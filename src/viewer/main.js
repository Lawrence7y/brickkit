import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HorizontalBlurShader } from 'three/examples/jsm/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/examples/jsm/shaders/VerticalBlurShader.js';
import demoModel from '../../examples/cottage.brick.json';
import { validate, bom, toLDraw, ldrawExt, stepPlan, partModule, moduleChain, PLATE } from '../core/core.js';
import { cat, colorOf, luminance, partGeometry, baseMatrix, mechMatrix, mechRange, esc } from './geom.js';
import { Booklet } from './booklet.js';

const $ = (s) => document.querySelector(s);
const V3 = THREE.Vector3;
const params = new URLSearchParams(location.hash.slice(1));
const SHOT = params.has('shot');
const reduceMotion = SHOT || matchMedia('(prefers-reduced-motion: reduce)').matches;
const STATUS_ZH = { confirmed: '已确认', inferred: '推断', uncertain: '存疑' };
const MECH_ZH = { hinge: '合页', slide: '滑动', removable: '可取下' };
const VIEW = [35, 26];

// ------------------------------------------------------------------ 材质
const matCache = new Map();
function mats(code) {
  if (matCache.has(code)) return matCache.get(code);
  const c = colorOf(code), alpha = c.alpha ?? 1, col = new THREE.Color(c.hex), l = luminance(col);
  const solid = new THREE.MeshPhysicalMaterial({ color: col, roughness: alpha < 1 ? 0.06 : 0.36, metalness: 0, clearcoat: alpha < 1 ? 0 : 0.3, clearcoatRoughness: 0.35,
    transparent: alpha < 1, opacity: alpha, depthWrite: alpha >= 1, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const faded = new THREE.MeshStandardMaterial({ color: col, roughness: 0.5, transparent: true, opacity: 0.14, depthWrite: false });
  const edge = new THREE.LineBasicMaterial({ color: l < 0.03 ? 0x9a9aa0 : col.clone().multiplyScalar(0.45), transparent: true, opacity: l < 0.03 ? 0.5 : 0.42 });
  const m = { solid, faded, edge }; matCache.set(code, m); return m;
}
const glassMat = new THREE.MeshPhysicalMaterial({ color: 0xbfd4e0, roughness: 0.05, transparent: true, opacity: 0.7 });
const edgeMats = {
  accent: new THREE.LineBasicMaterial({ color: 0x0071e3 }),
  inferred: new THREE.LineBasicMaterial({ color: 0xd5803b }),
  uncertain: new THREE.LineBasicMaterial({ color: 0xe0483a }),
  faded: new THREE.LineBasicMaterial({ color: 0x8e8e93, transparent: true, opacity: 0.1 }),
};

// ------------------------------------------------------------------ 场景
const canvas = $('#c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: SHOT });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0xffffff, 0);
renderer.toneMapping = THREE.NeutralToneMapping;
const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.8;
scene.add(new THREE.HemisphereLight(0xffffff, 0xd9d9de, 0.65));
const key = new THREE.DirectionalLight(0xffffff, 1.25); key.position.set(-6, 14, 10); scene.add(key);
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 2000);
const controls = new OrbitControls(camera, canvas);
controls.addEventListener('start', () => { S.userMoved = true; camAnim.t = 1; });
controls.addEventListener('change', () => { S.dirty = true; });
controls.enableDamping = true; controls.dampingFactor = 0.08; controls.maxPolarAngle = Math.PI * 0.495;
const root = new THREE.Group(); scene.add(root);
const selBox = new THREE.Box3Helper(new THREE.Box3(), 0x0071e3); selBox.visible = false; scene.add(selBox);

// 接触阴影：从地面往上拍一张深度图，模糊后贴在地面上（比阴影贴图更柔和，适合白色背景）
const shadow = (() => {
  const N = 512, rt = new THREE.WebGLRenderTarget(N, N), rtBlur = new THREE.WebGLRenderTarget(N, N);
  rt.texture.generateMipmaps = rtBlur.texture.generateMipmaps = false;
  const group = new THREE.Group(); scene.add(group);
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ map: rt.texture, transparent: true, opacity: 0.62, depthWrite: false }));
  plane.renderOrder = 1; plane.scale.y = -1; group.add(plane);
  const blurPlane = new THREE.Mesh(plane.geometry); blurPlane.visible = false; group.add(blurPlane);
  const cam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1); cam.rotation.x = Math.PI / 2; group.add(cam);
  const depth = new THREE.MeshDepthMaterial(); depth.depthTest = depth.depthWrite = false;
  depth.onBeforeCompile = (sh) => { sh.fragmentShader = sh.fragmentShader.replace('gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );', 'gl_FragColor = vec4( vec3( 0.0 ), ( 1.0 - fragCoordZ ) * 1.15 );'); };
  const hBlur = new THREE.ShaderMaterial(HorizontalBlurShader), vBlur = new THREE.ShaderMaterial(VerticalBlurShader); hBlur.depthTest = vBlur.depthTest = false;
  const blur = (amount) => {
    blurPlane.visible = true;
    blurPlane.material = hBlur; hBlur.uniforms.tDiffuse.value = rt.texture; hBlur.uniforms.h.value = amount / 256;
    renderer.setRenderTarget(rtBlur); renderer.render(blurPlane, cam);
    blurPlane.material = vBlur; vBlur.uniforms.tDiffuse.value = rtBlur.texture; vBlur.uniforms.v.value = amount / 256;
    renderer.setRenderTarget(rt); renderer.render(blurPlane, cam);
    blurPlane.visible = false;
  };
  return {
    fit(w, d, h) {   // 地面阴影范围 w×d，向上取 h 高度内的物体
      plane.geometry.dispose(); plane.geometry = blurPlane.geometry = new THREE.PlaneGeometry(w, d).rotateX(Math.PI / 2);
      Object.assign(cam, { left: -w / 2, right: w / 2, top: d / 2, bottom: -d / 2, near: 0, far: h }); cam.updateProjectionMatrix();
    },
    render() {
      const sel = selBox.visible; selBox.visible = false; group.visible = false;
      scene.overrideMaterial = depth;
      renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, cam);
      scene.overrideMaterial = null; group.visible = true; selBox.visible = sel;
      blur(2.6); blur(1.0);
      renderer.setRenderTarget(null);
    },
  };
})();

