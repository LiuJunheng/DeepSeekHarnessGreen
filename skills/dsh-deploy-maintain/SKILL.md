---
name: dsh-deploy-maintain
description: "DeepSeek Harness 绿色整合版部署维护与插件开发全套实操经验。Invoke when user 搭建/维护绿色版 dsh 环境、开发 dsh 插件、排查插件 WebUI/路由问题、或发布 Release。"
version_date: 2026-09-02
---

# DSH 绿色整合版 · 部署维护与插件开发

> 本 Skill 沉淀自 `DeepSeekHarnessLauncher` 项目实测经验，只记录**对日后部署/维护/插件开发有复用价值的内容：机制、避坑、约定**。不存档开发过程与时间线。
> 文档分流：README = 使用者文档；根项目 `DEV_NOTES.md` = 开发者/发布者权威文档；本 Skill = 可操作经验速查。改经验相关逻辑时**同步更新本 Skill 与 DEV\_NOTES**。

## 一、适用场景

- **部署**：绿色整合环境搭建——便携 Node + 本地 dsh + 数据全落程序目录，不污染用户主目录
- **维护**：dsh 更新（先备份后重装）、可视化插件管理（搜索/安装/移除/本地文件夹）、数据维护（会话永久删除/恢复归档）、绿色版自更新（双通道）
- **插件开发**：双端加载的 dsh 插件（宿主端路由 + WebUI 客户端入口），排查"服务端在客户端不显示/路由 404/装了不生效"
- 配套技能：`python-tkinter-desktop-dev`（GUI 通用规范）、`trae-skill-creation`（Skill 打包规范）

## 二、核心机制

### 2.1 目录结构（BASE\_DIR，可整目录拷走）

```
BASE_DIR/
├── launcher.py            # Python 启动器（GUI/CLI）
├── start.bat / stop.bat   # ASCII + CRLF 编码
├── desktop-shell.py       # pywebview 内置桌面壳
├── config.json            # 镜像/端口/default_workspace
├── plugins/               # 内置插件源码
├── runtime/               # 全部运行时数据（绿色整合核心）
│   ├── node/              # 便携 Node
│   ├── dsh/               # @deepseek-ai/dsh 本体
│   ├── dsh-home/          # DSH_HOME：会话/配置/存储
│   └── python/            # 内置便携 Python + PyInstaller
└── skills/                # Skill 文档
```

### 2.2 环境变量重定向（绿色整合命根子）

| 变量 | 落点 | 作用 |
|-----|------|------|
| `DSH_HOME` | `runtime/dsh-home` | 会话/配置/存储（**不设则写用户主目录，破坏便携**） |
| `npm_config_cache` | `runtime/npm-cache` | 下载缓存 |
| `npm_config_userconfig` | `runtime/npm-userconfig` | 阻断读写 `~/.npmrc` |
| `PNPM_HOME` | `runtime/pnpm-home` | pnpm 全局（dsh 插件管理依赖） |
| `npm_config_store_dir` | `runtime/pnpm-store` | pnpm 内容寻址存储 |
| `TEMP`/`TMP` | `runtime/tmp` | 进程临时目录 |

### 2.3 服务启动与进程管理（6 条硬坑）

| # | 坑 | 规则 |
|---|-----|------|
| 1 | `stdin` 未保持打开 → dsh 约 40 秒静默退出 | `Popen(..., stdin=subprocess.PIPE)` |
| 2 | 官方 dsh 默认自动开浏览器 | 启动命令必须加 `--no-open` |
| 3 | 新版 dsh 需 `?token=<launchToken>` 认证 | 从 server.log 解析 token + 拼认证 URL |
| 4 | 残留 dsh 进程占 3080 端口 | 启动前只杀进程名含 node 且命令行含 bin.js 的 |
| 5 | 改 launcher.py 必须重打包 exe | 否则旧 exe 开裸地址必然 401 |
| 6 | dsh bin 入口不是顶层 bin/ | 必须用 `node_modules/@deepseek-ai/dsh/lib/bin.js` |

### 2.4 工作区 ACL 沙箱（Windows 专属大坑）

- **dsh 要求临时根目录不能位于会话工作区内部**，否则 shell 工具报 `Windows ACL temp root must be outside the workspace`
- 会话**工作区归属固化**在日志 header 的 `cwd` 字段，一经创建不可改
- `workspace.json` 是**工作区注册表**，不是会话配置

### 2.5 exe 打包（PyInstaller）

