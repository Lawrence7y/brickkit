// plan.json（brickbuild-plan 0.1）端到端测试：
// extract-plan 用真实 60239 数据（examples/60239.brick.json + 60239.bom.json + out/manual-pages/60239/manifest.json）
// 产出 plan，再用 check-plan 守门；然后手工造 4 个坏 plan 断言各自的错误码命中。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { extractPlan, checkPlan, aggregateParts, sumPartRows, PLAN_FORMAT, PLAN_VERSION } from '../tools/extract-plan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const MODEL = path.join(ROOT, 'examples/60239.brick.json');
const BOM = path.join(ROOT, 'examples/60239.bom.json');
const MANIFEST = path.join(ROOT, 'out/manual-pages/60239/manifest.json');
const CLI = path.join(ROOT, 'cli/brickkit.mjs');

const model = readJSON(MODEL);
const bom = readJSON(BOM);
const manifest = readJSON(MANIFEST);
const clone = (o) => JSON.parse(JSON.stringify(o));

/** 端到端共享的 plan（只算一次；各用例 clone 后改写） */
const planOnce = (() => {
  let cached = null;
  return () => (cached ||= extractPlan({ model, modelFile: MODEL, manifest, manifestFile: MANIFEST, bom, bomFile: BOM }));
})();

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'brickkit-plan-'));
const codes = (r) => r.errors.map((e) => e.code);
const warnCodes = (r) => r.warnings.map((w) => w.code);

/* ---------------------------------------------------------------- extract-plan */
test('extract-plan：60239 真实数据 → 40 步 / 91 件 / main 单子模型，零件总数守恒', () => {
  const plan = planOnce();
  assert.equal(plan.format, PLAN_FORMAT);
  assert.equal(plan.version, PLAN_VERSION);
  assert.equal(plan.meta.setId, '60239');
  assert.equal(plan.submodels.length, 1);
  assert.equal(plan.submodels[0].id, 'main');
  assert.equal(plan.steps.length, 40);
  const stepTotal = plan.steps.reduce((a, s) => a + s.parts.reduce((b, p) => b + p.qty, 0), 0);
  const subTotal = plan.submodels.reduce((a, s) => a + s.bom.reduce((b, p) => b + p.qty, 0), 0);
  assert.equal(stepTotal, 91);
  assert.equal(subTotal, 91);
  assert.equal(model.parts.length, 91);
  assert.equal(plan.manual.pages, 36);
});

test('extract-plan：每步新增零件与模型 parts[].step 完全一致（无遗漏、无重复）', () => {
  const plan = planOnce();
  const fromModel = aggregateParts(model.parts);
  const fromSteps = sumPartRows(plan.steps.flatMap((s) => s.parts));
  assert.deepEqual(fromSteps, fromModel);
  const stepNums = new Set(plan.steps.map((s) => s.n));
  assert.deepEqual([...stepNums].sort((a, b) => a - b), [...new Set(model.parts.map((p) => p.step))].sort((a, b) => a - b));
});

test('extract-plan：页码口径诚实——顺序均摊的一律 assumed + note，不冒充 measured', () => {
  const plan = planOnce();
  assert.equal(plan.pageMapping.method, 'even-split');
  assert.equal(plan.steps.filter((s) => s.pageConfidence === 'measured').length, 0);
  assert.equal(plan.steps.filter((s) => s.pageConfidence === 'assumed').length, plan.steps.length);
  assert.ok(plan.assumptions.some((a) => a.includes('均摊')));
  // 页面必须是 manifest 里真实存在的 kind=step 页
  const stepPages = new Set(manifest.items.filter((i) => i.kind === 'step').map((i) => i.page));
  for (const s of plan.steps) assert.ok(stepPages.has(s.page), `步骤 ${s.n} 的 page=${s.page} 不是 kind=step 页`);
  // 共用页的步骤、以及任何 assumed 页码都必须写明 note（不冒充精确）
  for (const s of plan.steps) assert.ok(typeof s.note === 'string' && s.note.includes('第'), `步骤 ${s.n} 缺页码来源说明`);
});

test('extract-plan：没有 --poses 时视角标 assumed；模型无子组件归属时全部归 main 并写 assumption', () => {
  const plan = planOnce();
  assert.ok(plan.steps.every((s) => s.poseConfidence === 'assumed'));
  assert.ok(plan.assumptions.some((a) => a.includes('全部零件归入 main')));
  assert.equal(plan.submodels[0].attachStep, null);
});

