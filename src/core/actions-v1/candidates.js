// 候选枚举（enumerateCandidates）：引擎只回答「几何合法」，不替 B 或主会话判断「符合说明书意图」。
//
// 硬要求（PRD §7.3）：
//   - 每个候选检查与全部相关零件的碰撞，**包括父件**（EN-02）
//   - 区分 enumerationComplete / truncated；达到 maxResults 不得声称无其他候选
//   - 无解必须给出可区分原因，不得把零件摆在地面充数
//   - 候选带 candidateHash，动作请求回传以校验未过期
//   - 对称/多挂点等价动作保留 equivalenceGroup

import crypto from 'node:crypto';
import {
  partConnectors, partBoxes, partsCollide, transformAssembly3D, partCenter,
} from '../core.js';
import { getOrientation, orientationIdOf, mateOrientation, applyOrientation } from './pose.js';
import { gridToLdu, LDU_PER_STUD, LDU_PER_PLATE } from '../assets-v1/ids.js';

const stableStringify = (v) => {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
};
const hashOf = (obj) => crypto.createHash('sha256').update(stableStringify(obj), 'utf8').digest('hex');

const r6 = (v) => Math.round(v * 1e6) / 1e6 || 0;

/**
 * 枚举「把 partInstance 扣到 state 中某个接口」的全部几何合法候选。
 *
 * @param {object} state inspectFromModel 产出的 state
 * @param {object} request {
 *   childPartId, childModel?: {parts, anchor}  // 子组件挂装时给整组
 *   parentNodeId?, parentConnectorIds?, region?: {envelopeLdu}, orientationIds?,
 *   maxResults?, requireParentRegion?, inventoryTokens?
 * }
 * @param {object} cat { parts }
 * @param {object} [opts] { profileId, taskId }
 */
