# A 接口就绪声明（interface-ready）

- 执行者：Task A（ZCode / DeepSeek v4.1Flash）
- 日期：2026-10-26
- 契约版本：`contracts-1.0.0-draft`（等 B 复核意见后冻结）
- 交接文件：本目录 `contracts/`、`baseline.md`、`responses/RES-A01-c1-contracts.md`、`requests-to-B/REQ-A01-*.md`

---

## 1. 版本与哈希

| 项 | 值 |
|---|---|
| Git HEAD | `47f02a57886aacbe809732f1f9abbde51c09eb19` |
| 工作树 | 脏（A 在 59 个未跟踪文件 + 18 个已修改文件之上继续工作，未重置） |
| 契约版本 | `0.9.0-draft`（`contracts/version.json`） |
| 资产索引 | `brickkit-asset-index` 1.0.0，4605 件，index 4,729,634 B |
| 姿态表 | `1.0.0`，24 条，`det` 全 +1 |
| 动作协议 | `1.0.0` |
| 关系装配 | `0.3.0`（兼容读 0.2） |

A 侧全部改动文件哈希：`out/prd-v2/2026-10-26-a/A/baseline/hashes-after.json`
修改前基线哈希：`out/prd-v2/2026-10-26-a/A/baseline/hashes.json`

---

## 2. 实际导入路径

**JS**（Node ESM，无构建步骤）：

```js
// 资产
import {
  buildIndex, buildDefinition, deriveCapabilities, applyOverrides,
  connectorIdMap, expandConnectorGroups, connectorCountOf, readRawCatalog, readDatIndex, contentHashOf,
} from './src/core/assets-v1/index.js';
import { writeAssetStore, readIndex, loadDefinition, loadClosure, verifyStore } from './src/core/assets-v1/store.js';

// 关系装配
import {
  checkContainment, topoSortPlacements, expandNodes, compileToLegacy, validateAssembly,
} from './src/core/assembly-v1/compile.js';

// 动作与状态
import { inspectFromModel, stateHashOf } from './src/core/actions-v1/state.js';
import { enumerateCandidates } from './src/core/actions-v1/candidates.js';
import { applyActions } from './src/core/actions-v1/apply.js';
import {
  ORIENTATIONS, getOrientation, applyOrientation, composeOrientation,
  invertOrientation, mateOrientation, orientationIdOf,
} from './src/core/actions-v1/pose.js';

// B 兼容层
import {
  toBConnectorId, fromBConnectorId, candidateToB,
  enumerateCandidatesForB, bActionsToRequest, stateToB, applyActionsForB,
} from './src/core/actions-v1/compat-b.js';
```

**CLI**：`node cli/brickkit.mjs <命令>`（详见 `contracts/api.md` §2）

---

## 3. 一个真实成功用例（可复制执行）

```bash
# ① 生成按件分层的资产库（4605 件，约 11 s）
node cli/brickkit.mjs assets compile --force
# → {"ok":true,"commandOk":true,"passed":true,"parts":4605,"indexBytes":4729634,"totalDefinitionBytes":34034405,...}

# ② 单件按需加载（不加载全库）
node cli/brickkit.mjs assets inspect 3001
# → {"ok":true,...,"connectorCount":17,"connectorTypes":["antistud","stud"],
#     "capabilities":{"render":{"state":"measured"},"collide":{"state":"inferred"},"assemble":{"state":"measured"}}}

# ③ 0.3 关系装配 → 0.2 兼容快照
node cli/brickkit.mjs assembly compile docs/prd-v2/implementation-A/contracts/fixtures/assembly-minimal.assembly.brick.json -o /tmp/mini.brick.json
# → {"ok":true,"passed":true,"parts":2,"order":["main/base","main/plate"],
#     "validate":{"ok":true,"errors":0,"warnings":0,"stats":{"connectedComponents":1}}}

# ④ 用快照生成 viewer / PDF / MPD
node cli/brickkit.mjs viewer /tmp/mini.brick.json -o /tmp/mini.viewer.html
node cli/brickkit.mjs booklet /tmp/mini.brick.json -o /tmp/mini.pdf
node cli/brickkit.mjs export-ldraw /tmp/mini.brick.json -o /tmp/mini.mpd

# ⑤ 候选枚举（真实引擎，每条候选自证扣合 + 无穿模）
node cli/brickkit.mjs candidates examples/lantern.reconstructed.brick.json --child 3024 --max 2
```

实测输出（本机 2026-10-26）：

```text
assets compile     → parts=4605, index=4.73MB, definitions=34.0MB, verify 0 problems
assembly compile   → parts=2, validate 0 errors 0 warnings, connectedComponents=1
viewer             → ok, ldraw=11, triangles=5876（lantern 78 件）
booklet            → ok, pages=5
export-ldraw       → ok, format=ldr
candidates         → count=2, enumerationComplete=false, truncated=true（maxResults=2）
```

---

## 4. 一个真实失败用例（可复制执行）

