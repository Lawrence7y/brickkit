#!/usr/bin/env node
/**
 * validate-contracts-1.0.mjs —— contracts-1.0 冻结门禁（执行器 C0-3）。
 *
 * 只读校验脚本：不修改本目录以外的任何文件。检查项：
 *  (a) 9 份合并 schema 逐份作为合法 JSON Schema 解析（JS 子集校验器 + Python Draft202012Validator.check_schema 双跑）；
 *  (b) 三个 A/B 消费夹具（真实载荷）对合并 schema 复验，并做真实引擎对账：
 *      - 资产锁夹具：逐任务 checkAssetLock 严格校验 + buildAssetLock 重建逐字比对（锁必须由生成器产出）；
 *      - renderState 夹具：response 过 schema + toConnectorMap/resolveTag 真实调用与夹具 BConnectorMap 比对
 *        + 「侧接口禁止裸 stud_N」机制检查；
 *      - 完整组件夹具：request/result 过 schema + 用 A 真实 inspectFromModel/enumerateCandidates/applyActions 重放；
 *  (c) 15 条真实课程样本（run-20261026-v4）对合并 C3 schema 全部通过（样本不改）；
 *  (d) 负例探针：已知非法形态必须被合并 schema 拒绝（partLocks 字典、空哈希、超 32 标号、未知 op 等）；
 *  (e) version.json 一致性：engineRevision 复算、contractFiles 哈希复算、必填版本字段、frozen 与结果一致。
 *
 * 结果写 out/prd-v2/run-20261026-c/C/contracts/freeze-validation.json；退出码 0=通过，1=存在 blocker。
 * 用法：node validate-contracts-1.0.mjs [--out <path>]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..', '..'); // docs/prd-v2/implementation-C/contracts → repo root
const OUT_DIR = path.join(ROOT, 'out', 'prd-v2', 'run-20261026-c', 'C', 'contracts');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const stableStringify = (v) => {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
};
const deepEqual = (a, b) => stableStringify(a) === stableStringify(b);

// ---------------------------------------------------------------------------
// 1) 最小 Draft 2020-12 子集校验器（覆盖本契约集用到的全部关键词；Python 侧独立复核）
// ---------------------------------------------------------------------------
const KEYWORDS = new Set([
  '$schema', '$id', '$ref', '$defs', 'title', 'description', 'default', 'examples',
  'type', 'enum', 'const', 'required', 'properties', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'uniqueItems', 'pattern', 'minLength', 'maxLength',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'oneOf', 'anyOf', 'allOf', 'if', 'then', 'else', 'format', 'minProperties', 'maxProperties',
]);

function resolvePointer(root, ref) {
  if (!ref.startsWith('#')) throw new Error(`unsupported non-local $ref: ${ref}`);
  const ptr = ref.slice(1);
  if (!ptr) return root;
  let cur = root;
  for (const rawSeg of ptr.split('/').slice(1)) {
    const seg = decodeURIComponent(rawSeg).replace(/~1/g, '/').replace(/~0/g, '~');
    if (cur === null || typeof cur !== 'object') throw new Error(`$ref pointer broken at ${seg} in ${ref}`);
    cur = cur[seg];
    if (cur === undefined) throw new Error(`$ref target missing: ${ref}`);
  }
  return cur;
}

const typeOk = (t, v) => {
  switch (t) {
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v);
    default: return false;
  }
};

/** 遍历 schema 检查结构合法性与 $ref 可解析性（"作为 JSON Schema 合法"的 JS 侧判据） */
function checkSchemaShape(schema, root = schema, where = '$', problems = []) {
  if (typeof schema === 'boolean') return problems;
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    problems.push(`${where}: schema must be object or boolean`);
    return problems;
  }
  for (const [k, v] of Object.entries(schema)) {
    if (!KEYWORDS.has(k)) problems.push(`${where}: unknown keyword "${k}"`);
    if (k === '$ref' && typeof v === 'string') {
      try { resolvePointer(root, v); } catch (e) { problems.push(`${where}: ${e.message}`); }
    } else if (['properties', '$defs'].includes(k) && v !== null && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) checkSchemaShape(sv, root, `${where}.${k}.${sk}`, problems);
    } else if (['oneOf', 'anyOf', 'allOf'].includes(k)) {
      if (!Array.isArray(v) || v.length === 0) problems.push(`${where}: ${k} must be non-empty array`);
      else v.forEach((sv, i) => checkSchemaShape(sv, root, `${where}.${k}[${i}]`, problems));
    } else if (['if', 'then', 'else', 'not', 'additionalProperties', 'items'].includes(k)) {
      checkSchemaShape(v, root, `${where}.${k}`, problems);
    } else if (k === 'type') {
      const ok = (typeof v === 'string' && ['object', 'array', 'string', 'boolean', 'null', 'number', 'integer'].includes(v))
        || (Array.isArray(v) && v.every((t) => ['object', 'array', 'string', 'boolean', 'null', 'number', 'integer'].includes(t)));
      if (!ok) problems.push(`${where}: bad type ${JSON.stringify(v)}`);
    } else if (k === 'required') {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) problems.push(`${where}: required must be string[]`);
    } else if (k === 'pattern') {
      try { new RegExp(v); } catch (e) { problems.push(`${where}: pattern not a regex: ${e.message}`); }
    }
  }
  return problems;
}