// ------------------------------------------------------------------ 状态
const S = { ndc: { upper: 1, lower: -1 }, userMoved: false, model: null, plan: null, objs: [], byId: new Map(), steps: [], stepIdx: 0, attachIdx: new Map(), mechs: [],
  explode: { cur: 0, target: 0 }, emode: 'layer', opts: { highlight: true, fade: false, status: false }, sel: null, hiModule: null, playing: null, report: null, bomTab: 'step',
  center: new V3(), size: new V3(), layerGap: 1, hasModules: false, fitKey: 'main', shadowFrames: 0, dirty: true, mode: '3d', book: null, bookDirty: true };
const curStep = () => S.steps[S.stepIdx];
const lastIdx = () => S.steps.length - 1;
const ease = (t) => 1 - Math.pow(1 - t, 3);
const kick = () => { S.shadowFrames = Math.max(S.shadowFrames, 3); S.dirty = true; };

function loadModel(model, { keepCamera = false } = {}) {
  for (const o of S.objs) root.remove(o.group);
  S.model = model; S.objs = []; S.byId.clear(); S.sel = null; S.hiModule = null; selBox.visible = false; $('#infocard').hidden = true;
  S.report = validate(model, cat);
  S.plan = stepPlan(model);
  S.steps = S.plan.steps.length ? S.plan.steps : [{ n: 1, title: '', parts: [], attach: null, sub: null }];
  const idx = new Map(S.steps.map((s, i) => [s.n, i]));
  S.attachIdx = new Map([...S.plan.subs.values()].map((s) => [s.id, idx.get(s.attachStep)]));
  const bb = new THREE.Box3(), tmp = new THREE.Box3();
  for (const p of model.parts || []) {
    const def = cat.parts[p.part]; if (!def || !Array.isArray(p.at) || p.at.length !== 3) continue;
    const g = partGeometry(p.part), m = mats(p.color);
    const group = new THREE.Group(); group.matrixAutoUpdate = false;
    const mesh = new THREE.Mesh(g.main, m.solid); mesh.userData.id = p.id;
    const edges = new THREE.LineSegments(g.edges, m.edge);
    group.add(mesh, edges);
    const meshes = [mesh];
    if (g.glass) { const gm = new THREE.Mesh(g.glass, glassMat); gm.userData.id = p.id; group.add(gm); meshes.push(gm); }
    const base = baseMatrix(p, def);
    const o = { p, def, group, mesh, edges, meshes, base, localBox: g.main.boundingBox, rank: idx.get(p.step) ?? 0, sub: S.plan.partSub.get(p.id) || null, module: partModule(p),
      layer: p.at[1], layerRank: 0, mechs: [], drop: 1, dropH: 2.6, staged: false, off: new V3(), offTarget: new V3(), modOff: new V3(), stageOff: new V3() };
    bb.union(tmp.copy(o.localBox).applyMatrix4(base));
    S.objs.push(o); S.byId.set(p.id, o); root.add(group);
  }
  if (bb.isEmpty()) bb.set(new V3(0, 0, 0), new V3(1, 1, 1));
  bb.getCenter(S.center); bb.getSize(S.size);
  root.position.set(-S.center.x, 0, -S.center.z);
  const subMin = new Map();
  for (const o of S.objs) if (o.sub) subMin.set(o.sub, Math.min(subMin.get(o.sub) ?? Infinity, o.layer));
  for (const o of S.objs) if (o.sub) o.stageOff.set(0, -subMin.get(o.sub) * PLATE, 0);   // 子组件在装上之前放在地面上拼
  const layers = [...new Set(S.objs.map((o) => o.layer))].sort((a, b) => a - b);
  for (const o of S.objs) o.layerRank = layers.indexOf(o.layer);
  S.layerGap = Math.max(0.6, (S.size.y * 1.1) / Math.max(1, layers.length - 1));
  computeModuleOffsets();
  S.mechs = (model.mechanisms || []).filter((m) => m.parts && m.parts.length).map((m) => {
    const [lo, hi] = mechRange(m), v = m.default ?? lo, mm = { m, lo, hi, cur: v, target: v };
    for (const id of m.parts) S.byId.get(id)?.mechs.push(mm);
    return mm;
  });
  const r = Math.max(S.size.x, S.size.z);
  shadow.fit(r * 3 + 8, r * 3 + 8, Math.max(2, S.size.y * 0.8));
  if (!S.hasModules && S.emode === 'module') S.emode = 'layer';
  S.stepIdx = lastIdx(); S.fitKey = 'main';
  for (const o of S.objs) o.drop = 1;
  computeExplodeTargets(true);
  buildUI(); refreshLook(); updateStepUI();
  S.userMoved = false; if (!keepCamera) setView(...VIEW, 1);
  S.bookDirty = true; if (S.mode === 'book') buildBooklet();
}

