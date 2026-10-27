// LDraw 官方零件库素材（catalog/ldraw/）：下载、解析与尺寸核对工具。
// LDraw 基本单位为 LDU；与 catalog/gen-catalog.mjs 的换算约定一致：1 格 (stud) = 20 LDU，1 片 (plate) = 8 LDU。
// 官方零件库许可证：CC BY 2.0（https://library.ldraw.org/ —— 允许再分发，需署名）。
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const LDRAW_BASE = 'https://library.ldraw.org/library/official';
export const LDRAW_LICENSE = 'CC BY 2.0';
export const LDRAW_LICENSE_URL = 'https://library.ldraw.org/license';

// 目录编号 → 官方库文件编号（仅当官方库原始文件名与目录编号不同时列出）。
// 别名只是文件名映射，不代表识别确认；几何核对仍以实际下载的 .dat 为准。
// 模具变体存疑项：4085d 官方存在 4085b（薄 U 夹）/4085c（厚 U 夹）两种，此处先映射 4085b，待实物核对；
// 553b 官方迁移编号为 30367a（带 Blocked Stud 穹顶），553/30367 均为 ~Moved to 重定向。
export const OFFICIAL_ALIASES = {
  '553b': '30367a',
  '4085d': '4085b',
  '4589b': '4589',
};

// —— 引用路径解析 ————————————————————————————————————————————————
// LDraw 引用使用反斜杠；子零件固定 s\ 前缀，几何基元在 p/ 下（含 8\、48\ 高精度子目录），
// 完整 shortcut 零件会直接引用另一颗零件文件（无前缀）。
// 引用内容来自远程文件，路径段只允许 [a-z0-9._/-]，且禁止 ..，防止路径穿越。
export function refCandidates(raw) {
  const ref = String(raw).trim().toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!/^[a-z0-9][a-z0-9._/-]*\.dat$/.test(ref) || ref.split('/').includes('..')) return [];
  if (ref.startsWith('s/')) return [`parts/s/${ref.slice(2)}`];
  return [`parts/${ref}`, `p/${ref}`];
}

// 把库内相对路径解析为 outDir 内的绝对路径；越出根目录返回 null（写与读都必须经过这里）。
export function safeJoin(root, libPath) {
  const r = path.resolve(root);
  const t = path.resolve(r, String(libPath).replace(/\\/g, '/'));
  return t === r || t.startsWith(r + path.sep) ? t : null;
}

function partRefs(text) {
  const refs = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (Number(t[0]) === 1 && t.length >= 15) refs.push(t.slice(14).join(' '));
  }
  return refs;
}

function headerName(text) {
  let desc = '', name = '';
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!desc && /^0\s/.test(t)) desc = t.replace(/^0\s+/, '').trim();
    if (!name && /^0\s+!NAME:/i.test(t)) name = t.replace(/^0\s+!NAME:\s*/i, '').trim();
  }
  return { desc, name };
}

// —— 包围盒 ————————————————————————————————————————————————————
// 只统计实体几何：type 1（递归子引用）与 type 3/4（三角形/四边形）；type 0/2/5 不影响实体范围。
// 子引用的变换矩阵可能是带剪切的一般仿射（斜弧面建模技巧），因此必须把叶顶点沿完整矩阵链
// 精确变换后再取包围盒；用子包围盒角点传播会高估。返回 LDU 坐标 {min:[x,y,z], max:[x,y,z]}。
const ID3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function mul3(A, B) {
  return A.map((row) => [0, 1, 2].map((j) => row.reduce((s, v, k) => s + v * B[k][j], 0)));
}

function apply3(M, t, p) {
  return [
    M[0][0] * p[0] + M[0][1] * p[1] + M[0][2] * p[2] + t[0],
    M[1][0] * p[0] + M[1][1] * p[1] + M[1][2] * p[2] + t[1],
    M[2][0] * p[0] + M[2][1] * p[1] + M[2][2] * p[2] + t[2],
  ];
}

function addGeometry(text, resolve, depth, M, t, min, max, skipInstance) {
  if (depth > 12 || !min) return;
  const grow = (p) => {
    if (p[0] < min[0]) min[0] = p[0]; if (p[0] > max[0]) max[0] = p[0];
    if (p[1] < min[1]) min[1] = p[1]; if (p[1] > max[1]) max[1] = p[1];
    if (p[2] < min[2]) min[2] = p[2]; if (p[2] > max[2]) max[2] = p[2];
  };
  for (const line of text.split(/\r?\n/)) {
    const tok = line.trim().split(/\s+/);
    const type = Number(tok[0]);
    if (type === 1 && tok.length >= 15) {
      const refName = tok.slice(14).join(' ');
      const m = [[+tok[5], +tok[6], +tok[7]], [+tok[8], +tok[9], +tok[10]], [+tok[11], +tok[12], +tok[13]]];
      const pos = [+tok[2], +tok[3], +tok[4]];
      // 主体包围盒模式：连接器外挑图元（销/把手/夹/横向凸点等）不计入主体（整个子树跳过）
      if (skipInstance && skipInstance(refName.toLowerCase().replace(/\\/g, '/').split('/').pop(), mul3(M, m), apply3(M, t, pos))) continue;
      const child = resolve(refName);
      if (!child) continue;
      // 复合变换：v' = M·(m·v + pos) + t
      addGeometry(child, resolve, depth + 1, mul3(M, m), apply3(M, t, pos), min, max, skipInstance);
    } else if (type === 3 || type === 4) {
      const n = type === 3 ? 3 : 4;
      for (let k = 0; k < n; k++) grow(apply3(M, t, [+tok[2 + k * 3], +tok[3 + k * 3], +tok[4 + k * 3]]));
    }
  }
}

