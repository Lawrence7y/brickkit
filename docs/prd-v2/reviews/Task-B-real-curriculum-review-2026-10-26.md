# 真实装配 Curriculum 复核：模型状态对已成立，训练闭环仍需修正

日期：2026-10-26。范围：`out/prd-v2/run-20261026-v4/B/real-assembly-curriculum/`。

**本轮可以确认“15 对 builder 模型状态及配套图像的初稿已交付”。这与先前纯 PIL 徽标 smoke 相比有明确进展。仍不能核销为“可直接训练的无泄漏候选闭环”“1 正例 + 3 个经几何验证的负例”或“Qwen 真实 Processor 预检已通过”。**

本次只读 B 代码与产物，独立调用校验和几何函数；没有重生成数据、重新训练或覆盖原报告。机器证据见 [real-curriculum-evidence-20261026.json](./real-curriculum-evidence-20261026.json)。

## 1. 本次确认的交付

| 核查项 | 实测结果 |
|---|---|
| 样例数量 | 15 对，三类各 5 对 |
| 模型内容与清单哈希 | 30/30 匹配 |
| PNG 内容与清单哈希 | 30/30 匹配，30 个独立哈希 |
| 独立静态校验 | 30 个模型均 0 errors |
| 实际业务 warnings | 9 个状态合计 10 条 |
| 指定五份测试 | 30 tests、30 pass、0 fail |

模型状态确实来自 builder 的拼插/组件接口，支持继续完善该数据集。需要区分：测试程序没有告警，与数据模型零 warnings 是两件事。

现有 warnings 为颜色 7 不在本次目录颜色表中，以及子组件和主体混在同一步的 `sub-mixed`。`b.assert()` 只把 errors 当失败，不会保证 warnings 为 0；生成器的固定 `builderReceipt` 没有记录这些诊断。

## 2. R-01 / P0：正确答案直接暴露在候选 ID 中

生成器把正确项命名为 `cand_target`，其他项命名为 `cand_dist_1/2/3`。该名称保留在正式 `curriculum-samples.json` 的输入候选中，也会被 Qwen 的提示文本打印。

本次不读图像、不读 target 来预测，仅选择 `candidateId === 'cand_target'`：**15/15 正确**。

候选位置打乱与旋转查表发生冲突，没有消除这条更直接的答案通道。需要：

- 所有公开候选使用无目标含义的 ID，按每条样本独立分配；
- isTarget、正确项原始位置等只存在于标签/审核数据，不进入模型输入；
- 检查实际序列化 prompt，确认没有目标含义的字符串、字段、默认排序泄漏；
- 将候选重排和 ID 重命名测试加入回归，正确答案跟随真实动作身份变换。

## 3. R-02 / P0：负例未实际执行，至少三条与正例等价

生成器调用 builder 构建了正例前后状态，但候选/负例来自手写数组；没有逐个通过候选枚举或执行产生诊断。因此“引擎给出 4 个候选”和“3 个真实几何负样本”超出了当前证据。

本次对 `case_snot_01`、`case_snot_03`、`case_snot_05` 的 `cand_dist_2` 进行独立诊断：借助正例中的父件与受体，按生成器使用的角度约定重新 snap 1×1 板。

三条结果均为：

```text
与正例材料碰撞盒完全一致：true
真实连接成立：true
与当前模型碰撞：false
```

这意味着它们在当前引擎几何/连接语义下是等价正确装法，却没有进入 `equivalentCandidates`。不能将它们作为唯一正确标签之外的负例。

下一版应对每个候选执行并存证：

1. 物理不合法：记录具体错误；
2. 物理合法但目标不一致：记录结果状态及与目标的差异；
3. 与目标等价：加入正确动作集合。

候选必须含可重放的父实例、连接器/受体、方向、库存身份或子组件引用。组件模板与挂装动作也需可解析，不能只有 `subassembly_bumper` 这类未导出的符号名称。

## 4. R-03 / P1：C3 与姿态契约没有真正通过

按 B 自己提供的 Dataset Schema 检查，15 条样本均缺少顶层必填字段：

```text
protocolVersion / assetLock / stateRef / verification
```

此外，15 个候选在 `orientationId` 中写入 90 或 180；该字段按 PRD 的正交姿态表应为 0～23。如果表达绕接口轴的角度，应使用明确的 `rollDeg` 或通过适配器转换，不能混用单位。

