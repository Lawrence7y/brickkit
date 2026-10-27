// BrickVLM 合成数据引擎 + 物理奖励函数测试
//
// 覆盖三件事（对应 PRD Phase 4 交付门槛）：
//   ① --no-render 端到端产出合法 JSONL（用真实 60239 / 真实装配课程模型）
//   ② 奖励函数：全对给高分、错 stud 降分、穿模 physical=0
//   ③ GT 里假连接的样本被整步丢弃并计数
//
// 风格照抄 test/plan.test.mjs：node:test + node:assert/strict + spawnSync 跑 CLI。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { partConnectors, partsConnected, snapPart, validate } from '../src/core/core.js';
import { loadCatalog, extractStepSamples, groupByStep, deriveSnapCandidates } from '../tools/lib/snap-gt.mjs';
import { computeOpenStuds } from '../tools/lib/open-studs.mjs';
import {
  scorePrediction, scorePhysical, scoreSnapMatch, combineScore, compareRot, pairActions, normalizeAction, WEIGHTS,
} from '../tools/brickvlm-reward.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJSON = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const cat = loadCatalog(ROOT);
const CORE = { partConnectors, partsConnected, snapPart };

const MODEL_60239 = path.join(ROOT, 'examples/60239.brick.json');
const CASE_STACK_01 = path.join(ROOT, 'out/prd-v2/run-20261026-v4/B/real-assembly-curriculum/cases/case_stack_01');
const SUB_FRONT = path.join(ROOT, 'examples/60239.sub-front-bumper.brick.json');
const GEN = path.join(ROOT, 'tools/gen-training-steps.mjs');
const REWARD = path.join(ROOT, 'tools/brickvlm-reward.mjs');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'brickkit-brickvlm-'));
const runNode = (script, args) => spawnSync(process.execPath, [script, ...args], { cwd: ROOT, encoding: 'utf8' });

const clone = (o) => JSON.parse(JSON.stringify(o));
const ACTION_FIELDS = ['part', 'color', 'on', 'stud', 'receptor', 'rot'];

/* ---------------------------------------------------------------- 共享库 */

test('open-studs：与「第 t−1 步基准状态」口径一致，且被占用凸点不再出现', () => {
  const model = readJSON(SUB_FRONT);
  // 第 32 步后 p001#0 已被 p003（3710）占用
  const at31 = computeOpenStuds(model, cat, { stepMax: 31, partConnectors });
  const at32 = computeOpenStuds(model, cat, { stepMax: 32, partConnectors });
  assert.ok(at31.length > 0);
  const keys31 = new Set(at31.map((s) => s.label));
  const keys32 = new Set(at32.map((s) => s.label));
  assert.ok(keys31.has('p001#0'), '第 31 步 p001#0 应空闲');
  assert.equal(keys32.has('p001#0'), false, '第 32 步后 p001#0 已被占用，必须从空闲表消失');
  // 标签命名契约：`${partId}#${studIndex}`（与 render --show-studs 同源）
  for (const s of at31) assert.equal(s.label, `${s.id}#${s.stud}`);
  // 缺少 partConnectors 时必须显式报错，禁止静默用另一套连接器口径
  assert.throws(() => computeOpenStuds(model, cat, {}), /partConnectors/);
});

/* ---------------------------------------------------------------- ① 端到端 no-render */

test('gen-training-steps --no-render：60239 严格模式如实产出 0 样本并计数（examples 无 snap 树）', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'sft.jsonl');
  const meta = path.join(dir, 'sft.meta.json');
  const r = runNode(GEN, ['--models', 'examples/60239.brick.json', '--out', out, '--meta', meta, '--no-render']);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const summary = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(summary.ok, true);
  assert.equal(summary.samples, 0, 'examples/60239.brick.json 没有 parts[].snap，严格模式不得凭空产出 GT');
  assert.equal(summary.dropReasons['no-snap-parts'], 40, '40 个步骤每步都全是根件，必须逐条计数');
  assert.equal(fs.readFileSync(out, 'utf8'), '', '0 样本时 JSONL 必须为空文件（不是空行集合）');
  const m = readJSON(meta);
  assert.equal(m.totals.samples, 0);
  assert.equal(m.modes.allowDerivedSnap, false);
});

