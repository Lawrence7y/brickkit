// T2 目录补库单元测试（examples/60239.bom.json 的 7 条 catalog:false 缺口）：
//   ① 4 个 BOM 缺口件号（73081 方向盘底座 / 76382 人仔躯干 / 11303 人仔帽 / 73200 人仔腿部）
//      在合并目录（parts-ldraw.json ∪ parts.json）存在且 builder 可单件放置；
//   ② 3 个官方库无件号的印刷件（21023/35279/24741）的替代件在合并目录存在且 builder 可用；
//   ③ BOM 无未豁免的 catalog:false 条目（EXEMPT 当前为空，出现新的 catalog:false 即失败）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createBuilder } from '../src/core/builder.js';

const ext = JSON.parse(fs.readFileSync('catalog/parts-ldraw.json', 'utf8')).parts;
const curated = JSON.parse(fs.readFileSync('catalog/parts.json', 'utf8')).parts;
const colors = JSON.parse(fs.readFileSync('catalog/colors.json', 'utf8')).colors;
const merged = { ...ext, ...curated };
const bom = JSON.parse(fs.readFileSync('examples/60239.bom.json', 'utf8'));

// ---------------------------------------------------------------- ① 4 个 BOM 缺口件号
test('T2 缺口 4 件号在合并目录存在（73081/76382/11303/73200，官方 .dat 几何）', () => {
  for (const id of ['73081', '76382', '11303', '73200']) {
    const def = merged[id];
    assert.ok(def, `${id} 应在合并目录（ext 或 curated）`);
    assert.ok(def.auto === true, `${id} 应为 LDraw 官方几何自动提取条目`);
    assert.ok(Array.isArray(def.size) && def.size.length === 2 && def.size.every((n) => n >= 1), `${id} 占地 size 合法`);
    assert.ok(Number.isInteger(def.h) && def.h >= 1, `${id} 高度 h 合法`);
  }
  assert.equal(ext['73081'].kind, 'other', '73081 方向盘底座按名称归 other');
  assert.equal(ext['76382'].kind, 'minifig', '76382 人仔躯干归 minifig');
  assert.equal(ext['11303'].kind, 'minifig', '11303 人仔帽归 minifig');
  assert.equal(ext['73200'].kind, 'other', '73200 人仔腿部（Physical_Colour shortcut 无 minifig CATEGORY）归 other');
});

test('T2 缺口 4 件号 builder 单件放置可用（BOM 原色，assert 零错误）', () => {
  const cases = [
    ['73081', 14], // Bright Yellow，同 probe-73081
    ['76382', 212], // Light Royal Blue
    ['11303', 272], // Earth Blue
    ['73200', 272], // Earth Blue
  ];
  for (const [part, color] of cases) {
    const b = createBuilder({ catalog: { parts: merged, colors } });
    b.add(part, color, { at: [0, 0, 0], step: 1 });
    b.assert(); // 有 errors 即抛错
  }
});

// ---------------------------------------------------------------- ② 替代件
test('3 个印刷缺口（21023/35279/24741）的替代件在合并目录存在且 builder 可用', () => {
  const subs = [
    ['21023', '3626b', '印刷头→素头（Minifig Head with Blocked Hollow Stud）'],
    ['35279', '57783', '挡风玻璃→同一设计挡风玻璃（BrickLink 57783 = 35279 底模印设计号）'],
    ['24741', '85984', '印刷斜砖→素斜砖（Slope 30 1 x 2 x 2/3）'],
  ];
  for (const [design, sub, why] of subs) {
    const entry = bom.parts.find((p) => p.design === design);
    assert.ok(entry, `BOM 应含 design ${design}`);
    assert.equal(entry.catalog, true, `design ${design} 应已指向替代件（catalog:true）`);
    assert.equal(entry.substituteFor, sub, `design ${design} 替代件应为 ${sub}（${why}）`);
    assert.ok(typeof entry.substituteNote === 'string' && entry.substituteNote.length > 10, `design ${design} 应写明替代理由`);
    assert.ok(merged[sub], `替代件 ${sub} 应在合并目录`);
    const b = createBuilder({ catalog: { parts: merged, colors } });
    b.add(sub, entry.color, { at: [0, 0, 0], step: 1 }); // 用原 BOM 颜色放置
    b.assert();
  }
});

// ---------------------------------------------------------------- ③ BOM 无未豁免的 catalog:false
test('BOM 无未豁免的 catalog:false（豁免名单当前为空）', () => {
  const EXEMPT = new Set(); // 已无缺口；如后续新增缺口需挂起处理，将 design 加入此豁免名单
  const gaps = bom.parts.filter((p) => p.catalog === false && !EXEMPT.has(p.design));
  assert.deepEqual(
    gaps.map((p) => p.design),
    [],
    `以下 design 仍为 catalog:false 且未豁免：${gaps.map((p) => p.design).join(', ')}`
  );
});
