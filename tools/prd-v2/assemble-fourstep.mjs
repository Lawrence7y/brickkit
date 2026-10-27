// 四步工作流 · 总装（主会话，PRD §8 第 4 步）
// 用 core.transformAssembly3D 对 SA-1 / SA-2 做刚体正交变换后合并进主体模型。
import fs from 'node:fs';
import { transformAssembly3D, validate, partBoxes, partsCollide, partConnectors } from '../../src/core/core.js';

const ROOT = 'D:/Project/brickkit';
const DIR = `${ROOT}/out/prd-v2/run-20261026-c/C/integration/fourstep`;
const catalog = JSON.parse(fs.readFileSync(`${ROOT}/catalog/parts.json`, 'utf8'));
const main = JSON.parse(fs.readFileSync(`${DIR}/build/main.brick.json`, 'utf8'));
const sa1 = JSON.parse(fs.readFileSync(`${DIR}/build/SA-1.brick.json`, 'utf8'));
const sa2 = JSON.parse(fs.readFileSync(`${DIR}/build/SA-2.brick.json`, 'utf8'));

const byId = (m, id) => m.parts.find((p) => p.id === id);
const jibHost = byId(main, 'p022');
const cabHost = byId(main, 'p025');
console.log('jibHost', jibHost.part, JSON.stringify(jibHost.at), '| cabHost', cabHost.part, JSON.stringify(cabHost.at));

const sa1Members = sa1.parts.map((p) => ({ p, def: catalog.parts[p.part] }));
const sa2Members = sa2.parts.map((p) => ({ p, def: catalog.parts[p.part] }));

// 自动搜索：SA-1 走 SNOT 侧凸点（起重臂通常侧挂于塔顶），
// SA-2 允许正立在任意顶凸点（司机舱可立于底座/平台）。
const searchMounts = (members, anchorId, rotPref, hosts) => {
  const found = [];
  for (const host of hosts) {
    const conn = partConnectors(host, catalog.parts[host.part]);
    const studs = conn.studs.map((s, i) => ({ s, i }));
    for (const { s, i } of studs) {
      for (const deg of rotPref) {
        const res = transformAssembly3D(members, host, catalog.parts[host.part], i, anchorId, 0, deg);
        if (!res) continue;
        let hits = 0;
        for (const q of res) {
          if (q.id === anchorId) continue;
          const qb = partBoxes(q, catalog.parts[q.part]);
          for (const o of main.parts) {
            if (o.id === host.id) continue;
            if (partsCollide(q, catalog.parts[q.part], qb, o, catalog.parts[o.part], partBoxes(o, catalog.parts[o.part]))) hits++;
          }
          if (partsCollide(q, catalog.parts[q.part], qb, host, catalog.parts[host.part], partBoxes(host, catalog.parts[host.part]))) hits++;
        }
        if (hits === 0) found.push({ host: host.id, stud: i, rot: deg, placed: res });
      }
    }
  }
  return found;
};

const snotHosts = main.parts.filter((p) => p.part === '11211');
const anyHosts = main.parts;
const jibCandidates = searchMounts(sa1Members, 'jib-root-1', [180, 90, 0, 270], snotHosts);
const cabCandidates = searchMounts(sa2Members, 'cab-floor-left', [0, 90, 180, 270], anyHosts);
console.log(`SA-1 clean candidates: ${jibCandidates.length}`, jibCandidates.slice(0, 3).map((c) => `${c.host}#${c.stud}@${c.rot}`).join(' '));
console.log(`SA-2 clean candidates: ${cabCandidates.length}`, cabCandidates.slice(0, 3).map((c) => `${c.host}#${c.stud}@${c.rot}`).join(' '));

if (!jibCandidates.length || !cabCandidates.length) {
  fs.writeFileSync(`${DIR}/build/assemble-report.json`, JSON.stringify({ jibCandidates: jibCandidates.length, cabCandidates: cabCandidates.length }, null, 2));
  console.log('FAIL: 无零穿模挂装组合');
  process.exit(1);
}

