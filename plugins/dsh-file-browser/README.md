# dsh-file-browser

DeepSeek Harness 插件：在 WebUI 提供**文件列表 + 选中文件预览 + 右键添加到对话**。

- 输入框工具行左侧出现「📁 文件」按钮，点击打开/关闭右侧浮层文件浏览器。
- 面板默认从工作区根目录开始；左侧列表（目录在前、文件在后，显示大小），点击目录进入、顶部「↑ ..」返回上级、路径框可输入任意路径回车跳转。
- 点击文件，右侧立即预览：文本/代码显示等宽内容并带行数，png/jpg/gif/webp/bmp 图片直接显示。
- **右键文件/目录弹出菜单**：
  - 文件：插入文件路径到输入框 / 插入内容到输入框（内容 ≤ 3000 字符，超出截断并注明）/ 复制路径
  - 目录：插入目录路径到输入框 / 复制路径
  - 插入是**追加到输入框草稿**（不直接发消息），可编辑后再发送给模型。
- 不修改任何官方文件 / 官方包（纯插件，装进 profile 的 node_modules）。

## 工作原理

| 端 | 文件 | 作用 |
|---|---|---|
| 宿主 | `lib/index.js` | 注册本地路由（均要求 `X-DSH-File-Browser: 1` 头防跨站触发）：`GET /__dsh/file-browser/home` 返回起始目录（workspace root）；`POST /__dsh/file-browser/list` 列目录（名称/类型/大小/子路径）；`POST /__dsh/file-browser/read` 读取文件——图片返回 base64 data URL，其余按文本返回（二进制内容会被 `fs` 服务拒绝并转为错误）。 |
| 客户端 | `lib/client.js` | 加载器契约（`window.__ModuleLoader__.load`）。在 `conversation.input.left` 注册「文件」开关按钮，在 `shell.overlay` 注册右侧浏览面板（列目录 + 预览 + 右键菜单），通过 fetch 调宿主端路由；菜单的「插入到输入框」经由 input.left 条目的 `useInput`/`inputActions` 追加草稿。 |

限制：文本预览 ≤ 200KB；图片预览 ≤ 4MB（png/jpg/gif/webp/bmp）；单目录最多列 1000 项；预览只读，不提供编辑/下载。

## 安装

命令行（无需先停止服务，装完**重启服务**生效）：

```
python launcher.py --install-plugin plugins\dsh-file-browser
python launcher.py --start      # 或手动重启服务
```

或启动器 GUI：主界面「插件管理」→「手动安装」→ 选择本目录 `D:\DeepSeekHarnessLauncher\plugins\dsh-file-browser` →「重启服务」。

重启后自检：打开 `http://127.0.0.1:3080/`，页面源码 `window.__DSH_BOOT__.entries` 应含 `dsh-file-browser`。

## 升级 / 修改

改过 `lib/*.js` 后要**重新安装**才生效（pnpm 对 `file:` 是拷贝非软链）：

```
python launcher.py --remove-plugin dsh-file-browser
python launcher.py --install-plugin plugins\dsh-file-browser
python launcher.py --start      # 重启服务
```

## 卸载

```
python launcher.py --remove-plugin dsh-file-browser
# 或启动器「插件管理」→ 左侧选中后「移除选中插件」，然后重启服务。
```

## 排查

- 页面看不到「文件」按钮：确认插件已装进 profile（`runtime/dsh-home/profiles/web/package.json` 的 `dependencies` 与 `dsh.profile.bundles`）、服务已重启。
  - 常见根因：`package.json` 的 `exports` 漏了 `"./package.json"` → 客户端 bundle 不进 `__DSH_BOOT__`。**务必保留 `exports` 里的 `"./package.json": "./package.json"`**。
- 按钮点了没反应：按 F12 看网络请求是否 403（自定义头缺失）/ 405（路由未注册，常见于 `ctx.effect` 传参错误导致路由被立即注销）。
- 预览报错：F12 看 `/__dsh/file-browser/read` 的响应内容。

## 变更记录

- **v0.2.1（2026-08-15）**：修复"按钮不显示"。根因：工具行组件条件调用从 props 传入的 `useInput()` hook（`typeof useInput === "function" ? useInput() : null`），hook 身份/可用性在渲染间不稳会触发 React "Rendered more/fewer hooks" 错误、被错误边界吞掉导致组件不渲染。修复：**移除 `useInput()` 调用**，当前草稿改从 ownerProps 的 `input.draft` 读（InputZone 契约，普通数据快照，见根 `DEV_NOTES.md` 避坑 #42）。客户端 bundle 按请求生成，**改后无需重启服务，强制刷新页面即可**。
- **v0.2.0（2026-08-15）**：新增右键菜单——文件/目录右键可「插入路径/内容到输入框」「复制路径」；「添加到对话」由面板 `queueInsert` 排队、`conversation.input.left` 条目（standard-kit 的 `useInput`/`inputActions`）消费并用 `inputActions.setDraft` 追加到输入框草稿（不直接发消息）。
- **v0.1.0（2026-08-15）**：首个静态版本（由 DSH 动态插件 flst-1 转写，动态版只在进程内存、重启即失）：文件列表 + 文本/图片预览 + 路径跳转/返回上级/刷新，宿主端三个 HTTP 路由（`/__dsh/file-browser/home|list|read`，带 `X-DSH-File-Browser: 1` 头防跨站）。
  - 动态版踩坑记录见项目根 `DEV_NOTES.md` 避坑 #40（跨插槽 setState 通知不传值导致点击无响应）、#41（launcher GBK 打印 pnpm 输出崩溃）。
