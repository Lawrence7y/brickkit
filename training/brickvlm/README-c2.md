# BrickVLM QLoRA 训练入口（C2 交付 · README-c2.md）

本目录是 PRD v2 BrickVLM 线的真实像素 QLoRA 训练实现（C2-1 基座选择 + C2-2 数据路径修复的产物）。
R3 全量 SFT 由主会话按本 README 的命令与 GPU 队列纪律执行。

## 1. 文件

| 文件 | 职责 |
|---|---|
| `brickvlm_data.py` | 数据适配层：四类真实数据源 → 真实像素 → processor → 真实 `pixel_values`/`image_grid_thw`；assistant-only labels（前缀强校验 + decode 往返校验）；多模态 collator（Qwen2-VL patch 维拼接约定）；`assert_no_simulated` 红线断言 |
| `brickvlm_qlora.py` | QLoRA 权威实现：NF4+double quant+bf16；视觉塔冻结（动态内省 + 0 泄漏断言）；LoRA r=16 仅 LLM 7 类线性层；梯度检查点 + `model.train()`（eval-mode 陷阱见下）；sliced assistant-only CE；VRAM 门禁 |
| `train_qwen_qlora.py` | 训练入口（v5）：`--dry_run` / `--overfit N --max_steps M` / 全量 SFT；逐步 JSONL 日志 + 证据 JSON + 数据文件 SHA-256 |
| `requirements.txt` | 实测通过的确切版本（torch 2.5.1+cu121 / transformers 4.56.2 / peft 0.21.2 / bitsandbytes 0.50.2 …） |

## 2. 基座（C2-1 结论，详见 `out/prd-v2/run-20261026-c/C/env/c2-1-base-selection.md`）

- **PICK：Qwen2-VL-2B-Instruct**（本地 `out/prd-v2/run-20261026-c/C/models/qwen2-vl-2b-instruct`，Apache-2.0）。
  实测：448px 双图单批 reserved 2.154 GiB（最坏任务 seq 1389 → 2.334 GiB），稳态步时 1.48–2.10 s，门禁 3.4 GiB 内余量健康。
- 已验证 fallback：InternVL3-1B-hf（`.../models/internvl3-1b-hf`，reserved 1.262 GiB，步时 0.76 s；注意其 processor 忽略 `max_pixels`、无 `image_grid_thw`）。

## 3. 命令

一切命令在仓库根 `D:\Project\brickkit` 下执行；**GPU 队列纪律：同一时间只允许一个训练/高显存推理进程**（渲染、viewer、评测必须排队）。

### 3.1 数据路径验证（C2-2 证据，已完成，可随时复跑）

```bash
python training/brickvlm/train_qwen_qlora.py --dry_run \
  --evidence_out out/prd-v2/run-20261026-c/C/logs/c2-2-datapath-verification.json \
  --log_out out/prd-v2/run-20261026-c/C/logs/c2-2-datapath-verification.jsonl
```
内容：16 个真实样本（select_action 6 / understand_structure 4 / repair_local 3 / understand_step 3）真实像素编码 + decode 往返校验（前 3 条）+ 1 次 forward/backward。预期 `status: "ok"`、`backward_success: true`、`loss_finite: true`、峰值 reserved ≈ 2.1 GiB。

### 3.2 Overfit sanity（管线自检，≤10 步，不得当训练成果）

```bash
python training/brickvlm/train_qwen_qlora.py --overfit 8 --max_steps 10 \
  --evidence_out out/prd-v2/run-20261026-c/C/logs/c2-2-overfit-sanity.json \
  --log_out out/prd-v2/run-20261026-c/C/logs/c2-2-overfit-sanity.jsonl
```
8 个混合任务真实样本重复 10 步，`loss_decreased` 必须为 true。

### 3.3 R3 全量 SFT（主会话执行；预计时长见 §5）

