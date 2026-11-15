# CLI/TUI 与 Phase 1 实施记录

更新日期：2026-11-15（Asia/Shanghai）。需求依据为 [开发计划](cli-tui-phase-one-plan.md) 与 AGENTS.md。本记录区分源码实现、本地客观验收、历史证据和外部门槛，不将 Phase 1 记为全部完成。

## 当前验收结论

本轮以 e780f4c91bca6840da054cc319be473491608c3c 为基线，补齐稳定 checkpoint 真正续跑、累计预算与恢复计数、验证基线保留、上下文压缩、规划前项目分析、审批审计、TUI 报告/恢复/工作区绑定、Git 字面路径及子目录边界保护、独立安装产物编码闭环。

端口夹具修复后最终本地 **pnpm check 实际 exit 0：21 个测试文件、284 项通过、1 项平台条件跳过**；于本地 18:38:03 开始，耗时 108.99 秒，Lint、Workspace/测试 Type Check、Unit/Integration/E2E、Build 全部通过。跳过项是仅非 Windows 平台运行的 SIGINT 场景；Windows 专用 Console 取消测试已经执行，不能描述成 Windows 取消未测。

最终第二次 **pnpm smoke:package 实际 exit 0**：实际 pack/install 后经生成 bin 完成 5 次编码请求、15 次工具调用；引擎独立验证先 exit 1、修复后 exit 0，外部项目 npm 测试 exit 0。原脚本与测试断言保留，SQLite 逐事件与输出一致，两次 resume 均未重放已完成工作。模型为本地 HTTP 服务，仅证明本地协议、真实工具与独立安装产物链路，不冒充真实供应商验收。

本轮结构化证据见 [local-continuation-2026-11-15.json](acceptance/local-continuation-2026-11-15.json)。本轮生产代码已提交并 Push：**ef6ea5b945d1fe4c4d65673f5a35a660f63a843f**。其 CI 运行 43704103222 的 Ubuntu 完整检查及安装包验收通过，Windows 模型 HTTP 测试夹具因随机端口命中保留区而失败，后续安装检查未执行；已修复测试监听及清理逻辑。修复提交 **ca86ca5e7457c97c626fcbbf042fa69f58d18009** 的 CI **43705292641** 已 completed/success，Windows 与 Ubuntu 的 frozen install、完整 Check、安装产物编码验收全部通过，见 [双平台结果](acceptance/ci-continuation-2026-11-15.json)。历史提交 0888342 的成功 CI 不能代表本轮。未创建正式 Release，未推送发布 Tag。

## M0–M7 需求核对

