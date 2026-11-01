# BrickKit / Workbench 独立模型质量审计报告（方法纠偏与承重证据完整版）

> **审计执行时间**：2026-10-31  
> **审计环境**：Windows 11 / Node.js v22.22.2 / ES Modules  
> **目标集成仓库**：`D:\Project\brickkit-workbench`  
> **生产文件状态**：严格只读，无任何生产目录与引擎修改；独占工作目录 `audit/independent-audit-2026-10-31/`  
> **审计样本全集**：170 件（168 件主集合 + 50745、60477 补充样本）

---

## 一、对齐目标与集成上下文

### 1.1 实际输入文件与权威构建身份
| 输入文件 | 仓库路径 | SHA-256 哈希值 |
|---|---|---|
| 零件精选目录 | `catalog/parts.json` | `ce8843ff71328a764aeef648f9f2c5fa2cdc5b4657508677deafadfbcb3b6aab` |
| LDraw 扩展目录 | `catalog/parts-ldraw.json` | `1841b7081e03ec86be75cb687a9cda6f7727858de3ccd07de78a6bdbe60fea27` |
| 精选零件封包 | `catalog/ldraw-pack.json` | `2987cf49dc601fbfd3d6ba60c769dd2fdb1acebf2295a41057c725de0dbc15e7` |
| 官方颜色表 | `catalog/colors.json` | `2e858c4396eb27ecffdca8521131d029e920f5e832f79091cb58b9d2d38906a8` |
| Workbench 核心引擎 | `src/core/core.js` | `674b5cbb39c7674f7bc952f90a9a83a56f647c315ee663fdecb7c1004e88a235` |
| 原 BrickKit 核心引擎 | `brickkit/src/core/core.js` | `ac2394ce5036696ec0db2323f730d37c3afc56cffff6478e7bf8e091c3c316c5` |
| LDraw 解析工具 | `src/ldraw/ldraw.js` | `464d0d26104b6c2ee31d1fe370562932f4fe09d81388166934dd778bb683ba65` |
| 基准面推导引擎 | `src/ldraw/datum.mjs` | `2230432e0a8ab33c2ef8e83fbe22b31b77daeb1e342e1bcf85ec31715f254478` |

- **Git Commit (Workbench)**: `c0fd7b860c5f5734122dd04ac976b935d9f006d0`
- **Package Identity**: `brickkit` @ `0.2.0`

### 1.2 几何闭包与实现版本差异
1. **几何闭包分析**：
   - `catalog/ldraw` 精选离线库镜像共 522 个文件。
   - `catalog/ldraw-full`（通过符号链接挂载）包含 24,859 个零件与 1,791 个图元。
   - 经闭包依赖展开，全部 170 件目标零件及其递归引用的图元（`stud.dat`, `stud2.dat`, `stud4.dat`, `box5.dat` 等）**100% 成功解析，缺失零件数为 0**。
2. **连接与碰撞实现版本**：
   - 相比原 BrickKit，Workbench 的 `src/core/core.js` 引入了 `COORD_INHERITED_FIELDS` 白名单守卫（当 size/h 不一致时阻断 `studCells`, `centerStuds`, `subGrid`, `antistudCells` 继承，防止局部网格坐标错位）。
   - Workbench 修复了 `wheelCylinder` 轮件碰撞代理：轴向按零件姿态映射到世界坐标，半厚改为世界包围盒半跨度。
   - 原 BrickKit 审计结论仅作为历史比对证据，本报告的所有运行期行为与判定均在 Workbench 运行环境下独立复测。

---

## 二、审核器方法纠偏与逐件清单

### 2.1 审核方法彻底纠偏（去除默认放行与循环期望）
1. **连接器逐接口记录**：
   - 对 170 件零件的全部连接器逐个记录 `role`, `kind`, `pos`, `dir`, `axis`, `matchingBasis` 与 `nonJudgeableReason`。
   - 匹配依据区分为：官方图元精配 (`ldraw_primitive_exact`)、实测特征数组 (`ldraw_measured_array`)、人工精选网格合成 (`curated_synthetic_grid`)。
   - 连续自由度、球铰锥面旋转与公差依赖项均显式记录不可判原因，严禁隐式假定匹配。
2. **碰撞判定彻底破除“默认 accurate”**：
   - 确立四态严格分类：
     - `REPRODUCIBLE_FALSE_POSITIVE`（可复现合法装配误报，共 10 件）
     - `REPRODUCIBLE_FALSE_NEGATIVE`（可复现非法穿透漏报，共 2 件）
     - `ACCURATE_PRIMITIVE`（严格证明凸包等于包围盒的平直砖板，共 14 件）
     - `UNKNOWN`（未建立数学边界证明的一律置为 UNKNOWN，共 144 件，占 84.7%）
