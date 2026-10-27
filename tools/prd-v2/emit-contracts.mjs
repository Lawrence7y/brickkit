// 生成 docs/prd-v2/implementation-A/contracts/orientation-table.json
// 用法：node tools/prd-v2/emit-contracts.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ROOT = path.resolve(import.meta.dirname, '../..');

export async function emitOrientationTable(outDir) {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src/core/actions-v1/orientations.js')).href);
  const check = mod.selfCheck();
  if (!check.ok) throw new Error(`姿态表自检失败：${check.problems.join('; ')}`);
  const payload = {
    format: 'brickkit-orientation-table',
    version: mod.ORIENTATION_TABLE_VERSION,
    generatedBy: 'tools/prd-v2/emit-contracts.mjs',
    note: 'orientationId=0 为恒等旋转。matrix 为列主序 [[r00,r01,r02],[r10,r11,r12],[r20,r21,r22]] = [ux uy uz]，满足 RᵀR=I 且 det=+1。assemblyAxis 为装配轴；显示外法线另见 faceNormal。',
    faceNormal: mod.FACE_NORMAL,
    selfCheck: { count: check.count, distinct: check.distinct, orthonormal: true, determinantsAllPlusOne: true },
    orientations: mod.ORIENTATIONS.map(({ orientationId, up, rot, matrix, assemblyAxis, determinant, deltas }) => ({
      orientationId, up, rot, matrix, assemblyAxis, determinant, deltas,
    })),
  };
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'orientation-table.json');
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return { file, check };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const outDir = process.argv[2] || path.join(ROOT, 'docs/prd-v2/implementation-A/contracts');
  const r = await emitOrientationTable(outDir);
  console.log(JSON.stringify({ ok: true, file: path.relative(ROOT, r.file), count: r.check.count, distinct: r.check.distinct }));
}
