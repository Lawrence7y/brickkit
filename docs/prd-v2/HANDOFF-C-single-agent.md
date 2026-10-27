# 任务书 C：单一执行会话接管 PRD v2 全部剩余工作

日期：2026-10-26 23:35。适用对象：接下来唯一的执行 Agent（下称 **C**）。  
原 A（存储/引擎）与 B（说明书/BrickVLM）两条线从现在起**全部由 C 负责**。PRD 与 A/B 任务书仍然只读，作为规格输入；本文只改变"谁来做"和"先做什么"，不改任何验收门槛。

---

## 可直接复制的启动提示词

```text
请在 D:\Project\brickkit（WSL 下为 /mnt/d/Project/brickkit）接管 BrickKit PRD v2 的全部剩余工作。

先读：AGENTS.md → docs/prd-v2/PRD.md → 本任务书 docs/prd-v2/HANDOFF-C-single-agent.md → docs/prd-v2/reviews/ 下最新复核（A-B-integration-review、Task-B-v4-review、R02-closure-evidence）。
原 A/B 两个执行者已退出，你是唯一执行者，同时拥有 A 与 B 的全部文件所有权。不要从头重写：仓库已有大量未提交/未跟踪实现，先盘点再复用；不要 git reset/clean，不要覆盖历史 out/ 产物和旧报告。

工作方式要求：你应当大量使用子代理（subagent）。
- 盘点、读代码、查资料用 research 子代理并行做，避免把主上下文塞满；
- 互不相交的实现任务分给多个 self 子代理并行做，事先写清各自独占的文件范围；
- 每个里程碑完成后，另起一个"没参与实现"的只读复核子代理，按 PRD §13.4 复跑正负例，复核报告写入 docs/prd-v2/reviews/；
- 四步工作流的子模型搭建必须交给真实的子代理会话执行，并在收据里记录其 conversationId。
你（主会话）负责：全局规划、契约决策、验收标准冻结、总装、最终报告。

优先级：先把第二个核心目标 BrickVLM 从 smoke 推到"真实数据 + 真实视觉语言基座微调 + 留出评测"，同时补完引擎契约冻结与 60239 零错误总装。顺序与退出条件见本任务书 §3。

新产物写 out/prd-v2/<run-id>/C/，交接与报告写 docs/prd-v2/implementation-C/。不修改 PRD 门槛；未达标如实标 partial/failed/unavailable，不用 smoke、mock、强模型 API 或"CLI 退出 0"冒充完成。常规可逆的实现步骤无需反复请示；遇到真实资源缺口（如显存）给出具体问题与可选方案。
```

---

## 1. 第二个核心目标（BrickVLM）当前进度

结论：**约 15%～20%。管线骨架和小规模真实数据链路已打通；真正的"视觉语言基座领域微调"一次都没跑过；所有 ML 验收项未通过或不适用。**

| 阶段 | 状态 | 证据 / 缺口 |
|---|---|---|
| R0 资源预检 | 完成 | [resource-preflight.md](./implementation-B/resource-preflight.md)：RTX 3060 Laptop **6 GB，空闲约 3.7～3.9 GB**；结论是本机跑 Qwen2.5-VL-3B QLoRA 很可能 OOM，7B 不可行 |
| R1 零样本基线 | **未完成** | `tools/brickvlm/baseline_r1.py` 只在 smoke 数据上跑过；没有"同协议、未微调 VLM 基座"的冻结基线，ML-06 无法计算 |
| R2 数据 | 部分 | ① `synthetic_badge_smoke` 1,500 图：复核证明去掉序号只剩 8 种图，不看图查表即可 holdout 全对，**只能当 smoke**。② 真实装配课程 15 对 S_t→a→S_t+1（stack/snot/subasm 各 5）：30 模型 0/0、哈希全对；**R-02 已于 23:31 关闭**（60/60 候选重放与标签一致，见 [R02-closure-evidence](./reviews/R02-closure-evidence-20261026.json)）。距 PRD 建议的 ≥5,000 去重状态 + ≥200 真实说明书步骤差两个数量级 |
| R3 SFT pilot | 不符合要求 | 有真实权重 `out/prd-v2/run-20261026-v4/B/weights/r3-pilot-best/model.pt`，但它是**自研 ~310 万参数 BrickVLMCompact，从零训练 107 秒，训练数据是 smoke**，不是视觉语言基座的领域微调。Qwen QLoRA：有 `Trainer` 代码，但 preflight 里 `image_grid_thw` 仍为 simulated，单 batch 前后向从未实测 |
| R4 修复与集成 | 未开始 | 无 `serve` 推理服务，未接入会话，未用 A 的 `applyActions` 闭环；repair_local 无数据 |
| R5 留出验收 | failed / 不适用 | v4 holdout 是 smoke：Top-1 0.873（可被查表打满，无意义）、新增件精确匹配 0.16、结构 F1 0.0；ML-07 端到端 0/3 |
| RL | 未开始 | `tools/brickvlm-reward.mjs` 仅为早期奖励脚本 |

