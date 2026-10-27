// EN-04 独立配件名单联调实测（HANDOFF-C §3 C3-4 / PRD v2 EN-04，原 A 报告记 partial：
// 「独立配件名单由冻结计划指定（需 B 的 C2）未联调」）。
//
// 联调链路（全部真实数据，不用 mock）：
//   冻结验收 60239.acceptance.json（83 主体 + 8 配件，root p001，主体必须可达）
//   + 冻结任务包 60239.build.plan.json（role=accessory：task-minifig 4 + task-cones 4）
//   + 已验证模型 60239.fixed.brick.json（91 件，validate 0/0）
//   → 引擎 inspectFromModel 可达性 / BOM 守恒 / validate strictAssembly 配件豁免 逐项对账。
// 证据写入 out/prd-v2/run-20261026-c/C/engine/en04-accessory-integration.json。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../src/core/core.js';
import { inspectFromModel } from '../src/core/actions-v1/state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_OUT = path.join(ROOT, 'out', 'prd-v2', 'run-20261026-c', 'C', 'engine');
// 验收标准与构建计划是固定契约产物，放 examples/60239/ 随仓库分发
const DIR = path.join(ROOT, 'examples/60239');
const cat = {
  parts: {
    ...JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts-ldraw.json'), 'utf8')).parts,
    ...JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/parts.json'), 'utf8')).parts,
  },
  colors: JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/colors.json'), 'utf8')).colors,
};
const acceptance = JSON.parse(fs.readFileSync(path.join(DIR, '60239.acceptance.json'), 'utf8'));
const plan = JSON.parse(fs.readFileSync(path.join(DIR, '60239.build.plan.json'), 'utf8'));
const fixed = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/60239.fixed.brick.json'), 'utf8'));

/** 冻结计划里的 accessory 任务包（task-minifig + task-cones）→ (partId,colorId) 多重集合 */
function accessoryTokens() {
  const packs = plan.taskPackages.filter((t) => t.role === 'accessory');
  const tokens = packs.flatMap((t) => t.inventory.tokens.map((tok) => ({ taskId: t.taskId, part: tok.partId, color: tok.colorId, token: tok.tokenId })));
  return { packs: packs.map((t) => t.taskId), tokens };
}

test('EN-04 ① 冻结计划配件名单 ↔ 模型 BOM 守恒：8 配件逐个命中，83+8=91', () => {
  assert.equal(acceptance.criteria.partAllocation.totalParts, 91);
  assert.equal(acceptance.criteria.partAllocation.carBodyParts, 83);
  assert.equal(acceptance.criteria.partAllocation.accessoriesParts, 8);
  const { packs, tokens } = accessoryTokens();
  assert.deepEqual(packs, ['task-minifig', 'task-cones']);
  assert.equal(tokens.length, 8);
  // 模型 BOM（part|color 计数）
  const bom = new Map();
  for (const p of fixed.parts) {
    const k = `${p.part}|${p.color}`;
    bom.set(k, (bom.get(k) || 0) + 1);
  }
  const total = [...bom.values()].reduce((a, b) => a + b, 0);
  assert.equal(total, 91);
  // 每个配件 token 都能在模型 BOM 里扣减（件号 + 颜色逐项命中）
  const available = new Map(bom);
  const matched = [];
  for (const tok of tokens) {
    const k = `${tok.part}|${tok.color}`;
    const n = available.get(k) || 0;
    assert.ok(n > 0, `配件 token ${tok.token}（${tok.part}/${tok.color}）不在模型 BOM 中`);
    available.set(k, n - 1);
    matched.push({ ...tok, bomKey: k });
  }
  assert.equal(matched.length, 8);
  // 反向：模型中 (part,color) 命中配件名单的件数必须恰为 8（多一颗都算名单外）
  const accKeys = new Set(tokens.map((t) => `${t.part}|${t.color}`));
  let accCount = 0;
  for (const [k, n] of bom) if (accKeys.has(k)) accCount += n;
  assert.equal(accCount, 8, `按件号+颜色命中的配件应恰 8 颗，实际 ${accCount}`);
});

