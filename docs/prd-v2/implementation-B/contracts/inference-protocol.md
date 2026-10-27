# BrickVLM 推理与动作执行协议 (Inference Protocol)

- **责任者**：Task B (Antigravity)
- **协议版本**：1.0
- **适用组件**：`src/brickvlm/` 与工作流调度器

---

## 1. 离散动作与事务执行模型

BrickVLM 在任何情况下**严禁直接输出任意世界坐标小数（如 `[12.34, 5.67, 8.90]`）**。模型只负责在装配引擎生成的离散合法候选集合（Discrete Candidate Set）中进行选择或弃权 (Abstain)：

```text
[当前说明书图 + 标号状态图 + 可用零件 Token + 候选列表] 
       │
       ▼
[BrickVLM 推理]
       │
       ▼
{ "op": "attach_part", "candidateId": "cand-014", "consumedTokenId": "tok-008" }
       │
       ▼
[引擎校验 stateHash 并执行事务原子提交]
```

---

## 2. 状态绑定与过期校验 (StateHash Guard)

1. 推理请求必须携带当前权威源装配状态的哈希 `stateHash`。
2. 引擎在执行 `applyActions` 时，若传入的 `stateHash` 与当前实际状态不一致，必须立即拒绝并返回：
   ```json
   { "ok": false, "error": "stale-state", "expectedStateHash": "..." }
   ```
3. 客户端收到 `stale-state` 必须重新抓取当前状态、候选集与渲染图，禁止基于过期视野盲跑。

---

## 3. 候选截断与弃权机制 (Candidate Truncation & Abstain)

1. 当接口候选过多被引擎截断时（`truncated: true`），若模型置信度不足，模型应输出：
   ```json
   {
     "op": "abstain",
     "reason": "truncated_candidates_insufficient_view",
     "requestedView": { "azimuth": 90, "elevation": 15 }
   }
   ```
2. 单步动作执行重试预算：默认上限 **3 次**。
3. 局部修复轮数：默认上限 **2 轮**。
4. 超过预算未收敛时，自动标记任务 `needs-repair` 并向主会话汇报，记录强模型或人工介入次数（计入成本与 ML-08 统计）。
