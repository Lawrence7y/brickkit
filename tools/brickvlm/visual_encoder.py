"""
tools/brickvlm/visual_encoder.py — 轻量级真实视觉特征提取器 (CNN)

规范要求：
1. 作为 BrickVLMCompact 的内嵌模块，权重保存进 model.pt
2. 真实读取磁盘图像 (128x128x3 RGB)，归一化为张量
3. 纯前向计算支持梯度更新与评估推理
"""

import os
import hashlib
import numpy as np
import torch
import torch.nn as nn
from PIL import Image

def load_image_tensor(image_path: str, target_size=(128, 128)) -> torch.Tensor:
    """真实读取图像并转为 [1, 3, H, W] 归一化浮点张量"""
    if not os.path.exists(image_path):
        raise FileNotFoundError(f"图像文件不存在: {image_path}")

    img = Image.open(image_path).convert("RGB").resize(target_size)
    arr = np.array(img, dtype=np.float32) / 255.0  # [128, 128, 3]
    tensor = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0)  # [1, 3, 128, 128]
    return tensor

class SimpleVisualEncoder(nn.Module):
    def __init__(self, out_dim: int = 512):
        super().__init__()
        self.out_dim = out_dim
        self.conv = nn.Sequential(
            nn.Conv2d(3, 32, kernel_size=7, stride=2, padding=3),
            nn.BatchNorm2d(32),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(kernel_size=2, stride=2),
            nn.Conv2d(32, 64, kernel_size=3, stride=2, padding=1),
            nn.BatchNorm2d(64),
            nn.ReLU(inplace=True),
            nn.MaxPool2d(kernel_size=2, stride=2),
            nn.Conv2d(64, 128, kernel_size=3, stride=2, padding=1),
            nn.BatchNorm2d(128),
            nn.ReLU(inplace=True),
            nn.AdaptiveAvgPool2d((2, 2))
        )
        self.fc = nn.Linear(128 * 2 * 2, out_dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        """输入 [B, 3, 128, 128] -> 输出 [B, out_dim]"""
        feat = self.conv(x)
        feat = feat.view(feat.size(0), -1)
        return self.fc(feat)
