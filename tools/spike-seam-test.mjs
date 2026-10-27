// Spike①：灯笼现有实拍照片在原图分辨率下的缝隙可检测性实验。
// 依据 PRD D:/desktop/prd-multiview-photos.md §1（核心判断）、FR-6.1（段级缝隙概率）、§9-10（Spike 退出标准）。
//
// 方法：
//   1) 每张照片人工定位「缝隙候选」线段（同色相邻零件的可见交界）与「对照」线段
//      （方向/颜色区域相同、但位于单一零件内部不存在边界的网格位置）；
//   2) 沿每条线段取 3 个采样位置（t=0.2/0.5/0.8），在垂直于线段方向提取
//      ±42px 亮度剖面（双线性插值原灰度图，沿线段方向 ±10px 平均降噪）；
//   3) 指标：深度 = 肩部平台中位数 − 剖面谷底（8-bit 亮度）、半高宽 FWHM(px)、
//      局部噪声 σ（两肩窗内像素标准差）、SNR = 深度/σ；
//   4) 判定：可检出 = SNR≥3 且 FWHM≥1px；
//   5) 汇总：可检出率（候选中被判为缝的比例）、误检率（对照被误判为缝的比例）。
//
// mm/px 标定（每张照片一个估计，假设与误差见 docs/spike-缝隙可检测性.md）：
//   - lantern_top_detail (8564)：0.040 mm/px。锚点：淡紫板宽度方向凸点排间距
//     200px=8mm（(1975,1728) 处垂直剖面两排凸点中心 t≈87/287）。
//   - lantern_a090_e00 (8626)：0.051 mm/px。锚点：上/下圆板柱中心距 780px=40mm
//     （6×6 截面对角柱距 5 凸点）；交叉核对：上轨凸包距 203px≈9.6mm（圆砖）、
//     下轨缝距 252px≈12.8mm（圆砖+圆板交替）。
//   - lantern_base_detail (8492)：0.047 mm/px（±20%）。锚点：绿十字平行线间距
//     339px≈16mm（板宽）；交叉核对：防反孔间距 208px≈8mm（该读数偏大 20%）。
//
// 复跑：仓库根目录 `node tools/spike-seam-test.mjs`（只读照片目录，不写任何文件）。
// 照片目录只读；清单见 examples/lantern.photos.json。
import sharp from 'sharp';

const PHOTO_DIR = 'D:/bingdown/新建文件夹 (2)';

