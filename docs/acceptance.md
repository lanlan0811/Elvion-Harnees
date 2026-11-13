# Elvion CLI v0.1.0 验收记录

记录日期：2026-11-12（Asia/Shanghai）。当前为开发验收，npm 尚未发布；远端 CI 证据见下表。

## 验收方式

分别记录已通过、失败、未验证。跳过、mock、静态快照与真实平台验收不得混为一项；缺陷保留复现及防复发测试，涵盖时间顺序、历史基线与假绿。

## 自动验收

| 项目 | 状态 | 证据与范围 |
|---|---|---|
| 三协议 Provider | 已通过 | tests/providers.test.ts 的19项本地 HTTP 契约测试，不连接远端服务 |
| Provider strict 类型与 lint | 已通过 | 三模块独立严格检查及测试文件 lint |
| 全工程 typecheck/lint/test/build | 已通过 | npm run check；12个测试文件120项，0失败0跳过，Node24.22.1、Windows10 19045 x64 |
| Windows PortableGit 与 Job Object | 已通过 | 官方固定归档SHA校验、Zig编译启动器；中文空格cwd、真实Git、超时、输出上限、取消孙进程与父进程强杀清理 |
| 会话恢复、锁与崩溃恢复 | 已通过 | 独占与过期锁并发、完整记录损坏、尾部半条日志、工具结果未知不重放、resume重置权限 |
| 打包安装 | 已通过 | npm run test:package：真实主包与Windows平台tarball经npm安装，ignore-scripts、隔离配置、中文/空格路径、版本/帮助/狐狸资源、实际执行内置Bash，移走平台包后必须报错且不回退；尚非公开registry安装 |
| 生产依赖审计 | 已通过 | npm audit --omit=dev --audit-level=high：0 vulnerabilities |
| 精确 main 的远端 CI | 已通过 | 代码提交 607e3fb88a1a52507822d0462c399923f7c4baaa；CI run 43203219276 全部六组成功：Windows x64、macOS Apple Silicon、macOS Intel × Node24/26；包含实际平台Bash、全量检查、真实安装冒烟和生产审计 |

## 人工与外部验收

| 项目 | 状态 | 验证要求 |
|---|---|---|
| 三套远端真实 API | 未验证 | 有权限密钥、流式文本、工具、切换、用量，不记录密钥 |
| Windows 10 + Windows Terminal + 微软拼音 | 未验证 | 候选 Enter 不发消息、候选框位置、粘贴、缩窗、焦点、终端恢复 |
| macOS Terminal/iTerm2 + 中文输入 | 未验证 | Intel/Apple Silicon、中文输入、进程组取消、恢复、安装 |
| 静态视觉 | 已通过 | 真实素材与响应断点测试；App渲染行数与宽度检查，artifacts/welcome-*.txt为构建输出；不等同真终端或IME验收 |
| PortableGit 全组件源码和许可材料 | 未准备 | 精确版本材料、build-extra提交、全组件来源清单 |
| npm 身份与三个包发布权限 | 未配置 | trusted publishing或NPM_TOKEN，首次发布权限需核实 |

## 缺陷复现与防复发

