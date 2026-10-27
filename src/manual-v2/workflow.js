/**
 * src/manual-v2/workflow.js — 四步主从搭建工作流引擎
 *
 * 遵循 PRD Section 8 / WF-01～05 规范：
 * - 第一步：主会话提取说明书与冻结验收标准 (observations & acceptance)
 * - 第二步：全部零件归总并拆分子模型任务包 (inventory tokens & C2 task packages)
 *   * 严格包含 C2 Schema 必填的 globalPlanRef、assetLock、spatialContracts
 *   * 严格保证 91 = 71 主体 + 4 保险杠 + 8 车轮 + 4 人仔 + 4 配件
 * - 第三步：主体与局部并行推进，支持早期非破坏性试装与收据 (trial mounts & receipts)
 * - 第四步：主会话总装与全要素零件守恒核查
 *
 * 收据门禁（Task-B v4 复核 §3 两条反例修复，C0-4）：
 * 收据必须与被引用的任务包**真实绑定**，缺一即拒（validation error + reasonCode）：
 *   (a) revision / contractRevision / engineRevision 与任务包记录的版本严格一致；
 *   (b) stateHash 必须能用 src/core/actions-v1/state.js 的 stateHashOf 对收据声称的
 *       状态证据（内联 state 对象或磁盘 stateFile）真实复算并一致——任意"看似合法"
 *       的 64 位十六进制字符串不再被接受；
 *   (c) 声明的产物 artifacts 在磁盘上存在时，文件真实 SHA256 必须与声明一致；
 *   (d) 收据声明件数（declaredPartCount/totalParts）与任务包实际分配件数一致，
 *       且全局计划 totalBOMParts 与全部任务包实际分配总量一致；
 *   (e) 每颗被消费的库存 Token 都必须绑定到任务包的真实分配（件号/颜色/唯一性）。
 * 无法核对绑定的收据在 receiptAudit 中标记 binding:'unverified'。
 *
 * 机器可读原因码（reasonCodes）：
 *   PLAN_BOM_TOTAL_MISMATCH        计划声明总件数与任务包实际分配总量不一致（v4 反例 3.2）
 *   PACKAGE_INVENTORY_MISSING      任务包缺少库存分配
 *   PACKAGE_COUNT_MISMATCH         任务包 totalCount 与 tokens.length 不一致
 *   RECEIPT_UNKNOWN_TASK           收据引用了计划中不存在的任务
 *   RECEIPT_STATUS_NOT_COMPLETED   收据状态不是 completed/verified
 *   RECEIPT_REVISION_MISMATCH      revision/contractRevision/engineRevision 与任务包记录不一致（v4 反例 3.1）
 *   RECEIPT_STATEHASH_MALFORMED    stateHash 不是 64 位十六进制
 *   RECEIPT_STATEHASH_UNBOUND      收据未携带可复算的状态证据，stateHash 无法绑定（v4 反例 3.1）
 *   RECEIPT_STATEHASH_MISMATCH     复算 stateHashOf(state) 与声明 stateHash 不一致
 *   RECEIPT_STATE_TOKEN_MISMATCH   内联 state.inventory 与收据 consumedTokens 不一致
 *   RECEIPT_EVIDENCE_MISSING       缺少有效会话/执行证据（单字符占位签名不算）
 *   RECEIPT_PART_COUNT_MISMATCH    收据声明件数与任务包实际分配件数不一致（v4 反例 3.2 收据级形态）
 *   RECEIPT_ARTIFACT_HASH_MALFORMED 声明产物缺少合法 sha256
 *   RECEIPT_ARTIFACT_HASH_MISMATCH 声明产物在磁盘上存在但哈希不一致
 *   RECEIPT_ARTIFACT_MISSING       声明产物不在磁盘上，无法核对（warning）
 *   RECEIPT_TOKEN_NOT_ALLOCATED    消费了任务包未分配的 Token
 *   RECEIPT_TOKEN_FOREIGN          消费了全局计划外的 Token
 *   RECEIPT_TOKEN_PART_MISMATCH    Token 件号与分配不符
 *   RECEIPT_TOKEN_COLOR_MISMATCH   Token 颜色与分配不符
 *   RECEIPT_TOKEN_DUPLICATE        Token 重复消费
 *   RECEIPT_MISSING                任务缺少执行收据
 *   TOKEN_UNCONSUMED               分配 Token 未被消费
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
// 真实状态哈希：与动作协议 (actions-v1) 完全同一实现，杜绝第二套哈希口径
import { stateHashOf } from '../core/actions-v1/state.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;

// 60239 开发样例默认锁定的件号（主体用砖 + LDraw 提取件），
// 具体 revision/contentHash 一律从当前资产索引现取，不写死。
const CATALOG_LOCK_PART_IDS = ['3001', '3023'];

/** 从仓库资产索引构造资产锁；索引缺失时抛错而不是返回写死的假锁。 */
export function buildAssetLockFromCatalog(repoRoot = process.cwd(), partIds = CATALOG_LOCK_PART_IDS) {
  const indexFile = path.join(repoRoot, 'catalog', 'assets-v1', 'index.json');
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const byPart = new Map((index.parts || []).map((e) => [String(e.partId), e]));
  const missing = partIds.filter((id) => !byPart.has(String(id)));
  if (missing.length) {
    throw new Error(`资产索引缺少件号 ${missing.join(', ')}；请先运行 node cli/brickkit.mjs assets compile`);
  }
  return {
    profileId: index.profileId,
    indexVersion: index.version,
    parts: partIds.map((id) => {
      const e = byPart.get(String(id));
      return { partId: String(id), revision: e.revision, contentHash: e.contentHash };
    }),
  };
}