// ---------------------------------------------------------------- 线段定义
// 线段坐标为原图 4096×3072 像素坐标（端点目视 + 数值剖面校准，见报告）。
// kind: seam=缝隙候选（同色相邻零件交界）；control=对照（单零件内部无边界）。
const PHOTOS = [
  {
    id: 'lantern_top_detail',
    file: '1792845158564.jpg',
    mmPerPx: 0.040,
    anchor: '淡紫板凸点排距 200px=8mm',
    seams: [
      { name: 'A1 淡紫V交界·上', p1: [1815, 1580], p2: [1903, 1663] },
      { name: 'A2 淡紫V交界·中上', p1: [1903, 1663], p2: [1990, 1746] },
      { name: 'A3 淡紫V交界·中下', p1: [1990, 1746], p2: [2077, 1829] },
      { name: 'A4 淡紫V交界·下', p1: [2077, 1829], p2: [2147, 1893] },
      { name: 'B1 粉圈砖缝·上', p1: [1600, 1272], p2: [1670, 1360] },
      { name: 'B2 粉圈砖缝·下', p1: [1670, 1360], p2: [1737, 1445] },
    ],
    controls: 'auto', // 平坦区自动选点（单零件内部，扫描网格后取最平 3+3）
  },
  {
    id: 'lantern_a090_e00',
    file: '1792845158626.jpg',
    mmPerPx: 0.051,
    anchor: '上下柱中心距 780px=40mm',
    seams: [
      { name: 'B2 下轨缝2', p1: [1619, 1530], p2: [1615, 1690] },
      { name: 'B3 下轨缝3', p1: [1872, 1530], p2: [1872, 1690] },
      { name: 'B4 下轨缝4', p1: [2123, 1530], p2: [2124, 1690] },
      { name: 'B5 下轨缝5', p1: [2370, 1530], p2: [2376, 1690] },
      { name: 'B6 下轨缝6', p1: [2642, 1530], p2: [2625, 1690] },
      { name: 'T2 上轨缝2', p1: [1473, 810], p2: [1475, 920] },
      { name: 'T3 上轨缝3', p1: [1677, 810], p2: [1679, 920] },
      { name: 'T4 上轨缝4', p1: [1882, 810], p2: [1883, 920] },
      { name: 'T5 上轨缝5', p1: [2085, 810], p2: [2085, 920] },
    ],
    controls: [
      { name: 'C1 粉芯段1中线', p1: [1810, 1250], p2: [1810, 1490] },
      { name: 'C2 粉芯段2中线', p1: [2210, 1250], p2: [2210, 1490] },
      { name: 'C3 下轨宽段1中线', p1: [1520, 1530], p2: [1518, 1690] },
      { name: 'C4 下轨宽段2中线', p1: [1955, 1530], p2: [1953, 1690] },
      { name: 'C5 上轨凸包1中线', p1: [1370, 810], p2: [1372, 920] },
      { name: 'C6 上轨凸包2中线', p1: [1780, 810], p2: [1780, 920] },
    ],
  },
  {
    id: 'lantern_base_detail',
    file: '1792845158492.jpg',
    mmPerPx: 0.047,
    anchor: '绿十字平行线距 339px≈16mm',
    seams: [
      { name: 'G1 绿十字主缝·上', p1: [2095, 1250], p2: [2192, 1350] },
      { name: 'G2 绿十字主缝·中上', p1: [2192, 1350], p2: [2290, 1448] },
      { name: 'G3 绿十字主缝·中下', p1: [2290, 1448], p2: [2462, 1598] },
      { name: 'G4 绿十字主缝·下', p1: [2462, 1598], p2: [2605, 1735] },
      { name: 'G5 左下缝·上', p1: [1950, 1855], p2: [2012, 1918] },
      { name: 'G6 左下缝·下', p1: [2012, 1918], p2: [2075, 1990] },
    ],
    controls: [
      { name: 'H1 主缝-棱线带中线', p1: [2300, 1555], p2: [2377, 1629] },
      { name: 'H2 上臂板面中线', p1: [2130, 1200], p2: [2237, 1304] },
      { name: 'H3 左下臂板面', p1: [1950, 1935], p2: [2050, 2032] },
      { name: 'H4 右臂板面', p1: [2630, 1710], p2: [2725, 1800] },
      { name: 'H5 上臂板面2', p1: [2300, 1360], p2: [2380, 1438] },
      { name: 'H6 右下板面', p1: [2450, 1780], p2: [2530, 1858] },
    ],
  },
];

// ---------------------------------------------------------------- 测量实现
const HALF = 42;          // 剖面半宽（px）
const ALONG_AVG = 10;     // 沿线段方向平均半宽（px）
const SAMPLE_T = [0.2, 0.5, 0.8];

