// 由 inventory.json 派生「问题清单 + 增补优先级 + 下一批候选」。
// 只读 inventory.json / redirect-candidates.json；输出同目录 gaps.json 与 priority.json。
//
// 设计原则：不把「目录条数」当完成率。每条缺口都写清：
//   what（缺什么能力） / why（哪个用户任务需要） / blockers（要哪些证据才能算修好）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => JSON.parse(fs.readFileSync(path.join(HERE, f), 'utf8'));
const inv = read('inventory.json');
const ledger = read('inventory-parts.json');
const redirects = read('redirect-candidates.json');
const P = ledger.parts;
const byId = new Map(P.map((p) => [p.id, p]));

// ── 用户任务用件（来自 examples 与 BOM）
const taskModels = inv.tasks.models;
const usedBy = new Map();     // partId → [task names]
for (const [file, v] of Object.entries(taskModels)) {
  for (const id of v.ids) {
    if (!usedBy.has(id)) usedBy.set(id, []);
    const task = file.replace(/\.brick\.json$/, '');
    if (!usedBy.get(id).includes(task)) usedBy.get(id).push(task);
  }
}
const bomRows = [];
for (const [file, v] of Object.entries(inv.tasks.bomGaps)) {
  for (const r of v.unresolved) bomRows.push({ bom: file, ...r });
}

// ── 缺口分类（每类：定义、判据、逐件清单）
const gaps = [];

// G1 别名把「不同模具」当同一件：目录 id 与官方重定向目标接口不等价
// 判据含两路：连接器数量差（接口能力差）+ kind/名称差（模具身份差）。
const aliasAsym = inv.identity.aliases.filter((a) => {
  const d = a.connectorDelta;
  if (d && (d.studs !== 0 || d.receptors !== 0)) return true;
  if (!a.target) return false;
  return a.alias.kind !== a.target.kind;
});
gaps.push({
  id: 'G1-alias-interface-asymmetry',
  title: '别名映射把不同模具并成一件：目录 id 的连接器比官方目标少',
  severity: 'high',
  definition: 'OFFICIAL_ALIASES 只做文件名映射。当别名 id 的目录定义是「另一模具」时（例如 4589b 是圆锥、官方 4589 有轴孔），渲染用目标件网格、装配用别名条目，两者接口不一致。',
  criterion: '同一物理件的别名 id 与官方目标 id 的连接器集合（studs/receptors 的类型+数量+位置）一致，或显式拆成两个不同零件条目。',
  evidence: 'catalog/ldraw/README.md 已声明「别名仅是文件名映射，不代表零件识别确认」；本次盘点逐件量化了差异。',
  items: aliasAsym.map((a) => ({
    partId: a.id, officialId: a.officialId,
    catalogConnectors: a.alias, officialTargetConnectors: a.target,
    delta: a.connectorDelta,
    usedByTasks: usedBy.get(a.id) || [],
    note: a.id === '4589b' ? '官方 4589 有 2 个轴孔受体，目录别名条目 0 个：用 4589b 做轴穿件时引擎判「装不上」'
      : a.id === '553b' ? '官方 30367a 有 1 个顶凸点（standard stud），目录别名条目 0 个：叠件会判悬空'
        : 'kind 不同（clip vs plate），渲染与装配语义分歧',
  })),
});

