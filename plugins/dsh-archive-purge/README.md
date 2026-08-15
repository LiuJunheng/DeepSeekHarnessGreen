# dsh-archive-purge

DeepSeek Harness 插件：在 **WebUI 设置**里加一个「清理归档」页面，**只读展示**已归档（隐藏）的会话列表。

- 不修改任何官方文件 / 官方包（纯插件，装进 profile 的 node_modules）。
- **WebUI 侧只读**：实际启动服务时所有会话都处于"运行中"，WebUI 无法删除或恢复，故该页面只用于查看；永久删除 / 恢复请到**启动器 GUI** 操作（先停止服务 → 主窗口「数据维护」→「会话管理」→ 勾选后点「恢复选中」或「删除选中」）。
- 恢复（取消归档）：把会话 id 从 `workspace.json` 的 `archivedSessionIds` 移除，不删任何数据。
- 删除内容（由启动器 GUI / 命令行执行）：会话日志目录（`DSH_HOME/sessions/<工作区>/<会话ID>/`）+ 工作区注册表条目（`workspace.detachSession`）。
- 删除**不可恢复**，操作前有确认框。

## 工作原理

| 端 | 文件 | 作用 |
|---|---|---|
| 宿主 | `lib/index.js` | 注册本地路由 `GET /__dsh/archive-purge`（列表）+ `POST /__dsh/archive-purge`（删除，带 `X-DSH-Plugin-Purge: 1` 头防跨站触发）。POST 请求体 `{"ids": ["会话A","会话B"]}` 仅删除所选，省略 `ids` 则删除全部。 |
| 客户端 | `lib/client.js` | 在设置面板注册 `settings.section` 插槽（「清理归档」页），首次加载时 GET 列表；**只读展示**——保留列表显示与勾选/全选交互，但移除「删除所选 / 清空全部」按钮，仅提供「刷新列表」，并提示到启动器 GUI 操作 |

已知取舍：
- dsh 官方没有「取消归档/删除归档 id」接口，摘除后 `storages/workspace.json` 的 `archivedSessionIds` 里会残留一个不再指向任何会话的 id，纯属隐藏标记，不影响功能。
- `storages/session_projcache.json`（标题/统计等缓存）的旧行会残留，无害，dsh 会自行覆盖。

## 安装

需要先把服务停止（数据操作类操作要求服务停止，避免与运行中的 dsh 竞争写文件）。

### 最简单：GUI 一键

1. 启动器主界面点「插件管理」→ 右侧「手动安装」栏点 **「选择本地插件文件夹安装…」**
2. 选择本目录：`D:\DeepSeekHarnessLauncher\plugins\dsh-archive-purge`
3. 点「重启服务」（或停止后重新启动）

命令行方式（无需先停止服务，装完重启生效）：

```
python launcher.py --install-plugin plugins\dsh-archive-purge
python launcher.py --start      # 或手动重启服务
```

或手工用便携 pnpm（在 `runtime\dsh-home\profiles\web` 目录）：

```
..\..\..\pnpm-home\pnpm.cmd add file:D:/DeepSeekHarnessLauncher/plugins/dsh-archive-purge
```

重启后在 WebUI：左下角「设置」→ 左侧「清理归档」→ 可查看归档会话列表（勾选/全选交互仅作展示）。**删除 / 恢复请回启动器 GUI**：先「停止服务」→ 主窗口「数据维护」→「会话管理」→ 勾选会话后点「恢复选中」（取消归档）或「删除选中」（永久删除）。

> WebUI 只读展示、GUI 负责删除/恢复：因为实际启动服务时所有会话都处于"运行中"，WebUI 侧无法操作；而启动器「数据维护」区是在**停止服务后**直接操作本地数据文件，可彻底删除或无损恢复。
>
> 命令行等价物：`python launcher.py --restore-session <ID>`（复原/取消归档）、`python launcher.py --purge-archived`（清全部归档）与 `python launcher.py --purge-session <ID>`（删指定会话，数据维护需先停止服务）。

## 卸载

```
python launcher.py --remove-plugin dsh-archive-purge
```
或启动器「插件管理」左侧选中后「移除选中插件」，然后重启服务。

## 排查

- 设置里看不到「清理归档」：确认插件已装进 profile（`profiles/web/package.json` 的 dependencies）、服务已重启。
  - 常见根因：插件 `package.json` 的 `exports` 漏了 `"./package.json"` 导出 → 客户端 bundle 不进 `__DSH_BOOT__`。**务必保留 `exports` 里的 `"./package.json": "./package.json"`**。
  - 快速自检：`GET http://127.0.0.1:3080/` 后看页面源码里 `window.__DSH_BOOT__.entries` 是否含 `dsh-archive-purge`。
  - 改过源文件后要**重新安装**插件才生效（pnpm 对 `file:` 是拷贝非软链）。
  - **WebUI 里还是旧文案 / 还出现「删除所选」「清空全部」按钮**：说明 `node_modules` 里装的是**旧版本的拷贝**（本插件经历过"可删除→只读"两次改版，旧拷贝里带着误导文案）。重装（`python launcher.py --install-plugin plugins\dsh-archive-purge`）或直接覆盖 `profiles\web\node_modules\dsh-archive-purge\lib\client.js` 后，**强制刷新 WebUI 页面**即可生效（客户端 bundle 按请求生成，不必重启服务）。
- 按钮点了没反应 / 一直加载中：按 F12 看浏览器控制台网络请求是否 403/405。
- 结果显示 "HTTP 405"：最可能的原因是插件 `index.js` 中 `ctx.effect()` 的传参方式错误，导致路由注册后被立即注销（详见 DEV_NOTES.md 避坑 #34）。修复后需重装+重启。
- 服务日志 `runtime/server.log` 里应有插件加载痕迹；路由重复注册会报 `webserver: duplicate exact route`。