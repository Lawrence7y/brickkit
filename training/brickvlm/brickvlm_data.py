#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
brickvlm_data.py — BrickVLM 真实像素数据适配层（PRD v2 / contracts-1.0 C3 样本契约）。

职责（C2-2，替代 v4 脚本中的模拟字段路径）：
  1. 从 run-20261026-c/C/data 下四类真实数据源读取样本：
       trajectory/families/*/samples.jsonl                    -> select_action
       perturbation/families/*/samples.understand_structure.jsonl -> understand_structure
       perturbation/families/*/samples.repair_local.jsonl     -> repair_local
       manual/samples/*.json                                  -> understand_step
  2. 每条样本：按 taskType 选择图像角色 -> 用 PIL 读真实像素 -> processor 真实编码，
     产生真实 pixel_values / image_grid_thw。全程禁止 simulated 字段（校验函数 assert_no_simulated）。
  3. assistant-only 标签：prompt 部分 token 全部 -100，仅训练 assistant 响应 token；
     前缀一致性强校验（prompt 编码结果必须是全量编码的前缀），并提供 decode 往返校验工具。
  4. 多模态 collator：Qwen2-VL patch embedding 要求 batch 内 pixel_values 沿 patch 维拼接，
     image_grid_thw 逐图堆叠；labels 用 -100 pad；input_ids 用 pad_token pad。

图像角色选择（每任务最多 2 张，6GB 显存预算下控制视觉 token 总量 <= ~512）：
  select_action      : current_labeled | current_rendered_state  +  target_state | target_manual_step
  understand_structure: current_rendered_state(labeled)           +  auxiliary_view
  repair_local       : current_rendered_state(labeled)           +  repair_diagnosis | auxiliary_view
  understand_step    : target_manual_step                        +  candidate_part（最多 1 张）

注意：trajectory 样本 role 为 current_labeled / target_state / score_unlabeled（历史拼写），
contracts-1.0 冻结版枚举为 current_rendered_state 等；本适配层两者都认。
"""

from __future__ import annotations

import glob
import hashlib
import json
from pathlib import Path
from typing import Any, Iterator

import torch
from PIL import Image

TASK_TYPES = ("select_action", "understand_structure", "repair_local", "understand_step")

# 每任务的图像角色优先级（主图在前，辅图在后；最多取 MAX_IMAGES_PER_SAMPLE 张）
IMAGE_ROLE_PRIORITY = {
    "select_action": (["current_labeled", "current_rendered_state"],
                      ["target_state", "target_manual_step", "score_unlabeled"]),
    "understand_structure": (["current_rendered_state", "current_labeled"],
                             ["auxiliary_view"]),
    "repair_local": (["current_rendered_state", "current_labeled"],
                     ["repair_diagnosis", "auxiliary_view"]),
    "understand_step": (["target_manual_step"],
                        ["candidate_part"]),
}
MAX_IMAGES_PER_SAMPLE = 2
MAX_INTERFACE_LABELS = 48  # 接口标号列表上限，超出则截断并如实标注

INSTRUCTIONS = {
    "select_action": (
        "You are a LEGO assembly action selector. Image 1 is the current assembly state with "
        "neutral numeric interface labels; Image 2 is the target state after the correct action. "
        "Pick the ONE action that turns Image 1 into Image 2. Answer with JSON only."
    ),
    "understand_structure": (
        "You are a LEGO structure inspector. Image 1 is the current assembly state with neutral "
        "numeric interface labels; Image 2 is an auxiliary view of the same state. Compare it "
        "against the intended structure described by the candidates and report structural errors. "
        "Answer with JSON only."
    ),
    "repair_local": (
        "You are a LEGO repair planner. Image 1 is the current (faulty) assembly state with "
        "neutral numeric interface labels; Image 2 is a diagnosis view. Output the minimal "
        "corrective action sequence using the given candidates. Answer with JSON only."
    ),
    "understand_step": (
        "You are a LEGO manual step reader. Image 1 is the build area of one manual step; "
        "Image 2 is a callout crop of a part used in this step. Report which parts (partId, "
        "colorId, qty) are added in this step. Answer with JSON only."
    ),
}


# --------------------------------------------------------------------------- #
# 样本枚举
# --------------------------------------------------------------------------- #

def resolve_data_roots(repo_root: Path | str, data_root: Path | str | None = None) -> list[Path]:
    """返回图像路径解析根目录列表：repo 根 + manual 数据根（manual 样本路径相对其自身）。"""
    repo_root = Path(repo_root).resolve()
    roots = [repo_root]
    if data_root is not None:
        data_root = Path(data_root).resolve()
        roots.append(data_root)
        roots.append(data_root / "manual")
    return roots


def resolve_image_path(rel_path: str, roots: list[Path]) -> Path:
    p = Path(rel_path)
    if p.is_absolute() and p.exists():
        return p
    for r in roots:
        cand = r / rel_path
        if cand.exists():
            return cand
    raise FileNotFoundError(f"image not found under any root: {rel_path} (roots={[str(x) for x in roots]})")


def iter_dataset_samples(data_root: Path | str, tasks: list[str] | None = None,
                         limit: int | None = None) -> Iterator[dict]:
    """遍历四类真实数据源，yield {sample, taskType, source}。样本本身不复制不修改。"""
    data_root = Path(data_root)
    want = set(tasks or TASK_TYPES)
    emitted = 0

    sources: list[tuple[str, list[Path], str]] = []
    if "select_action" in want:
        sources.append(("select_action", sorted(glob.glob(str(data_root / "trajectory/families/*/samples.jsonl"))),
                        "trajectory"))
    if "understand_structure" in want:
        sources.append(("understand_structure",
                        sorted(glob.glob(str(data_root / "perturbation/families/*/samples.understand_structure.jsonl"))),
                        "perturbation"))
    if "repair_local" in want:
        sources.append(("repair_local",
                        sorted(glob.glob(str(data_root / "perturbation/families/*/samples.repair_local.jsonl"))),
                        "perturbation"))
    if "understand_step" in want:
        sources.append(("understand_step", sorted(glob.glob(str(data_root / "manual/samples/*.json"))), "manual"))

    for task, files, source in sources:
        for fp in files:
            if source == "manual":
                obj = json.loads(Path(fp).read_text(encoding="utf-8"))
                yield {"sample": obj, "taskType": task, "source": source, "path": fp}
                emitted += 1
                if limit and emitted >= limit:
                    return
            else:
                with open(fp, encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        yield {"sample": json.loads(line), "taskType": task, "source": source, "path": fp}
                        emitted += 1
                        if limit and emitted >= limit:
                            return


# --------------------------------------------------------------------------- #
# 图像选择与真实像素加载
# --------------------------------------------------------------------------- #

def pick_images(sample: dict, task_type: str) -> list[dict]:
    """按任务角色优先级挑图，返回 images 子集（保持样本原字段，只读）。"""
    primary_roles, aux_roles = IMAGE_ROLE_PRIORITY[task_type]
    images = sample.get("images", [])
    chosen: list[dict] = []

    def take(role_names: list[str], cap: int) -> None:
        for role in role_names:
            for img in images:
                if img.get("role") == role and img not in chosen:
                    chosen.append(img)
                    if len(chosen) >= cap:
                        return
            if len(chosen) >= cap:
                return

    take(primary_roles, 1)  # 主图恰好 1 张
    take(aux_roles, MAX_IMAGES_PER_SAMPLE - 1)
    if not chosen:
        raise ValueError(f"no usable image for task {task_type} in sample {sample.get('sampleId')}")
    return chosen[:MAX_IMAGES_PER_SAMPLE]


def load_real_pixels(sample: dict, task_type: str, roots: list[Path],
                     verify_sha: bool = True) -> tuple[list[Image.Image], list[dict]]:
    """读取真实像素（RGB）。verify_sha=True 时校验 imageSha256，不匹配即抛错（诚实失败）。"""
    pil_images, metas = [], []
    for img in pick_images(sample, task_type):
        path = resolve_image_path(img["imagePath"], roots)
        if verify_sha:
            h = hashlib.sha256(path.read_bytes()).hexdigest()
            if h != img["imageSha256"]:
                raise ValueError(f"image sha mismatch for {path}: manifest={img['imageSha256']} actual={h}")
        im = Image.open(path)
        im.load()
        pil_images.append(im.convert("RGB"))
        metas.append({k: img[k] for k in ("role", "imagePath", "labeled") if k in img} | {"resolvedPath": str(path)})
    return pil_images, metas


# --------------------------------------------------------------------------- #
# prompt / answer 构造（统一协议，每 taskType 一个格式）
# --------------------------------------------------------------------------- #

def _interface_label_lines(sample: dict) -> list[str]:
    labels = (sample.get("interfaceMap") or {}).get("labels") or []
    lines = []
    for lb in labels[:MAX_INTERFACE_LABELS]:
        lines.append(f"{lb.get('tag')}: part={lb.get('partInstanceId')} conn={lb.get('connectorId')} ({lb.get('dir')})")
    if len(labels) > MAX_INTERFACE_LABELS:
        lines.append(f"(…{len(labels) - MAX_INTERFACE_LABELS} more interface labels truncated)")
    return lines


def _candidate_lines(sample: dict) -> list[str]:
    cands = (sample.get("candidates") or {}).get("items") or []
    lines = []
    for c in cands:
        if "op" in c:
            parts = [f"{c['candidateId']}: op={c['op']}"]
            if c.get("childPartId"):
                parts.append(f"child={c['childPartId']}")
            if c.get("colorId") is not None:
                parts.append(f"color={c['colorId']}")
            if c.get("parentInstanceId") and c.get("parentInstanceId") != "none":
                parts.append(f"parent={c['parentInstanceId']}")
            if c.get("parentConnectorId") and c.get("parentConnectorId") != "none":
                parts.append(f"parentConn={c['parentConnectorId']}")
            if c.get("childConnectorId") and c.get("childConnectorId") != "none":
                parts.append(f"childConn={c['childConnectorId']}")
            if c.get("orientationId") is not None:
                parts.append(f"orient={c['orientationId']}")
            if c.get("spinDeg"):
                parts.append(f"spin={c['spinDeg']}")
            if c.get("snot"):
                parts.append(f"snot={c['snot']}")
            lines.append(" - " + ", ".join(parts))
        else:  # understand_structure 的结构描述候选
            at = c.get("at")
            lines.append(f" - {c['candidateId']}: part={c.get('childPartId')} color={c.get('colorId')} "
                         f"orient={c.get('orientationId')} at={at}")
    return lines


def _available_inventory(sample: dict) -> list[str]:
    inv = sample.get("inventory") or []
    agg: dict[tuple, int] = {}
    for t in inv:
        if t.get("state") == "available":
            key = (t.get("partId"), t.get("colorId"))
            agg[key] = agg.get(key, 0) + 1
    return [f" - {pid} color={cid} x{qty}" for (pid, cid), qty in sorted(agg.items())]


def build_answer(sample: dict, task_type: str) -> str:
    """assistant 响应（标签真值），全部来自样本 target/groundTruth 字段，绝不来自生成公式。"""
    if task_type == "select_action":
        tgt = sample.get("target") or {}
        pa = tgt.get("primaryAction") or {}
        ans = {"selectedCandidateId": pa.get("selectedCandidateId"),
               "equivalentCandidates": tgt.get("equivalentCandidates", [])}
        if pa.get("op") == "abstain":
            ans = {"op": "abstain", "abstainReason": pa.get("abstainReason")}
        return json.dumps(ans, ensure_ascii=False)
    if task_type == "understand_structure":
        sd = (sample.get("target") or {}).get("structureDiagnosis") or {}
        ans = {"hasStructuralError": sd.get("hasStructuralError"),
               "errorType": sd.get("errorType"),
               "faultyPartInstances": sd.get("faultyPartInstances", [])}
        return json.dumps(ans, ensure_ascii=False)
    if task_type == "repair_local":
        tgt = sample.get("target") or {}
        seq = [{"op": s.get("op"), "selectedCandidateId": s.get("selectedCandidateId")}
               for s in (tgt.get("correctiveSequence") or [])]
        return json.dumps({"correctiveSequence": seq}, ensure_ascii=False)
    if task_type == "understand_step":
        gt = sample.get("groundTruth") or {}
        parts = [{"partId": p.get("partId"), "colorId": p.get("colorId"), "qty": p.get("qty")}
                 for p in (gt.get("partsAdded") or [])]
        return json.dumps({"partsAdded": parts,
                           "isAssemblyEvent": gt.get("isAssemblyEvent", False),
                           "isFlip": gt.get("isFlip")}, ensure_ascii=False)
    raise ValueError(f"unknown taskType {task_type}")


def build_user_text(sample: dict, task_type: str) -> str:
    chunks = [INSTRUCTIONS[task_type]]
    n_img = len(pick_images(sample, task_type))
    if n_img == 2:
        chunks.append("Image 1 is the primary view; Image 2 is the auxiliary view as described above.")
    if task_type == "select_action":
        chunks.append("Available inventory (partId color qty):")
        chunks.extend(_available_inventory(sample) or [" - (none listed)"])
    label_lines = _interface_label_lines(sample)
    if label_lines:
        chunks.append("Interface labels in Image 1 (tag: part connector):")
        chunks.extend(label_lines)
    cand_lines = _candidate_lines(sample)
    if cand_lines:
        header = {"select_action": "Candidate actions:",
                  "repair_local": "Candidate actions:",
                  "understand_structure": "Intended structure (candidates):",
                  "understand_step": "Candidate part calls:"}[task_type]
        chunks.append(header)
        chunks.extend(cand_lines)
    chunks.append("Respond with the JSON answer only.")
    return "\n".join(chunks)


def build_messages(sample: dict, task_type: str, roots: list[Path],
                   verify_sha: bool = True) -> tuple[list[dict], list[Image.Image], list[dict]]:
    """构造 Qwen 风格多模态对话：user(图像+文本) -> assistant(JSON 答案)。"""
    pil_images, metas = load_real_pixels(sample, task_type, roots, verify_sha=verify_sha)
    user_content: list[dict] = []
    for i, m in enumerate(metas):
        user_content.append({"type": "image", "image": m["resolvedPath"]})
    user_content.append({"type": "text", "text": build_user_text(sample, task_type)})
    messages = [
        {"role": "user", "content": user_content},
        {"role": "assistant", "content": [{"type": "text", "text": build_answer(sample, task_type)}]},
    ]
    return messages, pil_images, metas


# --------------------------------------------------------------------------- #
# processor 编码 + assistant-only 标签
# --------------------------------------------------------------------------- #

def encode_sample(processor, sample: dict, task_type: str, roots: list[Path],
                  max_pixels: int = 448 * 448, min_pixels: int = 56 * 56,
                  verify_sha: bool = True, image_transform=None) -> dict:
    """真实像素 -> processor -> input_ids/labels/pixel_values/image_grid_thw（全部真实，无模拟字段）。

    image_transform: 可选 PIL->PIL 预处理（探针用它做等预算降采样）；训练路径默认 None。
    """
    messages, pil_images, metas = build_messages(sample, task_type, roots, verify_sha=verify_sha)
    if image_transform is not None:
        pil_images = [image_transform(im) for im in pil_images]

    full_text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=False)
    prompt_messages = [messages[0]]
    prompt_text = processor.apply_chat_template(prompt_messages, tokenize=False, add_generation_prompt=True)

    common = dict(images=pil_images, return_tensors="pt")
    try:  # transformers 4.49+ 用 max_pixels kwarg；旧版读 preprocessor_config
        full = processor(text=[full_text], max_pixels=max_pixels, min_pixels=min_pixels, **common)
        prompt = processor(text=[prompt_text], max_pixels=max_pixels, min_pixels=min_pixels, **common)
    except TypeError:
        full = processor(text=[full_text], **common)
        prompt = processor(text=[prompt_text], **common)

    input_ids = full["input_ids"]
    prompt_len = prompt["input_ids"].shape[1]
    # 硬校验：prompt 编码必须是全量编码的严格前缀（保证掩码位置正确）
    if not torch.equal(input_ids[0, :prompt_len], prompt["input_ids"][0]):
        raise RuntimeError(
            f"assistant mask prefix mismatch for {sample.get('sampleId')}: "
            f"prompt_ids[:{prompt_len}] != full_ids[:{prompt_len}]")

    labels = input_ids.clone()
    labels[:, :prompt_len] = -100
    if not (labels != -100).any():
        raise RuntimeError(f"empty assistant labels for {sample.get('sampleId')}")

    item = {
        "input_ids": input_ids[0],
        "attention_mask": full["attention_mask"][0],
        "labels": labels[0],
        "pixel_values": full["pixel_values"],
        # Qwen2-VL 返回 image_grid_thw；InternVL(HF) 不返回（视觉 token 数 = image_seq_length × 图数），
        # 其前向也不需要 grid —— None 是合法状态，不是 simulated
        "image_grid_thw": full["image_grid_thw"] if "image_grid_thw" in full else None,
        "sample_id": sample.get("sampleId", ""),
        "task_type": task_type,
        "prompt_len": int(prompt_len),
        "image_meta": metas,
    }
    assert_no_simulated(item)
    return item


