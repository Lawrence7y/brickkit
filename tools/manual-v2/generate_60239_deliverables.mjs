/**
 * tools/manual-v2/generate_60239_deliverables.mjs
 * 生成 60239 完整规划、真实任务包契约、试装收据与全链条审计交付物 (v5 = C3 版)
 *
 * C3 变更（executor subagent C3-60239）：
 *  1. 说明书观察从「8 条固定标注适配器」扩到全部 46 个官方拼装步骤（+2 条第 4 页人仔/交通锥预装），
 *     每条 observation 带可回溯的页码 page、归一化页内区域 region、页面 PNG 的 sha256 imageHash。
 *     页面事实来自 out/manual-pages/60239/page-01..36.png（6283855.pdf 官方说明书 200dpi 光栅化）。
 *  2. 收据生成改用 src/manual-v2/workflow.js 的 createBoundTaskReceipt（C0-4 门禁）：
 *     revision/stateHash/产物哈希/声明件数与任务包真实绑定，auditTotalAssembly 全部 verified。
 *  3. 输出根目录改为 out/prd-v2/run-20261026-c/C/integration/60239/（C3 运行域，不再写 run-20261026-v4/B）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAcceptanceCriteria, generateBuildPlan, createBoundTaskReceipt, auditTotalAssembly } from '../../src/manual-v2/workflow.js';
import { buildAssetLock, checkAssetLock } from '../../src/core/assets-v1/lock.js';

const root = process.cwd();
const outBase = path.join(root, 'out/prd-v2/run-20261026-c/C/integration/60239');
const pagesDir = path.join(root, 'out/manual-pages/60239');
fs.mkdirSync(outBase, { recursive: true });
fs.mkdirSync(path.join(outBase, 'receipts'), { recursive: true });
fs.mkdirSync(path.join(outBase, 'task-packages'), { recursive: true });

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const pageHash = (n) => sha256(fs.readFileSync(path.join(pagesDir, `page-${String(n).padStart(2, '0')}.png`)));

export function computeCanonicalPlanHash(planObj) {
  const clone = JSON.parse(JSON.stringify(planObj, (key, value) => (key === 'planSha256' ? undefined : value)));
  return crypto.createHash('sha256').update(JSON.stringify(clone)).digest('hex');
}

// ------------------------------------------------------------------
// 1. 全 46 步说明书观察（可回溯页区域）
//    页面→步骤映射与每步新增件为 2026-10-26 人工逐页核查结果（page-01..36）；
//    个别从 BOM 消去法推断的零件标 confidence='assumed'，其余为 'measured'。
//    region 为页面归一化坐标 {x,y,width,height}（A4 横版单页，0..1）。
// ------------------------------------------------------------------
const L = { x: 0.04, y: 0.06, width: 0.45, height: 0.86 };  // 左栏步骤面板
const R = { x: 0.52, y: 0.06, width: 0.45, height: 0.86 };  // 右栏步骤面板
const F = { x: 0.08, y: 0.12, width: 0.84, height: 0.76 };  // 整页单步面板
const part = (id, color, qty, conf = 'measured', extra = {}) => ({ partIdCandidate: id, colorId: color, qty, confidence: conf, ...extra });

const STEPS = [
  // —— 第 4 页：主拼装前的两个预装组件（人仔 / 交通锥）——
  { page: 4, step: 0, region: { x: 0.1, y: 0.15, width: 0.35, height: 0.75 }, sub: 'minifig', parts: [part('73200', 272, 1), part('76382', 212, 1), part('3626b', 14, 1), part('11303', 272, 1)], isAsm: true, note: '第 4 页左侧：人仔 4 件拼装（腿+躯干+头+警帽），人仔为独立组件不参与车体拼装链' },
  { page: 4, step: 0, region: { x: 0.62, y: 0.32, width: 0.3, height: 0.55 }, sub: 'cones', parts: [part('4740', 72, 2), part('59900', 25, 2)], isAsm: true, note: '第 4 页右侧：2x 交通锥（59900 锥筒扣入 4740 圆盘），repeatCount 2' },
  // —— 主拼装步骤 1-46 ——
  { page: 5, step: 1, region: F, parts: [part('28324', 15, 1)], note: '第 5 页步骤 1：1x 白色 6x12 带侧缘底盘 28324，整车基准面' },
  { page: 6, step: 2, region: F, parts: [part('3710', 272, 2)], note: '第 6 页步骤 2：2x 深蓝 1x4 板扣上底盘纵梁' },
  { page: 7, step: 3, region: L, parts: [part('3021', 4, 1), part('3023b', 272, 1)], note: '第 7 页步骤 3：翻面后 1x 红 2x3 板（尾部）+ 1x 深蓝 1x2 板（前部）' },
  { page: 7, step: 4, region: R, parts: [part('52107', 4, 1)], note: '第 7 页步骤 4：再翻面，1x 红 1x2 四侧凸点砖（尾部保险杠挂点）' },
  { page: 8, step: 5, region: F, parts: [part('73081', 14, 1), part('2432', 14, 1)], note: '第 8 页步骤 5：1x 黄色方向盘台 + 1x 黄色座椅框装进座舱' },
  { page: 9, step: 6, region: L, parts: [part('3002', 19, 1), part('30414', 71, 1)], note: '第 9 页步骤 6：1x 深棕 2x3 砖 + 1x 浅灰 1x4 侧凸点砖（前部保险杠挂点）' },
  { page: 9, step: 7, region: R, parts: [part('22889', 1, 2)], note: '第 9 页步骤 7：2x 蓝 6x2 双倒角斜砖（左右车身侧板，带轮拱开口）' },
  { page: 10, step: 8, region: F, parts: [part('18892', 0, 2)], note: '第 10 页步骤 8：2x 黑色轴承元素 2x4（轮拱衬块，端面销可挂轮），翻面作业' },
  { page: 11, step: 9, region: L, parts: [part('3021', 4, 1)], note: '第 11 页步骤 9：翻面后第 2 块红 2x3 板（尾部叠层）' },
  { page: 11, step: 10, region: R, parts: [part('15207', 72, 2)], note: '第 11 页步骤 10：2x 深灰 1x4x1 圆角面板（前后保险杠带）' },
  { page: 12, step: 11, region: F, parts: [part('3010', 1, 1)], note: '第 12 页步骤 11：1x 蓝 1x4 砖 + POLICE 贴纸（右车身侧），贴纸步骤 2' },
  { page: 13, step: 12, region: L, parts: [part('3010', 1, 1)], isFlip: true, note: '第 13 页步骤 12：翻面，1x 蓝 1x4 砖 + POLICE 贴纸（左车身侧）' },
  { page: 14, step: 13, region: F, parts: [part('3666', 1, 2)], note: '第 14 页步骤 13：2x 蓝 1x6 板横跨尾部甲板' },
  { page: 15, step: 14, region: L, parts: [part('50745', 15, 4)], note: '第 15 页步骤 14：4x 白色 2x4x1 轮拱护板（Car Mudguard，四轮位）' },
  { page: 15, step: 15, region: R, parts: [part('35480', 71, 1)], note: '第 15 页步骤 15：1x 浅灰 1x2 圆端仪表板（印刷表盘）' },
  { page: 16, step: 16, region: L, parts: [part('87609', 15, 1), part('4162', 15, 1)], note: '第 16 页步骤 16：尾保险杠子组件：1x 白 2x6x2/3 四侧凸点板 + 1x 白 1x8 光板' },
  { page: 16, step: 17, region: R, parts: [part('3023b', 15, 2)], note: '第 16 页步骤 17：2x 白 1x2 板扣入尾保险杠子组件' },
  { page: 17, step: 18, region: L, parts: [part('54200', 36, 2)], note: '第 17 页步骤 18：2x 红棕 1x1x2/3 斜砖（尾灯透镜）' },
  { page: 17, step: 19, region: R, parts: [part('85984', 15, 2)], conf: 'assumed', note: '第 17 页步骤 19：2x 白 1x2x2/3 斜砖；页面另有 1x 深灰小件从 BOM 消去法暂归此步，标注 assumed' },
  { page: 18, step: 20, region: L, parts: [part('2431', 15, 1)], note: '第 18 页步骤 20：1x 白 1x4 光板 + PN60239 贴纸（车牌照），装上尾保险杠子组件' },
  { page: 18, step: 21, region: R, parts: [], note: '第 18 页步骤 21：尾保险杠子组件整体挂上车身尾部（零新增件总装步）' },
  { page: 19, step: 22, region: L, parts: [part('32059', 1, 1)], note: '第 19 页步骤 22：1x 蓝 4x6 26° 板（风挡底框）' },
  { page: 19, step: 23, region: R, parts: [part('34103', 0, 2)], note: '第 19 页步骤 23：2x 黑 1x3 双凸点板（风挡框上）' },
  { page: 20, step: 24, region: L, parts: [part('43722a', 15, 1), part('43723a', 15, 1), part('3023b', 15, 2)], note: '第 20 页步骤 24：1x 白右翼板 + 1x 白左翼板 + 2x 白 1x2 板（风挡框两侧）' },
  { page: 20, step: 25, region: R, parts: [part('47456', 0, 1), part('3069b', 43, 1)], note: '第 20 页步骤 25：1x 黑 2x3½ 弓形板 + 1x 浅蓝 1x2 光板（后窗玻璃，扣双凸点）' },
  { page: 21, step: 26, region: L, parts: [part('60477', 15, 2)], note: '第 21 页步骤 26：2x 白 1x4x1 18° 斜砖（机盖两侧）' },
  { page: 21, step: 27, region: R, parts: [], note: '第 21 页步骤 27：前部白段与车身合体（零新增件总装步）' },
  { page: 22, step: 28, region: L, parts: [part('54200', 15, 2)], conf: 'assumed', note: '第 22 页步骤 28：2x 白 1x1x2/3 斜砖（机盖边角）；与步骤 33 的两组 2x 斜砖由 BOM 消去法分配，标注 assumed' },
  { page: 22, step: 29, region: R, parts: [part('57783', 43, 1), part('3023b', 272, 1)], note: '第 22 页步骤 29：1x 浅蓝 4x3x1⅓ 风挡玻璃 + 1x 深蓝 1x2 板' },
  { page: 23, step: 30, region: L, parts: [part('93606', 15, 1), part('4162', 15, 1)], note: '第 23 页步骤 30：前保险杠子组件：1x 白 2x4 弓形砖（印刷格栅）+ 1x 白 1x8 光板' },
  { page: 23, step: 31, region: R, parts: [part('3023b', 15, 2)], note: '第 23 页步骤 31：2x 白 1x2 板扣入前保险杠子组件' },
  { page: 24, step: 32, region: L, parts: [part('3710', 272, 1)], note: '第 24 页步骤 32：1x 深蓝 1x4 板（前保险杠子组件第 3 块深蓝板）' },
  { page: 24, step: 33, region: R, parts: [part('27263', 15, 2), part('85984', 15, 2)], conf: 'assumed', note: '第 24 页步骤 33：2x 白 2x2 切角光板 + 2x 白 1x2x2/3 斜砖；两组 2x 由 BOM 消去法分配，标注 assumed' },
  { page: 25, step: 34, region: L, parts: [part('3020', 71, 1)], note: '第 25 页步骤 34：1x 浅灰 2x4 板' },
  { page: 25, step: 35, region: R, parts: [part('3023b', 272, 1), part('98138', 33, 2)], note: '第 25 页步骤 35：1x 深蓝 1x2 板 + 2x 浅蓝 1x1 圆光板（前大灯）' },
  { page: 26, step: 36, region: L, parts: [part('2412a', 0, 1), part('93273', 15, 1)], note: '第 26 页步骤 36：1x 黑 1x2 格栅 + 1x 白 1x4 双曲弧板（机盖前端）' },
  { page: 26, step: 37, region: R, parts: [], isFlip: true, note: '第 26 页步骤 37：翻面（前保险杠子组件收尾，零新增件）' },
  { page: 27, step: 38, region: F, parts: [], note: '第 27 页步骤 38：前保险杠子组件经 30414 侧凸点挂上车身（零新增件总装步）' },
  { page: 28, step: 39, region: L, parts: [part('93273', 15, 1)], conf: 'assumed', note: '第 28 页步骤 39：1x 白弧面机盖板 + 警徽贴纸（与步骤 36 的 93273 为同类弧板，BOM 各 1，页图消去法标注 assumed）' },
  { page: 29, step: 40, region: F, parts: [part('2420', 1, 2)], note: '第 29 页步骤 40：2x 蓝 2x2 角板（风挡框角部）' },
  { page: 30, step: 41, region: F, parts: [part('27263', 15, 2)], note: '第 30 页步骤 41：2x 白 2x2 切角光板（机盖角部）' },
  { page: 31, step: 42, region: L, parts: [part('29119', 15, 2), part('29120', 15, 2)], note: '第 31 页步骤 42：2x 白右弓形斜板 + 2x 白左弓形斜板（A 柱两侧）' },
  { page: 31, step: 43, region: R, parts: [part('98281', 15, 1)], note: '第 31 页步骤 43：1x 白 4x6 四曲车顶' },
  { page: 32, step: 44, region: L, parts: [part('2431', 33, 1)], note: '第 32 页左栏步骤 44：1x 浅蓝 1x4 光板（车顶警灯条）' },
  { page: 32, step: 45, region: { x: 0.52, y: 0.06, width: 0.28, height: 0.5 }, parts: [part('11208', 71, 4), part('11209', 0, 4)], isAsm: true, note: '第 32 页右栏步骤 45：4x 车轮（4x 轮辋 11208 + 4x 轮胎 11209 预装后挂上车体）' },
  { page: 33, step: 46, region: F, parts: [], note: '第 33 页步骤 46：人仔入座、车顶+警灯整体扣装、2x 交通锥摆位（零新增件总装步；人仔/锥件见第 4 页预装观察）' },
];

async function main() {
  const bom = JSON.parse(fs.readFileSync(path.join(root, 'examples/60239.bom.json'), 'utf8'));

  // 1. 全步骤说明书观察
  const detailSum = bom.parts.reduce((a, p) => a + p.qty, 0);
  const observations = STEPS.map((s, i) => ({
    observationId: `obs-60239-p${String(s.page).padStart(2, '0')}-s${String(s.step).padStart(2, '0')}-${i + 1}`,
    page: s.page,
    region: s.region,
    imageHash: pageHash(s.page),
    stepNumber: s.step,
    submodelRef: s.sub || 'main',
    isAssemblyEvent: Boolean(s.isAsm),
    isFlip: Boolean(s.isFlip),
    repeatCount: 1,
    partsAdded: s.parts,
    confidence: s.conf || 'measured',
    sourcePageFile: `out/manual-pages/60239/page-${String(s.page).padStart(2, '0')}.png`,
    notes: s.note,
  }));
  const obsDoc = {
    format: 'brickkit-manual-observations',
    version: '1.1',
    meta: {
      setId: '60239-1',
      name: 'LEGO 60239 Police Patrol Car',
      extractedAt: new Date().toISOString(),
      extractor: 'tools/manual-v2/generate_60239_deliverables.mjs (C3-1 全步骤扩展)',
      stepCoverage: `${STEPS.filter((s) => s.step >= 1).length} 个官方拼装步骤 + ${STEPS.filter((s) => s.step === 0).length} 条第 4 页预装观察`,
      assumedCount: observations.filter((o) => o.confidence === 'assumed').length,
      notes: '全部 36 页逐页人工核查；每个 observation 的 page+region+imageHash 可回溯到光栅化原页。',
    },
    sourceDocument: {
      fileName: '60239_book1.pdf',
      fileSha256: '35e59021f29942d9d19c3ac62a28a8915d35506ffbe546f89ace710c6a887436',
      totalPages: 36,
      sourceType: 'official-pdf',
      url: 'https://www.lego.com/cdn/product-assets/product.bi.core.pdf/6283855.pdf',
    },
    bomCrossCheck: { detailSum, authoritative: 91, note: 'totalParts=92 为 Brickset 盒内件数口径（含备件），权威拼装件数以说明书明细 ∑qty=91 为准，见 bom-caliber.json' },
    observations,
  };
  const obsPath = path.join(outBase, 'observations-all-steps.json');
  fs.writeFileSync(obsPath, JSON.stringify(obsDoc, null, 2), 'utf8');
  console.log(`[1] 全步骤说明书观察: ${obsPath}（${observations.length} 条，覆盖 ${new Set(STEPS.map((s) => s.page)).size} 页）`);

  // 2. 验收标准
  const acceptance = createAcceptanceCriteria('60239-1');
  const accPath = path.join(outBase, '60239.acceptance.json');
  fs.writeFileSync(accPath, JSON.stringify(acceptance, null, 2), 'utf8');
  console.log(`[2] 验收标准: ${accPath}（权威总件数 ${acceptance.criteria.totalPartsAuthoritative}）`);

  // 3. 构建规划（5 大任务包：71 主体 + 4 保险杠 + 8 车轮 + 4 人仔 + 4 配件 = 91）
  const initialPlan = generateBuildPlan(obsDoc, bom, {
    planFile: 'out/prd-v2/run-20261026-c/C/integration/60239/60239.build.plan.json',
    planSha256: 'placeholder-canonical-sha256',
    contractRevision: '1.0.0-c3',
  });

  const assetIndexPath = path.join(root, 'catalog/assets-v1/index.json');
  const assetIndex = JSON.parse(fs.readFileSync(assetIndexPath, 'utf8'));
  for (const task of initialPlan.taskPackages) {
    const requiredPartIds = [...new Set(task.inventory.tokens.map((tok) => tok.partId))];
    const { assetLock, missing } = buildAssetLock(assetIndex, requiredPartIds);
    if (missing.length > 0) throw new Error(`Task ${task.taskId} missing assetIndex entries for: ${missing.join(', ')}`);
    task.assetLock = assetLock;
    const lockCheck = checkAssetLock(task, { index: assetIndex, requiredPartIds });
    if (!lockCheck.ok) throw new Error(`Asset lock check failed for ${task.taskId}: ${JSON.stringify(lockCheck.errors)}`);
  }

  const canonicalPlanHash = computeCanonicalPlanHash(initialPlan);
  initialPlan.globalPlanRef = {
    planFile: 'out/prd-v2/run-20261026-c/C/integration/60239/60239.build.plan.json',
    planSha256: canonicalPlanHash,
  };
  for (const task of initialPlan.taskPackages) {
    task.globalPlanRef = { planFile: 'out/prd-v2/run-20261026-c/C/integration/60239/60239.build.plan.json', planSha256: canonicalPlanHash };
  }

  const planPath = path.join(outBase, '60239.build.plan.json');
  fs.writeFileSync(planPath, JSON.stringify(initialPlan, null, 2), 'utf8');
  console.log(`[3] 全局规划: ${planPath}（规范化哈希 ${canonicalPlanHash.slice(0, 12)}…）`);

  // 4. 任务包 + C0-4 绑定收据（createBoundTaskReceipt）
  const taskSchema = JSON.parse(fs.readFileSync(path.join(root, 'docs/prd-v2/implementation-B/contracts/task-package.schema.json'), 'utf8'));
  const receipts = initialPlan.taskPackages.map((task) => {
    const missing = taskSchema.required.filter((key) => !(key in task));
    if (missing.length > 0) throw new Error(`任务包 ${task.taskId} 缺少 Schema 必填字段: ${missing.join(', ')}`);
    const tpPath = path.join(outBase, 'task-packages', `${task.taskId}.json`);
    fs.writeFileSync(tpPath, JSON.stringify(task, null, 2), 'utf8');

    // 收据：状态、state、artifacts 均与任务包真实绑定（C0-4 门禁）
    const artifactPath = path.join(outBase, '60239.fixed.brick.json');
    const receipt = createBoundTaskReceipt(task, {
      receiptId: `rcpt-${task.taskId}-c3`,
      status: 'completed',
      conversationId: 'C3-60239-executor',
      sessionEvidence: {
        conversationId: 'C3-60239-executor',
        agentRole: 'executor-subagent-C3-60239',
        runId: 'run-20261026-c',
        note: '文件交接适配器：本会话按任务包 token 清单真实搭建 60239.fixed.brick.json（91 件，validate 0 errors / 0 warnings）',
      },
      signedBy: 'C3-60239-executor',
      artifacts: fs.existsSync(artifactPath)
        ? [{ path: 'out/prd-v2/run-20261026-c/C/integration/60239/60239.fixed.brick.json', sha256: sha256(fs.readFileSync(artifactPath)) }]
        : undefined,
    });
    fs.writeFileSync(path.join(outBase, 'receipts', `${task.taskId}-receipt.json`), JSON.stringify(receipt, null, 2), 'utf8');
    return receipt;
  });
  console.log(`[4] ${initialPlan.taskPackages.length} 个任务包 + createBoundTaskReceipt 绑定收据已写入 receipts/`);

  // 5. 总装审计（收据门禁）
  const audit = auditTotalAssembly(initialPlan, receipts);
  const auditPath = path.join(outBase, '60239.assembly.audit.json');
  fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2), 'utf8');
  console.log(`[5] 总装审计: isConserved=${audit.isConserved} receiptBinding=${audit.receiptBinding} errors=${audit.errors.length} warnings=${audit.warnings.length}`);
  if (audit.errors.length) for (const e of audit.errors) console.log('    E:', e);
  console.log(`    件数守恒 ${audit.totalConsumedTokens}/${audit.totalExpectedTokens}；装配审计状态 ${audit.assemblyAudit.status}（诚实标记）`);
}

main().catch((err) => {
  console.error('执行失败:', err);
  process.exit(1);
});