/** bboxFromText(text, resolve, opts?)
 *  opts.skipInstance(baseName, MM, worldPos)：主体/外挑分离时跳过指定图元实例（含其整棵子树）；
 *  baseName 为小写文件名（如 'connect.dat'），MM 为该实例的复合旋转矩阵，worldPos 为实例中心的世界 LDU 坐标。 */
export function bboxFromText(text, resolve, opts = {}) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  addGeometry(text, resolve, 0, ID3, [0, 0, 0], min, max, opts.skipInstance || null);
  return min[0] === Infinity ? null : { min, max };
}

// LDraw 标准系统（System）单颗顶凸点基元集合：覆盖实心凸点 (stud/studa)、空心凸点 (stud2/stud2a)、
// 圆砖/八角砖截断或开孔凸点 (stud6/stud10/stud15/stud17) 等。
export const STUD_PRIMITIVES = new Set([
  'stud.dat', 'studa.dat',
  'stud2.dat', 'stud2a.dat',
  'stud6.dat', 'stud6a.dat',
  'stud9.dat', 'stud10.dat', 'stud12.dat', 'stud13.dat', 'stud15.dat',
  'stud17.dat', 'stud17a.dat', 'stud26.dat', 'studel.dat', 'studp01.dat',
  'stud-logo.dat', 'stud-logo2.dat', 'stud-logo3.dat', 'stud-logo4.dat', 'stud-logo5.dat',
  'stud2-logo.dat', 'stud2-logo2.dat', 'stud2-logo3.dat', 'stud2-logo4.dat', 'stud2-logo5.dat',
]);

// 判定零件是否为印刷图案/贴花/组合衍生件（默认仅入库基础素模，印刷图案作为独立属性后续接入）。
export function isPatternedOrDerivative(id, desc = '') {
  const cleanId = String(id).toLowerCase().replace(/\.dat$/, '');
  if (/^[0-9]+[a-z]?p[0-9a-z]{2,}$/i.test(cleanId)) return true;
  if (/^[0-9]+[a-z]?(?:d[0-9]{2}|pb[0-9]{2,}|c[0-9]{2})/i.test(cleanId)) return true;
  if (/\b(pattern|printed|stickered|marbled|decorated)\b/i.test(desc)) return true;
  if (/^[~=_]/.test(desc.trim())) return true;
  return false;
}

// —— 连接语义图元白名单（P1 连接语义自动提取，与 STUD_PRIMITIVES 同一范式）—————————————
// 依据官方 p/ 图元头注释逐族核对（catalog/ldraw-full/p/*.dat 首行）：
//   销孔（圆孔，插 Technic 销/光杆）：peghole*（Peg Hole End 端面，成对出现）、beamhole/beamhol2（Technic Beam Hole）、
//     connhole（Technic Connector Hole Long，销/轴两用长孔）；
//   轴孔（十字孔）：axlehole（Closed）、axlehol0/2~7/9（Hint/Sides/Edges/Tooth 等孔壁族）；
//     注意 axlehol8.dat 是 "Technic Axle Perimeter"（轴杆本体），不属于孔；
//   销（外凸 Technic 销）：connect*（Technic Pin 1.0/0.5 with/without Base Collar）、confric*（摩擦销族）；
//   把手/杆（可被夹子扣住的圆杆）：phandle1/2（Plate Handle）、handle/handle2；
//   夹子（U 形夹口）：clip1~16；
//   底部反凸点空腔（真实可扣合的底孔）：stud3/stud3a（Small Hollow Stud）、stud4/stud4a（Hollow Square Stud，
//     标准砖 s\*s01 底面子件逐格使用）；tile 类底腔用 box5 边沿建模、无图元实例，由生成器按类目兜底。
export const PIN_HOLE_PRIMITIVES = new Set([
  'peghole.dat', 'peghole2.dat', 'peghole3.dat', 'peghole4.dat', 'peghole5.dat', 'peghole6.dat',
  'beamhole.dat', 'beamhol2.dat', 'connhole.dat',
]);
export const AXLE_HOLE_PRIMITIVES = new Set([
  'axlehole.dat', 'axlehol0.dat', 'axlehol2.dat', 'axlehol3.dat', 'axlehol4.dat',
  'axlehol5.dat', 'axlehol6.dat', 'axlehol7.dat', 'axlehol9.dat',
]);
export const PIN_PRIMITIVES = new Set([
  'connect.dat', 'connect2.dat', 'connect3.dat', 'connect4.dat', 'connect5.dat',
  'connect6.dat', 'connect7.dat', 'connect8.dat', 'connect9.dat', 'connect10.dat',
  // Technic Friction Pin 族（confric*.dat，完整销本体；confricrib*.dat 是销面筋条子图元、非独立销，不收）——
  // 2026-10 回修：4459 摩擦销 .dat 仅引 2× confric.dat，此前不在白名单导致摩擦销族无 pins 连接器
  'confric.dat', 'confric2.dat', 'confric3.dat', 'confric4.dat', 'confric5.dat',
  'confric6.dat', 'confric8.dat', 'confric9.dat', 'confric10.dat', 'confric11.dat', 'confric12.dat',
]);
export const BAR_PRIMITIVES = new Set(['phandle1.dat', 'phandle2.dat', 'handle.dat', 'handle2.dat']);

