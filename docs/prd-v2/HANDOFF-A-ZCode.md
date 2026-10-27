# 任务书 A：ZCode / DeepSeek v4.1Flash

本任务书供用户复制到 ZCode 中的 DeepSeek v4.1Flash。名称沿用用户指定，不包含对产品可用性或模型能力的保证。

## 可直接复制的启动提示词

```text
请在 D:\Project\brickkit 执行 BrickKit PRD v2 的 A 任务。如果你在 WSL 中工作，对应路径为 /mnt/d/Project/brickkit。

先读取仓库 AGENTS.md 和 docs/prd-v2/PRD.md，再读取本任务书。不要从头重做：仓库已有大量未提交、未跟踪的 builder、装配树、目录扩充、说明书与视觉工具。先盘点真实状态，保留用户与另一位执行者的改动。

你负责零件素材存储、关系装配存储、精确装配引擎和公共入口集成。另一位执行者 B 是 Antigravity 中的 Gemini 3.8Flash，负责说明书理解、主从任务流程、视觉反馈和 BrickVLM 的数据、训练、推理、评测。这个分工只确定责任边界，不预设模型能力强弱。

你不是唯一执行者。严格遵守 PRD 第 13 节文件所有权，不覆盖 B 的文件、不重置工作树、不静默修改公共规格。你拥有 root CLI、package/lock、核心存储与装配、兼容编译和公共契约；B 提供新模块及集成片段，由你合入共享入口。

本项目三个核心目标必须一起保留：
1. 可追溯的零件几何/碰撞/接口存储与可复用关系装配；
2. 实际训练并验证的专用 BrickVLM 小模型；
3. 主会话整体理解与定标准 → 全部零件归总拆分 → 主干与局部并行搭建 → 主会话总装的四步流程。

请先完成基线和 C0 契约草案，然后持续推进你拥有的存储、引擎、兼容和集成工作；独立复核 B 的模型证据。不要只输出方案或停在已存在代码盘点。

新运行与验证证据写入 out/prd-v2/<run-id>/A/，接口文件和请求写入 docs/prd-v2/implementation-A/。不要覆盖历史 out/60239、已有原始模型或旧评分。旧文件需要兼容修复时按所有权作最小修改并记录差异。

交付时逐项给出源码/Schema、运行命令、正反用例结果、接口版本、未完成项及真实产物路径。CLI 正常退出、文件存在、BOM 相等或代码已写都不等于完成总装或训练。不能把未知、缺测、另一方未复核记成通过。

无需为了常规、可逆、已授权的实现步骤反复请求确认；遇到真实缺失资源或跨边界变更时，先完成独立可做部分并报告明确缺口。不要擅自调度其他聊天或替另一位执行者改代码。
```

## 1. 你拥有的工作

以 [PRD](./PRD.md) 为完整规格，重点负责 ST、AS、EN、CP 和 EX 的公共集成。

### A0：基线与契约

1. 记录 HEAD、工作树、源码/资产哈希、运行时、代表性测试和当前 60239 状态。
2. 检查 `src/core/core.js`、`builder.js`、`src/ldraw/`、合并目录、Schema、CLI 和 viewer 导出路径，列出现有能力与缺口。
3. 确认未跟踪源码如何进入双方的同一基线。不能从只含已提交文件的 HEAD 启动后声称“原实现不存在”。
4. 先复现 fake-group、snap 环、父件碰撞等反例，保存当前失败现象。
5. 在 `implementation-A/contracts/` 提交：资产/装配/动作 Schema 草案、24 姿态表、接口 ID 规则、错误协议、最小可运行 fixture 与 C1 API 适配。
6. 消费 B 的 C2/C3 和渲染需求，集成形成 contracts-1.0。提供兼容 mock，但 mock 与真实引擎结果必须分开。

### A1：素材与存储

