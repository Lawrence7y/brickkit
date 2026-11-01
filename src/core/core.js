// brickbuild 核心：坐标换算、3D 实体防穿模碰撞检测、凸点/底孔/把柄/夹子真实物理扣合计算、步骤计划、零件清单、LDraw 导出、照片完整性检查。
// 纯函数，不依赖 DOM / Node，可同时用于网页查看器与命令行（Harness）。

export const FORMAT = 'brickbuild';
export const VERSION = '0.2';
export const PLATE = 0.4;              // 1 片高度（以“格”为单位：3.2mm / 8.0mm = 0.4 格，即 5 片 = 2 格）
const ROTS = [0, 90, 180, 270];
export const UPS = ['+y', '-y', '+z', '-z', '+x', '-x'];

// ───────────────────────── 目录合并：唯一权威实现 ─────────────────────────
//
// 历史问题：`{ ...ext, ...curated }` 曾被复制到 CLI / 查看器 / tools / 测试共 10 处。
// 那是**条目级整体替换**——精选目录只要定义过某个件，扩展目录里该件的实测接口
// （bars / clips / holes / axleHoles，由 LDraw 官方几何自动提取）就整条消失，
// 连接器退回按 kind 猜的合成位置。于是「能看图、装不上」：零件外形对、接口位置错。
//
// 现在的合并规则（按字段，不按条目）：
//   · 精选目录优先决定「这件是什么」（kind / size / h / 名称 / 分类等标量）——人手核对过；
//   · 实测连接器数组只要精选目录**没有显式给出**，就从扩展目录继承——位置是量出来的；
//   · 两边都给时取精选目录，但用 catalogInterfaceConflicts() 报冲突，不允许悄悄覆盖。
export const MEASURED_CONNECTOR_FIELDS = ['bars', 'clips', 'holes', 'axleHoles', 'sideStuds'];

/**
 * 精选目录未覆盖时，允许从扩展目录继承的字段——它们都由官方 .dat 几何实测或反推，
 * 不是品类猜测：
 *   · studs / studCells / centerStuds / subGrid —— 顶面凸点数与格位（官方凸点图元逐个数的）
 *   · antistudCells / antistudSource        —— 底面反凸点格位（官方底腔图元）
 *   · pins                                  —— 外凸销（与 bars/clips/holes 同族）
 * 刻意**不**继承的：boxes / boxesSource / boxesCoverage（生成器按品类推断的近似碰撞盒，
 * 精选目录常刻意改用单盒）、kind / size / h（零件身份由精选目录决定）、tile / grid / auto /
 * source（生成器元数据）。默认全继承会把「推断」当「实测」用。
 */
export const INHERITED_FIELDS = [
  'studs', 'studCells', 'centerStuds', 'subGrid', 'antistudCells', 'antistudSource', 'pins', 'offGrid',
];

/**
 * 实测连接器坐标属于**扩展目录的局部坐标系**。精选目录若把 size 的 x/z 互换了
 * （例如 63868 实测 [2,1]、精选记 [1,2]），同一组局部坐标会落到另一个物理面上，
 * 直接继承会把把柄搬到错的地方。这类件的坐标须绕竖直轴旋转 90° 才能对齐。
 *
 * 这里只做「能否安全继承」的判定，不猜旋转方向：判不了的返回 null，由冲突报告暴露，
 * 不允许静默继承一个可能错位的接口。
 */
function measuredFrame(extDef, curatedDef) {
  const es = extDef && extDef.size, cs = curatedDef && curatedDef.size;
  if (!Array.isArray(es) || !Array.isArray(cs)) return 'unknown';
  if (es[0] === cs[0] && es[1] === cs[1]) return 'same';
  if (es[0] === cs[1] && es[1] === cs[0]) return 'rotated';
  return 'mismatch';
}

/**
 * 坐标类继承字段：它们的**语义**是「在这件零件的本地网格里，凸点/底孔落在哪一格」。
 *
 * 与 `studs`（一个数量）不同，这些是坐标；一旦两套目录对 size / h 的声明不一致，
 * 同一组数字就指向另一个物理位置。实测两例：
 *   · 3839b：精选 size [1,2]，扩展 [3,2]（把柄臂被算进占地），
 *     继承来的 centerStuds 是 **3×2 网格的中心** [[-0.5,-0.5],[0.5,-0.5]]，
 *     落到精选框架里就是两格之间的接缝，而不是两个真实凸点。
 *   · 4081b：精选 h=1，扩展 h=2 且 studCells 带 ly=1.25 ——
 *     继承后声明的顶凸点比真实凸点高出 0.25 片（2 LDU）。
 *
 * 所以这些字段只在「size 与 h 都一致」时才允许继承；不一致就**不继承**（宁可少一个
 * 实测坐标，也不要一个坐标系错的坐标），由 `catalogInterfaceFrameConflicts()` 报出来。
 * 空数组是「实测为无」的明确结论，不受此限。
 */
const COORD_INHERITED_FIELDS = new Set(['studCells', 'centerStuds', 'antistudCells']);
// 注：`subGrid` 曾经也被列进来，但它是**布尔标记**（生成器里 `rawSx<1 || rawSz<1 || rawH<1`），
// 不是坐标，core.js 里也没有任何消费者。把它当坐标会产生"假降级"：
// 4274/30374/60623/87994 四件会出现在坐标系冲突账上，而它们一个坐标都没丢。
// 独立验收发现并纠正了这一点。

/**
 * 两套目录的**原点定义不同**：扩展目录按「几何最低点」标注 `ldrawOrigin`，
 * 精选目录按「安装面」标注。于是同一件零件、同一个物理位置，在两套里差一个
 * 恒定的高度偏移 —— 这个偏移量恰好等于 `e.ldrawOrigin[1] - c.ldrawOrigin[1]`。
 *
 * 实测三例（`frameShiftPlates` → 观测残差）：
 *   18677: 2.38 − 1 = 1.38 片 = 11.04 LDU → 声明销孔比真实孔口低 11 LDU
 *   2444 : 同上            = 11.04 LDU → 11 LDU
 *   4081b: 1.25 − 1 = 0.25 片 =  2.00 LDU → 声明凸点比真实凸点高 2 LDU
 *
 * 关键结论：**这不是"目录 h 写错"，而是坐标系不同**。所以正确做法是
 * **重锚定**（把 ly 减去这个偏移，保持在同一个物理位置），而不是丢弃接口。
 * 丢弃会让 18677/2444 失去 Technic 板的核心销孔接口（实测这两件的重锚定误差仅 0.04 LDU）。
 *
 * @returns {number} 片为单位的偏移；无法判定时 0（不重锚定，也不丢弃）
 */
function frameShiftPlates(extDef, curatedDef, datumLdu = null) {
  const eo = Array.isArray(extDef?.ldrawOrigin) ? Number(extDef.ldrawOrigin[1]) : NaN;
  if (!Number.isFinite(eo)) return 0;
  /**
   * 有生产 datum 时以它为准：`extOrigin(片)*8 − datum(LDU)` 折回片。
   * 这才是"ext 坐标要平移多少才能落进生产框架"的精确答案。
   * 实测对照（ext−datum vs ext−h）：
   *   60623  0.005 片  vs  −0.870 片   ← h 近似把 0.04 LDU 放大成 −6.96 LDU
   *   92946  0.000 片  vs  −2.000 片   ← 斜面件 datum 与 h×8 无关
   *   18677  1.380 片  vs   1.380 片   ← 两者一致
   */
  if (Number.isFinite(datumLdu)) return (eo * 8 - datumLdu) / 8;
  const co = Array.isArray(curatedDef?.ldrawOrigin) ? Number(curatedDef.ldrawOrigin[1]) : NaN;
  if (!Number.isFinite(co)) return 0;
  return eo - co;
}

/**
 * 重锚定一条 `[[lx, ly, lz, ...], ...]` 坐标数组的 ly（单位：格，与 lx/lz 一致）。
 *
 * 单位说明（此处踩过两次，写清楚）：
 *   · 数组里的 ly 与 lx/lz 同单位 = **格**（`localToWorld` 三分量同单位；
 *     生成器 `tools/gen-parts-catalog.mjs:338` 注释亦写「ly 单位 = 格」）。
 *   · `frameShiftPlates` 用**片**表示（`ldrawOrigin[1]` 的单位）。
 *   · 两者换算：1 片 = PLATE(=0.4) 格。
 * 所以位移量必须先 ×PLATE 再减。实测校核（18677）：
 *   原 ly=0.45 格（= 9.04 LDU 低于几何最低点），shift=1.38 片；
 *   目标 ly = -0.1 格（真实 connhole y=10，datum=8 → (8−10)/20）；
 *   0.45 − 1.38×0.4 = 0.45 − 0.552 = −0.102 ✓
 */
function reanchorCoords(arr, deltaLy, deltaXZ = null) {
  if (!Array.isArray(arr) || (!deltaLy && !deltaXZ)) return arr;
  return arr.map((row) => {
    if (!Array.isArray(row) || row.length < 2) return row;
    const out = row.slice();
    out[1] = Math.round((Number(row[1]) - deltaLy) * 1e6) / 1e6;
    if (deltaXZ && out.length > 2) {
      out[0] = Math.round((Number(row[0]) + deltaXZ[0]) * 1e6) / 1e6;
      out[2] = Math.round((Number(row[2]) + deltaXZ[1]) * 1e6) / 1e6;
    }
    return out;
  });
}

/**
 * 重锚定「格位 + 可选 ly」字段（`studCells`/`antistudCells` 是 `[[i,k,ly?],...]`，
 * `centerStuds` 是 `[[cx,cz,ly?],...]`）。ly 在第 3 位（单位=**片**，与 def.h 同口径），
 * 缺省时表示「顶面」—— 那种情况不写死 ly 反而更安全（由 `studLevels()` 按 def.h 补），
 * 所以缺省项原样保留。
 *
 * 注意这里的 ly 是**片**，而连接器数组的 ly 是**格**：两套字段单位不同，
 * 各自用各自的换算（见 `frameShiftPlates` 与两个 reanchor 函数的注释）。
 */
function reanchorHeightField(arr, deltaPlates) {
  if (!Array.isArray(arr) || !deltaPlates) return arr;
  return arr.map((row) => {
    if (!Array.isArray(row) || row.length < 3 || !Number.isFinite(Number(row[2]))) return row;
    const out = row.slice();
    out[2] = Math.round((Number(row[2]) - deltaPlates) * 1e6) / 1e6;
    return out;
  });
}

/**
 * @param {object} ext      扩展目录（`catalog/parts-ldraw.json`.parts）
 * @param {object} curated  精选目录（`catalog/parts.json`.parts）
 * @param {{datumOf?:(id:string)=>number|null,
 *          frameOf?:(id:string)=>{originX:number,originZ:number}|null}} [opts]
 *   `datumOf` 返回该件**生产实际使用的安装面**（LDraw LDU）。提供它时，重锚量取
 *   `ext.ldrawOrigin[1]*8 − datum`（精确）；不提供时退回用 `c.h*8` 近似
 *   （对 141/151 件等价，但对 60623/92946 这类 datum≠h×8 的件会偏）。
 *   之所以做成可选：本函数有 24 处调用，绝大多数（查看器、CLI、测试）在建目录时
 *   还没有解析 .dat，不能强制要求 datum。默认近似 + 需要精确处显式传。
 */
export function mergeCatalogParts(ext = {}, curated = {}, opts = {}) {
  const out = {};
  for (const id of new Set([...Object.keys(ext), ...Object.keys(curated)])) {
    const e = ext[id], c = curated[id];
    if (!e) { out[id] = c; continue; }
    if (!c) { out[id] = e; continue; }
    // 以精选目录为骨架：`{...e, ...c}` 会让「精选目录没写的键」从扩展目录漏进来，
    // 而那些键不都是可继承的——例如 3039 的 boxes/studCells 是生成器按品类推断的近似几何，
    // 精选目录刻意不采用（它决定碰撞与占用）。默认全继承会把近似值当实测值用。
    // 因此合并改为「显式白名单」：只从扩展目录继承下面这些有官方几何依据的字段。
    const m = { ...c };
    const frame = measuredFrame(e, c);
    /**
     * **重锚定而不是丢弃**：两套目录的原点定义不同（扩展按几何最低点、精选按安装面），
     * 所以扩展目录里每个 ly 都要减去 `frameShiftPlates(e, c)` 才能落在精选框架的同一物理位置。
     *
     * 这是本轮最重要的一处纠正。第一版实现是「坐标系不一致就不继承」，
     * 结果 18677/2444 的 Technic 板销孔（每件 1 个）与 4274/60623 的侧凸点被静默吞掉，
     * 而实测重锚定后的误差只有 0.04 LDU —— 比丢掉接口好得多。
     * 独立验收发现并纠正了这一点（V3 报告 §3.6 记录了过程）。
     *
     * 坐标类字段（studCells/centerStuds/antistudCells）同理：先重锚 ly，再继承。
     * 只有 `frame === 'mismatch'`（两套目录对零件外形本身有分歧）才真正无法重锚定 ——
     * 那时 x/z 都不在同一个网格上，只能不继承，并由冲突账报出。
     */
    const shift = frameShiftPlates(e, c, opts.datumOf ? opts.datumOf(id) : null);
    const coordFrameOk = frame !== 'mismatch';
    /**
     * 水平重锚量（格）：扩展目录的局部坐标以「body 包围盒中心」为原点标注
     * （生成器 toLocal = (p - origin)/20），引擎/精选目录以 **.dat 原点**为原点
     * （LDraw 建模惯例：零件按凸点网格居中，.dat 原点即网格中心）。
     * 两套目录 size 不一致（frame === 'mismatch'）时，x/z 同样需要一个平移量；
     * 没有它，同一组坐标会落到另一个物理面上（4081b 的 2 个侧凸点此前因此被整条丢弃）。
     *
     * 只有调用方提供**实测**的扩展目录框架原点（opts.frameOf，LDraw LDU）时才可用：
     * 该原点由 .dat 的 body 包围盒中心决定，无法从 size 反推 —— size 是取整值，
     * 用 (extSize - curSize)/2 估计的误差可达 10 LDU。拿不到就不重锚（保持原行为），
     * 不拿估计值冒充实测。
     */
    const shiftXZ = frame === 'mismatch' && opts.frameOf
      ? (() => {
        const f = opts.frameOf(id);
        if (!f || !Number.isFinite(f.originX) || !Number.isFinite(f.originZ)) return null;
        return [-f.originX / 20, -f.originZ / 20];
      })()
      : null;
    for (const f of INHERITED_FIELDS) {
      if (m[f] !== undefined || e[f] === undefined) continue;
      if (f === 'antistudSource' && c.antistudCells !== undefined) continue;
      if (COORD_INHERITED_FIELDS.has(f)) {
        if (!coordFrameOk) continue;      // 外形本身有分歧：坐标没有可信网格
        // studCells/antistudCells 是 [[i,k,ly?], ...]，ly 在第 3 位（可缺省）；
        // centerStuds 是 [[cx,cz,ly?], ...]，ly 也在第 3 位。
        m[f] = shift ? reanchorHeightField(e[f], shift) : e[f];
        continue;
      }
      m[f] = e[f];
    }

    /**
     * 实测连接器数组：先做**单位换算**（ext 的 ly 是格，引擎要片），再做**重锚定**
     * （ext 原点=几何最低点，精选原点=安装面）。两步缺一不可：
     *   · 只换单位不重锚 → 18677 的孔仍在 1.125 片处，而真实孔口在 0 片（差 9 LDU）
     *   · 只重锚不换单位 → 差 2.5 倍，越修越远
     *
     * 例外：`'rotated'` 是**同一零件**换了轴（63868 实测 [2,1] vs 精选 [1,2]），
     * 坐标有效、只需换轴（由 L()/LV()/LA() 转置），照常继承。
     * `'mismatch'` 才是真的没有可信基准 —— 只有这种才不继承。
     */
    const connCoordFrameOk = frame !== 'mismatch' || shiftXZ !== null;
    // 重锚后的坐标已经落在引擎框架里，*Frame 记 'mismatch-shifted'：
    // 它既不是 'rotated' 也不是 'mismatch'，partConnectors 不会再把它整条挡掉。
    const connFrameTag = frame === 'mismatch' && shiftXZ !== null ? 'mismatch-shifted' : frame;
    for (const f of MEASURED_CONNECTOR_FIELDS) {
      const measuredRaw = Array.isArray(e[f]) && e[f].length ? e[f] : null;
      const authored = Array.isArray(c[f]) ? c[f] : null;
      const measured = measuredRaw;
      // 精选目录用数字表示「孔的数量」（如 3700 holes: 1），扩展目录同名字段是坐标数组。
      // 两者语义不同：数字保留为数量，实测坐标另存为 *Measured，供连接器生成使用。
      if (measured && typeof c[f] === 'number') {
        m[f] = c[f];
        if (connCoordFrameOk) m[f + 'Measured'] = (shift || shiftXZ) ? reanchorCoords(measured, shift * 0.4, shiftXZ) : measured;
        m[f + 'Frame'] = connFrameTag;
        continue;
      }
      // 精选目录显式给了坐标 → 以它为准（人手核对），冲突由 catalogInterfaceConflicts 报出
      if (measured && !authored) {
        // 外形有分歧且没有实测框架 → 仍然不继承（宁可报「装不上」，也不生成位置错的接口）
        if (!connCoordFrameOk) { m[f + 'Frame'] = frame; continue; }
        // ② 重锚：ext 原点(body bbox 中心) → 精选原点(安装面 / 网格中心)
        // 连接器 ly 以格计：shift 从片换算到格（xPLATE）；shiftXZ 本身已是格
        m[f] = (shift || shiftXZ) ? reanchorCoords(measured, shift * 0.4, shiftXZ) : measured;
        m[f + 'Frame'] = connFrameTag;   // 'rotated' 的连接器生成前需要换轴
      }
    }
    out[id] = m;
  }
  return out;
}

/**
 * 目录接口冲突报告：同名连接器字段在两套来源里都存在且不一致时列出。
 * 供 `catalog-audit` / 测试使用——静默覆盖正是「已知硬冲突」长期没被发现的原因。
 */
export function catalogInterfaceConflicts(ext = {}, curated = {}) {
  const rows = [];
  for (const id of Object.keys(curated)) {
    const e = ext[id], c = curated[id];
    if (!e || !c) continue;
    for (const f of MEASURED_CONNECTOR_FIELDS) {
      const measured = Array.isArray(e[f]) && e[f].length ? e[f] : null;
      if (!measured) continue;
      if (typeof c[f] === 'number') { rows.push({ id, field: f, kind: 'type-collision', detail: `精选目录用数字 ${c[f]} 表示数量，实测是 ${measured.length} 个坐标` }); continue; }
      if (Array.isArray(c[f]) && c[f].length) {
        const same = c[f].length === measured.length && c[f].every((v, i) => JSON.stringify(v) === JSON.stringify(measured[i]));
        if (!same) rows.push({ id, field: f, kind: 'value-conflict', detail: `精选目录 ${c[f].length} 条 vs 实测 ${measured.length} 条` });
      }
    }
  }
  return rows;
}

/**
 * **坐标字段的坐标系冲突**报告：哪些件的坐标类字段因两套目录**外形本身有分歧**
 * （`measuredFrame() === 'mismatch'`）而**没有被继承**。
 *
 * 判据是 `mismatch`，**不是** `h` 不一致：
 *   · `h` 不一致但 size 相同（18677 / 2444 / 60623 / 4274）→ 坐标可**重锚**，照常继承
 *     （见 `frameShiftPlates`）。它们不出现在本表里是**正确的**，不是漏报。
 *   · `size` 互转置（`'rotated'`，如 63868）→ 坐标有效、只需换轴，也照常继承。
 *   · 只有 `'mismatch'`（两套目录对零件外形本身有分歧）才真的没有可信网格。
 *
 * 字段清单与 `COORD_INHERITED_FIELDS` 一致，**不含** `subGrid`（布尔标记，不是坐标；
 * 早期误列导致 4 件"假降级"，已修正）。
 *
 * 为什么必须单列：这类"没继承"是**有意的降级**，代价是少几个实测凸点。若静默跳过，
 * 下游看到的就是"这件没有凸点数据"，与"它本来就没有凸点"无法区分。
 *
 * @returns {Array<{id:string, fields:string[], reason:string, curatedSize:any, autoSize:any,
 *                  curatedH:any, autoH:any, dropped:object}>}
 */
export function catalogInterfaceFrameConflicts(ext = {}, curated = {}) {
  const rows = [];
  for (const id of Object.keys(curated)) {
    const e = ext[id], c = curated[id];
    if (!e || !c) continue;
    const frame = measuredFrame(e, c);
    if (frame === 'same' && e.h === c.h) continue;   // 坐标系一致，不存在降级
    const dropped = {};
    for (const f of COORD_INHERITED_FIELDS) {
      if (c[f] !== undefined || e[f] === undefined) continue;
      const declaredEmpty = Array.isArray(e[f]) && e[f].length === 0;
      if (declaredEmpty) continue;                   // 「实测为无」仍被继承，不算降级
      dropped[f] = e[f];
    }
    if (!Object.keys(dropped).length) continue;
    const reasons = [];
    if (frame !== 'same') reasons.push(`size ${JSON.stringify(c.size)} vs ${JSON.stringify(e.size)}（${frame}）`);
    if (e.h !== c.h) reasons.push(`h ${c.h} vs ${e.h}`);
    rows.push({
      id, fields: Object.keys(dropped), reason: reasons.join('；'),
      curatedSize: c.size, autoSize: e.size, curatedH: c.h, autoH: e.h, dropped,
    });
  }
  return rows;
}


