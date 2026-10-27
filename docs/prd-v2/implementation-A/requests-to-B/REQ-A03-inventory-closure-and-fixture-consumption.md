# REQ-A03：A-INV-01 已关闭，三份夹具已由 A 实际消费

日期：2026-10-26（第三轮）
对应：`docs/prd-v2/reviews/A-B-integration-review-2026-10-26.md`
性质：A 侧修复与消费回执。**不是**对 B 的 R-02 复核结论，也不代表契约已冻结。

---

## 1. 结论一句话

A-INV-01（跨事务库存重复消费）已修复并附**变异测试**证明断言有效；
B 的一任务锁、renderState 夹具、完整组件夹具三份都已由 A 的实现实际跑通并逐项比对。

| 项 | 状态 |
|---|---|
| A-INV-01 跨事务库存 | **closed**（含变异测试） |
| 五任务 assetLock | **A 侧消费通过**（5/5，与重建逐字一致） |
| renderState 夹具 | **A 侧消费通过**（8/8 标签像素差 0） |
| 完整组件夹具 | **A 侧消费通过**（3 件目标，0/0） |
| 契约冻结 | **仍未冻结**（需双方共同签署） |
| 60239 | **仍 failed**（候选 5 errors / 原始 9 errors，不降级） |
| 性能 | **仍 partial**（基线已冻结，未优化） |

---

## 2. A-INV-01：根因与修复

### 2.1 根因

`apply.js` 用两层判据去重库存，但只有一层是持久的：

```js
// 修复前
const consumedNow = new Set();          // 只在本次调用内存活
...
if (token) consumedNow.add(token);      // 记在批次内
...
prevState.inventory = inventory.map((i) => ({
  ...i, state: i.state === 'consumed' ? 'consumed' : (i.state || 'available'),
}));                                    // ← 来源对象从没被写成 consumed，这行等于空操作
```

于是下一事务清空 `consumedNow` 后，重新拿到同一批 token 依然是 `available`。
反例因此表现为 **1 → 3 → 5 件且 0 errors / 0 warnings**：结构校验看不见库存账。

### 2.2 修复

| 改动 | 作用 |
|---|---|
| 新增 `consumeToken()` | 成功时写 `inv.state='consumed'` + `consumedBy=<实例 id>`，同时维护批次内 Set |
| 新增 `releaseTokens()` | `undo` 撤销时把 token 放回 `available`，撤销不再永久烧掉库存 |
| `rehash()` 改为 `inventory.map((i) => ({...i}))` | 库存状态以记录本体为权威，不再把 consumed 降级 |
| 单件路径新增守卫 | 该件号在库存里有记录但全部已消费 → `inventory-insufficient`（修复前是静默继续装） |
| `undo` 移除整组成员 | 原先只删锚点，`attach_assembly` 的 `<nodeId>/<member>` 成员会残留 |

### 2.3 证据

| 证据 | 内容 |
|---|---|
| `out/.../A/inventory/verify-cross-transaction-conservation.json` | 8/8 断言：持久 consumed / 跨事务拒绝 / 单件同路径 / 有新库存可继续 / 失败不动库存 / undo 释放 / stateHash 含库存 / B 夹具 0/0 |
| `out/.../A/inventory/mutation-prove-assertion-bites.json` | 变异测试：还原旧行为后**精确复现** `afterFirstParts:3 → finalParts:5`、`reusedSameTokens:[m1,m2]`、零诊断 |
| `test/assets-assembly.test.mjs` | 44 → 47 项，新增跨事务守恒 / 有库存可继续 / undo 释放三条 |

变异测试是本轮最重要的一项：它证明新断言**不是空断言**。做法是把 `apply.js` 复制成同目录临时变异体，
注入三处旧行为，跑同一组断言——变异体必须失败到「1→3→5」，实测确实如此；临时文件在 `finally` 里删除，
仓库实现未被修改。

### 2.4 给调用方的约定（这条会写进 `interface.md`）

```js
const r = applyActions(ctx, request);
if (r.passed) {
  model     = r._workingModel;   // 必须一起接管
  inventory = r._inventory;      // token 已持久标 consumed
}
```

**只取 `_workingModel` 而沿用旧 inventory，等于把消费事实丢掉。** 引擎侧现在能拒绝，
但调用方不该靠引擎兜底。

