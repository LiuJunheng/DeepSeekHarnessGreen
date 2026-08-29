---
name: dsh-deploy-maintain
description: "DeepSeek Harness 绿色整合版启动器的部署、日常维护、插件开发与避坑经验。覆盖便携 Node/dsh 安装、环境变量重定向、工作区 ACL 沙箱、更新备份、插件管理与 dsh 插件双端加载/路由注册等全套实操知识。"
---

# DeepSeek Harness 绿色整合版 · 部署维护与插件开发

> 版本日期：2026-08-29
> 本 Skill 沉淀自 `DeepSeekHarnessLauncher` 项目（Python tkinter 绿色整合版启动器 + 内置 `dsh-archive-purge` / `dsh-file-browser` / `dsh-session-rewind` / `dsh-usage-stats` 插件）的全过程实测经验，含 51 条避坑记录。适用于：把 dsh 封装成"双击即用、绿色整合、可整目录拷走"的形态，以及开发 DSH 插件（宿主端路由 + WebUI 客户端入口）。

## 一、适用场景

- **部署**：在任意 Windows/Linux 机器上搭建 dsh（DeepSeek Harness）绿色整合运行环境——便携 Node + 本地安装 dsh + 数据全部落程序目录，不污染用户主目录。
- **维护**：检查/更新 dsh 版本（先备份后重装）、可视化插件管理（搜索/安装/移除/本地文件夹安装）、数据维护（永久删除归档会话，dsh 官方没有该能力）。
- **插件开发**：开发同时被宿主端与 WebUI 双端加载的 dsh 插件（如「清理归档」会话管理插件），并排查"服务端在、客户端不显示 / 路由 404/405"等经典故障。
- 本 Skill 与 `python-tkinter-desktop-dev`（tkinter GUI 通用规范）、`trae-skill-creation`（Skill 打包规范）配套使用。

## 二、绿色整合部署核心机制

### 2.1 总体架构

```
程序根目录（BASE_DIR，绿色整合，可整目录拷走）
├── launcher.py            # Python 绿色整合版启动器（GUI/CLI）
├── start.bat / stop.bat   # ASCII + CRLF 编码的 .bat 入口
├── build_exe.bat          # PyInstaller 打包 DSH_Launcher.exe
├── config.json            # 镜像/端口/default_workspace 等配置
├── plugins/               # 内置插件源码（如 dsh-archive-purge、dsh-usage-stats）
└── runtime/               # 全部运行时数据（绿色整合核心）
    ├── node/              # 便携 Node（node-v22.20.0）
    ├── dsh/               # @deepseek-ai/dsh 本体
    ├── dsh-home/          # DSH_HOME：会话/配置/存储
    ├── npm-cache/         # npm_config_cache 重定向
    ├── pnpm-home/         # PNPM_HOME + pnpm 全局
    ├── pnpm-store/        # npm_config_store_dir 内容寻址存储
    ├── tmp/               # TEMP/TMP 重定向
    └── python/            # （exe 版可省）内置便携 Python + PyInstaller
```

### 2.2 便携 Node 与 dsh 安装（关键路径差异）

- **Node 二进制下载**：国内走 `https://registry.npmmirror.com/-/binary/node/...`，官方走 `https://nodejs.org/dist/...`（注意：**二进制下载与 npm 包注册表是两个不同的镜像路径**）。
- **便携 Node 自带 npm 的位置分平台**（必须两个都探测，否则误退回系统 npm）：
  - Windows zip：`node_modules/npm/bin/npm-cli.js`（node.exe 在发行包**顶层**）。
  - Linux/Mac tar.gz：`lib/node_modules/npm/bin/npm-cli.js`（node 在 `bin/` 子目录下）。
- **dsh bin 入口**：不是顶层 `bin/`，而是 `node_modules/@deepseek-ai/dsh/lib/bin.js`（package.json 的 `bin.dsh` 指向它）。**启动/插件管理必须用便携 `node.exe` + 此 `lib/bin.js` 直接调用**，不要依赖 `node_modules/.bin/dsh.cmd`（npm 生成的 .cmd 回退分支会调 PATH 里的系统 node，把便携和系统搞混）。
- **镜像附 `--registry`**：`resolve_mirror()` 返回 `("cn", True)` 时，`prepare_dsh()` 里只有非 auto 模式才附加 `--registry`；auto 模式下 npm 会走默认官方源，国内很慢甚至卡住——需要时把 `config.json` 的 `mirror` 改为 `"cn"`，或把 auto 的"国内优先、失败回退"逻辑扩展到 npm install 阶段。
- **首次 install 较慢**（约 3 分钟 / 587 包），界面提示"请耐心等待"，并用**流式实时输出**展示进度（`Launcher._stream_subprocess`：`subprocess.Popen` + 后台线程逐行读管道 + `self.log` 逐行打日志 + 行前缀 `"npm: "`；超时兼容 `process.wait(timeout)`、读取线程 `join(timeout=5)` 防孙进程持管道阻塞；返回 `(退出码, 完整输出)`）。npm 在 stdout 非 TTY（管道）时输出逐行 `npm notice`/`added N packages` 文本，逐行显示即可确认"没卡住/没报错"。三处接入：`install_dsh` / `install_pnpm` / `run_plugin_command`。
- **【关键避坑，2026-08-20】npm 安装"没输出=像卡死"的真因是 npm 而非显示端**：`_stream_subprocess` 只负责"转发 npm 吐出的内容"，并不会变出内容。npm 在 stdout 非 TTY（管道）时，**默认日志级别 `notice` 会抑制 `npm http fetch` 这类逐包下载输出**，只在全部下载完成才打印一行 `added N packages`——所以下载那几分钟管道里什么都没有，GUI 日志框/命令行自然一片空白，用户误以为卡死。**必须给安装命令加 `--loglevel=http`**（每个包 HTTP 下载完成实时吐一行 `npm http fetch GET 200 <url> <耗时>`）：选 `http` 而非 `verbose`，因 `http` 逐包一行、量适中平稳；`verbose` 的 reify 内部调试日志每秒数百行，经 `root.after(0)` 排队刷 Text 组件会把 GUI 拖卡，适得其反。排查"安装无进度"时，先怀疑 npm 自身当前日志级别没吐内容，再怀疑显示侧。
- **【避坑延伸，2026-08-20】`--loglevel=http` 只能救"有网络输出"的阶段，救不了 reify/安装链接静默**：真机实测元数据抓取会逐行实时显示，但抓完进入 reify（把包写 node_modules + 跑脚本，纯本地 I/O 无网络）后，http 级别又长时间静默、看着像卡死。**任何绑定网络/日志的 npm 级别都救不了这段**（verbose 刷爆 GUI）。解法：给 `_stream_subprocess(..., heartbeat_interval=60)` 开**空闲心跳**——子进程仍在运行且超过间隔（默认 60 秒）没有新输出时，启动器自己打一条 `[进度] 已运行 N 秒, 命令仍在执行 (暂无新输出, 请继续等待) ...`；正常有输出绝不打扰。`process.wait(timeout)` 超时/终止语义不受影响（心跳用独立 daemon 线程，主流程 finally 置结束标记）。间隔别设太短（最初 15s，用户反馈太频繁刷屏，改 60s）。**分层避坑**：网络阶段看 npm http 日志（#58），纯 I/O 阶段看启动器空闲心跳（#59），两招配合最稳。

### 2.3 环境变量重定向（build_env，绿色整合的命根子）

| 环境变量 | 本地落点 | 作用 |
|----------|----------|------|
| `DSH_HOME` | `runtime/dsh-home` | dsh 会话/配置/存储（**不设则写用户主目录，破坏便携**） |
| `npm_config_cache` | `runtime/npm-cache` | npm 下载缓存（否则写 `~/.npm`） |
| `npm_config_userconfig` | `runtime/npm-userconfig` | 本地空配置，阻断读写 `~/.npmrc` |
| `npm_config_global` / `update_notifier` / `fund` | - | 禁全局安装、禁更新通知、禁赞助广告 |
| `PNPM_HOME` | `runtime/pnpm-home` | pnpm 全局目录（dsh 插件管理依赖 pnpm） |
| `npm_config_store_dir` | `runtime/pnpm-store` | pnpm 内容寻址存储 |
| `TEMP` / `TMP` | `runtime/tmp` | 进程临时目录（与工作区 ACL 沙箱相关，见 2.5） |

### 2.4 服务启动与进程管理（stdin 大坑）

- **启动**：`node <dsh>/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3080`。
- **【严重】stdin 必须保持打开**：`subprocess.Popen` 未指定 `stdin` 时子进程继承父进程 stdin；在 .bat / 守护 / 无 TTY 环境下 stdin 是 EOF，**dsh 检测到后约 40 秒内静默退出**，网页报 "Failed to fetch" / "Service not running"。修复：`Popen(..., stdin=subprocess.PIPE)` 保持管道打开；CLI 守护模式由 Python 常驻持有管道写端，GUI 靠 mainloop 常驻。
- **就绪检测**：后台线程 socket 轮询端口，就绪后 `webbrowser.open`。CLI 模式要**同步** `wait_ready()` 再开浏览器（daemon 线程会随主进程退出而消失）。
- **WebUI 单页面去重（心跳机制，2026-08-15 新增）**：多次重启会在浏览器累积一堆相同标签页。做法 = 启动器向 `@deepseek-ai/dsh-web-frontend/dist/index.html`（`frontend_index_path()` 定位，服务每次请求都重新 `readFile` 后经 `applyIndexTaps` 渲染，**改文件立即生效**）注入一段幂等心跳脚本（`patch_frontend()`，用 `<!-- dsh-launcher-ui-beacon:start/end -->` 标记包裹，dsh 安装/升级后由 `install_dsh()` 与 `start_server()` 自动补齐）：页面每 15 秒 `fetch('http://127.0.0.1:3081/__dsh_ui_alive?t=<令牌>', {mode:'no-cors'})` 上报一次；启动器起一个 `http.server.ThreadingHTTPServer`（绑定 127.0.0.1:3081，daemon 线程）记录最近心跳，`ui_is_open()` 以最近 180 秒内有无心跳判定"界面已打开"，**仅自动打开**（`wait_and_open()`/`open_ui(force=False)`/CLI `--start`）先查此判定，已打开则跳过并记日志；**手动点「打开界面」= `open_ui(force=True)`，必定打开新页面，不受去重拦截**（关掉标签页后想立刻重开时点它即可）。**令牌**存 `runtime/ui-beacon.token`（`secrets.token_hex(8)`，持久化保证重启启动器后旧标签页仍能上报）防无关本地页面伪造上报；端口被占用时仅记日志、去重自动禁用（退化为每次都开新页，绝不阻塞启动）。配置：`auto_open_browser`（默认 True，False 则启动不自动开浏览器）、`ui_beacon_port`（默认 3081）。**取舍**：浏览器后台标签页 `setInterval` 会节流到约 60 秒一次，故窗口设 180 秒；关掉标签页后最多 3 分钟内重启仍可能跳过开新页，属预期（可点「打开界面」强制开新页）。
- **冷启动重复检测**：PID 文件（`runtime/server.pid`）+ 进程存在性判断"已在运行"，避免重复起服务。排查端口监听要用 `grep -w 3080`（`grep 3080` 会误匹配 `13080` 子串）。

### 2.5 工作区与 ACL 沙箱（Windows 专属大坑）

- **机制**：dsh 要求临时根目录（`runtime/tmp`）不能位于会话工作区内部，否则所有 shell 工具报 `Windows ACL temp root must be outside the workspace`。
- **三层概念要分清**：
  1. 会话的**工作区归属**固化在该会话日志 header 的 `cwd` 字段（`sessions/<编码>/<ID>/session.jsonl.zstd` 第一行），**一经创建不可改**——旧会话换不了工作区，只能归档/删除/开新会话。
  2. `storages/workspace.json` 只是**工作区注册表**（`{path, title, sessionIds, createdAt, updatedAt}` + 全局 `archivedSessionIds` + 显示顺序 `workspaceIds`），不是会话配置。
  3. 沙箱判定读 `session.header.cwd`：cwd 是子目录的会话 ACL 通过；cwd 是程序根目录（内含 `runtime/tmp`）的老会话报 temp 冲突。
- **新会话不会自动建子工作区**：工作区由用户在 WebUI 左侧手动选；启动器只负责预置一个安全的默认工作区。
- **自动解析**（不写死）：`workspace_conflicts_with_tmp(path)` 用 `os.path.normcase/normpath/abspath` + `os.path.commonpath` 判断"临时目录是否为工作区严格子路径"（不同盘符 `ValueError` 按不冲突处理）；`resolve_default_workspace()` 优先级 = ① config `default_workspace` 显式值（冲突则警告回退）→ ② 程序根目录本身不冲突则用它 → ③ 冲突才取 `BASE_DIR/workspace` 子目录。

### 2.6 exe 打包（PyInstaller）

- **onefile 下 `__file__` 不可用作程序根目录**：运行时 `__file__` 指向 `_MEIPASS` 临时解压目录。正确做法：`get_base_dir()` = `getattr(sys, "frozen", False)` 时取 `os.path.dirname(os.path.abspath(sys.executable))`（exe 所在目录），否则取脚本目录。
- **不污染环境/不用 C 盘**：`pip install --target runtime\pyinstaller -i https://pypi.tuna.tsinghua.edu.cn/simple pyinstaller` 装到项目目录，设 `PYTHONPATH=runtime\pyinstaller` 后用 `python -m PyInstaller` 调用；加 `--onefile --windowed --noupx`（禁用 UPX 减少杀软误报）。
- **内置便携 Python**：python-build-standalone 的 `install_only` 压缩包解压后有**顶层子目录**（`runtime/python/python/python.exe`），`find_python_exe()` 必须"先查顶层 `python.exe`，再遍历一层子目录"兼容两种布局。
- **重新打包纪律**：改过 `launcher.py` 后必须重打包 exe（用 `build_exe.bat`），否则用户跑的仍是旧版 exe（曾出现过"界面空白其实是旧 exe"的假象）。
- **必须显式补齐全套 VC 运行库（2026-08-18 实测）**：PyInstaller 默认只自动收集 `VCRUNTIME140.dll`，**漏 `vcruntime140_1.dll` / `vcruntime140_threads.dll`** → 目标机没装新版 VC++ 运行库时，exe 启动弹 `Failed to load Python DLL ... 找不到指定的模块`（`%TEMP%\MEIxxxx` 里的 python310.dll `LoadLibrary` 失败，这是 onefile 正常解压机制，与"内置 python"无关）。**修法**：`build_exe.bat` 用 `--add-binary "%~dp0runtime\python\python\vcruntime140_1.dll;."` 等三条把三个 DLL 全打进 bundle。诊断：`pyi-archive_viewer -l DSH_Launcher.exe` 过滤 `vcruntime|python310` 看包内内容；单 DLL 依赖用 PE 导入表解析（`runtime/tmp/pe_imports.py`，不依赖 dumpbin）。详见 DEV_NOTES 避坑 #67。

## 三、日常维护

### 3.1 检查更新（备份优先策略 / 动态检测所有标签）

- **"装了就永远最新"是错觉**：`prepare_dsh()` 只在缺失时安装，已装就跳过；同步更新的唯一途径是强制重装。
- **动态检测所有标签（2026-08-29 起，不再只查 npm latest/next）**：官方 dsh 发布**不一定**同步 npm——如 `0.1.2-alpha.1` 只发在 GitHub Releases（tag `dsh-v0.1.2-alpha.1`）、npm 仍停 `0.1.1-rc.2`，只看 dist-tags 永远检测不到。因此「检查更新」现在合并两个来源：① `dsh_dist_tags()` 读 npm 的 `latest`/`next`（稳定版/预发布，一定可安装）；② `dsh_github_releases()` 用 GitHub API `releases?per_page=100&page=N` **分页拉全部 tag**（`_dsh_tag_to_version()` 兼容 `dsh-v`/`v`/裸版本号三种前缀），再配 `dsh_npm_versions()`（`npm view … versions --json` 全量版本集合）判断每个 tag **是否已在 npm 发布（可安装）**。合并成动态候选列表，GUI 用**可滚动 Treeview** 列出（版本/标签来源/发布时间/可安装），选中可安装的版本才进「确认升级」；未发布到 npm 的源码 tag 给明确提示 + 「打开 GitHub 发布页」。
- **版本可选 + 只提示更新的版本（需求 #56/#57）**：GUI「检查更新」用 `app._green_version_greater(version, current_version)` **只保留比当前已装版本更新的候选**（否则已是 stable 仍提示再次覆盖，属误报）；去重、按 可安装优先 + 版本从新到旧 排序。都不更新时提示「已是最新版本: <当前>」。
- **升级两段式确认（需求 #57）**：点某版本按钮先弹出 `confirm_upgrade()` 二级确认框，展示 当前/目标版本 + 该版本更新说明（后台线程加载；动态检测已拉到的 GitHub body 会直接传入 `preloaded_notes` 复用，避免重复网络查询），点「确认升级」才真正 `update_dsh(target_version)`；「取消」则放弃。`update_dsh(None)` 仍装 latest（兼容旧调用）。
- **更新说明来源（重要避坑）**：官方 **GitHub Releases** 每个版本都带发布说明（tag 形如 `dsh-v<version>`，中英文 changelog），是正确来源。`dsh_version_notes(version)` 优先 `dsh_version_notes_from_github(version)`（批量拉 releases?per_page=30，tag 用 `_dsh_tag_to_version()` 解析后匹配，兼容 `dsh-v` 前缀）；GitHub 失败/未命中才回退 npm registry 元数据。**别用 `npm view readme`——npm 包 readme 是空的**。
- **查询避坑**：`dist-tags --json` 必须拆成独立 argv（`_npm_view` 内 `query.split()`），整串当单参数传 npm 会报用法错误返回 None；npm view 的 registry 参数要与安装一致（镜像源），否则查到非所选镜像的版本快照。
- **源码 tag ≠ 可安装（2026-08-29 实测）**：GitHub 上出现而 npm 没有的版本**无法自动安装**——`npm install @deepseek-ai/dsh@<版本>` 报 ETARGET；GitHub release 的 tarball 是 **monorepo 源码包**（根 package.json 是 `@deepseek-ai/dsh-root` + workspaces，需 pnpm build），也装不成 dsh 包。只能等官方同步发布到 npm 后才能装。凡第三方列表接口取"最新/全部"都要防顺序假设 + 分页截断（坑 26）。
- `update_dsh(target_version)` 顺序 = 备份 → **备份成功后才** `prepare_dsh(force=True, package_spec="<pkg>@<版本>")` 强制重装目标版本。备份失败直接中止，防止"旧版被覆盖又没装上"的数据丢失。GUI「数据维护」可一键清理更新/备份目录。
- 备份目录不自动清理，是否删除交给用户手动管理。
- 把安装主体抽成 `install_dsh(package_spec)`（支持 `@pkg` / `@pkg@<版本>` / `@pkg@next` 指定标签），`prepare_dsh(force, package_spec)` 只做"缺失则装 / 强制重装"分支，首装与更新共用同一代码。

### 3.2 插件管理（dsh plugin 依赖 pnpm）

