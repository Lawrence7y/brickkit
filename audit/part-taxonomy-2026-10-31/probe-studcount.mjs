// 对同名重复身份簇，数官方 .dat 的 STUD/ANTISTUD 图元实例，判断哪一条数量对。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectorInstancesFromText, refCandidates, STUD_PRIMITIVES, ANTISTUD_PRIMITIVES } from '../../src/ldraw/ldraw.js';

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
const inv = JSON.parse(fs.readFileSync(path.join(ROOT, 'audit/part-taxonomy-2026-10-31/inventory.json'), 'utf8'));
const byId = new Map(inv.parts.map((p) => [p.id, p]));
for (const id of process.argv.slice(2)) {
  const text = readLib(`${id}.dat`);
  if (!text) { console.log(id, 'NO DAT'); continue; }
  const inst = connectorInstancesFromText(text, readLib);
  const studs = inst.filter((c) => STUD_PRIMITIVES.has(c.prim));
  const up = studs.filter((c) => c.yUp > 0.7);
  const anti = inst.filter((c) => ANTISTUD_PRIMITIVES.has(c.prim) && c.yUp < -0.7);
  const p = byId.get(id) || {};
  console.log(id.padEnd(8), 'official studInst=' + studs.length, 'up=' + up.length, 'anti=' + anti.length,
    '| catalog studs=' + (p.connectors?.studs ?? '?'), 'recs=' + (p.connectors?.receptors ?? '?'), '|', p.name);
}
