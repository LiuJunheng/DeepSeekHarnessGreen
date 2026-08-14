# DeepSeek Harness 一键启动器 · 开发记录（需求 / 设定 / 规范 / 避坑）

> 本文档按项目约定持续更新，记录需求内容、代码设定、规范细节与避坑经验。

## 一、需求内容
1. 用户希望把 DeepSeek Harness（dsh）封装成**双击即用**的形态：
   - 不做"敲命令安装 + 手动开浏览器"的传统流程
   - 自动完成：便携 Node 准备 → dsh 安装 → 服务启动 → 自动打开浏览器
2. 形态选型：用户选择 **Python GUI 启动器**（tkinter），配套 `.bat` 一键入口
3. 网络：用户选择 **镜像自动检测**（国内优先、失败回退官方）
4. 所有运行时数据（Node、dsh、会话）放在程序目录内，**绿色便携**，可整目录拷走

## 二、代码设定（launcher.py）
| 模块 | 设定 |
|------|------|
| 依赖 | 仅 Python 标准库（tkinter / urllib / subprocess / zipfile / tarfile / webbrowser / socket），零第三方依赖 |
| 便携 Node | 自动下载 `node-v22.20.0` 到 `runtime/node`；国内 `registry.npmmirror.com/-/binary/node/...`，官方 `nodejs.org/dist/...`；zip（win）或 tar.gz（linux） |
| dsh 安装 | 优先 `node.exe npm-cli.js install --prefix runtime/dsh @deepseek-ai/dsh`（用便携 Node 自带 npm），按镜像附 `--registry` |
| dsh 启动 | 直接调 `node <dsh>/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3080` |
| 数据隔离 | 环境变量 `DSH_HOME=runtime/dsh-home`，会话/配置/存储全部落在程序目录 |
| 绿色便携 | `build_env()` 把 npm 缓存/用户配置、pnpm home/store、TEMP/TMP 全部重定向到本地 `runtime/` 下（见下） |
| 就绪检测 | 后台线程 socket 轮询端口，就绪后 `webbrowser.open` |
| 进程管理 | Windows 下 `CREATE_NO_WINDOW` 隐藏服务控制台；PID 写 `runtime/server.pid` 供独立 `--stop` 使用；**stdin 用 `PIPE` 保持打开**（否则 dsh 读到 EOF 会退出，见避坑 #12）；`watch_server` 线程监听异常退出并记日志 |
| 界面 | tkinter：状态栏 + 启动/停止/打开界面 + 设置(镜像/端口) + 运行日志框；关窗自动停服务 |

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

## 六、后续建议
- ✅ 已实现"连 Python 都不装"的完全免安装体验：内置便携 Python（python-build-standalone 含 tkinter，进 runtime/python）+ PyInstaller 打包 `DSH_Launcher.exe`（内嵌解释器）。详见避坑 #18/#19/#20 与 README 第五章。
- 可增加"开机自启""系统托盘""最小化到托盘"等桌面应用体验
- Windows 实机验证：建议在目标 Windows 机器上跑一遍 start.bat 首启全流程（沙箱仅能验证 Linux 逻辑）
- 待办：auto 镜像的"国内优先、失败回退"逻辑应扩展到 npm install 阶段（见避坑 #15）
