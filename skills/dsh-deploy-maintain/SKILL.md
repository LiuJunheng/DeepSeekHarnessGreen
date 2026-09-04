***

name: dsh-deploy-maintain
description: "DeepSeek Harness 绿色整合版启动器的部署、日常维护、插件开发与避坑经验。覆盖便携 Node/dsh 安装、环境变量重定向、工作区 ACL 沙箱、更新备份、插件管理与 dsh 插件双端加载/路由注册等全套实操知识。"
updated: "2026-09-02"
---------------------

# DeepSeek Harness 绿色整合版 · 部署维护与插件开发

> 本 Skill 沉淀自 `DeepSeekHarnessLauncher` 项目（Python tkinter 绿色整合版启动器 + 内置插件）的实测经验，只记录对日后部署/维护/插件开发有复用价值的内容：机制、避坑、约定。不存档开发过程与时间线。
> 文档分流：README = 使用者文档；根项目 DEV\_NOTES.md = 开发者/发布者文档（本项目现行权威）；本 Skill = 可操作经验速查。改经验相关逻辑时同步更新本 Skill 与 DEV\_NOTES。

## 一、适用场景

- **部署**：在任意 Windows/Linux 机器搭建 dsh（DeepSeek Harness）绿色整合环境——便携 Node + 本地安装 dsh + 数据全落程序目录，不污染用户主目录、不装系统 Python/Node。

- **维护**：检查/更新 dsh（先备份后重装）、可视化插件管理（搜索/安装/移除/本地文件夹安装）、数据维护（永久删除/恢复归档会话，官方无此能力）、绿色版自更新（双通道）。

- **插件开发**：开发双端加载的 dsh 插件（宿主端路由 + WebUI 客户端入口），排查"服务端在、客户端不显示 / 路由 404/405 / 装了不生效"等经典故障。

- 配套：`python-tkinter-desktop-dev`（tkinter GUI 通用规范）、`trae-skill-creation`（Skill 打包规范）。

## 二、绿色整合部署核心机制

### 2.1 总体架构

```
程序根目录（BASE_DIR，可整目录拷走）
├── launcher.py            # Python 启动器（GUI/CLI）
├── start.bat / stop.bat   # ASCII + CRLF 编码的 .bat 入口
├── desktop-shell.py       # 内置桌面壳（pywebview / WebView2，见 4.16）
├── build_exe.bat          # PyInstaller 打包 DSH_Launcher.exe
├── config.json            # 镜像/端口/default_workspace 等
├── plugins/               # 内置插件源码
└── runtime/               # 全部运行时数据（绿色整合核心）
    ├── node/              # 便携 Node
    ├── dsh/               # @deepseek-ai/dsh 本体
    ├── dsh-home/          # DSH_HOME：会话/配置/存储
    ├── npm-cache/ pnpm-home/ pnpm-store/ tmp/
    └── python/            # 内置便携 Python + PyInstaller
```

### 2.2 便携 Node 与 dsh 安装（关键路径差异）

- **Node 二进制**：国内走 `https://registry.npmmirror.com/-/binary/node/...`，官方走 `https://nodejs.org/dist/...`。注意二进制下载与 npm 包注册表是**两个不同镜像路径**。

- **便携 Node 自带 npm 位置分平台，必须两个都探测**：Windows zip `node_modules/npm/bin/npm-cli.js`（node.exe 在顶层）；Linux/Mac tar.gz `lib/node_modules/npm/bin/npm-cli.js`。

- **dsh bin 入口**：`node_modules/@deepseek-ai/dsh/lib/bin.js`（不是顶层 `bin/`）。启动/插件管理必须用便携 `node.exe` + 此 `lib/bin.js` 直接调用；**别依赖** **`node_modules/.bin/dsh.cmd`**（.cmd 回退分支会调 PATH 里的系统 node，便携/系统搞混）。

- **镜像附** **`--registry`**：`resolve_mirror()` 返回 `("cn", True)` 时附加 `--registry`；auto 模式的 npm install 不会自动挂 registry（看 config 是否需要改 cn）。

- **npm 安装"没输出=像卡死"的真因是 npm 而非显示端**：npm stdout 非 TTY（管道）时默认日志级别 `notice` 会抑制逐包下载输出，只打印完 `added N packages`。**必须给安装命令加** **`--loglevel=http`**（每个包下载实时吐一行，量平稳）；`--loglevel=verbose` 反而刷爆 GUI。且 metada 抓取完进入 reify（纯本地 I/O 无网络）阶段 http 级别又静默 → 再配 `_stream_subprocess(heartbeat_interval=60)` 空闲心跳（子进程仍运行且超时无新输出则自打 `[进度]...`）。**网络阶段看 npm http 日志，纯 I/O 阶段看心跳，两招配合最稳**。

### 2.3 环境变量重定向（build\_env，绿色整合的命根子）

| 变量                      | 落点                       | 作用                           |
| ----------------------- | ------------------------ | ---------------------------- |
| `DSH_HOME`              | `runtime/dsh-home`       | 会话/配置/存储（**不设则写用户主目录，破坏便携**） |
| `npm_config_cache`      | `runtime/npm-cache`      | 下载缓存（否则写 `~/.npm`）           |
| `npm_config_userconfig` | `runtime/npm-userconfig` | 阻断读写 `~/.npmrc`              |
| `PNPM_HOME`             | `runtime/pnpm-home`      | pnpm 全局（dsh 插件管理依赖）          |
| `npm_config_store_dir`  | `runtime/pnpm-store`     | pnpm 内容寻址存储                  |
| `TEMP`/`TMP`            | `runtime/tmp`            | 进程临时目录（与 ACL 沙箱相关，见 2.5）     |

### 2.4 服务启动与进程管理

- **启动**：`node <dsh>/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3080 [--no-open]`。

- **【严重】stdin 必须保持打开**：`Popen` 未指定 `stdin` 时继承父进程 stdin；在 .bat/守护/无 TTY 下 stdin 是 EOF，dsh 检测到后约 40 秒静默退出，网页报 "Failed to fetch"。修法：`Popen(..., stdin=subprocess.PIPE)`。

- **接管界面必须加** **`--no-open`**：官方 `dsh-web-app` 服务就绪后默认自动打开系统默认浏览器（`openBrowser` 默认 true）。启动器统一 `open_ui` 接管打开时，务必在启动命令末尾加 `--no-open`，否则"官方浏览器 + 自己开的界面"双开。通用方法：只要启动器接管打开界面，先列全所有会启动界面的地方，逐个确认。

- **就绪检测**：后台线程 socket 轮询端口，就绪后 `webbrowser.open`。CLI 模式要**同步** `wait_ready()`（daemon 线程会随主进程退出消失）。

- **冷启动重复检测**：PID 文件（`runtime/server.pid`）+ 进程存在判断。排查端口监听用 `grep -w 3080`（`grep 3080` 误匹配 `13080`）。

- **启动前自动清理孤儿 dsh 进程**：手动/残留的 dsh 进程占 3080 时新进程起不来还误报"已就绪"。`start_server()` 在判断已有进程之后、启动新进程之前，用 `_find_port_owner(port)`（`Get-NetTCPConnection -LocalPort -State Listen`→`Get-CimInstance Win32_Process`）+ `_cleanup_orphan_dsh(port)` 校验进程名含 `node` 且命令行含 `bin.js web --port`（**绝不误杀普通程序**）才 `taskkill /F /PID`，再 `_wait_port_free` 兜底轮询。

- **【高发】新版 dsh web 认证（0.1.2-alpha.2+，界面显示 "dsh web authentication required"）**：client-connection 首次访问要求认证，启动时打印带一次性 `?token=<launchToken>` 的 URL，打开它才签发 30 天 Cookie；直接开裸地址 401。launcher 从 server.log **最新启动块**解析 token（`_read_launch_token`）+ 拼认证地址（`_web_auth_url`，`/` 不能省）→ `open_ui`/`wait_and_open`/`launch_desktop_shell`（`--url` 传桌面壳）统一用。**两个坑**：① **竞态**——dsh 先绑端口、插件树加载完才打印 token，`_web_auth_url` 在端口已监听时最多短等 8s（`wait_and_open` 必须先 `wait_ready` 再解析地址）；② **改 launcher.py 必须重打包 exe**，否则旧 exe 开裸地址必然 401、误判"启动失败"。

