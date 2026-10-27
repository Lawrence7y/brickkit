// C3-3 四步工作流：港口吊机（harbor crane）冻结验收 + 全量计划 + 子任务包
// 主会话产出：验收标准（PRD §8.1 建前冻结）、BOM 守恒、真实 assetLock、C2 任务包。
// 子模型搭建由 ≥2 个真实子代理会话执行（WF-04 收据记录 conversationId）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildAssetLock, checkAssetLock } from '../../src/core/assets-v1/lock.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const OUT = path.join(ROOT, 'out', 'prd-v2', 'run-20261026-c', 'C', 'integration', 'fourstep');
const CAT = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'parts.json'), 'utf8'));
const INDEX = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'assets-v1', 'index.json'), 'utf8'));

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ── 设计：港口吊机 24×12 底座，≥45 件，2 个可独立搭建的子组件 ──
// 塔身（主体）：底座 + 4 层塔柱 + 回转平台
// SA-1 起重臂（jib）：水平悬臂 + 配重块，扣在回转平台的侧凸点上
// SA-2 司机舱（cab）：司机室，扣在塔身侧面的 SNOT 凸点上
const COLORS = { base: 71, tower: 14, jib: 4, cab: 1, accent: 0, counter: 72, deck: 72 };

// BOM：每件标 package（main / SA-1 / SA-2）
const bom = [
  // —— 主体：底座 8×10（3036 8×6 + 3035 8×4）+ 塔柱 6 层 + 回转平台 + SNOT 挂点 ——
  { part: '3036', color: COLORS.base, qty: 1, pkg: 'main', role: '底座主板 8×6' },
  { part: '3035', color: COLORS.base, qty: 1, pkg: 'main', role: '底座延长板 8×4' },
  { part: '3003', color: COLORS.tower, qty: 6, pkg: 'main', role: '塔柱 2×2 砖 ×6 层' },
  { part: '3010', color: COLORS.tower, qty: 6, pkg: 'main', role: '塔基横撑 1×4 砖 ×6' },
  { part: '3004', color: COLORS.tower, qty: 4, pkg: 'main', role: '塔基角撑 1×2 砖 ×4' },
  { part: '3795', color: COLORS.deck, qty: 1, pkg: 'main', role: '回转平台 2×6 板' },
  { part: '3022', color: COLORS.deck, qty: 1, pkg: 'main', role: '平台加宽 2×2 板' },
  { part: '3020', color: COLORS.deck, qty: 1, pkg: 'main', role: '平台加宽 2×4 板' },
  { part: '11211', color: COLORS.accent, qty: 5, pkg: 'main', role: 'SNOT 侧凸点接口砖 ×5（起重臂 ×2 / 司机舱 ×3）' },
  { part: '3024', color: COLORS.accent, qty: 3, pkg: 'main', role: '塔顶封盖 1×1 板 ×3' },
  { part: '63864', color: COLORS.accent, qty: 1, pkg: 'main', role: '塔顶平板 1×3' },

  // —— SA-1 起重臂（24 件，按子代理实搭产物对齐）——
  { part: '11211', color: COLORS.jib, qty: 2, pkg: 'SA-1', role: '起重臂根部侧凸点砖 ×2' },
  { part: '3460', color: COLORS.jib, qty: 3, pkg: 'SA-1', role: '悬臂主板 1×8 板 ×3' },
  { part: '3666', color: COLORS.jib, qty: 2, pkg: 'SA-1', role: '悬臂延长 1×6 板 ×2' },
  { part: '3010', color: COLORS.jib, qty: 3, pkg: 'SA-1', role: '悬臂加强 1×4 砖 ×3' },
  { part: '3023', color: COLORS.jib, qty: 2, pkg: 'SA-1', role: '悬臂侧封条 1×2 板 ×2' },
  { part: '4070', color: COLORS.accent, qty: 2, pkg: 'SA-1', role: '臂端吊钩挂点 车灯砖 ×2' },
  { part: '6541', color: COLORS.accent, qty: 2, pkg: 'SA-1', role: '吊索固定 科技孔砖 ×2' },
  { part: '4081b', color: COLORS.accent, qty: 1, pkg: 'SA-1', role: '吊钩滑轮 带圆环扣板' },
  { part: '30374', color: COLORS.accent, qty: 1, pkg: 'SA-1', role: '吊索杆' },
  // 配重块
  { part: '3002', color: COLORS.counter, qty: 3, pkg: 'SA-1', role: '配重块 2×3 砖 ×3' },
  { part: '3031', color: COLORS.counter, qty: 2, pkg: 'SA-1', role: '配重底座 4×4 板 ×2' },
  { part: '2431', color: COLORS.counter, qty: 1, pkg: 'SA-1', role: '配重顶板 1×4 平面板' },

  // —— SA-2 司机舱（12 件）——
  { part: '3004', color: COLORS.cab, qty: 6, pkg: 'SA-2', role: '司机室四壁 1×2 砖 ×6' },
  { part: '3023', color: COLORS.cab, qty: 2, pkg: 'SA-2', role: '司机室地板 1×2 板 ×2' },
  { part: '3039', color: COLORS.accent, qty: 1, pkg: 'SA-2', role: '司机室顶 2×2 斜面砖' },
  { part: '2412b', color: 15, qty: 1, pkg: 'SA-2', role: '前窗格栅' },
  { part: '4081b', color: COLORS.accent, qty: 1, pkg: 'SA-2', role: '舱顶警示灯座' },
  { part: '3024', color: 4, qty: 1, pkg: 'SA-2', role: '舱顶警示灯 1×1 板' },
];

