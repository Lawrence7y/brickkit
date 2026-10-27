#!/usr/bin/env node
/**
 * tools/gen-training-steps.mjs —— BrickVLM SFT 多模态合成数据引擎
 *
 * 把 .brick.json 里**带真实 snap 关系**的装配步骤，转成一跳 ShareGPT 多模态样本：
 *   状态图（第 t−1 步，空闲凸点带编号标签）+ 说明书风格图（第 t 步）+ 本步零件清单
 *   → 助手输出 6 字段动作 JSON 数组。
 *
 * Ground Truth 唯一来源 = 模型 parts[].snap（on/stud/receptor/rot），禁止推断。
 * 质量门禁：
 *   - 每条 GT 必须 partsConnected 复核通过；任一失败 → 整步样本丢弃（模型有假连接）
 *   - GT 父件必须在基准状态（step < t）里，否则状态图上没有该标签 → 该条不计入答案
 *   - GT 目标凸点在基准状态必须空闲 → 否则该条不计入答案
 *   - 无 snap 的零件是根件，不计入 GT
 *
 * 用法：
 *   node tools/gen-training-steps.mjs --models a.brick.json,b.brick.json \
 *     --out out/dataset/brickvlm-sft.jsonl [--max-steps 40] [--render-dir out/dataset/img] [--no-render]
 * 可选：
 *   --meta <path>            统计文件（默认 <out 去扩展名>.meta.json）
 *   --per-model-out <dir>    额外按模型拆分 JSONL（便于按模型族划分 split）
 *   --allow-derived-snap     对无 snap 的模型，从权威 at/rot/up 反解唯一扣合并标注 provenance=derived
 *   --az/--el/--w/--h        渲染机位与尺寸（默认 35 / 26 / 800 / 600）
 *   --manual-images          除「第 t 步模型渲染」外，再附一张真实说明书页（需 --manual-dir + manifest）
 *   --manual-dir <dir>       说明书页 PNG 目录（例如 out/manual-pages/60239）
 *   --manual-map <json>      { "<modelId>": { "<step>": "<page-file>" } } 步骤→说明书页映射
 *   --pretty                 统计 JSON 美化
 *   --quiet                  不打印进度
 *
 * 退出码：0 = 正常产出（即便样本为 0，只要有模型被处理）；1 = 致命错误。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { partConnectors, partsConnected, snapPart } from '../src/core/core.js';
import { loadCatalog, extractStepSamples } from './lib/snap-gt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const round = (v, n = 4) => (Number.isFinite(v) ? Number(v.toFixed(n)) : v);
const pad2 = (n) => String(n).padStart(2, '0');

/** 系统提示词：与 docs/BrickVLM训练架构.md 的「输入输出契约」逐字一致 */
export const SYSTEM_PROMPT = '你是乐高说明书拼装器。根据说明书步骤图与当前模型（已标注空闲凸点编号）输出 JSON 数组，'
  + '每项 {"part","color","on","stud","receptor","rot"}。只能引用画面中可见的凸点标签。';

/** 动作契约字段（顺序即输出顺序） */
export const ACTION_FIELDS = ['part', 'color', 'on', 'stud', 'receptor', 'rot'];

const USAGE = `node tools/gen-training-steps.mjs --models <a.brick.json[,b...]> --out <out.jsonl> [options]

必填：
  --models <list>        逗号分隔的 .brick.json 路径
  --out <file>           输出 JSONL（每行一个 ShareGPT 样本）

可选：
  --max-steps <n>        每个模型最多产出多少步样本（默认不限）
  --render-dir <dir>     图片输出目录（默认 out/dataset/img）
  --no-render            只导文本，不渲染图片（快速验证 schema）
  --meta <file>          统计文件（默认把 --out 的扩展名换成 .meta.json）
  --per-model-out <dir>  额外按模型拆分 JSONL
  --allow-derived-snap   对无 snap 的模型从 at/rot/up 反解唯一扣合（标 provenance=derived）；默认关闭
  --az/--el/--w/--h      渲染机位/尺寸（默认 35 / 26 / 800 / 600）
  --manual-dir <dir>     真实说明书页目录（附 manual_image）
  --manual-map <json>    { modelId: { step: pageFile } } 步骤到说明书页的映射
  --pretty               统计 JSON 美化
  --quiet                安静模式
`;

/** 极简参数解析：只吃 `--k v` 与 `--k`（布尔） */
function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`无法识别的参数：${a}`);
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { flags.set(key, next); i++; } else { flags.set(key, true); }
  }
  return flags;
}

