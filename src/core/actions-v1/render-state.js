// renderState v1：带接口标号的渲染视图（2D 像素 ↔ 3D 接口映射）。
//
// 责任边界（PRD §9.2 MV-01、第 13 节文件所有权）：
//   A 负责「相机与投影的权威口径 + 标号生成」，B 负责「把标号画到图上、把模型选中的标号解析回动作」。
//   本模块不渲染像素、不写 SVG/PNG，只输出可复核的几何与映射表（以及给 B 的消费夹具）。
//
// 相机口径直接取自 src/viewer/main.js，逐项对齐（改那两处必须同步改这里，见 CAMERA_CONTRACT）：
//   - 世界坐标：X = 格, Y = 片×0.4 = 格, Z = 格；即 core 的 [x, y片, z] → world [x, y*PLATE, z]
//   - 观察方向：dir = [sin(az)cos(el), sin(el), cos(az)cos(el)]，由目标指向相机
//   - 上方向：世界 +Y；相机朝向 target
//   - 透视：fovY = 30°，aspect = width/height，near 0.1 / far 2000
//   - 像素原点：左上角，x 向右，y 向下（与浏览器 canvas 一致）
//   - 视口偏移：SHOT 模式下 setViewOffset 为恒等；交互模式下步骤条会压缩可见区，故显式传 viewRect
//
// 遮挡判定用射线-AABB（slab 法）求最近命中距离，不用包围盒中心距离近似——
// 中心距离近似在细长件（1×16 板）上会误判遮挡。

import {
  partConnectors, partBoxes, PLATE,
} from '../core.js';
import { inspectFromModel } from '../actions-v1/state.js';

export const RENDER_STATE_VERSION = '1.0.0';

/** 相机契约快照：写进输出，让 B 能断言自己用的就是这一套 */
export const CAMERA_CONTRACT = {
  version: '1.0.0',
  worldUnit: 'stud',
  sourceSpace: 'core [x格, y片, z格]',
  sourceToWorld: { scale: [1, PLATE, 1], note: 'Y 方向片→格需乘 PLATE=0.4' },
  azimuthDefinition: 'dir = [sin(az)cos(el), sin(el), cos(az)cos(el)]，由 target 指向相机；az=0 时相机在 +Z 正前方',
  elevationDefinition: 'el 为正值时相机在上方；夹在 (-90, 90)',
  upAxis: '+Y',
  pixelOrigin: 'top-left',
  pixelAxes: { x: 'right', y: 'down' },
  projection: { type: 'perspective', fovYDeg: 30, near: 0.1, far: 2000 },
  handedness: 'right-handed, 与 three.js PerspectiveCamera 一致',
};

const r6 = (v) => Math.round(v * 1e6) / 1e6 || 0;

// ---------------------------------------------------------------- 向量工具

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l < 1e-12 ? [0, 0, 0] : [v[0] / l, v[1] / l, v[2] / l];
};

/** core 的 [x格, y片, z格] → 世界 [格, 格, 格]（viewer 口径）。乘 PLATE 后收敛到 1e-6，避免 3×0.4=1.2000000000000002 这类噪声进像素与哈希 */
export const coreToWorld = (p) => [p[0], r6(p[1] * PLATE), p[2]];
/** LDU → 世界格 */
export const lduToWorld = (ldu) => [r6(ldu[0] / 20), r6((ldu[1] / 8) * PLATE), r6(ldu[2] / 20)];

// ---------------------------------------------------------------- 相机

/**
 * 由视点参数构造相机。target/距离口径与 viewer 的 setView 一致。
 *
 * @param {object} q {
 *   azimuthDeg, elevationDeg, target: [x,y,z] 世界格, distance 世界格,
 *   width, height,                    // 画布像素
 *   fovYDeg?, near?, far?, mode?      // mode: 'perspective' | 'orthographic'
 *   orthoHalfHeight?                   // orthographic 必需
 *   viewRect?: { x, y, width, height } // 交互模式可见区（像素），缺省为整块画布
 * }
 */
