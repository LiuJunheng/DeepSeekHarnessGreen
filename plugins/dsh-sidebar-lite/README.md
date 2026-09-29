# dsh-sidebar-lite（官方右侧栏 tab 类型插件）

> 三国云:「关云长千里走单骑，不另立营寨——借荆州之壁，只自备一份图籍。」
> 本插件不再自建第二列侧栏，而是作为 **官方右侧栏（`dsh-client-ui-sidebar-right`）的 tab 类型提供者**：以扩展档接管官方内置文件树，并新增一个「文本编辑」tab 类型。文档预览、内嵌浏览器、终端、后台任务一律交由官方实现。

## 定位（一句话）

**官方右侧栏的 tab 类型插件**：往官方右栏容器里注册/接管 tab 类型（`ctx.sidebarRightTabs.register` + `sidebar.right.pane.tab` 插槽注册正文），补上官方文件树没有的「任意路径上溯浏览 + 路径框跳转 + 右键菜单」，并补一个官方没有的「文本编辑」tab。

**不再自建侧栏**：不再注入 `document.body` portal，不再用 `#root` 的 `margin-right` 硬让位。折叠、分栏、浮窗、全屏、快捷键、按会话持久化布局，全部由官方右侧栏容器负责。

## 交互形态（怎么进）

官方右栏是「tab 容器 + 类型提供者」架构。本插件提供两个 tab 类型，进入方式如下。

### 1）接管官方文件树（kind `files`，id `dsh-sidebar-lite`）

- **官方引导页入口**：右栏空态的官方引导页会列出本插件声明的文件树类型卡（`guide`，绑官方命令 `workspace.files`），点它即打开本插件的文件树 tab。
- **官方快捷键**：按官方「工作区文件」命令 `workspace.files`（Web 默认 `Mod+Alt+P`）打开同一个 tab。
- **文件行单击 → 官方预览**：单击文件行调 `tab.actions.openResource(dsh-resource://file/<会话>/<路径>)`，交给**官方 `text` 类型**渲染预览。
- **文件行右键**：见下方右键菜单（「编辑」进本插件的编辑 tab；其余项由本插件处理）。

### 2）文本编辑 tab（资源类型，kind `sidebar-lite.edit`，id `dsh-sidebar-lite/edit`）

官方预览是只读的；本插件认领 `dsh-resource://edit/**` 资源地址，提供可写编辑器。

- **进入方式**：文件行右键 →「编辑」（`tab.actions.openResource(dsh-resource://edit/...)`）。
- **去重**：同一文件重复打开按**资源地址**去重，复用同一个 tab。

## 能力清单（保留项）

保留的是「官方没有、或比官方强」的部分：

- **返回上级 ⬆ + 任意路径**：头部「返回上级 ⬆」按钮、**可编辑路径框**（输入任意绝对路径回车跳转）、**「回到工作目录」按钮**（SVG 房子图标 + 「目录」文字标签，目标 = 会话工作目录 `cwd`，悬停显示实际目标路径）。
- **目录浏览细节**：目录优先排序、隐藏文件灰显、目录懒加载、单目录 1000 条截断提示。
- **右键菜单**：以官方 @ 引用插入 / 编辑 / 另存为 / 复制相对路径 / 复制绝对路径（复制成功短暂提示「已复制」）。
- **文本编辑**：就地编辑并保存回写（走本插件 `fs.read` / `fs.write`，临时文件 + rename 原子写）；文件过大截断置只读并禁止保存；二进制文件拒绝编辑。
- **官方 tab 能力的复用**：`tab.actions.openResource` / `openTab` / `bindCommands({ refresh })`（绑定官方刷新快捷键，重新读取已展开目录）/ `close`。

## 已删除能力 + 迁移去向

本次改造把「官方右侧栏已经内置的」全部删掉，改用官方实现：

