# W01 实施进度

日期：2026-09-22
状态：done

## 1. 新增依赖

| 依赖 | 版本 | 状态 |
|------|------|------|
| koffi | 3.3.1 | 已安装并验证加载 ✓ |

## 2. 新增文件

| 文件 | 行数 | 状态 |
|------|------|------|
| packages/process/src/native/windows.ts | ~220 | ✓ Win32 Job/Mutex/进程身份 |
| packages/process/src/native/posix.ts | ~230 | ✓ flock/进程组管理 |
| packages/process/src/native/index.ts | ~72 | ✓ 平台路由 |
| packages/process/src/runner-entry.ts | ~300 | ✓ IPC 协议启动器 |
| packages/process/src/process-protocol.ts | ~100 | ✓ 类型与工具函数 |
| tests/unit/process-protocol.test.ts | ~150 | ✓ 17 测试 |
| tests/integration/node-native-primitives.test.ts | ~634 | ✓ 8+1 测试 |

## 3. 修改文件

| 文件 | 变更 |
|------|------|
| package.json | 添加 koffi@3.3.1 |
| pnpm-lock.yaml | 更新 |
| pnpm-workspace.yaml | allowBuilds 添加 koffi: true |
| components.lock.json | 添加 koffi，标记 go/devflow-host deprecated |
| THIRD_PARTY_NOTICES | 添加 Koffi 条目 |

## 4. 验收结果

### AC01: koffi 加载
- [x] koffi@3.3.1 安装成功
- [x] koffi.load("kernel32.dll") 成功
- [x] Win32 API 声明正确 (CreateJobObjectW, CreateMutexW, OpenProcess 等)

### AC02: 无预分配副作用
- [x] 模块加载不创建任何句柄
- [x] 不修改全局状态
- [x] 仅在显式调用时分配资源

### AC09: 互斥原语
- [x] Mutex 创建/等待/释放
- [x] Job Object 创建/分配/终止/查询
- [x] 进程身份查询 (创建时间)
- [x] POSIX flock (跳过 Windows)

### 集成测试
- [x] runner-entry IPC: ready → start → started → exited
- [x] stop via IPC terminates tool
- [x] IPC disconnect kills tool
- [x] Windows Job Object 终止
- [x] Windows Mutex 互斥
- [x] Windows 进程身份查询
- [x] koffi 基本功能

### 单元测试
- [x] process-protocol: 17/17 通过

## 5. 资源预算初步结果

- koffi 加载时间: <100ms
- 单个 Job/Mutex 创建: <1ms
- 无额外后台进程
- 无忙轮询

## 6. 下一步

W01 完成，可以推进到 W02 (统一普通进程和控制器锁)。