// G2 官方别名/重定向件缺席：目标已在目录里，原编号查不到
const eqRec = redirects.equalAliasRecoverable || [];
gaps.push({
  id: 'G2-redirect-ids-absent',
  title: '官方重定向件（~Moved to）与官方别名件（=）的原编号在目录里查不到，目标件其实已在目录',
  severity: 'medium',
  definition: '件号是真实的、官方几何也在，只是搬到了新编号文件里（~Moved to）或同一件有另一个官方描述（=）。生成器已支持跟随一层重定向（tools/gen-parts-catalog.mjs 有未提交改动），但当前 catalog/parts-ldraw.json 尚未重生成。',
  criterion: '清单里的原编号能在 catalog 查询到，且条目带 movedTo 或 alias 字段、几何/连接器与目标件一致。',
  evidence: 'tools/gen-parts-catalog.mjs 未提交改动 + test/catalog-redirect.test.mjs（已通过，但用的是临时夹具库）证明能力存在；prod 数据未重生成。`=` 别名件需要另一条收敛路径（同描述素模 → alias），不能套 movedTo。',
  counts: {
    redirectFiles: redirects.totals.redirectFiles,
    redirectRecoverable: redirects.totals.recoverable,
    redirectTwoLevel: redirects.totals.byState['two-level-redirect'],
    redirectTargetFiltered: redirects.totals.byState['target-filtered-out'],
    equalAliasFiles: redirects.totals.equalAliasFiles,
    equalAliasRecoverable: eqRec.length,
    equalAliasTargetFiltered: redirects.totals.equalAliasByState['target-filtered-out'],
  },
  items: [
    ...redirects.recoverable.map((r) => ({
      partId: r.id, relation: 'moved-to', target: r.target,
      targetDescription: r.targetDesc, targetKind: r.targetKind,
      usedByTasks: (usedBy.get(r.id) || []).concat(usedBy.get(r.target) || []),
    })),
    ...eqRec.map((r) => ({
      partId: r.id, relation: 'equal-alias', target: r.target,
      targetDescription: r.description,
      usedByTasks: (usedBy.get(r.id) || []).concat(usedBy.get(r.target) || []),
    })),
  ],
  nextBatch: [
    ...redirects.recoverable
      .filter((r) => (usedBy.get(r.target) || []).length || (usedBy.get(r.id) || []).length)
      .map((r) => ({ partId: r.id, relation: 'moved-to', target: r.target, targetDescription: r.targetDesc })),
    ...eqRec
      .filter((r) => (usedBy.get(r.target) || []).length || (usedBy.get(r.id) || []).length)
      .map((r) => ({ partId: r.id, relation: 'equal-alias', target: r.target, targetDescription: r.description })),
  ].slice(0, 30),
});

// G3 精选/扩充同 id 身份分歧（合并时精选胜出，扩充实测接口被遮蔽）
gaps.push({
  id: 'G3-curated-ext-identity-conflict',
  title: '精选目录与扩充目录对同一件的外形/分类给出不同答案',
  severity: 'medium',
  definition: 'mergeCatalogParts 规定精选决定「这是什么」（kind/size/h），扩充只补连接器；逐件出现 49 件分歧。分歧本身不都是错——但未逐件判定哪边对，就有一半可能错。',
  criterion: '逐件以官方 .dat 主体盒定案（size/h 以实测为准），并把结论写回精选目录或建立显式 override。',
  evidence: 'src/core/core.js mergeCatalogParts + catalogInterfaceConflicts；本轮对 15 件做了三方尺寸核对（见 sizeFindings）。',
  items: inv.identity.identityConflictsCuratedVsExt.map((c) => ({ ...c, usedByTasks: usedBy.get(c.id) || [] })),
});

// G4 同名不同号：跨目录重复身份
gaps.push({
  id: 'G4-cross-catalog-duplicate',
  title: '同一个物理件在目录里有两个编号（精选旧号 + 扩充官方现行号）',
  severity: 'medium',
  definition: '例：3023（官方 ~Moved to 3023b）与 3023b 同时存在且都可用；4589b 与 4589 同名。用户/BOM 按任一编号调用都能命中，但两边的接口与 kind 可能不同。',
  criterion: '每个物理件的全部编号收敛到同一份定义（一个 canonical + N 个 alias），或明确判定两号确实是不同模具。',
  evidence: '本轮 crossCatalogDuplicates + duplicateIdentityClusters，并用官方 .dat 的 STUD 实例数做了逐簇核对。',
  items: [
    ...inv.identity.crossCatalogDuplicates.map((d) => ({ kind: 'cross-catalog', ...d, usedByTasks: usedBy.get(d.curatedId) || [] })),
    ...inv.identity.duplicateIdentityClusters.map((c) => ({ kind: 'same-name-cluster', ids: c.ids, key: c.key, usedByTasks: c.ids.flatMap((i) => usedBy.get(i) || []) })),
  ],
});