const r6 = (v) => Math.round(v * 1e6) / 1e6 || 0;
export function rotXZ(x, z, rot) {     // 绕竖直轴 +y 旋转（俯视逆时针）
  const t = (rot * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return [r6(x * c + z * s), r6(-x * s + z * c)];
}
export function rotatedSize(def, rot) {
  const [sx, sz] = def.size;
  return rot % 180 === 0 ? [sx, sz] : [sz, sx];
}
/** 零件底面中心（格坐标：x、z 为格，y 为片；支持 6 向 SNOT 朝向 up 与法向片偏移 snot） */
export function partCenter(p, def) {
  const [w, d] = rotatedSize(def, p.rot || 0);
  const up = p.up || '+y', s = p.snot || 0;
  if (up === '+y') return [r6(p.at[0] + w / 2), r6(p.at[1] + s), r6(p.at[2] + d / 2)];
  if (up === '-y') return [r6(p.at[0] + w / 2), r6(p.at[1] + def.h - s), r6(p.at[2] + d / 2)];
  if (up === '+z') return [r6(p.at[0] + w / 2), r6(p.at[1] + d / (2 * PLATE)), r6(p.at[2] + s * PLATE)];
  if (up === '-z') return [r6(p.at[0] + w / 2), r6(p.at[1] + d / (2 * PLATE)), r6(p.at[2] - s * PLATE)];
  if (up === '+x') return [r6(p.at[0] + s * PLATE), r6(p.at[1] + w / (2 * PLATE)), r6(p.at[2] + d / 2)];
  if (up === '-x') return [r6(p.at[0] - s * PLATE), r6(p.at[1] + w / (2 * PLATE)), r6(p.at[2] + d / 2)];
  return [r6(p.at[0] + w / 2), r6(p.at[1]), r6(p.at[2] + d / 2)];
}

/** 本地向量 (lx, ly_stud, lz) 经 rot 与 up 旋转后的世界偏移向量 (wx_stud, wy_stud, wz_stud) */
export function rotateLocalVec(lx, ly, lz, rot = 0, up = '+y') {
  const [x1, z1] = rotXZ(lx, lz, rot), y1 = ly;
  if (up === '+y') return [x1, y1, z1];
  if (up === '-y') return [x1, -y1, -z1];
  if (up === '+z') return [x1, -z1, y1];
  if (up === '-z') return [x1, z1, -y1];
  if (up === '+x') return [y1, -x1, z1];
  if (up === '-x') return [-y1, x1, z1];
  return [x1, y1, z1];
}

/** 本地坐标点 (lx, ly_stud, lz) 转换为世界坐标 [wx (格), wy (层/片), wz (格)] */
export function localToWorld(p, def, lx, ly, lz) {
  const c = partCenter(p, def);
  const [wx, wy, wz] = rotateLocalVec(lx, ly, lz, p.rot || 0, p.up || '+y');
  return [r6(c[0] + wx), r6(c[1] + wy / PLATE), r6(c[2] + wz)];
}

/** 本地法向量 (nx, ny, nz) 转换到世界朝向字符串 ('+y'|'-y'|'+z'|'-z'|'+x'|'-x') */
export function localDirToWorld(nx, ny, nz, rot = 0, up = '+y') {
  const [wx, wy, wz] = rotateLocalVec(nx, ny, nz, rot, up);
  if (Math.abs(wy) >= 0.9) return wy > 0 ? '+y' : '-y';
  if (Math.abs(wz) >= 0.9) return wz > 0 ? '+z' : '-z';
  return wx > 0 ? '+x' : '-x';
}

/**
 * 凸点本地高度表：cell "i,k"（或 centerStuds 的 "c<cx>,<cz>"）→ ly 列表（片，零件底面起算）。
 * studCells / centerStuds 条目第三位可携带 ly（多高度凸点：底盘座舱槽 / 轮拱 / 双阶斜坡等凹形件的内腔凸点）；
 * 缺省（旧条目无第三位）视为顶面 ly = def.h，走原路径（validate 结果不变）。
 * 同一格允许出现多个不同 ly（例如同一格位上下两层凸点），逐层输出。
 */
export function studLevels(def) {
  const map = new Map();
  const add = (key, ly) => {
    const arr = map.get(key);
    if (!arr) map.set(key, [ly]);
    else if (!arr.includes(ly)) arr.push(ly);
  };
  if (Array.isArray(def.studCells)) for (const [i, k, ly] of def.studCells) add(`${i},${k}`, typeof ly === 'number' ? ly : def.h);
  if (Array.isArray(def.centerStuds)) for (const [cx, cz, ly] of def.centerStuds) add(`c${cx},${cz}`, typeof ly === 'number' ? ly : def.h);
  return map;
}

/** 本地格子（i 沿本地 x，k 沿本地 z；k=0 为后排） */
export function localCells(def) {
  const [sx, sz] = def.size, out = [];
  const cellSet = Array.isArray(def.studCells) ? new Set(def.studCells.map(([i, k]) => `${i},${k}`)) : null;
  for (let i = 0; i < sx; i++) for (let k = 0; k < sz; k++) {
    if (def.kind === 'corner' && i === sx - 1 && k === sz - 1) continue;
    let stud = false;
    if (!def.tile && !def.noTopStuds && def.studs !== 0 && !def.centerStuds) {
      if (cellSet) stud = cellSet.has(`${i},${k}`);
      else if (['brick', 'plate', 'pinplate', 'doorframe', 'round', 'snot', 'bracket', 'barplate', 'clip', 'corner', 'islope', 'arch', 'technic'].includes(def.kind)) stud = true;
      else if (def.kind === 'slope' || (def.kind === 'cslope' && def.backStuds)) stud = k === 0;
      else if (def.kind === 'wedge') stud = def.side === 'L' ? i === 0 || k === 0 : i === 0 || k === sz - 1;
      else if (def.grid) stud = true;
    }
    out.push({ i, k, lx: i - sx / 2 + 0.5, lz: k - sz / 2 + 0.5, stud });
  }
  return out;
}

/** 世界坐标中的占地格子 [{x,z,stud}] */
export function footprint(p, def) {
  const c = partCenter(p, def);
  return localCells(def).map((cell) => {
    const [x, z] = rotXZ(cell.lx, cell.lz, p.rot || 0);
    return { x: Math.floor(c[0] + x), z: Math.floor(c[2] + z), stud: cell.stud };
  });
}
export const topLayer = (p, def) => p.at[1] + def.h;

/**
 * 多高度凸点 / 非整数层扣合：顶凸点 ly 可以不是整数（半片内腔凸点，如 28324 座舱槽 ly=0.5），
 * 扣在上面的零件 at[1] 因此是小数。这类「1/4 片粒度的小数层」只在确实扣到非整数高度凸点上时才合法：
 * validate 仍按 SNOT 口径放宽坐标校验，但会在连通图上二次确认，孤立的小数层照旧报 at 错误。
 */
function quarterInteger(v) { return typeof v === 'number' && Number.isFinite(v) && Math.abs(v * 4 - Math.round(v * 4)) < 1e-9; }
const isRaisedOffGrid = (p) => (!p.up || p.up === '+y') && Array.isArray(p.at) && quarterInteger(p.at[1]) && !Number.isInteger(p.at[1]);
const isSnotLike = (p) => (p.up !== undefined && p.up !== '+y') || Boolean(p.mount) || Boolean(p.snot) || Boolean(p.subassembly) || isRaisedOffGrid(p);

/**
 * 计算零件在世界坐标系中的 3D 实体包围盒数组 [{ x0, x1, y0, y1, z0, z1 }]
 * 其中 x0,x1,z0,z1 单位为格 (stud)，y0,y1 单位为片 (plate)。
 * 支持全部 6 向 SNOT 朝向 (up) 与多包围盒零件（L型转角、SNOT 支架）。
 * 目录条目带 boxes（本地坐标多盒分解：[x0,x1,y0,y1,z0,z1]，y 为片）时优先使用——
 * 凹形件（底盘座舱槽 / 轮拱 / 双阶斜坡）用多盒表达「四壁 + 底」，中间空腔留空，内饰件才能放进去；
 * 无 boxes 的旧条目走下方按 kind 分类的原路径（validate 结果不变）。
 */
export function partBoxes(p, def) {
  if (def.occupies === false) return [];
  const [sx, sz] = def.size, hx = sx / 2, hz = sz / 2, H = def.h * PLATE;
  const localBoxes = [];
  const custom = Array.isArray(def.boxes) && def.boxes.length ? def.boxes : null;
  if (custom) {
    for (const b of custom) {
      if (!Array.isArray(b) || b.length !== 6 || !b.every((v) => typeof v === 'number' && Number.isFinite(v))) {
        throw new Error(`零件 ${p.part}（kind=${def.kind}）的 boxes 条目格式错误：需要 [x0,x1,y0,y1,z0,z1] 6 个有限数字`);
      }
      // boxes 的 y 单位为「片」（与 def.h / studCells 的 ly 同一口径），localToWorld 需要格单位 → ×PLATE
      const [x0, x1, y0, y1, z0, z1] = b;
      localBoxes.push([x0, x1, y0 * PLATE, y1 * PLATE, z0, z1]);
    }
  } else if (def.hollow === true) {
    // 底面开口的「空腔壳」：顶板 + 4 周壁，中间留空。
    //
    // 为什么需要它：默认分支给出的是 y=0..H 的**实心**盒，把真实零件底部的空腔
    // 一并填死。于是任何「把零件放进另一件底部空腔」的装配都会被报成穿模——
    // 这类装配在实物上真实存在（倒挂支架让位、斜面互让、以及玩家之间大量使用的
    // 非法连接），实心盒会把它们全部判死。opt-in 保证现有零件结论不变。
    //
    // 口径与 src/viewer/geom.js 的 hollowBrickBody() 一致：
    //   wall   周壁厚（格，默认 0.08，与 geom.js 的 w 同值）
    //   topT   顶板厚（格，默认 min(0.08, H*0.25)，同 geom.js 的 t_top）
    // 壁厚吃掉整个截面时（超薄件）**退回实心**，不生成退化的零厚度壁。
    const wall = Number.isFinite(def.wall) ? def.wall : 0.08;
    const tTop = Number.isFinite(def.topT) ? def.topT : Math.min(0.08, H * 0.25);
    const yCeil = H - tTop;
    if (yCeil <= 0 || wall * 2 >= sx || wall * 2 >= sz) {
      localBoxes.push([-hx, hx, 0, H, -hz, hz]);
    } else {
      localBoxes.push([-hx, hx, yCeil, H, -hz, hz]);                    // 顶板
      localBoxes.push([-hx, hx, 0, yCeil, hz - wall, hz]);              // +z 壁
      localBoxes.push([-hx, hx, 0, yCeil, -hz, -hz + wall]);            // -z 壁
      localBoxes.push([-hx, -hx + wall, 0, yCeil, -hz + wall, hz - wall]); // -x 壁
      localBoxes.push([hx - wall, hx, 0, yCeil, -hz + wall, hz - wall]);   // +x 壁
      //
      // ⚠ 关键：空腔**不是空的**。真实乐高砖底部有抗凸点圆管（2x2 以上）或中心销（1xN），
      // 独立审查（audit/independent-review-r2-20261031/REVIEW.md 漏洞反例 1）证明：
      // 只画「顶板 + 4 周壁」会让一块 1x3 板横穿中央圆管却报 0 碰撞 —— 那是假阴性后门。
      // 所以这里按 src/viewer/geom.js 的 hollowBrickBody 同一套口径把内部结构还原成盒：
      //   rOut=0.3255（圆管外径，格）、中心销 r=0.15、高度到 yCeil。
      // 用「外径当实心方盒」是**保守**近似：真实圆环比它更细，所以只会多报、不会漏报。
      const rOut = 0.3255;
      if (sx >= 2 && sz >= 2) {
        for (let i = 0; i <= sx - 2; i++) {
          for (let k = 0; k <= sz - 2; k++) {
            const cx = i - hx + 1.0;
            const cz = k - hz + 1.0;
            localBoxes.push([cx - rOut, cx + rOut, 0, yCeil, cz - rOut, cz + rOut]);
          }
        }
      } else if (sx === 1 && sz >= 2) {
        for (let k = 0; k <= sz - 2; k++) {
          const cz = k - hz + 1.0;
          localBoxes.push([-0.15, 0.15, 0, yCeil, cz - 0.15, cz + 0.15]);
        }
      } else if (sz === 1 && sx >= 2) {
        for (let i = 0; i <= sx - 2; i++) {
          const cx = i - hx + 1.0;
          localBoxes.push([cx - 0.15, cx + 0.15, 0, yCeil, -0.15, 0.15]);
        }
      }
    }
  } else if (def.kind === 'corner') {
    localBoxes.push([-hx, hx, 0, H, -hz, 0], [-hx, 0, 0, H, 0, hz]);
  } else if (def.kind === 'bracket') {
    // P0-b 守卫：ext 支架必须带实测 vH/dir（缺字段时 NaN 经 r6 静默归 0 → 竖板零高度盒 → 穿模假阴性）
    if (typeof def.vH !== 'number' || !Number.isFinite(def.vH) || (def.dir !== 'up' && def.dir !== 'down')) {
      throw new Error(`零件 ${p.part}（bracket）目录条目缺 vH/dir（支架臂高与朝向须由官方 .dat 实测补齐），拒绝生成包围盒`);
    }
    localBoxes.push([-hx, hx, 0, H, -hz, hz]);
    const y0 = def.dir === 'down' ? (1.5 - def.vH) * PLATE : 0;
    const y1 = def.dir === 'down' ? PLATE : def.vH * PLATE;
    localBoxes.push([-hx, hx, y0, y1, hz, hz + 0.2]);
  } else if (def.kind === 'pinplate') {
    localBoxes.push([-hx, hx, 0, H, -hz, hz]);
  } else if (def.kind === 'bar') {
    localBoxes.push([-0.2, 0.2, 0, H, -0.2, 0.2]);
  } else if (def.kind === 'arch' && sx >= 3) {
    const archH = (def.h >= 6 ? 3 : 1) * PLATE;
    localBoxes.push([-hx, -hx + 1, 0, H, -hz, hz], [hx - 1, hx, 0, H, -hz, hz], [-hx + 1, hx - 1, archH, H, -hz, hz]);
  } else if (def.kind === 'slope' && sz >= 2) {
    localBoxes.push([-hx, hx, 0, H, -hz, -hz + 1], [-hx, hx, 0, H * 0.5, -hz + 1, hz]);
  } else if (def.kind === 'islope' && sz >= 2) {
    localBoxes.push([-hx, hx, 0, H, -hz, -hz + 1], [-hx, hx, 1 * PLATE, H, -hz + 1, hz]);
  } else if (def.kind === 'snot' && def.recessed) {
    localBoxes.push([-hx, hx, 0, H, -hz, hz - 0.2]);
  } else {
    localBoxes.push([-hx, hx, 0, H, -hz, hz]);
  }
  return localBoxes.map(([lx0, lx1, ly0, ly1, lz0, lz1]) => {
    const a = localToWorld(p, def, lx0, ly0, lz0);
    const b = localToWorld(p, def, lx1, ly1, lz1);
    return {
      x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]),
      y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]),
      z0: Math.min(a[2], b[2]), z1: Math.max(a[2], b[2]),
    };
  });
}

/** 判断两个零件的 3D 实体包围盒是否发生穿模重叠（容差：水平 0.04 格，竖直 0.10 片） */
export function boxesCollide(boxesA, boxesB) {
  for (const a of boxesA) for (const b of boxesB) {
    const dx = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const dy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    const dz = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
    if (dx > 0.04 && dy > 0.10 && dz > 0.04) {
      return [
        Math.floor((Math.max(a.x0, b.x0) + Math.min(a.x1, b.x1)) / 2),
        Math.floor((Math.max(a.y0, b.y0) + Math.min(a.y1, b.y1)) / 2),
        Math.floor((Math.max(a.z0, b.z0) + Math.min(a.z1, b.z1)) / 2),
      ];
    }
  }
  return null;
}

/* ───────────────── 可开合机构：铰接几何推导与行程扫掠碰撞 ─────────────────
 *
 * 背景：`mechanisms[]` 过去只做字段存在性检查（pivot/axis 是不是 3 个数字），
 * 于是「把转轴挪到 9999 格之外」与「axis 写成零向量」都能零错误通过——
 * 查看器照样绕一个不存在的轴旋转，图纸也照样画。这里补上两类几何事实的核对：
 *
 *   ① 转轴必须落在真实铰接几何上：动件与静件之间要么有真实的轴类连接器
 *      （bar↔clip / pin↔hole / pin↔axle），要么该动件在本目录里带铰接基准 `hinge`。
 *   ② 行程内扫掠不得撞进静件：按查看器同一约定（y×PLATE 进米制）逐角度采样，
 *      把动件的包围盒转成 OBB 与静件 AABB 做分离轴测试；真实铰接在一起的两件豁免
 *      （合页本来就互相扣住）。
 */

/**
 * 可开合机构的检查**是近似检查**，不是运动合法性证明。已知局限（不要让「check 通过」被读成
 * 「实物能动」）：
 *
 *   1. 行程采样是离散的（8~72 个角度取值，步长 ≤5°）。恰好落在两个采样点之间的
 *      薄片擦碰可能漏检；反向也可能因采样点落在临界位置而多报。
 *   2. 碰撞代理是 AABB / 由 AABB 旋转得到的 OBB，不是零件的真实网格。圆件、斜件、
 *      夹口内部空腔都会高估体积——保守方向（宁可多报），但「不报」不等于「不碰」。
 *   3. 只豁免**连接器落在声明转轴上**的那一对零件（合页两半本来就互相扣住）。
 *      其它任何零件对都不豁免，包括动件与箱体之间的第二处连接——那正是真实碰撞的来源。
 *   4. 「转轴落在真实铰接上」的判定容差为 0.15 格（1.2mm）。这是工程容差，
 *      不是对实物间隙的测量。
 *   5. 实测接口换轴（size 的 x/z 互换时绕竖直轴转 90°）只保证**尺寸约定一致**，
 *      不保证每个件的接口朝向都逐件核对过。逐件核对仍需实物/照片。
 *
 * 因此「mech-* 无报错」只说明：声明转轴与某个真实铰接轴线重合、行程采样点内
 * 未发现 AABB 级碰撞、动件组内部连通。复拼验证仍需人工。
 */
const MECH_AXIS_TOL = 0.15;   // 格：声明转轴偏离真实铰接轴线的允许值（1 格 = 8mm）
const MECH_MOTION_TOL = 0.06; // 格：扫掠分离余量，避免贴合面因浮点误差误报
const AXLE_KINDS = new Set(['bar', 'pin', 'clip', 'hole', 'axle']);
// 连接器轴是不带符号的 'x'|'y'|'z'（轴线无正负），目录 hinge.axis 与 mechanisms.axis 走 ± 形式
const AXIS_VEC = {
  x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1],
  '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1],
};

const _dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const _sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const _cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const _unit3 = (v) => { const n = Math.hypot(v[0], v[1], v[2]); return n > 1e-12 ? [v[0] / n, v[1] / n, v[2] / n] : null; };
/** 世界坐标 [x 格, y 片, z 格] → 米制格向量（y 乘 PLATE）。与查看器 mechMatrix 同一口径。 */
const _metric3 = (pt) => [pt[0], pt[1] * PLATE, pt[2]];

const _boxCorners = (b) => {
  const out = [];
  for (const x of [b.x0, b.x1]) for (const y of [b.y0, b.y1]) for (const z of [b.z0, b.z1]) out.push([x, y, z]);
  return out;
};

/** 绕世界转轴旋转一点（pivot/axis/pt 均为 [x 格, y 片, z 格]），返回同单位坐标 */
export function rotateAboutPivot(pivot, axis, deg, pt) {
  const pv = _metric3(pivot), ax = _metric3(axis);
  const u = _unit3(ax);
  if (!u) return pt.slice();
  const v = _sub3(_metric3(pt), pv);
  const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
  const d = _dot3(u, v), cr = _cross3(u, v);
  return [
    r6(pv[0] + v[0] * c + cr[0] * s + u[0] * d * (1 - c)),
    r6((pv[1] + v[1] * c + cr[1] * s + u[1] * d * (1 - c)) / PLATE),
    r6(pv[2] + v[2] * c + cr[2] * s + u[2] * d * (1 - c)),
  ];
}

/** 旋转矩阵（轴为米制单位向量），返回按列存储的 3×3 数组 */
function _rotMat(axis, deg) {
  const u = _unit3(_metric3(axis));
  if (!u) return null;
  const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180), t = 1 - c;
  const [x, y, z] = u;
  return [
    [t * x * x + c, t * x * y - s * z, t * x * z + s * y],
    [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
    [t * x * z - s * y, t * y * z + s * x, t * z * z + c],
  ];
}

/** 分离轴测试：OBB { c, axes:[3], h:[3] } 与同结构 OBB 是否相交（tol 为分离余量） */
function _obbHit(a, b, tol = MECH_MOTION_TOL) {
  const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R[i][j] = _dot3(a.axes[i], b.axes[j]);
  const A = R.map((row) => row.map((v) => Math.abs(v) + 1e-9));
  const d = _sub3(b.c, a.c);
  const t = [0, 1, 2].map((i) => _dot3(d, a.axes[i]));
  for (let i = 0; i < 3; i++) {
    const rb = b.h[0] * A[i][0] + b.h[1] * A[i][1] + b.h[2] * A[i][2];
    if (Math.abs(t[i]) > a.h[i] + rb - tol) return false;
  }
  for (let j = 0; j < 3; j++) {
    const ra = a.h[0] * A[0][j] + a.h[1] * A[1][j] + a.h[2] * A[2][j];
    if (Math.abs(_dot3(d, b.axes[j])) > ra + b.h[j] - tol) return false;
  }
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const ra = a.h[(i + 1) % 3] * A[(i + 2) % 3][j] + a.h[(i + 2) % 3] * A[(i + 1) % 3][j];
    const rb = b.h[(j + 1) % 3] * A[i][(j + 2) % 3] + b.h[(j + 2) % 3] * A[i][(j + 1) % 3];
    // 平行/共轴时交叉轴长度趋于 0，投影恒为 0；此时再减容差会让右侧变负而误判分离，
    // 因此半径不足一个容差量级的轴直接跳过
    if (ra + rb <= tol) continue;
    const tij = Math.abs(t[(i + 2) % 3] * R[(i + 1) % 3][j] - t[(i + 1) % 3] * R[(i + 2) % 3][j]);
    if (tij > ra + rb - tol) return false;
  }
  return true;
}

