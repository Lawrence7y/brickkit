// Part Asset v1：把现有 catalog/parts.json + catalog/parts-ldraw.json 规范化成
// 「按件加载的版本化定义 + 全库索引 + 覆盖层」，并保持与 core 引擎完全一致的行为。
//
// 设计要点（对应 PRD §5）：
//   - 权威分离：原始目录（source）→ 规范化定义（definition）→ 覆盖（overrides），生效结果记合并来源
//   - 能力三分离：render / collide / assemble 各自独立判定，禁止一个 checked 代表三者
//   - 稳定接口 ID：由语义位置生成（见 ids.js），旧数组下标走 legacyIndex 固定映射
//   - 按需加载：loadDefinition(partId) 只读一个文件；不得要求加载全库
//   - 缓存键包含源几何 + 覆盖 + 转换器 + profile 哈希；输入变化自动失效
//
// 本模块不复制 core 的几何/连接算法：连接器位置一律调用 core.partConnectors，
// 保证「资产定义」与「引擎实际扣合」用的是同一套数。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { partConnectors, partBoxes, FORMAT as LEGACY_FORMAT } from '../core.js';
import {
  gridToLdu, makeConnectorId, makeLegacyIndex, connectorTypeOf,
  MATE_PROFILE_OF, dirToOrientationId, LDU_PER_STUD, LDU_PER_PLATE,
} from './ids.js';

export const ASSET_INDEX_FORMAT = 'brickkit-asset-index';
export const ASSET_INDEX_VERSION = '1.0.0';
export const PART_SCHEMA_VERSION = '1.0.0';
export const DEFINITION_CONVERTER = 'assets-v1/build-definition@1';

/** 默认装配 profile（PRD §5.3 建议初值；须先用正/错配对夹具验证后才能冻结） */
export const DEFAULT_PROFILE = {
  profileId: 'default-2026-10-26',
  version: '1.0.0',
  transformEpsLdu: 1e-6,
  connectorPositionTolLdu: 0.05,
  connectorAngleTolDeg: 0.1,
  collisionEpsLdu: 0.8,
  // core 的 boxesCollide 用「格/片」口径；这里显式记录换算来源，避免两套容差漂移
  legacyCollisionTol: { stud: 0.04, plate: 0.10 },
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256Json = (obj) => sha256(Buffer.from(JSON.stringify(obj), 'utf8'));

/**
 * 稳定内容哈希：只对语义字段排序后序列化，排除 recordedAt / generatedAt 等易变元数据。
 */
export function contentHashOf(obj) {
  const strip = (v) => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) {
        if (['recordedAt', 'generatedAt', 'checkedAt', 'extractedAt'].includes(k)) continue;
        out[k] = strip(v[k]);
      }
      return out;
    }
    return v;
  };
  return sha256Json(strip(obj));
}

// ---------------------------------------------------------------- 原始目录读取

/**
 * 读取并合并现有两个目录，保留来源标记。
 * curated（catalog/parts.json）优先于 ext（catalog/parts-ldraw.json）——与 CLI 的合并顺序一致。
 */
export function readRawCatalog(root, opts = {}) {
  const curatedPath = path.join(root, 'catalog/parts.json');
  const extPath = path.join(root, 'catalog/parts-ldraw.json');
  const colorsPath = path.join(root, 'catalog/colors.json');

  const curatedBuf = fs.readFileSync(curatedPath);
  const extBuf = fs.existsSync(extPath) ? fs.readFileSync(extPath) : null;
  const curated = JSON.parse(curatedBuf.toString('utf8'));
  const extDoc = extBuf ? JSON.parse(extBuf.toString('utf8')) : { parts: {} };
  const colors = JSON.parse(fs.readFileSync(colorsPath, 'utf8'));

  const merged = {};
  for (const [id, def] of Object.entries(extDoc.parts || {})) {
    merged[id] = { def, sourceType: 'extracted' };
  }
  for (const [id, def] of Object.entries(curated.parts || {})) {
    merged[id] = { def, sourceType: 'curated', overridesExtracted: Boolean(extDoc.parts?.[id]) };
  }
  return {
    merged,
    colors: colors.colors || {},
    sourceHashes: {
      curated: { file: 'catalog/parts.json', sha256: sha256(curatedBuf), bytes: curatedBuf.length },
      extracted: extBuf ? { file: 'catalog/parts-ldraw.json', sha256: sha256(extBuf), bytes: extBuf.length } : null,
      colors: { file: 'catalog/colors.json', sha256: sha256(fs.readFileSync(colorsPath)), bytes: fs.statSync(colorsPath).size },
    },
    catalogMeta: { format: curated.format, version: curated.version, units: curated.units },
  };
}

