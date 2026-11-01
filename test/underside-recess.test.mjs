// 零件下表面凹陷/镂空三层表达（碰撞包围盒 + 底孔连接器 + 3D 参数化几何）专项回归测试
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  partBoxes, boxesCollide, partConnectors, PLATE, mergeCatalogParts,
} from '../src/core/core.js';
import {
  refCandidates, safeJoin, bboxFromText, heightMapColumns, decomposeHeightMap, decomposeHeightMapChecked,
  STUD_PRIMITIVES, ANTISTUD_PRIMITIVES, PROTRUSION_PRIMITIVES, trianglesFromText,
} from '../src/ldraw/ldraw.js';
import { partGeometry, cat } from '../src/viewer/geom.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const partsJson = JSON.parse(fs.readFileSync(new URL('../catalog/parts.json', import.meta.url), 'utf8'));
const partsLdrawJson = JSON.parse(fs.readFileSync(new URL('../catalog/parts-ldraw.json', import.meta.url), 'utf8'));
const catalog = { parts: mergeCatalogParts(partsLdrawJson.parts, partsJson.parts) };

const readLib = (rel) => {
  const cleanRel = rel.replace(/^parts[\\/]/, '');
  for (const base of [path.join(ROOT, 'catalog/ldraw-full'), path.join(ROOT, 'catalog/ldraw')]) {
    for (const c of refCandidates(cleanRel)) {
      const f = safeJoin(base, c);
      if (f && fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
    }
  }
  return null;
};

describe('Task A: 碰撞包围盒层（partBoxes + decomposeHeightMap 下表面凹陷）', () => {
  it('拱门 3659 / 6182 / 3307 的 partBoxes 跨中底部留出净空，下方放置薄板/砖不误报穿模', () => {
    for (const id of ['3659', '6182', '3307']) {
      const def = catalog.parts[id];
      assert.ok(def, `目录应包含拱门 ${id}`);
      const [sx] = def.size;
      const pArch = { id: 'arch', part: id, color: 1, at: [0, 0, 0], rot: 0, up: '+y' };
      const boxes = partBoxes(pArch, def);
      assert.ok(boxes.length >= 3, `${id} 应分解为至少 3 个子包围盒（左腿+右腿+拱顶横梁），实际 ${boxes.length}`);

      // 跨中 (x = sx / 2) 的所有包围盒底面 y0 必须 >= 1 片（留出拱洞下方净空；注意 partBoxes 返回的 y 单位为片）
      const midX = sx / 2;
      const midBoxes = boxes.filter((b) => b.x0 < midX - 0.1 && b.x1 > midX + 0.1);
      assert.ok(midBoxes.length >= 1, `${id} 跨中应有横梁包围盒`);
      for (const mb of midBoxes) {
        assert.ok(mb.y0 >= 1 - 1e-6, `${id} 跨中包围盒底面 y0 (${mb.y0}) 应 >= 1 片`);
      }

      // 在拱门正下方跨中 (x = sx/2 - 1, y = 0, z = 0) 放置 1x2 薄板 3023（rot:90 时占 2x1 格），不得发生穿模
      const defPlate = catalog.parts['3023'];
      const pUnder = { id: 'under', part: '3023', color: 4, at: [midX - 1, 0, 0], rot: 90, up: '+y' };
      const underBoxes = partBoxes(pUnder, defPlate);
      assert.equal(
        boxesCollide(boxes, underBoxes),
        null,
        `穿过拱门 ${id} 下方跨中的 1x2 薄板不应误报穿模`
      );
    }
  });

  it('倒斜坡 3665 / 3660 的 partBoxes 在前排悬挑区底部留出净空，下方放置薄板不误报穿模', () => {
    for (const id of ['3665', '3660']) {
      const def = catalog.parts[id];
      assert.ok(def, `目录应包含倒斜坡 ${id}`);
      const pSlope = { id: 'islope', part: id, color: 1, at: [0, 0, 0], rot: 0, up: '+y' };
      const boxes = partBoxes(pSlope, def);
      assert.ok(boxes.length >= 2, `${id} 应分解为后排立柱与前排悬挑至少 2 个子盒，实际 ${boxes.length}`);

      // 前排悬挑区 (k=1, 世界 z ∈ [1, 2]) 的最低 y0 必须 >= 1 片
      const frontBoxes = boxes.filter((b) => b.z0 >= 0.9);
      assert.ok(frontBoxes.length >= 1, `${id} 应包含前排悬挑子盒`);
      for (const fb of frontBoxes) {
        assert.ok(fb.y0 >= 1 - 1e-6, `${id} 前排悬挑子盒底面 y0 (${fb.y0}) 应 >= 1 片`);
      }

      // 在前排悬挑正下方 (x = 0, y = 0, z = 1) 放置 1x1 板 3024，不得误报穿模
      const def3024 = catalog.parts['3024'];
      const pUnder = { id: 'under', part: '3024', color: 4, at: [0, 0, 1], rot: 0, up: '+y' };
      assert.equal(
        boxesCollide(boxes, partBoxes(pUnder, def3024)),
        null,
        `倒斜坡 ${id} 前排悬挑下方放置 1x1 薄板不应误报穿模`
      );
    }
  });

  it('decomposeHeightMap 识别上表面平整但下表面凹陷的零件（6182 / 3307），且保持标准砖 3001 单盒', () => {
    const skipFn = (base) => PROTRUSION_PRIMITIVES.has(base)
      || STUD_PRIMITIVES.has(base) || ANTISTUD_PRIMITIVES.has(base) || base.startsWith('stug');

    // 1) 标准砖 3001：每格四周外壁/反凸点管落底，cellFloorLy === 0 → boxes 保持为空（单实心盒）
    {
      const text = readLib('parts/3001.dat');
      const shell = bboxFromText(text, readLib, { skipInstance: skipFn });
      const hm = heightMapColumns(text, readLib, {
        size: [4, 2], bodyBottomY: shell.max[1], min: shell.min, max: shell.max, sub: 2, skipPrim: skipFn,
      });
      for (const fl of hm.floor.values()) assert.equal(fl, 0, '标准砖 3001 每格 floor 应为 0');
      const dec = decomposeHeightMap(hm, [4, 2], 3);
      assert.equal(dec.boxes.length, 0, '标准砖 3001 不应被拆成多盒');
    }

    // 2) 拱门 6182 (1x4x2) 与 3307 (1x6x2)：顶面满高 (t === 6)，但跨中下表面凹陷 (floor >= 0.75) → 产出多盒且覆盖率 >= 0.7
    for (const [id, sx, sz, h] of [['6182', 4, 1, 6], ['3307', 6, 1, 6]]) {
      const text = readLib(`parts/${id}.dat`);
      const shell = bboxFromText(text, readLib, { skipInstance: skipFn });
      const hm = heightMapColumns(text, readLib, {
        size: [sx, sz], bodyBottomY: shell.max[1], min: shell.min, max: shell.max, sub: 2, skipPrim: skipFn,
      });
      const pts = [];
      const ox = (shell.min[0] + shell.max[0]) / 2, oz = (shell.min[2] + shell.max[2]) / 2;
      for (const t of trianglesFromText(text, readLib, { skipPrim: skipFn })) {
        for (const v of t) pts.push([(v[0] - ox) / 20, (shell.max[1] - v[1]) / 8, (oz - v[2]) / 20]);
      }
      const { result, coverage } = decomposeHeightMapChecked(hm, [sx, sz], h, pts);
      assert.ok(result.boxes.length >= 3, `${id} 应分解出至少 3 个子盒，实际 ${result.boxes.length}`);
      assert.ok(coverage >= 0.7, `${id} 分解盒顶点覆盖率 (${coverage}) 应 >= 0.7`);
      // 两端支腿从 y0=0 起算，中间跨拱 y0 > 0
      const legBoxes = result.boxes.filter((b) => b[2] === 0);
      const spanBoxes = result.boxes.filter((b) => b[2] >= 0.75);
      assert.equal(legBoxes.length, 2, `${id} 应有左右 2 个落底支腿盒`);
      assert.ok(spanBoxes.length >= 1, `${id} 应有底部悬空的跨中横梁盒`);
    }
  });
});

describe('Task B: 底孔连接器层（partConnectors + parts-ldraw 悬空区底孔剔除）', () => {
  it('拱门 3659 / 6182 / 3307 仅在两端支腿格生成底孔，跨中无 ly=0 悬空假底孔', () => {
    for (const [id, sx] of [['3659', 4], ['6182', 4], ['3307', 6]]) {
      const def = catalog.parts[id];
      const p = { id: 'p', part: id, color: 1, at: [0, 0, 0], rot: 0, up: '+y' };
      const { receptors } = partConnectors(p, def);
      const anti = receptors.filter((r) => r.kind === 'antistud');
      assert.equal(anti.length, 2, `${id} 应仅有左右两端支腿 2 个底孔，实际 ${anti.length}`);
      const cells = anti.map((r) => `${r.i},${r.k}`).sort();
      assert.deepEqual(cells, [`0,0`, `${sx - 1},0`], `${id} 底孔格坐标应仅为两端支腿`);

      // parts-ldraw.json 自动提取条目同样剔除了跨中悬空格
      const extDef = partsLdrawJson.parts[id];
      if (extDef) {
        assert.deepEqual(
          extDef.antistudCells,
          [[0, 0], [sx - 1, 0]],
          `parts-ldraw.json 中 ${id} 的 antistudCells 应仅含两端支腿`
        );
      }
    }
  });

  it('倒斜坡 3665 / 3660 仅在后排立柱 (k=0) 生成底孔，前排悬挑区 (k=1) 无假底孔且无中心悬空孔', () => {
    for (const [id, sx] of [['3665', 1], ['3660', 2]]) {
      const def = catalog.parts[id];
      const p = { id: 'p', part: id, color: 1, at: [0, 0, 0], rot: 0, up: '+y' };
      const { receptors } = partConnectors(p, def);
      const anti = receptors.filter((r) => r.kind === 'antistud');
      assert.equal(anti.length, sx, `${id} 应仅有后排 ${sx} 个底孔，实际 ${anti.length}`);
      for (const r of anti) {
        assert.equal(r.k, 0, `${id} 的底孔必须在 k=0 后排立柱上，发现 k=${r.k}`);
        assert.notEqual(r.i, -1, `${id} 不应生成 i=-1 的中心悬空底孔`);
      }
    }
  });

  it('中心悬空的多盒零件或 2xN 拱门不在 (0,0,0) 生成悬空中心底孔', () => {
    const mockArch2x4 = {
      name: 'Arch 2 x 4', kind: 'arch', size: [4, 2], h: 3, studs: 8, grid: true,
    };
    const p = { id: 'p', part: 'mockArch', color: 1, at: [0, 0, 0], rot: 0, up: '+y' };
    const { receptors } = partConnectors(p, mockArch2x4);
    const centerAnti = receptors.filter((r) => r.kind === 'antistud' && r.i === -1 && r.k === -1);
    assert.equal(centerAnti.length, 0, '2x4 拱门不应在 (0,0,0) 生成中心悬空底孔');
  });
});

describe('Task C: 3D 参数化几何层（partGeometry 下表面凹腔面片验证）', () => {
  /**
   * 统计参数化几何中位于内部凹腔顶面（y > 0.04 且 y < H - 0.01）且法线朝下（ny < -0.5）的三角形数量。
   * 实心封死方块的朝下面片全部贴在 y = 0 底面上，内部凹腔顶面朝下面片数为 0；
   * 具有真实底部镂空凹腔的零件必有 > 0 个内部凹腔朝下顶壁面片。
   */
  function countRecessedUndersideFaces(id) {
    const d = cat.parts[id];
    assert.ok(d, `目录应包含零件 ${id}`);
    const H = d.h * PLATE;
    const { main } = partGeometry(id);
    const pos = main.attributes.position;
    const norm = main.attributes.normal;
    let recessedDownVerts = 0;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const ny = norm.getY(i);
      if (ny < -0.5 && y > 0.04 && y < H - 0.01) {
        recessedDownVerts++;
      }
    }
    return recessedDownVerts;
  }

  it('corner 转角砖/板（2357 / 2420 / 14719）底面具有 L 型镂空凹腔与内部顶壁', () => {
    for (const id of ['2357', '2420', '14719']) {
      const n = countRecessedUndersideFaces(id);
      assert.ok(n >= 6, `转角件 ${id} 应具有内部凹腔朝下顶壁顶点（实际 ${n}）`);
    }
  });

  it('arch 拱门（3659 / 6182 / 3307）具有支腿底部镂空腔与跨中弧形拱顶下表面', () => {
    for (const id of ['3659', '6182', '3307']) {
      const n = countRecessedUndersideFaces(id);
      assert.ok(n >= 12, `拱门 ${id} 应具有支腿底腔与弧形拱顶朝下顶点（实际 ${n}）`);
    }
  });

  it('wedge 楔形翼板（41769 / 41770 / 24299 / 24307）底面具有外沿周壁与镂空底腔', () => {
    for (const id of ['41769', '41770', '24299', '24307']) {
      const n = countRecessedUndersideFaces(id);
      assert.ok(n >= 6, `楔形板 ${id} 应具有内部凹腔朝下顶壁顶点（实际 ${n}）`);
    }
  });

  it('dish 雷达碟（4740）、bracket 支架（99780 / 99781）、recessed snot 车灯砖（4070）底面具有镂空凹腔', () => {
    for (const id of ['4740', '99780', '99781', '4070']) {
      const n = countRecessedUndersideFaces(id);
      assert.ok(n >= 6, `零件 ${id} 应具有底部镂空凹腔朝下顶壁顶点（实际 ${n}）`);
    }
  });

  it('带 d.boxes 多盒分解的零件（50745 轮拱 / 28324 底盘）按子盒渲染下表面悬空与分阶结构', () => {
    for (const id of ['50745', '28324']) {
      const n = countRecessedUndersideFaces(id);
      assert.ok(n >= 12, `多盒零件 ${id} 应按 d.boxes 渲染出内部凹腔与悬空底面（实际 ${n}）`);
    }
  });
});