test('EN-04 ② 引擎可达性：配件 ⊆ bodyPartsUnreachable，主体口径 83 = 91 − 8，root p001 可达 75 件', () => {
  const si = inspectFromModel(fixed, cat, { mainRootNodeId: acceptance.criteria.reachability.rootPartId });
  assert.ok(si.state.reachability, '必须产出 reachability（EN-04 引擎字段）');
  const { tokens } = accessoryTokens();
  const accKeys = new Set(tokens.map((t) => `${t.part}|${t.color}`));
  const accIds = fixed.parts.filter((p) => accKeys.has(`${p.part}|${p.color}`)).map((p) => p.id);
  assert.equal(accIds.length, 8);
  const unreach = new Set(si.state.reachability.bodyPartsUnreachable);
  for (const id of accIds) assert.ok(unreach.has(id), `配件 ${id} 应在 bodyPartsUnreachable 中（独立摆放的地面件）`);
  // 不可达 16 = 轮 8 + 配件 8；主体 83 口径 = 91 − 8 配件（轮按验收口径属于主体，但物理上
  // 与车体无连接器连接——已知目录缺口：11208 轮芯孔 vs 18892 销、50745 挡泥板无受体，本任务不修目录）
  assert.equal(si.state.reachability.bodyPartsTotal, 91);
  assert.equal(si.state.reachability.bodyPartsReachable, 75);
  assert.equal(unreach.size, 16);
  const wheelParts = new Set(['11208', '11209']);
  const wheelIds = fixed.parts.filter((p) => wheelParts.has(p.part)).map((p) => p.id);
  assert.equal(wheelIds.length, 8);
  for (const id of wheelIds) assert.ok(unreach.has(id), `轮件 ${id} 物理上也未连到车体（如实记录）`);
});

test('EN-04 ③ strictAssembly 配件豁免：散件判罚只允许指向轮件（目录缺口），绝不指向 8 颗名单内配件', () => {
  // 联调形态：按冻结名单给 8 颗配件打 accessory 标记 + accessories 模块（生产接线形态）
  const { tokens } = accessoryTokens();
  const accKeys = new Map();   // part|color → 需要标记的件数
  for (const t of tokens) {
    const k = `${t.part}|${t.color}`;
    accKeys.set(k, (accKeys.get(k) || 0) + 1);
  }
  const annotated = JSON.parse(JSON.stringify(fixed));
  annotated.meta = { ...annotated.meta, strictAssembly: true };
  annotated.modules = [{ id: 'accessories', label: '独立配件（冻结名单）' }];
  for (const p of annotated.parts) {
    const k = `${p.part}|${p.color}`;
    if ((accKeys.get(k) || 0) > 0) {
      accKeys.set(k, accKeys.get(k) - 1);
      p.accessory = true;
      p.module = 'accessories';
    }
  }
  const marked = annotated.parts.filter((p) => p.accessory === true);
  assert.equal(marked.length, 8, '必须恰好标记 8 颗配件');

  const v = validate(annotated, cat, { strictAssembly: true });
  const scattered = v.errors.filter((e) => e.code === 'scattered-parts-tray');
  const scatteredIds = new Set(scattered.flatMap((e) => e.parts));
  const wheelParts = new Set(['11208', '11209']);
  for (const id of scatteredIds) {
    const p = annotated.parts.find((x) => x.id === id);
    assert.ok(p && wheelParts.has(p.part), `strictAssembly 判罚出现了非轮件 ${id}（${p && p.part}）——配件豁免失效`);
  }
  // 配件一律不得出现在判罚名单
  for (const p of marked) assert.ok(!scatteredIds.has(p.id), `配件 ${p.id} 被误判为散件`);
  // 轮件未被豁免是引擎如实行为（目录连接器缺口，属已知输入，不是本引擎缺陷）
  const report = {
    gate: 'EN-04', item: 'accessory-list-integration',
    acceptance: { setId: acceptance.setId, carBody: 83, accessories: 8, total: 91, rootPartId: 'p001' },
    planAccessoryPackages: ['task-minifig', 'task-cones'],
    bomConservation: '8 配件逐 token 命中模型 BOM；91 = 83 + 8',
    reachability: { bodyPartsTotal: 91, reachableFromRoot: 75, unreachable: 16, accessoriesInUnreachable: 8, wheelsInUnreachable: 8 },
    strictAssembly: {
      annotatedAccessories: 8,
      scatteredVerdict: scattered.length ? scattered[0].msg : null,
      scatteredParts: [...scatteredIds].sort(),
      accessoryExemptionWorks: true,
      wheelCaveat: '8 颗轮件（11208×4 + 11209×4）与车体无连接器连接（已知目录几何缺口：11208 轮芯孔 vs 18892 销、50745 挡泥板无受体——按任务输入不修目录），引擎如实地将其列为散件；这 8 颗按验收口径属于 83 主体。largestComponentRatio = 0.824 ≥ 0.80',
    },
    verdict: 'verified（配件名单联调通过；轮件连接受目录缺口限制，如实单列）',
  };
  fs.mkdirSync(ENGINE_OUT, { recursive: true });
  fs.writeFileSync(path.join(ENGINE_OUT, 'en04-accessory-integration.json'), JSON.stringify(report, null, 2) + '\n');
});
