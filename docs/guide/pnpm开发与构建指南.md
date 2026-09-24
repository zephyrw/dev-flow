# pnpm 开发与构建指南（已归并）

> 本页内容已归并至 **[开发指南](../development/开发指南.md)**，以避免两套开发者文档。请不要再向本页添加新的构建说明。
>
> - Node ≥ 22.23.2、pnpm 11.7.0，与 `package.json` engines 一致
> - **先构建后测试**；不需要 Go / .NET / `build:host`
> - 开发者源码安装入口：`scripts/install-windows.ps1`（非用户默认）
>
> 用户安装与更新见 [安装与升级](安装与升级.md)。下文仅保留历史摘要，供旧链接跳转。

## 历史摘要（请改读开发指南）

- 依赖安装：`corepack enable pnpm` → `pnpm install --frozen-lockfile`
- 常用命令：`pnpm dev` / `dev:web` / `typecheck` / `build` / `test` / `test:e2e` / `start` / `cli help`
- **已过时**：表格中的 `pnpm build:host`（Windows Host / .NET 10）已移除，不要再执行。
- 磁盘与共享存储、依赖构建许可等说明见 [开发指南 §6](../development/开发指南.md)。
