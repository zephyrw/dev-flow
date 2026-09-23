# DevFlow 技术栈精简 - 基线记录

日期：2026-09-22
状态：W00 基线保存

## 1. 源码版本

- 当前 HEAD: `4aa5a3977d9f2425a0c250baf9cd59b6d280ac92`
- 分支: `feat/mimo-lightweight-workflow`
- 工作树: `devflow-node-migration` (隔离实施环境)

## 2. 运行环境

- Node.js: `22.23.2`
- pnpm: `11.7.0`
- 平台: `win32` (Windows 11 Pro)

## 3. 当前 Go/.NET 依赖清单

### 3.1 Go 源码 (待删除)

| 路径 | 用途 | 构建产物 |
|------|------|----------|
| `host/devflow-host/` | 跨平台进程宿主、锁、状态命令、交互控制台 | `dist/host/devflow-host.exe` |
| `host/devflow-auth-host/` | Windows 凭据、DPAPI、域锁、加密备份 | `dist/host/devflow-auth-host.exe` |

### 3.2 C# 源码 (待删除)

| 路径 | 用途 | 构建产物 |
|------|------|----------|
| `host/DevFlow.WinHost/` | Windows Job Object、进程管理 | `dist/host/DevFlow.WinHost.exe` |

### 3.3 构建脚本 (待删除)

| 路径 | 用途 |
|------|------|
| `scripts/build-host.mjs` | 编译 Go Host |
| `scripts/build-auth-host.mjs` | 编译 Go Auth Host |

### 3.4 package.json 中的构建入口 (待移除)

```json
{
  "build:host": "node scripts/build-host.mjs",
  "build:auth-host": "node scripts/build-auth-host.mjs"
}
```

## 4. 配置字段清单

### 4.1 当前 config schema (v1)

```yaml
schema_version: 1
server:
  host: "127.0.0.1"
  port: 4810
  human_origin: "http://localhost:4810"
storage_root: ".devflow"
workspace_root: ".devflow/worktrees"
host:
  executable: ""        # 待删除 - 指向 Go/C# Host
  required: true        # 待删除
agy_accounts:
  auth_host_executable: "dist/host/devflow-auth-host.exe"  # 待删除
  # ... 其他字段保留
models:
  agy_executable: "agy"
  codex_executable: "codex"
  # ... 其他字段保留
scheduler:
  executors: 1
  reviewers: 1
  # ... 其他字段保留
```

### 4.2 待删除字段

- `host.executable` - 指向 Go/C# Host 可执行文件
- `host.required` - Host 是否必需
- `agy_accounts.auth_host_executable` - 指向 Go Auth Host

### 4.3 待新增字段

- `schema_version: 2` - 新版本配置
- 移除上述 Host 相关字段

## 5. 依赖组件锁

### 5.1 components.lock.json

```json
{
  "node": { "version": "22.23.2", "required": true },
  "pnpm": { "version": "11.7.0", "required": true },
  "go": { "version": "1.24", "required": true },           // 待删除
  "better-sqlite3": { "version": "13.0.3", "required": true },
  "devflow-host": { "version": "1.0.0", "binary": "devflow-host.exe", "required": true }  // 待删除
}
```

### 5.2 toolchains.lock.json

```json
{
  "host_toolchain": "go",        // 待删除
  "go_version": "1.24",          // 待删除
  "targets": ["windows/amd64", "windows/arm64", "darwin/amd64", "darwin/arm64", "linux/amd64", "linux/arm64"],
  "build_metadata": "dist/host/build.json"  // 待删除
}
```

## 6. 涉及 Host 调用的源码文件

### 6.1 进程管理模块

| 文件 | Host 用途 | 整改方案 |
|------|-----------|----------|
| `packages/process/src/manager.ts` | 启动 Host 运行受管进程 | 改用 Node 启动器 + Windows Job |
| `packages/process/src/controller-lock.ts` | 调用 Host 获取控制器锁 | 改用 Node 直接持锁 |
| `packages/process/src/agy-account-job-runner.ts` | 调用 Host 运行 AGY 任务 | 统一走 ProcessManager |
| `packages/process/src/agy-account-processes.ts` | 调用 Host doctor/job-status | 改为内部函数 |

