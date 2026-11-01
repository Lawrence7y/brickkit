# BrickKit 深入复核（2026-11-01）

## 范围与身份

主对象：`D:/Project/brickkit` 当前磁盘源码，HEAD `c0fd7b86`，包含既有未提交修改。
另对 `D:/Project/brickkit-workbench` 的四个相关零件执行只读函数核对，不将其测试或审计结论混入主仓。
本轮只新增本目录审查脚本、证据和测试日志；未修生产源码、重建 dist、提交或修改另一工作树。

输入前后 SHA-256 一致，完整指纹见 `evidence.json`：

- 主仓 core：`260fde35fb4f213dc1654909dd333daff8ce87267c8ef6dd48a7caca38f7c24b`
- 主仓 parts：`121993ea74ffc13c246b2f0db137e21f0dfcc62f1980ee15d9eb85beb162c4d7`
- 主仓 dist：`d2c658f2c9f97fc394f304abb6728c1f255343472fe49d15a8cf35c65747c263`

## 对上一轮结论的纠正

当前主仓 `14417/14418` 已改为 plate + balls/sockets；运行时分别生成一个 ball/socket，不再合成旧 bar/clip。上一轮“球头仍是把柄”不能沿用于这个源码版本。

但这不等于球头装配链全部完成，下述负例和资产链问题均在更新后的源码上重现。

支架 `99781/36841` 的碰撞高度问题仍在本轮所读两套源码中重现。若另有修复分支/产物，需以该版本单独复核，不能据此否定其它未检查版本的修复。

## 确认问题

### F1 / P1 球头误配普通板底孔，并通过整模型 validate —— 已修复（2026-11-01 后续轮次）

- 位置：`src/core/core.js` 的 `connectorPairMatches`（原 `:1021`）。
- 本轮首次记录时的形态：泛化分支仅排除 bar/pin/minifig，新增 ball 落入“其它凸点可以扣 antistud”的兜底；实例 14417 `[0,0,0]` + snapPart 算出的 3024 `at=[0.5,0,-0.5], up=-z` 得到 ball↔antistud true、validate `ok:true / 0E / 0W`。证据键 `ballToAntistud` 保留原样，作为修复前基线。
- **当前状态：兜底分支已改为白名单 `top/side`**。同一原始反例（位姿不变，子件带 `mount`）现在：
  `connectorPairMatches=false`、`partsConnected=false`、`snapPart` 抛错、validate `ok:false` 且报 `mount-disconnected`。
- 独立复验：`REVIEW2.mjs` 的 `F1-original` / `F1-witness` 两项——把同一反例交给历史黑名单写法仍然返回 true，证明修复点确实在白名单，反例本身没有失效。
- 附带缺陷（未修，不阻断）：判罚文案仍写成“方向不匹配：-z 与 -z 不一致”，真实原因是类型不匹配。
- 修复方向（已完成）：显式列举普通凸点类型（top/side），使球头仅能配球窝；该反例已进入 `tools/probe-p1.mjs` 断言式回归。

### F2 / P1 轮胎沿轮轴移动 100 格，仍与轮毂连通

- 位置：`src/core/core.js:1031-1044`，状态层亦复制同类判据。
- 输入来自现有 `60239.fixed.brick.json` 的 11208/11209 轮对。
- 将轮胎 z 平移 +100，保留 mount/snap。轮毂 at `[1,1,0]`，轮胎 at `[0.5,0,100]`。
- 结果：partsConnected true；validate 仍 `ok:true / 0E / 0W`、一个连通分量。
- 根因：coaxial 仅检查垂直轮轴的两个坐标，轮轴方向无距离/厚度交叠限制。
- 影响：分离的轮胎可被报告为已装配，支撑、mount 与状态图同时受影响。
- 修复方向：以真实轮宽和安装区间约束轴向搭接，不把“同轴”单独作为“扣合”的充分条件。
- **真实安装区间已核定**（`F2-INTERVAL.md` / `F2-INTERVAL.mjs`，官方 .dat 网格实测）：
  11208 轮辋外缘带与 11209 胎孔内壁带均为 −0.625..0.625（宽 1.25 格），径向过盈 0.05 格；
  带宽差为 0，故 `|Δ轴向| ≤ 0 + 0.08 = 0.08 格`。当前核心在 0.1 / 0.5 / 5 / 100 格上全部放行。
