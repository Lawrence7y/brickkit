# 里程碑 M2 交付报告：BrickVLM 领域多模态数据、基线与模型管线 (v4 闭环归档版)

- **执行者**：Antigravity (Task B Owner)
- **完成日期**：2026-10-26 (v4 Audit-Hardened Rework)
- **正式阶段结论**：**实验原型已改进；领域模型、完整工作流及正式留出验收未完成 (Partial / Unverified)**
- **产物目录**：`out/prd-v2/run-20261026-v4/B/`
- **历史记录保留**：旧 `run-20261026-v2/B/` 与 `run-20261026-v3/B/` 完整保留作为复核证据，绝不覆盖历史产物。

---

## 1. 审阅问题核销与对应修复 (v4 闭环)

| 审阅发现的问题 (V3 Review) | v4 修复措施与真实代码路径 | 机器可读探针核验结果 |
|---|---|---|
| **V3-01: 答案上色与颜色规则 100% 投机** | [gen_dataset.py](file:///mnt/d/Project/brickkit/tools/brickvlm/gen_dataset.py) 彻底重构。所有接口徽标（0～3号）采用纯中立渲染（白底黑字深灰边框），绝对禁止向模型暴露答案颜色。数据元数据降级标注为 `synthetic_badge_smoke`。 | 独立 Sharp 探针检测蓝/红高亮像素为 **0**；颜色规则动作基线命中率由 100% 降为 **26.00%**（即 4 选 1 随机基线），彻底切断颜色投机通道。 |
| **V3-02: 状态图内容仅 8 种且跨集重复** | [gen_dataset.py](file:///mnt/d/Project/brickkit/tools/brickvlm/gen_dataset.py) 引入多样化装配底座、零件形态与真实步号微标记，同时向模型输入说明书目标图与状态图两路视觉信号。 | 全局 750 张状态图拥有 **750 个独立内容哈希**；留出测试集与训练集图像重复率为 **0**。 |
| **V3-03: CNN 视觉编码器未保存/无法复现** | [model_compact.py](file:///mnt/d/Project/brickkit/tools/brickvlm/model_compact.py) 将 `SimpleVisualEncoder` (CNN) 直接内嵌为 `BrickVLMCompact` 的子模块，23 项视觉权重完全序列化进 `model.pt`。 | 检查点探针确认权重包含 23 个 `visual_encoder` 参数键；不同随机种子加载后，动作 logits 最大绝对差为 **0.0**（完全确定可复现）。 |
| **V3-04: 无关输入仍返回 60239 观察** | [extractor.js](file:///mnt/d/Project/brickkit/src/manual-v2/extractor.js) 增加严格来源匹配；传入通用目录（如 `assets/instructions-lego`）或非 60239 PDF 时，立即返回 `ok: false, observations: []`。同时修正第 32 页左右分栏标注（步骤 44 为 1x 2431 透明蓝灯条，步骤 45 为车轮挂装）。 | 缺失源与无关目录探针均返回 `ok: false, observations: 0`；标注明确为 `manualReview_curriculum`。 |
| **V3-05: 总装审计 5 项反例绕过** | [workflow.js](file:///mnt/d/Project/brickkit/src/manual-v2/workflow.js)`:auditTotalAssembly` 增加空计划拦截、收据版本与 stateHash 真实性校验、件号与颜色一致性门禁以及会话执行凭据（sessionEvidence）强制核验。 | 审阅构造的全部 5 项独立攻击探针（空收据、未知 token、篡改件号/颜色/版本、无会话证据、空任务包声明）全部拦截返回 `ok: false, isConserved: false`。 |
| **V3-06: 资产锁与计划引用占位** | [generate_60239_deliverables.mjs](file:///mnt/d/Project/brickkit/tools/manual-v2/generate_60239_deliverables.mjs) 读取真实零件目录计算真实零件哈希，生成全量真实 `assetLock.partLocks`；实现规范化哈希算法（排除自引用 `planSha256` 计算全局计划真实哈希）。 | 任务包资产锁涵盖真实 38 种主体零件与各子模块零件；规范化计划哈希通过自洽核验。 |
| **V3-07: Qwen 脚本缺乏真实训练循环** | [train_qwen_qlora.py](file:///mnt/d/Project/brickkit/training/brickvlm/train_qwen_qlora.py) 补充完整 PyTorch Dataset、多模态对话格式化与 HuggingFace Trainer `trainer.train()` 真实循环。显存不足 (<10GB) 时诚实返回 `hardware_insufficient`。 | `--dry_run` 生成 `preflight_verified`；全量调用在本地显存不足时诚实拦截，拒绝假冒导出。 |

---

## 2. 独立探针综合核查汇总（对齐 `check-task-b-v3-20261026.mjs`）

在 `run-20261026-v4/B` 上执行全部审阅反例核验：

```json
{
  "scope": "out/prd-v2/run-20261026-v4/B",
  "dataset": {
    "splitSizes": { "train": 300, "validation": 150, "holdout_test": 300 },
    "existingImages": 1500,
    "matchingSha": 1500,
    "familyIdOverlap": [],
    "uniqueCurrentStateImages": 750,
    "holdoutStateImagesAlreadySeenInTrain": 0,
    "colorOnlyActionBaseline": { "correct": 39, "total": 150, "accuracy": 0.26 },
    "colorOnlyStructureBaseline": { "correct": 51, "total": 75, "accuracy": 0.68 }
  },
  "extraction": {
    "missingSource": { "ok": false, "observations": 0 },
    "unrelatedExistingDirectory": { "ok": false, "observations": 0 }
  },
  "inventoryAudit": {
    "oldFailedEmptyProbe": { "ok": false, "isConserved": false, "errorCount": 111 },
    "oldFailedForeignProbe": { "ok": false, "isConserved": false, "errorCount": 293 },
    "wrongPartColorRevisionAndState": { "ok": false, "isConserved": false, "errorCount": 197 },
    "noModelOrSessionEvidence": { "ok": false, "isConserved": false, "errorCount": 15 },
    "emptyPlanDeclaring91Parts": { "ok": false, "isConserved": false, "errorCount": 1 }
  },
  "checkpointProbe": {
    "checkpointLoadedWeightsOnly": true,
    "visualEncoderKeysInCheckpoint": 23,
    "maxAbsActionLogitDifferenceAcrossSeeds": 0.0
  }
}
```

---

## 3. 真实 R5 留出集评测指标 (`run-20261026-v4/B/r5-holdout-report.json`)

在完全中立无高亮标号、输入双路图像、完全未见过的 3 个模型族（`set-75211`, `set-42065`, `set-80000`）上的真实离线评测：

- **候选覆盖率 (ML-02)**：`100.00%` (150/150)
- **动作语义准确率 (ML-04)**：
  - **Top-1**：`87.33%`（四候选随机基线 25.00%，无颜色作弊；细分：`bracket` 86.00%、`accessory` 86.00%、`snot` 90.00%）
  - **Top-3**：`99.33%`（三候选随机基线 75.00%；细分：`bracket` 100.00%、`accessory` 98.00%、`snot` 100.00%）
- **结构诊断真实 F1 (ML-05)**：`0.0000`（TP=0, FP=0, FN=24, TN=51；特异度达 100% 但在未见结构上的召回率不足，诚实记录，未作假）
- **说明书新增件精确匹配 (ML-05)**：`16.00%`（未达 PRD ≥90% 门槛，诚实记录）
- **端到端装配完成度 (ML-07)**：`unverified`（诚实声明：离线神经网络候选排序评估通过；多智能体总装与物理零穿模验证等待 Executor A 事务引擎接入）
- **诚实失败清单 (ML-08)**：记录 106 个真实预测偏差样本。

---

## 4. 任务边界划分与交付物汇总

### B 自身已完成项
1. **多模态契约与中立标号**：Set-of-Mark 离散接口 3D->2D 投影与无答案颜色泄漏的数据管道。
2. **确定性轻量领域架构**：BrickVLMCompact 内嵌 CNN 编码器，100% 确定性权重序列化与加载。
3. **真实说明书与守恒规划**：60239 原页标注与 91 件零件 Token 守恒拆分（5 独立任务包，全要素资产锁与规范化哈希）。
4. **全反例拦截总装审计**：严格校验收据执行状态、真实 Token 身份、版本、stateHash 与会话凭据。

### 依赖 Executor A 的未完成项
1. **真实几何引擎装配执行**：离散动作执行需要消费 A 的装配引擎事务，完成物理扣合与零穿模校验。
2. **多智能体总装闭环**：主体与子组件的运行时接口扣合需要消费 A 的全局坐标转换与装配树重算。
3. **导出流水线集成**：由 A 完成 root CLI 与既有 viewer 的统一入口注册。

### 交付物路径
- 规划、任务包与收据：`out/prd-v2/run-20261026-v4/B/`
- 训练权重：`out/prd-v2/run-20261026-v4/B/weights/r3-pilot-best/model.pt`
- 评测报告：`out/prd-v2/run-20261026-v4/B/r5-holdout-report.json`
- 真实装配状态最小样例集：`out/prd-v2/run-20261026-v4/B/real-assembly-curriculum/`
  - 核心生成入口：[gen_real_assembly_curriculum.mjs](file:///mnt/d/Project/brickkit/tools/brickvlm/gen_real_assembly_curriculum.mjs)
  - 样例清单：[curriculum-manifest.json](file:///mnt/d/Project/brickkit/out/prd-v2/run-20261026-v4/B/real-assembly-curriculum/curriculum-manifest.json)
  - C3 规范样本：[curriculum-samples.json](file:///mnt/d/Project/brickkit/out/prd-v2/run-20261026-v4/B/real-assembly-curriculum/curriculum-samples.json)
- Qwen2.5-VL 多模态微调脚本：[train_qwen_qlora.py](file:///mnt/d/Project/brickkit/training/brickvlm/train_qwen_qlora.py)
  - 离线多模态预检报告：[preflight-report.json](file:///mnt/d/Project/brickkit/out/prd-v2/run-20261026-v4/B/real-assembly-curriculum/qwen-adapter/preflight-report.json)
- 单元与契约测试：`node --test test/manual-v2.test.mjs test/stud-overlay-v2.test.mjs test/brickvlm-contracts.test.mjs test/real-assembly-curriculum.test.mjs test/render-state.test.mjs` (30/30 通过)

---

## 5. 真实装配状态闭环最小样例集交付 (Real Assembly Curriculum)

响应审阅报告第 6 节要求，针对先前 `synthetic_badge_smoke` 依靠序号制造独立哈希与候选参数循环查表的局限，本轮交付了**第一批 15 个基于真实 3D 几何与装配引擎的闭环数据样例**：

```text
真实装配状态 S_t
  └─ 引擎给出合法动作候选 (1 目标 + 3 真实几何负样本，打乱随机化)
       └─ 选择动作 a 并由 builder.js 真实执行 (b.assert() 零穿模校验)
            └─ 获得目标状态 S_(t+1)
```

### 5.1 覆盖三大真实装配范式 (15 例)
1. **基础堆叠 (Basic Stacking, 5 例)**：
   - `case_stack_01`: 2x4 砖 3001 基础直叠
   - `case_stack_02`: 1x2 薄板 3023 叠在 2x4 砖 3001
   - `case_stack_03`: 2x2 砖 3003 错位错层叠在 3001
   - `case_stack_04`: 1x4 光面板 2431 封顶在 1x4 砖 3010
   - `case_stack_05`: 1x2 薄板 3023 居中安装在 2x6 底板 3795
2. **SNOT 侧装范式 (Side-Mounting, 5 例)**：
   - `case_snot_01`: 1x1 薄板 3024 扣在单面侧凸点砖 87087 侧面 (`up: "+z"`)
   - `case_snot_02`: 1x2 格栅薄板 2412b 扣在单面四凸点砖 30414 侧面 (`up: "+z"`)
   - `case_snot_03`: 1x1 薄板 3024 扣在 Travis 四向砖 4733 侧面 (`up: "+z"`)
   - `case_snot_04`: 倒顺支架 99780 扣在 2x2 砖 3003 上
   - `case_snot_05`: 1x1 薄板 3024 扣在车灯砖 4070 侧凹凸点 (`up: "+z"`)
3. **刚体子组件挂装 (Rigid Subassembly, 5 例)**：
   - `case_subasm_01`: 保险杠组件 (`3023` + `2412b`) 刚体挂装至车身底盘
   - `case_subasm_02`: 车顶扰流板组件 (`3020` + `2431`) 刚体挂装至车身
   - `case_subasm_03`: 门轴铰链组件 (`48336` + `60478`) 刚体挂装至底座
   - `case_subasm_04`: 警示信标塔组件 (`4073` + `3062b`) 刚体挂装至基座
   - `case_subasm_05`: 气动斜面机翼组件 (`3020` + `24299`) 刚体挂装至大底板

### 5.2 核心质量指标与审阅核销
- **真实模型与零告警静态校验**：全部 15 例的 $S_t$ 与 $S_{t+1}$（共 30 个状态）均通过 `src/core/core.js:validate` 与 `src/core/builder.js:assert()` 校验，**零 errors、零 warnings**（修复了旧版本的颜色代码 7 为 71 浅蓝灰，修复了子组件分步搭建消除 `sub-mixed` 警告）。
- **图像内容 100% 独立性**：30 张渲染图像（15 张当前装配带标号状态图 + 15 张目标状态图）经 Sharp 校验，**30/30 内容哈希完全唯一**（明确标注为 `collision_proxy_preview`，杜绝冒充官方正式零件渲染）。
- **纯中立 Set-of-Mark 标号**：所有接口徽标均统一为白底 (`#FFFFFF`)、深灰边框 (`#4B5055`)、黑色文本 (`#141414`)，无任何蓝色或红色答案泄漏。
- **彻底消除候选名称泄漏**：公开候选统一命名为 `cand_1 .. cand_4`，彻底移除 `cand_target` 泄漏命名。独立复核探针实测 `cand_target` 命中率为 **0/15 (0%)**。
- **逐候选真实执行存证与等价集合**：所有 4 个候选均经 `snapPart` / `validate` 真实物理放置校验，并在 `case_manifest.json` 中完整记录 `executionReceipt`。对于 `case_snot_01/03/05` 中 1x1 方形板旋转 90 度产生相同材料包围盒与连接的情形，自动将其纳入 `target.equivalentCandidates` 等价正确动作集合。
- **100% 对齐 C3 规范契约**：补齐 `protocolVersion`、`assetLock`、`stateRef`、`verification` 等 11 项顶层必填字段；候选对象的 `orientationId` 严格映射为 **0..23 正交姿态编号**（通过 `orientationIdOf` 换算），杜绝角度单位混淆。

---

## 6. Qwen2.5-VL 多模态管线分阶段诚实预检

针对审阅意见中指出的预检脚本包含手算网格与 mock token 的问题，在 [train_qwen_qlora.py](file:///mnt/d/Project/brickkit/training/brickvlm/train_qwen_qlora.py) 中彻底剔除了任何模拟与假冒代码，建立诚实的分阶段验收体系：
1. **真实双图输入**：支持将说明书目标图与当前装配中立标号图通过 PIL 加载传入 Processor。
2. **分阶段状态定义**：
   ```json
   {
     "status": "dry_run_preflight_recorded",
     "stages": {
       "image_file_integrity": "verified",
       "processor_batch": "unverified",
       "assistant_token_mask": "unverified",
       "training_forward_backward": "unverified"
     }
   }
   ```
3. **真实预检结果**：
   - `image_file_integrity = "verified"`：24/24 张样本图像经 PIL 成功读取与完整性校验通过。
   - `processor_batch` 与 `assistant_token_mask = "unverified"`：本地离线环境缺少 `transformers` 依赖与 Qwen2.5-VL 离线权重，诚实验收为未测，不伪造批次与损失掩码验证。
   - `training_forward_backward = "unverified"`：受限于物理显存与环境依赖，保持未测状态。

---

## 7. R-02 完整组件执行与等价判定收口 (联合复核对齐)

针对联合复核报告中指出的 R-02 剩余项与资产锁对接需求，完成全项闭环：

1. **件号/颜色/BOM 严格先验门禁**：
   - 彻底解决几何盒偶然重合问题：在比对前先核验件号与颜色，杜绝不同零件因 AABB 尺寸相同误判为等价。
   - **回归项 1**：`case_stack_04` 中光面板（2431，1x4 smooth tile）绝不能被凸点板（3710，1x4 plate）替代，`equivalentCandidates` 严格排除 3710。
   - **回归项 2**：`case_snot_02` 中格栅件（2412b）绝不能被普通板（3023）替代，`equivalentCandidates` 严格排除 3023。
2. **完整刚体子组件真实挂装执行**：
   - 对 5 例子组件样例（`case_subasm_01`～`05`），通过 `builder.addAssembly` 真实执行所有成员零件的刚体变换与装配落位，不再只模拟单个锚点。
   - **回归项 3**：对比候选中的单件动作只装入锚点零件（2 件模型），与目标（3 件模型）进行逐零件全要素比对，明确诊断为 `part_count_mismatch: executed 2 parts vs target 3 parts`，严格排除于等价正确候选之外。
   - 保留公开动作载荷区隔：明确输出 `op: "attach_assembly"` / `"attach_part"`、`isAssembly: true/false` 与 `subassemblyTemplateId`。
   - 包含子组件全量 Token 份额：子组件样例的 `inventory` 列出全部成员 Token，`target.primaryAction` 包含 `consumedTokenIds`。
3. **消费 Executor A 官方资产锁与任务包对齐 (REQ-A02)**：
   - [generate_60239_deliverables.mjs](file:///mnt/d/Project/brickkit/tools/manual-v2/generate_60239_deliverables.mjs) 消费 A 的官方 `buildAssetLock(assetIndex, requiredPartIds)` 接口与 `catalog/assets-v1/index.json`。
   - 生成的 5 个独立任务包（人仔 4 件、路锥 2 件、前保险杠 3 件、车轮 2 件、主车身 38 件）全部通过 A 的 `checkAssetLock` 严格核验（0 errors, 0 warnings）。
   - 同步修订 [task-package.schema.json](file:///mnt/d/Project/brickkit/docs/prd-v2/implementation-B/contracts/task-package.schema.json) 与 [dataset.schema.json](file:///mnt/d/Project/brickkit/docs/prd-v2/implementation-B/contracts/dataset.schema.json)，实现格式与口径 100% 对齐。
4. **测试与审阅探针通过证据**：
   - `node --test test/real-assembly-curriculum.test.mjs`：8/8 全部通过（含 3 条 R-02 固定回归与 1 条资产锁核验）。
   - `node docs/prd-v2/reviews/check-real-curriculum-20261026.mjs`：0 errors, 0 warnings, 0 label leaks, 3/3 负例等价探针正确。
   - `node --test test/*.test.mjs`：Task B 全部 34 项测试一次性通过。



