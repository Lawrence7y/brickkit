// assetLock v1：资产锁的解析与校验（ST-01）。
//
// 为什么单独成模块：assetLock 是「同一 lock 必解析出同一批定义」的唯一凭据。
// 只要它接受空串哈希、缺件或与索引不符，下游所有「可重现」结论都不成立。
// 因此这里的规则一律是**拒绝**而不是警告：
//   - 缺 assetLock                        → asset-lock-missing
//   - assetLock.parts 不是数组 / 空       → asset-lock-empty
//   - 任务实际用到的件号没进锁            → asset-lock-incomplete（不再降级为 warning）
//   - revision 为空或与索引不符           → asset-lock-revision-mismatch
//   - contentHash 缺失/空串/格式非法      → asset-lock-hash-missing（空串绝不算「锁住了」）
//   - contentHash 与索引不符              → asset-lock-hash-mismatch
//   - 锁里的件号在索引里不存在            → asset-lock-unknown-part
//   - profileId 与索引 profile 不符       → asset-lock-profile-mismatch
//
// 允许两种写法：
//   parts: [{ partId, revision, contentHash? }]                       // 显式列出
//   parts: 'closure'                                                 // 由引擎按实际用件生成闭包
// 后者是便捷写法，生成结果与显式列出等价，且必须能通过同样严格的校验。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { contentHashOf } from '../assets-v1/index.js';

const HASH_RE = /^[0-9a-f]{64}$/;

