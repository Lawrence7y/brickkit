// 从 catalog/ldraw-full（LDraw 官方全量镜像）自动生成扩充零件目录 catalog/parts-ldraw.json。
// 每个零件提取网格语义与连接语义：
//   几何：占地 size[格]、高度 h[片]（按砖体基准归一，剔除官方 bbox 顶部 ±4 LDU 凸沿）、顶凸点布局、
//         主体/外挑分离（销/把手/夹/横向凸点/轮销/轴端等外挑不计入占地，另行表达为连接字段）；
//   多高度凸点（2026-10）：每个顶凸点记录真实本地高度 ly（片，零件底面起算），不再只保留顶面 1 片内凸点；
//         studCells 条目第三位携带 ly（缺省 = h，即顶面）。底盘座舱槽（28324）、双阶斜坡（22889）、
//         轮拱（50745）等凹形件的内腔凸点由此可用。旧条目无第三位 → 引擎按顶面处理（向后兼容）。
//   分解包围盒（2026-10）：凹形件（底盘/轮拱/双阶斜坡/座舱类）按官方 .dat 逐格顶/底表面高度做简化分解，
//         输出 boxes 多盒（[x0,x1,y0,y1,z0,z1] 本地坐标，y 单位片）；中间空腔留空，内饰件才能放进去。
//         无法自动判定时标 needsManualBoxes:true 并保持单盒（不猜）。
//   连接（P1 自动提取，官方 .dat 图元白名单）：销孔 holes、轴孔 axleHoles、侧凸点 sideStuds、
//         把手/杆 bars、夹 clips、销 pins、轮销 wheelPins、实测底孔 antistudCells（替代默认满格底孔，杜绝虚假受体）；
//         底孔三类处置（2026-10 回修）：.dat 反孔图元实测（含 stud3a/stud4a 簇图元按覆盖格展开）→
//         antistudCells + antistudSource:'measured'；.dat 未建模但物理存在的砖族安装本体（3937/6078/65146 类）
//         → antistudSource:'assumed'（引擎默认满格）；.dat 明确无底腔（销杆/科技件/握持件）→ 空数组禁用；
//   轮/胎与人仔（2026-10）：轮毂 wheel{role:'rim'} / 轮胎 wheel{role:'tyre'}（外径/内孔实测，格为单位，轴向 = 最薄轴）；
//         人仔 minifig{pegs,sockets}（腿↔胯↔躯干↔头↔帽的标准插接）；轮销 wheelPins 用于 pin↔axleHole 配对；
//   支架（P0-b）：kind=bracket 条目从官方 .dat 实测补 vH/dir/sideRows（精选目录同款 schema）。
// 无法自动判定的条目标 needsManual:true（不猜）。默认仅入库基础素模（过滤印刷图案/贴花/组合衍生件），
// 但 BOM 需求白名单内的件号按缺口放行（仅绕过分类过滤，提取流水线照常）。
// 用法：node tools/gen-parts-catalog.mjs [--dir catalog/ldraw-full] [-o catalog/parts-ldraw.json] [--include-patterned]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  bboxFromText, isPatternedOrDerivative, refCandidates, safeJoin,
  connectorInstancesFromText, STUD_PRIMITIVES,
  PIN_HOLE_PRIMITIVES, AXLE_HOLE_PRIMITIVES, PIN_PRIMITIVES, BAR_PRIMITIVES, CLIP_PRIMITIVES, ANTISTUD_PRIMITIVES,
  WPIN_PRIMITIVES, AXLE_END_PRIMITIVES, PROTRUSION_PRIMITIVES,
  radialProfile, heightMapColumns, decomposeHeightMap, decomposeHeightMapChecked,
  trianglesFromText, instanceWorldBox,
} from '../src/ldraw/ldraw.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.resolve(ROOT, process.argv.includes('--dir') ? process.argv[process.argv.indexOf('--dir') + 1] : 'catalog/ldraw-full');
const OUT = path.resolve(ROOT, process.argv.includes('-o') ? process.argv[process.argv.indexOf('-o') + 1] : 'catalog/parts-ldraw.json');
const INCLUDE_PATTERNED = process.argv.includes('--include-patterned');

// —— BOM 需求白名单（T2 目录补库 2026-10）：按 examples/60239.bom.json 的 catalog:false 缺口放行，
//    不做全量放开。放行仅绕过 obsolete / 印刷 / minifig 三类分类过滤（这些件号多为人仔类或
//    Physical_Colour shortcut，几何本身有效）；几何提取、连接语义、底孔三分法（measured/assumed/禁用）
//    等流水线照常执行，条目与自动提取件同 schema。
const BOM_NEED_WHITELIST = new Set([
  '73081',  // 60239 缺口：方向盘底座 CONSOLE W/ST WHEEL（LDraw 73081 为 Physical_Colour shortcut 且标 Obsolete，几何有效）
  '76382',  // 60239 缺口：人仔躯干 MINI UPPER PART NO. 3627（LDraw: Minifig Torso with Arms and Hands）
  '11303',  // 60239 缺口：人仔帽（Brickset 名 FIGUR HEAD CLOTHING NO 6；LDraw: Minifig Cap with Short Arched Peak with Seams and Top Pin Hole）
  '73200',  // 60239 缺口：人仔腿部 MINI LOWER PART（LDraw: Minifig Hips and Legs (Complete)，Physical_Colour shortcut 标 Obsolete，几何有效）
  '3626b',  // 非 BOM 缺口件号：21023（印刷人仔头 'NO. 1663'，官方库无此件号）的素头替代载体——合并目录内无素头，
            // 替代必须形态近似（印刷头→素头），故放行官方素模 3626b（Minifig Head with Blocked Hollow Stud）
]);

