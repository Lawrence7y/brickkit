// ST-04 依赖闭包打包实测（HANDOFF-C §3 C3-4 / PRD v2 ST-04，原 A 报告记 partial：
// 「viewer 只打包依赖闭包未实测；相同 part revision 不重复编译未测」）。
//
// 在真实案例（60239.fixed.brick.json，91 件 / 47 种零件）上测量：
//   1) 从模型零件出发，沿官方 .dat 的 type-1 引用做闭包遍历（refCandidates 同一解析顺序，
//      OFFICIAL_ALIASES 同一别名表，MAX_DEPTH 12 与 loader 一致）；缺失引用必须为 0；
//   2) 把闭包打包成独立目录（保留 parts/ p/ parts/s/ 镜像布局）+ 逐文件 sha256 manifest；
//   3) 打包完整性双向断言：
//      a. 只给打包目录时 buildModelGeometries 产出与完整镜像逐字节一致（nothing missing）；
//      b. 打包目录内容 == 闭包集合，不多一件（nothing unreferenced），并给出闭包 ≪ 全镜像的量化；
//   4) 相同 part revision 不重复编译：91 个摆放 → 按 (part|color) 键只编译一次（parts=键数），
//      且磁盘读取次数 == 闭包文件数（每文件恰好读一次，与摆放次数/重复引用无关）。
//
// 用法：node tools/perf-st04-closure.mjs   （写 out/prd-v2/run-20261026-c/C/engine/st04-*）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_OUT = path.join(ROOT, 'out', 'prd-v2', 'run-20261026-c', 'C', 'engine');
// 与 src/ldraw/loader.mjs 的 LDRAW_ROOTS 同一优先级：先 ldraw-full（整库镜像），再 ldraw（精选 165 种）
const MIRROR_ROOTS = [
  path.join(ROOT, 'catalog', 'ldraw-full'),
  path.join(ROOT, 'catalog', 'ldraw'),
];
// 模型已提升进版本库（examples/），不再依赖本地的 out/ 产物
const MODEL_PATH = path.join(ROOT, 'examples/60239.fixed.brick.json');
const MAX_DEPTH = 12;

const { refCandidates, OFFICIAL_ALIASES } = await import(pathToFileURL(path.join(ROOT, 'src/ldraw/ldraw.js')).href);
const { parseLine } = await import(pathToFileURL(path.join(ROOT, 'src/ldraw/loader.mjs')).href);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const normRef = (raw) => String(raw).trim().toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '');

/** 镜像内解析：与 src/ldraw/loader.mjs createResolver 相同的候选顺序与根优先级 */
function resolveOnDisk(raw) {
  const key = normRef(raw);
  const cands = refCandidates(key);
  if (!cands.includes(key)) cands.push(key);
  for (const lp of cands) {
    for (const root of MIRROR_ROOTS) {
      const f = path.join(root, lp);
      if (fs.existsSync(f)) return { rel: lp.replace(/\\/g, '/'), abs: f };
    }
  }
  return null;
}

/** 沿 type-1 引用做闭包遍历；返回 Map(relPath → {text, refs:[{ref, resolved|null}]}) 与缺失清单 */
export function computeClosure(partIds) {
  const closure = new Map();
  const missing = [];
  const edges = {};
  const queue = partIds.map((id) => `${OFFICIAL_ALIASES[String(id)] || String(id)}.dat`.toLowerCase());
  const seenRoot = new Set(queue);
  while (queue.length) {
    const raw = queue.shift();
    const hit = resolveOnDisk(raw);
    if (!hit) { missing.push(raw); continue; }
    if (closure.has(hit.rel)) continue;
    const text = fs.readFileSync(hit.abs, 'utf8');
    closure.set(hit.rel, { text });
    const refs = [];
    for (const line of text.split(/\r?\n/)) {
      const t = parseLine(line);
      if (!t || t.type !== 1) continue;
      refs.push(t.file);
      if (!seenRoot.has(normRef(t.file))) { seenRoot.add(normRef(t.file)); queue.push(t.file); }
    }
    edges[hit.rel] = refs;
    if (normRef(raw) !== hit.rel) closure.get(hit.rel).aliasOf = normRef(raw);
  }
  return { closure, missing, edges };
}

/** 计数解析器：统计磁盘读取与 resolve 调用（自带缓存，语义与 createResolver 一致） */
export function countingResolver(root) {
  const cache = new Map();
  const stats = { diskReads: 0, resolveCalls: 0, perKeyCalls: {} };
  return {
    stats,
    resolve(raw) {
      const key = normRef(raw);
      stats.resolveCalls++;
      stats.perKeyCalls[key] = (stats.perKeyCalls[key] || 0) + 1;
      if (cache.has(key)) return cache.get(key);
      const cands = refCandidates(key);
      if (!cands.includes(key)) cands.push(key);
      for (const lp of cands) {
        const f = path.join(root, lp);
        if (fs.existsSync(f)) { cache.set(key, fs.readFileSync(f, 'utf8')); stats.diskReads++; return cache.get(key); }
      }
      cache.set(key, null);
      return null;
    },
  };
}

