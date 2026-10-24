// 生成 catalog/parts.json —— 乐高核心零件参数化目录（尺寸、凸点、侧凸点、支架、把柄/夹子均对照 LDraw 官方零件库核对）
// 单位换算：1 格 (stud) = 8.0 mm = 20 LDU；1 层/片 (plate) = 3.2 mm = 8 LDU = 0.4 格；1 砖高 (brick) = 3 片 = 9.6 mm = 24 LDU = 1.2 格（5 片 = 2 格）
import fs from 'fs';

const P = {};
const add = (id, name, zh, kind, size, h, extra = {}) => {
  P[id] = { name, zh, kind, size, h, ...extra };
};

// ================================================================
// 1. 基础砖 (Bricks, h = 3 片；高砖 h = 9 / 15 片)
// ================================================================
for (const [id, x, z] of [
  ['3005', 1, 1], ['3004', 2, 1], ['3622', 3, 1], ['3010', 4, 1],
  ['3009', 6, 1], ['3008', 8, 1], ['6111', 10, 1], ['6112', 12, 1],
  ['3003', 2, 2], ['3002', 3, 2], ['3001', 4, 2], ['2456', 6, 2],
  ['3007', 8, 2], ['3006', 10, 2],
]) {
  add(id, `Brick ${z} x ${x}`, `砖 ${z}×${x}`, 'brick', [x, z], 3, { category: 'brick' });
}
add('3065', 'Brick 1 x 2 without Centre Tube', '砖 1×2（无底管，常用于透明件）', 'brick', [2, 1], 3, { category: 'brick' });
add('2357', 'Brick 2 x 2 Corner', 'L型转角砖 2×2', 'corner', [2, 2], 3, { category: 'brick' });
add('14716', 'Brick 1 x 1 x 3', '高砖 1×1×3', 'brick', [1, 1], 9, { category: 'brick' });
add('2453', 'Brick 1 x 1 x 5', '高柱砖 1×1×5', 'brick', [1, 1], 15, { category: 'brick' });
add('2454', 'Brick 1 x 2 x 5', '高柱砖 1×2×5', 'brick', [2, 1], 15, { category: 'brick' });
add('30145', 'Brick 2 x 2 x 3', '高砖 2×2×3', 'brick', [2, 2], 9, { category: 'brick' });
add('30136', 'Brick 1 x 2 Log', '圆木栅栏纹砖 1×2', 'brick', [2, 1], 3, { fluted: true, category: 'brick' });
add('98283', 'Brick 1 x 2 Masonry', '砖石墙纹砖 1×2', 'brick', [2, 1], 3, { category: 'brick' });
add('2877', 'Brick 1 x 2 with Grille', '横纹格栅砖 1×2', 'brick', [2, 1], 3, { category: 'brick' });

// ================================================================
// 2. 基础板与跳线板 (Plates & Jumper Plates, h = 1 片)
// ================================================================
for (const [id, x, z] of [
  ['3024', 1, 1], ['3023', 2, 1], ['3623', 3, 1], ['3710', 4, 1],
  ['78329', 5, 1], ['3666', 6, 1], ['3460', 8, 1], ['4477', 10, 1], ['60479', 12, 1],
  ['3022', 2, 2], ['3021', 3, 2], ['3020', 4, 2], ['3795', 6, 2],
  ['3034', 8, 2], ['3832', 10, 2], ['2445', 12, 2],
  ['3031', 4, 4], ['3032', 6, 4], ['3035', 8, 4], ['3030', 10, 4],
  ['3958', 6, 6], ['3036', 8, 6], ['3033', 10, 6], ['3028', 12, 6],
  ['41539', 8, 8],
]) {
  add(id, `Plate ${z} x ${x}`, `板 ${z}×${x}`, 'plate', [x, z], 1, { category: 'plate' });
}
add('2420', 'Plate 2 x 2 Corner', 'L型转角板 2×2', 'corner', [2, 2], 1, { category: 'plate' });
add('15573', 'Plate 1 x 2 with 1 Stud (Jumper)', '单凸点跳线板 1×2（半格偏移神件）', 'jumper', [2, 1], 1, { centerStuds: [[0, 0]], category: 'plate' });
add('3794b', 'Plate 1 x 2 with 1 Stud without Groove', '单凸点跳线板 1×2（旧款）', 'jumper', [2, 1], 1, { centerStuds: [[0, 0]], category: 'plate' });
add('87580', 'Plate 2 x 2 with 1 Stud (Center Jumper)', '中心单凸点跳线板 2×2', 'jumper', [2, 2], 1, { centerStuds: [[0, 0]], category: 'plate' });
add('34103', 'Plate 1 x 3 with 2 Studs', '双凸点跳线板 1×3', 'jumper', [3, 1], 1, { centerStuds: [[-0.5, 0], [0.5, 0]], category: 'plate' });

