#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
brickvlm.serve — BrickVLM 版本化推理服务（PRD §10.8 R4 / C4-1）

让 Node 侧通过版本化 JSON（stdin/stdout 单行 NDJSON，或 HTTP）调用本地小模型。
每次响应都携带引擎要求的元信息：基座、adapter revision、协议版本、stateHash。

协议（contracts-1.0 inference-protocol 对齐）：
  请求  {"id": str, "taskType": "select_action|understand_structure|repair_local|understand_step",
         "images": [absPath, ...], "text": str, "stateHash": str|null, "maxNewTokens": int}
  响应  {"id": str, "ok": bool, "raw": str, "answer": obj|null,
         "base": str, "baseRevision": str, "adapterRevision": str|null,
         "protocolVersion": "1.0.0", "stateHash": str|null,
         "abstain": bool, "latencyMs": int, "vramPeakMiB": int, "error": str|null}

用法：
  python -m brickvlm.serve --model_dir <base> [--adapter_dir <adapter>] [--mode stdio|http] [--port 8765]

红线：不伪造权重；adapter 加载失败直接报错退出，不静默回退到基座伪装成微调模型。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

PROTOCOL_VERSION = "1.0.0"

INSTRUCTIONS = {
    "select_action": "Pick the ONE candidate action that turns the current state into the target state. Answer with JSON only.",
    "understand_structure": "List the structural problems you see. Answer with JSON only.",
    "repair_local": "Give the minimal repair action sequence. Answer with JSON only.",
    "understand_step": "List the new parts added in this manual step. Answer with JSON only.",
}


def _dir_hash(p: Path) -> str:
    """稳定目录哈希（文件名排序后逐个哈希再聚合）。"""
    h = hashlib.sha256()
    for f in sorted(p.rglob("*")):
        if f.is_file():
            h.update(f.relative_to(p).as_posix().encode())
            h.update(f.read_bytes())
    return h.hexdigest()


class BrickVLMService:
    def __init__(self, model_dir: str, adapter_dir: str | None, max_pixels: int = 448):
        import torch
        from transformers import AutoProcessor, AutoModelForVision2Seq

        self.torch = torch
        self.model_dir = Path(model_dir)
        self.adapter_dir = Path(adapter_dir) if adapter_dir else None
        self.processor = AutoProcessor.from_pretrained(model_dir, max_pixels=max_pixels * max_pixels)
        self.model = AutoModelForVision2Seq.from_pretrained(
            model_dir, torch_dtype=torch.bfloat16, device_map={"": 0}, attn_implementation="eager",
        ).eval()
        if self.adapter_dir:
            from peft import PeftModel
            if not self.adapter_dir.exists():
                raise SystemExit(f"adapter 目录不存在: {self.adapter_dir}（拒绝以基座冒充微调模型）")
            self.model = PeftModel.from_pretrained(self.model, str(self.adapter_dir)).eval()
        self.baseRevision = _dir_hash(self.model_dir)[:16]
        self.adapterRevision = _dir_hash(self.adapter_dir)[:16] if self.adapter_dir else None

    def infer(self, req: dict) -> dict:
        from PIL import Image

        t0 = time.time()
        task = req.get("taskType")
        if task not in INSTRUCTIONS:
            return {"id": req.get("id"), "ok": False, "error": f"unknown taskType: {task}",
                    "protocolVersion": PROTOCOL_VERSION}
        try:
            images = [Image.open(p).convert("RGB") for p in (req.get("images") or [])]
            text = f"{INSTRUCTIONS[task]}\n\n{req.get('text') or ''}".strip()
            content = [{"type": "image"} for _ in images] + [{"type": "text", "text": text}]
            prompt = self.processor.apply_chat_template(
                [{"role": "user", "content": content}], tokenize=False, add_generation_prompt=True)
            inputs = self.processor(text=[prompt], images=images, return_tensors="pt", padding=True).to("cuda")
            with self.torch.no_grad():
                gen = self.model.generate(**inputs, max_new_tokens=int(req.get("maxNewTokens") or 160), do_sample=False)
            raw = self.processor.batch_decode(gen[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True)[0]
            answer = _extract_json(raw)
            # abstain：模型输出无法解析为结构化答案，或明确表示不确定
            abstain = answer is None or any(k in raw.lower() for k in ("cannot determine", "unknown", "not sure", "无法判断"))
            return {
                "id": req.get("id"), "ok": True, "raw": raw, "answer": answer,
                "base": str(self.model_dir), "baseRevision": self.baseRevision,
                "adapterRevision": self.adapterRevision, "protocolVersion": PROTOCOL_VERSION,
                "stateHash": req.get("stateHash"), "abstain": bool(abstain),
                "latencyMs": int((time.time() - t0) * 1000),
                "vramPeakMiB": int(self.torch.cuda.max_memory_reserved() / (1024 ** 2)),
                "error": None,
            }
        except Exception as e:
            return {
                "id": req.get("id"), "ok": False, "error": f"{type(e).__name__}: {e}",
                "base": str(self.model_dir), "baseRevision": self.baseRevision,
                "adapterRevision": self.adapterRevision, "protocolVersion": PROTOCOL_VERSION,
                "stateHash": req.get("stateHash"),
                "latencyMs": int((time.time() - t0) * 1000), "abstain": True,
            }


def _extract_json(text: str):
    import re
    if not text:
        return None
    m = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    pools = [m.group(1)] if m else []
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
                        return json.loads(pool[start:i + 1])
                    except Exception:
                        start = None
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model_dir", required=True)
    ap.add_argument("--adapter_dir", default=None)
    ap.add_argument("--mode", choices=["stdio", "http"], default="stdio")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--max_pixels", type=int, default=448)
    args = ap.parse_args()

    svc = BrickVLMService(args.model_dir, args.adapter_dir, args.max_pixels)
    meta = {"ready": True, "base": args.model_dir, "baseRevision": svc.baseRevision,
            "adapterRevision": svc.adapterRevision, "protocolVersion": PROTOCOL_VERSION, "mode": args.mode}

    if args.mode == "stdio":
        sys.stdout.write(json.dumps({"event": "ready", **meta}) + "\n")
        sys.stdout.flush()
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except Exception as e:
                sys.stdout.write(json.dumps({"ok": False, "error": f"bad request json: {e}"}) + "\n")
                sys.stdout.flush()
                continue
            resp = svc.infer(req)
            sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        return 0

    from http.server import BaseHTTPRequestHandler, HTTPServer

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(meta).encode())

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            try:
                req = json.loads(self.rfile.read(n) or b"{}")
                resp = svc.infer(req)
                code = 200
            except Exception as e:
                resp, code = {"ok": False, "error": str(e)}, 400
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(resp, ensure_ascii=False).encode())

        def log_message(self, *a):  # 静默
            pass

    print(json.dumps({"event": "listening", "host": args.host, "port": args.port, **meta}))
    HTTPServer((args.host, args.port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
