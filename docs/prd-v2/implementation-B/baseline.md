# Task B 启动基线报告 (B0 Baseline)

- **执行者**：Antigravity (Task B Owner)
- **基线日期**：2026-10-26
- **Git HEAD**：`47f02a57886aacbe809732f1f9abbde51c09eb19` (branch: `main`)
- **工作区路径**：`/mnt/d/Project/brickkit` (WSL2 / Linux)

---

## 1. 现有代码库与工作树快照盘点

### 1.1 关键目录与未提交/未跟踪资产状态
工作树包含大量由用户和执行者 A/前序工作留下的未提交和未跟踪实现：
- **核心与引擎**：
  - `src/core/core.js`：核心装配数据结构、`validate` 校验器（已包含连通块分析与零件碰撞）。
  - `src/core/builder.js`：基于流式/链式调用的拼装构建器 `createBuilder`（包含穿模检测、编号递增、snapPart）。
  - `src/core/diff.js`（由 B 拥有）：视觉对账算法（已支持 `extractManualMask`、`gridStructureSim`、`shiftedIoU`、`scorePair(kind: 'manual')` 等）。
  - `src/core/observations.js`：观察清单与模型 BOM 对账模块。
- **说明书工具**：
  - `tools/manual-pages.mjs`：基于 pdfjs-dist legacy + canvas 的说明书 PDF 光栅化及初步分类工具。
  - `tools/extract-plan.mjs`：蓝图生成与零件守恒校验守门员。
  - `tools/manual-mask-probe.mjs`：说明书前景掩膜探针。
- **现有测试套件**：
  - `test/diff.test.mjs`：26 个视觉算法测试全部通过（459ms）。
  - `test/engine-v2.test.mjs`：48 个引擎功能测试全部通过（4459ms）。
  - `test/observations.test.mjs`：7 个观察对账测试全部通过（11ms）。
  - `test/plan.test.mjs`：21 个蓝图与守恒测试全部通过（1650ms）。
  - `test/ext-connectors.test.mjs`：42 项测试中 41 项通过，1 项失败（`mecha 零件数 83 !== 99`：注释表明为 11211 零件高度硬冲突修复后垫板重建的待合入变动，属 A 负责的目录与历史模型范畴，B 不越权修改）。

---

## 2. 60239 事实与推定区分 (Distinguishing Facts vs. Assumptions)

### 2.1 原始事实（Ground-Truth from Official PDF `6283855.pdf`）
经对官方说明书原始文本层与页面光栅图的严格提取，确认以下权威事实：
1. **总页数**：共 36 页。
   - 第 1 页：封面。
   - 第 2 页：人仔独立拼装步骤（步骤 1～4），共 4 件（腿部 73200、躯干 76382、头部 3626b、警察帽 11303）。
   - 第 3 页：人仔配件（2 个路障雪糕筒，步骤 1～3），共 4 件（2x 4740 橙色圆盘 + 2x 59900 橙/白圆锥）。
   - 第 4 页～第 32 页：警察巡逻车主体拼装（从底盘步骤 1 到整车步骤 45，含第 32 页的 4 个车轮子组件 ×4 挂装）。共 83 件。
   - 第 33 页：成品展示与场景玩法。
   - 第 34 页：LEGO Life App 互动说明。
   - 第 35 页：**官方零件清单页（Authoritative Elements BOM）**。
   - 第 36 页：封底问卷。
2. **官方 BOM 数量核准（彻底澄清 92 vs 91 疑点）**：
   - 提取说明书第 35 页全部 52 行条目：
     - `∑ qty` **精确等于 91 件**。
     - 其中车体零件 83 件 + 人仔零件 4 件 + 路障配件 4 件 = 91 件。
   - Brickset 页面自述 Pieces 字段为 92，因第三方网站将备用散件（spare part 1x）或特定整件打包计入了 92。
   - **结论**：本项目的官方拼装权威使用件数为 **91 件**（车体 83 件，配件 8 件）。

