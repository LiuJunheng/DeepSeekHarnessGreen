# DeepSeek Harness 绿色整合版启动器 · 开发记录（需求 / 设定 / 规范 / 避坑）

> 本文档按项目约定持续更新，记录需求内容、代码设定、规范细节与避坑经验。

## 一、需求内容
1. 用户希望把 DeepSeek Harness（dsh）封装成**双击即用**的形态：
   - 不做"敲命令安装 + 手动开浏览器"的传统流程
   - 自动完成：便携 Node 准备 → dsh 安装 → 服务启动 → 自动打开浏览器
2. 形态选型：用户选择 **Python GUI 启动器**（tkinter），配套 `.bat` 一键入口
3. 网络：用户选择 **镜像自动检测**（国内优先、失败回退官方）
4. 所有运行时数据（Node、dsh、会话）放在程序目录内，**绿色整合**，可整目录拷走
5. dsh 官方会持续发版，需要**检查更新**能力：GUI「检查更新」按钮 → 查询 npm 最新版 → 弹窗让用户选择更新/不更新 → 更新前**自动备份旧版本**到 `runtime/dsh-backup-<版本>`，不覆盖，备份由用户手动管理是否删除
6. 需要**可视化插件管理**：GUI 主窗口第六个按钮「插件管理」弹出新窗口，可查看已安装插件、搜索插件（npm 注册表 + GitHub 官方 `dsh-plugin` 话题页）、安装 / 移除插件
7. **数据维护需求（会话删除管理）**：dsh 官方没有"永久删除会话"功能，网页"归档"只是把会话**隐藏**（日志与注册表条目全部保留）。用户需要能**彻底删除**归档/指定会话的能力，于是：
   - 启动器主窗口新增「数据维护」区（清理归档会话 / 删除会话…可视化列表），并配套命令行 `--purge-archived` / `--purge-session <ID>`
   - 用 DSH 里的 AI 开发了 **`dsh-archive-purge`** 插件：在 WebUI「设置 → 清理归档」里一键清理归档会话（宿主端注册本地路由 + 客户端注入设置区块），并在插件管理里增加**「选择本地插件文件夹安装…」**按钮，方便安装本地插件
8. **本地插件安装优化**：手动安装栏除了 npm 包名 / `github:owner/repo#commit` 外，还支持直接选择**本地插件文件夹**（含 `package.json`）安装；`--install-plugin` 命令行同样支持传本地目录
9. **工作区不写死（自动检查解决 ACL 冲突）**：此前为解决"程序根目录工作区与 `runtime/tmp` 冲突"写死了 `workspace` 子目录；用户要求去掉写死——由启动器**自动检测**临时目录与工作区是否冲突并解析出安全的默认工作区（详见避坑 #31）
10. **清理归档支持选择会话（2026-08-15）**：WebUI「设置 → 清理归档」从"一键清空全部"升级为**列表勾选 + 选择清理**（对齐 GUI 启动器「数据维护」的可视化删除）：宿主端新增 `GET /__dsh/archive-purge` 列出已归档会话（id/标题/工作区/运行状态），`POST` 支持请求体 `{"ids": [...]}` 仅删所选、省略则清空全部；同时修复了「点击按钮报 HTTP 405」的路由注册 bug（见避坑 #34）
11. **经验沉淀为 Skill（2026-08-15）**：把本项目部署 / 维护 / 插件开发全套实测经验整理成 TRAE Skill **`dsh-deploy-maintain`**（源文件在 `skills/dsh-deploy-maintain/`，已复制安装到 `~/.trae-cn/skills/dsh-deploy-maintain/`）。结构：`SKILL.md`（主文档，部署/维护/插件/排查速查表）+ `checklists/`（deployment-checklist / plugin-dev-checklist）+ `references/`（plugin-skeleton 插件代码骨架 / data-directories 数据目录机制）。Skill 内已内置 34 条避坑浓缩版；后续新增经验要同步回 SKILL.md 与 checklists
12. **清理归档改版：WebUI 只读 + GUI 合并按钮 + 窗口放大（2026-08-15）**：
    - **WebUI「设置 → 清理归档」降级为只读展示**：实际启动服务时所有会话都处于"运行中"，WebUI 侧根本无法清理，删了也白删。于是：**列表显示保持原样**（含勾选/全选交互），但**移除「删除所选 / 清空全部」按钮**，说明文字改为引导——"删除功能已移至启动器 GUI：停止服务 → 数据维护 → 清理归档"，仅保留「刷新列表」按钮（`lib/client.js`）。
    - **GUI「数据维护」两按钮合并为单个「清理归档」**：原来 `清理归档会话`（全清）与 `删除会话…`（列表多选）语义重叠，合并为一个按钮，点击弹出会话列表弹窗（`open_purge_dialog`）：Treeview 列出标题/工作区/状态/有无日志，顶部一行「全选 / 全不选」，行点击即勾选，底部「删除选中 (N)」按钮，删除前二次确认；`on_purge` 统一入口（服务运行中弹窗提示先停止）。
    - **默认窗口放大**：主窗口默认 640x560 → **920x720**（最小 760x600），弹窗 920x540（最小 720x380），保证状态栏 + 按钮 + 数据维护 + 设置 + 日志全部**无需缩放即可完整显示**。
    - **删除的会话也一并更新**：`on_delete` 逐个 `purge_session(sid)`（服务已停止），失败项收集后统一提示，删除后自动 `refresh()` 刷新列表。
13. **WebUI 单页面去重（2026-08-15）**：多次重启服务会在浏览器累积一堆相同标签页。方案：启动器向 WebUI 前端 `index.html` 注入心跳脚本（`patch_frontend()`，幂等），页面打开后每 15 秒向启动器本地心跳服务（`127.0.0.1:3081`）上报一次；**自动打开**（「启动服务」后自动开页 / CLI `--start`）前用 `ui_is_open()` 检查最近 180 秒内是否有心跳，有则**不再打开新页面**；**手动点「打开界面」走 `open_ui(force=True)`，必定打开新页面，不受去重拦截**。心跳带令牌（`runtime/ui-beacon.token`）防其它本地页面伪造上报；令牌持久化，重启启动器后旧标签页仍能继续上报。dsh 安装/升级后由 `install_dsh()` 自动重新注入。**本经验已同步至 `skills/dsh-deploy-maintain/`（SKILL.md 2.4 节 + 速查表 + deployment-checklist），并重建 `Skill-dsh-deploy-maintain.zip`、更新 `~/.trae-cn/skills` 已安装副本。**
14. **双通道更新（绿色版自更新，2026-08-15）**：本绿色版分发给其他用户后需要两种更新——①**官方核心**（dsh npm 包，已有「检查更新」）；②**本绿色版外围**（`launcher.py` / `DSH_Launcher.exe` / `plugins/` / 文档等，从本项目 GitHub Release 更新）。两条通道**完全独立、互不干扰**：核心更新只动 `runtime/dsh/`；外围更新只动程序根目录并**跳过 `config.json`（用户配置）与 `runtime/`（用户数据/已装环境）**。外围更新流程：GUI「检查绿色版更新」→ 查 GitHub Release（官方 API 失败降级国内镜像）→ 对比版本（`GREEN_VERSION` 常量，随发布手动更新）→ 确认下载 zip 到 `runtime/update/`（带进度、校验大小）→ 解压（防路径穿越 + 检测内容根目录）→ 生成 `update_apply.bat` → **退出启动器**，由分离进程 bat 完成「等文件锁释放 → 备份旧文件到 `runtime/update/backup/` → robocopy 覆盖（跳过 config/runtime/.git）→ 重启新版」。**本经验已同步至 `skills/dsh-deploy-maintain/`（SKILL.md 2.5 节 + 速查表 + deployment-checklist），并重建 `Skill-dsh-deploy-maintain.zip`、更新 `~/.trae-cn/skills` 已安装副本。**

15. **WebUI 文件浏览与右键添加到对话（2026-08-15）**：用户要求 WebUI 增加「文件列表 + 选中文件预览」及「右键文件添加到对话」能力。先用 DSH **动态插件**（`cordis_define`/`cordis_run`，仅存在于当前进程、重启即失）快速验证功能，确认可行后转写为**静态插件 `dsh-file-browser`**（`plugins/dsh-file-browser/`，与 dsh-archive-purge 同款 bundle patch 结构，随服务启动自动加载，重启不丢、可长期维护升级，见避坑 #39）：
   - 宿主端 `lib/index.js` 注册三个本地路由（均要求 `x-dsh-file-browser: 1` 自定义头防跨站）：`GET /__dsh/file-browser/home`（起始目录 = workspace root）、`POST /__dsh/file-browser/list`（列目录：名称/类型/大小/子路径，单目录上限 1000 项）、`POST /__dsh/file-browser/read`（读文件：png/jpg/gif/webp/bmp 按扩展名走 `fs.readBytes` 返回 base64 data URL，≤4MB；其余走 `fs.readText` 按文本返回，≤200KB，二进制被 `fs` 拒绝转为错误）。复用 `ctx.get('fs')` 与 `ctx.get('sandboxPolicy')`，与模型读写同一套路径语义。
   - 客户端 `lib/client.js` 用加载器契约注入两个插槽：`conversation.input.left` 注册「📁 文件」开关按钮；`shell.overlay` 注册右侧浮层面板（列目录 + 预览 + 右键菜单：插入路径/内容到输入框、复制路径）。**「添加到对话」= 追加到输入框草稿**（不直接发消息）：面板在 root 作用域拿不到输入框 API，故走「右键菜单 `queueInsert` 排队 → 工具行按钮组件（session 作用域，standard-kit 提供 `useInput`/`inputActions`）消费，用 `inputActions.setDraft(当前草稿 + 文本)` 追加」的桥接。
   - 安装：`python launcher.py --install-plugin plugins\dsh-file-browser`（`dsh plugin` reconcile 自动加入 `dsh.profile.bundles`），重启服务生效。踩过的坑见避坑 #40/#41；根 README 第五章有使用说明。

16. **会话管理支持"恢复(取消归档)"（2026-08-15）**：用户希望归档清理不止删除，还要能**复原**——勾选会话后可选择**恢复**还是**删除**。由于 dsh 的"归档"只是把会话 id 放进 `workspace.json` 的 `global.archivedSessionIds`（日志、工作区归属、投影缓存全部保留），**复原 = 反向移除该 id**，天然无损、不删数据（"把放逐的武将召回麾下，既往不咎"）。实现：
    - 启动器新增 `restore_session(session_id)`：读 `workspace.json` → 若该 id 在 `archivedSessionIds` 中则移除并用 `_atomic_write_json`（同目录临时文件 + `os.replace`）原子写回；未归档/不存在/文件缺失均安全返回 False。
    - GUI 弹窗 `open_purge_dialog` 标题改为「会话管理 (勾选后恢复或永久删除)」，底部新增「**恢复选中 (N)**」按钮：只处理"勾选且已归档"的会话（`archived_by_id` 过滤），二次确认后逐个 `restore_session`，失败项收集统一提示，完成后 `refresh()`。
    - 「数据维护」按钮由「清理归档」改名「**会话管理**」，LabelFrame 标题改为「数据维护 (需先停止服务, 恢复不删数据)」。
    - 命令行新增 `--restore-session <ID>`（与 `--purge-session` 对称，同样校验服务未运行）。
    - **隔离测试**（`runtime/tmp/test_restore_session.py`，测完即删）：复制真实 `workspace.json` 到临时副本、monkeypatch `launcher.DSH_HOME_DIR` 指向副本，覆盖 6 个断言全部通过（恢复成功 / 归档移除 / **工作区归属保留** / 重复恢复返回 False / 恢复不存在返回 False / 测试会话确实仍在工作区）。避坑：测试会话优先选"已归档且仍归属某工作区"的 id，否则归属断言需放宽。

17. **WebUI「清理归档」文案修正 + 旧拷贝同步（2026-08-15）**：用户反馈 WebUI 里仍显示误导文案（"永久删除已归档（隐藏）的会话…勾选后点击「删除所选」或「清空全部」"），但 WebUI 实际无法删除（运行时全部会话都在运行中）。根因：**`node_modules` 里装的还是"可删除"改版前的旧拷贝**（pnpm 对 `file:` 是拷贝非软链，改 `plugins/` 源文件不会自动同步，见避坑 #30）。处置：
    - 更新 `plugins/dsh-archive-purge/lib/client.js` 说明文字为只读语义 + 指向启动器 GUI：**"这里列出的是已归档（隐藏）的会话…如需永久删除或恢复, 请在本机的启动器 GUI 操作：先停止服务 → 数据维护 → 会话管理 → 勾选会话后可「恢复选中」（取消归档, 不删数据）或「删除选中」（永久删除, 不可恢复）"**，并同步更新顶部 banner（"删除/恢复请到启动器 GUI：停止服务 → 数据维护 → 会话管理"）与文件头注释。
    - 同步两份拷贝：`--install-plugin plugins\dsh-archive-purge`（幂等重装）+ 直接覆盖 `profiles/web/node_modules/dsh-archive-purge/lib/client.js`；用 MD5 校验源文件与 node_modules 拷贝一致。
    - 验证：GET WebUI 根页从 `__DSH_BOOT__.entries` 拿 `dsh-archive-purge` 的 bundle URL，抓 bundle 确认**新文案在、旧文案（清空全部/删除所选/永久删除已归档…）已消失**——客户端 bundle 按请求生成，强制刷新页面即生效，无需重启服务。

18. **内置插件 dsh-session-rewind（会话回退，另一 AI 开发 2026-08-15）**：解决 dsh 会话被工具运行时失效（`Cannot read properties of undefined (reading 'prepare')`）**永久毒化**的问题——崩溃回合在日志里留下孤儿 `tool_calls`（有调用无结果），之后每轮都被 DeepSeek API 400 拒绝，且 DSH 0.1.0-rc.6 没有"删失败消息"的界面功能。插件在 WebUI 设置页新增「会话回退」：列出会话 →「分析」逐回合（问题/步骤/工具调用/错误码/是否完成）→ 在任意**已完成**回合点「回退到此」走官方 `session.fork`（`{sessionId, atSeq}`）派生干净续接会话并自动打开；原会话保留。关键设计：**"派生新会话"而非"原地删消息"**——服务运行时会话由持久化层内存缓存，原地改写磁盘日志会被内存覆盖或产生 seq 断裂；`session.fork` 与官方 UI"分支"同源（官方只暴露末位回合，本插件放开到任意回合）。宿主端 `lib/index.js` 直接按磁盘扫描 `DSH_HOME/sessions/**/session.jsonl.zstd`（zstd 多帧），用官方 `@deepseek-ai/dsh-session` 的 `decodeStorageRecord` 展开事件（对 chunk-run 打包行布局无关）；接口 `GET /__dsh/session-rewind/list`、`GET /__dsh/session-rewind/inspect?id=<ID>`，均要求自定义头 `X-DSH-Plugin-Rewind: 1` 防 CSRF。配套 `tools/`：`rewind-session.mjs`（服务停机时离线原地截断，自动备份）、`apply-agentloop-guard.mjs`（给 dsh-agent-loop 工具派发入口加存在性检查，幂等）。安装：`--install-plugin plugins\dsh-session-rewind`，依赖 `@deepseek-ai/dsh-session@0.1.0-rc.6`。相关讨论 DeepSeek Harness #1959 / #1974。**（2026-08-16 改版：列表与逐回合明细重设计为卡片式布局，与 dsh-usage-stats 同风格——会话卡片标题独占整行完整换行、下方 ID 与元信息 chips（工作区/创建时间/状态）；逐回合卡片用户问题独占整行完整可读、下方回合号/步骤/工具调用/错误徽标/未完成标记/「回退到此」按钮；实测零报错。）**
19. **update_apply.bat 延迟机制修复：ping → wscript + sleep_helper.vbs（2026-08-16）**：v1.0.3 自更新实测，覆盖脚本 `runtime/update/update_apply.bat` 的等待延迟用 `ping -n`，在**分离进程（无控制台、stdin 重定向 DEVNULL）**里逐次调用 `ping.exe` 会：
   - **窗口闪烁**：分离进程无控制台，cmd 调用控制台程序 `ping.exe` 时 Windows 为它**新建一个控制台窗口**，等待循环里每 1 秒弹一个、闪一下就退；
   - **安装卡死**：用户机器上系统 `ping.exe` 损坏（启动报 `0xc0000142` = DLL 初始化失败），每次弹错误框、永远睡不到 → 覆盖安装始终不完成；
   - 补充：`timeout`/`choice` 在 stdin 被重定向（DEVNULL）时直接报错退出，根本睡不了（旧方案已踩过）。
   修复：`_write_update_bat()` 在 `runtime/update/` 同目录生成 `sleep_helper.vbs`（内容 `WScript.Sleep CLng(WScript.Arguments(0))`），延迟统一改 `wscript.exe "%~dp0sleep_helper.vbs" <毫秒>`。`wscript.exe` 是 **GUI 子系统**（调用时不会新建控制台窗口，全程无闪窗）、Windows 全自带（不依赖可能损坏的外部 exe）、`WScript.Sleep` 延迟精确。详见避坑 #46。
20. **版本号双来源不同步修复：GREEN_VERSION 常量为唯一来源（2026-08-16）**：v1.0.3 发布后发现本地启动器显示版本号恒为 1.0.1、反复提示更新——根因是 `DEFAULT_CONFIG` 残留 `"green_version": "1.0.1"` 默认值（发布时只改了 `GREEN_VERSION` 常量），而 `green_local_version()` 走 `config.get()` 合并默认值 → 本地恒显示 1.0.1。修复：
   - `DEFAULT_CONFIG` 删除 `green_version` 默认值（`GREEN_VERSION` 常量成为**唯一来源**）；
   - `green_local_version()` 改为**直接读原始 `config.json`**（不读合并默认值）判断用户是否显式覆盖。
   教训：版本号默认值必须单点存放；改 `launcher.py` 后必须重打 exe + 绿色 zip 并替换 Release 资产（先删旧资产再传，否则 422）。提交 `ccc6bdb`。
21. **绿色版 zip 目录结构修复：插件不得被丢到 plugins 外面（2026-08-16）**：用户发现自动更新解压覆盖后**4 个插件目录（dsh-archive-purge / dsh-file-browser / dsh-session-rewind / dsh-deploy-maintain）被覆盖到程序根目录、而非 `plugins/` / `skills/` 下**——覆盖落点错误。根因：**发布侧 `Compress-Archive -Path` 传了 `"plugins\dsh-archive-purge"` 这类子路径**，PowerShell 会把该目录**直接打在 zip 根、丢掉 `plugins/` 前缀**；解压后 `_detect_zip_content_root()` 把内层当内容根，`robocopy` 就把这些目录整体拷到程序根目录（更糟的是根目录的 `launcher.py` 等也可能被旧结构覆盖错位）。修复（双保险）：
   - **① 发布侧（治本）**：README 的打包命令改为传**目录名** `"plugins"` / `"skills"`，zip 内保留前缀；打包后 `tar -tf` 确认 zip 根下有 `plugins/`、`skills/`。
   - **② 更新侧（容错）**：`launcher.py` 新增 `_normalize_update_structure(content_root)`——解压后把内容根下错位的已知插件/skill 目录**归位**到 `plugins/` / `skills/`（正确位置已存在则跳过，以 zip 内正确结构为准）；`update_apply.bat` 新增**第 2.5 步**清理程序根目录的错位残留（`if exist ... rmdir /s /q`，只删这 4 个已知旧目录，绝不碰用户数据/config/runtime）。
   - **验证**：`runtime/tmp/test_normalize_update_structure.py` 3 个用例全过（旧版错位归位 / 新版正确结构不动 / 新旧混合正确位置优先）。详见避坑 #47。
22. **启动器右上角「关于」入口（2026-08-16）**：用户要求主窗口右上角加「关于」按钮，弹出弹窗展示：作者（刘俊亨）、本仓库地址、引用的官方 dsh（`@deepseek-ai/dsh`，即 DeepSeek Harness）与其官方仓库（`github.com/deepseek-ai/deepseek-harness`）、版本号、版本日期。实现要点：
   - 按钮放在**状态栏 `status_frame`** 最右侧（`side="right"`，其余控件均为 `side="left"`，pack 先左后右不重叠）；
   - 弹窗用 `tk.Toplevel` + `transient(root)` + `grab_set()` 做模态，信息用两列 `grid`（灰色标签 / 黑色取值）；
   - 版本号显示 `"v" + GREEN_VERSION`（带 v 前缀更友好）、版本日期直接取 `GREEN_VERSION_DATE` 常量——与自更新版本号同源，避免再次出现"双来源不同步"（见需求 #20）；
   - 「打开本仓库 / 打开官方仓库」按钮用 `webbrowser.open()` 打开链接；链接地址与 `GITHUB_REPO` 常量一致（此处因弹窗需要完整 URL 而显式写出，后续若仓库迁移需一并同步）。
   - **验证**：`runtime/tmp/smoke_about.py` 冒烟测试通过（真实启动 GUI → monkey-patch `tk.Tk.mainloop` 自动点击「关于」→ 校验弹窗含全部关键文本与 3 个按钮 → 自动关闭）。注意：**不能 monkey-patch `tk.Toplevel`**（会破坏 `tkinter.filedialog`/`simpledialog` 里 `class Dialog(Toplevel)` 的类继承，报 `TypeError: function() argument 'code' must be code`），改用 `winfo children .` + `nametowidget` 枚举顶层窗口。
   - **2026-08-16 扩充「绿色整合·本地化」说明**：用户希望关于弹窗更详细地说明绿色版特点，特别是**所有文件与依赖全部本地化**。做法：子标题改为「绿色整合版 · 所有文件与依赖全部本地化」，信息表下方新增 `local_frame` 区块（绿色粗标题「绿色整合 · 本地化特点」+ 6 条要点 Label，`wraplength` 用默认整行、逐行 `anchor="w"` 排列），内容涵盖：双击即用免安装、运行时依赖全在根目录 `runtime/` 下（便携 Node / 内置 Python / dsh / npm-pnpm 缓存 / 会话数据 / 临时文件）、不写用户主目录 / 不改系统环境变量 / 不占 C 盘默认路径、整目录拷贝即用、更新不覆盖 `config.json` 与用户数据。弹窗高度 `480x330 → 480x500`。**验证**：`runtime/tmp/smoke_about_localized.py`（复用 monkey-patch mainloop 自动点击方案）PASS，6 项关键词全命中。注意冒烟测试前**先确认无残留进程持有单实例互斥量**（`runtime/tmp/probe_mutex_state.py` 检查），否则 run_gui 的单实例检测会走"激活旧窗口"分支直接 return、根本进不了 mainloop。
23. **本地插件安装默认目录指向本仓库 plugins/（2026-08-16）**：用户反馈插件管理里「选择本地插件文件夹安装…」每次打开默认落在 **C 盘**（tkinter `askdirectory` 未指定 `initialdir` 时用系统记忆的上次位置/默认目录）。修复：`on_install_local()` 里给 `filedialog.askdirectory` 加 `initialdir=os.path.join(BASE_DIR, "plugins")`（`BASE_DIR` 为程序根目录，frozen 取 exe 所在目录）；若该目录不存在则回退 `BASE_DIR`，确保始终停在本地仓库内、可一键选内置插件源码。配套说明已同步 README（手动安装栏）与 SKILL.md（3.x 插件管理）。
24. **X 关闭二次确认 + 最小化到系统托盘（2026-08-16）**：用户担心误点右上角 X 直接退出，且希望最小化后**从任务栏消失、缩到系统托盘后台运行**。实现：
    - **X 二次确认**：`on_close(confirm=True)` 在退出前弹 `messagebox.askyesno("确认关闭", "确定要退出启动器吗?\n\n退出会同时停止 dsh 服务。")`；绿色版自更新流程调用 `on_close(False)` 跳过重复询问（此前已确认过）。确认后先 `tray_icon.dispose()`（移除托盘图标 + 还原窗口过程）再停服务销毁窗口。
    - **最小化到托盘**：新增 `SysTrayIcon` 类（纯 `ctypes` + Win32 API，零第三方依赖）：
      - `Shell_NotifyIconW` 添加/移除托盘图标（`_NOTIFYICONDATAW` 结构，Vista+ 版本）；图标取 `WM_GETICON` → 类图标 → 兜底 `LoadIconW(IDI_APPLICATION)`；
      - 用 `SetWindowLongPtrW` 子类化窗口过程（`WINFUNCTYPE` 回调 + `ctypes.cast` 取地址，避免 64 位指针截断）拦截两条消息：`WM_SYSCOMMAND/SC_MINIMIZE`（点最小化 → `on_minimize` → 加托盘图标 + `root.withdraw()` 隐藏窗口，**不占任务栏**）与自定义 `WM_TRAY_CALLBACK`（`WM_LBUTTONUP`/`WM_RBUTTONUP` → 左/右键单击托盘图标都恢复窗口）；拦截后必须调用原窗口过程 `CallWindowProcW` 放行其余消息；
      - `minimize_to_tray`：`tray_icon.add()` 成功才 `withdraw()`（添加失败罕见，回退系统默认最小化到任务栏）；`restore_from_tray`：`remove()` 图标 + `deiconify()` + `lift()` + `focus_force()`。
    - **关键避坑（实测定点）**：
      - **窗口过程挂钩必须在 `__init__` 里装，不能放在 `add()`**：若等 `add()` 才挂钩，第一次点最小化时托盘图标还没出现 → 漏拦截，窗口会进任务栏而非托盘（冒烟测试 `smoke_gui3` 复现 `minimized=0`）；
      - **`remove()` 不能还原窗口过程**：还原窗口后再次最小化需要挂钩保持；`remove()` 只删托盘图标，`dispose()`（退出前调用）才 `_unhook_wndproc()` 还原，避免窗口销毁后回调对象悬空；
      - ctypes 显式设置 `argtypes`/`restype`（`c_ssize_t` 等），避免 64 位下句柄/指针被截断；`Shell_NotifyIconW`/`SetWindowLongPtrW` 需传整数指针（`ctypes.cast(..., c_void_p).value`），不能直接传 `WINFUNCTYPE` 回调对象。
    - **验证**：`runtime/tmp/smoke_tray.py`（添加/移除幂等）、`smoke_tray2.py`（第一次最小化进托盘 + 恢复后再最小化仍进托盘，覆盖上述两个 BUG）、`smoke_gui3.py`（端到端启动 `run_gui`：模拟最小化 → 托盘 → 恢复 → WM_CLOSE 弹二次确认）全部通过。