export function makeCamera(q) {
  const az = ((q.azimuthDeg ?? 35) * Math.PI) / 180;
  const el = ((q.elevationDeg ?? 26) * Math.PI) / 180;
  const target = q.target || [0, 0, 0];
  const distance = q.distance ?? 40;
  const dir = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
  const eye = [target[0] + dir[0] * distance, target[1] + dir[1] * distance, target[2] + dir[2] * distance];

  // three.js lookAt：zc 由 target 指向相机；xc = up × zc；yc = zc × xc
  const zc = norm(sub(eye, target));
  let upRef = [0, 1, 0];
  if (Math.abs(dot(zc, upRef)) > 0.9999) upRef = [0, 0, 1];   // 正上方俯视时换参考轴，避免退化
  const xc = norm(cross(upRef, zc));
  const yc = cross(zc, xc);

  const width = q.width ?? 1200, height = q.height ?? 900;
  const viewRect = q.viewRect || { x: 0, y: 0, width, height };
  return {
    mode: q.mode || 'perspective',
    eye: eye.map(r6), target: target.map(r6), distance: r6(distance),
    dir: dir.map(r6),
    basis: { x: xc.map(r6), y: yc.map(r6), z: zc.map(r6) },
    azimuthDeg: q.azimuthDeg ?? 35, elevationDeg: q.elevationDeg ?? 26,
    fovYDeg: q.fovYDeg ?? CAMERA_CONTRACT.projection.fovYDeg,
    near: q.near ?? CAMERA_CONTRACT.projection.near,
    far: q.far ?? CAMERA_CONTRACT.projection.far,
    orthoHalfHeight: q.orthoHalfHeight ?? null,
    viewport: { width, height },
    viewRect,
    aspect: width / height,
  };
}

/**
 * 世界点 → 像素 + 深度。
 * 返回 { visible, x, y, depth, inFront, ndcX, ndcY }：
 *   depth 是到相机平面的正距离（世界格），越大越远；
 *   visible 表示落在 viewRect 内且在前方。
 */
export function projectPoint(cam, worldPoint) {
  const rel = sub(worldPoint, cam.eye);
  const cx = dot(rel, cam.basis.x);
  const cy = dot(rel, cam.basis.y);
  const cz = dot(rel, cam.basis.z);      // 相机背后为正（因为 zc 由 target 指向 eye）
  const depth = -cz;                      // 前方为正
  if (!(depth > cam.near) || depth > cam.far) {
    return { visible: false, x: -1, y: -1, depth, inFront: false, ndcX: NaN, ndcY: NaN };
  }
  let ndcX, ndcY;
  if (cam.mode === 'orthographic') {
    const halfH = cam.orthoHalfHeight || 1;
    ndcX = cx / (halfH * cam.aspect);
    ndcY = cy / halfH;
  } else {
    const f = 1 / Math.tan((cam.fovYDeg * Math.PI) / 360);
    ndcX = (cx * f) / cam.aspect / depth;
    ndcY = (cy * f) / depth;
  }
  const vr = cam.viewRect;
  const x = r6(vr.x + ((ndcX + 1) / 2) * vr.width);
  const y = r6(vr.y + ((1 - ndcY) / 2) * vr.height);
  const visible = x >= vr.x && x <= vr.x + vr.width && y >= vr.y && y <= vr.y + vr.height;
  return { visible, x, y, depth: r6(depth), inFront: true, ndcX: r6(ndcX), ndcY: r6(ndcY) };
}

// ---------------------------------------------------------------- 遮挡

/**
 * 射线与 AABB 相交，返回最近命中参数 t（沿 dir 的距离）；不相交返回 null。
 * dir 必须是单位向量。slab 法，逐轴求交区间。
 */
