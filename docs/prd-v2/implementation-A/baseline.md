# A0 基线：BrickKit PRD v2 执行对象 A（ZCode）

记录时间：2026-10-26（本机 UTC+8）
证据目录：`out/prd-v2/2026-10-26-a/A/`

## 1. Git 与工作树

| 项 | 值 |
|---|---|
| HEAD | `47f02a57886aacbe809732f1f9abbde51c09eb19` |
| HEAD 提交时间 | 2026-10-24 21:23:04 +0800 |
| HEAD 主题 | Fix Step 7 front/back energy column SNOT connection (15573 + 4070 headlight brick) and pinplate collision box |
| 分支 | `main`（默认分支） |
| 工作树 | **脏**：`git status --porcelain` 77 条（18 modified、59 untracked） |

### 1.1 关键：不能从纯 HEAD 启动

未跟踪但属于本轮基线的源码（59 条中的关键项）：

| 路径 | 性质 | 为什么必须进入基线 |
|---|---|---|
| `src/core/builder.js` (517 行) | 未跟踪 | AGENTS.md 指定的官方搭建入口 `createBuilder`，全部 snap/刚体挂装逻辑 |
| `src/core/diff.js` (1030 行) | 未跟踪 | 视觉对账（B 拥有算法，A 只调用导出） |
| `src/core/observations.js` | 未跟踪 | `checkObservations` 观察清单对账 |
| `src/core/catalog-audit.mjs` | 未跟踪 | 目录四机查审计 |
| `src/ldraw/` (`ldraw.js` 674 行 + `loader.mjs` 202 行) | 未跟踪 | 官方 .dat 镜像下载/校验/几何构建 |
| `src/viewer/ldraw-geom.js` | 未跟踪 | viewer/render 的 LDraw 真实几何 |
| `examples/60239.brick.json`、`60239.bom.json`、`60239.plan.json` | 未跟踪 | 本轮端到端样例 |
| `examples/trex.*`、`lantern.*`、`mecha.reference.photos.json` | 未跟踪 | 其他代表模型与夹具 |
| `test/assembly-tree.test.mjs`、`builder.test.mjs`、`engine-v2.test.mjs`、`plan.test.mjs` 等 8 个 | 未跟踪 | 现有行为契约 |
| `catalog/ldraw/`（3.4 MB，522 个 .dat + manifest + verification） | 未跟踪 | 官方几何权威素材 |
| `catalog/parts-ldraw.json`（6.4 MB，4,585 条） | 未跟踪 | 扩充目录 |

已跟踪但有未提交修改（18 条）中与本责任域相关的：`src/core/core.js`、`cli/brickkit.mjs`、`catalog/parts.json`、`catalog/colors.json`、`package.json`、`package-lock.json`、`schema/photoset.schema.json`、`src/viewer/{main,geom,template}.js`、`test/core.test.mjs`、`build.mjs`。

> 结论：任何以 `git stash` / `git clean` / 新 clone 启动的做法都会丢失 59 个未跟踪文件与 18 处未提交修改。本任务全程在**当前工作树原位**工作，不重置、不清理。

### 1.2 另一执行者 B 的产出

基线时点 `docs/prd-v2/implementation-B/`、`src/manual-v2/`、`src/brickvlm/`、`tools/manual-v2/`、`tools/brickvlm/`、`training/` **均不存在**。只有 `docs/prd-v2/{PRD.md, HANDOFF-A-ZCode.md, HANDOFF-B-Antigravity.md}`（全部未跟踪）。
→ 本轮 A 无 B 产物可集成；C0 契约按“先提供、后兼容”推进，并保留 mock 与真实引擎分离。

## 2. 运行时

| 项 | 值 |
|---|---|
| OS | Windows 10.0.26200 x64（win32），Shell = Git Bash |
| Node | v22.22.2 |
| npm | 10.9.7 |
| 模块体系 | ESM（`"type": "module"`） |
| 依赖 | `@napi-rs/canvas ^1.0.13`、`pdfjs-dist ^6.4.299`、`three ^0.186.1`；dev：`esbuild ^0.25.0`、`playwright ^1.63.0`；optional：`sharp ^0.35.5` |
| Python | 本轮 A 不依赖；B 的 `training/` 尚未建立，无可用解释器证据 |