| 已删除（本插件旧实现） | 迁移去向（官方） |
|---|---|
| 内嵌浏览器（地址栏 + 沙箱 `iframe`） | 官方 `browser` tab（`ui-sidebar-browser`；web profile 默认禁用，本插件已在 `cordis.patch.yml` 追加一条启用，见下） |
| CMD 终端（`cmd.exe` + **SSE 流**逐行） | 官方 `terminal` tab（真 PTY + xterm；绿色版已随附 `node-pty@1.2.0-beta.15` + `conpty.dll`） |
| 后台任务面板（列表 / 查看输出 / 请求停止） | 官方会话头部 `dsh-client-ui-jobs` 控件（同源 `ctx.jobs`） |
| 独立预览侧栏框（`right: 主面板宽` 的第二个侧栏） | 官方 tab 与官方分栏 |
| 自研折叠按钮 / 宽度拖拽 / 侧栏外壳 / `#root` 让位 | 官方右侧栏容器 |
| 宿主端 SSE + 终端/任务路由（`terminal.stream`（SSE）/`terminal.open`/`terminal.input`/`terminal.kill`/`jobs.output`/`jobs.kill`）及 `node:child_process`、`openTerminal`、`TERMINALS`、`jobOutputParts` 等实现 | 无需迁移（官方对应能力走官方自己的通道，本插件不再持有这些路由与实现） |
| 自研 i18n 脚本桥（从 `http://127.0.0.1:3081/__dsh_i18n_bridge.js` 注入的 `__DSH_I18N__`） | 官方 `ctx.locale`（见「工作方式 · 文案与样式」） |

## 接管与回滚

- 本插件的文件树类型以 `priority: "extension"` 注册，**官方内置文件树是 `builtin` 档，会被 `extension` 档自动让位**（同 kind 只渲染优先级更高者）。
- **禁用或卸载本插件后，官方内置文件树自动恢复**（无需手动改任何官方文件/包）。
- 编辑 tab 是本插件**新增**的类型（kind `sidebar-lite.edit`），官方没有同 kind 类型，不涉及让位。
- 回退到"完全没有本插件"：删掉 `cordis.patch.yml` 中本插件那一行（`id: sidebar-lite`）后重启服务。

### 官方浏览器 tab 的启用 / 回退（一行）

官方 `browser` tab 在 web profile 默认禁用；本插件在 `cordis.patch.yml` 追加了一行把它启用：

```yaml
- id: ui-sidebar-browser
  disabled: false
```

**回退方法**：删除该条目并重启服务，官方浏览器 tab 回到默认禁用状态。

## 工作方式（零依赖、零构建）

### 双入口

- **宿主端** `lib/index.js`：导出 `apply` / `inject` / `name`，`inject = ["webServer"]`；在 DSH 的 `webServer` 上注册路由前缀 `/__dsh/sidebar-lite/*`（`ctx.effect(() => ctx.webServer.register({ kind: "prefix", ... }), label)`）。
- **客户端** `lib/client.js`：走 `window.__ModuleLoader__.load({ id: "dsh-sidebar-lite", factory })`，导出 `exports.apply` / `exports.inject`；`inject = ["slots", "sessions", "sidebarRightTabs", "locale"]`。

### 客户端注册（官方两阶段契约）

```js
// 1) 接管官方文件树 (kind "files"): extension 档压过官方 builtin, 卸载后官方自动恢复
ctx.effect(() => ctx.sidebarRightTabs.register({
  id: "dsh-sidebar-lite", kind: "files", priority: "extension",
  keepMounted: true, title, guide,
}), "dsh-sidebar-lite: files type");
ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register(
  { name: "sidebar.right.pane.tab", key: "dsh-sidebar-lite", locale: "dsh-sidebar-lite" }, FilesBody,
)), "dsh-sidebar-lite: files body");

// 2) 编辑 tab: 资源类型 (认领 dsh-resource://edit/**)
ctx.effect(() => ctx.sidebarRightTabs.register({
  id: "dsh-sidebar-lite/edit", kind: "sidebar-lite.edit", priority: "extension",
  patterns: ["dsh-resource://edit/**"], canOpen, title,
}), "dsh-sidebar-lite: edit type");
// 正文 / 标题分别注册到 sidebar.right.pane.tab / sidebar.right.pane.tab.title, slot key 同为 "dsh-sidebar-lite/edit"
```

