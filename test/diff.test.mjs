import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rgbaToLab,
  floodFillBackground,
  floodFillNearWhite,
  nearWhiteMap,
  extractPhotoMask,
  extractManualMask,
  extractRenderMask,
  maskCentroid,
  maskBBox,
  maskAspect,
  aspectSim,
  shiftedIoU,
  rgbHistogram,
  cosineSim,
  scorePair,
  colorClass,
  colorClassImage,
  gridStructureSim,
  weightedCircularMedian,
  jointScore,
  MANUAL_EL_FROM,
  MANUAL_EL_TO,
  MANUAL_EL_STEP,
} from '../src/core/diff.js';

// ------------------------------------------------------------------ 合成图片工具
const IMG = 512, SIDE = 256;   // 合成图直接用工作分辨率生成，避免缩放插值污染掩膜边缘

/** 造一张 w×h RGBA 原始图（全透明背景），返回 { data, w, h } */
function blank(w, h) {
  return { data: new Uint8Array(w * h * 4), w, h };
}

/** 在原始图上填充矩形（含透明度） */
function fillRect(img, x0, y0, rw, rh, [r, g, b, a = 255]) {
  for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) {
    const o = (y * img.w + x) * 4;
    img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = a;
  }
  return img;
}

/** 用 sharp 把 RGBA 原始数组编成 PNG Buffer */
async function toPng(img) {
  const { default: sharp } = await import('sharp');
  return sharp(Buffer.from(img.data.buffer, img.byteOffset, img.data.length), { raw: { width: img.w, height: img.h, channels: 4 } }).png().toBuffer();
}

/** 实拍风格合成图：浅灰均匀背景 + 不透明彩色方块（背景占比 75%，落在 15%–85% 合理区间） */
function photoLike(x0 = IMG / 4, y0 = IMG / 4, side = SIDE, rgb = [200, 30, 30]) {
  const img = blank(IMG, IMG);
  fillRect(img, 0, 0, IMG, IMG, [232, 232, 232, 255]);
  fillRect(img, x0, y0, side, side, [...rgb, 255]);
  return img;
}

/** 渲染风格合成图：全透明背景 + 不透明彩色方块 */
function renderLike(x0 = IMG / 4, y0 = IMG / 4, side = SIDE, rgb = [200, 30, 30]) {
  const img = blank(IMG, IMG);
  fillRect(img, x0, y0, side, side, [...rgb, 255]);
  return img;
}

// ------------------------------------------------------------------ 纯函数：IoU 与质心
test('shiftedIoU：相同掩膜 IoU=1、部分重叠可手算、不相交为 0、平移对齐后恢复 1', () => {
  const w = 16, h = 16;
  const a = new Uint8Array(w * h), b = new Uint8Array(w * h);
  for (let y = 2; y < 6; y++) for (let x = 2; x < 6; x++) a[y * w + x] = 1;         // 4×4 方块 @ (2,2)
  for (let y = 2; y < 6; y++) for (let x = 8; x < 12; x++) b[y * w + x] = 1;        // 4×4 方块 @ (8,2)

  const same = new Uint8Array(a);
  assert.equal(shiftedIoU(a, same, w, h, 0, 0), 1);

  // b 在 a 右侧 6 像素：把 b 向左平移（dx=-6）后完全重合；用 a 为基准反向平移（dx=+6）同样恢复
  assert.equal(shiftedIoU(a, b, w, h, -6, 0), 1);
  assert.equal(shiftedIoU(b, a, w, h, 6, 0), 1);

  // 不对齐：交集 0
  assert.equal(shiftedIoU(a, b, w, h, 0, 0), 0);

  // 部分重叠：a @ (2,2) 4×4 与 c @ (4,4) 4×4 交集 2×2=4，并集 16+16-4=28
  const c = new Uint8Array(w * h);
  for (let y = 4; y < 8; y++) for (let x = 4; x < 8; x++) c[y * w + x] = 1;
  assert.ok(Math.abs(shiftedIoU(a, c, w, h, 0, 0) - 4 / 28) < 1e-12);

  // 空掩膜
  assert.equal(shiftedIoU(a, new Uint8Array(w * h), w, h, 0, 0), 0);
});