/** 世界 AABB 盒（x/z 格、y 片）→ 米制 OBB（单位轴，即静止姿态） */
const _obbOfBox = (b) => ({
  c: [(b.x0 + b.x1) / 2, ((b.y0 + b.y1) / 2) * PLATE, (b.z0 + b.z1) / 2],
  axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  h: [(b.x1 - b.x0) / 2, ((b.y1 - b.y0) / 2) * PLATE, (b.z1 - b.z0) / 2],
});

/**
 * 推导一个合页的真实转轴候选（世界坐标）。
 * 只从「动件 ↔ 静件」的实际配对里找，不看 mechanisms 里声明的 pivot/axis：
 *   - source:'connector'：真实轴类连接器（bar↔clip / pin↔hole / pin↔axle）共轴
 *   - source:'catalog'  ：动件在本目录带铰接基准（def.hinge），按该件姿态变换到世界
 * 返回 [{ source, pivot:[x格,y片,z格], axis:'+x'|…, moving, fixed, kinds? }]
 */
export function mechCandidates(movingParts, fixedParts, defOf, connOf = null) {
  const out = [];
  const conn = (p) => connOf ? connOf(p.id) : partConnectors(p, defOf(p));
  const safe = (p) => { try { return conn(p); } catch { return { studs: [], receptors: [] }; } };

  for (const p of movingParts) {
    const def = defOf(p);
    if (!def || !def.hinge || !Array.isArray(def.hinge.pivot) || !Array.isArray(def.hinge.axis)) continue;
    const [hx, hy, hz] = def.hinge.pivot, [ax, ay, az] = def.hinge.axis;
    out.push({
      source: 'catalog',
      pivot: localToWorld(p, def, hx, hy * PLATE, hz),
      axis: localDirToWorld(ax, ay, az, p.rot || 0, p.up || '+y'),
      moving: p.id, fixed: null,
    });
  }

  const close = (a, b) => Math.abs(a[0] - b[0]) <= 0.08 && Math.abs(a[1] - b[1]) <= 0.20 && Math.abs(a[2] - b[2]) <= 0.08;
  for (const p of movingParts) {
    const cp = safe(p);
    for (const q of fixedParts) {
      const cq = safe(q);
      const pairs = [];
      for (const s of cp.studs) for (const r of cq.receptors) pairs.push([s, r]);
      for (const s of cq.studs) for (const r of cp.receptors) pairs.push([s, r]);
      for (const [s, r] of pairs) {
        if (!AXLE_KINDS.has(s.kind) || !AXLE_KINDS.has(r.kind)) continue;
        if (!connectorPairMatches(s, r)) continue;
        const axis = s.axis || r.axis;
        if (!axis || (s.axis && r.axis && s.axis !== r.axis)) continue;
        out.push({ source: 'connector', pivot: s.pos, axis, moving: p.id, fixed: q.id, kinds: `${s.kind}↔${r.kind}` });
      }
    }
  }
  return out;
}

/** 声明的 pivot/axis 是否落在某个候选轴线上。返回 { parallel, dist }（dist 单位为格） */
export function matchMechAxis(pivot, axis, cand) {
  const u = _unit3(_metric3(axis));
  const w = AXIS_VEC[cand.axis];
  if (!u || !w) return { parallel: false, dist: Infinity };
  const parallel = Math.abs(_dot3(u, _unit3(_metric3(w)) ?? [0, 0, 0])) >= 0.995;
  const dist = Math.hypot(..._cross3(_sub3(_metric3(pivot), _metric3(cand.pivot)), u));
  return { parallel, dist };
}

/** 行程扫掠包围球半径：任何绕轴旋转的点都不会离开 pivot 超过这个距离（slide 按位移展开） */
function _sweepAabb(m, movingItems) {
  if (m.type === 'slide') {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    const [lo, hi] = m.range;
    for (const { boxes } of movingItems) for (const b of boxes) {
      for (const v of [lo, hi]) {
        const dv = _metric3([m.axis[0] * v, m.axis[1] * v, m.axis[2] * v]);
        x0 = Math.min(x0, b.x0 + dv[0]); x1 = Math.max(x1, b.x1 + dv[0]);
        y0 = Math.min(y0, b.y0 + dv[1] / PLATE); y1 = Math.max(y1, b.y1 + dv[1] / PLATE);
        z0 = Math.min(z0, b.z0 + dv[2]); z1 = Math.max(z1, b.z1 + dv[2]);
      }
    }
    return { x0, x1, y0, y1, z0, z1 };
  }
  const pv = _metric3(m.pivot);
  let r = 0;
  for (const { boxes } of movingItems) for (const b of boxes) for (const c of _boxCorners(b)) {
    const d = Math.hypot(..._sub3(_metric3(c), pv));
    if (d > r) r = d;
  }
  return {
    x0: pv[0] - r, x1: pv[0] + r,
    y0: (pv[1] - r) / PLATE, y1: (pv[1] + r) / PLATE,
    z0: pv[2] - r, z1: pv[2] + r,
  };
}

/**
 * 行程内扫掠碰撞：按查看器同一约定逐角度采样，动件 OBB 撞静件 AABB 即记录。
 * exempt(aId, bId) 为真的零件对跳过（真实铰接在一起的两件在运动中本来就互相扣住）。
 * 返回 [{ deg, a, b }]（去重后最多保留前若干条）。
 */
export function sweepCollision(m, movingItems, staticItems, exempt = () => false) {
  if (!m || (m.type !== 'hinge' && m.type !== 'slide')) return [];
  if (!Array.isArray(m.range) || m.range.length !== 2 || !m.range.every((v) => typeof v === 'number')) return [];
  const [lo, hi] = m.range;
  if (!(hi > lo) || !Array.isArray(m.axis)) return [];
  const box = _sweepAabb(m, movingItems);
  if (!Number.isFinite(box.x0)) return [];
  // 粗筛：与扫掠包围盒不相交的静件直接排除
  const near = staticItems.filter(({ boxes }) => boxes.some((b) => b.x0 <= box.x1 && b.x1 >= box.x0 && b.y1 >= box.y0 && b.y0 <= box.y1 && b.z0 <= box.z1 && b.z1 >= box.z0));
  if (!near.length) return [];

  const n = Math.max(8, Math.min(72, Math.ceil((hi - lo) / 5)));
  const hits = [], seen = new Set();
  const pv = m.type === 'hinge' ? _metric3(m.pivot) : null;   // slide 没有 pivot，不能无条件取
  for (let k = 0; k <= n; k++) {
    const v = lo + ((hi - lo) * k) / n;
    const R = m.type === 'hinge' ? _rotMat(m.axis, v) : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    if (!R) return [];
    const axes = [[R[0][0], R[1][0], R[2][0]], [R[0][1], R[1][1], R[2][1]], [R[0][2], R[1][2], R[2][2]]];
    const moving = [];
    for (const { id, boxes } of movingItems) for (const b of boxes) {
      const rest = _obbOfBox(b);
      let c;
      if (m.type === 'hinge') {
        const rel = _sub3(rest.c, pv);
        c = [0, 1, 2].map((i) => pv[i] + axes[0][i] * rel[0] + axes[1][i] * rel[1] + axes[2][i] * rel[2]);
      } else {
        const dv = _metric3([m.axis[0] * v, m.axis[1] * v, m.axis[2] * v]);
        c = [rest.c[0] + dv[0], rest.c[1] + dv[1], rest.c[2] + dv[2]];
      }
      moving.push({ id, c, axes, h: rest.h });
    }
    for (const a of moving) for (const { id: sid, boxes } of near) {
      if (exempt(a.id, sid)) continue;
      for (const qb of boxes) {
        if (!_obbHit(a, _obbOfBox(qb))) continue;
        const key = `${Math.round(v)}°|${a.id}|${sid}`;
        if (!seen.has(key)) { seen.add(key); hits.push({ deg: Math.round(v), a: a.id, b: sid }); }
      }
    }
  }
  return hits;
}

/**
 * O(n²) 配对裁剪（CP-02）：给每个零件的世界 AABB 建立跨 x/z 的均匀栅格，返回
 * near[i] = 与第 i 件「各自外扩后仍相交」的全部 j > i（升序数组）。
 *
 * 每件的外扩量取**该件自己的连接器外悬**（连接器位置超出自身 AABB 的最大距离，x/z 与 y 分开测）
 * 再加连接判定容差（水平 0.08 格、竖直 0.20 片）与少量余量。于是裁剪是保守超集：
 *   - 任何真实穿模对（盒相交）必然保留（外扩只增不减）；
 *   - 任何可连接对：连接器 a、b 位置重合（±容差），a 距 A 盒 ≤ marginA，b 距 B 盒 ≤ marginB，
 *     故两盒距离 ≤ marginA + marginB，即彼此外扩后必相交，必然保留。
 * near[i] 升序、外层 i 升序 → 与朴素 i<j 双重循环的幸存对**顺序完全一致**，
 * 因此 validate 的错误/连接落盘顺序、支撑图邻接表插入顺序都不变。
 * AABB 为 null 的零件（无碰撞盒 / partBoxes 抛错）不参与裁剪：与所有 j>i 配成候选。
 */
export function nearPairCandidates(aabbs) {
  const n = aabbs.length;
  const out = new Array(n);
  const indexed = [], open = [];
  for (let i = 0; i < n; i++) {
    out[i] = [];
    if (aabbs[i]) indexed.push(i); else open.push(i);
  }
  if (indexed.length) {
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const i of indexed) {
      const b = aabbs[i];
      // 轮件轴向 ±∞ 薄板不参与栅格边界（cellsOf 会把 ±∞ 裁剪进有限格范围）
      if (b.x0 < minX && b.x0 > -Infinity) minX = b.x0; if (b.x1 > maxX && b.x1 < Infinity) maxX = b.x1;
      if (b.z0 < minZ && b.z0 > -Infinity) minZ = b.z0; if (b.z1 > maxZ && b.z1 < Infinity) maxZ = b.z1;
    }
    if (!Number.isFinite(minX)) minX = 0; if (!Number.isFinite(maxX)) maxX = 0;
    if (!Number.isFinite(minZ)) minZ = 0; if (!Number.isFinite(maxZ)) maxZ = 0;
    const CELL = 2;   // 栅格边长（格）；凸点间距 0.8 格，2 格保证通常每件只占 1~4 格
    const gw = Math.max(1, Math.ceil((maxX - minX) / CELL) + 1);
    const gd = Math.max(1, Math.ceil((maxZ - minZ) / CELL) + 1);
    const cellOf = (v, lo, cap) => Math.min(cap, Math.max(0, Math.floor((v - lo) / CELL)));
    const grid = new Map();
    const cellsOf = (b) => {
      const x0 = cellOf(b.x0 - b.mx, minX, gw - 1), x1 = cellOf(b.x1 + b.mx, minX, gw - 1);
      const z0 = cellOf(b.z0 - b.mx, minZ, gd - 1), z1 = cellOf(b.z1 + b.mx, minZ, gd - 1);
      return [x0, x1, z0, z1];
    };
    for (const i of indexed) {
      const [x0, x1, z0, z1] = cellsOf(aabbs[i]);
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const k = x * gd + z;
        const list = grid.get(k);
        if (list) list.push(i); else grid.set(k, [i]);
      }
    }
    for (const i of indexed) {
      const a = aabbs[i];
      const [x0, x1, z0, z1] = cellsOf(a);
      const cand = new Set();
      for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
        const list = grid.get(x * gd + z);
        if (!list) continue;
        for (const j of list) {
          if (j <= i || cand.has(j)) continue;
          const b = aabbs[j];
          if (a.x0 - a.mx > b.x1 + b.mx || b.x0 - b.mx > a.x1 + a.mx) continue;
          if (a.z0 - a.mx > b.z1 + b.mx || b.z0 - b.mx > a.z1 + a.mx) continue;
          if (a.y0 - a.my > b.y1 + b.my || b.y0 - b.my > a.y1 + a.my) continue;
          cand.add(j);
        }
      }
      out[i] = [...cand].sort((p, q) => p - q);
    }
  }
  // 无盒件不参与裁剪：它们既可能被穿模也可能被连接，与所有更高下标互为候选
  for (const i of open) {
    const all = [];
    for (let j = i + 1; j < n; j++) all.push(j);
    out[i] = all;
    for (let j = 0; j < i; j++) if (aabbs[j]) out[j].push(i);
  }
  for (let i = 0; i < n; i++) if (aabbs[i]) out[i].sort((p, q) => p - q);
  return out;
}

/** 计算单个零件的世界 AABB 与「连接器外悬」外扩量（x/z 格、y 片）。无盒返回 null。 */
export function partAabbWithMargin(p, def, conn = null) {
  let boxes;
  try { boxes = partBoxes(p, def); } catch { return null; }
  if (!Array.isArray(boxes) || !boxes.length) return null;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const b of boxes) {
    if (b.x0 < x0) x0 = b.x0; if (b.x1 > x1) x1 = b.x1;
    if (b.y0 < y0) y0 = b.y0; if (b.y1 > y1) y1 = b.y1;
    if (b.z0 < z0) z0 = b.z0; if (b.z1 > z1) z1 = b.z1;
  }
  // 连接器外悬：实测本件全部连接器位置超出 AABB 的最大距离（partConnectors 抛错按 0 处理，
  // 只损失裁剪率不损失正确性）；再加判定容差（水平 0.08 格 / 竖直 0.20 片）与余量。
  let mx = 0.1, my = 0.25;
  if (conn) {
    for (const c of [...conn.studs, ...conn.receptors]) {
      const ox = Math.max(x0 - c.pos[0], c.pos[0] - x1, 0);
      const oz = Math.max(z0 - c.pos[2], c.pos[2] - z1, 0);
      const oy = Math.max(y0 - c.pos[1], c.pos[1] - y1, 0);
      if (ox > mx) mx = ox; if (oz > mx) mx = oz; if (oy > my) my = oy;
    }
    mx += 0.1; my += 0.25;
  }
  // 轮件轴向开放（行为保持的关键特例）：partsConnected 的 tyre↔rim 判据只要求
  // 「垂直于轮轴的横截面圆心重合（±0.08）」，沿轮轴方向**不设上限**（60239 的 11208 轮辋与
  // 11209 轮胎盒沿 z 相距数格仍判扣合）。因此带 wheel 字段的件沿其轮轴取 ±∞ 薄板，
  // 轮轴向不裁剪；轮件数量少，代价可忽略。
  if (def && def.wheel && typeof def.wheel.axis === 'string') {
    if (def.wheel.axis === 'x') { x0 = -Infinity; x1 = Infinity; }
    else if (def.wheel.axis === 'y') { y0 = -Infinity; y1 = Infinity; }
    else { z0 = -Infinity; z1 = Infinity; }
  }
  return { x0, x1, y0, y1, z0, z1, mx, my };
}

/**
 * 圆柱体零件（轮毂/轮胎/圆盘，目录条目带 wheel 字段）的碰撞代理。
 * 轮/胎是圆盘，用 AABB 判会把轮外圈的方角误判成撞进车体（真实圆盘只擦边）。
 * 返回 { center（世界 [x, y片, z]）, axis（'x'|'y'|'z'，**已按 p.rot / p.up 转到世界**）,
 *        r（半径格，取 wheel.outer）, halfT（半厚，单位与轴向分量一致：轴向 y → 片，轴向 x/z → 格）}。
 *
 * 2026-10 修正（CR-01 轮子链必需）：
 *   ① 轴向必须随零件姿态旋转。旧实现直接返回 def.wheel.axis（本地轴名），
 *      于是 11208 绕竖直轴转 90° 装到轮销上后，代理仍认为是 z 轴轮——
 *      轮子实际绕 x 转，代理却按 z 轴圆柱算，碰撞结论整个错位。
 *   ② 半厚必须与轴向分量同单位。旧实现一律取 def.h/2（片），而 x/z 分量是格（1 格 = 2.5 片），
 *      于是 11208（h=5 片、实际厚 1 格）被当成 2.5 格厚，厚了 5 倍。
 *      现在直接取该件真实包围盒沿世界轴的半跨度（与 wheelBoxesCollide 的比较口径完全一致）。
 */
export function wheelCylinder(p, def) {
  if (!def || !def.wheel) return null;
  const localAxis = def.wheel.axis || 'z';
  const [lx, ly, lz] = localAxis === 'x' ? [1, 0, 0] : localAxis === 'y' ? [0, 1, 0] : [0, 0, 1];
  const [wx, wy, wz] = rotateLocalVec(lx, ly, lz, p.rot || 0, p.up || '+y');
  const ax = Math.abs(wx);
  const ay = Math.abs(wy);
  const az = Math.abs(wz);
  const axis = ax >= ay && ax >= az ? 'x' : az >= ay ? 'z' : 'y';
  const cy = typeof def.wheel.cy === 'number' ? def.wheel.cy : def.h / 2;
  const center = localToWorld(p, def, 0, cy * PLATE, 0);
  // 半厚：优先用真实包围盒沿世界轴的跨度（口径与 wheelBoxesCollide 一致，不做单位换算猜测）
  let halfT = typeof def.wheel.thickness === 'number' ? def.wheel.thickness / 2 : def.h / 2;
  try {
    const boxes = partBoxes(p, def);
    if (boxes.length) {
      const lo = Math.min(...boxes.map((b) => (axis === 'x' ? b.x0 : axis === 'y' ? b.y0 : b.z0)));
      const hi = Math.max(...boxes.map((b) => (axis === 'x' ? b.x1 : axis === 'y' ? b.y1 : b.z1)));
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) halfT = (hi - lo) / 2;
    }
  } catch { /* 包围盒不可用时回退到目录厚度 */ }
  return { center, axis, r: def.wheel.outer, halfT, localAxis };
}
/** 圆柱 vs AABB 数组：轴向区间重叠 + 垂直平面内圆心到矩形距离 < 半径 → 穿模。返回命中点或 null。 */
export function wheelBoxesCollide(cyl, boxes) {
  if (!cyl) return null;
  const i = { x: 0, y: 1, z: 2 }[cyl.axis];
  if (i === undefined) return null;
  const [a1, a2] = [0, 1, 2].filter((k) => k !== i);
  const lo = (b) => [b.x0, b.y0, b.z0];
  const hi = (b) => [b.x1, b.y1, b.z1];
  for (const b of boxes) {
    const off = Math.min(cyl.center[i] + cyl.halfT, hi(b)[i]) - Math.max(cyl.center[i] - cyl.halfT, lo(b)[i]);
    if (off <= (i === 1 ? 0.10 : 0.04)) continue;
    const clamp = (v, l, h) => Math.min(Math.max(v, l), h);
    const q1 = clamp(cyl.center[a1], lo(b)[a1], hi(b)[a1]);
    const q2 = clamp(cyl.center[a2], lo(b)[a2], hi(b)[a2]);
    if (Math.hypot(cyl.center[a1] - q1, cyl.center[a2] - q2) < cyl.r - 0.04) {
      const hit = [0, 1, 2].map((k) => Math.floor(k === i ? Math.max(cyl.center[i] - cyl.halfT, lo(b)[i]) : cyl.center[k]));
      return hit;
    }
  }
  return null;
}
/** 两个零件是否穿模。
 *
 *  轮/胎件（目录带 wheel 字段）的处理原则：**用连接关系决定嵌套是否合法**，而不是整件豁免。
 *
 *  历史背景：早先这里是 `if (defA?.wheel || defB?.wheel) return null;`，
 *  本意是「轮胎是圆环、轮毂嵌在胎孔里，两者 AABB 必然相交，整盒判会把正常嵌轮误判成穿模」。
 *  问题在于整件豁免同时吞掉真实穿模：在 60239 上它正好隐藏了两处
 *  「2 格宽轮胎压进 8 格瓷砖」的实心相交（p088×p056、p090×p057，各深 2×1×1 格），
 *  而这两颗轮胎与瓷砖之间没有任何连接器，属于真实错位。
 *
 *  现在的判据：
 *    - 轮件与对方**真实扣合**（tyre↔rim / pin↔axleHole 等，由 partsConnected 判定）→ 嵌套合法，
 *      不报穿模（轮毂就该在胎孔里）。
 *    - 轮件与对方**没有连接**却 AABB 相交 → 报穿模（这才是真错位）。
 *  这样「合法的嵌轮」和「压进别的东西」被区分开，不再靠一刀切豁免。
 *
 *  需要更精细的圆盘代理时传 `{ wheelMode: 'cylindrical' }`，改用 wheelBoxesCollide。
 *  返回命中点或 null。
 */
export function partsCollide(a, defA, boxesA, b, defB, boxesB, opts = {}) {
  const isWheel = Boolean(defA?.wheel || defB?.wheel);
  if (!isWheel) return boxesCollide(boxesA, boxesB);

  // 轮件：先看它们是不是真的扣在一起
  let connected = false;
  try {
    connected = partsConnected(a, defA, b, defB);
  } catch { connected = false; }
  if (connected) return null;      // 合法嵌套（轮胎包轮毂）

  if (opts.wheelMode === 'cylindrical') {
    const cylA = wheelCylinder(a, defA);
    if (cylA) return wheelBoxesCollide(cylA, boxesB);
    const cylB = wheelCylinder(b, defB);
    if (cylB) return wheelBoxesCollide(cylB, boxesA);
  }
  return boxesCollide(boxesA, boxesB);
}

