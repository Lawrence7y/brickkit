# Spike②：ChArUco 检测 + solvePnP 技术选型报告

> 对应 PRD《多角度图片 v0.3》FR-3.1（位姿解算）、第 8 节依赖选型段、第 10 节 Spike② 行。
> 日期：2026-10-25。结论置信度标注：★★★ = 本机实测一手证据；★★ = 官方文档/元数据一手证据；★ = 未验证或推断。
> 修订 2026-10-25（复核轮）：采纳复核意见，实测更正 §4.4/§5/§7——本机**普通 opencv-python 4.13.0 轮子**实测含 `cv2.aruco` 且 CharucoDetector 端到端可用（OpenCV 4.7.0 起 aruco 模块并入主库 objdetect），撤销初版「须另装 opencv-contrib 轮子」的过时文档推断；首选推荐不变。

---

## 1. 结论先行

**推荐：`@techstark/opencv-js@5.0.0-release.1`（纯 Node WASM）**。

备选顺序：

1. **首选** — `@techstark/opencv-js@5.0.0-release.1`：ChArUco 检测 + solvePnP + 联合标定（`calibrateCameraExtended`）全链路在一个纯 Node 包内闭环，本机实测端到端通过。
2. **备选 1** — Python 侧车（普通 `opencv-python` 轮子即可，**无需 contrib**）：本机 Python 3.12.10 + opencv-python 4.13.0.92 已实测 `cv2.aruco.CharucoDetector` 端到端检出 24 角点、`solvePnP`/`calibrateCamera` 存在（§4.4）；作为 WASM 方案遇到能力缺口时的兜底，成本为 Python 运行时分发 + spawn/IPC 集成。
3. **备选 2** — `js-aruco2@2.0.0` + 自写 PnP：检出可用但只有单 ArUco marker（4 点）、无标定/畸变支持、上游近 3 年无提交；仅当未来 OpenCV.js 官方构建裁剪掉 ChArUco 时作为降级路径。
4. **淘汰** — `opencv-wasm@4.3.0-10`：实测无 calib3d/objdetect 绑定（`solvePnP = undefined`、`aruco = undefined`），且 2021-01 起停止更新。

**对 PRD 遗留疑问的直接回答**（第 8 节「确认 WASM 版是否含 aruco/objdetect 模块」）：
**含。** `@techstark/opencv-js@5.0.0-release.1` 的 `opencv.js` 就是官方 `https://docs.opencv.org/5.0.0/opencv.js`（README 原文声明，★★），其运行时 `getBuildInformation()` 实测输出模块清单 `To be built: calib core dnn features flann geometry imgproc js objdetect photo ptcloud stereo video`（★★★）——OpenCV 5 中 ChArUco 类归入 **objdetect**、solvePnP 归入 **calib**（4.x 的 calib3d 改名），两者都在。且实测用 `aruco_CharucoDetector` 真实检出 24 个 ChArUco 角点并跑通 solvePnP（★★★）。

---

## 2. 需求对照（PRD 原文引用）

| PRD 条目 | 要求 | 本报告覆盖 |
|---|---|---|
| FR-3.1 | 「检测 ChArUco 角点 → 相机内参（EXIF 焦距初值 + 多张联合标定）→ solvePnP 得每张照片相对垫坐标系的位姿」，验收「合成集 az/el 误差 ≤ 2°，平移误差 ≤ 2 mm」 | 验证三能力是否齐备：ChArUco 检测 ✓、solvePnP ✓（合成 6 点自洽误差远小于验收线）、内参联合标定绑定存在 ✓（`calibrateCameraExtended`，未跑数值回归，留一期合成集） |
| 第 8 节 | 「ChArUco 检测 + solvePnP 需技术选型 spike（候选：@techstark/opencv-js WASM、js-aruco2 纯 JS + 自写 PnP、或 Python opencv-contrib 侧车）——优先纯 Node 方案，确认 WASM 版是否含 aruco/objdetect 模块」 | 三个候选全部核实 + 补充候选 opencv-wasm；WASM 模块问题已实测回答 |
| 第 10 节 Spike② | 「ArUco/PnP 库选型」，退出标准「库选型定稿」 | 本报告即定稿依据 |
| §13 开放问题 2 | 「是否接受 Python 侧车作为 ChArUco/PnP 的兜底方案？」 | 结论：可作为备选 1 兜底，不作为首选（双运行时分发/IPC 成本，见 §5） |

