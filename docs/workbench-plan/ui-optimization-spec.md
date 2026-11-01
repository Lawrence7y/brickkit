# BrickKit 工作台 UI 交互优化与设计规范说明书 (UI Optimization Specification)

> **文档标识**：`SPEC-WORKBENCH-UI-20261030`  
> **所属项目**：BrickKit Workbench (`brickkit-workbench`)  
> **版本**：v2.0-Formal  
> **制定角色**：Lead UI & Prototype Engineer (worker_doc_proto_1)  
> **基准审核轮次**：Round 5 独立重测与终验（Session ID: `20261030-133500`）  
> **配套交互原型**：`D:/Project/brickkit/docs/workbench-plan/ui-prototype.html`  
> **约束准则**：生产源码（`D:/Project/brickkit-workbench/src/` 及 `dist/`）完全保持只读，本规范与原型为后续工程落地的权威裁决依据。

---

## 目录 (Table of Contents)
1. [§1 概述与缺陷对账台账 (Executive Summary & Defect Ledger)](#1-概述与缺陷对账台账-executive-summary--defect-ledger)
2. [§2 设计系统令牌与调色板规范 (Design System Tokens & Palette)](#2-设计系统令牌与调色板规范-design-system-tokens--palette)
3. [§3 科技件 584 简化几何与多级名称回退规范 (Part 584 & Multi-Tier Fallback)](#3-科技件-584-简化几何与多级名称回退规范-part-584--multi-tier-fallback)
4. [§4 多视口响应式布局架构 (Multi-Viewport Responsive Architecture)](#4-多视口响应式布局架构-multi-viewport-responsive-architecture)
5. [§5 3D 舞台钉扎与滚动协同架构 (3D Stage Pinning & Scroll Coordination)](#5-3d-舞台钉扎与滚动协同架构-3d-stage-pinning--scroll-coordination)
6. [§6 核心组件全状态规范矩阵 (Component State Matrix)](#6-核心组件全状态规范矩阵-component-state-matrix)
7. [§7 工程落地核验与实施准则 (Implementation & Verification Checklist)](#7-工程落地核验与实施准则-implementation--verification-checklist)

---

## §1 概述与缺陷对账台账 (Executive Summary & Defect Ledger)

### 1.1 编制背景与目标
BrickKit 工作台（`brickkit-workbench`）是一款将乐高实物模型的多角度照片重构为 3D 交互模型、爆炸图拆解及拼装图纸的现代化 Web 端生产力工具。在前期独立审核（Round 5 Session: `20261030-133500`）中，测试团队指出了阻断性与关键性的交互及视觉表现缺陷：
- **ISSUE-R3-01**：页面滚动时 3D 舞台钉扎因 `requestAnimationFrame`（rAF）异步节流导致 1 帧瞬态负 Y 出屏（`minY = -94.7px`），引发强烈的视觉闪白与画面跳变；
- **ISSUE-R3-02**：科技零件 584 简化几何（Simplified Geometry）状态标识在属性检查器（`#props-body`）与物料清单（`#bom`）中完全缺失，且因中文名称为空导致 BOM 退化为冰冷的裸数字编号；
- **响应式与组件状态诉求（R2、R4）**：移动端 390px 视口下缺少专用的全屏/抽屉交互形态，且虚拟滚动容器存在断裂导致 510,000px DOM 膨胀的隐患，零件库与待选栏缺乏全状态矩阵定义。

针对用户明确指示“原型呢？”并严正要求“先不要修改生产代码，供评审验证”，本文档系统化定义 BrickKit 工作台的 UI 交互与视觉优化规范，并作为独立轻量单文件交互原型 `ui-prototype.html` 的顶层设计蓝图。

### 1.2 缺陷与需求双向映射台账 (Defect Ledger & Requirements Traceability)

| 需求编号 | 对应缺陷 / 规划编号 | 模块分类 | 严重度 | 缺陷/诉求核心现象与根因 | 规范解决方案概要 | 原型验证索引 |
| :---: | :---: | :---: | :---: | :--- | :--- | :---: |
| **R1** | **ISSUE-R3-02** | 元数据与BOM | P2 (Medium) | 零件 584 中文名为空串，BOM 清单采用 `def.zh \|\| partId` 退化为裸数字 `584`；属性栏与 BOM 缺失简化外形 Badge | 确立单一事实来源：三级回退算法（中文 -> 英文+编号 -> 身份未知+编号）；统一 20px 胶囊警示 Badge | 原型 Showcase 1 |
| **R2** | **PRD §9 / Addendum §一** | 视口响应式 | P1 (Critical) | 移动端 390 宽下网格模态框被遮挡截断；Flex 容器缺少 `min-height:0` 导致 51 万像素虚拟 DOM 膨胀死锁 | 4 视口断点形变：390px 转换为 100dvh 全屏 Sheet + 横向滚动分类 Chips；施加 Flex 全高度链 `min-height: 0` 与 120 张卡双硬顶 | 原型 Showcase 2 |
| **R3** | **ISSUE-R3-01** | 视口与滚动 | P1 (Critical) | 滚动突变当帧，浏览器合成器先平移文档（`top = -276px`），rAF 异步延迟导致 Canvas 滞留 1 帧，模型飞出屏幕（`minY = -94.7px`） | 稳定基座（Stable Base Pinning）：`#viewport.is-pinned` 静态常驻 `position: fixed`，纯靠 GPU `transform3d/scale` 硬件加速过渡 | 原型 Showcase 3 |
| **R4** | **PRD §3~5 / Addendum §三** | 交互全状态 | P2 (Medium) | 零件库卡片、分类器、搜索框、待选栏组件状态不全；直接拖入被误认模型文件；分类项高亮状态失步 | 规范卡片/分类器/搜索/待选区 6-State 矩阵；自定义私有拖拽 MIME 类型；四位一体高亮契约 | 原型 Showcase 4 |
| **R5** | **用户核心指令** | 交付验证 | P0 (Blocker) | 缺少供用户直观体验与审查的原型，且不得破坏生产代码工程 | 输出独立轻量单文件 `ui-prototype.html`（零 CDN/零依赖，内嵌 4 视口切换器与全量功能演示器） | 独立 HTML 原型 |

---

## §2 设计系统令牌与调色板规范 (Design System Tokens & Palette)

工作台 UI 必须严格遵循既有生产环境的设计变量体系（源自 `src/viewer/style.css`、`src/editor/library/library.css`），所有扩展样式必须使用设计令牌（Tokens）表达，严禁在业务样式中硬编码魔法颜色。

### 2.1 颜色令牌规范 (Color Tokens)

```css
:root {
  /* ==================== 1. 基础表面与背景色 (Surface & Background) ==================== */
  --bg: #F5F6F8;                  /* 工作台与 3D 舞台大背景底色：明亮、洁净的冷灰 */
  --panel: #FFFFFF;               /* 主面板表面色：卡片、侧边栏、顶栏、模态框主底色 */
  --surface: #FFFFFF;             /* 等同于 --panel，作为通用表面 Token */
  --surface2: #EDEFF3;            /* 次级表面色：分段控制器背景、输入框禁用底色、轻量槽位底色 */
  --soft: #F5F6F8;                /* 微弱底色：悬停态底色、浅灰列表斑马纹、占位框架底色 */
  --backdrop: rgba(24, 30, 40, 0.36); /* 模态弹窗遮罩背景：半透明深色毛玻璃 */

  /* ==================== 2. 文本与图标色 (Text & Ink) ==================== */
  --text: #20242B;                /* 主文本/墨水色：主标题、正文、主操作文字，对比度 12.8:1 */
  --ink: #20242B;                 /* 等同于 --text */
  --text2: #687180;               /* 次级文本色：零件编号、辅助说明、副标题、未激活图标，对比度 4.8:1 */
  --text-muted: #9BA3AF;          /* 禁用与弱提示色：输入框占位符、禁用按钮文本 */
  --text-inverse: #FFFFFF;        /* 反色文本：主操作按钮、深色色块内的文字 */

  /* ==================== 3. 边框与分割线 (Borders & Dividers) ==================== */
  --border: #E0E4EA;              /* 主边框色：卡片容器边框、弹窗边缘线、输入框常规边框 */
  --hair: #E8EBF0;                /* 细分割线：列表项分隔线、面板内部微弱划分线 */
  --border-focus: #3769E8;        /* 聚焦边框色：与强调主色一致 */

  /* ==================== 4. 品牌与强调色 (Brand & Accent) ==================== */
  --accent: #3769E8;              /* 强调主色：主按钮、高亮边框、选中轮廓、焦点光晕 */
  --wb-asm-primary: #3769E8;      /* 装配主品牌色 Token */
  --accent-text: #2A55C4;         /* 强调文字色：用于浅底上的强调文字，强化对比度 */
  --accent-soft: #EAF0FE;         /* 强调浅底色：选中行背景、分类高亮胶囊、选中标签 */
  --accent-glow: rgba(55, 105, 232, 0.18); /* 强调色扩散光晕：Focus-Visible 阴影扩展环 */

  /* ==================== 5. 语义与功能状态色 (Semantic & Feedback States) ==================== */
  /* Positive / Success：用于合法装配接口、通过测试、吸附就绪 */
  --positive: #1B9367;
  --positive-soft: #E7F6F0;
  --positive-text: #12744F;

  /* Attention / Warning：专用于简化几何标识（Simplified Geometry）、存疑参数、非致命警示 */
  --attention: #B77915;           /* 警示主色：警告三角图标轮廓、深色模式警示条 */
  --attention-soft: #FCF3E3;      /* 简化几何 Badge 底色：极浅柔和暖橙黄 */
  --attention-text: #8C5B0C;      /* 简化几何 Badge 文本与图标填色：深琥珀棕黄，对比度 5.2:1 */
  --attention-border: #EEDCBC;    /* 简化几何 Badge 外边线：浅棕黄 */

  /* Risk / Danger：用于穿模冲突、碰撞警报、删除危险、非法物理干涉 */
  --risk: #D34444;
  --wb-asm-bad: #D34444;
  --risk-soft: #FCEDED;
  --risk-text: #B03030;
  --risk-border: #F6C8C8;

  /* ==================== 6. 阴影系统 (Elevations & Shadows) ==================== */
  --shadow-sm: 0 1px 2px rgba(23, 31, 45, 0.05);
  --shadow: 0 1px 2px rgba(23, 31, 45, 0.05), 0 8px 24px rgba(23, 31, 45, 0.07);
  --shadow-md: 0 4px 16px rgba(23, 31, 45, 0.09), 0 1px 3px rgba(23, 31, 45, 0.04);
  --shadow-lg: 0 24px 72px rgba(16, 22, 32, 0.28); /* 零件库弹窗专用深度阴影 */
  --shadow-drawer: -8px 0 24px rgba(16, 22, 32, 0.12); /* 侧边抽屉阴影 */
  --shadow-bottom-drawer: 0 -8px 24px rgba(16, 22, 32, 0.12); /* 移动端底部抽屉阴影 */

  /* ==================== 7. 圆角与尺寸尺度 (Radii & Sizing) ==================== */
  --radius-sm: 6px;               /* 小色块、次级小按钮 */
  --radius: 12px;                 /* 卡片、面板、输入框基准圆角 */
  --radius-lg: 20px;              /* 模态弹窗、全屏抽屉外圆角 */
  --radius-pill: 999px;           /* 胶囊状态徽标、子分类 Chips */
  --control-h: 36px;              /* 桌面端控件基准高度 */
  --control-h-mobile: 44px;       /* 移动端触摸靶区最小安全高度 */
}
```

### 2.2 视图层级体系 (Z-Index Hierarchy Scale)

为彻底消灭图层遮挡、事件穿透以及弹窗与吸顶条打架的现象，全局严格执行 8 级层级阶梯：

```
z-index: 120  ── 全局飞行代理与容灾克隆体 (.wb-lib-fly, .wb-book-fallback)
z-index: 100  ── 全局 Toast 提示浮条 (#toast)
z-index: 90   ── 阻断性确认模态框 (.confirm, .danger-modal)
z-index: 80   ── 零件库模态弹窗与移动全屏覆层 (#library-root, .wb-lib-overlay)
z-index: 70   ── 设置零件面板与网格配置浮层 (.wb-set, .grid-pop)
z-index: 60   ── 下拉操作菜单与快捷气泡 (.menu, .wb-asm-popover)
z-index: 45   ── 3D 展示区吸顶控制栏 (#display-bar)
z-index: 40   ── 工作台顶部主导航栏 (#topbar)
z-index: 20   ── 侧边栏抽屉移动覆层 (#tree, #props 在窄屏 drawer 状态下) / 区域框选层 (.marquee)
z-index: 15   ── 3D 舞台过渡钉扎层 (#viewport.is-pinned / #viewport.is-fixed)
z-index: 6~8  ── 3D 舞台常驻 HUD 控件、吸附提示、就地尺寸标注 (.stage-badge, .wb-inplace)
z-index: 1~3  ── 3D 舞台文档占位基座 (#stage)
z-index: 0    ── 文档背景流与主工作区 (#app, #firstscreen, #scroll-track, #display)
```

---

## §3 科技件 584 简化几何与多级名称回退规范 (Part 584 & Multi-Tier Fallback)

### 3.1 缺陷审计对账与唯一事实源 (Single Source of Truth)
根据独立审核缺陷 `ISSUE-R3-02`，科技轴套零件 `584`（`Technic Bush with One Flange`，包含 2 处轴孔受体）在参数化建模阶段因无法通过程序化自动切削孔洞，内部覆盖率仅为 0.54（`< 0.7`），被标识为简化几何。旧版系统中零件库卡片正确显示了徽标，但在右侧属性检查器（`#props-body`）和 BOM 材料清单（`#bom`）中完全缺失，且由于 `catalog` 中 `zh` 为空，BOM 清单将名称粗暴截断为裸数字 `584`。

**统一治理铁律**：所有视图组件（零件库、详情页、属性检查器、BOM 材料清单、鼠标拾取 HUD）**必须统一调用 `identity.js` 适配器**，严禁在各自业务逻辑中私自拼接名称或硬编码退化逻辑。

### 3.2 简化几何徽标设计规范 (Simplified Geometry Badge Specifications)

#### 视觉参数规范 (Visual Specs)
- **CSS 实体类名**：`.wb-lib-badge.is-simplified`（行内徽标）与 `.wb-lib-card-simplified`（卡片徽标）；
- **形态与尺寸**：
  - 容器形态：Pill（全圆角药丸胶囊），`border-radius: var(--radius-pill)` (999px)；
  - 整体高度：固定 `height: 20px`，`line-height: 18px`，`box-sizing: border-box`；
  - 水平内边距：`padding: 0 6px`；
  - 排版布局：`display: inline-flex; align-items: center; gap: 3px; vertical-align: middle;`；
- **颜色配置 (Attention Palette)**：
  - 背景颜色：`background: var(--attention-soft)` (`#FCF3E3`) 或 `rgba(255, 247, 235, 0.94)`；
  - 边框线宽：`border: 1px solid var(--attention-border)` (`#EEDCBC`)；
  - 文本与图标色：`color: var(--attention-text)` (`#8C5B0C`)；
  - 字体字阶：`font-size: 11px`, `font-weight: 600`, `letter-spacing: 0.02em`；
- **内嵌矢量图标**：
  - 采用 12×12px 等比内嵌 SVG 警告三角形：
    ```html
    <svg class="badge-ico" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8 1.5L1 14h14L8 1.5z"/>
      <path d="M8 6v3.5"/>
      <circle cx="8" cy="12" r="0.75" fill="currentColor"/>
    </svg>
    ```
- **文字文案**：固定中文「简化外形」；
- **无障碍与 Tooltip 交互**：
  - 原生 `title` 属性：必须输出完整技术诊断解释：
    `"简化外形：当前只画了近似外形，不代表零件实际形状（扣合与碰撞判据不受影响）；目录声明 2 处销孔/轴孔，参数化外形未绘制孔洞"`；
  - 读屏属性：`aria-label="简化外形，当前只画了近似外形，不代表零件实际形状"`。

### 3.3 跨模块呈现规范 (Cross-Module Presentation)

#### 1) 属性检查器 (#props-body) 布局规范
选中科技零件 584 时，`#props-body` 头部必须完整呈现以下两处视觉增强：
1. **主标题区**：
   - 零件主名称后紧跟 `.wb-lib-badge.is-simplified` 徽标（垂直居中对齐）；
   - 示例：`Technic Bush with One Flange（584） [⚠️ 简化外形]`。
2. **专属参数行（外形行）**：
   - 在「颜色」、「尺寸」下方增加独立参数行：
     - 字段名（Key）：`外形`
     - 字段值（Value）：包含徽标与解释文本：
       ```html
       <div class="prop-row">
         <span class="prop-k">外形</span>
         <span class="prop-v">
           <span class="wb-lib-badge is-simplified">...简化外形</span>
           <span class="prop-hint">（参数化外形未绘制销孔/轴孔）</span>
         </span>
       </div>
       ```

#### 2) BOM 物料清单 (#bom) 结构规范
BOM 清单中的每一项零件条目（`.bom-row`）必须强化结构化排布：
- **色块区 (`.bom-color-chip`)**：左侧 `20×20px` 真实色块（圆角 6px，浅边线）；
- **主标题行 (`.bom-name-main`)**：
  - 渲染三级回退后的主标题文本，并在末尾紧邻追加 `.wb-lib-badge.is-simplified` 胶囊徽标；
- **副标题行 (`.bom-name-sub`)**：
  - 规范显示 `零件编号 · 颜色名称`（如 `584 · 浅灰`）；
- **数量区 (`.bom-qty`)**：
  - 右侧显示等宽数字数量（如 `×1` 或 `×4`，字号 `13px`，字重 `600`）。

### 3.4 多级名称回退算法 (Multi-Tier Name Fallback Algorithm)

为彻底消灭裸数字（如 `584`）与无意义空白，制定三级确定性回退阶梯：

```
                    ┌──────────────────────────────────────────────┐
                    │ 传入零件定义 (def) 与零件编号 (partId)          │
                    └──────────────────────┬───────────────────────┘
                                           │
                                  def 是否存在有效对象？
                                   ├─────────────────── NO ──> 返回: Tier 3 (未知零件)
                                  YES
                                           │
                               def.zh 或 def.nameZh 是否非空？
                                   ├─────────────────── YES ─> 返回: Tier 1 (完整中文名)
                                  NO
                                           │
                               def.name (英文名) 是否非空？
                                   ├─────────────────── YES ─> 返回: Tier 2 (英文名 + 括号编号)
                                  NO
                                           │
                                           └─────────────────> 返回: Tier 3 (未知零件)
```

#### 阶梯定义表：

| 阶梯顺序 | 触发条件 | 主标题 (`primary`) | 副标题 (`secondary`) | 编号 (`tertiary`) | 示例展示效果 (以 584 为例) |
| :---: | :--- | :--- | :--- | :--- | :--- |
| **Tier 1 (中文名优先)** | 目录中具备非空 `zh` 或 `nameZh` | 中文名称（例：`基础砖 2x4`） | 英文官方原名（例：`Brick 2 x 4`） | 零件编号（例：`3001`） | `基础砖 2x4`<br><small>Brick 2 x 4 · 3001</small> |
| **Tier 2 (英文兜底+编号)** | 中文名为空，但具备有效英文名 `name` | **`${def.name}（${partId}）`** | 留空（避免重复） | 零件编号 | **`Technic Bush with One Flange（584）`**<br><small>584 · 浅灰</small> *(彻底消灭裸数字)* |
| **Tier 3 (未知身份兜底)** | 目录未收录或中英文均为空 | **`身份未知（${partId}）`** | 留空 | 零件编号 | **`身份未知（99999）`**<br><small>99999 · 颜色未指定</small> |

**算法参考实现代码**：
```javascript
export function partDisplayName(def, partId) {
  const id = String(partId || '').trim();
  // 分别 trim 保证纯空格字符串不会错误阻断备用中文名字段
  const zh = String(def?.zh || '').trim() || String(def?.nameZh || '').trim();
  const en = String(def?.name || '').trim();

  // Tier 1: 具备完整中文名
  if (zh) {
    return {
      primary: zh,
      secondary: (en && en.toLowerCase() !== zh.toLowerCase()) ? en : '',
      tertiary: id,
      known: true,
      tier: 1
    };
  }

  // Tier 2: 中文缺失，采用英文官方名 + 括号编号
  if (en) {
    return {
      primary: `${en}（${id}）`,
      secondary: '',
      tertiary: id,
      known: true,
      tier: 2
    };
  }

  // Tier 3: 未知零件或编号
  return {
    primary: `身份未知（${id || '未知'}）`,
    secondary: '',
    tertiary: id,
    known: false,
    tier: 3
  };
}
```

---

## §4 多视口响应式布局架构 (Multi-Viewport Responsive Architecture)

### 4.1 总体架构哲学与断点矩阵
工作台采用**“模型为绝对视觉中心、控制层逐级让步”**的响应式哲学。中间 3D 舞台视口绝对不允许发生挤压塌陷或宽度为 0 的情况。

#### 核心断点矩阵：

```
       Desktop Baseline                Laptop Compact                Tablet Portrait              Mobile Phone
        [ ≥ 1440 × 900 ]              [ 1280 ~ 1399 px ]            [ 768 ~ 1099 px ]            [ < 768 px (390×844) ]
┌──────────────────────────────┐┌────────────────────────────┐┌────────────────────────┐┌──────────────────┐
│ Topbar (48px)                ││ Topbar (48px)              ││ Topbar (48px compact)  ││ Topbar (2-row)   │
├──────────────────────────────┤├────────────────────────────┤├────────────────────────┤├──────────────────┤
│ Traybar (104px)              ││ Traybar (104px)            ││ Traybar (104px/96px)   ││ Traybar (96px)   │
├───────┬──────────────┬───────┤├───────┬────────────┬───────┤├───────┬────────────────┤├──────────────────┤
│ Tree  │ 3D Stage     │ Props ││ Tree  │ 3D Stage   │ Props ││ Tree  │ 3D Stage       ││ 3D Stage (100%)  │
│ 200px │ 1fr (≥960px) │ 280px ││ 180px │ 1fr(≥840px)│ 260px ││ 180px │ 1fr (≥588px)   ││ (min-h: 360px)   │
│       │              │       ││       │            │       ││ (opt) │ [Props Drawer] ││ [Tree Drawer]    │
├───────┴──────────────┴───────┤├───────┴────────────┴───────┤├───────┴────────────────┤│ [Props Drawer]   │
│ Statusbar (40px)             ││ Statusbar (40px)           ││ Statusbar (40px)       │├──────────────────┤
└──────────────────────────────┘└────────────────────────────┘└────────────────────────┘│ Statusbar (Drawer│
                                                                                        │  Toggles Active) │
                                                                                        └──────────────────┘
```

### 4.2 各视口详细网格排布与形变策略

#### 1) 1440×900 桌面基准视口 (Desktop Baseline)
- **网格定义**：`#workspace { display: grid; grid-template-columns: 200px minmax(0, 1fr) 280px; height: 100%; }`
- **顶栏 (`#topbar`)**：单行 48px，左右两端对齐，中间常驻模式分段器（搭建 / 试玩）；
- **待选栏 (`#traybar-region`)**：高度 104px，左侧引导区 128px（零件库大按钮 +「待选 N 种」），卡片 `88×88px` 单行横滚；
- **左侧树 (`#tree`)**：常驻 200px 宽度，展示模块、骨架层级与未分组零件；
- **中间舞台 (`#stage`)**：自适应拉伸，实测可用宽约 960px，可用高 ≥ 588px；
- **右侧属性栏 (`#props`)**：常驻 280px 宽度，展示选中零件名称、颜色、位姿、外形 Badge 与连接树；
- **零件库模态框**：居中浮动卡片，尺寸 `min(1120px, 100vw - 64px) × min(760px, 100vh - 64px)`，左侧分类 160px，右侧网格排布为 5~6 列（每列 ≥160px，gap 16px）。

#### 2) 1280×800 小屏笔电视口 (Laptop Compact)
- **网格定义**：`#workspace { grid-template-columns: 180px minmax(0, 1fr) 260px; }`
- **形变策略**：
  - 左侧模块树收窄为 180px；
  - 右侧属性栏收窄为 260px；
  - 中间 3D 舞台保持宽 ≥ 840px，模型包围盒构图毫无裁剪；
- **零件库模态框**：宽度收敛为 1216px（受限于 `100vw - 64px`），左侧分类收窄至 120px，右侧网格自适应排布为 4~5 列。

#### 3) 768×1024 平板竖屏视口 (Tablet Portrait)
- **网格定义**：`#workspace { grid-template-columns: 180px minmax(0, 1fr) 0; position: relative; }`
- **右侧属性栏抽屉化 (Props Drawer)**：
  - 属性栏脱离网格流，转为绝对定位滑动抽屉：
    ```css
    #props {
      position: absolute; right: 0; top: 0; bottom: 0; width: 288px;
      z-index: 20; background: var(--panel);
      box-shadow: var(--shadow-drawer);
      transform: translateX(100%);
      transition: transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
    }
    body[data-props="drawer"] #props { transform: translateX(0); }
    ```
  - 默认隐藏抽屉，中间 3D 舞台独占横向宽度（≥ 588px）；
  - 当选中零件或点击底栏按钮时，抽屉平滑滑出覆盖在舞台右侧；
- **待选栏**：高度微调为 96px，卡片为 80×80px。

#### 4) 390×844 移动手机视口 (Mobile iPhone)
- **单列垂直堆叠**：`#workspace { grid-template-columns: minmax(0, 1fr); }`；
- **顶栏折叠为双行 (2-Row Grid)**：
  ```css
  #topbar {
    height: auto; min-height: 84px; padding: 6px 12px;
    grid-template-areas: "left right" "center center";
  }
  ```
  第一行展示品牌 Logo 与菜单入口，第二行撑满展示搭建/试玩切换器；隐藏不常用撤销/重做按钮；
- **双侧边栏完全抽屉化**：
  - `#tree` 转为左侧滑出抽屉（宽 240px，`z-index: 20`）；
  - `#props` 转为底部半屏抽屉（高度最高 `45vh`，圆角 `20px 20px 0 0`，`box-shadow: var(--shadow-bottom-drawer)`）；
- **底部状态栏强化 (`#statusbar`)**：
  - 常驻激活 `.sb-drawer-btn` 快捷按钮（`[结构]`、`[属性]`），提供触手可及的单手呼出交互。

### 4.3 390px 移动端零件库全屏 Sheet 规格

在 390px 视口下，桌面端居中弹窗彻底失效，必须全面形变为**移动端全屏抽屉/覆层（Full-screen Sheet/Overlay）**：

```
┌────────────────────────────────────────────────────────┐
│ 零件库移动全屏 Sheet (100vw × 100dvh)                   │
├────────────────────────────────────────────────────────┤
│ [零件库]                              [关闭 X] (44px)   │
├────────────────────────────────────────────────────────┤
│ 🔍 [搜索零件编号/名称/尺寸...]                 [清除]  │
├────────────────────────────────────────────────────────┤
│ 横向滚动分类 Chips (高度 44px, overflow-x: auto)        │
│ [ 全部 (165) ] [ SNOT侧装 (18) ] [ 基础板 (24) ] ...   │
├────────────────────────────────────────────────────────┤
│ 双列零件卡片网格 (CSS Grid 2 列, 每列 ≥160px)           │
│ ┌──────────────────────┐  ┌──────────────────────────┐ │
│ │ [Card: 3001]         │  │ [Card: 584 ⚠️简化]       │ │
│ │ 基础砖 2x4           │  │ Technic Bush (584)       │ │
│ └──────────────────────┘  └──────────────────────────┘ │
│ ┌──────────────────────┐  ┌──────────────────────────┐ │
│ │ [Card: 87087]        │  │ [Card: 3023]             │ │
│ └──────────────────────┘  └──────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

1. **容器重构与动态视口高度（dvh）**：
   - 弹窗去除桌面端 32px 边距：`.wb-lib-overlay { padding: 0; }`；
   - 弹窗占满全屏：`width: 100vw; height: 100vh; height: 100dvh; border-radius: 0;`；
   - **防御机制**：必须优先采用 `100dvh`，杜绝 iOS Safari / Android Chrome 底部导航栏收起与伸展引起的视口跳动与按钮截断。
2. **分类栏横向滑动 Chips 化**：
   - 分类容器 `.wb-lib-cats` 由竖栏转为横条：
     ```css
     .wb-lib-cats {
       width: 100%; flex: none; display: flex; gap: 8px;
       overflow-x: auto; -webkit-overflow-scrolling: touch;
       padding: 8px 12px; border-right: 0; border-bottom: 1px solid var(--hair);
     }
     .wb-lib-cat {
       flex: none; min-height: 36px; padding: 0 12px;
       border: 1px solid var(--border); border-radius: var(--radius-pill);
     }
     .wb-lib-cat[aria-pressed="true"] {
       background: var(--accent-soft); border-color: var(--accent); color: var(--accent-text);
     }
     ```
3. **网格双列自适应**：
   - `grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; padding: 10px;`，卡片高度压至 192px，缩略图高 112px。

### 4.4 虚拟滚动全高度链保护规范 (Virtualization Height Chain Protection)
在移动端 Column 布局下，若任何一层父容器未约束最小高度，内部虚拟滚动的 510,000px 占位高度将把父容器撑爆，导致虚拟化引擎误判视口高度为几十万像素，进而在单帧内把全量卡片（4,000+ DOM 节点）同步挂载，彻底卡死主线程（**历史缺陷 ISSUE-05**）。

**防御铁律（全链路 `min-height: 0`）**：
```css
/* 虚拟滚动真实祖先链每一层均必须施加 min-height: 0 约束 (剔除非真实幽灵类，严格匹配真实 DOM) */
.wb-lib-dialog   { display: flex; flex-direction: column; min-height: 0; }
.wb-lib-main     { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: hidden; }
.wb-lib-right    { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.wb-lib-scroll   { flex: 1 1 auto; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; }
```

**双硬顶拦截限制 (Dual-Cap Safety Valve)**：
- `MAX_RENDER_ROWS = 60`（单次渲染最大行数）；
- `MAX_RENDER_CARDS = 120`（单次渲染最大卡片数）；
- 在计算虚拟卡片范围时实施双重钳制：
  `activeRows = Math.max(1, Math.min(60, Math.ceil(viewportHeight / rowHeight)));`  
  `activeCards = Math.min(120, activeRows * cols);`  
  即便样式极端异常，DOM 节点总数也绝不会突破 120 个。

---

## §5 3D 舞台钉扎与滚动协同架构 (3D Stage Pinning & Scroll Coordination)

### 5.1 缺陷根因深度诊断 (Root-Cause Diagnosis of ISSUE-R3-01)
在独立审核中，通过 CDP 采样技术捕获到在 `window.scrollTo(0, 428)` 突变滚动期间：
- **Frame 0 (静止态)**：`scrollY = 0`, `canvasTop = 152px`, `minY = 320.4px` (模型正常居中)；
- **Frame 1 (突变当帧)**：`scrollY = 428`, `canvasTop = -276px`, **`minY = -94.7px` (模型脱屏飞出视口上顶边，`isOffScreen = true`)**；
- **Frame 2 (次帧恢复)**：`canvasTop` 恢复修正，`minY = 248.1px`。

```
[时间轴错位示意图]
时间点 T0 (用户突发快速滑轮 / scrollTo):
│
├─► 浏览器合成线程 (Compositor Thread):
│   立即按新的 scrollY 移动普通文档流: stageTop = 152 - 428 = -276px!
│   由于 #viewport 当帧仍然处于绝对定位 (position: absolute; inset: 0)，画布被同步上拖至 -276px!
│   【💥 致命缺陷：模型在屏幕上 minY 跌至 -94.7px，产生 1 帧严重出屏闪烁】
│
└─► 主线程 JavaScript 引擎 (rAF 节流队列):
    等待当前渲染管线调度... (耗时 9.5ms ~ 16.6ms)
    下一帧 rAF 回调执行：读取 scrollY，将 #viewport 切换为 position: fixed 并修正坐标。
    【画面产生单帧剧烈向下拉回抽搐】
```

### 5.2 稳定基座固定钉扎机制 (Stable Base Pinning Specification)
为了彻底消灭合成线程与主线程的 1 帧时差，**废除“滚动后才切换为 fixed”的旧机制，确立稳定基座铁律**：

```
[修复模式：稳定基座固定钉扎架构 (含动态视口坐标同步机制)]

1. 基座样式契约 (CSS Specification):
#viewport.is-pinned {
  position: fixed;        /* 基座恒定常驻 fixed，完全脱离文档流滚动 */
  /* 物理几何坐标与宽高不再硬编码固定数值，由 ResizeObserver 与视口监听动态写入 inline style */
  pointer-events: auto;
  will-change: transform;
}
#stage {
  /* 仅在普通文档流中作为动态布局占位块，由三栏 Grid 动态计算实际流式尺寸 */
  visibility: hidden;
}

2. 动态多视口与屏幕旋转同步机制 (Dynamic Viewport & Orientation Sync):
```javascript
/**
 * 将 fixed 视口物理基座与流式占位框 #stage 毫秒级像素对齐
 * 支持 1440/1280/768/390 断点切换、窗口 Resize 及移动端横竖屏切换
 */
function syncPinnedViewportBounds() {
  const stageEl = document.getElementById('stage');
  const viewportEl = document.getElementById('viewport');
  if (!stageEl || !viewportEl) return;

  const rect = stageEl.getBoundingClientRect();
  viewportEl.style.left = `${Math.round(rect.left)}px`;
  viewportEl.style.top = `${Math.round(rect.top)}px`;
  viewportEl.style.width = `${Math.round(rect.width)}px`;
  viewportEl.style.height = `${Math.round(rect.height)}px`;
}

// 使用 ResizeObserver 监听占位容器，尺寸微变即刻静默对齐
const stageResizeObserver = new ResizeObserver(() => {
  syncPinnedViewportBounds();
});
stageResizeObserver.observe(document.getElementById('stage'));

window.addEventListener('resize', syncPinnedViewportBounds, { passive: true });
window.addEventListener('orientationchange', syncPinnedViewportBounds, { passive: true });
```

滚动事件突变发生当帧 (Frame 1):
- 文档流向上平移，但 #viewport 本身常驻 fixed，不受任何文档平移拖拽，基座坐标绝对不动！
- 消除“先滚走再纠正”的时间窗口，跨断点与全分辨率下出屏跳变从物理上降为 0！
```

### 5.3 硬件加速形变与阻尼平滑动力学 (Hardware-Accelerated Dynamics)

1. **零重排与 GPU 硬件加速**：
   - 过渡全过程**严禁修改 `left`、`top`、`width`、`height`**；
   - 严禁每帧触发 Three.js `renderer.setSize()`（避免反复销毁重建 WebGL Framebuffer）；
   - 纯粹通过 CSS 2D 硬件矩阵承载形变：
     ```css
     transform: translate3d(dx, dy, 0) scale3d(sx, sy, 1);
     transform-origin: 0 0;
     ```
2. **滚动行程与分段规划 (`SCROLL_STAGES`)**：
   - 滚动过渡总行程：精准设定为 **`1.0 × 视口高 (100vh)`**；
   - 归一化进度计算：`p = Math.max(0, Math.min(1, window.scrollY / maxScroll))`；
   - 关键元素联动阶段：
     - `modelMove: [0.0, 1.0]`：自滚动首个像素（`scrollY > 0`）起，模型立即连续插值平滑缩小并向左侧平移；
     - `toolsFadeOut: [0.0, 0.25]`：待选区与搭建浮动 HUD 在前 25% 行程内线性淡出（`opacity: 1 -> 0`），并解绑点击事件；
     - `controlsFadeIn: [0.60, 1.0]`：展示控制栏与 BOM 清单在后 40% 行程内平滑淡入（`opacity: 0 -> 1`）；
     - `displayScale = 0.68`：模型在展示区的构图尺寸恒定为搭建构图的 68%。
3. **混合平滑收敛阻尼算法**：
   - 动态跟手期（持续滚动中）：采用时间常数 $\tau = 60\text{ms}$ 的一阶指数平滑滤波，保证与鼠标滚轮/手势完全贴合；
   - 停滚收敛期（停止输入后）：在 120ms ~ 200ms 区间内接入高阶连续收尾曲线，在 200ms 内误差硬指标归零（$\le 10^{-4}$），反向滚动立即反转，无排队滞留。
4. **全过程安全取景构图保护 (Safe Framing Bounds)**：
   - 视口绝对安全顶线：`safeTop = TOPBAR_H (48px) + 8px = 56px`；
   - 视口绝对安全底线：`safeBottom = vh - 8px`；
   - 在任何连续位移或突变下，模型 3D 外接盒（所有顶点相机投影）必须恒定满足：
     `minY ≥ safeTop` 且 `maxY ≤ safeBottom`，`isOffScreen === false`。

---

## §6 核心组件全状态规范矩阵 (Component State Matrix)

针对第四项需求（R4），对零件卡片、分类选择器、搜索过滤控件及待选栏制定完整的六维状态矩阵（Default, Hover, Active/Selected, Disabled, Focus-Visible, Empty/Loading）。

### 6.1 零件库卡片组件 (`.wb-lib-card`)
- **物理规格**：最小宽度 `160px`，高度 `208px`（移动端宽自适应，高 `192px`）；
- **结构分区**：上部缩略图 `128px`，中部零件名 `34px`（最多两行，超过截断并显示省略号），下部元信息 `18px`。

| 状态 (State) | 边框与阴影 (Border & Shadow) | 背景色 (Background) | 内部元素与徽标行为 | 光标与反馈 |
|---|---|---|---|---|
| **Default** (常规) | `1px solid var(--border)` (`#E0E4EA`)，无投影 | `#FFFFFF` | 灰模 3D 缩略图居中；若是简化件展示左上角黄色 Badge | `cursor: pointer` |
| **Hover** (悬停) | `1px solid #C6CEDA`，`box-shadow: var(--shadow)` | `#FFFFFF` | 缩略图平滑放大 `scale(1.02)`（120ms 缓动），卡片浮起 | `cursor: pointer` |
| **Active / Selected** (选中) | `1px solid var(--accent)` (`#3769E8`)，扩散光晕 `box-shadow: 0 0 0 2px var(--accent-glow)` | `var(--accent-soft)` (`#EAF0FE`) | 零件名加粗 `font-weight: 600`，触发飞入动画并打开详情 | `cursor: pointer` |
| **Focus-Visible** (键盘聚焦) | `1px solid var(--accent)`，`outline: 2px solid var(--accent); outline-offset: 1px` | `#FFFFFF` | 键盘 Tab 聚焦，Enter 或 Space 键触发选中装配 | 清晰蓝色聚焦环 |
| **Disabled / Exhausted** (禁用) | `1px dashed var(--border)`，整体 `opacity: 0.45` | `var(--soft)` (`#F5F6F8`) | 缩略图黑白去色滤镜，角标显示「库存为 0」 | `cursor: not-allowed`，禁用一切点击 |
| **Empty / Ghost** (几何缺失占位) | `1.5px dashed #D7DBE2`，带微弱斜线纹理 | `#F0F2F5` | 居中显示虚线零件轮廓占位符，标注「几何未就绪」 | `cursor: pointer`，允许查看文字详情 |

### 6.2 分类选择器与过滤标签 (`.wb-lib-cat` / `.wb-lib-subcat`)

#### 1) 侧边栏主分类项 (`.wb-lib-cat`)
- **结构**：高 `40px`，左侧图标与分类名，右侧等宽数字数量角标（`tabular-nums`）；
- **四位一体高亮契约**：分类项被选中时，严禁仅依靠文字颜色区分，必须同时满足：
  1. `aria-pressed="true"`（无障碍语义）；
  2. 浅蓝强调底色 `background: var(--accent-soft)`；
  3. 左侧 3px 绝对定位竖条 `border-left: 3px solid var(--accent)`；
  4. 文字加粗 `font-weight: 700` 与强调色文字 `color: var(--accent-text)`。

| 状态 (State) | 视觉表现 (Visual Representation) | 辅助指示物 (Affordance) | 无障碍属性 (A11y) |
|---|---|---|---|
| **Default** | 背景透明，文字 `14px var(--text)`，数量 `12px var(--text2)` | 无标记 | `aria-pressed="false"` |
| **Hover** | 背景色变 `var(--soft)` (`#F5F6F8`)，文字轻微加深 | 无标记 | `aria-pressed="false"` |
| **Active / Pressed** | 背景 `var(--accent-soft)`，文字 `var(--accent-text)` 加粗，内阴影 `inset 0 0 0 1px rgba(55,105,232,.18)` | **左侧 3px 纵向强调条**（`var(--accent)`） | `aria-pressed="true"` |
| **Focus-Visible** | 聚焦框 `outline: 2px solid var(--accent); outline-offset: -2px` | 键盘上下箭头快速巡检 | 焦点环清晰 |
| **Disabled** | 文字 `opacity: 0.35`，背景透明 | 数量显示 `-` | `aria-disabled="true"`, `cursor: not-allowed` |

#### 2) 子分类胶囊标签 (`.wb-lib-subcat`)
- **形态**：Pill 胶囊，高 `28px`，内边距 `0 10px`；
- **状态参数**：
  - **Default**：白底，边框 `1px solid var(--border)`，文字 `12px var(--text2)`；
  - **Hover**：底色变 `var(--soft)`，文字加深；
  - **Active**：边框 `var(--accent)`，底色 `var(--accent-soft)`，文字 `var(--accent-text)`（字重 700）；
  - **Disabled**：置灰隐藏或透明度 `0.35`。

### 6.3 搜索输入框与清除过滤控制 (`.wb-lib-searchinput`, `.wb-lib-clearbtn`)

#### 1) 搜索输入框 (`.wb-lib-searchinput`)
- **形态与尺寸**：高度 `40px`，圆角 `10px`，左侧内嵌放大镜搜索图标（偏移 12px），右侧预留 36px 清除按钮空间；
- **状态矩阵**：
  - **Default**：白底，边框 `1px solid var(--border)`，占位文案「搜索名称、编号或尺寸（例如 584、2x4、轴套）」，颜色 `var(--text2)`；
  - **Hover**：边框变深为 `#C6CEDA`；
  - **Focus**：边框高亮 `border-color: var(--accent)`，外围扩散 `box-shadow: 0 0 0 3px var(--accent-glow)`，移除浏览器默认 outline；
  - **Disabled**：背景 `#F5F6F8`，禁止输入，光标 `not-allowed`。

#### 2) 清除按钮 (`.wb-lib-clearbtn`)
- **显隐交互**：输入框文本长度 `input.value.length > 0` 时动态淡入；无输入内容时绝对隐藏（`display: none`）；
- **点击行为**：点击后立即清空内容，保持焦点留在输入框中（`input.focus()`），触发防抖检索还原并重置网格数据。

#### 3) 空搜索结果态 (`.wb-lib-empty`)
- **布局**：横跨整个结果网格（`grid-column: 1 / -1`），最小高度 260px，居中图文排布；
- **视觉层级**：
  - 标题（16px 字重 600）：`“没有找到与 “{query}” 匹配的零件”`；
  - 辅助文字（13px `var(--text2)`）：`“请尝试搜索零件编号（如 3001、584）、基础英文名或切换分类”`；
  - 一键操作：主按钮 `[清除搜索条件]`，点击直接清空搜索框并选中「全部」分类。

### 6.4 待选区 / 拾取栏 (`#traybar-region`, `.wb-tray`, `.wb-tray-card`)

待选区（统一命名为「待选区」，废除旧称「候选区」）位于工作台顶栏正下方，承载搭建所需的零件暂存、配色与调度。

#### 1) 待选卡全状态 (`.wb-tray-card`)
- **尺寸排版**：尺寸 `88×88px`（移动端 `80×80px`），卡片圆角 `12px`，上部 `60px` 预览图，右下角数量角标，左下角 12px 颜色圆点（`.wb-tray-dot`），右上角三点菜单触发按钮（`.wb-tray-menu`）。

| 状态 (State) | 边框与视觉表现 (Visual Representation) | 交互与动画响应 (Interaction & Motion) |
|---|---|---|
| **Default** | `1px solid var(--border)`，白底 | 展示当前选定颜色与剩余件数（自由搭建显示 `∞`） |
| **Hover** | `1px solid #C6CEDA`，轻量浮起阴影，右上角 `...` 菜单图标淡入显示 | 悬停提示零件中文/英文名与对应颜色码 |
| **Selected** (已取出装配) | `1px solid var(--accent)`，外扩散 `box-shadow: 0 0 0 1px var(--accent)` | 3D 舞台出现半透明跟随幽灵预览模型 |
| **Dragging** (拖拽中) | 透明度降至 `0.55`，原卡片保留阴影占位 | 3D 舞台边缘呈现绿色虚线吸附框提示 |
| **Just-Added Flash** (刚添加入条) | 触发 `@keyframes wb-flash` 缩放脉冲动画（`scale(1.08)`，持续 360ms） | 配合零件库飞行动画无缝落地 |
| **Exhausted** (配额耗尽) | `opacity: 0.45`，去色滤镜，角标显示「已用完」 | 禁用取件点击与拖拽放置 |

#### 2) 原生拖拽与类型分流安全规范 (Native Drag & Drop Specification)
为彻底杜绝用户拖动待选零件到 3D 舞台时，被系统当作“外部拖入模型 JSON 文件”而触发文件解析崩溃，必须施加**私有 MIME 数据通道分流**：
- **自定义私有数据类型**：`application/x-brickkit-tray-card`；
- **载荷数据契约**：
  ```json
  {
    "type": "brickkit-tray-card",
    "partId": "584",
    "color": 7,
    "sourceTrayId": "tray-card-584-c7"
  }
  ```
- **舞台监听逻辑**：
  - 3D 舞台 `#stage` 监听 `dragenter` / `dragover`：
    ```javascript
    stageEl.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('application/x-brickkit-tray-card')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        showStageDropIndicator(true); // 显示绿色虚线装配引导框
      }
    });
    ```
  - 外部常规文件（如 `.png`、`.brick.json`）走独立的文件输入管理器 `file-input.js`，绝不混淆。

#### 3) 待选栏空状态与设置面板
- **空状态占位 (`.wb-tray-empty`)**：待选卡片数量为 0 时呈现，居中展示两颗凸点乐高灰模插图 + `“待选区为空，请点击左侧 “零件库” 挑选零件”` + `[打开零件库]` 强调按钮；
- **设置零件面板 (`.wb-set`)**：
  - 点击待选卡右上角菜单唤起 288px 浮层；
  - 顶部集成 9 列官方经典色盘（黑、白、红、黄、蓝、浅灰、深灰、绿、橙等）；
  - 底部提供「复制为其他颜色」（自动寻找空闲颜色克隆新卡）与「移出待选区」动作。

---

## §7 工程落地核验与实施准则 (Implementation & Verification Checklist)

为了供后续工程团队将本规范与原型方案无缝移植到生产项目，制定工程落地核验清单：

### 7.1 缺陷与需求核验清单 (Defect & Requirements Checklist)

- [ ] **CH-01 [R1 / ISSUE-R3-02] 属性检查器 Badge 落地**：
  - 在 `#props-body` 主标题区渲染 `.wb-lib-badge.is-simplified` 徽标；
  - 增加「外形」专属参数行，显示简化几何说明与诊断信息；
  - 针对零件 584，确保无中文名时准确显示 `Technic Bush with One Flange（584）`。
- [ ] **CH-02 [R1 / ISSUE-R3-02] BOM 清单与三级回退落地**：
  - 改造 `#bom` 渲染器，在标题行内联嵌入 `.wb-lib-badge.is-simplified`；
  - 严格执行 Tier 1 (zh) -> Tier 2 (en + partId) -> Tier 3 (身份未知 + partId) 阶梯，彻底杜绝裸数字输出。
- [ ] **CH-03 [R2] 四视口网格与断点形变落地**：
  - 1440 宽（200px 1fr 280px）、1280 宽（180px 1fr 260px）；
  - 768 宽平板竖屏：右侧属性栏转为绝对定位 288px 浮动抽屉；
  - 390 宽移动手机：双侧边栏完全抽屉化，底栏激活抽屉触发按钮。
- [ ] **CH-04 [R2] 移动端零件库与虚拟滚动高度链**：
  - 零件库在 `<768px` 时转换为 `100vw × 100dvh` 全屏抽屉；
  - 分类转为顶部横向滚动 Chips；
  - 确保 `.wb-lib-dialog` 到 `.wb-lib-scroll` 全链路施加 `min-height: 0`；
  - 实施 `MAX_RENDER_ROWS=60` 与 `MAX_RENDER_CARDS=120` 双硬顶。
- [ ] **CH-05 [R3 / ISSUE-R3-01] 稳定基座固定钉扎机制**：
  - `#viewport.is-pinned` 自首屏初始化起即声明为 `position: fixed`；
  - 滚动过渡期间仅通过 CSS `transform: translate3d(...) scale3d(...)` 承载位移；
  - 杜绝在滚动时逐帧调用 `renderer.setSize()`；
  - 保证突变滚动下 `minY ≥ 56px`，出屏跳变为 0。
- [ ] **CH-06 [R4] 组件全状态与拖拽分流**：
  - 零件卡片、分类选择器、搜索框完成 Default/Hover/Active/Focus/Disabled/Empty 6 状态对接；
  - 分类项满足四位一体高亮契约；
  - 待选卡拖拽使用私有 MIME 类型 `application/x-brickkit-tray-card` 分流。
- [ ] **CH-07 [R5] 独立轻量原型单文件验证**：
  - 独立单文件 `docs/workbench-plan/ui-prototype.html` 离线双击即可完整运行；
  - 包含视口切换器与四大缺陷/需求动态演示模块；
  - 严格确认未修改 `D:/Project/brickkit-workbench/src/` 与 `dist/` 任何生产代码。

---
*本文档为 BrickKit 工作台 UI 交互优化之正式工程技术标准，已同独立交互原型 `ui-prototype.html` 完成双向对账。*