四类必训任务覆盖情况：`select_action` 有 15 对真实样例；`understand_step`、`understand_structure`、`repair_local` **没有可用真实数据**。

### 同期 A 侧新进展（23:31，尚待独立复核）
- 跨事务库存重复消费 A-INV-01 已修（`out/prd-v2/2026-10-26-a/A/inventory/verify-cross-transaction-conservation.json`，复核探针 `inventoryInvariantViolated:false`）。
- `detach` / `replace` 已实现（`.../A/repair/verify-detach-replace.json`）。
- 正交投影像素对账已做（`.../A/render/projection-verify-ortho.json`）。
- B 的五任务资产锁按 A 契约消费通过（`.../A/contracts/verify-b-asset-lock-consumption.json`）。
- 契约仍是 `0.9.0-draft`，`frozen:false`；60239 原始 9 errors / A 推进副本 5 errors，仍 failed。

---

## 2. 角色合并后的规则调整

1. **文件所有权**：PRD §13.2 的 A/B 所有权合并给 C。仍需保留"同一文件同一时刻只有一个写入者"——并行子代理开工前，由主会话分配互不重叠的文件集，写进子代理提示词。
2. **独立复核（§13.4）**：原来是 A/B 互审，现在改为"实现子代理 ≠ 复核子代理"。复核子代理只读、不改业务代码，只新增 `docs/prd-v2/reviews/` 下的报告、探针和证据 JSON。报告里如实写明"同一模型的不同会话复核"，**不等同于跨 Harness 复核**，最终报告单列这一限制。
3. **WF-04 主从并行**：用 ≥2 个真实子代理会话执行子模型任务包，收据记录子代理 conversationId、输入/产物哈希、起止时间。主会话串行生成多个文件不算。
4. **契约冻结（C0）**：不再等待另一方，由 C 在消费夹具全部真实调用通过后冻结 `contracts-1.0`，把 `version.json` 改为 `frozen:true` 并记录哈希；冻结后的破坏性变更按 PRD §13.3 提升版本。
5. **历史保护**：`out/prd-v2/2026-10-26-a/`、`run-20261026-v2/v3/v4/`、`out/60239`、`examples/60239.*` 只读。新 run 一律 `out/prd-v2/<run-id>/C/`。
6. **环境**：WSL 下 `npm test` 会因 `@napi-rs/canvas` 是 Windows 版二进制而失败。需要 WSL 内跑全量测试时，先评估是否单独安装 linux 版可选依赖（不要改根 lock 的 Windows 兼容性）；或在报告里标明测试在哪个平台执行。

---

## 3. 执行顺序与退出条件

按依赖推进，同一阶段内的条目尽量拆给并行子代理。

### 阶段 C0：盘点与契约冻结（短）
| # | 任务 | 建议子代理 | 退出条件 |
|---|---|---|---|
| C0-1 | 刷新基线：HEAD、工作树、关键哈希、两平台测试结果 | research ×1 | `implementation-C/baseline.md` |
| C0-2 | 复核 A 在 23:31 的四项新修复（库存持久化、detach/replace、正交投影、锁消费） | 只读复核 ×1 | 复核报告；不通过则回到实现 |
| C0-3 | 合并 A/B 契约（C1 + C2/C3），统一接口 ID（稳定语义 ID 为权威）、资产锁格式（用 `buildAssetLock`）、数据集与动作协议版本映射 | self ×1 | `contracts-1.0` frozen；全部消费夹具真实调用通过 |
| C0-4 | 修 B 收据门禁：revision/stateHash/产物哈希与任务包真实绑定；声明件数与分配件数一致 | self ×1 | v4 复核里的两条反例被拒 |

