# DeepSeek Harness 绿色整合版启动器 · 开发纪要（精简版）

> 精简自早期完整的 DEV_NOTES.md（原过程性记录已并入本文档），只保留以后开发会继续用到的坑点、约定、当前状态、核心设定与需求脉络。
> 文档分流：README = 使用者文档；本文档 = 开发者 / 发布者文档（打包命令、目录约定、发布流程等细节在此记录）。

## 一、项目定位与核心需求

**一句话：把 dsh 封装成「双击即用、绿色便携、可持续更新」的整合版。** 以下需求脉络决定所有取舍，改动前先对齐这里。

- **双击即用**：不做"敲命令安装 + 手动开浏览器"；自动完成「便携 Node 准备 → dsh 安装 → 服务启动 → 自动打开界面」。形态 = Python GUI（tkinter）启动器 + .bat 一键入口。
- **绿色便携**：所有运行时数据（Node、dsh、会话）放进程序目录（`DSH_HOME=runtime/dsh-home`），整目录拷走、免写系统。零第三方 Python 依赖（仅标准库）。
- **网络**：镜像自动检测（国内优先、失败回退官方）；更新检查仍优先查 npm dist-tags（`npm view @deepseek-ai/dsh dist-tags`），不畅再退 GitHub/Gitee。
- **自更新**：GUI「检查更新」→ 查 npm 最新版 → 弹窗让用户选择更新/不更新 → 更新前自动把旧版备份到统一目录 `runtime/backup/dsh-<版本>`（不覆盖；备份由用户手动管理，「数据维护」可一键清理）。
- **可视化插件管理**：GUI「插件管理」→ 新窗口，可查已装插件、搜索（npm 注册表 + GitHub 官方 dsh-plugin 话题）、安装 / 移除；支持选**本地插件文件夹**（含 package.json）安装，CLI `--install-plugin` 同支持本地目录。
- **数据维护**：dsh 官方无「永久删除会话」，网页"归档"只是隐藏（日志 + 注册表全保留）。启动器「数据维护」可视化删会话 / 归档 + CLI `--purge-archived / --purge-session <ID>`；配套内置插件 `dsh-archive-purge` 在 WebUI「设置 → 清理归档」实现同样能力（列表勾选选清理 / 一键清空）。
- **工作区不写死**：过去为解"程序根工作区与 runtime/tmp 冲突"写死了 workspace 子目录；现改为启动器自动检测临时目录与工作区是否冲突并解析出安全的默认工作区。
- **经验沉淀**：全套部署 / 维护 / 插件开发实测经验沉淀为 TRAE Skill `dsh-deploy-maintain`（主文档 SKILL.md + checklists/ + references/，内置避坑浓缩版），本项目每处改动须同步回 SKILL.md 与 checklists。

## 二、当前开发状态

