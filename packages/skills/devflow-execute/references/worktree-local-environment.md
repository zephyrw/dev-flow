# worktree 本地环境与端口隔离规范

> 本规范指导执行模型在独立 Git worktree 下进行开发、本地调试和测试时，如何管理独立端口与运行配置，确保多 worktree 互不串扰，且临时配置绝对不提交、不合并回主工作区。

---

## 1. 核心目标与不可偏离的原则

1. **端口全隔离**：
   - 每个独立 worktree 的前端服务、后端 API、测试服务器（如 Playwright E2E fixture server）及调试端口必须拥有独立的端口号。
   - 绝不与主工作区的默认端口（如前端 `5173`、后端 `4810`）冲突，也不与其他正在运行的兄弟 worktree 冲突。
2. **配置动态生成与同步更新**：
   - 端口改变时，前端 API 代理、WebSocket、HMR、测试 baseURL、后端允许的开发前端 Origin 必须同步指向当前实例。
3. **临时配置绝不进版本控制**：
   - 临时生成的端口清单、实例描述（`instance.json`）、临时运行时配置（`devflow.runtime.yaml`）、本地 SQLite 数据库等均必须处于 Git 忽略目录中。
   - 严禁修改已跟踪的文件（如 `vite.config.ts` 中的默认端口数值）来适应本地临时调试，更严禁将临时端口合并回主分支。

---

## 2. 临时文件布局与存储结构

```text
<worktree>/
  .cache/devflow-local/
    instance.json                 # 当前实例端口、路径与进程信息
    devflow.runtime.yaml          # 当前后端的临时运行时配置
    state/                        # 独立的 SQLite 数据存储
    reports/                      # 临时测试与核验报告
    browser/                      # 临时标签页信息与截图缓存

<git-common-dir>/devflow-local/
  ports.json                      # 同一 Git 仓库下所有 worktree 的全局端口登记表
  allocation.lock/                # 跨进程文件分配锁
```

- `<git-common-dir>` 通过 `git rev-parse --git-common-dir` 解析，兼容主工作区与 linked worktree。
- 所有上述目录均在 `.gitignore` 保护下，防止误提交。

---

## 3. 端口分配与冲突处理机制

1. **信息收集与排除**：
   - 读取主工作区的已知默认端口（前端 5173、后端 4810、测试 14811 等）。
   - 读取 `<git-common-dir>/devflow-local/ports.json` 中尚未释放的兄弟 worktree 端口。
   - 对系统当前监听状态进行探测（支持 IPv4 回环）。
2. **并发分配保护**：
   - 采用基于原子目录创建的锁机制（`allocation.lock`），避免多个子进程同时分配导致端口撞号。
3. **遇到占用的重试策略**：
   - 探测可用不保证 100% 占有。若实际启动服务时遇到 `EADDRINUSE`，**绝不强行杀死占用该端口的进程**。
   - 运行器应释放刚占用的登记，在候选端口池中重新选取新的可用端口，并同步更新配置重新尝试。
4. **启动健康校验**：
   - 服务启动后，通过请求 `/api/health` 检查实例标识与工作目录，确认连接的是当前 worktree 的后端服务。

---

## 4. 提交边界与合并检查清单

在准备提交代码前，执行模型必须执行严格自查：

- [ ] `git status --short` 与 `git diff` 检查：没有将 `instance.json`、`devflow.runtime.yaml` 或 `.cache/devflow-local` 误加入暂存区。
- [ ] 配置文件默认值检查：`apps/web/vite.config.ts` 默认端口仍为 `5173`，后端代理目标默认仍为 `4810`。
- [ ] 源码通用性检查：允许提交支持环境变量（如 `DEVFLOW_WEB_PORT`、`DEVFLOW_API_PORT`）的通用代码，但不允许提交具体 worktree 的硬编码数值。
- [ ] 进程清理检查：本 worktree 结束前，只停止由本 worktree 启动的子进程，并释放自己的端口登记，不影响正在运行的主工作区或其他 worktree。
