// Phase 1 单元测试：参数化装配树存储 (snap/rootAt/recompute/reanchor)、
// 3D 正交翻立子模型挂装 (addAssembly/importSubmodel)、自动寻点 (findMounts) 与反地摊连通门禁 (submodel/strictAssembly)。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createBuilder } from '../src/core/builder.js';
import { validate, recompute, findMounts, partsConnected } from '../src/core/core.js';

const curated = JSON.parse(fs.readFileSync('catalog/parts.json', 'utf8'));
const ext = JSON.parse(fs.readFileSync('catalog/parts-ldraw.json', 'utf8'));
const cat = {
  parts: { ...ext.parts, ...curated.parts },
  colors: JSON.parse(fs.readFileSync('catalog/colors.json', 'utf8')).colors,
};

test('参数化装配树：snap 与 rootAt 持久化，reanchor 抬高底盘时全车单件与子组件自动级联跟随', () => {
  const b = createBuilder({ catalog: cat, meta: { name: 'cascade-test' } });
  const base = b.add('3001', 15, { at: [0, 0, 0], step: 1 });
  const mid = b.add('3002', 19, { on: base.id, stud: 0, receptor: 0, step: 2 });
  const top = b.add('3021', 4, { on: mid.id, stud: 0, receptor: 0, step: 3 });

  // 子模型：在 [0,0,0] 局部空间平搭两块板，通过 importSubmodel 挂到 top 上
  const subBuilder = createBuilder({ catalog: cat, meta: { name: 'roof-sub' } });
  const s1 = subBuilder.add('3023', 1, { at: [0, 0, 0], step: 4 });
  subBuilder.add('54200', 15, { on: s1.id, stud: 0, receptor: 0, step: 5 });

  b.importSubmodel(subBuilder.model(), {
    id: 'roof_asm',
    on: top.id,
    stud: 2,
    anchor: s1.id,
    anchorReceptor: 0,
    rot: 0,
    step: 6,
    label: '车顶小组件',
  });

  assert.deepEqual(b.parts().find((p) => p.id === base.id).at, [0, 0, 0]);
  assert.deepEqual(b.parts().find((p) => p.id === mid.id).at, [0, 3, 0]);
  assert.deepEqual(b.parts().find((p) => p.id === top.id).at, [0, 6, 0]);
  assert.equal(b.parts().find((p) => p.id === 'roof_asm_p001').at[1], 7);
  assert.equal(b.parts().find((p) => p.id === 'roof_asm_p002').at[1], 8);

  // 将底盘从 [0, 0, 0] 抬高 4 层并平移 [2, 4, 3]
  b.reanchor(base.id, [2, 4, 3]);
  assert.deepEqual(b.parts().find((p) => p.id === base.id).at, [2, 4, 3]);
  assert.deepEqual(b.parts().find((p) => p.id === mid.id).at, [2, 7, 3]);
  assert.deepEqual(b.parts().find((p) => p.id === top.id).at, [2, 10, 3]);
  assert.equal(b.parts().find((p) => p.id === 'roof_asm_p001').at[1], 11);
  assert.equal(b.parts().find((p) => p.id === 'roof_asm_p002').at[1], 12);

  const res = b.assert();
  assert.equal(res.ok, true);
  assert.equal(res.stats.connectedComponents, 1);
  assert.equal(res.stats.largestComponentRatio, 1);
});