// G5 参数化回退：无专属几何分支，渲染成实心方块
const DISPATCH = new Set(['brick', 'plate', 'tile', 'jumper', 'technic', 'pinplate', 'corner', 'round', 'cone', 'dome', 'dish', 'cslope', 'arch', 'snot', 'bracket', 'barplate', 'clip', 'bar', 'wedge', 'cheese', 'slope', 'islope', 'ridge', 'panel', 'doorframe', 'door']);
const fallbackParts = P.filter((p) => !DISPATCH.has(p.kind));
gaps.push({
  id: 'G5-parametric-fallback',
  title: 'kind 没有专属几何分支，--geom param 下渲染成实心方块（含接头/夹口/凹腔件）',
  severity: 'medium',
  definition: 'src/viewer/geom.js 的 kind 分派缺一条就落到 else 分支的实心 box。带真实网格时可掩盖，但 param 回退、缩略图与未入库 .dat 的场景会暴露。',
  criterion: '该件在 param 模式下的外形可辨识（底面空腔、侧凹、夹口、轴孔至少有一种几何表达），或显式标注「无参数化几何，必须走 ldraw 网格」。',
  evidence: 'src/viewer/geom.js:55-250 的 kind 分派表；本轮统计 1801 件无分支。其中 11 件已被 examples 模型实际引用。',
  counts: { fallback: fallbackParts.length, total: P.length, usedByTasks: fallbackParts.filter((p) => usedBy.has(p.id)).length },
  items: fallbackParts
    .filter((p) => usedBy.has(p.id))
    .map((p) => ({ partId: p.id, kind: p.kind, name: p.name, usedByTasks: usedBy.get(p.id) })),
  backlog: { note: '其余 1790 件按同一判据排队；优先取 examples/BOM 未覆盖但照片重建高频的件（见 nextBatch）。' },
});

// G6 碰撞无分解盒：partBoxes 抛错或标记 needsManualBoxes
const collUnsupported = P.filter((p) => p.collision.state === 'unsupported');
gaps.push({
  id: 'G6-collision-unsupported',
  title: '碰撞盒不可用：bracket 缺 vH/dir 直接抛错，needsManualBoxes 退回「不判定」',
  severity: 'high',
  definition: 'needsManualBoxes 表示射线采样采空（覆盖率 < 0.7），退回单实心盒会把内腔封死；bracket 缺 vH/dir 则完全拒绝生成盒（保守，但该件不能参与 validate）。两者都要么补齐真实分解盒，要么明确标注「不可装配」。',
  criterion: '每件的 partBoxes 不抛错，且 boxes 覆盖率 ≥ 0.7（或声明 occupies:false / 已被判为不可碰撞件）；bracket 有实测 vH/dir/sideRows。',
  evidence: 'src/core/core.js partBoxes 守卫 + catalog-audit 的 boxesCoverageRejected 计数。',
  counts: {
    unsupportedTotal: collUnsupported.length,
    bracketThrows: collUnsupported.filter((p) => p.collision.error).length,
    needsManualBoxes: collUnsupported.filter((p) => p.fields.needsManualBoxes).length,
    usedByTasks: collUnsupported.filter((p) => usedBy.has(p.id)).length,
  },
  items: collUnsupported.map((p) => ({
    partId: p.id, kind: p.kind, name: p.name,
    reason: p.collision.error ? 'threw' : 'needsManualBoxes',
    usedByTasks: usedBy.get(p.id) || [],
  })),
  bracketThrows: collUnsupported.filter((p) => p.collision.error).map((p) => p.id),
});

// G7 定义性接口缺失：名字里有夹/铰/把手/侧凸点，连接器却只有 top/antistud
// 注意不要把 "Technic" 前缀本身算作定义性特征——248 件只因名字以 Technic 开头就被命中，
// 那是品类词不是接口词（本盘点第一版因此把 640 报成缺口，实际接口词命中只有 392）。
const DEFINING = /\bclip\b|\bhinge\b|studs? on|\bturntable\b|\bball joint\b|\bsocket\b|\bhandle\b|\bbar\b|\bpin\b|\baxle\b/i;
const WEAK_KIND = new Set(['other', 'plate', 'brick', 'tile', 'panel', 'doorframe', 'jumper', 'ridge', 'cheese', 'hinge', 'technic']);
const definingGaps = P.filter((p) => {
  if (!DEFINING.test(p.name)) return false;
  if (!WEAK_KIND.has(p.kind)) return false;
  const articulation = p.connectors.studKinds.concat(p.connectors.receptorKinds);
  return !articulation.some((k) => ['bar', 'clip', 'pin', 'hole', 'axle', 'side', 'rim', 'tyre'].includes(k));
});
gaps.push({
  id: 'G7-defining-interface-missing',
  title: '名称点明的定义性接口没有任何连接器表达（夹口/铰链指端/把手/侧凸点/转盘）',
  severity: 'high',
  definition: '机查（connectors 一条）只验证「显式字段 1:1 兑现」，不判「该有而没有」。这类件因此全部机查通过却只能当装饰块用。',
  criterion: '名称里的定义性特征在 partConnectors 输出里有对应 kind（clip/bar/pin/hole/axle/side/turntable），或被显式标 needsManual 且从装配候选里排除。',
  evidence: 'docs/扩充目录全量审计.md 第五节已点名同一类问题（hinge 族指端、axle 公头）；本轮把它量化到全库并按 kind 分组。',
  counts: {
    total: definingGaps.length,
    note: '第一版曾报 640，其中 248 件只因名称以 "Technic" 开头被命中（品类词不是接口词）；已剔除。',
    hingeCategoryWithoutArticulation: P.filter((p) => p.category === 'hinge' && !p.connectors.studKinds.concat(p.connectors.receptorKinds).some((k) => ['bar', 'clip', 'pin', 'hole', 'axle'].includes(k))).length,
    usedByTasks: definingGaps.filter((p) => usedBy.has(p.id)).length,
  },
  items: definingGaps.map((p) => ({ partId: p.id, kind: p.kind, category: p.category, name: p.name, usedByTasks: usedBy.get(p.id) || [] })),
});

