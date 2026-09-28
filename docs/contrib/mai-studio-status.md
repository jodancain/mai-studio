---
description: mai studio 私有分支的维护范围、群聊修复、历史验收证据与正式发布待办
sources:
  - README.md
  - package.json
  - pnpm-lock.yaml
  - packages/provider-registry/src/providers/mai.ts
  - src/main/data/db/seeding/seeders/presetProviderSeeder.ts
  - src/main/ai/agentGroupChat/AgentGroupChatOrchestrator.ts
  - src/main/ai/agentGroupChat/mentions.ts
  - src/main/data/services/AgentGroupChatService.ts
  - src/shared/ipc/schemas/agentGroupChat.ts
  - src/renderer/hooks/agent/useAgentGroupChats.ts
  - src/renderer/pages/agents/groupChats/GroupChatPage.tsx
  - src/renderer/pages/agents/groupChats/CreateGroupChatDialog.tsx
  - src/renderer/services/aiTransport/TopicStreamSubscription.ts
  - src/renderer/utils/routeTitle.ts
  - src/main/services/binaryManager/BinaryManager.ts
  - migrations/sqlite-drizzle/0025_curvy_black_tom.sql
  - tests/e2e/regression/07-integrations.test.ts
---

# mai studio 维护状态

记录日期：2026-09-28。本页区分当前源码修复、历史候选包结果和正式发布验收；当前工作尚不能作为生产交付或公司 IT 批准的结论。

## 仓库与范围

