/**
 * tools/brickvlm/gen_trajectory_dataset.mjs
 *
 * BrickVLM C1-1 + C1-2：select_action 轨迹数据工厂（S_t → a → S_t+1）。
 *
 * 方法（沿用 R-02 关闭时的口径并加强）：
 *   1. 装配源：已验证模型（mecha / lantern / cottage / 0.3 夹具）+ 程序化模型族（builder 搭建）。
 *      每个实例终态与全部前缀状态都必须 validate 0 errors / 0 warnings 才产出样本。
 *   2. 轨迹回放：按物理连接拓扑序逐件推进；每一步从 state_t 出发，
 *      用引擎 enumerateCandidates（父件范围）重枚举候选，逐候选真实 applyActions 执行，
 *      以「执行后 stateHash == builder 下一状态哈希」判定目标与等价组（真实重放判定，
 *      覆盖 parts/colors/poses/connections，绝不只比锚点包围盒）。
 *   3. 匿名化：公开候选集合用随机 cand_xxxx ID、随机顺序、无 isTarget 字段；
 *      真实引擎 ID 只出现在 ground-truth 标签区（verification.labels.actionRequest/actionResponse）。
 *   4. 渲染（纯 CPU，SVG→sharp 光栅化，相机契约对齐 A 的 renderState CAMERA_CONTRACT）：
 *      目标图（无标号）、当前图（中立 Set-of-Mark 接口标号，全部接口同款式）、
 *      无标号评分图；每图绑定 stateHash + 相机参数并记录 sha256。
 *   5. 出厂门禁：抽样 ≥100 条样本从 state_t 经真实 applyActions 重放，
 *      动作响应与 stateHash 必须 100% 一致，否则退出码 2。
 *
 * 用法：
 *   node tools/brickvlm/gen_trajectory_dataset.mjs --out <dir> [--workers 5] [--only fam-a,fam-b] [--width 512]
 *   node tools/brickvlm/gen_trajectory_dataset.mjs --out <dir> --list-families
 *   node tools/brickvlm/gen_trajectory_dataset.mjs --out <dir> --verify 150   （只跑重放核验）
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import sharp from 'sharp';

import { createBuilder } from '../../src/core/builder.js';
import {
  partBoxes, partsConnected, partConnectors, validate, PLATE,
} from '../../src/core/core.js';
import { inspectFromModel } from '../../src/core/actions-v1/state.js';
import { enumerateCandidates } from '../../src/core/actions-v1/candidates.js';
import { applyActions } from '../../src/core/actions-v1/apply.js';
import { orientationIdOf } from '../../src/core/actions-v1/orientations.js';
import { buildAssetLock } from '../../src/core/assets-v1/lock.js';
import { renderState } from '../../src/core/actions-v1/render-state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

// ---------------------------------------------------------------- 基础工具

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const r4 = (v) => Math.round(v * 1e4) / 1e4;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seedOf(str) {
  const h = crypto.createHash('sha256').update(String(str), 'utf8').digest();
  return h.readUInt32LE(0);
}
function seededShuffle(arr, rand) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];

// ---------------------------------------------------------------- 目录与资产锁

const CATALOG_PARTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'), 'utf8'));
const CATALOG_COLORS = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/colors.json'), 'utf8')).colors;
const CAT = { ...CATALOG_PARTS, colors: CATALOG_COLORS };
const ASSETS_DIR = path.join(ROOT, 'catalog/assets-v1');
const ASSET_INDEX = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, 'index.json'), 'utf8'));
const CATALOG_INDEX_SHA = sha256(fs.readFileSync(path.join(ASSETS_DIR, 'index.json')));

const COLOR_HEX = {};
for (const [id, c] of Object.entries(CATALOG_COLORS)) COLOR_HEX[id] = c.hex || '#969696';

// ---------------------------------------------------------------- 拓扑序（物理连接贪心）

function connectsTo(cat, a, b) {
  try { return partsConnected(a, cat.parts[a.part], b, cat.parts[b.part]); } catch { return false; }
}

/**
 * 物理连接贪心拓扑序：每件只在它与已放零件存在真实物理连接（或 mount 父件已放）时放置。
 * 根件取整坐标、无 mount 的最低层零件（并列取 x/z 最小，保证确定性）。
 * 不要求整数 at：SNOT 侧装件（分数 at）通过 3D 连接器匹配正常入序。
 */
function topoOrder(parts, cat) {
  const norm = (p) => ({
    id: p.id, part: p.part, color: p.color, at: [...p.at],
    rot: p.rot ?? 0, up: p.up ?? '+y', snot: p.snot ?? 0,
    ...(p.mount ? { mount: p.mount } : {}),
  });
  const all = parts.map(norm);
  const intAt = (p) => [0, 1, 2].every((j) => Number.isInteger(p.at[j]));
  const gMin = Math.min(...all.map((p) => p.at[1]));
  // 地面件（最低层、整坐标、无 mount）随时可放：validate 以最低层为支撑基准面，
  // 允许多个互不接触的地面岛（如桥墩），它们由后上层结构连成整体。
  const isGround = (p) => !p.mount && intAt(p) && p.at[1] === gMin;
  const remaining = [...all];
  const order = [];
  const placedIds = new Set();
  while (remaining.length) {
    let idx = -1;
    if (!order.length) {
      let best = -1;
      for (let i = 0; i < remaining.length; i++) {
        const p = remaining[i];
        if (!isGround(p)) continue;
        if (best === -1
          || p.at[0] < remaining[best].at[0]
          || (p.at[0] === remaining[best].at[0] && p.at[2] < remaining[best].at[2])) best = i;
      }
      idx = best;
    } else {
      idx = remaining.findIndex((p) =>
        isGround(p)
        || (!p.mount && order.some((o) => connectsTo(cat, o, p)))
        || (p.mount && placedIds.has(p.mount)));
    }
    if (idx === -1) {
      throw new Error(`拓扑序卡死：剩余 ${remaining.slice(0, 6).map((p) => p.id).join(',')} 无法连接到已放零件`);
    }
    const [p] = remaining.splice(idx, 1);
    order.push(p);
    placedIds.add(p.id);
  }
  return order;
}

// ---------------------------------------------------------------- 状态构建（0.2 扁平模型）

function flatModel(orderedParts, count, metaName) {
  const n = Math.max(1, Math.min(count, orderedParts.length));
  return {
    format: 'brickbuild',
    version: '0.2',
    meta: { name: metaName || 'trajectory-state' },
    parts: orderedParts.slice(0, n).map((p, i) => ({
      id: p.id, part: p.part, color: p.color, at: [...p.at],
      rot: p.rot, up: p.up, snot: p.snot,
      ...(p.mount ? { mount: p.mount } : {}),
      step: i + 1,
    })),
  };
}

function makeInventoryTokens(instanceId, orderedParts, placedCount) {
  return orderedParts.map((p, i) => ({
    token: `tok-${instanceId}-${String(i).padStart(3, '0')}`,
    partId: p.part,
    colorId: p.color,
    color: p.color,
    state: i < placedCount ? 'consumed' : 'available',
    ...(i < placedCount ? { consumedBy: p.id, consumedAt: 'transaction' } : {}),
  }));
}

function validateClean(model) {
  const v = validate(model, CAT);
  return { ok: v.ok && v.errors.length === 0 && v.warnings.length === 0, errors: v.errors, warnings: v.warnings };
}

// ---------------------------------------------------------------- 引擎目标发现（真实重放判定）

const MAX_APPLIES_PER_STEP = 240;

/**
 * 在 state_t 上为「装入 part p」枚举候选并逐个真实执行：
 *   - 目标组 = 执行后 stateHash == targetNextHash 的候选（真实重放等价，含连接图）；
 *   - 干扰池 = 执行成功但 stateHash 不同的合法候选（valid-but-wrong）。
 */
function geomSignature(model) {
  const boxes = [];
  for (const part of model.parts) {
    const def = CAT.parts[part.part];
    let bs;
    try { bs = partBoxes(part, def); } catch { bs = []; }
    boxes.push(`${part.part}/${part.color}:${JSON.stringify(bs)}`);
  }
  const si = inspectFromModel(model, CAT);
  const conns = si.state.connections.map((c) => JSON.stringify([c.aNodeId, c.aConnectorId, c.bNodeId, c.bConnectorId])).sort();
  return { boxes: boxes.sort().join('|'), conns: conns.join('|') };
}

/**
 * 在 state_t 上为「装入 part p」枚举候选并逐个真实执行（R-02 口径）：
 *   - 目标组 = 执行后 stateHash 相同，或全模型几何等价（零件/颜色/包围盒/连接全同）的候选；
 *   - 干扰池 = 执行成功但与目标既不同哈希也不同几何的合法候选（valid-but-wrong）。
 * 姿态先验过滤只用于加速第一轮；任何被判为干扰的候选都经过真实执行 + 几何比对，绝不只比锚点 AABB。
 */
