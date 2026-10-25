# dsh-skill-center · 技能中心

给 DSH Web UI 补上原生缺失的技能管理入口与聊天栏技能选择器（纯插件，零依赖、无构建步骤）。

## 功能

| 位置 | 能力 |
|---|---|
| 左侧栏「技能」入口 | 打开中央「技能中心」页面 |
| 技能中心页 | 分组展示 **官方技能（只读，bundled/runtime/preset 层）**、**我的技能（可管理）**、**其他来源（project/custom/agents，只读）**、**已停用**；支持搜索、预览 `SKILL.md`、新建、从 **ZIP 压缩包**导入（可含多个技能；也可粘贴本地文件夹 / `.md` 路径）、编辑保存、停用/启用、删除（进回收站）、在文件管理器中打开目录 |
| 聊天输入框「技能」按钮 | 弹出可搜索的技能选择器（只列用户可调用技能）；点选后向草稿插入 `/name `，发送后走原生显式调用链路（出现 Instructions 卡片），无需手动输入 `/` |

个人技能与官方技能**物理隔离**：

- 个人技能：`$DSH_HOME/skills`（绿色版 = `runtime/dsh-home/skills`），由 `@deepseek-ai/dsh-skill-filesystem` 扫描（rank 400）；
- 已停用：`$DSH_HOME/skill-center/disabled/`（移出扫描根，避免无效条目告警）；
- 回收站：`$DSH_HOME/skill-center/trash/<时间戳>-<name>/`（删除可手动恢复）；
- 官方技能：只读，不复制、不改官方文件。

## 架构

- 一个双端插件包（`dsh.bundle.patch` + `dsh.client`），与绿色版其他内置插件一致：
  - `lib/index.js`：宿主端，注册 `/__dsh/skill-center/*` HTTP 路由（仅本机回环），使用 `ctx.skills` 读取官方技能、用 Node `fs` 管理个人技能；
  - `/list` 把 `ctx.skills.list({scope})` 与磁盘扫描合并，按 personal / official / other / disabled 分组；
  - **官方判定**：`source=bundled`，或 `source=custom` 且 path 在 `<DSH 安装目录>/node_modules/@deepseek-ai/` 下。agent preset 随包技能的 `source` 仍是 `custom`，只能靠 path 区分；只按 source 分组会把官方 preset 技能错归到「其他来源」；
  - `lib/client.js`：客户端，注册三个插槽 —— `sidebar.panellist`（左侧入口）、`main`（中央页面，key `dsh-skill-center`）、`conversation.input.left`（输入框按钮与选择器）。
- 客户端不 import 任何 `@deepseek-ai/dsh-client-*` 包，样式使用 `--dsw-alias-*` 主题 token，类名 `dsc-` 前缀；中英文案自包含（`lib/client.js` 内词典，按 `<html lang>` 切换）。

## 路由（宿主端）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/list?sessionId=` | 个人/官方/其他/已停用分组列表 |
| POST | `/read` | 读取 `SKILL.md` 正文（≤256KB） |
| POST | `/create` | 新建个人技能（目录 bundle） |
| POST | `/save` | 保存个人技能正文（原子写） |
| POST | `/install-folder` | 从文件夹或 `.md` 文件导入 |
| POST | `/import-zip` | 上传 ZIP（base64）导入，支持一次导入多个技能 |
| POST | `/toggle` | 停用/启用 |
| POST | `/remove` | 卸载（移入回收站） |
| POST | `/open-folder` | 打开技能目录 |

## 错误码

响应统一为 `{ok:true,...}` / `{ok:false,code,message}`：

