---
name: dsh-deploy-maintain
description: "DeepSeek Harness 绿色便携版（一键启动器）的部署、日常维护、插件开发与避坑经验。覆盖便携 Node/dsh 安装、环境变量重定向、工作区 ACL 沙箱、更新备份、插件管理与 dsh 插件双端加载/路由注册等全套实操知识。"
---

# DeepSeek Harness 绿色便携版 · 部署维护与插件开发

> 版本日期：2026-08-15
> 本 Skill 沉淀自 `DeepSeekHarnessLauncher` 项目（Python tkinter 一键启动器 + 内置 `dsh-archive-purge` / `dsh-file-browser` 插件）的全过程实测经验，含 42 条避坑记录。适用于：把 dsh 封装成"双击即用、绿色便携、可整目录拷走"的形态，以及开发 DSH 插件（宿主端路由 + WebUI 客户端入口）。

## 一、适用场景

- **部署**：在任意 Windows/Linux 机器上搭建 dsh（DeepSeek Harness）绿色便携运行环境——便携 Node + 本地安装 dsh + 数据全部落程序目录，不污染用户主目录。
- **维护**：检查/更新 dsh 版本（先备份后重装）、可视化插件管理（搜索/安装/移除/本地文件夹安装）、数据维护（永久删除归档会话，dsh 官方没有该能力）。
- **插件开发**：开发同时被宿主端与 WebUI 双端加载的 dsh 插件（如「清理归档」会话管理插件），并排查"服务端在、客户端不显示 / 路由 404/405"等经典故障。
- 本 Skill 与 `python-tkinter-desktop-dev`（tkinter GUI 通用规范）、`trae-skill-creation`（Skill 打包规范）配套使用。

## 二、绿色便携部署核心机制

### 2.1 总体架构

```
程序根目录（BASE_DIR，绿色便携，可整目录拷走）
├── launcher.py            # Python 一键启动器（GUI/CLI）
├── start.bat / stop.bat   # ASCII + CRLF 编码的 .bat 入口
├── build_exe.bat          # PyInstaller 打包 DSH_Launcher.exe
├── config.json            # 镜像/端口/default_workspace 等配置
├── plugins/               # 内置插件源码（如 dsh-archive-purge）
└── runtime/               # 全部运行时数据（绿色便携核心）
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
- **首次 install 较慢**（约 3 分钟 / 587 包），界面应提示"请耐心等待"，只回显输出最后 15 行。

### 2.3 环境变量重定向（build_env，绿色便携的命根子）

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

## 三、日常维护

### 3.1 检查更新（备份优先策略）

- **"装了就永远最新"是错觉**：`prepare_dsh()` 只在缺失时安装，已装就跳过；同步更新的唯一途径是强制重装。
- `dsh_latest_version()` 用 `npm view @deepseek-ai/dsh version` **只读查询**（复用 find_npm_cli + build_env + 镜像参数，与安装同源），失败返回 `None` 而非抛错。
- `update_dsh()` 顺序 = 查最新版 → `backup_dsh()` 把旧版拷到 `runtime/dsh-backup-<版本>`（同名加时间戳后缀防覆盖）→ **备份成功后才** `prepare_dsh(force=True)` 强制重装。备份失败直接中止，防止"旧版被覆盖又没装上"的数据丢失。
- 备份目录不自动清理，是否删除交给用户手动管理。
- 把安装主体抽成 `install_dsh()`，`prepare_dsh(force)` 只做"缺失则装 / 强制重装"分支，首装与更新共用同一代码。

### 3.2 插件管理（dsh plugin 依赖 pnpm）

- `dsh plugin --profile <name> <pnpm 参数>` 内部转发给 pnpm 管理该 profile 依赖（`profiles/<name>/package.json` 的 `dependencies` + `node_modules`）。**已安装清单 = 读 profile 的 package.json，无需调查询接口**。
- **pnpm 必须装进便携 runtime**：用便携 node 的 npm `install -g pnpm --prefix runtime/pnpm-home`，并把 `runtime/pnpm-home` 加进 `build_env()` 的 PATH。**`pnpm --version` 直接裸跑会失败（退出码 1）**——pnpm.cmd 内部要调 node，必须在含便携 node 的 PATH 下运行。
- **本地插件安装**：`os.path.isdir(spec)` 为真时自动归一化为 `file:<绝对路径>`（`\`→`/`）交给 pnpm。**pnpm 对 `file:` 是拷贝非软链**，改 `plugins/` 下源文件后必须重新安装才同步（幂等重装很快）。
- **搜索源**：npm 注册表 API（`/-/v1/search?text=dsh-plugin&size=100`）+ GitHub 官方话题页 `https://github.com/topics/dsh-plugin`。`keywords:dsh-plugin` 限定查询在 npmmirror 返回 0（镜像索引对 keywords 支持不完整），用纯文本 `text=<关键词>` + 本地过滤最稳。过滤规则 `_is_dsh_plugin_package`：包名/关键词/描述任一命中 `dsh`/`dsh-plugin`/`deepseek-harness` 才保留。
- **GUI 多窗口线程安全**：耗时操作（搜索/安装/移除）在 `threading.Thread` 中执行，结果用 `root.after(0, ...)` 回主线程刷新列表/弹窗；忙时禁用全部操作按钮防重入。
- **GUI 布局坑**：`ttk.Panedwindow` 必须显式 `.add(child, weight=N)` 注册子面板，否则中间区域完全空白。固定宽度容器里 pack 滚动条前，先确认内容（列宽总和）留足余量，否则滚动条被压缩成 1x1 不可见（`winfo_viewable()` 判真伪）。

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

