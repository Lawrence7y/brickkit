# BrickKit PRD v2 执行对象 A 完成报告

- 执行者：Task A（ZCode / DeepSeek v4.1Flash）
- 日期：2026-10-26（第四轮：正交像素对账 + detach/replace；一至三轮内容作为历史 revision 保留）
- 基线 HEAD：`47f02a57886aacbe809732f1f9abbde51c09eb19` + 未提交/未跟踪工作树（未重置）
- 证据根目录：`out/prd-v2/2026-10-26-a/A/`、`docs/prd-v2/implementation-A/`
- 契约版本：`contracts-1.0.0-draft` revision 4（**未冻结**：B 已消费 A 的三份夹具，契约哈希待双方共同签署）

**TL;DR（第四轮）**：补齐 A 侧在契约冻结前最后两个自有缺口。
**正交 `renderState` 已像素级对账**：60/60 点、最大误差 0.0005 px，与透视模式同一量级——关键是半高直接取自 viewer 的
`cameraSnapshot().orthoHalfHeight`，不自己复算取景，否则比对就变成自证。
**`detach` / `replace` 修复动作已实现**：拆件会拒绝「拆完让别人悬空」，换件坚持同姿态且必须仍与邻居真实扣合；
4 条守卫各有一条变异测试证明它们是唯一拦截者。全量 **250/250**。

**第三轮（历史 revision）TL;DR**：B 提出的阻断项 **A-INV-01 已关闭**（跨事务库存守恒），
并由 B 独立复验签收；同时实际消费了 B 的三份夹具（五任务资产锁 4/2/3/2/38、renderState 8/8 像素差 0、完整组件 3 件匹配）。

**第二轮（历史 revision）TL;DR**：补齐 `renderState`（与真实浏览器逐点对齐 60/60 点误差 < 0.001 px）、
`assetLock` 收紧为「空串/缺件/不符一律拒绝」、`attach_assembly` 事务路径打通；
发现并修复 5 个真实引擎缺陷（候选坐标双重平移、混合单位旋转、`snot` 与 `at` 重复计偏移、事务假回滚、轮件整件豁免）。

**必须纠正首轮的两处结论（仍然有效）**：
1. **60239 不是「剩 2 个错误」，实际是 5 个**（3 处真实穿模 + 63 件悬空）。其中 2 处穿模原本被轮件豁免隐藏，收紧后如实暴露。
   **本轮补正计量口径**：5 个指 A 的推进候选 `60239-advanced.brick.json`；`examples/60239.brick.json` 原始示例当前是 **9 errors / 17 warnings**（6 处 overlap + 2 条 mount-disconnected + 1 条 63 件 floating）。两者都仍是 failed。
2. **mecha 99 件不是「计划未落地」，而是从未存在且当前工具链产不出来**：git 历史最高 83 件；产生 99 件的那条路径今天跑出 29 个 validate 错误。

B 的权重真实、族/模型 ID 三集合互斥（「无泄漏」仅此标识层面，图像级/语义级未测），R5 指标未达标而其里程碑写成 "Verified & Completed"。

---

## 0. 本轮（第四轮）改动清单（按责任域）

第四轮做两件事：**正交 `renderState` 像素对账**（MV-01 唯一的硬缺口）与 **`detach`/`replace` 修复动作**（生产流程实调用会撞到 `repair-unsupported`）。
A-INV-01 已由 B 独立复验关闭，本轮未再改动该路径。

| 文件 | 改动 | 为什么 |
|---|---|---|
| `src/viewer/main.js` | `cameraSnapshot()` 增补 `orthoHalfHeight` / `orthoHalfWidth` | 正交相机没有 `fov`。若不暴露真实半高，离线侧只能复算 viewer 的取景公式（8 角投影 + 纵横比对齐 + 1.08 边距），那样的对账等于自证 |
| `src/core/actions-v1/apply.js` | 新增 `applyDetach()` / `applyReplace()` / `connectionsAmong()` / `releaseTokensByNode()` | `detach`/`replace` 原先返回 `repair-unsupported`，是修复闭环的硬缺口 |
| `test/assets-assembly.test.mjs` | 47 → 49 项 | detach 正例 + 悬空拒绝 + 目标不存在；replace 正例 + 断连/碰撞/noop/无库存/缺件/无邻居 |
| `out/.../A/render/verify-projection-ortho.mjs` | **新增** | 正交投影逐点对账 |
| `out/.../A/repair/verify-detach-replace.mjs` | **新增** 14 项断言 | 每个拒绝码的触发条件 |
| `out/.../A/repair/mutation-prove-repair-guards.mjs` | **新增** 变异测试 | 证明 4 条守卫都是唯一拦截者，且正例不被误伤 |

第三轮（A-INV-01）改动仍见下节，保留不删。

### 0.1 第三轮（历史 revision）：关闭 A-INV-01

第三轮只做一件事：关闭 B 联合复核提出的阻断项 **A-INV-01（跨事务库存重复消费）**，并消费 B 的三份夹具。

| 文件 | 改动 | 为什么 |
|---|---|---|
| `src/core/actions-v1/apply.js` | 新增 `consumeToken()` / `releaseTokens()`；`rehash()` 库存以记录本体为准；单件路径同件号库存全耗尽改为 `inventory-insufficient`；`undo` 同时释放 token 并移除整组成员 | A-INV-01 根因：`consumedNow` 只是批次内 Set，成功提交从不写回 `inv.state='consumed'`，下一事务重新拿到同一批 token 还能再装一遍（1→3→5 件零错误） |
| `test/assets-assembly.test.mjs` | 44 → 47 项 | 新增跨事务守恒（组件/单件各一条拒绝）、「有新库存可继续」对照、undo 释放 token |
| `out/.../A/inventory/verify-cross-transaction-conservation.mjs` | **新增** 8 项断言 | 把守恒事实落成可复跑证据 |
| `out/.../A/inventory/mutation-prove-assertion-bites.mjs` | **新增** 变异测试 | 证明新断言不是空断言：还原旧行为后必须复现 1→3→5 |
| `out/.../A/contracts/verify-b-asset-lock-consumption.mjs` | **新增** | 消费 B 五任务资产锁（4/2/3/2/38 件），逐条比对 A 的重建结果 |
| `out/.../A/contracts/verify-b-fixtures-consumption.mjs` | **新增** | 消费 B 的 renderState 与完整组件夹具 |