function computeModuleOffsets() {   // 每个模块的爆炸位移：用 modules[].explode，没写的自动按高度排开；子模块叠加父模块的位移
  const mods = S.plan.mods, own = new Map(), stat = new Map();
  for (const o of S.objs) if (o.module) {
    const s = stat.get(o.module) || { min: Infinity, x: 0, z: 0, n: 0 }, e = o.base.elements;
    s.min = Math.min(s.min, o.layer); s.x += e[12]; s.z += e[14]; s.n++; stat.set(o.module, s);
  }
  const ids = [...new Set([...mods.keys(), ...stat.keys()])];
  const auto = ids.filter((id) => !mods.get(id)?.explode && !mods.get(id)?.parent).sort((a, b) => (stat.get(a)?.min ?? 0) - (stat.get(b)?.min ?? 0));
  const gap = Math.max(1.5, S.size.y * 0.45);
  auto.forEach((id, i) => { const s = stat.get(id); own.set(id, new V3(s ? (s.x / s.n - S.center.x) * 0.35 : 0, i * gap, s ? (s.z / s.n - S.center.z) * 0.35 : 0)); });
  for (const [id, m] of mods) if (Array.isArray(m.explode)) own.set(id, new V3(m.explode[0], m.explode[1] * PLATE, m.explode[2]));
  for (const o of S.objs) {
    o.modOff.set(0, 0, 0);
    if (o.module) for (const k of moduleChain(mods, o.module)) if (own.has(k)) o.modOff.add(own.get(k));
  }
  S.hasModules = stat.size > 0;
}
function moduleTree() {
  const mods = S.plan.mods, ids = [...new Set([...mods.keys(), ...S.objs.map((o) => o.module).filter(Boolean)])], out = [];
  const walk = (id, d) => { out.push({ id, d, m: mods.get(id) || { id }, n: S.objs.filter((o) => o.module && moduleChain(mods, o.module).includes(id)).length }); for (const c of ids.filter((k) => mods.get(k)?.parent === id)) walk(c, d + 1); };
  for (const id of ids.filter((k) => !mods.get(k)?.parent || !mods.has(mods.get(k).parent))) walk(id, 0);
  return out;
}