/**
 * 计算零件在世界空间中的全部连接点：
 * - studs: 输出连接点 [{ index, kind: 'top'|'side'|'bar'|'pin'|'rim'|'minifig', pos: [wx, wy_plates, wz], dir, label }]
 * - receptors: 输入插孔 [{ index, kind: 'antistud'|'clip'|'hole'|'axle'|'tyre'|'minifig', pos, dir, i, k }]
 */
export function partConnectors(p, def) {
  const [sx, sz] = def.size, hx = sx / 2, hz = sz / 2, H = def.h * PLATE;
  const rot = p.rot || 0, up = p.up || '+y';
  const studs = [], receptors = [];

  // 1. 顶面凸点 (Top Studs) —— 支持多高度凸点：studCells/centerStuds 第三位 ly（片，底面起算）可为内腔/分层凸点；
  //    无 ly 的旧条目一律按顶面 H 处理（原路径，validate 结果不变）。
  const topDir = localDirToWorld(0, 1, 0, rot, up);
  const levels = studLevels(def);
  const studYs = (key) => {
    const arr = levels.get(key);
    return arr ? arr.map((ly) => ly * PLATE) : [H];
  };
  if (!def.tile && !def.noTopStuds && def.studs !== 0) {
    if (def.centerStuds) {
      def.centerStuds.forEach(([cx, cz], idx) => {
        for (const y of studYs(`c${cx},${cz}`)) {
          studs.push({ index: studs.length, kind: 'top', pos: localToWorld(p, def, cx, y, cz), dir: topDir, label: `center-${idx}`, ly: r6(y / PLATE) });
        }
      });
    } else if ((def.kind === 'cone' || def.kind === 'dish') && !Array.isArray(def.studCells)) {
      studs.push({ index: studs.length, kind: 'top', pos: localToWorld(p, def, 0, H, 0), dir: topDir, label: 'top-0', ly: r6(H / PLATE) });
    } else {
      for (const c of localCells(def)) if (c.stud) {
        for (const y of studYs(`${c.i},${c.k}`)) {
          studs.push({ index: studs.length, kind: 'top', pos: localToWorld(p, def, c.lx, y, c.lz), dir: topDir, label: `top-${c.i},${c.k}`, ly: r6(y / PLATE) });
        }
      }
    }
  }

  // 2. SNOT 侧面凸点 & 支架侧面凸点/插孔（ext/auto 条目带显式 sideStuds 字段时以实测为准，走 2b）
  if ((def.kind === 'snot' || def.kind === 'bracket') && !Array.isArray(def.sideStuds)) {
    const zMax = def.kind === 'bracket' ? hz + 0.2 : (def.recessed ? hz - 0.2 : hz);
    const rows = def.sideRows || (def.h >= 5 ? [1.25, 3.75] : [1.75]);
    const faces = def.sideFaces || ['+z'];
    for (const face of faces) {
      if (face === '+z' || face === '-z') {
        const fz = face === '+z' ? zMax : -hz;
        const dir = localDirToWorld(0, 0, face === '+z' ? 1 : -1, rot, up);
        for (const r of rows) for (let i = 0; i < sx; i++) {
          const pos = localToWorld(p, def, i - hx + 0.5, r * PLATE, fz);
          studs.push({ index: studs.length, kind: 'side', pos, dir, label: `side(${face})-${i}@${r}` });
        }
      } else {
        const fx = face === '+x' ? hx : -hx;
        const dir = localDirToWorld(face === '+x' ? 1 : -1, 0, 0, rot, up);
        for (const r of rows) for (let k = 0; k < sz; k++) {
          studs.push({ index: studs.length, kind: 'side', pos: localToWorld(p, def, fx, r * PLATE, k - hz + 0.5), dir, label: `side(${face})-${k}@${r}` });
        }
      }
    }
  }

  // 2b. ext/auto 条目官方 .dat 实测连接字段（P1 连接语义自动提取；精选目录无这些字段，走原路径不受影响）
  //     条目格式：sideStuds/bars/pins/clips/holes/axleHoles = [[lx, ly, lz, 朝向或轴向], ...]
  //     lx/lz 为本地格坐标（中心原点），ly 同为格单位（1 格 = 2.5 片）；侧凸点/夹口存 '+x'…朝向，杆/销/孔存 'x'|'y'|'z' 轴向
  const axisOf = (d) => d.slice(1);
  const LOCAL_DIR = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };
  const LOCAL_AXIS = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

  // 实测数组（sideStuds/bars/pins/clips/holes/axleHoles）来自扩展目录的局部坐标系，
  // 而 localToWorld 会再按零件的 up/rot 做一次轴映射。两者叠加时，**只补偿 size 约定差异**：
  // 精选目录若把 size 的 x/z 互换（*Frame='rotated'），实测坐标要绕竖直轴转 90° 才对应同一物理面。
  // 'mismatch' 表示两套目录对外形本身有分歧，坐标没有可信基准 —— 一律不生成，
  // 宁可报「装不上」，也不生成一个位置错误的接口让下游误以为可扣。
  //
  // 旋转方向由 60478「端头把柄」校核：ext 把柄在 x=1.5（size=[2,1] 端头外侧），
  // 精选 size=[1,2] 的端头在 z 方向，故 (x,z) → (-z,x) 使 x=1.5 落到 z=1.5。
  const FRAME_KEYS = ['sideStudsFrame', 'barsFrame', 'pinsFrame', 'clipsFrame', 'holesFrame', 'axleHolesFrame'];
  const connRotated = FRAME_KEYS.some((k) => def[k] === 'rotated');
  const connUntrusted = FRAME_KEYS.some((k) => def[k] === 'mismatch');
  const L = (x, y, z) => (connRotated ? [-z, y, x] : [x, y, z]);
  const LV = (v) => (connRotated ? [-v[2], v[1], v[0]] : v);
  const LA = (ax) => (connRotated ? ({ x: 'z', z: 'x' })[ax] || ax : ax);

  if (Array.isArray(def.sideStuds) && !connUntrusted) {
    for (const [lx0, ly, lz0, face] of def.sideStuds) {
      const [lx, , lz] = L(lx0, ly, lz0);
      const v = LV(LOCAL_DIR[face] || LOCAL_DIR['+z']);
      studs.push({ index: studs.length, kind: 'side', pos: localToWorld(p, def, lx, ly, lz), dir: localDirToWorld(v[0], v[1], v[2], rot, up), label: `extside@${lx},${ly},${lz}` });
    }
  }
  if (Array.isArray(def.bars) && !connUntrusted) {
    for (const [lx0, ly, lz0, ax0, span] of def.bars) {
      const [lx, , lz] = L(lx0, ly, lz0);
      const a = LOCAL_AXIS[LA(ax0)] || LOCAL_AXIS.x;
      const axis = axisOf(localDirToWorld(a[0], a[1], a[2], rot, up));
      const s = { index: studs.length, kind: 'bar', pos: localToWorld(p, def, lx, ly, lz), dir: localDirToWorld(a[0], a[1], a[2], rot, up), axis, label: `extbar@${lx},${ly},${lz}` };
      if (typeof span === 'number') s.span = span;
      studs.push(s);
    }
  }
  if (Array.isArray(def.pins) && !connUntrusted) {
    for (const [lx0, ly, lz0, ax0] of def.pins) {
      const [lx, , lz] = L(lx0, ly, lz0);
      const a = LOCAL_AXIS[LA(ax0)] || LOCAL_AXIS.x;
      const axis = axisOf(localDirToWorld(a[0], a[1], a[2], rot, up));
      studs.push({ index: studs.length, kind: 'pin', pos: localToWorld(p, def, lx, ly, lz), dir: localDirToWorld(a[0], a[1], a[2], rot, up), axis, label: `extpin@${lx},${ly},${lz}` });
    }
  }

  // 3. 把柄 (Bars) —— 包含圆杆轴向 axis ('x'|'y'|'z')（axisOf 已在 2b 声明）
  //
  //   实测优先：条目若已从官方 .dat 提取出 bars 数组（第 5 步会逐个生成），这里就不按 kind
  //   再合成一遍。否则两套把柄会被**叠加**：48336 实测 2 根 + 合成 2 根 = 4 根，多出来的那两根
  //   位置是猜的，却会被当成真实接口参与扣合——「能看图、装不上」的典型来源。
  //
  //   坐标系不可信（`*Frame='mismatch'`，见 mergeCatalogParts 的 connCoordFrameOk）时，
  //   实测 bars 已被**主动丢弃**；此时绝不能退回按 kind 合成 —— 那等于用"猜的把柄"
  //   替换"知道位置但坐标系不对的把柄"，比不生成更糟（外观像能装、一装就错）。
  //   所以：mismatch 时明确跳过合成，宁可这件报"装不上"。
  const hasMeasuredBars = Array.isArray(def.bars) && def.bars.length > 0;
  if (def.kind === 'barplate' && !hasMeasuredBars && !connUntrusted) {
    const dir = localDirToWorld(0, 0, 1, rot, up);
    const axis = axisOf(localDirToWorld(1, 0, 0, rot, up));
    for (let i = 0; i < sx; i++) {
      studs.push({ index: studs.length, kind: 'bar', pos: localToWorld(p, def, i - hx + 0.5, H / 2, hz + 0.22), dir, axis, label: `bar-${i}` });
      if (def.bothEnds) {
        const dirBack = localDirToWorld(0, 0, -1, rot, up);
        studs.push({ index: studs.length, kind: 'bar', pos: localToWorld(p, def, i - hx + 0.5, H / 2, -hz - 0.22), dir: dirBack, axis, label: `bar-back-${i}` });
      }
    }
  } else if (def.kind === 'bar') {
    const axis = axisOf(topDir);
    for (let y = 0.5; y < def.h; y += 1) {
      studs.push({ index: studs.length, kind: 'bar', pos: localToWorld(p, def, 0, y * PLATE, 0), dir: topDir, axis, span: 0.5, label: `bar@${y}` });
    }
  }

  // 4. 底面反凸点 / 底孔 (Bottom Anti-studs) —— 支持第三位 ly（片，底面起算）表示内缩/抬高底孔（如挡泥板 50745、底盘 28324 前后桥）
  // ext/auto 条目带 antistudCells（官方 .dat 实测底孔格位）时按实测判定——空数组即底面无反孔
  // （科技梁/轴/轴衬等底面是实心的，禁用默认满格虚假受体）；无该字段（精选目录/常规砖板）走原满格路径。
  // antistudSource:'assumed' 是第三种口径（generator B 保守恢复）：官方 .dat 用 box 边沿建模底腔、
  // 不逐格建反孔图元，物理底孔确实存在（挡泥板 50745、异形砖 3937 等），按砖族默认满格处理。
  const antiLevels = new Map();
  if (Array.isArray(def.antistudCells)) {
    for (const [i, k, ly] of def.antistudCells) {
      const key = `${i},${k}`;
      const y = typeof ly === 'number' ? ly : 0;
      const arr = antiLevels.get(key);
      if (!arr) antiLevels.set(key, [y]);
      else if (!arr.includes(y)) arr.push(y);
    }
  }
  const antiCells = Array.isArray(def.antistudCells) ? antiLevels : null;
  const antiAssumed = def.antistudSource === 'assumed' && !Array.isArray(def.antistudCells);
  for (const c of localCells(def)) {
    if (def.kind === 'islope' && !antiCells && c.k > 0) continue;
    if (antiCells && !antiAssumed) {
      const ys = antiCells.get(`${c.i},${c.k}`);
      if (!ys) continue;
      for (const ly of ys) {
        receptors.push({ index: receptors.length, kind: 'antistud', pos: localToWorld(p, def, c.lx, ly * PLATE, c.lz), dir: topDir, i: c.i, k: c.k, ly });
      }
      continue;
    }
    receptors.push({ index: receptors.length, kind: 'antistud', pos: localToWorld(p, def, c.lx, 0, c.lz), dir: topDir, i: c.i, k: c.k, ly: 0 });
  }
  if ((!antiCells || antiAssumed) && sx >= 2 && sz >= 2 && def.kind !== 'corner' && def.kind !== 'arch' && def.kind !== 'islope' && !Array.isArray(def.boxes)) {
    receptors.push({ index: receptors.length, kind: 'antistud', pos: localToWorld(p, def, 0, 0, 0), dir: topDir, i: -1, k: -1 });
  } else if (antiCells && def.antistudCenter) {
    receptors.push({ index: receptors.length, kind: 'antistud', pos: localToWorld(p, def, 0, 0, 0), dir: topDir, i: -1, k: -1 });
  }

  // 5. 夹子 (Clips) —— 包含夹口圆柱轴向 axis ('x'|'y'|'z')
  if (def.kind === 'clip' && !Array.isArray(def.clips)) {
    const clipDir = localDirToWorld(0, 0, 1, rot, up);
    const axis = axisOf(localDirToWorld(1, 0, 0, rot, up));
    const clipXs = !def.singleClip && sx >= 2 ? [-0.5, 0.5] : [0];
    for (const cx of clipXs) {
      receptors.push({ index: receptors.length, kind: 'clip', pos: localToWorld(p, def, cx, H / 2, hz + 0.22), dir: clipDir, axis, i: 0, k: 0 });
    }
  }

  // 5b. ext/auto 条目实测夹口（clip 族图元）与销孔/轴孔受体（P1：对齐精选 clip 范式的新受体类型）
  //     坐标换算（L/LV/LA、connRotated/connUntrusted）已在第 2b 段按同一份 *Frame 判据定义。
  if (Array.isArray(def.clips) && !connUntrusted) {
    for (const [lx0, ly, lz0, face, explicitAxis] of def.clips) {
      const [lx, , lz] = L(lx0, ly, lz0);
      const v = LV(LOCAL_DIR[face] || LOCAL_DIR['+z']);
      const aRaw = explicitAxis ? (LOCAL_AXIS[explicitAxis] || LOCAL_AXIS.x) : ((face === '+x' || face === '-x') ? LOCAL_AXIS.z : LOCAL_AXIS.x);
      const a = connRotated ? (explicitAxis ? LOCAL_AXIS[LA(explicitAxis)] : LOCAL_AXIS[LA(face === '+x' || face === '-x' ? 'z' : 'x')]) : aRaw;
      receptors.push({ index: receptors.length, kind: 'clip', pos: localToWorld(p, def, lx, ly, lz), dir: localDirToWorld(v[0], v[1], v[2], rot, up), axis: axisOf(localDirToWorld(a[0], a[1], a[2], rot, up)), i: 0, k: 0 });
    }
  }
  // holes / axleHoles 两种语义并存（见 mergeCatalogParts 的注释）：
  //   · 数组  = 实测到的每个孔口坐标与轴向外法线（官方 .dat 提取），逐个建受体；
  //   · 数字  = 精选目录里「这件有几个孔」（如 3700 holes: 1），只是数量声明。
  //     数量声明不足以定位，故不凭它编造坐标；若同条目带 *Measured，则用实测坐标。
  const holeList = Array.isArray(def.holes) ? def.holes : (Array.isArray(def.holesMeasured) ? def.holesMeasured : null);
  if (holeList && !connUntrusted) {
    for (const [lx0, ly, lz0, ax0] of holeList) {
      const [lx, , lz] = L(lx0, ly, lz0);
      const a = LOCAL_AXIS[LA(ax0)] || LOCAL_AXIS.z;
      const axis = axisOf(localDirToWorld(a[0], a[1], a[2], rot, up));
      receptors.push({ index: receptors.length, kind: 'hole', pos: localToWorld(p, def, lx, ly, lz), dir: localDirToWorld(a[0], a[1], a[2], rot, up), axis, i: 0, k: 0 });
    }
  }
  const axleHoleList = Array.isArray(def.axleHoles) ? def.axleHoles : (Array.isArray(def.axleHolesMeasured) ? def.axleHolesMeasured : null);
  if (axleHoleList && !connUntrusted) {
    for (const [lx0, ly, lz0, ax0] of axleHoleList) {
      const [lx, , lz] = L(lx0, ly, lz0);
      const a = LOCAL_AXIS[LA(ax0)] || LOCAL_AXIS.z;
      const axis = axisOf(localDirToWorld(a[0], a[1], a[2], rot, up));
      receptors.push({ index: receptors.length, kind: 'axle', pos: localToWorld(p, def, lx, ly, lz), dir: localDirToWorld(a[0], a[1], a[2], rot, up), axis, i: 0, k: 0 });
    }
  }

  // 5c. 车轮语义（生成器实测轮径/轮孔）：rim（轮毂）输出轮辋凸缘，tyre（轮胎）输出胎孔受体。
  //     两者轴向同心 + 半径匹配才构成 tyre↔rim 连接（见 partsConnected）；径向尺寸单位 = 格。
  if (def.wheel && (def.wheel.role === 'rim' || def.wheel.role === 'tyre')) {
    const ax = def.wheel.axis || 'z';
    const a = LOCAL_AXIS[ax] || LOCAL_AXIS.z;
    // 轮心高度取生成器实测的 cy（片）；旧条目无 cy 时退回 h/2（半高）
    const cy = typeof def.wheel.cy === 'number' ? def.wheel.cy : def.h / 2;
    const pos = localToWorld(p, def, 0, cy * PLATE, 0);
    const dir = localDirToWorld(a[0], a[1], a[2], rot, up);
    const entry = { index: 0, kind: def.wheel.role, role: def.wheel.role, pos, dir, axis: axisOf(dir), outer: def.wheel.outer, bore: def.wheel.bore, i: 0, k: 0 };
    if (def.wheel.role === 'rim') { entry.index = studs.length; studs.push(entry); }
    else { entry.index = receptors.length; receptors.push(entry); }
  }

  // 5d. 人仔标准接口（LEGO 人仔系统：腿↔胯↔躯干↔头↔帽）：
  //     minifig.pegs = [[lx, ly, lz]] 竖直插柱；minifig.sockets = [[lx, ly, lz]] 底部插孔。
  //     配对规则：peg↔socket 同轴上下对接；头部顶凸点（kind top）也可插进 socket（stud↔antistud 的人仔变体）。
  if (def.minifig) {
    const mk = (list, kind) => {
      for (const [lx, ly, lz] of list || []) {
        // 目录里 minifig.pegs/sockets 的 ly 单位是「片」（与 studCells 的 ly 同口径），localToWorld 要格 → ×PLATE
        const entry = { index: kind === 'peg' ? studs.length : receptors.length, kind: 'minifig', role: kind,
          pos: localToWorld(p, def, lx, ly * PLATE, lz), dir: topDir, axis: 'y', i: 0, k: 0 };
        if (kind === 'peg') studs.push(entry); else receptors.push(entry);
      }
    };
    mk(def.minifig.pegs, 'peg');
    mk(def.minifig.sockets, 'socket');
  }

  return { studs, receptors };
}

/**
 * 单个「公头 ↔ 受体」是否构成真实扣合。
 *
 * 这是**唯一**的配对规则实现：`partsConnected`（整件连通性）与机关运动豁免
 * （`mech-axle-pairs`）都必须用它。历史上两条路径各写一套判据——豁免那边的距离阈值
 * 比这里宽 6 倍、也不检查类型配对与受体轴向，于是「没真正扣上」的零件对也可能被豁免，
 * 那处真实碰撞就被整个放过了。
 *
 * 判据要点：
 *   - 类型必须配对（bar↔clip、pin↔hole、pin↔axle、top↔antistud…），不是「都属于轴类」就算；
 *   - 轴类连接还要求轴**同向**（`sameAxis`：任何一侧没有轴信息时视为不冲突）；
 *   - 位置容差：水平 0.08 格、竖直 0.20 片。
 */
/**
 * 把柄↔夹口：夹口可以夹在**杆段上任意位置**，所以沿杆轴方向不是「点对点重合」而是「落在跨度内」。
 *
 * 旧实现只比点距（±0.08），于是 1×2 把柄板（48336）那根 1.4 格长的杆被提取成两端支撑环两个点，
 * 居中夹板（60470/63878 类）永远夹不上——机甲 11 项白名单错误就是这么来的。
 * 现在 bars 条目第 5 位带上沿轴半长，这里按「垂直方向 0.08/0.20 容差 + 沿轴落在 [pos±span] 内」判定；
 * span 缺省为 0，退化成旧的点判据，不改变任何未声明跨度的零件。
 */
export function barClipMatches(bar, clip) {
  if (bar.kind !== 'bar' || clip.kind !== 'clip') return false;
  if (bar.axis && clip.axis && bar.axis !== clip.axis) return false;
  const i = AXIS_COMPONENT[bar.axis || clip.axis];
  if (i === undefined) {
    return Math.abs(bar.pos[0] - clip.pos[0]) <= 0.08
      && Math.abs(bar.pos[1] - clip.pos[1]) <= 0.20
      && Math.abs(bar.pos[2] - clip.pos[2]) <= 0.08;
  }
  for (const j of [0, 1, 2]) {
    if (j === i) continue;
    const tol = j === 1 ? 0.20 : 0.08;
    if (Math.abs(bar.pos[j] - clip.pos[j]) > tol) return false;
  }
  const half = typeof bar.span === 'number' ? bar.span : 0;
  return Math.abs(bar.pos[i] - clip.pos[i]) <= half + 0.08;
}

