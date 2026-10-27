// builder（程序化搭建 API）与 snapPart 防错加固的测试：
// - 约 10 件小模型：叠砖 + 板上板 + on/stud 扣合（含 SNOT 侧装）
// - 故意制造 3D 穿模 → throw 且报出对方零件 id
// - snap 出的坐标与 partConnectors 凸点坐标一致
// - validate() 零错误零警告；save() JSON 往返一致
// - snapPart 加固：receptor 越界 throw；侧凸点上指定不兼容 up 仍 throw（审计 P2 负例）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuilder } from '../src/core/builder.js';
import { snapPart, partConnectors } from '../src/core/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const cat = {
  parts: readJSON('catalog/parts.json').parts,
  colors: readJSON('catalog/colors.json').colors,
};

/** 约 10 件的小模型：2×4 砖塔（叠砖 + 板上板）+ 87087 侧凸点砖（顶面 snap + 侧面 SNOT 侧装） */
function buildTower() {
  const b = createBuilder({ catalog: cat, meta: { name: '构建器测试塔', front: '+z' } });
  b.add('3001', 0, { at: [0, 0, 0], step: 1 });                  // p001 底砖
  b.add('3001', 0, { at: [0, 3, 0], step: 2 });                  // p002 叠砖
  b.add('3022', 4, { at: [0, 6, 0], step: 3 });                  // p003 板上板（2×2 板）
  b.add('3024', 14, { at: [0, 7, 0], step: 4 });                 // p004 1×1 板
  b.add('3710', 0, { at: [0, 8, 0], step: 5 });                  // p005 1×4 板（单点支撑悬挑）
  b.add('87087', 0, { at: [6, 0, 0], step: 1 });                 // p006 SNOT 侧凸点砖
  b.add('3024', 4, { on: 'p006', stud: 1, up: '+z', step: 2 });  // p007 侧面 SNOT 侧装（snap 自动算 at）
  b.add('3024', 4, { on: 'p006', stud: 0, step: 3 });            // p008 顶面 snap（默认 receptor 0）
  b.add('3023', 0, { at: [6, 4, 0], step: 3 });                  // p009 1×2 板
  b.add('3068b', 0, { at: [6, 5, 0], step: 4 });                 // p010 2×2 平板
  return b;
}

test('构建器：add 自动编号 p001 递增、model() 输出 format/meta/parts', () => {
  const b = buildTower();
  assert.equal(b.parts().length, 10);
  assert.deepEqual(b.parts().map((p) => p.id), ['p001', 'p002', 'p003', 'p004', 'p005', 'p006', 'p007', 'p008', 'p009', 'p010']);
  const m = b.model();
  assert.equal(m.format, 'brickbuild');
  assert.equal(m.meta.name, '构建器测试塔');
  assert.equal(m.parts.length, 10);
  // snap 侧装件：up 继承凸点朝向、snot 归零
  const p007 = b.parts().find((p) => p.id === 'p007');
  assert.equal(p007.up, '+z');
  assert.equal(p007.snot, 0);
});

test('snap 扣合坐标与 partConnectors 凸点坐标一致（顶面 + 侧面各一处）', () => {
  const b = buildTower();
  const def = (p) => cat.parts[p.part];
  const parent = b.parts().find((p) => p.id === 'p006');
  const sideStud = partConnectors(parent, def(parent)).studs[1];           // 1 号 = 侧面凸点
  const topStud = partConnectors(parent, def(parent)).studs[0];            // 0 号 = 顶面凸点
  for (const [childId, stud] of [['p007', sideStud], ['p008', topStud]]) {
    const child = b.parts().find((p) => p.id === childId);
    const rec = partConnectors(child, def(child)).receptors[0];
    assert.deepEqual(rec.pos, stud.pos, `${childId} 的底孔世界坐标应与父凸点完全重合`);
    assert.equal(rec.dir, stud.dir, `${childId} 的底孔朝向应与父凸点一致`);
  }
});

test('故意制造 3D 穿模：add 抛中文错误并报出对方零件 id；失败的 add 不消耗编号', () => {
  const b = buildTower();
  assert.throws(() => b.add('3024', 4, { at: [0, 1, 0], step: 9 }), (e) => /3D 穿模/.test(e.message) && /p001/.test(e.message));
  const p11 = b.add('3024', 4, { at: [20, 0, 0], step: 9 });
  assert.equal(p11.id, 'p011');
});

test('add 参数防错：on/at 互斥、缺失 at、未知编号、未知颜色、id 重复、父零件不存在', () => {
  const b = buildTower();
  assert.throws(() => b.add('3024', 4, { on: 'p006', at: [0, 0, 0] }), /不能再手动传 at/);
  assert.throws(() => b.add('3024', 4, {}), /必须显式传整数格坐标 at/);
  assert.throws(() => b.add('3024', 4, { at: [0, 0.5, 0] }), /3 个整数/);
  assert.throws(() => b.add('9999', 0, { at: [20, 0, 0] }), /9999/);
  assert.throws(() => b.add('3024', 999, { at: [20, 0, 0] }), /颜色代码 999/);
  assert.throws(() => b.add('3024', 4, { at: [20, 0, 0], id: 'p001' }), /id 重复：p001/);
  assert.throws(() => b.add('3024', 4, { on: 'nope' }), /父零件 nope 不存在/);
});