// —— 人仔标准接口（LEGO 人仔系统：腿/胯 ↔ 躯干 ↔ 头 ↔ 帽）——
// 数值来自官方 .dat 实测 + 人仔标准件尺寸（1 格 = 20 LDU、1 片 = 8 LDU）；ly 单位为片，从零件底起算。
//   73200 胯/腿：顶面两枚 hipstud（官方 3815s01 实测 x=±10 LDU，基面 y=0，零件底 y=40）→ 插柱 ly=5。
//   76382 躯干（= 973 + 手臂）：底面两个胯孔（人仔标准：正对胯部插柱，lx=±0.5、ly=0）；
//                              颈部插柱在正中，高度取官方 973 躯干主体 44 LDU = 5.5 片。
//   3626b 头：底部颈孔（正中、ly=0），顶面本身有标准凸点（普通 top 凸点，帽的底孔扣在上面）。
//   11303 帽：底部 stud4a 反凸点实测（官方 y=-4，帽体底 7.952 LDU）→ 帽孔 ly=1.5。
// 插柱 = kind minifig role peg（studs 侧），插孔 = role socket（receptors 侧）；partsConnected 按 peg↔socket 配对。
// 网格对齐说明：人仔件尺寸的奇偶（胯 2×1 / 躯干 3×2 / 头 1×1 / 帽 2×2）导致「几何中心对齐」在
// 引擎的整数格上无法同时成立，因此接口按「扣合后 at 必须仍是整数格」反推，等价于把各件的接口放在
// 自身格子中心所在的那条格线上（与 snapPart 的 at = 插孔世界位 - 凸点世界位 一致）。
// 数值口径：坐标 = 引擎本地格坐标（相对零件占地中心），ly 单位「片」（从零件底面起算）。
// 装配位必须让扣合后 at 仍为整数格，因此接口按各件自身奇偶宽度的实际格线放置（见下方各条注释）。
const MINIFIG_STANDARD = {
  // 胯/腿 2×1：两枚插柱在顶部两格中心（官方 3815s01 hipstud 实测 x=±10 LDU）。ly 取条目高度 h，
  //   保证躯干底（ly=0 的胯孔）正好落在胯顶——两件都按各自 h 归一，链上是整数层。
  '73200': { pegs: [[-0.5, 6, 0], [0.5, 6, 0]] },
  // 躯干 3×2（含双臂）：底部两个胯孔朝下（ly=0），lx=-1/0 使扣合后 at 为整数格（3 宽件的中心在半格上，
  //   胯 2 宽只能偏半格挂——与实物一致，躯干底部胯接面本就 2 格宽）。颈柱在躯干顶（ly=h=6），
  //   lz=+0.5 是把 1×1 头的中心对准 2 深躯干中心的建模约定（否则头的 at 会落到半格）。
  '76382': { sockets: [[-1, 0, -0.5], [0, 0, -0.5]], pegs: [[0, 6, 0.5]] },
  // 头 1×1：底部颈孔在正中（ly=0）；顶面本身有标准凸点（帽子直接扣在凸点上）
  '3626b': { sockets: [[0, 0, 0]] },
  // 帽 2×2：底孔（官方 stud4a 实测在帽体下 1.5 片，扣合面取帽底 ly=0）对准头的顶凸点；
  //   2×2 中心在整格边界，取 lx=lz=-0.5 使 cap.at 与 head.at 重合（凸点正好在 2×2 的格角交界处）。
  '11303': { sockets: [[-0.5, 0, -0.5]] },
};
const isTorsoDesc = (d) => /^minifig torso\b/i.test(d);
const isHeadDesc = (d) => /^minifig head\b/i.test(d) && !/headwear|helmet|hair\b/i.test(d);
const isWheelRim = (d) => /^wheel\s+(rim|wheel)\b/i.test(d) && !/^wheel\s+(fork|holder)/i.test(d);
const isTyre = (d) => /^(tyre|tire)\b/i.test(d);

const cache = new Map();
const readLib = (raw) => {
  const key = String(raw).toLowerCase();
  if (cache.has(key)) return cache.get(key);
  let t = null;
  for (const lp of refCandidates(key)) { const f = safeJoin(DIR, lp); if (f && fs.existsSync(f)) { t = fs.readFileSync(f, 'utf8'); break; } }
  cache.set(key, t);
  return t;
};

// LDraw !CATEGORY → brickbuild 12 大类
const CAT_MAP = {
  Brick: 'brick', Plate: 'plate', Slope: 'slope', Round: 'round', Tile: 'tile', Technic: 'technic',
  Bracket: 'bracket', Bar: 'hinge', 'Hose and Barbell': 'hinge', Hinge: 'hinge',
  Door: 'building', 'Door and Window': 'building', Window: 'building', 'Container': 'building',
  'Fence': 'building', 'Panel': 'building', Glass: 'building', Windscreen: 'building',
  Wedge: 'wedge', 'Wedge Plate': 'wedge', Arch: 'cslope', 'Curved Slope': 'cslope',
  Cone: 'round', Dish: 'round', Cylinder: 'round',
  Flag: 'other', Minifig: 'minifig', 'Minifig Accessory': 'minifig', 'Minifig Headwear': 'minifig',
  'Minifig Hipwear': 'minifig', 'Minifig Neckwear': 'minifig', 'Figure': 'minifig', 'Figure Accessory': 'minifig',
  Animal: 'other', 'Vehicle': 'other', Wheel: 'other', Tyre: 'other',
};
const mapCat = (c, name = '') => {
  if (c && CAT_MAP[c]) return CAT_MAP[c];
  const n = name.toLowerCase();
  if (/^(minifig|figure)\b/.test(n)) return 'minifig';
  if (/^brick\b/.test(n)) return 'brick';
  if (/^plate\b/.test(n)) return 'plate';
  if (/^tile\b|^roadsign\b/.test(n)) return 'tile';
  if (/^slope\b|^cheese\b/.test(n)) return 'slope';
  if (/^curved\b|^arch\b/.test(n)) return 'cslope';
  if (/^(brick|plate|tile) round|^round|^cone|^dish|^cylinder|^dome|^sphere|^hemisphere/.test(n)) return 'round';
  if (/^bracket\b/.test(n)) return 'bracket';
  if (/^bar\b|^hose\b|^clip\b|^handle\b|^hinge\b|^arm\b|^turntable\b/.test(n)) return 'hinge';
  if (/^wedge\b/.test(n)) return 'wedge';
  if (/^(door|window|fence|panel|garage|container|glass|windscreen|roof|wall| shutter|gate)\b/.test(n)) return 'building';
  if (/^technic\b|^axle\b|^pin\b|^gear\b|^connector\b/.test(n)) return 'technic';
  return 'other';
};

// 分解盒覆盖率下限：双向射线只在每格中心采样，弯曲壳体（轮拱 50745 / 方向盘台 73081）
// 会整格采空 → 分解盒只剩被采到的极少量格（实测 50745 覆盖率 0.03、73081 0.05），
// 其余材料在碰撞判定里人间蒸发，这比封住内腔危险得多。低于下限一律退回单实心盒。
// 阈值取 0.7：底盘座舱 28324（0.76）、双阶斜坡 22889（0.78）、阶梯砖 18892（0.81）、
// 人仔躯干 76382（0.82）都保留分解（这些是内腔件能装进去的前提，也是本轮引擎修复的核心），
// 而真正的"采空"件（<0.65）全部回退。（wheel 件不参与 AABB 判定，回退无副作用。）
const BOX_COVERAGE_MIN = 0.7;
const r2 = (v) => Math.round(v * 100) / 100 || 0;

const files = fs.readdirSync(path.join(DIR, 'parts')).filter((f) => f.endsWith('.dat') && !f.startsWith('~') && fs.statSync(path.join(DIR, 'parts', f)).isFile());
console.error(`扫描 ${files.length} 个主零件 …`);

