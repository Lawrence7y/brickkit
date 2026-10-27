// fix-mecha-a2：11211（h5→3、sideRows 双排[1.25,3.75]→实测单排[1.75]）修复后的 mecha 联动重建。
// 物理事实：真实 11211 比旧假想件矮 2 片，且侧凸点只有一排（旧件双排）。忠实修复 = 用 1×2 板
// (3023, 两片一摞) 补回丢失的 2 片高度，使柱/塔/翼/头回到基线摆放（轮廓不变），侧排合并使
// 桥接件（裙甲/胸甲/侧甲）按 snapPart 落到实测单排，链随父刚性平移；全部门禁由 validate 复核。
// 坐标全部来自 core.snapPart；不手写小数。用法：node tools/fix-mecha-a2.mjs [--write]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { partConnectors, partBoxes, boxesCollide, snapPart, partCenter, validate } from '../src/core/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const ext = fs.existsSync(path.join(ROOT, 'catalog/parts-ldraw.json')) ? readJSON('catalog/parts-ldraw.json').parts : {};
const cat = { parts: { ...ext, ...readJSON('catalog/parts.json').parts }, colors: readJSON('catalog/colors.json').colors };
const baseCat = { parts: { ...ext, ...readJSON('out/parts-base.json').parts } };
const base = readJSON('out/mecha-base.brick.json');
const baseById = Object.fromEntries(base.parts.map((p) => [p.id, p]));
const model = readJSON('examples/mecha.brick.json');
const byId = Object.fromEntries(model.parts.map((p) => [p.id, p]));

// MOVED：将被重排（snap/刚性）的零件；其余保持基线并始终作为穿模锚点。
// 塔组（把柄/翼/肩灯/头）也列入 MOVED：它们将在 p30-p34 落位后统一刚性 +1，未就位前不挡 snap 候选。
const MOVED = new Set(['p82', 'p83', 'p15', 'p16', 'p17', 'p18', 'p19', 'p84', 'p85', 'p20', 'p21', 'p22', 'p23', 'p24',
  'p40', 'p41', 'p41a', 'p42', 'p43', 'p44', 'p45', 'p45a', 'p46', 'p47', 'p76', 'p77', 'p48', 'p79', 'p80', 'p52',
  'p25', 'p26', 'p27', 'p28', 'p29', 'p30', 'p31', 'p32', 'p33', 'p34',
  'p49', 'p50', 'p51', 'p53', 'p54', 'p55', 'p56', 'p57', 'p58', 'p59', 'p60', 'p61', 'p62', 'p63',
  'p64', 'p64b', 'p65', 'p66', 'p67', 'p68', 'p74', 'p75', 'p69', 'p70', 'p71', 'p72', 'p73']);