- `dsh plugin --profile <name> <pnpm 参数>` 内部转发给 pnpm 管理该 profile 依赖（`profiles/<name>/package.json` 的 `dependencies` + `node_modules`）。**已安装清单 = 读 profile 的 package.json，无需调查询接口**。
- **pnpm 必须装进便携 runtime**：用便携 node 的 npm `install -g pnpm --prefix runtime/pnpm-home`，并把 `runtime/pnpm-home` 加进 `build_env()` 的 PATH。**`pnpm --version` 直接裸跑会失败（退出码 1）**——pnpm.cmd 内部要调 node，必须在含便携 node 的 PATH 下运行。
- **本地插件安装**：`os.path.isdir(spec)` 为真时自动归一化为 `file:<绝对路径>`（`\`→`/`）交给 pnpm。**pnpm 对 `file:` 是拷贝非软链**，改 `plugins/` 下源文件后必须重新安装才同步（幂等重装很快）。
- **内置插件批量安装（2026-08-17，需求 #37）**：`bundled_plugin_dirs()` 动态扫描程序目录 `plugins/` 下含 package.json 的子目录（不硬编码名单）；`install_bundled_plugins()` 用 `file:` 批量安装，**已装的跳过**、单个失败不中断、返回 (新装/跳过/失败)。接线：`prepare_all()` 在 `prepare_dsh()` 后自动调用（"已装跳过"故幂等，启动服务前的 prepare_all 不会重复装）；插件管理工具栏「一键安装内置插件」按钮复用同一方法。内置插件走 `file:` 本地源**不联网**，装完需重启服务生效。
- **搜索源**：npm 注册表 API（`/-/v1/search?text=dsh-plugin&size=100`）+ GitHub 官方话题页 `https://github.com/topics/dsh-plugin`。`keywords:dsh-plugin` 限定查询在 npmmirror 返回 0（镜像索引对 keywords 支持不完整），用纯文本 `text=<关键词>` + 本地过滤最稳。过滤规则 `_is_dsh_plugin_package`：包名/关键词/描述任一命中 `dsh`/`dsh-plugin`/`deepseek-harness` 才保留。
- **GUI 多窗口线程安全**：耗时操作（搜索/安装/移除）在 `threading.Thread` 中执行，结果用 `root.after(0, ...)` 回主线程刷新列表/弹窗；忙时禁用全部操作按钮防重入。
- **GUI 布局坑**：`ttk.Panedwindow` 必须显式 `.add(child, weight=N)` 注册子面板，否则中间区域完全空白。固定宽度容器里 pack 滚动条前，先确认内容（列宽总和）留足余量，否则滚动条被压缩成 1x1 不可见（`winfo_viewable()` 判真伪）。
- **"包装上了但没生效"根因：pnpm 非 0 退出码跳过官方 reconcile（2026-08-16 实测）**：pnpm 7+ 遇到 `ERR_PNPM_IGNORED_BUILDS`（安装含原生模块/构建脚本的依赖：ssh2/node-pty/cloudflared 等）时**以退出码 1 结束**（警告而非失败，包其实已写入 `dependencies`）。而 `dsh plugin` 的官方 reconcile（把声明 `dsh.bundle.patch` 的包写进 `dsh.profile.bundles`）**只在 `exitCode === 0` 时运行** → 退出码 1 时被跳过 → 包装上了但编排层（`dsh.profile.bundles`）没有它 → 重启后插件行不进树 → "没生效"。**排查顺序**：① 看 `profiles/<name>/package.json` 的 `dsh.profile.bundles` 是否含该包（不是看 dependencies/node_modules）；② 设 `DSH_HOME` 后 `dsh --profile web --dump-config` 看插件层；③ 有则重装/手动 `reconcile_bundles`。
- **启动器兜底同步编排层（2026-08-16 新增）**：`launcher.py` 新增 `reconcile_bundles(profile, removed=None)`——任何插件安装/移除/启停后，扫描 `dependencies` 把声明 `dsh.bundle.patch` 且未停用的包自动写进 `dsh.profile.bundles`，并清除本次移除/停用/不再声明 bundle 的包；**内置 bundle（`@deepseek-ai/dsh-base` / `dsh-web-app`）不在 dependencies 里，永不触碰**。`install_plugin` 容忍 pnpm 非 0（比较前后 dependencies，有新增即视为成功）；`run_plugin_command` 每次命令后兜底 reconcile；`remove_plugin` 传 `removed=[包名]` 强制清除。
- **启用/停用开关（2026-08-16 新增）**：插件管理窗口左侧"已安装插件"列表新增**状态列**（启用/停用/—）+「启用选中」「停用选中」按钮。停用 = 从 `dsh.profile.bundles` 移除 + 写入 `dsh.profile.disabled` 数组（launcher 维护）；启用 = 反向。**官方 reconcile 不识别 disabled 列表**，会把停用的包在下次命令时加回 → 必须由 launcher 在每次命令后重放停用状态（`reconcile_bundles` 已内置该逻辑）。启停后需**重启服务**才生效（GUI 有提示）。配套方法：`set_plugin_enabled()` / `get_plugin_state()` / `package_declares_bundle()`（读 node_modules 下该包 package.json 的 `dsh.bundle.patch`）。

### 3.3 数据维护（会话恢复 / 永久删除，dsh 官方无此能力）

- **dsh 没有"永久删除/取消归档"接口**：网页"归档"只是把会话隐藏（日志 + 注册表条目全保留）。
- **彻底删除需在服务停止后直接操作数据文件**，三处一并清理：
  1. `sessions/<工作区编码>/<会话ID>/` 日志目录（只按 id 遍历查找，**不拼接用户输入进路径，防路径穿越**）。
  2. `storages/workspace.json` 的 `sessionIds` / `archivedSessionIds`。
  3. `storages/session_projcache.json` 缓存行。
- **复原（取消归档）= 反向操作归档标记（2026-08-15 新增）**：`restore_session(session_id)` 只把 id 从 `workspace.json` 的 `global.archivedSessionIds` 中移除并原子写回即可——日志、工作区归属、投影缓存 dsh 本来就没动过，**天然无损、不删任何数据**。与 `purge_session` 完全相反（purge 动三个来源，restore 只动归档标记一处）。
- JSON 写回用 `_atomic_write_json`（同目录临时文件 + `os.replace`）保证原子性，避免半写损坏。
- **数据维护要求服务已停止**（GUI 弹窗提示、CLI `is_server_running()` 校验），避免与运行中的 dsh 竞争写文件。
- **界面形态（2026-08-15 改版）**：主窗口「数据维护」区只有一个「会话管理」按钮 → 弹出会话列表弹窗（Treeview：标题/工作区/状态/有无日志），首行「全选/全不选」，行点击勾选，底部「**恢复选中 (N)**」（只处理"勾选且已归档"会话）与「**删除选中 (N)**」两个按钮，均二次确认后逐个执行；GUI 承担全部删除/恢复，WebUI 插件页只读展示（实际启动时服务运行中，WebUI 删不了）。主窗口默认 920x720 保证无需缩放即可看到全部信息。
- **隔离测试**：复制真实 `workspace.json` 到临时副本 + monkeypatch `DSH_HOME_DIR` 指向副本，可安全验证恢复/删除逻辑，不碰真实数据；测试会话优先选"已归档且仍归属某工作区"的 id，以覆盖"恢复不丢归属"。
- **GUI 测试遍历坑**：遍历控件树断言用具体类型 `ttk.Treeview`/`ttk.Button` 递归收集，别用 `tk.Frame` 宽基类——`ttk.Frame` 不是 `tk.Frame` 子类，会一个都匹配不到。

### 3.4 绿色版自更新（双通道更新，2026-08-15）

分发给其他用户后存在**两条互不干扰的更新通道**：

- **通道①官方核心**：更新 `runtime/dsh/` 里的 dsh npm 包（即 3.1「检查更新」，只动 dsh 本体）。
- **通道②绿色版外围**：更新程序根目录 `launcher.py` / `DSH_Launcher.exe` / `plugins/` / 文档等，从本项目 GitHub Release 获取（GUI「检查绿色版更新」）。

**互不干扰的三个保证**：① 数据/环境各自隔离——核心只动 `runtime/dsh`，外围只动根目录；② 外围覆盖**跳过 `config.json`（用户配置）与 `runtime/`（用户数据 + 已装环境）**，绝不碰 dsh 环境；③ 两套独立查询接口与按钮，互不触发。

**版本追踪**：`GREEN_VERSION` 常量为**唯一来源**（发布时手动更新）；`green_local_version()` 只在该用户 `config.json` **显式写了 `green_version` 字段**时才覆盖（直接读原始配置文件判断，不读合并默认值）。GitHub Release tag 用 `v1.0.1` 形式，本地去 v 前缀后按**数字分段**比较 `_green_version_greater()`（`1.0.10 > 1.0.9` 成立，不依赖字符串长度）。
> **坑（v1.0.3 实测，详见 DEV_NOTES 需求 #20）**：版本号默认值**绝不能**写进 `DEFAULT_CONFIG`——曾留 `"green_version": "1.0.1"` 默认值 + `green_local_version()` 走 `config.get()`，config 合并后本地恒显示 1.0.1，导致 1.0.3 也反复提示更新（装上了也停不下来）。**教训**：版本相关默认值单点存放（GREEN_VERSION 常量），覆盖逻辑必须读原始 config.json；改 launcher.py 后要重打 exe + 绿色 zip 并替换 Release 资产（先删旧资产再传，否则 422）。

> **发布执行（2026-08-17，v1.0.7 实测，详见 DEV_NOTES 需求 #39）**：① 无 `gh` CLI、无 `GH_TOKEN` 环境变量时，用 **`git credential fill`**（stdin 喂 `protocol=https\nhost=github.com\n`）取 Windows 凭据管理器里的 PAT，再 urllib 直调 GitHub API（建 release、`POST /releases/{id}/assets` 传 zip、按 asset id 删旧资产，body 走 UTF-8 字节流）；② 打绿色 zip 用 **Python zipfile（stdlib）替代 Compress-Archive**，避免 PowerShell 转义/路径坑，并内置"根含 `LICENSE` + 无 `skills/*.zip` 嵌套"复核；③ **国内网络 github.com:443 常不可达但 api.github.com 正常**——git push 卡死而 API 通畅时，用 `curl --resolve github.com:443:<IP> https://github.com` 逐个测已知 IP（实测 `140.82.112.3` / `140.82.116.3` 可达），找到可用 IP 后可临时加 hosts 再 push；④ 用户要求"不单独打 Skill zip"时，绿色 zip 直接带 `skills/dsh-deploy-maintain/` 目录即可，Release 不再传 `DSH_Skill_*.zip`。

**查询与下载**：`green_latest_release()` **跟随下载源设置分流**（2026-08-20 用户需求，见 DEV_NOTES 需求 #85）——`config.mirror` 为 `cn`（含 auto 默认）时**先走 Gitee**（`green_gitee_latest()`：发布版 zip 直连 / 整仓快照），成功即返回，失败才回退 `api.github.com/repos/<owner>/<repo>/releases/latest` → 国内镜像 `mirror.nju.edu.cn/github-release/<owner>/<repo>/latest`；`mirror` 为 `official` 时才维持原 GitHub 优先、Gitee 兜底的三级降级。返回值统一带 `source`（`"github"` / `"gitee"` / `"gitee_release"`）。`confirm_green_update()` 的提示文案按"国内源优先（主动走 Gitee）"与"官方源兜底（GitHub 连不通）"区分语义。`green_find_zip_asset()` 按前缀 `DSH_Launcher_GreenPortable_Online_` + `.zip` 匹配资产；`download_green_update()` 下载到 `runtime/update/`（带进度），下载后**校验文件大小**（`size==0` 的整仓 zip 跳过校验），不符即删并抛异常。

> **追加坑（2026-08-19，GitHub 下载失败自动切 Gitee 兜底未生效）**：兜底**必须覆盖到"实际下载"这一步，不能只做查询兜底**。"api.github.com 可达能查到版本号，但 `releases/download` 大文件流被墙"是很典型的现象——此前只在 `green_latest_release()`(查询)做了 Gitee 三级降级，`prepare_update_content_root` 里 `download_green_update` 直接下 GitHub asset，失败就被 except 捕获直接弹窗，永远卡 GitHub。**修法**：GitHub 下载包 try/except，异常后调 `green_gitee_latest()` 拿 Gitee 镜像（优先"发布版 zip 附件直连"、无附件回退整仓快照 git 克隆）再 `green_find_zip_asset` 重下；加**防降级**（Gitee 版本号低于目标则放弃切换，避免装回旧版）；成功后改写 `release_info["source"]="gitee_release"`，调用方**在 `prepare_update_content_root` 之后再取 source**，保证失败提示/覆盖来源与真实下载源一致。

> **Gitee 兜底三坑（2026-08-18，详见 DEV_NOTES 需求 #48/#49 与避坑 #69/#70）**：① **Gitee 整仓 zip 接口是 `https://gitee.com/<repo>/repository/archive/<branch>.zip`**，不是 GitHub 的 `/archive/<ref>.zip`——套 GitHub 格式直接 404；② **Gitee 无 Release**，版本号改读 `gitee.com/<repo>/raw/<branch>/launcher.py` 源码，正则 `GREEN_VERSION\s*=\s*"([\d.]+)"` 提取（该常量是唯一版本来源，见需求 #20）；③ 整仓快照带 `DEV_NOTES.md`/`.gitignore` 开发侧文件 → `overlay_copy` 统一 `always_skipped_names=("DEV_NOTES.md",".gitignore")` 跳过，保证与 GitHub 发货清单覆盖结果一致。失败手动提示地址按 source 区分（github→`releases/latest` 发布页；gitee→仓库主页，因无 Release）。
>
> **Gitee 整仓 zip 实际拿不到（2026-08-18 实测，见 DEV_NOTES 需求 #49 / 避坑 #70）**：用户从 Gitee 网页"下载仓库 ZIP"按钮复制的 `repository/archive/master.zip` 地址，urllib 直接 GET 返回 **HTTP 200 但内容是 ~46KB HTML 挑战页**（`window._info`/`window._paths` + JS 轮询 checkURL），**不是真 zip**。纯 urllib 模拟拿不到真实包 → **改用 git 智能 HTTP 协议克隆整仓**（`green_gitee_clone_tree`）：`GET /<repo>.git/info/refs?service=git-upload-pack` 拿分支 head sha → `POST /<repo>.git/git-upload-pack`（want+done）拉 pack → 解析 pack 对象（普通 / REF_DELTA / OFS_DELTA 还原 delta）按 tree 落盘，只依赖标准库。集成要点：① `launcher.py` 需补 `import zlib`；② pack 对象前进位置用 `decompressobj().unused_data` 算消耗，别用 `unconsumed_tail`；③ REF/OFS_DELTA 要先读走未压缩前置字段（base sha / varint 负偏移）再解压 delta；④ sha 是 40 位 hex 串、pack key 是 20 字节 digest，匹配要 `bytes.fromhex()`；⑤ `green_gitee_clone_tree` 返回落盘文件数（int），`prepare_update_content_root` 的 Gitee 分支要返回 `target_dir` 本身。更新内容准备已拆成 `prepare_update_content_root(release_info, target_dir)`：github=下载 zip 解压，gitee=git 克隆整仓；`prepare_green_update` 改为接收 `content_root`。
>
> **Gitee 发布版 (Release) 优先于整仓克隆（2026-08-18 实测，见 DEV_NOTES 需求 #50 / 避坑 #71）**：Gitee **支持 Release + 附件**（网页"发布"页上传，上限 100MB；API v5 `POST /releases` + `POST /releases/{id}/attach_files`，需个人令牌 `projects` 权限）。**关键实测**：**手动上传的附件**（`browser_download_url = .../releases/download/<tag>/<file>`）**直连返回真实二进制，不走挑战页**；而 Gitee **自动生成的 tag 源码包**（`archive/refs/tags/<tag>.zip`）**仍走挑战页**。因此：① 建议每次发版用 `runtime/tmp/gitee_upload_release.py`（纯标准库 multipart）+ `upload_gitee_release.bat` 同步上传 zip 附件；② `launcher.py` 的 Gitee 通道两级策略：`green_gitee_latest()` 先查 `GITEE_RELEASES_API`（公开读）选"最新且带手动 zip 附件"的发布版（过滤条件 = 名字以 `.zip` 结尾 **且** URL 含 `/releases/download/`，否则会误选挑战页源码包）→ `source="gitee_release"` 走 zip 直连下载（与 GitHub 同路径）；无发布版才回退 `source="gitee"` 整仓克隆。所有按 source 分流/提示处要兼容 `in ("gitee", "gitee_release")`。
>
> **追加坑（v1.0.9 双平台分发实测，2026-08-18）**：Gitee 建 Release 的 API（`POST /api/v5/repos/<owner>/<repo>/releases`）**必须带 `target_commitish=<分支名>`**（如 `master`），否则返回 400 `target_commitish is missing`（GitHub API 无此要求）。body 传参用 `application/x-www-form-urlencoded`（`urlencode`）即可，无需 JSON。tag 需先推送到 Gitee 才能建 Release；建好后启动器更新会自动走"发布版附件直连"分支。删除旧附件用 `DELETE .../releases/{id}/attach_files/{attachment_id}`。

> **v1.0.10 多 zip 打包约定（2026-08-19）**：自 v1.0.10 起 Release 资产含 **3 个 zip**：① 绿色 zip（`DSH_Launcher_GreenPortable_Online_<日期>_v<ver>.zip`，更新匹配前缀）；② 技能 zip（`dsh-deploy-maintain_skill_v<ver>.zip`）；③ 插件 zip（`dsh-session-import_plugin_v<ver>.zip`，新增会话导入插件）。绿色 zip 用 `runtime/tmp/build_release_zip.py` 打包（该脚本是发布期临时生成，runtime/tmp 每次会被清理，发版前需重建；打包后用 `tar -tf` 校验 zip 根含 `plugins/`、`skills/dsh-deploy-maintain/` 前缀）。会话导入插件是 pnpm 拷贝到 profiles/web，新机装绿色版后需到「插件管理」手动重装本地插件才生效（同 dsh-file-browser）。
>
> **v1.0.11+ 精简约定（2026-08-19，用户要求）**：**不再单独把插件或技能打 zip 上传 Release**——插件（`plugins/`）与技能（`skills/dsh-deploy-maintain/`）本来就在仓库里、且已打进绿色 zip（含 `plugins/`、`skills/dsh-deploy-maintain/` 顶层目录）。发布只做：① 重打 `DSH_Launcher.exe` / `DSH_Update.exe`；② 只生成**一个**绿色 zip；③ 双平台 Release 只上传这个绿色 zip。

> **官方反馈渠道（2026-08-18 实测）**：`deepseek-ai/deepseek-harness` 官方仓库**已开启 Discussions**（`has_discussions=true`），外部反馈可直接发帖（分类含 General/Q&A/Ideas/Polls/Show Your Plugins/Announcements）。**创建 Discussion 只能用 GraphQL**（REST API 不支持）：先查 node id（`repository(owner,name){id}`、`discussionCategories{id}`），再 `mutation { createDiscussion(input:{repositoryId, categoryId, title, body}) }`。**token 权限注意**：fine-grained PAT 即使有 `repo` 也只对"已选仓库"生效，对外部仓库（deepseek-ai）报 `Resource not accessible by integration`；**classic PAT 带 `repo` scope 可对外部公共仓库建 Discussion**。发反馈前先 `npm pack @deepseek-ai/<pkg>@latest` 拉官方 tar 包核对源码，确认问题是否已被官方修复、贴出官方代码行号 + 推荐 diff，维护者能直接定位。

**安全解压**：`_safe_extract_zip()` 逐成员 `os.path.normpath` 检查，拒绝绝对路径与 `..` 前缀（防 zip-slip 路径穿越）；`_detect_zip_content_root()` 兼容「zip 是整文件夹」与「zip 内直接是文件」两种形态——解压后仅一个顶层目录且含 `launcher.py`/`start.bat`/`DSH_Launcher.exe` 标志文件则判定为外层文件夹，返回内层作为内容根。

> **zip 目录结构坑（2026-08-16，需求 #21，绿色版 v1.0.3 实测）**：`Compress-Archive -Path launcher.py, ..., "plugins", "skills"` 必须传**目录名** `"plugins"` / `"skills"`（zip 内保留 `plugins/`、`skills/` 前缀）。**不能**传 `"plugins\dsh-archive-purge"` 这种子路径——PowerShell 会把该目录直接打在 zip 根、**丢掉 `plugins/` 前缀**，更新覆盖时 `robocopy` 把插件错位拷到程序根目录。**双保险**：① 发布侧打包命令传目录名（README 已修正）；② 更新侧 `_normalize_update_structure()` 在 `prepare_green_update()` 解压后把 content_root 下错位的 `dsh-archive-purge`/`dsh-file-browser`/`dsh-session-rewind`/`dsh-deploy-maintain` 归位到 `plugins/` / `skills/`（正确位置已存在则跳过，以 zip 内正确结构为准），且 update_apply.bat 第 2.5 步**清理程序根目录的错位残留**（只删这 4 个已知旧目录，不碰用户数据/config/runtime）。打包后建议 `tar -tf xxx.zip` 确认 zip 根下有 `plugins/`、`skills/` 文件夹。

**覆盖安装（独立更新程序 `DSH_Update.exe`，2026-08-18 替代 update_apply.bat）**：启动器自身文件被锁定无法自替换 → `launch_update_agent(job_path)` 用 `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` 启动独立更新程序，启动器随即退出，由更新程序在独立进程里完成：① 读 `runtime/update/update_job.json`（含 `base_dir`/`content_root`/`backup_dir`/`relaunch_mode`/`new_version`/`manual_release_url`/`manual_zip_url`）→ ② **自我复制到 `runtime/tmp` 从副本运行**（释放根目录更新程序文件的锁，让新版更新程序也能被覆盖）→ ③ 等本体退出释放文件锁 → ④ 备份旧文件到 `runtime/update/backup/` → ⑤ 覆盖（跳过 `config.json`/`runtime/`/`.git`）→ ⑥ 重启新版。全程 tkinter 进度窗口，**失败弹窗给出手动下载地址**（GitHub 发布页 + 更新包直链）。

**独立更新程序关键避坑（2026-08-18 实测，详见 DEV_NOTES 需求 #47 / 避坑 #68）**：
- **运行中的 exe 无法原地覆盖**（Windows 以 `FILE_SHARE_READ` 打开执行中的 exe，进程存活期间不可写/删）→ 更新程序先把自己 `shutil.copy2` 到 `runtime/tmp/DSH_Update_worker.exe` 再从副本重启、原进程退出；副本的 `_self_name()` = worker 名，覆盖时不再跳过根目录 `DSH_Update.exe`，新版更新程序也能装进去。**判定要严谨**：用 `os.path.normcase` 比较绝对路径，仅当"自身就是根目录更新程序"才迁移，从副本二次运行时直接走正常覆盖，**不能无限复制重启**。
- **不轮询 PID，改轮询 exe 文件锁**：等待本体退出用 `_can_open_write`（`os.open` 以写方式试探 `DSH_Launcher.exe`），能打开 = 锁已释放。启动器退出后 PID 被 Windows 立即复用，轮询 PID 会死循环（避坑 #44）。
- **DSH_Update.exe 内嵌 python**，打包必须带 `VC_BINARIES` 三件套（`vcruntime140*.dll`），否则目标机同样报 `Failed to load Python DLL`（避坑 #67）。
- 用 `shutil.copy2` 逐个复制比 `robocopy` 更可控：失败能精确定位到具体文件并在 GUI 给可读错误。
- 兜底：根目录无 `DSH_Update.exe` 时用内置 python 跑 `update_agent.py --apply <job>`（同样带自我复制迁移，worker 名 = `update_agent_worker.py`）。

