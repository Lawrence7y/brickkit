// 动作事务执行（applyActions）：事务求解、回滚、幂等、旧状态拒绝、库存与接口占用。
//
// 语义（PRD §7.1 / EN-03）：
//   - stateHash 不匹配 → stale-state，整批拒绝，不尝试在新状态上执行旧动作
//   - 多动作按顺序执行，可声明 dependsOn；引用不存在的动作失败
//   - 任一动作失败 → 整批回滚，stateHash 不变（committed=false, rolledBack=true）
//   - 同一动作重复提交 → 幂等（第二次为 noop，带 idempotent 标记）
//   - 库存 token 只能消费一次；接口占用由引擎算，模型不得自行声称空闲
//   - 空动作请求 → empty-action，不计为该步完成

import crypto from 'node:crypto';
import {
  partConnectors, partsConnected, partBoxes, partsCollide, snapPart,
} from '../core.js';
import { inspectFromModel, stateHashOf } from './state.js';
import { getOrientation } from './pose.js';

const stableStringify = (v) => {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
};
const hashOf = (o) => crypto.createHash('sha256').update(stableStringify(o), 'utf8').digest('hex');
const r6 = (v) => Math.round(v * 1e6) / 1e6 || 0;

const D = (code, severity, msg, extra = {}) => ({ code, severity, msg, ...extra });

/**
 * 执行动作批次。
 *
 * @param {object} ctx {
 *   model,             // 当前 0.2 模型（不会被原地修改：事务在副本上推进）
 *   cat,
 *   stateHash,         // 当前权威状态哈希
 *   state?,            // 可选：预先算好的 state
 *   inventory,         // [{token, partId, color, state}]
 *   taskId,
 *   mainRootNodeId,
 * }
 * @param {object} request 符合 action-request.schema.json
 * @param {object} [opts] { profileId, engineRevision }
 */