// ------------------------------------------------------------------ 姿态与相机
const _M = new THREE.Matrix4(), _T = new THREE.Matrix4(), _MM = new THREE.Matrix4(), _v = new V3();
function compose(o, out, target, staged = o.staged) {
  out.copy(o.base);
  for (const mm of o.mechs) out.premultiply(mechMatrix(mm.m, target ? mm.target : mm.cur, _MM));
  _v.copy(target ? o.offTarget : o.off);
  if (staged) _v.add(o.stageOff);
  if (!target) _v.y += (1 - ease(o.drop)) * o.dropH;
  return out.premultiply(_T.makeTranslation(_v.x, _v.y, _v.z));
}
function contextFit() {   // 当前“场景”（主体或某个子组件）在目标姿态下的范围，步骤之间保持稳定
  const st = curStep(), set = st.sub ? S.objs.filter((o) => o.sub === st.sub) : S.objs;
  const box = new THREE.Box3(), tmp = new THREE.Box3();
  for (const o of set) box.union(tmp.copy(o.localBox).applyMatrix4(compose(o, _M, true, !!st.sub)));
  if (box.isEmpty()) box.set(new V3(-1, 0, -1), new V3(1, 1, 1)); else box.translate(root.position);
  return { box, target: box.getCenter(new V3()) };
}
const _corner = new V3();
function fitDistance(dir, target, box) {   // 让包围盒 8 个角都落在可见区域内
  const cam = camera.clone(); let d = Math.max(4, box.getSize(new V3()).length() * 1.6);
  for (let it = 0; it < 7; it++) {
    cam.position.copy(dir).multiplyScalar(d).add(target); cam.lookAt(target); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    let m = 0; const { upper, lower } = S.ndc, mid = (upper + lower) / 2, half = ((upper - lower) / 2) * 0.9;
    for (let i = 0; i < 8; i++) {
      _corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(cam);
      m = Math.max(m, Math.abs(_corner.x) / 0.84, Math.abs(_corner.y - mid) / half);
    }
    d *= 0.35 + 0.65 * m;
  }
  return d;
}
const camAnim = { t: 1 };
function setView(az, el, zoom = 1, animate = false, fit = contextFit()) {
  applyInsets();
  const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
  const dir = new V3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
  const pos = dir.clone().multiplyScalar(fitDistance(dir, fit.target, fit.box) * zoom * (curStep()?.sub ? 1.18 : 1)).add(fit.target);
  S.dirty = true;
  if (!animate || reduceMotion) { camera.position.copy(pos); controls.target.copy(fit.target); controls.update(); camAnim.t = 1; return; }
  Object.assign(camAnim, { t: 0, p0: camera.position.clone(), t0: controls.target.clone(), p1: pos, t1: fit.target.clone() });
}
function fitCurrent() {   // 保持当前观察方向，重新取景
  const dir = camera.position.clone().sub(controls.target).normalize();
  setView((Math.atan2(dir.x, dir.z) * 180) / Math.PI, (Math.asin(dir.y) * 180) / Math.PI, 1, true);
}
const refit = () => (S.userMoved ? fitCurrent() : setView(...VIEW, 1, true));

// ------------------------------------------------------------------ 爆炸 / 每帧
function computeExplodeTargets(snap) {
  const f = S.explode.target;
  for (const o of S.objs) {
    if (S.emode === 'layer') o.offTarget.set(0, f * S.layerGap * o.layerRank, 0);
    else o.offTarget.copy(o.modOff).multiplyScalar(f);
    if (snap) o.off.copy(o.offTarget);
  }
  kick();
}
function frameUpdate(dt) {
  const kf = reduceMotion ? 1 : 1 - Math.exp(-dt * 9);
  let moving = false;
  const de = S.explode.target - S.explode.cur; if (Math.abs(de) > 1e-4) moving = true; S.explode.cur += de * kf;
  for (const mm of S.mechs) { const d = mm.target - mm.cur; if (Math.abs(d) > 1e-3) moving = true; mm.cur += d * kf; }
  for (const o of S.objs) {
    if (!o.group.visible) continue;
    if (o.off.distanceToSquared(o.offTarget) > 1e-7) { moving = true; o.off.lerp(o.offTarget, kf); } else o.off.copy(o.offTarget);
    if (o.drop < 1) { moving = true; o.drop = reduceMotion ? 1 : Math.min(1, o.drop + dt / 0.55); }
    compose(o, o.group.matrix, false); o.group.matrixWorldNeedsUpdate = true;
  }
  if (moving) kick();
  if (camAnim.t < 1) {
    camAnim.t = Math.min(1, camAnim.t + dt / 0.6); const e = ease(camAnim.t);
    camera.position.lerpVectors(camAnim.p0, camAnim.p1, e); controls.target.lerpVectors(camAnim.t0, camAnim.t1, e); S.dirty = true;
  }
  const o = S.sel && S.byId.get(S.sel);
  if (o && o.group.visible) { o.group.updateMatrixWorld(true); selBox.box.setFromObject(o.mesh); selBox.visible = true; } else selBox.visible = false;
}

// ------------------------------------------------------------------ 外观
function moduleSet(id) { const mods = S.plan.mods; return new Set(S.objs.map((o) => o.module).filter((m) => m && moduleChain(mods, m).includes(id))); }
function refreshLook() {
  const st = curStep(), i = S.stepIdx, isLast = i === lastIdx(), hi = S.hiModule ? moduleSet(S.hiModule) : null;
  for (const o of S.objs) {
    const vis = st.sub ? o.sub === st.sub && o.rank <= i : o.rank <= i && (!o.sub || (S.attachIdx.get(o.sub) ?? 0) <= i);
    if (vis && !o.group.visible) o.off.copy(o.offTarget);
    o.group.visible = vis; if (!vis) continue;
    o.staged = !!(o.sub && i < (S.attachIdx.get(o.sub) ?? -1));
    const m = mats(o.p.color), current = o.rank === i || (st.attach && o.sub === st.attach);
    const dim = (S.opts.fade && !current && !isLast) || (hi && !hi.has(o.module));
    o.mesh.material = dim ? m.faded : m.solid;
    let e = dim ? edgeMats.faded : m.edge;
    if (S.opts.highlight && current && !isLast) e = edgeMats.accent;
    if (S.opts.status && (o.p.status === 'inferred' || o.p.status === 'uncertain')) e = edgeMats[o.p.status];
    if (o.p.id === S.sel) e = edgeMats.accent;
    o.edges.material = e;
  }
  kick();
}

