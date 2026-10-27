# -*- coding: utf-8 -*-
"""
brickvlm_qlora.py — BrickVLM QLoRA 模型构建与损失路径（C2-1/C2-2 权威实现）。

被 train_qwen_qlora.py 消费；探针脚本（env/c2_1_probe.py）持有一份自包含拷贝作证据。
要点：
  - BitsAndBytesConfig NF4 + double quant + bf16 compute；
  - 视觉塔冻结（动态内省校验：可训练参数一律不得位于视觉塔）；
  - LoRA r=16 挂 LLM 的 q/k/v/o/gate/up/down（按真实 named_modules 动态生成 regex，fullmatch）；
  - 梯度检查点（use_reentrant=False）+ use_cache=False；
  - assistant-only sliced-CE：只在 labels != -100 位置上取 hidden states 过 lm_head，
    避开全词表 logits 的 fp32 上采样显存大头（6GB 显存的关键节省项）；
  - VRAM 门禁：torch reserved > 3.4 GiB 即抛 HardwareInsufficient，绝不静默回退 CPU。
"""

from __future__ import annotations

import re

import torch

VRAM_ALERT_GIB = 3.4
VRAM_ALERT_BYTES = int(VRAM_ALERT_GIB * 2**30)
PROJ_NAMES = ("q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj")


class HardwareInsufficient(RuntimeError):
    """显存门禁触发（reserved > 阈值）。训练必须中止并如实上报，不得转 CPU。"""


def vram_snapshot() -> dict:
    free, total = torch.cuda.mem_get_info(0)
    return {"cuda_free_bytes": free, "cuda_total_bytes": total,
            "torch_allocated_bytes": torch.cuda.memory_allocated(),
            "torch_reserved_bytes": torch.cuda.memory_reserved(),
            "peak_allocated_bytes": torch.cuda.max_memory_allocated(),
            "peak_reserved_bytes": torch.cuda.max_memory_reserved()}


def vram_guard(stage: str, limit_bytes: int = VRAM_ALERT_BYTES, abort: bool = True) -> dict:
    """torch reserved 超阈值即中止（WDDM 下超限的表现是 sysmem fallback 慢 10x，必须主动拦截）。"""
    torch.cuda.synchronize()
    snap = vram_snapshot()
    snap["stage"] = stage
    snap["alert"] = snap["torch_reserved_bytes"] > limit_bytes
    if snap["alert"] and abort:
        raise HardwareInsufficient(
            f"VRAM guard at [{stage}]: torch reserved {snap['torch_reserved_bytes'] / 2**30:.2f} GiB "
            f"> {limit_bytes / 2**30:.2f} GiB —— 按 C2-2 规范中止（hardware_insufficient），不回退 CPU。")
    return snap


def build_bnb_config() -> "object":
    from transformers import BitsAndBytesConfig
    return BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )


def load_model_and_processor(model_dir: str, arch: str = "qwen2_vl", max_pixels: int | None = None):
    """arch: qwen2_vl | internvl_hf。返回 (processor, model)。模型整体上 GPU（device_map={'':0}），绝无 CPU offload。"""
    from transformers import AutoProcessor

    if arch == "qwen2_vl":
        from transformers import Qwen2VLForConditionalGeneration
        kw = {"max_pixels": max_pixels, "min_pixels": 28 * 28} if max_pixels else {}
        processor = AutoProcessor.from_pretrained(model_dir, **kw)
        model = Qwen2VLForConditionalGeneration.from_pretrained(
            model_dir, quantization_config=build_bnb_config(), dtype=torch.bfloat16,
            device_map={"": 0})
    elif arch == "internvl_hf":
        from transformers import AutoModelForImageTextToText
        processor = AutoProcessor.from_pretrained(model_dir)
        if max_pixels and hasattr(processor, "image_processor"):
            ip = processor.image_processor
            if hasattr(ip, "max_pixels"):
                ip.max_pixels = max_pixels
            if hasattr(ip, "max_patches"):  # 448px/tile；等预算换算 tile 数
                ip.max_patches = max(1, round(max_pixels / (448 * 448)))
            if hasattr(ip, "min_patches"):
                ip.min_patches = 1
        model = AutoModelForImageTextToText.from_pretrained(
            model_dir, quantization_config=build_bnb_config(), dtype=torch.bfloat16,
            device_map={"": 0})
    else:
        raise ValueError(f"unknown arch {arch}")
    return processor, model


def _vision_name_leak(arch: str, name: str) -> bool:
    if arch == "qwen2_vl":
        return name.split(".")[0] == "visual" or "visual" in name.split(".")
    return ("vision_model" in name or "vision_tower" in name
            or "mlp1" in name or "multi_modal_projector" in name)


