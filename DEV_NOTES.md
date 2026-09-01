# DeepSeek Harness 绿色整合版启动器 · 开发纪要（维护向）

> 只记录对日后维护 / 更新 / 发布有复用价值的内容：避坑经验、约定规则、项目设计要求、当前状态与待办。不存档开发过程与时间线叙述。
> 文档分流：README = 使用者文档；本文档 = 开发者 / 发布者文档（打包命令、目录约定、发布流程、坑点、规范）。
> 经验沉淀：全套部署 / 维护 / 插件开发实测经验同步进 TRAE Skill `dsh-deploy-maintain`（SKILL.md + checklists/ + references/），本项目每处改动须同步回该 skill。

## 一、项目定位与设计要求（改动前先对齐）

**一句话：把官方 dsh 封装成「双击即用、绿色便携、可持续更新」的整合版。**

* **双击即用**：不做"敲命令安装 + 手动开浏览器"；自动完成「便携 Node 准备 → dsh 安装 → 服务启动 → 自动打开界面」。形态 = Python(tkinter) GUI 启动器 + .bat 一键入口。

* **绿色便携**：所有运行时数据（Node / dsh / 会话 / 缓存 / TEMP）落本目录（`DSH_HOME=runtime/dsh-home`；npm 缓存、pnpm store、TEMP 重定向 `runtime/` 下），整目录拷走、免写系统、不自装 Python/Node。**零第三方 Python 依赖（仅标准库）**。

* **网络**：镜像自动检测（国内优先、失败回退官方）；更新检查优先 npm dist-tags，不畅再退 GitHub/Gitee。

* **自更新**：两套**完全独立**通道——官方核心（`runtime/dsh/`，GUI「检查更新」）+ 绿色版外围（程序根目录，GUI「检查绿色版更新」）；更新前自动备份，失败给出手动地址。

* **桌面壳**：默认独立桌面窗口（pywebview / WinForms / WebView2，标题「DeepSeek Harness 桌面版」），可一键切回网页窗口；桌面版固定单实例。

* **内置插件（8 款，纯插件不改官方文件）+ 可视化插件管理**：查已装 / 搜索（npm 注册表 + GitHub 官方 dsh-plugin 话题）/ 安装 / 移除 / 本地插件目录安装 / 加载推荐。

* **数据维护**：官方"归档"只是隐藏（日志 + 注册表全保留）；提供可视化删会话 / 归档。

* **默认工作区不写死**：自动检测与 `runtime/tmp` 的冲突（`os.path.commonpath` 判冲突）并解析安全默认值；`config.json` 的 `default_workspace` 可覆盖（冲突则警告回退）。

## 二、当前状态（版本 / 发布 / 仓库）

* **版本唯一来源 = launcher.py** **`GREEN_VERSION`**；`GREEN_VERSION_DATE` 由 `build_release_zip.py` 打包当天自动回写（禁止预写未来日期）。zip 名与发布均以此为准。当前已发布 **v1.0.22**。

* **形态**：tkinter 启动器 + 便携 Node/Python + 绿色 zip 分发 + 内置桌面壳 + 双通道自更新。

* **仓库**：GitHub `LiuJunheng/DeepSeekHarnessGreen` + Gitee `liujunheng/DeepSeekHarnessGreen`。协议统一 Apache-2.0（外壳 + 全部内置插件）。

* **发布源平台 = Gitee**（当前）：代码/tag 只需 `git push gitee master --tags`，GitHub 自动同步 Gitee 的代码与 tag；**但 Release 资产不会自动同步，双平台各自单独上传绿色 zip**。源平台方向历史上多次反转，**每次发版前先确认当次源平台**。

* **Release 只传一个绿色 zip**（`plugins/`、`skills/` 已在 zip 内），不再单打 skill/插件 zip；打包排除 DEV\_NOTES.md 与 .gitignore，保证 zip 内容与仓库一致。

* **绿色版自更新升级为独立更新程序** **`DSH_Update.exe`**（内嵌 python，`build_exe.bat` 同时构建；更新时自我复制到 `runtime/tmp/<name>_worker.exe` 从副本覆盖自身）。

* **凭据**：GitHub Release 用 `GH_TOKEN` 环境变量（可自动建 Release/传资产）；Gitee 需用户 PAT（存 project memory，勿写死进代码/文档）。GitHub 上传前须确认 `GH_TOKEN` / gh CLI 就位。

* **官方 dsh 更新检测用双数据源合并候选**：`dsh_github_releases()`（分页拉全部 tag，`_dsh_tag_to_version()` 兼容 `dsh-v`/`v`/裸版本号）+ `dsh_npm_versions()`（npm 全量版本，用于判断某 tag 是否可安装）→ 合并（可安装优先、从新到旧）。因源码 tag 不一定在 npm（如 0.1.2-alpha.1 只发 GitHub）→ 详见坑 13。

## 三、约定 / 规范（本项目规则）

* `.bat` 一律纯 ASCII + CRLF；`.ps1` 里不写中文常量（PS 5.1 对无 BOM UTF-8 按系统 ANSI 解码），脚本保持纯 ASCII。

* 变量名英文全称不缩写；代码注释用中文；不用简写语法。C# 不用 `var`；Unity 用代码自动找组件赋值。

* Python 最少依赖、相对路径装环境、不动系统 python、不用 C 盘默认路径；Windows 提供 bat 一键运行 + GUI。

* 文案包装优先用三国历史典故（本站发布页 `pages/` 除外，站点文案已明确不用三国）。

* **发版纪律**：

  * 版本日期 = 制作当天真实日期（`build_release_zip.py` 自动回写 `GREEN_VERSION_DATE`）。

  * 上传 / 发布 / 推送前必须先经用户确认；`git push --force` 等改写操作尤其要先展示。

  * 中文 commit / Release 正文一律规避 PowerShell ANSI（见编码坑，用 UTF-8 消息文件）。

  * Gitee 同名附件上传不覆盖 → 先按 attachment id 删旧；建 Release 必带 `target_commitish=master`（否则 400）。

* **每次改动后同步更新项目 md**（README.md / DEV\_NOTES.md，及涉及插件的 plugins/\*/README.md）；通用类经验同步回 `dsh-deploy-maintain` skill。

## 四、核心架构（launcher.py）关键设定

* **零第三方依赖**（仅标准库）；`build_env()` 把 npm 缓存 / pnpm store / TEMP 全部重定向 `runtime/` 下。

* **dsh 启动**：`node <dsh>/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3080 --no-open`。**stdin 必须** **`PIPE`** **保持打开**，否则 dsh 读到 EOF 静默退出（"Failed to fetch"）。

* **关键补丁（全部幂等；install\_dsh 末尾 + start\_server 前各打一次，因 dsh 升级重装会还原 node\_modules 内文件）**：

  * `patch_web_startup()`：放开绑定 `0.0.0.0`（局域网）。

  * `patch_lan_api_trust()`：信任围栏改 hostname 比较（Chrome 150+ 无端口 Origin 全 /api 403）。

  * `patch_frontend()`：注入心跳脚本 + `crypto.randomUUID` polyfill。

* **WebUI 单页面去重**：后台心跳 `127.0.0.1:3081`，窗口 180s；心跳 URL 用 `location.hostname` 适配局域网；**手动打开（force=True）不拦截，自动（force=False）排重**。