// ------------------------------------------------------------------ 步骤
function goStep(i, animateNew = true) {
  i = Math.max(0, Math.min(lastIdx(), i)); const forward = i === S.stepIdx + 1;
  S.stepIdx = i; const st = curStep();
  for (const o of S.objs) {
    const attaching = st.attach && o.sub === st.attach, current = o.rank === i || attaching;
    o.drop = current && forward && animateNew ? 0 : 1; o.dropH = attaching ? Math.max(4, S.size.y * 0.45) : 2.6;
  }
  refreshLook(); updateStepUI();
  const k = st.sub || 'main';
  if (k !== S.fitKey) { S.fitKey = k; refit(); }
}
function togglePlay(force) {
  const on = force ?? !S.playing;
  if (S.playing) { clearInterval(S.playing); S.playing = null; }
  if (on) { if (S.stepIdx === lastIdx()) goStep(0, false); S.playing = setInterval(() => { if (S.stepIdx >= lastIdx()) togglePlay(false); else goStep(S.stepIdx + 1); }, 1200); }
  $('#play').innerHTML = on ? ICON.pause : ICON.play; $('#play').setAttribute('aria-label', on ? '暂停' : '播放');
}
function updateStepUI() {
  const st = curStep(), badge = $('#step-badge');
  $('#step-num').textContent = `第 ${S.stepIdx + 1} / ${S.steps.length} 步`;
  $('#step-title').textContent = S.stepIdx === lastIdx() && !st.title ? '完整模型' : st.title || '';
  const sub = st.sub || st.attach;
  badge.hidden = !sub; if (sub) badge.textContent = `${st.sub ? '子组件' : '装配'} · ${S.plan.subs.get(sub).label}`;
  const r = $('#step-range'); r.max = String(lastIdx()); r.value = String(S.stepIdx); paintRange(r);
  renderBom();
}

// ------------------------------------------------------------------ 界面
const ICON = {
  first: '<svg viewBox="0 0 24 24"><path d="M6 5v14M18 6l-8 6 8 6z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  last: '<svg viewBox="0 0 24 24"><path d="M18 5v14M6 6l8 6-8 6z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path class="fill" d="M8 5.5v13l10.5-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M9 6v12M15 6v12"/></svg>',
  reset: '<svg viewBox="0 0 24 24"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3.7h3.7"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>',
};
const partLabel = (p) => cat.parts[p.part]?.zh || p.part;

