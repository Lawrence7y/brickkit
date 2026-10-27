"""Read-only CPU tensor loading and deterministic inference for the embedded v4 CNN."""
import json
import sys
from pathlib import Path
import torch
ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'tools/brickvlm'))
from model_compact import BrickVLMCompact
from visual_encoder import load_image_tensor
torch.set_num_threads(1)
base = ROOT / 'out/prd-v2/run-20261026-v4/B'
config = json.loads((base / 'weights/r3-pilot-best/config.json').read_text(encoding='utf-8-sig'))
weights = torch.load(base / 'weights/r3-pilot-best/model.pt', map_location='cpu', weights_only=True)
samples = json.loads((base / 'dataset/holdout_test.json').read_text(encoding='utf-8-sig'))[:16]
all_logits = []
for seed in (123, 456):
    torch.manual_seed(seed)
    model = BrickVLMCompact(**{key: config[key] for key in ('vocab_size', 'embed_dim', 'num_heads', 'num_layers', 'visual_dim') if key in config})
    model.load_state_dict(weights)
    model.eval()
    logits = []
    for sample in samples:
        candidates = sample['candidates']['items']
        features = {
            'part_ids': torch.tensor([[int(c['childPartId'][:3]) % 128 for c in candidates]]),
            'conn_ids': torch.tensor([[int(c['parentConnectorId'].split('_')[-1]) % 128 for c in candidates]]),
            'rot_ids': torch.tensor([[c['orientationId'] % 24 for c in candidates]]),
        }
        manual = load_image_tensor(str(ROOT / sample['images'][0]['imagePath']))
        render = load_image_tensor(str(ROOT / sample['images'][1]['imagePath']))
        with torch.no_grad():
            output = model(features, manual_tensor=manual, render_tensor=render)
        logits.append(output['action_logits'])
    all_logits.append(torch.cat(logits))
print(json.dumps({
    'checkpointLoadedWeightsOnly': True,
    'embeddedVisualStateKeys': sum(key.startswith('visual_encoder.') for key in weights),
    'allWeightsFinite': all(torch.isfinite(value).all().item() for value in weights.values()),
    'modelParameterCount': sum(parameter.numel() for parameter in model.parameters()),
    'sampleCount': len(samples), 'seeds': [123, 456],
    'maxAbsActionLogitDifference': (all_logits[0] - all_logits[1]).abs().max().item(),
}, indent=2))