export async function runSt04() {
  const cat = {
    parts: {
      ...JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts-ldraw.json'), 'utf8')).parts,
      ...JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'), 'utf8')).parts,
    },
    colors: JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/colors.json'), 'utf8')).colors,
  };
  const model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
  const { buildModelGeometries } = await import(pathToFileURL(path.join(ROOT, 'src/ldraw/loader.mjs')).href);

  const uniqueParts = [...new Set(model.parts.map((p) => String(p.part)))].sort();
  const { closure, missing, edges } = computeClosure(uniqueParts);

  // —— 打包：复制闭包文件，保留镜像布局 ——
  const pkgRoot = path.join(ENGINE_OUT, 'st04-package');
  fs.rmSync(pkgRoot, { recursive: true, force: true });
  const manifestFiles = {};
  for (const [rel, entry] of closure) {
    const src = resolveOnDisk(rel).abs;
    const dst = path.join(pkgRoot, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    const buf = fs.readFileSync(src);
    manifestFiles[rel] = { sha256: sha256(buf), bytes: buf.length, ...(entry.aliasOf ? { aliasOf: entry.aliasOf } : {}) };
  }
  const manifest = {
    gate: 'ST-04', item: 'dependency-closure-packaging',
    model: 'out/prd-v2/run-20261026-c/C/integration/60239/60239.fixed.brick.json',
    placements: model.parts.length,
    uniqueParts: uniqueParts.length,
    closureFiles: closure.size,
    closureBytes: Object.values(manifestFiles).reduce((a, f) => a + f.bytes, 0),
    missingRefs: missing,
    files: manifestFiles,
    edges,
  };
  fs.writeFileSync(path.join(ENGINE_OUT, 'st04-closure-manifest.json'), JSON.stringify(manifest, null, 1));

  // —— a. 只给打包目录：烘焙结果与完整镜像逐字节一致，missingFiles = 0 ——
  const fullBake = buildModelGeometries(model, cat);
  const pkg = countingResolver(pkgRoot);
  const pkgBake = buildModelGeometries(model, cat, { resolve: pkg.resolve });
  const fullJson = JSON.stringify(fullBake), pkgJson = JSON.stringify(pkgBake);
  const pkgStats = pkg.stats;

  // —— b. 打包目录内容 == 闭包集合（不多不少） ——
  const packaged = [];
  const walk = (dir, prefix = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else packaged.push(rel);
    }
  };
  walk(pkgRoot);
  const closureSet = new Set(closure.keys());
  const packagedSet = new Set(packaged);
  const unreferenced = packaged.filter((f) => !closureSet.has(f));
  const notPackaged = [...closureSet].filter((f) => !packagedSet.has(f));

  // 全镜像规模（量化闭包占比；按 rel 去重，字节按 loader 的根优先级取第一命中）
  const mirrorMap = new Map();
  const walkMirror = (dir, prefix = '') => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walkMirror(path.join(dir, e.name), rel);
      else if (rel.endsWith('.dat') && !mirrorMap.has(rel)) mirrorMap.set(rel, path.join(dir, e.name));
    }
  };
  for (const root of MIRROR_ROOTS) walkMirror(root);
  const mirrorFiles = [...mirrorMap.keys()];
  const mirrorBytes = mirrorFiles.reduce((a, f) => a + fs.statSync(mirrorMap.get(f)).size, 0);

  const report = {
    gate: 'ST-04', item: 'dependency-closure-packaging-measured',
    model: '60239.fixed.brick.json', placements: model.parts.length, uniqueParts: uniqueParts.length,
    closure: { files: closure.size, bytes: manifest.closureBytes },
    mirror: { files: mirrorFiles.length, bytes: mirrorBytes },
    closureRatio: { files: +(closure.size / mirrorFiles.length).toFixed(4), bytes: +(manifest.closureBytes / mirrorBytes).toFixed(4) },
    missingRefs: missing,
    packageEqualsClosure: { packaged: packaged.length, unreferenced, notPackaged },
    bakeEquivalence: { byteIdentical: fullJson === pkgJson, triangles: fullBake.triangles, parts: fullBake.parts, noDat: fullBake.noDat.length },
    compileOnce: {
      uniquePartColorKeys: fullBake.parts,
      placementsPerKey: +(model.parts.length / Math.max(1, fullBake.parts)).toFixed(2),
      diskReads: pkgStats.diskReads,
      diskReadsEqualsClosureFiles: pkgStats.diskReads === closure.size,
      resolveCalls: pkgStats.resolveCalls,
      note: 'builtCache 按 part|color 键复用：91 个摆放只编译 uniquePartColorKeys 次；解析器磁盘读取恰为闭包文件数',
    },
    verdict: (missing.length === 0 && unreferenced.length === 0 && notPackaged.length === 0 && fullJson === pkgJson && pkgStats.diskReads === closure.size) ? 'verified' : 'failed',
  };
  fs.writeFileSync(path.join(ENGINE_OUT, 'st04-closure-report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = await runSt04();
  console.log(JSON.stringify({ ok: report.verdict === 'verified', closureFiles: report.closure.files, missing: report.missingRefs.length, unreferenced: report.packageEqualsClosure.unreferenced.length, bakeIdentical: report.bakeEquivalence.byteIdentical, diskReads: report.compileOnce.diskReads }));
}
