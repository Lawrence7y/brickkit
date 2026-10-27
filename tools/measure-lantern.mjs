// 灯笼照片实测（躺倒侧视两张）：整体长宽比、柱高占总长比例、中芯沿轴向色带分段。
// 数据源：src/core/diff.js 的 extractPhotoMask（解码 RGBA@512 + flood-fill 掩膜诊断）+ colorClassImage（9 粗色类）+ sharp。
// 两张侧视的 flood-fill 掩膜均不可靠（a090_e05 bgRatio 0.94>0.92 退化为椭圆窗 degraded:true；
// a090_e00 掩膜非 degraded 但前景覆盖率仅 ~9.5%，背景吞掉大半个模型），
// 因此测量改用「色类前景」（同一套 diff.js 色类原语，不依赖背景均匀性）：
//   粉族 = 粉/紫类且 b>g（暖光下粉柱偏紫，两类合并；木桌 b<g 被排除）
//   红族 = 红类且 Lab 色相 < 32°（木桌色相 40~45° 大部分被排除）
//   蓝族 = 蓝/黑类且 b>r+8 且 L>8（暗蓝端板；暗房间背景同色，靠空间约束排除）
// 空间锚定（防木桌红/房间蓝污染）：先取「最大粉族连通域」= 灯笼主体（rail+棚顶粉件连成一片），
//   测量窗口 = 主体 bbox ∪ 与之相邻的红/蓝连通域；一切统计只发生在窗口内。
// 输出：out/lantern-v2/measurements.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPhotoMask, colorClassImage, rgbaToLab } from '../src/core/diff.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PHOTO_DIR = 'D:/bingdown/新建文件夹 (2)';
const OUT = path.join(ROOT, 'out/lantern-v2/measurements.json');
const TARGETS = [
  { id: 'lantern_a090_e05', file: '1792845158528.jpg', note: '躺倒侧视 e5：棚顶端在左、底座端在右（photos.json 标注）' },
  { id: 'lantern_a090_e00', file: '1792845158626.jpg', note: '躺倒平视 e0：上 rail / 中芯 / 下 rail（photos.json 标注）' },
];

/** 像素族归类：2=粉族 1=红族 3=蓝族 0=背景（规则见文件头） */
function familyMap(cls, rgba, lab, n) {
  const fam = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = cls[i], r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2], L = lab[i * 3];
    if ((c === 8 || c === 7) && b > g) fam[i] = 2;
    else if (c === 3) {
      const hue = (Math.atan2(lab[i * 3 + 2], lab[i * 3 + 1]) * 180 / Math.PI + 360) % 360;
      if (hue < 32) fam[i] = 1;
    } else if ((c === 6 || c === 0) && b > r + 8 && L > 8) fam[i] = 3;
  }
  return fam;
}

/** 同族 4 邻域连通域：返回 [{ minX, maxX, minY, maxY, n, fam }] 按面积降序（n 大者优先） */
function componentsOf(fam, w, h, famValue) {
  const seen = new Uint8Array(w * h), out = [];
  for (let i = 0; i < w * h; i++) {
    if (seen[i] || fam[i] !== famValue) continue;
    const q = [i]; seen[i] = 1;
    let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, n = 0;
    while (q.length) {
      const p = q.pop(), x = p % w, y = (p / w) | 0;
      n++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && !seen[p - 1] && fam[p - 1] === famValue) { seen[p - 1] = 1; q.push(p - 1); }
      if (x < w - 1 && !seen[p + 1] && fam[p + 1] === famValue) { seen[p + 1] = 1; q.push(p + 1); }
      if (y > 0 && !seen[p - w] && fam[p - w] === famValue) { seen[p - w] = 1; q.push(p - w); }
      if (y < h - 1 && !seen[p + w] && fam[p + w] === famValue) { seen[p + w] = 1; q.push(p + w); }
    }
    out.push({ minX, maxX, minY, maxY, n, fam: famValue });
  }
  return out.sort((a, b) => b.n - a.n);
}

/** 行序列聚类：连续（间隔 ≤ gap）的行合成一簇 */
function clusterRows(rows, gap) {
  const out = [];
  for (const y of rows) {
    const last = out[out.length - 1];
    if (last && y - last[last.length - 1] <= gap) last.push(y); else out.push([y]);
  }
  return out;
}