export function rayBoxHit(origin, dir, box) {
  let tmin = 0, tmax = Infinity;
  const o = [origin[0], origin[1], origin[2]];
  const lo = [box.min[0], box.min[1], box.min[2]];
  const hi = [box.max[0], box.max[1], box.max[2]];
  for (let i = 0; i < 3; i++) {
    const d = dir[i];
    if (Math.abs(d) < 1e-12) {
      if (o[i] < lo[i] || o[i] > hi[i]) return null;
      continue;
    }
    let t0 = (lo[i] - o[i]) / d, t1 = (hi[i] - o[i]) / d;
    if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
    tmin = Math.max(tmin, t0);
    tmax = Math.min(tmax, t1);
    if (tmin > tmax) return null;
  }
  return tmin;
}

/**
 * 收集零件的世界包围盒（CP-02：只建一次全模型数组，不再按 owner 各建一份）。
 * core.partBoxes 的 y 单位是片、x/z 是格；这里统一换算到世界格。
 */
function worldBoxes(model, cat) {
  const out = [];
  for (const p of model.parts || []) {
    const def = cat.parts[p.part];
    if (!def) continue;
    let boxes;
    try { boxes = partBoxes(p, def); } catch { continue; }
    for (const b of boxes) {
      // 必须与 coreToWorld 同样收敛到 1e-6：一边取整一边不取整，浮点边界会让 pointInBox 漏判
      // （3×0.4=1.2000000000000002 vs 1.2，接口点恰好落在盒边界上时被判成「不在盒内」）
      out.push({
        partId: p.id,
        min: [r6(b.x0), r6(b.y0 * PLATE), r6(b.z0)],
        max: [r6(b.x1), r6(b.y1 * PLATE), r6(b.z1)],
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- 遮挡空间索引（CP-02）
// 旧实现每条接口的遮挡判定都对「除 owner 外的全部盒」做两次线性扫描（点在盒内 + 射线 slab），
// 1000 件 ≈ 8000 条接口 × 999 盒 ≈ 800 万次盒测试，是 renderState 的 O(n²) 热点。
// 现改为：全模型盒按 2 格均匀栅格登记一次；每条查询用 3D DDA（Amanatides-Woo）只遍历
// 「点→相机线段穿过的格子」里登记的盒。线段与某盒相交 ⇒ 交点在盒内 ⇒ 交点所在格子被遍历 ⇒
// 该盒必然进入候选集，因此裁剪是**保守超集**；候选按下标升序回原数组扫描，
// 「第一个命中盒」语义与全量扫描逐字节一致（occludedBy / at / reason 不变）。
const OCCLUDE_CELL = 2;

function buildOcclusionIndex(boxes) {
  if (!boxes.length) return { empty: true, epoch: 0 };
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const b of boxes) {
    if (b.min[0] < minX) minX = b.min[0]; if (b.max[0] > maxX) maxX = b.max[0];
    if (b.min[1] < minY) minY = b.min[1]; if (b.max[1] > maxY) maxY = b.max[1];
    if (b.min[2] < minZ) minZ = b.min[2]; if (b.max[2] > maxZ) maxZ = b.max[2];
  }
  const pad = 1e-6; minX -= pad; minY -= pad; minZ -= pad; maxX += pad; maxY += pad; maxZ += pad;
  const nx = Math.max(1, Math.ceil((maxX - minX) / OCCLUDE_CELL));
  const ny = Math.max(1, Math.ceil((maxY - minY) / OCCLUDE_CELL));
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / OCCLUDE_CELL));
  const head = new Array(nx * ny * nz);      // 每格一个数组（盒下标升序由扫描时 sort 保证）
  const next = null;                          // 注意：不能用「每盒一个 next 槽」的链表——
                                              // 同一颗盒登记进多个格子时共享 next 槽会互相改写、断链漏盒（已实测踩坑）
  const clampCell = (v, lo, n) => Math.min(n - 1, Math.max(0, Math.floor((v - lo) / OCCLUDE_CELL)));
  boxes.forEach((b, bi) => {
    const x0 = clampCell(b.min[0], minX, nx), x1 = clampCell(b.max[0], minX, nx);
    const y0 = clampCell(b.min[1], minY, ny), y1 = clampCell(b.max[1], minY, ny);
    const z0 = clampCell(b.min[2], minZ, nz), z1 = clampCell(b.max[2], minZ, nz);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const rowBase = (x * ny + y) * nz;
      for (let z = z0; z <= z1; z++) { const k = rowBase + z; (head[k] || (head[k] = [])).push(bi); }
    }
  });
  return { empty: false, minX, minY, minZ, maxX, maxY, maxZ, nx, ny, nz, head, stamp: new Int32Array(boxes.length), epoch: 0 };
}

/** 点→相机线段穿过的全部盒下标（升序）。DDA 只走线段经过的格子，裁剪保守超集。 */
function segmentCandidates(index, from, to) {
  if (index.empty) return [];
  const { minX, minY, minZ, maxX, maxY, maxZ, nx, ny, nz, head } = index;
  const gmin = [minX, minY, minZ], gmax = [maxX, maxY, maxZ], n = [nx, ny, nz];
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  // 线段与栅格整体 AABB 求交（slab），裁到栅格内部
  let tEnter = 0, tExit = 1;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-12) { if (from[i] < gmin[i] || from[i] > gmax[i]) return []; continue; }
    let ta = (gmin[i] - from[i]) / d[i], tb = (gmax[i] - from[i]) / d[i];
    if (ta > tb) { const w = ta; ta = tb; tb = w; }
    if (ta > tEnter) tEnter = ta;
    if (tb < tExit) tExit = tb;
  }
  if (tEnter > tExit) return [];
  const clampCell = (v, lo, nn) => Math.min(nn - 1, Math.max(0, Math.floor((v - lo) / OCCLUDE_CELL)));
  const c = [clampCell(from[0] + d[0] * tEnter, minX, nx), clampCell(from[1] + d[1] * tEnter, minY, ny), clampCell(from[2] + d[2] * tEnter, minZ, nz)];
  const step = [0, 1, 2].map((i) => (d[i] > 1e-12 ? 1 : d[i] < -1e-12 ? -1 : 0));
  const tDelta = [0, 1, 2].map((i) => (Math.abs(d[i]) < 1e-12 ? Infinity : Math.abs(OCCLUDE_CELL / d[i])));
  const tMax = [0, 1, 2].map((i) => {
    if (!step[i]) return Infinity;
    const boundary = gmin[i] + (c[i] + (step[i] > 0 ? 1 : 0)) * OCCLUDE_CELL;
    return (boundary - from[i]) / d[i];
  });
  const epoch = ++index.epoch;
  const out = [];
  for (;;) {
    const k = (c[0] * ny + c[1]) * nz + c[2];
    const list = head[k];
    if (list) for (const bi of list) {
      if (index.stamp[bi] !== epoch) { index.stamp[bi] = epoch; out.push(bi); }
    }
    let axis = -1, tm = Infinity;
    for (let i = 0; i < 3; i++) if (tMax[i] < tm) { tm = tMax[i]; axis = i; }
    if (axis < 0 || tm > tExit) break;
    c[axis] += step[axis];
    if (c[axis] < 0 || c[axis] >= n[axis]) break;
    tMax[axis] += tDelta[axis];
  }
  out.sort((a, b) => a - b);
  return out;
}

