/**
 * tools/brickvlm/gen_perturbation_dataset.mjs
 *
 * BrickVLM C1-3：understand_structure + repair_local 结构理解与修复数据工厂。
 *
 * 方法（任务书 docs/prd-v2/HANDOFF-C-single-agent.md §3 C1-3）：
 *   1. 参考状态：≥5 个程序化模型族（createBuilder 搭建，含 L 形堆叠 / SNOT 侧装墙 /
 *      支架挂装 / 小车 / 对称门楼 / 双塔），每实例终态 validate 0 errors / 0 warnings。
 *   2. 扰动：从参考状态按 (零件 × 类型) 组合随机抽样（绝不编号取模），五类：
 *      (a) missing_part        —— 移除一个可拆零件（拆后仍 validate 0/0）；
 *      (b) misaligned          —— 同零件换到另一个「引擎枚举出的真实落位」（错误但物理合法）；
 *      (c) left_right_swap     —— 交换一对镜像同件号异色零件的颜色（镜像对按模型包围盒
 *                                  对称面判定，交换后 validate 0/0）；
 *      (d) wrong_color         —— 同零件换成目录中另一可见颜色；
 *      (e) reversed_orientation—— 零件原地转 180°（仅当碰撞盒改变且 validate 0/0，保证可视可辨）。
 *      每个扰动状态都是真实装配源（落盘 .brick.json + stateHash + 0/0 校验）。
 *   3. 真值：参考态与扰动态的逐实例结构 diff（件号/颜色/位置/姿态），issueType 由 diff
 *      模式本身分类（不看「用了哪种扰动公式」），expected/actual 全部来自 diff。
 *   4. 修复：每条扰动给出最小修复动作序列（detach/attach_part/replace，全部经引擎
 *      enumerateCandidates + applyActions 真实执行取得 candidateId）。
 *      出厂门禁：在扰动状态上逐事务真实重放修复序列，修复后 canonical model-only
 *      stateHash 必须等于参考态（100% 通过才允许产出）。
 *   5. 渲染（纯 CPU，SVG→sharp，对齐 render-state@1.0.0 相机契约）：参考图（无标号）、
 *      扰动图（中立 Set-of-Mark 接口标号，全部接口同款式，绝不泄露答案）、扰动第二视角；
 *      家族冻结视角，图绑定 stateHash + 相机 + sha256。
 *   6. 匿名化：公开样本中实例引用用随机 prt_xxxx、库存 token 用随机 tok_xxxx、候选用
 *      随机 cand_xxxx 且乱序无 isTarget 字段；真实引擎 ID 只在 verification.labels
 *      （ground-truth 标签区）出现。
 *   7. 独立复核：全量 repair_local 样本从落盘扰动状态出发重放修复，比较 canonical 哈希，
 *      任一失败退出码 2。
 *
 * 用法：
 *   node tools/brickvlm/gen_perturbation_dataset.mjs --out <dir> [--workers 6] [--only fam-gate]
 *   node tools/brickvlm/gen_perturbation_dataset.mjs --check-families        （家族搭建冒烟）
 *   node tools/brickvlm/gen_perturbation_dataset.mjs --out <dir> --verify     （只跑重放核验）
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

// ---------------------------------------------------------------- 状态构建（0.2 扁平模型，规范化）

function normPart(p) {
  return {
    id: p.id, part: p.part, color: p.color, at: [...p.at],
    rot: p.rot ?? 0, up: p.up ?? '+y', snot: p.snot ?? 0,
    ...(p.mount ? { mount: p.mount } : {}),
  };
}

/** 规范化扁平模型：topo 步号（支撑顺序合法）+ 按 id 排序（哈希与数组顺序无关） */
function canonicalFlat(partsIn, metaName) {
  const ordered = topoSteps(partsIn.map(normPart));
  const withSteps = ordered.map((p, i) => ({ ...p, step: i + 1 }));
  withSteps.sort((a, b) => a.id.localeCompare(b.id));
  return {
    format: 'brickbuild',
    version: '0.2',
    meta: { name: metaName || 'perturbation-state' },
    parts: withSteps,
  };
}

function flatParts(model) {
  return model.parts.map((p) => ({ ...p, at: [...p.at] }));
}

/** canonical model-only stateHash：id 排序后由 inspectFromModel 计算（步骤不进哈希） */
/** canonical full stateHash（parts 按 id 排序 + inventory 按 token 排序后计算，消除数组顺序影响） */
function canonicalFullHash(parts, inventory) {
  const sorted = [...parts].sort((a, b) => a.id.localeCompare(b.id));
  const invSorted = [...inventory].map((t) => ({ ...t })).sort((a, b) => a.token.localeCompare(b.token));
  return inspectFromModel({ format: 'brickbuild', version: '0.2', meta: {}, parts: sorted }, CAT, { inventory: invSorted }).stateHash;
}

function canonicalModelOnlyHash(parts) {
  const sorted = [...parts].sort((a, b) => a.id.localeCompare(b.id));
  return inspectFromModel({ format: 'brickbuild', version: '0.2', meta: {}, parts: sorted }, CAT).stateHash;
}

function fullHashOf(model, inventory) {
  return inspectFromModel(model, CAT, { inventory }).stateHash;
}

function validateClean(model) {
  const v = validate(model, CAT);
  return { ok: v.ok && v.errors.length === 0 && v.warnings.length === 0, errors: v.errors, warnings: v.warnings };
}

// ---------------------------------------------------------------- 拓扑步号（物理连接贪心，与轨迹生成器同口径）

function connectsTo(cat, a, b) {
  try { return partsConnected(a, cat.parts[a.part], b, cat.parts[b.part]); } catch { return false; }
}

function topoSteps(parts) {
  const all = parts.map(normPart);
  const intAt = (p) => [0, 1, 2].every((j) => Number.isInteger(p.at[j]));
  const gMin = Math.min(...all.map((p) => p.at[1]));
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
        || (!p.mount && order.some((o) => connectsTo(CAT, o, p)))
        || (p.mount && placedIds.has(p.mount)));
    }
    if (idx === -1) {
      throw new Error(`拓扑步号卡死：剩余 ${remaining.slice(0, 6).map((p) => p.id).join(',')} 无法连接到已放零件`);
    }
    const [p] = remaining.splice(idx, 1);
    order.push(p);
    placedIds.add(p.id);
  }
  return order;
}

// ---------------------------------------------------------------- 库存 token（每实例 1 枚 + 每件号 1 枚备用，供 replace 消费）

function makeInventoryTokens(instanceId, refParts) {
  const tokens = refParts.map((p, i) => ({
    token: `tok-${instanceId}-${String(i).padStart(3, '0')}`,
    partId: p.part,
    colorId: p.color,
    color: p.color,
    instanceId: p.id,
    state: 'available',
  }));
  const spareIds = [...new Set(refParts.map((p) => p.part))].sort();
  for (const partId of spareIds) {
    tokens.push({
      token: `tok-${instanceId}-spare-${partId}`,
      partId,
      colorId: refParts.find((p) => p.part === partId).color,
      color: refParts.find((p) => p.part === partId).color,
      spare: true,
      state: 'available',
    });
  }
  return tokens;
}

/** 按在场零件标记 consumed（consumedBy=实例 id）；缺席零件 token 保持 available */
function inventoryFor(inventory, presentIds) {
  const present = new Set(presentIds);
  return inventory.map((t) => {
    if (t.spare) return { ...t };
    return present.has(t.instanceId)
      ? { ...t, state: 'consumed', consumedBy: t.instanceId, consumedAt: 'transaction' }
      : { token: t.token, partId: t.partId, colorId: t.colorId, color: t.color, instanceId: t.instanceId, state: 'available' };
  });
}

// ---------------------------------------------------------------- 结构 diff（真值唯一来源）

function placementOf(p) {
  return { at: [...p.at], rot: p.rot ?? 0, up: p.up ?? '+y', snot: p.snot ?? 0 };
}

/**
 * 逐实例结构 diff（按 id 配对）。返回：
 *   removed / added / changed: [{id, part, deltas: {color?, placement?}, expected, actual}]
 * orientationIdOf 参与姿态比较，rot/up/snot 任一变化记为 placement 变化。
 */
function diffStructures(refParts, pertParts) {
  const refById = new Map(refParts.map((p) => [p.id, p]));
  const pertById = new Map(pertParts.map((p) => [p.id, p]));
  const removed = [];
  const added = [];
  const changed = [];
  for (const [id, rp] of refById) {
    if (!pertById.has(id)) { removed.push({ id, part: rp.part, color: rp.color, placement: placementOf(rp) }); continue; }
    const pp = pertById.get(id);
    const deltas = {};
    if (rp.color !== pp.color) deltas.color = { expected: rp.color, actual: pp.color };
    const ra = JSON.stringify(placementOf(rp));
    const pa = JSON.stringify(placementOf(pp));
    if (ra !== pa) deltas.placement = { expected: placementOf(rp), actual: placementOf(pp) };
    if (Object.keys(deltas).length) changed.push({ id, part: rp.part, deltas, expected: { color: rp.color, ...placementOf(rp) }, actual: { color: pp.color, ...placementOf(pp) } });
  }
  for (const [id, pp] of pertById) {
    if (!refById.has(id)) added.push({ id, part: pp.part, color: pp.color, placement: placementOf(pp) });
  }
  return { removed, added, changed };
}

/** 由 diff 模式本身分类 issueType（不读扰动公式） */
function classifyDiff(diff, cat) {
  const { removed, added, changed } = diff;
  if (removed.length === 1 && added.length === 0 && changed.length === 0) {
    return { errorType: 'missing_part', faulty: [removed[0].id], issues: [{ partId: removed[0].id, issueType: 'missing_part', expected: { part: removed[0].part, color: removed[0].color, ...removed[0].placement }, actual: null }] };
  }
  if (removed.length === 0 && added.length === 0 && changed.length === 1) {
    const c = changed[0];
    if (c.deltas.color && !c.deltas.placement) {
      return { errorType: 'wrong_color', faulty: [c.id], issues: [{ partId: c.id, issueType: 'wrong_color', expected: { color: c.deltas.color.expected }, actual: { color: c.deltas.color.actual } }] };
    }
    if (c.deltas.placement && !c.deltas.color) {
      const e = c.deltas.placement.expected, a = c.deltas.placement.actual;
      const sameAt = JSON.stringify(e.at) === JSON.stringify(a.at);
      const orientOnly = sameAt && (e.rot !== a.rot || e.up !== a.up || e.snot !== a.snot);
      return {
        errorType: orientOnly ? 'reversed_orientation' : 'misaligned',
        faulty: [c.id],
        issues: [{ partId: c.id, issueType: orientOnly ? 'reversed_orientation' : 'misaligned', expected: e, actual: a }],
      };
    }
  }
  if (removed.length === 0 && added.length === 0 && changed.length === 2
    && changed.every((c) => c.deltas.color && !c.deltas.placement)
    && changed[0].part === changed[1].part
    && changed[0].deltas.color.expected === changed[1].deltas.color.actual
    && changed[1].deltas.color.expected === changed[0].deltas.color.actual) {
    return {
      errorType: 'left_right_swap',
      faulty: [changed[0].id, changed[1].id],
      issues: changed.map((c) => ({ partId: c.id, issueType: 'left_right_swap', expected: { color: c.deltas.color.expected }, actual: { color: c.deltas.color.actual } })),
    };
  }
  return null;
}