def assert_no_simulated(obj: Any, path: str = "$") -> None:
    """递归断言：任何键/值不得含 'simulated'（C2-2 红线：真实像素路径）。"""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if "simulated" in str(k).lower():
                raise AssertionError(f"simulated key forbidden: {path}.{k}")
            assert_no_simulated(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            assert_no_simulated(v, f"{path}[{i}]")
    elif isinstance(obj, str):
        if "simulated" in obj.lower():
            raise AssertionError(f"simulated value forbidden at {path}: {obj[:80]}")


def decode_roundtrip(processor, item: dict) -> dict:
    """标签掩码往返校验：被掩掉（labels=-100）区域应解码回 prompt，未掩（labels!=-100）区域
    应解码为 assistant 答案。字段名以 labels 语义为准。"""
    ids = item["input_ids"].unsqueeze(0)
    labels = item["labels"].unsqueeze(0)
    pad = processor.tokenizer.pad_token_id
    masked_out_ids = ids.clone()      # labels == -100 的 token（被掩掉的部分 = prompt）
    masked_out_ids[labels != -100] = pad
    unmasked_ids = ids.clone()        # labels != -100 的 token（参与损失 = assistant 答案）
    unmasked_ids[labels == -100] = pad
    keep = lambda t: t[t != pad]
    masked_region_text = processor.tokenizer.decode(keep(masked_out_ids[0]), skip_special_tokens=False)
    unmasked_region_text = processor.tokenizer.decode(keep(unmasked_ids[0]), skip_special_tokens=False)
    return {"masked_region_text": masked_region_text, "unmasked_region_text": unmasked_region_text}


# --------------------------------------------------------------------------- #
# 多模态 collator（Qwen2-VL patch embedding 要求 patch 维拼接）
# --------------------------------------------------------------------------- #

class BrickVLMMultimodalCollator:
    """将 encode_sample 输出 pad 成 batch：
       - input_ids / attention_mask / labels 右 pad（pad_token / 1 / -100）
       - pixel_values 沿 patch 维(dim 0) cat，image_grid_thw 逐图 cat —— Qwen2-VL 视觉塔约定
    """

    def __init__(self, processor):
        self.processor = processor
        self.pad_token_id = processor.tokenizer.pad_token_id
        if self.pad_token_id is None:
            self.pad_token_id = processor.tokenizer.eos_token_id

    def __call__(self, features: list[dict]) -> dict:
        batch_size = len(features)
        max_len = max(f["input_ids"].shape[-1] for f in features)

        input_ids = torch.full((batch_size, max_len), self.pad_token_id, dtype=torch.long)
        attention_mask = torch.zeros((batch_size, max_len), dtype=torch.long)
        labels = torch.full((batch_size, max_len), -100, dtype=torch.long)

        pixel_values = torch.cat([f["pixel_values"] for f in features], dim=0)
        grids = [f.get("image_grid_thw") for f in features]
        image_grid_thw = torch.cat(grids, dim=0) if all(g is not None for g in grids) else None

        for i, f in enumerate(features):
            seq_len = f["input_ids"].shape[-1]
            input_ids[i, :seq_len] = f["input_ids"]
            attention_mask[i, :seq_len] = f["attention_mask"]
            labels[i, :seq_len] = f["labels"]

        out = {"input_ids": input_ids, "attention_mask": attention_mask, "labels": labels,
               "pixel_values": pixel_values, "image_grid_thw": image_grid_thw}
        assert_no_simulated({k: (v.shape if torch.is_tensor(v) else v) for k, v in out.items()})
        return out