25. **修复「最小化仍进任务栏、托盘无图标」（2026-08-16）**：需求 #24 落地后用户实测最小化还是落到任务栏，托盘没有图标。逐层排查出三个根因，最终方案如下：
    - **根因 1：`winfo_id()` 返回的是 Tk 内部子窗口（类名 `TkChild`），不是真实顶层窗口（类名 `TkTopLevel`）**。Tk 在 Windows 上为一个顶层窗口创建两个窗口：外层带标题的 `TkTopLevel` + 内层内容区 `TkChild`；`root.winfo_id()` 返回内层。WM_SYSCOMMAND / 托盘回调消息都发到**顶层窗口**，若把钩子挂在子窗口上，最小化消息永远收不到。且**构造时若窗口尚未真正映射（realize），`TkTopLevel` 还没创建**，此时 `GetAncestor(GA_ROOT)` 仍返回子窗口句柄（探针 `probe_hierarchy` 实证：`GetAncestor` 结果 == `winfo_id` == `TkChild`）。修复：`SysTrayIcon.__init__` 里先 `tk_root.update_idletasks()` 强制 Tk 完成窗口创建，再 `GetAncestor(inner, GA_ROOT)` 拿真实顶层 HWND。
    - **根因 2：WndProc 回调里直接调 `root.after(0, ...)` 重入 Tcl 会崩**。在窗口消息派发中途（ctypes 回调）里调用 Tk 的 `after`/`withdraw`，会让 Tcl 在消息派发中被重入，下一轮 `update()`/`mainloop` 时报 `PyEval_RestoreThread: the function must be called with the GIL held, but the GIL is released`（探针 `probe_tray_fix` 实证）。修复：**WndProc 里只允许做纯 Python 赋值**——拦截到 `SC_MINIMIZE` 就置 `_minimize_pending=True`、托盘点击就置 `_restore_pending=True` 并 `return 0`；`run_gui` 里新增 `poll_tray_loop()`（`root.after(80, ...)` 常驻轮询）调用 `tray_icon.poll()`，在**正常的 Tk 事件上下文**里消费标志、执行最小化/恢复。
    - **根因 3：`--windowed` exe 下 `sys.stderr=None`**，WndProc 里的调试输出一写就抛异常被 ctypes 吞掉 → 消息被"吃掉"却无动作。修复：移除回调内所有输出 + 全程 try/except，异常一律放行给原窗口过程。
    - **验证（全部通过）**：`probe_tray_real.py`（外部起真实 GUI + PostMessage SC_MINIMIZE → `判定 C: IsWindowVisible=0`）；`probe_tray_roundtrip.py`（最小化 → 隐藏 → 发 `WM_TRAY_CALLBACK`(lparam=WM_LBUTTONUP) → 恢复显示，完整回路 OK，注意首次轮询需稍等 >2s）；`probe_tray_exe.py`（直接起打包后的 `DSH_Launcher.exe`，判定 C 通过）。
    - **另注**：探针判定 A（IsIconic=TRUE）说明钩子没拦截到消息；判定 B（可见且非图标化）说明拦截了但 `add()`/隐藏未生效；判定 C（不可见）才是托盘路径成功。

26. **自定义 DSH 绿色版图标（2026-08-16）**：用户反馈启动器用的是 PyInstaller 默认图标（任务栏/托盘/exe 都是"小火箭"，分不清这是 DSH 绿色版）。设计并接入专属图标：
    - **方案**：用 seedream 生成 4 个候选（A 绿色小鲸鱼 / B 青龙盾徽 / C D 字闪电标 / D 蜀汉军旗），用户选定 **A 绿色小鲸鱼**（DeepSeek 品牌鲸鱼 + 金色启动闪电，绿色传达"绿色版"）。源图 `runtime/tmp/icon_design/option_a_green_whale.jpg`（1024 方形）。
    - **转 ICO**：`convert_ico.py` 用 Pillow（临时装到 `runtime/tmp/pillow_convert/`，不碰系统 Python / C 盘）按短边居中裁方后 `image.save(..., format="ICO", sizes=[16,24,32,48,64,128,256])` 生成 `DSH_Launcher.ico`（84KB，7 尺寸）。
      - **避坑**：ICO 保存不能 `append_images` 手动塞帧（会得到仅 600 多字节的空壳），直接传 `sizes` 让 Pillow 内部缩放；生成后回读 `Image.open(...).info.get("sizes")` 应得 7 个尺寸。
    - **三处接入（launcher.py）**：新增 `get_icon_path()`（frozen 时从 onefile 临时目录 `_MEIPASS` 取 `DSH_Launcher.ico`，源码模式取程序根目录，找不到返回 None）：
      - **窗口图标**：`root.iconbitmap(icon_path)`（try/except 静默降级）；
      - **托盘图标**：`SysTrayIcon._get_icon()` 优先 `LoadImageW(None, icon_path, 1, 0, 0, 0x10|0x40)`（IMAGE_ICON + LR_LOADFROMFILE|LR_DEFAULTSIZE）从 .ico 文件加载 HICON，失败再退回 `WM_GETICON` → 类图标 → `LoadIconW(IDI_APPLICATION)`；
      - **exe 图标**：`build_exe.bat` 加 `--icon "%~dp0DSH_Launcher.ico"`（exe 文件图标）+ `--add-data "%~dp0DSH_Launcher.ico;."`（运行时窗口/托盘可用）。
        - **避坑**：`--add-data` 的源路径按 **spec 目录**（`--specpath build`）解析，必须写绝对路径 `%~dp0...`，否则报 `Unable to find '...\build\DSH_Launcher.ico'`；而 `--icon` 按当前目录解析可直接写相对路径。
    - **验证**：`verify_icon.py`（不开 GUI）——ICO 文件头 `00000100` 合法；`shell32.ExtractIconExW(exe, 0, ...)` 数出 exe 内嵌 1 个图标；`launcher.get_icon_path()` 返回正确路径且 `LoadImageW` 拿到有效 HICON。注意 **`ExtractIconExW` 在 shell32.dll**（不在 user32）。已重打 `DSH_Launcher.exe`（9.2MB，含图标）。
    - 相关经验已同步 `skills/python-tkinter-desktop-dev.zip`（6.10 自定义 .ico 小节 + 检查清单 + 新模板）+ `skills/dsh-deploy-maintain/SKILL.md`（3.x 启动器 GUI 增强）。
27. **内置插件 dsh-usage-stats（用量统计，2026-08-16，另一 AI 开发）**：用户希望知道每个对话实际消耗了多少 token。插件在 WebUI 设置页新增「用量统计」面板，并提供消息行 token 显示（见 #28）。**宿主端** `lib/index.js` 复用 session-rewind 的扫描解码机制（`DSH_HOME/sessions/**/session.jsonl.zstd` zstd 多帧 + 官方 `decodeStorageRecord`），对每条 `assistant/message` 事件的 `usage`（`inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`/`reasoningTokens`）按模型聚合，模型名取 `message.source.model`；路由 `GET /__dsh/usage-stats/list`（全会话汇总）+ `GET /__dsh/usage-stats/detail?id=`（逐回合明细），均要求自定义头 `X-DSH-Usage-Stats: 1` 防跨站。**费用估算在客户端**：日志不含费用，前端价格表（元/每百万 tokens，localStorage 键 `dsh.usageStats.prices.v2` 持久化，可编辑增删模型、恢复默认）按**官方计费口径**估算——`费用 = 输入(未命中缓存) × 未命中单价 + 输入(命中缓存) × 命中单价 + 输出 × 输出单价`（字段映射：`inputTokens + cacheWriteTokens` 写入缓存的输入按未命中价 → 未命中列、`cacheReadTokens` → 命中列、`outputTokens` → 输出列、`reasoningTokens` 已计入输出不重复计费）；**默认价格取自 DeepSeek 官方定价页**（2026-08-16 无头浏览器抓取：v4-flash 命中 0.02/未命中 1/输出 2，v4-pro 0.025/3/6，单位元/百万 tokens；2026-08-17 00:00 起官方改为峰谷定价——高峰 9:00-12:00/14:00-18:00 为低谷 2 倍，默认价未含时段系数，UI 有提示按实际修改）。**客户端** `lib/client.js` 设置页布局迭代两次：初版横向表格（列宽固定）→ 用户反馈「标题格子太窄、只显示半个字」→ **重设计为卡片式纵向布局**：会话卡片（标题独占整行可换行 + ID + 元信息 chips 自动换行）+ 逐回合卡片（用户消息独占整行完整可读，下方回合号/步骤/工具调用/输出 tk/估算/模型/状态）。
28. **消息行「本次token」显示 + 插件合并（2026-08-16）**：用户希望对话框里能看到每回合具体 token 数字（官方悬停只显示用时/首token/速率）。先做独立插件 `dsh-turn-tokens`：走官方链式插槽 `conversation.chat.turnTail`（操作行上方内容区，`select` 返回 `{turn, seq}`，组件用 `useSession` 读快照，把本回合所有 `assistant` 节点的 `usage` 求和），右对齐常驻显示。用户随后要求**与用量统计合并成一个插件统一安装/卸载**——`dsh-turn-tokens` 的功能并入 `dsh-usage-stats`（v0.2.0，一个插件 = 设置面板 + 消息行显示），并删除独立插件；同时消息行显示加「**本次token：**」前缀（否则旁人看不出是 token 数字）。**另记 `dsh-message-actions`（消息操作增强）的完整生命周期**：先做「重新生成 + 复制含思考」→ 安装后**服务启动即退出**（缺宿主端 `lib/index.js`，见避坑 #49）→ 补文件后功能正常 → 用户实测「重新生成」语义 = fork 到上一回合结束 + 手动重发提示词（并非原地覆盖，dsh 架构不支持），**价值有限**（复制官方已有、删除/回退被 `dsh-session-rewind` 与启动器会话管理覆盖）→ 用户决定废弃，已卸载并删除源码。教训：**给官方已有能力做"重复插件"前先确认扩展点覆盖了什么**；本项目的价值插件是"官方没有的"（清理/回退/统计）。
29. **单实例检测（2026-08-16）**：用户反馈可能多次打开 DSH 启动器，重复起服务浪费资源。实现**命名互斥量 + 旧窗口激活**机制：
    - **互斥量**：`CreateMutexW` 创建命名互斥量 `DSH_Launcher_GreenPortable_SingleInstance`（`kernel32`），`GetLastError` 返回 `ERROR_ALREADY_EXISTS`(183) 即表示已有实例在运行。
      - **关键避坑**：互斥量句柄必须由实例**在整个生命周期内持有**（存模块级 `_SINGLE_INSTANCE_MUTEX_HANDLE`），否则 Python 释放句柄后互斥量对象消失，之后再开的实例会误判为第一个，单实例形同虚设。
      - 创建失败（句柄为 0，极罕见）时降级放行，仅失去单实例保证，不影响启动。
    - **旧窗口激活**：`_activate_existing_launcher()` 用 `FindWindowW(None, WINDOW_TITLE)` 查找已运行窗口 → `ShowWindow(hwnd, SW_RESTORE=9)`（同时恢复最小化与隐藏）→ `SetForegroundWindow` → `BringWindowToTop` 兜底。
      - 验证通过三种状态：正常显示（保持可见）、最小化到任务栏（`IsIconic=TRUE`→恢复为非图标化）、隐藏到托盘（`IsWindowVisible=FALSE`→恢复为可见）。
    - **插入位置**：`run_gui()` 开头、`Launcher()` 实例化之后、`tk.Tk()` 创建主窗口之前——避免重复起服务 / 重复初始化再退。
    - **降级重试**：互斥量存在但 `FindWindow` 找不到窗口（旧实例还在初始化），短等待重试 10 次（每次 0.3s），仍失败则弹 warning 提示用户手动处理残留进程。
    - **窗口标题常量化**：将原 `root.title("DeepSeek Harness 一键启动器")` 提到模块级常量 `WINDOW_TITLE`，使 `_activate_existing_launcher` 和 `run_gui` 共用同一字符串，避免硬编码不一致导致找不到窗口。
    - 验证：`verify_single_instance.py`（互斥量创建/释放幂等）+ `verify_activate_window.py`（真实窗口三种状态激活）。已重打 `DSH_Launcher.exe`（9.2MB）。
    - 相关经验已同步 `skills/dsh-deploy-maintain/SKILL.md`（3.8 小节）+ 代码设定表。

30. **安装进度实时显示：npm/pnpm/插件命令改为流式逐行输出（2026-08-16）**：用户反馈首次安装环境时 dsh 用 npm 安装要等很久（沙箱实测约 3 分钟、587 个包），界面全程无输出（原实现用 `subprocess.run` 一次性捕获，装完才回显最后 15 行），看起来像"卡死/报错"。改造：
    - **新增 `Launcher._stream_subprocess(command, cwd, env, timeout=None, log_prefix="")`**：改用 `subprocess.Popen` + 管道逐行读取，每行非空输出**实时**打到日志（GUI 日志框 / CLI 终端），返回 `(退出码, 完整输出文本)`。
      - **后台读取线程**：读取循环放 daemon 线程（`for line in process.stdout`），防止管道写满阻塞子进程；线程读到的每行调 `self.log("%s%s" % (log_prefix, text))`。
      - **超时保持兼容**：`process.wait(timeout=...)` 超时后 `process.kill()` 再抛 `subprocess.TimeoutExpired`（与原 `subprocess.run(timeout=...)` 行为一致）；读取线程用 `join(timeout=5)` 限时等待，避免子进程派生的孙进程仍持有管道句柄导致 join 永久阻塞（输出内容已完整收集，不影响返回）。
      - **行前缀**：`log_prefix` 区分来源（dsh/pnpm 用 `"npm: "`，插件命令用 `"plugin: "`）。
    - **三处接入**：`install_dsh()`（首次装 dsh）、`install_pnpm()`（装 pnpm，保留 timeout=300）、`run_plugin_command.execute_once()`（插件安装/移除/启停，保留 timeout=600，返回 `(退出码, 输出文本)` 契约不变）。
    - **注意**：npm 在 stdout 非 TTY（管道）时不会输出花哨进度条，而是逐行 `npm notice`/`added N packages` 文本——所以逐行显示即能看到进度与耗时。
    - 验证：`runtime/tmp/test_stream_subprocess.py`（模拟 5 行间隔输出 + stderr + 退出码 3）PASS——逐行实时收到（约 1.0s 全程）、前缀正确、退出码与完整输出正确。
31. **局域网远程访问 WebUI（2026-08-16）**：用户希望服务端部署在一台电脑，WebUI 从局域网内其它电脑的浏览器远程打开（未来还可能用 WebUI 连不同地址的服务器）。已确认决策：**直接绑定 `0.0.0.0`**（推荐）+ **GUI「网络设置」区 + config.json** 双配置入口 + **整个局域网开放**（信任围栏自动信任全网段 IP，属预期权衡）。改动：
    - **配置项**：`DEFAULT_CONFIG` 新增 `dsh_host`（默认 `127.0.0.1`；`"0.0.0.0"`=局域网可访问）与 `trusted_hosts`（list，默认空；host 或 host:port，追加到 `--trusted-host`）。`trusted_hosts` 语义：**空=局域网模式自动信任全部局域网 IP；填了任意一个=只信任显式填写的地址**（见下「精确语义补丁」）。
    - **启动命令**：`build_server_command()` 从 config 读 `dsh_host` / `trusted_hosts`，追加 `--host` / 多个 `--trusted-host` 参数（值 strip 后非空才传）。
    - **放开 0.0.0.0 补丁**：dsh 官方 `startup.js` 显式 `if (options.host === "0.0.0.0") program.error(...)` 拒绝绑定 0.0.0.0（防向局域网暴露远程工具执行能力），**唯一需要补丁的点**（schema 本身允许 0.0.0.0）。新增幂等方法 `patch_web_startup()`：把该条件替换为 `false /* dsh-launcher: 已放开 0.0.0.0 以支持局域网访问 */`（marker 已替换则直接返回 True）。两个调用点：`install_dsh()` 末尾（升级重装后自动重打）+ `start_server()` 启动前兜底。
    - **受信任主机精确语义补丁（2026-08-16 优化）**：官方 `resolveLanTrust` 在绑定 0.0.0.0 时**无条件** `trustedHosts: [...lanAddresses, ...extra]`（把全部局域网 IP 并入信任列表），导致用户填了 `trusted_hosts` 仍全局域网放行（"填了也白填"）。新增幂等方法 `patch_lan_trust()`：把该行替换为 `extra.length === 0 ? [...lanAddresses, ...extra] : [...extra]`（即**空=默认自动信任全部局域网；非空=只信任显式填写的**，`lanAddresses` 字段保留供 LAN 地址显示）。同样两个调用点 `install_dsh()` + `start_server()`。注：dsh 信任围栏是**按请求 Host（服务器地址）**判定的，非按客户端设备 IP——「只信任填写的」等价于"只允许通过填写的服务器地址访问 /api"，更精细的按客户端限制需另加鉴权层。
    - **心跳适配局域网**：`patch_frontend()` 注入的心跳脚本由硬编码 `http://127.0.0.1:<port>` 改为 `"http://" + location.hostname + ":<port>..."`（页面自动用其所在主机名上报，远程浏览器也能上报）；心跳服务 `_ensure_ui_beacon_server()` 绑定地址随 `dsh_host` 变化——`0.0.0.0` 时绑 `0.0.0.0`，否则 `127.0.0.1`（远程页面可访问）。
    - **GUI「网络设置」区**（设置在「设置」LabelFrame 上方新增独立 `network_frame`）：第 0 行「服务绑定」只读下拉（`本机 (仅本机访问 127.0.0.1)` / `局域网 (允许局域网访问 0.0.0.0)`，初始值按 `dsh_host`）；第 1 行「受信任主机」文本框（逗号分隔，初始值按 `trusted_hosts` 逗号拼接）；第 2 行说明文字（**不填=绑定局域网时自动信任全部局域网 IP；填了任意一个=只信任填写的地址**）；第 3 行「保存网络设置」并入 `on_save`（解析绑定→`dsh_host`，按逗号/空白拆分 strip 去空→`trusted_hosts`，保存后提示下次启动服务时生效）。
    - **就绪日志显示局域网地址**：新增 `lan_addresses()`（`socket.getaddrinfo` 枚举本机非 127. 的 IPv4，仅提示用途、错误静默）；服务就绪日志在 `dsh_host == "0.0.0.0"` 时追加 `http://<本机IP>:<端口>` 局域网访问地址行供分享。
    - **安全边界（预期行为）**：`trusted_hosts` 为空且绑定 0.0.0.0 时，dsh 的信任围栏（`resolveLanTrust`）**自动把全部非内网 IPv4 加入 trustedHosts** → 局域网浏览器可访问 `/api` 正常聊天/用工具；`trusted_hosts` 非空时（补丁后）只信任显式填写的地址。无论哪种，`PRIVILEGED_METHODS`（settings/credentials/host.pickDirectory 等特权方法）**仍仅回环可调** → 远程浏览器不能改设置与凭据（安全保护）。
    - 验证：单元冒烟（`patch_web_startup()` 幂等 + `build_server_command()` 传参正确）→ 本机回归（默认 127.0.0.1 行为不变）→ LAN 实测（本机 127.0.0.1 与局域网 `<服务器IP>:3080` 均可打开、聊天/工具正常、远端改设置返回 403）；精确语义用 `runtime/tmp/smoke_lan_trust.py`（8 项：`patch_lan_trust()` 幂等 + node 执行补丁后逻辑——空=含局域网、非空=只含填写项、本机模式=只含填写项 + 传参正确）PASS。**已同步 `skills/dsh-deploy-maintain/SKILL.md`（3.x 局域网访问小节）并重建 `Skill-dsh-deploy-maintain.zip`。**

32. **任务栏 + 托盘图标双常驻；产品名改为「绿色整合版」（2026-08-16）**：用户实测发现——最小化后**任务栏图标消失**（旧逻辑 `root.withdraw()` 隐藏窗口，任务栏自然没图标）、展开后**托盘图标又消失**（旧逻辑 `restore_from_tray()` 里 `tray_icon.remove()`），一来一回"任务栏没了、托盘也没了"，用户容易误以为程序退出了。改法：
    - **最小化只进任务栏、不再隐藏**：`minimize_to_tray()` 由 `root.withdraw()` 改为 `root.iconify()`（最小化到任务栏，**任务栏图标保留**）；托盘 `tray_icon.add()` 保持幂等调用。WndProc 拦截 `SC_MINIMIZE` 只置标志位的机制不变（`poll_tray_loop()` 轮询后在正常 Tk 上下文执行 `iconify()`）。
    - **托盘图标从启动就常驻**：`SysTrayIcon` 构造成功后立即 `tray_icon.add()`（启动即显示托盘图标）；`add()` 幂等、失败不抛异常（Shell_NotifyIconW 返回 false 则返回 False），若启动时失败，最小化时会再次尝试。**点托盘图标恢复只 `deiconify()`，不再 `remove()`**——托盘图标不再消失。
    - **产品中文名「绿色便携版」→「绿色整合版」**（多加"整合"二字）：改 launcher.py 三处（关于弹窗子标题「绿色整合版 · 所有文件与依赖全部本地化」、本地化区块标题「绿色整合 · 本地化特点」、托盘 tooltip「(绿色整合版)」）+ README.md + DEV_NOTES.md + `skills/dsh-deploy-maintain/SKILL.md` 与 README 全部「绿色便携」字样统一替换（`Edit` 工具 `replace_all`）。
    - **验证**：`python -m py_compile launcher.py` 语法通过；实际行为待 DSH_Launcher.exe 重打包后人工确认——启动即有托盘图标、最小化到任务栏（任务栏图标在）、点托盘或任务栏恢复后托盘图标仍在、点 X 退出后托盘图标移除。

33. **图标鲸鱼放大、去外围绿色圈（2026-08-16）**：用户反馈 `DSH_Launcher.ico`（需求 #26 产物）**周围一圈绿色太多、本体绿色鲸鱼图案太小**，要求"把中间鲸鱼弄大点、去掉外围那圈颜色、最大化利用空间、增加识别度"。用 `runtime/tmp/icon_design/whale_v3.py` 重新制作：
    - **主体定位**：先按颜色阈值（亮绿 G>160 且 R<150、黄色闪电 R>200）标出主体像素，再**行列密度过滤**（保留计数 ≥ 最大列/行计数的 5% 的列/行）剔除孤立边角像素（鲸鱼鳍、边缘水印），得到更紧的**主体包围盒**（比单纯连通域更稳）。
    - **最大化铺满**：以主体中心扩成正方形裁剪区，边距 `MARGIN_RATIO=0.01`（收紧到最小），主体几乎铺满画布；裁剪越界时自动平移修正仍保持正方形居中。
    - **去外围色**：主体之外像素统一处理——正式版 `DSH_Launcher.ico` 用**透明背景**（非主体像素全置透明），备选 `DSH_Launcher_bg.ico` 用深绿背景 `(0,83,41)`。
    - **结果**：`verify_v3.py` 实测——主体不透明像素 23365（35.7%），不透明包围盒 `[2,24]-[253,230]` 252×207，**占画布 98% × 81%**（鲸鱼放大铺满、外围绿色圈已去除，识别度明显提升）。
    - **验证**：`verify_icon.py`——ICO 文件头 `00000100`、62317 字节；重打 `DSH_Launcher.exe` 后 `ExtractIconExW` 数出 exe 内嵌 1 个图标、`LoadImageW` 拿到有效 HICON。已同步 `skills/dsh-deploy-maintain/SKILL.md`（3.7 自定义图标小节补充放大/去圈经验）。

34. **产品名「一键启动器」→「绿色整合版启动器」（2026-08-16）**：用户进一步要求把**程序标题**与**关于弹窗**里的"一键启动器"改为"绿色整合版启动器"（与上一轮「绿色便携版→绿色整合版」呼应，产品名统一为「DeepSeek Harness 绿色整合版启动器」）。改 launcher.py 五处——①模块 docstring、②`WINDOW_TITLE` 常量（主窗口标题 `root.title(WINDOW_TITLE)` 与单实例查找 `_activate_existing_launcher` 共用，一处改全联动）、③关于弹窗主标题、④托盘 tooltip、⑤启动日志文案；并同步 README.md / DEV_NOTES.md / `skills/dsh-deploy-maintain/SKILL.md` 与 README 的产品名描述（DEV_NOTES 历史验证快照里引用的旧标题保留不改）。重打 `DSH_Launcher.exe` + 重建 `Skill-dsh-deploy-maintain.zip`；`smoke_about_localized.py` 增加主标题「DeepSeek Harness 绿色整合版启动器」检查。