export function enumerateCandidates(state, request, cat, opts = {}) {
  const maxResults = request.maxResults ?? 50;
  const diagnostics = [];
  const capabilityGaps = [];

  const childPartId = request.childPartId;
  const isAssembly = Boolean(request.childModel);
  const childDef = isAssembly ? null : cat.parts[childPartId];
  if (!isAssembly && !childDef) {
    return {
      ok: false, items: [], count: 0, enumerationComplete: true, truncated: false,
      noSolutionReason: 'missing-asset',
      noSolutionDetail: `目录中没有零件 ${childPartId}`,
      capabilityGaps: [{ kind: 'missing-asset', partId: childPartId, detail: `目录中没有零件 ${childPartId}`, blocksTask: true }],
      diagnostics,
    };
  }
  if (isAssembly) {
    const missing = (request.childModel.parts || []).map((p) => p.part).filter((id) => !cat.parts[id]);
    if (missing.length) {
      return {
        ok: false, items: [], count: 0, enumerationComplete: true, truncated: false,
        noSolutionReason: 'missing-asset', noSolutionDetail: `子组件含目录外零件：${[...new Set(missing)].join(', ')}`,
        capabilityGaps: [...new Set(missing)].map((id) => ({ kind: 'missing-asset', partId: id, detail: '子组件零件不在目录', blocksTask: true })),
        diagnostics,
      };
    }
  }

  const parents = request.parentNodeId
    ? state.nodes.filter((n) => n.nodePath === request.parentNodeId)
    : state.nodes;
  if (request.parentNodeId && !parents.length) {
    return {
      ok: false, items: [], count: 0, enumerationComplete: true, truncated: false,
      noSolutionReason: 'missing-asset', noSolutionDetail: `状态中没有父节点 ${request.parentNodeId}`,
      capabilityGaps: [], diagnostics: [{ code: 'unknown-parent', severity: 'error', msg: `状态中没有父节点 ${request.parentNodeId}`, nodes: [request.parentNodeId] }],
    };
  }

  // 父件已占用接口集合（occupancy 由引擎算，不由模型声称）
  const occupied = new Map();
  for (const o of state.occupancy || []) {
    const k = `${o.nodeId}|${o.connectorId}`;
    occupied.set(k, o.occupiedBy);
  }

  const items = [];
  let sawUnsupportedConnector = false;
  const unsupportedTypes = new Set();

  for (const parentNode of parents) {
    const pDef = cat.parts[parentNode.partId];
    if (!pDef) continue;
    let pConn;
    try { pConn = partConnectors(parentNode, pDef); } catch { continue; }

    // 父件接口枚举：studs 是被扣的一方（子件底孔扣上去）；这里只考虑父件公头接口
    const studEntries = pConn.studs;
    for (const stud of studEntries) {
      if (request.parentConnectorIds && !request.parentConnectorIds.includes(studLabelId(stud))) continue;
      if (request.dir && stud.dir !== request.dir) continue;

      if (isAssembly) {
        // 子组件：遍历组内每个零件的每个底孔作为锚点接口
        for (const member of request.childModel.parts) {
          const cDef = cat.parts[member.part];
          let cConn;
          try { cConn = partConnectors(member, cDef); } catch { continue; }
          for (const rec of cConn.receptors) {
            for (const spin of [0, 90, 180, 270]) {
              const cand = buildAssemblyCandidate({
                state, parentNode, pDef, stud, members: request.childModel.parts, anchorId: member.id,
                anchorReceptor: rec.index, spin, cat, opts,
              });
              if (cand.kind === 'unsupported') { sawUnsupportedConnector = true; unsupportedTypes.add(cand.type); continue; }
              if (cand.kind !== 'ok') continue;
              items.push(cand.candidate);
              if (items.length >= maxResults) break;
            }
            if (items.length >= maxResults) break;
          }
          if (items.length >= maxResults) break;
        }
      } else {
        const cConn = safeConnectors(childPartId, childDef);
        if (!cConn) {
          capabilityGaps.push({ kind: 'untrusted-collision', partId: childPartId, detail: '子件连接器生成失败，无法判定扣合', blocksTask: true });
          continue;
        }
        for (const rec of cConn.receptors) {
          for (const spin of [0, 90, 180, 270]) {
            const cand = buildPartCandidate({
              state, parentNode, pDef, stud, childPartId, childDef, childConn: cConn,
              receptor: rec, spin, cat, opts, occupied,
            });
            if (cand.kind === 'unsupported') { sawUnsupportedConnector = true; unsupportedTypes.add(cand.type); continue; }
            if (cand.kind !== 'ok') continue;
            items.push(cand.candidate);
            if (items.length >= maxResults) break;
          }
          if (items.length >= maxResults) break;
        }
      }
      if (items.length >= maxResults) break;
    }
    if (items.length >= maxResults) break;
  }

  const truncated = items.length >= maxResults;
  let noSolutionReason = 'none';
  let noSolutionDetail = '';
  if (!items.length) {
    if (sawUnsupportedConnector) {
      noSolutionReason = 'unsupported-connector';
      noSolutionDetail = `存在无法归类的连接类型：${[...unsupportedTypes].join(', ')}`;
      capabilityGaps.push({ kind: 'unsupported-connector', detail: noSolutionDetail, blocksTask: true });
    } else {
      noSolutionReason = 'collision';
      noSolutionDetail = '所有接口对的候选都被碰撞或接口占用排除';
    }
  }

  return {
    ok: items.length > 0,
    items,
    count: items.length,
    // 未截断才有资格说「穷尽」
    enumerationComplete: !truncated,
    truncated,
    maxResults,
    noSolutionReason,
    noSolutionDetail,
    capabilityGaps,
    diagnostics,
    request: {
      childPartId: childPartId ?? null,
      isAssembly,
      parentNodeId: request.parentNodeId ?? null,
      parentConnectorIds: request.parentConnectorIds ?? null,
      orientationIds: request.orientationIds ?? null,
      maxResults,
    },
  };
}

function safeConnectors(partId, def) {
  try { return partConnectors({ id: '_p', part: partId, color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0 }, def); }
  catch { return null; }
}

function studLabelId(stud) {
  return `c${stud.kind}#${stud.index}`;
}