**发布 Release（含中文正文）的编码坑**：用 GitHub API（PowerShell）创建/更新 Release 时，即使 `ConvertTo-Json` + `[System.Text.Encoding]::UTF8.GetBytes()` + `-ContentType "application/json; charset=utf-8"`，正文中文仍可能全变 `?`——因为 **Windows PowerShell 5.1 会把"无 BOM 的 UTF-8 .ps1"按系统 ANSI（GBK）读取**，脚本里写的中文字符串字面量在内存里已乱码，后面怎么编码都救不回。**正确做法**：发布脚本保持**纯 ASCII**（不写一个中文字符），中文正文单独放一个 UTF-8 文本文件，脚本里 `[System.IO.File]::ReadAllText(路径, [System.Text.Encoding]::UTF8)` 显式按 UTF-8 读入再发送。校验也别用 PowerShell 的 `-match "中文"`（同样会被 ANSI 读乱），导出 body 到 UTF-8 文件后用 python 检查是否含关键中文且无 U+FFFD/`?`；资产下载 URL 用 `curl.exe -s -I -L` 验证 200。**本经验已同步至 `DEV_NOTES.md` 避坑 #43。**

**英文 README（README_EN.md，2026-08-16 约定）**：中文 README 是唯一维护主体，英文版**只在发布新版本时翻译更新一次**（供国际用户参考，中文为准）。打包绿色分发 zip 时**必须显式把 `README_EN.md` 加入 `-Path`**，并同步更新中文 README 顶部的语言切换指引行。

**绿色分发 zip 的"发货清单"（避坑 #55/#57，2026-08-17）**：Release zip 内容与 **GitHub 仓库（main）保持一致**（用户约定：`DSH_Launcher.exe` 也提交进仓库，Release 与仓库同源）：`launcher.py, start.bat, stop.bat, build_exe.bat, DSH_Launcher.exe, DSH_Launcher.ico, config.json, README.md, README_EN.md, LICENSE, "plugins", "skills"`——**不含** `DEV_NOTES.md`、`.gitignore`、`runtime/`；切忌漏 `.ico`（脚本版窗口/托盘图标、exe 已内嵌）。`skills/` 整目录打包会误入 `skills\*.zip` 残留，打包前 `Move-Item skills\*.zip %TEMP%\` 清走。打包后 `tar -tf` 核对：zip 根要有 `plugins/`、`skills/`、`DSH_Launcher.exe`、`DSH_Launcher.ico`、`LICENSE`，且**不含** `skills\*.zip`、`runtime/`、`DEV_NOTES.md`。配套坑：内置 Python 用 `py -3` 会选系统 3.13、触发 tarfile 的 3.14 DeprecationWarning；`prepare_python()` 的 `extractall` 已按 `sys.version_info >= (3,12)` 决定是否传 `filter="data"`（3.10 省略）。

**bat 启动绿色版必须用 pythonw，不能用 python（避坑 #60，2026-08-20）**：用 `python.exe`（控制台子系统）跑 GUI，那个 cmd 窗口就是启动器进程本体——用户关掉它会被 Windows 直接强杀（GUI+托盘一起没了，走不到 `on_close`），而 dsh 服务是独立 node 子进程，结果"程序关了、托盘没了、服务还在跑"。**start.bat 改用 `pythonw.exe`（GUI 子系统、无控制台）`start "" "<pythonw>" launcher.py` 后立刻返回**，自带 cmd 窗口一闪即关，之后没有可误关的控制台（exe 打包本就是 `--windowed` 同理）。关闭交互上，`on_close` 用自绘三选一 `ask_close_choice()`：「退出并停止服务」/「最小化到托盘(服务继续)」→ 调 `minimize_to_tray()` 保留任务栏+托盘入口、`return` 不退出 /「取消」；`confirm=False`（自更新）仍直接退出不多问。

**GUI 里"待保存"的设置 vs 已落盘 config 的脱节（避坑 #61，2026-08-20）**：tkinter 下拉/条目是内存里的"待保存"临时值，如果某操作直接读已落盘的 `config` 而忽略界面当前值，就会出现"界面显示 A、实际却按 B 执行"的误判——典型是改了「局域网」没点「保存设置」就点「启动服务」，服务仍绑 127.0.0.1 但界面显示局域网。**经验：启动类动作前，先把界面当前值同步进 config 并 `save_config()` 落盘，转换规则与「保存设置」保持一致、静默执行不弹窗**（失败仅警告不阻断）。这里只同步与"显示/实际"强相关的网络两项（绑定方式 `dsh_host`、受信任主机 `trusted_hosts`），端口/镜像等无同样歧义且带校验的项仍走显式保存。**闭包命名坑**：`on_start` 定义在 `bind_var`/`trusted_var` 之前（同在 `run_gui` 内）也 OK——闭包在**调用时**解析，按钮点击时变量已赋值。

**局域网 403（避坑 #56，2026-08-17）**：WebUI 报 `transport failure for /api/host.pickDirectory: HTTP 403` = dsh `client-connection` 的 `/api` 信任围栏默认 pin 死 loopback，局域网模式（0.0.0.0）下用局域网 IP 访问**全部 /api 都 403**（页面能开但 API 全挂）。`dsh-web-app` 的 `resolveLanTrust()` 算了 `lanAddresses`（本机局域网 IPv4）并通过 `webRuntime` 服务提供，但 client-connection 没用它。**幂等补丁 `patch_lan_api_trust()`**（launcher.py，`install_dsh()` 与 `start_server()` 自动重打；**调用处检查返回值，失败输出 `[警告]`**，让"装了才发现局域网用不了"变成可见提示）：`apply()` 里 `trustedHosts` 为空时自动并入 `ctx.get("webRuntime").lanAddresses`，并把特权方法的 `isTrustedApiRequest(request, [])` 改为 `isTrustedApiRequest(request, trustedHosts)`。CSRF（sec-fetch-site/origin 校验）保留；只信任本机网卡真实地址，伪造 IP 依然 403。结构不匹配时宁可跳过不硬改。全新用户 exe 首装即自动补齐（`install_dsh` 内）。
> **追加坑（避坑 #58，2026-08-17）**：**"本机模式也 403"是 Chrome 150+ 的 Origin 序列化问题**——Chrome 150 对 `http://127.0.0.1:3080` 页面的同源请求发送**不带端口的 Origin（`http://127.0.0.1`）**，官方 `new URL(origin).host === hostUrl.host` 把 `"127.0.0.1"` 与 `"127.0.0.1:3080"` 判为不等 → 本机/局域网模式**全部 /api 都 403**（页面加载的 host.describe 等也挂）。且 curl 模拟（Origin 手动带端口）**复现不出**，误导排查。**解决**：补丁升级 v3——`isTrustedApiRequest` 的 Origin 校验改 hostname 比较（忽略端口），并在全部 403 出口（fetchHandler/route/websocket/register/interceptor）加诊断日志（记录 url/method/ua/origin/host/sec-fetch-site/referer/trustedHosts，写进 server.log），用 UA 字段区分真实浏览器与脚本模拟。**排查经验**：服务端对 Origin/Host 校验别用"带端口精确相等"；403 定位第一步是给被拒出口加含 UA/Origin 的日志。`host.pickDirectory` 放行后无人交互会**超时挂起** = native 目录选择器弹窗等用户（worker.cjs 阻塞 Win32 `Show()`），真实浏览器弹窗选完即返回，非 bug。
> **追加坑（v1.0.3 发布，避坑 #46）**：`powershell -File script.ps1` 执行时，`$str | git credential fill` 这类"字符串管道到原生命令"会**静默失效**（交互式 PowerShell 正常，`-File` 模式报 `missing protocol field`）。取 git 凭据别用这条管道——先在交互终端把 token 存 `$env:GH_TOKEN`，脚本 `if ($env:GH_TOKEN) { $token = $env:GH_TOKEN.Trim() }` 读取（原逻辑作兜底）最稳。
>
> **追加坑（v1.0.3 实测，避坑 #47）**：分离进程里千万别用 `ping -n` 做等待延迟——实测下载没问题、退出启动器后 `update_apply.bat` 等待循环**不断弹 ping 窗口一闪一退**，且弹了几次后报 **"ping.exe application error（0xc0000142 = DLL 初始化失败）"**，安装永远不完成（系统 ping.exe 损坏 + 无控制台进程调控制台程序会新建窗口闪烁）。**全部延迟改用 `wscript.exe "%~dp0sleep_helper.vbs" <毫秒>`**（GUI 子系统不闪窗、Windows 全自带），详见 DEV_NOTES 需求 #19 / 避坑 #46。

### 3.5 会话回退（dsh-session-rewind WebUI 插件，2026-08-15 加入内置）

- **问题**：DSH 回合因工具运行时失效（`Cannot read properties of undefined (reading 'prepare')`）崩溃时，崩溃回合会在会话日志里留下**孤儿 `tool_calls`**（有调用、永远没有结果），之后每一轮对话都被 DeepSeek API 以 400 拒绝，会话**永久毒化**；DSH 0.1.0-rc.6 没有"删除失败消息"的界面功能。
- **方案**：内置 `dsh-session-rewind` 插件在 WebUI 设置页新增「会话回退」页：列出全部会话 →「分析」任意会话（逐回合：用户问题/步骤数/工具调用数/错误码统计/是否完成）→ 在任意**已完成**回合点「回退到此」走官方 `session.fork`（`{sessionId, atSeq}`）从该回合之后**派生一个干净的续接会话**并自动打开；原会话保留不动（可再交「会话管理」清理）。**界面为卡片式布局（2026-08-16，与 dsh-usage-stats 同风格）**：会话卡片标题独占整行完整换行 + 下方 ID 与元信息 chips（工作区/创建时间/状态）；逐回合卡片用户问题独占整行完整可读 + 下方回合号/步骤/工具调用/错误徽标/「回退到此」。
- **为什么派生而非原地删消息**：服务运行时会话由持久化层在内存缓存，原地改写磁盘日志会被内存状态覆盖或造成 seq 断裂，不安全；官方 `session.fork` 正是为此设计的机制（与官方 UI 自带「分支」同源，官方只暴露末位回合，本插件放开到任意回合）。
- **实现要点**：宿主端直接按磁盘扫描 `DSH_HOME/sessions/**/session.jsonl.zstd`（zstd 多帧，用官方 `@deepseek-ai/dsh-session` 的 `decodeStorageRecord` 展开事件，对 chunk-run 打包行布局无关）；回退动作走官方 `session.fork` + 客户端 `sessions.open`，与服务端持久化层一致。接口带自定义头 `X-DSH-Plugin-Rewind: 1` 防 CSRF。
- **配套 tools/**：`rewind-session.mjs`（服务停止时的**离线原地回退**：直接把会话日志截断到最后一个完整回合，自动备份）；`apply-agentloop-guard.mjs`（给 `dsh-agent-loop` 工具派发入口加存在性检查，把晦涩报错变成明确的可操作提示，幂等、可反复执行，dsh 升级后重跑一次即可）。
- **排查"会话突然全部 400"**：先看 `server.log` 有无该 bug 签名（`Cannot read properties of undefined (reading 'prepare')`）→ 用插件「分析」定位崩溃回合 → 在崩溃回合之前的**已完成**回合「回退到此」派生干净续接会话。

### 3.6 启动器 GUI 增强：X 关闭二次确认 + 最小化到系统托盘（2026-08-16）

- **需求**：误点右上角 X 直接退出难受 → 加**二次确认**；最小化希望"不打扰"（首版：缩到系统托盘、任务栏消失）。
- **X 二次确认**：`root.protocol("WM_DELETE_WINDOW", on_close)`，`on_close` 里 `messagebox.askyesno` 确认后才停服务销毁窗口；绿色版自更新流程传 `confirm=False` 跳过重复询问。
- **【演进 2026-08-16 双常驻】最小化不再隐藏窗口、托盘从启动就常驻**：首版"最小化→`root.withdraw()` 隐藏进托盘（任务栏没图标）、恢复→`remove()` 删托盘图标（托盘又没了）"，一来一回两头都看不见，用户实测反馈"容易误以为程序退出了"。改为**任务栏 + 托盘双入口始终可见**：
  - **最小化只进任务栏**：`minimize_to_tray()` 由 `root.withdraw()` 改为 `root.iconify()`（最小化到任务栏，**任务栏图标保留**）；托盘 `tray_icon.add()` 保持幂等调用（已常驻则直接返回 True）。
  - **托盘从启动就常驻**：`SysTrayIcon` 构造成功后立即 `tray_icon.add()`（启动即显示托盘图标，失败不抛异常）；点托盘恢复 `restore_from_tray()` 只 `root.deiconify()`，**不再 `remove()` 托盘图标**。
  - **效果**：任务栏图标 + 托盘图标同时常驻，任一点击都能恢复窗口，不会让用户误判程序退出。
- **最小化到托盘（纯 ctypes + Win32，零第三方依赖）**：
  - `Shell_NotifyIconW` 加/删托盘图标（`_NOTIFYICONDATAW` 结构，Vista+ 版）；图标取 `WM_GETICON` → 类图标 → 兜底 `LoadIconW(IDI_APPLICATION)`。
  - `SetWindowLongPtrW` 子类化窗口过程（`WINFUNCTYPE` 回调 + `ctypes.cast(回调, c_void_p).value` 取地址）拦截：`WM_SYSCOMMAND/SC_MINIMIZE`（点最小化 → `add()` 托盘图标，**窗口本身交给 `root.iconify()` 缩到任务栏，不再 `withdraw()` 隐藏**）与自定义 `WM_TRAY_CALLBACK`（左/右键单击图标都恢复窗口）；其余消息必须 `CallWindowProcW` 放行。
- **避坑（实测定点，见 DEV_NOTES 需求 #24/#25）**：
  - **窗口过程挂钩必须在 `__init__` 里装，不能放 `add()`**——否则第一次点最小化时托盘图标还没出现 → 漏拦截 → 窗口进任务栏而非托盘。
  - **`remove()` 只删托盘图标，不能还原窗口过程**——还原窗口后再次最小化要靠挂钩保持；退出前才用 `dispose()`（`remove()` + `_unhook_wndproc()`）还原，避免窗口销毁后回调对象悬空。
  - **`winfo_id()` 返回的是 Tk 内部子窗口（`TkChild`），不是真实顶层窗口（`TkTopLevel`）**；且构造时若窗口尚未 realize，顶层窗口还没创建。必须先在 `__init__` 里 `root.update_idletasks()` 强制 Tk 完成窗口创建，再用 `GetAncestor(inner, GA_ROOT)`（显式设 `argtypes`/`restype=c_ssize_t` 防 64 位截断）拿真实顶层 HWND 挂钩——否则钩子挂错窗口，最小化消息收不到、照样进任务栏。
  - **WndProc 回调里绝不能直接调 Tk（`after`/`withdraw` 等）**——消息派发中途重入 Tcl 会在下一轮 `update()`/`mainloop` 报 `PyEval_RestoreThread: the function must be called with the GIL held, but the GIL is released` 崩溃。**正确做法：WndProc 里只做纯 Python 赋值**（拦截 `SC_MINIMIZE` → 置 `_minimize_pending=True`；托盘点击 → 置 `_restore_pending=True`，`return 0`），另起 `root.after(80, ...)` 常驻轮询 `poll()` 在正常 Tk 事件上下文里消费标志、执行最小化/恢复。
  - **`--windowed` exe 下 `sys.stderr=None`**：WndProc 里任何输出都会抛异常被 ctypes 吞掉 → 消息被"吃掉"却无动作。回调内不输出 + 全程 try/except，异常一律放行给原窗口过程。
  - ctypes 必须显式设 `argtypes`/`restype`（`c_ssize_t` 等），否则 64 位下句柄/指针被截断；`Shell_NotifyIconW`/`SetWindowLongPtrW` 要传整数指针，不能直接传 `WINFUNCTYPE` 回调对象。
- **验证**：`runtime/tmp/smoke_tray.py`（加/删幂等）、`smoke_tray2.py`（第一次最小化进托盘 + 恢复后再最小化仍进托盘）、`smoke_gui3.py`（端到端 `run_gui`）、`probe_tray_real.py` / `probe_tray_roundtrip.py` / `probe_tray_exe.py`（外部起真实 GUI/exe + PostMessage SC_MINIMIZE，判定 C 即 `IsWindowVisible=0` 为托盘成功；判定 A `IsIconic=TRUE`=钩子没拦到；判定 B 可见非图标=拦截了但 add/隐藏没生效）。
  - **【双常驻新标准 2026-08-16】不再要求窗口隐藏**：双常驻下最小化后窗口只是 `IsIconic=TRUE`（任务栏图标在、窗口缩小），**`IsWindowVisible` 仍为 1**；托盘图标常驻（启动即有、恢复不删）。验证改为：最小化后 `IsIconic=TRUE` 且托盘图标仍在；托盘恢复后 `IsIconic=FALSE` 且托盘图标仍常驻。

### 3.7 启动器自定义图标（窗口 + 托盘 + exe 三处统一，2026-08-16）

- **需求**：默认 PyInstaller 图标（"小火箭"）任务栏/托盘/exe 都一样，分不清哪个是 DSH 绿色版。用 seedream 生成 4 个候选（A 绿色小鲸鱼 / B 青龙盾徽 / C D 字闪电标 / D 蜀汉军旗），选定 **A 绿色小鲸鱼**（DeepSeek 品牌鲸鱼 + 金色启动闪电，绿色传达"绿色版"）。源图 `runtime/tmp/icon_design/option_a_green_whale.jpg`。
- **转 ICO**：Pillow（临时装到 `runtime/tmp/pillow_convert/`，不碰系统 Python / C 盘）按短边居中裁方后 `image.save("DSH_Launcher.ico", format="ICO", sizes=[16,24,32,48,64,128,256])`（84KB，7 尺寸）。
  - **避坑**：ICO 保存别用 `append_images` 手动塞帧（会得到仅 600 多字节的空壳），直接传 `sizes` 让 Pillow 内部缩放；回读 `Image.open(...).info.get("sizes")` 应得 7 个尺寸。
- **三处接入**：`get_icon_path()`（frozen 时从 onefile 临时目录 `_MEIPASS` 取，源码模式取程序根目录，找不到返回 None）：
  - **窗口**：`root.iconbitmap(icon_path)`（try/except 静默降级）；
  - **托盘**：`SysTrayIcon._get_icon()` 优先 `LoadImageW(None, icon_path, 1, 0, 0, 0x10|0x40)`（IMAGE_ICON + LR_LOADFROMFILE|LR_DEFAULTSIZE）从 .ico 加载 HICON，失败再退回 `WM_GETICON` → 类图标 → `LoadIconW(IDI_APPLICATION)`；
  - **exe**：`build_exe.bat` 加 `--icon "%~dp0DSH_Launcher.ico"` + `--add-data "%~dp0DSH_Launcher.ico;."`。
- **避坑（build_exe.bat 实测）**：`--add-data` 的源路径按 **spec 目录**（`--specpath build`）解析，**必须写绝对路径 `%~dp0...`**，否则报 `Unable to find '...\build\DSH_Launcher.ico'`；而 `--icon` 按当前目录解析可直接写相对路径。
- **验证**（不开 GUI，`runtime/tmp/icon_design/verify_icon.py`）：ICO 文件头 `00000100`；`shell32.ExtractIconExW(exe, 0, ...)` 数 exe 内嵌图标 > 0；`launcher.get_icon_path()` + `LoadImageW` 拿到有效 HICON。注意 **`ExtractIconExW` 在 shell32.dll**（不在 user32）。详见 DEV_NOTES 需求 #26。
- **【鲸鱼放大/去圈 2026-08-16】图标主体最大化**：用户反馈 v1 图标"外围一圈绿色太多、鲸鱼图案太小"。用 `runtime/tmp/icon_design/whale_v3.py` 重做——**颜色阈值标主体**（亮绿 G>160 且 R<150、黄闪 R>200）→ **行列密度过滤**（保留 ≥ 最大列/行计数的 5% 的列/行）剔孤立边角像素（鳍/水印）得**紧主体包围盒** → 以中心扩正方形、边距 `MARGIN_RATIO=0.01` 收紧到最小、主体铺满画布 → **主体外像素置透明**（正式版 `DSH_Launcher.ico`）/深绿底 `(0,83,41)`（备选 `DSH_Launcher_bg.ico`）。实测**主体包围盒 98%×81%**（占画布）、不透明像素 35.7%，识别度明显提升；`verify_v3.py` 输出各小尺寸放大拼图检查可读性。详见 DEV_NOTES 需求 #33。
- 通用 tkinter 图标经验已同步 `skills/python-tkinter-desktop-dev.zip`（6.10 自定义 .ico + 检查清单 + `tray_icon_template.py` 模板）。

### 3.8 用量统计 + 消息行「本次token」（dsh-usage-stats 插件，2026-08-16 加入内置，v0.2.0 合并）

- **功能**：一个插件两个功能面、统一安装/卸载——①「设置 → 用量统计」面板：扫描全部会话日志按模型汇总 token 用量 + 费用估算（价格表可编辑）；② 对话消息行上方常驻显示 `本次token：输入(未命中) X · 输入(命中缓存) Y · 输出 Z · 思考 R`（与价格表同口径：输入未命中 = inputTokens+cacheWriteTokens、输入命中缓存 = cacheReadTokens、思考已计入输出不重复计费；该回合所有 `assistant/message` 的 `usage` 求和，k/M 缩写）。
- **数据链路**：宿主端复用 session-rewind 的扫描解码机制（`DSH_HOME/sessions/**/session.jsonl.zstd` zstd 多帧 + 官方 `decodeStorageRecord`）；`assistant/message` 事件的 `usage`（`inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`/`reasoningTokens`）即模型实际报告用量，模型名取 `message.source.model`；**费用不在日志里**，客户端按官方计费口径估算——`费用 = 输入(未命中缓存)×未命中单价 + 输入(命中缓存)×命中单价 + 输出×输出单价`（`inputTokens+cacheWriteTokens`→未命中列、`cacheReadTokens`→命中列、`outputTokens`→输出列，`reasoningTokens` 已计入输出不重复计费）。
- **默认价格 = 官方【高峰时段】价（2026-08-17 更新）**：DeepSeek 官方改为峰谷定价（北京时间高峰 9:00-12:00 / 14:00-18:00，高峰为低谷 2 倍）。插件默认取高峰价（估算偏保守）：`deepseek-v4-flash` 命中 0.10 / 未命中 3.0 / 输出 9.0；`deepseek-v4-pro` 命中 0.30 / 未命中 9.0 / 输出 27.0（元/百万 tokens）。**升级价格表必须同时改 `PRICES_KEY`（localStorage 键 v2→v3）**——否则用户浏览器里存的旧价格永远覆盖新默认价；改键后 loadPrices 读不到新键即回退新默认，无需清缓存。UI 提示文字要写清"默认官方高峰价，可按实际价格/时段修改"。
- **界面布局教训（卡片式而非表格）**：固定列宽的横向表格在窄面板下标题只显示半个字——改成**卡片式纵向流**：标题/用户消息**独占整行**（`wordBreak: break-word`）、元信息用 `flex-wrap` chips 自动换行、明细在卡片内展开。
- **消息行显示实现**：走官方链式插槽 `conversation.chat.turnTail`（操作行**上方**内容区）——`ctx.slots.register({ name: "conversation.chat.turnTail", priority: -10, select: (owner) => ({ turn: owner.turn, seq: owner.seq }) }, 组件)`，组件拿 `matched` + `useSession`，从 `snapshot.nodes`（`kind==="assistant"` 且 `turn` 匹配）求和 `usage`；无数据静默不渲染。
- **验证**：`node --check` 语法 + 无头 Edge CDP 实测（见 4.9 / DEV_NOTES 避坑 #51）。

### 3.9 启动器单实例（防重复启动，2026-08-16）

- **需求**：用户可能多次打开启动器，每次都会尝试起服务、浪费资源。要求第二次打开时把已运行的窗口调到前台、自身退出。
- **实现 = 命名互斥量 + 旧窗口激活**（纯 Win32，零依赖）：
  - **互斥量**：`kernel32.CreateMutexW(None, False, "DSH_Launcher_GreenPortable_SingleInstance")`，`GetLastError()==183(ERROR_ALREADY_EXISTS)` 即已有实例。
  - **关键避坑**：互斥量句柄必须由实例**整个生命周期持有**（存模块级变量），否则 Python GC 释放句柄后互斥量消失，之后再开的实例误判为第一个 → 单实例形同虚设。创建失败（句柄 0）降级放行。
  - **旧窗口激活**：`user32.FindWindowW(None, WINDOW_TITLE)` → `ShowWindow(hwnd, SW_RESTORE=9)`（同时恢复最小化+隐藏）→ `SetForegroundWindow` → `BringWindowToTop` 兜底。新实例是当前前台进程，合法让位，`SetForegroundWindow` 通常有效。
  - **插入位置**：`run_gui()` 开头、`tk.Tk()` 创建主窗口之前（在 `Launcher()` 实例化之后即可），避免重复初始化再退。
  - **降级重试**：互斥量在但 `FindWindow` 找不到窗口（旧实例仍在初始化）→ 重试 10 次（0.3s）→ 仍失败弹 warning 让用户处理残留进程。
  - **窗口标题常量化**：`root.title(...)` 的标题提取为模块级 `WINDOW_TITLE`，查找与创建共用同一字符串，避免硬编码不一致找不到窗口。
- **CLI 不拦截**：`--start` 等命令模式不创建互斥量，保持"启动(或复用已运行)服务"原语义。
- **验证**：`verify_single_instance.py`（互斥量创建/释放幂等）+ `verify_activate_window.py`（真实窗口三种状态：正常/最小化 `IsIconic=TRUE`/托盘隐藏 `IsWindowVisible=FALSE` → 激活后均恢复可见）。详见 DEV_NOTES 需求 #29。
- **冒烟/自动化测试 run_gui 前先查残留互斥量（2026-08-16 实测）**：测试进程异常退出/被杀可能残留命名互斥量，导致后续 `run_gui()` 的单实例检测误判"已有实例" → 走「激活旧窗口→找不到→弹 warning→return」分支，**根本进不了 mainloop**（表现为 GUI 自动化脚本里 fake_mainloop 完全不触发）。先用 `probe_mutex_state.py`（`CreateMutexW` + `ctypes.get_last_error()==183` 判占用）检查，有残留就 `tasklist`/`Stop-Process` 清掉对应 python/DSH 进程再测。

### 3.10 局域网远程访问 WebUI（2026-08-16）

- **需求**：服务端部署在一台电脑，WebUI 从局域网内其它电脑的浏览器远程打开（未来还可能用 WebUI 连不同地址的服务器）。
- **实现方式 = 直接绑定 `0.0.0.0`**（用户选定）+ GUI「网络设置」区 + `config.json`（`dsh_host` / `trusted_hosts`）。`trusted_hosts` 语义：**空=局域网模式自动信任全部局域网 IP（默认全网段开放）；填了任意一个=只信任显式填写的地址**。
- **四个必须一起改的点**（漏一个远程都连不上/心跳失效/信任范围不对）：
  1. **放开 0.0.0.0 补丁**：dsh 官方 `dsh-web-app/lib/startup.js` 有 `if (options.host === "0.0.0.0") program.error(...)` **刻意拒绝**绑定 0.0.0.0（防把远程工具执行能力暴露到局域网）——这是**唯一需要补丁的点**（后端 schema 本身允许 0.0.0.0）。启动器 `patch_web_startup()` 把该条件替换为 `false /* dsh-launcher: 已放开 0.0.0.0 以支持局域网访问 */`（幂等，marker 已替换则直接返回 True）。**关键避坑：dsh 升级 = 重装 `runtime/dsh` 会覆盖 startup.js 还原补丁** → 必须在 `install_dsh()` 末尾 + `start_server()` 启动前各调一次兜底。
  2. **心跳脚本适配**：`patch_frontend()` 注入的心跳脚本原硬编码 `http://127.0.0.1:<port>`，远程页面拿不到 → 改 `"http://" + location.hostname + ":<port>..."`（页面自动用其所在主机名上报）。
  3. **心跳服务绑定联动**：`_ensure_ui_beacon_server()` 绑定地址随 `dsh_host` 变化——`0.0.0.0` 模式绑 `0.0.0.0`（远端浏览器才能上报），否则 `127.0.0.1`。
  4. **受信任主机精确语义补丁（2026-08-16 新增）**：官方 `resolveLanTrust`（`dsh-web-app/lib/index.js`）绑定 0.0.0.0 时**无条件** `trustedHosts: [...lanAddresses, ...extra]`（自动把全部局域网 IP 并入信任列表），导致填了 `trusted_hosts` 仍全局域网放行（"填了也白填"）。启动器 `patch_lan_trust()` 改为 `extra.length === 0 ? [...lanAddresses, ...extra] : [...extra]`——空=默认自动信任全部局域网，非空=只信任显式填写的（`lanAddresses` 字段保留供 LAN 地址显示）。同样 `install_dsh()` + `start_server()` 两调用点兜底（升级重装会还原）。