test('maskCentroid / maskBBox / maskAspect / aspectSim：几何纯函数', () => {
  const w = 16, h = 16, m = new Uint8Array(w * h);
  for (let y = 4; y < 8; y++) for (let x = 2; x < 10; x++) m[y * w + x] = 1;   // 8×4 矩形 @ (2,4)

  const c = maskCentroid(m, w, h);
  assert.equal(c.count, 32);
  assert.ok(Math.abs(c.x - 5.5) < 1e-12);   // x 2..9 → 均值 5.5
  assert.ok(Math.abs(c.y - 5.5) < 1e-12);

  assert.deepEqual(maskBBox(m, w, h), { minX: 2, minY: 4, maxX: 9, maxY: 7 });
  assert.equal(maskAspect(m, w, h), 2);      // 8 / 4
  assert.equal(maskCentroid(new Uint8Array(w * h), w, h), null);
  assert.equal(maskAspect(new Uint8Array(w * h), w, h), null);

  assert.equal(aspectSim(2, 2), 1);
  assert.equal(aspectSim(4, 1), 0.25);      // 宽矩形 vs 正方形
  assert.equal(aspectSim(4, 0.25), 0.0625); // 宽矩形 vs 高矩形
  assert.equal(aspectSim(0, 1), 0);
});

test('rgbHistogram + cosineSim：同色为 1、无共同色阶为 0', () => {
  const w = 8, h = 8, mask = new Uint8Array(w * h).fill(1);
  const red = new Uint8Array(w * h * 4);
  const blue = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { red[i * 4] = 200; red[i * 4 + 1] = 30; red[i * 4 + 2] = 30; red[i * 4 + 3] = 255;
    blue[i * 4] = 30; blue[i * 4 + 1] = 60; blue[i * 4 + 2] = 200; blue[i * 4 + 3] = 255; }

  const hr = rgbHistogram(red, w, h, mask);
  assert.equal(cosineSim(hr, hr), 1);
  assert.equal(cosineSim(hr, rgbHistogram(blue, w, h, mask)), 0);   // 红 (3,0,0) 桶 vs 蓝 (0,0,3) 桶，无交集
  assert.equal(cosineSim(hr, null), 0);

  // 掩膜外像素不计入：只有 1 个前景像素时直方图集中在一个桶
  const one = new Uint8Array(w * h);
  one[0] = 1;
  const h1 = rgbHistogram(red, w, h, one);
  let sum = 0, bins = 0;
  for (const v of h1) { sum += v; if (v > 0) bins++; }
  assert.ok(Math.abs(sum - 1) < 1e-12);
  assert.equal(bins, 1);
  assert.equal(rgbHistogram(red, w, h, new Uint8Array(w * h)), null);
});

// ------------------------------------------------------------------ flood-fill 背景
test('rgbaToLab：sRGB→CIELAB 换算正确，负色度保留（回归：sharp 8-bit Lab 把负 a/b 截断为 0）', () => {
  const px = (r, g, b) => rgbaToLab(new Uint8Array([r, g, b, 255]), 1);
  const near = (got, exp) => got.forEach((v, i) => assert.ok(Math.abs(v - exp[i]) < 0.6, `通道 ${i}：${v.toFixed(2)} 应≈${exp[i]}`));
  near(px(255, 0, 0), [53.24, 80.09, 67.2]);    // 红：a/b 均为正
  near(px(0, 255, 0), [87.73, -86.18, 83.18]);   // 绿：a 为负（−86），旧实现截断为 0
  near(px(0, 0, 255), [32.3, 79.2, -107.86]);    // 蓝：b 为负（−108），旧实现截断为 0
  near(px(232, 232, 232), [91.96, 0, 0]);        // 近中性灰背景
});

test('floodFillBackground：均匀背景被四边吸收，色差大的前景块保留（含负色度），容差内的渐变被并入', () => {
  const w = 6, h = 6;
  const lab = new Float64Array(w * h * 3);
  const px = (i, L, a, b) => { lab[i * 3] = L; lab[i * 3 + 1] = a; lab[i * 3 + 2] = b; };
  for (let i = 0; i < w * h; i++) px(i, 92, 0, 0);   // 中灰背景 Lab(92, 0, 0)
  px(14, 53, 80, 67);   // 中心 2×2 红色前景（i=14,15,20,21）
  px(15, 53, 80, 67);
  px(20, 53, 80, 67);
  px(21, 53, 80, 67);
  px(8, 84, -40, -28);   // 绿系前景像素：负色度，ΔE ≈ 51 > 18，必须保留（旧实现会把 a/b 截断后误并入背景）
  px(9, 96, 4, 3);       // ΔE ≈ 7 ≤ 18 的渐变像素，应并入背景

  const bg = floodFillBackground(lab, w, h, 18);
  const fg = [];
  for (let i = 0; i < w * h; i++) if (!bg[i]) fg.push(i);
  assert.deepEqual(fg, [8, 14, 15, 20, 21]);
  assert.equal(bg[9], 1);
});

// ------------------------------------------------------------------ 合成 PNG 端到端
test('scorePair：同图得满分、score 符合 0.5*iou + 0.2*aspect + 0.3*color 公式', async () => {
  const photo = await toPng(photoLike());
  const render = await toPng(photoLike());
  const r = await scorePair(photo, render);
  assert.ok(Math.abs(r.silhouetteIoU - 1) < 1e-9);
  assert.ok(Math.abs(r.bboxAspectSim - 1) < 1e-9);
  assert.ok(Math.abs(r.colorSim - 1) < 1e-9);
  assert.ok(Math.abs(r.score - 1) < 1e-9);
});

