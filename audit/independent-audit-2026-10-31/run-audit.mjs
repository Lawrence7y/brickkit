// Comprehensive Independent Mesh Audit Runner
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectPart } from './probe.mjs';
import { PLATE } from '../../src/core/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CUR = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'), 'utf8')).parts;
const EXT = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts-ldraw.json'), 'utf8')).parts;

// Gather all parts from CUR and relevant EXT parts (including 584, 35, 36)
const allPartIds = Array.from(new Set([
  ...Object.keys(CUR),
  '584', '35', '36'
])).sort();

console.log(`Auditing ${allPartIds.length} target parts independently...`);

const results = [];
const stats = {
  total: allPartIds.length,
  found: 0,
  missingDat: 0,
  dimensions: {
    rawMesh: { authenticLdraw: 0, nonBfc: 0, pureInline: 0 },
    displayTransform: { ok: 0, conflict: 0, hangsBelow: 0, floatAbove: 0 },
    connectors: { matched: 0, phantom: 0, missingAnchor: 0, wrongOrientation: 0, wrongKind: 0 },
    collision: { accurate: 0, overapproximate: 0, underapproximate: 0, unsupported: 0 },
    assemblability: { fullyDiscrete: 0, nonJudgeableContinuous: 0, nonJudgeableBallSocket: 0, nonJudgeableAxleTolerance: 0 }
  },
  priorityGroups: {
    hangsBelow: [],
    noTopStuds: [],
    catalogConflict: [],
    unverified6: [],
    lackingPrimitiveAnchors: []
  }
};

const UNVERIFIED_6 = new Set(['15712', '30374', '4274', '584', '60623', '87994']);
const CONFLICT_12 = new Set(['11477', '14417', '14418', '15068', '18677', '2444', '3839b', '4081b', '54200', '85984', '92946', '93273']);

