// BrickBuild 0.3 关系装配：图校验 + 原子重算 + 编译为 0.2 兼容快照。
//
// 关键设计：本模块**不复制 core 的几何算法**。所有连接器位置、碰撞盒、扣合位姿一律调用
// core 的 partConnectors / partBoxes / partsCollide / snapPart。这里只做 0.3 特有的三件事：
//   ① 三种图分开校验（归属树 / 定位 DAG / 物理连接图）
//   ② 把 0.3 的稳定接口 ID + 实例路径编译成 core 能吃的 0.2 结构
//   ③ 把结果编译回 0.2 快照（现有 viewer/booklet/MPD 直接可读）
//
// 这样「资产定义」与「引擎实际扣合」用的是同一套数，不会出现两套真值。

import {
  partConnectors, snapPart, validate as coreValidate,
  FORMAT as LEGACY_FORMAT, VERSION as LEGACY_VERSION,
} from '../core.js';
import path from 'node:path';
import { checkAssetLock } from '../assets-v1/lock.js';

export const ASSEMBLY_FORMAT = 'brickbuild-assembly';
export const ASSEMBLY_VERSION = '0.3.0';
export const COMPILED_FORMAT = 'brickbuild';
export const COMPILED_VERSION = '0.2';

const r6 = (v) => Math.round(v * 1e6) / 1e6 || 0;
const LDU_PER_STUD = 20;
const LDU_PER_PLATE = 8;
const UPS = ['+y', '-y', '+z', '-z', '+x', '-x'];

const diag = (code, msg, extra = {}) => ({ code, severity: 'error', msg, ...extra });

// ---------------------------------------------------------------- ① 归属树

/**
 * 组件归属树校验：定义 id 唯一、嵌套引用存在、无递归包含、实例 id 不重复。
 * 归属树只表达「谁包含谁」，用于命名空间/复用/分包；它不产生定位边，也不产生连接边。
 */
export function checkContainment(source) {
  const problems = [];
  const defs = new Map();
  for (const d of source.definitions || []) {
    if (!d.id) { problems.push(diag('definition-no-id', '有定义缺少 id')); continue; }
    if (defs.has(d.id)) { problems.push(diag('definition-id-dup', `定义 id 重复：${d.id}`, { nodes: [d.id] })); continue; }
    defs.set(d.id, d);
  }
  if (!defs.has('main')) problems.push(diag('no-main-definition', '缺少 id="main" 的根定义'));

  for (const d of defs.values()) {
    const seen = new Set();
    for (const p of d.parts || []) {
      if (!p.instanceId) { problems.push(diag('part-no-id', `定义 ${d.id} 有零件实例缺 instanceId`, { nodes: [d.id] })); continue; }
      if (seen.has(p.instanceId)) problems.push(diag('part-id-dup', `定义 ${d.id} 内零件实例 id 重复：${p.instanceId}`, { nodes: [d.id, p.instanceId] }));
      seen.add(p.instanceId);
    }
    const seenC = new Set();
    for (const c of d.components || []) {
      if (!c.instancePath) { problems.push(diag('nested-no-path', `定义 ${d.id} 的嵌套组件缺 instancePath`, { nodes: [d.id] })); continue; }
      if (seenC.has(c.instancePath)) problems.push(diag('nested-path-dup', `定义 ${d.id} 内嵌套实例路径重复：${c.instancePath}`, { nodes: [d.id, c.instancePath] }));
      seenC.add(c.instancePath);
      if (!defs.has(c.componentId)) problems.push(diag('missing-component', `定义 ${d.id} 引用了不存在的组件 ${c.componentId}`, { nodes: [d.id] }));
    }
  }

  // 递归检测：沿嵌套链走，回到路径里已有的组件即递归
  for (const d of defs.values()) {
    const walk = (id, path) => {
      if (path.includes(id)) {
        problems.push(diag('recursive-template', `组件归属形成递归包含：${[...path, id].join(' → ')}`, { nodes: [...path, id] }));
        return true;
      }
      const cur = defs.get(id);
      if (!cur?.components?.length) return false;
      let hit = false;
      for (const c of cur.components) {
        if (defs.has(c.componentId) && walk(c.componentId, [...path, id])) hit = true;
      }
      return hit;
    };
    walk(d.id, []);
  }
  return { ok: problems.length === 0, problems, defs };
}

// ---------------------------------------------------------------- ② 定位 DAG

/**
 * 定位依赖 DAG：每个可定位节点恰好一条定位来源，无缺引用、无环。
 * 返回拓扑序；有环时列出环上节点（不静默保留旧坐标）。
 */
