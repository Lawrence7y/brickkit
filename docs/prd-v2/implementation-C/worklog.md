# BrickKit PRD v2 · 执行者 C 工作日志（进度台账）

日期：2026-10-26 23:40 → 2026-10-27。执行者：C（唯一执行会话 + 子代理）。
本文件记录每个里程碑的**实际状态**（不夸大），供最终报告与后续接手者核对。

状态词表沿用 PRD §16.3：`not-started / implemented / unverified / verified / partial / failed / unavailable`

---

## C0 盘点与契约冻结

| 项 | 状态 | 证据 |
|---|---|---|
| C0-1 基线（HEAD 47f02a5、工作树、关键哈希、两平台测试） | verified | `docs/prd-v2/implementation-C/baseline.md`；Windows 250/250（后续 261/275），WSL 3 个 canvas 渲染测试失败（平台差异，已记录） |
| C0-2 复核 A 四项修复（库存持久化 / detach-replace / 正交投影 / 锁消费） | verified | `docs/prd-v2/reviews/C0-2-a-fixes-review-20261026.md`：4/4 PASS，独立复跑 |
| C0-3 契约合并冻结 `contracts-1.0` | verified | `docs/prd-v2/implementation-C/contracts/version.json`（frozen:true）；`validate-contracts-1.0.mjs` → FROZEN-VALID；含 CP-02 后重冻结（engineRevision 88b51e19→85ad1710） |
| C0-4 收据门禁（v4 两条反例） | verified | `out/prd-v2/run-20261026-c/C/receipts/c0-4-evidence.json`；261/261 测试；两条反例分别被 `RECEIPT_REVISION_MISMATCH`/`PLAN_BOM_TOTAL_MISMATCH` 拒绝 |

## C1 BrickVLM 真实数据工厂

| 项 | 状态 | 实际数量 / 证据 |
|---|---|---|
| C1-1/2 轨迹数据（select_action） | verified（pilot 规模） | 2,225 去重样本、5,271 张图、14 家族；**240/240 重放与存储 stateHash 100% 一致**；`data/trajectory/manifest.json` |
| C1-3 扰动/修复数据 | verified | 2,496 样本（US 1,248 + RL 1,248）、6 家族；**1,248/1,248 修复重放回到参考 stateHash**；`data/perturbation/manifest.json` |
| C1-4 真实说明书步骤 | **partial（pilot）** | 199 verified（dev 33 / train 107 / holdout 59）；PRD 目标 ≥200 训练 + ≥100 留出 → **未达标**（107/59）；75211 扫描版整套排除、31058-b2/31062-b1/b2 无总览页排除；`data/manual/manifest.json` |
| C1-5 划分与防泄漏 | verified | 冻结于 2026-10-26T21:27:32Z（早于任何训练）；留出 827 条 / 7 个未见家族；捷径探针全部 ≤ 随机（0 泄漏）；`data/splits/split-manifest.json` |

**对照 PRD 数据门槛（如实）**
- ≥5,000 去重合法/修复状态：实际 3,473 唯一 stateHash → **未达标**
- ≥200 核查过的真实说明书训练步：实际 107 → **未达标**
- 留出 ≥300 案例：827 ✓；≥3 个未见模型族：7 ✓；≥100 真实说明书留出步：59 → **未达标**

## C2 基座、基线与真实微调

| 项 | 状态 | 证据 |
|---|---|---|
| C2-1 基座选型 | verified | Qwen2-VL-2B-Instruct（Apache-2.0），448px 双图单批 reserved 2.154GiB / 步时 1.48s；InternVL3-1B-hf 为已验证 fallback；`C/env/c2-1-base-selection.md` |
| C2-2 真实像素数据路径 | verified | 0 simulated 字段；真实 image_grid_thw；assistant-only 掩码 decode 往返校验；`C/logs/c2-2-datapath-verification.json` |
| C2-3 R1 零样本基线 | 见下（训练后执行） | `training/brickvlm/evaluate_r1_zero_shot.py` |
| C2-4 R3 SFT（QLoRA） | 见下 | 训练入口 `training/brickvlm/train_qwen_qlora.py`（已加周期性 checkpoint） |
| C2-5 BrickVLMCompact 对照 | 见下 | 复用 `tools/brickvlm/train_r3_pilot.py`，数据换为本 run 的真实集 |

## C3 引擎补完与 60239

| 项 | 状态 | 证据 |
|---|---|---|
| C3-1 BOM 口径 + 40+ 步观察 | verified | 权威 91 件（83 主体 + 4 人仔 + 4 锥）；92 为盒装含备用件口径；48 条观察（46 官方步 + 2 预组）；`integration/60239/bom-caliber.json`、`observations-all-steps.json` |
| C3-2 60239 严格校验 0/0 | verified | 全量重建（非补丁），91 件 0 errors / 0 warnings；`validate-report.json` |
| C3-3 四步工作流（WF-03/WF-04） | verified | 港口吊机 66 件：主体 30（主会话）+ SA-1 24 + SA-2 12（两个真实子代理会话）；总装 0 errors / 0 warnings / 单一连通组件；三份收据严格审计 `ok:true, isConserved:true, receiptBinding:verified` |
| C3-4 引擎六项遗留 | verified | ST-04 / AS-05 / AS-06 / EN-04 / EN-05 / CP-02 全 verified；275/275 测试；CP-02 提速 14–18× 且输出逐字节不变 |
| C3-5 MV-02 掩膜（≥30 区域、IoU≥0.90） | 未作为本 run 主攻 | 继承既有 `src/manual-v2/extractor` 与 v4 证据；本 run 未新做 30 区域人工标注 |
| C3-6 60239 视觉对账 | **partial** | 四向正交渲染完成；成品 diff **0.5315 < 0.60 门槛**（IoU 0.427 / 颜色 0.932 / 结构 0.132）；高于历史基线 0.4937，但未达标；参考素材为官方说明书封面插画而非实拍 |

## C4 集成

| 项 | 状态 | 证据 |
|---|---|---|
| C4-1 推理服务 | implemented（待接线验证） | `brickvlm/serve.py`：stdio/HTTP 双模式，响应携带 base/baseRevision/adapterRevision/protocolVersion/stateHash/abstain |
| C4-2 闭环（理解→候选→选动作→applyActions→校验→渲染→修复） | 见下 | 依赖 C4-1 与训练产物 |
| C4-3 导出（viewer/booklet/MPD） | 见下 | |

## C5 留出验收与最终报告

见 `final-report.md`（最终答复 PRD §16.3 五个固定问题）。