function buildUI() {
  const m = S.model, st = S.report.stats || {};
  $('#m-name').textContent = m.meta?.name || '未命名模型';
  document.title = `${m.meta?.name || '模型'} · brickkit`;
  $('#m-meta').textContent = `${st.parts ?? S.objs.length} 个零件 · ${S.steps.length} 步${S.mechs.length ? ` · ${S.mechs.length} 处可开合` : ''}`;
  // 爆炸方式
  const modBtn = $('[data-emode="module"]'); modBtn.disabled = !S.hasModules; modBtn.title = S.hasModules ? '' : '模型里没有定义模块（零件的 module 字段）';
  document.querySelectorAll('[data-emode]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.emode === S.emode));
  renderModules();
  // 检查结果
  const rep = S.report, chip = $('#check-chip');
  const nE = rep.errors.length, nW = rep.warnings.length;
  chip.className = 'chip ' + (nE ? 'risk' : nW ? 'attention' : 'positive');
  chip.textContent = nE ? `${nE} 个错误` : nW ? `${nW} 个警告` : '校验通过';
  const items = [...rep.errors.map((x) => ['risk', '错误', x]), ...rep.warnings.map((x) => ['attention', '警告', x]), ...rep.info.map((x) => ['info', '提示', x])];
  $('#checks').innerHTML = items.length ? items.map(([k, label, x], i) => `<li><button class="check" data-i="${i}"><span class="tag ${k}">${label}</span><span>${esc(x.msg)}</span></button></li>`).join('') : '<li class="empty">没有发现问题</li>';
  $('#checks').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { const x = items[+b.dataset.i][2]; if (x.parts?.length) select(x.parts[0], true); }));
  $('#conf-line').innerHTML = `<span><i class="dot positive"></i>已确认 ${st.confirmed ?? 0}</span><span><i class="dot attention"></i>推断 ${st.inferred ?? 0}</span><span><i class="dot risk"></i>存疑 ${st.uncertain ?? 0}</span>`;
  if (nE) $('#data-sec').open = true;
  // 可开合
  $('#mech-section').hidden = !S.mechs.length;
  $('#mechs').innerHTML = S.mechs.map((mm, i) => {
    const isOpen = Math.abs(mm.target - mm.lo) > 1e-6, slider = mm.m.type !== 'removable';
    return `<li class="mech"><div class="mech-head"><div><div class="mech-name">${esc(mm.m.label || mm.m.id)}</div><div class="sub">${MECH_ZH[mm.m.type] || mm.m.type} · ${mm.m.parts.length} 个零件</div></div>
      <button class="btn small" data-mech="${i}" aria-pressed="${isOpen}">${mm.m.type === 'removable' ? (isOpen ? '装回' : '取下') : isOpen ? '关上' : '打开'}</button></div>
      ${slider ? `<input type="range" class="mech-range" data-mr="${i}" min="${mm.lo}" max="${mm.hi}" step="1" value="${mm.target}" aria-label="${esc(mm.m.label || mm.m.id)} 角度">` : ''}</li>`;
  }).join('');
  $('#mechs').querySelectorAll('[data-mech]').forEach((b) => b.addEventListener('click', () => {
    const mm = S.mechs[+b.dataset.mech]; mm.target = Math.abs(mm.target - mm.lo) > 1e-6 ? mm.lo : mm.hi; buildUI(); kick();
    if (mm.m.type === 'removable') fitCurrent();
  }));
  $('#mechs').querySelectorAll('[data-mr]').forEach((r) => { paintRange(r); r.addEventListener('input', () => {
    const mm = S.mechs[+r.dataset.mr]; mm.target = +r.value; kick();
    const b = $(`[data-mech="${r.dataset.mr}"]`), open = Math.abs(mm.target - mm.lo) > 1e-6; b.textContent = open ? '关上' : '打开'; b.setAttribute('aria-pressed', open);
  }); });
  renderBom();
}
function renderModules() {
  const box = $('#mods'), show = S.emode === 'module' && S.hasModules;
  $('#mods-wrap').hidden = !show; if (!show) return;
  box.innerHTML = moduleTree().map(({ id, d, m, n }) => `<li><button class="mod" data-mod="${esc(id)}" aria-pressed="${S.hiModule === id}" style="--d:${d}">
    <span class="mod-name">${d ? '<span class="branch" aria-hidden="true"></span>' : ''}${esc(m.label || id)}${m.subassembly ? '<span class="tag info">子组件</span>' : ''}</span><span class="sub">${n} 件</span></button></li>`).join('');
  box.querySelectorAll('[data-mod]').forEach((b) => b.addEventListener('click', () => { S.hiModule = S.hiModule === b.dataset.mod ? null : b.dataset.mod; renderModules(); refreshLook(); }));
}
function renderBom() {
  const st = curStep(), tab = S.bomTab, ids = new Set(st.parts);
  const rows = bom(S.model, cat, (p) => cat.parts[p.part] && (tab === 'all' || ids.has(p.id)));
  const total = rows.reduce((a, r) => a + r.qty, 0);
  const attach = tab === 'step' && st.attach ? S.plan.subs.get(st.attach) : null;
  $('#bom-count').textContent = attach ? '1 个子组件' : `${total} 件 · ${rows.length} 种`;
  $('#bom').innerHTML = attach
    ? `<li class="bom-row"><span class="sw sub-sw" aria-hidden="true"></span><span class="bom-name"><span>子组件 · ${esc(attach.label)}</span><span class="sub">${attach.parts.length} 个零件，整体装到主体上</span></span><span class="qty">×1</span></li>`
    : rows.map((r) => `<li class="bom-row"><span class="sw" style="--c:${colorOf(r.color).hex}"></span><span class="bom-name"><span>${esc(r.def?.zh || r.part)}</span><span class="sub">${esc(r.part)} · ${esc(colorOf(r.color).zh)}</span></span><span class="qty">×${r.qty}</span></li>`).join('') || '<li class="empty">这一步没有零件</li>';
  document.querySelectorAll('[data-bomtab]').forEach((b) => b.setAttribute('aria-selected', b.dataset.bomtab === tab));
}
function select(id, jump = false) {
  S.sel = id; const o = S.byId.get(id), card = $('#infocard');
  if (!o) { card.hidden = true; S.sel = null; refreshLook(); return; }
  if (jump && !o.group.visible) goStep(o.rank, false);
  const p = o.p, st = S.steps[o.rank], status = p.status || 'confirmed', mod = o.module ? S.plan.mods.get(o.module) : null;
  card.innerHTML = `<div class="card-head"><div><div class="card-title">${esc(partLabel(p))}</div><div class="sub">${esc(p.part)} · ${esc(colorOf(p.color).zh)} · ${esc(p.id)}</div></div><button class="icon-btn" id="card-close" aria-label="关闭">${ICON.close}</button></div>
    <dl><dt>位置</dt><dd>[${p.at.join(', ')}] · 朝向 ${p.rot || 0}°${p.up && p.up !== '+y' ? ` · 凸点朝 ${esc(p.up)}${p.snot ? ` (+${p.snot}片)` : ''}` : ''}</dd><dt>步骤</dt><dd>第 ${o.rank + 1} 步${st?.title ? ` · ${esc(st.title)}` : ''}</dd>
    ${o.module ? `<dt>模块</dt><dd>${esc(mod?.label || o.module)}</dd>` : ''}
    <dt>状态</dt><dd><span class="tag ${status === 'confirmed' ? 'positive' : status === 'inferred' ? 'attention' : 'risk'}">${STATUS_ZH[status] || status}</span>${p.confidence != null ? ` <span class="sub">置信度 ${Math.round(p.confidence * 100)}%</span>` : ''}</dd>
    ${p.evidence?.length ? `<dt>照片</dt><dd class="ev">${p.evidence.map((e) => `<code>${esc(e)}</code>`).join('')}</dd>` : ''}
    ${p.note ? `<dt>备注</dt><dd>${esc(p.note)}</dd>` : ''}</dl>`;
  card.hidden = false; $('#card-close').addEventListener('click', () => select(null)); refreshLook();
}

