// 装配状态（inspectState）：从权威源或 0.2 模型构建可查询状态，计算 stateHash。
//
// stateHash 覆盖语义字段且排序稳定，不含 generatedAt 等易变元数据（AS-05）。
// 它是动作协议的幂等/过期判据：stateHash 不匹配 → stale-state，整批动作拒绝。

import crypto from 'node:crypto';
import {
  partConnectors, partsConnected, partBoxes, partsCollide, bom as coreBom,
  nearPairCandidates, partAabbWithMargin, rimTyreMatches, barClipMatches, doorHingeMatches,
} from '../core.js';

const stableStringify = (v) => {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().filter((k) => !['generatedAt', 'recordedAt', 'checkedAt'].includes(k))
      .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
};

export const stateHashOf = (payload) => crypto.createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex');

/**
 * 从 0.2 兼容模型构建状态。nodes 的 nodePath 用零件 id（扁平模型没有实例路径）。
 *
 * @param {object} model brickbuild 0.2 模型
 * @param {object} cat { parts, colors }
 * @param {object} [opts] { inventory: [], taskId, mainRootNodeId }
 */
export function inspectFromModel(model, cat, opts = {}) {
  const parts = (model.parts || []).filter((p) => p && cat.parts[p.part]);
  const nodes = parts.map((p) => ({
    nodePath: p.id,
    partId: p.part,
    revision: p.revision,
    color: p.color,
    at: p.at,
    rot: p.rot ?? 0,
    up: p.up ?? '+y',
    snot: p.snot ?? 0,
    componentPath: p.subassembly || null,
    stepOrder: p.step,
  }));

  // 连接图：真实连接器匹配（不是元数据声明）
  const connOf = new Map();
  for (const p of parts) {
    try { connOf.set(p.id, partConnectors(p, cat.parts[p.part])); }
    catch { connOf.set(p.id, { studs: [], receptors: [] }); }
  }
  // CP-02：栅格裁剪出「可能物理扣合」的候选对（每件按自身连接器外悬外扩，保守超集）；
  // near[i] 升序 → connections 数组顺序与朴素双重循环完全一致（stateHash 不变）。
  const near = nearPairCandidates(parts.map((p) => partAabbWithMargin(p, cat.parts[p.part], connOf.get(p.id))));
  const connections = [];
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i], ca = connOf.get(a.id);
    for (const j of near[i]) {
      const b = parts[j], cb = connOf.get(b.id);
      if (!partsConnected(a, cat.parts[a.part], b, cat.parts[b.part], ca, cb)) continue;
      // 一对零件之间可能同时有多个接口扣合（2×4 叠 2×4 是 8 对凸点/底孔）。
      // 只记第一对会让 occupancy 少标 7 个接口，候选枚举与标号渲染都会把已被占用的凸点当成空闲。
      const pairs = findAllConnectorPairs(ca, cb, cat.parts[a.part], cat.parts[b.part]);
      if (!pairs.length) {
        if (doorHingeMatches(a, cat.parts[a.part], b, cat.parts[b.part])) continue; // 门扇↔门框由下方 doorLinks 统一写入 door-hinge-v1
        // 连通但无法定位到具体接口（例如轮胎套轮毂的同心判定）→ 保留零件对级连接，接口占用记为未知
        connections.push({ aNodeId: a.id, aConnectorId: null, bNodeId: b.id, bConnectorId: null, mateProfile: null, connectorPairsUnknown: true });
        continue;
      }
      for (const pair of pairs) {
        connections.push({
          aNodeId: a.id, aConnectorId: pair.a,
          bNodeId: b.id, bConnectorId: pair.b,
          mateProfile: pair.profile,
        });
      }
    }
  }

  // 门 ↔ 门框：门的铰链在官方 .dat 里没有销孔图元（是造型暗示，不是可连接接口），
  // 所以物理判据无从判定——validate 一直用「kind==='door' 且 mount 指向门框」这条**模型级声明**放行。
  // 状态层原先不认这条规则，于是同一扇门在 validate 里连着、在状态图里断开（cottage 1 vs 2 分量）。
  // 这里补上同一条规则，并显式标记来源，两条判据对「门」的结论从此一致。
  const doorLinks = new Set(connections.map((c) => [c.aNodeId, c.bNodeId].sort().join('|')));
  const byIdAll = new Map(parts.map((p) => [p.id, p]));
  for (const p of parts) {
    if (cat.parts[p.part]?.kind !== 'door' || !p.mount) continue;
    const parent = byIdAll.get(p.mount);
    if (!parent || cat.parts[parent.part]?.kind !== 'doorframe') continue;
    const key = [p.id, parent.id].sort().join('|');
    if (doorLinks.has(key)) continue;
    doorLinks.add(key);
    connections.push({
      aNodeId: p.id, aConnectorId: null,
      bNodeId: parent.id, bConnectorId: null,
      mateProfile: 'door-hinge-v1', connectorPairsUnknown: true,
    });
  }

  // 接口占用：每个被真实连接用到的连接器记为 occupied
  const occupancy = [];
  for (const c of connections) {
    if (c.aConnectorId) occupancy.push({ nodeId: c.aNodeId, connectorId: c.aConnectorId, occupiedBy: c.bNodeId });
    if (c.bConnectorId) occupancy.push({ nodeId: c.bNodeId, connectorId: c.bConnectorId, occupiedBy: c.aNodeId });
  }

  // 可达性
  const adj = new Map(parts.map((p) => [p.id, new Set()]));
  for (const c of connections) { adj.get(c.aNodeId)?.add(c.bNodeId); adj.get(c.bNodeId)?.add(c.aNodeId); }
  const comps = connectedComponents(adj);
  const mainRoot = opts.mainRootNodeId || null;
  let reach = null;
  if (mainRoot && adj.has(mainRoot)) reach = reachability(adj, mainRoot);

  // 库存
  const inv = (opts.inventory || []).map((it) => ({ ...it }));
  const consumed = new Set(inv.filter((i) => i.state === 'consumed').map((i) => i.token));

  const state = {
    nodes, connections, occupancy,
    inventory: inv,
    reachability: reach,
    steps: (model.steps || []).map((s) => ({ id: String(s.n), order: s.n, status: 'applied', adds: [] })),
  };
  const hash = stateHashOf({
    nodes: nodes.map((n) => ({ p: n.nodePath, part: n.partId, c: n.color, at: n.at, rot: n.rot, up: n.up, snot: n.snot })),
    connections: connections.map((c) => [c.aNodeId, c.aConnectorId, c.bNodeId, c.bConnectorId]),
    inventory: inv.map((i) => [i.token, i.state || 'available']),
  });
  return { state, stateHash: hash, stats: { nodes: nodes.length, connections: connections.length, components: comps.length } };
}

