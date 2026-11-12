# Elvion CLI v0.1.0 验收记录

记录日期：2026-11-12（Asia/Shanghai）。当前为开发验收，不表示 npm 已发布或远端 CI 已通过。

## 验收方式

分别记录已通过、失败、未验证。跳过、mock、静态快照与真实平台验收不得混为一项；缺陷保留复现及防复发测试，涵盖时间顺序、历史基线与假绿。

## 自动验收

| 项目 | 状态 | 证据与范围 |
|---|---|---|
| 三协议 Provider | 已通过 | tests/providers.test.ts 的19项本地 HTTP 契约测试，不连接远端服务 |
| Provider strict 类型与 lint | 已通过 | 三模块独立严格检查及测试文件 lint |
| 全工程 typecheck/lint/test/build | 已通过 | npm run check；10个测试文件95项，0失败0跳过，Node24.22.1、Windows10 19045 x64 |
| Windows PortableGit 与 Job Object | 已通过 | 官方固定归档SHA校验、Zig编译启动器；中文空格cwd、真实Git、超时、输出上限、取消孙进程与父进程强杀清理 |
| 会话恢复、锁与崩溃恢复 | 已通过 | 独占与过期锁并发、完整记录损坏、尾部半条日志、工具结果未知不重放、resume重置权限 |
| 打包安装 | 已通过 | npm run test:package：真实主包tarball、ignore-scripts、中文/空格安装路径、命令帮助、狐狸资源、平台Bash；平台目录复制模拟依赖，不能代替公开registry验收 |
| 生产依赖审计 | 已通过 | npm audit --omit=dev --audit-level=high：0 vulnerabilities |
| 精确 main 的远端 CI | 未验证 | 推送后核对工作流 SHA，本地测试不能代替 |

## 人工与外部验收

| 项目 | 状态 | 验证要求 |
|---|---|---|
| 三套远端真实 API | 未验证 | 有权限密钥、流式文本、工具、切换、用量，不记录密钥 |
| Windows 10 + Windows Terminal + 微软拼音 | 未验证 | 候选 Enter 不发消息、候选框位置、粘贴、缩窗、焦点、终端恢复 |
| macOS Terminal/iTerm2 + 中文输入 | 未验证 | Intel/Apple Silicon、中文输入、进程组取消、恢复、安装 |
| 静态视觉 | 已通过 | 真实素材与响应断点测试；App渲染行数与宽度检查，artifacts/welcome-*.txt为构建输出；不等同真终端或IME验收 |
| PortableGit 全组件源码和许可材料 | 未准备 | 精确版本材料、build-extra提交、全组件来源清单 |
| npm 身份与三个包发布权限 | 未配置 | trusted publishing或NPM_TOKEN，首次发布权限需核实 |

## CI 与发布门禁

ci.yml覆盖Windows x64、macOS Apple Silicon与Intel、Node24/26。Windows校验固定PortableGit、初始化并构建原生启动器；测试前先构建，再检查、安装冒烟和生产审计。

release.yml只手动触发，要求main、准确版本、对应说明、完整源码HTTPS地址和SHA256。检查main当前SHA最近一次push CI成功，平台独立打包与检查后发布前再次检查。顺序为平台包、主包、GitHub Release。

GitHub官方文档列出windows-11-arm，不能用x64交叉编译成功替代ARM64实测；本仓库的runner权限和npm身份仍需真实运行验证。

## 完整源码归档契约

HTTPS tar.gz根部必须有sources-manifest.json：schemaVersion为1、portableGitVersion为2.56.1.windows.1、buildExtraCommit为40位精确上游SHA、complete为true。components数组为每个组件提供name、version、materials数组、licenses数组和buildInstructions路径。materials每项含path及文件sha256。

实际清单必须包含git、bash、msys2-runtime及所有其他捆绑组件、补丁和构建材料；不能只有三项核心组件。所有引用文件都必须在归档内。脚本校验版本、路径、必要组件、材料哈希及许可/构建文件；complete声明和整体完整性仍由发行者核实，脚本不构成法律意见或许可审计。

manifest还必须有binaryArchives.x64.sha256及binaryArchives.arm64.sha256，分别匹配两个平台provenance.json中的官方PortableGit归档摘要。SHA256SUMS以流式计算，避免大型源码归档占满内存。
