# DSH 绿色便携部署检查清单

## 初始部署

- [ ] 便携 Node 已下载到 `runtime/node`（路径按平台正确）
- [ ] `find_npm_cli()` 能正确找到 npm-cli.js（Windows 在 `node_modules/npm/bin/`，Linux 在 `lib/node_modules/npm/bin/`）
- [ ] dsh 安装用 `node.exe npm-cli.js install --prefix runtime/dsh @deepseek-ai/dsh`，并带 `--registry`（国内镜像时）
- [ ] `DSH_HOME` 已设为 `runtime/dsh-home`（不设则破坏便携）
- [ ] 所有环境变量已重定向到 `runtime/` 下（npm 缓存/pnpm store/TEMP 等）
- [ ] pnpm 已装进 `runtime/pnpm-home` 并加入 PATH
- [ ] 镜像配置正确（auto 模式在国内需确认 npm install 走哪个源）

## 启动

- [ ] 使用 `node <dsh>/lib/bin.js web --port 3080` 启动（不用 `.bat`/`.cmd` 入口）
- [ ] `subprocess.Popen` 已设 `stdin=subprocess.PIPE`（防止 dsh 因 stdin EOF 静默退出）
- [ ] PID 文件写 `runtime/server.pid`，冷启动有重复检测
- [ ] 就绪检测用 socket 轮询端口，成功后 `webbrowser.open`
- [ ] WebUI 单页面去重已生效：`dist/index.html` 含 `dsh-launcher-ui-beacon` 注入标记；心跳服务端口 3081 未被占用
- [ ] 手动点「打开界面」必定开新页（`open_ui(force=True)` 不受去重拦截）；仅自动打开受 `ui_is_open()` 约束
- [ ] 端口监听用 `grep -w 3080` 排查（`grep 3080` 会误匹配 `13080`）

## 更新

- [ ] `dsh_latest_version()` 是只读查询（`npm view`），失败返回 `None` 而非抛错
- [ ] `update_dsh()` 顺序：查询 → 备份旧版到统一备份目录 `runtime/backup/dsh-<版本>` → 备份成功后才强制重装
- [ ] 备份与更新目录集中管理：dsh 备份统一 `runtime/backup/`（不再散落 `runtime/dsh-backup-*`），绿色版更新暂存统一 `runtime/update/`；GUI「数据维护」有「清理更新」「清理备份」按钮清空对应目录（清理备份会顺带清旧版散落的 `dsh-backup-*` 残留）
- [ ] 备份同名加时间戳后缀防覆盖
- [ ] 安装代码抽成 `install_dsh()`，首装与更新共用

## 绿色版自更新（双通道）