test('validate() 零错误零警告，assert() 通过', () => {
  const b = buildTower();
  b.setModule('p003', 'tower');
  b.setModule('p004', 'tower');
  const res = b.validate();
  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
  assert.deepEqual(res.warnings, []);
  const res2 = b.assert();
  assert.equal(res2.ok, true);
});

test('assert()：有 errors 即抛出并附错误明细（悬空零件负例）', () => {
  const b = createBuilder({ catalog: cat });
  b.add('3001', 0, { at: [0, 0, 0], step: 1 });
  b.add('3024', 4, { at: [50, 3, 0], step: 2 });   // 高层孤立板：add 三项检查不拦，validate 判悬空（地面层零件视为已落地）
  assert.throws(() => b.assert(), (e) => /assert 失败/.test(e.message) && /悬空/.test(e.message) && /p002/.test(e.message));
});

test('setModule 归属、remove 移除与找不到时报错', () => {
  const b = buildTower();
  b.setModule('p010', 'cap');
  assert.equal(b.parts().find((p) => p.id === 'p010').module, 'cap');
  const removed = b.remove('p010');
  assert.equal(removed.id, 'p010');
  assert.equal(b.parts().length, 9);
  assert.equal(b.parts().some((p) => p.id === 'p010'), false);
  assert.throws(() => b.remove('p010'), /找不到零件 p010/);
  assert.throws(() => b.setModule('p010', 'x'), /找不到零件 p010/);
});

test('move：整格平移成功；撞上其他零件时抛错并回滚', () => {
  const b = buildTower();
  assert.deepEqual(b.move('p010', [2, 0, 0]).at, [8, 5, 0]);
  assert.deepEqual(b.parts().find((p) => p.id === 'p010').at, [8, 5, 0]);
  assert.throws(() => b.move('p004', [0, -6, 0]), (e) => /3D 穿模/.test(e.message) && /p001/.test(e.message));
  assert.deepEqual(b.parts().find((p) => p.id === 'p004').at, [0, 7, 0], '碰撞的 move 应已回滚');
  assert.throws(() => b.move('p004', [0.5, 0, 0]), /3 个整数/);
});

test('save()：JSON 往返一致（deepEqual 解析结果与 model()）', () => {
  const b = buildTower();
  b.setModule('p010', 'cap');
  const file = path.join(os.tmpdir(), `brickkit-builder-test-${process.pid}-${Date.now()}.brick.json`);
  try {
    assert.equal(b.save(file), file);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(parsed, b.model());
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('snapPart 加固：receptor 越界抛中文错误（不再静默回退第 0 号），默认 0 行为保留', () => {
  const parent = { id: 'pA', part: '3001', at: [0, 0, 0] };
  const parentDef = cat.parts['3001'];
  const childDef = cat.parts['3024'];
  // 3024 只有 1 个底孔：旧实现会静默用第 0 号算出坐标
  assert.throws(() => snapPart(parent, parentDef, 0, { id: 'pB', part: '3024' }, childDef, 7), /没有第 7 号底孔/);
  // 默认 receptorIndex = 0 与显式 0 结果一致
  const ok = snapPart(parent, parentDef, 0, { id: 'pB', part: '3024' }, childDef);
  assert.deepEqual(ok.at, [0, 3, 0]);
  assert.deepEqual(snapPart(parent, parentDef, 0, { id: 'pB', part: '3024' }, childDef, 0).at, [0, 3, 0]);
});

test('snapPart 加固：侧凸点上指定不兼容 up 仍抛错（方向不匹配负例），方向一致时可正常 snap', () => {
  const parent = { id: 'pA', part: '87087', at: [0, 0, 0] };
  const parentDef = cat.parts['87087'];
  const childDef = cat.parts['3024'];
  // 87087 的 1 号是 +z 侧面凸点：子件 up 仍为 +y 时凸点/底孔朝向不匹配，旧实现会照样输出坐标
  assert.throws(
    () => snapPart(parent, parentDef, 1, { id: 'pB', part: '3024', up: '+y' }, childDef),
    (e) => /物理扣合/.test(e.message) && /pA/.test(e.message) && /pB/.test(e.message) && /\+z/.test(e.message) && /\+y/.test(e.message),
  );
  // up 与凸点朝向一致（+z）时同一点位可正常扣合（at[1]=0.5：底孔中心比底面高 1.25 片，凸点在 1.75 片）
  const ok = snapPart(parent, parentDef, 1, { id: 'pC', part: '3024', up: '+z' }, childDef);
  assert.deepEqual(ok.at, [0, 0.5, 1]);
});
