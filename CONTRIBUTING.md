# 参与贡献 DevFlow

感谢关注 DevFlow。本文件是贡献流程与文档入口，**不替代**产品 README 与开发细节文档。

## 1. 先读什么

| 角色 | 阅读 |
|---|---|
| 使用者（给反馈、报问题） | [README](README.md)、[使用指南](docs/guide/使用指南.md)、[使用与恢复指南](docs/guide/使用与恢复指南.md) |
| 开发者 | [开发指南](docs/development/开发指南.md)（Node/pnpm 版本、先构建后测试、目录结构） |
| 关心安装与验证边界 | [安装与升级](docs/guide/安装与升级.md)、[客户端兼容性](docs/guide/客户端兼容性.md) |
| 执行模型 / 工作流文档作者 | [执行约定](docs/guide/执行约定.md)（指定计划权威规则；禁止另建实施计划替代原文） |

## 2. 开发环境

- Node.js ≥ 22.23.2、pnpm 11.7.0（与 `package.json` engines 一致；详见[开发指南](docs/development/开发指南.md)）。
- **不要求** Go / .NET / C++ 工具链；不要恢复 `build:host` 等已移除命令。
- 依赖：`pnpm install --frozen-lockfile`。
- 提交前建议：`pnpm typecheck` → `pnpm build` → `pnpm test`（先构建后测试，与 CI 顺序一致）。

## 3. 修改约定

1. **文档与实现一致**：命令、路径、支持声明必须指向真实现状；不写占位版本号、不存在的截图或“保证/绝对”类承诺。
2. **不扩大架构**：不恢复 Go Host 或旧认证 Host；不顺手迁移无关技术栈。
3. **计划执行**：已有正式计划/整改文档时，按原文执行与验收，不另建 implementation_plan 替代；进度可记在 `docs/process/`，只引用原任务编号。
4. **验证诚实**：替身测试不写成真实模型认证；未测组合保持 unknown/unverified。兼容性数据以 `compatibility.json` 为准，由对应负责流更新。
5. **范围**：安装/发布脚本、`packages/**`、`apps/**`、`compatibility.json`、`package.json` 等以仓库内各专项分工为准；勿在文档 PR 中顺手改无关源码。

## 4. 提交与 PR

- 一次 PR 聚焦一个目的；说明改了什么、如何验证、剩余问题。
- 测试与证据目录约定见仓库 `docs/test/`、`docs/process/` 既有实践。
- 不要提交密钥、真实账号凭据或未脱敏截图。
- 代码风格与格式化沿用仓库现有工具（TypeScript、Vite、vitest、Playwright、Prettier）。

## 5. 反馈问题

- 产品使用问题：附上你做了什么、实际结果、期望结果，以及任务页错误详情（脱敏后）。
- 安全或隐私相关：不要在公开 issue 贴出令牌、Cookie 或完整业务数据；按仓库维护者提供的私密渠道报告。
- 文档问题：直接指出文件与章节即可。

## 6. 许可证

贡献即表示同意以 [Apache License 2.0](LICENSE) 授权你的改动。第三方声明见 `THIRD_PARTY_NOTICES`。