35. **英文版 README_EN.md（2026-08-16）**：用户要求默认维护中文 README，只在版本上传时翻译一份英文版给外国人看。做法：
    - 创建 `README_EN.md`，忠实翻译当前中文 README（英文版编号连续，内容与结构一致），随版本更新翻译一次。
    - 中文 README.md 顶部增加语言切换指引行：`> **其他语言**：English — [README_EN.md](README_EN.md)（随版本更新翻译一次，供国际用户参考；本文为准）。`
    - 目录结构与发货清单中补充 `README_EN.md` 引用。
    - 绿色分发 zip 打包时包含 `README_EN.md`（`-Path` 显式加入）。
    - 版本号升至 v1.0.6，Release 时同步发布含英文 README 的绿色分发 zip。

37. **安装环境自动装上全部内置插件 + 插件管理「一键安装内置插件」（2026-08-17）**：
    - 用户要求：①「安装环境」最后自动把所有计划内置的插件都装上；②插件管理窗口加"一键安装本地内置插件"按钮。
    - 实现：新增 `bundled_plugin_dirs()`（扫描程序目录 `plugins/` 下含 package.json 的子目录，动态发现内置插件，不硬编码名单）与 `install_bundled_plugins()`（用 `file:<绝对路径>` 经 pnpm 批量安装，**已装的跳过**、单个失败不中断、返回 (新装/跳过/失败) 三元组）。
    - 接线：`prepare_all()` 在 `prepare_dsh()` 之后自动调用（因"已装跳过"所以幂等——每次启动服务前的 `prepare_all` 不会重复安装）；插件管理工具栏新增「一键安装内置插件」按钮复用同一方法。
    - 坑：内置插件安装走 `file:` 本地源，**不联网**，新装会写 `DSH_HOME/profiles/<profile>/package.json` 的 dependencies 并自动同步 `dsh.profile.bundles`（复用 `install_plugin()` 的 reconcile 逻辑）；装完需重启服务生效。

38. **用量管理价格更新为官方【高峰期】默认价 + bat 打包脚本闪退排查（2026-08-17）**：
    - **需求**：用户给出官方定价页 `https://api-docs.deepseek.com/zh-cn/quick_start/pricing/`，要求"更新默认的用量管理的价格，用官方的高峰期时段价格作为默认"；同时反馈"bat 打包脚本貌似有问题，打开就闪退"。
    - **官方定价抓取（2026-08-17）**：DeepSeek 官方改为**峰谷定价**——北京时间高峰 9:00-12:00 / 14:00-18:00，高峰为低谷 2 倍。高峰期价格（元/百万 tokens）：
      - `deepseek-v4-flash`：输入命中缓存 **0.10** / 未命中 **3.0** / 输出 **9.0**
      - `deepseek-v4-pro`：输入命中缓存 **0.30** / 未命中 **9.0** / 输出 **27.0**
    - **实现（`plugins/dsh-usage-stats/lib/client.js`）**：价格表 `localStorage` 键升级 `dsh.usageStats.prices.v2` → **`dsh.usageStats.prices.v3`**，`DEFAULT_PRICES` 改为上述官方高峰价（fallback 同 flash）。**升级后浏览器旧 v2 价格自动失效、回退新默认高峰价**（loadPrices 读不到 v3 键即用默认），无需用户手动清缓存。注释与 UI 提示文字同步改为"默认取官方高峰时段价（估算偏保守），可按实际价格/时段修改"。
    - **bat 闪退排查结论**：`build_exe.bat` **实际不闪退**。排查方法：① 字节级检查根目录 3 个 bat（start/stop/build_exe）——全部 ASCII、无 BOM、CRLF 行尾，排除编码问题；② 发现 `build_exe.bat` 第 40-42 行注释乱码（`?????`）——非 ASCII 虽不影响运行但破坏可读性，已改为纯 ASCII 英文注释；③ 用 Python `subprocess` 调 `cmd /c build_exe.bat` 抓完整输出——**退出码 0、增量构建 1.3s、输出 `[OK] Build finished`、`pause` 正常**；新 exe 实测启动存活（不闪退）。真正误判来源：PowerShell `Start-Process -RedirectStandardOutput/Error` 与 cmd 的交互（pause）冲突导致看起来"闪退"，见避坑 #59。

39. **v1.0.7 发布：Chrome 150 无端口 Origin 补丁（避坑 #58）+ 用量高峰价（#38）+ 发布流程调整（2026-08-17）**：
    - **版本号**：`GREEN_VERSION` 1.0.6 → **1.0.7**，`GREEN_VERSION_DATE` → 2026年08月17日（README/README_EN 的"最新下载 tag"与"当前版本"同步更新，共 3 处 × 2 文件）。
    - **不再单独打 Skill zip**：用户要求"不用单独打包 skill 了，把 `skills/dsh-deploy-maintain` 包含在 release 包里就行"——绿色 zip 直接带 `skills/dsh-deploy-maintain/` 目录（本版起 **Release 不再上传 `DSH_Skill_*.zip` 资产**）。打包用 **Python zipfile**（`runtime/tmp/pack_release.py`，用后即删）替代 Compress-Archive（避免 PowerShell 转义/路径问题），内置复核：根必须含 `LICENSE`、不得有 `skills/*.zip` 嵌套。zip 命名沿用 `DSH_Launcher_GreenPortable_Online_20260817_v1.0.7.zip`（9200793 字节，39 项）。
    - **发布默认 config.json 恢复本机模式**：本地 config.json 因局域网测试残留 `dsh_host: 0.0.0.0`，**发布默认改回 `127.0.0.1`**（用户确认）——新用户开箱仅本机访问，局域网需自行在 GUI 网络设置开启（特权 API 本就仅回环）。
    - **旧版 Release 资产清理**：v1.0.0~v1.0.6 各 Release 的 zip 资产（含 `DSH_Skill_*.zip`）全部删除，**Release 条目与更新记录保留**；新版本只传绿色 zip 一个资产。
    - **发布流程执行细节**：`gh` CLI 不可用，凭据在 Windows 凭据管理器（`credential.helper=manager`）→ 用 **`git credential fill` 取 token + urllib 直调 GitHub API**（`runtime/tmp/gh_helper.py`，用后即删）；上传资产走 `POST /releases/{id}/assets`（`Content-Type: application/zip`，body 为文件字节流）；release body 用 UTF-8 字节流提交（避坑 #32）；发布前用 `git credential fill` 拿到的 token 验证 API 可达。另：系统 PATH 的 `python` 是旧版（报 Py2 语法错误），统一用内置便携 Python `runtime\python\python\python.exe` 跑脚本。
    - **上传资产端点坑（实测 404）**：资产上传 **`POST` 端点必须用 `uploads.github.com`**（`https://uploads.github.com/repos/<owner>/<repo>/releases/<id>/assets?name=...`），用 `api.github.com` 同路径会 404；下载/读取资产走 `api.github.com` 正常。国内网络 github.com:443 不可达但 api.github.com/uploads.github.com 可达（用户开全局代理后可正常 git push）。
    - **发布完成（2026-08-17 实测）**：v1.0.7 Release（id 371534576，三国味 body 1077 字符）已创建，zip 资产 `DSH_Launcher_GreenPortable_Online_20260817_v1.0.7.zip`（9201258 字节）上传成功；v1.0.0~v1.0.6 共 **13 个旧资产全部删除，Release 条目与更新记录保留**（v1.0.7 起不再有 `DSH_Skill_*.zip`）。git 推送由用户本人完成（master=b8a6fdc，tag v1.0.7=34e94cb）。
40. **内置「WebUI 精简侧边栏」插件 dsh-sidebar-lite（2026-08-17，复刻自第三方 DSH Better Sidebar）**：
    - **来源**：用户点名第三方插件 **DSH Better Sidebar（omdsh-dev/DSH-better-sidebar）**，要求研究并参考复刻一个内置精简版，README 需标注引用来源以示尊重。定位「精简单机版」，只做**资源管理 / 文件预览 / 内嵌浏览器**三项核心（去掉终端 node-pty、Git 面板、Diff、Subagent、多分栏工作台等重能力）。
    - **宿主端** `plugins/dsh-sidebar-lite/lib/index.js`：在 `ctx.webServer` 注册前缀路由 `/__dsh/sidebar-lite/*`。`session.cwd`/`fs.tree`/`fs.read`/`fs.write` 走 POST JSON；`file` 走 GET 回原始媒体字节。安全：全部请求必须带自定义头 `X-DSH-Sidebar-Lite: 1`（跨域页面无法伪造，同 dsh-usage-stats 先例）；所有读写/列目录/媒体读取都用 `isWithin(cwd, …)` 锁定在会话工作目录之下；文本上限 1MB（超标 truncated）、媒体上限 32MB、单目录最多 1000 条（超标 truncated）；写文件先写临时文件再 rename 保证原子性。
    - **会话溯源**：权威来源是 `ctx.get("sessions").get(sessionId).header.cwd`（主机端优先），客户端经 `ctx.sessions.list`（standard kit 外部 store）订阅当前激活会话，取 id 与摘要 `byId[<id>].cwd` 上报；兜底用客户端 cwd → `process.cwd()`。
    - **客户端挂载** `lib/client.js`：与 better-sidebar 一致，往 `document.body` 挂 portal div 再用 `react-dom/client` 的 `createRoot` 渲染，**不依赖官方任何内部布局插槽**，也不修改官方文件；可折叠（收起时右侧留细条 `‹‹` 便于重开）、资源管理/浏览器双 Tab；展开时用 CSS 变量 `--dsh-sidebar-lite-width` 推动 `#root` 的 `margin-right` 让位（VSCode 侧栏效果，参考 better-sidebar layout.css 的手法简化实现）。
    - **安装方式**：与其它内置插件一致，`plugins/` 目录 → `--install-plugin file:...` → pnpm add → `reconcile_bundles` 自动进 `dsh.profile.bundles`，随服务重启加载；插件管理窗口「一键安装内置插件」会自动带上。
41. **dsh-sidebar-lite 对齐 better-sidebar 交互细节（2026-08-17）**：用户要求侧栏 UI 尽量照抄 better-sidebar 的打开/缩回按钮、文件显示方式/位置、右键功能，并把**资源管理器根目录改为会话的整个工作目录**（非写死，随会话切换变）。本次对齐：
    - **去掉「精简」字样**：UI 标题、package.json 描述、README 全文全部改成「侧边栏」；客户端标题为「侧边栏」，不再出现"精简（版）"。
    - **资源管理器根目录 = 会话工作目录**：客户端经 `session.cwd` 请求宿主端，宿主端以 `ctx.get("sessions").get(sessionId).header.cwd` 为权威（兜底客户端 cwd → `process.cwd()`），根目录随当前激活会话实时切换，**非写死路径**。
    - **资源管理头对齐**：头部显示「根目录名 + 刷新按钮（⟳）」，刷新清缓存重拉目录树（`refreshTick` 触发）；根行（`depth=0`）自身也可右键，点击根行复制其相对路径。
    - **缩进对齐**：行内的 `paddingLeft` 由 `6 + depth*14` 改为 `6 + depth*22`（与 better-sidebar 的 `depth*22+6` 一致）；沿用目录优先、隐藏灰显。
    - **右键菜单完全照抄原版 3 项**（用户明确选择「完全照抄」，其余新建/重命名/删除/刷新后续再加）：
      - 菜单项 = **仅文件行提供「下载」**；目录行只提供「**复制相对路径 / 复制绝对路径**」；
      - 单个共享菜单（`rowMenu` 记录触发行 + 光标位置），点击空白/菜单外关闭（`menu-mask`），复制成功该行短暂显示「已复制」（1200ms）。
    - **下载实现避坑**：宿主 `file` 媒体路由要求防御头（`X-DSH-Sidebar-Lite: 1`），故**不能**用 `<a href>` 直接跳转（会 403），而是 `fetch(带防御头)→blob→URL.createObjectURL` 后再用 `<a download>` 触发浏览器保存，1s 后 `revokeObjectURL` 释放内存。宿主 `file` 路由已支持 `download=1` 时返回 `Content-Disposition: attachment`。
    - **删除已无用的后端增删改接口**：先前为支持右键新建/重命名/删除加的 `fs.mkdir` / `fs.rename` / `fs.rm` 三个路由已随「只保留原版 3 项」删除（`rename` 导入保留，仍被 `writeText` 原子写使用），README 路由表同步更新。
    - **浏览器 AI 可调用性（对比结论）**：better-sidebar 的浏览器是**纯用户驱动的沙箱 iframe**，`browser.probe` 仅探测站点可嵌入性（返回头信息、非模型工具）；其唯一暴露给模型的是 8 个**终端**工具（`terminal_create/send/read/...`），浏览器**不能被 AI 调用**。我们的浏览器同为纯用户驱动 iframe，**同样不能被 AI 调用**——两者能力在此持平。用户选择暂不新增「AI 调浏览器」工具，维持与双方一致。

42. **dsh-sidebar-lite 补齐终端 + 任务管理，资源管理器默认根改为工作区根（2026-08-17）**：用户反馈「还没完全对齐」，要求：① 补上 CMD 终端页、任务管理页；② 资源管理器不能只显示固定会话工作目录（`runtime\dsh`），应默认显示 `E:\DeepSeekHarnessLauncher` 整个项目，或至少放开上级浏览——即放开资源管理器浏览上限，与内部 `dsh-file-browser` 插件一致。本次改动：
    - **CMD 终端（宿主端 `lib/index.js`）**：`terminal.stream`（GET SSE 流，回放 transcript + 实时推送）/ `terminal.open` / `terminal.input` / `terminal.kill` 四个路由；按 `${sessionId}:${tab}` 键控一把 `child_process.spawn("cmd.exe", [], {cwd})` 进程（STARTUPINFO 不建 TTY、绿色版零原生依赖、非 node-pty），stdout+stderr 合并 `push` 到有界 transcript（1MB 丢头）并推给所有 SSE 监听器；`req.on('close')` 只摘监听器**不杀进程**，刷新/切页断连后 `terminal.stream` 重连先回放 `replay` 事件恢复现场，`terminal.kill` 才真正 `proc.kill()`；客户端 `TerminalView`：`attachTerminalStream`（fetch SSE + TextDecoder + 按 `\n\n` 分事件解析 `data:` 行 JSON）+ 输入框回车 `terminal.input` 写 stdin + 「停止」按钮 `killTerminal`（先 `stop()` 断开 SSE 再 `kill`，避免进程退出事件写向已断开响应）+ 自动滚动到底。命令行由 cmd 自行回显，SSE 不再输回。
    - **任务管理（宿主端）**：`jobs.output` 从 `ctx.get("sessions").get(sessionId).events` 重放 `tool/call(job_output)` 与配对 `tool/result` 的文本块（按 `source.callId` 配对，幂等，不消费模型游标）；`jobs.kill` 复用官方 `ctx.get("jobs").kill(jobId, caller, reason)`（caller 取 `agents.get(sessionId)`）。客户端 `TasksView`：直接读**官方 session/jobs 推送镜像** `snapshot.jobsBySession[sessionId]` 列任务（状态/标题），「输出」调 `jobs.output`、「停止」调 `jobs.kill`。任务列表数据源与 better-sidebar 一致，不直连内部 API。
    - **资源管理器默认根改为工作区根**：宿主端 `session.cwd` 追加返回 `workspaceRoot`，用新增 `resolveWorkspaceRoot(ctx)` 解析 `ctx.get("sandboxPolicy").workspaceRoot`（优先 `fsService.resolve→processPath` 得可展示绝对路径，fs 不可用退回原始 root），与 `dsh-file-browser` 的 `/home` 同源；客户端 `SidebarShell` 存 `workspaceRoot`，`ExplorerView` 的 `currentPath` 默认取 `workspaceRoot || cwd`，此后「返回上级 ⬆ / 路径框」已放开可上溯到任意路径——**不再把会话 cwd 当锁死的固定根**。终端/文件操作的 scope.cwd 仍以会话 cwd 为准，仅资源管理器视图根变了。
    - **语法校验**：`node --check` 对 `index.js` / `client.js` 均通过。
    - **验证状态**：代码对齐已完成，需重装插件并重启 DSH 服务后做端到端验证（终端命令执行、任务列表/输出/停止、资源管理器默认显示工作区根）。
43. **dsh-sidebar-lite 侧栏宽度自由拉伸 + 文件「另存为」（2026-08-17）**：用户实测侧栏可打开后，要求 ① 做成左右能拉动的自由调整宽度；② 文件右键「下载」在本地机器上没意义，应改为「另存为」。本次改动（仅 `lib/client.js`，后端路由不变）：
    - **宽度自由拉伸**：右停靠面板的宽度从 `#dsl-host` CSS 常量改为用 CSS 变量 `--dsh-sidebar-lite-width`（`width:var(--dsh-sidebar-lite-width,320px)`），`#root` 的 `margin-right` 早已依赖同一变量，故拖动改宽度时面板与主内容区同步让位。`SidebarShell` 新增 `panelWidth` 状态、`lastWidthRef`（记住收起前宽度，展开时恢复而非重置回 320）、`resizing` 状态；渲染一个位于宿主左边缘、宽 5px、绝对定位的透明拖动手柄（`cursor:ew-resize`），`onMouseDown` 置 `resizing=true`，在 `resizing` 期间全局监听 `mousemove`（`nextWidth = max(200, window.innerWidth - clientX)`，右停靠故用视口宽减光标 x）与 `mouseup`，宽度变化经 `useEffect` 同步 CSS 变量。`#dsl-host.dsl-resizing` 关掉 `width` 过渡（`transition:none;cursor:col-resize;user-select:none`）避免拖动时延迟/跟手。
    - **文件「另存为」**：`downloadFile` 改名 `saveAsFile`。因宿主 `file` 媒体路由要求防御头、`<a href>` 直跳会 403（见避坑 #56 系），仍先 `fetch(带防御头)→blob` 取字节；随后**优先用原生「另存为」对话框**（File System Access API `window.showSaveFilePicker({suggestedName})`）让用户自选保存位置，`handle.createWritable()→write(blob)→close()` 写入；该 API 不可用或用户取消时**直接返回**（不触发自动下载）。「另存为」是本地机器语义的正确交互。右键菜单文案「下载」改「另存为」，触发 id `download`→`saveas`。
    - **避坑（另存为一键）**：`showSaveFilePicker` **必须在用户手势（右键点击）激活窗口内调用**，若先 `await fetch` 再弹框，异步丢失去焦点后对话框会被浏览器拦截（提示需用户手势）。故实现为**先弹框拿 handle、再 fetch**。初次调用会请求文件访问权限（浏览器询问），属正常。
    - **语法校验**：`node --check lib/client.js` 通过。
    - **验证状态**：代码完成，需重装插件并重启 DSH 服务后做端到端验证（拖动左边缘调整宽度并观察主区同步让位；对文件右键「另存为」弹出系统保存对话框选择不同位置保存成功）。若 `showSaveFilePicker` 在注入 iframe/受限上下文不可用，会自动回退为浏览器下载（同名文件），不影响主流程。
44. **dsh-file-browser 弹窗可拖动+可拉伸 + 大文件分块预览（2026-08-17）**：用户对比侧边栏体验后，要求 ① 文件浏览插件弹出来的窗口能拖动位置、拉伸宽高（右下角/右边/下边三路，参考侧边栏思路）；② 旧版 `TEXT_CAP=200KB / IMAGE_CAP=4MB` 超出后直接报「文件过大无法预览」且读大文件有时还会报错，用户希望「尽量先给前部预览、若还想看后面一段就点按钮继续分批加载」（对齐 dsh-sidebar-lite 预览的宽容度）。本次改动（两端各 1 文件）：
    - **宿主端 `lib/index.js` 改动**：废弃 `tooLarge` 响应式，统一**只读前部字节 + 标 `truncated`**，并新增 `POST /readChunk(offset?,size?)` 按字节偏移分块读取。① `TEXT_PREVIEW_BYTES=512KB / IMAGE_PREVIEW_BYTES=32MB / BINARY_HEAD_BYTES=4KB`；② 图片 `≤32MB` 完整做 dataURL，更大的只取前部 32MB head + `truncated`（客户端提示「图片过大，以下为前部缩略预览」）；③ 非图片先按 UTF-8 读前部 `readBytes(target,undefined,512KB)` 解码文本（`kind:text`），若 fs 拒读则降级二进制读 4KB head base64（`kind:binary`），都返回 `size` + `truncated` 不再报错；④ 新增 `/readChunk`：`offset` 默认 0、`size` 默认 512KB、单次上限 4MB，**防 UTF-8 多字节跨块截断**：请求进来时若 `offset>0`，本端回退 `back=min(3,offset)` 字节（覆盖可能的 UTF-8 尾巴残体），实际从 `actualStart=offset-back` 读，回传带 `back` 字段告知客户端前缀是冗余；⑤ `eof`/`truncated` 明确返回「是否还能继续点」。
    - **客户端 `lib/client.js` 改动（窗口几何）**：面板 `panelStyle` 从「固定 top/right/bottom 绝对定位 680 宽」改为 `win={left,top,width,height}` 动态值 + `min 520×380 / max 视口-16` clamp；渲染三条透明拉伸手柄（右 `cursor:ew-resize` / 下 `ns-resize` / 右下 `nwse-resize`，`onMouseDown` 调用 `windowOnDown` 设 `dragStateRef.mode`，全局 mousemove/mouseup 跟手）；**header 整段作为 move 手柄**（`cursor:move`），但 input 框、刷新按钮、关闭按钮上 `onMouseDown={e.stopPropagation}`，避免点输入/按钮被拖去；初始几何按「视口右下 720 × (视口高-128)」。
    - **客户端改动（大文件预览）**：`previewFile` 取消 `tooLarge` 错误分支，改为按 `kind` 渲染 `text/image/binary` 三种：① `text`：顶部显示「已预览前部 X 共 Y」提示；若 `truncated && !eof`，显示 **「再看后面一段（512KB）」按钮**（禁用态 `加载中…`）+ 提示「可连续点击直到文件末尾」，按 `loadedBytes`（Blob.size）估计字节偏移，`postJson('/readChunk')` 调回来，追加 `content`；② 「UTF-8 多字节边界修复」：host 回了 `back`，本端 `TextEncoder` 把增量 text 编成 utf8bytes，扫前 `back+1` 字节跳过 `0b10xxxxxx` 续字节前缀（这些字节是上一段末尾 UTF-8 尾，已完整解码过不会真丢码），`subarray(startByteIdx)` 再解回文本才拼接，保证 chunk 边界（字节对齐切在 UTF-8 中间）不会乱码；③ `image`：超大图给缩略 dataURL + 「建议直接双击文件看原图」；④ `binary`：给 hex+ASCII 4KB 嗅探网格 + 说明不支持大二进制预览。同时 `insertContent` 响应新 shape（`kind:image/binary/text` 分别生成文案）。
    - **避坑（UTF-8 chunk 边界）**：`Blob([string]).size` 是「字符串 UTF-8 字节数」，对纯 ASCII/大多数文本是对的，但**不能做精确字节指针**（因为 JS string 是 UTF-16）；只要分块**按字节 offset 去 fs.readBytes**，就必然有概率把一个 2~3 字节 UTF-8 码点切成两段，前半段上一段 decoded 的末尾还是正常完整码点显示（前一整块的 decoded 末尾 `content` 还是完整），**增量段如果从半中间读直接 decode 就会生成 `U+FFFD` 问号乱码**。解法必须是「host 多读 1~3 字节 + client 扫首字节跳过续字节」或用 offset 以字符为单位（难）。已实装 host 端 back 机制 + client `(b & 0xC0) !== 0x80` 找码点起始，这是最稳妥的 0 依赖解法。
    - **避坑（拖动事件冒泡）**：header 里含 `<input>`/按钮，若直接给 `header onMouseDown` 绑定 move 拖动，会覆盖用户在输入框上的正常点击（按下去就触发拖动、无法选中文本/聚焦输入框），因此**所有 header 内可交互子元素必须 `onMouseDown={e => e.stopPropagation()}`**，只有点在「文件浏览」文字与空白区域才会触发 move。
    - **语法校验**：`node --check lib/index.js` / `node --check lib/client.js` 双端均通过。
    - **验证状态**：代码完成，需重装插件并重启 DSH 服务后做端到端验证（窗口拖动/三路拉伸不丢焦点、超大 MD/日志 512KB 前部预览后点按钮能继续追加且 chunk 交界字符不问号乱码、超大图片不报错给缩略图、二进制文件显示嗅探网格）。

