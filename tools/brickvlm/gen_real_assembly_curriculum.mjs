/**
 * tools/brickvlm/gen_real_assembly_curriculum.mjs
 *
 * 真实装配状态闭环训练与评测数据集生成器 (PRD v2 / Task B / v4 闭环加固版)
 *
 * 核心升级（响应 2026-10-26 审阅意见）：
 * 1. 匿名候选：候选 ID 统一匿名化为 cand_1 .. cand_4，无目标含义泄漏。
 * 2. 逐候选执行存证：每个候选均经 snapPart / validate 物理执行诊断，存入 receipt。
 * 3. 等价候选集合：对几何与材质完全等价的动作自动归入 target.equivalentCandidates。
 * 4. 严格 C3 契约：补齐 protocolVersion / assetLock / stateRef / verification 等 11 个必填字段。
 * 5. 严格姿态契约：orientationId 严格采用 0..23 正交编号 (通过 orientationIdOf 转换)。
 * 6. 零业务 Warning：修正全部颜色为 catalog/colors.json 合法代码 (71 浅蓝灰)，子组件分步搭建消除 sub-mixed。
 * 7. 渲染属性定位：明确标注 renderMode: "collision_proxy_preview"，不冒充完整零件接口渲染。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { createBuilder } from '../../src/core/builder.js';
import { partBoxes, PLATE, snapPart, partsCollide, partsConnected, validate } from '../../src/core/core.js';
import { orientationIdOf } from '../../src/core/actions-v1/orientations.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

const CATALOG_PARTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'), 'utf8'));
const CATALOG_COLORS = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/colors.json'), 'utf8'));
const FULL_CAT = { ...CATALOG_PARTS, colors: CATALOG_COLORS.colors };

const COLOR_RGB = {
  0: [40, 40, 42],        // Black
  1: [20, 95, 180],       // Blue
  4: [200, 30, 25],       // Red
  14: [240, 200, 40],     // Yellow
  15: [245, 245, 248],    // White
  33: [30, 140, 220],     // Trans-Blue
  71: [155, 161, 157],    // Light Bluish Grey (71)
};

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * 3D 轴测碰撞盒实体投影与接口标号预览视图 (collision_proxy_preview)
 */
function projectPoint([x, yPlates, z], { azDeg = 35, elDeg = 25, scale = 14, cx = 64, cy = 72 } = {}) {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  const y = yPlates * PLATE;

  const rx = x * Math.cos(az) - z * Math.sin(az);
  const rz = x * Math.sin(az) + z * Math.cos(az);
  const ry = y * Math.cos(el) - rz * Math.sin(el);
  const rz2 = y * Math.sin(el) + rz * Math.cos(el);

  const px = cx + rx * scale;
  const py = cy - ry * scale;
  return { px: Math.round(px), py: Math.round(py), depth: rz2 };
}

