# REQ-A04：正交 renderState 已对账、detach/replace 已实现

日期：2026-10-26（第四轮）
对应：`docs/prd-v2/reviews/A-INV-01-closure-review-20261026.md`（B 的关闭记录）
性质：A 侧补齐自有缺口的回执。**A-INV-01 未再改动**；**R-02 与契约冻结仍不在本轮范围**。

---

## 1. 结论一句话

A 侧在契约冻结前的最后两个自有缺口已关闭：**正交 `renderState` 像素级对账完成**（60/60，最大误差 0.0005 px），
**`detach` / `replace` 修复动作已实现**（14 项断言 + 4 条守卫变异测试）。全量 **250/250**。

| 项 | 状态 |
|---|---|
| A-INV-01 | **已关闭**（第三轮修复、B 独立复验签收；本轮未改动该路径） |
| 正交 `renderState` | **已对账**（60/60，0.0005 px） |
| `detach` | **已实现**（叶子件可拆、会致悬空则拒） |
| `replace` | **已实现**（同姿态换件，碰撞/断连/noop/无库存/缺件/无邻居均拒） |
| R-02 | **仍属 B**，A 不代签 |
| 契约冻结 | **仍未冻结**（revision 4，frozen=false） |
| 60239 | **仍 failed**（候选 5 errors / 原始 9 errors） |
| 性能 | **仍 partial**（未优化） |

---

## 2. 正交 `renderState` 对账

### 2.1 为什么这次对账是有效对账

上一轮把「正交未对账」列为缺口。补的时候有个陷阱：viewer 的 `orthoHalfHeight` 不是常数值，
它由「包围盒 8 角投到相机平面取半宽/半高 → 按画布纵横比对齐 → 乘 1.08 边距」三步算出
（`src/viewer/main.js:528-543`）。如果离线侧自己再算一遍这套公式，两边用的是同一个假设，
比对就变成自证。

所以这一轮先给 `cameraSnapshot()` 补了 `orthoHalfHeight` / `orthoHalfWidth` 两个只读字段，
对账脚本直接从页面读 viewer **真实在用**的半高，只验证「同一组相机参数下两套投影公式是否给出同一像素」。

改动本身不改变任何渲染行为：`orthoHalfHeight` 取自 `camera.top`。

### 2.2 结果

| 模式 | 点数 | 最大误差 | 平均误差 |
|---|---|---|---|
| 透视 | 60/60 | 0.0005 px | — |
| 正交 | 60/60 | **0.0005 px** | 0.0003 px |

viewer 真实半高：`orthoHalfHeight = 6.613395`、`orthoHalfWidth = 5.952056`，`type = OrthographicCamera`。

证据：
- 脚本 `out/prd-v2/2026-10-26-a/A/render/verify-projection-ortho.mjs`
- 结果 `out/prd-v2/2026-10-26-a/A/render/projection-verify-ortho.json`
- 透视对照 `out/prd-v2/2026-10-26-a/A/render/projection-verify.json`

### 2.3 一条仍需要 B 注意的边界

正交模式**取景**仍由调用方决定，引擎不替调用方算 `orthoHalfHeight`。
`renderState` 只保证「给定这组参数，像素算得对」，不保证「这组参数是最佳取景」。
如果 B 的 overlay 想复用 viewer 的自动取景，需要自己跑那三步、或者从 `cameraSnapshot()` 取值。

---

## 3. `detach` / `replace`

### 3.1 语义边界（刻意收窄）

| 动作 | 做什么 | 拒绝什么 |
|---|---|---|
| `detach` | 拆下模型中已存在的件；按 `consumedBy` 反查释放库存（因此能拆更早事务装上的件） | `detach-no-target` / `detach-unknown-node` / **`detach-orphans-parts`**（拆完会让别人失唯一连接，点名会悬空的件） |
| `replace` | **同姿态**原地换件，`at/rot/up/snot` 全保留；先扣新件 token 再释放旧件 token | `replace-no-target` / `replace-no-part` / `replace-unknown-node` / `replace-noop` / `collision` / **`replace-disconnected`** / **`replace-no-neighbours`** / `inventory-insufficient` / `missing-asset` |

**为什么不给 replace 加「自动找个装得上的位置」**：那会把「换件」偷偷变成「重新装配」。
两者验收标准不同——换件要证明「同一位置换这个件仍成立」，重新装配要证明「候选求解正确」。
同姿态换不上时，正确路径是 `detach` + `attach_*`，让候选枚举重新算。

**为什么 detach 要拒绝「拆完让别人悬空」**：修复动作的语义是把模型改对，不是把问题换个形式。
如果拆支撑件能让三个件变悬空而引擎还返回成功，那 detach 就成了绕过结构校验的后门。

### 3.2 证据

| 证据 | 内容 |
|---|---|
| `out/.../A/repair/verify-detach-replace.json` | 14 项断言：夹具自检、detach 正例/悬空拒绝/目标不存在/门禁、replace 正例 + 6 类拒绝、与 `core.partsConnected`/`partsCollide` 直接调用的一致性交叉验证 |
| `out/.../A/repair/mutation-prove-repair-guards.json` | 4 条守卫逐条注入「去掉该检查」：`MUT-DET-ORPHAN` / `MUT-REP-DISCONN` / `MUT-REP-COLLIDE` / `MUT-REP-NOOP`，每条都让对应负例从拒绝变通过；同时两组正例仍通过（证明不是「一律拒绝」也能让负例全绿）|
| `test/assets-assembly.test.mjs` | 47 → 49 项 |

### 3.3 一个实践上的注意点

`replace` 同姿态能否成立，取决于目录里这两个件的包围盒与凸点位置，不是「同尺寸就能换」。
本轮测试用例就是按实测选的：

- `3023 → 3022` 能换（同为 2×2 板，同姿态仍扣在 3001 上）
- `3023 → 104`（Antenna 6H）在该姿态与父件无连接 → `replace-disconnected`
- `3023 → 99781`（1×2-1×2 倒支架）能扣上但实体重叠 → `collision`

选件依据写进了测试注释，避免后人以为是随便挑的件号。

---

## 4. 请 B 做与不要做的事

请做：

1. R-02：完整执行子组件、按全部零件/颜色/位姿/连接比目标，不要只比锚点 AABB。
2. 生产流程实调用 `childModel + attach_assembly`，把返回的 `_workingModel` 与 `_inventory` **一起**接管。
3. 契约冻结前，双方对 `contracts/version.json`（当前 revision 4）与 `render-state.schema.json` 的哈希达成一致。
4. overlay 若要正交取景，从 `cameraSnapshot().orthoHalfHeight` 取值或自行复算那三步，不要假设固定值。

请不要做：

- 不要为通过验收放宽碰撞容差、用配件豁免、把 60239 按分组合并降级。
- 不要用 `replace` 代替「装不上就换个位置」——它会正确拒绝，然后你会以为是引擎 bug。
- 不要修改 A 的所有权文件（`src/core/assets-v1/`、`src/core/assembly-v1/`、`src/core/actions-v1/`、`cli/`）。

---

## 5. A 侧剩余未完成

| 项 | 状态 |
|---|---|
| `constraints.extra-mate` / `keep-out` 求解 | 未参与（Schema + 校验有） |
| 刚性子组件内部的 SNOT 链 | 未单独验证 |
| 性能 O(n²) | 未优化（基线已冻结） |
| 契约冻结 | 未冻结（revision 4） |
| 60239 | failed |
| R-02 | B 负责 |
| ML-01～08 | 训练里程碑未完成（A 不代签） |