---

## 3. 三份夹具的消费结果

### 3.1 五任务资产锁

`checkAssetLock` 逐任务校验 + 与 `buildAssetLock(index, requiredPartIds)` 重建逐字比对：

| taskId | 用件数 | 校验 | 与重建一致 |
|---|---|---|---|
| task-minifig | 4 | `verified 4/4` | 是 |
| task-cones | 2 | `verified 2/2` | 是 |
| task-front-bumper | 3 | `verified 3/3` | 是 |
| task-wheels | 2 | `verified 2/2` | 是 |
| task-main-chassis | 38 | `verified 38/38` | 是 |

反向负例：`partLocks` 字典旧写法被拒（`asset-lock-format` + `asset-lock-empty` + 4×`asset-lock-incomplete`）。
证据：`out/.../A/contracts/verify-b-asset-lock-consumption.json`。

> B 在复核里说「格式/revision/profile/哈希口径不兼容」，这在本轮已不成立：
> 五任务锁全部通过，且与 A 自己的生成器输出逐字相同。

### 3.2 renderState 夹具

用夹具的源模型（sha256 与夹具自报一致）+ 夹具的相机请求重跑 A 的实现：

| 检查 | 结果 |
|---|---|
| 标签数 | B 8 / A 8 |
| 逐标签像素差 | **全部 0 px**（`matched` / `nodeIdSame` / `connectorIdSame` 全 true）|
| `stateHash` | 一致 |
| A 侧多余标签 | 无 |
| `toConnectorMap` | 输出 B 侧字段名（`2d` / `partInstanceId` / `connectorId` / `stableConnectorId`），hash 一致 |
| `resolveTag` | 能反查；传错误 stateHash 时**返回 null**（不跨状态复用标号）|

证据：`out/.../A/contracts/verify-b-fixtures-consumption.json`。

### 3.3 完整组件夹具

`enumerateCandidates({childModel})` 得到 64 个候选 → `applyActions(attach_assembly)`：

- 装成 3 件，形状 `3023/0 + 3001/15 + 2412b/4`，与目标匹配
- `validate` 0 errors / 0 warnings
- 返回库存两条都是 `consumed`，`consumedBy='mounted-bumper'`

这就是 A-INV-01 修复后的行为；同一夹具在修复前会允许第二次装配。

### 3.4 一个必须说清楚的限定

三份夹具自身标注 `review-*-not-integrated`。所以上表证明的是**A 侧能正确消费这些夹具**，
不等于 B 已把这些路径接进生产流程，也不等于契约已冻结。契约冻结需要双方对同一份契约哈希签名。

---

## 4. 请 B 做与不要做的事

请做：

1. 用 A 的 `buildAssetLock(index, requiredPartIds)` 产出生产锁，不要手算或沿用原始目录对象哈希。
2. 把 R-02 的候选执行改为完整组件路径（`childModel + attach_assembly`）；等价判定比全部零件/颜色/位姿/连接，
   不要只比锚点 AABB。
3. 消费 `toConnectorMap` 时把 `stateHash` 与**相机参数**一起存进缓存键——`stateHash` 只代表模型状态，
   同一模型不同取景不是同一视图。
4. 契约冻结前，双方对 `contracts/version.json` 的 revision 与 `render-state.schema.json` 的哈希达成一致。

请不要做：

- 不要为通过验收而放宽碰撞容差、用配件豁免、或把 60239 按分组合并降级——60239 继续记 `failed`。
- 不要在没有新库存的情况下用返回的 `_inventory` 重复装配后声称通过；引擎现在会拒绝。
- 不要修改 A 的所有权文件（`src/core/assets-v1/`、`src/core/assembly-v1/`、`src/core/actions-v1/`、`cli/`）。

---

## 5. A 侧剩余未完成（不因本轮而改变）

| 项 | 状态 |
|---|---|
| `detach` / `replace` | 未实现 |
| `constraints.extra-mate` / `keep-out` 求解 | 未参与 |
| `renderState` 正交模式像素对账 | 未做 |
| 刚性子组件内部的 SNOT 链 | 未单独验证 |
| 性能 O(n²) | 未优化（基线已冻结） |
| 契约冻结 | 未冻结 |
| 60239 | failed |
| ML-01～08 | 训练里程碑未完成（A 不代签） |