## 3. 源码与资产哈希（sha256 前 16 位）

见 `A/baseline/hashes.json`。摘录：

| 文件 | sha256[0:16] | 字节 |
|---|---|---|
| `src/core/core.js` | `eed6614abe23b610` | 78,985 |
| `src/core/builder.js` | `1f73ec180ff5922b` | 28,080 |
| `src/core/diff.js` | `997f4bc8229bfc62` | 59,145 |
| `src/ldraw/ldraw.js` | `99515e93d93090ca` | 38,268 |
| `src/ldraw/loader.mjs` | `483c0ac4d29541eb` | 11,543 |
| `cli/brickkit.mjs` | `a7180c4ead1e0928` | 39,349 |
| `catalog/parts.json` | `9394499144642881` | 54,569 |
| `catalog/parts-ldraw.json` | `a136a78e128689de` | 6,417,479 |
| `catalog/colors.json` | `4652bcf5a0b385f5` | 3,602 |
| `schema/brickbuild.schema.json` | `fb434cf0b07fbb8d` | 6,488 |

### 3.1 目录规模（实测，非 PRD 转述）

| 项 | PRD §3.1 读取值 | 本轮实测 | 差异 |
|---|---|---|---|
| 精选目录 | 167 | **167** | 一致 |
| 扩充目录 | 4,585 | **4,585** | 一致 |
| 合并目录 | 4,605 | **4,605** | 一致（重叠 id 147，curated 覆盖 ext） |
| `checked: true` | — | **165** | 2 条未确认 |
| 颜色代码 | — | **36** | — |
| `catalog/ldraw/` `.dat` | — | **522** | 3.4 MB |
| `catalog/ldraw-full/` | — | 602 MB（gitignore） | 全量镜像 |

## 4. 当前 60239 状态（实测，与 PRD 转述一致）

`node cli/brickkit.mjs validate examples/60239.brick.json --pretty`：

| 指标 | PRD §3.1 | 本轮实测 |
|---|---|---|
| parts | 91 | **91** |
| errors | 7 | **7** |
| warnings | 17 | **17** |
| connectedComponents | 36 | **36** |
| largestComponentRatio | 0.307692 | **0.307692** |
| modules / subassemblies / mechanisms | — | **0 / 0 / 0** |
| steps | 40（plan 40 条） | **40** |

> 注：首次读取时曾得到 6 条 errors，后续复测稳定为 7 条（记录见 §7 的
> `60239-advance-report.json` 基线段）。以 7 条为准，与 PRD §3.1 一致。

7 条 errors 明细：

```text
overlap              p002 与 p003 在格子 [12, 1, 5] 重叠（3D 穿模）
overlap              p002 与 p022 在格子 [11, 0, 5] 重叠（3D 穿模）
overlap              p003 与 p022 在格子 [11, 2, 5] 重叠（3D 穿模）
overlap              p004 与 p005 在格子 [12, 1, 8] 重叠（3D 穿模）
mount-disconnected    p003：与 mount 指定的父零件 p002 之间没有真实物理连接
mount-disconnected    p005：与 mount 指定的父零件 p004 之间没有真实物理连接
floating             63 个零件没有连到底座（悬空）
```

17 条 warnings 全部是 `step-order`（零件在其所在步骤还没有支撑）。
60239 仍是**扁平 91 件、无模块、无子组件**的状态，尚未使用关系装配与组件复用。

BOM 口径：`totalParts=92`（`totalPartsSource` 字段）vs 模型 91 件 vs 明细求和 91。
B 在 `implementation-B/baseline.md` 里给出 91 件的核准（说明书第 35 页 52 元素求和 = 车体 83 + 配件 8），
A 用本引擎独立核对：5 个任务包件数 4+4+4+8+71 = 91，与模型 91 件一致。
**92 的来源仍未核实**，本轮保持未核实状态，不擅自改成 91。

