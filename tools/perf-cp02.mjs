// CP-02 性能对引擎实现参数化的基准脚本（与 out/prd-v2/2026-10-26-a/A/perf/baseline-freeze.mjs 同夹具同口径）。
//
// 用途：
//   1) 同一台机器上，对「优化前快照」与「优化后现役实现」各跑一遍，得到诚实的新旧对比；
//   2) 同时输出行为等价指纹（validate 全量 JSON / stateHash / renderState 输出的稳定哈希），
//      新旧两份指纹必须逐字节一致，证明优化是行为保持的。
//
// 夹具生成算法与 baseline-freeze.mjs 逐字相同（makeModel），保证 modelSha256 与冻结基线可对上。
//
// 用法：
//   node tools/perf-cp02.mjs --core <src/core 目录> --out <perf.json> --fp <fingerprint.json>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? path.resolve(ROOT, process.argv[i + 1]) : def;
}
const coreDir = arg('--core', path.join(ROOT, 'src', 'core'));
const outFile = arg('--out', path.join(ROOT, 'out', 'perf-cp02.json'));
const fpFile = arg('--fp', '');

const load = (rel) => import(pathToFileURL(path.join(coreDir, rel)).href);
const core = await load('core.js');
const stateMod = await load('actions-v1/state.js');
const candMod = await load('actions-v1/candidates.js');
const renderMod = await load('actions-v1/render-state.js');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readJSON = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

const cat = {
  parts: { ...readJSON('catalog/parts-ldraw.json').parts, ...readJSON('catalog/parts.json').parts },
  colors: readJSON('catalog/colors.json').colors,
};

/** 与 baseline-freeze.mjs 完全相同的确定性夹具（逐字复制，禁止改动数值） */
function makeModel(n) {
  const parts = [{ id: 'b0001', part: '3001', color: 15, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 }];
  for (let i = 1; i < n; i++) {
    const layer = Math.floor(i / 6), col = i % 6;
    parts.push({
      id: `b${String(i + 1).padStart(4, '0')}`, part: '3001', color: 15,
      at: [col * 6, layer * 3, 0], rot: 0, up: '+y', snot: 0, step: layer + 1,
    });
  }
  return { format: 'brickbuild', version: '0.2', meta: { name: `perf-${n}` }, parts };
}

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 1000) / 1000;
};
const summarize = (arr) => ({
  samples: arr.length,
  p50Ms: pct(arr, 50), p95Ms: pct(arr, 95), minMs: pct(arr, 0), maxMs: pct(arr, 100),
  meanMs: Math.round((arr.reduce((a, b) => a + b, 0) / (arr.length || 1)) * 1000) / 1000,
});
function timeIt(fn, reps) {
  const out = [];
  for (let i = 0; i < reps; i++) {
    const t = process.hrtime.bigint();
    fn();
    out.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return out;
}

// 稳定序列化：剔除运行耗时字段，其余（含 skipped 计数、错误顺序）全部参与指纹
const stableStringify = (v) => {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => !['elapsedMs', 'generatedAt', 'recordedAt', 'checkedAt'].includes(k))
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};
const fp = (v) => sha256(Buffer.from(stableStringify(v), 'utf8'));

const results = { method: 'CP-02 impl-parametrized bench', coreDir: path.relative(ROOT, coreDir), env: {}, cases: {} };
results.env = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cpuModel: (os.cpus()[0]?.model ?? 'unknown').trim(),
  cpuCount: os.cpus().length,
  totalMemMb: Math.round(os.totalmem() / 1048576),
  measuredAt: new Date().toISOString(),
  implFingerprints: {},
};
for (const rel of ['core.js', 'actions-v1/state.js', 'actions-v1/candidates.js', 'actions-v1/render-state.js']) {
  results.env.implFingerprints[rel] = sha256(fs.readFileSync(path.join(coreDir, rel)));
}

