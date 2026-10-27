# contracts-1.0：A/B 合并接口契约（冻结）

契约集：`contracts-1.0`（版本 1.0.0，见同目录 `version.json`；`frozen:true` 仅在 `validate-contracts-1.0.mjs` 全部通过后成立）。
合并来源：A 契约 `0.9.0-draft`（存储/引擎：part-asset、assembly、action-request、action-response、render-state、orientation-table）＋ B 契约（说明书/BrickVLM：manual-observation 1.0、task-package C2 1.0、dataset C3 1.0、inference-protocol、render-requirements）＋ 新增 asset-lock（buildAssetLock-v1，按 `src/core/assets-v1/lock.js` 真实实现推导）。
裁决依据：`docs/prd-v2/reviews/A-B-integration-review-2026-10-26.md` §6–§7、`docs/prd-v2/HANDOFF-C-single-agent.md` §3 C0-3/C0-4。

---

## 0. 版本映射表（冻结）

| 层 | 权威格式 | 版本 | Schema 文件 | 引擎目录 |
|---|---|---|---|---|
| 零件素材 | part-asset（definition / index） | 1.0.0 | `part-asset.schema.json` | `src/core/assets-v1/` |
| 资产锁 | buildAssetLock-v1 | 1.0（assetLockFormat） | `asset-lock.schema.json` | `src/core/assets-v1/lock.js` |
| 装配源 | brickbuild-assembly 0.3 | 0.3.0 | `assembly.schema.json` | `src/core/assembly-v1/` |
| 动作请求/响应 | actionProtocol | 1.0.0 | `action-request.schema.json` / `action-response.schema.json` | `src/core/actions-v1/` |
| 接口标号视图 | renderState | 1.0.0（cameraContract 1.0.0） | `render-state.schema.json` | `src/core/actions-v1/render-state.js` |
| 说明书观察 | manual-observation | 1.0（datasetSchemaVersion 同源） | `manual-observation.schema.json` | `src/manual-v2/extractor.js` |
| 子任务包 | TaskPackageC2 | 1.0 | `task-package.schema.json` | `src/manual-v2/workflow.js` |
| 训练/评测样本 | BrickVLMDatasetSampleC3 | 1.0（datasetSchemaVersion） | `dataset.schema.json` | `src/brickvlm/`（B 实现） |
| 任务收据绑定 | createBoundTaskReceipt-v1 | 1.0（receiptBinding） | 收据形态见 §6（workflow 内聚，无独立 schema） | `src/manual-v2/workflow.js` |

固定换算关系：**dataset 1.0 ↔ actionProtocol 1.0.0 ↔ 引擎 v1 目录（assets-v1 / assembly-v1 / actions-v1）**。24 正交姿态表沿用 A 的 `implementation-A/contracts/orientation-table.json`（orientationId 0–23，含行列式 +1 校验）。历史兼容：brickbuild 0.2 模型与 legacy plan 0.1 走 A 的 compile 适配层（`compileToLegacy` / losses 逐项声明），不进入本冻结集。

## 1. 命令退出码与 commandOk/passed 分离

沿用 A：`0` = 有效且 `passed===true`；`1` = 有效但 `passed===false`（正常业务失败）；`2` = 输入/环境错误。所有 JSON 输出同时带 `commandOk` 与 `passed`；未测项进 `notMeasured`，不得把未知记成通过。

## 2. 连接器身份规则（权威裁决）

1. **权威键 = 稳定语义接口 ID**：由「连接类型 + 零件局部 LDU 语义位置（+ 面标记）」生成，形如 `stud-10000-24000-10000` / `bar-z-0-4000-11000`，与数组下标完全解耦、可独立复算；同位置重复接口按 `(collection, index)` 排序加 `-b/-c` 后缀。renderState 标号输出的短形态为 `ctop#N` / `cside#N` / `cantistud#N`。
2. **别名**：`stud_top_N`（顶凸点）/ `stud_side_N`（侧凸点）。**侧接口禁止裸 `stud_N`**——裸 `stud_N` 只是输入兼容拼写，仅解释为顶凸点；用 `stud_3` 表达侧凸点会与 `ctop#3`/`cside#3` 撞名，属于契约违规。
3. **别名按资产 revision 解析**：别名→语义 ID 的换算必须携带该样本/任务 `assetLock` 锁定的零件 `revision`；用过期 revision 应用覆盖将被拒绝（`override-rejected`）。dataset C3 v1.0 允许历史候选拼写（`stud_N`/`stud_top_N`/`stud_side_N`/`antistud_N`，见 15 条真实课程样本），新生成数据 SHOULD 直接写语义 ID 或带 revision 的别名。
4. **跨执行器输出形态**：A `renderState().labels[]` 的 `connectorId` 是权威键，`aliases.bStyle`/`aliases.bare` 是兼容别名（侧凸点 `bare === null`）；B 的 `connector-map.json` 中 `connectorId`（B 风格别名）必须与 `stableConnectorId` 成对出现，消费侧以 `stableConnectorId` 判等。换算由 `src/core/actions-v1/compat-b.js` 的 `toBConnectorId`/`fromBConnectorId` 承担（互逆已验证）。