// ================================================================
// 3. 光面板与格栅 (Tiles & Grilles, h = 1 片，顶面无凸点)
// ================================================================
for (const [id, x, z] of [
  ['3070b', 1, 1], ['3069b', 2, 1], ['63864', 3, 1], ['2431', 4, 1],
  ['6636', 6, 1], ['4162', 8, 1],
  ['3068b', 2, 2], ['26603', 3, 2], ['87079', 4, 2], ['69729', 6, 2],
]) {
  add(id, `Tile ${z} x ${x}`, `平板 ${z}×${x}`, 'tile', [x, z], 1, { category: 'tile' });
}
add('2412b', 'Tile 1 x 2 Grille', '散热格栅平板 1×2', 'tile', [2, 1], 1, { grille: true, category: 'tile' });
add('14719', 'Tile 2 x 2 Corner', 'L型转角光面板 2×2', 'corner', [2, 2], 1, { tile: true, category: 'tile' });
add('98138', 'Tile Round 1 x 1', '圆形光面板 1×1', 'round', [1, 1], 1, { tile: true, category: 'tile' });
add('4150', 'Tile Round 2 x 2', '圆形光面板 2×2', 'round', [2, 2], 1, { tile: true, category: 'tile' });
add('22385', 'Tile 2 x 3 Pentagonal Shield', '五边形护盾光面板 2×3', 'tile', [2, 3], 1, { category: 'tile' });

// ================================================================
// 4. SNOT 侧凸点砖 (Side-Stud Bricks)
// 说明：sideFaces 指明哪些侧面有凸点（'+z' 正面, '-z' 背面, '+x' 右侧, '-x' 左侧）
//       车灯砖 4070 的侧凸点向内缩进 0.5 片（2 LDU = 0.8mm）
// ================================================================
add('87087', 'Brick 1 x 1 with Stud on 1 Side', '单面侧凸点砖 1×1', 'snot', [1, 1], 3, {
  sideFaces: ['+z'], sideRows: [1.75], category: 'snot',
});
add('47905', 'Brick 1 x 1 with Studs on 2 Opposite Sides', '对向双面侧凸点砖 1×1', 'snot', [1, 1], 3, {
  sideFaces: ['+z', '-z'], sideRows: [1.75], category: 'snot',
});
add('26604', 'Brick 1 x 1 with Studs on 2 Adjacent Sides', '相邻双面侧凸点砖 1×1', 'snot', [1, 1], 3, {
  sideFaces: ['+z', '+x'], sideRows: [1.75], category: 'snot',
});
add('4733', 'Brick 1 x 1 with Studs on 4 Sides (Travis Brick)', '四面侧凸点核心砖 1×1（机甲核心神件）', 'snot', [1, 1], 3, {
  sideFaces: ['+z', '-z', '+x', '-x'], sideRows: [1.75], category: 'snot',
});
add('4070', 'Brick 1 x 1 with Headlight', '车灯砖 1×1（内缩侧凸点）', 'snot', [1, 1], 3, {
  sideFaces: ['+z'], sideRows: [1.75], recessed: true, category: 'snot',
});
add('99206', 'Plate 2 x 2 x 2/3 with 2 Studs on Side', '侧面双凸点增高板 2×2×2/3（高2片）', 'snot', [2, 2], 2, {
  sideFaces: ['+z'], sideRows: [1.0], category: 'snot',
});
add('11211', 'Brick 1 x 2 x 1 2/3 with 4 Studs on 1 Side', '单面四凸点砖 1×2（高5片=2格）', 'snot', [2, 1], 5, {
  sideFaces: ['+z'], sideRows: [1.25, 3.75], category: 'snot',
});
add('22885', 'Brick 1 x 2 x 1 2/3 with 8 Studs on 2 Opposite Sides', '对向八凸点砖 1×2（高5片=2格）', 'snot', [2, 1], 5, {
  sideFaces: ['+z', '-z'], sideRows: [1.25, 3.75], category: 'snot',
});
add('30414', 'Brick 1 x 4 with 4 Studs on 1 Side', '单面四凸点砖 1×4', 'snot', [4, 1], 3, {
  sideFaces: ['+z'], sideRows: [1.75], category: 'snot',
});

