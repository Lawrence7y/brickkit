# C 里程碑复核（C0 + C1 + C3-4）— 2026-10-26

- 复核对象：契约冻结（C0）、BrickVLM 真实数据工厂（C1）、引擎遗留门禁（C3-4）、C3-3 四步流程集成
- 复核人：独立只读复核者（PRD §13.4），**未参与**被复核内容的实现
- 仓库：`D:/Project/brickkit`；证据根目录：`docs/prd-v2/reviews/`
- 环境约束：**纯 CPU**（有 QLoRA 训练占用 GPU，未运行任何 python/torch/model 代码），仅 Node 探针与 `node --test`

> **本复核为同一模型的不同会话复核，不等同于跨 Harness 复核。**
> 独立性的实际含义：判据不采信被复核方的报告与既有 `C-milestone-1-*` 探针结论，全部探针为本轮新写在 `docs/prd-v2/reviews/C-milestone-1-indep-*`，直接调用 `src/` 下的真实引擎与 `src/manual-v2/workflow.js` 的真实导出。

---

## 一、总表

| # | 复核项 | 结论 | 关键实测数字 |
|---|---|---|---|
| 1 | C0 契约冻结 | **PASS** | `FROZEN-VALID`；engineRevision 复算 `85ad1710…d1fd8` 一致；12 文件；refreezeHistory 记录 CP-02 |
| 2 | C0-4 收据门禁 | **PASS** | 源测试 11/11；自建反例 (a) revision 999+假 hash 被拒、(b) totalBOMParts 999 vs 91 被拒 |
| 3 | C1 轨迹数据集 | **PASS** | 25/25 真实 `applyActions` 重放等于 state_t+1；图像 sha 10/10；公开候选泄漏 0/10；全量 2225 泄漏 0 |
| 4 | C1 扰动数据集 | **PASS** | repair 13/13 canonical 哈希恢复参考态；understand_structure 12/12 结构 diff 复现；匿名 10/10 + 全量 2496 干净 |
| 5 | C1-5 数据划分 | **PASS** | 5/5 文件 sha 一致；`.frozen` 在；跨 split 重叠 0；4 个留出族在 train 中零出现 |
| 6 | C3-4 引擎门禁 | **PASS** | `275/275 pass`；`c3-4-report.md` 存在；EN-05 独立负例 12/12 半格错位被拒 |
| 7 | C3-6 60239 零错误 | **PASS** | `ok:true` 0 errors 0 warnings 91 parts |
| 8 | C3-3 WF-04：题面 5 项核验 | **PASS** | 3 会话 / 2 子会话，3 个 conversationId 互异且异于主会话；装配 66 件 0/0；30+24+12=66，逐包 token BOM == 构建 BOM |
| 9 | C3-3 WF-04：收据真实绑定（新增） | **FAIL** | 真实 `auditTotalAssembly` 重审 **79 errors / 7 reason codes**（详见 §3） |

合计：**8 PASS / 1 FAIL / 0 UNABLE**（第 9 项是按第 8 项的「收据记录并绑定任务包」语义追加的必然推论，非题面放宽项）。

---

## 二、逐项复现与观测

### 1. C0 契约冻结 — PASS

```bash
node docs/prd-v2/implementation-C/contracts/validate-contracts-1.0.mjs
```

观测：`verdict: FROZEN-VALID`，`jsChecksPassed: true`，`pythonCrossCheck: ok`，`fixtureAssetLock: 5/5 tasks`，
`fixtureRenderState: true`，`fixtureFullAssembly: true`，`curriculumSamples: 15 samples, passed=true`，
`negativeProbes: 12/12`，`blockers: 0`，`versionConsistency: true`。

`docs/prd-v2/implementation-C/contracts/version.json`：`frozen: true`、`version 1.0.0`、`frozenAt 2026-10-26T16:36:27.493Z`、
`refrozenAt 2026-10-26T22:05:00Z`。

我自己复算（独立脚本，未用校验器的函数）：