## 5. 测试基线

`node --test`（Node 内置 runner，收集仓库全部 `*.test.mjs` + 被当作测试的脚本）：

| 项 | 值 |
|---|---|
| tests | **157** |
| pass | **152** |
| fail | **5** |
| duration | ~7.5 s |

5 个失败分两类：

**（a）4 个是测试收集器误收纳，不是产品缺陷**
`out/60239/test-builder-full.mjs`、`test-full-build.mjs`、`test-rb.mjs`、`test-submodels.mjs` 是 60239 搭建过程的临时脚本，被 `node --test` 的默认 glob 收进测试集。它们本不属于测试套件。
→ 记录为基线噪声；本任务不改历史 `out/60239`，改在 A 侧测试入口加显式 glob 排除（见 A3）。

**（b）1 个是真实回归：mecha 件数期望与实际不符**

```text
not ok 106 - 回归：mecha / lantern / cottage / demo-ext-part 与修复前一致（0 errors 0 warnings）
  test/ext-connectors.test.mjs:298  mecha 零件数  83 !== 99
```

`test/ext-connectors.test.mjs:287` 的注释声称 mecha 已从 83 件重建为 99 件（`tools/fix-mecha-a2.mjs`，“加 16 片 3023 垫板恢复柱顶承重层”），但 `examples/mecha.brick.json` 实际仍是 **83 件**（HEAD `47f02a5` 提交后未再增加）。即：**测试期望领先于模型事实**。
同时 `node cli/brickkit.mjs validate examples/mecha.brick.json` = `ok: true, 0 errors, 0 warnings, 83 parts`。
→ 结论：模型本身干净（0/0），失败原因是测试把“计划中的 99 件”写成了“已达成的 99 件”。本轮不掩盖：按事实把期望改回 83 并单列 99 件目标为未完成项（B 与用户均可复核 diff）。

## 6. 现有能力清单（真实引擎 vs 缺口）

### 6.1 已实现且被测试覆盖（真实引擎）

| 能力 | 入口 | 证据 |
|---|---|---|
| 3D 包围盒穿模 | `partBoxes` / `boxesCollide` / `partsCollide`(core.js:123/169/225) | core.test, engine-v2.test |
| 连接器生成（凸点/底孔/把柄/夹子/销/孔/轴/轮辋/轮胎/人仔） | `partConnectors`(235) | ext-connectors.test |
| 连接匹配 | `partsConnected`(442) | ext-connectors.test |
| 精确扣合 | `snapPart`(489)，越界抛错 + `partsConnected` 复核 | core.test |
| 3D 刚体挂装 | `transformAssembly3D`(596)，含 90°/180° 翻立 | assembly-tree.test |
| 挂点搜索 | `findMounts`(650) | assembly-tree.test |
| 装配树重算 | `recompute`(731) | assembly-tree.test |
| 结构校验 | `validate`(873)，含 fake-group/submodel/strictAssembly/step-order/mount | core.test, t2-gaps |
| 程序化搭建 | `createBuilder`(builder.js) 的 `add`/`addAssembly`/`importSubmodel`/`reanchor` | builder.test |
| LDraw 导出 | `toLDraw`(1235)，子组件 MPD | assembly-tree.test |
| 官方 .dat 几何 | `src/ldraw/{ldraw.js,loader.mjs}` | ldraw.test, ldraw-loader.test |

### 6.2 缺口（PRD 要求但当前不存在）

