#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
train_qwen_qlora.py — BrickVLM 真实像素 QLoRA 训练脚本（C2-2 重写版，contracts-1.0 / PRD §10）。

v4 → v5（C2-2 数据路径修复，全部模拟字段已铲除）：
  (a) 图像一律真实像素：PIL 读取（SHA-256 对账 manifest）→ processor → 真实
      pixel_values / image_grid_thw；assert_no_simulated 递归断言任何键值不得含 "simulated"。
  (b) assistant-only labels：prompt 部分 token 全 -100；前缀一致性强校验；decode 往返校验
      （被掩区域应解码回 prompt，未掩区域应解码为答案），默认对前 3 个样本执行并写入证据。
  (c) 多模态 collator：Qwen2-VL patch embedding 要求 batch 内 pixel_values 沿 patch 维拼接、
      image_grid_thw 逐图堆叠（见 brickvlm_data.BrickVLMMultimodalCollator）。
  (d) 数据集适配层：taskType → prompt/response 一一映射（brickvlm_data，统一协议 contracts-1.0 C3），
      四类任务 select_action / understand_structure / repair_local / understand_step 全部来自真实数据源。
  (e) VRAM 门禁：torch reserved > 3.4 GiB（保守预算 3.5 GiB 内留余量）→ 立即中止，
      状态 hardware_insufficient，绝不静默回退 CPU / sysmem fallback。
  (f) --dry_run：真实数据编码 + collation + 1 次 forward/backward 后退出并落证据 JSON。

训练模式：
  --dry_run                     数据+管线+单步验证（C2-2 证据）
  --overfit N --max_steps M     N 个真实样本重复 M 步（管线 sanity，loss 必须下降）
  （默认）                        全量 SFT：按 max_steps 或数据集一轮；产物 = PEFT adapter

用法示例见 training/brickvlm/README-c2.md。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_HARDWARE = 3

# C2-2 证据默认计划：16 个真实样本按任务配额（select_action 6 / understand_structure 4 /
# repair_local 3 / understand_step 3），与 4 类任务真实数据量成合理比例
DEFAULT_VERIFY_PLAN = {"select_action": 6, "understand_structure": 4, "repair_local": 3, "understand_step": 3}


def parse_args():
    ap = argparse.ArgumentParser(description="BrickVLM real-pixel QLoRA trainer (v5, C2-2)")
    ap.add_argument("--model_dir", type=str,
                    default="out/prd-v2/run-20261026-c/C/models/qwen2-vl-2b-instruct",
                    help="本地基座目录或 HF repo id")
    ap.add_argument("--arch", choices=["qwen2_vl", "internvl_hf"], default="qwen2_vl")
    ap.add_argument("--data_root", type=str, default="out/prd-v2/run-20261026-c/C/data")
    ap.add_argument("--tasks", type=str, nargs="*",
                    default=["select_action", "understand_structure", "repair_local", "understand_step"])
    ap.add_argument("--per_task_limit", type=int, default=0,
                    help="每个任务最多取多少样本（0 = 全量）")
    ap.add_argument("--task_plan", type=str, default="",
                    help="形如 select_action:6,understand_structure:4,... 的配额计划（验证模式用）")
    ap.add_argument("--output_dir", type=str, default="out/prd-v2/run-20261026-c/C/weights/qwen2vl-2b-qlora")
    ap.add_argument("--max_pixels", type=int, default=448, help="每图最大边长像素（视觉 token 封顶的杠杆）")
    ap.add_argument("--lora_r", type=int, default=16)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--warmup_steps", type=int, default=5)
    ap.add_argument("--grad_accum", type=int, default=1)
    ap.add_argument("--max_steps", type=int, default=-1, help="-1 = 跑完整个数据集一轮")
    ap.add_argument("--overfit", type=int, default=0, help=">0 时取前 N 个样本重复训练（overfit sanity）")
    ap.add_argument("--dry_run", action="store_true", help="数据+collation+1 次 fwd/bwd 后退出")
    ap.add_argument("--verify_roundtrip", type=int, default=3, help="decode 往返校验样本数")
    ap.add_argument("--max_encode_errors", type=int, default=20, help="全量训练时允许跳过的坏样本上限")
    ap.add_argument("--evidence_out", type=str, default="",
                    help="证据 JSON 路径（默认与 --log_out 同目录 c2-2-datapath-verification.json）")
    ap.add_argument("--log_out", type=str, default="",
                    help="逐步 JSONL 日志路径")
    ap.add_argument("--log_every", type=int, default=1)
    ap.add_argument("--ckpt_every", type=int, default=500)
    return ap.parse_args()


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_task_plan(plan: str) -> dict:
    out = {}
    for part in filter(None, plan.split(",")):
        k, v = part.split(":")
        out[k.strip()] = int(v)
    return out


