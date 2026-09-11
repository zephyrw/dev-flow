# SQLite 驱动稳定性调整

日期：2026-09-11。状态：源码、依赖及编译完成；用户随后恢复测试，数据库读写、事务、备份恢复结果见 [本轮验证报告](../test/免登录改版验证报告.md)。

## 警告的含义与决定

本机 Node 版本为 22.23.2，原实现使用内置 `node:sqlite`。该版本的[官方 SQLite 文档](https://nodejs.org/download/release/v22.23.2/docs/api/sqlite.html)将接口标记为实验性、积极开发阶段。[Node 稳定性说明](https://nodejs.org/download/release/v22.23.2/docs/api/documentation.html#stability-index)明确指出实验接口不受语义版本的兼容承诺保护。

实际风险是未来升级 Node 时，数据库访问或备份接口可能不兼容。警告本身不能作为配对失败、数据库损坏或信息泄露的证据；用户贴出的输出已经显示配对码写入成功。SQLite 文件格式的成熟度与 Node 接口的稳定等级是两件事。

决定保留 SQLite，将驱动替换为 `better-sqlite3`，固定版本为 **13.0.3**，同步更新依赖锁文件。无需新增数据库服务、账户或重新建立数据库。

## 修改范围

| 位置 | 调整 |
|---|---|
| Store | 使用 `better-sqlite3` 的同步连接与参数绑定，等待数据库锁的超时仍为 5 秒 |
| 查询结果类型 | 适配驱动的 TypeScript 类型，无 SQL 逻辑变更 |
| 备份 | 调用并等待 `db.backup()`，继续使用 SQLite 在线备份 |
| CLI | 删除未使用的 `node:sqlite` 导入 |
| 依赖 | 锁定运行驱动 13.0.3、类型声明 9.6.0，以及锁文件中的间接依赖 |

现有数据库路径、表结构、`user_version=1`、WAL、外键、显式事务和数据内容保持原设计。此次修改没有打开、迁移或重写用户的数据库文件。备份仍由驱动生成 SQLite 备份文件，不能改为直接复制运行中的数据库主文件而忽略 WAL。

驱动的 [13.0.0 发布说明](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0)说明其采用 N-API 并随包提供预编译组件；[13.0.3 包定义](https://github.com/WiseLibs/better-sqlite3/blob/v13.0.3/package.json)要求 Node 22 及以上。实际安装目录包含 Windows x64 预编译文件；这只证明文件存在，不代表本轮验证过原生模块加载。备份接口依据[官方 API 文档](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md)。

## 驱动替换时的记录与后续验证

- 依赖使用 `npm install --ignore-scripts --no-audit --no-fund` 安装完成。
- 后端使用 `tsc -p tsconfig.build.json` 编译通过；生产源码没有残留 `node:sqlite` 导入。
- 静态复核确认此次变更没有修改 SQL 表结构及事务边界，备份 Promise 被等待。
- 未运行原生组件加载、配对、数据库读写、并发事务、备份恢复或真实模型测试。历史验证结果不覆盖此次驱动替换。

后续恢复测试已覆盖数据库读取、事务回滚及备份恢复，配对要求已取消。固定驱动版本降低依赖漂移风险，不代表驱动永远没有缺陷；后续升级仍需验证这些行为。

CLI 下次启动会使用新依赖；已经运行的后台进程需要正常重启后才加载新代码。本轮未为了验证而重启服务。