### 阶段 C1：BrickVLM 真实数据工厂（最高优先级）
目标：把 15 对扩成可训练规模，**答案来自结构目标，不来自生成公式**。

| # | 任务 | 要点 | 退出条件 |
|---|---|---|---|
| C1-1 | 轨迹生成器：用已验证 builder / A 的 `enumerateCandidates`+`applyActions`，从已验证装配源（mecha、lantern、cottage、trex、0.3 夹具及新增合法程序化模型）按步骤回放生成 S_t→a→S_t+1 | 候选 ID 每样本随机匿名；候选顺序随机；等价组靠真实重放判定（沿用 R-02 关闭时的方法） | 每条样本含两个装配源、资产锁、动作请求/响应、相机、哈希；抽样重放 100% 一致 |
| C1-2 | 渲染：目标图、当前图（中立接口标号）、无标号评分图；绑定 stateHash + 相机 | 用 A 的 `renderState` + 无头 viewer；GPU/浏览器并发不要和训练同时抢显存 | 标号可读、2D↔3D 映射可解析 |
| C1-3 | 结构理解与修复数据：从正确状态派生漏件、错位、左右互换、颜色错、反向等扰动，真值来自与参考装配的差异 | 不再用编号取模指定错误 | `understand_structure` / `repair_local` 各有可核查样本 |
| C1-4 | 真实说明书步骤：从已有说明书素材（`assets/instructions-*`、`out/manual-pages`）人工核查标注步骤区域、新增件、数量、翻面/重复/总装 | 只保留来源可追溯的；60239 只进开发集 | 朝 ≥200 训练步 + 留出步推进，如实报告实际数量 |
| C1-5 | 划分与防泄漏：按模型族划分；结构去重；**捷径探针**（不看图的查表基线、仅候选 ID 基线、仅姿态 ID 基线）必须接近随机 | 测试集在选模型前冻结 | split manifest + 哈希；捷径基线报告 |

数量目标沿用 PRD：≥5,000 去重合法/修复状态、≥200 核查过的真实说明书训练步；留出 ≥300 案例、≥3 个未见模型族、≥100 真实说明书步骤。达不到就如实写实际数量，标 pilot。

### 阶段 C2：基座选择、基线与真实微调
| # | 任务 | 要点 | 退出条件 |
|---|---|---|---|
| C2-1 | 重新做 R0：在 **≤3.7 GB 可用显存**约束下比较可获得的视觉语言基座（Qwen2.5-VL-3B 4bit+低分辨率局部裁剪、Qwen2-VL-2B、InternVL 1B 级、SmolVLM 系列等，以实际可下载版本为准），记录许可、显存实测、训练支持 | 不预设哪个最好；以单 batch 实测为准；可用"区域裁剪+较低分辨率"保住凸点细节 | 选定基座及理由；若都不可行，给出所需云端 GPU 规格并请示用户 |
| C2-2 | 修 Qwen/所选基座数据路径：真实像素进 processor，产生真实 `pixel_values`/`image_grid_thw`；assistant-only labels；多模态 collator | 单 batch forward/backward 实测并留日志 | 不再有 simulated 字段 |
| C2-3 | R1 零样本基线：同协议、未微调基座在 C1 冻结验证集/留出集上的结果 | 冻结后作为 ML-06 比较对象 | baseline 报告 |
| C2-4 | R3 SFT（LoRA/QLoRA）：四类任务多任务训练 | 训练与渲染/高显存推理不要同时跑 | 可加载 adapter + 配置 + 日志 + 验证曲线 + 数据哈希 |
| C2-5 | 保留 BrickVLMCompact 作为**对照**，在同一真实数据上重训，用来衡量"基座有没有用" | 不能拿它代替 VLM 基座微调去声明 ML-03 | 对照结果 |

### 阶段 C3：引擎补完与 60239 四步流程
可与 C1/C2 并行，交给不同子代理，文件集不重叠。

