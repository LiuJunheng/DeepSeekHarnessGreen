---
name: dsh-deploy-maintain
description: "DeepSeek Harness 绿色便携版（一键启动器）的部署、日常维护、插件开发与避坑经验。覆盖便携 Node/dsh 安装、环境变量重定向、工作区 ACL 沙箱、更新备份、插件管理与 dsh 插件双端加载/路由注册等全套实操知识。"
---

# DeepSeek Harness 绿色便携版 · 部署维护与插件开发

> 版本日期：2026-08-15
> 本 Skill 沉淀自 `DeepSeekHarnessLauncher` 项目（Python tkinter 一键启动器 + 内置 `dsh-archive-purge` 插件）的全过程实测经验，含 34 条避坑记录。适用于：把 dsh 封装成"双击即用、绿色便携、可整目录拷走"的形态，以及开发 DSH 插件（宿主端路由 + WebUI 客户端入口）。

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

### 3.3 数据维护（会话永久删除，dsh 官方无此能力）

- **dsh 没有"永久删除/取消归档"接口**：网页"归档"只是把会话隐藏（日志 + 注册表条目全保留）。
- **彻底删除需在服务停止后直接操作数据文件**，三处一并清理：
  1. `sessions/<工作区编码>/<会话ID>/` 日志目录（只按 id 遍历查找，**不拼接用户输入进路径，防路径穿越**）。
  2. `storages/workspace.json` 的 `sessionIds` / `archivedSessionIds`。
  3. `storages/session_projcache.json` 缓存行。
- JSON 写回用 `_atomic_write_json`（同目录临时文件 + `os.replace`）保证原子性，避免半写损坏。
- **数据维护要求服务已停止**（GUI 弹窗提示、CLI `is_server_running()` 校验），避免与运行中的 dsh 竞争写文件。

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
- 加减插件必须**重启服务**才生效（HMR 只对已加载插件源码有效；settings.yaml 与 web 客户端 HMR 在 dev 模式不需重启）。
- GitHub topic 页的仓库 ≠ 插件本体：主仓库根目录往往没有 package.json（可能是跨 agent 工具集），真正的 dsh 插件可能是独立子仓库 + npm 包。判断标准 = 根目录有无 package.json + `dsh.bundle`/入口。

## 五、验证与排查速查表

| 症状 | 首选排查动作 |
|------|-------------|
| WebUI 入口不显示 | 抓首页 `window.__DSH_BOOT__.entries` 是否含插件 → 查 `exports` 是否含 `./package.json` → 查 `files` 是否含 `cordis.patch.yml` |
| 点击按钮 HTTP 405 | 查路由是否注册进 exact 表 → 确认 `ctx.effect(() => register(...), label)` 写法 → 查 `dsh-host-frontend-static` fallback 行为 |
| 路由 403 | 自定义头没带对（`x-dsh-plugin-purge: 1`），或来自跨域（无法带自定义头） |
| 会话 shell 报 ACL temp 冲突 | 临时目录在工作区内 → 换用 `BASE_DIR/workspace` 或工作区外目录 |
| "Failed to fetch" / 服务 40 秒退 | stdin 读到 EOF → 用 `stdin=PIPE` 保持打开 |
| 日志报 `Unexpected token '\ufeff'` | 某 npm 包 package.json 带 UTF-8 BOM → 安装前/读入后去 BOM |
| 改插件源码 WebUI 没变化 | pnpm 对 `file:` 是拷贝 → 重新安装插件 + 重启服务 |
| 插件树里有但入口没有 | 重启服务（加减插件需重启生效） |
| 界面空白（GUI 布局） | `ttk.Panedwindow` 漏 `.add()`；滚动条被列宽挤成 1x1 |

## 六、工作流建议（一键启动器开发顺序）

1. **先理数据目录**：确认 `DSH_HOME` / `runtime/` 全部重定向到程序目录，明确"绿色便携"边界。
2. **再搭启动**：便携 Node → `lib/bin.js` 启动 → `stdin=PIPE` → 就绪检测 → 自动开浏览器。
3. **后做维护**：检查更新（备份优先）→ 插件管理（pnpm 便携化）→ 数据维护（会话删除）。
4. **最后开发插件**：先写宿主 `index.js`（路由），再写客户端 `client.js`（设置区块），双端声明齐全 → `--dump-config` 验证插件树 → 抓 `__DSH_BOOT__` 验证客户端 → 实测路由。
5. **贯穿始终**：每个改动同步更新 md 文档；`.bat` 用 ASCII + CRLF；变量名用英文全称不缩写。
