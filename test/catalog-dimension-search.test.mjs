// 尺寸智能搜索、多词组合查询与精选目录 100% 可装配及真实网格门禁测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseDimensionQuery, matchesSingleToken, matchesItemQuery, classifyCapability, CAPABILITY,
} from '../src/core/dimension-search.js';
import { partConnectors, PLATE } from '../src/core/core.js';
import { buildPart, createResolver } from '../src/ldraw/loader.mjs';

const cat = JSON.parse(fs.readFileSync('catalog/parts.json', 'utf8'));
const packJson = JSON.parse(fs.readFileSync('catalog/ldraw-pack.json', 'utf8'));

test('精选目录 100% 可装配门禁（0 display，0 unverified，0 缺失中文名，全部 connectorCount > 0 且 assemble）', () => {
  const parts = cat.parts;
  const ids = Object.keys(parts);

  assert.ok(ids.length >= 198, `精选目录应至少收录 198 个零件，实测 ${ids.length}`);

  let assembleCount = 0;
  let displayCount = 0;
  let unverifiedCount = 0;

  for (const id of ids) {
    const def = parts[id];
    const probe = { id: '_probe', part: id, at: [0, 0, 0], rot: 0, up: '+y', snot: 0 };
    const conn = partConnectors(probe, def);
    const total = conn.studs.length + conn.receptors.length;
    const stats = { total, error: null };
    const cap = classifyCapability(def, stats);

    if (cap.capability === CAPABILITY.assemble) assembleCount++;
    if (cap.capability === CAPABILITY.display) displayCount++;
    if (cap.capability === CAPABILITY.unverified) unverifiedCount++;

    assert.ok(total > 0, `零件 ${id} 的连接器数量必须大于 0，实测 ${total}`);
    assert.equal(
      cap.capability,
      CAPABILITY.assemble,
      `零件 ${id} 的 capability 必须为 assemble，实测 ${cap.capability}（原因: ${cap.reason}）`
    );

    // 中文名与英文名必须齐全
    assert.ok(def.name && def.name.trim().length > 0, `零件 ${id} 必须具有英文 name`);
    assert.ok(def.zh && def.zh.trim().length > 0, `零件 ${id} 必须具有规范中文名 zh`);
  }

  assert.equal(displayCount, 0, '精选目录不得含有 display 仅展示零件');
  assert.equal(unverifiedCount, 0, '精选目录不得含有 unverified 待核实零件');
  assert.equal(assembleCount, ids.length, '精选目录中所有零件必须全部为 assemble 可装配');
});

test('精选目录 100% 具备 LDraw 官方 .dat 真实 3D 几何（网格面片非空）', () => {
  const resolve = createResolver();
  for (const id of Object.keys(cat.parts)) {
    const def = cat.parts[id];
    const built = buildPart({ partId: id, color: 16, def, resolve });
    assert.ok(built, `零件 ${id} 必须具备可解析的官方 .dat 文件`);
    const triCount = built.stats?.triangles ?? 0;
    const groupCount = Object.keys(built.groups || {}).length;
    assert.ok(triCount > 0 || groupCount > 0, `零件 ${id} 必须具备实体三角形面片`);
  }
});

