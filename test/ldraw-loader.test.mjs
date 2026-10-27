// src/ldraw/loader.mjs 单元测试：LDraw .dat 解析（线类型、子文件引用、颜色继承、面数统计、
// 坐标换算、INVERTNEXT/镜像绕组、循环/深度/缺文件保护）。全部注入内存 resolver 或临时目录镜像，
// 不依赖浏览器；真实库冒烟仅在 catalog/ldraw-full|ldraw 存在时执行（否则跳过）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'os';
import path from 'path';
import { parseLine, buildPartFromText, createResolver, buildPart, buildModelGeometries, LDRAW_ROOTS } from '../src/ldraw/loader.mjs';

// —— 线类型解析 ————————————————————————————————————————————————
test('parseLine 识别 6 种线类型并拒绝注释/空行/非法行', () => {
  assert.deepEqual(parseLine('0 Brick 2 x 4'), { type: 0, invertNext: false, subfile: false, endFile: false });
  assert.equal(parseLine('  0 BFC INVERTNEXT').invertNext, true);
  assert.equal(parseLine('0 FILE 3001.dat').subfile, true);
  assert.equal(parseLine('0 NOFILE').endFile, true);

  const ref = parseLine('1 16 10 -20 30 2 0 0 0 2 0 0 0 2 parts\\3001s01.dat 尾注');
  assert.equal(ref.type, 1);
  assert.equal(ref.color, 16);
  assert.deepEqual(ref.pos, [10, -20, 30]);
  assert.deepEqual(ref.m, [2, 0, 0, 0, 2, 0, 0, 0, 2]);
  assert.equal(ref.file, 'parts\\3001s01.dat 尾注');

  const ln = parseLine('2 24 0 0 0 20 0 0');
  assert.deepEqual({ type: ln.type, color: ln.color, a: ln.a, b: ln.b }, { type: 2, color: 24, a: [0, 0, 0], b: [20, 0, 0] });

  const tri = parseLine('3 4 0 0 0 10 0 0 0 10 0');
  assert.deepEqual(tri.pts, [[0, 0, 0], [10, 0, 0], [0, 10, 0]]);

  const quad = parseLine('4 16 0 0 0 20 0 0 20 20 0 0 20 0');
  assert.equal(quad.type, 4);
  assert.equal(quad.pts.length, 4);

  assert.equal(parseLine('5 24 10 20 30 -10 -20 -30').type, 5);

  for (const bad of ['', '   ', '6 16 0 0 0', '3 16 0 0 0 10 0 0', '3 x 0 0 0 10 0 0 0 10 0',
    '1 16 0 0 0 1 0 0 0 1 0 0 0', '4 16 0 0 0 20 0 0 20 20 0 0 20 NaN']) {
    assert.equal(parseLine(bad), null, `应拒绝 ${JSON.stringify(bad)}`);
  }
});

// —— 内存 resolver 辅助 —————————————————————————————————————————————
const memResolve = (files) => (raw) => {
  const key = String(raw).trim().toLowerCase().replace(/\\/g, '/');
  const hit = files[key] ?? files[key.split('/').pop()];
  return hit === undefined ? null : hit;
};

// —— 面数统计与坐标换算 ——————————————————————————————————————————————
test('buildPartFromText 面/线计数：四边形拆 2 三角，线段与类型5分别计数', () => {
  const text = [
    '0 Test Part',
    '4 16 0 0 0 20 0 0 20 20 0 0 20 0',
    '3 16 0 0 0 10 0 0 0 10 0',
    '2 24 0 0 0 20 0 0',
    '5 24 10 20 30 -10 -20 -30',
  ].join('\n');
  const r = buildPartFromText(text, { resolve: () => null, color: 4 });
  assert.equal(r.stats.quads, 1);
  assert.equal(r.stats.triangles, 1);
  assert.equal(r.stats.lineSegments, 1);
  assert.equal(r.stats.type5, 1);
  // 四边形→2 三角 + 顶层 1 三角都归主色组 4：共 3 个三角形 27 个数
  assert.equal(r.groups['4'].length, 27);
  // 线段归 lines 不混入 groups；色码 24 是边线色，记录在继承主色 4 下
  assert.deepEqual(Object.keys(r.lines), ['4']);
  assert.equal(r.lines['4'].length, 6);
});