// G8 完全无连接器
const noConn = P.filter((p) => p.connectors.origin === 'none');
gaps.push({
  id: 'G8-no-connectors',
  title: '0 凸点 0 受体：既不能安装在别的件上，也不能承托任何件',
  severity: 'medium',
  definition: '这类件在装配求解里是孤岛。有的是物理事实（软管端头、贴纸载体），有的是提取漏项（轮/胎同心、转盘上下盘）。',
  criterion: '逐件判定「物理上确实无接口」或「接口类型未被白名单覆盖」，后者需新增 kind 与配对规则。',
  evidence: '本轮 connectors.origin=none 全量枚举（653 件）。',
  counts: { total: noConn.length, byKind: noConn.reduce((a, p) => { a[p.kind] = (a[p.kind] || 0) + 1; return a; }, {}), usedByTasks: noConn.filter((p) => usedBy.has(p.id)).length },
  items: noConn.map((p) => ({ partId: p.id, kind: p.kind, name: p.name, usedByTasks: usedBy.get(p.id) || [] })),
});

// G9 几何硬冲突（官方 .dat 实测与目录 h 不符，超出量化容差）
const geoFail = P.filter((p) => p.geometryCheck.status.startsWith('FAIL'));
gaps.push({
  id: 'G9-geometry-height-mismatch',
  title: '官方 .dat 主体盒高度与目录 h 不符，且不属「片数量化」或「功能性外挑」豁免',
  severity: 'medium',
  definition: '这些件的 h 用来算层高与包围盒。偏低会把零件压进层里（穿模假阴性），偏高会把上方零件抬起（悬空假阳性）。',
  criterion: '每件按官方实测改 h，或在生成器白名单里给出书面豁免理由（并在报告里可追溯）。',
  evidence: '本轮按 catalog-audit 同口径（bodyBoxFromText + verifyPart + ±4.5 LDU 量化 + featureKind 豁免）复算，得 48 件（历史 audit-full 为 58 件，差额来自 2026-10-27 的 11211/22885/99206 等修正与目录重生成）。',
  counts: { total: geoFail.length, usedByTasks: geoFail.filter((p) => usedBy.has(p.id)).length },
  items: geoFail.map((p) => ({ partId: p.id, kind: p.kind, name: p.name, status: p.geometryCheck.status, expectedY: p.geometryCheck.expectedY, measuredY: p.geometryCheck.measuredY, usedByTasks: usedBy.get(p.id) || [] })),
});