export function applyActions(ctx, request, opts = {}) {
  const diagnostics = [];
  const engine = {
    engineRevision: opts.engineRevision || 'actions-v1@1.0.0',
    contractVersion: '1.0.0',
    mock: Boolean(opts.mock),
  };

  // —— 协议与状态前置检查 ——
  if (request.protocolVersion !== '1.0.0') {
    return {
      protocolVersion: '1.0.0', kind: 'apply', commandOk: false, passed: false,
      diagnostics: [D('protocol-version', 'error', `protocolVersion 必须是 1.0.0，收到 ${request.protocolVersion}`)],
      engine, capabilityGaps: [], notMeasured: [],
    };
  }
  if (!Array.isArray(request.actions) || request.actions.length === 0) {
    return {
      protocolVersion: '1.0.0', kind: 'apply', commandOk: true, passed: false,
      stateHash: ctx.stateHash, engine,
      apply: { committed: false, rolledBack: false, stateHashBefore: ctx.stateHash, stateHashAfter: ctx.stateHash, results: [], executedCount: 0, rejectedCount: 0, abstainedCount: 0 },
      diagnostics: [D('empty-action', 'error', '动作列表为空：空动作不构成该步完成')],
      capabilityGaps: [], notMeasured: [{ item: 'step-completion', reason: 'empty-action' }],
    };
  }
  if (ctx.taskId && request.taskId && request.taskId !== ctx.taskId) {
    return {
      protocolVersion: '1.0.0', kind: 'apply', commandOk: false, passed: false, engine,
      diagnostics: [D('task-mismatch', 'error', `动作属于任务 ${request.taskId}，当前任务 ${ctx.taskId}`)],
      capabilityGaps: [], notMeasured: [],
    };
  }
  if (request.stateHash !== ctx.stateHash) {
    return {
      protocolVersion: '1.0.0', kind: 'apply', commandOk: true, passed: false,
      stateHash: ctx.stateHash, engine,
      apply: { committed: false, rolledBack: false, stateHashBefore: ctx.stateHash, stateHashAfter: ctx.stateHash, results: [], executedCount: 0, rejectedCount: 0, abstainedCount: 0 },
      diagnostics: [D('stale-state', 'error', `stateHash 不匹配：请求 ${request.stateHash}，当前 ${ctx.stateHash}；整批拒绝，不在新状态上执行旧动作`)],
      capabilityGaps: [], notMeasured: [{ item: 'apply', reason: 'stale-state' }],
    };
  }

  // 修复模式门禁
  const baseRepairOps = new Set(['undo', 'detach', 'replace']);
  for (const a of request.actions) {
    if (baseRepairOps.has(a.op) && !request.repairMode) {
      return {
        protocolVersion: '1.0.0', kind: 'apply', commandOk: true, passed: false, stateHash: ctx.stateHash, engine,
        diagnostics: [D('repair-not-allowed', 'error', `动作 ${a.id} 使用 ${a.op}，但请求未设 repairMode:true`)],
        capabilityGaps: [], notMeasured: [],
      };
    }
  }

  // —— 在副本上推进 ——
  const working = JSON.parse(JSON.stringify(ctx.model));
  const inventory = JSON.parse(JSON.stringify(ctx.inventory || []));
  const invByToken = new Map(inventory.map((i) => [i.token, i]));
  // consumedNow 只是本批次的快速判据；真正的守恒靠 inv.state='consumed' 写回库存记录，
  // 否则下一事务清空本批次后重新拿到同一批 token 还能再装一遍（A-INV-01）。
  const consumedNow = new Set();
  const results = [];
  const appliedActionIds = new Map();     // actionId -> applied 记录（幂等判据）
  const verdicts = new Map();             // actionId -> 'ok'|'abstained'|'failed'

  // 工作状态必须是副本。ctx.state 属于调用方（B 的会话、CLI、测试夹具共用同一个对象），
  // 原地改写它会让「整批回滚」变成假回滚：返回 stateHashAfter=before，但调用方手里的
  // nodes/connections 已经被改成更新后的内容，后续任何基于它的候选枚举都跑在错状态上。
  let workingState = ctx.state
    ? JSON.parse(JSON.stringify(ctx.state))
    : inspectFromModel(working, ctx.cat, { mainRootNodeId: ctx.mainRootNodeId, inventory }).state;
  let workingHash = stateHashOf({
    nodes: workingState.nodes.map((n) => ({ p: n.nodePath, part: n.partId, c: n.color, at: n.at, rot: n.rot, up: n.up, snot: n.snot })),
    connections: workingState.connections.map((c) => [c.aNodeId, c.aConnectorId, c.bNodeId, c.bConnectorId]),
    inventory: inventory.map((i) => [i.token, i.state || 'available']),
  });

  const fail = (diag, extra = {}) => {
    // 整批回滚：working / inventory 全部丢弃，只回传诊断
    return {
      protocolVersion: '1.0.0', kind: 'apply', commandOk: true, passed: false,
      stateHash: ctx.stateHash, engine,
      apply: {
        committed: false, rolledBack: true,
        stateHashBefore: ctx.stateHash, stateHashAfter: ctx.stateHash,
        results: [...results, { actionId: extra.actionId ?? null, op: extra.op ?? null, status: 'rejected', diagnostics: [diag] }],
        executedCount: results.filter((r) => r.status === 'applied').length,
        rejectedCount: 1,
        abstainedCount: results.filter((r) => r.status === 'abstained').length,
      },
      diagnostics: [diag],
      capabilityGaps: [], notMeasured: [{ item: 'apply', reason: diag.code }],
    };
  };

  for (const action of request.actions) {
    // dependsOn：前置动作必须已成功
    for (const dep of action.dependsOn || []) {
      if (!verdicts.has(dep)) {
        return fail(D('missing-action-ref', 'error', `动作 ${action.id} 依赖不存在的动作 ${dep}；禁止猜测自动编号`, { nodes: [action.id] }), { actionId: action.id, op: action.op });
      }
      if (verdicts.get(dep) !== 'ok') {
        return fail(D('dependency-not-applied', 'error', `动作 ${action.id} 依赖的动作 ${dep} 未成功执行（${verdicts.get(dep)}）`, { nodes: [action.id] }), { actionId: action.id, op: action.op });
      }
    }

    // 幂等：同一 actionId 已应用 → noop
    if (appliedActionIds.has(action.id)) {
      results.push({ actionId: action.id, op: action.op, status: 'noop', diagnostics: [D('idempotent', 'info', `动作 ${action.id} 已应用过，重复提交不改变状态`)], stateHashAfter: workingHash });
      verdicts.set(action.id, 'ok');
      continue;
    }

    if (action.op === 'abstain') {
      if (!action.reason || !Array.isArray(action.needs) || !action.needs.length) {
        return fail(D('abstain-incomplete', 'error', `动作 ${action.id} 声明 abstain，但缺少 reason 或 needs（最小补充信息）`, { nodes: [action.id] }), { actionId: action.id, op: action.op });
      }
      results.push({ actionId: action.id, op: action.op, status: 'abstained', diagnostics: [D('abstained', 'info', action.reason)], stateHashAfter: workingHash });
      verdicts.set(action.id, 'abstained');
      continue;
    }

    if (action.op === 'inspect') {
      results.push({ actionId: action.id, op: action.op, status: 'applied', diagnostics: [D('inspect-only', 'info', '只读动作，不改变状态')], stateHashAfter: workingHash });
      verdicts.set(action.id, 'ok');
      continue;
    }

    if (action.op === 'place_root') {
      const nodeId = action.target?.partInstanceId || action.target?.nodeId;
      if (!nodeId) return fail(D('action-no-target', 'error', `place_root 动作 ${action.id} 缺少 target.partInstanceId`, { nodes: [] }), { actionId: action.id, op: action.op });
      const def = ctx.cat.parts[action.partId];
      if (!def) {
        return fail(D('missing-asset', 'error', `零件 ${action.partId} 不在目录中`, { nodes: [nodeId] }), { actionId: action.id, op: action.op });
      }
      // 根件放置只用任务指定基准（basePlacement），不接受任意世界坐标
      const base = action.basePlacement;
      if (!base?.baseId) return fail(D('place-root-base', 'error', `place_root 必须声明 basePlacement.baseId（任务指定的合法基准），不接受自由世界坐标`, { nodes: [nodeId] }), { actionId: action.id, op: action.op });
      const orient = getOrientation(base.orientationId ?? 0);
      const placed = { id: nodeId, part: action.partId, color: action.color ?? 0, at: [0, 0, 0], rot: orient.rot, up: orient.up, snot: 0, step: action.step ?? 1 };
      // 基准原点由任务包给出；这里以基准 y=0 面为地面
      const conflict = findCollision(placed, def, working, ctx.cat);
      if (conflict) return fail(D('collision', 'error', `place_root 的 ${nodeId} 与 ${conflict} 穿模`, { nodes: [nodeId, conflict] }), { actionId: action.id, op: action.op });
      working.parts.push(placed);
      results.push({ actionId: action.id, op: action.op, status: 'applied', applied: { nodeId, translationLdu: [0, 0, 0], orientationId: base.orientationId ?? 0, snot: 0 }, stateHashAfter: workingHash });
      appliedActionIds.set(action.id, true);
      verdicts.set(action.id, 'ok');
      workingHash = rehash(working, ctx.cat, inventory, workingState, ctx);
      continue;
    }

    if (action.op === 'attach_part' || action.op === 'attach_assembly') {
      // 成功返回 null（继续下一动作）；失败返回整批拒绝结果
      const rejected = applyAttach({ action, ctx, working, inventory, invByToken, consumedNow, results, verdicts, appliedActionIds, engine });
      if (rejected) return rejected;
      workingHash = rehash(working, ctx.cat, inventory, workingState, ctx);
      continue;
    }

    if (baseRepairOps.has(action.op)) {
      // 修复动作：undo（撤销本批次已应用的动作）/ detach（拆下已装件）/ replace（原地换件）
      if (action.op === 'undo') {
        const target = action.repair?.undoActionId;
        if (!target) return fail(D('undo-no-target', 'error', `undo 动作 ${action.id} 缺少 repair.undoActionId`, { nodes: [] }), { actionId: action.id, op: action.op });
        const prev = appliedActionIds.get(target);
        if (!prev) return fail(D('undo-unknown', 'error', `undo 指向的动作 ${target} 未在本批次成功应用`, { nodes: [] }), { actionId: action.id, op: action.op });
        const removed = new Set([prev.nodeId, ...(prev.memberIds || [])]);
        working.parts = working.parts.filter((p) => !removed.has(p.id));
        // 撤下的零件把库存 token 放回可用，否则撤销一次就永久烧掉一组库存
        const released = releaseTokens(inventory, invByToken, prev.tokens || []);
        appliedActionIds.delete(target);
        results.push({ actionId: action.id, op: action.op, status: 'applied', applied: { nodeId: prev.nodeId, removed: true, removedNodeIds: [...removed], releasedInventoryTokens: released }, stateHashAfter: workingHash });
        verdicts.set(action.id, 'ok');
        workingHash = rehash(working, ctx.cat, inventory, workingState, ctx);
        continue;
      }
      if (action.op === 'detach') {
        const rejected = applyDetach({ action, ctx, working, inventory, invByToken, results, verdicts, appliedActionIds });
        if (rejected) return rejected;
        workingHash = rehash(working, ctx.cat, inventory, workingState, ctx);
        continue;
      }
      if (action.op === 'replace') {
        const rejected = applyReplace({ action, ctx, working, inventory, invByToken, consumedNow, results, verdicts, appliedActionIds });
        if (rejected) return rejected;
        workingHash = rehash(working, ctx.cat, inventory, workingState, ctx);
        continue;
      }
      return fail(D('repair-unsupported', 'error', `修复动作 ${action.op} 本轮尚未实现（仅 undo 可用），返回明确缺口而不是静默放过`, { nodes: [] }), { actionId: action.id, op: action.op });
    }

    return fail(D('unknown-op', 'error', `未知动作 op=${action.op}`, { nodes: [] }), { actionId: action.id, op: action.op });
  }

  // —— 事务提交：全部成功 ——
  const committed = working.parts.length > 0;
  const abstained = results.filter((r) => r.status === 'abstained').length;
  const applied = results.filter((r) => r.status === 'applied').length;
  const finalHash = rehash(working, ctx.cat, inventory, workingState, ctx);
  // 提交成功才回写调用方状态；失败路径（fail/reject）提前 return，ctx.state 保持原样。
  // 这样「回滚」是真的回滚，而不是只在返回值里写 rolledBack:true。
  const clientStateUpdated = commitToClient(committed && applied > 0, ctx, workingState);
  return {
    protocolVersion: '1.0.0', kind: 'apply', commandOk: true,
    passed: applied > 0 && abstained === 0,
    stateHash: ctx.stateHash, engine,
    apply: {
      committed,
      rolledBack: false,
      stateHashBefore: ctx.stateHash,
      stateHashAfter: finalHash,
      results,
      executedCount: applied,
      rejectedCount: 0,
      abstainedCount: abstained,
      clientStateUpdated,
    },
    _workingModel: working,
    _inventory: inventory,
    diagnostics,
    capabilityGaps: [],
    notMeasured: abstained ? [{ item: 'step-completion', reason: `${abstained} 个动作 abstain，不计为该步完成` }] : [],
  };
}

