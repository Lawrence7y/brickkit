// brickbuild 核心：坐标换算、3D 实体防穿模碰撞检测、凸点/底孔/把柄/夹子真实物理扣合计算、步骤计划、零件清单、LDraw 导出、照片完整性检查。
// 纯函数，不依赖 DOM / Node，可同时用于网页查看器与命令行（Harness）。

export const FORMAT = 'brickbuild';
export const VERSION = '0.2';
export const PLATE = 0.4;              // 1 片高度（以“格”为单位：3.2mm / 8.0mm = 0.4 格，即 5 片 = 2 格）
const ROTS = [0, 90, 180, 270];
export const UPS = ['+y', '-y', '+z', '-z', '+x', '-x'];

const r6 = (v) => Math.round(v * 1e6) / 1e6 || 0;
export function rotXZ(x, z, rot) {     // 绕竖直轴 +y 旋转（俯视逆时针）
  const t = (rot * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return [r6(x * c + z * s), r6(-x * s + z * c)];
}
export function rotatedSize(def, rot) {
  const [sx, sz] = def.size;
  return rot % 180 === 0 ? [sx, sz] : [sz, sx];
}
/** 零件底面中心（格坐标：x、z 为格，y 为片；支持 6 向 SNOT 朝向 up 与法向片偏移 snot） */
export function partCenter(p, def) {
  const [w, d] = rotatedSize(def, p.rot || 0);
  const up = p.up || '+y', s = p.snot || 0;
  if (up === '+y') return [r6(p.at[0] + w / 2), r6(p.at[1] + s), r6(p.at[2] + d / 2)];
  if (up === '-y') return [r6(p.at[0] + w / 2), r6(p.at[1] + def.h - s), r6(p.at[2] + d / 2)];
  if (up === '+z') return [r6(p.at[0] + w / 2), r6(p.at[1] + d / (2 * PLATE)), r6(p.at[2] + s * PLATE)];
  if (up === '-z') return [r6(p.at[0] + w / 2), r6(p.at[1] + d / (2 * PLATE)), r6(p.at[2] - s * PLATE)];
  if (up === '+x') return [r6(p.at[0] + s * PLATE), r6(p.at[1] + w / (2 * PLATE)), r6(p.at[2] + d / 2)];
  if (up === '-x') return [r6(p.at[0] - s * PLATE), r6(p.at[1] + w / (2 * PLATE)), r6(p.at[2] + d / 2)];
  return [r6(p.at[0] + w / 2), r6(p.at[1]), r6(p.at[2] + d / 2)];
}

/** 本地向量 (lx, ly_stud, lz) 经 rot 与 up 旋转后的世界偏移向量 (wx_stud, wy_stud, wz_stud) */
export function rotateLocalVec(lx, ly, lz, rot = 0, up = '+y') {
  const [x1, z1] = rotXZ(lx, lz, rot), y1 = ly;
  if (up === '+y') return [x1, y1, z1];
  if (up === '-y') return [x1, -y1, -z1];
  if (up === '+z') return [x1, -z1, y1];
  if (up === '-z') return [x1, z1, -y1];
  if (up === '+x') return [y1, -x1, z1];
  if (up === '-x') return [-y1, x1, z1];
  return [x1, y1, z1];
}

/** 本地坐标点 (lx, ly_stud, lz) 转换为世界坐标 [wx (格), wy (层/片), wz (格)] */
export function localToWorld(p, def, lx, ly, lz) {
  const c = partCenter(p, def);
  const [wx, wy, wz] = rotateLocalVec(lx, ly, lz, p.rot || 0, p.up || '+y');
  return [r6(c[0] + wx), r6(c[1] + wy / PLATE), r6(c[2] + wz)];
}

/** 本地法向量 (nx, ny, nz) 转换到世界朝向字符串 ('+y'|'-y'|'+z'|'-z'|'+x'|'-x') */
export function localDirToWorld(nx, ny, nz, rot = 0, up = '+y') {
  const [wx, wy, wz] = rotateLocalVec(nx, ny, nz, rot, up);
  if (Math.abs(wy) >= 0.9) return wy > 0 ? '+y' : '-y';
  if (Math.abs(wz) >= 0.9) return wz > 0 ? '+z' : '-z';
  return wx > 0 ? '+x' : '-x';
}

/**
 * 凸点本地高度表：cell "i,k"（或 centerStuds 的 "c<cx>,<cz>"）→ ly 列表（片，零件底面起算）。
 * studCells / centerStuds 条目第三位可携带 ly（多高度凸点：底盘座舱槽 / 轮拱 / 双阶斜坡等凹形件的内腔凸点）；
 * 缺省（旧条目无第三位）视为顶面 ly = def.h，走原路径（validate 结果不变）。
 * 同一格允许出现多个不同 ly（例如同一格位上下两层凸点），逐层输出。
 */
export function studLevels(def) {
  const map = new Map();
  const add = (key, ly) => {
    const arr = map.get(key);
    if (!arr) map.set(key, [ly]);
    else if (!arr.includes(ly)) arr.push(ly);
  };
  if (Array.isArray(def.studCells)) for (const [i, k, ly] of def.studCells) add(`${i},${k}`, typeof ly === 'number' ? ly : def.h);
  if (Array.isArray(def.centerStuds)) for (const [cx, cz, ly] of def.centerStuds) add(`c${cx},${cz}`, typeof ly === 'number' ? ly : def.h);
  return map;
}

/** 本地格子（i 沿本地 x，k 沿本地 z；k=0 为后排） */
export function localCells(def) {
  const [sx, sz] = def.size, out = [];
  const cellSet = Array.isArray(def.studCells) ? new Set(def.studCells.map(([i, k]) => `${i},${k}`)) : null;
  for (let i = 0; i < sx; i++) for (let k = 0; k < sz; k++) {
    if (def.kind === 'corner' && i === sx - 1 && k === sz - 1) continue;
    let stud = false;
    if (!def.tile && !def.noTopStuds && def.studs !== 0 && !def.centerStuds) {
      if (cellSet) stud = cellSet.has(`${i},${k}`);
      else if (['brick', 'plate', 'pinplate', 'doorframe', 'round', 'snot', 'bracket', 'barplate', 'clip', 'corner', 'islope', 'arch', 'technic'].includes(def.kind)) stud = true;
      else if (def.kind === 'slope' || (def.kind === 'cslope' && def.backStuds)) stud = k === 0;
      else if (def.kind === 'wedge') stud = def.side === 'L' ? i === 0 || k === 0 : i === 0 || k === sz - 1;
      else if (def.grid) stud = true;
    }
    out.push({ i, k, lx: i - sx / 2 + 0.5, lz: k - sz / 2 + 0.5, stud });
  }
  return out;
}

/** 世界坐标中的占地格子 [{x,z,stud}] */
export function footprint(p, def) {
  const c = partCenter(p, def);
  return localCells(def).map((cell) => {
    const [x, z] = rotXZ(cell.lx, cell.lz, p.rot || 0);
    return { x: Math.floor(c[0] + x), z: Math.floor(c[2] + z), stud: cell.stud };
  });
}
export const topLayer = (p, def) => p.at[1] + def.h;

/**
 * 多高度凸点 / 非整数层扣合：顶凸点 ly 可以不是整数（半片内腔凸点，如 28324 座舱槽 ly=0.5），
 * 扣在上面的零件 at[1] 因此是小数。这类「1/4 片粒度的小数层」只在确实扣到非整数高度凸点上时才合法：
 * validate 仍按 SNOT 口径放宽坐标校验，但会在连通图上二次确认，孤立的小数层照旧报 at 错误。
 */
function quarterInteger(v) { return typeof v === 'number' && Number.isFinite(v) && Math.abs(v * 4 - Math.round(v * 4)) < 1e-9; }
const isRaisedOffGrid = (p) => (!p.up || p.up === '+y') && Array.isArray(p.at) && quarterInteger(p.at[1]) && !Number.isInteger(p.at[1]);
const isSnotLike = (p) => (p.up !== undefined && p.up !== '+y') || Boolean(p.mount) || Boolean(p.snot) || Boolean(p.subassembly) || isRaisedOffGrid(p);

/**
 * 计算零件在世界坐标系中的 3D 实体包围盒数组 [{ x0, x1, y0, y1, z0, z1 }]
 * 其中 x0,x1,z0,z1 单位为格 (stud)，y0,y1 单位为片 (plate)。
 * 支持全部 6 向 SNOT 朝向 (up) 与多包围盒零件（L型转角、SNOT 支架）。
 * 目录条目带 boxes（本地坐标多盒分解：[x0,x1,y0,y1,z0,z1]，y 为片）时优先使用——
 * 凹形件（底盘座舱槽 / 轮拱 / 双阶斜坡）用多盒表达「四壁 + 底」，中间空腔留空，内饰件才能放进去；
 * 无 boxes 的旧条目走下方按 kind 分类的原路径（validate 结果不变）。
 */
export function partBoxes(p, def) {
  if (def.occupies === false) return [];
  const [sx, sz] = def.size, hx = sx / 2, hz = sz / 2, H = def.h * PLATE;
  const localBoxes = [];
  const custom = Array.isArray(def.boxes) && def.boxes.length ? def.boxes : null;
  if (custom) {
    for (const b of custom) {
      if (!Array.isArray(b) || b.length !== 6 || !b.every((v) => typeof v === 'number' && Number.isFinite(v))) {
        throw new Error(`零件 ${p.part}（kind=${def.kind}）的 boxes 条目格式错误：需要 [x0,x1,y0,y1,z0,z1] 6 个有限数字`);
      }
      // boxes 的 y 单位为「片」（与 def.h / studCells 的 ly 同一口径），localToWorld 需要格单位 → ×PLATE
      const [x0, x1, y0, y1, z0, z1] = b;
      localBoxes.push([x0, x1, y0 * PLATE, y1 * PLATE, z0, z1]);
    }
  } else if (def.kind === 'corner') {
    localBoxes.push([-hx, hx, 0, H, -hz, 0], [-hx, 0, 0, H, 0, hz]);
  } else if (def.kind === 'bracket') {
    // P0-b 守卫：ext 支架必须带实测 vH/dir（缺字段时 NaN 经 r6 静默归 0 → 竖板零高度盒 → 穿模假阴性）
    if (typeof def.vH !== 'number' || !Number.isFinite(def.vH) || (def.dir !== 'up' && def.dir !== 'down')) {
      throw new Error(`零件 ${p.part}（bracket）目录条目缺 vH/dir（支架臂高与朝向须由官方 .dat 实测补齐），拒绝生成包围盒`);
    }
    localBoxes.push([-hx, hx, 0, H, -hz, hz]);
    const y0 = def.dir === 'down' ? (1 - def.vH) * PLATE : 0;
    const y1 = def.dir === 'down' ? PLATE : def.vH * PLATE;
    localBoxes.push([-hx, hx, y0, y1, hz, hz + 0.2]);
  } else if (def.kind === 'pinplate') {
    localBoxes.push([-hx, hx, 0, H, -hz, hz], [-0.45, 0.45, 0, H, hz, hz + 0.8], [-0.45, 0.45, 0, H, -hz - 0.8, -hz]);
  } else if (def.kind === 'slope' && sz >= 2) {
    localBoxes.push([-hx, hx, 0, H, -hz, -hz + 1], [-hx, hx, 0, H * 0.5, -hz + 1, hz]);
  } else if (def.kind === 'snot' && def.recessed) {
    localBoxes.push([-hx, hx, 0, H, -hz, hz - 0.2]);
  } else {
    localBoxes.push([-hx, hx, 0, H, -hz, hz]);
  }
  return localBoxes.map(([lx0, lx1, ly0, ly1, lz0, lz1]) => {
    const a = localToWorld(p, def, lx0, ly0, lz0);
    const b = localToWorld(p, def, lx1, ly1, lz1);
    return {
      x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]),
      y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]),
      z0: Math.min(a[2], b[2]), z1: Math.max(a[2], b[2]),
    };
  });
}

/** 判断两个零件的 3D 实体包围盒是否发生穿模重叠（容差：水平 0.04 格，竖直 0.10 片） */
export function boxesCollide(boxesA, boxesB) {
  for (const a of boxesA) for (const b of boxesB) {
    const dx = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const dy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    const dz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
    if (dx > 0.04 && dy > 0.10 && dz > 0.04) {
      return [
        Math.floor((Math.max(a.x0, b.x0) + Math.min(a.x1, b.x1)) / 2),
        Math.floor((Math.max(a.y0, b.y0) + Math.min(a.y1, b.y1)) / 2),
        Math.floor((Math.max(a.z0, b.z0) + Math.min(a.z1, b.z1)) / 2),
      ];
    }
  }
  return null;
}

/**
 * O(n²) 配对裁剪（CP-02）：给每个零件的世界 AABB 建立跨 x/z 的均匀栅格，返回
 * near[i] = 与第 i 件「各自外扩后仍相交」的全部 j > i（升序数组）。
 *
 * 每件的外扩量取**该件自己的连接器外悬**（连接器位置超出自身 AABB 的最大距离，x/z 与 y 分开测）
 * 再加连接判定容差（水平 0.08 格、竖直 0.20 片）与少量余量。于是裁剪是保守超集：
 *   - 任何真实穿模对（盒相交）必然保留（外扩只增不减）；
 *   - 任何可连接对：连接器 a、b 位置重合（±容差），a 距 A 盒 ≤ marginA，b 距 B 盒 ≤ marginB，
 *     故两盒距离 ≤ marginA + marginB，即彼此外扩后必相交，必然保留。
 * near[i] 升序、外层 i 升序 → 与朴素 i<j 双重循环的幸存对**顺序完全一致**，
 * 因此 validate 的错误/连接落盘顺序、支撑图邻接表插入顺序都不变。
 * AABB 为 null 的零件（无碰撞盒 / partBoxes 抛错）不参与裁剪：与所有 j>i 配成候选。
 */