- engineRevision 全量 = `85ad171008ef1fa68570eb16d7b759d8fbf34bc4df846c748127238e1e2d1fd8`，与声明**逐字符相等**，12 个文件。
  - 复算要点：`engineRevisionPerDir` 是「目录内文件哈希**未排序**拼接」，而全量是「全部文件哈希**升序**拼接」；两者算错任一个都会对不上——声明本身写对了。
- CP-02 变更可证伪性检验：用 `out/prd-v2/run-20261026-c/C/engine/old-snapshot/` 独立复算旧引擎哈希 =
  `88b51e1934c3fec901b9b6df5466188920c9b556487d110615938eaadcede5d3`，与 `refreezeHistory[0].priorEngineRevision` **完全一致**。
- 与旧快照逐文件比对，实际只有 `src/core/actions-v1/state.js`、`src/core/actions-v1/render-state.js` 两文件变化，
  与 refreezeHistory 里「行为保持性优化只改这两处」的描述吻合；`cp02-fp-old.json` vs `cp02-fp-new.json` 除 `coreDir` 字段外指纹**完全一致**。

结论：冻结状态、哈希复算、重冻结历史三者自洽，非事后补写。

### 2. C0-4 收据门禁 — PASS

```bash
node --test test/receipt-gating.test.mjs          # # tests 11 / # pass 11 / # fail 0
node docs/prd-v2/reviews/C-milestone-1-indep-receipt-probe-20261026.mjs
```

自建反例（调用 `src/manual-v2/workflow.js` 的 `generateBuildPlan` / `createBoundTaskReceipt` / `auditTotalAssembly`）：

| 反例 | 构造 | 结果 |
|---|---|---|
| (a) | `revision: 999` + `stateHash: 'b'*64`，无内联 state / stateFile | **拒**，`RECEIPT_REVISION_MISMATCH` + `RECEIPT_STATEHASH_UNBOUND` + `RECEIPT_EVIDENCE_MISSING`，binding=`unverified` |
| (a2) | revision 合法，仅 64 位假 hash 且无状态证据 | **拒**，`RECEIPT_STATEHASH_UNBOUND` |
| (b) | 计划 `totalBOMParts: 999`，实际分配 91 | **拒**，`PLAN_BOM_TOTAL_MISMATCH` |

正向：真实绑定收据 5 包 91 件 → `ok: true`，`reasonCodes: []`。原因码与反例一一对应，非泛化报错。

### 3. C1 轨迹数据集 — PASS

```bash
node docs/prd-v2/reviews/C-milestone-1-indep-traj-probe-20261026.mjs
```

- 总体 2225 样本；用**独立种子**随机抽 25 条（非生成器的 `mulberry32(20261026)`）。
- 每条从 `stateRefs[0].brickPath` 读 state_t → `inspectFromModel` 复算哈希 → 构造
  `{model, cat, stateHash, inventory, taskId, enumerate}` ctx → 真实 `applyActions`
  （`src/core/actions-v1/apply.js`）→ 比对。
- 结果：**25/25 通过**；重放 `apply.stateHashAfter` 同时等于 存储的 `actionResponse` 值 与 `state_t+1` 的 stateHash；
  state_t 文件哈希与重算哈希 25/25 一致。
- 图像 sha256 对磁盘：**10/10 匹配**（覆盖 labeled / target_state / score_unlabeled 三种 role 中随机取到的前 10 张）。
- 泄漏扫描（10 条，分三层）：公开 `candidates` 载荷中 `isTarget`/`groundTruth`/`correct`/`answer` 命中 **0**；
  去掉 `verification` 与 `target` 后的公开载荷命中 **0**；`verification` 内部若出现这些键则**只允许**在 `labels`/`groundTruth` 段内 —— 非法位置命中 **0**。
- 补充全量旁证（我自己加跑）：2225 条全部满足「答案候选 ∈ 公开候选集」「答案 ∈ 等价组」「候选区无标记字段」，命中 0/2225。

说明：公开候选条数（3–5）是引擎等价组（`equivalentGroupSize` 可达 4）的对外子集，`target` 与 `equivalentCandidates`
始终落在公开集内；标签字段只在 `verification.labels`（按 C3 契约恒定的 ground-truth 区），不属于模型输入。