/** 点是否在 AABB 内（含边界） */
function pointInBox(p, box) {
  return p[0] >= box.min[0] && p[0] <= box.max[0]
    && p[1] >= box.min[1] && p[1] <= box.max[1]
    && p[2] >= box.min[2] && p[2] <= box.max[2];
}

/**
 * 接口点是否被其他零件挡住（candidates：segmentCandidates 给出的盒下标升序子集）。
 * 两个必须覆盖的情形：
 *   1) 点在别的零件盒内（扣合状态下凸点恰好落在对方底孔处，数值上就在盒边界/内部）→ 判为遮挡；
 *   2) 视线射到别的零件（命中距离 < 到相机距离）→ 判为遮挡。
 * 只做 (2) 会漏掉 (1)：slab 法在起点位于盒内时返回 tmin=0，被 `t > 0` 过滤掉，
 * 于是「已经被上层板扣住的凸点」会被当成可见，标号直接画在别的零件表面上。
 * 候选集按下标升序回全量数组扫描 → 「第一个命中盒」与旧全量扫描语义逐字节一致。
 */
function isOccluded(pointWorld, camEye, boxes, candidates, eps = 0.02) {
  for (const bi of candidates) {
    const b = boxes[bi];
    if (pointInBox(pointWorld, b)) return { occludedBy: b.partId, at: 0, reason: 'inside-box' };
  }
  const v = sub(camEye, pointWorld);
  const dist = Math.hypot(v[0], v[1], v[2]);
  if (dist < 1e-9) return false;
  const dir = [v[0] / dist, v[1] / dist, v[2] / dist];
  const origin = [pointWorld[0] + dir[0] * eps, pointWorld[1] + dir[1] * eps, pointWorld[2] + dir[2] * eps];
  for (const bi of candidates) {
    const b = boxes[bi];
    const t = rayBoxHit(origin, dir, b);
    if (t !== null && t > 0 && t < dist - eps) return { occludedBy: b.partId, at: r6(t), reason: 'ray-hit' };
  }
  return null;
}

