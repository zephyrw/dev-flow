# 配置字段审计

## 1. 当前配置字段 (schema v1)

### server
- `server.host` - 保留
- `server.port` - 保留
- `server.human_origin` - 保留

### storage
- `storage_root` - 保留
- `workspace_root` - 保留

### host (待删除整个 section)
- `host.executable` - 删除 - 指向 Go/C# Host
- `host.required` - 删除 - Host 是否必需

### agy_accounts
- `agy_accounts.realm_id` - 保留 (在 AgyAccountSettingsSchema 中定义)
- `agy_accounts.revision` - 保留
- `agy_accounts.standalone_model_id` - 保留
- `agy_accounts.workflow_auto_switch` - 保留
- `agy_accounts.pause_managed_for_manual_switch` - 保留
- `agy_accounts.auth_host_executable` - 删除 - 指向 Go Auth Host
- `agy_accounts.switch_gap_seconds` - 保留
- `agy_accounts.reset_clock_skew_seconds` - 保留
- `agy_accounts.probe_timeout_seconds` - 保留
- `agy_accounts.switch_timeout_seconds` - 保留
- `agy_accounts.max_candidates_per_operation` - 保留
- `agy_accounts.local_snapshot_stale_hours` - 保留
- `agy_accounts.maintenance.timezone` - 保留
- `agy_accounts.maintenance.local_report_time` - 保留
- `agy_accounts.maintenance.night_start` - 保留
- `agy_accounts.maintenance.night_end` - 保留
- `agy_accounts.maintenance.refresh_verified_max_age_hours` - 保留
- `agy_accounts.maintenance.auto_network_check` - 保留
- `agy_accounts.updated_at` - 保留
- `agy_accounts.enabled` - 保留

### models
- `models.executor` - 保留
- `models.reviewer` - 保留
- `models.effort` - 保留
- `models.agy_executable` - 保留
- `models.codex_executable` - 保留
- `models.codex_prefix_args` - 保留

### scheduler
- `scheduler.executors` - 保留
- `scheduler.reviewers` - 保留
- `scheduler.heavy_tests` - 保留
- `scheduler.live_environments` - 保留
- `scheduler.aging_minutes` - 保留

### ports
- `ports.frontend` - 保留
- `ports.backend` - 保留
- `ports.bind_retries` - 保留

### opentabs
- `opentabs.endpoint` - 保留
- `opentabs.secret_file` - 保留
- `opentabs.allowed_test_origins` - 保留

### timeouts
- `timeouts.agent_minutes` - 保留
- `timeouts.idle_minutes` - 保留
- `timeouts.stop_seconds` - 保留
- `timeouts.heartbeat_seconds` - 保留

### retention
- `retention.logs_days` - 保留
- `retention.failed_logs_days` - 保留
- `retention.evidence_days` - 保留

### 其他
- `retain_services_on_stop` - 保留
- `schema_version` - 保留，值从 1 改为 2

## 2. 新配置 (schema v2)

```yaml
schema_version: 2
# host section 完全移除
# agy_accounts.auth_host_executable 移除
# 其他字段保持不变
```

## 3. 迁移规则

### 3.1 自动迁移字段
- `schema_version`: 1 → 2
- `host.executable`: 移除
- `host.required`: 移除
- `agy_accounts.auth_host_executable`: 移除

### 3.2 保留字段
所有其他字段原样保留，包括:
- 字段顺序
- 注释 (YAML 注释)
- 默认值

### 3.3 旧路径识别

以下路径可自动识别为旧 Host:
- `dist/host/devflow-host.exe` (内置 C# 路径)
- `dist/host/devflow-auth-host.exe` (内置 Go 路径)
- 安装清单中的旧版本路径

### 3.4 自定义 Host 处理

如果 `host.executable` 或 `agy_accounts.auth_host_executable` 指向非内置路径:
- 进入 `LEGACY_CUSTOM_HOST_UNSUPPORTED` 状态
- 迁移 dry-run 列出该非敏感字段
- 执行者需核对其用途后按 Node 功能合同替换
- 不为它保留第二种运行后端

## 4. 验收检查

### AC23: v1→v2 仅删除 Host 字段
- [ ] 自定义配置迁移正确
- [ ] 默认路径迁移正确
- [ ] 并发修改场景处理正确

### AC24: 旧服务活动时拒绝迁移
- [ ] 占用锁时拒绝
- [ ] 活动 Job 时拒绝
- [ ] 未知 Host 时拒绝
- [ ] 身份缺失时拒绝