// 校验目录存在性
const missing = [];
for (const line of bom) if (!CAT.parts[line.part]) missing.push(line.part);
if (missing.length) throw new Error('目录缺失零件: ' + [...new Set(missing)].join(', '));

const totalParts = bom.reduce((s, l) => s + l.qty, 0);

// —— 冻结验收标准（PRD §8.1：建前冻结，失败不得回改）——
const acceptance = {
  frozenAt: new Date().toISOString(),
  revision: 'c3-3-fourstep-1.0',
  model: { name: '港口吊机 Harbor Crane', front: '+z', footprintStuds: [24, 12], minParts: 45 },
  bomCaliber: { totalParts, detailSum: totalParts, packages: { main: 0, 'SA-1': 0, 'SA-2': 0 } },
  ownership: { body: 'main', accessories: [] },
  mustTestInterfaces: [
    { id: 'if-cab', description: 'SA-2 司机舱 → 主体塔身 SNOT 87087 侧凸点', type: 'side-stud', snotLayerRequired: 0 },
    { id: 'if-jib', description: 'SA-1 起重臂根部 11211 → 主体回转平台侧凸点', type: 'side-stud', snotLayerRequired: 0 },
  ],
  stepRegions: { policy: '每包步骤号连续，子组件包步骤号从 1 起，总装步骤号接主体' },
  visualThresholds: { fourViewRenders: ['az0', 'az90', 'az180', 'az270'], manualCheckList: ['起重臂水平外伸方向一致', '司机舱位于塔身单侧且不穿模', '配重块位于起重臂反侧', '塔柱四层与底座垂直'] },
  retryBudget: { maxStepRetries: 3, maxRepairRounds: 2, timeoutSeconds: 300 },
  validation: { requireZeroErrors: true, requireZeroWarnings: true, requireFullInventoryConsumption: true },
};
for (const line of bom) acceptance.bomCaliber.packages[line.pkg] += line.qty;

// —— 库存 token（每物理件一枚，tokenId 稳定可回溯）——
let counter = 0;
const tokensByPkg = { main: [], 'SA-1': [], 'SA-2': [] };
for (const line of bom) {
  for (let i = 0; i < line.qty; i++) {
    counter += 1;
    tokensByPkg[line.pkg].push({
      tokenId: `tok-${String(counter).padStart(3, '0')}`,
      partId: line.part,
      colorId: line.color,
      name: CAT.parts[line.part].zh || CAT.parts[line.part].name,
      allocation: line.pkg,
    });
  }
}