function discoverCandidates({ modelT, hashT, inventoryT, part, targetNextHash, targetNextModel, taskId, cache = new Map() }) {
  const si = inspectFromModel(modelT, CAT, { inventory: inventoryT });
  const targetSig = geomSignature(targetNextModel);
  const pFull = { id: part.id, part: part.part, color: part.color, at: part.at, rot: part.rot, up: part.up, snot: part.snot };
  const scopes = [];
  for (const node of si.state.nodes) {
    const np = modelT.parts.find((x) => x.id === node.nodePath);
    if (np && connectsTo(CAT, np, pFull)) scopes.push(node.nodePath);
  }
  const mkCtx = () => ({
    model: JSON.parse(JSON.stringify(modelT)), cat: CAT, stateHash: hashT,
    inventory: JSON.parse(JSON.stringify(inventoryT)), taskId,
    enumerate: (req) => {
      const key = `${req.childPartId}|${req.parentNodeId ?? ''}|${req.maxResults ?? ''}`;
      if (!cache.has(key)) cache.set(key, enumerateCandidates(si.state, req, CAT, {}));
      return cache.get(key);
    },
  });
  const runOne = (candidate, scope) => {
    const ctx = mkCtx();
    const request = {
      protocolVersion: '1.0.0', taskId, stateHash: hashT,
      actions: [{
        id: 'probe', op: 'attach_part',
        target: { partInstanceId: part.id },
        partId: part.part, color: part.color,
        candidateId: candidate.candidateId, candidateHash: candidate.candidateHash,
        candidateParentNodeId: scope,
        step: 1,
      }],
    };
    const response = applyActions(ctx, request, {});
    return { candidate, scope, response };
  };
  const classify = (run) => {
    if (!run.response.passed || run.response.apply?.stateHashAfter === undefined) return 'rejected';
    if (run.response.apply.stateHashAfter === targetNextHash) return 'target';
    const executed = run.response._workingModel;
    if (!executed) return 'distractor';
    const sig = geomSignature(executed);
    return sig.boxes === targetSig.boxes && sig.conns === targetSig.conns ? 'target' : 'distractor';
  };

  const allCandidates = [];   // {candidate, scope} 全量（含未执行）
  for (const scope of scopes) {
    const en = enumerateCandidates(si.state, { childPartId: part.part, parentNodeId: scope, maxResults: 5000 }, CAT, {});
    for (const candidate of en.items) allCandidates.push({ candidate, scope });
  }
  const wantOrient = orientationIdOf(part.up, part.rot);
  const targetGroup = [];
  const distractorPool = [];
  const tested = new Set();
  let applied = 0;
  const runBatch = (entries) => {
    for (const { candidate, scope } of entries) {
      if (tested.has(candidate.candidateId)) continue;
      tested.add(candidate.candidateId);
      if (applied >= MAX_APPLIES_PER_STEP) return;
      const run = runOne(candidate, scope);
      applied += 1;
      const verdict = classify(run);
      if (verdict === 'target') targetGroup.push(run);
      else if (verdict === 'distractor') distractorPool.push(run);
    }
  };
  // 第一轮：姿态一致候选（最快路径；哈希等价必在此组）
  runBatch(allCandidates.filter((e) => e.candidate.orientationId === wantOrient));
  // 第二轮：仅当第一轮无目标时全量兜底
  if (!targetGroup.length) runBatch(allCandidates);
  // 第三轮：干扰池补采样（随机抽未测候选执行，凑足 2-4 个合法但装错的干扰）
  const needDistractors = 4;
  if (distractorPool.length < needDistractors && targetGroup.length) {
    const untested = allCandidates.filter((e) => !tested.has(e.candidate.candidateId));
    const rnd = mulberry32(seedOf(`pool:${taskId}`));
    runBatch(seededShuffle(untested, rnd).slice(0, 14));
  }
  return { si, targetGroup, distractorPool, enumerated: allCandidates.length, applied, scopes };
}

// ---------------------------------------------------------------- 程序化模型族

// size = def.size = [w, l]（rot 0 时 w 沿 x、l 沿 z；rot 90/270 交换）
const dimsXZ = (part, rot) => {
  const [w, l] = CAT.parts[part].size;
  return rot === 90 || rot === 270 ? [l, w] : [w, l];
};

