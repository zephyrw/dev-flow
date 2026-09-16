# DevFlow 跨平台通用工作流平台实施方案

版本：1.4　编制日期：2026-09-14　目标版本：DevFlow 1.0.0

发布仓库：<https://github.com/zephyrw/dev-flow>。本方案中的新增命令、接口、目录和发布资产均为实施合同，完成对应工作包并发布后生效；当前 0.2.0 源码尚不具备这些完整能力。

## 1. 结论与确定的产品范围

可行。采用“本地工作流服务 + 声明式流程模板 + 客户端安装适配器 + Agent 执行适配器 + 工具网关 + 跨平台进程宿主”的统一架构。保留现有 TypeScript、React、Fastify、SQLite、任务隔离和证据机制，将 Windows、Codex、agy、模型名称及 OpenTabs 从核心逻辑中移出。

这里的通用有五个明确含义：

1. 平台服务运行于 Windows、macOS、Linux，安装不依赖开发者当前机器。
2. 发起客户端、规划工具、实施工具、测试工具、复核工具、模型和辅助工具分别配置。八种指定 CLI 均交付入口集成和完整执行适配；Kimi Code 发起、Claude Code 使用其已配置模型实施属于正式验收场景。
3. 只安装八种工具中的任意一种，就能由该工具完成方案、实施、测试和新会话复核；不强制安装第二个 AI 工具。单工具与多工具组合共用同一引擎。
4. 流程节点、顺序、条件、审批点、角色绑定和工具集合通过模板配置；无需修改平台核心代码。新增未知 Agent 的协议差异由独立适配器处理。

5. 每个任务独立冻结工具与模型组合；支持执行中同步设计、进度和测试文档并改向，支持不进入主流程的临时问答。完整协议见第 16 节，同属本次 1.0 完整交付。

支持边界固定如下：

| 项目 | 1.0.0 交付要求 |
|---|---|
| 操作系统 | Windows 11 24H2 及以上；macOS 14 及以上；Ubuntu 24.04 LTS |
| CPU | 上述系统分别提供 x64、arm64 原生产物，共六种目标 |
| 必须交付的八种 Agent | Codex CLI、Antigravity CLI（agy）、Grok Build、Claude Code、当前 TypeScript 版 Kimi Code、Qoder CLI、OpenCode、Cursor Agent CLI |
| 旧流程兼容 | 八工具中的 Antigravity CLI（agy）同时承接现有流程与旧任务迁移，不新增第九个适配器 |
| 单工具完整流程 | 八种工具分别独立完成 planner、implementer、tester、reviewer 四角色；只安装所选一种 AI 工具 |
| 发起入口 | 八种 CLI 的 MCP + Skill；共享官方本地配置的 Codex 桌面客户端；DevFlow 本地网页 |
| 浏览器 | 默认 Playwright 管理的 Chromium；可配置 OpenTabs 连接已登录浏览器 |
| 外部工具 | MCP stdio、MCP Streamable HTTP；受控命令；独立 Agent 适配器 |
| 部署形态 | 当前系统用户运行的本地服务，监听回环地址，无 DevFlow 账号、注册和配对步骤 |
| 开源 | 平台自有源码、Skill、适配器、安装器、构建流程、测试和示例全部采用 Apache-2.0 |
| 分发 | GitHub Releases 提供安装脚本、平台压缩包、源代码、校验和、SBOM 与依赖源码材料 |

不把“通用”解释为任何只有 GUI、没有开放调用能力的软件都能自动接入。未提供程序接口的工具不能宣称支持后台实施；新增工具必须实现第 5 节适配器合同。Windows 32 位、旧 macOS、Alpine/musl、浏览器云端直接控制个人电脑以及多用户 SaaS 不列入 1.0.0 支持矩阵。

工具身份固定：`agy` 是 Antigravity CLI 的唯一适配器 ID、组件 ID 和命令入口，正式承担规划、实施、测试及复核；`grok-build` 指官方 Grok Build 的 `grok` 程序，不是把 Grok 模型接进另一工具；`cursor-agent` 指 Cursor 的 `agent` CLI，不能用编辑器 `cursor` 启动命令或 Bugbot 代替；`qoder` 指 Qoder CLI，兼容旧命令名必须先通过产品指纹检查。