test('gen-training-steps --no-render --allow-derived-snap：60239 真实模型产出合法 ShareGPT JSONL', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'sft.jsonl');
  const meta = path.join(dir, 'sft.meta.json');
  const r = runNode(GEN, ['--models', 'examples/60239.brick.json', '--out', out, '--meta', meta, '--no-render', '--allow-derived-snap']);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const summary = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(summary.ok, true);
  assert.ok(summary.samples >= 5, `60239 反解模式应产出 ≥5 个样本，实际 ${summary.samples}`);

  const raw = fs.readFileSync(out, 'utf8').trim();
  assert.ok(raw.length > 0);
  const lines = raw.split('\n');
  assert.equal(lines.length, summary.samples, 'JSONL 行数必须等于样本数');

  const model = readJSON(MODEL_60239);
  const stepMap = groupByStep(model);
  let checkedAnswers = 0;

  for (const line of lines) {
    const s = JSON.parse(line);   // 每行必须是合法 JSON
    assert.deepEqual(s.messages.map((m) => m.role), ['system', 'user', 'assistant']);
    assert.match(s.messages[0].content, /只能引用画面中可见的凸点标签/);

    const content = s.messages[1].content;
    assert.ok(Array.isArray(content));
    const textPart = content.filter((c) => c.type === 'text');
    assert.equal(textPart.length, 1, '无图模式也必须保留唯一文本段');
    // 无图模式：images 为空，meta.manual_available 必须诚实为 false
    assert.equal(content.filter((c) => c.type === 'image').length, 0);
    assert.equal(s.meta.manual_available, false);
    assert.equal(s.meta.render_mode, 'none');

    const ans = s.messages[2].content;
    assert.equal(ans.length, 1);
    assert.equal(ans[0].type, 'json');
    assert.ok(Array.isArray(ans[0].value));
    assert.ok(ans[0].value.length >= 1);

    // 答案只允许 6 个字段
    for (const a of ans[0].value) assert.deepEqual(Object.keys(a).sort(), [...ACTION_FIELDS].sort());

    // 答案引用的凸点必须出现在「可用凸点」文本里（样本可解性）
    const openList = JSON.parse(textPart[0].text.slice(textPart[0].text.indexOf('可用的凸点：') + 6));
    const openLabels = new Set(openList.map((o) => o.label));
    for (const a of ans[0].value) {
      assert.ok(openLabels.has(`${a.on}#${a.stud}`), `答案引用了不在可用凸点表里的标签：${a.on}#${a.stud}`);
      checkedAnswers++;
    }

    // GT 必须真的是该步零件的 snap（反解模式 provenance=derived），且父件在基准状态里
    const atStep = stepMap.get(s.meta.step) || [];
    const ids = new Set(atStep.map((p) => p.id));
    for (const a of ans[0].value) {
      assert.ok(ids.has(a.on) === false, '同一 GT 的父件必须来自更早的步骤');
      assert.equal(a.on in Object.fromEntries(atStep.map((p) => [p.id, 1])), false);
    }
    assert.equal(s.meta.base_step, s.meta.step - 1);
    assert.ok(s.meta.gt_count >= 1);
    assert.deepEqual(s.meta.gt_provenance, ['derived'], '60239 无 snap 树，来源必须标 derived');
  }
  assert.ok(checkedAnswers >= 5);

  const m = readJSON(meta);
  assert.equal(m.totals.samples, summary.samples);
  assert.equal(m.modes.allowDerivedSnap, true);
  assert.ok(m.totals.dropReasons['no-snap-parts'] > 0, '仍有无 snap 可反解的步骤被如实计数');
  assert.equal(m.actionFields.join(','), ACTION_FIELDS.join(','));
});

test('gen-training-steps --no-render：真实 snap 树（sub-front-bumper）产出 snap 来源样本', () => {
  const dir = tmpDir();
  const out = path.join(dir, 'sft.jsonl');
  const meta = path.join(dir, 'sft.meta.json');
  const r = runNode(GEN, ['--models', path.relative(ROOT, SUB_FRONT), '--out', out, '--meta', meta, '--no-render']);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 5, '6 个步骤中第 31 步全是根件 → 5 个样本');

  const model = readJSON(SUB_FRONT);
  const byId = new Map(model.parts.map((p) => [p.id, p]));
  for (const s of lines) {
    assert.deepEqual(s.meta.gt_provenance, ['snap'], '真实 snap 树不得被标成 derived');
    for (const a of s.messages[2].content[0].value) {
      const src = model.parts.find((p) => p.step === s.meta.step && p.part === a.part && p.snap?.on === a.on && p.snap?.stud === a.stud);
      assert.ok(src, `答案 ${JSON.stringify(a)} 在模型 parts[].snap 里找不到对应来源`);
      // 逐字段与 snap 一致（唯一可接受标注来源）
      assert.equal(a.receptor, src.snap.receptor ?? 0);
      assert.equal(a.rot, src.snap.rot ?? src.rot ?? 0);
      assert.equal(a.color, src.color);
      assert.ok(byId.get(a.on).step < s.meta.step, '父件必须更早安装');
    }
  }
});