- [ ] `GREEN_VERSION` 常量与 GitHub Release tag 一致（tag 带 `v` 前缀，本地去前缀比较）
- [ ] Release 资产命名 `DSH_Launcher_GreenPortable_Online_<日期>_v<版本>.zip`（`green_find_zip_asset` 按此前缀匹配）
- [ ] 官方 API 查询失败降级国内镜像（`mirror.nju.edu.cn/github-release/<owner>/<repo>/latest`）
- [ ] GitHub + 国内镜像都失败自动转 Gitee：**两级策略**——① 先查 Gitee 发布版 `GITEE_RELEASES_API`（公开读），取"最新且带手动 zip 附件"的发布版（过滤：名字 `.zip` 结尾 **且** URL 含 `/releases/download/`，防误选 `archive/refs/tags/...` 挑战页源码包，避坑 #71）→ `source="gitee_release"` 走 zip 直连下载（**手动附件实测直连返回真 zip，不走挑战页**）；② 无发布版才回退 `source="gitee"`：版本号读 `gitee.com/<repo>/raw/master/launcher.py` 的 `GREEN_VERSION`，下载走 **git 智能 HTTP 协议克隆整仓**（`info/refs?service=git-upload-pack` 拿 head sha + `git-upload-pack` 拉 pack + 解析 delta 落盘，`green_gitee_clone_tree`，避坑 #70）；asset `size=0` 时下载跳过大小校验；覆盖时统一跳过 `DEV_NOTES.md`/`.gitignore` 开发侧文件保证与 GitHub 结果一致（避坑 #69）
- [ ] 每次发版建议用 `runtime/tmp/gitee_upload_release.py` + `upload_gitee_release.bat`（填 GITEE_TOKEN 后拖 zip 运行）同步上传 Gitee 发布版附件，让 Gitee 通道优先走直连下载而非整仓克隆
- [ ] 更新内容准备拆 `prepare_update_content_root(release_info, target_dir)`：GitHub/Gitee 发布版=下载 zip 解压，Gitee 整仓=git 克隆；`prepare_green_update` 接收 `content_root`（旧 `new_zip_path` 签名已废弃，`test_green_update.py` 需同步）
- [ ] `launcher.py` 集成 git 解析后确保有 `import zlib`；pack 对象前进位置用 `decompressobj().unused_data` 算消耗；REF/OFS_DELTA 先读未压缩前置字段再解压 delta；sha 匹配用 `bytes.fromhex()`；所有按 source 分流处兼容 `in ("gitee", "gitee_release")`
- [ ] 下载后校验文件大小，不符即删并报错
- [ ] zip 安全解压（逐成员 normpath 拒绝 `..`/绝对路径，防 zip-slip）+ 内容根目录检测（兼容带/不带外层文件夹）
- [ ] zip 打包命令的 `-Path` 传**目录名** `"plugins"` / `"skills"`（zip 内保留前缀）；**不能**传 `"plugins\dsh-xxx"` 子路径（会把插件目录打在 zip 根、丢前缀，覆盖时错位拷到程序根目录）；打包前把 `skills\*.zip` 残留全部移出（`Move-Item skills\*.zip %TEMP%\`）；打包后 `tar -tf` 确认 zip 根含 `plugins/`、`skills/`、`DSH_Launcher.exe`、`DSH_Launcher.ico`、`LICENSE`，且**不含** `skills\*.zip`、`runtime/`、`DEV_NOTES.md`、`.gitignore`（Release 与仓库统一，仅仓库文件发货）
- [ ] 更新侧 `_normalize_update_structure()` 解压后把错位的 `dsh-*` 插件/skill 目录归位到 `plugins/` / `skills/`（正确位置已存在则跳过），并清理程序根目录的错位残留（只删已知旧目录）
- [ ] **独立更新程序**：打包 `update_agent.py` → `DSH_Update.exe`（build_exe.bat 同时构建两个 exe）；启动器下载解压新版 zip 后写 `runtime/update/update_job.json`（含 `base_dir`/`content_root`/`backup_dir`/`relaunch_mode`/`new_version`/`manual_release_url`/`manual_zip_url`），再以 `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` 启动 `DSH_Update.exe --apply <job>` 并退出本体（旧 `update_apply.bat` 方案已废弃）
- [ ] DSH_Update.exe 更新流程：自我复制到 `runtime/tmp/DSH_Update_worker.exe` 从副本运行（释放根目录更新程序文件锁，让新版更新程序也能被覆盖）→ 轮询 exe 文件锁等本体退出（不轮询 PID）→ 备份旧文件到 `runtime/update/backup/` → 覆盖（跳过 `config.json` 用户配置与 `runtime/`、`.git`）→ 重启新版
- [ ] 更新失败**弹窗给出手动下载地址**（GitHub 发布页 + 更新包 zip 直链 + 解压覆盖说明）；全程 tkinter 进度窗口（不依赖 cmd 控制台）
- [ ] `DSH_Update.exe` 内嵌 python，build_exe.bat 必须带 `VC_BINARIES` 三件套（`vcruntime140*.dll`），否则目标机报 `Failed to load Python DLL`（避坑 #67）
- [ ] 兜底路径：根目录无 `DSH_Update.exe` 时用内置 python 跑 `update_agent.py --apply <job>`（同样带自我复制迁移，worker 名 = `update_agent_worker.py`）
- [ ] 旧文件备份到 `runtime/update/backup/`，供手动回退
- [ ] 发布 Release 正文含中文时：发布脚本保持纯 ASCII，中文拆到独立 UTF-8 文件用 `[System.IO.File]::ReadAllText(路径, UTF8)` 显式读取（PS 5.1 会把无 BOM 的 UTF-8 .ps1 按 ANSI 读，正文中文变 `?`，见 DEV_NOTES 避坑 #43）；校验用 python 而非 PowerShell 中文 `-match`

## exe 打包

- [ ] `get_base_dir()` 区分 frozen 与非 frozen（`sys._MEIPASS` vs `sys.executable`）
- [ ] PyInstaller 装到 `runtime/pyinstaller`，不污染系统 Python
- [ ] 打包参数：`--onefile --windowed --noupx`
- [ ] 改过 `launcher.py` 后已重打包 exe（`build_exe.bat`）

## 数据维护

- [ ] 永久删除会话前确认服务已停止
- [ ] 三处数据一并清理：日志目录 + workspace.json 的 sessionIds/archivedSessionIds + projcache 缓存行（DSH 0.1.2-rc.1+ 分文件 sessions/session-{uuid}.json，旧版单文件 session_projcache.json）
- [ ] 日志目录删除只按 id 遍历查找，不拼接用户输入（防路径穿越）
- [ ] JSON 写回用原子写（同目录临时文件 + `os.replace`）
- [ ] 运行中的会话自动跳过
- [ ] 恢复（取消归档）只改 workspace.json 的 archivedSessionIds，不删日志与归属；GUI「会话管理」弹窗支持勾选后「恢复选中」/「删除选中」
- [ ] 会话回退（`dsh-session-rewind` 插件）：WebUI 设置页出现「会话回退」；「分析」能逐回合展示；在已完成回合「回退到此」能派生干净续接会话并自动打开；配套 `tools/rewind-session.mjs` / `apply-agentloop-guard.mjs` 幂等可反复执行

## 验证

- [ ] 服务启动后 HTTP 200，页面标题 "DeepSeek Harness"
- [ ] 用户主目录零残留（`~/.npm`、`~/.pnpm-store`、`~/.local/share/pnpm` 等均未产生）
- [ ] 插件管理 - 已安装列表正常显示
- [ ] 插件管理 - 搜索/安装/移除功能正常
- [ ] 数据维护 - 清理归档/删除会话功能正常
- [ ] `--stop` 停止后端口关闭、PID 文件删除
- [ ] 二次启动秒开（不重复下载/安装）
- [ ] 多次重启服务/启动器后，浏览器不再累积重复 WebUI 标签页（已打开的标签页关掉后重启会正常重开）