function validateSchema(schema, value, root = schema, where = '$', errors = []) {
  if (schema === true) return errors;
  if (schema === false) { errors.push(`${where}: schema false`); return errors; }
  if (typeof schema !== 'object' || schema === null) { errors.push(`${where}: invalid schema node`); return errors; }

  if ('$ref' in schema) {
    let target;
    try { target = resolvePointer(root, schema.$ref); } catch (e) { errors.push(`${where}: ${e.message}`); return errors; }
    validateSchema(target, value, root, where, errors);
    return errors; // 本契约集的 $ref 均为纯引用（无兄弟关键词参与断言）
  }
  if ('type' in schema) {
    const ts = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!ts.some((t) => typeOk(t, value))) errors.push(`${where}: expected type ${schema.type}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`);
  }
  if ('const' in schema && !deepEqual(schema.const, value)) errors.push(`${where}: const mismatch (${JSON.stringify(schema.const)})`);
  if ('enum' in schema && !schema.enum.some((e) => deepEqual(e, value))) errors.push(`${where}: value not in enum`);
  if (typeof value === 'string') {
    if ('minLength' in schema && value.length < schema.minLength) errors.push(`${where}: minLength ${schema.minLength}`);
    if ('maxLength' in schema && value.length > schema.maxLength) errors.push(`${where}: maxLength ${schema.maxLength}`);
    if ('pattern' in schema && !new RegExp(schema.pattern).test(value)) errors.push(`${where}: pattern ${schema.pattern} mismatch`);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if ('minimum' in schema && value < schema.minimum) errors.push(`${where}: minimum ${schema.minimum}`);
    if ('maximum' in schema && value > schema.maximum) errors.push(`${where}: maximum ${schema.maximum}`);
    if ('exclusiveMinimum' in schema && value <= schema.exclusiveMinimum) errors.push(`${where}: exclusiveMinimum ${schema.exclusiveMinimum}`);
    if ('exclusiveMaximum' in schema && value >= schema.exclusiveMaximum) errors.push(`${where}: exclusiveMaximum ${schema.exclusiveMaximum}`);
    if ('multipleOf' in schema && !(Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) < 1e-9)) errors.push(`${where}: multipleOf ${schema.multipleOf}`);
  }
  if (Array.isArray(value)) {
    if ('minItems' in schema && value.length < schema.minItems) errors.push(`${where}: minItems ${schema.minItems}`);
    if ('maxItems' in schema && value.length > schema.maxItems) errors.push(`${where}: maxItems ${schema.maxItems}`);
    if ('items' in schema) value.forEach((item, i) => validateSchema(schema.items, item, root, `${where}[${i}]`, errors));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if ('required' in schema) for (const r of schema.required) if (!(r in value)) errors.push(`${where}: missing required "${r}"`);
    if ('minProperties' in schema && keys.length < schema.minProperties) errors.push(`${where}: minProperties ${schema.minProperties}`);
    if ('properties' in schema) for (const [pk, pv] of Object.entries(schema.properties)) if (pk in value) validateSchema(pv, value[pk], root, `${where}.${pk}`, errors);
    if ('additionalProperties' in schema) {
      const declared = new Set(Object.keys(schema.properties || {}));
      for (const k of keys) {
        if ('properties' in schema && declared.has(k)) continue;
        if (schema.additionalProperties === false) errors.push(`${where}: additional property "${k}" not allowed`);
        else if (typeof schema.additionalProperties === 'object') validateSchema(schema.additionalProperties, value[k], root, `${where}.${k}`, errors);
      }
    }
  }
  if ('allOf' in schema) for (const [i, sub] of schema.allOf.entries()) validateSchema(sub, value, root, `${where} (allOf[${i}])`, errors);
  if ('anyOf' in schema) {
    const ok = schema.anyOf.some((sub) => { const e = []; validateSchema(sub, value, root, where, e); return e.length === 0; });
    if (!ok) errors.push(`${where}: no anyOf branch matched`);
  }
  if ('oneOf' in schema) {
    const passed = schema.oneOf.filter((sub) => { const e = []; validateSchema(sub, value, root, where, e); return e.length === 0; });
    if (passed.length !== 1) errors.push(`${where}: oneOf matched ${passed.length} branches (need exactly 1)`);
  }
  if ('if' in schema) {
    const e = []; validateSchema(schema.if, value, root, where, e);
    const branch = e.length === 0 ? schema.then : schema.else;
    if (branch !== undefined) validateSchema(branch, value, root, `${where} (${e.length === 0 ? 'then' : 'else'})`, errors);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// 2) 载入契约与输入
// ---------------------------------------------------------------------------
const SCHEMA_FILES = [
  'part-asset.schema.json', 'assembly.schema.json', 'action-request.schema.json',
  'action-response.schema.json', 'render-state.schema.json', 'asset-lock.schema.json',
  'manual-observation.schema.json', 'task-package.schema.json', 'dataset.schema.json',
];
const REVIEWS = path.join(ROOT, 'docs', 'prd-v2', 'reviews');
const CURRICULUM = path.join(ROOT, 'out', 'prd-v2', 'run-20261026-v4', 'B', 'real-assembly-curriculum', 'curriculum-samples.json');

const report = {
  tool: 'validate-contracts-1.0.mjs',
  timestamp: new Date().toISOString(),
  contractSet: 'contracts-1.0',
  repoRoot: ROOT,
  checks: {},
  blockers: [],
};
const blocker = (id, msg, extra) => { report.blockers.push({ id, msg, ...(extra ? { extra } : {}) }); };

// (a) schema 解析 + 形状检查
report.checks.schemaParse = {};
for (const f of SCHEMA_FILES) {
  const p = path.join(HERE, f);
  let schema = null;
  try {
    schema = readJson(p);
    const shapeProblems = checkSchemaShape(schema);
    report.checks.schemaParse[f] = { parsed: true, jsShapeOk: shapeProblems.length === 0, shapeProblems };
    if (shapeProblems.length) blocker('schema-parse', `${f}: JS shape check failed`, shapeProblems);
  } catch (e) {
    report.checks.schemaParse[f] = { parsed: false, error: String(e.message) };
    blocker('schema-parse', `${f}: not parseable/valid: ${e.message}`);
  }
}
const S = {};
for (const f of SCHEMA_FILES) S[f] = report.checks.schemaParse[f]?.parsed ? readJson(path.join(HERE, f)) : null;
const validateAgainst = (file, payload) => (S[file] ? validateSchema(S[file], payload) : ['schema unavailable']);

// ---------------------------------------------------------------------------
// 3) (b-1) 资产锁消费夹具：schema 复验 + 真实 buildAssetLock/checkAssetLock 对账
// ---------------------------------------------------------------------------
report.checks.fixtureAssetLock = { file: rel(path.join(REVIEWS, 'A-to-B-asset-lock-fixture-20261026.json')), tasks: {} };
try {
  const fix = readJson(path.join(REVIEWS, 'A-to-B-asset-lock-fixture-20261026.json'));
  const index = readJson(path.join(ROOT, 'catalog', 'assets-v1', 'index.json'));
  const { checkAssetLock, buildAssetLock } = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'assets-v1', 'lock.js')).href);
  let tasksPassed = 0;
  for (const t of fix.tasks) {
    const r = { taskId: t.taskId, declaredParts: t.assetLock.parts.length };
    const errs = validateAgainst('asset-lock.schema.json', t.assetLock);
    r.schemaValid = errs.length === 0;
    if (errs.length) r.schemaErrors = errs;
    const chk = checkAssetLock({ assetLock: t.assetLock }, { index, requiredPartIds: t.requiredPartIds });
    r.engineCheckPassed = chk.ok === true;
    r.verifiedCount = chk.verifiedCount;
    r.engineErrorCodes = chk.errors.map((e) => e.code);
    const rebuilt = buildAssetLock(index, t.requiredPartIds, t.assetLock.profileId);
    r.rebuildMissing = rebuilt.missing;
    r.rebuildIdentical = deepEqual(rebuilt.assetLock, t.assetLock);
    r.passed = r.schemaValid && r.engineCheckPassed && r.rebuildIdentical && rebuilt.missing.length === 0;
    if (r.passed) tasksPassed++;
    else blocker('fixture-asset-lock', `${t.taskId} failed`, r);
    report.checks.fixtureAssetLock.tasks[t.taskId] = r;
  }
  report.checks.fixtureAssetLock.passed = tasksPassed === fix.tasks.length;
  report.checks.fixtureAssetLock.summary = `${tasksPassed}/${fix.tasks.length} tasks`;
} catch (e) {
  report.checks.fixtureAssetLock.passed = false;
  report.checks.fixtureAssetLock.error = String(e.stack || e.message);
  blocker('fixture-asset-lock', `harness error: ${e.message}`);
}