test('scorePair：偏移方块经质心对齐恢复 IoU=1，不对齐时 IoU 明显更低', async () => {
  const photo = await toPng(photoLike(128, 128));   // 方块 @ (128,128)，中心 (255.5, 255.5)
  const render = await toPng(renderLike(0, 64));    // 方块 @ (0,64)，中心 (127.5, 191.5) → 质心差 (128, 64)
  const r = await scorePair(photo, render);
  assert.ok(Math.abs(r.silhouetteIoU - 1) < 1e-9);

  // 不对齐的原始 IoU：交集 128×192=24576，并集 256²+256²-24576=106496
  const w = IMG, h = IMG, ma = new Uint8Array(w * h), mb = new Uint8Array(w * h);
  for (let y = 128; y < 384; y++) for (let x = 128; x < 384; x++) ma[y * w + x] = 1;
  for (let y = 64; y < 320; y++) for (let x = 0; x < 256; x++) mb[y * w + x] = 1;
  assert.ok(Math.abs(shiftedIoU(ma, mb, w, h, 0, 0) - 24576 / 106496) < 1e-12);
});

test('scorePair：同形不同占幅（拍摄距离差异）经面积比尺度归一 IoU≈1', async () => {
  const photo = await toPng(photoLike(128, 128, SIDE));       // 256×256 方块
  const render = await toPng(renderLike(192, 192, SIDE / 2)); // 128×128 方块：面积 1/4，位置不同
  const r = await scorePair(photo, render);
  assert.ok(Math.abs(r.scale - 2) < 1e-9, `scale 应为 2，实际 ${r.scale}`);
  // 最近邻缩放有一像素级损失，IoU ≈ 255²/256²
  assert.ok(r.silhouetteIoU > 0.98, `归一后 IoU 应≈1，实际 ${r.silhouetteIoU}`);
  assert.ok(r.silhouetteIoURaw < 0.35, `未归一 IoU 应显著更低，实际 ${r.silhouetteIoURaw}`);
});

test('scorePair：同形不同色 → IoU=1、colorSim≈0、score=0.7', async () => {
  const photo = await toPng(photoLike(128, 128, SIDE, [200, 30, 30]));
  const render = await toPng(renderLike(128, 128, SIDE, [30, 60, 200]));
  const r = await scorePair(photo, render);
  assert.ok(Math.abs(r.silhouetteIoU - 1) < 1e-9);
  assert.ok(r.colorSim < 0.1);
  assert.ok(Math.abs(r.score - 0.7) < 1e-9);
});

test('extractPhotoMask：均匀背景下前景占比准确、边界吸收充分、不降级', async () => {
  const m = await extractPhotoMask(await toPng(photoLike()));
  const fg = m.mask.reduce((a, v) => a + v, 0);
  assert.ok(Math.abs(fg / m.mask.length - 0.25) < 0.02);   // 32×32 方块占 64×64 的 25%
  assert.equal(m.degraded, false);
  assert.ok(m.maskConfidence > 0.99);   // 四条边全部被吸收
  assert.equal(m.tol, 18);              // 首轮容差即满足“边界饱和且未吞模型”
});

test('extractPhotoMask：淡绿前景（色差主要落在负 a 轴）不再被整块吞进背景（回归：8-bit Lab 截断 bug）', async () => {
  // 灰背景 + 淡绿方块 (196,232,192)：真实 ΔE≈24 > 18 应存活；旧实现把 a≈−18 截断为 0 后
  // ΔE 只剩 ≈6，方块被 flood-fill 吞掉 → bgRatio=1.0 → 误降级为椭圆窗
  const m = await extractPhotoMask(await toPng(photoLike(128, 128, SIDE, [196, 232, 192])));
  assert.equal(m.degraded, false);
  const fg = m.mask.reduce((a, v) => a + v, 0);
  assert.ok(Math.abs(fg / m.mask.length - 0.25) < 0.02, `前景占比 ${fg / m.mask.length} 应≈0.25`);
});

test('extractPhotoMask：噪声背景吸收不足 → 退回中心椭圆窗并标 degraded', async () => {
  // 伪随机灰噪声背景（确定性种子），中央放红色方块
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const img = blank(IMG, IMG);
  for (let i = 0; i < IMG * IMG; i++) {   // 三通道独立随机：相邻像素色差稳定超出最大容差
    img.data[i * 4] = Math.floor(rnd() * 256);
    img.data[i * 4 + 1] = Math.floor(rnd() * 256);
    img.data[i * 4 + 2] = Math.floor(rnd() * 256);
    img.data[i * 4 + 3] = 255;
  }
  fillRect(img, 192, 192, 128, 128, [200, 30, 30, 255]);
  const m = await extractPhotoMask(await toPng(img));
  assert.equal(m.degraded, true);
  const fg = m.mask.reduce((a, v) => a + v, 0);
  assert.ok(Math.abs(fg / m.mask.length - Math.PI * 0.42 ** 2) < 0.02);   // 椭圆窗面积占比
});