/** 主轴长宽比（PCA + 1%~99% 分位，抗斜放与离群） */
function principalAspect(sel, w, h) {
  let n = 0, sx = 0, sy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (sel[y * w + x]) { sx += x; sy += y; n++; }
  if (n < 20) return null;
  const cx = sx / n, cy = sy / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (sel[y * w + x]) {
    sxx += (x - cx) ** 2; syy += (y - cy) ** 2; sxy += (x - cx) * (y - cy);
  }
  const theta = 0.5 * Math.atan2(2 * (sxy / n), sxx / n - syy / n);
  const ct = Math.cos(theta), st = Math.sin(theta);
  const span = (pick) => {
    const a = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (sel[y * w + x]) a.push(pick(x - cx, y - cy));
    a.sort((p, q) => p - q);
    const qq = (p) => a[Math.min(a.length - 1, Math.max(0, Math.round(p * (a.length - 1))))];
    return qq(0.99) - qq(0.01);
  };
  const lengthPx = span((dx, dy) => dx * ct + dy * st);
  const widthPx = span((dx, dy) => -dx * st + dy * ct);
  return { aspect: Math.round(lengthPx / Math.max(1, widthPx) * 1000) / 1000, angleDeg: Math.round(((theta * 180 / Math.PI + 90) % 180) * 10) / 10, lengthPx: Math.round(lengthPx), widthPx: Math.round(widthPx) };
}