/** 单件候选：用 core.snapPart 的等价算术求位姿，再对全部相关零件（含父件）查碰撞 */
function buildPartCandidate({ state, parentNode, pDef, stud, childPartId, childDef, childConn, receptor, spin, cat, opts, occupied }) {
  // 先校验连接类型可匹配
  const typeOk = matchesStudAntistud(stud, receptor);
  if (!typeOk) return { kind: 'unsupported', type: `${stud.kind}/${receptor.kind}` };

  const parentConnId = studLabelId(stud);
  if (occupied.has(`${parentNode.nodePath}|${parentConnId}`)) return { kind: 'occupied' };

  // 位姿：父件接口姿态 ∘ 自旋 ∘ 子件接口逆姿态
  const parentOrient = orientationIdOf(stud.dir || '+y', 0);
  const childOrient = orientationIdOf(receptor.dir || '+y', 0);
  if (parentOrient === null || childOrient === null) return { kind: 'unsupported', type: 'orientation-not-in-table' };

  const probe = { id: '_probe', part: childPartId, color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0 };
  const probeConn = partConnectors(probe, childDef);
  const probeRec = probeConn.receptors[receptor.index];
  if (!probeRec) return { kind: 'unsupported', type: 'receptor-missing' };

  const oid = mateOrientation(parentOrient, childOrient, spin);
  if (oid === null) return { kind: 'unsupported', type: 'no-orthogonal-mate' };
  const orient = getOrientation(oid);

  // 子件姿态确定后，把「零件原点」放到正确位置。
  //
  // 坐标系铁律（这里踩过坑，改动前先读完）：
  //   1. core.partConnectors 返回的 pos 已经是**世界坐标**（内部经 localToWorld 换算）。
  //      再叠加 parentNode.at 等于把父件平移算两遍 —— 父件不在原点时位姿必然错。
  //   2. core.partCenter 返回的是**混合单位** [x格, y片, z格]。
  //      拿它做刚体旋转前必须整体换算到 LDU，否则正交矩阵会把「格」分量搬进「片」槽。
  // 因此：先在 LDU 里算 (中心 - 受体) 的相对向量，旋转，再加到凸点世界位置，最后换算回格/片。
  const childCenter = partCenter(probe, childDef);
  const recLdu = gridToLdu(probeRec.pos);
  const cntLdu = gridToLdu(childCenter);
  const relLdu = [r6(cntLdu[0] - recLdu[0]), r6(cntLdu[1] - recLdu[1]), r6(cntLdu[2] - recLdu[2])];
  const rotRelLdu = applyOrientation(oid, relLdu);
  const studLdu = gridToLdu(stud.pos);
  const childCenterLdu = [
    r6(studLdu[0] + rotRelLdu[0]),
    r6(studLdu[1] + rotRelLdu[1]),
    r6(studLdu[2] + rotRelLdu[2]),
  ];
  const centerAfterRotLdu = gridToLdu(partCenter({ at: [0, 0, 0], rot: orient.rot, up: orient.up, snot: 0 }, childDef));
  const delta = [
    r6((childCenterLdu[0] - centerAfterRotLdu[0]) / LDU_PER_STUD),
    r6((childCenterLdu[1] - centerAfterRotLdu[1]) / LDU_PER_PLATE),
    r6((childCenterLdu[2] - centerAfterRotLdu[2]) / LDU_PER_STUD),
  ];

  // at 已表达完整世界位置 → snot 必须为 0。
  // snot 是「沿 up 的附加片偏移」，与 at 是**叠加**关系（partCenter: up='+z' 时 z = at[2] + snot*PLATE）。
  // 两者同时非零会把零件再往外推 snot 片，连接器随之错位（见 out/prd-v2/.../A/snot/snot-candidate-probe.json）。
  const placed = {
    id: `pending-${childPartId}`,
    part: childPartId,
    color: 0,
    at: delta,
    rot: orient.rot,
    up: orient.up,
    snot: 0,
  };

  // 此时 placed 的 at 是「绝对位置」（snot=0 口径），碰撞检查就按绝对位置做。
  const boxes = safeBoxes(placed, childDef);
  if (!boxes) return { kind: 'unsupported', type: 'collision-box-failed' };
  let collidedWith = null;
  for (const other of state.nodes) {
    const oDef = cat.parts[other.partId];
    if (!oDef) continue;
    const oBoxes = safeBoxes(other, oDef);
    if (!oBoxes) continue;
    if (partsCollide(placed, childDef, boxes, other, oDef, oBoxes)) { collidedWith = other.nodePath; break; }
  }
  if (collidedWith) return { kind: 'collision', with: collidedWith };

  // SNOT 层号（真实模型口径：mecha p82=0 / p15=1 / p16=2，at 为共同基准）。
  // 候选要同时给出「基准 at」与「层号 snot」，apply 重建时按 at + snot 得绝对位置。
  const snot = computeSnotLevel(placed, childDef, parentNode, pDef, stud, cat);
  const baseAt = unapplySnot(delta, orient.up || '+y', snot, childDef);

  const candidate = {
    candidateId: `cand-${hashOf({ p: parentNode.nodePath, pc: parentConnId, c: childPartId, r: receptor.index, o: oid, t: baseAt, s: snot }).slice(0, 12)}`,
    candidateHash: '',
    equivalenceGroup: equivalenceGroupOf(state, parentNode, stud, childPartId, cat),
    parentNodeId: parentNode.nodePath,
    parentPartId: parentNode.partId,
    parentConnectorId: parentConnId,
    parentConnectorType: stud.kind,
    childNodeId: placed.id,
    childPartId,
    childConnectorId: `c${receptor.kind}#${receptor.index}`,
    childConnectorType: receptor.kind,
    mateProfile: 'stud-antistud-v1',
    orientationId: oid,
    spinDeg: spin,
    // translationLdu 是基准 at（apply 会再叠加 snot 得到绝对位置）
    translationLdu: [
      r6(baseAt[0] * LDU_PER_STUD), r6(baseAt[1] * LDU_PER_PLATE), r6(baseAt[2] * LDU_PER_STUD),
    ],
    absoluteCenterLdu: gridToLdu(partCenter(placed, childDef)),
    snot,
    inventoryToken: null,
    collisionChecked: {
      againstNodeIds: state.nodes.map((n) => n.nodePath),
      includesParent: true,
    },
    features: {
      studDir: stud.dir,
      studKind: stud.kind,
      studLayer: stud.pos[1],
      parentStepOrder: parentNode.stepOrder ?? null,
      isSnot: stud.kind === 'side',
      childIsSnotPart: (childDef.kind === 'snot' || childDef.kind === 'bracket'),
    },
    evidenceRefs: [],
    mock: false,
  };
  candidate.candidateHash = hashOf({ ...candidate, candidateHash: '' });
  return { kind: 'ok', candidate };
}