for (const n of [100, 1000]) {
  const model = makeModel(n);
  const modelHash = sha256(JSON.stringify(model));
  const entry = { parts: n, modelSha256: modelHash };

  entry.validate = summarize(timeIt(() => core.validate(JSON.parse(JSON.stringify(model)), cat), n >= 1000 ? 3 : 7));
  entry.inspectState = summarize(timeIt(() => stateMod.inspectFromModel(JSON.parse(JSON.stringify(model)), cat, { mainRootNodeId: 'b0001' }), n >= 1000 ? 3 : 7));
  const si = stateMod.inspectFromModel(model, cat, { mainRootNodeId: 'b0001' });
  entry.nodes = si.state.nodes.length;
  entry.connections = si.state.connections.length;
  entry.occupancy = si.state.occupancy.length;

  const camQ = { model, cat, camera: { azimuthDeg: 35, elevationDeg: 40, target: [3, 1, 0], distance: 30, width: 1200, height: 900 }, maxLabels: 24 };
  entry.renderState = summarize(timeIt(() => renderMod.renderState({ ...camQ, model: JSON.parse(JSON.stringify(model)) }), n >= 1000 ? 3 : 5));
  const rs = renderMod.renderState(camQ);
  entry.renderStateLabels = rs.labels?.length ?? null;

  entry.enumerateCandidates = summarize(timeIt(() => candMod.enumerateCandidates(si.state, { childPartId: '3024', parentNodeId: 'b0001', maxResults: 64 }, cat), n >= 1000 ? 3 : 5));
  const cr = candMod.enumerateCandidates(si.state, { childPartId: '3024', parentNodeId: 'b0001', maxResults: 64 }, cat);
  entry.candidateCount = cr.count;
  entry.candidateNoSolutionReason = cr.noSolutionReason;

  const iso = { format: 'brickbuild', version: '0.2', parts: [{ id: 'solo', part: '3001', color: 15, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 }] };
  const isoState = stateMod.inspectFromModel(iso, cat, { mainRootNodeId: 'solo' });
  entry.enumerateIsolated = summarize(timeIt(() => candMod.enumerateCandidates(isoState.state, { childPartId: '3024', maxResults: 64 }, cat), 9));

  entry.heapUsedMb = Math.round(process.memoryUsage().heapUsed / 1048576);
  entry.rssMb = Math.round(process.memoryUsage().rss / 1048576);
  results.cases[`n${n}`] = entry;
  console.log(JSON.stringify({ n, validateP50: entry.validate.p50Ms, renderP50: entry.renderState.p50Ms, candP50: entry.enumerateCandidates.p50Ms }));
}

// —— 行为等价指纹：真实模型上的完整输出（新旧实现必须一致） ——
if (fpFile) {
  const eqModels = [
    ['perf-100', makeModel(100)],
    ['perf-1000', makeModel(1000)],
    ['60239-fixed', readJSON('out/prd-v2/run-20261026-c/C/integration/60239/60239.fixed.brick.json')],
    ['mecha', readJSON('examples/mecha.brick.json')],
    ['cottage', readJSON('examples/cottage.brick.json')],
    ['lantern', readJSON('examples/lantern.reconstructed.brick.json')],
    ['trex', readJSON('examples/trex.reconstructed.brick.json')],
    ['demo-ext-part', readJSON('examples/demo-ext-part.brick.json')],
  ];
  const fingerprints = {};
  for (const [name, model] of eqModels) {
    const v = core.validate(JSON.parse(JSON.stringify(model)), cat);
    const si = stateMod.inspectFromModel(JSON.parse(JSON.stringify(model)), cat, { mainRootNodeId: (model.parts[0] || {}).id });
    const rs = renderMod.renderState({
      model: JSON.parse(JSON.stringify(model)), cat,
      camera: { azimuthDeg: 35, elevationDeg: 40, target: [3, 1, 0], distance: 60, width: 1200, height: 900 },
      maxLabels: 24,
    });
    const rec = {
      validateSha256: fp(v),
      validateOk: v.ok,
      validateErrorCount: v.errors.length,
      validateWarningCount: v.warnings.length,
      stateHash: si.stateHash,
      connections: si.state.connections.length,
      occupancy: si.state.occupancy.length,
      renderStateSha256: fp(rs),
      renderStateLabels: rs.labels?.length ?? null,
      renderStateSkipped: rs.skipped ? fp(rs.skipped) : null,
    };
    fingerprints[name] = rec;
    console.log(JSON.stringify({ eq: name, ok: v.ok, errors: v.errors.length, hash: si.stateHash.slice(0, 12) }));
  }
  fs.mkdirSync(path.dirname(fpFile), { recursive: true });
  fs.writeFileSync(fpFile, JSON.stringify({ coreDir: path.relative(ROOT, coreDir), fingerprints }, null, 2) + '\n', 'utf8');
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(results, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ ok: true, file: path.relative(ROOT, outFile) }));
