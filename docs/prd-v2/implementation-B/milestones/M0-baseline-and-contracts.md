# 里程碑 M0 交付报告：基线、契约与资源预检

- **执行者**：Antigravity (Task B Owner)
- **完成日期**：2026-10-26
- **里程碑状态**：Verified & Completed

---

## 1. 交付目标达成情况

| 编号 | PRD 规范要求 | 交付产物与验证状态 |
|---|---|---|
| **B0-01** | 工作树盘点与事实/推定区分 | `docs/prd-v2/implementation-B/baseline.md` 已交付。彻底澄清 60239 官方 BOM 为 91 件（说明书第 35 页 52 元素求和精确等于 91 件：车体 83 + 配件 8）。指出旧 plan 来源为反推假象与损坏模型。 |
| **B0-02** | 训练资源探测与 R0 计划 | `docs/prd-v2/implementation-B/resource-preflight.md` 已交付。实测 RTX 3060 Laptop (可用 3.7GB VRAM)，测算 Qwen2.5-VL 显存瓶颈，确立双轨方案：本地运行轻量 BrickVLM-Compact (真实权重/训练/评测)，大模型 Qwen2.5-VL 脚本待高显存主机执行，坚守学术诚信。 |
| **B0-03** | 观察与任务协议契约 | `contracts/manual-observation.schema.json`、`contracts/task-package.schema.json` (C2)、`contracts/dataset.schema.json` (C3) 均已冻结交付。附带完整有效实例。 |
| **B0-04** | 视觉反馈与标号需求 | `contracts/render-requirements.md` 已交付。确立带标号理解图与无标号评分图的双通道分离红线，防止标号混入 diff。 |
| **B0-05** | 向执行者 A 提出契约需求 | `requests-to-A/REQ-B01-C1-contracts.md` 已提交。对齐候选枚举 `enumerateCandidates`、事务执行 `applyActions`、24 姿态表与稳定接口 ID 规范。 |
