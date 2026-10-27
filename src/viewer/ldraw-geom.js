// LDraw 烘焙几何 → THREE BufferGeometry（浏览器侧；纯解析在 src/ldraw/loader.mjs）。
// 输入是 render --geom ldraw 嵌入的 window.__LDRAW_GEOM__.data["part|color"]：
// { groups: {色码: [x,y,z,...]三角形}, lines: {色码: [...]线段} }，坐标为 brickkit 本地框架
// （占地中心原点、底面 y=0、未旋转；rot/up 由调用方 baseMatrix 施加——与 geom.js partGeometry 同一约定）。
import * as THREE from 'three';
import { colorOf } from './geom.js';

const cache = new Map();   // "part|color|实例色" → { main, edges, extras, bbox }（几何共享，Mesh 逐实例创建）

function faceGeo(arr) {
  if (!arr || !arr.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
  g.computeVertexNormals();
  g.computeBoundingBox();
  return g;
}
function lineGeo(map) {
  const flat = [];
  for (const arr of Object.values(map || {})) for (const v of arr) flat.push(v);
  if (!flat.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(flat, 3));
  return g;
}
const vcount = (g) => g.attributes.position.count;

/**
 * 构建零件本地几何集。返回 { main, edges, extras:[{geo, code}], bbox, fromLdraw:true }；
 * 无实体面（纯线框文件等）返回 null → 调用方回退参数化几何。
 * main = 与实例主色一致的组（没有则顶点数最多的组），其余面组进 extras（各自材质，随淡化切换）。
 */
export function ldrawLocalGeometry(key, baked, partColor) {
  const ck = `${key}|${partColor}`;
  if (cache.has(ck)) return cache.get(ck);
  const entries = Object.keys(baked.groups || {})
    .map((c) => [c, faceGeo(baked.groups[c])])
    .filter((e) => e[1]);
  if (!entries.length) return null;
  const prim = String(partColor);
  let primary = entries.find(([c]) => c === prim);
  if (!primary) primary = entries.reduce((a, b) => (vcount(a[1]) >= vcount(b[1]) ? a : b));
  const extras = entries.filter((e) => e !== primary).map(([code, geo]) => ({ geo, code }));
  const bbox = new THREE.Box3();
  for (const [, g] of entries) bbox.union(g.boundingBox);
  const out = { main: primary[1], edges: lineGeo(baked.lines) || new THREE.BufferGeometry(), extras, bbox, fromLdraw: true };
  cache.set(ck, out);
  return out;
}