```bash
python training/brickvlm/train_qwen_qlora.py \
  --model_dir out/prd-v2/run-20261026-c/C/models/qwen2-vl-2b-instruct \
  --data_root out/prd-v2/run-20261026-c/C/data \
  --tasks select_action understand_structure repair_local understand_step \
  --max_pixels 448 --lora_r 16 --lr 1e-4 --warmup_steps 50 --grad_accum 8 \
  --max_steps 6000 \
  --output_dir out/prd-v2/run-20261026-c/C/weights/qwen2vl-2b-qlora-r3 \
  --evidence_out out/prd-v2/run-20261026-c/C/logs/r3-sft-evidence.json \
  --log_out out/prd-v2/run-20261026-c/C/logs/r3-sft-steps.jsonl \
  --log_every 20
```

- `--max_steps 6000` ≈ 数据集（4,920 样本）1.2 epoch；先跑 1 epoch（≈5,000 步）看验证曲线再续。
- 产物：`weights/qwen2vl-2b-qlora-r3/adapter-final/`（PEFT adapter，仅 ~74MB fp32）+ 证据 JSON（含全部被消费样本文件的 SHA-256）+ 逐步 JSONL。
- **启动前自查**：`nvidia-smi` 无其他计算进程；桌面显存占用未恶化（CUDA free ≥5 GiB）。
- **中途失败形态**：exit 3 = `hardware_insufficient`（reserved > 3.4 GiB，证据 JSON 有记录）——先清桌面/壁纸引擎显存再重跑，不要调门禁阈值。
- 评测（R1 零样本基线、R5 留出）另用冻结提示协议，不在此命令范围。

### 3.4 单任务小样本试跑（可选）

```bash
python training/brickvlm/train_qwen_qlora.py --tasks select_action --per_task_limit 200 --max_steps 200 --grad_accum 4 --output_dir out/prd-v2/run-20261026-c/C/weights/qwen2vl-2b-qlora-smoke --evidence_out out/prd-v2/run-20261026-c/C/logs/smoke-sft.json --log_out out/prd-v2/run-20261026-c/C/logs/smoke-sft.jsonl
```

## 4. 本脚本消费的数据（哈希）

| 数据源 | manifest SHA-256 | 样本数 |
|---|---|---|
| `out/prd-v2/run-20261026-c/C/data/trajectory`（select_action） | `f671f550b978229c0d51615783cc4629cf27e0cb8bf866b5d4abed57e17a29cb` | 2,225 |
| `out/prd-v2/run-20261026-c/C/data/perturbation`（understand_structure + repair_local） | `acbccba7581383558f4ac7585d27b550d87c419720fcaa3a1958814719c1db0f` | 1,248 + 1,248 |
| `out/prd-v2/run-20261026-c/C/data/manual`（understand_step） | `e164c48258b9908196dae4946c7344772519f84eca718f9e66bbf3ef9f3b824c` | 199 |

合计 4,920 样本、225 个样本集合文件。每次训练运行的证据 JSON `consumed_files` 字段记录实际读到的每个样本文件的 SHA-256（图像 SHA-256 与 manifest 逐张对账，不符即报错跳过并计数）。

## 5. 预计时长（实测外推）

- 稳态单步（batch=1，双图 448px）：select_action 1.48 s、understand_structure 2.10 s；全任务混合 + 惰性编码开销 ≈ **2.5 s/步**。
- R3 一轮（4,920 步）≈ **3.5–4 小时**；6000 步 ≈ 4.5 小时。建议夜间执行，日志每 20 步落盘，可随时核对 `reserved_gib` 是否贴近 2.1–2.4 GiB 区间（显著超出=桌面显存被挤占，立即排查而不是硬扛）。
- 梯度检查点开启（必须）；关掉它显存会到 7.5 GiB（WDDM sysmem fallback，步时 ×15）。

## 6. 红线（勿在此目录违反）

1. 不得出现任何 `simulated` 键/值（`assert_no_simulated` 会抛错）。
2. 标签只来自样本 `target`/`groundTruth` 字段（结构真值由真实重放/结构 diff 导出），不得引入生成公式。
3. 门禁阈值 3.4 GiB 不许改代码绕过；资源不足就如实 `hardware_insufficient`。
4. smoke/overfit 结果不得在 ML-03/ML-06/ML-07 验收中冒充 SFT 训练成果。
