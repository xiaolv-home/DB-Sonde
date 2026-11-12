# 2026-11 审查处置（0.52.4）

基于 `e4d2296`（11 月 10 日基线加启动恢复）核对截图。图表绘制、尺寸和动画未改动。模型地址授权、请求生命周期、流文本脱敏、下载、ClickHouse HTTP、日期键盘、分析时间对齐各自独立。

| 审查项 | 处置与边界 |
| --- | --- |
| CSP 缺失 | 生产脚本只来自应用自身，禁内联脚本、外部页面请求和对象插件；应用页禁止嵌入。开发服务器也发送 frame-ancestors 响应头。 |
| 页面拿到云端密钥 | 原生模型请求统一走 Rust；配置读取只给 hasKey。输入仅是短暂草稿，保存后清空，换源不会带走旧密钥。保留取消、UTF-8 和分块脱敏；用户保存的局域网本地端点仍可用。 |
| 任意 URL / 路径下载模型 | 命令不再接收 URL / 文件名，只下载固定官方模型；HTTPS 与逐跳来源检查、SHA-256 校验、.part 验证后才变 .gguf。拒绝越界路径、设备名和符号链接。 |
| Windows 主目录与停止 Python | 统一系统主目录和平台可执行路径；持有实际子进程句柄，停止在工作线程运行。Windows 用 taskkill /T，失败回退 Child::kill；Unix 有宽限后强制终止。 |
| AES 密钥与密文同目录 | **暂缓系统存储迁移**。现有 AES-GCM、文件权限和防符号链接保留，不能防止完整凭据目录被复制后的解密。本机当前使用 ad-hoc 签名，Keychain / DPAPI 的无损迁移、签名更新和失效恢复需要独立验证，避免已存凭据失效。 |
| ClickHouse 明文与重定向 | 新建默认 HTTPS / 8443；已保存 HTTP 配置不自动改写。密码请求不跟随重定向，要求填写最终地址。 |
| 监控 iframe 无隔离 | sandbox 保留脚本、同源登录、表单和受限弹窗，禁止顶层跳转；初始地址校验与 CSP 禁止嵌入应用源。独立监控窗口禁止调用应用命令，也限制导航目标，没有远程 IPC 授权。 |
| Oracle / ClickHouse 分析中途失败 | 复用能力表，在数据集和分析入口提前说明只读分析不支持，运行边界再次检查。SQL 编辑器继续使用；未用 SELECT 文本校验冒充数据库只读隔离。 |
| ClickHouse 30 秒超时与取消 | 每次查询独立期限（默认 300 秒，调用方可指定 1–3600 秒）、服务器 max_execution_time、独立 query_id。超时或停止通过单独 HTTP 请求发 KILL QUERY，限定编号和当前账号，只有 finished 才报告已停止。需要服务器权限，集群负载均衡下取消路由取决于部署。 |
| 分析下钻事实与最后一轮 | 同星期比较只排除当前行；缺失日/周/月按范围中的日期位置对齐，不能按结果行号凑对。最后一轮总结证据和缺口，证据不足明确根因未确认；与饼图动画无关。 |
| 依赖公告 | Tauri 配套依赖锁到 2.12.4、Vite 7.3.8，Rust 1.90 与 CI 对齐。 |
| 日期选择器 | 补方向键、Home/End、PageUp/PageDown、Esc、焦点恢复和完整日期名称；保留既有周日开周习惯。 |

## 验证范围

- 默认前端检查包含类型、lint、模型请求、凭据状态、分析事实、数据库能力、日期移动和既有看板回归。
- Rust 临时 HTTP 服务验证鉴权、重定向、流响应、下载、超时、查询编号和取消结果；受控子进程验证 Python 停止。Windows 专用测试交给 Windows CI。
- 原生 WKWebView 隔离验证：快速启动不闪、慢启动连续加载、缺凭据仍能导航；异步密钥保存不覆盖新输入；日期跨月与 Esc；生产 CSP 与框架隔离。
- 未使用用户真实云端密钥请求模型；不声称已在真实 Oracle / ClickHouse 服务器或 Windows 桌面人工验收。

## 判断依据

CSP 缺失会放大本地页面脚本注入的危害，但“任何远程网页都能调用全部 IPC”不准确：Tauri 默认限制远程来源。本次额外限制应用命令的窗口边界，使用公开 API 和浏览器 CSP / sandbox，没有替换 WebKit 私有导航方法。

- [Tauri CSP](https://v2.tauri.app/security/csp/) 与 [权限来源边界](https://v2.tauri.app/security/capabilities/)
- [Tauri 通道访问控制公告](https://github.com/tauri-apps/tauri/security/advisories/GHSA-w28w-mhc8-qvjv)：2.11.5 在影响范围，2.11.6 起修复。
- [Vite 开发服务器公告](https://github.com/vitejs/vite/security/advisories/GHSA-p4f5-76q4-ffq7)：7.3.8 修复，触发条件涉及向网络暴露开发服务器。
- [ClickHouse HTTP](https://clickhouse.com/docs/concepts/features/interfaces/http) 与 [KILL QUERY](https://clickhouse.com/docs/reference/statements/kill)