export function topoSortPlacements(source, nodePaths) {
  const problems = [];
  const byNode = new Map();
  for (const p of source.placements || []) {
    if (!p.nodeId) { problems.push(diag('placement-no-node', '定位记录缺少 nodeId')); continue; }
    if (byNode.has(p.nodeId)) {
      problems.push(diag('double-placement', `节点 ${p.nodeId} 有多条定位记录（${byNode.get(p.nodeId).kind} 与 ${p.kind}）；每个节点只能有一种权威定位方式`, { nodes: [p.nodeId] }));
      continue;
    }
    byNode.set(p.nodeId, p);
  }
  const known = new Set(nodePaths);
  for (const [nodeId, p] of byNode) {
    if (!known.has(nodeId)) problems.push(diag('placement-unknown-node', `定位记录指向不存在的节点 ${nodeId}`, { nodes: [nodeId] }));
    if (p.kind !== 'root') {
      if (!p.parentNodeId) { problems.push(diag('placement-no-parent', `节点 ${nodeId} 的 ${p.kind} 定位缺少 parentNodeId`, { nodes: [nodeId] })); continue; }
      if (!known.has(p.parentNodeId)) {
        problems.push(diag('missing-reference', `节点 ${nodeId} 的父节点 ${p.parentNodeId} 不存在`, { nodes: [nodeId, p.parentNodeId] }));
      }
    }
  }

  const referenced = new Set();
  for (const p of byNode.values()) if (p.parentNodeId) referenced.add(p.parentNodeId);
  for (const id of known) {
    if (!byNode.has(id) && !referenced.has(id)) {
      problems.push(diag('unplaced-node', `节点 ${id} 没有任何定位方式（既非根、也未被引用）`, { nodes: [id] }));
    }
  }

  const indeg = new Map([...known].map((id) => [id, 0]));
  const children = new Map();
  for (const [nodeId, p] of byNode) {
    if (p.kind === 'root' || !p.parentNodeId || !known.has(nodeId)) continue;
    children.set(p.parentNodeId, [...(children.get(p.parentNodeId) || []), nodeId]);
    indeg.set(nodeId, (indeg.get(nodeId) || 0) + 1);
  }
  const queue = [...known].filter((id) => (indeg.get(id) || 0) === 0).sort();
  const order = [];
  const depth = new Map(queue.map((id) => [id, 0]));
  while (queue.length) {
    const cur = queue.shift();
    order.push(cur);
    for (const ch of (children.get(cur) || []).sort()) {
      indeg.set(ch, indeg.get(ch) - 1);
      depth.set(ch, Math.max(depth.get(ch) ?? 0, (depth.get(cur) ?? 0) + 1));
      if (indeg.get(ch) === 0) queue.push(ch);
    }
  }
  if (order.length < known.size) {
    const stuck = [...known].filter((id) => !order.includes(id)).sort();
    problems.push(diag('placement-cycle', `定位依赖存在环，以下节点无法排序：${stuck.slice(0, 12).join(', ')}${stuck.length > 12 ? ' …' : ''}`, { nodes: stuck }));
  }
  return { ok: problems.length === 0, problems, order, depth };
}

// ---------------------------------------------------------------- 实例展开

/**
 * 把 definitions + instances 展开成可定位节点列表。
 * 节点路径 = `<instancePath>/<instanceId>`（嵌套组件再加一层），不依赖数组位置。
 */
export function expandNodes(source) {
  const problems = [];
  const defs = new Map((source.definitions || []).map((d) => [d.id, d]));
  if (!defs.has('main')) return { ok: false, problems: [diag('no-main-definition', '缺少 id="main" 定义')], nodes: [] };

  const nodes = [];
  const visit = (defId, prefix, stack) => {
    const def = defs.get(defId);
    if (!def) { problems.push(diag('missing-component', `组件 ${defId} 不存在（路径 ${prefix}）`)); return; }
    if (stack.includes(defId)) {
      problems.push(diag('recursive-instance', `组件 ${defId} 的实例展开形成递归：${[...stack, defId].join(' → ')}`));
      return;
    }
    for (const p of def.parts || []) {
      nodes.push({
        nodePath: `${prefix}/${p.instanceId}`,
        componentPath: prefix,
        componentId: defId,
        partId: p.partId,
        revision: p.revision,
        color: p.color,
        pose: p.pose,
        stepRef: p.stepRef,
        inventoryToken: p.inventoryToken,
        source: p,
      });
    }
    for (const c of def.components || []) {
      visit(c.componentId, `${prefix}/${c.instancePath}`, [...stack, defId]);
    }
  };

  const instances = source.instances?.length ? source.instances : [{ instancePath: 'main', componentId: 'main' }];
  const seenPaths = new Set();
  for (const inst of instances) {
    if (seenPaths.has(inst.instancePath)) { problems.push(diag('duplicate-instance-path', `实例路径重复：${inst.instancePath}`)); continue; }
    seenPaths.add(inst.instancePath);
    if (!defs.has(inst.componentId)) { problems.push(diag('missing-component', `实例 ${inst.instancePath} 引用不存在的组件 ${inst.componentId}`)); continue; }
    visit(inst.componentId, inst.instancePath, []);
  }
  const seen = new Set(), dups = new Set();
  for (const n of nodes) { if (seen.has(n.nodePath)) dups.add(n.nodePath); seen.add(n.nodePath); }
  if (dups.size) problems.push(diag('duplicate-node-path', `节点路径重复：${[...dups].slice(0, 5).join(', ')}；多实例必须用不同 instancePath`, { nodes: [...dups] }));

  return { ok: problems.length === 0, problems, nodes };
}