function familyRegistry() {
  const PALETTES = {
    castle: { primary: 71, secondary: 72, accent: 0, trim: 15 },
    ocean: { primary: 1, secondary: 15, accent: 71, trim: 0 },
    lava: { primary: 4, secondary: 0, accent: 14, trim: 15 },
    forest: { primary: 2, secondary: 15, accent: 70, trim: 71 },
    desert: { primary: 14, secondary: 71, accent: 70, trim: 0 },
    mono: { primary: 0, secondary: 71, accent: 15, trim: 72 },
    candy: { primary: 4, secondary: 15, accent: 1, trim: 14 },
    slate: { primary: 72, secondary: 0, accent: 71, trim: 15 },
  };
  const paletteList = Object.keys(PALETTES);

  const defs = [
    {
      familyId: 'fam-tower',
      title: '方形瞭望塔（互锁砖层 + 顶板 + 雉堞 + 旗杆）',
      views: [{ az: 30, el: 14 }, { az: 65, el: 20 }, { az: -25, el: 10 }],
      instances: 18,
      build(b, rnd, pal) {
        const floors = 2 + Math.floor(rnd() * 3); // 2..4 层
        const step0 = b.add('3020', pal.trim, { at: [0, 0, 0], step: 1 });
        b.add('3020', pal.trim, { at: [0, 0, 2], step: 1 });
        let y = 1;
        for (let f = 0; f < floors; f++) {
          const ca = f % 2 === 0 ? pal.primary : pal.secondary;
          const cb = f % 2 === 0 ? pal.secondary : pal.primary;
          if (f % 2 === 0) {
            b.add('3001', ca, { at: [0, y, 0], step: y + 1 });
            b.add('3001', cb, { at: [0, y, 2], step: y + 1 });
          } else {
            b.add('3001', ca, { at: [0, y, 0], rot: 90, step: y + 1 });
            b.add('3001', cb, { at: [2, y, 0], rot: 90, step: y + 1 });
          }
          y += 3;
        }
        // 顶层窗拱洞（留空一格）+ 顶板
        b.add('3020', pal.trim, { at: [0, y, 0], step: y + 1 });
        b.add('3020', pal.trim, { at: [0, y, 2], step: y + 1 });
        const capY = y + 1;
        for (const [cx, cz] of [[0, 0], [3, 0], [0, 3], [3, 3]]) {
          b.add('3005', pal.accent, { at: [cx, capY, cz], step: capY + 1 });
        }
        b.add('3062b', pal.primary, { at: [1, capY, 1], step: capY + 1 });
        b.add('4073', pal.secondary, { at: [1, capY + 3, 1], step: capY + 2 });
        return { rootId: step0.id };
      },
    },
    {
      familyId: 'fam-bridge',
      title: '四墩板梁桥（墩柱 + 双向桥面 + 路面砖 + 护柱）',
      views: [{ az: 20, el: 12 }, { az: 70, el: 24 }, { az: 160, el: 10 }],
      instances: 14,
      build(b, rnd, pal) {
        const pierH = 2 + Math.floor(rnd() * 2); // 2..3 层墩
        const step0 = b.add('3003', pal.primary, { at: [0, 0, 0], step: 1 });
        for (const [px, pz] of [[2, 0], [0, 6], [2, 6]]) {
          b.add('3003', pal.secondary, { at: [px, 0, pz], step: 1 });
        }
        for (let y = 3; y < pierH * 3; y += 3) {
          for (const [px, pz] of [[0, 0], [2, 0], [0, 6], [2, 6]]) {
            b.add('3003', (y / 3) % 2 === 0 ? pal.primary : pal.secondary, { at: [px, y, pz], step: y + 1 });
          }
        }
        const deckY = pierH * 3;
        for (const [dx, dz] of [[0, 0], [0, 4], [2, 0], [2, 4]]) {
          b.add('3020', dx === 0 ? pal.trim : pal.accent, { at: [dx, deckY, dz], rot: 90, step: deckY + 1 });
        }
        // 路面砖（铺在桥面上）
        b.add('3023', pal.secondary, { at: [0, deckY + 1, 1], step: deckY + 2 });
        b.add('3023', pal.secondary, { at: [2, deckY + 1, 1], step: deckY + 2 });
        b.add('3023', pal.secondary, { at: [0, deckY + 1, 5], step: deckY + 2 });
        b.add('3023', pal.secondary, { at: [2, deckY + 1, 5], step: deckY + 2 });
        // 护柱（全部落在桥面单元格上）
        for (const [px, pz] of [[0, 0], [3, 3], [0, 6], [3, 7]]) {
          b.add('3005', pal.accent, { at: [px, deckY + 1, pz], step: deckY + 3 });
        }
        return { rootId: step0.id };
      },
    },
    {
      familyId: 'fam-table',
      title: '四腿工作台（桌腿 + 桌面 + 桌面物件）',
      views: [{ az: 35, el: 18 }, { az: 125, el: 16 }, { az: -60, el: 22 }],
      instances: 12,
      build(b, rnd, pal) {
        const step0 = b.add('3004', pal.primary, { at: [0, 0, 0], rot: 90, step: 1 });
        for (const [lx, lz] of [[0, 5], [3, 0], [3, 5]]) {
          b.add('3004', pal.primary, { at: [lx, 0, lz], rot: 90, step: 1 });
        }
        for (const [lx, lz] of [[0, 0], [0, 5], [3, 0], [3, 5]]) {
          b.add('3004', pal.secondary, { at: [lx, 3, lz], rot: 90, step: 2 });
        }
        const topY = 6;
        for (const [tx, tz] of [[0, 0], [0, 4], [2, 0], [2, 4]]) {
          b.add('3020', (tx + tz) % 4 === 0 ? pal.trim : pal.accent, { at: [tx, topY, tz], rot: 90, step: 3 });
        }
        // 桌面物件
        b.add('2431', pal.secondary, { at: [0, topY + 1, 0], step: 4 });
        b.add('3003', pal.accent, { at: [1, topY + 1, 2], step: 4 });
        b.add('3062b', pal.primary, { at: [2, topY + 1, 5], step: 4 });
        b.add('4073', pal.trim, { at: [2, topY + 4, 5], step: 5 });
        b.add('3024', pal.trim, { at: [0, topY + 1, 5], step: 5 });
        return { rootId: step0.id };
      },
    },
    {
      familyId: 'fam-cargoer',
      title: '平板货车（底盘 + 驾驶室 + 货舱围板 + 货物）',
      views: [{ az: 40, el: 12 }, { az: 140, el: 14 }, { az: -35, el: 18 }],
      instances: 12,
      build(b, rnd, pal) {
        const step0 = b.add('3795', pal.secondary, { at: [0, 0, 0], rot: 90, step: 1 }); // x0..1 z0..5
        b.add('3795', pal.secondary, { at: [2, 0, 0], rot: 90, step: 1 });               // x2..3 z0..5
        // 驾驶室（前端 z0..1）
        b.add('3003', pal.accent, { at: [0, 1, 0], step: 2 });
        b.add('3003', pal.accent, { at: [2, 1, 0], step: 2 });
        b.add('3004', pal.primary, { at: [0, 4, 0], step: 3 });
        b.add('3004', pal.primary, { at: [2, 4, 0], step: 3 });
        b.add('3020', pal.trim, { at: [0, 7, 0], step: 4 });
        // 货舱围板（后段两侧）
        b.add('3004', pal.primary, { at: [0, 1, 2], rot: 90, step: 5 });
        b.add('3004', pal.primary, { at: [0, 1, 4], rot: 90, step: 5 });
        b.add('3004', pal.primary, { at: [3, 1, 2], rot: 90, step: 5 });
        b.add('3004', pal.primary, { at: [3, 1, 4], rot: 90, step: 5 });
        // 货物
        b.add('3068b', pal.trim, { at: [1, 1, 2], step: 6 });
        b.add('3023', pal.secondary, { at: [1, 1, 4], step: 6 });
        b.add('3005', pal.accent, { at: [1, 2, 4], step: 7 });
        return { rootId: step0.id };
      },
    },
    {
      familyId: 'fam-snotwall',
      title: 'SNOT 侧装墙（侧凸点砖 + 侧面贴板分层）',
      views: [{ az: 15, el: 10 }, { az: 55, el: 16 }, { az: 200, el: 12 }],
      instances: 12,
      build(b, rnd, pal) {
        const step0 = b.add('3795', pal.secondary, { at: [0, 0, 0], step: 1 }); // x0..5 z0..1
        // 墙体第一排：砖 + 侧凸点砖混排
        b.add('3004', pal.primary, { at: [0, 1, 0], step: 2 });
        const snot1 = b.add('87087', pal.accent, { at: [2, 1, 0], step: 2 });   // 侧凸点: 1=+z
        b.add('3004', pal.primary, { at: [3, 1, 0], step: 2 });
        const snot2 = b.add('4733', pal.trim, { at: [5, 1, 0], step: 2 });      // 侧凸点: 1=+z, 2=-z
        // 墙体第二排
        b.add('3004', pal.secondary, { at: [0, 4, 0], step: 3 });
        const snot3 = b.add('11211', pal.accent, { at: [2, 4, 0], step: 3 });   // 侧凸点: 2/3=+z
        b.add('3004', pal.secondary, { at: [4, 4, 0], step: 3 });
        // 第一层侧装板（snot=0，直接扣侧凸点）
        const plateA = b.add('3024', pal.trim, { on: snot1.id, stud: 1, up: '+z', step: 4 });
        const plateB = b.add('3024', pal.primary, { on: snot2.id, stud: 2, up: '-z', step: 4 });
        b.add('2412b', pal.accent, { on: snot3.id, stud: 2, up: '+z', step: 5 });
        b.add('3024', pal.secondary, { on: snot2.id, stud: 1, up: '+z', step: 5 });
        // 第二层：叠在第一层侧装板的凸点上（再外移 1 片）
        b.add('3023', pal.secondary, { on: plateA.id, stud: 0, up: '+z', step: 6 });
        b.add('3023', pal.accent, { on: plateB.id, stud: 0, up: '-z', step: 6 });
        return { rootId: step0.id };
      },
    },
    {
      familyId: 'fam-house',
      title: '小屋（四面墙 + 门洞 + 平屋顶 + 烟囱）',
      views: [{ az: 35, el: 16 }, { az: 145, el: 14 }, { az: -55, el: 20 }],
      instances: 18,
      build(b, rnd, pal) {
        const step0 = b.add('3795', pal.trim, { at: [0, 0, 0], step: 1 });
        for (const z of [2, 4, 6]) b.add('3795', pal.trim, { at: [0, 0, z], step: 1 });
        const wY = 1;
        // 前墙（z0，门洞在 x5）
        b.add('3010', pal.primary, { at: [0, wY, 0], step: 2 });
        b.add('3004', pal.primary, { at: [4, wY, 0], rot: 90, step: 2 });
        // 后墙（z7）
        b.add('3010', pal.secondary, { at: [0, wY, 7], step: 2 });
        b.add('3004', pal.secondary, { at: [4, wY, 6], rot: 90, step: 2 });
        // 左右墙
        b.add('3001', pal.primary, { at: [0, wY, 2], rot: 90, step: 2 });
        b.add('3001', pal.secondary, { at: [4, wY, 2], rot: 270, step: 2 });
        // 二层
        b.add('3010', pal.primary, { at: [0, wY + 3, 0], step: 3 });
        b.add('3004', pal.primary, { at: [4, wY + 3, 0], rot: 90, step: 3 });
        b.add('3010', pal.secondary, { at: [0, wY + 3, 7], step: 3 });
        b.add('3004', pal.secondary, { at: [4, wY + 3, 6], rot: 90, step: 3 });
        b.add('3001', pal.accent, { at: [0, wY + 3, 2], rot: 90, step: 3 });
        b.add('3001', pal.accent, { at: [4, wY + 3, 2], rot: 270, step: 3 });
        // 三层（窗洞层：只留前后墙 + 右侧半墙）
        b.add('3010', pal.primary, { at: [0, wY + 6, 0], step: 4 });
        b.add('3010', pal.secondary, { at: [0, wY + 6, 7], step: 4 });
        b.add('3001', pal.accent, { at: [0, wY + 6, 2], rot: 90, step: 4 });
        b.add('3001', pal.primary, { at: [4, wY + 6, 2], rot: 270, step: 4 });
        // 屋顶
        const rY = wY + 9;
        for (const z of [0, 2, 4, 6]) b.add('3020', pal.trim, { at: [0, rY, z], step: rY + 1 });
        b.add('3020', pal.accent, { at: [4, rY, 0], rot: 90, step: rY + 1 });
        b.add('3020', pal.accent, { at: [4, rY, 4], rot: 90, step: rY + 1 });
        // 屋面砖 + 烟囱
        for (const z of [0, 2, 4, 6]) b.add('2431', pal.secondary, { at: [0, rY + 1, z], step: rY + 2 });
        b.add('3005', pal.primary, { at: [4, rY + 1, 3], step: rY + 3 });
        b.add('3062b', pal.accent, { at: [4, rY + 4, 3], step: rY + 4 });
        return { rootId: step0.id };
      },
    },
    {
      familyId: 'fam-arch',
      title: '拱门（双柱 + 横梁 + 拱心石 + 顶饰）',
      views: [{ az: 25, el: 10 }, { az: 90, el: 18 }, { az: 205, el: 12 }],
      instances: 12,
      build(b, rnd, pal) {
        const step0 = b.add('3005', pal.primary, { at: [0, 0, 0], step: 1 });
        b.add('3005', pal.secondary, { at: [0, 0, 4], step: 1 }); // 第二根柱的基块
        const h = 2 + Math.floor(rnd() * 2); // 柱高层块数
        for (let i = 1; i < h; i++) {
          b.add('3005', i % 2 === 0 ? pal.primary : pal.secondary, { at: [0, i * 3, 0], step: i + 1 });
          b.add('3005', i % 2 === 0 ? pal.secondary : pal.primary, { at: [0, i * 3, 4], step: i + 1 });
        }
        const beamY = h * 3;
        // 横梁：跨 z0..3 的 3010（rot90，1x4 砖 h=3）+ z4 顶上的 3024 补板
        b.add('3010', pal.trim, { at: [0, beamY, 0], rot: 90, step: h + 1 });
        b.add('3024', pal.trim, { at: [0, beamY, 4], step: h + 1 });
        const beamTop = beamY + 3;
        // 拱心石与侧饰（都坐在梁顶层上）
        b.add('3003', pal.accent, { at: [0, beamTop, 2], step: h + 2 });
        b.add('3024', pal.secondary, { at: [0, beamTop, 0], step: h + 2 });
        b.add('3024', pal.secondary, { at: [0, beamY + 1, 4], step: h + 2 }); // 坐在 z4 补板（板顶 = beamY+1）上
        b.add('2412b', pal.accent, { at: [0, beamTop + 3, 2], step: h + 3 });
        return { rootId: step0.id };
      },
    },
    {
      familyId: 'fam-stair',
      title: '阶梯（递升平台 + 双立柱 + 扶手）',
      views: [{ az: 45, el: 16 }, { az: 135, el: 20 }, { az: -45, el: 12 }],
      instances: 14,
      build(b, rnd, pal) {
        const steps = 3 + Math.floor(rnd() * 2); // 3..4 级
        const step0 = b.add('3004', pal.primary, { at: [0, 0, 0], rot: 90, step: 1 });
        b.add('3004', pal.primary, { at: [2, 0, 0], rot: 90, step: 1 });
        for (let s = 1; s < steps; s++) {
          const zAt = s * 2;
          for (let y = 0; y <= s * 3; y += 3) {
            const col = y / 3;
            b.add('3004', col % 2 === 0 ? pal.primary : pal.secondary, { at: [0, y, zAt], rot: 90, step: y + 1 });
            b.add('3004', col % 2 === 0 ? pal.secondary : pal.primary, { at: [2, y, zAt], rot: 90, step: y + 1 });
          }
        }
        for (let s = 0; s < steps; s++) {
          const py = s * 3 + 3;
          const zAt = s * 2;
          b.add('3023', pal.trim, { at: [0, py, zAt], step: s + 2 });
          b.add('3023', pal.accent, { at: [2, py, zAt], step: s + 2 });
        }
        // 顶平台 + 扶手（平台压在最后一级上，扶柱落在平台单元格内）
        const topY = steps * 3 + 1;
        b.add('3020', pal.trim, { at: [0, topY, steps * 2 - 2], rot: 90, step: steps + 2 });
        b.add('3005', pal.accent, { at: [0, topY + 1, steps * 2], step: steps + 3 });
        b.add('3005', pal.accent, { at: [1, topY + 1, steps * 2 + 1], step: steps + 3 });
        return { rootId: step0.id };
      },
    },
    {
      familyId: 'fam-pylon',
      title: '信号塔（双柱 + 横担 + SNOT 旗帜 + 顶灯）',
      views: [{ az: 10, el: 8 }, { az: 75, el: 14 }, { az: 190, el: 16 }],
      instances: 12,
      build(b, rnd, pal) {
        const step0 = b.add('3004', pal.primary, { at: [0, 0, 0], rot: 90, step: 1 });
        b.add('3004', pal.primary, { at: [3, 0, 0], rot: 90, step: 1 });
        let y = 3;
        let snotB = null;
        const segs = 3 + Math.floor(rnd() * 3); // 后续段数
        for (let i = 0; i < segs; i++) {
          if (i % 2 === 1) {
            // 横担（1 片板，横跨 x0..3）
            b.add('3710', pal.trim, { at: [0, y, 0], step: y + 1 });
            y += 1;
          } else {
            // 柱段（3 片高；其中一段混入侧凸点砖）
            if (i === 2) {
              snotB = b.add('87087', pal.accent, { at: [0, y, 0], step: y + 1 });
              b.add('3004', pal.secondary, { at: [3, y, 0], rot: 90, step: y + 1 });
            } else {
              b.add('3004', i % 4 === 0 ? pal.secondary : pal.primary, { at: [0, y, 0], rot: 90, step: y + 1 });
              b.add('3004', i % 4 === 0 ? pal.primary : pal.secondary, { at: [3, y, 0], rot: 90, step: y + 1 });
            }
            y += 3;
          }
        }
        // SNOT 旗帜（扣在侧凸点砖侧面）
        if (snotB) {
          const plateA = b.add('3024', pal.secondary, { on: snotB.id, stud: 1, up: '+z', step: y + 1 });
          b.add('3023', pal.trim, { on: plateA.id, stud: 0, up: '+z', step: y + 2 });
        }
        // 顶灯（落在双柱间的板面上）
        b.add('3020', pal.trim, { at: [0, y, 0], step: y + 1 });
        b.add('3003', pal.accent, { at: [1, y + 1, 0], step: y + 2 });
        b.add('3062b', pal.primary, { at: [1, y + 4, 0], step: y + 3 });
        b.add('4073', pal.secondary, { at: [1, y + 7, 0], step: y + 4 });
        return { rootId: step0.id };
      },
    },
    {
      familyId: 'fam-pier',
      title: '码头平台（桩柱 + 平台板 + 货箱 + 系船柱）',
      views: [{ az: 55, el: 12 }, { az: 155, el: 18 }, { az: -30, el: 10 }],
      instances: 12,
      build(b, rnd, pal) {
        const piles = [[0, 0], [0, 5], [3, 0], [3, 5]];
        const step0 = b.add('3004', pal.primary, { at: [0, 0, 0], rot: 90, step: 1 });
        for (const [px, pz] of piles.slice(1)) b.add('3004', pal.primary, { at: [px, 0, pz], rot: 90, step: 1 });
        for (const [px, pz] of piles) b.add('3004', pal.secondary, { at: [px, 3, pz], rot: 90, step: 2 });
        const deckY = 6;
        for (const [dx, dz] of [[0, 0], [0, 4], [2, 0], [2, 4]]) {
          b.add('3020', dx === 0 ? pal.trim : pal.accent, { at: [dx, deckY, dz], rot: 90, step: deckY + 1 });
        }
        // 货箱
        b.add('3003', pal.accent, { at: [0, deckY + 1, 0], step: deckY + 2 });
        b.add('3003', pal.secondary, { at: [0, deckY + 4, 0], step: deckY + 3 });
        b.add('3001', pal.primary, { at: [0, deckY + 1, 2], step: deckY + 2 });
        // 系船柱
        b.add('3062b', pal.secondary, { at: [3, deckY + 1, 6], step: deckY + 4 });
        b.add('4073', pal.trim, { at: [3, deckY + 4, 6], step: deckY + 5 });
        return { rootId: step0.id };
      },
    },
  ];
  return { defs, PALETTES, paletteList };
}

