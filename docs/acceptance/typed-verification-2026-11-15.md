# 类型修复与验证超时验收

日期：2026-11-15（Asia/Shanghai）。基线为 `ec90c4ae8048aa9382ee8f9d7b9de7194aa603ef`。本轮对照正式计划补齐类型错误修复的客观证据，并修复验证超时与健康状态的实际调用方缺口。

## 可重复场景与观察

- `tests/e2e/cli.test.ts` 的 TypeScript 场景先独立运行实际 `tsc --noEmit`，观察 `TS2322` 和退出 2。构建后 CLI 经本地 HTTP 协议调用真实文件工具，修改两个 `.ts` 文件；第一次独立 `npm run typecheck` 为 2、原运行时检查为 1。模型收到该客观诊断后修复，再检查均为 0。外部编译器及运行时再次通过，原 package/tsconfig/检查脚本逐字保持，恢复不重放模型、工具或验证。
- 新超时回归在修复前真实失败：验证超时后仍运行后续 build 并请求模型修复。修复后先保存实际 `timed_out` 检查报告，终态 `execution.timed_out`，无修复/重试，后续检查哨兵不产生。真实 Shell 子进程已退出；SQLite 重开后恢复同一超时报告不再调用 Shell 或模型。
- 构建后 CLI 使用 `--verification-timeout 3000` 实际退出 124，并在 checkpoint 保留该限制；恢复保持原终态与报告。CLI/TUI 新执行允许 1–1800000 毫秒，默认 120000；恢复禁止覆盖保存值，供应商 HTTP `--timeout` 含义不变。
- TUI 应用层实际探针成功后再收到 HTTP 401，Runtime 变为错误；配置身份变化不沿用旧 Connected。真实 SQLite Worker 失败显示存储错误，后续成功读写可恢复。取消、拒绝和 Shell/验证超时不误报模型故障，未知 Usage 不当作连通成功。

## 已执行检查

- 核心超时新增回归先红 3 项，修复后绿 3 项；包含既有正常修复及安全报告恢复的相关定向回归 9 项通过。
- 界面/配置及真实 HTTP、存储场景的相关定向回归 7 项通过；CLI 类型检查和相关 ESLint 通过。
- 两项构建后 CLI E2E 实际通过，耗时 54.21 秒；测试服务是本地 HTTP 夹具，不是付费真实模型端点。
- 完整 `pnpm check` 实际 exit 0：22 个文件、296 pass、1 平台条件 skip；19:04:26 开始，144.40 秒。Lint、包及测试类型检查、Unit/Integration/E2E 和 Build 全通过。独立安装 `pnpm smoke:package` 随后实际 exit 0：生成 bin、完整资源、5 次编码/15 次真实工具、检查 1→0、外部测试 0、SQLite 事件一致及两次恢复无重放。代码提交 `dcf473c754618fd97cf573f8cfd1cd0baea1773c` 的精确 CI `43707523799` 已 completed/success，Windows 与 Ubuntu 的完整 Check 与安装验收均通过，见 [CI 证据](ci-typed-verification-2026-11-15.json)。

## 保留门槛

其余真实供应商按用户决定暂不配置，保留未验收。正式 Windows Terminal 截图、IME 与完整 PTY 矩阵由用户后续按 `docs/windows-terminal-acceptance.md` 执行。以上本地证据不替代这些门槛，未发布 Release 或 Tag。