// ================================================================
// 5. SNOT 倒顺支架 (Brackets —— 水平板 + 垂直侧板，无穿模实现侧面与竖向互转)
// 说明：支架自身占地为水平板 [sx, sz], h = 1 片；
//       其 +z 外侧面挂有一块厚 0.5 片 (0.2 格) 的竖直侧板，带朝向 +z 的侧凸点
// ================================================================
add('99780', 'Bracket 1 x 2 - 1 x 2 Inverted (Up)', '倒支架 1×2-1×2（向上翻，高3片）', 'bracket', [2, 1], 1, {
  dir: 'up', vRows: 1, vH: 3, sideFaces: ['+z'], sideRows: [1.75], category: 'bracket',
});
add('99781', 'Bracket 1 x 2 - 1 x 2 (Down)', '正支架 1×2-1×2（向下垂，深3片）', 'bracket', [2, 1], 1, {
  dir: 'down', vRows: 1, vH: 3, sideFaces: ['+z'], sideRows: [-1.25], category: 'bracket',
});
add('99207', 'Bracket 1 x 2 - 2 x 2 Inverted (Up)', '倒支架 1×2-2×2（向上翻4凸点，高5片）', 'bracket', [2, 1], 1, {
  dir: 'up', vRows: 2, vH: 5, sideFaces: ['+z'], sideRows: [1.25, 3.75], category: 'bracket',
});
add('44728', 'Bracket 1 x 2 - 2 x 2 (Down)', '正支架 1×2-2×2（向下垂4凸点，深5片）', 'bracket', [2, 1], 1, {
  dir: 'down', vRows: 2, vH: 5, sideFaces: ['+z'], sideRows: [-1.25, -3.75], category: 'bracket',
});
add('36840', 'Bracket 1 x 1 - 1 x 1 Inverted (Up)', '单格倒支架 1×1-1×1（向上翻）', 'bracket', [1, 1], 1, {
  dir: 'up', vRows: 1, vH: 3, sideFaces: ['+z'], sideRows: [1.75], category: 'bracket',
});
add('36841', 'Bracket 1 x 1 - 1 x 1 (Down)', '单格正支架 1×1-1×1（向下垂）', 'bracket', [1, 1], 1, {
  dir: 'down', vRows: 1, vH: 3, sideFaces: ['+z'], sideRows: [-1.25], category: 'bracket',
});