test('extract-plan：--from-pages 缺省时 page 全 null、pageMapping.method=none', () => {
  const plan = extractPlan({ model, modelFile: MODEL, bom, bomFile: BOM });
  assert.equal(plan.manual, null);
  assert.equal(plan.pageMapping.method, 'none');
  assert.ok(plan.steps.every((s) => s.page === null && s.pageConfidence === 'assumed'));
});

test('extract-plan：--assign 显式切分 main + 子模型，区间取成员步骤 min..max，件数守恒', () => {
  // 60239 没有天然子组件 → 用 --assign 把 step>=33 的件划给 sub-rear（尾部装配）
  const rear = model.parts.filter((p) => p.step >= 33).map((p) => p.id);
  const assign = { submodels: [{ id: 'main', label: '主干' }, { id: 'sub-rear', label: '尾部总成', attachStep: 46 }] };
  assign.assign = Object.fromEntries(rear.map((id) => [id, 'sub-rear']));
  const plan = extractPlan({ model, modelFile: MODEL, manifest, manifestFile: MANIFEST, bom, bomFile: BOM, assign });
  const ids = plan.submodels.map((s) => s.id);
  assert.deepEqual(ids.sort(), ['main', 'sub-rear']);
  const sub = plan.submodels.find((s) => s.id === 'sub-rear');
  assert.equal(sub.bom.reduce((a, p) => a + p.qty, 0), rear.length);
  assert.equal(sub.attachStep, 46);
  assert.equal(sub.steps[0], 33);
  assert.equal(sub.steps[1], 45);
  assert.equal(plan.submodels.reduce((a, s) => a + s.bom.reduce((b, p) => b + p.qty, 0), 0), 91);
  const r = checkPlan(plan, { bom, model });
  assert.equal(r.ok, true, `预期的 plan 应自洽：${JSON.stringify(r.errors)}`);
});

test('extract-plan：扁平映射形式的 --assign 也可用（{partId: submodelId}）', () => {
  const acc = model.parts.filter((p) => p.step === 1).slice(0, 3).map((p) => p.id);
  const plan = extractPlan({ model, modelFile: MODEL, assign: Object.fromEntries(acc.map((id) => [id, 'accessories'])) });
  const sub = plan.submodels.find((s) => s.id === 'accessories');
  assert.ok(sub, `应生成 accessories 子模型，实际 ${plan.submodels.map((s) => s.id)}`);
  assert.equal(sub.bom.reduce((a, p) => a + p.qty, 0), acc.length);
  assert.equal(checkPlan(plan, { model }).ok, true);
});

test('extract-plan：模型自带归属优先于 --assign（除非 assign.override）', () => {
  const cottage = readJSON(path.join(ROOT, 'examples/cottage.brick.json'));
  const flat = { [cottage.parts[0].id]: 'hacked' };
  const auto = extractPlan({ model: cottage, assign: flat });
  assert.ok(auto.submodels.some((s) => s.id === 'roof'), '默认应按模型 modules 分组');
  assert.ok(!auto.submodels.some((s) => s.id === 'hacked'));
  const forced = extractPlan({ model: cottage, assign: { ...flat, override: true } });
  assert.ok(forced.submodels.some((s) => s.id === 'hacked'), 'override:true 时应强制用 --assign');
});

test('extract-plan：模型自带 modules/subassembly 时按模块树分组（cottage：main + roof 装配步 15）', () => {
  const cottage = readJSON(path.join(ROOT, 'examples/cottage.brick.json'));
  const plan = extractPlan({ model: cottage, modelFile: path.join(ROOT, 'examples/cottage.brick.json') });
  const roof = plan.submodels.find((s) => s.id === 'roof');
  assert.ok(roof, '应识别出 roof 子组件');
  assert.equal(roof.attachStep, 15);
  assert.equal(roof.steps[1], 14);
  assert.equal(plan.submodels.reduce((a, s) => a + s.bom.reduce((b, p) => b + p.qty, 0), 0), cottage.parts.length);
  assert.equal(checkPlan(plan, { model: cottage }).ok, true);
});