export function connectorPairMatches(s, r) {
  const close = (p1, p2) => Math.abs(p1[0] - p2[0]) <= 0.08 && Math.abs(p1[1] - p2[1]) <= 0.20 && Math.abs(p1[2] - p2[2]) <= 0.08;
  const sameAxis = (a, b) => !a.axis || !b.axis || a.axis === b.axis;
  if (s.kind === 'ball' && r.kind === 'socket') return close(s.pos, r.pos);
  if (s.kind === 'bar' && r.kind === 'clip') return barClipMatches(s, r);
  if (s.kind === 'pin' && r.kind === 'hole') return sameAxis(s, r) && close(s.pos, r.pos);
  if (s.kind === 'pin' && r.kind === 'axle') return sameAxis(s, r) && close(s.pos, r.pos);
  if (s.kind === 'minifig' && r.kind === 'minifig') return s.role === 'peg' && r.role === 'socket' && close(s.pos, r.pos);
  if (s.kind === 'top' && r.kind === 'minifig') return r.role === 'socket' && s.dir === r.dir && close(s.pos, r.pos);
  if (s.kind === 'top' && r.kind === 'antistud') return s.dir === r.dir && close(s.pos, r.pos);
  const PLAIN_STUD_KINDS = new Set(['top', 'side']);
  if (PLAIN_STUD_KINDS.has(s.kind) && r.kind === 'antistud') return s.dir === r.dir && close(s.pos, r.pos);
  return false;
}

/** 轴名 → 分量下标 */
export const AXIS_COMPONENT = { x: 0, y: 1, z: 2 };

/** 零件沿指定轴的半跨度（格）：size 为 [x, z]；y 轴按片高换算。缺数据返回 null（不施加约束）。 */
export function halfSpanAlong(def, axis) {
  const i = AXIS_COMPONENT[axis];
  if (i === undefined || !def) return null;
  if (i === 1) return typeof def.h === 'number' && def.h > 0 ? (def.h * PLATE) / 2 : null;
  const v = Array.isArray(def.size) ? def.size[i === 0 ? 0 : 1] : null;
  return typeof v === 'number' && v > 0 ? v / 2 : null;
}

/**
 * 轮胎↔轮毂同心扣合（**唯一实现**；partsConnected 与 actions-v1/state.js 共用，禁止各写一套）。
 *
 * 判据三条：
 *   ① 轴向一致（两侧都有 axis 时必须相等）；
 *   ② 垂直于轮轴的横截面圆心重合（水平 0.08 / 竖直 0.20 片容差）；
 *   ③ **轴向搭接**：两件沿轮轴的半跨度之和必须覆盖轴向偏移，否则判为「隔空同心」。
 *   ④ 内孔 bore ≤ 轮毂外径 outer ≤ 轮胎外径。
 */
export function rimTyreMatches(rim, rimDef, tyre, tyreDef) {
  const axis = rim.axis || tyre.axis;
  const i = AXIS_COMPONENT[axis];
  if (i === undefined) return false;
  if (rim.axis && tyre.axis && rim.axis !== tyre.axis) return false;
  for (const j of [0, 1, 2]) if (j !== i && Math.abs(rim.pos[j] - tyre.pos[j]) > 0.08) return false;
  const bore = typeof tyre.bore === 'number' ? tyre.bore : null;
  const outer = typeof rim.outer === 'number' ? rim.outer : null;
  if (bore === null || outer === null) return false;
  if (!(bore <= outer + 0.12 && outer <= (typeof tyre.outer === 'number' ? tyre.outer : Infinity) + 0.12)) return false;
  const hr = halfSpanAlong(rimDef, axis), ht = halfSpanAlong(tyreDef, axis);
  const rBand = Array.isArray(rimDef?.wheel?.axialBand) ? rimDef.wheel.axialBand : null;
  const tBand = Array.isArray(tyreDef?.wheel?.axialBand) ? tyreDef.wheel.axialBand : null;
  const maxAxialOffset = (rBand && tBand)
    ? Math.max(0, Math.abs(tBand[1] - tBand[0]) - Math.abs(rBand[1] - rBand[0])) / 2 + 0.08
    : (hr != null && ht != null ? Math.abs(hr - ht) + 0.08 : null);
  if (maxAxialOffset != null && Math.abs(rim.pos[i] - tyre.pos[i]) > maxAxialOffset) return false;
  return true;
}

/** 门扇 ↔ 门框同位铰接判据：朝向与底面中心重合且尺寸匹配 */
export function doorHingeMatches(a, defA, b, defB) {
  if (!defA || !defB) return false;
  const isPair = (defA.kind === 'door' && defB.kind === 'doorframe') || (defA.kind === 'doorframe' && defB.kind === 'door');
  if (!isPair) return false;
  if ((a.up || '+y') !== (b.up || '+y') || (a.rot || 0) !== (b.rot || 0)) return false;
  const ca = partCenter(a, defA), cb = partCenter(b, defB);
  return Math.abs(ca[0] - cb[0]) <= 0.08 && Math.abs(ca[1] - cb[1]) <= 0.20 && Math.abs(ca[2] - cb[2]) <= 0.08;
}

/** 一对零件之间是否至少存在一处真实扣合（含轮胎套轮毂与门扇嵌门框判据） */
export function partsConnected(a, defA, b, defB, connA = partConnectors(a, defA), connB = partConnectors(b, defB)) {
  if (doorHingeMatches(a, defA, b, defB)) return true;
  for (const s of connA.studs) for (const r of connB.receptors) {
    if (s.kind === 'rim' && r.kind === 'tyre') { if (rimTyreMatches(s, defA, r, defB)) return true; continue; }
    if (connectorPairMatches(s, r)) return true;
  }
  for (const s of connB.studs) for (const r of connA.receptors) {
    if (s.kind === 'rim' && r.kind === 'tyre') { if (rimTyreMatches(s, defB, r, defA)) return true; continue; }
    if (connectorPairMatches(s, r)) return true;
  }
  return false;
}

/**
 * 给定父零件的某个凸点 studIndex，自动计算子零件以 receptorIndex 底孔扣合上去时的精确无穿模坐标 { at, up, rot, snot: 0 }
 * 防错加固：底孔编号越界直接抛中文错误（不再静默回退第 0 号）；算出坐标后用 partsConnected
 * 复核父子确实物理扣合，方向不匹配时抛出含双方 id、零件编号、凸点方向与底孔方向的中文错误。
 */
export function snapPart(parentPart, parentDef, studIndex, childPart, childDef, receptorIndex = 0, opts = {}) {
  const pConn = partConnectors(parentPart, parentDef);
  const under = Boolean(opts && opts.under);
  const pAnchor = under ? pConn.receptors[studIndex] : pConn.studs[studIndex];
  if (!pAnchor) {
    throw new Error(under ? `父零件 ${parentPart.id} 不存在底孔 #${studIndex}` : `父零件 ${parentPart.id} 不存在凸点 #${studIndex}`);
  }
  const up = childPart.up || pAnchor.dir;
  const rot = childPart.rot || 0;
  const probe = { id: '_probe', part: childPart.part, at: [0, 0, 0], rot, up, snot: 0 };
  const cConn = partConnectors(probe, childDef);
  const cAnchor = under ? cConn.studs[receptorIndex] : cConn.receptors[receptorIndex];
  if (!cAnchor) {
    const n = under ? cConn.studs.length : cConn.receptors.length;
    throw new Error(
      under
        ? `子零件 ${childPart.id || '(未命名)'}（零件 ${childPart.part}）没有第 ${receptorIndex} 号凸点：该零件共 ${n} 个凸点（编号 0~${n - 1}）`
        : `子零件 ${childPart.id || '(未命名)'}（零件 ${childPart.part}）没有第 ${receptorIndex} 号底孔：该零件共 ${n} 个底孔（编号 0~${n - 1}），不再静默回退到第 0 号`
    );
  }
  const stud = under ? cAnchor : pAnchor;
  const rec = under ? pAnchor : cAnchor;
  const childId = childPart.id || `(未命名 ${childPart.part})`;
  const snapped = {
    ...childPart,
    up,
    rot,
    snot: 0,
    at: [
      r6(pAnchor.pos[0] - cAnchor.pos[0]),
      r6(pAnchor.pos[1] - cAnchor.pos[1]),
      r6(pAnchor.pos[2] - cAnchor.pos[2]),
    ],
  };
  if (!partsConnected(parentPart, parentDef, snapped, childDef, pConn, partConnectors(snapped, childDef))) {
    // 归因：把柄只能扣夹子、销只能插销孔/轴孔、轮毂对轮胎、人仔插柱对插孔（kind 不匹配）；kind 匹配时才是朝向问题
    const kindMatched = (stud.kind === 'bar' && rec.kind === 'clip')
      || (stud.kind === 'pin' && (rec.kind === 'hole' || rec.kind === 'axle'))
      || (stud.kind === 'rim' && rec.kind === 'tyre')
      || (stud.kind === 'minifig' && rec.kind === 'minifig')
      || (stud.kind === 'top' && rec.kind === 'minifig')
      || (stud.kind !== 'bar' && stud.kind !== 'pin' && stud.kind !== 'minifig' && rec.kind === 'antistud');
    const reason = !kindMatched
      ? `连接类型不匹配：${stud.label || stud.kind}（${stud.kind}）无法扣进 ${rec.kind}（把柄只能扣夹子，凸点只能扣底孔，销只能插销孔/轴孔，轮毂只能对轮胎，人仔插柱只能插人仔插孔）`
      : `方向不匹配：凸点朝向 ${stud.dir} 与底孔朝向 ${rec.dir} 不一致`;
    throw new Error(
      `snap 结果不成立：父零件 ${parentPart.id}（零件 ${parentPart.part}）的${under ? '底孔' : '凸点'} #${studIndex}（朝向 ${pAnchor.dir}）` +
      `与子零件 ${childId}（零件 ${childPart.part}）的${under ? '凸点' : '底孔'} #${receptorIndex}（朝向 ${cAnchor.dir}）${reason}，不构成物理扣合；` +
      `请让子件 up 与凸点朝向一致，或改经 SNOT 侧凸点砖 / 倒顺支架 / 外挑托板转接`
    );
  }
  return snapped;
}

// ---------------------------------------------------------------- 3D 刚体挂装 / 挂点自动搜索 / 参数化装配树重算
/** 预计算 24 种立方体正交姿态 (rot ∈ {0,90,180,270}, up ∈ UPS) 的三轴单位向量 */
const POSE_TABLE = (() => {
  const list = [];
  for (const up of UPS) {
    for (const rot of ROTS) {
      list.push({
        rot,
        up,
        ux: rotateLocalVec(1, 0, 0, rot, up),
        uy: rotateLocalVec(0, 1, 0, rot, up),
        uz: rotateLocalVec(0, 0, 1, rot, up),
      });
    }
  }
  return list;
})();

function findOrthoPose(ux, uy, uz) {
  return POSE_TABLE.find((p) =>
    Math.abs(p.ux[0] - ux[0]) < 1e-3 && Math.abs(p.ux[1] - ux[1]) < 1e-3 && Math.abs(p.ux[2] - ux[2]) < 1e-3 &&
    Math.abs(p.uy[0] - uy[0]) < 1e-3 && Math.abs(p.uy[1] - uy[1]) < 1e-3 && Math.abs(p.uy[2] - uy[2]) < 1e-3 &&
    Math.abs(p.uz[0] - uz[0]) < 1e-3 && Math.abs(p.uz[1] - uz[1]) < 1e-3 && Math.abs(p.uz[2] - uz[2]) < 1e-3
  ) || { rot: 0, up: localDirToWorld(uy[0], uy[1], uy[2]) };
}

/** 逆向 rotateLocalVec(v, 0, dir)：将世界朝向 dir 的向量映回标准 +y 朝向 */
function unrotateDirVec(vx, vy, vz, dir = '+y') {
  if (dir === '+y') return [vx, vy, vz];
  if (dir === '-y') return [vx, -vy, -vz];
  if (dir === '+z') return [vx, vz, -vy];
  if (dir === '-z') return [vx, -vz, vy];
  if (dir === '+x') return [-vy, vx, vz];
  if (dir === '-x') return [vy, -vx, vz];
  return [vx, vy, vz];
}

/**
 * 将由 dir1 朝向定义的局部欧氏向量 v（统一以“格”为单位）旋转到 dir2 朝向，并绕法向自旋 rotDeg 度：
 *   v' = B(dir2) · R_y(rotDeg) · B(dir1)^T · v
 * 当 dir1 === '+y' 且 dir2 === '+y' 时，严格退化为 [rotXZ(vx, vz, rotDeg), vy]。
 */
export function rotateBetweenDirs(vx, vy, vz, dir1 = '+y', dir2 = '+y', rotDeg = 0) {
  const [x0, y0, z0] = unrotateDirVec(vx, vy, vz, dir1);
  const [x1, z1] = rotXZ(x0, z0, rotDeg);
  return rotateLocalVec(x1, y0, z1, 0, dir2);
}

/**
 * 3D 子组件刚体变换：将一组零件 members = [{ p, def }, ...] 围绕 anchorId 的第 anchorReceptor 号底孔
 * 旋转（含平面旋转与 90°/180° SNOT 翻立）并平移扣合到 parent 的第 studIndex 号凸点上。
 * 成功返回变换后的零件数组 placed（深拷贝），若无法物理扣合或非 SNOT 整数格非法则返回 null。
 */
export function transformAssembly3D(members, parent, parentDef, studIndex, anchorId, anchorReceptor = 0, rotDeg = 0) {
  const pConn = partConnectors(parent, parentDef);
  const parentStud = pConn.studs[studIndex];
  if (!parentStud) return null;
  const anchorEntry = members.find(({ p }) => p.id === anchorId);
  if (!anchorEntry) return null;
  const aConn = partConnectors(anchorEntry.p, anchorEntry.def);
  const aRec = aConn.receptors[anchorReceptor];
  if (!aRec) return null;

  const d1 = aRec.dir || '+y';
  const d2 = parentStud.dir || '+y';
  // 统一转换到以“格 (stud)”为单位的 3D 欧氏空间做刚体旋转 + 平移
  const R0 = [aRec.pos[0], aRec.pos[1] * PLATE, aRec.pos[2]];
  const S = [parentStud.pos[0], parentStud.pos[1] * PLATE, parentStud.pos[2]];
  const snotMount = d1 !== '+y' || d2 !== '+y' || isSnotLike(parent);

  const out = [];
  for (const { p, def } of members) {
    const c = partCenter(p, def);
    const C = [c[0], c[1] * PLATE, c[2]];
    const rel = [C[0] - R0[0], C[1] - R0[1], C[2] - R0[2]];
    const rotRel = rotateBetweenDirs(rel[0], rel[1], rel[2], d1, d2, rotDeg);
    const C2 = [S[0] + rotRel[0], S[1] + rotRel[1], S[2] + rotRel[2]];
    const c2 = [r6(C2[0]), r6(C2[1] / PLATE), r6(C2[2])];

    const pRot = p.rot || 0, pUp = p.up || '+y';
    const ux0 = rotateLocalVec(1, 0, 0, pRot, pUp);
    const uy0 = rotateLocalVec(0, 1, 0, pRot, pUp);
    const uz0 = rotateLocalVec(0, 0, 1, pRot, pUp);
    const ux = rotateBetweenDirs(ux0[0], ux0[1], ux0[2], d1, d2, rotDeg);
    const uy = rotateBetweenDirs(uy0[0], uy0[1], uy0[2], d1, d2, rotDeg);
    const uz = rotateBetweenDirs(uz0[0], uz0[1], uz0[2], d1, d2, rotDeg);
    const pose = findOrthoPose(ux, uy, uz);

    // 当 d1==='+y' 且 d2==='+y' 且零件原 snot 存在时保留原 snot，否则归零由 at 精确表达
    const snot = (!snotMount && p.snot) ? p.snot : 0;
    const off = partCenter({ at: [0, 0, 0], rot: pose.rot, up: pose.up, snot }, def);
    const at = [r6(c2[0] - off[0]), r6(c2[1] - off[1]), r6(c2[2] - off[2])];
    const cand = { ...p, at, rot: pose.rot, up: pose.up, snot };
    if (!snotMount && !isSnotLike(cand) && !def.offGrid && !at.every(Number.isInteger)) return null;
    out.push(cand);
  }
  const candAnchor = out.find((p) => p.id === anchorId);
  if (!partsConnected(parent, parentDef, candAnchor, anchorEntry.def, pConn, partConnectors(candAnchor, anchorEntry.def))) {
    return null;
  }
  return out;
}

/**
 * 自动搜索子模型 subModel 挂装到主模型 mainModel 上的全部合法无穿模候选方案。
 * opts: { parent?: string, anchor?: string, stud?: number, receptor?: number, rot?: number, maxResults?: number,
 *        includeParentCollision?: boolean }
 *
 * 父件碰撞（EN-02 / PRD §7.3）：候选必须对「全部相关零件」查碰撞，**包括父件本身**。
 * 历史上这里 `if (other.id === parent.id) continue;` 整件豁免父件，导致「以上片为锚点挂两片板、
 * 下片穿进父砖」的候选被当成合法返回。接触合法性应由连接器规则表达，不能用整件豁免表达。
 * 仍可为极少数确实与父件共面贴合的情形显式传 includeParentCollision:false，但那必须由调用方
 * 自己的连接证据背书，并会写进候选的 collisionChecked.includesParent=false。
 */
export function findMounts(mainModel, subModel, cat, opts = {}) {
  const mainParts = (mainModel?.parts || []).filter((p) => p && cat.parts[p.part]);
  const subParts = (subModel?.parts || []).filter((p) => p && cat.parts[p.part]);
  if (!mainParts.length || !subParts.length) return [];

  const members = subParts.map((p) => ({ p, def: cat.parts[p.part] }));
  const anchorId = opts.anchor || subModel.anchor || subModel.meta?.anchor || subParts[0].id;
  const anchorEntry = members.find(({ p }) => p.id === anchorId);
  if (!anchorEntry) return [];

  const includeParentCollision = opts.includeParentCollision !== false;
  const mainBoxes = new Map(mainParts.map((p) => [p.id, partBoxes(p, cat.parts[p.part])]));
  const parents = opts.parent ? mainParts.filter((p) => p.id === opts.parent) : mainParts;
  const rots = opts.rot !== undefined ? [opts.rot] : ROTS;
  const maxResults = opts.maxResults ?? 200;
  const aConn = partConnectors(anchorEntry.p, anchorEntry.def);
  const recIndices = opts.receptor !== undefined ? [opts.receptor] : aConn.receptors.map((_, i) => i);

  const results = [];
  for (const parent of parents) {
    const pDef = cat.parts[parent.part];
    const pConn = partConnectors(parent, pDef);
    const studIndices = opts.stud !== undefined ? [opts.stud] : pConn.studs.map((_, i) => i);
    for (const sIdx of studIndices) {
      const stud = pConn.studs[sIdx];
      if (!stud) continue;
      if (opts.dir && stud.dir !== opts.dir) continue;
      for (const rIdx of recIndices) {
        if (!aConn.receptors[rIdx]) continue;
        for (const deg of rots) {
          const placed = transformAssembly3D(members, parent, pDef, sIdx, anchorId, rIdx, deg);
          if (!placed) continue;
          let collided = false;
          const collidedWith = new Set();
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
          for (const cand of placed) {
            const cDef = cat.parts[cand.part];
            const boxes = partBoxes(cand, cDef);
            for (const b of boxes) {
              if (b.x0 < minX) minX = b.x0; if (b.x1 > maxX) maxX = b.x1;
              if (b.y0 < minY) minY = b.y0; if (b.y1 > maxY) maxY = b.y1;
              if (b.z0 < minZ) minZ = b.z0; if (b.z1 > maxZ) maxZ = b.z1;
            }
            for (const other of mainParts) {
              // 父件必须参与碰撞：挂装候选常以组内上片为锚点，下片会穿进父砖。
              // 兼容旧调用方可用 includeParentCollision:false 显式豁免，但结果会被标记。
              if (other.id === parent.id && !includeParentCollision) continue;
              if (partsCollide(cand, cDef, boxes, other, cat.parts[other.part], mainBoxes.get(other.id))) {
                collided = true;
                collidedWith.add(other.id);
                break;
              }
            }
            if (collided) break;
          }
          if (!collided) {
            results.push({
              parent: parent.id,
              parentPart: parent.part,
              stud: sIdx,
              studLabel: stud.label || `${stud.kind}-${sIdx}`,
              studDir: stud.dir,
              studPos: stud.pos,
              anchor: anchorId,
              anchorPart: anchorEntry.p.part,
              anchorReceptor: rIdx,
              rot: deg,
              worldBBox: minX < Infinity ? { x0: r6(minX), x1: r6(maxX), y0: r6(minY), y1: r6(maxY), z0: r6(minZ), z1: r6(maxZ) } : null,
              collisionChecked: { includesParent: includeParentCollision, againstCount: mainParts.length },
              placed,
            });
            if (results.length >= maxResults) return results;
          }
        }
      }
    }
  }
  return results;
}

/**
 * 参数化装配树拓扑级联重算：
 * 1) 具有 rootAt 的根零件先重置 at = [...rootAt]；
 * 2) 沿零件的 snap: { on, stud, receptor, rot, up } 依赖关系拓扑重算子件坐标；
 * 3) 对 model.mounts 中声明的子组件挂载（引用 model.submodels 或组内成员），执行 3D 刚体变换更新坐标；
 * 4) 对挂载在子组件零件之上的后续单件再做一轮拓扑更新。
 *
 * 失败处理（AS-04）：snap 依赖有环、或 snap.on 指向不存在的零件，必须抛结构化错误，
 * 不得「能解的先解、环内的静默保留旧坐标」——旧行为会让非法图通过校验并沿用过期坐标。
 * 出错时 model 保持调用前状态（求解在副本上推进，成功后才写回）。
 */