// ================================================================
// 6. 斜面砖、奶酪斜坡与倒斜面砖 (Slopes, Cheese Slopes & Inverted Slopes)
// 本地 +z 为斜面下坡方向（正面），凸点只在后排 (k = 0)
// ================================================================
add('54200', 'Slope 30 1 x 1 x 2/3 (Cheese Slope)', '奶酪小斜坡 30° 1×1（高2片，无凸点）', 'cheese', [1, 1], 2, { category: 'slope' });
add('85984', 'Slope 30 1 x 2 x 2/3', '小斜坡 30° 1×2（高2片，无凸点）', 'cheese', [2, 1], 2, { category: 'slope' });
for (const [id, x, chk] of [['3040b', 1, true], ['3039', 2, true], ['3038', 3, false], ['3037', 4, true], ['4286', 1, true], ['3298', 2, true], ['3297', 4, true]]) {
  const deg = ['4286', '3298', '3297'].includes(id) ? 33 : 45;
  const d = deg === 33 ? 3 : 2;
  add(id, `Slope Brick ${deg} ${d} x ${x}`, `斜面砖 ${deg}° ${d}×${x}`, 'slope', [x, d], 3, {
    ldrawOrigin: [0, 3, -0.5], checked: chk, category: 'slope',
  });
}
add('60481', 'Slope Brick 65 2 x 1 x 2', '高斜面砖 65° 2×1×2（高6片）', 'slope', [1, 2], 6, { category: 'slope' });
add('3678b', 'Slope Brick 65 2 x 2 x 2', '高斜面砖 65° 2×2×2（高6片）', 'slope', [2, 2], 6, { category: 'slope' });
add('3684c', 'Slope Brick 75 2 x 2 x 3', '高斜面砖 75° 2×2×3（高9片）', 'slope', [2, 2], 9, { category: 'slope' });
add('92946', 'Slope 45 2 x 1 with 2/3 Cutout', '带切口斜面砖 45° 1×2（高3片）', 'slope', [1, 2], 3, { category: 'slope' });
add('3043', 'Slope Brick 45 2 x 2 Double', '双面斜砖 45° 2×2（屋脊）', 'ridge', [2, 2], 3, { checked: false, category: 'slope' });
add('3041', 'Slope Brick 45 2 x 4 Double', '双面斜砖 45° 2×4（屋脊）', 'ridge', [4, 2], 3, { category: 'slope' });
add('3665', 'Slope Brick 45 2 x 1 Inverted', '倒斜面砖 45° 2×1（底面仅后排有孔，顶面2凸点）', 'islope', [1, 2], 3, { category: 'slope' });
add('3660', 'Slope Brick 45 2 x 2 Inverted', '倒斜面砖 45° 2×2（底面仅后排有孔，顶面4凸点）', 'islope', [2, 2], 3, { category: 'slope' });

// ================================================================
// 7. 弧面斜砖与拱门 (Curved Slopes & Arches)
// ================================================================
add('11477', 'Slope Curved 2 x 1 No Studs', '弧面斜坡 1×2（高2片，无凸点）', 'cslope', [1, 2], 2, { category: 'cslope' });
add('15068', 'Slope Curved 2 x 2 No Studs', '弧面斜坡 2×2（高2片，无凸点）', 'cslope', [2, 2], 2, { category: 'cslope' });
add('47457', 'Slope Curved 2 x 2 x 1 with 2 Studs', '弧面斜砖 2×2×1（高3片）', 'cslope', [2, 2], 3, { backStuds: true, category: 'cslope' });
add('93273', 'Slope Curved 4 x 1 Double No Studs', '双头弧面斜坡 1×4（高2片）', 'cslope', [1, 4], 2, { category: 'cslope' });
add('61678', 'Slope Curved 4 x 1 No Studs', '长弧面斜坡 1×4（高2片）', 'cslope', [1, 4], 2, { category: 'cslope' });
add('6091', 'Brick Curved Top 1 x 2 x 1 1/3', '弧顶砖 1×2（高4片，后排单凸点）', 'cslope', [1, 2], 4, { backStuds: true, category: 'cslope' });
add('3659', 'Brick Arch 1 x 4', '拱门砖 1×4（高3片）', 'arch', [4, 1], 3, { category: 'cslope' });
add('6182', 'Brick Arch 1 x 4 x 2', '高拱门砖 1×4×2（高6片）', 'arch', [4, 1], 6, { category: 'cslope' });
add('3307', 'Brick Arch 1 x 6', '长拱门砖 1×6（高3片）', 'arch', [6, 1], 3, { category: 'cslope' });