私有仓库为 [jodancain/mai-studio](https://github.com/jodancain/mai-studio)，默认开发分支为 `main`，上游为 [CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio)。保留 React、Electron、SQLite 与现有 DataApi、IpcApi、权限和生命周期体系；许可仍为 [AGPL-3.0](../../LICENSE)。本轮验收范围是 **macOS ARM64 核心路径**，不代表 Windows、Linux 或所有可选集成已验收。

内置 `mai` 提供方默认连接 `ezr.sh`，Claude 与 Codex 的协议选择见 [提供方定义](../../packages/provider-registry/src/providers/mai.ts)。`MAIN_VITE_MAI_API_KEY` 从未提交的本机 `.env` 或构建环境读取，在初次创建提供方时写入；已有用户修改不会被重新覆盖。内部受控分发沿用共享 Key 的例外：构建产物或客户端数据中的 Key 可被提取，`.env` 不入库并不构成服务端密钥隔离。本页和提交材料不包含 Key 值、个人配置或用户数据。

9Router 是可选路由；当前没有实际 9Router 请求链路通过的验收证据，不能把 `ezr.sh` 路径的结果套用到它。

## 群聊行为与本轮修复

群聊当前只支持文本。用户直接 `@` 成员后，每个目标成员在专用会话中执行一个受限回合；无提及时仅保存上下文，Agent 回复不会再次触发成员，因此没有自动对话循环。继续使用现有 headless 与权限护栏。

下表记录本轮逐项确认并修复的 11 个问题；具体测试状态见下一节。

| 编号 | 原问题 | 修复后的行为 |
| --- | --- | --- |
| B1 | DataApi 保存消息时启动模型执行 | 发送改走 `agent_group_chat.send_message`；主进程编排调用数据服务，DataApi 保持数据库边界 |
| B2 | 未读消息超过 100 条时，提及触发消息可能不在输入中 | 选取最新 100 条有界上下文，包含当前触发消息，丢弃更早的未读上下文 |
| B3 | 同名或大小写重名成员无法准确选择 | 成员按钮在同名或保留别名场景使用稳定身份提及；有歧义的原始名称在保存前拒绝，并提示选择成员按钮 |
| B4 | 邮件地址中的 `@成员名` 意外触发执行 | 邮件等普通上下文不再作为成员提及处理 |
| B5 | 中止或超时的部分输出被当作成功回复 | 中止不发布正常群回复，也不确认消费游标；失败状态会被报告 |
| F1 | 发送失败后草稿被清空 | 失败保留草稿；成功只清除未被继续编辑的原草稿，输入上限为 40,000 字符 |
| F2 | 只能看到最新 50 条消息 | 使用标准 `cursor` 分页加载更早历史，前插消息不会触发滚动到底部 |
| F3 | 创建失败仍关闭并清空表单 | 保留名称和成员选择，只有创建成功后关闭 |
| F4 | 返回正在执行的群聊时丢失响应状态 | 初始状态读取主进程快照，后续事件带修订号；较旧快照或乱序事件不能覆盖新状态 |
| F5 | 其他窗口重命名成员后，群内提及按钮仍用旧名 | 订阅 Agent 名称、成员数据变化并刷新群成员投影 |
| R1 | attach 聚合终态抢先覆盖准确的执行分支终态 | 优先处理已收到的分支终态，仅对仍未结束的原始分支应用回退，避免成功分支显示错误或触发错误的缓存回滚 |

新增数据库表为 `agent_group_chat`、`agent_group_chat_member`、`agent_group_chat_message`。通过追加 [0025 迁移](../../migrations/sqlite-drizzle/0025_curvy_black_tom.sql) 向前升级，不能重写已发布迁移或删除数据库来绕过升级。

OpenClaw 的 npm 安装路径使用 shell-out 和 Node 26 配方。这些变更作用于真正执行安装或更新时；仅改源码不代表旧安装已更新，用户显式固定的运行时版本保持原样。

编译后的界面检查还发现群聊标签页显示原始路由名 `agent-group-chats`。已在现有标题映射中登记 `agent.group_chat.title`，带群聊参数的地址也使用翻译后的标题；未新增导航或调整页面布局。

## 当前验证进度

以下是本轮本机验证结果。独立的针对性测试合计 **894 个通过**；本地校验、云端 CI 和正式安装包验收分别记录，不能相互替代。

| 检查 | 已有证据与边界 |
| --- | --- |
| 群聊前端 | 11 个针对性回归测试通过，使用真实 UI 组件与统一数据/IPC 边界模拟；不代替打包后的真实模型调用 |
| 群聊后端 | 3 个文件、25 个针对性测试通过 |
| 流式订阅 | 54 个针对性测试通过；覆盖终态处理，不代表大输出性能验收 |
| API 网关 | 安装 Elysia 1.4.30 后，32 个文件、486 个针对性测试通过 |
| 主进程与共享层 | BinaryManager、带存量数据的迁移、IpcRouter、IpcApiService 共 4 个文件、254 个测试通过；共享层 2 个文件、25 个测试通过 |
| 路由标题 | 39 个测试通过，包含群聊基础路由与带 `groupChatId` 参数的翻译标题 |
| 数据库 | 迁移链和带存量数据的向前迁移测试通过；实际候选包的升级、备份恢复仍需验收 |
| 文档 | 新增本页后，314 个 Markdown 文件的链接、目录结构、frontmatter 和生成索引检查通过 |
| 完整 lint 与类型 | `pnpm lint` 通过：41 条非阻断 ESLint 警告，4 项类型检查通过，77,285 条翻译校验通过，无无关格式差异；该完整检查早于最后的一行路由标题映射修复，标题修复另做针对性测试与只读风格检查 |
| 生产配置构建 | electron-vite 的 main、preload、renderer 及 utility bundles 构建通过；这是编译产物验证，尚未完成正式安装包验收 |
| 编译后界面与真实模型 | 隔离 profile 的 7 个场景通过：群聊入口、更早历史及纯上下文、HTML 处理器不执行、歧义提及保留草稿与消息数、重名成员身份选择、切换房间后恢复响应状态、真实 ezr 单成员回复 |
| 私有源码上传 | 本轮编译与界面验证对应的已上传源码基线为私有 `main` 的 [`8b8b597e2`](https://github.com/jodancain/mai-studio/commit/8b8b597e2)，当时 6 个新提交的 GitHub 签名状态均为 Verified；后续标题与文档修订不属于该历史基线 |
| GitHub Actions 与发布 | 仅启用 CI，其他 22 个工作流保持禁用；未发布 Release。云端结果须在 [CI 工作流](https://github.com/jodancain/mai-studio/actions/workflows/ci.yml)中按对应提交 SHA 核对，不能由本机检查结果推定通过 |

真实模型场景先持久化 107 条上下文消息，再加入 1 条用户提及和 1 条 Agent 回复，共 109 条；仅被选中的第二位同名 Agent 回复，内容精确为 `MAI_REVIEW_OK`，没有其他 Agent 回复。耗时 10.961 秒，包含 3 秒无后续扇出观察时间；这不是正式性能基准或完整回归结果。

初次依赖审计发现 1 个 HIGH：Elysia 的 [GHSA-9643-4qgh-g8mx](https://github.com/advisories/GHSA-9643-4qgh-g8mx)，涉及 `<1.4.29`，公告修复版本为 `1.4.29`。本轮将依赖下限调整为 `^1.4.29`，解析和安装版本为 `1.4.30`。复核审计为 0 critical、0 high、43 moderate、5 low；这不等于所有依赖风险已清零。`pnpm install --frozen-lockfile --ignore-scripts` 已通过，确认锁文件与依赖声明一致。

本轮原始日志和来源校验记录位于本机 `.context/github-review-20260928/`，属于排除上传的私有证据。仓库只记录必要摘要，不上传原始 profile、凭据或个人数据。

## 2026-09-25 历史候选包

历史候选为 macOS ARM64 `2.1.3-rc.1`，未签名。安装包 SHA-256：

```text
813c1866a75698cde28feb082b396b12491136e6ad127b18db76bb22dd35e9f5
```

该候选早于本轮修复，以下数据只能描述当时的包和测试条件：

| 项目 | 历史结果 |
| --- | --- |
| 启动采样 | 10 次，新进程、同一隔离 profile、保留操作系统文件缓存；包含控制器/CDP 开销，P95 为 2,238 ms |
| 60 分钟持续运行 | JSON 记录 3,600,114 ms、121 个采样点；20/20 消息持久化核验，0 个记录错误；使用本机 loopback fixture |
| Renderer heap | 起点 65.1 MiB，终点 50.4 MiB |
| Main RSS | 起点 143.8 MiB，终点 51.5 MiB |
| 完整核心汇总 | 原始 aggregate JSON 中 `MAI-K01`、`MCP-01`、`A-02` 失败；后续独立通过日志不能替代一次完整重跑 |

没有可据以宣称通过的 64 KB/256 KB 流式响应数据集；没有 Developer ID 签名、公证完成证据。旧安装包配合对应备份的完整回退演练、实际 9Router 路由和公司 IT 批准仍未证明完成。

## 升级、恢复与正式发布门禁

更新前先退出应用，保留旧安装包，并对当前完整用户数据目录做一致性备份；记录应用版本、备份时间和备份位置。备份应包含数据库及相关文件，存放在私有位置，不提交到仓库。数据库复制必须在应用停止后进行，避免只复制活动中的 SQLite 主文件而遗漏其日志状态。

如需恢复，先保存故障版本的数据副本，再使用旧安装包和与该版本匹配的更新前备份，在隔离目录验证启动、会话和文件读取后恢复使用。不要让旧应用直接读取未经兼容验证的新 schema，不删除数据库，也不手工回写旧迁移。当前尚未完成这一整套恢复演练。

正式发布前必须完成：

1. 对最终提交运行完整质量门禁和一次全新的核心回归，包含真实模型、知识库、MCP、Agent/群聊关键路径，并核对完整汇总报告。
2. 对最终候选包重新执行启动、持续运行和 64 KB/256 KB 流式响应测试，保存可复核的数据、配置范围和安装包哈希。
3. 验证签名、公证、安装和升级，完成“旧安装包 + 对应备份”的恢复演练。
4. 分别取得技术验收和实际业务使用验收；需要公司分发时，另行取得公司 IT 批准。

通过源码检查、上传私有分支或开启 CI 都不等于发布完成。正式发布操作遵循 [发布工作流](./release-workflow.md)。
