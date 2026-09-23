# W00 完成总结

日期：2026-09-22
状态：完成

## 1. 基线保存

### 1.1 源码版本
- 当前 HEAD: `4aa5a3977d9f2425a0c250baf9cd59b6d280ac92`
- 分支: `feat/mimo-lightweight-workflow`
- 工作树: `devflow-node-migration` (隔离实施环境)

### 1.2 运行环境
- Node.js: `22.23.2`
- pnpm: `11.7.0`
- 平台: `win32` (Windows 11 Pro)

## 2. 文件白名单

### 2.1 待删除文件 (W06)
- Go 源码: `host/devflow-host/` (8 个文件)
- Go Auth Host 源码: `host/devflow-auth-host/` (10 个文件)
- C# 源码: `host/DevFlow.WinHost/` (3 个文件)
- 构建脚本: `scripts/build-host.mjs`, `scripts/build-auth-host.mjs`

### 2.2 待修改文件 (W02-W05)
- 进程管理模块: 4 个文件
- 账号模块: 1 个文件
- 运行时模块: 2 个文件
- 入口文件: 3 个文件
- 服务模块: 1 个文件
- 配置模块: 2 个文件
- CLI 模块: 1 个文件
- 安装器模块: 4 个文件
- 发布脚本: 6 个文件
- CI/CD: 2 个文件
- 锁文件: 3 个文件
- 文档: 5 个文件
- 测试文件: 8 个文件
- Skill 文件: 6 个文件 (仅在仍规定旧构建流程时最小修订)

### 2.3 待新增文件 (W01-W05)
- 原生接口模块: 2 个文件
- 进程协议: 1 个文件
- 启动器: 1 个文件
- 凭据模块: 4 个文件
- 配置迁移: 2 个文件
- 测试文件: 11 个文件

## 3. 配置字段审计

### 3.1 待删除字段
- `host.executable` - 指向 Go/C# Host
- `host.required` - Host 是否必需
- `agy_accounts.auth_host_executable` - 指向 Go Auth Host

### 3.2 待修改字段
- `schema_version`: 1 → 2

### 3.3 保留字段
所有其他字段原样保留，包括字段顺序、注释和默认值。

## 4. 合成测试环境

### 4.1 测试配置
- `tests/fixtures/devflow.test.yaml` - 隔离测试配置
- 使用非标准端口 (14810)
- 独立存储目录 (`.devflow-test`)
- 合成命令 (`echo` 代替真实 CLI)
- 禁用真实账号功能

### 4.2 合成命令
- `tests/fixtures/synthetic-cli.js` - 模拟模型 CLI
- `tests/fixtures/synthetic-login.js` - 模拟登录
- `tests/fixtures/synthetic-credential.js` - 生成假凭据

### 4.3 测试隔离规则
1. 环境隔离: 使用独立的 `storage_root` 和端口
2. 凭据隔离: 使用合成 Credential target 和测试 Mutex
3. 进程隔离: 使用合成 CLI 命令，不启动真实模型
4. 数据隔离: 使用临时目录，测试后清理

## 5. 验收标准

### 5.1 W00 出口检查
- [x] 白名单清晰 - 已创建 `file-whitelist.md`
- [x] 隔离环境可启动 - 已创建合成测试配置和命令
- [x] 已保存旧运行版本的合法回退来源 - 已记录基线信息

### 5.2 后续工作包验收标准
- AC01: 依赖加载 (W01)
- AC02: Job 归属前无副作用 (W01/W02)
- AC09: 控制器锁互斥 (W01/W02)
- AC15: 旧格式兼容 (W04)
- AC23: v1→v2 仅删除 Host 字段 (W05)

## 6. 下一步

进入 W01: 验证唯一新增依赖及核心最小实现

### W01 任务
1. 安装 koffi@3.3.1
2. 验证预编译包可用性
3. 实现 `packages/process/src/native/windows.ts`
4. 实现 `packages/process/src/runner-entry.ts`
5. 运行 `tests/integration/node-native-primitives.test.ts`

### W01 验收标准
- AC01: koffi@3.3.1 在 Node 22.23.2 上加载成功
- AC02: Job 归属前无副作用
- AC04: 控制器突然退出仍清理 Windows Job
- AC09: 控制器锁互斥

## 7. 证据文件清单

- `baseline.md` - 基线记录
- `file-whitelist.md` - 文件变更白名单
- `config-field-audit.md` - 配置字段审计
- `synthetic-test-config.md` - 合成测试配置
- `W00-summary.md` - 本文件

## 8. 测试 Fixtures

- `tests/fixtures/synthetic-cli.js` - 合成 CLI
- `tests/fixtures/synthetic-login.js` - 合成登录
- `tests/fixtures/synthetic-credential.js` - 合成凭据
- `tests/fixtures/devflow.test.yaml` - 测试配置
- `tests/fixtures/README.md` - 使用说明
