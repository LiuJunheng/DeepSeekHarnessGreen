# DeepSeek Harness 一键启动器 · 开发记录（需求 / 设定 / 规范 / 避坑）

> 本文档按项目约定持续更新，记录需求内容、代码设定、规范细节与避坑经验。

## 一、需求内容
1. 用户希望把 DeepSeek Harness（dsh）封装成**双击即用**的形态：
   - 不做"敲命令安装 + 手动开浏览器"的传统流程
   - 自动完成：便携 Node 准备 → dsh 安装 → 服务启动 → 自动打开浏览器
2. 形态选型：用户选择 **Python GUI 启动器**（tkinter），配套 `.bat` 一键入口
3. 网络：用户选择 **镜像自动检测**（国内优先、失败回退官方）
4. 所有运行时数据（Node、dsh、会话）放在程序目录内，**绿色便携**，可整目录拷走
5. dsh 官方会持续发版，需要**检查更新**能力：GUI「检查更新」按钮 → 查询 npm 最新版 → 弹窗让用户选择更新/不更新 → 更新前**自动备份旧版本**到 `runtime/dsh-backup-<版本>`，不覆盖，备份由用户手动管理是否删除
6. 需要**可视化插件管理**：GUI 主窗口第六个按钮「插件管理」弹出新窗口，可查看已安装插件、搜索插件（npm 注册表 + GitHub 官方 `dsh-plugin` 话题页）、安装 / 移除插件
7. **数据维护需求（会话删除管理）**：dsh 官方没有"永久删除会话"功能，网页"归档"只是把会话**隐藏**（日志与注册表条目全部保留）。用户需要能**彻底删除**归档/指定会话的能力，于是：
   - 启动器主窗口新增「数据维护」区（清理归档会话 / 删除会话…可视化列表），并配套命令行 `--purge-archived` / `--purge-session <ID>`
   - 用 DSH 里的 AI 开发了 **`dsh-archive-purge`** 插件：在 WebUI「设置 → 清理归档」里一键清理归档会话（宿主端注册本地路由 + 客户端注入设置区块），并在插件管理里增加**「选择本地插件文件夹安装…」**按钮，方便安装本地插件
8. **本地插件安装优化**：手动安装栏除了 npm 包名 / `github:owner/repo#commit` 外，还支持直接选择**本地插件文件夹**（含 `package.json`）安装；`--install-plugin` 命令行同样支持传本地目录
9. **工作区不写死（自动检查解决 ACL 冲突）**：此前为解决"程序根目录工作区与 `runtime/tmp` 冲突"写死了 `workspace` 子目录；用户要求去掉写死——由启动器**自动检测**临时目录与工作区是否冲突并解析出安全的默认工作区（详见避坑 #31）
10. **清理归档支持选择会话（2026-08-15）**：WebUI「设置 → 清理归档」从"一键清空全部"升级为**列表勾选 + 选择清理**（对齐 GUI 启动器「数据维护」的可视化删除）：宿主端新增 `GET /__dsh/archive-purge` 列出已归档会话（id/标题/工作区/运行状态），`POST` 支持请求体 `{"ids": [...]}` 仅删所选、省略则清空全部；同时修复了「点击按钮报 HTTP 405」的路由注册 bug（见避坑 #34）
11. **经验沉淀为 Skill（2026-08-15）**：把本项目部署 / 维护 / 插件开发全套实测经验整理成 TRAE Skill **`dsh-deploy-maintain`**（源文件在 `skills/dsh-deploy-maintain/`，已复制安装到 `~/.trae-cn/skills/dsh-deploy-maintain/`）。结构：`SKILL.md`（主文档，部署/维护/插件/排查速查表）+ `checklists/`（deployment-checklist / plugin-dev-checklist）+ `references/`（plugin-skeleton 插件代码骨架 / data-directories 数据目录机制）。Skill 内已内置 34 条避坑浓缩版；后续新增经验要同步回 SKILL.md 与 checklists

