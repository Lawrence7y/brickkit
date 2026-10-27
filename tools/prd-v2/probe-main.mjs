// 四步工作流 · 主体搭建（主会话负责，PRD §8 第 3 步中的「主体」）
// 32 件：底座 → 塔柱 6 层 → 回转平台 → SNOT 挂点 → 塔顶封盖
// 坐标单位：at 为整数格 [x, 层, z]；垂直层 = 板层（h 值累加）
import fs from 'node:fs';
import { createBuilder } from '../../src/core/builder.js';
import { validate, partBoxes } from '../../src/core/core.js';

const ROOT = 'D:/Project/brickkit';
const OUT = `${ROOT}/out/prd-v2/run-20261026-c/C/integration/fourstep/build/main.brick.json`;
const catalog = JSON.parse(fs.readFileSync(`${ROOT}/catalog/parts.json`, 'utf8'));

const C = { base: 71, tower: 14, accent: 0, deck: 72 };
const b = createBuilder({ catalog, meta: { name: '港口吊机 · 主体', front: '+z', note: '四步工作流 C3-3 main_body' } });

// 底座占位：3036 (8×6) 在 [0,0,0]；3035 (8×4) 需 z 偏 6 → at [0,0,6]
const baseA = b.add('3036', C.base, { at: [0, 0, 0], step: 1 });
const baseB = b.add('3035', C.base, { at: [0, 0, 6], step: 1 });
// 4×4 加固板贴在 3035 两侧
const rein0 = b.add('3031', C.base, { at: [0, 1, 0], step: 1 });
const rein1 = b.add('3031', C.base, { at: [4, 1, 0], step: 1 });

// 塔柱 6 层 2×2 砖，坐落在底座中央（x 3-5, z 2-4）：3036 顶凸点编号需查
const studs = (await import('../../src/core/core.js')).partConnectors(baseA, catalog.parts['3036']);
console.log('3036 connectors:', JSON.stringify(studs).slice(0, 400));

b.assert();
const model = b.model();
const info = validate(model, catalog);
console.log(JSON.stringify({ ok: info.errors.length === 0, errors: info.errors.slice(0, 3), warnings: info.warnings.slice(0, 3), parts: model.parts.length }, null, 2));
