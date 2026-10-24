---
name: brickkit
description: 将乐高实物模型的多角度照片转化为可 360° 交互旋转、分层/分模块爆炸展示、可开合机关演示的单文件 3D 网页 (.viewer.html) 与 A4 横版拼装图纸 (.booklet.pdf)。
---

# BrickKit：多角度乐高实物照片 → 3D 模型、爆炸图与拼装图纸

当用户提供一组乐高实物照片并希望重建 3D 模型、生成交互式网页或打印级 A4 拼装说明书时，请严格遵循本技能规范。

---

## 一、核心原则（三大红线）

1. **零穿模硬约束（Zero 3D Interpenetration）**
   - 任何两颗零件在三维空间中的实体包围盒（`partBoxes`）绝不允许穿透重叠。
   - **SNOT 层级铁律**：直接扣在侧凸点砖（如 `11211`、`4733`、`87087`）外壁上的**第一层侧装件必须设 `snot: 0`**；叠在第一层侧装板（厚 1 片）凸点上的**第二层侧装件必须设 `snot: 1`**（每向外叠 1 片，`snot` 加 1）。
2. **凸点扣底孔硬约束（Stud-to-AntiStud Lock）**
   - 严禁手算或捏造悬空小数坐标。遇到侧装或转接结构时，优先运行 `node cli/brickkit.mjs studs` 与 `node cli/brickkit.mjs snap` 自动计算精确扣合坐标。
   - 严禁把朝上（`up: "+y"`）的圆柱或斜砖直接插进朝前（`up: "+z"`）的竖板表面；方向转换必须通过 **SNOT 侧凸点砖（`4733`/`11211`/`87087`）**、**倒顺支架（`99780`/`99781`/`36840`）** 或 **外挑水平托板（`3023`）**。
3. **四向正交视觉对账（Orthogonal Reprojection Loop）**
   - 初稿通过 `validate` 后，**必须**使用 `brickkit render` 渲染 `--az 0`（正）、`--az 180`（背）、`--az 270`（左）、`--az 90`（右）四张平视正交图，并与用户的实拍照片逐角度比对：
     - 注意相机坐标系：在 `--az 0` 正视图中，世界坐标 **`-x` 在画面左侧**，**`+x` 在画面右侧**；在 `--az 180` 背视图中相反。

---

## 二、标准六步重建工作流（SOP）

### 第 1 步：整理照片清单并检查机位完整性
1. 读取用户照片目录中的全部图片，识别每张照片的方位角 `azimuth`（`0°` 正、`90°` 右、`180°` 背、`270°` 左）、俯仰角 `elevation` 以及是否为局部拆解照片（`interior` / `module` / `detail`）。
2. 创建 `photos.json` 并运行检查：
   ```bash
   node cli/brickkit.mjs check-photos examples/model.photos.json --dir <照片目录> --pretty
   ```

### 第 2 步：检索 152 种内置零件与颜色表
在动笔写模型前，先用 CLI 查清所需零件编号与真实尺寸（切勿猜测编号）：
```bash
node cli/brickkit.mjs catalog          # 列出全部 12 大类 152 种零件
node cli/brickkit.mjs catalog snot     # 查侧凸点核心砖 (87087, 4733, 11211, 22885...)
node cli/brickkit.mjs catalog bracket  # 查正/倒转接支架 (99780, 99781, 99207, 36840...)
node cli/brickkit.mjs catalog wedge    # 查左右楔形机翼 (41769, 41770, 24299, 24307...)
node cli/brickkit.mjs colors           # 查 LDraw 颜色代码表
```

### 第 3 步：自底向上、由内向外搭建无穿模骨架
1. 先搭建底座与中央核心骨架（Step 1 ~ Step 6），每写完一个模块就运行一次：
   ```bash
   node cli/brickkit.mjs validate examples/model.brick.json --pretty
   ```
2. 需要将侧甲、机翼或装饰件扣到核心砖上时，使用 `studs` 和 `snap` 获取精确无穿模坐标：
   ```bash
   # 1) 查看核心砖 p13 的所有可用凸点编号与世界坐标
   node cli/brickkit.mjs studs examples/model.brick.json p13 --pretty
   # 2) 计算将 2×6 板 (3795) 的第 4 号底孔扣到 p13 的第 2 号侧凸点上的精确坐标
   node cli/brickkit.mjs snap examples/model.brick.json --parent p13 --stud 2 --part 3795 --receptor 4 --pretty
   ```

### 第 4 步：物理与结构静态校验（零错误、零穿模）
```bash
node cli/brickkit.mjs validate examples/model.brick.json --photos examples/model.photos.json --pretty
```
必须确保返回 `"ok": true`、`"errors": []`、`"warnings": []`（零 3D 穿模、零悬空、步骤支撑顺序完全合法）。

### 第 5 步：无头渲染四向正交图并与实拍照片逐一比对
```bash
node cli/brickkit.mjs render examples/model.brick.json -o out/front.png --az 0 --el 5 --w 900 --h 1000
node cli/brickkit.mjs render examples/model.brick.json -o out/back.png  --az 180 --el 5 --w 900 --h 1000
node cli/brickkit.mjs render examples/model.brick.json -o out/left.png  --az 270 --el 5 --w 900 --h 1000
node cli/brickkit.mjs render examples/model.brick.json -o out/right.png --az 90 --el 5 --w 900 --h 1000
```
用视觉工具同时打开渲染图与对应角度的实拍图，逐项核对：
- 零件横竖朝向是否一致（例如机翼是水平外掠还是竖立、圆砖是竖立还是横伸）；
- 左右颜色是否镜像反了（记住 `--az 0` 正面图中 `-x` 在左、`+x` 在右）；
- 是否有任何零件边缘发生穿模或重影。

### 第 6 步：导出单文件 3D 查看器、A4 拼装图纸 PDF 与 LDraw 文件
```bash
node build.mjs
node cli/brickkit.mjs viewer examples/model.brick.json -o out/model.viewer.html
node cli/brickkit.mjs booklet examples/model.brick.json -o out/model.booklet.pdf
node cli/brickkit.mjs export-ldraw examples/model.brick.json -o out/model.mpd
```

---

## 三、参考文档
- [docs/乐高拼插与防穿模规范.md](docs/乐高拼插与防穿模规范.md)：5:2 几何定律、三大拼插铁律与 152 种零件分类表
- [docs/数据格式.md](docs/数据格式.md)：`.brick.json` 与 `.photos.json` 字段定义
- [docs/拍摄规范.md](docs/拍摄规范.md)：用户拍摄引导规范