## 二、代码设定（launcher.py）
| 模块 | 设定 |
|------|------|
| 依赖 | 仅 Python 标准库（tkinter / urllib / subprocess / zipfile / tarfile / webbrowser / socket），零第三方依赖 |
| 便携 Node | 自动下载 `node-v22.20.0` 到 `runtime/node`；国内 `registry.npmmirror.com/-/binary/node/...`，官方 `nodejs.org/dist/...`；zip（win）或 tar.gz（linux） |
| dsh 安装 | 优先 `node.exe npm-cli.js install --prefix runtime/dsh @deepseek-ai/dsh`（用便携 Node 自带 npm），按镜像附 `--registry`；`install_dsh()` 只负责安装，`prepare_dsh(force)` 负责"缺失则装/强制重装" |
| dsh 更新 | `dsh_latest_version()` 用 `npm view @deepseek-ai/dsh version` 只读查最新版；`backup_dsh()` 把旧版拷到 `runtime/dsh-backup-<版本>`（同名加时间戳后缀）；`update_dsh()` = 查询→备份→强制重装，备份失败即中止避免数据丢失 |
| dsh 启动 | 直接调 `node <dsh>/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3080` |
| 数据隔离 | 环境变量 `DSH_HOME=runtime/dsh-home`，会话/配置/存储全部落在程序目录 |
| 绿色便携 | `build_env()` 把 npm 缓存/用户配置、pnpm home/store、TEMP/TMP 全部重定向到本地 `runtime/` 下（见下） |
| 工作区自动解析 | **不写死工作目录**：`resolve_default_workspace()` 自动判定——`workspace_conflicts_with_tmp()` 用 `os.path.commonpath` 检测"临时目录是否为工作区子路径"；冲突（程序根目录内含 `runtime/tmp` 的绿色便携默认形态）时默认工作区取程序目录内 `workspace` 子目录（`DEFAULT_WORKSPACE_SUBDIR`），不冲突时直接用程序根目录本身；config.json 的 `default_workspace` 可显式覆盖（冲突则警告并回退）。`seed_default_workspace()` 按解析结果预置注册表记录（title=目录名），详见避坑 #31 |
| 就绪检测 | 后台线程 socket 轮询端口，就绪后 `webbrowser.open` |
| 进程管理 | Windows 下 `CREATE_NO_WINDOW` 隐藏服务控制台；PID 写 `runtime/server.pid` 供独立 `--stop` 使用；**stdin 用 `PIPE` 保持打开**（否则 dsh 读到 EOF 会退出，见避坑 #12）；`watch_server` 线程监听异常退出并记日志 |
| 界面 | tkinter：状态栏 + 安装/启动/停止/打开界面/检查更新/刷新状态 + 设置(镜像/端口) + 运行日志框；关窗自动停服务 |
| 插件管理 | 第六个按钮「插件管理」开新窗口；已装列表读 `runtime/dsh-home/profiles/<profile>/package.json` 的 `dependencies`；安装/移除走 `node bin.js plugin --profile <profile> add|remove`（内部转发 pnpm）；搜索源 = npm 注册表 API（国内镜像优先，结果经 `_is_dsh_plugin_package` 过滤只留 dsh 相关包）+ GitHub 官方话题页 `https://github.com/topics/dsh-plugin`；另有「加载推荐」按钮展示内置 `RECOMMENDED_PLUGINS`（npm 上已核实的 12 个 dsh 插件，无需网络也能看到可安装项）；GitHub 源插件安装规格 `github:owner/repo` |
| 本地插件安装 | 手动安装栏新增「选择本地插件文件夹安装…」按钮（`filedialog.askdirectory` 选目录）；`install_plugin()` / `--install-plugin` 均支持：入参 `os.path.isdir(spec)` 为真时自动归一化为 `file:<绝对路径>`（`\`→`/`）交给 pnpm；pnpm 对 `file:` 本地路径默认**拷贝**而非软链，改源文件后需重新安装才同步 |
| 数据维护 | 主窗口新增「数据维护」区（LabelFrame，需先停止服务，操作不可恢复）：`清理归档会话`= `purge_archived_sessions()`；`删除会话…` = 弹出 `list_sessions()` 的可视化 Treeview（标题/工作区/状态/有无日志），多选后逐个 `purge_session(session_id)`。三处数据源一并清理：① `sessions/<工作区编码>/<会话ID>/` 日志目录（`_delete_session_log_dir` 按 id 遍历查找，防路径穿越）② `storages/workspace.json` 的 `sessionIds`/`archivedSessionIds` ③ `storages/session_projcache.json` 缓存行（`_remove_session_from_registries` + `_atomic_write_json` 原子写回）。命令行等价：`--purge-archived` / `--purge-session <ID>`（服务运行时会校验并拒绝） |
| 内置插件 dsh-archive-purge | `plugins/dsh-archive-purge/`：宿主端 `lib/index.js` 注册 `GET /__dsh/archive-purge`（列出已归档会话：id/标题(读 `storages/session_projcache.json` 尽力而为)/所属工作区/是否运行中）+ `POST /__dsh/archive-purge`（删除，带 `x-dsh-plugin-purge: 1` 自定义头防跨站触发）。POST 请求体 `{"ids": [...]}` 仅删除所选（结果去重），省略 `ids` 则遍历 `workspaceRegistry.archivedSessionIds` 清空全部；每个会话：跳过运行中 → 删日志目录 `sessions/<工作区>/<会话ID>/` → 遍历 `registry.list()` 逐个 `detachSession` 摘除。路由注册必须写成 `ctx.effect(() => ctx.webServer.register({...}), "…")`（把返回值当清理函数），否则注册后立即被注销（避坑 #34）。客户端 `lib/client.js` 用加载器契约 `window.__ModuleLoader__.load` 注入 `settings.section` 插槽（「清理归档」页）：挂载即 GET 拉列表，勾选列表 + 全选/全不选 + 「删除所选 / 清空全部 / 刷新列表」，成功后刷新列表。安装方式：插件管理 → 选择本地插件文件夹安装 `plugins/dsh-archive-purge`（或用 `--install-plugin plugins\dsh-archive-purge`） |

### 绿色便携的环境变量重定向（build_env）
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
3. **DSH_HOME 一定要设置**：不设置时 dsh 会把会话/配置写到用户主目录，破坏"绿色便携"；设为 `runtime/dsh-home` 后所有数据落程序目录。
4. **npm 镜像二进制下载路径**：Node 二进制走 `registry.npmmirror.com/-/binary/node/...`，npm 包注册表走 `registry.npmmirror.com`，两者路径不同。
5. **Python 官方 embeddable 版不含 tkinter**：给用户说明必须装完整版 python.org 安装包，否则 GUI 起不来（launcher 已做了 ImportError 兜底提示）。
6. **CLI 模式后台线程陷阱**：`wait_and_open` 是 daemon 线程，`--start` 主进程退出后线程会消失，所以 CLI 模式要**同步** `wait_ready()` 再开浏览器；GUI 模式则用线程即可。
7. **首次 npm install dsh 较慢**（沙箱实测约 3 分钟、587 个包），界面提示"请耐心等待"，只回显 npm 输出最后 15 行避免刷屏。
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
    - **插件侧（dsh-archive-purge 宿主）**：`workspaceRegistry.archivedSessionIds` 遍历 + `entity.detachSession(id)`（对未挂载 id 幂等）；`ctx.get("sessions")` 判活跳过运行中会话。已知取舍：dsh 没有"删归档 id"接口，摘除后 `archivedSessionIds` 会残留一个不指向任何会话的 id（隐藏标记，无害）；`session_projcache.json` 旧缓存行也无害，留待 dsh 自行覆盖。
    - **安全**：删除路由带自定义头 `x-dsh-plugin-purge: 1`（跨域请求无法带自定义头，会触发 CORS 预检且本服务不返回 CORS 头），防止外部网页对本地端口发起删除请求；路由只接受 POST。
    - **窗口期**：数据维护操作要求服务已停止（GUI 弹窗提示、命令行 `is_server_running()` 校验），避免与运行中的 dsh 写文件竞争。
30. **【本地插件安装】pnpm 对 `file:` 本地路径默认是拷贝不是软链（2026-08-15 实测）**：
    - 用 `pnpm add file:D:/.../plugins/dsh-archive-purge` 安装本地插件后，`node_modules` 里是**拷贝**（不是 symlink），后续改 `plugins/` 下源文件**不会**自动同步到 `node_modules`，必须重新安装（`pnpm add file:...` 幂等重装很快）。
    - 启动器 `install_plugin` / `--install-plugin` 用 `os.path.isdir(spec)` 识别本地目录并自动归一化为 `file:` 绝对路径（`\`→`/`），pnpm 才能识别；路径有中文/空格也 OK（pnpm 按 spec 处理）。
    - **排查思路**：改插件源码后 WebUI 没变化 → 先确认是不是没重装（对比 `node_modules/<包>` 与 `plugins/<包>` 的修改时间），再查 `profiles/web/package.json` 里 dependencies 与 `dsh.profile.bundles` 是否都有该包。
31. **【工作区】dsh 的 Windows ACL 沙箱要求临时根目录不能位于会话工作区内部；工作区归属记在会话 header，且工作区由用户在 GUI 选（2026-08-15 全量梳理）**：
    - **现象**：当会话工作区 = 程序根目录 `D:\DeepSeekHarnessLauncher` 时，所有 shell 工具报 `Windows ACL temp root must be outside the workspace`。根因：绿色便携把 `TMP/TEMP` 指向 `runtime/tmp`，它位于程序根目录内 = 位于工作区内 → dsh 的 ACL 沙箱拒绝。
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

## 五、Windows 实机测试记录（2026-08-14，绿色便携验证）
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
| 绿色便携 | ✅ 用户主目录零残留（`~/.npm`、`~/.pnpm-store`、`~/.local/share/pnpm`、`AppData/Local/pnpm`、`~/.config` 均未产生）；dsh 会话数据全在 `runtime/dsh-home`（profiles/storages/settings.yaml） |
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

## 七、后续建议
- ✅ 已实现"连 Python 都不装"的完全免安装体验：内置便携 Python（python-build-standalone 含 tkinter，进 runtime/python）+ PyInstaller 打包 `DSH_Launcher.exe`（内嵌解释器）。详见避坑 #18/#19/#20 与 README 第七章。
- 可增加"开机自启""系统托盘""最小化到托盘"等桌面应用体验
- Windows 实机验证：建议在目标 Windows 机器上跑一遍 start.bat 首启全流程（沙箱仅能验证 Linux 逻辑）
- 待办：auto 镜像的"国内优先、失败回退"逻辑应扩展到 npm install 阶段（见避坑 #15）
