# Phase 1 Tool Runtime

`ToolRuntime` 是十个 Phase 1 工具的统一入口。调用前执行严格 Zod Schema 校验、规范化真实路径、权限判定和单次审批；调用后返回 Kernel `ToolResult`，记录起止审计、耗时、截断状态及文件变更 SHA-256。工具输出按已知凭据环境变量和常见 Token 形态脱敏。

```ts
const tools = new ToolRuntime({ bashPath: 'C:/Program Files/Git/bin/bash.exe' });
const result = await tools.execute(call, {
  workspace, permissionMode: 'auto-edit', signal,
  approve: async request => ({ requestId: request.id, decision: 'approved' }),
});
```

审批回调只能由用户交互适配层提供。缺少回调时需审批的调用返回 `approval_required`；拒绝、取消和 ID 不匹配均不执行。`ask` 审批全部工具；`auto-edit` 允许工作区文件读写、搜索、Todo 和 Git 只读，Shell、Git 写入及工作区外访问逐次审批；`full-access` 免审批，仍执行 Schema、超时、取消、限长与审计。模型参数没有权限升级字段。

| 工具 | 输入要点 | 结果与限制 |
|---|---|---|
| `read_file` | `path`, `startLine?`, `endLine?` | UTF-8、原始 CRLF、1-based 范围、SHA-256；拒绝二进制/无效编码/大文件 |
| `write_file` | `path`, `content`, `overwrite?`, `expectedHash?` | 默认不覆盖；临时文件加 rename；乐观并发校验；变更记录 |
| `edit_file` | `path`, `oldText`, `newText`, `expectedMatches?`, `expectedHash?` | 精确非重叠匹配；数量不符不修改；保留其它内容 |
| `glob` | `pattern`, `path?`, `exclude?`, `maxResults?` | 相对 glob；不递归符号链接/junction；最多扫描 20,000 条目录项 |
| `grep` | `pattern`, `path?`, `regex?`, `caseSensitive?`, `filePattern?`, `exclude?`, `maxResults?` | 默认字面量；正则使用独立 Git ERE 进程，避免主线程执行不可信正则；返回路径/行号/文本 |
| `bash` | `command`, `cwd?`, `timeoutMs?` | Git Bash；默认 120 秒；stdout/stderr/退出码；本地进程树取消 |
| `git` | `operation`, `cwd?`, `paths?`, `message?`, `ref?`, `limit?`, `staged?` | 白名单 init/status/diff/log/show/add/commit；禁止任意参数、历史改写、推送；关闭 hooks、外部 diff、textconv |
| `diff` | `cwd?`, `paths?`, `staged?` | 真实 Git 行级 diff；不运行外部 diff 或 textconv |
| `apply_patch` | `patch` | 标准 unified diff；创建/编辑/删除；全部上下文/数量/目标预检；落盘失败逆序回滚并报告回滚失败 |
| `todo` | `operation`, `id?`, `text?`, `status?` | list/add/update/remove；每 Runtime、工作区独立；仅辅助事项，不替代 Task 或 Verification |

所有完整 Schema 由 `descriptors()` 暴露，`inputSchemas` 同步导出。文件上限默认 2 MB，输出默认 32,000 字符。搜索默认排除 `.git`、`node_modules`、`.elvion`、`.codex`、`dist`、`coverage`、`.cache`。补丁不支持重命名、二进制、带引号路径或混合行尾；此类修改使用精确文件编辑。

Git 写入需要显式 `paths`，且目标必须由当前 Runtime 从干净 Git 基线修改，之后内容仍与工具记录一致；存在不相关暂存改动时拒绝提交。原有用户改动可以经文件工具编辑，但不会自动暂存或提交。文件工具禁止直接写 `.git` 元数据。

Windows Shell 由固定 PowerShell/C# 监督器在 `CREATE_SUSPENDED` 后绑定 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，再恢复线程。超时或取消关闭监督器，从而终止后代进程；没有通过字符串拼接执行目标 argv。监督器编译和 Bash 初始化共享最多 30 秒启动预算；Bash 发出本次调用随机就绪标记后，开始计算用户命令超时，标记从 stderr 移除。Windows 上依赖系统 PowerShell、允许 Add-Type 和 Windows Job Object；失败返回实际失败信息。Git Bash 支持构造参数、`ELVION_BASH_PATH` 及标准安装路径。其它平台使用独立进程组。

这是受控执行，不是 OS 沙箱；经授权的 Shell 使用当前用户权限。路径在授权前后解析符号链接/junction，并在写入前重查，但无法阻止外部恶意进程在系统调用间竞争路径。多文件补丁具备预检和失败回滚，不是文件系统事务，进程崩溃期间仍应由 Session/Execution 标记副作用待核实。Todo 和 Git 文件所有权仅保存在当前 Runtime 内；恢复后不自动重放或取得旧文件的 Git 写入所有权。

补丁回滚无法恢复全部文件时，工具返回 `error.code=conflict`、`error.details.requiresReview=true`，同时保留 `rollbackFailures` 和 `changedFiles`。Agent 记录工具结果后立即停止当前批次和后续模型调用，交由 Execution 保存 `needs_review`，不允许把不确定副作用当作普通可修复错误继续执行。普通参数、匹配或未发生副作用的工具错误仍可反馈模型纠正。

`src/runtime.test.ts` 使用真实临时中文目录、Git 仓库、junction 和 Git Bash，覆盖正常/失败/审批/拒绝/取消/超时、UTF-8/CRLF、哈希冲突、用户改动保护、补丁失败无部分修改，以及启动后子进程取消不产生延迟写入。