/**
 * 把已提交的工作状态写回调用方的 ctx.state（原地更新，保持对象引用不变，
 * 因为 B 的会话持有同一个引用）。只在提交成功时调用。
 */
function commitToClient(committed, ctx, workingState) {
  if (!committed || !ctx.state) return false;
  ctx.state.nodes = workingState.nodes;
  ctx.state.connections = workingState.connections;
  ctx.state.occupancy = workingState.occupancy;
  ctx.state.inventory = workingState.inventory;
  return true;
}

function applyAttach({ action, ctx, working, inventory, invByToken, consumedNow, results, verdicts, appliedActionIds, engine }) {
  const d = [];
  const nodeId = action.target?.partInstanceId || action.target?.nodeId;
  if (!nodeId) {
    d.push(D('action-no-target', 'error', `动作 ${action.id} 缺少 target.partInstanceId`, { nodes: [] }));
    return reject(results, action, d, ctx);
  }
  if (working.parts.some((p) => p.id === nodeId)) {
    d.push(D('instance-id-dup', 'error', `实例 id ${nodeId} 已存在；重复提交必须用同一 actionId 才是幂等`, { nodes: [nodeId] }));
    return reject(results, action, d, ctx);
  }
  if (!action.candidateId) {
    d.push(D('action-no-candidate', 'error', `动作 ${action.id} 缺少 candidateId；引擎不接受自由坐标`, { nodes: [nodeId] }));
    return reject(results, action, d, ctx);
  }

  // 库存：token 必须存在且可用
  let token = action.inventoryToken;
  if (token) {
    const inv = invByToken.get(token);
    if (!inv) {
      d.push(D('inventory-unknown', 'error', `库存 token ${token} 不存在`, { nodes: [nodeId] }));
      return reject(results, action, d, ctx);
    }
    if (inv.state === 'consumed' || consumedNow.has(token)) {
      d.push(D('inventory-consumed', 'error', `库存 token ${token} 已被消费（重复消费）`, { nodes: [nodeId] }));
      return reject(results, action, d, ctx);
    }
    if (inv.partId !== action.partId && action.partId) {
      d.push(D('inventory-mismatch', 'error', `库存 token ${token} 是零件 ${inv.partId}，动作要装 ${action.partId}`, { nodes: [nodeId] }));
      return reject(results, action, d, ctx);
    }
  } else if (action.partId) {
    // 未给 token 时自动挑一个同类可用库存（仍保证不重复消费）。
    // 该零件在库存里有记录但全部已消费 → 必须拒绝：否则跨事务重复装配会绕过库存记账，
    // 表现为「库存明明用光了，模型还能继续长零件」。
    const samePart = inventory.filter((i) => i.partId === action.partId);
    const candidate = samePart.find((i) => i.state !== 'consumed' && !consumedNow.has(i.token));
    if (candidate) token = candidate.token;
    else if (samePart.length) {
      d.push(D('inventory-insufficient', 'error', `零件 ${action.partId} 的库存记录（${samePart.map((i) => i.token).join(',')}）全部已消费，不能再装一件`, { nodes: [nodeId] }));
      return reject(results, action, d, ctx);
    }
  }

  // 候选由引擎重新生成并核对哈希：不接受过期候选。
  // 子组件挂装必须带 childModel 一起重枚举，否则引擎只枚举单件候选、asm 候选永远找不到
  // （表现为 attach_assembly 恒报 candidate-unknown）。
  const enumRes = ctx.enumerate?.({
    childPartId: action.partId,
    ...(action.childModel ? { childModel: action.childModel } : {}),
    parentNodeId: action.candidateParentNodeId,
    maxResults: 5000,
  });
  if (!enumRes) {
    d.push(D('candidate-reeval-required', 'error', `引擎需要重新枚举候选以校验 candidateHash；本次调用未提供 enumerate 上下文`, { nodes: [nodeId] }));
    return reject(results, action, d, ctx);
  }
  const found = enumRes.items.find((c) => c.candidateId === action.candidateId);
  if (!found) {
    d.push(D('candidate-unknown', 'error', `候选 ${action.candidateId} 在当前状态下不存在（可能已过期或被其他动作占用）`, { nodes: [nodeId] }));
    return reject(results, action, d, ctx);
  }
  if (action.candidateHash && found.candidateHash !== action.candidateHash) {
    d.push(D('candidate-hash-mismatch', 'error', `候选哈希不匹配：请求 ${action.candidateHash}，当前 ${found.candidateHash}`, { nodes: [nodeId] }));
    return reject(results, action, d, ctx);
  }

  // —— 子组件挂装：一次事务提交整组，逐件复核，任一失败整批回滚 ——
  if (action.op === 'attach_assembly' || found.features?.isAssembly) {
    return applyAssemblyAttach({ action, ctx, working, inventory, invByToken, consumedNow, results, verdicts, appliedActionIds, found, nodeId, d });
  }

  // 由候选的 LDU 位姿写回 core 口径
  const orient = getOrientation(found.orientationId);
  const placed = {
    id: nodeId,
    part: found.childPartId,
    color: action.color ?? 0,
    at: [r6(found.translationLdu[0] / 20), r6(found.translationLdu[1] / 8), r6(found.translationLdu[2] / 20)],
    rot: orient.rot,
    up: orient.up,
    snot: found.snot ?? 0,
    step: action.step ?? 1,
  };

  // 复核物理连接（不接受只有元数据的「假连接」）
  const parent = working.parts.find((p) => p.id === found.parentNodeId);
  if (!parent) {
    d.push(D('missing-reference', 'error', `候选的父节点 ${found.parentNodeId} 不在模型中`, { nodes: [nodeId, found.parentNodeId] }));
    return reject(results, action, d, ctx);
  }
  const connected = partsConnected(parent, ctx.cat.parts[parent.part], placed, ctx.cat.parts[placed.part]);
  if (!connected) {
    d.push(D('fake-connection', 'error', `应用后 ${nodeId} 与父件 ${parent.id} 之间没有真实物理连接（连接器未对准）`, { nodes: [nodeId, parent.id] }));
    return reject(results, action, d, ctx);
  }
  const conflict = findCollision(placed, ctx.cat.parts[placed.part], working, ctx.cat, nodeId);
  if (conflict) {
    d.push(D('collision', 'error', `应用后 ${nodeId} 与 ${conflict} 穿模`, { nodes: [nodeId, conflict] }));
    return reject(results, action, d, ctx);
  }

  working.parts.push(placed);
  if (token) consumeToken(inventory, invByToken, token, nodeId, consumedNow);
  appliedActionIds.set(action.id, { nodeId, tokens: token ? [token] : [] });
  verdicts.set(action.id, 'ok');
  results.push({
    actionId: action.id, op: action.op, status: 'applied',
    applied: {
      nodeId,
      translationLdu: found.translationLdu,
      orientationId: found.orientationId,
      snot: found.snot,
      inventoryToken: token ?? null,
      connectorsUsed: [found.parentConnectorId, found.childConnectorId],
      physicalConnection: true,
    },
    stateHashAfter: null,   // 每批结束统一算
  });
  return null;   // 继续下一动作
}