* **新版 dsh web 认证（0.1.2-alpha.2+）**：首次访问需打开带一次性 `?token=<launchToken>` 的认证地址换取 30 天 Cookie 才放行，裸地址 401。launcher 每次启动后从 server.log **最新启动块**解析 token（`_read_launch_token`）+ 拼认证地址（`_web_auth_url`，含"端口已就绪但 token 未打印"的竞态等待）→ `open_ui` / `wait_and_open` / `launch_desktop_shell` 统一使用；桌面壳经 `--url` 接收认证地址（详见坑48）。

* **防火墙**：`dsh_host=0.0.0.0` 时用 netsh 放行 3080 入站 TCP（须管理员，失败仅记日志）。

* **桌面壳**：`desktop-shell.py`（pywebview），`webview.start(on_ready, icon=...)`；用 PID 文件 + OpenProcess/GetExitCodeProcess 判存活排重（别用页面心跳）；服务未就绪先显示提示页、就绪后切真实界面。入口仅 GUI「桌面窗口」按钮（pythonw 直启无黑窗）。

* **命令行**：`--start`(守护) / `--stop` / `--purge-archived` / `--purge-session <ID>` / `--restore-session <ID>` / `--install-plugin` / `--remove-plugin`。

* **内置插件自动同步**：`update_bundled_plugins()` 把 `plugins/` 源码镜像进运行副本（逐文件 MD5 比对、只写变化、清理源码已删陈旧文件）；入口＝打开插件管理窗口 / 「一键安装内置插件」/ 绿色版更新后首启。

* **pnpm 构建白名单已自动化**：`ensure_pnpm_native_allowbuilds`（装插件/环境时幂等补原生依赖 `false`）+ `auto_allow_git_build`（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 时从报错提取含完整 commit 的 allowBuilds key 写 `true` 并重试，幂等）。**绿色版 zip 不含 runtime/，此补丁必须在启动器内自动做**。

* **dsh 升级后自愈（`update_dsh`** **成功后自动执行** **`_heal_after_core_upgrade`，根治坑47）**，四步串联：① `_remove_incompatible_bundles` 移除黑名单 `UPGRADE_INCOMPATIBLE_BUNDLES`（dshmarket）＋历史启动日志（server.log 尾部 300 行）定位到的不兼容 bundle；定位判定 `_extract_bundle_from_log`＝日志含 `UPGRADE_INCOMPATIBLE_LOG_KEYWORDS` 关键字（`does not provide an export`/`is not in cache`/`ERR_MODULE_NOT_FOUND`/`Cannot find package`/`SyntaxError`）＋堆栈路径命中 profile 的 bundles **且** dependencies（内置 bundle 不在 dependencies 永不误删）→ ② `_heal_profile_dependencies` 补宿主核心声明的 peer 依赖（autoInstallPeers:false 不会自动装）＋把 profile 自身与 file: 本地插件的核心依赖版本同步到宿主已装版本 → ③ `_rebuild_dependency_tree` 便携 pnpm `install --force --no-frozen-lockfile` 强制重建（复用 BOM 清理＋allowBuilds 补丁）→ ④ `_smoke_verify_core_upgrade` 独立子进程冒烟启动验证端口监听；失败再从探针日志定位 1 个不兼容 bundle 移除重建重试（最多 2 轮，每轮只删 1 个避免误删）。服务运行中跳过冒烟。任一步失败只记警告不阻断「更新已成功」返回。

* **【关于】对话框**：右上角「关于」入口，含作者/版本/仓库/发布主页；GitHub 仓库 / Gitee 仓库 / 发布主页 / 官方仓库 以**可点击链接文字**呈现（蓝色 + 手型光标，`<Button-1>` 绑 `webbrowser.open`），底部仅留「关闭」按钮。链接项用 `(url, 显示文本)` 元组 + `isinstance(value, tuple)` 判断。发布主页常量 `GREEN_HOME_PAGE_URL`（GitHub Pages 地址）在信息表引用。

## 五、避坑经验（按主题聚合，均实证）

### 编码坑（最常见，必看）

1. **PowerShell 调 REST 发中文变** **`?`**：`Invoke-RestMethod -Body $str` 按本地 ANSI(GBK) 序列化。必须 `[System.Text.Encoding]::UTF8.GetBytes($json)` + `-ContentType "application/json; charset=utf-8"`。
2. `.ps1` 里写中文常量会被按 ANSI 读 → 脚本保持纯 ASCII；中文 body 拆独立 UTF-8 文件用 `ReadAllText(path,[Text.Encoding]::UTF8)` 读入；中文校验走 python，别在 PS 里 `-match "中文"`。
3. git commit 带中文经 PowerShell 变 `?` → 一律用 UTF-8 消息文件 `git commit -F <file>`，不用 `-m "中文"`。
4. `Compress-Archive -Path "plugins\dsh-xxx"` 会丢 `plugins/` 前缀 → 打 zip 传递目录名；最稳用 Python `zipfile` 打包并 `tar -tf` 复核根结构。
5. PowerShell 里 `"$uploadUrl?name=..."` 的 `?` 会被当变量名吞 → 用 `${uploadUrl}` 花括号界定。

### dsh 集成坑

1. dsh bin 入口是 `node_modules/@deepseek-ai/dsh/lib/bin.js`，别依赖 `node_modules/.bin/dsh.cmd`（会混系统 node）。
2. 不设 `DSH_HOME` 会写用户主目录；Windows 上定位 npm-cli 发行根用 `os.path.dirname(node_exe)`（Linux/Mac 多退一层）。
3. auto 镜像的 `npm install` 不会自动挂 `--registry`（`is_auto` 分支没加）→ 国内很慢甚至卡住。
4. 官方刻意拒绝 `--host 0.0.0.0` → 必须 `patch_web_startup()`；升级重装会还原，补丁幂等重打。
5. **Chrome 150+ 无端口 Origin 403**：官方 `new URL(origin).host === hostUrl.host` 精确比较，loopback 请求 Origin 不带端口 → 全 /api 403。补丁改 hostname 比较。排查"该放行却 403"→ 先给被拒出口加含 UA/Origin 的日志。
6. `crypto.randomUUID` 在 http + 非回环 IP 下用不了 → 注入基于 getRandomValues 的 polyfill。
7. node\_modules 内所有官方文件补丁都会被 dsh 升级重装还原 → 一律在 install\_dsh + start\_server 双点幂等重打。
8. **官方 dsh「npm 与 GitHub 不同步」，只查 npm dist-tags 会漏更新**：官方每个版本发 GitHub（tag `dsh-v<ver>`）但不一定同步 npm；源码 tag 无法直接安装（ETARGET）。检测必须同时拉 GitHub Releases 全 tag + npm 全版本（见第二节）。

### 插件开发坑

1. `package.json` 双入口：`dsh.bundle.patch`(→cordis.patch.yml) + `dsh.client` 才双端加载；`exports` 必须含 `"./package.json"`；`files` 必须含 `cordis.patch.yml`；**纯客户端插件也必须有宿主端** **`lib/index.js`（哪怕空** **`export{}`），否则整个服务起不来**。

2. 宿主注册路由必须 `ctx.effect(() => ctx.webServer.register({...}), label)`（把返回值当清理函数）；写成"先 register 再 effect(disposer)"会注册即注销 → 非 GET 全 405。

3. 防御路由带自定义头防 CSRF；GET 媒体路由 `req.method !== "GET/HEAD"` 会 405 → 预览走 `fetch(url,{headers})→blob→objectURL`（`<img>`/`<iframe>` 带不了自定义头）。

4. **pnpm 对** **`file:`** **本地路径是拷贝非软链**：改 `plugins/` 源码必须同步运行副本 `runtime/dsh-home/profiles/web/node_modules/<name>/`（或重装）；服务端文件（index.js/cordis.patch.yml）改后**重启服务**、client.js 改后强刷；运行文件被锁先停服务。**这是最易"改了没生效还当已完成"的坑，验证用** **`Get-FileHash`** **比对 SAME。** 同步已自动化（见第四节）。