test('buildPartFromText 坐标换算：x/20、-y/20、-z/20 加 origin 偏移（格/片单位）', () => {
  // LDraw stud 平面在 y=0、实体向下 +y：顶点 (40,24,20) → 本地 (2, -1.2, -1) + origin
  const r = buildPartFromText('4 16 40 24 20 0 24 20 0 24 0 40 24 0', { resolve: () => null, color: 4, origin: [1, 1.2, -1] });
  // 期望 y = -24/20 + 1.2 = 0（底面），x = 2+1=3，z = -1-1=-2
  const got = r.groups['4'].slice(0, 3);
  assert.deepEqual(got, [3, 0, -2]);
});

// —— 颜色继承 ————————————————————————————————————————————————
test('buildPartFromText 颜色继承：16/24 沿引用链继承主色，直接色码保留', () => {
  const files = {
    'main.dat': ['0 Main', '3 7 0 0 0 10 0 0 0 10 0', '1 5 0 0 0 1 0 0 0 1 0 0 0 1 sub.dat', '1 9 0 0 0 1 0 0 0 1 0 0 0 1 sub.dat'].join('\n'),
    'sub.dat': ['0 Sub', '3 16 0 0 0 10 0 0 0 10 0', '3 24 0 0 0 10 0 0 0 10 0', '3 14 0 0 0 10 0 0 0 10 0'].join('\n'),
  };
  const r = buildPartFromText(files['main.dat'], { resolve: memResolve(files), color: 4, fileName: 'main.dat' });
  // 直接色码 7 独立成组
  assert.equal(r.groups['7'].length, 9);
  // 子文件里 16 与 24 都继承引用行色码 5 / 9
  assert.equal(r.groups['5'].length, 18);
  assert.equal(r.groups['9'].length, 18);
  // 子文件里直接色码 14 不受继承影响；sub 被引用两次（色 5 与 9）→ 各组 2 个三角形
  assert.equal(r.groups['14'].length, 18);
  // 顶层主色 4 未被用到则不成组
  assert.ok(!('4' in r.groups));
});

// —— 子文件解析：矩阵应用 ——————————————————————————————————————————————
test('buildPartFromText 子文件引用沿矩阵链变换顶点', () => {
  const files = {
    'main.dat': '1 16 20 0 0 1 0 0 0 1 0 0 0 1 sub.dat',
    'sub.dat': '3 16 0 0 0 10 0 0 0 10 0',
  };
  const r = buildPartFromText(files['main.dat'], { resolve: memResolve(files), color: 4, fileName: 'main.dat' });
  // 子件局部 (10,0,0) 平移 20 LDU → LDraw (30,0,0) → 本地 (1.5,0,0)
  const v = r.groups['4'];
  const xs = v.filter((_, i) => i % 3 === 0);
  assert.ok(xs.includes(1.5), `应含本地 x=1.5，实际 ${xs}`);
});