## 二、代码设定（launcher.py）
| 模块 | 设定 |
|------|------|
| 依赖 | 仅 Python 标准库（tkinter / urllib / subprocess / zipfile / tarfile / webbrowser / socket），零第三方依赖 |
| 便携 Node | 自动下载 `node-v22.20.0` 到 `runtime/node`；国内 `registry.npmmirror.com/-/binary/node/...`，官方 `nodejs.org/dist/...`；zip（win）或 tar.gz（linux） |
| dsh 安装 | 优先 `node.exe npm-cli.js install --prefix runtime/dsh @deepseek-ai/dsh`（用便携 Node 自带 npm），按镜像附 `--registry`；`install_dsh()` 只负责安装，`prepare_dsh(force)` 负责"缺失则装/强制重装"；输出经 `_stream_subprocess()` **实时逐行**显示进度（需求 #30） |
| dsh 更新 | `dsh_latest_version()` 用 `npm view @deepseek-ai/dsh version` 只读查最新版；`backup_dsh()` 把旧版拷到 `runtime/dsh-backup-<版本>`（同名加时间戳后缀）；`update_dsh()` = 查询→备份→强制重装，备份失败即中止避免数据丢失 |
| dsh 启动 | 直接调 `node <dsh>/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3080` |
| 数据隔离 | 环境变量 `DSH_HOME=runtime/dsh-home`，会话/配置/存储全部落在程序目录 |
| 绿色整合 | `build_env()` 把 npm 缓存/用户配置、pnpm home/store、TEMP/TMP 全部重定向到本地 `runtime/` 下（见下） |
| 工作区自动解析 | **不写死工作目录**：`resolve_default_workspace()` 自动判定——`workspace_conflicts_with_tmp()` 用 `os.path.commonpath` 检测"临时目录是否为工作区子路径"；冲突（程序根目录内含 `runtime/tmp` 的绿色整合默认形态）时默认工作区取程序目录内 `workspace` 子目录（`DEFAULT_WORKSPACE_SUBDIR`），不冲突时直接用程序根目录本身；config.json 的 `default_workspace` 可显式覆盖（冲突则警告并回退）。`seed_default_workspace()` 按解析结果预置注册表记录（title=目录名），详见避坑 #31 |
| 就绪检测 | 后台线程 socket 轮询端口，就绪后 `webbrowser.open` |
| WebUI 单页面去重 | 本地心跳服务（`http.server.ThreadingHTTPServer` 绑定 127.0.0.1:3081，daemon 线程）+ 前端 `index.html` 注入心跳脚本（`patch_frontend()` 幂等，`install_dsh()` 与 `start_server()` 自动补齐）：页面每 15 秒 `fetch` 一次 `http://127.0.0.1:3081/__dsh_ui_alive?t=<令牌>`（no-cors）；`ui_is_open()` 以最近 180 秒内有无心跳判定"界面已打开"，**自动打开**（`wait_and_open()`/`open_ui(force=False)`/CLI `--start`）打开浏览器前先查此判定，已打开则跳过并记日志；**手动打开（GUI「打开界面」按钮 → `open_ui(force=True)`）必定打开新页面，不受去重限制**。令牌存 `runtime/ui-beacon.token`（`secrets.token_hex(8)`，读写失败退化为固定值仅影响防伪造）。配置项：`auto_open_browser`（默认 True，False 则启动不自动开浏览器）、`ui_beacon_port`（默认 3081，被占用时仅记日志并禁用去重）。 |
| 进程管理 | Windows 下 `CREATE_NO_WINDOW` 隐藏服务控制台；PID 写 `runtime/server.pid` 供独立 `--stop` 使用；**stdin 用 `PIPE` 保持打开**（否则 dsh 读到 EOF 会退出，见避坑 #12）；`watch_server` 线程监听异常退出并记日志 |
| 界面 | tkinter：状态栏 + 安装/启动/停止/打开界面/检查更新/刷新状态 + 设置(镜像/端口) + 运行日志框；主窗口默认 **920x720**（最小 760x600），保证全部信息无需缩放即可显示；关窗自动停服务 |
| 系统托盘 | `SysTrayIcon`（ctypes+Win32，零依赖）：`__init__` 先 `root.update_idletasks()` 再 `GetAncestor(GA_ROOT)` 取真实顶层 HWND 并挂钩窗口过程；`WndProc` 只置 `_minimize_pending`/`_restore_pending` 标志（**不直接调 Tk**），`run_gui` 里 `poll_tray_loop()`（`after(80,...)` 常驻）调 `tray_icon.poll()` 在正常事件上下文执行最小化(`add()`+`withdraw()`)/恢复(`remove()`+`deiconify()`)；`dispose()` 退出时移除图标并还原窗口过程 |
| 图标 | 自定义绿色小鲸鱼 `DSH_Launcher.ico`（84KB，16~256 七尺寸）三处统一：窗口 `root.iconbitmap(get_icon_path())`（try/except 降级）、托盘 `SysTrayIcon._get_icon()` 优先 `LoadImageW` 从 .ico 加载、exe 打包 `--icon`+`--add-data`；`get_icon_path()` 打包后从 `_MEIPASS` 取，源码模式取程序根目录（需求 #26） |
| 单实例 | `CreateMutexW` 命名互斥量 `DSH_Launcher_GreenPortable_SingleInstance`（句柄模块级 `_SINGLE_INSTANCE_MUTEX_HANDLE` 常驻防 GC，`GetLastError==183` 判已有实例）；`run_gui` 开头 `Launcher()` 后、`tk.Tk()` 前检测，已存在则 `_activate_existing_launcher()`（`FindWindowW`+`ShowWindow(SW_RESTORE)`+`SetForegroundWindow`+`BringWindowToTop`）激活旧窗口后退出本实例，找不到窗口重试 10 次后 warning 提示；CLI 模式不拦截（需求 #29） |
| 插件管理 | 第六个按钮「插件管理」开新窗口；已装列表读 `runtime/dsh-home/profiles/<profile>/package.json` 的 `dependencies`；安装/移除走 `node bin.js plugin --profile <profile> add|remove`（内部转发 pnpm）；搜索源 = npm 注册表 API（国内镜像优先，结果经 `_is_dsh_plugin_package` 过滤只留 dsh 相关包）+ GitHub 官方话题页 `https://github.com/topics/dsh-plugin`；另有「加载推荐」按钮展示内置 `RECOMMENDED_PLUGINS`（npm 上已核实的 12 个 dsh 插件，无需网络也能看到可安装项）；GitHub 源插件安装规格 `github:owner/repo` |
| 本地插件安装 | 手动安装栏新增「选择本地插件文件夹安装…」按钮（`filedialog.askdirectory` 选目录）；`install_plugin()` / `--install-plugin` 均支持：入参 `os.path.isdir(spec)` 为真时自动归一化为 `file:<绝对路径>`（`\`→`/`）交给 pnpm；pnpm 对 `file:` 本地路径默认**拷贝**而非软链，改源文件后需重新安装才同步 |
| 数据维护 | 主窗口新增「数据维护」区（LabelFrame，需先停止服务，操作不可恢复）：**单个「清理归档」按钮**（`on_purge` 统一入口，服务运行中弹窗提示先停止）→ 弹出 `open_purge_dialog()` 会话列表弹窗：Treeview 列出标题/工作区/状态(已归档或正常)/有无日志，首行「全选 / 全不选」，行点击即勾选，底部「删除选中 (N)」二次确认后逐个 `purge_session(session_id)`（失败项收集后统一提示），删除后自动刷新列表。三处数据源一并清理：① `sessions/<工作区编码>/<会话ID>/` 日志目录（`_delete_session_log_dir` 按 id 遍历查找，防路径穿越）② `storages/workspace.json` 的 `sessionIds`/`archivedSessionIds` ③ `storages/session_projcache.json` 缓存行（`_remove_session_from_registries` + `_atomic_write_json` 原子写回）。命令行等价：`--purge-archived` / `--purge-session <ID>`（服务运行时会校验并拒绝） |
| 内置插件 dsh-archive-purge | `plugins/dsh-archive-purge/`：宿主端 `lib/index.js` 注册 `GET /__dsh/archive-purge`（列出已归档会话：id/标题(读 `storages/session_projcache.json` 尽力而为)/所属工作区/是否运行中）+ `POST /__dsh/archive-purge`（删除，带 `x-dsh-plugin-purge: 1` 自定义头防跨站触发）。POST 请求体 `{"ids": [...]}` 仅删除所选（结果去重），省略 `ids` 则遍历 `workspaceRegistry.archivedSessionIds` 清空全部；每个会话：跳过运行中 → 删日志目录 `sessions/<工作区>/<会话ID>/` → 遍历 `registry.list()` 逐个 `detachSession` 摘除。路由注册必须写成 `ctx.effect(() => ctx.webServer.register({...}), "…")`（把返回值当清理函数），否则注册后立即被注销（避坑 #34）。客户端 `lib/client.js` 用加载器契约 `window.__ModuleLoader__.load` 注入 `settings.section` 插槽（「清理归档」页）：**只读展示**——挂载即 GET 拉列表，列表显示与勾选/全选交互保留，但**移除「删除所选 / 清空全部」按钮**（实际启动时会话均"运行中"无法清理），说明文字引导到启动器 GUI（停止服务 → 数据维护 → 清理归档），仅保留「刷新列表」按钮。安装方式：插件管理 → 选择本地插件文件夹安装 `plugins/dsh-archive-purge`（或用 `--install-plugin plugins\dsh-archive-purge`） |
| 内置插件 dsh-file-browser | `plugins/dsh-file-browser/`（v0.2.0）：宿主端 `lib/index.js` 注册 `GET /__dsh/file-browser/home` + `POST /__dsh/file-browser/list` + `POST /__dsh/file-browser/read`（均要求 `x-dsh-file-browser: 1` 自定义头防跨站；走 `ctx.get('fs')` 复用 dsh 文件系统服务；文本预览上限 200KB、图片 4MB、单目录 1000 项）。客户端 `lib/client.js`：`conversation.input.left` 注册「文件」开关按钮（经 standard-kit 拿到 `useInput`/`inputActions`），`shell.overlay` 注册右侧面板（列目录/预览/右键菜单）；「插入到输入框」由面板 `queueInsert` 排队、按钮组件用 `inputActions.setDraft` 追加草稿。安装：`--install-plugin plugins\dsh-file-browser`，重启生效 |
| 绿色版自更新 | **常量**：`GREEN_VERSION`（当前 `1.0.2`，与 GitHub Release tag 一致、不含 `v` 前缀，发布新版时手动同步）、`GREEN_VERSION_DATE`、`GITHUB_REPO`（`LiuJunheng/DeepSeekHarnessGreen`）、`GREEN_RELEASE_API`（`api.github.com/repos/.../releases/latest`）、`GREEN_RELEASE_MIRROR`（`mirror.nju.edu.cn/github-release/.../latest` 国内降级）、`GREEN_ZIP_PREFIX`（`DSH_Launcher_GreenPortable_Online_`，分发 zip 资产名前缀）、`GREEN_UPDATE_DIR`（`runtime/update/` 暂存：zip/解压/备份/bat）。**方法**：`green_latest_release()`（官方→镜像逐试，只读）；`green_find_zip_asset()`（匹配前缀资产）；`download_green_update()`（复用 `download_with_progress` + 大小校验）；`prepare_green_update()`（解压 `_safe_extract_zip` 防路径穿越 → `_detect_zip_content_root` 兼容带/不带一层外层文件夹 → `_write_update_bat` 生成纯 ASCII+CRLF 的 `update_apply.bat`）；`launch_update_script()`（`DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP` 分离进程启动 bat，传入 exe/脚本模式的重启标志，随后启动器退出，bat 存活完成覆盖）。**GUI**：`on_check_green_update` → `confirm_green_update`（无 Release/已最新/发现新版确认下载）→ `ask_apply_green_update`（下载就绪确认退出覆盖），按钮「检查绿色版更新」排在「检查更新」右侧，服务运行中或忙碌时置灰。**覆盖脚本核心逻辑**（见避坑 #38）：等 exe 锁释放 → 备份被覆盖文件到 `runtime/update/backup/` → `robocopy /E`（`/XF config.json` 保留用户配置、`/XD runtime .git` 保护用户数据/仓库）→ 重启新版。版本比较 `_green_version_tuple`/`_green_version_greater`（数字分段，兼容 `v1.0.1`/长短版本），本地版本取 config `green_version` 优先否则常量 |

### 绿色整合的环境变量重定向（build_env）
| 环境变量 | 本地落点 | 作用 |
|----------|----------|------|
| `DSH_HOME` | `runtime/dsh-home` | dsh 会话/配置/存储 |
| `npm_config_cache` | `runtime/npm-cache` | npm 下载缓存（否则写 `~/.npm`） |
| `npm_config_userconfig` | `runtime/npm-userconfig` | 本地空配置，阻断读写 `~/.npmrc` |
| `npm_config_global` / `update_notifier` / `fund` | - | 禁全局安装、禁更新通知、禁赞助广告 |
| `PNPM_HOME` | `runtime/pnpm-home` | pnpm 全局目录（dsh 插件管理） |
| `npm_config_store_dir` | `runtime/pnpm-store` | pnpm 内容寻址存储 |
| `TEMP` / `TMP` | `runtime/tmp` | 进程临时目录 |

### 命令行模式
- `python launcher.py` → GUI（推荐，start.bat 走这个；GUI 常驻 mainloop 保持服务 stdin 管道打开）
- `python launcher.py --start` → 无界面**守护模式**：启动后保持进程存活（维持 stdin 管道，防止 dsh 退出），服务停止后本进程自动返回
- `python launcher.py --stop` → 停止服务
- `python launcher.py --purge-archived` / `--purge-session <ID>` → 数据维护（永久删除归档/指定会话，需先停止服务，见避坑 #29）
- `python launcher.py --restore-session <ID>` → 数据维护（复原/取消归档指定会话，需先停止服务，见避坑 #29 与需求 #16）
- `python launcher.py --install-plugin <本地目录或npm包名>` / `--remove-plugin <包名>` → 插件安装/移除（本地目录自动转 `file:`，见避坑 #30）

## 三、规范细节（遵循项目用户规则）
- `.bat` 文件：**纯 ASCII 编码 + Windows CRLF 换行符**（已用 `file` 命令校验）
- 所有变量名用英文全称、不缩写（如 `node_exe`、`server_process`，不用 `ne`/`sp`）
- 代码注释用中文，功能分支均有注释，不用简写语法
- Python 为解释型语言，无 `var` 类型声明问题，但类型用法保持直观明确
- 改动后同步更新本文档

## 四、避坑经验（实测于 Linux 沙箱，Windows 逻辑已按此编写）
1. **dsh 的 bin 入口不是顶层 bin/，而是** `node_modules/@deepseek-ai/dsh/lib/bin.js`（package.json 里 `bin.dsh` 指向它）。
2. **不要在 Windows 上依赖 `node_modules/.bin/dsh.cmd`**：npm 生成的 `.cmd` 回退分支用 PATH 里的 `node`，会把便携 Node 和系统 Node 搞混。必须用便携 `node.exe` + `lib/bin.js` 直接调用。
3. **DSH_HOME 一定要设置**：不设置时 dsh 会把会话/配置写到用户主目录，破坏"绿色整合"；设为 `runtime/dsh-home` 后所有数据落程序目录。
4. **npm 镜像二进制下载路径**：Node 二进制走 `registry.npmmirror.com/-/binary/node/...`，npm 包注册表走 `registry.npmmirror.com`，两者路径不同。
5. **Python 官方 embeddable 版不含 tkinter**：给用户说明必须装完整版 python.org 安装包，否则 GUI 起不来（launcher 已做了 ImportError 兜底提示）。
6. **CLI 模式后台线程陷阱**：`wait_and_open` 是 daemon 线程，`--start` 主进程退出后线程会消失，所以 CLI 模式要**同步** `wait_ready()` 再开浏览器；GUI 模式则用线程即可。
7. **首次 npm install dsh 较慢**（沙箱实测约 3 分钟、587 个包），界面提示"请耐心等待"。原实现只回显最后 15 行（用户看不到进度），**已改为实时逐行输出**（需求 #30）：npm 每行信息（`npm notice`/`added N packages`）会立即出现在日志框，用户可看到进度确认未卡住。
8. **冷启动重复检测**：再次 `--start` 时通过 PID 文件 + 进程存在性判断"已在运行"，避免重复起服务。
9. **便携 Node 里 npm 的位置分平台**：Linux/Mac 的 tar.gz 里 npm 在 `lib/node_modules/npm/bin/npm-cli.js`，Windows 的 zip 里在 `node_modules/npm/bin/npm-cli.js`。`find_npm_cli()` 必须两个路径都探测，否则会误退回系统 npm（已实测修复：现在日志显示"使用便携 Node 自带的 npm"）。
10. **npm 缓存默认写 `~/.npm`**：要让 npm 真正绿色，必须在 `install` 命令带 `--cache runtime/npm-cache`，并在环境变量设 `npm_config_cache`（实测重定向后缓存约 196MB 落在本地 runtime/npm-cache，HOME 下 `~/.npm`/`~/.pnpm-store`/`~/.local/share/pnpm` 均未产生）。
11. **`dsh plugin` 的插件管理走 pnpm**：预先设好 `PNPM_HOME` 和 `npm_config_store_dir` 指向本地，避免插件安装时把 store 写到用户主目录。
12. **【严重】dsh web 进程在 stdin 读到 EOF 时静默退出** → 网页报 "Failed to fetch" / "Service not running"：
    - 现象：`dsh web` 启动后短暂可访问，约 40 秒内进程自行退出、无任何报错（server.log 只有启动横幅）；此时浏览器里前端 fetch 全部失败 → "Failed to fetch"。
    - 根因：`subprocess.Popen` 未指定 `stdin` → 子进程继承父进程 stdin；在 `.bat`/守护/无 TTY 环境下 stdin 是 EOF，dsh 检测到后静默退出。
    - 判定实验：`tail -f /dev/null | node ... web`（stdin 保持打开）→ 服务 60 秒+ 依然存活；后台 `&`（stdin EOF）→ 40 秒内死掉。可复现、可对照。
    - 修复：`Popen(..., stdin=subprocess.PIPE)` 保持管道打开；并让 `--start` 变**守护模式**（Python 常驻持有管道写端，服务退出才返回）；GUI 靠 mainloop 常驻。另加 `watch_server` 线程记录异常退出，避免再静默。
    - 注意：`grep 3080` 会误匹配 `13080`（子串），排查端口要用 `grep -w 3080`，否则会误判"在监听"。
13. **独立 `--stop` 停止时守护线程会误报"意外退出"**：守护进程的 `_stopping_server` 标志只在自身进程内生效；由另一个进程 stop 时标志不同步。已把该提示改成中性文案"若并非主动停止, 请查看日志"。
14. **【Windows 实测】`find_npm_cli()` 跨平台路径 bug（已修复）**：原实现用 `os.path.dirname(os.path.dirname(node_exe))` 当 node 发行根目录，在 Linux/Mac（node 在 `bin/` 下）是对的，但在 **Windows（node.exe 在发行包顶层）会多退一层**，导致找不到 `node_modules/npm/bin/npm-cli.js`，日志退回"使用系统 npm"→ 系统未装 npm 时报 `WinError 2 系统找不到指定的文件`。
    - 修复：按平台取根目录——Windows 用 `os.path.dirname(node_exe)`，Linux/Mac 用 `os.path.dirname(os.path.dirname(node_exe))`。
    - 修复后日志正确显示"使用便携 Node 自带的 npm 进行安装"。
15. **【Windows 实测】auto 镜像模式下 dsh 的 npm install 不会走国内镜像**：`resolve_mirror()` 返回 `("cn", True)`，而 `prepare_dsh()` 里 `if not is_auto:` 才附加 `--registry`，auto 模式下 npm 用默认官方 `registry.npmjs.org`，国内访问很慢甚至卡住（实测卡在 9.5MB 缓存不动）。
    - 处理：Windows 实机测试时把 `config.json` 的 `mirror` 改为 `"cn"`，npm install 走 `registry.npmmirror.com`，530 个包约 8 分钟装完。
    - 后续建议：auto 模式的"国内优先、失败回退官方"逻辑应扩展到 npm install 阶段（首次用 `--registry=cn` 试装，失败再换官方重试）。
16. **【Windows 实测】设置 API Key 时报 `EPERM: operation not permitted, rename '...\.credentials.yaml.xxx.tmp' -> '.credentials.yaml'`（偶发）**：
    - 现象：在 dsh 网页里保存 DeepSeek API Key 时偶发报 EPERM；重试一般即成功（实测凭证文件最终已正常写入 key）。
    - 排查结论：① 目录与文件 ACL 权限正常（Authenticated Users 有修改权限）、文件非只读；② 用 Python `os.replace`（等价 `MoveFileExW MOVEFILE_REPLACE_EXISTING`，与 dsh 原子写一致）对普通名 / 含 credentials 名的文件做 30 次覆盖替换均 0 失败，无法稳定复现；③ 目标机器运行**火绒安全**（`usysdiag` 进程，Windows Defender 实时防护已关闭）。
    - 根因判断：dsh 保存凭证采用"写 tmp 临时文件 + rename 原子替换"；火绒的实时防护过滤驱动扫描含真实 API Key 内容的 `.credentials.yaml` 时短暂锁定文件，恰好与 rename 重叠即报 EPERM。属安全软件实时扫描的**偶发竞态**，非代码 bug、非权限问题。
    - 处理建议：把 `DeepSeekHarnessLauncher` 整个目录加入火绒的"信任区/白名单"，避免运行时文件频繁原子替换被杀软干扰；偶发报错时直接重试保存即可。启动器无法干预 dsh 包内部的写文件行为，无需改 launcher.py。
17. **【迁移】dsh 的会话按工作区绝对路径组织**：`runtime/dsh-home/storages/workspace.json` 记录工作区的绝对路径（如 `D:\DeepSeekHarnessLauncher`、`E:\1\AI项目`），`sessions/` 目录也按工作区路径命名（`--D-DeepSeekHarnessLauncher--` 等）。整目录迁移到新电脑后，若新机工作区路径与旧机**不一致**，需在网页里重新选择/添加工作区（旧会话数据仍保留，不会丢失）；路径一致则完全无感。launcher 本身用 `os.path.dirname(os.path.abspath(__file__))` 动态定位 BASE_DIR，放任意路径都能启动，无写死路径。
18. **【内置 Python】python-build-standalone 的 `install_only` 压缩包解压后有顶层子目录**：其 `cpython-3.10.20+20260807-x86_64-pc-windows-msvc-install_only.tar.gz` 用 tarfile 解压后，python.exe 不在 `runtime/python` 顶层，而在子目录 `runtime/python/python/python.exe`（随版本可能叫 `cpython-3.x...`）。`find_python_exe()` 必须**先查顶层 `python.exe`，再遍历一层子目录**（`sorted(os.listdir)` 保证确定性），两种布局都兼容。官方完整版发行自带 `_tkinter.pyd`/`tk86t.dll` 等，GUI 可直接用。
19. **【exe 打包】PyInstaller onefile 模式下 `__file__` 不可用作程序根目录**：onefile 打包运行时，`__file__` 指向临时解压目录 `_MEIPASS`（`sys._MEIPASS`），用它会找不到同级的 `runtime/`。正确做法是 `get_base_dir()`：`getattr(sys, "frozen", False)` 时取 `os.path.dirname(os.path.abspath(sys.executable))`（即 exe 所在目录），否则取脚本目录。这样 exe 与 `runtime/` 同级放置即可正常工作。
20. **【exe 打包】PyInstaller 本地安装 + 国内镜像**：为不污染系统/不用 C 盘，`build_exe.bat` 用 `pip install --target runtime\pyinstaller -i https://pypi.tuna.tsinghua.edu.cn/simple pyinstaller` 装到项目目录，再设 `PYTHONPATH=runtime\pyinstaller` 后用 `python -m PyInstaller` 调用；加 `--onefile --windowed --noupx`（禁用 UPX 减少杀软误报）。打包用 `--windowed` 后 exe 无控制台，`--stop` 等命令行模式的输出不可见，但逻辑正常执行（退出码 0 验证通过）。
21. **【GUI 重构】启动按钮拆分为"安装/启动/停止/刷新状态"**（按 tkinter 规范 skill 优化）：
    - **状态可视化**：顶部用 `tk.Canvas` 画状态圆点（绿=运行中 / 黄=已就绪待启动 / 灰=未安装）+ 状态文字（加粗）+ 详情小字；`refresh_status()` 统一负责重算状态并联动按钮可用性。
    - **按钮拆分**：`安装环境`(prepare_all) / `启动服务`(start_server) / `停止服务`(stop_server) / `打开界面` / `刷新状态` 五个独立按钮，避免"一个启动按钮反复点"。
    - **防重入**：用 `is_busy = [False]`（列表包装以便闭包赋值）作防重复标志；`set_busy(True/False)` 统一禁用/恢复按钮，后台线程结束时用 `root.after(0, lambda: set_busy(False))` 切回主线程恢复。
    - **按钮联动**：安装→启动→停止按状态自动可用/禁用（如服务运行中自动禁用安装/启动、仅停止/打开可用）。
    - **状态检测超时**：`is_server_running()` 里 Windows 的 `tasklist` 调用加 `timeout=5`，避免刷新状态时界面卡死。
    - **避坑**：闭包里先引用后定义（`refresh_status` 引用后续创建的 `install_btn` 等）没问题，只要首次调用发生在所有按钮创建之后即可；此处首调放在按钮创建后的 `refresh_status()`。
