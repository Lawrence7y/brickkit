"""
tools/brickvlm/model_compact.py — BrickVLM-Compact 领域多模态小模型架构 (v4 闭环版)

设计红线（PRD Section 10 / V3-03 审阅修复）：
1. 完整内嵌视觉编码器：`self.visual_encoder` (CNN) 直接作为模型子模块，权重完全保存进 `model.pt`
2. 双路视觉感知：同时编码说明书目标图 (manual step) 与当前装配状态图 (render state)
3. 纯确定性与可复现性：从检查点加载后，视觉编码器权重完全固定，种子改变绝不导致特征漂移
4. 多任务输出头：
   - Action Head: 候选动作排序 (CrossEntropy over candidate logits)
   - Step Head: 说明书新增件件号预测
   - Structure Head: 结构对齐与错误分类
"""

import os
import json
from pathlib import Path
import torch
import torch.nn as nn
import torch.nn.functional as F

from visual_encoder import SimpleVisualEncoder

class BrickVLMCompact(nn.Module):
    def __init__(self, vocab_size: int = 128, embed_dim: int = 256, num_heads: int = 4, num_layers: int = 3, visual_dim: int = 512):
        super().__init__()
        self.vocab_size = vocab_size
        self.embed_dim = embed_dim
        self.num_heads = num_heads
        self.num_layers = num_layers
        self.visual_dim = visual_dim

        # 零件、连接器与旋转嵌入层
        self.part_embed = nn.Embedding(vocab_size, embed_dim)
        self.conn_embed = nn.Embedding(vocab_size, embed_dim)
        self.rot_embed = nn.Embedding(24, embed_dim)

        # 核心内嵌视觉编码器 (CNN)：权重直接序列化在模型状态字典中
        self.visual_encoder = SimpleVisualEncoder(out_dim=visual_dim)

        # 视觉降维融合层：接收说明书目标图特征 (512) + 当前渲染状态图特征 (512) = 1024 维
        self.visual_proj = nn.Linear(visual_dim * 2, embed_dim)

        # 多层 Transformer 融合编码器
        encoder_layer = nn.TransformerEncoderLayer(
            d_model=embed_dim,
            nhead=num_heads,
            dim_feedforward=embed_dim * 4,
            dropout=0.1,
            batch_first=True
        )
        self.encoder = nn.TransformerEncoder(encoder_layer, num_layers=num_layers)

        # 多任务输出头
        self.action_head = nn.Linear(embed_dim, 1) # 对每个候选输出匹配得分
        self.step_head = nn.Linear(embed_dim, vocab_size) # 预测说明书新增件件号
        self.structure_head = nn.Linear(embed_dim, 2) # 预测是否存在结构异常 (0=正常, 1=异常)

    def extract_visual_embedding(self, manual_tensor: torch.Tensor, render_tensor: torch.Tensor) -> torch.Tensor:
        """从说明书目标图与当前状态图提取联合视觉嵌入 [B, embed_dim]"""
        f_manual = self.visual_encoder(manual_tensor) # [B, 512]
        f_render = self.visual_encoder(render_tensor) # [B, 512]
        f_combined = torch.cat([f_manual, f_render], dim=-1) # [B, 1024]
        return self.visual_proj(f_combined) # [B, embed_dim]

    def forward(self, candidate_features, manual_tensor=None, render_tensor=None, visual_feat=None):
        """
        candidate_features: dict with:
          - part_ids: [B, N] (N: 候选数)
          - conn_ids: [B, N]
          - rot_ids: [B, N]
        manual_tensor: [B, 3, 128, 128] 可选说明书步骤图像
        render_tensor: [B, 3, 128, 128] 可选当前装配渲染图
        visual_feat: [B, embed_dim] 或 [B, 512/1024] 兼容直接传入视觉特征
        """
        device = candidate_features['part_ids'].device

        # 候选离散几何特征嵌入
        p_emb = self.part_embed(candidate_features['part_ids'])
        c_emb = self.conn_embed(candidate_features['conn_ids'])
        r_emb = self.rot_embed(candidate_features['rot_ids'])
        cand_emb = p_emb + c_emb + r_emb # [B, N, D]

        # 视觉特征提取与投射
        if manual_tensor is not None and render_tensor is not None:
            v_emb = self.extract_visual_embedding(manual_tensor, render_tensor).unsqueeze(1) # [B, 1, D]
            tokens = torch.cat([v_emb, cand_emb], dim=1) # [B, 1+N, D]
            has_visual = True
        elif visual_feat is not None:
            if visual_feat.size(-1) == self.embed_dim:
                v_emb = visual_feat.unsqueeze(1)
            elif visual_feat.size(-1) == self.visual_dim * 2:
                v_emb = self.visual_proj(visual_feat).unsqueeze(1)
            else:
                # 兼容旧单路 512 维特征
                padded = torch.cat([visual_feat, visual_feat], dim=-1)
                v_emb = self.visual_proj(padded).unsqueeze(1)
            tokens = torch.cat([v_emb, cand_emb], dim=1)
            has_visual = True
        else:
            tokens = cand_emb
            has_visual = False

        fused = self.encoder(tokens)

        if has_visual:
            ctx_token = fused[:, 0, :]
            cand_tokens = fused[:, 1:, :]
        else:
            ctx_token = fused.mean(dim=1)
            cand_tokens = fused

        # 1. 动作候选排序 logits
        action_logits = self.action_head(cand_tokens).squeeze(-1) # [B, N]

        # 2. 说明书新增件 logits
        step_logits = self.step_head(ctx_token) # [B, vocab_size]

        # 3. 结构分类 logits
        structure_logits = self.structure_head(ctx_token) # [B, 2]

        return {
            'action_logits': action_logits,
            'step_logits': step_logits,
            'structure_logits': structure_logits
        }

    def save_pretrained(self, save_dir: str):
        # 权重只落在调用方给定的模型目录内；文件名是固定字面量，save_dir 由训练入口决定
        target_dir = Path(save_dir)
        target_dir.mkdir(parents=True, exist_ok=True)
        config = {
            'model_type': 'brickvlm_compact',
            'vocab_size': self.vocab_size,
            'embed_dim': self.embed_dim,
            'num_heads': self.num_heads,
            'num_layers': self.num_layers,
            'visual_dim': self.visual_dim
        }
        (target_dir / "config.json").write_text(json.dumps(config, indent=2), encoding="utf-8")
        # 保存完整权重（包含 visual_encoder.conv / fc 所有参数）
        torch.save(self.state_dict(), target_dir / "model.pt")
        print(f"[BrickVLMCompact] 包含完整视觉编码器的模型权重已成功保存至 {target_dir}")

    @classmethod
    def from_pretrained(cls, load_dir: str):
        with open(os.path.join(load_dir, 'config.json'), 'r', encoding='utf-8') as f:
            config = json.load(f)
        model = cls(
            vocab_size=config['vocab_size'],
            embed_dim=config['embed_dim'],
            num_heads=config.get('num_heads', 4),
            num_layers=config.get('num_layers', 3),
            visual_dim=config.get('visual_dim', 512)
        )
        weights_path = os.path.join(load_dir, 'model.pt')
        state_dict = torch.load(weights_path, map_location='cpu', weights_only=True)
        model.load_state_dict(state_dict)
        model.eval()
        print(f"[BrickVLMCompact] 从 {load_dir} 成功加载已训练完整模型（含内嵌视觉编码器）")
        return model
