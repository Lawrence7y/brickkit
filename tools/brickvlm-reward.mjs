#!/usr/bin/env node
/**
 * tools/brickvlm-reward.mjs —— BrickVLM 的物理 + 视觉 RLVR 奖励
 *
 * 输入（JSONL，一行一条）：
 *   { "model": "60239", "step": 8, "pred": [...], "gt": [...] }
 *   可选 "modelFile": "examples/60239.brick.json" —— 该条的模型来源（CLI 的 --model 作为默认值）
 *
 * 输出（JSONL，顺序与输入一致）：
 *   { "ok": true, "score": 0.87, "breakdown": { "physical": 0.5, "snapMatch": 0.3, "visual": 0.2, "noOverlap": 1.0 }, "errors": [] }
 *
 * 奖励定义（详见 docs/BrickVLM训练架构.md「奖励函数」章节）：
 *   physical   把 pred 逐条 snapPart 到模型副本上：
 *                - snapPart 抛错/null            → 该条 0
 *                - 与已有零件 partsCollide 命中   → 该条 0
 *                - 与同批 pred 兄弟件穿模         → 该条 0
 *                - 全部通过再跑 validate()，按 error 数惩罚：1/(1+errors)
 *               physical = (通过条数 / pred 条数) × 1/(1+validateErrors)
 *   snapMatch  pred 与 gt 逐条比 6 字段命中率。配对用 (part, color) 多重集 + (on, stud) 首选、
 *              余下按 (part, color) 一对一贪心。每对字段权重：part/color/on/stud/receptor 各 1，rot 特殊——
 *              完全相同 1，相差 180° 且几何等价 0.5（按旋转等价类判定），其余 0。字段命中率 = 加权和 / 6。
 *              snapMatch = 配对字段命中率均值 × min(1, |pred| / |gt|)（少装扣分，多装按物理侧惩罚）
 *   visual     runDiff 的 overall.score（需 --photos + --dir；缺失时 breakdown.visual = null 并跳过）
 *   noOverlap  pred 之间的 3D 穿模率（1 = 完全没有穿模），独立报告便于诊断
 *
 *   总分 = 0.5*physical + 0.3*snapMatch + 0.2*visual，visual 缺失时按 0.5/0.3 重新归一
 *
 * 用法：
 *   node tools/brickvlm-reward.mjs --predictions preds.jsonl --model examples/60239.brick.json \
 *     [--photos examples/60239.photos.json --dir out/manual-pages/60239] [--out out/reward.json]
 * 可选：
 *   --greedy-rot        rot 的 180° 等价只按 rot 数值差判定（不做几何等价校验，更快）
 *   --no-validate       跳过 validate 惩罚（调试用）
 *   --skip-visual       即便给了 --photos 也不跑 runDiff
 *   --pretty            美化 stdout 的汇总 JSON
 *
 * 核心评分函数为纯函数 `scorePrediction()`，CLI 只是壳；见 test/brickvlm.test.mjs。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  partConnectors, partsCollide, partBoxes, snapPart, validate, rotXZ,
} from '../src/core/core.js';
import { loadCatalog } from './lib/snap-gt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

/** 奖励权重（写进文档，改动需同步 docs/BrickVLM训练架构.md） */
export const WEIGHTS = Object.freeze({ physical: 0.5, snapMatch: 0.3, visual: 0.2 });
/** 6 字段的匹配权重（rot 单独处理 180° 半对） */
export const FIELD_WEIGHTS = Object.freeze({ part: 1, color: 1, on: 1, stud: 1, receptor: 1, rot: 1 });
export const ACTION_FIELDS = ['part', 'color', 'on', 'stud', 'receptor', 'rot'];

const round = (v, n = 4) => (Number.isFinite(v) ? Number(v.toFixed(n)) : v);

/* ---------------------------------------------------------------- rot 等价 */