// ---------------------------------------------------------------- 位姿换算

/** 24 姿态 id → core 的 (up, rot) */
function poseOrientation(pose) {
  const oid = pose?.orientationId ?? 0;
  if (!Number.isInteger(oid) || oid < 0 || oid > 23) {
    return { up: null, rot: null };
  }
  return { up: UPS[Math.floor(oid / 4)], rot: (oid % 4) * 90 };
}

function poseToCore(pose) {
  const { up, rot } = poseOrientation(pose);
  if (up === null) return null;
  if (pose?.ldu) {
    return { at: [r6(pose.ldu[0] / LDU_PER_STUD), r6(pose.ldu[1] / LDU_PER_PLATE), r6(pose.ldu[2] / LDU_PER_STUD)], rot, up, snot: 0 };
  }
  if (pose?.grid) return { at: [...pose.grid], rot, up, snot: 0 };
  return { at: [0, 0, 0], rot, up, snot: 0 };
}

/** 稳定接口 ID → core 数组下标。
 *  接受两种写法：
 *    ① candidate 短名 `ctop#3` / `cantistud#0`（引擎自己产出，唯一无歧义）
 *    ② 契约稳定 ID（语义位置）→ 在 core 当前连接器里按位置回查
 *  找不到返回 null；不回退到 0 号（那是旧的静默行为）。
 */