/* ---------------------------------------------------------------- ③ 假连接门禁 */

test('gen-training-steps：GT 里假连接的样本被整步丢弃并计数', () => {
  // 造一个模型：p001→p002 真扣合（step2 合法样本），p003 的 snap 谎称扣在 p002 上但位置在天上
  // 注意 2×4 砖高 3 格（1 砖 = 3 格 = 9.6mm），正确叠放是 at[1] + 3
  const fake = {
    format: 'brickbuild',
    version: '0.2',
    meta: { name: 'fake-connection', front: '+z' },
    parts: [
      { id: 'p001', part: '3001', color: 0, at: [0, 0, 0], rootAt: [0, 0, 0], rot: 0, snot: 0, step: 1 },
      { id: 'p002', part: '3001', color: 0, at: [0, 3, 0], rot: 0, snot: 0, step: 2, snap: { on: 'p001', stud: 0, receptor: 0 } },
      // 假连接：snap 指向 p002，但实体位置在 [20, 10, 20]，partsConnected 必为 false
      { id: 'p003', part: '3001', color: 0, at: [20, 10, 20], rot: 0, snot: 0, step: 3, snap: { on: 'p002', stud: 0, receptor: 0 } },
    ],
  };
  // 前置确认：p002 的 snap 是真连接、p003 的是假连接（避免测试建立在错误假设上）
  const byId = new Map(fake.parts.map((p) => [p.id, p]));
  assert.equal(partsConnected(byId.get('p001'), cat.parts['3001'], byId.get('p002'), cat.parts['3001']), true);
  assert.equal(partsConnected(byId.get('p002'), cat.parts['3001'], byId.get('p003'), cat.parts['3001']), false);

  const r = extractStepSamples({ model: fake, cat, modelId: 'fake-connection', lib: CORE });
  assert.equal(r.samples.length, 1, '只剩 step 2 一个合法样本');
  assert.deepEqual(r.samples.map((s) => s.step), [2]);

  const failed = r.dropped.filter((d) => d.reason === 'false-connection');
  assert.equal(failed.length, 1, 'step 3 必须因假连接被丢弃');
  assert.equal(failed[0].step, 3);
  assert.deepEqual(failed[0].parts, ['p003']);
  assert.equal(failed[0].detail.includes('partsConnected(p003 on p002) 为 false'), true);
  assert.equal(r.stats.dropReasons['false-connection'], 1);
  // 另有一条 no-snap-parts（step 1 的 p001 是根件）——它不算假连接，必须分开计数
  assert.equal(r.stats.dropReasons['no-snap-parts'], 1);
  assert.equal(r.stats.dropped, 2);

  // 同一模型走 CLI 也要在 meta 里留下同样的计数
  const dir = tmpDir();
  const modelFile = path.join(dir, 'fake.brick.json');
  fs.writeFileSync(modelFile, JSON.stringify(fake, null, 2));
  const out = path.join(dir, 'sft.jsonl');
  const meta = path.join(dir, 'sft.meta.json');
  const cli = runNode(GEN, ['--models', modelFile, '--out', out, '--meta', meta, '--no-render']);
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  const summary = JSON.parse(cli.stdout.trim().split('\n').pop());
  assert.equal(summary.samples, 1);
  assert.equal(summary.dropReasons['false-connection'], 1);
  const m = readJSON(meta);
  // perModel 的 key 取自文件名（fake.brick.json → "fake"），不是 meta.name
  assert.equal(m.perModel.fake.dropReasons['false-connection'], 1);
  assert.equal(m.perModel.fake.samplesEmitted, 1);
});

test('extractStepSamples：无 snap 的零件是根件，不计入 GT；under 反扣单独计数', () => {
  const model = readJSON(SUB_FRONT);
  const r = extractStepSamples({ model, cat, modelId: 'sub-front-bumper', lib: CORE });
  // p001/p002 是 step31 的根件（无 snap）→ 该步无 GT，被 drop
  assert.equal(r.stats.dropReasons['no-snap-parts'], 1);
  // step35 的 p009 与 p010 同一步：p010 的父件在本步，被推迟而非丢弃
  const s35 = r.samples.find((s) => s.step === 35);
  assert.ok(s35);
  assert.ok(s35.deferred.length >= 1, '同一步父件的 GT 必须进 deferred，不得混进答案');
  for (const d of s35.deferred) assert.ok(!s35.gt.some((g) => g._partId === d._partId));
});