## 3. renderState 相机契约（MV-01）

1. **显式取景**：`camera.target` / `distance` / `viewport` / `projection` 必须显式给定，不接受隐式取景。UI 自动取景时，应把实际 `cameraSnapshot`（即 renderState 输出的 `camera` 对象）序列化后传入接口，用户无需手填坐标。
2. **stateHash ≠ 视图**：`stateHash` 只标识模型状态。图像与标签共同保存相机和模型状态；缓存键与标号引用必须**同时**包含 `stateHash` 与相机快照，不得把「同一模型」误当「同一视图」。`stateHash` 不符直接拒绝（`stale-state`），标号不得跨状态复用。
3. 几何口径：`dir = [sin(az)·cos(el), sin(el), cos(az)·cos(el)]`（由 target 指向相机，az=0 相机在 +Z 正前方）；世界坐标 `[x格, y片×0.4, z格]`；像素原点 top-left；透视 fovYDeg=30（正交模式 `orthoHalfHeight` 取自 viewer `cameraSnapshot()`，不复算取景）。透视/正交均已与真实浏览器 60 点对账（最大误差 0.0005 px，见 A `projection-verify*.json`）。
4. 标号上限 32（`maxLabels`），超限截断且 `enumerationComplete:false`，不得声称穷尽；每个剔除原因必须计入 `skipped`。
5. 通道分离红线（B render-requirements）：带标号图严禁进入 `diff.js` 评分；评分只用无标号纯净图。

## 4. 资产锁（buildAssetLock-v1，冻结格式）

1. 锁**必须**由 `buildAssetLock(index, requiredPartIds, profileId)` 生成（`src/core/assets-v1/lock.js`），格式为 `{ profileId, indexVersion, parts:[{partId, revision, contentHash}] }`（按 partId 排序去重）。**严禁手写或手算哈希**；`contentHash`/`revision` 一律取自资产索引条目。
2. 生成后由 `checkAssetLock(source, {index, requiredPartIds})` 严格校验，全部拒绝码为 **error**，不降级 warning：`asset-lock-missing` / `asset-lock-format` / `asset-lock-empty` / `asset-lock-closure-empty` / `asset-lock-part-no-id` / `asset-lock-part-dup` / `asset-lock-incomplete` / `asset-lock-revision-missing` / `asset-lock-revision-mismatch` / `asset-lock-hash-missing` / `asset-lock-hash-invalid` / `asset-lock-hash-mismatch` / `asset-lock-unknown-part` / `asset-lock-profile-missing` / `asset-lock-profile-mismatch` / `asset-lock-index-unavailable`（另有 notice：`asset-lock-closure`、`asset-lock-unused`；warning：`asset-lock-unverified` 仅当索引不可核验时出现）。`lockHash` 由 `checkAssetLock` 按规范化条目重算，不属于交换格式。
3. `parts:"closure"` 是引擎内部便捷写法，由引擎按用件闭包展开；跨执行器交付的锁必须是显式数组。
4. **破坏性变更（相对 B 示例）**：`partLocks` 字典写法（`implementation-B/contracts/examples/sample-task-package.json` 形态）自 contracts-1.0 起**不再合法**（A 真实消费已拒绝）；`catalogVersion` 字段由 `indexVersion` 取代。B v4 五任务真实锁（4/2/3/2/38 件，`A-to-B-asset-lock-fixture-20261026.json`）已符合本格式并通过 `checkAssetLock`。

## 5. 动作协议（actionProtocol 1.0.0）

请求/响应结构见两份 schema；要点沿用 A：

- 模型只选离散候选（`candidateId` + `candidateHash` 防过期），严禁手填世界坐标；`stateHash` 不匹配 → `stale-state` 整批拒绝（inference-protocol §2 原文并入本条）。
- 事务语义：任一动作失败整批回滚，`stateHash` 不变；同一 `actionId` 重复提交为 `noop`。`attach_assembly` 动作必须携带与枚举时逐字一致的 `childModel`（候选哈希把它绑进候选）。
- 修复动作 `undo`/`detach`/`replace` 需 `repairMode:true`，否则 `repair-not-allowed`；三者均已实现并有独立复核（`out/prd-v2/2026-10-26-a/A/repair/verify-detach-replace.json` 14/14；C0-2 复核通过），取代 A 草案 api.md 中「仅 undo 实现」的旧状态。`replace` 同姿态换不上时不得自行挪位姿，正确路径是 detach + attach 重解候选。
- 库存守恒：成功事务把 token 持久置 `consumed`（A-INV-01 已关闭），调用方必须同时接管 `_workingModel` 与 `_inventory`。
- 错误码表、能力缺口（`capabilityGaps`）、无解原因（`noSolutionReason`）沿用 A 契约 api.md §3.2–3.4，未改动。
- 预算：单步默认 ≤3 次候选执行，局部修复默认 ≤2 轮（inference-protocol §3；超限标 `needs-repair` 并计入 ML-08 介入统计）。