### 4. C1 扰动数据集 — PASS

```bash
node docs/prd-v2/reviews/C-milestone-1-indep-pert-probe-20261026.mjs
```

池：`repair_local` 1248、`understand_structure` 1248；抽 13 + 12 = 25 条。

**repair_local（13/13 PASS）**：从 `perturbed.brick.json` 出发，按 `verification.labels.repairPlan.transactions`
逐事务真实 `applyActions`，每事务前 `stateHash` 必须等于事务声明的 `stateHash`（**13/13**），
最终 canonical（按 id 排序、model-only）哈希 = 参考态 `modelOnlyStateHash`（**13/13**）。
`fullStateHashRestored` 仅 8/13 —— 但与本条样本自身的 `verification.repairVerification.fullStateHashRestored`
**逐条一致（13/13 一致）**：wrong_color 类扰动的库存消耗面不同，含库存的 full 哈希不必然回到参考值，
canonical 才是该数据集的判定口径。属既有口径，非新缺陷。

**understand_structure（12/12 PASS）**：我用自写的 id 配对结构 diff（不 import 生成器的 `diffStructures`）
重算 `removed/added/changed`，再按同样规则分类 `errorType`，与存储值比对：errorType **12/12**、issue 数 **12/12**、
issue 载荷（issueType / partRef / expected / actual）**12/12** 一致。抽样覆盖到 5 种扰动类型
（misaligned 5、missing_part 2、reversed_orientation 2、wrong_color 1、left_right_swap 2）。

**匿名性（10/10 + 全量）**：抽样 10 条与全量 2496 条的公开字段（candidates / inventory / interfaceMap / images）
中，`pNNN` 实例 id、`tok-fam-*` 真实 token、`cand-<hex12>` 引擎候选 id 命中 **0**；候选 id 全部为 `cand_xxxx` 形态。

### 5. C1-5 数据划分 — PASS

```bash
node docs/prd-v2/reviews/C-milestone-1-indep-splits-probe-20261026.mjs
```

- `freeze.splitFiles` 4 个 + `assignmentFile` 共 5 个文件 sha256 **5/5 匹配**：
  train `765f7941…3082d`(3155)、validation `4226981f…3a80f`(905)、holdout_test `5599e8ba…cdca5`(827)、dev `514ef88e…b5b50`(33)、assignment `7a62ae46…adc585`。
- `.frozen` 存在且自洽：其 `manifestSha256` / `probesSha256` / `assignmentSha256` 我逐个复算，**全部匹配**。
- 各 split 的 `samples.length` == 文件内 `sampleCount` == manifest 声明值（4/4）。
- 两两 split 求 sampleId 交集：**0 对重叠**（train/validation/holdout_test/dev 共 6 对）。
- 留出族 `fam-arch`、`fam-snotwall`、`fam-cargoer`、`fam-bracketholder` 在 `train.json` 的 familyId 集合中出现次数 **0**。

### 6. C3-4 引擎门禁 — PASS

```bash
node --test --test-reporter=spec test/*.test.mjs     # ℹ tests 275 / ℹ pass 275 / ℹ fail 0 / skipped 0 / todo 0
```

`out/prd-v2/run-20261026-c/C/engine/c3-4-report.md` 存在，逐门禁 ST-04 / AS-05 / AS-06 / EN-04 / EN-05 / CP-02 均有「一句话证据 + 复现命令」。

**EN-05 独立抽查**（我自建，不复用测试文件里的夹具构造代码）：

```bash
node docs/prd-v2/reviews/C-milestone-1-indep-en05-probe-20261026.mjs
```

- 从 95 条必需连接（83 snap + 12 物理对）中取第 1 / 中位 / 末位 3 对：`p001|p002`、`p029|p063`、`p075|p089`。
- 正例对照：3/3 `partsConnected === true`（确认我取的位姿确实成立，负例不是空转）。
- 半格（0.5 格）错位负例，两个水平轴 × 正负共 4 组：**12/12 全部被拒**（`partsConnected === false`）。
- 附带发现（非缺陷）：整格（±1 格）沿凸点阵平移仍有 10 次 `partsConnected === true` —— 沿已铺凸点表面整格滑动仍合法扣合，
  与 `test/engine-c3-en05-connections.test.mjs` 里「故错位负例取半格」的注释一致，是引擎正确行为。