function bilinear(gray, W, H, x, y) {
  if (x < 0 || y < 0 || x > W - 1 || y > H - 1) return null;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const i = y0 * W + x0;
  const a = gray[i], b = x0 + 1 < W ? gray[i + 1] : a;
  const c = y0 + 1 < H ? gray[i + W] : a;
  const d = x0 + 1 < W && y0 + 1 < H ? gray[i + W + 1] : a;
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/** 在 (px,py) 处沿法线 (nx,ny) 取亮度剖面：t ∈ [-HALF, HALF]，沿线段方向 ±ALONG_AVG 平均 */
function profileAt(gray, W, H, px, py, nx, ny) {
  const prof = [];
  for (let t = -HALF; t <= HALF; t++) {
    let s = 0, n = 0;
    for (let o = -ALONG_AVG; o <= ALONG_AVG; o += 2) {
      const v = bilinear(gray, W, H, px + nx * t - ny * o, py + ny * t + nx * o);
      if (v !== null) { s += v; n++; }
    }
    if (n === 0) return null;
    prof.push(s / n);
  }
  return prof;
}

function smooth3(a) {
  return a.map((_, i) => {
    let s = 0, n = 0;
    for (let o = -1; o <= 1; o++) { const j = i + o; if (j >= 0 && j < a.length) { s += a[j]; n++; } }
    return s / n;
  });
}

const median = (arr) => {
  const s = [...arr].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 单条剖面 → {depth, sigma, snr, fwhm, minT}；中心谷窗 [-25,25]，肩窗 [±28,±42] */
function profileMetrics(prof) {
  const sm = smooth3(prof);
  const N = sm.length;               // 2*HALF+1
  const idx = (t) => t + HALF;
  const shoulder = [];
  for (let t = -HALF; t <= -28; t++) shoulder.push(sm[idx(t)]);
  for (let t = 28; t <= HALF; t++) shoulder.push(sm[idx(t)]);
  const plateau = median(shoulder);
  const sigma = Math.sqrt(
    shoulder.reduce((acc, v) => acc + (v - plateau) ** 2, 0) / (shoulder.length - 1)
  );
  let minV = Infinity, minT = 0;
  for (let t = -25; t <= 25; t++) {
    if (sm[idx(t)] < minV) { minV = sm[idx(t)]; minT = t; }
  }
  const depth = plateau - minV;
  // FWHM：以 min 为中心向两侧找 depth/2 穿越（线性插值亚像素）
  const half = minV + depth / 2;
  const cross = (t0, dir) => {
    let prev = sm[idx(t0)];
    for (let t = t0 + dir; t >= -HALF && t <= HALF; t += dir) {
      const v = sm[idx(t)];
      if (v >= half) {
        const frac = (half - prev) / (v - prev || 1e-9);
        return Math.abs(t - frac * dir - t0);
      }
      prev = v;
    }
    return null; // 一侧未回到半高（谷贴边）
  };
  const wL = cross(minT, -1), wR = cross(minT, +1);
  const fwhm = wL !== null && wR !== null ? wL + wR : null;
  return { depth, sigma, snr: sigma > 0 ? depth / sigma : Infinity, fwhm, minT, plateau, minV };
}

/** 测量一条线段：3 个采样位（t=0.2/0.5/0.8）。
 * 段级聚合规则（v2，复核修订：显式声明并多规则对比，见报告 §1.3/§2.4）：
 *   逐位判据 P(s) = s.snr≥3 且 s.fwhm≥1 且 s.depth≥5（v2 起加深度下限，抑制超平坦面误检）
 *   R1 maxDepth（主规则）：取 depth 最大的采样位为代表，P(代表位) 即段判定 —— 首轮实验的隐藏规则，现声明
 *   R2 maxSNR：取 P 采样位中 SNR 最大者，P(该位) 即段判定
 *   R6 maxSNR(旧判据)：在旧判据（SNR≥3 且 FWHM≥1，无深度下限）采样位中取 SNR 最大者 —— 复核员设想的聚合方式
 *   R3 majority(旧判据)：≥2/3 位满足旧判据（复核员设想，供对比）
 *   R4 majorityStrict：≥2/3 位满足 P（含深度下限）
 *   R5 mixed（修订建议）：≥2/3 位满足 P，或任一位满足 P 且 (depth≥20 或 SNR≥10)
 * 主规则 R1 的代表位数值即报告 §2 各表所列；R2–R5 为敏感性分析。 */
const SAMPLE_OK = (s) => s.snr >= 3 && s.fwhm !== null && s.fwhm >= 1 && s.depth >= 5;

function measureSegment(gray, W, H, seg, mmPerPx = 0) {
  const [x1, y1] = seg.p1, [x2, y2] = seg.p2;
  const dx = x2 - x1, dy = y2 - y1;
  const L = Math.hypot(dx, dy);
  const ux = dx / L, uy = dy / L;
  const nx = -uy, ny = ux; // 法线（垂直于线段）
  const samples = SAMPLE_T.map((f) => {
    const px = x1 + dx * f, py = y1 + dy * f;
    const prof = profileAt(gray, W, H, px, py, nx, ny);
    if (!prof) return null;
    const m = profileMetrics(prof);
    return { t: f, at: [Math.round(px), Math.round(py)], ...m };
  });
  const valid = samples.filter(Boolean);
  const bestDepth = valid.reduce((a, b) => (b.depth > (a?.depth ?? -1) ? b : a), null);
  const okSamples = valid.filter(SAMPLE_OK);
  const bestSNR = okSamples.length ? okSamples.reduce((a, b) => (b.snr > a.snr ? b : a)) : null;
  const okOld = valid.filter((s) => s.snr >= 3 && s.fwhm !== null && s.fwhm >= 1);        // 不含深度下限
  const okNew = okSamples;                                                                // 含深度下限
  const bestSNROld = okOld.length ? okOld.reduce((a, b) => (b.snr > a.snr ? b : a)) : null;
  const agg = {
    R1: !!bestDepth && SAMPLE_OK(bestDepth),
    R2: !!bestSNR && SAMPLE_OK(bestSNR),
    R3: okOld.length >= 2,
    R4: okNew.length >= 2,
    R5: okNew.length >= 2 || (!!bestDepth && SAMPLE_OK(bestDepth) && (bestDepth.depth >= 20 || bestDepth.snr >= 10)),
    R6: !!bestSNROld, // maxSNR + 旧判据（SNR≥3&FWHM≥1，无深度下限）——复核员设想的聚合方式
  };
  const representative = bestDepth; // 主规则代表位
  return {
    ...seg, lenPx: +L.toFixed(0), lenMm: +(L * mmPerPx).toFixed(2),
    samples: valid, best: representative, agg,
    detected: agg.R1, // 主规则
  };
}

// ---------------------------------------------------------------- 8564 对照自动选点
// 淡紫两板整体各为单一零件，其内部任意平行于 V 交界的线均无边界；
// 唯一污染源是凸点/孔洞亮暗斑。因此在一个扫描网格上实测平坦度，
// 取每侧最平的 3 条（互不重叠的沿缝区间）作为对照，并如实报告扫描分布。
function autoControls8564(measure) {
  const base = { p1: [1815, 1580], p2: [2147, 1893] }; // V 交界全线
  const [bx1, by1] = base.p1, [bx2, by2] = base.p2;
  const bl = Math.hypot(bx2 - bx1, by2 - by1);
  const ux = (bx2 - bx1) / bl, uy = (by2 - by1) / bl;
  const nx = -uy, ny = ux;
  const cands = [];
  for (const side of [-1, +1]) {
    for (const off of [180, 220, 260, 300]) {
      for (const a0 of [40, 170, 300]) {
        const seg = {
          name: `scan${side > 0 ? '+' : '-'}${off}@${a0}`,
          p1: [bx1 + ux * a0 + side * off * nx, by1 + uy * a0 + side * off * ny],
          p2: [bx1 + ux * (a0 + 110) + side * off * nx, by1 + uy * (a0 + 110) + side * off * ny],
        };
        const r = measure(seg);
        if (r.samples.length === 3) {
          cands.push({ seg, maxDepth: Math.max(...r.samples.map((s) => s.depth)), meanDepth: r.samples.reduce((a, s) => a + s.depth, 0) / 3 });
        }
      }
    }
  }
  const picked = [];
  for (const side of [-1, +1]) {
    const pool = cands
      .filter((c) => (side > 0 ? c.seg.name.includes('+') : c.seg.name.includes('-')))
      .sort((a, b) => a.meanDepth - b.meanDepth);
    const usedRanges = [];
    for (const c of pool) {
      if (picked.filter((p) => p.side === side).length >= 3) break;
      const a0 = +c.seg.name.split('@')[1];
      if (usedRanges.some(([s, e]) => a0 < e + 20 && a0 + 110 > s - 20)) continue;
      usedRanges.push([a0, a0 + 110]);
      picked.push({ side, seg: c.seg, meanDepth: +c.meanDepth.toFixed(1) });
    }
  }
  return {
    controls: picked.map((p) => ({ name: `平板对照 ${p.seg.name}`, p1: p.seg.p1, p2: p.seg.p2 })),
    scanDistribution: cands.map((c) => ({ name: c.seg.name, meanDepth: +c.meanDepth.toFixed(1), maxDepth: +c.maxDepth.toFixed(1) })),
  };
}

// ---------------------------------------------------------------- 主流程
for (const ph of PHOTOS) {
  const path = `${PHOTO_DIR}/${ph.file}`;
  const { data, info } = await sharp(path).greyscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const measure = (seg) => measureSegment(data, W, H, seg, ph.mmPerPx);

  let controls = ph.controls;
  let scan8564 = null;
  if (controls === 'auto') {
    const auto = autoControls8564(measure);
    controls = auto.controls;
    scan8564 = auto.scanDistribution;
  }

  const seams = ph.seams.map(measure);
  const ctrls = controls.map(measure);

  const fmtBits = (s) => s.samples.map((x) =>
    `t${x.t}(d${x.depth.toFixed(1)},snr${x.snr.toFixed(1)},w${x.fwhm === null ? '-' : x.fwhm.toFixed(1)}${SAMPLE_OK(x) ? '✓' : ''})`
  ).join(' ');

  console.log(`\n================ ${ph.id} (${ph.file}) ================`);
  console.log(`mm/px = ${ph.mmPerPx}（锚点：${ph.anchor}）；候选段 ${seams.length}，对照段 ${ctrls.length}`);
  console.log('逐位判据 P = SNR≥3 且 FWHM≥1px 且 depth≥5；段级聚合 R1=maxDepth(主) R2=maxSNR R6=maxSNR(旧判据) R3=多数(旧判据) R4=多数(P) R5=混合，见文件头。');
  console.log('-- 缝隙候选 --');
  for (const s of seams) {
    const b = s.best;
    console.log(
      `  ${s.detected ? '✓' : '✗'} ${s.name.padEnd(14)} len=${String(s.lenPx).padStart(4)}px/${String(s.lenMm).padStart(5)}mm | ` +
      `代表位(depth最大): depth=${b ? b.depth.toFixed(1) : '-'} σ=${b ? b.sigma.toFixed(1) : '-'} SNR=${b ? b.snr.toFixed(1) : '-'} ` +
      `FWHM=${b && b.fwhm !== null ? b.fwhm.toFixed(1) : '-'}px | R1R2R6R3R4R5=${['R1', 'R2', 'R6', 'R3', 'R4', 'R5'].map((r) => (s.agg[r] ? 1 : 0)).join('')}\n` +
      `      逐位: ${fmtBits(s)}`
    );
  }
  console.log('-- 对照 --');
  for (const s of ctrls) {
    const b = s.best;
    console.log(
      `  ${s.detected ? '✗误检' : '✓'} ${s.name.padEnd(18)} len=${String(s.lenPx).padStart(4)}px | ` +
      `代表位: depth=${b ? b.depth.toFixed(1) : '-'} σ=${b ? b.sigma.toFixed(1) : '-'} SNR=${b ? b.snr.toFixed(1) : '-'} ` +
      `FWHM=${b && b.fwhm !== null ? b.fwhm.toFixed(1) : '-'} | R1R2R6R3R4R5=${['R1', 'R2', 'R6', 'R3', 'R4', 'R5'].map((r) => (s.agg[r] ? 1 : 0)).join('')}\n` +
      `      逐位: ${fmtBits(s)}`
    );
  }
  const rules = ['R1', 'R2', 'R6', 'R3', 'R4', 'R5'];
  const perRule = Object.fromEntries(rules.map((r) => [
    r,
    { det: seams.filter((s) => s.agg[r]).length, fp: ctrls.filter((s) => s.agg[r]).length },
  ]));
  console.log('-- 聚合规则对比（检出/候选，误检/对照）--');
  console.log(rules.map((r) => `${r}:${perRule[r].det}/${seams.length},误检${perRule[r].fp}/${ctrls.length}`).join('  '));
  const detSeams = seams.filter((s) => s.detected);
  const fwhmPx = detSeams.map((s) => s.best.fwhm).filter((f) => f !== null);
  const fwhmMean = fwhmPx.length ? fwhmPx.reduce((a, b) => a + b, 0) / fwhmPx.length : 0;
  const snrs = detSeams.map((s) => s.best.snr);
  console.log(
    `>> 主规则R1 可检出率 ${detSeams.length}/${seams.length} = ${((detSeams.length / seams.length) * 100).toFixed(0)}%；` +
    `误检率 ${ctrls.filter((s) => s.detected).length}/${ctrls.length}`
  );
  if (fwhmPx.length) {
    console.log(
      `>> 检出缝 FWHM 均值 ${fwhmMean.toFixed(1)}px = ${(fwhmMean * ph.mmPerPx).toFixed(2)}mm ` +
      `→ rectify(1凸点=80px, 1mm=10px) 后 ≈ ${(fwhmMean * ph.mmPerPx * 10).toFixed(1)}px；` +
      `SNR 中位 ${median(snrs).toFixed(1)}`
    );
  }
  if (scan8564) {
    console.log('-- 8564 对照平坦度扫描（全部候选，meanDepth 越小越平）--');
    console.log(scan8564.map((c) => `${c.name}:${c.meanDepth}`).join('  '));
  }
  ph._result = {
    detRate: detSeams.length / seams.length, fpRate: ctrls.filter((s) => s.detected).length / ctrls.length,
    seams: seams.length, ctrls: ctrls.length, fwhmMean, fwhmMm: fwhmMean * ph.mmPerPx,
    perRule: Object.fromEntries(rules.map((r) => [r, perRule[r]])),
  };
}

console.log('\n================ 汇总（主规则 R1 = max-depth 代表位） ================');
let S = 0, SD = 0, C = 0, CD = 0;
for (const ph of PHOTOS) {
  const r = ph._result;
  S += r.seams; SD += r.detRate * r.seams; C += r.ctrls; CD += r.fpRate * r.ctrls;
  console.log(
    `${ph.id.padEnd(22)} 候选 ${r.seams} 可检出 ${(r.detRate * 100).toFixed(0)}% | 对照 ${r.ctrls} 误检 ${(r.fpRate * 100).toFixed(0)}% | ` +
    `mm/px ${ph.mmPerPx} | 检出缝宽均值 ${r.fwhmMm.toFixed(2)}mm`
  );
}
console.log(`总计（R1）：候选 ${S} 段，可检出 ${SD.toFixed(0)} 段（${((SD / S) * 100).toFixed(0)}%）；对照 ${C} 段，误检 ${CD.toFixed(0)} 段（${((CD / C) * 100).toFixed(0)}%）`);

console.log('\n================ 段级聚合规则敏感性（候选检出数/21 与 对照误检数/18） ================');
const RULE_NAMES = {
  R1: 'maxDepth代表位（主，SNR≥3&FWHM≥1&depth≥5）',
  R2: 'maxSNR位（SNR≥3&FWHM≥1&depth≥5）',
  R6: 'maxSNR位（旧判据 SNR≥3&FWHM≥1，无深度下限）',
  R3: '≥2/3位 SNR≥3&FWHM≥1（无深度下限，复核员设想）',
  R4: '≥2/3位 SNR≥3&FWHM≥1&depth≥5',
  R5: '混合：≥2/3位 或 单位满足且(depth≥20或SNR≥10)',
};
for (const r of ['R1', 'R2', 'R6', 'R3', 'R4', 'R5']) {
  let det = 0, fp = 0, detSeamsN = 0, ctrlsN = 0;
  for (const ph of PHOTOS) {
    det += ph._result.perRule[r].det; fp += ph._result.perRule[r].fp;
    detSeamsN += ph._result.seams; ctrlsN += ph._result.ctrls;
  }
  console.log(`${r} ${RULE_NAMES[r].padEnd(30)} 检出 ${det}/${detSeamsN}（${((det / detSeamsN) * 100).toFixed(0)}%）  误检 ${fp}/${ctrlsN}（${((fp / ctrlsN) * 100).toFixed(0)}%）`);
}
