# M-A1/A2 里程碑：资产存储、关系装配、动作引擎

- 执行者：Task A（ZCode / DeepSeek v4.1Flash）
- 日期：2026-10-26
- 状态：**ST/AS/EN 关键正负例通过（A 自测）**，等 B 独立复核

## 1. Part Asset v1（ST）

| 项 | 实测 |
|---|---|
| 索引件数 | 4,605（curated 167 + extracted 4,438） |
| `index.json` | 4,729,634 B |
| 34 MB 定义总和（紧凑分组后） | 34,034,405 B（优化前 162,506,591 B，**-79%**） |
| 连接器总数 | 212,736（全库展开后） |
| 最大单件定义 | 782（50×50 底板）460,099 B（优化前 3,523,351 B） |
| 按件加载（5 件） | 1.40 ms/次 |
| 完整性自检 | `verifyStore` 4605/4605，0 problems |
| 重建确定性 | 同参数两次构建 contentHash 全一致 |

能力分布（`deriveCapabilities`）：

| 能力 | verified | measured | inferred | unsupported |
|---|---|---|---|---|
| render | 0 | 165 | 4,440 | 0 |
| collide | 20 | 0 | 2,406 | 2,179 |
| assemble | 0 | 3,952 | 0 | 653 |

> `collide` 的 2,179 个 `unsupported` 是 `needsManualBoxes` 或 bracket schema 缺陷的件，
> 这是诚实的缺口声明，不是"通过"。

## 2. 关系装配 0.3（AS）

| 项 | 结果 |
|---|---|
| 夹具总数 | 8（2 正例 + 6 负例） |
| 全部通过 | 8/8 |
| 负例命中错误码 | `placement-cycle` / `double-placement` / `missing-reference` / `recursive-template` / `missing-asset` / `unknown-connector` / `inventory-double-consume` |
| 失败时是否留半成品 | 否，`snapshot: null` |
| 编译到 0.2 | 可被 viewer / booklet / MPD 消费（实测三种导出全成功） |
| 损失声明 | 逐项 `losses`（constraints/inventory/evidence/steps） |

## 3. 动作引擎（EN）

| 项 | 结果 |
|---|---|
| 24 姿态 | 24 条，`det` 全 +1，互不重复，id 0 恒等 |
| 候选自证 | `3020`/`3024`/`3001`/`87087` 每种零件的**每个**候选都通过 `partsConnected` + `partsCollide` |
| 事务正例 | 提交、stateHash 变化、`physicalConnection: true`、库存消费 |
| 事务负例 | 8 类（stale-state / empty-action / candidate-unknown / missing-action-ref / instance-id-dup / repair-not-allowed / inventory-consumed / abstain-incomplete）全部命中预期错误码 |
| 幂等 | 同一 actionId 第二次为 `noop` |
| 父件碰撞 | 单件路径 + 装配路径都排除；显式豁免时复现旧行为 |

## 4. 额外修复的校验漏洞

`validate` 的两条穿模检测路径互相让位：

```text
修复前：4740(带 boxes) 在 [0,0,0] + 3001 在 [0,0,0] 完全重叠 → ok: true, errors: []
```

- 整格占用跳过带 `boxes` 的件（凹形件空腔格"有格无料"）
- 3D 盒检查跳过"两个整数格水平件"（认为整格已覆盖）

修复：3D 检查不再跳过"至少一方带多盒"的组合。回归测试
`[EN-02] 多盒凹形件与整数格水平件重叠必须被检出` 已加入。

## 5. 60239 推进（不属于本里程碑，附记）

| 阶段 | errors | warnings | 连通块 |
|---|---|---|---|
| 原始（只读基线） | 7 | 17 | 36 |
| +4740 碰撞覆盖 | 4 | 17 | 36 |
| +雪糕筒落位修正 | 2 | 17 | 34 |

产物：`out/prd-v2/2026-10-26-a/A/compat/60239-advanced.brick.json`（候选副本，未覆盖原文件）
报告：`out/prd-v2/2026-10-26-a/A/compat/60239-advance-report.json`

**剩余 2 个错误未修**（超出 A 责任边界，需 B 的 60239 计划与主会话判断）：
1. `p003 与 p022` 真实 3D 重叠（雪糕筒 vs 轮销架，0.5 格）
2. 63 件悬空（模型仍是扁平布局，未做主体连通）

## 6. 测试

```text
npm test（全套含 B 的测试）   : 190 pass / 0 fail
node --test test/assets-assembly.test.mjs : 31 pass / 0 fail
连续 4 次全套运行               : 190/0 × 4，无抖动
```

## 7. 未完成

- 侧凸点多层 SNOT（0/1/2…）真实 4 件链夹具
- `attach_assembly` 事务路径（候选生成有，事务只测单件）
- `detach` / `replace`
- `constraints.extra-mate` / `keep-out` 参与求解
- `renderState`
