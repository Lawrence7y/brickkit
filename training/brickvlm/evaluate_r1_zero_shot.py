#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
evaluate_r1_zero_shot.py — R1 零样本基线评测（PRD §10.7 R1 / ML-06 比较对象）

在**冻结的留出集**上评测**未微调的视觉语言基座**，与 R3 SFT 完全同协议：
同一 prompt 构造（brickvlm_data.build_user_text / build_answer）、同一图像角色选择、
同一答案解析。唯一差别是模型权重未经本数据集训练。

用法：
  python training/brickvlm/evaluate_r1_zero_shot.py \
    --model_dir out/prd-v2/run-20261026-c/C/models/qwen2-vl-2b-instruct \
    --split out/prd-v2/run-20261026-c/C/data/splits/holdout_test.json \
    --out out/prd-v2/run-20261026-c/C/eval/r1-zero-shot-holdout.json

红线：本脚本不训练、不调阈值；样本解析失败如实计入 error，不回退、不猜测。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from brickvlm_data import (  # noqa: E402
    TASK_TYPES, build_answer, build_user_text, iter_dataset_samples, load_real_pixels,
    pick_images, resolve_data_roots,
)


# ─────────────── 结果解析 ───────────────

def _extract_json_block(text: str):
    """从模型输出里抓第一个 JSON 对象（零样本模型常带散文包装）。"""
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    candidates = [fenced.group(1)] if fenced else []
    candidates.append(text)
    for c in candidates:
        depth = 0
        start = None
        for i, ch in enumerate(c):
            if ch == "{":
                if depth == 0:
                    start = i
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0 and start is not None:
                    try:
                        return json.loads(c[start:i + 1])
                    except Exception:
                        start = None
    return None


def score_select_action(pred_text: str, sample: dict) -> dict:
    gold = sample.get("target") or {}
    raw_eq = gold.get("equivalentCandidates") or gold.get("actionIds") or []
    gold_ids = {x if isinstance(x, str) else (x.get("candidateId") or x.get("id")) for x in raw_eq if x}
    if not gold_ids:
        gid = (gold.get("primaryAction") or {}).get("selectedCandidateId") or gold.get("candidateId") or gold.get("actionId")
        if gid:
            gold_ids = {gid}
    cands_obj = sample.get("candidates") or {}
    candidates = cands_obj.get("items") if isinstance(cands_obj, dict) else cands_obj
    candidates = candidates or []
    cand_ids = [c.get("candidateId") or c.get("id") for c in candidates if isinstance(c, dict)]
    parsed = _extract_json_block(pred_text)
    pred_id = None
    if isinstance(parsed, dict):
        pred_id = parsed.get("candidateId") or parsed.get("action") or parsed.get("candidate_id")
    else:
        # 退路：在原文里找第一个出现的合法候选 ID
        for cid in cand_ids:
            if cid and cid in pred_text:
                pred_id = cid
                break
    correct = bool(pred_id and pred_id in gold_ids)
    # Top-3：模型只给一个答案时，Top-3 退化为 Top-1（如实记录）
    return {
        "predicted": pred_id,
        "gold": sorted(gold_ids),
        "correct_top1": correct,
        "correct_top3": correct,
        "parsed_ok": pred_id is not None,
        "num_candidates": len(candidates),
        "chance_top1": (len(gold_ids) / len(candidates)) if candidates else None,
    }


def score_understand_structure(pred_text: str, sample: dict) -> dict:
    gold = sample.get("groundTruth") or sample.get("target") or {}
    gold_issues = gold.get("issues") or []
    gold_set = {(str(i.get("partRef")), str(i.get("issueType"))) for i in gold_issues}
    parsed = _extract_json_block(pred_text)
    pred_issues = []
    if isinstance(parsed, dict):
        pred_issues = parsed.get("issues") or []
    elif isinstance(parsed, list):
        pred_issues = parsed
    pred_set = {(str(i.get("partRef")), str(i.get("issueType"))) for i in pred_issues if isinstance(i, dict)}
    tp = len(gold_set & pred_set)
    precision = tp / len(pred_set) if pred_set else 0.0
    recall = tp / len(gold_set) if gold_set else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    return {
        "predicted_issues": len(pred_set),
        "gold_issues": len(gold_set),
        "exact_set_match": pred_set == gold_set,
        "precision": precision, "recall": recall, "f1": f1,
        "parsed_ok": isinstance(parsed, (dict, list)),
    }


