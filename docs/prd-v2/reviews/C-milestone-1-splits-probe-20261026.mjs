/**
 * C-milestone-1-splits-probe-20261026.mjs — 独立复核探针（只读评审，PRD §13.4）
 * 评审项 5（C1-5 划分与防捷径）：
 *   1. 重算 6 个 split 文件 sha256 并与 split-manifest.json 记录比对（哈希链）；
 *   2. 确认 .frozen 存在且 freeze.frozen=true；
 *   3. 四个 split 的 sampleId 两两不相交；
 *   4. 留出家族（trajectory: fam-arch/fam-cargoer/fam-snotwall；perturbation: fam-bracketholder；
 *      manual: 10715/31062/42065）不得出现在 train；
 *   5. 抽 10 个样本核对 sampleSha256 与落盘样本文件一致；
 *   6. shortcut-probes.json 全部探针记录值 ≤ 2× 随机水平。
 * 运行：node docs/prd-v2/reviews/C-milestone-1-splits-probe-20261026.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const S = 'out/prd-v2/run-20261026-c/C/data/splits';
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, p))).digest('hex');
const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail || ''}`); };

const m = JSON.parse(fs.readFileSync(path.join(ROOT, S, 'split-manifest.json'), 'utf8'));

// 1. 哈希链
const files = [
  ['train', m.freeze.splitFiles.train],
  ['validation', m.freeze.splitFiles.validation],
  ['holdout_test', m.freeze.splitFiles.holdout_test],
  ['dev', m.freeze.splitFiles.dev],
  ['assignment', m.freeze.assignmentFile],
  ['shortcut-probes', m.probesFile],
];
let hashFails = 0;
for (const [name, entry] of files) {
  const got = sha(entry.path);
  const ok = got === entry.sha256;
  if (!ok) hashFails++;
  record(`hash ${name}`, ok, ok ? entry.path : `want=${entry.sha256} got=${got}`);
}

// 2. .frozen 存在
const frozenPath = path.join(ROOT, S, '.frozen');
const frozenOk = fs.existsSync(frozenPath) && m.freeze.frozen === true;
record('.frozen exists && manifest.freeze.frozen=true', frozenOk,
  frozenOk ? `frozenAt=${m.freeze.frozenAt}` : 'missing .frozen or frozen!=true');

// 3. 两两不相交
const sets = {};
for (const [name] of files.slice(0, 4)) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, m.freeze.splitFiles[name].path), 'utf8'));
  sets[name] = { ids: new Set(j.samples.map(s => s.sampleId)), declared: j.sampleCount, json: j };
}
let disjoint = true, overlapInfo = '';
const names = Object.keys(sets);
for (let i = 0; i < names.length; i++) for (let k = i + 1; k < names.length; k++) {
  const [a, b] = [names[i], names[k]];
  const ov = [...sets[a].ids].filter(x => sets[b].ids.has(x));
  if (ov.length) { disjoint = false; overlapInfo += ` ${a}∩${b}=${ov.length}`; }
}
const countsOk = names.every(n => sets[n].ids.size === sets[n].declared);
record('splits pairwise disjoint', disjoint, overlapInfo || `(${names.join('+')})`);
record('declared sampleCount == actual ids', countsOk,
  names.map(n => `${n}=${sets[n].declared}/${sets[n].ids.size}`).join(' '));

// 4. 留出家族不得出现在 train
const HOLDOUT_FAMS = new Set(['fam-arch', 'fam-cargoer', 'fam-snotwall', 'fam-bracketholder', '10715', '31062', '42065']);
const trainLeak = [];
for (const s of sets.train.json.samples) {
  if (HOLDOUT_FAMS.has(s.familyId)) trainLeak.push({ sampleId: s.sampleId, familyId: s.familyId, dataset: s.dataset });
}
record('held-out families absent from train', trainLeak.length === 0, trainLeak.length ? JSON.stringify(trainLeak.slice(0, 5)) : `checked ${sets.train.json.samples.length} train samples`);

// 交叉复核：留出集确实包含这些家族
const holdoutFams = new Set(sets.holdout_test.json.samples.map(s => `${s.dataset}:${s.familyId}`));
const expected = ['trajectory:fam-arch', 'trajectory:fam-cargoer', 'trajectory:fam-snotwall', 'perturbation:fam-bracketholder', 'manual:10715', 'manual:31062', 'manual:42065'];
const missingFams = expected.filter(e => !holdoutFams.has(e));
record('holdout contains the 7 declared unseen families', missingFams.length === 0, missingFams.length ? `missing: ${missingFams}` : expected.join(', '));

// 5. 抽 10 个样本核对 sampleSha256（JSONL 数据集按行哈希，manual 按整文件哈希）
let shaCheck = 0, shaFail = 0;
const pool = names.flatMap(n => sets[n].json.samples.map(s => ({ split: n, s })));
seedCheck: {
  let seed = 20261026; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const picked = new Map();
  while (picked.size < 10) picked.set(pool[Math.floor(rnd() * pool.length)].s.sampleId, pool[Math.floor(rnd() * pool.length)]);
  for (const { s } of picked.values()) {
    if (!s.sampleRef?.file) continue;
    let got;
    if (s.sampleRef.line !== undefined) {
      const line = fs.readFileSync(path.join(ROOT, s.sampleRef.file), 'utf8').split('\n')[s.sampleRef.line - 1];
      got = crypto.createHash('sha256').update(Buffer.from(line, 'utf8')).digest('hex');
    } else {
      got = sha(s.sampleRef.file);
    }
    if (got !== s.sampleSha256) { shaFail++; console.log(`  sha mismatch ${s.sampleId}: ${got}`); }
    shaCheck++;
  }
}
record('sample sha256 spot checks (10)', shaFail === 0 && shaCheck === 10, `${shaCheck - shaFail}/${shaCheck} match`);

// 6. shortcut probes ≤ 2× 随机水平（threshold: accuracy > 2×chance 视为疑似泄漏）
const probes = JSON.parse(fs.readFileSync(path.join(ROOT, m.probesFile.path), 'utf8'));
let probeFails = 0, probeCount = 0;
const probeNotes = [];
for (const [task, blk] of Object.entries(probes.results || {})) {
  const chance = blk.chance ?? blk.P1_textTableErrorType?.chance_majorityClassFreq;
  if (typeof chance !== 'number') continue;
  const flat = [];
  const walk = (o, path) => {
    if (!o || typeof o !== 'object') return;
    if (typeof o.accuracy === 'number') flat.push({ path, accuracy: o.accuracy });
    for (const [k, v] of Object.entries(o)) if (typeof v === 'object') walk(v, `${path}.${k}`);
  };
  walk(blk, task);
  for (const f of flat) {
    probeCount++;
    if (f.accuracy > 2 * chance) { probeFails++; probeNotes.push(`OVER: ${task} ${f.path} acc=${f.accuracy} chance=${chance}`); }
  }
}
for (const n of probeNotes) console.log('  ' + n);
record('shortcut probes <= 2x chance', probeCount > 0 && probeFails === 0, `${probeCount - probeFails}/${probeCount} within threshold; manifest verdict="${m.probeLeakVerdict}"`);

const evidence = {
  probe: 'splits-hash-chain-disjointness', at: new Date().toISOString(),
  hashes: files.map(([n, e]) => ({ name: n, path: e.path, expected: e.sha256, actual: sha(e.path), match: sha(e.path) === e.sha256 })),
  frozen: { fileExists: fs.existsSync(frozenPath), manifestFlag: m.freeze.frozen, frozenAt: m.freeze.frozenAt },
  disjoint, countsOk, trainLeakCount: trainLeak.length, holdoutFamiliesOk: missingFams.length === 0,
  sampleShaChecks: { checked: shaCheck, failed: shaFail },
  shortcutProbes: { checked: probeCount, overThreshold: probeFails, verdict: m.probeLeakVerdict },
  allPass: hashFails === 0 && frozenOk && disjoint && countsOk && trainLeak.length === 0 && missingFams.length === 0 && shaFail === 0 && probeCount > 0 && probeFails === 0,
};
fs.writeFileSync('docs/prd-v2/reviews/C-milestone-1-splits-probe-result-20261026.json', JSON.stringify(evidence, null, 2));
console.log(evidence.allPass ? 'ALL PASS' : 'SOME FAILED');
process.exit(evidence.allPass ? 0 : 1);