3. **彻底去除循环期望**：
   - 独立安装面基准完全由物理几何特征决定（底腔管口 `maxY`、下挂件基板底面 `studBaseY + 8 LDU`、零基准斜面 `Y=0`），**绝不调用待测的 `declaredH` 或 `deriveDatum` 反向推算**。
   - 包围盒尺寸（`bboxLdu`）、接口安装基准（`interfaceMountingDatumLdu`）与名义装配尺寸（`nominalH`, `nominalOriginLdu`）三者严格解耦、分开建账。

### 2.2 总体统计与分母口径
- **样本总数**：170 件（主集合 168 件 + 补充样本 2 件）
- **互斥状态总览**：
  - `PASS`（全项无缺陷且通过验证）：**144 件**（Main: 142, Supp: 2）
  - `DEFECTIVE`（至少命中一类可证实缺陷）：**26 件**（Main: 26, Supp: 0）
  - `UNVERIFIED`（几何或来源不可考）：**0 件**

### 2.3 可重叠缺陷多维分布（逐件清单与分母）
| 缺陷类别 | 主集合 (Main) | 补充样本 (Supp) | 总计 (Total) | 涉及零件清单 |
|---|---|---|---|---|
| **D1: 目录元数据缺陷** | 2 / 168 | 0 / 2 | 2 / 170 | `30374`, `87994` |
| **D2: 显示基准面偏差** | 16 / 168 | 0 / 2 | 16 / 170 | `11476`, `11477`, `14417`, `14418`, `15068`, `30374`, `3839b`, `4081b`, `54200`, `60470`, `60623`, `63868`, `85984`, `87994`, `92946`, `93273` |
| **D3: 接口连接器缺陷** | 6 / 168 | 0 / 2 | 6 / 170 | `14417`, `14418`, `15712`, `30374`, `4274`, `87994` |
| **D4: 碰撞体保真度缺陷** | 12 / 168 | 0 / 2 | 12 / 170 | 假阳性(10): `11477`, `15068`, `36841`, `47457`, `54200`, `6091`, `61678`, `85984`, `93273`, `99781`<br>假阴性(2): `18677`, `2444` |
| **D5: 来源链与图元规范** | 1 / 168 | 0 / 2 | 1 / 170 | `35`（缺少官方 Part 头声明，为 Shortcut 装配体） |

---

## 三、三项关键反例的承重证据

所有反例均生成最小模型、姿态输入与直接运行输出，保存在 `audit/independent-audit-2026-10-31/counterexamples-evidence.json`：

### 证据 1：球铰伪连接与正对失锁（14417 & 14418）
- **判定状态**：`CONFIRMED`
- **最小模型与姿态**：
  - 球头板 `pBall` (14417): `at: [0, 0, 0]`, `up: "+y"`, `rot: 0`
  - 球窝板正对放置 `pSocketCentered` (14418): `at: [0, 0, 1.44]`, `up: "+y"`, `rot: 180`
  - 球窝板错位放置 `pSocketShifted` (14418): `at: [-0.5, 0, 1.44]`, `up: "+y"`, `rot: 180`
- **运行命令**：
  ```bash
  node audit/independent-audit-2026-10-31/evidence-runner.mjs
  ```
- **核心原始输出**：
  ```json
  "ball14417_bars": [
    { "index": 2, "pos": [0.5, 0.5, 1.22], "dir": "+z", "axis": "x", "label": "bar-0" },
    { "index": 3, "pos": [1.5, 0.5, 1.22], "dir": "+z", "axis": "x", "label": "bar-1" }
  ],
  "socket14418_centered_clips": [
    { "index": 2, "pos": [1, 0.5, 1.22], "dir": "-z", "axis": "x" }
  ],
  "socket14418_shifted_clips": [
    { "index": 2, "pos": [0.5, 0.5, 1.22], "dir": "-z", "axis": "x" }
  ],
  "centeredConnected_expected_TRUE_actual": false,
  "shiftedConnected_expected_FALSE_actual": true
  ```
- **物理机理证据**：
  14417 物理实体是中心球头（x=1.0），目录错标为 `kind: "barplate"`，导致引擎合成了两根偏心虚拟圆杆（x=0.5 与 x=1.5）；14418 目录错标为 `kind: "clip"`，生成中心夹口（x=1.0）。两件在实物正对对齐时，引擎判为 `false`（断开）；而当 14418 恶意横移 0.5 格时，虚假夹口扣在虚假圆杆上，引擎反常报告 `true`（连接）。