// ---------------------------------------------------------------- 能力三分离

/**
 * 从核心目录条目推导三类能力，逐项给出 state 与理由。
 * 关键：不允许一个 checked:true 同时代表 render/collide/assemble。
 *
 * @param {object} def 核心目录条目
 * @param {object} ctx { hasDat?: boolean, datSha256?: string, connectorCount?: number }
 */
export function deriveCapabilities(def, ctx = {}) {
  // —— 渲染 ——
  const hasDat = Boolean(ctx.hasDat);
  const render = hasDat
    ? { state: 'measured', geometryKind: 'ldraw-mesh', note: 'catalog/ldraw 中存在对应 .dat，渲染可走官方几何' }
    : { state: 'inferred', geometryKind: 'parametric', note: '无 .dat 镜像；只能按 kind/size/h 参数化近似，与真实外形有差异' };

  // —— 碰撞 ——
  // core 的 partBoxes 对大部分件按 kind 生成单盒；带 boxes 的凹形件是多盒分解；
  // 缺 vH/dir 的 bracket 会抛错（P0-b 守卫），这类件碰撞不可信。
  let collide;
  if (def.occupies === false) {
    collide = { state: 'verified', boxCount: 0, note: '声明不占体积（occupies:false），碰撞视为空集' };
  } else if (def.kind === 'bracket' && (typeof def.vH !== 'number' || (def.dir !== 'up' && def.dir !== 'down'))) {
    collide = { state: 'unsupported', boxCount: 0, note: 'bracket 缺 vH/dir，partBoxes 会拒绝生成包围盒' };
  } else if (Array.isArray(def.boxes) && def.boxes.length) {
    collide = {
      state: def.boxesSource === 'measured' ? 'measured' : 'inferred',
      boxCount: def.boxes.length,
      note: `多盒分解（boxesSource=${def.boxesSource || '未标注'}）；空腔留空由 validate 的 3D 盒检查负责`,
    };
  } else if (def.needsManualBoxes) {
    collide = { state: 'unsupported', boxCount: 0, note: `需手工多盒分解：${def.needsManualBoxesReason || '未给原因'}` };
  } else {
    collide = {
      state: 'inferred',
      boxCount: 1,
      note: '按 kind/size/h 生成的单实心盒；凹形件会高估体积（保守，不产生假阴性穿模，但可能误报）',
    };
  }

  // —— 装配 ——
  // 有真实连接器且类型可归类 → measured；无连接器 → unsupported（不能当作可装配）
  let assemble;
  if (ctx.connectorCount === 0) {
    assemble = { state: 'unsupported', verifiedConnectorTypes: [], note: '未生成任何连接器；该件不能参与装配求解' };
  } else if (ctx.connectorCount === undefined) {
    assemble = { state: 'unknown', verifiedConnectorTypes: [], note: '未计算连接器' };
  } else {
    const types = [...new Set((ctx.connectorTypes || []))];
    assemble = {
      state: ctx.assembleVerified ? 'verified' : 'measured',
      verifiedConnectorTypes: types,
      note: ctx.assembleVerified
        ? '有通过的正/负配对夹具'
        : '连接器由 .dat/目录实测生成，尚未跑配对夹具，除已列入 fixture 的类型外不得宣称 verified',
    };
  }
  return { render, collide, assemble };
}

// ---------------------------------------------------------------- 单件定义