// ---------------------------------------------------------------- 装配源（已验证模型）

function sourceFamilySpecs() {
  return [
    {
      familyId: 'fam-src-mecha',
      title: '已验证机甲模型回放（examples/mecha.brick.json）',
      instances: [{ instanceId: 'mecha-replay', file: 'examples/mecha.brick.json' }],
      views: [{ az: 30, el: 14 }, { az: 120, el: 18 }, { az: -40, el: 10 }],
      instanceId: 'mecha-replay',
    },
    {
      familyId: 'fam-src-lantern',
      title: '已验证灯笼模型回放（examples/lantern.reconstructed.brick.json）',
      instances: [{ instanceId: 'lantern-replay', file: 'examples/lantern.reconstructed.brick.json' }],
      views: [{ az: 25, el: 12 }, { az: 105, el: 20 }, { az: 215, el: 10 }],
      instanceId: 'lantern-replay',
    },
    {
      familyId: 'fam-src-cottage',
      title: '已验证小屋模型回放（examples/cottage.brick.json）',
      instances: [{ instanceId: 'cottage-replay', file: 'examples/cottage.brick.json' }],
      views: [{ az: 35, el: 16 }, { az: 150, el: 14 }, { az: -60, el: 18 }],
      instanceId: 'cottage-replay',
    },
  ];
}

function fixtureFamilySpecs() {
  const base = 'out/prd-v2/2026-10-26-a/A';
  return [
    {
      familyId: 'fam-fixture-a03',
      title: '0.3 夹具模型回放（A 侧验证产物）',
      views: [{ az: 30, el: 14 }, { az: 100, el: 20 }],
      instances: [
        { instanceId: 'a03-snotchain', file: `${base}/snot/snot-chain.assembly.brick.json` },
        { instanceId: 'a03-cli-after', file: `${base}/cli/after.brick.json` },
        { instanceId: 'a03-cli-mini', file: `${base}/cli/mini.brick.json` },
      ],
    },
  ];
}

// ---------------------------------------------------------------- 渲染（纯 CPU：SVG → sharp）

function shade(hex, factor) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * factor)));
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * factor)));
  const b = Math.max(0, Math.min(255, Math.round((n & 255) * factor)));
  return `rgb(${r},${g},${b})`;
}

function cameraFor(bbox, view, width, height) {
  const target = [r4((bbox.min[0] + bbox.max[0]) / 2), r4((bbox.min[1] + bbox.max[1]) / 2), r4((bbox.min[2] + bbox.max[2]) / 2)];
  const radius = Math.hypot(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]) / 2;
  const distance = r4((radius / Math.tan((30 / 2) * Math.PI / 180)) * 1.22 + 2);
  return {
    viewId: view.id,
    azimuthDeg: view.az, elevationDeg: view.el,
    target, distance,
    fovYDeg: 30, near: 0.1, far: 2000,
    viewport: { width, height },
    projection: 'perspective',
    pixelOrigin: 'top-left',
    up: '+Y',
  };
}

function modelBBox(model) {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const p of model.parts) {
    const def = CAT.parts[p.part];
    if (!def) continue;
    let boxes;
    try { boxes = partBoxes(p, def); } catch { continue; }
    for (const b of boxes) {
      min = [Math.min(min[0], b.x0), Math.min(min[1], b.y0 * PLATE), Math.min(min[2], b.z0)];
      max = [Math.max(max[0], b.x1), Math.max(max[1], b.y1 * PLATE), Math.max(max[2], b.z1)];
    }
  }
  if (!min.every(Number.isFinite)) return { min: [0, 0, 0], max: [1, 1, 1] };
  return { min, max };
}

const FACE_DEFS = [
  { n: [0, 1, 0], corners: (b) => [[b.min[0], b.max[1], b.min[2]], [b.max[0], b.max[1], b.min[2]], [b.max[0], b.max[1], b.max[2]], [b.min[0], b.max[1], b.max[2]]], f: 1.16 },
  { n: [0, -1, 0], corners: (b) => [[b.min[0], b.min[1], b.min[2]], [b.max[0], b.min[1], b.min[2]], [b.max[0], b.min[1], b.max[2]], [b.min[0], b.min[1], b.max[2]]], f: 0.55 },
  { n: [0, 0, 1], corners: (b) => [[b.min[0], b.min[1], b.max[2]], [b.max[0], b.min[1], b.max[2]], [b.max[0], b.max[1], b.max[2]], [b.min[0], b.max[1], b.max[2]]], f: 1.0 },
  { n: [0, 0, -1], corners: (b) => [[b.min[0], b.min[1], b.min[2]], [b.max[0], b.min[1], b.min[2]], [b.max[0], b.max[1], b.min[2]], [b.min[0], b.max[1], b.min[2]]], f: 0.82 },
  { n: [1, 0, 0], corners: (b) => [[b.max[0], b.min[1], b.min[2]], [b.max[0], b.min[1], b.max[2]], [b.max[0], b.max[1], b.max[2]], [b.max[0], b.max[1], b.min[2]]], f: 0.92 },
  { n: [-1, 0, 0], corners: (b) => [[b.min[0], b.min[1], b.min[2]], [b.min[0], b.min[1], b.max[2]], [b.min[0], b.max[1], b.max[2]], [b.min[0], b.max[1], b.min[2]]], f: 0.72 },
];