/**
 * rot 的 180° 等价判定：rot 只在有长宽不对称的零件上才是「真差别」；
 * 对正方形轮廓（size[0] === size[1]）旋转 180° 完全不可分辨。
 * 另外，某些零件带对称凸点/受体排列，180° 后连接器编号只是重排。
 * 这里采用保守口径：**几何包围盒 180° 前后完全一致**（按零件自身 size 与已给的 rot 计算）
 * 即视为 180° 等价，算半对。--greedy-rot 时直接按 |Δrot| === 180 算。
 */
function rot180Equivalent(partDef, greedy = false) {
  if (greedy) return true;
  if (!partDef) return false;
  const [sx, sz] = partDef.size || [1, 1];
  // 正方形足迹旋转 180° 与旋转 0° 的包围盒相同
  return sx === sz;
}

/**
 * 比较两个 rot 值：返回 1（完全一致）/ 0.5（180° 等价）/ 0（不等价）
 */
export function compareRot(a, b, partDef, greedy = false) {
  const ra = ((Number(a) || 0) % 360 + 360) % 360;
  const rb = ((Number(b) || 0) % 360 + 360) % 360;
  if (ra === rb) return 1;
  const diff = Math.abs(ra - rb);
  if (diff === 180) return rot180Equivalent(partDef, greedy) ? 0.5 : 0;
  return 0;
}

/* ---------------------------------------------------------------- snapMatch */

/** 规整一条动作（缺失字段补默认值，数字字段转数字） */
export function normalizeAction(a) {
  const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    part: a?.part !== undefined ? String(a.part) : '',
    color: num(a?.color),
    on: a?.on !== undefined && a.on !== null ? String(a.on) : '',
    stud: num(a?.stud),
    receptor: num(a?.receptor),
    rot: num(a?.rot),
  };
}

/**
 * 逐条配对 pred ↔ gt。
 * 配对策略（确定性）：
 *   1) 先按 (part, color, on, stud) 完全相同配对（最可能的真匹配）；
 *   2) 余下按 (part, color) 贪心一对一配对；
 *   3) 仍未配上的 pred = 多余动作；未配上的 gt = 漏装。
 * 返回 [{ pred, gt }] 配对列表 + 多余/漏装计数。
 */
export function pairActions(pred, gt) {
  const P = pred.map(normalizeAction);
  const G = gt.map(normalizeAction);
  const usedP = new Set(), usedG = new Set();
  const pairs = [];

  const key4 = (a) => `${a.part}|${a.color}|${a.on}|${a.stud}`;
  const key2 = (a) => `${a.part}|${a.color}`;

  const byKey4 = new Map();
  G.forEach((g, i) => { const k = key4(g); if (!byKey4.has(k)) byKey4.set(k, []); byKey4.get(k).push(i); });
  P.forEach((p, i) => {
    const list = byKey4.get(key4(p));
    if (list && list.length) { const j = list.shift(); usedP.add(i); usedG.add(j); pairs.push({ pi: i, gi: j }); }
  });

  const byKey2 = new Map();
  G.forEach((g, j) => { if (usedG.has(j)) return; const k = key2(g); if (!byKey2.has(k)) byKey2.set(k, []); byKey2.get(k).push(j); });
  P.forEach((p, i) => {
    if (usedP.has(i)) return;
    const list = byKey2.get(key2(p));
    if (list && list.length) { const j = list.shift(); usedP.add(i); usedG.add(j); pairs.push({ pi: i, gi: j }); }
  });

  const extraPred = P.length - usedP.size;
  const missingGt = G.length - usedG.size;
  return { P, G, pairs, extraPred, missingGt };
}

/**
 * snapMatch：配对字段命中率均值 × min(1, |pred|/|gt|)
 * @returns {{ score:number, fieldHits:number, fieldTotal:number, pairs:number, extraPred:number, missingGt:number }}
 */