/**
 * 生成单个零件的规范化定义（LDU 统一空间 + 稳定接口 ID + 能力三分离）。
 *
 * @param {string} partId
 * @param {object} def 核心目录条目
 * @param {object} opts { sourceType, sourceHashes, colors, overrides, profile, datInfo }
 */
export function buildDefinition(partId, def, opts = {}) {
  const profile = opts.profile || DEFAULT_PROFILE;
  const sourceType = opts.sourceType || 'extracted';

  // 用中心原点探针调用 core 的连接器生成，保证与引擎同一套数
  const probe = { id: '_probe', part: partId, color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 };
  let conn;
  try {
    conn = partConnectors(probe, def);
  } catch (e) {
    conn = null;
  }

  // —— 连接器紧凑存储 ——
  // 全库 21.3 万个连接器，逐条展开成完整对象约 162 MB（PRD §5.5 明确要求按需打包与体积控制）。
  // 这里按 (type, role, orientationId, kind, dir, mateProfile) 分组，组内只存
  // 位置三元组 + 旧数组下标；完整接口对象由 expandConnectorGroups() 在运行时按需生成，
  // ID 由语义位置确定，与数组顺序无关。
  const raw = [];
  const warnings = [];
  if (conn) {
    const collect = (entry, collection) => {
      const mapped = connectorTypeOf(entry);
      if (!mapped) {
        warnings.push(`连接器 ${entry.label || entry.kind}#${entry.index} 无法归类为契约类型（kind=${entry.kind}）`);
        return;
      }
      const orientationId = dirToOrientationId(entry.dir || '+y');
      if (orientationId === null) {
        warnings.push(`连接器 ${entry.label || entry.kind} 朝向 ${entry.dir} 无法映射到 24 姿态表`);
        return;
      }
      raw.push({
        type: mapped.type,
        role: mapped.role,
        orientationId,
        kind: entry.kind,
        dir: entry.dir || '+y',
        axis: entry.axis,
        collection,
        index: entry.index,
        pos: gridToLdu(entry.pos),
      });
    };
    for (const s of conn.studs) collect(s, 'studs');
    for (const r of conn.receptors) collect(r, 'receptors');
  }
  const grouped = groupConnectors(raw);
  const connectorGroups = grouped.groups;
  const connectorCount = raw.length;
  for (const w of grouped.warnings) warnings.push(w);

  // 碰撞盒：转成 LDU
  let boxesLdu = [];
  let boxesThrew = null;
  try {
    boxesLdu = partBoxes(probe, def).map((b) => [
      r6(b.x0 * LDU_PER_STUD), r6(b.x1 * LDU_PER_STUD),
      r6(b.y0 * LDU_PER_PLATE), r6(b.y1 * LDU_PER_PLATE),
      r6(b.z0 * LDU_PER_STUD), r6(b.z1 * LDU_PER_STUD),
    ]);
  } catch (e) {
    boxesThrew = e.message;
  }

  const capabilities = deriveCapabilities(def, {
    hasDat: Boolean(opts.datInfo),
    connectorCount,
    connectorTypes: [...new Set(raw.map((c) => c.type))],
    assembleVerified: Boolean(opts.assembleVerified),
  });
  if (boxesThrew) capabilities.collide = { state: 'unsupported', boxCount: 0, note: `partBoxes 抛错：${boxesThrew}` };

  const definition = {
    schemaVersion: PART_SCHEMA_VERSION,
    partId,
    revision: opts.revision || `r1-${sourceType}`,
    aliases: buildAliases(partId, def, opts),
    name: def.name || '',
    nameZh: def.zh || '',
    category: def.category || def.kind || '',
    source: {
      kind: sourceType === 'curated' ? 'catalog-entry' : 'ldraw-dat',
      ref: sourceType === 'curated' ? 'catalog/parts.json' : 'catalog/parts-ldraw.json',
      sha256: opts.sourceHashes?.[sourceType === 'curated' ? 'curated' : 'extracted']?.sha256,
      license: 'CC BY 2.0',
      licenseUrl: 'https://library.ldraw.org/license',
      extractor: DEFINITION_CONVERTER,
      note: def.source || def.auto ? String(def.source || 'LDraw 自动提取') : '',
    },
    canonicalFrame: {
      units: 'LDU',
      lduPerStud: LDU_PER_STUD,
      lduPerPlate: LDU_PER_PLATE,
      lduPerBrick: 24,
      upAxis: '+y',
      frontAxis: '+z',
      origin: def.wheel ? 'wheel-center' : 'bbox-bottom-center',
      sourceToCanonical: sourceToCanonical(def),
    },
    geometry: {
      kind: opts.datInfo ? 'ldraw-mesh' : 'parametric',
      sizeStud: def.size || [1, 1],
      heightPlate: def.h || 1,
      ...(opts.datInfo ? { assetRef: { datFile: opts.datInfo.file, sha256: opts.datInfo.sha256, bytes: opts.datInfo.bytes } } : {}),
      ...(boxesLdu.length ? { bboxLdu: unionBox(boxesLdu) } : {}),
    },
    collision: {
      shape: boxesLdu.length ? 'boxes' : 'none',
      state: capabilities.collide.state,
      boxes: boxesLdu,
      ...(def.boxesCoverage !== undefined ? { coverage: def.boxesCoverage } : {}),
      ...(def.occupies === false ? { occupiesVolume: false } : {}),
      evidence: {
        grade: def.boxesSource === 'measured' ? 'measured' : 'inferred',
        method: Array.isArray(def.boxes) ? `目录 boxes 多盒分解（${def.boxesSource || '未标注'}）` : '按 kind/size/h 单盒推导',
        recordedAt: opts.recordedAt || new Date().toISOString(),
        recordedBy: 'assets-v1/build-definition',
      },
    },
    // 紧凑分组存磁盘；运行时用 expandConnectorGroups() 展开成完整接口对象
    connectorCount,
    connectorGroups,
    capabilities,
    provenance: {
      grade: sourceType === 'curated' ? 'measured' : 'inferred',
      method: sourceType === 'curated' ? '精选目录（人工核对 + 官方 .dat 验证）' : 'LDraw 官方 .dat 自动提取',
      evidenceRefs: opts.datInfo ? [opts.datInfo.file] : [],
      recordedAt: opts.recordedAt || new Date().toISOString(),
      recordedBy: 'assets-v1/build-definition',
    },
    ...(opts.overrides?.length ? { overrides: opts.overrides } : {}),
    _buildWarnings: warnings,
  };
  definition.contentHash = contentHashOf(definition);
  return definition;
}