证据 JSON 自洽抽查：`en05-connection-fixtures.json` 95/380、`en05-shifted-detail.json` 95/95 拒、`en05-direction-detail.json` 95/95 拒、`en05-colliding-detail.json` 95/95 overlap。

### 7. C3-6 60239 零错误 — PASS

```bash
node cli/brickkit.mjs validate out/prd-v2/run-20261026-c/C/integration/60239/60239.fixed.brick.json
```

`{"ok":true,"errors":[],"warnings":[],"stats":{"parts":91,"steps":36,"connectedComponents":4,"largestComponentRatio":0.912088}}`
—— 91 件、0 错误、0 警告，与题面要求一致。

### 8. C3-3 WF-04：题面列明的 5 项核验 — PASS

```bash
node cli/brickkit.mjs validate out/prd-v2/run-20261026-c/C/integration/fourstep/build/harbor-crane.assembly.brick.json
```

`receipts/wf-04-fourstep.receipt.json` 观测：

1. **≥2 子会话且 conversationId 互异**：`sessions` 3 条，`subagentSessions: 2`；
   master `session_d1aabeed38c279be3291dd2d6c82cf76`、SA-1 `agent_65007cda-b943-4c48-8400-6b8fedd6029b`、
   SA-2 `agent_b505358a-11ef-4691-bf57-0fe6eecab95d`，两两互异（3 组比较均 false）。
2. **装配模型**：`ok:true` 0 errors 0 warnings **66 parts**（steps 8，connectedComponents 1）。
3. **BOM 守恒**：`30 + 24 + 12 = 66`；三个任务包的 token BOM（件号×颜色）与三个已构建模型的 BOM **逐包完全相等**（3/3）。
4. **收据记录子代理 conversationId**：`sessions[].conversationId` 与子收据 `sessionEvidence.conversationId` 一致（SA-2 是 `sess_subagent_agent_b505…` 包裹形态，含同一 agentId）。
5. **子会话 id ≠ 主会话 id**：确认（`session_…` vs `agent_…`，见上）。

附带：`artifacts` 8 个哈希我逐个复算 **8/8 匹配**；`acceptance.json` / `build.plan.json` 哈希匹配；三个子模型各自 `validate` 0/0（30/24/12）。

### 9. C3-3 WF-04：收据真实绑定 — **FAIL**

题面第 8 项只说「确认收据记录了子代理 conversationId」，这部分通过。但按 WF-04 的验收语义（收据须与任务包真实绑定）再往前一步，
把两份**真实子收据**交给**真实** `auditTotalAssembly` 审计，结果不成立：

```bash
node -e "import('./src/manual-v2/workflow.js').then(W=>{
  const plan={contractRevision:'1.0.0',totalBOMParts:66,taskPackages:[
    require('./out/prd-v2/run-20261026-c/C/integration/fourstep/task-packages/c3-3-main.json'),
    require('./out/prd-v2/run-20261026-c/C/integration/fourstep/task-packages/c3-3-sa1-jib.json'),
    require('./out/prd-v2/run-20261026-c/C/integration/fourstep/task-packages/c3-3-sa2-cab.json')]};
  console.log(W.auditTotalAssembly(plan,[<sa1 receipt>,<sa2 receipt>]).errors) })"
```

实测：`ok: false`，**79 errors**，7 个原因码
（`RECEIPT_REVISION_MISMATCH`、`RECEIPT_TOKEN_PART_MISMATCH`、`RECEIPT_TOKEN_COLOR_MISMATCH`、
`RECEIPT_TOKEN_NOT_ALLOCATED`、`RECEIPT_TOKEN_FOREIGN`、`RECEIPT_MISSING`、`TOKEN_UNCONSUMED`）。四类根因：

