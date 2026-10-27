// 24 正交姿态表的运行时访问层。
// 唯一真值源是 actions-v1/orientations.js（由它生成契约 orientation-table.json）；
// 这里只做「id ↔ 矩阵/up+rot」的双向查询与组合，避免 core 与契约各写一份表。
import { ORIENTATIONS, orientationById, orientationIdOf, orientationFromAxes, ORIENTATION_TABLE_VERSION } from './orientations.js';

export { ORIENTATIONS, orientationById, orientationIdOf, orientationFromAxes, ORIENTATION_TABLE_VERSION };

/** 取姿态；非法 id 抛错（不静默回退到 0） */
export function getOrientation(id) {
  const o = orientationById(id);
  if (!o) throw new Error(`orientationId=${id} 不在 24 姿态表中（合法范围 0..23）`);
  return o;
}

/** 姿态矩阵作用于 LDU 向量 */
export function applyOrientation(id, v) {
  const m = getOrientation(id).matrix;
  return [
    Math.round((m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2]) * 1e6) / 1e6,
    Math.round((m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2]) * 1e6) / 1e6,
    Math.round((m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]) * 1e6) / 1e6,
  ];
}

/** 姿态 A ∘ B（先 B 后 A）；找不到对应姿态返回 null，不猜 */
export function composeOrientation(a, b) {
  if (a === 0) return b;
  if (b === 0) return a;
  const A = getOrientation(a), B = getOrientation(b);
  const mul = (m, row) => [0, 1, 2].map((i) => m[i][0] * row[0] + m[i][1] * row[1] + m[i][2] * row[2]);
  const r6 = (v) => Math.round(v * 1e6) / 1e6 || 0;
  const cols = [0, 1, 2].map((j) => {
    const bcol = [B.matrix[0][j], B.matrix[1][j], B.matrix[2][j]];
    return mul(A.matrix, bcol).map(r6);
  });
  // cols = [ux, uy, uz]
  return orientationFromAxes(cols[0], cols[1], cols[2], 1e-6);
}

/** 逆姿态：矩阵转置（正交矩阵） */
export function invertOrientation(id) {
  if (id === 0) return 0;
  const m = getOrientation(id).matrix;
  const T = [0, 1, 2].map((i) => [0, 1, 2].map((j) => m[j][i]));
  return orientationFromAxes([T[0][0], T[1][0], T[2][0]], [T[0][1], T[1][1], T[2][1]], [T[0][2], T[1][2], T[2][2]], 1e-6);
}

/**
 * 由父件接口姿态与子件接口姿态求「子件整体需要的姿态」。
 * 装配语义：母件接口的装配轴 +y 要与公件接口的装配轴 −y 对合（同轴反向），
 * 因此子件姿态 = parentOrient ∘ spin ∘ invert(childOrient)。
 * 求不出精确正交姿态时返回 null（调用方报 unsupported，不回退到 0）。
 */
export function mateOrientation(parentOrientationId, childOrientationId, spinDeg = 0) {
  const spin = orientationIdOf('+y', spinDeg);
  if (spin === null) return null;
  const inv = invertOrientation(childOrientationId);
  if (inv === null) return null;
  const a = composeOrientation(parentOrientationId, spin);
  if (a === null) return null;
  return composeOrientation(a, inv);
}