function buildAssemblyCandidate({ state, parentNode, pDef, stud, members, anchorId, anchorReceptor, spin, cat }) {
  const pConn = partConnectors(parentNode, pDef);
  const anchorMember = members.find((m) => m.id === anchorId);
  if (!anchorMember) return { kind: 'no-anchor' };
  const anchorDef = cat.parts[anchorMember.part];
  if (!anchorDef) return { kind: 'unsupported', type: 'anchor-missing' };
  const aConn = safeConnectors(anchorMember.part, anchorDef);
  if (!aConn || !aConn.receptors[anchorReceptor]) return { kind: 'unsupported', type: 'anchor-receptor-missing' };

  const placed = transformAssembly3D(
    members.map((m) => ({ p: m, def: cat.parts[m.part] })),
    parentNode, pDef, stud.index, anchorId, anchorReceptor, spin,
  );
  if (!placed) return { kind: 'transform-failed' };

  // 碰撞：组内每件 vs 组外全部节点（含父件）
  const memberIds = new Set(members.map((m) => m.id));
  for (const cand of placed) {
    const cDef = cat.parts[cand.part];
    const boxes = safeBoxes(cand, cDef);
    if (!boxes) return { kind: 'unsupported', type: 'collision-box-failed' };
    for (const other of state.nodes) {
      if (memberIds.has(other.nodePath)) continue;
      const oDef = cat.parts[other.partId];
      if (!oDef) continue;
      const oBoxes = safeBoxes(other, oDef);
      if (!oBoxes) continue;
      if (partsCollide(cand, cDef, boxes, other, oDef, oBoxes)) return { kind: 'collision', with: other.nodePath };
    }
  }

  const anchorPlaced = placed.find((p) => p.id === anchorId);
  const parentConnId = studLabelId(stud);
  const oid = orientationIdOf(anchorPlaced.up || '+y', anchorPlaced.rot || 0);
  const candidate = {
    candidateId: `cand-asm-${hashOf({ p: parentNode.nodePath, pc: parentConnId, a: anchorId, ar: anchorReceptor, o: oid }).slice(0, 12)}`,
    candidateHash: '',
    equivalenceGroup: null,
    parentNodeId: parentNode.nodePath,
    parentPartId: parentNode.partId,
    parentConnectorId: parentConnId,
    parentConnectorType: stud.kind,
    childNodeId: anchorId,
    childPartId: anchorMember.part,
    childConnectorId: `c${aConn.receptors[anchorReceptor].kind}#${anchorReceptor}`,
    childConnectorType: aConn.receptors[anchorReceptor].kind,
    mateProfile: 'stud-antistud-v1',
    orientationId: oid,
    spinDeg: spin,
    translationLdu: [r6(anchorPlaced.at[0] * 20), r6(anchorPlaced.at[1] * 8), r6(anchorPlaced.at[2] * 20)],
    snot: 0,
    inventoryToken: null,
    collisionChecked: { againstNodeIds: state.nodes.map((n) => n.nodePath), includesParent: true },
    features: { isAssembly: true, memberCount: members.length, studDir: stud.dir, studKind: stud.kind },
    evidenceRefs: [],
    mock: false,
    _placed: placed,
  };
  candidate.candidateHash = hashOf({ ...candidate, candidateHash: '', _placed: undefined });
  return { kind: 'ok', candidate };
}