// G10 类别误分
gaps.push({
  id: 'G10-category-misclassification',
  title: 'kind/category 与官方名称不一致（转盘归 hinge、侧凸点砖归 other、圆砖归 brick…）',
  severity: 'low',
  definition: 'kind 驱动几何分支、碰撞生成与凸点判定。误分的直接后果是渲染成通用外形、或凸点按错误规则生成。',
  criterion: 'kind 与官方 !CATEGORY/名称一致，或在映射表里有显式条目（例：Dish→dish 而非 round）。',
  evidence: 'tools/gen-parts-catalog.mjs mapCat 的兜底 "other" + kind 二次归类规则；官方 .dat 里仅 6292/24856 文件带 !CATEGORY，其余靠名称正则。',
  counts: { rawMismatches: 190, note: '190 条是「名称期望 A、kind 为 B」的启发式命中，不全是错（corner/islope/cheese 等是更细的分类）。需逐簇人工定案。' },
  items: [
    { cluster: 'turntable 归 hinge', ids: P.filter((p) => /turntable/i.test(p.name) && p.category === 'hinge').map((p) => p.id) },
    { cluster: 'Studs on N Sides 归 other/brick（正解 snot）', ids: P.filter((p) => /studs on/i.test(p.name) && !['snot'].includes(p.kind)).slice(0, 20).map((p) => p.id) },
    { cluster: 'Dish 归 round/jumper（正解 dish）', ids: P.filter((p) => /^dish\b/i.test(p.name) && p.kind !== 'dish').map((p) => p.id) },
    { cluster: 'Wedge 归 other（正解 wedge）', ids: P.filter((p) => /^wedge\b/i.test(p.name) && p.kind !== 'wedge').map((p) => p.id) },
    { cluster: 'Clip 件归 plate/tile（正解 clip）', ids: P.filter((p) => /\bclip\b/i.test(p.name) && !['clip', 'barplate', 'hinge'].includes(p.kind)).slice(0, 25).map((p) => p.id) },
  ],
});

// G11 合并遗留字段：精选目录里的生成器标记
gaps.push({
  id: 'G11-merge-residue',
  title: '精选目录里残留生成器字段（auto/source/boxesSource）',
  severity: 'low',
  definition: '50745、60477 是从扩充目录手工提升的件，仍带 auto:true / source:「自动提取」/ boxesSource。资产库据此把它们判成 extracted 语义的来源说明与 curated 优先的合并规则冲突。',
  criterion: '精选条目不携带 auto/source 之类生成器元数据；来源信息只出现在资产定义的 source 段。',
  evidence: '本轮逐件扫描 merged 目录的 fields.auto / source 文本。',
  items: P.filter((p) => p.source === 'curated' && (p.fields.auto || /自动提取/.test(p.fields.sourceText || ''))).map((p) => ({ partId: p.id, name: p.name, auto: p.fields.auto, boxesSource: p.fields.boxesSource })),
  extra: ['50745', '60477'],
});

// G12 人仔体系只有 4 件、且非白名单一律过滤
gaps.push({
  id: 'G12-minifig-family-thin',
  title: '人仔体系覆盖极薄：全库仅 4 件带人仔接口（category=minifig 的只有 3 件），其余 1,406 件被过滤',
  severity: 'low',
  definition: '生成器 skip.minifig=1,406。60239 的 7 个 catalogGaps 里 4 个是人仔件，靠 BOM_NEED_WHITELIST 逐件放行。全库带人仔接口的仅 4 件：11303（帽）、76382（躯干）、3626b（头）、73200（胯/腿，category 记为 other 但带 minifig.pegs）。',
  criterion: '人仔体系按「腿+胯+躯干+头+帽」的最小可装配闭环覆盖，且接口走 minifig peg/socket 而非 top/antistud。',
  evidence: 'tools/gen-parts-catalog.mjs BOM_NEED_WHITELIST 与 MINIFIG_STANDARD 表；本盘点按 category==="minifig" 或 fields.minifig 双路识别，得 4 件（只看 category 会漏 73200）。',
  counts: {
    // 按接口认而不是只按 category 认：73200 分类是 other，但带 minifig:{pegs}，属人仔体系。
    // 只看 category 会漏掉它，把 4 件报成 3 件。
    shippedWithMinifigInterface: P.filter((p) => p.category === 'minifig' || p.fields.minifig).length,
    byCategoryMinifig: P.filter((p) => p.category === 'minifig').length,
    skipped: 1406, whitelisted: 5,
  },
  items: P.filter((p) => p.category === 'minifig' || p.fields.minifig).map((p) => ({ partId: p.id, category: p.category, kind: p.kind, name: p.name, connectors: p.connectors })),
});

