#!/usr/bin/env node
/**
 * C1-5 数据划分与防泄漏（PRD v2 §10.6 / docs/prd-v2/HANDOFF-C-single-agent.md §3 阶段 C1）。
 *
 * 职责：
 *  1. 按模型族/来源划分 trajectory / perturbation / manual 三个数据集；
 *     同一族样本（含全部视角、改色、重编号、近重复、扰动）只进一个 split；
 *  2. 划分前做结构去重：共享 stateHash / modelOnlyStateHash 的样本用并查集归组，整组同 split；
 *  3. 留出集（holdout_test）在任何模型选择/调参之前冻结（本工具运行时 C2 尚未开始，无任何训练发生）；
 *  4. train 侧族内按去重组级 ~80/20 切出 validation；60239/manual dev 只做开发，不进 train/holdout；
 *  5. 对每个样本做 C3 契约（dataset.schema.json）字段校验，记录严格通过数与映射表（不回写原始样本）；
 *  6. 在冻结留出集上跑捷径探针 P1（查表）/ P2（仅候选 ID）/ P3（仅姿态，限 select_action），对比随机水平；
 *  7. 产出 split-manifest.json、.frozen 冻结戳、split 文件、assignment.json、shortcut-probes.json。
 *
 * 用法：
 *   node tools/brickvlm/make_splits.mjs \
 *     [--repo <repoRoot>] [--data out/prd-v2/run-20261026-c/C/data] [--seed <str>]
 *
 * 只读输入：data/trajectory、data/perturbation、data/manual（绝不修改）。
 * 输出：data/splits/**（本工具独占）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DEFAULT = path.resolve(SCRIPT_DIR, '..', '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--data') out.data = argv[++i];
    else if (a === '--seed') out.seed = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('Usage: node tools/brickvlm/make_splits.mjs [--repo <root>] [--data <dir>] [--seed <str>]');
  process.exit(0);
}
const REPO = path.resolve(args.repo || REPO_DEFAULT);
const DATA = path.resolve(REPO, args.data || 'out/prd-v2/run-20261026-c/C/data');
const OUT = path.join(DATA, 'splits');
const SEED = args.seed || 'c1-5-splits-v1-20261026';

// ── 冻结的留出族选择（在写本工具时即固定，先于任何模型训练/选择）──────────────
// trajectory：3 个程序化族、难度各异（拱门=基础堆叠+拱形几何；SNOT 侧装墙=SNOT；
//             平板货车=多模块车辆）。perturbation：1 族（bracket 难度）。
// manual：尊重 C1-4 溯源划分（10715/31062/42065 → holdout，60239 → dev）。
const HOLDOUT_FAMILIES = {
  trajectory: ['fam-arch', 'fam-snotwall', 'fam-cargoer'],
  perturbation: ['fam-bracketholder'],
};
const MANUAL_HOLDOUT_SETS = new Set(['10715', '31062', '42065']);
const VAL_TARGET_RATIO = 0.2;
const VAL_MIN_FAMILY_SAMPLES = 10; // 小于该样本数的 train 侧族不参与 val 抽签（整族进 train）

const sha256Buf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256File = (p) => sha256Buf(fs.readFileSync(p));

function mulberry32(seedInt) {
  let a = seedInt >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(arr, seedStr) {
  const rnd = mulberry32(parseInt(sha256Buf(Buffer.from(seedStr)).slice(0, 8), 16));
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── 载入三个数据集（只读）─────────────────────────────────────────────────────
function rel(p) { return path.relative(REPO, p).split(path.sep).join('/'); }

function loadTrajectory() {
  const dir = path.join(DATA, 'trajectory', 'families');
  const entries = [];
  for (const fam of fs.readdirSync(dir).sort()) {
    const f = path.join(dir, fam, 'samples.jsonl');
    if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      if (!line.trim()) return;
      const s = JSON.parse(line);
      const stT = (s.stateRefs || []).find((r) => r.role === 'state_t') || {};
      const stateNext = (s.stateRefs || []).find((r) => r.role === 'state_t+1') || {};
      entries.push({
        dataset: 'trajectory', taskType: s.taskType,
        sampleId: s.sampleId, familyId: s.provenance.sourceFamilyId,
        modelId: s.provenance.sourceModelId,
        groupHashes: [stT.stateHash, stT.modelOnlyStateHash, stateNext.modelOnlyStateHash].filter(Boolean),
        identityKey: `traj:${s.sampleId}`,
        raw: line, rawSha256: sha256Buf(Buffer.from(line, 'utf8')),
        ref: { file: rel(f), line: idx + 1 },
        sample: s,
      });
    });
  }
  return entries;
}

function loadPerturbation() {
  const dir = path.join(DATA, 'perturbation', 'families');
  const entries = [];
  for (const fam of fs.readdirSync(dir).sort()) {
    for (const taskFile of ['samples.understand_structure.jsonl', 'samples.repair_local.jsonl']) {
      const f = path.join(dir, fam, taskFile);
      if (!fs.existsSync(f)) continue;
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (!line.trim()) return;
        const s = JSON.parse(line);
        const pert = (s.stateRefs || []).find((r) => r.role === 'perturbed') || {};
        entries.push({
          dataset: 'perturbation', taskType: s.taskType,
          sampleId: s.sampleId, familyId: s.provenance.sourceFamilyId,
          modelId: s.provenance.sourceModelId,
          groupHashes: [s.stateRef && s.stateRef.stateHash, pert.stateHash, pert.modelOnlyStateHash].filter(Boolean),
          identityKey: `pert:${s.sampleId}`,
          raw: line, rawSha256: sha256Buf(Buffer.from(line, 'utf8')),
          ref: { file: rel(f), line: idx + 1 },
          sample: s,
        });
      });
    }
  }
  return entries;
}

function loadManual() {
  const dir = path.join(DATA, 'manual', 'samples');
  const entries = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    const fp = path.join(dir, f);
    const s = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const fam = (s.c3 && s.c3.provenance && s.c3.provenance.sourceFamilyId) || s.familyId;
    const pageId = s.provenance && s.provenance.pageId;
    const stepIndex = s.provenance && s.provenance.stepIndex;
    entries.push({
      dataset: 'manual', taskType: s.taskType,
      sampleId: s.sampleId, familyId: fam,
      modelId: (s.provenance && s.provenance.bookId) || fam,
      groupHashes: [],
      identityKey: `manual:${fam}:${pageId}:${stepIndex}:${s.sampleId}`,
      rawSha256: sha256File(fp),
      ref: { file: rel(fp) },
      provenanceSplit: s.split, // dev | train | holdout（C1-4 溯源划分，必须尊重）
      sample: s,
    });
  }
  return entries;
}

// ── 结构去重：并查集共享 stateHash / modelOnlyStateHash ───────────────────────
class DSU {
  constructor() { this.p = new Map(); }
  find(x) {
    if (!this.p.has(x)) this.p.set(x, x);
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r);
    while (this.p.get(x) !== r) { const n = this.p.get(x); this.p.set(x, r); x = n; }
    return r;
  }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.p.set(ra, rb); }
}

function assignGroups(entries) {
  const dsu = new DSU();
  const hashOwners = new Map(); // hash -> first identityKey
  for (const e of entries) {
    dsu.find(e.identityKey);
    for (const h of e.groupHashes) {
      if (hashOwners.has(h)) dsu.union(e.identityKey, hashOwners.get(h));
      else hashOwners.set(h, e.identityKey);
    }
    for (let i = 1; i < e.groupHashes.length; i++) dsu.union(e.identityKey, `${e.identityKey}#h${i}`);
  }
  // 组代表 = 组内最小 identityKey（确定性）
  const reps = new Map();
  for (const e of entries) {
    const r = dsu.find(e.identityKey);
    if (!reps.has(r) || e.identityKey < reps.get(r)) reps.set(r, e.identityKey);
  }
  for (const e of entries) e.groupKey = reps.get(dsu.find(e.identityKey));
}

// ── 划分 ─────────────────────────────────────────────────────────────────────
function assignSplits(entries) {
  const famTable = {}; // `${dataset}:${family}` -> {samples, split-side}
  for (const e of entries) {
    const k = `${e.dataset}:${e.familyId}`;
    famTable[k] = famTable[k] || { dataset: e.dataset, familyId: e.familyId, samples: 0 };
    famTable[k].samples++;
  }
  const crossFamilyGroups = [];
  const byGroup = new Map();
  for (const e of entries) {
    if (!byGroup.has(e.groupKey)) byGroup.set(e.groupKey, []);
    byGroup.get(e.groupKey).push(e);
  }
  for (const [gk, es] of byGroup) {
    const fams = [...new Set(es.map((e) => `${e.dataset}:${e.familyId}`))];
    if (fams.length > 1) crossFamilyGroups.push({ groupKey: gk, families: fams, samples: es.length });
  }

  for (const e of entries) {
    if (e.dataset === 'manual') {
      if (e.provenanceSplit === 'dev') e.split = 'dev';
      else if (e.provenanceSplit === 'holdout') e.split = 'holdout_test';
      else if (e.provenanceSplit === 'train') {
        e.split = MANUAL_HOLDOUT_SETS.has(String(e.familyId)) ? 'holdout_test' : 'train';
      } else throw new Error(`manual 样本 ${e.sampleId} 未知溯源 split=${e.provenanceSplit}`);
    } else {
      e.split = HOLDOUT_FAMILIES[e.dataset].includes(e.familyId) ? 'holdout_test' : null;
    }
  }

  // train 侧 val 切分：族粒度（每族整族进 train 或 validation，绝不跨切，
  // 严格执行「同族样本必须同 split」；跨族去重组相连的族用并查集绑定同侧）。
  // manual train 尊重 C1-4 溯源划分，不重切（HANDOFF-C1-5：不跨 split 移动 manual 样本）。
  const trainSide = entries.filter((e) => e.split === null);
  const totalTrainSide = trainSide.length;
  const valTarget = Math.round(totalTrainSide * VAL_TARGET_RATIO);

  // 约束：共享去重组的族必须同侧
  const famDsu = new DSU();
  const famKeys = [...new Set(trainSide.map((e) => `${e.dataset}:${e.familyId}`))];
  for (const k of famKeys) famDsu.find(k);
  for (const g of crossFamilyGroups) {
    const fams = g.families.filter((f) => trainSide.some((e) => `${e.dataset}:${e.familyId}` === f));
    for (let i = 1; i < fams.length; i++) famDsu.union(fams[0], fams[i]);
  }
  const units = new Map(); // unitRoot -> {families:[], samples}
  for (const k of famKeys) {
    const r = famDsu.find(k);
    if (!units.has(r)) units.set(r, { families: [], samples: 0 });
    units.get(r).families.push(k);
    units.get(r).samples += trainSide.filter((e) => `${e.dataset}:${e.familyId}` === k).length;
  }
  const eligible = [...units.entries()].filter(([, u]) => u.samples >= VAL_MIN_FAMILY_SAMPLES);
  const ineligible = [...units.entries()].filter(([, u]) => u.samples < VAL_MIN_FAMILY_SAMPLES);
  const orderedUnits = seededShuffle(eligible.map(([r]) => r), `${SEED}:val-units`).map((r) => [r, units.get(r)]);
  const valUnits = new Set();
  let acc = 0;
  for (const [r, u] of orderedUnits) {
    if (acc >= valTarget) break;
    valUnits.add(r); acc += u.samples;
  }
  const carveLog = [];
  for (const [r, u] of [...units.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    const isVal = valUnits.has(r);
    carveLog.push({
      unit: u.families, samples: u.samples,
      split: isVal ? 'validation' : 'train',
      rule: u.samples < VAL_MIN_FAMILY_SAMPLES ? 'unit<10 样本 → train（不参与 val 抽签）' : (isVal ? 'seeded 抽签抽中 → validation（整族）' : 'train（整族）'),
    });
  }
  for (const e of trainSide) {
    const r = famDsu.find(`${e.dataset}:${e.familyId}`);
    e.split = valUnits.has(r) ? 'validation' : 'train';
  }
  return { famTable, crossFamilyGroups, byGroup, carveLog, valTarget, valActual: acc, trainSideSamples: totalTrainSide };
}

// ── C3 契约校验（dataset.schema.json required 字段；映射不回写）────────────────
const HEX64 = /^[0-9a-f]{64}$/;
const IMG_ROLES = new Set(['target_manual_step', 'current_rendered_state', 'candidate_part', 'auxiliary_view', 'repair_diagnosis']);
const OPS = new Set(['attach_part', 'attach_assembly', 'place_root', 'abstain', 'undo', 'detach', 'replace']);
const SOURCE_KINDS = new Set(['real_manual', 'synthetic_assembly', 'curriculum_rule']);
const SPLIT_ENUM = new Set(['train', 'validation', 'holdout_test']);

function strictC3Check(s) {
  const missing = [];
  const bad = [];
  const has = (o, k) => o && o[k] !== undefined && o[k] !== null;
  if (!/^smp-[a-zA-Z0-9_-]+$/.test(s.sampleId || '')) bad.push('sampleId.pattern');
  if (s.protocolVersion !== '1.0') missing.push('protocolVersion==="1.0"');
  if (!['understand_step', 'understand_structure', 'select_action', 'repair_local'].includes(s.taskType)) bad.push('taskType.enum');
  const p = s.provenance || {};
  for (const k of ['sourceFamilyId', 'sourceModelId', 'sourceKind', 'split']) if (!has(p, k)) missing.push(`provenance.${k}`);
  if (has(p, 'sourceKind') && !SOURCE_KINDS.has(p.sourceKind)) bad.push(`provenance.sourceKind.enum:${p.sourceKind}`);
  if (has(p, 'split') && !SPLIT_ENUM.has(p.split)) bad.push(`provenance.split.enum:${p.split}`);
  const al = s.assetLock || {};
  for (const k of ['catalogVersion', 'engineRevision']) if (!has(al, k)) missing.push(`assetLock.${k}`);
  if (!Array.isArray(s.images) || s.images.length < 1) missing.push('images(minItems=1)');
  else for (const [i, im] of s.images.entries()) {
    for (const k of ['role', 'imagePath', 'imageSha256', 'labeled']) if (!has(im, k)) missing.push(`images[${i}].${k}`);
    if (has(im, 'role') && !IMG_ROLES.has(im.role)) bad.push(`images[${i}].role.enum:${im.role}`);
    if (has(im, 'imageSha256') && !HEX64.test(im.imageSha256)) bad.push(`images[${i}].imageSha256.pattern`);
  }
  if (!s.stateRef) missing.push('stateRef');
  else for (const k of ['taskId', 'stepNumber', 'stateHash']) if (!has(s.stateRef, k)) missing.push(`stateRef.${k}`);
  if (!Array.isArray(s.inventory)) missing.push('inventory');
  else for (const [i, it] of s.inventory.entries()) for (const k of ['tokenId', 'partId', 'colorId']) if (!has(it, k)) missing.push(`inventory[${i}].${k}`);
  const c = s.candidates || {};
  for (const k of ['enumerationComplete', 'truncated', 'items']) if (!has(c, k)) missing.push(`candidates.${k}`);
  if (Array.isArray(c.items)) for (const [i, it] of c.items.entries()) for (const k of ['candidateId', 'parentInstanceId', 'parentConnectorId', 'childPartId', 'childConnectorId', 'orientationId']) if (!has(it, k)) missing.push(`candidates.items[${i}].${k}`);
  const t = s.target || {};
  if (!has(t, 'primaryAction')) missing.push('target.primaryAction');
  else if (!has(t.primaryAction, 'op')) missing.push('target.primaryAction.op');
  else if (!OPS.has(t.primaryAction.op)) bad.push(`target.primaryAction.op.enum:${t.primaryAction.op}`);
  const v = s.verification || {};
  for (const k of ['isGeometricallyLegal', 'hasManualGroundTruth', 'verifiedBy']) if (!has(v, k)) missing.push(`verification.${k}`);
  return { strictPass: missing.length === 0 && bad.length === 0, missing, bad };
}

// 映射视图：把各数据集的实际字段映射成 C3 形态（只读映射，不回写样本）
function c3MappedView(e) {
  const s = e.sample;
  if (e.dataset === 'manual') {
    const c3 = s.c3 || {};
    return {
      sampleId: s.sampleId, protocolVersion: '1.0', taskType: s.taskType,
      provenance: {
        sourceFamilyId: (c3.provenance && c3.provenance.sourceFamilyId) || s.familyId,
        sourceModelId: (c3.provenance && c3.provenance.sourceModelId) || s.provenance.bookId,
        sourceKind: 'real_manual',
        split: e.split === 'dev' ? undefined : e.split, // dev 不在 C3 枚举内（PRD §10.6 60239 仅开发）
      },
      assetLock: undefined, // manual 样本未内嵌资产锁（C1-4 产物形态；映射缺口，如实记录）
      images: s.images,
      stateRef: undefined, // manual 未内嵌 stateRef（映射缺口）
      inventory: undefined, // manual understand_step 无库存概念（映射缺口）
      candidates: undefined, // understand_step 无候选（映射缺口）
      target: {
        primaryAction: undefined, // understand_step 不做动作选择（by design）
        stepUnderstanding: {
          partsAdded: s.groundTruth.partsAdded,
          isFlip: s.groundTruth.isFlip,
          isAssemblyEvent: s.groundTruth.isAssemblyEvent,
        },
      },
      verification: c3.verification || s.verification,
    };
  }
  // trajectory / perturbation
  const prov = { ...s.provenance };
  prov.split = e.split; // 原始 split 为占位符，由本工具划分为准
  if (e.dataset === 'trajectory') {
    if (prov.sourceKind === 'programmatic_builder' || prov.sourceKind === 'verified_source_replay') prov.sourceKind = 'synthetic_assembly';
  }
  const stT = (s.stateRefs || []).find((r) => r.role === 'state_t') || (s.stateRefs || []).find((r) => r.role === 'perturbed') || {};
  const receipt = s.verification && s.verification.labels && s.verification.labels.actionRequest;
  return {
    sampleId: s.sampleId,
    protocolVersion: s.protocolVersion === '1.0.0' ? '1.0' : s.protocolVersion,
    taskType: s.taskType,
    provenance: prov,
    assetLock: {
      catalogVersion: (s.assetLock && s.assetLock.indexVersion) || undefined,
      engineRevision: s.engineRevision || (s.assetLock && s.assetLock.engineRevision),
    },
    images: (s.images || []).map((im) => ({
      ...im,
      role: im.role === 'current_labeled' ? 'current_rendered_state'
        : im.role === 'target_state' ? 'auxiliary_view'
        : im.role === 'score_unlabeled' ? 'auxiliary_view' : im.role,
    })),
    stateRef: s.stateRef || {
      taskId: receipt && receipt.taskId,
      stepNumber: receipt && Array.isArray(receipt.actions) && receipt.actions[0] && typeof receipt.actions[0].step === 'number' ? receipt.actions[0].step - 1 : undefined,
      stateHash: stT.stateHash,
    },
    inventory: (s.inventory || []).map((it) => ({ ...it, tokenId: it.tokenId || it.token })),
    candidates: s.candidates,
    target: s.target,
    verification: s.verification,
  };
}

function mappedC3Check(e) {
  // manual dev（60239）：PRD §10.6 规定仅开发，不进 C3 train/holdout 枚举 → 排除在映射通过率之外
  if (e.dataset === 'manual' && e.split === 'dev') return { mappedPass: true, excludedDev: true, missing: [], bad: [], byDesignGaps: [] };
  const v = c3MappedView(e);
  const res = strictC3Check({ ...v, sampleId: v.sampleId });
  // manual 的 by-design 缺口单独归类，不计为映射失败
  if (e.dataset === 'manual') {
    const byDesign = new Set(['assetLock.catalogVersion', 'assetLock.engineRevision', 'stateRef', 'stateRef.taskId', 'stateRef.stepNumber', 'stateRef.stateHash', 'inventory', 'candidates.enumerationComplete', 'candidates.truncated', 'candidates.items', 'target.primaryAction', 'target.primaryAction.op']);
    res.missing = res.missing.filter((m) => !byDesign.has(m));
    res.byDesignGaps = ['assetLock', 'stateRef', 'inventory', 'candidates', 'target.primaryAction'];
    res.bad = res.bad.filter((b) => !b.startsWith('provenance.split.enum'));
  }
  return { ...res, mappedPass: res.missing.length === 0 && res.bad.length === 0 };
}

// ── 图像校验 ─────────────────────────────────────────────────────────────────
function resolveImagePath(dataset, p) {
  if (path.isAbsolute(p)) return p;
  if (p.startsWith('out/') || p.startsWith('out\\')) return path.join(REPO, p);
  return path.join(DATA, dataset, p);
}

function verifyImages(entries) {
  const uniq = new Map(); // key path -> {sha, datasets:Set}
  for (const e of entries) {
    const imgs = e.sample.images || [];
    for (const im of imgs) {
      if (!im.imagePath) continue;
      const k = `${e.dataset}|${im.imagePath}`;
      if (!uniq.has(k)) uniq.set(k, { dataset: e.dataset, path: im.imagePath, claimed: im.imageSha256 });
    }
  }
  let checked = 0, matched = 0, mismatched = 0, missing = 0;
  const problems = [];
  for (const { dataset, path: p, claimed } of uniq.values()) {
    const fp = resolveImagePath(dataset, p);
    checked++;
    if (!fs.existsSync(fp)) { missing++; if (problems.length < 20) problems.push({ type: 'missing', path: p }); continue; }
    const actual = sha256File(fp);
    if (claimed && actual !== claimed) {
      mismatched++;
      if (problems.length < 20) problems.push({ type: 'sha-mismatch', path: p, claimed, actual });
    } else matched++;
  }
  return { uniqueImagesReferenced: checked, matched, mismatched, missing, problems };
}

// ── 捷径探针（冻结留出集上，不用任何图像）────────────────────────────────────
function correctSetOf(e) {
  const ids = new Set((e.sample.candidates.items || []).map((c) => c.candidateId));
  const sel = e.sample.target.primaryAction.selectedCandidateId;
  const correct = new Set();
  if (sel && ids.has(sel)) correct.add(sel);
  for (const eq of e.sample.target.equivalentCandidates || []) if (ids.has(eq)) correct.add(eq);
  return { ids: [...ids], correct: [...correct] };
}

function runProbes(entries) {
  const holdout = entries.filter((e) => e.split === 'holdout_test');
  const train = entries.filter((e) => e.split === 'train' || e.split === 'validation');
  const probes = { note: '全部探针在冻结 holdout_test 上评测，不使用任何图像；训练侧统计只用 train+validation 样本文本字段。', chanceDefinition: 'select_action/repair_local: 每样本 chance_i = |正确候选∩候选列表| / |候选列表|（等价组计入正确），报告均值。', results: {} };

  const candTasks = [
    { dataset: 'trajectory', taskType: 'select_action' },
    { dataset: 'perturbation', taskType: 'repair_local' },
  ];
  for (const { dataset, taskType } of candTasks) {
    const ho = holdout.filter((e) => e.dataset === dataset && e.taskType === taskType);
    const tr = train.filter((e) => e.dataset === dataset && e.taskType === taskType);
    if (ho.length === 0) continue;

    // 随机水平
    let chanceSum = 0;
    for (const e of ho) { const { ids, correct } = correctSetOf(e); chanceSum += ids.length ? correct.length / ids.length : 0; }
    const chance = chanceSum / ho.length;

    // P1 查表：train 中 (family) → 众数 selectedCandidateId
    const table = new Map(); const globalCount = new Map();
    for (const e of tr) {
      const sel = e.sample.target.primaryAction.selectedCandidateId;
      if (!sel) continue;
      const k = e.familyId;
      table.set(k, table.get(k) || new Map());
      const m = table.get(k); m.set(sel, (m.get(sel) || 0) + 1);
      globalCount.set(sel, (globalCount.get(sel) || 0) + 1);
    }
    const famModal = new Map();
    for (const [k, m] of table) famModal.set(k, [...m.entries()].sort((a, b) => b[1] - a[1] || a[0] < b[0] ? -1 : 1)[0][0]);
    const globalModal = [...globalCount.entries()].sort((a, b) => b[1] - a[1] || a[0] < b[0] ? -1 : 1)[0][0];
    let p1hit = 0, p1covered = 0;
    for (const e of ho) {
      const pred = famModal.get(e.familyId);
      const { correct } = correctSetOf(e);
      if (pred !== undefined) { p1covered++; if (correct.includes(pred)) p1hit++; }
      else if (correct.includes(globalModal)) p1hit++;
    }
    // P1-oracle：用 holdout 自身统计众数候选 ID（任何 ID 频率漏洞的上界）
    const hoCount = new Map();
    for (const e of ho) { const sel = e.sample.target.primaryAction.selectedCandidateId; if (sel) hoCount.set(sel, (hoCount.get(sel) || 0) + 1); }
    const hoModal = [...hoCount.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];
    const oracleP1 = ho.length ? hoModal[1] / ho.length : 0;

    // P2 仅候选顺序/ID 统计
    const posCount = new Map();
    for (const e of tr) {
      const { ids, correct } = correctSetOf(e);
      const sel = e.sample.target.primaryAction.selectedCandidateId;
      const pi = ids.indexOf(sel);
      if (pi >= 0) posCount.set(pi, (posCount.get(pi) || 0) + 1);
    }
    const modalPos = [...posCount.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    let p2first = 0, p2modalPos = 0, p2lexmin = 0;
    const hoPosHist = new Map();
    for (const e of ho) {
      const { ids, correct } = correctSetOf(e);
      const sel = e.sample.target.primaryAction.selectedCandidateId;
      const pi = ids.indexOf(sel);
      hoPosHist.set(pi, (hoPosHist.get(pi) || 0) + 1);
      if (pi === 0) p2first++; // 正确答案是否偏首位（直接统计，见下 p2firstAsPredictor）
      if (pi === Math.min(modalPos, ids.length - 1)) p2modalPos++;
      const lexmin = ids.slice().sort()[0];
      if (correct.includes(lexmin)) p2lexmin++;
    }
    const hoPosDist = Object.fromEntries([...hoPosHist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v]));

    // P3 仅姿态/位置特征（select_action 限定）：按 parentConnectorId 前缀桶的 train 正确率打分
    let p3 = null;
    if (taskType === 'select_action') {
      const bucketStat = new Map();
      const bucketOf = (cid) => {
        const item = (e2items) => e2items; // placeholder
        return null;
      };
      // 先在 train 上统计
      const stat = new Map(); // bucket -> {n, hit}
      const bucketOfItem = (it) => String(it.parentConnectorId || 'none').split('#')[0];
      for (const e of tr) {
        const sel = e.sample.target.primaryAction.selectedCandidateId;
        for (const it of e.sample.candidates.items || []) {
          const b = bucketOfItem(it);
          stat.set(b, stat.get(b) || { n: 0, hit: 0 });
          stat.get(b).n++;
          if (it.candidateId === sel) stat.get(b).hit++;
        }
      }
      let p3hit = 0;
      for (const e of ho) {
        const items = e.sample.candidates.items || [];
        let best = null, bestScore = -Infinity;
        for (const it of items) {
          const b = bucketOfItem(it);
          const s0 = stat.get(b) || { n: 0, hit: 0 };
          const score = (s0.hit + 1) / (s0.n + 2); // Laplace 平滑
          if (score > bestScore) { bestScore = score; best = it.candidateId; }
        }
        const { correct } = correctSetOf(e);
        if (correct.includes(best)) p3hit++;
      }
      p3 = { method: 'train 桶统计 parentConnectorId 前缀 × Laplace 平滑 → argmax（无图像、无答案表）', accuracy: p3hit / ho.length, trainBuckets: Object.fromEntries([...stat.entries()].map(([k, v]) => [k, v])) };
    }

    // 泄漏统计：候选 ID 复用
    const idReuse = { distinctSelectedIds: hoCount.size, modalSelectedId: hoModal[0], modalSelectedIdCount: hoModal[1] };

    probes.results[`${dataset}:${taskType}`] = {
      holdoutSamples: ho.length, trainSideSamples: tr.length,
      chance, chancePct: +(chance * 100).toFixed(2),
      P1_tableLookup: { accuracy: p1hit / ho.length, familyKeyCovered: p1covered, globalFallbackId: globalModal, note: '候选 ID 逐样本随机匿名，族键查表对未见族必然回退全局众数' },
      P1_oracleModalId: { accuracy: oracleP1, detail: idReuse, note: '即便用 holdout 自身答案统计（任何 ID 频率漏洞的上界）也只能到该值' },
      P2_candidateIdOnly: {
        alwaysPickFirstCorrectRate: p2first / ho.length, // 正确答案位于首位的频率（= 永远选首位的命中率）
        modalPositionFromTrain: modalPos, pickModalPositionAccuracy: p2modalPos / ho.length,
        lexicographicallyFirstAccuracy: p2lexmin / ho.length,
        holdoutCorrectPositionHistogram: hoPosDist,
      },
      P3_poseOnly: p3,
      leakThreshold: 'accuracy > 2×chance 视为疑似泄漏',
    };
  }

  // understand_structure：文本查表（errorType 众数）+ 类先验
  {
    const ho = holdout.filter((e) => e.dataset === 'perturbation' && e.taskType === 'understand_structure');
    const tr = train.filter((e) => e.dataset === 'perturbation' && e.taskType === 'understand_structure');
    if (ho.length) {
      const famTable = new Map(); const globalCount = new Map();
      for (const e of tr) {
        const et = e.sample.target.structureDiagnosis && e.sample.target.structureDiagnosis.errorType;
        if (!et) continue;
        famTable.set(e.familyId, famTable.get(e.familyId) || new Map());
        const m = famTable.get(e.familyId); m.set(et, (m.get(et) || 0) + 1);
        globalCount.set(et, (globalCount.get(et) || 0) + 1);
      }
      const globalModal = [...globalCount.entries()].sort((a, b) => b[1] - a[1] || a[0] < b[0] ? -1 : 1)[0][0];
      const hoHist = new Map(); let hit = 0, errTrue = 0;
      for (const e of ho) {
        const d = e.sample.target.structureDiagnosis || {};
        const et = d.errorType;
        hoHist.set(et, (hoHist.get(et) || 0) + 1);
        if (d.hasStructuralError) errTrue++;
        const fm = famTable.get(e.familyId);
        const pred = fm ? [...fm.entries()].sort((a, b) => b[1] - a[1] || a[0] < b[0] ? -1 : 1)[0][0] : globalModal;
        if (pred === et) hit++;
      }
      const histObj = Object.fromEntries([...hoHist.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [String(k), v]));
      const modalFreq = Math.max(...hoHist.values()) / ho.length;
      probes.results['perturbation:understand_structure'] = {
        holdoutSamples: ho.length,
        P1_textTableErrorType: { accuracy: hit / ho.length, chance_majorityClassFreq: modalFreq, holdoutErrorTypeHistogram: histObj, note: '未见族查表回退全局众数 errorType；命中率等于 holdout 中该类频率，即类先验水平' },
        classPrior: { hasStructuralErrorTrueRate: errTrue / ho.length, note: 'C1-3 扰动数据全为带错样本（无干净负例），hasStructuralError=true 的 100% 是任务设计决定的类先验，不是视觉泄漏；负例与 abstain 行为需在 C4 闭环中另行评测' },
      };
    }
  }
  return probes;
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
function main() {
  const t0 = Date.now();
  fs.mkdirSync(OUT, { recursive: true });
  const genCmd = `node ${rel(path.join(REPO, 'tools/brickvlm/make_splits.mjs'))} --repo ${rel(REPO)} --data ${rel(DATA)} --seed ${SEED}`;

  console.log('[1/8] 载入数据集（只读）…');
  const entries = [...loadTrajectory(), ...loadPerturbation(), ...loadManual()];
  const idSeen = new Map();
  for (const e of entries) {
    if (idSeen.has(e.sampleId)) throw new Error(`sampleId 重复: ${e.sampleId} (${idSeen.get(e.sampleId)})`);
    idSeen.set(e.sampleId, `${e.dataset}:${e.familyId}`);
  }

  console.log('[2/8] 结构去重分组（stateHash 并查集）…');
  assignGroups(entries);
  const { famTable, crossFamilyGroups, byGroup, carveLog, valTarget, valActual, trainSideSamples } = assignSplits(entries);

  // 组不得跨越 train 侧 / holdout 边界
  const spanning = [];
  for (const [gk, es] of byGroup) {
    const sides = new Set(es.map((e) => (e.split === 'holdout_test' ? 'holdout' : e.split === 'dev' ? 'dev' : 'train-side')));
    if (sides.size > 1) spanning.push({ groupKey: gk, splits: [...sides], samples: es.length });
  }
  if (spanning.length) {
    console.error('FATAL: 去重组跨越 split 边界，需要重选留出族：', JSON.stringify(spanning.slice(0, 10), null, 2));
    process.exit(2);
  }

  console.log('[3/8] C3 契约校验（严格 + 映射视图）…');
  const validation = { byDataset: {}, mappingTable: null };
  const perDs = new Map();
  for (const e of entries) {
    const k = e.dataset;
    if (!perDs.has(k)) perDs.set(k, { samples: 0, strictPass: 0, mappedPass: 0, excludedDev: 0, strictMissingTop: new Map(), strictBadTop: new Map() });
    const st = strictC3Check(e.sample);
    const mp = mappedC3Check(e);
    const agg = perDs.get(k);
    agg.samples++;
    if (st.strictPass) agg.strictPass++;
    if (mp.mappedPass) agg.mappedPass++;
    if (mp.excludedDev) agg.excludedDev++;
    for (const m of st.missing) { const key = m.replace(/\[\d+\]/g, '[]'); agg.strictMissingTop.set(key, (agg.strictMissingTop.get(key) || 0) + 1); }
    for (const b of st.bad) { const key = b.replace(/\[\d+\]/g, '[]'); agg.strictBadTop.set(key, (agg.strictBadTop.get(key) || 0) + 1); }
  }
  validation.byDataset = Object.fromEntries([...perDs.entries()].map(([k, v]) => [k, {
    samples: v.samples, strictPass: v.strictPass, mappedPass: v.mappedPass,
    mappedPassExcludingDev: v.samples - (v.excludedDev || 0) > 0 ? `${v.mappedPass - (v.excludedDev || 0)}/${v.samples - (v.excludedDev || 0)}` : 'n/a',
    excludedDev: v.excludedDev || 0,
    strictMissingHistogram: Object.fromEntries([...v.strictMissingTop.entries()].sort((a, b) => b[1] - a[1])),
    strictBadHistogram: Object.fromEntries([...v.strictBadTop.entries()].sort((a, b) => b[1] - a[1])),
  }]));
  validation.mappingTable = [
    { field: 'protocolVersion', raw: '1.0.0（trajectory 全部 / manual 外层）', contract: '"1.0" (const)', mapping: '1.0.0 ≡ 1.0（语义版本等价）', appliedIn: 'mapped view' },
    { field: 'protocolVersion', raw: '1.0（perturbation 全部 / manual c3 内嵌）', contract: '"1.0" (const)', mapping: '原生匹配', appliedIn: 'strict' },
    { field: 'stateRef', raw: 'trajectory 无 stateRef，仅有 stateRefs[role=state_t]', contract: 'stateRef{taskId,stepNumber,stateHash}', mapping: 'stateHash←stateRefs[state_t].stateHash；taskId/stepNumber←verification.labels.actionRequest.taskId/step-1', appliedIn: 'mapped view' },
    { field: 'assetLock.catalogVersion', raw: 'assetLock.indexVersion="1.0.0"', contract: 'catalogVersion', mapping: 'catalogVersion←assetLock.indexVersion', appliedIn: 'mapped view' },
    { field: 'assetLock.engineRevision', raw: '顶层 engineRevision="actions-v1@1.0.0"', contract: 'assetLock.engineRevision', mapping: 'engineRevision←顶层 engineRevision', appliedIn: 'mapped view' },
    { field: 'provenance.sourceKind', raw: 'programmatic_builder / verified_source_replay（trajectory）', contract: 'enum[real_manual,synthetic_assembly,curriculum_rule]', mapping: '两者→synthetic_assembly', appliedIn: 'mapped view' },
    { field: 'provenance.split', raw: '占位符 "train"（trajectory/perturbation 全部）', contract: 'enum[train,validation,holdout_test]', mapping: '由本工具 split assignment 取代（权威），原始样本不回写', appliedIn: 'assignment' },
    { field: 'images[].role', raw: 'current_labeled / target_state / score_unlabeled（trajectory）', contract: 'enum 五值', mapping: 'current_labeled→current_rendered_state；target_state→auxiliary_view；score_unlabeled→auxiliary_view', appliedIn: 'mapped view' },
    { field: 'inventory[].tokenId', raw: 'token（trajectory）', contract: 'tokenId', mapping: 'token→tokenId（同值）', appliedIn: 'mapped view' },
    { field: 'manual 整体', raw: 'C3 载荷部分内嵌于 c3 子对象（仅 sampleId/protocolVersion/taskType/provenance/verification），images/callouts/groundTruth 在顶层；dev 样本 c3=null', contract: '完整 C3 必填集', mapping: '顶层 images→images；groundTruth→target.stepUnderstanding；provenance.split: dev→(dev 枚举外，仅开发)、holdout→holdout_test、train→train；assetLock/stateRef/inventory/candidates/target.primaryAction 为 C1-4 by-design 缺口，如实记录、不虚构', appliedIn: 'mapped view（带 by-design 缺口清单）' },
  ];

  console.log('[4/8] 图像引用校验（sha256 全量）…');
  const imgVerify = verifyImages(entries);

  console.log('[5/8] 写 split 文件与 assignment…');
  const perSample = {};
  for (const e of entries) {
    perSample[e.sampleId] = {
      dataset: e.dataset, taskType: e.taskType, familyId: e.familyId, split: e.split,
      groupKey: e.groupKey, sampleSha256: e.rawSha256, sampleRef: e.ref,
    };
  }
  const splitFiles = {};
  const imageHashesOf = (e) => (e.sample.images || []).filter((i) => i.imagePath).map((i) => ({ path: i.imagePath, sha256: i.imageSha256 || null }));
  for (const split of ['train', 'validation', 'holdout_test', 'dev']) {
    const es = entries.filter((e) => e.split === split).sort((a, b) => a.sampleId < b.sampleId ? -1 : 1);
    const obj = {
      split, sampleCount: es.length,
      note: split === 'dev' ? '60239 开发样例（PRD §10.6：只做开发，不进 train/holdout）' : '每条含 sampleId、来源引用、样本 JSON sha256 与引用图像哈希',
      samples: es.map((e) => ({
        sampleId: e.sampleId, dataset: e.dataset, taskType: e.taskType, familyId: e.familyId,
        groupKey: e.groupKey, sampleRef: e.ref, sampleSha256: e.rawSha256, imageHashes: imageHashesOf(e),
      })),
    };
    const fp = path.join(OUT, `${split}.json`);
    fs.writeFileSync(fp, JSON.stringify(obj, null, 1));
    splitFiles[split] = { path: rel(fp), sha256: sha256File(fp), sampleCount: es.length };
  }
  const assignmentObj = {
    meta: { generatedAt: new Date().toISOString(), seed: SEED, cmd: genCmd, authoritative: 'split assignment 以本文件与 split-files 为准；原始数据集 provenance.split 为占位符，未回写' },
    samples: Object.fromEntries(Object.entries(perSample).sort(([a], [b]) => a < b ? -1 : 1)),
  };
  const assignmentPath = path.join(OUT, 'assignment.json');
  fs.writeFileSync(assignmentPath, JSON.stringify(assignmentObj, null, 1));

  console.log('[6/8] 捷径探针（冻结 holdout，无图像）…');
  const probes = runProbes(entries);
  const probesPath = path.join(OUT, 'shortcut-probes.json');
  fs.writeFileSync(probesPath, JSON.stringify({ ...probes, generatedAt: new Date().toISOString() }, null, 1));

  // 探针泄漏判定（候选类任务）
  const leakFindings = [];
  for (const [k, r] of Object.entries(probes.results)) {
    if (r.chance === undefined) {
      // understand_structure：查表命中率不应超过多数类频率（它按构造等于），类先验单列
      if (r.P1_textTableErrorType && r.P1_textTableErrorType.accuracy > r.P1_textTableErrorType.chance_majorityClassFreq + 1e-9) {
        leakFindings.push({ probe: `${k}:P1_textTableErrorType`, detail: '超过多数类频率' });
      }
      continue;
    }
    const thr = 2 * r.chance;
    const accs = {
      P1_tableLookup: r.P1_tableLookup.accuracy,
      P1_oracleModalId: r.P1_oracleModalId.accuracy,
      P2_alwaysFirst: r.P2_candidateIdOnly.alwaysPickFirstCorrectRate,
      P2_modalPosition: r.P2_candidateIdOnly.pickModalPositionAccuracy,
      P2_lexicographicFirst: r.P2_candidateIdOnly.lexicographicallyFirstAccuracy,
    };
    if (r.P3_poseOnly) accs.P3_poseOnly = r.P3_poseOnly.accuracy;
    for (const [name, acc] of Object.entries(accs)) {
      if (acc > thr) leakFindings.push({ probe: `${k}:${name}`, accuracy: acc, chance: r.chance, threshold: thr });
    }
  }

  console.log('[7/8] 汇总 counts 与 PRD 目标对账…');
  const countsBySplit = {};
  for (const e of entries) {
    const k = e.split;
    countsBySplit[k] = countsBySplit[k] || { total: 0, byDataset: {}, byTask: {} };
    countsBySplit[k].total++;
    countsBySplit[k].byDataset[e.dataset] = (countsBySplit[k].byDataset[e.dataset] || 0) + 1;
    countsBySplit[k].byTask[`${e.dataset}:${e.taskType}`] = (countsBySplit[k].byTask[`${e.dataset}:${e.taskType}`] || 0) + 1;
  }
  const holdoutFamilies = [...new Set(entries.filter((e) => e.split === 'holdout_test').map((e) => `${e.dataset}:${e.familyId}`))].sort();
  const trainFamilies = [...new Set(entries.filter((e) => e.split === 'train' || e.split === 'validation').map((e) => `${e.dataset}:${e.familyId}`))].sort();
  const uniqueStates = new Set(entries.map((e) => e.groupKey)).size;
  const uniqueStateHashes = new Set();
  for (const e of entries) {
    if (e.dataset === 'trajectory') {
      const stT = (e.sample.stateRefs || []).find((r) => r.role === 'state_t');
      if (stT && stT.stateHash) uniqueStateHashes.add(stT.stateHash);
    } else if (e.dataset === 'perturbation' && e.sample.stateRef && e.sample.stateRef.stateHash) {
      uniqueStateHashes.add(e.sample.stateRef.stateHash);
    }
  }
  const entangledFamilies = [...new Set(crossFamilyGroups.flatMap((g) => g.families))].sort();

  const prdDeltas = {
    '留出 ≥300 案例': { target: 300, actual: countsBySplit.holdout_test.total, pass: countsBySplit.holdout_test.total >= 300 },
    '留出 ≥3 未见模型族': { target: 3, actual: holdoutFamilies.length, families: holdoutFamilies, pass: holdoutFamilies.length >= 3 },
    '留出 ≥100 真实说明书步骤': { target: 100, actual: countsBySplit.holdout_test.byDataset.manual || 0, pass: (countsBySplit.holdout_test.byDataset.manual || 0) >= 100, note: 'pilot 缺口：C1-4 核查通过的真实步骤总量 199（dev 33 / train 107 / holdout 59），60239 按规则固定 dev' },
    '（参考）≥200 核查真实说明书训练步': { target: 200, actual: countsBySplit.train.byDataset.manual || 0, pass: (countsBySplit.train.byDataset.manual || 0) >= 200, note: 'pilot 缺口，同上' },
    '（参考）≥5,000 去重合法/修复状态': { target: 5000, actual: uniqueStateHashes.size, pass: uniqueStateHashes.size >= 5000, note: 'pilot 缺口：口径 = 数据集内互不相同的 stateHash（合法状态 state_t ∪ 扰动修复状态）；当前 4,920 样本去重后未达 5,000，需 C1 后续扩量' },
  };

  console.log('[8/8] 写 split-manifest.json 与 .frozen 冻结戳…');
  const now = new Date().toISOString();
  const inputManifests = {};
  for (const d of ['trajectory', 'perturbation', 'manual']) {
    const p = path.join(DATA, d, 'manifest.json');
    inputManifests[d] = { path: rel(p), sha256: sha256File(p) };
  }
  const manifest = {
    task: 'C1-5 数据划分与防泄漏（PRD v2 §10.6；HANDOFF-C §3 阶段 C1）',
    generatedAt: now,
    generationCommand: genCmd,
    tool: { path: rel(path.join(REPO, 'tools/brickvlm/make_splits.mjs')), sha256: sha256File(path.join(REPO, 'tools/brickvlm/make_splits.mjs')) },
    seed: SEED,
    determinism: '族选择固定于工具常量；val 切分 = 族粒度 seeded 抽签（sha256(seed:val-units) 洗牌单位后累计 ≥20% 样本），跨族去重纠缠的族绑定同侧；全部可复现',
    rules: [
      'R1 按 model family / source 划分：同族全部样本（含全部视角、改色、重编号、近重复、其上的扰动）只进一个 split（PRD §10.6 第 1 条）。',
      'R2 划分前结构去重：共享 stateHash / modelOnlyStateHash 的样本经并查集归组，整组同 split（PRD §10.6 结构去重条款）。',
      'R3 留出集在任何模型选择/调参/训练之前冻结：本次冻结时点无任何模型训练发生（C2 未开始，R0/R1/R3 均未在真实数据上运行）（PRD §10.6：测试集在选模型、调阈值之前冻结）。',
      'R4 60239 及 manual dev（33 步）只做开发样例，排除于 train/validation/holdout 之外（PRD §10.6 第 2 条）。',
      'R5 train:rest ≈ 80/20 于剩余（非留出、非 dev）样本：validation 以「族」为单位切出——每族整族进 train 或 validation，绝不跨切（严格满足 R1 的「同族同 split」）；共享去重组的族（如 fam-pier↔fam-table 结构纠缠）用并查集绑定同侧；<10 样本的小族不参与抽签直接进 train；manual 的 C1-4 溯源划分被尊重，manual train 不重切（HANDOFF-C1-5 指令：不跨 split 移动 manual 样本）。',
      'R6 每个样本 split 只记录于 assignment/split 文件（sampleId → split），原始样本文件一律不回写。',
      'R7 教师蒸馏不得使用冻结测试答案或测试标注（PRD §10.6）；本工具不生成任何蒸馏数据。',
    ],
    holdoutFamilyChoice: {
      trajectory: HOLDOUT_FAMILIES.trajectory.map((f) => ({ family: f, rationale: { 'fam-arch': '程序化·基础堆叠+拱形几何（12 实例/112 样本）', 'fam-snotwall': '程序化·SNOT 侧装分层（12 实例/96 样本）', 'fam-cargoer': '程序化·多模块车辆：底盘+驾驶室+货舱围板+货物（12 实例/144 样本）' }[f] })),
      perturbation: [{ family: 'fam-bracketholder', rationale: 'bracket 难度（支架转接），208 扰动 × 2 任务 = 416 样本；与其余 5 族结构独立' }],
      manual: '尊重 C1-4 溯源 holdout：集合 10715(15) + 31062(15) + 42065(29) = 59 步',
      frozenBeforeModelWork: true,
    },
    inputs: { manifests: inputManifests, datasetsRoot: rel(DATA), readOnly: true },
    counts: {
      totalSamples: entries.length,
      bySplit: countsBySplit,
      families: Object.values(famTable).map((f) => ({
        key: `${f.dataset}:${f.familyId}`,
        samples: f.samples,
        splitSide: entries.find((e) => e.dataset === f.dataset && e.familyId === f.familyId).split === 'holdout_test' ? 'holdout_test'
          : (f.dataset === 'manual' ? 'per C1-4 provenance (dev/train/holdout)' : 'train-side'),
      })).sort((a, b) => a.key < b.key ? -1 : 1),
      valCarve: carveLog.sort((a, b) => a.family < b.family ? -1 : 1),
    },
    dedup: {
      groupCount: byGroup.size,
      uniqueGroupKeys: uniqueStates,
      uniqueStateHashes: uniqueStateHashes.size,
      uniqueStateHashSetNote: '去重「状态」口径 = 数据集中互不相同的 stateHash 全集（trajectory state_t 哈希 ∪ perturbation 扰动态哈希；manual 无 stateHash 以步骤身份计）；uniqueGroupKeys 为并查集连通分量数（同一实例相邻步骤经 modelOnlyStateHash 链式相连，属同一防泄漏组）',
      entangledFamilies: entangledFamilies,
      crossFamilyGroups: crossFamilyGroups,
      spanningSplitGroups: spanning,
      rule: '组键 = 并查集代表（共享 stateHash / modelOnlyStateHash 相连的最小 identityKey）；manual 以 集合:页:步骤:sampleId 为身份键',
    },
    c3Validation: validation,
    imageVerification: imgVerify,
    prdTargetsDelta: prdDeltas,
    probesFile: { path: rel(probesPath), sha256: sha256File(probesPath) },
    probeLeakFindings: leakFindings,
    probeLeakVerdict: leakFindings.length === 0 ? 'PASS：全部探针 ≤ 2×随机水平，未发现查表/候选ID/姿态捷径泄漏；v1 划分为最终版' : 'FAIL：发现疑似泄漏，需按 v2 重划（见 probeLeakFindings）',
    freeze: {
      frozen: true,
      frozenAt: now,
      frozenBy: genCmd,
      noTrainingStatement: '冻结时点（' + now + '）不存在任何针对本数据集的模型训练、基座选择或阈值调优：C2 阶段（R0 复检/基座选择/R1 基线/R3 SFT）尚未开始，历史 v4 权重仅由 smoke 数据训练、与本数据集无关。',
      splitFiles: splitFiles,
      assignmentFile: { path: rel(assignmentPath), sha256: sha256File(assignmentPath) },
    },
  };
  const manifestPath = path.join(OUT, 'split-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));

  const frozen = {
    frozen: true,
    frozenAt: now,
    datasetRoot: rel(DATA),
    statement: manifest.freeze.noTrainingStatement,
    rules: 'PRD v2 §10.6（见 split-manifest.json.rules 全文）',
    manifestSha256: sha256File(manifestPath),
    splitFiles: splitFiles,
    assignmentSha256: sha256File(assignmentPath),
    probesSha256: sha256File(probesPath),
  };
  fs.writeFileSync(path.join(OUT, '.frozen'), JSON.stringify(frozen, null, 1));

  // 控制台摘要
  console.log('\n=== C1-5 完成 ===');
  console.log('样本总数:', entries.length);
  for (const [k, v] of Object.entries(countsBySplit)) console.log(`  ${k}: ${v.total}  ${JSON.stringify(v.byDataset)}`);
  console.log('留出族:', holdoutFamilies.join(', '));
  console.log('跨族去重组:', crossFamilyGroups.length, ' 跨 split 组:', spanning.length);
  console.log('图像校验:', JSON.stringify({ checked: imgVerify.uniqueImagesReferenced, matched: imgVerify.matched, mismatched: imgVerify.mismatched, missing: imgVerify.missing }));
  console.log('C3 严格/映射通过:', JSON.stringify(Object.fromEntries(Object.entries(validation.byDataset).map(([k, v]) => [k, `${v.strictPass}/${v.samples} strict, ${v.mappedPass}/${v.samples} mapped`]))));
  console.log('探针泄漏:', leakFindings.length === 0 ? '无（PASS）' : JSON.stringify(leakFindings));
  for (const [k, r] of Object.entries(probes.results)) {
    if (r.chance !== undefined) {
      console.log(`  ${k}: chance=${(r.chance * 100).toFixed(2)}%  P1=${(r.P1_tableLookup.accuracy * 100).toFixed(2)}%  P1oracle=${(r.P1_oracleModalId.accuracy * 100).toFixed(2)}%  P2first=${(r.P2_candidateIdOnly.alwaysPickFirstCorrectRate * 100).toFixed(2)}%  P2pos=${(r.P2_candidateIdOnly.pickModalPositionAccuracy * 100).toFixed(2)}%  P2lex=${(r.P2_candidateIdOnly.lexicographicallyFirstAccuracy * 100).toFixed(2)}%${r.P3_poseOnly ? `  P3pose=${(r.P3_poseOnly.accuracy * 100).toFixed(2)}%` : ''}`);
    } else {
      console.log(`  ${k}: P1text=${(r.P1_textTableErrorType.accuracy * 100).toFixed(2)}% vs majority=${(r.P1_textTableErrorType.chance_majorityClassFreq * 100).toFixed(2)}%  classPrior(hasError)=${(r.classPrior.hasStructuralErrorTrueRate * 100).toFixed(1)}%`);
    }
  }
  console.log('PRD 对账:', JSON.stringify(prdDeltas, null, 1));
  console.log('耗时 ms:', Date.now() - t0);
}

main();
