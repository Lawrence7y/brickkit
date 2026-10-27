// tools/extract-plan.mjs — 说明书蓝图提取器（extractPlan）与零件守恒守门员（checkPlan）
//
// 用途：把「说明书/模型里已经确定的步骤结构」固化成 `<model>.plan.json`（format: brickbuild-plan 0.1），
// 再在动手搭任何零件之前用 checkPlan 做零件守恒核对（∑ 步骤件数 == ∑ 子模型 BOM == 官方 BOM == 模型实际）。
//
// 诚实原则（本模块的硬约束）：
//   - 只写能由数据直接推出的事实。页码只能顺序均摊时标 pageConfidence: "assumed" + note，
//     绝不假装「量到了」；视角（az/el）没有 --poses 来源时同样标 assumed 并写进 assumptions[]。
//   - 零件只按 (part, color, qty) 汇总，不做任何零件类型猜测。
//
// CLI 入口见 cli/brickkit.mjs 的 `extract-plan` / `check-plan` 两个 case；本模块只导出纯函数。
//
// extractPlan({ model, modelFile, manifest, manifestFile, bom, bomFile, assign, poses, pageMap })
//   → plan 对象（见 docs/数据格式.md「6.4 xxx.plan.json」一节）
// checkPlan(plan, { bom, bomFile, model, planFile })
//   → { ok, errors, warnings, stats }（errors 非空即 ok=false，CLI 退出码 1）

import path from 'node:path';

export const PLAN_FORMAT = 'brickbuild-plan';
export const PLAN_VERSION = '0.1';

// 没有实拍/标定来源时的说明书步骤页默认视角初值（typical LEGO 步骤页 3/4 俯视）。
// 一律随 step 标 poseConfidence: "assumed"，并写进 plan.assumptions，不做「精确」伪装。
export const DEFAULT_POSE = Object.freeze({ az: 315, el: 25 });

/* --------------------------------------------------------------- 通用小件 */
const keyOf = (part, color) => `${part}|${color}`;
/** 目录/模型里的“件号”与 BOM 条目对齐：BOM 条目可能用 substituteFor/ldraw/part/design 之一作件号 */
export const bomEntryId = (e) => String(e?.substituteFor || e?.ldraw || e?.part || e?.design || '');
const isInt = (v) => Number.isInteger(v);
const cap = (arr, n = 12) => arr.slice(0, n);

/** 相对 cwd 的路径（统一正斜杠便于跨平台阅读）；不在 cwd 下时保留绝对路径 */
function rel(p) {
  if (!p) return null;
  const abs = path.resolve(String(p));
  const r = path.relative(process.cwd(), abs);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) return String(p).replace(/\\/g, '/');
  return r.replace(/\\/g, '/');
}

/** 零件列表 → [{ part, color, qty }]（按 part、color 排序，便于逐次迭代 diff 稳定） */
export function aggregateParts(parts) {
  const m = new Map();
  for (const p of parts || []) {
    if (!p || p.part == null || !Number.isFinite(Number(p.color))) continue;
    const k = keyOf(String(p.part), Number(p.color));
    const e = m.get(k) || { part: String(p.part), color: Number(p.color), qty: 0 };
    e.qty += 1;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => String(a.part).localeCompare(String(b.part)) || a.color - b.color);
}

const totalQty = (rows) => (rows || []).reduce((a, r) => a + (Number(r?.qty) || 0), 0);

/** plan 里已是「已汇总」的 {part,color,qty} 行 → 按 qty 累加合并（与 aggregateParts 的区别：不再按条目计数） */
export function sumPartRows(rows) {
  const m = new Map();
  for (const r of rows || []) {
    if (!r || r.part == null || !Number.isFinite(Number(r.color))) continue;
    const k = keyOf(String(r.part), Number(r.color));
    const e = m.get(k) || { part: String(r.part), color: Number(r.color), qty: 0 };
    e.qty += Number(r.qty) || 0;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => String(a.part).localeCompare(String(b.part)) || a.color - b.color);
}

/** [{part,color,qty}] → Map(key → qty) */
function qtyMap(rows) {
  const m = new Map();
  for (const r of rows || []) m.set(keyOf(String(r.part), Number(r.color)), (m.get(keyOf(String(r.part), Number(r.color))) || 0) + (Number(r.qty) || 0));
  return m;
}

/* ------------------------------------------------------ 子模型归属（分组） */
/** 模型里显式声明的装配步：steps[].attach 与 mounts[]（PRD 0.3 的子模型挂装声明） */
function collectAttachSteps(model) {
  const m = new Map();
  for (const s of model.steps || []) {
    if (s && isInt(s.n) && typeof s.attach === 'string' && s.attach) m.set(s.attach, s.n);
  }
  for (const a of model.mounts || []) {
    if (!a || typeof a !== 'object') continue;
    const id = a.submodel ?? a.sub ?? a.id;
    const n = a.step ?? a.attachStep ?? a.n;
    if (typeof id === 'string' && id && isInt(n) && !m.has(id)) m.set(id, n);
  }
  return m;
}

/** submodels[].parts 既可能是 id 字符串数组，也可能是整条零件对象数组 */
const partIdList = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : x && typeof x.id === 'string' ? x.id : null)).filter(Boolean) : []);

/** 由模块树的最近 subassembly 祖先决定零件归属（与 core.js 的 subOfModule 同口径） */
function moduleSubOf(mods, id) {
  const seen = new Set();
  while (id && mods.has(id) && !seen.has(id)) {
    seen.add(id);
    const m = mods.get(id);
    if (m.subassembly) return id;
    id = m.parent;
  }
  return null;
}

