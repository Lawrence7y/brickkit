# BrickKit

**把自己拼的乐高实物模型（多角度照片）整理成可交互的 3D 拼装演示、爆炸图和乐高风格拼装图纸。**

> **在线演示**：
> - **示例 1 · 林间小屋**：[3D 交互展示](https://lawrence7y.github.io/brickkit/) ｜ [乐高风格拼装图纸（`#view=book`）](https://lawrence7y.github.io/brickkit/#view=book)
> - **示例 2 · 四翼重装侦察机甲塔（实物照片重建）**：[3D 交互展示](https://lawrence7y.github.io/brickkit/mecha.html) ｜ [乐高风格拼装图纸（`#view=book`）](https://lawrence7y.github.io/brickkit/mecha.html#view=book)

BrickKit 定义了一套数据格式（`brickbuild` 0.2）、照片拍摄规范、校验工具和单文件网页查看器，并提供输出 JSON 的命令行，方便 AI 智能体（Harness）接入：智能体负责“看照片 → 写数据”，BrickKit 负责“校验 → 渲染对比 → 展示 → 出图纸”。

![3D 展示](docs/images/3d.png)

| 爆炸图 · 按层级 | 爆炸图 · 按模块 |
|---|---|
| ![按层级](docs/images/explode-layer.png) | ![按模块](docs/images/explode-module.png) |

| 拼装图纸 · 子组件装配页 | 可开合设计 |
|---|---|
| ![装配页](docs/images/booklet-attach.png) | ![可开合](docs/images/mechanism.png) |

![拼装图纸 PDF](docs/images/booklet-pages.png)

---

## 功能

**3D 展示**（白色简洁风格）
- 逐步播放拼装过程（←/→ 切换，空格播放），新零件从上方落下；子组件单独在旁边拼好，装配步整体落到主体上。
- 爆炸图两种模式：**按层级**（按高度分层拉开）/ **按模块**（按 `modules[].explode` 整体移开，支持父子模块叠加）。
- 模块列表点击高亮；可开合设计（合页 / 滑动 / 可取下）用滑块开合。
- 零件清单、存疑零件标记、“数据与校验”面板；可拖入任意 `.brick.json` 打开。

**拼装图纸**（乐高说明书风格）
- 封面 → 每步一页（大步骤号、本步零件 callout “n×”）→ 子组件步骤放进“子组件”框 → 装配页（子组件缩略图 + 装配箭头）→ 可开合设计页 → 零件清单。
- 可选“淡化已拼好的部分”；A4 横版，浏览器直接打印 / 存为 PDF，或用命令行 `booklet` 生成。
- 示例输出：[`out/cottage.booklet.pdf`](out/cottage.booklet.pdf)（18 页）。

**数据与校验**
- 零件 / 颜色用 LDraw 编号；校验重叠、悬空、步骤顺序（每一步零件都要有支撑）、模块、子组件、可开合设计、证据照片。
- 导出 LDraw；有子组件时导出 MPD，可在 Studio / LeoCAD / LPub3D 打开。

---

## 快速开始

需要 Node.js 18+。

```bash
npm install                      # three、esbuild、playwright
node build.mjs                   # 打包 dist/viewer.html
open dist/viewer.html            # 直接双击也可以；内嵌示例模型“林间小屋”
```

`dist/viewer.html` 是完全自包含的单文件，可以直接发给别人或放到任何静态网站上。地址加 `#view=book` 直接打开拼装图纸。

命令行（需要 Chromium 的命令会自动查找系统 Chromium，或设置 `CHROMIUM_PATH`；也可以运行 `npx playwright install chromium`）：

```bash
node cli/brickkit.mjs validate examples/cottage.brick.json --photos examples/cottage.photos.json --pretty
node cli/brickkit.mjs booklet  examples/cottage.brick.json -o out/cottage.booklet.pdf
node cli/brickkit.mjs render   examples/cottage.brick.json -o out/explode.png --explode 100 --emode module
```

---

## 命令行

所有命令输出 JSON（加 `--pretty` 美化）；退出码 `0` 通过、`1` 有问题、`2` 参数错误。

| 命令 | 作用 |
|---|---|
| `validate <model> [--photos photos.json]` | 校验模型，输出 `errors / warnings / info / stats` |
| `check-photos <photos.json> [--model m] [--dir 照片目录]` | 检查照片是否齐全、分辨率是否达标 |
| `photo-plan [--model m]` | 生成需要用户拍的照片清单 |
| `plan <model>` | 步骤计划：每一步的零件数、子组件、装配步 |
| `catalog [关键词]` / `colors` | 查零件目录 / 颜色代码 |
| `bom <model> [--step n]` | 零件清单 |
| `export-ldraw <model> [-o out.ldr\|out.mpd]` | 导出 LDraw / MPD |
| `viewer <model> [-o out.html]` | 生成内嵌该模型的单文件查看器 |
| `render <model> -o out.png [--az --el --step --explode 0-100 --emode layer\|module --mech door:90,roof:1 --w --h --status]` | 渲染 3D 图，用来和用户照片对比 |
| `booklet <model> -o out.pdf` | 生成拼装图纸 PDF |

---

## 接入 Harness（智能体工作流）

```
photo-plan ──► 用户按规范拍照 ──► check-photos（直到 complete: true）
     │
     ▼
识别零件（视觉模型 / 零件识别服务）──► catalog / colors 查编号
     │
     ▼
写 model.brick.json（parts、steps、modules、mechanisms，标注 status 与 evidence）
     │
     ▼
validate --photos ──► 修复 errors ──► render（按每张照片的方位角/俯角）与原图对比 ──► 迭代
     │
     ▼
viewer / booklet ──► 用户确认“存疑 / 推断”的零件 ──► export-ldraw（可选）
```

给智能体的要点：
1. 先读 [`docs/数据格式.md`](docs/数据格式.md) 和 [`docs/拍摄规范.md`](docs/拍摄规范.md)。
2. 照片里看不到的零件写 `status: "inferred"`，拿不准的写 `"uncertain"`，并在 `evidence` 里列出能看到它的照片 id；查看器会把这些零件标出来让用户确认。
3. 每次修改后跑 `validate`，`errors` 必须为空；`step-order` 警告说明步骤顺序不合理。
4. 用 `render --az <照片方位角> --el <照片俯角>` 出图，与对应照片逐张比对颜色和轮廓。
5. 单独拼好再装上的部分（例如屋顶）设为 `modules[].subassembly: true`，再加一个 `steps[].attach` 装配步。

---

## 目录结构

```
cli/brickkit.mjs        命令行（Harness 入口）
src/core/core.js        核心：坐标、校验、步骤计划、零件清单、LDraw/MPD 导出、照片检查（纯函数，网页与命令行共用）
src/viewer/             网页查看器（three.js）：main.js 3D 展示、booklet.js 拼装图纸、geom.js 零件几何
dist/viewer.html        打包好的单文件查看器
catalog/                零件目录（58 种常用零件：基础砖/板/平板/斜面/门窗 + 圆砖/圆板/弧面斜砖/SNOT 侧凸点砖/合页夹板/楔形翼板）、颜色表（32 色）
schema/                 JSON Schema：brickbuild.schema.json、photoset.schema.json
examples/               示例模型：cottage（林间小屋，75 件）与 mecha（四翼重装侦察机甲塔，70 件实物重建样本）
out/                    示例输出：拼装图纸 PDF、渲染图
docs/                   数据格式、拍摄规范、截图
tools/                  截图自检脚本（qa_run.mjs、qa_book.mjs）
```

---

## 现状与限制

- 当前零件目录覆盖 58 种常用零件（砖、板、平板、斜面、弧面斜砖、圆砖/圆板、SNOT 侧凸点砖、合页夹板/把柄板、楔形翼板、门窗），支持 6 向 SNOT 朝向（`up: "+y"|"-y"|"+z"|"-z"|"+x"|"-x"` 与 `snot` 片偏移）；更复杂的 Technic 齿轮连杆可在 `catalog/gen-catalog.mjs` 中扩充。
- 坐标是整格 / 整片网格，旋转只支持 90° 倍数。
- 从照片识别零件本身不在本仓库内，需要智能体或第三方识别服务完成；BrickKit 负责约束、校验和展示，“准确还原”依赖人工确认环节。