- **版本**：`GREEN_VERSION = 1.0.19`（launcher.py 内，唯一版本来源；`GREEN_VERSION_DATE` 打包当天自动回写）。GitHub + Gitee 双平台已发到 v1.0.19（2026-08-27：GitHub Release id=377753678 / Gitee Release id=916774，zip 17,745,739 B）。
- **形态**：python(tkinter) 启动器 + 便携 Node/Python + 绿色 zip 分发 + 内置桌面壳（pywebview / WebView2）+ 双通道自更新。
- **内置插件 8 款**：`dsh-file-browser`(文件浏览，右键文件可插**官方 @ 引用**/路径/内容) / `dsh-archive-purge`(清理归档) / `dsh-session-rewind`(会话回退) / `dsh-session-import`(会话导入) / `dsh-usage-stats`(用量统计) / `dsh-sidebar-lite`(侧边栏，资源管理器文件右键同样可插**官方 @ 引用**) / `dsh-media-background`(观星背景影画) / `dsh-ollama`(自动识别本机 Ollama 服务并接入 DSH，见下条)。
- **Ollama 多模型接入（2026-08-27，dsh-ollama 插件）**：用户要求"自动识别 ollama 接口、选择 ollama 模型和相关设置"。正解是**复用官方多 Provider 底座 `dsh-llm-pi-ai`，不自己写适配器**——插件启动后周期探测 Ollama 原生接口 `/api/tags`（默认 `http://localhost:11434`），拿到模型名列表后把 `providers.ollama`（`api=openai-completions` + `baseURL={baseUrl}/v1` + 模型列表 + 占位 Authorization 头 + **compat 兼容开关**）写进 `llm-pi-ai` 设置命名空间（`ctx.settings.mutate`），pi-ai 监听到设置变更即自动注册：模型目录（configurable providers）+ 对话路由 + 模型发现；WebUI Models 页随即出现 Ollama 条目、模型选择器可直接选 Ollama 模型对话，模型有增删自动同步。已实测端到端：qwen3:4b 出现在模型选择器、对话经"Deep diving…"思考后返回正文回复、无报错。插件纯宿主端、零原生依赖；配置项（baseUrl/displayName/探测间隔等）经 `cordis.patch.yml` 的 config 覆盖；模型参数（contextWindow/maxTokens/baseURL）用户可在 Models 页直接改。另提供 WebUI「设置 → Ollama 设置」面板（2026-08-27）在线修改插件配置（服务地址/显示名称/默认容量/探测间隔/超时/授权头/开关），持久化到 `DSH_HOME/ollama-config.json`、保存即按新配置重新探测接入，无需重启服务（路由实现见坑 34）。**compat 补充（2026-08-27 同日）：**Ollama 的 OpenAI 兼容层不认 `developer` 角色 / `max_completion_tokens` / 工具 `strict` 字段，缺 compat 时工具 schema 到不了模型、模型从不调用 DSH 工具；插件固定写入 `compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens", supportsStrictMode: false }`（详见坑 31）。
- **官方 @+文件 引用衔接（2026-08-26）**：官方 `dsh-client-ui-reference` 的 `@` 触发以会话 header.cwd 为根、用相对路径 mention；插件可直接向会话作用域派发官方事件 `slash/input-insert-reference`（`{reference:{source:"reference",ref,label,appearance:"file",clipboardText},span}`，span 须带 `draftRev` CAS）——与官方 @ 菜单 onPick 完全同一条管线，由官方输入机 mint chip（草稿显示 `@文件名`，发送时经 source codec 序列化为相对路径）。`dsh-file-browser` / `dsh-sidebar-lite` 已用它实现右键「以官方 @ 引用插入」：纯客户端（经 `sessions.provideInfo` 读输入机状态 `hooks.input`/`inputActions` + `sessions.scope` 取作用域派发），无需改宿主端 / 重启服务。
- **内置插件全自动同步（2026-08-27）**：`update_bundled_plugins()` 把 `plugins/` 源码镜像进已装副本（逐文件 MD5 对比、只写变化文件、清理源码已删的陈旧文件）。三个自动入口，无单独更新按钮：①**打开插件管理窗口**即后台自动同步一次（结果写状态栏）；②**「一键安装内置插件」**附带自动更新（未装补装 + 已装增量更新）；③**绿色版更新后**自动同步一次——更新确认时写标记 `runtime/pending_bundled_plugin_check`（更新程序不覆盖 runtime/），重启后 GUI 启动 / `--start` 都会消费标记执行同步并写日志。解决坑 16 的"源码更新了、已装副本不同步"（实测：用量统计余额功能 8-25 进源码，8-20 装的老副本一直 404）。发版后其他电脑更新绿色版即可自动同步，无需手动操作。
- **仓库**：GitHub `LiuJunheng/DeepSeekHarnessGreen` + Gitee `liujunheng/DeepSeekHarnessGreen`（国内镜像，代码/tag 自动同步）。协议统一 Apache-2.0（绿色版外壳 + 全部内置插件）。
- **发布凭据**：GitHub 用 `GH_TOKEN` 环境变量（可自动建 Release/传资产）；Gitee 需用户提供 PAT（保存在 project memory，勿写死进代码/文档）。

## 三、约定 / 规范（本项目用户规则）

- `.bat` 一律纯 ASCII + CRLF；`.ps1` 里不写中文常量（见编码坑）。
- 变量名英文全称不缩写；代码注释用中文；不用简写语法。C# 不用 `var`、Unity 用代码自动找组件。
- Python 最少依赖、相对路径装环境、不动系统 python、不用 C 盘默认路径；Windows 提供 bat 一键运行 + GUI。
- 文案包装优先用三国历史典故。
- 发版纪律：
  - 版本日期 = 制作当天真实日期（`build_release_zip.py` 自动回写 launcher.py 的 `GREEN_VERSION_DATE`）。
  - 自 v1.0.11 起 Release 只上传**一个**绿色 zip（`plugins/`、`skills/` 已在 zip 内），不再单独打 skill/插件 zip。
  - 上传 / 发布 / 推送前必须先经用户确认；`git push --force` 等改写操作尤其要先展示。
  - 中文 commit / Release 正文一律规避 PowerShell ANSI（见编码坑）。
  - 签名类细节：Gitee 同名附件上传不覆盖 → 先按 attachment id 删旧；建 Release 必带 `target_commitish=master`（否则 400）。

