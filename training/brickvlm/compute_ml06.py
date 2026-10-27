#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
compute_ml06.py — ML-06 域增益计算（PRD §12.3）

比较 R1（未微调基座）与 R5（R3 SFT adapter）在**同一冻结留出集、同一协议**下的结果，
逐任务给出分子/分母与判定：

  ML-06 域增益：准确率 +≥5 个百分点 或 错误率 −≥20%（两条满足其一）
  效率轨：准确率 ≥90% 且相对基线下降 ≤2pp 且单任务成本 −≥30%（无成本数据则不可通过）

红线：只做算术比较，不改阈值、不换比较对象、不挑选子集。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def task_metric(task: str, summary: dict):
    """按任务取主指标（值与名称）。"""
    s = summary.get(task) or {}
    if not s or s.get("n", 0) == 0:
        return None, None
    if task == "select_action":
        return s.get("top1"), "top1"
    if task == "understand_structure":
        return s.get("mean_f1"), "mean_f1"
    if task in ("repair_local", "understand_step"):
        return s.get("exact_match"), "exact_match"
    return None, None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--r1", required=True)
    ap.add_argument("--r5", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    r1 = json.loads(Path(args.r1).read_text("utf-8"))
    r5 = json.loads(Path(args.r5).read_text("utf-8"))

    tasks = ["select_action", "understand_structure", "repair_local", "understand_step"]
    rows = []
    aggregate = {"n_weighted_delta": 0.0, "n_total": 0, "pass_tasks": 0, "evaluable_tasks": 0}

    for task in tasks:
        b, metric = task_metric(task, r1.get("summary", {}))
        a, _ = task_metric(task, r5.get("summary", {}))
        n1 = (r1.get("summary", {}).get(task) or {}).get("n", 0)
        n5 = (r5.get("summary", {}).get(task) or {}).get("n", 0)
        if b is None or a is None:
            rows.append({
                "task": task, "status": "unavailable", "metric": metric,
                "r1_n": n1, "r5_n": n5,
                "reason": "任务在留出集中无样本或评测失败",
            })
            continue
        delta_pp = (a - b) * 100.0
        base_err = 1.0 - b
        new_err = 1.0 - a
        rel_err_change = ((new_err - base_err) / base_err * 100.0) if base_err > 1e-9 else None
        pass_acc = delta_pp >= 5.0
        pass_err = rel_err_change is not None and rel_err_change <= -20.0
        ok = pass_acc or pass_err
        aggregate["evaluable_tasks"] += 1
        if ok:
            aggregate["pass_tasks"] += 1
        rows.append({
            "task": task, "status": "evaluated", "metric": metric,
            "r1_value": round(b, 4), "r5_value": round(a, 4),
            "r1_n": n1, "r5_n": n5,
            "delta_pp": round(delta_pp, 2),
            "relative_error_change_pct": round(rel_err_change, 2) if rel_err_change is not None else None,
            "pass_via_accuracy": pass_acc,
            "pass_via_error_rate": pass_err,
            "ml06_task_pass": ok,
        })

    report = {
        "gate": "ML-06",
        "rule": "准确率 +≥5 个百分点 或 错误率 −≥20%（同基座、同协议、同冻结留出集）",
        "inputs": {
            "r1": {"file": args.r1, "stage": r1.get("stage"), "model": r1.get("model"), "split": r1.get("split")},
            "r5": {"file": args.r5, "stage": r5.get("stage"), "adapter": r5.get("adapter"), "split": r5.get("split")},
        },
        "sameSplit": (r1.get("split", {}).get("sha256") == r5.get("split", {}).get("sha256")),
        "rows": rows,
        "aggregate": aggregate,
        "verdict": ("pass" if aggregate["evaluable_tasks"] > 0 and aggregate["pass_tasks"] == aggregate["evaluable_tasks"]
                    else ("partial" if aggregate["pass_tasks"] > 0 else "fail")),
        "efficiencyTrack": {
            "status": "unavailable",
            "reason": "无同协议的每任务成本数据（训练/推理耗时只在单批探针上测过，不是完整任务成本）",
        },
        "honesty": {
            "thresholdsUnchanged": True,
            "subsetSelection": "none — 全部四个任务与全部留出样本参与",
            "notes": "Top-3 在单答案生成协议下退化为 Top-1，已计入 r5/report honesty 段，未据此放宽 ML-04。",
        },
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2), "utf-8")
    print(json.dumps({"verdict": report["verdict"], "rows": rows, "aggregate": aggregate}, ensure_ascii=False, indent=2)[:3000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