/**
 * attach_assembly 的原子提交：整组一次性落位，逐件复核连接/碰撞/库存。
 *
 * 为什么不能复用单件路径：子组件是多件刚体，锚点件扣在父件上，其余件由 rigid 变换带过来。
 * 任何一件穿模、或与父件之外已装件的连接缺失，都必须让**整组**不落地，
 * 不能出现「锚点件装上了、另外三件没装上」的半成品状态。
 */
function applyAssemblyAttach({ action, ctx, working, inventory, invByToken, consumedNow, results, verdicts, appliedActionIds, found, nodeId, d }) {
  const placedMembers = found._placed;
  if (!Array.isArray(placedMembers) || !placedMembers.length) {
    d.push(D('assembly-candidate-incomplete', 'error', `候选 ${action.candidateId} 是子组件挂装，但没有携带成员位姿（_placed 缺失）：无法原子提交`, { nodes: [nodeId] }));
    return reject(results, action, d, ctx);
  }
  // 实例 id：锚点用动作给的 nodeId，其余成员用 `<nodeId>/<memberId>` 前缀，避免与既有实例撞名
  const idOf = (memberId) => (memberId === found.childNodeId ? nodeId : `${nodeId}/${memberId}`);
  const taken = new Set(working.parts.map((p) => p.id));
  for (const m of placedMembers) {
    if (taken.has(idOf(m.id))) {
      d.push(D('instance-id-dup', 'error', `子组件成员实例 id ${idOf(m.id)} 已存在`, { nodes: [idOf(m.id)] }));
      return reject(results, action, d, ctx);
    }
  }

  // 库存：整组按件号扣，token 必须够且不重复消费
  const needByPart = new Map();
  for (const m of placedMembers) needByPart.set(m.part, (needByPart.get(m.part) || 0) + 1);
  const tokensUsed = [];
  for (const [partId, count] of needByPart) {
    const avail = inventory.filter((i) => i.partId === partId && i.state !== 'consumed' && !consumedNow.has(i.token));
    if (avail.length < count) {
      d.push(D('inventory-insufficient', 'error', `子组件需要 ${count} 个零件 ${partId}，可用库存只有 ${avail.length} 个`, { nodes: [nodeId] }));
      return reject(results, action, d, ctx);
    }
    tokensUsed.push(...avail.slice(0, count).map((i) => i.token));
  }

  // 逐件复核：与现有零件的碰撞（含父件），以及至少与组合内某件或父件真实连接
  const memberIds = new Set(placedMembers.map((m) => m.id));
  for (const m of placedMembers) {
    const def = ctx.cat.parts[m.part];
    if (!def) {
      d.push(D('missing-asset', 'error', `子组件成员 ${m.id} 的零件 ${m.part} 不在目录中`, { nodes: [idOf(m.id)] }));
      return reject(results, action, d, ctx);
    }
    const probe = { ...m, id: idOf(m.id) };
    const conflict = findCollision(probe, def, working, ctx.cat, probe.id);
    if (conflict) {
      d.push(D('collision', 'error', `子组件成员 ${probe.id} 与 ${conflict} 穿模`, { nodes: [probe.id, conflict] }));
      return reject(results, action, d, ctx);
    }
    // 连接性：锚点件必须与父件真实扣合；其余件必须与组合内某件或父件扣合
    if (m.id === found.childNodeId) {
      const parent = working.parts.find((p) => p.id === found.parentNodeId);
      if (!parent) {
        d.push(D('missing-reference', 'error', `候选的父节点 ${found.parentNodeId} 不在模型中`, { nodes: [probe.id, found.parentNodeId] }));
        return reject(results, action, d, ctx);
      }
      if (!partsConnected(parent, ctx.cat.parts[parent.part], probe, def)) {
        d.push(D('fake-connection', 'error', `锚点件 ${probe.id} 与父件 ${parent.id} 之间没有真实物理连接`, { nodes: [probe.id, parent.id] }));
        return reject(results, action, d, ctx);
      }
    } else {
      let connected = false;
      for (const other of placedMembers) {
        if (other.id === m.id) continue;
        const oProbe = { ...other, id: idOf(other.id) };
        if (partsConnected(oProbe, ctx.cat.parts[oProbe.part], probe, def)) { connected = true; break; }
      }
      if (!connected) {
        d.push(D('assembly-disconnected', 'error', `子组件成员 ${probe.id} 与组内其他零件没有真实物理连接（刚体变换没有把它带到扣合位置）`, { nodes: [probe.id] }));
        return reject(results, action, d, ctx);
      }
    }
  }

  // —— 全部通过：一次写入 ——
  for (const m of placedMembers) {
    const probe = { ...m, id: idOf(m.id) };
    delete probe._srcId;
    working.parts.push(probe);
  }
  for (const t of tokensUsed) consumeToken(inventory, invByToken, t, nodeId, consumedNow);
  appliedActionIds.set(action.id, { nodeId, memberIds: placedMembers.map((m) => idOf(m.id)), tokens: tokensUsed });
  verdicts.set(action.id, 'ok');
  results.push({
    actionId: action.id, op: action.op, status: 'applied',
    applied: {
      nodeId,
      memberNodeIds: placedMembers.map((m) => idOf(m.id)),
      memberCount: placedMembers.length,
      translationLdu: found.translationLdu,
      orientationId: found.orientationId,
      inventoryTokens: tokensUsed,
      connectorsUsed: [found.parentConnectorId, found.childConnectorId],
      physicalConnection: true,
      atomic: true,
    },
    stateHashAfter: null,
  });
  return null;
}

