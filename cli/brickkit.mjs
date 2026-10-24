#!/usr/bin/env node
// brickkit 命令行 —— 给 Harness（智能体）调用的工具入口。所有命令输出 JSON（--pretty 美化）。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validate, toLDraw, ldrawExt, checkPhotos, bom, stepPlan, PHOTO_SLOTS, partBoxes, partConnectors, snapPart } from '../src/core/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const cat = { parts: readJSON(path.join(ROOT, 'catalog/parts.json')).parts, colors: readJSON(path.join(ROOT, 'catalog/colors.json')).colors };
const args = process.argv.slice(2), cmd = args.shift();
const flag = (name, def) => { let i = args.indexOf(`--${name}`); if (i < 0 && name.length === 1) i = args.indexOf(`-${name}`); if (i < 0) return def; const v = args[i + 1]; args.splice(i, v && !v.startsWith('--') ? 2 : 1); return v && !v.startsWith('--') ? v : true; };
const pretty = flag('pretty', false);
const out = (o) => process.stdout.write(JSON.stringify(o, null, pretty ? 2 : 0) + '\n');
const fail = (msg) => { out({ ok: false, error: msg }); process.exit(2); };

const HELP = `brickkit <命令> [参数]
  validate <model.brick.json> [--photos photos.json]    校验模型：零件/颜色/重叠/悬空/步骤顺序/模块/子组件/可开合/证据照片
  check-photos <photos.json> [--model model.brick.json] [--dir 照片目录]   检查照片是否齐全、分辨率是否达标
  photo-plan [--model model.brick.json]                  列出需要用户拍的照片（必拍机位 + 每个可开合设计）
  plan <model.brick.json>                                步骤计划：每一步的零件、子组件、装配步
  catalog [关键词]                                       查零件目录（编号、中文名、类别、尺寸）
  studs <model.brick.json> [partId]                      查看零件的 3D 包围盒、全部凸点/把柄坐标与朝向
  snap <model.brick.json> --parent <id> --stud <n> --part <编号> [--rot 0] [--receptor 0]
                                                         按凸点扣底孔规律自动计算子零件的无穿模精确坐标
  colors                                                 列出颜色代码
  bom <model.brick.json> [--step n]                      零件清单
  export-ldraw <model.brick.json> [-o out.ldr|out.mpd]   导出 LDraw（有子组件时为 MPD，可用 Studio / LeoCAD / LPub3D 打开）
  viewer <model.brick.json> [-o out.html]                生成内嵌该模型的单文件查看器
  render <model.brick.json> -o out.png [--az 35 --el 26 --step n --explode 0-100 --emode layer|module --mech door:90,roof:1 --w 1200 --h 900 --status]
                                                         渲染 3D 图，用来和用户照片对比
  booklet <model.brick.json> -o out.pdf                  生成拼装图纸 PDF（A4 横版，含子组件、可开合、零件清单）`;