export function recompute(model, cat) {
  if (!model || !Array.isArray(model.parts)) return model;
  const byId = new Map(model.parts.map((p) => [p.id, p]));
  const mountedGroupIds = new Set((model.mounts || []).map((m) => m.id).filter(Boolean));

  // —— 定位依赖图完整性：悬空引用与环必须先报错，再谈求解 ——
  const snapDeps = new Map();
  for (const p of model.parts) {
    if (p && p.snap && p.snap.on) {
      if (!byId.has(p.snap.on)) {
        const err = new Error(`recompute：零件 ${p.id} 的 snap.on 指向不存在的零件 ${p.snap.on}（缺引用）`);
        err.code = 'snap-missing-reference';
        err.parts = [p.id, p.snap.on];
        throw err;
      }
      snapDeps.set(p.id, p.snap.on);
    }
  }
  if (snapDeps.size) {
    // 三色 DFS 找环；环上节点全部报出
    const WHITE = 0, GREY = 1, BLACK = 2;
    const color = new Map([...snapDeps.keys()].map((id) => [id, WHITE]));
    const stack = [];
    for (const start of snapDeps.keys()) {
      if (color.get(start) !== WHITE) continue;
      const path = [];
      let cur = start;
      while (cur !== undefined && color.get(cur) === WHITE) {
        color.set(cur, GREY);
        path.push(cur);
        cur = snapDeps.get(cur);
      }
      if (cur !== undefined && color.get(cur) === GREY) {
        const at = path.indexOf(cur);
        const cycle = path.slice(at >= 0 ? at : 0).concat(cur);
        const err = new Error(`recompute：snap 定位依赖存在环（${cycle.join(' → ')}），无法拓扑排序；请检查这些零件的 snap.on 是否互相引用`);
        err.code = 'snap-cycle';
        err.parts = cycle;
        throw err;
      }
      for (const id of path) color.set(id, BLACK);
    }
  }

  // 求解缓冲：先写副本，全部成功再一次性写回（原子性）。
  // 注意：后续节点必须读到「待提交态」的父坐标，否则原子缓冲会破坏 snap 的顺序依赖。
  const pending = new Map();   // id -> { at, rot, up, snot }
  const viewOf = (p) => {
    const pend = pending.get(p.id);
    return pend ? { ...p, ...pend } : p;
  };

  // 1. 重置根零件坐标
  for (const p of model.parts) {
    if (Array.isArray(p.rootAt) && p.rootAt.length === 3 && !p.snap) {
      pending.set(p.id, { at: [...p.rootAt] });
    }
  }

  // 辅助：对非挂装组内部（或挂装已就绪）的单件按 snap 树拓扑重算
  const resolveSnaps = (skipSubassemblies = true) => {
    const resolved = new Set();
    for (const p of model.parts) {
      if (skipSubassemblies && p.subassembly && mountedGroupIds.has(p.subassembly)) continue;
      if (!p.snap || !p.snap.on || !byId.has(p.snap.on)) resolved.add(p.id);
    }
    let progress = true;
    while (progress) {
      progress = false;
      for (const p of model.parts) {
        if (resolved.has(p.id)) continue;
        if (skipSubassemblies && p.subassembly && mountedGroupIds.has(p.subassembly)) continue;
        const s = p.snap;
        if (!s || !s.on) { resolved.add(p.id); continue; }
        if (!resolved.has(s.on)) continue;
        const parent = viewOf(byId.get(s.on));   // 读待提交态：父件可能刚刚在本轮被重算
        const pDef = cat.parts[parent.part], cDef = cat.parts[p.part];
        if (pDef && cDef) {
          const snapped = snapPart(
            parent, pDef, s.stud ?? 0,
            { ...p, rot: s.rot !== undefined ? s.rot : (p.rot || 0), ...(s.up !== undefined ? { up: s.up } : { up: undefined }) },
            cDef, s.receptor ?? 0,
            { under: Boolean(s.under) }
          );
          pending.set(p.id, { at: snapped.at, rot: snapped.rot, up: snapped.up, snot: snapped.snot });
        }
        resolved.add(p.id);
        progress = true;
      }
    }
    // 到这里不应再有未解析节点（环与缺引用已在前面抛错）；若仍有，说明依赖图不完整
    const unresolved = model.parts.filter((p) => !resolved.has(p.id)
      && !(skipSubassemblies && p.subassembly && mountedGroupIds.has(p.subassembly)));
    if (unresolved.length) {
      const err = new Error(`recompute：${unresolved.length} 个零件的 snap 依赖无法解析（${unresolved.slice(0, 6).map((p) => p.id).join(', ')}）`);
      err.code = 'snap-unresolved';
      err.parts = unresolved.map((p) => p.id);
      throw err;
    }
  };

  resolveSnaps(true);

  // 2. 处理 mounts 子模型 3D 刚体挂装
  if (Array.isArray(model.mounts)) {
    for (const m of model.mounts) {
      const parent = viewOf(byId.get(m.on));   // 读待提交态：父件可能刚在本轮被重算抬高
      if (!parent || !cat.parts[parent.part]) continue;
      let sourceParts = null;
      if (m.submodel && model.submodels && model.submodels[m.submodel]) {
        const sub = model.submodels[m.submodel];
        // 子模型自身也必须有合法依赖图（递归调用会走同样的环/缺引用检查）
        recompute(sub, cat);
        const prefix = m.prefix ?? `${m.id || m.submodel}_`;
        sourceParts = (sub.parts || []).map((sp) => {
          const pid = m.idMap?.[sp.id] || (byId.has(sp.id) ? sp.id : `${prefix}${sp.id}`);
          return { p: { ...sp, id: pid }, def: cat.parts[sp.part] };
        });
      } else if (m.id) {
        sourceParts = model.parts.filter((p) => p.subassembly === m.id).map((p) => ({ p: viewOf(p), def: cat.parts[p.part] }));
      }
      if (!sourceParts || !sourceParts.length) continue;
      const anchorId = m.anchor || sourceParts[0].p.id;
      const placed = transformAssembly3D(
        sourceParts, parent, cat.parts[parent.part],
        m.stud ?? 0, anchorId, m.anchorReceptor ?? 0, m.rot ?? 0
      );
      if (placed) {
        for (const cand of placed) {
          pending.set(cand.id, { at: cand.at, rot: cand.rot, up: cand.up, snot: cand.snot });
        }
      } else {
        const err = new Error(`recompute：子组件 ${m.id || m.submodel} 无法按锚点 ${anchorId} 扣到父零件 ${parent.id}（接口不匹配或变换后非整数格）`);
        err.code = 'mount-unsolvable';
        err.parts = [parent.id, anchorId];
        throw err;
      }
    }
    // 3. 子模型就位后，若有单件 snap.on 指向子模型内部零件，再做一轮拓扑更新
    mountedGroupIds.clear();
    resolveSnaps(false);
  }

  // 全部成功：一次性写回（原子提交）
  for (const [id, pose] of pending) {
    const target = byId.get(id);
    if (!target) continue;
    if (pose.at) target.at = pose.at;
    if (pose.rot !== undefined) target.rot = pose.rot;
    if (pose.up !== undefined) target.up = pose.up;
    if (pose.snot !== undefined) target.snot = pose.snot;
  }
  return model;
}


// ---------------------------------------------------------------- 模块 / 子组件 / 步骤计划
/** 零件所属模块（兼容 0.1 的 group 字段） */
export const partModule = (p) => p.module ?? p.group ?? null;
export function moduleMap(model) {
  const map = new Map();
  for (const m of model.modules || []) if (m && typeof m.id === 'string' && !map.has(m.id)) map.set(m.id, m);
  return map;
}
/** 沿 parent 链找到最近的“子组件”（subassembly: true）模块 */
export function subOfModule(mods, id) {
  const seen = new Set();
  while (id && mods.has(id) && !seen.has(id)) { seen.add(id); const m = mods.get(id); if (m.subassembly) return id; id = m.parent; }
  return null;
}
/** 模块 id 及其所有祖先 */
export function moduleChain(mods, id) {
  const out = [], seen = new Set();
  while (id && !seen.has(id)) { seen.add(id); out.push(id); id = mods.get(id)?.parent; }
  return out;
}
/**
 * 步骤计划：把零件步骤、无零件的“装配步”（steps[].attach）合并排序，并标出子组件步骤。
 * 返回 { steps:[{n,title,note,parts,attach,sub}], subs: Map(id→{id,label,attachStep,parts,steps}), partSub: Map(partId→subId), mods }
 */
export function stepPlan(model) {
  const mods = moduleMap(model);
  const parts = (model.parts || []).filter((p) => p && typeof p.id === 'string');
  const defs = new Map((model.steps || []).filter((s) => s && Number.isInteger(s.n)).map((s) => [s.n, s]));
  const subs = new Map();
  for (const m of mods.values()) if (m.subassembly) {
    const att = [...defs.values()].find((s) => s.attach === m.id);
    if (att) subs.set(m.id, { id: m.id, label: m.label || m.id, attachStep: att.n, parts: [], steps: [] });
  }
  const partSub = new Map();
  for (const p of parts) { const sid = subOfModule(mods, partModule(p)); if (sid && subs.has(sid)) { partSub.set(p.id, sid); subs.get(sid).parts.push(p.id); } }
  const nums = new Set(parts.map((p) => p.step).filter(Number.isInteger));
  for (const s of subs.values()) nums.add(s.attachStep);
  const steps = [...nums].sort((a, b) => a - b).map((n) => {
    const def = defs.get(n) || {}, ps = parts.filter((p) => p.step === n);
    const ids = [...new Set(ps.map((p) => partSub.get(p.id) || null))];
    const only = ids.length === 1 ? ids[0] : null;
    const sub = only && n < subs.get(only).attachStep ? only : null;
    return { n, title: def.title || '', note: def.note || '', parts: ps.map((p) => p.id), attach: def.attach && subs.has(def.attach) ? def.attach : null, sub, mixed: ids.length > 1 && ids.some(Boolean) };
  });
  for (const s of steps) if (s.sub) subs.get(s.sub).steps.push(s.n);
  return { steps, subs, partSub, mods };
}

