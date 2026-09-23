# 文件变更白名单

## 1. 待删除文件 (W06)

### Go 源码
- `host/devflow-host/go.mod`
- `host/devflow-host/go.sum` (如果存在)
- `host/devflow-host/main.go`
- `host/devflow-host/host_test.go`
- `host/devflow-host/interactive_windows.go`
- `host/devflow-host/process_posix.go`
- `host/devflow-host/process_windows.go`
- `host/devflow-host/process_windows_test.go`

### Go Auth Host 源码
- `host/devflow-auth-host/go.mod`
- `host/devflow-auth-host/go.sum` (如果存在)
- `host/devflow-auth-host/main.go`
- `host/devflow-auth-host/main_test.go`
- `host/devflow-auth-host/auth_metadata.go`
- `host/devflow-auth-host/credential_windows.go`
- `host/devflow-auth-host/lock_windows.go`
- `host/devflow-auth-host/unsupported.go`
- `host/devflow-auth-host/vault_windows.go`
- `host/devflow-auth-host/vault_windows_test.go`

### C# 源码
- `host/DevFlow.WinHost/Program.cs`
- `host/DevFlow.WinHost/DevFlow.WinHost.csproj`
- `host/NuGet.Config`

### 构建脚本
- `scripts/build-host.mjs`
- `scripts/build-auth-host.mjs`

## 2. 待修改文件 (W02-W05)

### 进程管理模块
- `packages/process/src/manager.ts` - 移除 Host 依赖，改用 Node 启动器
- `packages/process/src/controller-lock.ts` - 改用 Node 直接持锁
- `packages/process/src/agy-account-job-runner.ts` - 统一走 ProcessManager
- `packages/process/src/agy-account-processes.ts` - 改为内部函数

### 账号模块
- `packages/agy-accounts/src/auth-host.ts` - 改用 Node 凭据子进程

### 运行时模块
- `packages/runtime/src/recovery.ts` - 改为内部函数查询进程状态
- `packages/runtime/src/runtime.ts` - 移除 Host 路径依赖

### 入口文件
- `apps/api/src/main.ts` - 移除 Host 路径传递
- `apps/api/src/accounts-main.ts` - 移除 Host 路径传递
- `apps/api/src/account-service-bootstrap.ts` - 移除 Host 参数

### 服务模块
- `packages/service/src/launcher.ts` - 改为检查 Node 入口

### 配置模块
- `packages/contracts/src/config.ts` - schema v2，移除 Host 字段
- `packages/contracts/src/agy-account.ts` - 移除 auth_host_executable

### CLI 模块
- `packages/cli/src/main.ts` - init 输出 v2，doctor 调用内部函数

### 安装器模块
- `packages/installer/src/main.ts` - 移除 Host 组件
- `packages/installer/src/upgrade.ts` - 移除 Host 升级
- `packages/installer/src/components.ts` - 移除 Host 组件
- `packages/installer/src/manifest.ts` - 移除 Host 清单

### 发布脚本
- `scripts/release/build-release.mjs` - 移除 dist/host 输入
- `scripts/setup.mjs` - 源码只需 pnpm 安装和构建
- `scripts/install-windows.ps1` - 移除 Host 安装
- `scripts/bootstrap/install.ps1` - 移除 Host 安装
- `scripts/bootstrap/install.sh` - 移除 Host 安装

### CI/CD
- `.github/workflows/ci.yml` - 移除 Go 测试
- `.github/workflows/release.yml` - 移除 Host 构建

### 锁文件
- `components.lock.json` - 移除 go、devflow-host
- `toolchains.lock.json` - 移除 host_toolchain、go_version
- `compatibility.json` - 更新平台和能力

### 文档
- `README.md` - 更新安装说明
- `docs/guide/安装与恢复.md` - 更新安装说明
- `docs/guide/使用指南.md` - 更新使用说明
- `docs/guide/使用与恢复指南.md` - 更新使用说明
- `docs/guide/pnpm开发与构建指南.md` - 更新构建说明