### 2.5 工作区与 ACL 沙箱（Windows 专属大坑）

- **机制**：dsh 要求临时根目录不能位于会话工作区内部，否则 shell 工具报 `Windows ACL temp root must be outside the workspace`。

- **三层概念要分清**：

  1. 会话**工作区归属固化**在日志 header 的 `cwd` 字段，一经创建不可改（旧会话换不了工作区，只能归档/删除/开新会话）。
  2. `workspace.json` 只是**工作区注册表**（`{path,title,sessionIds,...}` + `archivedSessionIds` + 顺序 `workspaceIds`），不是会话配置。
  3. 沙箱判定读 `session.header.cwd`：cwd 是子目录的会话 ACL 通过；cwd 是程序根目录（内含 runtime/tmp）的老会话报冲突。

- **自动解析（不写死）**：`workspace_conflicts_with_tmp(path)` 用 `os.path.commonpath` 判"临时目录是否为工作区严格子路径"（不同盘符 `ValueError` 按不冲突）；`resolve_default_workspace()` 优先级 = ① config `default_workspace` 显式值（冲突警告回退）→ ② 根目录不冲突用根目录 → ③ 冲突才取 `BASE_DIR/workspace`。

### 2.6 exe 打包（PyInstaller）

- **onefile 下** **`__file__`** **不可作程序根目录**（指向 `_MEIPASS`）。`get_base_dir()` = `getattr(sys,"frozen",False)` 时取 `os.path.dirname(sys.executable)`，否则脚本目录。

- **必须显式补齐全套 VC 运行库三件套**：`--add-binary vcruntime140.dll/vcruntime140_1.dll/vcruntime140_threads.dll;.`，否则目标机 `Failed to load Python DLL ... 找不到指定的模块`。诊断：`pyi-archive_viewer -l DSH_Launcher.exe` 过滤 `vcruntime|python310`；单 DLL 依赖用 PE 导入表解析。

- **内置便携 Python**：python-build-standalone 解压后有**顶层子目录**（`runtime/python/python/python.exe`），`find_python_exe()` 必须"先查顶层，再遍历一层子目录"兼容两种布局。

- **校验用便携 python，别用系统 python**：系统可能是 2.7（`nonlocal` 误报语法错）。统一 `runtime\python\python\python.exe -m py_compile` 或 `py -3`。

- **重新打包纪律**：改 `launcher.py`（含 `GREEN_VERSION` 版本号）或 `update_agent.py` 后**必须**重打包 exe（`build_exe.bat`），否则用户跑旧 exe（"界面改了没反应" / "运行时版本比 Release tag 低一级" 十有八九是旧 exe）。发布脚本 `根目录 release_upload.py` v3.0+ 已强制校验 exe 新鲜度：打包前先比 mtime（exe 必须 >= launcher.py），再跑 `DSH_Launcher.exe --print-green-version` 对比源码版本，任一失败直接 exit(2) 阻断打包并提示先重跑 `build_exe.bat`。

## 三、日常维护

### 3.1 检查更新（备份优先 / 双数据源动态检测）

- **"装了就永远最新"是错觉**：`prepare_dsh()` 只缺失时安装；同步更新的唯一途径是强制重装。

- **候选收集与展示**（2026-09-03 v1.0.28 重构）：
  - **数据源**：`dsh_github_releases()`（分页拉全部 tag，`_dsh_tag_to_version()` 兼容 `dsh-v`/`v`/裸版本号）+ `dsh_npm_versions()`（npm 全量版本判断某 tag 是否可安装）。npm dist-tags 的 latest/next 也作为候选来源。
  - **不过滤新旧**：旧版有 `_green_version_greater()` 过滤"只保留比当前新的"——反模式，用户可能想降级/切通道/锁旧版，全部过滤会"没版本可选"。**正确做法**：不过滤新旧，只去重。
  - **版本比较（semver 正确实现）**：`_green_version_tuple()` 返回五元组 `(major, minor, patch, pre_rank, pre_number)`，pre_rank 映射 alpha=0, beta=1, rc=2, 无标记(正式版)=3。**不能**用 `re.split(r"[^\d]+", ...)` 纯拆数字——`alpha.5→(0,1,2,5)` vs `rc.1→(0,1,2,1)` 会误判 rc.1 < alpha.5。详见 DEV\_NOTES 坑列表"版本比较的 semver 陷阱"。
  - **npm dist-tag 两条独立通道**：latest（稳定正式版）和 next（预发布/rc/alpha）不应该混在一起比"谁更新"。GUI 按通道分组展示：① stable（npm latest）→ ② prerelease（npm next + GitHub prerelease）→ ③ history（GitHub 正式历史版）。每个通道内版本号从新到旧排序。
  - **当前版本标记**：绿色 + "(当前)" 高亮，让用户清楚自己在哪。灰色标记"未发布到 npm，无法自动安装"。按钮文案「安装选中版本」（可能是降级或切通道），不是「确认升级」。
  - **设计原则**：版本管理是用户的选择，不是启动器的过滤器。
  - **查询避坑**：`dist-tags --json` 必须拆成独立 argv（`query.split()`），整串当单参数会用法错误返回 None；npm view 的 registry 要与安装一致。

- `update_dsh(target)` 顺序 = 备份 → **备份成功后才**强制重装目标版本（否则"旧版被覆盖又没装上"丢数据）。备份目录不自动清理，用户手动管理。

- **升级后自愈（根治"升级后插件树起不来"）**：`update_dsh` 成功后自动执行 `_heal_after_core_upgrade` 四步——① `_remove_incompatible_bundles` 移除黑名单 `UPGRADE_INCOMPATIBLE_BUNDLES`(dshmarket)＋历史启动日志/探针日志定位到的不兼容 bundle（`_extract_bundle_from_log`：日志含关键字 `does not provide an export`/`is not in cache`/`ERR_MODULE_NOT_FOUND`/`Cannot find package`/`SyntaxError` 且堆栈路径命中 profile 的 bundles+dependencies，内置 bundle 不在 dependencies 永不误删）；② `_heal_profile_dependencies` 补宿主核心声明的 peer 依赖（`autoInstallPeers:false` 下 pnpm 不自动装，缺了报 `not in cache`）＋把 profile 与 file: 本地插件的核心依赖版本同步到宿主已装版本；③ `_rebuild_dependency_tree` 便携 pnpm `install --force --no-frozen-lockfile` 强制重建（复用 BOM 清理＋allowBuilds 补丁）；④ `_smoke_verify_core_upgrade` 独立子进程冒烟启动验证端口监听，失败再定位 1 个不兼容 bundle 移除重建重试（最多 2 轮，每轮只删 1 个防误删）。服务运行中跳过冒烟；任一步失败仅记警告不阻断更新成功返回。

- 安装主体抽成 `install_dsh(package_spec)`，`prepare_dsh(force, package_spec)` 只做"缺失则装 / 强制重装"分支，首装与更新共用。

### 3.2 插件管理（dsh plugin 依赖 pnpm）

- `dsh plugin --profile <name> <pnpm 参数>` 内部转发 pnpm 管理该 profile；**已装清单 = 读 profile 的 package.json**，无需调查询接口。

- **pnpm 必须装进便携 runtime**：`install -g pnpm --prefix runtime/pnpm-home` 并加 PATH；**`pnpm --version`** **裸跑失败（退出码 1）**——pnpm.cmd 内部要调 node，必须在含便携 node 的 PATH 下运行。

- **本地插件安装**：`os.path.isdir(spec)` 为真自动归一化为 `file:<绝对路径>` 交给 pnpm。**pnpm 对** **`file:`** **是拷贝非软链**，改 `plugins/` 源码必须重装才同步。

- **内置插件批量安装**：`bundled_plugin_dirs()` 动态扫描 `plugins/` 下含 package.json 的子目录（不硬编码名单）；`install_bundled_plugins()` 用 `file:` 批量装，已装跳过、单个失败不中断；`prepare_all()` 在 `prepare_dsh()` 后自动调用（幂等）。