5. **pnpm 非 0 退出码 ≠ 失败**：`ERR_PNPM_IGNORED_BUILDS` 让 pnpm 以 1 结束但安装成功，官方 reconcile 只在 exit=0 时写 `dsh.profile.bundles`。launcher 用 `reconcile_bundles()` 兜底自动写编排层 + 启停开关（`dsh.profile.disabled` 由 launcher 自己维护，官方不识别）。

6. 官方客户端 store 的**当前会话字段是** **`snapshot.current`（不是 sessionId）**；"数据源在却取不到"先核对键名（`current`/`byId`/`jobsBySession`）。

7. **工作区根权威来源 =** **`workspaceRegistry`**（读 `storages/workspace.json`），不是 `sandboxPolicy.workspaceRoot`（后者未显式配置时 = `process.cwd()` = `runtime\dsh`，兜底必错）。

8. 主题自适应：插件颜色改用 `var(--dsw-alias-*)`（CSS 变量自动随主题，**别加 JS 主题监听**）；锚定在固定浅色框里的内容整组固定（浅框 + 深字），只有框外页面级文字随主题。

9. pywebview：**`webview.start()`** **之前绝不调** **`load_url()`**（打断原生窗口创建，静默回退浏览器）；换图标用 `webview.start(icon=)`（WinForms）；窗口就绪后的导航/初始化放 `webview.start(func)` 回调；打开去重手动/自动分开走。

10. **`sctx.settings.mutate`** **只认** **`set`/`unset`，不认** **`remove`**：`op:"remove"` 抛 schema 校验错误、异常冒泡成运行失败。所有"删除字段"的写法统一用 `unset`。

11. **webServer.register 无** **`method`** **字段，同 path 只能注册一次**：想分 GET/POST 必须**在同一个 handler 里按** **`req.method`** **分流**；对同一 path 注册两条抛 "Duplicate (kind,path)"，整插件 fiber 回滚、所有路由失效 → 客户端全 404。排查 404：①先核对是否同 path 注册两条；②确认 `__DSH_BOOT__` 有该插件 client 条目、`/plugins/<id>/client.js` 能 200。

12. **给 DSH 加模型 / 新 Provider，正解是写 pi-ai 的** **`providers`** **配置，绝不自己调** **`ctx.llm.registerAdapter`/`registerModelDiscovery`**：`registerAdapter` 对 provider 路由是**排他**的、`registerModelDiscovery` 每 namespace 只能一个。正确姿势＝`sctx.settings.mutate("llm-pi-ai", ops)` 写 `providers.<id>`（displayName/api/baseURL/models/headers/compat），pi-ai 监听变更自动注册模型目录 + 对话路由 + 模型发现。

13. **OpenAI 兼容服务（Ollama / LM Studio / vLLM）必须配** **`compat`**：这类端点不认 OpenAI 官方方言（`developer` 角色 / `max_completion_tokens` / 工具 `strict` 字段），不配则工具 schema 到不了模型 → 模型接入后从不调工具。Ollama 用 `compat:{supportsDeveloperRole:false, supportsReasoningEffort:true, maxTokensField:"max_tokens", supportsStrictMode:false}`（`supportsReasoningEffort` 必须 `true`，否则无法关思考）。

14. **免鉴权服务须给 provider 补占位 Authorization 头，别写** **`apiKeyEnv`**：`openai-completions` 协议强制要求带 key 或头；`apiKeyEnv` 指向未设变量抛 `MISSING_CREDENTIAL`、指向已设又真解析不可控。正解 `headers:{Authorization:"Bearer ollama-local"}`（服务不校验该头）。

15. **`maxTokens`** **必须远小于** **`contextWindow`**（如 32768/8192），相等必截断。提升 Ollama 上下文别用 `OLLAMA_CONTEXT_LENGTH` 环境变量（桌面版 serve 不继承）也别用 `/v1` 的 num\_ctx（只原生 `/api/chat` 认）→ 正解用 Modelfile `PARAMETER num_ctx N` 建 `-32k` 变体，再装模型、DSH 指向该变体。

16. **Ollama 关 thinking 只认** **`reasoning_effort`，不认** **`think:false`**：新版 `/v1` 端点静默丢 think 字段。正解＝`compat.supportsReasoningEffort:true` + 每模型 `reasoningEfforts` 映射 `{off:"none",minimal:"none",low:"low",medium:"medium",high:"high"}`；DSH 思考档 off 时发 `reasoning_effort="none"` → 关思考。

17. **周期自动写入必须用** **`mergeModelParams`** **保留用户手改的"生效字段"**：自动同步 models 时若整体覆写 `profile.models`，Models 页手改的 contextWindow/maxTokens/name 会被下一轮探测覆盖（默认 60s）。面板数字框要绑**生效字段** `targetContextWindow/targetMaxTokens`（不是 `default*`——后者是回退值，`target*` 一设就盖掉它，改了不生效）。

18. **Ollama thinking 模型在 WebUI 长时间停在「Deep diving…」是正常**（先流 `reasoning-delta` 后出正文，本地 4B 冷启动+思考要十几秒到几十秒）。curl 直测 OpenAI 兼容端点注意 PowerShell 单引号 JSON 被吃 → JSON 写临时文件 `--data-binary "@file"`；`api/ps` 空 = 模型未加载（冷启动）。

19. **pnpm git 源插件** **`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`**：pnpm 11 strictDepBuilds 拦 git 源依赖（`github:owner/repo` → codeload tar.gz）的 prepare 脚本。正解＝profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 用**错误里含完整 commit hash 的 URL** 置 `true`（用包名/版本/分支都不匹配）；预构建原生依赖（cloudflared/cpu-features/node-pty/protobufjs/ssh2）显式 `false`，否则 `ERR_PNPM_IGNORED_BUILDS` 中断。改完无需删 node\_modules，直接重跑 add。launcher 已自动化（见第四节）。

20. **自建 WebUI 侧栏/悬浮件的开关按钮别钉官方右上角，也别叠在内容区中间高度**：官方右上角有「下载对话」等按钮，`position:fixed;top:right` 会盖住它们；而把折叠开关**垂直居中叠在面板（如文件列表）高度上会挡住列表点击**（两面都踩坑）。社区 better-sidebar 的 **toggle cluster**——开关**始终固定在面板顶部**：展开态折叠按钮在标题/tab 条右端（内容区之外），收起态开关在右上角/右缘圆形图标按钮；按钮用官方 icon-button 样式（圆形无边框 / hover 加深），图标复刻 `IconPanelRightOutline16` 而非字符箭头。重叠靠\*\*「展开时官方 header 已被 `#root` 的 `margin-right` 让位推到面板左侧」，官方按钮不在面板内右上角**来规避（`dsh-sidebar-lite`** **已如此实现）。多侧栏/浮动面板并存**时，额外面板（如独立文件预览框）用固定定位 + `right: 主面板宽`\*\* 叠在主面板左侧，并在 `#root` 的 `margin-right` 里**累加该面板宽度的让位 CSS 变量**（`calc(var(--dsh-sidebar-lite-width) + var(--dsh-sidebar-lite-extra))`），面板关闭时让位变量归零——否则主内容会被后开的浮动面板遮挡。