22. **【检查更新】dsh 升级的备份优先策略**：
    - **为什么原来"装了就永远最新"是错觉**：旧逻辑 `prepare_dsh()` 只在 dsh 缺失时安装，已安装就被判"就绪"跳过，官方发新版后本地不会自动变新。同步的唯一途径是手动删 `runtime/dsh`。
    - **查询只读不改**：`dsh_latest_version()` 用 `npm view @deepseek-ai/dsh version`（复用 find_npm_cli + build_env + registry 镜像参数，与安装同源），只查不改，失败返回 `None` 而非抛错。
    - **备份优先、失败即中止**：`update_dsh()` 顺序 = 查询最新版 → `backup_dsh()` 把旧版 `shutil.copytree` 到 `runtime/dsh-backup-<版本>`（同名备份自动加时间戳后缀避免覆盖）→ 备份成功后才 `prepare_dsh(force=True)` 强制重装。备份失败直接中止，防止"旧版被覆盖又没装上"的数据丢失。
    - **防误删**：备份目录不做自动清理，是否删除交给用户手动管理（GUI 弹窗里已明确提示备份位置）。
    - **代码复用**：把原 `prepare_dsh` 的安装主体抽成 `install_dsh()`，`prepare_dsh(force)` 只负责"缺失则装 / 强制重装"分支，首装与更新共用同一安装代码，避免双份逻辑漂移。
    - **UI 防重入**：「检查更新」与「更新执行」均走 `set_busy` 互斥；弹窗确认（`askyesno`）在查询线程结束后用 `root.after(0, ...)` 回主线程弹出，避免跨线程弹窗。
23. **【插件管理】`dsh plugin` 依赖 pnpm 且必须用便携环境**：
    - **机制**：`dsh plugin --profile <name> <pnpm 参数>` 会转发给 pnpm 管理该 profile 的依赖（`profiles/<name>/package.json` 的 `dependencies` + `node_modules`）。因此插件的"已安装清单"就是读 profile 的 `package.json`，无需调 dsh 查询接口。
    - **pnpm 必须装进便携 runtime**：绿色版不内置 pnpm。`install_pnpm()` 用便携 node 的 npm `install -g pnpm --prefix runtime/pnpm-home`，并把 `runtime/pnpm-home` 加入 `build_env()` 的 PATH，`dsh plugin` 才能转发到便携 pnpm（否则报 pnpm not found / 误用系统 pnpm）。
    - **`pnpm --version` 直接用会失败**（退出码 1）：pnpm.cmd 内部要调 node，必须在 `build_env()`（PATH 含便携 node）下运行才正常。GUI/CLI 一律走 `run_plugin_command()` 的统一环境，不裸跑 pnpm。
    - **GitHub 官方话题页抓取正则**：`https://github.com/topics/dsh-plugin` 的仓库条目形如 `href="/owner/repo" ... class="Link text-bold wb-break-word">名字</a>`；实测能抓约 20 个热门仓库（按星标）。页面结构变化需用 `runtime/tmp/test_gh_topic.py` 回归验证。
    - **GitHub 源插件安装规格**：搜索结果里 source=github 的项装成 `github:owner/repo`；GitHub 仓库未必是 npm 包，安装可能失败，属预期，界面会提示失败原因。
    - **GUI 多窗口线程安全**：插件窗口内所有耗时操作（搜索/安装/移除）在 `threading.Thread` 中执行，结果用 `root.after(0, ...)` 回主线程刷新列表/弹窗；`plugin_busy` 用列表包装以便闭包赋值，忙时禁用全部操作按钮防重入。
    - **GitHub topic 页的仓库 ≠ 插件本体**（2026-08-14 实测 `Anionex/agent-vision-toolkit`）：主仓库根目录往往没有 `package.json`（是跨 agent 的 Python 工具集 + skill + 文档），真正的 dsh 插件可能是**独立子仓库 + npm 包**（本例为 `@dsh-external/dsh-vision-toolkit`，官方 Profile Bundle，`dsh.bundle.patch` 指向 `cordis.patch.yml`，今天发布 v0.1.4）。判断标准仍是"根目录有无 package.json + `dsh.bundle`/入口"。已在 web profile 实测安装成功。
24. **【插件管理】"已装列表空白 / 搜索不到可安装插件"的根因排查（2026-08-14）**：
    - **数据链路本身是通的**：用 AST 抽取 `open_plugin_manager` 源码 + 真实 Tk 环境运行，左侧"已安装插件"Treeview 能正确插入 `@dsh-external/dsh-vision-toolkit`（`refresh_log.txt` 记录 `dependencies={'...': '^0.1.4'}` 且 `插入后 items='I001'`）；`list_installed_plugins` 读 `profiles/web/package.json` 的 `dependencies` 也返回正确。**界面空白不是代码 bug，而是用户跑的是旧版 `DSH_Launcher.exe`**（exe 比 launcher.py 旧 2 分钟，PyInstaller 打的是旧代码）。排查流程：对比 `Get-Item launcher.py, DSH_Launcher.exe` 的 `LastWriteTime`，发现 exe 旧 → 重新打包即可。
    - **npm 搜索"搜不到"的真正原因**：npm 搜索接口 `/-/v1/search?text=dsh-plugin&size=100` 本身正常（实测返回 630 个结果），但**全量结果混入了大量不是 dsh 插件的普通 npm 包**（按"dsh-plugin"文本匹配到无关工具），用户看到的"能装的"很少。修复：`search_npm_plugins` 增加 `_is_dsh_plugin_package` 静态过滤器——包名/关键词/描述任一命中 `dsh`/`dsh-plugin`/`deepseek-harness` 才保留，`size` 提到 100 保证过滤后仍有货（实测过滤后仍 100 个全为 dsh 相关）。
    - **`keywords:dsh-plugin` 限定查询在 npmmirror 返回 0**（实测）：镜像搜索索引对 keywords 限定支持不完整，别依赖它；用纯文本 `text=<关键词>` + 本地过滤最稳。
    - **新增「加载推荐」按钮**：内置 `RECOMMENDED_PLUGINS` 常量（npm 上已核实的 12 个 dsh 插件，含 `@dsh-external/dsh-vision-toolkit`、dsh-find-plugin、dsh-remote、dsh-clawrouter、dsh-lark-bot、dsh-email 等），一键填充搜索结果，**不依赖网络/GitHub 也能看到可安装项**；来源列标"推荐"，安装规格仍是裸 npm 包名。
    - **GUI 验证脚本**：`runtime/tmp/test_gui_plugin_final.py` 是端到端回归脚本（AST 抽取真实 `open_plugin_manager` 源码 → 点真实按钮「加载推荐」「搜索」→ 校验三个 Treeview），跑 `runtime\python\python\python.exe runtime\tmp\test_gui_plugin_final.py`。**避坑**：worker 线程用 `root.after` 回主线程，验证时主线程必须处于 `mainloop` 中，否则报 `RuntimeError: main thread is not in main loop`——测试脚本要用 `root.after(500, check)` + `root.mainloop()`，不能只用 `root.update()` 轮询。
    - **Windows 幂等重建 exe**：`$env:PYTHONPATH = "D:\...\runtime\pyinstaller"; runtime\python\python\python.exe -m PyInstaller --onefile --windowed --noupx --noconfirm --name DSH_Launcher --distpath dist --workpath build --specpath build launcher.py` 再 `Copy-Item dist\DSH_Launcher.exe .`；`build_exe.bat` 已封装同样流程（末尾 `pause` 仅交互用，脚本化可直接跑上面命令）。
25. **【插件管理】真正导致"中间两个面板全空白"的 bug：`ttk.Panedwindow` 必须显式 `.add()` 子控件（2026-08-14 晚）**：
    - 前面 #24 误判为"用户跑旧 exe"，用户明确排除"没更新"方向后深挖，发现**真凶**：`middle = ttk.Panedwindow(top, orient="horizontal")` 之后只 `installed_frame = ttk.LabelFrame(middle, ...)` / `search_frame = ttk.LabelFrame(middle, ...)`，**漏了 `middle.add(installed_frame, weight=1)` 与 `middle.add(search_frame, weight=2)`**。`Panedwindow` 不像普通 Frame 那样由子控件的 `pack` 自动布局——子控件必须通过 `.add()` 注册，否则中间区域完全空白（截图只剩顶部工具栏和底部手动安装栏）。
    - **教训**：用 `ttk.Panedwindow` 时，每个子面板都必须显式 `paned.add(child, weight=N)`，weight 控制左右比例；`weight` 越大占越宽。本次左侧 `weight=1`、右侧 `weight=2`。
    - **回归验证要覆盖"布局存在性"**：`test_gui_plugin_final.py` 通过 `collect()` 递归收集 `Treeview / Button / Scrollbar`，若数量不符即可抓出"控件建了但没被布局/注册"这类问题（本轮加了 Scrollbar 收集后 `scroll_ok` 才为 True）。
26. **【插件管理】左右列表加垂直滚动条 + 条目右键打开网页（2026-08-15）**：
    - **滚动条布局**：Treeview 外面套一层 `ttk.Frame`（`installed_body` / `search_body`），`tree.pack(side="left", fill="both", expand=True)` + `scrollbar.pack(side="right", fill="y")`；`ttk.Scrollbar(orient="vertical", command=tree.yview)` 且 `tree.configure(yscrollcommand=scrollbar.set)` 双向联动。不要直接在 Treeview 上 `.pack` 滚动条（放不下，会挤掉列表）。
    - **【大坑】列宽总和会把滚动条压缩成 1x1 不可见**：右面板"搜索结果"原本 4 列（插件名 210 + 来源 60 + 版本 70 + 描述 250 = **590px**），面板可用宽约 592px，Treeview 的 pack 先占满宽度后，**右侧 `fill="y"` 的滚动条得不到剩余横向空间，被 pack 压缩成 1x1、`winfo_viewable()=False`（在窗口里完全看不到，但代码存在、yview 也能滚）**。左面板"已安装"只有 2 列（250+90=340px）空间充足所以正常——这就是"只做了已安装的"表象。
    - **修复**：把搜索结果列宽缩窄为 160+48+58+180（共 446px），并给描述列加 `stretch=True`（宽度不足时自动压缩），保证列宽总和明显小于面板宽度，滚动条才能正常显示。**教训：凡在固定宽度容器里 pack 滚动条，必须先确认内容(列宽/请求宽度)总和留足余量，否则滚动条静默消失。**
    - **验证技巧**：不能只看 `winfo_children()` 里有没有 Scrollbar，必须 `sb.winfo_viewable()` / `sb.winfo_width()` 检查是否真可见；且测试要等窗口真实映射（`top.deiconify()+lift()+mainloop 后再查`），exec 出的 Toplevel 不强制显示时 `viewable` 恒为 False 会误判。
    - **右键菜单实现**：用 `tk.Menu(top, tearoff=0)`，`tree.bind("<Button-3>", lambda e: on_plugin_right_click(tree, url_map, e))`；回调里 `tree.identify_row(event.y)` 取被点行 → `tree.selection_set(row_id)` 选中 → `menu.tk_popup(event.x_root, event.y_root)` → `menu.grab_release()`。**关键**：菜单命令用 `lambda u=url: webbrowser.open(u)` 绑定默认参数捕获循环变量，否则闭包会取最后一个值。
    - **网址构造**：左侧"已安装"与右侧"搜索/推荐"各维护一个 `{item_id: info}` 映射（`installed_item_urls` / `search_item_urls`），刷新列表时同步 `clear()`+重建。`build_open_urls` 逻辑：github 来源 → 直接打开仓库地址 + npm 页面；npm/推荐来源 → npm 页面 + GitHub 搜索 `https://github.com/search?q=<包名>`（npm 搜索 API 的 `links` 在 npmmirror 实测为空，拿不到真实仓库地址，故用搜索兜底）。附加"复制包名"菜单项（`root.clipboard_append`）。
    - **AST 抽取闭包函数单独验证**：`build_open_urls` 是 `open_plugin_manager` 内部闭包，测试脚本用 `ast.get_source_segment` 抽出该函数源码、`exec` 到独立 namespace（需注入 `urllib`）再纯逻辑校验，绕开"闭包无法从外部访问"的限制。
    - 本次改动后回归全过：两滚动条 `winfo_viewable()` 均 True；exe 已重打包并启动实测无崩溃。
27. **【插件安装】npm 包 package.json 带 UTF-8 BOM 导致 dsh JSON.parse 崩溃（2026-08-15）**：
    - **现象**：`dsh plugin add` 执行成功（pnpm 正常下载安装），但 dsh 后续 reconcile 读已装包的 `package.json` 时 `JSON.parse` 报 `SyntaxError: Unexpected token '\ufeff'` — 这是 UTF-8 BOM（`EF BB BF`）被 Node 的 `JSON.parse` 直接拒绝。典型错误栈：`readProfileManifest → exportsPatch → reconcilePlugins`。
    - **根因**：个别 npm 包（如 `dsh-tool-vision@0.1.0`）发布时 package.json 以 UTF-8 BOM 开头，pnpm 原样保存到 `node_modules` 和 pnpm store 中。dsh 的 `readProfileManifest` 用 `readFileSync(path, "utf8")` 读入 → `JSON.parse(raw)`，BOM 作为非法字符导致解析崩溃。
    - **修复**：在 `run_plugin_command` 中新增 `strip_bom_from_profile_packages(profile)` 方法，在每次执行 dsh 命令前先遍历 profile 的 `node_modules` 下所有 `package.json`，检查前 3 字节是否为 `EF BB BF`，是则原地去 BOM 写回。命令失败后（pwd 为本次 pnpm 新装的包带 BOM）再清一次并重试一次（pnpm 幂等，不重复下载，很快完成）。
    - **典型复现包**：`dsh-tool-vision`（`node_modules/dsh-tool-vision/package.json` 开头字节 `EF BB BF 7B 0A 20`）。
    - **教训**：任何 npm 包的 `package.json` 都可能带 BOM，直接 `JSON.parse` 不安全。如果项目自定义了读 `package.json` 的逻辑，应在读入后 `JSON.parse(raw.replace(/^\uFEFF/, ""))` 或前置去 BOM 步骤。日志中看到 `Unexpected token '\ufeff'` 或 `'\uFEFF'` 时，100% 是 BOM 问题。
28. **【插件开发】dsh 插件要同时声明 `dsh.bundle` 与 `dsh.client` 才会被宿主 + WebUI 双端加载（2026-08-15，用 DSH AI 开发 dsh-archive-purge 实测）**：
    - **机制**：dsh 插件 = npm 包 + 两个入口。`package.json` 里：
      - `dsh.bundle.patch` → 指向一个 `cordis.patch.yml`（声明把本插件作为一行插入 profile 插件树，`- insert: [{id, name}]`）；`dsh plugin add` reconcile 时据此把包加进 `dsh.profile.bundles`，服务启动时由 `@deepseek-ai/dsh-app-boot` 的 `loadProfile` 按顺序合成 bundle 补丁 → 用户层 `cordis.patch.yml` → `--patch` 覆盖层。
      - `dsh.client` → 声明 WebUI 客户端入口（`inject` + `platform: "web"`），由 `dsh-client-modules` 扫描注入；宿主端则暴露 `lib/index.js`（导出 `name` / `inject` / `apply`）。
      - `files` 数组**必须包含 `cordis.patch.yml`**，否则发布/安装后文件缺失，宿主端扫描不到该行（本次踩过：补了 bundle 声明却没把 yml 放进 files，装完 node_modules 里没这个文件）。
    - **只声明 `dsh.client` 的插件不会进插件树**（这是最初"设置页看不到清理归档"的根因）；反过来只声明 bundle 没有 client 则宿主加载但 WebUI 无入口。
    - **验证**：`dsh --profile web --dump-config` 看合成后的插件树里是否出现该行；服务日志无激活失败警告但路由/页面没上，先查 `files` 是否含 `cordis.patch.yml` 与 node_modules 里文件是否真的在。
    - **入口格式**：宿主端 `apply(ctx)` 用 `ctx.webServer.register({kind, path, handler})` 注册 HTTP 路由，返回值用 `ctx.effect(disposer, ...)` 注册释放；`inject` 数组声明依赖的服务（如 `["webServer", "workspaceRegistry"]`），cordis 会在激活前注入。客户端用加载器契约 `window.__ModuleLoader__.load({id, factory})`，在 `apply(ctx)` 里 `ctx.slots.inject("settings.section", ...)` 注册设置区块。
29. **【会话删除】dsh 没有"永久删除/取消归档"接口，归档(archive)只是把会话隐藏；彻底删除需在服务停止后直接操作数据文件（2026-08-15）**：
    - **启动器侧（launcher.py）**：`purge_session` / `purge_archived_sessions` 三处一并清：① `sessions/<工作区编码>/<会话ID>/` 日志目录 ② `storages/workspace.json` 的 `sessionIds` / `archivedSessionIds` ③ `storages/session_projcache.json` 缓存行。注意 `_delete_session_log_dir` **只按会话 id 在工作区目录下遍历查找**（不拼接用户输入进路径，防路径穿越）；JSON 写回用 `_atomic_write_json`（同目录临时文件 + `os.replace`）保证原子性，避免半写损坏。
    - **复原 = 反向操作归档标记（2026-08-15 新增）**：`restore_session(session_id)` 只把 id 从 `workspace.json` 的 `global.archivedSessionIds` 中移除并原子写回即可——日志、工作区归属、投影缓存 dsh 本来就没动过，天然无损。这与 `purge_session` 完全相反（purge 动三个来源，restore 只动归档标记一处），务必区分：**restore 不删任何数据**。
    - **插件侧（dsh-archive-purge 宿主）**：`workspaceRegistry.archivedSessionIds` 遍历 + `entity.detachSession(id)`（对未挂载 id 幂等）；`ctx.get("sessions")` 判活跳过运行中会话。已知取舍：dsh 没有"删归档 id"接口，摘除后 `archivedSessionIds` 会残留一个不指向任何会话的 id（隐藏标记，无害）；`session_projcache.json` 旧缓存行也无害，留待 dsh 自行覆盖。
    - **安全**：删除路由带自定义头 `x-dsh-plugin-purge: 1`（跨域请求无法带自定义头，会触发 CORS 预检且本服务不返回 CORS 头），防止外部网页对本地端口发起删除请求；路由只接受 POST。
    - **窗口期**：数据维护操作要求服务已停止（GUI 弹窗提示、命令行 `is_server_running()` 校验），避免与运行中的 dsh 写文件竞争。
30. **【本地插件安装】pnpm 对 `file:` 本地路径默认是拷贝不是软链（2026-08-15 实测）**：
    - 用 `pnpm add file:D:/.../plugins/dsh-archive-purge` 安装本地插件后，`node_modules` 里是**拷贝**（不是 symlink），后续改 `plugins/` 下源文件**不会**自动同步到 `node_modules`，必须重新安装（`pnpm add file:...` 幂等重装很快）。
    - 启动器 `install_plugin` / `--install-plugin` 用 `os.path.isdir(spec)` 识别本地目录并自动归一化为 `file:` 绝对路径（`\`→`/`），pnpm 才能识别；路径有中文/空格也 OK（pnpm 按 spec 处理）。
    - **排查思路**：改插件源码后 WebUI 没变化 → 先确认是不是没重装（对比 `node_modules/<包>` 与 `plugins/<包>` 的修改时间），再查 `profiles/web/package.json` 里 dependencies 与 `dsh.profile.bundles` 是否都有该包。
31. **【工作区】dsh 的 Windows ACL 沙箱要求临时根目录不能位于会话工作区内部；工作区归属记在会话 header，且工作区由用户在 GUI 选（2026-08-15 全量梳理）**：
    - **现象**：当会话工作区 = 程序根目录 `D:\DeepSeekHarnessLauncher` 时，所有 shell 工具报 `Windows ACL temp root must be outside the workspace`。根因：绿色整合把 `TMP/TEMP` 指向 `runtime/tmp`，它位于程序根目录内 = 位于工作区内 → dsh 的 ACL 沙箱拒绝。
    - **机制（三层概念要分清）**：
      1) **会话的"工作区归属"记在该会话自己的日志头（header）里**：`runtime/dsh-home/sessions/<工作区路径编码>/<会话ID>/session.jsonl.zstd` 第一行有 `cwd` 字段（如 `D:\...\workspace`），**一经创建就固化不可改**——所以旧会话永远换不了工作区，只能归档/删除或开新会话。
      2) **`storages/workspace.json` 只是"工作区注册表"**（展示/分组的平行台账）：只记每个工作区的 `{path, title, sessionIds, createdAt, updatedAt}`、全局 `archivedSessionIds`、显示顺序 `workspaceIds`。**它不是会话的配置**；真正权威的是会话 header 的 `cwd`，两者还会互相校验（挂会话进工作区要求 header.cwd 规范化后 === 工作区 path）。
      3) **沙箱判定读 header.cwd**：`dsh-sandbox-policy` 里 `workspaceRoot = session.header.cwd`。cwd 是子目录的会话 ACL 检查通过，cwd 是程序根目录的老会话就报 temp 冲突。
    - **新会话会不会自动建子工作区？不会**。工作区是用户在 WebUI 左侧手动选的（`session.create({workspaceId})` → 后端查注册表拿 path 当 cwd 写入 header → 会话 id 记进该工作区 sessionIds → 日志落 `sessions/<编码>/<会话ID>/`）。启动器不拦截用户选择，只负责预置一个可用的默认工作区。
    - **修复 v1（写死）**：把默认工作区写死为 `BASE_DIR/workspace`（`WORKSPACE_DIR` 常量 + `seed_default_workspace()` 预置注册表记录）。缺点：写死了路径，若用户把 `tmp_dir` 配到程序目录外，程序根目录其实可安全用作工作区，仍会多建一个 workspace 子目录。
    - **修复 v2（自动，本次）**：删除 `WORKSPACE_DIR` 写死，改 `DEFAULT_WORKSPACE_SUBDIR="workspace"` 仅作为子目录名 + 三个方法：
      - `_tmp_dir()`：取生效临时根目录（config `tmp_dir` 优先）。
      - `workspace_conflicts_with_tmp(path)`：`os.path.normcase/normpath/abspath` 归一化后用 `os.path.commonpath` 判"临时目录是否为工作区严格子路径"；不同盘符等 `ValueError` 按不冲突处理，不阻断启动。
      - `resolve_default_workspace()`：优先级 = ① config `default_workspace` 显式值（与临时目录冲突则警告并回退）→ ② 程序根目录本身不冲突则用它 → ③ 冲突才取 `BASE_DIR/workspace` 子目录。
      - `ensure_runtime_dirs()` / `seed_default_workspace()` 改走 `resolve_default_workspace()`（title 用目录 basename）。
    - **实测验证**（Windows）：当前 `tmp_dir=runtime/tmp` 时 `resolve_default_workspace()` 正确返回 `D:\DeepSeekHarnessLauncher\workspace`（程序根目录判为冲突）；`E:\1\AI项目` 判为不冲突；config 覆盖 `E:/x/proj` 直接用、覆盖为程序根目录则警告回退。语法检查通过。
    - **给用户的实操建议**：开新会话在 GUI 左侧工作区选择器选 **workspace**（`D:\DeepSeekHarnessLauncher\workspace`）或任何不含 `runtime/tmp` 的目录（如 `E:\1\AI项目`）再新建，shell 工具就能正常工作；旧工作区里已有的会话 shell 受限，不删除也不影响其它功能。

## 五、Windows 实机测试记录（2026-08-14，绿色整合验证）
### 测试环境
- 系统：Windows（PowerShell），Python 3.10.11（含 tkinter），便携 Node v22.20.0 + npm 10.9.3
- 测试命令：`python launcher.py --start`（守护）/ `python launcher.py --stop` / `python launcher.py`（GUI）

### 测试结果（全部通过）
| 项目 | 结果 |
|------|------|
| 便携 Node 检测 / npm-cli 定位 | ✅ 修复 #14 后走"便携 Node 自带 npm" |
| dsh 首次安装 | ✅ `@deepseek-ai/dsh@0.1.0-rc.6`，530 包，走 npmmirror 约 8 分钟 |
| 服务启动 | ✅ `dsh web --port 3080`，HTTP 200，页面标题 "DeepSeek Harness" |
| 服务停止 | ✅ `--stop` 停止，node 进程退出、PID 文件删除、端口 3080 关闭 |
| 二次启动 | ✅ 秒开（环境已就绪，不重复下载/安装） |
| GUI 启动 | ✅ 窗口 "DeepSeek Harness 一键启动器" 正常创建、响应正常 |
| 绿色整合 | ✅ 用户主目录零残留（`~/.npm`、`~/.pnpm-store`、`~/.local/share/pnpm`、`AppData/Local/pnpm`、`~/.config` 均未产生）；dsh 会话数据全在 `runtime/dsh-home`（profiles/storages/settings.yaml） |
| runtime 体积 | ✅ 约 528MB（Node + dsh 包 + npm 缓存 175MB + 会话数据） |

### 待办 / 建议
- 后续可把 auto 镜像的"国内优先、失败回退"逻辑扩展到 npm install 阶段（见避坑 #15）
- 独立 stop 时守护进程的"意外退出"提示为已知中性文案（避坑 #13），若体验要求可进一步优化为"端口关闭即视为主动停止"

## 六、避坑（续）

32. **【PowerShell】Invoke-RestMethod 发中文到 GitHub API 会变问号（编码坑，2026-08-15）**：
    - **现象**：`ConvertTo-Json` + `Invoke-RestMethod` 发送含中文的 body 给 GitHub API，GitHub 收到后所有中文变成 `?`。
    - **根因**：PowerShell 的 `Invoke-RestMethod` 在 `-Body` 传 string 时，默认按本地 ANSI 编码（Windows 中文系统 = GBK）序列化，而 GitHub API 按 UTF-8 解析，GBK 字节到 UTF-8 里非 ASCII 字符全部变 `?`。
    - **修复**：不用 `-Body $jsonString`，改成 `$bytes = [System.Text.Encoding]::UTF8.GetBytes($jsonString)` + `-Body $bytes` + `-ContentType "application/json; charset=utf-8"`，强制 UTF-8 字节发送。
    - **验证**：PATCH 修复后 body/name 中文正常。
    - **教训**：以后任何 PowerShell 调 REST API 涉及中文，一律走 `UTF8.GetBytes` 字节流，不要直接传 string。`ConvertTo-Json` 生成的 string 本身是 UTF-16 在内存里，但 `-Body` 参数会丢给 `Content-Type` 的 charset 做编码转换，不传 charset 则用默认 ANSI。

33. **【DSH 插件】客户端插件不进 WebUI 的坑：`package.json` 的 `exports` 必须导出 `./package.json`（2026-08-15）**：
    - **现象**：`dsh-archive-purge` 插件已装进 `profiles/web` 的 `dsh.profile.bundles`、`--dump-config` 插件树里也合成了 `archive-purge` 条目、服务正常启动，但 WebUI「设置 → 清理归档」入口死活不出现。
    - **根因**：宿主端 `@deepseek-ai/dsh-client-modules` 的 `ClientModuleRegistry.resolveMeta()` 靠 `require.resolve("<插件名>/package.json")` 扫描**已加载进 cordis loader** 的条目，再看 `dsh.client.platform === "web"` 才把客户端 bundle 写入 `window.__DSH_BOOT__` 模块表。而插件 `package.json` 的 `exports` 只写了 `"."` 和 `"./client"`，**没写 `"./package.json"`**，于是 `require.resolve("dsh-archive-purge/package.json")` 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，该插件被当作"不是客户端包"跳过 → 模块表里没有它 → WebUI 不显示。服务端 `resolveBundleDir` 用的是 `createRequire().resolve.paths()` + `existsSync`，不受 `exports` 限制，所以服务端插件树照常合成，二者行为不一致造成"服务端在、客户端不在"的假象。
    - **修复**：插件 `package.json` 的 `exports` 增加 `"./package.json": "./package.json"`，然后**重新安装**插件（pnpm 对 `file:` 是拷贝非软链，改源文件后必须重装 `--install-plugin` 同步到 `node_modules`），重启服务。
    - **验证**：`GET http://127.0.0.1:3080/` 的 `window.__DSH_BOOT__.entries` 里出现 `dsh-archive-purge` 条目（rev 变化），WebUI 设置页左侧出现「清理归档」，点击进入有「立即清理归档会话」按钮，控制台无 JS 报错。
    - **教训**：写 DSH 客户端插件时，`exports` 字段要仿照官方包（如 `dsh-api-remotes`）带上 `"./package.json"`；排查"客户端功能不显示"先抓首页 `__DSH_BOOT__` 模块表是否含该插件，再用 `node -e` 验证 `require.resolve("<插件>/package.json")` 是否抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。