**版本追踪**：`GREEN_VERSION` 常量（发布时手动更新）+ `config.json` 的 `green_version` 可覆盖（`green_local_version()` 优先读 config）。GitHub Release tag 用 `v1.0.1` 形式，本地去 v 前缀后按**数字分段**比较 `_green_version_greater()`（`1.0.10 > 1.0.9` 成立，不依赖字符串长度）。

**查询与下载**：`green_latest_release()` 先 `api.github.com/repos/<owner>/<repo>/releases/latest`，失败降级国内镜像 `mirror.nju.edu.cn/github-release/<owner>/<repo>/latest`，只读返回 release_info；`green_find_zip_asset()` 按前缀 `DSH_Launcher_GreenPortable_Online_` + `.zip` 匹配资产；`download_green_update()` 下载到 `runtime/update/`（带进度），下载后**校验文件大小**，不符即删并抛异常。

**安全解压**：`_safe_extract_zip()` 逐成员 `os.path.normpath` 检查，拒绝绝对路径与 `..` 前缀（防 zip-slip 路径穿越）；`_detect_zip_content_root()` 兼容「zip 是整文件夹」与「zip 内直接是文件」两种形态——解压后仅一个顶层目录且含 `launcher.py`/`start.bat`/`DSH_Launcher.exe` 标志文件则判定为外层文件夹，返回内层作为内容根。

**覆盖安装（update_apply.bat，分离进程执行）**：启动器自身文件被锁定无法自替换 → `launch_update_script()` 用 `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` 把 bat 变成**独立进程**，启动器随即退出，bat 存活完成覆盖后 `start` 重启新版。bat 流程：① 等文件锁释放 → ② 备份旧文件到 `runtime/update/backup/` → ③ `robocopy /E /XF config.json /XD runtime .git` 覆盖 → ④ 重启新版。

**update_apply.bat 关键避坑（DETACHED 模式实测）**：
- **不轮询 PID，改轮询 exe 文件锁**：启动器退出后 PID 被 Windows 立即复用，`tasklist` 会永远匹配上新进程 → 死循环。改用 `ren DSH_Launcher.exe .DSH_Launcher.exe.upd` 试探文件锁，能改名 = 锁已释放，随即改回原名继续；运行 .py 形态时无锁可轮询，直接短暂睡眠。
- **`timeout` 命令在分离进程里失败**（需要控制台）→ 用 `ping -n <秒数+1> 127.0.0.1 >nul` 做无控制台睡眠。
- **`goto` 不能写在括号块内**（`if (...)` 里用 goto 会解析错误）→ 全部用顶层标签 + 顺序跳转。
- **`start` 目标文件不存在会弹错误框并卡死脚本** → 先 `if exist` 判断再 `start`。
- bat 全文**纯 ASCII + CRLF**（写文件用 `encoding="ascii", newline=""`，行以 `\r\n` 连接），避免 Windows cmd 编码问题。

**发布 Release（含中文正文）的编码坑**：用 GitHub API（PowerShell）创建/更新 Release 时，即使 `ConvertTo-Json` + `[System.Text.Encoding]::UTF8.GetBytes()` + `-ContentType "application/json; charset=utf-8"`，正文中文仍可能全变 `?`——因为 **Windows PowerShell 5.1 会把"无 BOM 的 UTF-8 .ps1"按系统 ANSI（GBK）读取**，脚本里写的中文字符串字面量在内存里已乱码，后面怎么编码都救不回。**正确做法**：发布脚本保持**纯 ASCII**（不写一个中文字符），中文正文单独放一个 UTF-8 文本文件，脚本里 `[System.IO.File]::ReadAllText(路径, [System.Text.Encoding]::UTF8)` 显式按 UTF-8 读入再发送。校验也别用 PowerShell 的 `-match "中文"`（同样会被 ANSI 读乱），导出 body 到 UTF-8 文件后用 python 检查是否含关键中文且无 U+FFFD/`?`；资产下载 URL 用 `curl.exe -s -I -L` 验证 200。**本经验已同步至 `DEV_NOTES.md` 避坑 #43。**

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
- **修复（绿色便携）**：便携 Python 3.11+ 进 `runtime/python`，在插件 Web Settings（如 vision-toolkit 命名空间）把 `runtime.python` 指向它、配好 credential，重启服务；成功标志 = server.log 出现 "dsh-vision-toolkit ... ready"。

