// catalog-audit：对合并目录（精选 parts.json + LDraw 自动扩充 parts-ldraw.json）全件跑四条机查 + 渲染冒烟。
// 由 cli/brickkit.mjs `catalog-audit --out catalog/audit-full.json` 调用（命令与参数名固定，供管线解析）。
//
// 四条机查（纯计算，不起浏览器）：
//   ① geometry   官方 .dat 实测占地/高度/顶凸点数核对（复用 verifyPart；hinge/technic/bracket/door 的
//                功能性外挑按 catalog-verify 同口径豁免 height-error 之外不豁免）；
//   ② connectors 定义性接口有表示 + 虚假受体扫描：
//                有顶凸点件必须输出 top 凸点；holes/axleHoles/pins/bars/clips/sideStuds/studCells/
//                centerStuds 每个显式字段必须在 partConnectors 输出中 1:1 兑现；
//                antistudCells 满格默认仅允许 antistudSource:'measured'（.dat 实测）——无标记的满格默认
//                视为虚假受体；空数组 + antistudSource:'assumed' 组合视为数据自相矛盾；
//   ③ schema     bracket 必须有 (vH+dir) 或 needsManual；全字段深扫 NaN/Infinity/undefined；
//                name/kind/size/h/studs 基本类型完整；
//   ④ assembly   builder 单件放置 [0,0,0] + validate 0 errors（door-mount 之类 warning 不算失败）。
// 渲染冒烟（注入的 renderFn，随机抽样默认 100 件）：单件 400×400 渲染非全白（文件字节数阈值）。
//
// 性能预算：默认 30 分钟（budgetMs）；渲染抽样按剩余时间自动减量，实际抽样数写进 summary。
import { bboxFromText, verifyPart, OFFICIAL_ALIASES, connectorInstancesFromText, STUD_PRIMITIVES, PIN_PRIMITIVES, BAR_PRIMITIVES, CLIP_PRIMITIVES, PROTRUSION_PRIMITIVES, WPIN_PRIMITIVES } from '../ldraw/ldraw.js';
import { partConnectors, localCells } from './core.js';
import { createBuilder } from './builder.js';

// 与 tools/gen-parts-catalog.mjs 同款主体/外挑分离：销/轮销/把手/夹/横向凸点不计入主体，
// 连接图元 14 LDU 邻域内的裸圆柱（把手立柱等）一并剔除；纯外挑件退回全量 bbox。
// 几何核对必须对「主体盒」做——目录 size/h 描述的是砖体基准（P0-a 归一口径），
// 直接拿全量 bbox 核会把外挑销/杆/轮销误判成 height-error / protrudes。
// 外挑白名单必须与生成器共用 PROTRUSION_PRIMITIVES：两处口径不一致会让「已修好的尺寸」（如 18892
// 轮销剔除后 4×2）在审计里重新被量成 5 格而报假错。
function bodyBoxFromText(text, readLib) {
  const instances = connectorInstancesFromText(text, readLib);
  const connAnchors = instances.filter((c) => PIN_PRIMITIVES.has(c.prim) || WPIN_PRIMITIVES.has(c.prim) || BAR_PRIMITIVES.has(c.prim) || CLIP_PRIMITIVES.has(c.prim)).map((c) => c.pos);
  const nearConn = (pos) => connAnchors.some((a) => (a[0] - pos[0]) ** 2 + (a[1] - pos[1]) ** 2 + (a[2] - pos[2]) ** 2 < 196);
  const full = bboxFromText(text, readLib);
  const body = bboxFromText(text, readLib, {
    skipInstance: (base, MM, pos) =>
      PROTRUSION_PRIMITIVES.has(base)
      || (STUD_PRIMITIVES.has(base) && Math.abs(MM[1][1]) < 0.3)
      || (/^(\d+-\d+(-\d+)?)?cyl/i.test(base) && pos && nearConn(pos)),
  });
  return body || full;
}