/**
 * 把零件分成 1 个主干 + N 个子模型。优先级（与任务口径一致）：
 *   ① model.modules 里 subassembly: true 的模块树
 *   ② model.submodels（数组或 {id: {...}} 映射）+ parts[].submodel 字段
 *   ③ --assign 显式映射（模型自己没有归属信息时才用它）
 *   ④ 都没有 → 全部归 main（如 examples/60239.brick.json）
 * --assign 文件里写 "override": true 可强制覆盖模型自带归属（用户的明确意图）。
 * 返回 { subs: [{id,label,partIds,range,attachStep,source}], source }，main 恒在首位。
 */
export function groupSubmodels(model, assign, notes = []) {
  const parts = (model.parts || []).filter((p) => p && typeof p === 'object' && isInt(p.step));
  const forceAssign = Boolean(assign && (assign.override === true || assign.force === true));
  if (assign && forceAssign) {
    const subs = groupsFromAssign(parts, assign, notes);
    if (subs) { notes.push('子模型归属来自 --assign（override: true 强制覆盖模型自带归属）'); return { subs: finishSubs(subs), source: 'assign' }; }
    notes.push('--assign 里没有可用的 submodels/assign 归属，退回按模型自身分组');
  }
  const mods = new Map();
  for (const m of model.modules || []) if (m && typeof m.id === 'string' && !mods.has(m.id)) mods.set(m.id, m);
  if ([...mods.values()].some((m) => m.subassembly)) {
    if (assign) notes.push('模型自带 modules/subassembly 归属，--assign 已忽略（要强制覆盖请在 --assign 文件里写 "override": true）');
    const attach = collectAttachSteps(model);
    const buckets = new Map();
    const mainIds = [];
    for (const m of mods.values()) if (m.subassembly) buckets.set(m.id, []);
    for (const p of parts) {
      const sid = moduleSubOf(mods, p.module ?? p.group ?? null);
      if (sid) buckets.get(sid).push(p); else mainIds.push(p);
    }
    const subs = [{ id: 'main', label: '主干', partIds: mainIds.map((p) => p.id), parts: mainIds, range: null, attachStep: null, source: 'fallback' }];
    for (const [id, list] of buckets) {
      const m = mods.get(id);
      subs.push({ id, label: m.label || id, partIds: list.map((p) => p.id), parts: list, range: null, attachStep: attach.get(id) ?? null, source: 'modules' });
    }
    return { subs: finishSubs(subs), source: 'modules' };
  }
  const fromField = groupsFromSubmodelsField(parts, model);
  if (fromField) {
    if (assign) notes.push('模型自带 submodels 归属，--assign 已忽略（要强制覆盖请在 --assign 文件里写 "override": true）');
    return { subs: finishSubs(fromField), source: 'submodels' };
  }
  if (assign) {
    const subs = groupsFromAssign(parts, assign, notes);
    if (subs) return { subs: finishSubs(subs), source: 'assign' };
    notes.push('--assign 里没有可用的 submodels/assign 归属，退回单子模型 main');
  }
  return {
    subs: finishSubs([{ id: 'main', label: '主干', partIds: parts.map((p) => p.id), parts, range: null, attachStep: null, source: 'fallback' }]),
    source: 'fallback',
  };
}

/**
 * --assign <file> 支持三种写法（都允许）：
 *   a. 扁平映射        { "p001": "sub-rear", "p007": "main", ... }
 *   b. submodels + 映射 { submodels:[{id,label,steps,attachStep,parts:[id]}], assign:{partId:submodelId} }
 *   c. 只给 submodels   （零件按各自 steps 区间归属）
 */
function groupsFromAssign(parts, assign, notes) {
  const defs = [];
  let map = {};
  const looksFlat = !Array.isArray(assign?.submodels) && !(assign?.submodels && typeof assign.submodels === 'object') && !assign?.assign;
  if (looksFlat && assign && typeof assign === 'object') {
    map = assign;                                  // a. 扁平映射
  } else {
    if (Array.isArray(assign?.submodels)) {
      for (const e of assign.submodels) if (e && typeof e.id === 'string' && e.id) defs.push(e);
    } else if (assign?.submodels && typeof assign.submodels === 'object') {
      for (const [id, e] of Object.entries(assign.submodels)) defs.push({ id, ...(e && typeof e === 'object' ? e : {}) });
    }
    map = assign?.assign && typeof assign.assign === 'object' ? assign.assign : {};
  }
  const known = new Set(Object.values(map).filter((v) => typeof v === 'string'));
  if (!defs.length && !known.size) return null;
  for (const sid of known) if (sid !== 'main' && !defs.some((d) => d.id === sid)) defs.push({ id: sid });
  const byId = new Map(defs.filter((d) => d.id !== 'main').map((d) => [d.id, { ...d, partIds: partIdList(d.parts), parts: [] }]));
  // 子模型声明的零件 id 也算归属（写错 id → 记 note，不静默丢）
  const declaredPart = new Map();
  for (const d of byId.values()) for (const pid of d.partIds) declaredPart.set(pid, d.id);
  const mainIds = [];
  const partIds = new Set(parts.map((p) => p.id));
  for (const [pid] of declaredPart) if (!partIds.has(pid)) notes.push(`--assign 的子模型零件清单里 ${pid} 不在模型中，已忽略`);
  for (const p of parts) {
    let sid = typeof map[p.id] === 'string' ? map[p.id] : declaredPart.get(p.id) ?? null;
    if (sid === 'main') sid = null;
    if (sid && !byId.has(sid)) { notes.push(`--assign 把 ${p.id} 指到未定义的子模型 ${sid}，该零件归入主干`); sid = null; }
    if (!sid) {
      // 没有逐件映射时按步骤区间归属（区间端点含）
      for (const d of byId.values()) {
        const r = Array.isArray(d.steps) && d.steps.length === 2 ? d.steps : null;
        if (r && isInt(r[0]) && isInt(r[1]) && p.step >= r[0] && p.step <= r[1]) { sid = d.id; break; }
      }
    }
    if (sid) byId.get(sid).parts.push(p); else mainIds.push(p);
  }
  const subs = [{ id: 'main', label: '主干', partIds: mainIds.map((p) => p.id), parts: mainIds, range: null, attachStep: null, source: 'fallback' }];
  for (const d of byId.values()) subs.push({ id: d.id, label: d.label || d.id, partIds: d.partIds, parts: d.parts, range: d.steps ?? null, attachStep: d.attachStep ?? null, source: 'assign' });
  return subs;
}

