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
| 刷新状态 | 手动重新检测环境与服务状态 | 任何时候 |

### 停止
- 点启动器里的【停止服务】，或双击 **stop.bat**
- 关闭启动器窗口也会自动停止服务

### 无界面模式（可选）
```bat
python launcher.py --start   :: 启动（守护模式：保持本窗口运行，关窗口或 stop.bat 停止）
python launcher.py --stop    :: 停止
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

也可在启动器界面【设置】里改镜像和端口，点【保存设置】。

## 四、绿色便携说明
- **全部本地化**：便携 Node、dsh 包、npm 缓存、pnpm 存储、会话数据、临时文件，全部在 `runtime/` 下，不写用户主目录（`~/.npm`、`~/.pnpm-store` 等都不会产生）
- **不污染系统**：不装全局 npm 包、不改 PATH、不写注册表
- **整目录迁移**：把整个文件夹复制到任意位置 / 另一台电脑，双击 start.bat 即可继续使用（会话记录跟着走）
- **彻底卸载**：直接删除整个文件夹即可

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

## 五、内置 Python 与 exe 打包

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

## 七、常见问题

| 问题 | 处理 |
|------|------|
| 提示找不到 Python | 说明内置便携 Python 缺失且下载失败（多为网络问题），按 start.bat 里的提示手动安装 Python 3，勾选 Add to PATH 即可兜底 |
| 下载 Node 慢 / 失败 | 在界面设置里把镜像源切到"国内"或"官方"再试 |
| 安装 dsh 慢 / 长时间卡住 | 官方 npm registry 在国内访问慢，在界面设置或 `config.json` 把镜像源切到"国内 (npmmirror)"，保存后重试（本次绿色版已默认 `mirror=cn`） |
| 端口被占用 | 设置里改端口（如 3090）后保存，重新启动 |
| 想彻底卸载 | 直接删掉整个文件夹即可（不写注册表、不留系统残留） |
| 网页报 "Failed to fetch" / 一直转圈 | 通常不是网络问题，而是**服务进程退出了**（早期版本 bug：dsh 在 stdin 关闭时会静默退出）。已修复：启动器保持服务 stdin 管道打开并常驻守护。若仍遇到，看 `runtime/server.log` 与启动器日志，确认服务是否存活 |
| dsh 网页打不开 | 看 `runtime/server.log`；确认防火墙没拦 127.0.0.1 |
| 设置 API Key 时报 `EPERM: rename denied` | 偶发，属安全软件（如火绒）实时扫描与写文件并发冲突。重试一次即可保存成功；若频繁出现，把 `DeepSeekHarnessLauncher` 目录加入安全软件白名单 |