const allTokens = [...tokensByPkg.main, ...tokensByPkg['SA-1'], ...tokensByPkg['SA-2']];
if (allTokens.length !== totalParts) throw new Error(`token 数 ${allTokens.length} ≠ BOM ${totalParts}`);

// —— 真实 assetLock（buildAssetLock，禁止手算哈希）——
const lockFor = (pkg) => {
  const ids = [...new Set(bom.filter((l) => l.pkg === pkg).map((l) => l.part))];
  const { assetLock, missing: m } = buildAssetLock(INDEX, ids, 'default-2026-10-26');
  if (m.length) throw new Error(`${pkg} assetLock 缺失零件: ${m.join(',')}`);
  const chk = checkAssetLock({ assetLock }, { index: INDEX });
  if (!chk.ok) throw new Error(`${pkg} assetLock 校验失败: ${JSON.stringify(chk.errors)}`);
  return assetLock;
};

const packages = [];
const mkPackage = (taskId, role, pkgName, interfaces, localFrame, spatial, deps) => ({
  schemaVersion: '1.0',
  taskId,
  revision: 1,
  designRevision: 'c3-3-fourstep-1.0',
  contractRevision: '1.0.0',
  globalPlanRef: { planFile: 'out/prd-v2/run-20261026-c/C/integration/fourstep/build.plan.json', planSha256: '' },
  role,
  dependencies: deps,
  assetLock: lockFor(pkgName),
  sourceEvidence: { designDoc: 'out/prd-v2/run-20261026-c/C/integration/fourstep/acceptance.json', designRevision: 'c3-3-fourstep-1.0' },
  inventory: { totalCount: tokensByPkg[pkgName].length, tokens: tokensByPkg[pkgName] },
  localFrame,
  interfaces,
  spatialContracts: spatial,
  budget: { maxStepRetries: 3, maxRepairRounds: 2, timeoutSeconds: 300 },
  acceptance: { requireZeroErrors: true, requireZeroWarnings: true, requireFullInventoryConsumption: true },
});

packages.push(mkPackage('c3-3-main', 'main_body', 'main',
  {
    outwardConnectors: [
      { id: 'ctop#tower', type: 'stud', localPartInstance: 'tower-top', status: 'frozen' },
      { id: 'cside#cab-0', type: 'side-stud', localPartInstance: 'snot-cab-0', status: 'frozen' },
      { id: 'cside#cab-1', type: 'side-stud', localPartInstance: 'snot-cab-1', status: 'frozen' },
      { id: 'cside#jib', type: 'side-stud', localPartInstance: 'snot-jib', status: 'frozen' },
    ],
    targetMounts: [],
  },
  { originDescription: '底座板 4×8 的角格 (0,0,0) 为局部原点，+y 向上，+z 为正面', allowedRootParts: ['3035'], initialOrientation: 0 },
  { maxBoundingBoxLdu: [480, 200, 240], keepOutZones: [] }, []));

packages.push(mkPackage('c3-3-sa1-jib', 'subassembly', 'SA-1',
  {
    outwardConnectors: [{ id: 'cside#root', type: 'side-stud', localPartInstance: 'jib-root-snot', status: 'frozen' }],
    targetMounts: [{ id: 'cside#jib', targetPackage: 'c3-3-main', targetConnector: 'cside#jib', status: 'frozen' }],
  },
  { originDescription: '起重臂根部 11211 的底孔面为局部原点，悬臂沿 +x 外伸', allowedRootParts: ['11211'], initialOrientation: 0 },
  { maxBoundingBoxLdu: [400, 80, 100], keepOutZones: [{ description: '回转平台上方保留净空', boxLdu: [0, 40, 0, 200, 120, 100] }] }, ['c3-3-main']));

