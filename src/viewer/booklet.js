// 拼装图纸：用离屏 WebGL 渲染每一步、零件图、子组件图，排成 A4 横版说明书页面（可打印 / 存为 PDF）。
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { cat, colorOf, luminance, partGeometry, baseMatrix, mechMatrix, mechRange, esc } from './geom.js';
import { bom, PLATE } from '../core/core.js';

const VIEW = { az: 32, el: 30 };     // 说明书固定视角：正面偏右、俯视 30°
const PPU = 44;                      // 零件图：每格渲染像素
const MAIN = [1800, 900];            // 步骤主图渲染尺寸
const MECH_ZH = { hinge: '合页', slide: '滑动', removable: '可取下' };
const tick = () => new Promise((r) => setTimeout(r, 0));
const V3 = THREE.Vector3;

export class Booklet {
  init() {
    if (this.r) return;
    const r = (this.r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }));
    r.setPixelRatio(1); r.setClearColor(0xffffff, 0); r.toneMapping = THREE.NeutralToneMapping;
    const sc = (this.scene = new THREE.Scene());
    const pm = new THREE.PMREMGenerator(r); sc.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; sc.environmentIntensity = 0.75; pm.dispose();
    sc.add(new THREE.HemisphereLight(0xffffff, 0xc9ccd2, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.0); key.position.set(-4, 10, 7); sc.add(key);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2000);
    this.mats = new Map(); this.lineMats = []; this.lineGeo = new Map();
    this.glass = new THREE.MeshStandardMaterial({ color: 0xbcd3e0, roughness: 0.1, transparent: true, opacity: 0.75 });
  }
  mat(code, faded) {
    const k = `${code}${faded ? '~' : ''}`;
    if (this.mats.has(k)) return this.mats.get(k);
    const c = colorOf(code), alpha = c.alpha ?? 1, col = new THREE.Color(c.hex), white = new THREE.Color(0xffffff);
    const body = faded ? col.clone().lerp(white, 0.62) : col;
    const solid = new THREE.MeshStandardMaterial({ color: body, roughness: 0.55, metalness: 0, transparent: alpha < 1, opacity: alpha, depthWrite: alpha >= 1,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const lc = luminance(col) < 0.04 ? new THREE.Color(0x707075) : col.clone().multiplyScalar(0.3);
    if (faded) lc.lerp(white, 0.55);
    const line = new LineMaterial({ color: lc, linewidth: 2.2 });
    this.lineMats.push(line);
    const m = { solid, line }; this.mats.set(k, m); return m;
  }
  makeGroup(part, code) {
    const g = partGeometry(part), m = this.mat(code, false);
    const group = new THREE.Group(); group.matrixAutoUpdate = false;
    let lg = this.lineGeo.get(part);
    if (!lg) { lg = new LineSegmentsGeometry().fromEdgesGeometry(g.edges); this.lineGeo.set(part, lg); }
    const mesh = new THREE.Mesh(g.main, m.solid), lines = new LineSegments2(lg, m.line);
    group.add(mesh, lines);
    if (g.glass) group.add(new THREE.Mesh(g.glass, this.glass));
    return { group, mesh, lines, localBox: g.main.boundingBox };
  }
  load(model, plan) {
    this.init();
    if (this.root) this.scene.remove(this.root);
    this.root = new THREE.Group(); this.scene.add(this.root);
    this.model = model; this.plan = plan; this.thumbs = new Map();
    const idx = new Map(plan.steps.map((s, i) => [s.n, i]));
    this.attachIdx = new Map([...plan.subs.values()].map((s) => [s.id, idx.get(s.attachStep)]));
    this.objs = [];
    for (const p of model.parts || []) {
      const def = cat.parts[p.part]; if (!def || !Array.isArray(p.at) || p.at.length !== 3) continue;
      const o = { p, def, ...this.makeGroup(p.part, p.color), base: baseMatrix(p, def), rank: idx.get(p.step) ?? 0, sub: plan.partSub.get(p.id) || null, mechs: [] };
      this.root.add(o.group); this.objs.push(o);
    }
    const byId = new Map(this.objs.map((o) => [o.p.id, o]));
    this.mechs = (model.mechanisms || []).filter((m) => m.parts?.length).map((m) => { const [lo, hi] = mechRange(m); const mm = { m, lo, hi }; for (const id of m.parts) byId.get(id)?.mechs.push(mm); return mm; });
    this.subMin = new Map();
    for (const o of this.objs) if (o.sub) this.subMin.set(o.sub, Math.min(this.subMin.get(o.sub) ?? Infinity, o.p.at[1]));
  }
  /** 摆好零件，返回可见零件的包围盒 */
  pose({ show, staged = () => false, lift = () => 0, mech = {}, fade = () => false }) {
    const M = new THREE.Matrix4(), T = new THREE.Matrix4(), box = new THREE.Box3(), tmp = new THREE.Box3();
    for (const o of this.objs) {
      const vis = !!show(o); o.group.visible = vis; if (!vis) continue;
      M.copy(o.base);
      for (const mm of o.mechs) M.premultiply(mechMatrix(mm.m, mech[mm.m.id] ?? mm.lo, T));
      M.premultiply(T.makeTranslation(0, (staged(o) ? -this.subMin.get(o.sub) * PLATE : 0) + lift(o), 0));
      o.group.matrix.copy(M); o.group.matrixWorldNeedsUpdate = true;
      const m = this.mat(o.p.color, !!fade(o)); o.mesh.material = m.solid; o.lines.material = m.line;
      box.union(tmp.copy(o.localBox).applyMatrix4(M));
    }
    return box;
  }
  orient(box, view = VIEW) {   // 把相机对准包围盒中心，返回包围盒在相机平面上的范围
    const a = (view.az * Math.PI) / 180, e = (view.el * Math.PI) / 180, cam = this.cam;
    const c = box.getCenter(new V3());
    cam.position.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)).multiplyScalar(500).add(c);
    cam.up.set(0, 1, 0); cam.lookAt(c); cam.updateMatrixWorld();
    return this.extents(box);
  }
  extents(box) {
    const v = new V3(), e = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(this.cam.matrixWorldInverse);
      e.x0 = Math.min(e.x0, v.x); e.x1 = Math.max(e.x1, v.x); e.y0 = Math.min(e.y0, v.y); e.y1 = Math.max(e.y1, v.y);
    }
    return e;
  }
  setFrustum(e, W, H, s) {
    const cx = (e.x0 + e.x1) / 2, cy = (e.y0 + e.y1) / 2, cam = this.cam;
    Object.assign(cam, { left: cx - W / 2 / s, right: cx + W / 2 / s, top: cy + H / 2 / s, bottom: cy - H / 2 / s, near: 1, far: 1000 });
    cam.updateProjectionMatrix();
  }
  /** 渲染一张图：box=要放进画面的范围；series=同一组步骤的整体范围（保持比例一致，最多放大 maxZoom 倍） */
  shot(box, { W = MAIN[0], H = MAIN[1], pad = 0.05, series = null, maxZoom = 1.35, view = VIEW, lw = 2.4 } = {}) {
    const fit = (e) => Math.min((W * (1 - 2 * pad)) / Math.max(1e-6, e.x1 - e.x0), (H * (1 - 2 * pad)) / Math.max(1e-6, e.y1 - e.y0));
    const e = this.orient(box, view);
    let s = fit(e);
    if (series) s = Math.min(s, fit(this.extents(series)) * maxZoom);
    this.setFrustum(e, W, H, s);
    return this.draw(W, H, lw);
  }
  draw(W, H, lw) {
    this.r.setSize(W, H, false);
    for (const m of this.lineMats) { m.resolution.set(W, H); m.linewidth = lw; }
    this.r.render(this.scene, this.cam);
    return this.r.domElement;
  }
  px(v, W, H) { const p = v.clone().project(this.cam); return [((p.x + 1) / 2) * W, ((1 - p.y) / 2) * H]; }
  url(canvas) { return canvas.toDataURL('image/webp', 0.94); }
  /** 零件图（所有零件同一比例，太大的缩小），返回 { url, cqw } */
  thumbOf(box, max = 400) {
    const e = this.orient(box), padU = 0.3, wU = e.x1 - e.x0 + 2 * padU, hU = e.y1 - e.y0 + 2 * padU;
    const ppu = Math.min(PPU, max / Math.max(wU, hU)), W = Math.ceil(wU * ppu), H = Math.ceil(hU * ppu);
    this.setFrustum(e, W, H, ppu);
    return { url: this.url(this.draw(W, H, 2.6)), studs: W / PPU };
  }
  partThumb(part, color) {
    const k = `${part}|${color}`; if (this.thumbs.has(k)) return this.thumbs.get(k);
    const t = this.makeGroup(part, color); t.group.matrix.identity();
    this.root.visible = false; this.scene.add(t.group);
    const res = this.thumbOf(t.localBox.clone());
    this.scene.remove(t.group); this.root.visible = true;
    this.thumbs.set(k, res); return res;
  }
  subThumb(id) {
    const k = `sub:${id}`; if (this.thumbs.has(k)) return this.thumbs.get(k);
    const res = this.thumbOf(this.pose({ show: (o) => o.sub === id, staged: () => true }), 420);
    this.thumbs.set(k, res); return res;
  }

  /** 逐页生成；onPage(html, i, total) 返回 false 时中止 */
  async build({ fade = false } = {}, onPage) {
    const { model, plan } = this, steps = plan.steps, name = model.meta?.name || '未命名模型';
    const subs = [...plan.subs.values()];
    const invRows = bom(model, cat, (p) => cat.parts[p.part]);
    const INV_PER = 24, invPages = Math.max(1, Math.ceil(invRows.length / INV_PER));
    const mechs = this.mechs;
    const total = 1 + steps.length + (mechs.length ? 1 : 0) + invPages;
    let n = 0;
    const emit = async (html) => { await tick(); return onPage(html, n++, total) !== false; };
    const foot = () => `<footer class="pg-foot"><span>${esc(name)}</span><span class="pg-n">${n + 1}</span></footer>`;
    const isMain = (o) => !o.sub;
    const final = { show: () => true };
    const all = this.pose(final);
    const seriesMain = all.clone();
    const seriesSub = new Map(subs.map((s) => [s.id, this.pose({ show: (o) => o.sub === s.id, staged: () => true })]));

    // 封面
    let img = this.url(this.shot(this.pose(final), { W: 1800, H: 1040, pad: 0.04, view: { az: 30, el: 24 }, lw: 2.2 }));
    const nParts = this.objs.length, nMech = mechs.length;
    if (!(await emit(`<article class="page cover"><header class="cv-head"><p class="cv-kicker">拼装图纸</p><h2 class="cv-title">${esc(name)}</h2>${model.meta?.description ? `<p class="cv-desc">${esc(model.meta.description)}</p>` : ''}</header>
      <div class="p-img"><img src="${img}" alt="${esc(name)} 完整模型"></div>
      <footer class="cv-foot"><div class="cv-stats"><span><b>${nParts}</b>个零件</span><span><b>${steps.length}</b>步</span>${nMech ? `<span><b>${nMech}</b>处可开合</span>` : ''}${subs.length ? `<span><b>${subs.length}</b>个子组件</span>` : ''}</div><span class="cv-brand">brickkit</span></footer></article>`))) return;

    // 每一步
    for (const [i, st] of steps.entries()) {
      const cur = (o) => o.rank === i;
      let box, arrow = null;
      const liftH = st.attach ? Math.max(6, (seriesSub.get(st.attach).max.y - seriesSub.get(st.attach).min.y) * 1.8) : 0;
      if (st.sub) box = this.pose({ show: (o) => o.sub === st.sub && o.rank <= i, staged: () => true, fade: (o) => fade && !cur(o) });
      else {
        const show = (o) => o.rank <= i && (!o.sub || this.attachIdx.get(o.sub) <= i);
        if (st.attach) {   // 装配步：子组件在最终位置正上方，画箭头
          const fin = this.pose({ show: (o) => o.sub === st.attach });
          const bc = new V3((fin.min.x + fin.max.x) / 2, fin.min.y, (fin.min.z + fin.max.z) / 2);
          arrow = { from: bc.clone().setY(fin.min.y + liftH), to: bc };
        }
        box = this.pose({ show, lift: (o) => (st.attach && o.sub === st.attach ? liftH : 0), fade: (o) => fade && !cur(o) && !(st.attach && o.sub === st.attach) });
      }
      const series = st.sub ? seriesSub.get(st.sub) : seriesMain;
      const canvas = this.shot(box, { series, maxZoom: st.sub ? 1.15 : 1.3 });
      img = arrow ? this.url(drawArrow(canvas, this.px(arrow.from, ...MAIN), this.px(arrow.to, ...MAIN))) : this.url(canvas);
      // 零件 callout
      let callout;
      if (st.attach) {
        const t = this.subThumb(st.attach);
        callout = `<figure class="ci mod"><div class="mini-frame"><img src="${t.url}" style="--w:${t.studs.toFixed(2)}" alt="子组件 ${esc(plan.subs.get(st.attach).label)}"></div><figcaption>1×</figcaption></figure>`;
      } else {
        const ids = new Set(st.parts);
        callout = bom(model, cat, (p) => ids.has(p.id) && cat.parts[p.part]).map((r) => {
          const t = this.partThumb(r.part, r.color);
          return `<figure class="ci"><img src="${t.url}" style="--w:${t.studs.toFixed(2)}" alt="${esc(r.def.zh)} ${esc(colorOf(r.color).zh)}"><figcaption>${r.qty}×</figcaption></figure>`;
        }).join('');
      }
      const unsure = st.parts.map((id) => model.parts.find((p) => p.id === id)).filter((p) => p && (p.status === 'uncertain' || p.status === 'inferred'));
      const flag = unsure.length ? `<p class="p-flag">本步 ${unsure.length} 个零件为推断或存疑，请对照实物确认</p>` : '';
      const head = `<div class="p-head"><div class="p-num"><div class="stepnum">${i + 1}</div>${st.title ? `<div class="steptitle">${esc(st.title)}</div>` : ''}</div>${callout ? `<div class="callout">${callout}</div>` : ''}${flag}</div>
        <div class="p-img"><img src="${img}" alt="第 ${i + 1} 步${st.title ? `：${esc(st.title)}` : ''}"></div>`;
      let body = head;
      if (st.sub) {
        const sub = plan.subs.get(st.sub), k = sub.steps.indexOf(st.n) + 1;
        body = `<div class="subframe"><div class="sublabel"><span>子组件</span><b>${esc(sub.label)}</b><span class="sub-n">${k} / ${sub.steps.length}</span></div>${head}</div>`;
      }
      if (!(await emit(`<article class="page step${st.sub ? ' is-sub' : ''}${st.attach ? ' is-attach' : ''}" data-step="${i + 1}">${body}${foot()}</article>`))) return;
    }

    // 可开合设计
    if (mechs.length) {
      const cards = mechs.map((mm) => {
        const m = mm.m, view = m.type === 'removable' ? { az: 30, el: 40 } : m.type === 'hinge' ? { az: 18, el: 22 } : VIEW;
        const box = this.pose({ show: () => true, mech: { [m.id]: mm.hi } });
        const url = this.url(this.shot(box, { W: 1200, H: 900, pad: 0.06, view, lw: 2.2 }));
        const range = m.type === 'removable' ? '整体取下' : m.type === 'hinge' ? `可转 ${mm.lo}°–${mm.hi}°` : `可滑动 ${mm.lo}–${mm.hi} 格`;
        return `<figure class="mcard"><div class="mimg"><img src="${url}" alt="${esc(m.label || m.id)} 打开状态"></div><figcaption><b>${esc(m.label || m.id)}</b><span>${MECH_ZH[m.type] || m.type} · ${range} · ${m.parts.length} 个零件</span></figcaption></figure>`;
      }).join('');
      if (!(await emit(`<article class="page mech"><header class="pg-title"><h3>可开合设计</h3><p>按照片里的打开状态还原</p></header><div class="mech-grid n${Math.min(mechs.length, 3)}">${cards}</div>${foot()}</article>`))) return;
    }

    // 零件清单
    const totalQty = invRows.reduce((a, r) => a + r.qty, 0);
    for (let k = 0; k < invPages; k++) {
      const cells = invRows.slice(k * INV_PER, (k + 1) * INV_PER).map((r) => {
        const t = this.partThumb(r.part, r.color);
        return `<figure class="inv"><div class="inv-img"><img src="${t.url}" style="--w:${t.studs.toFixed(2)}" alt="${esc(r.def.zh)}"></div><figcaption><b>${r.qty}×</b><span>${esc(r.part)}</span><span class="inv-c">${esc(r.def.zh)} · ${esc(colorOf(r.color).zh)}</span></figcaption></figure>`;
      }).join('');
      if (!(await emit(`<article class="page inv-page"><header class="pg-title"><h3>零件清单${invPages > 1 ? ` ${k + 1}/${invPages}` : ''}</h3><p>共 ${totalQty} 个零件 · ${invRows.length} 种</p></header><div class="inv-grid">${cells}</div>${foot()}</article>`))) return;
    }
    this.pose(final);
  }
}

function drawArrow(src, from, to) {   // 竖直箭头：在子组件和主体之间的空隙里，从上往下指向安装位置
  const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
  const g = c.getContext('2d'); g.drawImage(src, 0, 0);
  const x = Math.round(to[0]), y0 = Math.max(0, Math.round(from[1])), y1 = Math.min(c.height - 1, Math.round(to[1]));
  const col = g.getImageData(x, 0, 1, c.height).data, opaque = (y) => col[y * 4 + 3] > 24;
  let top = -1;
  for (let y = y0; y <= y1; y++) if (!opaque(y)) { top = y; break; }            // 子组件下沿
  if (top < 0 || y1 - top < 70) return c;
  const a = top + 16, b = y1 - 4, sw = 9, hw = 26, hl = Math.min(42, (b - a) * 0.5);   // 箭头尖 = 子组件中心落下的位置
  g.beginPath();
  [[x - sw, a], [x + sw, a], [x + sw, b - hl], [x + hw, b - hl], [x, b], [x - hw, b - hl], [x - sw, b - hl]].forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
  g.closePath(); g.lineJoin = 'round'; g.lineWidth = 8; g.strokeStyle = '#FFFFFF'; g.stroke(); g.fillStyle = '#0071E3'; g.fill();
  return c;
}
