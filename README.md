# DeepSeek Harness 一键启动器（绿色便携版）

把 DeepSeek Harness（`dsh`）封装成**双击即用**的本地启动器：
不用手动敲安装命令、不用手动开浏览器。**绿色便携**：Node、dsh、npm/pnpm 缓存、会话数据、临时文件
全部只在本目录 `runtime/` 下存取，**不写用户主目录、不装系统环境**，整目录拷走即用。

---

## 一、目录结构

```
DeepSeekHarnessLauncher/
├── start.bat              # ★ 双击这个开始（纯 ASCII + CRLF）
├── stop.bat               # 双击这个停止服务
├── launcher.py            # 核心：tkinter 图形界面 + 自动环境准备
├── DSH_Launcher.exe       # ★ 双击这个开始（exe 版，无需装 Python）
├── build_exe.bat          # 将 launcher.py 打包为 exe 的工具
├── config.json            # 配置（镜像源 / 端口 / Node / Python 版本）
├── runtime/               # ★ 首次运行自动生成，全部本地数据都在这（绿色便携）
│   ├── node/              # 便携版 Node.js（自动下载）
│   ├── dsh/               # 本地安装的 @deepseek-ai/dsh 包
│   ├── dsh-home/          # dsh 数据（会话/配置/存储）
│   ├── python/            # 内置便携 Python 3.10（含 tkinter，自动下载）
│   ├── npm-cache/         # npm 下载缓存（不会写到 ~/.npm）
│   ├── npm-userconfig     # 本地 npm 配置（阻断读取用户主目录 ~/.npmrc）
│   ├── pnpm-home/         # pnpm 全局目录（dsh 插件管理用）
│   ├── pnpm-store/        # pnpm 内容寻址存储
│   ├── pyinstaller/       # 本地 PyInstaller（打包 exe 用，自动安装）
│   ├── tmp/               # 临时文件
│   ├── server.pid         # 服务进程号
│   └── server.log         # 服务运行日志
└── README.md
```

## 二、使用步骤

> 本启动器提供**两种启动形态**，选其一即可：
> - **exe 版（推荐）**：直接双击 `DSH_Launcher.exe`，**完全无需安装 Python**
> - **脚本版**：双击 `start.bat`，会自动优先使用内置便携 Python（`runtime/python`），内置缺失时才回退到系统 Python

### 前置要求
- 若用 **exe 版**：什么都不用装
- 若用 **start.bat 脚本版**：首次运行会自动下载内置便携 Python（含 tkinter）到 `runtime/python`，之后不再需要系统 Python；只有内置 Python 下载失败时，才需要手动安装 Python 3（勾选 "Add Python to PATH"）作为兜底

### 第一次使用
1. 双击 **start.bat**（或 `DSH_Launcher.exe`）
2. 弹出启动器小窗口，顶部有**状态指示灯**（绿=运行中 / 黄=已就绪 / 灰=未安装）实时显示服务状态
3. 首次使用：点 **【安装环境】**，自动完成（需要联网，耗时几分钟）：
   - 下载便携版 Node.js v22 到 `runtime/node`（国内镜像优先，失败自动回退官方）
   - 本地安装 `@deepseek-ai/dsh` 到 `runtime/dsh`
   - 补齐内置便携 Python 到 `runtime/python`
4. 状态灯变黄后点 **【启动服务】** → 自动打开浏览器 → `http://127.0.0.1:3080`
5. 在网页里：设置 → 模型 → 填入 DeepSeek API Key；然后**选择工作区**（选择你要让 AI 干活的项目文件夹）
6. 之后每次使用：双击 start.bat（或 exe）→ 状态灯变黄说明环境就绪 → 点【启动服务】即可，秒开