```bash
# 旧 stateHash：整批拒绝，不尝试在新状态上执行
node -e "
import('./src/core/actions-v1/state.js').then(async (S) => {
  const C = await import('./src/core/actions-v1/candidates.js');
  const A = await import('./src/core/actions-v1/apply.js');
  const fs = await import('node:fs');
  const cat = { parts: { ...JSON.parse(fs.readFileSync('catalog/parts-ldraw.json','utf8')).parts,
                         ...JSON.parse(fs.readFileSync('catalog/parts.json','utf8')).parts }, colors: {} };
  const model = { format:'brickbuild', version:'0.2',
    parts:[{ id:'b1', part:'3001', color:0, at:[0,0,0], rot:0, up:'+y', snot:0, step:1 }] };
  const si = S.inspectFromModel(model, cat, {});
  const cand = C.enumerateCandidates(si.state, { childPartId:'3020', parentNodeId:'b1', maxResults:1 }, cat).items[0];
  const ctx = { model, cat, stateHash: si.stateHash, state: si.state, inventory: [], taskId: 't1',
                mainRootNodeId: 'b1', enumerate: (r) => C.enumerateCandidates(si.state, r, cat) };
  const r = A.applyActions(ctx, { protocolVersion:'1.0.0', taskId:'t1', stateHash:'deadbeef',
    actions:[{ id:'a1', op:'attach_part', candidateId: cand.candidateId, partId:'3020',
               target:{ partInstanceId:'p2' } }] });
  console.log(r.commandOk, r.passed, r.diagnostics[0].code);
});"
```

实测输出：

```text
true false stale-state
```

即：`commandOk: true`（命令跑通了）、`passed: false`（业务门禁未过）、`code: stale-state`。

另一个失败用例（父件碰撞反例，修复前会返回 40 个穿模候选）：

```bash
node -e "
import('./src/core/core.js').then(async (core) => {
  const fs = await import('node:fs');
  const cat = { parts: { ...JSON.parse(fs.readFileSync('catalog/parts-ldraw.json','utf8')).parts,
                         ...JSON.parse(fs.readFileSync('catalog/parts.json','utf8')).parts }, colors: {} };
  const main = { format:'brickbuild', version:'0.2',
    parts:[{ id:'base', part:'3001', color:0, at:[0,0,0], rot:0, up:'+y', snot:0, step:1 }] };
  const sub = { format:'brickbuild', version:'0.2', parts:[
    { id:'low', part:'3020', color:0, at:[0,0,0], rot:0, up:'+y', snot:0, step:1 },
    { id:'up',  part:'3020', color:0, at:[0,1,0], rot:0, up:'+y', snot:0, step:2 } ] };
  console.log('with parent check   :', core.findMounts(main, sub, cat, { anchor:'up', maxResults:40 }).length);
  console.log('without parent check:', core.findMounts(main, sub, cat, { anchor:'up', maxResults:40, includeParentCollision:false }).length);
});"
```

实测输出：

```text
with parent check   : 0
without parent check: 40
```

修复前这两行都是 40。

---

## 5. 已支持范围

