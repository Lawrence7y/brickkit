import test from 'node:test';
import assert from 'node:assert/strict';
import { checkObservations, OBS_FORMAT } from '../src/core/observations.js';

// ------------------------------------------------------------------ 合成目录与模型
// bom() 只用 cat 做零件/颜色的展示信息查找（cat.parts[p.part]、cat.colors?.[String(p.color)]），空壳即可
const cat = { parts: {}, colors: {} };

/** 合成小模型：红 2×4 砖 ×1（3001/4）＋ 粉 1×1 板 ×3（3024/29）＋ 亮绿 2×2 圆砖 ×6（3941/10） */
function makeModel() {
  const parts = [
    { id: 'a1', part: '3001', color: 4 },
    ...[1, 2, 3].map((i) => ({ id: `p${i}`, part: '3024', color: 29 })),
    ...Array.from({ length: 6 }, (_, i) => ({ id: `c${i + 1}`, part: '3941', color: 10 })),
  ];
  return { format: 'brickbuild', version: '0.2', meta: { name: '合成对账模型' }, parts };
}

/** 合成观察清单：photos 默认两张（ph1/ph2） */
const obs = (inventory, photos = ['ph1', 'ph2']) =>
  ({ format: OBS_FORMAT, version: '0.1', photos: photos.map((id) => ({ id })), inventory });

// ------------------------------------------------------------------ 四类判定 + evidence + format
test('checkObservations：数量全部落在区间内 → ok=true、零 errors 零 warnings、stats 正确', () => {
  const r = checkObservations(obs([
    { feature: '粉板', part: ['3024'], color: 29, count: [2, 4], evidence: ['ph1'] },
    { feature: '红砖', part: ['3001'], color: 4, count: [1, 1] },
    { feature: '绿圆砖', part: ['3941'], color: [10, 15], count: [6, 6], evidence: ['ph1', 'ph2'] },
  ]), makeModel(), cat);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.stats.matched, 3);
  assert.equal(r.stats.inventory, 3);
  assert.equal(r.stats.bomEntries, 3);
  assert.equal(r.stats.totalParts, 10);
});

test('checkObservations：多候选×多颜色合并计数（求和落入区间即通过）', () => {
  // 3001/4 ×1 ＋ 3024/29 ×3 ＝ 4，落在 [4,4]（区间边界含端点）
  const r = checkObservations(obs([
    { feature: '砖+板合计', part: ['3001', '3024'], color: [4, 29], count: [4, 4] },
  ]), makeModel(), cat);
  assert.equal(r.ok, true);
  assert.equal(r.stats.matched, 1);
  assert.equal(r.warnings.filter((w) => w.code === 'obs-count').length, 0);
  assert.equal(r.errors.length, 0);
});

test('checkObservations：数量超出区间 → warning obs-count（含 feature/实际数量/区间），warning 不影响 ok', () => {
  const r = checkObservations(obs([
    { feature: '绿圆砖', part: ['3941'], color: 10, count: [1, 4] },   // 模型 6 件 > 上限 4
    { feature: '粉板', part: ['3024'], color: 29, count: [5, 8] },     // 模型 3 件 < 下限 5
  ]), makeModel(), cat);
  assert.equal(r.ok, true);
  const counts = r.warnings.filter((w) => w.code === 'obs-count');
  assert.equal(counts.length, 2);
  assert.deepEqual(counts.map((w) => w.actual), [6, 3]);
  assert.deepEqual(counts[0].count, [1, 4]);
  assert.ok(counts[0].msg.includes('绿圆砖'));
  assert.equal(r.stats.countWarnings, 2);
});

test('checkObservations：整类缺失（候选×颜色总量为 0）→ error obs-missing、ok=false', () => {
  const r = checkObservations(obs([
    { feature: '蓝板', part: ['3022', '3795'], color: 272, count: [4, 12] },   // 模型里没有深蓝件
  ]), makeModel(), cat);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].code, 'obs-missing');
  assert.equal(r.errors[0].feature, '蓝板');
  assert.equal(r.stats.missing, 1);
});

test('checkObservations：模型 (零件×颜色) 不被任何 inventory 项覆盖 → warning model-extra 列出 part×color×数量', () => {
  const r = checkObservations(obs([
    { feature: '粉板', part: ['3024'], color: 29, count: [2, 4] },   // 只覆盖粉板；红砖/绿圆砖为多出
  ]), makeModel(), cat);
  const extra = r.warnings.find((w) => w.code === 'model-extra');
  assert.ok(extra, '应有 model-extra warning');
  // bom 按 qty 降序：绿圆砖 6 → 红砖 1；覆盖掉的粉板不出现
  assert.deepEqual(extra.extras, [
    { part: '3941', color: 10, qty: 6 },
    { part: '3001', color: 4, qty: 1 },
  ]);
  assert.ok(extra.msg.includes('3941×10×6'));
  assert.equal(r.stats.extras, 2);
});

test('checkObservations：evidence 引用的照片不在 photos 里 → warning obs-evidence（逐条）', () => {
  const r = checkObservations(obs([
    { feature: '粉板', part: ['3024'], color: 29, count: [2, 4], evidence: ['ph1', 'nope'] },
  ]), makeModel(), cat);
  const ev = r.warnings.filter((w) => w.code === 'obs-evidence');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].photo, 'nope');
  assert.equal(ev[0].feature, '粉板');
  assert.equal(r.stats.evidenceWarnings, 1);
});

test('checkObservations：format 不对 → error obs-format、不再做其余检查', () => {
  const r = checkObservations({ format: 'brickbuild', inventory: [{ feature: 'x', part: ['3024'], color: 29 }] }, makeModel(), cat);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].code, 'obs-format');
  assert.deepEqual(r.warnings, []);
  assert.equal(r.stats.inventory, 0);

  const r2 = checkObservations(null, makeModel(), cat);
  assert.equal(r2.ok, false);
  assert.equal(r2.errors[0].code, 'obs-format');
});
