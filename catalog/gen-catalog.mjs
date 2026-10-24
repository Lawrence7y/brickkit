// 生成 catalog/parts.json —— 基础件参数化目录（尺寸已对照 LDraw 官方零件库核对）
import fs from 'fs';
const P = {};
const add = (id, name, zh, kind, size, h, extra = {}) => { P[id] = { name, zh, kind, size, h, ...extra }; };
const sz = (s) => s.map(String).join('×');
// 砖 brick：高 3 片
for (const [id, x, z] of [['3005',1,1],['3004',2,1],['3622',3,1],['3010',4,1],['3009',6,1],['3008',8,1],['3003',2,2],['3002',3,2],['3001',4,2],['2456',6,2],['3007',8,2]])
  add(id, `Brick ${z} x ${x}`, `砖 ${z}×${x}`, 'brick', [x, z], 3);
add('3065', 'Brick 1 x 2 without Centre Stud', '砖 1×2（无底管，常用于透明件）', 'brick', [2, 1], 3);
// 板 plate：高 1 片
for (const [id, x, z] of [['3024',1,1],['3023',2,1],['3623',3,1],['3710',4,1],['3666',6,1],['3460',8,1],['3022',2,2],['3021',3,2],['3020',4,2],['3795',6,2],['3034',8,2],['3031',4,4],['3032',6,4],['3035',8,4],['3958',6,6],['3036',8,6],['3033',10,6],['41539',8,8]])
  add(id, `Plate ${z} x ${x}`, `板 ${z}×${x}`, 'plate', [x, z], 1);
// 平板 tile：无凸点
for (const [id, x, z] of [['3070b',1,1],['3069b',2,1],['63864',3,1],['2431',4,1],['3068b',2,2],['87079',4,2]])
  add(id, `Tile ${z} x ${x}`, `平板 ${z}×${x}`, 'tile', [x, z], 1);
// 45° 斜面：本地 +z 为斜面朝向（正面），凸点只在后排
for (const [id, x, chk] of [['3040b',1,true],['3039',2,true],['3038',3,false],['3037',4,true]])
  add(id, `Slope Brick 45 2 x ${x}`, `斜面砖 45° 2×${x}`, 'slope', [x, 2], 3, { ldrawOrigin: [0, 3, -0.5], checked: chk });
// 45° 双面斜（屋脊）：无凸点
add('3043', 'Slope Brick 45 2 x 2 Double', '双面斜砖 45° 2×2（屋脊）', 'ridge', [2, 2], 3, { checked: false });
add('3041', 'Slope Brick 45 2 x 4 Double', '双面斜砖 45° 2×4（屋脊）', 'ridge', [4, 2], 3);
// 门框与门（门不占格子，安装在门框上）
add('60596', 'Door 1 x 4 x 6 Frame', '门框 1×4×6', 'doorframe', [4, 1], 18);
add('60623', 'Door 1 x 4 x 6 with 4 Panes and Stud Handle', '门 1×4×6（四格窗）', 'door', [4, 1], 18,
  { occupies: false, ldrawOrigin: [-1.6, 18, -0.25], hinge: { pivot: [-1.6, 0, -0.25], axis: [0, 1, 0] }, note: '与门框使用相同的 at/rot；门轴在门框背面左侧' });
// 圆柱与圆板
add('3941', 'Brick Round 2 x 2', '圆砖 2×2', 'round', [2, 2], 3);
add('3062b', 'Brick Round 1 x 1 Open Stud', '圆砖 1×1（竖纹柱）', 'round', [1, 1], 3, { fluted: true });
add('4073', 'Plate Round 1 x 1', '圆板 1×1', 'round', [1, 1], 1);
// 弧面斜砖：本地 +z 为弧面下坡方向（正面）
add('15068', 'Slope Brick Curved 2 x 2', '弧面斜砖 2×2', 'cslope', [2, 2], 2);
add('47457', 'Slope Brick Curved 2 x 2 x 1', '弧面斜砖 2×2×1（高3片）', 'cslope', [2, 2], 3);
// SNOT 侧凸点砖：本地 +z 侧面带凸点
add('87087', 'Brick 1 x 1 with Stud on 1 Side', '单面侧凸点砖 1×1', 'snot', [1, 1], 3);
add('11211', 'Brick 1 x 2 x 1 2/3 with 4 Studs on 1 Side', '单面四凸点砖 1×2（高5片）', 'snot', [2, 1], 5);
add('30414', 'Brick 1 x 4 with 4 Studs on 1 Side', '单面四凸点砖 1×4', 'snot', [4, 1], 3);
// 合页夹板与把柄板：夹口/把柄朝向本地 +z
add('48336', 'Plate 1 x 2 with Handle on Side', '带侧把柄板 1×2', 'barplate', [2, 1], 1);
add('60470', 'Plate 1 x 2 with Horizontal Clips', '带水平夹板 1×2', 'clip', [2, 1], 1);
// 楔形翼板：斜切边在本地 -x（Left）或 +x（Right）
add('41770', 'Wedge Plate 4 x 2 Left', '左楔形翼板 2×4', 'wedge', [2, 4], 1, { side: 'L' });
add('41769', 'Wedge Plate 4 x 2 Right', '右楔形翼板 2×4', 'wedge', [2, 4], 1, { side: 'R' });
add('24299', 'Wedge Plate 2 x 2 Left', '左楔形翼板 2×2', 'wedge', [2, 2], 1, { side: 'L' });
add('24307', 'Wedge Plate 2 x 2 Right', '右楔形翼板 2×2', 'wedge', [2, 2], 1, { side: 'R' });
for (const v of Object.values(P)) { if (!v.ldrawOrigin) v.ldrawOrigin = [0, v.h, 0]; if (v.checked === undefined) v.checked = true; }
const out = { format: 'brickbuild-catalog', version: '0.1',
  units: { stud: '1 格 = 8 mm（LDraw 20 LDU）', plate: '1 层 = 3.2 mm（LDraw 8 LDU）' },
  note: 'size=[沿本地 x 的格数, 沿本地 z 的格数]（与 LDraw 零件的 X/Z 一致）；h=高度（片）；ldrawOrigin=LDraw 原点在本地坐标中的位置（x,z 以格为单位、相对占地中心；y 以片为单位、相对底面）；checked=已用 LDraw 官方库核对尺寸与原点',
  parts: P };
fs.writeFileSync(new URL('./parts.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(Object.keys(P).length, 'parts');