## 五、验证与排查速查表

| 症状 | 首选排查动作 |
|------|-------------|
| WebUI 入口不显示 | 抓首页 `window.__DSH_BOOT__.entries` 是否含插件 → 查 `exports` 是否含 `./package.json` → 查 `files` 是否含 `cordis.patch.yml` |
| 客户端组件不渲染 / 按钮消失（控制台 `componentDidCatch`、Rendered more/fewer hooks） | 查条目组件是否**条件调用 props 传入的 hook**（`typeof useXxx === "function" ? useXxx() : null`）→ 改读 ownerProps 里的普通数据字段（如 `input.draft`）→ 强制刷新页面（改客户端源码无需重启服务） |
| 点击按钮 HTTP 405 | 查路由是否注册进 exact 表 → 确认 `ctx.effect(() => register(...), label)` 写法 → 查 `dsh-host-frontend-static` fallback 行为 |
| 路由 403 | 自定义头没带对（`x-dsh-plugin-purge: 1`），或来自跨域（无法带自定义头） |
| 会话 shell 报 ACL temp 冲突 | 临时目录在工作区内 → 换用 `BASE_DIR/workspace` 或工作区外目录 |
| "Failed to fetch" / 服务 40 秒退 | stdin 读到 EOF → 用 `stdin=PIPE` 保持打开 |
| 日志报 `Unexpected token '\ufeff'` | 某 npm 包 package.json 带 UTF-8 BOM → 安装前/读入后去 BOM |
| 改插件源码 WebUI 没变化 | pnpm 对 `file:` 是拷贝 → 重新安装插件 + 重启服务 |
| 插件树里有但入口没有 | 重启服务（加减插件需重启生效） |
| 装了插件在 WebUI 看不到任何东西（无 UI） | 查插件 `package.json` 有无 `dsh.client`——无则是宿主端工具/路由插件，靠 agent 按需调用（如 `find_dsh_plugin`）或 HTTP 路由验证，不是装坏了 |
| `dsh --dump-config` 看不到自定义插件层 | 先 `$env:DSH_HOME=runtime\dsh-home` 再 dump（否则加载 `~/.dsh` 默认 home，只有内置 bundle） |
| 双端插件"树里有、设置界面有、但工具/skill 不生效" | 查插件自身运行时前提：外部解释器版本（如 dsh-vision-toolkit 要 Python 3.11+）、下载型依赖（managed 环境是否已建）、API credential（`VISION_API_KEY` 是否配）→ 看 server.log 里插件 `ctx.logger.error` 的 "runtime not ready" 提示 |
| 界面空白（GUI 布局） | `ttk.Panedwindow` 漏 `.add()`；滚动条被列宽挤成 1x1 |
| 多次重启累积一堆相同 WebUI 标签页 | 查 `dist/index.html` 是否含 `dsh-launcher-ui-beacon` 标记（无则 `patch_frontend()` 没跑，多半是旧 exe/没重启）；有心跳仍开新页则查 3081 端口占用或 `runtime/ui-beacon.token` |
| 「检查绿色版更新」查不到/报错 | 依次查：网络能否访问 api.github.com / 镜像 `mirror.nju.edu.cn/github-release`；Release 是否存在且 tag 带 `v` 前缀；资产名是否以 `DSH_Launcher_GreenPortable_Online_` 开头（否则 `green_find_zip_asset` 匹配不到） |
| 绿色版更新后启动器没被替换 | 查 `runtime/update/backup/` 有无备份、`runtime/update/update_apply.bat` 是否被执行过；bat 卡在 `start` 说明目标文件缺失未加 `if exist` 判断 |

## 六、工作流建议（一键启动器开发顺序）

1. **先理数据目录**：确认 `DSH_HOME` / `runtime/` 全部重定向到程序目录，明确"绿色便携"边界。
2. **再搭启动**：便携 Node → `lib/bin.js` 启动 → `stdin=PIPE` → 就绪检测 → 自动开浏览器。
3. **后做维护**：检查更新（备份优先）→ 插件管理（pnpm 便携化）→ 数据维护（会话删除）→ 绿色版自更新（双通道，见 3.4）。
4. **最后开发插件**：先写宿主 `index.js`（路由），再写客户端 `client.js`（设置区块），双端声明齐全 → `--dump-config` 验证插件树 → 抓 `__DSH_BOOT__` 验证客户端 → 实测路由。
5. **贯穿始终**：每个改动同步更新 md 文档；`.bat` 用 ASCII + CRLF；变量名用英文全称不缩写。