export function scoreSnapMatch(pred, gt, { cat, greedyRot = false } = {}) {
  const { P, G, pairs, extraPred, missingGt } = pairActions(pred, gt);
  if (!G.length) return { score: P.length ? 0 : 1, fieldHits: 0, fieldTotal: 0, pairs: 0, extraPred, missingGt };

  let hits = 0, total = 0;
  for (const { pi, gi } of pairs) {
    const p = P[pi], g = G[gi];
    total += 6;
    for (const f of ['part', 'color', 'on', 'stud', 'receptor']) if (p[f] === g[f]) hits += FIELD_WEIGHTS[f];
    hits += FIELD_WEIGHTS.rot * compareRot(p.rot, g.rot, cat?.parts?.[g.part], greedyRot);
  }
  const pairRate = total ? hits / total : 0;
  const coverage = Math.min(1, G.length ? P.length / G.length : 1);
  return {
    score: round(pairRate * coverage),
    fieldHits: round(hits, 3),
    fieldTotal: total,
    pairRate: round(pairRate),
    pairs: pairs.length,
    extraPred,
    missingGt,
  };
}

/* ---------------------------------------------------------------- physical */

/**
 * physical：把 pred 依次 snapPart 到模型副本上，逐条判定
 *   - snapPart 抛错 / 父件不存在 / 凸点越界 → 该条 0
 *   - 落位后与模型既有零件 partsCollide → 该条 0
 *   - 与同批已接受的兄弟件穿模 → 该条 0（按 pred 顺序，先到先得）
 * 再跑 validate（可用 validateFn 注入，测试里可替换为轻量桩），按 error 数惩罚 1/(1+n)。
 *
 * @returns {{
 *   score:number, accepted:number, total:number,
 *   perAction:Array<{index:number, ok:boolean, reason:string|null}>,
 *   validateErrors:number, validateErrorCodes:string[], noOverlap:number
 * }}
 */
export function scorePhysical(pred, model, cat, { validateFn = validate, runValidate = true } = {}) {
  const clone = JSON.parse(JSON.stringify(model));
  const parts = clone.parts = Array.isArray(clone.parts) ? clone.parts : [];
  const defOf = (id) => cat.parts[id];
  const perAction = [];
  let acceptedCount = 0, overlapHits = 0;

  // 直接穿模率只在「几何上真的重叠」时计数（用于 noOverlap 诊断指标）
  const boxesCache = new Map();
  const boxesOf = (p) => {
    if (!boxesCache.has(p.id)) boxesCache.set(p.id, partBoxes(p, defOf(p.part)));
    return boxesCache.get(p.id);
  };

  pred.forEach((raw, idx) => {
    const a = normalizeAction(raw);
    const fail = (reason) => { perAction.push({ index: idx, ok: false, reason }); return false; };

    const parent = parts.find((p) => p.id === a.on && p.id !== undefined);
    if (!parent) { fail(`父零件 ${a.on || '(空)'} 不在当前模型中（越界引用或尚未安装）`); return; }
    const parentDef = defOf(parent.part);
    const childDef = defOf(a.part);
    if (!parentDef) { fail(`目录里没有父零件 ${parent.part}`); return; }
    if (!childDef) { fail(`目录里没有零件 ${a.part}`); return; }
    if (cat.colors && !cat.colors[String(a.color)]) { fail(`颜色代码 ${a.color} 不在颜色表中`); return; }

    let placed = null;
    try {
      placed = snapPart(parent, parentDef, a.stud,
        { id: `_pred_${idx}`, part: a.part, color: a.color, rot: a.rot, up: undefined },
        childDef, a.receptor);
    } catch (e) {
      fail(`snapPart 失败：${e.message}`);
      return;
    }
    if (!placed) { fail('snapPart 返回 null'); return; }

    // 与既有零件逐件 3D 复核
    const childBoxes = partBoxes(placed, childDef);
    for (const other of parts) {
      const otherDef = defOf(other.part);
      if (!otherDef) continue;
      const otherBoxes = boxesOf(other);
      let hit = null;
      try { hit = partsCollide(placed, childDef, childBoxes, other, otherDef, otherBoxes); } catch { hit = null; }
      if (hit) {
        overlapHits++;
        fail(`与零件 ${other.id}（${other.part}）穿模，命中点 ${JSON.stringify(hit)}`);
        return;
      }
    }

    // 接受该条：写入模型副本，成为后续 pred 的兄弟件
    placed.step = Math.max(1, ...parts.map((p) => p.step || 1));
    parts.push(placed);
    boxesCache.set(placed.id, childBoxes);
    acceptedCount++;
    perAction.push({ index: idx, ok: true, reason: null });
  });

  let validateErrors = 0;
  let validateErrorCodes = [];
  if (runValidate) {
    try {
      const v = validateFn(clone, cat);
      validateErrors = (v.errors || []).length;
      validateErrorCodes = (v.errors || []).map((e) => e.code);
    } catch (e) {
      validateErrors = 1;
      validateErrorCodes = [`validate-threw:${e.message.slice(0, 120)}`];
    }
  }

  const total = pred.length;
  const acceptRate = total ? acceptedCount / total : 1;
  const penalty = 1 / (1 + validateErrors);
  return {
    score: round(acceptRate * penalty),
    acceptRate: round(acceptRate),
    accepted: acceptedCount,
    total,
    perAction,
    validateErrors,
    validateErrorCodes,
    noOverlap: total ? round(1 - overlapHits / total) : 1,
  };
}