34. **【DSH 插件】路由"注册后立即被注销"→ 点击按钮报 HTTP 405（2026-08-15）**：
    - **现象**：`dsh-archive-purge` 客户端入口正常显示，点击「立即清理归档会话」后提示 **HTTP 405**。此时 `POST http://127.0.0.1:3080/__dsh/archive-purge`（带自定义头）返回 405，而 `dsh-host-webserver` 的路由匹配逻辑（`match()`：先查 `exact` 表再查 `prefixes` 表，未命中才落到 `frontend-static` 的 fallback）本身不产生 405——405 是 fallback 对**非 GET/HEAD** 请求的默认响应（`dsh-host-frontend-static/lib/index.js` `apply()` 里 `req.method !== "GET" && req.method !== "HEAD" → res.writeHead(405)`）。所以 **405 = 插件的路由根本没在 exact 表里**。
    - **根因（误用 `ctx.effect`）**：Cordis 的 `ctx.effect(fn, label)` 会**立即执行 `fn()`**，并把 **`fn()` 的返回值**当作"清理函数"（dispose）存起来。官方写法是 `ctx.effect(() => ctx.webServer.register(route), "…")`——`register` 的返回值（注销函数）正是 `fn()` 的返回值，被存为清理函数。而我们的初版写成：
      ```js
      const disposer = ctx.webServer.register({...});  // 先注册
      ctx.effect(disposer, "…");                        // 把"注销函数"当成 fn 传进去
      ```
      于是 `ctx.effect` 把 `disposer()` 当作 setup **立即执行**，路由刚注册进 exact 表又被 `table.delete(path)` 删掉 → 之后所有请求都落到 fallback → 非 GET 一律 405。客户端能显示（`dsh-client-modules` 靠 `require.resolve(package.json)` 扫元数据，与宿主 `apply` 是否成功无关），造成"入口在、路由不在"的假象。
    - **修复**：改成官方写法 `ctx.effect(() => ctx.webServer.register({...}), "dsh-archive-purge: route")`。
    - **验证**（重启服务后实测）：`GET`（带头）返回 `{"ok":true,"total":0,"sessions":[]}`；`POST`（空体）返回 `{"ok":true,"total":0,...}`；`POST {"ids":["fake"]}` 只处理传入 id 返回 `detached-only`——200 而非 405。
    - **教训**：宿主插件注册任何路由/资源，**必须**用 `ctx.effect(() => 注册(...), label)` 模式；凡是"注册了但请求还是 404/405"的，先怀疑这个。同时注意 `dsh-client-modules` 与宿主端对"插件是否成功"的判定是两套独立机制，客户端显示了不代表宿主 `apply` 成功。

35. **【Skill 打包】PowerShell `Copy-Item -Recurse` 目标目录已存在时会把源目录整个嵌进去（嵌套副本，2026-08-15）**：
    - **现象**：`Copy-Item -Path "D:\...\skills\dsh-deploy-maintain" -Destination "C:\Users\bodyy\.trae-cn\skills\dsh-deploy-maintain" -Recurse` 后，目标出现 `...\dsh-deploy-maintain\dsh-deploy-maintain\` 嵌套（源目录被当子目录复制进已存在的同名目标）。
    - **原因**：目标目录已存在（第一次已写了 SKILL.md），`Copy-Item -Recurse` 把**源目录本身**作为目标下的子目录创建，而非合并内容。
    - **修复**：目标已存在时改用 `Copy-Item -Path "源\*" -Destination "目标\" -Recurse -Force`（通配符展开内容），或先删空目标再整目录复制。
    - **教训**：复制目录到可能已存在的目标前，先确认目标是否为空；Skill 安装后必须 `Get-ChildItem -Recurse` 核对结构（`SKILL.md` 应在技能根目录，不能套一层同名子目录，否则 TRAE 识别不到）。同时 Skill 目录应**先在项目内写好**（编辑工具限制在工作目录内，无法直接写 `~/.trae-cn/skills`），再复制安装。

36. **【发布流程】Skill 打包 zip 也发到 GitHub Release、不进仓库（2026-08-15）**：
    - **约定**：与分发 zip `DSH_Launcher_*.zip` 一致，Skill 打包产物 `DSH_Skill_*.zip` 同样只作为 Release 资产（发到 GitHub Releases 供下载/安装），**不提交进 git 仓库**。`.gitignore` 已把 `DSH_Skill_*.zip` 一并忽略，避免 git status 常年显示未跟踪文件。
    - **命名**：`DSH_Skill_<skill名>_<YYYYMMDD>.zip`；内容为 skill 目录本身（含 `SKILL.md` 在根，不能套一层同名子目录，见避坑 #35）。分发 zip 命名 `DSH_Launcher_GreenPortable_Online_<YYYYMMDD>_v<tag>.zip`。
    - **发布步骤**：提交并 push 代码 → 打 tag（`git tag vX.Y.Z` + `git push origin vX.Y.Z`）→ 用 GitHub API 创建/更新 release 并上传两个 zip（中文 body 必须走 `[System.Text.Encoding]::UTF8.GetBytes()` 字节流，见避坑 #32）。
    - **教训**：上传 Release 资产前先核对 zip 内的 `launcher.py`/`DSH_Launcher.exe` 等文件长度与本地一致（`Compress-Archive` 后可能有旧缓存），并用 `Invoke-WebRequest -Method Head` 验证下载 URL 返回 200。
    - **【约定 2026-08-15】Skill 同步目标 = 项目内 zip**：用户指定以后新经验整合同步到 **`skills/Skill-dsh-deploy-maintain.zip`**（打包更新该 skill 即可）。流程：改 `skills/dsh-deploy-maintain/` 源文件 → 删除旧 zip → `Compress-Archive -Path "skills\dsh-deploy-maintain" -DestinationPath "skills\Skill-dsh-deploy-maintain.zip"`（zip 根为 `dsh-deploy-maintain\` 文件夹，SKILL.md 在该层）→ 用 `[System.IO.Compression.ZipFile]` 读 SKILL.md 校验含最新关键词（防旧缓存）。`.gitignore` 已加入 `Skill-dsh-deploy-maintain.zip` 不提交仓库；该 zip 与 `~/.trae-cn/skills` 副本二选一作安装来源。

37. **【GUI 测试】Tk 测试脚本按 `tk.Frame` 判断控件会漏掉 `ttk.Frame`（2026-08-15）**：
    - **现象**：给「清理归档」弹窗写的冒烟测试 `runtime/tmp/test_purge_dialog.py`，用 `isinstance(child, tk.Frame)` 遍历弹窗子控件找 Treeview/Button，结果 `tree=None all=None del=None`——明明弹窗开出来了，却"找不到任何控件"。
    - **根因**：`tkinter.ttk.Frame` 继承自 `ttk.Widget`（混入类），**不是** `tkinter.Frame` 的子类；而 launcher.py 的布局全部用 `ttk.Frame`/`ttk.LabelFrame`。用 `tk.Frame` 判断自然一个都匹配不上（`ttk.Button`/`ttk.Treeview` 同理，需按 ttk 类判断）。
    - **修复**：测试脚本改用递归收集器 `collect_widgets(widget, wanted_type, found)`，按目标类型（`ttk.Treeview` / `ttk.Button`）递归 `winfo_children()` 收集，再按文字特征（"全选/全不选"、"删除选中…"）匹配目标控件。
    - **教训**：凡是遍历 Tk 控件树做断言，一律用具体类型（`ttk.Treeview`、`ttk.Button`）而不是 `tk.Frame` 这类宽基类；先确认真实布局用的到底是 `tk` 还是 `ttk` 系列。修复后测试通过：全选 → 逐个取消 s2 → 「删除选中」→ 正确删除 `['s1', 's3']`（`RESULT ok=True`）。

38. **【WebUI 单页面去重】心跳去重的关键设定与避坑（2026-08-15）**：
    - **前端注入点**：`frontend_index_path()` 定位到 `@deepseek-ai/dsh-web-frontend/dist/index.html`（`dsh-web-app` 通过 `require.resolve` 解析该路径，服务每次请求都 `readFile` 后经 `applyIndexTaps` 渲染——改文件立即生效，无需重启服务）。注入脚本放在 `</body>` 前，经典脚本解析即执行，不依赖应用 bundle。
    - **幂等写法**：以 `UI_BEACON_MARKER_START/END` 标记包裹整块脚本；已存在时整体替换（令牌/端口变了也能更新），未变化则跳过写文件（比较块内容，mtime 不变）。
    - **心跳判定窗口**：`UI_ALIVE_WINDOW=180` 秒——浏览器后台标签页的 `setInterval` 会被节流到约 60 秒一次（Chrome），窗口必须大于节流间隔；代价是关掉标签页后最多 3 分钟内仍可能判定"已打开"（自动打开会跳过开新页），属可接受的取舍。**逃生通道**：手动点「打开界面」（`open_ui(force=True)`）不受该判定约束、必定开新页，因此关掉标签页后想立刻重开时点它即可。
    - **令牌防伪造**：任意本地网页都能 `no-cors` 打到 127.0.0.1:3081，若不做令牌校验，无关页面可伪造"界面已打开"导致永远不开新页；令牌写入 `runtime/ui-beacon.token` 持久化，重启启动器进程后旧标签页带旧令牌仍能上报（保证跨进程重启去重有效）。
    - **dsh 升级后必须重新注入**：升级=重装 `runtime/dsh`，`dist/index.html` 被覆盖、心跳脚本丢失；`install_dsh()` 末尾调 `patch_frontend()` 覆盖首装与更新两条路径，`start_server()` 启动前再兜底补一次（仅服务未运行时才走到）。
    - **端口被占用不阻断**：3081 被其它程序占用时仅记日志，`ui_is_open()` 恒 False，行为退化为旧版（每次都开新页），绝不因去重功能阻塞服务启动。
38. **【update_apply.bat 不轮询 PID，改轮询 exe 文件锁（2026-08-15）】**：绿色版自更新（`runtime/update/update_apply.bat`）需要在启动器退出后执行覆盖安装。**绝对不能轮询 PID**：启动器进程退出后其 PID 立即被释放，Windows 可能**立刻复用**给另一个进程，此时 `tasklist /FI "PID eq %PID%"` 仍能匹配到新进程，导致等待循环**永不退出**（实测 `diag_bat_args.py` 验证：子进程退出后 bat 卡在 `step1_wait` 数分钟不前）。**正确方案**：轮询 exe 文件锁——`ren DSH_Launcher.exe .DSH_Launcher.exe.upd` 成功 = 文件锁已释放（启动器真退出），立刻恢复原名；失败则 `ping -n 2` 再试，最多 60 次（约 120 秒）。运行脚本模式（无 exe）时走 `:script_sleep` 分支直接 `ping -n 4` 等一小段。**技术细节**：`rename` 操作在 Windows 上要求独占文件句柄全释放，比 `tasklist` 更可靠；恢复原名的 `ren` 在解锁瞬间执行，几乎无竞争窗口。详见 `_write_update_bat()` 的 step 1 实现。

39. **【DSH 插件】动态插件（cordis_define，进程内）与静态插件（bundle patch，随服务启动）是两套形态（2026-08-15）**：
    - **动态插件**：DSH 会话内用 `cordis_define`/`cordis_run` 定义运行，只存在于当前进程内存、无磁盘文件，服务/会话重启即丢失，需重新 define+run（客户端包还要在 Run 卡片批准）。适合**临时验证**功能（快速试 UI/API）。
    - **静态插件**：`plugins/<包>/` 目录 = `package.json`（`dsh.bundle.patch` → `cordis.patch.yml` + `dsh.client`）+ `lib/index.js`（宿主，导出 `name/inject/apply`）+ `lib/client.js`（`window.__ModuleLoader__.load` 契约），经 `dsh plugin --profile web add file:<绝对路径>` 安装进 profile（pnpm 拷贝 + reconcile 自动写 `dsh.profile.bundles`），**服务启动时加载**，重启不丢、可随绿色版分发升级。适合**正式功能**。
    - **两形态的通信差异**：动态客户端用 `harness.handle`/`host.call`（Package 私有 RPC）；静态插件用 `webServer.register` HTTP 路由 + 客户端 `fetch`（带自定义头防跨站）。其余（插槽注册、`ctx.effect` 清理、exports 含 `./package.json`）完全一致。
    - **本次流程**：先用动态插件验证文件浏览可行性（期间修了 setState 通知不传值的 bug，见 #40）→ 转写静态插件 `dsh-file-browser` 安装。**启示**：新功能先用动态插件快速验证，稳定后转静态长期维护。
    - **验证静态插件是否合入插件树**：`node runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --dump-config`（需设 `DSH_HOME=runtime/dsh-home`）看合成树里是否出现该行。
40. **【DSH 插件客户端】跨插槽共享状态的 setState 通知必须传新值，否则点击无响应（2026-08-15）**：
    - **现象**：动态版文件浏览器「📁 文件」按钮可见，但点击无任何反应（面板不弹出、按钮不高亮），且无渲染报错、运行诊断正常。
    - **根因**：两个插槽组件（工具行按钮 + overlay 面板）用模块级 `listeners: Set` 共享开关状态，`setOpen` 里 `listeners.forEach((fn) => fn())` **调用时没带参数**，而 `fn` 是 `React.useState` 的 `setV` —— `setV()` 无参 = `setV(undefined)`，状态恒为 falsy → 面板永远 `return null`。
    - **修复**：`listeners.forEach((fn) => fn(open))`（把最新值作为参数传给 setState）。
    - **教训**：任何"模块级订阅 + setState 转发"模式，通知回调必须把最新值作为参数传入；排查"按钮点了没反应"先检查这类自定义 pub/sub 是否丢了参数。
41. **【launcher】Windows 控制台 GBK 编码下 launcher 打印 pnpm 输出崩溃（2026-08-15）**：
    - **现象**：`python launcher.py --install-plugin ...` 实际安装成功（profile 的 `dependencies`/`dsh.profile.bundles` 已更新、node_modules 已拷贝），但收尾打印 pnpm 输出行时报 `UnicodeEncodeError: 'gbk' codec can't encode character '\u2713'`（pnpm 的进度勾 '✓' 无法用 GBK 编码）→ 退出码 1，误导以为安装失败。
    - **根因**：`run_plugin_command` 里 `self.log("plugin: %s" % line)` 把 pnpm 输出打到 stdout，Windows 中文控制台默认 cp936(GBK)，'✓'(U+2713) 无法编码。
    - **处理**：执行时设 `PYTHONIOENCODING=utf-8`（`$env:PYTHONIOENCODING='utf-8'; python launcher.py --install-plugin ...`）；判定安装成功以 profile 的 `package.json`（dependencies + `dsh.profile.bundles`）与 `node_modules/<包>/` 是否拷贝为准，不要看最后的编码报错。
    - **教训**：launcher 在 Windows 中文控制台打印第三方输出（pnpm/npm）前，应统一 UTF-8 输出或对内容做可编码处理。
42. **【DSH 插件客户端】插槽条目组件里不要条件调用从 props 传入的 hook（如 `useInput`）→ 被错误边界吞掉、组件不渲染（2026-08-15）**：
    - **现象**：`dsh-file-browser` 的「文件」按钮不显示（服务端路由 200、`__DSH_BOOT__` 有模块、bundle 内容正确、SSR 渲染正常，但浏览器控制台有 `componentDidCatch` 报错——React 错误边界捕获了渲染异常，插槽渲染成 `data-slot-error` 空占位）。对照：`dsh-archive-purge` 的设置区块正常显示，说明客户端激活机制没问题，问题专属该组件。
    - **根因**：工具行按钮组件里写了 `const input = typeof useInput === "function" ? useInput() : null;` —— **条件调用从 props 传入的 hook**（standard-kit 的 `useInput`）。该 hook 的身份/可用性在不同渲染间可能变化（如会话绑定解析前后、重新渲染时），导致组件每次渲染的 hook 数量不稳定 → React 抛 "Rendered more/fewer hooks than during the previous render"，被错误边界捕获后该条目不渲染 → 按钮消失。Node/SSR 单测复现不了（测试里 props 恒定），只有真实 app 环境才触发。
    - **修复**：**不要调用 props 里的 hook**。当前草稿改从 ownerProps 读：`conversation.input.left` 的 InputZone ownerProps 直接带 `input: InputState` 快照（含 `draft`），即 `ownerProps.input.draft`，是普通数据不是 hook，绝对安全。`inputActions` 是普通对象 prop，可正常使用（`inputActions.setDraft(草稿+文本)` 追加）。
    - **排查方法**：客户端组件不渲染时，看浏览器控制台有没有 `componentDidCatch` / "Rendered more hooks"/"Rendered fewer hooks" 报错；用 SSR（react-dom/server renderToString + 真实 React）单测能排除组件本身逻辑问题，但**无法复现 props-hook 身份漂移**——真实环境优先怀疑"从 props 拿 hook 并条件调用"。
    - **教训**：插槽条目的 standard props 里，**hook（`useXxx`）只能无条件调用且不依赖其身份稳定性**；若需要读快照数据，优先用 ownerProps 里已有的普通数据字段，而不是通过 props hook 现取。改客户端源码后 bundle 按请求重新生成（rev 变化），**强制刷新页面即可生效，不必重启服务**。**本经验已同步至 `skills/dsh-deploy-maintain/`（SKILL.md 4.6 + 速查表 + plugin-dev-checklist + plugin-skeleton 警告），并重建 `Skill-dsh-deploy-maintain.zip`。**

43. **【发布流程】Windows PowerShell 5.1 按 ANSI 读"无 BOM 的 UTF-8 .ps1"→ 脚本里中文常量乱码 → GitHub Release 正文中文变 `?`（2026-08-15）**：
    - **现象**：首次创建 v1.0.2 Release 时，发布脚本 `_release_tmp.ps1` 里写了中文正文，即使按避坑 #32 用 `[System.Text.Encoding]::UTF8.GetBytes()` + `-ContentType "application/json; charset=utf-8"` 发送，GitHub 收到后正文中文仍全部变 `?`（`body -match "更新内容"` 为 False、`body -match "\?"` 为 True）。
    - **根因**：Windows PowerShell 5.1 读取 `.ps1` 脚本文件时，**无 BOM 的 UTF-8 文件会被当作系统 ANSI（中文系统 = GBK）解码** → 脚本里的中文字符串字面量在内存里就已经是乱码 → 后续再怎么 `UTF8.GetBytes` 也救不回来。避坑 #32 只解决了"发送端按 UTF-8 编码"，没解决"脚本文件本身被按 GBK 读"这一层。
    - **修复**：**发布脚本保持纯 ASCII（一个中文字符都不写）**，中文 Release 正文单独放到一个 UTF-8 文本文件（如 `_release_body_tmp.md`，用编辑器/工具按 UTF-8 保存），脚本里 `[System.IO.File]::ReadAllText(路径, [System.Text.Encoding]::UTF8)` 显式按 UTF-8 读入，再 `ConvertTo-Json` + `UTF8.GetBytes` 发送。修复后（用 PATCH `/releases/{id}` 改 body）验证通过。
    - **验证**：`Invoke-RestMethod` GET release → `ConvertTo-Json` → `UTF8.GetBytes` 存成 UTF-8 文件 → 用 **python** 检查 body 含"更新内容"且无 U+FFFD / `?`（不要用 PowerShell 的 `-match "中文"` 校验——校验脚本里写中文同样会被 ANSI 读乱）；资产下载 URL 用 `curl.exe -s -I -L -o NUL -w "%{http_code}"` 验证返回 200。
    - **教训**：Windows PowerShell 里"脚本内含中文常量"一律按坑处理：要么把 `.ps1` 存成 **UTF-8 with BOM**，要么**脚本纯 ASCII + 中文拆到独立 UTF-8 文件显式读取**；任何中文校验也走 python/外部工具，别在 PowerShell 里写中文断言。
44. **【DSH 第三方插件排查】宿主端"工具型"插件（如 dsh-find-plugin）无 UI、只注册 agent 工具；且用 dump-config 验证插件树必须设 DSH_HOME（2026-08-15）**：
    - **现象**：用户通过插件管理器装了 `dsh-find-plugin`（npm `^0.3.5`，进了 `dsh.profile.bundles`），在 WebUI 看不到任何按钮/面板/设置项，感觉"没生效"。
    - **根因（两层）**：① 该插件是**纯宿主端工具插件**——`package.json` 只声明 `dsh.bundle.patch`，**没有 `dsh.client`（无 WebUI 客户端入口）**，源码 `lib/index.js` 仅通过 `ctx.tools.register(defineTool({ name: 'find_dsh_plugin', ... }))` 注册一个 **agent 工具**（GitHub `dsh-plugin` topic 实时搜索，按 star 排序，返回描述 + 可直接执行的 `dsh plugin add` 安装命令）。它**不会在界面上出现任何东西**，只在对话里 agent 判定需要找插件时按需调用（如"帮我找一个能做微信通知的 DSH 插件"）。**"装完没见 UI"属于正常现象，不是装坏了。** ② 排查时我直接跑 `dsh --dump-config --profile web` **没设 DSH_HOME**，结果 dump 的是 `~/.dsh` 默认 home 的 profile（只有 dsh-base/dsh-web-app 两个内置 bundle），误判"插件没进插件树"——**必须 `$env:DSH_HOME=runtime\dsh-home` 后再 dump**，才能看到 `# == dsh-find-plugin` / `- id: find-dsh-plugin` 层。
    - **验证（设对 DSH_HOME 后）**：`dsh --dump-config --profile web` 输出末尾可见 `# == dsh-archive-purge`、`# == dsh-find-plugin`、`# == dsh-file-browser` 三段，说明三个插件都正常合成进树；工具能否被 agent 调用，还需 `dsh web` 服务启动（当前未在运行）后新建会话触发。插件依赖 `@deepseek-ai/dsh-tools`（peerDep）解析正常（resolve 到 `runtime/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`，被 pnpm 提升到安装根）。
    - **排查"装了插件没反应"的顺序**：① 看 `runtime/dsh-home/profiles/web/package.json` 的 `dependencies` + `dsh.profile.bundles` 是否含该包；② **设 DSH_HOME** 后 `dsh --dump-config --profile web` 看插件层是否在；③ 看插件 `package.json` 有无 `dsh.client`——**无则无 UI，属宿主端工具/路由插件**，靠 agent 调用或 HTTP 路由验证；④ 服务必须在安装后**重启**（bundle 补丁在启动时合成）。
    - **教训**：验证任何 profile 相关命令（dump-config/插件管理等）都要先设 `DSH_HOME` 指向 `runtime/dsh-home`，否则拿到的是默认 home 的结果；第三方插件"没动静"先判断它是不是"无 UI 的工具插件"，再谈生效。
