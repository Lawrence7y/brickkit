"""打包 Colab 评测载荷：只收冻结留出集所需的样本文件与图片。

产出 out/prd-v2/run-20261026-c/C/colab/payload/ 目录，保持原始相对路径，
另附 payload-manifest.json 记录每项 sha256 与总量，供云端解包后核对。
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "out/prd-v2/run-20261026-c/C/data"
SPLIT = DATA / "splits/holdout_test.json"
OUT = ROOT / "out/prd-v2/run-20261026-c/C/colab/payload"


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def read_sample(src: Path, sample_id: str) -> dict | None:
    """样本引用可能指向 .json（单条）或 .jsonl（多条），按 sampleId 定位。"""
    text = src.read_text("utf-8")
    if src.suffix == ".jsonl":
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if obj.get("sampleId") == sample_id:
                return obj
        return None
    obj = json.loads(text)
    return obj if obj.get("sampleId") == sample_id else obj


def resolve_image(ipath: str) -> Path | None:
    """图片路径可能相对仓库根，也可能相对 data/manual/（manual 数据集约定）。"""
    p = ROOT / ipath
    if p.exists():
        return p
    p2 = DATA / "manual" / ipath
    if p2.exists():
        return p2
    return None


def main() -> int:
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    split = json.loads(SPLIT.read_text("utf-8"))
    entries = split["samples"]

    copied: dict[str, dict] = {}
    missing_samples: list[str] = []
    missing_images: list[str] = []
    image_count = 0

    for entry in entries:
        ref = entry.get("sampleRef") or {}
        rel = ref.get("file")
        if not rel:
            missing_samples.append(entry.get("sampleId", "?"))
            continue
        src = ROOT / rel
        if not src.exists():
            missing_samples.append(rel)
            continue

        dst = OUT / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        copied[rel] = {"sha256": sha256_of(dst), "bytes": dst.stat().st_size}

        sample = read_sample(src, entry.get("sampleId", ""))
        if sample is None:
            missing_samples.append(f"{rel}#{entry.get('sampleId')}")
            continue
        for img in sample.get("images") or []:
            ipath = img.get("imagePath")
            if not ipath:
                continue
            isrc = resolve_image(ipath)
            if isrc is None:
                missing_images.append(ipath)
                continue
            idst = OUT / ipath
            if idst.exists():
                continue
            idst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(isrc, idst)
            image_count += 1

    # 划分文件本身也带上（评测器要读 sampleIds）
    split_dst = OUT / "out/prd-v2/run-20261026-c/C/data/splits/holdout_test.json"
    split_dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(SPLIT, split_dst)

    total_bytes = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    manifest = {
        "generatedFrom": str(SPLIT),
        "holdoutSampleCount": len(entries),
        "copiedSampleFiles": len(copied),
        "copiedImages": image_count,
        "missingSamples": missing_samples[:20],
        "missingImages": missing_images[:20],
        "totalFiles": sum(1 for p in OUT.rglob("*") if p.is_file()),
        "totalBytes": total_bytes,
        "totalMiB": round(total_bytes / 2**20, 1),
        "files": copied,
    }
    (OUT.parent / "payload-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), "utf-8"
    )
    print(json.dumps({k: v for k, v in manifest.items() if k != "files"}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