- **★ 95→91 的真因**：EN-05 的 95 条必需连接里混着 4 条错位轮对（p006|p009、p007|p008、p010|p013、p011|p012），
  全是 rim(z=0) 配 tyre(z=5)、轴向相距 5 格。它们是本缺陷经 `coaxial` 产生、又被状态层写进夹具基线的产物。
  任何合格轴向判据都必然把 95 打成 91；91 才是物理真实的必需连接数。实现方上一轮“轴向判据误伤合法轮装”的判断，
  是把这 4 条错位对当成了合法装配。真正合法的 4 对（Δ=0）在判据下全部保留。
- 证据键：`remoteTyre`。

### F3 / P1 球头新增类型未贯通资产、状态与候选

- 位置：`src/core/assets-v1/ids.js:69`、`index.js:200`、`src/core/actions-v1/state.js:141`、`candidates.js:398`。
- buildDefinition 无 ball/socket 类型映射，输出警告并丢弃接口；当前磁盘 definitions/14417.json 与 14418.json 也只有 stud/antistud。
- 合法 ball↔socket 在 core 中连通，但 inspectFromModel 返回 `aConnectorId:null, bConnectorId:null, mateProfile:null, connectorPairsUnknown:true`。
- 指定球头接口枚举 14418 候选，得到 `count:0, noSolutionReason:unsupported-connector`。
- 影响：源层能表达球关节，但资产协议缺接口，装配候选无法走通、占用关系无法精确表达。
- 修复方向：补类型/profile/序列化/占用/候选契约；暂不支持的运动自由度需明确保留限制，不等同于静态球头扣合不可表达。
- 证据键：`ball-14417`、`ball-14418`、`ballState`、`ballCandidates`。

### F4 / P1 CLI 与资产编译使用不同零件目录合并规则

- 位置：`src/core/assets-v1/index.js:89-95`。
- CLI 使用 mergeCatalogParts 的字段级合并；readRawCatalog 仍以精选条目整体覆盖扩展条目。
- 48336：CLI 把柄坐标 `[0.15,1,1.5] / [1.85,1,1.5]`，资产输入仍为 `[0.5,0.5,1.22] / [1.5,0.5,1.22]`。
- 60478：CLI 产生两个实测 bar，资产输入只产生一个合成 bar；63868 亦不一致。
- 影响：同件号在校验/动作与持久资产协议中有不同接口坐标乃至数量，不能用“资产已重编译”证明一致。
- 修复方向：共享同一目录合并入口，保留字段来源，并测试 CLI/core 与资产展开后的世界接口一致。
- 证据键：`catalog-48336`、`catalog-60478`、`catalog-63868`。

### F5 / P2 当前两套源码仍存在支架碰撞净空误报

- 位置：主仓 `src/core/core.js:247`，99781/36841 的 `vH=3`。
- 本轮实际解析本地官方 .dat 完整依赖网格：两件 missingFiles/cycles/tooDeep/malformed 均为 0。
- 当 at.y=5 片，官方网格最低世界高度为 3.5 片；当前碰撞盒最低为 3 片。
- 误差**只来自下界** `y0 = (1 - vH) * PLATE`（`vH=3` → 3.0 片）。本例 `h=1`，上界 `PLATE` 恰等于 `H`，
  上界不是误差来源；上一轮“上界 PLATE 与 H 无关”的表述对本例不成立，已更正（见 `REVIEW2.json` 的 `C2-loader`）。
- 在 y=3..3.4 片、x=0..1、z=1..1.2 的全网格下方放探针，boxesCollide 命中；这是空域误报，不依赖旧报告中的手填测量值。
- Workbench 只读调用也得到 y0=3 的碰撞盒。它的 14417/14418 当前仍生成旧 bar/clip，说明两套工作树修订不一致。
- 修复方向：核实目标修复版本并同步；依据官方实体边界治理碰撞盒，不直接更改全局容差。
- 证据键：`bracket-99781`、`bracket-36841`、`workbench`。

### F6 / P2 当前源码与发布 HTML 不一致