平台自身提供六种原生产物。八工具全能力的必需交付目标固定为 Windows x64、macOS x64、macOS arm64、Linux x64。Windows arm64、Linux arm64 的第三方 CLI 按官方原生产物及认证矩阵开放；没有官方支持的格子显示 `UNSUPPORTED_UPSTREAM`，安装器拒绝该绑定，不能标为“通过”或偷偷换工具。目前已确认 Qoder 不支持 Windows arm64，这个格子固定排除，不列作实施悬项，也不阻止其他已认证工具在该系统使用。[Qoder 安装要求](https://docs.qoder.com/cli/installation)

### 一键安装的准确含义

一个命令启动安装向导，自动完成平台、运行时、所选组件、MCP 配置和 Skill 的安装与检查。用户只选择工具组合并完成第三方账号授权。已有有效登录自动复用；新的 OAuth 授权、订阅购买、API Key 提供不能由源码代办。

OpenTabs 官方安装要求用户在 Chrome 中加载扩展，因此不能将它定义为无人值守安装必需品。默认浏览器使用 Playwright；选择 OpenTabs 后，安装器自动配置服务并打开扩展设置页，扩展连接前明确显示 `NEEDS_USER_ACTION`。这是固定处理流程，不作为实现时的分支决策。[OpenTabs 安装说明](https://opentabs.dev/docs/install)、[Playwright 浏览器安装](https://playwright.dev/docs/browsers)

## 2. 当前源码核查结果

基于当前工作区实际内容审阅。Git HEAD 为 `2316d7d`，`package.json` 为 `0.2.0`，工作区存在用户正在进行的未提交修改；实施基线必须包含经过确认的这些修改，不能直接将 HEAD 当作完整最新代码。

| 当前位置 | 已核实的绑定 | 必须实施的改动 |
|---|---|---|
| `packages/contracts/src/config.ts:19` | `executor`、`reviewer`、`effort` 使用固定 `z.literal` | 替换为 Profile、角色绑定、能力和版本校验 |
| `packages/core/src/engine.ts:862` | `review ? "codex" : "agy"` 决定适配器 | 从冻结的流程节点和 Profile 获取适配器 |
| `packages/runtime/src/runtime.ts` | 执行直接写 agy 项目、hooks 和参数；复核直接拼 Codex 参数 | 调度统一 AgentAdapter，具体 CLI 细节全部移入适配器 |
| `packages/contracts/src/index.ts:258` | `Run.adapter` 只有 `agy`、`codex` | 改为注册的适配器 ID，记录适配器版本与 Profile 快照 |
| `packages/process/src/controller-lock.ts` | 启动明确要求 `win32` 和 Windows Host | 替换为六平台统一宿主及操作系统锁 |
| `host/DevFlow.WinHost` | `net10.0-windows`，Win32 Job Object 和 Mutex | 将已有 Windows 行为移植到 Go 宿主，增加 POSIX 驱动 |
| `packages/process/src/manager.ts` | 环境变量白名单偏 Windows；非 Windows 只停止直接子进程 | 分平台环境与进程组管理；结束整个受管进程组后才释放租约 |
| `packages/runtime/src/recovery.ts` | 直接调用 Windows `job-status` | 通过宿主按操作系统进程身份对账 |
| `packages/service/src/launcher.ts`、`descriptor.ts` | PowerShell 打开浏览器、获取启动时间；按源码目录找安装 | 稳定安装目录、平台打开动作、宿主身份和状态描述 |
| `packages/runtime/src/browser.ts` | BrowserGateway 直接连接 OpenTabs | BrowserProvider 注册表及统一浏览器动作合同 |
| `packages/plans/src/validate.ts`、contracts | 测试层含厂商品牌 `opentabs` | 改为 `browser`，工具选择放进执行绑定 |
| `scripts/setup.mjs` | 只往 Codex 目录复制六个 Skill，并使用正则修改 TOML | 增加 devflow-test，统一 Skill 编译、八客户端事务化配置安装，包含 Antigravity 原有安装迁移 |
| `packages/skills/devflow/SKILL.md` | 固定 Windows、指定模型及 Codex 重启说明 | 平台中立正文，客户端差异由生成器处理 |
| `packages/adapters/cursor/src/index.ts` | 只有禁用的占位类，模型仍固定 | 将占位实现替换为正式 `cursor-agent` 适配器，补齐 headless、权限、MCP、模型、Skill 与安装认证 |
| `package.json` | `private: true`，无发布包、安装分发和 license 字段 | 增加开源元信息、发布资产及构建流水线 |
| 仓库分发材料 | 未见根 LICENSE、README、GitHub Actions；本机无 Git remote | 补齐开源交付文件和 `zephyrw/dev-flow` 发布配置 |

本机还存在带个人路径的安装配置及历史真实测试截图、日志、项目材料。即使运行配置已被 `.gitignore` 排除，历史测试材料也不能直接公开。开源发布按第 12 节生成经过检查的完整源码快照。

本次核查只证明上述源码事实和官方接口依据，没有把旧测试数量当作新版验收结果。1.1 修订追加了本机 CLI 只读探针，1.2 修订统一了 Antigravity 工具身份，详见 `docs/test/DevFlow八工具适配方案本机核查.md`；版本、帮助参数、模型调用、MCP 往返、Skill 触发和完整闭环是不同证据等级。正式工具范围按用户要求使用 Antigravity CLI（agy）；Claude Code 在核查期间安装完成，2.1.270 的版本及帮助探针通过。Antigravity 属于正式八工具范围。

## 3. 已确定的技术架构

```mermaid
flowchart TB
  Entry[八种 CLI / 本地网页] --> Bridge[客户端入口 MCP 与通用 Skill]
  Bridge --> Core[工作流引擎与模板编译器]
  UI[本地控制台] --> Core
  Core --> Store[SQLite / 事件 / 快照 / 证据]
  Core --> Agents[AgentAdapter 注册表]
  Core --> Gateway[工具与浏览器网关]
  Agents --> Codex[Codex CLI]
  Agents --> Claude[Claude Code]
  Agents --> Kimi[Kimi Code]
  Agents --> Agy[Antigravity CLI]
  Agents --> Grok[Grok Build]
  Agents --> Qoder[Qoder CLI]
  Agents --> OpenCode[OpenCode]
  Agents --> Cursor[Cursor Agent CLI]
  Gateway --> Browser[Playwright / OpenTabs]
  Gateway --> Tools[MCP 服务 / 已批准命令]
  Agents --> Host[Go 进程宿主]
  Gateway --> Host
  Host --> Windows[Windows Job Object]
  Host --> Posix[macOS 与 Linux 进程组]
```

### 3.1 技术栈

| 层 | 确定实现 |
|---|---|
| 核心、安装器、MCP、适配器 | TypeScript，Node.js 22.23.2 私有运行时 |
| Web/API | 保留 React、Vite、Fastify、WebSocket |
| 持久化 | 保留 `better-sqlite3@13.0.3`、WAL、事务、outbox |
| 配置校验 | Zod；YAML/JSON 是同一内部结构的序列化形式 |
| 原生宿主 | Go 1.26 构建工具链，Windows 与 POSIX 分平台源码 |
| 浏览器 | 将当前锁文件中的 Playwright 1.63.0 提升为正式运行依赖并固定版本 |
| 构建 | Node 锁文件 + Go `go.mod/go.sum` + 六平台发布清单 |
| 安装入口 | Windows PowerShell 5.1 脚本；macOS/Linux POSIX shell 脚本 |

选择 Go 仅用于小型进程宿主：可交付独立二进制，用户不需要安装 Go 或 .NET；平台业务逻辑继续使用 TypeScript。移植当前 Windows 的 Job Object 行为，并先通过与现有 Host 相同的生命周期测试，才替换旧 Host。Go 1.26 的具体补丁版本在第一个工作包由官方发行索引解析、写入锁文件，后续构建只读该锁文件；这是安装器构建步骤，不留给实现者选择技术路线。[Go 1.26 发布说明](https://go.dev/doc/go1.26)

Node 22.23.2 的六种目标二进制已有官方下载产物。SQLite 原生扩展在 CI 上按此 Node ABI 和目标架构构建后随平台包分发，终端用户不运行 `node-gyp`，不需要 Python、Visual Studio 或 Xcode。[Node 22.23.2 下载档案](https://nodejs.org/en/download/archive/v22.23.2)

### 3.2 仓库结构

```text
apps/
  api/                         现有服务
  web/                         控制台、安装向导、Profile 与模板编辑
packages/
  contracts/                   v2 配置、模板、节点、事件合同
  core/                        调度、审批、证据与提交规则
  workflow/                    模板解析、DAG 校验和节点运行
  profiles/                    工具、模型、角色绑定与版本
  adapters/
    sdk/                       适配器接口、测试合同
    codex/ agy/ grok-build/ claude-code/
    kimi-code/ qoder/ opencode/ cursor-agent/
  clients/                     八客户端发现、配置合并与 Skill 安装
  skills/                      七个中立 Skill 的唯一源码
  skill-compiler/              各客户端产物生成、校验、版本清单
  tools/                       MCP 和命令执行网关
  browsers/                    Playwright 与 OpenTabs Provider
  platform/                    路径、可执行文件解析、环境变量
  installer/                   安装计划、组件锁、更新和回滚
  cli/ service/ process/       命令行、自动启动、宿主客户端
  store/ evidence/ git/ workspace/ scheduler/
host/devflow-host/             Go 宿主；windows、darwin、linux 驱动
registry/components/           官方组件安装描述，按工具和平台区分
templates/                     内置工作流模板与配置 schema
scripts/bootstrap/             install.ps1、install.sh
scripts/release/               构建、分发、源码导出、SBOM
.github/workflows/             CI、兼容性测试、发布
docs/guide/ docs/design/ docs/plan/ docs/test/
```

这些目录是同一仓库内部模块。1.0.0 不拆分为多个独立发布的 npm 库，也不要求 npm 包名可用；公开仓库和 GitHub Releases 就能完成全部分发。

## 4. 角色、模型与配置规则

### 4.1 分开表达客户端、Agent 工具和模型

- **Client**：用户输入需求的软件，例如 Kimi Code。负责入口 MCP 和 Skill，不拥有平台调度逻辑。
- **Agent Tool**：实际被服务启动的软件，例如 Claude Code。
- **Model**：传给该工具的模型 ID 或其原生配置选择。
- **Profile**：固定工具、模型选择、鉴权引用、参数和工具权限的一组具名配置。
- **Role Binding**：流程中 planner、implementer、tester、reviewer 角色引用哪个 Profile。
- **Toolset**：某节点可以使用哪些浏览器能力、MCP 服务、只读工具和已批准命令。

入口客户端不隐式成为执行器。网页发起时，服务按 planner 绑定启动规划 Agent；CLI 发起时，入口 Agent 先提交任务和上下文，由绑定的 planner 完成正式方案；入口和 planner 的 Profile 一致时，入口提交的方案可直接完成该节点，否则入口输出只作为材料，必须由绑定的 planner 提交正式结果。后续节点由服务独立调度。关闭发起客户端不取消已启动的工作流。


### 4.2 默认规则与单工具模式

安装向导默认使用 `single-tool`。已发现可用 CLI 时，由用户选定其中一个；未发现时默认安装 Kimi Code。选定的工具成为唯一 AI 组件依赖，四个角色初始指向同一个原生模型 Profile；未被选择的另外七个 CLI 不下载、不检查账号，也不参与完成条件。

`execution.mode` 只有 `single-tool`、`composed` 两个运行配置值，共用同一套调度与证据逻辑。`single-tool` 下，所有启用的 AI 节点绑定必须具有相同 `adapter_id`，包括模板增加的自定义角色；模型可以相同，也可以是同一 CLI 下的不同已验证模型。保存跨工具绑定时必须在同一事务中显式切到 `composed`，禁止后台静默改变模式。`composed` 允许逐角色选择八种工具中的任何已认证 Profile。

四角色的职责固定：

| 角色 | 必须产出的内容 | 权限 |
|---|---|---|
| planner | 需求边界、唯一实施方案、修改范围、测试配方、验收断言 | 读取项目，提交计划 |
| implementer | 代码及必要测试修改、进度、变更说明 | 在批准范围内经 FileBroker 修改文件 |
| tester | 检查及补齐测试，调用测试命令，读取真实报告，定位失败，提交测试结论 | 读取代码；只修改批准的测试文件；通过受管命令工具执行测试 |
| reviewer | 人工验收后读取冻结快照与原始报告，提交复核意见 | 只读，无审批、实施或测试修改权限 |

“单工具”指一个 AI 软件承担全部 AI 工作，不要求只有一个进程或永远复用同一会话。规划、实施、测试和复核分别记录 NodeRun；测试与复核使用新会话，服务直接给出批准计划、代码快照和证据引用。测试命令由该 AI 工具通过 MCP 发起，DevFlow 启动 npm、pytest、Maven 等普通测试程序并保存报告；这些普通程序不构成第二个 AI 工具。服务没有预置 Codex/GPT-6/agy 的兜底调用。

同工具同模型的新会话复核提供阶段和权限隔离，不能宣传为模型之间的独立交叉验证。默认模板保留人工验收后复核；用户通过模板配置取消复核时，结果清楚显示“未配置复核”，方案、实施和测试仍构成完整最小流程。

旧安装迁移使用 `composed`，保留现有 Codex 规划、agy 实施、Codex 复核及精确模型值，tester 初始绑定原实施 Profile。历史已冻结任务继续使用原兼容模板；新任务采用含测试角色的模板。迁移不替换用户的模型或浏览器。

### 4.3 唯一配置结构

下面是安装向导可以生成的完整核心示例：入口及规划 Kimi、实施和测试 Claude Code 继承其已配置模型、复核 Kimi。字段中的选择是产品运行配置，不是实施路线的备选项。

```yaml
schema_version: 2
execution:
  mode: composed
server:
  host: 127.0.0.1
  preferred_port: 4810
clients:
  kimi-code:
    enabled: true
profiles:
  kimi-native:
    adapter: kimi-code
    executable: {source: discovered, command: kimi}
    model: {source: native-config}
    auth: {source: native}
    options: {}
    toolset: managed-development
  claude-native:
    adapter: claude-code
    executable: {source: discovered, command: claude}
    model: {source: native-config}
    auth: {source: native}
    options: {}
    toolset: managed-development
bindings:
  planner: kimi-native
  implementer: claude-native
  tester: claude-native
  reviewer: kimi-native
browser:
  provider: playwright
  channel: chromium
  headed: true
workflow:
  template: checked-development
  revision: 2
toolsets:
  managed-development:
    broker: true
    native_agent_tools: false
    mcp_servers: []
    commands: approved-plan-only
    browser: approved-scenarios-only
```

单工具安装生成同一 schema，以下为只使用 Cursor Agent CLI 的完整核心配置：

```yaml
schema_version: 2
execution:
  mode: single-tool
server:
  host: 127.0.0.1
  preferred_port: 4810
clients:
  cursor-agent:
    enabled: true
profiles:
  cursor-native:
    adapter: cursor-agent
    executable: {source: discovered, command: agent}
    model: {source: native-config}
    auth: {source: native}
    options: {}
    toolset: managed-development
bindings:
  planner: cursor-native
  implementer: cursor-native
  tester: cursor-native
  reviewer: cursor-native
browser:
  provider: playwright
  channel: chromium
  headed: true
workflow:
  template: checked-development
  revision: 2
toolsets:
  managed-development:
    broker: true
    native_agent_tools: false
    mcp_servers: []
    commands: approved-plan-only
    browser: approved-scenarios-only
```

这里的 `cursor-agent` 可由向导替换为任何一个正式适配器 ID，并同步生成该 CLI 的 executable；模式、角色、测试和证据代码完全相同。安装依赖从启用的入口客户端及实际节点绑定求闭包，不能从适配器注册表求并集。单工具向导默认把入口一并设置为所选工具；网页入口不增加 AI 依赖。

指定模型时，UI 将 `model` 写为 `{source: explicit, id: 用户所填的精确 ID}`；继承时使用上例 `native-config`。两种字段形态是同一功能的明确配置语义。核心不得按厂商或模型系列写死模型枚举。

Claude Code 的模型支持原生别名或模型名称；自定义网关必须按 Claude Code 支持的协议与鉴权配置接入。仅填写一个 OpenAI-compatible URL 并不意味着 Claude Code 一定兼容。平台沿用该工具已配置且测试通过的连接，不把任意网关都显示为可用。[Claude Code 模型配置](https://code.claude.com/docs/en/model-config)

### 4.4 参数、模型发现与实际模型记录

1. 每个适配器提供 `optionsSchema`。只有声明支持的参数进入 UI，例如某工具的 effort；不存在的参数不显示，也不传入 CLI。
2. 有官方模型枚举接口的工具使用该接口，例如 `agy models`、`opencode models`、Cursor `agent models`、Grok `grok models`；无枚举接口时显示用户原生配置里的模型，并提供“输入模型 ID”。禁止用其他厂商的 `/models` 结果冒充此工具的能力列表。
3. 原生配置在创建 Run 时解析：保留模型选择器、provider、endpoint 的无密钥信息及配置哈希。工具内置的账号默认模型无法事先解析时，保留 `native-default` 语义，不伪造精确模型 ID。
4. 日志分别保存 `requestedModel`、`reportedModel` 和 `modelEvidence`。未报告的实际模型必须显示“工具未报告”；代理网关报告的模型只能称为网关/工具报告，不能证明后端真实权重。
5. 显式模型与工具报告冲突时，本轮失败，错误为 `MODEL_MISMATCH`。不自动降级、更换工具或切换付费来源。
6. 连接检查先执行不调用模型的版本、配置和 MCP 检查；用户点击“验证模型连接”才进行一轮有界的只读模型调用，结果与安装成功分别记录。

### 4.5 随时修改的生效规则

1.3 补充：任务级组合快照、执行中正式指令和文档调整以第 16 节为准。无变化恢复可用已验证的原会话；正式改向统一停止后新会话交接。全局配置修改不影响已有任务。

| 修改对象 | 固定生效规则 |
|---|---|
| 默认角色、模型、Toolset | 保存后立即供新工作流使用；已有工作流继续使用冻结版本 |
| 尚未开始的工作流 | 用户点击“应用最新配置”，生成新修订；若改变已批准的计划约束，重新审批 |
| 正在运行的工具或模型 | “停止并切换”：停止进程和浏览器、撤销 Run token、确认资源退出，再创建新 Run |
| 相同工具的连续执行 | 只有适配器版本、Profile、工作目录、模板和权限哈希全部相同且支持恢复时，才使用明确的会话 ID |
| 跨工具或模型切换 | 新建会话；使用批准计划、当前代码快照、进度和证据摘要交接，不搬运厂商私有会话 |
| 浏览器 Provider 切换 | 新增浏览器租约并重新执行该层验收；已有代码测试只在其输入未变化时保留 |
| 实施工具或模型切换 | 新 Run 重新冻结并执行验证；旧人工验收和复核不继承到新 Run |
| 工具版本更新 | 无活跃引用后安装并验证；旧 Run 继续绑定原版本或停止后切换 |
| Skill 或流程模板修改 | 生成新版本；运行中任务继续持有旧内容哈希 |

不提供跨 CLI 的“无损热切会话”承诺。用户随时能修改配置，切换执行在可验证的停止边界完成。

## 5. Agent 与客户端适配器合同

### 5.1 AgentAdapter

```typescript
interface AgentAdapter {
  id: string;
  version: string;
  probe(input: ProbeInput): Promise<ProbeResult>;
  describe(): AdapterDescriptor;
  resolveProfile(input: ProfileInput): Promise<ResolvedProfile>;
  prepare(input: RunContext): Promise<PreparedInvocation>;
  decode(input: RawChunk): NormalizedEvent[];
  finalize(input: ExitAndArtifacts): Promise<AgentResult>;
  resume(input: ResumeContext): Promise<PreparedInvocation>;
}
```

`PreparedInvocation` 只含结构化 executable、argv、cwd、env 引用、stdin、临时文件和预期协议；由统一宿主启动。适配器没有自行 detached 启动进程的权力。`resume` 不支持时返回 `RESUME_UNSUPPORTED`，引擎按第 4.5 节创建新会话。

统一能力字段：`headless`、`streaming`、`explicitModel`、`nativeModel`、`resumeById`、`mcp`、`toolAllowlist`、`readOnlyReview`、`structuredResult`、`reportedModel`、`supportedTargets`。每个能力有测试证据与工具版本，不以工具名称推断。

统一事件：`run.started`、`session.bound`、`model.reported`、`message.delta`、`tool.started`、`tool.finished`、`approval.required`、`artifact.created`、`run.completed`、`run.failed`、`run.cancelled`。JSONL 字节解码器从 agy 目录迁入公共协议模块，但八种正式 CLI 的事件解析器分别实现。


### 5.2 八个内置适配器

下表是确定的协议实现合同。argv 始终以数组生成，表中省略的 prompt 从结构化输入传入。所有工具均实现四角色，不能只提供“入口可配置”就标记支持。

| ID / 工具 | 正式非交互入口 | 模型与恢复合同 |
|---|---|---|
| `codex` / Codex CLI | `codex exec --json` | `--model`；按保存的 thread ID 使用 `exec resume`，禁止 `--last` |
| `agy` / Antigravity CLI | `agy -p <prompt> --output-format stream-json` | `--model`、`--effort` 来自 Profile；保存 conversation ID，按 `--conversation <id>` 恢复，显式绑定项目 |
| `grok-build` / Grok Build | `grok -p <prompt> --output-format streaming-json --no-auto-update` | `--model`；保存 session ID，使用 `--resume <id>`；版本探针为 `grok version` |
| `claude-code` / Claude Code | `claude -p <prompt> --output-format stream-json --verbose` | `--model`；明确 `--resume <id>`；解析 permission denials 与错误终态 |
| `kimi-code` / Kimi Code | `kimi -p <prompt> --output-format stream-json` | `--model`、`--agent-file`；当前 TypeScript 版；首发固定新会话交接 |
| `qoder` / Qoder CLI | `qoder -p <prompt> --output-format stream-json` | `--model`、`--cwd`；保存会话 ID，用 `--session-id <id>` 绑定；首发跨节点统一新会话 |
| `opencode` / OpenCode | `opencode run --format json --pure --agent devflow-managed` | `--model provider/model`；`--session <id>`；`--dir` 指向控制目录；每 Run 独立本地进程，不挂接用户服务器 |
| `cursor-agent` / Cursor Agent CLI | `agent -p <prompt> --output-format stream-json` | `--model`、`--workspace`；明确 `--resume <chatId>`；`cursor-agent` 别名须验证与 `agent` 同产品 |

协议依据：[Codex 非交互](https://learn.chatgpt.com/docs/non-interactive-mode)、[Grok Headless](https://docs.x.ai/build/cli/headless-scripting)、[Claude Headless](https://code.claude.com/docs/en/headless)、[Kimi 命令](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command)、[Qoder 脚本运行](https://docs.qoder.com/cli/run-in-scripts)、[OpenCode CLI](https://opencode.ai/docs/cli/)、[Cursor 参数](https://prod.cursor.com/docs/cli/reference/parameters)、[Antigravity CLI Headless](https://www.agy.dev/docs/cli/headless/)。

不能把 `stream-json` 当作所有 CLI 共用的事件 schema。Antigravity CLI 解析 init/step_update/result；Grok 的参数值是 `streaming-json`；OpenCode 的 `json` 是事件流。其余类型和终态字段按各工具原始夹具实现，未知事件保存为扩展事件，未知终态不得自动判成功。stdout/stderr 分离；ANSI、启动提示、插件日志和不完整 JSON 单独处理。

本机证据种子为 npm Codex 0.152.0、桌面 Codex 0.154.0-alpha.6.2、Claude Code 2.1.270、Cursor Agent 2026.08.11-e8db854、OpenCode 1.18.30、agy 1.2.2；它们的版本与参数探针不等于完整适配认证。Kimi 0.37.2 本次也复验了版本。其余 CLI 在 P04 从官方来源解析当时稳定版本，执行合同测试后将精确版本、产物 SHA、帮助文本和事件夹具写入 `components.lock.json`。锁版本是确定的构建步骤，不要求用户选择；认证失败必须在 P04 修复，不能静默减少八工具交付范围。alpha 构建只作为本机兼容样本，不作为默认发布版本。

CLI 的 `exit=0` 仅表示进程层结果。工作流成功必须另有服务端保存的完成声明、实际测试证据、当前模板要求的审批与复核结果。权限软拒绝、输出截断、缺失结果消息和错误码不能被自然语言“完成”覆盖。

八适配器共用 MCP 结果合同：`devflow_submit_result`、`devflow_submit_test_result`、`devflow_submit_review`。测试提交只能引用本 Run 已存在的真实命令报告 ID，不能由模型自填一个 `passed: true`。工具支持 JSON Schema 时增加校验；业务层始终执行服务端 schema 校验。格式错误只允许一次格式修正调用。

### 5.3 执行权限不能只写在 Skill 中

实施 Agent 运行在独立控制目录，通过 DevFlow FileBroker 和已批准命令修改业务 worktree。测试、构建和浏览器启动由服务执行，第三方 Agent 不直接持有任意业务目录 shell 权限。

- Claude Code：`--tools ""` 禁用原生工具；`--strict-mcp-config` 配合专用 MCP 文件，只暴露该 Run 的工具。不能把 `--allowedTools` 当作禁用其他工具的开关。
- Kimi Code：显式 `--agent-file` 中 `tools` 只列当前角色 MCP 工具，禁用 Agent、AgentSwarm、Bash、原生写入等不在列表内的能力。MCP 工具名称按真实注册结果生成；只允许该角色的精确集合。
- Grok Build：隔离 `GROK_HOME`，用 `--tools` 及 `--disallowed-tools` 删除原生工具，`--allow`/`--deny` 限制当前 MCP。关闭 Claude/Cursor 配置兼容导入、外部插件、hooks、memory、web-search 与 subagents。Skill 的 `allowed-tools` 在该工具中不负责授权，不能以它代替运行策略。[Grok CLI](https://docs.x.ai/build/cli/reference)、[Grok 权限](https://docs.x.ai/build/features/permissions)、[Grok Skills](https://docs.x.ai/build/features/skills-plugins-marketplaces)
- Qoder CLI：隔离 `QODER_CONFIG_DIR`，使用 `--permission-mode dont_ask`；为版本清单列出的原生工具逐项生成 deny，仅允许 `mcp__devflow__<tool>`。关闭外部插件、hooks 和子 Agent，未知新增原生工具使认证失败。不能将 `accept_edits` 或 `bypass_permissions` 用作默认受管权限。[Qoder 权限](https://docs.qoder.com/cli/permissions)、[Qoder MCP](https://docs.qoder.com/cli/mcp-servers)
- OpenCode：生成 `devflow-managed` Agent，`permission` 先默认 `"*":"deny"`，随后仅放行准确的 DevFlow MCP 名称；`--pure` 禁止外部插件，隔离配置禁用 share 与其他 MCP/Agent。不得使用 `--auto` 或连接用户已有 `serve` 进程。MCP 名称从实际发现结果生成，不假定遵循 Claude 的命名方式。[OpenCode Agents](https://opencode.ai/docs/agents/)、[OpenCode 配置](https://opencode.ai/docs/config/)
- Cursor Agent：在隔离的当前用户配置视图与控制工作区生成 `cli-config.json`/`.cursor/cli.json` 和 `.cursor/mcp.json`，deny 原生 Shell、Read、Write、WebFetch，allow 精确 `Mcp(devflow:<tool>)`。只启用本 Run MCP，检查其生效配置来源；不传 `--force`、`--yolo`、`--approve-mcps` 来跳过限制。按版本记录其他原生工具并默认拒绝，不把 `--mode plan` 当作全部权限控制。[Cursor 权限](https://prod.cursor.com/docs/cli/reference/permissions)、[Cursor MCP](https://prod.cursor.com/docs/cli/mcp)
- Antigravity CLI（agy）：沿用项目级隔离、专用 MCP 与已实现的默认拒绝 PreToolUse；将当前项目绑定和 hook 生成逻辑保留在 agy 适配器内。按节点角色生成精确工具白名单，未授权原生工具在执行前拒绝；不同角色不共享实施会话的写入权限，钩子格式与行为按版本认证。
- Codex：使用 `--ignore-user-config --ignore-rules --sandbox read-only`；生成 `features.shell_tool=false`、`features.unified_exec=false`、`approval_policy="never"`、`web_search="disabled"`，仅配置当前角色必需的 MCP，并通过 `mcp_servers.<id>.enabled_tools` 限制工具集合。只读沙箱限制原生补丁写入，实际业务修改由服务端 FileBroker 完成；不得将 sandbox 升级成全权限来解决接入问题。[Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)

受管 Agent 所需 Skill 正文由服务从编译产物按节点角色直接注入启动上下文，并写入内容哈希，不要求额外放行原生文件读取才能获得指令。用户交互入口仍按原生 Skill 发现和触发机制工作。

配置隔离固定由 `ClientRuntimeSandbox` 构建：优先使用上表官方专用目录变量；没有独立目录开关的客户端使用仅对子进程生效的 HOME/USERPROFILE 视图与专用控制目录，绝不暂时改写用户全局配置。白名单复制模型/provider 非密钥字段，并通过该工具支持的凭据文件私有副本或单进程环境注入复用原生登录；相关文件权限限制为当前用户，Run 后清理。探针须同时证明原生鉴权可用、实际加载配置来源符合预期、没有夹带其他 MCP/hooks/plugins；否则该版本认证失败。操作系统凭据存储继续由原工具在当前用户身份下读取。

复核角色只获得读取冻结快照和原始证据的工具。用户原生配置中的模型与 provider 参数按白名单继承，原生全权限、hooks、项目插件不作为模型设置一起导入。使用“忽略用户配置”的参数时，必须补回已解析的 provider、endpoint、必要 model 选项和鉴权引用，避免丢失用户自己的模型接入。

八个正式适配器都必须通过“尝试原生 shell、写范围外文件、启动未授权 MCP、越权审批、读取其他工作流证据”的负向测试。能力检查失败的版本显示不可用于受管实施，不通过提示词降低要求。[Claude CLI 工具开关](https://code.claude.com/docs/en/cli-reference)、[Kimi 自定义 Agent 工具限制](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/agents.html)

上述机制是工作流权限控制。平台运行于同一系统用户，不能将它描述为抵御恶意本地插件或恶意测试程序的操作系统安全沙箱；受管测试执行的仍是用户选择的项目代码。

### 5.4 ClientInstaller 与 Skill 安装

客户端安装与执行适配分离。`ClientInstaller` 固定提供 `detect / locateConfig / render / diff / apply / verify / uninstall`。


| 客户端 | 入口 MCP 安装位置 | Skill 产物 |
|---|---|---|
| Codex | `$CODEX_HOME/config.toml`，默认 `~/.codex/config.toml` 的 `mcp_servers.devflow` | `~/.agents/skills/devflow*`，保留 references、agents 元信息 |
| Antigravity CLI（agy） | 官方本地 `devflow` plugin，包内含 MCP 配置，使用 `agy plugin` 安装并核实生效状态 | 七个中立 Skill 编译为 agy 平面 `.md` 格式，随 plugin 附带全部引用资源 |
| Grok Build | `$GROK_HOME/config.toml`，默认 `~/.grok/config.toml` 的 `mcp_servers.devflow` | `$GROK_HOME/skills/devflow*`，默认 `~/.grok/skills` |
| Claude Code | `claude mcp add --scope user` 管理用户级 `devflow`，事务保存前后差异 | `~/.claude/skills/devflow*` |
| Kimi Code | `$KIMI_CODE_HOME/mcp.json`，默认 `~/.kimi-code/mcp.json` 的 `mcpServers.devflow` | `$KIMI_CODE_HOME/skills/devflow*`，隔离目录与系统 home 分开 |
| Qoder CLI | `$QODER_CONFIG_DIR/settings.json`，默认 `~/.qoder/settings.json`；用 `qoder mcp add -s user` 管理 `devflow` 并读回 | 同配置根 `skills/devflow*` |
| OpenCode | `~/.config/opencode/opencode.json` 或用户现有 `opencode.jsonc`；`mcp.devflow`，`type: local`，`command` 为 executable/argv 数组 | `~/.config/opencode/skills/devflow*`，尊重已设置的 XDG 配置根 |
| Cursor Agent | `~/.cursor/mcp.json` 的 `mcpServers.devflow`；CLI 与编辑器共享，使用 `agent mcp` 验证 | `~/.cursor/skills/devflow*`，处理其 `.agents`/`.claude` 兼容发现 |

新增客户端依据：[Antigravity Plugins 与 Skills](https://www.agy.dev/docs/cli/plugins/)、[Grok MCP](https://docs.x.ai/build/features/mcp-servers)、[Grok Skills](https://docs.x.ai/build/features/skills-plugins-marketplaces)、[Qoder MCP](https://docs.qoder.com/cli/mcp-servers)、[Qoder Skills](https://docs.qoder.com/cli/Skills)、[OpenCode MCP](https://opencode.ai/docs/mcp-servers/)、[OpenCode Skills](https://opencode.ai/docs/skills/)、[Cursor Skills](https://cursor.com/docs/skills)、[Cursor MCP](https://prod.cursor.com/docs/cli/mcp)。

所有 `~` 均以当前操作系统实际用户目录展开，目录变量按各厂商语义展开；Antigravity 通过其原生 plugin 安装机制管理入口，不能套用其他工具的目录变量或配置格式。安装发现先读取实际配置覆盖变量，再确定唯一写入位置，避免另写一个客户端不会加载的默认文件。

Codex 当前官方用户 Skill 目录是 `.agents/skills`，不能继续只复制到 `.codex/skills`。Kimi 新版与旧 Python CLI 的目录、参数和配置格式不同；检测到旧版时给出迁移说明，不悄悄改写其配置。[Codex Skill 目录](https://learn.chatgpt.com/docs/build-skills)、[Codex MCP 配置](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)、[Kimi Skills](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html)、[Kimi MCP](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html)、[Claude Skills](https://code.claude.com/docs/en/skills)、[agy Plugins 与 Skills](https://www.agy.dev/docs/cli/plugins/)

七个 Skill 继续只有一份核心源码：`devflow`、`devflow-project-onboard`、`devflow-plan`、`devflow-execute`、`devflow-test`、`devflow-review`、`devflow-browser-accept`。正文不写固定系统、模型、CLI 路径或安装目录；按 `devflow_capabilities`、`devflow_context` 获取实际角色与工具。`devflow-test` 负责测试设计检查、批准范围内补测、发起受管测试、读取报告和提交失败诊断。生成器处理 agy 平面文件、Codex 元数据以及不同客户端引用资源路径。Antigravity 使用上述平面 Skill 产物，其余七种 CLI 使用标准目录形式，通用正文不得依赖某个厂商专用 Skill 工具名称。

共享 `~/.agents/skills` 的发现别名需要按 canonical path 和内容哈希去重；同一受管版本重复出现时只保留一份有效入口。多个客户端引用同一物理目录时按客户端引用计数卸载，不能卸载 Codex 就删除 Cursor 等其他客户端正在使用的共享 Skill。不同内容的同名用户 Skill 按配置冲突处理。

Skill 及配置安装合同：

1. 先生成安装差异、备份、文件清单与哈希，再在临时目录渲染产物。
2. TOML/JSON/JSONC 通过保留注释的结构化解析和最小字段修改处理；不能沿用正则删除整段配置。
3. 同名 MCP 项或 Skill 由安装清单识别所有权。不是 DevFlow 管理或内容被用户修改时，向导展示差异并要求用户选择覆盖的文件；其余组件继续安装。
4. 各客户端修改通过临时文件、同目录原子替换和配置读回验证。失败恢复本次修改，不覆盖其他安装进程的变更；提交前比较原配置哈希。
5. 安装整个 Skill 目录，校验引用资源存在，不只复制 `SKILL.md`。
6. 升级比较上次受管哈希，卸载只移除仍属于本安装的文件和配置字段。
7. 配置写入不等于当前会话已加载。对新增 MCP 要求新建会话/客户端重载；Kimi 当前会话不会自动加入新 MCP，向导准确显示此状态。
8. `doctor` 校验文件、配置、MCP initialize/tools/list，并以只读 `devflow_doctor_context` 完成往返。真实客户端中的 Skill 触发另列验收，不凭文件存在宣称触发已验证。
9. 七个 Skill 在八种客户端逐一校验，共 56 个基础安装格子，其中包含 Antigravity plugin 的七个 Skill 产物。客户端名称、角色与模型无硬编码绑定，`devflow-test` 在任何单工具安装中都必须可用。
10. 只读发现命令按工具使用：Antigravity `agy plugin list` 检查插件加载，Grok `inspect --json`，OpenCode `debug skill`；无稳定机器可读 Skill 列表的工具，使用原生新会话触发合成任务，必须观察真实 `devflow_doctor_context` 调用事件。命令随锁定版本通过帮助/协议探针认证，不通过模型自述判断加载成功。

### 5.5 社区新增工具

`devflow adapter add <本地目录或固定 Git revision>` 安装独立适配器包。包必须包含 ID、协议版本、支持平台、options schema、安装配方、入口程序和契约测试夹具。安装来源及执行权限展示给用户后才启用。

社区适配器通过版本化 JSON-RPC stdio 与核心通信，实现 `probe / describe / prepare / decode / finalize`；按统一宿主受管运行，崩溃只影响当前 Run。拥有相同 ID 的版本并存，每个 Run 固定其中一个版本。它是本地可执行代码，不能称为沙箱插件。

只有更换模型、路径、参数、已支持工具或 MCP 服务时只需配置；接入全新 CLI 事件协议时必须有适配器实现。平台不会要求用户修改 `engine.ts` 或复制一套工作流。

## 6. 流程从固定状态迁移为可配置模板

### 6.1 模板模型

新增 `WorkflowTemplate`：`id / revision / name / inputs / nodes / edges / outputs / policy / content_hash`。节点类型固定为 `agent`、`command`、`checks`、`browser`、`human`、`snapshot`、`condition`、`join`、`artifact`、`commit`。用户以这些节点拼接流程；社区 Agent 扩展不需要新增节点类型。

模板编辑器提供节点增删、排序、连线、角色选择、Toolset 选择、审批开关和条件表达式。条件使用类型化比较、布尔组合和前序输出引用，禁止 `eval`、任意 JavaScript 或 shell 片段。

编译时检查：唯一入口、节点引用、无环、可达性、输出类型、Profile 存在、能力满足、并行写集合冲突、审批节点与所批准材料的绑定。失败不能发布模板。修复回路通过创建关联的新执行轮次实现，不在 DAG 中引入无界环；默认最多 3 个修复轮次，超限进入人工处理。

默认 `checked-development@2` 模板保留人工批准与验收位置，增加显式 tester：

```mermaid
flowchart LR
  Plan[规划] --> Approval[人工批准计划]
  Approval --> Execute[实施]
  Execute --> Test[测试 Agent 检查并补齐测试]
  Test --> Freeze[冻结代码快照]
  Freeze --> Verify[测试 Agent 发起测试并核验报告]
  Verify --> Accept[人工验收]
  Accept --> Review[独立复核]
  Review --> Commit[本地提交]
```

用户能够发布删除、增加或移动节点的新模板。例如是否需要人工验收是显式模板属性，不能仍藏在核心的厂商专用 if/else 中。删除审批、复核或提交节点时，控制台明确显示本模板实际保证的内容；未配置的验证不会在结果上显示“已通过”。默认模板不删除任何当前门槛。

平台固定不变量与流程自由度分离：任何模板都不能冒用人工身份、接受跨 Run 证据、在已停止 Run 中继续写入、绕过工作目录范围、以退出码冒充测试结果或自动执行没有授权的发布动作。

### 6.2 节点运行与证据

新增 `NodeRun`，字段至少包括：

```text
id, workflow_id, template_revision, node_id, attempt,
status, profile_revision, toolset_hash, snapshot_id,
input_hash, output_ref, run_id, created_at, finished_at
```

状态为 `pending / ready / running / waiting_human / succeeded / failed / cancelled / blocked / skipped`。现有 `RESEARCHING`、`EXECUTING` 等中文进度及总状态成为节点状态投影；旧 API 迁移期间继续返回兼容总状态。

`agent` 节点的完成输出必须来自服务端业务工具确认。tester 分为 `test-prepare` 与 `test-verify` 两个节点：前者在批准范围内增补测试文件并提交测试清单；随后冻结代码及测试快照；后者只读调用 `devflow_run_checks` 发起正式测试并读取报告，不再修改文件。服务执行相应 `checks` 节点并回传报告；tester 提交结构化诊断后才允许进入人工验收。无 tester 的显式自定义模板可由服务直接执行 checks，但默认模板和单工具验收必须实际经过 tester。`checks` 节点由普通程序运行已批准测试，记录命令、cwd、环境摘要、退出码、结构化报告、文件哈希与快照哈希。单元、集成、E2E、浏览器层按项目适用性配置；不适用项必须在计划中明确说明，不能靠空测试报告跳过。失败交给相同绑定的 implementer 修复业务代码、tester 补测；形成新轮次并重新冻结，最多 3 次。测试报告未生成、只写了测试而未运行、测试进程超时或退出码与结构化报告冲突均失败。

默认模板的 `test-verify` 是 agent 节点。它调用 `devflow_run_checks` 时，由服务创建绑定其 `parent_node_run_id` 的 checks 子执行，继承同一 Run、快照和批准配方；该子执行不占用另一个 AI 槽位，也不等待父节点成功，避免相互等待。MCP 返回执行 ID，普通程序跟踪测试进程并提供 `devflow_get_check_result`；调用方等待/读取报告后提交测试结论。父节点只有在全部必需子执行真实通过且结论已提交后成功。测试运行期间没有 AI 轮询器。新增 `NodeRun.parent_node_run_id` 与 `check_execution_id`，绑定和幂等键在事务内创建。

`human` 节点绑定该节点的输入内容哈希，前序材料变更使其确认失效。`commit` 节点检查所有必需前序成功，绑定源码快照，保留现有提交前漂移检查与 `COMMIT_PARTIAL` 恢复规则。发布动作不随本地 commit 自动执行。

### 6.3 并发、事件与恢复

- 不同 worktree 可以并行；同一 worktree 的修改节点按写租约串行。
- 无写入、不同资源的节点可并行；join 等待其声明的全部必需输入，失败不能被同组成功覆盖。
- 浏览器租约覆盖整个验收场景；OpenTabs 按连接实例独占，Playwright 按独立 Context 并发。
- 通用调度器按资源标签计数，不再只区分 agy executor 和 Codex reviewer。
- 普通程序消费 CLI 事件并推送控制台；发起 Agent 不被当作轮询器。节点就绪时才启动对应 Agent。
- 平台崩溃后先检查宿主、进程身份、租约和文件快照；证据不足进入 `RECOVERY_REQUIRED`，不能因心跳过期自动判定安全。
- 网络重试复用 idempotency key。只读检查最多重试 3 次；有副作用步骤先核实是否已完成，不盲目重试。

## 7. 辅助工具和浏览器解耦

### 7.1 统一 ToolGateway

MCP server 注册项包含 `id / transport / command+argv 或 url / envRefs / headersRefs / version / required / allowedTools`。工具本身的 API Key 单独保管，配置只存引用。服务获取 tools/list 并固定工具 schema 哈希；版本或 schema 变化触发重新验证。

Toolset 引用允许的工具和参数约束，最终权限取 Toolset、节点角色、批准范围和当前 Run 授权的交集；因此复核角色即使复用实施 Profile 也得不到写入工具。Agent 只看见当前角色经 DevFlow 暴露的工具，不自动继承用户电脑上所有 MCP 服务。MCP 的 `readOnlyHint` 仅作为提示，不能当成授权依据；未经分类的外部工具按可能有副作用处理。

第一版直接支持 stdio 和 Streamable HTTP。OpenTabs 等已有客户端接入通过 Provider 转换为统一动作。对于任意新 MCP，只要使用上述标准传输和合法 schema，用户在设置页输入命令或 URL 即可注册；执行权限仍按 Toolset 配置。

### 7.2 BrowserProvider

接口固定为 `probe / createSession / navigate / locate / click / fill / select / assert / screenshot / console / close / reconcile`。场景数据使用语义动作和 locator，不直接写 `browser_click_element` 等 OpenTabs 专属名称。

默认 Provider 使用 Playwright 正式库，由服务执行固定场景。每个环境使用独立 Context、独立输出目录和已批准 origin；人工接管使用该工作流有头浏览器窗口，用户完成后继续同一验收会话。测试凭据不写进源代码和公共日志。

OpenTabs Provider 保留当前功能，执行前查询工具列表、校验必需 schema、登记本轮创建标签页，只关闭本轮标签页。它需要的浏览器扩展与用户登录状态独立检查，不能误伤用户原有标签页。

测试层迁移 `opentabs -> browser`；旧场景通过转换器转换成中立动作。无法无损转换的自定义工具调用仍保留为 `provider: opentabs` 的受支持旧场景，绑定 OpenTabs 运行；此类场景不允许直接切换到 Playwright 并声称等效，必须先编译成新场景并重新验收。

## 8. 跨平台进程、目录与环境

### 8.1 安装与数据目录

| 用途 | Windows | macOS | Linux |
|---|---|---|---|
| 安装根目录 | `%LOCALAPPDATA%\DevFlow` | `~/Library/Application Support/DevFlow` | `${XDG_DATA_HOME:-~/.local/share}/devflow` |
| 配置、状态、日志 | 安装根下 `data` | 同左 | 同左 |
| 公开命令 | 安装根下 `bin\devflow.cmd` | `~/.local/bin/devflow` | `~/.local/bin/devflow` |
| 版本程序 | `releases/<version>` | 同左 | 同左 |
| 私有运行时与组件 | `runtimes/<component>/<version>/<target>` | 同左 | 同左 |
| 业务 worktree | `data/worktrees/<workflow>/<repo>` | 同左 | 同左 |

`DEVFLOW_HOME` 是显式自定义安装根。默认目录由平台函数计算，不读取开发者的绝对路径。状态目录只允许本机文件系统，不放在网络盘或同步盘中依赖不可靠的 SQLite/文件锁语义。

安装根有稳定的 `bootstrap/dispatch.mjs` 与 `current.json`。终端 shim 调用私有 Node；MCP 配置直接写私有 Node 的绝对路径和 bootstrap 脚本的参数，避免 Windows `.cmd` 不能直接以 `shell:false` 启动的问题。bootstrap 按 `current.json` 选择服务版本，不依赖业务 cwd。

macOS 从 GUI 启动的程序常不继承终端 PATH，因此所有受管调用最终使用已验证的绝对 executable。发现顺序固定为显式配置、受管清单、当前 PATH、系统用户 PATH、官方安装目录；多个结果并存时展示版本与来源，保留用户已绑定的指纹。Windows npm shim 通过包 `bin` 映射解析到 Node + JS 或对应 native dependency，不能把所有 shim 一律当 JS。检查 PE/ELF/Mach-O 格式、CPU、真实长度、版本探针和帮助协议，才标记 `INVOCATION_READY`。

本机 OpenCode 案例必须转成回归夹具：`opencode-ai/bin/opencode.exe` 是 479 字节文本占位入口，但 `opencode-windows-x64/bin/opencode.exe` 是可运行的 1.18.30 原生产物。解析器只能沿受信任包元数据和受管组件映射定位真实平台文件，不任意猜路径。Cursor 也必须从包装器解析到确定版本目录内的运行时和 JS 入口，不能每次启动重新选择“最新”。禁止将未经解析的 shell 字符串塞入 executable。

只发现编辑器 `cursor` 而没有 Agent CLI 时，状态为 `AGENT_CLI_MISSING`，安装器自动补装所选 Agent 组件。原生入口无效时返回 `EXECUTABLE_INVALID` 并在安装事务中修复受管副本；对用户原装副本只报告发现结果，不静默覆盖。

### 8.2 Go 宿主职责

宿主提供 `doctor / lock / run / stop / status / process-identity`，使用版本化 JSONL 控制协议；stdout/stderr 以独立数据通道或带类型的 Base64 帧传递，保留 UTF-8 分块完整性。

| 能力 | Windows 驱动 | macOS/Linux 驱动 |
|---|---|---|
| 单控制器锁 | Named Mutex，基于规范化数据目录身份 | `flock` 持有锁文件描述符 |
| 启动 | suspended 创建进程，分配 Job 后 resume | `os/exec` + 独立进程组，宿主位于组外 |
| 子进程约束 | Job 不开放 breakaway，kill-on-close | 受管命令继承进程组，不允许业务配方自行 daemonize |
| 正常停止 | 撤销令牌、通知停止，然后终止整个 Job | SIGTERM 整组，5 秒后 SIGKILL 整组 |
| 控制器断连 | 管道 EOF，关闭/终止 Job | 管道 EOF，宿主终止所持进程组 |
| 宿主意外退出 | Job 句柄关闭触发系统终止 | 恢复时检查进程身份与组；无法证明清理完成就阻塞 |
| 身份 | PID、创建时间、可执行路径、Job 名称 | PID、PGID、启动时间、boot identity、可执行路径 |

不能声称 POSIX 进程组和 Windows Job Object 拥有完全相同的内核级保证。macOS 上宿主被 SIGKILL、子进程擅自脱离进程组等异常，以对账阻塞保证不提前重用资源；不根据 PID 单独发送 kill，防止 PID 复用误杀。

停止成功的判据是受管对象退出已经核实，而不是已经调用 `kill()`。停止超时显示具体残留身份，租约保持占用。宿主操作始终要求匹配 run ID 与启动身份，不能批量结束同名进程。

### 8.3 路径、环境和鉴权

- 路径身份使用 realpath、平台文件系统语义与持久化项目 ID。移除 `.toLowerCase()` 处理所有路径的做法；macOS 卷大小写能力需要探测，不按系统名直接假设。
- 统一覆盖空格、中文、Unicode 组合形式、长路径、符号链接和 Windows junction；保留现有禁止越界写的 FileBroker。
- 受保护目录扩展到 `.codex`、`.grok`、`.claude`、`.kimi-code`、`.qoder`、`.opencode`、`.cursor`、`.agents` 及 Antigravity 项目适配器维护的配置目录和各客户端配置实际解析路径。
- POSIX 进程补齐 HOME、PATH、TMPDIR、LANG/LC_ALL、SHELL；Windows 使用 USERPROFILE、APPDATA、LOCALAPPDATA、SystemRoot 等。环境继承采用按用途的白名单。
- 原生认证默认交给原工具读取。DevFlow 新增凭据使用操作系统凭据存储：Windows Credential Manager、macOS Keychain、Linux Secret Service；Linux 未安装 Secret Service 时只接受进程环境中的 key，不写明文替代文件。
- 原生 profile 中已有明文 token 不复制到日志、Git 或审计导出。需要隔离配置时通过受控临时凭据引用或单进程环境注入；临时文件为当前用户私有并在 Run 结束清理。
- Agent、测试进程、浏览器进程分别构建环境。模型密钥不传播到 npm 构建脚本和项目测试进程。

## 9. 一行安装和组件管理

### 9.1 发布后的固定入口

Windows PowerShell：

```powershell
irm https://github.com/zephyrw/dev-flow/releases/latest/download/install.ps1 | iex
```

macOS / Linux：

```sh
curl -fsSL https://github.com/zephyrw/dev-flow/releases/latest/download/install.sh | sh
```

这两个命令是同一安装系统的两个操作系统入口。当前不能将其当作已经上线的安装服务；P10 发布安装资产后再放入公共 README。

源码下载并解压到仓库目录后，一行安装入口固定为：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\bootstrap\install.ps1 -Source .
```

```sh
sh ./scripts/bootstrap/install.sh --source .
```

`--source` 从当前源码构建，自动下载同一锁文件中的 Node 和 Go 构建工具链，执行 `npm ci`、类型检查、测试、前后端构建和本机 Host 构建；SQLite 扩展优先使用经过验证的精确 ABI 产物。若修改了原生扩展依赖而无法使用既定产物，安装器根据注册的本机工具链配方安装构建依赖，并准确报告系统授权需求。官方发布源码的标准路径必须不要求用户自行排查 `node-gyp`。

### 9.2 安装器执行顺序

1. 检测 OS、CPU、目标目录、磁盘空间、代理变量和当前安装。未知平台在写入前明确拒绝。
2. 从固定仓库 latest release 取得安装清单，将 release ID、tag 和清单哈希锁定为本次安装计划，后续所有下载用该 tag，避免途中更新导致混包。
3. 下载目标平台包与必需运行时，校验长度和 SHA-256；解压拒绝路径穿越、绝对路径和逃逸链接。下载失败退避重试 3 次，不切换不受信任镜像。
4. 安装器使用私有 Node 启动只监听回环地址的设置向导，自动打开浏览器。
5. 显示检测到的客户端及角色绑定。选择一个工具也可运行全部角色，选择 Kimi + Claude 时只安装这两个工具及共有依赖。
6. 根据组件依赖图计算安装闭包；展示组件、版本、下载来源、磁盘需求和需要用户完成的第三方授权动作。
7. 先装组件，再完成原生登录或凭据引用配置。已安装版本通过探针且与兼容版本匹配时复用；不一致时另装受管版本，不覆盖用户全局工具。
8. 生成并事务化安装 MCP + 七个 Skill，检查解析和 tools/list 往返。
9. 启动服务、运行离线自检、创建临时演示仓库进行无需模型的调度/文件/测试/浏览器回环验证。
10. 输出分别列明平台、组件、授权、客户端加载状态的安装报告，打开控制台。仍需外部授权的组件不显示为可运行。

安装向导可通过本地网页接收输入，不依赖被 pipe 占用的 shell stdin。无图形界面的 Linux 支持 `--non-interactive --config <安装配置文件>`，缺失必需凭据时以明确退出码停止，不能无限等待。

### 9.3 组件依赖与安装责任

| 组件 | 固定安装策略 |
|---|---|
| Node | 私有目录安装精确版本，与系统 Node 并存 |
| 平台 Web/API/Host/SQLite | 目标平台包内预构建，普通安装不编译 |
| Git | 优先复用通过功能探针的本机 Git；缺失时安装发布清单中的便携 Git runtime |
| Windows Git Bash | Kimi/Claude 需要时安装匹配架构的 Git for Windows 便携产物，配置明确的 shell 路径 |
| macOS/Linux Git runtime | 从官方 Git 源码在 CI 构建便携包，带必需动态库、相对 rpath、HTTPS helper、CA 路径和对应源码 |
| Codex CLI | 官方 `@openai/codex` npm 包及对应平台依赖，按精确版本装到受管前缀 |
| Antigravity CLI（agy） | 从官方安装来源取得认证原生产物，锁定版本、目标架构与产物哈希；沿用本机已核实的 agy 命令协议，不能复制开发者机器上的 exe 作为公共发行包 |
| Kimi Code | 官方 TypeScript `@moonshot-ai/kimi-code` npm 包；拒绝把旧 Python CLI 当同协议 |
| Grok Build | 从官方 `x.ai/cli/install.sh` 所指向的发行索引提取对应系统原生产物，锁定版本和哈希；不使用第三方同名 npm 包 |
| Qoder CLI | 官方 `@qoder-ai/qodercli` npm 包及官方平台依赖；检查版本对应的 `qoder` bin，不硬编码旧别名；拒绝 Windows arm64 |
| OpenCode | 官方 `opencode-ai` npm 包及平台 native dependency；验证 postinstall 结果与真实原生入口 |
| Cursor Agent CLI | 官方 `cursor.com/install` / Windows `cursor.com/install?win32=true` 对应发行索引，安装固定版本目录；独立于 Cursor 编辑器 |
| OpenTabs CLI | 从官方 npm 包取得锁定版本，作为可配置浏览器组件安装 |
| Claude Code | 从官方安装器/官方原生产物取得认证版本，安装到受管位置，停用该受管副本的自动更新 |
| Playwright Chromium | 安装匹配 Playwright 版本的浏览器到私有缓存，不依赖用户已有 Chrome |
| Linux 浏览器系统库 | 由 Playwright 官方依赖安装步骤计算并安装；确需系统权限时显示系统授权步骤并保持可恢复状态 |
| 业务项目运行时 | 项目配方声明版本和命令；现有 Java、数据库、私有 SDK 不冒充平台公共依赖自动捆绑 |

便携 Git 是独立组件，不与平台代码链接。其 GPL 许可、完整对应源码及构建材料与二进制一同发布；自有平台 license 不覆盖 Git。六个平台上的本地仓库创建、worktree、状态、diff、提交以及 HTTPS Git 访问都列入 Git runtime 验收。

组件清单字段：`id / version / target / upstream / download / sha256 / size / license / dependencies / installActions / probe / uninstallOwnership`。必须解析为结构化操作，不把远程返回的任意字符串当作 PowerShell 或 shell 执行。

新增配方来源：[Antigravity CLI](https://www.agy.dev/docs/cli/headless/)、[Grok Build 安装](https://docs.x.ai/build/overview)、[Qoder 安装](https://docs.qoder.com/cli/installation)、[OpenCode 安装](https://opencode.ai/docs/)、[Cursor Agent 安装](https://prod.cursor.com/docs/cli/installation)。官方入口用于发行认证时解析版本，普通用户安装时只消费已经锁定的精确产物。

自动更新只对受管副本关闭：Grok 加 `--no-auto-update`，Qoder 写其隔离配置 `general.enableAutoUpdate=false`；其他工具按已认证原生设置关闭。没有停用开关的包装器不参与受管启动，固定启动版本目录并核对前后指纹；文件被修改就使 Run 失败，不继续将其标作锁定版本。用户原装 CLI 的更新配置不改。

上游脚本只提供“安装最新”而不能固定版本时，发布阶段从上游官方产物定位到精确下载 URL 和哈希后写入清单；定位不到就使该组件发布认证失败，不能交付一个会随时漂移的安装配方。该失败由 P04/P08 修复后才能发布 1.0.0，不转交最终用户研究。

### 9.4 安装状态、退出码和幂等

安装状态持久化为 `DISCOVERED -> PLANNED -> DOWNLOADED -> INSTALLED -> CONFIGURED -> VERIFIED`。外部授权进入 `NEEDS_USER_ACTION`，本地安装失败进入 `FAILED`，并保留最后成功步骤。网络恢复或用户授权后继续同一 installation ID。

退出码：`0` 全部必需项就绪；`10` 需要用户完成账号/系统/扩展操作；`20` 下载或校验失败；`30` 配置冲突；`40` 不支持的平台或协议；`50` 服务健康检查失败。非交互模式必须遵守；交互向导根据同一状态显示中文消息。

重复执行安装不重复写 MCP、不复制嵌套 Skill、不重复创建快捷方式、不重置模型配置、不重复登录。不改变无关软件的系统 PATH、自动更新策略和凭据。

### 9.5 一行命令的信任边界

初始脚本信任明确的 GitHub 仓库及 HTTPS。SHA-256 校验用于确保清单与下载产物一致，不能把“同源下载的哈希”描述为独立身份认证。GitHub Actions 生成构建 provenance 和 artifact attestation，供发布验证和人工审计使用。

发布产物无需向公共仓库提供厂商模型 API Key。任何私有测试凭据只在维护者受控的兼容测试任务中短时注入，不在公开 PR 工作流中可用。

## 10. 控制台与接口交付

控制台保留需求输入、项目、计划、执行日志和进度，新增以下固定页面：

| 页面 | 用户操作与输出 |
|---|---|
| 安装向导 | 默认单工具，展示八种 CLI；选择后一次绑定四角色，只安装依赖闭包；切至组合模式后逐角色设置，完成官方授权与就绪检查 |
| 工具与模型 | 创建/复制/编辑 Profile，继承原生模型或填精确 ID，检查能力和连接 |
| 辅助工具 | 注册 MCP、选择允许工具、配置浏览器、检查扩展连接 |
| 工作流模板 | 编辑节点、审批点、角色、条件和边；校验、预览、发布版本 |
| 任务配置 | 显示该任务冻结的工具、模型选择、版本和模板；停止并切换 |
| 安装维护 | 检查更新、查看配置差异、修复、回滚和卸载 |

页面文案默认展示“规划工具”“实施工具”“测试工具”“复核工具”“浏览器验收”，具体工具名来自 Profile。不要在通用流程界面继续写死“Antigravity 执行”“GPT-6 复核”。用户不需要填写 JSON 或接触内部 token。

新增 REST 合同：

```text
GET    /api/capabilities
GET    /api/adapters
POST   /api/adapters/:id/probe
GET    /api/profiles
POST   /api/profiles
PUT    /api/profiles/:id                   If-Match: profile_revision
POST   /api/profiles/:id/verify
GET    /api/templates
POST   /api/templates/validate
POST   /api/templates/:id/publish
POST   /api/workflows/:id/reconfigure      If-Match: workflow_version
GET    /api/installations/:id
POST   /api/installations/:id/resume
POST   /api/maintenance/update
POST   /api/maintenance/rollback
```

入口 MCP 新增 `devflow_capabilities`、`devflow_doctor_context`；保持 `devflow_start` 的自然语言入口，增加可选 `client_id`、`profile_id` 和 `execution_mode`，未传则使用已保存默认配置。会话绑定键加入 client 类型和真实会话 ID；无法取得 ID 时使用工作流显式绑定，不以最近任务代替。

设置、安装、模板发布和人工确认只由本地 human API 执行，普通 planner/worker token 无权改自己的权限、模型和流程门槛。保留 Host、Origin、Fetch Metadata、CSRF 防护。端口 4810 被占用时，在 4811–4899 顺序选择空闲端口并写入实例描述；不关闭占用端口的其他程序。人类 origin 与实际端口一起生成。

提交节点优先使用项目已有 Git 作者配置。缺少作者身份时，首次项目设置收集用户姓名与邮箱并写项目级配置；不能写入开发者本人的身份，也不因安装平台自动改全局 Git 身份。

命令行固定提供：

```text
devflow setup
devflow open
devflow status
devflow doctor --json
devflow integrate codex
devflow integrate agy
devflow integrate grok-build
devflow integrate claude-code
devflow integrate kimi-code
devflow integrate qoder
devflow integrate opencode
devflow integrate cursor-agent
devflow profile list
devflow workflow validate <文件>
devflow adapter add <来源>
devflow update
devflow rollback
devflow uninstall
```

这些是可脚本化的同一控制面；日常用户在已配置客户端说“用 DevFlow 帮我……”即可进入，不要求重复执行项目注册命令。

## 11. 旧安装迁移、升级、回滚与卸载

### 11.1 v1 配置和数据迁移

1. 首先识别旧配置的真实 `storage_root` 和 worktree 根；记录配置、数据库、证据、worktree 和宿主清单。停止动作只针对本实例拥有的对象。
2. 进入维护模式并排空活动 Run。无法确认进程退出时不迁移；`COMMIT_PARTIAL` 必须先完成其专用恢复。
3. 使用 SQLite 备份 API 创建一致性备份，复制配置、证据索引和安装清单，并校验可读与哈希；不能只复制可能仍写入的 sqlite 主文件。
4. 创建新 v2 配置，原 `executor/reviewer/effort` 转为旧模型的精确 Profile；旧端口、OpenTabs、调度额度和超时完整保留。
5. 数据库增加迁移版本记录；现有 entity 数据保留，新增 `profile_revision`、`template_revision`、`node_run`、`adapter_install`、`installation`、`artifact_lease` 实体。
6. 保留历史 workflow ID、run ID、事件 seq、审批和证据的原始哈希，并记录 `canonical_schema_version`。历史验证继续使用旧规范化算法，新 Run 使用 v2；不能因字段迁移重算哈希后还声称保留了旧审批。新建兼容模板和状态投影，不修改历史原始证据。历史 `opentabs` 标签在读模型中映射为 browser。
7. 有尚未完成任务时，旧状态及工作树保留原位置，并写入显式 `legacy_roots`；新任务使用新的安装数据根。不能通过直接复制文件夹破坏 Git worktree 的反向路径。
8. 新服务只读打开迁移结果，检查项目映射、任务数量、事件末序号、证据哈希、工作树与会话绑定，再提交迁移事务。
9. 安装新客户端集成并启动新服务。迁移完成后保留旧备份；旧服务不能与新服务同时写同一数据库。

旧正在等待人工验收/复核的任务按冻结材料继续，前提是配置与快照一致；正在执行时中断的任务进入恢复状态并创建新 Run，不能将旧进程描述伪装成可恢复会话。

### 11.2 升级与回滚

升级先下载和验证新版本，再进入维护模式。活动 Run 排空、SQLite 一致性备份、新版本健康检查通过后，原子更新 `current.json`。服务版本、MCP 协议和配置 schema 的兼容关系写入发布清单；不兼容升级要求桥接器重连，给现有客户端返回明确重连提示。

版本目录与原生二进制按版本并存。Windows 正在运行的 Node、Go Host、SQLite 扩展不原地覆盖；通过引用计数/租约决定何时清理旧版本。客户端路径更新也是安装事务的一部分。

健康检查失败且新版本尚未接受业务写入时，自动恢复旧指针和备份。新版本已经产生业务数据后，回滚先导出新增事件与配置并进行版本兼容检查；如果 schema 不能被旧版读取，固定拒绝直接降级并保留数据，进入修复升级。不能为回滚静默丢弃新任务。

保留最近两个完整安装版本；数据库与证据备份按显式保留策略处理。卸载默认删除受管程序与集成配置，保留业务项目、worktree、数据库和证据。删除这些数据需要用户明确选择“同时删除 DevFlow 数据”，并显示所有解析后的目标路径。共享 Git、用户原装 CLI 和浏览器不随卸载删除。

## 12. 完全开源与发布规则

### 12.1 开源范围

根目录增加标准 `LICENSE`（Apache-2.0）、`NOTICE`、`README.md`、`CONTRIBUTING.md`、`SECURITY.md`。README 是开源仓库标准入口，其余设计、指南与测试材料仍放在 `docs`。

Apache-2.0 覆盖 DevFlow 自有代码、网页、适配器、Skill、安装器、模板和测试。第三方运行时、CLI、Git 与浏览器保留各自许可；闭源厂商工具由用户通过官方来源安装，平台不重新授权或公开其私有代码。平台不设置不开源的核心服务、私有授权接口或必须使用开发者账号的组件。[Apache-2.0 正文](https://www.apache.org/licenses/LICENSE-2.0)

维护者账号仅用于将源码和 GitHub Release 发布到 `zephyrw/dev-flow`。使用者可 fork 后自行构建、修改和发布；`release.repository` 从构建仓库的 GitHub owner/repo 自动生成，bootstrap 的安装源可由显式参数覆盖，不能将安装后运行依赖永久绑定维护者仓库。

### 12.2 公开源码导出

P00 建立公开导出白名单，包含全部实际源码、构建配置、依赖锁、所有 Skill、合成测试夹具及所需文档；从当前完整工作区快照生成发布源码。导出后执行构建和测试，确保没有遗漏“只存在本机”的必要脚本。

下列本机内容不进入公开产物：运行数据、模型凭据、真实业务材料、个人截图、原始会话日志、用户配置、缓存、私有绝对路径。现有真实联调材料保留本地，公开测试报告以合成工程重新生成，记录方法与结果而不泄漏原始材料。

对导出内容和拟发布历史执行密钥与路径扫描；发现疑似凭据先验证并清理，已经暴露的真实凭据先撤销。首次公开采用新仓库的干净公开初始快照，不推送本机旧历史。若用户提供的远端已有提交，新增正常提交保留远端历史，不执行强推；远端是否存在/是否可读由 P00 用维护者 GitHub 身份核实。

本次匿名浏览未取得该仓库页面，不能据此断言仓库不存在或已公开。实施动作固定为：检查已有仓库；不存在则创建同名公开仓库；为私有仓库则在内容检查通过后转公开；已有公共仓库则保留其历史继续发布。目标仓库名称没有留作后续选择。

### 12.3 发布产物

tag 固定以 `vMAJOR.MINOR.PATCH` 命名，第一版为 `v1.0.0`。每次 release 同时产生：

```text
install.ps1
install.sh
release.json
components.lock.json
SHA256SUMS
devflow-<version>-windows-x64.zip
devflow-<version>-windows-arm64.zip
devflow-<version>-darwin-x64.tar.gz
devflow-<version>-darwin-arm64.tar.gz
devflow-<version>-linux-x64.tar.gz
devflow-<version>-linux-arm64.tar.gz
devflow-<version>-source.tar.gz
devflow-<version>-dependency-sources.tar.gz
sbom.cdx.json
THIRD_PARTY_NOTICES.txt
compatibility.json
```

`release.json` 包含源码 commit、构建工具链版本、六种目标的 URL/字节数/SHA、schema 版本、组件锁哈希和兼容性证据索引。构建 attestation 绑定同一 commit。缺任意目标或要求的兼容性结果，不更新 stable/latest 安装入口。

公开 PR CI 不运行真实付费模型，也不能访问维护者凭据。真实 CLI 认证在受保护的兼容测试流程运行，日志先脱敏，再发布版本和结果摘要。README 同时展示平台安装状态与各适配器版本支持状态，不用一个总绿勾覆盖全部兼容性。

## 13. 可直接分配的实施工作包

1.4补充：P12（代码输入与主工作区合并）放在P11后、P08前。当前完整顺序为P00→P01→P02→P03→P04→P05→P06→P07→P11→P12→P08→P09→P10。后文1.3中P11直接进入P08的流程由本顺序取代。

1.3 在同一个任务中加入 P11（任务组合与执行交互），执行位置为 P07 之后、P08 之前；P08～P10 的交付必须包含它。新增细项与原细项共用一份合同、开发进度和测试进度，完整依赖以第 16.10 节和结构化合同为准。

工作包按下表依次合并。每个工作包均提交源码、对应测试、文档及验收证据；前置项未完成时不能以 UI 截图代替运行能力。扩展八工具及单工具完整闭环后，整体估算为 90 个工程人日，按一名熟悉现有仓库的开发者全职执行约 18 周；这是工作量预算，不是已验证的交付耗时。

| 编号 | 工作包 | 人日 | 前置 |
|---|---|---:|---|

| P00 | 完整基线、公开导出与组件锁 | 3 | 无 |
| P01 | v2 合同、四角色、单工具约束与适配器 SDK | 6 | P00 |
| P02 | Go 跨平台宿主与平台目录 | 8 | P01 |
| P03 | 通用 Agent 调度、事件和证据 | 7 | P02 |
| P04 | 八种 CLI 全角色认证与原有流程迁移 | 18 | P03 |
| P05 | 七 Skill 与八客户端集成安装 | 8 | P04 |
| P06 | 模板引擎、测试角色和配置切换 | 8 | P05 |
| P07 | 工具网关与浏览器 Provider | 6 | P06 |
| P08 | 六平台发布包和一键安装器 | 10 | P07 |
| P09 | 数据迁移、控制台、八工具完整验收 | 12 | P08 |
| P10 | 开源材料、正式发布与干净机器验证 | 4 | P09 |
| 合计 | 完整 1.0.0 交付 | 90 | 全部必需验收通过 |

### P00：建立可重复基线

实施项：

1. 记录当前 HEAD、工作区差异和未跟踪文件清单，确认正在修改的 UI、进度与运行修复进入实施基线；创建 `zxw/devflow-portable-platform` 分支，保留既有改动。
2. 执行当前 `npm run check`、已有 E2E，归档真实结果；已有失败先归因并固定重现，不能把它们当成新架构回归。
3. 新增 `scripts/release/export-source.mjs`，输出完整可构建源码白名单和内容 manifest，排除本机材料。
4. 创建 `build/toolchains.lock.json`：Node 22.23.2、当前精确 JS 锁文件、Go 1.26 的官方最新稳定补丁及 SHA；同时把 Git 官方最新稳定版本、源码校验和写入组件锁。解析结果必须提交，后续 CI 不动态升级。
5. 用 GitHub 身份核实指定仓库，按第 12.2 节准备公开仓库；该阶段不上传真实运行数据。

完成判据：另一个干净目录仅使用导出的源码就能复现基线构建；公共材料扫描无真实密钥和个人业务材料；生成的锁文件没有浮动版本字段。

### P01：合同与 Profile

修改 `packages/contracts`、新增 `packages/profiles`、`packages/adapters/sdk`：

1. 实现 v2 schema、Profile revision、planner/implementer/tester/reviewer 绑定、single-tool/composed 约束、能力描述与 `ResolvedProfile`。
2. 运行记录增加 `adapter_id/version`、`executable_fingerprint`、`requested_model`、`reported_model`、`profile_hash`、`toolset_hash`、`template_hash`。
3. 将 `Run.adapter` 从固定 union 改为注册 ID；将模型固定 literal 全部移出核心。
4. 实现 Profile 的原生配置白名单解析、显式模型、错误码、模型证据等级。
5. 实现适配器 fixture runner 和假 Agent 程序，不调用付费模型。

完成判据：三种不同 Profile 可以读写、冻结和比较；未知参数被拒绝；无实际模型报告时 UI 数据不伪造；核心代码不 import 厂商适配器内部文件。

### P02：平台宿主

新增 `host/devflow-host`，修改 `packages/process`、`packages/platform`、`packages/service`：

1. 实现带协议版本的 Host 通信，Windows Job 与 Mutex 行为逐项对齐旧 C# Host。
2. 实现 macOS/Linux 进程组、flock、控制管道 EOF、分阶段终止和启动身份校验。
3. 所有进程生命周期和锁调用改走 Host；删除运行时强制 `win32`。
4. 实现规范化目录、平台环境、原生 executable/npm bin 解析、打开默认浏览器和稳定 bootstrap。
5. 将 `recordController`、`reconcileProcesses` 改为跨平台身份合同。

完成判据：六平台原生测试均通过父子孙进程退出、双控制器竞争、崩溃恢复、PID 复用保护、中文和空格路径。旧 C# Host 仅在迁移测试中保留，正式发布包不依赖 .NET。

### P03：通用运行器

重构 `packages/runtime/src/runtime.ts`、`engine.ts`、bridge 和事件层：

1. runtime 只处理 Run 生命周期、权限、证据和宿主，不拼厂商 CLI 参数。
2. 八种正式 CLI 的流式解析器输出统一事件；公共 JSONL 解码覆盖截断 UTF-8、超大行、重复终态及异常 stderr。
3. 实现通用完成/测试/复核 MCP 工具，测试执行回传和结构化结果校验。
4. 普通程序驱动执行完成事件，取消发起 Agent 对长任务的监控职责。
5. 适配器崩溃、协议失败和 token 撤销全部进入一致的失败/停止路径。

完成判据：假 Agent 与已有 agy 可以用同一引擎执行；模型输出“成功”但缺失服务端证据时任务不能完成；停止后迟到事件不能改变任务结果。


### P04：八工具认证

实现 `codex / agy / grok-build / claude-code / kimi-code / qoder / opencode / cursor-agent` 八个正式适配器：

1. 按第 5.2 节分别实现非交互、模型继承与指定、会话、事件解析、专用 MCP、权限限制和完整终态判断。
2. 实现明确 ID 恢复：Codex、Antigravity、Grok、Claude、OpenCode、Cursor；Kimi 与 Qoder 的首发跨节点固定新会话交接。恢复探针失败时引擎仅能创建新会话，不猜最近 session。
3. 实现每种工具的四角色；tester 必须发起实际测试并读报告，reviewer 必须在新会话只读复核。
4. 核实官方安装来源，锁定精确版本、每目标产物、CPU、hash、原生配置隔离方式，生成 `registry/components` 和 `compatibility.json`。
5. 对每工具执行真实计划提交、最小代码修改、测试失败诊断与修复、测试通过、只读复核、停止、模型错误和权限拒绝测试。
6. 替换 Cursor 占位目录；添加 OpenCode placeholder、Cursor 编辑器误识别、Qoder 旧别名、Antigravity 项目及 conversation 错配夹具。

文件交付按适配器固定为 `src/index.ts`、`invocation.ts`、`events.ts`、`profile.ts`、`permissions.ts`、`fixtures/`，客户端安装位于 `packages/clients/<id>`；不得把差异放回核心 switch。

完成判据：八种工具在 Windows x64、macOS x64、macOS arm64、Linux x64 均能单独承担四角色；每项有真实版本和证据。额外 ARM 格子只按已认证官方支持开放，Qoder/Windows arm64 明确排除。任意必需工具格子失败则不得发布“八工具支持”，由本工作包修复；不能减少需求或让最终用户研究参数。

### P05：Skill 和入口

修改七个 Skill，新增 compiler 和八个 ClientInstaller：

1. 去除 Windows、固定模型、CODEX 专有会话环境及固定浏览器的流程指令，新增 devflow-test。
2. 将相对引用、平台扩展元数据和 agy 平面 Skill 编译规则显式化。
3. 安装 MCP 与全部引用文件，实现哈希清单、备份、冲突检查和卸载。
4. 检查同名历史 `.codex/skills` 与新目录；只自动迁移明确由旧 DevFlow 安装管理的副本，避免重复触发。
5. 给通用入口加入 client namespace，保留工作流 ID 和幂等键语义。

完成判据：八客户端新会话能发现七 Skill 并完成 MCP 往返，包含 Antigravity plugin 的加载与触发；重复安装无重复项；用户其他 Skill/MCP 字段保持原值；升级后旧引用不残留。

### P06：流程模板和切换

新增模板 schema、DAG 编译器、NodeRun 调度与 reconfigure：

1. 保留旧任务 `checked-development@1`；新建含 tester 的 `checked-development@2`，支持单工具和组合绑定。
2. 将现有状态转换分解为节点动作和总状态投影。
3. 实现 test-prepare / snapshot / test-verify 与 checks 回传、失败修复轮次、分支条件、join、显式审批和资源冲突检查。
4. 实现新任务默认、旧任务冻结、停止并切换及交接包。
5. 实现变更对下游快照、证据、验收和复核的失效传播。

完成判据：修改节点顺序、角色、审批点和工具集合都只修改模板；旧模板实例继续可恢复；跨工具切换不复用私有 session；修改代码后旧证据不能继续通过。

### P07：辅助工具和浏览器

1. 将 BrowserGateway 拆为 Provider 和通用调度网关。
2. 交付 Playwright、OpenTabs 两个 Provider，迁移旧场景并规范 `browser` 测试层。
3. 交付 MCP stdio/HTTP 注册、schema 哈希、Toolset 权限与凭据引用。
4. 实现 browser/command/MCP 资源生命周期与日志脱敏。
5. 用合成页面跑完自动验收与人工接管回环。

完成判据：没有 OpenTabs 的机器能够完成默认流程；已连接 OpenTabs 能执行迁移场景；注册新标准 MCP 不改核心；浏览器切换后重新获取其验收证据。

### P08：一键安装与发行包

1. 产出六平台 Node+API+Web+Host+SQLite 发布包，构建与附带 Git runtime。
2. 实现 `install.ps1/install.sh`、组件安装闭包、私有运行时、下载校验、可恢复安装日志。
3. 实现安装网页，默认 single-tool，按启用入口和角色计算依赖闭包；生成四角色 Profile、官方授权交接、八客户端 CLI/Skill/MCP 安装。
4. 实现无 GUI 安装配置输入、退出码和重新运行幂等性。
5. 源码安装使用相同组件锁和安装事务，构建结果也写安装 manifest。

完成判据：六平台无预装 Node/npm/.NET/Go、无任何 AI CLI 的干净环境均能启动安装并完成平台检查；模型授权状态单独显示；两次安装结果一致；下载中断恢复不损坏原安装。

### P09：迁移和联合验收

1. 实现第 11 节配置/数据迁移、版本化升级和回滚。
2. 完成第 10 节六个控制台页面及所有配置差异展示。
3. 使用 0.2.0 脱敏数据库夹具验证项目、历史任务、审批、事件和工作树引用迁移。
4. 执行第 14 节完整测试矩阵，归档每条要求的证据。
5. 逐项消除受管接口与实际权限、安装成功与组件可用、工具报告与真实测试之间的误判。

完成判据：全部验收条目有当前源码 commit 的证据；八种单工具闭环与 Kimi 发起 / Claude 实施及测试 / Kimi 复核闭环完成；当前旧工作流可迁移，历史证据可读且不被重写。

### P10：开源正式发布

1. 完成 LICENSE/NOTICE/依赖源码/SBOM/贡献指南/安全报告入口/README。
2. 在公开源码导出目录再次执行构建和测试，校验源码产物与二进制 provenance。
3. 发布 `v1.0.0` 的完整资产与兼容性清单，再验证两条公开一行安装命令。
4. 在新的 Windows 和 macOS 环境从公开地址分别选择八工具安装；每次环境只保留所选一种 AI CLI，使用独立于开发者的账号验证授权、Skill 触发与单工具闭环。
5. 更新 README 的安装与支持矩阵，记录版本、平台、已验证工具版本和已知明确限制。

完成判据：陌生用户无需开发者机器、配置文件、私有账号或私有包，即可从公开仓库构建并从一行命令安装。发布资料里没有只在本机存在的必要依赖。

## 14. 验收矩阵与阻断条件

### 14.1 平台测试

六个目标都运行单元、集成、宿主、安装、SQLite 和默认浏览器测试。原生运行测试必须有相同 CPU 架构的 runner；交叉编译产物存在不算运行通过。macOS arm64 结果不代替 Intel Mac，Windows Server runner 不单独代替 Windows 11 的最终用户安装验收。

GitHub Actions 承担公开构建及可用的原生矩阵；Windows 11 客户端行为在其原生验收机/VM 上执行同一脚本。由平台测试配方自动创建一次性工作目录，使用合成项目；不会上传本机业务数据。P00 登记 runner 与目标映射，P10 发布必须检查六目标证据完整。

### 14.2 功能验收清单

| ID | 场景 | 通过条件 |
|---|---|---|
| AC-01 | 干净安装 | 六目标无预装开发运行时，安装命令完成平台和所选 CLI/Skill/MCP 安装 |
| AC-02 | 未授权账号 | 平台已安装，组件明确显示需授权；授权后继续原安装，不重新下载 |
| AC-03 | 重复安装 | 连续执行两次无重复 MCP/Skill、无额外服务，无原生模型配置丢失 |
| AC-04 | 已有客户端 | 复用认证版本；与用户现有配置合并而非整文件覆盖 |
| AC-05 | Skill 完整性 | 七个 Skill 正文、引用文件和客户端扩展元信息齐全且路径有效 |
| AC-06 | Skill 真实触发 | 八客户端新会话自然语言触发入口、七 Skill 正确加载，返回有效工作流 ID；包含 Antigravity 原生 plugin 触发 |
| AC-07 | Kimi 发起 Claude 实施 | Kimi 中规划，Claude 原生配置模型实施与测试，Kimi 新会话复核 |
| AC-08 | 原有组合 | Codex 发起、agy 原指定模型实施、Codex 原指定模型复核保持有效 |
| AC-09 | 单工具基本合同 | 所有 AI 节点只引用一个 adapter；安装依赖只有该 CLI；四角色与模板完成条件完整有效 |
| AC-10 | 任意注册 Profile | 新 Profile 在 UI 绑定，核心无代码修改；不支持参数在保存前拒绝 |
| AC-11 | 显式模型 | 用户指定 ID 被原样传递；无效 ID 明确失败，不自动回退 |
| AC-12 | 自定义 Claude 连接 | 继承用户已验证的 provider/endpoint/model 与鉴权；隔离权限后仍能调用 |
| AC-13 | 实际模型未知 | 工具未报告时 UI 诚实显示，不能用 requestedModel 冒充 reportedModel |
| AC-14 | 运行中换工具 | 旧 Run 停止且资源清理；新 Run 使用新工具并重新验证，没有共享私有 session |
| AC-15 | 旧任务冻结 | 修改全局设置不影响已有任务；显式应用新版本才创建变更记录 |
| AC-16 | 模板可编排 | 调整顺序、节点、角色、审批点、条件和 Toolset 无需修改引擎 |
| AC-17 | 模板非法结构 | 环、不可达节点、类型错误、非法并行写与缺少能力均无法发布 |
| AC-18 | 超限修复 | 第 3 次修复仍失败后停下，保留错误和证据，不无限调用模型 |
| AC-19 | 正式测试证据 | Agent 说成功/exit=0 但测试缺失、截断或哈希错误时不可通过 |
| AC-20 | 证据失效 | 快照、Run、模板、Toolset 或必需前序输入变化，相关下游结果失效 |
| AC-21 | 权限边界 | 八 Agent 不能调用原生越权工具、审批自己或操作其他工作流 |
| AC-22 | 无 OpenTabs | 默认 Playwright 场景和人工接管完成，全部截图与断言绑定当前 Run |
| AC-23 | OpenTabs 连接 | 未加载扩展时准确报告；连接后运行旧场景，不关闭无关标签页 |
| AC-24 | MCP 更换 | 切换标准 MCP 服务无需修改核心；schema 漂移触发重新验证 |
| AC-25 | 中文/空格路径 | 安装根、用户目录、仓库目录包含中文和空格时全流程通过 |
| AC-26 | 进程停止 | 父子孙进程、控制器崩溃、重复停止与超时停止均不提前释放租约 |
| AC-27 | PID 复用 | 身份不匹配时拒绝 kill，不结束无关进程 |
| AC-28 | 锁与并发 | 双启动只有一个控制器；三个 worktree 不串端口/证据/浏览器标签页 |
| AC-29 | 安装故障 | 下载中断、错误 SHA、解压越界、磁盘不足、配置并发修改均可恢复且不损坏旧版 |
| AC-30 | 升级回滚 | 活跃版本不原地覆盖；发布前失败恢复；产生新数据后不静默降级丢数据 |
| AC-31 | 旧数据迁移 | 任务数量、事件序号、ID、审批、证据哈希与工作树关联保持一致 |
| AC-32 | 卸载 | 默认保留用户数据；删除配置只触及 DevFlow 管理且未被用户改写的项 |
| AC-33 | 密钥处理 | 日志、导出、MCP 配置展示和项目测试环境没有模型密钥 |
| AC-34 | GUI 启动环境 | macOS GUI 的最小 PATH 与 Windows npm shim 环境下均能定位实际程序 |
| AC-35 | 公开源码构建 | 独立目录从公开源码与锁文件构建成功，无开发者本机路径依赖 |
| AC-36 | 公开命令安装 | 两条 GitHub 安装命令使用同一稳定 release，下载、授权、集成和开启任务闭环通过 |

| ID | 场景 | 通过条件 |
|---|---|---|
| AC-37 | Codex 单工具闭环 | 只装 Codex CLI，完成方案、实施、失败测试修复、真实测试和新会话复核 |
| AC-38 | Antigravity 单工具闭环 | 只装 Antigravity CLI（agy），完成方案、实施、失败测试修复、真实测试和新会话复核，无其他 AI CLI 依赖 |
| AC-39 | Grok 单工具闭环 | 只装官方 Grok Build，调用 grok，完成相同四角色流程 |
| AC-40 | Claude 单工具闭环 | 只装 Claude Code，继承已配置模型，完成相同四角色流程 |
| AC-41 | Kimi 单工具闭环 | 只装当前 Kimi Code，完成相同四角色流程，无其他 AI CLI 依赖 |
| AC-42 | Qoder 单工具闭环 | 只装 Qoder CLI，完成相同四角色流程；工具身份与协议正确 |
| AC-43 | OpenCode 单工具闭环 | 只装 OpenCode，provider/model 正确，完成相同四角色流程 |
| AC-44 | Cursor 单工具闭环 | 只装 Cursor Agent CLI，可无编辑器；完成相同四角色流程 |
| AC-45 | 单工具约束 | 模板新增角色仍受单 adapter 约束；跨工具绑定要求显式保存 composed |
| AC-46 | 同工具不同模型 | 四角色使用同一 CLI 下不同可用模型，保持 single-tool；每节点保存各自模型证据 |
| AC-47 | 测试责任真实执行 | tester 发起受管命令并读取原始报告；没有报告、伪造 passed、零执行均拒绝 |
| AC-48 | 测试阶段隔离 | prepare 后冻结；verify 禁止写入；修复重新快照并使旧报告失效 |
| AC-49 | 原生入口发现 | OpenCode 文本占位入口判失败，正确平台原生文件可用；Cursor 编辑器不冒充 agent |
| AC-50 | 模式转换与工具切换 | 单工具改组合、组合改单工具均校验全节点绑定；活动 Run 按停止边界切换 |
| AC-51 | 事件协议隔离 | Grok streaming-json、OpenCode json、各工具 stream-json 分别解析；未知终态不判成功 |
| AC-52 | Skill 共享目录 | 共享目录按路径和内容去重、引用计数卸载；同名用户修改不被覆盖 |
| AC-53 | 跨工具交接 | 八工具循环组合均成功，handoff 只含平台材料，无私有会话穿越 |
| AC-54 | 配置隔离与原生鉴权 | 原生模型连接保留，专用配置来源可证明；原生 hooks/MCP/权限不随模型设置导入 |
| AC-55 | 上游架构不支持 | Qoder/Windows arm64 返回 UNSUPPORTED_UPSTREAM；不下载错误 CPU 包，不换工具，不计成功 |
| AC-56 | 版本漂移与安装分层 | 区分 discovered/launchable/authenticated/mcp-ready/skill-ready/workflow-ready；更新改变指纹后重新验证 |

AC-37～AC-44 在 Windows x64、macOS x64、macOS arm64、Linux x64 分别执行，共 32 个强制真实单工具闭环；每格用仅安装该 AI CLI 的一次性环境。平台普通运行时、Git、MCP 服务与测试程序不计入 AI CLI 数量。Windows arm64、Linux arm64 按认证的原生工具格子运行同样场景，明确排除项单独展示。Antigravity 完整执行 AC-38，并额外覆盖原有组合 AC-08；两项分别保存单工具与迁移证据。

跨工具矩阵固定生成：工具顺序为 `codex, agy, grok-build, claude-code, kimi-code, qoder, opencode, cursor-agent`；对 i=0…7，入口/planner 使用 i，implementer 使用 (i+1)%8，tester 使用 (i+2)%8，reviewer 使用 (i+3)%8，共 8 组，每工具覆盖四角色及交接。另保留 AC-07 的 Kimi→Claude→Kimi 和 AC-08 的旧组合。循环组合在 Windows x64 与 macOS arm64 完整执行；平台与协议 fixture 在六目标执行。这是固定覆盖合同，不用单一混合用例代替全部工具验证。

合成项目固定包含：可观察 UI 修改、一个预置失败用例、待实现逻辑、一条单元测试、一条 HTTP 集成测试、一个 Playwright 浏览器断言；应用使用私有 Node，不依赖业务数据库。验收要求提交方案、实施变化、tester 看见红色报告并触发修复、最终测试报告、人工确认后新会话复核。仅让模型输出一句话不算闭环。

### 14.3 证据文件

每次验收保存：源码 commit/工作树哈希、平台/CPU、组件版本/哈希、配置快照哈希、命令与退出码、脱敏事件、原始测试报告哈希、前后代码快照、安装事务 ID、人工确认记录。

`docs/test/跨平台验收矩阵.json` 按 `AC ID + target + adapter/version + execution mode + role/combination` 保存状态：`not_run / passed / failed / blocked / unsupported_upstream`。`not_run`、`blocked`、`unsupported_upstream` 不能进入成功统计。`unsupported_upstream` 只允许第 1 节定义的额外架构格子，不能用来豁免八工具在四个必需目标上的失败。正式发布要求全部必需格子为当前发布 commit 的 `passed`；修改相关代码后清除对应格子的历史通过状态。

真实日志与可公开摘要分离：私密材料留在本地或受控证据存储，公共仓库只包含合成材料和脱敏摘要。隐私处理不能让证据变成不可核对的手工结论。

## 15. 实施中必须保持的判断

1. **先解耦合同，再扩工具。** 只把模型 literal 改成 string 不能完成通用化。
2. **入口与执行分离，单工具同样完整。** Kimi 中调用 DevFlow MCP，由服务启动 Claude；不依赖 Kimi 内部支持“委派给 Claude”的私有功能。
3. **七个 Skill 是交付物。** 每个平台包与安装事务都包含它；文件存在、客户端加载、真实触发分别验证。
4. **安装便利不等于授权自动化。** 新机器必须使用用户自己的厂商账号，平台不携带开发者登录态。
5. **状态与证据由平台管理。** 工具切换、重试、恢复和模板调整不能绕过证据真实性。
6. **保持一套核心。** Windows/macOS/Linux 差异留在宿主、路径和安装配方；不创建三套业务工作流。
7. **发布能力以实际矩阵为准。** 本方案给出完整目标、实现责任和失败处理，不提前将尚未执行的跨平台测试写成成功。

最终交付标准：用户从 `zephyrw/dev-flow` 获取全部可构建源码，用一行命令安装，从八种工具中选择一种完成方案、实施、测试和复核，也能逐角色组合工具与模型；平台按实际依赖完成组件、MCP 和七个 Skill 集成。用户以后修改角色、工具、模型或流程模板，通过配置即可完成，已有任务按明确的版本和恢复规则继续。

## 16. 任务级工具模型组合、执行调整与临时提问（1.3 新增）

### 16.1 确定的产品行为与范围

本节属于同一个“DevFlow v1.0 跨平台与八工具通用平台完整开发”任务，工作流 ID 为 `wf-508be4f4-4c5a-453c-9ac6-c6dafe717a08`。与第 1～15 节共同构成 1.3 完整开发范围；不建立第二个实施任务，不缩减原 58 项细项、八工具、六目标产物、七 Skill 或真实验收范围。

用户所说的“任务”是工作台里的独立业务工作流 Workflow；开发清单里的细项称为 LeafTask。两者分开编号。每个 Workflow 可选择自己的工具与模型组合；同一 Workflow 还支持按 LeafTask 覆盖实施、测试绑定。跨阶段规划与独立复核仍由 Workflow 的角色绑定决定，避免把一个细项误当成全流程。

| 用户操作 | 确定行为 | 验收编号 |
|---|---|---|
| 任务 A 只用 agy | planner、implementer、tester、reviewer 均使用 agy；可用同一或不同已验证模型；复核新会话且只读 | AC-57 |
| 任务 B 用 Kimi 规划、Cursor 执行 | planner 绑定 kimi-code；implementer 绑定 cursor-agent；未单独指定时 tester 继承 implementer，reviewer 继承 planner；保存前展示四角色最终值 | AC-58 |
| 任务 C 使用 OpenCode 不同模型 | 模型保存完整 provider/model ID，不能丢失 provider 后按名字猜测 | AC-59 |
| 给某一开发细项换工具/模型 | 只覆盖该细项及其明确绑定的测试子执行；总任务审批、范围和证据仍统一管理 | AC-60 |
| 实施中增加要求 | “调整执行”展示正式指令、文档差异和受影响细项；旧运行停止后交给新运行 | AC-61～AC-66 |
| 实施中问一个临时问题 | “临时提问”独立回答，不中断主执行，不追加主会话或主任务记录 | AC-67～AC-70 |

“Kimi Code + Cursor 中的 Grok 4.6”只是用户说明组合方式的例子，不是默认配置或指定采购范围；`grok-build` 与 `cursor-agent + 某 Grok 模型` 是不同工具路径。只有当前 Cursor Agent CLI/账号确实可选并通过探针的模型才能标记可运行；编辑器模型列表不自动视为 CLI 能力。

### 16.2 现状、目标与修改边界

```mermaid
flowchart LR
  Global[现状 全局固定模型] --> Engine[核心选择 agy 或 Codex]
  Engine --> Run[执行轮次]
  Docs[磁盘设计文档变化] -.无版本交接.-> Run
  Stop[已有停止与恢复] --> Run
  Missing[缺少任务组合及临时问答合同] --> Gap[不能可靠表达执行改向]
```

结论：已有 stop/recovery、FileBroker、细项进度、快照和证据失效机制可以复用；不能只增加输入框或向 stdin 发送一句“读最新文档”。证据位置：`packages/contracts/src/config.ts`、`packages/contracts/src/index.ts`、`packages/core/src/engine.ts`、`packages/runtime/src/runtime.ts`、`packages/entry/src/intake.ts`。1.3调研时工作区HEAD为b933cfb；1.4已按用户选择将本任务代码基线更新为`6eb47cca18dc65397aab125e96eb329cecc344d2`（主工作区已提交版本），不带入其他进行中的未提交修改；原始基线仅保留为历史。

```mermaid
flowchart TB
  UI[工作台自然语言入口和任务详情] --> Composer[任务组合与模型选择]
  UI --> Change[调整执行]
  UI --> Aside[临时提问]
  Composer --> Contract[批准的任务配置快照]
  Change --> Bundle[文档版本和变更包]
  Bundle --> Control[停止 交接 确认 后继续]
  Contract --> Control
  Control --> SDK[现有八工具 SDK 和 Host]
  Aside --> Context[已发布上下文的只读副本]
  Context --> Isolated[同工具同模型 独立临时运行]
  Isolated --> Answer[仅临时问答面板]
  Control --> Main[正式进度和测试证据]
```

结论：P01/P03/P06 的通用能力继续作为唯一基础，P11 在同一任务内增加任务配置、文档交接、控制命令与临时问答；P08 安装打包、P09 验收及 P10 交付统一包含 P11，不能先将缺少本节的版本标记为完整 1.0。

### 16.3 任务组合的冻结、继承与切换

新增 `WorkflowExecutionSpec`，字段固定为：`revision`、`mode`、`template_id/revision/hash`、`role_bindings`、`leaf_bindings`、`resolved_profiles`、`policy_hash`、`created_from`、`hash`。所有 Profile 引用同时保存 `id + revision` 与不可变解析快照；任务恢复不重新解析全局“当前默认”。

解析顺序固定：创建表单的显式选择覆盖所选组合模板，模板覆盖项目默认，项目默认覆盖安装默认；四角色补齐后一次性冻结。已创建任务不再动态继承上层。LeafTask 覆盖的优先级高于 Workflow 对应 implementer/tester；不允许叶子覆盖 planner、reviewer 或审批点。模板/全局 Profile 的后续编辑只影响未来创建的任务。

```json
{
  "schema_version": 1,
  "mode": "composed",
  "role_bindings": {
    "planner": {"profile_id": "user-kimi-planner", "profile_revision": 3},
    "implementer": {"profile_id": "user-cursor-implementer", "profile_revision": 2},
    "tester": {"profile_id": "user-cursor-implementer", "profile_revision": 2},
    "reviewer": {"profile_id": "user-kimi-planner", "profile_revision": 3}
  },
  "leaf_bindings": {},
  "created_from": "explicit-task-selection"
}
```

以上是结构示例，Profile 名称由用户创建，不预置虚假的账号或模型 ID。UI 逐行展示“阶段 → 平台/工具 → 模型 → 参数 → 可用状态”，保存前补齐实际 ID。所有启用角色、自定义 AI 节点、叶子绑定、临时问答都纳入 `single-tool` 校验；跨工具时用户在同一次保存中明确切换到 composed。单工具不等于单会话，测试和只读复核仍保留独立的角色权限。

模型选择复用第 4.4 节：缓存按 tool installation fingerprint、账号引用、provider/config fingerprint 分区，缓存最长 10 分钟；保存和启动时重新核对版本/配置指纹，失败显示具体原因。发现列表只证明“列出”，不能证明鉴权成功。显式模型验证失败返回 `MODEL_UNAVAILABLE`，不回退到 auto/default；报告模型与指定 ID 明确冲突返回 `MODEL_MISMATCH`。原生继承若不能解析精确模型，显示“继承原生配置，实际模型未报告”，不得冒充指定模型。

每个 NodeRun 冻结 tool installation、adapter/version、requested/reported model、Profile、角色、leaf ID、execution spec、plan revision、document bundle、instruction sequence、workspace 与权限哈希。若 tester 一次覆盖多个绑定不同的细项，按测试所声明的目标 Profile 分组为独立子执行；每个测试仅有一个明确负责的 tester，不能从多个细项任意选择。

修改尚未执行的绑定也生成 spec 新版本，已批准计划的绑定变化需重新展示并批准。活动执行中的任何平台/模型切换统一走“调整执行”，终止旧运行后启动新会话，禁止原地篡改正在运行的 Profile。历史节点和证据保留原绑定；未来节点使用新版本。成本和模型报告归属具体运行，不能整项任务只显示最后一次模型。

### 16.4 三文档的权威来源与版本包

`DocumentBundle` 包含三类材料：设计/实施合同、开发进度、测试定义与进度。平台保存每个文件的 repo ID、规范化相对路径、内容哈希、字节数、不可变内容引用、版本、生成来源；整包保存 `bundle_id/hash`、`plan_revision`、`progress_event_seq`、`test_definition_hash`、`snapshot_id` 和 `created_at`。

权威关系固定：已批准计划及冻结的设计文档定义“要做什么”；平台细项状态和当前证据定义“实际做到哪一步”；测试合同定义“需要验证什么”；原始测试报告和平台验收定义“是否通过”。用户编辑进度文档不能把未完成项变成已完成，编辑测试文档里的 passed 字样不能生成证据。识别这种编辑时保留其作为变更建议，并在预览中显示“文字状态与平台记录不一致”。

设计文件变化不自动获得执行授权。文件监听器只提示“检测到设计变化”，不自动改向；平台自己刷新进度/测试结果属于投影更新，不触发设计变更循环。采用文件来源和内容哈希识别，不能仅依赖文件名或 mtime。用户点击“同步文档”或在自然语言入口指定更新后，服务从绑定 worktree 读取选定路径，生成旧批准版本到当前稳定版本的逐文件 diff，覆盖新增、删除、重命名、需求编号、细项和测试定义变化。

读文件前后检查大小和哈希；连续两次读取不一致返回 `DOCUMENT_BUSY`，不打包半写入内容。拒绝跨仓路径、路径穿越与 symlink/junction 逃逸。每文档上限 2 MiB，整包 8 MiB；超出时在保存预览前列出文件和限制，不静默截断。模型上下文超限时使用服务分页读取，不只发送摘要。

`ChangeSet` 保存 `base_plan_revision/hash`、`target_bundle_hash`、全文差异引用、用户说明、受影响 requirement/task/test ID、取消与保留工作、spec 差异、范围差异。摘要是导航，完整批准正文和 diff 才是执行依据。新 Run 的启动上下文明确给出：新增什么、删除什么、哪些约束改变、已完成哪些工作仍有效、哪些必须返工、当前第一细项、必跑测试及三文档内容定位。

### 16.5 正式指令与立即改向协议

用户入口固定为“调整执行”。支持补充约束、设计已更新、调整平台/模型三种表单标签，它们最终都是正式 `ExecutionChange`。每次有 `change_id`、`idempotency_key`、`expected_workflow_version`、单调递增 `instruction_seq`、目标节点/细项与生效时机。默认“立即调整”；另一明确选项“当前细项结束后调整”只在用户主动选择时使用，不把普通聊天悄悄排到下一轮。

```mermaid
sequenceDiagram
  actor U as 用户
  participant UI as 调整执行入口
  participant C as 控制器
  participant O as 旧执行
  participant P as 规划角色
  participant N as 新执行
  U->>UI: 新指令并同步设计进度测试文档
  UI->>C: 生成有版本的变更预览
  C-->>UI: 差异 影响范围 需要的审批
  U->>C: 应用已展示的调整
  C->>C: 事务封锁旧写入并撤销旧令牌
  C->>O: 请求停止并核对进程树退出
  O-->>C: 停止确认与已落盘工作
  opt 需求 范围或测试合同改变
    C->>P: 原计划与变更包
    P-->>C: 完整新计划与细项测试差异
    C-->>U: 展示新计划并等待批准
    U->>C: 批准新版本
  end
  C->>N: 新运行 新令牌 当前计划及文档包
  N->>C: 读取完整变更并确认上下文哈希
  C->>C: 校验确认并开放批准范围内写入
  N-->>U: 按新方向继续实施
```

平台统一采用“中止旧轮次 → 新会话交接”，首发不依赖八工具是否支持热注入。日常无变化恢复仍按第 4.5 节使用已验证的精确会话 ID；发生正式改向一律新会话，减少旧指令残留。不同工具不能共享厂商私有会话，交接只通过 DevFlow 文档、工作区快照和结构化进度。

审批规则固定：纯执行约束且 requirement、scope、测试定义、审批策略、绑定均未改变时，服务可生成同计划修订下的正式指令预览；用户点击“应用调整”就是对该条明确内容的授权，不再重复弹窗。只要新增/删除需求、修改设计行为、测试标准、允许路径、依赖、工具绑定或权限，则必须由绑定的 planner 生成完整新计划并进入批准。不能用模型一句“这只是澄清”绕过结构差异检查；无法明确判为原范围内时采用新计划流程。用户输入“顺便做 X”不能只存聊天后直接执行。

停止算法：在工作流事务中 CAS 校验版本，保存变更与 outbox，递增 execution epoch、标记旧 Run 为 superseded、撤销写权限，再异步停止进程。FileBroker/ToolGateway/测试调度均以 epoch、run ID 和权限哈希校验；文件提交与封锁写入使用同一工作流临界区。已提交的完整文件修改保留；在途操作完成后进入 checkpoint，旧轮次不能再次提交。默认等待 5 秒，随后由 Host 终止已确认归属的进程树；无法确认退出则 `RECOVERY_REQUIRED`，仍占用写租约，不启动新写者。

旧轮次已经启动的测试/构建要等停止或完成并对账；已发生的外部副作用不能撤销，记录实际发生的动作，不宣称打断能回滚。临界的本地 commit 操作进入“提交后处理”并暂时拒绝新改向，返回 `COMMIT_IN_PROGRESS`，不在半提交事务中插入变更。COMMITTED 任务新增需求创建后续业务工作流，这是产品运行规则，不影响本次设计合并到原开发任务。

新执行初始只获得上下文读取权限。必须读完分页材料，并调用 `devflow_ack_context`，提交 `run_id/epoch/plan_hash/spec_hash/bundle_hash/instruction_seq`、受影响细项 ID 和下一步摘要。服务核对读取收据与哈希后才允许 FileBroker 写入；缺页或旧哈希返回 `CONTEXT_STALE`。ack 证明材料交付与身份匹配，不能证明模型理解完全正确，实际实现仍由测试和复核把关。连续 120 秒未确认时暂停该新运行并显示原因，不静默按旧计划继续。

```mermaid
stateDiagram-v2
  [*] --> Requested
  Requested --> StopRequested: CAS及旧权限撤销
  StopRequested --> Stopped: 进程树退出确认
  StopRequested --> RecoveryRequired: 停止无法确认
  RecoveryRequired --> Stopped: 恢复检查成功
  Stopped --> Replanning: 需求或合同改变
  Replanning --> ApprovalPending: 新计划完整
  ApprovalPending --> ContextPending: 用户批准
  Stopped --> ContextPending: 原范围内指令已授权
  ContextPending --> Applied: 新执行读取并确认
  ContextPending --> Failed: 模型或上下文校验失败
```

这是 ExecutionChange 自身的持久状态，Workflow 仍由第 6 节节点投影，不为每个工具复制状态机。前端分别显示“调整已保存”“旧执行已停止”“新计划待批准”“新执行已确认”“正在执行新指令”，仅写入 stdin 或发送成功不能显示“已生效”。

并发规则：同工作流一次只处理一个立即调整；用户可在新变更预览中明确合并尚未批准的请求，原请求保留 superseded 关系；不能丢弃中间正式指令。旧基线提交返回 409 `CHANGE_BASE_STALE` 并给最新版本，用户编辑内容保留。双击用相同幂等键返回同一 change；不同内容复用键报冲突。工作流 epoch 隔离迟到 tool/result/ack，迟到日志可标记旧轮次，但不能更新当前进度。

### 16.6 三文档、进度与测试如何随改向更新

新需求生成新 requirement ID、新 LeafTask 与测试 ID；删除项保存取消原因和 superseded_by，不复用旧 ID。正在执行细项在 checkpoint 标记 interrupted，已提交变更仍存在，不能假装该细项从未开始。涉及设计或绑定变化的细项及依赖后继置 needs_revalidation；未受影响项的实现证明仅在文件哈希、需求版本、权限和依赖证明完全一致时可保留，并显示其来源修订。

测试通过、人工验收和独立复核在任何正式改向时统一失效；先保留历史事实，再按新上下文重新 freeze 与运行批准测试。进度面板分别统计“实现完成”和“本轮测试通过”，不把旧绿色结果迁入新一轮。新增任务引起分母变化时显示“原 8 项，新增 2 项，当前 10 项”，不能将进度下降误显示为故障。

开发进度文档由事件投影生成，含运行绑定、当前计划/文档版本、进行中细项、变更列表、阻塞、下次执行入口；测试进度文档含本轮测试定义、实际报告、历史失效原因、尚未执行和失败项。CLI MCP 与网页读取同一投影。文档更新、Workflow 版本、变更单和派发 outbox 在事务中持久化，文件导出使用临时文件加原子替换；导出失败不丢数据库事实，重试不会创建第二次调整。

### 16.7 临时提问：同工具同模型，独立只读上下文

交互名称为“临时提问”，控制台独立输入框支持 `/btw <问题>` 别名；CLI 提供 `devflow btw --workflow <id>` 打开独立问答界面，再在该界面输入问题。八客户端 Skill 可以提供该入口链接，但问题和答案不得通过原执行模型的普通 MCP 调用或聊天消息传递，否则客户端会把工具结果写入主上下文。不拦截或假定各厂商原生 /btw 通用；所有问题均在独立UI连接上进入同一个aside服务。

主执行继续运行。aside 默认绑定提问瞬间的活动 implementer Profile 精确修订，在隔离的新会话中使用同工具和同模型；没有活动 implementer 时使用任务已冻结的 implementer，并标注所依据的最后快照。single-tool 任务不会为回答临时问题偷偷调用第二种工具。当前工具不支持并发时仅临时问题等待空闲，主执行不被暂停；同工具鉴权/模型失败则明确失败，不借用其他平台。

输入只含提问时已发布的计划/文档包、细项进度、已完成的可见消息、工具结果摘要和已完成 checkpoint 的文件摘要；不读取模型隐藏思维链，不复制正在流式写出的半条消息，不把持续变化的工作树称为一致快照。UI 显示“根据 XX 时刻已发布进度回答”；没有稳定工作区快照时仍可回答流程问题，涉及未确认代码则说明材料不足。

aside 没有文件、shell、浏览器、外部 MCP、主会话发送、任务完成或状态修改工具，不能写文档或触发测试。只使用提供的上下文回答；实现中配置隔离和 Host 权限必须实际阻止原生工具，不能只靠提示词说“请勿修改”。主流程永远不消费 aside 回答，主上下文摘要器也不得把 aside 内容重新汇总进去。

```mermaid
sequenceDiagram
  actor U as 用户
  participant M as 主执行
  participant C as 临时问答服务
  participant A as 独立只读会话
  M-->>C: 已发布上下文快照的只读引用
  U->>C: 临时问题
  C->>A: 同工具同模型 上下文副本 无工具权限
  M->>M: 继续原任务
  A-->>C: 回答
  C-->>U: 临时面板显示
  opt 用户明确选择转为正式指令
    U->>C: 编辑后转入调整执行预览
    C-->>U: 正式差异及授权入口
  end
```

持久性规则：DevFlow 的问题、答案和临时上下文仅留服务/页面内存，空闲 30 分钟、用户清空或任务页面关闭后取消并清理；连接异常保留最多 60 秒以便重连，服务重启不恢复。不写 Workflow events、计划、进度、测试、主 transcript、自动摘要、搜索索引、遥测或备份；HTTP 访问日志不记录请求体，错误日志不带内容，也不保存可逆内容哈希。旁路算力仅在独立资源账本记录 tool、token 数、耗时、错误代码，不保存问答内容，失败不计入主流程失败。

厂商 CLI 可能自行保存独立会话日志，模型服务端也可能按其政策保留请求。适配器必须把本机临时运行目录隔离、禁用可控历史并清理受管临时文件；无法禁止的上游保留在能力说明中如实显示。产品保证是“不进入 DevFlow 主流程和主会话”，不能声称全链路零留痕。异常重启扫尾只按受管目录所有权清理，不扫描或删除用户原生会话。

“转为正式指令”只把用户选定并可编辑的文本复制到调整预览，不自动复制整段问答历史；随后遵守 16.5 节授权与版本机制。关闭、失败或取消临时问答不更改主任务状态。每工作流最多一个活动 aside、最多三个排队问题；系统旁路槽位默认 2，主执行优先，超过队列限制立即显示繁忙。单问答超时 120 秒，人工取消立即撤销旁路令牌并只停止对应受管进程。

### 16.8 持久对象、API 与能力合同

复用当前 SQLite entities/events/dedup/outbox 存储，不在本任务引入第二套数据库或擅自改成 MySQL。新增实体 kind：`workflow_execution_spec`、`document_bundle`、`execution_change`、`context_ack`、`execution_checkpoint`；每个不可变对象用 workflow+revision 或内容哈希作为确定键，活跃指针在事务中 CAS 更新。问答内容不进入这些实体。取消/停止前后通过 outbox 恢复，不能在数据库事务内等待模型或进程退出。

核心不变量：每工作流最多一个有效写入 epoch；每个变更最多一个 successor Run；新 Run 未确认当前文档包前不能写；旧 Run 不能完成新细项或补交当前证据；side question 不能出现于主工作流事件与 prompt。重复调度先查稳定的 change→successor 关系，再启动进程；控制器重启通过 Host 身份、lease 和 outbox 对账，不能盲目重发生成两个写者。

| 接口 | 作用 | 权限与失败规则 |
|---|---|---|
| `GET /api/workflows/:id/execution-spec` | 读取任务四角色、叶子覆盖与实际冻结配置 | 本机只读；不返回密钥 |
| `POST /api/workflows/:id/execution-spec/preview` | 解析组合、模型与范围影响 | 只生成预览；不修改活动 Run |
| `POST /api/workflows/:id/changes/preview` | 指令与文档生成不可变差异预览 | workflow version、plan hash、目标路径必需 |
| `POST /api/workflows/:id/changes` | 应用用户已展示的正式调整 | 同源人工权限；模型入口仅提交草案，不能自行应用；幂等、CAS |
| `GET /api/workflows/:id/changes/:changeId` | 读取停止、审批、确认状态 | 明确区分 saved/stopped/acknowledged/applied |
| `POST /api/workflows/:id/asides` | 创建临时问题 | 独立 aside 权限和内存会话；响应 no-store |
| `DELETE /api/workflows/:id/asides/:asideId` | 取消并清理临时问题 | 校验浏览器会话及 workflow；不停止主执行 |
| `devflow_preview_change`、`devflow_submit_change` | 八客户端自然语言入口的变更草案 | 模型本身不能伪造人工批准；新合同走控制台确认 |
| `devflow_ack_context` | 新 worker 确认文档上下文 | 只允许本 Run，逐字段绑定哈希和 seq |
| `devflow_ask_aside`、`devflow_cancel_aside` | 专用旁路客户端协议，供独立问答UI使用 | 不注册到planner/worker主会话MCP；仅aside-client权限；禁止作为AI监工周期调用 |

网页复用既有本机免登录与 Host/Origin/CSRF 防护。入口身份与 worker token 严格区分；仅有 planner/worker 令牌不能调用人工批准。临时事件走独立内存 SSE/WS 通道，校验来源及所属 UI 会话，不能复用写入 Workflow events 的广播辅助函数。

SDK 扩展 `capabilities`：`modelCatalog`、`explicitModel`、`exactResume`、`concurrentSessions`、`readonlyNoTools`、`isolatedSessionStorage`、`nativeCancel`。这些是探针和认证结果，不是模型自报。正式改向要求 Host 停止与新会话启动，nativeCancel 只用于缩短停止耗时，仍需进程树停止确认；不因某工具缺少热注入而取消统一的调整入口。临时问答要求 readonlyNoTools 与受管隔离；无法满足的版本显示具体能力错误，并阻止该认证格标绿。

### 16.9 页面布局与自然语言入口

任务创建页默认展示“本任务使用的组合”，可用“一个工具完成全部”或“按阶段搭配”；每行平台选择后才加载该平台模型。模板仅用于填充，不与已有任务保持实时联动。“高级：按开发细项指定执行器”在细项计划生成后开放。模型 UI 标签和精确 ID 同时保留；不能仅保存显示名称。

```text
本任务：客户需求实现                       组合：按阶段搭配
规划      Kimi Code          已选择的模型
实施      Cursor Agent       已选择的模型
测试      同实施             已展开显示实际绑定
独立复核  同规划             新会话、只读

执行详情：正在处理 T-07 · Cursor Agent · 当前报告模型
[调整执行] [同步设计文档] [临时提问] [暂停]
正式调整：已停止旧执行 → 新计划待批准 → 新上下文已确认
设计版本、开发进度、测试进度：显示本轮版本与更新时间
```

“同步设计文档”打开同一个调整入口并自动预选变化文件；“临时提问”使用独立面板和发送按钮，不用一个输入框根据问号猜是否正式指令。执行区持续保留入口，规划/暂停/恢复/验证阶段按权限显示当前可用动作。离开详情再返回，正式调整从数据库恢复；临时问答不混入正式时间线。

正式主入口的自然语言示例：“这个任务只用 agy”“这个任务 Kimi 规划，Cursor 执行，模型用我选的这个”“第 T-07 项改用 OpenCode 的指定模型”“设计文档第 6 节增加了导出权限，请同步后调整执行”。临时问题“目前为什么先做数据库适配”在独立问答面板内输入；已经发给主模型的消息无法事后保证不进入其历史，入口必须在发送前明确分流。缺少模型时使用创建页已选择的精确配置；没有任何可解析配置时给出工具原生模型选择入口，不能凭示例推断账号里存在某模型。

### 16.10 合并后的开发顺序、验收与风险处置

```mermaid
flowchart LR
  P01[P01 合同和适配器SDK] --> P03[P03 通用运行器]
  P03 --> P04[P04 八工具适配]
  P04 --> P05[P05 七Skill]
  P05 --> P06[P06 模板和节点]
  P06 --> P07[P07 网关和浏览器]
  P07 --> P11[P11 任务组合与执行交互]
  P11 --> P08[P08 安装与打包]
  P08 --> P09[P09 完整迁移和验收]
  P09 --> P10[P10 开源交付]
```

P11 是原任务内的模块编号，放在 P07 后、P08 前执行；细项路径、输入、算法、完成检查、停止条件及测试 ID 全部进入同一份 leaf-v1 合同。P01 先定义共享字段，P03 预留 Run/epoch/上下文槽位，P04 声明能力，P05 增加入口说明，P06 配合冻结与细项绑定；不得先实现一套临时分支再整体重构。

本次新增验收 AC-57～AC-76：任务间组合隔离；跨工具规划执行；同平台不同模型；叶子覆盖；文档差异；停止顺序；上下文 ack；新计划审批；迟到/重复/重启；证据失效；临时问答上下文；主流程无污染；权限及上游日志边界；转正式指令；双浏览器冲突；并发与资源；迁移；四种必需平台上的八工具能力；可见状态；同一任务进度与发布门禁。完整用例见同任务测试合同，不接受只完成一个 UI happy path。

工程估算：P11 合计 15 个工程工作日，按 1 人串行、基础能力按合同完成计，属于原完整开发计划的增量工期；真实 CLI 账号/跨平台 runner 等待单列为外部阻塞，不伪装成已完成工作日。顺序为合同与配置 3 日、文档包与指令控制 5 日、临时问答 3 日、UI 与入口 2 日、集成和故障验证 2 日；原 P04/P09 认证时间仍保留，不以本估算替换。

主要失败处置：模型不可用阻止该绑定运行；文档读取不稳定不生成预览；停止未确认保留租约；上下文未确认不开放写权限；设计变化未批准不进入新实现；临时问答失败不暂停主任务；源码/配置基线变化停止派发并重新制定同一任务的新计划，不能提交用户未授权修改。外部发布仍须单独指令。

### 16.11 本次核对的官方资料与证据边界

核对日期：2026-09-14。以下仅用于确定适配设计，不代表本机真实模型执行已经通过。

- Cursor 官方 CLI 文档提供 model 参数、账号模型枚举、明确 chat ID 恢复及 workspace 参数；因此按 Cursor Agent 账号能力发现与精确 ID 绑定，而非预置 Grok 4.6。[Cursor CLI 参数](https://cursor.com/docs/cli/reference/parameters)
- OpenCode 官方 CLI 文档提供已配置 provider 的模型枚举、provider/model 标识和指定 session；因此模型键必须包含 provider，恢复必须显式 ID。[OpenCode CLI](https://opencode.ai/docs/cli/)
- Kimi Code 官方文档提供模型别名、非交互 stream-json；agent-file 与 resume 存在冲突约束，因此本次正式改向采用新会话交接，不拼接未经验证的恢复参数。[Kimi 命令](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command)
- Claude Code 官方 /btw 说明其侧问答可在主执行期间独立回答，不写主会话且无工具；DevFlow 采用这一交互语义，通过统一旁路实现八工具支持，不能据此声称其他 CLI 有原生 /btw。[Claude Code 临时提问](https://code.claude.com/docs/en/interactive-mode#side-questions-with-btw)


### 16.12 新增验收编号与完成断言

| 编号 | 必须证明的结果 |
|---|---|
| AC-57 | 两个任务配置不同工具，修改全局默认不改变任一冻结任务；single-tool覆盖全部AI节点 |
| AC-58 | Kimi规划与Cursor执行的绑定按任务保存，tester/reviewer默认值明确可见且可覆盖 |
| AC-59 | 同平台可用不同模型；provider不丢失，显式模型失败不回退，实际报告冲突阻止执行 |
| AC-60 | 叶子实施/测试覆盖只影响指定细项；测试多细项归属唯一，不能覆盖人工门禁 |
| AC-61 | 三文档以最后批准版本生成可核对diff，修改进度文字不能伪造完成 |
| AC-62 | 封锁旧写入先于停止；旧进程未确认退出时不启动新写者、不释放租约 |
| AC-63 | 新执行完整读取并确认当前包后才能写入；缺页、旧hash、超时均受阻 |
| AC-64 | 新需求、测试标准、范围、绑定变化必须生成完整新计划供用户批准 |
| AC-65 | 双击、重复投递、迟到结果及重启均不创建重复后继、不让旧轮次修改当前事实 |
| AC-66 | 正式改向使当前测试、验收与复核失效；历史结果可查但不能算当前通过 |
| AC-67 | 临时提问使用同工具同模型及已发布上下文；主执行继续，状态日期明确 |
| AC-68 | 问答canary不存在于主events、prompt、进度、测试、摘要或索引；只在内存旁路返回 |
| AC-69 | 旁路工具实际拒绝、临时目录受管清理；不声称供应商端零保留 |
| AC-70 | 转为正式指令必须经用户编辑预览和相应授权；不自动写入整个问答历史 |
| AC-71 | 双浏览器旧版本409可见且保留草稿；不覆盖另一条正式调整 |
| AC-72 | 旁路排队、120秒超时和取消只影响旁路；主写租约和失败计数不变 |
| AC-73 | 迁移保存旧任务原配置快照；历史未报告模型保持未知，不伪造新模型信息 |
| AC-74 | 八工具在四必需目标各有真实改向及旁路认证，32格全部当前版本通过 |
| AC-75 | UI明确区分保存、停止、等待批准、确认上下文、应用完成；不能提前显示已生效 |
| AC-76 | 当前1.4任务88项细项及275项用例统一计数，新功能未完成禁止进入完整交付 |


## 17. 审批前代码起点选择与合并主工作区（1.4 新增）

### 17.1 当前实现的准确行为

当前 `GitManager.prepare` 的 new_worktree 分支执行 `git worktree add -b <执行分支> <目录> <plan.baselines[repo]>`；已有工作区记录则直接复用。它不会先拉取远端，也不会合并源工作区当前 HEAD 或未提交修改。`Engine.run` 把批准计划的 baselines 传给 prepare；`snapshot/commit` 还假定执行 HEAD 等于旧 baseline 或服务记录的最终提交。所以目前直接手工往执行分支 merge 会触发 `BASELINE_CHANGED/INDEX_CHANGED`，不能把新增功能实现为只有一个调用 git merge 的按钮。

计划的设计正文通过 MCP 批准上下文交给执行模型；由本计划P00-01带入工作树。这个过程不是主工作区整份代码同步，不能据此声称最近的界面修复、代码提交或未提交文件已经进入执行分支。

本功能继续属于 `wf-508be4f4-4c5a-453c-9ac6-c6dafe717a08` 原任务，新增P12模块；原P00～P11全部保留，不建立第二个任务。按钮及审批选择是待开发功能，当前控制器在升级前仍按已有冻结基线执行。

### 17.2 一个产品设计，两个操作入口

审批页增加“执行代码起点”区；任务详情增加“合并主工作区变更”按钮。两处使用同一个 `WorkspaceSync` 协议。以下为用户可选的输入模式，不是交给开发者自行取舍的技术方案。

| UI选择 | 输入的精确定义 | 首次执行与已有执行分支的行为 |
|---|---|---|
| 保留已批准代码基线 | 当前计划冻结的精确commit | 保持原行为；源工作区变新只提醒，不自动拉入 |
| 主工作区最新已提交版本 | 点击预览时绑定源工作区的HEAD，不是执行时浮动的main | 首次执行从预览冻结的commit创建；已有执行分支保留既有工作后做三方合并 |
| 主工作区当前快照，包含未提交修改 | 冻结源HEAD加所选工作区文件内容，包含已暂存、未暂存、删除和明确选中的未跟踪文件 | 形成仅供本工作流使用的不可变输入提交，再与执行工作进行三方合并 |

“主工作区”指任务接入时绑定的源checkout，按repo ID和canonical common_git_dir标识，不按最近打开目录、分支名main或当前入口cwd猜测。预览同时显示源目录、源分支、源HEAD和执行分支，分支切换或仓库身份变化使预览过期。多个仓库分别指定输入，并作为一个同步批次共同冻结。

新建任务的默认行为仍是冻结创建时所选版本；已批准任务永远保留已批准基线，直到用户明确选择同步。发现源有新增提交时提示“源工作区较执行基线新增N个提交”，并提供“查看并合并”；普通批准/暂停/恢复不悄悄重新拉最新代码。

审批页显示选中版本和变更统计，按钮为“批准此版本并开始”。用户选择含未提交内容时，默认选中所有受支持的已跟踪变更，未跟踪文件逐项勾选；状态为ignored的缓存、日志、构建产物以及.devflow、凭据、.git等受保护内容不能打包。被排除文件必须列出原因，不能用“当前全部代码”掩盖实际排除范围。

任务详情按钮第一步只生成预览，不终止正在运行的模型；按下“暂停并准备合并”才撤销旧写权限、停止旧Run并生成最终目标检查点。最后显示完整合并结果和修订计划，用户按“批准合并并继续”一次授权这份确定结果；准备过程中的冲突、代码或文档调整反映在同一预览，不额外增加一次内容完全相同的批准。

### 17.3 必须保护源工作区与执行进度

源工作区是输入。同步不能在源checkout执行stash、reset、checkout、git add或普通git commit，不能替用户提交暂存区或改写主分支。快照使用临时index、独立对象目录及受管私有ref生成内部输入commit，保留原HEAD作为父提交；不会创建用户可见的主分支提交，也不自动push。必须在预览中说明生成了私有输入快照，其生命周期随任务证据保留。

“已暂存”和“未暂存”都表示源的变更，快照最终内容以用户磁盘工作树为准；原暂存区内容仅记录用于证明未被修改，不能先apply暂存diff再apply工作区diff造成重复。暂存与磁盘内容不同须在预览中提示。捕获HEAD、索引checksum、路径清单、文件mode/bytes/hash及删除事实；捕获前后再次核验。源被其他进程修改则 `SOURCE_CHANGED`，重建预览而非混合两时刻内容。

链接、submodule、LFS和自定义clean/smudge或merge driver首发按受管Git快照能力认证：支持的类型在能力清单中明确处理，未认证类型在预览前返回 `SOURCE_FILE_UNSUPPORTED` 并列路径；不能运行仓库自定义程序或静默丢内容。文本、二进制、权限位、重命名、删除和普通未跟踪文件纳入测试。独立临时index不会代替源index。

目标执行分支的未提交工作也要保留：停止旧Run后冻结完整target检查点，既有提交保留父链，未提交工作写为私有checkpoint commit；不假装它是测试通过或最终交付commit。拒绝尚未解决的用户原生Git合并/rebase、身份不明的writer及无法归属的工作树状态。已有目标改动不能因“换基线”被覆盖。

### 17.4 合并算法与冲突处理

输入由source snapshot commit和target checkpoint commit精确标识。存在共同祖先时用受管Git的 `merge-tree --write-tree` 进行三方合并，解析退出状态与完整冲突记录；使用Git自动计算共同祖先，不能将最近输入tree强行当merge-base。无共同历史返回 `UNRELATED_HISTORY`，不启用allow-unrelated-histories。没有目标工作时首次执行直接采用已冻结输入commit，不制造无意义的merge。

所有预合并结果、冲突文件和模型修复放在独立的受管integration工作树；正式执行分支在用户批准前不变。自定义merge drivers/hooks禁止自动执行；Git程序、配置与属性能力必须可核验。冲突按三方内容展示，禁止全局采用ours/theirs或静默丢文件。用户可在预览选择逐文件解决，或让该任务planner在明确的冲突文件范围内提出解决结果；解决后的差异和计划再交给用户一次批准。

```mermaid
sequenceDiagram
  actor U as 用户
  participant UI as 审批页或合并按钮
  participant C as 控制器
  participant S as 源主工作区
  participant T as 当前执行分支
  participant I as 隔离合并区
  U->>UI: 选择已提交版本或含未提交快照
  UI->>C: 预览输入版本
  C->>S: 只读捕获并检查稳定性
  C-->>UI: 源版本 文件差异 排除清单
  U->>C: 暂停并准备合并
  C->>T: 撤销写权限 停止 确认检查点
  C->>I: 三方合并精确source与target
  I-->>C: 合并结果或逐文件冲突
  C->>I: 校准设计 细项和测试合同
  C-->>U: 展示合并结果及新计划
  U->>C: 批准合并并继续
  C->>T: 校验未漂移后发布合并结果
  C->>C: 更新执行基线和文档包 失效旧证据
  C->>T: 新会话确认上下文后继续
```

同一来源的输入快照保存独立lineage：后续输入commit以已接受的上一输入commit为父，源HEAD出现尚未包含的新提交时再保留源HEAD父链，tree严格等于本次批准的源内容。这样源撤销此前未提交改动时，下一次快照会产生明确的撤销diff；不能每次都从源HEAD创建无关联的快照，导致反复同步无法识别撤回。输入模式从“含未提交”切成“仅已提交”引起的撤回也必须显示并随预览批准。

相同source tree、源提交祖先和输入模式重复同步且已被当前执行历史包含时返回no-op，不重复commit、不失效证据；只比较source HEAD不足以判断含未提交快照是否相同。merge必须基于真实输入commit祖先去重，不能机械重复应用patch。源不需要固定在最新HEAD直到执行时：批准的是预览显示的冻结版本。若用户在最后批准前想使用更新的源版本，必须点击刷新预览并重新校验，不能偷偷替换已展示内容。

### 17.5 执行基线、范围与复核不能被合并隐藏

区分三种字段：`original_plan_base`保存最初计划基线；`input_revision`保存每次批准引入的source commit/tree；`execution_base`保存当前允许运行与最终提交的精确父commit。它们不可互相覆盖。新版本的snapshot、matches、diff、commit、resume及反篡改检查全部校验execution_base和sync revision，不再永久要求HEAD等于最初baseline。

合并来源文件可能超出原开发任务允许路径；这不代表执行模型获得这些文件的任意后续修改权。同步有独立的、用户预览并批准的`import_paths`，模型后续写入仍受更新后计划的task paths限制。planner按候选合并快照校准实现路线、已实现细项、测试和设计；若源引入本次任务已经实现的功能，允许删除重复开发但必须写明旧→新细项映射，不能仅因上游文件存在就标记完成。

最终复核材料同时包含：每次输入变更source diff、合并前target工作、冲突解决diff、合并后任务新增diff和当前完整源码。只看execution_base之后的最后一段diff会漏掉合并带入的错误；复核不得因此省略任务原有改动或冲突解决。私有checkpoint/import/merge commit不是DevFlow最终COMMITTED，不获得人工验收或复核通过标记。

本任务的设计正文和导出文档也属于受版本控制的输入。源文件与已批准设计正文不同，必须显示“磁盘文档/已批准文档冲突”，校准为同一新版本后再批准；不能让源的旧设计覆盖刚提交的新设计，也不能用写文档步骤悄悄覆盖用户后来补充的要求。

### 17.6 发布、重启恢复与取消

持久`WorkspaceSync`状态为 `PREVIEW → STOPPING → CAPTURING_TARGET → MERGING → CONFLICTS或PLAN_PENDING → APPLYING → APPLIED`；故障转 `RECOVERY_REQUIRED`，用户放弃为CANCELLED。工作流共用第16节的epoch撤销、Host退出确认、outbox和上下文ack，不建立第二套模型调度器。

发布前CAS校验用户批准的source snapshot、target HEAD/tree/index、plan hash、merge tree和sync version；target在预览后被修改返回 `TARGET_CHANGED`，不能覆盖新工作。写入先保存recoverable intent，再更新执行分支引用及受管工作树；Git ref与文件系统不能被宣称是单个原子事务。只有所有受管repo完成并逐一核对tree、index、ref后，数据库事务才切换当前execution_base并标记APPLIED、开放新执行。文件更新期间一直保持写屏障。

中途崩溃按intent记录的每repo阶段及old/new ref恢复；不确定时保留现场和租约。回滚只允许目标仍匹配本sync已写入状态时用保存的checkpoint恢复；发现用户额外修改则暂停人工处理，不能强制reset。多仓批次任一未完成，整个Workflow不能恢复运行；明确显示哪些仓库已应用、哪些尚未应用，不能冒充跨仓原子成功。

取消预合并不改变源或目标；只有本次停止的原运行需要恢复时，沿原批准上下文经过恢复检查后新Run继续。取消已经发布的合并使用独立“撤销本次同步”预览，须以当前目标快照重新核对，不能无条件回退分支指针。回滚仍使旧证据失效。

任何实际代码合并/冲突修复都使测试、人工验收和独立复核失效；重新冻结、测试、验收和复核后才可最终提交。模板明确的CI输入验证不等于真实业务测试通过。执行器只在新execution_base、plan、bundle、sync ID全部确认后获得写权限。

### 17.7 接口、界面与执行门禁

| 接口或控件 | 行为 |
|---|---|
| 审批页“执行代码起点” | 展示冻结commit与源最新commit、未提交统计，三种输入模式和差异预览 |
| 详情页“合并主工作区变更” | 任意非最终提交临界阶段可生成预览，运行阶段明确提供暂停准备动作 |
| `GET /api/workflows/:id/source-status` | 只读返回每repo源与目标身份及ahead/dirty摘要，无隐式fetch |
| `POST /api/workflows/:id/workspace-syncs/preview` | 生成内容冻结的source预览及排除清单 |
| `POST /api/workflows/:id/workspace-syncs/:syncId/prepare` | 用户明确暂停准备，捕获target并合并候选 |
| `POST /api/workflows/:id/workspace-syncs/:syncId/apply` | 消费绑定sync/plan/source/target/result hash的人工批准并发布 |
| `POST /api/workflows/:id/workspace-syncs/:syncId/cancel` | 按当前阶段安全取消；已应用不隐式倒退 |
| planner MCP | 仅查询、预览及提交候选修订；不能自行批准导入主工作区或用worker token调用人工按钮 |

按钮实时显示待合并提交数、文件数、冲突数和最后同步版本。已有工作区以外的源只读；主工作区有改动不是自动阻塞所有执行，用户仍可明确保留原基线。源是本地checkout，“合并主工作区”不等于git pull，不自动fetch/push、改源分支或远端。需要先更新远端代码属于用户单独的源工作区操作。

### 17.8 同一任务内的开发顺序与验收

P12在P11后、P08前完成，统一纳入安装包、迁移、测试与开源交付。P12先定义源快照/执行基线合同，然后实现捕获与预合并、冲突与恢复、snapshot/commit兼容、API与UI、集成测试。增量估算8工程工作日，基于P11已完成且测试环境就绪；外部等待不计入通过状态。

```mermaid
flowchart LR
  P11[P11 任务配置及执行交互] --> S1[P12 源快照和检查点]
  S1 --> S2[三方合并及冲突预览]
  S2 --> S3[基线变更及恢复]
  S3 --> S4[审批选项和合并按钮]
  S4 --> S5[代码 文档 证据联合验收]
  S5 --> P08[P08 安装包]
  P08 --> P09[P09 完整验收]
```

| 新增验收 | 必须证明的结果 |
|---|---|
| AC-77 | 审批前选择旧基线/源已提交版/含未提交快照，均冻结精确输入，执行时不浮动 |
| AC-78 | 源HEAD、branch、index与工作树未被同步操作修改，未跟踪文件与排除清单明确 |
| AC-79 | 已有执行分支的提交和未提交工作保留，双方变更通过三方合并进入结果 |
| AC-80 | 同步与运行写入互斥，未确认停止不发布，目标漂移不覆盖 |
| AC-81 | 冲突逐文件可核对，取消不改原工作区；禁止全局ours/theirs |
| AC-82 | snapshot/commit/recovery使用新版execution_base，不能因合法同步误报BASELINE_CHANGED |
| AC-83 | 引入改动、冲突修复、任务新增均进入最终复核，旧证据失效后重测 |
| AC-84 | 重复同步no-op、崩溃恢复、部分多仓发布、回滚漂移均有确定安全状态 |
| AC-85 | 审批页与详情按钮真实可用，普通审批/恢复不自动同步，不替用户拉远端 |
| AC-86 | 设计文档与源代码共同冻结并校准，新设计不会被旧源文档覆盖 |

### 17.9 Git实现依据

Git官方说明merge-tree可生成三方合并tree而不改index和工作树，并能报告冲突；因此用于隔离预合并，不能把“输出了tree OID”单独当无冲突成功。[git-merge-tree](https://git-scm.com/docs/git-merge-tree)

临时index构造输入树，commit-tree创建带父关系的内部对象；发布引用需带期望旧值，不能把update-ref的原子性扩大解释为整个工作树或跨仓事务原子性。[git-read-tree](https://git-scm.com/docs/git-read-tree)、[git-commit-tree](https://git-scm.com/docs/git-commit-tree)、[git-update-ref](https://git-scm.com/docs/git-update-ref)


### 17.10 本任务本次代码输入选择

用户已明确选择“主工作区最新已提交版本”。已核实源checkout为D:/Code/system-handle，HEAD为`6eb47cca18dc65397aab125e96eb329cecc344d2`（6eb47cc，代码变更工作台重构、分支友好化与工作台交互视觉体验优化）。相对原d5bc298基线新增7个提交、涉及52个已跟踪文件；包括工作台布局、事件刷新、设计文档查看、暂停原因推断与自愈修复。

原任务当前尚无执行worktree或Run，因此本次直接把plan.baselines.main冻结为该commit，在批准后从它创建执行分支，不先创建旧分支再merge。未提交代码不带入；本次1.4设计与计划正文作为明确批准的文档材料由P00-01带入。没有操作源分支、暂存区、未提交代码或远端，也没有开始产品开发。以后HEAD推进仍使用本次冻结版本，需要再次选择更新后生成新修订。
