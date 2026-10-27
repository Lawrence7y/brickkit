/**
 * tools/lib/open-studs.mjs —— 「空闲凸点」计算（BrickVLM 合成数据引擎共享库）
 *
 * 来源说明（重要）：
 *   本文件是 `cli/brickkit.mjs` 中 `computeOpenStuds()`（第 944–966 行）的**逐行复制**。
 *   该命令行的 `render --show-studs` 用它决定在画面上标注哪些凸点标签（`p019#4`），
 *   因此训练样本里「可用凸点列表」必须与画面上真实画出来的标签**完全同源**，
 *   否则模型被要求引用一个画面上不存在的标签。
 *   按任务边界（`cli/brickkit.mjs` 由另一任务并行修改，禁止改），这里不做 import，只做复制；
 *   若 CLI 侧逻辑变更，需要同步本文件的 `close` 容差与注释掉的过滤条件。
 *
 * 与 CLI 唯一差异：catalog 由调用方传入（CLI 里是模块级常量 `cat`），函数体逻辑保持一致。
 */

/** 连接点重合判定容差（水平 0.08 格 / 竖直 0.20 片 / 水平 0.08 格）—— 与 partsConnected 同口径 */
const CLOSE = (p1, p2) => Math.abs(p1[0] - p2[0]) <= 0.08
  && Math.abs(p1[1] - p2[1]) <= 0.20
  && Math.abs(p1[2] - p2[2]) <= 0.08;

/**
 * 计算某个装配状态下仍然空闲的凸点。
 * 逻辑与 cli/brickkit.mjs#computeOpenStuds 一致：
 *   1) 只取 `p.step <= stepMax` 的零件（stepMax=null 表示全部）且零件必须在目录里；
 *   2) 逐件取 partConnectors().studs，若任一「同时活跃」零件的任一受体与该凸点位置重合 → 已被占用；
 *   3) 未被占用则输出 { id, part, stud, kind, dir, pos, label }，label = `${id}#${stud}`。
 *
 * @param {object} model   .brick.json 模型对象
 * @param {object} cat     { parts, colors } 合并目录（curated + ext）
 * @param {{ stepMax?: number|null, filterParts?: Set<string>|null, partConnectors: Function }} opts
 * @returns {Array<{id:string, part:string, stud:number, kind:string, dir:string, pos:number[], label:string}>}
 */
export function computeOpenStuds(model, cat, { stepMax = null, filterParts = null, partConnectors } = {}) {
  if (typeof partConnectors !== 'function') {
    throw new Error('computeOpenStuds：必须传入 partConnectors（src/core/core.js 的实现），避免与引擎口径漂移');
  }
  const active = (model.parts || []).filter((p) => p && cat.parts[p.part] && (stepMax === null || p.step <= stepMax));
  const connMap = new Map();
  for (const p of active) connMap.set(p.id, partConnectors(p, cat.parts[p.part]));
  const open = [];
  for (const p of active) {
    if (filterParts && !filterParts.has(p.id)) continue;
    const conn = connMap.get(p.id);
    for (const s of conn.studs) {
      let occupied = false;
      for (const q of active) {
        if (q.id === p.id) continue;
        if (connMap.get(q.id).receptors.some((r) => CLOSE(s.pos, r.pos))) { occupied = true; break; }
      }
      if (!occupied) {
        open.push({ id: p.id, part: p.part, stud: s.index, kind: s.kind, dir: s.dir, pos: s.pos, label: `${p.id}#${s.index}` });
      }
    }
  }
  return open;
}

/**
 * 只保留「来自基准状态零件」的空闲凸点，并按 step 归属过滤。
 * 训练样本的凸点候选只能来自第 t−1 步及更早的零件——否则模型会引用画面外/未安装的零件标签。
 *
 * @param {Array} openStuds computeOpenStuds 的返回值（建议 stepMax = t−1）
 * @param {Set<string>} baseIds 基准状态（step < t）的零件 id 集合
 */
export function filterToBaseState(openStuds, baseIds) {
  return openStuds.filter((s) => baseIds.has(s.id));
}
