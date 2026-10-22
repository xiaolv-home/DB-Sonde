# 模块结构与开发约定

DB Sonde 使用 Tauri 2、Rust、React 和 TypeScript。数据库工作区是核心功能，数据集、指标、看板、链路画布、监控中心、AI 和 Python 工作台通过功能模块接入。

## 代码目录

| 路径 | 职责 |
| --- | --- |
| `src/App.tsx` | 应用与功能模块装配 |
| `src/components` | SQL 工作区、结果表格、连接和对象浏览界面 |
| `src/store` | 连接、对象树、查询、工作区和界面状态 |
| `src/features` | 数据集、指标、看板、链路画布、监控中心、AI 分析 |
| `src/lib` | 平台接口、SQL 方言、存储和共享模型 |
| `src-tauri/src/commands.rs` | 桌面命令与会话管理 |
| `src-tauri/src/db` | 数据库驱动、元数据、事务和数据编辑 |
| `src-tauri/src/credentials.rs` | 本地凭据加密 |
| `src-tauri/src/persistence.rs` | 文件原子写入 |
| `scripts/test-*.mjs` | 前端与跨模块回归检查 |

## 依赖边界

- 核心 store 不导入可选功能或界面组件。
- 功能模块管理各自的界面、状态和业务流程；纯模型通过参数接收依赖。
- 前端通过 `src/lib/api.ts` 调用桌面命令，Rust 执行数据库、文件与凭据操作。
- 外部数据进入领域模型时必须校验，类型断言不能替代运行时验证。
- 未配置模型、指标或监控源时，数据库工作区仍应可用。

## 查询与编辑

`QueryPanel` 管理页面路由与页面实例，`SqlWorkspace` 管理编辑器，`QueryResults` 管理结果展示。
`src/lib/queryExecution.ts` 编排语句执行，执行状态绑定连接、数据库和运行标识，迟到响应不能覆盖新的运行结果。

普通 SQL 编辑器与分析取数使用不同执行通道。只读能力由 Rust 驱动实现，支持范围见
[数据库支持](../README.md#数据库支持)。手动事务绑定数据库会话。

表格修改使用完整主键及原值进行并发检查，受影响行数必须符合预期。大整数与 DECIMAL 使用字符串传输，避免 JavaScript 数值精度丢失。
停止后续任务派发不等于终止数据库正在执行的语句；取消行为必须按驱动能力处理。

## 持久化与页面恢复

- `jsonStorage.ts`、`workspacePersistence.ts` 与各功能仓储负责读取、校验和保存状态。
- 损坏配置保留原文并报告错误，不能以空默认值覆盖原文件。
- 保存、重命名和删除操作持久化成功后再更新界面状态；失败通过 `StorageNotice` 提示。
- 退出快照不保存密码、查询结果集或未提交的表格编辑。
- 页面错误边界隔离 React 渲染错误；网络、SQL 和文件错误仍需在操作边界处理。
- 恢复页面不重放已提交的 SQL、存储过程或分析任务。

## 扩展入口

### 数据库

在 `src-tauri/src/db` 实现驱动操作，并更新 `src/lib/databaseDialect.ts` 的方言与能力声明。
新增引擎需要验证连接、元数据、查询、数值类型和事务行为；不支持的能力应明确报错。

### 数据集与看板

数据集模型在 `src/features/datasets/domain.ts`，组件取数的 SQL 由 `widgetQuery.ts` 生成（数据集整段作为子查询）。
看板在 `src/features/dashboard`：`resolveDatasets.ts` 把组件编译成查询，`queryRuntime.ts` 负责缓存、并发去重和重编（下钻、同环比、组件筛选）。
用法见 [数据集、指标与看板](metrics-and-dashboards.md)。

### 链路画布与监控中心

链路画布在 `src/features/canvas`：`canvasModel.ts` 是图的模型（分叉点、弧度、彗星节拍），
`canvasExport.ts` / `canvasAnimation.ts` / `canvasVideo.ts` / `canvasHtml.ts` 分别负责 SVG/PNG、GIF、MP4 和 HTML 导出。
监控中心在 `src/features/monitor`，目前只有「嵌网页」一种接入方式，新的方式在 `MONITOR_KINDS` 里加。

### AI

`src/features/ai/aiTypes.ts` 定义模型配置，`src/features/ai/providers` 处理供应商请求差异。
分析工作流通过端口接收模型和数据工具，供应商专用参数应保留在适配层。
流程与会话边界见 [AI 分析流程](ai-agent-design.md)。

## 验证

```sh
npm run check
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

`npm run check` 包含架构边界、行为回归、lint 和类型检查；构建前自动执行。
它由 `scripts/run-checks.mjs` 并行跑完 `package.json` 里所有 `test:*`（加 eslint、tsc），最后一次列出全部失败项；
新加的 `test:*` 脚本自动纳入。`npm run check -- canvas sql` 只跑名字带这些词的，`-- --serial` 逐个跑。
新写的测试要打包前端模块时用 `scripts/lib/load-src.mjs`，别再各自复制一遍 esbuild 的样板。
修改驱动或外部系统适配器时，还应在相应测试环境验证实际协议行为。