- Windows PowerShell 5.1 在英文 runner 将无 BOM 的 UTF-8 构建脚本误解码，导致原生启动器构建前解析失败。构建脚本改为 ASCII；tests/build-scripts.test.ts 同时验证字符集和真实 5.1 解析，不执行编译作为替代。
- 英文 Windows runner 的 tar 命令不能通过旧代码页解析中文 -C 参数。安装验收改为 Unicode cwd 与纯 ASCII tar 参数，仍保留真实中文和空格安装路径。
- 密钥包含引号或反斜线时，先序列化再替换会漏掉转义后的凭据。改为递归清理每个字符串；运行时测试直接检查持久日志中没有转义密钥。
- 待批准／问答回调同步取消曾可能留下等待 Promise；已验证取消不会执行写入，恢复不重跑已产生副作用的工具。
- 长工具详情的左右键现在独立横向滚动，中文字符按显示列裁切；待办及基础 Markdown 纳入界面回归。
- doctor 对 lock-claim 残留和损坏锁只读报错并给出路径，不按时间自动抢锁；诊断测试核实文件未被删除或改写。
- resume 同一配置 ID 但模型、地址或协议已修改时，校验持久化的精确配置指纹后清除不兼容的私有状态；旧日志无指纹时也保守清除，通用消息继续保留。
- 工具完成事件已 fsync 而下一份状态快照尚未写入时，恢复重放已确认的 tool-end 结果关闭事务；只有没有完成结果的调用才标为未知，任何情况均不自动重跑。
- 新消息预算仍使用估算及 usage 校准，必须持续显示估算标记；不能因为前一次收到真实 usage 就将后续预测标成实测。
- apply_patch 删除到 /dev/null 必须确实删除全部原文，残留内容则拒绝整个批次；回归检查未展示内容不丢失且前置合法修改也未落盘。
- Linux 仅承担发行归档与发布，不执行本项目不支持的 Linux Bash 集成测试；完整执行和安装验收由前置 Windows/macOS CI 及发行平台作业承担，发布作业仍要求其成功并重新核对 SHA。

## CI 与发布门禁

### 2026-11-13：移除 API Key 环境变量名配置

- 基线：main 的 9c3569b；改动前配置与 UI 的 36 项原有测试通过。
- 复现：先增加字段移除、必填密钥、旧配置及真实表单保存回归，改动前出现 8 项预期失败，确认测试能识别旧行为。
- 修复：删除表单字段、配置类型与环境变量优先读取；协议及输出参数切换按字段键定位，避免删字段后索引错位。
- 回归与时间维：旧配置的本地密钥继续有效，旧环境变量名被忽略且下次保存移除；仅含旧环境变量名时提示补填 API Key 并保留草稿，不自动把环境变量密钥写入文件。
- 严格核实：实际按键覆盖 Tab、Shift+Tab、Enter、左右键和密钥掩码，真实保存至隔离目录后重新读取，不 mock 配置持久化；原有运行时测试继续验证事件日志脱敏。
- 本地验证：Node 24.22.1 / Windows，npm run check 全通过，12 个测试文件共 129 项通过、无失败或跳过；实际内置 Bash 检查通过；生产依赖审计 0 vulnerabilities。
- 远端 CI 必须以此修改提交的准确 SHA 为准，沿用下方发布门禁，不以历史绿灯替代，也不触发 release。

ci.yml覆盖Windows x64、macOS Apple Silicon与Intel、Node24/26。Windows校验固定PortableGit、初始化并构建原生启动器；测试前先构建，再检查、安装冒烟和生产审计。

上述远端证据对应已核对的代码 SHA。后续提交仍必须等待自身 CI 成功；文档记录不能替代 release-gate 对当前 main SHA 的实时查询。工作流：https://github.com/lanlan0811/Elvion-Harnees/actions/runs/43203219276 。

release.yml只手动触发，要求main、准确版本、对应说明、完整源码HTTPS地址和SHA256。检查main当前SHA最近一次push CI成功，平台独立打包与检查后发布前再次检查。顺序为平台包、主包、GitHub Release。

GitHub官方文档列出windows-11-arm，不能用x64交叉编译成功替代ARM64实测；本仓库的runner权限和npm身份仍需真实运行验证。

## 完整源码归档契约

HTTPS tar.gz根部必须有sources-manifest.json：schemaVersion为1、portableGitVersion为2.56.1.windows.1、buildExtraCommit为40位精确上游SHA、complete为true。components数组为每个组件提供name、version、materials数组、licenses数组和buildInstructions路径。materials每项含path及文件sha256。

实际清单必须包含git、bash、msys2-runtime及所有其他捆绑组件、补丁和构建材料；不能只有三项核心组件。所有引用文件都必须在归档内。脚本校验版本、路径、必要组件、材料哈希及许可/构建文件；complete声明和整体完整性仍由发行者核实，脚本不构成法律意见或许可审计。

manifest还必须有binaryArchives.x64.sha256及binaryArchives.arm64.sha256，分别匹配两个平台provenance.json中的官方PortableGit归档摘要。SHA256SUMS以流式计算，避免大型源码归档占满内存。