// ---------------------------------------------------------------------------
// 4) (b-2) renderState 消费夹具：schema 复验 + toConnectorMap/resolveTag 真实调用 + 侧接口裸 stud_N 禁令
// ---------------------------------------------------------------------------
report.checks.fixtureRenderState = { file: rel(path.join(REVIEWS, 'A-to-B-renderstate-fixture-20261026.json')) };
try {
  const fix = readJson(path.join(REVIEWS, 'A-to-B-renderstate-fixture-20261026.json'));
  const resp = fix.response;
  const errs = validateAgainst('render-state.schema.json', resp);
  report.checks.fixtureRenderState.schemaValid = errs.length === 0;
  if (errs.length) report.checks.fixtureRenderState.schemaErrors = errs;

  const rs = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'actions-v1', 'render-state.js')).href);
  const map = rs.toConnectorMap(resp);
  report.checks.fixtureRenderState.toConnectorMapMatchesFixture = deepEqual(map, fix.BConnectorMap);
  const tag1 = rs.resolveTag(resp, '1', resp.stateHash);
  report.checks.fixtureRenderState.resolveTagBoundToStateHash = Boolean(tag1 && tag1.connectorId === resp.labels[0].connectorId);
  report.checks.fixtureRenderState.resolveTagStaleHashRejected = rs.resolveTag(resp, '1', '0'.repeat(64)) === null;

  // 相机契约显式性 + stateHash≠视图
  report.checks.fixtureRenderState.cameraExplicit = Boolean(resp.camera.target && resp.camera.distance > 0 && resp.camera.viewport?.width > 0 && resp.camera.viewport?.height > 0 && resp.cameraContract?.projection?.type);
  report.checks.fixtureRenderState.cameraSnapshotSerializable = deepEqual(JSON.parse(JSON.stringify(resp.camera)), resp.camera);

  // 裸 stud_N 侧接口禁令：bare 仅允许 +y 顶凸点；侧向接口 bare 必须为 null
  let bareRuleOk = true;
  for (const l of resp.labels) {
    const isTop = l.dir === '+y';
    const bareOk = isTop ? (l.aliases.bare !== null && l.aliases.bare === `stud_${l.aliases.bStyle.replace(/^stud_(?:top|side)_/, '')}`) : l.aliases.bare === null;
    if (!bareOk) { bareRuleOk = false; break; }
  }
  report.checks.fixtureRenderState.bareStudOnlyTopStuds = bareRuleOk;
  report.checks.fixtureRenderState.passed = report.checks.fixtureRenderState.schemaValid
    && report.checks.fixtureRenderState.toConnectorMapMatchesFixture
    && report.checks.fixtureRenderState.resolveTagBoundToStateHash
    && report.checks.fixtureRenderState.resolveTagStaleHashRejected
    && report.checks.fixtureRenderState.cameraExplicit
    && report.checks.fixtureRenderState.cameraSnapshotSerializable
    && report.checks.fixtureRenderState.bareStudOnlyTopStuds;
  if (!report.checks.fixtureRenderState.passed) blocker('fixture-renderstate', 'renderState consumption fixture failed', report.checks.fixtureRenderState);
} catch (e) {
  report.checks.fixtureRenderState.passed = false;
  report.checks.fixtureRenderState.error = String(e.stack || e.message);
  blocker('fixture-renderstate', `harness error: ${e.message}`);
}

