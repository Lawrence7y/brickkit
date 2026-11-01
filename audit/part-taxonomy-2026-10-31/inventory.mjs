// 零件种类/身份/覆盖缺口盘点（只读）。产出同目录的 inventory.json。
//
// 口径原则（与 AGENTS.md 一致）：
//   · 目录有条目 ≠ 可用；有真实网格 ≠ 可装配；机查通过 ≠ 实物验收。
//   · 所有计数从 catalog/parts.json、catalog/parts-ldraw.json、catalog/ldraw/manifest.json、
//     catalog/ldraw-full（本地镜像）直接计算，不转录任何历史报告的数字。
//   · 本脚本不写 catalog/、不改 parts.json / parts-ldraw.json / 别名映射 / 扩展网格包。
//
// 用法：node audit/part-taxonomy-2026-10-31/inventory.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeCatalogParts, partConnectors, partBoxes, MEASURED_CONNECTOR_FIELDS } from '../../src/core/core.js';
import { OFFICIAL_ALIASES, bboxFromText, verifyPart, connectorInstancesFromText, refCandidates, STUD_PRIMITIVES, PIN_PRIMITIVES, BAR_PRIMITIVES, CLIP_PRIMITIVES, PROTRUSION_PRIMITIVES, WPIN_PRIMITIVES } from '../../src/ldraw/ldraw.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'inventory.json');

const readJSON = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const curatedDoc = readJSON('catalog/parts.json');
const extDoc = readJSON('catalog/parts-ldraw.json');
const curated = curatedDoc.parts;
const ext = extDoc.parts;
const manifest = readJSON('catalog/ldraw/manifest.json');
const merged = mergeCatalogParts(ext, curated);
const colors = readJSON('catalog/colors.json').colors;

// ── 官方 .dat 解析（与 CLI catalog-audit 同口径的两级解析源）
//    必须用官方 refCandidates 解析引用：`s\xxx.dat` 只能落到 parts/s/xxx.dat，
//    手写「只取文件名」的解析器会把它解析成主零件 parts/xxx.dat，形成自引用并指数展开
//    （实测 6580a 一道 6 条自引用就让递归爆栈式膨胀 —— 这正是本脚本第一次跑不完的原因）。
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

// 与 src/core/catalog-audit.mjs 完全同款的主体盒（销/杆/夹/横向凸点剔除）
function bodyBoxFromText(text) {
  const instances = connectorInstancesFromText(text, readLib);
  const anchors = instances
    .filter((c) => PIN_PRIMITIVES.has(c.prim) || WPIN_PRIMITIVES.has(c.prim) || BAR_PRIMITIVES.has(c.prim) || CLIP_PRIMITIVES.has(c.prim))
    .map((c) => c.pos);
  const nearConn = (pos) => anchors.some((a) => (a[0] - pos[0]) ** 2 + (a[1] - pos[1]) ** 2 + (a[2] - pos[2]) ** 2 < 196);
  const full = bboxFromText(text, readLib);
  const body = bboxFromText(text, readLib, {
    skipInstance: (base, MM, pos) =>
      PROTRUSION_PRIMITIVES.has(base)
      || (STUD_PRIMITIVES.has(base) && Math.abs(MM[1][1]) < 0.3)
      || (/^(\d+-\d+(-\d+)?)?cyl/i.test(base) && pos && nearConn(pos)),
  });
  return body || full;
}

const featureKind = (def) => ['hinge', 'technic', 'bracket'].includes(def.category) || def.kind === 'door';
const trackedDat = new Set(fs.readdirSync(path.join(ROOT, 'catalog/ldraw/parts')).filter((f) => f.endsWith('.dat')).map((f) => f.replace(/\.dat$/i, '')));
const fullDat = new Set(fs.readdirSync(path.join(ROOT, 'catalog/ldraw-full/parts')).filter((f) => f.endsWith('.dat')).map((f) => f.replace(/\.dat$/i, '')));
const officialIdOf = (id) => OFFICIAL_ALIASES[id] || id;

