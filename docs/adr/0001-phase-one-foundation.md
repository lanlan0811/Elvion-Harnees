# ADR 0001：Phase 1 工程与运行边界

- 状态：采纳（来源：用户批准的 CLI/TUI 与 Phase 1 计划）
- 日期：2026-11-15

## 背景

初始仓库仅含品牌资源，Phase 1 需要独立单 Agent 引擎与 Windows 优先的字符界面。原计划位于本地 `.codex/plans/Elvion CLI-TUI 与 Phase 1 引擎开发计划.md`，不更改其忽略规则。

## 决策

- Node.js 24、ESM、pnpm Workspaces、严格 TypeScript；Zod 校验边界，Vitest 验证。
- Kernel 仅提供版本化事件、错误、预算、取消及共享契约。各 Runtime 独立包，通过契约组合。
- React + Ink 原生字符 TUI 只呈现事件及用户操作；所有模型工具和验证命令经过 Tool Runtime。
- 四个独立模型协议使用标准 HTTP 流；配置仅保存凭据环境变量名。
- SQLite 放在 worker 中，Repository 封装事件与快照；未确认副作用恢复后先核实，禁止自动重放。
- 默认 auto-edit，ask 每次审批，full-access 使用当前用户权限。受控执行不等于操作系统沙箱。
- 内部 Workspace 模块打入 CLI 产物；第三方作为普通依赖；品牌原文随包分发。
- 仅 main 开发，不创建 Worktree、分支、Tag 或正式 Release。

## 备选与影响

不采用 Qwen Runtime、Turborepo 或原生 SQLite 扩展：保持独立实现并减小 Windows 安装成本。Node 自带 SQLite 只在存储 worker 内引用，未来替换不影响应用层。流式协议独立实现增加协议测试责任。所有权限判断在统一工具入口完成，调用者负责操作系统权限和受信任工作区选择。

## 回滚

新增工程与包可逐提交回滚；不得重置用户文件或 Git 历史。持久化带 schemaVersion，不兼容数据必须明确拒绝，不能静默删除或覆盖。