/** 世界坐标相机（与 render-state.js makeCamera 同口径） */
function makeCam(camQ) {
  const az = (camQ.azimuthDeg * Math.PI) / 180;
  const el = (camQ.elevationDeg * Math.PI) / 180;
  const dir = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
  const eye = [
    camQ.target[0] + dir[0] * camQ.distance,
    camQ.target[1] + dir[1] * camQ.distance,
    camQ.target[2] + dir[2] * camQ.distance,
  ];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return l < 1e-12 ? [0, 0, 0] : [v[0] / l, v[1] / l, v[2] / l]; };
  const zc = norm(sub(eye, camQ.target));
  const xc = norm(cross([0, 1, 0], zc));
  const yc = cross(zc, xc);
  const project = (wp) => {
    const rel = sub(wp, eye);
    const cx = dot(rel, xc), cy = dot(rel, yc), cz = dot(rel, zc);
    const depth = -cz;
    if (!(depth > camQ.near) || depth > camQ.far) return null;
    const f = 1 / Math.tan((camQ.fovYDeg * Math.PI) / 360);
    const aspect = camQ.viewport.width / camQ.viewport.height;
    const ndcX = (cx * f) / aspect / depth;
    const ndcY = (cy * f) / depth;
    return {
      x: r4(camQ.viewport.x + ((ndcX + 1) / 2) * camQ.viewport.width),
      y: r4(camQ.viewport.y + ((1 - ndcY) / 2) * camQ.viewport.height),
      depth: r4(depth),
    };
  };
  return { eye, project };
}