// —— 绕组：INVERTNEXT 与镜像 —————————————————————————————————————————————
test('buildPartFromText INVERTNEXT 仅翻转紧跟子引用的绕组，镜像引用同样翻转', () => {
  const tri = '3 16 0 0 0 10 0 0 0 10 0';
  const files = {
    'main.dat': ['0 Main', '1 16 0 0 0 1 0 0 0 1 0 0 0 1 tri.dat', '0 BFC INVERTNEXT', '1 16 0 0 0 1 0 0 0 1 0 0 0 1 tri.dat', '3 16 0 0 0 10 0 0 0 10 0'].join('\n'),
    'tri.dat': tri,
  };
  const r = buildPartFromText(files['main.dat'], { resolve: memResolve(files), color: 4, fileName: 'main.dat' });
  // 顶层三角形（无翻转）=[A,B,C]；INVERTNEXT 的子树 = [A,C,B]；镜像 det<0 引用也翻转
  const filesM = { 'main.dat': '1 16 0 0 0 -1 0 0 0 1 0 0 0 1 tri.dat', 'tri.dat': tri };
  const rm = buildPartFromText(filesM['main.dat'], { resolve: memResolve(filesM), color: 4, fileName: 'main.dat' });
  const asTriples = (arr) => [0, 3, 6].map((o) => [arr[o], arr[o + 1], arr[o + 2]]);
  // 顶点本地坐标：A=[0,0,0] B=[0.5,0,0] C=[0,-0.5,0]
  const expectPlain = [[0, 0, 0], [0.5, 0, 0], [0, -0.5, 0]];
  const expectFlip = [[0, 0, 0], [0, -0.5, 0], [0.5, 0, 0]];
  const plain = r.groups['4'].slice(0, 9), inverted = r.groups['4'].slice(9, 18), topDirect = r.groups['4'].slice(18, 27);
  const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
  assert.ok(close(asTriples(plain)[0], expectPlain[0]) && close(asTriples(plain)[1], expectPlain[1]) && close(asTriples(plain)[2], expectPlain[2]), 'INVERTNEXT 前=正向');
  assert.ok(close(asTriples(inverted)[0], expectFlip[0]) && close(asTriples(inverted)[1], expectFlip[1]) && close(asTriples(inverted)[2], expectFlip[2]), 'INVERTNEXT 后=反向');
  assert.ok(close(asTriples(topDirect)[0], expectPlain[0]), 'INVERTNEXT 不影响其后的行');
  // 镜像：x 取反 (0.5→-0.5) 且绕组翻转
  const mx = rm.groups['4'];
  assert.ok(Math.abs(mx[3] - -0.5) < 1e-6 || Math.abs(mx[6] - -0.5) < 1e-6, '镜像 x 应取反');
});

// —— 保护机制：循环引用 / 缺文件 / 递归深度 —————————————————————————————————
test('buildPartFromText 循环引用、缺文件与过深递归均显式计数不发散', () => {
  // 循环
  const cyc = buildPartFromText('1 16 0 0 0 1 0 0 0 1 0 0 0 1 self.dat', { resolve: () => '1 16 0 0 0 1 0 0 0 1 0 0 0 1 self.dat', color: 4, fileName: 'self.dat' });
  assert.equal(cyc.stats.cycles, 1);
  assert.ok(cyc.notes.includes('cycle:self.dat'));
  // 缺文件
  const miss = buildPartFromText('1 16 0 0 0 1 0 0 0 1 0 0 0 1 gone.dat', { resolve: () => null, color: 4 });
  assert.equal(miss.stats.missingFiles, 1);
  assert.ok(miss.notes.includes('missing:gone.dat'));
  // 过深：链 a→b→c→d，maxDepth=2 时 d 被截断
  const chain = (n) => `1 16 0 0 0 1 0 0 0 1 0 0 0 1 f${n + 1}.dat`;
  const filesC = { 'f1.dat': chain(1), 'f2.dat': chain(2), 'f3.dat': chain(3), 'f4.dat': '0 end' };
  const deep = buildPartFromText(filesC['f1.dat'], { resolve: memResolve(filesC), color: 4, maxDepth: 2 });
  assert.equal(deep.stats.tooDeep, 1);
});