注意：本 Spike 验证的是**库能力与数值正确性**（合成数据、无噪声）；FR-3.1 的 2°/2mm 验收需在 PRD §9 的合成回归集（噪声/模糊/JPEG/白平衡偏移）上做，属于一期工作，不在本 Spike 范围。

---

## 3. 实测环境与方法（可复现）

| 项 | 值 |
|---|---|
| 临时目录（仓库外） | `os.tmpdir() = C:\Users\Administrator\AppData\Local\Temp`，实测目录 `C:\Users\Administrator\AppData\Local\Temp\spike-aruco`（Git Bash 路径 `/tmp/spike-aruco`） |
| Node / npm | v22.22.2 / 10.9.7（`node --version`、`npm --version` 实测） |
| 实测包版本 | `@techstark/opencv-js@5.0.0-release.1`（2026-06-24 发布）、`js-aruco2@2.0.0`（2025-06-19 发布）、`opencv-wasm@4.3.0-10`（2021-01-15 发布）；本机经 npm 镜像（registry.npmmirror.com）安装 |
| 仓库边界 | 未改任何仓库文件、未装进仓库；仅临时目录内 `npm init -y` + 安装 |

复现步骤：

```bash
cd "$TMP/spike-aruco"        # C:\Users\Administrator\AppData\Local\Temp\spike-aruco
npm init -y
npm install @techstark/opencv-js@5.0.0-release.1 js-aruco2@2.0.0 opencv-wasm@4.3.0-10
node probe1.js               # 模块覆盖探测（aruco_* / solvePnP / DICT_* 键枚举）
node e2e.js                  # 决定性实测：solvePnP 合成 6 点自洽 + ChArUco 生成→检测→PnP 全链路
node jsaruco.test.js         # js-aruco2：合成 marker 检出 + POSIT 位姿
node dbg2.js                 # getBuildInformation()（模块清单权威输出）
python -c "import cv2; import cv2.aruco as A; d=A.getPredefinedDictionary(A.DICT_4X4_50); b=A.CharucoBoard((5,7),1.0,0.75,d); img=b.generateImage((280,360),marginSize=40); cc,cid,mc,mid=A.CharucoDetector(b,A.CharucoParameters(),A.DetectorParameters()).detectBoard(img); print(cid.shape, mid.shape)"
                             # Python 侧车同参数端到端（复核轮补测）
```

（probe1.js / e2e.js / dbg1-3.js / jsaruco.test.js 为本次实测脚本，留存在临时目录中；仓库内不留副本，以本报告摘录为准。）

---

## 4. 实测结果（关键输出摘录）

### 4.1 @techstark/opencv-js@5.0.0-release.1 ★★★

**模块覆盖（probe1.js + dbg2.js 实测）**：

- `cv.solvePnP / solvePnPRansac / solvePnPRefineLM` 均为 `function`；`SOLVEPNP_IPPE / IPPE_SQUARE / EPNP / P3P / SQPNP / AP3P / ITERATIVE` 方法常量齐全；`Rodrigues / projectPoints / findHomography / initUndistortRectifyMap / undistort / calibrateCameraExtended` 存在（`calibrateCamera` 裸名不存在，联合标定用 `calibrateCameraExtended`）。
- **aruco/ChArUco 以扁平命名导出**（无 `cv.aruco` 命名空间）：`aruco_CharucoDetector`、`aruco_ArucoDetector`、`aruco_Dictionary`、`aruco_CharucoBoard`、`aruco_GridBoard`、`aruco_CharucoParameters`、`aruco_DetectorParameters`、`aruco_RefineParameters`、`drawDetectedCornersCharuco`、`getPredefinedDictionary`、`extendDictionary`，字典常量 `DICT_4X4_50 … DICT_APRILTAG_36h11` 共 22 种。
- objdetect 模块存在性另证：`QRCodeDetector` / `QRCodeDetectorAruco` 为 `function`。
- 权威模块清单（`cv.getBuildInformation()` 实测摘录）：`General configuration for OpenCV 5.0.0`、`To be built: calib core dnn features flann geometry imgproc js objdetect photo ptcloud stereo video`、`Disabled: highgui imgcodecs stitching videoio world`；编译 flags 含 `-s SINGLE_FILE=1 -s USE_PTHREADS=0` → **wasm 以 base64 内嵌于单个 js 文件，Node 下无需额外 .wasm 文件**。
- 加载方式：`require('@techstark/opencv-js')` 返回 Promise-like，`await`/`.then()` 后同步可用；实测初始化 74–122 ms。

