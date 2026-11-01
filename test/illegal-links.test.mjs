// 非法连接（illegalLinks）契约测试 —— r2（Leader）
//
// 独立审查 audit/independent-review-r2-20261031/REVIEW.md 的漏洞反例 2 指出：
// 第一版只校验 id 与 kind，于是「悬空在 (100,50,100) 的散件 + 一行 illegalLinks」
// 就能让 floating 与 mount-disconnected 全部哑火，模型直接 ok:true —— 那不是承认非法连接，
// 是任何坏模型的洗白通道。
//
// 现在的硬前置：**两件必须在三个轴上都贴住或相交**（间距 ≤ 0.05），
// 悬空在几十格以外的一对物理上不可能有摩擦/夹持，继续报错：illegal-link-not-adjacent。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mergeCatalogParts, validate, partConnectors, partsConnected } from '../src/core/core.js';

const rd = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const EXT = rd('catalog/parts-ldraw.json').parts;
const CUR = rd('catalog/parts.json').parts;
const PACK = rd('catalog/ldraw-pack.json');
const COLORS = rd('catalog/colors.json').colors;
const cat = () => ({
  parts: mergeCatalogParts(EXT, CUR, {
    datumOf: (id) => (Number.isFinite(PACK.datum?.[id]) ? PACK.datum[id] : null),
    frameOf: (id) => PACK.frame?.[id] || null,
  }),
  colors: COLORS, curated: CUR, ext: EXT,
});

// 相邻（贴面，间距 0）、但侧壁之间没有标准连接器的一对。
// 用 3001（x 0..4, y 0..3, z 0..2）坐地，另一块 1x1 板贴在它的 +x 侧壁上、离地一层：
// 这样 p1 在支撑图里是孤立的（会被判悬空），同时与 b1 三轴都贴住（满足邻近性前置）。
const adjacent = (extra = {}) => ({
  format: 'brickbuild', version: '0.2', meta: { name: 'illegal-adjacent', front: '+z' },
  parts: [
    { id: 'b1', part: '3001', at: [0, 0, 0], rot: 0, up: '+y', step: 1, color: 0 },
    { id: 'p1', part: '3024', at: [4, 2, 0], rot: 0, up: '+y', step: 2, color: 0 },
  ],
  ...extra,
});

// 审查者的反例：悬空在 100 格以外
const farApart = (extra = {}) => ({
  format: 'brickbuild', version: '0.2', meta: { name: 'exploit', front: '+z' },
  parts: [
    { id: 'b1', part: '3001', at: [0, 0, 0], rot: 0, up: '+y', step: 1, color: 0 },
    { id: 'p1', part: '3001', at: [100, 50, 100], rot: 0, up: '+y', step: 2, color: 0 },
  ],
  ...extra,
});

test('IL-01 不声明：相邻但无连接器的一对仍被判悬空（行为与引入前一致）', () => {
  const res = validate(adjacent(), cat());
  assert.ok(res.errors.map((e) => e.code).includes('floating'),
    '未声明时必须仍报悬空，实得 ' + JSON.stringify(res.errors.map((e) => e.code)));
});

test('IL-02 相邻 + 声明：悬空消失，但留下 illegal-link WARNING', () => {
  const res = validate(adjacent({ illegalLinks: [{ a: 'p1', b: 'b1', kind: 'illegal-clutch' }] }), cat());
  const codes = res.errors.map((e) => e.code);
  assert.equal(codes.includes('floating'), false, '不应再判悬空：' + JSON.stringify(codes));
  assert.ok((res.warnings || []).map((w) => w.code).includes('illegal-link'), '必须留下警告');
});

test('IL-03 【审查反例2 回归】相距 100 格的悬空件：声明必须被拒绝，悬空照报', () => {
  const res = validate(farApart({ illegalLinks: [{ a: 'p1', b: 'b1', kind: 'cavity-friction' }] }), cat());
  const codes = res.errors.map((e) => e.code);
  assert.ok(codes.includes('illegal-link-not-adjacent'),
    '必须报 illegal-link-not-adjacent（第一版在这里直接洗白），实得 ' + JSON.stringify(codes));
  assert.ok(codes.includes('floating'), '悬空必须仍然报出，实得 ' + JSON.stringify(codes));
  assert.equal(res.ok, false, '整模型不得通过');
});