### 2.2 现有 `examples/60239.brick.json` 与 `60239.plan.json` 的推定与缺陷
1. **历史 plan 的来源是反推与推定**：
   - `examples/60239.plan.json` 是通过 `tools/extract-plan.mjs` 从 `examples/60239.brick.json` 反向导出的。
   - 历史 plan 将所有步骤硬塞入一个名为 `main` 的单一子模型中。
   - 页码标注为 `pageConfidence: "assumed"`（按 40 步平摊到 36 页，非真实页码）。
   - 视角标注为 `cameraConfidence: "default"`（一律写为 `az: 315, el: 25`），没有任何实测证据。
2. **现有 60239 模型的物理与结构严重失效**：
   运行 `node cli/brickkit.mjs validate examples/60239.brick.json` 结果：
   - `ok: false`
   - `errors`: 6 项硬错误：
     - 3 处 3D 穿模重叠：`p002 与 p003` (12, 1, 5)、`p003 与 p022` (11, 2, 5)、`p004 与 p005` (12, 1, 8)。
     - 2 处挂装断连：`p003 与 p002` 无物理连接、`p005 与 p004` 无物理连接。
     - 1 处严重悬空：`floating: 63 个零件没有连到底座`。
   - `warnings`: 17 处 `step-order` 支撑倒挂警告。
   - `connectedComponents`: 36 个分离连通块，最大连通块占比仅 0.307692。
3. **结论**：
   现有的 `examples/60239.brick.json` 是严重损坏的模型，绝对不能作为说明书提取或动作训练的真值。必须从说明书原页出发，重新构建独立的 `manual.observations.json` 与 C2 任务包。

---

## 3. 说明书素材与模型族划分（防数据泄漏设计）

根据 PRD 10.6，必须按模型族级划分开发集与留出测试集，禁止跨 split 泄漏：

| 集合类别 | 套装编号 | 套装名称 | 分册/页数 | 作用定位 |
|---|---|---|---|---|
| **开发与调试样例** | `60239-1` | City 警察巡逻车 | 36p | 端到端工作流调优与试装开发（**禁止充当留出测试**） |
| **训练与微调集 (Train)** | `31058-1` (Book 1) | Creator 威猛恐龙 (霸王龙) | 48p | 复杂 SNOT、铰链关节、组件挂装 |
| **训练与微调集 (Train)** | `10715-1` | Classic 基础齿轮轮组 | 48p | 基础堆叠、轮轴与销连接、颜色辨识 |
| **训练与微调集 (Train)** | `70615-1` | Ninjago 火焰机甲 | 164p | 大跨度骨架、对称异形件、局部反向安装 |
| **开发验证集 (Validation)** | `31062-1` (Book 1) | Creator 机械探险者 (机器人) | 56p | 模块化结构、履带/关节、调优超参与阈值 |
| **严格留出测试集 (Holdout Test 1)** | `31058-1` (Book 2/3) | Creator 翼龙 / 三角龙 | 28p / 24p | 3-in-1 未见同构模型，测试组件独立理解 |
| **严格留出测试集 (Holdout Test 2)** | `75211-1` | Star Wars 帝国 TIE 战机 | 136p | 对称大面积机翼挂装、深色件与特殊倒角 |
| **严格留出测试集 (Holdout Test 3)** | `42065-1` | Technic 遥控履带赛车 | 100p | 纯科技销梁结构、不同零件族泛化能力 |

---

## 4. 下一步行动 (Phase B1 / B2 / B3)
1. 提交 `resource-preflight.md`，明确真实硬件瓶颈与 R0 方案。
2. 固化 `contracts/` 下的观察 Schema、任务包 C2 Schema、数据集 C3 Schema。
3. 向执行者 A 提出 C1 接口需求请求 `requests-to-A/REQ-B01-C1-contracts.md`。
4. 编写 `src/viewer/stud-overlay-v2.js` 接口标号独立模块。
5. 生成基于官方原页的 `60239.manual.observations.json` 与 C2 任务分包。
