# M-A0/C0 里程碑：基线与公共契约

- 执行者：Task A（ZCode / DeepSeek v4.1Flash）
- 日期：2026-10-26
- 状态：**契约草案已出，等 B 复核后冻结**（`contracts-1.0.0-draft`）

## 交付物

| 产物 | 路径 | 验证 |
|---|---|---|
| 基线（HEAD/工作树/哈希/运行时/60239 现状） | `docs/prd-v2/implementation-A/baseline.md` | 全部数字来自实测 |
| 修改前哈希 | `out/prd-v2/2026-10-26-a/A/baseline/hashes.json` | 25 个文件 |
| 修改后哈希 | `out/prd-v2/2026-10-26-a/A/baseline/hashes-after.json` | 17 个文件 |
| 契约版本表 | `contracts/version.json` | — |
| 零件资产 Schema | `contracts/part-asset.schema.json` | — |
| 关系装配 Schema 0.3 | `contracts/assembly.schema.json` | — |
| 动作请求 Schema | `contracts/action-request.schema.json` | — |
| 动作响应 Schema | `contracts/action-response.schema.json` | — |
| 24 姿态表 | `contracts/orientation-table.json` | `selfCheck: {ok:true,count:24,distinct:24}` |
| API 与错误协议 | `contracts/api.md` | — |
| 夹具（1 最小正例 + 1 组件复用正例 + 6 负例） | `contracts/fixtures/` | `make-fixtures.mjs` → 8/8 passed |
| 对 B 请求的响应 | `responses/RES-A01-c1-contracts.md` | — |
| 给 B 的复核请求 | `requests-to-B/REQ-A01-review-and-api-questions.md` | — |

## 三个反例的状态

| 反例 | 修复前（已复现） | 修复后（已验证） |
|---|---|---|
| fake-group | `strictAssembly` 下 `ok: true`，远处散件被当作已装 | `ok: false`，`subassembly-disconnected` 点名该件 |
| snap 环 | 静默保留旧坐标 | 抛 `snap-cycle`，模型保持原状 |
| 父件碰撞 | 40/40 候选穿父砖 | 0 个候选；显式豁免才复现旧行为 |

复现脚本：`out/prd-v2/2026-10-26-a/A/repro/repro-cases.mjs`
修复前输出：`repro.json`（4×REPRODUCED）；修复后：`repro-after.json`（4×BLOCKED）。

## 契约争议点（等 B 定）

1. `stud_N`（B 草案）vs `stud_top_N`（A 建议）——B 的 `stud_N` 无法区分顶/侧凸点
2. 权威接口 ID 用语义位置还是 `类型_序号`——A 用语义位置，理由见 `api.md` §1.1
3. `renderState` 坐标系约定
4. B 的 `assetLock.partLocks.hash` 是空字符串哈希（已在请求里报告）

## 未完成

- 契约未冻结（依赖 B 回复）
- 容差 profile 未用完整正/错配对夹具验证
- `renderState` 未实现
