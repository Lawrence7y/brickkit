/**
 * src/viewer/stud-overlay-v2.js — 独立接口视觉标号与 2D/3D 映射模块
 *
 * 规范遵循：
 * - PRD Section 9.2 (MV-01) 标号规范
 * - 纯 ESM 模块，不侵入既有 viewer 入口，支持在 Node.js (无头渲染/评测) 与浏览器端运行
 * - 核心能力：
 *   1. 3D 世界坐标投影至 2D 视口平面 (Camera Projection)
 *   2. 朝向与遮挡检测 (Facing Camera & Bounding-box Raycast Occlusion)
 *   3. 空闲/占用接口过滤与标签数量控制
 *   4. 生成带 stateHash 的 2D 标号 ↔ 3D 接口映射表与独立 SVG 遮罩
 */

import { partConnectors, partBoxes } from '../core/core.js';

/**
 * 经典乐高世界坐标系约定：
 * 1 格 (Grid) = 1 单位长宽 (20 LDU)
 * 1 片 (Plate) = 0.4 单位高度 (8 LDU)，1 砖 = 3 片 = 1.2 单位高
 */

/**
 * 3D 向量基本运算
 */
export function vec3Sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vec3Dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vec3Normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len < 1e-8) return [0, 1, 0];
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * 将方位角 (az) 与俯仰角 (el) 转换为相机世界坐标位置
 */
export function sphericalToCartesian(azDeg, elDeg, distance = 40, target = [0, 5, 0]) {
  const azRad = (azDeg * Math.PI) / 180;
  const elRad = (elDeg * Math.PI) / 180;
  const cx = target[0] + distance * Math.cos(elRad) * Math.sin(azRad);
  const cy = target[1] + distance * Math.sin(elRad);
  const cz = target[2] + distance * Math.cos(elRad) * Math.cos(azRad);
  return [cx, cy, cz];
}

/**
 * 3D 世界坐标点透视/正交投影至 2D 像素坐标
 */
export function project3DTo2D(point3d, camera, viewport = { width: 800, height: 600 }) {
  const { width, height } = viewport;
  const camPos = camera.position || sphericalToCartesian(camera.azimuth ?? 315, camera.elevation ?? 25, camera.distance ?? 40, camera.target ?? [0, 5, 0]);
  const target = camera.target || [0, 5, 0];

  // 构建视线坐标系 (LookAt Matrix)
  const forward = vec3Normalize(vec3Sub(target, camPos));
  let worldUp = [0, 1, 0];
  if (Math.abs(vec3Dot(forward, worldUp)) > 0.99) worldUp = [0, 0, 1];
  
  // right = forward x worldUp
  const right = vec3Normalize([
    forward[1] * worldUp[2] - forward[2] * worldUp[1],
    forward[2] * worldUp[0] - forward[0] * worldUp[2],
    forward[0] * worldUp[1] - forward[1] * worldUp[0]
  ]);
  // up = right x forward
  const up = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0]
  ];

  // 变换到相机空间
  const rel = vec3Sub(point3d, camPos);
  const camX = vec3Dot(rel, right);
  const camY = vec3Dot(rel, up);
  const camZ = vec3Dot(rel, forward);

  if (camZ <= 0.1) {
    return { visible: false, x: -1, y: -1, depth: camZ };
  }

  // 透视投影
  const fov = ((camera.fov || 45) * Math.PI) / 180;
  const aspect = width / height;
  const tanHalfFov = Math.tan(fov / 2);
  const normX = camX / (camZ * tanHalfFov * aspect);
  const normY = camY / (camZ * tanHalfFov);

  const x = Math.round(((normX + 1) / 2) * width);
  const y = Math.round(((1 - normY) / 2) * height);
  const visible = x >= 0 && x <= width && y >= 0 && y <= height;

  return { visible, x, y, depth: camZ };
}

export function dirToVec3(dir) {
  if (Array.isArray(dir)) return dir;
  if (typeof dir === 'string') {
    switch (dir.trim()) {
      case '+x': return [1, 0, 0];
      case '-x': return [-1, 0, 0];
      case '+y': return [0, 1, 0];
      case '-y': return [0, -1, 0];
      case '+z': return [0, 0, 1];
      case '-z': return [0, 0, -1];
    }
  }
  return [0, 1, 0];
}

/**
 * 射线与 3D AABB 盒相交测试
 */
export function rayIntersectsBox(rayOrigin, rayDir, box) {
  let tmin = -Infinity;
  let tmax = Infinity;

  for (let i = 0; i < 3; i++) {
    const invD = 1.0 / (Math.abs(rayDir[i]) < 1e-8 ? 1e-8 : rayDir[i]);
    let t0 = (box.min[i] - rayOrigin[i]) * invD;
    let t1 = (box.max[i] - rayOrigin[i]) * invD;
    if (invD < 0) {
      const tmp = t0; t0 = t1; t1 = tmp;
    }
    tmin = Math.max(tmin, t0);
    tmax = Math.min(tmax, t1);
    if (tmax <= tmin) return false;
  }
  return tmax > 0;
}

/**
 * 遮挡检测：判断连接器点到相机的视线是否被其他零件包围盒阻挡
 */