function r6(v) { return Math.round(v * 1e6) / 1e6 || 0; }

/**
 * 连接器紧凑编码：按 (type, role, orientationId, kind, dir, axis, mateProfile) 分组。
 * 组内每个连接器只保留 [x,y,z] LDU 位置与该连接器在 core 数组中的下标。
 *
 * 磁盘格式（每组）：
 *   { t: type, r: role, o: orientationId, k: kind, d: dir, x: axis, mp: mateProfile,
 *     items: [[x,y,z,collectionIndex,index], ...] }
 * collectionIndex: 0=studs 1=receptors。
 *
 * 为什么可以分组：同组内所有字段（除位置与数组下标）完全相同，ID 由 type + 位置确定。
 * 这一步把 782（50×50 底板）从 1.99 MB 压到约 40 KB。
 */
export function groupConnectors(raw) {
  const warnings = [];
  const groups = new Map();
  for (const c of raw) {
    const mp = MATE_PROFILE_OF[c.type];
    const key = [c.type, c.role, c.orientationId, c.kind, c.dir, c.axis ?? '', mp].join('|');
    let g = groups.get(key);
    if (!g) {
      g = { t: c.type, r: c.role, o: c.orientationId, k: c.kind, d: c.dir, mp, items: [] };
      if (c.axis !== undefined) g.x = c.axis;
      groups.set(key, g);
    }
    g.items.push([c.pos[0], c.pos[1], c.pos[2], c.collection === 'studs' ? 0 : 1, c.index]);
  }
  // 组顺序按 key 排序，保证重建确定性
  const sorted = [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, g]) => g);
  return { groups: sorted, warnings };
}