**三处名字必须一致**：`package.json` 的 `name`、`lib/client.js` 的 `ModuleLoader.load({ id })`、`lib/index.js` 的 `const name`；并且 `sidebar.right.pane.tab` 注册的 `key` 必须等于类型 `definition.id`。任一处不一致会**静默不渲染 / 静默加载失败**（不报错）。

### 资源地址：把文件身份编进地址本身（关键避坑）

**官方只持久化资源地址（`tab.contentId`），不持久化 `navigation.params`**（官方 README 明确写「导航参数、资源内容和活动连接不属于布局状态」）。因此编辑 tab 的**文件身份必须编进地址本身**，而不是放进 `params: { path }`：

- **编辑地址**：`dsh-resource://edit/session/<sessionId>/<逐段编码的绝对路径>`（`editAddressFor` / `pathFromEditAddress`）。
- **文件地址**（单击文件行用，供官方 `text` 类型预览）：`fileAddressFor(sessionId, cwd, path)` → `dsh-resource://file/session/<sessionId>/<相对或绝对路径>`。构造逻辑与官方 `@deepseek-ai/dsh-util-workspace-path` 一致但**必须内联实现**（客户端不能 `require` 官方包）；`encodeSegment` 保留盘符冒号 `:`，Windows 反斜杠归一为 `/`。

若改用 `params: { path }`：**刷新页面恢复布局后 params 丢失**，编辑 tab 会退化成「没有可编辑的文件」。编进地址本身后：刷新后仍能定位同一文件；同一文件重复打开按地址去重复用同一 tab。

### 文案与样式（官方契约）

- **多语言**：`ctx.locale.register("dsh-sidebar-lite", { zh, en })` + `ctx.locale.bind`；插槽注册带 `locale: "dsh-sidebar-lite"` 选项即可拿到 `t()`。**已删除自研 `__DSH_I18N__` 脚本桥**（原来从 `http://127.0.0.1:3081/__dsh_i18n_bridge.js` 注入）。
- **样式**：只用官方主题 token，**不写 JS 主题监听**：`--dsw-alias-label-primary/secondary/tertiary`、`--dsw-alias-border-l3`、`--dsw-alias-interactive-bg-hover`、`--dsw-alias-bg-overlay`、`--dsw-alias-state-error/success/warn-primary`、`--dsw-specific-input-major`、`--dsw-radius-sm/md`、`--dsh-content-font-size-secondary`。

### 官方输入机捕获（保留）

客户端注册一个渲染 `null` 的隐藏组件到官方 `conversation.input.left` 插槽（`ctx.slots.inject("conversation.input.left", ...)`），把 `ownerProps.inputActions` / `input`（InputZone 契约快照）存入模块级变量。右键「以官方 @ 引用插入」读其中的 `draft` / `draftRev`，经 `actx.bail(actx, "slash/input-insert-reference", { reference, span })` 派发给官方输入机 mint 成 chip（草稿显示 `@文件名`，发送时序列化为完整相对路径 mention）；派发失败仍有 DOM `execCommand` 兜底。

## 路由与安全一览

