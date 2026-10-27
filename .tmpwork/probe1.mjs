import fs from 'node:fs';
import { partConnectors, partBoxes, boxesCollide, snapPart, partsConnected } from '../src/core/core.js';
const rd = (f) => JSON.parse(fs.readFileSync(new URL(`../${f}`, import.meta.url),'utf8'));
const ext = fs.existsSync(new URL('../catalog/parts-ldraw.json', import.meta.url)) ? rd('catalog/parts-ldraw.json').parts : {};
const cat = { parts: { ...ext, ...rd('catalog/parts.json').parts }, colors: rd('catalog/colors.json').colors };
const m = rd('examples/mecha.brick.json');
const byId = Object.fromEntries(m.parts.map(p=>[p.id,p]));
const P = byId.p13;
const pc = partConnectors(P, cat.parts['11211']);
console.log('p13 studs', pc.studs.map(s=>[s.index,s.kind,s.label,JSON.stringify(s.pos), s.dir]));
const probe = { id:'x', part:'3022', color:0, at:[0,0,0], up:'+z', rot:0 };
const cc = partConnectors(probe, cat.parts['3022']);
console.log('3022 up+z receptors', cc.receptors.map(r=>[r.index,r.kind,JSON.stringify(r.pos),r.dir]));
for (let s=0;s<pc.studs.length;s++) for (let r=0;r<cc.receptors.length;r++){
  try { const c = snapPart(P, cat.parts['11211'], s, {id:'x',part:'3022',color:0,rot:0}, cat.parts['3022'], r);
    console.log('snap s',s,'r',r,'->',JSON.stringify(c.at), c.up, c.rot, 'snot', c.snot);
  } catch(e){ console.log('snap s',s,'r',r,'ERR',e.message.slice(0,80)); }
}