| code | 含义 |
|---|---|
| `NAME_INVALID` | 技能名非法（非 kebab-case / Windows 保留名 / 超长） |
| `EXISTS` | 同名个人技能已存在 |
| `OFFICIAL_CONFLICT` | 与官方技能同名（需勾选「允许遮蔽」） |
| `FRONTMATTER_INVALID` | `SKILL.md` frontmatter 缺失或格式错误 |
| `NOT_FOUND` | 目标技能不存在 |
| `TOO_LARGE` / `TOO_MANY_FILES` | 超出大小 / 文件数限制 |
| `PATH_INVALID` | 路径越界或非法（含 zip-slip） |
| `IO_ERROR` | 磁盘读写失败（Windows 占用会返回可读信息） |
| `BAD_REQUEST` | 请求体或参数错误 |
| `SKILLS_UNAVAILABLE` | `ctx.skills` 服务未启用 |
| `METHOD_NOT_ALLOWED` | HTTP 方法不允许 |

## 校验与安全

- 技能名必须是 kebab-case、非 Windows 保留名；frontmatter 必须含 `name`/`description`，`name` 与目录一致，`disable-model-invocation`/`user-invocable` 严格布尔；
- 导入复制时跳过 `.git`/`node_modules`/`__pycache__`，拒绝符号链接；单 `SKILL.md` ≤256KB，单个 bundle ≤8MB / ≤200 文件；
- 目标路径始终位于 `$DSH_HOME/skills` 内；写入用临时文件 + rename；Windows 占用时返回可读错误；
- 路由仅本机回环，不接受任意路径读写。

## ZIP 导入

- 支持布局：`<name>/SKILL.md`、ZIP 根 `SKILL.md`、单层包装目录、`skills/<name>/SKILL.md`（可一次导入多个）、根级 `<name>.md`；ZIP 内含多个技能时逐个安装，返回 `imported` / `failed`；
- 兼容 TRAE / WorkBuddy 导出的 ZIP：**显式目录条目**（如 `trae-skill-creation/`、`templates/`）会被识别并跳过，`./` 前缀路径会被规范化；
- 拖拽导入：把 `.zip` 直接拖到「技能中心」页面，松开后弹出导入确认（可勾选覆盖/遮蔽）；
- 本地文件夹：不提供系统目录选择（DSH 0.2.1-rc.3 无 `uiWorkspace/pickDirectory` 服务，`webkitdirectory` 上传在 WebView2 里拿不到文件），可在弹窗里**直接粘贴文件夹路径**导入，或先把文件夹打包成 ZIP；
- 限制：ZIP ≤12MB（上传请求体 ≤20MB），解压后总大小 ≤24MB，单文件 ≤4MB，压缩比 >200 视为 ZIP 炸弹并拒绝；
- 安全：仅支持 store/deflate；拒绝加密、ZIP64、分卷、重复条目、符号链接条目、绝对路径与 `..`（zip-slip）；解压目标做路径包含校验；
- 零依赖实现：自行扫描 EOCD + 中央目录，deflate 用 `node:zlib.inflateRawSync`；不引入第三方解压库，也不调用系统解压命令；
- 冲突：同名个人/已停用技能默认失败，勾选「覆盖」后旧技能进回收站；同名官方技能需勾选「允许遮蔽」。

## 维护要点（改代码前必读）

