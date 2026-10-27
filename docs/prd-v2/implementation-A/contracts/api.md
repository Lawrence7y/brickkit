# C1 API：JS 模块与 CLI 双入口

契约版本：`contracts-1.0.0-draft`（见 `version.json`；B 复核前不冻结为 1.0.0）
实现版本：`assets-v1@1.0.0`、`assembly-v1@1.0.0`、`actions-v1@1.0.0`

本文件是 A 侧引擎的**真实行为说明**。所有列出的接口都有可运行实现与测试；标 `mock` 的地方明确标注。

---

## 0. 命令退出码约定（PRD §7.4）

| 码 | 含义 |
|---|---|
| 0 | 请求有效且 `passed === true` |
| 1 | 请求有效但 `passed === false`（结构错误、无解、校验失败等正常业务结果） |
| 2 | 输入/环境/执行错误（文件缺失、JSON 坏、模块缺失、未知子命令） |

**所有 JSON 输出同时带 `commandOk` 与 `passed`**：
- `commandOk: false` → 命令本身没跑通，`passed` 无意义
- `commandOk: true` + `passed: false` → 命令跑通了，但业务门禁没过（这是正常结果，不是故障）

---

## 1. JS 模块入口

### 1.1 资产层 `src/core/assets-v1/`

```js
import {
  buildIndex,          // (root, opts) → { index, definitions: Map, stats, buildWarnings }
  buildDefinition,     // (partId, coreDef, opts) → definition（单件，含 contentHash）
  deriveCapabilities,  // (coreDef, ctx) → { render, collide, assemble }
  applyOverrides,      // (definition, overrideList) → { definition, applied, rejected }
  connectorIdMap,      // (definition, coreDef) → { byId, idToLegacy, legacyToId, problems }
  expandConnectorGroups, // (definition) → 完整接口对象数组（运行时展开）
  connectorCountOf,    // (definition) → number
  readRawCatalog,      // (root) → { merged, colors, sourceHashes }
  readDatIndex,        // (root) → { partId: {file, sha256, bytes} }
  contentHashOf,       // (obj) → sha256（排除 recordedAt 等易变字段）
} from './src/core/assets-v1/index.js';

import {
  writeAssetStore,     // (root, outDir, {force}) → 落盘结果 + 体积统计
  readIndex,           // (assetsDir) → index.json
  loadDefinition,      // (assetsDir, partId, {overridesDir}) → definition（单件，缺失抛 code='missing-asset'）
  loadClosure,         // (assetsDir, partIds) → { definitions, bytes, missing }
  verifyStore,         // (assetsDir) → { ok, checked, problems }
} from './src/core/assets-v1/store.js';
```

**能力三分离**（ST-02）：`capabilities.render` / `.collide` / `.assemble` 各带独立 `state`，取值
`verified | measured | inferred | assumed | unsupported | unknown`。禁止用一个 `checked: true` 代表三者。

**稳定接口 ID**（ST-03）：`expandConnectorGroups()` 生成的 `id` 由 `类型 + 局部 LDU 位置` 决定，
形如 `stud-10000-24000-10000`（负数用 `n` 前缀：`stud-n10000-0-0`）。数组重排不改变任何 ID；
同零件同位置重复接口按 `(collection, index)` 排序后加 `-b/-c` 后缀。

**旧索引适配**：每个展开后的接口带 `legacyIndex: { collection: 'studs'|'receptors', index }`，
`connectorIdMap()` 校验该映射在当前 core 计算中仍然位置一致（超出 `connectorPositionTolLdu` 即报漂移）。

**磁盘格式**：`catalog/assets-v1/definitions/<partId>.json` 用紧凑分组存连接器：

```json
{ "connectorCount": 17,
  "connectorGroups": [
    { "t": "stud", "r": "male", "o": 0, "k": "top", "d": "+y", "mp": "stud-antistud-v1",
      "items": [[10,24,10,0,0], [10,24,30,0,1], "..."] } ] }
```

`items` 每项为 `[xLdu, yLdu, zLdu, collectionIndex, coreArrayIndex]`。这是把全库从 162 MB 降到
34 MB 的关键（21 万个连接器逐条展开的替代）；完整接口对象由 `expandConnectorGroups()` 在运行时生成。

### 1.1b 接口 ID 的权威键与别名（主会话裁决，已落地）

- **权威键**：A 的稳定语义 ID——由「连接类型 + 零件局部 LDU 语义位置（+ 面标记）」生成，
  形如 `stud-10000-24000-10000` / `bar-z-0-4000-11000`。与数组下标完全解耦，可独立复算。