21. **React 函数组件里 const/let 变量的 TDZ（Temporal Dead Zone）坑**：任何被 `useCallback(fn, [scope])` / `useEffect(fn, [scope])` **依赖数组引用**的变量（包括从 useState 返回的值、从 store/getSnapshot 计算的局部变量、`const scope = {...}` 这类派生对象），**必须在这些 hooks 声明之前定义**。JavaScript 的 TDZ 规则：`const`/`let` 声明从代码执行流到达该行时才初始化，在此之前引用抛 `ReferenceError: Cannot access "xxx" before initialization`。典型场景：SidebarShell 组件里 `openPreview = useCallback(() => { setPreview({entry,scope}) }, [scope])` 写在 L1107，而 `const scope = {...}` 直到 L1201 才声明 → 组件渲染时 useCallback 初始化就炸。**修复方式**：要么把依赖变量的定义上移到所有 hooks 之前，要么把 useCallback/useEffect 下移到变量定义之后。注意：dsh 的插件 client.js 最终被合并打包（`/plugins/??...&rev=hash`），报错堆栈里的行号是 **sourcemap 映射后的原始文件行号**（不是 bundle 里的绝对行号），修完后须用**全新浏览器标签页**验证（旧标签页的 ModuleLoader 已缓存模块，刷新不会重新执行）。

22. **dsh-ollama 变体识别正则只匹配整数、漏了小数点 → 无限递归创建多层后缀垃圾模型**：`ensureContextVariants` 用 `/-\d+k$/` 判断模型名是否已带"上下文后缀"（如 `-32k` / `-64k`），以此过滤掉变体只让原始模型参与决策。但 `targetContextWindow` 除以 1024 后可能产出 **带小数的后缀**（64000 / 1024 = `62.5k`），而正则里的 `\d` 只匹配纯数字、不匹配小数点，导致 `gemma4:latest-62.5k` **不被当作变体**、被当作原始模型进入循环 → `variant = gemma4:latest-62.5k-62.5k` → 用 Modelfile `FROM gemma4:latest-62.5k` 创建（ollama create 幂等，变体已存在不会报错）→ 下一轮探测时旧正则仍漏判 `gemma4:latest-62.5k-62.5k` → 又创建 `-62.5k-62.5k-62.5k`……**每次探测循环加一层后缀**，几十轮后 Ollama 里堆出 11 层叠加的垃圾模型（全 9.6 GB 一个，白白占几十 GB 磁盘）。**修复**：三处正则统一从 `/-\d+k$/` 改为 `/-\d+(?:\.\d+)?k$/`（支持 `-32k` / `-62.5k` / `-3.1k`）；同时加两层防御纵深：① `probeOllamaModels` 源头用 `multiVariantRegex` 过滤掉含多层后缀的 Ollama 垃圾模型（防止 `ensureContextVariants` 被脏输入污染）；② `ensureContextVariants` 在 `ollama create` 前校验 variant 名不含多层后缀（兜住未来有人改了源头过滤又回归）。**教训**：`Math.round(target/1024)` 这种整数除法假设在工程里要小心——浮点除法可能产出小数后缀，正则、字符串拼接、Map key 匹配都要留余地。

### PyInstaller / 打包坑

1. `--onefile` 不带全运行库：**显式** **`--add-binary`** **打包 VC 运行库三件套** `vcruntime140.dll` / `vcruntime140_1.dll` / `vcruntime140_threads.dll`，否则目标机报 "Failed to load Python DLL"。
2. onefile 里程序根目录用 `sys.executable` 所在目录（`frozen` 判定），别用 `__file__`（指向 `_MEIPASS` 临时解压目录）。
3. 更新器自替换：运行中的 exe 不能覆盖自己 → 先把自己 `copy2` 到 `runtime/tmp/<name>_worker.exe`，从副本带原参数再 Popen、原进程退出；用 `normcase` 比较绝对路径避免无限自启。
4. 分离进程/无控制台的休眠用 `wscript.exe "%~dp0sleep_helper.vbs" <ms>`（WScript.Sleep），**别用 ping/timeout/choice**：ping 闪窗且依赖可能损坏的 ping.exe，timeout/choice 在 stdin 重定向时失效。

### 发布 / 平台坑

1. **Gitee** **`/releases`** **按创建时间升序返回 + 默认每页 20**：取"最新"必须 `?per_page=100` 后再按 `created_at` 降序（否则首选到最旧 v1.0.9 → 误报"已是最新"）。凡依赖第三方列表接口取"最新"都要防顺序假设 + 分页截断。

2. Gitee 整仓 zip 接口是 `repository/archive/<branch>.zip` 且被 JS 挑战墙（纯 urllib 拿不到）→ 走 git 智能 HTTP 协议（`info/refs` + `git-upload-pack`，需处理 zlib 边界、REF/OFS delta、`bytes.fromhex`）。**手动上传的附件** `/releases/download/<tag>/<file>` 可直连；自动生成的 tag 源码包是挑战页 → 选 zip 必须 URL 含 `/releases/download/`，且 Gitee asset 无 `size`（用 `size:0` 跳过校验）。

3. 网络（本机常态）：常只有 `api.github.com` 可达、`github.com:443` 直连超时。git push 失败 → 用 GitHub API 建 ref/提交/传资产（uploads.github.com）；可临时全局代理 `-c http.proxy=...`。Gitee push 认 `https://oauth2:<token>@gitee.com`（`用户名:token` 会 403）。

4. Gitee 删附件：用 **curl.exe**（PowerShell `Invoke-RestMethod -Method Delete` 404），且**逐条删**（短时间批量循环命中限流返回假 404），删后 `attach_files?per_page=100` 复查。

5. **Git Data API 断点续推坑**：远端 master 会变成"本地没有的改写 SHA"，`rev-list <remote>..master` 报 `Invalid revision range`。正解（`runtime/tmp/git_push_github_api.py` 已实现）：①沿远端提交链向上找**第一个本地对象库存在的提交**作 rev-list 基准（**不能只取远端 master 的** **`parents[0]`**，父也可是改写版）；②用 **tree 相等**建立 `本地SHA→远端SHA` 映射；③待推列表 `rev-list --reverse local_base..master` 精确取（候选列表可能混入已推旧提交致基准不准）；④create\_commit 的 parents 用**远端父 SHA**、每次 commit 后回读远端 tree 作下个 base\_tree。改写提交**只在远端**，本地别 update-ref 到该 SHA（nonexistent object），本地 git status 显示 ahead 属预期。Gitee git data **只支持写**（POST blob/tree/commit、PATCH ref），GET commits 返回 405 → Gitee 直连可达时直接 `git push --force` 同步完整历史（改写链无 tag、是残缺中间态，force 安全；先 `git ls-remote` 核对）。

6. **绿色 zip 顶层清单要维护两处（打包** **`GREEN_TOP_FILES`** **+ verify 期望** **`expect_top`）**：漏一处（如 desktop-shell.py）会导致新机对应文件缺失但本地不报错。**教训：新增/同步顶层文件必须两处都改，verify 期望要和打包清单逐一对应；建议收敛为单一数据源**（verify 直接从 `GREEN_TOP_FILES`/`GREEN_TOP_DIRS` 派生期望，从根上消灭"清单不一致"）。

