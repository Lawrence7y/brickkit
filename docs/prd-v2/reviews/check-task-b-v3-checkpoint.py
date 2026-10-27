"""Read-only CPU check. Loads tensors with weights_only=True; never trains or rewrites checkpoint."""
import json
import sys
from pathlib import Path
import torch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tools' / 'brickvlm'))
from model_compact import BrickVLMCompact
from visual_encoder import SimpleVisualEncoder

torch.set_num_threads(1)
base = ROOT / 'out/prd-v2/run-20261026-v3/B'
config = json.loads((base / 'weights/r3-pilot-best/config.json').read_text(encoding='utf-8-sig'))
weights = torch.load(base / 'weights/r3-pilot-best/model.pt', map_location='cpu', weights_only=True)
model = BrickVLMCompact(vocab_size=config['vocab_size'], embed_dim=config['embed_dim'], num_heads=config['num_heads'], num_layers=config['num_layers'])
model.load_state_dict(weights)
model.eval()
samples = json.loads((base / 'dataset/holdout_test.json').read_text(encoding='utf-8-sig'))[:16]
all_features, all_logits = [], []
for seed in (123, 456):
    torch.manual_seed(seed)
    encoder = SimpleVisualEncoder(512)
    encoder.eval()
    features, logits = [], []
    for sample in samples:
        candidates = sample['candidates']['items']
        candidate_features = {
            'part_ids': torch.tensor([[int(c['childPartId'][:3]) % 128 for c in candidates]]),
            'conn_ids': torch.tensor([[int(c['parentConnectorId'].split('_')[-1]) % 128 for c in candidates]]),
            'rot_ids': torch.tensor([[c['orientationId'] % 24 for c in candidates]]),
        }
        visual = encoder.extract_from_path(str(ROOT / sample['images'][1]['imagePath'])).unsqueeze(0)
        with torch.no_grad():
            output = model(candidate_features, visual_feat=visual)
        features.append(visual)
        logits.append(output['action_logits'])
    all_features.append(torch.cat(features))
    all_logits.append(torch.cat(logits))
print(json.dumps({
    'checkpointLoadedWeightsOnly': True,
    'modelParameterCount': sum(p.numel() for p in model.parameters()),
    'allWeightsFinite': all(torch.isfinite(value).all().item() for value in weights.values()),
    'visualEncoderKeysInCheckpoint': [key for key in weights if key.startswith(('conv.', 'visual_encoder.'))],
    'visualFeatureRequiresGrad': all_features[0].requires_grad,
    'samplesProbed': len(samples),
    'encoderSeeds': [123, 456],
    'maxAbsFeatureDifference': (all_features[0] - all_features[1]).abs().max().item(),
    'maxAbsActionLogitDifference': (all_logits[0] - all_logits[1]).abs().max().item(),
    'actionArgmaxChanged': (all_logits[0].argmax(-1) != all_logits[1].argmax(-1)).sum().item(),
}, indent=2))