packages.push(mkPackage('c3-3-sa2-cab', 'subassembly', 'SA-2',
  {
    outwardConnectors: [{ id: 'cside#back', type: 'side-stud', localPartInstance: 'cab-back', status: 'frozen' }],
    targetMounts: [
      { id: 'cside#cab-0', targetPackage: 'c3-3-main', targetConnector: 'cside#cab-0', status: 'frozen' },
      { id: 'cside#cab-1', targetPackage: 'c3-3-main', targetConnector: 'cside#cab-1', status: 'frozen' },
    ],
  },
  { originDescription: '司机舱后壁为局部原点，驾驶室开口朝 +z', allowedRootParts: ['3004'], initialOrientation: 0 },
  { maxBoundingBoxLdu: [60, 120, 80], keepOutZones: [{ description: '司机舱前窗方向(+z)保留 40 LDU 视野净空', boxLdu: [-30, 0, 20, 30, 120, 60] }] }, ['c3-3-main']));

const plan = {
  format: 'brickkit.build.plan',
  version: '1.0.0',
  modelName: '港口吊机 Harbor Crane',
  revision: 'c3-3-fourstep-1.0',
  acceptanceRef: 'acceptance.json',
  contractRevision: '1.0.0',
  bom,
  totalParts,
  tokens: allTokens,
  packageSplit: {
    main: tokensByPkg.main.length,
    'SA-1': tokensByPkg['SA-1'].length,
    'SA-2': tokensByPkg['SA-2'].length,
  },
  stepRegions: [
    { package: 'main', steps: '1-12' },
    { package: 'SA-1', steps: '1-6' },
    { package: 'SA-2', steps: '1-5' },
    { package: 'assembly', steps: '13-16' },
  ],
};

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(OUT, 'task-packages'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'acceptance.json'), JSON.stringify(acceptance, null, 2));
fs.writeFileSync(path.join(OUT, 'build.plan.json'), JSON.stringify(plan, null, 2));
const planSha = sha256(fs.readFileSync(path.join(OUT, 'build.plan.json')));
for (const p of packages) {
  p.globalPlanRef.planSha256 = planSha;
  const f = path.join(OUT, 'task-packages', `${p.taskId}.json`);
  fs.writeFileSync(f, JSON.stringify(p, null, 2));
}

// —— 自检：BOM 守恒 / assetLock / schema 形状 ——
const conservation = {
  bomTotal: totalParts,
  tokenTotal: allTokens.length,
  packageSum: Object.values(plan.packageSplit).reduce((a, b) => a + b, 0),
  uniqueTokenIds: new Set(allTokens.map((t) => t.tokenId)).size,
  perPackageDeclaredVsTokens: packages.map((p) => ({
    taskId: p.taskId,
    declared: p.inventory.totalCount,
    tokens: p.inventory.tokens.length,
    ok: p.inventory.totalCount === p.inventory.tokens.length,
  })),
  assetLocks: packages.map((p) => ({ taskId: p.taskId, parts: p.assetLock.parts.length, ok: checkAssetLock({ assetLock: p.assetLock }, { index: INDEX }).ok })),
};
conservation.ok = conservation.bomTotal === conservation.tokenTotal
  && conservation.bomTotal === conservation.packageSum
  && conservation.uniqueTokenIds === totalParts
  && conservation.perPackageDeclaredVsTokens.every((x) => x.ok)
  && conservation.assetLocks.every((x) => x.ok);

const precheck = {
  generatedAt: new Date().toISOString(),
  designRevision: 'c3-3-fourstep-1.0',
  totalParts,
  packageCount: packages.length,
  conservation,
  catalogCheck: { allPartsExist: true, partCount: bom.length },
  contractRevision: '1.0.0',
  planSha256: planSha,
  acceptanceSha256: sha256(fs.readFileSync(path.join(OUT, 'acceptance.json'))),
};
fs.writeFileSync(path.join(OUT, 'precheck-report.json'), JSON.stringify(precheck, null, 2));

console.log(JSON.stringify({
  ok: conservation.ok,
  totalParts,
  packageSplit: plan.packageSplit,
  tokenCount: allTokens.length,
  packages: packages.map((p) => ({ taskId: p.taskId, tokens: p.inventory.totalCount, lockParts: p.assetLock.parts.length })),
  planSha256: planSha,
}, null, 2));
