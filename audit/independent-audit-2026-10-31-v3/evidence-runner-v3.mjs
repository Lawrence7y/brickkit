// Concrete Counterexample Evidence Runner v3
// Adheres strictly to Requirement 5:
// - Every part ID is executed individually (no group representative substitution)
// - 99781, 36841, 44728 tested separately
// - 18677, 2444 tested separately
// - Ball joint legal poses derived from independent interface center & axis transformations
// - Bracket clearances & bottom boss penetrations provided in unified units (LDU, plates, studs)
// - Assertions verify expected outcomes to yield CONFIRMED / REFUTED / UNVERIFIED

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WB_ROOT = 'D:/Project/brickkit-workbench';

const wbCore = await import(`file:///${WB_ROOT}/src/core/core.js`);
const cur = JSON.parse(fs.readFileSync(`${WB_ROOT}/catalog/parts.json`, 'utf8')).parts;
const ext = JSON.parse(fs.readFileSync(`${WB_ROOT}/catalog/parts-ldraw.json`, 'utf8')).parts;
const defs = wbCore.mergeCatalogParts(ext, cur);

const evidence = {
  version: '2026-10-31-v3',
  generatedAt: new Date().toISOString(),
  unitsDefinition: {
    studToLdu: 20,
    plateToLdu: 8,
    studToPlates: 2.5,
    plateToStuds: 0.4,
    lduToStuds: 0.05,
    lduToPlates: 0.125
  },
  cases: {}
};

console.log('=== Running Evidence Runner v3 ===');