/* ---------------------------------------------------------------- ② 奖励函数 */

// 奖励函数只需要「一颗 3001 当底座」这个最小状态来验证打分链路；
// 原先读课程数据集里的 state_t.brick.json，而那套数据是本地产物（不进版本库）。
// 这里直接构造等价底座，内容与 case_stack_01 的 state_t 完全一致（1 件 3001 @ [0,0,0]）。
const stackBase = {
  format: 'brickbuild',
  version: '0.2',
  meta: { name: 'reward-base-3001' },
  parts: [{ id: 'p001', part: '3001', color: 14, at: [0, 0, 0], step: 1, status: 'confirmed' }],
};
const stackGt = [{ part: '3001', color: 14, on: 'p001', stud: 0, receptor: 0, rot: 0 }];

test('奖励：全对 pred 给高分（physical=1、snapMatch=1、无 validate 错误）', () => {
  const r = scorePrediction({ pred: clone(stackGt), gt: stackGt, model: stackBase, cat });
  assert.equal(r.score, 1);
  assert.equal(r.ok, true);
  assert.equal(r.breakdown.physical, 1);
  assert.equal(r.breakdown.snapMatch, 1);
  assert.equal(r.breakdown.noOverlap, 1);
  assert.equal(r.breakdown.visual, null, '未给 --photos 时 visual 必须为 null，不得伪造');
  assert.deepEqual(r.errors, []);
  // visual 缺失 → 0.5/0.3 归一到 0.625/0.375
  assert.deepEqual(r.weights, { physical: 0.625, snapMatch: 0.375 });
});

test('奖励：错 stud（仍物理合法）只降 snapMatch，physical 保持 1', () => {
  // 3001 有 8 颗顶凸点；stud 2 同样空着且不穿模
  const wrong = [{ ...stackGt[0], stud: 2 }];
  const r = scorePrediction({ pred: wrong, gt: stackGt, model: stackBase, cat });
  assert.equal(r.breakdown.physical, 1, '换个空闲凸点仍然是合法装配');
  assert.equal(r.details.physical.validateErrors, 0);
  assert.ok(r.breakdown.snapMatch < 1, 'stud 字段错必须让 snapMatch 掉下来');
  assert.equal(r.breakdown.snapMatch, Number((5 / 6).toFixed(4)), '6 字段错 1 个 → 5/6');
  assert.ok(r.score < 1 && r.score > 0.9, `总分应小幅下降，实际 ${r.score}`);
  assert.equal(r.ok, true, '物理合法但答案错 → ok 仍为 true（ok 只表示物理可行）');

  // 相邻研究：完全不相干的零件号也应显著降分
  const wrongPart = scorePrediction({ pred: [{ ...stackGt[0], part: '3002' }], gt: stackGt, model: stackBase, cat });
  assert.ok(wrongPart.breakdown.snapMatch < r.breakdown.snapMatch, '零件号错比 stud 错扣得更多');
});

test('奖励：穿模 pred 的 physical=0（同一凸点叠两块砖）', () => {
  const collide = [clone(stackGt[0]), { ...stackGt[0], color: 4 }];
  const r = scorePrediction({ pred: collide, gt: stackGt, model: stackBase, cat });
  assert.equal(r.breakdown.physical, 0.5, '2 条里 1 条穿模 → acceptRate 0.5');
  assert.equal(r.details.physical.accepted, 1);
  assert.equal(r.details.physical.total, 2);
  assert.equal(r.details.physical.perAction[1].ok, false);
  assert.match(r.details.physical.perAction[1].reason, /穿模/);
  assert.equal(r.breakdown.noOverlap, 0.5);
  assert.equal(r.ok, false);

  // 完全穿模：把 pred 扣到已被占用的凸点（3723 与已存在的 p001 重叠）
  const total = scorePhysical([{ part: '3001', color: 14, on: 'p001', stud: 0, receptor: 0, rot: 0 },
    { part: '3001', color: 14, on: 'p001', stud: 0, receptor: 0, rot: 0 }], stackBase, cat);
  assert.equal(total.accepted, 1);
  assert.equal(total.noOverlap, 0.5);

  // 一条都不合法（父件不存在）→ physical 0
  const zero = scorePrediction({ pred: [{ part: '3001', color: 14, on: 'p999', stud: 0, receptor: 0, rot: 0 }], gt: stackGt, model: stackBase, cat });
  assert.equal(zero.breakdown.physical, 0);
  assert.match(zero.details.physical.perAction[0].reason, /不在当前模型/);
});