- **搜索源**：npm 注册表 `/-/v1/search?text=dsh-plugin` + GitHub topic 页。`keywords:dsh-plugin` 在 npmmirror 返回 0，用 `text=<关键词>` + 本地过滤最稳。

- **GUI 线程安全**：耗时操作在 `threading.Thread`，结果 `root.after(0, ...)` 回主线程；忙时禁用按钮防重入。`ttk.Panedwindow` 必须 `.add(child, weight=N)` 显式注册（否则空白）。

- **"包装上了但没生效"根因：pnpm 非 0 退出码跳过官方 reconcile**：pnpm 遇到 `ERR_PNPM_IGNORED_BUILDS`（含原生模块/构建脚本依赖：ssh2/node-pty/cloudflared 等）以退出码 1 结束（包已写 dependencies），而官方 reconcile（把声明 `dsh.bundle.patch` 的包写进 `dsh.profile.bundles`）**只在 exitCode===0 运行** → 被打断 → 编排层没有它。**排查顺序**：① 看 `dsh.profile.bundles` 是否含该包（不是 dependencies/node\_modules）；② 设 DSH\_HOME 后 dump-config 看插件层；③ 有则重装/手动 reconcile。

- **启动器兜底** **`reconcile_bundles()`**：任何插件安装/移除/启停后扫描 dependencies 把声明 bundle 且未停用的写进 bundles，清除不再声明的；**内置 bundle（dsh-base/dsh-web-app）不在 dependencies 里，永不触碰**。`run_plugin_command` 每次命令后兜底。

- **启用/停用开关**：停用 = 从 bundles 移除 + 写 `dsh.profile.disabled` 数组；**官方 reconcile 不识别 disabled 列表**会把停用包加回 → launcher 每次命令后重放停用状态。启停后重启服务生效。

- **pnpm 构建白名单已自动化**：`ensure_pnpm_native_allowbuilds`（补原生依赖 `false`）+ `auto_allow_git_build`（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 时从报错提取含完整 commit hash 的 URL→`pnpm-workspace.yaml` 的 `allowBuilds: true` 并重试，幂等）。**绿色版 zip 不含 runtime/，此补丁必须在启动器内自动做**。

### 3.3 数据维护（会话恢复 / 永久删除，官方无此能力）

- **dsh 没有"永久删除/取消归档"接口**：网页"归档"只是把会话隐藏（日志 + 注册表全保留）。

- **彻底删除需服务停止后直接操作数据，三处一并清理**：① `sessions/<编码>/<ID>/` 日志目录（只按 id 遍历查找，**不拼接用户输入进路径，防路径穿越**）；② `workspace.json` 的 `sessionIds`/`archivedSessionIds`；③ projcache 缓存（DSH 0.1.2-rc.1+ 分文件 `sessions/session-{uuid}.json`，旧版单文件 `session_projcache.json`）。

- **复原（取消归档）= 只把 id 从 archivedSessionIds 移除并原子写回**——日志/归属/缓存 dsh 从没动过，天然无损。与 `purge_session` 完全相反。

- JSON 写回用原子写（同目录临时 + `os.replace`）。GUI「会话管理」弹窗：Treeview 多选 +「恢复选中 (N)」/「删除选中 (N)」，均二次确认；GPU 承担全部删除/恢复（实际启动时服务运行中，WebUI 删不了）。

- **隔离测试**：复制真实 workspace.json 到副本 + monkeypatch `DSH_HOME_DIR`，不碰真实数据。

### 3.4 绿色版自更新（双通道）

分发给用户后两条**完全独立**的更新通道，互不干扰三保证：① 数据/环境隔离（核心只动 `runtime/dsh`，外围只动根目录）；② 外围覆盖跳过 `config.json`（用户配置）与 `runtime/`（数据+环境）；③ 两套独立查询接口与按钮。

- **通道①官方核心**：更新 `runtime/dsh/` 的 dsh npm 包（即 3.1）。

- **通道②绿色版外围**：更新根目录 launcher.py/exe/plugins/文档，从双平台 Release 获取（GUI「检查绿色版更新」）。

- **版本追踪**：`GREEN_VERSION` 常量为**唯一来源**；`green_local_version()` 只在用户 `config.json` **显式写了** **`green_version`** **字段**时才覆盖（读原始配置文件，不走合并默认值）。版本号对比用**正确的 semver 五元组**（`_green_version_tuple()`），见 3.1。

  > **坑**：版本默认值**绝不能**写进 `DEFAULT_CONFIG`（曾导致本地恒显示旧版、反复提示更新）。版本相关默认值单点放 GREEN\_VERSION。

- **查询与下载跟随下载源分流**：`config.mirror` 为 `cn`（含 auto）时**先走 Gitee**，失败回退 GitHub→国内镜像；为 `official` 时 GitHub 优先、Gitee 兜底。返回值带 `source`（github/gitee/gitee\_release）。

- **Gitee 通道两级策略**：① 先查 Gitee Release（`GITEE_RELEASES_API` 公开读），取"最新且带手动 zip 附件"（过滤：名 `.zip` 结尾 **且** URL 含 `/releases/download/`，防误选 `archive/refs/tags/...` 挑战页源码包）→ `source="gitee_release"` 走 zip 直连下载（**手动附件直连返回真 zip**）；② 无发布版才回退 `source="gitee"` 整仓快照（无 Release）。

- **Gitee 整仓快照**：版本号读 `gitee.com/<repo>/raw/master/launcher.py` 的 `GREEN_VERSION` 正则提取；下载走 **git 智能 HTTP 协议克隆整仓**（`green_gitee_clone_tree`：`info/refs?service=git-upload-pack`→`git-upload-pack` 拉 pack→解析 delta 落盘，只依赖标准库）。整仓 zip 实际是 JS 挑战页拿不到，纯 urllib 模拟不行。asset `size=0` 时跳过大小校验；覆盖时 `always_skipped_names=("DEV_NOTES.md",".gitignore")` 统一跳过开发侧文件。

- **下载兜底必须覆盖"实际下载"步骤**："api.github.com 可达查得到版本、但 releases/download 大文件流被墙"是典型现象 → GitHub 下载包 try/except，异常后转 Gitee 重下；加**防降级**（Gitee 版本号低于目标则放弃切换）；成功后改写 `release_info["source"]`，调用方**在** **`prepare_update_content_root`** **之后再取 source**（保证失败提示与真实来源一致）。

- **独立更新程序** **`DSH_Update.exe`（替代 update\_apply.bat）**：启动器自身 exe 被 Windows 锁定无法自替换。流程：下载解压新版 zip + 写 `runtime/update/update_job.json`（含 base\_dir/content\_root/backup\_dir/relaunch\_mode/new\_version/手动地址）→ 以 `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` 启动 `DSH_Update.exe --apply <job>` 并退出本体（兜底：无 exe 用内置 python 跑 `update_agent.py`）。更新程序：**自我复制到** **`runtime/tmp/DSH_Update_worker.exe`** **从副本运行**（释放根目录更新程序文件锁）→ 轮询 exe 文件锁等本体退出（`_can_open_write` 试探，**不轮询 PID**）→ 备份到 `runtime/update/backup/` → `shutil.copy2` 逐个覆盖（跳过 config.json/runtime/.git）→ 重启。失败弹窗给出手动下载地址；全程 tkinter 进度窗口。

- **关键避坑（独立更新程序）**：① 迁移判定用 `os.path.normcase` 比较绝对路径，仅"自身就是根目录更新程序"才迁移，副本二次运行直接正常覆盖，**不能无限复制**；② DSH\_Update.exe 内嵌 python，打包须带 VC\_BINARIES 三件套；③ 用 copy2 比 robocopy 可控（失败能定位具体文件）。

- **发布 Release 中文编码坑**：Windows PowerShell 5.1 会把"无 BOM 的 UTF-8 .ps1"按系统 ANSI(GBK) 读取——脚本里写的中文字面量在内存已乱码，后面怎么编码都救不回。**正确做法**：发布脚本保持**纯 ASCII**，中文正文单独放 UTF-8 文件用 `[IO.File]::ReadAllText(path, UTF8)` 显式读取；校验用 python 而非 PS `-match "中文"`。