// ---------------------------------------------------------------- 镜像对检测（left_right_swap 用）

function modelBBoxParts(parts) {
  let min = [Infinity, Infinity, Infinity];
  let max = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
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

/**
 * 镜像同件号异色对：同 partId、同 rot（或 rot 互补 180°）、同 up/snot、同 y，
 * 位置关于模型格胞对称面（x 或 z）镜像，且两件颜色不同。交换两件颜色后物理布局不变。
 * 对称面在「格胞索引空间」计算：零件 at 是格胞索引，bbox 连续坐标会差半个格。
 */
function spanXZOf(p) {
  const def = CAT.parts[p.part];
  const [w, l] = def ? def.size : [1, 1];
  const rot = p.rot ?? 0;
  return rot === 90 || rot === 270 ? [l, w] : [w, l];
}

function findMirrorPairs(parts) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of parts) {
    const [sx, sz] = spanXZOf(p);
    minX = Math.min(minX, p.at[0]); maxX = Math.max(maxX, p.at[0] + sx - 1);
    minZ = Math.min(minZ, p.at[2]); maxZ = Math.max(maxZ, p.at[2] + sz - 1);
  }
  const sumX = minX + maxX;
  const sumZ = minZ + maxZ;
  const pairs = [];
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i], b = parts[j];
      if (a.part !== b.part || a.color === b.color) continue;
      if ((a.up ?? '+y') !== (b.up ?? '+y') || (a.snot ?? 0) !== (b.snot ?? 0)) continue;
      const rotMirror = ((a.rot ?? 0) + (b.rot ?? 0)) % 360 === 0;
      if ((a.rot ?? 0) !== (b.rot ?? 0) && !rotMirror) continue;
      const [sa] = spanXZOf(a);
      const [, saz] = spanXZOf(a);
      if (a.at[1] !== b.at[1]) continue;
      // x 镜像：z 跨与 z 位置一致，x 胞跨关于 sumX 对称
      const xMirror = a.at[2] === b.at[2]
        && (a.at[0] + b.at[0] + sa - 1) === sumX;
      // z 镜像：x 跨与 x 位置一致，z 胞跨关于 sumZ 对称
      const zMirror = a.at[0] === b.at[0]
        && (a.at[2] + b.at[2] + saz - 1) === sumZ;
      if (xMirror || zMirror) pairs.push([a, b]);
    }
  }
  return pairs;
}

// ---------------------------------------------------------------- 可拆零件（拆后其余件不失唯一连接）

function adjacencyOf(parts) {
  const adj = new Map(parts.map((p) => [p.id, new Set()]));
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      if (connectsTo(CAT, parts[i], parts[j])) {
        adj.get(parts[i].id).add(parts[j].id);
        adj.get(parts[j].id).add(parts[i].id);
      }
    }
  }
  return adj;
}