// ── 增补优先级（按「用户任务阻塞度 × 证据成本」排序，不按数量）
const priority = [
  {
    rank: 1, gapId: 'G1-alias-interface-asymmetry', tier: 'P0',
    why: '别名差异直接制造「渲染对、装不上」。4589b 在 trex BOM 里 qty 6、553b qty 2，都是白名单替代件的替代件；再用它们做轴穿/叠件就会静默失败。',
    action: '拆成独立条目（4589b/553b/4085d 各自 geometry+connectors），或把 OFFICIAL_ALIASES 的值改成「只用于渲染网格」的显式字段，装配语义不跟随。',
    needs: ['官方 .dat 主体盒与连接器实测（已有）', '逐件确认实物模具（照片或 BOM 的 designId）', 'trex BOM 映射复核'],
    cost: 'S（3 件，纯数据）',
  },
  {
    rank: 2, gapId: 'G6-collision-unsupported', tier: 'P0',
    why: '60239 已验收模型里有 6 件碰撞不可用（11208/11209/11303/73081/29119/29120），其中车轮轮毂与轮胎是整车的支撑结构；mecha 的 bracket 抛错会直接阻塞 validate。',
    action: '优先给「examples/BOM 已用」的 6 件补真实分解盒；bracket 的 8 件按 2436a 先例从 .dat 实测 vH/dir/sideRows。',
    needs: ['官方 .dat 双向高度图重跑（boxes 覆盖率 ≥ 0.7）', '轮胎/轮毂的 wheel 语义复核（outer/bore/cy）', '补完后 60239 validate 与渲染回归'],
    cost: 'M（8 件 bracket 批量 + 6 件逐件采样策略调参）',
  },
  {
    rank: 3, gapId: 'G7-defining-interface-missing', tier: 'P1',
    why: '夹口/铰链指端/转盘是「可开合机关」这一整条用户任务的物理基础。现在 3937/3938/30365 铰链件只有 top/antistud，装配能「粘住」但没有真实轴——mecha 的 mech-axis 报错正是这个根因的另一面。',
    action: '按形态分批：① hinge 指端/夹口（clip1-16 图元已在白名单，需扩到 finger/boss 图元）；② turntable 上下盘（18938/18939 已有 hole，缺盘间同心轴）；③ 球头/球窝（14417/14418 已实测 bars，缺 socket 受体类型）。',
    needs: ['新增 primitives 白名单：finger/boss/ball/socket', '新增连接器 kind 与 connectorPairMatches 配对规则', '每类至少一对正/负夹具（沿用 EN-05 四夹具范式）'],
    cost: 'L（引擎改动 + 夹具 + 全库重生成）',
  },
  {
    rank: 4, gapId: 'G3-curated-ext-identity-conflict', tier: 'P1',
    why: '49 件分歧里 15 件被 examples/BOM 实际引用。size 差一格就会让 snap 坐标错位一整格（60478/63868 的 size 轴互换已由 *Frame 机制兜住，但其余 14 件没有等价保护）。',
    action: '用官方 .dat 主体盒逐件定案，把结论写进精选条目；对 size 轴互换的件确认 *Frame 是否已生效。',
    needs: ['三方尺寸对照（本轮已有脚本 probe-size.mjs）', '每件渲染+snap 抽查', '修正后的模型联动重建（60478/63868 在 mecha 中在用）'],
    cost: 'M',
  },
  {
    rank: 5, gapId: 'G2-redirect-ids-absent', tier: 'P1',
    why: '670 个真实件号查不到（403 条 ~Moved to + 267 条 = 别名），其中 101→3623（trex BOM qty 3）、11153→61678（AGENTS.md 已知冲突件）等直接对上用户任务。修复成本几乎为零：生成器能力已写好，只差重生成 + 验收。',
    action: '① 合并未提交的生成器改动 → 重跑 gen-parts-catalog（覆盖 403 条 movedTo）；② `=` 别名件另走 alias 收敛（同描述素模已在目录，不需重定向）；③ 校验每条的几何/连接器与目标件一致；④ 更新 catalog-verify 与 audit。',
    needs: ['parts-ldraw.json 重生成（体积 +约 670 条目）', '体积/性能对照（当前 6.8MB / 4605 条）', 'test/catalog-redirect.test.mjs 改为对 prod 数据断言', '`=` 类别需确定「alias 字段」schema（现有 buildAliases 只认 officialId）'],
    cost: 'S（一条命令 + 验收）；风险：重生成会刷新全库 extracted 字段，需 diff 审查',
  },
  {
    rank: 6, gapId: 'G9-geometry-height-mismatch', tier: 'P2',
    why: '48 件高度错，其中 0 件被 examples 直接引用 → 不在关键路径。但它们是「看起来机查通过、实际层高错」的隐患。',
    action: '按形态分组处理：6 件扁平线缆件直接改 h；42 件凸出件扩 featureKind 白名单或成组实测。',
    needs: ['分组白名单决策', 'catalog-verify 重跑'],
    cost: 'M',
  },
  {
    rank: 7, gapId: 'G5-parametric-fallback', tier: 'P2',
    why: '1801 件在 param 模式下是实心方块。真实网格可用时不影响交付，但缩略图/param 回退/未镜像环境会退化。其中 11 件已被模型引用（28324 座舱、11208/11209 轮组、43722a/43723a 楔形）。',
    action: '优先给已用 11 件加专属分支；再按「照片重建高频形态」（轮/胎、斜面、夹板、座舱）扩。',
    needs: ['每个 kind 一份参数化几何 + 凸点/凹腔表达', 'param vs ldraw 对照渲染', '不得用「加了标牌」代替外形'],
    cost: 'L（逐 kind）',
  },
  {
    rank: 8, gapId: 'G8-no-connectors', tier: 'P2',
    why: '653 件孤岛。多数是物理事实，但轮/胎、转盘、软管端头属于「应有接口而没提取」。',
    action: '按 kind 分组判定：other 371 件人工过一遍；technic 260 件核查是否漏了 hole/axle。',
    needs: ['逐组判定表（物理无接口 vs 提取漏项）', '漏项需扩 primitives'],
    cost: 'M',
  },
  {
    rank: 9, gapId: 'G4-cross-catalog-duplicate', tier: 'P2',
    why: '7 个同名簇里 3 个是同一物理件两个编号（3023/3023b、4589/4589b、4085c 家族），其余 4 个（2437/57783、2577/48092、2629/71772、41761/42021、45411/56204）官方仍是两个独立文件、凸点数量不同（2577=11 vs 48092=3；2629=128 vs 71772=32），说明是**真实不同模具**，不应合并。',
    action: '只处理「确为同一物理件」的簇；差异簇写入说明，防止后人误合并。',
    needs: ['逐簇官方 .dat 凸点实例核对（本轮已完成 14 件）', '3023→3023b 的 canonical 决策'],
    cost: 'S',
  },
  {
    rank: 10, gapId: 'G10-category-misclassification', tier: 'P3',
    why: '影响渲染分支与凸点规则，但多数件已有真实网格兜住外形。',
    action: '先修会改变凸点数量的簇（Studs on N Sides → snot；Dish → dish），其余记录。',
    needs: ['逐簇人工定案', 'kind 变更后重跑 audit'],
    cost: 'M',
  },
  {
    rank: 11, gapId: 'G11-merge-residue', tier: 'P3',
    why: '数据卫生，无功能影响。',
    action: '删 50745/60477 的 auto/source/boxesSource，或在合并层忽略。',
    needs: ['assets-v1 重编译（contentHash 会全库变，需重新冻结 assetLock）'],
    cost: 'S，但会触发全库 contentHash 变更',
  },
  {
    rank: 12, gapId: 'G12-minifig-family-thin', tier: 'P3',
    why: '60239 有 7 个 catalogGaps，其中 4 个人仔件靠白名单。除非继续做带人仔的套装，否则不阻塞。',
    action: '若继续 60239/城市类套装：把 MINIFIG_STANDARD 从 4 件扩到完整人仔闭环；否则维持白名单逐件放行。',
    needs: ['人仔接口夹具（peg↔socket 已验证 4/4 正例？实际无夹具）', '逐件 BOM 需求'],
    cost: 'M',
  },
];