## 四、核心架构（launcher.py）— 只记关键设定

- **零第三方依赖**（仅 python 标准库）；运行时数据全落程序目录：`DSH_HOME=runtime/dsh-home`，npm 缓存 / pnpm store / TEMP 全部重定向到 `runtime/` 下（`build_env()`）。
- **dsh 启动**：`node <dsh>/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3080 --no-open`。**stdin 必须 `PIPE` 保持打开**，否则 dsh 读到 EOF 静默退出（"Failed to fetch"）。
- **关键补丁点**（全部幂等；`install_dsh()` 末尾 + `start_server()` 前各打一次，因为 **dsh 升级重装会还原 node_modules 内文件**）：
  - `patch_web_startup()`：放开绑定 `0.0.0.0`（局域网）。
  - `patch_lan_api_trust()`：信任围栏改 **hostname** 比较（Chrome 150+ 同源请求 Origin 无端口会全 /api 403）。
  - `patch_frontend()`：注入心跳脚本 + `crypto.randomUUID` polyfill。
- **WebUI 单页面去重**：后台心跳服务 `127.0.0.1:3081`，窗口 180s；心跳 URL 用 `location.hostname` 适配局域网；**手动打开(force=True)不拦截，自动(force=False)才排重**。
- **防火墙**：`dsh_host=0.0.0.0` 时用 netsh 放行 3080 入站 TCP（须管理员，失败仅记日志）。
- **桌面壳**：`desktop-shell.py`（pywebview，WinForms/WebView2），`webview.start(on_ready, icon=...)`；桌面版固定单实例 → 用 **PID 文件 + OpenProcess/GetExitCodeProcess** 判存活排重（别用页面心跳）；服务未启动先显示固定提示页，端口就绪后自动切真实界面。入口只从启动器 GUI「桌面窗口」按钮进（`desktop-shell.bat` 独立双击入口 2026-08-27 已移除——功能与 GUI 完全一致，GUI 直启 pythonw 无黑窗反而更好；launcher 里 bat 兜底路径同步删掉，直接回退浏览器）。
- **命令行**：`--start`(守护) / `--stop` / `--purge-archived` / `--purge-session <ID>` / `--restore-session <ID>` / `--install-plugin` / `--remove-plugin`。

## 五、高频坑点（按主题聚合，均实证）

### 编码坑（最常见，必看）
1. **PowerShell 调 REST 发中文变 `?`**：`Invoke-RestMethod -Body $str` 按本地 ANSI(GBK) 序列化。必须 `[System.Text.Encoding]::UTF8.GetBytes($json)` + `-ContentType "application/json; charset=utf-8"`。
2. **`.ps1` 里写中文常量会被按 ANSI 读**（PS 5.1 对无 BOM UTF-8 脚本按系统 ANSI 解码）→ 脚本**保持纯 ASCII**，中文 Release 正文拆到独立 UTF-8 文件用 `ReadAllText(路径, [Text.Encoding]::UTF8)` 读入；校验中文也走 python，别在 PS 里 `-match "中文"`。
3. **git commit 带中文经 PowerShell 变 `?`**：凡是带中文 commit，一律用 UTF-8 消息文件 `git commit -F <文件>`，不要 `-m "中文"`。
4. `Compress-Archive -Path "plugins\dsh-xxx"` 会丢 `plugins/` 前缀 → 打 zip 传递**目录名** `"plugins"`/`"skills"`；最稳用 Python `zipfile`（`runtime/tmp/build_release_zip.py`）打包并 `tar -tf` 复核根结构。
5. PowerShell 里 `"$uploadUrl?name=..."` 的 `?` 会被当变量名吞掉 → 用 `${uploadUrl}` 花括号界定。