- **绿色 zip 顶层清单要维护两处（打包** **`GREEN_TOP_FILES`** **+ verify 期望** **`expect_top`）**：漏一处会导致新机对应文件缺失但本地不报错（曾漏 desktop-shell.py）。新增/同步顶层文件必须两处都改；**建议收敛 verify 从 GREEN\_TOP\_FILES/GREEN\_TOP\_DIRS 派生期望**，从根上消灭清单不一致。

- **zip 打包命令传目录名**：打包 `plugins`/`skills` 要传**目录名**（zip 内保留前缀）；不能传子路径（会把插件目录打在 zip 根、覆盖时错位拷到程序根）。打包后 `tar -tf` 复核。更新侧 `_normalize_update_structure()` 解压后把错位的 `dsh-*` 归位 + 清理根目录残留。

- **在线发布页（GitHub Pages）**：`pages/`（纯静态：`index.html` + `assets/app.js` + `assets/style.css`）+ `.github/workflows/pages.yml` 自动部署到 `https://<owner>.github.io/<repo>/`。机制：`push master (path: pages)` 上传 `upload-pages-artifact` 构建 → `deploy-pages` 发布，可 `workflow_dispatch` 手动触发。经验：发布页动画（如 Canvas 水纹背景）**纯本地渲染、遵循** **`prefers-reduced-motion`**，无 Canvas/被禁用时静默跳过，`pointer-events:none` + `z-index` 归位不拦截交互；读版本号用 `GREEN_VERSION` 正则从 `raw launcher.py` 提取（与 Gitee 整仓快照同源）。日期纪律：发布页/文档里的版本日期必须是制作当天，不预写未来日期。

### 3.5 会话回退（dsh-session-rewind 插件）

- **背景**：工具运行时失效（`Cannot read properties of undefined (reading 'prepare')`）崩溃留下孤儿 `tool_calls`，之后每轮被 API 400 拒绝，会话**永久毒化**；官方无"删除失败消息"功能。

- **方案**：WebUI「会话回退」页 → 分析会话 → 在**已完成**回合「回退到此」走官方 `session.fork`（`{sessionId, atSeq}`）派生干净续接会话并自动打开；原会话不动。

- **为什么派生而非原地删消息**：服务运行时持久化层内存缓存，原地改磁盘日志会被内存状态覆盖或 seq 断裂；`session.fork` 是官方为此设计的机制（官方 UI 只暴露末位回合，插件放开到任意回合）。

- **fork 边界语义限制**：边界 =「≥ atSeq 的第一个 turn/end」，只能整回合切，**切不出**"历史+提问、无回答"。