/**
 * detach：把一个已装件从模型上拆下来。
 *
 * 与 undo 的区别：undo 撤销「本批次刚应用的动作」，detach 拆「当前模型里已经存在的件」，
 * 两者都不需要重新生成候选（拆不需要位姿求解）。
 *
 * 拒绝条件：拆完会让别的零件失去唯一连接（变成悬空）。修复动作不应该以「把问题换个形式」
 * 收场，所以这里不给「拆了但留下悬空件」放行，而是明确报出会变成孤立的件。
 */
function applyDetach({ action, ctx, working, inventory, invByToken, results, verdicts, appliedActionIds }) {
  const d = [];
  const nodeId = action.repair?.detachNodeId || action.target?.partInstanceId || action.target?.nodeId;
  if (!nodeId) {
    d.push(D('detach-no-target', 'error', `detach 动作 ${action.id} 缺少 repair.detachNodeId 或 target.partInstanceId`, { nodes: [] }));
    return reject(results, action, d, ctx);
  }
  const idx = working.parts.findIndex((p) => p.id === nodeId);
  if (idx < 0) {
    d.push(D('detach-unknown-node', 'error', `detach 目标 ${nodeId} 不在模型中`, { nodes: [nodeId] }));
    return reject(results, action, d, ctx);
  }
  const victim = working.parts[idx];
  const remaining = working.parts.filter((p) => p.id !== nodeId);
  const before = connectionsAmong(working.parts, ctx.cat);
  const after = connectionsAmong(remaining, ctx.cat);

  // 原先有连接、拆完变成零连接的件 = 被这次 detach 弄成悬空的
  const orphaned = [];
  for (const p of remaining) {
    const had = (before.get(p.id) || new Set()).size;
    const has = (after.get(p.id) || new Set()).size;
    if (had > 0 && has === 0) orphaned.push(p.id);
  }
  if (orphaned.length) {
    d.push(D('detach-orphans-parts', 'error',
      `拆下 ${nodeId} 会让 ${orphaned.length} 个零件失去唯一连接（悬空）：${orphaned.slice(0, 6).join(',')}${orphaned.length > 6 ? '…' : ''}；`
      + '修复动作不接受「拆完留下悬空件」', { nodes: [nodeId, ...orphaned] }));
    return reject(results, action, d, ctx);
  }

  working.parts = remaining;
  // 库存按 consumedBy 反查：detach 的目标可能来自更早的事务，本批次没有它的动作记录
  const released = releaseTokensByNode(inventory, nodeId);
  appliedActionIds.set(action.id, { nodeId, detached: true, tokens: released });
  verdicts.set(action.id, 'ok');
  results.push({
    actionId: action.id, op: action.op, status: 'applied',
    applied: {
      nodeId,
      detached: true,
      detachedPart: `${victim.part}/${victim.color}`,
      releasedInventoryTokens: released,
      remainingParts: remaining.length,
    },
    stateHashAfter: null,
  });
  return null;
}