// ── 下一批候选（按「能补什么能力 + 需要哪些证据」写）
const nextBatch = [
  {
    batch: 'B1', goal: '让别名件真正可装配（G1）', parts: ['4589b', '553b', '4085d'],
    capability: '轴穿圆锥（trex 背棘）、可叠穹顶（替代件）、竖直夹装配',
    models: ['catalog/parts.json 3 条', '或 catalog/parts-ldraw.json 拆条目'],
    connectors: ['4589b 需 axleHoles×2（官方 4589 实测 y=0.3/0.6）', '553b 需 top stud×1（官方 30367a 实测）', '4085d 与 4085a/b/c 的夹口差异需实物定案'],
    collision: ['沿用现有单盒（3 件都是网格件）'],
    acceptance: ['trex BOM 映射复核', '单件 snap 正/负例', '渲染与 ldraw 网格一致'],
  },
  {
    batch: 'B2', goal: '让 60239 的轮组与风挡可碰撞（G6 子集）', parts: ['11208', '11209', '29119', '29120', '11303', '73081'],
    capability: '整车可 validate、轮组可扣合、风挡侧板不穿模',
    models: ['catalog/parts-ldraw.json 6 条 boxes'],
    connectors: ['11208/11209 wheel 语义已有，需确认 bore/outer/cy', '29119/29120 需 side studs 或 clip'],
    collision: ['双向高度图重跑并接受 coverage ≥ 0.7；否则显式 occupies 策略'],
    acceptance: ['60239.fixed validate 0 errors 0 warnings', '四向正交渲染', 'EN-05 夹具补这 6 件'],
  },
  {
    batch: 'B3', goal: '解锁支架（G6 bracket 8 件）', parts: ['3956', '4585', '4598', '30250', '30263', '42446', '48724', '28974a'],
    capability: 'SNOT 转接主力件可用于装配，mecha 类模型不再因 partBoxes 抛错而阻塞',
    models: ['catalog/parts-ldraw.json 8 条'],
    connectors: ['vH/dir/sideRows 从官方 .dat 实测（2436a 先例）'],
    collision: ['partBoxes 不再抛错，竖板双盒非退化'],
    acceptance: ['builder 单件放置通过', 'catalog-audit assembly 转绿', 'SNOT 侧装夹具一组正/负例'],
  },
  {
    batch: 'B4', goal: '恢复真实件号（G2）', parts: ['403 条 ~Moved to RECOVERABLE', '267 条 = 别名 RECOVERABLE'],
    capability: '用户按实物件号直接查得到（101→3623、11153→61678、10201→2436b…），BOM 不再需要人工映射',
    models: ['catalog/parts-ldraw.json 重生成（movedTo 路径）', '`=` 类别需 alias 字段（不能套 movedTo：官方保留两个文件）'],
    connectors: ['movedTo 继承目标件（生成器已实现）', '`=` 类别应共享目标件的几何与连接器，但保留自己的件号'],
    collision: ['继承目标件 boxes'],
    acceptance: ['403 + 267 条逐条与目标件字段一致', '体积/启动耗时对照', 'redirect 测试改用 prod 数据', 'catalog 查询按任一件号命中'],
  },
  {
    batch: 'B5', goal: '夹/铰/球头真实轴（G7 第一批）', parts: ['3937', '3938', '30365', '65146', '14417', '14418', '2650', '2651'],
    capability: '可开合机构（mecha 翼、60239 车门/引擎盖）有真实铰接轴，不再靠两个夹板冒充关节',
    models: ['src/ldraw/ldraw.js primitives 白名单', 'src/core/core.js connectorPairMatches'],
    connectors: ['新增 finger/boss/ball/socket 类'],
    collision: ['铰接件保持多盒分解，豁免规则需重新核对'],
    acceptance: ['每类一对正/负夹具（4 夹具范式）', 'mecha mech-axis 缺陷清单缩减', '实物/照片核对接头形态'],
  },
];