### dsh 集成坑
6. dsh bin 入口是 `node_modules/@deepseek-ai/dsh/lib/bin.js`，别依赖 `node_modules/.bin/dsh.cmd`（会混系统 node）。
7. 不设 `DSH_HOME` 会写用户主目录；Windows 上定位 npm-cli 发行根用 `os.path.dirname(node_exe)`（Linux/Mac 多退一层）。
8. auto 镜像的 `npm install` 不会自动挂 `--registry`（`is_auto` 分支没加）→ 国内很慢甚至卡住；待办：把"国内优先、失败回退"扩到 npm install 阶段。
9. 官方刻意拒绝 `--host 0.0.0.0`（安全）→ 必须 `patch_web_startup()`；升级重装会还原，补丁幂等重打。
10. **Chrome 150+ 无端口 Origin 403**：官方 `new URL(origin).host === hostUrl.host` 精确比较，loopback 请求 Origin 不带端口 → 全 /api 403。补丁改用 `hostname` 比较。排查"明明该放行却 403"→ 第一个动作是给被拒出口加含 UA/Origin 的日志。
11. `crypto.randomUUID` 在 http + 非回环 IP 下用不了 → 注入基于 `getRandomValues` 的 polyfill（`patch_frontend()`）。
12. 任何对 `node_modules` 内官方文件的补丁都会被 **dsh 升级重装还原** → 一律在 install_dsh + start_server 双点幂等重打。

### 插件开发坑（7 款插件反复验证）
13. `package.json` 双入口：`dsh.bundle.patch`(→ cordis.patch.yml) + `dsh.client` 才双端加载；`exports` 必须含 `"./package.json"`；`files` 必须含 `cordis.patch.yml`；**纯客户端插件也必须有宿主端 `lib/index.js`（哪怕空 `export{}`），否则整个服务起不来**。
14. 宿主注册路由必须 `ctx.effect(() => ctx.webServer.register({...}), label)`（把返回值当清理函数）；写成"先 register 再 effect(disposer)"会注册即注销 → 非 GET 全 405。
15. 防御路由带自定义头防 CSRF；但 GET 媒体路由 `req.method !== "GET/HEAD"` 会 405 → 预览走 `fetch(url,{headers})→blob→objectURL`（`<img>`/`<iframe>` 带不了自定义头）。
16. **pnpm 对 `file:` 本地路径是拷贝非软链**：改 `plugins/` 源码后**必须同步运行副本** `runtime/dsh-home/profiles/web/node_modules/<name>/`（或重装 `--install-plugin`）。服务端文件（index.js/cordis.patch.yml）改后要**重启服务**、client.js 改后强刷；dsh 运行时 index.js/cordis.patch.yml 被文件锁挡住需先停服务。**这是最易"改了没生效还当已完成"的坑，做完要 `Get-FileHash` 比对 SAME。** 自 2026-08-27 起同步已自动化（`update_bundled_plugins()` 逐文件哈希、只写变化文件、跳过内容一致的文件避免锁冲突）：打开插件管理窗口 / 点「一键安装内置插件」/ 绿色版更新后首启 都会自动同步。
17. **pnpm 非 0 退出码 ≠ 失败**：`ERR_PNPM_IGNORED_BUILDS` 会让 pnpm 以 1 结束但安装成功，而官方 reconcile 只在 exit=0 时写 `dsh.profile.bundles`。launcher 已用 `reconcile_bundles()` 兜底自动写编排层 + 启停开关（`dsh.profile.disabled` 由 launcher 自己维护，官方不识别）。
18. 官方客户端 store 的**当前会话字段是 `snapshot.current`（不是 sessionId）**；"数据源在却取不到"先核对键名（`current`/`byId`/`jobsBySession`）。
19. **工作区根权威来源 = `workspaceRegistry`**（读 `storages/workspace.json`），不是 `sandboxPolicy.workspaceRoot`——后者未显式配置时默认值= `process.cwd()`= `runtime\dsh`（启动器以 `Popen(cwd=DSH_DIR)` 拉起 dsh），当兜底根必错。
20. 主题自适应：插件颜色改用 `var(--dsw-alias-*)`（CSS 变量自动随深/浅主题，**别加 JS 主题监听**）；锚定在固定浅色背景框里的内容整组固定（浅框 + 深字，不随主题），只有框外页面级文字随主题。
21. pywebview：**`webview.start()` 之前绝不调 `load_url()`**（打断原生窗口创建，静默回退浏览器）；换图标用 `webview.start(icon=)`（WinForms 支持，翻源码确认）；窗口就绪后的导航/初始化放 `webview.start(func)` 回调里；打开去重手动/自动分开走。