/* ---------------------------------------------------------------- 汇总 */

/**
 * 归一化权重：visual 缺失时 physical/snapMatch 重新归一（0.5/0.3 → 0.625/0.375）
 */
export function combineScore({ physical, snapMatch, visual }) {
  const active = [];
  if (Number.isFinite(physical)) active.push(['physical', physical, WEIGHTS.physical]);
  if (Number.isFinite(snapMatch)) active.push(['snapMatch', snapMatch, WEIGHTS.snapMatch]);
  if (Number.isFinite(visual)) active.push(['visual', visual, WEIGHTS.visual]);
  const wSum = active.reduce((a, [, , w]) => a + w, 0);
  if (!wSum) return { score: 0, weights: {} };
  let s = 0;
  const weights = {};
  for (const [k, v, w] of active) { const nw = w / wSum; weights[k] = round(nw); s += v * nw; }
  return { score: round(Math.min(1, Math.max(0, s))), weights };
}

/**
 * 纯函数总评分：单条预测 → 奖励。
 *
 * @param {object} args
 * @param {Array} args.pred        模型给出的动作数组（6 字段）
 * @param {Array} args.gt          Ground Truth 动作数组（6 字段）
 * @param {object} args.model      .brick.json（基准状态 S_{t-1}）
 * @param {object} args.cat        合并目录
 * @param {Function} [args.validateFn]  注入的 validate（默认 core.validate）
 * @param {boolean} [args.runValidate=true]
 * @param {number|null} [args.visual=null]  runDiff 的 overall.score
 * @param {boolean} [args.greedyRot=false]
 */
export function scorePrediction({
  pred, gt, model, cat, validateFn = validate, runValidate = true, visual = null, greedyRot = false,
}) {
  const errors = [];
  const predArr = Array.isArray(pred) ? pred : [];
  const gtArr = Array.isArray(gt) ? gt : [];
  if (!Array.isArray(pred)) errors.push('pred 不是数组');
  if (!Array.isArray(gt)) errors.push('gt 不是数组');

  const physical = scorePhysical(predArr, model, cat, { validateFn, runValidate });
  const snap = scoreSnapMatch(predArr, gtArr, { cat, greedyRot });
  const visualScore = Number.isFinite(visual) ? round(Math.min(1, Math.max(0, visual))) : null;
  const { score, weights } = combineScore({ physical: physical.score, snapMatch: snap.score, visual: visualScore });

  const ok = physical.accepted === predArr.length && predArr.length > 0 && (physical.validateErrors === 0);
  return {
    ok,
    score,
    breakdown: {
      physical: physical.score,
      snapMatch: snap.score,
      visual: visualScore,
      noOverlap: physical.noOverlap,
    },
    weights,
    details: {
      physical: {
        accepted: physical.accepted,
        total: physical.total,
        acceptRate: physical.acceptRate,
        validateErrors: physical.validateErrors,
        validateErrorCodes: physical.validateErrorCodes,
        perAction: physical.perAction,
      },
      snapMatch: snap,
    },
    errors,
  };
}