- **配套 tools/**：`rewind-session.mjs`（服务停止时的离线原地截断回退，自动备份）、`apply-agentloop-guard.mjs`（工具派发加存在性检查，把晦涩报错变明确提示，幂等）。

- 排查"会话突然全部 400"：看 server.log 有无该签名 → 分析定位崩溃回合 → 在之前**已完成**回合回退派生。

## 四、GUI 启动器要点（tkinter）

- **X 二次确认 + 最小化**：`root.protocol("WM_DELETE_WINDOW", on_close)` 二次确认；最小化到任务栏（图标保留），托盘从启动就常驻，双入口始终可见（用户易误判程序退出）。绿色版自更新传 `confirm=False` 跳过询问。

- **托盘（纯 ctypes + Win32，零依赖）**：`Shell_NotifyIconW` 加删图标；`SetWindowLongPtrW` 子类化窗口过程拦截 `WM_SYSCOMMAND/SC_MINIMIZE` 与自定 `WM_TRAY_CALLBACK`。**关键避坑**：窗口过程挂钩必须在 `__init__` 装（别放 add()，否则第一次最小化漏拦截）；`winfo_id()` 返回 Tk 内部子窗口，须先 `update_idletasks()` 再 `GetAncestor(GA_ROOT)` + 显式 `argtypes/restype=c_ssize_t` 拿真实顶层 HWND；**WndProc 回调里绝不能直接调 Tk**（重入 Tcl 崩溃）→ 只置布尔标志 + `root.after(80,...)` 轮询消费；`--windowed` 下 `sys.stderr=None`，回调内不输出 + 全程 try/except；`remove()` 只删图标不还原窗口过程，退出才 `dispose()`。

- **单实例**：`CreateMutexW` 命名互斥量，句柄由实例**整个生命周期持有**（否则 GC 释放后互斥量消失）；`GetLastError()==183` 即已有实例 → `FindWindowW` + `ShowWindow(SW_RESTORE)` + `SetForegroundWindow` + `BringWindowToTop`。窗口标题常量化（查找创建共用同一 WINDOW\_TITLE）。CLI 命令模式不建互斥量。

- **自定义图标（窗口+托盘+exe 统一）**：`get_icon_path()`（frozen 从 `_MEIPASS` 取，否则根目录，找不到 None）。窗口 `iconbitmap`；托盘 `LoadImageW` 从 .ico 加载 HICON；exe 加 `--icon` + `--add-data`。**避坑**：`--add-data` 源路径按 **spec 目录**解析，必须写绝对路径 `%~dp0...`；`--icon` 按当前目录解析可直接相对。ICO 保存用 `image.save(format="ICO", sizes=[...])`，**别用 append\_images 手动塞帧**（得到几百字节空壳）。

- **"待保存"设置 vs 已落盘 config 脱节**：tkinter 下拉/条目是内存"待保存"值。启动类动作（如点启动服务）前，先把界面当前值同步进 config 并 `save_config()` 落盘（转换规则与「保存设置」一致、静默）。收敛到单一 `sync_gui(silent=False)` 函数，保存/on\_start/on\_install 三处共用，防三处逻辑漂移。

- **语言提示**：`.bat` 保持 ASCII 全英文；desktop-shell 相关提示语用英文（中文乱码）。

- 涉及图标/托盘/单实例的通用经验可另参考 `python-tkinter-desktop-dev` Skill。

## 五、DSH 插件开发（双端加载 + 路由注册）

### 5.0 Cordis 插件协议核心约束（必须先记住，否则装完服务直接炸）

五条硬约束，踩任何一条都会导致"装完插件服务起不来"：

| # | 约束                                                        | 违反症状                                                                                    | 正确写法                                                                |
| - | --------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 1 | **宿主端导出函数名必须是 apply**                                     | `invalid plugin, expect function or object with an "apply" method, received object`     | `export async function apply(ctx, config)`                          |
| 2 | **纯客户端插件也必须带宿主端 lib/index.js**                            | `ERR_MODULE_NOT_FOUND: ...lib/index.js` 服务启动即退出                                         | 纯客户端用官方 no-op: `function apply() {}; export { apply }`              |
| 3 | **exports 必须包含** **`"./package.json": "./package.json"`** | 客户端 bundle 跳过 → WebUI 入口不出现                                                             | 检查 package.json exports 字段                                          |
| 4 | **files 数组必须包含 cordis.patch.yml**                         | pnpm 安装时文件被排除 → 插件树注册失败                                                                 | `files: ["lib", "cordis.patch.yml"]`                                |
| 5 | **name 字段与目录名一致**                                         | 包名/目录名对不上时 pnpm 安装可能出问题                                                                 | 目录 `dsh-rules/` → package.json `name: "dsh-rules"`                  |
| 6 | **纯 hook 插件 package.json 不能写** **`dsh.client`**           | `client-modules: dsh-xxx declares dsh.client but exports no "./client" bundle` → 服务启动崩溃 | 只有带 WebUI 的"类型 A"插件才声明 `dsh.client`；纯 hook 插件只声明 `dsh.bundle.patch` |

**导出契约完整版**（所有插件都应遵守）：

```javascript
import z from '@deepseek-ai/schemastery';  // 可选
import '@deepseek-ai/dsh-system-prompt';   // 纯 hook 插件必需

export const name = 'dsh-xxx';         // 插件名, 与目录一致
export const inject = ['webServer'];    // 按需声明依赖服务, 纯 hook 可空 []
export const Config = z.object({...});  // 可选: schemastery 配置 schema
export async function apply(ctx, config) { ... }  // 必须叫 apply, 可用 async
// package.json 的 dsh.client 块: 只有带 WebUI 的"类型 A"插件才写
// 纯 hook 插件 (类型 B) 不要写 dsh.client, 否则客户端模块注册表会去找 ./client export
```

完整检查清单见 `checklists/plugin-dev-checklist.md` 零节；代码骨架见 `references/plugin-skeleton.md`。

### 5.1 插件 = npm 包 + 双入口（最容易漏）

- **`dsh.bundle.patch`** → 指向 `cordis.patch.yml`（`- insert: [{id, name}]` 把插件作为一行插入 profile 插件树）。`dsh plugin add` reconcile 据此写进 `dsh.profile.bundles`；服务启动时 `dsh-app-boot` 的 `loadProfile` 按序合成 **bundle 补丁 → 用户 cordis.patch.yml → --patch 覆盖层**。

- **`dsh.client`** → 声明 WebUI 客户端入口（`inject` + `platform: "web"`），由 `dsh-client-modules` 扫描注入。

- **`files`** **数组必须包含** **`cordis.patch.yml`**（否则命令/安装后文件缺失）。

- **只声明** **`dsh.client`** **不会进插件树**；只声明 bundle 没 client 则宿主加载但 WebUI 无入口。

### 5.2 客户端 `exports` 必须导出 `./package.json`（高优先级坑）

- **现象**：已装进 bundles、dump-config 树合成、服务正常，但 WebUI 入口死活不出现。

- **根因**：`ClientModuleRegistry.resolveMeta()` 用 `require.resolve("<插件>/package.json")` 扫描；`exports` 漏 `./package.json` 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED` → 该插件被跳过 → 不进 `__DSH_BOOT__`。服务端 `resolveBundleDir` 不受 exports 限制 → "服务端在、客户端不在"假象。

- **修复**：`exports` 保留 `"./package.json": "./package.json"`，重新安装 + 重启服务。

- **排查顺序**：① 首页源码看 `window.__DSH_BOOT__.entries`；② `node -e "require.resolve('<插件>/package.json')"`。

### 5.3 宿主端路由注册：`ctx.effect` 的正确用法

- **错误写法**：`const disposer = ctx.webServer.register({...}); ctx.effect(disposer, "...");` —— `ctx.effect(fn)` 立即执行 `fn()` 并把**返回值**当清理函数 → 注册刚进表又被删 → 非 GET 3005 fallback（405）。

- **正确写法**：

  ```js
  ctx.effect(() => ctx.webServer.register({ kind, path, handler }), "label");
  ```

  把注册包进回调，register 返回值（注销函数）正是 `fn()` 返回值。

- **405 语义**：内置 web server 先匹配 exact 表再 prefixes，未命中落 `frontend-static` fallback（非 GET/HEAD 返回 405）。405 = 插件路由根本没在 exact 表里。

- **404 语义（`webServer.register`** **无** **`method`** **字段，同一 path 只能注册一次）**：想分 GET/POST 必须在**同一 handler 按** **`req.method`** **分流**；对同 path 注册两条抛 "Duplicate (kind,path)" → 整个插件 fiber 回滚、**所有**路由失效（不止 POST）→ 客户端全 404。排查"路由注册了却 404"三步：① 是否同 (kind,path) 注册两条；② `__DSH_BOOT__.entries` 有该插件 client 条目、`curl /plugins/<id>/client.js` 能 200；③ 若是 `settings.section` 注册——它生成的是**侧边栏导航行**（按 order 排），不是顶栏独立标签，浏览器验证要滚动侧边栏找。

### 5.4 纯客户端插件也必须带宿主端 `lib/index.js`（缺失则服务起不来）

- **【严重】宿主 cordis loader 对 bundle 树**每个包都会 import 其 `main`/`exports["."]`，纯客户端插件也不例外。只放 `client.js` 时安装后重启服务**瞬间退出**，报 `ERR_MODULE_NOT_FOUND: ...lib/index.js`（plugin tree failed to load）。修法：放官方 no-op：

  ```js
  function apply() {}
  export { apply };
  ```

### 5.5 客户端加载器与官方扩展点

- 加载器契约 `window.__ModuleLoader__.load({ id, factory })`；`apply(ctx)` 里 `ctx.slots.inject("settings.section", ...)` 注册设置区块。

- **消息行两个官方插槽**（只做官方没有的，别重复官方已有能力）：

  - `conversation.chat.assistant-actions`：每条已完成助手的 IconActions 操作行，`owner={messageId}`，list 按 `order` 升序（官方 👍👎 用 10，第三方从 20 起）。

  - `conversation.chat.turnTail`：操作行**上方**内容区，chain——`select` 必填返回匹配值（全拒渲染空），`priority` 控选举；组件拿 `matched`+`useSession`。

- **读快照拿消息数据**：`useSession((s)=>s)` 的 `snapshot.nodes`（legacy，`kind:'assistant'`/`turn`/`usage`）与 `snapshot.chat.nodes.values()`（实时节点库，`data.finalNode` 等）双源；`finalNode.usage` 即事件原始 usage。**0.1.2+ 重构**：`useSession` 改返回 SessionSnapshot（生命周期），聊天数据走新 standard-kit hook **`useChat`**（`chat.legacy.nodes` / `chat.nodes` store）；兼容写法 `const data = useChat ? useChat(s=>s) : useSession(s=>s)` 再按两种形态取节点（官方 StatsLine = `useChat(s=>s.legacy.nodes)`）。

- **官方 0.1.2 新增（与统计插件不冲突）**：① **ContextMeter**（输入框右侧环形仪表）——当前会话**上下文窗口占用**（\~已用/窗口+系统/工具/消息三段，估算、无费用）；② 逐回合精确记账 `turn-tail` 节点 `data.tokenUsage`（`TurnTokenUsage`，含 routes 模型归属）——消息行"实际消耗"的最权威来源。本插件 = 实际计费 token + 费用估算 + 账户余额（账单视角），互补。

- **官方已原生覆盖、别重复做**：消息正文「复制」、回合尾「在新对话中分支」、悬停"用时/首 token/速率"、会话级 token 合计（官方 StatsLine，`useProjection("tokenUsage")`）。项目价值插件 = 官方没有的（清理/回退/统计）。

### 5.6 客户端 UI 通用坑

- **插槽条目组件不要条件调用 props 传入的 hook**（`typeof useXxx === "function" ? useXxx() : null`）→ React "Rendered more/fewer hooks" 被错误边界吞掉、组件不渲染（`data-slot-error` 空占位）。读快照优先用 ownerProps 里的普通字段（`ownerProps.input.draft`），hook 必须无条件调用。

- **宽数据用卡片式纵向布局**（标题独占整行 `wordBreak`、元信息 `flexWrap` chips），别用固定列宽横向表格（窄面板只显示半个字）。

- **自定义 keyframes 必须自己注入**（style 块加 `@keyframes`），否则引用了不存在的动画名不闪。

- **改客户端源码强刷页面即可生效**（bundle 按请求重新生成、rev 变化）；改宿主端/加减插件才需重启服务。

- **字符按钮（如** **`⌂`）部分字体渲染空白/方框** → 优先内联 SVG + 文字标签 + `title`。

- **媒体路由 + 防御头的矛盾**：`<img src>`/`<iframe src>`/`<a href>` 均带不上自定义头 → 预览/下载一律 `fetch(url,{headers:防御头})` → blob → `URL.createObjectURL` → 交给 `<img>`/下载 + 适时 `revokeObjectURL`。`showSaveFilePicker` 必须先弹框拿 handle 再 fetch 写回（异步丢焦点会拦截"需要用户手势"）。

### 5.7 主题自适应（内置插件）

> **踩过 3 轮坑才搞对，直接抄这个方案**。
>
> 踩坑史：① 全 CSS 变量但变量选得不对（`label-secondary` 配白底 = 灰糊）→ ② 硬编码白底 + CSS 变量字（背景不随主题切，深主题像白补丁）→ ③ **全部走 CSS 变量 + 选对变量名**（背景和文字一起切）→ 正确。

#### 核心原则

**背景和文字必须一起走 CSS 变量**，DSH 会自动根据 `data-theme="dark|light"` 切换值。绝对不要"背景硬编码 + 文字走变量"或反过来。

#### 变量速查表（抄 DSH 官方组件实际用的）

| 元素类型             | 正确变量                                                     | 说明                           |
| ---------------- | -------------------------------------------------------- | ---------------------------- |
| 卡片/面板背景          | `var(--dsw-alias-bg-base)`                               | 主面板底色，深浅主题自动切                |
| 输入框/TextInput 背景 | `var(--dsw-specific-input-major)`                        | **DSH 官方输入框专用**，深浅主题都做了对比度适配 |
| 主文字（标题、label）    | `var(--dsw-alias-label-primary)`                         | 深主题 = 亮，浅主题 = 深              |
| 次文字（hint、说明）     | `var(--dsw-alias-label-secondary)`                       | 比 primary 低一级，深主题下可读         |
| 辅助文字（非常淡）        | `var(--dsw-alias-label-tertiary)`                        | 用在"最近检测时间"这种                 |
| 边框               | `var(--dsw-alias-border-l2)`                             | 通用边框，深浅自动切换                  |
| 主按钮填充            | `var(--dsw-alias-button-info-fill)`                      | 品牌蓝，深浅不变                     |
| 幽灵按钮边框           | `var(--dsw-alias-border-l2)`                             | 配 transparent 背景             |
| 状态点-成功           | `var(--dsw-alias-state-success-primary)`                 | 绿                            |
| 状态点-错误           | `var(--dsw-alias-state-error-primary)`                   | 红                            |
| 业务色（chip/badge）  | `var(--dsw-alias-state-business-primary)` / `-secondary` | 蓝                            |
| 警告色（真警告）         | `var(--dsw-alias-state-warn-primary)`                    | 橙，只在真正警告场景用，别乱用              |

#### 唯一可接受的硬编码

按钮上的白字 `color: "#ffffff"` —— 配合 `--dsw-alias-button-info-fill` 填充色，这是设计规范内的对比度保证。其他任何地方都**不要硬编码颜色**。

#### 错误示范（千万别做）

```js
// ❌ 错误 1: 硬编码白底 + CSS 变量字（深主题下白底像补丁）
const card = { background: "#ffffff", color: "var(--dsw-alias-label-primary)" };

// ❌ 错误 2: 硬编码灰字（深浅主题都不变，深主题下糊）
const hint = { color: "#8a8f98" };

// ❌ 错误 3: 输入框背景用 bg-primary 而不是 specific-input-major（可能对比度不够）
const input = { background: "var(--dsw-alias-bg-primary)" };

// ❌ 错误 4: "运行中"状态用 warn 橙色（语义错误，运行中是正常不是警告）
const running = { color: "var(--dsw-alias-state-warn-primary)" };

// ✅ 正确: 背景 + 文字 + 边框全部变量
const card = { background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", border: "1px solid var(--dsw-alias-border-l2)" };
const input = { background: "var(--dsw-specific-input-major)", color: "var(--dsw-alias-label-primary)", border: "1px solid var(--dsw-alias-border-l2)" };
const running = { color: "var(--dsw-alias-state-success-primary)" };  // 运行中 = 绿
```

#### 设计语义速查

| 场景        | 正确颜色语义           | 别用             |
| --------- | ---------------- | -------------- |
| 运行中/在线状态  | success（绿）       | warn（橙，那是警告）   |
| 离线/错误     | error（红）         | success        |
| 信息提示横幅    | business（蓝）      | warn（橙，信息不是警告） |
| 真正危险/毒化提示 | warn（橙）          | 其他             |
| 模型名 chip  | business 蓝字（无背景） | 蓝底蓝字（同色系糊片）    |

#### 颜色对比度铁律（同色系 text + bg 必糊）

> 踩坑实录：先后在 dsh-market 橙色标签、dsh-usage-stats "运行中" 绿色 badge、dsh-memory "删除" 红按钮上翻了车——**任何** **`state-xxx-primary`（文字）配** **`state-xxx-secondary`（背景）都是同色系，深浅主题下都会糊成一片**，没有例外。

**绝对规则**：同一个状态色的 `primary`（主色）和 `secondary`（淡底色）**不能同时用**在同一个元素上——不管深浅主题，对比度都不够。

**正确模式**分两类：

| 元素类型               | 正确写法                    | 原因                                              |
| ------------------ | ----------------------- | ----------------------------------------------- |
| Badge/Chip/标签（非交互） | **只用文字色**，不要 background | 轻量标注不需要背景块，彩色文字足够识别                             |
| 按钮（可点击）            | **深彩底 + 白字**            | 用 `state-xxx-primary` 做背景，`#fff` 做文字，保证点击区域的存在感 |

```js
// ❌ 糊片 1: primary 文字 + secondary 背景 (同色系!)
const badge = { color: "var(--dsw-alias-state-success-primary)", background: "var(--dsw-alias-state-success-secondary)" };

// ❌ 糊片 2: 同上结构换了 error/business/warn 色值 (一样糊)
const deleteBtn = { color: "var(--dsw-alias-state-error-primary)", background: "var(--dsw-alias-state-error-secondary)" };

// ✅ Badge/Chip: 只有文字色, 无背景
const runningBadge = { color: "var(--dsw-alias-state-success-primary)" };
const tag = { color: "var(--dsw-alias-state-business-primary)" };

// ✅ 按钮: 深彩底 + 白字
const deleteBtn = { background: "var(--dsw-alias-state-error-primary)", color: "#fff", border: "none" };
const warnBtn = { background: "var(--dsw-alias-state-warn-primary)", color: "#fff", border: "none" };
```

#### 排查清单

改完主题后，用这个命令检查硬编码残留（只剩按钮白字 `#ffffff` 是可接受的）：

```powershell
Select-String -Path "lib\client.js" -Pattern '#([0-9a-fA-F]{3,8})|rgb\(|rgba\(' -AllMatches
```

参考变量权威定义：`runtime/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js`。

### 5.8 改源码必须同步运行副本（最易"改了没生效"）

- 插件经 `dsh plugin add file:`（pnpm）是**拷贝/硬链接**进 `runtime/dsh-home/profiles/web/node_modules/<插件>/`，dsh 实际跑的 bundle 读安装副本。只改 `plugins/` 源码不重装/不同步，运行端**静默不生效**。

- **同步法**：`Copy-Item -Path "$src\*" -Destination $dst -Recurse -Force`（`Copy-Item -Destination` 遇已存在目录会**嵌套**复制，须用 `$src\*`）；dsh 硬链接同 inode 时 `Get-FileHash` 双路径一致即已同步（运行时只读副本的宿主文件被锁、Copy 报"被占用"属正常）；或直接 `--install-plugin file:<绝对路径>` 重装。

- 改 `lib/index.js`/`cordis.patch.yml` 需**重启服务**；纯客户端 `lib/client.js` 强刷页面即可。

- **验证插件树必须设 DSH\_HOME**：`--dump-config` 要先 `$env:DSH_HOME=runtime\dsh-home`，否则加载 `~/.dsh` 默认 home（只有内置 bundle），误判没进树。

### 5.9 system-prompt/assemble 插件注入机制（纯 hook 插件的核心）

除了"路由 + 客户端"双端插件，DSH 还支持**纯 hook 插件**：只监听 DSH 内部事件，注入内容到 system prompt。dsh-rules（用户规则注入）和 dsh-memory（祖宗记忆库注入）就是这个模式。

#### 运作原理

```
DSH 组装 system prompt 时
  → 触发 waterfall 事件 system-prompt/assemble
  → 所有监听者依次修改 assembly.contexts
  → DSH runtime 把所有 contexts 拼成完整 prompt
  → 发给 LLM
```

#### 事件签名

```javascript
import '@deepseek-ai/dsh-system-prompt';  // 声明依赖, 否则事件总线不存在

ctx.on('system-prompt/assemble', async (assembly, _ctx, next) => {
    assembly.contexts.push({
        name: 'unique-context-name',  // 必填, 全局唯一 (invariant.js 校验, 重复会 fail)
        text: '注入的纯文本内容',        // 必填, 必须是字符串
        weight: 0.9,                   // 可选, 权重越高越优先
    });
    return next();  // waterfall 链必须继续传下去
});
```

#### 两个已存在的 context.name（不要重复）

| 插件         | context.name         | 内容             |
| ---------- | -------------------- | -------------- |
| dsh-rules  | `user-rules`         | 用户手写的规则文件      |
| dsh-memory | `zuzong:auto-recall` | 祖宗记忆库自动召回的最近对话 |

#### 实现注意事项

- **钩子失败要静默**：读文件失败/bridge 断开时别 throw，用 try-catch 吞掉，下一次请求继续试

- **context name 全局唯一**：两个插件用同一个 name 会报 invariant 错

- **hook 是 async 的**：可以 `await bridge.callTool()` 异步取数据，不阻塞 waterfall

- **缓存策略**：规则/记忆这种"读多写少"的内容应该本地缓存（2s TTL），避免每次请求磁盘 IO

- **文件变化自动重载**：用 `fs.watch` 监听目录 + 清缓存 → 下次请求生效

完整代码骨架见 `references/plugin-skeleton.md` 类型 B。

### 5.9.1 类型 B → 类型 A 升级路径（纯 hook 加 WebUI 开关）

> 参考实作：dsh-rules v3、dsh-memory v3。
>
> 纯 hook 插件做了一段时间后，发现用户需要从 WebUI 开关（不是每次都改 cordis.yml 重启）。这时把 Type B 升级成 Type A 要改三个地方：

**1. package.json 加两个声明**

```json
// 原来只有 dsh.bundle.patch，现在加:
"exports": { "./client": "./lib/client.js" },    // 让客户端模块注册表能 resolve
"dsh": { "client": { "inject": ["slots"], "platform": "web" } }
// 同时补 files: ["lib", "cordis.patch.yml"]
```

**2. lib/index.js 加 inject + 路由 + 持久化配置**

```javascript
// inject 从 [] 改成 ["webServer"]
export const inject = ["webServer"];

// Config 加 enabled 默认 false (省 token)
export const Config = z.object({ enabled: z.boolean().default(false), ... });

// 持久化三个辅助函数
function _persistPath() { return join(DSH_HOME, "xxx", "xxx-config.json"); }
function _loadPersist() { ... }
function _savePersist(patch) { ... }

// apply() 合并持久化 → 注册 config GET/POST 路由 → enabled=false 跳过 hooks
```

**3. 新建 lib/client.js**（settings.section 插槽 + enabled 开关 checkbox）

完整骨架见 `references/plugin-skeleton.md` 的「持久化配置 + WebUI 开关」章节。

**关键设计决策**：

- **enabled 默认 false**（system-prompt 注入类插件占 token，默认关闭让用户自己决定）

- **持久化 json 独立于 cordis.yml**（用户手改 cordis.yml 可能覆盖 WebUI 开关；json 是"用户态覆盖层"，优先级更高）

- **路由始终注册，hooks 按 enabled 装**（enabled=false 时用户仍能打开 WebUI 改开关，但不消耗 token）

- **提示"下次启动生效"**（apply() 只在启动时跑一次，不热插拔）

### 5.10 第三方"工具型"插件（无 UI）

- 分类：**宿主端工具/路由插件**（package.json 只有 dsh.bundle.patch）与**客户端 UI 插件**（有 dsh.client）。工具型插件只 `ctx.tools.register(defineTool(...))`，**界面上不出现任何 UI**（"装完没见 UI"正常），靠 agent 在对话里按需调用。安装后重启 `dsh web`。

- **排查"装了没反应"顺序**：① dependencies + bundles 是否含包；② 设 DSH\_HOME dump-config 看插件层；③ package.json 有无 dsh.client（无则无 UI）；④ **插件自身运行时/凭据前提**（外部解释器版本、下载型依赖、API key所属，最易忽略）→ 看 server.log 里插件 `ctx.logger.error` 的降级提示；⑤ 重启服务。

### 5.11 接入第三方模型/Provider（Ollama 等）：写 pi-ai 的 providers 配置

- 官方多 Provider 底座 = `dsh-llm-pi-ai`（命名空间 `llm-pi-ai`）。给 DSH 加模型源**绝不要**自己调 `ctx.llm.registerAdapter`（对 provider 路由**排他**）或 `registerModelDiscovery`（每 namespace 只能一个）。**正解**：经 `sctx.settings.mutate("llm-pi-ai", ops)` 写 `providers.<id>`，pi-ai 监听变更自动注册模型目录 + 对话路由 + 发现。

- **Ollama 接入配方**：`api:"openai-completions"` + `baseURL:"{url}/v1"` + `models:[{id,name,contextWindow,maxTokens}]`（从 `/api/tags` 探测）。

- **上下文容量配置错位 = "能对话但从不调工具 + 报 token 上限"双故障同源**：① `maxTokens` 绝不能等于 `contextWindow`（正确如 32768/8192）；② 提升 Ollama 上下文别用 `OLLAMA_CONTEXT_LENGTH` 环境变量（桌面版 serve 不继承）、`/v1` 也不转发 num\_ctx → 正解 Modelfile `PARAMETER num_ctx N` 建 `-32k` 变体再装、DSH 指向该变体。

- **OpenAI 兼容服务必配** **`compat`**：Ollama/LM Studio/vLLM 不认 OpenAI 官方方言（`developer` 角色/`max_completion_tokens`/工具 `strict` 字段），不配则工具 schema 到不了模型、**模型接入后从不调工具**。`compat:{ supportsDeveloperRole:false, supportsReasoningEffort:true, maxTokensField:"max_tokens", supportsStrictMode:false }`。

- **thinking 模型关思考只认** **`reasoning_effort`，不认** **`think:false`**：新版 `/v1` 静默丢 think 字段 → `compat.supportsReasoningEffort:true` + 每模型 `reasoningEfforts:{off:"none",minimal:"none",low:"low",medium:"medium",high:"high"}`，think off 时发 `reasoning_effort="none"` 关思考。

- **生效字段是** **`target*`** **不是** **`default*`**：`buildProviderProfile` 取 `target* || default* || 内置默认`，`ensureContextVariants` 只认 `targetContextWindow` → 面板应绑 `targetContextWindow/targetMaxTokens`（不是 default\*，default 是被 target 盖掉的回退值）。排查"AI 优化了配置没效果"先核对是不是生效字段。

- **周期自动写入必须保留用户手改的生效字段**：`applyOllamaProfile` 已存在 provider 分支里用 `mergeModelParams(current, new)`（已有模型保留手改参数、新增套默认），否则 Models 页手改的 contextWindow/maxTokens/name 会被下一轮探测（默认 60s）覆盖。教训：任何"周期自动写入"逻辑先问"会不会覆盖用户手改的生效字段"。

- **免鉴权服务必带占位 Authorization 头**：`openai-completions` 协议校验 key——无 apiKeyEnv 无头抛 `No API key for provider`、写 `apiKeyEnv` 又缺真 Key 报 `MISSING_CREDENTIAL` → 正解 `headers:{Authorization:"Bearer ollama-local"}`（服务不校验）。

- **thinking 模型"Deep diving…"是正常思考态**（先流 reasoning-delta 后出正文，本地 4B 冷启动+思考十几秒\~几十秒）；`curl` 直测注意 PowerShell 单引号 JSON 被吃（写临时文件 `--data-binary "@file"`）；`api/ps` 空 = 模型未加载。

- **后台探测型插件要提供「主动重接入」入口**（外部服务比 DSH 晚启动时用户无重试入口）：加独立路由 `POST /<route>/reconnect`（复用 `runDetection(force:true)`），与配置路由**不同 path**（避免同 path 只能注册一次）；`force:true` 全量重写但 `mergeModelParams` 保留手改项；内部只 runDetection，**不写**配置文件（避免点一下清空面板覆盖值）；离线也是正常返回（reconnected:false + lastError）；客户端按钮置忙。

### 5.12 WebUI 悬浮侧栏/浮层的开关按钮：别钉右上角、也别叠内容区

- 官方 WebUI 右上角自带宽操作按钮（下载对话等）；自建侧栏/浮层的**展开收拢开关若** **`position:fixed; top/right`** **固定右上角会盖住官方按钮**（第一处坑）。**把折叠开关垂直居中叠在面板内容区（文件列表）高度上会挡住列表点击**（第二处坑，两面都踩过，`dsh-sidebar-lite`）。

- 参考社区 better-sidebar 的 **toggle cluster**：开关**始终固定在面板顶部**——

  - **展开态**：折叠按钮放在**标题/tab 条右端**（内容区之外），绝不叠在列表中间高度；

  - **收起态**：开关在右上角/右缘（圆形图标按钮）。

  - 按钮用**官方 icon-button 样式**（圆形无边框 / secondary 墨色 / hover 加深填底），图标复刻官方 `IconPanelRightOutline16`（外框 + 右侧竖条）而非字符箭头。

- 规避重叠的正解不是"把开关挪开"，而是靠 `#root` 让位：面板展开时 `#root{margin-right:面板宽}` 把**官方 header（含下载按钮）推到面板左侧**，故面板内右上角本就没有官方按钮 → 标题条右端放折叠按钮天然不重叠。收起态若用右上角 cluster，需让官方 header `padding-right` 给 cluster 让位。左缘拖拽调宽条保持窄透明（宽 5px），避免挡内容。

- **多浮动面板并存时的让位累加**（如侧栏 + 独立文件预览框）：额外面板用 `position:fixed; right:主面板宽; width:预览宽` 叠在主面板**左侧**，并把它的宽度也累进 `#root` 的 `margin-right`（`calc(var(--w1)+var(--w2))`）；面板关闭/收起时对应让位变量归零，否则主内容会被后开的浮动面板遮挡（`dsh-sidebar-lite` 已如此实现）。

## 六、验证与排查速查表

| 症状                                                         | 首选排查动作                                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebUI 入口不显示                                                | 抓 `__DSH_BOOT__.entries` 是否含插件 → 查 exports 含 `./package.json` → 查 files 含 `cordis.patch.yml`                                                      |
| 客户端组件不渲染/按钮消失（componentDidCatch、Rendered more/fewer hooks） | 查条目组件是否条件调用 props 传入的 hook → 改读 ownerProps 普通字段 → 强刷页面                                                                                            |
| 点击按钮 HTTP 405                                              | 路由没进 exact 表 → `ctx.effect(()=>register(...), label)` 写法 → `dsh-host-frontend-static` fallback                                                    |
| 客户端 fetch 404（服务端明明有路由）                                    | 是否同 (kind,path) 注册两条（无 method 字段，重复注册抛 Duplicate 回滚全路由）→ 合并单 handler 按 req.method 分流 → 重启服务                                                       |
| 路由 403                                                     | 自定义头没带对 / 跨域带不上自定义头                                                                                                                               |
| 会话 shell 报 ACL temp 冲突                                     | 临时目录在工作区内 → 换 `BASE_DIR/workspace` 或工作区外目录                                                                                                        |
| "Failed to fetch"/服务 40 秒退                                 | stdin 读到 EOF → `stdin=PIPE` 保持打开                                                                                                                  |
| 日志 `Unexpected token '\ufeff'`                             | npm 包 package.json 带 UTF-8 BOM → 读 JSON 前去 BOM                                                                                                    |
| 改插件源码 WebUI 没变化                                            | pnpm 对 file: 是拷贝 → 同步运行副本/重装 + 重启服务                                                                                                               |
| 安装插件后服务重启即退出（ERR\_MODULE\_NOT\_FOUND lib/index.js）         | 纯客户端插件缺宿主端 `lib/index.js` → 加官方 no-op                                                                                                             |
| 装插件 WebUI 看不到任何东西（无 UI）                                    | 查有无 `dsh.client`——无则宿主端工具/路由插件，靠 agent 调用或 HTTP 路由验证                                                                                              |
| `--dump-config` 看不到自定义插件层                                  | 先 `$env:DSH_HOME=runtime\dsh-home` 再 dump                                                                                                         |
| 会话突然全部 400（孤儿 tool\_calls 毒化）                              | 「会话回退」插件分析 → 在崩溃回合前已完成回合「回退到此」派生续接                                                                                                                |
| 界面空白（GUI）                                                  | `ttk.Panedwindow` 漏 `.add()`；滚动条被列宽挤成 1x1                                                                                                         |
| 多次重启累积 WebUI 标签页                                           | `dist/index.html` 无 `dsh-launcher-ui-beacon`（patch\_frontend 没跑/旧 exe）；有心跳仍开新页查 3081 占用/token                                                     |
| 「检查绿色版更新」查不到                                               | 网络 api.github.com / 镜像；Release tag 带 v 前缀；资产名以 `DSH_Launcher_GreenPortable_Online_` 开头                                                            |
| 更新后启动器没被替换                                                 | 独立更新程序 `DSH_Update.exe --apply`：查 `runtime/update/backup/`、`update_job.json`、server.log                                                           |
| 桌面窗口起不来显示"连接失败"                                            | 避免 `start()` 前 `load_url()` 致 Main window failed 后回退浏览器 → 提示页放 create\_window 初始地址，导航放 `start(func)` 回调；用控制台 python 跑看 traceback                  |
| 桌面窗口图标是默认                                                  | 往 `webview.start(icon=路径)` 传 icon（WinForms 支持，`self.Icon=Icon(icon)`）；别信"仅 GTK/QT"文档；`WM_SETICON` 依赖 FindWindowW 而 WebView2 用页面 title 覆盖窗体标题，常失效  |
| 远程打不开 WebUI/进程立即退                                          | `dsh_host=0.0.0.0` → `startup.js` 补丁是否生效 → `install_dsh()` 后调了 patch\_web\_startup                                                                |
| 远程能聊天但改设置 403                                              | 正常——PRIVILEGED\_METHODS 仅回环可调，官方安全保护                                                                                                              |
| 填了受信任主机没生效                                                 | `trusted_hosts` 应为数组（config.json `["ip:port"]`）→ build\_server\_command 生成 --trusted-host；官方绑定 0.0.0.0 无条件全局域网放行，需 patch\_lan\_trust 才"填了=只信任填写的" |
| 模型选择器无 Ollama/报 No API key                                 | 查 `llm-pi-ai.providers.<id>` 已写（重启服务持久）；免鉴权服务带占位 `headers.Authorization`；thinking 模型等待式思考正常                                                       |
| Ollama 能对话从不调工具                                            | **compat 缺失**（OpenAI 兼容端点不认官方方言）→ 配置带 `compat:{...}`；查 settings.yaml 的 providers.<id>.compat                                                      |
| 对话停"Deep diving…"很久                                        | thinking 模型先思考后出正文（本地冷启动+思考十几秒\~几十秒）；`GET /api/ps` 确认已加载                                                                                          |
| bat 双击闪退但代码看着没问题                                           | 抓行为用 `subprocess.run(["cmd","/c",bat], capture_output=True)`（别用 PS Start-Process 重定向，与 pause 交互冲突）；字节级检查 ASCII 无 BOM CRLF                         |

## 七、工作流建议（开发顺序）

1. **先理数据目录**：确认 `DSH_HOME`/`runtime/` 全部重定向到程序目录，明确"绿色整合"边界。
2. **再搭启动**：便携 Node → `lib/bin.js` → `stdin=PIPE` → 就绪检测 → `--no-open` + 统一 `open_ui` 接管。
3. **后做维护**：检查更新（备份优先）→ 插件管理（pnpm 便携化 + reconcile 兜底）→ 数据维护 → 绿色版自更新（双通道 + 独立更新程序）。
4. **最后开发插件**：先宿主 index.js（路由）再客户端 client.js，双端声明齐全 → 设 DSH\_HOME dump-config 验证树 → 抓 `__DSH_BOOT__` 验证客户端 → 实测路由。

