// 零件几何（参数化：砖/板/平板/斜面/屋脊/门框/门 + 凸点）与颜色。3D 展示和拼装图纸共用。
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import partsJson from '../../catalog/parts.json';
import colorsJson from '../../catalog/colors.json';
import { localCells, partCenter, PLATE } from '../core/core.js';

export const cat = { parts: partsJson.parts, colors: colorsJson.colors };
export const colorOf = (code) => cat.colors[String(code)] || { hex: '#C8C8C8', zh: `颜色 ${code}` };
export const luminance = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

const G = 0.012;   // 零件之间留的缝
const clean = (g) => { const n = g.index ? g.toNonIndexed() : g; if (n.attributes.uv) n.deleteAttribute('uv'); n.clearGroups(); return n; };
const box = (x0, x1, y0, y1, z0, z1) => { const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0); g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2); return clean(g); };
const stud = (x, z, y) => { const g = new THREE.CylinderGeometry(0.3, 0.3, 0.17, 24); g.translate(x, y + 0.085, z); return clean(g); };
const prism = (pts, sx) => {
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y))), { depth: sx - 2 * G, bevelEnabled: false });
  g.rotateY(-Math.PI / 2); g.translate((sx - 2 * G) / 2, 0, 0); return clean(g);
};
const cache = new Map();
/** { main, glass, edges }，本地坐标：占地中心在原点，底面 y=0 */
export function partGeometry(id) {
  if (cache.has(id)) return cache.get(id);
  const d = cat.parts[id], [sx, sz] = d.size, H = d.h * PLATE, hx = sx / 2, hz = sz / 2, list = [], glass = [];
  const studsOnTop = (y) => { for (const c of localCells(d)) if (c.stud) list.push(stud(c.lx, c.lz, y)); };
  if (d.kind === 'brick' || d.kind === 'plate' || d.kind === 'tile') { list.push(box(-hx + G, hx - G, 0, H - 0.004, -hz + G, hz - G)); studsOnTop(H - 0.004); }
  else if (d.kind === 'slope') { const lip = 0.2; list.push(prism([[-hz + G, 0], [hz - G, 0], [hz - G, lip], [-hz + 1, H - 0.004], [-hz + G, H - 0.004]], sx)); studsOnTop(H - 0.004); }
  else if (d.kind === 'ridge') { const lip = 0.2; list.push(prism([[-hz + G, 0], [hz - G, 0], [hz - G, lip], [0.06, H - 0.004], [-0.06, H - 0.004], [-hz + G, lip]], sx)); }
  else if (d.kind === 'doorframe') {
    list.push(box(-hx + G, -hx + 0.25, 0, H, -hz + G, hz - G), box(hx - 0.25, hx - G, 0, H, -hz + G, hz - G));
    list.push(box(-hx + 0.25, hx - 0.25, H - 0.15, H, -hz + G, hz - G), box(-hx + 0.25, hx - 0.25, H - 0.5, H - 0.15, 0, hz - G));
    list.push(box(-hx + 0.25, hx - 0.25, 0, 0.3, 0, hz - G)); studsOnTop(H);
  } else if (d.kind === 'door') {
    list.push(box(-1.75, 1.73, 0.35, 7.05, -0.4, -0.1));
    const h = new THREE.CylinderGeometry(0.12, 0.12, 0.56, 16); h.rotateX(Math.PI / 2); h.translate(1.3, 3.3, -0.25); list.push(clean(h));
    for (const [x0, x1] of [[-1.45, -0.08], [0.08, 1.45]]) for (const [y0, y1] of [[4.0, 5.3], [5.5, 6.8]]) glass.push(box(x0, x1, y0, y1, -0.43, -0.07));
  } else list.push(box(-hx + G, hx - G, 0, H, -hz + G, hz - G));
  const main = mergeGeometries(list); main.computeBoundingBox();
  const out = { main, glass: glass.length ? mergeGeometries(glass) : null, edges: new THREE.EdgesGeometry(main, 28) };
  cache.set(id, out); return out;
}
const Y = new THREE.Vector3(0, 1, 0);
/** 零件在模型中的基础矩阵（未开合、未爆炸） */
export function baseMatrix(p, def) {
  const c = partCenter(p, def);
  return new THREE.Matrix4().compose(new THREE.Vector3(c[0], c[1] * PLATE, c[2]), new THREE.Quaternion().setFromAxisAngle(Y, ((p.rot || 0) * Math.PI) / 180), new THREE.Vector3(1, 1, 1));
}
const _t = new THREE.Matrix4(), _r = new THREE.Matrix4();
/** 可开合设计在取值 v 时的变换（世界坐标，作用在零件基础矩阵之前） */
export function mechMatrix(m, v, out = new THREE.Matrix4()) {
  if (m.type === 'hinge') {
    const pv = new THREE.Vector3(m.pivot[0], m.pivot[1] * PLATE, m.pivot[2]);
    const ax = new THREE.Vector3(m.axis[0], m.axis[1] * PLATE, m.axis[2]).normalize();
    out.makeTranslation(pv.x, pv.y, pv.z).multiply(_r.makeRotationAxis(ax, (v * Math.PI) / 180)).multiply(_t.makeTranslation(-pv.x, -pv.y, -pv.z));
  } else if (m.type === 'slide') out.makeTranslation(m.axis[0] * v, m.axis[1] * PLATE * v, m.axis[2] * v);
  else out.makeTranslation(m.offset[0] * v, m.offset[1] * PLATE * v, m.offset[2] * v);
  return out;
}
export const mechRange = (m) => (m.type === 'removable' ? [0, 1] : [m.range?.[0] ?? 0, m.range?.[1] ?? 1]);
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