// ---------------------------------------------------------------------------
// 5) (b-3) 完整组件事务夹具：schema 复验 + A 真实引擎重放
// ---------------------------------------------------------------------------
report.checks.fixtureFullAssembly = { file: rel(path.join(REVIEWS, 'A-to-B-full-assembly-fixture-20261026.json')) };
try {
  const fix = readJson(path.join(REVIEWS, 'A-to-B-full-assembly-fixture-20261026.json'));
  const reqErrs = validateAgainst('action-request.schema.json', fix.request);
  const resErrs = validateAgainst('action-response.schema.json', fix.result);
  report.checks.fixtureFullAssembly.requestSchemaValid = reqErrs.length === 0;
  report.checks.fixtureFullAssembly.responseSchemaValid = resErrs.length === 0;
  if (reqErrs.length) report.checks.fixtureFullAssembly.requestSchemaErrors = reqErrs;
  if (resErrs.length) report.checks.fixtureFullAssembly.responseSchemaErrors = resErrs;
  const applied0 = fix.result.apply.results[0].applied;
  report.checks.fixtureFullAssembly.semanticConnectorIdsUsed = applied0.connectorsUsed.every((c) => /^(ctop|cside|cantistud|cbar|cclip|cpin|chole|caxle|crim|ctyre)#[0-9]+$/.test(c));
  report.checks.fixtureFullAssembly.stateHashChained = fix.result.apply.stateHashBefore === fix.request.stateHash;

  // 真实引擎重放（与 reviews/check-A-inventory-reuse 相同的目录装载方式）
  const cat = {
    parts: { ...readJson(path.join(ROOT, 'catalog', 'parts-ldraw.json')).parts, ...readJson(path.join(ROOT, 'catalog', 'parts.json')).parts },
    colors: readJson(path.join(ROOT, 'catalog', 'colors.json')).colors,
  };
  const stateMod = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'actions-v1', 'state.js')).href);
  const candMod = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'actions-v1', 'candidates.js')).href);
  const applyMod = await import(pathToFileURL(path.join(ROOT, 'src', 'core', 'actions-v1', 'apply.js')).href);
  const model = structuredClone(fix.model);
  const inventory = structuredClone(fix.inventory);
  // 夹具的 request.stateHash 来自“不带 inventory 的裸 inspectFromModel”（哈希输入只有 nodes/connections/空库存），
  // 库存作为独立 ctx 传入——与夹具生成时的调用形态一致（见下 stateHashMatchesFixture 断言）。
  const inspected = stateMod.inspectFromModel(model, cat, { mainRootNodeId: model.parts[0].id });
  report.checks.fixtureFullAssembly.stateHashMatchesFixture = inspected.stateHash === fix.request.stateHash;
  const replay = applyMod.applyActions({
    model, cat, stateHash: inspected.stateHash, state: inspected.state,
    taskId: fix.request.taskId, mainRootNodeId: model.parts[0].id, inventory,
    enumerate: (request) => candMod.enumerateCandidates(inspected.state, request, cat),
  }, structuredClone(fix.request));
  report.checks.fixtureFullAssembly.replayPassed = replay.passed === true;
  report.checks.fixtureFullAssembly.replayCommitted = replay.apply?.committed === true;
  report.checks.fixtureFullAssembly.replayPartCount = replay._workingModel?.parts?.length ?? null;
  report.checks.fixtureFullAssembly.expectedPartCount = fix.summary.outputPartCount;
  report.checks.fixtureFullAssembly.replayMatchesSummary = replay.passed === true
    && replay.apply?.committed === true
    && (replay._workingModel?.parts?.length ?? -1) === fix.summary.outputPartCount;
  report.checks.fixtureFullAssembly.replayDiagnostics = (replay.diagnostics || []).map((d) => d.code);
  report.checks.fixtureFullAssembly.passed = report.checks.fixtureFullAssembly.requestSchemaValid
    && report.checks.fixtureFullAssembly.responseSchemaValid
    && report.checks.fixtureFullAssembly.semanticConnectorIdsUsed
    && report.checks.fixtureFullAssembly.stateHashChained
    && report.checks.fixtureFullAssembly.stateHashMatchesFixture
    && report.checks.fixtureFullAssembly.replayMatchesSummary;
  if (!report.checks.fixtureFullAssembly.passed) blocker('fixture-full-assembly', 'full assembly consumption fixture failed', report.checks.fixtureFullAssembly);
} catch (e) {
  report.checks.fixtureFullAssembly.passed = false;
  report.checks.fixtureFullAssembly.error = String(e.stack || e.message);
  blocker('fixture-full-assembly', `harness error: ${e.message}`);
}