// ---------------------------------------------------------------- 主入口

/**
 * 生成带标号的接口视图。
 *
 * @param {object} request {
 *   model,                       // 0.2 模型（权威几何）
 *   cat,
 *   stateHash?,                  // 若给出则强制核对；不一致直接拒绝（MV-01：映射与状态绑定）
 *   camera: {...makeCamera 参数},
 *   maxLabels? = 24,             // 标签密度上限（PRD MV-01 ≤32）
 *   focus? = { nodeIds?: [], region?: {min,max} },  // 只标待装区域
 *   includeOccupied? = false,    // 已占用接口是否也列出（默认排除，避免视觉干扰）
 *   tagStyle? = 'numeric'        // 'numeric' → '1'..'N'
 * }
 */
export function renderState(request) {
  const t0 = Date.now();
  const { model, cat } = request;
  if (!model || !cat) {
    return rejected('render-invalid-request', 'renderState 需要 model 与 cat');
  }
  const camQ = request.camera || {};
  if (!camQ.width || !camQ.height) {
    return rejected('render-invalid-request', 'camera.width / camera.height 必填（像素视口），不接受隐式默认');
  }
  if (!camQ.target || !Number.isFinite(camQ.distance)) {
    return rejected('render-invalid-request', 'camera.target 与 camera.distance 必填；标号必须绑定明确的取景，不接受隐式取景');
  }

  const si = inspectFromModel(model, cat, { mainRootNodeId: request.mainRootNodeId });
  if (request.stateHash && request.stateHash !== si.stateHash) {
    return rejected('stale-state', `stateHash 不匹配：请求 ${request.stateHash}，当前 ${si.stateHash}；标号不得跨状态复用`);
  }

  const cam = makeCamera(camQ);
  const maxLabels = Math.min(request.maxLabels ?? 24, 32);   // PRD MV-01 上限 32
  const focusIds = request.focus?.nodeIds ? new Set(request.focus.nodeIds) : null;
  const region = request.focus?.region || null;

  // 占用表：引擎算，不信模型声明
  const occ = new Map();
  for (const o of si.state.occupancy || []) occ.set(`${o.nodeId}|${o.connectorId}`, o.occupiedBy);

  // CP-02：全模型盒只收集一次并建栅格索引；遮挡查询按线段 DDA 走格子，
  // 不再为每个 owner 重复构建「除 owner 外全部盒」的数组，也不再全量线性扫描。
  const allBoxes = worldBoxes(model, cat);
  const occIndex = buildOcclusionIndex(allBoxes);

  const items = [];
  const skipped = { backFacing: 0, outOfView: 0, occluded: 0, occupied: 0, outOfFocus: 0, unsupported: 0 };

  for (const node of si.state.nodes) {
    if (focusIds && !focusIds.has(node.nodePath)) { skipped.outOfFocus++; continue; }
    const def = cat.parts[node.partId];
    if (!def) { skipped.unsupported++; continue; }
    let conn;
    try { conn = partConnectors(node, def); } catch { skipped.unsupported++; continue; }

    for (const c of conn.studs) {
      const cid = `c${c.kind}#${c.index}`;
      const occupiedBy = occ.get(`${node.nodePath}|${cid}`) || null;
      if (occupiedBy && !request.includeOccupied) { skipped.occupied++; continue; }

      const world = coreToWorld(c.pos);
      if (region) {
        const w = world;
        if (w[0] < region.min[0] || w[0] > region.max[0] || w[1] < region.min[1] || w[1] > region.max[1] || w[2] < region.min[2] || w[2] > region.max[2]) {
          skipped.outOfFocus++; continue;
        }
      }

      // 朝向：接口法线必须朝向相机
      const toCam = norm(sub(cam.eye, world));
      const facing = c.dir ? FACE_VEC[c.dir] : [0, 1, 0];
      const facingDot = dot(facing, toCam);
      if (facingDot <= 0.05) { skipped.backFacing++; continue; }

      const proj = projectPoint(cam, world);
      if (!proj.visible) { skipped.outOfView++; continue; }

      const candidates = segmentCandidates(occIndex, world, cam.eye)
        .filter((bi) => allBoxes[bi].partId !== node.nodePath);
      const blocked = isOccluded(world, cam.eye, allBoxes, candidates);
      if (blocked) { skipped.occluded++; continue; }

      items.push({
        nodeId: node.nodePath,
        partId: node.partId,
        connectorId: cid,
        connectorType: c.kind,
        connectorRole: 'male',
        dir: c.dir || '+y',
        worldPos: world.map(r6),
        worldPosLdu: [r6(c.pos[0] * 20), r6(c.pos[1] * 8), r6(c.pos[2] * 20)],
        pixel: [proj.x, proj.y],
        depth: proj.depth,
        facingDot: r6(facingDot),
        occupied: Boolean(occupiedBy),
        occupiedBy,
        aliases: aliasesOf(cid),
      });
    }
  }

  // 标签分配：先按屏幕行分桶（24 px 一行）再从左到右，阅读顺序稳定且与相机微调无关
  items.sort((a, b) => {
    const ra = Math.floor(a.pixel[1] / 24), rb = Math.floor(b.pixel[1] / 24);
    if (ra !== rb) return ra - rb;
    if (a.pixel[0] !== b.pixel[0]) return a.pixel[0] - b.pixel[0];
    return `${a.nodeId}|${a.connectorId}`.localeCompare(`${b.nodeId}|${b.connectorId}`);
  });
  const truncated = items.length > maxLabels;
  const selected = items.slice(0, maxLabels);
  selected.forEach((it, i) => { it.tag = String(i + 1); });

  const out = {
    ok: true, commandOk: true, passed: true,
    kind: 'renderState',
    renderStateVersion: RENDER_STATE_VERSION,
    cameraContract: CAMERA_CONTRACT,
    camera: {
      mode: cam.mode, eye: cam.eye, target: cam.target, distance: cam.distance,
      azimuthDeg: cam.azimuthDeg, elevationDeg: cam.elevationDeg,
      dir: cam.dir, up: cam.basis.y,
      fovYDeg: cam.fovYDeg, near: cam.near, far: cam.far, aspect: r6(cam.aspect),
      orthoHalfHeight: cam.orthoHalfHeight,
      viewport: cam.viewport, viewRect: cam.viewRect, pixelOrigin: 'top-left',
    },
    stateHash: si.stateHash,
    labels: selected.map((it) => ({
      tag: it.tag,
      pixel: it.pixel,
      nodeId: it.nodeId,
      partId: it.partId,
      connectorId: it.connectorId,
      connectorType: it.connectorType,
      dir: it.dir,
      worldPos: it.worldPos,
      worldPosLdu: it.worldPosLdu,
      depth: it.depth,
      aliases: it.aliases,
    })),
    // 未截断才有资格说「视口内可见接口已穷尽」
    enumerationComplete: !truncated,
    truncated,
    maxLabels,
    candidatesInView: items.length,
    skipped,
    diagnostics: [],
    elapsedMs: Date.now() - t0,
  };
  return out;
}