const parts = {};
const skip = { moved: 0, sticker: 0, obsolete: 0, nonSystem: 0, patterned: 0, minifig: 0, flatSheet: 0, huge: 0, empty: 0 };
const keptByMode = { withTopStuds: 0, noTopStuds: 0, partialStuds: 0, centerStuds: 0, subGridClamped: 0, needsManual: 0, antiMeasured: 0, antiAssumed: 0 };
let done = 0;
for (const f of files) {
  done++;
  if (done % 4000 === 0) console.error(`  … ${done}/${files.length}`);
  const id = f.replace(/\.dat$/, '').toLowerCase();
  const text = fs.readFileSync(path.join(DIR, 'parts', f), 'utf8');
  const head = text.slice(0, 800);
  const desc = (text.split(/\r?\n/).find((l) => /^0\s/.test(l)) || '').replace(/^0\s+/, '').trim();
  if (/^~Moved to /i.test(desc)) { skip.moved++; continue; }
  if (/^0\s+!STICKER/i.test(head) || /^0\s+!CATEGORY\s+Sticker/im.test(head) || /^=?Sticker\b/i.test(desc)) { skip.sticker++; continue; }
  if (!BOM_NEED_WHITELIST.has(id) && /obsolete/i.test(head.split('!HISTORY')[0])) { skip.obsolete++; continue; }
  const catLine = (head.match(/^0\s+!CATEGORY\s+(.+)$/m) || [])[1];
  const rawCat = catLine ? catLine.trim() : '';
  if (/^(Duplo|Quatro|Primo|Scala|Znap|Clikits|Belville|Fabuland|Modulex|Bionicle|Hero Factory|Constraction)\b/i.test(rawCat)
    || /\b(Duplo|Quatro|Primo|Scala|Znap|Clikits|Belville|Fabuland|Modulex|Bionicle|Hero Factory)\b/i.test(desc)) {
    skip.nonSystem++; continue;
  }
  if (!INCLUDE_PATTERNED && !BOM_NEED_WHITELIST.has(id) && isPatternedOrDerivative(id, desc)) { skip.patterned++; continue; }
  const category = mapCat(rawCat || 'Other', desc);
  if (category === 'minifig' && !BOM_NEED_WHITELIST.has(id)) { skip.minifig++; continue; }
  if (/^Sheet\s+(Plastic|Fabric|Cardboard)\b/i.test(rawCat) || /^(Sheet|Sail|Cape|Cloth|Cardboard)\b/i.test(desc)) { skip.flatSheet++; continue; }
  const fullBox = bboxFromText(text, readLib);
  if (!fullBox) { skip.empty++; continue; }
  const fullEx = fullBox.max[0] - fullBox.min[0], fullEy = fullBox.max[1] - fullBox.min[1], fullEz = fullBox.max[2] - fullBox.min[2];
  // 过滤厚度 ≤ 1 LDU 的纯 2D 纸片/膜片；其余细杆/窗芯/插销（> 1 LDU）保底为 1 格 / 1 片占地
  if (fullEx <= 1 || fullEy <= 1 || fullEz <= 1) { skip.flatSheet++; continue; }

  // —— 连接图元实例分类（P1 连接语义自动提取，白名单见 src/ldraw/ldraw.js）——
  // 顶/底凸点按朝向 + 位置区分：yUp = 复合矩阵 Y 分量（>0.7 凸点朝上，<-0.7 朝下，|·|<0.3 横向=侧凸点）
  const instances = connectorInstancesFromText(text, readLib);
  const vStuds = [], sideStuds = [], antistuds = [], pinHoleInst = [], axleHoleInst = [], pinInst = [], barInst = [], clipInst = [], wpinInst = [];
  for (const c of instances) {
    if (STUD_PRIMITIVES.has(c.prim)) {
      if (c.yUp > 0.7) vStuds.push(c);
      else if (Math.abs(c.yUp) < 0.3) sideStuds.push(c);
    } else if (ANTISTUD_PRIMITIVES.has(c.prim)) {
      if (c.yUp < -0.7) antistuds.push(c);
    } else if (PIN_HOLE_PRIMITIVES.has(c.prim)) pinHoleInst.push(c);
    else if (AXLE_HOLE_PRIMITIVES.has(c.prim)) axleHoleInst.push(c);
    else if (WPIN_PRIMITIVES.has(c.prim)) wpinInst.push(c);
    else if (PIN_PRIMITIVES.has(c.prim)) pinInst.push(c);
    else if (BAR_PRIMITIVES.has(c.prim)) barInst.push(c);
    else if (CLIP_PRIMITIVES.has(c.prim)) clipInst.push(c);
  }

  // —— 主体包围盒（P0-a 外挑分离）：销/把手/夹/横向凸点/轮销/轴端等外挑不计入主体占地 ——
  // 把手/销/夹的配套立柱（如 18649 两端 4-4cylo 柱）是裸圆柱图元，按「位于连接图元实例 14 LDU 邻域内」一并剔除。
  // 轮销（wpin*，2026-10 修复）：18892 两侧轮销中心在 x=±42 LDU，不剔除会把 4 格砖体量成 5.4 格（误记 [5,2]）。
  // 连接图元锚点：销/轮销/杆/夹的实例位置。附近 14 LDU 内的裸圆柱视为配套立柱一并剔除——
  // 轮销（wpin*）也必须进来：21445 的轮销带一圈 1-4cyli 孔壁，不进锚点会被当主体量成 2 格深（y 14）。
  const connAnchors = [...pinInst, ...wpinInst, ...barInst, ...clipInst].map((c) => c.pos);
  const nearConn = (pos) => connAnchors.some((a) => (a[0] - pos[0]) ** 2 + (a[1] - pos[1]) ** 2 + (a[2] - pos[2]) ** 2 < 196);
  const bodyBox = bboxFromText(text, readLib, {
    skipInstance: (base, MM, pos) =>
      PROTRUSION_PRIMITIVES.has(base)
      || (STUD_PRIMITIVES.has(base) && Math.abs(MM[1][1]) < 0.3)
      || (/^(\d+-\d+(-\d+)?)?cyl/i.test(base) && pos && nearConn(pos)),
  }) || fullBox; // 纯销/纯杆件（实体全部由外挑图元构成）退回全量 bbox

  // —— 高度归一（P0-a）：剔除官方 bbox 顶部标准凸沿 4 LDU 后取整（28 LDU 砖记 3 片而非 4 片）——
  const eyBody = bodyBox.max[1] - bodyBox.min[1];
  let topLip = 0;
  if (vStuds.length) {
    const minStudY = Math.min(...vStuds.map((s) => s.pos[1]));
    const over = minStudY - bodyBox.min[1]; // 凸点基面到 bbox 顶的距离
    if (over >= 3.5 && over <= 4.5) topLip = 4; // 恰为标准凸点凸沿 → 剔除
  }
  const rawSx = Math.round((bodyBox.max[0] - bodyBox.min[0]) / 20);
  const rawSz = Math.round((bodyBox.max[2] - bodyBox.min[2]) / 20);
  const rawH = Math.round((eyBody - topLip) / 8);
  const subGrid = rawSx < 1 || rawSz < 1 || rawH < 1;
  const sx = Math.max(1, rawSx), sz = Math.max(1, rawSz), h = Math.max(1, rawH);
  if (sx > 64 || sz > 64 || h > 160) { skip.huge++; continue; }

  // —— 本地坐标基准（引擎约定：本地 +x = LDraw +x，+y = -LDraw y（上），+z = -LDraw z）——
  let originX = (bodyBox.min[0] + bodyBox.max[0]) / 2;
  let originZ = (bodyBox.min[2] + bodyBox.max[2]) / 2;
  let bodyBottomY = bodyBox.max[1];
  let needsManual = false; // 无法自动判定 → 标记人工处理，绝不猜

  // —— P0-b 支架 schema：从官方 .dat 实测补 vH/dir/sideRows（对齐精选目录 99780/99781 schema）——
  // 基板 = 带顶凸点的翼板（1 片厚）；墙板 = 带侧凸点的翼板；vH = 官方总高取整片（99780/99781 实测 20/24 LDU → 3）。
  const isBracket = category === 'bracket' || /^bracket\b/i.test(desc);
  const bracket = { dir: null, vH: 0, sideRows: [] };
  if (isBracket) {
    if (vStuds.length && sideStuds.length) {
      const ys = vStuds.map((s) => s.pos[1]);
      const baseTopY = Math.min(...ys);
      if (Math.max(...ys) - baseTopY > 2) needsManual = true; // 多层顶凸点支架无法用单一基板表达
      const xs = vStuds.map((s) => s.pos[0]), zs = vStuds.map((s) => s.pos[2]);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minZ = Math.min(...zs), maxZ = Math.max(...zs);
      const bx = Math.round((maxX - minX) / 20) + 1, bz = Math.round((maxZ - minZ) / 20) + 1;
      const wallYs = sideStuds.map((s) => s.pos[1]);
      const wallMidY = (Math.min(...wallYs) + Math.max(...wallYs)) / 2;
      // 引擎 bracket 墙板固定外挑在本地 +z（= LDraw -z 一侧）；墙板在另一侧或贴着基板面的件不猜
      const wallZs = sideStuds.map((s) => s.pos[2]);
      const wallOnLdrawMinusZ = Math.max(...wallZs) < (bodyBox.min[2] + bodyBox.max[2]) / 2;
      if (wallMidY < baseTopY - 1) bracket.dir = 'up';
      else if (wallMidY > baseTopY + 2) bracket.dir = 'down';
      if (!bracket.dir || !wallOnLdrawMinusZ) needsManual = true;
      bracket.vH = Math.max(1, Math.round(fullEy / 8));
      // 侧凸点行高（片，相对基板底面，向下为负）：99780 实测 +1.25 / 2436a 实测 -0.25
      const baseBottomY = baseTopY + 8;
      bracket.sideRows = [...new Set(wallYs.map((y) => Math.round(((baseBottomY - y) / 8) * 100) / 100))].sort((a, b) => a - b);
      // 支架条目基准改为基板中心 + 基板底
      originX = (minX + maxX) / 2; originZ = (minZ + maxZ) / 2; bodyBottomY = baseBottomY;
      bracket.cells = vStuds.map((s) => {
        const fi = (s.pos[0] - minX) / 20 - 0.5, fk = (maxZ - s.pos[2]) / 20 - 0.5;
        return [Math.round(fi), Math.round(fk)];
      });
      bracket.size = [Math.max(1, Math.min(bx, 64)), Math.max(1, Math.min(bz, 64))];
    } else {
      needsManual = true; // 无顶凸点或无侧凸点：无法定位基板/墙板
    }
  }

  // 顶凸点（非支架路径，2026-10 多高度凸点）：不再只保留顶面 1 片内的凸点——
  // 每个竖直凸点记录真实本地高度 ly（片，零件底面起算 = (bodyBottomY - LDraw y)/8），
  // studCells 条目第三位携带 ly。缺省（顶面，ly ≈ h）不写第三位，条目形态与旧版完全一致。
  // 这样底盘座舱槽（28324）、双阶斜坡（22889）、轮拱（50745）等凹形件的内腔凸点都能被扣合。
  const pts = bracket.dir ? [] : vStuds.map((s) => ({ pos: s.pos, ly: r2((bodyBottomY - s.pos[1]) / 8) }));
  const midX = originX, midZ = originZ;
  // 逐格收集该格上所有竖直凸点的 ly（同一格可能有上下两层凸点）。
  const cellLys = new Map();        // "i,k" → Set(ly)
  const offGridStuds = [];          // [lx, lz, ly?]
  // 「顶面凸点」判定：凸点基面与目录高度 h 相差 ≤ 0.5 片即视为顶面凸点（不写第三位，条目形态与旧版一致）。
  // 容差 0.5 片用来吸收 h 的取整：底板类（210/397）官方主体只有 4 LDU（0.5 片）厚、h 取整为 1，
  // 凸点基面在 0.5 片处——按严格相等会把它写成 ly=0.5，叠在上面的零件就会陷进 1 片厚的体里。
  const lyTop = (ly) => Math.abs(ly - h) <= 0.5;
  const nearA = (a, b) => Math.abs(a - b) < 0.1;
  let interiorStuds = 0;
  for (const { pos: p, ly } of pts) {
    // brickbuild 本地坐标：+x 与 LDraw +x 同向，+z 与 LDraw -z 同向（绕 X 轴翻转 180°）
    const fi = (p[0] - bodyBox.min[0]) / 20 - 0.5;
    const fk = (bodyBox.max[2] - p[2]) / 20 - 0.5;
    const ri = Math.round(fi), rk = Math.round(fk);
    if (!lyTop(ly)) interiorStuds++;
    if (!subGrid && Math.abs(fi - ri) <= 0.18 && Math.abs(fk - rk) <= 0.18 && ri >= 0 && ri < sx && rk >= 0 && rk < sz) {
      const key = `${ri},${rk}`;
      if (!cellLys.has(key)) cellLys.set(key, new Set());
      cellLys.get(key).add(ly);
    } else {
      const lx = r2((p[0] - midX) / 20), lz = r2((midZ - p[2]) / 20);
      if (!offGridStuds.some(([x, z, y]) => nearA(x, lx) && nearA(z, lz) && (y === undefined || nearA(y, ly)))) {
        offGridStuds.push(lyTop(ly) ? [lx, lz] : [lx, lz, ly]);
      }
    }
  }
  // studCells 展开：全顶面格写 [i,k]（与旧版字节一致）；含内腔/分层凸点的格写 [i,k,ly] 逐条列出。
  const gridCells = [];
  let gridCellCount = 0;
  for (const [key, lys] of cellLys) {
    const [ii, kk] = key.split(',').map(Number);
    gridCellCount++;
    const arr = [...lys].sort((a, b) => a - b);
    if (arr.every((ly) => lyTop(ly))) gridCells.push([ii, kk]);
    else for (const ly of arr) gridCells.push([ii, kk, ly]);
  }
  const studCount = bracket.dir ? vStuds.length : gridCellCount + offGridStuds.length;
  // 顶面凸点计数（只算在顶面上的）：底孔实测分支仍按「有没有顶面凸点」判定，
  // 不能因为新增了内腔凸点就把这类件的实测底孔（含「明确无底腔」的空数组守卫）丢掉。
  let topStudCount = 0;
  for (const [key, lys] of cellLys) for (const ly of lys) if (lyTop(ly)) { topStudCount++; break; }
  topStudCount += offGridStuds.filter((s) => s.length === 2).length;
  if (interiorStuds) keptByMode.interiorStuds = (keptByMode.interiorStuds || 0) + interiorStuds;
  if (subGrid) keptByMode.subGridClamped++;

  // —— 外挑无法解释 → needsManual（主体/外挑分离后的守门）——
  const explained = [...pinInst, ...wpinInst, ...barInst, ...clipInst, ...sideStuds];
  for (const [ai, sgn] of [[0, 1], [0, -1], [2, 1], [2, -1]]) {
    const gap = sgn > 0 ? fullBox.max[ai] - bodyBox.max[ai] : bodyBox.min[ai] - fullBox.min[ai];
    if (gap <= 4) continue;
    const covered = explained.some((c) => (sgn > 0 ? c.pos[ai] > bodyBox.max[ai] - 2 : c.pos[ai] < bodyBox.min[ai] + 2));
    if (!covered) needsManual = true;
  }

  // 分解包围盒用的大类（形态判定时排除 brick/plate/tile/corner/technic 等实心族）
  const kindForBoxes = category;

  // —— 连接字段本地坐标换算（ly 单位 = 格，与引擎 localToWorld 一致）——
  const toLocal = (p) => [r2((p[0] - originX) / 20), r2((bodyBottomY - p[1]) / 20), r2((originZ - p[2]) / 20)];
  const col = (M, j) => [M[0][j], M[1][j], M[2][j]];
  const localAxis = (v) => { // LDraw 世界向量 → 引擎本地轴名（x 同向、y/z 取反）
    const a = [v[0], -v[1], -v[2]];
    const ax = Math.abs(a[0]), ay = Math.abs(a[1]), az = Math.abs(a[2]);
    return ax >= ay && ax >= az ? 'x' : az >= ay ? 'z' : 'y';
  };
  const localFace = (v) => {
    const a = [v[0], -v[1], -v[2]];
    const ax = Math.abs(a[0]), ay = Math.abs(a[1]), az = Math.abs(a[2]);
    if (ax >= ay && ax >= az) return a[0] > 0 ? '+x' : '-x';
    if (az >= ay) return a[2] > 0 ? '+z' : '-z';
    return a[1] > 0 ? '+y' : '-y';
  };
  const dedupe = (arr) => {
    const seen = new Map();
    for (const e of arr) {
      const k = e.slice(0, 3).map((v) => Math.round(v * 4) / 4).join(',') + '|' + e[3];
      if (!seen.has(k)) seen.set(k, e);
    }
    return [...seen.values()];
  };
  const connExtra = {};
  // 几何原点（loader 用）：本地框架约定「占地中心原点、底面 y=0」。
  // loader 的换算 local_y = -LDraw_y/20 + origin_studs（origin[1] 以「片」记，内部 ×PLATE 转格），
  // 令零件最底材料（LDraw y 最大处 = bodyBottomY）落到 local_y = 0，得 origin[1] = bodyBottomY / 8（1 片 = 8 LDU）。
  // 旧实现退回 [0, def.h, 0]：ext 的 h 是"主体高度"而非几何基线，导致 2772 件几何整体漂浮（最大错 29 片）。
  connExtra.ldrawOrigin = [0, r2(bodyBottomY / 8), 0];
  const holeList = dedupe(pinHoleInst.map((c) => [...toLocal(c.pos), localAxis(col(c.M, 1))]));
  const axleList = dedupe(axleHoleInst.map((c) => [...toLocal(c.pos), localAxis(col(c.M, 1))]));
  if (holeList.length) connExtra.holes = holeList;            // 销孔（peghole/beamhole/connhole，孔口逐个表示）
  if (axleList.length) connExtra.axleHoles = axleList;        // 轴孔（axlehole/axlehol 族，不含轴杆本体 axlehol8）
  const pinList = dedupe(pinInst.map((c) => [...toLocal(c.pos), localAxis(col(c.M, 1))]));
  if (pinList.length) connExtra.pins = pinList;               // 外凸销（connect 族，销环中心）
  // 轮轴销（wpin*，2026-10）：轮销外端 + 轴向。用于 pin↔axleHole 配对（轮销插轮毂中央轴孔），
  // 同时 wheelPins 字段让审计/测试能核对「18892 这类件确实有轮销」。
  // 轮销的销轴 = 图元本地 y（wpin2.dat 本体长度沿本地 y；实例矩阵把本地 y 旋到世界 ±x）。
  // 连接点取轮销的「外端」（离零件中心最远的那一头）：轮毂中央轴孔就套在这一端，轮毂盘面因此整个落在
  // 零件体外（若取实例原点，半只轮毂会陷进车体内部 → 与车体 3D 穿模）。
  const wpinList = dedupe(wpinInst.map((c) => {
    const ax = localAxis(col(c.M, 1));
    const ai = { x: 0, y: 1, z: 2 }[ax] ?? 0;
    const wb = instanceWorldBox(c.prim, c.M, c.pos, readLib);
    const p = c.pos.slice();
    if (wb) {
      const center = ai === 0 ? originX : ai === 2 ? originZ : 0;
      const dMin = Math.abs(wb.min[ai] - center), dMax = Math.abs(wb.max[ai] - center);
      p[ai] = dMax >= dMin ? wb.max[ai] : wb.min[ai];
    }
    return [...toLocal(p), ax];
  }));
  if (wpinList.length) {
    connExtra.wheelPins = wpinList;
    connExtra.pins = dedupe([...(connExtra.pins || []), ...wpinList]);   // 轮销也是外凸销
  }
  const barList = dedupe(barInst.map((c) => [...toLocal(c.pos), localAxis(col(c.M, 0))]));
  if (barList.length) connExtra.bars = barList;               // 把手/杆（phandle/handle 族，杆沿图元本地 x）
  const sideList = dedupe(sideStuds.map((c) => [...toLocal(c.pos), localFace(col(c.M, 1).map((v) => -v))]));
  if (sideList.length) connExtra.sideStuds = sideList;        // 侧凸点（横向凸点图元，face=朝外方向）
  const clipList = dedupe(clipInst.map((c) => [...toLocal(c.pos), localFace(col(c.M, 2).map((v) => -v))]));
  if (clipList.length) connExtra.clips = clipList;            // 夹口（clip 族，face=夹口张开方向）

  // —— .dat 无反孔图元时的三类处置（2026-10 回修，依据 out/ext-audit2 实测）——
  // A 禁用（维持空数组）：科技件、杆/夹/握持件、圆盘罩类、动物车辆轮履杂项；
  // B 保守恢复（antistudSource:'assumed'）：System 砖族安装本体（官方 .dat 用 box 边沿建模底腔、不逐格建模反孔图元，
  //   物理底孔存在——审计点名 3937/6078/65146 的垫砖能力丢失）；名称点名「without understuds」的例外件（5849/10314）仍禁用；
  // C 名称点名的握持件（Bar/Hose/Arm Piece/Claw/Pole/Spike/Kite/Ring/Propeller/Flower/Mast/Oar/
  //   Rigging/Cable/Antenna/Pantograph/Control Stick）仍禁用（2375 铰链杆等）。
  // 「无顶面凸点」与「只有内腔凸点」两个分支共用，保证增量改动不改变既有件的底孔语义。
  const resolveAssumedAntistuds = (kindName, descText, extraObj) => {
    const ROD_LIKE = /(bar|hose|arm piece|claw|pole|spike|kite|ring|propeller|flower|mast|oar|rigging|cable|antenna|pantograph|control stick)/i;
    const ASSUME_KINDS = new Set(['brick', 'plate', 'slope', 'ridge', 'cheese', 'islope', 'cslope', 'arch', 'wedge', 'panel', 'door', 'doorframe', 'hinge', 'bracket', 'tile']);
    if (!/without under-?stud/i.test(descText) && !ROD_LIKE.test(descText) && ASSUME_KINDS.has(kindName)) {
      delete extraObj.antistudCells;
      extraObj.antistudSource = 'assumed';
      keptByMode.antiAssumed++;
      return true;
    }
    return false;
  };

  // —— 底孔按 .dat 判定（杜绝虚假受体；2026-10 回修：簇图元展开 + 三类处置）——
  // 仅对「无顶凸点且非 tile 类目」的条目写实测底孔；有顶凸点或 tile 类目保持引擎默认满格。
  // stud3/stud3a/stud4/stud4a 是标准底面的「格点边界管」（填充在 4 个底孔腔的交界处，r4/r8 管）：
  //   实例位落在格心（|Δ|≤0.35）→ 单格底孔；落在半格位（格点边界）= 簇图元 → 按覆盖格展开为交界两侧
  //   的 2×2 格（3299 三根 stud4a 交界管展开 = 4×2 满格；3049b 的 stud3a 展开 = 其 2×1 真实底面的两格）。
  //   展开结果去重后写 antistudCells + antistudSource:'measured'（不再写 antistudCenter——
  //   偶数网格的中心管即交界管，由展开覆盖；半格位中心受体会产生非整数扣合坐标，见审计 3299 回归）。
  // .dat 无反孔图元时不猜：先写空数组并记 antistudUnmeasured，待 studCount===0 分支按件族分类
  // （禁用维持空数组 / antistudSource:'assumed' 保守恢复引擎默认满格），三类策略详见该分支注释。
  const hasTopSemantics = bracket.dir || topStudCount > 0;
  let antistudUnmeasured = false;
  if (!hasTopSemantics && category !== 'tile') {
    const cellSet = new Map();
    for (const c of antistuds) {
      if (c.pos[1] < bodyBottomY - 8) continue;
      const fi = (c.pos[0] - bodyBox.min[0]) / 20 - 0.5, fk = (bodyBox.max[2] - c.pos[2]) / 20 - 0.5;
      const nearI = Math.round(fi), nearK = Math.round(fk);
      const iCells = Math.abs(fi - nearI) <= 0.35 ? [nearI] : [Math.floor(fi), Math.floor(fi) + 1];
      const kCells = Math.abs(fk - nearK) <= 0.35 ? [nearK] : [Math.floor(fk), Math.floor(fk) + 1];
      for (const i of iCells) for (const k of kCells) if (i >= 0 && i < sx && k >= 0 && k < sz) cellSet.set(`${i},${k}`, [i, k]);
    }
    if (cellSet.size) {
      connExtra.antistudCells = [...cellSet.values()];
      connExtra.antistudSource = 'measured';
      keptByMode.antiMeasured++;
    } else {
      connExtra.antistudCells = [];
      antistudUnmeasured = true;
    }
  }
  if (needsManual) { connExtra.needsManual = true; keptByMode.needsManual++; }

  // —— 车轮语义（2026-10）：轮毂 rim（外径）、轮胎 tyre（内孔 + 外径），轴向取 bbox 最薄轴 ——
  // wheel: { role:'rim'|'tyre', axis:'x'|'y'|'z', outer（外径格）, bore（内孔格） }；
  // partsConnected 用 axial 同心 + bore ≤ rim.outer ≤ tyre.outer 判 tyre↔rim。
  if (isWheelRim(desc) || isTyre(desc)) {
    const prof = radialProfile(text, readLib);
    if (prof) {
      const role = isTyre(desc) ? 'tyre' : 'rim';
      // cy = 轮心相对零件底面的高度（片）：轮毂/轮胎的轴向孔必须落在真实轮心上，不能用 h/2 近似。
      const cy = r2(((bodyBottomY - prof.center[1]) / 8));
      connExtra.wheel = { role, axis: prof.axis, outer: r2(prof.outer / 20), bore: r2(prof.bore / 20), cy };
      // 轮/胎是圆盘件，轮毂中心必然落在格线之外（真实 18892 轮销中心在 2.1 格处）：
      // 标 offGrid 让引擎允许非整数 at（不做整格占用判定，穿模仍由 3D 盒负责）。
      connExtra.offGrid = true;
      // 轮毂补中央轴孔（11208 的 .dat 用环图元建模轮毂，没有 axlehole 图元，实测不出轴孔；
      // 但轮毂物理上必须有中央轴孔才能套到轮销/轴上）：位置 = 轮心，轴向 = 轮轴方向。
      if (role === 'rim' && !axleList.length) {
        // axleHoles 的 ly 单位是格（1 格 = 2.5 片）→ cy(片) × 0.4 = ly(格)
        connExtra.axleHoles = dedupe([...(connExtra.axleHoles || []), [0, r2(cy * 0.4), 0, prof.axis]]);
      }
      keptByMode[role === 'rim' ? 'wheelRim' : 'wheelTyre'] = (keptByMode[role === 'rim' ? 'wheelRim' : 'wheelTyre'] || 0) + 1;
    } else {
      connExtra.needsManualWheel = true;
    }
  }

  // —— 人仔标准接口（2026-10）：腿/胯 ↔ 躯干 ↔ 头 ↔ 帽 ——
  // 官方 .dat 不建模裤脚插柱/颈孔（人仔是装配体而非系统砖），因此按人仔标准件尺寸写实测/标准值：
  //   优先用 MINIFIG_STANDARD 的件号表（BOM 白名单四件：73200/76382/3626b/11303）；
  //   其余人仔件按名称族识别躯干/头，仅写官方 .dat 实测得出的一侧（另一侧标 needsManualMinifig 不猜）。
  {
    const std = MINIFIG_STANDARD[id];
    if (std) connExtra.minifig = { ...(std.pegs ? { pegs: std.pegs } : {}), ...(std.sockets ? { sockets: std.sockets } : {}) };
    else if (isTorsoDesc(desc)) {
      // 躯干默认两个胯孔（人仔标准件位置）+ 颈部插柱（官方 973 主体高 44 LDU = 5.5 片）
      connExtra.minifig = { sockets: [[-0.5, 0, 0], [0.5, 0, 0]], pegs: [[0, 5.5, 0]] };
      connExtra.needsManualMinifig = true;   // 非白名单躯干的颈高未逐件实测 → 标人工复核
    } else if (isHeadDesc(desc)) {
      connExtra.minifig = { sockets: [[0, 0, 0]] };
      connExtra.needsManualMinifig = true;
    }
    if (connExtra.minifig) keptByMode.minifig = (keptByMode.minifig || 0) + 1;
  }

  // —— 分解包围盒（2026-10）：凹形件（底盘座舱槽 / 开口中腔 / 轮拱）多盒分解 ——
  // 依据官方 .dat 双向竖向高度图（heightMapColumns，剔除凸点/外挑图元只看主体壳）：
  //   · 每格顶面未到零件顶（< h-0.4）→ 开口内腔格，输出地板盒（0..舱底高度），上方留空；
  //   · 其余格保持满高（0..h），与旧单盒完全一致。
  // 只有真的存在开口内腔格才写 boxes（否则保持单盒，旧条目行为不变）。
  // 跳过 bracket（自带 vH/dir 结构盒）、occupies:false 与超小网格件；无法判定的标 needsManualBoxes。
  if (!(isBracket && bracket.dir) && !subGrid && sx * sz <= 400) {
    try {
      const shell = bboxFromText(text, readLib, {
        skipInstance: (base) => PROTRUSION_PRIMITIVES.has(base)
          || STUD_PRIMITIVES.has(base) || ANTISTUD_PRIMITIVES.has(base) || base.startsWith('stug'),
      }) || bodyBox;
      const hm = heightMapColumns(text, readLib, {
        size: [sx, sz], bodyBottomY, min: shell.min, max: shell.max, sub: 2,
        skipPrim: (base) => PROTRUSION_PRIMITIVES.has(base)
          || STUD_PRIMITIVES.has(base) || ANTISTUD_PRIMITIVES.has(base) || base.startsWith('stug'),
      });
      const dec = decomposeHeightMap(hm, [sx, sz], h, kindForBoxes);
      if (dec.boxes.length) {
        // 覆盖率自检：双向射线只在子格中心采样，弯曲/倾斜壳体（轮拱 50745、斜挡泥板）
        // 会整格采空 → boxes 只剩被采到的少量格，其余材料在碰撞判定里消失（实测 50745 覆盖率 0.03）。
        // 覆盖率不足时宁可退回单实心盒（保守：可能把内腔封死，但绝不漏保护真实材料）。
        const pts = [];
        const tris = trianglesFromText(text, readLib, {
          skipPrim: (base) => PROTRUSION_PRIMITIVES.has(base) || STUD_PRIMITIVES.has(base)
            || ANTISTUD_PRIMITIVES.has(base) || base.startsWith('stug'),
        });
        for (const t of tris) for (const v of t) pts.push([v[0] / 20, v[1] / 20, v[2] / 20]);
        const check = decomposeHeightMapChecked(hm, [sx, sz], h, pts);
        if (check.coverage === null || check.coverage >= BOX_COVERAGE_MIN) {
          connExtra.boxes = dec.boxes;
          connExtra.boxesSource = 'ldraw-heightmap';
          connExtra.boxesOpenCells = dec.openCells;
          if (check.coverage !== null) connExtra.boxesCoverage = r2(check.coverage);
          keptByMode.decomposed = (keptByMode.decomposed || 0) + 1;
        } else {
          connExtra.needsManualBoxes = true;
          connExtra.needsManualBoxesReason =
            `分解盒覆盖率仅 ${r2(check.coverage)}（< ${BOX_COVERAGE_MIN}）：射线采样采空弯曲壳体，退回单实心盒`;
          keptByMode.boxCoverageRejected = (keptByMode.boxCoverageRejected || 0) + 1;
        }
      }
    } catch (e) {
      connExtra.needsManualBoxes = true;
      connExtra.needsManualBoxesReason = String(e.message || e);
    }
  }

  // —— 支架条目（P0-b）：h=基板厚(1 片) + vH + dir + sideRows + 基板凸点格 ——
  if (isBracket && bracket.dir) {
    const fullGrid = bracket.cells.length === bracket.size[0] * bracket.size[1];
    parts[id] = {
      name: desc, zh: '', kind: 'bracket', category,
      size: bracket.size, h: 1,
      dir: bracket.dir, vH: bracket.vH, sideRows: bracket.sideRows,
      studs: vStuds.length, grid: fullGrid,
      ...(fullGrid ? {} : { studCells: bracket.cells }),
      ...connExtra,
      auto: true, source: 'LDraw 官方几何自动提取（catalog/ldraw-full）',
    };
    keptByMode.withTopStuds++;
    continue;
  }

  if (studCount === 0) {
    // 全部无顶凸点系统基础零件入库：标记 tile: true, studs: 0（禁止顶面叠件，保留底孔/把柄/夹持或实体占位语义）
    let kind = category;
    if (/^(bar|antenna)\b/i.test(desc) && sx === 1 && sz === 1) kind = 'bar';
    else if (/\bclip\b/i.test(desc) && category === 'hinge') kind = 'clip';
    else if (category === 'tile' || (h === 1 && (category === 'plate' || category === 'other'))) kind = 'tile';
    else if (category === 'slope') kind = /\bdouble\b/i.test(desc) ? 'ridge' : h <= 2 ? 'cheese' : /\binverted\b/i.test(desc) ? 'islope' : 'slope';
    else if (category === 'cslope') kind = /\barch\b/i.test(desc) ? 'arch' : 'cslope';
    else if (category === 'round') kind = /\b(dome|hemisphere|sphere)\b/i.test(desc) ? 'dome' : /\bdish\b/i.test(desc) ? 'dish' : /\bcone\b/i.test(desc) ? 'cone' : 'round';
    else if (category === 'building') kind = /\b(panel|fence|wall|windscreen|glass)\b/i.test(desc) ? 'panel' : /^door\b/i.test(desc) && !/\bframe\b/i.test(desc) ? 'door' : 'doorframe';
    const extra = {};
    if (kind === 'wedge') extra.side = /\bleft\b/i.test(desc) ? 'L' : 'R';
    if (/\bgrille\b/i.test(desc)) extra.grille = true;
    if (subGrid) extra.subGrid = true;
    // —— .dat 无反孔图元时的三类处置（2026-10 回修，依据 out/ext-audit2 实测）——
    // A 禁用（维持空数组）：科技件（technic：梁/轴/销/轴衬——实测 32017/3673/3705/3749/4459/4265a 底面
    //   确无标准底孔网格）、杆/夹/握持件（bar/clip）、圆盘罩类（round/dome/dish/cone——反射碗/半球/花盘
    //   等握持装饰件）、动物车辆轮履杂项（other/minifig）；
    // B 保守恢复（antistudSource:'assumed'，移除空数组走引擎默认满格）：System 砖族安装本体
    //   （brick/plate/slope/ridge/cheese/islope/cslope/arch/wedge/panel/door/doorframe/hinge/bracket/tile 形）——
    //   官方 .dat 用 box 边沿建模底腔、不逐格建模反孔图元，物理底孔存在（审计点名 3937/6078/65146
    //   垫砖能力丢失）；名称点名「without understuds」的例外件（5849/10314）仍禁用；
    //   砖族 kind 中名称为杆/软管/夹爪等握持件的（Hinge Bar/Hose/Arm Piece/Claw/Pole/Spike/Kite/Ring/
    //   Propeller/Flower/Mast/Oar/Rigging/Cable/Antenna/Pantograph/Control Stick）仍禁用（2375 铰链杆等）。
    if (antistudUnmeasured) resolveAssumedAntistuds(kind, desc, connExtra);
    // 嵌入窗框/门框内部的超薄玻璃或窗格扇（厚度 ≤ 6 LDU）不占主网格包围盒，避免装入窗框时误报 3D 穿模
    if (category === 'building' && (/^glass\b|\bpane\b/i.test(desc)) && Math.min(fullEx, fullEz) <= 6) {
      extra.occupies = false;
    }
    parts[id] = {
      name: desc, zh: '', kind, category,
      size: [sx, sz], h,
      studs: 0, grid: false, tile: true,
      ...extra, ...connExtra,
      auto: true, source: 'LDraw 官方几何自动提取（catalog/ldraw-full）',
    };
    keptByMode.noTopStuds++;
    continue;
  }

  // 有顶凸点零件：区分满格凸点、部分网格凸点（studCells）与半格偏移跳线凸点（centerStuds）
  const isFullGrid = gridCellCount === sx * sz && offGridStuds.length === 0
    && gridCells.every((c) => c.length === 2);   // 满格且全为顶面凸点（分层/内腔件不写 grid:true）
  const useCenterStuds = offGridStuds.length > 0 && gridCellCount === 0;
  let kind = category;
  if (useCenterStuds && h === 1) kind = 'jumper';
  else if (category === 'slope') kind = /\binverted\b/i.test(desc) ? 'islope' : /\bdouble\b/i.test(desc) ? 'ridge' : 'slope';
  else if (category === 'cslope') kind = /\barch\b/i.test(desc) ? 'arch' : 'cslope';
  else if (category === 'round') kind = /\bdish\b/i.test(desc) ? 'dish' : /\bcone\b/i.test(desc) ? 'cone' : /\bdome\b/i.test(desc) ? 'dome' : 'round';
  else if (category === 'building') kind = /\b(panel|fence|wall|windscreen)\b/i.test(desc) ? 'panel' : 'doorframe';
  else if (h === 1 && isFullGrid && category === 'plate') kind = 'plate';
  else if (h === 3 && isFullGrid && category === 'brick') kind = 'brick';

  // 顶面无凸点但有内腔凸点的凹形件：底孔按同一套三类处置收尾（不能因为有了内腔凸点就跳过）
  if (antistudUnmeasured) resolveAssumedAntistuds(kind, desc, connExtra);
  // 有顶凸点的条目也要收尾：它们在上面的分支里不写 antistudCells，于是既没有实测底孔、
  // 也没有 assumed 标记 → 引擎按「无该字段」走满格，看起来没问题；但 50745 这类条目
  // 由别的路径写了空数组，就变成"底面完全不能扣"。这里统一补：空数组一律走件族判定。
  if (!antistudUnmeasured && Array.isArray(connExtra.antistudCells) && connExtra.antistudCells.length === 0) {
    resolveAssumedAntistuds(kind, desc, connExtra);
  }
  const extra = {};
  if (kind === 'wedge') extra.side = /\bleft\b/i.test(desc) ? 'L' : 'R';
  if (useCenterStuds) {
    extra.centerStuds = offGridStuds;
    keptByMode.centerStuds++;
  } else if (!isFullGrid) {
    extra.studCells = gridCells.slice();
    if (kind === 'cslope') extra.backStuds = true;
    keptByMode.partialStuds++;
  } else {
    // dish/cone 满格角凸点也要显式写入 studCells：引擎对这两类默认强制单中心凸点
    // （core.js partConnectors 与 geom.js 渲染均以 Array.isArray(studCells) 为准、尊重显式数据），
    // 不写会被 kind 覆盖（2654a 官方 4 角凸点曾被强制为 1 个中心凸点）。
    if (kind === 'dish' || kind === 'cone') extra.studCells = gridCells.slice();
    keptByMode.withTopStuds++;
  }

  parts[id] = {
    name: desc, zh: '', kind, category,
    size: [sx, sz], h,
    studs: studCount, grid: isFullGrid,
    ...extra, ...connExtra,
    auto: true, source: 'LDraw 官方几何自动提取（catalog/ldraw-full）',
  };
}

