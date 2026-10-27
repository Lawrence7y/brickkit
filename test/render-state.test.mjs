// renderState（MV-01）契约测试：投影口径、遮挡剔除、标号与 stateHash 绑定、密度上限、负例。
// 与真实浏览器的一致性由 out/prd-v2/.../A/render/verify-projection.mjs 单独验证（像素级 <0.001 px），
// 这里只测纯离线可判定的语义，保证 CI 不依赖浏览器。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  renderState, makeCamera, projectPoint, rayBoxHit, coreToWorld, aliasesOf,
  toConnectorMap, resolveTag, CAMERA_CONTRACT, RENDER_STATE_VERSION,
} from '../src/core/actions-v1/render-state.js';
import { inspectFromModel } from '../src/core/actions-v1/state.js';
import { partCenter } from '../src/core/core.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const readJSON = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const cat = { parts: { ...readJSON('catalog/parts-ldraw.json').parts, ...readJSON('catalog/parts.json').parts }, colors: readJSON('catalog/colors.json').colors };

const baseModel = () => ({
  format: 'brickbuild', version: '0.2',
  parts: [
    { id: 'p1', part: '3001', color: 15, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 },
  ],
});
const camOf = (over = {}) => ({ azimuthDeg: 0, elevationDeg: 5, target: [0, 1, 0], distance: 18, width: 900, height: 1000, ...over });

// ---------------------------------------------------------------- 相机与投影

test('[MV-01] 相机契约：az=0 时相机在 +Z 正前方，el>0 时在目标上方', () => {
  assert.equal(CAMERA_CONTRACT.pixelOrigin, 'top-left');
  assert.equal(RENDER_STATE_VERSION, '1.0.0');

  const front = makeCamera(camOf());
  assert.ok(front.eye[2] > front.target[2], 'az=0 相机应在 target 的 +Z 侧');
  assert.ok(Math.abs(front.eye[0] - front.target[0]) < 1e-9, 'az=0 时 X 不应偏移');

  const up = makeCamera(camOf({ elevationDeg: 30 }));
  assert.ok(up.eye[1] > front.eye[1], 'el 变大时相机应升高');

  const right = makeCamera(camOf({ azimuthDeg: 90 }));
  assert.ok(right.eye[0] > right.target[0], 'az=90 相机应在 +X 侧');
});

test('[MV-01] 像素原点在左上：同深度下世界 +X 向右、世界 +Y 在屏幕上向上', () => {
  const cam = makeCamera(camOf({ azimuthDeg: 0, elevationDeg: 0, target: [0, 0, 0], distance: 20 }));
  const center = projectPoint(cam, [0, 0, 0]);
  const plusX = projectPoint(cam, [2, 0, 0]);
  const plusY = projectPoint(cam, [0, 2, 0]);

  assert.ok(plusX.x > center.x, '世界 +X 应投到更大像素 x（右侧）');
  assert.ok(plusY.y < center.y, '世界 +Y 应投到更小像素 y（屏幕上方，因原点在左上）');
  assert.ok(Math.abs(plusX.y - center.y) < 0.01, '+X 平移不应改变屏幕 y');
});

test('[MV-01] 相机背后与视口外的点必须标为不可见，不返回负坐标冒充可见', () => {
  const cam = makeCamera(camOf({ distance: 10, target: [0, 0, 0] }));
  // 相机在 +Z 侧（eye.z ≈ +9.96）。比相机更远的 +Z 方向才是「背后」。
  const behind = projectPoint(cam, [0, 0, 50]);
  assert.equal(behind.visible, false);
  assert.equal(behind.inFront, false);

  // 反面对照：-Z 方向在相机前方，必须可见（防止把「背后判定」写成方向写反）
  const inFront = projectPoint(cam, [0, 0, -50]);
  assert.equal(inFront.inFront, true);
  assert.ok(inFront.visible, '相机前方的中心轴点应可见');

  const farOff = projectPoint(cam, [500, 0, 0]);
  assert.equal(farOff.visible, false, '远在视口外的点不得标为可见');
});

test('[MV-01] 射线-AABB 相交：命中返回近端距离，未命中返回 null（slab 法）', () => {
  const box = { min: [-1, -1, -1], max: [1, 1, 1] };
  const hit = rayBoxHit([0, 0, 10], [0, 0, -1], box);
  assert.ok(hit !== null && Math.abs(hit - 9) < 1e-9, `应命中于 t=9，实际 ${hit}`);
  assert.equal(rayBoxHit([0, 0, 10], [0, 0, 1], box), null, '背向射线不得命中');
  assert.equal(rayBoxHit([5, 0, 10], [0, 0, -1], box), null, '错开的射线不得命中');
});

// ---------------------------------------------------------------- 标号