/**
 * 展开紧凑分组为完整接口对象数组（运行时用）。
 * 稳定 ID 生成规则与逐条构建完全一致：type + 语义位置（+ 面标记），
 * 同零件上位置完全重复的接口按 (collection, index) 排序后加 -b/-c 后缀。
 *
 * @param {object} definition 含 connectorGroups（紧凑）或 connectors（旧完整数组）
 * @param {object} [opts] { fixtureRefs, fixtureStats }
 */
export function expandConnectorGroups(definition, opts = {}) {
  const out = [];
  const groups = definition.connectorGroups;
  if (!groups) {
    // 兼容：旧格式（完整 connectors 数组）
    return (definition.connectors || []).map((c) => ({ ...c }));
  }
  for (const g of groups) {
    for (const it of g.items) {
      const [x, y, z, coll, index] = it;
      const ldu = [x, y, z];
      const face = g.d && g.d !== '+y' ? g.d : undefined;
      const id = makeConnectorId(g.t, ldu, face ? { face } : {});
      out.push({
        id,
        type: g.t,
        role: g.r,
        frame: { translationLdu: ldu, orientationId: g.o },
        mateProfile: g.mp,
        capacity: 1,
        _core: { kind: g.k, dir: g.d || '+y', axis: g.x },
        legacyIndex: makeLegacyIndex(coll === 0 ? 'studs' : 'receptors', index),
        verification: {
          status: definition.provenance?.grade === 'measured' ? 'measured' : 'inferred',
          evidenceRefs: opts.fixtureRefs?.[id] || [],
          positiveCases: opts.fixtureStats?.[id]?.positive ?? 0,
          negativeCases: opts.fixtureStats?.[id]?.negative ?? 0,
          note: definition.provenance?.grade === 'measured'
            ? '精选目录条目，尺寸经 catalog-verify / 审计流程'
            : 'LDraw 自动提取条目，几何来自官方 .dat，配对夹具未跑',
        },
      });
    }
  }
  // 同语义位置去重后缀（源数据真实存在重复，例如 12622 的 16 组共面凸点）
  const buckets = new Map();
  for (const c of out) {
    const k = `${c.type}|${c.frame.translationLdu.join(',')}`;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(c);
  }
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    const order = { studs: 0, receptors: 1 };
    list.sort((a, b) => (order[a.legacyIndex.collection] - order[b.legacyIndex.collection]) || (a.legacyIndex.index - b.legacyIndex.index));
    list.forEach((c, i) => { if (i > 0) { c.baseId = c.id; c.id = `${c.id}-${suffixFor(i)}`; } });
  }
  return out;
}

/** 定义内连接器总数（不展开） */
export function connectorCountOf(definition) {
  if (definition.connectorCount !== undefined) return definition.connectorCount;
  if (definition.connectorGroups) return definition.connectorGroups.reduce((s, g) => s + g.items.length, 0);
  return (definition.connectors || []).length;
}

/** 定义内出现的连接器类型集合（不展开） */
export function connectorTypesOf(definition) {
  return [...new Set((definition.connectorGroups || []).map((g) => g.t))];
}

/**
 * 覆盖层会替换 connectors 时，把完整数组重新压成紧凑分组，保持磁盘格式统一。
 */
export function compactConnectors(fullArray) {
  const raw = fullArray.map((c) => ({
    type: c.type,
    role: c.role,
    orientationId: c.frame?.orientationId ?? 0,
    kind: c._core?.kind ?? 'top',
    dir: c._core?.dir ?? '+y',
    axis: c._core?.axis,
    collection: c.legacyIndex?.collection ?? 'studs',
    index: c.legacyIndex?.index ?? 0,
    pos: c.frame?.translationLdu ?? [0, 0, 0],
  }));
  return groupConnectors(raw).groups;
}