- **信任围栏与特权方法**：`trusted_hosts` 为空且绑定 0.0.0.0 时，dsh 的 `resolveLanTrust` 把**全部非内网 IPv4 自动加入 trustedHosts** → 整个局域网网段自动放行，无需手动填受信主机；`trusted_hosts` 非空时（补丁后）只信任显式填写的地址。**注意 dsh 信任围栏是按请求 Host（服务器地址）判定，不是按客户端设备 IP**——"只信任填写的"等价于"只允许通过填写的服务器地址访问 /api"，要按客户端设备限制需另加鉴权层。`PRIVILEGED_METHODS`（settings/credentials/host.pickDirectory 等）**即使 LAN 部署也仅回环可调** → 远程浏览器能聊天/用工具，但**不能改设置与凭据**（远程返回 403，官方安全保护）。
- **启动命令**：`build_server_command()` 从 config 追加 `--host <dsh_host>` + 多个 `--trusted-host <host>`；默认 `127.0.0.1` 时行为与升级前一致（多传 `--host 127.0.0.1` 无害）。
- **GUI**：「网络设置 (局域网远程访问)」区（「设置」LabelFrame 上方）——「服务绑定」只读下拉（本机 / 局域网）+「受信任主机」文本框（逗号分隔）+ 说明文字 + 并入 on_save；就绪日志在 `dsh_host=="0.0.0.0"` 时用 `lan_addresses()`（`socket.getaddrinfo` 枚举非 127. IPv4）追加 `局域网访问地址: http://<本机IP>:3080` 供分享。
- **验证**：`patch_web_startup()` 幂等（两次结果一致、marker 已替换）+ `patch_lan_trust()` 幂等 → `build_server_command()` 传参正确 → 本机回归（默认 127.0.0.1 行为不变）→ LAN 实测（本机 `127.0.0.1:3080` 与局域网 `<服务器IP>:3080` 均可打开、聊天/工具正常、远端改设置返回 403）→ 精确语义用 `runtime/tmp/smoke_lan_trust.py`（node 直接执行补丁后逻辑：空=含全部局域网、非空=只含填写项、本机模式=只含填写项）。
- **教训**：① 官方为安全刻意禁用的能力（0.0.0.0）用"补丁 + 两个调用点兜底"，并记住**任何改 `node_modules` 内官方文件的补丁都会在升级重装后被还原**；② 前端脚本里凡硬编码 `127.0.0.1` 的都要排查是否需要 `location.hostname` 适配；③ 后端小服务（心跳等）绑定地址要跟随主服务 host 联动；④ 官方"自动全放行"的语义未必满足产品需求（`resolveLanTrust` 无条件合并 lanAddresses），要用同样的幂等补丁方式修正。详见 DEV_NOTES 需求 #31 / 避坑 #52。

### 3.11 启动前自动清理占用端口的孤儿 dsh 进程（2026-08-18，需求 #46）

- **现象**：手动点「启动服务」后新进程立刻以退出码 1 退出，`server.log` 报 `listen EADDRINUSE: address already in use 127.0.0.1:3080`；且此前打印了"服务已就绪"（误导）。
- **根因**：`start_server()` 开头只检查 `is_server_running()`（本启动器记录的 service 进程 / PID 文件），**不检测孤儿进程**。之前调试/测试时手动 `node bin.js web` 启动的服务残留占着 3080，`wait_ready()` 里 `port_open()` 对残留端口立即返回 True → 误报"已就绪"，新进程实际绑定失败退出。
- **修法（仅 launcher.py，3 个新方法 + 1 个调用点）**：
  1. `_find_port_owner(port)`：PowerShell `Get-NetTCPConnection -LocalPort <port> -State Listen` 拿 `OwningProcess` → `Get-CimInstance Win32_Process` 取进程名 + 命令行，返回 `[(pid, name, command_line), ...]`（**tab 分隔**解析；非 Windows / 查询失败返回空列表安全兜底）。
  2. `_cleanup_orphan_dsh(port)`：启动前调用，先 `port_open` 确认被占，再遍历占用者**严格校验 dsh 特征**（进程名含 `node` + 命令行含 `bin.js` 且 `web` 且 `--port`）才 `taskkill /F /PID`——**绝不误杀普通程序**；清理后轮询等端口释放。
  3. `_wait_port_free(port, timeout=5)`：`taskkill /F` 后端口一般立即释放，仅兜底轮询。
  4. 调用点：`start_server()` 在 `is_server_running()` 判断之后、启动新进程之前调 `_cleanup_orphan_dsh(port)`。
- **验证（runtime/tmp/smoke_port_cleanup.py，3 场景全 PASS）**：① 端口空闲→不动；② 普通进程（命令行无 dsh 特征）→ 不误杀、进程存活；③ 带 `bin.js web --port` 特征的占用进程 → 清理数 1、进程终止、端口释放。测试用 `Launcher.__new__(Launcher)` + 覆盖 `obj.log` 即可免 GUI 实例化。
- **注意**：改 `launcher.py` 后必须重打包 `DSH_Launcher.exe`（`build_exe.bat`）GUI 才生效；命令行 `python launcher.py --start` 直接跑源码不受影响。

### 3.12 局域网 http 下 crypto.randomUUID 缺失 → 会话记录/工作区异常（2026-08-18，需求 #53）

- **现象**：局域网模式用内网 IP（`http://192.168.x.x:3080`）打开，界面正常但**会话记录拉不到、添加工作区报 `crypto.randomUUID is not a function`**；同一模式下 `127.0.0.1` 打开则正常。
- **根因**：`crypto.randomUUID()` 是浏览器 Web API，**只在 secure context（HTTPS 或 localhost/127.0.0.1 环回）下存在**。内网 IP 走普通 HTTP 时页面非安全上下文，`window.crypto.randomUUID` 为 `undefined`，一调即抛 TypeError。官方 `dsh-client-connection/lib/client.js` 两处裸调（`MessageId(crypto.randomUUID())`、`mintRpcId()->RpcId(crypto.randomUUID())`）全踩；官方自己 6366 行写的 `randomUuid()`（`getRandomValues` 兜底）生产路径没用到。
- **修法（launcher.py，纯前端注入，1 方法 + 2 调用点）**：新增 `patch_frontend_uuid()`，向 WebUI `index.html` 注入幂等 `crypto.randomUUID` polyfill（`<!-- dsh-launcher-uuid-polyfill:start/end -->` 标记包裹）。polyfill 条件：`crypto` 存在且 `getRandomValues` 可调且 `randomUUID` 缺失才注入；用 `getRandomValues(new Uint8Array(16))` + `bytes[6]=&0x0f|0x40`（v4 版本位）+`bytes[8]=&0x3f|0x80`（variant），`toString(16)` 补 `0` 拼 8-4-4-4-12。注入点优先 `</head>` 前（早于官方 bundle）、兜底 `</body>` 前。调用点：`install_dsh()`（重装自动补）+ `start_server()`（每次就绪）。
- **关键坑 1**：若注入在主 `<script>` 之后、官方 bundle 加载期间才执行，`crypto.randomUUID` 一旦在模块顶层就被调用会来不及；故**尽量插 `</head>` 前**。实测本修复用 getRandomValues 生成 `911522b9-...`、`v4=true`、variant 正确。
- **关键坑 2**：`@deepseek-ai/dsh-client-connection/lib/client.js` 是**官方 node_modules 文件**，任何直接改它的补丁升级重装会还原；前端 index.html 注入同样会被重装覆盖，所以必须走 `patch_frontend_uuid()`（安装/启动各兜一次）而非一次性手工改。
- **易混**：`randomUUID` 缺失（本文）与「浏览器无 `crypto`」不同——`getRandomValues` 在非安全上下文仍暴露，故用它做兜底可行；不要假设 `crypto` 整体不存在（那样连 getRandomValues 都没得用，得先 `globalThis.crypto = ...` 兜底）。
- **验证**：项目便携版 Python 3 `py_compile` 通过（**不要用系统 python——可能是 2.7，`nonlocal` 会误报语法错**，本项目校验统一用 `runtime\python\python\python.exe -m py_compile`）；注入 JS 片 `node --check` 通过；重启服务 + 内网 IP Ctrl+F5 强刷新再测会话列表/添加工作区。

### 3.13 局域网手机连不上 / Windows 防火墙自动放行端口（launcher.ensure_firewall_port，2026-08-18，需求 #54）

- **现象**：局域网模式（`dsh_host=0.0.0.0`）下电脑本机浏览器正常、手机用内网 IP 打不开；`netstat` 已显示 `0.0.0.0:3080 LISTENING`，`ipconfig` 本机局域网 IP 正常，网络 DomainAuthenticated、防火墙规则无分域遗漏——但手机就是连不上。
- **根因**：既有防火墙规则 `dsh_launcher` 是**按「程序（dsh_launcher.exe）」放行**，而实际监听 3080 的是 **`node.exe`**（官方 dsh 是 node 进程）。Windows 按程序放行只对该 exe 生效 → `node.exe` 入站无放行记录，局域网流量被防火墙丢弃；本机能连是回环流量不走防火墙入站过滤。
- **排错铁律**：先 `netstat -ano | findstr :端口` 确认监听地址与监听进程 → `tasklist /FI "PID eq <pid>"` 确认是 node.exe 还是别的 → 再 `netsh advfirewall firewall show rule name=xxx` 看是"按端口"还是"按程序"放行。**只要按程序放行且程序 ≠ 监听进程，就是漏放行。**
- **修法（绿色版通用，非一次性手工）**：launcher.py 新增 `ensure_firewall_port(port)`，**按端口放行**（TCP localport），对同规则名**先 delete 再 add**（同名多条 netsh 会累加重复）保证幂等落到最终态；`start_server()` 仅当 `dsh_host==0.0.0.0` 时调用（本机模式不开放），这样任意电脑跑绿色版都能在启动时自动放行，不依赖用户手动配置防火墙。
- **关键坑**：`subprocess.call` 里 `stdout/stderr=DEVNULL` + 检查返回码判断成败；无管理员权限/非 Windows 时仅记警告**不阻断主流程**；netsh 成功后 `exit=0`。
- **验证**：`py_compile` 通过；生产同命令执行 `exit=0` 规则成功写入；`Test-NetConnection <本机局域网IP> -Port 3080` 返回 `TcpTestSucceeded: True`。**局限**：本机连本机局域网 IP 多走回环协议栈，未严格走防火墙入站过滤，最终必须用手机实测内网 IP 打开。

### 3.14 双平台发布（GitHub + Gitee 发行避坑，2026-08-26 沉淀）

发版到 GitHub/Gitee Release 的平台性坑，均实测。除「更新」外，发布流程本身也要过一遍这里。

- **PowerShell 发中文 commit / Release 正文变 `?`**：`Invoke-RestMethod -Body $str` 按本地 ANSI(GBK) 序列化，必须 `[System.Text.Encoding]::UTF8.GetBytes($json)` + `-ContentType "application/json; charset=utf-8"`；**git commit 带中文一律用 UTF-8 消息文件 `git commit -F <文件>`**，不要 `-m "中文"`（否则 PowerShell 管线上中文被 ANSI 转码成 `?`，commit 后是坏消息面）。拼 URL 时 `"$uploadUrl?name=..."` 里的 `?` 会被当变量名吞掉，需写成 `"${uploadUrl}?name=..."`。
- **Gitee `/releases` 升序返回 + 默认每页 20**：取"最新"必须 `?per_page=100` 后再按 `created_at` 降序，否则会首选到最旧版本（曾误报 v1.0.9 为最新）。**凡依赖第三方列表接口取"最新"，都防"顺序假设 + 分页截断"，不要轻信返回顺序**。
- **Gitee 删附件用 `curl.exe` 逐条删**：PowerShell `Invoke-RestMethod -Method Delete` 会 404；短时间批量循环会命中限流返回**假 404**，须逐条 + 删后 `?per_page=100` 复查；建 Release 必带 `target_commitish=master`（否则 400）；Gitee 同名附件上传不覆盖，先按 attachment id 删旧再传。
- **推送 / 网络**：本机常有 `api.github.com` 可达、`github.com:443` 直连超时——git push 失败改走 GitHub API 建 ref/提交/传资产（`uploads.github.com`），或开代理 `-c http.proxy=http://127.0.0.1:10809 -c http.lowSpeedLimit=0 -c http.lowSpeedTime=999`。**Gitee push 认 `https://oauth2:<token>@gitee.com`，用 `用户名:token` 会 403**。
- **Git Data API 断点续推（v1.0.19 实测，模板 `runtime/tmp/git_push_github_api.py`）**：API 重放的提交 SHA 与本地不同，若上次只推到一半，远端 master 变成"本地没有的改写 SHA"，`rev-list <远端SHA>..master` 报 `Invalid revision range`。正解：①用 `find_local_ancestor` 沿远端提交链（API GET parents）**向上找第一个本地存在的提交**作 rev-list 基准——**别只取远端 master 的 `parents[0]`**，多级改写链下父提交也可能是改写版（实测 v1.0.19 二次续推父 45e2cba 不在本地）；②用 **tree 相等**（`get_commit(remote)["tree"]["sha"]` vs `rev-parse c^{tree}`）找远端 master 对应的本地提交，建 `本地SHA→远端SHA` 映射；③待推列表用 `rev-list --reverse local_base..master` 精确取 local_base 之后（候选列表可能混入已推送旧提交）；④`create_commit` 的 parents 用**远端父 SHA**，每次提交后回读远端 tree 作下个 base_tree。注意改写提交只存在远端、本地 update-ref 会报 `nonexistent object`（别试），本地 `git status` 显示 ahead 属预期。**Gitee 侧：其 git data 只支持写（POST blob/tree/commit、PATCH ref），GET `/git/commits/{sha}` 返回 405**；且 gitee.com 直连可达 → 直接用 `git push --force gitee master` 把完整本地历史同步过去（改写链无 tag 引用、是残缺中间态，force 覆盖安全；先 `git ls-remote gitee refs/heads/master` 核对远端状态）。
- **发行流程（v1.0.18 起复用模板）**：`runtime/tmp/` 下 `build_release_zip_v10xx.py`（纯标准库打**一个**绿色 zip，`GREEN_FILES` 白名单 + `GREEN_DIRS` 递归，含 `plugins/` 与 `skills/dsh-deploy-maintain/`）、`github_release_v10xx.py`（`GH_TOKEN` 建 Release/传资产，422 自动复用）、`gitee_release_v10xx.py`（`GITEE_TOKEN` 会话临时注入不落盘，先删同名旧附件再传）。**构建 zip 用便携 Python `runtime\python\python\python.exe`**——系统 `python` 是本机 Python 2.7.6，跑新脚本会误报语法错。发布说明按改动主题分节、文案三国化包装；Gitee 正文用纯文本编号列表（不带 Markdown 标题）。改内置插件/入口后记得同步 `GREEN_FILES` 白名单（如 v1.0.18 移除了 `desktop-shell.bat`）。