/** model.submodels（0.3 风格）+ parts[].submodel */
function groupsFromSubmodelsField(parts, model) {
  const sm = model.submodels;
  const defs = [];
  if (Array.isArray(sm)) {
    for (const e of sm) if (e && typeof e.id === 'string' && e.id) defs.push({ id: e.id, label: e.label, steps: e.steps, attachStep: e.attachStep, partIds: partIdList(e.parts) });
  } else if (sm && typeof sm === 'object') {
    for (const [id, e] of Object.entries(sm)) defs.push({ id, label: e?.label, steps: e?.steps, attachStep: e?.attachStep, partIds: partIdList(e?.parts) });
  }
  const partSub = new Map();
  for (const p of parts) if (typeof p.submodel === 'string' && p.submodel) partSub.set(p.id, p.submodel);
  if (!defs.length && !partSub.size) return null;
  const byId = new Map(defs.filter((d) => d.id !== 'main').map((d) => [d.id, { ...d, parts: [] }]));
  for (const [pid, sid] of partSub) if (sid !== 'main' && !byId.has(sid)) byId.set(sid, { id: sid, label: sid, partIds: [], parts: [] });
  const mainIds = [];
  for (const p of parts) {
    const sid = partSub.get(p.id) || (defs.find((d) => d.id !== 'main' && d.partIds.includes(p.id))?.id ?? null);
    if (sid && sid !== 'main' && byId.has(sid)) byId.get(sid).parts.push(p); else mainIds.push(p);
  }
  const subs = [{ id: 'main', label: '主干', partIds: mainIds.map((p) => p.id), parts: mainIds, range: null, attachStep: null, source: 'fallback' }];
  for (const d of byId.values()) subs.push({ id: d.id, label: d.label || d.id, partIds: d.partIds, parts: d.parts, range: d.steps ?? null, attachStep: d.attachStep ?? null, source: 'submodels' });
  return subs;
}

/**
 * 收尾：补齐区间（显式区间优先，否则取成员步骤的 [min,max]）、丢掉空子模型、
 * 排序（main 首位，其余按区间起点）。
 */
function finishSubs(subs) {
  const out = [];
  for (const s of subs) {
    const steps = s.parts.map((p) => p.step).sort((a, b) => a - b);
    let range = Array.isArray(s.range) && s.range.length === 2 && isInt(s.range[0]) && isInt(s.range[1]) ? [s.range[0], s.range[1]] : null;
    if (!range && steps.length) range = [steps[0], steps[steps.length - 1]];
    if (!s.parts.length && !range) continue; // 空子模型：既无零件也无显式区间，不进计划
    out.push({ ...s, range, stepList: [...new Set(steps)] });
  }
  out.sort((a, b) => (a.id === 'main' ? -1 : b.id === 'main' ? 1 : (a.range?.[0] ?? 1e9) - (b.range?.[0] ?? 1e9) || String(a.id).localeCompare(String(b.id))));
  return out;
}

/* ------------------------------------------------------------ 页码映射 */
/**
 * 步骤号 → 页码。口径：
 *   - manifest 条目自带 step / steps 字段，或 --page-map 声明 → measured（有人/工具做了这层对应）
 *   - 其余按顺序均摊到 kind=step 的页 → assumed + note
 *   - manifest 没有步骤页 → page=null + assumed
 */
export function mapStepsToPages(stepNums, items, declared = new Map()) {
  const stepPages = [];
  for (const it of items || []) {
    const kind = it?.kind ?? it?.cls;
    if (kind === 'step' && isInt(it.page)) stepPages.push(it.page);
  }
  stepPages.sort((a, b) => a - b);
  const pageOf = new Map(), conf = new Map();
  for (const [n, page] of declared) if (stepNums.includes(n) && isInt(page)) { pageOf.set(n, page); conf.set(n, 'measured'); }
  const rest = stepNums.filter((n) => !pageOf.has(n));
  const used = new Set([...pageOf.values()]);
  const free = stepPages.filter((p) => !used.has(p));
  const split = evenSplit(rest, free);
  for (const [n, p] of split) { pageOf.set(n, p); conf.set(n, 'assumed'); }
  for (const n of rest) if (!pageOf.has(n)) { pageOf.set(n, null); conf.set(n, 'assumed'); }
  // method 只描述“页码是从哪来的”，不掩盖混合情况：declared / even-split / mixed / none
  const method = rest.length === 0 ? (declared.size ? 'declared' : 'none')
    : (declared.size && stepPages.length ? 'mixed'
      : stepPages.length ? 'even-split' : (declared.size ? 'mixed' : 'none'));
  return {
    pageOf, conf, stepPages,
    method,
    assumedCount: rest.length,
    measuredCount: stepNums.length - rest.length,
    evenSplit: split.size > 0,
  };
}