第二轮（历史 revision）改动：

| 文件 | 改动 | 为什么 |
|---|---|---|
| `src/core/actions-v1/render-state.js` | **新增**（MV-01） | `renderState` 缺失是 A 侧最大空白；B 的 `stud-overlay-v2.js` 无法对接 |
| `src/core/assets-v1/lock.js` | **新增**（ST-01） | assetLock 校验原先缺失；`assetLock.parts` 无哈希也当通过 |
| `src/core/actions-v1/candidates.js` | 修单位/坐标系；`snot` 分两层编码 | 候选位姿在父件平移后全错；`at` 与 `snot` 重复计偏移 |
| `src/core/actions-v1/apply.js` | `attach_assembly` 原子提交；回滚改真回滚 | 子组件挂装恒 `candidate-unknown`；回滚原地改写调用方 state |
| `src/core/actions-v1/state.js` | 连接器对改为**全部**匹配 | 2×4 叠 2×4 有 8 对，原实现只记 1 对 → 7 个接口错标空闲 |
| `src/core/assembly-v1/compile.js` | assetLock 严格校验 + SNOT 链实测 | ST-01 从「有 lockHash」改为「逐条哈希相符」；AS-06 从「未测」改为实测 |
| `src/core/core.js` | 轮件碰撞从「整件豁免」改为「按连接判定」 | 豁免掩盖了 60239 两处真实穿模 |
| `cli/brickkit.mjs` | 新增 `renderstate` 子命令；修 `flag()` 重复读取 | `--max` 被读两次导致 `slice(0,NaN)` 静默返回空标号 |
| `test/render-state.test.mjs` | **新增** 15 项 | MV-01 正负例 |

测试总数演进：**250/250**（第四轮）← 248（B 侧新增测试）← 244（第三轮）← 222（第二轮）← 191（首轮）。各轮数字都保留，不互相覆盖。

---

## 1. 复用了什么、改了什么，为什么

### 1.1 复用（没有重写）

| 复用对象 | 做法 | 为什么 |
|---|---|---|
| `core.js` 的 `partConnectors` / `partsConnected` / `snapPart` / `partBoxes` / `partsCollide` | 全部新模块**调用**它们，不复制几何算法 | 避免"资产定义"和"引擎扣合"两套真值漂移 |
| `core.js` 的 `validate` | `validateAssembly` 编译后直接调它做几何校验 | 同一套判定标准，0.3 只加图结构检查 |
| `catalog/parts.json` + `catalog/parts-ldraw.json` | 作为 Part Asset 的**原始来源层**，不改写 | 保留原始来源与覆盖分离（PRD §5.5） |
| `builder.js` 的 `createBuilder` | 完全不动，0.3 编译产物仍是 0.2 模型 | 保持现有调用方可用 |
| `src/viewer/` / `src/ldraw/` / booklet / MPD | 一行未改，只做回归 | 兼容优先 |

### 1.2 改动（逐项理由）

| 文件 | 改动 | 为什么必须改 |
|---|---|---|
| `src/core/core.js` `findMounts` | 父件参与碰撞（原先整件豁免），加 `collisionChecked` | 反例 3：40/40 候选穿父砖。PRD §7.3 明确要求"包括父件" |
| `src/core/core.js` `recompute` | 加 snap 环/缺引用检测 + 原子提交（副本求解后一次写回） | 反例 2：环静默保留旧坐标。PRD §6.4 要求"全部成功后原子提交" |
| `src/core/core.js` `validate` 子组件段 | 组内真实连通性检查，不伪造支撑边 | 反例 1：伪组让 63 件悬空通过 strictAssembly |
| `src/core/core.js` `validate` 3D 盒段 | 不再跳过"至少一方带多盒"的组合 | **本轮新发现的漏洞**：整格检查跳过带 `boxes` 件、3D 检查跳过整数格件，两者叠加导致漏检。实证：4740 与 3001 完全重叠时 `ok: true` |
| `test/ext-connectors.test.mjs` | mecha 期望 99 → 83 | 测试期望领先于模型事实（模型实际 83 件）；不掩盖，把 99 作为未完成目标记录 |
| `package.json` | `test` 改为 `node --test test/*.test.mjs` | 原 `node --test` 会误收 `out/60239/test-*.mjs` 临时脚本（4 个假失败） |

新增（全部新文件，不覆盖任何既有文件）：

```
src/core/assets-v1/{ids,index,store}.js
src/core/assembly-v1/compile.js
src/core/actions-v1/{orientations,pose,state,candidates,apply,compat-b}.js
test/assets-assembly.test.mjs
catalog/assets-v1/**           （生成的资产库 + 4740 覆盖）
docs/prd-v2/implementation-A/**
tools/prd-v2/emit-contracts.mjs
out/prd-v2/2026-10-26-a/A/**
```

`cli/brickkit.mjs` 新增 6 组子命令（`assets` / `assembly` / `candidates` / `actions` / `manual` / `workflow`），
未修改任何既有子命令。

---

## 2. 原始基线与候选的路径/哈希

| 项 | 路径 |
|---|---|
| 修改前基线哈希（25 文件） | `out/prd-v2/2026-10-26-a/A/baseline/hashes.json` |
| 修改后哈希（17 文件） | `out/prd-v2/2026-10-26-a/A/baseline/hashes-after.json` |
| 原始 60239（只读） | `examples/60239.brick.json`（未改动，sha 保持） |
| 60239 推进候选副本 | `out/prd-v2/2026-10-26-a/A/compat/60239-advanced.brick.json` |
| 资产库 | `catalog/assets-v1/`（index 4,729,634 B + 4,605 个定义） |

