# Windows Terminal 人工验收

日期：2026-11-15。此文是可重复步骤，不代表已通过正式视觉、IME 或全部 PTY 验收。当前已有真实 ConPTY 80×24 输入证据以及 Ink/网格测试；它们不能替代 Windows Terminal 的实际截图。

## 基准环境

使用 Windows Terminal、Cascadia Mono、UTF-8、TrueColor。先在项目根目录完成 `pnpm check`，然后打开专用终端标签页，避免影响用户其他任务。设置 160 列×42 行，运行：

```powershell
$env:TERM = 'xterm-256color'
$env:COLORTERM = 'truecolor'
node dist/cli.js
```

不要在命令行或截图中显示 API Key。需真实模型时，先由用户在进程环境设置凭据，配置文件仅写环境变量引用。

## 操作和证据

1. 在 160×42 截图，对照 `assets/tui-preview.png` 与 `assets/brand` 原文：大狐狸、字标、标语、版本、Runtime/Execution/Tools 三行卡片、分隔线和输入区域完整，状态必须来自实际配置。
2. 依次调整至 144×36、116×28、80×24 和小于 72 列，再反复放大/缩小；逐档截图，确认无横向溢出、字符图裁切或输入区错位。
3. 使用系统中文输入法组合输入，确认候选词期间不会发送；完成组合后 Enter 发送。Ctrl+J 换行，粘贴含中文、空行和多行文本，确认粘贴不误提交。
4. `/help` 后 Esc 返回，`/sessions` 查看列表；长消息期间 PgUp/PgDn 查看历史，追加内容时滚动位置保持。观察每个真实任务状态、Usage 未知值、工具 Diff 和独立检查退出码。
5. 在 ask 模式触发工具审批，核对参数、目录和范围；Esc/N 拒绝，Y 只批准当前请求。粘贴含 Y 的文字不得批准。无交互 `--json` 待审批应退出 3。
6. 执行中 Ctrl+C 取消；空闲 Ctrl+C 退出。确认光标恢复、粘贴模式关闭、Shell 可正常输入。重开程序 `/resume <id>`，确认保存对话/验收报告与原权限恢复，未知副作用不会重放。
7. 使用未配置模型、无效端点、Git Bash 缺失和断流场景，确认明确显示非 Ready 状态；设置 `NO_COLOR=1` 后仍可辨识状态。

记录终端版本、字体、尺寸、操作、实际结果及截图路径。失败时保留原始结果，不以网格快照或本地 HTTP 夹具代替。

## 当前已观察到的 PTY 结果

2026-11-15，在本机实际 ConPTY（stdin/stdout `isTTY=true`、80×24）运行构建后 CLI：欢迎页展示真实版本与 Provider setup required；`/help`、独立 Enter 与 Esc 正常；真实 bracketed paste 中文两行文本保持两行且不自动发送；空闲 Ctrl+C 退出码 0，输出包含光标恢复及 bracketed paste 关闭序列。该运行没有真实 IME 输入法组合、动态 PTY resize、模型审批或 Windows Terminal 截图。
