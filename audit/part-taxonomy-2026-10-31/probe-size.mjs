// 逐件核对「精选 vs 扩充 vs 官方 .dat 主体盒」的三方尺寸，定位谁是错的。
// 只读：不写 catalog/。
import fs from 'node:fs';
import path from 'node:path';
import { bboxFromText, connectorInstancesFromText, refCandidates, OFFICIAL_ALIASES, STUD_PRIMITIVES, PIN_PRIMITIVES, BAR_PRIMITIVES, CLIP_PRIMITIVES, PROTRUSION_PRIMITIVES, WPIN_PRIMITIVES } from '../../src/ldraw/ldraw.js';

import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cache = new Map();
function readLib(raw) {
  const key = String(raw).toLowerCase();
  if (cache.has(key)) return cache.get(key);
  let text = null;
  for (const rel of refCandidates(key)) {
    for (const root of ['catalog/ldraw', 'catalog/ldraw-full']) {
      const abs = path.join(ROOT, root, rel);
      if (fs.existsSync(abs)) { text = fs.readFileSync(abs, 'utf8'); break; }
    }
    if (text) break;
  }
  cache.set(key, text);
  return text;
}
function bodyBox(text) {
  const inst = connectorInstancesFromText(text, readLib);
  const anchors = inst.filter((c) => PIN_PRIMITIVES.has(c.prim) || WPIN_PRIMITIVES.has(c.prim) || BAR_PRIMITIVES.has(c.prim) || CLIP_PRIMITIVES.has(c.prim)).map((c) => c.pos);
  const near = (pos) => anchors.some((a) => (a[0] - pos[0]) ** 2 + (a[1] - pos[1]) ** 2 + (a[2] - pos[2]) ** 2 < 196);
  const full = bboxFromText(text, readLib);
  const body = bboxFromText(text, readLib, {
    skipInstance: (base, MM, pos) => PROTRUSION_PRIMITIVES.has(base)
      || (STUD_PRIMITIVES.has(base) && Math.abs(MM[1][1]) < 0.3)
      || (/^(\d+-\d+(-\d+)?)?cyl/i.test(base) && pos && near(pos)),
  });
  return body || full;
}
const cu = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'), 'utf8')).parts;
const ex = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts-ldraw.json'), 'utf8')).parts;
const ids = process.argv.slice(2);
for (const id of ids) {
  const c = cu[id], e = ex[id];
  const off = OFFICIAL_ALIASES[id] || id;
  const text = readLib(`${off}.dat`);
  const box = text ? bodyBox(text) : null;
  const meas = box ? { x: +(box.max[0] - box.min[0]).toFixed(1), y: +(box.max[1] - box.min[1]).toFixed(1), z: +(box.max[2] - box.min[2]).toFixed(1) } : null;
  const studs = meas ? Math.round(meas.x / 20) : null, studsZ = meas ? Math.round(meas.z / 20) : null;
  console.log(id, 'curated', c ? `${c.size} h${c.h}` : '-', '| ext', e ? `${e.size} h${e.h}` : '-', '| dat', meas ? `${meas.x}x${meas.y}x${meas.z}LDU => ${studs}x${studsZ} h${Math.round(meas.y / 8)}` : 'none');
}