const FACE_VEC = {
  '+y': [0, 1, 0], '-y': [0, -1, 0],
  '+z': [0, 0, 1], '-z': [0, 0, -1],
  '+x': [1, 0, 0], '-x': [-1, 0, 0],
};

/**
 * 接口 ID 的兼容写法。
 * 权威键是 A 的稳定语义 ID（`ctop#3` → 稳定 `stud-10000-24000-10000` 由 assets-v1 提供）；
 * 这里给出 B 草案写法的别名，供跨版本兼容输入。别名**必须**与资产修订一起使用，不能只凭序号跨版本解释。
 */
export function aliasesOf(shortId) {
  const hashAt = shortId.indexOf('#');
  if (hashAt < 0) return { bStyle: shortId, bare: null };
  const kind = shortId.slice(1, hashAt);
  const idx = shortId.slice(hashAt + 1);
  const bStyle = kind === 'top' ? `stud_top_${idx}` : kind === 'side' ? `stud_side_${idx}` : `${kind}_${idx}`;
  return {
    bStyle,
    // 裸 stud_N 只对顶凸点有定义（B 草案写法）；侧凸点必须写 stud_side_N，否则有损
    bare: kind === 'top' ? `stud_${idx}` : null,
  };
}

/**
 * 把 A 的标签表翻成 B 消费的 connector-map.json 形态（REQ-B01 / render-requirements §2.4）。
 * 与 B 的字段差异只在命名，语义一一对应；resolution 侧用 resolveTag。
 */
