// 供执行者 A 合入 cli/brickkit.mjs 的注册片段
// 增加 manual-v2 观察提取与 workflow 主从流程 CLI 入口

import { extractManualObservations } from '../src/manual-v2/extractor.js';
import { runWorkflowPlan, executeFourStepWorkflow } from '../src/manual-v2/workflow.js';

export function registerManualWorkflowCommands(cli) {
  // 1. brickkit manual extract <pdf-or-pages-dir> --bom <bom.json> -o <out.json>
  cli.command('manual-extract')
    .argument('<input>', '说明书 PDF 文件或渲染页面目录')
    .option('--bom <file>', '官方或参考 BOM 文件路径')
    .option('-o, --output <file>', '输出 observations.json 文件路径')
    .action(async (input, opts) => {
      const observations = await extractManualObservations(input, { bomFile: opts.bom });
      fs.writeFileSync(opts.output, JSON.stringify(observations, null, 2));
      console.log(`[manual-extract] 观察已成功提取至: ${opts.output}`);
    });

  // 2. brickkit workflow plan <observations.json> --bom <bom.json> -o <plan.json>
  cli.command('workflow-plan')
    .argument('<observations>', '说明书观察文件路径')
    .option('--bom <file>', 'BOM 清单文件路径')
    .option('-o, --output <file>', '输出 build.plan.json 文件路径')
    .action(async (obsFile, opts) => {
      const plan = await runWorkflowPlan(obsFile, opts.bom);
      fs.writeFileSync(opts.output, JSON.stringify(plan, null, 2));
      console.log(`[workflow-plan] 规划蓝图已生成至: ${opts.output}`);
    });

  // 3. brickkit workflow run <plan.json> --out-dir <dir>
  cli.command('workflow-run')
    .argument('<plan>', 'build.plan.json 文件路径')
    .option('--out-dir <dir>', '产物输出目录')
    .action(async (planFile, opts) => {
      const result = await executeFourStepWorkflow(planFile, { outDir: opts.outDir });
      console.log(`[workflow-run] 工作流执行结果:`, result.status);
    });
}
