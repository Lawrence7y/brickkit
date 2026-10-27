#!/usr/bin/env node
/**
 * tools/manual-mask-probe.mjs —— 说明书页前景掩膜探针（可复跑）
 *
 * 用途：对 out/manual-pages/<set>/page-NN.png 逐页跑 extractManualMask，打印
 *   maskPath / bg / borderUniformity / fg 占比 / bbox / 右下角页码字形区是否被掩膜覆盖，
 * 用于回归 src/core/diff.js 说明书页掩膜的改动（不再靠肉眼）。
 *
 * 用法：
 *   node tools/manual-mask-probe.mjs [--dir out/manual-pages/60239] [--json out/manual-mask-probe.json]
 *                                   [--quiet] [--pages 1,2,35] [--strict]
 *
 * 判定口径：
 *   - 页码字形：一个**完全落在**页码窄带（x ≥ 0.94w 且 y ≥ 0.93h）内、面积 < 1.5% 页面积的连通分量。
 *     窄带取自实测：60239 页码字形落在 x∈[0.955,0.978]w、y∈[0.938,0.960]h，取该带留余量。
 *     只统计“整块都在带内”的小分量——模型/插画伸进页角的像素属于大分量，不算页码（旧口径
 *     按“带内有任何像素”判，会把靠近页角的模型也误报成含页码）。
 *   - bbox 是否与右下角 0.88w×0.88h 区域相交：辅助观察值（满版封面插画本来就会覆盖页角），不计入判定。
 *   - fg 占比应落在 [0.005, 0.60]；--strict 时额外要求 maskPath 全为 uniform-bg-flood
 *     （页边被满版彩图打乱的封面页按设计会走 photo-sweep-fallback，默认不算失败）。
 * 退出码：0 = 全部页满足判定；1 = 有页不满足（明细见 stdout / --json）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { extractManualMask, maskBBox, manualPageNumberPixels } from '../src/core/diff.js';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const dir = String(flag('dir', 'out/manual-pages/60239'));
const jsonOut = flag('json', null);
const quiet = Boolean(flag('quiet', false));
const wantPages = flag('pages', null);
const strict = Boolean(flag('strict', false));

/** 右下角观察区（bbox 相交检查用） */
const CORNER = 0.88;

const files = fs.readdirSync(dir).filter((f) => /^page-\d+\.png$/.test(f)).sort();
const rows = [];
let allOk = true;
for (const f of files) {
  const pageNo = Number(f.match(/page-(\d+)\.png/)[1]);
  if (wantPages && !String(wantPages).split(',').map(Number).includes(pageNo)) continue;
  const m = await extractManualMask(fs.readFileSync(path.join(dir, f)));
  let fg = 0;
  for (let i = 0; i < m.mask.length; i++) fg += m.mask[i];
  const fgRatio = fg / m.mask.length;
  const bbox = maskBBox(m.mask, m.w, m.h);
  // 页码字形残留（完全落在窄带内的孤立小分量）
  const pageNumHit = manualPageNumberPixels(m.mask, m.w, m.h);
  // bbox 是否伸进右下角观察区
  const cx = Math.floor(m.w * CORNER), cy = Math.floor(m.h * CORNER);
  const bboxInCorner = !!bbox && bbox.maxX >= cx && bbox.maxY >= cy;
  const okPath = strict ? m.maskPath === 'uniform-bg-flood' : true;
  const okFg = fgRatio >= 0.005 && fgRatio <= 0.6;
  const okPageNum = pageNumHit === 0;
  const ok = okPath && okFg && okPageNum;
  if (!ok) allOk = false;
  const row = {
    page: pageNo, maskPath: m.maskPath,
    bg: m.bg, borderUniformity: m.borderUniformity == null ? null : Number(m.borderUniformity.toFixed(3)),
    fgRatio: Number(fgRatio.toFixed(4)), bbox, bboxInCorner, pageNumHit,
    chromeMode: m.chromeMode ?? null, ok,
  };
  rows.push(row);
  if (!quiet) {
    const bg = m.bg ? `(${m.bg.r},${m.bg.g},${m.bg.b})` : '—';
    const bb = bbox ? `${bbox.minX},${bbox.minY}-${bbox.maxX},${bbox.maxY}` : 'null';
    console.log([String(pageNo).padStart(2, '0'), (m.maskPath || '?').padEnd(21), bg.padEnd(16),
      String(row.borderUniformity).padEnd(6), row.fgRatio.toFixed(4).padEnd(7), bb.padEnd(21),
      pageNumHit ? `页码${pageNumHit}` : '', bboxInCorner ? 'corner' : '', ok ? '' : '⚠'].join(' | '));
  }
}
const byPath = rows.reduce((a, r) => { a[r.maskPath] = (a[r.maskPath] || 0) + 1; return a; }, {});
const uniform = byPath['uniform-bg-flood'] || 0;
console.log(`\n共 ${rows.length} 页；路径分布 ${JSON.stringify(byPath)}；uniform-bg-flood ${uniform}/${rows.length}；全部达标=${allOk}`);
if (jsonOut) {
  fs.mkdirSync(path.dirname(String(jsonOut)), { recursive: true });
  fs.writeFileSync(String(jsonOut), JSON.stringify({ dir, generatedAt: new Date().toISOString(), rows }, null, 2));
  console.log(`已写 ${jsonOut}`);
}
process.exit(allOk ? 0 : 1);