export function toConnectorMap(result, extra = {}) {
  if (!result.ok) return result;
  return {
    version: RENDER_STATE_VERSION,
    stateHash: result.stateHash,
    camera: {
      azimuth: result.camera.azimuthDeg ?? null,
      elevation: result.camera.elevationDeg ?? null,
      distance: result.camera.distance,
      target: result.camera.target,
      eye: result.camera.eye,
      fovYDeg: result.camera.fovYDeg,
      viewport: result.camera.viewport,
      viewRect: result.camera.viewRect,
      pixelOrigin: 'top-left',
    },
    totalVisibleLabels: result.labels.length,
    enumerationComplete: result.enumerationComplete,
    labels: result.labels.map((l) => ({
      tag: l.tag,
      // B 草案字段名 pixel；render-requirements §2.4 写的是 "2d"
      pixel: l.pixel,
      '2d': l.pixel,
      partInstanceId: l.nodeId,
      connectorId: l.aliases.bStyle,
      stableConnectorId: l.connectorId,
      type: l.connectorType,
      up: l.dir,
      worldPos: l.worldPos,
      depth: l.depth,
    })),
    ...extra,
  };
}

/** 按 tag 反查接口（B 的 resolveLabelToConnector 等价物，但带 stateHash 校验） */
export function resolveTag(result, tag, expectedStateHash = null) {
  if (!result.ok) return null;
  if (expectedStateHash && expectedStateHash !== result.stateHash) return null;
  const hit = result.labels.find((l) => String(l.tag) === String(tag));
  if (!hit) return null;
  return {
    nodeId: hit.nodeId,
    connectorId: hit.connectorId,
    aliases: hit.aliases,
    dir: hit.dir,
    worldPos: hit.worldPos,
    pixel: hit.pixel,
  };
}

function rejected(code, msg) {
  return {
    ok: false, commandOk: true, passed: false, kind: 'renderState',
    renderStateVersion: RENDER_STATE_VERSION,
    diagnostics: [{ code, severity: 'error', msg }],
    capabilityGaps: [], notMeasured: [{ item: 'renderState', reason: code }],
  };
}