// ── 逐件账本
const parts = [];
const t0 = Date.now();
let done = 0;
for (const [id, def] of Object.entries(merged)) {
  done++;
  if (done % 500 === 0) process.stderr.write(`  逐件 ${done}/${Object.keys(merged).length}（${Math.round((Date.now() - t0) / 1000)}s）\n`);
  if (process.env.TAX_TRACE && done > 4000) process.stderr.write(`    > ${id}\n`);
  const official = officialIdOf(id);
  const inTracked = trackedDat.has(official) || trackedDat.has(id);
  const inFull = fullDat.has(official) || fullDat.has(id);
  const source = curated[id] ? 'curated' : 'extracted';
  const overwritten = curated[id] && ext[id] ? true : false;

  // 连接器
  let conn = null, connErr = null;
  try { conn = partConnectors({ id: '_x', part: id, at: [0, 0, 0], rot: 0, up: '+y', snot: 0 }, def); }
  catch (e) { connErr = e.message; }
  const studKinds = conn ? [...new Set(conn.studs.map((s) => s.kind))].sort() : [];
  const recKinds = conn ? [...new Set(conn.receptors.map((s) => s.kind))].sort() : [];
  const measuredConn = MEASURED_CONNECTOR_FIELDS.filter((f) => Array.isArray(def[f]) && def[f].length > 0);
  const connOrigin = !conn || !(conn.studs.length + conn.receptors.length) ? 'none'
    : measuredConn.length ? 'measured' : 'synthesized';

  // 碰撞
  let boxes = null, boxErr = null;
  try { boxes = partBoxes({ id: '_x', part: id, at: [0, 0, 0], rot: 0, up: '+y' }, def); }
  catch (e) { boxErr = e.message; }
  const collideState = boxErr ? 'unsupported' : def.occupies === false ? 'empty-by-declaration'
    : Array.isArray(def.boxes) ? (def.boxesSource === 'measured' ? 'verified' : 'multi-box-inferred')
      : def.needsManualBoxes ? 'unsupported'
        : 'single-box-inferred';

  // 几何核对（官方 .dat 主体盒）
  let geoStatus = 'no-dat', geoDetail = null;
  if (inFull) {
    const text = readLib(`${official}.dat`);
    const box = text && bodyBoxFromText(text);
    if (box) {
      const v = verifyPart(def, box);
      const quantized = def.auto && !v.ok && Math.abs(v.axes.y.diff) <= 4.5;
      const explained = !v.ok && featureKind(def);
      geoStatus = v.ok ? v.status : quantized ? `${v.status}(quantized)` : explained ? `${v.status}(feature)` : `FAIL:${v.status}`;
      geoDetail = { expectedY: v.expected.y, measuredY: v.measured.y };
    }
  } else if (inTracked) geoStatus = 'tracked-only';

  parts.push({
    id,
    officialId: official,
    aliasRelation: OFFICIAL_ALIASES[id] ? 'redirect-alias' : 'identity',
    name: def.name || '',
    nameZh: def.zh || '',
    kind: def.kind,
    category: def.category,
    source,
    sourceOverWritesExtracted: overwritten,
    size: def.size,
    h: def.h,
    fields: {
      auto: Boolean(def.auto), movedTo: def.movedTo || null, needsManual: Boolean(def.needsManual),
      needsManualBoxes: Boolean(def.needsManualBoxes), occupies: def.occupies,
      boxesSource: def.boxesSource || null, antistudSource: def.antistudSource || null,
      sideRows: def.sideRows ? def.sideRows.length : 0, vH: typeof def.vH === 'number' ? def.vH : null,
      dir: def.dir || null, wheel: def.wheel ? def.wheel.role : null,
      minifig: Boolean(def.minifig), zgr: (def.zh || '').trim() ? 'zh' : 'none',
    },
    mesh: { trackedDat: inTracked, fullDat: inFull, geometryKind: inFull ? 'ldraw-mesh-available' : 'parametric-only' },
    connectors: {
      origin: connOrigin, measuredFields: measuredConn,
      studs: conn ? conn.studs.length : 0, receptors: conn ? conn.receptors.length : 0,
      studKinds, receptorKinds: recKinds, error: connErr,
    },
    collision: { state: collideState, boxCount: boxes ? boxes.length : 0, error: boxErr },
    geometryCheck: { status: geoStatus, ...(geoDetail || {}) },
  });
}