export function nearPairCandidates(aabbs) {
  const n = aabbs.length;
  const out = new Array(n);
  const indexed = [], open = [];
  for (let i = 0; i < n; i++) {
    out[i] = [];
    if (aabbs[i]) indexed.push(i); else open.push(i);
  }
  if (indexed.length) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const i of indexed) {
      const b = aabbs[i];
      // 轮件轴向 ±∞ 薄板不参与栅格边界（cellsOf 会把 ±∞ 裁剪进有限格范围）
      if (b.x0 < minX && b.x0 > -Infinity) minX = b.x0; if (b.x1 > maxX && b.x1 < Infinity) maxX = b.x1;
      if (b.z0 < minZ && b.z0 > -Infinity) minZ = b.z0; if (b.z1 > maxZ && b.z1 < Infinity) maxZ = b.z1;
    }
    if (!Number.isFinite(minX)) minX = 0; if (!Number.isFinite(maxX)) maxX = 0;
    if (!Number.isFinite(minZ)) minZ = 0; if (!Number.isFinite(maxZ)) maxZ = 0;
    const CELL = 2;   // 栅格边长（格）；凸点间距 0.8 格，2 格保证通常每件只占 1~4 格
    const gw = Math.max(1, Math.ceil((maxX - minX) / CELL) + 1);
    const gd = Math.max(1, Math.ceil((maxZ - minZ) / CELL) + 1);
    const cellOf = (v, lo, cap) => Math.min(cap, Math.max(0, Math.floor((v - lo) / CELL)));
    const grid = new Map();
    const cellsOf = (b) => {
      const x0 = cellOf(b.x0 - b.mx, minX, gw - 1), x1 = cellOf(b.x1 + b.mx, minX, gw - 1);
      const z0 = cellOf(b.z0 - b.mx, minZ, gd - 1), z1 = cellOf(b.z1 + b.mx, minZ, gd - 1);
      return [x0, x1, z0, z1];
    };
    for (const i of indexed) {
      const [x0, x1, z0, z1] = cellsOf(aabbs[i]);
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const k = x * gd + z;
        const list = grid.get(k);
        if (list) list.push(i); else grid.set(k, [i]);
      }
    }
    for (const i of indexed) {
      const a = aabbs[i];
      const [x0, x1, z0, z1] = cellsOf(a);
      const cand = new Set();
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const list = grid.get(x * gd + z);
        if (!list) continue;
        for (const j of list) {
          if (j <= i || cand.has(j)) continue;
          const b = aabbs[j];
          if (a.x0 - a.mx > b.x1 + b.mx || b.x0 - b.mx > a.x1 + a.mx) continue;
          if (a.z0 - a.mx > b.z1 + b.mx || b.z0 - b.mx > a.z1 + a.mx) continue;
          if (a.y0 - a.my > b.y1 + b.my || b.y0 - b.my > a.y1 + a.my) continue;
          cand.add(j);
        }
      }
      out[i] = [...cand].sort((p, q) => p - q);
    }
  }
  // 无盒件不参与裁剪：它们既可能被穿模也可能被连接，与所有更高下标互为候选
  for (const i of open) {
    const all = [];
    for (let j = i + 1; j < n; j++) all.push(j);
    out[i] = all;
    for (let j = 0; j < i; j++) if (aabbs[j]) out[j].push(i);
  }
  for (let i = 0; i < n; i++) if (aabbs[i]) out[i].sort((p, q) => p - q);
  return out;
}

/** 计算单个零件的世界 AABB 与「连接器外悬」外扩量（x/z 格、y 片）。无盒返回 null。 */
export function partAabbWithMargin(p, def, conn = null) {
  let boxes;
  try { boxes = partBoxes(p, def); } catch { return null; }
  if (!Array.isArray(boxes) || !boxes.length) return null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const b of boxes) {
    if (b.x0 < x0) x0 = b.x0; if (b.x1 > x1) x1 = b.x1;
    if (b.y0 < y0) y0 = b.y0; if (b.y1 > y1) y1 = b.y1;
    if (b.z0 < z0) z0 = b.z0; if (b.z1 > z1) z1 = b.z1;
  }
  // 连接器外悬：实测本件全部连接器位置超出 AABB 的最大距离（partConnectors 抛错按 0 处理，
  // 只损失裁剪率不损失正确性）；再加判定容差（水平 0.08 格 / 竖直 0.20 片）与余量。
  let mx = 0.1, my = 0.25;
  if (conn) {
    for (const c of [...conn.studs, ...conn.receptors]) {
      const ox = Math.max(x0 - c.pos[0], c.pos[0] - x1, 0);
      const oz = Math.max(z0 - c.pos[2], c.pos[2] - z1, 0);
      const oy = Math.max(y0 - c.pos[1], c.pos[1] - y1, 0);
      if (ox > mx) mx = ox; if (oz > mx) mx = oz; if (oy > my) my = oy;
    }
    mx += 0.1; my += 0.25;
  }
  // 轮件轴向开放（行为保持的关键特例）：partsConnected 的 tyre↔rim 判据只要求
  // 「垂直于轮轴的横截面圆心重合（±0.08）」，沿轮轴方向**不设上限**（60239 的 11208 轮辋与
  // 11209 轮胎盒沿 z 相距数格仍判扣合）。因此带 wheel 字段的件沿其轮轴取 ±∞ 薄板，
  // 轮轴向不裁剪；轮件数量少，代价可忽略。
  if (def && def.wheel && typeof def.wheel.axis === 'string') {
    if (def.wheel.axis === 'x') { x0 = -Infinity; x1 = Infinity; }
    else if (def.wheel.axis === 'y') { y0 = -Infinity; y1 = Infinity; }
    else { z0 = -Infinity; z1 = Infinity; }
  }
  return { x0, x1, y0, y1, z0, z1, mx, my };
}

/**
 * 圆柱体零件（轮毂/轮胎/圆盘，目录条目带 wheel 字段）的碰撞代理。
 * 轮/胎是圆盘，用 AABB 判会把轮外圈的方角误判成撞进车体（真实圆盘只擦边）。
 * 返回 { center（世界 [x, y片, z]）, axis（'x'|'y'|'z'）, r（半径格，取 w 的 outer）, halfT（半厚片）}。
 */
export function wheelCylinder(p, def) {
  if (!def || !def.wheel) return null;
  const axis = def.wheel.axis || 'z';
  const cy = typeof def.wheel.cy === 'number' ? def.wheel.cy : def.h / 2;
  const center = localToWorld(p, def, 0, cy * PLATE, 0);
  const halfT = typeof def.wheel.thickness === 'number' ? def.wheel.thickness / 2 : def.h / 2;
  return { center, axis, r: def.wheel.outer, halfT };
}
/** 圆柱 vs AABB 数组：轴向区间重叠 + 垂直平面内圆心到矩形距离 < 半径 → 穿模。返回命中点或 null。 */
export function wheelBoxesCollide(cyl, boxes) {
  if (!cyl) return null;
  const i = { x: 0, y: 1, z: 2 }[cyl.axis];
  if (i === undefined) return null;
  const [a1, a2] = [0, 1, 2].filter((k) => k !== i);
  const lo = (b) => [b.x0, b.y0, b.z0];
  const hi = (b) => [b.x1, b.y1, b.z1];
  for (const b of boxes) {
    const off = Math.min(cyl.center[i] + cyl.halfT, hi(b)[i]) - Math.max(cyl.center[i] - cyl.halfT, lo(b)[i]);
    if (off <= (i === 1 ? 0.10 : 0.04)) continue;
    const clamp = (v, l, h) => Math.min(Math.max(v, l), h);
    const q1 = clamp(cyl.center[a1], lo(b)[a1], hi(b)[a1]);
    const q2 = clamp(cyl.center[a2], lo(b)[a2], hi(b)[a2]);
    if (Math.hypot(cyl.center[a1] - q1, cyl.center[a2] - q2) < cyl.r - 0.04) {
      const hit = [0, 1, 2].map((k) => Math.floor(k === i ? Math.max(cyl.center[i] - cyl.halfT, lo(b)[i]) : cyl.center[k]));
      return hit;
    }
  }
  return null;
}
/** 两个零件是否穿模。
 *
 *  轮/胎件（目录带 wheel 字段）的处理原则：**用连接关系决定嵌套是否合法**，而不是整件豁免。
 *
 *  历史背景：早先这里是 `if (defA?.wheel || defB?.wheel) return null;`，
 *  本意是「轮胎是圆环、轮毂嵌在胎孔里，两者 AABB 必然相交，整盒判会把正常嵌轮误判成穿模」。
 *  问题在于整件豁免同时吞掉真实穿模：在 60239 上它正好隐藏了两处
 *  「2 格宽轮胎压进 8 格瓷砖」的实心相交（p088×p056、p090×p057，各深 2×1×1 格），
 *  而这两颗轮胎与瓷砖之间没有任何连接器，属于真实错位。
 *
 *  现在的判据：
 *    - 轮件与对方**真实扣合**（tyre↔rim / pin↔axleHole 等，由 partsConnected 判定）→ 嵌套合法，
 *      不报穿模（轮毂就该在胎孔里）。
 *    - 轮件与对方**没有连接**却 AABB 相交 → 报穿模（这才是真错位）。
 *  这样「合法的嵌轮」和「压进别的东西」被区分开，不再靠一刀切豁免。
 *
 *  需要更精细的圆盘代理时传 `{ wheelMode: 'cylindrical' }`，改用 wheelBoxesCollide。
 *  返回命中点或 null。
 */
export function partsCollide(a, defA, boxesA, b, defB, boxesB, opts = {}) {
  const isWheel = Boolean(defA?.wheel || defB?.wheel);
  if (!isWheel) return boxesCollide(boxesA, boxesB);

  // 轮件：先看它们是不是真的扣在一起
  let connected = false;
  try {
    connected = partsConnected(a, defA, b, defB);
  } catch { connected = false; }
  if (connected) return null;      // 合法嵌套（轮胎包轮毂）

  if (opts.wheelMode === 'cylindrical') {
    const cylA = wheelCylinder(a, defA);
    if (cylA) return wheelBoxesCollide(cylA, boxesB);
    const cylB = wheelCylinder(b, defB);
    if (cylB) return wheelBoxesCollide(cylB, boxesA);
  }
  return boxesCollide(boxesA, boxesB);
}

/**
 * 计算零件在世界空间中的全部连接点：
 * - studs: 输出连接点 [{ index, kind: 'top'|'side'|'bar'|'pin'|'rim'|'minifig', pos: [wx, wy_plates, wz], dir, label }]
 * - receptors: 输入插孔 [{ index, kind: 'antistud'|'clip'|'hole'|'axle'|'tyre'|'minifig', pos, dir, i, k }]
 */