/** 把 nums 顺序均摊到 pages：页比步多则顺序一一对应；步比页多则前面的页各多担 1 步 */
function evenSplit(nums, pages) {
  const out = new Map();
  if (!nums.length || !pages.length) return out;
  const k = nums.length, m = pages.length;
  if (m >= k) { for (let i = 0; i < k; i++) out.set(nums[i], pages[i]); return out; }
  const base = Math.floor(k / m), rem = k % m;
  let idx = 0;
  for (let j = 0; j < m && idx < k; j++) {
    const take = base + (j < rem ? 1 : 0);
    for (let t = 0; t < take && idx < k; t++) out.set(nums[idx++], pages[j]);
  }
  return out;
}

/** --poses 归一化：支持 { steps:{ "1":{az,el} }, pages:{ "8":{az,el} } }、数组、或扁平 { "1":{az,el} } */
function poseIndex(poses) {
  const byStep = new Map(), byPage = new Map();
  const norm = (v) => (v && typeof v === 'object' && Number.isFinite(Number(v.az)) && Number.isFinite(Number(v.el))
    ? { az: Number(v.az), el: Number(v.el) } : null);
  const add = (map, k, v) => { const p = norm(v); const n = Number(k); if (p && Number.isFinite(n)) map.set(n, p); };
  if (Array.isArray(poses)) {
    for (const e of poses) { if (!e) continue; add(byStep, e.step ?? e.n, e); add(byPage, e.page, e); }
  } else if (poses && typeof poses === 'object') {
    const hasBlocks = (poses.steps && typeof poses.steps === 'object') || (poses.pages && typeof poses.pages === 'object');
    if (poses.steps && typeof poses.steps === 'object') for (const [k, v] of Object.entries(poses.steps)) add(byStep, k, v);
    if (poses.pages && typeof poses.pages === 'object') for (const [k, v] of Object.entries(poses.pages)) add(byPage, k, v);
    if (!hasBlocks) for (const [k, v] of Object.entries(poses)) if (/^\d+$/.test(k)) add(byStep, k, v);
  }
  return { byStep, byPage };
}

/* ------------------------------------------------------------- 主：提取 */
/**
 * 从模型（+ 说明书页 manifest + 官方 BOM + 可选 --assign/--poses）反推 plan。
 * 只做事实归集：每步新增零件来自 parts[].step，子模型 BOM 来自归属分组的零件汇总。
 */