// 轮轴销 / 金属销族（外挑图元，不计入零件主体占地；也是 pin↔axleHole 的销侧连接器）：
//   wpin*（Wheel Holding Pin 1/2/3/4、带中心孔变体、pull-back 电机轮销）——18892/2926/4600 等
//   车底盘两侧轮销长 24~28 LDU，若不剔除会把 4 格砖体量成 5 格（18892 曾误记 size [5,2]）。
//   axleend*/axlecap*/axlecaph*（Technic Axle End Surface / Endcap）同样属于轴端外挑。
//   注意：axle.dat/axlehol8.dat 是轴杆本体，可能是零件全部实体，不收（否则纯轴件主体盒为空）。
export const WPIN_PRIMITIVES = new Set([
  'wpin.dat', 'wpin2.dat', 'wpin2a.dat', 'wpin3.dat', 'wpin4.dat',
  'wpin5a.dat', 'wpin5aq.dat', 'wpin5e.dat',
]);
export const AXLE_END_PRIMITIVES = new Set([
  'axleend.dat', 'axleend2.dat', 'axleend20.dat', 'axleend2hole.dat', 'axlecap.dat', 'axlecaph.dat', 'axlecaph2.dat',
]);
/** 主体/外挑分离时始终剔除的外挑图元（外凸销/轮销/杆/夹）。
 *  不含轴孔/销孔图元：它们是零件内部的孔壁几何，剔掉会把实心砖体的孔壁一起删掉、缩小主体盒。
 *  也不含 AXLE_END_PRIMITIVES（axleend/axlecap 轴端面）：对「轴本身即零件主体」的科技轴类
 *  （27940 轴 3L、57585 三联轴套），轴端就是零件实体端点，剔掉会把零件量短（曾误伤 1 格）。
 *  （CLIP_PRIMITIVES 在其后声明，此处用惰性 getter 避免 TDZ；见 PROTRUSION_PRIMITIVES 末尾的 add） */
export const PROTRUSION_PRIMITIVES = new Set([
  ...PIN_PRIMITIVES, ...BAR_PRIMITIVES, ...WPIN_PRIMITIVES,
]);

export const CLIP_PRIMITIVES = new Set([
  'clip1.dat', 'clip2.dat', 'clip3.dat', 'clip4.dat', 'clip5.dat', 'clip6.dat',
  'clip7.dat', 'clip8.dat', 'clip9.dat', 'clip10.dat', 'clip11.dat', 'clip12.dat',
  'clip13.dat', 'clip14.dat', 'clip15.dat', 'clip16.dat',
]);
for (const p of CLIP_PRIMITIVES) PROTRUSION_PRIMITIVES.add(p);
export const ANTISTUD_PRIMITIVES = new Set(['stud3.dat', 'stud3a.dat', 'stud4.dat', 'stud4a.dat']);

const CONNECTOR_PRIMITIVES = new Set([
  ...PIN_HOLE_PRIMITIVES, ...AXLE_HOLE_PRIMITIVES, ...PIN_PRIMITIVES,
  ...BAR_PRIMITIVES, ...CLIP_PRIMITIVES, ...ANTISTUD_PRIMITIVES, ...STUD_PRIMITIVES,
  ...WPIN_PRIMITIVES,   // 轮轴销（2026-10）：既是外挑图元（不计入占地）也是 pin↔axleHole 的销侧连接器
]);

/** 收集连接图元实例（白名单并集，含凸点族任意朝向）：递归全部子引用，
 *  在图元叶子处记录 { prim（小写文件名）, pos（世界 LDU 坐标）, M（复合旋转矩阵）, yUp: M[1][1] }。
 *  分类（顶凸点 / 侧凸点 / 底孔 / 销孔 / 轴孔 / 销 / 杆 / 夹）由调用方按 prim + 朝向 + 位置决定。 */
export function connectorInstancesFromText(text, resolve) {
  const found = [];
  const walk = (txt, M, t, depth) => {
    if (depth > 12) return;
    for (const line of txt.split(/\r?\n/)) {
      const tok = line.trim().split(/\s+/);
      const type = Number(tok[0]);
      if (type === 0) continue;
      if (type === 1 && tok.length >= 15) {
        const ref = tok.slice(14).join(' ').toLowerCase().replace(/\\/g, '/');
        const base = ref.split('/').pop();
        const m = [[+tok[5], +tok[6], +tok[7]], [+tok[8], +tok[9], +tok[10]], [+tok[11], +tok[12], +tok[13]]];
        const MM = mul3(M, m);
        const pos = apply3(M, t, [+tok[2], +tok[3], +tok[4]]);
        if (CONNECTOR_PRIMITIVES.has(base)) {
          found.push({ prim: base, pos, M: MM, yUp: MM[1][1] });
          continue;
        }
        const child = resolve(ref);
        if (child) walk(child, MM, pos, depth + 1);
      }
    }
  };
  walk(text, ID3, [0, 0, 0], 0);
  return found;
}

// 收集朝上单凸点实例（STUD_PRIMITIVES）的世界坐标：递归全部子引用（含 stug* 凸点群），在凸点基元叶子处记录位置。
// 要求复合旋转矩阵的 Y 轴分量 MM[1][1] > 0.7（即凸点朝向 LDraw 顶面 -y，排除 SNOT 侧壁上的横向 stud2a）。
/** 轮/胎放射剖面：以 bbox 最薄轴为轮轴，统计中段（|沿轴偏移| < 35% 半长）顶点半径分布。
 *  返回 { axis: 'x'|'y'|'z', outer（最外半径 LDU）, bore（内孔半径 LDU，无内孔为 0）, span（轴向长度 LDU） }。
 *  用途：生成器给 11208 轮毂 / 11209 轮胎写 wheel 语义，partsConnected 用它做 tyre↔rim 半径匹配。 */
export function radialProfile(text, resolve) {
  const polys = trianglesFromText(text, resolve);
  const box = bboxFromText(text, resolve);
  if (!box) return null;
  const ext = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  const ai = ext.indexOf(Math.min(...ext));
  const axis = ['x', 'y', 'z'][ai];
  const c = [(box.max[0] + box.min[0]) / 2, (box.max[1] + box.min[1]) / 2, (box.max[2] + box.min[2]) / 2];
  const half = ext[ai] / 2;
  const off = [...c]; off[ai] = 0;
  const rad = [];
  for (const p of polys) for (const v of p) {
    const a = Math.abs(v[ai] - c[ai]);
    if (a > half * 0.35) continue;
    const d = [v[0] - c[0], v[1] - c[1], v[2] - c[2]];
    d[ai] = 0;
    rad.push(Math.hypot(d[0], d[1], d[2]));
  }
  if (!rad.length) return null;
  rad.sort((a, b) => a - b);
  const outer = rad[rad.length - 1];
  // 内孔半径：半径分布里第一段密集值（轮毂/轮胎内壁）——取最小半径，但排除 < 1 LDU 的中心点噪声
  const meaningful = rad.filter((r) => r > 1);
  const bore = meaningful.length ? meaningful[0] : 0;
  return { axis, outer: r1(outer), bore: r1(bore), span: r1(ext[ai]), center: c, bbox: box };
}