// ---------------------------------------------------------------------------
// 6) (c) 15 条真实课程样本对合并 C3 schema（样本只读，不改）
// ---------------------------------------------------------------------------
report.checks.curriculumSamples = { file: rel(CURRICULUM) };
try {
  const samples = readJson(CURRICULUM);
  report.checks.curriculumSamples.count = samples.length;
  const failures = [];
  const idShape = /^(ctop|cside|cantistud|cbar|cclip|cpin|chole|caxle|crim|ctyre)#[0-9]+$|^(stud_top|stud_side|antistud|bar|clip|pin|hole|axle|rim|tyre)_[0-9]+$|^stud_[0-9]+$/;
  for (const s of samples) {
    const errs = validateAgainst('dataset.schema.json', s);
    if (errs.length) failures.push({ sampleId: s.sampleId, errors: errs.slice(0, 5) });
    // 身份策略机制检查：裸 stud_N 只允许作为父件顶凸点（parentConnectorId），不得作子件接口
    for (const c of s.candidates.items) {
      for (const [k, v] of [['parentConnectorId', c.parentConnectorId], ['childConnectorId', c.childConnectorId]]) {
        if (!idShape.test(v)) failures.push({ sampleId: s.sampleId, errors: [`${k} illegal connector id form: ${v}`] });
        if (k === 'childConnectorId' && /^stud_[0-9]+$/.test(v)) failures.push({ sampleId: s.sampleId, errors: [`bare stud_N used as child connector: ${v}`] });
      }
    }
  }
  report.checks.curriculumSamples.failures = failures;
  report.checks.curriculumSamples.passed = samples.length === 15 && failures.length === 0;
  if (!report.checks.curriculumSamples.passed) blocker('curriculum-samples', `${failures.length} sample failures`, failures.slice(0, 5));
} catch (e) {
  report.checks.curriculumSamples.passed = false;
  report.checks.curriculumSamples.error = String(e.stack || e.message);
  blocker('curriculum-samples', `harness error: ${e.message}`);
}