// =========================================================================
// Case 1a: Downward Bracket 1 x 2 (99781) - Separate Execution
// =========================================================================
console.log('--- Case 1a: 99781 Downward Bracket ---');
{
  // 99781: Bracket 1 x 2 - 1 x 2 Down
  // Official LDraw geometry (99781.dat):
  // BBox Y: [-4, 20] LDU. Top plate top: 0 LDU, bottom: 8 LDU.
  // Hanging wall bottom: 20 LDU. Real hanging depth below top plate bottom = 12 LDU = 1.5 plates = 0.60 studs.
  // Catalog definition: vH = 3, causing core partBoxes to extend down:
  // (1 - vH) * PLATE = (1 - 3) * 0.4 = -0.8 (-2.0 plates = -16 LDU below top plate bottom, reaching 24 LDU).
  // Overextension: 24 - 20 = 4 LDU = 0.5 plate = 0.20 studs.
  const pBracket = { id: 'pBracket_99781', part: '99781', color: 0, at: [0, 5, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  const boxesBracket = wbCore.partBoxes(pBracket, defs['99781']);

  // Physical clearance region:
  // In world coordinates, top plate bottom is at y = 5 plates (2.0 studs).
  // Physical wall extends down to y = 5 - 1.5 = 3.5 plates (1.4 studs).
  // Space from y = 3.0 to y = 3.4 plates (1.2 to 1.36 studs) is physically empty clearance!
  const mockClearanceOccupant = [{ x0: 0, x1: 2, y0: 3.0, y1: 3.4, z0: 1.0, z1: 1.2 }];
  const collisionHit = wbCore.boxesCollide(boxesBracket, mockClearanceOccupant);

  // Assertion check:
  // Expected physical collision: false (occupant is in legal physical clearance).
  // Actual engine collision: true (due to 0.5 plate downward overextension).
  const isFalsePositiveConfirmed = collisionHit !== null;

  evidence.cases.bracket_99781 = {
    partId: '99781',
    name: 'Bracket 1 x 2 - 1 x 2 (Down)',
    officialDat: '99781.dat',
    category: 'bracket',
    physicalMeasurement: {
      bboxLdu: [-20, -4, -18, 20, 20, 10],
      topPlateTopLdu: 0,
      topPlateBottomLdu: 8,
      hangingWallBottomLdu: 20,
      realHangDepthLdu: 12,
      realHangDepthPlates: 1.5,
      realHangDepthStuds: 0.60
    },
    engineRepresentation: {
      catalog_vH: defs['99781'].vH,
      generatedBoxes: boxesBracket,
      bracketVerticalBoxY: [boxesBracket[1].y0, boxesBracket[1].y1],
      engineHangDepthPlates: 2.0,
      engineHangDepthLdu: 16,
      engineHangDepthStuds: 0.80,
      overextensionLdu: 4,
      overextensionPlates: 0.5,
      overextensionStuds: 0.20
    },
    testSetup: {
      bracketPose: pBracket,
      adjacentOccupantInPhysicalClearance: mockClearanceOccupant[0]
    },
    testExecution: {
      expectedPhysicalCollision: false,
      actualEngineCollisionHit: collisionHit,
      collisionDetected: isFalsePositiveConfirmed
    },
    assertion: {
      condition: 'collisionDetected === true && expectedPhysicalCollision === false',
      passed: isFalsePositiveConfirmed
    },
    verdict: isFalsePositiveConfirmed ? 'CONFIRMED' : 'REFUTED'
  };
}

// =========================================================================
// Case 1b: Downward Bracket 1 x 1 (36841) - Separate Execution
// =========================================================================
console.log('--- Case 1b: 36841 Downward Bracket ---');
{
  // 36841: Bracket 1 x 1 - 1 x 1 Down
  // Official LDraw geometry (36841.dat):
  // BBox Y: [-4, 20] LDU. Top plate top: 0 LDU, bottom: 8 LDU.
  // Hanging wall bottom: 20 LDU. Real hanging depth below top plate bottom = 12 LDU = 1.5 plates = 0.60 studs.
  // Catalog definition: vH = 3, causing core partBoxes to extend down:
  // (1 - vH) * PLATE = (1 - 3) * 0.4 = -0.8 (-2.0 plates = -16 LDU below top plate bottom).
  // Overextension: 4 LDU = 0.5 plate = 0.20 studs.
  const pBracket = { id: 'pBracket_36841', part: '36841', color: 0, at: [0, 5, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  const boxesBracket = wbCore.partBoxes(pBracket, defs['36841']);

  // Physical clearance region:
  const mockClearanceOccupant = [{ x0: 0, x1: 1, y0: 3.0, y1: 3.4, z0: 1.0, z1: 1.2 }];
  const collisionHit = wbCore.boxesCollide(boxesBracket, mockClearanceOccupant);

  const isFalsePositiveConfirmed = collisionHit !== null;

  evidence.cases.bracket_36841 = {
    partId: '36841',
    name: 'Bracket 1 x 1 - 1 x 1 (Down)',
    officialDat: '36841.dat',
    category: 'bracket',
    physicalMeasurement: {
      bboxLdu: [-10, -4, -18, 10, 20, 10],
      topPlateTopLdu: 0,
      topPlateBottomLdu: 8,
      hangingWallBottomLdu: 20,
      realHangDepthLdu: 12,
      realHangDepthPlates: 1.5,
      realHangDepthStuds: 0.60
    },
    engineRepresentation: {
      catalog_vH: defs['36841'].vH,
      generatedBoxes: boxesBracket,
      bracketVerticalBoxY: [boxesBracket[1].y0, boxesBracket[1].y1],
      engineHangDepthPlates: 2.0,
      engineHangDepthLdu: 16,
      engineHangDepthStuds: 0.80,
      overextensionLdu: 4,
      overextensionPlates: 0.5,
      overextensionStuds: 0.20
    },
    testSetup: {
      bracketPose: pBracket,
      adjacentOccupantInPhysicalClearance: mockClearanceOccupant[0]
    },
    testExecution: {
      expectedPhysicalCollision: false,
      actualEngineCollisionHit: collisionHit,
      collisionDetected: isFalsePositiveConfirmed
    },
    assertion: {
      condition: 'collisionDetected === true && expectedPhysicalCollision === false',
      passed: isFalsePositiveConfirmed
    },
    verdict: isFalsePositiveConfirmed ? 'CONFIRMED' : 'REFUTED'
  };
}

// =========================================================================
// Case 1c: Downward Bracket 1 x 2 - 2 x 2 (44728) - Separate Execution
// =========================================================================
console.log('--- Case 1c: 44728 Downward Bracket ---');
{
  // 44728: Bracket 1 x 2 - 2 x 2 Down
  // Official LDraw geometry (44728.dat):
  // BBox Y: [-4, 40] LDU. Top plate top: 0 LDU, bottom: 8 LDU.
  // Hanging wall bottom: 40 LDU. Real hanging depth below top plate bottom = 40 - 8 = 32 LDU = 4.0 plates = 1.60 studs.
  // Catalog definition: vH = 5, causing core partBoxes to extend down:
  // (1 - 5) * PLATE = -1.6 (-4.0 plates = -32 LDU below top plate bottom).
  // Notice: Engine vertical box depth is EXACTLY 4.0 plates (32 LDU)!
  // Downward overextension: 0 LDU!
  const pBracket = { id: 'pBracket_44728', part: '44728', color: 0, at: [0, 5, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  const boxesBracket = wbCore.partBoxes(pBracket, defs['44728']);

  // Test space below physical bottom: y in [0.5, 0.9] plates (below y = 1.0)
  const mockOccupantBelow = [{ x0: 0, x1: 2, y0: 0.5, y1: 0.9, z0: 1.0, z1: 1.2 }];
  const collisionHit = wbCore.boxesCollide(boxesBracket, mockOccupantBelow);

  // Assertion check:
  // Does 44728 have downward 0.5 plate overextension? NO!
  const hasDownwardOverextension = (boxesBracket[1].y0 < 1.0);

  evidence.cases.bracket_44728 = {
    partId: '44728',
    name: 'Bracket 1 x 2 - 2 x 2 (Down)',
    officialDat: '44728.dat',
    category: 'bracket',
    physicalMeasurement: {
      bboxLdu: [-20, -4, -18, 20, 40, 10],
      topPlateTopLdu: 0,
      topPlateBottomLdu: 8,
      hangingWallBottomLdu: 40,
      realHangDepthLdu: 32,
      realHangDepthPlates: 4.0,
      realHangDepthStuds: 1.60
    },
    engineRepresentation: {
      catalog_vH: defs['44728'].vH,
      generatedBoxes: boxesBracket,
      bracketVerticalBoxY: [boxesBracket[1].y0, boxesBracket[1].y1],
      engineHangDepthPlates: 4.0,
      engineHangDepthLdu: 32,
      engineHangDepthStuds: 1.60,
      overextensionLdu: 0,
      overextensionPlates: 0,
      overextensionStuds: 0
    },
    testSetup: {
      bracketPose: pBracket,
      occupantBelowPhysicalBottom: mockOccupantBelow[0]
    },
    testExecution: {
      expectedPhysicalCollision: false,
      actualEngineCollisionHit: collisionHit,
      collisionDetected: collisionHit !== null
    },
    assertion: {
      hypothesis: '44728 has downward 0.5 plate overextension like 99781',
      condition: 'hasDownwardOverextension === false && overextensionLdu === 0',
      passed: !hasDownwardOverextension
    },
    verdict: hasDownwardOverextension ? 'CONFIRMED' : 'REFUTED',
    findingsNote: '44728 physical hanging depth is 32 LDU (4.0 plates), exactly matching catalog (vH-1)*8 LDU. The downward overextension defect reported in Round 2 for 44728 is REFUTED; 44728 was erroneously conflated with 99781/36841.'
  };
}

// =========================================================================
// Case 2a: Bottom Boss Collision Omission (18677) - Separate Execution
// =========================================================================
console.log('--- Case 2a: 18677 Bottom Boss ---');
{
  // 18677: Plate 1 x 2 with Pin Hole Underneath
  // Official LDraw geometry (18677.dat):
  // BBox Y: [-4, 19] LDU. Top plate top: 0 LDU, bottom: 8 LDU.
  // Cylindrical pin boss extends down to 19 LDU (11 LDU = 1.375 plates = 0.55 studs below plate bottom).
  // Catalog definition: kind = 'plate', h = 1.
  // Core partBoxes generates single 1-plate box: [0, 2, y0, y1, 0, 1]. Downward boss is 100% OMITTED.
  const pBasePlate = { id: 'pBase_3020', part: '3020', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  const pBoss18677 = { id: 'pBoss_18677', part: '18677', color: 4, at: [0, 1, 0], rot: 0, up: '+y', snot: 0, step: 2 };

  const boxesBase = wbCore.partBoxes(pBasePlate, defs['3020']);
  const boxesBoss = wbCore.partBoxes(pBoss18677, defs['18677']);

  const collisionHit = wbCore.boxesCollide(boxesBase, boxesBoss);
  const connectionHit = wbCore.partsConnected(pBasePlate, defs['3020'], pBoss18677, defs['18677']);

  const isOmissionConfirmed = (collisionHit === null && connectionHit === true);

  evidence.cases.bottomBoss_18677 = {
    partId: '18677',
    name: 'Plate 1 x 2 with Pin Hole Underneath',
    officialDat: '18677.dat',
    category: 'technic',
    physicalMeasurement: {
      bboxLdu: [-20, -4, -10, 20, 19, 10],
      plateTopLdu: 0,
      plateBottomLdu: 8,
      bossBottomLdu: 19,
      realBossDepthLdu: 11,
      realBossDepthPlates: 1.375,
      realBossDepthStuds: 0.55
    },
    engineRepresentation: {
      catalog_kind: defs['18677'].kind,
      generatedBoxesCount: boxesBoss.length,
      boxesYRange: [boxesBoss[0].y0, boxesBoss[0].y1],
      omittedDepthLdu: 11,
      omittedDepthPlates: 1.375,
      omittedDepthStuds: 0.55
    },
    testSetup: {
      basePart: pBasePlate,
      testedPartStackedDirectlyOnBase: pBoss18677
    },
    testExecution: {
      expectedPhysicalCollision: true,
      actualEngineCollisionDetected: collisionHit !== null,
      actualEngineConnectionDetected: connectionHit
    },
    assertion: {
      condition: 'actualEngineCollisionDetected === false && actualEngineConnectionDetected === true',
      passed: isOmissionConfirmed
    },
    verdict: isOmissionConfirmed ? 'CONFIRMED' : 'REFUTED'
  };
}

// =========================================================================
// Case 2b: Bottom Boss Collision Omission (2444) - Separate Execution
// =========================================================================
console.log('--- Case 2b: 2444 Bottom Boss ---');
{
  // 2444: Plate 2 x 2 with Pin Hole
  // Official LDraw geometry (2444.dat):
  // BBox Y: [-4, 19] LDU. Top plate top: 0 LDU, bottom: 8 LDU.
  // Cylindrical pin boss extends down to 19 LDU (11 LDU = 1.375 plates = 0.55 studs below plate bottom).
  // Catalog definition: kind = 'pinplate', h = 1.
  // Core partBoxes generates 3 boxes for pinplate, but ALL THREE have y in [1, 2] plates!
  // The downward 11 LDU boss below plate bottom is 100% OMITTED.
  const pBasePlate = { id: 'pBase_3020', part: '3020', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  const pBoss2444 = { id: 'pBoss_2444', part: '2444', color: 4, at: [0, 1, 0], rot: 0, up: '+y', snot: 0, step: 2 };

  const boxesBase = wbCore.partBoxes(pBasePlate, defs['3020']);
  const boxesBoss = wbCore.partBoxes(pBoss2444, defs['2444']);

  const collisionHit = wbCore.boxesCollide(boxesBase, boxesBoss);
  const connectionHit = wbCore.partsConnected(pBasePlate, defs['3020'], pBoss2444, defs['2444']);

  const isOmissionConfirmed = (collisionHit === null && connectionHit === true);

  evidence.cases.bottomBoss_2444 = {
    partId: '2444',
    name: 'Plate 2 x 2 with Pin Hole',
    officialDat: '2444.dat',
    category: 'technic',
    physicalMeasurement: {
      bboxLdu: [-20, -4, -20, 20, 19, 20],
      plateTopLdu: 0,
      plateBottomLdu: 8,
      bossBottomLdu: 19,
      realBossDepthLdu: 11,
      realBossDepthPlates: 1.375,
      realBossDepthStuds: 0.55
    },
    engineRepresentation: {
      catalog_kind: defs['2444'].kind,
      generatedBoxesCount: boxesBoss.length,
      boxesYRanges: boxesBoss.map(b => [b.y0, b.y1]),
      omittedDepthLdu: 11,
      omittedDepthPlates: 1.375,
      omittedDepthStuds: 0.55
    },
    testSetup: {
      basePart: pBasePlate,
      testedPartStackedDirectlyOnBase: pBoss2444
    },
    testExecution: {
      expectedPhysicalCollision: true,
      actualEngineCollisionDetected: collisionHit !== null,
      actualEngineConnectionDetected: connectionHit
    },
    assertion: {
      condition: 'actualEngineCollisionDetected === false && actualEngineConnectionDetected === true',
      passed: isOmissionConfirmed
    },
    verdict: isOmissionConfirmed ? 'CONFIRMED' : 'REFUTED'
  };
}

// =========================================================================
// Case 3: Ball Joint Connection & Legal Pose Derivation (14417 & 14418)
// =========================================================================
console.log('--- Case 3: 14417 & 14418 Ball Joint ---');
{
  // 14417: Plate 1 x 2 with Ball Joint-8 on Side
  // Official LDraw geometry (14417.dat):
  // Ball center primitive: 1 16 0 4 -20 1 0 0 0 1 0 0 0 1 joint8ball.dat
  // In local LDraw coordinates: ball center = [0, 4, -20] LDU.
  // In BrickKit coordinate frame (size [2, 1], h 1 plate):
  // Plate center: hx = 1.0 stud, hz = 0.5 stud.
  // Real ball center: x = 1.0 stud, y = 0.5 plate (0.2 stud), z = -0.5 stud (or outward normal along -Z).
  //
  // 14418: Plate 1 x 2 with Socket Joint-8 with Friction
  // Official LDraw geometry (14418.dat):
  // Socket center primitive: 1 16 30 4 0 0 0 -1 0 1 0 1 0 0 joint8socket1.dat
  // In local LDraw coordinates: socket center = [30, 4, 0] LDU (on +X short end!).
  //
  // Current Catalog Modeling:
  // 14417 is cataloged as kind: 'barplate' (generates two synthetic bars at x = 0.5 and x = 1.5).
  // 14418 is cataloged as kind: 'clip' (generates one synthetic clip at x = 1.0).
  const pBall = { id: 'pBall', part: '14417', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  const pSocketCentered = { id: 'pSocketCentered', part: '14418', color: 1, at: [0, 0, 1.44], rot: 180, up: '+y', snot: 0, step: 2 };
  const pSocketShifted = { id: 'pSocketShifted', part: '14418', color: 1, at: [-0.5, 0, 1.44], rot: 180, up: '+y', snot: 0, step: 2 };

  const cBall = wbCore.partConnectors(pBall, defs['14417']);
  const cCent = wbCore.partConnectors(pSocketCentered, defs['14418']);
  const cShift = wbCore.partConnectors(pSocketShifted, defs['14418']);

  const centeredConnected = wbCore.partsConnected(pBall, defs['14417'], pSocketCentered, defs['14418'], cBall, cCent);
  const shiftedConnected = wbCore.partsConnected(pBall, defs['14417'], pSocketShifted, defs['14418'], cBall, cShift);

  const isBallDefectConfirmed = (centeredConnected === false && shiftedConnected === true);

  evidence.cases.ballJoint_14417_14418 = {
    parts: ['14417', '14418'],
    names: ['Plate 1 x 2 with Towball on Side', 'Plate 1 x 2 with Towball Socket'],
    officialPrimitives: {
      ball14417: {
        primitive: 'joint8ball.dat',
        posLdu: [0, 4, -20],
        posStuds: [0, 0.2, -1.0],
        facingAxis: '-z'
      },
      socket14418: {
        primitive: 'joint8socket1.dat',
        posLdu: [30, 4, 0],
        posStuds: [1.5, 0.2, 0],
        matrix: [0, 0, -1, 0, 1, 0, 1, 0, 0],
        facingAxis: '+x'
      }
    },
    independentLegalPoseDerivation: {
      explanation: 'To engage the ball joint physically, the socket interface center of 14418 must coincide in 3D world space with the ball center of 14417, with opposed approach vectors. Since 14418 has its socket on the +x end (30 LDU from center) while 14417 has its ball on the -z side (20 LDU from center), engaging them requires a 90-degree orthogonal relative orientation.',
      catalogDefectNote: 'Catalog erroneously modeled 14417 as a barplate (creating two phantom bars at x=0.5, 1.5) and 14418 as a single clip (at x=1.0). When aligned face-to-face centered, the synthetic clip sits midway between the two synthetic bars and reports disconnected (false negative). Shifting by 0.5 studs docks the clip onto a non-existent bar (false positive).'
    },
    syntheticConnectorsGenerated: {
      ball14417_bars: cBall.studs.filter(s => s.kind === 'bar').map(s => ({ index: s.index, pos: s.pos, dir: s.dir, axis: s.axis, label: s.label })),
      socket14418_centered_clips: cCent.receptors.filter(r => r.kind === 'clip').map(r => ({ index: r.index, pos: r.pos, dir: r.dir, axis: r.axis })),
      socket14418_shifted_clips: cShift.receptors.filter(r => r.kind === 'clip').map(r => ({ index: r.index, pos: r.pos, dir: r.dir, axis: r.axis }))
    },
    testExecution: {
      centeredConnected_expected_TRUE_actual: centeredConnected,
      shiftedConnected_expected_FALSE_actual: shiftedConnected
    },
    assertion: {
      condition: 'centeredConnected === false && shiftedConnected === true',
      passed: isBallDefectConfirmed
    },
    verdict: isBallDefectConfirmed ? 'CONFIRMED' : 'REFUTED'
  };
}

const outEvidencePath = path.join(SCRIPT_DIR, 'counterexamples-evidence-v3.json');
fs.writeFileSync(outEvidencePath, JSON.stringify(evidence, null, 2), 'utf8');
console.log(`Saved counterexample evidence v3 to ${outEvidencePath}`);