// ================================================================
// 8. 楔形翼板 (Wedge Plates, h = 1 片)
// ================================================================
add('24299', 'Wedge Plate 2 x 2 Left', '左楔形翼板 2×2', 'wedge', [2, 2], 1, { side: 'L', category: 'wedge' });
add('24307', 'Wedge Plate 2 x 2 Right', '右楔形翼板 2×2', 'wedge', [2, 2], 1, { side: 'R', category: 'wedge' });
add('43723', 'Wedge Plate 3 x 2 Left', '左楔形翼板 2×3', 'wedge', [2, 3], 1, { side: 'L', category: 'wedge' });
add('43722', 'Wedge Plate 3 x 2 Right', '右楔形翼板 2×3', 'wedge', [2, 3], 1, { side: 'R', category: 'wedge' });
add('41770', 'Wedge Plate 4 x 2 Left', '左楔形翼板 2×4', 'wedge', [2, 4], 1, { side: 'L', category: 'wedge' });
add('41769', 'Wedge Plate 4 x 2 Right', '右楔形翼板 2×4', 'wedge', [2, 4], 1, { side: 'R', category: 'wedge' });
add('54384', 'Wedge Plate 6 x 3 Left', '左大楔形机翼 3×6', 'wedge', [3, 6], 1, { side: 'L', category: 'wedge' });
add('54383', 'Wedge Plate 6 x 3 Right', '右大楔形机翼 3×6', 'wedge', [3, 6], 1, { side: 'R', category: 'wedge' });

// ================================================================
// 9. 圆柱、圆锥、穹顶与雷达碟 (Rounds, Cones, Domes & Dishes)
// ================================================================
add('4073', 'Plate Round 1 x 1', '圆板 1×1', 'round', [1, 1], 1, { category: 'round' });
add('85861', 'Plate Round 1 x 1 with Open Stud', '空心圆板 1×1', 'round', [1, 1], 1, { category: 'round' });
add('4032', 'Plate Round 2 x 2', '圆板 2×2', 'round', [2, 2], 1, { category: 'round' });
add('18674', 'Plate Round 2 x 2 with 1 Center Stud', '中心单凸点圆跳线板 2×2', 'round', [2, 2], 1, { centerStuds: [[0, 0]], category: 'round' });
add('2654', 'Plate Round 2 x 2 with Rounded Bottom', '弧底滑移圆板 2×2', 'round', [2, 2], 1, { tile: true, category: 'round' });
add('3062b', 'Brick Round 1 x 1 Open Stud', '圆砖 1×1（竖纹柱）', 'round', [1, 1], 3, { fluted: true, category: 'round' });
add('3941', 'Brick Round 2 x 2', '圆砖 2×2', 'round', [2, 2], 3, { category: 'round' });
add('87081', 'Brick Round 4 x 4', '大圆砖 4×4', 'round', [4, 4], 3, { category: 'round' });
add('4589b', 'Cone 1 x 1', '圆锥 1×1（高3片）', 'cone', [1, 1], 3, { category: 'round' });
add('3942c', 'Cone 2 x 2 x 2', '大圆锥 2×2×2（高6片）', 'cone', [2, 2], 6, { category: 'round' });
add('553b', 'Brick Round 2 x 2 Dome Top', '半球穹顶 2×2（高3片，无凸点）', 'dome', [2, 2], 3, { category: 'round' });
add('4740', 'Dish 2 x 2 Inverted (Radar)', '雷达圆碟 2×2', 'dish', [2, 2], 2, { category: 'round' });
add('3960', 'Dish 4 x 4 Inverted (Radar)', '大雷达圆碟 4×4', 'dish', [4, 4], 2, { category: 'round' });

