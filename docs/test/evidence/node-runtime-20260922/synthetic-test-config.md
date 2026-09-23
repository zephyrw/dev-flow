# 合成测试配置

## 1. 测试目标

建立仅使用合成命令/假凭据的测试入口，用于验证 Node 原生接口能力，不访问真实用户凭据或启动真实登录。

## 2. 合成测试配置文件

### 2.1 devflow.test.yaml

```yaml
schema_version: 2
server:
  host: "127.0.0.1"
  port: 14810  # 使用非标准端口避免冲突
  human_origin: "http://localhost:14810"
storage_root: ".devflow-test"
workspace_root: ".devflow-test/worktrees"
agy_accounts:
  enabled: false  # 测试时不启用真实账号
  realm_id: "test-realm"
  revision: 1
  standalone_model_id: null
  workflow_auto_switch: false
  pause_managed_for_manual_switch: false
  switch_gap_seconds: 3
  reset_clock_skew_seconds: 60
  probe_timeout_seconds: 5
  switch_timeout_seconds: 10
  max_candidates_per_operation: 5
  local_snapshot_stale_hours: 1
  maintenance:
    timezone: "UTC"
    local_report_time: "12:00"
    night_start: "00:00"
    night_end: "23:59"
    refresh_verified_max_age_hours: 1
    auto_network_check: false
  updated_at: "2026-09-22T00:00:00Z"
models:
  executor: "test-model"
  reviewer: "test-model"
  effort: "high"
  agy_executable: "echo"  # 使用 echo 代替真实 AGY
  codex_executable: "echo"
  codex_prefix_args: []
scheduler:
  executors: 1
  reviewers: 1
  heavy_tests: 1
  live_environments: 1
  aging_minutes: 1
ports:
  frontend: [15173, 15272]
  backend: [18081, 18180]
  bind_retries: 2
opentabs:
  endpoint: "http://127.0.0.1:19515/mcp"
  secret_file: ""
  allowed_test_origins: []
timeouts:
  agent_minutes: 1
  idle_minutes: 1
  stop_seconds: 2
  heartbeat_seconds: 1
retention:
  logs_days: 1
  failed_logs_days: 1
  evidence_days: 1
```

## 3. 合成命令

### 3.1 模拟模型 CLI

创建 `tests/fixtures/synthetic-cli.js`:

```javascript
#!/usr/bin/env node
// 合成 CLI - 模拟模型行为，用于测试进程管理
const args = process.argv.slice(2);
const stdin = process.stdin.read();

console.log(JSON.stringify({
  type: "init",
  conversation_id: "test-conv-" + Date.now(),
  timestamp: new Date().toISOString(),
}));

// 模拟工作
setTimeout(() => {
  console.log(JSON.stringify({
    type: "result",
    exit: 0,
    message: "Synthetic task completed",
    timestamp: new Date().toISOString(),
  }));
  process.exit(0);
}, 1000);
```

### 3.2 模拟登录命令

创建 `tests/fixtures/synthetic-login.js`:

```javascript
#!/usr/bin/env node
// 合成登录 - 模拟登录行为，不执行真实登录
console.log("Synthetic login started");
console.log("Waiting for user input...");

// 模拟等待用户输入
setTimeout(() => {
  console.log("Login completed (synthetic)");
  process.exit(0);
}, 2000);
```

## 4. 合成凭据测试

### 4.1 测试 Credential Target

- Target 名称: `DevFlow-Test-Synthetic`
- 不包含真实凭据
- 用于验证 DPAPI 加密/解密往返

### 4.2 测试 Mutex

- Mutex 名称: `Local\DevFlowTest_SyntheticMutex`
- 用于验证域锁互斥

### 4.3 测试金库

- 路径: `%LOCALAPPDATA%\DevFlow\test-accounts\synthetic\`
- 包含合成的 JSON 数据
- 用于验证旧格式兼容性

## 5. 测试隔离规则

### 5.1 环境隔离
- 使用独立的 `storage_root` (`.devflow-test`)
- 使用非标准端口 (14810)
- 不读取用户配置文件

### 5.2 凭据隔离
- 使用合成 Credential target
- 使用测试 Mutex
- 使用临时金库目录

### 5.3 进程隔离
- 使用合成 CLI 命令
- 不启动真实模型
- 不执行真实登录

## 6. 测试入口

### 6.1 单元测试
```bash
pnpm exec vitest run tests/unit/process-protocol.test.ts
```

### 6.2 集成测试
```bash
pnpm exec vitest run tests/integration/node-native-primitives.test.ts --maxWorkers=1
pnpm exec vitest run tests/integration/node-process-lifecycle.test.ts --maxWorkers=1
pnpm exec vitest run tests/integration/node-controller-lock.test.ts --maxWorkers=1
```

### 6.3 凭据测试
```bash
pnpm exec vitest run tests/integration/node-credential-worker.test.ts --maxWorkers=1
pnpm exec vitest run tests/integration/node-credential-os.test.ts --maxWorkers=1
```

## 7. 验收标准

### AC01: 依赖加载
- [ ] koffi@3.3.1 在 Node 22.23.2 上加载成功
- [ ] 预编译包可用，无需 Go/.NET/C++ 编译

### AC02: Job 归属前无副作用
- [ ] 注入延迟/Assign 失败/IPC 超时
- [ ] 观察合成 marker 文件未创建

### AC09: 控制器锁互斥
- [ ] 多个隔离控制器无法并占
- [ ] 旧锁名兼容正确