宿主端前缀 `/__dsh/sidebar-lite/*`，**全部要求自定义头 `X-DSH-Sidebar-Lite: 1`**（跨域页面无法伪造）：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/__dsh/sidebar-lite/session.cwd` | 解析会话权威工作目录 `cwd` + 工作区根（资源管理器默认根） |
| POST | `/__dsh/sidebar-lite/fs.tree` | 列目录（目录优先、隐藏灰显、懒加载、`truncated`） |
| POST | `/__dsh/sidebar-lite/fs.read` | 读文件（文本/二进制 head；文本上限 1MB，超出置 `truncated` 只读） |
| POST | `/__dsh/sidebar-lite/fs.write` | 写文件（临时文件 + rename 原子化） |
| GET | `/__dsh/sidebar-lite/file?sessionId=&cwd=&path=&download=` | 返回原始媒体字节（另存为；`download=1` 附 `content-disposition`；单文件上限 32MB） |

> 安全要点：
> - 路径一律按**绝对路径**处理，**允许上溯浏览到工作区之外**（安全边界 = 自定义头 + 本地进程，不再有目录围栏）。
> - 文本上限 1MB、媒体上限 32MB；超限按 `truncated` 只读或拒绝。
> - GET 媒体路由带不上自定义头（`<img>` / `<a>` 的浏览器限制）→ 客户端一律 `fetch(url, { headers }) → blob → objectURL`。

### 已知边界：接进官方容器 ≠ 套上官方沙箱

- **目录浏览**走本插件宿主路由（绝对路径、**无工作区围栏**，允许上溯到工作区之外）。
- **预览**走官方 Host 读取（`workspaceFiles`），**受工作区围栏限制** → 工作区之外的文件单击预览，会由官方预览器报 `outside-workspace`。
- 此时可用右键「**编辑**」（走本插件 `fs.read` / `fs.write`，无围栏）或「**另存为**」（走本插件 `GET file`）。
- 这是「接进官方容器 ≠ 套上官方沙箱」的语义差异：本插件的文件树能列出工作区外的路径，但单击预览受官方沙箱约束。

## 安装 / 卸载

插件通过 `cordis.patch.yml` 以一行 bundle 插入 profile 插件树，随 DSH 服务启动加载：

```
右下角 → 插件管理 →（enable/disable dsh-sidebar-lite）
```

或直接编辑配置文件，增删 `dsh-sidebar-lite` 一行后再重启服务。

> **改源码必须重装 + 重启**：插件通过 `file:` 依赖安装，**pnpm 是拷贝不是软链**，改完 `lib/*.js` 必须重装插件 + 重启服务才生效。

## 引用与致谢（Reference & Acknowledgment）

本插件的**交互形态与整体设计**参考、复刻自第三方开源插件 **DSH Better Sidebar**：

- 项目名：`omdsh-dev/DSH-better-sidebar`
- 主页：<https://github.com/omdsh-dev/DSH-better-sidebar>

本版取其「文件资源管理器 + 预览/编辑」核心能力，**其余一律改用官方右侧栏内置实现**：

| 来源能力（Better Sidebar） | 本版取舍 |
|---|---|
| 文件资源管理器 / 文件预览 | **保留并接管官方 files tab**（核心；放开上级 / 任意路径浏览） |
| 会话工作目录溯源（`session.header.cwd`）与工作区兜底 | **保留**（资源管理器默认根 = 会话工作目录 `header.cwd`；无会话 / 无 cwd 时回退**工作区根**，权威来源 `workspaceRegistry`；兜底链绝不落 `process.cwd()`) |
| 资源管理器「回到工作目录」按钮 | **保留 + 图标升级**（SVG 房子 + 「目录」文字标签，悬停显示实际目标路径） |
| 运行中会话定位（`current` vs `sessionId`） | **保留修复**（官方 list store 用 `current` 字段表示当前激活会话 id） |
| 内嵌浏览器 | **删除 → 官方 `browser` tab**（本插件用一行 patch 启用） |
| 终端（node-pty / xterm） | **删除 → 官方 `terminal` tab**（绿色版已随附 `node-pty` + `conpty.dll`） |
| 后台任务（Jobs）列表 / 输出 / 收割 | **删除 → 官方会话头部 `dsh-client-ui-jobs` 控件** |
| 独立预览侧栏框 / 自研折叠按钮 / 宽度拖拽 / `#root` 让位 | **删除 → 官方右侧栏容器** |
| 自定义头防跨站 + DNS-rebinding / CSRF 边界 | **保留**（`X-DSH-Sidebar-Lite: 1`） |
| Git 面板、Diff、Subagent、多分栏等 | **去除**（偏离本版定位） |

特此向原创作者致谢。若介意使用，可随时禁用本插件；本插件不修改任何官方文件 / 包。

## License

MIT（本插件自身代码）。设计参考来源为 `omdsh-dev/DSH-better-sidebar`，引用原则与署名见上文「引用与致谢」。