- **别名**：`stud_top_N` / `stud_side_N`（顶/侧凸点必须分开，否则 `ctop#3` 与 `cside#3` 撞名）。
- **仅兼容输入**：裸 `stud_N` 只解释为顶凸点。
- **别名绑定资产修订**：解析别名必须携带 `assetLock` 的 revision；用过期 revision 应用覆盖会被拒绝
  （`override-rejected: baseRevision 不匹配`）。
- 验证脚本：`out/prd-v2/2026-10-26-a/A/contracts/verify-connector-id-authority.mjs`（8/8 通过）。

### 1.2 装配层 `src/core/assembly-v1/compile.js`

```js
import {
  checkContainment,      // (source) → { ok, problems }  组件归属树
  topoSortPlacements,    // (source, nodePaths) → { ok, problems, order, depth }  定位 DAG
  expandNodes,           // (source) → { ok, problems, nodes }  实例路径展开
  compileToLegacy,       // (source, cat) → { ok, snapshot, instanceMap, losses }
  validateAssembly,      // (source, cat, opts) → { ok, errors, warnings, notices, tests, stats }
} from './src/core/assembly-v1/compile.js';
```

**三种图严格分开**：归属树（`checkContainment`）、定位 DAG（`topoSortPlacements`）、物理连接图
（不存于源，由 core `partsConnected` 计算）。归属树不产生定位边，元数据分组不产生连接边。

**编译不复制几何**：所有位姿用 core 的 `snapPart` 求解；`compileToLegacy` 只做 ID 映射与拓扑排序。
`losses` 逐项声明 0.3 → 0.2 丢失的信息，不静默丢弃。

### 1.3 动作层 `src/core/actions-v1/`

```js
import { inspectFromModel, stateHashOf } from './src/core/actions-v1/state.js';
//   inspectFromModel(model, cat, { mainRootNodeId, inventory })
//     → { state: { nodes, connections, occupancy, inventory, reachability, steps }, stateHash, stats }

import { enumerateCandidates } from './src/core/actions-v1/candidates.js';
//   enumerateCandidates(state, request, cat, opts)
//     request: { childPartId, childModel?, parentNodeId?, parentConnectorIds?, dir?, maxResults? }
//     → { ok, items, count, enumerationComplete, truncated, noSolutionReason, capabilityGaps }

import { applyActions } from './src/core/actions-v1/apply.js';
//   applyActions(ctx, request, opts)
//     ctx: { model, cat, stateHash, state?, inventory, taskId, mainRootNodeId, enumerate }
//     request: action-request.schema.json 的 1.0.0 形态
//     → { commandOk, passed, apply: { committed, rolledBack, results, stateHashBefore/After } }

import {
  ORIENTATIONS, getOrientation, applyOrientation, composeOrientation,
  invertOrientation, mateOrientation, orientationIdOf, orientationFromAxes,
} from './src/core/actions-v1/pose.js';
```

**候选的硬保证**（EN-02）：`items[]` 里每个候选都（a）与父件真实扣合（`partsConnected`），
（b）与**全部**相关零件（含父件）无穿模。`collisionChecked.includesParent` 恒为 `true`。
性能基准里的朴素全量检查是 O(n²)，见 `out/prd-v2/<run>/A/perf/bench.json`。

**事务语义**（EN-03）：任一动作失败 → 整批回滚，`stateHash` 不变。`stateHash` 不匹配立即
`stale-state`，不尝试执行。同一 `actionId` 重复提交第二次为 `noop`（幂等）。

### 1.3b 标号层 `src/core/actions-v1/render-state.js`（MV-01）

| 导出 | 说明 |
|---|---|
| `renderState(request)` | 生成带标号的接口视图：相机契约、2D 像素、3D 世界坐标、朝向剔除、遮挡剔除、密度上限（≤32）、`stateHash` 绑定 |
| `makeCamera(q)` | 由 az/el/target/distance/视口 构造相机；与 `src/viewer/main.js` 逐项一致 |
| `projectPoint(cam, worldPoint)` | 世界点 → `{ visible, x, y, depth }`，像素原点左上 |
| `rayBoxHit(origin, dir, box)` | slab 法射线-AABB，返回近端距离 |
| `toConnectorMap(result)` | 转成 B 的 `connector-map.json` 字段（含 `'2d'` / `pixel` / `partInstanceId`） |
| `resolveTag(result, tag, expectedStateHash)` | 按标号反查接口；`stateHash` 不符返回 `null` |
| `aliasesOf(shortId)` | `{ bStyle, bare }`；侧凸点 `bare === null`（避免与顶凸点撞名） |
| `CAMERA_CONTRACT` | 相机语义自描述，写进每次输出 |

契约：`contracts/render-state.schema.json`；CLI：`renderstate`（见 §2）。

### 1.4 B 兼容层 `src/core/actions-v1/compat-b.js`