- Part Asset v1 索引、按件加载、原始/覆盖分离、来源与锁定、可重建缓存。
- 外观、碰撞、连接三类能力分别判定；稳定接口 ID 不能随数组排序变化。
- LDU 统一物理空间与旧格/片 API 适配。
- 关系装配 0.3：组件定义/实例、定位 DAG、额外连接约束、步骤与证据。
- 旧模型导入保留事实和不确定性；新模型编译为现有 viewer 可读快照。
- 按需打包与几何复用，报告真实包体和内存/加载影响。

### A2：引擎与动作

- 24 种正交姿态、局部组件、嵌套挂装和整体刚体变换。
- 对单件、组件和跨组件依赖统一拓扑排序；循环/缺引用/双定位失败。
- 事务求解、回滚、幂等、旧状态拒绝、库存与接口占用。
- 真实连接图不接受分组或配件标志伪造连接。
- 所有相关零件参与碰撞，包含父件；不要靠豁免父件修复挂装。
- 候选无解/截断/歧义有明确状态，不摆地面充数，不把首个合法挂点当作已符合说明书。
- SNOT 兼容编码遵守第一层 0、后续叠层逐片增加规则。

### A3：集成与复核

- 将 B 的说明书、视觉标号、小模型调用及流程模块接入 root CLI 和公共渲染入口。
- 保留现有单文件 viewer、逐步播放、组件爆炸、机关、A4 booklet 与 MPD 输出。
- 消费 B 的 60239 新计划和组件，解决实际接口/引擎问题并推进总装。
- 独立检查 B 的 split、权重是否真实加载、推理是否使用指定 adapter、测试是否泄漏、指标是否复现。
- 最终汇总各方报告，但不能替 B 宣称未发生的训练成功。

## 2. 写入范围

默认唯一拥有：

- `src/core/core.js`、`src/core/builder.js`；
- `src/core/assets-v1/`、`src/core/assembly-v1/`、`src/core/actions-v1/`；
- `src/ldraw/`、`catalog/` 的候选索引/定义/覆盖；
- `cli/brickkit.mjs`、根 `package.json`、`package-lock.json`、`build.mjs`；
- 兼容所需既有 viewer 入口、几何适配和公共导出；
- 资产/装配/动作 Schema、对应测试与夹具；
- `docs/prd-v2/implementation-A/` 与 `out/prd-v2/<run-id>/A/`。

`src/core/diff.js` 由 B 拥有。B 的 `src/manual-v2/`、`src/brickvlm/`、训练、任务包、独立标号模块及其 Schema/测试由 B 拥有，你通过公开导出集成。

不要编辑本 PRD 和两份任务书来消除未满足要求。公共文档与入口集成按 PRD 第 13 节执行。

## 3. 向 B 提供的交接物

```text
implementation-A/
  baseline.md
  contracts/
    version.json
    part-asset.schema.json
    assembly.schema.json
    action-request.schema.json
    action-response.schema.json
    api.md
    orientation-table.json
    fixtures/
  interface-ready.md
  requests-to-B/<request-id>.md
  responses/<request-id>.md
  milestones/<milestone-id>.md
```

交接必须写明：版本/哈希、实际导入路径或命令、一个真实成功用例、一个真实失败用例、已支持范围、暂不支持接口和下一版本变化。只有 API 文字说明不够。

C0 未冻结时可继续独立引擎工作；不要催 B 批量生成尚不稳定的动作标签。

## 4. 你的验收与完成报告

至少逐项覆盖 PRD 的 ST-01～05、AS-01～06、EN-01～05、CP-01～02，并向 B 请求指定候选 revision 的独立复核。

报告包含：

1. 复用了什么、改了什么，为什么；
2. 原始基线与候选的路径/哈希；
3. 正例、负例、回归与性能结果；
4. 哪些 CLI/API 是真实引擎，哪些仍是 mock；
5. 与 B 联调的真实结果、未解决接口和下一责任者；
6. 对 B 数据/权重/评测的独立复核结果；
7. 按 implemented / unverified / verified / partial / failed 列出状态。

如果 B 的训练资源暂不可用，你仍应完成本责任域和可执行集成；模型训练里程碑保持未完成。不要擅自替换为 API 调用、改成只交付脚本或降低测试门槛。