**solvePnP 数值自洽（e2e.js 实测，手写投影模型独立于 OpenCV）**：

```text
[合成6点 solvePnP] ok=true
  真值 rvec=0.1,-0.2,0.3  tvec=0.05,-0.03,1.2     （内参 fx=fy=600, cx=320, cy=240）
  解得 rvec=[0.099999,-0.200000,0.300000]  tvec=[0.050000,-0.030000,1.200000]
  旋转误差 = 0.000031 deg, 平移误差 = 0.000287 mm, 最大重投影误差 = 0.000017087 px
  SOLVEPNP_IPPE 也可用, tvec_z = 1.200000
```

6 个共面 3D-2D 点（ChArUco 角点即共面场景），旋转误差 3.1e-5°、平移误差 0.0003 mm，远优于 FR-3.1 的 2°/2 mm 验收线（无噪声合成条件）。

**ChArUco 端到端（e2e.js 实测）**：`getPredefinedDictionary(DICT_4X4_50)` → `new aruco_CharucoBoard({width:5,height:7}, 1.0, 0.75, dict, ids)`（OpenCV 5.x 新签名，`size` 即格子数；签名来源：官方 `aruco_board.hpp`，★★）→ `board.generateImage({280,360}, img, 40, 1)` 生成 280×360 板图 → `new aruco_CharucoDetector(board, CharucoParameters, DetectorParameters, RefineParameters(10,3,false))` → `detectBoard(img, cc, cid, new MatVector(), mid)`：

```text
[detectBoard] charucoCorners=1x24 charucoIds=1x24 markerIds=1x17   （24 角点 / 17 marker 全检出）
[id 前 8 个] = [0,1,2,3,4,5,6,7]
[getChessboardCorners] 数量 = 24, 前3点 = [[1,1,0],[2,1,0],[3,1,0]]
[ChArUco->PnP] 解得 rvec=[0.000000,0.000000,-0.000000] (期望≈[0,0,0])
[ChArUco->PnP] 解得 tvec=[-0.0125,-0.0125,25.0000] (期望≈[0,0,25])
[ChArUco->PnP] 旋转误差 = 0.000007 deg, 最大重投影误差 = 0.000004 px, 角点数 = 24
```

tvec_z 与解析真值（fx/像素密度 = 1000/40 = 25）精确一致；检出角点 → PnP → 用解得位姿反投影回像素，误差 4e-6 px，链路自洽。

**实测踩坑清单（工程配方，全部有实测依据）**：

| 坑 | 现象（实测） | 正确用法 |
|---|---|---|
| solvePnP 输出 Mat | 传空 `new cv.Mat()` 或预分配 `CV_64FC1` 时返回垃圾值（实测 rvec=[0,1.45,0]、重投影 4e20 px） | **rvec/tvec 预分配 `cv.Mat.zeros(3,1,cv.CV_32FC1)`**，实测返回精确真值 |
| CharucoBoard 构造 | 4.x 老签名 `(sqX,sqY,sqLen,mkLen,dict)` 报 `invalid number of parameters (6) - expected (5)` | OpenCV 5.x 签名 `(Size 格子数, squareLength, markerLength, dict[, ids])`（官方 aruco_board.hpp 佐证） |
| RefineParameters 构造 | 无参构造报 `expected (3)` | `new aruco_RefineParameters(10.0, 3.0, false)` |
| detectBoard 参数 | 传 Mat 报 `Expected null or instance of MatVector` | markerCorners 传 `new cv.MatVector()` |
| Point3fVector | `board.getChessboardCorners()` 返回 embind `Point3fVector`，`.get(i).z` 为 `null` | z 按板平面 0 处理 |
| TS 类型缺口 | `dist/src/types/opencv/objdetect.d.ts` 仅 re-export `QRCodeDetectorAruco`，0 处 charuco（实测 grep）；README 自认 "The TypeScript type declarations may not be up to date"（★★） | ChArUco API 需 `any`/手写声明；以运行时 `Object.keys(cv)` 为准 |

**体积**：npm unpacked 14,731,296 B（234 文件，`npm view` ★★）；`dist/opencv.js` 单文件 13,298,869 B（实测 `ls -la`）；磁盘安装后 15 MB（`du -sh`）。无任何运行时依赖（`dependencies` 字段为空，★★）。