// ---------------------------------------------------------------- 校验
export function validate(model, cat, opts = {}) {
  const errors = [], warnings = [], info = [];
  const E = (code, msg, parts = []) => errors.push({ code, msg, parts });
  const W = (code, msg, parts = []) => warnings.push({ code, msg, parts });
  if (!model || typeof model !== 'object') { E('model', '不是有效的 JSON 对象'); return { ok: false, errors, warnings, info }; }
  if (model.format !== FORMAT) W('format', `format 应为 "${FORMAT}"`);
  if (!Array.isArray(model.parts)) { E('parts', 'parts 必须是数组'); return { ok: false, errors, warnings, info }; }

  const byId = new Map(), good = [];
  const looseAt = new Set();     // 1/4 片小数层的零件 id（待连通图确认确实扣在非整数高度凸点上）
  for (const [n, p] of model.parts.entries()) {
    const tag = p && p.id ? p.id : `#${n}`;
    if (!p || typeof p !== 'object') { E('part', `第 ${n} 个零件不是对象`); continue; }
    if (!p.id || typeof p.id !== 'string') { E('id', `第 ${n} 个零件缺少 id`); continue; }
    if (byId.has(p.id)) { E('id-dup', `零件 id 重复：${p.id}`, [p.id]); continue; }
    byId.set(p.id, p);
    const def = cat.parts[p.part];
    if (!def) { E('part-unknown', `${tag}：目录里没有零件 ${p.part}`, [p.id]); continue; }
    if (cat.colors && !cat.colors[String(p.color)]) W('color-unknown', `${tag}：颜色代码 ${p.color} 不在颜色表中`, [p.id]);
    const isSnot = isSnotLike(p);
    if (p.up !== undefined && !UPS.includes(p.up)) { E('up', `${tag}：up 只能是 +y/-y/+z/-z/+x/-x`, [p.id]); continue; }
    if (p.snot !== undefined && !Number.isInteger(p.snot)) { E('snot', `${tag}：snot 必须是整数（沿 up 方向偏移的片数）`, [p.id]); continue; }
    // 目录标记 offGrid（轮毂/轮胎等圆盘件）时 at 允许任意有限数：轮心必然落在格线之外
    const looseAtAllowed = isSnot || def.offGrid || Boolean(def.wheel);
    if (!Array.isArray(p.at) || p.at.length !== 3 || !p.at.every((v) => looseAtAllowed ? typeof v === 'number' && Number.isFinite(v) : Number.isInteger(v))) { E('at', `${tag}：at 必须是 3 个整数 [x, 层, z]`, [p.id]); continue; }
    // 多高度凸点：up=+y、x/z 为整数格、y 为 1/4 片小数的零件算「暂定合法」，连通图确认后才放行。
    // 已经带 mount/snot/非 +y 的件走原有 SNOT 路径（历史上就允许任意有限数），不受这条约束影响。
    if (isRaisedOffGrid(p) && !p.mount && !p.snot) {
      if (def.offGrid || def.wheel) { /* 圆盘/轮类：轮心必然离格，任意有限 at 合法（穿模由 3D 盒负责） */ }
      else if (Number.isInteger(p.at[0]) && Number.isInteger(p.at[2]) && quarterInteger(p.at[1])) looseAt.add(p.id);
      else { E('at', `${tag}：at 必须是 3 个整数 [x, 层, z]（内腔凸点扣合只放宽 y 到 1/4 片）`, [p.id]); continue; }
    }
    if (!ROTS.includes(p.rot ?? 0)) { E('rot', `${tag}：rot 只能是 0/90/180/270`, [p.id]); continue; }
    if (!Number.isInteger(p.step) || p.step < 1) { E('step', `${tag}：step 必须是 ≥1 的整数`, [p.id]); continue; }
    if (p.status && !['confirmed', 'inferred', 'uncertain'].includes(p.status)) W('status', `${tag}：status 只能是 confirmed / inferred / uncertain`, [p.id]);
    good.push({ p, def });
  }
  const stepNums = new Set((model.steps || []).map((s) => s.n));
  for (const { p } of good) if (model.steps && !stepNums.has(p.step)) W('step-undefined', `${p.id}：第 ${p.step} 步没有在 steps 中定义`, [p.id]);

  // 模块与子组件
  const mods = moduleMap(model), plan = stepPlan(model);
  if (model.modules !== undefined && !Array.isArray(model.modules)) E('modules', 'modules 必须是数组');
  const modSeen = new Set();
  for (const m of Array.isArray(model.modules) ? model.modules : []) {
    if (!m || typeof m.id !== 'string' || !m.id) { E('module-id', '模块缺少 id'); continue; }
    if (modSeen.has(m.id)) E('module-id', `模块 id 重复：${m.id}`); modSeen.add(m.id);
    if (m.parent !== undefined && !mods.has(m.parent)) E('module-parent', `模块 ${m.id}：parent 指向不存在的模块 ${m.parent}`);
    { let id = m.parent, n = 0; while (id && n++ < 64 && id !== m.id) id = mods.get(id)?.parent; if (id === m.id) E('module-cycle', `模块 ${m.id}：parent 形成了循环`); }
    if (m.explode !== undefined && !(Array.isArray(m.explode) && m.explode.length === 3 && m.explode.every((v) => typeof v === 'number'))) E('module-explode', `模块 ${m.id}：explode 必须是 3 个数字 [x格, 层(片), z格]`);
    if (m.subassembly && !plan.subs.has(m.id)) E('sub-attach', `子组件 ${m.id}：需要在 steps 里加一个装配步，例如 { "n": 15, "title": "装上${m.label || m.id}", "attach": "${m.id}" }`);
  }
  const unknownMod = good.filter(({ p }) => partModule(p) != null && !mods.has(partModule(p))).map(({ p }) => p.id);
  if (unknownMod.length && mods.size) W('module-unknown', `${unknownMod.length} 个零件的 module 没有在 modules 中定义：${unknownMod.slice(0, 8).join(', ')}`, unknownMod);
  for (const st of model.steps || []) if (st && st.attach !== undefined) {
    if (!mods.has(st.attach)) E('attach', `第 ${st.n} 步：attach 指向不存在的模块 ${st.attach}`);
    else if (!mods.get(st.attach).subassembly) E('attach', `第 ${st.n} 步：模块 ${st.attach} 不是子组件（需要 subassembly: true）`);
  }
  for (const sub of plan.subs.values()) {
    const late = good.filter(({ p }) => plan.partSub.get(p.id) === sub.id && p.step >= sub.attachStep).map(({ p }) => p.id);
    if (late.length) E('attach-order', `子组件 ${sub.id} 在第 ${sub.attachStep} 步装上，但 ${late.slice(0, 6).join(', ')} 的 step 不早于装配步`, late);
    if (!sub.parts.length) W('sub-empty', `子组件 ${sub.id} 没有零件`);
  }
  for (const st of plan.steps) if (st.mixed) W('sub-mixed', `第 ${st.n} 步同时包含子组件和主体的零件，建议分成两步`, st.parts);

  // 1) 标准整数网格占位冲突（snot 竖直偏移件除外：其物理占层与 at[1] 不一致，交由下方 3D 包围盒检查）
  //    带 boxes 多盒分解的凹形件（座舱槽 / 轮拱 / 双阶斜坡）不参与整格占用：其空腔格在网格上「有格无料」，
  //    内饰件必须能放进去——这类件的穿模由下方 3D 盒检查（更严）负责。
  const occ = new Map();
  for (const { p, def } of good) {
    if (def.occupies === false || def.offGrid || (p.up && p.up !== '+y') || p.snot || !p.at.every(Number.isInteger)) continue;
    if (Array.isArray(def.boxes) && def.boxes.length) continue;
    for (const f of footprint(p, def)) for (let y = p.at[1]; y < p.at[1] + def.h; y++) {
      const key = `${f.x},${y},${f.z}`, o = occ.get(key);
      if (o && o !== p.id) {
        if (!warnings.some((w) => w.code === 'overlap' && w.parts.includes(o) && w.parts.includes(p.id)))
          E('overlap', `${o} 与 ${p.id} 在格子 [${f.x}, ${y}, ${f.z}] 重叠`, [o, p.id]);
      } else occ.set(key, p.id);
    }
  }
  // 2) 全方向 3D 实体包围盒防穿模检查（覆盖全部 SNOT 侧装件、非整数偏移件与支架）
  // P0-b：目录条目 schema 缺陷（如 bracket 缺 vH/dir）转为校验错误，不再让异常炸掉整个 validate
  const boxesMap = new Map();
  for (const { p, def } of good) {
    try { boxesMap.set(p.id, partBoxes(p, def)); }
    catch (e) { E('part-schema', `${p.id}：${e.message}`, [p.id]); boxesMap.set(p.id, []); }
  }
  // CP-02：连接器表提前构建（两个 O(n²) 循环共用）；每件按自身连接器外悬算外扩 AABB，
  // 用栅格裁剪出「可能穿模/可能连接」的候选对。near[i] 升序 → 幸存 (i,j) 遍历顺序与
  // 朴素双重循环一致，错误与连接的落盘顺序不变（行为保持，见 tools/perf-cp02.mjs 指纹对账）。
  const connMap = new Map();
  for (const { p, def } of good) {
    try { connMap.set(p.id, partConnectors(p, def)); }
    catch (e) { connMap.set(p.id, { studs: [], receptors: [] }); }
  }
  const near = nearPairCandidates(good.map(({ p, def }) => partAabbWithMargin(p, def, connMap.get(p.id))));
  for (let i = 0; i < good.length; i++) {
    const a = good[i].p;
    const aDef = a.def ?? cat.parts[a.part];
    for (const j of near[i]) {
      const b = good[j].p;
      const bDef = cat.parts[b.part];
      // 快速跳过：两个都是「标准整数格水平实心件」时，整格占用检查（上一步）已经覆盖，
      // 不必再做 3D 盒检查。但只要**任一方带多盒分解**（凹形件：卫星锅/底盘座舱槽/轮拱），
      // 整格占用就会因「空腔格有格无料」而跳过它，此时必须走 3D 盒检查——否则
      // 「4740 凹陷件与相邻砖重叠」这类组合两条路径都跳过，穿模直接漏检。
      const hasMultiBox = (d) => Array.isArray(d?.boxes) && d.boxes.length > 0;
      if ((!a.up || a.up === '+y') && (!b.up || b.up === '+y') && a.at.every(Number.isInteger) && b.at.every(Number.isInteger) && !a.snot && !b.snot
        && !aDef?.offGrid && !bDef?.offGrid && !hasMultiBox(aDef) && !hasMultiBox(bDef)) continue;
      const hit = partsCollide(a, aDef, boxesMap.get(a.id), b, bDef, boxesMap.get(b.id));
      if (hit) E('overlap', `${a.id} 与 ${b.id} 在格子 [${hit[0]}, ${hit[1]}, ${hit[2]}] 重叠（3D 穿模）`, [a.id, b.id]);
    }
  }
  // 去重重叠报告
  const seen = new Set();
  for (let i = errors.length - 1; i >= 0; i--) if (errors[i].code === 'overlap') {
    const k = errors[i].parts.slice().sort().join('|'); if (seen.has(k)) errors.splice(i, 1); else seen.add(k);
  }

  // 凸点连接图（标准 +y 网格凸点 + 3D 物理连接器匹配 + mount 显式挂载）
  const studs = new Map();               // "x,z,layer" -> [partId]
  for (const { p, def } of good) if ((!p.up || p.up === '+y') && p.at.every(Number.isInteger) && !p.snot) for (const f of footprint(p, def)) if (f.stud) {
    const k = `${f.x},${f.z},${topLayer(p, def)}`; (studs.get(k) || studs.set(k, []).get(k)).push(p.id);
  }
  const adj = new Map(good.map(({ p }) => [p.id, new Set()]));
  const link = (a, b) => { if (adj.has(a) && adj.has(b)) { adj.get(a).add(b); adj.get(b).add(a); } };
  const antiCellKeys = new Map();
  for (const { p } of good) {
    const keys = new Set();
    for (const r of connMap.get(p.id)?.receptors || []) {
      if (r.kind !== 'antistud' || r.i < 0) continue;         // 中央内腔受体（i=-1）不对应任何整格凸点
      keys.add(`${Math.round(r.pos[0] - 0.5)},${Math.round(r.pos[2] - 0.5)},${Math.round(r.pos[1] * 1000) / 1000}`);
    }
    antiCellKeys.set(p.id, keys);
  }
  for (const { p, def } of good) {
    if (def.kind === 'door' || (p.up && p.up !== '+y') || !p.at.every(Number.isInteger) || p.snot) continue;
    const anti = antiCellKeys.get(p.id);
    const layerKey = Math.round(p.at[1] * 1000) / 1000;
    for (const f of footprint(p, def)) {
      if (!anti.has(`${f.x},${f.z},${layerKey}`)) continue;   // 该格底面没有真实底孔 → 不得加边
      for (const id of studs.get(`${f.x},${f.z},${p.at[1]}`) || []) if (id !== p.id) link(p.id, id);
    }
  }
  // 3D 连接器自动物理匹配（凸点对底孔、把柄对夹子、销对销孔）——connMap 已在上方构建
  for (let i = 0; i < good.length; i++) {
    const a = good[i];
    for (const j of near[i]) {
      const b = good[j];
      if (adj.get(a.p.id).has(b.p.id)) continue;
      if (partsConnected(a.p, a.def, b.p, b.def, connMap.get(a.p.id), connMap.get(b.p.id))) {
        link(a.p.id, b.p.id);
      }
    }
  }
  /**
   * 非法连接（cavity-friction 等）：显式声明「这两件在实物上确实靠空腔摩擦/夹持连在一起，
   * 但目录里不存在对应的连接器类型」。
   *
   * 为什么要这个口子：玩家的真实技法里有相当一部分不经过凸点/底孔/夹口/轴孔，而是把一件的实体
   * 塞进另一件的底部空腔或内壁之间。这类装配此前只有两个下场 —— 被判穿模（实心 AABB，已由
   * partBoxes 的 opt-in hollow 解决几何那一半），或被判「与 mount 指定的父件没有真实物理连接」。
   * 后者是**连接语义**问题，几何修不了，只能在模型层显式声明。
   *
   * 语义（刻意保守）：
   *   · 只在模型显式声明 model.illegalLinks 时生效；不声明时，本段之前的行为逐字节不变。
   *   · 计入**支撑图**（否则会被判悬空），但**不进**连接器邻接 adj（不产生假的凸点匹配，
   *     不会让 partsConnected 认为它们扣上了）。
   *   · 穿模判定不受影响：实体仍然由 partBoxes 负责，hollow 之外照旧判。
   *   · 每条都发 WARNING，让它始终在报告里可见 —— 「能通过」不等于「被当成正常连接」。
   */
  const ILLEGAL_LINK_KINDS = new Set(['cavity-friction', 'illegal-clutch', 'bar-in-hole']);
  const illegalPairs = new Set();
  const illegalPairKey = (a, b) => (String(a) < String(b) ? a + '|' + b : b + '|' + a);
  if (model.illegalLinks !== undefined) {
    if (!Array.isArray(model.illegalLinks)) E('illegal-links', 'illegalLinks 必须是数组');
    else for (const [n, l] of model.illegalLinks.entries()) {
      const tag = l && l.a && l.b ? l.a + '×' + l.b : '#' + n;
      if (!l || typeof l !== 'object') { E('illegal-links', 'illegalLinks 第 ' + n + ' 条不是对象'); continue; }
      if (!l.a || !l.b) { E('illegal-links', tag + '：需要 a 与 b 两个零件 id'); continue; }
      if (l.a === l.b) { E('illegal-links', tag + '：不能把自己连到自己'); continue; }
      if (!byId.has(l.a) || !byId.has(l.b)) { E('illegal-links', tag + '：引用了不存在的零件'); continue; }
      if (!ILLEGAL_LINK_KINDS.has(l.kind)) { E('illegal-links', tag + '：kind 只能是 ' + [...ILLEGAL_LINK_KINDS].join(' / ')); continue; }
      //
      // ⚠ 几何邻近性是**必需**前置，不是可选优化。
      // 独立审查（audit/independent-review-r2-20261031/REVIEW.md 漏洞反例 2）证明：
      // 只校验 id 与 kind 时，一个悬空在 (100,50,100) 的散件只要补一行
      //   illegalLinks: [{ a:'p1', b:'b1', kind:'cavity-friction' }]
      // 就能让 floating 与 mount-disconnected 全部哑火，模型直接 ok:true。
      // 那不是「承认一种非法连接」，而是「把任何坏模型洗白」的通道。
      //
      // 判据：两件的实体包围盒必须在**三个轴上都贴住或相交**（间距 ≤ ILLEGAL_LINK_TOL）。
      // 贴住（间距 0）是非法连接的典型形态：空腔摩擦、侧壁夹持，都不产生标准连接器。
      // 悬空在几十格以外的一对，物理上不可能有任何摩擦/夹持，必须继续报错。
      const ILLEGAL_LINK_TOL = { xz: 0.05, y: 0.05 };
      let boxesA, boxesB;
      try {
        boxesA = partBoxes(byId.get(l.a), cat.parts[byId.get(l.a).part]);
        boxesB = partBoxes(byId.get(l.b), cat.parts[byId.get(l.b).part]);
      } catch {
        E('illegal-links', tag + '：无法计算包围盒（零件定义不完整），不能据此声明非法连接');
        continue;
      }
      if (!boxesA.length || !boxesB.length) {
        E('illegal-links', tag + '：其中一件 occupies:false（无实体盒），声明非法连接没有物理基础');
        continue;
      }
      let near = false, best = Infinity;
      for (const a of boxesA) for (const b of boxesB) {
        const sx2 = Math.max(0, a.x0 - b.x1, b.x0 - a.x1);
        const sy2 = Math.max(0, a.y0 - b.y1, b.y0 - a.y1);
        const sz2 = Math.max(0, a.z0 - b.z1, b.z0 - a.z1);
        const gap = Math.max(sx2, sy2, sz2);
        best = Math.min(best, gap);
        if (sx2 <= ILLEGAL_LINK_TOL.xz && sy2 <= ILLEGAL_LINK_TOL.y && sz2 <= ILLEGAL_LINK_TOL.xz) near = true;
      }
      if (!near) {
        E('illegal-link-not-adjacent', tag + '：两件相距 ' + best.toFixed(2) + ' 格，物理上不可能发生摩擦/夹持 —— 非法连接声明只允许用于**贴住或相交**的一对');
        continue;
      }
      illegalPairs.add(illegalPairKey(l.a, l.b));
      W('illegal-link', tag + '：非法连接（' + l.kind + '）—— 实物可行，但无标准连接器支撑；图纸与 BOM 需人工确认');
    }
  }

  for (const { p, def } of good) if (p.mount) {
    if (!byId.has(p.mount)) E('mount', `${p.id}：mount 指向不存在的零件 ${p.mount}`, [p.id]);
    else if (def.kind === 'door') {
      const parentP = byId.get(p.mount), parentDef = cat.parts[parentP?.part];
      if (doorHingeMatches(p, def, parentP, parentDef)) link(p.id, p.mount);
      else E('mount-disconnected', `${p.id}：门扇与门框 ${p.mount} 未能正确铰接对位（坐标或朝向错位）`, [p.id, p.mount]);
    }
    else if (!adj.get(p.id).has(p.mount) && !illegalPairs.has(illegalPairKey(p.id, p.mount))) E('mount-disconnected', `${p.id}：与 mount 指定的父零件 ${p.mount} 之间没有真实物理连接（凸点未对准底孔或夹口未对准把柄）`, [p.id, p.mount]);
  }
  for (const { p, def } of good) if (def.kind === 'door' && !p.mount) W('door-mount', `${p.id}：门需要用 mount 指明安装在哪个门框上`, [p.id]);

  // —— 子组件刚体挂装（builder.addAssembly 写入的 subassembly / subassemblyAnchor）——
  // 语义：同一 subassembly 组内的零件是一个刚体；组内连接已在 addAssembly 时逐件用 snapPart 语义核对。
  // 校验三件事：
  //   ① 锚点唯一且属于组内；② 锚点真实连到组外（否则整组悬空）；
  //   ③ 组内必须形成连通刚体——除锚点外每件都要通过真实连接（或其自身 snap.on）连到组内其他件。
  // 第 ③ 条是 EN-01 的核心：只声明 subassembly 字段不能产生连接边。历史实现在这里直接把
  // 组员与锚点连起来（supportAdj 加边），把「远处散件声明进子组件」也当成已支撑；现在改为
  // 先算组内真实连通分量，非连通成员逐一报错，并且不为其伪造支撑边。
  const supportAdj = new Map([...adj].map(([id, set]) => [id, new Set(set)]));
  // 非法连接计入**支撑图**（否则会被判「没有连到底座（悬空）」），但不进 adj：
  // 它们不该被当成可扣合的凸点关系，partsConnected 仍然返回 false。
  for (const key of illegalPairs) {
    const [x, y] = key.split('|');
    if (supportAdj.has(x) && supportAdj.has(y)) { supportAdj.get(x).add(y); supportAdj.get(y).add(x); }
  }
  const groups = new Map();
  for (const { p } of good) if (typeof p.subassembly === 'string' && p.subassembly) {
    if (!groups.has(p.subassembly)) groups.set(p.subassembly, []);
    groups.get(p.subassembly).push(p);
  }
  for (const [gid, members] of groups) {
    const ids = members.map((p) => p.id);
    const anchors = [...new Set(members.map((p) => p.subassemblyAnchor).filter(Boolean))];
    if (anchors.length !== 1 || !byId.has(anchors[0]) || !ids.includes(anchors[0])) {
      E('subassembly-anchor', `子组件 ${gid}：subassemblyAnchor 必须唯一且指向组内零件（收到 ${JSON.stringify(anchors)}）`, ids);
      continue;
    }
    const anchor = anchors[0];
    const memberSet = new Set(ids);
    const outside = [...adj.get(anchor)].filter((x) => !memberSet.has(x));
    if (!outside.length) E('subassembly-anchor', `子组件 ${gid} 的锚点零件 ${anchor} 没有连到组外任何零件（整组悬空）`, [anchor]);

    // 组内真实连通性：只用真实连接图 adj（凸点/夹口/销/轮）+ 零件自身的 snap.on（若是组内件）
    const insideAdj = new Map(ids.map((id) => [id, new Set()]));
    for (const id of ids) {
      for (const nb of adj.get(id) || []) if (memberSet.has(nb)) insideAdj.get(id).add(nb);
      const p = byId.get(id);
      // snap.on 组内引用也是一条真实的「由上件定位到此件」的证据（add 时已用 snapPart 校验过扣合）
      if (p?.snap?.on && memberSet.has(p.snap.on)) { insideAdj.get(id).add(p.snap.on); insideAdj.get(p.snap.on).add(id); }
      // mount 指向组内件同理
      if (p?.mount && memberSet.has(p.mount)) { insideAdj.get(id).add(p.mount); insideAdj.get(p.mount).add(id); }
    }
    const seen = new Set([anchor]);
    const q = [anchor];
    while (q.length) {
      const cur = q.pop();
      for (const nb of insideAdj.get(cur) || []) if (!seen.has(nb)) { seen.add(nb); q.push(nb); }
    }
    const detached = ids.filter((id) => !seen.has(id));
    if (detached.length) {
      E('subassembly-disconnected', `子组件 ${gid}：${detached.length} 个零件与其他成员没有真实物理连接，不能作为单一刚体（声明 subassembly 不会产生连接边）：${detached.slice(0, 10).join(', ')}${detached.length > 10 ? ' …' : ''}`, detached);
      // 不为断开成员伪造支撑边；它们若真悬空，会由下面的 floating 检查独立报出
      for (const id of ids) if (seen.has(id) && id !== anchor) { supportAdj.get(anchor).add(id); supportAdj.get(id).add(anchor); }
      continue;
    }
    for (const id of ids) if (id !== anchor) {
      supportAdj.get(anchor).add(id); supportAdj.get(id).add(anchor);
    }
  }
  // 多高度凸点：小数层零件必须真的扣在「非整数高度顶凸点」上，否则退回 at 错误（防手写小数坐标蒙混过关）
  for (const id of looseAt) {
    const entry = good.find(({ p }) => p.id === id);
    if (!entry) continue;
    const mine = connMap.get(id);
    const at = (mine?.studs || []).concat(mine?.receptors || []);
    let ok = false;
    for (const nid of adj.get(id)) {
      const oConn = connMap.get(nid);
      if (!oConn) continue;
      const theirs = (oConn.studs || []).concat(oConn.receptors || []);
      // 合法条件：本件与邻居有一对连接器重合，且该重合点位于「非整数层」（内腔凸点 ly=0.5/1.5、
      // 或人仔颈柱高度 5.5 片等）——也就是说小数层确实是被这个非整数高度的接口顶上来的。
      const hit = at.some((c) => theirs.some((d) =>
        Math.abs(c.pos[0] - d.pos[0]) <= 0.08 && Math.abs(c.pos[1] - d.pos[1]) <= 0.2 && Math.abs(c.pos[2] - d.pos[2]) <= 0.08
        && Math.abs(c.pos[1] * 4 - Math.round(c.pos[1] * 4)) < 1e-6 && Math.abs(c.pos[1] - Math.round(c.pos[1])) > 1e-6));
      if (hit) { ok = true; break; }
    }
    if (!ok) E('at', `${id}：at 必须是 3 个整数 [x, 层, z]（小数层只有扣在非整数高度的内腔凸点上才合法）`, [id]);
  }

  const rawGround = good.length ? Math.min(...good.map(({ p }) => p.at[1])) : 0;
  const rawTop = good.length ? Math.max(...good.map(({ p }) => p.at[1])) : 0;
  // 翻面搭建（flip）最小可行方案：
  //  ① 负层（at[1] < 0）是合法的「底部倒装」——不报 ground 提示；支撑链仍按最底层向上推导，
  //     因此 step 1..3 的倒装件必须最终接到同一支撑链上（validate 的 floating / step-order 照常判定）。
  //  ② 底盘整体翻面作业（模型 y 反转）时，在模型顶层声明 flip: true（或 meta.flip: true）：
  //     支撑基准面改为最上层（施工时朝上的那一面是翻转后的底盘），无需改写任何零件坐标。
  const flip = model.flip === true || model.meta?.flip === true;
  const ground = flip ? rawTop : rawGround;
  if (good.length && !flip && rawGround > 0) W('ground', `最低零件在第 ${rawGround} 层，建议从第 0 层开始`);
  // 支撑链推导：从基准面出发。翻面搭建（flip）时基准面是最上层，逐层「向下」走
  // （从第 n 层能挂到第 n-1 层的零件也算支撑——倒装作业时后放的是更靠上的一层）。
  const reach = (filter, g0 = ground) => {
    const ok = new Set(), q = [];
    for (const { p } of good) if (filter(p) && (p.at[1] === g0 || (g0 < 0 && p.at[1] === 0))) { ok.add(p.id); q.push(p.id); }
    while (q.length) { const a = q.pop(); for (const b of supportAdj.get(a)) if (!ok.has(b) && filter(byId.get(b))) { ok.add(b); q.push(b); } }
    if (!flip) return ok;
    // flip：把「已支撑」集合沿支撑图再扩一圈（上下相邻层都算），直到收敛
    const allIds = new Set(good.filter(({ p }) => filter(p)).map(({ p }) => p.id));
    let grew = true;
    while (grew) {
      grew = false;
      for (const id of allIds) {
        if (ok.has(id)) continue;
        if ([...supportAdj.get(id)].some((n) => ok.has(n))) { ok.add(id); q.push(id); grew = true; }
      }
    }
    return ok;
  };
  const all = reach(() => true);
  const floating = good.filter(({ p }) => !all.has(p.id)).map(({ p }) => p.id);
  if (floating.length) E('floating', `${floating.length} 个零件没有连到底座（悬空）：${floating.slice(0, 12).join(', ')}${floating.length > 12 ? ' …' : ''}`, floating);
  // 步骤顺序：每一步结束时，已放的零件都应连到底座；子组件在装上之前，只需连到它自己的最底层
  const steps = [...new Set(good.map(({ p }) => p.step))].sort((a, b) => a - b);
  const subOf = (p) => plan.partSub.get(p.id), attachAt = (p) => plan.subs.get(subOf(p))?.attachStep ?? -Infinity;
  for (const s of steps) {
    const ok = reach((p) => p.step <= s && (!subOf(p) || attachAt(p) <= s));
    const bad = good.filter(({ p }) => p.step === s && !subOf(p) && all.has(p.id) && !ok.has(p.id)).map(({ p }) => p.id);
    if (bad.length) W('step-order', `第 ${s} 步：${bad.join(', ')} 在这一步还没有支撑（支撑它的零件在后面的步骤）`, bad);
  }
  for (const sub of plan.subs.values()) {
    const mine = good.filter(({ p }) => subOf(p) === sub.id); if (!mine.length) continue;
    const g0 = Math.min(...mine.map(({ p }) => p.at[1]));
    for (const s of [...new Set(mine.map(({ p }) => p.step))].sort((a, b) => a - b)) {
      const ok = reach((p) => subOf(p) === sub.id && p.step <= s, g0);
      const bad = mine.filter(({ p }) => p.step === s && !ok.has(p.id)).map(({ p }) => p.id);
      if (bad.length) W('step-order', `子组件 ${sub.id} 第 ${s} 步：${bad.join(', ')} 没有连到子组件上`, bad);
    }
  }
  // 可开合设计
  const mechIds = new Set();
  for (const m of model.mechanisms || []) {
    const tag = m.id || '(无 id)';
    if (!m.id) E('mech-id', '可开合设计缺少 id');
    else if (mechIds.has(m.id)) E('mech-id', `可开合设计 id 重复：${m.id}`); else mechIds.add(m.id);
    if (!['hinge', 'slide', 'removable'].includes(m.type)) E('mech-type', `${tag}：type 只能是 hinge / slide / removable`);
    const missing = (m.parts || []).filter((id) => !byId.has(id));
    if (!m.parts || !m.parts.length) E('mech-parts', `${tag}：parts 不能为空`);
    if (missing.length) E('mech-parts', `${tag}：引用了不存在的零件 ${missing.join(', ')}`);
    const vec = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number');
    if (m.type === 'hinge' && (!vec(m.pivot) || !vec(m.axis) || !Array.isArray(m.range))) E('mech-hinge', `${tag}：合页需要 pivot、axis、range`);
    if (m.type === 'slide' && (!vec(m.axis) || !Array.isArray(m.range))) E('mech-slide', `${tag}：滑动需要 axis、range`);
    if (m.type === 'removable' && !vec(m.offset)) E('mech-removable', `${tag}：可拆卸需要 offset`);
    if (!m.evidence || !m.evidence.length) W('mech-evidence', `${tag}：没有关联打开状态的照片`);
    // 转轴不能退化成零向量，行程不能倒置（查看器会把零轴静默当成「不动」，让人误以为机构没问题）
    if (m.type === 'hinge' && vec(m.axis) && !m.axis.some((v) => Math.abs(v) > 1e-9)) E('mech-axis', `${tag}：axis 是零向量，转轴方向未定义`, m.parts || []);
    if (['hinge', 'slide'].includes(m.type) && Array.isArray(m.range)) {
      // range 必须是两个有限数字；字符串/NaN 会让查看器算出 NaN 变换（静默不显示），必须当错误
      if (m.range.length !== 2 || !m.range.every((v) => typeof v === 'number' && Number.isFinite(v))) {
        E('mech-range', `${tag}：range 必须是 2 个数字（当前 ${JSON.stringify(m.range)}）`, m.parts || []);
      } else if (!(m.range[1] > m.range[0])) {
        E('mech-range', `${tag}：range 必须满足 range[1] > range[0]（当前 ${JSON.stringify(m.range)}）`, m.parts || []);
      }
    }
  }
  // —— 机关几何核对：转轴必须落在真实铰接上，行程内不得撞进静件 ——
  const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
  if ((model.mechanisms || []).length) {
    const defOf = (p) => cat.parts[p.part];
    const connOf = (id) => connMap.get(id);
    for (const m of model.mechanisms || []) {
      const tag = m.id || '(无 id)';
      const mine = (m.parts || []).filter((id) => byId.has(id) && boxesMap.has(id));
      if (!mine.length) continue;
      const movingSet = new Set(mine);
      const movingParts = mine.map((id) => byId.get(id));
      const fixedParts = good.filter(({ p }) => !movingSet.has(p.id)).map(({ p }) => p);

      if (m.type === 'hinge' && vec3(m.pivot) && vec3(m.axis) && m.axis.some((v) => Math.abs(v) > 1e-9)) {
        // ① 声明的转轴必须与某个真实铰接轴线重合（否则查看器只是在绕空气旋转）
        const cands = mechCandidates(movingParts, fixedParts, defOf, connOf);
        const scored = cands.map((c) => ({ c, e: matchMechAxis(m.pivot, m.axis, c) }));
        const matched = scored.filter(({ e }) => e.parallel && e.dist <= MECH_AXIS_TOL);
        if (!matched.length) {
          const near = scored.slice().sort((x, y) => x.e.dist - y.e.dist)[0];
          const hint = near
            ? `最接近的真实铰接在 ${near.c.moving}↔${near.c.fixed || '(目录基座)'}（${near.c.source === 'connector' ? near.c.kinds : 'catalog hinge'}，轴 ${near.c.axis}），偏离 ${near.e.dist.toFixed(2)} 格${near.e.parallel ? '' : '且轴向不平行'}`
            : '这些零件之间没有任何真实铰接连接器（bar↔clip / pin↔hole / pin↔axle）';
          E('mech-axis', `${tag}：转轴没有落在真实铰接上——${hint}`, m.parts || []);
        }
        // ② 运动件必须是刚体：组内应连通，且只通过铰接轴与箱体相连
        if (movingParts.length > 1) {
          const inner = new Set();
          const q = [movingParts[0].id]; inner.add(movingParts[0].id);
          while (q.length) {
            const cur = q.pop();
            for (const n of adj.get(cur) || []) if (movingSet.has(n) && !inner.has(n)) { inner.add(n); q.push(n); }
          }
          const loose = movingParts.filter((p) => !inner.has(p.id)).map((p) => p.id);
          if (loose.length) {
            W('mech-rigid', `${tag}：运动零件不是一个整体——${loose.join(', ')} 与主体不连通，却会被同一转轴一起带着转`, m.parts || []);
          }
        }
      }

      // ③ 行程扫掠：动件不得撞进静件。
      //
      //     豁免范围必须严格限定在**铰接轴本身**：合页的两半在运动中本来就一直互相扣住，
      //     那对零件的重叠是结构的一部分。旧实现把「任何 partsConnected 的零件对」都豁免，
      //     范围过宽——动件与箱体之间若另有别的连接（例如翼板同时扣在装甲上），
      //     那处真实碰撞会被一并放过。这里只豁免「连接器落在转轴上的那一对」。
      const movingItems = movingParts.map((p) => ({ id: p.id, boxes: boxesMap.get(p.id) || [] }))
        .filter((it) => it.boxes.length);
      const staticItems = fixedParts.map((p) => ({ id: p.id, boxes: boxesMap.get(p.id) || [] }))
        .filter((it) => it.boxes.length);
      // 轴上一对：该零件对之间存在**真实扣合**的轴类接口，且该接口位于声明转轴上。
      //
      //     必须复用 connectorPairMatches（与 partsConnected 同一套判据）：类型要配对
      //     （bar↔clip / pin↔hole / pin↔axle），轴要同向，位置容差 0.08 格 / 0.20 片。
      //     不能用「双方都属于轴类 + 距离宽松」近似——那会把没真正扣上的零件对也放进豁免，
      //     于是那里发生的真实碰撞被整个放过。
      const axlePairs = new Set();
      if (m.type === 'hinge' && vec3(m.pivot) && vec3(m.axis)) {
        const u = m.axis.map((v) => v / Math.hypot(...m.axis));
        const axisParallel = (axName) => {
          const av = AXIS_VEC[axName];
          return av ? Math.abs(Math.abs(u[0] * av[0] + u[1] * av[1] + u[2] * av[2]) - 1) < 1e-3 : false;
        };
        // 公头可能在动件侧，也可能在静件侧（bar 在静件、clip 在动件是常见组合），两个方向都要看
        const consider = (s, r, movingId, fixedId) => {
          if (!connectorPairMatches(s, r)) return;          // 复用真实配对规则
          const ax = s.axis || r.axis;
          if (!ax || (s.axis && r.axis && s.axis !== r.axis)) return;   // 轴须同向
          if (!axisParallel(ax)) return;                     // 且与声明转轴平行
          const e = matchMechAxis(m.pivot, m.axis, { pivot: s.pos, axis: ax });
          if (e.parallel && e.dist <= MECH_AXIS_TOL) axlePairs.add(`${movingId}|${fixedId}`);
        };
        for (const a of movingParts) {
          const ca = connOf(a.id);
          if (!ca) continue;
          for (const b of fixedParts) {
            const cb = connOf(b.id);
            if (!cb) continue;
            for (const s of ca.studs) for (const r of cb.receptors) consider(s, r, a.id, b.id);
            for (const s of cb.studs) for (const r of ca.receptors) consider(s, r, a.id, b.id);
          }
        }
      }
      const isAxlePair = (a, b) => axlePairs.has(`${a}|${b}`) || axlePairs.has(`${b}|${a}`);
      // 【2026-11-01 回滚】这里曾加过「门 ↔ 它自己的门框」的扫掠豁免，
      // 用来让 60623 在开门扫掠时限不被自己的框判碰撞。
      // 但第三次独立审查指出：那条豁免的前提是「门能装进框」，而实现方式是**把门框内壁
      // 从真实的 3.40 格改宽到 3.55 格** —— 那是为了通过而伪造装配关系。
      // 因此门/框目录改动与这条豁免一起回滚；60623 恢复 occupies:false（碰撞透明），
      // 缺陷如实登记在 catalog/parts.json 的 note 与 out/r2-lead-20261031/C2-60623-door-frame-defect.md。
      // 根治需要 OBB 扫掠或按特征拆盒（门板/轴销分开），未做。
      if (movingItems.length && staticItems.length) {
        const hits = sweepCollision(m, movingItems, staticItems, isAxlePair);
        if (hits.length) {
          const worst = hits.reduce((acc, h) => { const k = `${h.a}×${h.b}`; (acc[k] = acc[k] || []).push(h.deg); return acc; }, {});
          const list = Object.entries(worst).slice(0, 4).map(([k, degs]) => `${k}（${degs.length} 个角度，含 ${degs.slice(0, 3).join('°、')}°）`);
          E('mech-clearance', `${tag}：可用行程内发生碰撞——${list.join('；')}${Object.keys(worst).length > 4 ? ` 等 ${Object.keys(worst).length} 对` : ''}`, m.parts || []);
        }
      }
    }
  }
  // 证据与置信度
  const inferred = good.filter(({ p }) => p.status === 'inferred').map(({ p }) => p.id);
  const uncertain = good.filter(({ p }) => p.status === 'uncertain').map(({ p }) => p.id);
  if (inferred.length) info.push({ code: 'inferred', msg: `${inferred.length} 个零件是推断的（照片里看不到）`, parts: inferred });
  if (uncertain.length) info.push({ code: 'uncertain', msg: `${uncertain.length} 个零件存疑，需要人工确认`, parts: uncertain });
  if (opts.photos) {
    const ids = new Set((opts.photos.photos || []).map((ph) => ph.id));
    const bad = [];
    for (const { p } of good) for (const e of p.evidence || []) if (!ids.has(e)) bad.push(`${p.id}→${e}`);
    for (const m of model.mechanisms || []) for (const e of m.evidence || []) if (!ids.has(e)) bad.push(`${m.id}→${e}`);
    if (bad.length) W('evidence', `${bad.length} 处证据照片在照片清单里找不到：${bad.slice(0, 8).join(', ')}`);
  }
  // 连通分量统计与反地摊门禁（submodel / strictAssembly）
  const compVisited = new Set();
  const components = [];
  for (const { p } of good) {
    if (compVisited.has(p.id)) continue;
    const comp = [], q = [p.id];
    compVisited.add(p.id);
    while (q.length) {
      const cur = q.pop();
      comp.push(cur);
      for (const nxt of supportAdj.get(cur) || []) {
        if (!compVisited.has(nxt)) { compVisited.add(nxt); q.push(nxt); }
      }
    }
    components.push(comp);
  }
  components.sort((a, b) => b.length - a.length);
  const largestComp = components[0] || [];
  const largestRatio = good.length ? r6(largestComp.length / good.length) : 1;

  const isSubmodelMode = opts.submodel === true || model.meta?.submodel === true;
  if (isSubmodelMode && good.length > 1 && components.length > 1) {
    const detached = components.slice(1).flat();
    E('submodel-disconnected', `子模型必须 100% 物理扣合成单一连通刚体，当前存在 ${components.length} 个分离连通块（分离零件：${detached.slice(0, 10).join(', ')}）`, detached);
  }

  const isStrictAssembly = opts.strictAssembly === true || model.meta?.strictAssembly === true;
  if (isStrictAssembly && good.length > 1) {
    const mainCompSet = new Set(largestComp);
    const isAccessoryPart = (p, def) =>
      p.accessory === true || partModule(p) === 'accessories' || partModule(p) === 'minifig' || Boolean(def?.minifig);
    const scatteredBody = good
      .filter(({ p, def }) => !mainCompSet.has(p.id) && !isAccessoryPart(p, def))
      .map(({ p }) => p.id);
    const minRatio = opts.minComponentRatio ?? 0.80;
    if (scatteredBody.length > 0 || largestRatio < minRatio) {
      const targetParts = scatteredBody.length ? scatteredBody : components.slice(1).flat();
      E(
        'scattered-parts-tray',
        `主干最大连通分量占比仅 ${(largestRatio * 100).toFixed(1)}%（共 ${components.length} 个连通块），发现 ${targetParts.length} 个未装上主体的散落零件（严禁摆地摊充数）：${targetParts.slice(0, 12).join(', ')}${targetParts.length > 12 ? ' …' : ''}`,
        targetParts
      );
    }
  }

  const stats = {
    parts: good.length, steps: plan.steps.length, modules: mods.size, subassemblies: plan.subs.size, mechanisms: (model.mechanisms || []).length,
    confirmed: good.length - inferred.length - uncertain.length, inferred: inferred.length, uncertain: uncertain.length,
    connectedComponents: components.length, largestComponentRatio: largestRatio,
  };
  return { ok: errors.length === 0, errors, warnings, info, stats };
}

