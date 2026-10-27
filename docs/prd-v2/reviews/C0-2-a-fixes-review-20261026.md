# C0-2 执行方 A 四项修复独立复核记录

日期：2026-10-26。复核对象：执行方 A 于 2026-10-26 23:31 落地的四项修复（A-INV-01 库存跨事务持久化、detach/replace 修复动作、正交投影像素对账、B 资产锁消费）。工作树状态：HEAD `47f02a5` + 未提交改动。

**本复核为同一模型的不同会话复核，不等同于跨 Harness 复核**（HANDOFF-C 规则 2）。本复核为只读复核：未修改任何业务源码；除本文与配套 evidence JSON 外，仅在 reviews 目录新增了一个投影脚本的改编副本（见第 3 节）。

## 结论（总表）

| # | 项目 | 复现方式 | 结果 |
|---|---|---|---|
| 1 | A-INV-01 库存跨事务持久化 | 复跑独立反例脚本 + 复跑 A 的 8 项守恒脚本 | **PASS** |
| 2 | detach / replace 修复动作 | 复跑 `verify-detach-replace.mjs`（14 项断言） | **PASS** |
| 3 | 正交投影像素对账 | 复跑改编副本脚本（60 探针 vs 真实浏览器 viewer） | **PASS** |
| 4 | B 资产锁消费 | 复跑 `verify-b-asset-lock-consumption.mjs` | **PASS** |
| — | 全量测试集 | `node --test --test-reporter=dot test/*.test.mjs` | **250/250 通过，退出 0** |

## 1. A-INV-01 库存跨事务持久化 — PASS

复跑命令（均为本人独立执行，非引用 A 的输出）：

```powershell
node docs/prd-v2/reviews/check-A-inventory-reuse-20261026.mjs
node out/prd-v2/2026-10-26-a/A/inventory/verify-cross-transaction-conservation.mjs
```

独立反例脚本本次输出与回执一致：

- `firstPassed: true`，模型 1 件 → 3 件；两个 token（`audit-member-1`/`audit-member-2`）持久写为 `consumed` 且记录 `consumedBy: "first-group"`；
- 第二次复用同一批 token 的装配被拒绝：`secondPassed: false`、`secondDiagnosticCodes: ["inventory-insufficient"]`、不回传第二组模型（`afterSecondParts: null`）；
- **`inventoryInvariantViolated: false`** —— 达标。

A 的守恒证据脚本 `verify-cross-transaction-conservation.mjs` 复跑结果 8/8 通过（INV-01 ~ INV-08 全 ok），与 `out/prd-v2/2026-10-26-a/A/inventory/verify-cross-transaction-conservation.json` 的原始声明逐项吻合：跨事务拒绝（INV-02）、补料后第二次合法装配仍通过（INV-04）、失败事务不污染库存（INV-05）、undo 放回 token（INV-06）、stateHash 覆盖库存消费状态（INV-07）、B 完整组件夹具 0 errors/0 warnings（INV-08）。声明与观察一致。

## 2. detach / replace 修复动作 — PASS

复跑命令：

```powershell
node out/prd-v2/2026-10-26-a/A/repair/verify-detach-replace.mjs
```

本次复跑 14/14 全部通过（PRE-01、DET-01~04、REP-01~08、X-01），与原始 `verify-detach-replace.json`（generatedAt 15:31:19.894Z，14/14）一致。逐类核对：

- **detach 精确移除**：DET-01 拆叶子件后 `remainingParts: 2`（3 件链只少被拆的那一件），库存按 `consumedBy` 释放 `cap-1` 且清掉 consumedBy，拆完 validate 0 errors；
- **detach 拒绝与回滚**：DET-02 拆支撑件被 `detach-orphans-parts` 拒绝（点名 cap 会悬空）、`rolledBack: true` 且不回传已推进模型；DET-03 未知目标拒绝；DET-04 未开 repairMode 被 `repair-not-allowed` 拒绝；
- **replace 守恒与位姿**：REP-01 换件成功时 `keptPose.at` 保持 `[0,3,0]` 不动、仍连 base、消费新 token `new-1` 并释放旧 token `old-1`（一进一出守恒）；
- **replace 拒绝族**：断连（REP-02）、碰撞（REP-03）、noop（REP-04）、目标件号库存全消费（REP-05）、缺件（REP-06）、未知实例（REP-07）、原悬空件（REP-08）全部按预期拒绝；失败操作不回传推进后的模型（DET-02 断言 `res._workingModel === undefined`）；
- **X-01**：接受/拒绝判定与 `core.partsConnected` / `partsCollide` 直接调用三例一致。

