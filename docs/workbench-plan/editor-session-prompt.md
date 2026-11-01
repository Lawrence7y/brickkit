# 新 Harness 主会话提示词：乐高工作台

请实现 D:\Project\brickkit 的乐高编辑工作台。完整产品规格见 docs/workbench-plan/PRD.md，协调规则见 docs/workbench-plan/README.md。先完整读取二者及 AGENTS.md；不要根据自己的理解重新设计或省略页面部分。用户已授权实现及主会话与子代理并行工作，不需要再次询问是否开始。

## 工作环境与边界

1. 使用独立工作树，分支前缀 codex/，与灯笼修复会话隔离。先记录当前分支、HEAD、dirty清单。工作树只复制已提交代码，当前core/目录治理存在未提交修改；不得假装新工作树已包含它们。先把需要的当前源码保存为可追踪基线快照（文件列表+SHA256+差异），在独立工作树应用所需源码依赖，不移动/清理原目录，不把别人的未提交工作重置。无法取得一致基线时继续做隔离UI模块，明确核心集成待办。
2. 只负责工作台、浏览器适配和展示集成。不要修改 catalog、src/core、灯笼脚本/模型/照片观察记录、既有缺陷登记或放宽测试。缺能力写 docs/workbench-plan/editor-core-requests.md：触发场景、现有API、所需输入/输出、错误语义、最小复现，不写假扣合兜底。
3. 现有 actions-v1 使用 Node 依赖，不能直接照搬进浏览器。复用可用纯函数，通过 src/editor/engine-adapter.js 隔离。未支持接口显示待支持，不伪造成功。

## 任务拆分（立即执行，不只输出计划）

主会话负责：架构和状态机、文件所有权、核心适配、跨模块集成、src/viewer/main.js/template.html/style.css及必要build入口、最终浏览器验证。只有主会话可修改这些集成文件。

最多同时开两个执行子代理，自己继续工作，空闲后复用槽位做独立审计：

- 子代理 UI-Library：独占 src/editor/library/ 和 test/editor-library*；负责全库分类/搜索/虚拟列表、灰模缩略图、详情3D旋转、物件过渡、待选条、颜色/数量。不得写集成入口。
- 子代理 UI-Assembly：独占 src/editor/assembly/ 和 test/editor-assembly*；负责选择/放置预览/候选切换/属性/涂色/试玩控件，调用主会话给定适配契约。不得自行实现第二套连接算法。
- 执行代理完成后，复用一个槽位交给只读QA，独立验证PRD关键路径，不让实现者自报通过代替审计。

所有子代理须明确告知：你不是独自在代码库，不撤销其他人的改动，超出所有权的修改先交主会话。同一文件同一时刻只有一个写入者。主会话先定义共享接口再派工，代理等待接口期间可做独立组件。

## 主会话先固定的接口

接口由主会话写入 src/editor/contracts.js（或等效声明），统一通过事件/状态读写，不暴露THREE对象作为存储格式：

- catalog.list/filter/getDetail(partId)、geometry.load(partId)、tray.add/update/take/return。
- document.getSnapshot/commitTransaction/undo/redo/serialize/import。
- engine.inspect/enumeratePlacements/validatePlacement/commitPlacement/getRigidComponent/getJointMotion。
- scene.preview/select/focus、transition.openDetail/closeDetail/addToTray/setScrollProgress。

名称可按现有仓库调整，但能力/单位/错误返回/稳定ID不能省略。预览不得扣库存或写历史，提交需复核；UI能力和核心实际支持范围分别记录。

## 产品要求摘要（以PRD详细规格为准）

首屏顶部待选区旁边是零件库按钮，下方大模型区；灰模库、可旋转详情、添加到待选、待选配色、调色盘点涂。点击取件为主，拖拽为辅，预览后确认，Esc取消。库卡片中的零件放大进入详情，副本飞入待选，取件进入模型；上下滚动模型连续等比缩小进入现有展示页，反向恢复。所有转换保持颜色、朝向、关节状态，不改物理坐标。保留现有步骤/爆炸/模块/BOM/图纸/导出和CLI能力。

分两阶段实现，必须完成两阶段：A完整基础编辑与连续过渡；B轮子、折叠、滑动、多级联动。为B使用独立可动样本，不用灯笼替代关节验收。球关节/齿轮闭环等不支持则清晰标注。

## 执行和验收

持续记录任务所有者/路径/状态/证据到工作树自己的进度文档，避免让两会话同时改共享PRD。实现过程中实际启动浏览器验证，不只编译或截图静态页面。依据PRD逐项验收，覆盖五种尺寸、撤销恢复、导入失败、离线查看器、接口错误和可动组件。针对状态和规则写有价值的测试，不为像素样式制造大量镜像测试。原测试和build必要检查完成后停止无理由反复测试。

输出工作树路径、分支及基线、启动命令、页面入口、阶段A/B状态、测试通过/跳过/失败、截图/视频证据、核心缺口。不得宣称接口检查通过等于实物可动。不要自动合并回主目录、推送或覆盖正式灯笼成果；集成准备好后交付可审查差异。