test('extractRenderMask：渲染图 90° 旋转等价于相机滚转，掩膜长宽比互换（躺倒/直立姿态对齐的基础）', async () => {
  const img = blank(IMG, IMG);
  fillRect(img, 128, 192, 256, 128, [30, 90, 200, 255]);   // 宽 256 × 高 128 的矩形前景
  const buf = await toPng(img);
  const m0 = await extractRenderMask(buf);
  const { default: sharp } = await import('sharp');
  const rot = await sharp(buf).rotate(90).png().toBuffer();
  const m1 = await extractRenderMask(rot);
  const a0 = maskAspect(m0.mask, m0.w, m0.h), a1 = maskAspect(m1.mask, m1.w, m1.h);
  assert.ok(Math.abs(a0 - 2) < 0.05, `原掩膜长宽比应≈2，实际 ${a0}`);
  assert.ok(Math.abs(a1 - 0.5) < 0.05, `旋转 90° 后应≈0.5，实际 ${a1}`);
});

test('extractRenderMask：alpha>8 即前景；全不透明时退回 flood-fill 并标 degraded', async () => {
  const m = await extractRenderMask(await toPng(renderLike()));
  const fg = m.mask.reduce((a, v) => a + v, 0);
  assert.ok(Math.abs(fg / m.mask.length - 0.25) < 0.02);
  assert.equal(m.degraded, false);
  assert.equal(m.maskConfidence, 1);

  // 无 alpha 信息（全 255）→ 走 flood-fill 保底
  const opaque = await toPng(photoLike());
  const m2 = await extractRenderMask(opaque);
  assert.equal(m2.degraded, true);
  assert.ok(Math.abs(m2.mask.reduce((a, v) => a + v, 0) / m2.mask.length - 0.25) < 0.02);
});

// ------------------------------------------------------------------ 粗色类 colorClass
test('colorClass：深红并入红、深蓝并入蓝、粉/紫可区分、灰阶按明度分（Lab 色相分区）', () => {
  assert.equal(colorClass(201, 26, 9), '红');
  assert.equal(colorClass(114, 0, 18), '红');        // 深红与红同类
  assert.equal(colorClass(0, 85, 191), '蓝');
  assert.equal(colorClass(10, 52, 99), '蓝');        // 深蓝与蓝同类
  assert.equal(colorClass(250, 200, 10), '橙黄');    // 黄并入橙黄
  assert.equal(colorClass(254, 138, 24), '橙黄');    // 橙
  assert.equal(colorClass(95, 49, 9), '橙黄');       // 棕并入橙黄（深橙黄）
  assert.equal(colorClass(0, 133, 43), '绿');
  assert.equal(colorClass(0, 69, 26), '绿');
  // 灯笼关键区分项：淡紫板 ≠ 粉件
  assert.equal(colorClass(255, 158, 205), '粉');     // 亮粉
  assert.equal(colorClass(211, 53, 157), '粉');      // 深粉
  assert.equal(colorClass(205, 164, 222), '紫');     // 淡紫
  assert.equal(colorClass(129, 0, 123), '紫');       // 深紫
  assert.notEqual(colorClass(205, 164, 222), colorClass(255, 158, 205));   // 紫/粉必须不同类
  // 灰阶按明度分：黑/灰/白
  assert.equal(colorClass(20, 20, 20), '黑');
  assert.equal(colorClass(128, 128, 128), '灰');
  assert.equal(colorClass(244, 244, 244), '白');
  // colorClassImage 批量版与单像素版一致（索引：红=3、蓝=6）
  const idx = colorClassImage(new Uint8Array([201, 26, 9, 255, 0, 0, 255, 255]), 2);
  assert.equal(idx.length, 2);
  assert.equal(idx[0], 3);
  assert.equal(idx[1], 6);
});

// ------------------------------------------------------------------ 色块结构相似度
/** 256×256 双色横带方块（上半/下半各一色），swap=true 时上下互换；红=3、蓝=6（COLOR_CLASS 索引） */
function bandedFig(swap = false) {
  const w = 256, h = 256, mask = new Uint8Array(w * h), classes = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    mask[i] = 1;
    classes[i] = (y < 128) === !swap ? 3 : 6;   // 未互换：上红下蓝；互换：上蓝下红
  }
  return { mask, classes, w, h };
}