function removableParts(parts) {
  const adj = adjacencyOf(parts);
  const intAt = (p) => [0, 1, 2].every((j) => Number.isInteger(p.at[j]));
  const gMin = Math.min(...parts.map((p) => p.at[1]));
  const isGround = (p) => !p.mount && intAt(p) && p.at[1] === gMin;
  const out = [];
  for (const p of parts) {
    let ok = true;
    for (const other of parts) {
      if (other.id === p.id) continue;
      const nb = adj.get(other.id);
      if (nb.size === 1 && nb.has(p.id)) { ok = false; break; }
      if (nb.size === 0) { ok = false; break; }
    }
    if (!ok) continue;
    // 拆后每个连通分量必须仍含接地件（格胞整数、最低层）：否则出现无支撑悬空岛
    // （validate 会拒、topoSteps 会卡死）。多岛模型（如双开间门楼）本身合法，
    // 只要各岛仍有地面件即可。
    const rest = parts.filter((q) => q.id !== p.id);
    if (!rest.length) continue;
    const adj2 = adjacencyOf(rest);
    const seen = new Set();
    for (const seed of rest) {
      if (seen.has(seed.id) || !isGround(seed)) continue;
      const q = [seed.id];
      seen.add(seed.id);
      while (q.length) {
        const cur = q.pop();
        for (const nb of adj2.get(cur) || []) {
          if (!seen.has(nb)) { seen.add(nb); q.push(nb); }
        }
      }
    }
    if (seen.size !== rest.length) continue;
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------- 程序化模型族（≥5 族，全部 0/0）

export { familyRegistry, canonicalFlat, topoSteps, normPart, canonicalModelOnlyHash, flatParts, diffStructures, classifyDiff, findMirrorPairs, removableParts, adjacencyOf, makeInventoryTokens, inventoryFor, PALETTES, PALETTE_LIST, buildPerturbationPlans, probeAttachCandidates, buildAndVerifyRepair, processFamily, runVerify, allSpecs, CAT as CATALOG };

const PALETTES = {
  castle: { a: 71, b: 72, c: 4, d: 14, e: 0 },
  ocean: { a: 1, b: 73, c: 15, d: 14, e: 0 },
  lava: { a: 4, b: 0, c: 14, d: 320, e: 71 },
  forest: { a: 2, b: 10, c: 70, d: 28, e: 15 },
  candy: { a: 5, b: 29, c: 1, d: 14, e: 15 },
  desert: { a: 14, b: 19, c: 28, d: 6, e: 0 },
  slate: { a: 72, b: 71, c: 0, d: 14, e: 15 },
  royal: { a: 26, b: 31, c: 15, d: 14, e: 1 },
};
const PALETTE_LIST = Object.keys(PALETTES);

/** 在已放置零件上找侧凸点（可选朝向过滤），返回 { index, dir } 或 null */
function sideStudOf(placedPart, wantDir) {
  const def = CAT.parts[placedPart.part];
  let conn;
  try { conn = partConnectors(placedPart, def); } catch { return null; }
  for (const s of conn.studs) {
    if (s.kind !== 'side') continue;
    if (wantDir && s.dir !== wantDir) continue;
    return { index: s.index, dir: s.dir };
  }
  return null;
}

function familyRegistry() {
  const defs = [
    {
      familyId: 'fam-pgate',
      title: '对称门楼（四柱双梁 + 斜顶坡 + 镜像色柱）',
      difficulty: 'basic_stack',
      views: [{ az: 30, el: 14 }, { az: 105, el: 20 }],
      instances: 26,
      build(b, rnd, pal) {
        const colH = 2 + (rnd() < 0.5 ? 1 : 0); // 每柱 2~3 块
        b.add('3020', pal.e, { at: [0, 0, 0], step: 1 });
        b.add('3020', pal.e, { at: [0, 0, 2], step: 1 });
        for (let i = 0; i < colH; i++) {
          const s = i + 2;
          b.add('3005', i % 2 === 0 ? pal.a : pal.b, { at: [0, 1 + i * 3, 0], step: s });
          b.add('3005', i % 2 === 0 ? pal.b : pal.a, { at: [3, 1 + i * 3, 0], step: s });
          b.add('3005', i % 2 === 0 ? pal.a : pal.b, { at: [0, 1 + i * 3, 2], step: s });
          b.add('3005', i % 2 === 0 ? pal.b : pal.a, { at: [3, 1 + i * 3, 2], step: s });
        }
        const topY = 1 + colH * 3;
        b.add('3010', pal.c, { at: [0, topY, 0], step: colH + 2 });
        b.add('3010', pal.c, { at: [0, topY, 2], step: colH + 2 });
        const deckY = topY + 3;
        b.add('3020', pal.d, { at: [0, deckY, 0], step: colH + 3 });
        b.add('3020', pal.d, { at: [0, deckY, 2], step: colH + 3 });
        const capY = deckY + 1;
        b.add('3039', pal.a, { at: [0, capY, 0], step: colH + 4 });
        b.add('3039', pal.b, { at: [2, capY, 0], step: colH + 4 });
        b.add('3005', pal.d, { at: [0, capY, 2], step: colH + 4 });
        b.add('3003', pal.c, { at: [1, capY, 2], step: colH + 4 });
        b.add('3005', pal.e, { at: [3, capY, 2], step: colH + 4 });
        b.add('3062b', pal.a, { at: [0, capY + 3, 2], step: colH + 5 });
        b.add('4073', pal.e, { at: [1, capY + 3, 2], step: colH + 5 });
        b.add('3062b', pal.b, { at: [3, capY + 3, 2], step: colH + 5 });
      },
    },
    {
      familyId: 'fam-twintower',
      title: '双塔（镜像色塔身 + 斜顶 + 联顶板 + 后院圆砖）',
      difficulty: 'basic_stack',
      views: [{ az: 25, el: 16 }, { az: 155, el: 12 }],
      instances: 26,
      build(b, rnd, pal) {
        const h = 2 + (rnd() < 0.5 ? 1 : 0); // 塔身 2~3 层
        b.add('3020', pal.e, { at: [0, 0, 0], step: 1 });
        b.add('3020', pal.e, { at: [0, 0, 2], step: 1 });
        for (let i = 0; i < h; i++) {
          b.add('3003', i % 2 === 0 ? pal.a : pal.b, { at: [0, 1 + i * 3, 0], step: i + 2 });
          b.add('3003', i % 2 === 0 ? pal.b : pal.a, { at: [2, 1 + i * 3, 0], step: i + 2 });
        }
        const topY = 1 + h * 3;
        b.add('3039', pal.a, { at: [0, topY, 0], step: h + 2 });
        b.add('3039', pal.b, { at: [2, topY, 0], step: h + 2 });
        b.add('3020', pal.c, { at: [0, topY + 3, 0], step: h + 3 });
        b.add('3062b', pal.a, { at: [0, topY + 4, 0], step: h + 4 });
        b.add('3062b', pal.b, { at: [3, topY + 4, 0], step: h + 4 });
        b.add('2431', pal.d, { at: [0, 1, 2], step: h + 2 });
        b.add('3062b', pal.d, { at: [1, 1, 3], step: h + 3 });
        b.add('4073', pal.e, { at: [1, 4, 3], step: h + 4 });
      },
    },
    {
      familyId: 'fam-snotpanel',
      title: 'SNOT 侧装墙（87087 双侧凸点 + 11211/4733 + 分层侧贴板）',
      difficulty: 'snot',
      views: [{ az: 15, el: 10 }, { az: 205, el: 14 }],
      instances: 26,
      build(b, rnd, pal) {
        b.add('3795', pal.e, { at: [0, 0, 0], step: 1 }); // 6x2 底板 x0..5 z0..1
        b.add('3004', pal.a, { at: [0, 1, 0], step: 2 });            // x0..1 y1..3
        const s1 = b.add('87087', pal.c, { at: [2, 1, 0], step: 2 }); // x2 y1..3
        b.add('3004', pal.a, { at: [3, 1, 0], step: 2 });            // x3..4 y1..3
        const s2 = b.add('87087', pal.d, { at: [5, 1, 0], step: 2 }); // x5 y1..3
        b.add('3004', pal.b, { at: [0, 4, 0], step: 3 });            // x0..1 y4..6
        const s3 = b.add('11211', pal.c, { at: [2, 4, 0], step: 3 }); // x2..3 y4..8（2x1x5）
        b.add('3004', pal.b, { at: [4, 4, 0], step: 3 });            // x4..5 y4..6
        b.add('3004', pal.a, { at: [0, 7, 0], step: 4 });            // x0..1 y7..9
        b.add('3004', pal.a, { at: [4, 7, 0], step: 4 });            // x4..5 y7..9
        const s4 = b.add('4733', pal.d, { at: [2, 9, 0], step: 5 }); // x2 y9..11（坐 11211 顶）
        b.add('3005', pal.e, { at: [3, 9, 0], step: 5 });            // x3 y9..11
        b.add('3023', pal.c, { at: [0, 10, 0], step: 6 });           // 帽板 x0..1
        b.add('3023', pal.d, { at: [4, 10, 0], step: 6 });           // 帽板 x4..5
        b.add('3023', pal.e, { at: [2, 12, 0], step: 7 });           // 中央帽板 x2..3（坐 4733/3005 顶）
        b.add('3062b', pal.a, { at: [0, 11, 0], step: 8 });
        b.add('3062b', pal.b, { at: [5, 11, 0], step: 8 });
        b.add('4073', pal.e, { at: [3, 13, 0], step: 9 });
        // 前面（+z）第一层侧装板（snot=0，直接扣侧凸点）
        const f1 = b.add('3024', pal.e, { on: s1.id, stud: 1, up: '+z', step: 6 });
        const f2 = b.add('3024', pal.f ?? pal.b, { on: s2.id, stud: 1, up: '+z', step: 6 });
        b.add('2412b', pal.d, { on: s3.id, stud: 2, up: '+z', step: 6 });
        b.add('2412b', pal.c, { on: s3.id, stud: 4, up: '+z', step: 6 });
        // 前面第二层（叠在第一层板凸点上，再外移 1 片）
        b.add('3023', pal.f ?? pal.b, { on: f1.id, stud: 0, up: '+z', step: 7 });
        b.add('3023', pal.e, { on: f2.id, stud: 0, up: '+z', step: 7 });
        // 后面（-z）：4733 背面侧凸点
        const b1 = b.add('3024', pal.b, { on: s4.id, stud: 2, up: '-z', step: 10 });
        b.add('3023', pal.c, { on: b1.id, stud: 0, up: '-z', step: 11 });
      },
    },
    {
      familyId: 'fam-bracketholder',
      title: '支架挂装架（99780 正/倒支架对 + 侧贴板 + 裸支架对）',
      difficulty: 'bracket',
      views: [{ az: 40, el: 12 }, { az: 130, el: 18 }],
      instances: 26,
      build(b, rnd, pal) {
        b.add('3020', pal.e, { at: [0, 0, 0], step: 1 });
        b.add('3020', pal.e, { at: [0, 0, 2], step: 1 });
        for (const [px, pz] of [[0, 0], [0, 2], [3, 0], [3, 2]]) {
          b.add('3004', pal.a, { at: [px, 1, pz], rot: 90, step: 2 });
        }
        b.add('3010', pal.a, { at: [0, 4, 0], step: 3 });
        b.add('3010', pal.a, { at: [0, 4, 2], step: 3 });
        const beamTop = 7;
        // 支架对 1：带侧贴板（rot0 朝 +z / rot180 朝 -z，镜像）
        const br1 = b.add('99780', pal.c, { at: [0, beamTop, 0], step: 4 });
        const br2 = b.add('99780', pal.d, { at: [0, beamTop, 2], rot: 180, step: 4 });
        const sd1 = sideStudOf({ ...br1, at: [...br1.at], rot: br1.rot ?? 0, up: br1.up ?? '+y', snot: 0 }, '+z');
        const sd2 = sideStudOf({ ...br2, at: [...br2.at], rot: br2.rot ?? 0, up: br2.up ?? '+y', snot: 0 }, '-z');
        const p1 = b.add('3024', pal.a, { on: br1.id, stud: sd1.index, up: sd1.dir, step: 5 });
        const p2 = b.add('3024', pal.b, { on: br2.id, stud: sd2.index, up: sd2.dir, step: 5 });
        // （单层侧贴板：支架间距 2 格，第二层外挑板会撞邻架 web；分层侧装见 fam-snotpanel）
        // 支架对 2：裸支架（无可拆依赖，允许 reversed_orientation 翻转）
        b.add('99780', pal.c, { at: [2, beamTop, 0], step: 7 });
        b.add('99780', pal.d, { at: [2, beamTop, 2], rot: 180, step: 7 });
        // 中央立柱（立在底板中央空档，梁顶已被四组支架占满；y7 起四周是支架 web，到此为止）
        b.add('3003', pal.b, { at: [1, 1, 1], step: 3 });
        b.add('3062b', pal.f ?? pal.e, { at: [1, 4, 1], step: 8 });
      },
    },
    {
      familyId: 'fam-cart',
      title: '小车（平板底盘 + 驾驶室 + 引擎盖斜坡 + 货斗 + 尾圆灯）',
      difficulty: 'basic_stack',
      views: [{ az: 35, el: 12 }, { az: 145, el: 16 }],
      instances: 26,
      build(b, rnd, pal) {
        b.add('3795', pal.e, { at: [0, 0, 0], rot: 90, step: 1 }); // x0..1 z0..5
        b.add('3795', pal.e, { at: [2, 0, 0], rot: 90, step: 1 }); // x2..3 z0..5
        b.add('3003', pal.a, { at: [0, 1, 0], step: 2 });
        b.add('3003', pal.b, { at: [2, 1, 0], step: 2 });
        b.add('3004', pal.c, { at: [0, 4, 0], step: 3 });
        b.add('3004', pal.c, { at: [2, 4, 0], step: 3 });
        b.add('3020', pal.d, { at: [0, 7, 0], step: 4 });
        // 引擎盖斜坡（镜像对，可翻转）
        b.add('3039', pal.a, { at: [0, 1, 2], step: 5 });
        b.add('3039', pal.b, { at: [2, 1, 2], step: 5 });
        // 货斗
        b.add('3004', pal.b, { at: [0, 1, 4], rot: 90, step: 6 });
        b.add('3004', pal.b, { at: [3, 1, 4], rot: 90, step: 6 });
        b.add('3023', pal.c, { at: [1, 1, 4], step: 7 });
        b.add('3003', pal.c, { at: [1, 2, 4], step: 8 });
        b.add('85984', pal.d, { at: [1, 5, 4], step: 9 });
        // 尾灯（镜像对）+ 车顶小板（镜像对）
        b.add('3062b', pal.a, { at: [0, 4, 4], step: 10 });
        b.add('3062b', pal.b, { at: [3, 4, 4], step: 10 });
        b.add('3024', pal.e, { at: [0, 8, 0], step: 11 });
        b.add('3024', pal.f ?? pal.d, { at: [3, 8, 0], step: 11 });
      },
    },
    {
      familyId: 'fam-lstack',
      title: 'L 形堆叠（高塔 + 后墙 + 短臂 + 前柱奶酪坡）',
      difficulty: 'basic_stack',
      views: [{ az: 20, el: 14 }, { az: 115, el: 18 }],
      instances: 26,
      build(b, rnd, pal) {
        const towerH = 2 + (rnd() < 0.5 ? 1 : 0);
        b.add('3020', pal.e, { at: [0, 0, 0], step: 1 });
        b.add('3020', pal.e, { at: [0, 0, 2], step: 1 });
        for (let i = 0; i < towerH; i++) {
          b.add('3003', i % 2 === 0 ? pal.a : pal.b, { at: [0, 1 + i * 3, 0], step: i + 2 });
        }
        const towerTop = 1 + towerH * 3;
        b.add('3004', pal.b, { at: [0, 1, 2], rot: 90, step: towerH + 2 });
        b.add('3004', pal.b, { at: [0, 4, 2], rot: 90, step: towerH + 2 });
        b.add('3020', pal.c, { at: [2, 1, 2], step: towerH + 3 });
        b.add('3023', pal.c, { at: [2, 2, 2], step: towerH + 4 });
        b.add('3023', pal.c, { at: [2, 2, 3], step: towerH + 4 });
        b.add('3005', pal.d, { at: [2, 1, 0], step: towerH + 3 });
        b.add('3005', pal.e, { at: [3, 1, 0], step: towerH + 3 });
        b.add('85984', pal.c, { at: [2, 4, 0], step: towerH + 4 });
        b.add('2412b', pal.d, { at: [2, 3, 3], step: towerH + 5 });
        b.add('3062b', pal.f ?? pal.a, { at: [0, towerTop, 0], step: towerH + 5 });
        b.add('4073', pal.e, { at: [0, towerTop + 3, 0], step: towerH + 6 });
      },
    },
  ];
  return { defs };
}

// ---------------------------------------------------------------- 渲染（纯 CPU：SVG → sharp，与轨迹生成器同口径）

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

const FACE_DEFS = [
  { n: [0, 1, 0], corners: (b) => [[b.min[0], b.max[1], b.min[2]], [b.max[0], b.max[1], b.min[2]], [b.max[0], b.max[1], b.max[2]], [b.min[0], b.max[1], b.max[2]]], f: 1.16 },
  { n: [0, -1, 0], corners: (b) => [[b.min[0], b.min[1], b.min[2]], [b.max[0], b.min[1], b.min[2]], [b.max[0], b.min[1], b.max[2]], [b.min[0], b.min[1], b.max[2]]], f: 0.55 },
  { n: [0, 0, 1], corners: (b) => [[b.min[0], b.min[1], b.max[2]], [b.max[0], b.min[1], b.max[2]], [b.max[0], b.max[1], b.max[2]], [b.min[0], b.max[1], b.max[2]]], f: 1.0 },
  { n: [0, 0, -1], corners: (b) => [[b.min[0], b.min[1], b.min[2]], [b.max[0], b.min[1], b.min[2]], [b.max[0], b.max[1], b.min[2]], [b.min[0], b.max[1], b.min[2]]], f: 0.82 },
  { n: [1, 0, 0], corners: (b) => [[b.max[0], b.min[1], b.min[2]], [b.max[0], b.min[1], b.max[2]], [b.max[0], b.max[1], b.max[2]], [b.max[0], b.max[1], b.min[2]]], f: 0.92 },
  { n: [-1, 0, 0], corners: (b) => [[b.min[0], b.min[1], b.min[2]], [b.min[0], b.min[1], b.max[2]], [b.min[0], b.max[1], b.max[2]], [b.min[0], b.max[1], b.min[2]]], f: 0.72 },
];

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
      x: r4(((ndcX + 1) / 2) * camQ.viewport.width),
      y: r4(((1 - ndcY) / 2) * camQ.viewport.height),
      depth: r4(depth),
    };
  };
  return { eye, project };
}

