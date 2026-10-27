# BrickVLM 训练架构（Phase 4：合成数据引擎 + 物理奖励）

> 本文只描述**数据与奖励工具**，不含模型训练实现。所有数字与命令都可在本仓库复跑复核。
>
> 相关代码：
> - `tools/gen-training-steps.mjs` —— SFT 多模态合成数据器
> - `tools/brickvlm-reward.mjs` —— 物理 + 视觉 RLVR 奖励（要求纯函数可单测）
> - `tools/lib/snap-gt.mjs` —— 步骤分组 / GT 抽取 / 质量门禁 / 可选反解
> - `tools/lib/open-studs.mjs` —— 空闲凸点计算（复制自 `cli/brickkit.mjs#computeOpenStuds`）
> - `test/brickvlm.test.mjs` —— 端到端 + 奖励 + 假连接门禁测试

---

## 1. 模型定位：Step-Level Snap Predictor

BrickVLM 不是「看图生模型」的通用 VLM，而是一个**单步装配动作预测器**：

- **基座**：Qwen2.5-VL-3B / 7B（已具备中文指令跟随与细粒度空间定位能力，3B 用于边缘/批量 rollout，7B 用于质量上限对照）。
- **任务**：给定「当前已拼到第 t−1 步的模型状态图（凸点带编号标签）」+「第 t 步的说明书风格图」+ 本步零件清单，
  输出一个**恰好 6 个字段**的动作数组，每个动作把一颗零件扣到一个**画面中可见的凸点标签**上。
- **为什么限定为「单步」**：多步联合输出会让错误归因困难，且无法与引擎的逐步校验对齐；
  单步预测可以直接用 `snapPart` + `partsCollide` + `validate` 做**确定性可验证奖励**（RLVR 的前提）。
- **不做的事**：不生成最终 `.brick.json`（由 Harness 逐步累积）、不识别自由拍摄照片里的零件（那是重建任务，非本模型职责）、不生成拼装顺序（step 由说明书给定）。

### 1.1 输入输出契约

**输入（一条 ShareGPT 样本的 user 段）**

| 段 | 内容 |
|---|---|
| `image[0]` | 状态图：第 `t−1` 步渲染，`--show-studs` 打开，空闲凸点画 `p019#4` 形式标签 |
| `image[1]` | 说明书风格图：第 `t` 步渲染（装完本步之后），不带标签；渲染失败时**不塞重复图**，而是 `meta.manual_available=false` |
| `text` | `本步需安装：[{"part","color","qty"}...]。可用的凸点：[{"label","part","stud","kind","dir"}...]` |

**系统提示词**（逐字固定，`meta.systemPrompt` 同步记录）

```
你是乐高说明书拼装器。根据说明书步骤图与当前模型（已标注空闲凸点编号）输出 JSON 数组，
每项 {"part","color","on","stud","receptor","rot"}。只能引用画面中可见的凸点标签。
```

**输出（assistant 段，`{"type":"json","value":[...]}`）**

```json
[{"part":"18892","color":0,"on":"p001","stud":12,"receptor":0,"rot":0}]
```

字段语义（与 `src/core/core.js#snapPart` 完全一致，无自定义语义）：

| 字段 | 含义 | 取值约束 |
|---|---|---|
| `part` | 零件编号 | 必须存在于合并目录（curated 165 + LDraw 扩充） |
| `color` | LDraw 颜色代码 | 必须存在于 `catalog/colors.json` |
| `on` | 父零件 id | 必须是**画面中可见**的零件（状态图里已安装的件） |
| `stud` | 父件凸点编号 | `partConnectors(parent).studs[stud]` 必须存在 |
| `receptor` | 子件底孔编号 | `partConnectors(child).receptors[receptor]` 必须存在 |
| `rot` | 绕子件 up 轴旋转 | `0/90/180/270` |

**关键约束**：`on` 与 `stud` 组合出的标签必须出现在输入文本的「可用凸点」列表里——即**禁止引用画面外/未安装零件的标签**。这既由数据生成保证（见 §3），也由训练时的格式校验与奖励的 `snapMatch` 惩罚保证。

---

## 2. 数据集 schema（ShareGPT 多模态，JSONL 一行一条）