7. **pnpm 11+ strictDepBuilds（安全机制）**：① 已预构建的原生依赖（cloudflared/cpu-features/node-pty/protobufjs/ssh2）缺省会在安装时报 `ERR_PNPM_IGNORED_BUILDS` 且以非 0 退出 → `pnpm-workspace.yaml` 的 `allowBuilds` 显式写 `false` 跳过（launcher `ensure_pnpm_native_allowbuilds` 自动补）；② git 源插件的 `prepare` 脚本默认被拦（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`）→ 需从报错建议块提取 `name@commit-url: true` 精确放行（launcher `auto_allow_git_build` 自动提取重试）。

8. **升级 DSH 核心后插件树起不来（服务秒退/退出码 1）必查两件事**：① **编排层 bundles 里残留不兼容插件**——新核心移除旧导出（如 `@deepseek-ai/dsh-settings` 的 `installSettingsSection`）时，内置 dsh-market 会报 `does not provide an export named ...`，从 `profiles/web/package.json` 的 `dsh.profile.bundles` + `dependencies` 移除并 `pnpm install --force --no-frozen-lockfile` 重建；② **peer 依赖缺失**——`pnpm-workspace.yaml` 配了 `autoInstallPeers: false`，新版 `@deepseek-ai/dsh-session` 的 peer 依赖 `@deepseek-ai/cordis`/`@deepseek-ai/dsh-scope`（其又依赖 `dsh-invariants`）不会自动安装，插件 import 时报 `request for '@deepseek-ai/cordis' is not in cache` / `ERR_VM_MODULE_LINK_FAILURE` → 在 profile `dependencies` 里**显式声明**这些 peer 依赖（版本与核心一致：`cordis@4.0.2`、`dsh-scope`/`dsh-invariants@0.1.2-alpha.2`）再重建。验证：`node_modules/@deepseek-ai/` 需含 cordis/cosmokit/dsh-scope/dsh-llm/dsh-brand/dsh-session 等；`curl http://127.0.0.1:3080` 返回 401（服务存活）而非进程退出。**launcher 已把整套修复自动化**：`update_dsh` 成功后自动执行自愈流程（移除不兼容 bundle → 补 peer 依赖/同步核心版本 → 强制重建依赖树 → 冒烟启动验证），升级后起不来的情况不再需要手动改 profile（见第四节）。

9. **新版 dsh 的 web 认证（401 "dsh web authentication required"）**：0.1.2-alpha.2+ 的 client-connection 在首次访问前要求认证——启动时打印的 URL 带一次性 `?token=<launchToken>`（**每次进程启动都重新生成**），打开它才签发 30 天浏览器 Cookie（签名 secret 跨进程持久），此后请求放行；直接打开裸地址返回 401 且显示 "dsh web authentication required; reopen the URL printed by dsh web."。launcher 已处理：`_read_launch_token()` 从 server.log **最新一个启动块**解析 `dsh web: ...?token=` → `_web_auth_url()` 拼认证地址（**`/`** **不能省**，统一 `http://host:port/?token=...` 与 dsh 打印一致）→ `open_ui`/`wait_and_open`/`launch_desktop_shell`（经 `--url` 传给桌面壳）统一用它打开。**竞态**：dsh 先绑定端口、插件树加载完成才打印带 token 的 URL，故"端口已就绪但 token 未落盘"是常见窗口期 → `_web_auth_url` 在端口已监听的前提下最多短等 8s 等 token 打印（服务未启动端口未开则不白等，兼容旧版无认证）；`wait_and_open` 必须在 `wait_ready` **之后**再解析地址，否则过早拿到空 token 退回裸地址。**改 launcher.py 后必须重打包 exe**：旧 exe 打开裸地址必然 401，界面显示 "dsh web authentication required"（曾误判为"启动失败"）。桌面壳 WebView2 每次经 `--url` 拿到全新认证地址，Cookie 每次都能签发，无持久化阻塞。

10. **0.1.2 客户端快照重构：`useSession`** **不再含聊天数据，改用** **`useChat`（2026-08 实测，dsh-usage-stats 消息行修复）**：

* **官方 0.1.2+ 把会话数据拆成两层**：`useSession`（standard kit）返回 **SessionSnapshot**（仅生命周期：queue/running/openState/hasMore/blank…），聊天内容改由新的 standard-kit hook **`useChat`** 提供（`SnapshotSelectorHook<ChatSnapshot>`，`chat.legacy.nodes` = ConversationNode\[]、`chat.nodes` = ChatNodeStore）。旧版（rc.6）`useSession` 直接返回含顶层 `nodes`/`chat` 的 ConversationSnapshot——**读** **`snapshot.nodes`** **的插件在 0.1.2 会静默拿不到数据（消息行消失）**。兼容写法：`const data = useChat ? useChat(s=>s) : useSession(s=>s)`，再统一从 `data.nodes`（数组，rc.6 legacy）/ `data.legacy.nodes`（0.1.2）/ `data.nodes.values()` 或 `data.chat.nodes.values()`（store 兜底）取节点。官方 StatsLine 即 `useChat(s => s.legacy.nodes)`。

* **聊天 UI 包迁移**：`turnTail` / `assistant-actions` / `conversation.chat.node` 等插槽从 `dsh-client-ui-conversation` 迁至新包 **`dsh-client-ui-chat`**（契约不变：turnTail 仍 chain/session/TurnTailOwnerProps{turn,seq,openFile}、assistant-actions 仍 list/session/{messageId}；旧 conversation 包仍在但只含会话层）。

* **官方 0.1.2 新增逐回合精确记账**：turn-tail 节点 `data.tokenUsage`（`TurnTokenUsage`：uncachedInputTokens/outputTokens/totalTokens/cacheRead/cacheWrite/reasoningTokens + routes 按 provider/model 归属，窗口证据不全时缺省）——消息行"实际消耗"的最权威来源（插件当前仍用 legacy 求和，二者对完整回合一致；后续可切换为官方记账）。

* **官方 ContextMeter（输入框右侧环形仪表）与用量统计不冲突**：ContextMeter 显示当前会话**上下文窗口占用**（\~已用/窗口 + 系统/工具/消息三段，估算值，无费用）；本插件显示**实际计费 token + 费用估算 + 账户余额**（账单视角）。互补关系，见插件 README「与官方功能的区别」。

1. **web token 认证开关（2026-08-31，需求 #49）**：DSH 0.1.2-alpha.2+ 的 BrowserAuth 是强制开启的（官方 Config 里没有 enableAuth 开关），关掉只能 patch。绿色版实现：`launcher.py` 加 `dsh_require_auth` config 字段（默认 True）+ GUI 网络设置区复选框（动态安全警告：0.0.0.0+关auth 时红框、127.0.0.1+关auth 时橙框提示风险极低）+ `patch_auth(require_auth=True/False)` 条件式补丁函数（双副本覆盖 core+shared、幂等、支持正向关闭+反向还原）。patch **只关 token/Cookie 层**（BrowserAuth.isAuthenticated 跳过），**保留 Host/Origin 围栏**（isTrustedApiRequest → 403）。所以 "关 token" ≠ 回到旧版 0.1.1-rc.2 裸奔（旧版两层都没），而是 401 那层的安全门拆了但 403 Host 防火墙还在。127.0.0.1 下 loopback 自动放行 403，实际差异为零；0.0.0.0 下等于"局域网任何人靠 Host header 就能直接访问界面"。两个精确 patch 点（官方打包纯 tab 缩进）：① `requestRejection()` 第二行 `return this.browserAuth.isAuthenticated(request) ? void 0 : 401` → 改 `return void 0;`；② `authorizeIndex()` 方法体开头插入 `return true;` 跳过 token/Cookie 校验。启动前 patch 链（两处：install\_dsh 安装后 + 启动服务前）根据 config 决定 patch 方向；`_web_auth_url()` 在 auth 关闭时直接返回裸地址短路，省掉 8s token 竞态等待。**还原方向**（用户改回 require\_auth=True）会把两处 patch 还原回官方原始代码，不留残留。dsh 升级重装会清除所有 patch，启动前自动重新应用。