function connectedComponents(adj) {
  const seen = new Set(), comps = [];
  for (const id of adj.keys()) {
    if (seen.has(id)) continue;
    const comp = [], q = [id];
    seen.add(id);
    while (q.length) { const cur = q.pop(); comp.push(cur); for (const nb of adj.get(cur) || []) if (!seen.has(nb)) { seen.add(nb); q.push(nb); } }
    comps.push(comp);
  }
  return comps.sort((a, b) => b.length - a.length);
}

function reachability(adj, root) {
  const seen = new Set([root]), q = [root];
  while (q.length) { const cur = q.pop(); for (const nb of adj.get(cur) || []) if (!seen.has(nb)) { seen.add(nb); q.push(nb); } }
  const all = [...adj.keys()];
  return {
    mainRootNodeId: root,
    bodyPartsTotal: all.length,
    bodyPartsReachable: seen.size,
    bodyPartsUnreachable: all.filter((id) => !seen.has(id)),
    largestComponentRatio: all.length ? Math.round((seen.size / all.length) * 1e6) / 1e6 : 1,
  };
}

/**
 * 找到实际构成连接的全部连接器对（用于 occupancy 与 candidates）。
 * 规则必须与 core.partsConnected 一致；不一致时返回空数组让上层标 unsupported，不猜。
 * 注意这里返回**全部**匹配对：两块 2×4 叠起来是 8 对，不是 1 对。
 */
function findAllConnectorPairs(ca, cb, defA, defB) {
  const close = (p, q) => Math.abs(p[0] - q[0]) <= 0.08 && Math.abs(p[1] - q[1]) <= 0.20 && Math.abs(p[2] - q[2]) <= 0.08;
  const sameAxis = (s, r) => !s.axis || !r.axis || s.axis === r.axis;
  const tryPair = (s, r) => {
    // 球头↔球窝：三自由度关节，只判球心与窝心重合（与 core.connectorPairMatches 一致）
    if (s.kind === 'ball' && r.kind === 'socket') return close(s.pos, r.pos) ? 'ball-socket-v1' : null;
    // 把柄↔夹口：与 core.connectorPairMatches 共用同一实现（杆段跨度语义）
    if (s.kind === 'bar' && r.kind === 'clip') return barClipMatches(s, r) ? 'bar-clip-v1' : null;
    if (s.kind === 'pin' && r.kind === 'hole') return sameAxis(s, r) && close(s.pos, r.pos) ? 'pin-hole-v1' : null;
    if (s.kind === 'pin' && r.kind === 'axle') return sameAxis(s, r) && close(s.pos, r.pos) ? 'pin-axle-v1' : null;
    if (s.kind === 'minifig' && r.kind === 'minifig') return s.role === 'peg' && r.role === 'socket' && close(s.pos, r.pos) ? 'minifig-peg-socket-v1' : null;
    if (s.kind === 'top' && r.kind === 'minifig') return r.role === 'socket' && s.dir === r.dir && close(s.pos, r.pos) ? 'minifig-peg-socket-v1' : null;
    // 轮胎↔轮毂：判据与 core.partsConnected 共用同一实现（含轴向搭接），不再各写一套
    if (s.kind === 'rim' && r.kind === 'tyre') return rimTyreMatches(s, defB, r, defA) ? 'tyre-rim-v1' : null;
    if ((s.kind === 'top' || s.kind === 'side') && r.kind === 'antistud') {
      return s.dir === r.dir && close(s.pos, r.pos) ? 'stud-antistud-v1' : null;
    }
    return null;
  };
  const out = [];
  const seen = new Set();
  const push = (a, b, profile) => {
    const key = `${a}|${b}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ a, b, profile });
  };
  for (const s of ca.studs) for (const r of cb.receptors) {
    const prof = tryPair(s, r);
    if (prof) push(`c${s.kind}#${s.index}`, `c${r.kind}#${r.index}`, prof);
  }
  for (const s of cb.studs) for (const r of ca.receptors) {
    const prof = tryPair(s, r);
    if (prof) push(`c${r.kind}#${r.index}`, `c${s.kind}#${s.index}`, prof);
  }
  return out;
}

/** 兼容旧调用点：只取第一对 */
function findConnectorPair(ca, cb) {
  const all = findAllConnectorPairs(ca, cb);
  return all.length ? all[0] : null;
}

export { connectedComponents, reachability };
