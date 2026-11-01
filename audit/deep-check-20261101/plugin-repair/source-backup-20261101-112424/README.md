# DSH Bridge

最小本地 Codex 插件，Python 3 标准库，无第三方依赖。连接本机已运行的 DSH，复用 `~/.dsh/lan/session.json` 登录态。适配当前宿主 `/api/session/<method>` Typert RPC（payload.args），不修改 DSH。

工具：`dsh_status`、`dsh_models`、`dsh_sessions`、`dsh_create_session`、`dsh_send`、`dsh_read`、`dsh_cancel`。创建时指定 provider/model，并读回模型选择；发送使用 request_id 本地防重。超时或不确定结果不会自动重试。只允许本机 HTTP 地址、禁代理和重定向；凭据不写进插件。

创建普通会话时按 cwd 解析/复用 DSH 工作区，用 `workspaceId` 创建，并读回 sessionIds 确认关联后返回。`D:\Project\ra2-campaign-forge` 下的会话关联 `ra2-campaign-forge` 工作区；关联失败不发送提示词。原生 subagent 仍由 DSH 管理，显示在已关联的父会话下。

可选环境变量：`DSH_COOKIE_JAR`（登录态文件）、`DSH_BASE`（本机服务地址）、`DSH_BRIDGE_STATE`（防重记录目录）。默认读登录态中的地址，默认防重记录为 `~/.codex/dsh-bridge/requests`。DSH 重启后需要重新登录；协议不兼容时明确报错，不猜接口。

命令验证：

```powershell
python -B server.py --call dsh_status
python -B server.py --call dsh_models
python -B server.py --call dsh_create_session --args-file create.json
python -B server.py --call dsh_send --args-file send.json
python -B server.py --call dsh_read --args-file read.json
python -B -m unittest discover -s tests -v
```

create.json 示例：`{"cwd":"D:\\Project\\ra2-campaign-forge","provider":"opencode-go","model":"deepseek-v4.1-flash","reasoning_effort":"high"}`。这里的名称必须以当前 dsh_models 返回为准，不能将 API ID 当作固定版本证明。用户禁止使用 `deepseek-official` 和 `deepseek-account`，插件在创建及发送前拒绝这两个供应商。

安装到本地 marketplace 后刷新插件或新开聊天，以 tools/list 的实际发现确认加载。CLI 通信成功不代表当前聊天已经注入工具。插件不提供自动完成回执，使用 dsh_read 核验结果。

本机安装：`powershell -File install.ps1`（或 pwsh），默认使用独立 marketplace `~/dsh-bridge-marketplace`，保留其他插件目录和登记。源代码位于项目 `plugins/dsh-bridge`，修改后重跑安装脚本；不编辑 Codex 缓存。
