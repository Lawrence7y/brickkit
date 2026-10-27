// 观察清单 → 模型 BOM 数值对账模块（纯函数，Node 侧，不进 viewer bundle）。
// 轮廓 IoU 看不见内部结构：本模块把“照片里看到什么”（inventory：候选零件 × 颜色 × 数量区间）
// 与模型 BOM 逐类对账，抓住 IoU 抓不到的数量/颜色错误。
// - checkObservations(obsSet, model, cat) → { ok, errors, warnings, stats }
//   a. inventory 每项：候选×颜色的 BOM 总数量落在 count 区间 → 通过；区间外 → warning 'obs-count'；
//      总数量为 0（完全缺该类）→ error 'obs-missing'
//   b. 反向：模型 BOM 中不被任何 inventory 项覆盖的 (part,color) → 汇总 warning 'model-extra'
//   c. evidence 引用的照片 id 必须在 obsSet.photos 里 → 否则 warning 'obs-evidence'；format 不对 → error 'obs-format'
import { bom } from './core.js';

export const OBS_FORMAT = 'brickbuild-observations';   // 观察清单格式标识（obsSet.format）

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const key = (part, color) => `${part}|${color}`;
// count 归一成 [min, max]：缺省视为不限，单值视为精确数量，单元素数组上限视为不限
const countRange = (c) => (c == null ? [0, Infinity] : Array.isArray(c) ? [c[0] ?? 0, c[1] ?? Infinity] : [c, c]);

/** inventory 单项覆盖的全部 (part,color) 组合键：part 候选 × 颜色集合 的笛卡尔积 */
function coveredKeys(item) {
  const keys = new Set();
  for (const p of asArray(item.part)) for (const c of asArray(item.color)) keys.add(key(p, c));
  return keys;
}

/** 观察清单 ↔ 模型 BOM 对账：数量区间、整类缺失、模型多出零件、证据引用与格式校验 */
export function checkObservations(obsSet, model, cat) {
  const errors = [], warnings = [];
  if (!obsSet || obsSet.format !== OBS_FORMAT) {   // 格式不对：清单结构不可信，不再做其余检查
    return { ok: false, errors: [{ code: 'obs-format', msg: `观察清单 format 应为 "${OBS_FORMAT}"，收到 ${obsSet?.format ?? '(缺失)'}` }], warnings, stats: { inventory: 0 } };
  }
  const photos = new Set(asArray(obsSet.photos).map((p) => p.id).filter(Boolean));
  const rows = bom(model || {}, cat);              // [{ part, color, qty }]：按 (零件×颜色) 聚合
  const qtyOf = new Map(rows.map((r) => [key(r.part, r.color), r.qty]));
  const covered = new Set();
  let matched = 0, countWarnings = 0, missing = 0, evidenceWarnings = 0;

  for (const item of asArray(obsSet.inventory)) {
    const feature = item.feature || '(未命名)';
    const keys = coveredKeys(item);
    for (const k of keys) covered.add(k);
    let total = 0;                                 // 所有候选×颜色组合的 BOM 数量之和
    for (const k of keys) total += qtyOf.get(k) || 0;
    if (total === 0) {                             // 模型中完全缺该类
      missing++;
      errors.push({ code: 'obs-missing', msg: `「${feature}」：模型中完全缺失（候选 ${asArray(item.part).join('/')} × 颜色 ${asArray(item.color).join('/')}，数量 0）`, feature });
    } else {
      const [min, max] = countRange(item.count);
      if (total < min || total > max) {            // 数量落在区间外
        countWarnings++;
        warnings.push({ code: 'obs-count', msg: `「${feature}」：模型实际 ${total} 件，超出观察区间 [${min}, ${max}]`, feature, actual: total, count: [min, max] });
      } else matched++;
    }
    for (const e of asArray(item.evidence)) if (!photos.has(e)) {
      evidenceWarnings++;
      warnings.push({ code: 'obs-evidence', msg: `「${feature}」引用的照片 ${e} 不在观察清单 photos 里`, feature, photo: e });
    }
  }

  // 反向对账：照片里没观察到（不被任何 inventory 项覆盖）却出现在模型里的 (零件×颜色)
  const extras = rows.filter((r) => !covered.has(key(r.part, r.color))).map((r) => ({ part: r.part, color: r.color, qty: r.qty }));
  if (extras.length) {
    warnings.push({ code: 'model-extra', msg: `模型有 ${extras.length} 类 (零件×颜色) 未被任何 inventory 项覆盖：${extras.map((e) => `${e.part}×${e.color}×${e.qty}`).join('、')}`, extras });
  }

  const stats = { inventory: asArray(obsSet.inventory).length, photos: photos.size, bomEntries: rows.length,
    totalParts: rows.reduce((a, r) => a + r.qty, 0), matched, countWarnings, missing, extras: extras.length, evidenceWarnings };
  return { ok: errors.length === 0, errors, warnings, stats };
}