/** 单个图元实例的世界 AABB：把实例的变换矩阵写成一行 .dat 再递归求包围盒。
 *  用途：轮销（wpin*）这类「实例原点 ≠ 几何中心」的图元，需要真实端点求轮毂扣合位。
 *  返回 { min:[x,y,z], max:[x,y,z] }（LDU）或 null。 */
export function instanceWorldBox(prim, M, t, resolve) {
  const line = `1 16 ${t[0]} ${t[1]} ${t[2]} ${M[0][0]} ${M[0][1]} ${M[0][2]} ${M[1][0]} ${M[1][1]} ${M[1][2]} ${M[2][0]} ${M[2][1]} ${M[2][2]} ${prim}`;
  return bboxFromText(line, resolve);
}

export function studPositionsFromText(text, resolve) {
  const pts = [];
  const walk = (txt, M, t, depth) => {
    if (depth > 12) return;
    for (const line of txt.split(/\r?\n/)) {
      const tok = line.trim().split(/\s+/);
      const type = Number(tok[0]);
      if (type === 0) continue;
      if (type === 1 && tok.length >= 15) {
        const ref = tok.slice(14).join(' ').toLowerCase().replace(/\\/g, '/');
        const base = ref.split('/').pop();
        const m = [[+tok[5], +tok[6], +tok[7]], [+tok[8], +tok[9], +tok[10]], [+tok[11], +tok[12], +tok[13]]];
        const MM = mul3(M, m);
        const pos = apply3(M, t, [+tok[2], +tok[3], +tok[4]]);
        if (STUD_PRIMITIVES.has(base)) {
          if (MM[1][1] > 0.7) pts.push(pos);
          continue;
        }
        const child = resolve(ref);
        if (child) walk(child, MM, pos, depth + 1);
      }
    }
  };
  walk(text, ID3, [0, 0, 0], 0);
  return pts;
}
// 收集实体多边形（type 3/4 顶点沿引用矩阵链变换到世界空间），供渲染预览/缩略图使用。
// BFC 绕组：负行列式矩阵（镜像）与 `0 BFC INVERTNEXT`（其后一条子引用为内腔几何）都会翻转绕组，
// 沿矩阵链累计翻转奇偶并在发出时反转顶点顺序，背面剔除与光照才正确。
// opts.skipPrim(baseName)：跳过指定图元实例（含子树），用于「去掉凸点/外挑件只看主体壳」的竖向采样。
export function trianglesFromText(text, resolve, opts = {}) {
  const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const skipPrim = typeof opts.skipPrim === 'function' ? opts.skipPrim : null;
  const walk = (txt, M, t, depth, flip) => {
    const acc = [];
    if (depth > 12) return acc;
    let invertNext = false;
    for (const line of txt.split(/\r?\n/)) {
      const tok = line.trim().split(/\s+/);
      const type = Number(tok[0]);
      if (type === 0) {
        if (/^0\s+BFC\s+INVERTNEXT\b/i.test(line)) invertNext = true;
        continue;
      }
      if (type === 1 && tok.length >= 15) {
        const raw = tok.slice(14).join(' ');
        if (skipPrim && skipPrim(String(raw).toLowerCase().replace(/\\/g, '/').split('/').pop())) { invertNext = false; continue; }
        const child = resolve(raw);
        if (child) {
          const m = [[+tok[5], +tok[6], +tok[7]], [+tok[8], +tok[9], +tok[10]], [+tok[11], +tok[12], +tok[13]]];
          const mirrored = det3(m) < 0;
          const polys = walk(child, mul3(M, m), apply3(M, t, [+tok[2], +tok[3], +tok[4]]), depth + 1, flip !== mirrored);
          if (invertNext) for (const p of polys) acc.push([...p].reverse());
          else acc.push(...polys);
        }
        invertNext = false; // 仅作用于紧跟的这一条子引用
      } else if (type === 3 || type === 4) {
        const n = type === 3 ? 3 : 4;
        const poly = [];
        for (let k = 0; k < n; k++) poly.push(apply3(M, t, [+tok[2 + k * 3], +tok[3 + k * 3], +tok[4 + k * 3]]));
        acc.push(flip ? [...poly].reverse() : poly);
      }
    }
    return acc;
  };
  return walk(text, ID3, [0, 0, 0], 0, false);
}

/** 多边形（3/4/n 顶点）三角化：四边形沿较短对角线切分，避免长细三角形在射线相交时漏检。 */
export function triangulatePoly(poly) {
  if (poly.length === 3) return [poly];
  if (poly.length === 4) {
    const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    return d2(poly[0], poly[2]) <= d2(poly[1], poly[3])
      ? [[poly[0], poly[1], poly[2]], [poly[0], poly[2], poly[3]]]
      : [[poly[0], poly[1], poly[3]], [poly[1], poly[2], poly[3]]];
  }
  const out = [];
  for (let i = 1; i + 1 < poly.length; i++) out.push([poly[0], poly[i], poly[i + 1]]);
  return out;
}