### PyInstaller / 打包坑
22. `--onefile` 不等于带全运行库：**显式 `--add-binary` 打包 VC 运行库三件套** `vcruntime140.dll` / `vcruntime140_1.dll` / `vcruntime140_threads.dll`，否则目标机报 "Failed to load Python DLL"。
23. onefile 里程序根目录用 `sys.executable` 所在目录（`frozen` 判定），别用 `__file__`（指向 `_MEIPASS` 临时解压目录）。
24. 更新器自替换：运行中的 exe 不能覆盖自己 → 先把自己 `copy2` 到 `runtime/tmp/<name>_worker.exe`，从副本带**原参数**再 Popen、原进程退出；用 `normcase` 比较绝对路径避免无限自启。
25. 分离进程/无控制台的 cmd 延迟用 `wscript.exe "%~dp0sleep_helper.vbs" <ms>`（`WScript.Sleep`），**别用 ping/timeout/choice**：ping 闪窗且依赖可能损坏的 ping.exe，timeout/choice 在 stdin 重定向时直接失效。

### 发布 / 平台坑
26. **Gitee `/releases` 按创建时间升序返回 + 默认每页 20**：取"最新"必须 `?per_page=100` 后再按 `created_at` 降序（否则首选到最旧的 v1.0.9 → 误报"已是最新"，v1.0.16 实测 bug）。凡依赖第三方列表接口取"最新"都要防顺序假设 + 分页截断。
27. Gitee 整仓 zip 接口是 `repository/archive/<branch>.zip` 且被 JS 挑战墙（纯 urllib 拿不到）→ 走 git 智能 HTTP 协议（`info/refs` + `git-upload-pack`，需处理 zlib 边界、REF/OFS delta、`bytes.fromhex`）。**手动上传的附件** `/releases/download/<tag>/<file>` 可直连下载；自动生成的 tag 源码包是挑战页 → `_gitee_release_latest` 选 zip 必须同时要求 URL 含 `/releases/download/`，且 Gitee asset 无 `size`（用 `size:0` 跳过校验）。
28. 网络（本机常态）：常只有 `api.github.com` 可达，`github.com:443` 直连超时。git push 失败 → GitHub API 建 ref/提交/传资产（`uploads.github.com`）；可开全局代理 `-c http.proxy=http://127.0.0.1:10809 -c http.lowSpeedLimit=0 -c http.lowSpeedTime=999`。Gitee push 认 `https://oauth2:<token>@gitee.com`（`用户名:token` 会 403）。
29. Gitee 删附件：用 **curl.exe**（PowerShell `Invoke-RestMethod -Method Delete` 会 404），且要**逐条删**（短时间批量循环会命中限流返回假 404），删后 `attach_files?per_page=100` 复查。
30. **v1.0.18 发布（2026-08-27）**：release zip 只发一个（v1.0.11 起的惯例）；GitHub 用 `runtime/tmp/github_release_v1018.py`（GH_TOKEN 建 Release + 传资产，自动处理 422 复用），Gitee 用 `runtime/tmp/gitee_release_v1018.py`（GITEE_TOKEN 会话临时注入不落盘，先删同名旧附件再传）。发布说明正文按改动主题分节、文案沿用三国化包装；Gitee 正文用纯文本编号列表（不带 Markdown 标题）。构建 zip 用便携 Python `runtime\python\python\python.exe`（系统 python 是 2.7.6 会误报语法错）。v1.0.18 打包清单已移除 `desktop-shell.bat`（入口收敛后源码已删，勿再打进去）。
31. **给 DSH 加新模型/新 Provider，正解是写 pi-ai 的 `providers` 配置，绝不自己调 `ctx.llm.registerAdapter` / `registerModelDiscovery`**（2026-08-27，dsh-ollama 实测）：`registerAdapter` 对 provider 路由是**排他**的，`registerModelDiscovery` 每个 namespace **只能有一个**，直接注册会与 pi-ai 冲突；正确姿势是经 `ctx.settings.mutate("llm-pi-ai", ops)` 把 `providers.<id>`（`displayName`/`api`/`baseURL`/`models`/`headers`/`compat`）写进 pi-ai 设置节，pi-ai 监听变更自动注册模型目录 + 对话路由 + 模型发现。Ollama 就是复用 `api: "openai-completions"`（OpenAI 兼容端点 `/v1`）接进来。**OpenAI 兼容服务（Ollama / LM Studio / vLLM 等）必须配 `compat`**（2026-08-27 实测）：这类端点不认 OpenAI 官方方言（`developer` 角色 / `max_completion_tokens` / 工具 `strict` 字段），不配 compat 时 pi-ai 默认按 OpenAI 官方协议发送，工具 schema 到不了模型 → **模型接入后从不调用工具**。Ollama 的正解是 `compat: { supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: "max_tokens", supportsStrictMode: false }`（`supportsReasoningEffort` 必须为 `true`，否则无法发 `reasoning_effort` 关思考，见坑 37）。
32. **pi-ai 的 `openai-completions` 协议强制要求请求带 apiKey 或 Authorization 头**（2026-08-27 实测）：没写 `apiKeyEnv` 也没写 headers 时，请求直接报 `No API key for provider`（Ollama 这种免鉴权本地服务也过不了）。**别写 `apiKeyEnv`**（Ollama 无真实 Key，会报 `MISSING_CREDENTIAL`）；正解是给 provider 配置补一个**占位 `headers: { Authorization: "Bearer ollama-local" }`**，Ollama 不校验该头、pi-ai 原样透传即可。此坑对任何免鉴权的 OpenAI 兼容网关（LM Studio / vLLM 本地等）同样适用。
33. **Ollama 的 thinking 模型在 WebUI 里会长时间停在「Deep diving…」**（2026-08-27 实测）：qwen3:4b 等带 `thinking` 能力（`/api/tags` 的 `capabilities` 含 `thinking`）的模型，对话先流式输出 `delta.reasoning`（pi-ai 映射成 `reasoning-delta`，UI 显示"Deep diving…"），**思考结束后才出正文**；本地 4B 模型冷启动 + 思考要十几秒到几十秒，别误判为卡死/失败。curl 直测 OpenAI 兼容端点注意：**PowerShell 里 `-d '...'` 的单引号 JSON 会被吃掉变 `invalid character 'm'`**，正确做法是 JSON 写临时文件用 `--data-binary "@file"`；`api/ps` 空 = 模型未加载（冷启动）。
40. **Git Data API 断点续推：远端 master 会变成"本地没有的改写 SHA"，`rev-list <remote>..master` 直接报 `Invalid revision range`**（2026-08-27，v1.0.19 双平台发布实测）：api.github.com 可达、github.com:443 被墙时用 Git Data API 逐提交重放（blob→tree→commit→update ref），但**远端重建的提交 SHA 与本地不同**；若上次推送只推到一半（如只重放了 `fc8552f`，远端 master=改写版 `13f46190`），本地 `git rev-parse origin/master` 仍是旧值 `fee50ef`（API 推送不更新本地 tracking ref），而远端 SHA 不在本地对象库 → `rev-list 13f46190..master` 报 `Invalid revision range`。**正解（`runtime/tmp/git_push_github_api.py` 已实现）**：①先 GET 远端 master 提交，取其 `parents[0]`（= 本地已知的 `fee50ef`）作基准，`rev-list <parent>..master` 列候选；②用 `find_base_local` 按 **tree 相等**（`get_commit(remote)["tree"]["sha"]` vs `rev-parse c^{tree}`）找出远端 master 对应的本地提交，建立 `本地SHA→远端SHA` 映射；③只续推其后的提交，`create_commit` 的 parents 用**远端父 SHA**、每次 commit 后回读远端 tree 作下一提交的 base_tree。注意：这些改写提交**只存在于远端**，本地 update-ref 到该 SHA 会报 `nonexistent object`（别尝试），本地 `git status` 显示 ahead 属预期。Gitee 侧另一教训：**Gitee 的 git data 只支持写（POST blob/tree/commit、PATCH ref），GET `/git/commits/{sha}` 返回 405**；且 gitee.com 直连可达 → Gitee 无需 API 续推，直接 `git push --force gitee master` 把完整本地历史同步过去即可（改写链无 tag 引用、是残缺中间态，force 覆盖安全；先 `git ls-remote gitee refs/heads/master` 核对远端状态再动手）。