## 6. 收据绑定规则（createBoundTaskReceipt-v1，C0-4）

主从搭建（WF-04）的任务收据**必须**经 `createBoundTaskReceipt(taskPackage, options)`（`src/manual-v2/workflow.js`）构造，字段与任务包真实绑定，禁止手拼：

| 收据字段 | 绑定来源 |
|---|---|
| `taskId` / `revision` | 任务包本体 |
| `contractRevision` / `engineRevision` | 任务包盖章（计划生成时写入） |
| `stateHash` | `stateHashOf(state)`（actions-v1 稳定序列化）真实复算，可逐字节审计 |
| `state` | 收据声称的最终状态证据（内联 state.inventory 必须与 `consumedTokens` 一致） |
| `declaredPartCount` | 必须等于任务包实际分配 token 数 |
| `consumedTokens[]` | 逐颗来自任务包分配（件号/颜色逐一对账，禁止未分配/跨计划/重复消费） |
| `artifacts[].sha256` | 声明产物必须为合法 sha256 且与磁盘实算一致 |
| `sessionEvidence` / `signedBy` | 真实子会话证据（WF-04 要求记录 conversationId；单字符占位不算） |

`auditTotalAssembly` 门禁拒绝码（error，除非注明 warning）：`RECEIPT_MISSING`、`RECEIPT_UNKNOWN_TASK`、`RECEIPT_STATUS_NOT_COMPLETED`、`RECEIPT_REVISION_MISMATCH`、`RECEIPT_STATEHASH_MALFORMED`、`RECEIPT_STATEHASH_UNBOUND`（无 state/stateFile 证据，无法复算绑定）、`RECEIPT_STATEHASH_MISMATCH`、`RECEIPT_STATE_TOKEN_MISMATCH`、`RECEIPT_EVIDENCE_MISSING`、`RECEIPT_PART_COUNT_MISMATCH`、`RECEIPT_ARTIFACT_HASH_MALFORMED`、`RECEIPT_ARTIFACT_HASH_MISMATCH`、`RECEIPT_TOKEN_NOT_ALLOCATED`、`RECEIPT_TOKEN_FOREIGN`、`RECEIPT_TOKEN_PART_MISMATCH`、`RECEIPT_TOKEN_COLOR_MISMATCH`、`RECEIPT_TOKEN_DUPLICATE`；warning：`RECEIPT_ARTIFACT_MISSING`。计划级另有 `PLAN_BOM_TOTAL_MISMATCH`、`PACKAGE_INVENTORY_MISSING`、`PACKAGE_COUNT_MISMATCH`。v4 复核两条反例（假 revision/stateHash 绑定、声明 999 件实配 91 件）必须被拒。

## 7. SNOT 层级规则（硬约束）

直接扣在侧凸点砖（`4733`/`11211`/`87087` 等）外壁上的**第一层侧装件 `snot: 0`**；叠在第一层侧装板凸点上的**第二层 `snot: 1`**；每向外叠 1 片 `snot` 加 1（`snot` 编码沿 `assembly.derived.worldPoses[].snot`、候选与 `apply.results[].applied.snot` 传递）。严禁全部清零或把朝上圆柱/斜砖直接插进朝前竖板表面——方向转换必须经 SNOT 侧凸点砖、倒顺支架或外挑水平托板（AGENTS.md 三大红线；0/1/2 三层链已实测冻结，渲染侧与 MPD 导出侧逐层对账仍为 partial，见 §9）。

## 8. 数据与验收边界（并入的 B 规格）

- 候选匿名化：公开数据不得含 `cand_target`/`isTarget`；等价判定不得用编号取巧，不同件号/缺成员组件不得判等价（R-02 门禁沿用）。
- 60239 只做开发样例，不进泛化留出；留出集在选模型前冻结。
- smoke/mock/强模型介入结果与真实引擎结果必须分开标注（`actionSource.kind`、`mock` 字段），不得冒充小模型效果。

## 9. 明确未完成项（冻结≠全部 verified）

| 项目 | 状态 |
|---|---|
| renderState 正交相机像素对账 | partial（C0-2 已复验正交投影：`reviews/C0-2-projection-verify-ortho.json`） |
| SNOT 渲染侧 / MPD 导出侧逐层一致性 | partial |
| 装配 `constraints`（extra-mate/keep-out）参与求解 | partial |
| 容差 profile 冻结（`default-2026-10-26`） | unverified |
| 1000 件性能 O(n²)→优化 | measured（CP-02 未做） |
| BrickVLM 训练/留出验收（ML-*） | 未完成（HANDOFF-C §1），不在本契约范围 |

## 10. 变更策略

本契约集已冻结：任何破坏性变更必须提升主版本（contracts-2.0）并附迁移说明与重跑范围（PRD §13.3）；新增可选字段按次版本递增。哈希记录在 `version.json`（`engineRevision` + `contractFiles`），由 `validate-contracts-1.0.mjs` 复算校验。