function legacyIndexOf(connectorId, coreCollection) {
  if (!connectorId) return null;
  const short = connectorId.match(/^c(\w+)#(\d+)$/);
  if (short) {
    const idx = Number(short[2]);
    return idx < coreCollection.length ? idx : null;
  }
  // 契约 ID：stud-pz-10000-24000-n10000 → 解析出 LDU 位置后按位置匹配
  const parts = connectorId.split('-');
  const nums = parts.slice(parts.length - 3);
  if (nums.length !== 3) return null;
  const parseTick = (s) => (s.startsWith('n') ? -Number(s.slice(1)) : Number(s));
  const target = nums.map((s) => {
    const v = parseTick(s);
    return Number.isFinite(v) ? v / 1000 : null;
  });
  if (target.some((v) => v === null)) return null;
  const TOL = 0.05;
  const idx = coreCollection.findIndex((c) => Math.abs(c.pos[0] * LDU_PER_STUD - target[0]) <= TOL
    && Math.abs(c.pos[1] * LDU_PER_PLATE - target[1]) <= TOL
    && Math.abs(c.pos[2] * LDU_PER_STUD - target[2]) <= TOL);
  return idx >= 0 ? idx : null;
}

// ---------------------------------------------------------------- 编译

/**
 * 0.3 源 → core 0.2 兼容模型（内存对象）。
 * 位姿求解全部用 core.snapPart（引擎唯一几何真值），不自己算几何。
 * 失败时返回 { ok:false, problems }，不产出半成品快照。
 */
export function compileToLegacy(source, cat, opts = {}) {
  const problems = [];
  const containment = checkContainment(source);
  problems.push(...containment.problems);
  const expanded = expandNodes(source);
  problems.push(...expanded.problems);
  if (problems.length) return { ok: false, problems, snapshot: null, instanceMap: [], losses: [] };
  const nodes = expanded.nodes;
  const nodeByPath = new Map(nodes.map((n) => [n.nodePath, n]));

  const missingParts = [...new Set(nodes.map((n) => n.partId).filter((id) => !cat.parts[id]))];
  if (missingParts.length) {
    for (const id of missingParts) problems.push(diag('missing-asset', `目录中没有零件 ${id}`, { nodes: [id] }));
    return { ok: false, problems, snapshot: null, instanceMap: [], losses: [] };
  }

  const dag = topoSortPlacements(source, nodes.map((n) => n.nodePath));
  problems.push(...dag.problems);
  if (problems.length) return { ok: false, problems, snapshot: null, instanceMap: [], losses: [] };

  // 库存 token 守恒：未知 token、同一 token 被多个实例占用都必须拒绝编译
  const invTokens = new Map();
  for (const it of source.inventory || []) {
    if (!it.token) continue;
    if (invTokens.has(it.token)) problems.push(diag('inventory-token-dup', `库存 token 重复：${it.token}`));
    invTokens.set(it.token, it);
  }
  const tokenUse = new Map();
  for (const n of nodes) {
    if (!n.inventoryToken) continue;
    if (!invTokens.has(n.inventoryToken)) problems.push(diag('inventory-unknown-token', `节点 ${n.nodePath} 引用了不存在的库存 token ${n.inventoryToken}`, { nodes: [n.nodePath] }));
    tokenUse.set(n.inventoryToken, [...(tokenUse.get(n.inventoryToken) || []), n.nodePath]);
  }
  for (const [tok, paths] of tokenUse) {
    if (paths.length > 1) problems.push(diag('inventory-double-consume', `库存 token ${tok} 被 ${paths.length} 个零件实例占用：${paths.join(', ')}`, { nodes: paths }));
  }
  if (problems.length) return { ok: false, problems, snapshot: null, instanceMap: [], losses: [] };

  // 连接器能力检查：参与定位的节点必须有可归类连接器，否则明确报缺口（不当作可用）
  const placedNodes = new Set((source.placements || []).filter((p) => p.kind !== 'root').map((p) => p.nodeId));
  for (const n of nodes) {
    if (!placedNodes.has(n.nodePath)) continue;
    const probe = { id: n.nodePath, part: n.partId, color: n.color ?? 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0 };
    let conn = null;
    try { conn = partConnectors(probe, cat.parts[n.partId]); } catch { conn = null; }
    if (!conn) {
      problems.push(diag('untrusted-collision', `节点 ${n.nodePath}（零件 ${n.partId}）连接器生成失败`, { nodes: [n.nodePath] }));
      continue;
    }
    if (conn.studs.length === 0 && conn.receptors.length === 0) {
      problems.push(diag('unverified-interface', `节点 ${n.nodePath}（零件 ${n.partId}）没有任何可归类连接器，无法参与装配求解`, { nodes: [n.nodePath] }));
    }
  }
  if (problems.length) return { ok: false, problems, snapshot: null, instanceMap: [], losses: [] };

  const placementOf = new Map((source.placements || []).map((p) => [p.nodeId, p]));
  const solved = new Map();
  const coreParts = [];
  const instanceMap = [];
  const rigidGroups = new Map();   // assemblyInstancePath -> { anchorNodeId, target }

  for (const path of dag.order) {
    const node = nodeByPath.get(path);
    const placement = placementOf.get(path);
    const def = cat.parts[node.partId];
    let corePose = null;

    if (!placement || placement.kind === 'root') {
      const bf = placement?.baseFrame || {};
      const origin = bf.originLdu || opts.originLdu || [0, 0, 0];
      const local = poseToCore(node.pose);
      if (!local) { problems.push(diag('bad-orientation', `节点 ${path} 的 orientationId 不在 0..23`, { nodes: [path] })); break; }
      const oid = bf.orientationId ?? 0;
      if (!Number.isInteger(oid) || oid < 0 || oid > 23) { problems.push(diag('bad-orientation', `节点 ${path} 的 baseFrame.orientationId 不在 0..23`, { nodes: [path] })); break; }
      corePose = {
        at: [
          r6(origin[0] / LDU_PER_STUD + local.at[0]),
          r6(origin[1] / LDU_PER_PLATE + local.at[1]),
          r6(origin[2] / LDU_PER_STUD + local.at[2]),
        ],
        rot: local.rot, up: local.up, snot: local.snot ?? 0,
      };
    } else if (placement.kind === 'rigid') {
      // 刚性挂装：整组共享一次变换。
      // 锚点节点自己就是这个 rigid 记录（anchorNodeId === nodeId）时，它按普通 connector 语义
      // 扣到 parent 上；组内其余成员随后按「相对锚点的局部偏移」随锚点平移。
      if (placement.anchorNodeId === path) {
        const parentNode = nodeByPath.get(placement.parentNodeId);
        const parentSolved = solved.get(placement.parentNodeId);
        if (!parentNode || !parentSolved) {
          problems.push(diag('rigid-anchor-unsolved', `刚性组 ${placement.assemblyInstancePath} 的父节点 ${placement.parentNodeId} 尚未求解`, { nodes: [path, placement.parentNodeId] }));
          break;
        }
        const local = poseToCore(node.pose);
        if (!local) { problems.push(diag('bad-orientation', `节点 ${path} 的 orientationId 不在 0..23`, { nodes: [path] })); break; }
        const parentCore = {
          id: placement.parentNodeId, part: parentNode.partId, color: parentNode.color ?? 0,
          at: parentSolved.at, rot: parentSolved.rot, up: parentSolved.up, snot: parentSolved.snot ?? 0,
        };
        const childProbe = { id: path, part: node.partId, color: node.color ?? 0, ...local };
        const pConn = partConnectors(parentCore, cat.parts[parentNode.partId]);
        const cConn = partConnectors(childProbe, def);
        const studIdx = legacyIndexOf(placement.parentConnectorId, pConn.studs);
        const recIdx = legacyIndexOf(placement.anchorConnectorId, cConn.receptors);
        if (studIdx === null || recIdx === null) {
          problems.push(diag('unknown-connector', `刚性组 ${placement.assemblyInstancePath} 的锚点接口无法解析（父 ${placement.parentConnectorId} / 子 ${placement.anchorConnectorId}）`, { nodes: [path] }));
          break;
        }
        try {
          const snapped = snapPart(parentCore, cat.parts[parentNode.partId], studIdx, childProbe, def, recIdx, { under: Boolean(placement.under) });
          corePose = { at: snapped.at, rot: snapped.rot, up: snapped.up, snot: snapped.snot ?? 0 };
          rigidGroups.set(placement.assemblyInstancePath, { anchorNodeId: path, target: corePose, anchorLocal: local });
        } catch (e) {
          problems.push(diag('connector-mismatch', `刚性组锚点 ${path} 无法扣合到 ${placement.parentNodeId}：${e.message}`, { nodes: [path, placement.parentNodeId] }));
          break;
        }
      } else {
        const g = rigidGroups.get(placement.assemblyInstancePath);
        if (!g) {
          problems.push(diag('rigid-anchor-unsolved', `刚性组 ${placement.assemblyInstancePath} 的锚点 ${placement.anchorNodeId} 尚未求解（锚点必须先于组员）`, { nodes: [placement.anchorNodeId] }));
          break;
        }
        const mine = poseToCore(node.pose);
        if (!mine) { problems.push(diag('bad-orientation', `刚性组 ${placement.assemblyInstancePath} 内节点 ${path} 的 orientationId 非法`, { nodes: [path] })); break; }
        corePose = {
          at: [
            r6(g.target.at[0] + (mine.at[0] - g.anchorLocal.at[0])),
            r6(g.target.at[1] + (mine.at[1] - g.anchorLocal.at[1])),
            r6(g.target.at[2] + (mine.at[2] - g.anchorLocal.at[2])),
          ],
          rot: mine.rot, up: mine.up, snot: mine.snot ?? 0,
        };
      }
    } else {
      const parentNode = nodeByPath.get(placement.parentNodeId);
      const parentSolved = solved.get(placement.parentNodeId);
      if (!parentNode || !parentSolved) {
        problems.push(diag('missing-reference', `节点 ${path} 的父节点 ${placement.parentNodeId} 未求解`, { nodes: [path, placement.parentNodeId] }));
        break;
      }
      const parentCore = {
        id: placement.parentNodeId, part: parentNode.partId, color: parentNode.color ?? 0,
        at: parentSolved.at, rot: parentSolved.rot, up: parentSolved.up, snot: parentSolved.snot ?? 0,
      };
      const local = poseToCore(node.pose);
      if (!local) { problems.push(diag('bad-orientation', `节点 ${path} 的 orientationId 不在 0..23`, { nodes: [path] })); break; }
      const childProbe = { id: path, part: node.partId, color: node.color ?? 0, ...local };
      const pConn = partConnectors(parentCore, cat.parts[parentNode.partId]);
      const cConn = partConnectors(childProbe, def);
      const studIdx = legacyIndexOf(placement.parentConnectorId, pConn.studs);
      const recIdx = legacyIndexOf(placement.childConnectorId, cConn.receptors);
      if (studIdx === null) {
        problems.push(diag('unknown-connector', `父节点 ${placement.parentNodeId} 上不存在接口 ${placement.parentConnectorId}`, { nodes: [placement.parentNodeId] }));
        break;
      }
      if (recIdx === null) {
        problems.push(diag('unknown-connector', `节点 ${path} 上不存在接口 ${placement.childConnectorId}`, { nodes: [path] }));
        break;
      }
      try {
        const snapped = snapPart(parentCore, cat.parts[parentNode.partId], studIdx, childProbe, def, recIdx, { under: Boolean(placement.under) });
        corePose = { at: snapped.at, rot: snapped.rot, up: snapped.up, snot: snapped.snot ?? 0 };
      } catch (e) {
        problems.push(diag('connector-mismatch', `节点 ${path} 无法扣合到 ${placement.parentNodeId}：${e.message}`, { nodes: [path, placement.parentNodeId] }));
        break;
      }
    }

    solved.set(path, corePose);
    coreParts.push({ id: path, part: node.partId, color: node.color ?? 0, step: stepOf(node, source), ...corePose });
    instanceMap.push({ legacyPartId: path, nodePath: path, partId: node.partId, revision: node.revision });
  }

  if (problems.length) return { ok: false, problems, snapshot: null, instanceMap: [], losses: [] };

  const snapshot = {
    format: LEGACY_FORMAT,
    version: LEGACY_VERSION,
    meta: {
      name: source.meta?.name || '未命名装配',
      ...(source.meta?.setId ? { setId: source.meta.setId } : {}),
      ...(source.meta?.front ? { front: source.meta.front } : {}),
      ...(source.meta?.flip ? { flip: true } : {}),
      compiledFrom: ASSEMBLY_FORMAT,
      compiledVersion: ASSEMBLY_VERSION,
      engineRevision: opts.engineRevision || 'assembly-v1@1.0.0',
    },
    parts: coreParts,
  };

  const losses = [];
  if ((source.steps || []).length) {
    snapshot.steps = source.steps.slice().sort((a, b) => a.order - b.order).map((s) => {
      const entry = { n: s.order };
      entry.title = s.sourceStepRef?.stepNo ? `原书第 ${s.sourceStepRef.stepNo} 步`
        : s.action?.op === 'final-assembly' ? '总装' : `第 ${s.order} 步`;
      const notes = [];
      if (s.action?.op === 'flip' || s.flip) notes.push('本步翻面');
      if ((s.adds || []).length === 0) notes.push('本步无新增件');
      if (s.repeatOf) notes.push(`重复 ${s.repeatOf}`);
      if (notes.length) entry.note = notes.join('；');
      return entry;
    });
    const declared = new Set(snapshot.steps.map((s) => s.n));
    const used = new Set(coreParts.map((p) => p.step).filter((n) => !declared.has(n)));
    if (used.size) {
      losses.push({ field: 'steps', reason: `有 ${used.size} 个步骤号在 0.2 快照里出现但 0.3 steps 未声明：${[...used].join(', ')}` });
    }
  } else {
    losses.push({ field: 'steps', reason: '0.3 源未声明 steps；0.2 快照按零件 step 号自动成步' });
  }

  const componentPaths = [...new Set(nodes.map((n) => n.componentPath))].filter((p) => p && p !== 'main');
  if (componentPaths.length) {
    snapshot.modules = componentPaths.map((p) => ({ id: p, label: p }));
    for (const p of coreParts) {
      const node = nodeByPath.get(p.id);
      if (node?.componentPath && node.componentPath !== 'main') p.module = node.componentPath;
    }
    losses.push({ field: 'definitions', reason: '0.2 只有扁平 modules；组件模板/实例层级、mirror、instanceOverrides 无法在快照中表达，需从 0.3 源读取' });
  }
  if ((source.constraints || []).length) {
    losses.push({ field: 'constraints', reason: `0.2 无额外约束字段，${source.constraints.length} 条约束未进入快照（快照只保留几何结果）` });
  }
  if ((source.inventory || []).length) {
    losses.push({ field: 'inventory', reason: '0.2 无库存 token 概念；token ↔ 零件实例的对应关系保留在 instanceMap 与 0.3 源中' });
  }
  losses.push({ field: 'evidence', reason: '0.2 只保留零件级 evidence；步骤级与接口级证据留在 0.3 源' });

  return { ok: true, problems: [], snapshot, instanceMap, losses, order: dag.order };
}

function stepOf(node, source) {
  const byRef = (source.steps || []).find((x) => x.id === node.stepRef);
  if (byRef) return byRef.order;
  const containing = (source.steps || []).find((x) => (x.adds || []).includes(node.nodePath));
  return containing?.order ?? 1;
}

// ---------------------------------------------------------------- SNOT 链实测

/**
 * 从编译后的 0.2 快照实测 SNOT 层号链（AS-06）。
 *
 * 判定：把每颗 snot≠0 的件沿它的 up 轴往回找「同一条链上的上一件」（按真实扣合关系），
 * 上一件的 snot 必须等于当前 snot − 1。找不到上一件、或跳号，都算链断裂。
 * 链根（snot=0 但 up≠'+y'，即直接扣在侧凸点砖上）必须是 side 凸点连接。
 *
 * 返回 { ok, note, chains }。没有任何 snot≠0 件时 ok=false 且说明「本快照无 SNOT 链可测」，
 * 不算通过——「没测到」不等于「测过了且正确」。
 */
export function measureSnotChains(snapshot, cat) {
  const parts = snapshot.parts || [];
  const byId = new Map(parts.map((p) => [p.id, p]));
  const snotParts = parts.filter((p) => (p.snot ?? 0) !== 0);
  const sideParts = parts.filter((p) => p.up && p.up !== '+y');
  if (!snotParts.length) {
    return {
      ok: false, chains: [],
      note: sideParts.length
        ? `快照有 ${sideParts.length} 个 SNOT 朝向件但 snot 全为 0（位置全由 at 表达），没有分层链可测`
        : '快照中没有 SNOT 朝向件，AS-06 无对象可测',
    };
  }

  // 扣合邻接（只用于沿链回溯，口径与 core 的连接图一致：位置重合的凸点/底孔）
  const connOf = new Map();
  for (const p of parts) {
    const def = cat.parts[p.part];
    if (!def) continue;
    try { connOf.set(p.id, partConnectors(p, def)); } catch { /* 无连接器 */ }
  }
  const close = (a, b) => Math.abs(a[0] - b[0]) <= 0.08 && Math.abs(a[1] - b[1]) <= 0.20 && Math.abs(a[2] - b[2]) <= 0.08;
  const parentOf = (p) => {
    const pc = connOf.get(p.id);
    if (!pc) return null;
    const out = new Set();
    for (const other of parts) {
      if (other.id === p.id) continue;
      const oc = connOf.get(other.id);
      if (!oc) continue;
      for (const s of oc.studs) for (const r of pc.receptors) if (close(s.pos, r.pos)) out.add(other.id);
      for (const s of pc.studs) for (const r of oc.receptors) if (close(s.pos, r.pos)) out.add(other.id);
    }
    return out;
  };

  const chains = [];
  const problems = [];
  for (const p of snotParts) {
    const want = p.snot - 1;
    const cands = parentOf(p);
    const parents = [...(cands || [])].map((id) => byId.get(id)).filter(Boolean);
    const match = parents.find((q) => (q.snot ?? 0) === want);
    if (!match) {
      problems.push(`${p.id}（snot=${p.snot}, up=${p.up}）找不到 snot=${want} 的上一件；实际候选 ${parents.map((q) => `${q.id}(snot=${q.snot ?? 0})`).join(', ') || '无'}`);
      continue;
    }
    chains.push({ node: p.id, snot: p.snot, parent: match.id, parentSnot: match.snot ?? 0 });
  }

  const ok = problems.length === 0 && chains.length === snotParts.length;
  return {
    ok,
    chains,
    problems,
    note: ok
      ? `${snotParts.length} 个分层件的 snot 链全部逐层 −1 连通`
      : `${problems.length} 个分层件的 snot 链断裂：${problems.slice(0, 3).join('; ')}`,
  };
}

// ---------------------------------------------------------------- 校验入口

/**
 * validateAssembly：0.3 三种图 + 库存守恒 + 编译后 core 校验。
 * 几何部分编译后交给 core.validate（同一套真值），本模块不重算几何。
 */
export function validateAssembly(source, cat, opts = {}) {
  const errors = [], warnings = [], notices = [];
  const addErr = (code, msg, extra) => errors.push({ code, severity: 'error', msg, ...extra });
  const addWarn = (code, msg, extra) => warnings.push({ code, severity: 'warning', msg, ...extra });
  let assetLockResult = null;

  if (source.format !== ASSEMBLY_FORMAT) addErr('format', `format 应为 "${ASSEMBLY_FORMAT}"，收到 ${source.format ?? '(缺失)'}`);
  if (source.version !== ASSEMBLY_VERSION) {
    const major = String(source.version || '').split('.')[0];
    if (major !== '0') addErr('schema-version', `assembly 主版本 ${major} 未知，拒绝执行`);
    else addWarn('version', `assembly 版本 ${source.version} 与当前 ${ASSEMBLY_VERSION} 不同`);
  }

  // —— 资产锁（ST-01）：缺锁/空串哈希/内容不符一律拒绝，不再降级为 warning ——
  // 用件集合由装配图展开得到，确保「任务实际依赖的每个件号」都在锁里。
  const usedPartIds = [...new Set(expandNodes(source).nodes.map((n) => n.partId))];
  const lockRes = checkAssetLock(source, {
    index: opts.assetIndex ?? null,
    assetsDir: opts.assetsDir ?? (opts.assetIndex ? undefined : path.join(process.cwd(), 'catalog/assets-v1')),
    requiredPartIds: usedPartIds,
    requireIndex: opts.requireAssetIndex !== false,
  });
  for (const e of lockRes.errors) errors.push(e);
  for (const w of lockRes.warnings) warnings.push(w);
  for (const n of lockRes.notices) notices.push(n);
  assetLockResult = lockRes;

  const containment = checkContainment(source);
  for (const p of containment.problems) errors.push({ ...p, severity: 'error' });
  const expanded = expandNodes(source);
  for (const p of expanded.problems) errors.push({ ...p, severity: 'error' });
  const dag = topoSortPlacements(source, expanded.nodes.map((n) => n.nodePath));
  for (const p of dag.problems) errors.push({ ...p, severity: 'error' });

  let compiled = null;
  if (!errors.length) {
    compiled = compileToLegacy(source, cat, opts);
    for (const p of compiled.problems) errors.push({ ...p, severity: 'error' });
    if (compiled.ok) {
      const v = coreValidate(compiled.snapshot, cat, { strictAssembly: opts.strictAssembly, photos: opts.photos });
      for (const e of v.errors) errors.push({ code: `core-${e.code}`, severity: 'error', msg: e.msg, nodes: e.parts });
      for (const w of v.warnings) warnings.push({ code: `core-${w.code}`, severity: 'warning', msg: w.msg, nodes: w.parts });
      for (const i of v.info || []) notices.push({ ...i, severity: 'notice' });
    }
  }

  if (Array.isArray(source.inventory) && source.inventory.length) {
    const tokens = new Map();
    for (const it of source.inventory) {
      if (!it.token) { addErr('inventory-no-token', '库存项缺少 token'); continue; }
      if (tokens.has(it.token)) addErr('inventory-token-dup', `库存 token 重复：${it.token}`);
      tokens.set(it.token, it);
    }
    const usedTokens = new Set(expanded.nodes.map((n) => n.inventoryToken).filter(Boolean));
    for (const t of usedTokens) if (!tokens.has(t)) addErr('inventory-unknown-token', `零件实例引用了不存在的库存 token ${t}`);
    const unconsumed = [...tokens.values()].filter((t) => !usedTokens.has(t.token));
    if (unconsumed.length) addWarn('inventory-unconsumed', `${unconsumed.length} 个库存 token 未被任何零件实例占用：${unconsumed.slice(0, 8).map((t) => t.token).join(', ')}`);
    const usedTwice = [...usedTokens].filter((t) => expanded.nodes.filter((n) => n.inventoryToken === t).length > 1);
    if (usedTwice.length) addErr('inventory-double-consume', `库存 token 被多个零件实例占用：${usedTwice.slice(0, 8).join(', ')}`);
  }

  // AS-06：SNOT 层号不是「有 snot 字段就算过」。这里从编译后的快照实测：
  //   ① 每一层侧装件都真实扣合（core.partsConnected 已在 coreValidate 里查过）
  //   ② 同一条侧装链上 snot 从 0 起逐层 +1，不跳号、不重复
  // 只有编译成功且实测通过才记 verified；否则如实标 unverified/not-started。
  let snotChainVerified = false;
  let snotChainNote = compiled?.ok ? '本轮未在编译结果中发现可测的 SNOT 链' : '编译未通过，SNOT 链无从测量';
  if (compiled?.ok) {
    const chain = measureSnotChains(compiled.snapshot, cat);
    snotChainVerified = chain.ok;
    snotChainNote = chain.note;
  }

  // ST-01 的状态按事实给：只有每条锁记录都带真实内容哈希且与索引逐条相符，才配叫 verified。
  // 索引不可用或未带哈希时只能是 partial/unknown，不能因为「有 lockHash 字段」就算通过。
  // 顺序很重要：有 error 就是 failed；只有「无错但索引缺失（requireIndex:false 降级）」才是 unknown。
  const lockStatus = !assetLockResult ? 'failed'
    : assetLockResult.errors.length ? 'failed'
      : !assetLockResult.indexAvailable ? 'unknown'
        : assetLockResult.verifiedCount === assetLockResult.partCount ? 'verified'
          : 'partial';
  const lockNote = !assetLockResult ? 'assetLock 缺失或格式非法'
    : assetLockResult.errors.length ? `资产锁核验失败：${assetLockResult.errors.map((e) => e.code).join(', ')}`
      : !assetLockResult.indexAvailable ? '资产索引不可用，未做内容级核验'
        : `${assetLockResult.verifiedCount}/${assetLockResult.partCount} 条锁记录带真实内容哈希并与索引相符`;

  const tests = [
    { id: 'ST-01', status: lockStatus, note: lockNote, evidence: assetLockResult ? { lockHash: assetLockResult.lockHash, profileId: assetLockResult.profileId } : null },
    { id: 'AS-04', status: dag.ok && containment.ok ? 'verified' : 'failed', evidence: dag.ok && containment.ok ? [] : ['placement-cycle / missing-reference / recursive-template'], note: '非法图报错并拒绝编译（原子，无半成品快照）' },
    { id: 'AS-06', status: snotChainVerified ? 'verified' : (compiled?.ok ? 'unverified' : 'not-started'), note: snotChainNote },
    { id: 'EN-01', status: compiled?.ok ? 'unverified' : 'not-started', note: '真实连接由编译后 core 的 partsConnected 判定' },
  ];

  return {
    ok: errors.length === 0,
    errors, warnings, notices,
    tests,
    assetLock: assetLockResult ? {
      ok: assetLockResult.ok, lockHash: assetLockResult.lockHash, profileId: assetLockResult.profileId,
      indexAvailable: assetLockResult.indexAvailable, verifiedCount: assetLockResult.verifiedCount, partCount: assetLockResult.partCount,
      resolved: assetLockResult.resolved,
    } : null,
    stats: {
      definitions: (source.definitions || []).length,
      nodes: expanded.nodes.length,
      placements: (source.placements || []).length,
      constraints: (source.constraints || []).length,
      steps: (source.steps || []).length,
      inventory: (source.inventory || []).length,
      compiledParts: compiled?.snapshot?.parts?.length ?? 0,
    },
    compiled: compiled?.ok ? { losses: compiled.losses, instanceMap: compiled.instanceMap } : null,
  };
}
