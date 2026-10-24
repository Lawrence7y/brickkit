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

/** 本地格子（i 沿本地 x，k 沿本地 z；k=0 为后排） */
export function localCells(def) {
  const [sx, sz] = def.size, out = [];
  for (let i = 0; i < sx; i++) for (let k = 0; k < sz; k++) {
    if (def.kind === 'corner' && i === sx - 1 && k === sz - 1) continue;
    let stud = false;
    if (!def.tile && !def.centerStuds) {
      if (['brick', 'plate', 'pinplate', 'doorframe', 'round', 'snot', 'bracket', 'barplate', 'clip', 'corner', 'islope', 'arch', 'technic'].includes(def.kind)) stud = true;
      else if (def.kind === 'slope' || (def.kind === 'cslope' && def.backStuds)) stud = k === 0;
      else if (def.kind === 'wedge') stud = def.side === 'L' ? i === 0 || k === 0 : i === 0 || k === sz - 1;
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
 * 计算零件在世界坐标系中的 3D 实体包围盒数组 [{ x0, x1, y0, y1, z0, z1 }]
 * 其中 x0,x1,z0,z1 单位为格 (stud)，y0,y1 单位为片 (plate)。
 * 支持全部 6 向 SNOT 朝向 (up) 与多包围盒零件（L型转角、SNOT 支架）。
 */
export function partBoxes(p, def) {
  if (def.occupies === false) return [];
  const [sx, sz] = def.size, hx = sx / 2, hz = sz / 2, H = def.h * PLATE;
  const localBoxes = [];
  if (def.kind === 'corner') {
    localBoxes.push([-hx, hx, 0, H, -hz, 0], [-hx, 0, 0, H, 0, hz]);
  } else if (def.kind === 'bracket') {
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
 * 计算零件在世界空间中的全部连接点：
 * - studs: 输出连接点 [{ index, kind: 'top'|'side'|'bar', pos: [wx, wy_plates, wz], dir, label }]
 * - receptors: 输入插孔 [{ index, kind: 'antistud'|'clip', pos: [wx, wy_plates, wz], dir, i, k }]
 */
export function partConnectors(p, def) {
  const [sx, sz] = def.size, hx = sx / 2, hz = sz / 2, H = def.h * PLATE;
  const rot = p.rot || 0, up = p.up || '+y';
  const studs = [], receptors = [];

  // 1. 顶面凸点 (Top Studs)
  const topDir = localDirToWorld(0, 1, 0, rot, up);
  if (!def.tile) {
    if (def.centerStuds) {
      def.centerStuds.forEach(([cx, cz], idx) => {
        studs.push({ index: studs.length, kind: 'top', pos: localToWorld(p, def, cx, H, cz), dir: topDir, label: `center-${idx}` });
      });
    } else if (def.kind === 'cone' || def.kind === 'dish') {
      studs.push({ index: studs.length, kind: 'top', pos: localToWorld(p, def, 0, H, 0), dir: topDir, label: 'top-0' });
    } else {
      for (const c of localCells(def)) if (c.stud) {
        studs.push({ index: studs.length, kind: 'top', pos: localToWorld(p, def, c.lx, H, c.lz), dir: topDir, label: `top-${c.i},${c.k}` });
      }
    }
  }

  // 2. SNOT 侧面凸点 & 支架侧面凸点/插孔
  if (def.kind === 'snot' || def.kind === 'bracket') {
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

  // 3. 把柄 (Bars) —— 包含圆杆轴向 axis ('x'|'y'|'z')
  const axisOf = (d) => d.slice(1);
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

  // 4. 底面反凸点 / 底孔 (Bottom Anti-studs)
  for (const c of localCells(def)) {
    if (def.kind === 'islope' && c.k > 0) continue;
    receptors.push({ index: receptors.length, kind: 'antistud', pos: localToWorld(p, def, c.lx, 0, c.lz), dir: topDir, i: c.i, k: c.k });
  }
  if (sx >= 2 && sz >= 2 && def.kind !== 'corner') {
    receptors.push({ index: receptors.length, kind: 'antistud', pos: localToWorld(p, def, 0, 0, 0), dir: topDir, i: -1, k: -1 });
  }

  // 5. 夹子 (Clips) —— 包含夹口圆柱轴向 axis ('x'|'y'|'z')
  if (def.kind === 'clip') {
    const clipDir = localDirToWorld(0, 0, 1, rot, up);
    const axis = axisOf(localDirToWorld(1, 0, 0, rot, up));
    const clipXs = !def.singleClip && sx >= 2 ? [-0.5, 0.5] : [0];
    for (const cx of clipXs) {
      receptors.push({ index: receptors.length, kind: 'clip', pos: localToWorld(p, def, cx, H / 2, hz + 0.22), dir: clipDir, axis, i: 0, k: 0 });
    }
  }

  return { studs, receptors };
}

/** 判断两个零件是否存在真实物理连接（凸点扣底孔同向重合 / 夹子扣把柄同轴重合） */
export function partsConnected(a, defA, b, defB, connA = partConnectors(a, defA), connB = partConnectors(b, defB)) {
  const close = (p1, p2) => Math.abs(p1[0] - p2[0]) <= 0.08 && Math.abs(p1[1] - p2[1]) <= 0.20 && Math.abs(p1[2] - p2[2]) <= 0.08;
  for (const s of connA.studs) for (const r of connB.receptors) {
    if (s.kind === 'bar' && r.kind === 'clip' && (!s.axis || !r.axis || s.axis === r.axis) && close(s.pos, r.pos)) return true;
    if (s.kind !== 'bar' && r.kind === 'antistud' && s.dir === r.dir && close(s.pos, r.pos)) return true;
  }
  for (const s of connB.studs) for (const r of connA.receptors) {
    if (s.kind === 'bar' && r.kind === 'clip' && (!s.axis || !r.axis || s.axis === r.axis) && close(s.pos, r.pos)) return true;
    if (s.kind !== 'bar' && r.kind === 'antistud' && s.dir === r.dir && close(s.pos, r.pos)) return true;
  }
  return false;
}

/**
 * 给定父零件的某个凸点 studIndex，自动计算子零件以 receptorIndex 底孔扣合上去时的精确无穿模坐标 { at, up, rot, snot: 0 }
 */
export function snapPart(parentPart, parentDef, studIndex, childPart, childDef, receptorIndex = 0) {
  const pConn = partConnectors(parentPart, parentDef);
  const stud = pConn.studs[studIndex];
  if (!stud) throw new Error(`父零件 ${parentPart.id} 不存在凸点 #${studIndex}`);
  const up = childPart.up || stud.dir;
  const rot = childPart.rot || 0;
  const probe = { id: '_probe', part: childPart.part, at: [0, 0, 0], rot, up, snot: 0 };
  const cConn = partConnectors(probe, childDef);
  const rec = cConn.receptors[receptorIndex] || cConn.receptors[0];
  if (!rec) throw new Error(`子零件 ${childPart.part} 没有可用底孔`);
  return {
    ...childPart,
    up,
    rot,
    snot: 0,
    at: [
      r6(stud.pos[0] - rec.pos[0]),
      r6(stud.pos[1] - rec.pos[1]),
      r6(stud.pos[2] - rec.pos[2]),
    ],
  };
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
  for (const [n, p] of model.parts.entries()) {
    const tag = p && p.id ? p.id : `#${n}`;
    if (!p || typeof p !== 'object') { E('part', `第 ${n} 个零件不是对象`); continue; }
    if (!p.id || typeof p.id !== 'string') { E('id', `第 ${n} 个零件缺少 id`); continue; }
    if (byId.has(p.id)) { E('id-dup', `零件 id 重复：${p.id}`, [p.id]); continue; }
    byId.set(p.id, p);
    const def = cat.parts[p.part];
    if (!def) { E('part-unknown', `${tag}：目录里没有零件 ${p.part}`, [p.id]); continue; }
    if (cat.colors && !cat.colors[String(p.color)]) W('color-unknown', `${tag}：颜色代码 ${p.color} 不在颜色表中`, [p.id]);
    const isSnot = (p.up !== undefined && p.up !== '+y') || Boolean(p.mount);
    if (p.up !== undefined && !UPS.includes(p.up)) { E('up', `${tag}：up 只能是 +y/-y/+z/-z/+x/-x`, [p.id]); continue; }
    if (p.snot !== undefined && !Number.isInteger(p.snot)) { E('snot', `${tag}：snot 必须是整数（沿 up 方向偏移的片数）`, [p.id]); continue; }
    if (!Array.isArray(p.at) || p.at.length !== 3 || !p.at.every((v) => isSnot ? typeof v === 'number' && Number.isFinite(v) : Number.isInteger(v))) { E('at', `${tag}：at 必须是 3 个整数 [x, 层, z]`, [p.id]); continue; }
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

  // 1) 标准整数网格占位冲突
  const occ = new Map();
  for (const { p, def } of good) {
    if (def.occupies === false || (p.up && p.up !== '+y') || !p.at.every(Number.isInteger)) continue;
    for (const f of footprint(p, def)) for (let y = p.at[1]; y < p.at[1] + def.h; y++) {
      const key = `${f.x},${y},${f.z}`, o = occ.get(key);
      if (o && o !== p.id) {
        if (!warnings.some((w) => w.code === 'overlap' && w.parts.includes(o) && w.parts.includes(p.id)))
          E('overlap', `${o} 与 ${p.id} 在格子 [${f.x}, ${y}, ${f.z}] 重叠`, [o, p.id]);
      } else occ.set(key, p.id);
    }
  }
  // 2) 全方向 3D 实体包围盒防穿模检查（覆盖全部 SNOT 侧装件、非整数偏移件与支架）
  const boxesMap = new Map(good.map(({ p, def }) => [p.id, partBoxes(p, def)]));
  for (let i = 0; i < good.length; i++) {
    for (let j = i + 1; j < good.length; j++) {
      const a = good[i].p, b = good[j].p;
      if ( (!a.up || a.up === '+y') && (!b.up || b.up === '+y') && a.at.every(Number.isInteger) && b.at.every(Number.isInteger) && !a.snot && !b.snot ) continue;
      const hit = boxesCollide(boxesMap.get(a.id), boxesMap.get(b.id));
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
  // 3D 连接器自动物理匹配（凸点对底孔、把柄对夹子）
  const connMap = new Map(good.map(({ p, def }) => [p.id, partConnectors(p, def)]));
  for (let i = 0; i < good.length; i++) {
    for (let j = i + 1; j < good.length; j++) {
      const a = good[i], b = good[j];
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
  const ground = good.length ? Math.min(...good.map(({ p }) => p.at[1])) : 0;
  if (good.length && ground !== 0) W('ground', `最低零件在第 ${ground} 层，建议从第 0 层开始`);
  const reach = (filter, g0 = ground) => {
    const ok = new Set(), q = [];
    for (const { p } of good) if (filter(p) && p.at[1] === g0) { ok.add(p.id); q.push(p.id); }
    while (q.length) { const a = q.pop(); for (const b of adj.get(a)) if (!ok.has(b) && filter(byId.get(b))) { ok.add(b); q.push(b); } }
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
  const stats = { parts: good.length, steps: plan.steps.length, modules: mods.size, subassemblies: plan.subs.size, mechanisms: (model.mechanisms || []).length,
    confirmed: good.length - inferred.length - uncertain.length, inferred: inferred.length, uncertain: uncertain.length };
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
export function toLDraw(model, cat) {
  const name = (model.meta?.name || 'model').replace(/[\r\n]/g, ' '), plan = stepPlan(model);
  const byId = new Map((model.parts || []).map((p) => [p.id, p]));
  const head = (title, file) => [`0 ${title}`, `0 Name: ${file}`, `0 Author: ${model.meta?.author || 'brickkit'}`, `0 // 由 brickkit 从 brickbuild ${model.version || VERSION} 导出`];
  const body = (steps) => {
    const lines = [];
    steps.forEach((st, i) => {
      if (st.title) lines.push(`0 // 第 ${st.n} 步：${st.title}`);
      for (const id of st.parts) {
        const p = byId.get(id), def = cat.parts[p.part];
        if (!def) { lines.push(`0 // 跳过未知零件 ${p.part}`); continue; }
        lines.push(ldrawLine(p, def));
      }
      if (st.attach) lines.push(`1 16 0 0 0 1 0 0 0 1 0 0 0 1 ${subFile(st.attach)}`);   // 子组件坐标与主模型一致
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
    out.push(`0 FILE ${subFile(sub.id)}`, ...head(`子组件 · ${sub.label}`, subFile(sub.id)), ...body(steps), '0 NOFILE');
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
  return { complete: missing.length === 0, total: photos.length, have, missing, warnings };
}