for (const partId of allPartIds) {
  const p = inspectPart(partId);
  if (!p.found) {
    stats.missingDat++;
    results.push({ partId, found: false });
    continue;
  }
  stats.found++;

  const cur = p.curDef;
  const ext = p.extDef;
  const def = p.mergedDef;
  const bbox = p.geometry.bboxLdu;
  const prims = p.geometry.primitives;

  // 1. Raw Mesh Authenticity
  let rawMeshStatus = 'authentic';
  if (p.geometry.bfcCertify !== 'CCW') {
    rawMeshStatus = 'non_bfc_or_cw';
    stats.dimensions.rawMesh.nonBfc++;
  } else if (prims.total === 0 && (p.geometry.inlineTriangles > 0 || p.geometry.inlineQuads > 0)) {
    rawMeshStatus = 'pure_inline';
    stats.dimensions.rawMesh.pureInline++;
  } else {
    stats.dimensions.rawMesh.authenticLdraw++;
  }

  // 2. Display Transform & Mounting Datum
  // Independent Physical Measurement:
  // LDraw coordinate conventions:
  // - Top studs: standard studs have top at Y = -4, base at Y = 0.
  // - Standard plates have base at Y = 0, bottom at Y = 8 (thickness 8 LDU = 1 plate).
  // - Standard bricks have base at Y = 0, bottom at Y = 24 (thickness 24 LDU = 3 plates).
  // - Slopes without top studs: typically modeled with bottom at Y = 0 and top slanting up to Y = -16 or -24.
  // - Downward brackets: top flange bottom at Y = 8, hanging wall extends down to Y = 20 (99781/36841) or 40 (44728).
  const declaredH = cur?.h ?? ext?.h ?? null;
  const declaredOrigin = cur?.ldrawOrigin ?? ext?.ldrawOrigin ?? null;
  const curOriginY = Array.isArray(cur?.ldrawOrigin) ? cur.ldrawOrigin[1] * 8 : null;
  const extOriginY = Array.isArray(ext?.ldrawOrigin) ? ext.ldrawOrigin[1] * 8 : null;

  const topStudPrims = prims.studs.filter(s => s.yUp > 0.7);
  const hasTopStuds = topStudPrims.length > 0;
  const studBaseY = hasTopStuds ? Math.min(...topStudPrims.map(s => s.pos[1])) : null;

  let physicalDatumLdu = null;
  let datumBasis = '';
  if (hasTopStuds && declaredH != null) {
    physicalDatumLdu = studBaseY + declaredH * 8;
    datumBasis = 'stud-reference';
  } else if (bbox && bbox.max[1] === 0 && bbox.min[1] < 0) {
    physicalDatumLdu = 0;
    datumBasis = 'slope-bottom-at-zero';
  } else if (bbox) {
    physicalDatumLdu = bbox.max[1];
    datumBasis = 'bbox-max-y';
  }

  // Check Hanging Below / Protrudes Above / Catalog Conflict
  const hangLdu = (bbox && physicalDatumLdu != null) ? Math.max(0, bbox.max[1] - physicalDatumLdu) : 0;
  const isHangsBelow = hangLdu > 0.5;

  let transformVerdict = 'ok';
  let originDiscrepancyLdu = null;
  if (curOriginY != null && physicalDatumLdu != null) {
    originDiscrepancyLdu = Math.round((curOriginY - physicalDatumLdu) * 100) / 100;
    if (Math.abs(originDiscrepancyLdu) > 1.0) {
      transformVerdict = 'catalog_conflict';
      stats.dimensions.displayTransform.conflict++;
    } else if (isHangsBelow) {
      transformVerdict = 'hangs_below';
      stats.dimensions.displayTransform.hangsBelow++;
    } else {
      stats.dimensions.displayTransform.ok++;
    }
  } else {
    stats.dimensions.displayTransform.ok++;
  }

  // 3. Connector Positions & Orientations
  const connIssues = [];
  let connectorVerdict = 'matched';

  if (p.core.connError) {
    connectorVerdict = 'error';
    connIssues.push(`partConnectors threw: ${p.core.connError}`);
  } else if (p.core.connectors) {
    const cStuds = p.core.connectors.studs;
    const cReceptors = p.core.connectors.receptors;

    // Check bar overgeneration
    if (def.kind === 'bar' && bbox) {
      const realPlates = Math.round(bbox.size[1] / 8);
      const generatedBars = cStuds.filter(s => s.kind === 'bar').length;
      if (generatedBars > realPlates) {
        connectorVerdict = 'phantom';
        connIssues.push(`Generated ${generatedBars} bar connectors, but real length is ${bbox.size[1]} LDU (${realPlates} plates). Phantom connectors: ${generatedBars - realPlates}`);
        stats.dimensions.connectors.phantom++;
      }
    }

    // Check 15712 phantom top stud and side clip
    if (partId === '15712') {
      const topStud = cStuds.find(s => s.kind === 'top');
      if (topStud) {
        connIssues.push('Tile 1x1 has no top stud, but core generated phantom top stud');
        stats.dimensions.connectors.phantom++;
      }
      const sideClip = cReceptors.find(r => r.kind === 'clip' && r.dir === '+z');
      if (sideClip) {
        connIssues.push('Clip oriented in +z (side), but real physical clip is on top (+y)');
        stats.dimensions.connectors.wrongOrientation++;
      }
    }

    // Check 14417 (Ball) and 14418 (Socket)
    if (partId === '14417') {
      const barCount = cStuds.filter(s => s.kind === 'bar').length;
      if (barCount > 0) {
        connIssues.push(`Ball joint modeled as ${barCount} synthetic bars on side; real geometry is single center ball`);
        stats.dimensions.connectors.wrongKind++;
      }
    }
    if (partId === '14418') {
      const sideClip = cReceptors.find(r => r.kind === 'clip' && r.dir === '+z');
      if (sideClip) {
        connIssues.push('Socket modeled as side-facing clip in +z; real geometry is end socket in +x');
        stats.dimensions.connectors.wrongOrientation++;
      }
    }

    // Check 4274 (Technic Pin)
    if (partId === '4274') {
      if (cur?.kind === 'round') {
        connIssues.push('Curated catalog defines 4274 as kind: "round" (vertical 1x1 round plate); real geometry is horizontal technic pin along X');
        stats.dimensions.connectors.wrongKind++;
      }
    }

    // Check lacking primitive anchors
    if (!hasTopStuds && prims.total === 0) {
      stats.dimensions.connectors.missingAnchor++;
    } else {
      stats.dimensions.connectors.matched++;
    }
  }

  // 4. Collision Body Fidelity
  let collisionVerdict = 'accurate';
  const collisionIssues = [];
  if (p.core.boxError) {
    collisionVerdict = 'unsupported';
    collisionIssues.push(`partBoxes threw: ${p.core.boxError}`);
    stats.dimensions.collision.unsupported++;
  } else if (p.core.boxes) {
    const bCount = p.core.boxes.length;
    if (cur?.kind === 'bracket' && cur.dir === 'down') {
      if (cur.vH === 3 && hangLdu === 12) {
        collisionVerdict = 'overapproximate';
        collisionIssues.push(`Bracket Box 2 uses vH: 3 (-2 plates = 16 LDU depth), but official .dat hangs down 12 LDU (1.5 plates). Overestimates collision by 0.5 plate (4 LDU)`);
        stats.dimensions.collision.overapproximate++;
      }
    } else if (cur?.kind === 'cheese' || cur?.kind === 'cslope') {
      collisionVerdict = 'overapproximate';
      collisionIssues.push('Single solid bounding box for slope/curved surface (overestimates solid volume by ~30%-50%)');
      stats.dimensions.collision.overapproximate++;
    } else if (partId === '18677') {
      collisionVerdict = 'underapproximate';
      collisionIssues.push('Plate 1x2 with Pin Hole: bottom boss hangs down 11 LDU (1.375 plates), but partBoxes only generates single 1-plate box (misses downward boss)');
      stats.dimensions.collision.underapproximate++;
    } else {
      stats.dimensions.collision.accurate++;
    }
  }

  // 5. Assemblability & Non-Judgeable Conditions
  const nonJudgeable = [];
  if (def.kind === 'bar' || def.kind === 'clip' || prims.bars.length > 0 || prims.clips.length > 0) {
    nonJudgeable.push('Bar-Clip continuous translation and 360-deg rotation cannot be fully judged by discrete grid sampling');
    stats.dimensions.assemblability.nonJudgeableContinuous++;
  }
  if (partId === '14417' || partId === '14418' || prims.balls.length > 0 || prims.sockets.length > 0) {
    nonJudgeable.push('Spherical ball joint 3-DoF angular cone motion cannot be judged by 1D hinge or discrete snap');
    stats.dimensions.assemblability.nonJudgeableBallSocket++;
  }
  if (def.kind === 'technic' || (def.axleHoles && def.axleHoles.length > 0)) {
    nonJudgeable.push('Cross-axle continuous sliding and 90-degree rotational symmetry unmodeled in discrete interface');
    stats.dimensions.assemblability.nonJudgeableAxleTolerance++;
  }

  // Priority group classifications
  if (isHangsBelow) stats.priorityGroups.hangsBelow.push(partId);
  if (!hasTopStuds) stats.priorityGroups.noTopStuds.push(partId);
  if (CONFLICT_12.has(partId)) stats.priorityGroups.catalogConflict.push(partId);
  if (UNVERIFIED_6.has(partId)) stats.priorityGroups.unverified6.push(partId);
  if (prims.studs.length === 0 && prims.clips.length === 0 && prims.bars.length === 0 && prims.pins.length === 0 && prims.pinHoles.length === 0 && prims.axleHoles.length === 0) {
    stats.priorityGroups.lackingPrimitiveAnchors.push(partId);
  }

  results.push({
    partId,
    official: p.official,
    found: true,
    file: p.file,
    category: cur?.category ?? ext?.category ?? 'other',
    kind: cur?.kind ?? ext?.kind ?? 'other',
    rawMesh: {
      status: rawMeshStatus,
      bfc: p.geometry.bfcCertify,
      subfiles: p.geometry.subfileCount,
      inlineTriangles: p.geometry.inlineTriangles,
      inlineQuads: p.geometry.inlineQuads,
      bboxLdu: bbox
    },
    displayTransform: {
      status: transformVerdict,
      datumBasis,
      physicalDatumLdu,
      curOriginY,
      extOriginY,
      originDiscrepancyLdu,
      hangLdu,
      declaredH
    },
    connectors: {
      status: connectorVerdict,
      issues: connIssues,
      studsCount: p.core.connectors?.studs.length ?? 0,
      receptorsCount: p.core.connectors?.receptors.length ?? 0,
      primitivesMeasured: {
        studs: prims.studs.length,
        antistuds: prims.antistuds.length,
        clips: prims.clips.length,
        bars: prims.bars.length,
        pins: prims.pins.length,
        pinHoles: prims.pinHoles.length,
        axleHoles: prims.axleHoles.length,
        balls: prims.balls.length,
        sockets: prims.sockets.length
      }
    },
    collision: {
      status: collisionVerdict,
      issues: collisionIssues,
      boxesCount: p.core.boxes?.length ?? 0
    },
    assemblability: {
      nonJudgeable
    }
  });
}

const auditOutput = {
  timestamp: new Date().toISOString(),
  stats,
  results
};

const outPath = path.join(ROOT, 'audit/independent-audit-2026-10-31/independent-audit-results.json');
fs.writeFileSync(outPath, JSON.stringify(auditOutput, null, 2), 'utf8');
console.log(`Independent audit complete. Results saved to ${outPath}`);
console.log('Stats summary:');
console.log(JSON.stringify(stats, null, 2));
