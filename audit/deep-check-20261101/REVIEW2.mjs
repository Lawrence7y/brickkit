// REVIEW2 —— 对「F1 修复复核」说明中三处依据的独立复验（2026-11-01 第二轮）
//
// 目标：把复核意见里的三条纠正变成可复跑断言，并固定当前 F1 状态。
//   1) 白名单 95→91 是否可复现（单变量：只换普通凸点兜底分支）
//   2) 主仓是否已有可复用的 .dat 递归解析器（loader.mjs），支架最低点误差属于下界公式
//   3) tools/probe-p1.mjs 是否真的用原反例 + 断言证明修复
//   另固定：F1 原反例在当前源码下被拒。
//
// 只读生产源码；唯一的写入是本目录 REVIEW2.json 与 out/_tmpvar 下的内存变体文件。
// 用法：node audit/deep-check-20261101/REVIEW2.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'REVIEW2.json');
const TMP = path.join(ROOT, 'out/_tmpvar');
const rd = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const results = [];
const run = async (id, title, fn) => {
  const t0 = Date.now();
  try {
    const data = await fn();
    results.push({ id, title, ok: true, ms: Date.now() - t0, data });
    console.log('PASS ' + id + ' ' + title + '  (' + (Date.now() - t0) + 'ms)');
  } catch (e) {
    results.push({ id, title, ok: false, ms: Date.now() - t0, error: String(e && e.message || e) });
    console.log('FAIL ' + id + ' ' + title + '\n     ' + String(e && e.message || e).split('\n')[0]);
  }
};

const core = await import(pathToFileURL(path.join(ROOT, 'src/core/core.js')).href);
const L = await import(pathToFileURL(path.join(ROOT, 'src/ldraw/loader.mjs')).href);
const { inspectFromModel } = await import(pathToFileURL(path.join(ROOT, 'src/core/actions-v1/state.js')).href);

const extParts = rd('catalog/parts-ldraw.json').parts;
const curatedParts = rd('catalog/parts.json').parts;
const colors = rd('catalog/colors.json').colors;
// 目录 A：EN-05 夹具用的条目级覆盖（test/engine-c3-en05-connections.test.mjs 第 25-31 行）
const CAT_A = { parts: { ...extParts, ...curatedParts }, colors };
// 目录 B：CLI / core 的字段级合并
const CAT_B = { parts: core.mergeCatalogParts(extParts, curatedParts), colors };

const model = rd('examples/60239.fixed.brick.json');
const byId = new Map(model.parts.map((p) => [p.id, p]));

// ── 1. 白名单是单变量还是双变量：95→91 不复现 ────────────────────────────────
// 变体 A（历史写法）：黑名单兜底（排除 bar/pin/minifig 之外一律可以扣 antistud）
// 变体 B（当前源码）：白名单 top/side
function buildVariant(name, transform) {
  fs.mkdirSync(TMP, { recursive: true });
  const src = fs.readFileSync(path.join(ROOT, 'src/core/core.js'), 'utf8');
  const out = transform(src);
  assert.notEqual(out, src, '变体未生效：替换目标字符串在 core.js 中不存在');
  const file = path.join(TMP, 'core-' + name + '.mjs');
  fs.writeFileSync(file, out);
  return pathToFileURL(file).href;
}
const WHITELIST_BLOCK = /const PLAIN_STUD_KINDS = new Set\(\['top', 'side'\]\);\r?\n\s*if \(PLAIN_STUD_KINDS\.has\(s\.kind\) && r\.kind === 'antistud'\) return s\.dir === r\.dir && close\(s\.pos, r\.pos\);/;

function requiredPairs(cat) {
  const si = inspectFromModel(model, cat, {});
  const pairs = new Map();
  for (const c of si.state.connections) {
    if (!c.aConnectorId) continue;
    const k = [c.aNodeId, c.bNodeId].sort().join('|');
    pairs.set(k, true);
  }
  return [...pairs.keys()].sort().map((k) => {
    const [a, b] = k.split('|');
    const A = byId.get(a), B = byId.get(b);
    let child, parent;
    if (A.snap && A.snap.on === b) { child = A; parent = B; }
    else if (B.snap && B.snap.on === a) { child = B; parent = A; }
    else { child = a > b ? A : B; parent = a > b ? B : A; }
    return { key: k, parent, child };
  });
}
function countConnected(cat, pairs, matcher = core) {
  let ok = 0; const bad = [];
  for (const pr of pairs) {
    const defA = cat.parts[pr.parent.part], defB = cat.parts[pr.child.part];
    if (matcher.partsConnected(pr.parent, defA, pr.child, defB)) ok++;
    else bad.push(pr.key + ' ' + pr.parent.part + '/' + pr.child.part);
  }
  return { ok, bad };
}