test('gridStructureSim：同布局=1、红蓝横带互换=0（纯函数，网格边界与色带边界对齐）', () => {
  const a = bandedFig();
  assert.equal(gridStructureSim(a, bandedFig(false)), 1);   // 同布局：全部非空格众数色类一致
  assert.equal(gridStructureSim(a, bandedFig(true)), 0);    // 横带互换：每一格众数色类都不同
});

test('gridStructureSim：双空格不计入分母、单侧空格记不匹配（十字交叉精确手算 16/112）', () => {
  // 等面积竖条 A（x 12..19）与横条 B（y 12..19），质心重合、scale=1，无平移。
  // 16×16 网格（2×2 像素/格）：仅 A 48 格 + 仅 B 48 格 = 不匹配，交叠 4×4=16 格同色匹配，
  // 四角 12×12=144 格双空不计 → sim = 16/112
  const w = 32, h = 32;
  const bar = (vertical) => {
    const mask = new Uint8Array(w * h), classes = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const hit = vertical ? (x >= 12 && x < 20) : (y >= 12 && y < 20);
      if (hit) { mask[y * w + x] = 1; classes[y * w + x] = 3; }
    }
    return { mask, classes, w, h };
  };
  const sim = gridStructureSim(bar(true), bar(false));
  assert.ok(Math.abs(sim - 16 / 112) < 1e-12, `十字交叉 sim 应为 16/112≈0.1429，实际 ${sim}`);
});

test('区分力对照：同轮廓不同内部色带 —— silhouetteIoU 均为 1（旧指标盲区），structureSim 拉开差距', async () => {
  // 实拍风格：灰底 + 上红下蓝横带方块；渲染风格：透明底 + 同轮廓方块
  const banded = (photoStyle, swap) => {
    const img = blank(IMG, IMG);
    if (photoStyle) fillRect(img, 0, 0, IMG, IMG, [232, 232, 232, 255]);   // 灰色拍摄背景
    fillRect(img, 128, 128, SIDE, SIDE / 2, swap ? [30, 60, 200, 255] : [200, 30, 30, 255]);   // 上半
    fillRect(img, 128, 128 + SIDE / 2, SIDE, SIDE / 2, swap ? [200, 30, 30, 255] : [30, 60, 200, 255]);   // 下半
    return img;
  };
  const photo = await toPng(banded(true, false));
  const sameLayout = await scorePair(photo, await toPng(banded(false, false)));
  const swapped = await scorePair(photo, await toPng(banded(false, true)));

  // 旧指标盲区：三张图轮廓完全一致，IoU/长宽比/颜色总量（红蓝各半）分不出互换
  assert.ok(Math.abs(sameLayout.silhouetteIoU - 1) < 1e-9);
  assert.ok(Math.abs(swapped.silhouetteIoU - 1) < 1e-9);
  assert.ok(Math.abs(swapped.colorSim - sameLayout.colorSim) < 1e-9);   // 颜色直方图对空间互换不敏感
  // 新指标看见内部结构：同布局 ≈1，互换显著更低
  assert.ok(sameLayout.structureSim > 0.95, `同布局 structureSim=${sameLayout.structureSim}`);
  assert.ok(swapped.structureSim < sameLayout.structureSim - 0.5, `互换 structureSim=${swapped.structureSim} 应显著低于 ${sameLayout.structureSim}`);
  // 联合总分随之拉开（0.20 权重差）
  assert.ok(swapped.jointScore < sameLayout.jointScore - 0.15, `jointScore：互换 ${swapped.jointScore} vs 同布局 ${sameLayout.jointScore}`);
});

test('jointScore：权重和为 1，全 1 度量得满分', () => {
  assert.ok(Math.abs(jointScore({ silhouetteIoU: 1, bboxAspectSim: 1, colorSim: 1, structureSim: 1, silhouetteIoURaw: 1 }) - 1) < 1e-12);
  assert.ok(Math.abs(jointScore({ silhouetteIoU: 0.8, bboxAspectSim: 1, colorSim: 0.5, structureSim: 0.25, silhouetteIoURaw: 0.4 })
    - (0.35 * 0.8 + 0.15 * 1 + 0.2 * 0.5 + 0.2 * 0.25 + 0.1 * 0.4)) < 1e-12);
  assert.ok(Math.abs(0.35 + 0.15 + 0.2 + 0.2 + 0.1 - 1) < 1e-12);   // 权重常数之和 = 1
});

