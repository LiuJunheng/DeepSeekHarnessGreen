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
- [ ] 端口监听用 `grep -w 3080` 排查（`grep 3080` 会误匹配 `13080`）

## 更新

- [ ] `dsh_latest_version()` 是只读查询（`npm view`），失败返回 `None` 而非抛错
- [ ] `update_dsh()` 顺序：查询 → 备份旧版到 `runtime/dsh-backup-<版本>` → 备份成功后才强制重装
- [ ] 备份同名加时间戳后缀防覆盖
- [ ] 安装代码抽成 `install_dsh()`，首装与更新共用

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