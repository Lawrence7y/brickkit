// 把 Part Asset v1 落盘为 catalog/assets-v1/：
//   index.json                全库索引（不含完整定义）
//   definitions/<id>.json     按件定义
//   overrides/<id>.json       覆盖层（人工修订，单独存放，不写回定义）
//   profiles/<id>.json        装配 profile（容差等）
//
// 产物体积与加载耗时必须能测（PRD §5.5）：不得要求加载全库才能做单件操作。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildIndex, DEFAULT_PROFILE, contentHashOf, connectorCountOf } from './index.js';

const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// Windows 上杀毒/索引服务会在文件刚被读过后短暂持有句柄，此时写入会抛
// UNKNOWN/EBUSY/EPERM。整库重建要写 4600+ 个文件，必然撞上，所以带退避重试。
// 只重试「疑似瞬时占用」的错误码；真权限问题（EACCES）直接抛出。
const RETRYABLE = new Set(['UNKNOWN', 'EBUSY', 'EPERM', 'EAGAIN']);
function writeFileRetry(file, body, opts = {}) {
  const attempts = opts.attempts ?? 8;
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.writeFileSync(file, body, 'utf8');
      return;
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE.has(err.code)) throw err;
      // 同步短退避：重建是批处理，几十毫秒的开销远小于整轮重来的代价
      const until = Date.now() + 40 * (i + 1);
      while (Date.now() < until) { /* spin */ }
    }
  }
  throw lastErr;
}

/**
 * 写盘。返回 { outDir, indexBytes, totalBytes, files, indexHash, stats, elapsedMs }
 * 同名目录已存在时默认拒绝覆盖（保护历史证据），需显式 { force: true }。
 */
export function writeAssetStore(root, outDir, opts = {}) {
  const t0 = Date.now();
  if (fs.existsSync(outDir) && !opts.force) {
    const hasIndex = fs.existsSync(path.join(outDir, 'index.json'));
    if (hasIndex) {
      const err = new Error(`资产目录 ${outDir} 已存在且含 index.json；拒绝覆盖（如需重建请显式传 force）`);
      err.code = 'exists';
      throw err;
    }
  }
  const built = opts.built || buildIndex(root, opts.buildOpts || {});
  fs.mkdirSync(path.join(outDir, 'definitions'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'overrides'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'profiles'), { recursive: true });

  // profiles
  const profile = built.profile || DEFAULT_PROFILE;
  fs.writeFileSync(path.join(outDir, 'profiles', `${profile.profileId}.json`),
    JSON.stringify({ format: 'brickkit-assembly-profile', ...profile }, null, 2) + '\n', 'utf8');

  let totalBytes = 0;
  const defSizes = [];
  for (const [partId, def] of [...built.definitions].sort((a, b) => a[0].localeCompare(b[0]))) {
    const body = JSON.stringify(def, null, 2) + '\n';
    const file = path.join(outDir, 'definitions', `${partId}.json`);
    writeFileRetry(file, body);
    totalBytes += Buffer.byteLength(body);
    defSizes.push({ partId, bytes: Buffer.byteLength(body) });
  }

  if (opts.overrides && typeof opts.overrides === 'object') {
    for (const [partId, list] of Object.entries(opts.overrides)) {
      fs.writeFileSync(path.join(outDir, 'overrides', `${partId}.json`), JSON.stringify(list, null, 2) + '\n', 'utf8');
    }
  }

  // index 最后写：其它文件齐了再写索引，避免半成品被当成可用
  const indexBody = JSON.stringify(built.index, null, 2) + '\n';
  writeFileRetry(path.join(outDir, 'index.json'), indexBody);

  defSizes.sort((a, b) => b.bytes - a.bytes);
  return {
    outDir,
    indexBytes: Buffer.byteLength(indexBody),
    totalDefinitionBytes: totalBytes,
    partCount: built.definitions.size,
    indexHash: contentHashOf(built.index),
    largestDefinitions: defSizes.slice(0, 5),
    stats: built.stats,
    buildWarnings: built.buildWarnings.length,
    elapsedMs: Date.now() - t0,
  };
}

/** 读取资产目录的最小索引（不加载任何定义） */
export function readIndex(assetsDir) {
  const f = path.join(assetsDir, 'index.json');
  if (!fs.existsSync(f)) {
    const err = new Error(`资产索引缺失：${f}`);
    err.code = 'missing-index';
    throw err;
  }
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

/**
 * 只加载指定零件的定义闭包（用于打包与内存核算）。
 * 返回 { definitions: Map, bytes, missing: [] }
 */
export function loadClosure(assetsDir, partIds) {
  const defs = new Map();
  const missing = [];
  let bytes = 0;
  for (const id of [...new Set(partIds)]) {
    const f = path.join(assetsDir, 'definitions', `${id}.json`);
    if (!fs.existsSync(f)) { missing.push(id); continue; }
    const buf = fs.readFileSync(f);
    bytes += buf.length;
    defs.set(id, JSON.parse(buf.toString('utf8')));
  }
  return { definitions: defs, bytes, missing };
}

/** 资产目录完整性自检：索引里每条都必须有定义文件，哈希必须对得上 */
export function verifyStore(assetsDir) {
  const index = readIndex(assetsDir);
  const problems = [];
  let checked = 0;
  for (const e of index.parts || []) {
    const f = path.join(assetsDir, 'definitions', `${e.partId}.json`);
    if (!fs.existsSync(f)) { problems.push({ partId: e.partId, issue: 'missing-definition' }); continue; }
    const def = JSON.parse(fs.readFileSync(f, 'utf8'));
    checked++;
    if (def.contentHash !== e.contentHash) {
      problems.push({ partId: e.partId, issue: 'content-hash-mismatch', index: e.contentHash, file: def.contentHash });
    }
    if (def.partId !== e.partId) problems.push({ partId: e.partId, issue: 'part-id-mismatch' });
    if (connectorCountOf(def) !== e.connectorCount) {
      problems.push({ partId: e.partId, issue: 'connector-count-mismatch', index: e.connectorCount, file: connectorCountOf(def) });
    }
  }
  return { ok: problems.length === 0, checked, count: (index.parts || []).length, problems: problems.slice(0, 50), problemCount: problems.length };
}