/** 竖向高度图（凹形件分解用）：把零件按 size[格] 切成竖列，每列从上往下、从下往上各打 sub×sub 条竖直射线，
 *  记录「从上方最先撞到的面」（材料顶面）与「从下方最先撞到的面」（材料底面，null = 从零件底起算）。
 *  LDraw 零件是薄壁壳体、砖类内部是封闭空腔，用"点在体内"测试会把实心砖判空；用双向首撞面则：
 *    实心砖 3001 每格顶面都 = H（材料到顶）→ 视为全高实心（与旧单盒一致）；
 *    底盘座舱槽 28324 的槽底格顶面 ≈ 0.5 片 → 判为开口内腔。
 *  返回 { top: Map("i,k" → ly|null), bottom: Map("i,k" → ly|null), tris }，ly 单位为片（底面起算，向上为正）。
 *  opts.skipPrim 用来剔除凸点/外挑图元，只对主体壳采样。 */
export function heightMapColumns(text, resolve, opts = {}) {
  const { size, bodyBottomY, min, max } = opts;
  const r4 = (v) => Math.round(v * 4) / 4;
  const sub = Math.max(1, opts.sub ?? 2);
  const [sx, sz] = size;
  const tris = [];
  for (const p of trianglesFromText(text, resolve, opts)) for (const t of triangulatePoly(p)) {
    tris.push({
      v: t,
      b: [Math.min(t[0][0], t[1][0], t[2][0]), Math.min(t[0][1], t[1][1], t[2][1]), Math.min(t[0][2], t[1][2], t[2][2]),
        Math.max(t[0][0], t[1][0], t[2][0]), Math.max(t[0][1], t[1][1], t[2][1]), Math.max(t[0][2], t[1][2], t[2][2])],
    });
  }
  const x0 = min[0], zMax = max[2];
  const toLy = (y) => (bodyBottomY - y) / 8;
  // 竖直射线：dy = +1（从上方按 LDraw +y 向下走）或 -1（从下方往上走），返回最近命中 y（LDraw 坐标）或 null
  const firstHit = (px, pz, startY, dy) => {
    let best = Infinity;
    for (const { v, b } of tris) {
      if (b[3] < px - 1e-6 || b[0] > px + 1e-6) continue;
      if (b[5] < pz - 1e-6 || b[2] > pz + 1e-6) continue;
      const e1 = [v[1][0] - v[0][0], v[1][1] - v[0][1], v[1][2] - v[0][2]];
      const e2 = [v[2][0] - v[0][0], v[2][1] - v[0][1], v[2][2] - v[0][2]];
      const hx = dy * e2[2], hy = 0, hz = -dy * e2[0];        // h = d × e2，d = (0, dy, 0)
      const a = e1[0] * hx + e1[1] * hy + e1[2] * hz;
      if (Math.abs(a) < 1e-9) continue;
      const f = 1 / a, s = [px - v[0][0], startY - v[0][1], pz - v[0][2]];
      const u = f * (s[0] * hx + s[1] * hy + s[2] * hz);
      if (u < -1e-7 || u > 1 + 1e-7) continue;
      const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
      const vv = f * (dy * q[1]);
      if (vv < -1e-7 || u + vv > 1 + 1e-7) continue;
      const tt = f * (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]);
      if (tt > 1e-6 && tt < best) best = tt;
    }
    return Number.isFinite(best) ? startY + dy * best : null;
  };
  const top = new Map(), bottom = new Map();
  for (let i = 0; i < sx; i++) for (let k = 0; k < sz; k++) {
    const baseX = x0 + i * 20, baseZ = zMax - (k + 1) * 20;
    let tBest = null, bBest = null;
    for (let a = 0; a < sub; a++) for (let b = 0; b < sub; b++) {
      const px = baseX + ((a + 0.5) / sub) * 20, pz = baseZ + ((b + 0.5) / sub) * 20;
      const yTop = firstHit(px, pz, min[1] - 2, 1);
      const yBot = firstHit(px, pz, bodyBottomY + 2, -1);
      if (yTop !== null && (tBest === null || yTop < tBest)) tBest = yTop;   // 顶面取最高（LDraw y 最小）
      if (yBot !== null && (bBest === null || yBot > bBest)) bBest = yBot;   // 底面取最低（LDraw y 最大）
    }
    top.set(`${i},${k}`, tBest === null ? null : r4(toLy(tBest)));
    bottom.set(`${i},${k}`, bBest === null ? null : r4(toLy(bBest)));
  }
  return { top, bottom, tris: tris.length };
}

/** 双向高度图 → 分解包围盒（本地坐标 [x0,x1,y0,y1,z0,z1]，x/z 为格、y 为片）。
 *  依据官方 .dat 实测顶面轮廓逐格生成材料区间：
 *    每格材料 = [底面（从下方首撞面，null → 0）, 顶面（从上方首撞面）]；
 *    顶面为空（图形外）→ 该格不产盒；底面高于顶面 → 该格无实体。
 *  y 端点按 1/4 片向外取整（顶面向上、底面向下），保证盒只会覆盖真实材料、绝不低估实体。
 *  只有确实存在「顶面明显低于零件顶」（< h-0.4）的格子才输出多盒——此时单实心盒会把
 *  座舱槽（28324 槽底 0.5 片）/ 轮拱（50745 拱顶 5 片）/ 双阶斜坡（22889 中段 1 片）的空腔封死；
 *  全高实心件（3001/3020 等）没有任何低顶面格 → 返回空 boxes，调用方保持旧单盒（validate 结果不变）。
 *  返回 { boxes, mode:'heightmap'|null, recessedCells, hTop }。 */
export function decomposeHeightMap(hm, size, h) {
  return decomposeHeightMapChecked(hm, size, h).result;
}

/**
 * 分解 + 覆盖率自检：`coverage` 是「网格顶点被 boxes 覆盖的比例」。
 * 双向射线只在每个子格中心采样，对弯曲/倾斜的壳体（轮拱 50745、斜挡泥板）会整格采空——
 * 那种格子被当成"无材料"跳过，结果 boxes 只余一小片，绝大多数材料在碰撞判定里消失
 * （实测 50745 覆盖率 0.03）。调用方必须检查 coverage，偏低时退回单盒（保守，绝不漏保护）。
 *
 * coverCheck：{ points:[x,y,z], ... } 可选网格顶点（单位格，本地框架），用于算覆盖率。
 */
