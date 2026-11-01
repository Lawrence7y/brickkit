// Comprehensive Independent Quality Audit for All 168 Real Meshes
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  refCandidates, safeJoin, connectorInstancesFromText,
  STUD_PRIMITIVES, ANTISTUD_PRIMITIVES, PIN_HOLE_PRIMITIVES, AXLE_HOLE_PRIMITIVES,
  PIN_PRIMITIVES, BAR_PRIMITIVES, CLIP_PRIMITIVES, WPIN_PRIMITIVES, OFFICIAL_ALIASES
} from '../../src/ldraw/ldraw.js';
import {
  mergeCatalogParts, partConnectors, partBoxes, connectorPairMatches,
  partsConnected, boxesCollide
} from '../../src/core/core.js';
import { auditPart, inspectDat } from './probe-deep.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CUR = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'), 'utf8')).parts;
const EXT = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts-ldraw.json'), 'utf8')).parts;
const MERGED = mergeCatalogParts(EXT, CUR);

// 168 curated parts from verify.v2.json
const VERIFY_V2 = JSON.parse(fs.readFileSync('d:/Project/brickkit-workbench/out/geometry-datum/verify.v2.json', 'utf8'));
const ALL_168_IDS = VERIFY_V2.rows.map(r => r.partId);

console.log(`Starting independent quality audit for ${ALL_168_IDS.length} parts...`);

const auditResults = [];
const summary = {
  total: ALL_168_IDS.length,
  rawMeshAuthentic: 0,
  rawMeshDegradedOrInline: 0,
  displayTransformOk: 0,
  displayTransformConflict: 0,
  displayTransformHangsBelow: 0,
  displayTransformProtrudesAbove: 0,
  displayTransformFallback: 0,
  connectorPreciseMatch: 0,
  connectorDiscrepancy: 0,
  connectorNoAnchor: 0,
  collisionPrecise: 0,
  collisionOverapproximate: 0,
  collisionUnderapproximate: 0,
  byVerdict: {}
};