test('extract-plan：--poses 提供视角时标 measured；--page-map 声明页码时 pageConfidence=measured', () => {
  const steps = { 1: { az: 300, el: 20 } };
  const plan = extractPlan({ model, modelFile: MODEL, poses: { steps } });
  const s1 = plan.steps.find((s) => s.n === 1);
  assert.deepEqual([s1.az, s1.el, s1.poseConfidence], [300, 20, 'measured']);

  // --page-map 显式声明：page 2 对应 step 1，标 measured；其余仍 assumed
  const pm = extractPlan({ model, modelFile: MODEL, manifest, manifestFile: MANIFEST, pageMap: { 1: 2 } });
  assert.equal(pm.steps.find((s) => s.n === 1).pageConfidence, 'measured');
  assert.equal(pm.pageMapping.measuredSteps, 1);
  assert.equal(pm.pageMapping.assumedSteps, pm.steps.length - 1);
  assert.equal(pm.pageMapping.method, 'mixed');

  assert.throws(() => extractPlan({ model: { ...clone(model), parts: [{ id: 'x', part: '3001', color: 15 }] } }), /缺少合法整数 step/);
});

/* ------------------------------------------------------------------ check-plan */
test('check-plan：60239 真实 plan 与本模型 + 官方 BOM 完全自洽（ok=true，仅 3 条替代件 warning）', () => {
  const r = checkPlan(planOnce(), { bom, model });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.errors, []);
  assert.equal(warnCodes(r).filter((c) => c === 'plan-substituted').length, 3);
  assert.equal(r.stats.stepsTotalParts, 91);
  assert.equal(r.stats.submodelsTotalParts, 91);
  assert.equal(r.stats.bomTotalParts, 91);
  assert.equal(r.stats.modelTotalParts, 91);
  assert.equal(r.stats.bomEntries, 52);
});

test('check-plan：替代件（substituteFor）放行但 warning plan-substituted，且 plan 用官方设计件号也放行', () => {
  const r = checkPlan(planOnce(), { bom });
  const subs = r.warnings.filter((w) => w.code === 'plan-substituted');
  assert.deepEqual(subs.map((w) => w.substitute).sort(), ['3626b', '57783', '85984']);
  assert.deepEqual(subs.map((w) => w.design).sort(), ['21023', '24741', '35279']);

  // plan 若改用官方设计件号（21023/35279/24741），同样不报 missing/extra
  const alt = clone(planOnce());
  const rename = { '3626b|14': '21023|14', '57783|43': '35279|43', '85984|72': '24741|72' };
  const swap = (rows) => rows.map((e) => { const k = `${e.part}|${e.color}`; return rename[k] ? { ...e, part: rename[k].split('|')[0] } : e; });
  alt.submodels = alt.submodels.map((s) => ({ ...s, bom: swap(s.bom) }));
  alt.steps = alt.steps.map((s) => ({ ...s, parts: swap(s.parts) }));
  const r2 = checkPlan(alt, { bom });
  assert.equal(r2.ok, true, JSON.stringify(r2.errors));
  assert.equal(r2.stats.substituted, 3);

  // 反向漏洞用例：用设计件号时多报 1 件，必须报 plan-bom-extra（别名键不能被跳过多件检查）
  const alt2 = clone(alt);
  alt2.submodels[0].bom.push({ part: '21023', color: 14, qty: 1 });
  const r3 = checkPlan(alt2, { bom });
  assert.ok(codes(r3).includes('plan-bom-extra'), `命中码：${codes(r3)}`);
  assert.equal(r3.errors.find((x) => x.code === 'plan-bom-extra').extra[0].excess, 1);
});

test('check-plan：format/version 非法 → error', () => {
  const bad = clone(planOnce());
  bad.format = 'brickbuild';
  bad.version = '0.2';
  const r = checkPlan(bad, {});
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r).sort(), ['plan-format', 'plan-version']);
});

test('check-plan：未知字段 → warning（不静默丢弃）', () => {
  const p = clone(planOnce());
  p.submodelz = [];                       // 顶层拼写错误
  p.steps[0].viewAngle = 300;             // 步骤级未知字段
  p.submodels[0].bom[0].partId = 'x';     // BOM 行未知字段
  const r = checkPlan(p, {});
  const unknown = r.warnings.filter((w) => w.code === 'plan-unknown-field');
  assert.equal(unknown.length, 3);
  assert.deepEqual(unknown.map((w) => w.field).sort(), ['partId', 'submodelz', 'viewAngle']);
  assert.equal(r.ok, true);
});

