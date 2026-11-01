// Audit tiles and parts without top studs
import { auditPart } from './probe-deep.mjs';
import fs from 'node:fs';

const tilesAndNoStuds = [
  '2431', '3068b', '3069b', '3070b', '2412b', '22385', '26603',
  '4150', '4162', '63864', '6636', '69729', '87079', '98138',
  '11477', '15068', '54200', '85984', '93273', '61678', '3633'
];

console.log('Auditing', tilesAndNoStuds.length, 'no-stud / tile parts...');
const results = [];
for (const id of tilesAndNoStuds) {
  const r = auditPart(id);
  results.push({
    partId: id,
    title: r.title,
    kind: r.mergedDef.kind,
    size: r.mergedDef.size,
    h: r.mergedDef.h,
    curOrigin: r.curDef?.ldrawOrigin,
    extOrigin: r.extDef?.ldrawOrigin,
    bboxLdu: r.bboxLdu,
    coreConn: {
      studs: r.coreConn.studsCount,
      receptors: r.coreConn.receptorsCount
    },
    coreBoxes: r.coreBoxes.boxes
  });
}

console.log(JSON.stringify(results, null, 2));