```json
{
  "messages": [
    {"role": "system", "content": "<固定系统提示词>"},
    {"role": "user", "content": [
      {"type": "image", "image": "out/dataset/img/60239-step08-state-marked.png"},
      {"type": "image", "image": "out/dataset/img/60239-step08-manual.png"},
      {"type": "text",  "text": "本步需安装：[...]。可用的凸点：[...]"}
    ]},
    {"role": "assistant", "content": [
      {"type": "json", "value": [{"part":"18892","color":0,"on":"p001","stud":12,"receptor":0,"rot":0}]}
    ]}
  ],
  "meta": {
    "model": "sub-front-bumper",
    "step": 34,
    "base_step": 33,
    "manual_available": true,
    "open_stud_count": 2,
    "gt_count": 1,
    "gt_provenance": ["snap"],
    "render_mode": "synthetic_step_render",
    "manual_source": "synthetic_step_render",
    "gt_deferred_same_step": 0,
    "gt_target_stud_occupied": 0
  }
}
```

`meta` 字段全部是**审计信息**，不参与训练 loss，但必须保留：

- `gt_provenance`：`["snap"]` = GT 逐条来自模型 `parts[].snap`（权威）；`["derived"]` = 来自引擎验证的反解（见 §3.2）。两者**禁止混作同一数据源**。
- `gt_deferred_same_step`：本步内「父件也在本步安装」的 GT 条数（状态图上没有该标签，已被剔除出答案）。
- `gt_target_stud_occupied`：目标凸点在基准状态已被占用/不可见的条数（已剔除）。
- `manual_source`：`synthetic_step_render` / `real_manual_page` / `null`。

配套的 `*.meta.json`（数据集级清单，由 `--meta` 指定，默认 `<out>.meta.json`）：

```json
{
  "format": "brickvlm-sft-manifest", "version": "1.0",
  "systemPrompt": "...", "actionFields": ["part","color","on","stud","receptor","rot"],
  "render": {"enabled": true, "az": 35, "el": 26, "w": 800, "h": 600,
             "studLabelConvention": "空闲凸点标签 = `${partId}#${studIndex}`",
             "calls": 36, "failed": 0, "manualRenderFallbackToState": 0,
             "avgMsPerCall": 5620, "images": 36},
  "modes": {"allowDerivedSnap": false, "manualDir": null},
  "totals": {"models": 9, "samples": 18, "gtItems": 27, "gtPerSample": 1.5,
             "avgOpenStuds": 10, "images": 36,
             "samplesWithManualImage": 18, "samplesWithoutManualImage": 0,
             "dropped": 12, "dropReasons": {"no-snap-parts": 10, "parent-in-same-step": 2}},
  "perModel": {"<modelId>": {"steps": 6, "samples": 5, "dropped": 1, "dropReasons": {...},
                             "avgOpenStuds": 5, "derivedSnapParts": 0,
                             "gtProvenance": {"snap": 8},
                             "samplesEmitted": 5, "images": 10, "partsWithSnap": 11}},
  "droppedDetail": [{"model": "...", "step": 31, "reason": "no-snap-parts", "detail": "...", "parts": ["p001","p002"]}]
}
```

---

## 3. 合成数据管线

### 3.1 步骤

```
.brick.json ──groupByStep──► 每步 t 的零件集
                                  │
                    ┌─────────────┴─────────────┐
                    │  ① GT = parts[].snap       │  无 snap → 根件，不计入 GT
                    │     逐条 6 字段抄写        │
                    └─────────────┬─────────────┘
                                  ▼
                    ② 父件必须在基准状态（step < t）
                                  ▼
                    ③ partsConnected 物理复核（假连接 → 整步丢弃）
                                  ▼
                    ④ 目标凸点必须在 step ≤ t−1 的空闲凸点表里
                                  ▼
        ⑤ 渲染：状态图(--step t-1 --show-studs) + 说明书图(--step t)
                                  ▼
                    ⑥ 组装 ShareGPT 样本 + 写 meta
