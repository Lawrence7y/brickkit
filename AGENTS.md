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
   - 肉眼比对之外，用 `brickkit diff` 做数值对账：`overall.score ≥ 0.6` 为达标门槛，不达标按逐张分数迭代（用法见 SOP）。

---

## 二、重建工作流 SOP（按复杂度二选一）

- **简单路径**：无 SNOT 侧装、无可开合机关的纯堆叠模型。
- **完整路径**：含 SNOT/转接机构、可开合机关或子组件的复杂模型。

### 简单路径（照片清单 → builder 搭建 → validate → diff 达标 → 导出）

1. **照片清单**：同完整路径第 1 步，`check-photos` 返回 `complete: true`。
2. **用 `src/core/builder.js` 写搭建脚本生成 `.brick.json`**（禁止手写 JSON 坐标）：
   ```js
   import fs from 'node:fs';
   import { createBuilder } from '../src/core/builder.js';
   const catalog = JSON.parse(fs.readFileSync('catalog/parts.json', 'utf8'));
   const b = createBuilder({ catalog, meta: { name: '模型名', front: '+z' } });
   const base = b.add('3001', 0, { at: [0, 0, 0], step: 1 });  // 无 on：显式整数格 at
   b.add('3001', 0, { on: base.id, stud: 0, step: 2 });        // 有 on：snapPart 自动算坐标，禁止再传 at
   b.assert();                                                  // 校验有 errors 即抛错（附前 3 条）
   b.save('examples/model.brick.json');
   ```
   每次 `add` 自动检查零件编号/颜色在目录、3D 穿模（报对方 id）、id 重复，违反即抛中文错误；完整用法见 `src/core/builder.js` 文件头注释。
3. **静态校验**：`node cli/brickkit.mjs validate examples/model.brick.json --photos examples/model.photos.json --pretty`，必须 `ok: true`、零 errors 零 warnings。
4. **数值对账 → 迭代 → 导出**：
   ```bash
   node cli/brickkit.mjs diff examples/model.brick.json --photos examples/model.photos.json --dir <照片目录> --out-dir out/model-diff --pretty
   # 退出码 0 = overall.score ≥ 0.6（达标）；1 = 低于 0.6，按 report.json 逐张分数定位最差照片，改搭建脚本重新生成后重跑
   ```
   - **0.6 数值门槛**：`overall.score ≥ 0.6` 才算通过（逐张指标与权重见下一条 joint 公式）。分数最低的照片对应最该先修的部位；照片背景杂乱会系统性压低 IoU，掩膜 degraded 的照片（椭圆保底）在总分中自动降权 0.3，对比时应看逐次迭代的分数趋势。
   - diff 新指标（默认 `--mode joint` 联合标定）：`structureSim` 色块结构相似度（16×16 网格众数粗色类一致率，同轮廓不同内部结构在此拉开差距）、全组共享 yaw 偏移的联合标定（压制逐照片择优虚高）与 0.10×未归一 IoU 比例惩罚项（整体偏长偏瘦由它扣分），joint 总分 = 0.35 IoU + 0.15 长宽比 + 0.20 颜色 + 0.20 色块结构 + 0.10 rawIoU；`--mode sweep|fixed` 分别保留旧逐照片择优公式 / 仅清单姿态批量变体筛选。
   - 观察清单对账：`node cli/brickkit.mjs check-observations examples/model.observations.json --model examples/model.brick.json`，把「照片里看到什么」（inventory 候选零件×颜色×数量区间）与模型 BOM 数值对账——数量超区间出 warning、整类缺失出 error，专抓轮廓 IoU 看不见的数量/颜色错误。
   - 机位存疑先标定：`node cli/brickkit.mjs calibrate examples/model.brick.json --photos examples/model.photos.json --photo <照片id> --dir <照片目录>`；`best.az` 与清单标注 `azimuth` 相差超过 15° 时，优先怀疑机位标注或模型整体朝向，而不是逐个改零件。
   - 达标后导出：同完整路径第 6 步。

### 完整路径（六步）

### 第 1 步：整理照片清单并检查机位完整性
1. 读取用户照片目录中的全部图片，识别每张照片的方位角 `azimuth`（`0°` 正、`90°` 右、`180°` 背、`270°` 左）、俯仰角 `elevation` 以及是否为局部拆解照片（`interior` / `module` / `detail`）。
2. 创建 `photos.json` 并运行检查：
   ```bash
   node cli/brickkit.mjs check-photos examples/model.photos.json --dir <照片目录> --pretty
   ```

### 第 2 步：检索 165 种内置零件与颜色表
在动笔写模型前，先用 CLI 查清所需零件编号与真实尺寸（切勿猜测编号）：
```bash
node cli/brickkit.mjs catalog          # 列出全部 12 大类 165 种零件
node cli/brickkit.mjs catalog snot     # 查侧凸点核心砖 (87087, 4733, 11211, 22885, 99206...)
node cli/brickkit.mjs catalog bracket  # 查正/倒转接支架 (99780, 99781, 99207, 36840...)
node cli/brickkit.mjs catalog hinge    # 查把柄与夹板 (48336, 60478, 63868 端头夹板, 60470, 44301...)
node cli/brickkit.mjs catalog wedge    # 查左右楔形机翼 (41769, 41770, 24299, 24307...)
node cli/brickkit.mjs colors           # 查 LDraw 颜色代码表
node cli/brickkit.mjs catalog-verify   # 用官方 LDraw 几何核对目录尺寸（硬冲突清单见 catalog/ldraw/README.md）
```
`catalog/ldraw/` 内置 LDraw 官方零件库素材镜像（165 种零件的 .dat 权威几何 + manifest + 核对报告，CC BY 2.0）；
核对零件真实外形与接口时优先查那里的官方几何，`catalog-fetch` 可重建/更新（详见 `catalog/ldraw/README.md`）。
已知目录硬冲突（11211/3307/61678/47457/4740）在修正并联动重建模型前，不要在模型中沿用其旧定义。

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

肉眼比对后追加数值闭环：`node cli/brickkit.mjs diff examples/model.brick.json --photos examples/model.photos.json --dir <照片目录> --out-dir out/model-diff --pretty`，`overall.score ≥ 0.6` 为达标门槛，不达标按 `report.json` 逐张分数迭代模型后重跑（详见简单路径第 4 步）。

### 第 6 步：导出单文件 3D 查看器、A4 拼装图纸 PDF 与 LDraw 文件
```bash
node build.mjs
node cli/brickkit.mjs viewer examples/model.brick.json -o out/model.viewer.html
node cli/brickkit.mjs booklet examples/model.brick.json -o out/model.booklet.pdf
node cli/brickkit.mjs export-ldraw examples/model.brick.json -o out/model.mpd
```

---

## 三、参考文档
- [docs/乐高拼插与防穿模规范.md](docs/乐高拼插与防穿模规范.md)：5:2 几何定律、三大拼插铁律、三大复杂机构范式与 165 种零件分类表
- [docs/数据格式.md](docs/数据格式.md)：`.brick.json` 与 `.photos.json` 字段定义
- [docs/拍摄规范.md](docs/拍摄规范.md)：用户拍摄引导规范
