# catalog/ldraw —— LDraw 官方零件库素材镜像

本目录是从 **LDraw.org 官方零件库**下载的权威零件几何素材，供零件识别核对、
尺寸校准与（后续）精确几何建模使用。`catalog-fetch` 一条命令即可重建本目录。

- 来源：`https://library.ldraw.org/library/official`
- 许可：**CC BY 2.0**（`https://library.ldraw.org/license`；再分发需署名 LDraw.org，
  部分文件文件头标注 CC BY 4.0，以各文件头为准）
- 快照时间：见 `manifest.json` 的 `fetchedAt`；每个文件的 SHA-256 在 `manifest.json` 中登记

## 目录结构

```
parts/<编号>.dat      主零件几何（165 种目录零件 + 被直接引用的官方变体）
parts/s/*.dat         子零件（零件内部的共用几何块）
p/*.dat               几何基元（含 8\、48\ 高精度子目录）
manifest.json         来源、许可、快照时间、全部文件的 SHA-256 与字节数
verification.json     catalog/parts.json 与官方几何的逐件尺寸核对报告
```

## 用法

```bash
# 重建/更新素材库（大批量时强烈建议走整库镜像，单文件直连会被官方库限流）
curl -o complete.zip https://library.ldraw.org/library/updates/complete.zip   # 约 140 MB
unzip -q complete.zip -d ldraw-mirror
node cli/brickkit.mjs catalog-fetch --mirror "$(pwd)/ldraw-mirror/ldraw"
#   无镜像时也可直接 node cli/brickkit.mjs catalog-fetch（限速直连，慢）

# 整库安装（约 2.5 万种零件 + 基元，602 MB / 3.7 万文件，.gitignore 不入库）
node cli/brickkit.mjs catalog-fetch --full --mirror "$(pwd)/ldraw-mirror/ldraw"
#   安装到 catalog/ldraw-full/，catalog-verify 与后续核对工具会自动将其作为二级解析源

# 用官方几何核对目录定义（写入 verification.json；有硬冲突时退出码 1）
node cli/brickkit.mjs catalog-verify --pretty

# 生成零件预览图库（渲染自 .dat：out/ldraw-gallery/<编号>.svg 每件一张 + index.html 离线画廊）
node tools/ldraw-gallery.mjs            # 加 --screenshot 出视觉自检截图（需 CHROMIUM_PATH）
```

## 核对结论（2026-10-24 快照，165/165 零件已核对）

`catalog-verify` 把每个零件的官方几何实测 LDU 尺寸（1 格 = 20 LDU，1 片 = 8 LDU，
顶点沿引用矩阵链精确变换）与 `catalog/parts.json` 逐件对照，分类：

| 分类 | 数量 | 含义 |
|---|---|---|
| match | 26 | 官方实测与目录完全一致 |
| stud-offset | 93 | 仅 y 多 4 LDU = 顶部凸点，实体占位一致（可解释） |
| protrudes | 16 | 官方实体超出网格（把柄/夹口/侧凸点等真实突出） |
| smaller | 4 | 官方实体小于网格（杆件、门叶等） |
| feature-explained | 21 | 夹板/把柄/支架垂片/销孔类零件的高度差，目录按网格占位建模所致 |
| **height-error（硬冲突）** | **5** | **目录定义与官方几何矛盾，必须修正** |

硬冲突清单（`verification.json` 中含官方文件头描述作为证据）：

| 编号 | 目录定义 | 官方事实（文件头 + 实测） |
|---|---|---|
| `11211` | 高 5 片、单面 4 凸点 | "Brick 1 x 2 with **Two** Studs on One Side"，实测高 28 LDU = 3 片 + 凸点 |
| `3307` | 拱门砖 1×6，高 3 片 | "Arch 1 x 6 **x 2**"，实测高 52 LDU ≈ 6 片 |
| `61678` | 弧面斜坡 1×4，高 2 片 | "Slope Brick Curved 4 x 1"，实测高 24 LDU = 1 砖 |
| `47457` | 弧面斜砖 2×2×1，高 3 片 | "Slope Brick Curved 2 x 2 x **2/3** Triple"，实测高 20 LDU = 2 片 + 凸点 |
| `4740` | 雷达圆碟 2×2，高 2 片 | "Dish 2 x 2 Inverted"，实测高 12 LDU（碟体 1 片 + 底部凸点） |

别名映射（`src/ldraw/ldraw.js` `OFFICIAL_ALIASES`；仅是文件名映射，**不代表零件识别确认**）：

| 目录编号 | 官方文件 | 备注 |
|---|---|---|
| `553b` | `30367a` | 官方经 ~Moved to 重定向；穹顶 2×2（另有机轴孔变体 `30367b`，全量镜像可得） |
| `4085d` | `4085b` | 官方只有 4085b（薄 U 夹）/4085c（厚 U 夹），模具变体待实物核对 |
| `4589b` | `4589` | 官方无 4589b，圆锥 1×1 |

全量镜像（`catalog/ldraw-full/`）中已确认存在、重建核对要用的官方文件（2026-10-24）：

| 编号 | 官方描述 | 关联需求 |
|---|---|---|
| `60470b` | Plate 1 x 2 with 2 Clips Horizontal (Thick C-Clips) | 翼根双夹板候选；证实为双厚 C 夹而非两个侧凸点 |
| `63868` | Plate 1 x 2 with Clip Horizontal on End (Thick C-Clip) | 机翼底孔反扣高频件（已引用） |
| `22885` | Brick 1 x 2 x 1.667 with Studs on **1** Side | 官方头描述证实单面凸点，目录"对向八凸点"命名有误 |
| `30367b` | Cylinder 2 x 2 with Dome Top with Axle Hole and Blocked Stud | 顶部圆件底部接口候选 |
| `4085c` | Plate 1 x 1 with Clip Vertical (Thick U-Clip) | 竖夹模具变体候选 |
| `3839b` | Plate 1 x 2 with Handles Type 2 | 两侧把柄板候选（已引用） |

> 注意：修正以上目录定义会改变既有模型的 snap/占位坐标，须与机甲重建
> （`docs/实物机甲验收目标.md` 推进次序第 2、3 步）联动进行，不要只改目录。