await run('C1-whitelist', '白名单兜底不丢连接：EN-05 两套目录各 95/95', () => {
  const variantUrl = buildVariant('blacklist', (src) => src.replace(WHITELIST_BLOCK,
    "const PLAIN_STUD_KINDS = null;\n  if (s.kind !== 'bar' && s.kind !== 'pin' && s.kind !== 'minifig' && r.kind === 'antistud') return s.dir === r.dir && close(s.pos, r.pos);"));
  return import(variantUrl).then((blacklistCore) => {
    const out = { catalogs: {}, blacklistSameCount: null };
    for (const [name, cat] of [['A-entry-overwrite(EN-05)', CAT_A], ['B-field-merge(CLI)', CAT_B]]) {
      const pairs = requiredPairs(cat);
      const cur = countConnected(cat, pairs);
      const blk = countConnected(cat, pairs, blacklistCore);
      out.catalogs[name] = { required: pairs.length, whitelistConnected: cur.ok, blacklistConnected: blk.ok, lost: cur.bad };
      assert.equal(pairs.length, 95, name + ' 必需连接数应为 95，实得 ' + pairs.length);
      assert.equal(cur.ok, 95, name + ' 白名单下应 95/95，实得 ' + cur.ok + ' 丢失 ' + cur.bad.join(' '));
      assert.deepEqual(cur.bad, [], name + ' 不应丢连接');
    }
    // 关键对照：两种写法在 EN-05 上计数完全相同 → 单变量替换不可能产生 95→91
    assert.equal(out.catalogs['A-entry-overwrite(EN-05)'].blacklistConnected, 95,
      '黑名单下也应是 95：若不同，说明当年 95→91 另有变量');
    return out;
  });
});

await run('C1-census', '95 条连接的凸点类型普查：无白名单之外的合法普通凸点', () => {
  const pairs = requiredPairs(CAT_A);
  const kinds = new Map();
  const rows = [];
  for (const pr of pairs) {
    const cA = core.partConnectors(pr.parent, CAT_A.parts[pr.parent.part]);
    const cB = core.partConnectors(pr.child, CAT_A.parts[pr.child.part]);
    let hit = null;
    for (const s of cA.studs) for (const r of cB.receptors) if (core.connectorPairMatches(s, r)) { hit = s.kind + '→' + r.kind; break; }
    if (!hit) for (const s of cB.studs) for (const r of cA.receptors) if (core.connectorPairMatches(s, r)) { hit = s.kind + '→' + r.kind; break; }
    // 轮对不走 connectorPairMatches：rim↔tyre 由 partsConnected 里的 tyreRim 专用判据处理
    if (!hit) {
      const rimA = cA.studs.some((s) => s.kind === 'rim'), tyreA = cA.receptors.some((s) => s.kind === 'tyre');
      const rimB = cB.studs.some((s) => s.kind === 'rim'), tyreB = cB.receptors.some((s) => s.kind === 'tyre');
      if ((rimA && tyreB) || (rimB && tyreA)) hit = 'rim↔tyre(tyreRim 专用分支)';
    }
    assert.ok(hit, '未找到匹配接口：' + pr.key);
    kinds.set(hit, (kinds.get(hit) || 0) + 1);
    rows.push({ pair: pr.key, kinds: hit });
  }
  return { pairs: rows.length, byKind: Object.fromEntries([...kinds].sort((a, b) => b[1] - a[1])) };
});

// ── 2. F1 原反例：当前源码拒绝，历史黑名单写法接受 ─────────────────────────
const ev = rd('audit/deep-check-20261101/evidence.json');
const EV_BALL = ev.cases.ballToAntistud;
const PARENT = { id: 'p', part: '14417', color: 1, at: [0, 0, 0], rot: 0, up: '+y', step: 1 };
// 原始反例的完整形态：子件带着 mount 记录（F1-FIX-REVIEW 记的 mount=ball）。
// 缺 mount 时 validate 没有「声称已挂上」的断言，自然不报 mount-disconnected——
// 这一点已由 out/_tmp-diag 复核：no-mount → ok:true / 0E，mount-p → ok:false / mount-disconnected。
const CHILD = { ...EV_BALL.snap, id: 'c', mount: 'p' };