export function partConnectors(p, def) {
  const [sx, sz] = def.size, hx = sx / 2, hz = sz / 2, H = def.h * PLATE;
  const rot = p.rot || 0, up = p.up || '+y';
  const studs = [], receptors = [];

  // 1. 顶面凸点 (Top Studs) —— 支持多高度凸点：studCells/centerStuds 第三位 ly（片，底面起算）可为内腔/分层凸点；
  //    无 ly 的旧条目一律按顶面 H 处理（原路径，validate 结果不变）。
  const topDir = localDirToWorld(0, 1, 0, rot, up);
  const levels = studLevels(def);
  const studYs = (key) => {
    const arr = levels.get(key);
    return arr ? arr.map((ly) => ly * PLATE) : [H];
  };
  if (!def.tile && !def.noTopStuds && def.studs !== 0) {
    if (def.centerStuds) {
      def.centerStuds.forEach(([cx, cz], idx) => {
        for (const y of studYs(`c${cx},${cz}`)) {
          studs.push({ index: studs.length, kind: 'top', pos: localToWorld(p, def, cx, y, cz), dir: topDir, label: `center-${idx}`, ly: r6(y / PLATE) });
        }
      });
    } else if ((def.kind === 'cone' || def.kind === 'dish') && !Array.isArray(def.studCells)) {
      studs.push({ index: studs.length, kind: 'top', pos: localToWorld(p, def, 0, H, 0), dir: topDir, label: 'top-0', ly: r6(H / PLATE) });
    } else {
      for (const c of localCells(def)) if (c.stud) {
        for (const y of studYs(`${c.i},${c.k}`)) {
          studs.push({ index: studs.length, kind: 'top', pos: localToWorld(p, def, c.lx, y, c.lz), dir: topDir, label: `top-${c.i},${c.k}`, ly: r6(y / PLATE) });
        }
      }
    }
  }

  // 2. SNOT 侧面凸点 & 支架侧面凸点/插孔（ext/auto 条目带显式 sideStuds 字段时以实测为准，走 2b）
  if ((def.kind === 'snot' || def.kind === 'bracket') && !Array.isArray(def.sideStuds)) {
    const zMax = def.kind === 'bracket' ? hz + 0.2 : (def.recessed ? hz - 0.2 : hz);
    const rows = def.sideRows || (def.h >= 5 ? [1.25, 3.75] : [1.75]);
    const faces = def.sideFaces || ['+z'];
    for (const face of faces) {
      if (face === '+z' || face === '-z') {
        const fz = face === '+z' ? zMax : -hz;
        const dir = localDirToWorld(0, 0, face === '+z' ? 1 : -1, rot, up);
        for (const r of rows) for (let i = 0; i < sx; i++) {
          const pos = localToWorld(p, def, i - hx + 0.5, r * PLATE, fz);
          studs.push({ index: studs.length, kind: 'side', pos, dir, label: `side(${face})-${i}@${r}` });
        }
      } else {
        const fx = face === '+x' ? hx : -hx;
        const dir = localDirToWorld(face === '+x' ? 1 : -1, 0, 0, rot, up);
        for (const r of rows) for (let k = 0; k < sz; k++) {
          studs.push({ index: studs.length, kind: 'side', pos: localToWorld(p, def, fx, r * PLATE, k - hz + 0.5), dir, label: `side(${face})-${k}@${r}` });
        }
      }
    }
  }

  // 2b. ext/auto 条目官方 .dat 实测连接字段（P1 连接语义自动提取；精选目录无这些字段，走原路径不受影响）
  //     条目格式：sideStuds/bars/pins/clips/holes/axleHoles = [[lx, ly, lz, 朝向或轴向], ...]
  //     lx/lz 为本地格坐标（中心原点），ly 同为格单位（1 格 = 2.5 片）；侧凸点/夹口存 '+x'…朝向，杆/销/孔存 'x'|'y'|'z' 轴向
  const axisOf = (d) => d.slice(1);
  const LOCAL_DIR = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };
  const LOCAL_AXIS = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  if (Array.isArray(def.sideStuds)) {
    for (const [lx, ly, lz, face] of def.sideStuds) {
      const v = LOCAL_DIR[face] || LOCAL_DIR['+z'];
      studs.push({ index: studs.length, kind: 'side', pos: localToWorld(p, def, lx, ly, lz), dir: localDirToWorld(v[0], v[1], v[2], rot, up), label: `extside@${lx},${ly},${lz}` });
    }
  }
  if (Array.isArray(def.bars)) {
    for (const [lx, ly, lz, ax] of def.bars) {
      const a = LOCAL_AXIS[ax] || LOCAL_AXIS.x;
      const axis = axisOf(localDirToWorld(a[0], a[1], a[2], rot, up));
      studs.push({ index: studs.length, kind: 'bar', pos: localToWorld(p, def, lx, ly, lz), dir: localDirToWorld(a[0], a[1], a[2], rot, up), axis, label: `extbar@${lx},${ly},${lz}` });
    }
  }
  if (Array.isArray(def.pins)) {
    for (const [lx, ly, lz, ax] of def.pins) {
      const a = LOCAL_AXIS[ax] || LOCAL_AXIS.x;
      const axis = axisOf(localDirToWorld(a[0], a[1], a[2], rot, up));
      studs.push({ index: studs.length, kind: 'pin', pos: localToWorld(p, def, lx, ly, lz), dir: localDirToWorld(a[0], a[1], a[2], rot, up), axis, label: `extpin@${lx},${ly},${lz}` });
    }
  }

  // 3. 把柄 (Bars) —— 包含圆杆轴向 axis ('x'|'y'|'z')（axisOf 已在 2b 声明）
  if (def.kind === 'barplate') {
    const dir = localDirToWorld(0, 0, 1, rot, up);
    const axis = axisOf(localDirToWorld(1, 0, 0, rot, up));
    for (let i = 0; i < sx; i++) {
      studs.push({ index: studs.length, kind: 'bar', pos: localToWorld(p, def, i - hx + 0.5, H / 2, hz + 0.22), dir, axis, label: `bar-${i}` });
      if (def.bothEnds) {
        const dirBack = localDirToWorld(0, 0, -1, rot, up);
        studs.push({ index: studs.length, kind: 'bar', pos: localToWorld(p, def, i - hx + 0.5, H / 2, -hz - 0.22), dir: dirBack, axis, label: `bar-back-${i}` });
      }
    }
  } else if (def.kind === 'bar') {
    const axis = axisOf(topDir);
    for (let y = 0.5; y < def.h; y += 1) {
      studs.push({ index: studs.length, kind: 'bar', pos: localToWorld(p, def, 0, y * PLATE, 0), dir: topDir, axis, label: `bar@${y}` });
    }
  }

  // 4. 底面反凸点 / 底孔 (Bottom Anti-studs) —— 支持第三位 ly（片，底面起算）表示内缩/抬高底孔（如挡泥板 50745、底盘 28324 前后桥）
  // ext/auto 条目带 antistudCells（官方 .dat 实测底孔格位）时按实测判定——空数组即底面无反孔
  // （科技梁/轴/轴衬等底面是实心的，禁用默认满格虚假受体）；无该字段（精选目录/常规砖板）走原满格路径。
  // antistudSource:'assumed' 是第三种口径（generator B 保守恢复）：官方 .dat 用 box 边沿建模底腔、
  // 不逐格建反孔图元，物理底孔确实存在（挡泥板 50745、异形砖 3937 等），按砖族默认满格处理。
  const antiLevels = new Map();
  if (Array.isArray(def.antistudCells)) {
    for (const [i, k, ly] of def.antistudCells) {
      const key = `${i},${k}`;
      const y = typeof ly === 'number' ? ly : 0;
      const arr = antiLevels.get(key);
      if (!arr) antiLevels.set(key, [y]);
      else if (!arr.includes(y)) arr.push(y);
    }
  }
  const antiCells = Array.isArray(def.antistudCells) ? antiLevels : null;
  const antiAssumed = def.antistudSource === 'assumed';
  for (const c of localCells(def)) {
    if (def.kind === 'islope' && !antiCells && c.k > 0) continue;
    if (antiCells && !antiAssumed) {
      const ys = antiCells.get(`${c.i},${c.k}`);
      if (!ys) continue;
      for (const ly of ys) {
        receptors.push({ index: receptors.length, kind: 'antistud', pos: localToWorld(p, def, c.lx, ly * PLATE, c.lz), dir: topDir, i: c.i, k: c.k, ly });
      }
      continue;
    }
    receptors.push({ index: receptors.length, kind: 'antistud', pos: localToWorld(p, def, c.lx, 0, c.lz), dir: topDir, i: c.i, k: c.k, ly: 0 });
  }
  if ((!antiCells || antiAssumed) && sx >= 2 && sz >= 2 && def.kind !== 'corner') {
    receptors.push({ index: receptors.length, kind: 'antistud', pos: localToWorld(p, def, 0, 0, 0), dir: topDir, i: -1, k: -1 });
  } else if (antiCells && def.antistudCenter) {
    receptors.push({ index: receptors.length, kind: 'antistud', pos: localToWorld(p, def, 0, 0, 0), dir: topDir, i: -1, k: -1 });
  }

  // 5. 夹子 (Clips) —— 包含夹口圆柱轴向 axis ('x'|'y'|'z')
  if (def.kind === 'clip' && !Array.isArray(def.clips)) {
    const clipDir = localDirToWorld(0, 0, 1, rot, up);
    const axis = axisOf(localDirToWorld(1, 0, 0, rot, up));
    const clipXs = !def.singleClip && sx >= 2 ? [-0.5, 0.5] : [0];
    for (const cx of clipXs) {
      receptors.push({ index: receptors.length, kind: 'clip', pos: localToWorld(p, def, cx, H / 2, hz + 0.22), dir: clipDir, axis, i: 0, k: 0 });
    }
  }

  // 5b. ext/auto 条目实测夹口（clip 族图元）与销孔/轴孔受体（P1：对齐精选 clip 范式的新受体类型）
  if (Array.isArray(def.clips)) {
    for (const [lx, ly, lz, face] of def.clips) {
      const v = LOCAL_DIR[face] || LOCAL_DIR['+z'];
      // 夹口朝向 ±x 时杆轴取 z，其余（±z/±y）取 x
      const a = (face === '+x' || face === '-x') ? LOCAL_AXIS.z : LOCAL_AXIS.x;
      receptors.push({ index: receptors.length, kind: 'clip', pos: localToWorld(p, def, lx, ly, lz), dir: localDirToWorld(v[0], v[1], v[2], rot, up), axis: axisOf(localDirToWorld(a[0], a[1], a[2], rot, up)), i: 0, k: 0 });
    }
  }
  if (Array.isArray(def.holes)) {
    for (const [lx, ly, lz, ax] of def.holes) {
      const a = LOCAL_AXIS[ax] || LOCAL_AXIS.z;
      const axis = axisOf(localDirToWorld(a[0], a[1], a[2], rot, up));
      receptors.push({ index: receptors.length, kind: 'hole', pos: localToWorld(p, def, lx, ly, lz), dir: localDirToWorld(a[0], a[1], a[2], rot, up), axis, i: 0, k: 0 });
    }
  }
  if (Array.isArray(def.axleHoles)) {
    for (const [lx, ly, lz, ax] of def.axleHoles) {
      const a = LOCAL_AXIS[ax] || LOCAL_AXIS.z;
      const axis = axisOf(localDirToWorld(a[0], a[1], a[2], rot, up));
      receptors.push({ index: receptors.length, kind: 'axle', pos: localToWorld(p, def, lx, ly, lz), dir: localDirToWorld(a[0], a[1], a[2], rot, up), axis, i: 0, k: 0 });
    }
  }

  // 5c. 车轮语义（生成器实测轮径/轮孔）：rim（轮毂）输出轮辋凸缘，tyre（轮胎）输出胎孔受体。
  //     两者轴向同心 + 半径匹配才构成 tyre↔rim 连接（见 partsConnected）；径向尺寸单位 = 格。
  if (def.wheel && (def.wheel.role === 'rim' || def.wheel.role === 'tyre')) {
    const ax = def.wheel.axis || 'z';
    const a = LOCAL_AXIS[ax] || LOCAL_AXIS.z;
    // 轮心高度取生成器实测的 cy（片）；旧条目无 cy 时退回 h/2（半高）
    const cy = typeof def.wheel.cy === 'number' ? def.wheel.cy : def.h / 2;
    const pos = localToWorld(p, def, 0, cy * PLATE, 0);
    const dir = localDirToWorld(a[0], a[1], a[2], rot, up);
    const entry = { index: 0, kind: def.wheel.role, role: def.wheel.role, pos, dir, axis: axisOf(dir), outer: def.wheel.outer, bore: def.wheel.bore, i: 0, k: 0 };
    if (def.wheel.role === 'rim') { entry.index = studs.length; studs.push(entry); }
    else { entry.index = receptors.length; receptors.push(entry); }
  }

  // 5d. 人仔标准接口（LEGO 人仔系统：腿↔胯↔躯干↔头↔帽）：
  //     minifig.pegs = [[lx, ly, lz]] 竖直插柱；minifig.sockets = [[lx, ly, lz]] 底部插孔。
  //     配对规则：peg↔socket 同轴上下对接；头部顶凸点（kind top）也可插进 socket（stud↔antistud 的人仔变体）。
  if (def.minifig) {
    const mk = (list, kind) => {
      for (const [lx, ly, lz] of list || []) {
        // 目录里 minifig.pegs/sockets 的 ly 单位是「片」（与 studCells 的 ly 同口径），localToWorld 要格 → ×PLATE
        const entry = { index: kind === 'peg' ? studs.length : receptors.length, kind: 'minifig', role: kind,
          pos: localToWorld(p, def, lx, ly * PLATE, lz), dir: topDir, axis: 'y', i: 0, k: 0 };
        if (kind === 'peg') studs.push(entry); else receptors.push(entry);
      }
    };
    mk(def.minifig.pegs, 'peg');
    mk(def.minifig.sockets, 'socket');
  }

  return { studs, receptors };
}

/**
 * 判断两个零件是否存在真实物理连接
 *   凸点扣底孔（同向重合）/ 夹子扣把柄（同轴重合）/ 销插销孔（同轴重合）/
 *   轮销插轮毂轴孔（pin↔axle，同轴重合）/ 轮胎套轮毂（tyre↔rim，轴向同心 + 半径匹配）/
 *   人仔插接（minifig peg↔socket 上下对接，或头部顶凸点 ↔ 躯干颈孔）
 */
export function partsConnected(a, defA, b, defB, connA = partConnectors(a, defA), connB = partConnectors(b, defB)) {
  const close = (p1, p2) => Math.abs(p1[0] - p2[0]) <= 0.08 && Math.abs(p1[1] - p2[1]) <= 0.20 && Math.abs(p1[2] - p2[2]) <= 0.08;
  const sameAxis = (s, r) => !s.axis || !r.axis || s.axis === r.axis;
  // 轮胎套轮毂：两件轴向同心 —— 只要求「垂直于轮轴的横截面圆心重合」（轮毂/轮胎各自包围盒底不同，
  // 轴向允许错位），轮胎内孔 bore ≤ 轮毂外径 outer，且轮毂外径 ≤ 轮胎外径。
  const AXIS_COMPONENT = { x: 0, y: 1, z: 2 };
  const coaxial = (a, b) => {
    const axis = a.axis || b.axis;
    const i = AXIS_COMPONENT[axis];
    if (i === undefined) return false;
    for (const j of [0, 1, 2]) if (j !== i && Math.abs(a.pos[j] - b.pos[j]) > 0.08) return false;
    return true;
  };
  const tyreRim = (tyre, rim) => {
    if (!sameAxis(tyre, rim)) return false;
    if (!coaxial(tyre, rim)) return false;
    const bore = typeof tyre.bore === 'number' ? tyre.bore : null;
    const outer = typeof rim.outer === 'number' ? rim.outer : null;
    if (bore === null || outer === null) return false;
    return bore <= outer + 0.12 && outer <= (typeof tyre.outer === 'number' ? tyre.outer : Infinity) + 0.12;
  };
  const pair = (s, r) => {
    if (s.kind === 'bar' && r.kind === 'clip') return sameAxis(s, r) && close(s.pos, r.pos);
    if (s.kind === 'pin' && r.kind === 'hole') return sameAxis(s, r) && close(s.pos, r.pos);
    if (s.kind === 'pin' && r.kind === 'axle') return sameAxis(s, r) && close(s.pos, r.pos);
    if (s.kind === 'minifig' && r.kind === 'minifig') return s.role === 'peg' && r.role === 'socket' && close(s.pos, r.pos);
    if (s.kind === 'top' && r.kind === 'minifig') return r.role === 'socket' && s.dir === r.dir && close(s.pos, r.pos);
    if (s.kind === 'top' && r.kind === 'antistud') return s.dir === r.dir && close(s.pos, r.pos);
    if (s.kind !== 'bar' && s.kind !== 'pin' && s.kind !== 'minifig' && r.kind === 'antistud') return s.dir === r.dir && close(s.pos, r.pos);
    return false;
  };
  for (const s of connA.studs) for (const r of connB.receptors) {
    if (s.kind === 'rim' && r.kind === 'tyre') { if (tyreRim(r, s)) return true; continue; }
    if (pair(s, r)) return true;
  }
  for (const s of connB.studs) for (const r of connA.receptors) {
    if (s.kind === 'rim' && r.kind === 'tyre') { if (tyreRim(r, s)) return true; continue; }
    if (pair(s, r)) return true;
  }
  return false;
}

