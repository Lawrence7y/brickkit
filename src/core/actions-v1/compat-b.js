// C1 兼容适配层：把 A 的引擎接口包装成 B 的 REQ-B01 字段命名，以及反向适配。
//
// 为什么需要这一层：B 的请求提出用 `parentInstanceId` + `stud_0` / `antistud_0` 命名，
// A 的引擎内部用 `parentNodeId` + `ctop#N` / `cantistud#N`。两者语义相同、拼写不同。
// 与其让一方去改私有实现，这里集中做一次映射，并把映射**显式化、可测试**：
//   B 风格（parentInstanceId / stud_0 / antistud_0 / free|occupied）
//   A 风格（parentNodeId / ckind#index / occupied）
//
// 契约冻结时以 contracts-1.0 的 assembly/action Schema 为准；本模块是**唯一**允许
// 在两种拼写间转换的地方，避免各处各自实现一份映射而漂移。

import { enumerateCandidates } from './candidates.js';
import { applyActions } from './apply.js';
import { inspectFromModel } from './state.js';
import { partConnectors } from '../core.js';

const B_KINDS = new Set(['stud', 'antistud', 'bar', 'clip', 'pin', 'hole', 'axle', 'rim', 'tyre']);

/** A 的短名 → B 的命名：ctop#3 → stud_top_3；cantistud#0 → antistud_0；cside#2 → stud_side_2
 *
 * 注意：B 的草案用 `stud_N` 统称顶凸点，但顶凸点与侧凸点是不同物理接口，共用一种拼写会
 * 让 `stud_3 → ctop#3` 与 `stud_3 → cside#3` 无法区分（有损映射）。这里统一加 `_top`/`_side`
 * 限定来源，保证 to/from 严格互逆；`stud_N` 仍作为**只读入**的兼容写法按顶凸点解释。
 */
export function toBConnectorId(shortId) {
  if (!shortId) return null;
  if (!shortId.startsWith('c')) return shortId;
  const hashAt = shortId.indexOf('#');
  if (hashAt < 0) return shortId;
  const kind = shortId.slice(1, hashAt);
  const idx = shortId.slice(hashAt + 1);
  if (!/^\d+$/.test(idx)) return shortId;
  switch (kind) {
    case 'top': return `stud_top_${idx}`;
    case 'side': return `stud_side_${idx}`;
    case 'antistud': return `antistud_${idx}`;
    case 'bar': return `bar_${idx}`;
    case 'clip': return `clip_${idx}`;
    case 'pin': return `pin_${idx}`;
    case 'hole': return `hole_${idx}`;
    case 'axle': return `axle_${idx}`;
    case 'rim': return `rim_${idx}`;
    case 'tyre': return `tyre_${idx}`;
    default: return `${kind}_${idx}`;
  }
}

/** B 的命名 → A 的短名：stud_top_3 → ctop#3；antistud_0 → cantistud#0；stud_side_2 → cside#2
 *  裸 `stud_N` 按顶凸点解释（B 草案写法）。 */
export function fromBConnectorId(bId) {
  if (!bId) return null;
  if (bId.startsWith('c') && bId.includes('#')) return bId;   // 已是 A 短名
  const parts = bId.split('_');
  if (parts.length < 2 || parts.length > 3) return bId;
  const idx = parts[parts.length - 1];
  if (!/^\d+$/.test(idx)) return bId;
  const head = parts[0];
  if (!B_KINDS.has(head)) return bId;
  if (parts.length === 2) {
    // 裸写法：stud_N 视为顶凸点（B 草案写法），其余类型按同名直译
    const aKind = head === 'stud' ? 'top' : head;
    return `c${aKind}#${idx}`;
  }
  // 三段：stud_top_N / stud_side_N
  const where = parts[1];
  if (head !== 'stud' || (where !== 'top' && where !== 'side')) return bId;
  return `c${where}#${idx}`;
}

