# DeepSeek Harness 桌面绿色整合版启动器

[English](README_EN.md) | 中文

把 DeepSeek Harness（`dsh`）封装成**双击即用**的本地启动器：不用敲命令、不用单独装 Python / Node、不用手动开浏览器，整包拷走就能用。如同三军帐中一纸调令，点一下即可出征。

**下载**：[GitHub Release](https://github.com/LiuJunheng/DeepSeekHarnessGreen/releases/latest) ｜ [Gitee Release](https://gitee.com/liujunheng/DeepSeekHarnessGreen/releases)（国内更快）｜ [GitHub 仓库](https://github.com/LiuJunheng/DeepSeekHarnessGreen) ｜ [Gitee 仓库](https://gitee.com/liujunheng/DeepSeekHarnessGreen)

---

## 亮点速览

- **⚡ 双击即用**：用 `DSH_Launcher.exe`（无需装 Python）或 `start.bat`，首次点一下「安装环境」即可自动就绪。
- **🖥️ 桌面版界面体验**：默认以**独立桌面窗口**打开（内嵌 WebView2，完全脱离浏览器，像原生桌面 App 一样独立成窗）；也可一键切回**原始 WebUI**（用系统浏览器打开）。「桌面窗口 / 网页窗口」随时切换，默认方式可在设置里改。
- **🌱 绿色便携**：Node、dsh、npm/pnpm 缓存、会话数据、临时文件**全部在本目录 `runtime/`**——不写用户主目录、不装系统、不写注册表；内置便携 Node/Python，下载国内镜像优先、连不上自动回退官方。整个文件夹拷到任意电脑即可继续用。
- **📦 内置 10 款实用插件**：会话回退 / 导入、用量统计、文件浏览、清理归档、侧边栏、背景影画、**Ollama 本地大模型接入**、**祖宗记忆库（跨会话自动记忆，v3 默认关闭）**、**用户规则注入（类似 TRAE 规则功能，v4 支持 WebUI 内编辑）**等，文有文臣、武有武将，各司其职（详见[内置插件](#内置插件)）。
- **🔁 两通道独立自更新**：官方核心（dsh）与绿色版外围互不干扰，各查各的、各备各的；更新前自动备份、失败给出手动地址，**不丢你的设置与会话**。
- **🏠 局域网远程访问**：一键把服务绑定到 `0.0.0.0` 并**自动放行 Windows 防火墙**，手机 / 其它电脑可直接打开 WebUI。

---

## 快速上手（第一次使用）

1. 解压后双击 **`DSH_Launcher.exe`**（或 `start.bat`）；
2. 点 **【安装环境】**：自动下载便携 Node → 本地安装 dsh → 补齐内置 Python（需联网，几分钟，npm 进度逐行显示）；
3. 点 **【启动服务】** → 自动打开**独立桌面窗口**（也可在启动器里切到**网页窗口**，用浏览器打开原始 WebUI）；
4. 网页里：设置 → 模型 → 填入 **DeepSeek API Key**，并**选择工作区**（让 AI 干活的文件夹）；
5. 之后每次：双击启动器 → 点【启动服务】即用。

> 之后即可直接在网页里与 DeepSeek 对话、让 AI 读写工作区文件、调用工具执行任务。

### 主要界面按钮

| 按钮 | 作用 |
|------|------|
| 安装环境 | 下载便携 Node + 安装 dsh + 补齐内置 Python |
| 启动 / 停止服务 | 拉起 / 停止 dsh 服务（启动后按默认方式自动打开界面） |
| 桌面窗口 / 网页窗口 | 手动打开界面：**桌面窗口** = 内嵌 WebView2 独立窗口；**网页窗口** = 系统浏览器打开原始 WebUI（默认方式可在设置里改） |
| 检查更新 | 检测**官方 dsh** 最新版本（动态列出 npm 稳定版/预发布 + GitHub 全部 tag），更新前自动备份旧版 |
| 检查绿色版更新 | 检测**本绿色版外围**（启动器/插件/文档）更新，由独立更新程序 `DSH_Update.exe` 完成覆盖安装并重启 |
| 插件管理 | 查看 / 搜索 / 安装 / 移除插件（npm + GitHub 官方话题页，也可装本地插件文件夹） |
| 数据维护 | 服务停止后：恢复（取消归档）或永久删除归档会话 |
| 设置 | 镜像源、端口、局域网绑定等 |

> **无界面模式**（可选）：`python launcher.py --start / --stop / --purge-archived / --purge-session <ID> / --restore-session <ID> / --install-plugin <目录或包名>`。

---

## 绿色整合与数据

- **全部本地化**：便携 Node、dsh 包、npm 缓存、pnpm 存储、会话数据、临时文件，全在 `runtime/` 下，不会产生 `~/.npm`、`~/.pnpm-store` 等用户目录残留。
- **不污染系统**：不装全局包、不改 PATH、不写注册表。
- **整目录迁移**：停止服务 → 复制整个文件夹到新电脑 → 双击即用，会话记录跟着走（工作区路径不一致时在网页里重新选一下工作区即可）。
- **彻底卸载**：直接删除整个文件夹，无残留。

**轻量分发 zip**：发布包不含 `runtime/`（不带已下载的环境），体积小；新机联网后由启动器自动下载 Node / Python / dsh，解压 → 点【安装环境】 → 点【启动服务】三步即可。

---

## 内置插件

全部为**纯插件**（不修改官方文件），与绿色版统一采用 Apache License 2.0 开源；安装方式：「插件管理 → 选择本地插件文件夹安装…」选 `plugins\<插件名>`，装完**重启服务**生效。

| 插件 | 一句话功能 |
|------|-----------|
| `dsh-file-browser` | WebUI 内文件浏览 / 预览 / 右键把官方 `@引用`、路径或内容塞进对话 |
| `dsh-archive-purge` | WebUI 查看已归档会话（清理归档只读页） |
| `dsh-session-rewind` | 会话被工具崩溃"毒化"时，一键回退到某可行回合派生干净续聊 |
| `dsh-session-import` | 把导出的会话 ZIP / JSONL 导回本机（与官方导出互逆） |
| `dsh-usage-stats` | 用量统计 + 每条消息的「本次 token / 预估费用」 |
| `dsh-sidebar-lite` | WebUI 右侧边栏（文件管理 / 预览 / 浏览器 / 终端 / 任务） |
| `dsh-media-background` | 本地目录视频作为 WebUI 背景播放（画面 + 声音） |
| `dsh-ollama` | 自动识别本机 Ollama 服务并接入，模型选择器直接选 Ollama 模型对话 |
| `dsh-memory` | **祖宗记忆库**：把对话关键信息沉淀到 SQLite，下次对话自动召回注入 system prompt。v3 加【测试】标签 + 默认关闭（省 token）+ WebUI 开关 + 记忆类型分类。规则提炼引擎零 LLM 成本，自动过滤寒暄套话思考过程。 |
| `dsh-rules` | **用户规则注入**：类似 TRAE 规则功能，编写个人偏好 / 代码风格 / 沟通要求的 markdown，每次对话自动注入 system prompt。v4 升级为双端插件，支持 **WebUI 内直接编辑**（预览 + textarea + 下载 .md 备份）+ 默认关闭。 |

各插件详细用法见 `plugins/<插件名>/README.md`。

### 数据维护（恢复 / 永久删除归档会话）

dsh 官方**没有**"永久删除会话"和"取消归档"功能——网页里的"归档"只是把会话隐藏（日志全保留）。本启动器在**停止服务**后直接操作本地数据，做到：

- **恢复（取消归档）**：会话重新出现在列表，日志与内容不受影响（召回放逐的武将，既往不咎）；
- **永久删除**：彻底删除日志 + 注册表条目，不可恢复（削籍夺职，永不叙用）。

入口：主窗口「数据维护 → 会话管理」，勾选会话后点「恢复选中 / 删除选中」。

---

## 双通道独立更新

两条**完全独立、互不干扰**的更新通道：

| 通道 | 更新对象 | 入口 | 更新源 |
|------|----------|------|--------|
| 官方核心 | dsh 本体（npm 包） | 「检查更新」 | 官方 npm / GitHub（动态检测所有标签） |
| 绿色版外围 | 启动器 / exe / 插件 / 文档 | 「检查绿色版更新」 | GitHub Release（连不通自动转 Gitee 镜像） |

核心更新只动 `runtime/dsh/`，外围更新只动程序根目录并**跳过 `config.json` 与 `runtime/`**（你的设置与会话数据不被动）；覆盖前旧文件自动备份到 `runtime/update/backup/`，新版有问题可手动复制回退。

---

## 局域网远程访问

主窗口「网络设置」→ 服务绑定选 **局域网 (0.0.0.0)** → 保存并【启动服务】，就绪日志会显示 `局域网访问地址: http://<本机IP>:3080`，其它电脑/手机打开即可使用。受信任主机不填 = 自动信任全部局域网 IP；填了只信任填写的地址。**凭据（API Key）类特权操作仍仅本机可改**，属官方安全保护。本机模式（默认 `127.0.0.1`）与以往完全一致。

> 常用设置（镜像源 / 端口 / 局域网）也可在 `config.json` 里改：`mirror`（auto/cn/official）、`dsh_port`、`dsh_host`、`trusted_hosts`。

---

## 常见问题

| 问题 | 处理 |
|------|------|
| 提示找不到 Python | 内置便携 Python 缺失且下载失败（多为网络问题），按 start.bat 提示手动装 Python 3 勾选 Add to PATH 兜底 |
| 下载 Node / 安装 dsh 慢 | 界面设置把镜像源切到「国内」或「官方」再试（默认已 `mirror=cn`） |
| 端口被占用 | 设置里改端口（如 3090）后保存重启动 |
| shell 工具报 `Windows ACL temp root must be outside the workspace` | 该会话工作区包含了 `runtime/tmp`；开新会话时在工作区选择器里选 **workspace** 目录（启动器会自动预置） |
| 网页打不开 | 看 `runtime/server.log`；确认防火墙没拦 127.0.0.1 |
| 设置 API Key 报 `EPERM: rename denied` | 偶发，属安全软件实时扫描冲突，重试一次即可；频繁出现则把目录加入安全软件白名单 |
| 绿色版更新失败 | 更新程序会弹窗给出手动下载地址（GitHub / Gitee 发布页 + 直链），解压后覆盖到程序根目录（**不要**覆盖 `config.json` 与 `runtime/`） |

---

## 开源协议

本绿色版整体（启动器 `launcher.py`、绿色版外壳、内置插件）统一采用 **Apache License 2.0**：`Copyright (c) 2026 LiuJunheng`，协议副本见 [LICENSE](LICENSE)，绿色版 zip 已随包附带。运行时依赖（`@deepseek-ai/dsh`、Node.js、便携 Python 等）为各第三方项目自己的许可证，仅在本地运行时目录内安装使用，不随源码分发。

---

## DSH 经验 Skill

本项目部署 / 维护 / 插件开发经验已沉淀为 TRAE Skill **`dsh-deploy-maintain`**（源文件在 `skills/dsh-deploy-maintain/`，含 51 条避坑速查），已安装到 TRAE 全局 skills，新会话可直接使用。