export function isConnectorOccluded(connectorPos, cameraPos, allBoxes, ownerPartId) {
  const dir = vec3Normalize(vec3Sub(cameraPos, connectorPos));
  const distToCam = Math.hypot(
    cameraPos[0] - connectorPos[0],
    cameraPos[1] - connectorPos[1],
    cameraPos[2] - connectorPos[2]
  );

  // 稍微向外偏移一点，避免命中自身表面
  const offsetOrigin = [
    connectorPos[0] + dir[0] * 0.05,
    connectorPos[1] + dir[1] * 0.05,
    connectorPos[2] + dir[2] * 0.05
  ];

  for (const b of allBoxes) {
    if (b.partId === ownerPartId) continue;
    if (rayIntersectsBox(offsetOrigin, dir, b)) {
      // 检查交点是否在相机之前
      const midPoint = [
        (b.min[0] + b.max[0]) / 2,
        (b.min[1] + b.max[1]) / 2,
        (b.min[2] + b.max[2]) / 2
      ];
      const distToBox = Math.hypot(
        midPoint[0] - connectorPos[0],
        midPoint[1] - connectorPos[1],
        midPoint[2] - connectorPos[2]
      );
      if (distToBox < distToCam) return true;
    }
  }
  return false;
}

/**
 * 核心对外接口：生成 2D 接口标号与映射表
 */
export function generateConnectorOverlay(model, catalog, camera, options = {}) {
  const {
    viewport = { width: 800, height: 600 },
    stateHash = 'unspecified-state-hash',
    maxLabels = 24,
    focusPartIds = null,
    occupiedConnectors = new Set()
  } = options;

  const camPos = camera.position || sphericalToCartesian(
    camera.azimuth ?? 315,
    camera.elevation ?? 25,
    camera.distance ?? 40,
    camera.target ?? [0, 5, 0]
  );

  // 1. 收集全部零件包围盒（用于遮挡判定）
  const partsDict = catalog?.parts || catalog || {};
  const allBoxes = [];
  for (const p of model.parts || []) {
    const def = partsDict[p.part];
    if (!def) continue;
    const boxes = partBoxes(p, def);
    for (const b of boxes) {
      allBoxes.push({
        partId: p.id,
        min: [b.x0, b.y0, b.z0],
        max: [b.x1, b.y1, b.z1]
      });
    }
  }

  // 2. 收集候选连接器
  const candidates = [];
  for (const p of model.parts || []) {
    if (focusPartIds && !focusPartIds.has(p.id)) continue;
    const def = partsDict[p.part];
    if (!def) continue;
    const conns = partConnectors(p, def);

    // 优先处理凸点 (studs) 与反向孔 (receptors)
    const list = [...(conns.studs || []), ...(conns.receptors || [])];
    for (const c of list) {
      const connId = `${p.id}#${c.label || c.index}`;
      if (occupiedConnectors.has(connId)) continue; // 跳过已被占用的连接器

      // 朝向检测：法线与相机方向夹角 < 90° (dot > 0)
      const dirVec = dirToVec3(c.dir);
      const toCam = vec3Normalize(vec3Sub(camPos, c.pos));
      const dot = vec3Dot(dirVec, toCam);
      if (dot <= 0.05) continue; // 背对相机或过于平行

      // 投影至 2D
      const proj = project3DTo2D(c.pos, camera, viewport);
      if (!proj.visible) continue;

      // 遮挡检测
      if (isConnectorOccluded(c.pos, camPos, allBoxes, p.id)) continue;

      candidates.push({
        partId: p.id,
        connector: c,
        dirVec,
        proj,
        dot,
        connId
      });
    }
  }

  // 3. 排序与密度截断（优先保留最朝向相机、离相机较近的接口）
  candidates.sort((a, b) => b.dot - a.dot || a.proj.depth - b.proj.depth);
  const selected = candidates.slice(0, maxLabels);

  // 4. 编号分配与结构化映射输出
  const labels = [];
  const svgElements = [];

  selected.forEach((item, idx) => {
    const tag = String(idx + 1);
    const { x, y } = item.proj;
    const c = item.connector;

    const dirVec = item.dirVec;

    labels.push({
      tag,
      pixel: [x, y],
      partInstanceId: item.partId,
      connectorId: c.label || `idx-${c.index}`,
      type: c.kind || 'stud',
      worldPos: [Number(c.pos[0].toFixed(3)), Number(c.pos[1].toFixed(3)), Number(c.pos[2].toFixed(3))],
      worldDir: [Number(dirVec[0].toFixed(3)), Number(dirVec[1].toFixed(3)), Number(dirVec[2].toFixed(3))]
    });

    // 绘制圆圈标签 (Set-of-Mark 风格)
    svgElements.push(`
      <g class="connector-mark" data-tag="${tag}" transform="translate(${x}, ${y})">
        <circle r="9" fill="#FFCC00" stroke="#000000" stroke-width="1.5" opacity="0.9" />
        <text text-anchor="middle" dy="3.5" font-family="sans-serif" font-size="10" font-weight="bold" fill="#000000">${tag}</text>
      </g>
    `.trim());
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${viewport.width}" height="${viewport.height}" viewBox="0 0 ${viewport.width} ${viewport.height}">
    <g class="stud-overlay-layer">
      ${svgElements.join('\n      ')}
    </g>
  </svg>`;

  const labelMap = {
    version: '1.0',
    stateHash,
    camera: {
      azimuth: camera.azimuth,
      elevation: camera.elevation,
      distance: camera.distance,
      target: camera.target || [0, 5, 0]
    },
    totalVisibleLabels: labels.length,
    labels
  };

  return { labelMap, svg };
}

/**
 * 标签解析辅助函数：将模型选择的离散数字/标签反查回稳定连接器标识
 */
export function resolveLabelToConnector(labelMap, tag) {
  if (!labelMap || !Array.isArray(labelMap.labels)) return null;
  const match = labelMap.labels.find((l) => String(l.tag) === String(tag));
  if (!match) return null;
  return {
    partInstanceId: match.partInstanceId,
    connectorId: match.connectorId,
    type: match.type,
    worldPos: match.worldPos
  };
}