## 四、DSH 插件开发（双端加载 + 路由注册）

### 4.1 插件 = npm 包 + 双入口（最容易漏）

dsh 插件要**同时**声明 `dsh.bundle` 与 `dsh.client` 才会被宿主 + WebUI 双端加载：

- **`dsh.bundle.patch`** → 指向一个 `cordis.patch.yml`（`- insert: [{id, name}]` 把插件作为一行插入 profile 插件树）。`dsh plugin add` reconcile 时据此把包加进 `dsh.profile.bundles`；服务启动时 `@deepseek-ai/dsh-app-boot` 的 `loadProfile` 按序合成 **bundle 补丁 → 用户 cordis.patch.yml → --patch 覆盖层**。
- **`dsh.client`** → 声明 WebUI 客户端入口（`inject` + `platform: "web"`），由 `dsh-client-modules` 扫描注入。
- **`files` 数组必须包含 `cordis.patch.yml`**，否则发布/安装后文件缺失，宿主端扫描不到该行。
- **只声明 `dsh.client` 的插件不会进插件树**（"设置页看不到清理归档"的根因之一）；只声明 bundle 没 client 则宿主加载但 WebUI 无入口。

### 4.2 客户端 `exports` 必须导出 `./package.json`（高优先级坑）

- **现象**：插件已装进 profile 的 `dsh.profile.bundles`、`--dump-config` 插件树也合成、服务正常启动，但 WebUI 入口死活不出现。
- **根因**：宿主端 `@deepseek-ai/dsh-client-modules` 的 `ClientModuleRegistry.resolveMeta()` 用 `require.resolve("<插件>/package.json")` 扫描客户端 bundle；`exports` 漏了 `"./package.json"` 会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，该插件被当作"不是客户端包"跳过 → 不进 `window.__DSH_BOOT__` 模块表 → WebUI 不显示。而服务端 `resolveBundleDir` 不受 `exports` 限制，造成"服务端在、客户端不在"的假象。
- **修复**：`exports` 里必须保留 `"./package.json": "./package.json"`，然后**重新安装**插件并重启服务。
- **排查顺序**：① 抓首页源码看 `window.__DSH_BOOT__.entries` 是否含该插件；② `node -e` 验证 `require.resolve("<插件>/package.json")` 是否抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。

### 4.3 宿主端路由注册：`ctx.effect` 的正确用法（405 大坑）

- **错误写法（注册后立即被注销 → 一切非 GET 请求落 fallback → 405）**：
  ```js
  const disposer = ctx.webServer.register({ ... }); // 先注册
  ctx.effect(disposer, "…");                        // 把"注销函数"当 fn 传进去
  ```
  Cordis 的 `ctx.effect(fn, label)` 会**立即执行 `fn()`**，并把 **`fn()` 的返回值**当作清理函数。上面把 `disposer()` 当 setup 立即执行 → 路由刚进 exact 表又被 `table.delete(path)` 删掉。
- **正确写法**：把注册包进回调，`register` 的返回值（注销函数）正是 `fn()` 的返回值：
  ```js
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/__dsh/archive-purge",
    handler: async (req, res) => { /* GET/POST 分发 */ }
  }), "dsh-archive-purge: route");
  ```
- **405 语义**：dsh 内置 web server 的路由匹配 `match()` 先查 exact 表再查 prefixes 表，未命中才落到 `frontend-static` fallback；fallback 对**非 GET/HEAD** 请求默认返回 405。所以 **405 = 插件路由根本没在 exact 表里**（`dsh-host-webserver` / `dsh-host-frontend-static` 源码可查证）。
- **教训**：宿主插件注册任何路由/资源**必须**用 `ctx.effect(() => 注册(...), label)` 模式；"注册了但 404/405"先怀疑这个。注意客户端显示 ≠ 宿主 apply 成功（两套独立判定机制）。

### 4.4 宿主端与客户端代码骨架（详见 references/plugin-skeleton.md）

- **宿主端 `lib/index.js`**：导出 `{ name, inject, apply }`。`inject` 声明依赖服务（如 `["webServer", "workspaceRegistry"]`），cordis 激活前注入；`apply(ctx)` 里注册路由。
  - 会话列表：`workspaceRegistry.archivedSessionIds` 遍历 + `registry.list()` 找所属工作区；`ctx.get("sessions")` 判活跳过运行中会话；标题尽力从 `storages/session_projcache.json` 读（需去 BOM）。
  - 删除：跳过运行中 → 删日志目录 → 遍历 `registry.list()` 逐个 `entity.detachSession(id)`（对未挂载 id 幂等）。
  - **安全**：删除路由带自定义头 `x-dsh-plugin-purge: 1`（跨域请求无法携带自定义头，会触发 CORS 预检且本服务不返回 CORS 头），防外部网页对本地端口发起删除。
- **客户端 `lib/client.js`**：用加载器契约 `window.__ModuleLoader__.load({ id, factory })`，`apply(ctx)` 里 `ctx.slots.inject("settings.section", ...)` 注册设置区块（`{ name, id, order, label }` + 组件）。组件内 `fetch` 调宿主路由（带自定义头），勾选列表 + 全选/全不选 + 删除所选/清空全部/刷新列表，成功后重新拉列表。

### 4.5 已知取舍

- dsh 没有"取消归档/删除归档 id"接口，`detachSession` 摘除后 `archivedSessionIds` 会残留一个不指向任何会话的 id（纯隐藏标记，无害）；`session_projcache.json` 旧缓存行也无害，留待 dsh 自行覆盖。
- 加减插件必须**重启服务**才生效（HMR 只对已加载插件源码有效；settings.yaml 与 web 客户端 HMR 在 dev 模式不需重启）。**客户端源码改动例外**：客户端 bundle 按请求从 node_modules 重新生成（rev 哈希变化），**强制刷新页面即可生效，不必重启服务**。
- GitHub topic 页的仓库 ≠ 插件本体：主仓库根目录往往没有 package.json（可能是跨 agent 工具集），真正的 dsh 插件可能是独立子仓库 + npm 包。判断标准 = 根目录有无 package.json + `dsh.bundle`/入口。

### 4.6 插槽条目组件不要条件调用 props 传入的 hook（useInput 等）→ 组件被错误边界吞掉、不渲染

- **现象**（`dsh-file-browser` 实测）：输入框工具行按钮不显示。服务端路由 200、`__DSH_BOOT__` 有模块、bundle 内容正确、SSR 渲染正常，但浏览器控制台出现 `componentDidCatch`——React 错误边界捕获了渲染异常，插槽渲染成 `data-slot-error` 空占位。对照实验：另一插件（`dsh-archive-purge` 设置区块）正常显示，说明客户端激活机制没问题，问题专属该组件。
- **根因**：条目组件里写 `const input = typeof useInput === "function" ? useInput() : null;` —— **条件调用从 props 传入的 hook**（standard-kit 注入的 `useInput`）。该 hook 的身份/可用性在不同渲染间可能变化（会话绑定解析前后、重渲染时），导致组件每次渲染的 hook 数量不稳定 → React 抛 **"Rendered more/fewer hooks than during the previous render"** → 被错误边界捕获 → 条目不渲染。Node/SSR 单测复现不了（测试里 props 恒定），只有真实 app 环境才触发。
- **修复**：**不要调用 props 里的 hook**。需要读快照时用 ownerProps 里已有的普通数据字段——例：`conversation.input.left` 的 InputZone ownerProps 直接带 `input: InputState` 快照（含 `draft`），即 `ownerProps.input.draft`；`inputActions` 是普通对象 prop，可正常用（`inputActions.setDraft(草稿+文本)` 追加草稿）。
- **排查**：客户端组件不渲染 → 先看控制台有无 `componentDidCatch` / "Rendered more|fewer hooks"；用 SSR（react-dom/server renderToString + 真实 React）可排除组件自身逻辑，但**无法复现 props-hook 身份漂移**——真实环境优先怀疑"从 props 拿 hook 并条件调用"。
- **教训**：插槽条目的 standard props 里，**hook（`useXxx`）只能无条件调用且不能依赖其身份稳定性**；要读快照数据优先用 ownerProps 里的普通字段，而不是通过 props hook 现取。

### 4.7 第三方"工具型"插件（如 dsh-find-plugin）无 UI、仅注册 agent 工具；验证插件树必须设 DSH_HOME

- **分类**：DSH 插件分两类——**宿主端工具/路由插件**（`package.json` 只有 `dsh.bundle.patch`，无 `dsh.client`）与 **客户端 UI 插件**（有 `dsh.client`，WebUI 出现界面）。`dsh-find-plugin` 属前者：`lib/index.js` 只 `ctx.tools.register(defineTool({ name: 'find_dsh_plugin', ... }))` 注册一个 agent 工具（GitHub `dsh-plugin` topic 实时搜索，按 star 排序，返回描述 + 可执行的 `dsh plugin add` 命令）。**它不会在界面上出现任何按钮/面板/设置项**——"装完没见 UI"是正常现象，不是装坏了。
- **触发方式**：工具型插件只在对话里 **agent 按需调用**（如"帮我找一个能做微信通知的 DSH 插件""有什么终端 TUI 插件"）。用户不主动问，工具永远不会被调用。安装后需**重启 `dsh web`**（bundle 补丁在启动时合成）。
- **【高优先级坑】用 `dsh --dump-config --profile web` 验证插件树，必须 `$env:DSH_HOME=runtime\dsh-home` 后再跑**：直接跑会加载 `~/.dsh` 默认 home 的 profile（只有 dsh-base/dsh-web-app 两个内置 bundle），看不到自定义插件，误判"没进插件树"。设对 DSH_HOME 后输出末尾可见 `# == dsh-find-plugin` / `- id: find-dsh-plugin` 层。
- **排查"装了插件没反应"的顺序**：① `runtime/dsh-home/profiles/web/package.json` 的 `dependencies` + `dsh.profile.bundles` 是否含该包；② **设 DSH_HOME** 后 dump-config 看插件层；③ 插件 `package.json` 有无 `dsh.client`——**无则无 UI，属工具/路由插件**，靠 agent 调用或 HTTP 路由验证；④ 安装后重启服务。
- **依赖解析**：插件 peerDep（如 `@deepseek-ai/dsh-tools`）由 pnpm 提升到安装根（`runtime/dsh/node_modules/`），`require.resolve` 可验证。

### 4.8 双端插件"树里有、UI 有、但能力不生效" → 先查插件自己的运行时/凭据前提（dsh-vision-toolkit 实测）

- **案例**：`@dsh-external/dsh-vision-toolkit@0.1.4` 装上后——插件树已合成（设 DSH_HOME 后 dump-config 有 `# == @dsh-external/dsh-vision-toolkit` 层）、双端声明齐全（`dsh.bundle.patch` + `dsh.client`）、16 个 peer 依赖全可解析、`runtime/requirements.lock` 和 vendor 上游快照都在，**但实际只有设置界面可用，10 个视觉工具 + skill 全不注册**。
- **根因①（运行时版本门槛）**：默认 `runtime.mode: managed`，首次启动必须找到 **Python 3.11+** 自动建隔离 venv 装依赖。本机只有 Python 3.10/3.8 → `resolveBootstrapPython` 探测 `python`/`py -3`/`python3` 全失败 → `manager.initialize()` 抛错 → 插件 `ctx.logger.error` 明确打印 **"runtime not ready; the vision-tools skill, activation bootstrap, and Agent-scoped visual tools are NOT registered. Settings remain available for repair."**。旁证：`DSH_HOME/cache/dsh-vision-toolkit/` 下只有 `artifact-access.key`、没有 `python/` 运行时目录。
- **根因②（API 凭据）**：默认 provider `https://api.inferera.com/v1`、credential 引用 `VISION_API_KEY`，`.credentials.yaml` 无此 key——运行时修好也需先配 key。
- **排查"装了但没完全生效"顺序**：① dependencies + bundles 是否含包 → ② 设 DSH_HOME 后 dump-config 看插件层 → ③ 有无 `dsh.client`（双端才有 UI）→ ④ **插件自身的外部运行时要求**（外部解释器版本 / 下载型依赖 / API key）——最容易被忽略 → ⑤ 重启服务后看 `server.log` 里插件自己 `ctx.logger.error` 的降级提示。
- **修复（绿色整合）**：便携 Python 3.11+ 进 `runtime/python`，在插件 Web Settings（如 vision-toolkit 命名空间）把 `runtime.python` 指向它、配好 credential，重启服务；成功标志 = server.log 出现 "dsh-vision-toolkit ... ready"。

### 4.9 纯客户端插件也必须带宿主端 `lib/index.js`（空 apply）→ 缺失则服务启动即退出；消息行扩展点盘点（2026-08-16，dsh-message-actions 实测）

- **【严重】纯客户端插件缺 `lib/index.js` → 整个服务起不来**：宿主 cordis loader 对 bundle 树里**每个包都会 import 其 `main`/`exports["."]`**，纯客户端插件（只做 WebUI 插槽注入）也不例外。`lib/` 下只放 `client.js` 时，安装后重启服务**瞬间退出**，server.log 报 `ERR_MODULE_NOT_FOUND: ...lib/index.js`（`plugin tree failed to load`）。**修复**：`lib/index.js` 放官方纯 UI 插件同款 no-op——`function apply() {} export { apply };`（对照官方 `@deepseek-ai/dsh-client-ui-message-feedback` 宿主端）。
- **消息行两个官方插槽**：
  - `conversation.chat.assistant-actions`：每条**已完成**助手消息的 IconActions 操作行，`owner={messageId}`，list 按 `order` 升序（官方反馈 👍👎 用 `order:10`，第三方从 `order:20` 起）；组件拿 session standard kit（`useSession`/`sessionId`）。
  - `conversation.chat.turnTail`：操作行**上方**内容区，chain 链式——`select` 必填返回匹配值（全拒渲染空），`priority` 控制选举顺序；组件拿 `matched` + `useSession`。
- **官方已原生覆盖、别重复做**：消息正文「复制」、回合尾「在新对话中分支」（fork 到该消息）、悬停「用时/首 token/速率」；会话级 token 合计官方 StatsLine 已显示在输入框下方（`useProjection("tokenUsage")`）。**教训**：给官方已有能力做"重复插件"价值有限（`dsh-message-actions` 因此被废弃删除）；本项目价值插件 = "官方没有的"（清理/回退/统计）。
- **fork 边界语义限制"重新生成/删除回合"**：官方 `session.fork` 边界 =「≥ atSeq 的**第一个 turn/end**」→ 只能整回合切，**切不出**"历史 + 用户提问、无回答"（用户提问在上一 turn/end 之后、本回合 turn/end 之前，中间没有 turn/end）；**原地删回合 dsh 不支持**（内存缓存 + seq 断裂）。替代能力由 `dsh-session-rewind`（回退）+ 启动器「会话管理」（清理）覆盖。
- **读快照拿消息数据**：`useSession((s) => s)` 的 `snapshot.nodes`（legacy 字段，含 `AssistantMessageNode`：`kind:'assistant'`/`turn`/`usage`）与 `snapshot.chat.nodes.values()`（实时节点库，`data.finalNode`/`data.closing.finalNode`）双源；`finalNode.usage` 即事件原始 usage（`outputTokens` 至少必有）。
- **验证**：无头 Edge + CDP（`/json/list` 取 `type==="page"` target；`Page.addScriptToEvaluateOnNewDocument` 预置 `localStorage["dsh.sessions.current"]={sessionId}` 自动打开历史会话；`Runtime.enable` 抓异常；设置触发器 class `VOzbGW_trigger`；读文本用 `textContent` 而非 `innerText`——innerText 会把 flex 项拆行误判）。详见 DEV_NOTES 避坑 #51。

### 4.10 复刻第三方插件做内置精简版：挂载方式 + 媒体路由踩坑（2026-08-17，dsh-sidebar-lite）

复刻第三方 DSH 插件（本例 `omdsh-dev/DSH-better-sidebar`）做"绿色版内置精简版"的经验（详见 DEV_NOTES 需求 #40/#41）：