export function decomposeHeightMapChecked(hm, size, h, coverPoints = null) {
  const result = decomposeHeightMapCore(hm, size, h);
  if (!coverPoints || !coverPoints.length) return { result, coverage: null };
  const boxes = result.boxes;
  if (!boxes.length) return { result, coverage: 1 };
  const inBox = (p) => boxes.some((b) => p[0] >= b[0] - 1e-4 && p[0] <= b[1] + 1e-4
    && p[1] >= b[2] - 1e-4 && p[1] <= b[3] + 1e-4
    && p[2] >= b[4] - 1e-4 && p[2] <= b[5] + 1e-4);
  let hit = 0;
  for (const p of coverPoints) if (inBox(p)) hit++;
  return { result, coverage: hit / coverPoints.length };
}

function decomposeHeightMapCore(hm, size, h) {
  const [sx, sz] = size;
  const eps = 1e-6;
  const q4 = (v, dir) => (dir > 0 ? Math.ceil(v * 4 - eps) : Math.floor(v * 4 + eps)) / 4;
  // 底面基准：官方 .dat 里砖类底下是封闭空腔，「从下方首撞面」撞到的是腔内顶壁（3001 约 2.5 片），
  // 不是零件底面。因此只有当「没有任何一格从下方触及零件底」时（整体悬空的拱/壳，如 50745 轮拱）
  // 才采用逐格底面；否则所有格一律从 0 起算（保守：绝不缩小实体占位）。
  let minBottom = Infinity;
  for (let i = 0; i < sx; i++) for (let k = 0; k < sz; k++) {
    const b = hm.bottom.get(`${i},${k}`);
    if (b !== null && b !== undefined) minBottom = Math.min(minBottom, b);
  }
  const shellMode = Number.isFinite(minBottom) && minBottom > 1.0;
  const cells = new Map();
  let recessed = 0;
  let hTop = 0;
  for (let i = 0; i < sx; i++) for (let k = 0; k < sz; k++) {
    const key = `${i},${k}`;
    const t = hm.top.get(key);
    if (t === null || t === undefined) { cells.set(key, null); continue; }
    const b = hm.bottom.get(key);
    const y0 = shellMode && b !== null && b !== undefined ? Math.min(b, t) : 0;
    if (t - y0 <= eps) { cells.set(key, null); continue; }
    hTop = Math.max(hTop, t);
    if (t < h - 0.4) recessed++;
    const q0 = Math.max(0, q4(y0, -1)), q1 = Math.min(h, q4(t, 1));
    cells.set(key, q1 - q0 <= eps ? null : [q0, q1]);
  }
  if (!recessed) return { boxes: [], mode: null, recessedCells: 0, hTop };
  const levels = new Set();
  for (const span of cells.values()) if (span) { levels.add(span[0]); levels.add(span[1]); }
  const lv = [...levels].sort((a, b) => a - b);
  const boxes = [];
  for (let n = 0; n + 1 < lv.length; n++) {
    const y0 = lv[n], y1 = lv[n + 1];
    const covers = (i, k) => { const s = cells.get(`${i},${k}`); return Boolean(s) && s[0] <= y0 + eps && s[1] >= y1 - eps; };
    const used = new Set();
    for (let k = 0; k < sz; k++) for (let i = 0; i < sx; i++) {
      const id = `${i},${k}`;
      if (used.has(id) || !covers(i, k)) continue;
      let i1 = i;
      while (i1 + 1 < sx && !used.has(`${i1 + 1},${k}`) && covers(i1 + 1, k)) i1++;
      let k1 = k;
      while (k1 + 1 < sz) {
        let ok = true;
        for (let ii = i; ii <= i1; ii++) if (used.has(`${ii},${k1 + 1}`) || !covers(ii, k1 + 1)) { ok = false; break; }
        if (!ok) break;
        k1++;
      }
      for (let ii = i; ii <= i1; ii++) for (let kk = k; kk <= k1; kk++) used.add(`${ii},${kk}`);
      boxes.push([-sx / 2 + i, -sx / 2 + i1 + 1, y0, y1, -sz / 2 + k, -sz / 2 + k1 + 1]);
    }
  }
  // 竖向合并：x/z 范围相同且上下相接的盒并成一个
  const merged = [];
  for (const b of boxes) {
    const prev = merged.find((m) => m[0] === b[0] && m[1] === b[1] && m[4] === b[4] && m[5] === b[5] && Math.abs(m[3] - b[2]) < 1e-6);
    if (prev) prev[3] = b[3];
    else merged.push([...b]);
  }
  return { boxes: merged, mode: shellMode ? 'heightmap-shell' : 'heightmap', recessedCells: recessed, hTop };
}

