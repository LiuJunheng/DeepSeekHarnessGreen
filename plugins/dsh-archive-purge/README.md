# dsh-archive-purge

DeepSeek Harness 插件：在 **WebUI 设置**里加一个「清理归档」页面，一键**永久删除所有已归档（隐藏）的会话**。

- 不修改任何官方文件 / 官方包（纯插件，装进 profile 的 node_modules）。
- 删除内容：会话日志目录（`DSH_HOME/sessions/<工作区>/<会话ID>/`）+ 工作区注册表条目（`workspace.detachSession`）。
- 正在运行的会话自动跳过。
- 数据**不可恢复**，操作前有确认框。

## 工作原理

| 端 | 文件 | 作用 |
|---|---|---|
| 宿主 | `lib/index.js` | 注册本地路由 `POST /__dsh/archive-purge`（带 `X-DSH-Plugin-Purge: 1` 头防跨站触发），执行删除 |
| 客户端 | `lib/client.js` | 在设置面板注册 `settings.section` 插槽（「清理归档」页），按钮 + 结果列表 |

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

重启后在 WebUI：左下角「设置」→ 左侧「清理归档」→ 点击「立即清理归档会话」。

> 也可以不用 WebUI：启动器图形界面新增了「数据维护」区（**清理归档会话** /
> **删除会话…** 可视化列表），命令行等价物是 `python launcher.py --purge-archived`
> 与 `python launcher.py --purge-session <ID>`（数据维护需先停止服务）。

## 卸载

```
python launcher.py --remove-plugin dsh-archive-purge
```
或启动器「插件管理」左侧选中后「移除选中插件」，然后重启服务。

## 排查

- 设置里看不到「清理归档」：确认插件已装进 profile（`profiles/web/package.json` 的 dependencies）、服务已重启。
- 按钮点了没反应：按 F12 看浏览器控制台网络请求是否 403/405（跨站或方法不对）。
- 服务日志 `runtime/server.log` 里应有插件加载痕迹；路由重复注册会报
  `webserver: duplicate exact route`（一般不会发生）。