// ── 身份层：别名 / 重定向 / 变体 / 重复
const aliasRows = [];
for (const [id, def] of Object.entries(merged)) {
  const official = officialIdOf(id);
  if (official === id) continue;
  const target = merged[official];
  const src = partConnectors({ id: '_a', part: id, at: [0, 0, 0], rot: 0, up: '+y' }, def);
  const tgt = target ? partConnectors({ id: '_b', part: official, at: [0, 0, 0], rot: 0, up: '+y' }, target) : null;
  aliasRows.push({
    id, officialId: official, targetInCatalog: Boolean(target),
    alias: { kind: def.kind, size: def.size, h: def.h, studs: src.studs.length, receptors: src.receptors.length },
    target: target ? { kind: target.kind, size: target.size, h: target.h, studs: tgt.studs.length, receptors: tgt.receptors.length } : null,
    connectorDelta: target ? { studs: tgt.studs.length - src.studs.length, receptors: tgt.receptors.length - src.receptors.length } : null,
    geometryDisagreement: target ? String(def.size) !== String(target.size) || def.h !== target.h : null,
  });
}

// 精选 ↔ 扩充 同 id 身份分歧（合并时精选胜出、扩充的实测接口被遮蔽的部分单独列出）
const identityConflicts = [];
for (const id of Object.keys(curated)) {
  const c = curated[id], e = ext[id];
  if (!e) continue;
  const diffs = [];
  if (String(c.size) !== String(e.size)) diffs.push(`size ${c.size} vs ${e.size}`);
  if (c.h !== e.h) diffs.push(`h ${c.h} vs ${e.h}`);
  if (c.kind !== e.kind) diffs.push(`kind ${c.kind} vs ${e.kind}`);
  if ((c.category || '') !== (e.category || '')) diffs.push(`category ${c.category} vs ${e.category}`);
  if (diffs.length) identityConflicts.push({ id, name: c.name, diffs });
}

// 同名不同号（跨目录重复身份）
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const extByName = new Map();
for (const [id, d] of Object.entries(ext)) {
  const k = norm(d.name);
  if (!extByName.has(k)) extByName.set(k, []);
  extByName.get(k).push(id);
}
const crossCatalogDuplicates = [];
for (const [id, d] of Object.entries(curated)) {
  const hits = (extByName.get(norm(d.name)) || []).filter((h) => h !== id);
  if (hits.length) crossCatalogDuplicates.push({ curatedId: id, name: d.name, extIds: hits });
}

// 合并目录内「同名 + 同尺寸 + 同高 + 同 kind」的重复身份簇
const clusterKey = (d) => [norm(d.name), d.size.join('x'), d.h, d.kind].join('|');
const clusters = new Map();
for (const [id, d] of Object.entries(merged)) {
  const k = clusterKey(d);
  if (!clusters.has(k)) clusters.set(k, []);
  clusters.get(k).push(id);
}
const duplicateIdentityClusters = [...clusters.entries()]
  .filter(([, ids]) => ids.length > 1)
  .map(([k, ids]) => ({ key: k, ids }));