说明：该脚本复跑会在原位重新生成 `out/prd-v2/2026-10-26-a/A/repair/verify-detach-replace.json`（新 generatedAt），复核人已在复跑前完整读取并留存原 JSON 内容，本次生成与原声明一致。

## 3. 正交投影像素对账 — PASS

原脚本 `out/prd-v2/2026-10-26-a/A/render/verify-projection-ortho.mjs` 直接复跑会覆写 A 的原始证据，故按复核规则在 reviews 目录创建**改编副本**（仅改 ROOT 相对层数与输出路径，其余逐字相同），原始脚本与原始 JSON 未动：

```powershell
node docs/prd-v2/reviews/C0-2-verify-projection-ortho.mjs
```

本次输出（`docs/prd-v2/reviews/C0-2-projection-verify-ortho.json`）与原始 `projection-verify-ortho.json` 逐位一致：

- `maxDeltaPx: 0.0005`（容差 0.5 px），`meanDeltaPx: 0.0003`，60/60 探针全部落在 0.01 px 内；
- 相机参数取自真实 viewer 的 `cameraSnapshot()`：`OrthographicCamera`、`orthoHalfHeight: 6.613395069110807`（与原始证据完全相同），不复算取景、不自证；
- 最差五探针（p056/p057/p060/p020/p021）的坐标与误差值和原始证据逐一相同。

原回执所声称的「正交 0.0005 px 量级」成立；透视模式 ~0.0005 px 的声明本次未重跑（不属于本项范围）。

## 4. B 资产锁消费 — PASS

复跑命令：

```powershell
node out/prd-v2/2026-10-26-a/A/contracts/verify-b-asset-lock-consumption.mjs
```

该脚本经 `src/core/assets-v1/lock.js` 的 `checkAssetLock` / `buildAssetLock`（lock.js 实际导出名；即任务书所指的严格校验/构建入口）逐任务校验。本次复跑 `allPassed: true`：

| 任务 | required | lock | verified | lockHash | matchesARebuild |
|---|---|---|---|---|---|
| task-minifig | 4 | 4 | 4/4 | cc76307166b6d9b2 | true |
| task-cones | 2 | 2 | 2/2 | a85cd038910fb5e2 | true |
| task-front-bumper | 3 | 3 | 3/3 | 14b7dc367418e08b | true |
| task-wheels | 2 | 2 | 2/2 | 11d3e9a2705f0b31 | true |
| task-main-chassis | 38 | 38 | 38/38 | ba6216d2446b2f26 | true |

- 4/2/3/2/38 五份锁全部通过严格校验，`errorCodes` 均为空，lockHash 与原始证据逐一相同；
- 夹具自报来源指纹与当前 `catalog/assets-v1/index.json` 的 sha256 一致（`030ffb68…f517d0`），索引 4605 件、profileId `default-2026-10-26`；
- `buildAssetLock` 从同一索引重建的条目与 B 夹具逐字相同（matchesARebuild 全 true）；
- 负例仍成立：`partLocks` 字典旧写法被明确拒绝（`asset-lock-format` / `asset-lock-empty` / `asset-lock-incomplete`×4），无静默兼容。

夹具状态仍为 `review-proposal-not-integrated`（未集成），与回执口径一致。

## 5. 全量测试集 — PASS

```powershell
node --test --test-reporter=dot test/*.test.mjs
```

- dot 报告：250 个点、零失败标记、退出码 0；
- 另用 TAP 报告复核计数：`tests 250 / pass 250 / fail 0 / skipped 0`；
- 与基线声称 250/250 一致。

## 复核边界与说明

1. 本复核为**同一模型的不同会话复核，不等同于跨 Harness 复核**（HANDOFF-C 规则 2）。
2. 复跑 `verify-cross-transaction-conservation.mjs`、`verify-detach-replace.mjs`、`verify-b-asset-lock-consumption.mjs` 会在 out/ 原位重新生成对应 JSON（新 generatedAt，内容与原声明一致）；原始 generatedAt 分别为 15:31:20.522Z / 15:31:19.894Z / 15:31:21.089Z，复核人复跑前已留存原文。
3. 复核人未修改任何业务源码；新增文件仅限 `docs/prd-v2/reviews/` 下的本报告、evidence JSON、投影脚本改编副本及其独立输出 `C0-2-projection-verify-ortho.json`。
4. 未重跑透视模式投影对账与 R02 全量回放（不属本次四项范围）。

机器可读证据见 [C0-2-a-fixes-evidence-20261026.json](./C0-2-a-fixes-evidence-20261026.json)。