const CONNECTOR_FIELDS = [
  // [目录字段, partConnectors 输出 kind, 输出侧('studs'|'receptors')]
  ['holes', 'hole', 'receptors'],
  ['axleHoles', 'axle', 'receptors'],
  ['clips', 'clip', 'receptors'],
  ['pins', 'pin', 'studs'],
  ['bars', 'bar', 'studs'],
  ['sideStuds', 'side', 'studs'],
];

// 深扫 NaN / Infinity / undefined（JSON 解析产物理论上不会出现，机查兜底）
function findBadNumbers(value, path, out) {
  if (value === undefined) { out.push(`${path}=undefined`); return; }
  if (typeof value === 'number' && !Number.isFinite(value)) { out.push(`${path}=${value}`); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => findBadNumbers(v, `${path}[${i}]`, out)); return; }
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) findBadNumbers(v, `${path}.${k}`, out);
}

// 与 cli catalog-verify 同口径的功能性外挑豁免（这类件官方几何天然超出网格占位）
const featureKind = (def) => ['hinge', 'technic', 'bracket'].includes(def.category) || def.kind === 'door';

/** auditCatalog —— 全量审计。返回 { summary, results }；summary 同时作为 stdout 顶部一行汇总 JSON。
 * 参数：cat = 合并目录 { parts, colors }；readLib(rawName) → 官方 .dat 文本（带缓存）；
 *       renderFn(model) → { bytes }（注入的渲染冒烟实现，传 null 则跳过渲染抽样）；
 *       sample/seed = 抽样量与随机种子；budgetMs = 总预算；renderThresholdBytes = 非全白阈值。 */