/**
 * replace：原地把一个零件换成另一个件号（颜色可选）。
 *
 * 位姿不动（at/rot/up/snot 全保留），因为换件的语义是「这个位置该用另一个件」，
 * 不是「重新求解落位」。因此必须验证新件在同一位置仍然：
 *   1) 不与任何其他零件穿模；
 *   2) 至少与原件的某个邻居保持真实连接（不能换成一坨悬空件）。
 * 任一不满足即拒绝，并要求改用 attach 重新求解候选。
 */
function applyReplace({ action, ctx, working, inventory, invByToken, consumedNow, results, verdicts, appliedActionIds }) {
  const d = [];
  const nodeId = action.target?.partInstanceId || action.target?.nodeId || action.repair?.detachNodeId;
  const newPartId = action.repair?.replacePartId || action.partId;
  if (!nodeId) {
    d.push(D('replace-no-target', 'error', `replace 动作 ${action.id} 缺少 target.partInstanceId`, { nodes: [] }));
    return reject(results, action, d, ctx);
  }
  if (!newPartId) {
    d.push(D('replace-no-part', 'error', `replace 动作 ${action.id} 缺少 repair.replacePartId（要换成什么件）`, { nodes: [nodeId] }));
    return reject(results, action, d, ctx);
  }
  const idx = working.parts.findIndex((p) => p.id === nodeId);
  if (idx < 0) {
    d.push(D('replace-unknown-node', 'error', `replace 目标 ${nodeId} 不在模型中`, { nodes: [nodeId] }));
    return reject(results, action, d, ctx);
  }
  const old = working.parts[idx];
  const newDef = ctx.cat.parts[newPartId];
  if (!newDef) {
    d.push(D('missing-asset', 'error', `零件 ${newPartId} 不在目录中`, { nodes: [nodeId] }));
    return reject(results, action, d, ctx);
  }
  if (old.part === newPartId && (action.color === undefined || action.color === old.color)) {
    d.push(D('replace-noop', 'error', `replace 目标 ${nodeId} 已经是 ${newPartId}/${old.color}，换件不改变任何东西`, { nodes: [nodeId] }));
    return reject(results, action, d, ctx);
  }

  const replaced = {
    ...old,
    part: newPartId,
    color: action.color ?? old.color,
    revision: action.repair?.replaceRevision ?? undefined,
  };
  if (replaced.revision === undefined) delete replaced.revision;

  // 1) 碰撞：新件在同一位置不得与任何其他件穿模
  const conflict = findCollision(replaced, newDef, working, ctx.cat, nodeId);
  if (conflict) {
    d.push(D('collision', 'error', `换件后 ${nodeId}（${newPartId}）与 ${conflict} 穿模；同姿态换不上就是换不上，不改位姿凑合`, { nodes: [nodeId, conflict] }));
    return reject(results, action, d, ctx);
  }

  // 2) 连接：新件必须仍与原件的至少一个邻居真实扣合
  const neighbors = [...(connectionsAmong(working.parts, ctx.cat).get(nodeId) || [])];
  if (!neighbors.length) {
    d.push(D('replace-no-neighbours', 'error', `replace 目标 ${nodeId} 原本就没有任何物理连接，换件后仍然是悬空件`, { nodes: [nodeId] }));
    return reject(results, action, d, ctx);
  }
  const stillConnected = [];
  for (const nbId of neighbors) {
    const nb = working.parts.find((p) => p.id === nbId);
    if (!nb) continue;
    const nbDef = ctx.cat.parts[nb.part];
    if (!nbDef) continue;
    if (partsConnected(nb, nbDef, replaced, newDef)) stillConnected.push(nbId);
  }
  if (!stillConnected.length) {
    d.push(D('replace-disconnected', 'error',
      `换件后 ${nodeId}（${newPartId}）与原来的 ${neighbors.length} 个邻居（${neighbors.slice(0, 6).join(',')}）全部失去真实连接；`
      + '同姿态换件装不上时应走 detach + attach 重新求解候选，不要静默留下悬空件', { nodes: [nodeId, ...neighbors] }));
    return reject(results, action, d, ctx);
  }

  // 3) 库存：先占新件的 token，再释放旧件的 token
  const tokensUsed = [];
  const samePart = inventory.filter((i) => i.partId === newPartId && i.state !== 'consumed' && !consumedNow.has(i.token));
  if (action.inventoryToken) {
    const inv = invByToken.get(action.inventoryToken);
    if (!inv) { d.push(D('inventory-unknown', 'error', `库存 token ${action.inventoryToken} 不存在`, { nodes: [nodeId] })); return reject(results, action, d, ctx); }
    if (inv.state === 'consumed' || consumedNow.has(inv.token)) { d.push(D('inventory-consumed', 'error', `库存 token ${inv.token} 已被消费`, { nodes: [nodeId] })); return reject(results, action, d, ctx); }
    if (inv.partId !== newPartId) { d.push(D('inventory-mismatch', 'error', `库存 token ${inv.token} 是零件 ${inv.partId}，换件要装 ${newPartId}`, { nodes: [nodeId] })); return reject(results, action, d, ctx); }
    tokensUsed.push(inv.token);
  } else if (samePart.length) {
    tokensUsed.push(samePart[0].token);
  } else if (inventory.some((i) => i.partId === newPartId)) {
    // 有该件号的库存记录但全被消费了 → 明确拒绝，不能凭空变出一件
    d.push(D('inventory-insufficient', 'error', `零件 ${newPartId} 的库存记录全部已消费，不能替换进来`, { nodes: [nodeId] }));
    return reject(results, action, d, ctx);
  }
  for (const t of tokensUsed) consumeToken(inventory, invByToken, t, nodeId, consumedNow);
  const released = releaseTokensByNode(inventory, nodeId, old.part);

  working.parts[idx] = replaced;
  appliedActionIds.set(action.id, { nodeId, replaced: true, from: old.part, to: newPartId, tokens: tokensUsed });
  verdicts.set(action.id, 'ok');
  results.push({
    actionId: action.id, op: action.op, status: 'applied',
    applied: {
      nodeId,
      replaced: true,
      from: `${old.part}/${old.color}`,
      to: `${newPartId}/${replaced.color}`,
      keptPose: { at: old.at, rot: old.rot, up: old.up, snot: old.snot },
      connectedTo: stillConnected,
      lostConnections: neighbors.filter((n) => !stillConnected.includes(n)),
      inventoryTokens: tokensUsed,
      releasedInventoryTokens: released,
    },
    stateHashAfter: null,
  });
  return null;
}