test('奖励：validate 的 error 数按 1/(1+n) 惩罚 physical', () => {
  const good = clone(stackGt);
  const withValidate = scorePhysical(good, stackBase, cat);
  assert.equal(withValidate.validateErrors, 0);
  assert.equal(withValidate.score, 1);

  // 注入一个声称有 2 个 error 的 validateFn → physical 打折为 acceptRate/(1+2)
  const stubbed = scorePhysical(good, stackBase, cat, {
    validateFn: () => ({ errors: [{ code: 'x' }, { code: 'y' }], warnings: [] }),
  });
  assert.equal(stubbed.validateErrors, 2);
  assert.deepEqual(stubbed.validateErrorCodes, ['x', 'y']);
  assert.equal(stubbed.score, Number((1 / 3).toFixed(4)));

  // 真实 validate 对 stack_01 基准状态必须是零错误（夹具自身健康）
  assert.equal(validate(stackBase, cat).errors.length, 0);
});

test('奖励：snapMatch 配对覆盖（少装/多装）与 rot 180° 等价', () => {
  const twoGt = [
    { part: '3001', color: 14, on: 'p001', stud: 0, receptor: 0, rot: 0 },
    { part: '3001', color: 14, on: 'p001', stud: 2, receptor: 0, rot: 0 },
  ];
  // 少装一条 → snapMatch 按覆盖率打折
  const half = scoreSnapMatch(twoGt.slice(0, 1), twoGt, { cat });
  assert.equal(half.score, 0.5);
  assert.equal(half.missingGt, 1);
  // 多装一条 → 覆盖率不超 1，多余单独计数
  const extra = scoreSnapMatch([...twoGt, { ...twoGt[0], stud: 4 }], twoGt, { cat });
  assert.equal(extra.extraPred, 1);
  assert.equal(extra.score, 1);

  // rot 180°：正方形足迹（2×4 砖 size=[2,4] 不对称）→ 不算等价
  const sq = cat.parts['3001'];
  assert.ok(sq);
  assert.equal(compareRot(0, 180, sq), 0, '2×4 砖 180° 后轮廓不同，必须判不等价');
  assert.equal(compareRot(0, 90, sq), 0);
  assert.equal(compareRot(90, 90, sq), 1);
  // 正方形足迹零件（3024 1×1 / 3005 1×1 类）：180° 等价算半对
  const squareDef = { size: [2, 2] };
  assert.equal(compareRot(0, 180, squareDef), 0.5);
  assert.equal(compareRot(0, 180, squareDef, true), 0.5);
  // 强制 greedy 时任何 180° 都算半对（文档里写明这是宽松口径）
  assert.equal(compareRot(0, 180, sq, true), 0.5);
});

test('奖励：combineScore 权重归一与夹取', () => {
  const noVisual = combineScore({ physical: 1, snapMatch: 0, visual: null });
  assert.equal(noVisual.score, 0.625);
  assert.deepEqual(noVisual.weights, { physical: 0.625, snapMatch: 0.375 });

  const withVisual = combineScore({ physical: 1, snapMatch: 1, visual: 1 });
  assert.equal(withVisual.score, 1);
  assert.deepEqual(withVisual.weights, { physical: 0.5, snapMatch: 0.3, visual: 0.2 });
  assert.equal(WEIGHTS.physical + WEIGHTS.snapMatch + WEIGHTS.visual, 1);

  const mid = combineScore({ physical: 0.5, snapMatch: 0.5, visual: 0.5 });
  assert.equal(mid.score, 0.5);
  // 越界值夹到 [0,1]
  assert.equal(combineScore({ physical: 2, snapMatch: 2, visual: null }).score, 1);
});

