# DeepSeek Harness 绿色整合版启动器

把 DeepSeek Harness（`dsh`）封装成**双击即用**的本地启动器：不用敲命令、不用开浏览器、连 Python/Node 都不用装，整包拷走就能用。一份开箱即得、拎包即走（三国文案：告别繁琐的"排兵布阵"，一纸调令即可出征）。

> **下载**：GitHub [Release v1.0.10](https://github.com/LiuJunheng/DeepSeekHarnessGreen/releases/latest) ／ Gitee 镜像（国内更快）<https://gitee.com/liujunheng/DeepSeekHarnessGreen/releases> → 仓库 [GitHub](https://github.com/LiuJunheng/DeepSeekHarnessGreen) / [Gitee](https://gitee.com/liujunheng/DeepSeekHarnessGreen)
>
> **其他语言**：English — [README_EN.md](README_EN.md)（随版本发布翻译一次；以本文为准）

## 亮点速览

- **⚡ 双击即用**：用 `DSH_Launcher.exe` 或 `start.bat`，连 Python / Node 都不用单独装（内置便携版），首次点一下「安装环境」即可。
- **🌱 绿色便携**：Node、dsh、npm/pnpm 缓存、会话数据、临时文件全在本目录 `runtime/`，**不写用户主目录、不装系统、不写注册表**；内置便携 Node/Python，下载国内镜像优先、连不上自动回退官方。整目录拷到任意新电脑即用，无需重装。
- **📦 内置 6 款实用插件**：会话回退、会话导入、用量统计、文件浏览、清理归档等，一键安装（详见 [内置插件一览](#内置插件一览)）。
- **🏠 局域网远程访问**：一键改 0.0.0.0 绑定 + **自动放行 Windows 防火墙端口**，手机/其它电脑直接打开 WebUI（含手动智能修复循环的「随机 UUID」缺失、端口与 IP 403 等坑）。
- **🔁 两通道独立自更新**：官方核心（dsh）与绿色版外围互不干扰，可一键升级；绿色版更新 GitHub 连不通时**自动转 Gitee 镜像**，升级前自动备份、失败给出手动地址，**不丢你的设置与会话**。

---

## 一、目录结构

```
DeepSeekHarnessLauncher/
├── start.bat              # ★ 双击这个开始（纯 ASCII + CRLF）
├── stop.bat               # 双击这个停止服务
├── launcher.py            # 核心：tkinter 图形界面 + 自动环境准备
├── DSH_Launcher.exe       # ★ 双击这个开始（exe 版，无需装 Python）
├── update_agent.py        # 独立更新程序源码（打包为 DSH_Update.exe）
├── DSH_Update.exe         # ★ 独立更新程序：本体退出后由它完成覆盖安装并重启
├── DSH_Launcher.ico       # 启动器图标（窗口 / 系统托盘 / exe 使用）
├── build_exe.bat          # 将 launcher.py / update_agent.py 打包为 exe 的工具
├── config.json            # 配置（镜像源 / 端口 / Node / Python 版本）
├── runtime/               # ★ 首次运行自动生成，全部本地数据都在这（绿色整合）
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
├── plugins/               # 内置插件源码（6 款，见「内置插件一览」）
├── skills/                # 本项目的 DSH 经验 Skill（已安装到 TRAE 全局 skills）
└── README.md / README_EN.md  # 中文说明（维护主体）/ 英文说明（随版本更新翻译一次）
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
3. 首次使用：点 **【安装环境】**，自动完成（需要联网，耗时几分钟；**npm 安装过程会实时逐行显示进度**，便于确认没有卡住或报错）：
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
| 启动服务 | 拉起 dsh web 服务并自动开浏览器（界面已在浏览器中打开则不重复开新页） | 环境已就绪且服务未运行 |
| 停止服务 | 停止 dsh 服务 | 服务运行中 |
| 打开界面 | 手动在浏览器打开 dsh 界面（**必定打开新页面**，不受单页面去重限制） | 服务运行中 |
| 检查更新 | 查询 npm 上 dsh 最新版本，有新版则弹窗让您选择是否更新；更新前自动备份旧版本到 `runtime/backup/dsh-<版本>`，不覆盖、可在「数据维护」一键清理 | 环境已安装且服务未运行 |
| 检查绿色版更新 | 查询本项目 GitHub 最新 Release（本绿色版外围：启动器/插件/文档等）；发现新版 → 下载到 `runtime/update/` 暂存 → **退出启动器 → 由独立更新程序 `DSH_Update.exe` 完成覆盖安装并重启**（它会等本体退出、备份旧文件、覆盖新版、再启动）；若更新失败会弹窗提示**手动下载地址**（GitHub 发布页 + 更新包直链）。**不替换 `config.json`（你的设置）与 `runtime/`（你的数据）**，旧文件自动备份到 `runtime/update/backup/`，详见第六章 | 服务未运行 |
| 插件管理 | 弹出插件管理窗口：查看已安装插件、搜索插件（npm 注册表 + GitHub 官方 `dsh-plugin` 话题页）、安装 / 移除插件（详见第五章） | 环境已就绪 |
| 数据维护区 | 主窗口「数据维护」区（需先停止服务）：**会话管理**按钮 → 弹出会话列表，**勾选（可全选/单选）**后可**恢复（取消归档）**或**永久删除**选中的会话，详见第五章「数据维护」 | 服务停止后 |
| 刷新状态 | 手动重新检测环境与服务状态 | 任何时候 |
| 关于（右上角） | 弹出「关于」弹窗：作者、版本号、版本日期、本仓库与官方 dsh 仓库链接（可点击打开），并附**绿色整合·本地化特点**说明（所有文件与依赖全部本地化） | 任何时候 |
| 最小化按钮 | 最小化到任务栏（任务栏图标保留），**托盘图标从启动起常驻**，点任务栏或托盘图标都能恢复窗口 | 任何时候 |
| 右上角 X 关闭 | 先弹二次确认（避免误关），确认后自动停止 dsh 服务并退出 | 任何时候 |
| 防重复启动 | 若启动器已在运行（含最小化到任务栏 / 托盘后台运行），再次打开时不会重复启动服务，而是直接把已运行的窗口调到前台 | 任何时候 |

> **WebUI 单页面去重**：启动器会向 WebUI 页面注入心跳脚本，页面打开后每 15 秒向本地
> 127.0.0.1:3081 上报一次；**自动打开**（启动服务后自动开页）时若检测到界面已在浏览器
> 中打开（180 秒内有心跳），就**不再打开新页面**，避免多次重启累积一堆相同标签页。
> **手动点「打开界面」不受此限制，必定打开新页面**。
> 可在「设置」里取消勾选 *启动服务后自动打开浏览器*（对应 `config.json` 的
> `auto_open_browser`，端口可用 `ui_beacon_port` 调整）。

### 停止
- 点启动器里的【停止服务】，或双击 **stop.bat**
- 点右上角 **X** 关闭启动器会先弹**二次确认**（避免误关），确认后自动停止服务
- 点**最小化**按钮会缩到**系统托盘**后台运行（任务栏不显示，主窗口隐藏），点托盘图标恢复显示；
  想要彻底退出仍点右上角 X（或托盘图标所在区域右键无菜单时用 X 关闭）

### 无界面模式（可选）
```bat
python launcher.py --start              :: 启动（守护模式：保持本窗口运行，关窗口或 stop.bat 停止）
python launcher.py --stop               :: 停止
python launcher.py --purge-archived     :: 永久删除全部已归档会话（需先停止服务）
python launcher.py --purge-session <ID> :: 永久删除指定会话（需先停止服务）
python launcher.py --restore-session <ID> :: 复原(取消归档)指定会话（需先停止服务）
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
| `tmp_dir` | 临时目录（空 = 默认 `runtime/tmp`，绿色整合；可自定义为任意绝对路径） | 空 |
| `default_workspace` | 默认工作区（空 = 自动解析：不冲突时用程序根目录，冲突时自动用程序目录内 `workspace` 子目录；可自定义绝对路径，与临时目录冲突会自动回退并警告） | 空 |
| `dsh_host` | dsh web 服务绑定地址：`127.0.0.1`=仅本机访问 / `0.0.0.0`=局域网内其它电脑可远程打开 WebUI | `127.0.0.1` |
| `trusted_hosts` | 受信任主机列表（数组，元素为 host 或 host:port）。**不填（默认）= 绑定局域网时自动信任全部局域网 IP；填了任意一个 = 只信任填写的地址，不再自动全局域网放行** | `[]` |

也可在启动器界面【设置】里改镜像和端口（网络相关的【网络设置】见下节），点【保存设置】。

### 网络设置（局域网远程访问）
> 想让**其它电脑的浏览器**远程打开本机部署的 dsh WebUI（例如服务端一台电脑、客户端多台电脑），按下面配置。

- 主窗口「网络设置 (局域网远程访问)」区 →「服务绑定」选 **「局域网 (允许局域网访问 0.0.0.0)」** →「保存网络设置」（下次启动服务时生效）。
- 保存后 **点【启动服务】**，就绪日志会额外显示一行 `局域网访问地址: http://<本机IP>:3080`；局域网内其它电脑用浏览器打开该地址即可使用 WebUI（聊天、工具调用正常）。
- 「受信任主机」**不填（默认）= 自动信任全部局域网 IP**（最简单，局域网内所有电脑都能打开）；**填了任意一个 = 只信任填写的地址**（如只允许特定主机 `my-server.local` 或 `192.168.1.10:3080` 访问），多个用英文逗号分隔。
- **安全边界（请知悉）**：选择局域网模式且不填受信任主机 = **整个局域网网段开放**，任何能连到本机局域网 IP 的设备都能打开并操作 WebUI（可用工具执行）；填了受信任主机则只对填写的主机开放。dsh 的**设置 / 凭据（API Key）类特权操作仍仅本机可改**（远程浏览器访问会返回 403），属官方安全保护。本机模式（默认 `127.0.0.1`）则与以往完全一致，仅本机可访问。
- 命令行/配置文件等价设置：`config.json` 的 `dsh_host`（`127.0.0.1` / `0.0.0.0`）与 `trusted_hosts`（数组）。

## 四、绿色整合说明
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
> 打包内容与 GitHub 仓库（main 分支）**保持一致**：`launcher.py`、`update_agent.py`、`start.bat`、`stop.bat`、`build_exe.bat`、`DSH_Launcher.exe`、`DSH_Update.exe`、`DSH_Launcher.ico`、`config.json`、`README.md`、`README_EN.md`、`LICENSE`、`plugins/`、`skills/dsh-deploy-maintain/`（`DSH_Launcher.exe` / `DSH_Update.exe` 也上传 GitHub 仓库，与 Release 同源；`DEV_NOTES.md` 与 `.gitignore` 是开发侧文件，不进 release）。

- **最新下载**（GitHub Release，tag `v1.0.10`）：<https://github.com/LiuJunheng/DeepSeekHarnessGreen/releases/latest>
- **Gitee 镜像下载**（国内访问 GitHub 不便时）：<https://gitee.com/liujunheng/DeepSeekHarnessGreen/releases>
- 仓库：<https://github.com/LiuJunheng/DeepSeekHarnessGreen>（GitHub）/ <https://gitee.com/liujunheng/DeepSeekHarnessGreen>（Gitee）

新机使用三步：
1. 解压到任意目录（如 `E:\DeepSeekHarnessLauncher`），双击 **start.bat**（或 `DSH_Launcher.exe`）；
2. 点 **【安装环境】**，等待自动下载便携 Node + 安装 dsh + 补齐便携 Python（需联网，几分钟）；
3. 点 **【启动服务】** → 网页里填 API Key、选工作区（建议选程序目录内自动预置的 `workspace`，避开 ACL 临时目录冲突）即可。

> 该 zip 由作者打包维护并随 Release 分发，使用者仅需下载后解压即可，无需关心其中的结构。

## 五、插件与会话管理

> 本章覆盖本绿色版的**插件体系**与**会话数据维护**两部分：
> - **内置插件**：6 款自带插件（源码在 `plugins/` 随包分发），分别聊天增强、会话管理、用量统计等功能；
> - **数据维护**：启动器内置的「恢复 / 永久删除归档会话」功能（dsh 官方没有，绿色版自建）。
>
> 使用入口：主窗口点 **【插件管理】** 弹出插件管理窗口；数据维护在「数据维护」区（需先停止服务）。

### 插件的管理与维护
> 环境就绪（已安装 Node + dsh）后，在主窗口点 **【插件管理】** 即可在弹出的窗口里**查看、搜索、安装、移除、启停**插件。下面按"管理动作"讲清怎么操（有关每个内置插件的功能，见下方「内置插件一览 / 详解」）。

- **查看已装插件**：窗口左侧「已安装插件」列出当前 profile（`web`）已安装的插件（列：插件名 / 版本 / **状态**——启用 / 停用 / —），可单选/多选后【移除选中插件】、【启用选中】或【停用选中】（启停、移除后需**重启服务**生效）、【刷新】；条目上**右键**可打开 npm 页面 / GitHub 搜索 / 复制包名。
- **从搜索列表装新插件**：窗口右侧「搜索结果」展示命中项（来源 / 版本 / 描述），选中后【安装选中插件】。可通过顶部工具行找插件：
  - **【搜索】**：从 **npm 注册表**（国内镜像优先）按关键词搜，**只展示 dsh 相关的可安装插件**（自动过滤无关包）；
  - **【加载推荐】**：一键展示内置的 **12 个已核实 dsh 插件**（如 `@dsh-external/dsh-vision-toolkit`、`dsh-remote`、`dsh-lark-bot`），无需联网也能看到可安装项；
  - **【加载 GitHub 热门】**：抓取 **GitHub 官方 `dsh-plugin` 话题页**的热门仓库（按星标约 20 个）；
  - **【打开官方话题页】**：在浏览器打开该话题页，翻页浏览完整列表。
- **手动指定安装**：底部手动安装栏直接输入 npm 包名（如 `dsh-remote`）或 `github:用户/仓库#提交号` 安装指定版本；也点 **「选择本地插件文件夹安装…」** 选任意含 `package.json` 的目录一键安装（默认打开本仓库 `plugins/`，方便直接装内置插件）。命令行等价：`python launcher.py --install-plugin <本地目录或包名>`。
- **装在哪儿 / 是否绿色**：插件装进 `runtime/dsh-home/profiles/web/`（profile 的 `node_modules` + `package.json`），走 `dsh plugin`（内部转发 pnpm）——pnpm 及其存储都在 `runtime/` 下，**不写用户主目录**；首次使用自动用便携 Node 把 pnpm 装到 `runtime/pnpm-home`。
- **自动生效编排层**：任何安装 / 移除 / 启停后，启动器自动把声明 `dsh.bundle.patch` 的依赖写进 profile 的 `dsh.profile.bundles`（即使 pnpm 因构建脚本警告 `ERR_PNPM_IGNORED_BUILDS` 以退出码 1 结束也兜底同步，**无需手动编辑 package.json**）；启停状态记在 `dsh.profile.disabled`。**重启服务后插件即加载**。
- **其它提示**：底部状态栏实时显示"正在安装 / 安装成功 / 共 N 条结果"进度；GitHub 源仓库未必是 npm 包、安装失败属正常，窗口会提示原因，可改用 npm 注册表里的同名包。

### 内置插件一览（本绿色版自带 6 款）
安装方式：任一内置插件均可通过「插件管理 → 选择本地插件文件夹安装…」选择对应目录（命令行等价物：`python launcher.py --install-plugin plugins\<插件名>`），装完**重启服务**生效。官方核心或绿色版自更新后，已装入的旧副本需重新安装本地方可生效。各插件详细用法见其 README。

| 插件 | 一句话功能 | 详细文档 |
|------|-----------|----------|
| `dsh-file-browser` | WebUI 内文件浏览 / 预览 / 右键把路径或内容塞进对话 | [README](plugins/dsh-file-browser/README.md) |
| `dsh-archive-purge` | WebUI「清理归档」页只读查看已归档会话 | [README](plugins/dsh-archive-purge/README.md) |
| `dsh-session-rewind` | 会话被工具崩溃"毒化"时报错时，一键回退到某可行回合派生干净续聊 | [README](plugins/dsh-session-rewind/README.md) |
| `dsh-session-import` | 把导出的会话 ZIP / JSONL **导回本机**（官方导出互逆） | [README](plugins/dsh-session-import/README.md) |
| `dsh-usage-stats` | 用量统计 + 每条消息的「本次 token / 预估费用」 | [README](plugins/dsh-usage-stats/README.md) |
| `dsh-sidebar-lite` | WebUI 右侧边栏（文件管理 / 预览 / 浏览器 / 终端 / 任务） | [README](plugins/dsh-sidebar-lite/README.md) |

所有内置插件均为**纯插件**（不修改任何官方文件），与绿色版一起以 **Apache License 2.0** 开源（见第十一章）。

### 内置插件详解（按功能分组）
> 下面按用途分组介绍各插件。实际安装均通过「插件管理 → 选择本地插件文件夹安装…」选择对应 `plugins\<插件名>` 目录即可（命令行等价物 `python launcher.py --install-plugin plugins\<插件名>`），装完**重启服务**生效；更完整用法见各章节末尾的 README。

#### 聊天与文件增强
- **`dsh-file-browser`（文件浏览 / 预览 / 右键添加到对话）**：安装并重启服务后，WebUI 输入框工具行左侧出现「📁 文件」按钮，点击打开右侧浮层文件浏览器——目录列表（目录在前）、文本/代码与图片预览、路径输入跳转、返回上级/刷新；**右键文件或目录**弹出菜单，可把**路径**或**内容**（≤3000 字符，超出截断并注明）追加到输入框草稿（可编辑后再发送），或**复制路径**。详见 [plugins/dsh-file-browser/README.md](plugins/dsh-file-browser/README.md)。
  > 常见问题：安装后输入框看不到「文件」按钮 → 多为没重启服务 / 插件 `exports` 少了 `"./package.json"` / 改源码后没重新安装，详见插件 README 的「排查」一节。
- **`dsh-sidebar-lite`（WebUI 右侧边栏）**：在 WebUI 右侧常驻一个工作面板，提供文件管理 / 预览 / 浏览器 / 终端 / 任务入口，方便在对话旁直接操作文件与工具。详见 [plugins/dsh-sidebar-lite/README.md](plugins/dsh-sidebar-lite/README.md)。

#### 会话数据管理
- **`dsh-archive-purge`（清理归档查看）**：安装并重启服务后，可在 WebUI「设置 → 清理归档」里**查看**已归档会话列表（可勾选/全选交互保留）。由于实际启动服务时所有会话都处于"运行中"，WebUI 侧**无法直接删除**，该页面为**只读展示**——真正的删除/恢复请在下方「数据维护」完成。详见 [plugins/dsh-archive-purge/README.md](plugins/dsh-archive-purge/README.md)。
  > 常见问题：安装后 WebUI 设置里看不到「清理归档」→ 多为插件 `package.json` 的 `exports` 少了 `"./package.json"`（或改源码后没重新安装），详见插件 README 的「排查」一节。
- **`dsh-session-rewind`（会话回退）**：解决 dsh 会话被工具运行时失效（`Cannot read properties of undefined (reading 'prepare')`）**永久毒化**的问题——崩溃回合会在日志里留下孤儿 `tool_calls`，之后每一轮都被 API 400 拒绝。安装并重启服务后，WebUI「设置 → 会话回退」可：列出全部会话 →「分析」任意会话（逐回合信息：用户问题 / 步骤数 / 工具调用数 / 错误码统计 / 是否完成）→ 在任意一个**已完成**回合上点「回退到此」，调用官方 `session.fork` 从该回合之后派生一个**干净的续接会话**并自动打开（原会话保留，可再交「数据维护」清理）。界面为**卡片式布局**（会话标题、用户问题描述均独占整行完整可读，下方显示工作区/创建时间/步骤/工具调用等具体信息，与用量统计同风格）。详见 [plugins/dsh-session-rewind/README.md](plugins/dsh-session-rewind/README.md)。
- **`dsh-session-import`（会话导入）**：把「Session log」按钮导出的会话 ZIP（`dsh-session-<id>.zip`，来自官方 `GET /api/session.export`）或单个 `.jsonl` 日志**导入回本机**，与官方导出互逆。安装并重启服务后，WebUI「设置 → 会话导入」选择文件即可：自动识别 ZIP（`PK` 魔数）或明文 JSONL，校验会话 header（版本 / 字段）后按日志头部的 `cwd` 写回 `runtime/dsh-home/sessions/<项目>/<会话ID>/`（zstd 帧与官方持久化后端逐字节一致），`media/` 附件按内容寻址写回附件库，并把会话挂到对应工作区（cwd 目录本机不存在时留在「未分组」，仍会出现在会话列表）；重复导入同一会话自动跳过、不覆盖。详见 [plugins/dsh-session-import/README.md](plugins/dsh-session-import/README.md)。
  > 说明：导入是「恢复/查看」语义——会话出现在列表可查看历史，但官方没有「从该会话继续聊」的通用入口；标题等投影元数据由 DSH 后续补齐，刚导入时可能显示「(无标题)」。

#### 用量统计
- **`dsh-usage-stats`（用量统计 + 消息行「本次token」）**（v0.2.0，一个插件两个功能面，统一安装/卸载）：
  1. **设置页「用量统计」**：扫描本机**全部会话日志**，按模型汇总每次模型调用的 token 用量，支持**费用估算**。总览卡片（会话数 / 回合总数 / 输入 / 输出 / 缓存 / 思考 tokens + 估算费用，按模型分布）；**可编辑价格表**（元 / 每百万 tokens，按官方计费口径分「输入未命中缓存 / 输入命中缓存 / 输出」三列，默认官方高峰价，存浏览器 localStorage）；**会话卡片列表**（标题独占整行、元信息自动换行）+ 点「明细」展开**逐回合卡片**（用户消息独占整行完整可读，下方回合号 / 步骤 / 工具调用 / 输出 tk / 估算 / 模型 / 完成状态）。
  2. **对话消息行「本次token」**：每条**已完成助手消息**的操作行上方，右对齐常驻显示该回合实际消耗的 token 与**预估费用**——`本次token：输入(未命中) 3.3k · 输入(命中缓存) 832.3k · 输出 4.6k · 思考 3.7k · 费用约 ¥0.13`（k/M 缩写，按官方计费口径分类，思考已计入输出不重复计费，费用按价格表估算；数据取该回合所有 `assistant/message` 事件的 `usage` 求和，与面板同源；官方悬停的用时/首token/速率不受影响）。

  数据直接从会话日志解码（`session.jsonl.zstd` zstd 多帧，与 `dsh-session-rewind` 同机制），**费用为估算**（日志不含费用，按价格表估算，仅供成本参考）。详见 [plugins/dsh-usage-stats/README.md](plugins/dsh-usage-stats/README.md)。
  > 说明：消息行「本次token」原为独立插件 `dsh-turn-tokens`（v0.1.0），自 v0.2.0 起合并进本插件；若历史版本装过它，先移除再安装本插件，避免重复显示。

### 数据维护（恢复 / 永久删除归档会话）
> dsh 官方**没有**"永久删除会话"和"取消归档"功能：网页里的"归档"只是把会话**隐藏**（日志文件与注册表条目全部保留）。本启动器在**服务停止后**直接操作本地数据文件，做到：
> - **恢复（取消归档）**：把会话 id 从 `workspace.json` 的 `global.archivedSessionIds` 中移除，会话重新出现在 WebUI 会话列表，**日志与内容不受影响**（等价于"把放逐的武将召回麾下，既往不咎"）。
> - **永久删除**：彻底删除日志目录 + 注册表条目，**不可恢复**（等价于"削籍夺职，永不叙用"）。
>
> WebUI 侧仅能通过 `dsh-archive-purge` 插件**只读查看**已归档会话；真正的删除/恢复在这里完成：**先点「停止服务」→ 主窗口「数据维护」→「会话管理」→ 勾选会话后点「恢复选中」或「删除选中」**。

| 操作 | 位置 | 说明 |
|------|------|------|
| 会话管理 | 主窗口「数据维护」区 | 点击后弹出会话列表（标题 / 工作区 / 状态 / 有无日志），**可勾选（全选/全不选/单选）**后选择**恢复选中**（仅对"已归档"会话生效）或**永久删除选中** |
| 命令行 | `--restore-session <ID>` | 复原（取消归档）指定会话 |
| 命令行 | `--purge-archived` / `--purge-session <ID>` | 永久删除：前者清全部归档，后者删指定会话 |

- **恢复**只改 `storages/workspace.json` 的 `archivedSessionIds`（原子写回：临时文件 + `os.replace`），不动日志与工作区归属；重复恢复未归档会话、恢复不存在的会话都会安全返回"无需操作"。
- **删除**时会一并清理三个来源：
  1. 会话日志目录 `runtime/dsh-home/sessions/<工作区编码>/<会话ID>/`
  2. `storages/workspace.json` 中的 `sessionIds` / `archivedSessionIds` 条目
  3. `storages/session_projcache.json` 中该会话的标题 / 统计缓存行

注意事项：
- **必须先停止服务**（GUI 会弹窗提示；命令行会校验，服务在运行时报错退出）
- 删除**不可恢复**，删除前均有确认提示；恢复不删数据，可放心操作
- 正在运行的会话不会被清理

## 六、绿色版自更新（双通道更新）

本绿色版支持**两条完全独立、互不干扰的更新通道**：

| 通道 | 更新对象 | 入口 | 更新源 |
|------|----------|------|--------|
| 官方核心 | dsh 本体（`runtime/dsh/` 的 npm 包） | 「检查更新」 | 官方 npm / GitHub |
| 绿色版外围 | 启动器 `launcher.py` / `DSH_Launcher.exe` / `plugins/` / 文档等 | 「检查绿色版更新」 | 本项目 GitHub Release（连不通时自动转 Gitee 镜像） |

两条通道各自判断版本、各自下载、各自备份，**绝不互相触碰**：核心更新只动 `runtime/dsh/`，外围更新只动程序根目录（并跳过 `config.json` 与 `runtime/`），互不干扰、互不依赖。

### 绿色版外围更新流程
1. 点「检查绿色版更新」（需先停止服务）→ 查询 GitHub 最新 Release（官方 API 失败自动降级国内镜像，再失败自动转 **Gitee**——两级策略：有发布版优先用发布版 zip 附件直连下载，无发布版才回退 git 协议克隆整仓快照；覆盖时统一跳过 `DEV_NOTES.md`/`.gitignore` 等开发侧文件，保证与 GitHub 更新结果一致）。
2. 有新版则弹窗显示版本对比与更新说明（更新来源为 GitHub 或 Gitee 会分别提示）→ 确认后获取新版内容到 `runtime/update/extracted/`：
   - **GitHub 来源 / Gitee 发布版**：下载分发 zip（带进度、校验大小）→ 安全解压（Gitee 手动上传的 release 附件实测可直连下载，不走挑战页）；
   - **Gitee 整仓快照（无发布版时兜底）**：Gitee 的整仓 zip 下载地址会返回 JS 挑战页拿不到真实包，启动器改用 **git 智能 HTTP 协议克隆整仓**（等效整仓快照，只依赖 Python 标准库）。
3. 生成**更新任务文件**（`runtime/update/update_job.json`，内含新版路径与手动下载地址）。
4. 确认后**退出启动器**，启动独立更新程序 `DSH_Update.exe` 完成后续全部动作：
   等本体退出并释放文件锁 → 备份旧文件到 `runtime/update/backup/` → 覆盖程序根目录（跳过 `config.json` / `runtime/` / `.git`，连 `DSH_Update.exe` 自身也会先复制到 `runtime/tmp` 再从副本运行，保证自己能替换成新版）→ 自动重启新版启动器。
5. 全程有独立进度窗口显示状态；**若失败会弹窗说明原因，并给出手动下载地址**（GitHub 发布页 / Gitee 仓库页 + 更新包直链），程序不受影响可继续使用当前版本。

### 安全与回退
- **不替换** `config.json`（你自定义的端口/镜像设置）与 `runtime/`（你的会话数据 / 已装环境）。
- 覆盖前旧文件自动备份到 `runtime/update/backup/`，新版有问题可手动复制回根目录回退。
- 分发 zip 命名约定：`DSH_Launcher_GreenPortable_Online_<日期>_v<版本>.zip`，Release tag 为 `v<版本>`（当前 `v1.0.10`）。
- 内置插件源码随绿色版更新，但**已安装**到 `runtime/dsh-home/profiles/web` 的插件副本是 pnpm 拷贝，需到「插件管理」重新安装本地插件才生效。
- **手动更新方式（自动更新失败时的备选）**：打开 GitHub 发布页下载最新 zip → 解压 → 把解压得到的文件**覆盖**到程序根目录（**不要**覆盖 `config.json` 与 `runtime/` 文件夹）→ 重新双击启动。

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
改过 `launcher.py` / `update_agent.py` 后想更新 exe，双击 **build_exe.bat** 即可：
1. 自动定位 Python（内置优先，其次系统）
2. 本地安装 PyInstaller 到 `runtime/pyinstaller`（清华镜像，不动系统环境、不用 C 盘）
3. 打包单文件 `dist\DSH_Launcher.exe` 并复制到项目根目录
4. 同时打包独立更新程序 `dist\DSH_Update.exe` 并复制到项目根目录
5. 打包时会自动把内置的 VC 运行库（`vcruntime140.dll` / `vcruntime140_1.dll` / `vcruntime140_threads.dll`）一并打进两个 exe，目标机器无需另装 VC++ 运行库（详见下方"常见问题"末行）

### 手动下载内置 Python（可选）
若不想等自动下载，可手动把 python-build-standalone 的
`cpython-3.10.20+20260807-x86_64-pc-windows-msvc-install_only.tar.gz` 解压进 `runtime/python`，
目录布局放 `runtime/python/python.exe` 或 `runtime/python/任意子目录/python.exe` 均可被识别。

## 八、安全说明
- 服务只绑定 `127.0.0.1`（本机回环），不会暴露到公网
- 所有文件读写、命令执行都发生在你选择的**工作区**内
- 首次在网页里操作时，遇到高危命令确认框请仔细看后再点允许

## 九、DSH 经验 Skill

把本项目沉淀的部署 / 维护 / 插件开发经验整理成了 TRAE Skill：**`dsh-deploy-maintain`**。

- 源文件在项目 `skills/dsh-deploy-maintain/`（主文档 `SKILL.md` + `checklists/` 检查清单 + `references/` 插件骨架与数据目录详解）。
- 已安装到 TRAE 全局 skills（`~/.trae-cn/skills/dsh-deploy-maintain/`），新会话可直接用。
- 内容：绿色整合部署（便携 Node / 环境变量重定向 / 工作区 ACL 沙箱 / exe 打包）、日常维护（更新备份 / 插件管理 / 数据维护）、DSH 插件开发（双端加载 / `ctx.effect` 路由注册 / `exports` 坑）、51 条避坑浓缩为排查速查表。

## 十、常见问题

| 问题 | 处理 |
|------|------|
| 提示找不到 Python | 说明内置便携 Python 缺失且下载失败（多为网络问题），按 start.bat 里的提示手动安装 Python 3，勾选 Add to PATH 即可兜底 |
| 下载 Node 慢 / 失败 | 在界面设置里把镜像源切到"国内"或"官方"再试 |
| 安装 dsh 慢 / 长时间卡住 | 官方 npm registry 在国内访问慢，在界面设置或 `config.json` 把镜像源切到"国内 (npmmirror)"，保存后重试（本次绿色版已默认 `mirror=cn`） |
| 端口被占用 | 设置里改端口（如 3090）后保存，重新启动 |
| 想彻底卸载 | 直接删掉整个文件夹即可（不写注册表、不留系统残留） |
| shell 工具报 `Windows ACL temp root must be outside the workspace` | 该会话的工作区包含了 `runtime/tmp`（典型：工作区选了程序根目录）。绿色整合把临时目录放在程序目录内，dsh 的 ACL 沙箱要求临时目录必须在工作区**外部**。解决：开新会话时在工作区选择器里选 **workspace**（`…\workspace`，启动器会自动解析并预置）或任何不含 `runtime/tmp` 的目录；旧会话无法改工作区，只能归档/删除或开新会话 |
| dsh 网页打不开 | 看 `runtime/server.log`；确认防火墙没拦 127.0.0.1 |
| 设置 API Key 时报 `EPERM: rename denied` | 偶发，属安全软件（如火绒）实时扫描与写文件并发冲突。重试一次即可保存成功；若频繁出现，把 `DeepSeekHarnessLauncher` 目录加入安全软件白名单 |
| 绿色版更新失败 / 更新后没生效 | 独立更新程序会弹窗说明失败原因，并给出手动下载地址（GitHub 发布页 + 更新包直链）。备选：打开 GitHub 发布页下载最新 zip → 解压 → 把解压得到的文件覆盖到程序根目录（**不要**覆盖 `config.json` 与 `runtime/` 文件夹）→ 重新双击启动 |

## 十一、开源协议

本绿色版整体（启动器 `launcher.py`、绿色版外壳、内置的 6 款插件，见 [内置插件一览](#内置插件一览)）统一采用 **Apache License 2.0** 开源协议：`Copyright (c) 2026 LiuJunheng`。协议副本见仓库根目录 [LICENSE](LICENSE)，绿色版 zip 已随包附带。

- **主项目 + 全部内置插件**：同一份 Apache License 2.0，随绿色版一并分发，无额外、无割裂的单独协议声明。
- **运行时依赖**（`@deepseek-ai/dsh`、Node.js、便携 Python 等）为各第三方项目自己的许可证，绿色版仅在其本地运行时目录内安装使用，不随源码分发。

Apache License 2.0 要求：再分发（含绿色版 zip / exe）必须保留本 LICENSE 副本与版权声明；修改文件须标注变更；不授予商标许可；按 "AS IS" 提供、无任何担保。

> **对绿色版打包的合规提醒**：打包命令里**必须包含 `LICENSE`**（见上文"轻量分发 zip"），否则分发的 zip 不含协议副本、违反 Apache 2.0 §4 的再分发条款；同样，各插件随绿色版再分发时也需保留根 [LICENSE](LICENSE) 副本，已随打包目录一并带上。