function renderSvg(model, camQ, labels) {
  const cam = makeCam(camQ);
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
      const b = { min: [box.x0, box.y0 * PLATE, box.z0], max: [box.x1, box.y1 * PLATE, box.z1] };
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
  partDrawables.sort((a, b) => b.depth - a.depth);
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

// ---------------------------------------------------------------- 引擎动作执行辅助

function makeCtx(model, stateHash, inventory, taskId) {
  const si = inspectFromModel(model, CAT, { inventory });
  return {
    si,
    ctx: {
      model: JSON.parse(JSON.stringify(model)), cat: CAT, stateHash,
      inventory: JSON.parse(JSON.stringify(inventory)), taskId,
      enumerate: (req) => enumerateCandidates(si.state, req, CAT, {}),
    },
  };
}

/**
 * 在 stateMid（已去掉零件 p 的状态）上为「装回 p」枚举候选并逐个真实执行。
 *   correct = 执行后 canonical model-only 哈希 == 参考态（真实重放判定，非锚点近似）
 *   wrong   = 执行成功但哈希不同的合法落位（misaligned 干扰池）
 */
function probeAttachCandidates({ modelMid, hashMid, inventoryMid, part, refCanonicalHash, taskId, maxExec = 18 }) {
  const { si, ctx } = makeCtx(modelMid, hashMid, inventoryMid, taskId);
  const en = enumerateCandidates(si.state, { childPartId: part.part, maxResults: 5000 }, CAT, {});
  const wantOrient = orientationIdOf(part.up ?? '+y', part.rot ?? 0);
  const ordered = [...en.items].sort((a, b) => {
    const pa = a.orientationId === wantOrient ? 0 : 1;
    const pb = b.orientationId === wantOrient ? 0 : 1;
    return pa - pb || a.candidateId.localeCompare(b.candidateId);
  });
  const correct = [];
  const wrong = [];
  const tested = new Set();
  let executed = 0;
  for (const candidate of ordered) {
    if (tested.has(candidate.candidateId)) continue;
    tested.add(candidate.candidateId);
    if (executed >= maxExec) break;
    executed += 1;
    const request = {
      protocolVersion: '1.0.0', taskId, stateHash: hashMid,
      actions: [{
        id: 'probe', op: 'attach_part',
        target: { partInstanceId: part.id },
        partId: part.part, color: part.color,
        candidateId: candidate.candidateId, candidateHash: candidate.candidateHash,
        candidateParentNodeId: candidate.parentNodeId,
        inventoryToken: inventoryMid.find((t) => t.instanceId === part.id)?.token,
        step: part.step ?? 1,
      }],
    };
    const response = applyActions(ctx, request, {});
    if (!response.passed || !response._workingModel) continue;
    const execHash = canonicalModelOnlyHash(flatParts(response._workingModel));
    const run = { candidate, response, execHash };
    if (execHash === refCanonicalHash) correct.push(run);
    else wrong.push(run);
  }
  return { enumeration: en, correct, wrong, executed };
}

// ---------------------------------------------------------------- 扰动构造

const PERT_TYPES = ['missing_part', 'misaligned', 'left_right_swap', 'wrong_color', 'reversed_orientation'];

function altColorsFor(color, palette) {
  const all = [...new Set(Object.values(palette))];
  return all.filter((c) => c !== color);
}

/**
 * 为一个参考实例生成扰动候选清单（随机化零件 + 类型，绝不编号取模）。
 * 每项 {type, part?, pair?, make: () => perturbed|null, probe?} 由调用方按序尝试。
 */
async function buildPerturbationPlans({ family, instanceId, refModel, refParts, palette, rand, skipUnusedExec, counters }) {
  const plans = [];
  const refCanonical = canonicalModelOnlyHash(refParts);
  const removable = removableParts(refParts);
  const shuffledRemovable = seededShuffle(removable, rand);
  const probeBudget = Math.min(6, shuffledRemovable.length); // 每实例最多探测 6 个零件的候选执行

  // (a)+(b) 共享候选执行探测：missing 与 misaligned
  const probed = [];
  for (let i = 0; i < shuffledRemovable.length && probed.length < probeBudget; i++) {
    probed.push(shuffledRemovable[i]);
  }
  const pertInvRef = inventoryFor(makeInventoryTokens(instanceId, refParts), refParts.map((p) => p.id));
  for (const part of probed) {
    let modelMid, vMid, hashMid, probe;
    try {
      const without = refParts.filter((p) => p.id !== part.id);
      modelMid = canonicalFlat(without, `${instanceId}-mid-${part.id}`);
      vMid = validateClean(modelMid);
      if (!vMid.ok) { counters.skip('removal-invalid'); continue; }
      hashMid = fullHashOf(modelMid, inventoryFor(pertInvRef, without.map((p) => p.id)));
      probe = probeAttachCandidates({ modelMid, hashMid, inventoryMid: inventoryFor(pertInvRef, without.map((p) => p.id)), part, refCanonicalHash: refCanonical, taskId: `probe-${instanceId}-${part.id}` });
    } catch (e) {
      counters.skip('probe-throw');
      continue;
    }
    // (a) missing_part：拆后 0/0，且修复候选存在（能装回原位）
    if (probe.correct.length) {
      plans.push({
        type: 'missing_part', part, probe, modelMid, hashMid,
        weight: 1,
      });
    } else counters.skip('no-reinstall-candidate');
    // (b) misaligned：存在与原位不同的合法落位
    if (probe.wrong.length) {
      plans.push({
        type: 'misaligned', part, probe, modelMid, hashMid,
        weight: 1,
      });
    } else counters.skip('no-wrong-candidate');
  }

  // (c) left_right_swap：镜像同件号异色对，交换颜色
  for (const [a, b] of findMirrorPairs(refParts)) {
    plans.push({
      type: 'left_right_swap', pair: [a, b],
      weight: 1,
    });
  }

  // (d) wrong_color：每零件最多 2 个备选色（随机取样）
  const colorTargets = seededShuffle(refParts, rand).slice(0, 5);
  for (const part of colorTargets) {
    const alts = altColorsFor(part.color, palette);
    if (!alts.length) continue;
    const chosen = pick(rand, alts);
    plans.push({ type: 'wrong_color', part, newColor: chosen, weight: 1 });
  }

  // (e) reversed_orientation：rot 翻转 180°，仅当碰撞盒改变且 validate 0/0（不要求可拆）
  const flipTargets = seededShuffle(refParts, rand);
  let flipPlans = 0;
  for (const part of flipTargets) {
    if (flipPlans >= 4) break; // 每实例最多 4 个翻转计划，其余类型留预算
    const flipped = { ...part, at: [...part.at], rot: ((part.rot ?? 0) + 180) % 360 };
    let boxes0, boxes1;
    try {
      boxes0 = partBoxes(part, CAT.parts[part.part]);
      boxes1 = partBoxes(flipped, CAT.parts[part.part]);
    } catch { continue; }
    if (JSON.stringify(boxes0) === JSON.stringify(boxes1)) { counters.skip('flip-boxes-identical'); continue; }
    const trial = canonicalFlat(refParts.map((p) => (p.id === part.id ? flipped : p)), `${instanceId}-flip-${part.id}`);
    const v = validateClean(trial);
    if (!v.ok) { counters.skip('flip-invalid'); continue; }
    flipPlans += 1;
    plans.push({ type: 'reversed_orientation', part, flipped, weight: 1 });
  }

  // 类型均衡交错：同类内乱序，跨类轮转（随机但不让单一类型垄断每实例配额）
  const byType = new Map();
  for (const p of plans) {
    if (!byType.has(p.type)) byType.set(p.type, []);
    byType.get(p.type).push(p);
  }
  for (const list of byType.values()) {
    const shuffled = seededShuffle(list, rand);
    list.length = 0;
    list.push(...shuffled);
  }
  const typeOrder = seededShuffle([...byType.keys()], rand);
  const interleaved = [];
  let added = true;
  while (added) {
    added = false;
    for (const t of typeOrder) {
      const list = byType.get(t);
      if (list.length) { interleaved.push(list.shift()); added = true; }
    }
  }
  return interleaved;
}

// ---------------------------------------------------------------- 修复构造（真实执行 + 出厂门禁）

function anonIdGen(rand, prefix, used) {
  return () => {
    let s;
    do { s = `${prefix}_${Math.floor(rand() * 0xffff).toString(16).padStart(4, '0')}`; } while (used.has(s));
    used.add(s);
    return s;
  };
}

/**
 * 构造修复序列并在扰动状态上真实执行验证。
 * 返回 { transactions: [{request, response}], passed, modelOnlyRestored, fullRestored, finalModel }
 * 或 { passed: false, reason }。
 */
function buildAndVerifyRepair({ type, refParts, refCanonicalHash, pertModel, pertHash, pertInventory, part, probe, pair, newColor, taskId }) {
  // 参考态完整库存（canonical 口径）：全部实例 token consumed、备用 token available
  const refInventoryFull = pertInventory.map((t) => (t.spare
    ? { ...t }
    : { ...t, state: 'consumed', consumedBy: t.instanceId, consumedAt: 'transaction' }));
  const transactions = [];
  const runTx = (model, hash, inventory, actions) => {
    const { ctx } = makeCtx(model, hash, inventory, taskId);
    const request = { protocolVersion: '1.0.0', taskId, stateHash: hash, repairMode: true, actions };
    const response = applyActions(ctx, request, {});
    transactions.push({ request, response });
    if (!response.passed) return { ok: false, response };
    return { ok: true, model: response._workingModel, hash: response.apply.stateHashAfter, inventory: response._inventory, response };
  };

  if (type === 'missing_part' || type === 'misaligned' || type === 'reversed_orientation') {
    let model = pertModel, hash = pertHash, inventory = pertInventory;
    let probeNow = probe;
    if (type !== 'missing_part') {
      // 第 1 事务：detach 错装/反装件
      const r1 = runTx(model, hash, inventory, [{
        id: 'r-detach', op: 'detach',
        repair: { detachNodeId: part.id },
      }]);
      if (!r1.ok) return { passed: false, reason: `detach 拒绝：${r1.response.diagnostics?.[0]?.code ?? '?'}`, transactions };
      model = r1.model; hash = r1.hash; inventory = r1.inventory;
      if (type === 'reversed_orientation' || !probeNow) {
        // 反装件拆下后才枚举（拆后状态内容 = 参考态去件，candidateId 内容确定）
        probeNow = probeAttachCandidates({ modelMid: model, hashMid: hash, inventoryMid: inventory, part, refCanonicalHash, taskId: `${taskId}-probe` });
      }
    }
    // 第 2 事务：attach 正确候选（correct 组由真实重放判定）
    const correct = probeNow.correct;
    if (!correct.length) return { passed: false, reason: 'no-correct-candidate', transactions };
    const target = correct[0];
    const maxStep = Math.max(...model.parts.map((p) => p.step ?? 1));
    const r2 = runTx(model, hash, inventory, [{
      id: 'r-attach', op: 'attach_part',
      target: { partInstanceId: part.id },
      partId: part.part, color: part.color,
      candidateId: target.candidate.candidateId,
      candidateHash: target.candidate.candidateHash,
      candidateParentNodeId: target.candidate.parentNodeId,
      inventoryToken: inventory.find((t) => t.instanceId === part.id && t.state !== 'consumed')?.token
        ?? inventory.find((t) => t.partId === part.part && t.state !== 'consumed')?.token,
      step: maxStep + 1,
    }]);
    if (!r2.ok) return { passed: false, reason: `attach 拒绝：${r2.response.diagnostics?.[0]?.code ?? '?'}`, transactions };
    const finalCanonical = canonicalModelOnlyHash(flatParts(r2.model));
    const refCanonical = canonicalModelOnlyHash(refParts);
    return {
      passed: finalCanonical === refCanonical,
      reason: finalCanonical === refCanonical ? null : 'canonical-hash-mismatch',
      transactions,
      finalModel: r2.model,
      finalCanonicalHash: finalCanonical,
      probe: probeNow,
      fullRestored: canonicalFullHash(flatParts(r2.model), r2.inventory) === canonicalFullHash(refParts, refInventoryFull),
    };
  }

  if (type === 'wrong_color') {
    const r1 = runTx(pertModel, pertHash, pertInventory, [{
      id: 'r-replace', op: 'replace',
      target: { partInstanceId: part.id },
      repair: { replacePartId: part.part },
      color: part.color,
    }]);
    if (!r1.ok) return { passed: false, reason: `replace 拒绝：${r1.response.diagnostics?.[0]?.code ?? '?'}`, transactions };
    const finalCanonical = canonicalModelOnlyHash(flatParts(r1.model));
    return {
      passed: finalCanonical === refCanonicalHash,
      reason: finalCanonical === refCanonicalHash ? null : 'canonical-hash-mismatch',
      transactions, finalModel: r1.model, finalCanonicalHash: finalCanonical,
      fullRestored: canonicalFullHash(flatParts(r1.model), r1.inventory) === canonicalFullHash(refParts, refInventoryFull),
    };
  }

  if (type === 'left_right_swap') {
    const [a, b] = pair;
    const r1 = runTx(pertModel, pertHash, pertInventory, [
      { id: 'r-swap-a', op: 'replace', target: { partInstanceId: a.id }, repair: { replacePartId: a.part }, color: a.color },
      { id: 'r-swap-b', op: 'replace', target: { partInstanceId: b.id }, repair: { replacePartId: b.part }, color: b.color },
    ]);
    if (!r1.ok) return { passed: false, reason: `replace 拒绝：${r1.response.diagnostics?.[0]?.code ?? '?'}`, transactions };
    const finalCanonical = canonicalModelOnlyHash(flatParts(r1.model));
    return {
      passed: finalCanonical === refCanonicalHash,
      reason: finalCanonical === refCanonicalHash ? null : 'canonical-hash-mismatch',
      transactions, finalModel: r1.model, finalCanonicalHash: finalCanonical,
      fullRestored: canonicalFullHash(flatParts(r1.model), r1.inventory) === canonicalFullHash(refParts, refInventoryFull),
    };
  }

  return { passed: false, reason: 'unknown-type', transactions };
}

// ---------------------------------------------------------------- 实例处理

async function processFamily(spec, outDir, opts) {
  const width = opts.width;
  const height = opts.width;
  const views = spec.views.map((v, i) => ({ ...v, id: `v${i}` }));
  const famDir = path.join(outDir, 'families', spec.familyId);
  const imgDir = path.join(outDir, 'images', spec.familyId);
  fs.mkdirSync(famDir, { recursive: true });
  fs.mkdirSync(imgDir, { recursive: true });

  const samplesUS = [];
  const samplesRL = [];
  const stats = {
    familyId: spec.familyId, title: spec.title, instances: [], perturbations: 0,
    samples: 0, images: 0, errors: [], skipReasons: {},
  };
  const counters = { skip: (r) => { stats.skipReasons[r] = (stats.skipReasons[r] || 0) + 1; } };
  const seenDedup = new Set();
  const instanceCount = opts.instances ?? spec.instances;
  const renderCache = new Map();

  for (let ii = 0; ii < instanceCount; ii++) {
    const instanceId = `${spec.familyId}-i${String(ii + 1).padStart(2, '0')}`;
    const instDir = path.join(famDir, 'instances', instanceId);
    const instImgDir = path.join(imgDir, instanceId);
    fs.mkdirSync(instDir, { recursive: true });
    fs.mkdirSync(instImgDir, { recursive: true });

    const pal = PALETTES[PALETTE_LIST[ii % PALETTE_LIST.length]];
    const b = createBuilder({ catalog: CAT, meta: { name: instanceId, front: '+z' } });
    const rand = mulberry32(seedOf(`inst:${spec.familyId}:${instanceId}`));
    try {
      spec.build(b, rand, pal);
      b.assert();
    } catch (e) {
      stats.errors.push(`${instanceId}: 搭建失败 ${e.message.slice(0, 140)}`);
      continue;
    }
    const rawParts = flatParts(b.model());
    if (rawParts.some((p) => !CAT.parts[p.part])) { stats.errors.push(`${instanceId}: 目录外零件`); continue; }

    // —— 参考状态（规范化 + 0/0 门禁 + 落盘）——
    const refModel = canonicalFlat(rawParts, `${instanceId}-reference`);
    const refParts = flatParts(refModel);
    const refV = validateClean(refModel);
    if (!refV.ok) { stats.errors.push(`${instanceId}: 参考态校验不过 (${refV.errors[0]?.code ?? refV.warnings[0]?.code})`); continue; }
    const refInventory = makeInventoryTokens(instanceId, refParts);
    const refHashFull = fullHashOf(refModel, inventoryFor(refInventory, refParts.map((p) => p.id)));
    const refHashModelOnly = canonicalModelOnlyHash(refParts);
    const refCanonical = refHashModelOnly;

    const usedPartIds = [...new Set(refParts.map((p) => p.part))];
    const { assetLock, missing } = buildAssetLock(ASSET_INDEX, usedPartIds);
    if (missing.length) { stats.errors.push(`${instanceId}: 资产锁缺件 ${missing.join(',')}`); continue; }

    const stateDir = path.join(instDir, 'states');
    fs.mkdirSync(stateDir, { recursive: true });
    const refStatePath = path.join(stateDir, 'reference.brick.json');
    fs.writeFileSync(refStatePath, JSON.stringify({
      model: refModel, role: 'reference', instanceId,
      stateHash: refHashFull, modelOnlyStateHash: refHashModelOnly,
      inventory: inventoryFor(refInventory, refParts.map((p) => p.id)),
      validation: { ok: true, errors: 0, warnings: 0 },
    }, null, 2));

    // —— 相机（家族冻结视角，按实例 bbox 取景）——
    const bbox = modelBBoxParts(refParts);
    const camQ = (viewId) => cameraFor(bbox, views.find((v) => v.id === viewId), width, height);

    const renderOnce = async (key, model, viewId, labeled, labels) => {
      const ck = `${instanceId}|${key}|${viewId}|${labeled ? 'l' : 'u'}`;
      if (renderCache.has(ck)) return renderCache.get(ck);
      const q = camQ(viewId);
      const svg = renderSvg(model, q, labeled ? labels : null);
      const png = await svgToPng(svg);
      const sha = sha256(png);
      const file = path.join(instImgDir, `${key}-${viewId}-${labeled ? 'labeled' : 'plain'}-${sha.slice(0, 8)}.png`);
      if (!fs.existsSync(file)) fs.writeFileSync(file, png);
      const entry = { imagePath: path.relative(ROOT, file).replace(/\\/g, '/'), imageSha256: sha, camera: q };
      renderCache.set(ck, entry);
      stats.images += 1;
      return entry;
    };

    // —— 参考图（无标号，v0）——
    const refImgV0 = await renderOnce('ref', refModel, 'v0', false, null);

    // —— 扰动计划 ——
    let plans;
    try {
      plans = await buildPerturbationPlans({ family: spec, instanceId, refModel, refParts, palette: pal, rand, counters });
    } catch (e) {
      stats.errors.push(`${instanceId}: 扰动计划失败 ${e.message.slice(0, 140)}`);
      continue;
    }

    let pertIdx = 0;
    const instStats = { instanceId, parts: refParts.length, perturbations: 0, samples: 0 };
    for (const plan of plans) {
      if (instStats.perturbations >= opts.maxPerInstance) break;
      pertIdx += 1;
      const pTag = `p${String(pertIdx).padStart(2, '0')}`;
      const taskIdBase = `task-pert-${spec.familyId}-${instanceId}-${pTag}`;

      // —— 构造扰动状态 ——
      let perturbedParts = null;
      let pertMeta = {};
      if (plan.type === 'missing_part') {
        perturbedParts = refParts.filter((p) => p.id !== plan.part.id);
        pertMeta = { removedPartId: plan.part.id };
      } else if (plan.type === 'misaligned') {
        const wrong = pick(mulberry32(seedOf(`wrong:${taskIdBase}`)), plan.probe.wrong);
        perturbedParts = flatParts(wrong.response._workingModel);
        pertMeta = { movedPartId: plan.part.id, candidateId: wrong.candidate.candidateId };
      } else if (plan.type === 'left_right_swap') {
        const [a, bb] = plan.pair;
        perturbedParts = refParts.map((p) => {
          if (p.id === a.id) return { ...p, color: bb.color };
          if (p.id === bb.id) return { ...p, color: a.color };
          return p;
        });
        pertMeta = { swapped: [a.id, bb.id] };
      } else if (plan.type === 'wrong_color') {
        perturbedParts = refParts.map((p) => (p.id === plan.part.id ? { ...p, color: plan.newColor } : p));
        pertMeta = { coloredPartId: plan.part.id, fromColor: plan.part.color, toColor: plan.newColor };
      } else if (plan.type === 'reversed_orientation') {
        perturbedParts = refParts.map((p) => (p.id === plan.part.id ? { ...plan.flipped, at: [...plan.flipped.at] } : p));
        pertMeta = { flippedPartId: plan.part.id, fromRot: plan.part.rot ?? 0, toRot: plan.flipped.rot };
      }
      if (!perturbedParts) { counters.skip('no-perturbed-parts'); continue; }

      const pertModel = canonicalFlat(perturbedParts, `${instanceId}-${pTag}-${plan.type}`);
      const pertParts = flatParts(pertModel);
      const pertV = validateClean(pertModel);
      if (!pertV.ok) { counters.skip('perturbed-invalid'); continue; }
      const pertCanonical = canonicalModelOnlyHash(pertParts);
      if (pertCanonical === refCanonical && plan.type !== 'left_right_swap') { counters.skip('perturbed-identical'); continue; }
      if (pertCanonical === refCanonical) { counters.skip('perturbed-identical'); continue; }

      // —— 去重（familyId + perturbedStateHash + type）——
      const dedupKey = `${spec.familyId}|${pertCanonical}|${plan.type}`;
      if (seenDedup.has(dedupKey)) { counters.skip('dedup'); continue; }
      seenDedup.add(dedupKey);

      // —— diff 真值 + 分类 ——
      const diff = diffStructures(refParts, pertParts);
      const cls = classifyDiff(diff, CAT);
      if (!cls) { counters.skip('diff-unclassifiable'); continue; }

      // —— 扰动库存 + 落盘 ——
      const pertInventory = inventoryFor(refInventory, pertParts.map((p) => p.id));
      const pertHashFull = fullHashOf(pertModel, pertInventory);
      const pertStatePath = path.join(stateDir, `${pTag}-${plan.type}.brick.json`);
      fs.writeFileSync(pertStatePath, JSON.stringify({
        model: pertModel, role: 'perturbed', instanceId, perturbationType: plan.type,
        pertMeta, stateHash: pertHashFull, modelOnlyStateHash: pertCanonical,
        inventory: pertInventory,
        validation: { ok: true, errors: 0, warnings: 0 },
        derivation: plan.type === 'missing_part'
          ? 'reference-minus-part（可拆件，validate 0/0）'
          : plan.type === 'misaligned'
            ? 'engine enumerateCandidates 真实落位（wrong-but-plausible）'
            : plan.type === 'reversed_orientation'
              ? 'rot+180（碰撞盒改变 + validate 0/0）'
              : plan.type === 'left_right_swap'
                ? '镜像同件号异色对颜色交换（布局不变）'
                : '同零件目录内换色（布局不变）',
      }, null, 2));

      // —— 修复构造 + 出厂门禁（真实执行）——
      const repair = buildAndVerifyRepair({
        type: plan.type, refParts, refCanonicalHash: refCanonical,
        pertModel, pertHash: pertHashFull, pertInventory,
        part: plan.part, probe: plan.probe, pair: plan.pair, newColor: plan.newColor,
        taskId: `${taskIdBase}-repair`,
      });
      if (!repair.passed) {
        counters.skip(`repair-failed:${plan.type}`);
        fs.rmSync(pertStatePath, { force: true });
        continue;
      }

      // —— 渲染：扰动 labeled v0 + plain v1（参考图已备）——
      const hashForRender = canonicalModelOnlyHash(pertParts);
      const rs = renderStateSafe(pertModel, camQ('v0'), hashForRender);
      const badgeLabels = rs && rs.ok ? rs.labels.map((l) => ({ tag: l.tag, pixel: l.pixel })) : null;
      if (!badgeLabels) { counters.skip('no-renderstate'); fs.rmSync(pertStatePath, { force: true }); continue; }
      const pertImgL0 = await renderOnce(`${pTag}-${plan.type}`, pertModel, 'v0', true, badgeLabels);
      const pertImgP1 = await renderOnce(`${pTag}-${plan.type}`, pertModel, 'v1', false, null);

      // —— 匿名化 ——
      const anonRand = mulberry32(seedOf(`anon:${taskIdBase}`));
      const usedAnon = new Set();
      const genPart = anonIdGen(anonRand, 'prt', usedAnon);
      const genTok = anonIdGen(anonRand, 'tok', usedAnon);
      const genCand = anonIdGen(anonRand, 'cand', usedAnon);
      const faultyIds = cls.faulty;
      const partAnon = {};
      for (const id of faultyIds) partAnon[id] = genPart();
      for (const it of pertParts) if (!partAnon[it.id]) partAnon[it.id] = genPart();
      const tokAnon = {};
      for (const t of pertInventory) tokAnon[t.token] = genTok();
      const candAnon = {};

      // —— 公共候选集 ——
      let candidatesItems = [];
      let primaryAction = null;
      let correctiveSequence = [];
      let equivalentCandidates = [];

      const publicStructureCandidates = pertParts.map((p) => ({
        candidateId: partAnon[p.id],
        parentInstanceId: 'none',
        parentConnectorId: 'none',
        childPartId: p.part,
        childConnectorId: 'none',
        orientationId: orientationIdOf(p.up ?? '+y', p.rot ?? 0) ?? 0,
        colorId: p.color,
        at: p.at,
      }));

      if (plan.type === 'missing_part' || plan.type === 'misaligned' || plan.type === 'reversed_orientation') {
        // 修复候选：detach（若需要）+ attach 候选（correct + 干扰，全部真实执行过）
        let detachAnon = null;
        if (plan.type !== 'missing_part') {
          detachAnon = genCand();
          candidatesItems.push({
            candidateId: detachAnon, op: 'detach',
            parentInstanceId: partAnon[plan.part.id],
            parentConnectorId: 'none',
            childPartId: plan.part.part,
            childConnectorId: 'none',
            orientationId: orientationIdOf(plan.part.up ?? '+y', plan.part.rot ?? 0) ?? 0,
          });
          correctiveSequence.push({ op: 'detach', selectedCandidateId: detachAnon });
          primaryAction = { op: 'detach', selectedCandidateId: detachAnon };
        }
        const repairProbe = repair.probe ?? plan.probe;
        const correctRuns = repairProbe.correct;
        const wrongRuns = repairProbe.wrong.filter((w) => plan.type !== 'misaligned' || w.candidate.candidateId !== pertMeta.candidateId);
        const distractors = seededShuffle(wrongRuns, mulberry32(seedOf(`distractor:${taskIdBase}`))).slice(0, 3);
        // 等价组代表（correct[0] 之外的 correct 组成员，最多带 2 个）全部进入公共候选集
        const equivExtras = correctRuns.slice(1, 3);
        const attachAnon = genCand();
        candAnon[correctRuns[0].candidate.candidateId] = attachAnon;
        const mkAttachItem = (run, anon) => ({
          candidateId: anon, op: 'attach_part',
          parentInstanceId: partAnon[run.candidate.parentNodeId] ?? 'none',
          parentConnectorId: run.candidate.parentConnectorId,
          childPartId: run.candidate.childPartId,
          childConnectorId: run.candidate.childConnectorId,
          orientationId: run.candidate.orientationId,
          spinDeg: run.candidate.spinDeg,
          snot: run.candidate.snot,
          candidateHash: run.candidate.candidateHash,
        });
        candidatesItems.push(mkAttachItem(correctRuns[0], attachAnon));
        for (const eq of equivExtras) {
          const anon = genCand();
          candAnon[eq.candidate.candidateId] = anon;
          candidatesItems.push(mkAttachItem(eq, anon));
        }
        correctiveSequence.push({ op: 'attach_part', selectedCandidateId: attachAnon, consumedTokenId: tokAnon[repair.transactions[repair.transactions.length - 1].request.actions[0].inventoryToken] ?? null });
        if (!primaryAction) primaryAction = { op: 'attach_part', selectedCandidateId: attachAnon, consumedTokenId: correctiveSequence[correctiveSequence.length - 1].consumedTokenId };
        for (const w of distractors) {
          const anon = genCand();
          candAnon[w.candidate.candidateId] = anon;
          candidatesItems.push(mkAttachItem(w, anon));
        }
        // 等价组：真实重放后 canonical 哈希 == 参考态的全部已测候选（全部在公共候选集内）
        equivalentCandidates = repairProbe.correct
          .filter((r) => candAnon[r.candidate.candidateId])
          .map((r) => candAnon[r.candidate.candidateId]);
      } else {
        // replace 候选：正确换色 + 干扰色（真实执行过的收据）
        const mkReplace = (targetPart, color, anon) => ({
          candidateId: anon, op: 'replace',
          parentInstanceId: partAnon[targetPart.id],
          parentConnectorId: 'none',
          childPartId: targetPart.part,
          childConnectorId: 'none',
          orientationId: orientationIdOf(targetPart.up ?? '+y', targetPart.rot ?? 0) ?? 0,
          replaceColor: color,
        });
        const replaceTargets = plan.type === 'wrong_color' ? [plan.part] : plan.pair;
        const first = replaceTargets[0];
        const correctAnon = genCand();
        candidatesItems.push(mkReplace(first, first.color, correctAnon));
        correctiveSequence.push({ op: 'replace', selectedCandidateId: correctAnon });
        primaryAction = { op: 'replace', selectedCandidateId: correctAnon };
        if (plan.type === 'left_right_swap') {
          const secondAnon = genCand();
          candidatesItems.push(mkReplace(plan.pair[1], plan.pair[1].color, secondAnon));
          correctiveSequence.push({ op: 'replace', selectedCandidateId: secondAnon });
        }
        // 干扰：同零件其他颜色（真实执行 → passed 但 canonical 哈希不同，收据入候选项）
        const dr = mulberry32(seedOf(`rdistract:${taskIdBase}`));
        const altPool = seededShuffle(altColorsFor(first.color, pal), dr).filter((c) => c !== pertParts.find((p) => p.id === first.id).color).slice(0, 2);
        for (const c of altPool) {
          const probeTx = buildAndVerifyRepair({
            type: 'wrong_color', refParts, refCanonicalHash: refCanonical,
            pertModel, pertHash: pertHashFull, pertInventory,
            part: { ...first, color: c }, probe: null, pair: null, newColor: c,
            taskId: `${taskIdBase}-distract`,
          });
          const anon = genCand();
          candidatesItems.push({
            ...mkReplace(first, c, anon),
            receipt: {
              executed: true,
              passed: Boolean(probeTx.passed),
              restoresReference: Boolean(probeTx.passed && probeTx.finalCanonicalHash === refCanonical),
              diagCode: probeTx.transactions.length ? (probeTx.transactions[0].response.passed ? null : probeTx.transactions[0].response.diagnostics?.[0]?.code ?? 'rejected') : 'not-executed',
            },
          });
        }
        equivalentCandidates = [correctAnon, ...(plan.type === 'left_right_swap' ? [candidatesItems[1].candidateId] : [])];
      }

      // 候选乱序（无 isTarget 字段）
      candidatesItems = seededShuffle(candidatesItems, mulberry32(seedOf(`order:${taskIdBase}`)));

      // —— 修复收据（真实执行过的 transactions，脱去 _workingModel）——
      const receipts = repair.transactions.map(({ request, response }) => ({
        stateHashIn: request.stateHash,
        passed: response.passed,
        stateHashAfter: response.passed ? response.apply.stateHashAfter : null,
        diagCode: response.passed ? null : (response.diagnostics?.[0]?.code ?? 'rejected'),
        actionOps: request.actions.map((a) => a.op),
      }));

      // —— 两个 taskType 的样本 ——
      const mkSample = (taskType, sampleId) => {
        const isUS = taskType === 'understand_structure';
        return {
          sampleId,
          protocolVersion: '1.0',
          taskType,
          provenance: {
            sourceFamilyId: spec.familyId,
            sourceModelId: instanceId,
            sourceRevision: 'r1',
            sourceKind: 'synthetic_assembly',
            split: 'train',
            difficulty: spec.difficulty,
            generator: 'tools/brickvlm/gen_perturbation_dataset.mjs',
          },
          assetLock: {
            ...assetLock,
            catalogVersion: ASSET_INDEX.version,
            engineRevision: 'actions-v1@1.0.0',
          },
          engineRevision: 'actions-v1@1.0.0',
          renderRevision: 'render-state@1.0.0',
          renderMode: 'collision_proxy_svg_v1',
          catalogIndexSha256: CATALOG_INDEX_SHA,
          stateRef: {
            taskId: `${taskIdBase}-${isUS ? 'us' : 'rl'}`,
            stepNumber: 0,
            stateHash: pertHashFull,
          },
          stateRefs: [
            { role: 'reference', stateHash: refHashFull, modelOnlyStateHash: refHashModelOnly, brickPath: path.relative(ROOT, refStatePath).replace(/\\/g, '/'), partsCount: refParts.length, validationOk: true },
            { role: 'perturbed', stateHash: pertHashFull, modelOnlyStateHash: pertCanonical, brickPath: path.relative(ROOT, pertStatePath).replace(/\\/g, '/'), partsCount: pertParts.length, validationOk: true },
          ],
          camera: camQ('v0'),
          views: { v0: views[0], v1: views[1] },
          images: isUS
            ? [
              { role: 'current_rendered_state', imagePath: pertImgL0.imagePath, imageSha256: pertImgL0.imageSha256, labeled: true, stateHash: pertHashFull, cameraPose: { azimuth: views[0].az, elevation: views[0].el } },
              { role: 'auxiliary_view', imagePath: pertImgP1.imagePath, imageSha256: pertImgP1.imageSha256, labeled: false, stateHash: pertHashFull, cameraPose: { azimuth: views[1].az, elevation: views[1].el } },
              { role: 'auxiliary_view', imagePath: refImgV0.imagePath, imageSha256: refImgV0.imageSha256, labeled: false, stateHash: refHashFull, cameraPose: { azimuth: views[0].az, elevation: views[0].el } },
            ]
            : [
              { role: 'current_rendered_state', imagePath: pertImgL0.imagePath, imageSha256: pertImgL0.imageSha256, labeled: true, stateHash: pertHashFull, cameraPose: { azimuth: views[0].az, elevation: views[0].el } },
              { role: 'auxiliary_view', imagePath: refImgV0.imagePath, imageSha256: refImgV0.imageSha256, labeled: false, stateHash: refHashFull, cameraPose: { azimuth: views[0].az, elevation: views[0].el } },
              { role: 'repair_diagnosis', imagePath: pertImgP1.imagePath, imageSha256: pertImgP1.imageSha256, labeled: false, stateHash: pertHashFull, cameraPose: { azimuth: views[1].az, elevation: views[1].el } },
            ],
          interfaceMap: {
            version: 'render-state@1.0.0',
            stateHash: hashForRender,
            stateHashScope: 'model-only',
            camera: camQ('v0'),
            labels: rs.labels.map((l) => ({
              tag: l.tag, pixel: l.pixel, partInstanceId: partAnon[l.nodeId] ?? l.nodeId,
              connectorId: l.connectorId, stableConnectorId: l.connectorId, type: l.connectorType, dir: l.dir, worldPos: l.worldPos,
              aliases: l.aliases,
            })),
            enumerationComplete: rs.enumerationComplete,
            truncated: rs.truncated,
            note: '标号对所有接口同款式（数字序号），不携带任何错误位置信息',
          },
          inventory: pertInventory.map((t) => ({
            tokenId: tokAnon[t.token], partId: t.partId, colorId: t.colorId, state: t.state,
          })),
          candidates: {
            enumerationComplete: true,
            truncated: false,
            items: isUS ? publicStructureCandidates : candidatesItems,
          },
          target: isUS
            ? {
              primaryAction: { op: 'abstain', abstainReason: 'understand_structure 报告结构诊断，不执行搭建动作' },
              equivalentCandidates: [],
              structureDiagnosis: {
                hasStructuralError: true,
                errorType: cls.errorType,
                faultyPartInstances: cls.faulty.map((id) => partAnon[id]),
                issues: cls.issues.map((iss) => ({
                  partRef: partAnon[iss.partId],
                  issueType: iss.issueType,
                  expected: iss.expected,
                  actual: iss.actual,
                })),
              },
            }
            : {
              primaryAction,
              equivalentCandidates,
              structureDiagnosis: {
                hasStructuralError: true,
                errorType: cls.errorType,
                faultyPartInstances: cls.faulty.map((id) => partAnon[id]),
                issues: cls.issues.map((iss) => ({
                  partRef: partAnon[iss.partId],
                  issueType: iss.issueType,
                  expected: iss.expected,
                  actual: iss.actual,
                })),
              },
              correctiveSequence,
            },
          verification: {
            isGeometricallyLegal: true,
            hasManualGroundTruth: false,
            groundTruthSource: 'structural_diff_reference_vs_perturbed',
            verifiedBy: 'src/core/actions-v1/apply.js + src/core/core.js validate',
            evidenceNote: '扰动状态 validate 0 errors / 0 warnings；真值由参考态与扰动态逐实例结构 diff 导出；修复序列在扰动状态上经 applyActions 真实重放，canonical model-only stateHash 恢复为参考态',
            referenceValidation: { ok: true, errors: 0, warnings: 0 },
            perturbedValidation: { ok: true, errors: 0, warnings: 0 },
            diffSummary: { removed: diff.removed.length, added: diff.added.length, changed: diff.changed.length },
            repairVerification: {
              passed: true,
              method: 'real-applyActions-replay-on-perturbed-state',
              transactions: receipts.length,
              modelOnlyStateHashRestored: repair.finalCanonicalHash === refCanonical,
              fullStateHashRestored: repair.fullRestored ?? null,
              finalCanonicalModelOnlyHash: repair.finalCanonicalHash,
              receipts,
            },
            labels: {
              note: 'ground-truth 标签区（真实引擎 ID 与扰动元数据；不属于模型输入）',
              partRefMap: partAnon,
              tokenMap: tokAnon,
              candidateMap: candAnon,
              perturbationType: plan.type,
              pertMeta,
              repairPlan: {
                transactions: repair.transactions.map(({ request }) => request),
              },
            },
          },
        };
      };

      const sampleUS = mkSample('understand_structure', `smp-pert-${spec.familyId.replace(/^fam-/, '')}-${instanceId.replace(/^[^-]+-/, '')}-${pTag}-us`);
      const sampleRL = mkSample('repair_local', `smp-pert-${spec.familyId.replace(/^fam-/, '')}-${instanceId.replace(/^[^-]+-/, '')}-${pTag}-rl`);
      samplesUS.push(sampleUS);
      samplesRL.push(sampleRL);
      instStats.perturbations += 1;
      instStats.samples += 2;
      stats.perturbations += 1;
      stats.samples += 2;
    }

    stats.instances.push(instStats);
  }

  fs.writeFileSync(path.join(famDir, 'samples.understand_structure.jsonl'), samplesUS.map((s) => JSON.stringify(s)).join('\n') + (samplesUS.length ? '\n' : ''));
  fs.writeFileSync(path.join(famDir, 'samples.repair_local.jsonl'), samplesRL.map((s) => JSON.stringify(s)).join('\n') + (samplesRL.length ? '\n' : ''));
  stats.samplesUS = samplesUS.length;
  stats.samplesRL = samplesRL.length;
  return { stats, samplesUS, samplesRL };
}

// ---------------------------------------------------------------- 独立复核：从落盘状态重放全部修复

function canonicalHashOfStateFile(stateFile) {
  return canonicalModelOnlyHash(flatParts(stateFile.model));
}

function runVerify(outDir, limitAll = true) {
  const famDirs = fs.readdirSync(path.join(outDir, 'families')).sort();
  const all = [];
  for (const fid of famDirs) {
    const f = path.join(outDir, 'families', fid, 'samples.repair_local.jsonl');
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (line.trim()) all.push(JSON.parse(line));
    }
  }
  let passed = 0;
  const failures = [];
  for (const s of all) {
    try {
      const pertState = JSON.parse(fs.readFileSync(path.join(ROOT, s.stateRefs[1].brickPath), 'utf8'));
      const refState = JSON.parse(fs.readFileSync(path.join(ROOT, s.stateRefs[0].brickPath), 'utf8'));
      if (pertState.validation?.ok !== true) throw new Error('扰动状态校验标记非 0/0');
      if (refState.modelOnlyStateHash !== s.stateRefs[0].modelOnlyStateHash) throw new Error('参考态哈希不一致');
      // 重算扰动状态哈希
      const recomputed = canonicalModelOnlyHash(flatParts(pertState.model));
      if (recomputed !== s.stateRefs[1].modelOnlyStateHash) throw new Error('扰动状态重算哈希不一致');
      const requests = s.verification.labels.repairPlan.transactions;
      let model = pertState.model;
      let hash = pertState.stateHash;
      let inventory = pertState.inventory;
      for (const request of requests) {
        if (request.stateHash !== hash) throw new Error(`事务 stateHash 链断裂: ${request.stateHash} vs ${hash}`);
        const { ctx } = makeCtx(model, hash, inventory, request.taskId);
        const res = applyActions(ctx, request, {});
        if (!res.passed) throw new Error('重放未通过: ' + (res.diagnostics?.[0]?.code ?? '?'));
        model = res._workingModel;
        hash = res.apply.stateHashAfter;
        inventory = res._inventory;
      }
      const finalCanonical = canonicalModelOnlyHash(flatParts(model));
      if (finalCanonical !== refState.modelOnlyStateHash) throw new Error('修复后 canonical 哈希 != 参考态');
      const rv = validate(model, CAT);
      if (rv.errors.length > 0) throw new Error('修复后模型仍有校验错误');
      passed += 1;
    } catch (e) {
      failures.push({ sampleId: s.sampleId, error: e.message.slice(0, 200) });
    }
  }
  const report = {
    checked: all.length,
    passed,
    failed: failures.length,
    failures: failures.slice(0, 20),
    method: '从落盘扰动状态（model+inventory+stateHash）出发，逐事务真实 applyActions 重放修复序列；修复后 canonical model-only stateHash 必须等于参考态',
    checkedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(outDir, 'repair-verification.json'), JSON.stringify(report, null, 2));
  return report;
}