/** A 的候选 → B 的期望形态（REQ-B01 §2.1） */
export function candidateToB(c) {
  return {
    candidateId: c.candidateId,
    parentInstanceId: c.parentNodeId,
    parentConnectorId: toBConnectorId(c.parentConnectorId),
    childPartId: c.childPartId,
    childConnectorId: toBConnectorId(c.childConnectorId),
    orientationId: c.orientationId,
    spinDeg: c.spinDeg,
    translationLdu: c.translationLdu,
    snot: c.snot,
    candidateHash: c.candidateHash,
    equivalenceGroup: c.equivalenceGroup,
    inventoryToken: c.inventoryToken,
    collisionChecked: c.collisionChecked,
    features: c.features,
    // B 只需要「几何合法」；「符合说明书意图」由 B 或主会话排序
    mock: false,
  };
}

/**
 * B 风格的候选枚举。
 * @param state A 的 state（inspectFromModel 产物）
 * @param bRequest { taskId, stateHash, childPartId, targetRegion?: {parentInstanceIds}, maxResults }
 */
export function enumerateCandidatesForB(state, bRequest, cat, opts = {}) {
  const parentIds = bRequest.targetRegion?.parentInstanceIds || [];
  const parentNodeId = parentIds.length === 1 ? parentIds[0] : undefined;
  const internal = {
    childPartId: bRequest.childPartId,
    parentNodeId,
    maxResults: bRequest.maxResults ?? 64,
    ...(bRequest.orientationIds ? { orientationIds: bRequest.orientationIds } : {}),
  };
  const res = enumerateCandidates(state, internal, cat, opts);
  const items = res.items.map(candidateToB);
  // 多父件：逐个枚举后合并（REQ 里 targetRegion.parentInstanceIds 是集合）
  let complete = res.enumerationComplete;
  let truncated = res.truncated;
  if (!parentNodeId && parentIds.length > 1) {
    complete = true;
    for (const pid of parentIds) {
      const sub = enumerateCandidates(state, { ...internal, parentNodeId: pid }, cat, opts);
      if (!sub.enumerationComplete) complete = false;
      if (sub.truncated) truncated = true;
      for (const c of sub.items) {
        const b = candidateToB(c);
        if (!items.some((x) => x.candidateId === b.candidateId)) items.push(b);
      }
    }
  }
  return {
    ok: items.length > 0,
    enumerationComplete: complete,
    truncated,
    candidateCount: items.length,
    candidates: items,
    noSolutionReason: res.noSolutionReason,
    noSolutionDetail: res.noSolutionDetail,
    capabilityGaps: res.capabilityGaps,
    stateHash: bRequest.stateHash,
    mock: false,
  };
}

/** B 的动作（inference-protocol）→ A 的 action request */
export function bActionsToRequest(bActions, { taskId, stateHash, repairMode = false, actionSource }) {
  return {
    protocolVersion: '1.0.0',
    taskId,
    stateHash,
    repairMode,
    ...(actionSource ? { actionSource } : {}),
    actions: (bActions || []).map((a, i) => {
      const id = a.id || `b-act-${i + 1}`;
      if (a.op === 'abstain') {
        return {
          id,
          op: 'abstain',
          reason: a.reason || 'unspecified',
          needs: a.needs || (a.requestedView ? [`view:${JSON.stringify(a.requestedView)}`] : ['missing-info']),
        };
      }
      if (a.op === 'inspect') return { id, op: 'inspect' };
      return {
        id,
        op: a.op,
        ...(a.candidateId ? { candidateId: a.candidateId } : {}),
        ...(a.candidateHash ? { candidateHash: a.candidateHash } : {}),
        ...(a.partId ? { partId: a.partId } : {}),
        ...(a.partInstanceId ? { target: { partInstanceId: a.partInstanceId } } : {}),
        ...(a.target ? { target: a.target } : {}),
        ...(a.inventoryToken || a.consumedTokenId ? { inventoryToken: a.inventoryToken || a.consumedTokenId } : {}),
        ...(a.dependsOn ? { dependsOn: a.dependsOn } : {}),
      };
    }),
  };
}

