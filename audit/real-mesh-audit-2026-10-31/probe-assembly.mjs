// Probe to test physical assemblability, snap, and collision on priority parts
import {
  mergeCatalogParts, partConnectors, partBoxes, partsConnected,
  snapPart, validate, boxesCollide
} from '../../src/core/core.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CUR = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'), 'utf8')).parts;
const EXT = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts-ldraw.json'), 'utf8')).parts;
const cat = { parts: mergeCatalogParts(EXT, CUR), colors: {} };

console.log('=== TEST 1: Bar 30374 into Clip 11476 & 15712 ===');
{
  const pClip = { id: 'c1', part: '11476', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  const pBar = { id: 'b1', part: '30374', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  const defClip = cat.parts['11476'];
  const defBar = cat.parts['30374'];

  console.log('11476 receptors:', partConnectors(pClip, defClip).receptors);
  console.log('30374 studs:', partConnectors(pBar, defBar).studs.slice(0, 3));

  // Try snapping bar onto clip: clip receptor 2 is the clip, bar stud 0 is the bar
  try {
    const snapRes = snapPart(pClip, defClip, 2, pBar, defBar, 0, { under: true });
    console.log('Snap 30374 (stud 0) onto 11476 (receptor 2):', snapRes);
    console.log('partsConnected after snap:', partsConnected(pClip, defClip, snapRes, defBar));
  } catch (e) {
    console.log('Snap 30374 onto 11476 threw:', e.message);
  }
}

console.log('\n=== TEST 2: Downward Bracket 99781 & 44728 on Plate 3020 ===');
{
  const plate = { id: 'base', part: '3020', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  const bracket = { id: 'brk', part: '99781', color: 0, at: [0, 1, 0], rot: 0, up: '+y', snot: 0, step: 2 };
  const defPlate = cat.parts['3020'];
  const defBrk = cat.parts['99781'];

  console.log('Bracket 99781 snap onto 3020 stud 0:');
  try {
    const snapped = snapPart(plate, defPlate, 0, bracket, defBrk, 0);
    console.log('Snapped bracket pose:', snapped);
    console.log('partsConnected:', partsConnected(plate, defPlate, snapped, defBrk));
    const boxPlate = partBoxes(plate, defPlate);
    const boxBrk = partBoxes(snapped, defBrk);
    console.log('Collision between base plate (at y=0) and bracket:', boxesCollide(boxPlate, boxBrk));
  } catch (e) {
    console.log('Snap bracket threw:', e.message);
  }
}

console.log('\n=== TEST 3: Ball joint 14417 and socket 14418 ===');
{
  const pBall = { id: 'ball', part: '14417', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  const pSocket = { id: 'sock', part: '14418', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  const defBall = cat.parts['14417'];
  const defSocket = cat.parts['14418'];

  console.log('14417 studs:', partConnectors(pBall, defBall).studs);
  console.log('14418 receptors:', partConnectors(pSocket, defSocket).receptors);

  // Try snapping socket onto ball
  try {
    const snapRes = snapPart(pBall, defBall, 2, pSocket, defSocket, 2);
    console.log('Snap 14418 onto 14417:', snapRes);
    console.log('partsConnected after snap:', partsConnected(pBall, defBall, snapRes, defSocket));
  } catch (e) {
    console.log('Snap 14418 onto 14417 threw:', e.message);
  }
}

console.log('\n=== TEST 4: Technic Pin 4274 into Technic Brick 3700 ===');
{
  const pBrick = { id: 'tb', part: '3700', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  const pPin = { id: 'pin', part: '4274', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  const defBrick = cat.parts['3700'];
  const defPin = cat.parts['4274'];

  console.log('3700 receptors:', partConnectors(pBrick, defBrick).receptors);
  console.log('4274 studs:', partConnectors(pPin, defPin).studs);

  // Can pin snap into hole?
  try {
    const snapRes = snapPart(pBrick, defBrick, 0, pPin, defPin, 1, { under: true });
    console.log('Snap pin into brick hole:', snapRes);
    console.log('partsConnected:', partsConnected(pBrick, defBrick, snapRes, defPin));
  } catch (e) {
    console.log('Snap pin threw:', e.message);
  }
}

console.log('\n=== TEST 5: Bush 584 on Axle ===');
{
  const pBush = { id: 'bush', part: '584', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  const defBush = cat.parts['584'];
  console.log('584 receptors:', partConnectors(pBush, defBush).receptors);
}