### 证据 2：下挂支架碰撞向下虚增 0.5 片（99781 & 36841）
- **判定状态**：`CONFIRMED`
- **物理几何测量**：
  官方 `99781.dat` 的 BBox Y 范围为 `[-4, 20]` LDU。顶板凸点基面为 Y=0，顶板底面为 Y=8 LDU，下垂竖板底部为 Y=20 LDU。下垂深度实际为 `20 - 8 = 12 LDU = 1.5 片`。
- **引擎计算与误报复现**：
  目录声明 `vH: 3`，导致 `partBoxes` 按 `y0 = (1 - vH) * PLATE = (1 - 3) * 0.4 = -0.8`（即向下延伸 2 片 = 16 LDU，达到 Y=24 LDU），向下虚增了 `4 LDU = 0.5 片`（0.2 格）。
  在真实物理下挂净空处（Y 在 0 到 0.5 片之间）放置相邻合法零件时，`boxesCollide` 误报穿模：
  ```json
  "reproducibleFalsePositive": {
    "adjacentPartBoxInRealClearance": { "x0": 0, "x1": 2, "y0": 0, "y1": 0.4, "z0": 0.8, "z1": 1.2 },
    "collisionDetected": true,
    "rawCollisionHit": [ 1, 0, 1 ]
  }
  ```

### 证据 3：底面销孔凸台完全漏检穿模（18677 & 2444）
- **判定状态**：`CONFIRMED`
- **物理几何测量**：
  官方 `18677.dat` 的 BBox Y 范围为 `[-4, 19]` LDU。顶板底面为 Y=8 LDU，底面销孔圆柱台向下延伸至 Y=19 LDU，外凸下挂深度达 `11 LDU = 1.375 片`。
- **引擎计算与漏报复现**：
  目录将 18677 设为普通 `kind: "plate"`，`partBoxes` 走默认单盒分支，只生成 `y: [1, 2]` 片的 1 片厚包围盒，彻底丢失下方 11 LDU 的凸台。
  当在 18677 底面平铺一块实心板 3022 时，实物中凸台硬切入下方板材 1.375 片厚，但引擎判定完全无穿模且判定合法装配：
  ```json
  "engineOutput": {
    "pBaseBoxes": [ { "x0": 0, "x1": 2, "y0": 0, "y1": 1, "z0": 0, "z1": 2 } ],
    "pBossBoxes": [ { "x0": 0, "x1": 2, "y0": 1, "y1": 2, "z0": 0, "z1": 1 } ],
    "collisionDetected_expected_TRUE_actual": false,
    "rawCollisionHit": null,
    "connectionDetected_expected_FALSE_actual": true
  }
  ```

---

## 四、特殊结构与循环期望解题

### 4.1 60623 门叶与门框名义尺寸解耦
- **独立几何测量**：
  官方 `60623.dat`（门叶单件）物理 BBox Y 范围为 `[3, 137]` LDU，净高度为 `134 LDU`（折合 16.75 片）。
  配套门框（如 60596）的门洞开口为 `[4, 140]` LDU（136 LDU = 17 片），门框总高度为 6 块标准砖 = `18 片`（144 LDU）。
- **解耦审查结论**：
  `60623` 目录中声明的 `h: 18` 是该门组件在建筑网格中的**名义装配高度**（与门框及墙体砖对齐）。
  **严禁直接用门叶物理高度 16.75 片覆盖门框名义高度 18 片**！否则会导致装配树高度塌陷、上层砌砖悬空或网格错位。
  正确方案为建立双层字段：`h: 18`（名义装配高度），补充 `leafPhysicalHeightLdu: 134`（门叶物理高度）与门轴转角，几何对齐以铰接轴（pivot）为独立锚点。

### 4.2 杆件小数高度（Fractional h）全链路语义影响
实测表明，LEGO 中 1 格长度等于 2.5 片高（20 LDU）。因此：
- 4L 杆件（`30374`）实长为 `4 × 20 = 80 LDU = 10 片`（整数片，原目录错写为 12 片）；
- 3L 杆件（`87994`）实长为 `3 × 20 = 60 LDU = 7.5 片`（**小数片**，原目录错写为 9 片）。

若在目录中将 `87994` 的 `h` 改为 `7.5`，引擎内部将产生以下四处连锁破坏：
1. **生成循环错位**：
   `validate` 的底层空间网格占用循环为：
   ```js
   for (const f of footprint(p, def)) for (let y = p.at[1]; y < p.at[1] + def.h; y++)
   ```
   当 `p.at[1]=0, def.h=7.5` 时，`y` 将迭代 `0, 1, ..., 7` 共 8 层整数格，导致第 7 层被整层虚占，合法搭接被误报 `overlap` 错误。