// ------------------------------------------------------------------ joint 全局 yaw 偏移估计
test('weightedCircularMedian：合成 4 组方位角偏移的 Δ 估计（抗离群、跨 0° 环绕、退化输入）', () => {
  const cd = (x, y) => { const d = Math.abs(x - y) % 360; return Math.min(d, 360 - d); };
  // 4 组偏移：主体 +10/+12/+14（分数高、权重大），一组 200° 离群（低分）→ Δ≈12，不被离群拉走
  const d1 = weightedCircularMedian([
    { delta: 10, weight: 0.9 }, { delta: 12, weight: 0.8 }, { delta: 14, weight: 0.85 }, { delta: 200, weight: 0.3 },
  ]);
  assert.ok(cd(d1, 12) <= 1, `Δ=${d1} 应落在簇中心 12° 附近`);
  // 4 组跨 0° 环绕偏移 [350,356,4,10]：真簇在 0° 附近；线性中位数会错排到 180° 背面
  const d2 = weightedCircularMedian([
    { delta: 350, weight: 0.7 }, { delta: 356, weight: 0.8 }, { delta: 4, weight: 0.75 }, { delta: 10, weight: 0.6 },
  ]);
  assert.ok(cd(d2, 0) <= 10, `Δ=${d2} 应在 0° 附近（短弧内）`);
  assert.ok(cd(d2, 180) > 90, `Δ=${d2} 不应落到背面 180°`);
  // 退化输入：单样本原样返回（规范角），空/无有效样本返回 0
  assert.equal(weightedCircularMedian([{ delta: 350, weight: 1 }]), 350);
  assert.equal(weightedCircularMedian([{ delta: -10, weight: 1 }]), 350);   // 负角规范化
  assert.equal(weightedCircularMedian([]), 0);
  assert.equal(weightedCircularMedian([{ delta: 10, weight: 0 }]), 0);      // 零权样本视为无效
});

// ------------------------------------------------------------------ 说明书页（kind:'manual'）
/** 说明书页风格合成图：纯白(255)不透明背景 + 不透明彩色方块 */
function manualLike(x0 = IMG / 4, y0 = IMG / 4, side = SIDE, rgb = [200, 30, 30]) {
  const img = blank(IMG, IMG);
  fillRect(img, 0, 0, IMG, IMG, [255, 255, 255, 255]);
  fillRect(img, x0, y0, side, side, [...rgb, 255]);
  return img;
}

test('nearWhiteMap：纯白与 #F4F4F4 判白、232 灰与有彩色判非白（阈值 L≥95 且 |a|,|b|≤4）', () => {
  const px = (r, g, b) => rgbaToLab(new Uint8Array([r, g, b, 255]), 1);
  const mk = (list) => {
    const rgba = new Uint8Array(list.length * 4);
    list.forEach(([r, g, b], i) => { rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255; });
    return nearWhiteMap(rgbaToLab(rgba, list.length), list.length);
  };
  const got = mk([[255, 255, 255], [244, 244, 244], [232, 232, 232], [200, 30, 30], [0, 133, 43], [250, 250, 248], [240, 240, 250]]);
  assert.deepEqual([...got], [1, 1, 0, 0, 0, 1, 0]);   // 页底白/米白=1；灰背景、红绿零件、偏蓝(240,240,250 |b|>4)=0
});

test('floodFillNearWhite：四边连通近白算背景，孤立近白洞（白零件）保留为前景', () => {
  const w = 10, h = 10;
  const white = new Uint8Array(w * h).fill(1);
  for (let y = 3; y <= 6; y++) for (let x = 3; x <= 6; x++) white[y * w + x] = 0;   // 3..6 有色方块
  for (let y = 4; y <= 5; y++) for (let x = 4; x <= 5; x++) white[y * w + x] = 1;   // 方块内部 2×2 白零件
  const { bg, count } = floodFillNearWhite(white, w, h);
  assert.equal(count, w * h - 16);                       // 背景 = 全部近白减 4 个孤立洞
  assert.equal(bg[0], 1);
  for (let y = 4; y <= 5; y++) for (let x = 4; x <= 5; x++) assert.equal(bg[y * w + x], 0, '孤立白洞不得算背景');
});

test('extractManualMask：白底前景占比准确、不标 degraded；内部白色零件（被彩色包围的白）不误并入背景', async () => {
  const img = manualLike();
  fillRect(img, 192, 192, 64, 64, [255, 255, 255, 255]);   // 红色方块(128..384)中心的 64×64 白零件：与页底不连通
  const m = await extractManualMask(await toPng(img));
  assert.equal(m.manual, true);
  assert.equal(m.degraded, false);
  const fg = m.mask.reduce((a, v) => a + v, 0);
  const expect = (256 * 256 - 0) / (IMG * IMG);   // 256×256 红块含内嵌白零件都应是前景
  assert.ok(Math.abs(fg / m.mask.length - expect) < 0.01, `前景占比 ${fg / m.mask.length} 应≈${expect}`);
  assert.equal(m.mask[192 * m.w + 192], 1);   // 白零件像素是前景
  assert.equal(m.mask[0], 0);                 // 页底是背景
});