const round3 = (v) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------- 单张照片测量
async function measureOne(t) {
  const buf = fs.readFileSync(path.join(PHOTO_DIR, t.file));
  const { rgba, w, h, tol, bgRatio, maskConfidence, degraded } = await extractPhotoMask(buf);
  const cls = colorClassImage(rgba, w * h);
  const lab = rgbaToLab(rgba, w * h);
  const fam = familyMap(cls, rgba, lab, w * h);

  // ① 灯笼主体 = 最大粉族连通域；窗口 = 主体 bbox 外扩 24px 后与其相交/相邻的红、蓝连通域并集
  const pinkComps = componentsOf(fam, w, h, 2);
  const body = pinkComps[0];
  if (!body) throw new Error(`${t.id}: 找不到粉族主体连通域`);
  const PAD = 24;
  const win = { x0: Math.max(0, body.minX - PAD), x1: Math.min(w - 1, body.maxX + PAD), y0: Math.max(0, body.minY - PAD), y1: Math.min(h - 1, body.maxY + PAD) };
  const near = (c) => c.maxX >= win.x0 && c.minX <= win.x1 && c.maxY >= win.y0 && c.minY <= win.y1;
  const redCompsAll = componentsOf(fam, w, h, 1).filter(near);
  const blueCompsAll = componentsOf(fam, w, h, 3).filter(near);
  for (const c of [...redCompsAll, ...blueCompsAll]) {
    win.x0 = Math.min(win.x0, c.minX); win.x1 = Math.max(win.x1, c.maxX);
    win.y0 = Math.min(win.y0, c.minY); win.y1 = Math.max(win.y1, c.maxY);
  }

  // ② rail：窗口内粉族行计数 → 峰值行带聚类，最上簇 = 上 rail、最下簇 = 下 rail（躺倒照片 rail 沿主轴横贯）
  const rowPink = new Array(h).fill(0);
  for (let y = win.y0; y <= win.y1; y++) for (let x = win.x0; x <= win.x1; x++) if (fam[y * w + x] === 2) rowPink[y]++;
  const peak = Math.max(...rowPink);
  const rowsHit = [];
  for (let y = win.y0; y <= win.y1; y++) if (rowPink[y] >= 0.4 * peak) rowsHit.push(y);
  const mergeGap = Math.max(8, Math.round((win.y1 - win.y0) * 0.1));   // 容忍斜放导致的 rail 行带拉宽
  const railClusters = clusterRows(rowsHit, mergeGap);
  const bandTop = railClusters[0][0], bandBot = railClusters[railClusters.length - 1].slice(-1)[0];
  const railTopInner = railClusters[0].slice(-1)[0], railBotInner = railClusters[railClusters.length - 1][0];
  const bandH = bandBot - bandTop + 1;

  // ③ 带内总长：band 行内每列三族计数 → 物体 x 范围（列计数 ≥ 3）
  const colCnt = [];
  for (let x = win.x0; x <= win.x1; x++) {
    let c = 0;
    for (let y = bandTop; y <= bandBot; y++) if (fam[y * w + x]) c++;
    colCnt.push(c);
  }
  const maxCol = Math.max(...colCnt) || 1;
  let xMin = -1, xMax = -1;
  for (let i = 0; i < colCnt.length; i++) if (colCnt[i] >= 3) { xMin = win.x0 + i; break; }
  for (let i = colCnt.length - 1; i >= 0; i--) if (colCnt[i] >= 3) { xMax = win.x0 + i; break; }
  const totalPx = xMax - xMin + 1;

  // ④ 端板：窗口内蓝族连通域，与 band 行有 ≥ 50% 高度交叠且宽 ≥ 3px → 最左/最右
  const overlapY = (c) => Math.min(c.maxY, bandBot) - Math.max(c.minY, bandTop) + 1;
  const plates = blueCompsAll
    .filter((c) => (c.maxX - c.minX + 1) >= 3 && overlapY(c) >= 0.5 * (c.maxY - c.minY + 1) && overlapY(c) >= 0.45 * bandH)
    .sort((a, b) => a.minX - b.minX);
  const plateL = plates[0] || null, plateR = plates.length >= 2 ? plates[plates.length - 1] : null;

  // ⑤ 柱区间（内部）：两端端板内缘之间；无端板时回退「列计数 ≥ 0.5×峰值」的连续区
  let xL, xR, method;
  if (plateL && plateR && plateR.minX - plateL.maxX > totalPx * 0.3) {
    xL = plateL.maxX + 1; xR = plateR.minX - 1; method = 'blue-end-plates';
  } else {
    xL = xMin; for (let i = 0; i < colCnt.length; i++) if (colCnt[i] >= 0.5 * maxCol) { xL = win.x0 + i; break; }
    xR = xMax; for (let i = colCnt.length - 1; i >= 0; i--) if (colCnt[i] >= 0.5 * maxCol) { xR = win.x0 + i; break; }
    method = 'column-density-fallback';
  }
  const interiorPx = xR - xL + 1;

  // ⑥ 中芯：band 中部（避开上下边缘的木桌红）且 x 中心落在柱区间内 10%~90% 的红族连通域，
  //    取最大者为锚。芯带 y = 锚 y 范围向上下各扩到 rail 内缘（芯是被柱部分遮挡的中央 2×2 圆砖堆，
  //    红段只在柱间隙露出，轴向顺序无法从单张照片程序化判定 → 输出红簇位置 + 芯带位置/高度，
  //    颜色顺序由 photos.json / observations 的人工标注提供，生成端做枚举）。
  const midBand0 = bandTop + 0.2 * bandH, midBand1 = bandBot - 0.2 * bandH;
  const coreZone = redCompsAll.filter((c) => {
    const cx = (c.minX + c.maxX) / 2, cy = (c.minY + c.maxY) / 2;
    return c.n >= 30 && cx >= xL + 0.1 * interiorPx && cx <= xR - 0.1 * interiorPx && cy >= midBand0 && cy <= midBand1;
  });
  const anchor = coreZone.sort((a, b) => b.n - a.n)[0] || null;
  let coreBands = null;
  if (anchor) {
    // 芯带 y：锚 y 范围向外扩至 rail 内缘（cap 到 band 中部），并统计带内红/粉像素的 x 直方图
    const cy0 = Math.max(anchor.minY - 8, midBand0), cy1 = Math.min(anchor.maxY + 8, midBand1);
    const redLs = [];
    for (let y = cy0; y <= cy1; y++) for (let x = xL; x <= xR; x++) if (fam[y * w + x] === 1) redLs.push(lab[(y * w + x) * 3]);
    redLs.sort((a, b) => a - b);
    let thr = redLs[Math.floor(redLs.length / 2)] ?? 0;
    for (let it = 0; it < 40 && redLs.length > 1; it++) {
      const lo = redLs.filter((v) => v <= thr), hi = redLs.filter((v) => v > thr);
      if (!lo.length || !hi.length) break;
      const nt = (lo.reduce((a, v) => a + v, 0) / lo.length + hi.reduce((a, v) => a + v, 0) / hi.length) / 2;
      if (Math.abs(nt - thr) < 0.01) break;
      thr = nt;
    }
    // 红簇（≥30px 的红连通域）位置：柱间隙露出的红段
    const redClusters = coreZone.map((c) => ({ x: [c.minX, c.maxX], y: [c.minY, c.maxY], px: c.n, xRatio: round3((c.minX - xMin) / totalPx) }));
    // 带内逐 1/12 段红/粉像素比（轴向分布概览）
    const bins = 12, binStat = [];
    for (let k = 0; k < bins; k++) {
      const bx0 = xL + Math.floor((xR - xL + 1) * k / bins), bx1 = xL + Math.floor((xR - xL + 1) * (k + 1) / bins) - 1;
      let red = 0, pink = 0;
      for (let y = cy0; y <= cy1; y++) for (let x = bx0; x <= bx1; x++) {
        const f = fam[y * w + x];
        if (f === 1) red++; else if (f === 2) pink++;
      }
      binStat.push({ bin: k + 1, xRatio: round3((bx0 - xMin) / totalPx), red, pink });
    }
    coreBands = {
      coreBandY: [Math.round(cy0), Math.round(cy1)],
      coreHeightToBand: round3((cy1 - cy0 + 1) / bandH),   // 芯带高 / 灯笼带高（截面对角线），2×2 芯 ≈ 2/6~7
      redAnchor: { x: [anchor.minX, anchor.maxX], y: [anchor.minY, anchor.maxY], px: anchor.n, xRatio: round3((anchor.minX - xMin) / totalPx) },
      redPixelCount: redLs.length,
      darkRedThresholdL: round3(thr),
      redClusters,
      axialBins: binStat,
      axialColorOrder: null,
      axialOrderNote: '红段被角柱遮挡、仅在柱间隙露出（红簇 x 区间见上），单张照片无法程序化判定 深红/红/粉 轴向顺序；颜色顺序按 photos.json 标注（e00「深红→红→粉→红」、a135「左深红、中红、右粉」）在生成端枚举 ≤4 组合',
    };
  }

  // ⑦ 长宽比：band ∩ [xMin,xMax] 内三族前景的 PCA
  const sel = new Uint8Array(w * h);
  for (let y = bandTop; y <= bandBot; y++) for (let x = xMin; x <= xMax; x++) if (fam[y * w + x]) sel[y * w + x] = 1;

  return {
    id: t.id, file: t.file, note: t.note,
    method: '色类前景（flood-fill 掩膜不可靠，诊断见下）：粉族(粉∪紫,b>g) ∪ 红族(色相<32°) ∪ 蓝族(b>r+8)；空间锚定=最大粉族连通域',
    workSize: `${w}x${h}`,
    maskDiagnostics: {
      extractPhotoMask: { tol, bgRatio: round3(bgRatio), maskConfidence: round3(maskConfidence), degraded },
      floodFillMaskUsed: false,
      reason: 'a090_e05 椭圆退化 / a090_e00 前景仅剩碎屑，均无法承载测量；色类前景不依赖背景均匀性',
    },
    body: { pinkComps: pinkComps.length, bodyPx: body.n, bbox: [body.minX, body.maxX, body.minY, body.maxY], window: [win.x0, win.x1, win.y0, win.y1],
      bboxAspect: round3((body.maxX - body.minX + 1) / Math.max(1, body.maxY - body.minY + 1)),
      bboxAspectNote: '主体连通域 bbox 长宽比（含端部支脚/棚顶外挑，未裁剪，比 band 内 PCA 更接近整体比例）' },
    rails: { bandTop, bandBot, railTopInner, railBotInner, bandHeightPx: bandH, clusters: railClusters.length, peakRowPinkPx: peak },
    object: { xMin, xMax, totalPx, columnSpanMethod: method, ...(plateL ? { plateL: { x: [plateL.minX, plateL.maxX], px: plateL.n } } : {}), ...(plateR ? { plateR: { x: [plateR.minX, plateR.maxX], px: plateR.n } } : {}) },
    aspect: principalAspect(sel, w, h),
    columnSpan: { interiorPx, totalPx, columnSpanRatio: round3(interiorPx / totalPx), leftCapPx: xL - xMin, rightCapPx: xMax - xR, leftCapRatio: round3((xL - xMin) / totalPx), rightCapRatio: round3((xMax - xR) / totalPx) },
    coreBands,
  };
}

