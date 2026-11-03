# AGY 执行阶段自动续接：适配层复核与隔离验证

日期：2026-11-04（Asia/Shanghai；执行环境 UTC 日期为 2026-11-03）。

复核基线：`70e884679f15aa589dbf3c7eb2e0c6baafccbcda`，包含自动续接提交 `9bb1f2fe11db49d01c55301487c28e817384d30f`。交付前再次查询远端，`main`、`dev` 均仍指向该基线。

范围为同一执行任务的 AGY 自动续接。本次没有进行跨账号切换、读取私人凭据或调用真实 AGY 模型。

## 结论

已有实现能够保存原会话、冻结调用配置、等待模型进程退出，并保护暂停、用户交互与后续人工验收。本次确认并修复三处结果处理缺口：AGY 结束事件校验不足、直接提交结果的归属检查晚于自动续接分支、矛盾完成声明中的具体用户请求被自动核对抢先处理。

新增 22 个隔离用例；相关四个核心测试目标最终共 64 项通过。其他受影响目标的通过和失败结果列在下表。**这不是“真实 AGY 自动续接已通过”的结论，也不是生产进程树或浏览器 E2E 已验证的结论。**

## 已有实现与本次修复

### 1. AGY 退出码为 0 不足以采纳完成声明

生产调用使用 `ProfileRuntime` 与 `AgyNativeCliAdapter`。原先运行时仅在 `agyResult.error` 为真值时处理 AGY 终止错误。因此，即使结束事件是 `ERROR`、`CANCELLED` 或缺少状态，只要错误文本缺失或为空且进程退出码为 0，内嵌的 `completed`／`incomplete` 就可能被返回给控制器。缺少 `result` 结束事件、但其他事件含有 `structured_output` 的截断流也可能被采纳。

[修复位置](../../packages/runtime/src/profile-runtime.ts)：等待 `proc.completion` 并消费最后的输出片段后，要求存在 AGY 结束事件并报告 `SUCCESS`；否则保留失败，阻止把该业务结果作为完成或自动续接依据。沿用已有的严格历史错误尾部识别例外，保留权限拒绝、手动停止和超时的处理优先级。

[回归测试](../../tests/integration/profile-agy-historical-footer.test.ts)新增 8 项：4 种无有效错误文本／状态的完成声明、错误终止中的 `incomplete`、缺少结束事件的完成声明，以及正常 `SUCCESS` 下的 `completed` 和 `incomplete`。6 个负向场景均先在修复前观察到错误接纳，修复后通过；原有历史尾部用例仍通过。

### 2. 自动续接前验证结果属于当前任务

通过 `extractRoundOutput` 的结果已有归属检查，但直接 worker 提交可能提前走自动续接或结束原因核对，绕过后续完成分支中的检查。

[修复位置](../../packages/core/src/engine.ts)：入队之前检查结果顶层与 `delivery` 的 `workflow_id`、`run_id`。允许模型回显同一任务、同一原生会话中的历史 Run ID；续接来源仍保存当前实际 Run。其他任务／运行的声明抛出 `ROUND_RESULT_IDENTITY_MISMATCH`，不创建续接或重试记录。

[回归测试](../../tests/integration/execution-auto-continuation.test.ts)新增 5 个外部归属负向场景和 1 个同会话历史 Run 正向场景。5 个负向场景均在修复前错误入队，修复后拒绝。

### 3. 明确的用户请求优先于矛盾完成声明的自动核对

原策略遇到 `completed` 与非空 `unfinished_items` 时先决定核对，尚未处理同一结果里的具体用户请求；控制器只把 `incomplete` 加用户请求提升为 `need_user`。

[策略](../../packages/core/src/execution-continuation-policy.ts)与[控制器](../../packages/core/src/engine.ts)现共同处理这种矛盾结果：存在未完成项且明确需要用户决定时，进入 `WAITING_INPUT`，保留 pending 交互，不自动作答或再启动核对。新增 1 个策略用例、2 个顶层／嵌套请求集成用例；两项集成用例在修复前均错误入队。

单独的 `completed` 不会因为携带历史交互字段就一律失效。已存在的“明确未完成项则核对”“连续三轮没有新增完成项则等待用户”“核对轮不消耗开发进展预算”“控制器重启后恢复续接”行为保持不变。

## 新增适配器与子进程链路测试的边界

[新集成测试](../../tests/integration/agy-execution-auto-continuation.test.ts)通过真实 `AgyNativeCliAdapter` 构造参数、`ProfileRuntime.invoke` 处理输出、`Engine.receiveRoundResult` 路由结果，并用 `child_process.spawn` 实际启动[本地模拟 AGY CLI](../../tests/fixtures/agy-auto-continuation-cli.mjs)。五项测试覆盖：

1. `incomplete` 后下一轮携带原 `--conversation`、原模型、冻结配置及续接提示，随后完成。
2. CLI 已输出结果但子进程尚未关闭时，不提前路由或创建续接；真实 `close` 后才继续。
3. 已输出 `incomplete`、尚未退出时用户暂停，控制器停止该测试子进程，迟到结果被撤销且不复活任务。
4. 续接轮返回具体用户问题时，保留待答交互并停止续接。
5. 续接轮报告原生权限拒绝时，进入等待且不自动授权、不采纳完成结果。

本测试替换账号身份解析和原生历史读取，不需要账号。进程 host 使用测试端口，完成 Promise 由真实子进程 `close` 事件驱动；生命周期记录由该测试端口写入。下一轮 Run 通过生产 `readRunContinuation`、`resolveRoutingPreview` 读取续接和冻结配置后，在夹具中组装。**它不是完整调度器 E2E，也不验证生产 `ProcessManager` 的 OS 身份解析、进程树清理或真实 AGY 协议兼容性。**