| 域 | 已支持 | 边界 |
|---|---|---|
| ST 资产 | 索引/按件加载/覆盖链/内容哈希/能力三分离/稳定接口 ID/LDU 换算/源→规范基变换/**assetLock 严格校验（缺件·空串·不符一律拒绝）** | 容差 profile 未用完整夹具冻结；覆盖层目前没有真实生产用例 |
| AS 装配 | 0.3 定义与实例/归属树/定位 DAG/拓扑排序/实例路径/刚性挂装/编译到 0.2/**SNOT 链实测（逐层 −1）** | `constraints` 只校验不参与求解；镜像实例仅存标记 |
| EN 引擎 | 状态与 stateHash/候选枚举（含父件碰撞）/事务执行/**真回滚**/幂等/库存占用/可达性/**attach_assembly 原子提交**/**跨事务库存守恒（A-INV-01 已关闭）**/**修复动作 undo+detach+replace** | 候选是全量朴素扫描（O(n²)） |
| MV 标号 | **`renderState` 已实现**：相机契约、2D↔3D 映射、朝向剔除、遮挡剔除（射线+盒内）、密度上限 32、stateHash 绑定、B 侧 `toConnectorMap`/`resolveTag` | 只输出几何与映射表，不画像素（画图归 B）；正交相机需显式 `orthoHalfHeight` |
| CP 兼容 | 0.2 读写、viewer/booklet/MPD 全链路、编译 losses 声明 | 0.3 的 constraints/inventory/evidence 不进 0.2 快照 |

**已与 B 的夹具实际联调通过**（2026-10-26 第三轮）：

| 夹具 | 结果 |
|---|---|
| `A-to-B-asset-lock-fixture`（五任务 4/2/3/2/38 件） | 全部 `verified`，条目与 `buildAssetLock` 重建**逐字相同**；`partLocks` 字典旧写法被拒 |
| `A-to-B-renderstate-fixture` | 8/8 标签像素差 **0**、hash 一致、`toConnectorMap`/`resolveTag` 双向可用且拒绝错误哈希 |
| `A-to-B-full-assembly-fixture` | 64 候选 → 装成 3 件目标，0 errors/0 warnings，库存持久标 `consumed` |

> 三份夹具自身标注 `review-*-not-integrated`。因此这里的「联调通过」指**A 侧能正确消费**，
> 不等于 B 已把这些路径接进生产流程。契约冻结仍需双方共同签署。

## 6. 暂不支持的接口

| 接口 | 状态 | 说明 |
|---|---|---|
| `constraints.extra-mate` / `keep-out` 的执行 | **部分** | Schema + 校验有，求解未用 |
| `renderState` 正交相机的取景自动化 | **部分** | 投影公式已逐点对账（60/60，最大误差 0.0005 px）；但 `orthoHalfHeight` 仍需调用方显式给，引擎不替调用方算取景 |
| 1000 件以上的性能 | **partial** | 已冻结可复测基线（`perf/baseline-frozen.json`）；O(n²) 未优化 |
| 刚性子组件内部的 SNOT 链 | **部分** | 顶层 SNOT 0/1/2 三层链已实测；组件内链未单独验证 |

### 6.1 `renderState` 的相机契约（B 可直接照抄）

```js
// 与 src/viewer/main.js 逐项一致，已用真实浏览器逐点验证
dir  = [sin(az)*cos(el), sin(el), cos(az)*cos(el)]   // 由 target 指向相机
world = [x格, y片*0.4, z格]
fovY = 30°, near 0.1, far 2000                        // 透视
正交：必须显式给 orthoHalfHeight，x 方向半宽 = orthoHalfHeight * aspect
像素原点 = 左上角；x 向右，y 向下
```

两种投影都已与真实浏览器对账：

| 模式 | 结果 | 证据 |
|---|---|---|
| 透视 | 60/60 点，最大误差 **0.0005 px** | `render/projection-verify.json` |
| 正交 | 60/60 点，最大误差 **0.0005 px** | `render/projection-verify-ortho.json`（半高直接取自 viewer 的 `cameraSnapshot().orthoHalfHeight`，不复算取景） |
| B 的消费夹具 | 8/8 标签像素差 **0** | `contracts/verify-b-fixtures-consumption.json` |

> 正交对账为什么不自己算取景：viewer 的半高由「8 角投影 + 纵横比对齐 + 1.08 边距」决定。
> 离线侧若复算这套公式，比对就变成自证。所以这里只验证「同一组相机参数下两套投影公式是否给出同一像素」。

### 6.2 库存守恒的调用方约定（A-INV-01 修复后）

```js
// 事务成功：把返回的三样东西一起接管，不要只取 _workingModel
const r = applyActions(ctx, request);
if (r.passed) {
  model     = r._workingModel;   // 新模型
  inventory = r._inventory;      // token 已持久标 state:'consumed'，带 consumedBy
}
// 事务失败：调用方的 model / state / inventory 全部未动，可原样重试
```

**必须一起接管 `_inventory`**：只更新 model 而沿用旧 inventory，等于把消费事实丢掉，
下一事务会再次消费同一批 token（这正是 A-INV-01 的表现）。引擎侧已能拒绝，
但调用方不该靠引擎兜底。

### 6.3 修复动作的语义边界（`undo` / `detach` / `replace`）

三个动作都要求 `repairMode: true`，否则 `repair-not-allowed`。

| 动作 | 做什么 | 明确拒绝什么 |
|---|---|---|
| `undo` | 撤销**本批次**刚应用的动作，移除该动作产生的全部实例（含 `attach_assembly` 的带前缀成员），并按记录释放 token | 目标动作未在本批次成功过 → `undo-unknown` |
| `detach` | 拆下**模型中已存在**的件；按 `consumedBy` 反查释放库存，所以能拆更早事务装上的件 | 拆完会让别的件失去唯一连接 → `detach-orphans-parts`（点名会悬空的件） |
| `replace` | **同姿态**原地换件（`at/rot/up/snot` 全保留）；先扣新件 token，再释放旧件 token | 碰撞 → `collision`；与原邻居全部断连 → `replace-disconnected`；原本就无连接 → `replace-no-neighbours`；同件同色 → `replace-noop`；该件号库存全耗尽 → `inventory-insufficient`；缺件 → `missing-asset` |

**边界说明**：`replace` 不替调用方挪位姿。同姿态换不上（穿模或断连）时，正确答案是
`detach` + `attach_*` 重新求解候选，而不是让 `replace` 自己找位置——那样就把「换件」
偷偷变成了「重新装配」，两件事的验收标准不同。

证据：`repair/verify-detach-replace.json`（14 项断言）+ `repair/mutation-prove-repair-guards.json`
（4 条守卫逐条注入，去掉任一即让对应负例变成通过，证明它们都是唯一拦截者；正例不受影响）。

## 7. 下一版本变化预告

- `contracts-1.0.0`：稳定语义 ID 为权威键（已裁决落地，见 `contracts/connector-id-authority.json`），
  `stud_top_N`/`stud_side_N` 为别名，裸 `stud_N` 仅兼容输入且只解释为顶凸点
- `constraints.extra-mate` / `keep-out` 参与求解
- 候选枚举与 validate 加空间索引，把 1000 件的 O(n²) 降下来（当前 validate P50 1.4 s / renderState 1.7 s）