### 4.2 js-aruco2@2.0.0 ★★★

- **检出**：合成 ARUCO 字典 id=0 marker（7×7 黑环 + 5×5 数据 + 白留白，180×180 RGBA）→ `new AR.Detector({dictionaryName:'ARUCO'}).detect({width,height,data})` 实测检出 1 个 marker，`id=0`，角点 `[159,20],[159,159],[20,159],[20,20]`，位置精确；**角点顺序顺时针但起始角随码字旋转对齐变化**（本例起始右上，非固定左上）——自写 PnP 必须先做顺序归一。
- **位姿**：自带 `POS.Posit(modelSize, focalLength).pose(4角点)`（posit1.js/posit2.js/svd.js）。合成投影 4 工况实测（正对 / 15°级 / 35°级 / 60°级倾角）：平移误差 ≤ 0.26 px（深度 360–600 px，即 ~0.05%）；旋转输出带**固定可标定的坐标系约定差**，实测暴力识别出「输入角点顺序循环移位 2 + 结果后乘 Ry180」后四工况最差旋转误差 **0.014°**。POSIT 是近似算法（弱透视迭代），本测试未加噪声，真实场景精度需重验。
- **能力边界**：仅方块 ArUco marker（ARUCO 5×5bits/τ=3、ARUCO_MIP_36h12 8×8/τ=12 等），**无 ChArUco**（无棋盘角点亚像素精化）、无畸变模型、无 `calibrateCamera`（FR-3.1 的「多张联合标定」全部要自写：P3P/DLT+LM 或 findHomography 平面单应分解 + 手工畸变忽略）。
- **维护/license**：MIT（npm 元数据 ★★；源码文件头 MIT 双版权 Damiano Falcioni 2020 / Juan Mellado 2011 ★★）。上游 GitHub `damianofalcioni/js-aruco2` 最后提交 **2023-08-10**（GitHub API ★★）；npm 上 2.0.0 于 2025-06-19 由第三方 `lucas-vitrus` 单版本转发（npm 元数据 ★★）。488 KB 磁盘（实测），零依赖。

### 4.3 opencv-wasm@4.3.0-10（补充候选）★★★

- Node 22 实测：`require('opencv-wasm').cv` 可加载（1343 键、`calledRun=true`），但 **`solvePnP = undefined`、`aruco = undefined`**——其 OpenCV 4.3.0 构建不含 calib3d/objdetect 绑定；且 `cv.onRuntimeInitialized` 回调 30 s 未触发（同步立即探测可用，回调机制在该版本与 Node 22 组合下不可靠）。
- 维护：最后发布 2021-01-15（npm time ★★）；unpacked 17.1 MB。**淘汰。**

### 4.4 Python 侧车可行性 ★★★（初版只查未装；复核轮已本机实测补齐并更正归因）

- `python --version` → **Python 3.12.10**（`C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe`；另有 `D:\Anaconda\python.exe`；`python3` 是 MS Store 存根）。
- `pip show opencv-contrib-python` → **未安装**（"Package(s) not found"）；`pip show opencv-python` → **4.13.0.92 已装**（普通轮子）。
- **本机实测（`python -c` 一行端到端，2026-10-25 复核轮）**：

```text
cv2.__version__ = 4.13.0
cv2.aruco 存在 = True | CharucoDetector = True | solvePnP = True | calibrateCamera = True
generateImage: (360, 280) | detectBoard: charucoCorners (24, 1, 2) charucoIds (24, 1) markerIds (17, 1)
id 前 8 个 = [0, 1, 2, 3, 4, 5, 6, 7]
```

  与 §4.1 完全同参数的 ChArUco 链路（DICT_4X4_50、(5,7) 格、sqLen=1.0/mkLen=0.75、280×360、margin=40）在 Python 侧同样检出 **24 角点 + 17 marker、id 0..7**，与 WASM 侧结果一致。
- **归因更正（复核意见采纳）**：初版写「普通 `opencv-python` 不含 `cv2.aruco`（aruco 在 contrib 轮子）」——该推断**已被本次实测推翻**。正确事实：OpenCV **4.7.0 起 aruco 模块从 contrib 并入主库 objdetect**，此后普通 `opencv-python` 轮子即自带 ChArUco 检测与 calib3d；「须另装 contrib 轮子」仅适用于 OpenCV ≤ 4.6。初版该条自标为文档证据未实测，现已按实测改写。
- 侧车真实成本（修正后）：**无需额外安装任何 Python 包**（本机已有可用轮子）；对 brickkit 终端用户仍需 Python 运行时 + `pip install opencv-python`（预编译 wheel，约 40–60 MB 级，未实测），以及 spawn/IPC 双运行时集成（`ingest` 传输 12 MP 图像 / 回传位姿 JSON）。PRD §8「离线：全部本地运行」仍满足。