// —— 镜像目录解析（临时目录，模拟 parts/、p/、s/ 布局） ————————————————————————
test('createResolver 按 parts/、p/ 与 s/ 前缀解析镜像引用，越界/缺失返回 null', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brickkit-ldres-'));
  try {
    fs.mkdirSync(path.join(root, 'parts', 's'), { recursive: true });
    fs.mkdirSync(path.join(root, 'p'), { recursive: true });
    fs.writeFileSync(path.join(root, 'parts', 'a.dat'), '0 A');
    fs.writeFileSync(path.join(root, 'p', 'prim.dat'), '0 P');
    fs.writeFileSync(path.join(root, 'parts', 's', 'sub.dat'), '0 S');
    const resolve = createResolver([root]);
    assert.equal(resolve('a.dat'), '0 A');
    assert.equal(resolve('p\\prim.dat'), '0 P');
    assert.equal(resolve('s\\sub.dat'), '0 S');
    assert.equal(resolve('gone.dat'), null);
    assert.equal(resolve('../evil.dat'), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// —— 顶层 buildPart / buildModelGeometries —————————————————————————————————
test('buildPart 无 .dat 返回 null（调用方回退），有 def 时按 ldrawOrigin 定位', () => {
  assert.equal(buildPart({ partId: '99999', color: 4, resolve: () => null }), null);
  const files = { '3001.dat': '4 16 -40 0 -20 40 0 -20 40 24 -20 -40 24 -20' };
  const b = buildPart({ partId: '3001', color: 4, def: { ldrawOrigin: [0, 3, 0] }, resolve: memResolve(files) });
  assert.equal(b.partId, '3001');
  // y=-24/20+3*0.4=0（底面 y=0）
  assert.equal(b.groups['4'].length, 18);
});

test('buildModelGeometries 去重 part|color、缺 .dat 入 noDat、缺色记 notes', () => {
  const model = { parts: [
    { id: 'p1', part: '3001', color: 4 },
    { id: 'p2', part: '3001', color: 4 },   // 同件同色 → 只构建一次
    { id: 'p3', part: '3001', color: 999 }, // 目录缺色 999 → note
    { id: 'p4', part: '88888', color: 4 },  // 镜像缺 .dat → noDat
  ] };
  const cat = { parts: { 3001: { size: [4, 2], h: 3 } }, colors: { 4: { hex: '#C8702A' } } };
  const files = { '3001.dat': '4 16 -40 0 -20 40 0 -20 40 24 -20 -40 24 -20' };
  const r = buildModelGeometries(model, cat, { resolve: memResolve(files) });
  assert.deepEqual(Object.keys(r.data).sort(), ['3001|4', '3001|999']);
  assert.deepEqual(r.noDat, ['88888|4']);
  assert.ok(r.notes.some((n) => n.startsWith('missing-color:999')), `notes 应含缺色，实际 ${r.notes}`);
  assert.equal(r.parts, 2);
  // 四边形 1 个 → triangles = 2
  assert.equal(r.triangles, 4);
});

// —— 真实库冒烟（镜像缺失时跳过） ————————————————————————————————————————————
test('真实镜像 3001.dat 构建成功且包围盒符合 2×4 砖', (t) => {
  const resolve = createResolver(LDRAW_ROOTS);
  if (!resolve('3001.dat')) return t.skip('catalog/ldraw-full 与 catalog/ldraw 均无 3001.dat');
  const b = buildPart({ partId: '3001', color: 4, def: { ldrawOrigin: [0, 3, 0], h: 3 }, resolve });
  assert.equal(b.stats.missingFiles, 0);
  let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (const arr of Object.values(b.groups)) for (let i = 0; i < arr.length; i += 3) for (let k = 0; k < 3; k++) {
    mn[k] = Math.min(mn[k], arr[i + k]); mx[k] = Math.max(mx[k], arr[i + k]);
  }
  // 2×4 砖：x∈[-2,2]、z∈[-1,1]、底面 y=0（顶含凸点至 ~1.4）
  for (const [i, lo, hi] of [[0, -2.01, 2.01], [1, 0, 1.6], [2, -1.01, 1.01]]) {
    assert.ok(mn[i] >= lo && mx[i] <= hi, `bbox 第${i}维 [${mn[i]},${mx[i]}] 应在 [${lo},${hi}]`);
  }
  assert.ok(b.stats.triangles + b.stats.quads > 0, '应有实体面');
});