test('check-plan：结构错误（steps 非数组 / 重复步骤号 / 区间非法 / qty 非正整数）→ plan-structure / plan-dup', () => {
  const p = clone(planOnce());
  p.steps[1].n = p.steps[0].n;            // 步骤号重复
  p.steps[2].parts[0].qty = 0;            // qty 非法
  p.submodels[0].steps = [45, 1];         // 区间降序
  const r = checkPlan(p, {});
  assert.ok(codes(r).includes('plan-dup'));
  assert.ok(codes(r).filter((c) => c === 'plan-structure').length >= 2);
  const r2 = checkPlan({ ...clone(planOnce()), steps: 'nope' }, {});
  assert.ok(codes(r2).includes('plan-structure'));
  assert.equal(r2.ok, false);
});

/* ------------------------------------------------------------- 4 个坏 plan 用例 */
// 口径：submodels[].bom 是 plan 的“零件预算”，官方 BOM 与模型都拿它对比；
// 只改一侧时既有守恒错误（plan-step-sum-mismatch），也有与 BOM/模型的差异，正是要抓的漏洞。
test('坏 plan ①（少件）：submodels 少 1 件 → plan-bom-missing + plan-step-sum-mismatch + plan-model-drift', () => {
  const p = clone(planOnce());
  const victim = p.submodels[0].bom[0];
  const gone = { part: victim.part, color: victim.color };
  victim.qty -= 1;
  if (victim.qty === 0) p.submodels[0].bom.shift();

  const r = checkPlan(p, { bom, model });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('plan-bom-missing'), `命中码：${codes(r)}`);
  const miss = r.errors.find((x) => x.code === 'plan-bom-missing');
  assert.equal(miss.count, 1);
  assert.deepEqual([miss.missing[0].part, miss.missing[0].color, miss.missing[0].need], [gone.part, gone.color, 1]);
  assert.ok(codes(r).includes('plan-step-sum-mismatch'));
  const sum = r.errors.find((x) => x.code === 'plan-step-sum-mismatch');
  assert.deepEqual([sum.steps, sum.submodels, sum.delta], [91, 90, 1]);
  // 明细点出唯一的差异条目：步骤侧仍是原数量（victim.qty + 1），子模型侧少 1
  assert.deepEqual(sum.detail, [{ ...gone, steps: victim.qty + 1, submodels: victim.qty, diff: 1 }]);
  assert.ok(codes(r).includes('plan-model-drift'));
  assert.equal(r.stats.submodelsTotalParts, 90);
});

test('坏 plan ②（多件）：submodels 多 2 件 → plan-bom-extra + plan-step-sum-mismatch + plan-model-drift', () => {
  const p = clone(planOnce());
  p.submodels[0].bom.push({ part: '3001', color: 4, qty: 2 });   // 官方 BOM 不含 (3001, 4)
  const r = checkPlan(p, { bom, model });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('plan-bom-extra'), `命中码：${codes(r)}`);
  const extra = r.errors.find((x) => x.code === 'plan-bom-extra');
  assert.equal(extra.count, 1);
  assert.deepEqual([extra.extra[0].part, extra.extra[0].color, extra.extra[0].excess], ['3001', 4, 2]);
  assert.ok(codes(r).includes('plan-step-sum-mismatch'));
  const sum = r.errors.find((x) => x.code === 'plan-step-sum-mismatch');
  assert.deepEqual([sum.steps, sum.submodels, sum.delta], [91, 93, -2]);
  assert.deepEqual(sum.detail, [{ part: '3001', color: 4, steps: 0, submodels: 2, diff: -2 }]);
  assert.ok(codes(r).includes('plan-model-drift'));
});

test('坏 plan ②b：只在 steps 侧多件 → plan-step-sum-mismatch 报差值与差在哪条', () => {
  const p = clone(planOnce());
  p.steps[0].parts.push({ part: '3001', color: 4, qty: 2 });
  const r = checkPlan(p, {});
  assert.ok(codes(r).includes('plan-step-sum-mismatch'));
  const e = r.errors.find((x) => x.code === 'plan-step-sum-mismatch');
  assert.equal(e.delta, 2);
  assert.deepEqual(e.detail, [{ part: '3001', color: 4, steps: 2, submodels: 0, diff: 2 }]);
  assert.equal(e.detailCount, 1);
  assert.ok(e.msg.includes('3001×4'));
});

