# Elvion

Your Partner in Action.

Elvion 是独立实现的单 Agent Coding Engine，提供原生字符 CLI/TUI。使用 TypeScript、Node.js 24、pnpm Workspaces、React/Ink 和 Worker SQLite；不依赖 Qwen Code Runtime。

## 开发与运行

```powershell
pnpm install --frozen-lockfile
pnpm check
node dist/cli.js --help
node dist/cli.js doctor --json
node dist/cli.js
```

Windows 上安装 Git for Windows，`bash` 使用 Git Bash。若无法探测安装位置，设置 `ELVION_BASH_PATH` 为 `bash.exe` 的绝对路径。Windows 子进程树通过 Job Object 监督，要求系统 PowerShell 可使用 Add-Type。Node 的 SQLite API 运行在独立 Worker，终端不执行同步数据库操作。

## 配置模型

```powershell
node dist/cli.js providers add openai --protocol openai-chat --url https://api.openai.com/v1 --model <模型名> --key-env OPENAI_API_KEY
node dist/cli.js providers test openai
node dist/cli.js providers list
node dist/cli.js providers edit openai --model <模型名>
```

密钥由用户在进程环境中配置，配置文件只保存环境变量名。不要把密钥放在命令行或 `/provider` JSON 中。支持 `openai-chat`、`openai-responses`、`anthropic-messages`、`ollama-chat`；Qwen 选择其 OpenAI 兼容端点；自定义供应商选择同样的协议模板，不能加载任意脚本。Base URL 为 API 根路径：OpenAI/Anthropic 通常包含 `/v1`，Ollama 为服务根 URL。模型名按端点实际配置，不会自动替换模型或协议。

TUI 通过 `/provider` 新增、编辑、测试及切换配置，`/model` 切换精确模型名。未配置时明确显示待配置状态。配置和会话默认位于本地数据目录 `Elvion/`；`ELVION_DATA_DIR` 或 `--data-dir` 可显式指定。

## 执行与权限

```powershell
node dist/cli.js run "分析并修复项目中的类型错误" --json --permissions auto-edit
node dist/cli.js sessions list --json
node dist/cli.js resume <会话ID> --json
```

- `ask`：全部工具逐次批准。
- `auto-edit`（新会话默认）：工作区读取、搜索和编辑免审批；Shell、Git 写入及工作区外访问需批准。
- `full-access`：免审批，使用当前操作系统用户权限，仍执行校验、取消、超时、审计和输出限制。

非交互执行不会猜测批准，需审批时返回 `approval_required`、退出码 3。需要交互批准可用 TUI。完全访问允许执行有副作用的项目脚本，请根据实际任务选择权限。这是受控执行，不提供操作系统级沙箱。

执行先通过独立无工具模型调用建立严格校验的任务 DAG，然后串行完成可验证增量。每个任务的真实项目检查通过后才解锁依赖；验证失败最多修复两轮。默认 50 个模型 Turn、100 次工具调用、30 分钟，Shell 默认 120 秒。当前客观验证发现 Node `package.json` 中的 Lint、Typecheck、Test、Integration、E2E、Build 等脚本；没有可执行检查时会失败并说明未验收。自然语言验收文字本身不构成自动证明。

会话保存事件、消息、权限和任务状态。CLI `resume` 恢复并报告已保存状态，不自动重放旧任务；TUI `/resume <id>` 后可以提交新指令。崩溃时未确认的工具副作用进入 `needs_review`，需检查文件、Git 和进程后创建新任务。工作区锁防止并发执行；遗留锁必须先核查，不能自动删除。

JSON 模式 stdout 为结构化 JSON/NDJSON，诊断写 stderr。退出码：成功 0，执行失败 1，参数/配置错误 2，待审批 3，超时 124，用户取消 130。Usage 缺失显示未知。

## TUI

直接加载 `assets/brand` 原始狐狸和字标文本。支持大/小狐狸双栏、字标与窄屏布局，动态 resize、TrueColor 与 `NO_COLOR`。Enter 发送，Ctrl+J 换行，PgUp/PgDn 滚动；活动任务 Ctrl+C 取消，空闲 Ctrl+C 退出。审批仅 Y 批准当前调用，N/Esc 拒绝。`/provider /model /permissions /sessions /resume /new /help` 提供配置与会话入口。

正式视觉基准为 Windows Terminal、Cascadia Mono、UTF-8、TrueColor、160×42；字符和合成 TTY 测试已实现，真实 Windows Terminal 截图验收状态见实施记录。

## 检查与分发

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
pnpm smoke:package
```

`dist/` 含可独立打包的 npm 包、CLI、SQLite Worker 及全部品牌文本；`smoke:package` 实际 pack、在独立临时目录安装并验证资源与命令。内部 Workspace 已打包，第三方为普通依赖。GitHub CI 在 Windows/Linux 检查。手工触发的 `release.yml` 重新验证版本、检查和安装包，使用 `release/release-<版本>.md` 作为发布说明；开发期间不会自动创建 Tag 或 Release。

更多说明：[开发计划](docs/cli-tui-phase-one-plan.md)、[实施与验收记录](docs/development-status.md)、[工程决策](docs/adr/0001-phase-one-foundation.md)、[工具 Schema 与权限](packages/tool/README.md)、[模型协议](packages/model/README.md)、[执行与恢复](packages/execution/README.md)。
