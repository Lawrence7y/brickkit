import fs from 'node:fs';
import { partBoxes, partConnectors, partsConnected, partCenter } from '../src/core/core.js';
const rd = (f) => JSON.parse(fs.readFileSync(new URL(`../${f}`, import.meta.url),'utf8'));
const ext = fs.existsSync(new URL('../catalog/parts-ldraw.json', import.meta.url)) ? rd('catalog/parts-ldraw.json').parts : {};
const cat = { parts: { ...ext, ...rd('catalog/parts.json').parts }, colors: rd('catalog/colors.json').colors };
const m = rd('examples/mecha.brick.json');
for (const p of m.parts) {
  const def = cat.parts[p.part];
  const bs = partBoxes(p, def);
  const c = partConnectors(p, def);
  console.log(`${p.id} ${p.part} ${def.zh} at=${JSON.stringify(p.at)} up=${p.up||'+y'} rot=${p.rot||0} snot=${p.snot??0} step=${p.step} mount=${p.mount||'-'}`);
  console.log(`   boxes=${JSON.stringify(bs.map(b=>[b.x0,b.x1,b.y0,b.y1,b.z0,b.z1]))}`);
  console.log(`   studs=${c.studs.length} ${JSON.stringify(c.studs.map(s=>[s.kind,s.label,s.pos,s.dir,s.axis].filter(x=>x!==undefined)))}`);
  console.log(`   recs=${c.receptors.length} ${JSON.stringify(c.receptors.map(r=>[r.kind,r.pos,r.dir,r.axis].filter(x=>x!==undefined)))}`);
}