---

## 5. 对比表

| 维度 | **@techstark/opencv-js 5.0.0-release.1** | js-aruco2 2.0.0 | opencv-wasm 4.3.0-10 | Python 侧车（普通 opencv-python 轮子） |
|---|---|---|---|---|
| ChArUco 检测 | ✅ `aruco_CharucoDetector` 实测检出 24 角点 ★★★ | ❌ 仅单 ArUco 方块 marker ★★★ | ❌ 实测无 aruco 绑定 ★★★ | ✅ `cv2.aruco.CharucoDetector` 本机实测检出 24 角点（4.7 起 aruco 并入主库，普通 opencv-python 轮子即含，无需 contrib）★★★ |
| solvePnP (calib3d) | ✅ 实测 6 点自洽 3.1e-5°，IPPE 等 7 种方法 ★★★ | ❌ 仅 POSIT 近似（实测可用但需约定修正）；精确 PnP 需自写 ★★★ | ❌ 实测 undefined ★★★ | ✅ `cv2.solvePnP`（本机 hasattr 实测存在）★★★ |
| 内参联合标定 | ✅ `calibrateCameraExtended` 存在（未跑数值回归）★★★ | ❌ 全自写 | ❌ | ✅ `cv2.calibrateCamera`（本机 hasattr 实测存在）★★★ |
| 畸变模型 | ✅ distCoeffs 全流程 ★★★ | ❌ | ❌ | ✅ |
| 包/WASM 体积 | npm 14.7 MB；单文件 opencv.js 13.3 MB（wasm base64 内嵌）★★★ | 0.49 MB ★★★ | 17.1 MB ★★ | wheel 约 40–60 MB 级（未实测 ★） |
| Node 集成成本 | 低-中：await 初始化 74–122 ms；有 5 个已破坑的调用配方（§4.1）；TS 类型缺 aruco 需 any ★★★ | 低：require 即用；但位姿/标定/畸变全自写（预估 2–3 天 + 精度风险）★★★ | 实测初始化回调不可靠 ★★★ | 中：Python 运行时分发 + spawn/图像与结果 IPC、错误处理跨进程（无需装 contrib）★★★ |
| 维护度 | 活跃：npm 2026-06-24 发版；GitHub 最后提交 2026-08-01 ★★ | 停滞：上游最后提交 2023-08-10；npm 2025-06 由第三方转发 ★★ | 死亡：2021-01 后无更新 ★★ | 极活跃（OpenCV 官方生态）★★ |
| license | Apache-2.0（npm 元数据）★★ | MIT ★★ | BSD-3-Clause ★★ | Apache-2.0（OpenCV 主库；pip show 未显示 license 字段，未见一手输出）★ |
| Windows 风险 | 低：纯 WASM 无原生二进制、无编译链 ★★★ | 低：纯 JS ★★★ | 高：Node 22 兼容性已实测异常 ★★★ | 中：Python 分发/多版本（本机已有 3.12.10 + Anaconda 并存）；无编译问题（预编译轮子）★★ |
| PnP 方案 | `solvePnP`（平面垫推荐 `SOLVEPNP_IPPE`/`IPPE_SQUARE`） | POSIT 或自写 | — | `cv2.solvePnP` |

---

## 6. 推荐与落地要点

**定稿：`@techstark/opencv-js@5.0.0-release.1` 作为 `ingest`（FR-3.1）的 ChArUco + solvePnP 引擎**，理由：

1. 纯 Node 单包闭环 FR-3.1 三能力，符合 PRD「优先纯 Node 方案」与「离线」约束；零运行时依赖，npm 安装即用（用户侧体验与 brickkit 现状一致）。
2. 数值正确性有实测背书（§4.1），且 ChArUco 提供几十个共面角点 + 亚像素精化，天然优于单 marker 4 点方案，是 az/el ≤2° 验收最稳的路线。
3. 维护活跃（跟随 OpenCV 官方 5.0.0 构建），Apache-2.0 无传染风险。
4. Windows/离线分发零风险（无原生二进制）。