test('[MV-01] renderState 正例：俯视可见的凸点被标出，背面与遮挡点被剔除', () => {
  const model = baseModel();
  const r = renderState({ model, cat, camera: camOf({ elevationDeg: 40, distance: 20 }), maxLabels: 32 });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.ok(r.labels.length > 0, '应至少标出一个可用凸点');
  assert.equal(r.stateHash, inspectFromModel(model, cat, {}).stateHash, '输出必须绑定 stateHash');
  for (const l of r.labels) {
    assert.ok(Number.isInteger(Number(l.tag)), 'tag 应为数字字符串');
    assert.ok(l.pixel[0] >= 0 && l.pixel[0] <= 900, `像素 x 越界：${l.pixel[0]}`);
    assert.ok(l.pixel[1] >= 0 && l.pixel[1] <= 1000, `像素 y 越界：${l.pixel[1]}`);
    assert.ok(l.worldPos.length === 3 && l.worldPosLdu.length === 3);
    assert.ok(l.aliases.bStyle, '每个标号都要带 B 侧别名');
  }
  // 3001 是 2×4 砖，顶面 8 个凸点；斜上方看应能看到一部分而非全部
  assert.ok(r.labels.length <= 8, `3001 顶面只有 8 个凸点，不应标出 ${r.labels.length} 个`);
});

test('[MV-01] 仰视时顶面凸点必须全部朝背，不得标出（朝向剔除）', () => {
  const r = renderState({ model: baseModel(), cat, camera: camOf({ elevationDeg: -40, distance: 20 }) });
  assert.equal(r.ok, true);
  assert.equal(r.labels.length, 0, '从下往上看不到顶面凸点');
  assert.ok(r.skipped.backFacing > 0, '应记录为 backFacing 而不是静默丢弃');
});

test('[MV-01] 遮挡剔除：上层大板会挡住下层凸点，被挡点不得出现在标号里', () => {
  // 下层 3001（8 个顶凸点），正上方盖一块 2×4 板 3020（底板孔刚好占满下面 8 个凸点）
  const model = {
    format: 'brickbuild', version: '0.2',
    parts: [
      { id: 'low', part: '3001', color: 15, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 },
      { id: 'top', part: '3020', color: 15, at: [0, 3, 0], rot: 0, up: '+y', snot: 0, step: 2 },
    ],
  };
  const r = renderState({ model, cat, camera: camOf({ elevationDeg: 60, distance: 22 }), includeOccupied: true, maxLabels: 32 });
  assert.equal(r.ok, true);
  // 下层已被 top 扣住 → 其 8 个凸点属于 occupied；top 的 8 个凸点在最上面应可见
  const fromLow = r.labels.filter((l) => l.nodeId === 'low');
  assert.equal(fromLow.length, 0, `下层的凸点全部被占据且被遮挡，不应标出 ${fromLow.length} 个`);
  assert.ok(r.labels.some((l) => l.nodeId === 'top'), '上层板的可用凸点应被标出');
  assert.ok(r.skipped.occupied > 0 || r.skipped.occluded > 0, '被扣住/被遮挡的点应计入 skipped，不能静默消失');
});

test('[MV-01] 已占用接口默认不标；includeOccupied 时才列出且带 occupiedBy', () => {
  const model = {
    format: 'brickbuild', version: '0.2',
    parts: [
      { id: 'low', part: '3001', color: 15, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 },
      { id: 'top', part: '3020', color: 15, at: [0, 3, 0], rot: 0, up: '+y', snot: 0, step: 2 },
    ],
  };
  const cam = camOf({ elevationDeg: 55, distance: 22 });
  const off = renderState({ model, cat, camera: cam, maxLabels: 32 });
  const on = renderState({ model, cat, camera: cam, includeOccupied: true, maxLabels: 32 });
  assert.equal(off.labels.every((l) => !off.labels.find((x) => x.nodeId === l.nodeId && x.occupied)), true);
  assert.ok(on.skipped.occupied <= off.skipped.occupied, 'includeOccupied 后 occupied 跳过数应不增加');
});

test('[MV-01] 标签密度上限：超过上限必须截断并把 enumerationComplete 置 false', () => {
  const parts = [];
  for (let i = 0; i < 6; i++) {
    for (let k = 0; k < 6; k++) {
      parts.push({ id: `p${i}_${k}`, part: '3024', color: 15, at: [i, 0, k], rot: 0, up: '+y', snot: 0, step: 1 });
    }
  }
  const model = { format: 'brickbuild', version: '0.2', parts };
  const r = renderState({ model, cat, camera: camOf({ elevationDeg: 70, distance: 40, target: [3, 0, 3] }), maxLabels: 10 });
  assert.equal(r.ok, true);
  assert.equal(r.labels.length, 10);
  assert.equal(r.truncated, true);
  assert.equal(r.enumerationComplete, false, '截断时不得声称视口内接口已穷尽');
  assert.ok(r.candidatesInView > 10);

  // 上限 32 是硬约束（PRD MV-01），传更大值必须被夹到 32
  const big = renderState({ model, cat, camera: camOf({ elevationDeg: 70, distance: 40, target: [3, 0, 3] }), maxLabels: 999 });
  assert.equal(big.maxLabels, 32, '标签上限不得超过 PRD 规定的 32');
});