const r1 = (v) => Math.round(v * 10) / 10;
// 用官方几何实测尺寸核对目录条目：size[格] → ×20 LDU，h[片] → ×8 LDU，容差 0.5 LDU。
// 分类说明（audit 语境下的可解释差异）：
//   match        官方实测与目录完全一致
//   stud-offset  仅 y 多出 4 LDU = 顶部凸点高度，实体占位（h 片）仍正确
//   protrudes    x/z 超出网格（侧凸点、把柄、夹口等真实突出；网格 AABB 低估实体）
//   smaller      x/z 小于网格（杆件、门板等比格子细；网格 AABB 高估实体）
//   height-error 高度差无法用凸点解释 —— 目录 h 定义与官方几何矛盾（硬错误，ok=false）
//   missing      官方库无此编号
//
// 包围盒只能核对「外形占多高多大」，核对不了「凸点长在哪一面、有几个」。目录里
// sideFaces/sideRows 是手写参数，装配引擎直接拿它生成侧凸点坐标，写错会让侧装件
// 扣在空气上却又自洽通过校验。因此这里额外拿官方 .dat 实测的 sideStuds 对账：
//   side-face-mismatch  目录声明的侧凸点朝向集合与官方不一致
//   side-count-mismatch 朝向一致但每面凸点数不一致
//   side-faces-missing  官方有侧凸点，目录一个没声明（引擎会当成没有侧装接口）
// 这三类与 height-error 同级：都是「目录手写定义与官方几何冲突即硬错误」。
export function verifyPart(def, box, opts = {}) {
  const expected = { x: def.size[0] * 20, y: def.h * 8, z: def.size[1] * 20 };
  const axes = {};
  const flags = [];
  for (const [a, i] of [['x', 0], ['y', 1], ['z', 2]]) {
    const measured = box.max[i] - box.min[i];
    axes[a] = { expected: expected[a], measured: r1(measured), diff: r1(measured - expected[a]), ok: Math.abs(measured - expected[a]) <= 0.5 };
  }
  if (!axes.y.ok) {
    if (Math.abs(axes.y.measured - (expected.y + 4)) <= 0.5) {
      flags.push('stud-offset');
      axes.y = { ...axes.y, ok: true, note: '官方几何含顶部凸点 +4 LDU，实体占位一致' };
    } else {
      flags.push('height-error');
    }
  }
  for (const a of ['x', 'z']) {
    if (!axes[a].ok) flags.push(axes[a].measured > axes[a].expected ? 'protrudes' : 'smaller');
  }

  // —— 侧凸点面/数对账（官方 sideStuds 形如 [x, y, z, "+z"]）——
  const sideDetail = verifySideStuds(def, opts.officialSideStuds);
  if (sideDetail) flags.push(sideDetail.flag);

  const status = flags.includes('height-error') ? 'height-error'
    : flags.includes('side-face-mismatch') || flags.includes('side-count-mismatch') ? 'side-mismatch'
      : flags.includes('side-faces-missing') ? 'side-faces-missing'
        : flags.includes('protrudes') ? 'protrudes'
          : flags.includes('smaller') ? 'smaller'
            : flags.includes('stud-offset') ? 'stud-offset' : 'match';
  const hard = flags.some((f) => HARD_FLAGS.has(f));
  return {
    expected, measured: { x: axes.x.measured, y: axes.y.measured, z: axes.z.measured },
    axes, flags, status, ok: !hard,
    ...(sideDetail ? { sideStuds: sideDetail } : {}),
  };
}

const HARD_FLAGS = new Set(['height-error', 'side-face-mismatch', 'side-count-mismatch', 'side-faces-missing']);

// 官方实测侧凸点按「朝向 → 数量」归并；凸点在本地的 y 也一并记下，供人工核对行高。
function groupSideStuds(studs) {
  const g = {};
  for (const s of studs || []) {
    const face = s[3];
    if (!face) continue;
    (g[face] ||= []).push({ x: s[0], y: s[1], z: s[2] });
  }
  return g;
}

// 目录声明（sideFaces/sideRows）与官方实测侧凸点对账。返回 null 表示无可比信息。
//
// 只在「目录自认有侧装接口」时才核对：sideFaces 已声明，或 kind 是 snot/bracket。
// 否则零件没有侧装面，把它的外凸销/夹口/把柄当侧凸点比对会全是误报。
export function verifySideStuds(def, officialSideStuds) {
  const declared = Array.isArray(def.sideFaces) ? def.sideFaces : null;
  const claimsSide = (declared && declared.length) || def.kind === 'snot' || def.kind === 'bracket';
  if (!claimsSide) return null;
  const measured = groupSideStuds(officialSideStuds);
  const measuredFaces = Object.keys(measured).sort();
  if (!measuredFaces.length) return null;
  if (!declared || !declared.length) {
    return { flag: 'side-faces-missing', declaredFaces: [], measuredFaces, measuredCount: measuredFaces.length };
  }
  const declaredFaces = [...new Set(declared)].sort();
  if (declaredFaces.join(',') !== measuredFaces.join(',')) {
    return { flag: 'side-face-mismatch', declaredFaces, measuredFaces };
  }
  // 每面凸点数：目录用 sideRows × 该面宽度推期望数，官方按实测点个数
  const rows = def.sideRows || (def.h >= 5 ? [1.25, 3.75] : [1.75]);
  const counts = {};
  for (const face of measuredFaces) {
    const span = face === '+z' || face === '-z' ? def.size[0] : def.size[1];
    counts[face] = { declared: rows.length * span, measured: measured[face].length };
  }
  const bad = measuredFaces.find((f) => counts[f].declared !== counts[f].measured);
  if (bad) {
    return { flag: 'side-count-mismatch', counts, offendingFace: bad, declaredRows: rows };
  }
  return null;
}


// —— 下载 ————————————————————————————————————————————————————
// 安全约束：仅允许 https 且主机必须为官方库域名，拒绝环回/私有/保留地址（防 SSRF）。
export function assertOfficialUrl(url) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const bad = u.protocol !== 'https:' || host === 'localhost' || host === '127.0.0.1' || host === '::1'
    || host.endsWith('.local') || host.endsWith('.internal')
    || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^169\.254\./.test(host) || /^0\./.test(host) || host === '[::]';
  if (bad || !(host === 'library.ldraw.org' || host.endsWith('.ldraw.org'))) {
    throw new Error(`拒绝非官方素材源 URL：${url}`);
  }
}