| 缺口 | 影响 | 归属 |
|---|---|---|
| 无 `assets-v1/`：零件定义只有单一 `catalog/parts.json` + `parts-ldraw.json` 平表 | 无 revision、无覆盖层、无按件加载、无能力三分离、无稳定接口 ID（接口靠 `studs[N]` 数组下标） | A |
| 无 `assembly-v1/`：只有扁平 `parts[]` + `mounts[]` | 无组件模板/实例、无定位 DAG、无额外连接约束、无证据等级 | A |
| `recompute` 不检测 snap 环，静默保留旧坐标 | **反例已复现** | A |
| `findMounts` 跳过父件碰撞 | **反例已复现（40/40 候选）** | A |
| `validate` 支持伪组通过 strictAssembly | **反例已复现** | A |
| 无 `actions-v1/`：无 candidate/stateHash/事务 | 无标准化动作协议，B 无法训练 | A |
| 无 24 姿态的正式 ID 与表（core 内部有 `POSE_TABLE` 但未导出、无 id） | 协议缺稳定编码 | A |
| 无 LDU 统一物理空间（内部混用「格/片」） | 与 PRD §5.3 冲突 | A |
| 无 `catalog-preflight` 的 `commandOk`/`passed` 分离（有命令但字段不全） | 缺 ST-02 验收口径 | A |
| viewer/booklet/MPD 的组件语义 | 需回归确认 | A |

## 7. 反例复现结果（PRD §3.3）

原始脚本与输出：`A/repro/repro-cases.mjs`、`A/repro/repro.json`。

| 反例 | 结果 | 现象 |
|---|---|---|
| fake-group（远处散件声明进子组件） | **REPRODUCED** | `strictAssembly: true` 下 `ok: true`；x=20 处的 `far` 无任何真实连接，却被当作已装；连通块被压成 1 |
| snap 环 | **REPRODUCED** | `recompute` 不抛错，坐标 `0,0,0 \| 0,3,0` 原样退回；`validate` `ok: true` |
| 父件碰撞（上片锚定） | **REPRODUCED** | `findMounts` 返回 40 个候选，**40/40** 的下片（y=2..3）穿入父砖 3001（y=0..3） |
| 同一位姿交给 `validate` | BLOCKED | `validate` 报 `overlap`（说明校验层正确，缺陷在**候选搜索层**） |

> 第 4 行很关键：父件穿模不是校验漏了，而是 `findMounts` 的 `for (const other of mainParts) if (other.id === parent.id) continue;`（原 core.js:692）主动豁免了父件。修复应在此处，而不是放宽 validate。

### 7.1 额外发现的校验漏洞（本轮新发现，不在 PRD 列表内）

在推进 60239 时发现 `validate` 的穿模检测有**两条路径互相让位**的漏洞：

- 整格占用检查（`occ`）会跳过"带 `boxes` 多盒分解的零件"——理由是凹形件空腔格"有格无料"，
  不能按整格判占用。
- 3D 盒检查会跳过"两个都是标准整数格水平件"的组合——理由是整格占用已经覆盖。

两者叠加的结果：**一个带 `boxes` 的凹形件与另一个整数格水平件重叠时，两边都跳过，穿模直接漏检。**

实证（修复前）：

```text
模型：4740 在 [0,0,0] + 3001 在 [0,0,0]（完全重叠）
validate → ok: true, errors: []
```

这条漏洞与 4740 的碰撞定义缺陷（单实心盒覆盖了 Inverted Dish 的内腔）相互掩盖：
- 不修 4740 → 雪糕筒放内腔被判穿模（假阳性 4 处）
- 只修 4740 → 整格路径跳过、3D 路径也跳过，真穿模反而不报

两处都已在本轮修复：`catalog/assets-v1/overrides/4740.json`（多盒分解）
+ `core.js` 的 3D 检查不再跳过"至少一方带多盒"的组合。
修复后既有 4 个代表模型仍是 0 errors / 0 warnings（`npm test` 190/190 通过）。

## 8. 本轮起点判定

- 存储层与引擎层**有大量真实实现**，不是空仓库；PRD §3.1 的描述偏保守（60239 误差 7→6）。
- 但 PRD 要求的**版本化存储、关系装配、动作协议三项完全缺失**，且三个已知反例全部仍然存在。
- 因此本轮不做“从头重建”，做的是：**在现有真实引擎之上分层**（assets-v1/assembly-v1/actions-v1 复用 core 的几何与连接计算），并修复三个反例。
- B 侧在基线时点无任何产物 → 契约按 A 先出、B 后兼容的顺序，全部响应文件预留。