### 界面按钮说明
| 按钮 | 作用 | 何时可用 |
|------|------|----------|
| 安装环境 | 下载便携 Node + 安装 dsh + 补齐内置 Python | 环境未安装 / 未运行服务时 |
| 启动服务 | 拉起 dsh web 服务并自动开浏览器 | 环境已就绪且服务未运行 |
| 停止服务 | 停止 dsh 服务 | 服务运行中 |
| 打开界面 | 在浏览器打开 dsh 界面 | 服务运行中 |
| 检查更新 | 查询 npm 上 dsh 最新版本，有新版则弹窗让您选择是否更新；更新前自动备份旧版本到 `runtime/dsh-backup-<版本>`，不覆盖、可手动删除 | 环境已安装且服务未运行 |
| 插件管理 | 弹出插件管理窗口：查看已安装插件、搜索插件（npm 注册表 + GitHub 官方 `dsh-plugin` 话题页）、安装 / 移除插件（详见第五章） | 环境已就绪 |
| 数据维护区 | 主窗口新增「数据维护」区（需先停止服务）：**清理归档会话**（永久删除全部已归档/隐藏会话）、**删除会话…**（可视化列表，可多选后永久删除），详见第六章 | 服务停止后 |
| 刷新状态 | 手动重新检测环境与服务状态 | 任何时候 |

### 停止
- 点启动器里的【停止服务】，或双击 **stop.bat**
- 关闭启动器窗口也会自动停止服务

### 无界面模式（可选）
```bat
python launcher.py --start              :: 启动（守护模式：保持本窗口运行，关窗口或 stop.bat 停止）
python launcher.py --stop               :: 停止
python launcher.py --purge-archived     :: 永久删除全部已归档会话（需先停止服务）
python launcher.py --purge-session <ID> :: 永久删除指定会话（需先停止服务）
python launcher.py --install-plugin <本地插件目录或npm包名> :: 安装插件（本地目录直接给路径即可）
```

## 三、配置项（config.json）

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `mirror` | 镜像源：`auto` 自动（国内优先回退官方）/ `cn` 国内 / `official` 官方 | `auto` |
| `node_version` | 便携 Node 版本号 | `22.20.0` |
| `python_version` | 内置便携 Python 版本号 | `3.10.20` |
| `python_release` | python-build-standalone 发布标签（日期） | `20260807` |
| `dsh_port` | 服务端口 | `3080` |
| `dsh_package` | dsh 包名 | `@deepseek-ai/dsh` |
| `tmp_dir` | 临时目录（空 = 默认 `runtime/tmp`，绿色便携；可自定义为任意绝对路径） | 空 |
| `default_workspace` | 默认工作区（空 = 自动解析：不冲突时用程序根目录，冲突时自动用程序目录内 `workspace` 子目录；可自定义绝对路径，与临时目录冲突会自动回退并警告） | 空 |

也可在启动器界面【设置】里改镜像和端口，点【保存设置】。

## 四、绿色便携说明
- **全部本地化**：便携 Node、dsh 包、npm 缓存、pnpm 存储、会话数据、临时文件，全部在 `runtime/` 下，不写用户主目录（`~/.npm`、`~/.pnpm-store` 等都不会产生）
- **不污染系统**：不装全局 npm 包、不改 PATH、不写注册表
- **整目录迁移**：把整个文件夹复制到任意位置 / 另一台电脑，双击 start.bat 即可继续使用（会话记录跟着走）
- **彻底卸载**：直接删除整个文件夹即可
- **默认工作区自动解析**：因为临时目录在程序目录内，dsh 的 ACL 沙箱不允许工作区包含它。启动器启动时**自动检测**：程序根目录与临时目录冲突时，默认工作区自动用程序目录内 `workspace` 子目录并预置进工作区列表；不冲突时直接用程序根目录。无需手动配置（详见 `config.json` 的 `default_workspace`）

### 迁移到新电脑（完整步骤）
1. **旧电脑先停止服务**：双击 `stop.bat`（或启动器里【停止服务】），避免有进程占用文件导致复制不全
2. **复制整个 `DeepSeekHarnessLauncher` 文件夹**（约 528MB）到新电脑，放任意位置均可（程序按自身位置自动定位，不写死路径）
3. **可选清理**（让迁移更干净、体积更小）：
   - 删除 `runtime/server.pid`、`runtime/server.log`（旧状态残留）
   - 清空 `runtime/tmp`（临时文件）
   - 可删除 `runtime/npm-cache`（纯下载缓存，删除不影响使用，仅日后重装 dsh 会重新下载）
