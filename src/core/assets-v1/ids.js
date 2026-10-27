// 稳定接口 ID（ST-03）：ID 由接口的语义位置（类型 + 局部 LDU 坐标）生成，
// 与 core.partConnectors 的数组下标完全解耦。重排数组不会改变 ID 含义；
// 旧 stud/receptor 数字索引通过 legacyIndex 固定映射适配，映射随本目录版本冻结。
//
// 旧语义回顾（core.js partConnectors）：
//   studs[]      = 顶凸点 / 侧凸点 / 把柄 / 插销 / 轮辋 / 人仔插柱
//   receptors[]  = 底孔 / 夹口 / 销孔 / 轴孔 / 轮胎胎孔 / 人仔插孔
// 两者都是数组，索引随零件几何与代码顺序变化 → 不能当权威 ID。

import { PLATE } from '../core.js';
import { ORIENTATIONS } from '../actions-v1/orientations.js';

/** 1 格 = 20 LDU；1 片 = 8 LDU（core 内部 y 的「片」单位与 LDU 的换算） */
export const LDU_PER_STUD = 20;
export const LDU_PER_PLATE = 8;
export const LDU_PER_BRICK = 24;

/** core 的 [x格, y片, z格] → LDU [x, y, z]，四舍五入到 1e-6 LDU */
export function gridToLdu(posStud) {
  const r6 = (v) => Math.round(v * 1e6) / 1e6 || 0;
  return [r6(posStud[0] * LDU_PER_STUD), r6(posStud[1] * LDU_PER_PLATE), r6(posStud[2] * LDU_PER_STUD)];
}

/** LDU → core 的 [x格, y片, z格] */
export function lduToGrid(ldu) {
  const r6 = (v) => Math.round(v * 1e6) / 1e6 || 0;
  return [r6(ldu[0] / LDU_PER_STUD), r6(ldu[1] / LDU_PER_PLATE), r6(ldu[2] / LDU_PER_STUD)];
}

const MIL = 1000;   // ID 用 1/1000 LDU 的整数刻度，避免小数点与负零

/** LDU 分量 → ID 片段的整数刻度（-0 归一为 0；负数用 n 前缀，避免 `--` 造成的解析歧义） */
function tick(v) {
  const n = Math.round(v * MIL);
  if (n === 0) return '0';
  return n < 0 ? `n${-n}` : String(n);
}

/**
 * 稳定接口 ID。
 * 形如 `stud-0-24000-0`（类型 + 局部 LDU x/y/z 的千分位刻度），
 * 侧凸点/把柄等再带一个面标记：`bar-z-0-4000-11000`。
 *
 * @param {string} type 连接类型（stud / antistud / bar / clip / pin / hole / axle / rim / tyre / minifig-peg / minifig-socket）
 * @param {number[]} translationLdu 接口在零件局部坐标中的位置（LDU）
 * @param {object} [extra] { face?: '+x'|…, role?: 'male'|'female' }
 */
export function makeConnectorId(type, translationLdu, extra = {}) {
  const parts = [sanitizeType(type)];
  if (extra.face) parts.push(extra.face.replace('+', 'p').replace('-', 'n'));
  parts.push(tick(translationLdu[0]), tick(translationLdu[1]), tick(translationLdu[2]));
  return parts.join('-');
}

function sanitizeType(t) {
  return String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * 旧数组下标 → 稳定 ID 的固定映射。
 * 记录的是「生成本资产目录时」的数组顺序；即使将来 partConnectors 顺序变化，
 * 用这份映射仍能找回同一物理接口（ST-03 的旧索引兼容）。
 */
export function makeLegacyIndex(collection, index) {
  return { collection, index };
}

/** core 连接器 kind → 契约 type（kind 是 core 内部名，type 是跨语言协议名） */
const KIND_TO_TYPE = {
  top: 'stud',
  side: 'stud',
  bar: 'bar',
  pin: 'pin',
  antistud: 'antistud',
  clip: 'clip',
  hole: 'hole',
  axle: 'axle',
  rim: 'rim',
  tyre: 'tyre',
  minifig: null,          // 由 role 决定 peg / socket
};

const KIND_TO_ROLE = {
  top: 'male', side: 'male', bar: 'male', pin: 'male', rim: 'male',
  antistud: 'female', clip: 'female', hole: 'female', axle: 'female', tyre: 'female',
};

/** 由 core 连接器条目推导契约 type / role；无法归类时返回 null（调用方须显式声明缺口，不得猜） */
export function connectorTypeOf(entry) {
  if (entry.kind === 'minifig') {
    return entry.role === 'peg'
      ? { type: 'minifig-peg', role: 'male' }
      : { type: 'minifig-socket', role: 'female' };
  }
  const type = KIND_TO_TYPE[entry.kind];
  if (!type) return null;
  return { type, role: KIND_TO_ROLE[entry.kind] || 'male' };
}

/** 每个 type 的配对规则 id（mateProfile） */
export const MATE_PROFILE_OF = {
  stud: 'stud-antistud-v1',
  antistud: 'stud-antistud-v1',
  bar: 'bar-clip-v1',
  clip: 'bar-clip-v1',
  pin: 'pin-hole-v1',
  hole: 'pin-hole-v1',
  axle: 'pin-axle-v1',
  rim: 'tyre-rim-v1',
  tyre: 'tyre-rim-v1',
  'minifig-peg': 'minifig-peg-socket-v1',
  'minifig-socket': 'minifig-peg-socket-v1',
};

/**
 * 朝向字符串（'+y' 等）→ 24 姿态表的 orientationId。
 * 接口的本地 +y 定义为装配轴：对 locator 类连接器，装配轴 = 连接器 dir；
 * 对轴向类（bar/pin/hole/axle/rim/tyre），dir 是轴线方向，装配轴同为该轴。
 *
 * 同一装配轴对应 4 个绕轴自旋的姿态；接口框架固定取 orientationId 最小的那个，
 * 把自旋单独表达（placement.spinDeg / candidate.spinDeg），避免「朝向对了但字母转了」被记成两套 ID。
 */
export function dirToOrientationId(dir) {
  const d = dir || '+y';
  let best = null;
  for (const o of ORIENTATIONS) {
    if (o.deltas.uy[0] === 0 && o.deltas.uy[1] === 0 && o.deltas.uy[2] === 0) continue;
    const target = DIR_VEC[d];
    if (!target) return null;
    if (o.deltas.uy[0] === target[0] && o.deltas.uy[1] === target[1] && o.deltas.uy[2] === target[2]) {
      if (best === null || o.orientationId < best) best = o.orientationId;
    }
  }
  return best;
}

const DIR_VEC = {
  '+y': [0, 1, 0], '-y': [0, -1, 0],
  '+z': [0, 0, 1], '-z': [0, 0, -1],
  '+x': [1, 0, 0], '-x': [-1, 0, 0],
};