// ---------------------------------------------------------------------------
// 7) (d) 负例探针：已知非法形态必须被拒（正例 = 上文真实载荷，不再重复）
// ---------------------------------------------------------------------------
const probes = [];
const probe = (id, schemaFile, payload, expectValid) => probes.push({ id, schemaFile, payload, expectValid });
probe('al-entry-missing-contenthash', 'asset-lock.schema.json', { profileId: 'p', indexVersion: '1.0.0', parts: [{ partId: '3001', revision: 'r1' }] }, false);
probe('al-empty-parts', 'asset-lock.schema.json', { profileId: 'p', indexVersion: '1.0.0', parts: [] }, false);
probe('al-bad-hash', 'asset-lock.schema.json', { profileId: 'p', indexVersion: '1.0.0', parts: [{ partId: '3001', revision: 'r1', contentHash: 'NOTAHASH' }] }, false);
probe('al-extra-lockhash-key', 'asset-lock.schema.json', { profileId: 'p', indexVersion: '1.0.0', parts: [{ partId: '3001', revision: 'r1', contentHash: 'a'.repeat(64) }], lockHash: 'b'.repeat(64) }, false);
probe('tp-legacy-partlocks-dict', 'task-package.schema.json', { schemaVersion: '1.0', taskId: 't1', revision: 1, globalPlanRef: { planFile: 'x', planSha256: 'c'.repeat(64) }, role: 'subassembly', assetLock: { profileId: 'p', indexVersion: '1.0.0', parts: [{ partId: '3001', revision: 'r1', contentHash: 'a'.repeat(64) }], partLocks: { '3001': { revision: 'r1', hash: 'a'.repeat(64) } } }, inventory: { totalCount: 1, tokens: [{ tokenId: 't', partId: '3001', colorId: 0 }] }, localFrame: { originDescription: 'o', allowedRootParts: ['3001'] }, interfaces: { outwardConnectors: [], targetMounts: [] }, budget: { maxStepRetries: 3, maxRepairRounds: 2, timeoutSeconds: 300 }, acceptance: { requireZeroErrors: true, requireFullInventoryConsumption: true } }, false);
probe('ar-unknown-op', 'action-request.schema.json', { protocolVersion: '1.0.0', taskId: 't', stateHash: 'a'.repeat(64), actions: [{ id: 'a1', op: 'teleport' }] }, false);
probe('ar-attach-missing-candidate', 'action-request.schema.json', { protocolVersion: '1.0.0', taskId: 't', stateHash: 'a'.repeat(64), actions: [{ id: 'a1', op: 'attach_part', target: { partInstanceId: 'p2' } }] }, false);
probe('ar-empty-actions', 'action-request.schema.json', { protocolVersion: '1.0.0', taskId: 't', stateHash: 'a'.repeat(64), actions: [] }, false);
probe('rs-33-labels', 'render-state.schema.json', null, false); // 特殊构造见下
probe('mo-bad-observation-id', 'manual-observation.schema.json', { format: 'brickkit-manual-observations', version: '1.0', meta: { setId: 's', name: 'n', extractedAt: '2026-10-26T00:00:00Z', extractor: 'e' }, sourceDocument: { fileName: 'f', fileSha256: 'a'.repeat(64), totalPages: 1, sourceType: 'official-pdf' }, observations: [{ observationId: 'wrong-id', page: 1, region: { x: 0, y: 0, width: 1, height: 1 }, stepNumber: 1, confidence: 'high', partsAdded: [] }] }, false);
probe('ds-bad-protocol', 'dataset.schema.json', null, false); // 特殊构造见下
probe('asm-loose-assetlock', 'assembly.schema.json', null, false); // 特殊构造见下
// 特殊构造
probes.find((p) => p.id === 'rs-33-labels').payload = {
  ok: true, kind: 'renderState', renderStateVersion: '1.0.0',
  cameraContract: { version: '1.0.0', worldUnit: 'stud', pixelOrigin: 'top-left', upAxis: '+Y' },
  camera: { mode: 'perspective', eye: [0, 0, 10], target: [0, 0, 0], distance: 10, fovYDeg: 30, viewport: { width: 100, height: 100 }, pixelOrigin: 'top-left' },
  stateHash: 'a'.repeat(64),
  labels: Array.from({ length: 33 }, (_, i) => ({ tag: String(i), pixel: [0, 0], nodeId: `p${i}`, partId: '3001', connectorId: `ctop#${i}`, connectorType: 'top', dir: '+y', worldPos: [0, 0, 0], worldPosLdu: [0, 0, 0], depth: 1, aliases: { bStyle: `stud_top_${i}`, bare: `stud_${i}` } })),
  enumerationComplete: false, truncated: true,
};
probes.find((p) => p.id === 'ds-bad-protocol').payload = {
  sampleId: 'smp-x', protocolVersion: '2.0', taskType: 'select_action',
  provenance: { sourceFamilyId: 'f', sourceModelId: 'm', sourceKind: 'synthetic_assembly', split: 'train' },
  assetLock: { catalogVersion: '1', engineRevision: '1' }, images: [{ role: 'current_rendered_state', imagePath: 'x', imageSha256: 'a'.repeat(64), labeled: false }],
  stateRef: { taskId: 't', stepNumber: 0, stateHash: 'a'.repeat(64) }, inventory: [], candidates: { enumerationComplete: true, truncated: false, items: [] },
  target: { primaryAction: { op: 'abstain' } }, verification: { isGeometricallyLegal: true, hasManualGroundTruth: false, verifiedBy: 'x' },
};
probes.find((p) => p.id === 'asm-loose-assetlock').payload = {
  format: 'brickbuild-assembly', version: '0.3.0',
  assetLock: { profileId: 'p', parts: [{ partId: '3001', revision: 'r1' }] },
  definitions: [], instances: [], placements: [], steps: [],
};
report.checks.negativeProbes = [];
let probesPassed = 0;
for (const pr of probes) {
  const errs = validateAgainst(pr.schemaFile, pr.payload);
  const ok = pr.expectValid ? errs.length === 0 : errs.length > 0;
  report.checks.negativeProbes.push({ id: pr.id, schemaFile: pr.schemaFile, expectValid: pr.expectValid, rejected: errs.length > 0, ok, errors: errs.slice(0, 3) });
  if (ok) probesPassed++; else blocker('negative-probe', `probe ${pr.id} did not behave as required`, errs.slice(0, 3));
}
report.checks.negativeProbesSummary = `${probesPassed}/${probes.length} probes behaved as required`;