// 429 与瞬时错误都退避重试；404 视为不存在返回 null。
async function fetchBytes(url, tries = 5) {
  assertOfficialUrl(url);
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 30000);
      const r = await fetch(url, { signal: ctl.signal }); clearTimeout(tm);
      if (r.status === 404) return null;
      if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`HTTP ${r.status}`), { retryable: true });
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((res) => setTimeout(res, e.retryable ? 2000 * 2 ** i : 400 * (i + 1)));
    }
  }
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// 下载目录全部零件及其引用闭包到 outDir（镜像官方库目录结构 parts/、parts/s/、p/）。
// mirror 指定本地整库解压目录（如 complete.zip 解压结果）时优先离线拷贝；已存在的文件视为缓存（--force 重取）。
// 返回 manifest（含来源、许可与 SHA-256），由调用方落盘。
export async function fetchLDrawLibrary({ outDir, ids, aliases = OFFICIAL_ALIASES, force = false, concurrency = 2, throttleMs = 250, base = LDRAW_BASE, mirror = null, log = () => {} }) {
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = {
    source: base, license: LDRAW_LICENSE, licenseUrl: LDRAW_LICENSE_URL, fetchedAt: new Date().toISOString(),
    mirror: mirror ? path.resolve(mirror) : null,
    note: '官方零件库本地镜像（主零件 + 子零件 + 几何基元闭包）。别名仅是文件名映射，不代表零件识别确认。',
    parts: {}, files: {}, missing: {}, errors: [],
  };
  const queue = []; const seen = new Set();
  const enqueue = (raw, meta) => { const key = String(raw).toLowerCase(); if (!seen.has(key)) { seen.add(key); queue.push({ raw, ...meta }); } };
  for (const id of ids) {
    const official = aliases[id] || id;
    enqueue(`${official}.dat`, { id, official, main: true });
  }
  let done = 0;
  // 全局节流：请求间隔不小于 throttleMs，避免触发官方库限流（Cloudflare 429）
  let nextSlot = 0;
  const throttledFetch = async (url) => {
    const wait = Math.max(0, nextSlot - Date.now());
    nextSlot = Math.max(nextSlot, Date.now()) + throttleMs;
    if (wait) await new Promise((res) => setTimeout(res, wait));
    return fetchBytes(url);
  };
  const handle = async (item) => {
    let buf = null, resolved = null;
    for (const libPath of refCandidates(item.raw)) {
      const local = safeJoin(outDir, libPath);
      if (!local) continue;
      if (!force && fs.existsSync(local)) { buf = fs.readFileSync(local); resolved = libPath; break; }
      if (mirror) {
        const mp = safeJoin(mirror, libPath);
        if (mp && fs.existsSync(mp)) { buf = fs.readFileSync(mp); fs.mkdirSync(path.dirname(local), { recursive: true }); fs.writeFileSync(local, buf); resolved = libPath; break; }
        continue; // 整库镜像本身就是全集：镜像里没有的候选不再回退网络，避免限流噪音
      }
      try { buf = await throttledFetch(`${base}/${libPath}`); } catch (e) { manifest.errors.push({ libPath, error: String(e.message || e) }); continue; }
      if (buf) { fs.mkdirSync(path.dirname(local), { recursive: true }); fs.writeFileSync(local, buf); resolved = libPath; break; }
    }
    done++;
    if (done % 25 === 0) log(`  … ${done} 已处理`);
    if (!buf) { manifest.missing[item.raw] = item.id || null; return; }
    const digest = sha256(buf);
    if (!manifest.files[resolved]) manifest.files[resolved] = { sha256: digest, bytes: buf.length, url: `${base}/${resolved}` };
    const text = buf.toString('utf8');
    if (item.main) {
      const { desc, name } = headerName(text);
      manifest.parts[item.id] = { officialId: item.official, file: resolved, sha256: digest, bytes: buf.length, desc, name };
    }
    for (const ref of partRefs(text)) enqueue(ref, {});
  };
  const worker = async () => { while (queue.length) await handle(queue.shift()); };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return manifest;
}

// 整库安装：把官方 complete.zip 解压镜像的 parts/ 与 p/ 全量拷入 outDir（自包含、可离线），
// 并为每个文件登记 SHA-256。官方库无全量列表接口且逐文件下载会限流，整库包是官方推荐方式，
// 因此 full 模式必须提供 mirror。目录体积约数百 MB，建议放入 .gitignore 的目录（如 catalog/ldraw-full）。
export async function installFullLDrawLibrary({ outDir, mirror, base = LDRAW_BASE, license = LDRAW_LICENSE, licenseUrl = LDRAW_LICENSE_URL, log = () => {} }) {
  if (!mirror) throw new Error('整库安装必须提供 --mirror <complete.zip 解压目录>（官方无全量直连接口）');
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = {
    source: base, license, licenseUrl, fetchedAt: new Date().toISOString(),
    mirror: path.resolve(mirror), mode: 'full',
    note: 'LDraw 官方零件库全量本地镜像（parts/ 主零件 + parts/s/ 子零件 + p/ 几何基元）。仅是素材镜像，不代表任何零件被识别确认。',
    counts: {}, files: {},
  };
  for (const seg of ['parts', 'p']) {
    const src = safeJoin(mirror, seg), dst = safeJoin(outDir, seg);
    if (!src || !fs.existsSync(src)) throw new Error(`镜像缺少 ${seg}/ 目录：${mirror}`);
    if (!dst) throw new Error(`非法目标目录：${outDir}`);
    log(`  复制 ${seg}/ …`);
    fs.cpSync(src, dst, { recursive: true });
  }
  log('  计算 SHA-256 …');
  const walk = (dir, prefix = '') => {
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name), rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) n += walk(p, rel);
      else if (/\.(dat|ldr)$/i.test(e.name)) {
        const buf = fs.readFileSync(p);
        manifest.files[rel] = { sha256: sha256(buf), bytes: buf.length };
        n++;
      }
    }
    return n;
  };
  manifest.counts.parts = walk(path.join(outDir, 'parts'), 'parts');
  manifest.counts.primitives = walk(path.join(outDir, 'p'), 'p');
  return manifest;
}