/**
 * 给定父零件的某个凸点 studIndex，自动计算子零件以 receptorIndex 底孔扣合上去时的精确无穿模坐标 { at, up, rot, snot: 0 }
 * 防错加固：底孔编号越界直接抛中文错误（不再静默回退第 0 号）；算出坐标后用 partsConnected
 * 复核父子确实物理扣合，方向不匹配时抛出含双方 id、零件编号、凸点方向与底孔方向的中文错误。
 */
export function snapPart(parentPart, parentDef, studIndex, childPart, childDef, receptorIndex = 0, opts = {}) {
  const pConn = partConnectors(parentPart, parentDef);
  const under = Boolean(opts && opts.under);
  const pAnchor = under ? pConn.receptors[studIndex] : pConn.studs[studIndex];
  if (!pAnchor) {
    throw new Error(under ? `父零件 ${parentPart.id} 不存在底孔 #${studIndex}` : `父零件 ${parentPart.id} 不存在凸点 #${studIndex}`);
  }
  const up = childPart.up || pAnchor.dir;
  const rot = childPart.rot || 0;
  const probe = { id: '_probe', part: childPart.part, at: [0, 0, 0], rot, up, snot: 0 };
  const cConn = partConnectors(probe, childDef);
  const cAnchor = under ? cConn.studs[receptorIndex] : cConn.receptors[receptorIndex];
  if (!cAnchor) {
    const n = under ? cConn.studs.length : cConn.receptors.length;
    throw new Error(
      under
        ? `子零件 ${childPart.id || '(未命名)'}（零件 ${childPart.part}）没有第 ${receptorIndex} 号凸点：该零件共 ${n} 个凸点（编号 0~${n - 1}）`
        : `子零件 ${childPart.id || '(未命名)'}（零件 ${childPart.part}）没有第 ${receptorIndex} 号底孔：该零件共 ${n} 个底孔（编号 0~${n - 1}），不再静默回退到第 0 号`
    );
  }
  const stud = under ? cAnchor : pAnchor;
  const rec = under ? pAnchor : cAnchor;
  const childId = childPart.id || `(未命名 ${childPart.part})`;
  const snapped = {
    ...childPart,
    up,
    rot,
    snot: 0,
    at: [
      r6(pAnchor.pos[0] - cAnchor.pos[0]),
      r6(pAnchor.pos[1] - cAnchor.pos[1]),
      r6(pAnchor.pos[2] - cAnchor.pos[2]),
    ],
  };
  if (!partsConnected(parentPart, parentDef, snapped, childDef, pConn, partConnectors(snapped, childDef))) {
    // 归因：把柄只能扣夹子、销只能插销孔/轴孔、轮毂对轮胎、人仔插柱对插孔（kind 不匹配）；kind 匹配时才是朝向问题
    const kindMatched = (stud.kind === 'bar' && rec.kind === 'clip')
      || (stud.kind === 'pin' && (rec.kind === 'hole' || rec.kind === 'axle'))
      || (stud.kind === 'rim' && rec.kind === 'tyre')
      || (stud.kind === 'minifig' && rec.kind === 'minifig')
      || (stud.kind === 'top' && rec.kind === 'minifig')
      || (stud.kind !== 'bar' && stud.kind !== 'pin' && stud.kind !== 'minifig' && rec.kind === 'antistud');
    const reason = !kindMatched
      ? `连接类型不匹配：${stud.label || stud.kind}（${stud.kind}）无法扣进 ${rec.kind}（把柄只能扣夹子，凸点只能扣底孔，销只能插销孔/轴孔，轮毂只能对轮胎，人仔插柱只能插人仔插孔）`
      : `方向不匹配：凸点朝向 ${stud.dir} 与底孔朝向 ${rec.dir} 不一致`;
    throw new Error(
      `snap 结果不成立：父零件 ${parentPart.id}（零件 ${parentPart.part}）的${under ? '底孔' : '凸点'} #${studIndex}（朝向 ${pAnchor.dir}）` +
      `与子零件 ${childId}（零件 ${childPart.part}）的${under ? '凸点' : '底孔'} #${receptorIndex}（朝向 ${cAnchor.dir}）${reason}，不构成物理扣合；` +
      `请让子件 up 与凸点朝向一致，或改经 SNOT 侧凸点砖 / 倒顺支架 / 外挑托板转接`
    );
  }
  return snapped;
}

// ---------------------------------------------------------------- 3D 刚体挂装 / 挂点自动搜索 / 参数化装配树重算
/** 预计算 24 种立方体正交姿态 (rot ∈ {0,90,180,270}, up ∈ UPS) 的三轴单位向量 */
const POSE_TABLE = (() => {
  const list = [];
  for (const up of UPS) {
    for (const rot of ROTS) {
      list.push({
        rot,
        up,
        ux: rotateLocalVec(1, 0, 0, rot, up),
        uy: rotateLocalVec(0, 1, 0, rot, up),
        uz: rotateLocalVec(0, 0, 1, rot, up),
      });
    }
  }
  return list;
})();

function findOrthoPose(ux, uy, uz) {
  return POSE_TABLE.find((p) =>
    Math.abs(p.ux[0] - ux[0]) < 1e-3 && Math.abs(p.ux[1] - ux[1]) < 1e-3 && Math.abs(p.ux[2] - ux[2]) < 1e-3 &&
    Math.abs(p.uy[0] - uy[0]) < 1e-3 && Math.abs(p.uy[1] - uy[1]) < 1e-3 && Math.abs(p.uy[2] - uy[2]) < 1e-3 &&
    Math.abs(p.uz[0] - uz[0]) < 1e-3 && Math.abs(p.uz[1] - uz[1]) < 1e-3 && Math.abs(p.uz[2] - uz[2]) < 1e-3
  ) || { rot: 0, up: localDirToWorld(uy[0], uy[1], uy[2]) };
}

/** 逆向 rotateLocalVec(v, 0, dir)：将世界朝向 dir 的向量映回标准 +y 朝向 */
function unrotateDirVec(vx, vy, vz, dir = '+y') {
  if (dir === '+y') return [vx, vy, vz];
  if (dir === '-y') return [vx, -vy, -vz];
  if (dir === '+z') return [vx, vz, -vy];
  if (dir === '-z') return [vx, -vz, vy];
  if (dir === '+x') return [-vy, vx, vz];
  if (dir === '-x') return [vy, -vx, vz];
  return [vx, vy, vz];
}

/**
 * 将由 dir1 朝向定义的局部欧氏向量 v（统一以“格”为单位）旋转到 dir2 朝向，并绕法向自旋 rotDeg 度：
 *   v' = B(dir2) · R_y(rotDeg) · B(dir1)^T · v
 * 当 dir1 === '+y' 且 dir2 === '+y' 时，严格退化为 [rotXZ(vx, vz, rotDeg), vy]。
 */
export function rotateBetweenDirs(vx, vy, vz, dir1 = '+y', dir2 = '+y', rotDeg = 0) {
  const [x0, y0, z0] = unrotateDirVec(vx, vy, vz, dir1);
  const [x1, z1] = rotXZ(x0, z0, rotDeg);
  return rotateLocalVec(x1, y0, z1, 0, dir2);
}

/**
 * 3D 子组件刚体变换：将一组零件 members = [{ p, def }, ...] 围绕 anchorId 的第 anchorReceptor 号底孔
 * 旋转（含平面旋转与 90°/180° SNOT 翻立）并平移扣合到 parent 的第 studIndex 号凸点上。
 * 成功返回变换后的零件数组 placed（深拷贝），若无法物理扣合或非 SNOT 整数格非法则返回 null。
 */
export function transformAssembly3D(members, parent, parentDef, studIndex, anchorId, anchorReceptor = 0, rotDeg = 0) {
  const pConn = partConnectors(parent, parentDef);
  const parentStud = pConn.studs[studIndex];
  if (!parentStud) return null;
  const anchorEntry = members.find(({ p }) => p.id === anchorId);
  if (!anchorEntry) return null;
  const aConn = partConnectors(anchorEntry.p, anchorEntry.def);
  const aRec = aConn.receptors[anchorReceptor];
  if (!aRec) return null;

  const d1 = aRec.dir || '+y';
  const d2 = parentStud.dir || '+y';
  // 统一转换到以“格 (stud)”为单位的 3D 欧氏空间做刚体旋转 + 平移
  const R0 = [aRec.pos[0], aRec.pos[1] * PLATE, aRec.pos[2]];
  const S = [parentStud.pos[0], parentStud.pos[1] * PLATE, parentStud.pos[2]];
  const snotMount = d1 !== '+y' || d2 !== '+y' || isSnotLike(parent);

  const out = [];
  for (const { p, def } of members) {
    const c = partCenter(p, def);
    const C = [c[0], c[1] * PLATE, c[2]];
    const rel = [C[0] - R0[0], C[1] - R0[1], C[2] - R0[2]];
    const rotRel = rotateBetweenDirs(rel[0], rel[1], rel[2], d1, d2, rotDeg);
    const C2 = [S[0] + rotRel[0], S[1] + rotRel[1], S[2] + rotRel[2]];
    const c2 = [r6(C2[0]), r6(C2[1] / PLATE), r6(C2[2])];

    const pRot = p.rot || 0, pUp = p.up || '+y';
    const ux0 = rotateLocalVec(1, 0, 0, pRot, pUp);
    const uy0 = rotateLocalVec(0, 1, 0, pRot, pUp);
    const uz0 = rotateLocalVec(0, 0, 1, pRot, pUp);
    const ux = rotateBetweenDirs(ux0[0], ux0[1], ux0[2], d1, d2, rotDeg);
    const uy = rotateBetweenDirs(uy0[0], uy0[1], uy0[2], d1, d2, rotDeg);
    const uz = rotateBetweenDirs(uz0[0], uz0[1], uz0[2], d1, d2, rotDeg);
    const pose = findOrthoPose(ux, uy, uz);

    // 当 d1==='+y' 且 d2==='+y' 且零件原 snot 存在时保留原 snot，否则归零由 at 精确表达
    const snot = (!snotMount && p.snot) ? p.snot : 0;
    const off = partCenter({ at: [0, 0, 0], rot: pose.rot, up: pose.up, snot }, def);
    const at = [r6(c2[0] - off[0]), r6(c2[1] - off[1]), r6(c2[2] - off[2])];
    const cand = { ...p, at, rot: pose.rot, up: pose.up, snot };
    if (!snotMount && !isSnotLike(cand) && !def.offGrid && !at.every(Number.isInteger)) return null;
    out.push(cand);
  }
  const candAnchor = out.find((p) => p.id === anchorId);
  if (!partsConnected(parent, parentDef, candAnchor, anchorEntry.def, pConn, partConnectors(candAnchor, anchorEntry.def))) {
    return null;
  }
  return out;
}

/**
 * 自动搜索子模型 subModel 挂装到主模型 mainModel 上的全部合法无穿模候选方案。
 * opts: { parent?: string, anchor?: string, stud?: number, receptor?: number, rot?: number, maxResults?: number,
 *        includeParentCollision?: boolean }
 *
 * 父件碰撞（EN-02 / PRD §7.3）：候选必须对「全部相关零件」查碰撞，**包括父件本身**。
 * 历史上这里 `if (other.id === parent.id) continue;` 整件豁免父件，导致「以上片为锚点挂两片板、
 * 下片穿进父砖」的候选被当成合法返回。接触合法性应由连接器规则表达，不能用整件豁免表达。
 * 仍可为极少数确实与父件共面贴合的情形显式传 includeParentCollision:false，但那必须由调用方
 * 自己的连接证据背书，并会写进候选的 collisionChecked.includesParent=false。
 */
