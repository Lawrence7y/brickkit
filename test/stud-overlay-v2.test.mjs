import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  vec3Sub,
  vec3Dot,
  vec3Normalize,
  sphericalToCartesian,
  project3DTo2D,
  rayIntersectsBox,
  isConnectorOccluded,
  generateConnectorOverlay,
  resolveLabelToConnector
} from '../src/viewer/stud-overlay-v2.js';

const cat = JSON.parse(fs.readFileSync('catalog/parts.json', 'utf8'));

test('3D 向量运算与坐标变换纯函数', () => {
  const a = [3, 4, 0];
  const b = [1, 1, 0];
  assert.deepEqual(vec3Sub(a, b), [2, 3, 0]);
  assert.equal(vec3Dot(a, b), 7);
  assert.deepEqual(vec3Normalize([0, 5, 0]), [0, 1, 0]);

  const p = sphericalToCartesian(0, 0, 10, [0, 0, 0]);
  assert.equal(Math.round(p[0]), 0);
  assert.equal(Math.round(p[1]), 0);
  assert.equal(Math.round(p[2]), 10);
});

test('3D 坐标投影到 2D 像素坐标 (project3DTo2D)', () => {
  const camera = { azimuth: 0, elevation: 0, distance: 20, target: [0, 0, 0] };
  const viewport = { width: 800, height: 600 };

  // 位于目标点 [0, 0, 0] 应投影至视口中心 (400, 300)
  const centerProj = project3DTo2D([0, 0, 0], camera, viewport);
  assert.equal(centerProj.visible, true);
  assert.equal(Math.abs(centerProj.x - 400) <= 2, true);
  assert.equal(Math.abs(centerProj.y - 300) <= 2, true);

  // 位于相机背后的点应不可见
  const behindProj = project3DTo2D([0, 0, 30], camera, viewport);
  assert.equal(behindProj.visible, false);
});

test('射线与 AABB 包围盒相交测试 (rayIntersectsBox)', () => {
  const box = { min: [-1, -1, -1], max: [1, 1, 1] };
  const origin = [0, 0, 10];
  const hitDir = [0, 0, -1];
  const missDir = [1, 0, 0];

  assert.equal(rayIntersectsBox(origin, hitDir, box), true);
  assert.equal(rayIntersectsBox(origin, missDir, box), false);
});

test('遮挡判定：被前方实体零件挡住的接口必须被剔除', () => {
  // 零件 A 在 [0, 0, 0]，大遮挡块 B 在 [0, 0, 5]，相机在 [0, 0, 10]
  const connectorPos = [0, 0, 0];
  const cameraPos = [0, 0, 10];
  const boxes = [
    { partId: 'blocker', min: [-2, -2, 4], max: [2, 2, 6] }
  ];

  const occluded = isConnectorOccluded(connectorPos, cameraPos, boxes, 'ownerPart');
  assert.equal(occluded, true);

  // 若没有阻挡块，则不应被遮挡
  const notOccluded = isConnectorOccluded(connectorPos, cameraPos, [], 'ownerPart');
  assert.equal(notOccluded, false);
});

test('generateConnectorOverlay 端到端标号生成与映射表解析', () => {
  // 构造一个简单的双零件模型（两块 3001 2x4 基础砖）
  const model = {
    format: 'brickbuild',
    meta: { name: 'test-overlay' },
    parts: [
      { id: 'p001', part: '3001', color: 0, at: [0, 0, 0], rot: 0, up: '+y' },
      { id: 'p002', part: '3001', color: 15, at: [0, 3, 0], rot: 0, up: '+y' }
    ]
  };

  const camera = { azimuth: 315, elevation: 30, distance: 30, target: [0, 1.5, 0] };
  const res = generateConnectorOverlay(model, cat, camera, {
    maxLabels: 8,
    stateHash: 'test-hash-12345'
  });

  assert.ok(res.labelMap);
  assert.ok(res.svg);
  assert.equal(res.labelMap.stateHash, 'test-hash-12345');
  assert.equal(res.labelMap.labels.length <= 8, true);
  assert.equal(res.labelMap.labels.length > 0, true);

  // 检查首个标签的结构完整性
  const first = res.labelMap.labels[0];
  assert.equal(first.tag, '1');
  assert.ok(Array.isArray(first.pixel));
  assert.ok(first.partInstanceId);
  assert.ok(first.connectorId);

  // 检查 SVG 内容
  assert.equal(res.svg.includes('<svg'), true);
  assert.equal(res.svg.includes('data-tag="1"'), true);
  assert.equal(res.svg.includes('connector-mark'), true);

  // 检查 resolveLabelToConnector 查表反解
  const found = resolveLabelToConnector(res.labelMap, '1');
  assert.ok(found);
  assert.equal(found.partInstanceId, first.partInstanceId);
  assert.equal(found.connectorId, first.connectorId);

  // 不存在的标签返回 null
  const notFound = resolveLabelToConnector(res.labelMap, '999');
  assert.equal(notFound, null);
});