关键哈希（修改后，sha256 前 16 位）：

| 文件 | 哈希 |
|---|---|
| `src/core/core.js` | `c9a95f587ed740a6` |
| `src/core/assets-v1/index.js` | `b340916004b89744` |
| `src/core/assembly-v1/compile.js` | `4ac44538ed1523a6` |
| `src/core/actions-v1/candidates.js` | `d8b8af2ef1a31bac` |
| `src/core/actions-v1/apply.js` | `9e80a7bbe768e47d` |
| `cli/brickkit.mjs` | `05efc33822a07d6a` |
| `catalog/assets-v1/index.json` | `030ffb688ed71377` |

---

## 3. 正例、负例、回归与性能结果

### 3.1 正例

| 用例 | 命令 | 结果 |
|---|---|---|
| 资产库构建 + 完整性 | `assets compile --force` | 4605 件，index 4.73 MB，defs 34.0 MB，verify 0 problems |
| 单件按需加载 | `assets inspect 3001` | 17 个接口，render=measured / collide=inferred / assemble=measured |
| 0.3 最小装配 → 0.2 | `assembly compile .../assembly-minimal...` | 2 件，0 errors，连通块 1 |
| 组件实例复用 | `assembly compile .../positive-component-instance...` | 3 件，含 `car/hat/p1` 嵌套路径 |
| 编译产物导出 | `viewer` / `booklet` / `export-ldraw` | 全部成功（见 §3.4） |
| 候选枚举自证 | `--test test/assets-assembly.test.mjs` `[EN-05]` | 640 个候选（4 种零件）全部真实扣合且无穿模 |
| 动作事务 | `actions apply` 端到端 CLI | `committed: true`、`physicalConnection: true`、库存 `T1` 消费 |
| 幂等 | 重复 actionId | `[applied, noop]` |

### 3.2 负例（全部命中预期错误码）

| 负例 | 预期 | 实测 |
|---|---|---|
| `stale-state`（旧 stateHash） | 整批拒绝 | `commandOk: true, passed: false, code: stale-state` |
| `empty-action` | 不记为该步完成 | 命中 |
| `candidate-unknown` | 回滚 | 命中，`rolledBack: true` |
| `missing-action-ref` | 禁止猜编号 | 命中 |
| `instance-id-dup` | 拒绝 | 命中 |
| `repair-not-allowed` | 未开修复模式 | 命中 |
| `inventory-consumed` | 重复消费 | 命中 |
| `abstain-incomplete` | 缺 needs | 命中 |
| `placement-cycle` | 定位环 | 命中，`snapshot: null` |
| `double-placement` | 双重定位 | 命中 |
| `missing-reference` | 缺引用 | 命中 |
| `recursive-template` | 递归模板 | 命中 |
| `missing-asset` | 目录外零件 | 命中 |
| `unknown-connector` | 接口不存在 | 命中 |
| `inventory-double-consume` | token 复用 | 命中 |
| fake-group | 伪组必须失败 | `subassembly-disconnected`，点名 far |
| snap 环 | 必须抛错 | `snap-cycle`，模型未变 |
| 父件碰撞 | 0 个候选 | 0（显式豁免才得 40） |
| 多盒件重叠 | 必须报 overlap | 命中（新回归） |

### 3.3 回归

| 项 | 结果 |
|---|---|
| `npm test` 全套（含 B 的测试） | **191 pass / 0 fail** |
| 连续 4 次全套 | 190/0 × 4（加入新回归前），最终 191/0，无抖动 |
| `node --test test/assets-assembly.test.mjs` | 31 pass / 0 fail |
| 契约夹具 | 8/8 passed（2 正例 + 6 负例，每个负例命中预期错误码） |
| 三个反例 | 4/4 BLOCKED（fake-group / snap-cycle / 父件碰撞候选 / 父件碰撞校验） |
| mecha / lantern / cottage / demo-ext-part | 全部 0 errors / 0 warnings |
| viewer 浏览器渲染 | 2/2 成功（78 件 + 3 件，0 console error，截图非空） |
| booklet PDF | 5 页，297.0×209.9 mm A4 横版 |
| MPD | 78 个零件引用，7 种 .dat，含 `0 STEP` |

修复前后对比（`npm test`）：

| 时点 | tests | pass | fail |
|---|---|---|---|
| 基线（未改动） | 157 | 152 | 5（4 个误收 + 1 个 mecha 期望错） |
| 最终 | 191 | 191 | 0 |

### 3.4 性能（CP-02）

**本轮冻结的可复测基线**：`out/prd-v2/2026-10-26-a/A/perf/baseline-frozen.json`
脚本：`perf/baseline-freeze.mjs`（自记录脚本 sha256 + 9 个源/目录文件 sha256 + CPU/内存/Node 版本 + 样本数）

| 规模 | validate P50/P95 | inspectState P50 | renderState P50 | 候选枚举 P50 |
|---|---|---|---|---|
| 100 件 | **17.9 / 33.5 ms** | 12.1 ms | 18.6 ms | 0.86 ms |
| 1,000 件 | **1,445 / 1,596 ms** | 1,180 ms | 1,724 ms | 3.67 ms |

环境：win32 x64 / Node v22.22.2 / 16 CPU / 15.6 GB。

**诚实的解读（按复核要求收紧）**：
- `validate` 与 `renderState` 在 1000 件是 O(n²) 朴素全量扫描（前者碰撞对，后者遮挡射线×全部盒），约 1.4~1.7 s。**这是未优化基线，不是"性能良好"。**
- 上一轮写的「本基准没有历史冻结基线可比」已被本轮部分解决：现在**有**一份带完整指纹的可复测基线，
  但仓库中仍**没有同一台机器上的历史测量**，所以仍然**不能**得出「恶化 ≤ 20%」的结论。
  本轮只承诺：下一次测量用同一脚本、同一输入指纹即可直接对比。