for (const p of model.parts) p.at = baseById[p.id].at.slice();
const boxesOf = new Map();
const refresh = (id) => boxesOf.set(id, partBoxes(byId[id], cat.parts[byId[id].part]));
for (const p of model.parts) refresh(p.id);
const fixed = (id) => !MOVED.has(id) || byId[id]._settled;
function collides(p) {
  const bs = partBoxes(p, cat.parts[p.part]);
  for (const q of model.parts) {
    if (q.id === p.id || q.id === p.mount || !fixed(q.id)) continue;
    if (boxesCollide(bs, boxesOf.get(q.id))) return q.id;
  }
  return null;
}
const centerDist = (p) => {
  const b = baseById[p.id]; if (!b) return 0;
  const c0 = partCenter(b, cat.parts[b.part]), c1 = partCenter(p, cat.parts[p.part]);
  return Math.abs(c1[0] - c0[0]) + Math.abs(c1[1] - c0[1]) * 2 + Math.abs(c1[2] - c0[2]);
};
const cl = (a, b) => Math.abs(a[0] - b[0]) <= 0.08 && Math.abs(a[1] - b[1]) <= 0.2 && Math.abs(a[2] - b[2]) <= 0.08;
function pairOK(s, r) {
  if (s.kind === 'bar' && r.kind === 'clip') return (!s.axis || !r.axis || s.axis === r.axis) && cl(s.pos, r.pos);
  if (s.kind === 'pin' && r.kind === 'hole') return (!s.axis || !r.axis || s.axis === r.axis) && cl(s.pos, r.pos);
  if (s.kind !== 'bar' && s.kind !== 'pin' && r.kind === 'antistud') return s.dir === r.dir && cl(s.pos, r.pos);
  return false;
}
function basePair(pid, cid) {
  const P = baseById[pid], C = baseById[cid];
  if (!P || !C) return null;
  const pc = partConnectors(P, baseCat.parts[P.part]), cc = partConnectors(C, baseCat.parts[C.part]);
  for (let i = 0; i < pc.studs.length; i++) for (let j = 0; j < cc.receptors.length; j++)
    if (pairOK(pc.studs[i], cc.receptors[j])) return { s: i, r: j };
  return null;
}
// 在父件（已就位）上重扣：基线编号对优先，其余组合按「离基线最近且不穿模」取第一个
function resnap(cid, pid) {
  const C = byId[cid], P = byId[pid];
  C._settled = false;
  const pConn = partConnectors(P, cat.parts[P.part]);
  const nRec = partConnectors({ ...C, at: [0, 0, 0], snot: 0 }, cat.parts[C.part]).receptors.length;
  const mk = (s, r) => { try { return snapPart(P, cat.parts[P.part], s, { ...C, snot: 0 }, cat.parts[C.part], r); } catch (e) { return null; } };
  const bp = basePair(pid, cid);
  const cands = [];
  if (bp) { const c = mk(bp.s, bp.r); if (c) cands.push(c); }
  for (let s = 0; s < pConn.studs.length; s++) for (let r = 0; r < nRec; r++) { const c = mk(s, r); if (c && !cands.includes(c)) cands.push(c); }
  cands.sort((a, b) => centerDist(a) - centerDist(b));
  for (const c of cands) {
    if (collides(c)) continue;
    const d = [c.at[0] - baseById[cid].at[0], c.at[1] - baseById[cid].at[1], c.at[2] - baseById[cid].at[2]];
    Object.assign(C, { at: c.at, rot: c.rot, snot: c.snot, up: c.up, _settled: true, mount: pid });
    refresh(cid);
    console.log(`  ${cid}（${C.part}）←${pid}: ${JSON.stringify(baseById[cid].at)}→${JSON.stringify(C.at)} Δ=${JSON.stringify(d)}`);
    return d;
  }
  throw new Error(`${cid} 在 ${pid} 无 0 穿模 snap 候选（${cands.length} 组：${cands.slice(0, 8).map((c) => JSON.stringify(c.at.map((x) => Math.round(x * 100) / 100)) + '←' + collides(c)).join(' ')}）`);
}
function rigid(group, d, note) {
  for (const id of group) { const p = byId[id]; p.at = [baseById[id].at[0] + d[0], baseById[id].at[1] + d[1], baseById[id].at[2] + d[2]]; p._settled = true; refresh(id); }
  console.log(`  刚性 Δ=${JSON.stringify(d)} ${note}：${group.join(',')}`);
}
// 在 pid 顶凸点上叠两片 1×2 板（3023，颜色同承托砖），把该柱顶恢复基线高度；返回顶层件 id
function restoreTop(pid, color, step, count = 2) {
  let prev = byId[pid]; const ids = [];
  for (let i = 0; i < count; i++) {
    const id = `rs${pid}${i}`;
    const probe = { id, part: '3023', color, at: [0, 0, 0], rot: prev.rot || 0, step, module: 'core', status: 'inferred', confidence: 0.95,
      evidence: (baseById[pid] ? baseById[pid].evidence : prev.evidence) || ['dis_core_right'],
      note: `A2 联动：11211 实测 h=3（旧定义 5），补 ${count} 片 1×2 板(3023) 恢复该柱顶凸点基线高度` };
    MOVED.add(id); byId[id] = probe; model.parts.push(probe);
    const pConn = partConnectors(prev, cat.parts[prev.part]);
    const nRec = partConnectors({ ...probe, snot: 0 }, cat.parts['3023']).receptors.length;
    let placedCand = null;
    for (let s = 0; s < pConn.studs.length && !placedCand; s++) for (let r = 0; r < nRec && !placedCand; r++) {
      let c; try { c = snapPart(prev, cat.parts[prev.part], s, { ...probe, snot: 0 }, cat.parts['3023'], r); } catch (e) { continue; }
      if (collides(c)) continue;
      placedCand = c;
    }
    if (!placedCand) throw new Error(`垫板 ${id} 无合法落位（父 ${pid}）`);
    Object.assign(probe, { at: placedCand.at, rot: placedCand.rot, up: placedCand.up, snot: placedCand.snot, mount: prev.id, _settled: true });
    refresh(id); ids.push(id); prev = probe;
    console.log(`  +${id}（3023）←${ids.length === 1 ? pid : ids[ids.length - 2]}: at ${JSON.stringify(placedCand.at)}`);
  }
  return ids[ids.length - 1];
}

