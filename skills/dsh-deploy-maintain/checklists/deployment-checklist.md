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
- [ ] 端口监听用 `grep -w 3080` 排查（`grep 3080` 会误匹配 `13080`）

## 更新

- [ ] `dsh_latest_version()` 是只读查询（`npm view`），失败返回 `None` 而非抛错
- [ ] `update_dsh()` 顺序：查询 → 备份旧版到 `runtime/dsh-backup-<版本>` → 备份成功后才强制重装
- [ ] 备份同名加时间戳后缀防覆盖
- [ ] 安装代码抽成 `install_dsh()`，首装与更新共用

## 绿色版自更新（双通道）

- [ ] `GREEN_VERSION` 常量与 GitHub Release tag 一致（tag 带 `v` 前缀，本地去前缀比较）
- [ ] Release 资产命名 `DSH_Launcher_GreenPortable_Online_<日期>_v<版本>.zip`（`green_find_zip_asset` 按此前缀匹配）
- [ ] 官方 API 查询失败降级国内镜像（`mirror.nju.edu.cn/github-release/<owner>/<repo>/latest`）
- [ ] 下载后校验文件大小，不符即删并报错
- [ ] zip 安全解压（逐成员 normpath 拒绝 `..`/绝对路径，防 zip-slip）+ 内容根目录检测（兼容带/不带外层文件夹）
- [ ] 覆盖安装 bat 跳过 `config.json`（用户配置）与 `runtime/`、`.git`（用户数据/仓库）
- [ ] update_apply.bat 用「exe 文件锁轮询」等待启动器退出（不轮询 PID，防 PID 复用死循环）；DETACHED 模式下用 `ping -n` 睡眠替代 `timeout`，`goto` 只用顶层标签，`start` 前加 `if exist` 判断
- [ ] bat 全文纯 ASCII + CRLF，避免 Windows cmd 编码问题
- [ ] 旧文件备份到 `runtime/update/backup/`，供手动回退
- [ ] 发布 Release 正文含中文时：发布脚本保持纯 ASCII，中文拆到独立 UTF-8 文件用 `[System.IO.File]::ReadAllText(路径, UTF8)` 显式读取（PS 5.1 会把无 BOM 的 UTF-8 .ps1 按 ANSI 读，正文中文变 `?`，见 DEV_NOTES 避坑 #43）；校验用 python 而非 PowerShell 中文 `-match`

## exe 打包

- [ ] `get_base_dir()` 区分 frozen 与非 frozen（`sys._MEIPASS` vs `sys.executable`）
- [ ] PyInstaller 装到 `runtime/pyinstaller`，不污染系统 Python
- [ ] 打包参数：`--onefile --windowed --noupx`
- [ ] 改过 `launcher.py` 后已重打包 exe（`build_exe.bat`）

## 数据维护

- [ ] 永久删除会话前确认服务已停止
- [ ] 三处数据一并清理：日志目录 + workspace.json 的 sessionIds/archivedSessionIds + session_projcache.json 缓存行
- [ ] 日志目录删除只按 id 遍历查找，不拼接用户输入（防路径穿越）
- [ ] JSON 写回用原子写（同目录临时文件 + `os.replace`）
- [ ] 运行中的会话自动跳过

## 验证

- [ ] 服务启动后 HTTP 200，页面标题 "DeepSeek Harness"
- [ ] 用户主目录零残留（`~/.npm`、`~/.pnpm-store`、`~/.local/share/pnpm` 等均未产生）
- [ ] 插件管理 - 已安装列表正常显示
- [ ] 插件管理 - 搜索/安装/移除功能正常
- [ ] 数据维护 - 清理归档/删除会话功能正常
- [ ] `--stop` 停止后端口关闭、PID 文件删除
- [ ] 二次启动秒开（不重复下载/安装）
- [ ] 多次重启服务/启动器后，浏览器不再累积重复 WebUI 标签页（已打开的标签页关掉后重启会正常重开）