1. **revision 类型错位**：任务包是 `revision: 1`（正整数）+ `designRevision: "c3-3-fourstep-1.0"`；
   两份收据写的是 `revision: "c3-3-fourstep-1.0"`（字符串），门禁要求正整数，直接拒。
   两份收据都**没有** `contractRevision` 字段，而任务包盖了 `contractRevision: "1.0.0"`，再记一次不一致。
   （注：receipt `notes` 里写「已在生成器中修正为整数并新增 designRevision 字段」——任务包确实修了，收据侧没跟上。）
2. **Token 窗口整体错位 +2**：SA-1 分配 `tok-031..tok-054`，收据消费 `tok-033..tok-056`；
   SA-2 分配 `tok-055..tok-066`，收据消费 `tok-057..tok-068`。**件号与颜色的序列本身完全相等**（`partColorSequenceIdentical: true`），
   所以这是「按位序重新编号」造成的 id 错位，而不是装配错误。
3. **越界 token**：`tok-067`、`tok-068` 在全局计划 66 个 token 中不存在，被判 `RECEIPT_TOKEN_NOT_ALLOCATED` + `RECEIPT_TOKEN_FOREIGN`。
4. **主任务无收据**：`c3-3-main` 完全没有 `receipt.json`，判 `RECEIPT_MISSING` + 其全部 30 个 token `TOKEN_UNCONSUMED`。

另外，收据内自带的 `totalAssemblyAudit` 是 `ok:false` 但只有 5 条 issue（全是「缺少执行收据」）——
说明它是**以空收据列表**调用的，恰好掩盖了上述 token/版本错误。字段如实写了 false，但作为交付证据具有误导性。

**判定**：FAIL（遗留缺陷）。按复核纪律**不修复**、不改阈值、不改判据。修复方向（供实现方参考，本复核不实施）：
收据 `revision` 用任务包的整数 `revision`、补 `contractRevision`，`consumedTokens` 用任务包**实际分配**的 tokenId，
补 `c3-3-main` 收据，然后用非空收据列表重算 `totalAssemblyAudit` 并把 `ok:true` 作为 C3-3 的退出条件。

---

## 三、测试计数

| 范围 | tests | pass | fail | skipped |
|---|---|---|---|---|
| `test/*.test.mjs`（全量，`--test-reporter=spec`） | 275 | **275** | 0 | 0 |
| `test/receipt-gating.test.mjs`（单文件） | 11 | 11 | 0 | 0 |
| 我的独立探针（自写断言，非 node:test） | 5 个探针 / 共 68 个受检对象 | 67 | 1（见第 9 项） | 0 |

## 四、失败与观察汇总

- **FAIL（1）**：WF-04 收据未通过真实收据门禁 —— 见 §2 第 9 项，79 errors / 7 codes。
- **观察（不扣分）**：
  1. WF-04 收据内 `totalAssemblyAudit` 以空收据列表计算，仅 5 条 issue，与真实重审结果差异极大，建议交付时注明计算输入。
  2. `repair_local` 的 full（含库存）哈希恢复率 8/13，低于 canonical 的 13/13；与 stored 标记逐条一致，是既定口径而非回归。
  3. 引擎允许整格沿凸点阵滑动后重新扣合（EN-05 正例侧 10 次），负例必须取半格错位——测试文件已注明，属正确行为。
  4. `split-manifest.json` 的 `generationCommand` 里 `--repo` 为空串（`--repo  --data ...`），不影响结果但不利于逐字节复现。

## 五、结论

C0 契约冻结、C1 数据工厂（轨迹 / 扰动 / 划分）、C3-4 引擎门禁、C3-6 60239 零错误**全部实测通过**，数字与声明一致，且关键项用独立复算而非采信报告。

**WF-04 四步流程**在「有 2 个真实子会话、conversationId 可追溯、装配 66 件 0/0、BOM 守恒」这些结构性事实上成立，
但**收据与任务包之间没有真实绑定**（revision 类型、token id 窗口错位、越界 token、主任务缺收据），
一经真实门禁重审即失败。这一项需要在 C3-3 关闭前修好，否则「收据可审计」的性质在这条链路上不成立。

本复核未修改任何被复核文件；新增文件全部位于 `docs/prd-v2/reviews/`。