test('extractManualMask：非白底（灰底噪声）白底假设不成立 → 退回容差扫描取最优，仍跳过椭圆保底、不标 degraded', async () => {
  // 与实拍 degraded 用例同一张噪声背景图：extractPhotoMask 会椭圆保底 + degraded:true
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const img = blank(IMG, IMG);
  for (let i = 0; i < IMG * IMG; i++) {
    img.data[i * 4] = Math.floor(rnd() * 256);
    img.data[i * 4 + 1] = Math.floor(rnd() * 256);
    img.data[i * 4 + 2] = Math.floor(rnd() * 256);
    img.data[i * 4 + 3] = 255;
  }
  fillRect(img, 192, 192, 128, 128, [200, 30, 30, 255]);
  const buf = await toPng(img);
  const p = await extractPhotoMask(buf);
  assert.equal(p.degraded, true);                 // 旧口径：照片通道判不可信，椭圆保底
  const m = await extractManualMask(buf);
  assert.equal(m.manual, true);
  assert.equal(m.whiteFallback, true);            // 走的是容差扫描兜底
  assert.equal(m.degraded, false);                // 但说明书页不标 degraded、不降权
  const fg = m.mask.reduce((a, v) => a + v, 0);
  assert.ok(Math.abs(fg / m.mask.length - Math.PI * 0.42 ** 2) > 0.02, '兜底掩膜不应等于椭圆窗');
});

test('scorePair(kind:manual)：白底同图满分；红块 vs 蓝块 → IoU=1、colorSim≈0（与照片口径同样的可分性）', async () => {
  const a = await toPng(manualLike());
  const r1 = await scorePair(a, a, { kind: 'manual' });
  assert.ok(Math.abs(r1.silhouetteIoU - 1) < 1e-9);
  assert.ok(Math.abs(r1.jointScore - 1) < 1e-9, `jointScore=${r1.jointScore}`);
  const b = await toPng(manualLike(IMG / 4, IMG / 4, SIDE, [30, 60, 200]));
  const r2 = await scorePair(a, b, { kind: 'manual' });
  assert.ok(Math.abs(r2.silhouetteIoU - 1) < 1e-9);
  assert.ok(r2.colorSim < 0.1);
});

test('manual elevation 扫描常量：默认 5..40 步 5', () => {
  assert.equal(MANUAL_EL_FROM, 5);
  assert.equal(MANUAL_EL_TO, 40);
  assert.equal(MANUAL_EL_STEP, 5);
});

// ------------------------------------------------------------------ 合成说明书页真值自测（IoU ≥ 0.90）
/** 用 @napi-rs/canvas 画一张「说明书页风格」合成图，同时返回它对应的真值掩膜。
 *  版式（与真实官方说明书一致的结构元素，但不依赖任何真实照片）：
 *    - 彩色统一页底（pageBg）；
 *    - 一块实心矩形 + 一对「零件状色块」（带凸点缺口的矩形组合），这三块是真值前景；
 *    - 一个 BOM 蓝框（#B2D7F3 填充 + 深色描边，左上角的零件清单面板）；
 *    - 一个黄 callout 框（#FFCC01 填充，右下角的放大标注）；
 *    - 一条贯穿上下的竖直分割线（灰）——它必须被剥掉；
 *    - 右下角页码文字（深灰数字）——它也必须被剥掉。
 *  真值掩膜只含三块零件形状（不含页底、BOM 框、callout 框、分割线、页码）。
 *  返回 { png, gt, w, h, shapes }。 */