1. **宿主路由 handler 统一签名 `(ctx, input)`** — 不要写单参 handler，否则 `ctx` 会被当成请求体，表现为莫名其妙的 `NAME_INVALID`。
2. **插槽 `ctx.slots.inject(key, cb)` 的回调不是立即执行** — 它在插槽声明就绪时才调用；离线测试要主动调用 `cb()` 才能捕获注册。
3. **`sidebar.panellist` 与 `main` 必须成对注册，且共用同一个 id**；点击切面板由 shell 负责，插件只提供 glyph + label。
4. **停用目录必须在扫描根之外** — 不能放 `$DSH_HOME/skills/.disabled/`：provider 只跳过 `.system`，其它点目录仍会被当技能扫描并告警。正确位置是 `$DSH_HOME/skill-center/disabled/`。
5. **改了已安装插件的宿主代码不会自动热加载** — 需要 remove + add 重装（或重启 dsh）才会加载新代码；launcher 新增 bundle 本身可以热加载，但更新已有插件的 `lib/index.js` 不行。
6. **i18n**：客户端自带 zh/en 词典（按 `<html lang>`），同时监听宿主的 `dsh-i18n-change` 事件以跟随语言切换。
7. **ZIP 的显式目录条目必须先识别并跳过，再做路径校验** — TRAE / WorkBuddy 导出的 ZIP 常带 `xxx/`、`templates/` 这类目录条目，先校验会因尾部空段被判成非法路径。
8. **不要假设客户端有系统目录选择对话框** — DSH 0.2.1-rc.3 没有 `uiWorkspace/pickDirectory`；`<input webkitdirectory>` 在桌面 WebView2 里选目录后 `FileList` 为空。文件导入用 ZIP 上传 / 拖拽 / 粘贴路径。
9. **测试方式可复用**：宿主端用假 `ctx`（收集 `webServer.register` 的 handler、`skills` 打桩、`ctx.effect` 立即执行）；客户端用假 React（`useEffect` 不执行）+ 假 `document`，逐组件渲染并断言关键文案。
10. **列表的 scope**：页面无会话时只列全局层；输入框选择器用 session 作用域，能列出 agent preset 层。`sessionId` 从 `ctx.sessions.list.getSnapshot().current` 取。

## 使用

安装/生效：

```sh
# 绿色版（推荐，随包内置后自动安装）
runtime\python\python\python.exe launcher.py --install-plugin plugins\dsh-skill-center
# 或 GUI：插件管理 -> 选择本地插件文件夹安装…
```

安装/重装插件后（通常热加载即可；若入口未出现再重启 dsh 服务）：

1. 左侧栏出现「技能」；
2. 输入框左侧出现「技能」按钮，点选即可插入 `/name`；
3. 页面里可新建/导入/编辑/停用/卸载个人技能；导入用「选择 ZIP 文件…」或把 ZIP 拖到页面，也可粘贴本地文件夹路径。

## 测试

```sh
# 用绿色版自带 node（无依赖）
runtime\node\node-v22.20.0-win-x64\node.exe workspace\research\skill-center-test.mjs
runtime\node\node-v22.20.0-win-x64\node.exe workspace\research\skill-center-client-smoke.mjs
```

- 宿主端：51 项断言（路由 / CRUD / ZIP 各布局与安全用例 / 冲突 / 降级）
- 客户端：12 项冒烟（插槽注册 / 页面渲染 / 导入弹窗 / 选择器过滤）



## 兼容性与已知限制

- 目标 DSH `0.2.1-rc.3`（`sidebar.panellist` / `main` / `conversation.input.left` 插槽与 `ctx.skills` 服务均在该版本验证）；
- 若未来插槽/服务缺失，客户端只记录 `console.warn` 并跳过对应注册，不影响其他插件与页面；
- 未启用 `@deepseek-ai/dsh-skill` 的 profile：页面降级为只显示本地个人技能，并提示注册表未启用。

**暂未实现**：

- 复制官方技能为个人副本（遮蔽安装）；
- 回收站自动清理与恢复 UI（当前需手动从 `$DSH_HOME/skill-center/trash/` 恢复）；
- 给模型提供只读的 `skill_center_list` 工具（安装/卸载类操作保持仅用户可发起）。

## 版本

- `0.2.3`：移除「选择文件夹」（DSH 无目录选择服务、webkitdirectory 在 WebView2 不可靠），改为 ZIP 上传 / 拖拽 ZIP / 粘贴本地路径。
- `0.2.2`：修复「选择文件夹」点击无反应（改用 webkitdirectory 上传）；拖拽改为 document 级并支持文件夹；页面常驻拖拽提示。
- `0.2.1`：修复 TRAE/WorkBuddy ZIP 的显式目录条目被误判为非法路径；新增拖拽 ZIP 导入；官方技能无 `valid` 字段时不再误显示「格式有误」。
- `0.2.0`：新增 ZIP 导入（多技能、zip-slip / zip bomb 防护、覆盖/遮蔽选项）。
- `0.1.0`：首个版本（左侧入口 + 技能中心页 + 聊天栏选择器 + 官方/个人分组管理）。