4. **新电脑前置**：**无需装任何东西**。直接用 `DSH_Launcher.exe`，或 `start.bat`（内置便携 Python 在 runtime 里）；只有内置 Python 下载失败时才需装系统 Python。**不需要装 Node**（便携版在 runtime 里）
5. **启动**：双击 `DSH_Launcher.exe`（或 `start.bat`）→ 【启动服务】。API Key、设置、插件、会话记录全部已带过来
6. **工作区注意**：dsh 的会话按"工作区绝对路径"记录（见 `runtime/dsh-home/storages/workspace.json`）。若新电脑的工作区路径与旧机**不一致**，需在网页里重新选择/添加工作区（旧会话数据仍在，不会被删除）；路径一致则完全无感

### 轻量分发 zip（精简在线版，约 8MB）
> 相较"整目录迁移"，此 zip **不含 `runtime/`（不带已下载的环境与会话）**，新机联网后由启动器自动下载 Node / Python / dsh，体积小、适合放到 GitHub Release 分发。
>
> 打包内容（即项目根目录的"发货清单"）：`launcher.py`、`start.bat`、`stop.bat`、`build_exe.bat`、`DSH_Launcher.exe`、`config.json`、`README.md`、`DEV_NOTES.md`、`.gitignore`、`plugins/dsh-archive-purge/`。

- **最新下载**（GitHub Release，tag `v1.0.0`）：<https://github.com/LiuJunheng/DeepSeekHarnessGreen/releases/latest>
- 仓库：<https://github.com/LiuJunheng/DeepSeekHarnessGreen>

新机使用三步：
1. 解压到任意目录（如 `E:\DeepSeekHarnessLauncher`），双击 **start.bat**（或 `DSH_Launcher.exe`）；
2. 点 **【安装环境】**，等待自动下载便携 Node + 安装 dsh + 补齐便携 Python（需联网，几分钟）；
3. 点 **【启动服务】** → 网页里填 API Key、选工作区（建议选程序目录内自动预置的 `workspace`，避开 ACL 临时目录冲突）即可。

重新生成该 zip（在项目根目录 PowerShell 执行）：
```powershell
Compress-Archive -Path launcher.py, start.bat, stop.bat, build_exe.bat, DSH_Launcher.exe, config.json, README.md, DEV_NOTES.md, .gitignore, "plugins\dsh-archive-purge" -DestinationPath DSH_Launcher_GreenPortable_Online_<日期>.zip -CompressionLevel Optimal
```

## 五、插件管理

> 环境就绪（已安装 Node + dsh）后，主窗口点 **【插件管理】** 弹出插件管理窗口。

### 窗口布局
- **左侧「已安装插件」**：当前 profile（`web`）已安装的插件列表，带垂直滚动条；条目上**右键**可打开 npm 页面或 GitHub 搜索，也可复制包名；选中后可【移除选中插件】；【刷新】重新读取。
- **右侧「搜索结果」**：显示搜索到的插件（来源 / 版本 / 描述），带垂直滚动条；条目上**右键**同左侧功能；选中后可【安装选中插件】。
- **顶部工具栏**：
  - 搜索框 +【搜索】：从 **npm 注册表**（国内镜像优先）按关键词搜索，**只展示 dsh 相关的可安装插件**（自动过滤无关包）；
  - 【加载推荐】：一键展示内置的 **12 个已核实 dsh 插件**（如 `@dsh-external/dsh-vision-toolkit`、`dsh-remote`、`dsh-lark-bot` 等），无需联网、不依赖 GitHub 也能看到可安装项；
  - 【加载 GitHub 热门】：抓取 **GitHub 官方 `dsh-plugin` 话题页**（`https://github.com/topics/dsh-plugin`）的热门仓库（按星标约 20 个）；
  - 【打开官方话题页】：在浏览器打开该话题页，可翻页浏览完整列表。
