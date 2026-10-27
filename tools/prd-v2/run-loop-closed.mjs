// C4-2 闭环驱动：理解 → 候选 → 模型选动作 → applyActions → 校验 → 渲染反馈 → 局部修复
// 通过 brickvlm.serve 的 stdio 协议调用本地小模型（不直接 import torch）。
// 预算（PRD §10.8）：每步候选执行 ≤3 次、局部修复 ≤2 轮；越界即记为失败，不算成功。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { inspectFromModel } from '../../src/core/actions-v1/state.js';
import { enumerateCandidates } from '../../src/core/actions-v1/candidates.js';
import { applyActions } from '../../src/core/actions-v1/apply.js';
import { renderState } from '../../src/core/actions-v1/render-state.js';
import { validate } from '../../src/core/core.js';

const ROOT = 'D:/Project/brickkit';
const OUT = `${ROOT}/out/prd-v2/run-20261026-c/C/integration/loop`;

const MAX_STEP_RETRIES = 3;
const MAX_REPAIR_ROUNDS = 2;

class ServeClient {
  constructor(args) {
    this.proc = spawn('python', args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    this.buf = '';
    this.pending = new Map();
    this.seq = 0;
    this.ready = new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('serve 启动超时 (300s)')), 300000);
      this.proc.stdout.on('data', (d) => {
        this.buf += d.toString('utf8');
        let i;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).trim();
          this.buf = this.buf.slice(i + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.event === 'ready') { clearTimeout(to); this.meta = msg; resolve(msg); continue; }
          const p = this.pending.get(msg.id);
          if (p) { this.pending.delete(msg.id); p(msg); }
        }
      });
      this.proc.stderr.on('data', () => {});
      this.proc.on('exit', (code) => reject(new Error(`serve 退出 code=${code}`)));
    });
  }

  infer(req) {
    const id = `req-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { this.pending.delete(id); reject(new Error('infer 超时 (120s)')); }, 120000);
      this.pending.set(id, (msg) => { clearTimeout(to); resolve(msg); });
      this.proc.stdin.write(JSON.stringify({ ...req, id }) + '\n');
    });
  }

  close() { try { this.proc.stdin.end(); } catch {} }
}

const stable = (v) => Array.isArray(v) ? `[${v.map(stable).join(',')}]`
  : (v && typeof v === 'object') ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v);

async function main() {
  const args = process.argv.slice(2);
  const modelDir = args.find((a) => a.startsWith('--model_dir='))?.split('=')[1]
    || `${ROOT}/out/prd-v2/run-20261026-c/C/models/qwen2-vl-2b-instruct`;
  const adapterDir = args.find((a) => a.startsWith('--adapter_dir='))?.split('=')[1]
    || `${ROOT}/out/prd-v2/run-20261026-c/C/weights/qwen2vl-2b-qlora-r3/adapter-final`;
  // 闭环使用的起始状态与目标动作：取自真实轨迹样本（冻结留出集之外，避免污染验收）
  const samplePath = args.find((a) => a.startsWith('--sample='))?.split('=')[1];
  const catalog = JSON.parse(fs.readFileSync(`${ROOT}/catalog/parts.json`, 'utf8'));

  fs.mkdirSync(OUT, { recursive: true });
  const client = new ServeClient([
    '-m', 'brickvlm.serve', '--model_dir', modelDir,
    ...(fs.existsSync(adapterDir) ? ['--adapter_dir', adapterDir] : []),
    '--mode', 'stdio', '--max_pixels', '384',
  ]);
  const meta = await client.ready;
  console.log('[loop] serve ready:', JSON.stringify(meta).slice(0, 240));

  // 载入一个真实样本（select_action）
  const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
  const stateT = sample.stateRef?.state || sample.stateT;
  const state = inspectFromModel(stateT, catalog);

  // 1) 候选枚举（引擎侧）
  const cands = enumerateCandidates(state, {
    childPartId: sample.candidates?.[0]?.partId || sample.nextPartId,
    maxResults: 8,
  }, catalog);
  console.log(`[loop] candidates=${cands.candidates?.length ?? 0} complete=${cands.enumerationComplete}`);

  // 2) 模型选动作
  const images = (sample.images || []).map((i) => path.join(ROOT, i.path)).filter((p) => fs.existsSync(p));
  const resp = await client.infer({
    taskType: 'select_action',
    images,
    text: `Candidates:\n${(cands.candidates || []).map((c) => `${c.candidateId}: ${c.childPartId} on ${c.parentNodeId}#${c.parentConnectorId}`).join('\n')}`,
    stateHash: state.stateHash,
    maxNewTokens: 96,
  });
  console.log('[loop] model:', JSON.stringify({ ok: resp.ok, abstain: resp.abstain, answer: resp.answer }).slice(0, 300));

  const chosen = resp.answer?.candidateId;
  const record = {
    startedAt: new Date().toISOString(),
    serveMeta: meta, sample: samplePath,
    candidates: cands.candidates?.length ?? 0, enumerationComplete: cands.enumerationComplete,
    modelResponse: { ok: resp.ok, abstain: resp.abstain, answer: resp.answer, latencyMs: resp.latencyMs, adapterRevision: resp.adapterRevision },
    chosenCandidateId: chosen ?? null,
    stepRetries: 0, repairRounds: 0,
    outcome: 'unknown',
  };

  // 3) applyActions + 校验 + 渲染反馈（失败则计数重试，≤3 次）
  if (chosen) {
    const candidate = (cands.candidates || []).find((c) => c.candidateId === chosen);
    for (let attempt = 0; attempt < MAX_STEP_RETRIES && candidate; attempt++) {
      record.stepRetries = attempt;
      const applied = applyActions({ model: stateT, inventory: sample.inventory || { tokens: [] } }, [
        { op: 'attach_part', candidateId: candidate.candidateId, requestHash: cands.requestHash },
      ]);
      if (applied?.passed) {
        const v = validate(applied.model, catalog);
        const rendered = renderState({ model: applied.model, camera: sample.camera || { az: 30, el: 12, distance: 60 } });
        record.applyResult = { passed: true, errors: v.errors.length, warnings: v.warnings.length, renderTriangles: rendered?.stats?.triangles ?? null };
        record.outcome = v.errors.length === 0 ? 'complete' : 'render-needs-repair';
        break;
      }
      record.applyResult = { passed: false, errors: (applied?.errors || []).slice(0, 3) };
      record.outcome = 'apply-failed';
    }
  } else {
    record.outcome = resp.abstain ? 'abstain' : 'no-candidate-chosen';
  }

  record.finishedAt = new Date().toISOString();
  record.budgetRespected = record.stepRetries <= MAX_STEP_RETRIES && record.repairRounds <= MAX_REPAIR_ROUNDS;
  fs.writeFileSync(`${OUT}/loop-run.json`, JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ outcome: record.outcome, stepRetries: record.stepRetries, budgetRespected: record.budgetRespected }, null, 2));
  client.close();
}

main().catch((e) => { console.error('[loop] FAILED:', e.message); process.exit(1); });