```

### 3.2 Ground Truth 的两条来源（严格区分）

| `gt_provenance` | 含义 | 启用条件 |
|---|---|---|
| `snap` | **逐字段抄自** `parts[].snap`（`on`/`stud`/`receptor`/`rot`）。这是唯一默认接受的真实标注来源。 | 模型自带 snap 树 |
| `derived` | 模型**没有** snap 树时，从权威 `at/rot/up` 用引擎反解出**唯一**物理扣合。 | 必须显式传 `--allow-derived-snap` |

反解（`deriveSnapCandidates`）的四重约束，缺一不可：

1. `snapPart(父, 凸点, 子, 底孔)` 算出的 `at` 与原 `at` **逐位相等**（1e-7），`up`/`rot` 也一致；
2. `partsConnected` 成立；
3. 父件在子件之前安装（`parts` 数组顺序 + `step` 都早于子件）；
4. **物理接触身份唯一**——把「父件 id + 凸点世界坐标 + under 标志」当身份，底孔编号等价的组合取最小号；
   出现第二个不同身份 → 该件判为歧义，**不产出 GT**。

> 为什么默认关掉：`examples/*.brick.json`（5 个模型，368 件）**全部没有 `snap` 字段**（历史生成器用 `mount`/显式 `at` 定位）。
> 实测反解覆盖率（`parts` 中能唯一反解的比例）：60239 22/91 唯一、30 歧义、39 无解；
> mecha 26/83、cottage 15/75、lantern 58/78、trex 10/41。
> 歧义主要来自「多排底孔扣同一颗凸点」（如 4×2 板有 4 排）——这在物理上不可区分，但对**训练标签**是可区分的，
> 因此不能拿它冒充真实标注。需要更多样本时必须先补齐 snap 树，或用 `--allow-derived-snap` 并接受 `derived` 标记。

### 3.3 质量门禁（每一类都会进 `dropReasons` 计数）

| 门禁 | 条件 | 处置 | `reason` |
|---|---|---|---|
| 假连接 | GT 任一 `partsConnected` 为 false | **整步样本丢弃** | `false-connection` |
| 根件 | 该步全部零件无 `snap` | 整步丢弃 | `no-snap-parts` |
| 父件同一步 | GT 父件也在第 t 步安装 | 该条剔除出答案（计入 `gt_deferred_same_step`）；全步都如此则整步丢弃 | `parent-in-same-step` |
| 目标凸点被占 | `on#stud` 不在 step ≤ t−1 的空闲凸点表 | 该条剔除（计入 `gt_target_stud_occupied`）；全步都如此则整步丢弃 | `target-stud-not-open` |
| 底孔反扣 | `snap.under === true` | 该条剔除（6 字段契约无法表达 `under`） | `under-snap-unsupported` |
| 渲染失败 | CLI 返回非 0 或图片不存在 | 整步丢弃 | `render-failed` |

**凸点标签与文本列表同源**：`tools/lib/open-studs.mjs` 是 `cli/brickkit.mjs#computeOpenStuds` 的逐行复制
（任务边界禁止改 CLI，也无法 import 其内部函数）。两者的容差与过滤条件必须一致，否则模型会被要求引用一个画面上不存在的标签。
实测复核：`state_next-case_snot_01-step03` 的 10 个标签与渲染图上的 10 个可见标签逐一对应
（含 SNOT 侧凸点 `p002#1 dir=+z` 画在竖板侧面上）。

### 3.4 用法

```bash
# 严格模式（只认真实 snap）
node tools/gen-training-steps.mjs \
  --models out/60239/sub-front-bumper.brick.json,out/60239/sub-rear-bumper.brick.json \
  --out out/dataset/brickvlm-sft.jsonl --render-dir out/dataset/img

# 快速验证 schema（不渲染）
node tools/gen-training-steps.mjs --models examples/60239.brick.json \
  --out /tmp/sft.jsonl --no-render --allow-derived-snap --pretty

# 附真实说明书页（步骤→页映射由调用方提供）
node tools/gen-training-steps.mjs --models examples/60239.brick.json \
  --out out/dataset/60239-sft.jsonl --allow-derived-snap \
  --manual-dir out/manual-pages/60239 --manual-map out/dataset/60239.manual-map.json
```

渲染开销实测：800×600、`--az 35 --el 26`，**平均 5.62 s/张**（36 张 3 分 22 秒，Playwright + SwiftShader 软渲染）。
`--no-render` 走纯文本路径（60239 91 件 × 40 步：0.2 s）。

---

## 4. 奖励函数（RLVR）

入口：`scorePrediction({ pred, gt, model, cat, validateFn, runValidate, visual, greedyRot })`（纯函数）；
CLI 只是读 JSONL / 拼 `visual` 的壳。

```bash
node tools/brickvlm-reward.mjs --predictions preds.jsonl --model examples/60239.brick.json \
  [--photos examples/60239.photos.json --dir out/manual-pages/60239] [--out out/reward.json]
```

**输入**（每行）：`{ "model": "60239", "step": 8, "pred": [...], "gt": [...], "modelFile": "可选，覆盖 --model" }`
**输出**（每行，顺序与输入一致）：

```json
{"model":"60239","step":8,"ok":true,"score":0.87,
 "breakdown":{"physical":0.5,"snapMatch":0.9,"visual":0.71,"noOverlap":1.0},
 "weights":{"physical":0.625,"snapMatch":0.375},
 "details":{"physical":{"accepted":1,"total":2,"acceptRate":0.5,"validateErrors":0,
                        "validateErrorCodes":[],"perAction":[{"index":0,"ok":true,"reason":null},...]},
            "snapMatch":{"score":0.9,"fieldHits":21,"fieldTotal":24,"pairRate":0.875,"pairs":4,
                         "extraPred":0,"missingGt":0}},
 "errors":[]}
```

### 4.1 三个分项 + 一个诊断项

**`physical`（权重 0.5）** —— 把 pred **按顺序** `snapPart` 到模型副本上，逐条判定：

1. 父件 `on` 不在当前模型里 → 该条 0（越界引用/未安装）；
2. 零件/颜色不在目录 → 该条 0；
3. `snapPart` 抛错 → 该条 0（凸点编号越界、朝向不匹配、连接类型不匹配都走这里）；
4. 落位后与**模型既有零件**任一 `partsCollide` 命中 → 该条 0；
5. 与**同批已接受的兄弟 pred** 穿模 → 该条 0（先到先得，顺序敏感——这是刻意的，鼓励按说明书顺序作答）。

```
physical = (通过条数 / pred 条数) × 1/(1 + validateErrors)
```

通过条数全部并入模型副本后再跑一次 `validate()`，用 error 数做惩罚。`validate()` 可注入（单测里替换为桩）。

**`snapMatch`（权重 0.3）** —— pred 与 gt 逐条比 6 字段：

- 配对是确定性的：先按 `(part,color,on,stud)` 完全相同配对，余下按 `(part,color)` 贪心一对一；
  没配上的 pred = `extraPred`（多装），没配上的 gt = `missingGt`（漏装）。
- 字段权重各 1（共 6 分）；`rot` 例外：完全相同 1 分，**相差 180° 且几何等价** 0.5 分，其余 0 分。
  - 180° 等价判据：零件足迹为正方形（`def.size[0] === def.size[1]`）时旋转 180° 与 0° 的包围盒相同 → 不可分辨，算半对；
    非正方形（如 2×4 砖）180° 后轮廓不同 → 判不等价。
  - `--greedy-rot` 强制任何 180° 都算半对（更宽松，仅供对照实验，不进默认口径）。
- `snapMatch = 配对字段命中率均值 × min(1, |pred| / |gt|)`——少装按覆盖率打折，多装由 `physical` 侧自然惩罚。

**`visual`（权重 0.2）** —— `runDiff(model, ...)` 的 `overall.score`（joint 模式）。
需要 `--photos` + `--dir`；缺失时为 `null` 并在 `breakdown` 里如实标注，**不伪造**。
注意：`visual` 是对**整个模型**（而非单步）与真实照片的对账分，同一模型的所有行共享同一次 `runDiff` 结果（整批只算一次）。

**`noOverlap`（无权重，诊断项）** —— `1 - 穿模条数/总条数`。与 `physical` 的区别：`physical` 还含 `snapPart` 失败与 validate 惩罚，
`noOverlap` 只回答「pred 之间有没有几何打架」，便于定位是「不会扣」还是「扣上去撞了」。

### 4.2 总分与缺失项归一

```
总分 = 0.5×physical + 0.3×snapMatch + 0.2×visual
```

`visual` 缺失时按剩余权重重新归一：`0.5/0.3 → 0.625/0.375`。归一后的实际权重写在输出 `weights` 字段，便于审计。

### 4.3 实测分档（case_stack_01 step2，基准 `state_t.brick.json`）

| 输入 | score | physical | snapMatch | noOverlap | 说明 |
|---|---|---|---|---|---|
| 全对 | **1.0** | 1.0 | 1.0 | 1.0 | 8 颗凸点里选对 `p001#0` |
| 错 stud（换 `p001#2`，仍物理合法） | **0.9375** | 1.0 | 0.8333 | 1.0 | 只掉 snapMatch（5/6 字段） |
| 错 part（3001→3002） | 更低 | 0（3002 与基准件穿模） | — | — | 物理失败连锁 |
| 同一凸点叠两块 | **0.6875** | 0.5 | 1.0 | 0.5 | 第二条与第一条兄弟件穿模 |
| 父件不存在 | **0.375** | 0.0 | 0.0 | 0.0 | 越界引用 |

---

## 5. 训练两阶段

### 阶段一：SFT（行为克隆）

- 数据：§2 的 JSONL（`snap` 来源优先；`derived` 只作补充并保留标记以便消融）。
- 目标：**学会输出 6 字段 JSON 数组，且只引用画面里的标签**。这一阶段不追求「选得最优」，只求格式与视觉 grounding 正确。
- 采样：按模型族划分 train/val（同一模型的相邻步骤高度相关，**禁止跨 split**——与 `test/brickvlm-contracts.test.mjs` 的 ML-01 同口径）。
- 建议先做 3B 的 LoRA（r=16，`vision` 塔冻结，仅解冻 LM 后 8 层 + projector）。

### 阶段二：GRPO / RLVR（用本文奖励）

- 每个 prompt 采样 K=4~8 条 rollout（温度 0.7），用 `scorePrediction` 打分，组内归一化做优势。
- `visual` 项在 rollout 时**不建议**每条都算（`runDiff` 要起浏览器，>10 s/次）；
  训练时把 `visual` 固定为该模型的缓存值（或在 reward 中置 null 走 0.625/0.375 归一），
  只在**验证集**上计算真实 `visual`。
- 关键：`physical` 是**确定性、零成本**的（纯几何），因此可以每条 rollout 都算，是最主要的梯density来源。

### 阶段划分与退出条件

| 阶段 | 输入 | 目标 | 手工检查的退出条件 |
|---|---|---|---|
| SFT | snapshot 数据（≥数百条 snap 来源样本） | 合法 JSON + 标签引用正确率 | 格式合法率 100%、引用不存在的标签率 0 |
| RLVR-warmup | SFT 权重 | `physical` 均值 > 0.8 | 假连接率 < 5% |
| RLVR-full | + `snapMatch` / `visual` | `snapMatch` 均值 > 0.6 | 与 SFT 基线在 holdout 上有显著提升 |

---

## 6. 已知局限（必须如实披露）

### 6.1 合成数据分布 vs 真实说明书页的域差

| 维度 | 合成图 | 真实说明书页 | 影响 |
|---|---|---|---|
| 背景 | 纯白 | 白底 + 米色底衬 + 分栏线 + 页码 | 视觉特征偏移，模型可能学到「找白底」 |
| 相机 | 固定 `az=35, el=26`（可调） | 每页视角不同（常见等轴测 + 局部放大） | 对视角变化的外推能力未知 |
| 标注 | `p001#12` 蓝色/彩色文字标签 | **完全没有标签** | 见 §6.2，最核心的域差 |
| 线宽/描边 | 无 | 有黑色轮廓描边、零件序号 callout 框 | 模型可能把 callout 当零件 |
| 零件呈现 | LDraw 精确几何 | 印刷渲染（略有色差、少了部分内部结构） | 颜色/形状细节差异 |

### 6.2 `--show-studs` 标签在真实说明书页上不存在

这是本方案**最重要的已知缺口**。训练时状态图带编号标签、真实说明书页没有，模型会学到
「标签来自合成渲染」而不是「标签是数据管线画的」——在真实页面上推理时，凸点编号的来源必须由**外部系统**提供。

三种缓解路径（按推荐度）：

1. **推理时也贴标签**（推荐）：把真实照片/说明书页喂给 `brickkit render --show-studs` 的等价管线做不到（那是渲染器），
   但可以用**相机标定 + 凸点投影**在实物照片上叠加同样风格的标签（`window.brickkit.projectWorldPoint` 已有投影能力，缺的是真实相机位姿）。
2. **训练时只用合成状态图 + 真实说明书页仅作「目标成品」参考**：即让模型从「带标签的状态图」推理位置，
   说明书页只提供「要装成什么样」的语义，不要求它在说明书页上找标签。本文的默认管线就是这种分工。
3. **教模型识字**：混入少量「标签被随机遮挡/改色/换字体」的增广样本，提高对标签样式变化的鲁棒性（未实现）。

### 6.3 数据量不足

本仓库当前能产出的**严格 snap 来源样本**很少：`examples/` 5 个模型 368 件**全部无 snap**；
带 snap 树的只有 `out/60239/sub-*.brick.json`（34 件）与 15 个 `real-assembly-curriculum` 用例（每个 2–3 件）。
实测一轮全量渲染只得 **18 个样本 / 27 条 GT / 36 张图**。这与 PRD §10.7 的「≥5,000 个状态」差 2 个数量级，
**当前数据只能做管线验证与 SFT smoke，不足以训练可用模型**。扩充路径：
(1) 给现有生成器补 `on/stud` 并重建模型（`builder.add({on,...})` 会自动写 snap）；
(2) 用 `--allow-derived-snap` 补 derived 样本（需接受分布偏差）。

### 6.4 反解不是标注

`deriveSnapCandidates` 在歧义时**不产出**，实测 60239 有 30 件歧义、39 件无解。
歧义来自多排底孔共用一颗凸点，物理上等价但标签不同。用它训练会让模型学到「随便哪排都行」，
与 `snapMatch` 的严格字段比对口径冲突。因此默认关闭，且产物逐条标 `derived`。

### 6.5 奖励的已知盲点

- `physical` 顺序敏感：同一组 pred 换顺序可能得到不同的 `physical`（先到先得）。这符合「按说明书顺序拼」的语义，但对无序集合不公平。
- `snapMatch` 的贪心配对在「多个同型号零件扣不同凸点」时可能配错对（按 `(part,color)` 贪心）。已用 `(part,color,on,stud)` 优先配对缓解，
  但极端情况（4 个 54200 板全错位）仍可能高估。
- `visual` 是整模型分，不反映「这一步装错但整体看起来还行」；单步视觉奖励需要按步渲染 + 局部掩膜，未实现。
- `rot` 180° 等价只看正方形足迹，未考虑凸点排列的对称性（例如带中心孔 + 8 颗凸点的圆盘在 90° 时也等价）。

---

## 7. 复现命令

```bash
# 1) 严格模式（examples 无 snap → 0 样本，如实计数）
node tools/gen-training-steps.mjs --models examples/60239.brick.json \
  --out /tmp/sft.jsonl --no-render --pretty

# 2) 反解模式（管线验证，样本标 derived）
node tools/gen-training-steps.mjs --models examples/60239.brick.json \
  --out /tmp/sft-derived.jsonl --no-render --allow-derived-snap --pretty

# 3) 全量真实 snap 样本（9 个模型 / 18 样本 / 36 张图，约 3.5 分钟）
node tools/gen-training-steps.mjs \
  --models out/60239/sub-front-bumper.brick.json,out/60239/sub-rear-bumper.brick.json,out/60239/sub-rear-deck.brick.json,out/prd-v2/run-20261026-v4/B/real-assembly-curriculum/cases/case_stack_01/state_next.brick.json \
  --out out/dataset/brickvlm-sft.jsonl --render-dir out/dataset/img --pretty

# 4) 奖励（全对 / 错 stud / 穿模）
node tools/brickvlm-reward.mjs --predictions preds.jsonl \
  --model out/prd-v2/run-20261026-v4/B/real-assembly-curriculum/cases/case_stack_01/state_t.brick.json --pretty

# 5) 测试
node --test test/brickvlm.test.mjs
```