// 官方库里的重定向件（~Moved to）在合并目录中的覆盖情况
const redirectStats = { scanned: 0, resolvedOneLevel: 0, resolvedTargetShipped: 0, resolvedTargetFiltered: 0, twoLevel: 0, aliasEntries: 0, equalAliasEntries: 0 };
for (const f of fs.readdirSync(path.join(ROOT, 'catalog/ldraw-full/parts'))) {
  if (!f.endsWith('.dat')) continue;
  const text = fs.readFileSync(path.join(ROOT, 'catalog/ldraw-full/parts', f), 'utf8');
  const first = (text.split(/\r?\n/).find((l) => /^0\s/.test(l)) || '').replace(/^0\s+/, '');
  if (/^=\s*\S/.test(first)) redirectStats.equalAliasEntries++;
  const m = first.match(/^~Moved to\s+(\S+)/i);
  if (!m) continue;
  redirectStats.scanned++;
  const target = m[1].replace(/\.dat$/i, '').toLowerCase();
  const tf = path.join(ROOT, 'catalog/ldraw-full/parts', `${target}.dat`);
  if (!fs.existsSync(tf)) continue;
  const t2 = fs.readFileSync(tf, 'utf8').split(/\r?\n/).find((l) => /^0\s/.test(l)) || '';
  if (/^~Moved to/i.test(t2)) { redirectStats.twoLevel++; continue; }
  redirectStats.resolvedOneLevel++;
  const id = f.replace(/\.dat$/i, '').toLowerCase();
  if (merged[id]) redirectStats.aliasEntries++;
  if (merged[target]) redirectStats.resolvedTargetShipped++; else redirectStats.resolvedTargetFiltered++;
}

// 变体家族（数字主号 + 字母后缀）
const families = new Map();
for (const id of Object.keys(merged)) {
  const m = id.match(/^(\d+)([a-z]+)$/);
  if (!m) continue;
  if (!families.has(m[1])) families.set(m[1], []);
  families.get(m[1]).push(id);
}
const variantFamilies = [...families.entries()]
  .filter(([base, ids]) => ids.length > 1 || merged[base])
  .map(([base, ids]) => ({ base, present: merged[base] ? [base, ...ids] : ids, hasBare: Boolean(merged[base]), variants: ids }))
  .filter((f) => f.variants.length > 1 || f.hasBare);