- 状态：**`partial`**（基线已冻结可用于后续比较；优化与历史对比均未做）。
- 1000 件的候选枚举对「有邻居占位的父件」返回 0，这是场景约束（接口全被占用），不是性能结论；
  另测了隔离件候选枚举作为对照路径。

---

## 4. 哪些 CLI/API 是真实引擎，哪些仍是 mock

### 4.1 真实引擎（有正负例支撑）

| API | 证据 |
|---|---|
| `buildIndex` / `loadDefinition` / `writeAssetStore` / `verifyStore` | ST-01/03/04/05 + 4605 件实跑 |
| `deriveCapabilities` | ST-02（三能力独立判定） |
| `checkContainment` / `topoSortPlacements` / `expandNodes` | AS-04 + 8 夹具 |
| `compileToLegacy` | AS-03/04 + viewer/booklet/MPD 全链路 |
| `inspectFromModel` | EN-01/EN-04 |
| `enumerateCandidates` | EN-02/EN-05（候选自证） |
| `applyActions` | EN-03（正例 + 8 负例 + 幂等） |
| `ORIENTATIONS` / `mateOrientation` | AS-02（24 条自检 + 代数自洽） |

### 4.2 仍无实现或只有部分实现

> 历史说明：本节在第二轮曾把 `renderState` 与 `detach`/`replace` 列为「无实现」。
> 二者现已实现（`renderState` 见 MV-01，修复动作见 EN-03），此处只保留**当前**仍缺的部分，旧结论不删但已失效。

| 项 | 状态 | 说明 |
|---|---|---|
| `constraints.extra-mate` / `keep-out` | **只有 Schema + 校验** | 求解不用，标注为 partial |
| `manual` / `workflow` CLI | **真实入口，实现属 B** | A 只做注册；B 模块缺失时报 `commandOk:false` + `owner:"B"`，不降级 mock |

**没有任何 mock 结果进入过上述验收。** `candidateToB` 里 `mock: false` 是硬编码常量，
因为引擎确实没有 mock 路径；若将来加 mock，必须改这个字段并在报告里区分。

### 4.3 已知的实现取舍（不是缺陷，但要记录）

- `computeSnotLevel` 按"父件中心到侧凸点的法向距离"推算层数，是**推断**不是实测。
  尚无 4 件真实 SNOT 链夹具验证，标为 partial。
- 等价组 `equivalenceGroup` 只按 `父件|类型|朝向|层高` 分组，**没有**做几何对称性分析。
  两个候选在同一组不代表它们真的等价——这是保守分组，评分时应以几何结果为准。

---

## 5. 与 B 联调的真实结果、未解决接口与下一责任者

### 5.1 联调成功项

| 项 | 方式 | 结果 |
|---|---|---|
| B 的观察提取 | `manual extract` CLI | 8 条观察，1 个总装事件（页 32 / 步 45 / wheels），落盘成功 |
| B 的验收标准 | `workflow acceptance 60239-1` | 91 件、车体 83 + 配件 8、`minProductScore 0.6` |
| B 的任务包 | `workflow plan` | 5 个任务包，件数 4+4+4+8+71 = 91 |
| B 任务包件号 vs A 资产库 | `loadDefinition` 逐个加载 | 49/49 唯一件号全部存在 |
| B 的 C1 需求 | `RES-A01` 逐条答复 | 3 条完全对齐，1 条（命名）待 B 定 |
| B 风格候选枚举 | `candidates --b-style` | `parentInstanceId` / `stud_top_N` / `candidateHash` 全对上 |
| **B 的五任务 assetLock** | 用 A 的 `checkAssetLock` 逐任务校验 + 与 `buildAssetLock` 重建比对 | 4/2/3/2/38 件全部 `verified`，条目与重建**逐字相同**；`partLocks` 字典旧写法被拒（6 条 error）|
| **B 的 renderState 夹具** | 用夹具的源模型+相机重跑 A 的实现 | 8/8 标签像素差 **0**、`stateHash` 一致、nodeId/connectorId 全同、无多余标签；`toConnectorMap`/`resolveTag` 双向可用且拒绝错误哈希 |
| **B 的完整组件夹具** | `enumerateCandidates(childModel)` → `applyActions(attach_assembly)` | 64 个候选；装成 3 件 `3023/0 + 3001/15 + 2412b/4`，0 errors/0 warnings，库存持久标 `consumed` |

### 5.2 未解决接口（明确列出）

| 接口 | 阻塞点 | 下一责任者 |
|---|---|---|
| 契约冻结 | 三方夹具已互相消费通过，但契约哈希需双方共同签署；`version.frozen` 仍为 false | **A + B**（共同签署） |
| 别名落点 | `stud_top_N` 已确认为兼容别名、稳定 ID 为权威键；B 侧适配层是否已落地未验 | **B**（落地）+ A（复核） |
| C2 `assetLock` 生产化 | 夹具状态仍是 `review-proposal-not-integrated`；B 需用 A 的生成器产出生产锁 | **B** |
| `constraints.extra-mate` / `keep-out` | Schema + 校验有，求解未用 | **A** |
| 60239 剩余错误 | 候选 5 errors / 原始 9 errors，需 B 的计划与主会话判断 | **B**（计划）+ 主会话 |

**第四轮已关闭的两项（原在此表）**：`detach`/`replace` 已实现（14 项断言 + 4 条守卫变异测试）；
`renderState` 正交模式已与 viewer `ortho=1` 逐点对账（60/60，最大误差 0.0005 px）。

### 5.3 A 只读复核发现 B 侧的问题（详见 `requests-to-B/REQ-A01-*.md`、`REQ-A02-*.md`）

