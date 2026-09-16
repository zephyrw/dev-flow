# pnpm 开发与构建指南

项目统一使用 **pnpm 11.7.0** 管理依赖和运行构建命令，Node.js 要求 **22.23.2 或更高版本**。根目录的 `package.json` 管理前后端全部依赖，`apps/`、`packages/` 是源码模块目录。

## 安装依赖

在项目根目录执行。Node.js 安装包含 Corepack 时，可以启用 pnpm 命令：

```powershell
corepack enable pnpm
pnpm --version
pnpm install --frozen-lockfile
```

本机已安装 pnpm 时直接执行后两条。`packageManager` 固定 pnpm 版本，`pnpm-lock.yaml` 固定依赖版本；安装器和工作流的 bootstrap 也使用冻结锁文件安装。工作流直接通过 Node.js 调用随 Node 安装的 Corepack pnpm 入口。

`pnpm-workspace.yaml` 保留精确版本保存规则，并允许 `esbuild`、`fsevents` 执行所需的安装脚本；其中 `fsevents` 仅在适用平台安装。`better-sqlite3 13.0.3` 已随包提供 N-API 预编译组件且声明 `gypfile: false`，因此仅对该精确版本关闭 pnpm 11.7 的隐式 node-gyp 编译，避免额外安装 C++ 工具链。升级 SQLite 驱动时需重新检查这项配置，并验证数据库读写。

## 常用命令

| 目的 | 命令 |
| --- | --- |
| 后端开发 | `pnpm dev` |
| 前端开发 | `pnpm dev:web` |
| 类型检查 | `pnpm typecheck` |
| 单元与集成测试 | `pnpm test` |
| 浏览器测试 | `pnpm test:e2e` |
| 前后端生产构建 | `pnpm build` |
| Windows Host 构建 | `pnpm build:host`（需要 .NET 10） |
| 类型检查、测试、生产构建 | `pnpm check` |
| 启动构建产物 | `pnpm start` |
| CLI 帮助 | `pnpm cli help` |

Windows 的“安装或更新 DevFlow.cmd”会同步 pnpm 依赖，编译前后端及 Host，然后更新本机 Skill 和 MCP 配置。日常运行测试或编译无需执行安装器。

## 添加与更新依赖

```powershell
pnpm add 包名
pnpm add -D 包名
pnpm update 包名
```

依赖变更时一并提交 `package.json` 和 `pnpm-lock.yaml`；构建许可变化还需提交 `pnpm-workspace.yaml`。不要再生成 `package-lock.json` 或运行 `npm install` / `npm ci`。

## 磁盘占用

项目不指定独立的 store 或 npm 缓存目录，使用 pnpm 的本机共享存储。用 `pnpm store path` 查看实际路径；同一磁盘上相同依赖可通过硬链接复用。不要复制整个 `node_modules` 到另一个工作区，在目标工作区执行冻结锁文件安装即可。

受限沙箱可能使 pnpm 回退到项目内的 store，普通终端应核对 `pnpm store path` 是否指向共享位置。旧 `.cache/npm` 和以前保留的依赖备份不会因更换包管理器自动消失；历史测试证据与 `.devflow` 业务状态应保留。

官方参考：[锁文件导入](https://pnpm.io/cli/import)、[共享存储](https://pnpm.io/settings/store)、[依赖构建许可](https://pnpm.io/settings/build)。