/**
 * 把「绝对位置 at」折算回「基准 at」：沿 up 方向回退 snot 片。
 * 与 core.partCenter 的叠加口径严格互逆，保证 apply 的 at + snot 能还原绝对位置。
 */
function unapplySnot(absAt, up, snot, def) {
  if (!snot) return absAt;
  const back = snot * 0.4;                    // 1 片 = 0.4 格
  const out = [absAt[0], absAt[1], absAt[2]];
  if (up === '+z') out[2] = r6(absAt[2] - back);
  else if (up === '-z') out[2] = r6(absAt[2] + back);
  else if (up === '+x') out[0] = r6(absAt[0] - back);
  else if (up === '-x') out[0] = r6(absAt[0] + back);
  else if (up === '+y') out[1] = r6(absAt[1] - snot);
  else if (up === '-y') out[1] = r6(absAt[1] + snot);
  void def;
  return out;
}

function safeBoxes(p, def) {
  try { return partBoxes(p, def); } catch { return null; }
}

function matchesStudAntistud(s, r) {
  if (s.kind === 'top' && r.kind === 'antistud') return true;
  if (s.kind === 'side' && r.kind === 'antistud') return true;
  return false;
}

/**
 * SNOT 层级编码（AS-06 / PRD §6.5）—— 按几何实测，不按「看起来像」赋值。
 *
 * 判据：子件贴向父件的那一面，相对父件侧面的外移距离（单位：片）。
 *   直接扣在侧凸点砖侧面上的第一层 → 距离 0 → snot = 0
 *   叠在第一层侧装板上 → 再外移 1 片 → snot = 1，逐层递增
 * 与 catalog 里 mecha 的写法一致（p82 snot=0 / p15 snot=1 / p16 snot=2，at 基准不变）。
 *
 * 注意 snot 与 at 是**叠加**关系而非二选一：
 *   partCenter(up='+z') = at[2] + snot*PLATE
 * 因此候选必须输出「基准 at + 层号 snot」，由调用方相加得到绝对位置；
 * 若两边都写绝对值，位置会被多推 snot 片（见 A/snot/snot-candidate-probe.json）。
 */
function computeSnotLevel(placed, childDef, parentNode, pDef, stud, cat) {
  if (stud.kind !== 'side') return 0;
  const axis = stud.dir === '+z' || stud.dir === '-z' ? 2 : stud.dir === '+x' || stud.dir === '-x' ? 0 : 1;
  const sign = stud.dir.startsWith('-') ? -1 : 1;
  const span = (boxes, idx) => [Math.min(...boxes.map((b) => (idx === 0 ? b.x0 : idx === 1 ? b.y0 : b.z0))),
    Math.max(...boxes.map((b) => (idx === 0 ? b.x1 : idx === 1 ? b.y1 : b.z1)))];
  let cBoxes, pBoxes;
  try {
    cBoxes = partBoxes(placed, childDef);
    pBoxes = partBoxes(parentNode, pDef);
  } catch { return 0; }
  if (!cBoxes.length || !pBoxes.length) return 0;
  // 子件朝父件的那一面 vs 父件朝外的那一面
  const cFace = sign > 0 ? span(cBoxes, axis)[0] : span(cBoxes, axis)[1];
  const pFace = sign > 0 ? span(pBoxes, axis)[1] : span(pBoxes, axis)[0];
  const gapStud = (cFace - pFace) * sign;          // 外移距离，格单位
  const gapPlate = gapStud * (5 / 2);              // 1 格 = 2.5 片
  return Math.max(0, Math.round(gapPlate));
}

function equivalenceGroupOf(state, parentNode, stud, childPartId, cat) {
  // 同一父件、同一朝向、同一 stud 层高的同类接口 → 旋转等价（只在几何对称时成立，这里保守只按层高分组）
  return `${parentNode.nodePath}|${stud.kind}|${stud.dir}|${r6(stud.pos[1])}`;
}