// ================================================================
// 10. 把柄、夹子、合页与球头关节 (Bars, Clips, Hinges & Ball Joints)
// ================================================================
add('48336', 'Plate 1 x 2 with Handle on Side', '带侧把柄板 1×2（封闭端）', 'barplate', [2, 1], 1, { category: 'hinge' });
add('2540', 'Plate 1 x 2 with Handle on Side (Free Ends)', '开放式侧把柄板 1×2', 'barplate', [2, 1], 1, { category: 'hinge' });
add('60478', 'Plate 1 x 2 with Handle on End', '端头把柄板 1×2', 'barplate', [1, 2], 1, { category: 'hinge' });
add('3839b', 'Plate 1 x 2 with Handles on Ends', '双端把柄板 1×2', 'barplate', [1, 2], 1, { bothEnds: true, category: 'hinge' });
add('26047', 'Plate Round 1 x 1 with Handle', '带单把柄圆板 1×1', 'barplate', [1, 1], 1, { category: 'hinge' });
add('60470', 'Plate 1 x 2 with Horizontal Clips', '侧边双水平夹板 1×2', 'clip', [2, 1], 1, { category: 'hinge' });
add('11476', 'Plate 1 x 2 with Horizontal Clip on Side', '侧边单水平夹板 1×2', 'clip', [2, 1], 1, { singleClip: true, category: 'hinge' });
add('63868', 'Plate 1 x 2 with Clip on End', '端头单水平夹板 1×2（机翼底孔反扣高频件）', 'clip', [1, 2], 1, { endClip: true, category: 'hinge' });
add('44301', 'Hinge Plate 1 x 2 Locking with 1 Finger on End', '棘轮合页板 1×2（单指端）', 'clip', [1, 2], 1, { category: 'hinge' });
add('44302', 'Hinge Plate 1 x 2 Locking with 2 Fingers on End', '棘轮合页板 1×2（双指端）', 'barplate', [1, 2], 1, { category: 'hinge' });
add('2429c01', 'Hinge Plate 1 x 4 Swivel Complete', '水平旋转合页板 1×4', 'plate', [4, 1], 1, { category: 'hinge' });
add('4085d', 'Plate 1 x 1 with Vertical Clip', '带竖直夹板 1×1', 'clip', [1, 1], 1, { category: 'hinge' });
add('4081b', 'Plate 1 x 1 with Light Ring', '带圆环扣板 1×1', 'clip', [1, 1], 1, { category: 'hinge' });
add('15712', 'Plate 1 x 1 with Top Clip', '顶面带夹板 1×1', 'clip', [1, 1], 1, { category: 'hinge' });
add('30237', 'Brick 1 x 2 with Vertical Clip', '带侧竖夹砖 1×2', 'clip', [2, 1], 3, { singleClip: true, category: 'hinge' });
add('14417', 'Plate 1 x 2 with Towball on Side', '带侧球头板 1×2', 'barplate', [2, 1], 1, { category: 'hinge' });
add('14418', 'Plate 1 x 2 with Towball Socket', '带球窝夹板 1×2', 'clip', [2, 1], 1, { singleClip: true, category: 'hinge' });
add('87994', 'Bar 3L', '3格长光剑杆/连接杆（高9片）', 'bar', [1, 1], 9, { category: 'hinge' });
add('30374', 'Bar 4L (Lightsaber Blade)', '4格长光剑杆（高12片）', 'bar', [1, 1], 12, { category: 'hinge' });

