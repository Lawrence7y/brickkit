#!/usr/bin/env node
// brickkit 命令行 —— 给 Harness（智能体）调用的工具入口。所有命令输出 JSON（--pretty 美化）。
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { validate, toLDraw, ldrawExt, checkPhotos, bom, stepPlan, PHOTO_SLOTS, partBoxes, partConnectors, snapPart, findMounts, recompute } from '../src/core/core.js';
import { runDiff, calibratePhoto } from '../src/core/diff.js';
import { checkObservations } from '../src/core/observations.js';
import { extractPlan, checkPlan } from '../tools/extract-plan.mjs';
import { fetchLDrawLibrary, installFullLDrawLibrary, bboxFromText, verifyPart, refCandidates, safeJoin, OFFICIAL_ALIASES } from '../src/ldraw/ldraw.js';
import { buildModelGeometries } from '../src/ldraw/loader.mjs';
// PRD v2 责任域 A：资产 / 关系装配 / 候选与动作
import {
  loadDefinition, expandConnectorGroups, connectorCountOf, connectorTypesOf,
} from '../src/core/assets-v1/index.js';
import { writeAssetStore, verifyStore, readIndex } from '../src/core/assets-v1/store.js';
import {
  validateAssembly, compileToLegacy, expandNodes, topoSortPlacements, checkContainment,
} from '../src/core/assembly-v1/compile.js';
import { inspectFromModel } from '../src/core/actions-v1/state.js';
import { enumerateCandidates } from '../src/core/actions-v1/candidates.js';
import { applyActions } from '../src/core/actions-v1/apply.js';
import { enumerateCandidatesForB } from '../src/core/actions-v1/compat-b.js';
import { renderState, toConnectorMap } from '../src/core/actions-v1/render-state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const extFile = path.join(ROOT, 'catalog/parts-ldraw.json');
const ext = fs.existsSync(extFile) ? readJSON(extFile).parts : {};
const curated = readJSON(path.join(ROOT, 'catalog/parts.json')).parts;
const cat = { parts: { ...ext, ...curated }, colors: readJSON(path.join(ROOT, 'catalog/colors.json')).colors, curated, ext };
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
  extract-plan --from-model <model.brick.json> [--from-pages <manifest.json>] [--bom <bom.json>] [--assign <assign.json>]
               [--poses <poses.json>] [-o out/x.plan.json]
                                                         说明书蓝图提取：从 parts[].step 反推每步新增零件，结合说明书页分类补齐 page 与页视角初值，
                                                         产出 <model>.plan.json（brickbuild-plan 0.1）。无可靠来源的页码/视角一律标 pageConfidence=assumed + note
  check-plan <plan.json> [--bom <bom.json>] [--model <model.brick.json>]
                                                         零件守恒守门员：∑steps.parts == ∑submodels.bom，可选与官方 BOM、模型实际 BOM 逐 (件号,颜色) 对账；
                                                         退出码 0=ok / 1=有 error（错误码见 docs/数据格式.md）
  catalog [关键词] [--all]                              查零件目录（默认 165 种精选；--all 含 LDraw 自动提取的扩充目录）
  catalog-fetch [--dir catalog/ldraw] [--mirror 整库解压目录] [--force] [--full]
                                                         从 LDraw 官方零件库下载素材（CC BY 2.0）。默认只装目录引用的 165 种零件及其闭包；
                                                         --full 从 --mirror（complete.zip 解压目录）整库安装约 2.5 万种零件到 catalog/ldraw-full（建议 .gitignore）
  catalog-verify [--dir catalog/ldraw]                   用官方几何实测尺寸核对 catalog/parts.json（目录 vs 官方 .dat），产出 verification.json
  catalog-audit --out catalog/audit-full.json [--sample 100] [--seed N] [--budget-min 30] [--no-render]
                                                         合并目录全件四条机查（①官方 .dat 几何核对 ②连接器完整性+虚假受体扫描
                                                         ③schema（bracket vH/dir、无 NaN/undefined） ④builder 单件放置+validate 0 errors）
                                                         + 渲染冒烟（随机抽样 --sample 件 400×400 非全白）。stdout 首行 = 汇总 JSON（各类
                                                         通过/失败计数与渲染抽样量），明细写 --out；审计完成即退出 0（逐件失败是报告数据，
                                                         见汇总 ok 字段），仅命令自身出错退出 2
  studs <model.brick.json> [partId]                      查看零件的 3D 包围盒、全部凸点/把柄坐标与朝向
  snap <model.brick.json> --parent <id> --stud <n> --part <编号> [--rot 0] [--receptor 0]
                                                         按凸点扣底孔规律自动计算子零件的无穿模精确坐标
  colors                                                 列出颜色代码
  bom <model.brick.json> [--step n]                      零件清单
  export-ldraw <model.brick.json> [-o out.ldr|out.mpd]   导出 LDraw（有子组件时为 MPD，可用 Studio / LeoCAD / LPub3D 打开）
  viewer <model.brick.json> [-o out.html] [--geom ldraw|param]
                                                         生成内嵌该模型的单文件查看器；--geom 默认 ldraw（烘焙官方 .dat 真实几何，
                                                         文件显著变大——60239 约 2.3MB；--geom param 不带几何，文件小但用品类近似外形）
  render <model.brick.json> -o out.png [--az 35 --el 26 --step n --explode 0-100 --emode layer|module --mech door:90,roof:1 --w 1200 --h 900 --status] [--geom ldraw|param]
                                                         渲染 3D 图，用来和用户照片对比。--geom 默认 ldraw（用 catalog/ldraw-full
                                                         官方 .dat 真实几何，stderr/stdout 报 noDat 与回退件；缺 .dat 的件显式回退参数化并计数）；
                                                         --geom param 退回参数化近似几何（旧行为，仅供对照实验）
  diff <model.brick.json> --photos photos.json --dir 照片目录 [--out-dir out/diff] [--w 640] [--mode joint|sweep|fixed]
                                                         数值对账（默认 joint 联合标定：每张照片 320px 粗扫 标注az±30°步15 × 4 向滚转取最优，再取全组分数加权圆周中位数得全局 yaw 偏移 Δ，正式打分统一 az=标注az+Δ、冻结各照片滚转——单张择优虚高被压制；sweep=旧逐照片 ±20° 方位角+滚转择优；fixed=仅清单姿态+4 向滚转，批量变体筛选用）。总分 = 0.35 归一IoU + 0.15 长宽比 + 0.20 颜色直方图 + 0.20 色块结构（16×16 网格众数粗色类一致率，可见内部结构差异）+ 0.10 未归一IoU（比例惩罚）；sweep 沿用旧 0.5/0.2/0.3 公式。机关 open 状态照片跳过。写 outDir/<id>.png 三联图与 report.json（structureSim/roll/poseAz/bestAz/scale 逐张诊断）。overall.score ≥ 0.6 退出 0，低于退出 1（供智能体迭代），照片文件缺失的条目跳过并列出
  calibrate <model.brick.json> --photos photos.json --photo <照片id> --dir 照片目录
                                                         机位标定：单张照片 az 0..345 步进 15 × el -10..45 低分辨率（320px）扫描，输出 best 与 top5，并附与清单标注方位角的偏差
  check-observations <obs.json> --model <model.brick.json>
                                                         观察清单→BOM 数值对账：inventory 数量区间（obs-count）、整类缺失（obs-missing）、模型多出 (零件×颜色)（model-extra）、evidence 引用（obs-evidence）与 format 校验；退出码 0=ok / 1=有 error
  booklet <model.brick.json> -o out.pdf                  生成拼装图纸 PDF（A4 横版，含子组件、可开合、零件清单）`;

async function main() {
  switch (cmd) {
    case 'validate': {
      const f = args[0] || fail('缺少模型文件'); const photos = flag('photos');
      const strictAssembly = Boolean(flag('strict-assembly'));
      const submodel = Boolean(flag('submodel'));
      const r = validate(readJSON(f), cat, {
        photos: photos ? readJSON(photos) : null,
        strictAssembly,
        submodel,
      });
      out(r); process.exit(r.ok ? 0 : 1);
    }
    case 'find-mount': {
      const mainFile = args[0] || fail('缺少主模型文件 <main.brick.json>');
      const subFile = args[1] || fail('缺少子模型文件 <sub.brick.json>');
      const parentId = flag('parent');
      const anchorId = flag('anchor');
      const dir = flag('dir');
      const maxResults = Number(flag('max', 50));
      const mainModel = readJSON(mainFile);
      const subModel = readJSON(subFile);
      const candidates = findMounts(mainModel, subModel, cat, {
        ...(parentId ? { parentId } : {}),
        ...(anchorId ? { anchorId } : {}),
        ...(dir ? { dir } : {}),
        maxResults,
      });
      out({ ok: true, count: candidates.length, candidates: candidates.map(({ placed, ...rest }) => rest) });
      break;
    }
    case 'catalog-preflight': {
      const bomFile = args[0] || fail('缺少 BOM 文件 <bom.json>');
      const bomData = readJSON(bomFile);
      const entries = bomData.parts || [];
      const report = [];
      const issues = [];
      for (const item of entries) {
        const id = String(item.substituteFor || item.ldraw || item.part || item.design || '');
        if (!id) continue;
        const def = cat.parts[id];
        if (!def) {
          issues.push({ part: id, issue: 'missing-in-catalog', name: item.name });
          report.push({ part: id, ok: false, issue: 'missing-in-catalog' });
          continue;
        }
        const probe = { id: '_preflight', part: id, at: [0, 0, 0], rot: 0, up: '+y', step: 1 };
        const conn = partConnectors(probe, def);
        const warnings = [];
        if (def.needsManualBoxes) warnings.push(`needsManualBoxes: ${def.needsManualBoxesReason || '需手工多盒分解'}`);
        if (def.needsManual) warnings.push('needsManual: 外挑/异形需复核');
        if (conn.studs.length === 0 && conn.receptors.length === 0) warnings.push('no-connectors: 0 凸点且 0 受体');
        if ( warnings.length ) issues.push({ part: id, warnings, name: def.name });
        report.push({
          part: id,
          ok: warnings.length === 0,
          name: def.name,
          size: def.size,
          h: def.h,
          boxes: Array.isArray(def.boxes) ? def.boxes.length : 1,
          studs: conn.studs.length,
          receptors: conn.receptors.length,
          ...(warnings.length ? { warnings } : {}),
        });
      }
      out({ ok: issues.every((x) => !x.issue), total: report.length, issuesCount: issues.length, issues, parts: report });
      break;
    }
    case 'check-photos': {
      const f = args[0] || fail('缺少照片清单'); const set = readJSON(f), model = flag('model'), dir = flag('dir');
      if (dir) {
        let sharp = null; try { sharp = (await import('sharp')).default; } catch {}
        for (const p of set.photos || []) {
          const file = !p.file ? '' : path.isAbsolute(p.file) ? p.file : path.join(dir, p.file);
          if (!p.file || !fs.existsSync(file)) { p._missingFile = true; continue; }
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
    case 'extract-plan': {
      const modelFile = flag('from-model') || args.find((a) => !a.startsWith('-'));
      if (!modelFile) fail('缺少模型文件：extract-plan --from-model <model.brick.json>');
      const pagesFile = flag('from-pages');
      const bomFile = flag('bom');
      const assignFile = flag('assign');
      const posesFile = flag('poses');
      const pageMapFile = flag('page-map');
      const plan = extractPlan({
        model: readJSON(modelFile), modelFile,
        manifest: pagesFile ? readJSON(pagesFile) : null, manifestFile: pagesFile || null,
        bom: bomFile ? readJSON(bomFile) : null, bomFile: bomFile || null,
        assign: assignFile ? readJSON(assignFile) : null,
        poses: posesFile ? readJSON(posesFile) : null,
        pageMap: pageMapFile ? readJSON(pageMapFile) : null,
      });
      const o = flag('o') || String(modelFile).replace(/(\.brick)?\.json$/i, '') + '.plan.json';
      fs.mkdirSync(path.dirname(path.resolve(o)), { recursive: true });
      fs.writeFileSync(o, JSON.stringify(plan, null, 2) + '\n');
      const stepsTotal = plan.steps.reduce((a, s) => a + s.parts.reduce((b, p) => b + p.qty, 0), 0);
      const subsTotal = plan.submodels.reduce((a, s) => a + s.bom.reduce((b, p) => b + p.qty, 0), 0);
      out({ ok: true, file: o, stats: {
        steps: plan.steps.length, stepsTotalParts: stepsTotal,
        submodels: plan.submodels.length, submodelsTotalParts: subsTotal,
        pages: plan.manual?.pages ?? null, pageMethod: plan.pageMapping.method,
        measuredPages: plan.steps.filter((s) => s.pageConfidence === 'measured').length,
        assumedPages: plan.steps.filter((s) => s.pageConfidence !== 'measured').length,
        measuredPoses: plan.steps.filter((s) => s.poseConfidence === 'measured').length,
      }, submodels: plan.submodels.map((s) => ({ id: s.id, steps: s.steps, attachStep: s.attachStep, parts: s.bom.reduce((a, p) => a + p.qty, 0), kinds: s.bom.length })),
        assumptions: plan.assumptions, notes: plan.notes }); break;
    }
    case 'check-plan': {
      const f = args[0] || fail('缺少计划文件：check-plan <plan.json>');
      const bomFile = flag('bom'); const modelFile = flag('model');
      const r = checkPlan(readJSON(f), {
        ...(bomFile ? { bom: readJSON(bomFile), bomFile } : {}),
        ...(modelFile ? { model: readJSON(modelFile) } : {}),
        planFile: f,
      });
      out(r); process.exit(r.ok ? 0 : 1);
    }
    case 'catalog': {
      const all = flag('all');
      const q = (args.find((a) => !a.startsWith('--')) || '').toLowerCase();
      const source = all ? cat.parts : cat.curated;
      const list = Object.entries(source).filter(([id, d]) => !q || id.includes(q) || d.name.toLowerCase().includes(q) || d.zh.includes(q) || d.kind === q || d.category === q)
        .map(([id, d]) => ({ part: id, zh: d.zh, name: d.name, kind: d.kind, category: d.category, size: d.size, h: d.h, ...(d.sideFaces ? { sideFaces: d.sideFaces } : {}), ...(d.auto ? { auto: true } : {}) }));
      out({ ok: true, count: list.length, parts: list, source: all ? 'curated+ldraw-auto' : 'curated' }); break;
    }
    case 'catalog-fetch': {
      const full = !!flag('full'); const force = !!flag('force');
      const dir = path.resolve(ROOT, flag('dir', full ? 'catalog/ldraw-full' : 'catalog/ldraw'));
      const mirror = flag('mirror');
      const r = full
        ? await installFullLDrawLibrary({ outDir: dir, mirror, log: (m) => process.stderr.write(m + '\n') })
        : await fetchLDrawLibrary({ outDir: dir, ids: Object.keys(cat.parts), force, mirror, log: (m) => process.stderr.write(m + '\n') });
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(r, null, 2));
      if (full) {
        out({ ok: true, mode: 'full', license: r.license, base: r.source, mirror: r.mirror,
          parts: r.counts.parts, primitives: r.counts.primitives, files: Object.keys(r.files).length,
          manifest: path.join(dir, 'manifest.json') });
      } else {
        out({ ok: r.errors.length === 0, license: r.license, base: r.source, fetchedAt: r.fetchedAt,
          parts: Object.keys(r.parts).length, files: Object.keys(r.files).length,
          missing: Object.keys(r.missing), errors: r.errors, manifest: path.join(dir, 'manifest.json') });
        process.exit(r.errors.length ? 1 : 0);
      }
      break;
    }
    case 'catalog-verify': {
      const dir = path.resolve(ROOT, flag('dir', 'catalog/ldraw'));
      // catalog/ldraw 优先；catalog/ldraw-full（--full 整库镜像）作为二级解析源
      const fullDir = path.resolve(ROOT, 'catalog/ldraw-full');
      const roots = [dir, ...(fs.existsSync(fullDir) ? [fullDir] : [])];
      const readLib = (raw) => {
        for (const lp of refCandidates(raw)) {
          for (const root of roots) { const f = safeJoin(root, lp); if (f && fs.existsSync(f)) return fs.readFileSync(f, 'utf8'); }
        }
        return null;
      };
      const manifest = fs.existsSync(path.join(dir, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) : null;
      // 这些类别的零件官方几何天然超出网格占位（夹口/把柄/垂片/销孔/门叶），高度差不构成目录定义错误
      const featureKind = (def) => ['hinge', 'technic', 'bracket'].includes(def.category) || def.kind === 'door';
      // 自动提取件（parts-ldraw.json）的 h 由官方包围盒反推，本身不是手写定义，所以只对精选目录
      // 强制硬冲突；自动件报出来供参考（--strict-auto 可把它们一并当硬错误）。
      const curated = cat.curated || {};
      const strictAuto = flag('strict-auto', false) === true;
      const rows = [], missing = [];
      for (const [id, def] of Object.entries(cat.parts)) {
        const official = OFFICIAL_ALIASES[id] || id;
        const text = readLib(`${official}.dat`); const box = text && bboxFromText(text, readLib);
        if (!box) { missing.push(id); continue; }
        // 官方侧凸点：parts-ldraw.json 已从 .dat 实测过，优先复用其 sideStuds，避免重复解析
        const officialSideStuds = cat.ext?.[id]?.sideStuds || [];
        const v = verifyPart(def, box, { officialSideStuds });
        const handWritten = Object.hasOwn(curated, id);
        const enforced = handWritten || strictAuto;
        const featureExplained = !v.ok && featureKind(def) && !v.flags.some((f) => f.startsWith('side-'));
        const ok = enforced ? (v.ok || featureExplained) : true;
        rows.push({
          id, ...(official !== id ? { officialId: official, alias: true } : {}), zh: def.zh,
          officialDesc: manifest?.parts?.[id]?.desc || undefined, status: v.status, flags: v.flags,
          handWritten: handWritten || undefined,
          featureExplained: featureExplained || undefined,
          expected: v.expected, measured: v.measured, ok,
          ...(v.sideStuds ? { sideStuds: v.sideStuds } : {}),
        });
      }
      const byStatus = {};
      for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      const hardRows = rows.filter((r) => !r.ok);
      const summary = { total: Object.keys(cat.parts).length, verified: rows.length, missing: missing.length, byStatus,
        featureExplained: rows.filter((r) => r.featureExplained).map((r) => r.id),
        hardErrors: hardRows.map((r) => r.id),
        hardErrorsHandWritten: hardRows.filter((r) => r.handWritten).map((r) => r.id) };
      fs.writeFileSync(path.join(dir, 'verification.json'), JSON.stringify({
        generatedAt: new Date().toISOString(),
        governedBy: { curatedParts: Object.keys(curated).length, strictAuto },
        note: 'status 说明见 src/ldraw/ldraw.js verifyPart：height-error / side-face-mismatch / side-count-mismatch / side-faces-missing 是目录手写定义与官方几何的硬冲突（精选目录一律 ok=false）；stud-offset = 官方几何含顶部凸点 +4 LDU；protrudes/smaller = 实体超出/小于网格占位（信息性）。自动提取件的 h 由包围盒反推，默认不计硬错误。',
        summary, missing, results: rows,
      }, null, 2));
      out({ ok: !summary.hardErrors.length && !missing.length, ...summary, hardErrorDetails: hardRows, missingParts: missing, report: path.join(dir, 'verification.json') });
      process.exit(summary.hardErrors.length || missing.length ? 1 : 0);
    }
    case 'catalog-audit': {
      const outFile = path.resolve(ROOT, flag('out', 'catalog/audit-full.json'));
      const sample = Number(flag('sample', 100));
      const seed = Number(flag('seed', 20261025));
      const budgetMin = Number(flag('budget-min', 30));
      const noRender = !!flag('no-render');
      const dir = path.resolve(ROOT, flag('dir', 'catalog/ldraw'));
      const fullDir = path.resolve(ROOT, 'catalog/ldraw-full');
      const roots = [dir, ...(fs.existsSync(fullDir) ? [fullDir] : [])];
      const cache = new Map();
      const readLib = (raw) => {
        const key = String(raw).toLowerCase();
        if (cache.has(key)) return cache.get(key);
        let t = null;
        for (const lp of refCandidates(key)) { for (const root of roots) { const f = safeJoin(root, lp); if (f && fs.existsSync(f)) { t = fs.readFileSync(f, 'utf8'); break; } } if (t) break; }
        cache.set(key, t);
        return t;
      };
      // 渲染冒烟：单个浏览器实例复用批量渲染（复用 render 命令的 shot 协议，纯字节数阈值判全白）
      let renderFn = null;
      if (!noRender) {
        renderFn = async (model) => {
          if (!auditRenderContext) await initAuditRender();
          const { page } = auditRenderContext;
          const errs = []; const onErr = (e) => errs.push(e.message);
          page.on('pageerror', onErr);
          try {
            fs.writeFileSync(auditTmpHtml, embed(model));
            await page.goto('file://' + auditTmpHtml + '#shot=1&w=400&h=400');
            await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 30000 }).catch(() => {});
            const buf = await page.locator('#c').screenshot();
            if (errs.length) throw new Error(errs.join(' | '));
            return { bytes: buf.length };
          } finally { page.off('pageerror', onErr); }
        };
      }
      let auditRenderContext = null, auditTmpHtml = null;
      async function initAuditRender() {
        const browser = await launchBrowser();
        const page = await browser.newPage({ viewport: { width: 400, height: 400 }, deviceScaleFactor: 1 });
        auditTmpHtml = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brickkit-audit-')), 'a.html');
        auditRenderContext = { browser, page, close: () => browser.close() };
        return auditRenderContext;
      }
      const { auditCatalog } = await import('../src/core/catalog-audit.mjs');
      try {
        const report = await auditCatalog({
          cat, readLib, renderFn, sample, seed, budgetMs: budgetMin * 60 * 1000,
          log: (m) => process.stderr.write(m + '\n'),
        });
        const { summary, results } = report;
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, JSON.stringify({
          generatedAt: new Date().toISOString(),
          command: `brickkit catalog-audit --out ${path.relative(ROOT, outFile)}`,
          note: '四条机查 + 渲染冒烟的口径见 src/core/catalog-audit.mjs 文件头。checks.geometry=null 表示官方库缺 .dat（计入 checks.geometry.missing，不算失败）；checks.render 仅抽样件有值。',
          summary, results,
        }, null, 1));
        process.stdout.write(JSON.stringify(summary) + '\n');   // 顶部一行汇总 JSON，供下游解析
        out({ ok: summary.ok, ...summary, file: outFile, reportFile: outFile });
        if (auditRenderContext) await auditRenderContext.close();
        // 审计成功完成即退出 0：逐件 pass/fail 是报告数据（汇总 ok 字段可见），不是命令失败；
        // 命令自身出错走 fail()（退出 2）。检查口径不变，不因失败件降级退出码语义。
        process.exit(0);
      } catch (e) {
        if (auditRenderContext) await auditRenderContext.close().catch(() => {});
        fail(e.message);
      }
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
      const sRaw = flag('stud', 0), rRaw = flag('rot', 0), recRaw = flag('receptor', 0);
      for (const [k, v] of [['stud', sRaw], ['rot', rRaw], ['receptor', recRaw]]) if (v === true) fail(`--${k} 需要一个数值参数（当前只写了旗标名）`);
      const sIdx = Number(sRaw), rot = Number(rRaw), rIdx = Number(recRaw);
      const cPart = String(flag('part') || fail('缺少 --part <子零件编号>'));
      const upFlag = flag('up');
      const under = Boolean(flag('under'));
      const parent = (m.parts || []).find((p) => p.id === pid) || fail(`找不到父零件 ${pid}`);
      const pDef = cat.parts[parent.part] || fail(`未知父零件 ${parent.part}`);
      const cDef = cat.parts[cPart] || fail(`未知子零件 ${cPart}`);
      const snapped = snapPart(parent, pDef, sIdx, { part: cPart, rot, ...(upFlag ? { up: upFlag } : {}) }, cDef, rIdx, { under });
      out({ ok: true, parent: pid, studIndex: sIdx, receptorIndex: rIdx, ...(under ? { under: true } : {}), placement: { ...snapped, mount: pid } }); break;
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
      const model = readJSON(f);
      const geom = String(flag('geom', 'ldraw'));
      if (geom !== 'param' && geom !== 'ldraw') fail(`--geom 只能是 ldraw / param，收到 ${geom}`);
      const baked = geom === 'ldraw' ? bakeFor(model) : null;
      fs.writeFileSync(o, embed(model, baked, geom));
      out({ ok: true, file: o, geom, ...(baked ? { ldraw: baked.parts, noDat: baked.noDat.length, triangles: baked.triangles } : {}) }); break;
    }
    case 'render': {
      const f = args[0] || fail('缺少模型文件'); const o = flag('o') || fail('缺少 -o 输出图片');
      const q = new URLSearchParams({ shot: '1' });
      for (const k of ['az', 'el', 'step', 'explode', 'emode', 'mech', 'w', 'h', 'zoom', 'sel']) { const v = flag(k); if (v !== undefined && v !== true) q.set(k, v); }
      if (flag('status')) q.set('status', '1');
      const showStuds = Boolean(flag('show-studs'));
      const filterPartsRaw = flag('filter-parts');
      const filterParts = typeof filterPartsRaw === 'string' ? new Set(filterPartsRaw.split(',').map((s) => s.trim()).filter(Boolean)) : null;
      const geom = String(flag('geom', 'ldraw'));
      if (geom !== 'param' && geom !== 'ldraw') fail(`--geom 只能是 ldraw / param，收到 ${geom}`);
      const model = readJSON(f);
      let baked = null;
      if (geom === 'ldraw') {
        baked = bakeFor(model);
        if (!baked) fail('LDraw 镜像中找不到任何零件 .dat（检查 catalog/ldraw-full 或 catalog/ldraw 是否存在）');
        q.set('geom', 'ldraw');
      }
      const openStuds = showStuds ? computeOpenStuds(model, q.has('step') ? +q.get('step') : null, filterParts) : null;
      const stat = await render(model, q, o, baked, openStuds);
      out({ ok: true, file: o, geom, ...(showStuds ? { openStuds: openStuds.length } : {}), ...(stat ? { ldraw: stat.ldraw, fallback: stat.fallback, fallbackKeys: stat.fallbackKeys, notes: stat.notes, noDat: stat.noDat, triangles: stat.triangles } : {}) }); break;
    }
    case 'diff': {
      const f = args[0] || fail('缺少模型文件');
      const photos = flag('photos') || fail('缺少 --photos <photos.json>');
      const dir = flag('dir') || fail('缺少 --dir <照片目录>');
      const outDir = flag('out-dir', 'out/diff');
      const mode = flag('mode', 'joint');
      if (!['joint', 'sweep', 'fixed'].includes(mode)) fail(`--mode 只能是 joint / sweep / fixed，收到 ${mode}`);
      const wRaw = flag('w', 640), w = Number(wRaw);
      if (!Number.isFinite(w) || w < 64 || w > 4096) fail(`--w 必须是 64~4096 的数字，收到 ${wRaw}`);
      const geom = String(flag('geom', 'ldraw'));
      if (geom !== 'ldraw' && geom !== 'param') fail(`--geom 只能是 ldraw / param，收到 ${geom}`);
      const report = await runDiff(readJSON(f), cat, readJSON(photos), dir, { outDir, width: w, height: w, mode, geom });
      const skipped = [...(report.skipped || []), ...report.photos.filter((r) => r.error).map((r) => ({ id: r.id, file: r.file, reason: r.error }))];
      const pass = report.overall.score >= 0.6;   // 0.6 为迭代门槛：不达标退出 1，供智能体改模型后重跑
      out({ ok: pass, threshold: 0.6, mode, geom, ...(mode === 'joint' ? { yawDelta: report.yawDelta } : {}), outDir, reportFile: path.join(outDir, 'report.json'), overall: report.overall, skipped, photos: report.photos });
      process.exit(pass ? 0 : 1);
    }
    case 'calibrate': {
      const f = args[0] || fail('缺少模型文件');
      const photos = flag('photos') || fail('缺少 --photos <photos.json>');
      const pid = flag('photo') || fail('缺少 --photo <照片id>');
      const dir = flag('dir') || fail('缺少 --dir <照片目录>');
      const p = (readJSON(photos).photos || []).find((x) => x.id === pid) || fail(`照片清单里没有 id 为 ${pid} 的照片`);
      const file = p.file && !path.isAbsolute(p.file) ? path.join(dir, p.file) : p.file;
      if (!p.file || !fs.existsSync(file)) fail(`找不到照片文件 ${p.file || '(空)'}`);
      const r = await calibratePhoto(readJSON(f), cat, file);
      const d = r.best ? Math.abs((r.best.az - (p.azimuth ?? 0)) % 360) : null;
      out({ ok: true, photo: pid, file: p.file, declared: { azimuth: p.azimuth, elevation: p.elevation },
        azDelta: d === null ? null : Math.min(d, 360 - d), best: r.best, top5: r.top });
      break;
    }
    case 'check-observations': {
      const f = args[0] || fail('缺少观察清单'); const m = flag('model') || fail('缺少 --model <model.brick.json>');
      const r = checkObservations(readJSON(f), readJSON(m), cat);
      out(r); process.exit(r.ok ? 0 : 1);
    }
    case 'booklet': {
      const f = args[0] || fail('缺少模型文件'); const o = flag('o') || f.replace(/(\.brick)?\.json$/, '') + '.booklet.pdf';
      const geom = String(flag('geom', 'ldraw'));
      if (geom !== 'ldraw' && geom !== 'param') fail(`--geom 只能是 ldraw / param，收到 ${geom}`);
      const model = readJSON(f);
      const baked = geom === 'ldraw' ? bakeFor(model) : null;
      const pages = await booklet(model, o, baked); out({ ok: true, file: o, pages, geom }); break;
    }

    // ---------------- PRD v2：Part Asset v1（ST）----------------
    case 'assets': {
      const sub = args.shift();
      if (sub === 'compile') {
        // assets compile [--out catalog/assets-v1] [--force]
        const outDir = path.resolve(ROOT, String(flag('out', 'catalog/assets-v1')));
        const force = Boolean(flag('force'));
        const t0 = Date.now();
        try {
          const res = writeAssetStore(ROOT, outDir, { force, buildOpts: { recordedAt: new Date().toISOString() } });
          const verify = verifyStore(outDir);
          out({
            ok: verify.ok, commandOk: true, passed: verify.ok,
            out: path.relative(ROOT, outDir),
            parts: res.partCount,
            indexBytes: res.indexBytes,
            totalDefinitionBytes: res.totalDefinitionBytes,
            largestDefinitions: res.largestDefinitions,
            stats: res.stats,
            buildWarnings: res.buildWarnings,
            verify: { checked: verify.checked, problemCount: verify.problemCount, problems: verify.problems },
            elapsedMs: res.elapsedMs,
          });
          process.exit(verify.ok ? 0 : 1);
        } catch (e) {
          out({ ok: false, commandOk: false, passed: false, error: e.message, code: e.code });
          process.exit(2);
        }
      }
      if (sub === 'inspect') {
        // assets inspect <partId> [--dir catalog/assets-v1] [--expand]
        const partId = args[0] || fail('缺少零件编号，例如：assets inspect 3001');
        const dir = path.resolve(ROOT, String(flag('dir', 'catalog/assets-v1')));
        try {
          const def = loadDefinition(dir, String(partId), { overridesDir: path.join(dir, 'overrides') });
          const expand = Boolean(flag('expand'));
          out({
            ok: true, commandOk: true, passed: true,
            partId: def.partId, revision: def.revision, contentHash: def.contentHash,
            capabilities: def.capabilities,
            canonicalFrame: def.canonicalFrame,
            geometry: def.geometry,
            collision: { state: def.collision.state, shape: def.collision.shape, boxCount: def.collision.boxes?.length ?? 0, boxes: def.collision.boxes },
            connectorCount: connectorCountOf(def),
            connectorTypes: connectorTypesOf(def),
            ...(expand ? { connectors: expandConnectorGroups(def) } : { groups: def.connectorGroups }),
          });
        } catch (e) {
          out({ ok: false, commandOk: false, passed: false, error: e.message, code: e.code, partId });
          process.exit(e.code === 'missing-asset' ? 1 : 2);
        }
        break;
      }
      if (sub === 'preflight') {
        // assets preflight <bom.json> [--dir catalog/assets-v1] [--for render,collide,assemble]
        const bomFile = args[0] || fail('缺少 BOM 文件 <bom.json>');
        const bomData = readJSON(bomFile);
        const useFor = String(flag('for', 'render,collide,assemble')).split(',').map((s) => s.trim()).filter(Boolean);
        const dir = path.resolve(ROOT, String(flag('dir', 'catalog/assets-v1')));
        const entries = bomData.parts || [];
        const rows = [];
        const issues = [];
        for (const item of entries) {
          const id = String(item.substituteFor || item.ldraw || item.part || item.design || '');
          if (!id) continue;
          const qty = item.qty ?? item.quantity ?? 1;
          let def = null, err = null;
          try { def = loadDefinition(dir, id); } catch (e) { err = e; }
          if (!def) {
            issues.push({ part: id, qty, code: 'missing-asset', msg: `目录里没有零件 ${id}` });
            rows.push({ part: id, qty, ok: false, blocking: true, caps: null });
            continue;
          }
          const caps = def.capabilities;
          const blockers = [];
          const gaps = [];
          if (useFor.includes('render') && caps.render.state === 'unsupported') blockers.push('render-unsupported');
          if (useFor.includes('render') && caps.render.state === 'inferred') gaps.push('render-parametric-only');
          if (useFor.includes('collide') && caps.collide.state === 'unsupported') blockers.push('collision-unsupported');
          if (useFor.includes('collide') && caps.collide.state === 'inferred') gaps.push('collision-single-box');
          if (useFor.includes('assemble') && caps.assemble.state === 'unsupported') blockers.push('no-connectors');
          if (useFor.includes('assemble') && caps.assemble.state === 'measured') gaps.push('connectors-unverified-by-fixture');
          const ok = blockers.length === 0;
          if (!ok) issues.push({ part: id, qty, code: blockers[0], msg: blockers.join(', ') });
          rows.push({
            part: id, qty, ok, blocking: blockers.length > 0,
            revision: def.revision,
            caps: {
              render: caps.render.state, collide: caps.collide.state, assemble: caps.assemble.state,
              connectorCount: connectorCountOf(def),
            },
            gaps,
          });
        }
        const blocking = rows.filter((r) => r.blocking).length;
        const passed = blocking === 0 && rows.length > 0;
        out({
          // commandOk 与 passed 分离：命令跑通不代表目录通过（PRD §5.6）
          ok: passed, commandOk: true, passed,
          bom: path.relative(ROOT, bomFile),
          requested: useFor,
          parts: rows.length,
          blocking,
          stats: {
            renderMeasured: rows.filter((r) => r.caps?.render === 'measured').length,
            collideVerified: rows.filter((r) => r.caps?.collide === 'verified').length,
            assembleMeasured: rows.filter((r) => r.caps?.assemble === 'measured').length,
          },
          issues,
          rows,
          note: 'passed=true 表示本次用途下没有阻塞项；gaps 里的项仍需人工确认，不计为已验证',
        });
        process.exit(passed ? 0 : 1);
      }
      if (sub === 'verify') {
        // assets verify [--dir catalog/assets-v1]
        const dir = path.resolve(ROOT, String(flag('dir', 'catalog/assets-v1')));
        const r = verifyStore(dir);
        out({ ok: r.ok, commandOk: true, passed: r.ok, ...r });
        process.exit(r.ok ? 0 : 1);
      }
      if (sub === 'index') {
        // assets index [--json]：只读索引，不加载任何定义
        const dir = path.resolve(ROOT, String(flag('dir', 'catalog/assets-v1')));
        const idx = readIndex(dir);
        out({ ok: true, commandOk: true, passed: true, format: idx.format, version: idx.version, profileId: idx.profileId, parts: idx.parts.length, indexBytes: Buffer.byteLength(JSON.stringify(idx)) });
        break;
      }
      fail(`assets 子命令未知：${sub ?? '(空)'}；可用 compile / inspect / preflight / verify / index`);
      break;
    }

    // ---------------- PRD v2：关系装配 0.3（AS）----------------
    case 'assembly': {
      const sub = args.shift();
      if (sub === 'validate') {
        const f = args[0] || fail('缺少 .assembly.brick.json');
        const src = readJSON(f);
        const r = validateAssembly(src, cat, {
          strictAssembly: Boolean(flag('strict-assembly')),
          photos: flag('photos') ? readJSON(flag('photos')) : null,
        });
        out({ ok: r.ok, commandOk: true, passed: r.ok, ...r, file: path.relative(ROOT, f) });
        process.exit(r.ok ? 0 : 1);
      }
      if (sub === 'compile') {
        const f = args[0] || fail('缺少 .assembly.brick.json');
        const o = flag('o') || f.replace(/\.assembly\.brick\.json$/, '.compiled.brick.json');
        const src = readJSON(f);
        const r = compileToLegacy(src, cat);
        if (!r.ok) {
          out({ ok: false, commandOk: true, passed: false, errors: r.problems, file: path.relative(ROOT, f) });
          process.exit(1);
        }
        fs.mkdirSync(path.dirname(o), { recursive: true });
        fs.writeFileSync(o, JSON.stringify(r.snapshot, null, 2) + '\n', 'utf8');
        // 编译产物必须能过 core 校验才算通过
        const v = validate(r.snapshot, cat);
        out({
          ok: r.ok && v.ok, commandOk: true, passed: v.ok,
          file: path.relative(ROOT, o),
          parts: r.snapshot.parts.length,
          order: r.order,
          losses: r.losses,
          instanceMap: r.instanceMap.slice(0, 20),
          validate: { ok: v.ok, errors: v.errors.length, warnings: v.warnings.length, stats: v.stats },
        });
        process.exit(v.ok ? 0 : 1);
      }
      if (sub === 'inspect') {
        const f = args[0] || fail('缺少 .assembly.brick.json');
        const src = readJSON(f);
        const nodes = expandNodes(src);
        const dag = topoSortPlacements(src, nodes.nodes.map((n) => n.nodePath));
        const cont = checkContainment(src);
        out({
          ok: nodes.ok && dag.ok && cont.ok, commandOk: true, passed: nodes.ok && dag.ok && cont.ok,
          containment: { ok: cont.ok, problems: cont.problems },
          nodes: nodes.nodes.map((n) => ({ path: n.nodePath, partId: n.partId, component: n.componentId })),
          topologicalOrder: dag.order,
          depth: Object.fromEntries(dag.depth || []),
          placementProblems: dag.problems,
        });
        process.exit(nodes.ok && dag.ok && cont.ok ? 0 : 1);
      }
      if (sub === 'recompute') {
        // 对 0.2 模型跑装配树重算（snap/rootAt/mounts），失败原子回滚
        const f = args[0] || fail('缺少 <model.brick.json>');
        const o = flag('o');
        const model = readJSON(f);
        const before = JSON.stringify(model.parts.map((p) => p.at));
        try {
          recompute(model, cat);
        } catch (e) {
          out({ ok: false, commandOk: true, passed: false, code: e.code, error: e.message, parts: e.parts, note: '重算失败：模型未被修改（原子回滚）' });
          process.exit(1);
        }
        if (o) fs.writeFileSync(o, JSON.stringify(model, null, 2) + '\n', 'utf8');
        const v = validate(model, cat);
        out({ ok: v.ok, commandOk: true, passed: v.ok, changed: before !== JSON.stringify(model.parts.map((p) => p.at)), validate: { ok: v.ok, errors: v.errors.length, warnings: v.warnings.length }, ...(o ? { file: o } : {}) });
        process.exit(v.ok ? 0 : 1);
      }
      fail(`assembly 子命令未知：${sub ?? '(空)'}；可用 validate / compile / inspect / recompute`);
      break;
    }

    // ---------------- PRD v2：候选与动作 C1（EN）----------------
    case 'renderstate': {
      // renderstate <model.brick.json> --az <deg> --el <deg> --target x,y,z --dist <n> --w <px> --h <px>
      //   [--max 24] [--connector-map] [-o out.json] [--state-hash <sha>]
      const f = args[0] || fail('缺少 <model.brick.json>');
      const model = readJSON(f);
      const parseVec = (s, name) => {
        const v = String(s).split(',').map((x) => Number(x.trim()));
        if (v.length !== 3 || v.some((x) => !Number.isFinite(x))) fail(`--${name} 需要三个数字，例如 --${name} 0,2,0；收到 ${s}`);
        return v;
      };
      const need = (k) => {
        const v = flag(k);
        if (v === undefined || v === true) fail(`缺少 --${k}`);
        return v;
      };
      // 注意：flag() 会把命中的 token 从 args 里 splice 掉，同一个 flag 只能读一次。
      // 读第二次会拿到 undefined（曾经因此让 --max 变成 NaN、slice(0,NaN) 静默返回空标号）。
      const maxRaw = flag('max');
      const viewRectRaw = flag('view-rect');
      const ortho = Boolean(flag('ortho'));
      const orthoHalfRaw = flag('ortho-half');
      const stateHashRaw = flag('state-hash');
      const mainRootRaw = flag('main-root');
      const focusRaw = flag('focus-parts');
      const connectorMap = Boolean(flag('connector-map'));
      const includeOccupied = Boolean(flag('include-occupied'));
      const q = {
        model, cat,
        camera: {
          azimuthDeg: Number(need('az')),
          elevationDeg: Number(need('el')),
          target: parseVec(need('target'), 'target'),
          distance: Number(need('dist')),
          width: Number(need('w')),
          height: Number(need('h')),
          ...(viewRectRaw !== undefined && viewRectRaw !== true ? (() => {
            const r = String(viewRectRaw).split(',').map(Number);
            if (r.length !== 4 || r.some((x) => !Number.isFinite(x))) fail('--view-rect 需要 x,y,w,h 四个数字');
            return { viewRect: { x: r[0], y: r[1], width: r[2], height: r[3] } };
          })() : {}),
          mode: ortho ? 'orthographic' : 'perspective',
          ...(ortho ? { orthoHalfHeight: Number(orthoHalfRaw) } : {}),
        },
        // 未显式给 --max 时由引擎取默认 24；给了必须是正整数
        ...(maxRaw !== undefined && maxRaw !== true ? { maxLabels: Number(maxRaw) } : {}),
        ...(stateHashRaw && stateHashRaw !== true ? { stateHash: String(stateHashRaw) } : {}),
        ...(mainRootRaw && mainRootRaw !== true ? { mainRootNodeId: String(mainRootRaw) } : {}),
        includeOccupied,
        ...(focusRaw && focusRaw !== true ? { focus: { nodeIds: String(focusRaw).split(',').map((s) => s.trim()).filter(Boolean) } } : {}),
      };
      const r = renderState(q);
      const payload = connectorMap ? toConnectorMap(r) : r;
      const o = flag('o');
      if (o) { fs.mkdirSync(path.dirname(path.resolve(ROOT, o)), { recursive: true }); fs.writeFileSync(path.resolve(ROOT, o), JSON.stringify(payload, null, 2) + '\n', 'utf8'); }
      out({ ...payload, ...(o ? { writtenTo: o } : {}) });
      process.exit(r.passed ? 0 : 1);
      break;
    }
    case 'candidates': {
      // candidates <model.brick.json> --child <partId> [--parent <id>] [--max 64] [--state state.json] [--b-style]
      const f = args[0] || fail('缺少 <state 或 model.brick.json>');
      const model = readJSON(f);
      const child = flag('child') || fail('缺少 --child <partId>');
      const parentNodeId = flag('parent');
      const max = Number(flag('max', 64));
      const bStyle = Boolean(flag('b-style'));
      const si = inspectFromModel(model, cat, { mainRootNodeId: flag('main-root') });
      const req = { childPartId: String(child), maxResults: max, ...(parentNodeId ? { parentNodeId: String(parentNodeId) } : {}) };
      if (bStyle) {
        const r = enumerateCandidatesForB(si.state, { taskId: String(flag('task', 'cli')), stateHash: si.stateHash, childPartId: String(child), targetRegion: parentNodeId ? { parentInstanceIds: [String(parentNodeId)] } : undefined, maxResults: max }, cat);
        out({ ok: r.ok, commandOk: true, passed: r.ok, stateHash: si.stateHash, candidates: r.candidates, enumerationComplete: r.enumerationComplete, truncated: r.truncated, noSolutionReason: r.noSolutionReason });
        process.exit(r.ok ? 0 : 1);
      }
      const r = enumerateCandidates(si.state, req, cat);
      out({
        ok: r.ok, commandOk: true, passed: r.ok,
        stateHash: si.stateHash,
        count: r.count,
        enumerationComplete: r.enumerationComplete,
        truncated: r.truncated,
        maxResults: r.maxResults,
        noSolutionReason: r.noSolutionReason,
        noSolutionDetail: r.noSolutionDetail,
        capabilityGaps: r.capabilityGaps,
        candidates: r.items.map(({ _placed, ...rest }) => rest),
      });
      process.exit(r.ok ? 0 : 1);
      break;
    }
    case 'actions': {
      const sub = args.shift();
      if (sub !== 'apply') fail(`actions 子命令未知：${sub ?? '(空)'}；可用 actions apply <model> --request <actions.json>`);
      const f = args[0] || fail('缺少 <model.brick.json>');
      const reqFile = flag('request') || fail('缺少 --request <actions.json>');
      const model = readJSON(f);
      const request = readJSON(reqFile);
      const mainRootInfo = flag('main-root');
      const si = inspectFromModel(model, cat, { mainRootNodeId: mainRootInfo ? String(mainRootInfo) : (model.parts?.[0]?.id) });
      // 库存可从 --inventory 指定，否则按 BOM 自动生成每 (件号,颜色) 的 token
      let inventory = [];
      const invFile = flag('inventory');
      if (invFile) inventory = readJSON(invFile);
      else {
        const b = bom(model, cat);
        let i = 0;
        for (const row of b) for (let k = 0; k < row.qty; k++) inventory.push({ token: `inv-${++i}-${row.part}-${row.color}`, partId: row.part, color: row.color, state: 'consumed' });
      }
      const ctx = {
        model, cat, stateHash: si.stateHash, state: si.state, inventory,
        taskId: request.taskId, mainRootNodeId: si.state.reachability?.mainRootNodeId || model.parts?.[0]?.id,
        enumerate: (r) => enumerateCandidates(si.state, r, cat),
      };
      const res = applyActions(ctx, request);
      const o = flag('o');
      if (o && res.apply?.committed && res._workingModel) fs.writeFileSync(o, JSON.stringify(res._workingModel, null, 2) + '\n', 'utf8');
      const { _workingModel, _inventory, ...clean } = res;
      out({ ...clean, ...(o && res.apply?.committed ? { writtenTo: o } : {}) });
      process.exit(res.passed ? 0 : 1);
      break;
    }

    // ---------------- PRD v2：说明书观察与四步流程（B 提供，A 集成入口）----------------
    // 本段只是把 B 的 src/manual-v2/ 公开导出接到 root CLI；不改 B 的实现。
    // 若 B 的模块缺失或导出改名，命令必须明确报"B 模块不可用"，不能静默降级成 mock。
    case 'manual': {
      const sub = args.shift();
      if (sub !== 'extract') fail(`manual 子命令未知：${sub ?? '(空)'}；可用 manual extract <pdf> --bom <bom.json> -o <out.json>`);
      const input = args[0] || fail('缺少说明书 PDF 路径');
      let mod;
      try {
        mod = await import('../src/manual-v2/extractor.js');
      } catch (e) {
        out({ ok: false, commandOk: false, passed: false, error: `B 模块不可用：src/manual-v2/extractor.js 无法加载（${e.message}）`, owner: 'B' });
        process.exit(2);
      }
      if (typeof mod.extractManualObservations !== 'function') {
        out({ ok: false, commandOk: false, passed: false, error: 'B 模块 src/manual-v2/extractor.js 未导出 extractManualObservations', owner: 'B' });
        process.exit(2);
      }
      const bomFile = flag('bom');
      const o = flag('o') || 'out/manual.observations.json';
      try {
        const result = await mod.extractManualObservations(input, bomFile ? { bomFile } : {});
        fs.mkdirSync(path.dirname(o), { recursive: true });
        fs.writeFileSync(o, JSON.stringify(result, null, 2) + '\n', 'utf8');
        out({
          ok: true, commandOk: true, passed: true,
          file: o, owner: 'B',
          format: result.format, setId: result.meta?.setId,
          totalPages: result.sourceDocument?.totalPages,
          observations: result.observations?.length,
          assemblyEvents: (result.observations || []).filter((x) => x.isAssemblyEvent).length,
          note: '观察由 B 的 extractManualObservations 产出；A 只做入口注册与落盘',
        });
      } catch (e) {
        out({ ok: false, commandOk: true, passed: false, error: e.message, owner: 'B' });
        process.exit(1);
      }
      break;
    }
    case 'workflow': {
      const sub = args.shift();
      let mod;
      try {
        mod = await import('../src/manual-v2/workflow.js');
      } catch (e) {
        out({ ok: false, commandOk: false, passed: false, error: `B 模块不可用：src/manual-v2/workflow.js 无法加载（${e.message}）`, owner: 'B' });
        process.exit(2);
      }
      if (sub === 'acceptance') {
        // workflow acceptance <setId> [-o out/acceptance.json]
        const setId = args[0] || fail('缺少 set 编号，例如：workflow acceptance 60239-1');
        if (typeof mod.createAcceptanceCriteria !== 'function') {
          out({ ok: false, commandOk: false, passed: false, error: 'B 模块未导出 createAcceptanceCriteria', owner: 'B' });
          process.exit(2);
        }
        const crit = mod.createAcceptanceCriteria(setId);
        const o = flag('o');
        if (o) { fs.mkdirSync(path.dirname(o), { recursive: true }); fs.writeFileSync(o, JSON.stringify(crit, null, 2) + '\n', 'utf8'); }
        out({ ok: true, commandOk: true, passed: true, owner: 'B', ...(o ? { file: o } : {}), acceptance: crit });
        break;
      }
      if (sub === 'plan') {
        // workflow plan <observations.json> --bom <bom.json> [-o out/build.plan.json]
        const obsFile = args[0] || fail('缺少 observations.json');
        const bomFile = flag('bom') || fail('缺少 --bom <bom.json>');
        if (typeof mod.generateBuildPlan !== 'function') {
          out({ ok: false, commandOk: false, passed: false, error: 'B 模块未导出 generateBuildPlan', owner: 'B' });
          process.exit(2);
        }
        const obs = readJSON(obsFile), bomData = readJSON(bomFile);
        const plan = mod.generateBuildPlan(obs, bomData, {});
        const o = flag('o') || obsFile.replace(/observations\.json$/, 'build.plan.json');
        fs.mkdirSync(path.dirname(o), { recursive: true });
        fs.writeFileSync(o, JSON.stringify(plan, null, 2) + '\n', 'utf8');
        out({
          ok: true, commandOk: true, passed: true, owner: 'B', file: o,
          tasks: plan.tasks?.length ?? plan.submodels?.length ?? null,
          totalParts: plan.criteria?.totalPartsAuthoritative ?? plan.totals?.parts ?? null,
          note: '计划由 B 的 generateBuildPlan 产出；A 只做入口注册与落盘',
        });
        break;
      }
      if (sub === 'audit') {
        // workflow audit <build.plan.json> --receipts <dir>
        const planFile = args[0] || fail('缺少 build.plan.json');
        const dir = flag('receipts') || fail('缺少 --receipts <dir>');
        if (typeof mod.auditTotalAssembly !== 'function') {
          out({ ok: false, commandOk: false, passed: false, error: 'B 模块未导出 auditTotalAssembly', owner: 'B' });
          process.exit(2);
        }
        const plan = readJSON(planFile);
        const receipts = fs.existsSync(dir)
          ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
          : [];
        const res = mod.auditTotalAssembly(plan, receipts);
        out({ ok: res.ok ?? res.passed ?? false, commandOk: true, passed: res.ok ?? res.passed ?? false, owner: 'B', receipts: receipts.length, ...res });
        process.exit((res.ok ?? res.passed) ? 0 : 1);
        break;
      }
      fail(`workflow 子命令未知：${sub ?? '(空)'}；可用 acceptance / plan / audit`);
      break;
    }

    default: console.log(HELP); process.exit(cmd ? 2 : 0);
  }
}
/** 烘焙模型的 LDraw 几何；目录里一个 .dat 都没有时返回 null（调用方决定报错还是回退） */
function bakeFor(model) {
  const baked = buildModelGeometries(model, cat);
  return baked.parts ? baked : null;
}
/** 嵌入模型；geom='param' 时显式关掉查看器的 LDraw 通道（否则嵌入即默认开启） */
function embed(model, baked, geom = 'ldraw') {
  const html = fs.readFileSync(path.join(ROOT, 'dist/viewer.html'), 'utf8');
  const data = JSON.stringify(model).replace(/</g, '\\u003c');
  const geomTag = baked ? `<script>window.__LDRAW_GEOM__=${JSON.stringify(baked).replace(/</g, '\\u003c')}</script>` : '';
  return html.replace('<!--MODEL-->', () => `<script>window.__BRICK_MODEL__=${data}</script>${geomTag}<script>window.__GEOM_PARAM__=${baked && geom === 'param'}</script>`);
}
async function launchBrowser() {
  const { chromium } = await import('playwright');
  const exe = process.env.CHROMIUM_PATH || ['/usr/local/bin/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
  const extraLib = '/home/administrator/.local/rootfs/usr/lib/x86_64-linux-gnu';
  const env = { ...process.env };
  if (fs.existsSync(extraLib)) env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${extraLib}:${env.LD_LIBRARY_PATH}` : extraLib;
  return chromium.launch({ executablePath: exe, env, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
}
async function launch(model, baked) {
  const browser = await launchBrowser();
  const tmp = path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'brickkit-')), 'v.html'); fs.writeFileSync(tmp, embed(model, baked, baked ? 'ldraw' : 'param'));
  return { browser, url: 'file://' + tmp };
}
async function booklet(model, outFile, baked) {
  const { browser, url } = await launch(model, baked);
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
function computeOpenStuds(model, stepMax = null, filterParts = null) {
  const active = (model.parts || []).filter((p) => p && cat.parts[p.part] && (stepMax === null || p.step <= stepMax));
  const connMap = new Map();
  for (const p of active) connMap.set(p.id, partConnectors(p, cat.parts[p.part]));
  const close = (p1, p2) => Math.abs(p1[0] - p2[0]) <= 0.08 && Math.abs(p1[1] - p2[1]) <= 0.20 && Math.abs(p1[2] - p2[2]) <= 0.08;
  const open = [];
  for (const p of active) {
    if (filterParts && !filterParts.has(p.id)) continue;
    const conn = connMap.get(p.id);
    for (const s of conn.studs) {
      let occupied = false;
      for (const q of active) {
        if (q.id === p.id) continue;
        const qConn = connMap.get(q.id);
        if (qConn.receptors.some((r) => close(s.pos, r.pos))) { occupied = true; break; }
      }
      if (!occupied) {
        open.push({ id: p.id, part: p.part, stud: s.index, kind: s.kind, dir: s.dir, pos: s.pos, label: `${p.id}#${s.index}` });
      }
    }
  }
  return open;
}
async function render(model, q, outFile, baked, openStuds = null) {
  const { browser, url } = await launch(model, baked);
  const w = +(q.get('w') || 1200), h = +(q.get('h') || 900);
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(url + '#' + q.toString());
  await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 30000 }).catch(() => {});
  if (Array.isArray(openStuds) && openStuds.length) {
    await page.evaluate((studs) => {
      const stage = document.querySelector('#stage');
      const glCanvas = document.querySelector('#c');
      const w = glCanvas.clientWidth || glCanvas.width, h = glCanvas.clientHeight || glCanvas.height;
      const ov = document.createElement('canvas');
      ov.width = w; ov.height = h;
      ov.style.cssText = `position:absolute;left:0;top:0;width:${w}px;height:${h}px;pointer-events:none;z-index:99`;
      stage.style.position = 'relative';
      stage.appendChild(ov);
      const ctx = ov.getContext('2d');
      ctx.font = 'bold 11px monospace';
      ctx.textBaseline = 'middle';
      const dirColors = { '+y': '#0055d4', '-y': '#7a00b8', '+x': '#d40000', '-x': '#c45100', '+z': '#008033', '-z': '#007a87' };
      const projected = studs.map((s) => ({ ...s, pt: window.brickkit.projectWorldPoint(s.pos[0], s.pos[1], s.pos[2]) }))
        .filter((s) => s.pt && s.pt.z >= -1 && s.pt.z <= 1 && s.pt.x >= 4 && s.pt.x <= w - 4 && s.pt.y >= 4 && s.pt.y <= h - 4)
        .sort((a, b) => b.pt.z - a.pt.z);
      for (const s of projected) {
        const { x, y } = s.pt;
        const bg = dirColors[s.dir] || '#222';
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = bg;
        ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fill();
        const text = s.label;
        const tw = ctx.measureText(text).width + 6;
        const th = 14;
        const bx = Math.min(w - tw - 2, Math.max(2, x + 5));
        const by = Math.min(h - th - 2, Math.max(2, y - th / 2));
        ctx.fillStyle = 'rgba(255,255,255,0.88)';
        ctx.strokeStyle = bg;
        ctx.lineWidth = 1.2;
        ctx.fillRect(bx, by, tw, th);
        ctx.strokeRect(bx, by, tw, th);
        ctx.fillStyle = bg;
        ctx.fillText(text, bx + 3, by + th / 2);
      }
    }, openStuds);
    await page.locator('#stage').screenshot({ path: outFile });
  } else {
    await page.locator('#c').screenshot({ path: outFile });
  }
  const stat = await page.evaluate(() => (typeof window.__geomStat === 'object' ? window.__geomStat : null)).catch(() => null);
  await browser.close();
  if (errs.length) throw new Error(errs.join('\n'));
  return stat;
}
main().catch((e) => fail(e.message));