/** 去重后缀：0→a（不写）、1→b、2→c … 25→z、26→aa。与数组顺序无关（调用方先按 legacyIndex 排序）。 */
function suffixFor(i) {
  let s = '';
  let n = i;
  do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

function unionBox(boxes) {
  const out = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (const b of boxes) {
    out[0] = Math.min(out[0], b[0]); out[1] = Math.max(out[1], b[1]);
    out[2] = Math.min(out[2], b[2]); out[3] = Math.max(out[3], b[3]);
    out[4] = Math.min(out[4], b[4]); out[5] = Math.max(out[5], b[5]);
  }
  return out.map(r6);
}

function buildAliases(partId, def, opts) {
  const out = [];
  // 精选目录的 ldraw 官方编号可能与目录 id 不同（取自 catalog-verify 结果）；这里只记录显式证据
  if (def.officialId && def.officialId !== partId) {
    out.push({ id: String(def.officialId), relation: 'renumber', note: 'officialId 与目录 id 不同' });
  }
  if (Array.isArray(opts.aliases)) out.push(...opts.aliases);
  return out;
}

/**
 * LDraw 原始空间 → BrickKit 规范空间的基变换。
 *
 * LDraw：右手系，+y 向上，-z 为正视方向（零件正面朝 -z）；单位 1 LDU。
 * BrickKit：右手系，+y 向上，+z 为正面。
 * 因此只需绕 y 轴 180°： (x, y, z)_ldraw → (-x, y, -z)_bk。
 * 行列式 = (-1)·1·(-1) = +1 → 纯旋转，无镜像。
 */
export function sourceToCanonical(def) {
  return {
    matrix: [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    translationLdu: [0, 0, 0],
    determinant: 1,
    note: 'LDraw 正面朝 -z，BrickKit 正面朝 +z；绕 y 轴 180°。det=+1 为纯旋转（无镜像）。' +
      '若要叠加 ldrawOrigin 平移，由调用方按 ldrawOrigin*20 LDU 另行应用，不并入本矩阵。',
  };
}

// ---------------------------------------------------------------- 覆盖层

/**
 * 应用覆盖链。每一层只改声明字段，并记录来源；baseRevision 不匹配直接拒绝（防覆盖错版本）。
 * 返回 { definition, applied:[], rejected:[] }
 */
export function applyOverrides(definition, overrideList = []) {
  const applied = [], rejected = [];
  let out = JSON.parse(JSON.stringify(definition));
  let revision = out.revision;
  for (const ov of overrideList) {
    if (ov.partId !== out.partId) { rejected.push({ override: ov, reason: `partId 不匹配：${ov.partId} ≠ ${out.partId}` }); continue; }
    if (ov.baseRevision !== revision) {
      rejected.push({ override: ov, reason: `baseRevision 不匹配：期望 ${revision}，覆盖声明 ${ov.baseRevision}` });
      continue;
    }
    // 只允许覆盖这些顶层字段
    const ALLOWED = new Set(['collision', 'connectors', 'connectorGroups', 'capabilities', 'canonicalFrame', 'geometry', 'aliases']);
    for (const [k, v] of Object.entries(ov.fields || {})) {
      if (!ALLOWED.has(k)) { rejected.push({ override: ov, reason: `字段 ${k} 不允许被覆盖` }); continue; }
      // connectors 允许用完整数组书写（人写覆盖更直观），落盘前压成紧凑分组
      if (k === 'connectors') {
        out.connectorGroups = compactConnectors(v);
        out.connectorCount = v.length;
        delete out.connectors;
        continue;
      }
      if (k === 'connectorGroups') {
        out.connectorGroups = JSON.parse(JSON.stringify(v));
        out.connectorCount = out.connectorGroups.reduce((s, g) => s + (g.items?.length || 0), 0);
        continue;
      }
      out[k] = JSON.parse(JSON.stringify(v));
    }
    out.overrides = [...(out.overrides || []), ov];
    revision = `${revision}+${ov.author || 'anon'}@${ov.recordedAt || 'undated'}`.slice(0, 120);
    out.revision = revision;
    applied.push({ partId: ov.partId, fields: Object.keys(ov.fields || {}), reason: ov.reason, author: ov.author });
  }
  if (applied.length) out.contentHash = contentHashOf(out);
  return { definition: out, applied, rejected };
}

// ---------------------------------------------------------------- 索引与按件加载

/**
 * 构建全库索引（不含各件完整定义）。索引体积必须远小于全库定义总和。
 * 返回 { index, definitions: Map<partId, definition>, stats }
 */
export function buildIndex(root, opts = {}) {
  const raw = readRawCatalog(root);
  const datIndex = opts.datIndex || readDatIndex(root);
  const overridesByPart = opts.overridesByPart || {};
  const profile = opts.profile || DEFAULT_PROFILE;
  const partIds = Object.keys(raw.merged).sort();

  const definitions = new Map();
  const entries = [];
  const buildWarnings = [];
  for (const partId of partIds) {
    const { def, sourceType } = raw.merged[partId];
    const datInfo = datIndex[partId] || null;
    let definition = buildDefinition(partId, def, {
      sourceType,
      sourceHashes: raw.sourceHashes,
      datInfo,
      profile,
      fixtureRefs: opts.fixtureRefs,
      fixtureStats: opts.fixtureStats,
      assembleVerified: Boolean(opts.verifiedParts?.has?.(partId) || opts.verifiedParts?.includes?.(partId)),
      recordedAt: opts.recordedAt,
    });
    if (definition._buildWarnings?.length) buildWarnings.push({ partId, warnings: definition._buildWarnings });
    const ovs = overridesByPart[partId];
    if (ovs?.length) {
      const res = applyOverrides(definition, ovs);
      definition = res.definition;
      if (res.rejected.length) buildWarnings.push({ partId, warnings: res.rejected.map((r) => `覆盖被拒绝：${r.reason}`) });
    }
    definitions.set(partId, definition);
    entries.push({
      partId,
      revision: definition.revision,
      contentHash: definition.contentHash,
      definitionFile: `definitions/${partId}.json`,
      aliases: (definition.aliases || []).map((a) => a.id),
      capabilities: definition.capabilities,
      connectorCount: connectorCountOf(definition),
      sourceType,
    });
  }

  const index = {
    format: ASSET_INDEX_FORMAT,
    version: ASSET_INDEX_VERSION,
    generatedBy: 'src/core/assets-v1/index.js#buildIndex',
    generatedAt: opts.recordedAt || new Date().toISOString(),
    profileId: profile.profileId,
    sourceHashes: raw.sourceHashes,
    parts: entries,
  };
  const stats = {
    parts: entries.length,
    bySourceType: countBy(entries, (e) => e.sourceType),
    byRender: countBy(entries, (e) => e.capabilities.render.state),
    byCollide: countBy(entries, (e) => e.capabilities.collide.state),
    byAssemble: countBy(entries, (e) => e.capabilities.assemble.state),
    withDat: entries.filter((e) => e.capabilities.render.geometryKind === 'ldraw-mesh').length,
    withConnectors: entries.filter((e) => e.connectorCount > 0).length,
    buildWarnings: buildWarnings.length,
  };
  return { index, definitions, stats, buildWarnings, profile, sourceHashes: raw.sourceHashes };
}

function countBy(arr, fn) {
  const m = {};
  for (const x of arr) { const k = fn(x) ?? 'unknown'; m[k] = (m[k] || 0) + 1; }
  return m;
}

/** 读取 catalog/ldraw/manifest.json 形成 partId → { file, sha256, bytes } */
export function readDatIndex(root) {
  const manifestPath = path.join(root, 'catalog/ldraw/manifest.json');
  if (!fs.existsSync(manifestPath)) return {};
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const out = {};
  for (const [id, v] of Object.entries(m.parts || {})) {
    if (v?.file) out[id] = { file: `catalog/ldraw/${v.file}`, sha256: v.sha256, bytes: v.bytes, desc: v.desc };
  }
  return out;
}

/**
 * 按件加载：只读该件的定义文件。
 * 若给了 overridesDir 则合并覆盖（覆盖单独存放，不写回原始定义）。
 */
export function loadDefinition(assetsDir, partId, opts = {}) {
  const file = path.join(assetsDir, 'definitions', `${partId}.json`);
  if (!fs.existsSync(file)) {
    const err = new Error(`资产缺失：找不到零件 ${partId} 的定义（${file}）`);
    err.code = 'missing-asset';
    err.partId = partId;
    throw err;
  }
  let definition = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (opts.overridesDir) {
    const ovFile = path.join(opts.overridesDir, `${partId}.json`);
    if (fs.existsSync(ovFile)) {
      const ov = JSON.parse(fs.readFileSync(ovFile, 'utf8'));
      const list = Array.isArray(ov) ? ov : [ov];
      const res = applyOverrides(definition, list);
      if (res.rejected.length) {
        const err = new Error(`零件 ${partId} 的覆盖被拒绝：${res.rejected.map((r) => r.reason).join('; ')}`);
        err.code = 'override-rejected';
        throw err;
      }
      definition = res.definition;
    }
  }
  const mv = String(definition.schemaVersion || '').split('.')[0];
  if (mv !== String(PART_SCHEMA_VERSION).split('.')[0]) {
    const err = new Error(`零件 ${partId} 的 schemaVersion ${definition.schemaVersion} 主版本未知，拒绝装配执行`);
    err.code = 'schema-version';
    throw err;
  }
  return definition;
}

/**
 * 把 Part Asset 定义投影回 core 需要的 catalog 条目（兼容层）。
 * core 的 partConnectors/partBoxes 只认「格/片」目录口径，故这里保持原目录条目不变，
 * 只额外挂上稳定 ID 映射 _connectorIds（供 actions-v1 做 ID ↔ 下标转换）。
 */
export function toCoreCatalog(root, opts = {}) {
  const raw = readRawCatalog(root);
  const parts = {};
  for (const [id, { def }] of Object.entries(raw.merged)) parts[id] = def;
  return { parts, colors: raw.colors, _sourceHashes: raw.sourceHashes, _raw: raw };
}

/**
 * 为零件建立「稳定 ID ↔ core 数组下标」双向映射。
 * 每次调用都重新用 core.partConnectors 计算位置，再与定义里的接口对照；
 * 对不上说明定义过期（源几何或转换器变更），直接报错而不是静默返回旧映射。
 */
export function connectorIdMap(definition, coreDef, instancePose = { at: [0, 0, 0], rot: 0, up: '+y', snot: 0 }) {
  const probe = { id: '_probe', part: definition.partId, color: 0, ...instancePose };
  const conn = partConnectors(probe, coreDef);
  const expanded = expandConnectorGroups(definition);
  const byId = new Map();
  const idToLegacy = new Map();
  const legacyToId = new Map();
  for (const c of expanded) {
    byId.set(c.id, c);
    if (c.legacyIndex) {
      idToLegacy.set(c.id, c.legacyIndex);
      legacyToId.set(`${c.legacyIndex.collection}:${c.legacyIndex.index}`, c.id);
    }
  }
  // 校验：定义里的每个接口在 core 当前计算中确实存在同位置同类型的连接器
  const problems = [];
  const collections = { studs: conn.studs, receptors: conn.receptors };
  for (const c of expanded) {
    const li = c.legacyIndex;
    if (!li) continue;
    const entry = collections[li.collection]?.[li.index];
    if (!entry) { problems.push(`接口 ${c.id} 的 legacyIndex ${li.collection}[${li.index}] 在当前 core 计算中不存在`); continue; }
    const ldu = gridToLdu(entry.pos);
    const d = Math.max(...ldu.map((v, i) => Math.abs(v - c.frame.translationLdu[i])));
    if (d > DEFAULT_PROFILE.connectorPositionTolLdu) {
      problems.push(`接口 ${c.id} 位置漂移 ${d} LDU（超出容差 ${DEFAULT_PROFILE.connectorPositionTolLdu}）：可能是源几何或转换器已变更，需重建定义`);
    }
  }
  return { byId, idToLegacy, legacyToId, problems, currentConnectors: conn };
}
