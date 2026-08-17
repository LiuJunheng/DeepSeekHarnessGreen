# dsh-sidebar-lite（WebUI 侧边栏插件）

> 三国云:「关云长千里走单骑，只取五样家什——兵马、文牍、烽火、令旗、军情。」
> 本插件以「资源管理、文件预览/编辑、内嵌浏览器、CMD 终端、任务管理」五样本事，为 DeepSeek Harness 的 WebUI 右侧送来一方侧栏。

一个 **DSH 内置插件**，在 WebUI 右侧注入一个**可折叠、可左右自由拉伸宽度**（拖动左边缘）的侧边栏，能力聚焦五项：

1. **文件资源管理器** — 默认以**工作区根目录**（`sandboxPolicy.workspaceRoot`，即 `E:\DeepSeekHarnessLauncher` 整个项目）为根，对齐内部 `dsh-file-browser` 的 home（无工作区根时回退会话工作目录），列出目录树（目录优先、隐藏文件灰显、目录懒加载展开、单目录最多 1000 条防溢出），头部带 **「返回上级 ⬆」**与**可编辑路径框**（回车跳转到任意路径），彻底放开上级/任意路径浏览——不再把会话工作目录当作锁死的固定根；文件行支持**右键**：另存为（仅文件，本地机器用系统对话框自选保存位置）、复制相对路径、复制绝对路径（复制成功短暂提示"已复制"）。
2. **文件预览 / 编辑** — 文本文件就地编辑并保存回写；图片 / PDF / HTML 通过 `fetch → blob → objectURL` 预览。路径以绝对路径为准，不强制锁在工作目录内（支持浏览上级时同时预览/编辑上级文件）。
3. **内嵌浏览器** — 地址栏导航 + 沙箱 `iframe`，用于在侧栏内浏览网页。
4. **CMD 终端** — 逐行执行命令的轻量终端：`child_process.spawn(cmd.exe)` + **SSE 流**推送输出（带历史回放，刷新后重连可恢复现场）；避免 `node-pty` 原生依赖，契合绿色版零原生依赖定位。命令结果由 cmd 自行回显。
5. **任务管理（后台任务）** — 复用官方 **session/jobs 推送镜像**（`jobsBySession`）列出当前会话的后台任务（状态、标题），并可**查看 AI 读取到的输出**（`jobs.output`，从会话事件日志重放，不消费模型游标）与**请求停止**（`jobs.kill`，复用官方 jobs 注册表）。

## 引用与致谢（Reference & Acknowledgment）

本插件的**交互形态与整体设计**参考、复刻自第三方开源插件 **DSH Better Sidebar**：

- 项目名：`omdsh-dev/DSH-better-sidebar`
- 主页：<https://github.com/omdsh-dev/DSH-better-sidebar>
- 本版取其核心能力并做**对齐重构**：

  | 来源能力（Better Sidebar） | 本版取舍 |
  |---|---|
  | 文件资源管理器 / 文件预览 / 内嵌浏览器 | **保留**（核心，并放开上级目录浏览） |
  | 会话工作目录溯源（`session.header.cwd`）与工作区兜底 | **升级**（资源管理器默认根改为工作区根 `sandboxPolicy.workspaceRoot`，会话 cwd 退居兜底，保持上级浏览） |
  | 后台任务（Jobs）列表/输出/收割 | **保留**（列表走官方 jobs 推送镜像，输出/停止走 jobs.output / jobs.kill） |
  | 终端（node-pty / xterm） | **换为** `cmd.exe + SSE` 的轻量方案（绿色版零原生依赖，逐行执行） |
  | 自定义头防跨站 + DNS-rebinding / CSRF 边界 | **保留**（`X-DSH-Sidebar-Lite: 1`） |
  | Git 面板、Diff、Subagent、多分栏等 | **去除**（偏离本版本职定位） |

特此向原创作者致谢。若介意使用，可随时禁用本插件；本插件不修改任何官方文件/包。

## 工作方式（零依赖、零构建）

- **宿主端** `lib/index.js`：在 DSH 的 `webServer` 上注册路由前缀 `/__dsh/sidebar-lite/*`。
  - `session.cwd` / `fs.tree` / `fs.read` / `fs.write` / `terminal.*` / `jobs.*`：POST JSON。
  - `file`：GET 回原始媒体字节（预览 / 另存为）。
  - `terminal.stream`：GET 返回 **SSE 流**（命令输出回放 + 实时推送；`req.on('close')` 只摘监听器、不杀进程，重连复用，`terminal.kill` 才真正结束）。
  - 所有请求必须携带自定义头 `X-DSH-Sidebar-Lite: 1`，跨域页面无法伪造；路径一律按**绝对路径**处理，允许上溯浏览（安全边界从「目录围栏」让位于「自定义头 + 本地进程」）。
- **客户端** `lib/client.js`：走 `window.__ModuleLoader__.load` 注入到 WebUI，挂一个 `document.body` 上的 portal 面板（与 Better Sidebar 挂载路径一致，不依赖官方内部布局插槽），订阅 `ctx.sessions.list` 定位当前激活会话，并读取其 `jobsBySession` 生成任务列表。

## 安装 / 卸载

插件通过 `cordis.patch.yml` 以一行 bundle 插入 profile 插件树，随 DSH 服务启动加载：

```
右下角 → 插件管理 →（enable/disable dsh-sidebar-lite）
```

或直接编辑配置文件，增删 `dsh-sidebar-lite` 一行后再重启服务。

## 路由与安全一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/__dsh/sidebar-lite/session.cwd` | 解析会话权威工作目录 + 工作区根（资源管理器默认根） |
| POST | `/__dsh/sidebar-lite/fs.tree` | 列目录（目录优先、隐藏灰显、truncated） |
| POST | `/__dsh/sidebar-lite/fs.read` | 读文件（文本/二进制 head） |
| POST | `/__dsh/sidebar-lite/fs.write` | 写文件（临时文件 + rename 原子化） |
| GET | `/__dsh/sidebar-lite/file?sessionId=&cwd=&path=&download=` | 读原始字节（预览 / 另存为用） |
| GET | `/__dsh/sidebar-lite/terminal.stream?sessionId=&cwd=&tab=` | SSE 流（命令输出/回放） |
| POST | `/__dsh/sidebar-lite/terminal.open` | 确保终端进程就绪（可复用） |
| POST | `/__dsh/sidebar-lite/terminal.input` | 写入一行命令到 cmd stdin |
| POST | `/__dsh/sidebar-lite/terminal.kill` | 结束终端进程 |
| POST | `/__dsh/sidebar-lite/jobs.output` | 重放某任务 AI 已读到的输出 |
| POST | `/__dsh/sidebar-lite/jobs.kill` | 请求停止某后台任务 |

> 安全要点：
> - 所有请求走自定义头防跨站；路径以**绝对路径**为准，允许上溯浏览（用户自查范围，与 `dsh-file-browser` 一致，不再是 `isWithin` 目录围栏）；
> - 媒体文件上限 32MB、文本上限 1MB（超出置 `truncated` 只读）；
> - 终端的 SSE 流断开不杀进程（刷新/切页可重连恢复），仅「停止」按钮或 `terminal.kill` 真正结束；插件卸载时会清理全部已开终端。

## License

MIT（本插件自身代码）。设计参考来源为 `omdsh-dev/DSH-better-sidebar`，引用原则与署名见上文「引用与致谢」。