/** 本步需要安装的零件清单（按零件号+颜色聚合，附数量）——输入侧「本步需安装」字段 */
function inventoryOf(gt) {
  const agg = new Map();
  for (const g of gt) {
    const k = `${g.part}#${g.color}`;
    const cur = agg.get(k) || { part: g.part, color: g.color, qty: 0 };
    cur.qty++;
    agg.set(k, cur);
  }
  return [...agg.values()].sort((a, b) => (a.part < b.part ? -1 : a.part > b.part ? 1 : a.color - b.color));
}

/** 可用凸点列表（精简字段，避免 prompt 过长） */
function openStudView(openStuds) {
  return openStuds.map((s) => ({ label: s.label, part: s.part, stud: s.stud, kind: s.kind, dir: s.dir }));
}

/** 助手答案：严格 6 字段、按 (part,on,stud) 排序保证可复现 */
function answerOf(gt) {
  return gt
    .map((g) => ({ part: g.part, color: g.color, on: g.on, stud: g.stud, receptor: g.receptor, rot: g.rot }))
    .sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : a.stud - b.stud || (a.part < b.part ? -1 : 1)));
}

/** 构造一条 ShareGPT 多模态样本 */
export function buildSample({ modelId, step, gt, openStuds, images, manualAvailable }) {
  const inventory = inventoryOf(gt);
  const userText = `本步需安装：${JSON.stringify(inventory)}。可用的凸点：${JSON.stringify(openStudView(openStuds))}`;
  const content = images.map((image) => ({ type: 'image', image }));
  content.push({ type: 'text', text: userText });
  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content },
      { role: 'assistant', content: [{ type: 'json', value: answerOf(gt) }] },
    ],
    meta: {
      model: modelId,
      step,
      base_step: step - 1,
      manual_available: manualAvailable,
      open_stud_count: openStuds.length,
      gt_count: gt.length,
      gt_provenance: [...new Set(gt.map((g) => g._provenance))].sort(),
    },
  };
}

/* ------------------------------------------------------------------ 渲染 */
/** 启动一个常驻渲染进程（每张图 = 一次 CLI 调用；CLI 自身无批量模式且禁止改动） */
function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function renderStep({ modelFile, outFile, step, showStuds, az, el, w, h }) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const args = ['cli/brickkit.mjs', 'render', modelFile, '-o', outFile,
    '--az', String(az), '--el', String(el), '--w', String(w), '--h', String(h), '--step', String(step)];
  if (showStuds) args.push('--show-studs');
  const r = await runNode(args);
  let info = null;
  try { info = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { info = null; }
  const ok = r.code === 0 && info && info.ok && fs.existsSync(outFile);
  return { ok, info, stdout: r.stdout, stderr: r.stderr, file: outFile, step, showStuds };
}