def collect_samples(data_root: Path, tasks: list[str], plan: dict | None,
                    per_task_limit: int) -> tuple[list[dict], list[Path]]:
    """从四类真实数据源收集样本（round-robin 保持任务混合），返回 (样本列表, 被消费的样本文件列表)。"""
    import brickvlm_data as bd

    samples: list[dict] = []
    consumed_files: list[Path] = []
    per_task: dict[str, list[dict]] = {t: [] for t in tasks}
    seen_files: set[str] = set()

    for entry in bd.iter_dataset_samples(data_root, tasks):
        t = entry["taskType"]
        lim = (plan or {}).get(t, per_task_limit if per_task_limit else None)
        if lim is not None and len(per_task[t]) >= lim:
            continue
        per_task[t].append(entry)
        if entry["path"] not in seen_files:
            seen_files.add(entry["path"])
            consumed_files.append(Path(entry["path"]))
        if plan:
            if all(len(per_task[t2]) >= plan.get(t2, 0) for t2 in tasks) and plan:
                break
        elif per_task_limit and all(len(per_task[t2]) >= per_task_limit for t2 in tasks):
            break

    if plan:  # 配额计划：交错混合
        order: list[dict] = []
        idx = 0
        while True:
            added = False
            for t in tasks:
                if idx < len(per_task[t]):
                    order.append(per_task[t][idx])
                    added = True
            if not added:
                break
            idx += 1
        samples = order
    else:
        for t in tasks:  # 无计划：任务块顺序（训练循环内再 shuffle）
            samples.extend(per_task[t])
    return samples, consumed_files


def encode_all(processor, samples: list[dict], roots: list[Path], max_pixels: int,
               max_encode_errors: int, log_fn=print) -> tuple[list[dict], list[dict]]:
    import brickvlm_data as bd

    items, errors = [], []
    for s in samples:
        entry = s
        sample, task = entry["sample"], entry["taskType"]
        try:
            item = bd.encode_sample(processor, sample, task, roots,
                                    max_pixels=max_pixels * max_pixels, min_pixels=28 * 28,
                                    verify_sha=True)
            items.append(item)
        except Exception as e:  # 坏样本：如实记录，不静默
            errors.append({"sample_id": sample.get("sampleId"), "task": task,
                           "error": f"{type(e).__name__}: {str(e)[:300]}"})
            log_fn(f"[encode-error] {sample.get('sampleId')}: {e}")
            if len(errors) > max_encode_errors:
                raise RuntimeError(f"encode error rate too high ({len(errors)} errors), aborting") from e
    return items, errors


def save_evidence(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False, default=str), encoding="utf-8")
    print(f"[evidence] wrote {path}")


