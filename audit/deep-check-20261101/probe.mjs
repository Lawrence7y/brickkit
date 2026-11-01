import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as core from '../../src/core/core.js';
import { buildDefinition, readRawCatalog } from '../../src/core/assets-v1/index.js';
import { inspectFromModel } from '../../src/core/actions-v1/state.js';
import { enumerateCandidates } from '../../src/core/actions-v1/candidates.js';
import { buildPart } from '../../src/ldraw/loader.mjs';
import * as esbuild from 'esbuild';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const rd = p => JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const cur=rd('catalog/parts.json').parts, ext=rd('catalog/parts-ldraw.json').parts;
const cat={parts:core.mergeCatalogParts(ext,cur),colors:rd('catalog/colors.json').colors};
const p=(id,part,at=[0,0,0],extra={})=>({id,part,color:0,at,rot:0,up:'+y',step:1,...extra});
const model=parts=>({format:'brickbuild',version:'0.2',meta:{name:'audit'},parts});
const tracked=['src/core/core.js','catalog/parts.json','catalog/parts-ldraw.json','src/core/assets-v1/index.js','src/core/assets-v1/ids.js','src/core/actions-v1/state.js','dist/viewer.html'];
const hashes=()=>Object.fromEntries(tracked.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')]));
const result={root,startedAt:new Date().toISOString(),before:hashes(),cases:{}};
const cases=result.cases;
for(const id of ['14417','14418']){
 const c=core.partConnectors(p('p',id),cat.parts[id]);
 const d=buildDefinition(id,cat.parts[id],{sourceType:'curated'});
 cases['ball-'+id]={connectors:c,assetTypes:d.connectorGroups.map(g=>g.t),assetWarnings:d._buildWarnings};
}
const ballPart=p('ball','14417');
const ball=core.partConnectors(ballPart,cat.parts['14417']).studs.find(s=>s.kind==='ball');
const fakePlate=core.snapPart(ballPart,cat.parts['14417'],ball.index,p('plate','3024',undefined,{up:ball.dir}),cat.parts['3024'],0);
const plateConn=core.partConnectors(fakePlate,cat.parts['3024']).receptors[0];
cases.ballToAntistud={ball,plateConn,snap:fakePlate,matched:core.connectorPairMatches(ball,plateConn),connected:core.partsConnected(ballPart,cat.parts['14417'],fakePlate,cat.parts['3024']),validation:core.validate(model([ballPart,fakePlate]),cat)};
const socket=core.partConnectors(p('socket','14418'),cat.parts['14418']).receptors.find(r=>r.kind==='socket');
const socketPart=core.snapPart(ballPart,cat.parts['14417'],ball.index,p('socket','14418'),cat.parts['14418'],socket.index);
cases.ballState={socketPart,connected:core.partsConnected(ballPart,cat.parts['14417'],socketPart,cat.parts['14418']),state:inspectFromModel(model([ballPart,socketPart]),cat).state};
const single=inspectFromModel(model([ballPart]),cat).state;
cases.ballCandidates=Object.fromEntries(['14418','3024'].map(childPartId=>[childPartId,enumerateCandidates(single,{childPartId,parentNodeId:'ball',parentConnectorIds:[`cball#${ball.index}`],maxResults:100},cat)]));
for(const id of ['99781','36841']){
 const boxes=core.partBoxes(p('bracket',id,[0,5,0]),cat.parts[id]);
 const mesh=buildPart({partId:id,color:0,def:cat.parts[id]});
 const bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
 for(const vertices of Object.values(mesh.groups))for(let i=0;i<vertices.length;i++){
  bounds.min[i%3]=Math.min(bounds.min[i%3],vertices[i]);bounds.max[i%3]=Math.max(bounds.max[i%3],vertices[i]);
 }
 cases['bracket-'+id]={boxes,clearanceCollision:core.boxesCollide(boxes,[{x0:0,x1:1,y0:3,y1:3.4,z0:1,z1:1.2}]),meshLocalBoundsStuds:bounds,meshBottomWorldPlates:5+bounds.min[1]/core.PLATE,meshStats:mesh.stats,meshNotes:mesh.notes};
}
const raw=readRawCatalog(root);
for(const id of ['48336','63868','60478']) {
 const a=core.partConnectors(p('p',id),cat.parts[id]);
 const b=core.partConnectors(p('p',id),raw.merged[id].def);
 cases['catalog-'+id]={cli:a,assetInput:b,same:JSON.stringify(a)===JSON.stringify(b)};
}
const wheelModel=rd('examples/60239.fixed.brick.json');
let pair;
for(const a of wheelModel.parts)for(const b of wheelModel.parts){
 if(cat.parts[a.part]?.wheel?.role==='rim'&&cat.parts[b.part]?.wheel?.role==='tyre'&&core.partsConnected(a,cat.parts[a.part],b,cat.parts[b.part])){pair=[a,b];break;}
 if(pair)break;
}
if(pair){
 const [a,b]=pair, tyre=structuredClone(b), c=core.partConnectors(b,cat.parts[b.part]).receptors.find(r=>r.kind==='tyre');
 tyre.at[{x:0,y:1,z:2}[c.axis]]+=100;
 cases.remoteTyre={rim:a,tyre,axis:c.axis,connected:core.partsConnected(a,cat.parts[a.part],tyre,cat.parts[tyre.part]),state:inspectFromModel(model([a,tyre]),cat).state,validation:core.validate(model([a,tyre]),cat)};
}
for(const name of ['cottage','mecha','lantern.reconstructed.v9']){
 const m=rd('examples/'+name+'.brick.json');
 const r=core.validate(m,cat);
 cases['model-'+name]={ok:r.ok,errors:r.errors,warnings:r.warnings,stats:r.stats};
}
cases.door={definition:cat.parts['60623'],boxes:core.partBoxes(p('door','60623'),cat.parts['60623'])};
const built=await esbuild.build({entryPoints:[path.join(root,'src/viewer/main.js')],bundle:true,minify:true,format:'iife',write:false,target:'es2020',loader:{'.json':'json'},legalComments:'none'});
const js=built.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
const html=fs.readFileSync(path.join(root,'src/viewer/template.html'),'utf8').replace('/*CSS*/',()=>fs.readFileSync(path.join(root,'src/viewer/style.css'),'utf8')).replace('//JS',()=>js);
cases.build={inMemory:true,matchesDist:html===fs.readFileSync(path.join(root,'dist/viewer.html'),'utf8'),builtHash:crypto.createHash('sha256').update(html).digest('hex')};
const wb='D:/Project/brickkit-workbench';
if(fs.existsSync(wb)){
 const wc=await import(pathToFileURL(path.join(wb,'src/core/core.js')));
 const wr=f=>JSON.parse(fs.readFileSync(path.join(wb,f),'utf8'));
 const wd=wc.mergeCatalogParts(wr('catalog/parts-ldraw.json').parts,wr('catalog/parts.json').parts);
 cases.workbench={coreHash:crypto.createHash('sha256').update(fs.readFileSync(path.join(wb,'src/core/core.js'))).digest('hex'),parts:Object.fromEntries(['14417','14418','99781','36841'].map(id=>[id,{def:wd[id],boxes:wc.partBoxes(p('p',id,[0,5,0]),wd[id]),connectors:wc.partConnectors(p('p',id),wd[id])}]))};
}
result.after=hashes();result.inputsStable=JSON.stringify(result.before)===JSON.stringify(result.after);
fs.writeFileSync(new URL('evidence.json',import.meta.url),JSON.stringify(result,null,2));
console.log(JSON.stringify({inputsStable:result.inputsStable,cases:Object.keys(cases),ballToAntistud:cases.ballToAntistud.matched,ballValidation:cases.ballToAntistud.validation,ballState:cases.ballState.state.connections,remoteTyre:cases.remoteTyre&&{connected:cases.remoteTyre.connected,validation:cases.remoteTyre.validation},brackets:['99781','36841'].map(id=>cases['bracket-'+id])},null,2));