export function extractPlan(opts = {}) {
  const { model, manifest = null, bom = null, assign = null, poses = null } = opts;
  const modelFile = opts.modelFile || null;
  const manifestFile = opts.manifestFile || null;
  const bomFile = opts.bomFile || null;
  const notes = [], assumptions = [];

  if (!model || typeof model !== 'object' || !Array.isArray(model.parts)) throw new Error('提取失败：模型缺少 parts 数组');
  const parts = model.parts.filter((p) => p && typeof p === 'object');
  if (!parts.length) throw new Error('提取失败：模型 parts 为空');
  const bad = parts.filter((p) => !isInt(p.step) || p.step < 0);
  if (bad.length) {
    throw new Error(`提取失败：${bad.length} 个零件缺少合法整数 step（${cap(bad.map((p) => p.id || '?' ), 5).join(', ')}${bad.length > 5 ? '…' : ''}）——无法反推每步新增清单`);
  }

  /* 1) 子模型归属 */
  const { subs, source: groupSource } = groupSubmodels(model, assign, notes);
  if (groupSource === 'fallback') {
    assumptions.push('模型没有 modules/subassembly、submodels 或 --assign 归属信息：全部零件归入 main（单子模型），子模型拆分需后续用 --assign 明确声明');
  } else if (groupSource === 'assign') {
    assumptions.push('子模型归属来自 --assign 显式映射（用户声明，未做视觉核对）');
  } else {
    assumptions.push(`子模型归属来自模型自身的 ${groupSource} 声明`);
  }

  /* 2) 每步新增零件 */
  const stepNums = [...new Set(parts.map((p) => p.step))].sort((a, b) => a - b);
  const byStep = new Map(stepNums.map((n) => [n, []]));
  for (const p of parts) byStep.get(p.step).push(p);

  /* 3) 步骤 → 页码 */
  const items = Array.isArray(manifest?.items) ? manifest.items : [];
  const declared = new Map();
  for (const it of items) {
    if (isInt(it.step) && isInt(it.page)) declared.set(it.step, it.page);
    if (Array.isArray(it.steps)) for (const n of it.steps) if (isInt(n) && isInt(it.page)) declared.set(n, it.page);
  }
  const pageMap = opts.pageMap;
  if (pageMap && typeof pageMap === 'object') {
    const flat = pageMap.map && typeof pageMap.map === 'object' ? pageMap.map : pageMap;
    for (const [k, v] of Object.entries(flat)) {
      const n = Number(k), pg = Number(v);
      if (isInt(n) && isInt(pg)) declared.set(n, pg);
      else notes.push(`--page-map 条目 ${k} → ${v} 不是整数步骤号/页码，已忽略`);
    }
    for (const n of declared.keys()) if (!stepNums.includes(n) && isInt(n)) notes.push(`--page-map 声明了模型中不存在的步骤 ${n}，已忽略`);
  }
  const pm = mapStepsToPages(stepNums, items, declared);
  if (!manifest && !declared.size) {
    assumptions.push('没有说明书页清单（--from-pages）：steps[].page 全为 null，pageConfidence=assumed');
  } else if (pm.method === 'declared') {
    assumptions.push(`页码口径：全部 ${stepNums.length} 步的页码来自显式声明（pageConfidence=measured），未做视觉复核`);
  } else if (pm.method === 'even-split') {
    assumptions.push(`页码口径：${stepNums.length} 个步骤按顺序均摊到 ${pm.stepPages.length} 张 kind=step 页（无 OCR/文字层核对），全部 pageConfidence=assumed`);
  } else if (pm.method === 'mixed') {
    assumptions.push(`页码口径：${pm.measuredCount} 步来自显式声明（measured），${pm.assumedCount} 步为剩余步骤页顺序均摊（assumed）`);
  } else if (pm.method === 'none') {
    assumptions.push('说明书页清单里没有 kind=step 的页：steps[].page 全为 null');
  }

  /* 4) 视角初值 */
  const pi = poseIndex(poses);
  if (!poses) assumptions.push(`视角口径：无 --poses 来源，全部步骤用默认说明书视角初值 az=${DEFAULT_POSE.az} el=${DEFAULT_POSE.el}（poseConfidence=assumed），可用 brickkit calibrate 逐页标定后回填`);
  else assumptions.push('视角口径：az/el 来自 --poses（视为已标定，poseConfidence=measured）');

  /* 5) 组装 steps
   * pageConfidence=assumed 时必须带 note：说清这页码是怎么来的（顺序均摊 / 与谁共用），
   * 绝不留下“看起来是量到的”含糊状态。 */
  const steps = stepNums.map((n) => {
    const list = byStep.get(n);
    const page = pm.pageOf.get(n) ?? null;
    const pose = pi.byStep.get(n) || (page !== null ? pi.byPage.get(page) : null) || null;
    const pageConfidence = pm.conf.get(n) || 'assumed';
    const samePage = page === null ? [] : stepNums.filter((x) => pm.pageOf.get(x) === page);
    let note;
    if (page === null) note = 'pages 清单里没有可对应的 kind=step 页：page 置 null，页码未确定';
    else if (pageConfidence !== 'measured') {
      note = samePage.length > 1
        ? `与第 ${samePage[0]}–${samePage[samePage.length - 1]} 步共用第 ${page} 页（页码按顺序均摊，未经 OCR/文字层核对）`
        : `页码按顺序均摊到第 ${page} 页（未经 OCR/文字层核对）`;
    }
    return {
      n, page,
      pageConfidence,
      pageKind: page === null ? null : (items.find((it) => it.page === page)?.kind ?? items.find((it) => it.page === page)?.cls ?? null),
      az: pose ? pose.az : DEFAULT_POSE.az,
      el: pose ? pose.el : DEFAULT_POSE.el,
      poseConfidence: pose ? 'measured' : 'assumed',
      parts: aggregateParts(list),
      ...(note ? { note } : {}),
    };
  });

  /* 6) 组装 submodels（BOM = 归属零件的汇总；区间 = 显式区间或成员步骤 min..max） */
  const submodels = subs.map((s) => ({
    id: s.id,
    label: s.label,
    steps: s.range,
    attachStep: s.attachStep ?? null,
    bom: aggregateParts(s.parts),
    source: s.source,
    ...(s.stepList.length ? { stepList: s.stepList } : {}),
    ...(s.attachStep == null && s.id !== 'main' ? { note: '没有装配步声明（steps[].attach / mounts[]）：attachStep 为 null' } : {}),
  }));

  /* 7) 顶层装配 */
  const setId = bom?.set ? String(bom.set).replace(/-\d+$/, '')
    : (modelFile ? (path.basename(String(modelFile)).match(/(\d{4,6})/) || [])[1] : null) || null;
  const pagesDir = manifestFile ? rel(path.dirname(String(manifestFile))) : (setId ? rel(path.join('out/manual-pages', setId)) : null);
  const total = parts.length;
  if (bom && Array.isArray(bom.parts)) {
    const bomTotal = bom.parts.reduce((a, e) => a + (Number(e.qty) || 0), 0);
    if (bomTotal !== total) notes.push(`模型 ${total} 件 ≠ 官方 BOM ${bomTotal} 件（差 ${total - bomTotal}）；用 check-plan 逐 (件号,颜色) 定位`);
  }

  return {
    format: PLAN_FORMAT,
    version: PLAN_VERSION,
    meta: {
      name: model.meta?.name || (setId ? `LEGO ${setId}` : '未命名模型'),
      setId,
      generatedBy: 'tools/extract-plan.mjs',
      generatedAt: new Date().toISOString(),
      source: modelFile ? rel(modelFile) : null,
    },
    bomFile: bomFile ? rel(bomFile) : null,
    manual: manifest
      ? { pdf: manifest.source ? rel(manifest.source) : null, pagesDir, pages: Number.isInteger(manifest.pages) ? manifest.pages : items.length, book: Number(manifest.book) || null }
      : null,
    submodels,
    steps,
    pageMapping: {
      source: manifest ? rel(manifestFile) : null,
      method: pm.method,
      stepPages: pm.stepPages,
      stepCount: stepNums.length,
      measuredSteps: pm.measuredCount,
      assumedSteps: pm.assumedCount,
    },
    assumptions,
    notes,
  };
}

/* ------------------------------------------------------------- 主：校验 */
// 字段白名单：extractPlan 会写出的字段都在这里；白名单外的一律 warning（不静默丢弃，
// 让手写 plan 的拼写错误能被看见）。
const TOP_FIELDS = ['format', 'version', 'meta', 'bomFile', 'manual', 'submodels', 'steps', 'pageMapping', 'assumptions', 'notes'];
const META_FIELDS = ['name', 'setId', 'generatedBy', 'generatedAt', 'source', 'note'];
const MANUAL_FIELDS = ['pdf', 'pagesDir', 'pages', 'book'];
const PAGE_MAPPING_FIELDS = ['source', 'method', 'stepPages', 'stepCount', 'measuredSteps', 'assumedSteps'];
const SUBMODEL_FIELDS = ['id', 'label', 'steps', 'stepList', 'attachStep', 'bom', 'source', 'note'];
const STEP_FIELDS = ['n', 'page', 'pageConfidence', 'pageKind', 'az', 'el', 'poseConfidence', 'parts', 'note'];
const PART_FIELDS = ['part', 'color', 'qty'];