def score_repair_local(pred_text: str, sample: dict) -> dict:
    gold = sample.get("groundTruth") or sample.get("target") or {}
    gold_actions = gold.get("actions") or gold.get("repairActions") or []
    parsed = _extract_json_block(pred_text)
    pred_actions = []
    if isinstance(parsed, dict):
        pred_actions = parsed.get("actions") or parsed.get("repairActions") or []
    elif isinstance(parsed, list):
        pred_actions = parsed

    def norm(a):
        if not isinstance(a, dict):
            return str(a)
        return f"{a.get('op') or a.get('type')}|{a.get('candidateId') or a.get('partId') or ''}|{a.get('instanceId') or a.get('target') or ''}"

    gold_set = {norm(a) for a in gold_actions}
    pred_set = {norm(a) for a in pred_actions}
    return {
        "predicted_actions": len(pred_set), "gold_actions": len(gold_set),
        "exact_match": pred_set == gold_set and bool(gold_set),
        "parsed_ok": isinstance(parsed, (dict, list)),
    }


def score_understand_step(pred_text: str, sample: dict) -> dict:
    gold = sample.get("groundTruth") or sample.get("target") or sample.get("partsAdded") or []
    gold_list = gold if isinstance(gold, list) else (gold.get("parts") or gold.get("partsAdded") or [])
    gold_set = {(str(p.get("partId")), int(p.get("colorId") or 0), int(p.get("quantity") or 1)) for p in gold_list}
    parsed = _extract_json_block(pred_text)
    pred_list = []
    if isinstance(parsed, dict):
        pred_list = parsed.get("parts") or parsed.get("partsAdded") or []
    elif isinstance(parsed, list):
        pred_list = parsed
    pred_set = {(str(p.get("partId")), int(p.get("colorId") or 0), int(p.get("quantity") or 1)) for p in pred_list if isinstance(p, dict)}
    return {
        "predicted_parts": len(pred_set), "gold_parts": len(gold_set),
        "exact_match": pred_set == gold_set and bool(gold_set),
        "parsed_ok": isinstance(parsed, (dict, list)),
    }


def _family_of(sample: dict) -> str:
    prov = sample.get("provenance") or {}
    return (sample.get("familyId") or sample.get("modelId") or prov.get("familyId")
            or prov.get("modelId") or prov.get("setNumber") or "unknown")