// ── 能力层汇总
const tally = (fn) => parts.reduce((acc, p) => { const k = fn(p); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
const bySource = tally((p) => p.source);
const byMesh = {
  trackedDat: parts.filter((p) => p.mesh.trackedDat).length,
  fullDatOnly: parts.filter((p) => !p.mesh.trackedDat && p.mesh.fullDat).length,
  noDatAnywhere: parts.filter((p) => !p.mesh.fullDat).length,
};
const byConnectorOrigin = tally((p) => p.connectors.origin);
const byCollision = tally((p) => p.collision.state);
const byGeometryCheck = tally((p) => (p.geometryCheck.status.startsWith('FAIL') ? 'FAIL' : 'pass'));
const noReceptor = parts.filter((p) => p.connectors.origin !== 'none' && p.connectors.receptors === 0 && p.connectors.studs === 0).length;
const studSideOnly = parts.filter((p) => p.connectors.origin !== 'none' && p.connectors.receptors === 0 && p.connectors.studs > 0).length;
const receptorOnly = parts.filter((p) => p.connectors.origin !== 'none' && p.connectors.studs === 0 && p.connectors.receptors > 0).length;
const bothSides = parts.filter((p) => p.connectors.studs > 0 && p.connectors.receptors > 0).length;

// ── 用户搭建任务的零件需求（来自 examples/*.brick.json、*.bom.json、reconstruction-needs.json）
const taskParts = {};
for (const f of fs.readdirSync(path.join(ROOT, 'examples')).filter((f) => /\.brick\.json$/.test(f))) {
  const m = readJSON(`examples/${f}`);
  const ids = [...new Set((m.parts || []).map((p) => p.part))];
  taskParts[f] = { parts: ids.length, ids, missing: ids.filter((i) => !merged[i]) };
}
const bomGaps = {};
for (const f of fs.readdirSync(path.join(ROOT, 'examples')).filter((f) => /bom\.json$/.test(f))) {
  const b = readJSON(`examples/${f}`);
  const rows = b.parts || b.entries || [];
  const unresolved = rows.filter((r) => (r.status && r.status !== 'exact') || (r.catalog === false) || (r.ldraw === null && r.status !== 'exact'));
  bomGaps[f] = {
    total: rows.length,
    unresolved: unresolved.map((r) => ({
      status: r.status || (r.catalog === false ? 'not-in-catalog' : 'unknown'),
      ldraw: r.ldraw ?? r.design ?? null,
      qty: r.qty, color: r.color ?? r.colorName ?? null,
      name: r.name || r.shape || '', note: r.note || '',
      inCatalog: r.ldraw ? Boolean(merged[r.ldraw]) : false,
      datAvailable: r.ldraw ? fullDat.has(r.ldraw) : false,
    })),
  };
}
const reconstructionNeeds = readJSON('catalog/reconstruction-needs.json');

// ── 输出
const report = {
  generatedAt: new Date().toISOString(),
  scope: '只读盘点：未修改 catalog/parts.json、parts-ldraw.json、别名映射或网格包',
  sources: {
    curated: { file: 'catalog/parts.json', entries: Object.keys(curated).length },
    extracted: { file: 'catalog/parts-ldraw.json', entries: Object.keys(ext).length, generatedAt: extDoc.generatedAt, stats: extDoc.stats },
    merged: { entries: Object.keys(merged).length, formula: `${Object.keys(curated).length} + ${Object.keys(ext).length} - ${Object.keys(curated).filter((k) => ext[k]).length} 重叠` },
    ldraw: { manifestParts: Object.keys(manifest.parts || {}).length, trackedDatFiles: trackedDat.size, fullDatFiles: fullDat.size, colors: Object.keys(colors).length },
  },
  identity: {
    aliasMapEntries: Object.keys(OFFICIAL_ALIASES).length,
    aliases: aliasRows,
    redirectStats,
    crossCatalogDuplicates,
    duplicateIdentityClusters,
    identityConflictsCuratedVsExt: identityConflicts,
    variantFamilies,
  },
  coverage: {
    bySource,
    mesh: byMesh,
    connectors: { byOrigin: byConnectorOrigin, bothSides, receptorOnly, studOnlyNoReceptor: studSideOnly, noConnectors: noReceptor },
    collision: byCollision,
    geometryCheck: byGeometryCheck,
    geometryFailures: parts.filter((p) => p.geometryCheck.status.startsWith('FAIL')).map((p) => ({ id: p.id, status: p.geometryCheck.status })),
  },
  tasks: { models: taskParts, bomGaps, reconstructionNeeds: reconstructionNeeds.needs },
};

// 两文件输出，方便主会话按体积决策：
//   inventory.json        摘要层（身份 + 覆盖 + 任务），约 0.3 MB，适合进版本库
//   inventory-parts.json  逐件账本 4,605 行，约 3.4 MB，可 gitignore、需要时重跑
const ledger = parts;
const ledgerPath = path.join(HERE, 'inventory-parts.json');
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
fs.writeFileSync(ledgerPath, JSON.stringify({ generatedAt: report.generatedAt, count: ledger.length, parts: ledger }));
const summary = {
  out: path.relative(ROOT, OUT),
  ledger: path.relative(ROOT, ledgerPath),
  merged: report.sources.merged.entries,
  mesh: byMesh,
  connectors: report.coverage.connectors,
  collision: byCollision,
  geometryFails: report.coverage.geometryFailures.length,
  aliases: aliasRows.length,
  identityConflicts: identityConflicts.length,
  duplicateClusters: duplicateIdentityClusters.length,
  variantFamilies: variantFamilies.length,
};
console.log(JSON.stringify(summary, null, 1));