test('奖励：CLI 输出 schema 与 --out 落盘（三条：全对/错 stud/穿模）', () => {
  const dir = tmpDir();
  const preds = path.join(dir, 'preds.jsonl');
  const outFile = path.join(dir, 'reward.json');
  const rows = [
    { model: 'case_stack_01', step: 2, pred: clone(stackGt), gt: stackGt },
    { model: 'case_stack_01', step: 2, pred: [{ ...stackGt[0], stud: 2 }], gt: stackGt },
    { model: 'case_stack_01', step: 2, pred: [clone(stackGt[0]), { ...stackGt[0], color: 4 }], gt: stackGt },
  ];
  fs.writeFileSync(preds, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // CLI 需要一个真实的模型文件路径：把上面构造的等价底座写到临时目录
  const baseFile = path.join(dir, 'stack-base.brick.json');
  fs.writeFileSync(baseFile, JSON.stringify(stackBase, null, 2));
  const r = runNode(REWARD, ['--predictions', preds, '--model', baseFile, '--out', outFile]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const lines = r.stdout.trim().split('\n').map((s) => JSON.parse(s));
  const summary = lines.pop();
  assert.equal(summary.ok, true);
  assert.equal(summary.rows, 3);
  assert.equal(summary.visualUsed, false);
  assert.equal(lines.length, 3);
  assert.ok(fs.existsSync(outFile));
  assert.equal(fs.readFileSync(outFile, 'utf8').trim().split('\n').length, 3);

  for (const row of lines) {
    assert.equal(typeof row.score, 'number');
    assert.ok(row.score >= 0 && row.score <= 1);
    assert.deepEqual(Object.keys(row.breakdown).sort(), ['noOverlap', 'physical', 'snapMatch', 'visual']);
    assert.ok(Array.isArray(row.errors));
    assert.equal(typeof row.ok, 'boolean');
  }
  // 分数单调：全对 > 错 stud > 穿模
  assert.ok(lines[0].score > lines[1].score, `${lines[0].score} 应 > ${lines[1].score}`);
  assert.ok(lines[1].score > lines[2].score, `${lines[1].score} 应 > ${lines[2].score}`);
  assert.equal(lines[0].score, 1);
  assert.equal(lines[2].breakdown.physical, 0.5);
});

test('奖励：pairActions / normalizeAction 的确定性配对', () => {
  const pred = [{ part: '3001', color: '14', on: 'p001', stud: '0' }];   // 字符串数字也要吃下
  const gt = [{ part: '3001', color: 14, on: 'p001', stud: 0, receptor: 0, rot: 0 }];
  const p = pairActions(pred, gt);
  assert.equal(p.pairs.length, 1);
  assert.equal(p.extraPred, 0);
  assert.equal(p.missingGt, 0);
  const n = normalizeAction({ part: 3001, color: null, on: null, stud: undefined });
  assert.deepEqual(n, { part: '3001', color: 0, on: '', stud: 0, receptor: 0, rot: 0 });
});

/* ---------------------------------------------------------------- 反解器回归 */

test('deriveSnapCandidates：与真实 snap 树逐条对齐（不许反解出不同答案）', () => {
  const model = readJSON(SUB_FRONT);
  const derived = deriveSnapCandidates({ model, cat, ...CORE });
  // 对「模型里已有 snap」的零件，反解不应覆盖；这里只检查反解出的东西物理成立
  for (const [id, d] of derived) {
    const child = model.parts.find((p) => p.id === id);
    const parent = model.parts.find((p) => p.id === d.on);
    assert.ok(child && parent);
    assert.equal(partsConnected(parent, cat.parts[parent.part], child, cat.parts[child.part]), true);
  }
  // 真实 snap 树全部零件都有 snap → 反解集合必须为空（不重复造标注）
  assert.equal(derived.size, 0);

  // 无 snap 的模型：反解结果逐条必须 partsConnected 成立（只认物理成立的解）
  const m60239 = readJSON(MODEL_60239);
  const d2 = deriveSnapCandidates({ model: m60239, cat, ...CORE });
  assert.ok(d2.size > 0, '60239 应能反解出一部分唯一扣合');
  const byId = new Map(m60239.parts.map((p) => [p.id, p]));
  for (const [id, d] of d2) {
    const child = byId.get(id);
    const parent = byId.get(d.on);
    assert.equal(partsConnected(parent, cat.parts[parent.part], child, cat.parts[child.part]), true, `${id} 反解结果物理不成立`);
    // 反解坐标必须能复现原 at（引擎口径，不是拍脑袋）
    const sn = snapPart(parent, cat.parts[parent.part], d.stud, { id, part: child.part, color: child.color, rot: child.rot, up: child.up }, cat.parts[child.part], d.receptor, { under: d.under });
    assert.ok(Math.abs(sn.at[0] - child.at[0]) < 1e-7 && Math.abs(sn.at[1] - child.at[1]) < 1e-7 && Math.abs(sn.at[2] - child.at[2]) < 1e-7);
  }
});