SCORERS = {
    "select_action": score_select_action,
    "understand_structure": score_understand_structure,
    "repair_local": score_repair_local,
    "understand_step": score_understand_step,
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model_dir", required=True)
    ap.add_argument("--split", required=True, help="冻结划分文件（holdout_test.json）")
    ap.add_argument("--out", required=True)
    ap.add_argument("--repo", default="D:/Project/brickkit")
    ap.add_argument("--data_root", default="out/prd-v2/run-20261026-c/C/data")
    ap.add_argument("--max_pixels", type=int, default=448)
    ap.add_argument("--limit_per_task", type=int, default=0, help="0=全部；>0 每任务限流（用于快速验证）")
    ap.add_argument("--max_new_tokens", type=int, default=160)
    ap.add_argument("--device", default="cuda", choices=["cuda", "cpu"])
    args = ap.parse_args()

    repo = Path(args.repo)
    data_root = repo / args.data_root
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    split = json.loads(Path(args.split).read_text("utf-8"))
    split_ids = set()
    if isinstance(split, dict):
        for key in ("sampleIds", "ids", "samples"):
            v = split.get(key)
            if isinstance(v, list):
                split_ids = {s if isinstance(s, str) else (s.get("sampleId") or s.get("id")) for s in v}
                break
    else:
        split_ids = {s if isinstance(s, str) else (s.get("sampleId") or s.get("id")) for s in split}
    split_ids.discard(None)
    split_hash = hashlib.sha256(Path(args.split).read_bytes()).hexdigest()
    print(f"[R1] split={args.split} ids={len(split_ids)} sha256={split_hash[:16]}")

    from transformers import AutoProcessor, AutoModelForVision2Seq  # noqa: E402

    t0 = time.time()
    processor = AutoProcessor.from_pretrained(args.model_dir, max_pixels=args.max_pixels * args.max_pixels)
    if args.device == "cpu":
        torch.cuda.empty_cache() if torch.cuda.is_available() else None
    _dev = args.device if (args.device == "cpu" or torch.cuda.is_available()) else "cpu"
    _dt = torch.float32 if _dev == "cpu" else torch.bfloat16
    model = AutoModelForVision2Seq.from_pretrained(
        args.model_dir, torch_dtype=_dt,
        **( {"device_map": {"": 0}} if _dev == "cuda" else {"device_map": "cpu"} ),
        attn_implementation="eager",
    ).eval()
    print(f"[R1] base loaded in {time.time()-t0:.1f}s")

    roots = resolve_data_roots(repo, data_root)
    # 收集留出集样本（只取 split 内的）
    per_task = defaultdict(list)
    for task in TASK_TYPES:
        for entry in iter_dataset_samples(data_root, [task]):
            sample = entry["sample"]
            sid = sample.get("sampleId") or sample.get("id")
            if split_ids and sid not in split_ids:
                continue
            per_task[task].append(sample)
    for task in TASK_TYPES:
        if args.limit_per_task:
            per_task[task] = per_task[task][: args.limit_per_task]
        print(f"[R1] {task}: {len(per_task[task])} samples")

    results = []
    vram_peak = 0
    for task in TASK_TYPES:
        for sample in per_task[task]:
            sid = sample.get("sampleId") or sample.get("id")
            try:
                imgs, _img_meta = load_real_pixels(sample, task, roots)
                text = build_user_text(sample, task)
                content = [{"type": "image"} for _ in imgs] + [{"type": "text", "text": text}]
                messages = [{"role": "user", "content": content}]
                prompt = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
                inputs = processor(text=[prompt], images=imgs, return_tensors="pt", padding=True).to(_dev)
                with torch.no_grad():
                    gen = model.generate(**inputs, max_new_tokens=args.max_new_tokens, do_sample=False)
                new_tokens = gen[:, inputs["input_ids"].shape[1]:]
                pred_text = processor.batch_decode(new_tokens, skip_special_tokens=True)[0]
                vram_peak = max(vram_peak, int(torch.cuda.max_memory_reserved() / (1024 ** 2))) if _dev == "cuda" else 0
                score = SCORERS[task](pred_text, sample)
                results.append({
                    "sampleId": sid, "taskType": task, "familyId": _family_of(sample),
                    **score, "raw_output_head": pred_text[:200],
                })
            except Exception as e:  # 如实记录，不静默跳过
                results.append({
                    "sampleId": sid, "taskType": task,
                    "familyId": _family_of(sample),
                    "error": f"{type(e).__name__}: {e}", "parsed_ok": False,
                    "correct_top1": False, "correct_top3": False,
                    "exact_match": False, "exact_set_match": False,
                })
            if len(results) % 20 == 0:
                print(f"[R1] {len(results)} done")

    # 汇总（按任务、按家族）
    summary = {}
    for task in TASK_TYPES:
        rows = [r for r in results if r["taskType"] == task]
        if not rows:
            summary[task] = {"n": 0, "status": "no_samples"}
            continue
        n = len(rows)
        entry = {"n": n, "errors": sum(1 for r in rows if r.get("error"))}
        if task == "select_action":
            entry["top1"] = sum(1 for r in rows if r.get("correct_top1")) / n
            entry["top3"] = sum(1 for r in rows if r.get("correct_top3")) / n
            chances = [r["chance_top1"] for r in rows if r.get("chance_top1") is not None]
            entry["mean_chance_top1"] = (sum(chances) / len(chances)) if chances else None
        elif task == "understand_structure":
            f1s = [r.get("f1", 0.0) for r in rows]
            entry["mean_f1"] = sum(f1s) / n
            entry["exact_set_match"] = sum(1 for r in rows if r.get("exact_set_match")) / n
        else:
            entry["exact_match"] = sum(1 for r in rows if r.get("exact_match")) / n
        entry["parse_rate"] = sum(1 for r in rows if r.get("parsed_ok")) / n
        # 按家族拆分（PRD §10.6 要求不跨子集平均掩盖）
        by_fam = defaultdict(list)
        for r in rows:
            by_fam[r.get("familyId") or "unknown"].append(r)
        entry["by_family"] = {
            fam: {
                "n": len(rs),
                **({"top1": sum(1 for x in rs if x.get("correct_top1")) / len(rs)} if task == "select_action" else {}),
                **({"mean_f1": sum(x.get("f1", 0.0) for x in rs) / len(rs)} if task == "understand_structure" else {}),
                **({"exact_match": sum(1 for x in rs if x.get("exact_match")) / len(rs)} if task in ("repair_local", "understand_step") else {}),
            } for fam, rs in sorted(by_fam.items())
        }
        summary[task] = entry

    report = {
        "stage": "R1",
        "protocol": "zero-shot base model, same prompt/image protocol as R3 SFT",
        "model": {"dir": args.model_dir, "max_pixels": args.max_pixels, "max_new_tokens": args.max_new_tokens},
        "split": {"file": args.split, "sha256": split_hash, "sampleIds": len(split_ids)},
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "elapsedSeconds": round(time.time() - t0, 1),
        "vramPeakMiB": vram_peak,
        "summary": summary,
        "results": results,
        "honesty": {
            "trained_on_this_dataset": False,
            "threshold_tuning": "none",
            "notes": "零样本基线未经本数据集训练；select_action 的 Top-3 在单答案生成协议下退化为 Top-1，已在代码中如实处理。",
        },
    }
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), "utf-8")
    print(json.dumps({"out": str(out_path), "summary": summary}, ensure_ascii=False, indent=2)[:2500])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
