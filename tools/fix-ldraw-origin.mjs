// LDraw 几何原点重算：把每件的 ldrawOrigin 由官方 .dat 实测几何反推，消除「渲染几何整体漂浮/下陷」。
//
// 约定（loader 与 geom.js 共用）：本地框架 = 占地中心原点、底面 y=0、未旋转。
// 旧实现用 `[0, def.h, 0]`（h 单位片）当原点，但 ext 目录的 h 多为描述/占地推断值，
// 与 .dat 实测高度不符 → 几何整体位移（实测 4605 件里 2772 件底面不在 y=0，最大偏差 29 片），
// 渲染图看起来完整但整机悬浮，diff 轮廓对不上。
//
// 本工具的口径：raw 几何（origin=0）的 y 最小值即零件最底材料，令其落在 y=0：
//   origin_y(片) = -rawMinY(格) / PLATE
// x/z 一律不动：LDraw 零件本来就以占地中心为原点，按 bbox 居中会把伸出的销/轴算进去（18892 会错 0.7 格）。
// 有轮字段（wheel）的件不参与：车轮几何含轴心偏移，由 wheel.cy 单独表达。
//
// 用法：
//   node tools/fix-ldraw-origin.mjs            # 只报告（dry-run）
//   node tools/fix-ldraw-origin.mjs --write    # 写回 catalog/parts-ldraw.json 与 catalog/parts.json
//   node tools/fix-ldraw-origin.mjs --write --only 18892 11209   # 只改指定件
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPart, createResolver } from '../src/ldraw/loader.mjs';
import { PLATE } from '../src/core/core.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_FILE = path.join(ROOT, 'catalog/parts-ldraw.json');
const CUR_FILE = path.join(ROOT, 'catalog/parts.json');
const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? new Set(argv.slice(onlyIdx + 1)) : null;

const resolve = createResolver();
/** raw 几何（origin=0）的 y 范围，单位格 */
function rawYR(id) {
  const b = buildPart({ partId: id, color: 0, def: { h: 0 }, resolve });
  if (!b) return null;
  let min = Infinity, max = -Infinity, n = 0;
  for (const arr of Object.values(b.groups)) {
    for (let i = 0; i + 2 < arr.length; i += 3) {
      if (arr[i + 1] < min) min = arr[i + 1];
      if (arr[i + 1] > max) max = arr[i + 1];
      n++;
    }
  }
  return n ? { min, max, n } : null;
}

const ext = readJSON(EXT_FILE);
const cur = readJSON(CUR_FILE);
const changes = [];
const stats = { scanned: 0, changed: 0, skippedWheel: 0, noDat: 0, noFace: 0 };

for (const [label, file] of [['ext', ext], ['curated', cur]]) {
  for (const id of Object.keys(file.parts)) {
    if (only && !only.has(id)) continue;
    const def = file.parts[id];
    if (!def) continue;
    if (def.wheel) { stats.skippedWheel++; continue; }
    const y = rawYR(id);
    if (!y) { stats.noDat++; continue; }
    stats.scanned++;
    // 目标原点是「片」的 1/4 粒度；取整避免浮点噪声进入目录
    const want = Math.round((-y.min / PLATE) * 4) / 4;
    const have = Array.isArray(def.ldrawOrigin) ? def.ldrawOrigin[1] : def.h;
    if (!Number.isFinite(want)) { stats.noFace++; continue; }
    if (Math.abs(want - have) < 0.25) continue;
    stats.changed++;
    changes.push({ src: label, id, from: have, to: want, geomSpan: Math.round((y.max - y.min) * 100) / 100, h: def.h });
    if (WRITE) def.ldrawOrigin = [0, want, 0];
  }
}

if (WRITE && stats.changed) {
  // 缩进必须与仓库既有文件一致（parts-ldraw.json/parts.json 都是 1 空格缩进）：
  // 换成 2 空格会让整份文件显示为"全量重写"，掩盖真实的 origin 改动、也让 review 无法逐条看。
  fs.writeFileSync(EXT_FILE, JSON.stringify(ext, null, 1));
  fs.writeFileSync(CUR_FILE, JSON.stringify(cur, null, 1));
}
console.log(JSON.stringify({ ok: true, write: WRITE, ...stats, sample: changes.slice(0, 8) }));
if (!WRITE && changes.length) console.log('前 8 条：', JSON.stringify(changes.slice(0, 8), null, 1));