async function syntheticManualPage({ pageBg, label }) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const W = 768, H = 512;
  const cv = createCanvas(W, H);
  const ctx = cv.getContext('2d');
  const hex = (rgb) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  ctx.fillStyle = hex(pageBg);
  ctx.fillRect(0, 0, W, H);

  // 真值形状：实心矩形 + 一对零件状色块（两个错位矩形拼成一个“凸点砖”轮廓）
  const shapes = [
    { x: 300, y: 130, w: 210, h: 150, rgb: [200, 30, 30] },     // 主矩形（红）
    { x: 120, y: 300, w: 96, h: 60, rgb: [30, 60, 200] },        // 零件状色块 A（蓝）
    { x: 216, y: 318, w: 48, h: 24, rgb: [30, 60, 200] },        // 零件状色块 A 的凸点
    { x: 480, y: 320, w: 72, h: 72, rgb: [40, 140, 60] },        // 零件状色块 B（绿）
  ];
  for (const s of shapes) { ctx.fillStyle = hex(s.rgb); ctx.fillRect(s.x, s.y, s.w, s.h); }

  // BOM 蓝框（左上角零件清单面板）：填充 + 深色描边
  ctx.fillStyle = 'rgb(178,215,243)';
  ctx.fillRect(20, 20, 180, 90);
  ctx.strokeStyle = 'rgb(40,60,90)';
  ctx.lineWidth = 2;
  ctx.strokeRect(21, 21, 178, 88);

  // 黄 callout 框（右下角放大标注）：填充 + 描边
  ctx.fillStyle = 'rgb(255,204,1)';
  ctx.fillRect(560, 380, 180, 110);
  ctx.strokeStyle = 'rgb(90,70,10)';
  ctx.lineWidth = 2;
  ctx.strokeRect(561, 381, 178, 108);

  // 贯穿上下的竖直分割线（灰）——分栏线，必须被剥掉
  ctx.strokeStyle = 'rgb(120,124,130)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(540, 0);
  ctx.lineTo(540, H);
  ctx.stroke();

  // 右下角页码（深灰数字）——必须被剥掉
  ctx.fillStyle = 'rgb(30,30,30)';
  ctx.font = 'bold 12px sans-serif';
  ctx.textBaseline = 'bottom';
  ctx.fillText(String(label), W - 22, H - 8);

  // 真值掩膜：只含 shapes 的矩形（与 canvas 像素栅格一致：fillRect(x,y,w,h) 覆盖 [x,x+w)×[y,y+h)）
  const gt = new Uint8Array(W * H);
  for (const s of shapes) {
    for (let y = s.y; y < s.y + s.h; y++) for (let x = s.x; x < s.x + s.w; x++) gt[y * W + x] = 1;
  }
  return { png: cv.toBuffer('image/png'), gt, w: W, h: H, shapes };
}

/** 掩膜 IoU（同尺寸、无平移） */
function iou(a, b) {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i], y = b[i]; if (x && y) inter++; if (x || y) uni++; }
  return uni ? inter / uni : 1;
}

/** 合成页三底色各跑一遍：浅蓝(212,237,252) / 纯白 / 浅紫(240,235,250)，都要求 IoU ≥ 0.90。
 *  这一组用例是“掩膜提取正确性”的真值验收——旧实现靠单像素(5,5)取背景 + 硬编码 RGB 阈值，
 *  在浅蓝底上会把整页当背景或把面板整块当前景；这里三条底色都必须把三块零件形状干净留下。 */
for (const [name, pageBg] of [['浅蓝 #D4EDFC', [212, 237, 252]], ['纯白 #FFFFFF', [255, 255, 255]], ['浅紫 #F0EBFA', [240, 235, 250]]]) {
  test(`extractManualMask 合成页真值 IoU ≥ 0.90：${name} + 矩形/零件色块 + BOM 蓝框 + 黄 callout + 竖分割线 + 页码`, async () => {
    const { png, gt, w, h } = await syntheticManualPage({ pageBg, label: 42 });
    const m = await extractManualMask(png);
    assert.equal(m.manual, true);
    assert.equal(m.degraded, false);
    // 掩膜工作分辨率可能被等比缩放到 height=512；按同尺寸重采样真值后再比
    let scaledGt = gt, sw = w, sh = h;
    if (m.w !== w || m.h !== h) {
      scaledGt = new Uint8Array(m.w * m.h);
      for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) {
        const sx = Math.min(w - 1, Math.floor((x * w) / m.w)), sy = Math.min(h - 1, Math.floor((y * h) / m.h));
        scaledGt[y * m.w + x] = gt[sy * w + sx];
      }
      sw = m.w; sh = m.h;
    }
    const score = iou(m.mask, scaledGt);
    assert.ok(score >= 0.90, `${name} 合成页 IoU=${score.toFixed(4)} 应 ≥ 0.90（w=${sw}h=${sh} path=${m.maskPath}）`);
    // 诊断字段齐全：路径名必须是三条之一，bg / borderUniformity 有值
    assert.ok(['near-white-flood', 'uniform-bg-flood', 'photo-sweep-fallback'].includes(m.maskPath), `maskPath=${m.maskPath}`);
    assert.ok(m.bg && Number.isFinite(m.bg.r) && Number.isFinite(m.bg.g) && Number.isFinite(m.bg.b), 'bg 必须是 RGB 数值');
    assert.ok(Number.isFinite(m.borderUniformity) && m.borderUniformity >= 0 && m.borderUniformity <= 1, `borderUniformity=${m.borderUniformity}`);
    // 页码 / 分割线不得留在掩膜里：右下角小区域与分割线中段都应为背景
    let pageNumPx = 0;
    for (let y = Math.floor(sh * 0.96); y < sh; y++) for (let x = Math.floor(sw * 0.94); x < sw; x++) pageNumPx += m.mask[y * sw + x];
    assert.equal(pageNumPx, 0, `右下角页码区不应有前景像素（实得 ${pageNumPx}）`);
  });
}