// ---------------------------------------------------------------- 零件清单
export function bom(model, cat, filter = () => true) {
  const m = new Map();
  for (const p of model.parts || []) {
    if (!filter(p)) continue;
    const k = `${p.part}|${p.color}`;
    const e = m.get(k) || { part: p.part, color: p.color, qty: 0, def: cat.parts[p.part], col: cat.colors?.[String(p.color)] };
    e.qty++; m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.qty - a.qty || String(a.part).localeCompare(String(b.part)));
}

// ---------------------------------------------------------------- LDraw 导出
const fmt = (v) => { const n = Math.round(v * 1000) / 1000; return Object.is(n, -0) ? '0' : String(n); };
export function ldrawLine(p, def) {
  const rot = p.rot || 0, c = partCenter(p, def), o = def.ldrawOrigin || [0, def.h, 0];
  const [ox, oz] = rotXZ(o[0], o[2], rot);
  const gx = c[0] + ox, gy = c[1] + o[1], gz = c[2] + oz;
  const t = (rot * Math.PI) / 180, co = Math.round(Math.cos(t)), s = Math.round(Math.sin(t));
  const M = [co, 0, -s, 0, 1, 0, s, 0, co];             // 本格式 → LDraw：绕 X 轴转 180°（y 朝下、z 朝后）
  return `1 ${p.color} ${fmt(gx * 20)} ${fmt(-gy * 8)} ${fmt(-gz * 20)} ${M.map(fmt).join(' ')} ${p.part}.dat`;
}
/** 有子组件时导出 MPD（主模型 + 每个子组件一个子文件），LPub3D / Studio 可直接按子组件生成说明书 */
export const ldrawExt = (model) => (stepPlan(model).subs.size ? '.mpd' : '.ldr');
const subFile = (id) => `${String(id).replace(/[^\w.-]+/g, '_')}.ldr`;
/** 子组件子文件坐标系 → 主模型：以锚点零件的世界原点（零件底面中心）作为子文件原点，
 *  子文件内所有零件坐标减去锚点原点。挂装行 = 单位旋转 + 锚点平移（--rot 变换已在零件摆放坐标里体现）。 */
function subOrigin(model, cat) {
  const parts = (model.parts || []).filter((p) => p && cat.parts[p.part]);
  const byId = new Map(parts.map((p) => [p.id, p]));
  const mods = moduleMap(model);
  const out = new Map();
  const groups = new Map();
  for (const p of parts) if (typeof p.subassembly === 'string' && p.subassembly) {
    if (!groups.has(p.subassembly)) groups.set(p.subassembly, []);
    groups.get(p.subassembly).push(p);
  }
  for (const [gid, members] of groups) {
    const anchorId = members.find((p) => p.id === p.subassemblyAnchor)?.id || members[0].id;
    const anchor = byId.get(anchorId);
    if (!anchor) continue;
    const entry = { anchor: anchorId, origin: partCenter(anchor, cat.parts[anchor.part]) };
    out.set(gid, entry);
    // MPD 按「子组件模块」分文件（module 指向 subassembly:true 的模块），因此同一原点也要按模块 id 登记
    for (const m of members) {
      const mid = partModule(m);
      if (mid && mods.get(mid)?.subassembly) out.set(mid, entry);
    }
  }
  return out;
}
export function toLDraw(model, cat) {
  const name = (model.meta?.name || 'model').replace(/[\r\n]/g, ' '), plan = stepPlan(model);
  const byId = new Map((model.parts || []).map((p) => [p.id, p]));
  // 子组件（builder.addAssembly 的刚体组）需要按组内坐标局部化：子文件里的零件相对锚点原点书写，
  // 主文件用「锚点原点平移」把整组挂回去。普通模块子组件（无 subassembly 标记）保持原路径（原点一致）。
  const rig = subOrigin(model, cat);
  // 子组件子文件坐标系：以锚点零件的 LDraw 位置为原点。LDraw 变换是「旋转 + 平移」，
  // 因此把主模型里算好的零件行整体减去锚点的平移分量（前 3 个数字）即可——对任意 rot/up 都精确，
  // 不需要在引擎坐标里做位移换算。挂装行 = 同一平移（旋转为单位阵）。
  const ldrawPos = (line) => line.split(/\s+/).slice(2, 5).map(Number);
  const subOffset = (gid) => {
    const r = rig.get(gid);
    if (!r) return [0, 0, 0];
    const anchor = byId.get(r.anchor);
    const adef = anchor && cat.parts[anchor.part];
    return anchor && adef ? ldrawPos(ldrawLine(anchor, adef)) : [0, 0, 0];
  };
  const shiftLine = (line, off) => {
    const t = line.split(/\s+/);
    for (let i = 0; i < 3; i++) t[2 + i] = fmt(Number(t[2 + i]) - off[i]);
    return t.join(' ');
  };
  const partLine = (p, def, off) => {
    const line = ldrawLine(p, def);
    return off ? shiftLine(line, off) : line;
  };
  const head = (title, file) => [`0 ${title}`, `0 Name: ${file}`, `0 Author: ${model.meta?.author || 'brickkit'}`, `0 // 由 brickkit 从 brickbuild ${model.version || VERSION} 导出`];
  const body = (steps, origin = null) => {
    const lines = [];
    steps.forEach((st, i) => {
      if (st.title) lines.push(`0 // 第 ${st.n} 步：${st.title}`);
      for (const id of st.parts) {
        const p = byId.get(id), def = cat.parts[p.part];
        if (!def) { lines.push(`0 // 跳过未知零件 ${p.part}`); continue; }
        lines.push(partLine(p, def, origin));
      }
      if (st.attach) {
        // 子组件挂装：子文件以锚点 LDraw 位置为原点 → 挂装行就是该平移（单位旋转）。
        // 普通模块子组件（无 subassembly 刚体组）偏移为 0，保持原路径。
        const off = subOffset(st.attach);
        lines.push(`1 16 ${off.map(fmt).join(' ')} 1 0 0 0 1 0 0 0 1 ${subFile(st.attach)}`);
      }
      if (i < steps.length - 1) lines.push('0 STEP');
    });
    return lines;
  };
  const mech = (model.mechanisms || []).map((m) => `0 // 可开合：${m.id} (${m.type}) ${m.label || ''} 零件 ${(m.parts || []).join(',')}`);
  const main = plan.steps.filter((s) => !s.sub && !s.parts.some((id) => plan.partSub.has(id)) || s.attach);
  if (!plan.subs.size) return [...head(name, `${name}.ldr`), ...body(plan.steps), ...mech].join('\n') + '\n';
  const out = ['0 FILE main.ldr', ...head(name, 'main.ldr'), ...body(main), ...mech, '0 NOFILE'];
  for (const sub of plan.subs.values()) {
    const steps = plan.steps.filter((s) => s.sub === sub.id || (!s.sub && s.parts.length && s.parts.every((id) => plan.partSub.get(id) === sub.id)));
    const off = subOffset(sub.id);
    out.push(`0 FILE ${subFile(sub.id)}`, ...head(`子组件 · ${sub.label}`, subFile(sub.id)), ...body(steps, off), '0 NOFILE');
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- 照片完整性检查
const angDist = (a, b) => { const d = Math.abs((((a - b) % 360) + 360) % 360); return Math.min(d, 360 - d); };
export const PHOTO_SLOTS = [
  ...[0, 45, 90, 135, 180, 225, 270, 315].map((az) => ({ id: `orbit-${az}`, group: '基础外观 · 斜上方一圈', az, el: [15, 50], hint: `方位 ${az}°、俯角约 30°` })),
  ...[0, 90, 180, 270].map((az) => ({ id: `flat-${az}`, group: '基础外观 · 平视', az, el: [-10, 15], hint: `方位 ${az}°、相机与模型同高` })),
  { id: 'top', group: '基础外观 · 顶视', el: [70, 90], hint: '正上方往下拍' },
  { id: 'bottom', group: '基础外观 · 底视', kind: 'bottom', hint: '翻过来拍底面；不能翻就在 skipped 里说明原因' },
];
export function checkPhotos(set, model) {
  const photos = (set && set.photos) || [], missing = [], warnings = [], have = [];
  const skipped = new Map(((set && set.skipped) || []).map((s) => [s.slot, s.reason]));
  const ext = photos.filter((p) => (p.kind === 'exterior' || p.kind === 'bottom') && (!p.state || p.state === 'closed'));
  for (const slot of PHOTO_SLOTS) {
    const hit = slot.kind === 'bottom'
      ? ext.find((p) => p.kind === 'bottom' || (p.elevation ?? 0) <= -60)
      : ext.find((p) => p.kind === 'exterior' && typeof p.elevation === 'number' && p.elevation >= slot.el[0] && p.elevation <= slot.el[1] && (slot.az === undefined || angDist(p.azimuth ?? 999, slot.az) <= 20));
    if (hit) have.push({ slot: slot.id, photo: hit.id });
    else if (skipped.has(slot.id)) have.push({ slot: slot.id, skipped: skipped.get(slot.id) });
    else missing.push({ slot: slot.id, group: slot.group, hint: slot.hint });
  }
  const mechs = new Map();
  for (const m of (set && set.mechanisms) || []) mechs.set(m.id, m);
  for (const m of (model && model.mechanisms) || []) if (!mechs.has(m.id)) mechs.set(m.id, m);
  for (const m of mechs.values()) {
    const mp = photos.filter((p) => p.mechanism === m.id);
    const open = mp.filter((p) => p.state === 'open');
    const az = new Set(open.map((p) => Math.round((p.azimuth ?? -1) / 45)));
    const label = m.label || m.id;
    if (open.length < 2 || az.size < 2) missing.push({ slot: `mech-${m.id}-open`, group: `可开合 · ${label}`, hint: '完全打开状态，至少 2 个不同角度' });
    if (!mp.some((p) => p.kind === 'interior')) missing.push({ slot: `mech-${m.id}-interior`, group: `可开合 · ${label}`, hint: '打开后露出的内部，至少 1 张' });
    if (m.type === 'removable' && mp.filter((p) => p.kind === 'module').length < 2) missing.push({ slot: `mech-${m.id}-module`, group: `可开合 · ${label}`, hint: '取下的部件单独拍顶面和底面各 1 张' });
    if (m.type === 'hinge' || m.type === 'slide') if (!mp.some((p) => p.state === 'half')) warnings.push({ code: 'mech-half', msg: `${label}：建议补一张半开状态，方便判断转轴/滑轨位置` });
  }
  const ids = new Set();
  for (const p of photos) {
    if (!p.id) warnings.push({ code: 'photo-id', msg: `有照片缺少 id（${p.file || '未知文件'}）` });
    else if (ids.has(p.id)) warnings.push({ code: 'photo-dup', msg: `照片 id 重复：${p.id}` }); else ids.add(p.id);
    if (p.width && p.height && Math.max(p.width, p.height) < 3000) warnings.push({ code: 'resolution', msg: `${p.id}：长边 ${Math.max(p.width, p.height)}px，低于 3000px` });
  }
  if (!photos.some((p) => p.kind === 'detail')) warnings.push({ code: 'detail', msg: '没有细节特写；小零件、侧面拼装处建议补拍' });
  if (!(set && set.capture && set.capture.reference)) warnings.push({ code: 'reference', msg: 'capture.reference 未填写：建议垫 8mm 方格纸或乐高底板作为尺寸参照' });
  // 审计回归（docs/审计-5c1c2b9.md P1）：cli check-photos 打了 _missingFile 标记的照片说明文件不存在，
  // 机位覆盖再全也不能算 complete；同一张 file 被标成两个方位角差 >100° 的机位视为照片冲突。
  const missingFiles = photos.filter((p) => p._missingFile).map((p) => p.id);
  const byFile = new Map();
  for (const p of photos) if (p.file) { if (!byFile.has(p.file)) byFile.set(p.file, []); byFile.get(p.file).push(p); }
  for (const [file, group] of byFile) for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
    const a = group[i], b = group[j];
    if (typeof a.azimuth !== 'number' || typeof b.azimuth !== 'number') continue;
    const d = angDist(a.azimuth, b.azimuth);
    if (d > 100) warnings.push({ code: 'photo-conflict', msg: `${a.id} 与 ${b.id} 使用同一文件 ${file}，但方位角 ${a.azimuth}° 与 ${b.azimuth}° 相差 ${d}°，疑似同一张照片被标成两个机位` });
  }
  return { complete: missing.length === 0 && missingFiles.length === 0, total: photos.length, have, missing, warnings, missingFiles };
}