2. **堆叠步进层级污染**：
   `topLayer(p, def) = p.at[1] + def.h`，输出 `7.5`。下游装配树与图纸生成器按整数层分步绘制时，由于键值变为浮点数而脱离分层索引。
3. **连接点遗漏**：
   `partConnectors` 内部采用 `for (let y = 0.5; y < def.h; y += 1)`。当 `h=7.5` 时，最后一个凸点落在 `y=6.5`，顶端遗漏整整 1 片（8 LDU）的把柄扣合点。
4. **目录继承阻断**：
   Workbench 的 `mergeCatalogParts` 引入了 `coordFrameOk` 检查：`e.h === c.h`。若扩展目录是整数 8 而精选目录改设 7.5，会导致实测特征坐标被阻断继承。
- **推荐方案**：
  名义高度保留 `h: 8`（向下取整/保守包围）或引入独立 `lengthPlates: 7.5` 属性；连接器直接继承官方实测端头坐标，禁止裸改标量 `h`。

---

## 五、候选修复建议清单（四大独立类别）

向主会话提交结构化候选建议，供主工程按类独立评审集成：

### 类别 1：目录元数据修复（Catalog Metadata）
- **[CR-CAT-01] 30374 标量高度纠偏**：
  将 `h: 12` 修正为 `h: 10`（80 LDU 官方实测，10 片高）；`ldrawOrigin` 由 `[0, 12, 0]` 修正为 `[0, 10, 0]`。
- **[CR-CAT-02] 4274 类别重构**：
  将 `kind: "round"` 修正为 `kind: "technic"`，标明销轴方向为水平 X 轴。
- **[CR-CAT-03] 92946 原点浮空修正**：
  将 `ldrawOrigin: [0, 3, 0]` 修正为 `[0, 1, 0]`（单片板厚 8 LDU，非 3 片）。

### 类别 2：显示与安装基准修复（Display & Datum）
- **[CR-DISP-01] 5 种零基准斜砖原点归零**：
  针对 `11477`, `15068`, `54200`, `85984`, `93273`，LDraw 官方底面均建模在 Y=0。将其 `ldrawOrigin` 从 `[0, h, 0]`（16 LDU）修正为 `[0, 0, 0]`，彻底消除查看器中浮空 2 片的渲染缺陷。
- **[CR-DISP-02] 下挂件基准面锚定**：
  对下挂支架（`99781`, `36841`, `44728`）与下挂球头/把柄（`14417`, `14418`, `3839b`, `4081b`），渲染对齐以物理安装面（`studBaseY + 8 LDU`）为原点，禁止使用包围盒最低点对齐。

### 类别 3：接口与连接器修复（Connectors）
- **[CR-CONN-01] 14417/14418 原生球铰接口定义**：
  废弃 `kind: "barplate"` 与 `kind: "clip"` 伪装，新增原生 `ball`（14417 中心 [1.0, 0.5, 1.22]）与 `socket`（14418 中心 [1.0, 0.5, 1.22]）连接器对，恢复中心合法正对扣合。
- **[CR-CONN-02] 15712 顶凸点与夹口方向修正**：
  剔除虚假 top stud，将 clip receptor 轴向由 `+z` 修正为实物 `+y`。

### 类别 4：碰撞盒保真度修复（Collision Boxes）
- **[CR-COLL-01] 下挂支架包围盒深度修正**：
  在 `src/core/core.js` 的 `partBoxes` 中，将下挂支架（`def.dir === 'down'`）竖板包围盒深度由 `(1 - def.vH) * PLATE` 修正为 `-0.5 * PLATE`（或采用实测 1.5 片深度），消除下方 0.5 片的穿模假阳性。
- **[CR-COLL-02] 底面销孔凸台补齐**：
  为 `18677` 与 `2444` 配置 `boxes: [[-1, 1, 0, 1, -0.5, 0.5], [-0.5, 0.5, -1.375, 0, -0.5, 0.5]]`，精准表达下方 11 LDU 销孔圆柱台，消除非法重叠穿模假阴性。
- **[CR-COLL-03] 斜面零件阶梯盒逼近**：
  对 `54200`、`85984` 等斜面件，引入 stepped 盒结构（参照 60477 范式），替代粗糙的实心外接盒。

---

## 六、证据与产物文件索引
- 审计全量数据账本：`audit/independent-audit-2026-10-31/audit-v2-corrected.json`
- 三项反例可复现证据：`audit/independent-audit-2026-10-31/counterexamples-evidence.json`
- 审计执行脚本：`audit/independent-audit-2026-10-31/rigorous-audit.mjs`
- 反例复现脚本：`audit/independent-audit-2026-10-31/evidence-runner.mjs`