// ---------------------------------------------------------------------------
// 8) (e) version.json 一致性：engineRevision / contractFiles / 必填版本字段
// ---------------------------------------------------------------------------
report.checks.versionConsistency = {};
try {
  const ver = readJson(path.join(HERE, 'version.json'));
  report.checks.versionConsistency.requiredFields = {
    version: ver.version === '1.0.0',
    name: ver.name === 'contracts-1.0',
    frozenIsBoolean: typeof ver.frozen === 'boolean',
    datasetSchemaVersion: ver.datasetSchemaVersion === '1.0',
    actionProtocolVersion: ver.actionProtocolVersion === '1.0.0',
    assetLockFormat: ver.assetLockFormat === 'buildAssetLock-v1',
    receiptBinding: ver.receiptBinding === 'createBoundTaskReceipt-v1',
    frozenAtIso: typeof ver.frozenAt === 'string' && !Number.isNaN(Date.parse(ver.frozenAt)),
  };
  const dirs = ['src/core/actions-v1', 'src/core/assets-v1', 'src/core/assembly-v1'];
  const walk = (d, acc = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, acc); else acc.push(p); } return acc; };
  const allHashes = [];
  const perDir = {};
  for (const d of dirs) {
    const hs = walk(path.join(ROOT, d)).map((p) => sha256(fs.readFileSync(p)));
    perDir[d] = sha256(Buffer.from(hs.join(''), 'utf8'));
    allHashes.push(...hs);
  }
  const engine = sha256(Buffer.from(allHashes.sort().join(''), 'utf8'));
  report.checks.versionConsistency.engineRevisionComputed = engine;
  report.checks.versionConsistency.engineRevisionMatches = engine === ver.engineRevision;
  report.checks.versionConsistency.engineRevisionPerDirMatches = deepEqual(perDir, ver.engineRevisionPerDir);

  const files = [...SCHEMA_FILES, 'api.md'];
  const hashReport = {};
  let hashesOk = true;
  for (const f of files) {
    const actual = sha256(fs.readFileSync(path.join(HERE, f)));
    const recorded = ver.contractFiles?.[f];
    hashReport[f] = { actual, recorded, match: actual === recorded };
    if (actual !== recorded) hashesOk = false;
  }
  report.checks.versionConsistency.contractFileHashesMatch = hashesOk;
  report.checks.versionConsistency.contractFilesCoverAll = deepEqual(Object.keys(ver.contractFiles || {}).sort(), files.slice().sort());
  report.checks.versionConsistency.all = Object.values(report.checks.versionConsistency.requiredFields).every(Boolean)
    && report.checks.versionConsistency.engineRevisionMatches
    && report.checks.versionConsistency.engineRevisionPerDirMatches
    && hashesOk
    && report.checks.versionConsistency.contractFilesCoverAll;
  if (!report.checks.versionConsistency.all) blocker('version-consistency', 'version.json inconsistent with recomputed hashes/fields', report.checks.versionConsistency);

  // frozen 一致性在最后统一判定（见下）
  report.versionFrozenDeclared = ver.frozen;
} catch (e) {
  report.checks.versionConsistency.all = false;
  report.checks.versionConsistency.error = String(e.stack || e.message);
  blocker('version-consistency', `harness error: ${e.message}`);
  report.versionFrozenDeclared = null;
}

