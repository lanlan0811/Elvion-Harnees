# CLI/TUI 与 Phase 1 实施记录

更新日期：2026-11-15（Asia/Shanghai）。需求来源：本地《Elvion CLI-TUI 与 Phase 1 引擎开发计划》及 AGENTS.md。目标为需求、项目分析、任务规划、工具调用、跨文件修改、独立验证、有限恢复、会话保存和交付报告的单 Agent 闭环。

本记录区分源码实现、本地客观验收与完整里程碑门槛。源码已形成可运行实现；仍有真实供应商、正式终端视觉及远端 CI 门槛待验收，不能将 Phase 1 记为全部完成。

## 里程碑状态

| 里程碑 | 已实现范围 | 已取得验收证据 | 尚未通过的完整门槛 |
| --- | --- | --- | --- |
| M0：工程与契约 | pnpm Workspace、Node.js 24/ESM、严格 TypeScript、Kernel 事件/错误/取消/预算契约、模块包、质量脚本及 CI 配置 | `pnpm check` 中 Lint、全部包及测试代码类型检查、测试、构建均退出 0 | Windows/Ubuntu 远端 CI 已触发，首轮 Linux 失败正在修复；实现完成、本地工程门槛通过 |
| M1：品牌 TUI | React/Ink 字符界面、原始大小狐狸及字标、四档断点、颜色降级、中文多行输入、流消息、审批、滚动、Diff/状态/报告显示 | 原品牌文本保真；160×42、144×36、116×28、80×24、窄屏和反复 resize 的字符网格测试；实际 Ink 输入流测试覆盖 Enter、Ctrl+J、中文、Esc 拒绝、单次审批、取消及 raw mode 恢复 | 本机未检测到 Windows Terminal；Cascadia Mono/TrueColor 正式环境截图及人工视觉对照未验收。流模拟输入不等同于真实终端 IME、粘贴和 PTY 全场景验收 |
| M2：首个真实闭环 | OpenAI Chat 适配、独立 Agent Loop、Context/Prompt、Tool Runtime、读取/搜索及审批 | 第二次真实 OpenAI-compatible 运行取得 `execution.completed` / exit 0；完成 4 个任务、27 个 Agent Turn、51 次工具调用，4 次引擎独立 `npm run test` 均 exit 0；实际修复 `math` 并更新 README，测试断言和 package scripts 未改 | 该真实运行早于最终验证基线冻结及不确定回滚保护补丁；最终代码须随后完成本地回归及精确 SHA 的 CI。此证据仅覆盖一个真实端点，不代表全部供应商验收 |
| M3：完整工具与权限 | `bash`、`read_file`、`write_file`、`edit_file`、`grep`、`glob`、`git`、`diff`、`apply_patch`、`todo`；ask/auto-edit/full-access 三模式 | 真实临时文件系统、中文路径/CRLF、精确匹配、覆盖/hash 冲突、补丁全目标预校验、真实 Git Diff/受控暂存提交、真实 Git Bash、拒绝/取消、越界与 junction、输出限制/脱敏、真实子进程树超时及取消测试通过 | 本地自动化门槛通过；其跨平台行为仍须远端矩阵核实。权限属于受控执行，不是 OS 沙箱 |
| M4：全部模型接入 | `openai-chat`、`openai-responses`、`anthropic-messages`、`ollama-chat` 四独立协议；Qwen 使用兼容配置；自定义供应商按协议配置；配置增改/切换/探针 | 四协议均经本地 HTTP 服务检验实际分片 UTF-8/JSON、文本流、多工具与后续结果、终止、断流、错误、取消、超时及 Usage 缺失；配置只存环境变量引用，拒绝明文凭据；一个真实 OpenAI-compatible 端点连通通过 | 未完成所有真实 OpenAI 双协议、Anthropic、Qwen、Ollama 和自定义供应商端点的逐链路验收。本地 HTTP 夹具通过不能代替上述真实供应商验收 |
| M5：会话与任务执行 | Worker SQLite Repository、版本化事件/快照、模型规划与 Task DAG、串行执行、依赖门槛、同工作区互斥、会话恢复 | 真 SQLite 文件及 Worker 重启；序号/事务/双写冲突、初始化锁竞争、并发关闭、权限保存恢复；两节点规划执行及逐节点验证；未知副作用转 `needs_review`，稳定会话不重放旧操作 | 本地自动化门槛通过；崩溃未知副作用仍需用户核实，不会自动宣称已恢复成功。CLI `resume` 仅恢复状态/报告，不调用模型或重放工具 |
| M6：验证与有限恢复 | 从真实 package scripts 发现验证项、验证经统一工具权限入口、实际命令/退出码/证据报告、有限重试/修复、Turn/工具/时间预算 | 本地夹具覆盖真实检查先 exit 1、修复后 exit 0；第二次真实模型闭环的 4 次引擎独立 `npm run test` 均 exit 0，原测试及 package scripts 保持不变；无检查不能假完成；验证工具计入预算；审批、拒绝、取消和超时不自动重试 | 最终验证基线冻结及不确定回滚保护补丁的本地回归/CI 须另行记录；真实运行证据不覆盖补丁后的最终代码或全部真实供应商 |
| M7：集成与分发 | 非交互 CLI、NDJSON、固定退出码、会话/供应商命令、包资源/Worker、安装包脚本、CI 矩阵和手动 Release 门禁 | 实际构建产物 CLI 子进程端到端覆盖跨文件修改、验证失败修复、恢复、不交互审批 exit 3、真实 HTTP 超时 exit 124；Windows 隐藏 Console helper 实际 Ctrl+C 返回 130；安装包冒烟完整执行两次通过 | 首轮远端 CI 暴露的跨平台问题正在修复，最终 SHA 待重新核实；Windows Terminal 截图和完整 PTY 交互未验收。未创建正式 Release 或发布 Tag |