- **挂载方式别赌官方内部布局插槽名**：better-sidebar 是把一个 `<div>` append 到 `document.body`，再用 `react-dom/client` 的 `createRoot` 渲染成门户面板，**并不依赖官方任何布局插槽声明**——这是复刻侧边栏/floating 面板最稳的通用手法（仅需 `require("react-dom/client")`，拿不到再兜底全局 `ReactDOM.createRoot`）。若只 `require("react")` 拿不到 `createRoot`，要显式 require react-dom。
- **媒体路由 + 自定义防御头的矛盾**：给插件每个路由都加自定义头（`X-DSH-...: 1`）防跨站后，图片/PDF 预览**不能用 `<img src>`/`<iframe src>`**——子资源加载带不上自定义头，媒体路由全 403。解法：媒体路由仍校验防御头，预览端一律 `fetch(url, {headers:{防御头}})` 取回 `blob` → `URL.createObjectURL` 交给 `<img>`/`<iframe>`，并在卸载/换文件时 `revokeObjectURL`。宿主端 `"prefix"` 路由若再同时暴露 POST 业务 + GET 媒体，handler 里要按 `req.method`+`pathname` 分流（GET 只放行精确的 `/file`，否则 GET 会被统一 POST-only 判断拦成 405）。
- **`file:` 安装是拷贝非软链 + 重装才同步**（与避坑 #30 同源）：改 `plugins/` 下源文件后要用 `--install-plugin file:<绝对路径>` 重装（幂等很快），并靠 `reconcile_bundles` 自动进 `dsh.profile.bundles`；装完**必须重启服务**新插件才真正加载。内置插件清单收录于 `plugins/`，插件管理「一键安装内置插件」会自动带上。
- **右键"下载"同样要走 fetch+blob**：媒体路由都带防御头，`<a href>` 直接跳转下载**同样带不上自定义头会 403**。下载 = `fetch(带防御头)` → `blob` → `URL.createObjectURL` → `<a download>` 触发保存 → 1s 后 `revokeObjectURL`。宿主 `file` 路由加 `download=1` 时返回 `Content-Disposition: attachment` 即可兼容。
- **右键/上下文菜单照抄原版**：单个共享菜单（状态只记"触发行+光标位置"）+ 点击空白处用透明 mask 关闭；菜单项对齐原版（文件行才有「下载」，目录行只有「复制相对/绝对路径」）；复制成功把目标行短暂标「已复制」再 1.2s 复位。复制用 `navigator.clipboard.writeText`，缺省回退 `execCommand("copy")` + 隐藏 textarea 兼容旧内核。
- **浏览器 AI 可调用性（对比判定基准）**：此类侧栏/内嵌 iframe 浏览器（含 better-sidebar 官方版）都是**纯用户驱动**，工具栏只有 `browser.probe` 这类"探测站点能否嵌入"的展示型路由，**均不能被模型直接调用导航**；真正暴露给模型的是终端工具（如 `terminal_create/send/...`）。判断"浏览器能不能被 AI 调用"，看插件是否用宿主 `ctx.tools.register(defineTool(...))` 注册了模型工具、以及是否有 `sessionId` 作用域权限路由——没有就是纯 UI 浏览。若需"AI 打开某 URL 到侧栏"，得另注册模型工具，属超集增强。
- **轻量 CMD 终端（绿色版零原生依赖）**：原版 better-sidebar 终端走 `node-pty/xterm`，但 **`node-pty` 要编译原生模块（Windows 需 VS 工具链），违反绿色版"零原生依赖、可整目录拷走"定位**，别学着引入。换 `child_process.spawn("cmd.exe", [], { cwd })` + SSE 流：stdout+stderr 合并 `push` 到有界 transcript（1MB 丢头）并推给所有 SSE 监听器；前端回车 `terminal.input` 写一行到 stdin，命令由 cmd 自行回显（无真实 TTY，光标/ANSI 原始回流，用 `<pre>`+`pre-wrap` 原样展示）。SSE 连接的 `req.on('close')` **只删监听器不杀进程**，刷新/切页断连后重连先 `replay` 历史 transcript 恢复现场，「停止」/`terminal.kill` 才 `proc.kill()`；`spawn` 务必传 `{cwd}`。不能 `Ctrl+C` 中断前台命令（得 taskkill）是非 TTY 的已知取舍。
- **任务管理 = 复用官方 session/jobs 推送镜像**：客户端任务列表**不直连内部 API**，直接读 `ctx.sessions.list` 快照里的 `jobsBySession[sessionId]`（官方推送镜像，与 better-sidebar 同源）；「查看输出」走宿主端 `jobs.output`——从 `ctx.get("sessions").get(sessionId).events` 重放 `tool/call(job_output)` 与其配对 `tool/result`（按 `source.callId` 配对）得文本，**只读重放、不消费模型游标**；「停止」走 `jobs.kill` 复用官方 `ctx.get("jobs").kill(jobId, caller, reason)`（caller 取 `agents.get(sessionId)`）。
- **资源管理器默认根 vs 会话 cwd**：会话工作目录（`session.header.cwd`）通常是 `runtime\dsh` 这类运行目录，用户更想要**整个项目根**。对齐内部 `dsh-file-browser`：默认根取 `ctx.get("sandboxPolicy").workspaceRoot`，优先 `fsService.resolve→processPath` 转会展示路径；`session.cwd` 路由同时返回 present cwd 与 workspaceRoot，前端默认取 `workspaceRoot || cwd`（无工作区根才回退会话 cwd）。**同时必须放开 `isWithin`/上级浏览**——路径按绝对路径处理、允许上溯任意路径（与 `dsh-file-browser` 一致），否则用户还是会觉得"被锁死在固定目录"。
- **无会话时资源管理器卡死"扫描目录…"（前端状态短路，严重避坑）**：`sessionId` 为空（新开页面/无激活会话）时，若会话溯源 effect 只写了 `if (!sessionId) return;`（不请求 `session.cwd`），则 `workspaceRoot`/`cwd` 永远是 null → `currentPath` 初始化为 `""` → 主 effect `if (currentPath === "") return;` 短路，`fs.tree` 永不触发 → 永久停在"扫描目录…"且 console 无报错。**修法**：无会话时也要兜底解析一次工作区根（宿主端 `resolveWorkspaceRoot` 不依赖 sessionId，`session.cwd({sessionId:""})` 一样能返回），用 ref 保证只兜底一次，并把根同步进 `workspaceRoot` 与 `cwd`。诊断可 curl 打宿主端未报错 + DevTools console 无 React 错 → 一定要 trace 前端状态依赖链而不是只查后端。**部署坑**：client bundle `client.js` 被运行的 web server 持有文件句柄，改完 `Copy-Item` 到 node_modules 报"被另一进程占用"，**必须重启 DSH 服务**才释放并重载，`node --check` 过了不重启也是旧代码。
- **侧栏宽度可自由拉伸（右停靠通用手法）**：右停靠固定面板的宽度要能拖动，核心是**宽度走 CSS 变量**统一驱动——宿主 `width:var(--dsh-sidebar-lite-width,320px)`，主内容 `#root` 的 `margin-right` 也读同一变量，改宽度两面同步让位。拖动手柄：在面板左（上）边缘放一个宽 5px、绝对定位、透明的 div（`cursor:ew-resize`），`onMouseDown` 置 `resizing=true`，`resizing` 期间在 `document` 上全局监听 `mousemove`/`mouseup`（全局监听保证拖出面板边界也持续跟手），右停靠宽度=`max(200, window.innerWidth - clientX)`。**拖动时务必关掉 `width` 的 CSS 过渡**（`transition:none`），否则每帧都跟动画、严重滞后；用 `user-select:none` 防拖拽误选文本。
- **文件"下载"改"另存为"（本地机器语义 + showSaveFilePicker 手势坑）**：媒体路由带防御头、`<a href>` 直跳 403（见上），所以仍要 `fetch(带防御头)→blob`。要改成真正的「另存为」：调用原生 `window.showSaveFilePicker({suggestedName})` 让用户自选保存位置，`handle.createWritable()→write(blob)→close()` 写入。**关键坑：`showSaveFilePicker` 必须在用户手势（右键点击）激活窗口内调用**——若先 `await fetch` 再弹框，异步丢失去焦点后浏览器会拦截对话框（提示"需要用户手势"）。所以**先弹框拿 handle、再 fetch 取字节写回**。API 不可用 / 用户取消对话框 → `AbortError` 直接 return 不触发下载。初次调用浏览器会询问文件访问权限，属正常。
- **自由弹窗（非侧栏）可拖动 + 三路拉伸（dsh-file-browser 手法）**：若窗口是"自由浮层"（非边缘停靠），把 `panelStyle` 的位置改为 `left/top/width/height` 四元状态 `win={left,top,width,height}`，最小 520×380、最大视口-16 做 clamp。三条透明手柄：右（ew-resize 调 width）、下（ns-resize 调 height）、右下（nwse-resize 双调）——注意手柄要放在面板**溢出区**（如 `right:-3px` 宽 7px），`zIndex:5/6` 盖住内部元素的点击，`onMouseDown` 设 mode。**拖动用 `dragStateRef.current` + 全局 window mousemove/mouseup**，在 onMove 里读 ref 的 orig 值（而非闭包内 win 状态）。另外 `header cursor:move` 做 move 拖拽、**header 内所有可交互元素（input/刷新/关闭按钮）必须 `onMouseDown={e.stopPropagation()}`**，否则按到输入框聚焦/点刷新会被当拖动。
- **大文件预览（文本按字节分块 + UTF-8 chunk 边界不乱码，0 依赖）**：别用「文件 > X 就报 tooLarge」，`fs.readBytes(target, undefined, 512KB)` 取前部文本预览 + 标 `truncated`，客户端加「再看后面一段 512KB」按钮反复追加，内存稳。**致命坑：字节 offset 可能落在 UTF-8 多字节码点中间**（中文、emoji 占 2~4 字节），直接从中间读 decode 会在 chunk 交界出现 `U+FFFD` 问号。最稳妥 0 依赖解法：host 端接到 offset>0 时回退 `back=min(3,offset)` 字节再读，并把 `back` 回传；client 端把返回字符串 `TextEncoder().encode()` 成 utf8bytes，扫前 `back+1` 字节里第一个「非续字节」`(b & 0xC0) !== 0x80` 的位置 `startByteIdx`，仅 `utf8bytes.subarray(startByteIdx)` 再解码后才拼接到 `preview.content`。这样丢的那几个字节（前一块末尾的多字节尾巴）**在前一块完整解码里已经有完整码点显示**，不会真丢字符、不会乱码。

### 4.11 「工作目录 / 工作区根」兜底路径权威来源 = `workspaceRegistry`，绝不能用 `process.cwd()`（2026-08-17，避坑 #65）

用户说"回到工作目录"应回到**当前会话指定的目录**（会话 header 的 `cwd`，即 WebUI 左侧选的工作区），**不是 dsh 程序自己的位置**（绿色版 = `runtime\dsh`）。但即便 header.cwd 逻辑写对，路径仍恒为 `runtime\dsh`，两层根因：

- **① `sandboxPolicy.workspaceRoot` 未显式配置时默认值 = `process.cwd()`**：启动器以 `Popen(cwd=DSH_DIR)` 拉起 dsh，dsh 进程 cwd = `runtime\dsh`（目录名恰为 "dsh"，资源管理器默认路径就会显示成 "dsh"）。把它当"工作区根"兜底天然就是错的。
- **② 会话对象可能还没进 live store**：`ctx.get("sessions").get(sessionId)` 在服务刚启动/会话未激活时返回 `undefined`，header.cwd 拿不到，一路落到兜底命中 `process.cwd()`。

**修法（权威来源改为工作区注册表）**：
- 宿主端新增 `workspaceRootOf(ctx, sessionId)`，**优先从 `ctx.get("workspaceRegistry")` 取**——该服务（`@deepseek-ai/dsh-workspace`）维护用户创建的工作区目录，物理文件 `runtime/dsh-home/storages/workspace.json` 的 `tables.workspaces`（每个工作区含 `path` + `sessionIds`）。有 sessionId 按 `workspace.sessionIds.includes(sessionId)` 匹配该会话所属工作区 path，否则取注册表第一个；`sandboxPolicy.workspaceRoot` 降级为**次选且只有显式配置（≠ process.cwd()）才可信**。
- 兜底链最终：**会话 header.cwd → 客户端 cwd → 工作区根(workspaceRegistry，含会话归属匹配) → sandboxPolicy.workspaceRoot(仅显式) → process.cwd()（最后的最后）**。
- 诊断：先查 `runtime/dsh-home/storages/workspace.json` 工作区注册表当兜底根的事实来源，再看服务日志 `[dsh-sidebar-lite] sessionCwdOf:` 前缀（`用 header.cwd` / `用客户端 cwd` / `兜底 cwd` 三种去向一目了然）。

**客户端侧配套（"回到工作目录"按钮）**：
- 目标 = `cwd || workspaceRoot`（会话工作目录优先，工作区根兜底），一键回到会话锁指定的目录。
- **字符按钮（如 `⌂`）在部分字体/浏览器渲染成空白/方框看不清**——WebUI 侧字符按钮要优先用**内联 SVG**（如 Material 房子 `M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z`），再配文字标签（如「目录」）+ 高 26px + 主题强调色边框（`--dsw-alias-accent`）更醒目；`title` 提示显示实际跳转的目标路径，悬停即可确认。
- 注意「工作区根」与「dsh 进程 cwd」是两个概念；凡涉及"用户工作目录"的默认/兜底路径，权威来源 = `workspaceRegistry`。

### 4.12 「添加工作区」目录选择器难用：官方原生选择器在网络绑定下被屏蔽，纯插件改不动，只能走官方装配（2026-08-20，详见 DEV_NOTES 需求 #84）

用户反馈 WebUI「添加工作区」目录对话框把路径折叠成只剩"主目录"、默认落 C 盘、找不到偏好文件夹；诉求是**盘符切换 + 常驻完整路径 + 可编辑路径**。三层结论：

- **根因**：dsh 官方有**两套**目录选择器——`-browse`（内嵌 React 对话框，"主目录"折叠版）与 `-native`（`host.pickDirectory` 拉起 Windows 原生文件夹对话框：盘符切换/完整路径/快速访问全有）。装配由 `directory-picker-auto` 启动时 `resolveDirectoryPickerBackend` 决定：**`bindHost ≠ 127.0.0.1`（本绿色版局域网 `0.0.0.0`）时无条件退回 `browse`**（`dsh-host-directory-picker-auto/lib/index.js`）。所以局域网模式恒用 browse 版。
- **插件不可行**：两套都注册进 ui-workspace 两个 directory-flow 洞（`conversation.hero.workspace.directoryFlow` / `sidebar.workspaces.directoryFlow`），槽位是 **`single` 单占位**，官方文档明说"再挂第二个流程包加载期失败"。要改官方目录选择器 UI，**任何"用插件自定义"的方案都不可行**，别浪费时间。
- **想给原生对话框**：只能走官方装配——不改源码、配置覆盖把选择器钉到 `-native`（`@deepseek-ai/dsh-host-directory-picker-native` + `@deepseek-ai/dsh-client-ui-directory-picker-native`）。取舍：该 README 标注"仅限本地 Host 载体"，局域网时原生对话框弹在**运行 launcher 的电脑屏幕**上。
- **本项目决策（用户明确，2026-08-20）**：满足"不改官方代码、不做补丁"前提下改不动 → **放弃，目录选择器保持现状（browse）**，不做任何代码/装配改动。

### 4.13 侧栏「任务」页看似没绑定：`jobsBySession` 只覆盖后台 job，普通对话恒空；用官方 `SessionSummary` 做 AI 状态卡（2026-08-20，避坑 #64 的延伸，DEV_NOTES 需求 #85）

用户反馈侧栏「任务」页"实际没绑定到任何东西、没有任何输出和显示"。要区分两类"空白"，根因和处理完全不同：

- **后台任务列表 `jobsBySession[sessionId]` 恒空是正常现象，不是没绑定**：官方这个字段只在 AI 调用 `job_*` 类工具（长任务/后台脚本）时由 session/jobs 帧填充，**普通对话永远为空**。别以为"绑上就有内容"，数据源本身对普通对话为空。
- **真正该"绑定"的是激活会话的元信息**：切到该数据源，明确展示 **AI 当前任务目标 / 进度 / 会话工作目录**。数据来源是官方会话列表 store 的 `SessionSummary`（`dsh-client-runtime` 的 `SessionListState`），字段：`displayTitle`=当前任务目标、`running`=是否执行中、`completed`=是否已完成、`cwd`=会话工作目录。

关键技术点（前端 `plugins/dsh-sidebar-lite/lib/client.js`）：

- 快照取法：`const snapshot = ctx.sessions.list.getSnapshot();`（不要直接用 `sessionId` 判空）。官方投影 `projectList()` 把 `current` / `byId` / `jobsBySession` 放在**同一个快照**里：`sessionId = snapshot.current`、`jobs = snapshot.jobsBySession[sessionId]`、`activeSummary = snapshot.byId[sessionId]`——三者同源同键，一次取齐。
- `byId` 的键是 **`sessionId`**（不是 `id`），值是 `SessionSummary` 对象，`displayTitle/running/completed/cwd` 都在上面；`displayTitle` 为空时兜底成"（未命名）"。
- 状态徽标由 `running`/`completed` 派生：执行中=蓝点（加 `@keyframes` 呼吸动画提示"正在推进"）、已完成=绿点、空闲=灰点。**自定义动画 keyframes 必须自己注入**（本文档 `injectStyles` 的 style 块里加 `@keyframes dsl-pulse{0%,100%{opacity:1}50%{opacity:.25}}`），否则引用了不存在的动画名，蓝点不会闪。
- **无会话 / 无后台任务要给明确的中文空态提示**（"未选择会话，无法显示 AI 的当前任务状态"、"当前没有后台任务运行"），否则用户会误以为"没绑定到东西"。
- 同样是"空"，要分清是**数据源空**（jobs 普通对话恒空，属正常）还是**取值字段空**（取错字段→静默空）。前者给空态文案，后者才是 bug（见避坑 #64 的 `current` vs `sessionId`）。

### 4.14 绿色版「桌面版」入口做成本地插件：宿主端建桌面快捷方式 + 启动 bat，不下载外部 exe（2026-08-20，DEV_NOTES 需求 #88）

不想要官方 `dsh-desktop-plugin`（下载 exe 到系统 `%LOCALAPPDATA%`、桌面快捷方式还建不出来、绿色版搬移即失效）时，可自做**绿色版路径优先、可迁移**的本地入口插件 `dsh-green-desktop`：

- **不下载任何外部 exe**：把绿色版现成 WebUI 关进 `Edge --app` 独立无边框窗口即可（`start "" msedge.exe --app=http://HOST:PORT`，无地址栏、任务栏独立图标，形似桌面 App）。**⚠️ `--app=URL` 绝不能加引号**，加引号会被 Chromium 整个忽略、退回普通浏览器且不跳转（见避坑 4.15）。找不到 Edge/Chrome 则 `start` 系统默认浏览器兜底。
- **绿色版根目录定位**：插件在 DSH 里是装在 `<green>/runtime/dsh-home/profiles/<p>/node_modules/dsh-xxx`，从 `import.meta.url` 逐级向上找含 `config.json` 的目录（config.json 是稳定锚点文件）。
- **host/port 不写死、不写在 JS**：由根目录 bat 运行时粗解析 `config.json` 的 `dsh_host`/`dsh_port`（默认 127.0.0.1:3080），随绿色版迁移自动跟随。JS 端只负责建快捷方式指向这个 bat。**注意**：早期用的 `desktop-open.bat`（`Edge --app` 无边框窗口）已废弃删除，桌面入口现统一由内置 `desktop-shell.py`（WebView2 独立窗口）承担、从启动器 GUI「桌面窗口」按钮进入（`desktop-shell.bat` 独立入口 2026-08-27 已移除，功能与 GUI 完全一致），绿色 zip 不再带 `desktop-open.bat`/`desktop-shell.bat`。
- **插件 .js 必须是纯 JS，不能带 TS 类型注解**（本项目插件由 node 直接加载，非 tsc 编译）——写了 `function x(): string` / `: Promise<void>` 会在 `node --check` 直接 SyntaxError，必须全部去掉改成 JSDoc 注释式。
- **别用 `homedir()\Desktop` 判快捷方式是否存在**：目标机桌面常被 OneDrive/重定向（实测 `D:\junheng.liu\Desktop`），路径判空会失准。改为**每次都重建**快捷方式（隐藏 PowerShell 一条命令，代价极小），顺带保证绿色版整体迁移后快捷方式目标自动跟随最新路径。
- **对话工具注册先别硬上**：dsh 核心与既有内置插件均未暴露可直接复用的工具注册 API（`ctx.tools` 经查 dsh lib 与仓库源码都无对应实现），自造 API 有插件加载失败风险。桌面入口最稳的路径就是"桌面快捷方式 + 启动 bat"，对话拉起可等官方 API 明确后再说。
- 建快捷方式用 `powershell -NoProfile -WindowStyle Hidden -Command` + `WScript.Shell`，`windowsHide: true + stdio: ignore`，失败仅 `logger.warn` 不阻塞 DSH 启动。

### 4.15 `Edge/Chrome --app` 参数绝不能加引号；Edge 已有进程时 app 窗口复用主进程（2026-08-20，DEV_NOTES 需求 #89）

用 `--app=URL` 弹独立无边框「桌面版」窗口时：

- **`--app` 的值（URL）不能加引号**：`start "" msedge.exe --app=http://127.0.0.1:3080` 正确；`--app="http://..."` 会被 Chromium 系浏览器**整个忽略**，退回普通浏览器模式启动且 URL 不跳转——表现就是"只开了浏览器、没独立窗口、没自动跳转"。浏览器 exe 路径加引号没问题，只有 URL 参数不能加。
- **Edge 已有进程时，app 窗口复用既有浏览器主进程**：此时 `msedge.exe --app=...` 会转发给已运行的主进程，新窗口**不产生新的 `--app` 进程**。所以**不能靠"进程命令行含 `--app=`"判断是否成功**，要看窗口标题：`Get-Process msedge | ? MainWindowTitle`（独立窗口标题 = URL 的 host，如 `127.0.0.1`）。
- **绑定地址归一化**：解析出的 `dsh_host` 若是 `0.0.0.0` 或 `::`，浏览器本地访问不到，需归一化为 `127.0.0.1`。
- **浏览器探测顺序**：Edge x86/x64 两个稳定路径 → Chrome x86/x64 两个路径 → 都没有才 `start "" http://...` 走系统默认浏览器兜底。

### 4.16 完全脱离浏览器开 WebUI 的正解：内嵌 WebView2（pywebview）；别再用 `--app` 依赖已装浏览器（2026-08-20，DEV_NOTES 需求 #90）

`Edge/Chrome --app`（避坑 4.15）有个硬伤：**依赖用户已装浏览器**——缺失或行为不同就弹不出独立窗口，用户直呼"非常不可靠"。要"完全脱离浏览器"就内嵌系统 WebView2（Chromium 内核，独立于浏览器进程）。官方 `dsh-desktop-windowos.exe`（4.8MB 单文件）正是这么做的。