test('[MV-01] 标号顺序稳定：同一相机与状态两次调用，tag→接口映射完全一致', () => {
  const model = baseModel();
  const q = { model, cat, camera: camOf({ elevationDeg: 35, distance: 20 }), maxLabels: 32 };
  const a = renderState(q);
  const b = renderState(q);
  assert.deepEqual(a.labels.map((l) => `${l.tag}:${l.nodeId}/${l.connectorId}`),
    b.labels.map((l) => `${l.tag}:${l.nodeId}/${l.connectorId}`), '标号顺序必须确定（同一输入同一输出）');
});

test('[MV-01] 负例：stateHash 不匹配必须拒绝（标号不得跨状态复用）', () => {
  const model = baseModel();
  const r = renderState({ model, cat, camera: camOf(), stateHash: 'f'.repeat(64) });
  assert.equal(r.ok, false);
  assert.equal(r.diagnostics[0].code, 'stale-state');
  assert.equal(r.passed, false);
});

test('[MV-01] 负例：缺相机尺寸/取景参数必须拒绝，不得隐式取景', () => {
  const model = baseModel();
  const noSize = renderState({ model, cat, camera: { target: [0, 0, 0], distance: 20 } });
  assert.equal(noSize.ok, false);
  assert.equal(noSize.diagnostics[0].code, 'render-invalid-request');

  const noTarget = renderState({ model, cat, camera: { width: 800, height: 600, distance: 20 } });
  assert.equal(noTarget.ok, false, '缺 target 不许猜取景');

  const noModel = renderState({ cat, camera: camOf() });
  assert.equal(noModel.ok, false);
});

// ---------------------------------------------------------------- B 消费侧

test('[MV-01] toConnectorMap / resolveTag：B 草案字段可读，且反查受 stateHash 约束', () => {
  const model = baseModel();
  const r = renderState({ model, cat, camera: camOf({ elevationDeg: 35, distance: 20 }), maxLabels: 32 });
  const cm = toConnectorMap(r);
  assert.equal(cm.stateHash, r.stateHash);
  assert.equal(cm.totalVisibleLabels, r.labels.length);
  const first = cm.labels[0];
  assert.ok(Array.isArray(first['2d']) && first['2d'].length === 2, 'render-requirements §2.4 的 "2d" 字段');
  assert.ok(first.partInstanceId && first.connectorId, 'B 草案字段名');
  assert.ok(first.stableConnectorId, '权威稳定 ID 必须同时给出');

  const back = resolveTag(r, first.tag, r.stateHash);
  assert.ok(back);
  assert.equal(back.connectorId, r.labels[0].connectorId);
  assert.equal(resolveTag(r, first.tag, 'f'.repeat(64)), null, '状态不符时反查必须失败');
  assert.equal(resolveTag(r, '9999', r.stateHash), null);
});

test('[MV-01] 接口别名：顶凸点有 stud_top_N 与裸 stud_N，侧凸点只有 stud_side_N（裸写法有损）', () => {
  assert.deepEqual(aliasesOf('ctop#3'), { bStyle: 'stud_top_3', bare: 'stud_3' });
  assert.deepEqual(aliasesOf('cside#2'), { bStyle: 'stud_side_2', bare: null });
  assert.equal(aliasesOf('cantistud#0').bStyle, 'antistud_0');
  // 侧凸点不得给出裸 stud_N，否则与顶凸点撞名
  assert.equal(aliasesOf('cside#3').bare, null);
});

test('[MV-01] core→world 换算：片上坐标乘 PLATE，格坐标不变', () => {
  assert.deepEqual(coreToWorld([2, 3, 5]), [2, 1.2, 5]);
  const p = { id: 'x', part: '3001', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0 };
  // partCenter 返回 [x格, y片, z格]；3001 是 4×2 砖，中心在 x=2, z=1, y=0（底面起算）
  const c = partCenter(p, cat.parts['3001']);
  assert.deepEqual(c, [2, 0, 1], `3001 中心应为 [2,0,1]，实际 ${JSON.stringify(c)}`);
  assert.deepEqual(coreToWorld(c), [2, 0, 1], 'y=0 片换算后仍是 0 格');
  // 抬高一砖（3 片 = 1.2 格）：片上 y=3 必须换算成世界 1.2
  const raised = partCenter({ ...p, at: [0, 3, 0] }, cat.parts['3001']);
  assert.deepEqual(coreToWorld(raised), [2, 1.2, 1]);
});