function renderSvg(model, camQ, labels) {
  const cam = makeCam(camQ);
  // 按零件分组：零件深度 = 其包围盒最远角深度（互不穿模前提下，画家算法按最远角排序稳定）
  const partDrawables = [];
  for (const p of model.parts) {
    const def = CAT.parts[p.part];
    if (!def) continue;
    let boxes;
    try { boxes = partBoxes(p, def); } catch { continue; }
    const baseHex = COLOR_HEX[String(p.color)] || '#969696';
    const items = [];
    let partDepth = 0;
    for (const box of boxes) {
      const b = {
        min: [box.x0, box.y0 * PLATE, box.z0],
        max: [box.x1, box.y1 * PLATE, box.z1],
      };
      for (const corner of [b.min, b.max]) partDepth = Math.max(partDepth, cam.project(corner)?.depth ?? 0);
      const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = (b.min[2] + b.max[2]) / 2;
      const view = [cam.eye[0] - cx, cam.eye[1] - cy, cam.eye[2] - cz];
      for (const face of FACE_DEFS) {
        const d = face.n[0] * view[0] + face.n[1] * view[1] + face.n[2] * view[2];
        if (d <= 0) continue;
        const pts = face.corners(b).map((wp) => cam.project(wp));
        if (pts.some((q) => !q)) continue;
        const ctr = cam.project([cx + face.n[0] * 0.01, cy + face.n[1] * 0.01, cz + face.n[2] * 0.01]);
        items.push({
          depth: ctr ? ctr.depth : Math.min(...pts.map((q) => q.depth)),
          svg: `<polygon points="${pts.map((q) => `${q.x},${q.y}`).join(' ')}" fill="${shade(baseHex, face.f)}" stroke="${shade(baseHex, face.f * 0.55)}" stroke-width="1"/>`,
        });
      }
    }
    // 凸点（含侧凸点）：中性圆点，属于所属零件一起排序，提供接口视觉锚
    let conn;
    try { conn = partConnectors(p, def); } catch { conn = null; }
    if (conn) {
      for (const s2 of conn.studs) {
        const wp = [s2.pos[0], s2.pos[1] * PLATE, s2.pos[2]];
        const proj = cam.project(wp);
        if (!proj) continue;
        const ppu = (camQ.viewport.height / 2) / (Math.tan((camQ.fovYDeg * Math.PI) / 360) * proj.depth);
        const r = r4(0.3 * ppu);
        if (r < 0.8 || r > 40) continue;
        const hex = COLOR_HEX[String(p.color)] || '#969696';
        items.push({
          depth: proj.depth + 0.05,
          svg: `<circle cx="${proj.x}" cy="${proj.y}" r="${r}" fill="${shade(hex, 1.22)}" stroke="${shade(hex, 0.5)}" stroke-width="${r4(Math.max(0.6, r * 0.18))}"/>`,
        });
      }
    }
    partDrawables.push({ depth: partDepth, items });
  }
  partDrawables.sort((a, b) => b.depth - a.depth); // 远 → 近（画家算法）
  const badgeSvg = (labels || []).map((l) => `
    <g class="som-badge">
      <circle cx="${l.pixel[0]}" cy="${l.pixel[1]}" r="13" fill="#FFFFFF" fill-opacity="0.94" stroke="#4B5055" stroke-width="2.4"/>
      <text x="${l.pixel[0]}" y="${l.pixel[1] + 5.5}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="15" font-weight="bold" fill="#141414">${l.tag}</text>
    </g>`).join('');
  const body = partDrawables.map((pd) => pd.items.sort((x, y) => y.depth - x.depth).map((it) => it.svg).join('')).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${camQ.viewport.width}" height="${camQ.viewport.height}" viewBox="0 0 ${camQ.viewport.width} ${camQ.viewport.height}">
  <rect width="100%" height="100%" fill="#E9EDF2"/>
  <g class="geometry-layer">${body}</g>
  <g class="badge-overlay-layer">${badgeSvg}</g>
</svg>`;
}

async function svgToPng(svg) {
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// ---------------------------------------------------------------- 家族处理

function renderStateSafe(model, camQ, stateHash) {
  try {
    return renderState({
      model, cat: CAT, stateHash,
      camera: {
        azimuthDeg: camQ.azimuthDeg, elevationDeg: camQ.elevationDeg,
        target: camQ.target, distance: camQ.distance,
        width: camQ.viewport.width, height: camQ.viewport.height,
      },
      maxLabels: 32,
    });
  } catch { return null; }
}

async function processFamily(spec, outDir, opts) {
  const famDir = path.join(outDir, 'families', spec.familyId);
  const imgDir = path.join(outDir, 'images', spec.familyId);
  fs.mkdirSync(famDir, { recursive: true });
  fs.mkdirSync(imgDir, { recursive: true });

  const width = opts.width;
  const height = opts.width;
  const views = spec.views.map((v, i) => ({ ...v, id: `v${i}` }));
  const CHUNK = 6;

  const samples = [];
  const stats = {
    familyId: spec.familyId, title: spec.title, instances: [], samples: 0,
    images: 0, skippedSteps: 0, silentParts: 0, errors: [],
  };
  const seenDedup = new Set();
  const registry = familyRegistry();

  const instanceDefs = spec.instances
    ? spec.instances
    : Array.from({ length: spec.instancesCount ?? 8 }, (_, i) => ({
      instanceId: `${spec.familyId}-i${String(i + 1).padStart(2, '0')}`,
      programmatic: true,
      paletteIdx: i % registry.paletteList.length,
    }));

  for (const inst of instanceDefs) {
    const instDir = path.join(famDir, 'instances', inst.instanceId);
    const instImgDir = path.join(imgDir, inst.instanceId);
    fs.mkdirSync(instDir, { recursive: true });
    fs.mkdirSync(instImgDir, { recursive: true });

    // —— 1. 构建/读取装配源终态 ——
    let orderedParts;
    let sourceKind;
    let finalModelRaw;
    if (inst.programmatic) {
      const pal = registry.PALETTES[registry.paletteList[inst.paletteIdx]];
      const b = createBuilder({ catalog: CAT, meta: { name: inst.instanceId, front: '+z' } });
      const instRand = mulberry32(seedOf(`inst:${spec.familyId}:${inst.instanceId}`));
      spec.build(b, instRand, pal);
      b.assert();
      finalModelRaw = b.model();
      sourceKind = 'programmatic_builder';
      orderedParts = topoOrder(finalModelRaw.parts, CAT);
    } else {
      finalModelRaw = JSON.parse(fs.readFileSync(path.join(ROOT, inst.file), 'utf8'));
      sourceKind = 'verified_source_replay';
      const srcV = validateClean(finalModelRaw);
      if (!srcV.ok) { stats.errors.push(`${inst.instanceId}: 源模型校验不过`); continue; }
      orderedParts = topoOrder(finalModelRaw.parts, CAT);
    }
    if (/60239/.test(inst.instanceId + (inst.file || ''))) throw new Error('60239 是禁用的开发样例');
    if (orderedParts.some((p) => !CAT.parts[p.part])) { stats.errors.push(`${inst.instanceId}: 目录外零件`); continue; }

    const finalFlat = flatModel(orderedParts, orderedParts.length, `${inst.instanceId}-final`);
    const finalV = validateClean(finalFlat);
    if (!finalV.ok) { stats.errors.push(`${inst.instanceId}: 终态校验不过 (${finalV.errors[0]?.msg ?? finalV.warnings[0]?.msg})`); continue; }

    // 资产锁（真实目录索引）
    const usedPartIds = [...new Set(orderedParts.map((p) => p.part))];
    const { assetLock, missing } = buildAssetLock(ASSET_INDEX, usedPartIds);
    if (missing.length) { stats.errors.push(`${inst.instanceId}: 资产锁缺件 ${missing.join(',')}`); continue; }

    // 相机：按实例终态 bbox 取景；家族冻结视角，按步分块轮换
    const bbox = modelBBox(finalFlat);
    const camQ = (viewId) => cameraFor(bbox, views.find((v) => v.id === viewId), width, height);
    const viewForStep = (k) => views[Math.floor(k / CHUNK) % views.length].id;

    // —— 2. 全部前缀状态：哈希 + 校验 + 落盘 ——
    const instStats = { instanceId: inst.instanceId, parts: orderedParts.length, samples: 0, silent: 0, skipped: 0, skipReasons: {} };
    const noteSkip = (reason) => { instStats.skipReasons[reason] = (instStats.skipReasons[reason] || 0) + 1; instStats.skipped += 1; };
    let imagesForInstance = 0;
    const renderCache = new Map();

    const hashes = new Array(orderedParts.length + 1);
    const modelOnlyHashes = new Array(orderedParts.length + 1);
    const valid = new Array(orderedParts.length + 1);
    const stateDir = path.join(instDir, 'states');
    fs.mkdirSync(stateDir, { recursive: true });
    for (let n = 0; n <= orderedParts.length; n++) {
      const m = flatModel(orderedParts, n, `${inst.instanceId}-s${n}`);
      const invN = makeInventoryTokens(inst.instanceId, orderedParts, n);
      hashes[n] = inspectFromModel(m, CAT, { inventory: invN }).stateHash;
      modelOnlyHashes[n] = inspectFromModel(m, CAT).stateHash;
      const v = validateClean(m);
      valid[n] = v.ok;
      fs.writeFileSync(
        path.join(stateDir, `state-${String(n).padStart(4, '0')}.brick.json`),
        JSON.stringify({ model: m, inventory: invN, stateHash: hashes[n], validation: { ok: v.ok, errors: v.errors.length, warnings: v.warnings.length } }, null, 2),
      );
    }

    const renderOnce = async (stateIdx, viewId, labeled, labels) => {
      const key = `${stateIdx}|${viewId}|${labeled ? 'l' : 'u'}`;
      if (renderCache.has(key)) return renderCache.get(key);
      const model = flatModel(orderedParts, stateIdx, `${inst.instanceId}-s${stateIdx}`);
      const q = camQ(viewId);
      const svg = renderSvg(model, { ...q, aspect: width / height, viewport: { x: 0, y: 0, width, height } }, labeled ? labels : null);
      const png = await svgToPng(svg);
      const sha = sha256(png);
      const file = path.join(instImgDir, `s${String(stateIdx).padStart(4, '0')}-${viewId}-${labeled ? 'labeled' : 'plain'}-${sha.slice(0, 8)}.png`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, png);
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      const entry = { imagePath: rel, imageSha256: sha, stateHash: hashes[stateIdx], camera: q };
      renderCache.set(key, entry);
      imagesForInstance += 1;
      return entry;
    };

    for (let k = 1; k < orderedParts.length; k++) {
      const part = orderedParts[k];
      if (!valid[k] || !valid[k + 1]) { noteSkip('invalid-prefix'); continue; }
      const attachable = !part.mount && [0, 1, 2].every((j) => Number.isInteger(part.at[j]));
      if (!attachable) { instStats.silent += 1; continue; }

      const taskId = `task-traj-${inst.instanceId}-s${k}`;
      const modelT = flatModel(orderedParts, k, `${inst.instanceId}-s${k}`);
      const inventoryT = makeInventoryTokens(inst.instanceId, orderedParts, k);
      const cache = new Map();
      let disc;
      try {
        disc = discoverCandidates({ modelT, hashT: hashes[k], inventoryT, part, targetNextHash: hashes[k + 1], targetNextModel: flatModel(orderedParts, k + 1, `${inst.instanceId}-s${k + 1}`), taskId, cache });
      } catch (e) {
        stats.errors.push(`${inst.instanceId} s${k}: 候选发现异常 ${e.message.slice(0, 120)}`);
        noteSkip('discover-throw');
        continue;
      }
      if (!disc.targetGroup.length) { instStats.silent += 1; continue; }

      // 干扰候选：合法但装错（真实执行 ≠ 目标状态）；公开候选集总量严格落在 3-5
      const MAX_PRESENTED = 5;
      const eqKeep = Math.min(disc.targetGroup.length - 1, 2);      // 等价组其余代表最多带 2 个
      const wantDistractors = Math.max(2, Math.min(4, MAX_PRESENTED - 1 - eqKeep));
      const distractors = seededShuffle(disc.distractorPool, mulberry32(seedOf(`distractor:${taskId}`))).slice(0, wantDistractors);
      const presentedEquiv = disc.targetGroup.slice(1, 1 + eqKeep);
      if (1 + presentedEquiv.length + distractors.length < 3) { noteSkip('too-few-candidates'); continue; }

      // 目标动作：优先取「哈希匹配」代表（与 builder 下一状态完全同表示），否则取几何等价代表
      const hashReps = disc.targetGroup.filter((r) => r.response.apply.stateHashAfter === hashes[k + 1]);
      const repPool = hashReps.length ? hashReps : disc.targetGroup;
      const targetRun = [...repPool].sort((a, b) => a.candidate.candidateId.localeCompare(b.candidateId))[0];
      const repIsHashMatch = hashReps.includes(targetRun);
      const token = `tok-${inst.instanceId}-${String(k).padStart(3, '0')}`;

      const actionRequest = {
        protocolVersion: '1.0.0', taskId, stateHash: hashes[k],
        actions: [{
          id: `act-${inst.instanceId}-s${k}`,
          op: 'attach_part',
          target: { partInstanceId: part.id },
          partId: part.part, color: part.color,
          candidateId: targetRun.candidate.candidateId,
          candidateHash: targetRun.candidate.candidateHash,
          candidateParentNodeId: targetRun.scope,
          inventoryToken: token,
          step: k + 1,
        }],
      };
      const ctx = {
        model: JSON.parse(JSON.stringify(modelT)), cat: CAT, stateHash: hashes[k],
        inventory: JSON.parse(JSON.stringify(inventoryT)), taskId,
        enumerate: (req) => {
          const key = `${req.childPartId}|${req.parentNodeId ?? ''}|${req.maxResults ?? ''}`;
          if (!cache.has(key)) cache.set(key, enumerateCandidates(disc.si.state, req, CAT, {}));
          return cache.get(key);
        },
      };
      const actionResponseFull = applyActions(ctx, actionRequest, {});
      if (!actionResponseFull.passed) {
        stats.errors.push(`${inst.instanceId} s${k}: 权威执行未通过`);
        noteSkip('authoritative-mismatch');
        continue;
      }
      if (repIsHashMatch) {
        if (actionResponseFull.apply.stateHashAfter !== hashes[k + 1]) {
          stats.errors.push(`${inst.instanceId} s${k}: 权威执行未复现目标状态哈希`);
          noteSkip('authoritative-mismatch');
          continue;
        }
      } else {
        const sig = geomSignature(actionResponseFull._workingModel);
        const tgt = geomSignature(flatModel(orderedParts, k + 1, `${inst.instanceId}-s${k + 1}`));
        if (sig.boxes !== tgt.boxes || sig.conns !== tgt.conns) {
          stats.errors.push(`${inst.instanceId} s${k}: 权威执行未复现目标状态几何`);
          noteSkip('authoritative-mismatch');
          continue;
        }
      }
      const actionResponse = (({ protocolVersion, kind, passed, stateHash, engine, apply, diagnostics }) => ({ protocolVersion, kind, passed, stateHash, engine, apply, diagnostics }))(actionResponseFull);

      // 视角选择：优先「目标父接口在本图中有标号」，同块共享相机提升图像复用；标号款式对所有接口一致
      const wantedView = viewForStep(k);
      const viewOrder = [wantedView, ...views.map((v) => v.id).filter((v) => v !== wantedView)];
      let chosenView = null;
      let rs = null;
      for (const vid of viewOrder) {
        const tryRs = renderStateSafe(modelT, camQ(vid), modelOnlyHashes[k]);
        if (!tryRs || !tryRs.ok) continue;
        if (!rs) { rs = tryRs; chosenView = vid; }
        const hasTarget = tryRs.labels.some((l) => l.nodeId === targetRun.scope && l.connectorId === targetRun.candidate.parentConnectorId);
        if (hasTarget) { rs = tryRs; chosenView = vid; break; }
      }
      if (!rs) { noteSkip('no-renderstate'); continue; }
      const q = camQ(chosenView);
      const interfaceMap = {
        version: 'render-state@1.0.0',
        stateHash: modelOnlyHashes[k],
        stateHashScope: 'model-only（renderState 契约不含库存）',
        stateHashInventoryThreaded: hashes[k],
        bindingNote: '标号绑定 model-only stateHash；动作协议 stateHash（含库存）见 stateRefs',
        camera: q,
        labels: rs.labels.map((l) => ({
          tag: l.tag, pixel: l.pixel, partInstanceId: l.nodeId, connectorId: l.connectorId,
          stableConnectorId: l.connectorId, type: l.connectorType, dir: l.dir, worldPos: l.worldPos,
          aliases: l.aliases,
        })),
        enumerationComplete: rs.enumerationComplete,
        truncated: rs.truncated,
      };

      // —— 3. 匿名候选集（随机 ID + 随机顺序，无 isTarget 字段）——
      const anonRand = mulberry32(seedOf(`anon:${taskId}`));
      const usedAnon = new Set();
      const anonId = () => {
        let s;
        do { s = `cand_${Math.floor(anonRand() * 0xffff).toString(16).padStart(4, '0')}`; } while (usedAnon.has(s));
        usedAnon.add(s);
        return s;
      };
      const targetAnon = anonId();
      const equivalentAnon = [targetAnon, ...presentedEquiv.map(() => anonId())];
      const distractorAnon = distractors.map(() => anonId());
      const publicItem = (run, anon) => ({
        candidateId: anon,
        op: 'attach_part',
        isAssembly: false,
        subassemblyTemplateId: null,
        parentInstanceId: run.candidate.parentNodeId,
        parentConnectorId: run.candidate.parentConnectorId,
        childPartId: run.candidate.childPartId,
        childConnectorId: run.candidate.childConnectorId,
        orientationId: run.candidate.orientationId,
        spinDeg: run.candidate.spinDeg,
        snot: run.candidate.snot,
        candidateHash: run.candidate.candidateHash,
      });
      const anonPairs = [
        ...[targetRun, ...presentedEquiv].map((run, i) => ({ run, anon: equivalentAnon[i], isTarget: true })),
        ...distractors.map((run, i) => ({ run, anon: distractorAnon[i], isTarget: false })),
      ];
      const shuffled = seededShuffle(anonPairs, mulberry32(seedOf(`order:${taskId}`)));
      const candidatesPublic = shuffled.map((p) => publicItem(p.run, p.anon));
      const candidateSetHash = sha256(JSON.stringify(candidatesPublic.map((c) => c.candidateHash).sort()));

      // 去重（familyId + stateHash + candidateSetHash）
      const dedupKey = `${spec.familyId}|${hashes[k]}|${candidateSetHash}`;
      if (seenDedup.has(dedupKey)) { noteSkip('dedup'); continue; }
      seenDedup.add(dedupKey);

      // —— 4. 渲染三图（当前带标号 / 目标无标号 / 评分无标号）——
      const badgeLabels = rs.labels.map((l) => ({ tag: l.tag, pixel: l.pixel }));
      const currentImg = await renderOnce(k, chosenView, true, badgeLabels);
      const targetImg = await renderOnce(k + 1, chosenView, false, null);
      const scoreImg = await renderOnce(k, chosenView, false, null);

      // —— 5. 组装样本（C3 契约）——
      const sampleId = `smp-traj-${spec.familyId.replace(/^fam-/, '')}-${inst.instanceId.replace(/^[^-]+-/, '')}-s${String(k).padStart(3, '0')}`;
      const candidateReceipts = anonPairs.map((p) => ({
        candidateId: p.anon,
        status: p.run.response.passed ? 'applied' : 'rejected',
        matchesTarget: Boolean(p.isTarget),
        executedStateHash: p.run.response.passed ? p.run.response.apply.stateHashAfter : null,
        diagCode: p.run.response.passed ? null : (p.run.response.diagnostics?.[0]?.code ?? 'rejected'),
      }));
      const sample = {
        sampleId,
        protocolVersion: '1.0.0',
        taskType: 'select_action',
        provenance: {
          sourceFamilyId: spec.familyId,
          sourceModelId: inst.instanceId,
          sourceRevision: 'r1',
          sourceKind,
          split: 'train',
          difficulty: spec.difficulty || 'mixed',
          generator: 'tools/brickvlm/gen_trajectory_dataset.mjs',
        },
        assetLock,
        engineRevision: 'actions-v1@1.0.0',
        renderRevision: 'render-state@1.0.0',
        renderMode: 'collision_proxy_svg_v1',
        catalogIndexSha256: CATALOG_INDEX_SHA,
        stateRefs: [
          { role: 'state_t', stateHash: hashes[k], modelOnlyStateHash: modelOnlyHashes[k], brickPath: path.relative(ROOT, path.join(stateDir, `state-${String(k).padStart(4, '0')}.brick.json`)).replace(/\\/g, '/'), partsCount: k, validationOk: valid[k] },
          { role: 'state_t+1', stateHash: hashes[k + 1], modelOnlyStateHash: modelOnlyHashes[k + 1], brickPath: path.relative(ROOT, path.join(stateDir, `state-${String(k + 1).padStart(4, '0')}.brick.json`)).replace(/\\/g, '/'), partsCount: k + 1, validationOk: valid[k + 1] },
        ],
        camera: q,
        images: [
          { role: 'current_labeled', imagePath: currentImg.imagePath, imageSha256: currentImg.imageSha256, labeled: true, stateHash: hashes[k] },
          { role: 'target_state', imagePath: targetImg.imagePath, imageSha256: targetImg.imageSha256, labeled: false, stateHash: hashes[k + 1] },
          { role: 'score_unlabeled', imagePath: scoreImg.imagePath, imageSha256: scoreImg.imageSha256, labeled: false, stateHash: hashes[k] },
        ],
        interfaceMap,
        inventory: inventoryT,
        candidates: {
          enumerationComplete: disc.applied < MAX_APPLIES_PER_STEP,
          truncated: false,
          enumerationScope: 'parent-scoped (action.candidateParentNodeId)',
          count: candidatesPublic.length,
          items: candidatesPublic,
        },
        target: {
          primaryAction: {
            op: 'attach_part',
            selectedCandidateId: targetAnon,
            consumedTokenId: token,
            assignedInstanceId: part.id,
          },
          equivalentCandidates: equivalentAnon,
        },
        verification: {
          isGeometricallyLegal: true,
          hasManualGroundTruth: false,
          groundTruthSource: 'structural_target_replay',
          stateTValidation: { ok: valid[k], errors: 0, warnings: 0 },
          stateNextValidation: { ok: valid[k + 1], errors: 0, warnings: 0 },
          targetConsistency: {
            method: 'real-replay-state-hash-or-geometry-equivalence',
            representativeMatchesBuilderHash: repIsHashMatch,
            note: '目标与等价组由逐候选真实 applyActions 执行、比较执行后 stateHash（覆盖零件/颜色/位姿/连接）判定；非锚点 AABB 近似',
            equivalentGroupSize: disc.targetGroup.length,
          },
          enumerationStats: { enumerated: disc.enumerated, executed: disc.applied, scopes: disc.scopes.length },
          candidateReceipts,
          labels: {
            note: 'ground-truth 标签区（真实引擎 ID；不属于模型输入）',
            actionRequest,
            actionResponse,
          },
          verifiedBy: 'src/core/actions-v1/apply.js',
        },
      };

      samples.push(sample);
      instStats.samples += 1;
      stats.samples += 1;
    }

    const instReceipt = {
      instanceId: inst.instanceId,
      sourceKind,
      parts: orderedParts.length,
      samples: instStats.samples,
      silentParts: instStats.silent,
      skippedSteps: instStats.skipped,
      skipReasons: instStats.skipReasons,
      images: imagesForInstance,
      finalValidation: { ok: finalV.ok, errors: 0, warnings: 0 },
      assetLockPartCount: assetLock.parts.length,
      builderReceipt: inst.programmatic
        ? { engine: 'src/core/builder.js', assert: 'zero-error', status: 'verified_zero_error' }
        : { engine: 'source_replay_topology', sourceFile: inst.file, status: 'verified_source' },
    };
    stats.instances.push(instStats);
    stats.images += imagesForInstance;
    stats.skippedSteps += instStats.skipped;
    stats.silentParts += instStats.silent;
    fs.writeFileSync(path.join(instDir, 'instance-receipt.json'), JSON.stringify(instReceipt, null, 2));
  }

  fs.writeFileSync(path.join(famDir, 'samples.jsonl'), samples.map((s) => JSON.stringify(s)).join('\n') + (samples.length ? '\n' : ''));
  stats.samples = samples.length;
  return { stats, samples };
}

// ---------------------------------------------------------------- 主流程：规划 / worker / 核验 / manifest

function allSpecs() {
  const { defs, paletteList, PALETTES } = familyRegistry();
  const progSpecs = defs.map((d) => ({
    familyId: d.familyId,
    title: d.title,
    build: d.build,
    views: d.views,
    instancesCount: d.instances,
    difficulty: 'programmatic',
    _paletteList: paletteList,
    _PALETTES: PALETTES,
  }));
  const srcSpecs = sourceFamilySpecs().map((s) => ({ ...s, difficulty: 'verified_source' }));
  const fixSpecs = fixtureFamilySpecs().map((s) => ({ ...s, difficulty: 'fixture' }));
  return [...srcSpecs, ...fixSpecs, ...progSpecs];
}

async function runWorker(shardId, shardCount, outDir, onlyList, width) {
  const specs = allSpecs()
    .filter((s) => !onlyList || onlyList.includes(s.familyId))
    .filter((_, i) => i % shardCount === shardId);
  const results = [];
  for (const spec of specs) {
    process.stdout.write(`[worker ${shardId}] family ${spec.familyId} ...\n`);
    const { stats } = await processFamily(spec, outDir, { width });
    results.push(stats);
    process.stdout.write(`[worker ${shardId}] family ${spec.familyId} done: ${stats.samples} samples, ${stats.images} images, skipped=${stats.skippedSteps}, silent=${stats.silentParts}, errors=${stats.errors.length}\n`);
    if (stats.errors.length) process.stdout.write(`  errors: ${stats.errors.slice(0, 5).join(' | ')}\n`);
  }
  fs.writeFileSync(path.join(outDir, `.shard-${shardId}.json`), JSON.stringify({ shardId, families: results }, null, 2));
  return results;
}

async function runVerify(outDir, nCheck) {
  const famDirs = fs.readdirSync(path.join(outDir, 'families'));
  const all = [];
  for (const fid of famDirs) {
    const f = path.join(outDir, 'families', fid, 'samples.jsonl');
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (line.trim()) all.push(JSON.parse(line));
    }
  }
  const rand = mulberry32(20261026);
  const sampled = nCheck >= all.length ? all : seededShuffle(all, rand).slice(0, nCheck);
  let passed = 0;
  const failures = [];
  for (const s of sampled) {
    try {
      const stateT = JSON.parse(fs.readFileSync(path.join(ROOT, s.stateRefs[0].brickPath), 'utf8'));
      const stateNext = JSON.parse(fs.readFileSync(path.join(ROOT, s.stateRefs[1].brickPath), 'utf8'));
      if (stateT.stateHash !== s.stateRefs[0].stateHash) throw new Error('state_t 文件哈希不一致');
      if (stateNext.stateHash !== s.stateRefs[1].stateHash) throw new Error('state_t+1 文件哈希不一致');
      if (stateT.validation.ok !== true || stateNext.validation.ok !== true) throw new Error('状态文件校验标记非 0/0');
      const si = inspectFromModel(stateT.model, CAT, { inventory: stateT.inventory });
      if (si.stateHash !== s.stateRefs[0].stateHash) throw new Error('state_t 重算哈希不一致');
      const ctx = {
        model: JSON.parse(JSON.stringify(stateT.model)), cat: CAT,
        stateHash: stateT.stateHash, inventory: JSON.parse(JSON.stringify(stateT.inventory)),
        taskId: s.verification.labels.actionRequest.taskId,
        enumerate: (req) => enumerateCandidates(si.state, req, CAT, {}),
      };
      const res = applyActions(ctx, s.verification.labels.actionRequest, {});
      const stored = s.verification.labels.actionResponse;
      if (!res.passed) throw new Error('重放未通过: ' + (res.diagnostics?.[0]?.code ?? '?'));
      if (res.apply.stateHashAfter !== stored.apply.stateHashAfter) throw new Error('重放 stateHash 不一致');
      if (s.verification.targetConsistency.representativeMatchesBuilderHash && res.apply.stateHashAfter !== s.stateRefs[1].stateHash) {
        throw new Error('重放 stateHash 与 state_t+1 不一致');
      }
      if (JSON.stringify(res.apply.results) !== JSON.stringify(stored.apply.results)) throw new Error('重放 results 不一致');
      passed += 1;
    } catch (e) {
      failures.push({ sampleId: s.sampleId, error: e.message.slice(0, 200) });
    }
  }
  const report = {
    checked: sampled.length,
    passed,
    failed: failures.length,
    failures: failures.slice(0, 20),
    method: '从 state_t 状态文件出发，用存储的 actionRequest 经真实 applyActions 重执行；比较 actionResponse 与 stateHashAfter',
    checkedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'replay-verification.json'), JSON.stringify(report, null, 2));
  return report;
}

async function benchmark(outDir, width) {
  const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/lantern.reconstructed.brick.json'), 'utf8'));
  const order = topoOrder(src.parts, CAT);
  const models = [];
  for (const n of [4, Math.floor(order.length / 2), order.length]) {
    models.push(flatModel(order, n, `bench-${n}`));
  }
  const bbox = modelBBox(models[2]);
  const cam = cameraFor(bbox, { id: 'bench', az: 35, el: 16 }, width, width);
  const camQ = { ...cam, aspect: width / width, viewport: { x: 0, y: 0, width, height: width } };
  const t0 = Date.now();
  let bytes = 0;
  for (let i = 0; i < 10; i++) {
    const m = models[i % models.length];
    const png = await svgToPng(renderSvg(m, camQ, i % 2 === 0 ? [{ tag: '1', pixel: [40, 40] }, { tag: '2', pixel: [90, 60] }] : null));
    bytes += png.length;
  }
  const msPer = (Date.now() - t0) / 10;
  const report = {
    width, height: width, renders: 10, msPerRender: r4(msPer), avgBytes: Math.round(bytes / 10),
    renderer: 'svg->sharp (CPU)', cameraContract: 'render-state@1.0.0 CAMERA_CONTRACT',
    projectedImagesPerHour: Math.round(3600000 / msPer),
    measuredAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'render-benchmark.json'), JSON.stringify(report, null, 2));
  return report;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const has = (name) => args.includes(`--${name}`);
  const outDir = path.resolve(ROOT, flag('out', 'out/prd-v2/run-20261026-c/C/data/trajectory'));
  fs.mkdirSync(outDir, { recursive: true });

  if (has('list-families')) {
    for (const s of allSpecs()) console.log(s.familyId, '-', s.title);
    return;
  }

  if (has('verify')) {
    const report = await runVerify(outDir, Number(flag('verify', '150')));
    console.log(JSON.stringify(report, null, 2));
    if (report.failed > 0) process.exit(2);
    return;
  }

  const width = Number(flag('width', '512'));

  // worker 子进程模式：处理 i % shardCount 分片后退出
  if (has('shard')) {
    await runWorker(Number(flag('shard', '0')), Number(flag('shard-count', '1')), outDir, null, width);
    return;
  }

  const bench = await benchmark(outDir, width);
  process.stdout.write(`[benchmark] ${bench.msPerRender} ms/render (${bench.renders} renders @ ${width}px), ~${bench.projectedImagesPerHour} images/h\n`);

  const onlyList = has('only') ? String(flag('only', '')).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const workers = Number(flag('workers', '5'));
  const generatedAt = new Date().toISOString();
  if (workers <= 1 || onlyList) {
    // 单进程模式：只跑分配到的家族
    const specs = allSpecs().filter((s) => !onlyList || onlyList.includes(s.familyId));
    for (const spec of specs) {
      process.stdout.write(`[worker 0] family ${spec.familyId} ...\n`);
      const { stats } = await processFamily(spec, outDir, { width });
      process.stdout.write(`[worker 0] family ${spec.familyId} done: ${stats.samples} samples, ${stats.images} images, skipped=${stats.skippedSteps}, silent=${stats.silentParts}, errors=${stats.errors.length}\n`);
      if (stats.errors.length) process.stdout.write(`  errors: ${stats.errors.slice(0, 8).join(' | ')}\n`);
    }
  } else {
    // worker 池：N 个 node 子进程按家族分片并行
    const results = await Promise.all(
      Array.from({ length: workers }, (_, i) => new Promise((resolve) => {
        const child = spawn(process.execPath, [__filename, '--out', outDir, '--shard', String(i), '--shard-count', String(workers), '--width', String(width)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
        child.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
        child.on('exit', (code) => resolve({ shard: i, code, out }));
      })),
    );
    const bad = results.filter((r) => r.code !== 0);
    if (bad.length) {
      process.stdout.write(`[workers] ${bad.length} 个分片失败: ${bad.map((b) => `shard${b.shard}#${b.code}`).join(',')}\n`);
    }
  }

  if (onlyList) {
    process.stdout.write(`[done] only-mode: ${onlyList.join(',')}\n`);
    return;
  }

  // —— 汇总 manifest ——
  const famDirs = fs.readdirSync(path.join(outDir, 'families')).sort();
  const countsPerFamily = {};
  let totalSamples = 0;
  let imagesCount = 0;
  for (const fid of famDirs) {
    const f = path.join(outDir, 'families', fid, 'samples.jsonl');
    let n = 0;
    if (fs.existsSync(f)) n = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).length;
    let imgs = 0;
    const imgRoot = path.join(outDir, 'images', fid);
    if (fs.existsSync(imgRoot)) {
      for (const d of fs.readdirSync(imgRoot)) {
        imgs += fs.readdirSync(path.join(imgRoot, d)).filter((x) => x.endsWith('.png')).length;
      }
    }
    countsPerFamily[fid] = { samples: n, images: imgs };
    totalSamples += n;
    imagesCount += imgs;
  }

  const verifyN = Number(flag('verify-n', '150'));
  const replay = await runVerify(outDir, verifyN);

  const manifest = {
    generatedAt,
    generatorSha256: sha256(fs.readFileSync(__filename)),
    cmd: `node tools/brickvlm/gen_trajectory_dataset.mjs --out ${path.relative(ROOT, outDir).replace(/\\/g, '/')} --workers ${workers} --width ${width}`,
    catalogIndexHash: CATALOG_INDEX_SHA,
    assetLockProfileId: ASSET_INDEX.profileId,
    assetLockIndexVersion: ASSET_INDEX.version,
    countsPerFamily,
    totalSamples,
    dedupRule: 'familyId + stateHash(state_t) + sha256(sorted candidateHash[]) — 候选集内容去重',
    imagesCount,
    render: {
      resolution: { width, height: width },
      renderer: 'svg->sharp CPU (collision_proxy_svg_v1)',
      benchmark: bench,
      cameraContract: 'render-state@1.0.0 (perspective fovY 30, explicit target/distance/viewport)',
    },
    replayVerification: { checked: replay.checked, passed: replay.passed, failed: replay.failed },
    sampleSchemaRef: 'docs/prd-v2/PRD.md §10.4 数据样本契约 C3 + docs/prd-v2/implementation-B/contracts/dataset.schema.json (v4 先例)',
    taskType: 'select_action',
    protocolVersion: '1.0.0',
    anonymity: '公开候选随机匿名 ID（cand_xxxx）+ 随机顺序；真实引擎 ID 仅存在于 verification.labels（ground-truth 标签区）',
    forbiddenParts: ['60239'],
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  process.stdout.write(`[manifest] totalSamples=${totalSamples} images=${imagesCount} replay=${replay.passed}/${replay.checked}\n`);
  if (replay.failed > 0) process.exit(2);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  main().catch((e) => { console.error('生成失败:', e); process.exit(1); });
}