/** 读取资产索引；找不到就返回 null（调用方决定是「无锁可用」还是「必须失败」） */
export function tryReadAssetIndex(assetsDir) {
  const f = path.join(assetsDir, 'index.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

// 索引登记的源文件（仓库相对路径）。index.json 记录的是「生成索引时读到的源文件哈希」；
// 源文件改过而没重跑 `assets compile`，索引就是过期的。拿过期索引核验 assetLock 等于
// 用旧定义验证新模型，比没有索引更危险，所以这里要把过期状态显式查出来。
const INDEX_SOURCE_FILES = ['catalog/parts.json', 'catalog/parts-ldraw.json', 'catalog/colors.json'];

/**
 * 读文件并归一化行尾后取哈希。
 *
 * 同一份内容在 Windows（autocrlf 检出为 CRLF）与 Linux（LF）下字节不同，但语义相同。
 * 索引里记的哈希是构建机上算的；若直接比原始字节，别的机器一检出就是「过期」，
 * 而实际上文件没改。归一化后比较的是内容而不是行尾风格。
 */
function contentSha256(file) {
  const text = fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 返回索引已过期的源文件列表；空数组表示索引与源文件一致。 */
export function staleAssetIndexSources(index, repoRoot) {
  const sources = index?.sourceHashes;
  if (!sources || typeof sources !== 'object' || !repoRoot) return [];
  const root = path.resolve(repoRoot);
  const stale = [];
  for (const [role, meta] of Object.entries(sources)) {
    if (!meta || typeof meta.file !== 'string' || typeof meta.sha256 !== 'string') continue;
    const rel = meta.file.split('\\').join('/');
    if (!INDEX_SOURCE_FILES.includes(rel)) { stale.push({ role, file: meta.file, reason: 'not-an-index-source' }); continue; }
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) { stale.push({ role, file: meta.file, reason: 'path-outside-repo' }); continue; }
    if (!fs.existsSync(target)) { stale.push({ role, file: meta.file, reason: 'source-missing' }); continue; }
    if (contentSha256(target) !== meta.sha256) stale.push({ role, file: meta.file, recorded: meta.sha256, current: contentSha256(target) });
  }
  return stale;
}

/**
 * 校验 assetLock。
 *
 * @param {object} source 0.3 装配源
 * @param {object} [opts] {
 *   index,            // 已读入的资产索引（优先于 assetsDir）
 *   assetsDir,        // 未给 index 时按目录读取
 *   requiredPartIds,  // 从装配图展开得到的实际用件集合（不给则只做自洽校验）
 *   requireIndex=true // 索引不可用时是否算失败；false 时降级为「无法核验」并显式标注
 * }
 * @returns {{ ok, errors, warnings, notices, resolved, closure, profileId, lockHash, indexAvailable }}
 */
export function checkAssetLock(source, opts = {}) {
  const errors = [];
  const warnings = [];
  const notices = [];
  const E = (code, msg, extra) => errors.push({ code, severity: 'error', msg, ...extra });
  const W = (code, msg, extra) => warnings.push({ code, severity: 'warning', msg, ...extra });

  const lock = source?.assetLock;
  if (!lock) {
    E('asset-lock-missing', '缺少 assetLock：无法确认零件 revision 与资源哈希，装配不可执行');
    return { ok: false, errors, warnings, notices, resolved: null, closure: null, lockHash: null, indexAvailable: false };
  }

  const index = opts.index || (opts.assetsDir ? tryReadAssetIndex(opts.assetsDir) : null);
  const requireIndex = opts.requireIndex !== false;
  const indexAvailable = Boolean(index && Array.isArray(index.parts));
  if (!indexAvailable && requireIndex) {
    E('asset-lock-index-unavailable', '资产索引不可用（catalog/assets-v1/index.json 缺失或损坏）：无法核验 assetLock；'
      + '请先运行 assets compile，或显式传 requireIndex:false 以标注「未核验」');
  }
  // 索引存在但源文件已改过（没重跑 assets compile）：索引里的 revision/contentHash
  // 反映的是旧定义，用它核验等于「用旧目录验证新模型」。这种情况按不可核验处理。
  const indexStale = indexAvailable && opts.repoRoot ? staleAssetIndexSources(index, opts.repoRoot) : [];
  if (indexStale.length) {
    E('asset-lock-index-stale', `资产索引已过期（${indexStale.map((s) => s.file).join('、')} 改动后未重跑 assets compile）：`
      + '索引内容不再反映当前零件定义，无法据此核验 assetLock');
  }

  const indexByPart = new Map();
  if (indexAvailable) for (const e of index.parts) indexByPart.set(String(e.partId), e);

  // —— parts 写法归一 ——
  let lockParts = lock.parts;
  if (lockParts === 'closure') {
    const need = [...(opts.requiredPartIds || [])];
    if (!need.length) {
      E('asset-lock-closure-empty', 'assetLock.parts="closure" 但没有可用的 requiredPartIds：无法推导闭包');
      lockParts = [];
    } else {
      lockParts = need.map((id) => {
        const e = indexByPart.get(String(id));
        return { partId: String(id), revision: e?.revision ?? null, contentHash: e?.contentHash ?? null };
      });
      notices.push({ code: 'asset-lock-closure', severity: 'notice', msg: `assetLock 以闭包形式生成，含 ${lockParts.length} 个件号` });
    }
  }
  if (!Array.isArray(lockParts)) {
    E('asset-lock-format', 'assetLock.parts 必须是数组，或字符串 "closure"');
    lockParts = [];
  }
  if (!lockParts.length) E('asset-lock-empty', 'assetLock.parts 为空：空锁等同于没有锁');

  const resolved = [];
  const seen = new Set();
  for (const p of lockParts) {
    const partId = p?.partId === undefined ? null : String(p.partId);
    if (!partId) { E('asset-lock-part-no-id', 'assetLock.parts 有条目缺少 partId'); continue; }
    if (seen.has(partId)) { E('asset-lock-part-dup', `assetLock.parts 重复列出零件 ${partId}`, { nodes: [partId] }); continue; }
    seen.add(partId);

    // revision：必须显式给，空串/缺失都不算「锁住了版本」
    const revision = typeof p.revision === 'string' ? p.revision.trim() : '';
    if (!revision) E('asset-lock-revision-missing', `零件 ${partId} 的 assetLock 条目缺 revision（空串不等于锁定）`, { nodes: [partId] });

    // contentHash：空串、非 64 位小写十六进制一律拒绝
    const rawHash = p.contentHash;
    const hash = typeof rawHash === 'string' ? rawHash.trim() : '';
    if (!hash) {
      E('asset-lock-hash-missing', `零件 ${partId} 的 assetLock 条目缺 contentHash（空串/缺失不算锁住内容）`, { nodes: [partId] });
    } else if (!HASH_RE.test(hash)) {
      E('asset-lock-hash-invalid', `零件 ${partId} 的 contentHash 不是 64 位小写十六进制：${hash}`, { nodes: [partId] });
    }

    if (!indexAvailable) { resolved.push({ partId, revision, contentHash: hash || null, verified: false }); continue; }

    const entry = indexByPart.get(partId);
    if (!entry) {
      E('asset-lock-unknown-part', `assetLock 里的零件 ${partId} 在资产索引中不存在`, { nodes: [partId] });
      resolved.push({ partId, revision, contentHash: hash || null, verified: false });
      continue;
    }
    if (revision && entry.revision !== revision) {
      E('asset-lock-revision-mismatch', `零件 ${partId} 的 revision 不符：锁 ${revision}，索引 ${entry.revision}`, { nodes: [partId] });
    }
    if (hash && entry.contentHash && HASH_RE.test(hash) && hash !== entry.contentHash) {
      E('asset-lock-hash-mismatch', `零件 ${partId} 的 contentHash 不符：锁 ${hash.slice(0, 16)}…，索引 ${String(entry.contentHash).slice(0, 16)}…`, { nodes: [partId] });
    }
    resolved.push({
      partId,
      revision: entry.revision,
      contentHash: entry.contentHash,
      verified: Boolean(revision && hash && revision === entry.revision && hash === entry.contentHash),
    });
  }

  // —— 覆盖性：实际用到的件必须全部在锁里 ——
  if (Array.isArray(opts.requiredPartIds)) {
    const need = new Set(opts.requiredPartIds.map(String));
    for (const id of need) {
      if (!seen.has(id)) E('asset-lock-incomplete', `任务实际用到零件 ${id}，但 assetLock 未列出`, { nodes: [id] });
    }
    for (const id of seen) {
      if (!need.has(id)) notices.push({ code: 'asset-lock-unused', severity: 'notice', msg: `assetLock 含未使用的零件 ${id}` });
    }
  }

  // —— profile ——
  let profileId = lock.profileId ?? null;
  if (!profileId) E('asset-lock-profile-missing', 'assetLock 缺 profileId：容差与配对规则未被锁定');
  else if (indexAvailable && index.profileId && index.profileId !== profileId) {
    E('asset-lock-profile-mismatch', `assetLock.profileId 不符：锁 ${profileId}，索引 ${index.profileId}`);
  }

  // —— lockHash：全部条目的确定性摘要，用于「同一 lock」的判据 ——
  const lockHash = contentHashOf({
    profileId,
    parts: [...resolved].sort((a, b) => a.partId.localeCompare(b.partId))
      .map((r) => ({ partId: r.partId, revision: r.revision, contentHash: r.contentHash })),
  });

  const verifiedCount = resolved.filter((r) => r.verified).length;
  if (indexAvailable && resolved.length && verifiedCount === 0 && !errors.length) {
    W('asset-lock-unverified', 'assetLock 条目均未带 contentHash，无法做内容级核验');
  }

  return {
    ok: errors.length === 0,
    errors, warnings, notices,
    resolved,
    closure: resolved.map((r) => ({ partId: r.partId, revision: r.revision, contentHash: r.contentHash })),
    profileId,
    lockHash,
    indexAvailable,
    verifiedCount,
    partCount: resolved.length,
  };
}

/**
 * 由资产索引与用件集合生成一个「可以直接用」的 assetLock。
 * 供 CLI 与夹具生成器使用：手写 lock 极易漏件，生成器保证闭包完整。
 */
export function buildAssetLock(index, requiredPartIds, profileId) {
  const byPart = new Map((index.parts || []).map((e) => [String(e.partId), e]));
  const missing = [];
  const parts = [];
  for (const id of [...new Set(requiredPartIds.map(String))].sort()) {
    const e = byPart.get(id);
    if (!e) { missing.push(id); continue; }
    parts.push({ partId: id, revision: e.revision, contentHash: e.contentHash });
  }
  return {
    assetLock: { profileId: profileId ?? index.profileId, indexVersion: index.version, parts },
    missing,
  };
}
