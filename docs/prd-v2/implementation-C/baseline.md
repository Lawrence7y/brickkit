# C 接管基线（baseline.md）

日期：2026-10-26 23:40–24:00。执行者：C（唯一执行会话）。run-id：`run-20261026-c`。

## 仓库状态
- HEAD：`47f02a57886aacbe809732f1f9abbde51c09eb19`（2026-10-24 21:23 +0800，"Fix Step 7 front/back energy column SNOT connection…"）。仓库共 12 个提交，PRD v2 的全部 A/B 工作均为未提交工作树状态。
- 工作树：18 个已跟踪文件修改 + ~50 个未跟踪新文件 + 14 个未跟踪目录（`src/core/{actions-v1,assembly-v1,assets-v1}`、`src/ldraw`、`src/manual-v2`、`tools/brickvlm`、`training/`、`catalog/{assets-v1,ldraw}`、`docs/prd-v2` 等）。按 HANDOFF-C 规则 5 不做 reset/clean，历史产物只读。

## 关键哈希（sha256 前 16 位）
| 文件 | 哈希 |
|---|---|
| catalog/parts.json | `9394499144642881` |
| catalog/colors.json | `4652bcf5a0b385f5` |
| src/core/core.js | `3de52d202f603a14` |
| src/core/builder.js | `1f73ec180ff5922b` |
| src/core/actions-v1/apply.js | `05b6488fa918a49a`（C0 复核时点） |
| src/manual-v2/workflow.js | `27f563e23555ba0b`（C0-4 修改前；修改后见 c0-4-evidence.json） |

## 测试（两平台）
- **Windows（Python 3.12.10 / node）**：`node --test --test-reporter=dot test/*.test.mjs` → C0-2 独立复核与本会话基线跑均为 **250/250 通过、退出 0**（C0-4 修改后为 **261/261**，见 out/prd-v2/run-20261026-c/C/receipts/c0-4-evidence.json）。
- **WSL（Ubuntu, WSL2）**：`npm test` → **3 个失败**，全部为 `extractManualMask 合成页真值 IoU ≥ 0.90` 系列（121/122/123 号测试；`@napi-rs/canvas` 为 Windows 二进制，WSL 下渲染结果不同）。按 HANDOFF-C 规则 6 仅作记录，不为此改根 lock；引擎/模型测试统一以 Windows 结果为准。

## C0 阶段结论（2026-10-26 深夜）
- **C0-2 只读复核：4/4 PASS**（A-INV-01 库存持久化、detach/replace 14/14、正交投影 maxDeltaPx 0.0005、资产锁消费 4/2/3/2/38 全过）。报告：docs/prd-v2/reviews/C0-2-a-fixes-review-20261026.md（含"同一模型不同会话复核≠跨 Harness 复核"声明）。
- **C0-4 收据门禁：已修复**。v4 两条反例（伪造 revision/stateHash 收据、BOM 声明 999 vs 实配 91）现分别被 `RECEIPT_REVISION_MISMATCH`/`RECEIPT_STATEHASH_*` 与 `PLAN_BOM_TOTAL_MISMATCH` 拒绝；新增 11 测试；证据 out/prd-v2/run-20261026-c/C/receipts/c0-4-evidence.json。
- **C0-3 契约合并：进行中** → docs/prd-v2/implementation-C/contracts/（完成后 frozen:true + 哈希；见该目录 version.json 为准）。

## 资源与环境（C2 预检，详见 out/prd-v2/run-20261026-c/C/env/env-report.md）
- GPU：RTX 3060 Laptop 6GB；torch.cuda.mem_get_info 空闲 5.01GiB（WDDM 下 nvidia-smi 口径 ~3.5–3.7GiB 可用）。
- 已装：transformers 4.56.2 / peft 0.21.2 / accelerate 1.15.0 / datasets 5.0.1 / bitsandbytes 0.50.2（Windows 原生轮，CUDA 4-bit 实测 OK）/ qwen-vl-utils 0.0.14。
- HF 直连可达；带宽 ~1.1 MB/s（4.4GB 模型约 60–75 分钟预取）。
- 合成 QLoRA 探针（1.26B 代理，seq=1024）：峰值 3292MiB，无 OOM。**Qwen2-VL-2B QLoRA 判定为"条件性可行"**（frozen vision tower、seq≤512、NF4+8bit 优化器、监控 WDDM 回退），7B 不可行。

## 遗留缺口快照（接管时点）
- 契约：0.9.0-draft / frozen:false（C0-3 合并中）。
- 60239：examples 原版 91 件 9 errors/17 warnings；A 推进副本 5 errors（4 overlap + 63 件 floating 组）；EX-01/EX-02 failed。
- BrickVLM：仅 smoke 数据（1500 图/8 种唯一）+ 从零 BrickVLMCompact（3.1M 参数，不能冒充基座微调）；15 对真实装配课程（R-02 已关闭）；Qwen QLoRA Trainer 从未真跑（预检时 transformers 未装）；R1 基线未冻结；R4/RL 未开始。
