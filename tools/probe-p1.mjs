import fs from 'node:fs';
import assert from 'node:assert/strict';
const core = await import('../src/core/core.js');
const { mergeCatalogParts, partConnectors, partsConnected, validate, snapPart, connectorPairMatches } = core;
const rd = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const CAT = { parts: mergeCatalogParts(rd('catalog/parts-ldraw.json').parts, rd('catalog/parts.json').parts), colors: rd('catalog/colors.json').colors };
const P = CAT.parts;

// ── 原始反例（audit evidence.json）：父 14417 at=[0,0,0] up=+y；子 3024 at=[0.5,0,-0.5] up=-z
const parent = { id: 'p', part: '14417', color: 1, at: [0, 0, 0], rot: 0, up: '+y', step: 1 };
const child  = { id: 'c', part: '3024',  color: 4, at: [0.5, 0, -0.5], rot: 0, up: '-z', step: 1, mount: 'p' };
const pc = partConnectors(parent, P['14417']);
const cc = partConnectors(child, P['3024']);
const ball = pc.studs.find((s) => s.kind === 'ball');
assert.ok(ball, '前置：14417 必须生成 ball 凸点');
const anti = cc.receptors.find((r) => r.kind === 'antistud');
assert.ok(anti, '前置：3024 必须有 antistud 受体');
assert.equal(connectorPairMatches(ball, anti), false, 'ball 不得匹配 antistud');
assert.equal(partsConnected(parent, P['14417'], child, P['3024']), false, 'partsConnected 必须为 false');
assert.throws(() => snapPart(parent, P['14417'], 0, child, P['3024'], 0), /./, 'snapPart 必须抛错');
const m = { format: 'brickbuild', version: '0.2', parts: [parent, child] };
const r = validate(m, CAT);
assert.equal(r.ok, false, 'validate 不得判为合格');
assert.ok((r.errors || []).some((e) => e.code === 'mount-disconnected'), '应报 mount-disconnected');

// ── 回归 1：球头↔球窝仍成立（用实测重合位姿）
const ball2 = partConnectors({ id: 'a', part: '14417', at: [1.5, 0, 1], rot: 0, up: '+y' }, P['14417']).studs.find((s) => s.kind === 'ball');
const sock = partConnectors({ id: 'b', part: '14418', at: [0, 0, 0], rot: 0, up: '+y' }, P['14418']).receptors.find((s) => s.kind === 'socket');
assert.equal(connectorPairMatches(ball2, sock), true, 'ball↔socket 必须仍然成立');

// ── 回归 2：普通顶凸点↔底孔仍成立
// 不假设下标，直接扫描一对真实重合的 top↔antistud。
const up = partConnectors({ id: 'u', part: '3001', at: [0, 0, 0], rot: 0, up: '+y' }, P['3001']);
let found = null;
for (const s of up.studs) {
  if (s.kind !== 'top') continue;
  for (const dy of [3, 3.0]) {
    const low = partConnectors({ id: 'l', part: '3020', at: [s.pos[0] - 0.5, dy, s.pos[2] - 0.5], rot: 0, up: '+y' }, P['3020']);
    for (const rr of low.receptors) {
      if (rr.kind !== 'antistud') continue;
      if (connectorPairMatches(s, rr)) { found = { s, rr }; break; }
    }
    if (found) break;
  }
  if (found) break;
}
assert.ok(found, '必须存在至少一对真实重合的 top↔antistud（否则说明普通连接被误伤）');
console.log('F1 回归通过；普通顶凸点↔底孔仍成立（找到真实重合对）');