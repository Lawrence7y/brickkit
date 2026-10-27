import fs from 'node:fs';
import { partConnectors, partsConnected, validate } from '../src/core/core.js';
const rd = (f) => JSON.parse(fs.readFileSync(new URL(`../${f}`, import.meta.url),'utf8'));
const ext = rd('catalog/parts-ldraw.json').parts;
const oldcat = { parts: { ...ext, ...rd('out/parts-base.json').parts }, colors: rd('catalog/colors.json').colors };
const m = rd('examples/mecha.brick.json');
const byId = Object.fromEntries(m.parts.map(p=>[p.id,p]));
for (const p of m.parts) {
  if (!p.mount) continue;
  const q = byId[p.mount];
  const ok = partsConnected(p, oldcat.parts[p.part], q, oldcat.parts[q.part]);
  console.log(p.id, '<-', p.mount, ok ? 'OK' : 'FAIL');
}
const v = validate(m, oldcat);
console.log('old-cat validate', v.ok, 'E', v.errors.length, 'W', v.warnings.length);