export function findMounts(mainModel, subModel, cat, opts = {}) {
  const mainParts = (mainModel?.parts || []).filter((p) => p && cat.parts[p.part]);
  const subParts = (subModel?.parts || []).filter((p) => p && cat.parts[p.part]);
  if (!mainParts.length || !subParts.length) return [];

  const members = subParts.map((p) => ({ p, def: cat.parts[p.part] }));
  const anchorId = opts.anchor || subModel.anchor || subModel.meta?.anchor || subParts[0].id;
  const anchorEntry = members.find(({ p }) => p.id === anchorId);
  if (!anchorEntry) return [];

  const includeParentCollision = opts.includeParentCollision !== false;
  const mainBoxes = new Map(mainParts.map((p) => [p.id, partBoxes(p, cat.parts[p.part])]));
  const parents = opts.parent ? mainParts.filter((p) => p.id === opts.parent) : mainParts;
  const rots = opts.rot !== undefined ? [opts.rot] : ROTS;
  const maxResults = opts.maxResults ?? 200;
  const aConn = partConnectors(anchorEntry.p, anchorEntry.def);
  const recIndices = opts.receptor !== undefined ? [opts.receptor] : aConn.receptors.map((_, i) => i);

  const results = [];
  for (const parent of parents) {
    const pDef = cat.parts[parent.part];
    const pConn = partConnectors(parent, pDef);
    const studIndices = opts.stud !== undefined ? [opts.stud] : pConn.studs.map((_, i) => i);
    for (const sIdx of studIndices) {
      const stud = pConn.studs[sIdx];
      if (!stud) continue;
      if (opts.dir && stud.dir !== opts.dir) continue;
      for (const rIdx of recIndices) {
        if (!aConn.receptors[rIdx]) continue;
        for (const deg of rots) {
          const placed = transformAssembly3D(members, parent, pDef, sIdx, anchorId, rIdx, deg);
          if (!placed) continue;
          let collided = false;
          const collidedWith = new Set();
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
          for (const cand of placed) {
            const cDef = cat.parts[cand.part];
            const boxes = partBoxes(cand, cDef);
            for (const b of boxes) {
              if (b.x0 < minX) minX = b.x0; if (b.x1 > maxX) maxX = b.x1;
              if (b.y0 < minY) minY = b.y0; if (b.y1 > maxY) maxY = b.y1;
              if (b.z0 < minZ) minZ = b.z0; if (b.z1 > maxZ) maxZ = b.z1;
            }
            for (const other of mainParts) {
              // 父件必须参与碰撞：挂装候选常以组内上片为锚点，下片会穿进父砖。
              // 兼容旧调用方可用 includeParentCollision:false 显式豁免，但结果会被标记。
              if (other.id === parent.id && !includeParentCollision) continue;
              if (partsCollide(cand, cDef, boxes, other, cat.parts[other.part], mainBoxes.get(other.id))) {
                collided = true;
                collidedWith.add(other.id);
                break;
              }
            }
            if (collided) break;
          }
          if (!collided) {
            results.push({
              parent: parent.id,
              parentPart: parent.part,
              stud: sIdx,
              studLabel: stud.label || `${stud.kind}-${sIdx}`,
              studDir: stud.dir,
              studPos: stud.pos,
              anchor: anchorId,
              anchorPart: anchorEntry.p.part,
              anchorReceptor: rIdx,
              rot: deg,
              worldBBox: minX < Infinity ? { x0: r6(minX), x1: r6(maxX), y0: r6(minY), y1: r6(maxY), z0: r6(minZ), z1: r6(maxZ) } : null,
              collisionChecked: { includesParent: includeParentCollision, againstCount: mainParts.length },
              placed,
            });
            if (results.length >= maxResults) return results;
          }
        }
      }
    }
  }
  return results;
}

/**
 * 参数化装配树拓扑级联重算：
 * 1) 具有 rootAt 的根零件先重置 at = [...rootAt]；
 * 2) 沿零件的 snap: { on, stud, receptor, rot, up } 依赖关系拓扑重算子件坐标；
 * 3) 对 model.mounts 中声明的子组件挂载（引用 model.submodels 或组内成员），执行 3D 刚体变换更新坐标；
 * 4) 对挂载在子组件零件之上的后续单件再做一轮拓扑更新。
 *
 * 失败处理（AS-04）：snap 依赖有环、或 snap.on 指向不存在的零件，必须抛结构化错误，
 * 不得「能解的先解、环内的静默保留旧坐标」——旧行为会让非法图通过校验并沿用过期坐标。
 * 出错时 model 保持调用前状态（求解在副本上推进，成功后才写回）。
 */
export function recompute(model, cat) {
  if (!model || !Array.isArray(model.parts)) return model;
  const byId = new Map(model.parts.map((p) => [p.id, p]));
  const mountedGroupIds = new Set((model.mounts || []).map((m) => m.id).filter(Boolean));

  // —— 定位依赖图完整性：悬空引用与环必须先报错，再谈求解 ——
  const snapDeps = new Map();
  for (const p of model.parts) {
    if (p && p.snap && p.snap.on) {
      if (!byId.has(p.snap.on)) {
        const err = new Error(`recompute：零件 ${p.id} 的 snap.on 指向不存在的零件 ${p.snap.on}（缺引用）`);
        err.code = 'snap-missing-reference';
        err.parts = [p.id, p.snap.on];
        throw err;
      }
      snapDeps.set(p.id, p.snap.on);
    }
  }
  if (snapDeps.size) {
    // 三色 DFS 找环；环上节点全部报出
    const WHITE = 0, GREY = 1, BLACK = 2;
    const color = new Map([...snapDeps.keys()].map((id) => [id, WHITE]));
    const stack = [];
    for (const start of snapDeps.keys()) {
      if (color.get(start) !== WHITE) continue;
      const path = [];
      let cur = start;
      while (cur !== undefined && color.get(cur) === WHITE) {
        color.set(cur, GREY);
        path.push(cur);
        cur = snapDeps.get(cur);
      }
      if (cur !== undefined && color.get(cur) === GREY) {
        const at = path.indexOf(cur);
        const cycle = path.slice(at >= 0 ? at : 0).concat(cur);
        const err = new Error(`recompute：snap 定位依赖存在环（${cycle.join(' → ')}），无法拓扑排序；请检查这些零件的 snap.on 是否互相引用`);
        err.code = 'snap-cycle';
        err.parts = cycle;
        throw err;
      }
      for (const id of path) color.set(id, BLACK);
    }
  }

  // 求解缓冲：先写副本，全部成功再一次性写回（原子性）。
  // 注意：后续节点必须读到「待提交态」的父坐标，否则原子缓冲会破坏 snap 的顺序依赖。
  const pending = new Map();   // id -> { at, rot, up, snot }
  const viewOf = (p) => {
    const pend = pending.get(p.id);
    return pend ? { ...p, ...pend } : p;
  };

  // 1. 重置根零件坐标
  for (const p of model.parts) {
    if (Array.isArray(p.rootAt) && p.rootAt.length === 3 && !p.snap) {
      pending.set(p.id, { at: [...p.rootAt] });
    }
  }

  // 辅助：对非挂装组内部（或挂装已就绪）的单件按 snap 树拓扑重算
  const resolveSnaps = (skipSubassemblies = true) => {
    const resolved = new Set();
    for (const p of model.parts) {
      if (skipSubassemblies && p.subassembly && mountedGroupIds.has(p.subassembly)) continue;
      if (!p.snap || !p.snap.on || !byId.has(p.snap.on)) resolved.add(p.id);
    }
    let progress = true;
    while (progress) {
      progress = false;
      for (const p of model.parts) {
        if (resolved.has(p.id)) continue;
        if (skipSubassemblies && p.subassembly && mountedGroupIds.has(p.subassembly)) continue;
        const s = p.snap;
        if (!s || !s.on) { resolved.add(p.id); continue; }
        if (!resolved.has(s.on)) continue;
        const parent = viewOf(byId.get(s.on));   // 读待提交态：父件可能刚刚在本轮被重算
        const pDef = cat.parts[parent.part], cDef = cat.parts[p.part];
        if (pDef && cDef) {
          const snapped = snapPart(
            parent, pDef, s.stud ?? 0,
            { ...p, rot: s.rot !== undefined ? s.rot : (p.rot || 0), ...(s.up !== undefined ? { up: s.up } : { up: undefined }) },
            cDef, s.receptor ?? 0,
            { under: Boolean(s.under) }
          );
          pending.set(p.id, { at: snapped.at, rot: snapped.rot, up: snapped.up, snot: snapped.snot });
        }
        resolved.add(p.id);
        progress = true;
      }
    }
    // 到这里不应再有未解析节点（环与缺引用已在前面抛错）；若仍有，说明依赖图不完整
    const unresolved = model.parts.filter((p) => !resolved.has(p.id)
      && !(skipSubassemblies && p.subassembly && mountedGroupIds.has(p.subassembly)));
    if (unresolved.length) {
      const err = new Error(`recompute：${unresolved.length} 个零件的 snap 依赖无法解析（${unresolved.slice(0, 6).map((p) => p.id).join(', ')}）`);
      err.code = 'snap-unresolved';
      err.parts = unresolved.map((p) => p.id);
      throw err;
    }
  };

  resolveSnaps(true);

  // 2. 处理 mounts 子模型 3D 刚体挂装
  if (Array.isArray(model.mounts)) {
    for (const m of model.mounts) {
      const parent = viewOf(byId.get(m.on));   // 读待提交态：父件可能刚在本轮被重算抬高
      if (!parent || !cat.parts[parent.part]) continue;
      let sourceParts = null;
      if (m.submodel && model.submodels && model.submodels[m.submodel]) {
        const sub = model.submodels[m.submodel];
        // 子模型自身也必须有合法依赖图（递归调用会走同样的环/缺引用检查）
        recompute(sub, cat);
        const prefix = m.prefix ?? `${m.id || m.submodel}_`;
        sourceParts = (sub.parts || []).map((sp) => {
          const pid = m.idMap?.[sp.id] || (byId.has(sp.id) ? sp.id : `${prefix}${sp.id}`);
          return { p: { ...sp, id: pid }, def: cat.parts[sp.part] };
        });
      } else if (m.id) {
        sourceParts = model.parts.filter((p) => p.subassembly === m.id).map((p) => ({ p: viewOf(p), def: cat.parts[p.part] }));
      }
      if (!sourceParts || !sourceParts.length) continue;
      const anchorId = m.anchor || sourceParts[0].p.id;
      const placed = transformAssembly3D(
        sourceParts, parent, cat.parts[parent.part],
        m.stud ?? 0, anchorId, m.anchorReceptor ?? 0, m.rot ?? 0
      );
      if (placed) {
        for (const cand of placed) {
          pending.set(cand.id, { at: cand.at, rot: cand.rot, up: cand.up, snot: cand.snot });
        }
      } else {
        const err = new Error(`recompute：子组件 ${m.id || m.submodel} 无法按锚点 ${anchorId} 扣到父零件 ${parent.id}（接口不匹配或变换后非整数格）`);
        err.code = 'mount-unsolvable';
        err.parts = [parent.id, anchorId];
        throw err;
      }
    }
    // 3. 子模型就位后，若有单件 snap.on 指向子模型内部零件，再做一轮拓扑更新
    mountedGroupIds.clear();
    resolveSnaps(false);
  }

  // 全部成功：一次性写回（原子提交）
  for (const [id, pose] of pending) {
    const target = byId.get(id);
    if (!target) continue;
    if (pose.at) target.at = pose.at;
    if (pose.rot !== undefined) target.rot = pose.rot;
    if (pose.up !== undefined) target.up = pose.up;
    if (pose.snot !== undefined) target.snot = pose.snot;
  }
  return model;
}


// ---------------------------------------------------------------- 模块 / 子组件 / 步骤计划
/** 零件所属模块（兼容 0.1 的 group 字段） */
export const partModule = (p) => p.module ?? p.group ?? null;
export function moduleMap(model) {
  const map = new Map();
  for (const m of model.modules || []) if (m && typeof m.id === 'string' && !map.has(m.id)) map.set(m.id, m);
  return map;
}
/** 沿 parent 链找到最近的“子组件”（subassembly: true）模块 */
export function subOfModule(mods, id) {
  const seen = new Set();
  while (id && mods.has(id) && !seen.has(id)) { seen.add(id); const m = mods.get(id); if (m.subassembly) return id; id = m.parent; }
  return null;
}
/** 模块 id 及其所有祖先 */
export function moduleChain(mods, id) {
  const out = [], seen = new Set();
  while (id && !seen.has(id)) { seen.add(id); out.push(id); id = mods.get(id)?.parent; }
  return out;
}
/**
 * 步骤计划：把零件步骤、无零件的“装配步”（steps[].attach）合并排序，并标出子组件步骤。
 * 返回 { steps:[{n,title,note,parts,attach,sub}], subs: Map(id→{id,label,attachStep,parts,steps}), partSub: Map(partId→subId), mods }
 */
export function stepPlan(model) {
  const mods = moduleMap(model);
  const parts = (model.parts || []).filter((p) => p && typeof p.id === 'string');
  const defs = new Map((model.steps || []).filter((s) => s && Number.isInteger(s.n)).map((s) => [s.n, s]));
  const subs = new Map();
  for (const m of mods.values()) if (m.subassembly) {
    const att = [...defs.values()].find((s) => s.attach === m.id);
    if (att) subs.set(m.id, { id: m.id, label: m.label || m.id, attachStep: att.n, parts: [], steps: [] });
  }
  const partSub = new Map();
  for (const p of parts) { const sid = subOfModule(mods, partModule(p)); if (sid && subs.has(sid)) { partSub.set(p.id, sid); subs.get(sid).parts.push(p.id); } }
  const nums = new Set(parts.map((p) => p.step).filter(Number.isInteger));
  for (const s of subs.values()) nums.add(s.attachStep);
  const steps = [...nums].sort((a, b) => a - b).map((n) => {
    const def = defs.get(n) || {}, ps = parts.filter((p) => p.step === n);
    const ids = [...new Set(ps.map((p) => partSub.get(p.id) || null))];
    const only = ids.length === 1 ? ids[0] : null;
    const sub = only && n < subs.get(only).attachStep ? only : null;
    return { n, title: def.title || '', note: def.note || '', parts: ps.map((p) => p.id), attach: def.attach && subs.has(def.attach) ? def.attach : null, sub, mixed: ids.length > 1 && ids.some(Boolean) };
  });
  for (const s of steps) if (s.sub) subs.get(s.sub).steps.push(s.n);
  return { steps, subs, partSub, mods };
}