/* ------------------------------------------------------------------ 主流程 */
async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.has('help') || !flags.size) { process.stdout.write(USAGE); return; }

  const modelsRaw = flags.get('models');
  const outFile = flags.get('out');
  if (typeof modelsRaw !== 'string') throw new Error('缺少 --models（逗号分隔的 .brick.json 路径）');
  if (typeof outFile !== 'string') throw new Error('缺少 --out（输出 JSONL 路径）');

  const modelFiles = modelsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const maxSteps = flags.has('max-steps') ? Number(flags.get('max-steps')) : Infinity;
  if (maxSteps !== Infinity && (!Number.isInteger(maxSteps) || maxSteps < 1)) throw new Error(`--max-steps 必须是 ≥1 的整数，收到 ${flags.get('max-steps')}`);
  const renderDir = String(flags.get('render-dir') || 'out/dataset/img');
  const noRender = Boolean(flags.get('no-render'));
  const allowDerivedSnap = Boolean(flags.get('allow-derived-snap'));
  const az = Number(flags.get('az') ?? 35), el = Number(flags.get('el') ?? 26);
  const w = Number(flags.get('w') ?? 800), h = Number(flags.get('h') ?? 600);
  const quiet = Boolean(flags.get('quiet'));
  const log = (msg) => { if (!quiet) process.stderr.write(msg + '\n'); };

  const cat = loadCatalog(ROOT);
  const core = { partConnectors, partsConnected, snapPart };

  const metaPath = String(flags.get('meta') || outFile.replace(/\.jsonl$/, '') + '.meta.json');
  const perModelOut = flags.has('per-model-out') ? path.resolve(ROOT, String(flags.get('per-model-out'))) : null;
  const manualDir = flags.has('manual-dir') ? path.resolve(ROOT, String(flags.get('manual-dir'))) : null;
  const manualMap = flags.has('manual-map') ? readJSON(String(flags.get('manual-map'))) : {};

  fs.mkdirSync(path.dirname(path.resolve(ROOT, outFile)), { recursive: true });
  if (!noRender) fs.mkdirSync(path.resolve(ROOT, renderDir), { recursive: true });

  const perModelStats = {};
  const allDropped = [];
  const lines = [];
  const perModelLines = new Map();
  let renderCalls = 0, renderFails = 0, renderMsTotal = 0, manualFallbackToState = 0;
  let manualAvailableCount = 0, manualUnavailableCount = 0;
  const imageFiles = [];

  // 模型 id 唯一化：basename 去掉 .brick.json；若重名（如多份 state_next.brick.json），
  // 追加父目录 slug 保证样本 meta.model 与图片文件名可区分（否则图片互相覆盖 + 统计串号）。
  const usedIds = new Set();
  const modelIdOf = (abs) => {
    const base = path.basename(abs).replace(/\.brick\.json$/, '');
    let id = base;
    if (usedIds.has(id)) {
      const parent = path.basename(path.dirname(abs)).replace(/[^A-Za-z0-9_-]/g, '');
      id = `${base}-${parent}`;
      let n = 2;
      while (usedIds.has(id)) id = `${base}-${parent}-${n++}`;
    }
    usedIds.add(id);
    return id;
  };

  for (const rel of modelFiles) {
    const abs = path.resolve(ROOT, rel);
    if (!fs.existsSync(abs)) throw new Error(`模型文件不存在：${rel}`);
    const model = readJSON(abs);
    const modelId = modelIdOf(abs);
    const hasSnap = (model.parts || []).filter((p) => p && p.snap).length;

    const r = extractStepSamples({ model, cat, modelId, lib: core, allowDerivedSnap, maxSteps });
    const modelOutLines = [];
    let modelImages = 0, modelManualOk = 0;

    for (const s of r.samples) {
      const stepTag = `${modelId}-step${pad2(s.step)}`;
      let stateImg = null, manualImg = null, manualAvailable = false;

      if (!noRender) {
        const stateFile = path.join(renderDir, `${stepTag}-state-marked.png`);
        const t0 = Date.now();
        const sr = await renderStep({ modelFile: rel, outFile: path.resolve(ROOT, stateFile), step: s.baseStep, showStuds: true, az, el, w, h });
        renderMsTotal += Date.now() - t0; renderCalls++;
        if (sr.ok) { stateImg = stateFile.replace(/\\/g, '/'); modelImages++; imageFiles.push({ file: stateImg, bytes: fs.statSync(path.resolve(ROOT, stateFile)).size }); }
        else { renderFails++; allDropped.push({ model: modelId, step: s.step, reason: 'render-failed', detail: (sr.stderr || sr.stdout || '').slice(0, 400) }); continue; }
        if (stateImg) {
          // 说明书风格图：第 t 步（装完本步后的成品），不带凸点标签。
          // 渲染失败时按规范回退为「复用状态图」并在样本里诚实标 manual_available: false。
          const manualFile = path.join(renderDir, `${stepTag}-manual.png`);
          const t1 = Date.now();
          const mr = await renderStep({ modelFile: rel, outFile: path.resolve(ROOT, manualFile), step: s.step, showStuds: false, az, el, w, h });
          renderMsTotal += Date.now() - t1; renderCalls++;
          if (mr.ok) {
            manualImg = manualFile.replace(/\\/g, '/');
            modelImages++;
            imageFiles.push({ file: manualImg, bytes: fs.statSync(path.resolve(ROOT, manualFile)).size });
          } else {
            // 回退：复用状态图（manualImg 保持 null → 下面 images 只放一张，manual_available 记 false）
            renderFails++;
            manualFallbackToState++;
          }
        }
      }

      // 真实说明书页（可选）：映射命中时用真实页替换/补上「说明书风格图」
      const mapped = manualMap[modelId]?.[String(s.step)];
      let manualImagePath = manualImg;
      let manualSource = manualImg ? 'synthetic_step_render' : null;
      if (mapped && manualDir) {
        const p = path.join(manualDir, String(mapped));
        if (fs.existsSync(p)) {
          // 用相对 ROOT 的路径，保持样本可移植
          manualImagePath = path.relative(ROOT, p).replace(/\\/g, '/');
          manualSource = 'real_manual_page';
          modelManualOk++;
          imageFiles.push({ file: manualImagePath, bytes: fs.statSync(path.resolve(ROOT, manualImagePath)).size });
        }
      }
      if (manualImagePath) manualAvailableCount++; else manualUnavailableCount++;

      // 图片顺序：状态图 → 说明书风格图。缺说明书图时不重复塞状态图（避免同图两遍），
      // 由 meta.manual_available=false 与 render_mode 如实表达。
      const images = [];
      if (stateImg) images.push(stateImg);
      if (manualImagePath) images.push(manualImagePath);
      // 无图模式（--no-render）时 images 为空：样本仍然合法（纯文本 schema 校验用），
      // 但 meta.manual_available 如实为 false。
      const sample = buildSample({ modelId, step: s.step, gt: s.gt, openStuds: s.openStuds, images, manualAvailable: Boolean(manualImagePath) });
      sample.meta.render_mode = noRender ? 'none' : (manualSource || 'state_only');
      sample.meta.manual_source = manualSource;
      sample.meta.gt_deferred_same_step = s.deferred.length;
      sample.meta.gt_target_stud_occupied = s.unsolvable.length;
      const line = JSON.stringify(sample);
      lines.push(line);
      modelOutLines.push(line);
    }

    allDropped.push(...r.dropped);
    const st = {
      ...r.stats,
      file: rel,
      partsWithSnap: hasSnap,
      parts: (model.parts || []).length,
      samplesEmitted: modelOutLines.length,
      images: modelImages,
      manualPagesUsed: modelManualOk,
    };
    perModelStats[modelId] = st;
    if (perModelOut && modelOutLines.length) {
      fs.mkdirSync(perModelOut, { recursive: true });
      fs.writeFileSync(path.join(perModelOut, `${modelId}.jsonl`), modelOutLines.join('\n') + '\n');
    }
    log(`[${modelId}] parts=${st.parts} snap=${hasSnap} steps=${st.steps} samples=${st.samples} emitted=${modelOutLines.length} dropped=${st.dropped} imgs=${modelImages}`);
  }

  fs.writeFileSync(path.resolve(ROOT, outFile), lines.length ? lines.join('\n') + '\n' : '');

  const totalSamples = lines.length;
  const dropReasons = {};
  for (const d of allDropped) dropReasons[d.reason] = (dropReasons[d.reason] || 0) + 1;
  const statsList = Object.values(perModelStats);
  const avgOpen = totalSamples
    ? statsList.reduce((a, s) => a + (s.avgOpenStuds || 0) * (s.samplesEmitted || 0), 0) / totalSamples
    : 0;
  const totalGt = statsList.reduce((a, s) => a + (((s.gtProvenance?.snap) || 0) + ((s.gtProvenance?.derived) || 0)), 0);

  const meta = {
    format: 'brickvlm-sft-manifest',
    version: '1.0',
    createdAt: new Date().toISOString(),
    generator: 'tools/gen-training-steps.mjs',
    systemPrompt: SYSTEM_PROMPT,
    actionFields: ACTION_FIELDS,
    render: {
      enabled: !noRender,
      az, el, w, h,
      stateImageSuffix: '-state-marked.png',
      manualImageSuffix: '-manual.png',
      studLabelConvention: '空闲凸点标签 = `${partId}#${studIndex}`（与 cli/brickkit.mjs render --show-studs 同源）',
      calls: renderCalls,
      failed: renderFails,
      manualRenderFallbackToState: manualFallbackToState,
      avgMsPerCall: renderCalls ? Math.round(renderMsTotal / renderCalls) : 0,
      images: imageFiles.length,
    },
    modes: {
      allowDerivedSnap,
      manualDir: manualDir ? path.relative(ROOT, manualDir).replace(/\\/g, '/') : null,
    },
    totals: {
      models: modelFiles.length,
      samples: totalSamples,
      gtItems: totalGt,
      gtPerSample: totalSamples ? round(totalGt / totalSamples, 2) : 0,
      avgOpenStuds: round(avgOpen, 2),
      images: imageFiles.length,
      samplesWithManualImage: manualAvailableCount,
      samplesWithoutManualImage: manualUnavailableCount,
      dropped: allDropped.length,
      dropReasons,
    },
    perModel: perModelStats,
    droppedDetail: allDropped.slice(0, 200),
  };
  fs.mkdirSync(path.dirname(path.resolve(ROOT, metaPath)), { recursive: true });
  fs.writeFileSync(path.resolve(ROOT, metaPath), JSON.stringify(meta, null, 2) + '\n');

  process.stdout.write(JSON.stringify({
    ok: true,
    out: outFile,
    meta: metaPath,
    samples: totalSamples,
    images: imageFiles.length,
    dropped: allDropped.length,
    dropReasons,
    perModel: Object.fromEntries(Object.entries(perModelStats).map(([k, v]) => [k, { samples: v.samplesEmitted, dropped: v.dropped, images: v.images }])),
  }, null, flags.has('pretty') ? 2 : 0) + '\n');
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n');
  process.exit(1);
});