45. **【DSH 第三方插件排查】`@dsh-external/dsh-vision-toolkit`（v0.1.4）：装进树但运行时未就绪 → 只显示设置界面、工具不注册（2026-08-15）**：
    - **现象**：用户经插件管理器装上 dsh-vision-toolkit 后想确认是否生效。检查发现：插件树已合成（`dsh --dump-config` 设 DSH_HOME 后有 `# == @dsh-external/dsh-vision-toolkit` / `- id: vision-toolkit` 层）、双端声明齐全（`dsh.bundle.patch` + `dsh.client` 注入 client-runtime/ui-tool/ui-settings/locale）、16 个 peer 依赖全部可解析、`runtime/requirements.lock` 与 vendor 上游快照都在——**但实际不会真正生效**。
    - **根因（双硬门槛）**：① **运行时未就绪**：插件默认 `runtime.mode: managed`，首次启动必须找到一个 **Python 3.11+** 解释器，用 `uv`（或 venv+pip）自动建隔离环境并按 `runtime/requirements.lock`（Pillow/numpy/vtracer 等）装依赖。本机只有 **Python 3.10 / 3.8**（`py -0p` 确认），`resolveBootstrapPython` 探测 `python`(=3.10)、`py -3`(=3.10.11)、`python3`(不存在) 全部失败 → `manager.initialize()` 抛错 → `lib/index.js` 明确 log **"runtime not ready; the vision-tools skill, activation bootstrap, and Agent-scoped visual tools are NOT registered. Settings remain available for repair."** —— 即**只有设置界面可用，10 个视觉工具 + vision-tools skill + 激活引导全都不注册**。旁证：`DSH_HOME/cache/dsh-vision-toolkit/` 下只有 `artifact-access.key`，**没有 `python/` 运行时目录**（从未成功创建）。② **API 凭据未配置**：默认 provider `https://api.inferera.com/v1`、credential 引用 `VISION_API_KEY`、model `gemini-3.6-flash`，但 `.credentials.yaml` 里无此 key——即使运行时修好，工具调用也需先配 key。
    - **排查顺序（第三方"装了没完全生效"通用）**：① `package.json` 的 dependencies + bundles 是否含包 → ② **设 DSH_HOME** 后 dump-config 看插件层 → ③ 看插件 `package.json` 有无 `dsh.client`（双端才有 UI）→ ④ **看插件自身的"外部运行时要求"**（本插件：Python 3.11+ / API key / managed 环境）——这是最容易被忽略的一层 → ⑤ 服务重启后看 server.log 里插件自己打的 error（如 "runtime not ready"）。
    - **修复方向（绿色整合原则）**：把便携 Python 3.12+ 装进 `runtime/python`（或复用启动器已有的便携 Python，但它目前是 3.10），并在插件的 Web Settings（vision-toolkit 命名空间）里把 `runtime.python` 指向该 3.11+ 可执行文件、`provider.credential` 配好 key，然后重启服务；客户端验证 = WebUI 设置出现 vision-toolkit 区块 + server.log 出现 "dsh-vision-toolkit ... ready"。
    - **教训**：双端插件"树里有、UI 有、但能力不生效"时，先查插件自己的**运行时/凭据前提**（外部解释器版本、下载型依赖、API key），server.log 里插件用 `ctx.logger.error` 打印的降级提示是最直接的诊断入口。
46. **【绿色版自更新】分离进程的睡眠延迟别用 ping/timeout/choice，用 wscript + sleep_helper.vbs（2026-08-16）**：
    - **现象**：v1.0.3 自动更新下载没问题，手动退出启动器后，`update_apply.bat` 等待循环里**不断弹出 ping 命令窗口**（一闪一退），弹了几次后报 **"ping.exe application error，无法正常启动（0xc0000142）"**，覆盖安装始终没完成。
    - **根因（两层）**：① **窗口闪烁**——`launch_update_script()` 用 `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` 分离启动 bat，该进程**没有控制台**；cmd 在无控制台的进程里调用 `ping.exe` 这类**控制台子系统**程序时，Windows 会为它**新建一个控制台窗口**，每次等待（`ping -n`）都弹一个闪窗。② **0xc0000142 = STATUS_DLL_INIT_FAILED（DLL 初始化失败）**——用户机器的系统 `ping.exe` 本身损坏（常见于系统文件损坏/安全软件劫持），控制台窗口一弹出来它就报错，延迟/错误处理被打断 → 循环卡住、安装永远不完成。补充：`timeout`/`choice` 在 stdin 被重定向（DEVNULL）时也直接报错退出，根本睡不了。
    - **修复**：延迟统一改 `wscript.exe "%~dp0sleep_helper.vbs" <毫秒>`。`_write_update_bat()` 在 `runtime/update/` 同目录生成 `sleep_helper.vbs`（内容 `WScript.Sleep CLng(WScript.Arguments(0))`）。`wscript.exe` 是 **GUI 子系统**——调用时**不会新建控制台窗口**（不闪窗）、Windows 全自带（不依赖可能损坏的外部 exe）、`WScript.Sleep` 延迟精确到毫秒。替换后等待循环每轮静默睡 1000ms、解锁后睡 2500ms，全程无窗口。
    - **验证**：生成的新 `update_apply.bat` 全部 sleep 均为 `wscript.exe "%~dp0sleep_helper.vbs" ...`；在文件锁占用场景端到端跑通（能正确等到解锁 → 备份 → robocopy 覆盖 → 重启新版）。
    - **教训**：任何"分离进程 / 无控制台 / 后台静默"场景的 cmd 延迟，**首选 wscript + VBScript 的 `WScript.Sleep`**；`ping -n` 不仅闪窗，还依赖可能损坏的 ping.exe；`timeout`/`choice` 依赖交互/控制台，stdin 重定向就废。**本经验已同步至 `skills/dsh-deploy-maintain/`（SKILL.md 3.4）并重建 `Skill-dsh-deploy-maintain.zip`。**
47. **【绿色版自更新】Compress-Archive 传子路径会丢目录前缀，导致插件被覆盖到程序根目录（2026-08-16）**：
    - **现象**：v1.0.3 自动更新解压覆盖后，`plugins/dsh-archive-purge`、`plugins/dsh-file-browser`、`plugins/dsh-session-rewind`、`skills/dsh-deploy-maintain` 全被**覆盖到程序根目录**（`dsh-archive-purge/`、`dsh-file-browser/` 直接出现在 `BASE_DIR` 下），覆盖落点错误。
    - **根因**：发布侧 `Compress-Archive -Path launcher.py, ..., "plugins\dsh-archive-purge", "plugins\dsh-file-browser", ...` 传的是**子路径**。PowerShell 的 `Compress-Archive` 对子路径目录会**直接打在 zip 根**（不带 `plugins/` 前缀）→ zip 里是 `dsh-archive-purge/...` 而非 `plugins/dsh-archive-purge/...` → 解压后 `robocopy` 按 zip 结构把这些目录整体拷到程序根目录，造成错位覆盖。用户根目录甚至可能出现一堆不该有的文件夹。
    - **修复（双保险）**：① 发布侧打包命令改传**目录名** `"plugins"` / `"skills"`（README 已修正），zip 内保留前缀；② 更新侧 `launcher.py` 新增 `_normalize_update_structure(content_root)`：解压后把内容根下错位的已知插件/skill 目录归位到 `plugins/` / `skills/`（正确位置已存在则跳过），且 `update_apply.bat` 新增第 2.5 步清理程序根目录的错位残留（`if exist "%BASE_DIR%\dsh-archive-purge" rmdir /s /q ...`，只删这 4 个已知旧目录，不碰用户数据/config/runtime）。
    - **验证**：`runtime/tmp/test_normalize_update_structure.py` 3 用例全过——①旧版错位 zip 结构正确归位到 plugins/skills；②新版正确 zip 结构不动；③新旧混合时正确位置优先、根目录错位保留由 bat 清理。测试类名是 `Launcher`（不是 `DSHLauncher`）。
    - **教训**：用 `Compress-Archive` 打 zip 时，**想让目录带父级前缀，`-Path` 必须传目录名本身**；传子路径会丢前缀。发布前一定 `tar -tf` 核对 zip 根结构。**本经验已同步至 `skills/dsh-deploy-maintain/`（SKILL.md 3.4 + deployment-checklist）并重建 `Skill-dsh-deploy-maintain.zip`。**
48. **【DSH 插件管理】"包装上了但没生效"根因 = pnpm 非 0 退出码跳过官方 reconcile；新增启动器兜底自动写 bundles + 启用/停用开关（2026-08-16）**：
    - **现象**：用户通过启动器 GUI 安装 `@linxin666/dsh-web-ui-all`（全家桶聚合包）后重启服务，WebUI 里看不到任何新入口（SSH/任务看板/宠物等都不出现）。检查发现包已进 `node_modules` 与 `dependencies`，但 `profiles/web/package.json` 的 **`dsh.profile.bundles` 没有该包** → 它的 `cordis.patch.yml`（10 个插件行）从未被编排应用。
    - **根因（两层）**：① **pnpm 7+ 的 `ERR_PNPM_IGNORED_BUILDS`**：安装含原生模块/构建脚本的依赖（本插件依赖 ssh2/cpu-features/node-pty/cloudflared/protobufjs）时，pnpm 默认忽略构建脚本并**以退出码 1 结束**（警告而非失败，包其实已写入依赖）。② **`dsh plugin` 命令的 reconcile 只在 `exitCode === 0` 时执行**（`plugin-9h8shc4d.js` 的 `if (exitCode === 0) reconcilePlugins(before, dir)`）→ 退出码 1 时跳过 → `dsh.profile.bundles` 没被写入 → "包装上了但编排层没有"。实测复现：`dsh plugin --profile web add @linxin666/dsh-web-ui-all` 返回 exit=1、`package.json UNCHANGED`，输出正是 `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: ...`。
    - **修复（launcher.py 兜底，不依赖 dsh 内部行为）**：
      - 新增 `reconcile_bundles(profile, removed=None)`：扫描 `dependencies`，把声明 `dsh.bundle.patch` 且未停用的包自动写进 `dsh.profile.bundles`；从编排层清除本次移除/已停用/不再声明 bundle 的包。**内置 bundle（`@deepseek-ai/dsh-base` / `dsh-web-app`）不在 dependencies 里，永不触碰**（与官方 reconcile 一致，防止误删）。
      - `install_plugin` 容忍 pnpm 非 0：比较安装前后 `dependencies`，只要有新包写入就视为成功并 `reconcile_bundles`，不再抛"安装失败"。
      - `run_plugin_command` 每次命令后都兜底 `reconcile_bundles`（覆盖"官方只在 exit 0 时 reconcile、且不识别停用列表"两个缺口）。
      - `remove_plugin` 传 `removed=[包名]` 强制从 bundles 清除。
    - **新功能：插件管理窗口启用/停用开关**：左侧"已安装插件"列表新增**状态列**（启用/停用/—）+「启用选中」「停用选中」按钮；停用状态持久化在 `dsh.profile.disabled` 数组（launcher 维护，官方 reconcile 不识别 → 由 launcher 每次命令后重新应用）；`set_plugin_enabled()` / `get_plugin_state()` 实现读写；启停后需重启服务生效（GUI 有提示）。
    - **验证**：① `py_compile` 通过；② 隔离测试 6 断言全过（幂等 reconcile 不删内置 bundle / 停用从 bundles 移除且 disabled 记录 / 停用后 reconcile 不被加回 / 启用恢复 / 模拟移除清除 / 最终恢复）；③ 端到端模拟 GUI 安装本地 bundle 包：pnpm 触发 `ERR_PNPM_IGNORED_BUILDS`（exit 1）后**仍自动写入 bundles** ✓、移除后自动清除 ✓；④ `dsh --profile web --dump-config`（设 DSH_HOME）确认全家桶 10 个插件行全部合成进树；⑤ 重新 PyInstaller 打包 `DSH_Launcher.exe` 成功（新 exe 另存 `DSH_Launcher_new.exe` 供替换）。
    - **教训**：① 排查"装了插件没生效"先看 `dsh.profile.bundles` 是否含包（不是看 dependencies/node_modules）；② **任何调 pnpm 的插件命令，绝不能假设退出码 0 才成功**——`ERR_PNPM_IGNORED_BUILDS` 会让 pnpm 以 1 结束但安装实际成功，启动器必须自己兜底同步编排层；③ 停用状态必须由启动器自己持久化并在每次命令后重放，因为官方 reconcile 只认 `dsh.profile.bundles`，会无视 disabled 把停用的包加回。**本经验已同步至 `skills/dsh-deploy-maintain/`（SKILL.md 3.2 + plugin-dev-checklist）并重建 `Skill-dsh-deploy-maintain.zip`。**
49. **【DSH 插件·严重】纯客户端插件也必须带宿主端 `lib/index.js`（哪怕空 apply）→ 缺失则服务启动即退出（2026-08-16，dsh-message-actions 实测）**：
    - **现象**：`dsh-message-actions` 是纯客户端插件（只做 WebUI 插槽注入，无宿主路由），当时 `lib/` 下只放了 `client.js`。安装后**重启服务瞬间退出**，server.log 报 `dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry message-actions (dsh-message-actions): Cannot find module '...lib/index.js'`（`ERR_MODULE_NOT_FOUND`）——宿主 cordis loader 对 bundle 树里的**每个包都会 import 其 main/exports["."]**，纯客户端插件也不例外。
    - **修复**：`lib/index.js` 放官方纯 UI 插件同款 no-op：`function apply() {} export { apply };`（可再带 `const name`/`inject` 注释说明）。对照官方 `@deepseek-ai/dsh-client-ui-message-feedback` 的宿主端就是这么写的。
    - **教训**：**写任何 dsh 插件（含纯客户端）都必须保证 `package.json` 的 `exports["."]`（main）指向一个真实存在的模块文件**；缺了它插件树加载失败，不是"插件不生效"而是"整个服务起不来"。这也是后续 `dsh-turn-tokens`/合并后的 `dsh-usage-stats` 都带 `lib/index.js` 空 apply 的原因。
50. **【DSH 插件客户端】消息行扩展点与官方已覆盖能力盘点（2026-08-16）**：
    - **两个官方插槽**：① `conversation.chat.assistant-actions`——每条**已完成**助手消息的 IconActions 操作行（`owner={messageId}`，list 按 `order` 升序渲染，官方反馈 👍👎 用 `order:10`，第三方从 `order:20` 起）；② `conversation.chat.turnTail`——操作行**上方**的内容区（chain 链式，`select` 必填返回匹配值，组件拿 `matched` + session standard kit 的 `useSession`，`priority` 控制选举顺序，全拒则渲染空）。
    - **官方已原生提供、插件别重复做**：消息正文「复制」、每条回合尾「在新对话中分支」（fork 到该消息）、悬停「用时/首 token/速率」（`MessageIconActions`）；会话级 token 合计官方 StatsLine 已显示在输入框下方（`useProjection("tokenUsage")`）。
    - **fork 边界语义限制"重新生成/删除回合"**：官方 `session.fork` 的边界是「≥ atSeq 的**第一个 turn/end**」——只能整回合切，**无法**切到"历史 + 用户提问、无回答"（用户提问在上一 turn/end 之后、本回合 turn/end 之前，不存在介于两者之间的 turn/end 边界）。因此"重新生成"只能 fork 到上一回合结束再手动重发（或 fork 后取提问文本自动重发，但只支持纯文本且立即耗 token）；**原地删除回合 dsh 不支持**（内存缓存 + seq 断裂，见 dsh-session-rewind 设计结论）。本项目的替代能力已由 `dsh-session-rewind`（回退）+ 启动器「会话管理」（清理）覆盖。
    - **读快照拿消息数据**：`useSession((s) => s)` 的 `snapshot.nodes`（legacy 兼容字段，含 `AssistantMessageNode`：`kind:'assistant'`/`turn`/`usage`）与 `snapshot.chat.nodes.values()`（实时节点库，`data.finalNode`/`data.closing.finalNode`）双源；`finalNode.usage` 即事件的原始 `usage`（`outputTokens` 至少必有）。
51. **【验证】无头 Edge + CDP 实测 WebUI 插件（2026-08-16）**：浏览器侧问题（按钮不渲染/布局错）用无头 Edge 复现最靠谱：
    - **CDP 连接**：`msedge --headless=new --remote-debugging-port=934X --user-data-dir=<临时>` 后 `GET /json/list` 取 **`type === "page"`** 的 target（否则会连到扩展 background page）；用 node_modules 里的 `ws` 写脚本：`Runtime.enable`（抓 `Runtime.exceptionThrown`/`console.error`）+ `Page.addScriptToEvaluateOnNewDocument`（页面脚本前注入）+ `Page.navigate`。
    - **自动打开历史会话**：无头浏览器无当前会话（停在 hero），在 `addScriptToEvaluateOnNewDocument` 里预置 `localStorage.setItem("dsh.sessions.current", JSON.stringify({ sessionId: "<id>" }))`（客户端选择持久化键，`dsh-client-runtime` 里 `persist: { name: "dsh.sessions.current" }`），加载后自动打开该会话并可检查消息行。
    - **设置面板**：触发按钮 class `VOzbGW_trigger`（侧边栏底部齿轮，无文本/aria），面板是居中模态（`.VOzbGW_navCell` 导航 + 右区 `settings.section`）。
    - **读文本用 textContent 而非 innerText**：innerText 会把 flex 项当块级插入换行（"本次token：值"被拆成两行误判），`el.textContent` 才是真实拼接。
    - **清理**：无头 Edge 的 `--user-data-dir` 会留在 `runtime/tmp/dsh-cdp-*`，跑完要删；`taskkill /F /IM msedge.exe` 兜底清进程。
    - **教训**：服务端 bundle/路由都对、浏览器看不到 → 十有八九是**页面缓存**（强制刷新 Ctrl+Shift+R）或组件运行时问题；先用无头复现拿控制台异常，再对症下药。
52. **【局域网访问】dsh 官方拒绝 `--host 0.0.0.0`，必须补丁 startup.js；且 dsh 升级重装会还原补丁（2026-08-16）**：
    - **现象**：直接在启动器里给 dsh 传 `--host 0.0.0.0` 启动，进程立即报错退出（`error: --host 0.0.0.0 is intentionally not supported yet for safety...`）。这是**官方刻意为之**——dsh 担心把远程工具执行能力暴露到局域网，`dsh-web-app/lib/startup.js` 里 `if (options.host === "0.0.0.0") program.error(...)` 显式拒绝（虽然后端 schema 本身允许 0.0.0.0）。
    - **修复（幂等补丁）**：`patch_web_startup()` 把该条件替换为 `false /* dsh-launcher: 已放开 0.0.0.0 以支持局域网访问 */`（保留其余代码，最小改动；marker 已替换则直接返回 True）。**关键避坑：dsh 升级 = 重装 `runtime/dsh`，会覆盖 startup.js 把补丁还原** → 必须在 `install_dsh()` 末尾 + `start_server()` 启动前各调一次补丁兜底，否则局域网模式升级后静默失效（进程又报错退出）。
    - **信任围栏与特权方法**：绑定 0.0.0.0 时，`dsh-web-app` 的 `resolveLanTrust` 会把**全部非内网 IPv4 自动加入 trustedHosts**（浏览器信任围栏只拦"非回环且非信任"的来源），所以**整个局域网网段自动放行**，无需手动填受信主机；`trusted_hosts` 配置用于信任**非 IP 主机名**/代理场景。同时 `PRIVILEGED_METHODS`（settings/credentials/host.pickDirectory 等）**即使 LAN 部署也仅回环可调**——远程浏览器能聊天/用工具，但不能改设置与凭据（预期行为，安全保护，远程实测返回 403）。
    - **心跳脚本必须适配局域网**：原 `patch_frontend()` 注入的心跳脚本硬编码 `http://127.0.0.1:<port>`——局域网远程页面拿到的是远端 IP，心跳永远上不去（自动打开界面会误判"已打开"或无法去重）。改为 `"http://" + location.hostname + ":<port>..."`（页面自动用其所在主机名上报）；且心跳服务 `_ensure_ui_beacon_server()` 绑定地址必须随 `dsh_host` 变化——`0.0.0.0` 模式绑 `0.0.0.0`，否则远端浏览器也连不上心跳端口。
    - **本机模式回归**：`dsh_host` 默认 `127.0.0.1` 时行为与升级前完全一致（命令多传一个 `--host 127.0.0.1` 无害），心跳绑定 `127.0.0.1`。
    - **教训**：① 官方为安全刻意禁用的能力（0.0.0.0）要改成"补丁 + 两个调用点兜底"，并记住**任何改 `node_modules` 内官方文件的补丁都会在升级重装后被还原**；② 前端脚本里凡硬编码 `127.0.0.1` 的都要排查是否需要 `location.hostname` 适配；③ 后端小服务（心跳/其它监听端口）的绑定地址要跟随主服务 host 配置联动。**本经验已同步至 `skills/dsh-deploy-maintain/`（SKILL.md 3.x）并重建 `Skill-dsh-deploy-maintain.zip`。**
53. **【代码托管】Gitee 镜像仓库创建与历史全量推送（2026-08-17）**：
    - **需求**：在 `https://gitee.com/liujunheng` 下创建仓库，把本地所有提交（含历史）全部推上去，作为 GitHub 之外的国内镜像备份。
    - **Gitee API 建仓**：`POST https://gitee.com/api/v5/user/repos`（access_token = 用户 PAT，需 `repos` 权限），请求体 JSON 用**文件传参**（`curl --data-binary "@create_gitee_repo.json"`）避免命令行内嵌 JSON 的引号转义问题。关键参数：`name=DeepSeekHarnessGreen`、`private=false`、`auto_init=false`（不自动初始化，避免与本地历史冲突）。响应 `html_url=https://gitee.com/liujunheng/DeepSeekHarnessGreen`。
    - **推送（关键避坑）**：① 建仓后 `git remote add gitee https://<user>:<PAT>@gitee.com/<user>/<repo>.git` 一次性带 PAT 推送，**推送成功后立即 `git remote set-url` 去掉 URL 里的 PAT**，避免明文凭据常驻 `.git/config`；② 分别 `git push gitee --all`（分支）与 `git push gitee --tags`（标签），**历史提交随分支一起全量过去**（不是增量同步）；③ PowerShell 下 git 把进度写到 stderr，`2>&1` 会显示成 `git : remote: Powered by GITEE.COM` 的红色"错误"，**那是正常输出不是报错**（exit code 0，有 `* [new branch]` / `* [new tag]` 即成功）；④ 验证一致性用 `git ls-remote gitee` 对比 `HEAD`/`refs/heads/master`/`refs/tags/*` 的 SHA 与本地 `git rev-parse HEAD` 完全一致。
    - **结果**：Gitee 仓库 `DeepSeekHarnessGreen` 的 master 指向 `f61ce72`（与 GitHub 完全同步），标签 v1.0.0~v1.0.6 全部推送。
    - **教训**：① 建仓 API 的 `auto_init=false` 可避免远端首条空提交与本地历史打架；② 任何把令牌写进 remote URL 的操作，完成后都要清回干净 URL；③ PowerShell 里 git 的 stderr 输出不要误判为失败，以 exit code 和 `[new branch]`/`[new tag]` 为准。
54. **【开源合规】Apache 2.0 协议落地与绿色版再分发合规（2026-08-17）**：
    - **背景**：用户在 GitHub 上通过 "Create LICENSE" 创建了标准 Apache License 2.0 全文（`LICENSE`，201 行官方模板）。评估后发现两个合规缺口：① GitHub 模板未填写版权行（附录 `Copyright [yyyy] [name of copyright owner]` 是占位符）；② **绿色版 zip 打包清单（README 的 `Compress-Archive` 命令）没有包含 `LICENSE`**——Apache 2.0 §4 Redistribution 要求"再分发必须给接受者一份本协议副本"，缺 LICENSE 的 zip/exe 分发即违约。
    - **修复**：① `LICENSE` 顶部补版权行 `Copyright 2026 LiuJunheng`（官方模板允许在文件开头声明版权），附录占位符同步替换为实际版权行；② README.md / README_EN.md 的 zip 打包命令与"发货清单"都加上 `LICENSE`；③ README/README_EN 新增「开源协议 / Open Source License」章节：主项目（launcher.py + 绿色版外壳 + 内置插件 dsh-archive-purge/dsh-file-browser/dsh-usage-stats）以 Apache 2.0 发布、`dsh-session-rewind` 单独以 MIT 发布（随包保留其 LICENSE，见避坑记录）、运行时依赖（dsh/Node/便携 Python）为第三方各自许可、再分发须保留 LICENSE 副本与版权声明。
    - **验证**：重新打包 `DSH_Launcher_GreenPortable_Online_20260817_v1.0.6.zip`，用 `[System.IO.Compression.ZipFile]::OpenRead` 核对 zip 根含 `LICENSE`（plugins/dsh-session-rewind/LICENSE 也保留）。**旧资产 20260816_v1.0.6.zip 不含根 LICENSE，保持已发布原样不破坏；本合规 zip 为新增件**（未上传 Release，供下次发布或手动替换时使用）。
    - **教训**：① GitHub "Create LICENSE" 模板只有协议正文、**版权行要自己补**（README 的打包命令/发货清单/README_EN 三处都要同步）；② 只要走"绿色版 zip/exe"再分发，**打包清单必须含 LICENSE**，否则 Apache 2.0 §4 违约；③ 内嵌子组件（如 dsh-session-rewind）若用不同协议（MIT），要在主 LICENSE 之外随包保留其许可证文本并在 README 说明。

