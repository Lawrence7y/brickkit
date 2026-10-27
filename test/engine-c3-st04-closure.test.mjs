// ST-04 依赖闭包打包实测（真实案例：60239.fixed.brick.json）。
// 断言 tools/perf-st04-closure.mjs 的全部不变量：
//   缺失引用 = 0；打包目录 == 闭包集合（无缺失、无多余）；只给打包目录时烘焙几何与
//   完整镜像逐字节一致；磁盘读取次数 == 闭包文件数（相同 part revision 不重复编译/读取）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSt04 } from '../tools/perf-st04-closure.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_OUT = path.join(ROOT, 'out', 'prd-v2', 'run-20261026-c', 'C', 'engine');

test('ST-04 60239 依赖闭包：缺失 0、打包无多余、打包即完整（烘焙逐字节一致）、每文件只读一次', async () => {
  const report = await runSt04();
  // 缺失引用必须为 0（闭包内每个 type-1 引用都能解析）
  assert.deepEqual(report.missingRefs, [], `缺失引用：${report.missingRefs.join(', ')}`);
  // 打包目录 == 闭包集合（不多一件、不少一件）
  assert.deepEqual(report.packageEqualsClosure.unreferenced, [], '打包目录含有未被引用的文件');
  assert.deepEqual(report.packageEqualsClosure.notPackaged, [], '闭包文件未全部入包');
  // 只给打包目录：烘焙结果与完整镜像逐字节一致（viewer 单文件自包含的等价判据）
  assert.equal(report.bakeEquivalence.byteIdentical, true, '打包目录烘焙结果与完整镜像不一致');
  assert.equal(report.bakeEquivalence.noDat, 0);
  // 相同 part revision 不重复编译/读取
  assert.equal(report.compileOnce.diskReadsEqualsClosureFiles, true,
    `磁盘读取 ${report.compileOnce.diskReads} != 闭包文件 ${report.closure.files}`);
  assert.ok(report.compileOnce.uniquePartColorKeys <= report.placements,
    `编译键数 ${report.compileOnce.uniquePartColorKeys} 应 ≤ 摆放数 ${report.placements}（builtCache 去重）`);
  // 闭包显著小于全镜像（量化「只打包依赖闭包」的收益）
  assert.ok(report.closureRatio.files < 0.05, `闭包文件数占全镜像 ${(report.closureRatio.files * 100).toFixed(2)}%`);
  assert.equal(report.verdict, 'verified');
}, { timeout: 120000 });