// ================================================================
// 11. 门窗、挡板与围栏 (Doors, Windows, Panels & Fences)
// ================================================================
add('60596', 'Door 1 x 4 x 6 Frame', '门框 1×4×6', 'doorframe', [4, 1], 18, { category: 'building' });
add('60623', 'Door 1 x 4 x 6 with 4 Panes and Stud Handle', '门 1×4×6（四格窗）', 'door', [4, 1], 18, {
  occupies: false, ldrawOrigin: [-1.6, 18, -0.25], hinge: { pivot: [-1.6, 0, -0.25], axis: [0, 1, 0] },
  note: '与门框使用相同的 at/rot；门轴在门框背面左侧', category: 'building',
});
add('60592', 'Window 1 x 2 x 2 Frame', '窗框 1×2×2（高6片）', 'doorframe', [2, 1], 6, { category: 'building' });
add('60594', 'Window 1 x 4 x 3 Frame', '窗框 1×4×3（高9片）', 'doorframe', [4, 1], 9, { category: 'building' });
add('4865b', 'Panel 1 x 2 x 1', 'U型挡板 1×2×1（高3片）', 'panel', [2, 1], 3, { category: 'building' });
add('4864b', 'Panel 1 x 2 x 2', '高挡板 1×2×2（高6片）', 'panel', [2, 1], 6, { category: 'building' });
add('3633', 'Fence 1 x 4 x 1', '围栏 1×4×1（高3片）', 'panel', [4, 1], 3, { category: 'building' });

// ================================================================
// 12. 科技孔砖与插销 (Technic Bricks & Pins)
// ================================================================
add('6541', 'Technic Brick 1 x 1 with Hole', '科技单孔砖 1×1', 'technic', [1, 1], 3, { holes: 1, category: 'technic' });
add('3700', 'Technic Brick 1 x 2 with Hole', '科技单孔砖 1×2', 'technic', [2, 1], 3, { holes: 1, category: 'technic' });
add('32000', 'Technic Brick 1 x 2 with 2 Holes', '科技双孔砖 1×2', 'technic', [2, 1], 3, { holes: 2, category: 'technic' });
add('3701', 'Technic Brick 1 x 4 with 3 Holes', '科技三孔砖 1×4', 'technic', [4, 1], 3, { holes: 3, category: 'technic' });
add('3894', 'Technic Brick 1 x 6 with 5 Holes', '科技五孔砖 1×6', 'technic', [6, 1], 3, { holes: 5, category: 'technic' });
add('3176', 'Plate 3 x 2 with Hole', '带圆孔半圆耳板 2×3（前/后伸出圆孔耳）', 'pinplate', [2, 2], 1, { category: 'technic' });
add('2444', 'Plate 2 x 2 with Pin Hole', '带销孔连接板 2×2', 'pinplate', [2, 2], 1, { category: 'technic' });
add('18677', 'Plate 1 x 2 with Pin Hole Underneath', '底面带销孔板 1×2', 'plate', [2, 1], 1, { category: 'technic' });
add('4274', 'Technic Pin 1/2 with Stud', '带凸点半长蓝销 1×1', 'round', [1, 1], 1, { category: 'technic' });

for (const v of Object.values(P)) {
  if (!v.ldrawOrigin) v.ldrawOrigin = [0, v.h, 0];
  if (v.checked === undefined) v.checked = true;
}

const out = {
  format: 'brickbuild-catalog',
  version: '0.2',
  units: {
    stud: '1 格 = 8.0 mm（LDraw 20 LDU）',
    plate: '1 层/片 = 3.2 mm（LDraw 8 LDU = 0.4 格）',
    brick: '1 砖高 = 3 片 = 9.6 mm（LDraw 24 LDU = 1.2 格；5 片 = 2 格）',
  },
  note: 'size=[沿本地 x 的格数, 沿本地 z 的格数]（与 LDraw 零件的 X/Z 一致）；h=高度（片）；ldrawOrigin=LDraw 原点在本地坐标中的位置；sideFaces/sideRows=SNOT 侧面凸点所在面与层高；dir/vH=支架竖板方向与高度',
  parts: P,
};

fs.writeFileSync(new URL('./parts.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(Object.keys(P).length, 'parts generated');