| 里程碑 | 当前实现 | 已取得证据 | 尚待验收或明确边界 |
| --- | --- | --- | --- |
| M0：工程与契约 | pnpm Workspace、Node.js 24/ESM、严格 TypeScript、Zod 运行时校验、Kernel 事件/错误/取消/预算、模块包、质量脚本与 CI | 本轮 Lint、全部包及测试类型检查、21 文件/284 项测试与 Build 通过；同步 abort 后拒绝 Promise 的未处理拒绝已复现并回归 | 精确修复提交 ca86ca5 的 Windows/Ubuntu 完整 CI 已通过；完整外部门槛仍按各里程碑分别记录 |
| M1：品牌 TUI | 原品牌文本、四档断点、颜色降级、中文多行输入、流消息、审批、任务进度、Diff、Usage 未知值与交付报告；历史恢复和工作区绑定 | 字符网格覆盖 160×42、144×36、116×28、80×24、窄屏及 resize；实际 Ink 输入/生命周期；80×24 Windows ConPTY 观察欢迎页、帮助/Esc、中文两行 bracketed paste 不误提交、空闲 Ctrl+C exit 0 和终端状态恢复 | 用户稍后按 [正式验收步骤](windows-terminal-acceptance.md) 完成 Windows Terminal/Cascadia Mono/TrueColor 截图、IME 与完整 PTY 矩阵；80×24 ConPTY 不替代正式 160×42 及断点验收 |
| M2：首个真实闭环 | OpenAI Chat、独立 Agent Loop、Context/Prompt、统一工具入口、读取搜索、审批和流式响应 | 历史单个真实 OpenAI-compatible 端点曾完成 4 任务、27 Turn、51 工具、4 次独立 npm exit 0；本轮本地 HTTP、真实文件/Shell/SQLite、构建与独立安装链路通过 | 历史实时端点运行早于本轮改动，不能作为当前代码重新跑过的证据；本轮未重发付费请求，未保存明文 Key |
| M3：完整工具与权限 | 十个 Phase 1 工具与三模式、权限/路径边界、变更记录、输出限制/脱敏；审批真实 cwd；Git 字面路径、子目录范围与用户改动保护 | 真实临时 FS/Git/Git Bash：中文/CRLF、覆盖/hash 冲突、全目标补丁预校验、回滚失败强停、junction/越界、拒绝/取消、子进程树退出；新增 Git 恶意路径及子目录负向测试；审批 ID 错配/取消审计 | 当前 OS 用户权限下的受控执行，不是 OS Sandbox；本轮 ca86ca5 远端双平台矩阵已通过 |
| M4：全部模型接入 | openai-chat、openai-responses、anthropic-messages、ollama-chat 四独立协议；Qwen/自定义模板；环境变量凭据引用、增改/切换/探针 | 四协议本地 HTTP 真实网络覆盖分片 UTF-8/JSON、多工具关联、多轮、终止/断流、错误/超时/取消、Usage 缺失；历史一个真实兼容端点有证据 | 用户明确其余真实协议暂不配置，保留未验收；这是用户主动暂缓的端点验收，不列为本轮已确认代码缺失。本地服务不能替代逐供应商实测 |
| M5：会话与任务执行 | Worker SQLite 原子事件/快照；可选版本化 checkpoint 保存原任务、模型、TaskGraph/当前节点、验证基线/报告与累计预算；稳定边界按原图继续；completed/stopped 恢复原报告 | SQLite close/reopen、独立 Node 进程、构建后 CLI 续跑；不重规划/不重工具副作用，verification_result 不重 Shell；事务/序号/并发/初始化/关闭；模型/目录/Provider 拒绝；state/phase 联校验防伪完成；用户权限审计 | 未完成请求/工具意图、不完整批次、未知副作用或无安全 checkpoint 的 legacy 活动状态进入 needs_review。真实崩溃遗留锁仍需人工检查，不自动清锁，不宣称高级容灾 |
| M6：验证与有限恢复 | 真实 package scripts 发现/冻结、客观报告、有限重试/修复；Turn/工具/活动时间/重试/修复跨重启累计；有界项目分析和上下文压缩 | 检查先失败→证据修复→成功；删改原脚本不假绿；预算/基线不重置、存储拒绝计数回滚；普通/压缩请求先持久化消耗；压缩保留目标/验收/决策/剩余工作及完整工具交换；审批 requested/decided、拒绝/取消/错 ID/等待重启 | 当前验证发现 Node package scripts，无客观检查明确失败；自然语言条件不能单靠模型声明证明。合法变更冻结脚本需人工核实，摘要是非权威历史而非长期记忆 |
| M7：集成与分发 | 非交互 CLI、NDJSON、固定退出码、Session/Provider、包资源/Worker、CI 矩阵及手动 Release 门禁 | 全量 Check；CLI 真实 HTTP/FS/Shell/SQLite E2E；timeout 124、取消 130、非交互审批 3；独立安装编码失败修复、外部测试、重复 resume 和事件一致 | 修复提交 ca86ca5 的双平台完整 CI 已通过；正式 Windows Terminal/完整 PTY 待用户验收；无正式发布指令，不发布 Release/Tag |

## 本轮实现与安全边界

- **恢复和状态：** executeTask(session) 继续原任务和原图，沿用保存权限，不以新规划冒充续跑。task.started 使用实际 running 状态，失败/取消节点与执行终态保存。completed 必须有完整安全 checkpoint 与客观报告；legacy completed 必须有真实历史通过事件。stopped 保留原错误及退出码，不自动重启。
- **预算和审批：** Turn/工具/重试/修复/活动时间累计且不可回滚，普通推理/规划/压缩请求先保存消耗。先记录 approval.requested 与 awaiting_approval/unsafe，再记录 approval.decided，包含请求 ID、工具、真实 cwd 与范围；无交互不伪造批准，日志和快照脱敏。
- **Context 和分析：** 规划前经有界 glob/read_file 读取真实规则/项目文档，受同一权限、预算、取消和审计约束。仓库内容及压缩摘要只作不可信 user data，不提升权限或覆盖引擎策略；目标/验收保留，工具交换不拆散。
- **工具和验证：** 原脚本/manager 删除或弱化触发 review，无检查不假完成；回滚失败立即停止后续工具；Git literal/subdir 保护保留用户改动。未知副作用不自动重放。
- **TUI 和安装：** 任务、Diff、Usage、审批 cwd 与报告来自事件。恢复 A 后新任务使用 A 工作区，/new 恢复当前工作区。独立安装后的 bin、Worker 和品牌资源参与验收。

## 本轮命令和验收映射

| 命令 | 真实结果 |
| --- | --- |
| pnpm check | exit 0；21 test files、284 pass、1 平台 skip；18:38:03 开始，108.99 秒；Lint/Typecheck/Unit/Integration/E2E/Build 通过 |
| pnpm smoke:package | 最终第二次独立安装 exit 0；5 coding requests、15 tool calls、引擎 [1,0]、外部 npm 0、两次 resume 无重放、SQLite/NDJSON 一致 |
| 定向回归 | 伪 completed 先红后绿；同步 abort+reject 无 unhandled；恢复预算/基线/修复数不重置；审批 ID/取消/等待恢复；多次压缩；Git literal/subdir；TUI 完成证据与工作区调用方 |