2. **dsh-sidebar-lite rail 开关位置 + 初始宽度最小化（2026-09-01）**：

* **rail 位置**：从
  ight:10px;top:50%（右侧垂直居中）→
  ight:16px;top:56px（右上角 header 下方）。避开官方「下载日志」按钮（\~top:48px right:8px）。Rail 从「仅收起态显示」改为「始终显示」——展开态用 Fragment 包装 host + rail，rail fixed 定位独立于 host 不占内部空间。onClick 从 ()=>setOpen(true) 改为 ()=>setOpen(o=>!o) toggle，title/aria-label 随状态切换。展开态侧栏内部 collapse 按钮保留作为次级关闭入口。

* **初始宽度**：useState(PANEL\_WIDTH=320) → useState(MIN\_PANEL\_WIDTH=200)。新增常量 MIN\_PANEL\_WIDTH=200 统一所有硬编码 200px（主面板拖拽最小值、预览框拖拽最小值、lastWidthRef 初始值、挂载 setPanelWidth）。首次打开 200px 不挡太多主内容，用户按需拖宽。收起/展开记忆的 lastWidthRef 同样从 200 起步（用户拖宽后再收起会记住更宽的值）。

* **Fragment 双元素返回**：原来 SidebarShell 要么返回 rail（!open），要么返回 host（open）。现在 open=true 时返回
  eact.createElement(react.Fragment, null, \[host, rail])——React 16+ Fragment 允许返回数组，且 rail fixed 定位不依赖 host DOM 层级。

1. **发布规范：绿色 zip 不含 runtime/（2026-09-01，v1.0.24 重打包发现之前没记录）**：

* **绿色 zip 目的**：启动器 exe 自身无能力下载 runtime，首次运行后才下载 DSH 核心（Node.js + 插件树）。zip 只携带**启动器层**文件，用户双击 exe 启动，联网后自动拉取 runtime。

* **zip 内容清单**（由 `runtime/tmp/build_release_zip.py` 的 `GREEN_TOP_FILES` + `GREEN_TOP_DIRS` 定义）：

* 顶层文件：`launcher.py`、`desktop-shell.py`、`update_agent.py`、`start.bat`、`stop.bat`、`build_exe.bat`、`DSH_Launcher.exe`、`DSH_Update.exe`、`DSH_Launcher.ico`、`config.json`、`README.md`、`README_EN.md`、`LICENSE`

* 顶层目录：`plugins/`（全量）、`skills/dsh-deploy-maintain/`

* **绝不含**：`runtime/`、`build/`、`dist/`、`.git/`、`DEV_NOTES.md`、config.json 运行时用户配置

* **发布流程 checklist**（每次发版必走）：

1. 更新 `launcher.py` 的 `GREEN_VERSION`（唯一版本来源，不要硬编码版本号到 zip 名里）
2. 改了 `launcher.py` 或 `update_agent.py` → 重跑 `build_exe.bat`（两个 exe 里的版本日期会同步）
3. 运行 `python runtime/tmp/build_release_zip.py`（自动回写 `GREEN_VERSION_DATE` 为构建当天日期 → 打 zip → verify 根目录齐全）
4. `git add launcher.py DSH_Launcher.exe DSH_Update.exe` → commit → push
5. `git tag -a v{version} -m "v{version}: 版本说明"` → push --tags
6. **Gitee Release 上传**：`set GITEE_TOKEN=xxx` + `python runtime/tmp/gitee_upload_release.py --zip <zip_path> --tag v{version} --name "v{version}: 版本说明" --body "<release_body>"`（脚本自动查已有 release，有则直接传附件，无则先建 release 再传）
7. **GitHub Release 上传**：MCP 工具只有 `create_release` 没有 `upload_asset` → 用临时 Python 脚本直接调 GitHub REST API（标准库 urllib 即可，不需要 requests）：先 POST `/releases` 建 release，再 POST `uploads.github.com/repos/{owner}/{repo}/releases/{id}/assets?name={filename}` 以 `application/octet-stream` 传 body。脚本可以存 `runtime/tmp/github_upload_release.py` 以后复用。
8. **清理**：删除本地构建产物 zip（已上传到 Release 的 zip 不在 gitignore 里，别 commit）

* **zip 文件名**：`DSH_Launcher_GreenPortable_Online_<YYYYMMDD>_v<version>.zip`（日期=构建当天，版本号=GREEN\_VERSION）。`build_release_zip.py` 自动生成，不要手写。

* **双平台 token**：Gitee 在网页「个人设置 → 安全 → 私人令牌」勾 `projects`；GitHub 在网页「Settings → Developer settings → Personal access tokens → Tokens (classic)」勾 `repo`（完整 repo 访问，需 upload asset）。命令行临时 `set GITEE_TOKEN=xxx` / `set GITHUB_TOKEN=xxx` 用完即弃，别写入任何文件。

* **为什么不用 gh CLI / hub CLI**：新环境默认没装，临时装浪费时间。Python 标准库 urllib + multipart 手写足够（两个脚本都已实现）。

1. **DSH 0.1.2-alpha.3+ 框架契约变化：profile.bundles 必须显式声明 core bundles（2026-09-01，v1.0.25 自愈升级）**：

* **现象**：升级到 0.1.2-alpha.3 后启动报 plugin tree failed to load: dsh: 8 entries did not activate，所有插件等待 webServer / llm 等核心服务。

* **根因**：旧版本框架自动注入 @deepseek-ai/dsh-base + 对应 profile 层（dsh-web-app / dsh-headless 等），新版本不再自动注入，**必须显式声明在 dsh.profile.bundles 数组里**。launcher 从第一个版本就没写过这些，升级后 bundle 栈底层 = 空，所有插件依赖的核心服务不存在。

* **自愈体系 4 个盲区**（为什么之前的逻辑兜不住）：

* ① 移除不兼容 bundle：黑名单只覆盖"已知插件不兼容"，处理不了"框架改了行为"；

* ② 补 peer 依赖 + 同步版本：只碰 dependencies，**从不碰 dsh.profile.bundles 数组**；

* ③ 重建依赖树：pnpm install 按 package.json 声明装，core bundles 不在声明里；

* ④ 冒烟验证：日志解析器只认 5 种关键字（ERR\_MODULE\_NOT\_FOUND 等），waiting for services 一个都没命中。

* **升级后自愈体系（3 层防护）**：

* Layer 1 - 写入时兜底：
  econcile\_bundles() 前置调 \_ensure\_core\_bundles()，每次任何 bundle 操作都先确保 core 存在；

* Layer 2 - 安装时同步检查：erify\_environment\_integrity() 新增"检查 1.5: core bundles 存在性"；

* Layer 3 - 冒烟时框架级故障诊断（新增）：\_diagnose\_framework\_failure() 识别日志特征，自动调 \_ensure\_core\_bundles() 修复并重试（最多 3 轮）。

* **自适应探测**：\_detect\_runtime\_profile\_core\_bundles() 扫描 runtime @deepseek-ai/ 包的 cordis.patch.yml 和 description，自动识别 profile 级 core bundle。探测失败才用硬编码常量兜底。

* **关键认知**：core bundles 只需要在 dsh.profile.bundles 数组里出现即可，**不需要写入 dependencies** - 它们在 runtime 的 node\_modules 里已经装好了，DSH 框架加载 bundle 时直接按名字在 runtime/@deepseek-ai/ 下找对应的包。

1. **profile package.json 依赖污染根因：\_host\_peer\_dependencies() 扫描范围过广（2026-09-01，v1.0.25 修复）**：

