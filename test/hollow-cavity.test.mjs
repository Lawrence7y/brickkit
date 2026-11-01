// 底面空腔（hollow）契约测试 —— r2（Leader）
//
// 独立审查 audit/independent-review-r2-20261031/REVIEW.md 的漏洞反例 1 指出：
// 第一版 hollow 只画「顶板 + 4 周壁」，把乐高砖底部真实的抗凸点圆管/中心销一并抹掉，
// 于是「一块 1x3 板横穿中央圆管」会报 0 碰撞 —— 那是假阴性后门。
//
// 本文件现在锁死的是「空腔**不是空的**」这一物理事实：
//   · 砖/板空腔里有圆管（2x2 以上）或中心销（1xN），它们必须继续参与碰撞；
//   · hollow 只把「壁与壁之间的空隙」让出来，不让出圆管；
//   · 因为用外径当实心方盒，这个近似只会多报、不会漏报。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partBoxes, boxesCollide } from '../src/core/core.js';

const brickDef = (extra = {}) => ({ size: [4, 2], h: 3, kind: 'brick', ...extra });
const brick = { id: 'b1', part: '3001', at: [0, 0, 0], rot: 0, up: '+y' };
const plateAt = (at, size = [1, 1]) => ({ id: 'p1', part: 'x', at, rot: 0, up: '+y' });
const plateDef = (size = [1, 1]) => ({ size, h: 1, kind: 'plate' });

test('HC-01 默认（不设 hollow）行为不变：1 个盒，覆盖 y=0..H', () => {
  const b = partBoxes(brick, brickDef());
  assert.equal(b.length, 1);
  assert.deepEqual([b[0].x0, b[0].x1, b[0].y0, b[0].y1, b[0].z0, b[0].z1], [0, 4, 0, 3, 0, 2]);
});

test('HC-02 hollow=true：顶板 + 4 周壁 + 圆管（4x2 砖 → 3 根管，共 8 个盒）', () => {
  const b = partBoxes(brick, brickDef({ hollow: true }));
  // 5 个壳盒 + 3 个圆管盒（geom.js 同口径：i=0..sx-2, k=0..sz-2 → 3×1）
  assert.equal(b.length, 8, '应为 顶板+4壁+3管，实得 ' + b.length);
  // 圆管应当是「从底面到顶板」的柱状盒，而不是零高度片
  const tubes = b.filter((x) => (x.x1 - x.x0) < 0.7 && (x.z1 - x.z0) < 0.7);
  assert.equal(tubes.length, 3, '应有 3 个圆管盒');
  for (const t of tubes) {
    assert.ok(t.y0 === 0 && t.y1 > 2.5, '圆管必须从底面延伸到顶板，实得 ' + JSON.stringify([t.y0, t.y1]));
  }
});

test('HC-03 【审查反例1 回归】1x3 板横穿 2x4 砖中央圆管 → 必须报碰撞', () => {
  const hollow = partBoxes(brick, brickDef({ hollow: true }));
  const p = partBoxes(plateAt([0.5, 0, 0.5], [3, 1]), plateDef([3, 1]));
  assert.notEqual(boxesCollide(hollow, p), null,
    '实物上会切断圆管，必须报碰撞（第一版 hollow 在这里漏报）');
});

test('HC-04 【审查反例2 回归】1x1 板平放在空腔内也躲不开圆管', () => {
  const hollow = partBoxes(brick, brickDef({ hollow: true }));
  // 之前的测试断言这里「不碰撞」，正是靠圆管被掏空才成立的 —— 那是错的
  const p = partBoxes(plateAt([1, 0, 0.5]), plateDef());
  assert.notEqual(boxesCollide(hollow, p), null, '平放插入必然撞管，不得漏报');
});

test('HC-05 砖叠砖仍然成立（空腔不制造假碰撞）', () => {
  const def = brickDef({ hollow: true });
  const lower = partBoxes({ ...brick, at: [0, 0, 0] }, def);
  const upper = partBoxes({ ...brick, at: [0, 3, 0] }, def);
  assert.equal(boxesCollide(lower, upper), null, '上下相切不应判碰撞');
});

test('HC-06 壁厚吃掉截面时退回实心，且不生成零厚度盒', () => {
  const b = partBoxes({ ...brick, part: 'tiny' }, brickDef({ hollow: true, size: [1, 1], wall: 0.6 }));
  assert.equal(b.length, 1, '1x1 + 0.6 壁 → 退回单一实心盒');
  for (const x of b) assert.ok(x.x1 > x.x0 && x.y1 > x.y0 && x.z1 > x.z0, '不得出现零厚度盒');
});

test('HC-07 自定义 boxes 优先于 hollow；occupies:false 仍完全透明', () => {
  assert.equal(partBoxes(brick, brickDef({ hollow: true, boxes: [[0, 1, 0, 1, 0, 1]] })).length, 1);
  assert.equal(partBoxes(brick, brickDef({ hollow: true, occupies: false })).length, 0);
});

test('HC-08 1xN 件用中心销而不是圆管（geom.js 同口径）', () => {
  const b = partBoxes({ ...brick, part: 'y' }, { size: [1, 4], h: 1, kind: 'plate', hollow: true });
  // 壳 5 个 + 中心销 3 个（k=0..sz-2）
  assert.equal(b.length, 8, '实得 ' + b.length);
  // 中心销是 0.3 格宽的正方截面（±0.15）；-x/+x 壁只有 0.08 宽，别把壁算成销
  const pins = b.filter((x) => Math.abs((x.x1 - x.x0) - 0.3) < 1e-9 && Math.abs((x.z1 - x.z0) - 0.3) < 1e-9);
  assert.equal(pins.length, 3, '1x4 应有 3 个中心销，实得 ' + pins.length);
});