/**
 * 零件守恒守门员。
 * opts: { bom, model, bomFile, planFile }
 *   bom   —— 官方 BOM（brickkit-bom）；给了就逐 (件号,颜色) 对账
 *   model —— 模型（brickbuild）；给了就核对模型实际 BOM 与 plan 的 submodels 汇总
 */
export function checkPlan(plan, opts = {}) {
  const errors = [], warnings = [];
  const E = (code, msg, extra = {}) => errors.push({ code, msg, ...extra });
  const W = (code, msg, extra = {}) => warnings.push({ code, msg, ...extra });
  const stats = { steps: 0, submodels: 0, planTotalParts: 0, stepsTotalParts: 0, submodelsTotalParts: 0,
    bomEntries: 0, bomTotalParts: 0, modelTotalParts: 0, substituted: 0 };

  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    E('plan-format', '不是有效的 JSON 对象');
    return { ok: false, errors, warnings, stats };
  }
  if (plan.format !== PLAN_FORMAT) E('plan-format', `format 应为 "${PLAN_FORMAT}"，收到 ${plan.format ?? '(缺失)'}`);
  if (plan.version !== PLAN_VERSION) E('plan-version', `version 应为 "${PLAN_VERSION}"，收到 ${plan.version ?? '(缺失)'}`);

  /* 未知字段（白名单外一律 warning，方便抓拼写错误） */
  const unknown = (obj, allowed, where) => {
    for (const k of Object.keys(obj || {})) if (!allowed.includes(k)) W('plan-unknown-field', `${where} 里的未知字段 "${k}"（不在 plan.json 0.1 规范内，已忽略）`, { where, field: k });
  };
  unknown(plan, TOP_FIELDS, 'plan');
  if (plan.meta && typeof plan.meta === 'object') unknown(plan.meta, META_FIELDS, 'meta');
  if (plan.manual && typeof plan.manual === 'object') unknown(plan.manual, MANUAL_FIELDS, 'manual');
  if (plan.pageMapping && typeof plan.pageMapping === 'object') unknown(plan.pageMapping, PAGE_MAPPING_FIELDS, 'pageMapping');

  /* 结构校验 */
  const stepRows = Array.isArray(plan.steps) ? plan.steps : null;
  const subRows = Array.isArray(plan.submodels) ? plan.submodels : null;
  if (!stepRows) E('plan-structure', 'steps 必须是数组');
  if (!subRows) E('plan-structure', 'submodels 必须是数组');
  if (!Array.isArray(plan.submodels) && plan.submodels !== undefined) E('plan-structure', 'submodels 必须是数组（{id,label,steps,attachStep,bom} 的列表）');

  const seenStep = new Set();
  for (const [i, st] of (stepRows || []).entries()) {
    const where = `steps[${i}]`;
    if (!st || typeof st !== 'object') { E('plan-structure', `${where} 不是对象`); continue; }
    unknown(st, STEP_FIELDS, where);
    if (!isInt(st.n)) E('plan-structure', `${where} 的 n 必须是整数`);
    else if (seenStep.has(st.n)) E('plan-dup', `步骤 n=${st.n} 重复`);
    else seenStep.add(st.n);
    if (st.page !== undefined && st.page !== null && !isInt(st.page)) E('plan-structure', `${where} 的 page 必须是整数或 null`);
    if (st.az !== undefined && st.az !== null && !Number.isFinite(Number(st.az))) E('plan-structure', `${where} 的 az 必须是数字`);
    if (st.el !== undefined && st.el !== null && !Number.isFinite(Number(st.el))) E('plan-structure', `${where} 的 el 必须是数字`);
    if (st.pageConfidence !== undefined && !['measured', 'assumed'].includes(st.pageConfidence)) W('plan-confidence', `${where} 的 pageConfidence="${st.pageConfidence}" 不在 measured/assumed 内`);
    if (!Array.isArray(st.parts)) { E('plan-structure', `${where} 的 parts 必须是数组`); continue; }
    for (const [j, p] of st.parts.entries()) {
      if (!p || typeof p !== 'object') { E('plan-structure', `${where}.parts[${j}] 不是对象`); continue; }
      unknown(p, PART_FIELDS, `${where}.parts[${j}]`);
      if (p.part == null || String(p.part) === '') E('plan-structure', `${where}.parts[${j}] 缺少 part`);
      if (!Number.isFinite(Number(p.color))) E('plan-structure', `${where}.parts[${j}] 缺少数字 color`);
      if (!Number.isInteger(Number(p.qty)) || Number(p.qty) < 1) E('plan-structure', `${where}.parts[${j}] 的 qty 必须是正整数`);
    }
  }

  const seenSub = new Set();
  for (const [i, sm] of (subRows || []).entries()) {
    const where = `submodels[${i}]`;
    if (!sm || typeof sm !== 'object') { E('plan-structure', `${where} 不是对象`); continue; }
    unknown(sm, SUBMODEL_FIELDS, where);
    if (typeof sm.id !== 'string' || !sm.id) E('plan-structure', `${where} 缺少字符串 id`);
    else if (seenSub.has(sm.id)) E('plan-dup', `子模型 id=${sm.id} 重复`);
    else seenSub.add(sm.id);
    if (sm.steps !== null && sm.steps !== undefined) {
      const ok = Array.isArray(sm.steps) && sm.steps.length === 2 && isInt(sm.steps[0]) && isInt(sm.steps[1]) && sm.steps[0] <= sm.steps[1];
      if (!ok) E('plan-structure', `${where} 的 steps 必须是 [起始步骤, 结束步骤]（整数、升序）或 null，收到 ${JSON.stringify(sm.steps)}`);
    }
    if (sm.attachStep !== null && sm.attachStep !== undefined && !isInt(sm.attachStep)) E('plan-structure', `${where} 的 attachStep 必须是整数或 null`);
    if (!Array.isArray(sm.bom)) E('plan-structure', `${where} 的 bom 必须是数组`);
    for (const [j, e] of (Array.isArray(sm.bom) ? sm.bom : []).entries()) {
      if (!e || typeof e !== 'object') { E('plan-structure', `${where}.bom[${j}] 不是对象`); continue; }
      unknown(e, PART_FIELDS, `${where}.bom[${j}]`);
      if (e.part == null || String(e.part) === '') E('plan-structure', `${where}.bom[${j}] 缺少 part`);
      if (!Number.isFinite(Number(e.color))) E('plan-structure', `${where}.bom[${j}] 缺少数字 color`);
      if (!Number.isInteger(Number(e.qty)) || Number(e.qty) < 1) E('plan-structure', `${where}.bom[${j}] 的 qty 必须是正整数`);
    }
  }

  /* 守恒：∑ steps[].parts == ∑ submodels[].bom */
  const stepsAgg = sumPartRows((stepRows || []).flatMap((st) => Array.isArray(st?.parts) ? st.parts : []));
  const subsAgg = sumPartRows((subRows || []).flatMap((sm) => Array.isArray(sm?.bom) ? sm.bom : []));
  const stepsQty = qtyMap(stepsAgg), subsQty = qtyMap(subsAgg);
  const stepsTotal = totalQty(stepsAgg), subsTotal = totalQty(subsAgg);
  stats.steps = (stepRows || []).length;
  stats.submodels = (subRows || []).length;
  stats.stepsTotalParts = stepsTotal;
  stats.submodelsTotalParts = subsTotal;
  stats.planTotalParts = stepsTotal;

  if (stepsTotal !== subsTotal) {
    const keys = new Set([...stepsQty.keys(), ...subsQty.keys()]);
    const detail = [];
    for (const k of keys) {
      const a = stepsQty.get(k) || 0, b = subsQty.get(k) || 0;
      if (a === b) continue;
      const [part, color] = k.split('|');
      detail.push({ part, color: Number(color), steps: a, submodels: b, diff: a - b });
    }
    detail.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff) || String(x.part).localeCompare(String(y.part)));
    E('plan-step-sum-mismatch', `步骤件数合计 ${stepsTotal} ≠ 子模型 BOM 合计 ${subsTotal}（差 ${stepsTotal - subsTotal}）；${detail.length} 处 (件号,颜色) 不一致：${cap(detail).map((d) => `${d.part}×${d.color}（步骤 ${d.steps}/子模型 ${d.submodels}）`).join('、')}${detail.length > 12 ? ` 等 ${detail.length} 处` : ''}`,
      { delta: stepsTotal - subsTotal, steps: stepsTotal, submodels: subsTotal, detail: cap(detail), detailCount: detail.length });
  }

  /* 子模型区间重叠（main 可与其它重叠，例外） */
  const ranged = (subRows || []).filter((sm) => Array.isArray(sm?.steps) && sm.steps.length === 2 && isInt(sm.steps[0]) && isInt(sm.steps[1]) && sm.id !== 'main');
  for (let i = 0; i < ranged.length; i++) for (let j = i + 1; j < ranged.length; j++) {
    const a = ranged[i], b = ranged[j];
    const lo = Math.max(a.steps[0], b.steps[0]), hi = Math.min(a.steps[1], b.steps[1]);
    if (lo <= hi) E('plan-step-overlap', `子模型 ${a.id} [${a.steps[0]},${a.steps[1]}] 与 ${b.id} [${b.steps[0]},${b.steps[1]}] 在步骤 ${lo}–${hi} 重叠（main 以外的子模型区间必须互不重叠）`, { a: a.id, b: b.id, from: lo, to: hi });
  }

  /* 挂装步必须晚于自身区间末 */
  for (const sm of subRows || []) {
    if (!sm || !isInt(sm.attachStep) || !Array.isArray(sm.steps) || sm.steps.length !== 2) continue;
    if (sm.attachStep < sm.steps[1]) {
      E('plan-attach-order', `子模型 ${sm.id} 的 attachStep=${sm.attachStep} 早于自身区间末 ${sm.steps[1]}（应先拼完 ${sm.id} 再装到主体）`, { submodel: sm.id, attachStep: sm.attachStep, rangeEnd: sm.steps[1] });
    }
  }

  /* 官方 BOM 对账
   * 替代件：BOM 条目可能写 substituteFor（模型实际使用的件号）+ design（官方设计件号），
   * 两者在 plan 里都算合法件号——plan 用任意一侧都放行，但记 warning 'plan-substituted'。 */
  const bomData = opts.bom || null;
  if (bomData && Array.isArray(bomData.parts)) {
    const official = new Map();          // 规范键（substituteFor 优先）→ qty
    const alias = new Map();             // 设计件号键 → 规范键（等价件号）
    const substitutedKeys = new Map();   // 规范键 → { design, substitute, note, qty }
    const subsEntries = [];              // 先收集，等 official 齐了再建 alias（与 BOM 条目顺序无关）
    let bomTotal = 0;
    for (const e of bomData.parts) {
      const id = bomEntryId(e);
      if (!id || !Number.isFinite(Number(e.color))) continue;
      const color = Number(e.color), qty = Number(e.qty) || 0;
      const k = keyOf(id, color);
      official.set(k, (official.get(k) || 0) + qty);
      bomTotal += qty;
      if (e.substituteFor) subsEntries.push({ k, color, e, qty });
    }
    for (const { k, color, e, qty } of subsEntries) {
      substitutedKeys.set(k, { design: e.design ? String(e.design) : null, substitute: String(e.substituteFor), note: String(e.substituteNote || e.ldrawNote || ''), qty });
      // 设计件号（21023/35279/24741…）与替代件号指同一格位：互为等价键（official 里另有一条同键条目时不覆盖）
      for (const alt of [e.design, e.ldraw, e.part]) {
        const a = alt ? keyOf(String(alt), color) : null;
        if (a && a !== k && !official.has(a) && !alias.has(a)) alias.set(a, k);
      }
    }
    stats.bomEntries = official.size;
    stats.bomTotalParts = bomTotal;
    // plan 的键 → 规范键（含替代件等价）；plan 用替代件号或官方设计件号都归到同一格位，
    // 少件/多件两侧都对称比较，不存在“别名键被跳过多件”的漏洞。
    const effective = new Map();
    for (const [k, q] of subsQty) {
      const canon = alias.get(k) || k;
      effective.set(canon, (effective.get(canon) || 0) + q);
    }
    for (const [canon, info] of substitutedKeys) {
      const used = effective.get(canon) || 0;
      if (!used) continue;
      stats.substituted++;
      W('plan-substituted', `BOM 条目 ${info.design || info.substitute}（颜色 ${canon.split('|')[1]}）在 plan 里按 ${info.substitute} 计价，放行：${info.note ? info.note.slice(0, 120) : 'BOM 声明了 substituteFor'}`,
        { design: info.design, substitute: info.substitute, color: Number(canon.split('|')[1]), qty: used });
    }
    const missing = [], extra = [];
    for (const k of new Set([...official.keys(), ...effective.keys()])) {
      const q = official.get(k) || 0, have = effective.get(k) || 0;
      const [part, color] = k.split('|');
      if (have < q) missing.push({ part, color: Number(color), need: q - have, official: q, plan: have });
      else if (have > q) extra.push({ part, color: Number(color), excess: have - q, official: q, plan: have });
    }
    if (missing.length) E('plan-bom-missing', `plan 比官方 BOM 少 ${missing.reduce((a, x) => a + x.need, 0)} 件、涉及 ${missing.length} 类 (件号,颜色)：${cap(missing).map((x) => `${x.part}×${x.color} 缺 ${x.need}（BOM ${x.official}/plan ${x.plan}）`).join('、')}${missing.length > 12 ? ` 等 ${missing.length} 类` : ''}`, { missing: cap(missing), count: missing.length });
    if (extra.length) E('plan-bom-extra', `plan 比官方 BOM 多 ${extra.reduce((a, x) => a + x.excess, 0)} 件、涉及 ${extra.length} 类 (件号,颜色)：${cap(extra).map((x) => `${x.part}×${x.color} 多 ${x.excess}（BOM ${x.official}/plan ${x.plan}）`).join('、')}${extra.length > 12 ? ` 等 ${extra.length} 类` : ''}`, { extra: cap(extra), count: extra.length });
  } else if (bomData) {
    E('plan-bom-file', 'BOM 文件缺少 parts 数组（应为 brickkit-bom 格式）');
  }

  /* 模型漂移：模型实际 BOM vs plan 的 submodels 汇总 */
  const model = opts.model || null;
  if (model && Array.isArray(model.parts)) {
    const modelAgg = aggregateParts(model.parts);
    stats.modelTotalParts = totalQty(modelAgg);
    const modelQty = qtyMap(modelAgg);
    const planMissingInModel = [], modelOnly = [];
    for (const [k, q] of subsQty) {
      const have = modelQty.get(k) || 0;
      if (have < q) { const [part, color] = k.split('|'); planMissingInModel.push({ part, color: Number(color), plan: q, model: have }); }
      else if (have > q) { const [part, color] = k.split('|'); modelOnly.push({ part, color: Number(color), plan: q, model: have }); }
    }
    for (const [k, have] of modelQty) if (!subsQty.has(k)) { const [part, color] = k.split('|'); modelOnly.push({ part, color: Number(color), plan: 0, model: have }); }
    if (planMissingInModel.length || modelOnly.length) {
      E('plan-model-drift', `模型实际 BOM 与 plan 子模型汇总不符：模型共 ${stats.modelTotalParts} 件、plan 共 ${subsTotal} 件；${planMissingInModel.length} 类模型少于 plan（${cap(planMissingInModel).map((x) => `${x.part}×${x.color} plan ${x.plan}/模型 ${x.model}`).join('、') || '无'}），${modelOnly.length} 类模型多于 plan（${cap(modelOnly).map((x) => `${x.part}×${x.color} plan ${x.plan}/模型 ${x.model}`).join('、') || '无'}）`,
        { planTotal: subsTotal, modelTotal: stats.modelTotalParts, modelMissing: cap(planMissingInModel), modelExtra: cap(modelOnly) });
    }
  } else if (model) {
    E('plan-structure', '模型文件缺少 parts 数组（应为 brickbuild 格式）');
  }

  return { ok: errors.length === 0, errors, warnings, stats };
}