test('坏 plan ③：子模型区间重叠 → plan-step-overlap（main 与非 main 重叠除外）', () => {
  const p = clone(planOnce());
  p.submodels.push({ id: 'sub-a', label: 'A', steps: [5, 20], attachStep: 21, bom: [] },
    { id: 'sub-b', label: 'B', steps: [15, 30], attachStep: 31, bom: [] });
  const r = checkPlan(p, {});
  const e = r.errors.filter((x) => x.code === 'plan-step-overlap');
  assert.equal(e.length, 1);
  assert.deepEqual([e[0].a, e[0].b, e[0].from, e[0].to], ['sub-a', 'sub-b', 15, 20]);

  // main [1,45] 与 sub-a 重叠不报（例外）
  const p2 = clone(planOnce());
  p2.submodels.push({ id: 'sub-a', label: 'A', steps: [5, 20], attachStep: 21, bom: [] });
  assert.equal(codes(checkPlan(p2, {})).includes('plan-step-overlap'), false);
});

test('坏 plan ④：attachStep 早于自身区间末 → plan-attach-order', () => {
  const p = clone(planOnce());
  p.submodels.push({ id: 'sub-roof', label: '屋顶', steps: [11, 14], attachStep: 12, bom: [] });
  const r = checkPlan(p, {});
  const e = r.errors.filter((x) => x.code === 'plan-attach-order');
  assert.equal(e.length, 1);
  assert.deepEqual([e[0].submodel, e[0].attachStep, e[0].rangeEnd], ['sub-roof', 12, 14]);
  // 合法值（区间末之后）不报
  const p2 = clone(planOnce());
  p2.submodels.push({ id: 'sub-roof', label: '屋顶', steps: [11, 14], attachStep: 15, bom: [] });
  assert.equal(codes(checkPlan(p2, {})).includes('plan-attach-order'), false);
});

/* --------------------------------------------------------------------- CLI */
test('CLI：extract-plan 写盘 + check-plan 退出码 0（真实 60239），坏 plan 退出码 1', () => {
  const dir = tmpDir();
  const planFile = path.join(dir, '60239.plan.json');
  const run = (...argv) => spawnSync(process.execPath, [CLI, ...argv], { cwd: ROOT, encoding: 'utf8' });

  const ex = run('extract-plan', '--from-model', 'examples/60239.brick.json', '--from-pages', 'out/manual-pages/60239/manifest.json', '--bom', 'examples/60239.bom.json', '-o', planFile);
  assert.equal(ex.status, 0, ex.stderr || ex.stdout);
  const res = JSON.parse(ex.stdout.trim().split('\n').pop());
  assert.equal(res.ok, true);
  assert.equal(res.stats.steps, 40);
  assert.equal(res.stats.stepsTotalParts, 91);
  assert.equal(res.stats.submodels, 1);
  assert.equal(res.stats.assumedPages, 40);
  assert.ok(fs.existsSync(planFile));
  assert.equal(readJSON(planFile).format, PLAN_FORMAT);

  const ck = run('check-plan', planFile, '--bom', 'examples/60239.bom.json', '--model', 'examples/60239.brick.json');
  assert.equal(ck.status, 0, ck.stdout);
  const ckJson = JSON.parse(ck.stdout.trim().split('\n').pop());
  assert.equal(ckJson.ok, true);

  // 坏 plan → 退出码 1
  const bad = clone(readJSON(planFile));
  bad.steps[0].parts.push({ part: '3001', color: 4, qty: 1 });
  const badFile = path.join(dir, 'bad.plan.json');
  fs.writeFileSync(badFile, JSON.stringify(bad));
  const badRes = run('check-plan', badFile, '--bom', 'examples/60239.bom.json');
  assert.equal(badRes.status, 1);
  assert.ok(JSON.parse(badRes.stdout.trim().split('\n').pop()).errors.some((e) => e.code === 'plan-step-sum-mismatch'));

  // format 非法（用 brickbuild 模型冒充 plan）→ error
  const wrong = path.join(dir, 'wrong.plan.json');
  fs.writeFileSync(wrong, JSON.stringify(model));
  const wrongRes = run('check-plan', wrong);
  assert.equal(wrongRes.status, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});