**落地配方（已实测验证，直接进一期代码）**：

- 加载：`const cvMod = require('@techstark/opencv-js'); const cv = await cvMod;`（Promise-like）。
- 标定垫（FR-1.1 生成端与 FR-3.1 解算端使用同一套定义）：`DICT_4X4_50` 或 `DICT_5X5_1000`（`getPredefinedDictionary`）；板定义 `new cv.aruco_CharucoBoard({width:格X,height:格Y}, squareLength, markerLength, dict)`。
- 检测：`new cv.aruco_CharucoDetector(board, new cv.aruco_CharucoParameters(), new cv.aruco_DetectorParameters(), new cv.aruco_RefineParameters(10,3,false))` → `detector.detectBoard(grayMat, cc, cid, new cv.MatVector(), mid)`。
- 位姿：3D 点取 `board.getChessboardCorners()`（按 `cid` 索引，z 按 0）；**rvec/tvec 预分配 `cv.Mat.zeros(3,1,cv.CV_64FC1)`？——不，`CV_32FC1`**（§4.1 坑表）；平面垫用 `cv.SOLVEPNP_IPPE`。
- 输入图像：Node 侧用 `sharp` 解码 → 原始像素 buffer → `cv.matFromArray(h, w, cv.CV_8UC4/8UC1, ...)`；**全程原图分辨率**（对齐 FR-5.4）。
- EXIF 焦距初值 + 多张联合标定：EXIF 解析留在 Node（现有依赖），初值填入 `K` 后按 `CALIB_FIX_ASPECT_RATIO` 等标志用 `calibrateCameraExtended` 联合精化（一期在合成集上回归）。
- 内存纪律：12 MP 图 `CV_8UC4` ≈ 48 MB/张，用完必须 `mat.delete()`（PRD 性能线：20 张 ≤ 60 s，一期实测）。

**备选 1（Python 侧车）触发条件**：若一期在合成集上发现 WASM 检测在真实手机照片上检出率 < FR-1.1 的 95%，或需要鱼眼模型等 WASM 绑定缺失能力，再切换。成本（复核轮修正）：普通 `opencv-python` 轮子（≥ 4.7）即含 ChArUco + calib3d，**无需 contrib 轮子**，本机已实测端到端可用；剩余成本为终端用户的 Python 运行时分发 + spawn/IPC 集成。

**备选 2（js-aruco2）触发条件（WASM 缺 ChArUco 的降级代价评估，PRD 要求项）**：当前 WASM **不缺** ChArUco，此路径仅在未来官方构建裁剪模块时启用。代价评估：检出可用（实测）；但需要自写 (a) 角点顺序归一（实测顺序不固定）、(b) 4 点位姿——POSIT 可用但为弱透视近似且需约定修正（实测 0.014° 系约定补偿后的无噪声误差，真实噪声下未验），更稳的是自写 DLT+LM 或复用 techstark 的 solvePnP（则失去「不依赖 WASM」的意义）；(c) 多 marker 融合成虚拟角点网、(d) 内参联合标定全自写。综合估 **2–3 个工作日 + 精度风险**，仅 4 点/单 marker 的 az/el 精度劣于 ChArUco 一个量级以上，故排在 Python 侧车之后。

---

## 7. 遗留风险

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| 1 | TS 类型不含 aruco 类（实测 objdetect.d.ts 0 处 charuco） | 低 | `ingest` 模块内部封装 + 手写最小 `.d.ts`；以运行时键为契约 |
| 2 | solvePnP 输出 Mat 必须 `CV_32FC1` 预分配，否则垃圾值不报错 | 高（若不知情） | 已写入 §6 配方；`ingest` 首个单测用合成 6 点断言真值回归 |
| 3 | 合成实验中检出角点存在 ~0.5 px 系统平移偏移（t_x=t_y=-0.0125 单位 × 40 px/单位 = 0.5 px，来源疑为 generateImage 栅格约定/亚像素收敛） | 低 | 多张照片联合标定 `cx/cy` 可吸收；`rectify`（FR-5.2）网格对齐容差 2 LDU ≫ 0.5 px |
| 4 | WASM 内存：12 MP 图大 Mat + 15 MB 初始化体 | 中 | strict `delete()` 纪律 + 逐张处理队列；性能在一期合成集实测（PRD §8：20 张 ≤ 60 s 未验） |
| 5 | OpenCV 5.x API 变动快（CharucoBoard 签名 4.x→5.x 已变一次）；techstark 无 GitHub Releases，发版全靠 npm | 低 | 锁定精确版本（`5.0.0-release.1`）；升级时以 `getBuildInformation()` + 合成 6 点回归做升级门禁 |
| 6 | FR-3.1 的 2°/2 mm 验收尚未在带噪合成集上验证（本 Spike 仅无噪声数值自洽） | 中 | 一期 `test/ingest.test.mjs` 按 PRD §9 合成回归集断言 |
| 7 | 初版曾记「普通 opencv-python 不含 cv2.aruco，切 Python 侧车需另装 contrib（60–70 MB）」——**已撤销**：复核轮实测 cv2 4.13.0（普通轮子）含 aruco/CharucoDetector 且端到端 24 角点通过（OpenCV 4.7 起 aruco 并入主库 objdetect）；Python 侧车剩余成本仅为运行时分发与 IPC | — | 初版基于过时文档推断（当时自标未实测），本次实测后撤销 |

