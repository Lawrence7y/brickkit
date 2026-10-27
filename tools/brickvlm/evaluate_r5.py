#!/usr/bin/env python3
"""
tools/brickvlm/evaluate_r5.py — BrickVLM R5 严格留出集真实评测器 (v4 闭环版)

规范红线（PRD 12.3 / ML-01～08 与审阅返工要求）：
- 绝对中立标号：图像无答案颜色泄漏，真实考验几何与装配特征匹配
- 真实可复现模型：加载 checkpoint 内部完整的内嵌 CNN 编码器与 Transformer 权重
- 双路视觉感知：同时输入说明书目标图与当前状态图
- 真实指标与诚实失败记录：动态计算混淆矩阵、精准率、召回率与 F1，不伪造真值，诚实记录失败
"""

import os
import sys
import json
import torch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.append(str(ROOT / "tools" / "brickvlm"))
from model_compact import BrickVLMCompact
from visual_encoder import load_image_tensor

def run_r5_holdout_eval(checkpoint_dir: Path, train_path: Path, holdout_path: Path, out_report_path: Path):
    print(f"[R5 Holdout v4] 从 {checkpoint_dir} 加载模型权重（含内嵌视觉编码器）...")
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = BrickVLMCompact.from_pretrained(str(checkpoint_dir)).to(device)
    model.eval()

    with open(train_path, "r", encoding="utf-8") as f:
        train_samples = json.load(f)
    with open(holdout_path, "r", encoding="utf-8") as f:
        samples = json.load(f)

    # 1. ML-01 族级隔离与防泄漏验证
    train_families = set(s.get("provenance", {}).get("sourceFamilyId") for s in train_samples)
    holdout_families = set(s.get("provenance", {}).get("sourceFamilyId") for s in samples)
    family_overlap = list(train_families.intersection(holdout_families))
    leakage_prevented = (len(family_overlap) == 0 and "60239" not in train_families and "60239" not in holdout_families)

    # 检查图像物理存在性
    image_refs = [img["imagePath"] for s in samples for img in s.get("images", [])]
    existing_images = [p for p in image_refs if (ROOT / p).exists()]
    all_images_exist = (len(image_refs) > 0 and len(image_refs) == len(existing_images))

    report = {
        "evaluationScope": f"Strict Holdout Test ({len(samples)} samples across {sorted(list(holdout_families))})",
        "datasetKind": "synthetic_badge_smoke",
        "checkpoint": str(checkpoint_dir),
        "totalHoldoutSamples": len(samples),
        "metrics": {
            "ML-01_data_leakage_prevented": {
                "passed": leakage_prevented,
                "trainFamilies": sorted(list(train_families)),
                "holdoutFamilies": sorted(list(holdout_families)),
                "familyOverlap": family_overlap,
                "allReferencedImagesExistOnDisk": all_images_exist,
                "totalImageRefs": len(image_refs),
                "existingImageRefs": len(existing_images)
            },
            "ML-02_candidate_coverage": { "eligible": 0, "covered": 0, "rate": 0.0 },
            "ML-03_weights_loadable": {
                "loadable": True,
                "modelType": "BrickVLMCompact",
                "vocabSize": model.vocab_size,
                "embedDim": model.embed_dim,
                "numLayers": model.num_layers,
                "visualEncoderEmbedded": True,
                "device": str(device)
            },
            "ML-04_action_accuracy": {
                "overallTop1": 0.0,
                "overallTop3": 0.0,
                "byDifficulty": {},
                "totalActions": 0
            },
            "ML-05_understanding": {
                "stepExactMatchRate": 0.0,
                "structureDiagnosis": {
                    "tp": 0, "fp": 0, "fn": 0, "tn": 0,
                    "precision": 0.0,
                    "recall": 0.0,
                    "f1": 0.0
                }
            },
            "ML-07_completed_workflows": {
                "status": "unverified",
                "zeroHumanInterventionCount": 0,
                "totalCompleted": 0,
                "note": "离线模型动作排序与结构诊断评估已独立完成；端到端自动化物理装配依赖 Executor A 运行时事务引擎集成"
            },
            "ML-08_honest_status": {
                "abstainCount": 0,
                "humanInterventions": 0,
                "strongModelInterventions": 0,
                "totalEvaluated": len(samples),
                "failureCount": 0,
                "failures": []
            }
        }
    }

    cov = report["metrics"]["ML-02_candidate_coverage"]
    act = report["metrics"]["ML-04_action_accuracy"]
    und = report["metrics"]["ML-05_understanding"]
    failures = report["metrics"]["ML-08_honest_status"]["failures"]

    top1_correct = 0
    top3_correct = 0
    total_actions = 0
    diff_stats = {}

    step_exact = 0
    step_total = 0

    tp, fp, fn, tn = 0, 0, 0, 0

    for s in samples:
        sid = s.get("sampleId")
        ttype = s.get("taskType")
        diff = s.get("provenance", {}).get("difficulty", "standard")
        cands = s.get("candidates", {}).get("items", [])
        target = s.get("target", {})
        target_cid = target.get("primaryAction", {}).get("selectedCandidateId")

        # 真实读取双路图像
        manual_p = str(ROOT / s["images"][0]["imagePath"])
        render_p = str(ROOT / s["images"][1]["imagePath"])
        try:
            manual_tensor = load_image_tensor(manual_p).to(device)
            render_tensor = load_image_tensor(render_p).to(device)
        except Exception as e:
            failures.append({"sampleId": sid, "error": f"Image read error: {e}"})
            continue

        # ML-02 候选覆盖
        if target_cid:
            cov["eligible"] += 1
            cand_ids = [c["candidateId"] for c in cands]
            if target_cid in cand_ids:
                cov["covered"] += 1
            else:
                failures.append({
                    "sampleId": sid,
                    "taskType": ttype,
                    "error": f"Target candidate {target_cid} not in enumerated candidates"
                })

        if cands:
            part_ids = torch.tensor([[int(c["childPartId"][:3]) % 128 if c["childPartId"][:3].isdigit() else 1 for c in cands]], device=device)
            conn_ids = torch.tensor([[int(c["parentConnectorId"].split("_")[-1]) % 128 if c["parentConnectorId"].split("_")[-1].isdigit() else 0 for c in cands]], device=device)
            rot_ids = torch.tensor([[c.get("orientationId", 0) % 24 for c in cands]], device=device)
            cand_feats = {'part_ids': part_ids, 'conn_ids': conn_ids, 'rot_ids': rot_ids}
        else:
            cand_feats = None

        with torch.no_grad():
            outputs = model(cand_feats, manual_tensor=manual_tensor, render_tensor=render_tensor) if cand_feats else None

        # ML-04 动作准确率
        if (ttype == "select_action" or ttype == "repair_local") and outputs is not None:
            total_actions += 1
            diff_stats.setdefault(diff, {"total": 0, "top1": 0, "top3": 0})
            diff_stats[diff]["total"] += 1

            logits = outputs['action_logits'][0]
            sorted_indices = torch.argsort(logits, descending=True).cpu().tolist()

            cand_id_list = [c["candidateId"] for c in cands]
            target_idx = cand_id_list.index(target_cid) if target_cid in cand_id_list else -1

            is_top1 = (sorted_indices[0] == target_idx)
            is_top3 = (target_idx in sorted_indices[:3])

            if is_top1:
                top1_correct += 1
                diff_stats[diff]["top1"] += 1
            else:
                failures.append({
                    "sampleId": sid,
                    "taskType": ttype,
                    "difficulty": diff,
                    "targetCandidate": target_cid,
                    "predictedCandidate": cand_id_list[sorted_indices[0]],
                    "rank": sorted_indices.index(target_idx) + 1 if target_idx in sorted_indices else -1
                })

            if is_top3:
                top3_correct += 1
                diff_stats[diff]["top3"] += 1

        # ML-05 说明书新增件
        elif ttype == "understand_step" and outputs is not None:
            step_total += 1
            pred_part_id = outputs['step_logits'][0].argmax().item()
            inv = s.get("inventory", [])
            tgt_part_id = int(inv[0]["partId"][:3]) % 128 if inv and inv[0]["partId"][:3].isdigit() else 1
            if pred_part_id == tgt_part_id:
                step_exact += 1
            else:
                failures.append({
                    "sampleId": sid,
                    "taskType": ttype,
                    "targetPartId": tgt_part_id,
                    "predictedPartId": pred_part_id
                })

        # ML-05 结构诊断真实 F1 (模型真实推理)
        elif ttype == "understand_structure" and outputs is not None:
            actual_err = target.get("structureDiagnosis", {}).get("hasStructuralError", False)
            struct_logits = outputs['structure_logits'][0]
            pred_err = (struct_logits.argmax().item() == 1)

            if actual_err and pred_err:
                tp += 1
            elif not actual_err and pred_err:
                fp += 1
            elif actual_err and not pred_err:
                fn += 1
            else:
                tn += 1

            if pred_err != actual_err:
                failures.append({
                    "sampleId": sid,
                    "taskType": ttype,
                    "actualError": actual_err,
                    "predictedError": pred_err
                })

    # 统计计算
    cov["rate"] = round(cov["covered"] / max(1, cov["eligible"]), 4)

    act["totalActions"] = total_actions
    act["overallTop1"] = round(top1_correct / max(1, total_actions), 4)
    act["overallTop3"] = round(top3_correct / max(1, total_actions), 4)
    for d, st in diff_stats.items():
        act["byDifficulty"][d] = {
            "top1": round(st["top1"] / max(1, st["total"]), 4),
            "top3": round(st["top3"] / max(1, st["total"]), 4),
            "samples": st["total"]
        }

    und["stepExactMatchRate"] = round(step_exact / max(1, step_total), 4)
    prec = tp / max(1, tp + fp)
    rec = tp / max(1, tp + fn)
    f1 = 2 * prec * rec / max(1e-8, prec + rec)
    und["structureDiagnosis"] = {
        "tp": tp, "fp": fp, "fn": fn, "tn": tn,
        "precision": round(prec, 4),
        "recall": round(rec, 4),
        "f1": round(f1, 4)
    }

    report["metrics"]["ML-08_honest_status"]["failureCount"] = len(failures)

    out_report_path.parent.mkdir(parents=True, exist_ok=True)
    out_report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"\n================ [R5 留出集严格评测报告 (v4 闭环)] ================")
    print(f"评估样本总数: {len(samples)} | 族级隔离无泄漏: {leakage_prevented}")
    print(f"全图物理存在: {all_images_exist} ({len(existing_images)}/{len(image_refs)})")
    print(f"候选覆盖率: {cov['rate']*100:.2f}% ({cov['covered']}/{cov['eligible']})")
    print(f"动作预测 Top-1: {act['overallTop1']*100:.2f}% | Top-3: {act['overallTop3']*100:.2f}% (总动作数: {total_actions})")
    print(f"按难度细分: {act['byDifficulty']}")
    print(f"新增件精确匹配: {und['stepExactMatchRate']*100:.2f}%")
    print(f"结构诊断 F1 (模型真实预测): {und['structureDiagnosis']['f1']} (TP={tp}, FP={fp}, FN={fn}, TN={tn}, P={und['structureDiagnosis']['precision']}, R={und['structureDiagnosis']['recall']})")
    print(f"端到端装配完成: {report['metrics']['ML-07_completed_workflows']['status']} (Honest report)")
    print(f"失败案例总数: {len(failures)}")
    print(f"报告已保存至: {out_report_path}")
    return report

if __name__ == "__main__":
    base_run = ROOT / "out" / "prd-v2" / "run-20261026-v4" / "B"
    ckpt = base_run / "weights" / "r3-pilot-best"
    train_file = base_run / "dataset" / "train.json"
    holdout_file = base_run / "dataset" / "holdout_test.json"
    report_out = base_run / "r5-holdout-report.json"
    run_r5_holdout_eval(ckpt, train_file, holdout_file, report_out)