test('3D 正交翻立挂装：桌面平搭 (up="+y") 的前保险杠子模型一键 90° 竖立扣到 30414 侧凸点上', () => {
  // 主模型：底砖 + 30414 (1×4 侧凸点砖，rot:270 使 4 颗侧凸点朝 -x)
  const main = createBuilder({ catalog: cat, meta: { name: 'snot-mount-main' } });
  const base = main.add('3001', 15, { at: [0, 0, 0], step: 1 });
  const snotBrick = main.add('30414', 71, { on: base.id, stud: 0, receptor: 0, rot: 270, step: 2 });

  // 子模型：在自身局部桌面 [0,0,0] 平搭（up: '+y'）一个 3 层厚的保险杠组件
  const sub = createBuilder({ catalog: cat, meta: { name: 'front-bumper', submodel: true } });
  const strip = sub.add('3710', 272, { at: [0, 0, 0], rot: 90, step: 3 });          // 1×4 底板
  const cheese1 = sub.add('54200', 15, { on: strip.id, stud: 0, receptor: 0, step: 4 });
  const cheese2 = sub.add('54200', 47, { on: strip.id, stud: 1, receptor: 0, step: 4 });
  assert.equal(sub.assert({ submodel: true }).ok, true);

  // 用 findMounts 在 snotBrick 上自动查找侧凸点挂装方案
  const cands = findMounts(main.model(), sub.model(), cat, { parent: snotBrick.id });
  const sideCands = cands.filter((c) => c.studDir === '-x');
  assert.ok(sideCands.length > 0, '必须在 30414 的 -x 侧凸点上找到无穿模 3D 翻立挂装方案');

  // 使用 importSubmodel 挂装到侧凸点
  const mounted = main.importSubmodel(sub.model(), {
    id: 'fb',
    on: snotBrick.id,
    stud: sideCands[0].stud,
    anchor: strip.id,
    anchorReceptor: sideCands[0].anchorReceptor,
    rot: sideCands[0].rot,
    step: 5,
    label: '前保险杠',
  });
  assert.equal(mounted.parts.length, 3);

  const mpStrip = main.parts().find((p) => p.id === 'fb_p001');
  const mpCheese1 = main.parts().find((p) => p.id === 'fb_p002');
  const mpCheese2 = main.parts().find((p) => p.id === 'fb_p003');
  assert.equal(mpStrip.up, '-x', '桌面平搭的基板挂到 -x 侧凸点后 up 应自动翻立为 -x');
  assert.equal(mpCheese1.up, '-x', '组内叠放的斜坡 up 也应同步翻立为 -x');
  assert.equal(partsConnected(mpStrip, cat.parts[mpStrip.part], mpCheese1, cat.parts[mpCheese1.part]), true);
  assert.equal(partsConnected(mpStrip, cat.parts[mpStrip.part], mpCheese2, cat.parts[mpCheese2.part]), true);

  const vRes = main.assert({ strictAssembly: true });
  assert.equal(vRes.ok, true);
  assert.equal(vRes.stats.connectedComponents, 1);
});

test('反地摊连通率门禁：submodel 拒绝分离散件，strictAssembly 拦截待装区地摊但放行显式配件', () => {
  // 1) 子模型模式：两块不相连的砖报错 submodel-disconnected
  const badSub = createBuilder({ catalog: cat });
  badSub.add('3001', 4, { at: [0, 0, 0], step: 1 });
  badSub.add('3001', 1, { at: [10, 0, 0], step: 2 });
  const rSub = badSub.validate({ submodel: true });
  assert.equal(rSub.ok, false);
  assert.ok(rSub.errors.some((e) => e.code === 'submodel-disconnected'));

  // 2) 总装严格模式：把未装上车的车身砖摆在地上充数 → 报错 scattered-parts-tray
  const badMain = createBuilder({ catalog: cat });
  const b1 = badMain.add('3001', 4, { at: [0, 0, 0], step: 1 });
  badMain.add('3001', 4, { on: b1.id, stud: 0, step: 2 });
  badMain.add('3020', 15, { at: [20, 0, 0], step: 3 }); // 地摊散件
  const rMain = badMain.validate({ strictAssembly: true });
  assert.equal(rMain.ok, false);
  assert.ok(rMain.errors.some((e) => e.code === 'scattered-parts-tray'));

  // 3) 显式标记 accessory: true（如路障锥桶）且主干占比 >= 80% 时放行
  const goodMain = createBuilder({ catalog: cat });
  let cur = goodMain.add('3001', 4, { at: [0, 0, 0], step: 1 });
  for (let i = 0; i < 4; i++) {
    cur = goodMain.add('3001', 4, { on: cur.id, stud: 0, step: i + 2 });
  }
  goodMain.add('4740', 72, { at: [10, 0, 0], step: 6, accessory: true }); // 5 件主干 + 1 件配件 (83.3%)
  const rGood = goodMain.validate({ strictAssembly: true });
  assert.equal(rGood.ok, true);
});