- **技术选型（Python，贴合本项目）**：**pywebview**，Windows 后端 = `WinForms / Chromium`（本质内嵌 WebView2 Runtime）。只要系统装了 WebView2 Runtime（`C:\Program Files (x86)\Microsoft\EdgeWebView\Application`；Win10/11 普遍自带）即弹**真正独立桌面窗口**，不依赖 Edge/Chrome 是否安装。
- **安装**：便携 python（绿色版 `runtime\python\python\python.exe`）里 `pip install pywebview pythonnet`。pythonnet + clr_loader 是 Windows 加载 WebView2 的桥（都有 cp310 win_amd64 wheel 可镜像装）。
- **最小用法**：`import webview; webview.create_window(title, url, width=..., height=..., min_size=(...), resizable=True); webview.start()`。`start()` 阻塞到用户关窗口；`create_window` 成功即返回窗口对象。
- **pywebview6 的坑**：没有 `webview.GUIS`/`_core`/`destroy_window` 这些旧属性（会 AttributeError）；判断后端是否真起 WebView2，看启动日志 `[pywebview] Using WinForms / Chromium` + `loaded event fired`。
- **优雅回退**：先检测 WebView2 Runtime 目录（`EdgeWebView`），缺失或 `start()` 初始化抛异常时用 `webbrowser.open(url)` 回退系统浏览器——保证内核缺失时功能仍可用。
- **进绿色版**：绿色 zip 是**在线版不含 runtime/**，故 pywebview 由启动器 GUI 层 **`Launcher.prepare_desktop_deps()` 首次自动在线安装**（`pip install ... --index-url https://mirrors.aliyun.com/pypi/simple/`），再用 `pythonw.exe`（无控制台）直启 `desktop-shell.py`——首次装依赖给实时进度，后续直接无黑窗弹桌面窗口。
- **GUI 也会装（2026-08-20，需求 #84 更新）**：启动器 GUI 层新增 `Launcher.prepare_desktop_deps()`（幂等）——【安装环境】`prepare_all()` 末尾与【桌面窗口】`launch_desktop_shell()` 开头都会先调用：用 `python -c "import webview"` 运行时探测（**别只看 `Lib/site-packages/webview` 目录，目录列表易截断/误判**），未装则走 `_stream_subprocess` 实时进度安装，失败明确提示并回退浏览器。桌面窗口只从启动器进入（`desktop-shell.bat` 2026-08-27 已移除）。
- **`.bat` 保持 ASCII 全英文**（中文会乱码），提示语也用英文。

### 4.17 桌面版入口「不是插件、是内置」：WebView2 壳收起进启动器（2026-08-20，DEV_NOTES 需求 #91）

`dsh-green-desktop` 插件唯一副作用只是往桌面放一个 `.lnk` 快捷方式，实质逻辑（`desktop-shell.bat/.py`）是绿色版根目录本来就随包的内置文件——**为"自己绿色版才能用"的功能单独做插件是过度设计**，会引入：插件要进 profile bundle、要 pnpm/reconcile_bundles、多一层宿主端加载失败风险。

- **正解**：把入口收敛进启动器本身，`desktop-shell.py` 就是绿包内置物。launcher 的做法：
  - 配置 `DEFAULT_CONFIG["open_method"] = "desktop"`（desktop=独立 WebView2 窗口 / browser=系统浏览器）。
  - `Launcher.launch_desktop_shell()` 直接用 `subprocess.Popen([pythonw_exe, desktop-shell.py], CREATE_NO_WINDOW)` 直启（无黑窗；`desktop-shell.bat` 已于 2026-08-27 移除，不再有 bat 兜底路径），启动失败/缺 pythonw 时 `webbrowser.open()` 回退浏览器。
  - 统一入口 `open_ui(force=False, method=None)`：method 缺省取 `config.open_method`；`not force and ui_is_open()` 才去重（只约束自动打开，点按钮用 `force=True` 必开）。`start_server` / `wait_and_open` / GUI `on_start` / CLI `--start` 四处自动打开**全部归一**到这一个入口 → 自动打开跟随默认打开方式。
  - GUI：配置区**左右两栏**（左=网络设置，右=常规设置），**两栏合计控制在 ~1280 内**——窗口默认 `geometry("1160x780")`/`minsize(1000,660)`，`columnconfigure(0/1, weight=1)`；网络描述文字 `wraplength=430` 换行避免撑宽；「保存设置」两块**共用**、统一放在下方提交；常规设置加「默认打开方式」下拉、且「镜像源+端口」同行并列；原「打开界面」拆成「桌面窗口」「网页窗口」两按钮。多次在#91左右/#92上下间来回后定稿为当前"左右分栏但总宽受控"。
- **教训（GUI 布局试错）**：左右分栏比上下堆叠更省屏幕高度但也更容易被"单栏内容太宽"撑破窗口默认宽度导致右栏被截。治本是**同时压缩内容宽度**（长文本 `wraplength` 换行、字段同行并列）**且把窗口默认宽调到刚好容纳两栏**（<1280），而不是来回切上下/左右。
- **「所见即所得」设置同步**：抽一个 `sync_gui(silent=False)` 统一函数，把界面当前填入的端口/绑定/受信任主机/镜像/打开方式/自动打开整体写入 config 并落盘；`保存设置 / on_start / on_install` 三处共用——用户改了没点保存就启动服务或安装下载，也会按最新输入自动落盘再操作。教训：三处重复"各写各的转换逻辑"极易漂移，应收敛到单一入口。
- **验证新逻辑必重建 EXE**："界面改了但行为没变"（如"存了默认桌面仍开浏览器"）十有八九是**仍在跑旧 `DSH_Launcher.exe`**——它没有新代码。改完 `launcher.py` 后要用 `build_exe.bat` 的等价 PyInstaller 命令行**本地重建**再测；命令行里 `python -m PyInstaller` 需先 `set PYTHONPATH=..\runtime\pyinstaller`。
- **编译注意**：本机 `python` 可能是旧 Python 2.7（`nonlocal` 会报 `SyntaxError: invalid syntax`！）——**千万别用它 `py_compile`**，务必用 `runtime\python\python\python.exe` 或 `py -3`。区分真实语法错误的唯一可靠手段就是"用对解释器"。
- **清理取舍**：删除 `plugins/dsh-green-desktop` 源目录（不再随包、不再自动装）。后续用户要求彻底清理，最终执行：移除 live profile `web\package.json` 对 `dsh-desktop-plugin` 的依赖与 disabled 引用、删除桌面 `.lnk` 与系统 `%LOCALAPPDATA%\Programs\dsh-desktop-windowos`（官方外置 exe）、确认 `node_modules` 无 `dsh-green-desktop`/`dsh-desktop-plugin` 残留、C 盘 npm 全局无残留。桌面独立入口统一只留内置 `desktop-shell.py`（`desktop-shell.bat` 已移除，入口收敛到启动器 GUI「桌面窗口」按钮）。
- **教训（官方 dev server 会自开浏览器 → 接管界面必加 `--no-open`，DEV_NOTES 避坑 #97）**：官方 `dsh-web-app` 服务就绪后**默认自动打开系统默认浏览器**（`startup.js`: `openBrowser: options.open` 默认 true；`index.js`: `webUrl` 就绪后 `internals.openBrowser`）。已把界面打开统一收到启动器 `open_ui` 时，务必在 `build_server_command` 的启动命令末尾加 `--no-open`，否则会"官方默认浏览器 + 你自己开的界面"双开（实测：选桌面=桌面+网页、选网页=2网页）。**通用方法**：只要启动器接管"打开界面"，先**列全所有会启动界面的地方**（官方服务、内置插件、自身 open_ui），逐个确认，别只盯着自己的入口；再统一由单一 `open_ui` 打开、并给官方服务关掉自动打开。
- **教训（pywebview 窗口起不来：`start()` 之前绝不能调 `load_url()`，DEV_NOTES 避坑 #99）**：用 pywebview 做"未启动提示页"时，若在 `webview.create_window(...)` 之后、`webview.start()` **之前**调用 `window.load_url(data:...)`，WinForms/WebView2 后端的原生窗口会初始化失败/挂起——页面层被 `except Exception` 吞成一句 `WebViewException('Main window failed to start')`，还会**静默回退到系统浏览器**，非常难定位。**正解**：①先同步探测服务状态（`socket.connect_ex`）；②未就绪时把提示页 `data:` URL **直接作为 `create_window` 的初始地址**（首屏就是提示页，不闪"连接失败"）；③所有"窗口起来后的导航/轮询"放进 **`webview.start(func)` 的窗口就绪回调**里做。**通用要点**：包装任何 GUI 后端的"窗口就绪后再导航"逻辑，一律放 `start(func)` 回调，绝不放 `start()` 之前；真机失败要看真因，用**控制台 python.exe + 完整 traceback** 跑（别用 pythonw，无 stderr）；判断"后端是否支持某操作"以**实机行为**为准，别只看目录/版本探测。
- **教训（桌面窗口图标换不掉的根因，DEV_NOTES 避坑 #101）**：给 pywebview(WinForms) 窗口换图标，**正确姿势是把它交回 pywebview 自己**——`webview.start(..., icon=图标路径)`，WinForms 后端会直接 `self.Icon = Icon(icon)`（权威、免查找）。注释/文档里"icon 仅 GTK/QT 支持"是**错的**，WinForms/Cocoa/qT/GTK 都认。**别**自己在 `start()` 后发 `WM_SETICON` 换图标，因为它要靠 `FindWindowW(标题)` 找窗口，而 **WebView2 加载页面后会用页面 `<title>` 同步覆盖窗体标题** → 找不到 → 白忙。**通用避坑**：只要把 icon 相关行为交给 GUI 库托管的，优先传它的**官方参数**；对"三方库某平台到底支不支持某特性"，直接读它 `platforms/` 后端源码，别只信 docstring 默认说明。

### 4.18 背景媒体插件：`<video>` 全屏背景 + 宿主端流式路由（2026-08-24，dsh-media-background，对应项目 DEV_NOTES 需求 #104）

复刻第三方 `Olivia-Lin-in-DeepSeek-Harness` 的"本地视频做网页背景"能力时，**只取其核心播放槽**（选目录→列视频→入播放清单→全屏背景播画面+声音），砍掉对方三层解耦的独立媒体服务器/待机/时段/遮挡门帘，做单插件自包含、复用 harness `webServer` 同源路由（**不新增独立端口、不新增守护进程**）。要点：

- **流式路由选型**：媒体文件是任意绝对路径、且量大按需流式读，**不要**走 harness 沙箱 `fs`（`dsh-fs` 面向会话工作区），宿主端直接用 `node:fs` 的 `createReadStream` 流式返回；`inject=["webServer"]` 用 `ctx.effect(() => ctx.webServer.register(...), 说明)` 注册（同 dsh-file-browser）。
- **Range 支持（进度条/边下边播）**：`GET stream?path=<rel>` 解析 `Range` 头（`bytes=start-end` / `bytes=-N`），用 `createReadStream(file,{start,end})` 返回 `206` + `content-range`/`content-length`/`content-type`；无 Range 返回 `200` + 完整长 + `accept-ranges: bytes`。**平方定级**：`decodeURIComponent` 后必须 `path.resolve(dir, rel)` 再**防穿越**（`isInside` 校验 `..`，Windows 大小写不敏感需统一小写比较）。
- **核心坑：媒体流路由不能加守卫头，但要防外部网页触发**——`<video>` 标签**无法携带自定义请求头**，给 `stream` 加守卫头就播不出来；所以 `/stream` **不带守卫头**，改由"目录受限读（只读已配置目录）+ 防穿越 403"兜底；而 `config/list`（改目录/列目录）仍带守卫头（能带头的 fetch 都带）。
- **原生选目录弹窗必须给 owner 才置顶（2026-08-24 补）**：宿主端 `pickNativeDir()` 用 `execFile` 跑临时 `pickdir.ps1`（.NET `FolderBrowserDialog`），初始目录经环境变量 `DSH_PICK_INITIAL` 传入绕过脚本内联转义、ps1 为纯 ASCII。**避坑**：`ShowDialog()` 无 owner 时对话框以无主顶层窗口弹出、Windows 不强制置顶，易被其他窗口盖住看似没弹出；须在 ps1 里 `Add-Type` 内联 C# 声明 `user32.dll` 的 `GetForegroundWindow()`，把前台窗口句柄用 `System.Windows.Forms.NativeWindow` 包装成 owner 传 `ShowDialog($nativeWindow)`（用后 `ReleaseHandle()`），无前台窗口时回退无 owner 调用。
- **目录来源优先级（多入口易冲突，需定序）**：① 面板里改过的持久化 `DSH_HOME/media-background-dir.json`（POST 时 `stat` 校验是目录再写）→ ② `process.env.DSH_MEDIA_BG_DIR`（启动器 GUI 用 Windows 文件夹选择框设置的默认，`build_env()` 注入）→ ③ 空（前端提示未配置）。
- **客户端注入**：`window.__ModuleLoader__.load` 直接往 `document.body` 挂命名空间节点（背景层 `<video>` 全屏 `position:fixed; inset:0; z-index:0; object-fit:cover; pointer-events:none`），不依赖官方内部布局插槽；`<video>` 需 `muted`（音量=0 时）与 `playsinline`；播放清单/音量/浓度存 `localStorage`。
- **启动器配置对接**：`DEFAULT_CONFIG` 加 `"media_background_dir": ""`；GUI「常规设置」加"背景视频目录"行，用 `filedialog.askdirectory(title=..., parent=...)`（Windows 自带文件夹选择框，与选工作区同类）；`build_env()` 里 `env["DSH_MEDIA_BG_DIR"]=media_dir`。改动须**重打包 exe** 才生效（GUI 行为"改了没变化"多为旧 exe）。
- **安全**：目录受限读（只读用户配置的那个目录）；`stream` 对 `..` 越界一律 403；`config/list` 带守卫头才放行。刻意**不硬改 harness 主题 token**（如 `--dsw-alias-bg-base`），用 `opacity` 半透明壁纸（默认 ~35%）透出，避免影响正常对话观感。
- **格式扩展 + 纯音乐（2026-08-24，需求 #105）**：把扩展名集拆成 `VIDEO_EXTS` / `AUDIO_EXTS` 两套即可让同一个全屏 `<video>` 同时播 mp3/wav 等音频（`<video>` 原生支持音频轨道，`stream` 端 `content-type` 按表回 `audio/*`）。**纯音乐绝不能走"背景板全透明 + video 显示画面"**——`<video>` 底是黑色 `#000`，整窗会变黑底听歌；纯音乐需 `setBackgroundActive(false)` 恢复原生背景板 + `videoEl.style.display="none"` 只出声（保留原深色壁纸当视觉）。mkv/flv/wmv 等能否解取决于浏览器内核/编码，**统一列出交给浏览器尝试**，解不了会触发结束事件、前端 `onEnded` 自动跳下一首，不影响清单其余项。清单项/试播项加 `kind` 字段区分，旧版 localStorage 无 kind 时默认 `video` 兼容。
4.19 **内置插件主题自适应（2026-08-24，需求 #106）**：做插件 UI 必须用 harness 语义 CSS 变量 `--dsw-alias-*`（主文字 `label-primary`、次文字 `label-secondary`、弱文字 `label-tertiary`、面板背景 `bg-layer-2`、底座 `bg-base`、边框 `border-l1/l2`、hover `interactive-bg-hover`、主按钮 `button-primary-fill`、错误 `state-error-primary`、遮罩 `bg-mask-N`）。深浅主题由根容器 `body[data-ds-dark-theme]` 自动换值、CSS 变量级联，**不用写任何 JS 主题判断/监听**。禁引 `--dsw-static-*` 当底色/文字/边框（静态色不随主题）；状态装饰（运行蓝 `#1a56db`、成功绿、危险红、品牌强调 `#4a7bff`）与阴影可留少量静态色。改造用 `var(--x, #回退值)` 写法可安全兜底。切记 media-background 的背景透明语义（`html.dsw-mbg-active` / `setBackgroundActive` / `applyMediaMode` / `--dsw-alias-bg-base:transparent` / `<video> background:#000`）是刻意为之、不能因主题化误改——只改面板控件色即可。**凡是无显式 `color`、靠父级继承的文字（正文/标题/数值/折叠 summary）也要显式补 `var(--dsw-alias-label-*)`，否则深色下会落到默认黑字看不清**；**固定深字侧同理（2026-08-25，需求 #108 补漏）**：浅框表格里无显式 `color` 的单元格（如价格表模型名）也要显式补固定深色 `#1f1f1f`，否则深色下继承页面白字、白字落白底。参考：7 个内置插件已全量按此适配（theme 变量权威定义在 `runtime/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js`）。**重大补漏（2026-08-25 实测，dev 流程必读）：改完 `plugins/` 源码必须同步运行副本！** 插件经 `dsh plugin add file:`（pnpm）是**拷贝**进 `runtime/dsh-home/profiles/web/node_modules/<插件>/`，dsh 实际跑的 bundle 读的是**安装副本**；只改 `plugins/` 源码不重装/不同步，改动在运行端**静默不生效**——#106 全量主题化改造就因没同步，用户切深色后用量统计仍是旧白框（`#fff`/`#f5f5f5`/`#fafafa`）。同步法：`Copy-Item -Path "$src\*" -Destination $dst -Recurse -Force`（PowerShell `Copy-Item -Destination` 遇已存在目录会**嵌套**复制、须用 `$src\*` 复制内容）；dsh 运行中 `lib/index.js`/`cordis.patch.yml` 被锁无法覆盖、`lib/client.js` 按请求生成不受锁；同步后纯客户端改动**强刷页面**即生效、服务端改动需**重启服务**。或直接 `--install-plugin file:<绝对路径>` 重装（幂等很快）+ 重启服务。**分层决策（2026-08-25，需求 #108 细化）**：不是"全都随主题"就最好——**锚定在固定浅色背景框里的内容要整组固定（浅框 `#fff`/`#f5f5f5`/`#fafafa` + 深字 `#1f1f1f`/`#555555`/`#8a8f98`）**，不能只让框内文字随主题变白（白字落白底看不清）；只有框外的页面级文字才用 `var(--dsw-alias-label-*)` 随主题。改主题前先分清"浮在页面底上的文字 vs 框内文字"。**宿主端调 DeepSeek API 拿凭据（2026-08-25，需求 #109 余额接入实测）**：用户经 WebUI 设置面板配置的 API Key 由 harness 持久化到 `$DSH_HOME/.credentials.yaml`（格式 `refs:\n  DEEPSEEK_API_KEY: sk-xxx`，`$DSH_HOME` 默认 `%USERPROFILE%\.dsh`，绿色版在 runtime/dsh-home）；宿主端插件调用 `DEEPSEEK_API_KEY` 的凭据**取值优先级=运行进程环境变量 → 解析该 yaml**（去 UTF-8 BOM + 正则 `^\s*DEEPSEEK_API_KEY\s*:\s*(\S+)` 取首项）。**Key 绝不能传给前端**：宿主端路由持 Key 调官方接口（如 `GET https://api.deepseek.com/user/balance`，node 全局 `fetch` + `AbortController` 设超时），再只把结果 JSON 返回给客户端；读 `credentials` 属官方 `PRIVILEGED_METHODS`，本插件的取巧是直接读文件而非调 credentials 服务。

4.20 **接入第三方模型/Provider（Ollama 等）：写 pi-ai 的 `providers` 配置，别自己注册适配器（2026-08-27，dsh-ollama，对应 DEV_NOTES 坑 31-33）**：官方多 Provider 底座是 `dsh-llm-pi-ai`（命名空间 `llm-pi-ai`），要给 DSH 加新模型源（Ollama / LM Studio / vLLM 等任何 OpenAI 兼容服务）**绝不要**自己调 `ctx.llm.registerAdapter`（对 provider 路由**排他**）或 `ctx.llm.registerModelDiscovery`（每 namespace **只能一个**）——直接注册必与 pi-ai 冲突。**正解：经 `ctx.settings.mutate("llm-pi-ai", ops)` 把 `providers.<id>` 写进设置节**，pi-ai 监听变更自动注册模型目录 + 对话路由 + 模型发现：

- **Ollama 接入配方**：`api: "openai-completions"`（OpenAI 兼容端点） + `baseURL: "{baseUrl}/v1"`（默认 `http://localhost:11434`）+ `models: [{id,name,contextWindow,maxTokens}]`（从 `/api/tags` 探测）。探测不到服务/超时（`AbortController` 3s）静默跳过、周期重试（60s）；首次写入全量、已存在则仅当 baseURL 一致时才补缺字段 + 同步模型列表（**尊重用户在 Models 页的手改，不覆盖 displayName/api/baseURL/模型参数**）。
- **上下文容量配置错位 = "能对话但从不调工具 + 报 token 上限" 双故障同源（2026-08-27 实测，对应 DEV_NOTES 坑 35）**：①**`maxTokens` 绝不能等于 `contextWindow`**（如都设 16000 → pi-ai 认为输出上限 = 总上下文、输入空间为零 → 必然截断）；正确如 32768/8192。②**DSH 的 system prompt + 工具 schema 上万 token，Ollama 默认 `num_ctx` 只有 4096/16384 → 工具定义被截断 → 模型收不到工具**。③提升 Ollama 上下文**别用 `OLLAMA_CONTEXT_LENGTH` 环境变量**（桌面版 `ollama app.exe` 启动的 serve 实测不继承，`/v1` 端点也不转发 `options.num_ctx`）；**正解是 Modelfile 固化并重建**：`FROM qwen3:4b` + `PARAMETER num_ctx 32768` → `ollama create qwen3:4b-32k -f Modelfile`（任何方式启动都生效，`api/ps` 验证），DSH 指向 `-32k` 变体。④**dsh-ollama 插件每次探测用 `ollama-config.json` 的默认容量重建 models**，面板里 `defaultContextWindow/defaultMaxTokens` 也要同步改，否则 settings.yaml 手改值会被覆盖回去。
- **OpenAI 兼容服务必配 `compat`（工具调用关键，2026-08-27 实测）**：Ollama / LM Studio / vLLM 等端点**不认 OpenAI 官方方言**——`developer` 角色、`max_completion_tokens` 字段、工具定义里的 `strict` 字段都会被丢弃/拒绝；pi-ai 对无法识别的端点默认按 OpenAI 官方协议发送，结果**工具 schema 到不了模型、模型接入后从不调用 DSH 工具**。正解：`compat: { supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: "max_tokens", supportsStrictMode: false }`（system 角色、`max_tokens` 字段、不带 strict 的工具）。验证：带 tools 直测 `/v1/chat/completions` 应返回 `finish_reason: "tool_calls"` + `message.tool_calls`。
- **thinking 模型关思考只认 `reasoning_effort`，不认 `think: false`（2026-08-27 实测，对应 DEV_NOTES 坑 37）**：qwen3/gemma 等带 `thinking` 能力的模型默认思考，把 `max_tokens` 烧在 reasoning 上、还没轮到工具调用就被截断。新版 Ollama `/v1` 端点**静默丢弃顶层 `think: false`**（原生 `/api/chat` 才认）；**只有 `reasoning_effort` 生效**。因此 `compat.supportsReasoningEffort` 必须为 `true`，且每个模型声明 `reasoningEfforts: { off:"none", minimal:"none", low:"low", medium:"medium", high:"high" }`——DSH 思考档位 off 时 pi-ai 发送 `reasoning_effort="none"` 关思考。实测（`runtime/tmp/pi_ai_ollama_repro.js` 直连 pi-ai）：思考片段 0、正常调用 `web_search`（stopReason=toolUse）。
- **面板/配置改 `defaultContextWindow/defaultMaxTokens` 不生效，生效的是 `target*`（2026-08-27 实测，对应 DEV_NOTES 坑 38）**：`buildProviderProfile` 取容量是 `target* || default* || 内置默认`，`ensureContextVariants` 也只认 `targetContextWindow`——用户（或 DSH 的 AI）在面板改"默认上下文/最大输出"＝改了个**被 target 盖掉的回退字段**，表现为"优化了插件设置但依旧不行"。**面板应暴露生效字段**：dsh-ollama 面板已把两个数字框改绑 `targetContextWindow`/`targetMaxTokens`（宿主端 `sanitizeOverrides` 本就校验），并标注为"目标/生效值"。排查"AI 优化了配置却没效果"时先核对改动的是不是生效字段。
- **周期自动写入必须保留用户手改的生效字段（2026-08-27 实测，对应 DEV_NOTES 坑 39）**：`applyOllamaProfile` 的"已存在 provider"分支里，`modelsEquivalent` 不相等时若直接写插件默认的 `profile.models`，用户在 Models 页手改的 contextWindow/maxTokens/name 会被下一轮探测（默认 60s）覆盖回默认值——又是"改了不生效"。**正解：写 `mergeModelParams(currentProfile.models, profile.models)`**（已有模型保留手改参数、新增模型套默认、reasoningEfforts 以新列表为准补齐）。教训：任何"周期自动写入"逻辑都要先问一句"会不会覆盖用户手改的生效字段"。
- **免鉴权服务必带占位 Authorization 头**：pi-ai 的 `openai-completions` 协议校验 `getClientApiKey()`——无 `apiKeyEnv` 也无 headers 直接抛 `No API key for provider`；但给 Ollama 这类服务写 `apiKeyEnv` 又会因缺真实 Key 报 `MISSING_CREDENTIAL`。**正解：配置 `headers: { Authorization: "Bearer ollama-local" }` 占位头**，Ollama 不校验、pi-ai 原样透传。
- **thinking 模型"Deep diving…"是正常思考态**：带 `thinking` 能力（`/api/tags` 的 `capabilities`）的模型先流式 `delta.reasoning`（pi-ai 映射 `reasoning-delta`，UI 显示"Deep diving…"），**思考完才出正文**；本地 4B 冷启动 + 思考要十几秒~几十秒，别误判卡死。
- **curl 直测 OpenAI 兼容端点（Windows/PowerShell）**：`-d '...'` 单引号 JSON 会被 PowerShell 吃掉（报 `invalid character 'm'`）→ JSON 写临时文件 `curl --data-binary "@file"`；`GET /api/ps` 空数组 = 模型未加载（冷启动慢）。
- **插件形态**：纯宿主端 `lib/index.js` 即可，零原生依赖、零构建（探测用 Node 全局 `fetch`）；配置项（baseUrl/displayName/探测间隔等）由 `cordis.patch.yml` 的 `config` 覆盖；模型参数（contextWindow/maxTokens/baseURL）用户直接在 WebUI Models 页改。想免编辑文件改插件配置，再加 `dsh.client` 客户端设置面板。
- **验证链（四环缺一不可）**：① `GET {baseUrl}/api/tags` 能列模型；② `settings.yaml` 里 `llm-pi-ai.providers.ollama` 已写入（含 `compat`，重启服务后持久）；③ WebUI 模型选择器出现 Ollama 模型 + 真实对话有回复（耐心等 thinking 模型思考完）；④ **工具调用实测**：让模型"查一下现在几点"（或任一需要工具的任务），观察它是否真的发起工具调用并返回结果——不调用即 compat 缺失（见上条）。端到端通过后，改动同步更新 DEV_NOTES.md 与本文档。

### 4.21 `webServer.register` 无 `method` 字段：同一 path 只能注册一次，GET/POST 须在同一 handler 按 `req.method` 分流（2026-08-27，dsh-ollama 设置路由 404）

- **现象**：dsh-ollama 的 WebUI「设置 → Ollama 设置」面板客户端 fetch `/__dsh/ollama/config` 一直 404，但插件探测/接入 provider 都正常（settings.yaml 里 ollama provider 已写入、模型已同步）。
- **根因**：`@deepseek-ai/dsh-host-webserver` 的 `WebRoute` 只有 `kind` / `path` / `handler` 三个字段（`lib/types/index.d.ts` 确认），**没有 `method` 字段**——想区分 GET/POST 必须在**同一个 handler 里按 `req.method` 分流**。对同一 path 分别注册 GET 路由和 POST 路由会抛 **"Duplicate (kind, path)"** 错误，异常把整个插件 fiber 回滚、**所有**路由（不止 POST）全部失效 → 客户端 fetch 全 404。注意与 4.3 的 405 语义不同：404 = 路由根本没进 exact 表。
- **修复**：合并为单一路由、handler 内按 `req.method` 分流：
  ```js
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/__dsh/ollama/config",
    handler: async (req, res) => {
      if (req.method === "POST") { /* 解析 body + 校验 + 保存 + 立即重新接入 */ return; }
      /* GET 与其余方法: 返回当前生效配置 + 连接状态 */
    }
  }), "dsh-ollama: config route");
  ```
- **排查"路由注册了却 404"三步**：① 核对是否同 `(kind, path)` 注册了两条（撞车必抛错回滚全插件路由）；② 抓首页 `window.__DSH_BOOT__.entries` 是否含该插件的 client 条目、`curl /plugins/<id>/client.js` 能否 200（排除客户端根本没加载）；③ 若面板是 `settings.section` 注册——它在设置页生成的是**侧边栏导航行**（按 `order` 排序，order 大排最后），**不是顶栏独立标签**，浏览器验证时要滚动侧边栏找（dsh-ollama order=520 排在「用量统计」之后）。
- **改完同步 + 重启**：`plugins/` 源文件与运行副本是 **pnpm 硬链接**同一物理文件（`fsutil hardlink list <副本路径>` 可见双路径）→ 改源码即改副本，但**运行中的服务内存里仍是旧代码，必须重启服务**；重启后 `node` 仍持有文件句柄时 `Copy-Item` 覆盖报"被另一进程占用"（硬链接同 inode 所致）属正常——内容已共享，无需再拷，`Get-FileHash` 双路径一致即证明已同步。

### 4.22 后台自动探测型插件要提供「主动重接入」入口（2026-08-27，dsh-ollama 「一键接入」按钮）

- **背景**：外部服务探测类插件（识别本地 Ollama / LM Studio / vLLM 等）默认是**后台周期探测**，一旦「启动时或更新后的那一轮没接上」（如外部服务比 DSH 晚启动、更新后 provider 列表停在旧状态），用户**没有任何主动重试入口**，只能等下一轮或重启服务，体验割裂。
- **正解**：给 WebUI 面板加一个手动「一键接入」按钮，走**独立路由** `POST /<route>/reconnect`（复用现有的 `runDetection(..., {force:true})` 逻辑 + `configPayload()`），客户端按钮放置于状态卡「已接入/未接入」徽章旁。要点：
  - **独立 path**：新路由与配置读写路由 `/config` 用**不同 path**，避免违背 4.21 的"同一 path 只能注册一次"。
  - **`force:true` 全量重写、但保留用户手改项**：`applyOllamaProfile` 的 force 分支里用 `mergeModelParams` 合并——已有模型保留 Models 页手改的 contextWindow/maxTokens/name，新增模型套默认容量。
  - **不干扰持久化配置**：`/reconnect` 内部只 `runDetection`，**不要写 `ollama-config.json`**，避免"点一下接入"意外清空用户在面板保存的覆盖值。
  - **离线也是正常返回**：外部服务未开时 `runDetection` 返回 `false`（不抛异常），路由照常 `200` 返回 `reconnected:false` + `status.lastError`，客户端据此显示"未检测到服务"而非报错。
  - **置忙防连点**：客户端按钮 `disabled: busy`，文案切「接入中…」。

## 五、验证与排查速查表

| 症状 | 首选排查动作 |
|------|-------------|
| WebUI 入口不显示 | 抓首页 `window.__DSH_BOOT__.entries` 是否含插件 → 查 `exports` 是否含 `./package.json` → 查 `files` 是否含 `cordis.patch.yml` |
| 客户端组件不渲染 / 按钮消失（控制台 `componentDidCatch`、Rendered more/fewer hooks） | 查条目组件是否**条件调用 props 传入的 hook**（`typeof useXxx === "function" ? useXxx() : null`）→ 改读 ownerProps 里的普通数据字段（如 `input.draft`）→ 强制刷新页面（改客户端源码无需重启服务） |
| 点击按钮 HTTP 405 | 查路由是否注册进 exact 表 → 确认 `ctx.effect(() => register(...), label)` 写法 → 查 `dsh-host-frontend-static` fallback 行为 |
| 客户端 fetch 报 HTTP 404（服务端插件明明有路由） | 查是否同 `(kind, path)` 注册了两条路由（`webServer` 无 `method` 字段，重复注册抛 "Duplicate" 回滚全插件路由）→ 合并为单 handler 按 `req.method` 分流 → 重启服务（见 4.21） |
| 路由 403 | 自定义头没带对（`x-dsh-plugin-purge: 1`），或来自跨域（无法带自定义头） |
| 会话 shell 报 ACL temp 冲突 | 临时目录在工作区内 → 换用 `BASE_DIR/workspace` 或工作区外目录 |
| "Failed to fetch" / 服务 40 秒退 | stdin 读到 EOF → 用 `stdin=PIPE` 保持打开 |
| 日志报 `Unexpected token '\ufeff'` | 某 npm 包 package.json 带 UTF-8 BOM → 安装前/读入后去 BOM |
| 改插件源码 WebUI 没变化 | pnpm 对 `file:` 是拷贝 → 重新安装插件 + 重启服务 |
| 安装插件后**服务重启即退出**（`ERR_MODULE_NOT_FOUND: ...lib/index.js`） | **纯客户端插件也必须带宿主端 `lib/index.js`**（官方 no-op：`function apply(){} export { apply }`）——`exports["."]`/`main` 必须指向真实存在的模块，缺了它插件树加载失败、整个服务起不来 |
| 消息行看不到自定义操作按钮 | 先确认官方已原生覆盖（正文复制 / 在新对话中分支 / 悬停用时首token速率 / StatsLine token 合计）→ 检查 `conversation.chat.assistant-actions`（`order` 20+）或 `conversation.chat.turnTail`（chain `select`）注册是否生效 → 强制刷新页面 |
| 插件树里有但入口没有 | 重启服务（加减插件需重启生效） |
| 装了插件在 WebUI 看不到任何东西（无 UI） | 查插件 `package.json` 有无 `dsh.client`——无则是宿主端工具/路由插件，靠 agent 按需调用（如 `find_dsh_plugin`）或 HTTP 路由验证，不是装坏了 |
| `dsh --dump-config` 看不到自定义插件层 | 先 `$env:DSH_HOME=runtime\dsh-home` 再 dump（否则加载 `~/.dsh` 默认 home，只有内置 bundle） |
| 双端插件"树里有、设置界面有、但工具/skill 不生效" | 查插件自身运行时前提：外部解释器版本（如 dsh-vision-toolkit 要 Python 3.11+）、下载型依赖（managed 环境是否已建）、API credential（`VISION_API_KEY` 是否配）→ 看 server.log 里插件 `ctx.logger.error` 的 "runtime not ready" 提示 |
| 会话突然全部被 400 拒绝（`Cannot read properties of undefined (reading 'prepare')`，孤儿 `tool_calls` 毒化） | 用「设置 → 会话回退」插件：分析会话 → 定位崩溃回合 → 在崩溃回合之前的**已完成**回合点「回退到此」派生干净续接会话（`session.fork`）；服务停止时可用 `tools/rewind-session.mjs` 离线原地回退 |
| 界面空白（GUI 布局） | `ttk.Panedwindow` 漏 `.add()`；滚动条被列宽挤成 1x1 |
| 多次重启累积一堆相同 WebUI 标签页 | 查 `dist/index.html` 是否含 `dsh-launcher-ui-beacon` 标记（无则 `patch_frontend()` 没跑，多半是旧 exe/没重启）；有心跳仍开新页则查 3081 端口占用或 `runtime/ui-beacon.token` |
| 「检查绿色版更新」查不到/报错 | 依次查：网络能否访问 api.github.com / 镜像 `mirror.nju.edu.cn/github-release`；Release 是否存在且 tag 带 `v` 前缀；资产名是否以 `DSH_Launcher_GreenPortable_Online_` 开头（否则 `green_find_zip_asset` 匹配不到） |
| 绿色版更新后启动器没被替换 | 更新是独立更新程序 `DSH_Update.exe --apply runtime/update/update_job.json` 完成：查 `runtime/update/backup/` 有无备份、`runtime/update/update_job.json` 是否生成、`server.log` 有无启动更新程序日志；失败会弹窗给出手动下载地址（发布页 + zip 直链）。旧 `update_apply.bat` 方案已废弃（避坑 #47/#68） |
| 桌面窗口打开后却是"连接失败"网页 | 多半桌面窗没起来、`open_in_shell_window` 里 `start()` 前 `load_url()` 致 `Main window failed to start` 后**回退到系统浏览器** → 将提示页 `data:` URL 设为 `create_window` 初始地址，导航放 `webview.start(func)` 回调（避坑 4.17/#99）；用控制台 python.exe 跑看完整 traceback（别用 pythonw） |
| 桌面窗口图标是默认（pythonw 的） | **没往 `webview.start(icon=图标路径)` 传 icon**→ WinForms 后端走 else 分支 `ExtractIconW(sys.executable)` 挖 pythonw 默认图标；**WinForms 后端本就支持 `webview.start(icon=)`**（会 `self.Icon = Icon(icon)`）——别信"仅 GTK/QT"注释（避坑 4.17/#101）。自绘 `WM_SETICON` 依赖 `FindWindowW(标题)`，而 **WebView2 会用页面 `<title>` 覆盖窗体标题**，因此常失效、只能当双保险 |
| 远程浏览器打不开 WebUI / 启动后进程立即报错退出 | 查 `dsh_host` 是否为 `0.0.0.0` → 查 `startup.js` 补丁是否生效（`dsh-web-app/lib/startup.js` 里 `options.host === "0.0.0.0"` 是否已替换为 `false`）→ 查 `install_dsh()` 后是否调了 `patch_web_startup()`（dsh 升级重装会还原补丁） |
| 远程浏览器打不开 WebUI（进程正常） | 服务端命令行查 `--host` 是否为 `0.0.0.0` → 远程电脑 `telnet <服务器IP> 3080` 测端口连通性 → 查防火墙 / 路由器 |
| 远程浏览器能打开但心跳不上报（自动打开界面失效） | 查 `patch_frontend()` 注入的心跳脚本是否从 `127.0.0.1` 改为 `location.hostname`（`dist/index.html` 里 `dsh-launcher-ui-beacon` 块）；查心跳服务绑定地址是否随 `dsh_host` 联动为 `0.0.0.0`（否则远端连不上 3081 端口） |
| 远程浏览器能聊天但改设置报 403 | 正常行为——dsh 的 `PRIVILEGED_METHODS`（settings/credentials/host.pickDirectory）即使 LAN 部署也仅回环可调，为官方安全保护，非 bug |
| 手动填了受信任主机但没生效 | ①查 `trusted_hosts` 值为逗号分隔字符串而非数组（`config.json` 里应为 `["192.168.1.10:3080"]` 而非 `"192.168.1.10:3080"`）→ 查 `build_server_command()` 是否生成对应的 `--trusted-host` 参数；②dsh 官方 `resolveLanTrust` 绑定 0.0.0.0 时无条件自动信任全部局域网 IP（填了也白填），需 `patch_lan_trust()` 补丁后才"填了=只信任填写的"（查 `dsh-web-app/lib/index.js` 是否含 `extra.length === 0 ?` 分支） |
| 填了受信任主机却仍整个局域网都能访问 | dsh 官方行为（`resolveLanTrust` 无条件 `[...lanAddresses, ...extra]` 自动全局域网放行），非 bug——需要"只信任填写的"语义必须应用 `patch_lan_trust()` 补丁（改 `node_modules` 内官方文件，升级重装会还原，`install_dsh`/`start_server` 会自动重打） |
| 点最小化窗口却进了任务栏、没进系统托盘 | ①钩子只装在 `add()` 没在 `__init__`（第一次最小化时托盘图标还没出现→漏拦截）→ 移到 `__init__`；②`winfo_id()` 拿到的是 `TkChild` 子窗口、或窗口未 realize 导致 `GetAncestor` 拿错窗口 → 先 `update_idletasks()` 再 `GetAncestor(GA_ROOT)`；③WndProc 里直接调 `after`/`withdraw` 重入 Tcl 崩溃或 `--windowed` 下 `stderr=None` 输出崩 → 改用「WndProc 只置标志位 + `after(80,...)` 轮询 `poll()`」；恢复后再最小化又失效则 `remove()` 误还原了窗口过程（应只删图标，退出才 `dispose()` 还原） |
| bat 双击/调用"闪退"但代码看着没问题 | 先分清「窗口关闭」与「逻辑失败」：带 `pause` 的 bat 若真失败会暂停显示错误、不会闪退。抓取完整行为用 Python `subprocess.run(["cmd","/c",bat], capture_output=True, text=True)`——**别用 PowerShell `Start-Process -RedirectStandardOutput/Error`**（重定向管道与 cmd 的 `pause` 交互冲突，输出被吞、看起来像闪退）。再字节级检查 bat 是否全 ASCII、无 BOM、CRLF（非 ASCII 注释在 GBK 代码页下变乱码虽不致命但难看） |
| 改了默认价格 WebUI 还是旧价 | 改价格表必须**同时改 `PRICES_KEY`（localStorage 键）**——键不变则用户浏览器里已存的旧价永远覆盖新默认；改键后 loadPrices 读不到新键自动回退新默认。客户端 bundle 按请求生成，强制刷新页面即可生效，无需重启服务 |
| 模型选择器没有 Ollama 等新 provider / 选了发消息报 `No API key for provider` | ①查 `settings.yaml` 里 `llm-pi-ai.providers.<id>` 是否已写（重启服务后持久，改插件源码须同步运行副本 + 重启，见 4.19/坑 16）；②免鉴权服务（Ollama 等）须有占位 `headers.Authorization`（无 apiKey 无头必报 `No API key for provider`，见 4.20）；③模型是 thinking 模型时"Deep diving…"是正常思考态，耐心等正文（见 4.20） |
| Ollama 接入后能对话但**从不调用工具**（模型收不到工具 schema） | **compat 缺失**：Ollama / LM Studio / vLLM 等 OpenAI 兼容端点不认 `developer` 角色 / `max_completion_tokens` / 工具 `strict` 字段，pi-ai 默认按 OpenAI 官方方言发送会被丢弃 → provider 配置必须带 `compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens", supportsStrictMode: false }`（查 `settings.yaml` 的 `llm-pi-ai.providers.<id>.compat` 是否在；dsh-ollama 0.1.0+ 自动写入，见 4.20/坑 31） |
| 对话停在"Deep diving…"很久 | thinking 模型先思考后出正文（本地 4B 冷启动 + 思考十几秒~几十秒）；先 `GET /api/ps` 确认模型已加载、再耐心等，别误判卡死（见 4.20） |

## 六、工作流建议（绿色整合版启动器开发顺序）

1. **先理数据目录**：确认 `DSH_HOME` / `runtime/` 全部重定向到程序目录，明确"绿色整合"边界。
2. **再搭启动**：便携 Node → `lib/bin.js` 启动 → `stdin=PIPE` → 就绪检测 → 自动开浏览器。
3. **后做维护**：检查更新（备份优先）→ 插件管理（pnpm 便携化）→ 数据维护（会话删除）→ 绿色版自更新（双通道，见 3.4）。
4. **最后开发插件**：先写宿主 `index.js`（路由），再写客户端 `client.js`（设置区块），双端声明齐全 → `--dump-config` 验证插件树 → 抓 `__DSH_BOOT__` 验证客户端 → 实测路由。
5. **贯穿始终**：每个改动同步更新 md 文档；`.bat` 用 ASCII + CRLF；变量名用英文全称不缩写。
