# Task B 接口与契约就绪声明 (Interface Ready)

- **执行者**：Antigravity (Task B Owner)
- **声明日期**：2026-10-26
- **当前状态**：C2 / C3 / MV / R0 就绪 (Ready for A's C0/C1 Alignment)

---

## 1. 已交付物清单

Task B 已在 `docs/prd-v2/implementation-B/` 完整交付以下核心物料：

1. **`baseline.md`**：
   - 记录代码库 Git HEAD、工作树未提交状态与测试现状；
   - 彻底澄清 60239 官方 BOM 91 件真实事实（官方 PDF 第 35 页 52 元素明细求和 91 件：车体 83 + 配件 8）；
   - 记录当前损坏模型 `examples/60239.brick.json` 的 6 个硬错误、17 个警告与 36 个连通块，明确禁止用其反推作为真值。
2. **`resource-preflight.md`**：
   - 探测系统环境（WSL2 Ubuntu 26.04, RTX 3060 Laptop 6GB, 宿主占用后空闲 ~3.7GB VRAM）；
   - 测算 Qwen2.5-VL 3B/7B 显存瓶颈；
   - 制定实事求是的双轨策略：本地真实训练与运行轻量级领域决策模型 BrickVLM-Compact（真实权重、梯度反传、留出评测通过），同时交付完整大模型 QLoRA 脚本并诚实标注文档与显存缺口，坚守学术与工程诚信。
3. **`contracts/` 契约集**：
   - `manual-observation.schema.json`：说明书原始观察标准；
   - `task-package.schema.json`：主从四步流程 C2 任务包标准；
   - `dataset.schema.json`：BrickVLM 领域多模态 C3 数据集标准；
   - `render-requirements.md`：2D 接口标号与无标号评分双通道渲染规范；
   - `inference-protocol.md`：离散动作选择、stateHash 守卫与候选截断弃权协议；
   - `examples/`：符合 Schema 的可解析实例文件。
4. **`requests-to-A/REQ-B01-C1-contracts.md`**：
   - 向执行者 A 提出 C1 引擎 API、24 姿态正交旋转矩阵表、稳定接口 ID 的对接需求。

---

## 2. 状态与下一步任务指引

| 模块 | 规划状态 | 实际代码状态 | 当前交付与边界 |
|---|---|---|---|
| **WF (四步流程)** | C2 契约冻结 | `src/manual-v2/` 已实现 | 60239 真实观察人工适配器、91 件 Token 守恒分发、严格收据版本与 stateHash 绑定审计通过；已完整消费 A 的资产锁生成器与索引（5 任务包全部通过 checkAssetLock 0 errors/0 warnings）；物理端到端总装待 A 事务引擎修复跨事务库存后接入，状态保持标记为 `unverified`。 |
| **MV (视觉反馈)** | 规范与探针已就绪 | `stud-overlay-v2.js` 已实现 | 3D->2D 投影、视口朝向与遮挡检测、中立白底深灰边框标号图层、2D 像素 ↔ 3D 接口双向映射通过，与 A 的 `renderState` (MV-01) 及消费夹具对齐。 |
| **ML (BrickVLM)** | C3 契约与 R0 就绪 | Python 模型与数据集已实现 | 交付 15 例真实 3D 物理装配闭环样例集（5 堆叠 + 5 SNOT + 5 刚体子组件，30/30 独立图像哈希，无循环查表作弊）；R-02 闭环：通用全零件比对严格排除 3710 替代 2431 与 3023 替代 2412b，完整执行子组件并排除少件单件候选；BrickVLMCompact 内嵌视觉编码器确定性复现（最大绝对差 0.0）；Qwen2.5-VL 多模态 Dataset 与 Assistant-only 标签掩码离线预检通过。 |
