// 连接层守卫（2026-11 修复的回归基线）
//
// 起因：一次「模型零件底层连接层」排查发现 validate 与 actions-v1/state.js 对同一模型给出
// 不同连通结论，根因是两条判据各自为政：
//   ① validate 的「整数网格快径」只按 footprint 命中下方凸点就加边，**不看上方零件底面有没有底孔**；
//      => 实测底面无反孔的零件（50745 轮拱 / 11208 轮辋 / 科技梁）被凭空粘到下方零件上。
//   ② partsConnected 的轮胎↔轮毂同轴判据只比横截面圆心，**不约束沿轮轴的偏移**；
//      => 60239 里同一侧轮辋与另一根轴上的轮胎相距 5 格仍被判同心，造出 4 条跨车幽灵连接。
// 本文件把两个不变式钉死：任何一条被改回去，这里立刻红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { validate, partsConnected, partConnectors, rimTyreMatches, halfSpanAlong, mergeCatalogParts } from '../src/core/core.js';
import { inspectFromModel } from '../src/core/actions-v1/state.js';

const ext = JSON.parse(fs.readFileSync('catalog/parts-ldraw.json', 'utf8')).parts;
const curated = JSON.parse(fs.readFileSync('catalog/parts.json', 'utf8')).parts;
// 目录合并必须走唯一入口 mergeCatalogParts（test/catalog-merge.test.mjs 守门）
const cat = {
  parts: mergeCatalogParts(ext, curated),
  colors: JSON.parse(fs.readFileSync('catalog/colors.json', 'utf8')).colors,
};

test('快径守卫：底面无反孔的零件不能被下方凸点「盲连」（50745 轮拱）', () => {
  // 元件事实：50745 官方 .dat 无底腔反孔图元 -> antistudCells: []，partConnectors 不产出 antistud 受体
  const def = cat.parts['50745'];
  assert.deepEqual(def.antistudCells, [], '50745 应当没有底孔（官方几何实测）');
  const mud = { id: 'm1', part: '50745', color: 1, at: [0, 1, 0], step: 2 };
  const plate = { id: 'p1', part: '3023b', color: 1, at: [0, 0, 0], step: 1 };
  assert.equal(
    partsConnected(plate, cat.parts['3023b'], mud, def, partConnectors(plate, cat.parts['3023b']), partConnectors(mud, def)),
    false,
    '物理判据：轮拱压在板上不构成扣合',
  );
  const v = validate({ format: 'brickbuild', version: '0.2', meta: { name: 'bottom-hole-guard' }, parts: [plate, mud] }, cat);
  const floating = v.errors.filter((e) => e.code === 'floating');
  assert.ok(
    floating.length && floating[0].parts.includes('m1'),
    '校验器必须与物理判据一致地报 m1 悬空，而不是用整数快径把它粘到板上',
  );
});

test('快径守卫：有底孔的常规零件照旧按整格加边（不误伤）', () => {
  const brick = { id: 'b1', part: '3001', color: 1, at: [0, 0, 0], step: 1 };
  const plate = { id: 'p1', part: '3020', color: 1, at: [0, 3, 0], step: 2 };
  const v = validate({ format: 'brickbuild', version: '0.2', meta: { name: 'fastpath-ok' }, parts: [brick, plate] }, cat);
  assert.equal(v.errors.filter((e) => e.code === 'floating').length, 0, '常规砖板叠放不得被判悬空');
  assert.equal(v.stats.connectedComponents, 1, '常规砖板叠放必须是单一刚体');
});

test('同轴守卫：轮胎↔轮毂必须轴向搭接（同侧扣合成立，跨 5 格不成立）', () => {
  const rimDef = cat.parts['11208'], tyreDef = cat.parts['11209'];
  assert.equal(rimDef.wheel.axis, 'z');
  const mk = (id, part, at) => ({ id, part, color: 1, at, step: 1 });
  // 位姿取自 60239 的真实同侧装配（轮辋 offGrid：at 与轮胎差半格 + 1 层，连接器才同心）
  const rim = mk('r1', '11208', [1, 1, 0]);
  const tyreNear = mk('t1', '11209', [0.5, 0, 0]);
  const tyreFar = mk('t2', '11209', [0.5, 0, 5]);        // 沿轮轴平移 5 格（60239 的跨轴幽灵连接）
  assert.equal(partsConnected(rim, rimDef, tyreNear, tyreDef), true, '同侧轮辋↔轮胎必须扣合');
  assert.equal(partsConnected(rim, rimDef, tyreFar, tyreDef), false, '轴距 5 格的「隔空同心」必须被拒');

  // 半跨度取自目录声明尺寸（size=[x,z]），轴向容差 = 两件半跨度之和 + 0.2
  const hr = halfSpanAlong(rimDef, 'z'), ht = halfSpanAlong(tyreDef, 'z');
  assert.ok(hr > 0 && ht > 0, '轮/胎应能给出沿轮轴的半跨度');
  const rimConn = partConnectors(rim, rimDef), tyreConn = partConnectors(tyreFar, tyreDef);
  const rimEntry = rimConn.studs.find((s) => s.kind === 'rim');
  const tyreEntry = tyreConn.receptors.find((r) => r.kind === 'tyre');
  assert.ok(rimEntry && tyreEntry);
  assert.equal(rimTyreMatches(rimEntry, rimDef, tyreEntry, tyreDef), false);
  assert.ok(Math.abs(rimEntry.pos[2] - tyreEntry.pos[2]) > hr + ht + 0.2);
});

test('回归：60239 的四个车轮不再靠幽灵连接粘进车身（validate 与 state 分量一致）', () => {
  const model = JSON.parse(fs.readFileSync('examples/60239.fixed.brick.json', 'utf8'));
  const si = inspectFromModel(model, cat, {});
  const v = validate(model, cat);
  assert.equal(
    v.stats.connectedComponents,
    si.stats.components,
    'validate 与 actions-v1/state.js 的连通分量数必须一致（旧实现 4 vs 6）',
  );
  const rimTyrePairs = [];
  for (const c of si.state.connections) {
    const pa = model.parts.find((p) => p.id === c.aNodeId);
    const pb = model.parts.find((p) => p.id === c.bNodeId);
    const pair = [pa.part, pb.part].sort().join('|');
    if (pair === '11208|11209') rimTyrePairs.push([pa, pb]);
  }
  assert.equal(rimTyrePairs.length, 4, '只允许 4 组同侧轮胎↔轮毂（旧的 8 组含 4 条跨轴幽灵连接）');
  for (const [pa, pb] of rimTyrePairs) {
    const rim = pa.part === '11208' ? pa : pb;
    const tyre = pa.part === '11209' ? pa : pb;
    assert.ok(Math.abs(rim.at[2] - tyre.at[2]) <= 0.5, '轮 ' + rim.id + ' 与胎 ' + tyre.id + ' 必须同轴同侧');
  }
});