/**
 * 统计零件之间的真实物理连接（邻接表）。
 * 与 state.js 的 inspect 口径一致：只认连接器实测，不认模型自报的 subassembly 字段。
 */
function connectionsAmong(parts, cat) {
  const adj = new Map(parts.map((p) => [p.id, new Set()]));
  const connOf = new Map();
  for (const p of parts) {
    const def = cat.parts[p.part];
    if (!def) { connOf.set(p.id, { studs: [], receptors: [] }); continue; }
    try { connOf.set(p.id, partConnectors(p, def)); } catch { connOf.set(p.id, { studs: [], receptors: [] }); }
  }
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i], b = parts[j];
      const da = cat.parts[a.part], db = cat.parts[b.part];
      if (!da || !db) continue;
      let connected = false;
      try { connected = partsConnected(a, da, b, db, connOf.get(a.id), connOf.get(b.id)); } catch { connected = false; }
      if (!connected) continue;
      adj.get(a.id).add(b.id);
      adj.get(b.id).add(a.id);
    }
  }
  return adj;
}

/** 按 consumedBy 反查释放：detach 的目标常常来自更早的事务，本批次没有它的动作记录 */
function releaseTokensByNode(inventory, nodeId, expectPartId = null) {
  const tokens = inventory
    .filter((i) => i.consumedBy === nodeId && i.state === 'consumed' && (!expectPartId || i.partId === expectPartId))
    .map((i) => i.token);
  for (const t of tokens) {
    const rec = inventory.find((i) => i.token === t);
    if (!rec) continue;
    rec.state = 'available';
    delete rec.consumedBy;
    delete rec.consumedAt;
  }
  return tokens;
}