* **现象**：插件管理界面显示大量 runtime 内部包（96 个 @deepseek-ai/\*），正常电脑只有 8 个本地插件。

* **根因**：\_host\_peer\_dependencies() 原逻辑收集**所有** runtime @deepseek-ai/\* 包声明的 peerDependencies -> runtime 内部 peer 互相引用被当作"profile 需要补的"写入 dependencies -> 污染累积。

* **修复**：

* \_host\_peer\_dependencies() 加 2 条过滤：peer 是 @deepseek-ai/\* 跳过（runtime 内部闭环）、peer 在 runtime node\_modules 里已存在跳过；

* 新增 \_clean\_profile\_manifest() 清洗污染依赖，删除黑名单前缀（@deepseek-ai/\* / cordis\* / schemastery / 顶层 dsh-\* 包），保留例外名单（cordis / cordis-plugin-\* / schemastery 被 cordis.yml 直接 import）；

* \_heal\_profile\_dependencies() 和 \_rebuild\_dependency\_tree() 前置调用清洗。

## 六、维护提醒

* 跨机 / 整包覆盖会吞掉本地未提交改动（实测覆盖过）→ 发布前先 `git diff` / `git log` 核对，或先把改动 commit。

* 改内置插件源码后必须同步运行副本并**在运行端目验**（见坑 17）。同步已自动化：打开插件管理窗口即同步 / 「一键安装内置插件」/ 绿色版更新后首启。

* 改 `launcher.py` 后须重打包 `DSH_Launcher.exe`（build\_exe.bat）；改更新程序 / 其它 exe 同理各自重打包。

## 七、待办 / 后续建议

* auto 镜像"国内优先、失败回退"扩到 npm install 阶段（坑 8）。

* README\_EN 随中文 README 每次发布一次性翻译对齐。

* 桌面壳真机冒烟：start.bat 首启全流程、默认桌面窗 + 图标 + 无 cmd 闪窗 + 未启动提示页、局域网防火墙放行。

* 观星背景影画：mkv/avi/hevc 等浏览器不原生支持的编码需转 mp4/webm；不进三级以上深层大目录（扫描深度限 6）；待机轮播 / 时段 / 遮挡门帘等高级特性未做。

* dsh-ollama「一键接入」已拆独立路由 `POST /__dsh/ollama/reconnect`（规避坑 24）复用 `runDetection(force:true)`，待实机验证在线/离线两分支。

* 插件管理「加载推荐」`RECOMMENDED_PLUGINS`（launcher.py 顶部，约 26 款）：生态情报只记目录站与口径、不逐版本记 star；扩充推荐时 `modlens` 装须**锁版本勿用 @latest**（pnpm 11 拦 <24h 版本），涉及内置插件安装须走插件管理。

## 八、GitHub Pages 在线发布页

* **源码位置与托管**：发布页在 `pages/`（`index.html` + `assets/style.css` + `assets/app.js`，零第三方依赖）；托管于 GitHub Pages，URL `https://liujunheng.github.io/DeepSeekHarnessGreen/`；资源用相对路径 `./assets/...`。内容结构：Hero + 快速上手 + 核心特性 + 双平台下载 + 内置插件 + 常见问题 + 页脚协议。

* **版本通用方案**：页面**不写死**版本号/日期；`app.js` 运行时读 `https://api.github.com/repos/LiuJunheng/DeepSeekHarnessGreen/releases/latest` 的 `tag_name` 回填 3 处版本芯片（`hero-version`/`dl-version`/`footer-version`），失败保留 HTML 通用提示；下载按钮均指向 `/releases/latest`。**发版零改动页面**。

* **部署**：`.github/workflows/pages.yml` 用 `actions/upload-pages-artifact` + `actions/deploy-pages` 发布 `pages/`；push 到 master 或手动 `workflow_dispatch` 触发；需 `permissions: pages: write, id-token: write` + `environment: github-pages`；仓库需先开启 Pages（Source = **GitHub Actions**）。

* **水纹动效**：`#water-background` Canvas 2D 绘制（三段流动水波带：青/蓝/紫、`lighter` 加法混合 alpha≈0.24\~0.26、波幅≈8% 屏高、每条波峰加 2px 亮光边突出"流动"感；+ 自动与指针涟漪 0.55 起始对比）；`prefers-reduced-motion` 时停用；**必须先同步调用一次** **`drawWaves(time)`** **画首帧，再** **`animate()`**——否则靠 rAF 首帧可能在后台/节流下迟滞，出现过 canvas 全空白、水纹完全不可见；调参集中在 `startWaterRipples` 的 `waveBands`/`maxRipples`/`autoSpawnGap`；`main,.footer` 抬升 `z-index:5` 于画布（`z-index:0`）之上保证可读。

* **避坑**：纯静态、不引第三方字体/统计/CDN；`index.html` 大小写敏感、须在发布根目录；Pages 不支持动态后端；Pages 若 404 先确认 Source=GitHub Actions 且 artifact 路径正确；仓库 Gitee↔GitHub 自动同步（代码/tag 主推 Gitee），但 Pages 的 workflow 触发与站点启用都在 GitHub 侧，须保证 GitHub master 上有 `pages.yml` 且能跑 Actions。

* **`pages/`** **不进绿色 zip**：`build_release_zip.py` 的 `GREEN_TOP_FILES` 不含 pages/，打包清单保持不变。

## 九、内置插件

全部 9 款内置插件的功能说明、配置、安装方法等已统一在插件自身 README 里维护：`plugins/<插件名>/README.md`。

launcher.py 侧注意事项（插件集成相关）：

* `_bundled_plugin_dirs()` 自动扫描 `plugins/` 下含 `package.json` 的子目录，无需手动注册。首次启动时 `install_bundled_plugins()` 自动装进 profile node\_modules，后续 `update_bundled_plugins()` 自动同步源码更新。

* launcher 启动时会对 node\_modules 里的插件做完整性校验（hash 比对），发现"被污染"会删掉从 `file:plugins/<插件名>` 重新 `dsh plugin add` 安装。修改插件源码后**直接重启 launcher 即可**，不用手动 copy。

* 插件文件必须**无 BOM UTF-8**。launcher 跑 pnpm install 时如果 JSON/YAML 有 BOM 会报 `SyntaxError: Unexpected token '\uFEFF'`。

## 十、profile package.json 与 cordis hoisting

### 1. 三层 node\_modules 结构（pnpm hoisted 模式）

```
runtime/dsh/node_modules/@deepseek-ai/cordis   ← DSH 框架自带 (唯一物理源)
runtime/dsh-home/profiles/node_modules/…       ← hoist 硬链接到上面
runtime/dsh-home/profiles/web/node_modules/…   ← hoist 硬链接到上面
```

pnpm hoisting 把三层 node\_modules 都指向同一份物理目录，不是三份拷贝。`os.path.islink()` 在 Windows hoisted 模式下返回 False（用的是 junction/硬链接不是 symlink）。

### 2. 插件管理里看到 cordis 不是"重复安装"

插件管理读 `list_installed_plugins()` → 扫 profile/package.json 的 dependencies → 无差别显示。cordis 家族恰好在 dependencies 里（hoisted 残留），所以被误显示为"已装插件"。

**不是真的装了两份**，是显示逻辑没过滤内部包。

### 3. profile/cordis.yml 不 import cordis

v1.0.25 自愈系统里 `_clean_profile_manifest` 的 `_EXCEPTIONAL_PROFILE_DEPS` 注释写的"profile 的 cordis.yml 直接 import cordis"——**实测 cordis.yml 只是 bundle 加载说明，没有任何** **`import cordis`**。例外名单是保守过度设计。