## 已执行的工程命令

最终两项保护补丁后的根目录完整检查使用 `pnpm check`，展开为以下真实脚本，全部退出 0：

| 命令 | 实际结果与覆盖 |
| --- | --- |
| `pnpm lint` | ESLint 通过，无通过修改工作流或屏蔽有效断言掩盖失败 |
| `pnpm typecheck` | 各 Workspace 包 `tsc --noEmit` 及 `tsc -p tests/tsconfig.json` 通过 |
| `pnpm test` | 15 个测试文件，193 项通过、1 项按平台条件跳过。当前 Windows 已执行专用 Console Ctrl+C 测试；跳过项是仅在非 Windows 平台运行的 SIGINT 场景，不是失败被跳过 |
| `pnpm build` | 构建 CLI、内部模块及 Session Worker，并包含原品牌资源，通过 |
| `pnpm smoke:package` | 独立安装目录重复执行均通过：实际 pack/install、版本/help、doctor 未配置状态、会话 Worker、供应商列表、全部品牌资源字节及无未发布 Workspace 依赖 |

`pnpm test:integration` 与 `pnpm test:e2e` 为仓库提供的定向重跑入口；本次完整 `pnpm test` 已包含对应目录，不能将重复脚本入口计算为额外测试数量。构建产物 E2E 使用本地 HTTP 协议服务，真实执行文件、Shell、SQLite 和 CLI 进程；脚本化或本地 HTTP 模型响应仅证明本地引擎行为。

新增保护已回归：修改或删除执行前冻结的项目脚本不能假绿；真实补丁回滚冲突立即中止 Agent、保留 `requiresReview` 并持久化为 `needs_review`。普通无副作用的工具失败仍允许模型修正。

测试分布为 Kernel、模型配置/四协议、工具、Agent 安全、Context、Task、Verification、SQLite 初始化，以及会话/执行集成、CLI 应用层、Ink UI 和构建后 CLI E2E，共 15 个文件。具体断言及场景以源码测试为准。

## 真实端点验收记录

本节仅记录实际观察结果，不包含端点地址、供应商凭据或凭据环境变量值。