```js
import {
  toBConnectorId, fromBConnectorId,   // ctop#3 ↔ stud_top_3（保证互逆）
  candidateToB,                        // A 候选 → B 的 parentInstanceId 形态
  enumerateCandidatesForB,             // B 风格枚举
  bActionsToRequest,                   // B 推理动作 → A 的 action request
  stateToB,                            // A 状态 → B 的 free/occupied + connectors 形态
  applyActionsForB,                    // 端到端便捷入口
} from './src/core/actions-v1/compat-b.js';
```

**命名差异与取舍**：B 的 `REQ-B01` 用 `stud_0` 统称凸点，但顶凸点与侧凸点物理不同，共用一种拼写
会让 `stud_3` 无法确定映射到 `ctop#3` 还是 `cside#3`。因此契约规定：
- 输出统一用 `stud_top_N` / `stud_side_N`（互逆，已验证 10/10）
- 输入兼容裸 `stud_N`，按顶凸点解释

---

## 2. CLI 入口

```bash
# 资产
node cli/brickkit.mjs assets compile  [--out catalog/assets-v1] [--force]
node cli/brickkit.mjs assets inspect  <partId> [--dir catalog/assets-v1] [--expand]
node cli/brickkit.mjs assets preflight <bom.json> [--for render,collide,assemble]
node cli/brickkit.mjs assets verify   [--dir catalog/assets-v1]
node cli/brickkit.mjs assets index    [--dir catalog/assets-v1]

# 关系装配
node cli/brickkit.mjs assembly validate  <x.assembly.brick.json> [--strict-assembly] [--photos p.json]
node cli/brickkit.mjs assembly compile   <x.assembly.brick.json> [-o x.compiled.brick.json]
node cli/brickkit.mjs assembly inspect   <x.assembly.brick.json>
node cli/brickkit.mjs assembly recompute <model.brick.json> [-o out.json]

# 候选与动作
node cli/brickkit.mjs candidates <model.brick.json> --child <partId> [--parent <nodeId>] [--max 64] [--b-style]
node cli/brickkit.mjs actions apply <model.brick.json> --request <actions.json> [--inventory inv.json] [-o after.json]

# B 提供的模块（A 只做入口注册）
node cli/brickkit.mjs manual extract     <pdf> --bom <bom.json> -o <obs.json>
node cli/brickkit.mjs workflow acceptance <setId> [-o acceptance.json]
node cli/brickkit.mjs workflow plan      <obs.json> --bom <bom.json> [-o plan.json]
node cli/brickkit.mjs workflow audit     <plan.json> --receipts <dir>
```

`manual` / `workflow` 四个子命令把 B 的 `src/manual-v2/` 公开导出接到 root CLI；若 B 模块缺失或
导出改名，命令返回 `commandOk: false` + `owner: "B"`，**不降级为 mock**。

---

## 3. 错误协议

### 3.1 通用诊断形态

```json
{ "code": "stale-state", "severity": "error", "msg": "...", "nodes": ["p003"], "detail": {} }
```

`severity`: `error` | `warning` | `info` | `notice`。结构错误**不得**降级为 `notice`。

### 3.2 动作/候选/装配错误码表

| code | 出口 | 含义 |
|---|---|---|
| `stale-state` | apply | `stateHash` 不匹配，整批拒绝 |
| `empty-action` | apply | 动作列表为空；不构成该步完成 |
| `protocol-version` | apply | `protocolVersion` 不是 1.0.0 |
| `task-mismatch` | apply | 动作的 taskId 与上下文任务不符 |
| `repair-not-allowed` | apply | 未设 `repairMode` 却用 undo/detach/replace |
| `repair-unsupported` | apply | 修复动作本轮未实现（仅 undo） |
| `candidate-unknown` | apply | 候选在当前状态不存在（过期/被占用） |
| `candidate-hash-mismatch` | apply | 候选哈希与引擎重算结果不一致 |
| `inventory-unknown` / `inventory-consumed` / `inventory-mismatch` | apply | 库存 token 不存在 / 重复消费 / 型号不符 |
| `instance-id-dup` | apply | 实例 id 已存在 |
| `missing-action-ref` / `dependency-not-applied` | apply | dependsOn 指向不存在或未成功的动作 |
| `abstain-incomplete` | apply | abstain 缺 reason 或 needs |
| `fake-connection` | apply | 应用后与父件无真实物理连接 |
| `collision` | apply / candidates | 与其它零件穿模 |
| `missing-asset` | 多处 | 目录/资产库无此零件 |
| `unsupported-connector` | candidates | 连接类型无法归类 |
| `untrusted-collision` | candidates / compile | 碰撞盒生成失败，无法判定 |
| `unverified-interface` | compile | 参与定位的零件没有任何可归类连接器 |
| `unknown-connector` | apply / compile | 接口 ID 在当前零件上不存在 |
| `placement-cycle` | assembly | 定位依赖成环 |
| `double-placement` | assembly | 同一节点多条定位记录 |
| `missing-reference` | assembly | 父节点引用不存在 |
| `recursive-template` | assembly | 组件归属递归包含 |
| `unplaced-node` | assembly | 节点既非根也未被引用 |
| `inventory-double-consume` | assembly | 同一 token 被多个实例占用 |
| `schema-version` | assets / assembly | 主版本未知，拒绝执行 |
| `override-rejected` | assets | 覆盖被拒（baseRevision 或字段白名单） |
| `snap-cycle` | recompute | snap 定位依赖成环（JS Error.code） |
| `snap-missing-reference` | recompute | snap.on 指向不存在零件 |
| `mount-unsolvable` | recompute | 子组件无法按锚点扣上 |