### 插件开发坑（续）
34. **webServer.register 无 `method` 字段：同一 path 只能注册一次**（2026-08-27，dsh-ollama 设置路由 404 实测）：`@deepseek-ai/dsh-host-webserver` 的 `WebRoute` 只有 `kind` / `path` / `handler` 三个字段（`lib/types/index.d.ts` 确认），**没有 `method`**——想区分 GET/POST 必须在**同一个 handler 里按 `req.method` 分流**；对同一 path 注册两条（一次 GET、一次 POST）会抛 "Duplicate (kind, path)" 错误，异常把整个插件 fiber 回滚、**所有**路由全部失效 → 客户端 fetch 全 404。排查"路由明明注册了却 404"：①先核对是否同 path 注册了两条；②再确认 `__DSH_BOOT__` 清单里有该插件的 client 条目、`/plugins/<id>/client.js` 能 200 取到（排除客户端根本没加载）；③WebUI 设置面板这种 `settings.section` 注册会生成设置侧边栏**导航行**（按 `order` 排序，order 大排最后），不是独立顶栏标签，验证时要滚动侧边栏找。
35. **Ollama 接入 DSH 后"能对话但从不调用工具 + 动不动报 token 上限/上下文截断"，根因是上下文容量配置错位**（2026-08-27，双故障同源实测）：**症状一（不调工具）**＝DSH 的 system prompt + 全套工具 schema 动辄上万 token，Ollama 默认 `num_ctx` 只有 4096（`api/ps` 常见 16384），工具定义被截断 → 模型收不到工具、永不调用；**症状二（token 上限）**＝settings.yaml / 插件 `ollama-config.json` 里 `contextWindow` 与 `maxTokens` 被设成**相同值**（如都是 16000），pi-ai 认为"输出上限 = 总上下文"，输入空间为零。**两个教训**：①`maxTokens` 必须**远小于** `contextWindow`（如 32768/8192），二者相等必截断；②提升 Ollama 上下文**别用 `OLLAMA_CONTEXT_LENGTH` 环境变量**——实测桌面版 `ollama app.exe` 启动的 serve **不继承**该变量（无论 User 级 setx 还是当前 shell `$env:` 后 Start-Process 都不行，`api/ps` 仍是旧值）；`/v1/chat/completions` 端点**也不转发** `options.num_ctx` / 顶层 `num_ctx`（实测均无效，原生 `/api/chat` 才认）。**正解：用 Modelfile 给模型固化 num_ctx 并重建**——`FROM qwen3:4b` + `PARAMETER num_ctx 32768`，`ollama create qwen3:4b-32k -f Modelfile`，任何方式启动都生效（`api/ps` 确认 32768），DSH 里把模型指向 `-32k` 变体即可。另注意：dsh-ollama 插件每次探测会**用 `ollama-config.json` 的默认容量重建 models 列表**（面板保存的值优先），所以面板里 `defaultContextWindow/defaultMaxTokens` 也要同步改，否则 settings.yaml 里手改的容量会被插件覆盖回去。
36. **Ollama 别写 `apiKeyEnv`，补占位 Authorization 头即可**（2026-08-27 实测，坑 32 的进阶）：给免鉴权服务配 `apiKeyEnv: OLLAMA_API_KEY` 而该环境变量未设时，`dsh-llm-pi-ai` 直接抛 `MISSING_CREDENTIAL` 让**所有**请求失败；反之 `apiKeyEnv` 指向已存在的变量又会让 pi-ai 真去解析、行为不可控。**正解：只写 `headers: { Authorization: "Bearer ollama-local" }`**，满足 pi-ai "有 key 或有头才放行"的协议门禁，Ollama 不校验该头。插件 `applyOllamaProfile` 会对已有配置里误加的 `apiKeyEnv` 主动 remove 自愈。
37. **Ollama thinking 模型默认思考会把 `max_tokens` 烧光、还没轮到工具调用就被截断；关思考只认 `reasoning_effort`，不认 `think: false`**（2026-08-27 实测，`/v1` 端点 + Ollama 0.32.14）：qwen3 / gemma 等带 `thinking` 能力的模型默认思考，DSH 默认思考档位是 off，本应不思考——但若 pi-ai 发的是 `think: false`，新版 Ollama `/v1` 端点**静默丢弃**（原生 `/api/chat` 才认），结果继续思考、输出被截断、工具调用被裁掉。**正解**：①`compat.supportsReasoningEffort: true`（否则 pi-ai 根本不发 `reasoning_effort`）；②每个模型声明 `reasoningEfforts` 映射 `{ off:"none", minimal:"none", low:"low", medium:"medium", high:"high" }`；③DSH 思考档位 off 时 pi-ai 发送 `reasoning_effort="none"` → Ollama 关思考。实测（`runtime/tmp/pi_ai_ollama_repro.js` 直连 pi-ai）：思考片段 0、模型正常调用 `web_search`（stopReason=toolUse、usage.reasoning=0）。
38. **dsh-ollama 面板/配置里 `defaultContextWindow/defaultMaxTokens` 是"回退值"，改了不生效——生效的是 `target*`**（2026-08-27，审查"DSH 的 AI 优化"时发现的坑）：`buildProviderProfile` 用 `target* || default* || 内置默认` 取容量，`ensureContextVariants` 也只认 `targetContextWindow`。**用户（或 DSH 的 AI）在面板改"默认上下文窗口/最大输出"＝改了个永不生效的字段**（target 一设就把它盖掉），表现为"优化了插件设置但依旧不行"。教训：面板应暴露**生效字段**。已修复：面板两个数字框改绑 `targetContextWindow`/`targetMaxTokens`（宿主端 `sanitizeOverrides` 本就校验这两个字段），并把它俩标注为"目标/生效值"；`ollama-config.json` 里 `default*` 已归一化回 32768/8192 与 target 一致，避免显示值与实际不符。**部署提醒（坑 16 再次应验）**：DSH 实际执行的是 `runtime/dsh-home/profiles/web/node_modules/dsh-ollama` 的运行副本，不是 `plugins/dsh-ollama` 源码——"改了源码不生效"先核对运行副本时间戳/大小（本次源码 34610B vs 旧运行副本 32636B，缺 compat/reasoning 修复），再重启服务；面板客户端改动同理要重新同步 client.js + 重启 WebUI 才加载新表单。
39. **dsh-ollama 周期同步 models 列表必须用 `mergeModelParams` 保留用户手改参数，否则 Models 页手改的 contextWindow/maxTokens/name 会被下一轮探测（默认 60s）覆盖回默认值**（2026-08-27，审查"是否还有优化"时修复）：`applyOllamaProfile` 的"已存在 provider"分支里，`modelsEquivalent` 判定不相等时若直接写 `profile.models`（插件默认容量），用户手改的模型参数就丢了——又是"改了不生效"（坑 38 同类）。**正解：与 force 分支一致，写 `mergeModelParams(currentProfile.models, profile.models)`**——已有模型保留手改的 contextWindow/maxTokens/name，新增模型套默认容量，reasoningEfforts 始终以新列表（插件）为准（负责给旧配置补齐该字段）。教训：任何"周期自动写入"都要先想清楚会不会覆盖用户手改的**生效字段**。本次已改源码 + 同步运行副本 + 重启服务（运行副本 34610B→35131B）。

