---
name: dsh-bridge
description: 在用户要求与本机 DeepSeek Harness 通信、选择 DSH 模型、派任务或读取结果时使用。
---

# DSH Bridge

1. 调用 dsh_status，再读 dsh_models。目录仅说明路由可选，实际权限由执行确认。
2. 用户授权派发后，用 dsh_create_session 指定现存绝对 cwd、目录中的 provider/model，核对 verified_projection。禁止静默换模型。
   项目会话须同时确认 workspace_attached=true；本项目 cwd=D:\Project\ra2-campaign-forge，对应工作区 ra2-campaign-forge。不要用只有 cwd 的原始 session/create 创建游离会话；DSH 原生 subagent 从属于已关联的父会话。
   用户限定 DeepSeek 使用 OpenCode Go：provider=opencode-go、model=deepseek-v4.1-flash。禁止 deepseek-official 和 deepseek-account，不尝试修复或使用这两条路由。
3. dsh_send 使用唯一 request_id；失败/超时先用 dsh_read 核对，不能换 ID 重发同一任务。
4. 实际返回 accepted 不代表完成；dsh_read 读取 running、助手回复、错误及历史。项目验收仍须检查真实产物与相关测试。
5. 只向用户授权的 DSH 会话发送；不修改其他活动会话。dsh_cancel 仅用于用户明确要求停止的会话。
6. 本插件没有自动 Codex 回执；用有限的状态读取或既有调度机制，不宣称会自动唤醒。不要创建高频轮询自动任务。
7. 凭据来自 ~/.dsh/lan/session.json；过期时让用户通过 DSH 登录，不输出 cookie/token，不自动修改 DSH 配置或重启 DSH。

标准输出为 MCP 协议。插件脚本支持同一工具实现的 CLI 验证：python -B server.py --call dsh_status；带参工具使用 --args-file，避免提示词 shell 转义。
