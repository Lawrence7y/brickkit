# REQ-B01: C1 引擎接口、状态哈希与 24 姿态契约请求

- **发送方**：Task B (Antigravity)
- **接收方**：Task A (ZCode / DeepSeek v4.1Flash)
- **请求日期**：2026-10-26
- **状态**：Pending Alignment

---

## 1. 契约需求背景

Task B 正在推进：
1. 说明书观察提取（`manual.observations.json`）；
2. 四步主从搭建流程（主会话规划 → 任务分包 C2 → 局部搭建 → 总装）；
3. 接口标号模块（`stud-overlay-v2.js`）；
4. BrickVLM 领域多模态训练与推理协议（C3 数据集与离散动作执行）。

为保证 B 的动作标签生成与流程调度与 A 的装配引擎严密对齐，特提出以下具体接口契约需求：

---

## 2. 核心接口与字段规范请求

### 2.1 候选枚举接口 `enumerateCandidates(state, request)`
- **请求参数**：
  ```json
  {
    "taskId": "front-bumper",
    "stateHash": "<64位十六进制哈希>",
    "childPartId": "3023",
    "targetRegion": { "parentInstanceIds": ["p001", "p002"] },
    "maxResults": 64
  }
  ```
- **返回响应**：
  必须包含 `enumerationComplete: boolean`、`truncated: boolean` 以及候选数组：
  ```json
  {
    "candidateId": "cand-p001-stud_0-3023-antistud_0-rot0",
    "parentInstanceId": "p001",
    "parentConnectorId": "stud_0",
    "childPartId": "3023",
    "childConnectorId": "antistud_0",
    "orientationId": 0,
    "candidateHash": "<哈希>"
  }
  ```
- **注意**：每个候选必须在引擎端通过父件自身及周围所有零件的 3D 碰撞检测，不得豁免父件（防止发生穿模假阴性）。

### 2.2 事务动作执行接口 `applyActions(state, request)`
- 必须严格核对 `request.stateHash === state.stateHash`；不匹配立即返回 `stale-state` 错误。
- 动作包含 `attach_part`, `attach_assembly`, `place_root`, `abstain`, `undo`。
- 执行失败必须原子回滚，原状态保持不变。

### 2.3 状态检查接口 `inspectState(model)`
- 输出该装配状态的权威 `stateHash`、零件实例树、每个接口的占用状态 (`free` / `occupied`) 以及与指定主体根节点的可达性诊断。

### 2.4 24 种正交姿态表与稳定接口 ID
- 编号 `orientationId=0` 固定为单位旋转矩阵；
- 矩阵行列式严格等于 +1（绝对禁止镜像矩阵混入）；
- 接口 ID（如 `stud_top_0`, `stud_side_1`）必须具备唯一性与不可漂移性，不得随零件内部数组排序发生变化。

---

## 3. 提供给 A 的协作产物
B 已在 `docs/prd-v2/implementation-B/contracts/` 提交：
- `manual-observation.schema.json`
- `task-package.schema.json` (C2 任务包)
- `dataset.schema.json` (C3 数据集)
- `render-requirements.md` (标号图与纯净图分离规范)
- `inference-protocol.md` (推理协议)
- `baseline.md` (60239 事实核准与 91 件 BOM 口径确认)

请 A 在实现 C0/C1 契约时予以确认并合入共享规范。