---

## 8. 证据来源清单

**实测（本机执行，临时目录 `C:\Users\Administrator\AppData\Local\Temp\spike-aruco`，Node v22.22.2）**：

- `npm view` 输出：三包版本/license/时间/体积（`@techstark/opencv-js` Apache-2.0、latest 5.0.0-release.1、时间表 2021→2026；`js-aruco2` MIT、2.0.0、unpacked 424,088 B；`opencv-wasm` BSD-3-Clause、4.3.0-10、2021-01-15）。
- `probe1.js`：1622 个导出键枚举，aruco_*/solvePnP/DICT_* 存在性。
- `dbg2.js`：`cv.getBuildInformation()` 完整输出（OpenCV 5.0.0、模块清单、SINGLE_FILE=1）；projectPoints 与手写模型最大偏差 1.8e-5 px；solvePnP 输出类型坑复现。
- `e2e.js`：solvePnP 合成 6 点自洽（0.000031° / 0.000287 mm）；ChArUco 端到端（24 角点检出、tvec_z=25.0000 精确、重投影 4e-6 px）。
- `jsaruco.test.js` + 后续验证：marker 检出（id=0、角点精确）；POSIT 四工况位姿（约定修正后最差旋转误差 0.014°、平移 ≤0.26 px）。
- `opencv-wasm` 探测：1343 键、solvePnP/aruco undefined、onRuntimeInitialized 30 s 未回调。
- `python --version` = Python 3.12.10；`pip show opencv-contrib-python` = 未安装；`pip show opencv-python` = 4.13.0.92。
- `python -c` 一行端到端（2026-10-25 复核轮补测）：`cv2.__version__ = 4.13.0`；`cv2.aruco` / `CharucoDetector` / `solvePnP` / `calibrateCamera` 均存在；DICT_4X4_50 (5,7) 板 `generateImage((280,360), marginSize=40)` → `detectBoard` 检出 24 角点 + 17 marker、id 0..7（与 §4.1 WASM 侧同参数同结果）——证明普通 opencv-python 轮子即含 ChArUco，撤销初版「需 contrib 轮子」推断。
- 体积实测：`du -sh`（15 MB / 488 KB）；`ls -la dist/opencv.js` = 13,298,869 B。

**官方文档/元数据（一手链接）**：

- OpenCV 5.x `aruco_board.hpp`（CharucoBoard 5.x 构造签名）：https://github.com/opencv/opencv/tree/5.x/modules/objdetect/include/opencv2/objdetect （`CharucoBoard(const Size& size, float squareLength, float markerLength, const Dictionary &dictionary, InputArray ids = noArray())`）
- TechStark/opencv-js README（opencv.js 直接取自 `https://docs.opencv.org/5.0.0/opencv.js`；异步初始化模式；类型声明可能滞后声明）：https://github.com/TechStark/opencv-js
- js-aruco2 README（字典支持/POSIT/NodeJS 用法）：https://github.com/damianofalcioni/js-aruco2
- 维护时间线（GitHub API）：`api.github.com/repos/TechStark/opencv-js/commits?per_page=1` → 2026-08-01；`api.github.com/repos/damianofalcioni/js-aruco2/commits?per_page=1` → 2023-08-10。
- opencv-wasm 入口源码（`node_modules/opencv-wasm/index.js`，包装 `cv` + `cvTranslateError`）。