test('IL-04 非法连接不改连接器语义：partsConnected 仍为 false', () => {
  const c = cat();
  const b1 = { id: 'b1', part: '3001', at: [0, 0, 0], rot: 0, up: '+y' };
  const p1 = { id: 'p1', part: '3001', at: [4, 0, 0], rot: 0, up: '+y' };
  const d = c.parts['3001'];
  assert.equal(partsConnected(b1, d, p1, d, partConnectors(b1, d), partConnectors(p1, d)), false,
    '侧壁贴住不是可扣合关系');
});

test('IL-05 配对与书写顺序无关', () => {
  const r1 = validate(adjacent({ illegalLinks: [{ a: 'p1', b: 'b1', kind: 'illegal-clutch' }] }), cat());
  const r2 = validate(adjacent({ illegalLinks: [{ a: 'b1', b: 'p1', kind: 'illegal-clutch' }] }), cat());
  assert.deepEqual(r1.errors.map((e) => e.code), r2.errors.map((e) => e.code));
});

test('IL-06 畸形声明必须报错，不能静默放过', () => {
  const cases = [
    [{ illegalLinks: {} }],
    [{ illegalLinks: [{ a: 'p1' }] }],
    [{ illegalLinks: [{ a: 'p1', b: 'p1', kind: 'cavity-friction' }] }],
    [{ illegalLinks: [{ a: 'p1', b: 'nope', kind: 'cavity-friction' }] }],
    [{ illegalLinks: [{ a: 'p1', b: 'b1', kind: 'whatever' }] }],
  ];
  for (const [extra] of cases) {
    const res = validate(adjacent(extra), cat());
    assert.ok(res.errors.map((e) => e.code).includes('illegal-links'),
      '应报 illegal-links，实得 ' + JSON.stringify(res.errors.map((e) => e.code)));
  }
});

test('IL-07 声明不能替代几何：相交的两件照样报 overlap', () => {
  const m = {
    format: 'brickbuild', version: '0.2', meta: { name: 'overlap', front: '+z' },
    parts: [
      { id: 'b1', part: '3001', at: [0, 0, 0], rot: 0, up: '+y', step: 1, color: 0 },
      { id: 'p1', part: '3001', at: [2, 0, 0], rot: 0, up: '+y', step: 2, color: 0 },
    ],
    illegalLinks: [{ a: 'p1', b: 'b1', kind: 'cavity-friction' }],
  };
  const res = validate(m, cat());
  assert.ok(res.errors.map((e) => e.code).includes('overlap'),
    '实体相交必须仍然报 overlap，实得 ' + JSON.stringify(res.errors.map((e) => e.code)));
});

test('IL-08 occupies:false（无实体盒）的一对不能声明非法连接', () => {
  // 【2026-11-01 换件】原来用 60623（门）。这一轮把门从 occupies:false 改成有实体薄门盒了，
  // 于是它不再是「无实体盒」的样本。改用扩展目录里仍为 occupies:false 的 2494（玻璃窗片）。
  const m = {
    format: 'brickbuild', version: '0.2', meta: { name: 'nobox', front: '+z' },
    parts: [
      { id: 'b1', part: '3001', at: [0, 0, 0], rot: 0, up: '+y', step: 1, color: 0 },
      { id: 'd1', part: '2494', at: [0, 0, 0], rot: 0, up: '+y', step: 2, color: 0 },
    ],
    illegalLinks: [{ a: 'd1', b: 'b1', kind: 'cavity-friction' }],
  };
  const res = validate(m, cat());
  assert.ok(res.errors.map((e) => e.code).includes('illegal-links'),
    '没有实体盒就没有物理基础，必须报错，实得 ' + JSON.stringify(res.errors.map((e) => e.code)));
});