export function hashString(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

/** 计算磁盘文件的真实 SHA256（收据产物 artifacts 哈希核对用） */
export function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

/**
 * 第一步：生成冻结的整体验收标准 (acceptance.json)
 */
export function createAcceptanceCriteria(setId, options = {}) {
  return {
    schemaVersion: '1.0',
    setId,
    frozenAt: new Date().toISOString(),
    criteria: {
      strictZeroErrors: true,
      strictZeroWarnings: true,
      totalPartsAuthoritative: 91,
      partAllocation: {
        carBodyParts: 83,
        accessoriesParts: 8,
        totalParts: 91
      },
      reachability: {
        requireCarBodyReachableToRoot: true,
        rootPartId: 'p001'
      },
      visualDiff: {
        minProductScore: 0.60,
        minStepScore: 0.70
      },
      budget: {
        maxRetriesPerStep: 3,
        maxRepairRounds: 2
      }
    }
  };
}

/**
 * 第二步：零件归总拆分与 C2 任务包生成
 *
 * 任务包会盖章 contractRevision（默认 '0.9.0-draft'，可用 options.contractRevision 覆盖）
 * 与可选 engineRevision；收据门禁据此核对 (a) 版本绑定。
 */
export function generateBuildPlan(observationsSet, bomData, options = {}) {
  const planRef = {
    planFile: options.planFile || 'out/prd-v2/run-20261026-v3/B/60239.build.plan.json',
    planSha256: options.planSha256 || '4a51e600868f0ef81e9f298f2402120092576b251fcfa11ecf11370ae24f5a2a'
  };

  const contractRevision = options.contractRevision || '0.9.0-draft';

  // 资产锁必须反映当前零件定义的 contentHash。写死常量会在目录修订后静默失配，
  // 所以默认从 catalog/assets-v1/index.json 现取（也可由 options.assetLock 显式覆盖）。
  const defaultAssetLock = options.assetLock || buildAssetLockFromCatalog(options.repoRoot, CATALOG_LOCK_PART_IDS);

  const defaultSpatialContracts = {
    maxBoundingBoxLdu: [200, 100, 400],
    keepOutZones: []
  };

  // 1. 零件唯一 Inventory Token 守恒分配
  const allTokens = [];
  let tokenCounter = 1;

  for (const partItem of bomData.parts || []) {
    const qty = partItem.qty || 1;
    for (let q = 0; q < qty; q++) {
      allTokens.push({
        tokenId: `tok-${String(tokenCounter++).padStart(3, '0')}`,
        partId: String(partItem.ldraw || partItem.part || partItem.design),
        colorId: Number(partItem.color),
        name: partItem.name || 'LEGO Part'
      });
    }
  }

  // 2. 依据装配独立性严格拆分子任务（71 主体 + 4 保险杠 + 8 车轮 + 4 人仔 + 4 配件 = 91）
  const submodelTokenBuckets = {
    minifig: [],
    cones: [],
    front_bumper: [],
    wheels: [],
    main_chassis: []
  };

  for (const token of allTokens) {
    if (['73200', '76382', '3626b', '11303'].includes(token.partId) && submodelTokenBuckets.minifig.length < 4) {
      submodelTokenBuckets.minifig.push(token);
    } else if (['4740', '59900'].includes(token.partId) && submodelTokenBuckets.cones.length < 4) {
      submodelTokenBuckets.cones.push(token);
    } else if (['11208', '11209'].includes(token.partId) && submodelTokenBuckets.wheels.length < 8) {
      submodelTokenBuckets.wheels.push(token);
    } else if (submodelTokenBuckets.front_bumper.length < 4) {
      // 保险杠由 4 件组成：1x 2412a 格栅 + 2x 3023/3023b 板 + 1x 54200 斜面
      const fbParts = submodelTokenBuckets.front_bumper.map(t => t.partId);
      if (token.partId.startsWith('2412') && !fbParts.some(p => p.startsWith('2412'))) {
        submodelTokenBuckets.front_bumper.push(token);
      } else if (token.partId.startsWith('3023') && fbParts.filter(p => p.startsWith('3023')).length < 2) {
        submodelTokenBuckets.front_bumper.push(token);
      } else if (token.partId.startsWith('54200') && !fbParts.some(p => p.startsWith('54200'))) {
        submodelTokenBuckets.front_bumper.push(token);
      } else {
        submodelTokenBuckets.main_chassis.push(token);
      }
    } else {
      submodelTokenBuckets.main_chassis.push(token);
    }
  }

  // 构建符合 C2 Schema (task-package.schema.json) 的完整任务包
  const taskPackages = [];

  // A. 人仔任务包 (4 件)
  taskPackages.push({
    schemaVersion: '1.0',
    taskId: 'task-minifig',
    revision: 1,
    globalPlanRef: planRef,
    role: 'accessory',
    dependencies: [],
    assetLock: defaultAssetLock,
    inventory: {
      totalCount: submodelTokenBuckets.minifig.length,
      tokens: submodelTokenBuckets.minifig
    },
    localFrame: { originDescription: '以人仔腿部为原点', allowedRootParts: ['73200'], initialOrientation: 0 },
    interfaces: { outwardConnectors: [], targetMounts: [] },
    spatialContracts: defaultSpatialContracts,
    budget: { maxStepRetries: 3, maxRepairRounds: 2, timeoutSeconds: 120 },
    acceptance: { requireZeroErrors: true, requireZeroWarnings: true, requireFullInventoryConsumption: true }
  });

  // B. 路障配件任务包 (4 件)
  taskPackages.push({
    schemaVersion: '1.0',
    taskId: 'task-cones',
    revision: 1,
    globalPlanRef: planRef,
    role: 'accessory',
    dependencies: [],
    assetLock: defaultAssetLock,
    inventory: {
      totalCount: submodelTokenBuckets.cones.length,
      tokens: submodelTokenBuckets.cones
    },
    localFrame: { originDescription: '以底座圆盘为原点', allowedRootParts: ['4740'], initialOrientation: 0 },
    interfaces: { outwardConnectors: [], targetMounts: [] },
    spatialContracts: defaultSpatialContracts,
    budget: { maxStepRetries: 3, maxRepairRounds: 2, timeoutSeconds: 120 },
    acceptance: { requireZeroErrors: true, requireZeroWarnings: true, requireFullInventoryConsumption: true }
  });

  // C. 前保险杠子组件任务包 (4 件)
  taskPackages.push({
    schemaVersion: '1.0',
    taskId: 'task-front-bumper',
    revision: 1,
    globalPlanRef: planRef,
    role: 'subassembly',
    dependencies: ['task-main-chassis'],
    assetLock: defaultAssetLock,
    inventory: {
      totalCount: submodelTokenBuckets.front_bumper.length,
      tokens: submodelTokenBuckets.front_bumper
    },
    localFrame: { originDescription: '以底板中心底孔为原点', allowedRootParts: ['3023'], initialOrientation: 0 },
    interfaces: {
      outwardConnectors: [{ id: 'mount_antistud_0', type: 'antistud', status: 'frozen' }],
      targetMounts: [{ targetTask: 'task-main-chassis', parentConnectorId: 'stud_side_0', status: 'frozen' }]
    },
    spatialContracts: defaultSpatialContracts,
    budget: { maxStepRetries: 3, maxRepairRounds: 2, timeoutSeconds: 180 },
    acceptance: { requireZeroErrors: true, requireZeroWarnings: true, requireFullInventoryConsumption: true }
  });

  // D. 4 轮组装任务包 (8 件)
  taskPackages.push({
    schemaVersion: '1.0',
    taskId: 'task-wheels',
    revision: 1,
    globalPlanRef: planRef,
    role: 'subassembly',
    dependencies: ['task-main-chassis'],
    assetLock: defaultAssetLock,
    inventory: {
      totalCount: submodelTokenBuckets.wheels.length,
      tokens: submodelTokenBuckets.wheels
    },
    localFrame: { originDescription: '以轮毂轴孔为原点', allowedRootParts: ['11208'], initialOrientation: 0 },
    interfaces: {
      outwardConnectors: [{ id: 'wheel_hole_0', type: 'hole', status: 'frozen' }],
      targetMounts: [{ targetTask: 'task-main-chassis', parentConnectorId: 'axle_pin_wheel', status: 'frozen' }]
    },
    spatialContracts: defaultSpatialContracts,
    budget: { maxStepRetries: 3, maxRepairRounds: 2, timeoutSeconds: 180 },
    acceptance: { requireZeroErrors: true, requireZeroWarnings: true, requireFullInventoryConsumption: true }
  });

  // E. 车身骨架主体任务包 (71 件)
  taskPackages.push({
    schemaVersion: '1.0',
    taskId: 'task-main-chassis',
    revision: 1,
    globalPlanRef: planRef,
    role: 'main_body',
    dependencies: [],
    assetLock: defaultAssetLock,
    inventory: {
      totalCount: submodelTokenBuckets.main_chassis.length,
      tokens: submodelTokenBuckets.main_chassis
    },
    localFrame: { originDescription: '以底盘主板为全局原点 [0, 0, 0]', allowedRootParts: ['3020'], initialOrientation: 0 },
    interfaces: {
      outwardConnectors: [
        { id: 'stud_side_0', type: 'stud', status: 'frozen' },
        { id: 'axle_pin_wheel', type: 'pin', status: 'frozen' }
      ],
      targetMounts: []
    },
    spatialContracts: defaultSpatialContracts,
    budget: { maxStepRetries: 3, maxRepairRounds: 2, timeoutSeconds: 600 },
    acceptance: { requireZeroErrors: true, requireZeroWarnings: true, requireFullInventoryConsumption: true }
  });

  // 版本盖章：全部任务包继承契约版本（可选引擎版本），供收据门禁做 (a) 版本绑定
  for (const tp of taskPackages) {
    tp.contractRevision = contractRevision;
    if (options.engineRevision) tp.engineRevision = options.engineRevision;
  }

  return {
    schemaVersion: '1.0',
    setId: bomData.set || '60239-1',
    name: 'LEGO 60239 Build Plan',
    contractRevision,
    ...(options.engineRevision ? { engineRevision: options.engineRevision } : {}),
    totalBOMParts: allTokens.length,
    tasksCount: taskPackages.length,
    taskPackages
  };
}

/**
 * 构造与任务包**真实绑定**的收据（正向用例的权威构造器）：
 * - revision / contractRevision / engineRevision 直接取自任务包记录；
 * - state 为收据声称的最终状态证据（本模块范围内=库存 Token 消费状态），
 *   stateHash 用 actions-v1 的 stateHashOf 真实复算，可被审计逐字节复算核对；
 * - declaredPartCount 与任务包实际分配件数一致；
 * - consumedTokens 逐颗来自任务包分配。
 */
export function createBoundTaskReceipt(taskPackage, options = {}) {
  const tokens = taskPackage.inventory?.tokens || [];
  const state = {
    nodes: [],
    connections: [],
    inventory: tokens.map((t) => [t.tokenId, 'consumed'])
  };
  const receipt = {
    receiptId: options.receiptId || `rcpt-${taskPackage.taskId}`,
    taskId: taskPackage.taskId,
    status: options.status || 'completed',
    revision: taskPackage.revision,
    stateHash: stateHashOf(state),
    state,
    sessionEvidence: options.sessionEvidence || {
      conversationId: options.conversationId || `sess-${taskPackage.taskId}`,
      agentRole: 'subagent-builder'
    },
    signedBy: options.signedBy || 'subagent-builder',
    declaredPartCount: tokens.length,
    consumedTokens: tokens.map((t) => ({ tokenId: t.tokenId, partId: t.partId, colorId: t.colorId }))
  };
  if (taskPackage.contractRevision !== undefined) receipt.contractRevision = taskPackage.contractRevision;
  if (taskPackage.engineRevision !== undefined) receipt.engineRevision = taskPackage.engineRevision;
  if (options.artifacts) receipt.artifacts = options.artifacts;
  return receipt;
}

/**
 * 第三步：记录早期试装收据 (Trial Mount Receipt)
 */
export function recordTrialMountReceipt(taskId, parentTaskId, interfacePair, success, diagnostics = {}) {
  return {
    receiptId: `rcpt-${Date.now()}-${taskId}`,
    taskId,
    parentTaskId,
    interfacePair,
    timestamp: new Date().toISOString(),
    status: success ? 'trial_mounted' : 'trial_mount_failed',
    diagnostics
  };
}

/**
 * 第四步：总装与全要素零件守恒核查 + 收据真实绑定门禁
 * （修复 B-06 / V3-05 漏洞；修复 Task-B v4 复核 §3.1/§3.2 两条反例）
 */
export function auditTotalAssembly(buildPlan, completedTaskReceipts) {
  const errors = [];
  const warnings = [];
  const reasonCodes = [];
  const addError = (code, msg) => {
    if (!reasonCodes.includes(code)) reasonCodes.push(code);
    errors.push(msg);
  };
  const addWarning = (code, msg) => {
    if (!reasonCodes.includes(code)) reasonCodes.push(code);
    warnings.push(msg);
  };

  // 0. 计划完整性门禁：声明 BOM 总件数必须与任务包**实际分配**（真实 Token 数）严格相等
  //    —— v4 反例 3.2：totalBOMParts=999 而实际分配 91 件必须被拒
  const declaredTotalBOM = Number(buildPlan?.totalBOMParts || 0);
  const packages = buildPlan?.taskPackages || [];
  if (declaredTotalBOM > 0 && packages.length === 0) {
    addError('PLAN_BOM_TOTAL_MISMATCH', `全局计划声明了 ${declaredTotalBOM} 件，但任务包列表为空`);
  }

  const taskMap = new Map();
  const allExpectedTokens = new Map();
  let allocatedFromTokens = 0;
  for (const t of packages) {
    taskMap.set(t.taskId, t);
    const tokens = t.inventory?.tokens || [];
    allocatedFromTokens += tokens.length;
    if (!t.inventory || tokens.length === 0) {
      addError('PACKAGE_INVENTORY_MISSING', `任务包 ${t.taskId} 缺少库存分配 (inventory.tokens 为空)`);
    } else if (Number(t.inventory.totalCount || 0) !== tokens.length) {
      addError('PACKAGE_COUNT_MISMATCH', `任务包 ${t.taskId} 声明 ${t.inventory.totalCount} 件，但实际只分配了 ${tokens.length} 个 Token`);
    }
    for (const tok of tokens) {
      allExpectedTokens.set(tok.tokenId, { ...tok, taskId: t.taskId });
    }
  }
  if (declaredTotalBOM > 0 && packages.length > 0 && declaredTotalBOM !== allocatedFromTokens) {
    addError('PLAN_BOM_TOTAL_MISMATCH', `全局计划声明了 ${declaredTotalBOM} 件，但任务包实际分配了 ${allocatedFromTokens} 件，总量不守恒`);
  }

  // 1. 逐条收据的门禁审计
  const seenReceiptTasks = new Set();
  const consumedTokens = new Set();
  let duplicateTokens = 0;
  const receiptAudit = [];

  for (const r of completedTaskReceipts || []) {
    const rcCodes = [];
    const rError = (code, msg) => {
      addError(code, msg);
      if (!rcCodes.includes(code)) rcCodes.push(code);
    };
    const rWarn = (code, msg) => {
      addWarning(code, msg);
      if (!rcCodes.includes(code)) rcCodes.push(code);
    };

    if (!taskMap.has(r.taskId)) {
      rError('RECEIPT_UNKNOWN_TASK', `收据包含未定义任务: ${r.taskId}`);
      receiptAudit.push({ taskId: r.taskId ?? null, receiptId: r.receiptId ?? null, binding: 'unverified', reasonCodes: rcCodes });
      continue;
    }
    seenReceiptTasks.add(r.taskId);
    const taskDef = taskMap.get(r.taskId);

    // 1a) 状态必须是 completed 或 verified
    if (r.status !== 'completed' && r.status !== 'verified') {
      rError('RECEIPT_STATUS_NOT_COMPLETED', `任务 ${r.taskId} 状态未成功（当前状态: ${r.status}）`);
    }

    // 1b) 版本真实绑定（v4 反例 3.1）：revision 必须是正整数且与任务包记录严格一致；
    //     任务包（或全局计划）盖章的 contractRevision/engineRevision 收据必须声明且一致
    if (typeof r.revision !== 'number' || !Number.isInteger(r.revision) || r.revision < 1) {
      rError('RECEIPT_REVISION_MISMATCH', `任务 ${r.taskId} 收据版本号非法: ${r.revision}`);
    } else if (r.revision !== taskDef.revision) {
      rError('RECEIPT_REVISION_MISMATCH', `任务 ${r.taskId} 收据版本号 (${r.revision}) 与任务定义版本号 (${taskDef.revision}) 不匹配`);
    }
    const revisionFields = [
      ['contractRevision', taskDef.contractRevision ?? buildPlan?.contractRevision],
      ['engineRevision', taskDef.engineRevision ?? buildPlan?.engineRevision]
    ];
    for (const [field, recorded] of revisionFields) {
      if (recorded === undefined || recorded === null) continue;
      if (r[field] !== recorded) {
        rError('RECEIPT_REVISION_MISMATCH', `任务 ${r.taskId} 收据 ${field} (${r[field]}) 与任务包记录 (${recorded}) 不一致`);
      }
    }

    // 1c) stateHash 真实复算绑定（v4 反例 3.1）：必须携带内联 state 或可读 stateFile，
    //     并用 actions-v1 的 stateHashOf 复算；"看似合法"的任意 64 位十六进制不再被接受
    const stateHash = typeof r.stateHash === 'string' ? r.stateHash : '';
    if (!SHA256_HEX.test(stateHash)) {
      rError('RECEIPT_STATEHASH_MALFORMED', `任务 ${r.taskId} 收据 stateHash 非法（必须是 64 位十六进制）: ${String(r.stateHash).slice(0, 16)}`);
    }

    let bindingEvidence = null;
    let recomputed = null;
    if (r.state && typeof r.state === 'object' && !Array.isArray(r.state)) {
      bindingEvidence = 'inline';
      recomputed = stateHashOf(r.state);
    } else if (typeof r.stateFile === 'string' && r.stateFile) {
      bindingEvidence = 'file';
      try {
        recomputed = stateHashOf(JSON.parse(fs.readFileSync(r.stateFile, 'utf8')));
      } catch {
        rError('RECEIPT_STATEHASH_UNBOUND', `任务 ${r.taskId} 收据 stateFile (${r.stateFile}) 不存在或无法解析，stateHash 无法复算绑定`);
      }
    }
    if (bindingEvidence === null) {
      rError('RECEIPT_STATEHASH_UNBOUND', `任务 ${r.taskId} 收据 stateHash 无法复算绑定：未携带内联 state 或 stateFile 状态证据`);
    } else if (recomputed !== null && SHA256_HEX.test(stateHash) && recomputed !== stateHash) {
      rError('RECEIPT_STATEHASH_MISMATCH', `任务 ${r.taskId} 收据 stateHash 与复算值不一致 (声明 ${stateHash.slice(0, 8)}..., 复算 ${recomputed.slice(0, 8)}...)`);
    }

    // 1d) 内联状态的 inventory 与收据声明消费的 Token 必须完全一致（防"哈希自洽但状态说谎"）
    if (bindingEvidence === 'inline' && Array.isArray(r.state.inventory)) {
      const stateConsumed = new Set();
      for (const entry of r.state.inventory) {
        const tokId = Array.isArray(entry) ? entry[0] : entry?.token;
        const st = Array.isArray(entry) ? entry[1] : entry?.state;
        if (tokId !== undefined && st === 'consumed') stateConsumed.add(String(tokId));
      }
      const declaredConsumed = new Set((r.consumedTokens || []).map(t => String(t.tokenId)));
      const onlyInState = [...stateConsumed].filter(x => !declaredConsumed.has(x));
      const onlyDeclared = [...declaredConsumed].filter(x => !stateConsumed.has(x));
      if (onlyInState.length > 0 || onlyDeclared.length > 0) {
        rError('RECEIPT_STATE_TOKEN_MISMATCH', `任务 ${r.taskId} 内联 state.inventory 与 consumedTokens 不一致 (state 多: ${onlyInState.slice(0, 3).join(',') || '无'}; 声明多: ${onlyDeclared.slice(0, 3).join(',') || '无'})`);
      }
    }

    // 1e) 会话凭据与模型构建证据检查（防单字符占位签名，v4 反例 3.1 的 signedBy='x'）
    const hasSessionEvidence = r.sessionEvidence || (r.signedBy && String(r.signedBy).trim().length > 1) || r.executionEvidence;
    if (!hasSessionEvidence) {
      rError('RECEIPT_EVIDENCE_MISSING', `任务 ${r.taskId} 缺少有效模型会话构建证据或签名 (sessionEvidence / signedBy)`);
    }

    // 1f) 声明件数必须与任务包实际分配件数一致（v4 反例 3.2 的收据级形态）
    const declaredParts = r.totalParts ?? r.declaredPartCount ?? r.partCount;
    if (declaredParts !== undefined) {
      const actualAllocated = (taskDef.inventory?.tokens || []).length;
      if (Number(declaredParts) !== actualAllocated) {
        rError('RECEIPT_PART_COUNT_MISMATCH', `任务 ${r.taskId} 收据声明 ${declaredParts} 件，但任务包实际分配 ${actualAllocated} 件`);
      }
    }

    // 1g) 产物哈希核对：磁盘上存在的产物文件必须与声明 sha256 一致
    let artifactsDeclared = 0;
    let artifactsVerified = 0;
    for (const a of r.artifacts || []) {
      artifactsDeclared++;
      const declaredHash = typeof a.sha256 === 'string' ? a.sha256.toLowerCase() : '';
      if (!SHA256_HEX.test(declaredHash)) {
        rError('RECEIPT_ARTIFACT_HASH_MALFORMED', `任务 ${r.taskId} 声明的产物 ${a.path} 缺少合法 sha256`);
        continue;
      }
      if (fs.existsSync(a.path)) {
        const actual = fileSha256(a.path);
        if (actual !== declaredHash) {
          rError('RECEIPT_ARTIFACT_HASH_MISMATCH', `任务 ${r.taskId} 产物 ${a.path} 哈希不匹配 (声明 ${declaredHash.slice(0, 8)}..., 实际 ${actual.slice(0, 8)}...)`);
        } else {
          artifactsVerified++;
        }
      } else {
        rWarn('RECEIPT_ARTIFACT_MISSING', `任务 ${r.taskId} 声明的产物 ${a.path} 不在磁盘上，无法核对哈希`);
      }
    }

    // 1h) 每颗被消费 Token 必须绑定任务包真实分配（件号/颜色/唯一性）
    const validTaskTokens = new Set((taskDef.inventory?.tokens || []).map(t => t.tokenId));

    for (const tok of r.consumedTokens || []) {
      if (!validTaskTokens.has(tok.tokenId)) {
        rError('RECEIPT_TOKEN_NOT_ALLOCATED', `任务 ${r.taskId} 消费了非法/未分配的 Token: ${tok.tokenId} (${tok.partId})`);
      }
      if (!allExpectedTokens.has(tok.tokenId)) {
        rError('RECEIPT_TOKEN_FOREIGN', `消费了未在全局计划中登记的外部 Token: ${tok.tokenId}`);
      } else {
        // 核验真实零件件号与颜色，防止仅保留 Token ID 偷换件号/颜色
        const expectedTok = allExpectedTokens.get(tok.tokenId);
        if (tok.partId && String(tok.partId) !== String(expectedTok.partId)) {
          rError('RECEIPT_TOKEN_PART_MISMATCH', `任务 ${r.taskId} Token ${tok.tokenId} 件号不匹配 (期望: ${expectedTok.partId}, 实际: ${tok.partId})`);
        }
        if (tok.colorId !== undefined && Number(tok.colorId) !== Number(expectedTok.colorId)) {
          rError('RECEIPT_TOKEN_COLOR_MISMATCH', `任务 ${r.taskId} Token ${tok.tokenId} 颜色不匹配 (期望: ${expectedTok.colorId}, 实际: ${tok.colorId})`);
        }
      }

      if (consumedTokens.has(tok.tokenId)) {
        duplicateTokens++;
        rError('RECEIPT_TOKEN_DUPLICATE', `Token ${tok.tokenId} (${tok.partId}) 被重复消费！`);
      }
      consumedTokens.add(tok.tokenId);
    }

    receiptAudit.push({
      taskId: r.taskId,
      receiptId: r.receiptId ?? null,
      binding: rcCodes.length === 0 ? 'verified' : 'unverified',
      stateHashBinding: recomputed !== null && SHA256_HEX.test(stateHash) && recomputed === stateHash ? 'verified' : 'unverified',
      artifacts: { declared: artifactsDeclared, verified: artifactsVerified },
      reasonCodes: rcCodes
    });
  }

  // 2. 检查是否有遗漏未完成的任务
  for (const [taskId] of taskMap) {
    if (!seenReceiptTasks.has(taskId)) {
      addError('RECEIPT_MISSING', `任务 ${taskId} 缺少执行收据`);
    }
  }

  // 3. 检查是否有未消费的库存 Token
  const totalTokensExpected = allExpectedTokens.size;
  for (const [tokenId, tok] of allExpectedTokens) {
    if (!consumedTokens.has(tokenId)) {
      addError('TOKEN_UNCONSUMED', `任务 ${tok.taskId} 中的 Token ${tokenId} (${tok.partId}) 未被消费`);
    }
  }

  const isConserved = totalTokensExpected > 0 && consumedTokens.size === totalTokensExpected && duplicateTokens === 0 && errors.length === 0;
  const ok = errors.length === 0 && isConserved;
  const allReceiptsVerified = receiptAudit.length > 0 && receiptAudit.every(x => x.binding === 'verified');
  const receiptBinding = (allReceiptsVerified && seenReceiptTasks.size === taskMap.size && taskMap.size > 0)
    ? 'verified'
    : 'unverified';

  return {
    ok,
    isConserved,
    receiptBinding,
    reasonCodes,
    receiptAudit,
    inventoryAudit: {
      passed: isConserved,
      totalExpectedTokens: totalTokensExpected,
      totalConsumedTokens: consumedTokens.size,
      duplicateTokens
    },
    assemblyAudit: {
      status: 'unverified',
      engineConnected: false,
      note: '物理装配无穿模与几何连接待 Executor A 运行时事务引擎执行'
    },
    overallAssemblyVerified: false, // 永远为 false 直至 A 引擎接入
    totalExpectedTokens: totalTokensExpected,
    totalConsumedTokens: consumedTokens.size,
    duplicateTokens,
    errors,
    warnings
  };
}