完整 pnpm test 已包含 Integration/E2E；重复定向入口不算额外数量。#复现/#基线 对应负向和先红后绿；#回归/#复发 对应全量、两进程及重复安装/恢复；#验证/#核实 对应实际文件、Diff、SQLite 和退出码；#严谨/#归族/#时间维 对应边界/取消/并发/状态/重启；#假绿 对应无检查不完成、保留断言、284 pass/1 skip 与外部未验收严格区分。

## 外部门槛与交付状态

- 用户明确其余真实供应商暂不配置，保留未验收；不以本地 HTTP 替代，也不将暂缓描述成已验收。
- 用户稍后按 [Windows Terminal 验收步骤](windows-terminal-acceptance.md) 完成正式截图、IME 和完整 PTY。80×24 ConPTY 是补充，不能替代正式视觉基线。
- 本轮本地质量与独立安装验收通过，生产代码 ef6ea5b945d1fe4c4d65673f5a35a660f63a843f 已 Commit/Push；其 Ubuntu CI 通过，Windows 的 HTTP 夹具端口失败已修，修复提交 ca86ca5e7457c97c626fcbbf042fa69f58d18009 的运行 43705292641 已核实双平台全部成功，未通过的外部门槛仍保留。
- 已有 Release/版本/说明门禁；未发布 Release/Tag。未引入 Multi-Agent、长期记忆、MCP/Web Research、OS Sandbox、Git Worktree 或并行工作区。

## 历史真实端点证据

本节均为本轮之前的事实，不包含地址、凭据或环境变量值，不代表当前最终代码重新完成实时端点验收。

1. 历史 OpenAI-compatible 探针收到 ELVION_READY；两次 Usage 为 65/21/86 与 65/24/89。
2. 首次编码已修改 math/README，但验收宿主 PATHEXT 仅 .CPL 且缺少 ComSpec，独立 npm 失败并达到外层 deadline，该次不计完成。
3. 第二次仅恢复验收进程正常命令查找环境后，真实 Loop 以 execution.completed / exit 0 完成：4 任务、27 Agent Turn、51 工具、4 次引擎 npm test exit 0；math 从 a+b 修为 a*b，README 正确，原脚本及断言未改。见 [live-model-2026-11-15.json](acceptance/live-model-2026-11-15.json)。
4. 该运行早于验证基线冻结、未知回滚保护及本轮改动。历史事实保留，本轮没有重新跑真实付费端点，不扩写为当前代码或其余供应商验收。

## 历史工程与 CI 记录

以下不是本轮最终 SHA 的 CI。当时 CLI resume 仅恢复状态/报告，未实现稳定 checkpoint 继续；该旧限制本轮已补齐，不作为当前能力结论。

- 运行 43697152323 / a9d29ed170fa545fca0524d5151df0d81b803167 在 Ubuntu 暴露内联 JS 转义、ENOTDIR 清理覆盖错误、Ink CI 帧时机问题；修后本地 15 文件、193 pass、1 skip，保留退出码断言，未跳过检查。
- 运行 43697811331 / b0e9878 仍有 Ink 最后一帧断言；修正卸载生命周期，没有修改 CI 环境或降低门槛。
- 运行 43698322700 / 5ec0cbb 的 Ubuntu 全过，Windows 暴露短路径/大小写身份与回滚夹具未命中；修复 realpath 并补 junction/大小写/不同目录和 Provider 拒绝。
- 此后历史本地 **15 文件、198 pass、1 平台 skip**，Lint/Typecheck/Build exit 0。这不是本轮 21 文件/284 pass 结果。
- 历史精确提交 0888342133be4f378e597dab5e7a21ce42bd96d0 的运行 43699015123 completed/success；Ubuntu 与 Windows frozen install、Check、安装包冒烟全过。见 [ci-2026-11-15.json](acceptance/ci-2026-11-15.json)。其成功不覆盖本轮改动。

## 本轮远端端口夹具修复

运行 43704103222 / ef6ea5b 的 Windows 结果为 282 pass、1 fail、1 平台 skip；唯一失败为 OpenAI Responses 断流场景的 HTTP 服务监听 `EACCES`，随后清理未启动服务又产生 `Server is not running`。此时测试尚未请求协议适配器，不能归为协议功能已失败或已通过。Ubuntu 同提交全部质量与安装验收通过。原始脱敏状态见 [ci-continuation-failed-2026-11-15.json](acceptance/ci-continuation-failed-2026-11-15.json)。

测试现改由操作系统 `listen(0, 127.0.0.1)` 分配非特权回环端口，成功监听才纳入清理；不放宽权限、不重试掩盖错误、不删协议断言。新增异步 EACCES 回归验证原错误身份、未启动服务不清理以及监听器无泄漏。定向 53/53 及模型类型检查、ESLint 已实际通过，此后完整 pnpm check 实际通过：21 文件、284 pass、1 平台 skip，18:38:03 开始，108.99 秒；修复提交 ca86ca5 的精确远端运行 43705292641 已完成，Windows 与 Ubuntu 的完整检查和安装产物编码验收均 success。