/* ---------------------------------------------------------------- CLI */

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`无法识别的参数：${a}`);
    const k = a.slice(2), n = argv[i + 1];
    if (n !== undefined && !n.startsWith('--')) { flags.set(k, n); i++; } else flags.set(k, true);
  }
  if (flags.has('help') || !flags.size) {
    process.stdout.write('node tools/brickvlm-reward.mjs --predictions <preds.jsonl> --model <base.brick.json> '
      + '[--photos <photos.json> --dir <photo dir>] [--out <reward.jsonl>] [--greedy-rot] [--no-validate] [--skip-visual] [--pretty]\n');
    return;
  }

  const predFile = flags.get('predictions');
  if (typeof predFile !== 'string') throw new Error('缺少 --predictions <preds.jsonl>');
  const modelFile = flags.get('model');
  if (typeof modelFile !== 'string') throw new Error('缺少 --model <base.brick.json>');

  const cat = loadCatalog(ROOT);
  const baseModel = readJSON(path.resolve(ROOT, modelFile));
  const modelCache = new Map([[path.resolve(ROOT, modelFile), baseModel]]);
  const modelFor = (mf) => {
    if (!mf) return baseModel;
    const abs = path.resolve(ROOT, mf);
    if (!modelCache.has(abs)) modelCache.set(abs, readJSON(abs));
    return modelCache.get(abs);
  };

  const lines = fs.readFileSync(path.resolve(ROOT, predFile), 'utf8').split(/\r?\n/).filter((s) => s.trim());
  const greedyRot = Boolean(flags.get('greedy-rot'));
  const runValidate = !flags.get('no-validate');
  const skipVisual = Boolean(flags.get('skip-visual'));
  const photos = typeof flags.get('photos') === 'string' ? flags.get('photos') : null;
  const dir = typeof flags.get('dir') === 'string' ? flags.get('dir') : null;

  // 视觉项需要 runDiff（昂贵：启动浏览器 + 多机位渲染），整批只算一次
  let visualScore = null;
  if (photos && dir && !skipVisual) {
    try {
      const { runDiff } = await import('../src/core/diff.js');
      const report = await runDiff(baseModel, cat, readJSON(path.resolve(ROOT, photos)), path.resolve(ROOT, dir),
        { outDir: path.resolve(ROOT, 'out/reward-diff'), width: 640, mode: 'joint', geom: 'ldraw' });
      visualScore = report.overall?.score ?? null;
    } catch (e) {
      process.stderr.write(`[warn] 视觉项跳过（runDiff 失败）：${e.message}\n`);
      visualScore = null;
    }
  }

  const results = [];
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch (e) { results.push({ ok: false, score: 0, breakdown: { physical: 0, snapMatch: 0, visual: null, noOverlap: 0 }, errors: [`JSON 解析失败：${e.message}`] }); continue; }
    const model = modelFor(row.modelFile);
    const r = scorePrediction({ pred: row.pred, gt: row.gt, model, cat, runValidate, visual: visualScore, greedyRot });
    results.push({ model: row.model ?? null, step: row.step ?? null, ...r });
  }

  const outFile = typeof flags.get('out') === 'string' ? flags.get('out') : null;
  if (outFile) {
    fs.mkdirSync(path.dirname(path.resolve(ROOT, outFile)), { recursive: true });
    fs.writeFileSync(path.resolve(ROOT, outFile), results.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  for (const r of results) process.stdout.write(JSON.stringify(r) + '\n');

  const mean = results.length ? results.reduce((a, r) => a + r.score, 0) / results.length : 0;
  process.stdout.write(JSON.stringify({
    ok: true, rows: results.length, meanScore: round(mean, 4),
    visualUsed: Number.isFinite(visualScore), out: outFile,
  }, null, flags.has('pretty') ? 2 : 0) + '\n');
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
  process.exit(1);
});
