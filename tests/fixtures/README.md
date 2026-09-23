# 测试 Fixtures

本目录包含用于隔离测试的合成命令和假凭据。

## 合成 CLI

### synthetic-cli.js

模拟模型 CLI 行为，用于测试进程管理。

**使用方法:**

```bash
node tests/fixtures/synthetic-cli.js [选项]
```

**选项:**
- `--delay <ms>` - 模拟工作延迟 (默认 1000)
- `--exit <code>` - 退出码 (默认 0)
- `--marker <path>` - 创建标记文件 (用于测试 Job 归属前无副作用)
- `--stdin` - 读取 stdin 并回显
- `--verbose` - 输出详细信息

**示例:**

```bash
# 基本使用
node tests/fixtures/synthetic-cli.js

# 模拟长时间运行
node tests/fixtures/synthetic-cli.js --delay 5000

# 模拟失败
node tests/fixtures/synthetic-cli.js --exit 1

# 创建标记文件 (用于测试 Job 归属前无副作用)
node tests/fixtures/synthetic-cli.js --marker /tmp/test-marker.json

# 读取 stdin
echo "test input" | node tests/fixtures/synthetic-cli.js --stdin
```

### synthetic-login.js

模拟登录行为，不执行真实登录。

**使用方法:**

```bash
node tests/fixtures/synthetic-login.js [选项]
```

**选项:**
- `--delay <ms>` - 模拟登录延迟 (默认 2000)
- `--exit <code>` - 退出码 (默认 0)
- `--marker <path>` - 创建标记文件
- `--verbose` - 输出详细信息

**示例:**

```bash
# 基本使用
node tests/fixtures/synthetic-login.js

# 模拟登录失败
node tests/fixtures/synthetic-login.js --exit 1

# 创建标记文件
node tests/fixtures/synthetic-login.js --marker /tmp/login-marker.json
```

## 合成凭据

### synthetic-credential.js

生成假凭据用于测试，不包含真实凭据。

**使用方法:**

```bash
node tests/fixtures/synthetic-credential.js [选项]
```

**选项:**
- `--action <action>` - 动作: generate, validate
- `--output <path>` - 输出文件路径
- `--verbose` - 输出详细信息

**示例:**

```bash
# 生成合成凭据
node tests/fixtures/synthetic-credential.js --action generate --output /tmp/test-credential.json

# 验证凭据格式
node tests/fixtures/synthetic-credential.js --action validate --output /tmp/test-credential.json
```

## 测试配置

### devflow.test.yaml

隔离测试配置，使用:
- 非标准端口 (14810)
- 独立存储目录 (`.devflow-test`)
- 合成命令 (`echo` 代替真实 CLI)
- 禁用真实账号功能

**使用方法:**

```bash
DEVFLOW_CONFIG=tests/fixtures/devflow.test.yaml pnpm exec vitest run tests/integration/node-native-primitives.test.ts
```

## 测试隔离规则

1. **环境隔离**: 使用独立的 `storage_root` 和端口
2. **凭据隔离**: 使用合成 Credential target 和测试 Mutex
3. **进程隔离**: 使用合成 CLI 命令，不启动真实模型
4. **数据隔离**: 使用临时目录，测试后清理

## 验收标准

使用这些 fixtures 时，需满足以下验收标准:

- [ ] AC01: 依赖加载 - koffi@3.3.1 在 Node 22.23.2 上加载成功
- [ ] AC02: Job 归属前无副作用 - marker 文件未创建
- [ ] AC09: 控制器锁互斥 - 多个隔离控制器无法并占
- [ ] AC15: 旧格式兼容 - Node 可读旧 Go 合成金库包
