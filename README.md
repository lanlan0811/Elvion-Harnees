# ELVION CLI

Your Partner in Action.

ELVION 是一个 TypeScript 编写的本地单 Agent CLI，支持流式对话、文件操作、Bash 命令、多 Provider 切换及持久会话。

## 运行环境

- Node.js 24 LTS 或 26 及以上。
- Windows 10 2004 / 19041 及以上与 Windows Terminal；macOS 13.5 及以上。
- Windows 发行包包含固定版本 PortableGit 和进程启动器；macOS 仅调用 `/bin/bash`。

## 开发

```bash
npm ci --ignore-scripts
npm run prepare:platform # Windows，需要发布构建工具；macOS 不运行
npm run check
npm start
```

`npm run prepare:platform` 只用于开发／发布构建机，不在用户安装时运行。Windows 上须安装 MSVC Build Tools（或用 `scripts/build-launcher-zig.mjs` 提供经校验的 Zig）构建启动器。

## 使用

```bash
elvion
elvion config
elvion sessions
elvion resume <session-id>
elvion doctor
```

首次使用通过 `/provider` 配置协议、URL、密钥来源、模型、上下文容量与最大输出；支持 OpenAI Responses、Chat Completions 及 Anthropic Messages。容量支持 `1m`、`512k`、`384k`，每个模型独立填写。不要把示例容量当作所有供应商的额度。环境变量密钥优先于本地密钥。配置保存在 `~/.elvion/config.json`；本地明文密钥请妥善管理，推荐环境变量。可用 `ELVION_HOME` 指定独立数据目录。

会话内命令：`/provider`、`/model`、`/permissions`、`/compact`、`/help`、`/exit`。模型在当前轮结束后切换；新进程及恢复会话默认“每次询问”，不恢复提权。75% 输入占用提示手动压缩，95% 自动压缩；实际输出按剩余容量缩减。未知模型计数为估算。

`Enter` 发送，`Ctrl+J` 换行，`PageUp/PageDown` 浏览历史，`Ctrl+End` 回到底部，`F2` 查看工具详情。运行中可编辑草稿但不会自动排队；`Ctrl+C` 取消当前轮，空闲时退出。

## 权限与恢复

“每次询问”允许工作区读取、写入和命令需批准；“自动编辑”允许工作区文件修改、命令仍需批准；“完全访问”自动执行本地工具。完全访问不是系统沙箱，Bash 可以调用开发程序，不提供对恶意代码的隔离保证。

一个前台进程对应一个会话，退出终止执行；resume 加载持久记录并重新取得独占锁。中断时未完成命令显示“结果未知”，不会自动重跑。记录包含代码和命令输出，不包含运行时识别的 API 密钥；用户自行输入的其他敏感内容仍需自行管理。跨会话无记忆。

## 验收与发布

参见 `docs/acceptance.md` 和 `release/release-0.1.0.md`。CI 测试、模拟接口测试、真实平台交互和真实 API 验证分别记录，不能互相替代。发布 workflow 要求 main 的 CI 成功、匹配提交和版本、完整第三方源码材料。

本项目代码采用 MIT；PortableGit、Bash、MSYS2 和 npm 依赖保留各自许可证，见 THIRD_PARTY.md。