// ------------------------------------------------------------------ 拼装图纸
let bookJob = 0;
async function buildBooklet() {
  const job = ++bookJob, pages = $('#pages'), status = $('#book-status'), bar = $('#book-progress');
  S.bookDirty = false; window.__bookReady = false;
  pages.innerHTML = ''; pages.setAttribute('aria-busy', 'true'); $('#btn-print').disabled = true; bar.hidden = false; bar.value = 0;
  status.textContent = '正在生成图纸…';
  try {
    if (!S.book) S.book = new Booklet();
    S.book.load(S.model, S.plan);
    let count = 0;
    await S.book.build({ fade: $('#book-fade').checked }, (html, i, total) => {
      if (job !== bookJob) return false;
      pages.insertAdjacentHTML('beforeend', html); count = i + 1;
      status.textContent = `正在生成图纸 ${count} / ${total}`; bar.max = total; bar.value = count;
    });
    if (job !== bookJob) return;
    status.textContent = `共 ${count} 页 · A4 横版`;
    $('#btn-print').disabled = false; window.__bookReady = true;
  } catch (err) {
    console.error(err); status.textContent = `生成失败：${err.message}`;
  } finally { if (job === bookJob) { pages.removeAttribute('aria-busy'); bar.hidden = true; } }
}
function setMode(mode) {
  S.mode = mode;
  $('#view3d').hidden = mode !== '3d'; $('#book').hidden = mode !== 'book';
  document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-selected', b.dataset.mode === mode));
  document.body.dataset.mode = mode;
  if (mode === 'book') { togglePlay(false); if (S.bookDirty) buildBooklet(); }
  else { resize(); S.dirty = true; }
}

