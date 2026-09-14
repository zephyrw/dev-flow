# DevFlow 重启后继续执行故障恢复记录

日期：2026-09-14。工作流：`wf-203cb2b8-aff1-4da5-9a22-495dcacafe4a`，标题“排查修复任务提交与阶段更新失败”。

结论：本次继续失败的直接原因是宿主安装目录的依赖不完整。已按原锁文件恢复依赖、重启原服务，并通过正常恢复入口续接原任务。北京时间 18:55:36，执行器已成功读取原任务上下文，状态为 `EXECUTING`。

## 故障证据

- 失败轮次：`run-70cffacf-de52-4043-a2ca-f393ba2ebd71`。18:33:40 的执行日志报告：Hook 加载 `D:\Code\system-handle\dist\packages\mcp\src\tools.js` 时找不到 `@modelcontextprotocol/server`，抛出 `ERR_MODULE_NOT_FOUND`。
- 18:33:41，工作流记录 `EXECUTION_INCOMPLETE`。这是工具调用前的模块加载故障，不能据此认定任务结果已提交或测试通过。
- 本次排查直接执行模块导入，同样复现 `Cannot find package '@modelcontextprotocol/server'`。
- 排查期间另有窗口反复运行 `npm ci` / `npm install`，用户已确认。安装交叠时出现 `ENOTEMPTY` 与大量 `TAR_ENTRY_ERROR ENOENT`；有一次 npm 返回 0 后，生产导入仍因缺少传递依赖 `@hono/node-server` 而失败。不能仅按安装退出码判断恢复成功。
- 现有证据没有证明电脑重启本身删除了依赖；可确认的是继续执行时依赖已不完整，以及本次修复期间存在并发安装。

## 恢复操作

1. 通过 `devflow_start` 的继续入口明确绑定原工作流，核对原批准计划与隔离工作区，没有另建工作流。
2. 确认所有业务工作流均未执行后，核验控制器 PID、启动时间、可执行文件及入口路径，停止对应控制器。备份 SQLite 文件及 WAL/SHM；原数据库没有被手工改写。
3. 保留旧依赖目录。在 `.cache/reboot-dependencies-20260914` 中复制原 `package.json` / `package-lock.json`，使用 Node 随附 npm 10.9.8 执行 `ci --ignore-scripts=false --prefer-offline --no-audit --no-fund`。安装 457 个包，不升级依赖。
4. 实际加载暂存目录中的 MCP server/client/node、YAML 及 SQLite，并打开、关闭内存数据库，均成功。
5. 确认没有并发安装进程、锁文件哈希未变化；持有维护锁，将完整依赖目录整体切换到宿主目录。加载原生产模块并通过原启动器恢复 4810 服务。
6. 完成下面的验证后，调用原任务的正常恢复入口。该入口执行旧进程对账、原审批校验、旧证据失效及新轮次排队。没有新审批、人工验收或提交操作。

备份位于 `.cache/reboot-repair-backup-20260914`；两份残缺依赖保留在 `.cache/node_modules-before-reboot-repair-20260914` 和 `.cache/node_modules-conflicted-20260914`，便于必要时追溯。

## 验证结果

| 检查 | 结果 |
|---|---|
| 生产 MCP 工具与 API 模块加载 | 通过 |
| `GET /api/health` | `ok=true`，原 DevFlow 实例 |
| `npm ls --depth=0 --json` | 退出码 0，无依赖问题 |
| 原有 Windows Hook 集成测试 | 1 通过、0 失败；验证中文 JSON、合法工具允许、其他工具/服务拒绝、凭证撤销后拒绝 |
| `package.json` / `package-lock.json` | 与 Git 基线一致，未改变依赖合同 |
| 恢复前后计划、审批、工作区、会话 | 与停服备份逐条比对，全部一致 |
| 恢复前后任务声明与任务证明 | 各 4 条，全部一致 |
| 正常恢复入口 | 18:55:13 从 `BLOCKED` 经 `QUEUED` 进入 `EXECUTING` |
| 实际执行器上下文读取 | 18:55:36，事件 1523 的 `devflow_execute_context` 成功返回原工作流上下文 |

新轮次：`run-38ce261c-5e65-4ced-9207-cf0feab2b50b`，仍为原计划第 1 版。上述恢复验证使用普通程序接收事件，在首次上下文读取成功后结束观察，没有持续轮询执行器。

本报告证明本次模块缺失故障已解除、原任务已成功续接。原计划的 17 项测试在恢复前仍为 0 通过，不能把本次独立 Hook 回归记作原计划已通过；后续实施、测试、人工验收、独立复核仍由原 DevFlow 流程完成。本次未修改产品源码，未提交、合并或发布工作流中的待验收代码。

原始验证证据：

- [依赖树](evidence/reboot-resume-20260914/reboot-dependency-tree.json)
- [Hook 原始测试报告](evidence/reboot-resume-20260914/reboot-repair-hook-test.json)
- [数据保持与健康检查](evidence/reboot-resume-20260914/reboot-repair-verification.json)
- [实际恢复与首次工具成功](evidence/reboot-resume-20260914/reboot-repair-resume.json)

后续维护同一宿主目录时应串行安装依赖，避免在任务执行期间从其他窗口覆盖 `node_modules`。工作流业务代码的依赖安装应使用其自己的隔离工作区。
