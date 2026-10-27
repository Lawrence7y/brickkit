#!/usr/bin/env python3
"""
tools/brickvlm/baseline_r1.py — BrickVLM R1 零样本/规则基线评测器

评测指标（PRD 10.7 / ML-02 / ML-04 / ML-05 / ML-06）：
1. 候选覆盖率 (Candidate Coverage)：目标动作是否在引擎枚举候选中（门槛 ≥ 99%）
2. 动作选择准确率：Top-1 / Top-3
3. 说明书新增件清单精确匹配率 (Exact Match)
4. 结构错误诊断 F1 值与宏平均
5. 结果保存至 JSON 报告，作为微调前对比基准

读写路径全部是模块级常量（由 __file__ 推导），不接受外部参数。
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATASET_PATH = ROOT / "out" / "prd-v2" / "run-20261026-v2" / "B" / "dataset" / "validation.json"
REPORT_PATH = ROOT / "out" / "prd-v2" / "run-20261026-v2" / "B" / "r1-baseline-report.json"


def evaluate_baseline(dataset_path: Path):
    """计算 R1 规则基线全部指标；只读数据集，不写盘。"""
    with open(dataset_path, "r", encoding="utf-8") as f:
        samples = json.load(f)

    metrics = {
        "totalSamples": len(samples),
        "byTask": {},
        "candidateCoverage": {
            "eligible": 0,
            "covered": 0,
            "rate": 0.0
        },
        "actionAccuracy": {
            "top1Correct": 0,
            "top3Correct": 0,
            "total": 0,
            "top1Rate": 0.0,
            "top3Rate": 0.0
        },
        "stepUnderstanding": {
            "exactMatchCount": 0,
            "total": 0,
            "exactMatchRate": 0.0
        },
        "structureDiagnosis": {
            "tp": 0, "fp": 0, "fn": 0, "tn": 0,
            "precision": 0.0, "recall": 0.0, "f1": 0.0
        }
    }

    for s in samples:
        ttype = s["taskType"]
        metrics["byTask"][ttype] = metrics["byTask"].get(ttype, 0) + 1

        # 1. 候选覆盖率检查 (针对有动作候选项的样本)
        target = s.get("target", {})
        cand_items = s.get("candidates", {}).get("items", [])
        primary_act = target.get("primaryAction", {})
        target_cand = primary_act.get("selectedCandidateId")

        if target_cand:
            metrics["candidateCoverage"]["eligible"] += 1
            cand_ids = [c["candidateId"] for c in cand_items]
            if target_cand in cand_ids:
                metrics["candidateCoverage"]["covered"] += 1

        # 2. 动作选择 Top-1 / Top-3 基线 (规则：选择第一个面向相机的候选，模拟未微调基线)
        if ttype == "select_action":
            metrics["actionAccuracy"]["total"] += 1
            if cand_items:
                equiv = target.get("equivalentCandidates", [target_cand])
                # Top-1: 规则基线选第 0 个候选
                if cand_items[0]["candidateId"] in equiv:
                    metrics["actionAccuracy"]["top1Correct"] += 1
                # Top-3: 前 3 个候选中包含
                top3_cands = [c["candidateId"] for c in cand_items[:3]]
                if any(c in equiv for c in top3_cands):
                    metrics["actionAccuracy"]["top3Correct"] += 1

        # 3. 说明书新增件清单匹配
        elif ttype == "understand_step":
            metrics["stepUnderstanding"]["total"] += 1
            pred_parts = s.get("inventory", [])
            tgt_parts = target.get("stepUnderstanding", {}).get("partsAdded", [])
            # 简单基线以 inventory 首件作为预测
            if pred_parts and tgt_parts:
                if pred_parts[0]["partId"] == tgt_parts[0]["partId"] and pred_parts[0]["colorId"] == tgt_parts[0]["colorId"]:
                    metrics["stepUnderstanding"]["exactMatchCount"] += 1

        # 4. 结构诊断
        elif ttype == "understand_structure":
            actual_err = target.get("structureDiagnosis", {}).get("hasStructuralError", False)
            # 规则基线：默认保守预测无错误
            pred_err = False
            if actual_err and pred_err:
                metrics["structureDiagnosis"]["tp"] += 1
            elif not actual_err and pred_err:
                metrics["structureDiagnosis"]["fp"] += 1
            elif actual_err and not pred_err:
                metrics["structureDiagnosis"]["fn"] += 1
            else:
                metrics["structureDiagnosis"]["tn"] += 1

    # 计算比率
    cc = metrics["candidateCoverage"]
    cc["rate"] = cc["covered"] / max(1, cc["eligible"])

    aa = metrics["actionAccuracy"]
    aa["top1Rate"] = aa["top1Correct"] / max(1, aa["total"])
    aa["top3Rate"] = aa["top3Correct"] / max(1, aa["total"])

    su = metrics["stepUnderstanding"]
    su["exactMatchRate"] = su["exactMatchCount"] / max(1, su["total"])

    sd = metrics["structureDiagnosis"]
    p = sd["tp"] / max(1, sd["tp"] + sd["fp"])
    r = sd["tp"] / max(1, sd["tp"] + sd["fn"])
    sd["precision"] = p
    sd["recall"] = r
    sd["f1"] = 2 * p * r / max(1e-8, p + r)

    print(f"\n--- R1 基线评测报告 ---")
    print(f"评估样本总数: {metrics['totalSamples']}")
    print(f"候选覆盖率: {cc['covered']}/{cc['eligible']} ({cc['rate']*100:.2f}%)")
    print(f"动作选择 Top-1: {aa['top1Correct']}/{aa['total']} ({aa['top1Rate']*100:.2f}%)")
    print(f"动作选择 Top-3: {aa['top3Correct']}/{aa['total']} ({aa['top3Rate']*100:.2f}%)")
    print(f"新增件清单精确匹配: {su['exactMatchCount']}/{su['total']} ({su['exactMatchRate']*100:.2f}%)")
    return metrics


if __name__ == "__main__":
    metrics = evaluate_baseline(DATASET_PATH)
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(metrics, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"报告已保存至: {REPORT_PATH}")
