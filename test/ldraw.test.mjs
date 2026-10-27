// src/ldraw/ldraw.js 单元测试：引用路径安全、包围盒递归与矩阵、目录尺寸核对
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { refCandidates, safeJoin, bboxFromText, studPositionsFromText, isPatternedOrDerivative, verifyPart, assertOfficialUrl } from '../src/ldraw/ldraw.js';

test('assertOfficialUrl 仅放行 https 官方库域名，拒绝环回/私有/保留地址', () => {
  assertOfficialUrl('https://library.ldraw.org/library/official/parts/3001.dat');
  assertOfficialUrl('https://www.ldraw.org/library/official/parts/3001.dat');
  for (const bad of [
    'http://library.ldraw.org/library/official/parts/3001.dat',
    'https://localhost/3001.dat',
    'https://127.0.0.1/3001.dat',
    'https://10.0.0.1/3001.dat',
    'https://192.168.1.1/3001.dat',
    'https://172.16.0.1/3001.dat',
    'https://169.254.1.1/3001.dat',
    'https://evil.example.com/3001.dat',
  ]) {
    assert.throws(() => assertOfficialUrl(bad), undefined, `应拒绝 ${bad}`);
  }
});

test('refCandidates 解析引用路径并拒绝越界或非法文件名', () => {
  assert.deepEqual(refCandidates('s\\3001s01.dat'), ['parts/s/3001s01.dat']);
  assert.deepEqual(refCandidates('48\\4-4edge.dat'), ['parts/48/4-4edge.dat', 'p/48/4-4edge.dat']);
  assert.deepEqual(refCandidates('3001.dat').length, 2);
  assert.deepEqual(refCandidates('..\\evil.dat'), []);
  assert.deepEqual(refCandidates('a b.dat'), []);
});

test('safeJoin 拒绝越出素材根目录的路径', () => {
  const root = path.join(os.tmpdir(), 'brickkit-ldraw-test');
  assert.equal(safeJoin(root, 'parts/3001.dat'), path.resolve(root, 'parts/3001.dat'));
  assert.equal(safeJoin(root, '..\\evil.dat'), null);
  assert.equal(safeJoin(root, 'parts/../../evil.dat'), null);
});

test('bboxFromText 沿矩阵链精确变换叶顶点（含仿射剪切）', () => {
  const files = {
    main: [
      '0 Test Brick 2 x 1 x 3',
      '1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\tsub.dat',
      '4 16 -20 0 -10 20 0 -10 20 24 -10 -20 24 -10',
    ].join('\n'),
    's\\tsub.dat': '0 Sub\n4 16 -20 24 -10 20 24 -10 20 24 10 -20 24 10',
  };
  const box = bboxFromText(files.main, (r) => files[r.toLowerCase()] ?? null);
  assert.deepEqual(box, { min: [-20, 0, -10], max: [20, 24, 10] });

  // 旋转矩阵把子引用绕 y 轴转 90°：子件 20×40 变为 40×40 的整体包围盒
  const rotated = files.main.replace('1 16 0 0 0 1 0 0 0 1 0 0 0 1', '1 16 0 0 0 0 0 1 0 1 0 -1 0 0');
  const box2 = bboxFromText(rotated, (r) => files[r.toLowerCase()] ?? null);
  assert.deepEqual(box2, { min: [-20, 0, -20], max: [20, 24, 20] });

  // 一般仿射（斜弧面技巧）：顶点必须沿复合矩阵变换，不能用子包围盒角点近似
  const sheared = files.main.replace('1 16 0 0 0 1 0 0 0 1 0 0 0 1', '1 16 10 24.972 20 0 -20 0 -28.9719 0 -28.9719 -40 0 40');
  const box3 = bboxFromText(sheared, (r) => files[r.toLowerCase()] ?? null);
  assert.ok(box3.min[0] < box.max[0] || box3.max[0] > box.max[0] || box3.max[2] > box.max[2]);
});

test('verifyPart 按 1格=20LDU、1片=8LDU 核对并分类差异', () => {
  const box = { min: [-20, 0, -10], max: [20, 24, 10] };
  assert.equal(verifyPart({ size: [2, 1], h: 3 }, box).status, 'match');
  // +4 LDU = 顶部凸点，可解释差异
  const stud = verifyPart({ size: [2, 1], h: 3 }, { min: [-20, 0, -10], max: [20, 28, 10] });
  assert.equal(stud.status, 'stud-offset');
  assert.equal(stud.ok, true);
  // 高度差无法用凸点解释 → 硬错误（11211 类目录错误）
  const bad = verifyPart({ size: [1, 1], h: 3 }, { min: [-10, 0, -10], max: [10, 40, 10] });
  assert.equal(bad.status, 'height-error');
  assert.equal(bad.ok, false);
  // 侧凸点横向突出 → protrudes（信息性）
  const prot = verifyPart({ size: [1, 1], h: 3 }, { min: [-10, 0, -10], max: [10, 28, 14] });
  assert.equal(prot.status, 'protrudes');
  assert.equal(prot.ok, true);
});

test('studPositionsFromText 识别实心/空心顶凸点基元并过滤 SNOT 侧向凸点', () => {
  const txt = [
    '0 Test Part with Open Top Stud and Side Stud',
    '1 16 -10 0 0 1 0 0 0 1 0 0 0 1 stud.dat',
    '1 16 10 0 0 1 0 0 0 1 0 0 0 1 stud2.dat',
    '1 16 0 10 -10 1 0 0 0 0 1 0 1 0 stud2a.dat',
  ].join('\n');
  const pts = studPositionsFromText(txt, () => null);
  assert.deepEqual(pts, [[-10, 0, 0], [10, 0, 0]]);
});

test('isPatternedOrDerivative 过滤印刷/贴花/组合衍生件，保留基础素模', () => {
  assert.equal(isPatternedOrDerivative('3069b', 'Tile  1 x  2 with Groove'), false);
  assert.equal(isPatternedOrDerivative('11477', 'Slope Curved  2 x  1 No Studs'), false);
  assert.equal(isPatternedOrDerivative('3069bp01', 'Tile  1 x  2 with Arrow Pattern'), true);
  assert.equal(isPatternedOrDerivative('3001', 'Brick  2 x  4 with Red Stripe Printed'), true);
  assert.equal(isPatternedOrDerivative('2429c01', 'Hinge Plate  1 x  4 Swivel Complete'), true);
  assert.equal(isPatternedOrDerivative('10041', '~Motor Pull Back - Bottom'), true);
});