| # | 问题 | 严重度 | 本轮状态 |
|---|---|---|---|
| 1 | ~~`assetLock.partLocks.hash` 全是 `e3b0c442...`（空字符串 SHA-256），且只锁 2/49 件~~ | 高 | **已关闭**：B v4 补了真实哈希，五任务锁 4/2/3/2/38 件全部通过 A 的严格校验 |
| 2 | 里程碑 M2 写 "Verified & Completed"，但 R5 Top-1 68.67% / 新增件 16% / F1 0.63 均未达标 | 高 | **未关闭**（B 侧） |
| 3 | `test/manual-v2.test.mjs` 全套并发时失败（单独跑 3/3 通过） | 中 | 未关闭（B 侧） |
| 4 | `integration-fragments/cli-subcommands.snippet.js` 引用不存在的 `runWorkflowPlan` / `executeFourStepWorkflow`，且用 commander 风格与 root CLI 不符 | 中 | 未关闭（B 侧） |
| 5 | `training/brickvlm/.venv` 是 Linux 路径，Windows 宿主不可用 | 低（权重本身可用） | 未关闭（B 侧） |

---

## 6. 对 B 数据/权重/评测的独立复核结果

复核对象：`out/prd-v2/run-20261026-v3/B/`（B 的最新运行）

| 复核项 | 方法 | 结果 | 判定 |
|---|---|---|---|
| 权重是否真实 | `torch.load` 加载 | `OrderedDict`，2,605,955 参数，真实 PyTorch zip | **确认真实** |
| 权重是否训练过 | 检查 `visual_proj.weight` 统计 | mean -6.07e-05，std 0.0298（非标准初始化形态） | 倾向于已训练，但**未经训练日志交叉验证** |
| 数据集图像哈希 | 抽样 16 张重算 SHA-256 | 16/16 一致，0 缺失 | **确认真实** |
| 数据划分泄漏 | 比对 `sourceFamilyId` / `sourceModelId` 三集合 | 族与模型三集合**互斥** | **族/模型 ID 层面未发现交叉**；不等于「所有形式泄漏均不存在」（见下注） |
| 60239 是否进 holdout | 全样本字符串检索 | holdout/validation 无命中；train 1 处为件号子串误命中 | **字符串层面未见**；未做图像感知哈希比对 |
| 指标可复现 | 跑 `python tools/brickvlm/evaluate_r5.py` | 输出与 B 报告数值一致 | **可复现** |
| R5 指标 vs PRD 门槛 | 逐项对照 §12.3 | 见下表 | **未达标** |
| BOM 守恒 | 5 任务包求和 | 4+4+4+8+71 = 91 = 模型 91 件 | **一致** |
| 任务包件号 vs A 资产库 | 逐个 `loadDefinition` | 49/49 存在 | **一致** |

R5 实测（A 独立复现）：

> **「无泄漏」的边界（收紧表述）**：本轮只验证了 `sourceFamilyId` / `sourceModelId` 三集合互斥，以及 60239 字符串未出现在 holdout/validation。
> 这能证明**标识层面**没有交叉，但不能推出「所有形式的数据泄漏均不存在」——图像级近重复（同一实物不同角度）、
> 说明书页复用、语义级同构题都没有测。因此 ML-01 本轮记 `partial`（ID 层通过、其余未测），不记「全项通过」。

| 指标 | PRD 门槛 | 实测 | 判定 |
|---|---|---|---|
| ML-01 数据无泄漏 | 族级隔离 | 族/模型 ID 三集合互斥 | **仅 ID 层面通过**；图像级/语义级泄漏未测，不计为完整通过 |
| ML-02 正确候选覆盖 | ≥99% | 100%（150/150） | 通过 |
| ML-04 Top-1 | ≥90% | **68.67%** | **未达标** |
| ML-04 Top-3 | ≥97% | **95.33%** | **未达标** |
| ML-05 新增件精确匹配 | ≥90% | **16.00%** | **未达标** |
| ML-05 结构错误 F1 | ≥0.85 | **0.6286** | **未达标** |
| ML-06 领域优化收益 | +5pp 或 -20% 错误率 | 未计算基线对比 | **未测** |
| ML-07 完整流程 | 2/3 零人工完成 | `unverified` | **未测** |
| ML-08 诚实状态 | 单列介入/失败 | 报告列了 123 失败案例 | 部分通过 |

**B 的评测脚本本身是诚实的**（输出 `失败案例总数: 123`、`端到端装配完成: unverified`），
问题在里程碑文档的状态标注：把"管线跑通"写成了"Verified & Completed"。
按 PRD §16.3，正确状态应是 R3 = `implemented`，R5 = `failed`（指标未达标）。

**A 没有替 B 宣称训练成功。** 模型训练里程碑保持未完成。

---

## 7. 逐项验收状态（PRD §12）

图例：`implemented` = 代码有且正负例有；`verified` = A 自测 + 可复跑；
`partial` = 部分覆盖；`failed` = 已测未达标；`unverified` = 有实现但未独立复核；
`not-started` = 未开始；`unavailable` = 资源不可用。

### 7.1 存储与引擎