test('parseDimensionQuery 尺寸解析纯函数测试', () => {
  // 1. 3D: W x L x H
  const q3d = parseDimensionQuery('1x4x3');
  assert.ok(q3d);
  assert.equal(q3d.type, '3d');
  assert.ok(q3d.matches({ size: [1, 4], h: 3 }));
  assert.ok(q3d.matches({ size: [4, 1], h: 3 }));
  assert.ok(q3d.matches({ size: [1, 4], h: 9 })); // 无单位兼容 3 砖高
  assert.ok(!q3d.matches({ size: [1, 2], h: 3 }));
  assert.ok(!q3d.matches({ size: [1, 4], h: 1 }));

  // 3D 空格与乘号变体: 1 4 3, 2*4*1, 1×4×3
  const q3dSpace = parseDimensionQuery('1 4 3');
  assert.ok(q3dSpace);
  assert.ok(q3dSpace.matches({ size: [1, 4], h: 3 }));
  assert.ok(q3dSpace.matches({ size: [4, 1], h: 9 }));

  // 3D 带单位: 砖
  const q3db = parseDimensionQuery('1x4x1砖');
  assert.ok(q3db);
  assert.ok(q3db.matches({ size: [1, 4], h: 3 }));
  assert.ok(!q3db.matches({ size: [1, 4], h: 1 }));

  // 3D 带单位: 片
  const q3dp = parseDimensionQuery('1x2x5p');
  assert.ok(q3dp);
  assert.ok(q3dp.matches({ size: [1, 2], h: 5 }));
  assert.ok(q3dp.matches({ size: [2, 1], h: 5 }));

  // 2. 2D 对称匹配（x, *, ×, 空格）
  for (const str of ['2x4', '4x2', '2*4', '2×4', '2 4', '4 2']) {
    const q2d = parseDimensionQuery(str);
    assert.ok(q2d, `Query "${str}" 应成功解析为 2D 尺寸`);
    assert.equal(q2d.type, '2d');
    assert.ok(q2d.matches({ size: [2, 4], h: 3 }));
    assert.ok(q2d.matches({ size: [4, 2], h: 1 }));
    assert.ok(!q2d.matches({ size: [2, 3], h: 3 }));
  }

  // 3. 单轴高度
  const qH1 = parseDimensionQuery('高3');
  assert.ok(qH1);
  assert.ok(qH1.matches({ size: [1, 1], h: 3 }));
  assert.ok(!qH1.matches({ size: [1, 1], h: 2 }));

  const qH2 = parseDimensionQuery('高1砖');
  assert.ok(qH2);
  assert.ok(qH2.matches({ size: [1, 1], h: 3 }));
  assert.ok(!qH2.matches({ size: [1, 1], h: 1 }));

  const qH3 = parseDimensionQuery('h=3');
  assert.ok(qH3);
  assert.ok(qH3.matches({ size: [1, 1], h: 3 }));

  // 4. 单轴宽度 / 长度
  const qW = parseDimensionQuery('宽2');
  assert.ok(qW);
  assert.ok(qW.matches({ size: [2, 4] }));
  assert.ok(qW.matches({ size: [6, 2] }));
  assert.ok(!qW.matches({ size: [1, 4] }));

  const qL = parseDimensionQuery('长4');
  assert.ok(qL);
  assert.ok(qL.matches({ size: [2, 4] }));
  assert.ok(qL.matches({ size: [4, 6] }));
  assert.ok(!qL.matches({ size: [1, 2] }));
});

test('matchesItemQuery 复合与多词查询匹配', () => {
  const p3001 = { partId: '3001', ...cat.parts['3001'] };
  const p3002 = { partId: '3002', ...cat.parts['3002'] };
  const p3020 = { partId: '3020', ...cat.parts['3020'] };

  // 2D 格式
  assert.ok(matchesItemQuery(p3001, '2x4'));
  assert.ok(matchesItemQuery(p3001, '4x2'));
  assert.ok(matchesItemQuery(p3001, '2 4'));
  assert.ok(matchesItemQuery(p3001, '2*4'));
  assert.ok(matchesItemQuery(p3001, '2×4'));

  // 单轴与多条件
  assert.ok(matchesItemQuery(p3001, '高1砖'));
  assert.ok(matchesItemQuery(p3001, '高3'));
  assert.ok(matchesItemQuery(p3001, '长4'));
  assert.ok(matchesItemQuery(p3001, '宽2'));

  // 复合 token 组合
  assert.ok(matchesItemQuery(p3001, '砖 高3 宽2'));
  assert.ok(matchesItemQuery(p3001, '高3 宽2'));
  assert.ok(matchesItemQuery(p3002, '高3 宽2'));
  assert.ok(!matchesItemQuery(p3020, '高3 宽2')); // 3020 是板，h: 1
});
