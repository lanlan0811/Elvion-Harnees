# Elvion CLI v0.1.0

## 功能

- TypeScript 单 Agent CLI，中文界面、狐狸点阵欢迎页、固定输入与历史浏览。
- OpenAI Responses、Chat Completions、Anthropic Messages 三协议，自定义供应商及轮次结束后切换。
- 十项基础工具及用户提问；Windows 固定 PortableGit，macOS 固定 Bash。
- 每次询问、自动编辑、完全访问三权限，启动及恢复默认每次询问。
- 单前台进程会话、追加记录、独占锁和恢复；中断命令不自动重跑。
- 上下文 75% 提醒、95% 自动压缩，每个模型独立配置容量与输出上限。

## 安装

发布完成后运行 npm install -g elvion-harnees@0.1.0，通过 elvion 启动。需要 Node 24 LTS 或受支持的 Node 26；Windows 完整 TUI 以 Windows Terminal 验收。

## 验收状态

这是拟发布说明，不代表已发布。发布前必须确认精确 main 提交 CI 全绿并更新 docs/acceptance.md。契约服务器和快照不能替代远端真实 API、Windows 10 中文 IME、macOS 中文 IME 人工验收。

## 第三方运行包与源码

Windows 捆绑 PortableGit 2.56.1.windows.1 及开源 Job Object 启动器。Git、Bash、MSYS2 等保留各自许可证，不因主项目 MIT 而重新许可。

正式 Release 必须包含两个平台 tarball、CLI tarball、完整对应源码归档、sources-manifest.json、来源记录与 SHA256SUMS。缺少材料或校验失败会阻止发布。对应源码由发行者依上游流程准备，不能仅用 Git 源码替代整套 PortableGit 源码；清单哈希核验不等同完整许可证审计。

## 发布前配置

仓库配置 npm-release 环境，以及三个包的 trusted publishing，或有发布权限的 NPM_TOKEN。本次工程开发不预置凭据、不自动触发发布。