| # | 坑 | 规则 |
|---|-----|------|
| 1 | onefile 下 `__file__` 不可作根目录 | `frozen` 时取 `sys.executable` 所在目录 |
| 2 | 缺 VC 三件套 → `Failed to load Python DLL` | `--add-binary vcruntime140.dll/vcruntime140_1.dll/vcruntime140_threads.dll;.` |
| 3 | 便携 Python 有顶层子目录 | `find_python_exe` 必须"先查顶层，再遍历一层子目录" |
| 4 | 系统 python 可能是 2.7 | 统一用 `runtime\python\python\python.exe` 校验 |

## 三、日常维护

### 3.1 检查更新

- **官方 dsh 只查 npm 会漏更新**：GitHub tag（`dsh-v<ver>`）和 npm 不同步，必须两源合并
- 查询避坑：`dist-tags --json` 必须拆成独立 argv（整串当单参数会返回 None）
- `update_dsh` 顺序：备份 → **备份成功后才**强制重装
- 升级后自愈四步：移除不兼容 bundle → 补宿主 peer 依赖 → 强制重建依赖树 → 冒烟验证

### 3.2 插件管理（pnpm 驱动）

| # | 坑 | 规则 |
|---|-----|------|
| 1 | pnpm 裸跑 `--version` 失败 | 必须在含便携 node 的 PATH 下运行 |
| 2 | `file:` 安装是拷贝非软链 | 改源码必须重装才同步 |
| 3 | pnpm 退出码 1 跳过 reconcile | 启动器兜底 `reconcile_bundles()` |
| 4 | 停用插件被 reconcile 加回 | launcher 每次命令后重放停用状态 |
| 5 | 原生依赖构建被拒 | 启动器自动补 `allowBuilds` 白名单 |

### 3.3 数据维护（官方无此能力）

- **彻底删除**：服务停止后，三处一并清理——`sessions/<ID>/` + `workspace.json` + `session_projcache.json`
- **复原（取消归档）**：只从 `archivedSessionIds` 移除 ID，日志/归属/缓存天然无损
- JSON 写回用**原子写**（同目录临时文件 + `os.replace`）

### 3.4 绿色版自更新

分发给用户后两条**完全独立**的更新通道：
- **通道①官方核心**：更新 `runtime/dsh/` 的 dsh npm 包
- **通道②绿色版外围**：更新根目录 launcher.py/exe/plugins/文档，从双平台 Release 获取

**版本追踪铁律**：
- `GREEN_VERSION` 是**唯一来源**（禁止硬编码版本号到脚本 zip 名）
- 版本号对比按数字分段（`1.0.10 > 1.0.9`）
- **版本日期纪律**：`GREEN_VERSION_DATE` 必须是制作当天，**不预写未来日期**

**独立更新程序**：启动器 exe 被 Windows 锁定无法自替换 → 下载新版 zip → 写 `update_job.json` → 以 `DETACHED_PROCESS` 启动 `DSH_Update.exe --apply` 并退出本体。更新程序先自我复制到 `runtime/tmp/` 从副本运行。

### 3.5 Online 绿色版打包

> **完整配置代码见**：`references/release-script.md` | **一键脚本**：根目录 `release_upload.py`