export async function auditCatalog({ cat, readLib, renderFn = null, sample = 100, seed = 20261025, budgetMs = 30 * 60 * 1000, renderThresholdBytes = 4000, log = () => {} }) {
  const t0 = Date.now();
  const entries = Object.entries(cat.parts);
  const counts = {
    geometry: { pass: 0, fail: 0, missing: 0 }, connectors: { pass: 0, fail: 0 },
    schema: { pass: 0, fail: 0 }, assembly: { pass: 0, fail: 0 }, render: { requested: renderFn ? sample : 0, sampled: 0, pass: 0, fail: 0 },
  };
  const color = cat.colors && (cat.colors['4'] ? '4' : Object.keys(cat.colors)[0]);
  const results = [];

  // —— ① ~ ④ 纯计算机查（全件）——
  let done = 0;
  for (const [id, def] of entries) {
    done++;
    if (done % 800 === 0) log(`  机查 ${done}/${entries.length}（${Math.round((Date.now() - t0) / 1000)}s）`);
    const reasons = [];
    const checks = {};

    // ① 几何：对官方 .dat 主体盒（外挑分离后）核占地/高度
    const official = OFFICIAL_ALIASES[id] || id;
    let geo = null;
    try {
      const text = readLib(`${official}.dat`);
      if (!text) {
        counts.geometry.missing++;
        reasons.push('geometry: 官方库无 .dat');
      } else {
        const box = bodyBoxFromText(text, readLib);
        if (!box) { counts.geometry.missing++; reasons.push('geometry: .dat 无实体几何'); }
        else geo = verifyPart(def, box);
      }
    } catch (e) { counts.geometry.fail++; reasons.push(`geometry: ${e.message}`); }
    if (geo) {
      // 判定口径（三层，自 catalog-verify 推广到全量目录）：
      //   ① verifyPart 精确匹配（容差 0.5 LDU）或 stud-offset（官方几何含顶部凸点 +4 LDU）；
      //   ② auto 条目的片数量化容差 ±4.5 LDU——h/radius 本就是官方尺寸的四舍五入片数（轮/胎/天线等
      //     非网格件必然有半片级漂移，属生成约定而非目录错误）；
      //   ③ hinge/technic/bracket/door 的功能性外挑（与 cli catalog-verify 同口径豁免）。
      const quantized = def.auto && !geo.ok && Math.abs(geo.axes.y.diff) <= 4.5;
      const featureExplained = !geo.ok && featureKind(def);
      const geoOk = geo.ok || quantized || featureExplained;
      if (geoOk) counts.geometry.pass++;
      else { counts.geometry.fail++; reasons.push(`geometry: ${geo.status}${quantized ? '(quantized)' : ''} ${geo.flags.join(',')}（y 期望 ${geo.expected.y} 实测 ${geo.measured.y}）`); }
      checks.geometry = geoOk;
    } else checks.geometry = reasons.some((r) => r.startsWith('geometry:')) ? false : null;

    // ② 连接器完整性与虚假受体
    const connIssues = [];
    let conn = null;
    try { conn = partConnectors({ id: 'p1', part: id, at: [0, 0, 0], step: 1 }, def); }
    catch (e) { connIssues.push(`partConnectors 抛错：${e.message}`); }
    if (conn) {
      const tops = conn.studs.filter((s) => s.kind === 'top');
      // 定义性顶凸点（localCells 引擎口径，精选/扩充目录通用）：应有 top 凸点输出的件必须 > 0
      if (localCells(def).some((c) => c.stud) && tops.length === 0) {
        connIssues.push('定义性顶凸点件未输出任何 top 凸点');
      }
      for (const [field, kind, side] of CONNECTOR_FIELDS) {
        if (!Array.isArray(def[field])) continue;
        // 引擎对 kind bar/barplate 会结构性生成 bar，与显式字段并存时不做 1:1 强校验
        if (field === 'bars' && (def.kind === 'bar' || def.kind === 'barplate')) continue;
        const emitted = conn[side].filter((x) => x.kind === kind).length;
        if (emitted !== def[field].length) connIssues.push(`${field} 声明 ${def[field].length} 个，引擎输出 ${emitted} 个`);
      }
      if (Array.isArray(def.studCells) && !def.tile && !def.noTopStuds && def.studs > 0 && def.kind !== 'cone' && def.kind !== 'dish') {
        const emitted = tops.length; // 非圆件族 top 凸点应逐格来自 studCells（cone/dish 有引擎默认单凸点路径）
        if (emitted < def.studCells.length) connIssues.push(`studCells ${def.studCells.length} 格仅输出 ${emitted} 个 top 凸点`);
      }
      const [sx, sz] = def.size;
      if (Array.isArray(def.antistudCells)) {
        const n = def.antistudCells.length;
        const expect = (def.kind === 'islope' ? def.antistudCells.filter(([, k]) => k === 0).length : n) + (def.antistudCenter ? 1 : 0);
        const emitted = conn.receptors.filter((r) => r.kind === 'antistud').length;
        if (emitted !== expect) connIssues.push(`antistudCells ${n} 格（+center ${def.antistudCenter ? 1 : 0}）引擎输出 ${emitted} 个底孔`);
        if (n === sx * sz && def.antistudSource !== 'measured') {
          connIssues.push(`满格 antistudCells 无 .dat 依据（antistudSource=${def.antistudSource ?? '未标记'}），疑似虚假受体`);
        }
        if (n === 0 && def.antistudSource === 'assumed') connIssues.push('空 antistudCells 与 antistudSource:assumed 自相矛盾');
      } else if (def.antistudSource === 'assumed') {
        const emitted = conn.receptors.filter((r) => r.kind === 'antistud').length;
        if (emitted === 0) connIssues.push('antistudSource:assumed 应走引擎默认满格（底孔受体 > 0）');
      }
    }
    checks.connectors = connIssues.length === 0;
    if (connIssues.length) { counts.connectors.fail++; for (const m of connIssues) reasons.push(`connectors: ${m}`); }
    else counts.connectors.pass++;

    // ③ schema
    const schemaIssues = [];
    if (def.kind === 'bracket' && !((Number.isFinite(def.vH) && (def.dir === 'up' || def.dir === 'down')) || def.needsManual === true)) {
      schemaIssues.push('bracket 缺 vH/dir 且未标 needsManual');
    }
    findBadNumbers(def, id, schemaIssues);
    if (typeof def.name !== 'string' || !def.name.trim()) schemaIssues.push('name 缺失');
    if (typeof def.kind !== 'string' || !def.kind) schemaIssues.push('kind 缺失');
    if (!Array.isArray(def.size) || def.size.length !== 2 || !def.size.every((v) => Number.isFinite(v) && v >= 1)) schemaIssues.push(`size 非法：${JSON.stringify(def.size)}`);
    if (!Number.isFinite(def.h) || def.h < 1) schemaIssues.push(`h 非法：${def.h}`);
    // studs 是扩充目录（auto）字段；精选目录（parts.json）无此字段，凸点由 kind/grid 隐含表达
    if (def.auto && !Number.isFinite(def.studs)) schemaIssues.push(`studs 非法：${def.studs}`);
    checks.schema = schemaIssues.length === 0;
    if (schemaIssues.length) { counts.schema.fail++; for (const m of schemaIssues) reasons.push(`schema: ${m}`); }
    else counts.schema.pass++;

    // ④ 装配冒烟：builder 单件放置 + validate 0 errors
    let asmMsg = null;
    try {
      const b = createBuilder({ catalog: cat });
      b.add(id, color, { at: [0, 0, 0], step: 1 });
      const r = b.validate();
      if (r.errors.length) asmMsg = `validate ${r.errors.length} errors：${r.errors[0].code} ${r.errors[0].msg}`;
    } catch (e) { asmMsg = e.message; }
    checks.assembly = !asmMsg;
    if (asmMsg) {
      counts.assembly.fail++;
      // needsManual 支架（P0-b 已知未完成项：引擎双守卫显式拒绝放置，待人工补 vH/dir）单列 known 计数
      const known = def.needsManual && /vH\/dir/.test(asmMsg);
      if (known) counts.assembly.known = (counts.assembly.known || 0) + 1;
      reasons.push(`assembly: ${known ? '[known:needsManual] ' : ''}${asmMsg}`);
    }
    else counts.assembly.pass++;

    const pass = checks.geometry !== false && checks.connectors && checks.schema && checks.assembly;
    results.push({ part: id, checks, ...(pass ? {} : { reasons }) });
  }

  // —— 渲染冒烟（抽样；按剩余预算自动减量）——
  if (renderFn && sample > 0) {
    // 种子线性同余洗牌，抽样可复现
    let s = seed >>> 0;
    const rand = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const pool = entries.map(([id]) => id);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const deadline = t0 + budgetMs - 60 * 1000; // 留 60s 收尾写盘
    for (const id of pool.slice(0, sample)) {
      if (Date.now() > deadline) { log(`  渲染抽样预算耗尽，实际抽样 ${counts.render.sampled}/${sample}`); break; }
      const row = results.find((r) => r.part === id);
      const model = { format: 'brickbuild', version: '0.2', meta: { name: `catalog-audit ${id}` }, parts: [{ id: 'p1', part: id, color, at: [0, 0, 0], step: 1 }] };
      let pass = false, why = null;
      try { const { bytes } = await renderFn(model); pass = bytes >= renderThresholdBytes; if (!pass) why = `渲染输出 ${bytes}B < ${renderThresholdBytes}B（疑似全白）`; }
      catch (e) { why = `渲染失败：${e.message}`; }
      counts.render.sampled++;
      if (pass) counts.render.pass++; else { counts.render.fail++; (row.reasons ||= []).push(`render: ${why}`); }
      row.checks.render = pass;
      row.pass = row.checks.geometry !== false && row.checks.connectors && row.checks.schema && row.checks.assembly && row.checks.render;
      if (counts.render.sampled % 20 === 0) log(`  渲染抽样 ${counts.render.sampled}`);
    }
  }
  for (const r of results) if (r.pass === undefined) r.pass = r.checks.geometry !== false && r.checks.connectors && r.checks.schema && r.checks.assembly && r.checks.render !== false;

  const passCount = results.filter((r) => r.pass).length;
  const summary = {
    ok: passCount === results.length,
    total: results.length, pass: passCount, fail: results.length - passCount,
    checks: counts, seconds: Math.round((Date.now() - t0) / 1000),
  };
  return { summary, results };
}
