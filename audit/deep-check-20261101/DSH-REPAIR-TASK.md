# DeepSeek Harness 修复任务

状态：待派发，尚未被 Harness 接收。
目标工作区：D:/Project/brickkit。只修本主仓，不修改 D:/Project/brickkit-workbench。
模型路由：通过 dsh_models 核实后使用 opencode-go / deepseek-v4.1-flash，不静默切换。

## 目标及授权

用户明确要求派发修复任务。落实下列已复核问题，完成源码修复、针对性正反例、资产一致性、构建和实际交付页验证。不要只写分析报告。
现有工作树有大量他人未提交修改，不是干净基线。开始前读取 AGENTS.md、当前差异与下面证据，记录关键输入哈希；不得回退、清理、覆盖他人成果。不要 git add/commit/push，不发布，不修改其它会话或工作树。
本任务是主仓 core/catalog/assets/actions 的单一修复入口，不另派多个写者改同一文件。若发现另一个会话正在写这些文件，应报告冲突并继续独立只读分析，不抢写。
只对本轮变更负责。原审查证据与旧报告保留，新输出写入独立目录；构建前保留现有 dist 快照及哈希。

## 必读证据

1. audit/deep-check-20261101/REPORT.md
2. audit/deep-check-20261101/evidence.json
3. audit/deep-check-20261101/probe.mjs
4. audit/deep-check-20261101/F1-FIX-REVIEW.md（优先于旧报告）
5. out/P1-ball-antistud-fix.md 和 tools/probe-p1.mjs（实现方说明，包含已被复核纠正的推断）

旧 probe.mjs 在 F1 修复后可能因 snapPart 正确抛错提前退出。复制为新目录下的复核脚本并调整预期，不改写旧证据，不将正确抛错当成新故障。

## 修复顺序与验收

### 1. F1 收紧类型判据并建立有效回归

当前特定 ball↔antistud 误配已被拒，但黑名单结构仍允许未知类型自动成为普通凸点。
复核已证明：只将 connectorPairMatches 普通底孔兜底改为 top/side，保留 bar/pin/minifig/ball 专用判据和 partsConnected 的轮对分支，在当前 60239.fixed 的 EN-05 目录和 CLI 合并目录下均为 95→95，未丢连接。
不得把历史“95→91”直接当未知合法类型证据；若再次出现，输出准确 diff 和消失的四对零件及接口类型后归因。
固定原始反例：14417 at=[0,0,0], up=+y；3024 at=[0.5,0,-0.5], up=-z，mount 指向球头件。断言 matcher=false、partsConnected=false、snapPart 拒绝、validate 有 mount-disconnected。
同时断言合法 top/side↔antistud、ball↔socket、pin/bar/minifig 和现有轮对路径不受损；未知类型必须拒绝。
不要用“坐标重合计数”代替 matcher 回归。修正 snapPart 将类型不匹配说成“-z 与 -z 方向不一致”的诊断。

### 2. F2 轮胎隔空连接

来自 examples/60239.fixed.brick.json 的 11208/11209 轮对，将轮胎沿 z 平移 +100 仍连通并通过 validate。
真实安装区间必须有几何依据，不能猜 def.size/def.h 半跨度或调容差凑绿。
主仓已有 src/ldraw/loader.mjs：buildPart/buildPartFromText/createResolver 可递归解析官方几何，不需要缺失的 tools/lib/dat-expand.mjs。
已复核 11208/11209 局部网格 z 范围均为 [-0.625,0.625] 格、依赖缺失为零；这只是整体网格范围，不自动等于轮毂插入区间。
查清接口与实体轴向区间、单位、rot/up 变换，补可追溯字段与严格搭接条件。保留合法轮装，拒绝轴向分离、错轴和错直径。轮对状态层与核心保持一致，不以整对无条件碰撞豁免掩盖干涉。

### 3. F3/F4 接口与资产链一致

assets-v1/ids.js 缺 ball/socket 类型与 mate profile；buildDefinition 丢弃接口；inspectFromModel 只返回 null 接口；候选枚举不能形成合法球窝装配。
补全类型、持久化、接口身份、占用、静态合法候选和反例。静态扣合与连续运动自由度分开验收，不得声称实现了未做的球关节求解器。
readRawCatalog 仍整条覆盖，CLI 使用 mergeCatalogParts，48336/63868/60478 的坐标或数量分歧已证实。统一合并入口与字段来源，验证资产展开后与 CLI 的接口数量、类型、位置、方向一致。
按实际依赖重编译资产并更新必要锁/夹具，记录变化范围；禁止简单刷新快照掩盖错误或全量 git add。

### 4. F5 支架碰撞体

99781/36841 at.y=5 时，官方完整网格最低为 3.5 片，partBoxes 最低为 3.0 片，y=3..3.4 的净空探针仍碰撞。
误差涉及下界 (1-vH)*PLATE；本例 h=1，所以 H 本来等于 PLATE，不能把上界 PLATE 当作最低点错误根因。
以官方网格核定 vH、原点与实体分解，选择有证据的逐件数据或通用表达修复，不盲改所有支架公式。检查下挂/上挑、正向/旋转/侧装、合法净空与真实穿模正反例；44728 不可由另外两件结果替代。

### 5. F6 构建与实际交付

完成上面修复后保留旧 dist 快照，构建主仓交付 HTML，证明源码与产物一致。
检查加载、模型导入、连接/碰撞表现与必要导出路径；使用实际构建页，不用源码函数结果冒充浏览器验收。
若运行环境阻止浏览器验证，记录具体阻塞、已完成的构建/自动验证和未验项目，不宣布完全验收。

## 验证纪律与交付

- 先跑对应正反例，再串行跑完整 npm test；通过/失败/跳过分列，不删负例、不扩大 KNOWN_DEFECTS 或容差换绿。
- 记录机甲原有 11E/2W 的逐条零件集合与数量；不得用此任务扩大为整机甲照片复原。小屋、灯笼 v9 也复查静态状态。
- 不把 F1 局部修复等同于整个球头链完成，不把 301 测试通过等同于实物可搭。
- 未修问题如 60623 occupies:false 在交付中明确保留，本任务不扩张为全部目录重建。
- 新建一份结果报告：逐项已修/仍失败/未验证、文件变更、运行命令、关键输入和产物哈希、正反例结果、测试日志与浏览器证据、剩余风险。
- 这是实现方自验，不能自称独立审计通过。回传实际路径和结果，等待 Codex 复核。