const out = {
  format: 'brickkit-parts-ldraw',
  source: 'https://library.ldraw.org (本地镜像 catalog/ldraw-full, CC BY 2.0/4.0)',
  generatedAt: new Date().toISOString(),
  note: '自动提取的扩充零件目录（默认仅收录基础素模，过滤印刷衍生件）。几何：高度按砖体基准归一（剔除官方 bbox 顶部 4 LDU 凸沿，24 LDU 砖=3 片），销/把手/夹/横向凸点等外挑不计入占地、以连接字段另行表达。连接（P1，官方 .dat 图元白名单实测）：holes=销孔、axleHoles=轴孔、pins=外凸销、bars=把手杆、sideStuds=侧凸点、clips=夹口、antistudCells=实测底孔（含 stud3a/stud4a 簇图元覆盖格展开）。底孔三类处置（2026-10 回修）：antistudSource=measured（.dat 反孔图元实测）/ assumed（.dat 未建模但物理存在的砖族安装本体，走引擎默认满格，3937/6078/65146 类）/ 空数组（.dat 明确无底腔：销杆/科技件/握持件）。支架（P0-b）：vH/dir/sideRows 与精选目录同 schema。dish/cone 满格角凸点显式写 studCells（防引擎单中心凸点覆盖，2654a）。多高度凸点（2026-10）：studCells 条目第三位 ly = 凸点真实本地高度（片，零件底面起算），缺省（无第三位）= 顶面 h；底盘座舱槽/轮拱/双阶斜坡等凹形件的内腔凸点因此可用。分解包围盒（2026-10）：boxes = 本地坐标多盒 [x0,x1,y0,y1,z0,z1]（y 单位片），由官方 .dat 双向竖向高度图逐格取「底面..顶面」材料区间后量化并成矩形（boxesSource=ldraw-heightmap）；只有存在顶面明显低于零件顶的格子时才写 boxes（全高实心件保持单盒），中间空腔留空以便内饰放入。轮/胎（2026-10）：wheel={role:rim|tyre, axis, outer, bore, cy}（外径/内孔为格单位、cy 为轮心高度片），轮毂补中央 axleHoles；offGrid:true 表示圆盘件 at 允许非整数。人仔（2026-10）：minifig={pegs,sockets}（插柱/插孔，ly 单位片），用于腿↔胯↔躯干↔头↔帽互插；非白名单人仔件标 needsManualMinifig。轮销（2026-10）：wheelPins=轮销外端+轴向（已并入 pins）。无法自动判定者标 needsManual:true。颜色与印刷图案均与基础几何解耦。',
  stats: { scanned: files.length, kept: Object.keys(parts).length, keptByMode, skip },
  parts,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.error(`完成：保留 ${Object.keys(parts).length} 种 (${JSON.stringify(keptByMode)}) → ${OUT}`);
console.error(`跳过：${JSON.stringify(skip)}`);