55. **【发布】绿色 zip 的"发货清单"漏 `DSH_Launcher.ico`，且 `skills\*.zip` 残留会被误打进去（2026-08-17）**：
    - **背景**：用户加装 git 后要求核对"exe 一键启动是否被漏传 / Release 包是否有缺有冗余"。实测 Release v1.0.6 资产 `DSH_Launcher_GreenPortable_Online_20260817_v1.0.6.zip`（9389386B，"Online" 精简版）：**含 `DSH_Launcher.exe`（exe 一键启动没漏）**、不含 `runtime/`（正确，属在线版语义）；但发现两处问题：① **缺 `DSH_Launcher.ico`**——README 发货清单与 `Compress-Archive` 命令都漏了这个文件；脚本版 start.bat 跑起来窗口/托盘会退化为系统默认图标（exe 版图标已内嵌不受影响）；② **误入 `skills/python-tkinter-desktop-dev.zip`**——传统 `"skills"` 整目录打包会把 `skills\*.zip` 残留一并塞进绿色 zip。
    - **修复**：① README.md / README_EN.md 的"发货清单"与 `Compress-Archive` 命令都补上 `DSH_Launcher.ico`；② 把"移出一个 zip"的提示改成 `Move-Item skills\*.zip %TEMP%\` 全量清走；③ 打包后必用 `tar -tf` 核对：zip 根要有 `plugins/`、`skills/`、`DSH_Launcher.exe`、`DSH_Launcher.ico`、`LICENSE`，且**不应有** `skills\*.zip`、`runtime/`。
    - **配套（同一会话）**：内置 Python 用 `py -3` 跑时会选到系统 Python **3.13**（`py -0p` 的 `*` 默认项），触发 `tarfile.extractall` 的 "Python 3.14 will..." DeprecationWarning。`prepare_python()` 的 `extractall` 已改为**按版本判断**：`sys.version_info >= (3,12)` 才传 `filter="data"`，3.10（内置便携）省略——既消除 3.14 警告，又不破坏 3.10 兼容。内置便携 Python 实测为 3.10.20（`runtime/python/python/python.exe`）。
    - **待发布动作**：本地重打合规 zip（补 .ico、剔除 skills 残留）并按需替换/追加 Release 资产；重打 exe 时用内置 Python 3.10（`build_exe.bat` 会优先内置，当前根目录无 exe，需先 `build_exe.bat`）。

56. **【局域网 403】WebUI 报 `transport failure for /api/host.pickDirectory: HTTP 403`（2026-08-17）**：
    - **背景/根因**：dsh 官方把 `client-connection` 插件的 `/api` 通道（`@deepseek-ai/dsh-client-connection/lib/index.js`）默认信任围栏 **pin 死在 loopback**：`apply()` 里 `trustedHosts = config?.trustedHosts ?? []`，且特权方法（`PRIVILEGED_METHODS`，含 `host.pickDirectory`、`host.openPath`、`settings.*`、`credentials.*`、`llm.discoverModels` 等）**硬编码传空列表** `isTrustedApiRequest(request, [])`。实测（curl 模拟 Host）：`127.0.0.1` 访问全部 200；用**本机局域网 IP / 局域网 Host** 访问时**所有 /api（含普通 API）都 403**。而 `dsh-web-app` 的 `resolveLanTrust()` 明明算了 `lanAddresses`（0.0.0.0 绑定时的本机局域网 IPv4）并通过 `WEB_RUNTIME_SERVICE`（`"webRuntime"`）提供——client-connection 却没用它，两套信任语义不一致。
    - **修复（幂等补丁 `patch_lan_api_trust()`）**：补丁 `dsh-client-connection/lib/index.js` 的 `apply()`：① `trustedHosts` 改为 `let`，当 `config.trustedHosts` 为空且 `ctx.get("webRuntime").lanAddresses` 非空时，自动并入本机局域网 IPv4（与 resolveLanTrust 语义一致）；② 特权方法的 `isTrustedApiRequest(request, [])` 改为 `isTrustedApiRequest(request, trustedHosts)`。CSRF 防护（`sec-fetch-site: cross-site` 拒绝 / Origin 必须同 host）**保留**。安全边界：只信任本机网卡实际地址（`lanAddresses`），伪造局域网 IP 依然 403。已在 `install_dsh()` 与 `start_server()` 中自动重打（dsh 升级重装后恢复原样）。
    - **验证（0.0.0.0 实测）**：loopback → 200；本机局域网 IP（192.168.32.88）→ **200**（原 403）；伪造 192.168.1.100 → 403（安全）；跨站 Origin evil.example.com → 403（CSRF 保留）。loopback-only 模式无行为变化（lanAddresses 为空，trustedHosts 仍 []）。**注：此结论仅对"Origin 带端口"的客户端成立；真实 Chrome 150+ 会发无端口 Origin 导致本机模式也 403，见避坑 #58（补丁已升级 v3 修复）。**
    - **坑**：① dsh 官方"局域网模式"文档语义与实际 `client-connection` 实现不一致——页面能开但 /api 全 403，报错很误导（"transport failure"）；② 补丁匹配串要跟随 dsh 版本，结构不匹配时**宁可跳过不硬改**（防止破坏运行），并在日志提示；③ 补丁失败要**醒目提示**——`install_dsh()`/`start_server()` 里对 `patch_lan_api_trust()` 返回值做判断，失败输出 `[警告]`（此前仅一行普通日志，用户"装了才发现局域网用不了"），见 2026-08-17 补记。

57. **【发布】Release zip 与 GitHub 仓库统一 + exe 上传 GitHub（2026-08-17）**：
    - **需求**：用户要求"release 包跟 github 上传内容统一，包含 exe 也上传 github，移除 skills/python-tkinter-desktop-dev.zip；DEV_NOTES.md / .gitignore 不进 release"。
    - **实施**：① `.gitignore` 移除 `DSH_Launcher.exe` 忽略项 → exe 作为仓库文件一并提交 GitHub（与 Release 同源）；② README/README_EN 的"发货清单"与 `Compress-Archive` 命令改为**与仓库内容统一**：`launcher.py, start.bat, stop.bat, build_exe.bat, DSH_Launcher.exe, DSH_Launcher.ico, config.json, README.md, README_EN.md, LICENSE, "plugins", "skills"`（剔除 `DEV_NOTES.md`、`.gitignore`；`.ico` 保留）；③ `skills\*.zip` 残留打包前 `Move-Item skills\*.zip %TEMP%\` 清走（实测 release 曾误入 `python-tkinter-desktop-dev.zip`）。
    - **教训**：二进制 exe 进 git 仓库虽非常规（会撑大仓库），但用户明确要求"仓库与 Release 一致、exe 可一键下载"，且单文件 9MB 可接受；`.gitignore` 里 `DSH_Launcher_*.zip` 仍保留（zip 只进 Release 不进仓库）。

58. **【本机模式 403 复发】Chrome 150+ 同源请求发送"无端口 Origin"，官方 `new URL(origin).host` 精确比较判 403（2026-08-17，避坑 #56 补记）**：
    - **现象**：局域网 403 修复（#56）后，用户"本机模式 + 手动点启动服务"仍报 `transport failure for /api/host.pickDirectory: HTTP 403`；且**用 curl 模拟（Origin 带端口）死活复现不出**（一直 200）。
    - **定位（关键）**：把 #56 补丁升级为 v2，在 client-connection 全部 403 出口（fetchHandler/route/websocket/register/interceptor）加诊断日志（记录 url/method/ua/origin/host/sec-fetch-site/referer/trustedHosts），server.log 立刻现形：
      ```
      [client-connection:403] route url=/api/host.describe method=POST
        ua=Mozilla/5.0 ... Chrome/150.0.0.0  host=127.0.0.1:3080
        origin=http://127.0.0.1  sec-fetch-site=same-origin
        referer=http://127.0.0.1:3080/  trustedHosts=[]
      ```
      **真实 Chrome 150 对 `http://127.0.0.1:3080` 页面的同源请求，Origin 竟然不带端口（`http://127.0.0.1`）**。官方校验 `new URL(origin).host === hostUrl.host` → `"127.0.0.1" !== "127.0.0.1:3080"` → false → 全部 /api 403（不只是 pickDirectory，页面加载的 host.describe 等都 403）。这就是"本机模式也 403"、且"curl 复现不出"（curl 手动带端口 Origin）的原因。
    - **修复（补丁升级 v3）**：`isTrustedApiRequest` 的 Origin 校验改为**只比较 hostname（忽略端口）**：`new URL(origin).hostname === hostUrl.hostname`。安全性论证：端口不是 CSRF / DNS-rebinding 边界（跨站攻击是不同 hostname 的页面发请求；rebinding 是 Host header hostname 与服务地址不一致），忽略端口不削弱防护；第一道"Host 必须 loopback 或受信任"与 `sec-fetch-site: cross-site` 拒绝都保留。补丁函数 `patch_lan_api_trust()` 升级为"完整 v3 幂等检查（hostname 比较 + 各出口日志都存在才 True），否则先把 v1/v2/v3 已知片段还原为官方原样再打 v3"的收敛逻辑，dsh 升级重装后自动重打。
    - **验证**：本机模式重启后，`host.describe` / `session.list` / `llm.discoverModels` 全部恢复 200（此前 Chrome 下全 403）；跨站伪造 Origin 仍 403（CSRF 保留）；`lan-ip=000` 确认服务确为本机绑定。**附带发现**：`host.pickDirectory` 放行后 curl 会**超时挂起**——那是 native 目录选择器（`dsh-host-directory-picker-native` spawn 的 worker.cjs 阻塞在 Win32 `Show()`）在**等待用户在原生对话框里选目录**，真实浏览器点"选择工作区"会弹窗、选完正常返回；无人交互的自动化请求超时属预期。
    - **教训**：① 服务端对 Origin/Host 的校验**不要用"带端口精确相等"**——浏览器 Origin 序列化行为会变（Chrome 150 对 loopback 丢端口），用 hostname 比较最稳；② 排查"xxx 明明该放行却 403"，**第一件事给被拒出口加请求头日志（必须含 UA 和 Origin）**，否则 curl/脚本模拟与真实浏览器的 header 差异会让你陷入"复现不出"的死循环；③ 补丁迭代（v1→v2→v3）要设计成"还原全部已知片段→按官方锚点重打"的收敛函数，并做"完整版本"幂等检查，否则老补丁文件会把新补丁的 replace 锚点破坏。
    - **待办**：重打 `DSH_Launcher.exe`（内置 v3 补丁 + 403 诊断日志），用户确认后替换/发布。（2026-08-17 已完成：`build_exe.bat` 实测正常，根目录 `DSH_Launcher.exe` 已重打为 v3 补丁 + 新高峰价格版，12:34:53，9184901 字节。）

59. **【bat 闪退排查】`build_exe.bat` 双击"闪退"实为正常，误判来自 Start-Process 重定向与 cmd 交互冲突（2026-08-17）**：
    - **现象**：用户反馈"bat 打包脚本貌似有问题，打开就闪退"。
    - **排查步骤**：① 字节级检查根目录 3 个 bat（start/stop/build_exe）——全部 **ASCII、无 BOM、CRLF 行尾**（用户规则要求 bat 全 ASCII 防 cmd 编码问题），排除编码闪退；② 逐行审阅 `build_exe.bat` 逻辑——`%~dp0` 定位、Python 探测、PyInstaller 本地安装、`--onefile --windowed --noupx` 构建、copy 到根目录、`pause`，逻辑无误；③ 发现第 40-42 行注释被写成乱码 `?????`（非 ASCII），虽不破坏运行但影响可读性，改为纯 ASCII 英文；④ **用 Python `subprocess` 调 `cmd /c build_exe.bat` 抓完整输出**：退出码 0、增量构建 1.3s、`[INFO]/[OK] Build finished` 输出齐全、`pause` 正常驻留——**bat 本身不闪退**。
    - **误判根因**：PowerShell `Start-Process cmd -RedirectStandardOutput -RedirectStandardError` 重定向的是管道，而 cmd 脚本里的 `pause` 等待键盘输入，两者交互下输出被吞、窗口看起来瞬间消失——**"闪退"是抓取方式的假象，不是脚本问题**。正确抓 bat 完整行为用 Python `subprocess.run(["cmd", "/c", bat], capture_output=True, text=True)` 或 `CreateProcess` 加参数，别用 Start-Process 重定向。
    - **坑**：① 判断 bat "闪退"前先分清"窗口本身关闭"与"逻辑失败退出"——带 `pause` 的 bat 若真逻辑失败也会暂停显示错误，不会闪退；② bat 内注释/回显字符串必须保持 ASCII（中文注释在非 UTF-8 代码页下会变乱码，虽不致命但难看），要写中文说明就放脚本外的 README/md；③ PyInstaller 增量构建很快（复用 build/ 缓存），复打 exe 是低成本的，改 launcher.py 后随手重打即可。

60. **【插件】侧边栏媒体预览踩坑：`<img>`/`<iframe>` 带不了自定义防御头，媒体路由 GET 需 fetch→blob→objectURL（2026-08-17，dsh-sidebar-lite）**：
    - **现象/根因**：给插件每个路由都加自定义头（如 `X-DSH-Sidebar-Lite: 1`）防跨站后，图片/PDF 预览如果直接用 `<img src="...">` 或 `<iframe src="...">`，浏览器加载子资源时**根本不带自定义头** → 媒体路由被 403 拒绝，图片全挂。
    - **解法**：媒体路由对"是否带防御头"同样校验，但**预览一律端内 `fetch(url, { headers: { 防御头: "1" } })` 取回 `blob`，再 `URL.createObjectURL` 交给 `<img>`/`<iframe>`**——fetch 能带自定义头，blob URL 同源且不用二次鉴权。记得在组件卸载/换文件时 `URL.revokeObjectURL` 释放，避免 blob 泄漏。
    - **另一个配套坑**：宿主端注册 `"prefix"` 路由后，若只在 handler 里接了 POST 方法，GET 会一路 405——**插件同时暴露 POST 业务路由 + GET 媒体路由时，handler 里必须按 `req.method` + `pathname` 分支**（本项目 `file` 路由就是 `req.method === "GET" && pathname === 前缀 + "/file"` 才分流到字节流）。写路由注解（注释顶部说好有哪些方法/路径）也避免"注释说做了、代码没做"（参考需求 #40 宿主端描述）。
    - **坑**：仅凭 `require("react")` 不一定拿到 `createRoot`——DHS 客户端注入若要用 React 根，优先 `require("react-dom/client")`，失败再兜底全局 `ReactDOM.createRoot`；挂载方式抄 better-sidebar `document.body` portal，别赌官方内部布局插槽名。

61. **【插件】轻量 CMD 终端：`node-pty` 是原生依赖、绿色版带不动，改 `child_process.spawn(cmd.exe)` + SSE 流（2026-08-17，dsh-sidebar-lite）**：
    - **缘由**：better-sidebar 原版终端走 `node-pty/xterm`，「xterm.js 键盘布局 + 光标 + 回显」体验好，但 `node-pty` 要编译原生模块（Windows 需 VS 工具链），**违反本绿色版"零原生依赖、可整目录拷走"的定位**，故不引入。
    - **方案**：`child_process.spawn("cmd.exe", [], { cwd })` 起一把 cmd，stdout+stderr 合并推送，前端回车写一行到 stdin。**cmd 没有真实 TTY**：光标/ANSI 序列会以原始字节回流 → 前端用 `<pre>` + `white-space: pre-wrap` 原样展示，不解析 ANSI（可接受，命令结果可读）；`dir`/`cd` 完整输出、中文代码页 GBK 由 Node 按 stdout 默认编码转 utf8 在浏览器端显示（个别中文可能有乱码，无碍命令执行）。
    - **键控与生命周期**：`TERMINALS` Map 以 `${sessionId}:${tab}` 为键复用进程；SSE 连接的 `req.on('close')` **只删监听器、不杀进程**，刷新/切页断连后重新连一次自动 `replay` 历史 transcript 恢复现场；「停止」按钮/`terminal.kill` 才 `proc.kill()` 并清 Map。插件卸载兜底清理全部已开终端。
    - **坑**：`spawn("cmd.exe")` 若不传 `{cwd}` 会用 Node 进程 cwd（可能不是用户预期目录），务必传会话 cwd；Windows 下别用 `shell:true` 双启动避免嵌套 exit 校验；前端 SSE 解析要按空行 `\n\n` 分隔事件、只取 `data: ` 行并 `JSON.parse`，才拿得到宿主 `push` 的结构化事件。
    - **遗留**：非 TTY 下的 ANSI 转义不回显美化、不支持 `Ctrl+C` 中断前台命令（`taskkill` 才能杀），如需更完整终端体验再评估是否引 `node-pty`（被迫上原生依赖时要在 README 标注绿色版例外）。

62. **【插件】无激活会话时，侧边栏资源管理器卡死在「扫描目录…」不显示目录（2026-08-17，dsh-sidebar-lite）**：
    - **现象**：新开页面/未新建会话（`sessionId` 为空）时，右边侧边栏资源管理区一直显示「📁 工作目录 扫描目录…」，目录树永不渲染；浏览器 console 无 React 报错。后端路由 `session.cwd` / `fs.tree` 实测均正常，问题在客户端。
    - **根因**：`SidebarShell` 的会话溯源 effect 里写了 `if (!sessionId) return undefined;`——**没有会话就完全不请求 `session.cwd`**，于是 `workspaceRoot`/`cwd` 一直是 `null`；`ExplorerView` 的 `currentPath` 用 `workspaceRoot || cwd || ""` 初始化成空串，主 effect 又 `if (currentPath === "") return;` 直接短路不调 `fs.tree`，于是永久停在 `rootEntries===null` 的 loading 态（渲染「扫描目录…」），就这么白白卡死。
    - **修法**：无会话时也兜底解析一次工作区根。把 effect 改为：`sessionId` 非空走原逻辑（解析会话 cwd + workspaceRoot）；`sessionId` 为空时用 `fallbackResolved` ref 保证只兜底一次，调 `session.cwd({sessionId:""})` 拿 `workspaceRoot` 设入 `workspaceRoot` 与 `cwd`（宿主端 `resolveWorkspaceRoot` 不依赖 sessionId，空会话也能返回工作区根）。这样资源管理器始终有可浏览的根目录，`scope.cwd` 也非空，`fs.tree/file/terminal` 都有落点。
    - **诊断手法（可复用）**：用 `curl -s -H "X-DSH-Sidebar-Lite: 1" -H "Content-Type: application/json" -X POST http://127.0.0.1:3080/__dsh/sidebar-lite/session.cwd -d "{}"` 直接打运行中的宿主端，发现 `sessionId":""` 也能返回 `workspaceRoot`；再开浏览器 DevTools 看 console（无 React 报错）+ 亲眼看 UI 文字「扫描目录…」是**前端状态短路**而非后端 500。疑似前端问题时先 trace 状态依赖链，别只查后端。
    - **部署坑**：客户端 bundle `client.js` 被运行中的 DSH web 服务**持有文件句柄**，改完源码 `Copy-Item` 到 `node_modules` 会报 `The process cannot access the file ... because it is being used by another process`——**必须重启 DSH 服务**才释放句柄并重载 bundle；只 `node --check` 过语法无用，不重启永远跑旧代码（本次正是改完也卡「扫描目录」，重启后生效）。

63. **【插件】侧边栏资源管理器默认路径"总是 dsh"的坑：`process.cwd()` 兜底落在 dsh 安装目录（2026-08-17，dsh-sidebar-lite）**：
    - **现象**：资源管理器默认根目录**总是显示 `dsh`**（路径框 `...\runtime\dsh`），用户期望的是**工作目录的根目录**（用户选择的工作区，如 `D:\DeepSeekHarnessLauncher`）。
    - **根因**：dsh 服务进程由启动器以 `subprocess.Popen(..., cwd=DSH_DIR)` 拉起（见 launcher.py `start_server`），**进程 cwd 就是 `runtime\dsh`**（目录名恰为 "dsh"）。宿主插件 `sessionCwdOf()` 的兜底链是 `会话 header.cwd → 客户端 cwd → process.cwd()`；当 `ctx.get("sessions").get(sessionId)` 拿不到（服务未就绪/会话对象无 header）且客户端 `summaryCwd` 也为空时，就**落到 `process.cwd()` = `runtime\dsh`**，于是资源管理器默认根固定显示 "dsh"——明明会话 header.cwd 是 `D:\DeepSeekHarnessLauncher`（用 zstd 解压 `session.jsonl.zstd` 第一行 header 可实测确认）。
    - **修法（双管齐下）**：① 宿主端新增 `defaultRootOf(ctx)` 同步兜底函数：优先返回 `sandboxPolicy.workspaceRoot`（工作区根），拿不到才 `process.cwd()`；`sessionCwdOf` 改为接受可选第 4 参 `fallbackRoot`，兜底链变成 `header.cwd → 客户端 cwd → fallbackRoot(工作区根) → sandboxPolicy.workspaceRoot → process.cwd()`；`session.cwd` 路由先 `await resolveWorkspaceRoot(ctx)` 拿到工作区根再当 fallback 传给 `sessionCwdOf`。② 客户端 `ExplorerView` 初始根与首次同步 effect 的优先级改为 **`workspaceRoot || cwd`（工作区根优先，会话 cwd 兜底）**——资源管理器默认展示"工作目录的根目录"（工作区根），而不是会话子目录或 runtime\dsh。
    - **诊断手法（可复用）**：别猜"用户选的工作区对不对"，先确认兜底值来源。用 `node --check` 过语法只是基础；本项目用便携 Node 解压 `runtime/dsh-home/sessions/<工作区编码>/<会话ID>/session.jsonl.zstd`（Node 22 内置 `zlib.zstdDecompressSync` 按 `28 B5 2F FD` magic 切帧）读首行 header 看 `cwd`，再对照 `runtime/dsh-home/storages/workspace.json` 的工作区 `path`——两处都该是工作区根；如果宿主端返回的 `cwd` 不是它俩之一，就是 `process.cwd()` 兜底被命中（启动器 `cwd=DSH_DIR` 所致）。
    - **教训**：**进程 cwd ≠ 用户工作目录**，尤其 dsh 服务进程 cwd 是安装目录 `runtime\dsh`。插件任何"默认路径"的兜底都不该直接用 `process.cwd()`，应优先工作区根（`sandboxPolicy.workspaceRoot`，经 `fs.resolve/processPath` 转可展示绝对路径）；客户端侧"工作区根优先、会话 cwd 兜底"才是"工作目录的根目录"语义。

64. **【插件】侧边栏任务面板永远"暂无后台任务" + 会话定位失效：官方 list store 字段是 `current` 不是 `sessionId`（2026-08-17，dsh-sidebar-lite）**：
    - **现象**：① 任务面板**无论当前会话有没有在跑后台任务都空**，永远显示「暂无后台任务…」；② 资源管理器其实也一直拿不到真实会话 cwd（默认根一直走"无会话兜底"，恰好显示成工作区根所以看着正常）。
    - **根因**：`SidebarShell` 里 `const sessionId = snapshot.sessionId`，但官方 `dsh-client-runtime` 的会话列表 store（`ctx.sessions.list`）snapshot 结构是 `{ ids, byId, current, phase, jobsBySession, currentAddress }`——**当前激活会话 id 的字段叫 `current`，根本没有 `sessionId` 字段**（见 client-runtime `projectList()` 的 `this.list.set({...})`）。于是 `sessionId` 恒为 `null`：① `jobs = snapshot.jobsBySession[null]` = undefined → 任务面板永远空；② 会话溯源 effect 误判"无会话"，走 `fallbackResolved` 兜底分支，`postMethod("session.cwd", { sessionId: "" })` 拿不到 header.cwd，只拿到工作区根。
    - **修法**：`const sessionId = (snapshot && (snapshot.current || snapshot.sessionId)) || null;`——官方字段 `current` 优先，保留 `sessionId` 作旧字段兼容兜底。修好后：任务面板 `jobsBySession[sessionId]` 正常取数（与官方 `dsh-client-ui-jobs` 的 `useSessions(state => state.jobsBySession[sessionId])` 同源同键）；会话溯源改走有会话分支，`session.cwd` 传真实 sessionId 拿到 header.cwd。
    - **附带功能**：`ExplorerView` 头部在刷新按钮旁新增「⌂ 回到工作目录」按钮（目标 = `workspaceRoot || cwd`，即资源管理器默认根）——用户用路径框/上下级浏览改过目录后，可一键回到工作区根，不用手动重输路径。
    - **诊断手法（可复用）**：插件读官方 store 前先核对 snapshot 键名——在浏览器 DevTools 里 `window.__DSH_BOOT__` 相关 store 或临时 `console.log(Object.keys(snapshot))` 打印键集合，别凭记忆猜字段名；官方 client-runtime 的 list store 统一用 `current` 表示"当前激活会话"，`selection` store 才用 `sessionId`，别混。
    - **教训**：**"数据源明明存在却取不到" 优先怀疑键名/字段名写错**（`sessionId` vs `current`），其次是取值时 key 为 null/undefined 导致的静默空结果；修这种字段名 bug 往往同时治愈多个看似无关的症状（任务面板空 + 会话定位不准同源）。

## 七、后续建议
- ✅ 已实现"连 Python 都不装"的完全免安装体验：内置便携 Python（python-build-standalone 含 tkinter，进 runtime/python）+ PyInstaller 打包 `DSH_Launcher.exe`（内嵌解释器）。详见避坑 #18/#19/#20 与 README 第七章。
- 可增加"开机自启""系统托盘""最小化到托盘"等桌面应用体验
- Windows 实机验证：建议在目标 Windows 机器上跑一遍 start.bat 首启全流程（沙箱仅能验证 Linux 逻辑）
- 待办：auto 镜像的"国内优先、失败回退"逻辑应扩展到 npm install 阶段（见避坑 #15）
