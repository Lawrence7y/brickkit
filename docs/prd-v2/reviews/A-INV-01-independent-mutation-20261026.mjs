// Independent rerun derived from out/prd-v2/2026-10-26-a/A/inventory/mutation-prove-assertion-bites.mjs; source SHA256 8fdeea4e786748397efbb19ef11d9620d269689a8f86076002c8f26d68218568.
// ROOT, output directory/name, and unique guarded temporary filename changed only.
// A-INV-01 变异测试：证明新回归断言真的能抓到旧缺陷。
//
// 做法：把当前 apply.js 复制成同目录的临时变异体（相对 import 才能解析），
// 注入「旧行为」（成功时不写回 consumed），再跑与 INV-02 相同的两步装配。
// 若变异体仍然通过，说明断言是空的；必须看到 mutant 复现「3→5 件」而 fixed 拒绝。
//
// 不修改仓库里的实现文件；临时文件在 finally 里删除。
//
// 用法：node out/prd-v2/2026-10-26-a/A/inventory/mutation-prove-assertion-bites.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

const ACTIONS_DIR = path.join(ROOT, 'src/core/actions-v1');
const MUTANT = path.join(ACTIONS_DIR, `apply.codex-audit-mutant-${process.pid}.js`);
if (fs.existsSync(MUTANT)) throw new Error('Independent mutant path already exists; refusing overwrite');

const { inspectFromModel } = await load('src/core/actions-v1/state.js');
const { enumerateCandidates } = await load('src/core/actions-v1/candidates.js');
const { applyActions: fixedApply } = await load('src/core/actions-v1/apply.js');

const readJSON = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const cat = {
  parts: { ...readJSON('catalog/parts-ldraw.json').parts, ...readJSON('catalog/parts.json').parts },
  colors: readJSON('catalog/colors.json').colors,
};

const childModel = { parts: [
  { id: 'bump1', part: '3023', color: 0, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 },
  { id: 'bump2', part: '2412b', color: 4, at: [0, 1, 0], rot: 0, up: '+y', snot: 0, step: 1 },
] };
const baseModel = () => ({ format: 'brickbuild', version: '0.2', parts: [
  { id: 'base', part: '3001', color: 15, at: [0, 0, 0], rot: 0, up: '+y', snot: 0, step: 1 },
] });

function runTwoTransactions(applyFn) {
  const attach = (model, inventory, nodeId) => {
    const si = inspectFromModel(model, cat, { inventory, mainRootNodeId: 'base' });
    const en = enumerateCandidates(si.state, { childModel, parentNodeId: 'base', maxResults: 5000 }, cat);
    const cand = en.items[0];
    const ctx = { model, cat, stateHash: si.stateHash, state: si.state, taskId: 'mut', mainRootNodeId: 'base', inventory,
      enumerate: (r) => enumerateCandidates(si.state, r, cat) };
    return applyFn(ctx, { protocolVersion: '1.0.0', taskId: 'mut', stateHash: si.stateHash, actions: [{
      id: `a-${nodeId}`, op: 'attach_assembly', target: { partInstanceId: nodeId },
      candidateId: cand.candidateId, candidateHash: cand.candidateHash, partId: cand.childPartId, color: 0, childModel,
    }] });
  };
  const first = attach(baseModel(), [
    { token: 'm1', partId: '3023', color: 0, state: 'available' },
    { token: 'm2', partId: '2412b', color: 4, state: 'available' },
  ], 'g1');
  const second = attach(first._workingModel, first._inventory, 'g2');
  const t1 = first.apply?.results?.[0]?.applied?.inventoryTokens || [];
  const t2 = second.apply?.results?.[0]?.applied?.inventoryTokens || [];
  return {
    firstPassed: first.passed,
    inventoryAfterFirst: (first._inventory || []).map((i) => `${i.token}:${i.state}`),
    afterFirstParts: first._workingModel ? first._workingModel.parts.length : null,
    secondPassed: second.passed,
    secondCodes: (second.diagnostics || []).map((d) => d.code),
    finalParts: second._workingModel ? second._workingModel.parts.length : null,
    reusedSameTokens: t2.filter((t) => t1.includes(t)),
  };
}

const mutations = [];
let mutantApply = null;
try {
  let src = fs.readFileSync(path.join(ACTIONS_DIR, 'apply.js'), 'utf8');

  // 注入点 1：consumeToken 不再写回记录本体，只维持批次内 Set —— 这正是修复前的行为
  const beforeConsume = src;
  src = src.replace(
    /function consumeToken\(inventory, invByToken, token, nodeId, consumedNow\) \{[\s\S]*?\n\}/,
    'function consumeToken(inventory, invByToken, token, nodeId, consumedNow) {\n  consumedNow.add(token);\n}',
  );
  if (src === beforeConsume) throw new Error('变异注入失败：找不到 consumeToken 函数体，脚本需随实现同步更新');
  mutations.push('consumeToken 只维护批次内 Set，不写回 inv.state=consumed');

  // 注入点 2：恢复旧 rehash 的库存映射写法
  const beforeRehash = src;
  src = src.replace(
    /prevState\.inventory = inventory\.map\(\(i\) => \(\{ \.\.\.i \}\)\);/,
    "prevState.inventory = inventory.map((i) => ({ ...i, state: i.state === 'consumed' ? 'consumed' : (i.state || 'available') }));",
  );
  if (src === beforeRehash) throw new Error('变异注入失败：找不到 rehash 的库存赋值行');
  mutations.push('rehash 恢复旧的库存映射（不把 consumed 当权威）');

  // 注入点 3：去掉「同件号库存全消费必须拒绝」的新守卫（旧版静默继续）
  const beforeGuard = src;
  src = src.replace(
    /\n    else if \(samePart\.length\) \{[\s\S]*?\n    \}\n  \}/,
    '\n  }',
  );
  if (src === beforeGuard) throw new Error('变异注入失败：找不到单件库存守卫分支');
  mutations.push('去掉单件路径「同件号库存全消费必须拒绝」守卫');

  fs.writeFileSync(MUTANT, src);
  mutantApply = (await import(`${pathToFileURL(MUTANT).href}?v=${Date.now()}`)).applyActions;
} finally {
  if (fs.existsSync(MUTANT)) fs.rmSync(MUTANT, { force: true });
}

if (!mutantApply) throw new Error('变异体未生成');

const fixedRun = runTwoTransactions(fixedApply);
const mutantRun = runTwoTransactions(mutantApply);

const assertions = {
  fixedSecondRejected: fixedRun.secondPassed === false,
  fixedNoTokenReuse: fixedRun.reusedSameTokens.length === 0,
  fixedInventoryConsumed: fixedRun.inventoryAfterFirst.every((s) => s.endsWith(':consumed')),
  mutantReproducesDefect: mutantRun.secondPassed === true && mutantRun.finalParts === 5,
  mutantReusesSameTokens: mutantRun.reusedSameTokens.length === 2,
  mutantMatchesBReportedCounterexample: mutantRun.afterFirstParts === 3 && mutantRun.finalParts === 5,
};

const out = {
  generatedAt: new Date().toISOString(),
  purpose: '证明 A-INV-01 回归断言不是空断言：还原旧行为后必须复现缺陷（1→3→5 件且零错误）',
  mutations,
  fixed: fixedRun,
  mutant: mutantRun,
  assertions,
  ok: Object.values(assertions).every(Boolean),
};

const outDir = path.join(ROOT, 'docs/prd-v2/reviews');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'A-INV-01-independent-mutation-20261026.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