| # | 任务 | 退出条件 |
|---|---|---|
| C3-1 | 60239 BOM 92/91 口径核准；说明书观察从"8 条固定标注适配器"扩到全部 40+ 步，可回溯页区域 | WF-01、WF-02、WF-05 |
| C3-2 | 修 60239：4 处穿模 + 63 件悬空 + 2 处 mount-disconnected；50745 等先核准官方几何再改碰撞体 | 严格校验 0 errors / 0 warnings（EX-01） |
| C3-3 | 四步流程真跑：主会话搭主体 → ≥2 个子代理分别搭子组件 → 早期试装 → 总装；收据含子代理 conversationId | WF-03、WF-04 |
| C3-4 | 引擎遗留：ST-04 依赖闭包打包实测、AS-05 序列化等价、AS-06 渲染/导出一致、EN-04 配件名单联调、EN-05 60239 必需连接正负例、CP-02 O(n²) 优化 | 对应 partial 项转 verified |
| C3-5 | MV-02 掩膜：≥30 个独立标注区域，IoU 均值 ≥0.90 并列最差样本 | MV-02 |
| C3-6 | 60239 视觉对账：成品 diff ≥0.6，冻结关键步 ≥0.7，四向正交渲染 + 人工核查 | EX-02 |

### 阶段 C4：集成、恢复与端到端
| # | 任务 | 退出条件 |
|---|---|---|
| C4-1 | `python -m brickvlm.serve` 推理服务；Node 侧通过版本化 JSON 调用；输出基座、adapter revision、协议、stateHash | R4 |
| C4-2 | 闭环：理解 → 候选 → 模型选动作 → `applyActions` → 校验 → 渲染反馈 → 局部修复（单步 ≤3 次、修复 ≤2 轮） | 介入、abstain、失败分别计数 |
| C4-3 | 导出：viewer 逐步播放/爆炸/机关点验，PDF 人工查裁切漏步，MPD 外部工具打开 | EX-03 |

### 阶段 C5：留出验收与最终报告
- 用冻结模型在冻结留出集上跑 R5：ML-01～ML-08 逐项给出分子/分母；ML-07 在 3 个留出模型上记录完整流程。
- 只读复核子代理复跑权重加载、split、评测脚本和端到端记录。
- `out/prd-v2/<run-id>/` 按 PRD §16.3 组织联合交付；`final-report.md` 回答 PRD §16.3 的 5 个固定问题，每项状态取 `not-started/implemented/unverified/verified/partial/failed/unavailable` 并附证据。
- RL（P2）只有在 SFT 基线、奖励负例、独立测试都稳定后才开始，单独报告。

---

## 4. 子代理使用建议

| 场景 | 类型 | 做法 |
|---|---|---|
| 盘点现有代码/产物、读长报告、查基座资料 | `research` | 同时开 2～4 个，各查一块，只要结论 + 文件路径 |
| 并行实现（例：数据工厂 / 60239 修复 / 引擎遗留 / 掩膜标注） | `self` | 提示词写清：目标、独占文件集、禁止碰的文件、退出条件、证据输出路径 |
| 独立复核 | `self`（只读约束） | 不给它实现过程，只给 manifest、命令和 PRD 条款；要求先复现再判定，发现问题写报告，不修代码 |
| WF-04 子模型搭建 | `self` | 每个任务包一个子代理；只给 C2 任务包和引擎 API；交回局部装配源 + 收据 |
| 生成示意图、说明书配图 | `image-generator` | 只用于文档展示，**不得**作为训练真值或视觉对账参考 |

注意事项：
- GPU 只有一块 6 GB 卡：同一时间只允许一个子代理跑训练或高显存推理，主会话负责排队。
- 子代理交回的"已完成"必须附命令和证据文件；主会话抽查后才能晋级状态。
- 长训练放后台任务，不要阻塞；不要把 CPU 上不可行的长训练无限挂起。

---

## 5. 红线（沿用 PRD，不得放宽）

- 不改验收门槛；失败后不改阈值、不换比较对象来制造提升。
- smoke、mock、教师/强模型 API 结果不能冒充小模型效果；自研从零小网不能冒充 VLM 基座微调。
- 引擎只证明物理合法；标签的目标一致性需要参考装配或原图核查证据。
- 60239 只做开发样例，不进泛化留出。
- 资源不足时继续完成可做部分，把缺口写清楚（例如"需要 ≥16 GB 显存的 GPU 才能跑 X"），不要伪造权重或无限挂起。
- 遵守 AGENTS.md 的零穿模、凸点扣合、SNOT 层级、四向正交对账规则。
