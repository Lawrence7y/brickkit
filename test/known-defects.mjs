// 示例模型的「已知未解决缺陷」登记表。
//
// 为什么需要它：这些模型曾被校验器判为零错误零警告，但那个结论来自校验器**不检查**那些维度。
// 补上检查后，旧模型暴露出真实缺陷，于是回归测试不能再写「0 errors 0 warnings」。
//
// 登记粒度是「错误码 + 零件集合 + 数量」三者同时匹配：
//   - 只按错误码过滤会太宽——同一个码多冒几处（例如再多 3 个 mount-disconnected）也能通过，
//     那样就失去了「不让同类问题扩大」的作用；
//   - 因此每条登记都写明**受影响的零件**，测试逐条比对集合与条数，任何新增/替换都会失败。
//
// 修好某一项后应从对应 key 里删掉那几条——删条目即等于收紧门禁。
//
// 详见 docs/实物机甲验收目标.md「已确认的根因」。

/** 把 validate 的 errors/warnings 压成可比较的「code:排序后的零件 id」多重集 */
export function defectKeys(list = []) {
  return list
    .map((e) => `${e.code}:${(e.parts || []).slice().sort().join('+')}`)
    .sort();
}

/** 登记表里的条目也走同一规格化，避免手写顺序与运行时顺序不一致 */
const normalize = (keys = []) => keys.map((k) => {
  const i = k.indexOf(':');
  if (i < 0) return k;
  return `${k.slice(0, i)}:${k.slice(i + 1).split('+').sort().join('+')}`;
}).sort();

/**
 * mecha 的已知缺陷（逐条列明受影响零件）。
 *
 * 2026-11：errors 已清零。原 11 项全部由「把柄被错提取成两端支撑环」引起——48336 的真实把柄是
 * 4-4cylo 的一根连续杆，夹板只要夹在杆上任意位置就成立；旧实现按两个点判重合，于是
 * 6 处 mount 扣不上 → 4 片翼悬空 → 无铰接候选 → 转轴对不上 → 白名单里堆了 11 项。
 * 修好杆段语义后，6 块夹板按杆轴重新落位（只动 y/z，x 由杆段跨度吸收，不改外观排布），
 * 两个翼关节的 pivot 改到真实杆轴 y=20、行程改成「向外张开」（前翼 −30..0 / 后翼 0..30），
 * 整机成为单一刚体（分量 1）。
 *
 * 仍保留的 2 条 warning 是**真实拓扑**，不是缺陷：左右两片翼各由一套独立夹板夹在同一根
 * 虚拟轴线上，中间隔着机身，几何共轴但拓扑上是两个刚体。要消掉它只能把左右翼拆成两个
 * mechanism（会丢掉「双翼联动」语义）或在两翼之间补一段结构件（改外观），属设计取舍。
 */
export const KNOWN_DEFECTS = {
  mecha: {
    errors: [].sort(),
    warnings: [
      'mech-rigid:p56+p57+p58+p59',
      'mech-rigid:p60+p61+p62+p63',
    ].sort(),
  },
};

/**
 * 校验某模型的错误/警告是否**恰好等于**登记集合。
 *
 * 必须是**多重集**比较，不能只判存在性：同一个「错误码 + 零件集合」若出现两次
 * （例如同一条 mount-disconnected 被重复报告），`includes` 会认为它在登记表里就通过，
 * 条数翻倍也发现不了。所以逐 key 比对出现次数。
 *
 * 返回 { ok, added, missing }：
 *   - added   = 实际出现次数多于登记（同类问题扩大了）→ 测试失败
 *   - missing = 登记多于实际（问题被修好了，或登记放宽了）→ 测试失败，提示收紧
 */
export function compareDefects(modelName, result) {
  const known = KNOWN_DEFECTS[modelName] || { errors: [], warnings: [] };
  const count = (keys) => {
    const m = new Map();
    for (const k of keys) m.set(k, (m.get(k) || 0) + 1);
    return m;
  };
  const diff = (expectedKeys, actualKeys) => {
    const exp = count(normalize(expectedKeys));
    const act = count(actualKeys);
    const added = [], missing = [];
    for (const [k, n] of act) if (n > (exp.get(k) || 0)) added.push(n - (exp.get(k) || 0) > 1 ? `${k} ×${n}（登记 ${exp.get(k) || 0}）` : k);
    for (const [k, n] of exp) if (n > (act.get(k) || 0)) missing.push(n - (act.get(k) || 0) > 1 ? `${k}（登记 ${n}，实际 ${act.get(k) || 0}）` : k);
    return { added, missing };
  };
  const e = diff(known.errors, defectKeys(result.errors));
  const w = diff(known.warnings, defectKeys(result.warnings));
  return {
    ok: !e.added.length && !e.missing.length && !w.added.length && !w.missing.length,
    added: [...e.added.map((k) => `error ${k}`), ...w.added.map((k) => `warning ${k}`)],
    missing: [...e.missing.map((k) => `error ${k}`), ...w.missing.map((k) => `warning ${k}`)],
  };
}