**核心原则**：Online 版 = **启动器框架**（~17 MB），**不包含 runtime/**。用户首次运行时点「安装环境」由 launcher 自动下载。

**必须包含**：DSH\_Launcher.exe / DSH\_Update.exe / DSH\_Launcher.ico / launcher.py / update\_agent.py / desktop-shell.py / config.json / start.bat / stop.bat / plugins/ / pages/ / skills/ / README.md / README\_EN.md / LICENSE / DEV\_NOTES.md

**必须排除**：整个 runtime/（Gitee 100MB 限制）| .git/ .trae/ workspace/ build/ dist/ __pycache__/ | \*.pyc \*.pdb \*.spec | 打包辅助脚本

**命名规范**：`DSH_Launcher_GreenPortable_Online_{YYYYMMDD}_v{VERSION}.zip`

## 四、GUI 启动器要点（tkinter）

- **X 二次确认 + 最小化**：`root.protocol("WM_DELETE_WINDOW", on_close)`；托盘从启动就常驻
- **单实例**：`CreateMutexW` 命名互斥量，句柄由实例**整个生命周期持有**
- **托盘窗口过程挂钩必须在 `__init__`**：别放 add()；WndProc 回调**绝不能直接调 Tk**（重入 Tcl 崩溃）
- **自定义图标**：`--add-data` 源路径必须写绝对路径；ICO 用 `image.save(format="ICO", sizes=[...])`
- **"待保存"设置同步**：启动类动作前先 `sync_gui(silent=False)` 落盘
- **语言提示**：`.bat` 保持 ASCII 全英文；desktop-shell 提示语用英文（中文乱码）
- 通用经验另参考 `python-tkinter-desktop-dev` Skill

## 五、DSH 插件开发

> **完整开发指南（协议详解、路由注册、客户端扩展点、UI 坑、pnpm 坑、自愈逻辑）见**：`references/plugin-guide.md` | **主题适配完整规范见**：`references/theme-adaptation.md` | **代码骨架见**：`references/plugin-skeleton.md`

### Cordis 插件协议硬约束（踩任何一条服务直接炸）

| # | 约束 | 违反症状 |
|---|-----|---------|
| 1 | 宿主端导出函数名必须是 `apply` | `invalid plugin, expect function or object with an "apply" method` |
| 2 | 纯客户端也必须带 `lib/index.js`（no-op apply） | `ERR_MODULE_NOT_FOUND: ...lib/index.js` 启动即退 |
| 3 | `exports` 必须含 `"./package.json": "./package.json"` | 客户端 bundle 跳过 → WebUI 入口不出现 |
| 4 | `files` 数组必须含 `cordis.patch.yml` | pnpm 安装时文件被排除 → 插件树注册失败 |
| 5 | `name` 与目录名一致 | pnpm 安装可能出问题 |
| 6 | 纯 hook 插件不能写 `dsh.client` | `client-modules declares dsh.client but exports no "./client"` → 启动崩溃 |

### 路由注册速查

- `ctx.effect` 必须**回调包裹**：`ctx.effect(() => ctx.webServer.register({...}), "label")`，不能直接传 disposer
- 同 path 不同 method → **同一 handler 内按 `req.method` 分流**（dsh 的 register 不支持同 path 多 method）
- 404 排查：① 同 (kind,path) 是否注册两条 ② `__DSH_BOOT__.entries` + `curl /plugins/<id>/client.js` 200 ③ `settings.section` 是侧边栏导航行

### 客户端开发速查

- 改客户端源码**强刷页面**即可；改宿主端/加减插件必须**重启服务**
- `file:` 安装是**拷贝**非软链，改 `plugins/` 源码不重装静默不生效
- 插槽条目组件**不要条件调用 hook**
- 同色系糊片铁律：primary 文字 + secondary 背景绝对不能同时用（完整规则见 theme-adaptation.md）

## 六、发布脚本

> 完整代码和配置见：`references/release-script.md` | 项目实作：根目录 `release_upload.py`（v2.0）

一键完成：环境校验 → 读版本号 → Python zipfile 打 Online 绿色版 → GitHub/Gitee Release 创建 → zip 上传。

8 条避坑清单：系统 python 2.7 → PowerShell multipart 编码 → zip 被清理 → 版本号不同步 → Gitee 100MB 超限 → .bat 乱码 → PowerShell 转义 → Release tag 不一致。

## 七、纪律与注意事项

| # | 纪律 |
|---|------|
| 1 | `.bat` 文件**全部 ASCII 编码**，避免 GBK/UTF-8 BOM 冲突 |
| 2 | 版本号**唯一来源**：`launcher.py GREEN_VERSION`，禁止硬编码到脚本 |
| 3 | 版本日期**必须是制作当天**，不预写未来日期 |
| 4 | 改 `launcher.py` 后必须**重打包 exe**，否则旧 exe 行为不变 |
| 5 | GitHub Release 上传用 urllib 直传或 curl.exe，**别用 PowerShell Invoke-RestMethod** |
| 6 | 中文 Git 提交用 UTF-8 消息文件（`git commit -F <file>`），别用 `-m "中文"` |
| 7 | 插件 package.json 改了后用户必须**重装插件**（file: 是拷贝非软链） |
| 8 | Skill 改了必须同步更新 DEV\_NOTES.md（权威开发者文档） |

## 八、避坑速查表

| 领域 | 最高发坑 | 一句话 |
|-----|---------|-------|
| 部署 | 启动后网页 "Failed to fetch" | stdin 必须 PIPE 打开，别让 dsh 读 EOF |
| 部署 | 启动后网页 401 | dsh 0.1.2+ 需 `?token=` 认证 URL，别开裸地址 |
| 部署 | 3080 端口被占 | 启动前杀残留 dsh 进程（只杀 node+bin.js 的） |
| 更新 | dsh 包有新但启动器说没 | 只查 npm 会漏，GitHub tag 和 npm 不同步 |
| 插件 | "装完服务起不来" 最常见原因 | 纯客户端没放宿主端 lib/index.js no-op |
| 插件 | WebUI 入口死活不出现 | exports 漏 `./package.json` |
| 插件 | 同色系糊片 | primary 文字 + secondary 背景绝对不能同时用 |
| 发布 | Gitee Release 附件超 100MB | 砍掉 runtime/，Online 版只含启动器框架 |
| 发布 | 旧 exe 改了没反应 | exe 被锁定无法自替换，必须用 DSH\_Update.exe 机制 |