1. 真实 OpenAI-compatible 连通探针成功：收到 `ELVION_READY`；Usage 为 65/21/86（输入/输出/总计）。此证据只证明该端点当时的连通和响应链路。
2. 首次真实编码 Loop 已通过工具实际修改 `math` 与 README；任务测试从失败变为通过。此证据验证了真实模型到工具及文件副作用链路。
3. 同次运行中，Node REPL 验收启动进程的 `PATHEXT` 只有 `.CPL`，并缺少 `ComSpec`，导致引擎独立 npm 验证失败；其后达到 6 分钟外层验收 deadline。该次运行不能记为独立验证通过或执行完成。
4. 第二次运行仅为验收进程恢复正常 Windows 命令查找环境后重测，未因此修改产品行为。连通探针再次返回 `ELVION_READY`，Usage 为 65/24/89（输入/输出/总计）。
5. 第二次真实编码 Loop 以 `execution.completed` / exit 0 完成：4 个任务、27 个 Agent Turn、51 次工具调用，4 次引擎独立 `npm run test` 均 exit 0。`math.mjs` 从 `a+b` 修正为 `a*b`，README Usage 正确；原测试断言及 package scripts 未改，夹具仍只有原 5 个文件，没有额外 `.npmrc`。脱敏证据见 [live-model-2026-11-15.json](acceptance/live-model-2026-11-15.json)。
6. 该真实运行发生在最终验证基线冻结及不确定回滚保护补丁之前；最终代码的本地回归及远端 CI 需随后单独核实。本节仅证明一个已配置 OpenAI-compatible 端点的完整闭环，不代表所有真实供应商均已验收。

## 安全、状态和回归证据

| AGENTS 验收项 | 已落实证据 |
| --- | --- |
| #复现、#基线 | 明确成功与失败场景；测试项目先失败再修复；未配置模型/无验证脚本保持非成功状态 |
| #回归、#复发 | 15 文件完整回归；安装包重复独立冒烟；SQLite 初始化竞争、重启及重复操作测试 |
| #验证、#核实 | 读取实际文件、Diff、SQLite 内容、真实子进程退出码和验证证据；不是只断言函数被调用 |
| #严谨、#归族 | Schema、越界路径/junction、精确匹配/覆盖冲突、Git 用户改动保护、协议畸形分片、审批 ID、拒绝和取消、敏感流跨分片脱敏 |
| #时间维 | 模型 pending 流取消/超时、真实进程树退出、审批中取消、会话重启、同工作区互斥、SQLite 多 Worker 竞争与并发关闭 |
| #假绿 | 保留失败断言；独立验证失败不完成；无检查/需要审批不默认成功；193 pass 与 1 平台条件 skip 如实区分；真实端点与本地夹具证据分开 |

## 剩余验收与交付状态

- 一个真实 OpenAI-compatible 端点的完整闭环已取得证据；最终两项保护补丁后的本地完整回归通过，CI 待核实，全部真实供应商逐协议验收仍未完成。
- Windows Terminal 正式 160×42 及断点实际截图、人工视觉对照、真实 IME/PTY 完整交互证据待验收。本机未检测到 Windows Terminal，现有字符网格与 Ink 测试不能替代该门槛。
- CI 配置已覆盖 `windows-latest` 和 `ubuntu-latest` 的 frozen install、`pnpm check`、安装包冒烟；已推送并读取精确 SHA 的首轮运行 `43697152323`：Ubuntu 失败、Windows 因矩阵 fail-fast 被取消；不能声称 CI 全绿。失败原因和修复见下文。
- 已完成首个中文 Commit `a9d29ed` 并 Push `origin main`；首轮 CI 的修复需在完整本地检查后追加提交，再核实最终 SHA 的全部 Jobs。
- 已准备手动 Release 工作流与版本/发布说明检查；未获得正式发布指令，因此未发布 Release、未推送发布 Tag。

Phase 1 未引入 Multi-Agent、长期记忆、MCP/Web Research、OS 级 Sandbox、Git Worktree 或并行工作区等后续阶段功能。文件和 Shell 安全依赖实际权限检查、路径边界及当前 OS 用户权限；不宣称绝对安全。

## 首轮远端 CI 复核与修复

运行 `43697152323` 对应 `a9d29ed170fa545fca0524d5151df0d81b803167`。Ubuntu 的四项失败来自三类问题：npm 测试夹具未转义的内联 JS 在 sh 下退出 2；保存配置失败后的清理 ENOTDIR 覆盖了类型化错误；Ink 测试在真实渲染前断言。已改为真实 .mjs 测试文件（保留并加强 exit 1/0 断言）、保留原始持久化异常 cause，以及等待实际渲染。没有删除测试或降低门槛。修复后再次完整执行 `pnpm check`：15 个文件、193 pass、1 平台条件 skip，Lint/Typecheck/Build 均退出 0；后续 CI 结果待远端取得后更新。