// ---------------------------------------------------------------- 校验
export function validate(model, cat, opts = {}) {
  const errors = [], warnings = [], info = [];
  const E = (code, msg, parts = []) => errors.push({ code, msg, parts });
  const W = (code, msg, parts = []) => warnings.push({ code, msg, parts });
  if (!model || typeof model !== 'object') { E('model', '不是有效的 JSON 对象'); return { ok: false, errors, warnings, info }; }
  if (model.format !== FORMAT) W('format', `format 应为 "${FORMAT}"`);
  if (!Array.isArray(model.parts)) { E('parts', 'parts 必须是数组'); return { ok: false, errors, warnings, info }; }

  const byId = new Map(), good = [];
  const looseAt = new Set();     // 1/4 片小数层的零件 id（待连通图确认确实扣在非整数高度凸点上）
  for (const [n, p] of model.parts.entries()) {
    const tag = p && p.id ? p.id : `#${n}`;
    if (!p || typeof p !== 'object') { E('part', `第 ${n} 个零件不是对象`); continue; }
    if (!p.id || typeof p.id !== 'string') { E('id', `第 ${n} 个零件缺少 id`); continue; }
    if (byId.has(p.id)) { E('id-dup', `零件 id 重复：${p.id}`, [p.id]); continue; }
    byId.set(p.id, p);
    const def = cat.parts[p.part];
    if (!def) { E('part-unknown', `${tag}：目录里没有零件 ${p.part}`, [p.id]); continue; }
    if (cat.colors && !cat.colors[String(p.color)]) W('color-unknown', `${tag}：颜色代码 ${p.color} 不在颜色表中`, [p.id]);
    const isSnot = isSnotLike(p);
    if (p.up !== undefined && !UPS.includes(p.up)) { E('up', `${tag}：up 只能是 +y/-y/+z/-z/+x/-x`, [p.id]); continue; }
    if (p.snot !== undefined && !Number.isInteger(p.snot)) { E('snot', `${tag}：snot 必须是整数（沿 up 方向偏移的片数）`, [p.id]); continue; }
    // 目录标记 offGrid（轮毂/轮胎等圆盘件）时 at 允许任意有限数：轮心必然落在格线之外
    const looseAtAllowed = isSnot || def.offGrid;
    if (!Array.isArray(p.at) || p.at.length !== 3 || !p.at.every((v) => looseAtAllowed ? typeof v === 'number' && Number.isFinite(v) : Number.isInteger(v))) { E('at', `${tag}：at 必须是 3 个整数 [x, 层, z]`, [p.id]); continue; }
    // 多高度凸点：up=+y、x/z 为整数格、y 为 1/4 片小数的零件算「暂定合法」，连通图确认后才放行。
    // 已经带 mount/snot/非 +y 的件走原有 SNOT 路径（历史上就允许任意有限数），不受这条约束影响。
    if (isRaisedOffGrid(p) && !p.mount && !p.snot) {
      if (def.offGrid) { /* 圆盘/轮类：轮心必然离格，任意有限 at 合法（穿模由 3D 盒负责） */ }
      else if (Number.isInteger(p.at[0]) && Number.isInteger(p.at[2]) && quarterInteger(p.at[1])) looseAt.add(p.id);
      else { E('at', `${tag}：at 必须是 3 个整数 [x, 层, z]（内腔凸点扣合只放宽 y 到 1/4 片）`, [p.id]); continue; }
    }
    if (!ROTS.includes(p.rot ?? 0)) { E('rot', `${tag}：rot 只能是 0/90/180/270`, [p.id]); continue; }
    if (!Number.isInteger(p.step) || p.step < 1) { E('step', `${tag}：step 必须是 ≥1 的整数`, [p.id]); continue; }
    if (p.status && !['confirmed', 'inferred', 'uncertain'].includes(p.status)) W('status', `${tag}：status 只能是 confirmed / inferred / uncertain`, [p.id]);
    good.push({ p, def });
  }
  const stepNums = new Set((model.steps || []).map((s) => s.n));
  for (const { p } of good) if (model.steps && !stepNums.has(p.step)) W('step-undefined', `${p.id}：第 ${p.step} 步没有在 steps 中定义`, [p.id]);

  // 模块与子组件
  const mods = moduleMap(model), plan = stepPlan(model);
  if (model.modules !== undefined && !Array.isArray(model.modules)) E('modules', 'modules 必须是数组');
  const modSeen = new Set();
  for (const m of Array.isArray(model.modules) ? model.modules : []) {
    if (!m || typeof m.id !== 'string' || !m.id) { E('module-id', '模块缺少 id'); continue; }
    if (modSeen.has(m.id)) E('module-id', `模块 id 重复：${m.id}`); modSeen.add(m.id);
    if (m.parent !== undefined && !mods.has(m.parent)) E('module-parent', `模块 ${m.id}：parent 指向不存在的模块 ${m.parent}`);
    { let id = m.parent, n = 0; while (id && n++ < 64 && id !== m.id) id = mods.get(id)?.parent; if (id === m.id) E('module-cycle', `模块 ${m.id}：parent 形成了循环`); }
    if (m.explode !== undefined && !(Array.isArray(m.explode) && m.explode.length === 3 && m.explode.every((v) => typeof v === 'number'))) E('module-explode', `模块 ${m.id}：explode 必须是 3 个数字 [x格, 层(片), z格]`);
    if (m.subassembly && !plan.subs.has(m.id)) E('sub-attach', `子组件 ${m.id}：需要在 steps 里加一个装配步，例如 { "n": 15, "title": "装上${m.label || m.id}", "attach": "${m.id}" }`);
  }
  const unknownMod = good.filter(({ p }) => partModule(p) != null && !mods.has(partModule(p))).map(({ p }) => p.id);
  if (unknownMod.length && mods.size) W('module-unknown', `${unknownMod.length} 个零件的 module 没有在 modules 中定义：${unknownMod.slice(0, 8).join(', ')}`, unknownMod);
  for (const st of model.steps || []) if (st && st.attach !== undefined) {
    if (!mods.has(st.attach)) E('attach', `第 ${st.n} 步：attach 指向不存在的模块 ${st.attach}`);
    else if (!mods.get(st.attach).subassembly) E('attach', `第 ${st.n} 步：模块 ${st.attach} 不是子组件（需要 subassembly: true）`);
  }
  for (const sub of plan.subs.values()) {
    const late = good.filter(({ p }) => plan.partSub.get(p.id) === sub.id && p.step >= sub.attachStep).map(({ p }) => p.id);
    if (late.length) E('attach-order', `子组件 ${sub.id} 在第 ${sub.attachStep} 步装上，但 ${late.slice(0, 6).join(', ')} 的 step 不早于装配步`, late);
    if (!sub.parts.length) W('sub-empty', `子组件 ${sub.id} 没有零件`);
  }
  for (const st of plan.steps) if (st.mixed) W('sub-mixed', `第 ${st.n} 步同时包含子组件和主体的零件，建议分成两步`, st.parts);

  // 1) 标准整数网格占位冲突（snot 竖直偏移件除外：其物理占层与 at[1] 不一致，交由下方 3D 包围盒检查）
  //    带 boxes 多盒分解的凹形件（座舱槽 / 轮拱 / 双阶斜坡）不参与整格占用：其空腔格在网格上「有格无料」，
  //    内饰件必须能放进去——这类件的穿模由下方 3D 盒检查（更严）负责。
  const occ = new Map();
  for (const { p, def } of good) {
    if (def.occupies === false || def.offGrid || (p.up && p.up !== '+y') || p.snot || !p.at.every(Number.isInteger)) continue;
    if (Array.isArray(def.boxes) && def.boxes.length) continue;
    for (const f of footprint(p, def)) for (let y = p.at[1]; y < p.at[1] + def.h; y++) {
      const key = `${f.x},${y},${f.z}`, o = occ.get(key);
      if (o && o !== p.id) {
        if (!warnings.some((w) => w.code === 'overlap' && w.parts.includes(o) && w.parts.includes(p.id)))
          E('overlap', `${o} 与 ${p.id} 在格子 [${f.x}, ${y}, ${f.z}] 重叠`, [o, p.id]);
      } else occ.set(key, p.id);
    }
  }
  // 2) 全方向 3D 实体包围盒防穿模检查（覆盖全部 SNOT 侧装件、非整数偏移件与支架）
  // P0-b：目录条目 schema 缺陷（如 bracket 缺 vH/dir）转为校验错误，不再让异常炸掉整个 validate
  const boxesMap = new Map();
  for (const { p, def } of good) {
    try { boxesMap.set(p.id, partBoxes(p, def)); }
    catch (e) { E('part-schema', `${p.id}：${e.message}`, [p.id]); boxesMap.set(p.id, []); }
  }
  // CP-02：连接器表提前构建（两个 O(n²) 循环共用）；每件按自身连接器外悬算外扩 AABB，
  // 用栅格裁剪出「可能穿模/可能连接」的候选对。near[i] 升序 → 幸存 (i,j) 遍历顺序与
  // 朴素双重循环一致，错误与连接的落盘顺序不变（行为保持，见 tools/perf-cp02.mjs 指纹对账）。
  const connMap = new Map();
  for (const { p, def } of good) {
    try { connMap.set(p.id, partConnectors(p, def)); }
    catch (e) { connMap.set(p.id, { studs: [], receptors: [] }); }
  }
  const near = nearPairCandidates(good.map(({ p, def }) => partAabbWithMargin(p, def, connMap.get(p.id))));
  for (let i = 0; i < good.length; i++) {
    const a = good[i].p;
    const aDef = a.def ?? cat.parts[a.part];
    for (const j of near[i]) {
      const b = good[j].p;
      const bDef = cat.parts[b.part];
      // 快速跳过：两个都是「标准整数格水平实心件」时，整格占用检查（上一步）已经覆盖，
      // 不必再做 3D 盒检查。但只要**任一方带多盒分解**（凹形件：卫星锅/底盘座舱槽/轮拱），
      // 整格占用就会因「空腔格有格无料」而跳过它，此时必须走 3D 盒检查——否则
      // 「4740 凹陷件与相邻砖重叠」这类组合两条路径都跳过，穿模直接漏检。
      const hasMultiBox = (d) => Array.isArray(d?.boxes) && d.boxes.length > 0;
      if ((!a.up || a.up === '+y') && (!b.up || b.up === '+y') && a.at.every(Number.isInteger) && b.at.every(Number.isInteger) && !a.snot && !b.snot
        && !aDef?.offGrid && !bDef?.offGrid && !hasMultiBox(aDef) && !hasMultiBox(bDef)) continue;
      const hit = partsCollide(a, aDef, boxesMap.get(a.id), b, bDef, boxesMap.get(b.id));
      if (hit) E('overlap', `${a.id} 与 ${b.id} 在格子 [${hit[0]}, ${hit[1]}, ${hit[2]}] 重叠（3D 穿模）`, [a.id, b.id]);
    }
  }
  // 去重重叠报告
  const seen = new Set();
  for (let i = errors.length - 1; i >= 0; i--) if (errors[i].code === 'overlap') {
    const k = errors[i].parts.slice().sort().join('|'); if (seen.has(k)) errors.splice(i, 1); else seen.add(k);
  }

  // 凸点连接图（标准 +y 网格凸点 + 3D 物理连接器匹配 + mount 显式挂载）
  const studs = new Map();               // "x,z,layer" -> [partId]
  for (const { p, def } of good) if ((!p.up || p.up === '+y') && p.at.every(Number.isInteger) && !p.snot) for (const f of footprint(p, def)) if (f.stud) {
    const k = `${f.x},${f.z},${topLayer(p, def)}`; (studs.get(k) || studs.set(k, []).get(k)).push(p.id);
  }
  const adj = new Map(good.map(({ p }) => [p.id, new Set()]));
  const link = (a, b) => { if (adj.has(a) && adj.has(b)) { adj.get(a).add(b); adj.get(b).add(a); } };
  for (const { p, def } of good) {
    if (def.kind === 'door' || (p.up && p.up !== '+y') || !p.at.every(Number.isInteger) || p.snot) continue;
    for (const f of footprint(p, def)) for (const id of studs.get(`${f.x},${f.z},${p.at[1]}`) || []) if (id !== p.id) link(p.id, id);
  }
  // 3D 连接器自动物理匹配（凸点对底孔、把柄对夹子、销对销孔）——connMap 已在上方构建
  for (let i = 0; i < good.length; i++) {
    const a = good[i];
    for (const j of near[i]) {
      const b = good[j];
      if (adj.get(a.p.id).has(b.p.id)) continue;
      if (partsConnected(a.p, a.def, b.p, b.def, connMap.get(a.p.id), connMap.get(b.p.id))) {
        link(a.p.id, b.p.id);
      }
    }
  }
  for (const { p, def } of good) if (p.mount) {
    if (!byId.has(p.mount)) E('mount', `${p.id}：mount 指向不存在的零件 ${p.mount}`, [p.id]);
    else if (def.kind === 'door') link(p.id, p.mount);
    else if (!adj.get(p.id).has(p.mount)) E('mount-disconnected', `${p.id}：与 mount 指定的父零件 ${p.mount} 之间没有真实物理连接（凸点未对准底孔或夹口未对准把柄）`, [p.id, p.mount]);
  }
  for (const { p, def } of good) if (def.kind === 'door' && !p.mount) W('door-mount', `${p.id}：门需要用 mount 指明安装在哪个门框上`, [p.id]);

  // —— 子组件刚体挂装（builder.addAssembly 写入的 subassembly / subassemblyAnchor）——
  // 语义：同一 subassembly 组内的零件是一个刚体；组内连接已在 addAssembly 时逐件用 snapPart 语义核对。
  // 校验三件事：
  //   ① 锚点唯一且属于组内；② 锚点真实连到组外（否则整组悬空）；
  //   ③ 组内必须形成连通刚体——除锚点外每件都要通过真实连接（或其自身 snap.on）连到组内其他件。
  // 第 ③ 条是 EN-01 的核心：只声明 subassembly 字段不能产生连接边。历史实现在这里直接把
  // 组员与锚点连起来（supportAdj 加边），把「远处散件声明进子组件」也当成已支撑；现在改为
  // 先算组内真实连通分量，非连通成员逐一报错，并且不为其伪造支撑边。
  const supportAdj = new Map([...adj].map(([id, set]) => [id, new Set(set)]));
  const groups = new Map();
  for (const { p } of good) if (typeof p.subassembly === 'string' && p.subassembly) {
    if (!groups.has(p.subassembly)) groups.set(p.subassembly, []);
    groups.get(p.subassembly).push(p);
  }
  for (const [gid, members] of groups) {
    const ids = members.map((p) => p.id);
    const anchors = [...new Set(members.map((p) => p.subassemblyAnchor).filter(Boolean))];
    if (anchors.length !== 1 || !byId.has(anchors[0]) || !ids.includes(anchors[0])) {
      E('subassembly-anchor', `子组件 ${gid}：subassemblyAnchor 必须唯一且指向组内零件（收到 ${JSON.stringify(anchors)}）`, ids);
      continue;
    }
    const anchor = anchors[0];
    const memberSet = new Set(ids);
    const outside = [...adj.get(anchor)].filter((x) => !memberSet.has(x));
    if (!outside.length) E('subassembly-anchor', `子组件 ${gid} 的锚点零件 ${anchor} 没有连到组外任何零件（整组悬空）`, [anchor]);

    // 组内真实连通性：只用真实连接图 adj（凸点/夹口/销/轮）+ 零件自身的 snap.on（若是组内件）
    const insideAdj = new Map(ids.map((id) => [id, new Set()]));
    for (const id of ids) {
      for (const nb of adj.get(id) || []) if (memberSet.has(nb)) insideAdj.get(id).add(nb);
      const p = byId.get(id);
      // snap.on 组内引用也是一条真实的「由上件定位到此件」的证据（add 时已用 snapPart 校验过扣合）
      if (p?.snap?.on && memberSet.has(p.snap.on)) { insideAdj.get(id).add(p.snap.on); insideAdj.get(p.snap.on).add(id); }
      // mount 指向组内件同理
      if (p?.mount && memberSet.has(p.mount)) { insideAdj.get(id).add(p.mount); insideAdj.get(p.mount).add(id); }
    }
    const seen = new Set([anchor]);
    const q = [anchor];
    while (q.length) {
      const cur = q.pop();
      for (const nb of insideAdj.get(cur) || []) if (!seen.has(nb)) { seen.add(nb); q.push(nb); }
    }
    const detached = ids.filter((id) => !seen.has(id));
    if (detached.length) {
      E('subassembly-disconnected', `子组件 ${gid}：${detached.length} 个零件与其他成员没有真实物理连接，不能作为单一刚体（声明 subassembly 不会产生连接边）：${detached.slice(0, 10).join(', ')}${detached.length > 10 ? ' …' : ''}`, detached);
      // 不为断开成员伪造支撑边；它们若真悬空，会由下面的 floating 检查独立报出
      for (const id of ids) if (seen.has(id) && id !== anchor) { supportAdj.get(anchor).add(id); supportAdj.get(id).add(anchor); }
      continue;
    }
    for (const id of ids) if (id !== anchor) {
      supportAdj.get(anchor).add(id); supportAdj.get(id).add(anchor);
    }
  }
  // 多高度凸点：小数层零件必须真的扣在「非整数高度顶凸点」上，否则退回 at 错误（防手写小数坐标蒙混过关）
  for (const id of looseAt) {
    const entry = good.find(({ p }) => p.id === id);
    if (!entry) continue;
    const mine = connMap.get(id);
    const at = (mine?.studs || []).concat(mine?.receptors || []);
    let ok = false;
    for (const nid of adj.get(id)) {
      const oConn = connMap.get(nid);
      if (!oConn) continue;
      const theirs = (oConn.studs || []).concat(oConn.receptors || []);
      // 合法条件：本件与邻居有一对连接器重合，且该重合点位于「非整数层」（内腔凸点 ly=0.5/1.5、
      // 或人仔颈柱高度 5.5 片等）——也就是说小数层确实是被这个非整数高度的接口顶上来的。
      const hit = at.some((c) => theirs.some((d) =>
        Math.abs(c.pos[0] - d.pos[0]) <= 0.08 && Math.abs(c.pos[1] - d.pos[1]) <= 0.2 && Math.abs(c.pos[2] - d.pos[2]) <= 0.08
        && Math.abs(c.pos[1] * 4 - Math.round(c.pos[1] * 4)) < 1e-6 && Math.abs(c.pos[1] - Math.round(c.pos[1])) > 1e-6));
      if (hit) { ok = true; break; }
    }
    if (!ok) E('at', `${id}：at 必须是 3 个整数 [x, 层, z]（小数层只有扣在非整数高度的内腔凸点上才合法）`, [id]);
  }

  const rawGround = good.length ? Math.min(...good.map(({ p }) => p.at[1])) : 0;
  const rawTop = good.length ? Math.max(...good.map(({ p }) => p.at[1])) : 0;
  // 翻面搭建（flip）最小可行方案：
  //  ① 负层（at[1] < 0）是合法的「底部倒装」——不报 ground 提示；支撑链仍按最底层向上推导，
  //     因此 step 1..3 的倒装件必须最终接到同一支撑链上（validate 的 floating / step-order 照常判定）。
  //  ② 底盘整体翻面作业（模型 y 反转）时，在模型顶层声明 flip: true（或 meta.flip: true）：
  //     支撑基准面改为最上层（施工时朝上的那一面是翻转后的底盘），无需改写任何零件坐标。
  const flip = model.flip === true || model.meta?.flip === true;
  const ground = flip ? rawTop : rawGround;
  if (good.length && !flip && rawGround > 0) W('ground', `最低零件在第 ${rawGround} 层，建议从第 0 层开始`);
  // 支撑链推导：从基准面出发。翻面搭建（flip）时基准面是最上层，逐层「向下」走
  // （从第 n 层能挂到第 n-1 层的零件也算支撑——倒装作业时后放的是更靠上的一层）。
  const reach = (filter, g0 = ground) => {
    const ok = new Set(), q = [];
    for (const { p } of good) if (filter(p) && (p.at[1] === g0 || (g0 < 0 && p.at[1] === 0))) { ok.add(p.id); q.push(p.id); }
    while (q.length) { const a = q.pop(); for (const b of supportAdj.get(a)) if (!ok.has(b) && filter(byId.get(b))) { ok.add(b); q.push(b); } }
    if (!flip) return ok;
    // flip：把「已支撑」集合沿支撑图再扩一圈（上下相邻层都算），直到收敛
    const allIds = new Set(good.filter(({ p }) => filter(p)).map(({ p }) => p.id));
    let grew = true;
    while (grew) {
      grew = false;
      for (const id of allIds) {
        if (ok.has(id)) continue;
        if ([...supportAdj.get(id)].some((n) => ok.has(n))) { ok.add(id); q.push(id); grew = true; }
      }
    }
    return ok;
  };
  const all = reach(() => true);
  const floating = good.filter(({ p }) => !all.has(p.id)).map(({ p }) => p.id);
  if (floating.length) E('floating', `${floating.length} 个零件没有连到底座（悬空）：${floating.slice(0, 12).join(', ')}${floating.length > 12 ? ' …' : ''}`, floating);
  // 步骤顺序：每一步结束时，已放的零件都应连到底座；子组件在装上之前，只需连到它自己的最底层
  const steps = [...new Set(good.map(({ p }) => p.step))].sort((a, b) => a - b);
  const subOf = (p) => plan.partSub.get(p.id), attachAt = (p) => plan.subs.get(subOf(p))?.attachStep ?? -Infinity;
  for (const s of steps) {
    const ok = reach((p) => p.step <= s && (!subOf(p) || attachAt(p) <= s));
    const bad = good.filter(({ p }) => p.step === s && !subOf(p) && all.has(p.id) && !ok.has(p.id)).map(({ p }) => p.id);
    if (bad.length) W('step-order', `第 ${s} 步：${bad.join(', ')} 在这一步还没有支撑（支撑它的零件在后面的步骤）`, bad);
  }
  for (const sub of plan.subs.values()) {
    const mine = good.filter(({ p }) => subOf(p) === sub.id); if (!mine.length) continue;
    const g0 = Math.min(...mine.map(({ p }) => p.at[1]));
    for (const s of [...new Set(mine.map(({ p }) => p.step))].sort((a, b) => a - b)) {
      const ok = reach((p) => subOf(p) === sub.id && p.step <= s, g0);
      const bad = mine.filter(({ p }) => p.step === s && !ok.has(p.id)).map(({ p }) => p.id);
      if (bad.length) W('step-order', `子组件 ${sub.id} 第 ${s} 步：${bad.join(', ')} 没有连到子组件上`, bad);
    }
  }
  // 可开合设计
  const mechIds = new Set();
  for (const m of model.mechanisms || []) {
    const tag = m.id || '(无 id)';
    if (!m.id) E('mech-id', '可开合设计缺少 id');
    else if (mechIds.has(m.id)) E('mech-id', `可开合设计 id 重复：${m.id}`); else mechIds.add(m.id);
    if (!['hinge', 'slide', 'removable'].includes(m.type)) E('mech-type', `${tag}：type 只能是 hinge / slide / removable`);
    const missing = (m.parts || []).filter((id) => !byId.has(id));
    if (!m.parts || !m.parts.length) E('mech-parts', `${tag}：parts 不能为空`);
    if (missing.length) E('mech-parts', `${tag}：引用了不存在的零件 ${missing.join(', ')}`);
    const vec = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number');
    if (m.type === 'hinge' && (!vec(m.pivot) || !vec(m.axis) || !Array.isArray(m.range))) E('mech-hinge', `${tag}：合页需要 pivot、axis、range`);
    if (m.type === 'slide' && (!vec(m.axis) || !Array.isArray(m.range))) E('mech-slide', `${tag}：滑动需要 axis、range`);
    if (m.type === 'removable' && !vec(m.offset)) E('mech-removable', `${tag}：可拆卸需要 offset`);
    if (!m.evidence || !m.evidence.length) W('mech-evidence', `${tag}：没有关联打开状态的照片`);
  }
  // 证据与置信度
  const inferred = good.filter(({ p }) => p.status === 'inferred').map(({ p }) => p.id);
  const uncertain = good.filter(({ p }) => p.status === 'uncertain').map(({ p }) => p.id);
  if (inferred.length) info.push({ code: 'inferred', msg: `${inferred.length} 个零件是推断的（照片里看不到）`, parts: inferred });
  if (uncertain.length) info.push({ code: 'uncertain', msg: `${uncertain.length} 个零件存疑，需要人工确认`, parts: uncertain });
  if (opts.photos) {
    const ids = new Set((opts.photos.photos || []).map((ph) => ph.id));
    const bad = [];
    for (const { p } of good) for (const e of p.evidence || []) if (!ids.has(e)) bad.push(`${p.id}→${e}`);
    for (const m of model.mechanisms || []) for (const e of m.evidence || []) if (!ids.has(e)) bad.push(`${m.id}→${e}`);
    if (bad.length) W('evidence', `${bad.length} 处证据照片在照片清单里找不到：${bad.slice(0, 8).join(', ')}`);
  }
  // 连通分量统计与反地摊门禁（submodel / strictAssembly）
  const compVisited = new Set();
  const components = [];
  for (const { p } of good) {
    if (compVisited.has(p.id)) continue;
    const comp = [], q = [p.id];
    compVisited.add(p.id);
    while (q.length) {
      const cur = q.pop();
      comp.push(cur);
      for (const nxt of supportAdj.get(cur) || []) {
        if (!compVisited.has(nxt)) { compVisited.add(nxt); q.push(nxt); }
      }
    }
    components.push(comp);
  }
  components.sort((a, b) => b.length - a.length);
  const largestComp = components[0] || [];
  const largestRatio = good.length ? r6(largestComp.length / good.length) : 1;

  const isSubmodelMode = opts.submodel === true || model.meta?.submodel === true;
  if (isSubmodelMode && good.length > 1 && components.length > 1) {
    const detached = components.slice(1).flat();
    E('submodel-disconnected', `子模型必须 100% 物理扣合成单一连通刚体，当前存在 ${components.length} 个分离连通块（分离零件：${detached.slice(0, 10).join(', ')}）`, detached);
  }

  const isStrictAssembly = opts.strictAssembly === true || model.meta?.strictAssembly === true;
  if (isStrictAssembly && good.length > 1) {
    const mainCompSet = new Set(largestComp);
    const isAccessoryPart = (p, def) =>
      p.accessory === true || partModule(p) === 'accessories' || partModule(p) === 'minifig' || Boolean(def?.minifig);
    const scatteredBody = good
      .filter(({ p, def }) => !mainCompSet.has(p.id) && !isAccessoryPart(p, def))
      .map(({ p }) => p.id);
    const minRatio = opts.minComponentRatio ?? 0.80;
    if (scatteredBody.length > 0 || largestRatio < minRatio) {
      const targetParts = scatteredBody.length ? scatteredBody : components.slice(1).flat();
      E(
        'scattered-parts-tray',
        `主干最大连通分量占比仅 ${(largestRatio * 100).toFixed(1)}%（共 ${components.length} 个连通块），发现 ${targetParts.length} 个未装上主体的散落零件（严禁摆地摊充数）：${targetParts.slice(0, 12).join(', ')}${targetParts.length > 12 ? ' …' : ''}`,
        targetParts
      );
    }
  }

  const stats = {
    parts: good.length, steps: plan.steps.length, modules: mods.size, subassemblies: plan.subs.size, mechanisms: (model.mechanisms || []).length,
    confirmed: good.length - inferred.length - uncertain.length, inferred: inferred.length, uncertain: uncertain.length,
    connectedComponents: components.length, largestComponentRatio: largestRatio,
  };
  return { ok: errors.length === 0, errors, warnings, info, stats };
}