// —— ① 裙甲（父 p13/p14 不动，侧排并一：+0.5 片），子链随父 ——
const d82 = resnap('p82', 'p13'); resnap('p83', 'p13'); rigid(['p15', 'p16', 'p17', 'p18', 'p19'], d82, '前裙甲');
const d84 = resnap('p84', 'p14'); resnap('p85', 'p14'); rigid(['p20', 'p21', 'p22', 'p23', 'p24'], d84, '后裙甲');

// —— ② 下部柱顶恢复：p13/p14 顶凸点 13→11，两片一摞补回 → p25 落回基线层 13 ——
const t13 = restoreTop('p13', 0, 4);
const t14 = restoreTop('p14', 72, 4);
resnap('p25', t13); // p25 2×4 横跨两柱：先扣 p13 柱顶，p14 柱顶由连接图自然咬合
delete byId.p25.mount;
if (JSON.stringify(byId.p25.at) !== JSON.stringify(baseById.p25.at)) console.log('  !! p25 未回基线', JSON.stringify(byId.p25.at));
else console.log('  p25 回基线 [-1,13,0] ✓');

// —— ③ 中段 11211（p26..p29）：扣 p25 顶 → 保持基线；其顶凸点 17 vs 旧 19，补摞 3 片（旧 19+0.5 胸甲漂移+1 净余）
//     使把柄层 p30-p34 +1；胸甲链因单排 +0.5，能量柱顶端需与头塔保持间隙 → 上部整塔刚性 +1（塔内咬合全保持基线）。
for (const id of ['p26', 'p27', 'p28', 'p29']) { byId[id].at = baseById[id].at.slice(); byId[id]._settled = true; refresh(id); }
const t26 = restoreTop('p26', 72, 5, 3);
const t27 = restoreTop('p27', 0, 5, 3);
const t28 = restoreTop('p28', 72, 5, 3);
const t29 = restoreTop('p29', 0, 5, 3);
resnap('p30', t28); resnap('p31', t29); resnap('p32', t28); resnap('p33', t29); resnap('p34', t26);
const TUP = [0, 1, 0];
for (const id of ['p30', 'p31', 'p32', 'p33', 'p34']) {
  const want = [baseById[id].at[0], baseById[id].at[1] + 1, baseById[id].at[2]];
  console.log(JSON.stringify(byId[id].at) === JSON.stringify(want) ? `  ${id} = 基线+1 ✓` : `  !! ${id} 期望 ${JSON.stringify(want)} 实得 ${JSON.stringify(byId[id].at)}`);
  byId[id]._settled = true;
}
// 塔/翼/肩灯/头：塔内零件对未变 → 整组刚性 +1
for (const id of ['p49', 'p50', 'p51', 'p53', 'p54', 'p55', 'p56', 'p57', 'p58', 'p59', 'p60', 'p61', 'p62', 'p63',
  'p64', 'p64b', 'p65', 'p66', 'p67', 'p68', 'p74', 'p75', 'p69', 'p70', 'p71', 'p72', 'p73']) MOVED.add(id);
rigid(['p49', 'p50', 'p51', 'p53', 'p54', 'p55', 'p56', 'p57', 'p58', 'p59', 'p60', 'p61', 'p62', 'p63',
  'p64', 'p64b', 'p65', 'p66', 'p67', 'p68', 'p74', 'p75', 'p69', 'p70', 'p71', 'p72', 'p73'], TUP, '肩灯/机翼/头塔 刚性 +1');