## 实际执行结果

工具链：Node `v24.22.1`、仓库锁定 pnpm `11.7.0`（使用 `corepack pnpm`）；`install --frozen-lockfile` 成功。最终源码的生产构建成功，随后修正一处新测试夹具的循环类型推断并完成全项目类型检查；该测试类型修改不影响已经通过的生产构建。

| 实际执行目标 | 结果 |
| --- | --- |
| `corepack pnpm typecheck` | 通过，包含测试类型检查 |
| `corepack pnpm build` | 通过；构建标识 `workspace-0688104ec58eaf01312f`；保留已有 Vite 提示 |
| `tests/integration/agy-execution-auto-continuation.test.ts` | 5 通过 |
| `tests/integration/execution-auto-continuation.test.ts` | 26 通过 |
| `tests/integration/profile-agy-historical-footer.test.ts` | 22 通过 |
| `tests/unit/execution-continuation-policy.test.ts` | 11 通过 |
| `tests/unit/execution-continuation-session.test.ts` | 11 通过 |
| `tests/unit/agy-current-turn-finish.test.ts` | 31 通过 |
| `tests/unit/agy-permission-calls.test.ts` | 11 通过 |
| `tests/unit/round-output.test.ts` | 30 通过 |
| `tests/integration/native-permission-authorization.test.ts` | 44 通过、4 失败；失败均为 `RUNNER_IDENTITY_UNKNOWN` |
| `tests/integration/round-result-routing.test.ts` | 16 通过、1 失败；失败为 `RUNNER_IDENTITY_UNKNOWN` |
| `tests/integration/process.test.ts`（原始基线执行，相关进程实现未修改） | 5 通过、3 失败；失败均为 `RUNNER_IDENTITY_UNKNOWN` |

Vitest 每条命令只选择一个上述测试文件，没有把无筛选全量套件作为检查入口。最终十个受影响目标合计 212 项：207 通过、5 失败；另列原始进程基线的 8 项结果，不把部分通过概括为全绿。

另建独立 worktree，在未修改的 `70e8846` 上编译其自己的产物并仅选择上述 5 个失败用例复核。首轮为 4 失败、1 通过；其中 `historical-footer` 首次通过，单例复跑又出现同一 `RUNNER_IDENTITY_UNKNOWN`。因此五个失败用例都已在原始基线上复现，但结果存在波动，不能表述成“一次基线运行 5/5 失败”。基线命令使用 `corepack pnpm --config.verify-deps-before-run=false` 复用锁文件一致的已装依赖，未修改生产身份检查；临时 worktree 随后移除。

### 当前环境的限制

- **生产进程身份检查：** `/proc/self/stat` 和 boot ID 可读，但实际 `spawn` 返回的子进程 PID 在当前挂载的 `/proc/<pid>/stat` 中不存在。生产 `ProcessManager` 因无法确认身份而拒绝执行。没有关闭或放宽该保护。以上三个文件的失败均停在这一层，不能据此宣称其业务路径通过。
- **浏览器 E2E：** 没有可用 Chromium；实际尝试 `corepack pnpm exec playwright install chromium` 后，下载得到无效／截断 ZIP，报 `End of central directory record signature not found`。因此 `tests/e2e/execution-auto-continuation.spec.ts` 本次未执行，不标记通过；该文件仍是 Codex 模拟路径。
- **真实 AGY：** 环境没有 `agy` 可执行文件，未调用真实 Antigravity/Gemini，也未执行 `tests/live/agy-auto-continuation.ts`。原生会话回放、真实 CLI 版本差异及生产进程树退出仍需在具备 AGY 的正常主机验证。

## 可复现命令

仓库根目录执行；下面是本次核心验证入口：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm build
corepack pnpm exec vitest run tests/integration/agy-execution-auto-continuation.test.ts
corepack pnpm exec vitest run tests/integration/execution-auto-continuation.test.ts
corepack pnpm exec vitest run tests/integration/profile-agy-historical-footer.test.ts
corepack pnpm exec vitest run tests/unit/execution-continuation-policy.test.ts
```

其他目标使用相同的 `corepack pnpm exec vitest run <单个测试文件>` 命令。当前容器中，上表中依赖生产进程身份检查的目标仍有失败，不能预期全部通过。

在有 Chromium 和正常进程身份映射的主机，可以再执行浏览器目标：

```sh
corepack pnpm exec playwright test tests/e2e/execution-auto-continuation.spec.ts
```

仓库已有真实 AGY 验证脚本，其模型目前硬编码为 `gemini-3.8-flash-high`。确认本机已安装 AGY、该模型可用且允许使用本机已登录账号后，才适合自行执行下列命令；它会真实调用模型、消耗额度，**本次没有执行**：

```sh
corepack pnpm exec tsx tests/live/agy-auto-continuation.ts
```

## 错误完成声明的剩余边界

本次封堵的是可从协议和声明中识别的矛盾：失败／缺失结束事件却声称完成、明确列出未完成项、明确向用户求助以及错误任务归属。若模型返回协议有效的 `SUCCESS`，业务结果为 `completed`，同时完全不披露遗漏项，平台无法仅凭该声明证明所有原计划工作已经完成。

自动续接继续遵循仓库的轻量调度职责，不新增代码扫描或平台证据审计关卡。执行测试、既有质量复核与人工验收仍是发现此类语义遗漏的途径；上述隔离测试不能证明模型不会漏报。