// 联合选型：SA-1 与 SA-2 各自零穿模主体且互不穿模
const crossClean = (A, B) => {
  for (const a of A) {
    const ab = partBoxes(a, catalog.parts[a.part]);
    for (const c of B) {
      if (partsCollide(a, catalog.parts[a.part], ab, c, catalog.parts[c.part], partBoxes(c, catalog.parts[c.part]))) return false;
    }
  }
  return true;
};
// 端到端判定：候选组 vs 全部主件（排除自身 host）
const cleanAgainstMain = (placed, hostId, anchorId) => {
  for (const q of placed) {
    const qb = partBoxes(q, catalog.parts[q.part]);
    for (const o of main.parts) {
      if (o.id === hostId) continue;
      if (partsCollide(q, catalog.parts[q.part], qb, o, catalog.parts[o.part], partBoxes(o, catalog.parts[o.part]))) return `${q.id} × main:${o.id}`;
    }
  }
  return null;
};
let best = null, firstFail = null;
for (const jc of jibCandidates) {
  for (const cc of cabCandidates) {
    if (jc.host === cc.host) continue;
    const jf = cleanAgainstMain(jc.placed, jc.host, 'jib-root-1');
    if (jf) { firstFail = firstFail || `jib ${jf}`; continue; }
    const cf = cleanAgainstMain(cc.placed, cc.host, 'cab-floor-left');
    if (cf) { firstFail = firstFail || `cab ${cf}`; continue; }
    if (!crossClean(jc.placed, cc.placed)) { firstFail = firstFail || 'jib×cab'; continue; }
    best = { jib: jc, cab: cc };
    break;
  }
  if (best) break;
}
if (!best) {
  fs.writeFileSync(`${DIR}/build/assemble-report.json`, JSON.stringify({ jibCandidates: jibCandidates.length, cabCandidates: cabCandidates.length, joint: 'no clean pair', firstFail }, null, 2));
  console.log('FAIL: 无联合零穿模组合', firstFail);
  process.exit(1);
}
const jibResult = { ok: true, ...best.jib };
const cabResult = { ok: true, ...best.cab };
console.log(`联合选型: SA-1 ${jibResult.host}#${jibResult.stud}@${jibResult.rot} | SA-2 ${cabResult.host}#${cabResult.stud}@${cabResult.rot}`);

const prefix = (parts, pre) => parts.map((p) => ({
  ...p,
  id: `${pre}:${p.id}`,
  // mount 指向组内父件时同步加前缀；指向主体（p###）时保持不变
  ...(p.mount && !/^p\d+$/.test(p.mount) ? { mount: `${pre}:${p.mount}` } : {}),
}));

const merged = {
  ...main,
  meta: { ...main.meta, name: '港口吊机 Harbor Crane', note: '四步工作流 C3-3 总装（主体 + SA-1 起重臂 + SA-2 司机舱）' },
  parts: [
    ...main.parts,
    // 子组件整体作为「装配步」出现：把其内部 step 映射到主体之后（主体最多 6 步）
    ...prefix(jibResult.placed, 'sa1').map((p) => ({ ...p, step: 7, module: 'SA-1' })),
    ...prefix(cabResult.placed, 'sa2').map((p) => ({ ...p, step: 8, module: 'SA-2' })),
  ],
};

const crossReport = [];
const hostIds = new Set([jibResult.host, cabResult.host]);
const sets = {
  main: merged.parts.filter((p) => !/^sa[12]:/.test(p.id)),
  sa1: merged.parts.filter((p) => p.id.startsWith('sa1:')),
  sa2: merged.parts.filter((p) => p.id.startsWith('sa2:')),
};
const crossCheck = (A, B, nA, nB) => {
  for (const a of A) {
    const ad = catalog.parts[a.part];
    const ab = partBoxes(a, ad);
    for (const c of B) {
      // 挂装接触面允许贴合：跳过它与自己 host 的组合（由 partsConnected 保真）
      if ((hostIds.has(a.id) || hostIds.has(c.id)) && (nA === 'main' || nB === 'main')) {
        const mainSide = nA === 'main' ? a : c;
        if (hostIds.has(mainSide.id)) continue;
      }
      const cd = catalog.parts[c.part];
      if (partsCollide(a, ad, ab, c, cd, partBoxes(c, cd))) crossReport.push(`${nA}:${a.id} × ${nB}:${c.id}`);
    }
  }
};
crossCheck(sets.main, sets.sa1, 'main', 'sa1');
crossCheck(sets.main, sets.sa2, 'main', 'sa2');
crossCheck(sets.sa1, sets.sa2, 'sa1', 'sa2');

const info = validate(merged, catalog);
const out = `${DIR}/build/harbor-crane.assembly.brick.json`;
fs.writeFileSync(out, JSON.stringify(merged, null, 2));
fs.writeFileSync(`${DIR}/build/assemble-report.json`, JSON.stringify({
  jib: { rot: jibResult.rot, stud: jibResult.stud, host: 'p022' },
  cab: { rot: cabResult.rot, stud: cabResult.stud, host: 'p025' },
  parts: merged.parts.length,
  crossCollisions: crossReport,
  validate: { errors: info.errors.length, warnings: info.warnings.length },
}, null, 2));

console.log(JSON.stringify({
  parts: merged.parts.length,
  expected: main.parts.length + sa1.parts.length + sa2.parts.length,
  crossCollisions: crossReport.length,
  firstCross: crossReport.slice(0, 5),
  errors: info.errors.length,
  warnings: info.warnings.length,
  firstErrors: info.errors.slice(0, 6).map((e) => String(e.code || '') + ': ' + String(e.msg || '').slice(0, 120)),
  stats: info.stats,
  out,
}, null, 2));