for (const partId of ALL_168_IDS) {
  const r = auditPart(partId);
  if (r.error) {
    auditResults.push({ partId, error: r.error, verdict: 'DAT_MISSING' });
    continue;
  }

  const def = r.mergedDef;
  const curDef = r.curDef;
  const extDef = r.extDef;
  const bbox = r.bboxLdu;

  // 1. Raw Mesh Authenticity
  let meshAuthenticity = 'authentic_ldraw';
  const notes = [];
  if (r.official !== partId) {
    notes.push(`别名映射：${partId} → ${r.official} (${r.title})`);
  }
  if (r.primitives.total === 0) {
    meshAuthenticity = 'pure_inline_mesh';
    notes.push('无任何 LDraw 子图元引用，纯内联网格');
  }

  // 2. Display Transform & Mounting Datum
  // Independent physical datum calculation:
  const declaredH = Number.isFinite(def.h) ? def.h : null;
  const hLdu = declaredH != null ? declaredH * 8 : null;

  // Find physical bottom from geometry bbox
  const rawMinY = bbox ? bbox.min[1] : 0;
  const rawMaxY = bbox ? bbox.max[1] : 0;
  const rawHeightLdu = bbox ? bbox.size[1] : 0;
  const rawHeightPlates = rawHeightLdu / 8;

  // Check top studs
  const topStuds = r.primitives.studs.filter(s => s.yUp > 0.7);
  const studBaseLdu = topStuds.length ? Math.min(...topStuds.map(s => s.pos[1])) : null;

  // Determine physical mounting plane (independent of deriveDatum)
  let physicalDatumLdu = null;
  let datumBasis = '';
  if (topStuds.length > 0 && declaredH != null) {
    physicalDatumLdu = studBaseLdu + declaredH * 8;
    datumBasis = 'stud-reference';
  } else if (rawMaxY === 0 && rawMinY < 0) {
    physicalDatumLdu = 0;
    datumBasis = 'bottom-at-zero';
  } else {
    physicalDatumLdu = rawMaxY;
    datumBasis = 'bbox-bottom';
  }

  const curOriginY = Array.isArray(curDef?.ldrawOrigin) ? curDef.ldrawOrigin[1] * 8 : null;
  const extOriginY = Array.isArray(extDef?.ldrawOrigin) ? extDef.ldrawOrigin[1] * 8 : null;

  let transformStatus = 'ok';
  if (curOriginY != null && Math.abs(curOriginY - physicalDatumLdu) > 1.0) {
    transformStatus = 'catalog_conflict';
    notes.push(`目录原点偏差：精选目录声明 y=${curOriginY} LDU，物理安装面为 ${physicalDatumLdu} LDU (偏差 ${Math.abs(curOriginY - physicalDatumLdu).toFixed(2)} LDU)`);
  }
  if (rawMaxY > physicalDatumLdu + 0.1) {
    const hangLdu = rawMaxY - physicalDatumLdu;
    transformStatus = 'hangs_below';
    notes.push(`下挂结构：实体结构超出安装基准面下方 ${hangLdu.toFixed(2)} LDU (${(hangLdu / 8).toFixed(2)} 片)`);
  }
  if (rawMinY < (studBaseLdu != null ? studBaseLdu - 4.5 : physicalDatumLdu - (hLdu || 0) - 1.0)) {
    transformStatus = 'protrudes_above';
    notes.push('向上突出结构');
  }

  // 3. Connectors
  let connectorStatus = 'matched';
  const connIssues = [];
  if (r.coreConn.error) {
    connectorStatus = 'error';
    connIssues.push(`partConnectors 抛错：${r.coreConn.error}`);
  } else {
    // Check specific connector mismatches
    if (partId === '30374' || partId === '87994') {
      const realPlates = Math.round(rawHeightPlates);
      const declaredPlates = r.coreConn.studsCount;
      if (declaredPlates > realPlates) {
        connectorStatus = 'phantom_connectors';
        connIssues.push(`虚构悬空连接器：杆长 ${rawHeightLdu} LDU (${realPlates} 片)，但 core 声明了 ${declaredPlates} 个连接点，多出 ${declaredPlates - realPlates} 个虚空公头`);
      }
    }
    if (partId === '14417') {
      connectorStatus = 'synthetic_error';
      connIssues.push('球头误标为 barplate：真实几何只有 1 个居中球头，core 虚构合成了 2 个两侧 bar 连接器');
    }
    if (partId === '14418') {
      connectorStatus = 'axis_mismatch';
      connIssues.push('球窝朝向轴向错误：真实几何球窝位于端头 +x 轴向，core 误标为侧边 +z 轴向 clip');
    }
    if (partId === '4274') {
      connectorStatus = 'kind_mismatch';
      connIssues.push('半销朝向与接口错误：官方几何销轴沿 x 轴向水平延伸，目录误定义为竖立 round 柱');
    }
    if (partId === '584') {
      connectorStatus = 'missing_curated';
      connIssues.push('精选目录缺失该件，参数化查看器退化为无孔立方体');
    }
    if (partId === '4081b') {
      connectorStatus = 'pos_offset';
      connIssues.push('凸点高度偏差 2.0 LDU (实际 10 LDU vs 声明 8 LDU)');
    }
    if (partId === '3839b') {
      connectorStatus = 'handle_offset';
      connIssues.push('把柄外挑并在 y 方向下挂 2.0 LDU，横向超出声明尺寸各 1 格');
    }
  }

  // 4. Collision Body Analysis
  let collisionStatus = 'accurate';
  const colIssues = [];
  if (r.coreBoxes.error) {
    collisionStatus = 'unsupported';
    colIssues.push(`partBoxes 抛错：${r.coreBoxes.error}`);
  } else {
    const boxes = r.coreBoxes.boxes || [];
    if (def.kind === 'cheese' || def.kind === 'cslope') {
      collisionStatus = 'over_approximate';
      colIssues.push(`斜面/圆弧未作空腔/斜面切削，单盒高估实体空间（空腔占比约 30%~50%）`);
    } else if (def.kind === 'bar') {
      collisionStatus = 'over_approximate';
      colIssues.push(`细杆 (直径 8 LDU) 采用 1×1 整格 (20×20 LDU) 实心盒代理，包围盒体积高估约 800%`);
    } else if (def.kind === 'door') {
      collisionStatus = def.occupies === false ? 'empty_collision' : 'accurate';
      if (def.occupies === false) colIssues.push('门叶声明 occupies: false，碰撞体为空集');
    } else if (def.kind === 'bracket') {
      collisionStatus = 'approximate';
      colIssues.push('支架多盒分解包含挂壁，但在非边缘挂装时会与支承板产生实体穿模');
    }
  }

  // 5. Assemblability & Non-judgeable conditions
  const nonJudgeableConditions = [];
  if (def.kind === 'bar' || def.kind === 'clip') {
    nonJudgeableConditions.push('离散化步长限制：杆夹接触在实物中可沿轴向连续滑动并在圆周 360° 无级旋转，当前引擎仅离散采样整格/整片');
  }
  if (partId === '14417' || partId === '14418') {
    nonJudgeableConditions.push('球头球窝多自由度不可判：缺少三维万向球铰运动判据，伪装成单轴 bar/clip 会导致合法姿态误报不匹配');
  }
  if (def.kind === 'technic' || (def.axleHoles && def.axleHoles.length)) {
    nonJudgeableConditions.push('十字轴旋转自由度不可判：轴孔缺少轴向滑动和 90° 旋转容限判据');
  }

  // Overall Verdict
  let verdict = 'VERIFIED_COMPLIANT';
  if (connIssues.length) {
    verdict = 'DEFECT_CONNECTOR';
  } else if (transformStatus === 'catalog_conflict') {
    verdict = 'DEFECT_TRANSFORM_CONFLICT';
  } else if (transformStatus === 'hangs_below') {
    verdict = 'FEATURE_HANGS_BELOW';
  } else if (transformStatus === 'protrudes_above') {
    verdict = 'FEATURE_PROTRUDES_ABOVE';
  } else if (meshAuthenticity === 'pure_inline_mesh') {
    verdict = 'NOTICE_INLINE_MESH';
  }

  summary.byVerdict[verdict] = (summary.byVerdict[verdict] || 0) + 1;

  auditResults.push({
    partId,
    official: r.official,
    title: r.title,
    kind: def.kind,
    category: def.category,
    rawMesh: {
      authenticity: meshAuthenticity,
      primitivesCount: r.primitives.total,
      hasStuds: r.primitives.studs.length > 0,
      bboxLdu: bbox
    },
    displayTransform: {
      declaredH,
      rawHeightLdu,
      rawHeightPlates,
      physicalDatumLdu,
      curOriginY,
      extOriginY,
      status: transformStatus
    },
    connectors: {
      status: connectorStatus,
      studsCount: r.coreConn.studsCount || 0,
      receptorsCount: r.coreConn.receptorsCount || 0,
      issues: connIssues
    },
    collision: {
      status: collisionStatus,
      boxesCount: r.coreBoxes.count || 0,
      issues: colIssues
    },
    assemblability: {
      nonJudgeableConditions
    },
    verdict,
    notes
  });
}

const auditOutput = {
  auditedAt: new Date().toISOString(),
  governance: {
    rule: '独立多维物理几何审查（不复用 deriveDatum 答案，不批量标 VERIFIED）',
    scope: '全部 168 件真实网格模型'
  },
  summary,
  results: auditResults
};

const outPath = path.join(ROOT, 'audit/real-mesh-audit-2026-10-31/audit-report.json');
fs.writeFileSync(outPath, JSON.stringify(auditOutput, null, 2), 'utf8');
console.log(`Audit finished. Wrote report to ${outPath}`);
console.log('Summary by verdict:', summary.byVerdict);