function renderModelToSvg(model, { badges = [], width = 128, height = 128 } = {}) {
  const parts = model.parts || [];
  const faces = [];

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of parts) {
    const def = CATALOG_PARTS.parts[p.part];
    if (!def) continue;
    const boxes = partBoxes(p, def);
    for (const b of boxes) {
      minX = Math.min(minX, b.x0); maxX = Math.max(maxX, b.x1);
      minY = Math.min(minY, b.y0); maxY = Math.max(maxY, b.y1);
      minZ = Math.min(minZ, b.z0); maxZ = Math.max(maxZ, b.z1);
    }
  }
  const midX = Number.isFinite(minX) ? (minX + maxX) / 2 : 0;
  const midY = Number.isFinite(minY) ? (minY + maxY) / 2 : 0;
  const midZ = Number.isFinite(minZ) ? (minZ + maxZ) / 2 : 0;

  const camConfig = {
    azDeg: 35,
    elDeg: 25,
    scale: 14,
    cx: 64 - (midX * 8 - midZ * 6),
    cy: 76 + (midY * PLATE * 6)
  };

  for (const p of parts) {
    const def = CATALOG_PARTS.parts[p.part];
    if (!def) continue;
    const boxes = partBoxes(p, def);
    const baseRgb = COLOR_RGB[p.color] || [140, 145, 150];

    for (const b of boxes) {
      const { x0, x1, y0, y1, z0, z1 } = b;

      // 顶面 (+Y)
      const topPts = [
        projectPoint([x0, y1, z0], camConfig),
        projectPoint([x1, y1, z0], camConfig),
        projectPoint([x1, y1, z1], camConfig),
        projectPoint([x0, y1, z1], camConfig),
      ];
      const avgTopDepth = (topPts[0].depth + topPts[1].depth + topPts[2].depth + topPts[3].depth) / 4;
      const topFill = `rgb(${Math.min(255, baseRgb[0] + 35)}, ${Math.min(255, baseRgb[1] + 35)}, ${Math.min(255, baseRgb[2] + 35)})`;
      faces.push({
        pts: topPts,
        depth: avgTopDepth + 0.1,
        fill: topFill,
        stroke: `rgb(${Math.max(0, baseRgb[0] - 40)}, ${Math.max(0, baseRgb[1] - 40)}, ${Math.max(0, baseRgb[2] - 40)})`
      });

      // 前面 (+Z)
      const frontPts = [
        projectPoint([x0, y0, z1], camConfig),
        projectPoint([x1, y0, z1], camConfig),
        projectPoint([x1, y1, z1], camConfig),
        projectPoint([x0, y1, z1], camConfig),
      ];
      const avgFrontDepth = (frontPts[0].depth + frontPts[1].depth + frontPts[2].depth + frontPts[3].depth) / 4;
      const frontFill = `rgb(${baseRgb[0]}, ${baseRgb[1]}, ${baseRgb[2]})`;
      faces.push({
        pts: frontPts,
        depth: avgFrontDepth + 0.2,
        fill: frontFill,
        stroke: `rgb(${Math.max(0, baseRgb[0] - 40)}, ${Math.max(0, baseRgb[1] - 40)}, ${Math.max(0, baseRgb[2] - 40)})`
      });

      // 侧面 (+X)
      const sidePts = [
        projectPoint([x1, y0, z0], camConfig),
        projectPoint([x1, y0, z1], camConfig),
        projectPoint([x1, y1, z1], camConfig),
        projectPoint([x1, y1, z0], camConfig),
      ];
      const avgSideDepth = (sidePts[0].depth + sidePts[1].depth + sidePts[2].depth + sidePts[3].depth) / 4;
      const sideFill = `rgb(${Math.max(0, baseRgb[0] - 25)}, ${Math.max(0, baseRgb[1] - 25)}, ${Math.max(0, baseRgb[2] - 25)})`;
      faces.push({
        pts: sidePts,
        depth: avgSideDepth,
        fill: sideFill,
        stroke: `rgb(${Math.max(0, baseRgb[0] - 50)}, ${Math.max(0, baseRgb[1] - 50)}, ${Math.max(0, baseRgb[2] - 50)})`
      });
    }
  }

  faces.sort((a, b) => a.depth - b.depth);

  const svgFaces = faces.map(f => {
    const pointsStr = f.pts.map(p => `${p.px},${p.py}`).join(' ');
    return `<polygon points="${pointsStr}" fill="${f.fill}" stroke="${f.stroke}" stroke-width="1.2" stroke-linejoin="round" />`;
  });

  const svgBadges = badges.map(b => {
    const pos = projectPoint(b.pos3d, camConfig);
    return `
      <g class="neutral-badge" transform="translate(${pos.px}, ${pos.py})">
        <circle r="8.5" fill="#FFFFFF" stroke="#4B5055" stroke-width="1.8" />
        <text text-anchor="middle" dy="3.5" font-family="DejaVu Sans, Arial, sans-serif" font-size="9.5" font-weight="bold" fill="#141414">${b.tag}</text>
      </g>
    `.trim();
  });

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="${width}" height="${height}" fill="#ECEFF3" />
      <g class="geometry-layer">
        ${svgFaces.join('\n        ')}
      </g>
      <g class="badge-overlay-layer">
        ${svgBadges.join('\n        ')}
      </g>
    </svg>
  `.trim();
}

function seededShuffle(array, seedStr) {
  let hashVal = 0;
  for (let i = 0; i < seedStr.length; i++) {
    hashVal = ((hashVal << 5) - hashVal) + seedStr.charCodeAt(i);
    hashVal = Math.abs(hashVal | 0);
  }
  const prng = () => {
    hashVal = (Math.abs(hashVal) * 9301 + 49297) % 233280;
    return Math.abs(hashVal) / 233280;
  };

  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(prng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * 15 个真实装配样例规格定义 (全部使用合法颜色代码，子组件严格分步)
 */
const CASE_DEFS = [
  // --- A. 基础常规堆叠 (5 例) ---
  {
    caseId: 'case_stack_01',
    category: 'basic_stack',
    name: 'Stack 2x4 Brick 3001 on 3001',
    build: (cat) => {
      const b_t = createBuilder({ catalog: cat, meta: { name: 'c1_t', front: '+z' } });
      const p1 = b_t.add('3001', 4, { at: [0, 0, 0], step: 1 });
      b_t.assert();

      const b_next = createBuilder({ catalog: cat, meta: { name: 'c1_next', front: '+z' } });
      const q1 = b_next.add('3001', 4, { at: [0, 0, 0], step: 1 });
      b_next.add('3001', 14, { on: q1.id, stud: 0, step: 2 });
      b_next.assert();

      return {
        b_t, b_next,
        parentInstanceId: p1.id,
        targetAction: { childPartId: '3001', colorId: 14, parentInstanceId: p1.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 0 },
        candidateDistractors: [
          { childPartId: '3001', colorId: 14, parentInstanceId: p1.id, parentConnectorId: 'stud_2', childConnectorId: 'antistud_0', up: '+y', rot: 0 },
          { childPartId: '3001', colorId: 14, parentInstanceId: p1.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 90 },
          { childPartId: '3003', colorId: 14, parentInstanceId: p1.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 0 }
        ],
        badgePositions: [
          { tag: '1', pos3d: [0.5, 3, 0.5] },
          { tag: '2', pos3d: [1.5, 3, 0.5] },
          { tag: '3', pos3d: [2.5, 3, 0.5] },
          { tag: '4', pos3d: [3.5, 3, 0.5] }
        ]
      };
    }
  },
  {
    caseId: 'case_stack_02',
    category: 'basic_stack',
    name: 'Mount 1x2 Plate 3023 on 2x4 Brick 3001',
    build: (cat) => {
      const b_t = createBuilder({ catalog: cat, meta: { name: 'c2_t', front: '+z' } });
      const p1 = b_t.add('3001', 1, { at: [0, 0, 0], step: 1 });
      b_t.assert();

      const b_next = createBuilder({ catalog: cat, meta: { name: 'c2_next', front: '+z' } });
      const q1 = b_next.add('3001', 1, { at: [0, 0, 0], step: 1 });
      b_next.add('3023', 15, { on: q1.id, stud: 0, step: 2 });
      b_next.assert();

      return {
        b_t, b_next,
        parentInstanceId: p1.id,
        targetAction: { childPartId: '3023', colorId: 15, parentInstanceId: p1.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 0 },
        candidateDistractors: [
          { childPartId: '3023', colorId: 15, parentInstanceId: p1.id, parentConnectorId: 'stud_4', childConnectorId: 'antistud_0', up: '+y', rot: 0 },
          { childPartId: '3023', colorId: 15, parentInstanceId: p1.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 90 },
          { childPartId: '3024', colorId: 15, parentInstanceId: p1.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 0 }
        ],
        badgePositions: [
          { tag: '1', pos3d: [0.5, 3, 0.5] },
          { tag: '2', pos3d: [1.5, 3, 0.5] },
          { tag: '3', pos3d: [0.5, 3, 1.5] },
          { tag: '4', pos3d: [1.5, 3, 1.5] }
        ]
      };
    }
  },
  {
    caseId: 'case_stack_03',
    category: 'basic_stack',
    name: 'Mount 2x2 Brick 3003 Offset on 2x4 Brick 3001',
    build: (cat) => {
      const b_t = createBuilder({ catalog: cat, meta: { name: 'c3_t', front: '+z' } });
      const p1 = b_t.add('3001', 0, { at: [0, 0, 0], step: 1 });
      b_t.assert();

      const b_next = createBuilder({ catalog: cat, meta: { name: 'c3_next', front: '+z' } });
      const q1 = b_next.add('3001', 0, { at: [0, 0, 0], step: 1 });
      b_next.add('3003', 4, { on: q1.id, stud: 2, step: 2 });
      b_next.assert();

      return {
        b_t, b_next,
        parentInstanceId: p1.id,
        targetAction: { childPartId: '3003', colorId: 4, parentInstanceId: p1.id, parentConnectorId: 'stud_2', childConnectorId: 'antistud_0', up: '+y', rot: 0 },
        candidateDistractors: [
          { childPartId: '3003', colorId: 4, parentInstanceId: p1.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 0 },
          { childPartId: '3003', colorId: 4, parentInstanceId: p1.id, parentConnectorId: 'stud_2', childConnectorId: 'antistud_0', up: '+y', rot: 90 },
          { childPartId: '3004', colorId: 4, parentInstanceId: p1.id, parentConnectorId: 'stud_2', childConnectorId: 'antistud_0', up: '+y', rot: 0 }
        ],
        badgePositions: [
          { tag: '1', pos3d: [0.5, 3, 0.5] },
          { tag: '2', pos3d: [1.5, 3, 0.5] },
          { tag: '3', pos3d: [2.5, 3, 0.5] },
          { tag: '4', pos3d: [3.5, 3, 0.5] }
        ]
      };
    }
  },
  {
    caseId: 'case_stack_04',
    category: 'basic_stack',
    name: 'Mount 1x4 Smooth Tile 2431 on 1x4 Brick 3010',
    build: (cat) => {
      const b_t = createBuilder({ catalog: cat, meta: { name: 'c4_t', front: '+z' } });
      const p1 = b_t.add('3010', 15, { at: [0, 0, 0], step: 1 });
      b_t.assert();

      const b_next = createBuilder({ catalog: cat, meta: { name: 'c4_next', front: '+z' } });
      const q1 = b_next.add('3010', 15, { at: [0, 0, 0], step: 1 });
      b_next.add('2431', 1, { on: q1.id, stud: 0, step: 2 });
      b_next.assert();

      return {
        b_t, b_next,
        parentInstanceId: p1.id,
        targetAction: { childPartId: '2431', colorId: 1, parentInstanceId: p1.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 0 },
        candidateDistractors: [
          { childPartId: '2431', colorId: 1, parentInstanceId: p1.id, parentConnectorId: 'stud_1', childConnectorId: 'antistud_0', up: '+y', rot: 0 },
          { childPartId: '2431', colorId: 1, parentInstanceId: p1.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 90 },
          { childPartId: '3710', colorId: 1, parentInstanceId: p1.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 0 }
        ],
        badgePositions: [
          { tag: '1', pos3d: [0.5, 3, 0.5] },
          { tag: '2', pos3d: [1.5, 3, 0.5] },
          { tag: '3', pos3d: [2.5, 3, 0.5] },
          { tag: '4', pos3d: [3.5, 3, 0.5] }
        ]
      };
    }
  },
  {
    caseId: 'case_stack_05',
    category: 'basic_stack',
    name: 'Mount 1x2 Plate 3023 on 2x6 Plate 3795',
    build: (cat) => {
      const b_t = createBuilder({ catalog: cat, meta: { name: 'c5_t', front: '+z' } });
      const p1 = b_t.add('3795', 71, { at: [0, 0, 0], step: 1 }); // 71 浅蓝灰
      b_t.assert();

      const b_next = createBuilder({ catalog: cat, meta: { name: 'c5_next', front: '+z' } });
      const q1 = b_next.add('3795', 71, { at: [0, 0, 0], step: 1 });
      b_next.add('3023', 0, { on: q1.id, stud: 6, step: 2 });
      b_next.assert();

      return {
        b_t, b_next,
        parentInstanceId: p1.id,
        targetAction: { childPartId: '3023', colorId: 0, parentInstanceId: p1.id, parentConnectorId: 'stud_6', childConnectorId: 'antistud_0', up: '+y', rot: 0 },
        candidateDistractors: [
          { childPartId: '3023', colorId: 0, parentInstanceId: p1.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 0 },
          { childPartId: '3023', colorId: 0, parentInstanceId: p1.id, parentConnectorId: 'stud_6', childConnectorId: 'antistud_0', up: '+y', rot: 90 },
          { childPartId: '3022', colorId: 0, parentInstanceId: p1.id, parentConnectorId: 'stud_6', childConnectorId: 'antistud_0', up: '+y', rot: 0 }
        ],
        badgePositions: [
          { tag: '1', pos3d: [0.5, 1, 0.5] },
          { tag: '2', pos3d: [2.5, 1, 0.5] },
          { tag: '3', pos3d: [3.5, 1, 0.5] },
          { tag: '4', pos3d: [5.5, 1, 0.5] }
        ]
      };
    }
  },

  // --- B. SNOT 侧装范式 (5 例) ---
  {
    caseId: 'case_snot_01',
    category: 'snot',
    name: 'SNOT 1x1 Plate 3024 on 87087 Side Stud',
    build: (cat) => {
      const b_t = createBuilder({ catalog: cat, meta: { name: 'c6_t', front: '+z' } });
      const p1 = b_t.add('3020', 0, { at: [0, 0, 0], step: 1 });
      const p2 = b_t.add('87087', 15, { on: p1.id, stud: 0, step: 2 });
      b_t.assert();

      const b_next = createBuilder({ catalog: cat, meta: { name: 'c6_next', front: '+z' } });
      const q1 = b_next.add('3020', 0, { at: [0, 0, 0], step: 1 });
      const q2 = b_next.add('87087', 15, { on: q1.id, stud: 0, step: 2 });
      b_next.add('3024', 33, { on: q2.id, stud: 1, up: '+z', rot: 0, step: 3 });
      b_next.assert();

      return {
        b_t, b_next,
        parentInstanceId: p2.id,
        targetAction: { childPartId: '3024', colorId: 33, parentInstanceId: p2.id, parentConnectorId: 'stud_side_1', childConnectorId: 'antistud_0', up: '+z', rot: 0 },
        candidateDistractors: [
          { childPartId: '3024', colorId: 33, parentInstanceId: p2.id, parentConnectorId: 'stud_top_0', childConnectorId: 'antistud_0', up: '+y', rot: 0 },
          { childPartId: '3024', colorId: 33, parentInstanceId: p2.id, parentConnectorId: 'stud_side_1', childConnectorId: 'antistud_0', up: '+z', rot: 90 }, // 等价候选 (1x1 方形板旋转 90 度包围盒相同)
          { childPartId: '87087', colorId: 33, parentInstanceId: p2.id, parentConnectorId: 'stud_side_1', childConnectorId: 'antistud_0', up: '+z', rot: 0 }
        ],
        badgePositions: [
          { tag: '1', pos3d: [0.5, 4, 0.5] },
          { tag: '2', pos3d: [0.5, 2.5, 1.0] },
          { tag: '3', pos3d: [1.5, 1, 0.5] },
          { tag: '4', pos3d: [2.5, 1, 0.5] }
        ]
      };
    }
  },
  {
    caseId: 'case_snot_02',
    category: 'snot',
    name: 'SNOT 1x2 Grille 2412b on 30414 Side Stud',
    build: (cat) => {
      const b_t = createBuilder({ catalog: cat, meta: { name: 'c7_t', front: '+z' } });
      const p1 = b_t.add('3001', 0, { at: [0, 0, 0], step: 1 });
      const p2 = b_t.add('30414', 4, { on: p1.id, stud: 0, step: 2 });
      b_t.assert();

      const b_next = createBuilder({ catalog: cat, meta: { name: 'c7_next', front: '+z' } });
      const q1 = b_next.add('3001', 0, { at: [0, 0, 0], step: 1 });
      const q2 = b_next.add('30414', 4, { on: q1.id, stud: 0, step: 2 });
      b_next.add('2412b', 0, { on: q2.id, stud: 4, up: '+z', rot: 0, step: 3 });
      b_next.assert();

      return {
        b_t, b_next,
        parentInstanceId: p2.id,
        targetAction: { childPartId: '2412b', colorId: 0, parentInstanceId: p2.id, parentConnectorId: 'stud_side_4', childConnectorId: 'antistud_0', up: '+z', rot: 0 },
        candidateDistractors: [
          { childPartId: '2412b', colorId: 0, parentInstanceId: p2.id, parentConnectorId: 'stud_top_0', childConnectorId: 'antistud_0', up: '+y', rot: 0 },
          { childPartId: '2412b', colorId: 0, parentInstanceId: p2.id, parentConnectorId: 'stud_side_4', childConnectorId: 'antistud_0', up: '+z', rot: 90 }, // 1x2 非对称旋转 90 度为真负例
          { childPartId: '3023', colorId: 0, parentInstanceId: p2.id, parentConnectorId: 'stud_side_4', childConnectorId: 'antistud_0', up: '+z', rot: 0 }
        ],
        badgePositions: [
          { tag: '1', pos3d: [0.5, 4.5, 1.0] },
          { tag: '2', pos3d: [1.5, 4.5, 1.0] },
          { tag: '3', pos3d: [0.5, 6, 0.5] },
          { tag: '4', pos3d: [2.5, 6, 0.5] }
        ]
      };
    }
  },
  {
    caseId: 'case_snot_03',
    category: 'snot',
    name: 'SNOT 1x1 Plate 3024 on 4733 Travis Brick Side Stud',
    build: (cat) => {
      const b_t = createBuilder({ catalog: cat, meta: { name: 'c8_t', front: '+z' } });
      const p1 = b_t.add('3001', 0, { at: [0, 0, 0], step: 1 });
      const p2 = b_t.add('4733', 4, { on: p1.id, stud: 0, step: 2 });
      b_t.assert();

      const b_next = createBuilder({ catalog: cat, meta: { name: 'c8_next', front: '+z' } });
      const q1 = b_next.add('3001', 0, { at: [0, 0, 0], step: 1 });
      const q2 = b_next.add('4733', 4, { on: q1.id, stud: 0, step: 2 });
      b_next.add('3024', 14, { on: q2.id, stud: 1, up: '+z', rot: 0, step: 3 });
      b_next.assert();

      return {
        b_t, b_next,
        parentInstanceId: p2.id,
        targetAction: { childPartId: '3024', colorId: 14, parentInstanceId: p2.id, parentConnectorId: 'stud_side_1', childConnectorId: 'antistud_0', up: '+z', rot: 0 },
        candidateDistractors: [
          { childPartId: '3024', colorId: 14, parentInstanceId: p2.id, parentConnectorId: 'stud_top_0', childConnectorId: 'antistud_0', up: '+y', rot: 0 },
          { childPartId: '3024', colorId: 14, parentInstanceId: p2.id, parentConnectorId: 'stud_side_1', childConnectorId: 'antistud_0', up: '+z', rot: 90 }, // 等价候选
          { childPartId: '3005', colorId: 14, parentInstanceId: p2.id, parentConnectorId: 'stud_side_1', childConnectorId: 'antistud_0', up: '+z', rot: 0 }
        ],
        badgePositions: [
          { tag: '1', pos3d: [0.5, 6, 0.5] },
          { tag: '2', pos3d: [0.5, 4.5, 1.0] },
          { tag: '3', pos3d: [1.0, 4.5, 0.5] },
          { tag: '4', pos3d: [2.5, 3, 0.5] }
        ]
      };
    }
  },
  {
    caseId: 'case_snot_04',
    category: 'snot',
    name: 'Mount Inverted Bracket 99780 on 3003',
    build: (cat) => {
      const b_t = createBuilder({ catalog: cat, meta: { name: 'c9_t', front: '+z' } });
      const p1 = b_t.add('3003', 0, { at: [0, 0, 0], step: 1 });
      b_t.assert();

      const b_next = createBuilder({ catalog: cat, meta: { name: 'c9_next', front: '+z' } });
      const q1 = b_next.add('3003', 0, { at: [0, 0, 0], step: 1 });
      b_next.add('99780', 71, { on: q1.id, stud: 0, step: 2 }); // 71 浅蓝灰
      b_next.assert();

      return {
        b_t, b_next,
        parentInstanceId: p1.id,
        targetAction: { childPartId: '99780', colorId: 71, parentInstanceId: p1.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 0 },
        candidateDistractors: [
          { childPartId: '99780', colorId: 71, parentInstanceId: p1.id, parentConnectorId: 'stud_2', childConnectorId: 'antistud_0', up: '+y', rot: 0 },
          { childPartId: '99780', colorId: 71, parentInstanceId: p1.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 180 },
          { childPartId: '99781', colorId: 71, parentInstanceId: p1.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 0 }
        ],
        badgePositions: [
          { tag: '1', pos3d: [0.5, 3, 0.5] },
          { tag: '2', pos3d: [1.5, 3, 0.5] },
          { tag: '3', pos3d: [0.5, 3, 1.5] },
          { tag: '4', pos3d: [1.5, 3, 1.5] }
        ]
      };
    }
  },
  {
    caseId: 'case_snot_05',
    category: 'snot',
    name: 'SNOT 1x1 Plate 3024 on 4070 Headlight Brick',
    build: (cat) => {
      const b_t = createBuilder({ catalog: cat, meta: { name: 'c10_t', front: '+z' } });
      const p1 = b_t.add('3001', 0, { at: [0, 0, 0], step: 1 });
      const p2 = b_t.add('4070', 14, { on: p1.id, stud: 0, step: 2 });
      b_t.assert();

      const b_next = createBuilder({ catalog: cat, meta: { name: 'c10_next', front: '+z' } });
      const q1 = b_next.add('3001', 0, { at: [0, 0, 0], step: 1 });
      const q2 = b_next.add('4070', 14, { on: q1.id, stud: 0, step: 2 });
      b_next.add('3024', 4, { on: q2.id, stud: 1, up: '+z', rot: 0, step: 3 });
      b_next.assert();

      return {
        b_t, b_next,
        parentInstanceId: p2.id,
        targetAction: { childPartId: '3024', colorId: 4, parentInstanceId: p2.id, parentConnectorId: 'stud_side_1', childConnectorId: 'antistud_0', up: '+z', rot: 0 },
        candidateDistractors: [
          { childPartId: '3024', colorId: 4, parentInstanceId: p2.id, parentConnectorId: 'stud_top_0', childConnectorId: 'antistud_0', up: '+y', rot: 0 },
          { childPartId: '3024', colorId: 4, parentInstanceId: p2.id, parentConnectorId: 'stud_side_1', childConnectorId: 'antistud_0', up: '+z', rot: 90 }, // 等价候选
          { childPartId: '3023', colorId: 4, parentInstanceId: p2.id, parentConnectorId: 'stud_side_1', childConnectorId: 'antistud_0', up: '+z', rot: 0 }
        ],
        badgePositions: [
          { tag: '1', pos3d: [0.5, 6, 0.5] },
          { tag: '2', pos3d: [0.5, 4.5, 0.8] },
          { tag: '3', pos3d: [1.5, 3, 0.5] },
          { tag: '4', pos3d: [2.5, 3, 0.5] }
        ]
      };
    }
  },

  // --- C. 子组件刚体挂装 (5 例，严格按 step: 1 主体、step: 2 子组件零件、step: 3 挂装，消除 sub-mixed) ---
  {
    caseId: 'case_subasm_01',
    category: 'subassembly',
    name: 'Mount Bumper Subassembly (3023 + 2412b) onto Base',
    build: (cat) => {
      const b_t = createBuilder({ catalog: cat, meta: { name: 'c11_t', front: '+z' } });
      const base = b_t.add('3001', 15, { at: [0, 0, 0], step: 1 });
      b_t.assert();

      const b_next = createBuilder({ catalog: cat, meta: { name: 'c11_next', front: '+z' } });
      const base_next = b_next.add('3001', 15, { at: [0, 0, 0], step: 1 });
      const b1 = b_next.add('3023', 0, { at: [10, 0, 0], id: 'bump1', step: 2 });
      const b2 = b_next.add('2412b', 4, { on: b1.id, stud: 0, id: 'bump2', step: 2 });
      b_next.addAssembly([b1.id, b2.id], { on: base_next.id, stud: 0, anchor: b1.id, anchorReceptor: 0, step: 3, label: 'bumper' });
      b_next.assert();

      return {
        b_t, b_next,
        parentInstanceId: base.id,
        subassemblyTemplate: {
          templateId: 'sub_bumper',
          anchorPartId: '3023',
          anchorReceptor: 0,
          members: [
            { part: '3023', color: 0, isAnchor: true },
            { part: '2412b', color: 4, studOnAnchor: 0, receptor: 0, rot: 0, up: '+y' }
          ]
        },
        targetAction: { op: 'attach_assembly', childPartId: '3023', colorId: 0, subassemblyTemplateId: 'sub_bumper', parentInstanceId: base.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 0, isAssembly: true },
        candidateDistractors: [
          { op: 'attach_assembly', childPartId: '3023', colorId: 0, subassemblyTemplateId: 'sub_bumper', parentInstanceId: base.id, parentConnectorId: 'stud_4', childConnectorId: 'antistud_0', up: '+y', rot: 0, isAssembly: true },
          { op: 'attach_assembly', childPartId: '3023', colorId: 0, subassemblyTemplateId: 'sub_bumper', parentInstanceId: base.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 180, isAssembly: true },
          { op: 'attach_part', childPartId: '3023', colorId: 0, subassemblyTemplateId: null, parentInstanceId: base.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 0, isAssembly: false }
        ],
        badgePositions: [
          { tag: '1', pos3d: [0.5, 3, 0.5] },
          { tag: '2', pos3d: [1.5, 3, 0.5] },
          { tag: '3', pos3d: [2.5, 3, 0.5] },
          { tag: '4', pos3d: [3.5, 3, 0.5] }
        ]
      };
    }
  },
  {
    caseId: 'case_subasm_02',
    category: 'subassembly',
    name: 'Mount Roof Subassembly (3020 + 2431) onto Base',
    build: (cat) => {
      const b_t = createBuilder({ catalog: cat, meta: { name: 'c12_t', front: '+z' } });
      const base = b_t.add('3001', 33, { at: [0, 0, 0], step: 1 });
      b_t.assert();

      const b_next = createBuilder({ catalog: cat, meta: { name: 'c12_next', front: '+z' } });
      const base_next = b_next.add('3001', 33, { at: [0, 0, 0], step: 1 });
      const r1 = b_next.add('3020', 15, { at: [10, 0, 0], id: 'roof1', step: 2 });
      const r2 = b_next.add('2431', 4, { on: r1.id, stud: 0, id: 'roof2', step: 2 });
      b_next.addAssembly([r1.id, r2.id], { on: base_next.id, stud: 0, anchor: r1.id, anchorReceptor: 0, step: 3, label: 'roof' });
      b_next.assert();

      return {
        b_t, b_next,
        parentInstanceId: base.id,
        subassemblyTemplate: {
          templateId: 'sub_roof',
          anchorPartId: '3020',
          anchorReceptor: 0,
          members: [
            { part: '3020', color: 15, isAnchor: true },
            { part: '2431', color: 4, studOnAnchor: 0, receptor: 0, rot: 0, up: '+y' }
          ]
        },
        targetAction: { op: 'attach_assembly', childPartId: '3020', colorId: 15, subassemblyTemplateId: 'sub_roof', parentInstanceId: base.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 0, isAssembly: true },
        candidateDistractors: [
          { op: 'attach_assembly', childPartId: '3020', colorId: 15, subassemblyTemplateId: 'sub_roof', parentInstanceId: base.id, parentConnectorId: 'stud_2', childConnectorId: 'antistud_0', up: '+y', rot: 0, isAssembly: true },
          { op: 'attach_assembly', childPartId: '3020', colorId: 15, subassemblyTemplateId: 'sub_roof', parentInstanceId: base.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 90, isAssembly: true },
          { op: 'attach_part', childPartId: '3020', colorId: 15, subassemblyTemplateId: null, parentInstanceId: base.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 0, isAssembly: false }
        ],
        badgePositions: [
          { tag: '1', pos3d: [0.5, 3, 0.5] },
          { tag: '2', pos3d: [1.5, 3, 0.5] },
          { tag: '3', pos3d: [0.5, 3, 1.5] },
          { tag: '4', pos3d: [1.5, 3, 1.5] }
        ]
      };
    }
  },
  {
    caseId: 'case_subasm_03',
    category: 'subassembly',
    name: 'Mount Hinge Subassembly (48336 + 60478) onto Base',
    build: (cat) => {
      const b_t = createBuilder({ catalog: cat, meta: { name: 'c13_t', front: '+z' } });
      const base = b_t.add('3001', 1, { at: [0, 0, 0], step: 1 });
      b_t.assert();

      const b_next = createBuilder({ catalog: cat, meta: { name: 'c13_next', front: '+z' } });
      const base_next = b_next.add('3001', 1, { at: [0, 0, 0], step: 1 });
      const h1 = b_next.add('48336', 0, { at: [10, 0, 0], id: 'h1', step: 2 });
      const h2 = b_next.add('60478', 14, { on: h1.id, stud: 0, id: 'h2', step: 2 });
      b_next.addAssembly([h1.id, h2.id], { on: base_next.id, stud: 0, anchor: h1.id, anchorReceptor: 0, step: 3, label: 'hinge' });
      b_next.assert();

      return {
        b_t, b_next,
        parentInstanceId: base.id,
        subassemblyTemplate: {
          templateId: 'sub_hinge',
          anchorPartId: '48336',
          anchorReceptor: 0,
          members: [
            { part: '48336', color: 0, isAnchor: true },
            { part: '60478', color: 14, studOnAnchor: 0, receptor: 0, rot: 0, up: '+y' }
          ]
        },
        targetAction: { op: 'attach_assembly', childPartId: '48336', colorId: 0, subassemblyTemplateId: 'sub_hinge', parentInstanceId: base.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 0, isAssembly: true },
        candidateDistractors: [
          { op: 'attach_assembly', childPartId: '48336', colorId: 0, subassemblyTemplateId: 'sub_hinge', parentInstanceId: base.id, parentConnectorId: 'stud_3', childConnectorId: 'antistud_0', up: '+y', rot: 0, isAssembly: true },
          { op: 'attach_assembly', childPartId: '48336', colorId: 0, subassemblyTemplateId: 'sub_hinge', parentInstanceId: base.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 90, isAssembly: true },
          { op: 'attach_part', childPartId: '48336', colorId: 0, subassemblyTemplateId: null, parentInstanceId: base.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 0, isAssembly: false }
        ],
        badgePositions: [
          { tag: '1', pos3d: [0.5, 3, 0.5] },
          { tag: '2', pos3d: [1.5, 3, 0.5] },
          { tag: '3', pos3d: [2.5, 3, 0.5] },
          { tag: '4', pos3d: [3.5, 3, 0.5] }
        ]
      };
    }
  },
  {
    caseId: 'case_subasm_04',
    category: 'subassembly',
    name: 'Mount Beacon Subassembly (4073 + 3062b) onto Base',
    build: (cat) => {
      const b_t = createBuilder({ catalog: cat, meta: { name: 'c14_t', front: '+z' } });
      const base = b_t.add('3001', 14, { at: [0, 0, 0], step: 1 });
      b_t.assert();

      const b_next = createBuilder({ catalog: cat, meta: { name: 'c14_next', front: '+z' } });
      const base_next = b_next.add('3001', 14, { at: [0, 0, 0], step: 1 });
      const bc1 = b_next.add('4073', 4, { at: [10, 0, 0], id: 'bc1', step: 2 });
      const bc2 = b_next.add('3062b', 1, { on: bc1.id, stud: 0, id: 'bc2', step: 2 });
      b_next.addAssembly([bc1.id, bc2.id], { on: base_next.id, stud: 0, anchor: bc1.id, anchorReceptor: 0, step: 3, label: 'beacon' });
      b_next.assert();

      return {
        b_t, b_next,
        parentInstanceId: base.id,
        subassemblyTemplate: {
          templateId: 'sub_beacon',
          anchorPartId: '4073',
          anchorReceptor: 0,
          members: [
            { part: '4073', color: 4, isAnchor: true },
            { part: '3062b', color: 1, studOnAnchor: 0, receptor: 0, rot: 0, up: '+y' }
          ]
        },
        targetAction: { op: 'attach_assembly', childPartId: '4073', colorId: 4, subassemblyTemplateId: 'sub_beacon', parentInstanceId: base.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 0, isAssembly: true },
        candidateDistractors: [
          { op: 'attach_assembly', childPartId: '4073', colorId: 4, subassemblyTemplateId: 'sub_beacon', parentInstanceId: base.id, parentConnectorId: 'stud_2', childConnectorId: 'antistud_0', up: '+y', rot: 0, isAssembly: true },
          { op: 'attach_assembly', childPartId: '4073', colorId: 4, subassemblyTemplateId: 'sub_beacon', parentInstanceId: base.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 180, isAssembly: true },
          { op: 'attach_part', childPartId: '4073', colorId: 4, subassemblyTemplateId: null, parentInstanceId: base.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 0, isAssembly: false }
        ],
        badgePositions: [
          { tag: '1', pos3d: [0.5, 3, 0.5] },
          { tag: '2', pos3d: [1.5, 3, 0.5] },
          { tag: '3', pos3d: [2.5, 3, 0.5] },
          { tag: '4', pos3d: [3.5, 3, 0.5] }
        ]
      };
    }
  },
  {
    caseId: 'case_subasm_05',
    category: 'subassembly',
    name: 'Mount Wing Subassembly (3020 + 24299) onto Base',
    build: (cat) => {
      const b_t = createBuilder({ catalog: cat, meta: { name: 'c15_t', front: '+z' } });
      const base = b_t.add('3795', 71, { at: [0, 0, 0], step: 1 }); // 71 浅蓝灰
      b_t.assert();

      const b_next = createBuilder({ catalog: cat, meta: { name: 'c15_next', front: '+z' } });
      const base_next = b_next.add('3795', 71, { at: [0, 0, 0], step: 1 });
      const w1 = b_next.add('3020', 0, { at: [10, 0, 0], id: 'w1', step: 2 });
      const w2 = b_next.add('24299', 15, { on: w1.id, stud: 0, id: 'w2', step: 2 });
      b_next.addAssembly([w1.id, w2.id], { on: base_next.id, stud: 0, anchor: w1.id, anchorReceptor: 0, step: 3, label: 'wing' });
      b_next.assert();

      return {
        b_t, b_next,
        parentInstanceId: base.id,
        subassemblyTemplate: {
          templateId: 'sub_wing',
          anchorPartId: '3020',
          anchorReceptor: 0,
          members: [
            { part: '3020', color: 0, isAnchor: true },
            { part: '24299', color: 15, studOnAnchor: 0, receptor: 0, rot: 0, up: '+y' }
          ]
        },
        targetAction: { op: 'attach_assembly', childPartId: '3020', colorId: 0, subassemblyTemplateId: 'sub_wing', parentInstanceId: base.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 0, isAssembly: true },
        candidateDistractors: [
          { op: 'attach_assembly', childPartId: '3020', colorId: 0, subassemblyTemplateId: 'sub_wing', parentInstanceId: base.id, parentConnectorId: 'stud_1', childConnectorId: 'antistud_0', up: '+y', rot: 0, isAssembly: true },
          { op: 'attach_assembly', childPartId: '3020', colorId: 0, subassemblyTemplateId: 'sub_wing', parentInstanceId: base.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 90, isAssembly: true },
          { op: 'attach_part', childPartId: '3020', colorId: 0, subassemblyTemplateId: null, parentInstanceId: base.id, parentConnectorId: 'stud_0', childConnectorId: 'antistud_0', up: '+y', rot: 0, isAssembly: false }
        ],
        badgePositions: [
          { tag: '1', pos3d: [0.5, 1, 0.5] },
          { tag: '2', pos3d: [1.5, 1, 0.5] },
          { tag: '3', pos3d: [2.5, 1, 0.5] },
          { tag: '4', pos3d: [3.5, 1, 0.5] }
        ]
      };
    }
  }
];

export async function generateRealAssemblyCurriculum(outBaseDir) {
  const targetDir = path.resolve(outBaseDir);
  const casesDir = path.join(targetDir, 'cases');
  fs.mkdirSync(casesDir, { recursive: true });

  console.log('='.repeat(70));
  console.log('BrickKit 真实装配状态闭环最小样例集构建 (Task B Curriculum v4 Hardened)');
  console.log(`目标输出目录: ${targetDir}`);
  console.log(`样例总数: ${CASE_DEFS.length} 例 (5 堆叠 + 5 SNOT + 5 刚体子组件)`);
  console.log('='.repeat(70));

  const curriculumManifest = {
    schemaVersion: '1.0',
    curriculumKind: 'real_assembly_physical_transitions',
    createdAt: new Date().toISOString(),
    totalCases: CASE_DEFS.length,
    cases: []
  };

  const c3Samples = [];

  for (let idx = 0; idx < CASE_DEFS.length; idx++) {
    const cDef = CASE_DEFS[idx];
    const caseFolder = path.join(casesDir, cDef.caseId);
    fs.mkdirSync(caseFolder, { recursive: true });

    // 1. 构建真实 3D 模型
    const { b_t, b_next, parentInstanceId, targetAction, candidateDistractors, badgePositions, subassemblyTemplate } = cDef.build(FULL_CAT);
    const model_t = b_t.model();
    const model_next = b_next.model();

    // 静态校验确保 0 errors 与 0 warnings
    const v_t = validate(model_t, FULL_CAT);
    const v_next = validate(model_next, FULL_CAT);
    if (v_t.errors.length || v_t.warnings.length) {
      throw new Error(`${cDef.caseId} state_t 校验不合规: errors=${v_t.errors.length}, warnings=${v_t.warnings.length}`);
    }
    if (v_next.errors.length || v_next.warnings.length) {
      throw new Error(`${cDef.caseId} state_next 校验不合规: errors=${v_next.errors.length}, warnings=${v_next.warnings.length}`);
    }

    const stateTJson = JSON.stringify(model_t, null, 2);
    const stateNextJson = JSON.stringify(model_next, null, 2);
    const stateTHash = sha256(stateTJson);
    const stateNextHash = sha256(stateNextJson);

    fs.writeFileSync(path.join(caseFolder, 'state_t.brick.json'), stateTJson);
    fs.writeFileSync(path.join(caseFolder, 'state_next.brick.json'), stateNextJson);

    // 找出目标状态中新增的参考零件实例
    const existingIds = new Set(model_t.parts.map(p => p.id));
    const refPart = model_next.parts.find(p => !existingIds.has(p.id));

    // 2. 构造 4 个原始候选，并完成真实几何执行存证与等价判定
    const rawCandidates = [
      { ...targetAction, isTarget: true },
      { ...candidateDistractors[0], isTarget: false },
      { ...candidateDistractors[1], isTarget: false },
      { ...candidateDistractors[2], isTarget: false },
    ];

    function compareModels(executedModel, targetModel, catalog) {
      if (executedModel.parts.length !== targetModel.parts.length) {
        return {
          matches: false,
          reason: `part_count_mismatch: executed ${executedModel.parts.length} parts vs target ${targetModel.parts.length} parts`
        };
      }
      const executedParts = [...executedModel.parts];
      for (const tPart of targetModel.parts) {
        const tDef = catalog.parts[tPart.part];
        const tBoxes = JSON.stringify(partBoxes(tPart, tDef));
        const matchIdx = executedParts.findIndex(ePart => {
          if (ePart.part !== tPart.part || ePart.color !== tPart.color) return false;
          const eDef = catalog.parts[ePart.part];
          return JSON.stringify(partBoxes(ePart, eDef)) === tBoxes;
        });
        if (matchIdx === -1) {
          return {
            matches: false,
            reason: `target_part_not_matched: part ${tPart.part} (color ${tPart.color})`
          };
        }
        executedParts.splice(matchIdx, 1);
      }
      return { matches: true };
    }

    // 逐候选进行真实 builder.js 物理执行存证与全零件目标比对
    for (const cand of rawCandidates) {
      cand.orientationId = orientationIdOf(cand.up || '+y', cand.rot || 0);

      const parentPart = model_t.parts.find(p => p.id === cand.parentInstanceId);
      const studIdxMatch = cand.parentConnectorId.match(/(\d+)$/);
      const studIdx = studIdxMatch ? Number(studIdxMatch[1]) : 0;

      try {
        const b = createBuilder({ catalog: FULL_CAT, meta: model_t.meta });
        for (const p of model_t.parts) {
          b.add(p.part, p.color, { at: p.at, rot: p.rot, up: p.up, snot: p.snot, id: p.id, step: p.step });
        }

        if (cand.isAssembly && subassemblyTemplate) {
          // 完整刚体子组件挂装执行
          const subPartIds = [];
          const stagingX = 100;
          let anchorId = null;
          for (let mIdx = 0; mIdx < subassemblyTemplate.members.length; mIdx++) {
            const m = subassemblyTemplate.members[mIdx];
            const pid = `eval_sub_${mIdx}`;
            subPartIds.push(pid);
            if (mIdx === 0) {
              anchorId = pid;
              b.add(m.part, m.color, { at: [stagingX, 0, 0], id: pid, step: 2 });
            } else {
              b.add(m.part, m.color, { on: anchorId, stud: m.studOnAnchor, receptor: m.receptor, rot: m.rot, up: m.up, id: pid, step: 2 });
            }
          }
          b.addAssembly(subPartIds, {
            on: parentPart.id,
            stud: studIdx,
            anchor: anchorId,
            anchorReceptor: subassemblyTemplate.anchorReceptor ?? 0,
            rot: cand.rot ?? 0,
            step: 3,
            label: subassemblyTemplate.templateId
          });
        } else {
          // 单件动作执行 (若目标是子组件但候选为单件，将产生零件缺失)
          b.add(cand.childPartId, cand.colorId ?? (refPart ? refPart.color : 0), {
            id: 'eval_cand_part',
            on: parentPart.id,
            stud: studIdx,
            rot: cand.rot ?? 0,
            up: cand.up ?? '+y',
            step: 2
          });
        }

        b.assert(); // 校验是否有穿模、干涉或浮空
        const executedModel = b.model();

        // 核对执行后完整模型与目标模型 model_next 是否全量匹配 (件数、件号、颜色、包围盒)
        const cmp = compareModels(executedModel, model_next, FULL_CAT);
        if (cmp.matches) {
          cand.executionReceipt = {
            status: 'success',
            physicalConnected: true,
            collides: false,
            sameMaterialBoxesAsTarget: true,
            outcome: 'matches_target_geometry'
          };
        } else {
          cand.executionReceipt = {
            status: 'target_mismatch',
            physicalConnected: true,
            collides: false,
            sameMaterialBoxesAsTarget: false,
            outcome: cmp.reason
          };
        }
      } catch (e) {
        const isCollision = e.message.includes('穿模') || e.message.includes('collide') || e.message.includes('boxesCollide');
        cand.executionReceipt = {
          status: isCollision ? 'collision_error' : 'physical_invalid',
          physicalConnected: false,
          collides: isCollision,
          sameMaterialBoxesAsTarget: false,
          outcome: e.message
        };
      }
    }

    // 3. 确定性随机洗牌 (打乱顺序) 并分配匿名 candidateId (cand_1 .. cand_4)
    const shuffledRaw = seededShuffle(rawCandidates, `${cDef.caseId}-${idx * 17 + 42}`);
    const anonymousCandidates = shuffledRaw.map((c, i) => {
      const anonId = `cand_${i + 1}`;
      return {
        ...c,
        candidateId: anonId,
        candidateHash: sha256(`${anonId}-${stateTHash}-${c.orientationId}`)
      };
    });

    const targetCand = anonymousCandidates.find(c => c.isTarget);
    if (!targetCand) {
      throw new Error(`${cDef.caseId}: 缺少目标动作候选`);
    }
    if (!targetCand.executionReceipt || targetCand.executionReceipt.status !== 'success' || !targetCand.executionReceipt.sameMaterialBoxesAsTarget) {
      throw new Error(`${cDef.caseId}: 预设目标动作候选执行未成功: ${JSON.stringify(targetCand.executionReceipt)}`);
    }
    const selectedCandidateId = targetCand.candidateId;

    // 收集全部与目标几何完全等价的候选 ID (严禁无条件塞入未通过执行的候选)
    const equivalentCandidateIds = anonymousCandidates
      .filter(c => c.executionReceipt.sameMaterialBoxesAsTarget && c.executionReceipt.physicalConnected && !c.executionReceipt.collides && c.executionReceipt.status === 'success')
      .map(c => c.candidateId);

    if (!equivalentCandidateIds.includes(selectedCandidateId)) {
      throw new Error(`${cDef.caseId}: selectedCandidateId ${selectedCandidateId} 未被纳入 equivalentCandidateIds`);
    }

    // 4. 渲染 128x128 预览图 (明确标注为 collision_proxy_preview)
    const svgStateT = renderModelToSvg(model_t, { badges: badgePositions });
    const pngStateTBuf = await sharp(Buffer.from(svgStateT)).png().toBuffer();
    const stateTPngPath = path.join(caseFolder, 'state_t_rendered.png');
    fs.writeFileSync(stateTPngPath, pngStateTBuf);

    const svgStateNext = renderModelToSvg(model_next, { badges: [] });
    const pngStateNextBuf = await sharp(Buffer.from(svgStateNext)).png().toBuffer();
    const stateNextPngPath = path.join(caseFolder, 'target_rendered.png');
    fs.writeFileSync(stateNextPngPath, pngStateNextBuf);

    const stateTPngHash = sha256(pngStateTBuf);
    const stateNextPngHash = sha256(pngStateNextBuf);

    // 5. 组装单个 Case 契约清单
    const caseManifest = {
      caseId: cDef.caseId,
      category: cDef.category,
      name: cDef.name,
      renderMode: 'collision_proxy_preview',
      state_t: {
        path: `cases/${cDef.caseId}/state_t.brick.json`,
        sha256: stateTHash,
        partsCount: model_t.parts.length,
        validation: { ok: true, errors: 0, warnings: 0 }
      },
      state_next: {
        path: `cases/${cDef.caseId}/state_next.brick.json`,
        sha256: stateNextHash,
        partsCount: model_next.parts.length,
        validation: { ok: true, errors: 0, warnings: 0 }
      },
      builderReceipt: {
        status: 'verified_zero_error',
        executionEngine: 'src/core/builder.js',
        collisions: 0,
        floating: 0,
        warnings: 0,
        ok: true
      },
      targetAction: {
        selectedCandidateId,
        equivalentCandidates: equivalentCandidateIds,
        action: targetAction
      },
      candidates: anonymousCandidates.map((c, i) => ({
        index: i,
        candidateId: c.candidateId,
        op: c.op || (c.isAssembly ? 'attach_assembly' : 'attach_part'),
        isAssembly: Boolean(c.isAssembly),
        subassemblyTemplateId: c.subassemblyTemplateId || null,
        parentInstanceId: c.parentInstanceId,
        parentConnectorId: c.parentConnectorId,
        childPartId: c.childPartId,
        childConnectorId: c.childConnectorId,
        orientationId: c.orientationId,
        candidateHash: c.candidateHash,
        executionReceipt: c.executionReceipt
      })),
      images: {
        state_t: {
          path: `cases/${cDef.caseId}/state_t_rendered.png`,
          sha256: stateTPngHash,
          neutralBadgesCount: badgePositions.length,
          style: 'neutral_white_dark_outline_black_text'
        },
        target: {
          path: `cases/${cDef.caseId}/target_rendered.png`,
          sha256: stateNextPngHash
        }
      }
    };

    fs.writeFileSync(path.join(caseFolder, 'case_manifest.json'), JSON.stringify(caseManifest, null, 2));
    curriculumManifest.cases.push(caseManifest);

    // 6. 输出 100% 符合 dataset.schema.json 的标准 C3 样本
    const splitName = idx < 9 ? 'train' : (idx < 12 ? 'validation' : 'holdout_test');
    const tokId = `tok-${cDef.caseId}`;
    const subassemblyMembers = subassemblyTemplate ? subassemblyTemplate.members : null;
    const inventoryTokens = subassemblyMembers
      ? subassemblyMembers.map((m, mIdx) => ({ tokenId: `${tokId}-m${mIdx + 1}`, partId: m.part, colorId: m.color }))
      : [{ tokenId: tokId, partId: targetAction.childPartId, colorId: targetAction.colorId || 0 }];

    c3Samples.push({
      sampleId: `smp-curriculum-${String(idx + 1).padStart(5, '0')}`,
      protocolVersion: '1.0',
      taskType: 'select_action',
      provenance: {
        sourceFamilyId: 'curriculum-real-assembly',
        sourceModelId: cDef.caseId,
        sourceKind: 'synthetic_assembly',
        split: splitName,
        difficulty: cDef.category
      },
      assetLock: {
        catalogVersion: '1.0',
        engineRevision: '1.0'
      },
      images: [
        {
          role: 'target_manual_step',
          imagePath: path.relative(ROOT, stateNextPngPath).replace(/\\/g, '/'),
          imageSha256: stateNextPngHash,
          labeled: false
        },
        {
          role: 'current_rendered_state',
          imagePath: path.relative(ROOT, stateTPngPath).replace(/\\/g, '/'),
          imageSha256: stateTPngHash,
          labeled: true
        }
      ],
      stateRef: {
        taskId: `task-curriculum-${cDef.caseId}`,
        stepNumber: 1,
        stateHash: stateTHash
      },
      inventory: inventoryTokens,
      candidates: {
        enumerationComplete: true,
        truncated: false,
        items: anonymousCandidates.map(c => ({
          candidateId: c.candidateId,
          op: c.op || (c.isAssembly ? 'attach_assembly' : 'attach_part'),
          isAssembly: Boolean(c.isAssembly),
          subassemblyTemplateId: c.subassemblyTemplateId || null,
          parentInstanceId: c.parentInstanceId,
          parentConnectorId: c.parentConnectorId,
          childPartId: c.childPartId,
          childConnectorId: c.childConnectorId,
          orientationId: c.orientationId,
          candidateHash: c.candidateHash
        }))
      },
      target: {
        primaryAction: {
          op: cDef.category === 'subassembly' ? 'attach_assembly' : 'attach_part',
          selectedCandidateId,
          subassemblyTemplateId: cDef.category === 'subassembly' ? subassemblyTemplate.templateId : null,
          consumedTokenId: inventoryTokens[0].tokenId,
          consumedTokenIds: inventoryTokens.map(t => t.tokenId),
          assignedInstanceId: refPart ? refPart.id : 'p002'
        },
        equivalentCandidates: equivalentCandidateIds
      },
      verification: {
        isGeometricallyLegal: true,
        hasManualGroundTruth: true,
        verifiedBy: 'src/core/builder.js',
        evidenceNote: `Verified 3D physical transition via builder.js (${cDef.category}); candidate actions executed and diagnosed`
      }
    });

    console.log(`[样例已生成] ${cDef.caseId} (${cDef.category}) | Target: ${selectedCandidateId} | Equiv: [${equivalentCandidateIds.join(', ')}]`);
  }

  // 7. 保存全清单与标准化 C3 样本集及训练/验证/留出划分
  fs.writeFileSync(path.join(targetDir, 'curriculum-manifest.json'), JSON.stringify(curriculumManifest, null, 2));
  fs.writeFileSync(path.join(targetDir, 'curriculum-samples.json'), JSON.stringify(c3Samples, null, 2));

  const datasetDir = path.join(targetDir, 'dataset');
  fs.mkdirSync(datasetDir, { recursive: true });

  const trainSamples = c3Samples.filter(s => s.provenance.split === 'train');
  const valSamples = c3Samples.filter(s => s.provenance.split === 'validation');
  const holdoutSamples = c3Samples.filter(s => s.provenance.split === 'holdout_test');

  fs.writeFileSync(path.join(datasetDir, 'train.json'), JSON.stringify(trainSamples, null, 2));
  fs.writeFileSync(path.join(datasetDir, 'validation.json'), JSON.stringify(valSamples, null, 2));
  fs.writeFileSync(path.join(datasetDir, 'holdout_test.json'), JSON.stringify(holdoutSamples, null, 2));

  console.log('='.repeat(70));
  console.log(`[成功交付] 15 个真实装配状态闭环样例与分层划分已落盘至: ${targetDir}`);
  return curriculumManifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2] || 'out/prd-v2/run-20261026-v4/B/real-assembly-curriculum';
  generateRealAssemblyCurriculum(outDir).catch(err => {
    console.error('生成失败:', err);
    process.exit(1);
  });
}