### 测试文件
- `tests/integration/process.test.ts` - 移除 C# 路径依赖
- `tests/unit/agy-account-processes.test.ts` - 更新 Host 调用
- `tests/unit/agy-auth-host-pipes.test.ts` - 更新 Auth Host 通信
- `tests/integration/recovery.test.ts` - 更新进程状态查询
- `tests/integration/check-repair.test.ts` - 移除 C# 路径
- `tests/integration/environments.test.ts` - 移除 C# 路径
- `tests/integration/precommit-runtime.test.ts` - 移除 C# 路径
- `tests/e2e/fixture-server.ts` - 移除 Host 前提
- `tests/live/` 相关入口 - 移除 C# 路径

### Skill 文件 (仅在仍规定旧构建流程时最小修订)
- `packages/skills/devflow/SKILL.md`
- `packages/skills/devflow-plan/SKILL.md`
- `packages/skills/devflow-execute/SKILL.md`
- `packages/skills/devflow-review/SKILL.md`
- `packages/skills/devflow-test/SKILL.md`
- `packages/skills/devflow-project-onboard/SKILL.md`

## 3. 待新增文件 (W01-W05)

### 原生接口模块
- `packages/process/src/native/windows.ts` - Win32 API 声明和调用
- `packages/process/src/native/posix.ts` - POSIX flock 接口

### 进程协议
- `packages/process/src/process-protocol.ts` - ProcessIdentity、StopObservation 类型

### 启动器
- `packages/process/src/runner-entry.ts` - 最小 Node 启动器

### 凭据模块
- `packages/agy-accounts/src/credential-worker.ts` - 凭据子进程
- `packages/agy-accounts/src/credential-windows.ts` - Windows 凭据 API
- `packages/agy-accounts/src/credential-store.ts` - 旧 envelope 兼容
- `packages/agy-accounts/src/auth-metadata.go` → `auth-metadata.ts` - 元数据提取

### 配置迁移
- `packages/contracts/src/config-migration.ts` - v1→v2 迁移
- `scripts/migrate-node-runtime.ts` - 迁移脚本

### 测试文件
- `tests/integration/node-native-primitives.test.ts`
- `tests/unit/process-protocol.test.ts`
- `tests/integration/node-process-lifecycle.test.ts`
- `tests/integration/node-controller-lock.test.ts`
- `tests/integration/node-interactive-process.test.ts`
- `tests/unit/credential-store-compat.test.ts`
- `tests/unit/auth-metadata.test.ts`
- `tests/integration/node-credential-worker.test.ts`
- `tests/integration/node-credential-os.test.ts`
- `tests/integration/node-runtime-migration.test.ts`
- `tests/integration/node-release-smoke.test.ts`

## 4. 不动文件

### 明确保留
- `packages/presentation/src/native-progress.ts` - 识别 `go test`/`dotnet test` 是为用户项目，不动
- 所有 `.devflow/` 目录内容
- 所有 `dist/` 目录内容 (旧版本回退材料)
- 所有工作树、会话、凭据目录
- 全局工具链或共享 pnpm store

### 已有未提交修改的文件 (合并而非覆盖)
根据 `git status`，以下文件已有未提交修改，实施时需合并:
- `packages/skills/devflow/SKILL.md`
- `packages/skills/devflow-plan/SKILL.md`
- `packages/skills/devflow-execute/SKILL.md`
- `packages/skills/devflow-review/SKILL.md`
- `packages/skills/devflow-test/SKILL.md`
- `packages/skills/devflow-project-onboard/SKILL.md`
- `packages/skills/devflow/references/role-and-schedule.md`
- `packages/skills/devflow-plan/references/plan-contract.md`
- `packages/skills/devflow-review/references/review-contract.md`
- `packages/skills/devflow-review/references/repair-document-contract.md`