当前测试只检查样本存在、哈希、收据字段和候选位置，没有执行上述 Schema 和逐候选语义验证。

## 5. R-04：渲染可作为碰撞盒预览，不能冒充完整零件接口视觉

当前 SVG 渲染取 `partBoxes` 的盒面做投影，标号位置由 `badgePositions` 手填。它确实受到模型三维坐标驱动，可以作为粗结构预览，但没有使用正式 LDraw/Three.js 零件几何，也未从稳定接口表自动生成并遮挡过滤全部标签。

因此暂标记为 `collision_proxy_preview` 更准确。训练小模型识别凸点、底孔、铰链或零件细节时，应消费已有正式渲染与接口标号能力，保留 2D↔3D 接口映射和相机参数。

这项不否定已经生成的模型状态对，但其视觉用途需按实际能力限定。

## 6. R-05 / P0：Qwen dry-run 仍是模拟网格和模拟标签检查

训练分支已补充实际 PIL 双图、`images=pil_images` 与按 prompt token 长度掩码的实现，这些是有效代码进展。

但 `--dry_run` 在构建真实 Processor/Dataset 之前返回，实际执行的是：

- 用 PIL 验证 train+validation 的图片，本次报告为 12 条样本、24 张图；
- 根据宽高 `//14` 手造 `image_grid_thw`，报告也命名为 `simulated_image_grid_thw`；
- 用固定的 8 个 `mock_input_ids` 和固定 `prompt_len=4` 验证赋值为 -100。

这没有验证真实 Processor 输出的 `pixel_values/image_grid_thw`，也没有验证真实 tokenizer 上的 assistant 区间、padding、双图 batch 或一次模型 forward/backward。报告里的 `assistant_only_loss_masking_verified=true` 超出了执行范围。

建议拆分状态：

```text
image_file_integrity = verified
processor_batch = unverified
assistant_token_mask = unverified
training_forward_backward = unverified
```

真实图像接口和模板处理参照 [Transformers Qwen2.5-VL 官方文档](https://huggingface.co/docs/transformers/model_doc/qwen2_5_vl)。可以先用本地或可获得的真实 Processor 在 CPU 上检验；缺少配置时记录未测，不能用 mock 代替。大基座反向执行仍可因硬件不足保持未完成。

## 7. 下一次只需关闭这些具体门禁

1. 保留 15 对真实模型状态，修正 warnings，不再重新从头构建数据主线。
2. 匿名化候选，消除 `cand_target`；逐条执行候选，正确处理三条已知等价动作。
3. 保存可独立重放的动作与组件源，并满足 C3/姿态/资产锁的真实契约。
4. 正式渲染与接口映射采用已有模块；碰撞盒预览单列用途。
5. 用真实 Processor 输出验证双图张量和 tokenizer 标签；没有跑到的层明确 unverified。

这些完成后，可以验收“真实装配最小开发集的数据链路”。不要求此时完成整书或大型训练，也不修改正式 PRD 留出门槛。

## 8. 复现和可转交提示词

```powershell
node docs/prd-v2/reviews/check-real-curriculum-20261026.mjs
```

转交 B：

```text
请读取 docs/prd-v2/reviews/Task-B-real-curriculum-review-2026-10-26.md。

本轮15对builder模型与30张图像真实落盘已确认，30个模型独立校验均零errors，方向应保留。不要重做整条主线。

数据链路仍有五项具体门禁：公开candidateId=cand_target使不用图也15/15正确；SNOT_01/03/05的90度1x1板候选与正例材料盒相同、可连接且无碰撞，应计等价正确动作；负例目前为手写且没有逐条执行；15条C3样本缺4项必填字段、orientationId混入90/180；Qwen dry_run仍用模拟网格和mock token，没有实际调用Processor检验mask。

请匿名化输入候选，对全部候选执行存证并重放正例得到目标，补齐真实资产/状态/组件契约，修复9个状态中的10条warnings。采用正式零件渲染/接口映射，或明确把现有图片标为碰撞盒预览。

Qwen训练分支的PIL和images参数可保留，但dry-run报告请按真正执行层分状态。只有真实Processor和tokenizer batch检查后才标相应verified；模型反向执行因资源不足可以未完成。

继续保留旧结果，新证据另起路径；本次目标是最小开发集链路通过，不追加整书或大规模训练要求。不要覆盖A拥有的实现。
```