## 六、维护提醒

- **跨机 / 整包覆盖会吞本地未提交改动**（实测 1.0.10 覆盖把已修好的代码覆盖掉）→ 发布前先 `git diff` / `git log` 核对，或先把改动 commit。
- 改内置插件源码后必须同步运行副本（见坑 16）——验证"已生效"要在运行端目验，不能只看源码。同步动作已自动化：打开插件管理窗口即自动同步，或点「一键安装内置插件」；绿色版更新后首启也会自动同步一次。

## 七、待办 / 后续建议

- auto 镜像"国内优先、失败回退"扩到 npm install 阶段（坑 8）。
- README_EN 随中文 README 每次发布一次性翻译对齐。
- 桌面壳真机冒烟：start.bat 首启全流程、默认桌面窗 + 鲸鱼图标 + 无 cmd 闪窗 + 未启动提示页、局域网防火墙放行。
- 观星背景影画：mkv/avi/hevc 等浏览器不原生支持的编码需转 mp4/webm；不进三级以上深层大目录（扫描深度限 6）；待机轮播 / 时段 / 遮挡门帘等高级特性未做。
- dsh-ollama：插件自身配置（baseUrl / displayName / 探测间隔等）支持两途径：`cordis.patch.yml` 覆盖 + WebUI「设置 → Ollama 设置」面板在线修改（2026-08-27 已完成，见第二节）。无剩余待办。