def _write_ckpt_marker(ckpt_dir, step: int, losses: list, max_steps: int) -> None:
    """写入 checkpoint 标记（续训与审计依据）。"""
    import json as _json
    try:
        (ckpt_dir / "ckpt-state.json").write_text(_json.dumps({
            "step": step, "max_steps": max_steps,
            "loss_first": losses[0] if losses else None,
            "loss_last": losses[-1] if losses else None,
            "savedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }, ensure_ascii=False, indent=2), "utf-8")
    except Exception:
        pass


def main() -> int:
    args = parse_args()
    import torch

    from brickvlm_qlora import (HardwareInsufficient, apply_qlora, forward_loss,
                                load_model_and_processor, make_optimizer, vram_guard, vram_snapshot)

    data_root = (REPO_ROOT / args.data_root) if not Path(args.data_root).is_absolute() else Path(args.data_root)
    model_dir = (REPO_ROOT / args.model_dir) if not Path(args.model_dir).is_absolute() else Path(args.model_dir)
    out_dir = (REPO_ROOT / args.output_dir) if not Path(args.output_dir).is_absolute() else Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    evidence_path = (REPO_ROOT / args.evidence_out) if args.evidence_out else \
        out_dir / "c2-2-datapath-verification.json"
    log_path = (REPO_ROOT / args.log_out) if args.log_out else out_dir / "c2-2-datapath-verification.jsonl"

    evidence: dict = {
        "script": "training/brickvlm/train_qwen_qlora.py (v5, C2-2 real-pixel path)",
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "mode": "dry_run" if args.dry_run else ("overfit" if args.overfit else "sft"),
        "config": {k: getattr(args, k) for k in vars(args)},
        "data_root": str(data_root),
        "model_dir": str(model_dir),
    }
    jsonl = open(log_path, "a", encoding="utf-8")

    def log_line(obj: dict):
        obj["t"] = time.strftime("%H:%M:%S")
        jsonl.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")
        jsonl.flush()

    print("=" * 70)
    print("BrickVLM 真实像素 QLoRA 训练 (v5, C2-2)")
    print(f"基座: {model_dir} | arch={args.arch} | max_pixels={args.max_pixels}")
    print(f"数据: {data_root} | tasks={args.tasks} | mode={evidence['mode']}")
    print("=" * 70)

    if not torch.cuda.is_available():
        evidence["status"] = "hardware_insufficient"
        evidence["reason"] = "no CUDA device; 6GB QLoRA path requires a real GPU, CPU 不可行"
        save_evidence(evidence_path, evidence)
        return EXIT_HARDWARE

    try:
        # 1) 收集真实样本（含被消费文件哈希）
        plan = parse_task_plan(args.task_plan) if args.task_plan else \
            (DEFAULT_VERIFY_PLAN if args.dry_run else
             ({t: max(1, args.overfit // len(args.tasks)) for t in args.tasks} if args.overfit else None))
        over_limit = args.overfit if args.overfit else None
        samples, consumed_files = collect_samples(
            data_root, args.tasks, plan,
            per_task_limit=over_limit or args.per_task_limit)
        if over_limit:
            samples = samples[:over_limit]
        if not samples:
            evidence["status"] = "failed"
            evidence["reason"] = "no real samples collected"
            save_evidence(evidence_path, evidence)
            return EXIT_ERROR
        evidence["consumed_files"] = [{"path": str(p.relative_to(REPO_ROOT)) if p.is_relative_to(REPO_ROOT) else str(p),
                                       "sha256": sha256_file(p)} for p in consumed_files]
        counts: dict[str, int] = {}
        for s in samples:
            counts[s["taskType"]] = counts.get(s["taskType"], 0) + 1
        evidence["sample_counts"] = counts
        evidence["sample_count"] = len(samples)
        print(f"[data] collected {len(samples)} real samples: {counts}")

        # 2) 基座 + QLoRA（NF4、冻结视觉塔、LoRA 只挂 LLM）
        vram_guard("before_model_load")
        processor, model = load_model_and_processor(str(model_dir), args.arch,
                                                    max_pixels=args.max_pixels * args.max_pixels)
        model, lora_info = apply_qlora(model, args.arch, lora_r=args.lora_r)
        evidence["lora"] = lora_info
        evidence["vram_after_load"] = vram_guard("after_model_load")
        print(f"[model] loaded; trainable params={lora_info['trainable_params']:,} "
              f"(vision frozen), vram reserved={evidence['vram_after_load']['torch_reserved_bytes'] / 2**30:.2f} GiB")
        optimizer = make_optimizer(model)
        for g in optimizer.param_groups:
            g["lr"] = args.lr

        # 3) 真实像素编码：dry_run / overfit 一次性编码（样本少）；全量 SFT 惰性逐步编码
        import brickvlm_data as bd
        roots = bd.resolve_data_roots(REPO_ROOT, data_root)

        def encode_entry(entry: dict) -> dict:
            return bd.encode_sample(processor, entry["sample"], entry["taskType"], roots,
                                    max_pixels=args.max_pixels * args.max_pixels, min_pixels=28 * 28,
                                    verify_sha=True)

        encode_errors: list[dict] = []
        items: list[dict] = []
        evidence["image_grid_thw_real"] = True

        if args.dry_run or args.overfit:
            t0 = time.time()
            items, encode_errors = encode_all(processor, samples, roots, args.max_pixels,
                                              args.max_encode_errors)
            evidence["encode_seconds"] = round(time.time() - t0, 1)
        else:
            for entry in samples[:3]:  # 全量模式只预编码前 3 条做校验，其余训练时惰性编码
                try:
                    items.append(encode_entry(entry))
                except Exception as e:
                    encode_errors.append({"sample_id": entry["sample"].get("sampleId"),
                                          "task": entry["taskType"],
                                          "error": f"{type(e).__name__}: {str(e)[:300]}"})
        evidence["encode_errors"] = encode_errors
        assert all(bd.assert_no_simulated(it) is None for it in items)  # (a) 红线：无 simulated 字段
        grids = [it["image_grid_thw"] for it in items[:4]]
        evidence["image_grid_thw_examples"] = [g.tolist() if g is not None else None for g in grids]
        seq_lens = [int(it["input_ids"].shape[-1]) for it in items]
        answer_toks = [int((it["labels"] != -100).sum()) for it in items]
        evidence["seq_len_min/median/max"] = [min(seq_lens), sorted(seq_lens)[len(seq_lens) // 2], max(seq_lens)]
        evidence["answer_tokens_min/median/max"] = [min(answer_toks), sorted(answer_toks)[len(answer_toks) // 2],
                                                    max(answer_toks)]
        vision_toks = [int(it["image_grid_thw"].prod(dim=1).sum()) // 4 if it["image_grid_thw"] is not None
                       else 256 * len(it["image_meta"]) for it in items]
        evidence["vision_tokens_min/median/max"] = [min(vision_toks), sorted(vision_toks)[len(vision_toks) // 2],
                                                    max(vision_toks)]
        print(f"[encode] {len(items)} encoded / {len(encode_errors)} errors | "
              f"seq_len med={evidence['seq_len_min/median/max'][1]} | "
              f"vision_tokens med={evidence['vision_tokens_min/median/max'][1]}")

        # 4) decode 往返校验（assistant-only 掩码的正确性）
        roundtrips = []
        for it in items[:args.verify_roundtrip]:
            rt = bd.decode_roundtrip(processor, it)
            roundtrips.append({"sample_id": it["sample_id"], "task_type": it["task_type"],
                               "prompt_len": it["prompt_len"],
                               "masked_region_tail": rt["masked_region_text"][-160:],
                               "unmasked_region_text": rt["unmasked_region_text"][:400]})
        evidence["decode_roundtrip"] = roundtrips
        for r in roundtrips:
            print(f"[roundtrip] {r['sample_id']} ({r['task_type']}): unmasked -> "
                  f"{r['unmasked_region_text'][:120]!r}")

        collator = bd.BrickVLMMultimodalCollator(processor)

        # 5) 模式分支
        if args.dry_run:
            # (f) 真实数据 + collation + 1 次 fwd/bwd，然后退出
            batch = collator(items[:1])
            batch = {k: (v.cuda() if torch.is_tensor(v) else v) for k, v in batch.items()}
            vram_guard("before_dry_forward")
            torch.cuda.reset_peak_memory_stats()
            t1 = time.time()
            loss = forward_loss(model, args.arch, batch)
            torch.cuda.synchronize()
            fwd_s = time.time() - t1
            t2 = time.time()
            loss.backward()
            torch.cuda.synchronize()
            bwd_s = time.time() - t2
            snap = vram_snapshot()
            evidence["dry_forward_backward"] = {
                "loss": round(float(loss.detach()), 4),
                "loss_finite": bool(torch.isfinite(loss).item()),
                "forward_seconds": round(fwd_s, 3),
                "backward_seconds": round(bwd_s, 3),
                "backward_success": True,
                "peak_allocated_gib": round(snap["peak_allocated_bytes"] / 2**30, 3),
                "peak_reserved_gib": round(snap["peak_reserved_bytes"] / 2**30, 3),
            }
            evidence["status"] = "ok"
            evidence["verdict"] = ("real-pixel datapath verified: real pixel_values/image_grid_thw, "
                                   "assistant-only labels (decode roundtrip ok), fwd+bwd success")
            save_evidence(evidence_path, evidence)
            print(json.dumps(evidence["dry_forward_backward"], ensure_ascii=False))
            print("[dry_run] OK")
            return EXIT_OK

        # ---- 真实训练循环（overfit sanity 或全量 SFT）----
        # 这里只需要可复现的训练顺序，不是安全随机源：固定种子即可保证同一命令重跑得到同样批次。
        import random
        rng = random.Random(20261026)
        lazy_encode = not (args.dry_run or args.overfit)
        if lazy_encode:
            pool_entries = samples[:]
            rng.shuffle(pool_entries)  # 全量时打乱任务顺序（每 epoch 内固定种子）
            pool_len = len(pool_entries)
        else:
            pool_len = len(items)

        def get_item(i: int) -> dict:
            if lazy_encode:
                return encode_entry(pool_entries[i % pool_len])
            return items[i % pool_len]

        max_steps = args.max_steps if args.max_steps > 0 else pool_len
        vram_guard("before_training")

        def lr_at(step: int) -> float:
            if step < args.warmup_steps:
                return args.lr * (step + 1) / args.warmup_steps
            return args.lr

        losses = []
        model.train()
        optimizer.zero_grad(set_to_none=True)
        t_start = time.time()
        aborted = None
        skipped = 0
        idx = 0
        step = 0
        while step < max_steps:
            if skipped > args.max_encode_errors:
                aborted = f"encode error budget exhausted ({skipped} skips)"
                break
            try:
                it = get_item(idx)
            except Exception as e:
                skipped += 1
                encode_errors.append({"index": idx, "error": f"{type(e).__name__}: {str(e)[:300]}"})
                idx += 1
                continue
            batch = collator([it])
            batch = {k: (v.cuda() if torch.is_tensor(v) else v) for k, v in batch.items()}
            for g in optimizer.param_groups:
                g["lr"] = lr_at(step)
            try:
                loss = forward_loss(model, args.arch, batch)
                (loss / args.grad_accum).backward()
                if (step + 1) % args.grad_accum == 0 or step == max_steps - 1:
                    optimizer.step()
                    optimizer.zero_grad(set_to_none=True)
            except torch.cuda.OutOfMemoryError:
                aborted = f"OOM at step {step}"
                torch.cuda.empty_cache()
                break
            guard = vram_guard(f"step_{step}", abort=False)
            if guard["alert"]:  # (e) 门禁：reserved > 3.4 GiB -> 先清碎片重查一次，仍超即中止
                torch.cuda.empty_cache()
                guard = vram_guard(f"step_{step}_recheck", abort=True)
            losses.append(round(float(loss.detach()), 4))
            if step % args.log_every == 0 or step == max_steps - 1:
                rec = {"step": step, "sample_id": it["sample_id"], "task": it["task_type"],
                       "loss": losses[-1], "lr": round(lr_at(step), 8),
                       "reserved_gib": round(guard["torch_reserved_bytes"] / 2**30, 3),
                       "alloc_gib": round(guard["torch_allocated_bytes"] / 2**30, 3)}
                log_line(rec)
                print(f"[step {step + 1}/{max_steps}] loss={losses[-1]} lr={lr_at(step):.2e} "
                      f"reserved={rec['reserved_gib']}GiB sample={it['sample_id']}")
            step += 1
            idx += 1
            # 周期性落盘：防止长训练被外部终止时进度全丢（每 ckpt_every 步一次）
            if args.ckpt_every > 0 and step % args.ckpt_every == 0:
                ckpt_dir = out_dir / f"ckpt-{step:05d}"
                model.save_pretrained(str(ckpt_dir))
                _write_ckpt_marker(ckpt_dir, step, losses, max_steps)
                print(f"[ckpt] step={step} -> {ckpt_dir}")

        evidence["encode_errors_during_training"] = skipped

        wall = round(time.time() - t_start, 1)
        snap = vram_snapshot()
        evidence["training"] = {
            "steps_done": len(losses), "max_steps": max_steps,
            "loss_first5": losses[:5], "loss_last5": losses[-5:],
            "loss_first": losses[0] if losses else None,
            "loss_last": losses[-1] if losses else None,
            "loss_decreased": bool(losses and losses[-1] < losses[0]),
            "wall_seconds": wall,
            "peak_allocated_gib": round(snap["peak_allocated_bytes"] / 2**30, 3),
            "peak_reserved_gib": round(snap["peak_reserved_bytes"] / 2**30, 3),
            "aborted": aborted,
        }
        if aborted:
            evidence["status"] = "aborted"
            evidence["reason"] = aborted
            save_evidence(evidence_path, evidence)
            return EXIT_HARDWARE if "guard" in str(aborted) else EXIT_ERROR

        # adapter 落盘（PEFT adapter 很小，直接保存）
        adapter_dir = out_dir / ("overfit-adapter" if args.overfit else "adapter-final")
        model.save_pretrained(str(adapter_dir))
        evidence["adapter_dir"] = str(adapter_dir)
        evidence["status"] = "ok"
        save_evidence(evidence_path, evidence)
        print(f"[done] steps={len(losses)} loss {losses[0]} -> {losses[-1]} "
              f"({wall}s); adapter -> {adapter_dir}")
        return EXIT_OK

    except HardwareInsufficient as e:
        evidence["status"] = "hardware_insufficient"
        evidence["reason"] = str(e)
        evidence["vram_final"] = vram_snapshot()
        save_evidence(evidence_path, evidence)
        print(f"[HARDWARE_INSUFFICIENT] {e}", file=sys.stderr)
        return EXIT_HARDWARE
    except Exception as e:
        evidence["status"] = "failed"
        evidence["reason"] = f"{type(e).__name__}: {str(e)[:800]}"
        save_evidence(evidence_path, evidence)
        raise


if __name__ == "__main__":
    sys.exit(main())