// ------------------------------------------------------------------ 事件
const paintRange = (r) => r.style.setProperty('--pct', `${((+r.value - +r.min) / Math.max(1e-9, +r.max - +r.min)) * 100}%`);
document.addEventListener('input', (e) => { if (e.target.type === 'range') paintRange(e.target); });
function wire() {
  for (const k of ['first', 'prev', 'next', 'last']) $(`#${k}`).innerHTML = ICON[k];
  $('#play').innerHTML = ICON.play; $('#btn-reset').innerHTML = ICON.reset;
  $('#first').onclick = () => { togglePlay(false); goStep(0); };
  $('#prev').onclick = () => { togglePlay(false); goStep(S.stepIdx - 1); };
  $('#next').onclick = () => { togglePlay(false); goStep(S.stepIdx + 1); };
  $('#last').onclick = () => { togglePlay(false); goStep(lastIdx(), false); };
  $('#play').onclick = () => togglePlay();
  $('#step-range').oninput = (e) => { togglePlay(false); goStep(+e.target.value, false); };
  $('#btn-reset').onclick = () => { S.userMoved = false; setView(...VIEW, 1, true); };
  $('#explode').oninput = (e) => { S.explode.target = +e.target.value / 100; computeExplodeTargets(false); $('#explode-val').textContent = `${e.target.value}%`; fitCurrent(); };
  document.querySelectorAll('[data-emode]').forEach((b) => b.addEventListener('click', () => {
    if (b.disabled) return;
    S.emode = b.dataset.emode; document.querySelectorAll('[data-emode]').forEach((x) => x.setAttribute('aria-pressed', x === b));
    if (S.emode !== 'module') S.hiModule = null;
    if (S.explode.target === 0) { S.explode.target = 0.7; $('#explode').value = '70'; paintRange($('#explode')); $('#explode-val').textContent = '70%'; }
    computeExplodeTargets(false); renderModules(); refreshLook(); fitCurrent();
  }));
  document.querySelectorAll('[data-bomtab]').forEach((b) => b.addEventListener('click', () => { S.bomTab = b.dataset.bomtab; renderBom(); }));
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  for (const k of ['highlight', 'fade', 'status']) $(`#opt-${k}`).addEventListener('change', (e) => { S.opts[k] = e.target.checked; refreshLook(); if (k === 'status') $('#legend').hidden = !e.target.checked; });
  $('#book-fade').addEventListener('change', () => buildBooklet());
  $('#btn-print').onclick = () => window.print();
  $('#open-file').onclick = () => $('#file').click();
  $('#file').onchange = (e) => e.target.files[0] && readFile(e.target.files[0]);
  $('#dl-ldraw').onclick = () => download(`${S.model.meta?.name || 'model'}${ldrawExt(S.model)}`, toLDraw(S.model, cat), 'text/plain');
  $('#dl-json').onclick = () => download(`${S.model.meta?.name || 'model'}.brick.json`, JSON.stringify(S.model, null, 1), 'application/json');
  const stage = $('#stage');
  stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drag'); });
  stage.addEventListener('dragleave', () => stage.classList.remove('drag'));
  stage.addEventListener('drop', (e) => { e.preventDefault(); stage.classList.remove('drag'); e.dataTransfer.files[0] && readFile(e.dataTransfer.files[0]); });
  let down = null; const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  canvas.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return; down = null;
    const r = canvas.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(S.objs.filter((o) => o.group.visible).flatMap((o) => o.meshes), false)[0];
    select(hit ? hit.object.userData.id : null);
  });
  addEventListener('keydown', (e) => {
    if (S.mode !== '3d' || e.target.closest('input,button,textarea,select,summary')) return;
    if (e.key === 'ArrowRight') goStep(S.stepIdx + 1); else if (e.key === 'ArrowLeft') goStep(S.stepIdx - 1); else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  });
}
function readFile(f) {
  f.text().then((t) => { try { loadModel(JSON.parse(t)); toast(`已打开 ${f.name}`); } catch (err) { toast(`无法读取：${err.message}`, true); } });
}
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
function toast(msg, bad) { const t = $('#toast'); t.textContent = msg; t.className = bad ? 'show bad' : 'show'; clearTimeout(t._h); t._h = setTimeout(() => (t.className = ''), 2600); }
function applyInsets() {   // 步骤条盖住的区域不放模型：把投影中心移到可见区域中间
  const r = $('#stage').getBoundingClientRect(), h = Math.max(1, r.height);
  const top = SHOT ? 0 : 12, bottom = SHOT ? 0 : h - $('#stepbar').offsetTop + 8;
  camera.setViewOffset(r.width, h, 0, (bottom - top) / 2, r.width, h);
  S.ndc = { upper: 1 - (2 * top) / h, lower: -1 + (2 * bottom) / h };
}
function resize() {
  const r = $('#stage').getBoundingClientRect(); if (!r.width || !r.height) return;
  renderer.setSize(r.width, r.height, false); camera.aspect = r.width / r.height; applyInsets(); camera.updateProjectionMatrix();
  if (S.model && !S.userMoved && !SHOT) setView(...VIEW, 1); S.dirty = true;
}

// ------------------------------------------------------------------ 启动
wire();
new ResizeObserver(resize).observe($('#stage')); resize();
loadModel(window.__BRICK_MODEL__ || demoModel);
if (SHOT) {
  document.body.classList.add('shot');
  const W = +params.get('w') || 1200, H = +params.get('h') || 900;
  $('#stage').style.cssText = `width:${W}px;height:${H}px;flex:none`; resize();
  if (params.has('step')) { const i = S.steps.findIndex((s) => s.n === +params.get('step')); goStep(i >= 0 ? i : lastIdx(), false); }
  if (params.has('emode')) S.emode = params.get('emode') === 'module' ? 'module' : 'layer';
  S.explode.target = (+params.get('explode') || 0) / 100; computeExplodeTargets(true); S.explode.cur = S.explode.target;
  for (const kv of (params.get('mech') || '').split(',').filter(Boolean)) { const [id, v] = kv.split(':'); const mm = S.mechs.find((x) => x.m.id === id); if (mm) mm.cur = mm.target = +v; }
  if (params.get('status') === '1') { S.opts.status = true; refreshLook(); }
  if (params.has('sel')) select(params.get('sel'));
  frameUpdate(1);
  setView(+(params.get('az') ?? VIEW[0]), +(params.get('el') ?? VIEW[1]), +params.get('zoom') || 1, false);
} else if (params.get('view') === 'book') setMode('book');
let last = performance.now(), frames = 0;
renderer.setAnimationLoop((t) => {
  const dt = Math.min(0.05, (t - last) / 1000); last = t;
  if (S.mode !== '3d') return;
  frameUpdate(dt); controls.update();
  if (S.shadowFrames > 0) { shadow.render(); S.shadowFrames--; S.dirty = true; }
  if (S.dirty || SHOT) { renderer.render(scene, camera); S.dirty = false; }
  if (SHOT && ++frames === 4) window.__shotReady = true;
});
window.brickkit = { loadModel, goStep, setView, setMode, state: S };