- 按 build.mjs 的相同 esbuild 参数在内存中构建，没有覆盖文件。
- 本轮构建哈希 `4959a15ff85c3728706c2b9cd18809c880d1c20b9a39b7d82ffd195d975a6814`，与磁盘 dist 哈希不同。
- 上一轮源码/dist 相等的结论已经过期，不能用当前源码修复状态代表分发 HTML。
- 证据键：`build`。

## 验证与边界

- 定向回归：core、builder、catalog-merge、catalog-redirect、mechanism、defect-gates，共 57 通过、0 失败、0 跳过，见 tests.log。
- 本轮没有重跑完整 308 项套件，不能把上一轮全套数字当成本版本结果。
- 小屋、灯笼 v9 静态校验 0E/0W；机甲仍 11E/2W，明细见 evidence.json。
- 60623 仍 occupies:false，碰撞为空集；小屋静态通过不能证明门板/门框实体正确。本轮没有把这一已知问题当作新增反例。
- 未做浏览器交互、实物复拼、照片 diff 或全目录几何验收。构建一致性检查不能替代运行时接受性。
- 测试全绿与上述反例同时成立，说明现有定向回归没有覆盖这些错误路径。

## 二次复核：三处依据的更正（本轮追加）

对本目录上一版说明中的三条依据，逐条重验，结论如下（`REVIEW2.mjs`，全部断言通过，输出 `REVIEW2.json`）：

| # | 上一版说法 | 复验结论 | 依据 |
|---|---|---|---|
| 1 | 白名单会把 EN-05 的 95 条连接挤到 91，说明存在未知合法凸点类型 | **不成立**。单变量把兜底换成 `top/side`，EN-05 两套目录（条目覆盖 / 字段级合并）各 **95→95，丢失 0**；同一测试下黑名单写法也是 95，计数本身无法区分两种写法 | `C1-whitelist`、`C1-census` |
| 2 | 主仓没有 .dat 递归展开器，拿不到可重复的网格测量 | **不成立**。`src/ldraw/loader.mjs` 的 `buildPart / buildPartFromText / createResolver` 可直接递归展开；99781/36841/11208/11209 的 missingFiles/cycles/tooDeep 全 0 | `C2-loader` |
| 3 | `tools/probe-p1.mjs` 的“重合对数”能证明修复 | **不成立**（当时）。旧脚本改过反例位姿、只比坐标不调用匹配判据、无断言。现版本已重写为原反例位姿 + 4 条 `connectorPairMatches/partsConnected/snapPart/validate` 断言 | `C3-probe` |

另更正 F5 的表述：本例 `h=1`，上界 `PLATE` 恰等于 `H`，误差只在下界 `(1-vH)*PLATE`；上一版把矛头指向“上界与 H 无关”对本例不成立。

本轮完整套件实测 **308 项 / 301 通过 / 0 失败 / 7 跳过**，与实现方报告一致。
测试全绿与 F2–F6 未关闭同时成立。

### 95→91 的准确归因

复验发现 EN-05 基线本身含 4 条错位轮对（见 F2 段）。所以：

- 单变量白名单替换：95→95（不丢连接）；
- 任何带轴向约束的轮对判据：95→91，且被丢的正是那 4 条错位对 —— 那是应丢的。

当年把 95→91 归因到“存在未知合法凸点类型”，是因为把两处改动（普通凸点兜底 + 轮对轴向判据）混在一次操作里；
现在可以明确指出：91 是物理真实的必需连接数，EN-05 基线需要从 95 改为 91。

## 复跑

- 本轮反对例/依据复核：`node audit/deep-check-20261101/probe.mjs`（写 `evidence.json`）
- 三处依据复验：`node audit/deep-check-20261101/REVIEW2.mjs`（写 `REVIEW2.json`，7 项断言，全绿 exit 0）
- F2 安装区间实测：`node audit/deep-check-20261101/F2-INTERVAL.mjs`（写 `F2-INTERVAL.json`）
- 修复回归：`node tools/probe-p1.mjs`

上述脚本都只读生产源码；唯一写入是本目录的 JSON 与 `out/_tmpvar`（REVIEW2 的内存变体）。要保留本轮证据，应先复制本目录或为新一轮指定新输出目录。

本轮重点先修 F1/F2 的误放行，再统一 F3/F4 的接口协议，核实 F5 的目标修复版本，最后构建并对实际交付页验收。
