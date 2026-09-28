# DB Sonde

桌面数据库客户端，提供 SQL 查询、数据编辑、指标管理、数据血缘和 AI 分析。

## 下载安装

**[下载 DB Sonde 0.51.13 · macOS Apple Silicon](https://github.com/xiaolv-home/DB-Sonde/releases/download/v0.51.13/DB-Sonde_0.51.13_macOS_arm64.dmg)**

1. 下载并打开 `.dmg`。
2. 将 **DB Sonde** 拖入 **Applications（应用程序）**。
3. 打开应用，添加数据库连接，或创建 SQLite 演示库体验。

无需安装开发工具。安装包适用于 M 系列 Mac，建议 macOS 14 或更新版本。
当前版本未经过 Apple 签名公证；首次打开若被系统拦截，可在
**系统设置 → 隐私与安全性 → 仍要打开** 中允许。参见 [Apple 官方说明](https://support.apple.com/102445)。

安装包包含数据库客户端和云端 AI 接口，本地 AI 与 Python 运行时需另行配置。
版本说明和 SHA-256 校验文件见 [Releases](https://github.com/xiaolv-home/DB-Sonde/releases/tag/v0.51.13)。

> [!NOTE]
> 当前为 Beta。各平台的验证程度不同，见下表；SQL 执行和表格编辑可以修改数据库，
> 写操作请先在测试库验证。

| 平台 | 验证程度 |
| --- | --- |
| macOS Apple Silicon | 日常使用 |
| Windows x64 | 已在 Windows 10 上安装、打开、做过基本操作；CI 构建与单元测试通过。**没有长期使用，深层功能（指标、血缘、AI 分析）未逐项试过** |
| macOS Intel (x86_64) | 能构建出 Mach-O x86_64 并打包，**未在 Intel 机器上运行过** |
| Linux | 未做 |

## 功能

- **数据库工作区**：SQL 编辑器、数据浏览与编辑、表结构、事务和结果导出。
- **指标中心**：定义计算公式、业务口径、维度和汇总方式，供查询、AI 和看板复用。
- **数据血缘**：解析 SQL、ETL 文件和调度定义，查看表、任务与指标的上下游关系。
- **AI 分析**：根据问题选择指标、查询数据、检查结果并生成分析与看板。
- **扩展工具**：Python 工作台和 DolphinScheduler 接入。

AI 分析需要配置模型服务及指标；Python 工作台需要可用的 Python 运行时。

## 数据库支持

| 数据库 | 连接方式 | 手动事务 | 只读查询通道 |
| --- | --- | --- | --- |
| MySQL / MariaDB | SQLx | 支持 | 支持 |
| PostgreSQL | SQLx | 支持 | 支持 |
| SQLite | SQLx | 支持 | 支持 |
| Oracle | Rust thin；可选 Instant Client thick | 不支持 | 不支持 |
| ClickHouse | HTTP / HTTPS | 不支持 | 不支持 |

兼容 MySQL 协议的 PolarDB 实例可按 MySQL 连接。

## 开发

技术栈：Tauri 2、Rust、React、TypeScript。请先安装 Node.js、Rust 和
[Tauri 平台构建依赖](https://v2.tauri.app/start/prerequisites/)。

```sh
git clone https://github.com/xiaolv-home/DB-Sonde.git
cd DB-Sonde
npm ci
npm run tauri dev
```

常用命令：

```sh
npm run dev          # 浏览器预览，使用模拟数据
npm run check        # 回归检查、lint 和类型检查
npm run tauri build  # 构建桌面应用
npm run package:mac  # 在 Apple Silicon Mac 上生成 DMG
```

Rust 测试：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

### 跨平台构建

`.github/workflows/build.yml` 在三个原生 runner 上构建：macOS Apple Silicon、
macOS Intel、Windows x64，产物上传为 workflow artifact。

在本机为另一个 macOS 架构构建：

```sh
rustup target add x86_64-apple-darwin
npx tauri build --target x86_64-apple-darwin
```

**Windows 必须在 Windows 上构建。** 依赖链里的 `aws-lc-sys` 和 `ring` 含 C 代码，
需要 Windows SDK 头文件，从 macOS 交叉编译会在 `windows.h` / `stdlib.h` 处失败。
这是交叉编译 C 的固有限制，不是配置问题。

### 可选运行时

源码构建默认不包含本地 AI 和 Python 运行时。在 macOS 上可执行：

```sh
brew install llama.cpp
scripts/bundle-llama.sh
scripts/bundle-python.sh
npm run tauri build -- --config src-tauri/tauri.bundled.conf.json
```

基础构建不需要这些运行时，云端 AI 接口也不依赖它们。

## 文档

- [指标、看板与 ETL 接入](docs/semantic-and-etl.md)
- [模块结构与开发约定](docs/architecture.md)
- [AI 分析流程](docs/ai-agent-design.md)
- [在 Windows 上开发](docs/windows-dev.md) —— 实际踩过的坑：安全软件拦编译产物、PowerShell 5.1 编码陷阱、comctl32 清单导致测试加载即崩

## 数据与凭据

连接配置保存在本地，密码通过 AES-256-GCM 加密保存。数据库连接需手动建立。
AI 使用配置的模型服务，使用云端模型前应确认可发送的数据范围。

数据集预览、AI 取数和 Python `sonde.query` 使用独立只读查询通道；普通 SQL 编辑器支持写操作。
表格编辑要求完整主键并检查原值。MySQL 非事务表无法保证回滚，Oracle / ClickHouse 批量语句可能部分成功。
Python 脚本以当前用户权限运行，不提供系统级沙箱隔离。

## 许可证

[MIT](LICENSE)。第三方声明见 [NOTICE](NOTICE)。
