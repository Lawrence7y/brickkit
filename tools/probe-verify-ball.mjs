
import fs from 'node:fs';
const { partConnectors, mergeCatalogParts } = await import('../src/core/core.js');
const rd=(p)=>JSON.parse(fs.readFileSync(p,'utf8'));
const EXT=rd('catalog/parts-ldraw.json').parts, CUR=rd('catalog/parts.json').parts;
const M=mergeCatalogParts(EXT,CUR);
const closeC=(a,b)=>Math.abs(a[0]-b[0])<=0.08&&Math.abs(a[1]-b[1])<=0.20&&Math.abs(a[2]-b[2])<=0.08;

for (const id of ['14417','14418']) {
  const d=M[id];
  const c=partConnectors({id:'x',part:id,at:[0,0,0],rot:0,up:'+y'}, d);
  const bars=c.studs.filter(s=>s.kind==='bar');
  const clips=c.receptors.filter(r=>r.kind==='clip');
  const balls=c.studs.filter(s=>s.kind==='ball');
  const socks=c.receptors.filter(r=>r.kind==='socket');
  console.log(id,'kind='+d.kind,'| bars='+bars.length,'clips='+clips.length,'balls='+balls.length,'sockets='+socks.length);
  balls.forEach(b=>console.log('    ball  pos',JSON.stringify(b.pos.map(v=>+v.toFixed(3)))));
  socks.forEach(b=>console.log('    socket pos',JSON.stringify(b.pos.map(v=>+v.toFixed(3)))));
}

const a=M['14417'], b=M['14418'];
const ball=partConnectors({id:'a',part:'14417',at:[0,0,0],rot:0,up:'+y'},a).studs.find(s=>s.kind==='ball');
const sock=partConnectors({id:'b',part:'14418',at:[0,0,0],rot:0,up:'+y'},b).receptors.find(s=>s.kind==='socket');
if(!ball||!sock){ console.log('MISSING ball/socket'); }
else {
  const at=[0,1,2].map(i=>+(sock.pos[i]-ball.pos[i]).toFixed(3));
  const c1=partConnectors({id:'b',part:'14418',at:[0,0,0],rot:0},b);
  const c2=partConnectors({id:'a',part:'14417',at,rot:0},a);
  let hit=0;
  for(const s of c2.studs) for(const r of c1.receptors) if(s.kind==='ball'&&r.kind==='socket'&&closeC(s.pos,r.pos)) hit++;
  console.log('mate placement at='+JSON.stringify(at)+'  ball<->socket pairs='+hit);
}