function reject(results, action, diags, ctx) {
  results.push({ actionId: action.id, op: action.op, status: 'rejected', diagnostics: diags });
  return {
    protocolVersion: '1.0.0', kind: 'apply', commandOk: true, passed: false,
    stateHash: ctx.stateHash,
    engine: { engineRevision: 'actions-v1@1.0.0', contractVersion: '1.0.0', mock: false },
    apply: {
      committed: false, rolledBack: true,
      stateHashBefore: ctx.stateHash, stateHashAfter: ctx.stateHash,
      results,
      executedCount: results.filter((r) => r.status === 'applied').length,
      rejectedCount: results.filter((r) => r.status === 'rejected').length,
      abstainedCount: results.filter((r) => r.status === 'abstained').length,
    },
    diagnostics: diags,
    capabilityGaps: [], notMeasured: [{ item: 'apply', reason: diags[0]?.code || 'rejected' }],
  };
}

function findCollision(placed, def, model, cat, exceptId) {
  let boxes;
  try { boxes = partBoxes(placed, def); } catch { return '__collision_box_unavailable__'; }
  for (const other of model.parts || []) {
    if (other.id === exceptId || other.id === placed.id) continue;
    const oDef = cat.parts[other.part];
    if (!oDef) continue;
    let oBoxes;
    try { oBoxes = partBoxes(other, oDef); } catch { continue; }
    if (partsCollide(placed, def, boxes, other, oDef, oBoxes)) return other.id;
  }
  return null;
}

/**
 * 把 token 标成持久 consumed，并记下消费去向（哪个实例、哪个动作）。
 *
 * 必须写到 inventory 记录本体而不是只记在 consumedNow：
 * 事务成功提交后调用方拿到的是这份 inventory，下一事务从它继续。
 */
function consumeToken(inventory, invByToken, token, nodeId, consumedNow) {
  consumedNow.add(token);
  const rec = invByToken.get(token) || inventory.find((i) => i.token === token);
  if (!rec) return;
  rec.state = 'consumed';
  rec.consumedBy = nodeId;
  rec.consumedAt = 'transaction';   // 无真实时钟：只标来源，不写易变时间戳污染 stateHash
}

/**
 * 撤销已提交动作时把 token 放回可用。
 *
 * 不放回会让 undo 变成「消耗一次机会」：同一组零件再也装不回去，库存永久短缺，
 * 而 undo 的语义是恢复到动作之前的状态，库存也必须一起恢复。
 */
function releaseTokens(inventory, invByToken, tokens) {
  const released = [];
  for (const t of tokens) {
    const rec = invByToken.get(t) || inventory.find((i) => i.token === t);
    if (!rec || rec.state !== 'consumed') continue;
    rec.state = 'available';
    delete rec.consumedBy;
    delete rec.consumedAt;
    released.push(t);
  }
  return released;
}

/**
 * 从工作模型 + 工作库存重算状态。库存状态以记录本体为准，不再把 consumed 降回 available。
 * 之前这里写 `state === 'consumed' ? 'consumed' : (state || 'available')`，看着对，
 * 但来源对象里的 state 从未被写成 consumed，等于整条链路都拿不到消费事实。
 */
function rehash(working, cat, inventory, prevState, ctx) {
  const fresh = inspectFromModel(working, cat, { mainRootNodeId: ctx.mainRootNodeId, inventory });
  prevState.nodes = fresh.state.nodes;
  prevState.connections = fresh.state.connections;
  prevState.occupancy = fresh.state.occupancy;
  prevState.inventory = inventory.map((i) => ({ ...i }));
  return fresh.stateHash;
}