- **底部手动安装栏**：直接输入 npm 包名（如 `dsh-remote`）或 `github:用户/仓库#提交号` 安装指定版本；也可点 **「选择本地插件文件夹安装…」**，选择任意含 `package.json` 的本地插件目录一键安装（本地插件装完需**重启服务**生效）。命令行等价物：`python launcher.py --install-plugin <本地目录或包名>`。
- 底部状态栏实时显示"正在安装 / 安装成功 / 共 N 条结果"等进度。

### 说明
- 插件实际安装在 `runtime/dsh-home/profiles/web/`（profile 的 `node_modules` 与 `package.json`），走 `dsh plugin`（内部转发 pnpm），**绿色便携**：pnpm 及其存储都在 `runtime/` 下，不写用户主目录。
- 首次使用插件管理时启动器会自动用便携 Node 安装 pnpm 到 `runtime/pnpm-home`。
- GitHub 源的仓库未必是 npm 包，安装失败属正常，窗口会提示原因；可改用 npm 注册表里的同名包。

## 六、数据维护（清理 / 删除会话）

> dsh 官方**没有**"永久删除会话"功能：网页里的"归档"只是把会话**隐藏**（日志文件与注册表条目全部保留）。本启动器在**服务停止后**直接操作本地数据文件，做到彻底删除、**不可恢复**。

| 操作 | 位置 | 说明 |
|------|------|------|
| 清理归档会话 | 主窗口「数据维护」区 | 永久删除**所有已归档（隐藏）**的会话（自动跳过运行中的） |
| 删除会话… | 主窗口「数据维护」区 | 弹出可视化列表（标题 / 工作区 / 状态 / 有无日志），**可多选**后永久删除 |
| 命令行 | `--purge-archived` / `--purge-session <ID>` | 等价操作 |

删除时会一并清理三个来源：
1. 会话日志目录 `runtime/dsh-home/sessions/<工作区编码>/<会话ID>/`
2. `storages/workspace.json` 中的 `sessionIds` / `archivedSessionIds` 条目
3. `storages/session_projcache.json` 中该会话的标题 / 统计缓存行

注意事项：
- **必须先停止服务**（GUI 会弹窗提示；命令行会校验，服务在运行时报错退出）
- 操作**不可恢复**，删除前均有确认提示
- 正在运行的会话不会被清理

### 配套：内置「清理归档」WebUI 插件
启动器 `plugins/` 下自带 **`dsh-archive-purge`** 插件：安装并重启服务后，可在 WebUI「设置 → 清理归档」里一键清理所有归档会话，无需回到启动器。它是纯插件（不修改任何官方文件），通过「插件管理 → 选择本地插件文件夹安装…」选择 `plugins/dsh-archive-purge` 目录安装即可，详见 [plugins/dsh-archive-purge/README.md](plugins/dsh-archive-purge/README.md)。

## 七、内置 Python 与 exe 打包

### 为什么需要 Python / 内置 Python
- **launcher.py 的工作**：这个启动器本身就是用 Python 写的，负责「自动下载便携 Node → 本地安装 dsh → 拉起服务 → 打开浏览器」，并提供 tkinter 图形界面。所以运行启动器**需要**一个 Python 解释器。
- **内置便携 Python**：`runtime/python` 下自带的 Python 3.10（完整版，含 tkinter），由 `start.bat` 优先调用。首次启动若缺失会自动从镜像下载（国内 `mirror.nju.edu.cn` 优先、失败回退 GitHub），**不装进系统、不污染环境**，随目录一起迁移。
- **exe 版**：用 PyInstaller 把 launcher.py 打包成 `DSH_Launcher.exe`，解释器和标准库都内嵌进 exe，**运行时完全不需要 Python**，双击即用，体验最接近"绿色免安装软件"。