### 6.2 账号模块

| 文件 | Host 用途 | 整改方案 |
|------|-----------|----------|
| `packages/agy-accounts/src/auth-host.ts` | 启动 Go Auth Host 守护进程 | 改用 Node 凭据子进程 |

### 6.3 运行时模块

| 文件 | Host 用途 | 整改方案 |
|------|-----------|----------|
| `packages/runtime/src/recovery.ts` | 调用 Host job-status 查询进程状态 | 改为内部函数 |
| `packages/runtime/src/runtime.ts` | 传递 Host 路径给 ProcessManager | 移除 Host 依赖 |

### 6.4 入口文件

| 文件 | Host 用途 | 整改方案 |
|------|-----------|----------|
| `apps/api/src/main.ts` | 传递 config.host.executable | 移除 Host 路径 |
| `apps/api/src/accounts-main.ts` | 传递 config.host.executable | 移除 Host 路径 |
| `apps/api/src/account-service-bootstrap.ts` | 创建 AgyAccountJobRunner 时传入 Host | 移除 Host 参数 |

### 6.5 服务模块

| 文件 | Host 用途 | 整改方案 |
|------|-----------|----------|
| `packages/service/src/launcher.ts` | 检查 Host 文件是否存在 | 改为检查 Node 入口 |

## 7. 新增依赖

### 7.1 koffi@3.3.1

- 用途: Node.js FFI，调用 Windows API
- 范围: 仅用于 `packages/process/src/native/windows.ts`
- 能力: Windows Job Objects、Mutex、进程身份查询、交互进程创建

## 8. 测试文件清单

### 8.1 现有测试 (需修改)

- `tests/integration/process.test.ts` - 移除 C# 路径依赖
- `tests/unit/agy-account-processes.test.ts` - 更新 Host 调用
- `tests/unit/agy-auth-host-pipes.test.ts` - 更新 Auth Host 通信
- `tests/integration/recovery.test.ts` - 更新进程状态查询

### 8.2 新增测试

- `tests/integration/node-native-primitives.test.ts` - Koffi 原生接口测试
- `tests/unit/process-protocol.test.ts` - 进程协议测试
- `tests/integration/node-process-lifecycle.test.ts` - 进程生命周期测试
- `tests/integration/node-controller-lock.test.ts` - 控制器锁测试
- `tests/integration/node-interactive-process.test.ts` - 交互进程测试
- `tests/unit/credential-store-compat.test.ts` - 凭据存储兼容测试
- `tests/unit/auth-metadata.test.ts` - 认证元数据测试
- `tests/integration/node-credential-worker.test.ts` - 凭据 Worker 测试
- `tests/integration/node-credential-os.test.ts` - OS 凭据测试
- `tests/integration/node-runtime-migration.test.ts` - 运行时迁移测试
- `tests/integration/node-release-smoke.test.ts` - 发布冒烟测试

## 9. 保留边界确认

以下内容不因本次整改而改变:

- [ ] React、Fastify、SQLite、pnpm 保留
- [ ] 模型路由、角色阶段、质量失败计数保留
- [ ] 账号选择算法、额度识别规则保留
- [ ] 同一任务/模型的会话绑定保留
- [ ] 调度并发数、超时、已配置模型保留
- [ ] 官方登录/刷新流程保留
- [ ] PowerShell/sh/cmd 系统安装入口保留

## 10. 下一步

W00 完成后，进入 W01: 验证唯一新增依赖及核心最小实现

- 安装 koffi@3.3.1
- 验证预编译包可用性
- 实现 `packages/process/src/native/windows.ts`
- 实现 `packages/process/src/runner-entry.ts`
- 运行 `tests/integration/node-native-primitives.test.ts`