def apply_qlora(model, arch: str = "qwen2_vl", lora_r: int = 16, lora_alpha_mult: int = 2,
                lora_dropout: float = 0.05) -> tuple[object, dict]:
    """冻结视觉塔与 embedding，LoRA 只挂 LLM 7 类线性层，开梯度检查点。返回 (peft_model, info)。"""
    from peft import LoraConfig, get_peft_model

    # 1) 视觉塔冻结（QLoRA 冻结视觉铁律；子模块名随 transformers 版本不同，做版本容忍解析）
    if arch == "qwen2_vl":
        model.visual.requires_grad_(False)
    elif arch == "internvl_hf":
        inner = getattr(model, "model", None)
        vm = (getattr(model, "vision_model", None) or getattr(model, "vision_tower", None)
              or getattr(inner, "vision_model", None) or inner.vision_tower)
        vm.requires_grad_(False)
        pr = (getattr(model, "mlp1", None) or getattr(model, "multi_modal_projector", None)
              or getattr(inner, "mlp1", None) or inner.multi_modal_projector)
        pr.requires_grad_(False)
    model.get_input_embeddings().requires_grad_(False)
    try:
        model.get_output_embeddings().requires_grad_(False)
    except AttributeError:
        pass

    # 2) 梯度检查点 + use_cache=False
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.enable_input_require_grads()
    model.config.use_cache = False

    # 3) 动态内省 LLM 线性层（绝不含视觉塔），生成 fullmatch regex
    proj_re = re.compile(r"(?:" + "|".join(PROJ_NAMES) + r")$")
    llm_names = [n for n, m in model.named_modules()
                 if proj_re.search(n) and isinstance(m, torch.nn.Linear)
                 and not _vision_name_leak(arch, n)]
    if not llm_names:
        raise RuntimeError("no LLM projection modules found for LoRA targeting")
    regex = r".*(?:" + "|".join(re.escape(n) for n in llm_names) + r")"
    lora_config = LoraConfig(r=lora_r, lora_alpha=lora_r * lora_alpha_mult, target_modules=regex,
                             lora_dropout=lora_dropout, bias="none", task_type="CAUSAL_LM")
    model = get_peft_model(model, lora_config)

    trainable = [(n, p.numel()) for n, p in model.named_parameters() if p.requires_grad]
    leak = [n for n, _ in trainable
            if ("visual" in n or "vision_model" in n or "vision_tower" in n
                or "mlp1" in n or "multi_modal_projector" in n)]
    if leak:
        raise RuntimeError(f"vision tower NOT frozen, trainable leak: {leak[:3]}")
    info = {"trainable_params": sum(c for _, c in trainable),
            "trainable_tensors": len(trainable),
            "lora_target_module_count": len(llm_names),
            "lora_target_examples": llm_names[:3],
            "vision_frozen": True}
    # HF 梯度检查点门 = `self.gradient_checkpointing and self.training`：必须进 train 模式，
    # 否则检查点静默失效、eval 下全量激活驻留（C2-1 探针实测教训，见 env/c2-1-probe-qwen-448-firstrun-overbudget.json）
    model.train()
    return model, info


def make_optimizer(model) -> "torch.optim.Optimizer":
    import bitsandbytes as bnb
    trainable = [p for p in model.parameters() if p.requires_grad]
    return bnb.optim.AdamW8bit(trainable, lr=1e-4)  # lr 由调用方覆盖


def forward_loss(model, arch: str, batch: dict) -> "torch.Tensor":
    """assistant-only sliced-CE。peft 链：PeftModel.base_model(LoraModel).model = ForConditionalGeneration。"""
    forcond = model.base_model.model if hasattr(model, "base_model") else model
    if arch == "qwen2_vl":
        base, lm_head = forcond.model, forcond.lm_head
        out = base(input_ids=batch["input_ids"], attention_mask=batch["attention_mask"],
                   pixel_values=batch["pixel_values"], image_grid_thw=batch["image_grid_thw"],
                   use_cache=False)
    elif arch == "internvl_hf":
        # InternVLModel.forward 不接受 image_grid_thw（patch 布局打包在 pixel_values 内）
        base = forcond.model
        lm_head = getattr(forcond, "lm_head", None) or forcond.language_model.lm_head
        out = base(input_ids=batch["input_ids"], attention_mask=batch["attention_mask"],
                   pixel_values=batch["pixel_values"],
                   use_cache=False)
    else:
        raise ValueError(f"unknown arch {arch}")
    hidden = out.last_hidden_state
    shift_labels = batch["labels"][:, 1:]
    keep = shift_labels != -100
    sel_hidden = hidden[:, :-1][keep]
    logits = lm_head(sel_hidden)
    return torch.nn.functional.cross_entropy(logits.float(), shift_labels[keep])
