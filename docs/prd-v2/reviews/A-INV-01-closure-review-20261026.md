# A-INV-01 独立关闭记录

日期：2026-10-26。对应问题：成功事务未持久记录库存消费，导致同 token 在后续事务重复使用。

**结论：A-INV-01 已独立复验，关闭。** 本结论限定于已复现的跨事务重复消费问题及本次相关回归；不扩展为完整工作流、B 的 R-02、正式模型验收或契约冻结。

## 1. 本次独立执行结果

| 验证 | 本次结果 |
|---|---|
| 原独立反例 `check-A-inventory-reuse-20261026.mjs` | `inventoryInvariantViolated:false` |
| 第一次完整组件挂装 | 成功；模型由 1 件变 3 件；两个 token 持久为 consumed，并记录 consumedBy |
| 第二次复用相同 token | 被 inventory-insufficient 拒绝，无第二组模型输出 |
| 补料与单件/回滚/undo 回归 | 维护测试中的对应检查通过 |
| 独立整组 undo 检查 | 同一批次挂装后撤销：两成员全部移除，模型回到 1 件，两 token 回到 available；0 errors/0 warnings |
| 维护测试集 | 本次独立复跑实际为 **248/248**，退出 0；与回执所列 244 不同，本记录以本次输出为准 |

测试命令：

```powershell
node docs/prd-v2/reviews/check-A-inventory-reuse-20261026.mjs
node --test --test-reporter=dot test/*.test.mjs
```

本次撤销验证是本批次已有动作的撤销，不外推为已完成跨批次 undo、detach 或 replace。

## 2. 变异证据独立复跑

在保留 A 原脚本和原报告的前提下，复制变异脚本到 reviews，调整仓库根目录、独立输出位置及带 PID/防覆盖检查的临时模块路径。

| 实现 | 第二次装配 | token 状态 | 结果 |
|---|---|---|---|
| 修复版 | 拒绝 | consumed | 无 token 复用 |
| 恢复旧行为的变异体 | 成功 | available | 精确复现 1→3→5 件，复用 m1/m2，零诊断 |

六项变异断言全部成立。独立变异输出见 [A-INV-01-independent-mutation-20261026.json](./A-INV-01-independent-mutation-20261026.json)。临时变异模块已经清理，未改写 A 的常驻实现。

```powershell
node docs/prd-v2/reviews/A-INV-01-independent-mutation-20261026.mjs
```

## 3. 三类面向 B 的夹具消费已确认

本次重新调用 A 当前实现，不沿用夹具内嵌的旧结果：

- 五任务资产锁全部通过，分别 verified 4/2/3/2/38，与 buildAssetLock 重建结果一致。
- renderState 8 个标签及映射表完全一致；stateHash 一致，错误哈希反查返回 null。
- 完整组件路径枚举 64 个候选，得到三件目标；0 errors/0 warnings，返回库存持久 consumed。

这些是本聊天生成的面向 B 的消费夹具，A 侧验证通过不能代替 B 的生产流程回执。夹具本身原有 review-*-not-integrated 状态继续保留；其内嵌历史结果也不覆盖，以本次新证据说明当前实现。

额外检查了 **B 当前实际生产计划** `out/prd-v2/run-20261026-v4/B/60239.build.plan.json`：五份任务锁已采用 parts 数组，均通过 A 的 checkAssetLock。可以关闭“这份当前计划的锁格式/revision/profile/hash 不兼容”这一旧结论。它仍不证明所有 B 路径或整个运行时已完成集成。

## 4. 保持不变的状态与下一步

- 契约文件当前为 `0.9.0-draft`、revision 3、frozen=false；尚未冻结。
- B 的完整组件执行/同件等价 R-02 不由本记录代签，仍等待对应独立复核。
- 60239 保持 failed；候选与原始示例的错误口径分别保留。
- 性能优化、正交像素对账、组件内部 SNOT 链、detach/replace、正式领域训练与留出验收不因本次而升格。
- 后续消费成功事务时，调用方必须一起接管返回模型与返回库存，并按 after hash 更新后续请求上下文。

下一步由 B 交付 R-02 的完整目标对照与实际生产调用证据，双方再确认相同契约哈希后冻结。A-INV-01 不重复返工。

机器可读关闭证据：[A-INV-01-closure-evidence-20261026.json](./A-INV-01-closure-evidence-20261026.json)。