| ID | 状态 | 证据 / 缺口 |
|---|---|---|
| **ST-01** 资产修订与重现 | `verified`（A 自测；B 的五任务真实锁已实际消费通过） | 同参数重建 contentHash 一致；源哈希变化改变哈希；`missing-asset` 明确失败。`assetLock` 严格校验——缺锁/空串哈希/非 64 位十六进制/件号未覆盖/revision 与内容不符 全部 error，不再降级 warning；9 项负例。**本轮新增联调证据**：B 的五任务锁（4/2/3/2/38 件）逐条通过 A 的校验，且与 A 的 `buildAssetLock` 重建结果逐字相同；`partLocks` 字典旧写法被明确拒绝（`verify-b-asset-lock-consumption.json`）。**缺口**：这份夹具状态仍是 `review-proposal-not-integrated`，B 需用 A 的生成器产出生产锁后才算集成完成 |
| **ST-02** 几何/碰撞/接口分离 | `verified`（A 自测） | 三能力独立 state；2,179 件 collide=unsupported 显式声明；无连接器件 assemble=unsupported |
| **ST-03** 稳定接口 | `verified`（A 自测） | 语义位置生成 ID；重排分组后 ID 集合不变（有测试）；`legacyIndex` 双向映射 0 漂移 |
| **ST-04** 按需与复用 | `partial` | 索引 4.73 MB ≪ 定义 34 MB；按件 1.40 ms。**缺口**：viewer 只打包依赖闭包未实测；"相同 part revision 不重复编译"未测 |
| **ST-05** 数值与基变换 | `verified`（A 自测） | 格/LDU 往返 0 漂移；`sourceToCanonical` det=+1、正交、无镜像（有测试） |
| **AS-01** 根节点迁移 | `verified` | `assembly-tree.test` 的 reanchor 级联用例通过 |
| **AS-02** 正交挂装 | `partial` | 24 姿态自检通过、代数自洽、刚性翻立有测试。**缺口**：侧凸点多层 SNOT 4 件链未测 |
| **AS-03** 嵌套与次序 | `verified`（A 自测） | 嵌套组件 `car/hat/p1` + 刚性挂装；拓扑序父先于子（有测试） |
| **AS-04** 非法图 | `verified`（A 自测） | 6 类非法图全部报错且 `snapshot: null`（不留半成品） |
| **AS-05** 幂等和序列化 | `partial` | 100 次重算 0 漂移（有测试）。**缺口**：保存/读取/编译后等价性未逐位比对 |
| **AS-06** SNOT 编码 | `partial` | **本轮新增**：真实 0/1/2 三层链夹具（3001→4733→3024×3，`snapPart` 逐层求解，中心严格递增 0.4 格）；`snot` 与 `at` 的叠加语义已用等价性测试钉死；`measureSnotChains` 从编译快照实测「逐层 −1」，跳号即报断裂。**缺口**：渲染/导出三者一致性未逐项对账；刚性挂装组件内的 SNOT 链未单独验证 |
| **EN-01** 真实连接 | `verified` | fake-group 反例必须失败（有测试）；分组不产生连接边（有测试）；修复未误伤真实刚体（有测试） |
| **EN-02** 父件碰撞 | `verified` | 单件路径 0 候选、装配路径 0 穿模、显式豁免复现旧行为（三测试）；"多盒件重叠漏检"已修 + 回归。**本轮新增**：候选坐标两处单位/坐标系缺陷修复（父件平移被算两遍、混合单位向量被旋转）——原先侧装候选恒 `fake-connection`；轮件碰撞从「整件豁免」改为「按连接判定」，未连接的轮/瓷砖重叠现在如实报错 |
| **EN-03** 占用/库存/修复 | `verified`（A 自测 + B 反例已关闭） | 8 类负例 + 幂等 + 无部分提交。`attach_assembly` 原子提交（整组落位，任一失败整批回滚，成员库存逐件扣减）；**修复「假回滚」**——原先 rehash 原地改写调用方 `ctx.state`，返回 `rolledBack:true` 但状态已前进；现有「提交回写 / 回滚不动」两条对照用例。**第三轮关闭 A-INV-01**：成功事务把 token 持久写成 `consumed` 并记 `consumedBy`，跨事务第二次装同一组被 `inventory-insufficient` 拒绝；`undo` 把 token 放回 `available`；失败事务不动调用方库存。**第四轮补齐修复动作**：`detach`（按 `consumedBy` 反查释放库存，拒绝「拆完让别人悬空」）+ `replace`（同姿态换件，碰撞/断连/noop/无库存/缺件/无邻居一律拒绝）。证据：8 项守恒断言 + 变异测试（还原旧行为复现 1→3→5）；14 项修复断言 + 4 条守卫变异测试（去掉任一即让对应负例变成通过） |
| **EN-04** 主体可达 | `partial` | `inspectState` 输出 `bodyPartsUnreachable` 与 `largestComponentRatio`。**缺口**：独立配件名单由冻结计划指定（需 B 的 C2）未联调 |
| **EN-05** 目录配对 | `partial` | 4 种零件 × 全部候选自证；`assets preflight` 报 6 个碰撞阻塞。**缺口**：60239 全必需连接的正/错位/方向/碰撞负例未逐对跑 |
| **CP-01** 旧模型兼容 | `verified` | 4 个代表模型 0/0；三种导出全成功；编译 losses 逐项声明 |
| **CP-02** 性能可复测 | `partial` | **本轮新增可复测基线** `perf/baseline-frozen.json`：自记录脚本 sha256 + 9 个源/目录文件 sha256 + CPU/内存/Node 版本 + 样本数。100 件 validate P50 17.9 ms / renderState 18.6 ms；1000 件 1,445 / 1,724 ms。**缺口**：仓库无同机历史测量，仍**不能**宣称「恶化 ≤20%」；O(n²) 未优化 |

### 7.2 工作流/视觉/交付（A 侧只做集成与复核）