### 3.3 能力缺口（不当作可用）

`capabilityGaps: [{ kind, partId?, detail, blocksTask }]`，`kind` 取值：
`missing-asset` | `unsupported-connector` | `untrusted-collision` | `unverified-interface` |
`unmeasured` | `out-of-scope`。

返回缺口意味着**该任务被阻塞**，不是"跳过后继续"。

### 3.4 无解原因（candidates）

`noSolutionReason`: `missing-asset` | `unsupported-connector` | `occupied` | `collision` |
`out-of-envelope` | `ambiguity` | `stale-state` | `inventory-exhausted` | `task-constraint` | `none`。

`enumerationComplete: false` 或 `truncated: true` 时**不得**声称"没有其它候选"。

---

## 4. 容差 profile

`catalog/assets-v1/profiles/default-2026-10-26.json`：

| 字段 | 值 | 说明 |
|---|---|---|
| `transformEpsLdu` | 1e-6 | 变换相等判据 |
| `connectorPositionTolLdu` | 0.05 | 接口位置漂移告警阈值 |
| `connectorAngleTolDeg` | 0.1 | 接口朝向容差 |
| `collisionEpsLdu` | 0.8 | 碰撞浮点边界（= 旧 0.04 格 / 0.10 片） |

**未冻结**：这些值尚未用完整的正/错配对夹具验证（见 §6 未完成项）。调用方不应依赖它们已被冻结。

---

## 5. 真实引擎 vs mock

| 接口 | 实现状态 | 证据 |
|---|---|---|
| `buildIndex` / `loadDefinition` / `writeAssetStore` / `verifyStore` | **真实引擎** | `test/assets-assembly.test.mjs` ST-01/03/04/05 |
| `deriveCapabilities` | **真实引擎** | ST-02 |
| `topoSortPlacements` / `expandNodes` / `checkContainment` | **真实引擎** | AS-04，8 个夹具 |
| `compileToLegacy` | **真实引擎**（几何委托 core） | AS-03/04，CP-01 |
| `inspectFromModel` | **真实引擎** | EN-01/EN-04 |
| `enumerateCandidates` | **真实引擎** | EN-02/EN-05，候选自证扣合 + 无穿模 |
| `applyActions` | **真实引擎** | EN-03，正例 + 8 类负例 + 幂等 |
| `manual` / `workflow` CLI | **真实入口**，实现属 B | 60239 实际产出 |
| `renderState`（带接口标号） | **已实现** | 透视模式与真实浏览器 60 点对账 < 0.001 px；正交模式未对账。输出几何+映射表，不画像素（画图归 B） |
| `validateAssembly` 的 `tests[]` 状态 | 部分 `unverified` | 逐项列出，不冒充 |

---

## 6. A 侧未完成接口（明确列出，不当作已通过）

| 项目 | 状态 | 缺口 |
|---|---|---|
| `renderState` 正交相机像素对账 | partial | 透视已对账；正交只有实现+结构测试，未与 viewer `ortho=1` 逐点比对 |
| 侧凸点多层 SNOT 与「渲染/导出」三者一致性 | partial | 0/1/2 三层链已实测并冻结；渲染侧与 MPD 导出侧未逐层对账 |
| 24 姿态的 SNOT side-face 锚点夹具 | partial | 现有夹具覆盖顶凸点与刚性翻立；侧凸点多层 SNOT 编码（0/1/2…）尚未用真实 4 件链验证 |
| 0.3 的 `attach_assembly` 动作 | partial | 候选生成已实现（`childModel`），事务执行路径只测了单件 |
| `detach` / `replace` 修复动作 | unsupported | 只有 `undo` 实现；其余返回 `repair-unsupported` |
| 装配 `constraints` 的执行 | partial | Schema 与校验已定义；`extra-mate` / `keep-out` 未参与求解 |
| 容差 profile 冻结 | unverified | 需完整正/错配对夹具 |
| 1000 件性能 | measured | validate P50 1.09 s（O(n²)），未见回归基线 |
