
import fs from 'node:fs';
const { validate, mergeCatalogParts } = await import('../src/core/core.js');
const rd=(p)=>JSON.parse(fs.readFileSync(p,'utf8'));
const CAT={parts:mergeCatalogParts(rd('catalog/parts-ldraw.json').parts, rd('catalog/parts.json').parts), colors:rd('catalog/colors.json').colors};
for (const f of ['examples/cottage.brick.json','examples/mecha.brick.json','examples/lantern.reconstructed.v4.brick.json']) {
  try {
    const m=rd(f); const r=validate(m,CAT);
    const codes=(r.errors||[]).map(e=>e.code); const w=(r.warnings||[]).map(e=>e.code);
    const c={}; for(const x of codes) c[x]=(c[x]||0)+1;
    console.log(f.split('/').pop().padEnd(38), 'E='+codes.length, 'W='+w.length, JSON.stringify(c));
  } catch(e){ console.log(f, 'THREW', String(e.message).slice(0,80)); }
}