await run('F1-original', '复用 evidence.json 原始反例位姿：匹配/连通/snap/validate 全部拒绝', () => {
  const pc = core.partConnectors(PARENT, CAT_A.parts['14417']);
  const cc = core.partConnectors(CHILD, CAT_A.parts['3024']);
  const ball = pc.studs.find((s) => s.kind === 'ball');
  const anti = cc.receptors.find((r) => r.kind === 'antistud');
  assert.ok(ball && anti, '前置：必须能取到 ball 凸点与 antistud 受体');
  assert.deepEqual(ball.pos, EV_BALL.ball.pos, '球头坐标必须与原始反例一致');
  assert.equal(core.connectorPairMatches(ball, anti), false, 'ball↔antistud 必须不匹配');
  assert.equal(core.partsConnected(PARENT, CAT_A.parts['14417'], CHILD, CAT_A.parts['3024']), false, 'partsConnected 必须 false');
  assert.throws(() => core.snapPart(PARENT, CAT_A.parts['14417'], 2, CHILD, CAT_A.parts['3024'], 0), /.+/, 'snapPart 必须抛错');
  const v = core.validate({ format: 'brickbuild', version: '0.2', parts: [PARENT, CHILD] }, CAT_A);
  assert.equal(v.ok, false, 'validate 不得判合格');
  assert.ok((v.errors || []).some((e) => e.code === 'mount-disconnected'), '应报 mount-disconnected');
  return {
    pose: { ball: ball.pos, childAt: CHILD.at, childUp: CHILD.up },
    matched: false, connected: false,
    snapThrows: (() => { try { core.snapPart(PARENT, CAT_A.parts['14417'], 2, CHILD, CAT_A.parts['3024'], 0); return false; } catch { return true; } })(),
    validate: { ok: v.ok, errors: v.errors.map((e) => e.code) },
  };
});

await run('F1-witness', '同一反例在历史黑名单写法下仍为 true：修复点确实在白名单', async () => {
  const blacklistCore = await import(buildVariant('blacklist2', (src) => src.replace(WHITELIST_BLOCK,
    "const PLAIN_STUD_KINDS = null;\n  if (s.kind !== 'bar' && s.kind !== 'pin' && s.kind !== 'minifig' && r.kind === 'antistud') return s.dir === r.dir && close(s.pos, r.pos);")));
  const connected = blacklistCore.partsConnected(PARENT, CAT_A.parts['14417'], CHILD, CAT_A.parts['3024']);
  assert.equal(connected, true, '黑名单写法应当再次放行该反例（否则说明反例失效）');
  return { blacklistConnected: connected };
});