### 两种启动形态怎么选
| 形态 | 入口 | 需要 Python 吗 | 体积/说明 |
|------|------|----------------|-----------|
| exe 版 | 双击 `DSH_Launcher.exe` | 不需要 | exe 单文件（约 8MB）内嵌解释器；程序根目录必须与 `runtime/` 同级 |
| 脚本版 | 双击 `start.bat` | 不需要（用内置） | 依赖 `runtime/python`（约 200MB）；内置缺失才回退系统 Python |

> 注：exe 与 start.bat 共用同一套 `runtime/`，二选一使用即可，数据完全互通。

### 重新打包 exe
改过 `launcher.py` 后想更新 exe，双击 **build_exe.bat** 即可：
1. 自动定位 Python（内置优先，其次系统）
2. 本地安装 PyInstaller 到 `runtime/pyinstaller`（清华镜像，不动系统环境、不用 C 盘）
3. 打包单文件 `dist\DSH_Launcher.exe` 并复制到项目根目录

### 手动下载内置 Python（可选）
若不想等自动下载，可手动把 python-build-standalone 的
`cpython-3.10.20+20260807-x86_64-pc-windows-msvc-install_only.tar.gz` 解压进 `runtime/python`，
目录布局放 `runtime/python/python.exe` 或 `runtime/python/任意子目录/python.exe` 均可被识别。

## 六、安全说明
- 服务只绑定 `127.0.0.1`（本机回环），不会暴露到公网
- 所有文件读写、命令执行都发生在你选择的**工作区**内
- 首次在网页里操作时，遇到高危命令确认框请仔细看后再点允许

## 九、常见问题

| 问题 | 处理 |
|------|------|
| 提示找不到 Python | 说明内置便携 Python 缺失且下载失败（多为网络问题），按 start.bat 里的提示手动安装 Python 3，勾选 Add to PATH 即可兜底 |
| 下载 Node 慢 / 失败 | 在界面设置里把镜像源切到"国内"或"官方"再试 |
| 安装 dsh 慢 / 长时间卡住 | 官方 npm registry 在国内访问慢，在界面设置或 `config.json` 把镜像源切到"国内 (npmmirror)"，保存后重试（本次绿色版已默认 `mirror=cn`） |
| 端口被占用 | 设置里改端口（如 3090）后保存，重新启动 |
| 想彻底卸载 | 直接删掉整个文件夹即可（不写注册表、不留系统残留） |
| 网页报 "Failed to fetch" / 一直转圈 | 通常不是网络问题，而是**服务进程退出了**（早期版本 bug：dsh 在 stdin 关闭时会静默退出）。已修复：启动器保持服务 stdin 管道打开并常驻守护。若仍遇到，看 `runtime/server.log` 与启动器日志，确认服务是否存活 |
| shell 工具报 `Windows ACL temp root must be outside the workspace` | 该会话的工作区包含了 `runtime/tmp`（典型：工作区选了程序根目录）。绿色便携把临时目录放在程序目录内，dsh 的 ACL 沙箱要求临时目录必须在工作区**外部**。解决：开新会话时在工作区选择器里选 **workspace**（`…\workspace`，启动器会自动解析并预置）或任何不含 `runtime/tmp` 的目录；旧会话无法改工作区，只能归档/删除或开新会话 |
| dsh 网页打不开 | 看 `runtime/server.log`；确认防火墙没拦 127.0.0.1 |
| 设置 API Key 时报 `EPERM: rename denied` | 偶发，属安全软件（如火绒）实时扫描与写文件并发冲突。重试一次即可保存成功；若频繁出现，把 `DeepSeekHarnessLauncher` 目录加入安全软件白名单 |
| 安装插件时日志报 `SyntaxError: Unexpected token '\ufeff'` | 该 npm 包的 `package.json` 带了 UTF-8 BOM（发布者的编码问题），dsh 的 JSON 解析会崩溃。已内置修复：启动器会在插件命令前自动清除这些 BOM 并重试，正常重试后即可装成功 |