| ID | 状态 | 说明 |
|---|---|---|
| WF-01 | `unverified`（B 实现） | A 只验证了 CLI 能产出 8 条观察；来源可回溯性未独立核查 |
| WF-02 | `partial`（B 实现） | 91 = 4+4+4+8+71 守恒；**assetLock 哈希是空串**（见 §5.3） |
| WF-03 | `unverified`（B 实现） | C2 Schema 有；A 未逐字段核对 |
| WF-04 | `not-started` | 需两个真实子会话与收据；A 侧只做了 `workflow audit` 入口 |
| WF-05 | `unverified`（B 实现） | 零新增件总装步在 A 的 0.3 里保留（夹具已验证），但 60239 的 40 步未逐条映射 |
| MV-01 | `partial`（A 侧实现与对账已完成；剩 B 的实际接线） | A 侧 `renderState`：相机契约自描述、2D↔3D 映射、朝向剔除、遮挡剔除（射线 slab + 盒内判定）、密度上限 32、`stateHash` 绑定、`toConnectorMap`/`resolveTag` 适配层、CLI `renderstate` 子命令。**两种投影都已与真实浏览器逐点对账**：透视 60/60、正交 60/60，最大误差均 **0.0005 px**（正交半高取自 `cameraSnapshot().orthoHalfHeight`，不复算取景）。**联调证据**：B 的 `A-to-B-renderstate-fixture` 重跑后 8/8 标签像素差 0、`stateHash` 一致、nodeId/connectorId 全同、无多余标签；`resolveTag` 拒绝错误 stateHash。**缺口不在 A 侧**：B 的 `stud-overlay-v2.js` 尚未在本仓实际接线；夹具状态仍是 `review-consumer-fixture-not-integrated`，故整体仍记 `partial` 而非 `verified` |
| MV-02 | `unverified`（B 实现） | 需 ≥30 个独立标注区域与 IoU ≥0.90；A 未复核 |
| MV-03 | `unverified` | — |
| **EX-01** 60239 总装 | `failed`（**比首轮报的更严重**） | 两个口径必须分开写：**A 的推进候选** `60239-advanced.brick.json` = **5 errors**（4 处穿模 + 1 组 63 件悬空）；**原始示例** `examples/60239.brick.json` = **9 errors / 17 warnings**（6 处 overlap + 2 条 mount-disconnected + 1 条 63 件 floating），91 件、连通分量 36、最大连通比 0.308。其中 3 处按「三向均 > 0.5」的严格判据确认为真实实心穿模。**首轮报「2 errors」是低估**：其中 2 处穿模被轮件整件豁免吞掉，收紧后暴露。碰撞阈值与 HEAD 完全一致、未放宽（`compat/60239-not-loosened.json` 逐对量化「需要放宽几倍才能隐藏」）。**未完成，不因分组/配件豁免/扩大容差而降级** |
| **EX-02** 60239 视觉 | `not-started` | 未做视觉对账（60239 结构都没通过） |
| **EX-03** 输出 | `partial` | **已实测**：viewer 3.64 MB 完全自包含（0 远程引用、0 CDN import、three.js 内联），**用 Chromium 实际打开渲染成功**：canvas 844×833、78 件全部加载、0 console error、0 pageerror，截图见 `compat/exports/lantern-viewer-screenshot.png`；0.3 编译产物同样在浏览器渲染成功（3 件，0 error）。PDF `MediaBox 841.92×594.96 pt` = 297.0×209.9 mm A4 横版，5 页与 `pages:5` 一致。MPD 78 个 type-1 引用与 lantern 78 件一致，含 `0 STEP`。**缺口**：逐步播放 / 组件爆炸 / 机关三种交互未点验；PDF 未人工检查裁切与漏步；MPD 未用 Studio/LDView 外部打开 |
| ML-01～08 | 见 §6 | 训练里程碑**未完成** |

---

## 8. 诚实声明

1. **没有替 B 宣称训练成功。** R5 指标未达标，模型里程碑保持未完成。
2. **`verified` 只是"A 自测可复跑"，不是"B 已独立复核"。** 所有 A 侧 `verified` 都待 B 按
   `REQ-A02` 复跑。PRD §13.4 要求独立复核，A 不代签。
3. **契约未冻结。** 接口命名已按主会话裁决落地（稳定语义 ID 为权威键），三方夹具已互相消费通过；
   但契约哈希仍需双方共同签署，`version.frozen` 仍为 false。
4. **60239 未完成，且首轮报告低估了错误数。** 首轮写"剩 2 个错误"，实际候选是 **5 个**、原始示例是 **9 个**。
   原因是轮件整件豁免吞掉了其中 2 处穿模；第二轮已收紧该规则并如实暴露。**仍记 `failed`**。
5. **性能未优化，但基线已冻结。** 1000 件 validate P50 1.4 s / renderState 1.7 s（O(n²)）。
   已产出带脚本与输入指纹的可复测基线；**仓库无同机历史测量，因此仍不宣称"恶化 ≤ 20%"**。记 `partial`。
6. **`EX-03` 只到 `partial`。** viewer 已用 Chromium 真实打开渲染（0 error、78 件全加载、截图留证），
   PDF 尺寸与页数、MPD 结构与件数都实测过。但**逐步播放 / 组件爆炸 / 机关三种交互没有逐项点验**，
   PDF 没人工检查裁切与漏步，MPD 没用 Studio/LDView 打开过。
7. **A 没有修改任何 B 的所有权文件**（`src/manual-v2/`、`src/brickvlm/`、`tools/brickvlm/`、
   `training/`、`src/core/diff.js`、B 的 Schema 与测试）。
8. **第二轮修复的 5 个引擎缺陷都是 A 自己的代码。** 其中 3 个（候选坐标双重平移、混合单位旋转、
   `snot` 重复计偏移）会让侧装/子组件挂装**完全不可用**；首轮 191 项测试全绿却没能发现，
   因为测试只用了「父件在原点」的场景。这是最重要的教训：**测试全绿不等于功能可用**。
9. **mecha 99 件的期望值不是"计划未落地"，而是从未存在。** git 历史最高 83 件；
   产生 99 件的那条路径今天跑出 29 个 validate 错误。99 作为未完成目标保留，不当作已达成验收。
10. **`renderState` 的两种投影现已都做了像素对账**（第四轮）。透视 60/60、正交 60/60，最大误差均 0.0005 px。
    上一轮把「正交未对账」列为缺口，是当时的真实状态；第四轮补上了，且刻意**没有**自己复算 viewer 的取景公式
    （8 角投影 + 纵横比对齐 + 1.08 边距），而是从页面读真实 `orthoHalfHeight`——复算等于自证。
11. **`detach` / `replace` 的语义边界是刻意收窄的，不是「换件求解器」。**
    `replace` 坚持同姿态、不替调用方挪位姿；换不上（穿模/断连）就拒绝，正确路径是 `detach` + `attach_*` 重新求候选。
    4 条守卫各有一条变异测试：去掉任一即让对应负例从拒绝变通过，证明它们不是装饰。
12. **"无泄漏"只在标识层面成立。** 族/模型 ID 三集合互斥已验证；图像级近重复、说明书页复用、
    语义级同构题都未测。ML-01 记 `partial` 而非通过。