// ── 3. loader.mjs 递归解析：支架最低点误差属于下界公式 ───────────────────────
await run('C2-loader', '.dat 递归展开：四件 missing/cycles/tooDeep 全 0，支架网格最低 3.5 片', () => {
  const resolve = L.createResolver();
  const want = ['99781', '36841', '11208', '11209'];
  const rows = [];
  for (const id of want) {
    const b = L.buildPart({ partId: id, color: 16, def: CAT_A.parts[id], resolve });
    assert.ok(b, id + ' 必须能构建');
    assert.equal(b.stats.missingFiles, 0, id + ' missingFiles 应为 0');
    assert.equal(b.stats.cycles, 0, id + ' cycles 应为 0');
    assert.equal(b.stats.tooDeep, 0, id + ' tooDeep 应为 0');
    const verts = [];
    for (const arr of Object.values(b.groups)) for (let i = 0; i < arr.length; i += 3) verts.push([arr[i], arr[i + 1], arr[i + 2]]);
    const minY = Math.min(...verts.map((v) => v[1]));
    const zs = verts.map((v) => v[2]);
    rows.push({ id, files: b.stats.files, triangles: b.stats.triangles + b.stats.quads * 2, minLocalYStuds: +minY.toFixed(3), zSpan: [+Math.min(...zs).toFixed(3), +Math.max(...zs).toFixed(3)] });
  }
  const p = { part: '99781', color: 1, at: [0, 5, 0], rot: 0, up: '+y' };
  const boxes = core.partBoxes(p, CAT_A.parts['99781']);
  const boxMinY = Math.min(...boxes.map((b) => b.y0));
  const boxMaxY = Math.max(...boxes.map((b) => b.y1));
  const meshMinYPlates = 5 + rows[0].minLocalYStuds * 2.5;
  const vH = 3;
  const lowerBound = 5 + (1 - vH) * core.PLATE * 2.5;
  assert.equal(+meshMinYPlates.toFixed(3), 3.5, '支架网格最低应为 3.5 片，实得 ' + meshMinYPlates);
  assert.equal(+boxMinY.toFixed(3), 3.0, '碰撞盒最低应为 3.0 片');
  assert.equal(+lowerBound.toFixed(3), 3.0, '下界公式 (1-vH)*PLATE 应正好得到 3.0');
  const H = CAT_A.parts['99781'].h * core.PLATE * 2.5;   // h=1 → 1 片
  assert.equal(+H.toFixed(3), 1.0, 'h=1 时 H 应为 1 片');
  assert.equal(+(boxMaxY - 5).toFixed(3), 1.0, '竖板上界 = at.y + 1 片 = H：本例上界不是误差来源');
  return { parts: rows, bracket: { at: 5, boxMinY: +boxMinY.toFixed(3), boxMaxY: +boxMaxY.toFixed(3), meshMinYPlates: +meshMinYPlates.toFixed(3), lowerBoundFormula: +lowerBound.toFixed(3), h: CAT_A.parts['99781'].h, H: +H.toFixed(3), upperBoundEqualsH: true } };
});

// ── 4. tools/probe-p1.mjs：断言式回归是否成立 ───────────────────────────────
await run('C3-probe', 'probe-p1.mjs 用原反例 + 断言，可直接判成败', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/probe-p1.mjs'), 'utf8');
  const stat = {
    importsAssert: /from 'node:assert\/strict'/.test(src),
    callsMatcher: /connectorPairMatches\(/.test(src),
    assertCount: (src.match(/\bassert\.(equal|ok|throws|deepEqual)\(/g) || []).length,
    usesEvidencePose: /\[0\.5, 0, -0\.5\]/.test(src) && /'\-z'/.test(src),
    hasExitOnFail: /assert\.|process\.exit/.test(src),
  };
  assert.ok(stat.importsAssert, 'probe-p1 应 import node:assert/strict');
  assert.ok(stat.callsMatcher, 'probe-p1 应调用 connectorPairMatches（而不是只比坐标）');
  assert.ok(stat.assertCount >= 4, 'probe-p1 断言数应 ≥ 4，实得 ' + stat.assertCount);
  assert.ok(stat.usesEvidencePose, 'probe-p1 应使用原始反例位姿 [0.5,0,-0.5] / up=-z');
  let runOut = '';
  try {
    runOut = execFileSync(process.execPath, ['tools/probe-p1.mjs'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error('probe-p1 运行失败（期望 exit 0）：' + String(e.stderr || e.message).slice(0, 400));
  }
  assert.match(runOut, /F1 回归通过/, 'probe-p1 应打印通过标记');
  return { ...stat, stdout: runOut.trim().split('\n').slice(-2) };
});

// ── 5. 套件 ───────────────────────────────────────────────────────────────
await run('suite', '完整套件当前计数', () => {
  const out = execSync('node --test test/*.test.mjs 2>&1', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const num = (k) => { const m = out.match(new RegExp('^# ' + k + ' (\\d+)$', 'm')); return m ? +m[1] : null; };
  const r = { tests: num('tests'), pass: num('pass'), fail: num('fail'), skipped: num('skipped') };
  assert.equal(r.fail, 0, '套件不应有失败');
  assert.equal(r.tests, 308, '套件应为 308 项');
  return r;
});

const failed = results.filter((r) => !r.ok);
const report = { startedAt: new Date().toISOString(), root: ROOT, head: execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(), results, failed: failed.length };
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
console.log('\n' + (failed.length ? 'FAILED ' + failed.length : 'ALL PASS') + ' → ' + path.relative(ROOT, OUT));
process.exit(failed.length ? 1 : 0);