// ---------------------------------------------------------------- 渲染基准

async function benchmark(outDir, width) {
  const defs = familyRegistry().defs;
  const pal = PALETTES.castle;
  const b = createBuilder({ catalog: CAT, meta: { name: 'bench', front: '+z' } });
  defs[0].build(b, mulberry32(1), pal);
  b.assert();
  const parts = flatParts(b.model());
  const model = canonicalFlat(parts, 'bench');
  const bbox = modelBBoxParts(flatParts(model));
  const camQ = { ...cameraFor(bbox, { id: 'bench', az: 30, el: 14 }, width, width), viewport: { x: 0, y: 0, width, height: width } };
  const t0 = Date.now();
  let bytes = 0;
  for (let i = 0; i < 10; i++) {
    const png = await svgToPng(renderSvg(model, camQ, i % 2 === 0 ? [{ tag: '1', pixel: [40, 40] }, { tag: '2', pixel: [90, 60] }] : null));
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

// ---------------------------------------------------------------- 主流程

function allSpecs() {
  return familyRegistry().defs.map((d) => ({ ...d }));
}

async function runWorker(shardId, shardCount, outDir, onlyList, width, instances, maxPerInstance) {
  const specs = allSpecs()
    .filter((s) => !onlyList || onlyList.includes(s.familyId))
    .filter((_, i) => i % shardCount === shardId);
  const results = [];
  for (const spec of specs) {
    process.stdout.write(`[worker ${shardId}] family ${spec.familyId} ...\n`);
    const { stats } = await processFamily(spec, outDir, { width, instances, maxPerInstance });
    results.push(stats);
    process.stdout.write(`[worker ${shardId}] family ${spec.familyId} done: pert=${stats.perturbations} samples=${stats.samples} images=${stats.images} skips=${JSON.stringify(stats.skipReasons)} errors=${stats.errors.length}\n`);
    if (stats.errors.length) process.stdout.write(`  errors: ${stats.errors.slice(0, 5).join(' | ')}\n`);
  }
  fs.writeFileSync(path.join(outDir, `.shard-${shardId}.json`), JSON.stringify({ shardId, families: results }, null, 2));
  return results;
}

async function checkFamilies() {
  const specs = allSpecs();
  let bad = 0;
  for (const spec of specs) {
    for (let pi = 0; pi < PALETTE_LIST.length; pi++) {
      const pal = PALETTES[PALETTE_LIST[pi]];
      const instanceId = `${spec.familyId}-check-p${pi}`;
      const b = createBuilder({ catalog: CAT, meta: { name: instanceId, front: '+z' } });
      const rand = mulberry32(seedOf(`inst:${spec.familyId}:${instanceId}`));
      try {
        spec.build(b, rand, pal);
        b.assert();
        const refModel = canonicalFlat(flatParts(b.model()), instanceId);
        const v = validateClean(refModel);
        if (!v.ok) throw new Error(`规范化后校验不过: ${v.errors[0]?.code ?? v.warnings[0]?.code}`);
      } catch (e) {
        bad += 1;
        console.log(`FAIL ${instanceId}: ${e.message.slice(0, 160)}`);
      }
    }
    console.log(`ok ${spec.familyId} (8 palettes checked)`);
  }
  if (bad) process.exit(2);
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : dflt;
  };
  const has = (name) => args.includes(`--${name}`);

  if (has('check-families')) { await checkFamilies(); return; }

  const outDir = path.resolve(ROOT, flag('out', 'out/prd-v2/run-20261026-c/C/data/perturbation'));
  fs.mkdirSync(outDir, { recursive: true });

  if (has('verify')) {
    const report = runVerify(outDir);
    console.log(JSON.stringify(report, null, 2));
    if (report.failed > 0) process.exit(2);
    return;
  }

  const width = Number(flag('width', '512'));
  const instances = Number(flag('instances', '0')) || null;
  const maxPerInstance = Number(flag('max-per-instance', '7'));

  if (has('shard')) {
    await runWorker(Number(flag('shard', '0')), Number(flag('shard-count', '1')), outDir, null, width, instances, maxPerInstance);
    return;
  }

  const bench = await benchmark(outDir, width);
  process.stdout.write(`[benchmark] ${bench.msPerRender} ms/render, ~${bench.projectedImagesPerHour} images/h\n`);

  const onlyList = has('only') ? String(flag('only', '')).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const workers = Number(flag('workers', '6'));
  const generatedAt = new Date().toISOString();

  if (workers <= 1 || onlyList) {
    const specs = allSpecs().filter((s) => !onlyList || onlyList.includes(s.familyId));
    for (const spec of specs) {
      process.stdout.write(`[worker 0] family ${spec.familyId} ...\n`);
      const { stats } = await processFamily(spec, outDir, { width, instances, maxPerInstance });
      process.stdout.write(`[worker 0] family ${spec.familyId} done: pert=${stats.perturbations} samples=${stats.samples} images=${stats.images} errors=${stats.errors.length}\n`);
      if (stats.errors.length) process.stdout.write(`  errors: ${stats.errors.slice(0, 8).join(' | ')}\n`);
    }
  } else {
    const results = await Promise.all(
      Array.from({ length: workers }, (_, i) => new Promise((resolve) => {
        const child = spawn(process.execPath, [__filename, '--out', outDir, '--shard', String(i), '--shard-count', String(workers), '--width', String(width),
          ...(instances ? ['--instances', String(instances)] : []), '--max-per-instance', String(maxPerInstance)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d) => process.stdout.write(d));
        child.stderr.on('data', (d) => process.stderr.write(d));
        child.on('exit', (code) => resolve({ shard: i, code }));
      })),
    );
    const bad = results.filter((r) => r.code !== 0);
    if (bad.length) process.stdout.write(`[workers] ${bad.length} 个分片失败: ${bad.map((x) => `shard${x.shard}#${x.code}`).join(',')}\n`);
  }

  if (onlyList) {
    process.stdout.write(`[done] only-mode: ${onlyList.join(',')}\n`);
    return;
  }

  // —— 汇总 manifest ——
  const famDirs = fs.readdirSync(path.join(outDir, 'families')).sort();
  const countsPerFamily = {};
  const countsByTaskType = { understand_structure: 0, repair_local: 0 };
  const countsByType = {};
  let totalSamples = 0;
  let totalPerturbations = 0;
  let imagesCount = 0;
  const skipReasons = {};
  const errors = [];
  for (const fid of famDirs) {
    let nUS = 0, nRL = 0;
    const fUS = path.join(outDir, 'families', fid, 'samples.understand_structure.jsonl');
    const fRL = path.join(outDir, 'families', fid, 'samples.repair_local.jsonl');
    if (fs.existsSync(fUS)) {
      for (const line of fs.readFileSync(fUS, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        nUS += 1;
      }
    }
    if (fs.existsSync(fRL)) {
      for (const line of fs.readFileSync(fRL, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        nRL += 1;
        const t = JSON.parse(line).verification.labels.perturbationType;
        countsByType[t] = (countsByType[t] || 0) + 1; // 每扰动恰 1 条 repair_local 样本 → 扰动级计数
      }
    }
    let imgs = 0;
    const imgRoot = path.join(outDir, 'images', fid);
    if (fs.existsSync(imgRoot)) {
      for (const d of fs.readdirSync(imgRoot)) {
        imgs += fs.readdirSync(path.join(imgRoot, d)).filter((x) => x.endsWith('.png')).length;
      }
    }
    countsPerFamily[fid] = { perturbations: nRL, samples: nUS + nRL, understand_structure: nUS, repair_local: nRL, images: imgs };
    countsByTaskType.understand_structure += nUS;
    countsByTaskType.repair_local += nRL;
    totalSamples += nUS + nRL;
    totalPerturbations += nRL;
    imagesCount += imgs;
    const shardFiles = fs.readdirSync(outDir).filter((f) => f.startsWith('.shard-'));
    for (const sf of shardFiles) {
      try {
        const shard = JSON.parse(fs.readFileSync(path.join(outDir, sf), 'utf8'));
        for (const fam of shard.families) {
          if (fam.familyId !== fid) continue;
          for (const [k, v] of Object.entries(fam.skipReasons || {})) skipReasons[k] = (skipReasons[k] || 0) + v;
          for (const e of fam.errors || []) errors.push(e);
        }
      } catch { /* shard 文件缺失不阻塞汇总 */ }
    }
  }

  const replay = runVerify(outDir);

  const manifest = {
    generatedAt,
    generatorSha256: sha256(fs.readFileSync(__filename)),
    cmd: `node tools/brickvlm/gen_perturbation_dataset.mjs --out ${path.relative(ROOT, outDir).replace(/\\/g, '/')} --workers ${workers} --width ${width} --max-per-instance ${maxPerInstance}`,
    catalogIndexHash: CATALOG_INDEX_SHA,
    assetLockProfileId: ASSET_INDEX.profileId,
    assetLockIndexVersion: ASSET_INDEX.version,
    countsPerFamily,
    countsByTaskType,
    countsByPerturbationType: countsByType,    totalPerturbations,
    totalSamples,
    dedupRule: 'familyId + canonical model-only stateHash(perturbed) + perturbationType',
    imagesCount,
    render: {
      resolution: { width, height: width },
      renderer: 'svg->sharp CPU (collision_proxy_svg_v1)，纯 CPU 无 GPU',
      benchmark: bench,
      cameraContract: 'render-state@1.0.0 (perspective fovY 30, explicit target/distance/viewport, pixelOrigin top-left)',
      setOfMark: '中立数字接口标号（renderState 全接口同款式），参考图无标号；标号不含任何错误位置信息',
    },
    repairVerification: { checked: replay.checked, passed: replay.passed, failed: replay.failed, reportPath: path.relative(ROOT, path.join(outDir, 'repair-verification.json')).replace(/\\/g, '/') },
    rules: {
      referenceStates: 'createBuilder 程序化搭建，canonicalFlat（topo 步号 + id 排序），validate 0 errors / 0 warnings',
      perturbations: 'missing_part=移除可拆件(拆后0/0)；misaligned=engine enumerateCandidates 真实落位(canonical哈希!=参考, validate 0/0)；left_right_swap=镜像同件号异色对颜色交换(包围盒对称面判定)；wrong_color=目录内可见换色；reversed_orientation=rot+180(碰撞盒必须改变+validate 0/0)',
      groundTruth: '真值唯一来源为参考态与扰动态逐实例结构 diff（件号/颜色/位置/姿态）；issueType 由 diff 模式分类，不读扰动公式',
      repairGate: '修复序列（detach/attach_part/replace）在扰动状态上经 applyActions(repairMode:true) 逐事务真实执行；出厂门禁=修复后 canonical model-only stateHash == 参考态，100% 通过才产出；replace 路径库存备用 token 使 full stateHash 不参与门禁（canonical 哈希为权威门禁）',
      engineCoordinates: '全部坐标来自引擎（enumerateCandidates/applyActions/引擎放置零件的 rot 翻转），无手算小数坐标',
      anonymity: '公开样本实例引用=随机 prt_xxxx、库存 token=随机 tok_xxxx、候选=随机 cand_xxxx + 乱序 + 无 isTarget；真实引擎 ID 与扰动类型只在 verification.labels（ground-truth 标签区）',
      splitNote: '全部样本 split=train 占位；按模型族的 train/holdout 划分与防泄漏在 C1-5 执行',
    },
    skipReasons,
    errors: errors.slice(0, 40),
    sampleSchemaRef: 'docs/prd-v2/PRD.md §10.4 数据样本契约 C3 + docs/prd-v2/implementation-C/contracts/dataset.schema.json（contracts-1.0 冻结版，datasetSchemaVersion=1.0，样本 protocolVersion 按冻结 const 写 "1.0"；样本内嵌 actionRequest 为动作协议 1.0.0）',
    protocolVersion: '1.0.0',
    taskTypes: ['understand_structure', 'repair_local'],
    forbiddenParts: ['60239'],
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  process.stdout.write(`[manifest] perturbations=${totalPerturbations} totalSamples=${totalSamples} images=${imagesCount} repairVerify=${replay.passed}/${replay.checked}\n`);
  if (replay.failed > 0) process.exit(2);
  if (countsByTaskType.understand_structure < 400 || countsByTaskType.repair_local < 400 || countsByTaskType.repair_local < 200) {
    process.stdout.write(`[warn] 样本量未达目标：US=${countsByTaskType.understand_structure} RL=${countsByTaskType.repair_local}\n`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  main().catch((e) => { console.error('生成失败:', e); process.exit(1); });
}
