"""Colab 端留出评测：R1 零样本基线 + R5 SFT adapter，同协议对比。

适配 T4（Turing）：fp16 而非 bf16；支持断点续跑（每 N 条落盘一次）。
输出 eval-<stage>.json，可直接喂给 compute_ml06.py 计算域增益。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

import torch

REPO = Path("/content/repo")
sys.path.insert(0, str(REPO / "training" / "brickvlm"))

from brickvlm_data import (  # noqa: E402
    TASK_TYPES,
    build_user_text,
    iter_dataset_samples,
    load_real_pixels,
    resolve_data_roots,
)


def extract_json(text: str):
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    pools = [fenced.group(1)] if fenced else []
    pools.append(text)
    for pool in pools:
        depth, start = 0, None
        for i, ch in enumerate(pool):
            if ch == "{":
                if depth == 0:
                    start = i
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0 and start is not None:
                    try:
                        return json.loads(pool[start : i + 1])
                    except Exception:
                        start = None
    return None


def family_of(sample: dict) -> str:
    prov = sample.get("provenance") or {}
    return (
        sample.get("familyId")
        or sample.get("modelId")
        or prov.get("familyId")
        or prov.get("modelId")
        or prov.get("setNumber")
        or "unknown"
    )


def score_select_action(pred: str, sample: dict) -> dict:
    target = sample.get("target") or {}
    raw_eq = target.get("equivalentCandidates") or target.get("actionIds") or []
    gold = {x if isinstance(x, str) else (x.get("candidateId") or x.get("id")) for x in raw_eq if x}
    if not gold:
        gid = (target.get("primaryAction") or {}).get("selectedCandidateId")
        if gid:
            gold = {gid}
    cands_obj = sample.get("candidates") or {}
    items = cands_obj.get("items") if isinstance(cands_obj, dict) else cands_obj
    items = items or []
    ids = [c.get("candidateId") for c in items if isinstance(c, dict)]
    parsed = extract_json(pred)
    pred_id = None
    if isinstance(parsed, dict):
        pred_id = parsed.get("candidateId") or parsed.get("action") or parsed.get("candidate_id")
    if pred_id is None:
        for cid in ids:
            if cid and cid in pred:
                pred_id = cid
                break
    correct = bool(pred_id and pred_id in gold)
    return {
        "predicted": pred_id,
        "gold": sorted(gold),
        "correct_top1": correct,
        "correct_top3": correct,
        "parsed_ok": pred_id is not None,
        "num_candidates": len(items),
        "chance_top1": (len(gold) / len(items)) if items else None,
    }


def score_understand_structure(pred: str, sample: dict) -> dict:
    target = sample.get("target") or {}
    diag = target.get("structureDiagnosis") or {}
    gt = sample.get("groundTruth") or {}
    gold_issues = diag.get("issues") or gt.get("issues") or []
    gold = {(str(i.get("partRef")), str(i.get("issueType"))) for i in gold_issues}
    parsed = extract_json(pred)
    pred_list = []
    if isinstance(parsed, dict):
        pred_list = parsed.get("issues") or []
    elif isinstance(parsed, list):
        pred_list = parsed
    ps = {(str(i.get("partRef")), str(i.get("issueType"))) for i in pred_list if isinstance(i, dict)}
    tp = len(gold & ps)
    prec = tp / len(ps) if ps else 0.0
    rec = tp / len(gold) if gold else 0.0
    f1 = (2 * prec * rec / (prec + rec)) if (prec + rec) else 0.0
    return {
        "predicted_issues": len(ps),
        "gold_issues": len(gold),
        "exact_set_match": ps == gold,
        "precision": prec,
        "recall": rec,
        "f1": f1,
        "parsed_ok": isinstance(parsed, (dict, list)),
    }


def _norm_action(a) -> str:
    if not isinstance(a, dict):
        return str(a)
    return "|".join(
        str(a.get(k) or "")
        for k in ("op", "type", "candidateId", "partId", "instanceId", "target")
    )


def score_repair_local(pred: str, sample: dict) -> dict:
    target = sample.get("target") or {}
    gt = sample.get("groundTruth") or {}
    gold_actions = (
        target.get("correctiveSequence")
        or gt.get("actions")
        or gt.get("repairActions")
        or []
    )
    parsed = extract_json(pred)
    pred_actions = []
    if isinstance(parsed, dict):
        pred_actions = parsed.get("actions") or parsed.get("repairActions") or []
    elif isinstance(parsed, list):
        pred_actions = parsed
    gs = {_norm_action(a) for a in gold_actions}
    ps = {_norm_action(a) for a in pred_actions}
    return {
        "predicted_actions": len(ps),
        "gold_actions": len(gs),
        "exact_match": ps == gs and bool(gs),
        "parsed_ok": isinstance(parsed, (dict, list)),
    }


def score_understand_step(pred: str, sample: dict) -> dict:
    gt = sample.get("groundTruth") or {}
    if isinstance(gt, dict):
        gold_list = gt.get("partsAdded") or gt.get("parts") or []
    elif isinstance(gt, list):
        gold_list = gt
    else:
        gold_list = []
    gold = {
        (str(p.get("partId")), int(p.get("colorId") or 0), int(p.get("quantity") or 1))
        for p in gold_list
        if isinstance(p, dict)
    }
    parsed = extract_json(pred)
    pred_list = []
    if isinstance(parsed, dict):
        pred_list = parsed.get("parts") or parsed.get("partsAdded") or []
    elif isinstance(parsed, list):
        pred_list = parsed
    ps = {
        (str(p.get("partId")), int(p.get("colorId") or 0), int(p.get("quantity") or 1))
        for p in pred_list
        if isinstance(p, dict)
    }
    return {
        "predicted_parts": len(ps),
        "gold_parts": len(gold),
        "exact_match": ps == gold and bool(gold),
        "parsed_ok": isinstance(parsed, (dict, list)),
    }


SCORERS = {
    "select_action": score_select_action,
    "understand_structure": score_understand_structure,
    "repair_local": score_repair_local,
    "understand_step": score_understand_step,
}


def strict_subset_summary(results: list[dict]) -> dict:
    """select_action 严格子集：只统计非全等价样本（候选里存在真实错误选项）。

    留出集 352 条里 64 条候选全等价（随机也 100%），会抬高 Top-1；
    这里单列严格指标，供 ML-04 判读时区分「模型真会选」与「题目本身无区分力」。
    """
    rows = [r for r in results if r["taskType"] == "select_action" and not r.get("error")]
    informative = [
        r for r in rows if (r.get("num_candidates") or 0) > (len(r.get("gold") or []) or 0)
    ]
    degenerate = [r for r in rows if r not in informative]
    if not informative:
        return {"n": 0, "status": "no_informative_samples"}
    n = len(informative)
    chances = [r["chance_top1"] for r in informative if r.get("chance_top1") is not None]
    return {
        "n": n,
        "degenerate_all_equivalent": len(degenerate),
        "top1": sum(1 for r in informative if r.get("correct_top1")) / n,
        "mean_chance_top1": (sum(chances) / len(chances)) if chances else None,
        "parse_rate": sum(1 for r in informative if r.get("parsed_ok")) / n,
    }


def summarize(results: list[dict]) -> dict:
    out = {}
    for task in TASK_TYPES:
        rows = [r for r in results if r["taskType"] == task]
        if not rows:
            out[task] = {"n": 0, "status": "no_samples"}
            continue
        n = len(rows)
        e = {"n": n, "errors": sum(1 for r in rows if r.get("error"))}
        if task == "select_action":
            e["top1"] = sum(1 for r in rows if r.get("correct_top1")) / n
            e["top3"] = sum(1 for r in rows if r.get("correct_top3")) / n
            ch = [r["chance_top1"] for r in rows if r.get("chance_top1") is not None]
            e["mean_chance_top1"] = (sum(ch) / len(ch)) if ch else None
        elif task == "understand_structure":
            e["mean_f1"] = sum(r.get("f1", 0.0) for r in rows) / n
            e["exact_set_match"] = sum(1 for r in rows if r.get("exact_set_match")) / n
        else:
            e["exact_match"] = sum(1 for r in rows if r.get("exact_match")) / n
        e["parse_rate"] = sum(1 for r in rows if r.get("parsed_ok")) / n
        fams = defaultdict(list)
        for r in rows:
            fams[r.get("familyId") or "unknown"].append(r)
        e["by_family"] = {}
        for fam, rs in sorted(fams.items()):
            sub = {"n": len(rs)}
            if task == "select_action":
                sub["top1"] = sum(1 for x in rs if x.get("correct_top1")) / len(rs)
            elif task == "understand_structure":
                sub["mean_f1"] = sum(x.get("f1", 0.0) for x in rs) / len(rs)
            else:
                sub["exact_match"] = sum(1 for x in rs if x.get("exact_match")) / len(rs)
            e["by_family"][fam] = sub
        out[task] = e
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", required=True, choices=["R1", "R5"])
    ap.add_argument("--model_id", default="Qwen/Qwen2-VL-2B-Instruct")
    ap.add_argument("--adapter_dir", default=None)
    ap.add_argument("--out", required=True)
    ap.add_argument("--max_pixels", type=int, default=448)
    ap.add_argument("--max_new_tokens", type=int, default=128)
    ap.add_argument("--limit_per_task", type=int, default=0)
    ap.add_argument("--resume", action="store_true")
    args = ap.parse_args()

    data_root = REPO / "out/prd-v2/run-20261026-c/C/data"
    split_path = data_root / "splits/holdout_test.json"
    split = json.loads(split_path.read_text("utf-8"))
    ids = {s["sampleId"] for s in split["samples"]}
    split_sha = hashlib.sha256(split_path.read_bytes()).hexdigest()
    print(f"[{args.stage}] holdout ids={len(ids)} sha={split_sha[:16]}", flush=True)

    roots = resolve_data_roots(REPO, data_root)

    per_task: dict[str, list] = defaultdict(list)
    for task in TASK_TYPES:
        for entry in iter_dataset_samples(data_root, [task]):
            s = entry["sample"]
            if s.get("sampleId") in ids:
                per_task[task].append(s)
        if args.limit_per_task:
            per_task[task] = per_task[task][: args.limit_per_task]
        print(f"[{args.stage}] {task}: {len(per_task[task])}", flush=True)

    done: dict[str, dict] = {}
    out_path = Path(args.out)
    if args.resume and out_path.exists():
        prev = json.loads(out_path.read_text("utf-8"))
        for r in prev.get("results", []):
            if not r.get("error"):
                done[r["sampleId"]] = r
        print(f"[{args.stage}] resumed {len(done)} finished samples", flush=True)

    from transformers import AutoModelForImageTextToText, AutoProcessor

    processor = AutoProcessor.from_pretrained(
        args.model_id, max_pixels=args.max_pixels * args.max_pixels
    )
    model = AutoModelForImageTextToText.from_pretrained(
        args.model_id,
        torch_dtype=torch.float32,
        device_map={"": 0},
        attn_implementation="eager",
    ).eval()
    if args.stage == "R5":
        from peft import PeftModel

        if not args.adapter_dir or not Path(args.adapter_dir).exists():
            raise SystemExit(f"[R5] adapter 不存在: {args.adapter_dir}")
        model = PeftModel.from_pretrained(model, args.adapter_dir).eval()
        print(f"[{args.stage}] adapter loaded: {args.adapter_dir}", flush=True)

    results = list(done.values())
    t0 = time.time()
    processed = 0

    for task in TASK_TYPES:
        for sample in per_task[task]:
            sid = sample.get("sampleId")
            if sid in done:
                continue
            try:
                imgs, _meta = load_real_pixels(sample, task, roots)
                text = build_user_text(sample, task)
                content = [{"type": "image"} for _ in imgs] + [{"type": "text", "text": text}]
                prompt = processor.apply_chat_template(
                    [{"role": "user", "content": content}],
                    tokenize=False,
                    add_generation_prompt=True,
                )
                inputs = processor(text=[prompt], images=imgs, return_tensors="pt", padding=True).to(
                    "cuda"
                )
                with torch.no_grad():
                    gen = model.generate(
                        **inputs, max_new_tokens=args.max_new_tokens, do_sample=False
                    )
                pred = processor.batch_decode(
                    gen[:, inputs["input_ids"].shape[1] :], skip_special_tokens=True
                )[0]
                score = SCORERS[task](pred, sample)
                results.append(
                    {
                        "sampleId": sid,
                        "taskType": task,
                        "familyId": family_of(sample),
                        **score,
                        "raw_output_head": pred[:200],
                    }
                )
            except Exception as exc:
                results.append(
                    {
                        "sampleId": sid,
                        "taskType": task,
                        "familyId": family_of(sample),
                        "error": f"{type(exc).__name__}: {exc}"[:300],
                        "parsed_ok": False,
                        "correct_top1": False,
                        "correct_top3": False,
                        "exact_match": False,
                        "exact_set_match": False,
                    }
                )
            processed += 1
            if processed % 20 == 0:
                print(
                    f"[{args.stage}] {processed} new / {len(results)} total, "
                    f"{(time.time()-t0)/processed:.1f}s/sample",
                    flush=True,
                )
                # 断点落盘
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_text(
                    json.dumps(
                        {
                            "stage": args.stage,
                            "partial": True,
                            "results": results,
                            "summary": summarize(results),
                        },
                        ensure_ascii=False,
                    ),
                    "utf-8",
                )

    summary = summarize(results)
    summary["select_action_strict"] = strict_subset_summary(results)
    report = {
        "stage": args.stage,
        "protocol": "T4 fp32 (fp16 degenerates Qwen2-VL logits to token 0), same prompt/image protocol for both stages",
        "model": {
            "id": args.model_id,
            "max_pixels": args.max_pixels,
            "max_new_tokens": args.max_new_tokens,
            "dtype": "float32",
        },
        "adapter": {"dir": args.adapter_dir} if args.stage == "R5" else None,
        "split": {"file": str(split_path), "sha256": split_sha, "sampleIds": len(ids)},
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "elapsedSeconds": round(time.time() - t0, 1),
        "vramPeakMiB": int(torch.cuda.max_memory_reserved() / (1024**2)),
        "summary": summary,
        "results": results,
        "honesty": {
            "trained_on_this_dataset": args.stage == "R5",
            "threshold_tuning": "none",
            "notes": (
                "T4 fp32 推理（实测 fp16 会让 logits 退化，见 colab_diag_fp16 诊断）；"
                "select_action 的 Top-3 在单答案生成协议下退化为 Top-1。"
                "留出集在训练前冻结（split-manifest freeze）。"
            ),
        },
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), "utf-8")
    print(json.dumps({"stage": args.stage, "summary": summary}, ensure_ascii=False, indent=2)[:3000])
    print(f"[{args.stage}] wrote {out_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