### 4. 例外名单已移除（v1.0.25 hotfix）

验证方法：

* 手动在插件管理里移除 cordis → 重启 DSH → 服务正常（pnpm hoisting 残留 + Node.js 模块解析自动向上回溯 → 不崩）

* 移除后 profile dependencies 变干净：只剩 file: 本地插件 + 用户主动安装的外部插件

**结论**：cordis 家族、schemastery 等内部包**应该全被** **`_clean_profile_manifest`** **洗掉**。例外名单已删除（-18 行）。如果未来 DSH 升级后发现某些内部包真的被 profile 代码 import 了，**届时再加精确例外**，而不是先留着所有内部包污染 dependencies。

### 5. 清掉内部包后的好处

* profile/package.json dependencies 干净（只有真正的插件）

* 插件管理列表不再误显示 cordis / schemastery 等内部包

* 依赖溯源清晰：装了什么插件 → package.json 里就看到什么

## 十一、system-prompt/assemble 插件注入机制

### 1. 事件签名

import '@deepseek-ai/dsh-system-prompt';

ctx.on('system-prompt/assemble', async (assembly, context, next) => {
// waterfall 模式: 可以修改 assembly, 然后调 next() 继续链
assembly.contexts.push({
name: 'unique-context-name',  // 必填, 全局唯一, 不能重复
text: '注入的纯文本内容',       // 必填, 必须是字符串
weight: 0.9,                  // 可选, 权重越高越优先
});
return next();  // 必须继续传下去
});

### 2. assembly 对象结构

* assembly.sections\[] — 官方预设的 section (persona, tools, 等)

* assembly.contexts\[] — 插件追加的 contexts (唯一可扩展的点)

* contexts 里的 name 必须全局唯一 (invariant.js 校验, 重复会 fail)

### 3. 已有使用者 (两个, 不冲突)

| 插件         | context name       | 内容          |
| ---------- | ------------------ | ----------- |
| dsh-memory | zuzong:auto-recall | 祖宗记忆库最近 4 条 |
| dsh-rules  | user-rules         | 用户手写的规则文件   |

### 4. 实现注意事项

* 必须 import @deepseek-ai/dsh-system-prompt — 否则事件没注册

* 钩子失败要静默 — 读文件失败/bridge 断开时别 throw, 用 try-catch 吞掉

* context name 全局唯一 — 两个插件用同一个 name 会报 invariant 错

* hook 是 async 的 — 可以 await bridge.callTool() 异步取数据

* 缓存策略 — 规则/记忆这种"读多写少"的内容应该本地缓存 (2s TTL), 避免每次请求磁盘 IO

### 5. 参考实现

* plugins/dsh-rules/lib/hooks.js — 纯文件读取注入, 带 fs.watch autoReload + BOM 清洗 + maxLength 截断

* plugins/dsh-memory/lib/hooks.js — 异步 bridge 取记忆 + 脱敏

### 6. dsh-rules 插件备忘

* 规则文件位置: DSH\_HOME/rules/user-rules.md (绿色版 = runtime/dsh-home/rules/)

* 规则存 DSH\_HOME 而非插件目录 — 插件升级不覆盖用户数据

* 自动创建: 首次启动时 ensureRulesFile() 从 default-rules.md 拷贝

* autoReload: fs.watch 监听目录 + 清缓存 — 下次请求生效


### 7. dsh-memory v2 记忆引擎升级 (2026-09-02)

#### 7.1 核心改动

* **数据库 schema 升级** — 新增 summary TEXT (AI 精简概要) + 	ype TEXT (记忆分类: user/assistant/decision/preference/fact) + 索引 idx_memories_type。旧库 ALTER TABLE 增量迁移, 向后兼容。

* **规则提炼引擎 (ruleSummarize)** — 零 LLM 成本, 纯正则规则生成精简概要 (60-120 字):
  * 用户消息: 去掉 "帮我/请/请问" 等寒暄 + 第二人称 "你", 取第一句核心 query, 去句尾标点, 最多 80 字
  * AI 回复: 跳过 "好的/明白了/收到" 等寒暄 + "这是/下面是" 等套话, 按信息量评分 (含数字 +10, 技术关键词 +15), 取 top 1-2 句, 最多 120 字
  * 日志噪音检测: 以 [HH:MM:SS] 开头的行占比 > 50% → 从最后一行抽提示或返回 null (跳过写入)
  * 纯寒暄的 AI 回复 (只剩 "好的") → 返回 null 跳过写入

* **assistantMessage 默认开启** — v1 默认 false, v2 默认 true, 让 AI 回复也沉淀进记忆库 (importance × 0.8)

* **autoRecall 按 type 分组注入** — v1 是一个大文本块塞 4 条原文, v2 分三部分:
  * 【用户提问】· bullet 列表, 用 summary 而非原文
  * 【AI 回答】· bullet 列表
  * 【其他记忆】· bullet 列表
  * 引擎 recall 空 query 时自动优先有 summary 的条目 (ORDER BY CASE WHEN summary IS NOT NULL THEN 1 ELSE 0 END DESC)

#### 7.2 配置项变化

* ssistantMessage: false → true (默认开启)
* utoRecallLimit: 4 → 6 (按 type 分组后更紧凑, 可以多放)
* **新增** useSummarize: true — 规则提炼开关, 关掉就退回 v1 原文模式

#### 7.3 修改文件清单

* plugins/dsh-memory/engine/zuzong_memory.py — 版本 1.0.0 → 2.0.0
  * _init_db() — 加 ALTER TABLE 增量迁移 + type 索引
  * _tool_remember() — 接受 summary + type 可选参数, 白名单校验 type
  * _tool_recall() — 空 query 时优先有 summary 的, 有 query 时同时搜 content + summary, 返回 display 字段 (优先 summary)
  * _tool_timeline() — 同样优先有 summary 的
  * _tool_search() — 同时搜 content + summary, 返回新字段
  * _tool_service_info() — 版本号 + summarized_count 统计
  * _tool_list_all() — 返回 summary + type
* plugins/dsh-memory/lib/hooks.js
  * 新增 uleSummarize(text, kind) 规则提炼函数 (~60 行)
  * session/event 三个分支都加 summary + type 写入, 根据 opts.useSummarize 开关
  * autoRecall 改为解析 recall JSON → 按 type 分组 → 用 display 优先 summary → 结构化注入
* plugins/dsh-memory/lib/index.js — Config 默认值 + useSummarize 新配置

#### 7.4 关键坑

* **pnpm workspace 硬链接** — 改源码 plugins/dsh-memory/ 下的文件, 运行时 node_modules/ 里自动同步 (MD5 一致), 不需要手动复制。这是 pnpm 的特性, 不是 bug。

* **旧数据库增量迁移** — 不要 DROP TABLE 重建, 用 ALTER TABLE ADD COLUMN, 旧数据 type='raw' + summary=null 保持可用。引擎层 _init_db 每次启动都会检查列是否存在并自动迁移。

* **纯寒暄 AI 回复跳过写入** — 用户发 "好的" 或 AI 回 "好的" 这种没实质内容的, ruleSummarize 返回 null, hooks.js 检测到后 return, 不进数据库。

* **recall 空 query 的排序逻辑** — 引擎层用 CASE WHEN summary IS NOT NULL AND summary != '' THEN 1 ELSE 0 END DESC, 再按 importance DESC, 再按 created_at DESC。保证有摘要的 > 重要的 > 新的。