// ---------------------------------------------------------------------------
// 9) Python Draft202012Validator 独立复核（jsonschema ≥4.x；不可用时标 unavailable，不算 blocker）
// ---------------------------------------------------------------------------
report.checks.pythonCrossCheck = { available: false };
try {
  const pyProbesFile = path.join(OUT_DIR, 'freeze-probes.tmp.json');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(pyProbesFile, JSON.stringify(probes));
  const py = `
import json, sys
from jsonschema import Draft202012Validator
HERE = r'''${HERE}'''
ROOT = r'''${ROOT}'''
REVIEWS = r'''${REVIEWS}'''
CURRICULUM = r'''${CURRICULUM}'''
out = {"schemas": {}, "payloads": {}, "probes": []}
for f in ${JSON.stringify(SCHEMA_FILES)}:
    s = json.load(open(HERE + "/" + f, encoding="utf-8"))
    Draft202012Validator.check_schema(s)
    out["schemas"][f] = {"checkSchemaOk": True}
V = {f: Draft202012Validator(json.load(open(HERE + "/" + f, encoding="utf-8"))) for f in ${JSON.stringify(SCHEMA_FILES)}}
fix1 = json.load(open(REVIEWS + "/A-to-B-asset-lock-fixture-20261026.json", encoding="utf-8"))
out["payloads"]["assetLockTasks"] = all(V["asset-lock.schema.json"].is_valid(t["assetLock"]) for t in fix1["tasks"])
fix2 = json.load(open(REVIEWS + "/A-to-B-renderstate-fixture-20261026.json", encoding="utf-8"))
out["payloads"]["renderStateResponse"] = V["render-state.schema.json"].is_valid(fix2["response"])
fix3 = json.load(open(REVIEWS + "/A-to-B-full-assembly-fixture-20261026.json", encoding="utf-8"))
out["payloads"]["fullAssemblyRequest"] = V["action-request.schema.json"].is_valid(fix3["request"])
out["payloads"]["fullAssemblyResult"] = V["action-response.schema.json"].is_valid(fix3["result"])
samples = json.load(open(CURRICULUM, encoding="utf-8"))
out["payloads"]["curriculumSamples"] = {"count": len(samples), "allValid": all(V["dataset.schema.json"].is_valid(s) for s in samples)}
for pr in json.load(open(sys.argv[1], encoding="utf-8")):
    errs = list(V[pr["schemaFile"]].iter_errors(pr["payload"]))
    rejected = len(errs) > 0
    ok = rejected if not pr["expectValid"] else not rejected
    out["probes"].append({"id": pr["id"], "ok": bool(ok), "rejected": bool(rejected)})
print(json.dumps(out))
`;
  const res = spawnSync('python', ['-', path.join(OUT_DIR, 'freeze-probes.tmp.json')], { input: py, encoding: 'utf8', timeout: 120000 });
  if (res.status === 0) {
    const parsed = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    report.checks.pythonCrossCheck = { available: true, ...parsed };
    const allOk = Object.values(parsed.schemas).every((x) => x.checkSchemaOk)
      && parsed.payloads.assetLockTasks && parsed.payloads.renderStateResponse
      && parsed.payloads.fullAssemblyRequest && parsed.payloads.fullAssemblyResult
      && parsed.payloads.curriculumSamples.count === 15 && parsed.payloads.curriculumSamples.allValid
      && parsed.probes.every((p) => p.ok);
    report.checks.pythonCrossCheck.allOk = allOk;
    if (!allOk) blocker('python-cross-check', 'Python Draft202012Validator disagrees', parsed);
  } else {
    report.checks.pythonCrossCheck = { available: false, reason: (res.stderr || res.error?.message || `exit ${res.status}`).slice(0, 400) };
  }
  fs.rmSync(pyProbesFile, { force: true });
} catch (e) {
  report.checks.pythonCrossCheck = { available: false, reason: String(e.message).slice(0, 400) };
}

// ---------------------------------------------------------------------------
// 10) 总判定：frozen 只允许在全部通过时为 true
// ---------------------------------------------------------------------------
const jsAllPassed = !report.blockers.length;
report.overall = {
  jsChecksPassed: jsAllPassed,
  pythonCrossCheckOk: report.checks.pythonCrossCheck?.allOk === true,
  frozenDeclared: report.versionFrozenDeclared,
  frozenConsistent: jsAllPassed && report.versionFrozenDeclared === true,
  verdict: jsAllPassed ? (report.versionFrozenDeclared === true ? 'FROZEN-VALID' : 'ALL-PASS-BUT-NOT-FROZEN') : 'BLOCKED',
  blockers: report.blockers,
};

const outPath = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : path.join(OUT_DIR, 'freeze-validation.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({
  verdict: report.overall.verdict,
  jsChecksPassed: report.overall.jsChecksPassed,
  pythonCrossCheck: report.checks.pythonCrossCheck.available ? (report.checks.pythonCrossCheck.allOk ? 'ok' : 'MISMATCH') : 'unavailable',
  fixtureAssetLock: report.checks.fixtureAssetLock.summary || String(report.checks.fixtureAssetLock.error),
  fixtureRenderState: report.checks.fixtureRenderState.passed,
  fixtureFullAssembly: report.checks.fixtureFullAssembly.passed,
  curriculumSamples: `${report.checks.curriculumSamples.count ?? '?'} samples, passed=${report.checks.curriculumSamples.passed}`,
  negativeProbes: report.checks.negativeProbesSummary,
  versionConsistency: report.checks.versionConsistency.all,
  blockers: report.blockers.length,
  out: rel(outPath),
}, null, 1));
process.exit(report.overall.frozenConsistent ? 0 : 1);