// ---------------------------------------------------------------- 零件清单
export function bom(model, cat, filter = () => true) {
  const m = new Map();
  for (const p of model.parts || []) {
    if (!filter(p)) continue;
    const k = `${p.part}|${p.color}`;
    const e = m.get(k) || { part: p.part, color: p.color, qty: 0, def: cat.parts[p.part], col: cat.colors?.[String(p.color)] };
    e.qty++; m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.qty - a.qty || String(a.part).localeCompare(String(b.part)));
}

// ---------------------------------------------------------------- LDraw 导出
const fmt = (v) => { const n = Math.round(v * 1000) / 1000; return Object.is(n, -0) ? '0' : String(n); };
export function ldrawLine(p, def) {
  const rot = p.rot || 0, c = partCenter(p, def), o = def.ldrawOrigin || [0, def.h, 0];
  const [ox, oz] = rotXZ(o[0], o[2], rot);
  const gx = c[0] + ox, gy = c[1] + o[1], gz = c[2] + oz;
  const t = (rot * Math.PI) / 180, co = Math.round(Math.cos(t)), s = Math.round(Math.sin(t));
  const M = [co, 0, -s, 0, 1, 0, s, 0, co];             // 本格式 → LDraw：绕 X 轴转 180°（y 朝下、z 朝后）
  return `1 ${p.color} ${fmt(gx * 20)} ${fmt(-gy * 8)} ${fmt(-gz * 20)} ${M.map(fmt).join(' ')} ${p.part}.dat`;
}
/** 有子组件时导出 MPD（主模型 + 每个子组件一个子文件），LPub3D / Studio 可直接按子组件生成说明书 */
export const ldrawExt = (model) => (stepPlan(model).subs.size ? '.mpd' : '.ldr');
const subFile = (id) => `${String(id).replace(/[^\w.-]+/g, '_')}.ldr`;
/** 子组件子文件坐标系 → 主模型：以锚点零件的世界原点（零件底面中心）作为子文件原点，
 *  子文件内所有零件坐标减去锚点原点。挂装行 = 单位旋转 + 锚点平移（--rot 变换已在零件摆放坐标里体现）。 */