// ---------------------------------------------------------------- 主流程
const photos = [];
for (const t of TARGETS) photos.push(await measureOne(t));
const agg = {
  aspectMean: round3(photos.reduce((a, r) => a + r.aspect.aspect, 0) / photos.length),
  aspectTrusted: (() => {
    // e00 窗口干净（PCA 1.945）；e05 窗口被粉色背景并入整幅（见 body.window），两者分开列出不取巧
    const e00 = photos.find((p) => p.id === 'lantern_a090_e00'), e05 = photos.find((p) => p.id === 'lantern_a090_e05');
    return { lantern_a090_e00: e00?.aspect ?? null, lantern_a090_e05: e05?.aspect ?? null, note: 'e05 主体连通域 bbox 覆盖整幅（粉色背景并入），其 aspect 仅供参考；比例以 e00 为准' };
  })(),
  columnSpanRatioMean: round3(photos.reduce((a, r) => a + r.columnSpan.columnSpanRatio, 0) / photos.length),
  capRatioMean: round3(photos.reduce((a, r) => a + (r.columnSpan.leftCapRatio + r.columnSpan.rightCapRatio), 0) / (photos.length * 2)),
  coreAxialOrder: null,
  coreAxialOrderNote: '程序化仅测得芯带位置/高度与红簇位置；深红/红/粉 轴向顺序采用 photos.json 人工标注并在生成端枚举',
};
const out = { format: 'brickbuild-measurements', version: '0.1', generatedAt: new Date().toISOString(), photos, aggregate: agg };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