async function main() {
  switch (cmd) {
    case 'validate': {
      const f = args[0] || fail('缺少模型文件'); const photos = flag('photos');
      const r = validate(readJSON(f), cat, { photos: photos ? readJSON(photos) : null });
      out(r); process.exit(r.ok ? 0 : 1);
    }
    case 'check-photos': {
      const f = args[0] || fail('缺少照片清单'); const set = readJSON(f), model = flag('model'), dir = flag('dir');
      if (dir) {
        let sharp = null; try { sharp = (await import('sharp')).default; } catch {}
        for (const p of set.photos || []) {
          const file = path.join(dir, p.file || ''); if (!p.file || !fs.existsSync(file)) { p._missingFile = true; continue; }
          if (sharp) { try { const m = await sharp(file).metadata(); p.width = m.width; p.height = m.height; } catch {} }
        }
      }
      const r = checkPhotos(set, model ? readJSON(model) : null);
      const missingFiles = (set.photos || []).filter((p) => p._missingFile).map((p) => p.id);
      if (missingFiles.length) r.warnings.push({ code: 'file', msg: `找不到照片文件：${missingFiles.join(', ')}` });
      out(r); process.exit(r.complete ? 0 : 1);
    }
    case 'photo-plan': {
      const model = flag('model'); const m = model ? readJSON(model) : null;
      const plan = PHOTO_SLOTS.map((s) => ({ slot: s.id, group: s.group, hint: s.hint }));
      for (const mech of m?.mechanisms || []) {
        plan.push({ slot: `mech-${mech.id}-open`, group: `可开合 · ${mech.label || mech.id}`, hint: '完全打开状态，至少 2 个不同角度' });
        plan.push({ slot: `mech-${mech.id}-interior`, group: `可开合 · ${mech.label || mech.id}`, hint: '打开后露出的内部' });
        if (mech.type === 'removable') plan.push({ slot: `mech-${mech.id}-module`, group: `可开合 · ${mech.label || mech.id}`, hint: '取下的部件单独拍顶面和底面' });
      }
      out({ ok: true, count: plan.length, plan, spec: 'docs/拍摄规范.md' }); break;
    }
    case 'plan': {
      const m = readJSON(args[0] || fail('缺少模型文件')), plan = stepPlan(m);
      out({ ok: true, steps: plan.steps.map((st, i) => ({ index: i + 1, n: st.n, title: st.title, parts: st.parts.length, sub: st.sub, attach: st.attach })),
        subassemblies: [...plan.subs.values()].map((x) => ({ id: x.id, label: x.label, attachStep: x.attachStep, parts: x.parts.length, steps: x.steps })) }); break;
    }
    case 'catalog': {
      const q = (args[0] || '').toLowerCase();
      const list = Object.entries(cat.parts).filter(([id, d]) => !q || id.includes(q) || d.name.toLowerCase().includes(q) || d.zh.includes(q) || d.kind === q || d.category === q)
        .map(([id, d]) => ({ part: id, zh: d.zh, name: d.name, kind: d.kind, category: d.category, size: d.size, h: d.h, ...(d.sideFaces ? { sideFaces: d.sideFaces } : {}) }));
      out({ ok: true, count: list.length, parts: list }); break;
    }
    case 'studs': {
      const m = readJSON(args[0] || fail('缺少模型文件')), target = args[1];
      const parts = (m.parts || []).filter((p) => !target || p.id === target);
      if (!parts.length) fail(target ? `找不到零件 ${target}` : '模型中没有零件');
      const items = parts.map((p) => {
        const def = cat.parts[p.part] || fail(`未知零件 ${p.part}`);
        const conn = partConnectors(p, def);
        return { id: p.id, part: p.part, zh: def.zh, at: p.at, rot: p.rot || 0, up: p.up || '+y', snot: p.snot || 0, boxes: partBoxes(p, def), studs: conn.studs, receptors: conn.receptors };
      });
      out({ ok: true, count: items.length, parts: items }); break;
    }
    case 'snap': {
      const m = readJSON(args[0] || fail('缺少模型文件'));
      const pid = flag('parent') || fail('缺少 --parent <父零件id>');
      const sIdx = Number(flag('stud', 0));
      const cPart = String(flag('part') || fail('缺少 --part <子零件编号>'));
      const rot = Number(flag('rot', 0));
      const rIdx = Number(flag('receptor', 0));
      const upFlag = flag('up');
      const parent = (m.parts || []).find((p) => p.id === pid) || fail(`找不到父零件 ${pid}`);
      const pDef = cat.parts[parent.part] || fail(`未知父零件 ${parent.part}`);
      const cDef = cat.parts[cPart] || fail(`未知子零件 ${cPart}`);
      const snapped = snapPart(parent, pDef, sIdx, { part: cPart, rot, ...(upFlag ? { up: upFlag } : {}) }, cDef, rIdx);
      out({ ok: true, parent: pid, studIndex: sIdx, receptorIndex: rIdx, placement: { ...snapped, mount: pid } }); break;
    }
    case 'colors': out({ ok: true, colors: cat.colors }); break;
    case 'bom': {
      const m = readJSON(args[0] || fail('缺少模型文件')); const step = flag('step');
      const rows = bom(m, cat, (p) => !step || p.step === +step).map((r) => ({ part: r.part, zh: r.def?.zh, color: r.color, colorZh: r.col?.zh, qty: r.qty }));
      out({ ok: true, total: rows.reduce((a, r) => a + r.qty, 0), rows }); break;
    }
    case 'export-ldraw': {
      const f = args[0] || fail('缺少模型文件'), m = readJSON(f); const o = flag('o') || f.replace(/(\.brick)?\.json$/, '') + ldrawExt(m);
      fs.writeFileSync(o, toLDraw(m, cat)); out({ ok: true, file: o, format: ldrawExt(m) === '.mpd' ? 'mpd' : 'ldr' }); break;
    }
    case 'viewer': {
      const f = args[0] || fail('缺少模型文件'); const o = flag('o') || f.replace(/(\.brick)?\.json$/, '') + '.viewer.html';
      fs.writeFileSync(o, embed(readJSON(f))); out({ ok: true, file: o }); break;
    }
    case 'render': {
      const f = args[0] || fail('缺少模型文件'); const o = flag('o') || fail('缺少 -o 输出图片');
      const q = new URLSearchParams({ shot: '1' });
      for (const k of ['az', 'el', 'step', 'explode', 'emode', 'mech', 'w', 'h', 'zoom', 'sel']) { const v = flag(k); if (v !== undefined && v !== true) q.set(k, v); }
      if (flag('status')) q.set('status', '1');
      await render(readJSON(f), q, o); out({ ok: true, file: o }); break;
    }
    case 'booklet': {
      const f = args[0] || fail('缺少模型文件'); const o = flag('o') || f.replace(/(\.brick)?\.json$/, '') + '.booklet.pdf';
      const pages = await booklet(readJSON(f), o); out({ ok: true, file: o, pages }); break;
    }
    default: console.log(HELP); process.exit(cmd ? 2 : 0);
  }
}
function embed(model) {
  const html = fs.readFileSync(path.join(ROOT, 'dist/viewer.html'), 'utf8');
  const data = JSON.stringify(model).replace(/</g, '\\u003c');
  return html.replace('<!--MODEL-->', () => `<script>window.__BRICK_MODEL__=${data}</script>`);
}
async function launch(model) {
  const { chromium } = await import('playwright');
  const tmp = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'brickkit-')), 'v.html'); fs.writeFileSync(tmp, embed(model));
  const exe = process.env.CHROMIUM_PATH || ['/usr/local/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
  const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  return { browser, url: 'file://' + tmp };
}
async function booklet(model, outFile) {
  const { browser, url } = await launch(model);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(url + '#view=book');
  await page.waitForFunction(() => window.__bookReady === true, null, { timeout: 300000 });
  const n = await page.locator('#pages .page').count();
  await page.emulateMedia({ media: 'print' });
  await page.pdf({ path: outFile, printBackground: true, preferCSSPageSize: true });
  await browser.close();
  if (errs.length) throw new Error(errs.join('\n'));
  return n;
}
async function render(model, q, outFile) {
  const { browser, url } = await launch(model);
  const w = +(q.get('w') || 1200), h = +(q.get('h') || 900);
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(url + '#' + q.toString());
  await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 30000 }).catch(() => {});
  await page.locator('#c').screenshot({ path: outFile });
  await browser.close();
  if (errs.length) throw new Error(errs.join('\n'));
}
main().catch((e) => fail(e.message));