function subOrigin(model, cat) {
  const parts = (model.parts || []).filter((p) => p && cat.parts[p.part]);
  const byId = new Map(parts.map((p) => [p.id, p]));
  const mods = moduleMap(model);
  const out = new Map();
  const groups = new Map();
  for (const p of parts) if (typeof p.subassembly === 'string' && p.subassembly) {
    if (!groups.has(p.subassembly)) groups.set(p.subassembly, []);
    groups.get(p.subassembly).push(p);
  }
  for (const [gid, members] of groups) {
    const anchorId = members.find((p) => p.id === p.subassemblyAnchor)?.id || members[0].id;
    const anchor = byId.get(anchorId);
    if (!anchor) continue;
    const entry = { anchor: anchorId, origin: partCenter(anchor, cat.parts[anchor.part]) };
    out.set(gid, entry);
    // MPD 按「子组件模块」分文件（module 指向 subassembly:true 的模块），因此同一原点也要按模块 id 登记
    for (const m of members) {
      const mid = partModule(m);
      if (mid && mods.get(mid)?.subassembly) out.set(mid, entry);
    }
  }
  return out;
}
export function toLDraw(model, cat) {
  const name = (model.meta?.name || 'model').replace(/[\r\n]/g, ' '), plan = stepPlan(model);
  const byId = new Map((model.parts || []).map((p) => [p.id, p]));
  // 子组件（builder.addAssembly 的刚体组）需要按组内坐标局部化：子文件里的零件相对锚点原点书写，
  // 主文件用「锚点原点平移」把整组挂回去。普通模块子组件（无 subassembly 标记）保持原路径（原点一致）。
  const rig = subOrigin(model, cat);
  // 子组件子文件坐标系：以锚点零件的 LDraw 位置为原点。LDraw 变换是「旋转 + 平移」，
  // 因此把主模型里算好的零件行整体减去锚点的平移分量（前 3 个数字）即可——对任意 rot/up 都精确，
  // 不需要在引擎坐标里做位移换算。挂装行 = 同一平移（旋转为单位阵）。
  const ldrawPos = (line) => line.split(/\s+/).slice(2, 5).map(Number);
  const subOffset = (gid) => {
    const r = rig.get(gid);
    if (!r) return [0, 0, 0];
    const anchor = byId.get(r.anchor);
    const adef = anchor && cat.parts[anchor.part];
    return anchor && adef ? ldrawPos(ldrawLine(anchor, adef)) : [0, 0, 0];
  };
  const shiftLine = (line, off) => {
    const t = line.split(/\s+/);
    for (let i = 0; i < 3; i++) t[2 + i] = fmt(Number(t[2 + i]) - off[i]);
    return t.join(' ');
  };
  const partLine = (p, def, off) => {
    const line = ldrawLine(p, def);
    return off ? shiftLine(line, off) : line;
  };
  const head = (title, file) => [`0 ${title}`, `0 Name: ${file}`, `0 Author: ${model.meta?.author || 'brickkit'}`, `0 // 由 brickkit 从 brickbuild ${model.version || VERSION} 导出`];
  const body = (steps, origin = null) => {
    const lines = [];
    steps.forEach((st, i) => {
      if (st.title) lines.push(`0 // 第 ${st.n} 步：${st.title}`);
      for (const id of st.parts) {
        const p = byId.get(id), def = cat.parts[p.part];
        if (!def) { lines.push(`0 // 跳过未知零件 ${p.part}`); continue; }
        lines.push(partLine(p, def, origin));
      }
      if (st.attach) {
        // 子组件挂装：子文件以锚点 LDraw 位置为原点 → 挂装行就是该平移（单位旋转）。
        // 普通模块子组件（无 subassembly 刚体组）偏移为 0，保持原路径。
        const off = subOffset(st.attach);
        lines.push(`1 16 ${off.map(fmt).join(' ')} 1 0 0 0 1 0 0 0 1 ${subFile(st.attach)}`);
      }
      if (i < steps.length - 1) lines.push('0 STEP');
    });
    return lines;
  };
  const mech = (model.mechanisms || []).map((m) => `0 // 可开合：${m.id} (${m.type}) ${m.label || ''} 零件 ${(m.parts || []).join(',')}`);
  const main = plan.steps.filter((s) => !s.sub && !s.parts.some((id) => plan.partSub.has(id)) || s.attach);
  if (!plan.subs.size) return [...head(name, `${name}.ldr`), ...body(plan.steps), ...mech].join('\n') + '\n';
  const out = ['0 FILE main.ldr', ...head(name, 'main.ldr'), ...body(main), ...mech, '0 NOFILE'];
  for (const sub of plan.subs.values()) {
    const steps = plan.steps.filter((s) => s.sub === sub.id || (!s.sub && s.parts.length && s.parts.every((id) => plan.partSub.get(id) === sub.id)));
    const off = subOffset(sub.id);
    out.push(`0 FILE ${subFile(sub.id)}`, ...head(`子组件 · ${sub.label}`, subFile(sub.id)), ...body(steps, off), '0 NOFILE');
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- 照片完整性检查
const angDist = (a, b) => { const d = Math.abs((((a - b) % 360) + 360) % 360); return Math.min(d, 360 - d); };
export const PHOTO_SLOTS = [
  ...[0, 45, 90, 135, 180, 225, 270, 315].map((az) => ({ id: `orbit-${az}`, group: '基础外观 · 斜上方一圈', az, el: [15, 50], hint: `方位 ${az}°、俯角约 30°` })),
  ...[0, 90, 180, 270].map((az) => ({ id: `flat-${az}`, group: '基础外观 · 平视', az, el: [-10, 15], hint: `方位 ${az}°、相机与模型同高` })),
  { id: 'top', group: '基础外观 · 顶视', el: [70, 90], hint: '正上方往下拍' },
  { id: 'bottom', group: '基础外观 · 底视', kind: 'bottom', hint: '翻过来拍底面；不能翻就在 skipped 里说明原因' },
];
export function checkPhotos(set, model) {
  const photos = (set && set.photos) || [], missing = [], warnings = [], have = [];
  const skipped = new Map(((set && set.skipped) || []).map((s) => [s.slot, s.reason]));
  const ext = photos.filter((p) => (p.kind === 'exterior' || p.kind === 'bottom') && (!p.state || p.state === 'closed'));
  for (const slot of PHOTO_SLOTS) {
    const hit = slot.kind === 'bottom'
      ? ext.find((p) => p.kind === 'bottom' || (p.elevation ?? 0) <= -60)
      : ext.find((p) => p.kind === 'exterior' && typeof p.elevation === 'number' && p.elevation >= slot.el[0] && p.elevation <= slot.el[1] && (slot.az === undefined || angDist(p.azimuth ?? 999, slot.az) <= 20));
    if (hit) have.push({ slot: slot.id, photo: hit.id });
    else if (skipped.has(slot.id)) have.push({ slot: slot.id, skipped: skipped.get(slot.id) });
    else missing.push({ slot: slot.id, group: slot.group, hint: slot.hint });
  }
  const mechs = new Map();
  for (const m of (set && set.mechanisms) || []) mechs.set(m.id, m);
  for (const m of (model && model.mechanisms) || []) if (!mechs.has(m.id)) mechs.set(m.id, m);
  for (const m of mechs.values()) {
    const mp = photos.filter((p) => p.mechanism === m.id);
    const open = mp.filter((p) => p.state === 'open');
    const az = new Set(open.map((p) => Math.round((p.azimuth ?? -1) / 45)));
    const label = m.label || m.id;
    if (open.length < 2 || az.size < 2) missing.push({ slot: `mech-${m.id}-open`, group: `可开合 · ${label}`, hint: '完全打开状态，至少 2 个不同角度' });
    if (!mp.some((p) => p.kind === 'interior')) missing.push({ slot: `mech-${m.id}-interior`, group: `可开合 · ${label}`, hint: '打开后露出的内部，至少 1 张' });
    if (m.type === 'removable' && mp.filter((p) => p.kind === 'module').length < 2) missing.push({ slot: `mech-${m.id}-module`, group: `可开合 · ${label}`, hint: '取下的部件单独拍顶面和底面各 1 张' });
    if (m.type === 'hinge' || m.type === 'slide') if (!mp.some((p) => p.state === 'half')) warnings.push({ code: 'mech-half', msg: `${label}：建议补一张半开状态，方便判断转轴/滑轨位置` });
  }
  const ids = new Set();
  for (const p of photos) {
    if (!p.id) warnings.push({ code: 'photo-id', msg: `有照片缺少 id（${p.file || '未知文件'}）` });
    else if (ids.has(p.id)) warnings.push({ code: 'photo-dup', msg: `照片 id 重复：${p.id}` }); else ids.add(p.id);
    if (p.width && p.height && Math.max(p.width, p.height) < 3000) warnings.push({ code: 'resolution', msg: `${p.id}：长边 ${Math.max(p.width, p.height)}px，低于 3000px` });
  }
  if (!photos.some((p) => p.kind === 'detail')) warnings.push({ code: 'detail', msg: '没有细节特写；小零件、侧面拼装处建议补拍' });
  if (!(set && set.capture && set.capture.reference)) warnings.push({ code: 'reference', msg: 'capture.reference 未填写：建议垫 8mm 方格纸或乐高底板作为尺寸参照' });
  // 审计回归（docs/审计-5c1c2b9.md P1）：cli check-photos 打了 _missingFile 标记的照片说明文件不存在，
  // 机位覆盖再全也不能算 complete；同一张 file 被标成两个方位角差 >100° 的机位视为照片冲突。
  const missingFiles = photos.filter((p) => p._missingFile).map((p) => p.id);
  const byFile = new Map();
  for (const p of photos) if (p.file) { if (!byFile.has(p.file)) byFile.set(p.file, []); byFile.get(p.file).push(p); }
  for (const [file, group] of byFile) for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
    const a = group[i], b = group[j];
    if (typeof a.azimuth !== 'number' || typeof b.azimuth !== 'number') continue;
    const d = angDist(a.azimuth, b.azimuth);
    if (d > 100) warnings.push({ code: 'photo-conflict', msg: `${a.id} 与 ${b.id} 使用同一文件 ${file}，但方位角 ${a.azimuth}° 与 ${b.azimuth}° 相差 ${d}°，疑似同一张照片被标成两个机位` });
  }
  return { complete: missing.length === 0 && missingFiles.length === 0, total: photos.length, have, missing, warnings, missingFiles };
}