13. **A-INV-01 是第二轮遗留的真缺陷，由 B 独立发现。** 我的库存测试只覆盖了「批次内重复消费」，
    没覆盖「跨事务重复消费」，因此 226 项全绿时它仍然存在。第三轮已修复并补了变异测试，
    但这说明**我自己的测试覆盖也有系统性盲区：只测单个事务的原子性，不测事务序列的守恒性**。
14. **B 的三份夹具已实际消费通过，但都是 review 状态。** 五任务锁、renderState 夹具、完整组件夹具
    都在 A 的实现上跑通并逐项比对，但夹具自身标注 `review-*-not-integrated`；
    在这些夹具被 B 转为生产接线之前，只能记「联调验证通过」，不能记「集成完成」。
15. **R-02 属 B，A 不代签。** A 提供的 `childModel + attach_assembly` 路径已被 B 的夹具验证可用，
    但 B 的候选循环是否已改用它，本轮未复核，按未关闭记。

---

## 9. 证据索引

```
out/prd-v2/2026-10-26-a/A/
  baseline/hashes.json              修改前哈希（25 文件）
  baseline/hashes-after.json        修改后哈希（17 文件）
  repro/repro-cases.mjs             三个反例的复现脚本
  repro/repro.json                  修复前（4×REPRODUCED）
  repro/repro-after.json            修复后（4×BLOCKED）
  perf/bench.mjs                    旧性能基准脚本（保留）
  perf/bench.json                   旧基准结果（保留）
  perf/baseline-freeze.mjs          本轮冻结基线脚本（自记录指纹）
  perf/baseline-frozen.json         可复测基线：validate/renderState/候选 + 环境指纹
  render/verify-projection.mjs      离线投影 vs 真实浏览器对账脚本（透视）
  render/projection-verify.json     透视 60/60 点误差 < 0.001 px
  render/verify-projection-ortho.mjs  第四轮：正交投影对账（半高取自 viewer，不复算取景）
  render/projection-verify-ortho.json 正交 60/60 点最大误差 0.0005 px
  render/renderstate.cottage.json   renderState 输出样例
  repair/verify-detach-replace.mjs       第四轮：detach/replace 14 项断言
  repair/verify-detach-replace.json      每个拒绝码的触发条件
  repair/mutation-prove-repair-guards.mjs 4 条守卫逐条变异
  repair/mutation-prove-repair-guards.json 去掉任一守卫即让对应负例变通过；正例未误伤
  snot/probe-snot-chain.mjs         SNOT 0/1/2 三层链探针
  snot/snot-chain.json              链位姿 / snot 值 / 反例结果
  snot/probe-snot-candidate.mjs     候选 snot 编码探针（暴露重复计偏移）
  snot/probe-candidate-unit-rootcause.mjs  候选坐标缺陷根因（父件平移被算两遍）
  snot/candidate-unit-rootcause.json 根因证据
  mecha/evidence-mecha-83.mjs       mecha 99→83 三项证据脚本
  mecha/mecha-99-to-83-evidence.json 历史最高 83 / 工具 29 errors / 83 合法
  compat/prove-60239-not-loosened.mjs  60239 未放宽容差自证
  compat/60239-not-loosened.json    5 个错误逐对量化 + 容差与 HEAD 逐项比对
  contracts/verify-connector-id-authority.mjs  接口 ID 权威键验证
  contracts/connector-id-authority.json        8/8 通过
  contracts/verify-b-asset-lock-consumption.mjs  第三轮：消费 B 五任务资产锁
  contracts/verify-b-asset-lock-consumption.json 4/2/3/2/38 件全过 + 与重建逐字一致 + partLocks 旧写法被拒
  contracts/verify-b-fixtures-consumption.mjs    第三轮：消费 B 的 renderState 与完整组件夹具
  contracts/verify-b-fixtures-consumption.json   8/8 标签像素差 0 + 3 件目标匹配 + 库存持久 consumed
  inventory/verify-cross-transaction-conservation.mjs  A-INV-01 修复证据（8 项断言）
  inventory/verify-cross-transaction-conservation.json 全通过
  inventory/mutation-prove-assertion-bites.mjs   变异测试：还原旧行为必须复现 1→3→5
  inventory/mutation-prove-assertion-bites.json  fixed 拒绝 / mutant 精确复现 B 报的反例
  cli/                              CLI 端到端产物（candidates → actions → after.brick.json）
  compat/minimal.compiled.brick.json   0.3 → 0.2 快照
  compat/exports/                   viewer / booklet / mpd + 浏览器截图
  compat/verify-exports.mjs         EX-03 验证脚本（真实 Chromium + PDF/MPD 结构）
  compat/exports/exports-verify.json   验证结果（ok: true）
  compat/60239-advance.mjs          60239 推进脚本
  compat/60239-advanced.brick.json  5 errors 的候选副本（首轮曾误标 2 errors）
  compat/60239-advance-report.json  逐项改动依据
  integration/60239.observations.json   B 的观察（经 A 的 CLI）
  integration/60239.build.plan.json     B 的任务包（经 A 的 CLI）
  render/                            renderState 投影对账 + 输出样例
  snot/                              SNOT 三层链探针 + 候选 snot 编码/坐标根因
  mecha/                             99→83 三项证据
  contracts/                         接口 ID 权威键验证（8/8）

docs/prd-v2/implementation-A/
  baseline.md                       基线与能力盘点
  interface-ready.md                接口就绪（含成功/失败用例）
  contracts/version.json            契约版本
  contracts/{part-asset,assembly,action-request,action-response}.schema.json
  contracts/orientation-table.json  24 姿态
  contracts/api.md                  API 与错误协议
  contracts/fixtures/               8 个夹具 + fixtures-report.json
  responses/RES-A01-c1-contracts.md 对 REQ-B01 的响应
  requests-to-B/REQ-A01-review-and-api-questions.md  复核请求 + 5 个 B 侧问题
  milestones/M-A0-C0-baseline-contracts.md
  milestones/M-A1-A2-storage-engine.md
```