/** A 的状态响应 → B 期望的形态（REQ-B01 §2.3：接口占用 free/occupied + 可达性） */
export function stateToB(si, cat, opts = {}) {
  const occupancyByNode = new Map();
  for (const o of si.state.occupancy || []) {
    if (!occupancyByNode.has(o.nodeId)) occupancyByNode.set(o.nodeId, new Map());
    occupancyByNode.get(o.nodeId).set(o.connectorId, o.occupiedBy);
  }
  const toLdu = (pos) => [
    Math.round(pos[0] * 20 * 1e6) / 1e6,
    Math.round(pos[1] * 8 * 1e6) / 1e6,
    Math.round(pos[2] * 20 * 1e6) / 1e6,
  ];
  const nodes = si.state.nodes.map((n) => {
    const def = cat.parts[n.partId];
    let conn = { studs: [], receptors: [] };
    try { conn = partConnectors(n, def); } catch { /* 连接器不可用：下面显式标 unsupported */ }
    const occ = occupancyByNode.get(n.nodePath) || new Map();
    const connectors = [
      ...conn.studs.map((s) => {
        const aid = `c${s.kind}#${s.index}`;
        return {
          connectorId: toBConnectorId(aid),
          stableId: aid,
          type: s.kind,
          role: 'male',
          dir: s.dir,
          posLdu: toLdu(s.pos),
          state: occ.has(aid) ? 'occupied' : 'free',
          occupiedBy: occ.get(aid) || null,
        };
      }),
      ...conn.receptors.map((r) => {
        const aid = `c${r.kind}#${r.index}`;
        return {
          connectorId: toBConnectorId(aid),
          stableId: aid,
          type: r.kind,
          role: 'female',
          dir: r.dir,
          posLdu: toLdu(r.pos),
          state: occ.has(aid) ? 'occupied' : 'free',
          occupiedBy: occ.get(aid) || null,
        };
      }),
    ];
    return {
      instanceId: n.nodePath,
      partId: n.partId,
      color: n.color,
      at: n.at,
      rot: n.rot,
      up: n.up,
      snot: n.snot,
      connectors,
      connectorCapability: conn.studs.length || conn.receptors.length ? 'available' : 'unsupported',
    };
  });
  return {
    ok: true,
    stateHash: si.stateHash,
    taskId: opts.taskId ?? null,
    instances: nodes,
    connections: si.state.connections.map((c) => ({
      aInstanceId: c.aNodeId, aConnectorId: toBConnectorId(c.aConnectorId),
      bInstanceId: c.bNodeId, bConnectorId: toBConnectorId(c.bConnectorId),
      mateProfile: c.mateProfile,
    })),
    reachability: si.state.reachability,
    stats: si.stats,
    mock: false,
  };
}

/**
 * 端到端便捷入口：B 侧只要给 model + bActions 就能跑一次事务。
 * 返回 A 的 apply 结果，并把关键字段额外翻成 B 的命名。
 */
export function applyActionsForB(ctx, bActions, opts = {}) {
  const si = ctx.state && ctx.stateHash
    ? { state: ctx.state, stateHash: ctx.stateHash }
    : inspectFromModel(ctx.model, ctx.cat, { mainRootNodeId: ctx.mainRootNodeId, inventory: ctx.inventory });
  const request = bActionsToRequest(bActions, {
    taskId: ctx.taskId,
    stateHash: ctx.stateHash || si.stateHash,
    repairMode: opts.repairMode,
    actionSource: opts.actionSource,
  });
  const baseState = ctx.state || si.state;
  const internalCtx = {
    ...ctx,
    stateHash: ctx.stateHash || si.stateHash,
    state: baseState,
    enumerate: (req) => enumerateCandidates(baseState, req, ctx.cat),
  };
  const res = applyActions(internalCtx, request, opts);
  return {
    ...res,
    bView: {
      ok: res.passed,
      staleState: (res.diagnostics || []).some((d) => d.code === 'stale-state'),
      appliedActionIds: (res.apply?.results || []).filter((r) => r.status === 'applied').map((r) => r.actionId),
      abstainedActionIds: (res.apply?.results || []).filter((r) => r.status === 'abstained').map((r) => r.actionId),
    },
  };
}
