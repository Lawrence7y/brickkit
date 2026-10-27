// 24 正交姿态表的唯一定义源：既供契约导出（docs/prd-v2/implementation-A/contracts/orientation-table.json），
// 也供 actions-v1 引擎运行时使用。任何修改必须重新生成本文件的 JSON 产物并提升版本。
// 姿态 = (rot ∈ {0,90,180,270}, up ∈ UPS 六面)，共 24 个，恰好覆盖立方体旋转群（行列式全 +1，无镜像）。
//
// 约定（PRD §5.3）：
//   - orientationId = 0 固定为恒等旋转（up='+y', rot=0）
//   - 局部轴 ux/uy/uz 是「零件本地 +x/+y/+z 经该姿态后的世界向量」
//   - 连接框架的 +y 是装配轴；显示外法线单独用 faceNormal 表达
//   - 矩阵以列主序存 ux/uy/uz，即 R = [ux uy uz]，满足 R^T R = I 且 det R = +1

import { rotateLocalVec, UPS } from '../core.js';

export const ORIENTATION_TABLE_VERSION = '1.0.0';
const ROTS = [0, 90, 180, 270];

/** 六面到本地法向 */
export const FACE_NORMAL = {
  '+y': [0, 1, 0], '-y': [0, -1, 0],
  '+z': [0, 0, 1], '-z': [0, 0, -1],
  '+x': [1, 0, 0], '-x': [-1, 0, 0],
};

const r6 = (v) => Math.round(v * 1e6) / 1e6 || 0;

/**
 * 列主序 3×3 矩阵（行数组 [[r00,r01,r02],[r10,r11,r12],[r20,r21,r22]]）。
 * R 的 3 列 = ux, uy, uz 在世界中的分量。
 */
function matrixOf(up, rot) {
  const ux = rotateLocalVec(1, 0, 0, rot, up);
  const uy = rotateLocalVec(0, 1, 0, rot, up);
  const uz = rotateLocalVec(0, 0, 1, rot, up);
  return [
    [r6(ux[0]), r6(uy[0]), r6(uz[0])],
    [r6(ux[1]), r6(uy[1]), r6(uz[1])],
    [r6(ux[2]), r6(uy[2]), r6(uz[2])],
  ];
}

function det(m) {
  return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
}

/** 恒等姿态固定为 id 0；其余按 (up 顺序, rot 顺序) 编号 1..23 */
function buildTable() {
  const list = [];
  let id = 0;
  for (const up of UPS) {
    for (const rot of ROTS) {
      const identity = up === '+y' && rot === 0;
      const entry = {
        orientationId: identity ? 0 : ++id,
        up, rot,
        matrix: matrixOf(up, rot),
        // 装配轴（+y 本地轴的世界朝向）与显示外法线分别表达，避免混用
        assemblyAxis: up,
        determinant: det(matrixOf(up, rot)),
        deltas: {
          ux: rotateLocalVec(1, 0, 0, rot, up).map(r6),
          uy: rotateLocalVec(0, 1, 0, rot, up).map(r6),
          uz: rotateLocalVec(0, 0, 1, rot, up).map(r6),
        },
      };
      list.push(entry);
    }
  }
  // identity 必须排第一
  list.sort((a, b) => a.orientationId - b.orientationId);
  return list;
}

export const ORIENTATIONS = buildTable();

/** orientationId → 姿态；非法 id 返回 null（调用方决定报错还是回退） */
export function orientationById(id) {
  return ORIENTATIONS.find((o) => o.orientationId === id) ?? null;
}

/** (up, rot) → orientationId；非法组合返回 null */
export function orientationIdOf(up, rot) {
  const o = ORIENTATIONS.find((x) => x.up === up && x.rot === (rot ?? 0));
  return o ? o.orientationId : null;
}

/**
 * 由三轴世界向量反查姿态（transformAssembly3D 内部 FIND 逻辑的公开版）。
 * 找不到精确匹配时返回 null，不静默归零——旧 core 的 findOrthoPose 会回退 {rot:0,up},
 * 那会在刚体变换中悄悄产生错误朝向后仍被接受。
 */
export function orientationFromAxes(ux, uy, uz, eps = 1e-3) {
  for (const o of ORIENTATIONS) {
    const d = o.deltas;
    if (Math.abs(d.ux[0] - ux[0]) <= eps && Math.abs(d.ux[1] - ux[1]) <= eps && Math.abs(d.ux[2] - ux[2]) <= eps
      && Math.abs(d.uy[0] - uy[0]) <= eps && Math.abs(d.uy[1] - uy[1]) <= eps && Math.abs(d.uy[2] - uy[2]) <= eps
      && Math.abs(d.uz[0] - uz[0]) <= eps && Math.abs(d.uz[1] - uz[1]) <= eps && Math.abs(d.uz[2] - uz[2]) <= eps) {
      return o.orientationId;
    }
  }
  return null;
}

/** 自检：24 个姿态、id 连续 0..23、正交归一、det=+1、无重复矩阵。返回 { ok, problems } */
export function selfCheck() {
  const problems = [];
  if (ORIENTATIONS.length !== 24) problems.push(`姿态数 ${ORIENTATIONS.length} ≠ 24`);
  const ids = new Set(ORIENTATIONS.map((o) => o.orientationId));
  for (let i = 0; i < 24; i++) if (!ids.has(i)) problems.push(`缺少 orientationId=${i}`);
  if (ORIENTATIONS[0].orientationId !== 0 || ORIENTATIONS[0].up !== '+y' || ORIENTATIONS[0].rot !== 0) {
    problems.push('orientationId=0 不是恒等姿态');
  }
  const keys = new Set();
  for (const o of ORIENTATIONS) {
    const m = o.matrix;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const dot = m[0][i] * m[0][j] + m[1][i] * m[1][j] + m[2][i] * m[2][j];
      if (Math.abs(dot - (i === j ? 1 : 0)) > 1e-9) problems.push(`姿态 ${o.orientationId} 列 ${i}/${j} 非正交`);
    }
    if (Math.abs(det(m) - 1) > 1e-9) problems.push(`姿态 ${o.orientationId} det=${det(m)} ≠ +1`);
    const k = m.flat().join(',');
    if (keys.has(k)) problems.push(`姿态 ${o.orientationId} 矩阵重复`);
    keys.add(k);
  }
  return { ok: problems.length === 0, count: ORIENTATIONS.length, distinct: keys.size, problems };
}