const outGaps = {
  generatedAt: new Date().toISOString(),
  scope: '只读盘点派生物：未修改 catalog/、别名映射或网格包',
  basis: 'audit/part-taxonomy-2026-10-31/inventory.json + redirect-candidates.json',
  taskUsage: {
    models: Object.fromEntries(Object.entries(taskModels).map(([f, v]) => [f, { parts: v.parts, missing: v.missing }])),
    bomUnresolved: bomRows,
  },
  gaps: gaps.map((g) => ({ ...g, itemCount: Array.isArray(g.items) ? g.items.length : 0 })),
};
const outPriority = {
  generatedAt: new Date().toISOString(),
  rule: 'P0 = 已验收模型/关键路径阻塞；P1 = 解锁一整类用户任务；P2 = 质量债；P3 = 数据卫生。rank 只在同 tier 内排序。不以条数计完成率。',
  priority,
  nextBatch,
};

fs.writeFileSync(path.join(HERE, 'gaps.json'), JSON.stringify(outGaps, null, 1));
fs.writeFileSync(path.join(HERE, 'priority.json'), JSON.stringify(outPriority, null, 1));
console.log(JSON.stringify({
  gaps: gaps.map((g) => `${g.id}: ${g.itemCount}${g.counts ? ' ' + JSON.stringify(g.counts) : ''}`),
  priorityRanks: priority.map((p) => `${p.tier} ${p.gapId}`),
  nextBatch: nextBatch.map((b) => b.batch + ' ' + b.goal),
}, null, 1));