// —— ④ 胸甲/侧甲桥接件重扣单排，链随父 Δ 刚性 ——
const d40 = resnap('p40', 'p26'); rigid(['p41', 'p41a', 'p42', 'p43'], d40, '前胸甲链');
const d44 = resnap('p44', 'p27'); rigid(['p45', 'p45a', 'p46', 'p47'], d44, '后背甲链');
const d76 = resnap('p76', 'p28'); resnap('p77', 'p28'); rigid(['p48'], d76, '左外甲');
const d79 = resnap('p79', 'p29'); resnap('p80', 'p29'); rigid(['p52'], d79, '右外甲');

// —— ⑤ 合页 pivot：p30 已回基线 → 与基线同 ——
const bar = partConnectors(byId.p30, cat.parts['48336']).studs.find((s) => s.kind === 'bar');
for (const m of model.mechanisms || []) {
  if (m.id === 'wings_front') m.pivot = [1, Math.round(bar.pos[1] * 100) / 100, 2.22];
  if (m.id === 'wings_back') m.pivot = [1, Math.round(bar.pos[1] * 100) / 100, -0.22];
}
console.log('  wings pivot →', JSON.stringify(model.mechanisms[0].pivot), JSON.stringify(model.mechanisms[1].pivot));

const v = validate(model, cat);
console.log('validate:', v.ok ? 'OK' : 'FAIL', 'errors', v.errors.length, 'warnings', v.warnings.length);
for (const e of v.errors.slice(0, 40)) console.log('  E', e.code, JSON.stringify(e.parts || ''), (e.msg || '').slice(0, 130));
for (const w of v.warnings.slice(0, 40)) console.log('  W', w.code, JSON.stringify(w.parts || ''), (w.msg || '').slice(0, 130));

if (process.argv.includes('--write')) {
  if (!v.ok || v.warnings.length) { console.log('未达 0 errors 0 warnings，拒绝写回'); process.exit(1); }
  const upStr = (p) => p.up || '+y';
  const lines = fs.readFileSync(path.join(ROOT, 'examples/mecha.brick.json'), 'utf8').split(/\r?\n/);
  for (const p of model.parts) {
    if (!baseById[p.id]) continue;
    const i = lines.findIndex((L) => L.includes(`"id": "${p.id}"`));
    if (i < 0) continue;
    const b = baseById[p.id];
    if (JSON.stringify(b.at) === JSON.stringify(p.at) && (b.snot || 0) === (p.snot || 0) && upStr(b) === upStr(p) && (b.rot || 0) === (p.rot || 0)) continue;
    let L = lines[i];
    L = L.replace(/"at": *\[[^\]]*\]/, `"at": [${p.at.join(', ')}]`);
    if (/"rot": *[0-9]+/.test(L)) L = L.replace(/"rot": *[0-9]+/, `"rot": ${p.rot}`);
    if (/"snot": *[0-9.]+/.test(L)) L = L.replace(/"snot": *[0-9.]+/, `"snot": ${p.snot}`);
    if (/"up": *"[+-][a-z]"/.test(L)) L = L.replace(/"up": *"[+-][a-z]"/, `"up": "${upStr(p)}"`);
    else if (upStr(p) !== '+y') L = L.replace(/"at":/, `"up": "${p.up}", "at":`);
    lines[i] = L;
  }
  const anchor = lines.findIndex((L) => L.includes(`"id": "p12"`));
  const newLines = model.parts.filter((p) => !baseById[p.id]).map((p) =>
    `  { "id": "${p.id}", "part": "${p.part}", "color": ${p.color}, "at": [${p.at.join(', ')}], "up": "${p.up || '+y'}", "rot": ${p.rot}, "step": ${p.step}, "module": "${p.module}", "mount": "${p.mount}", "status": "${p.status}", "confidence": ${p.confidence}, "evidence": ${JSON.stringify(p.evidence)}, "note": "${p.note}" },`);
  lines.splice(anchor + 1, 0, ...newLines);
  fs.writeFileSync(path.join(ROOT, 'examples/mecha.brick.json'), lines.join('\r\n'));
  console.log('已写回 examples/mecha.brick.json');
}
