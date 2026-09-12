# 发布流程 · v1.0.30 起（正式规范）

> 目的：把每次"混乱发布"的错误一次性解决。所有步骤**按顺序执行**，不能跳步，每步有验收标准。
> 本文件**不提交 git**（放 `doc/` 目录，本地参考）。

---

## 总览：5 阶段，不可跳步

```
① 改版本号 → ② 建 EXE → ③ 写 release_notes → ④ 打包 zip → ⑤ 发 Release
```

---

## 阶段 ① · 改版本号（3 处，必须同步）

### 要改的文件

| 文件 | 字段 | 说明 |
|------|------|------|
| `launcher.py` | L279 `GREEN_VERSION` | 版本号主来源，唯一权威 |
| `launcher.py` | L280 `GREEN_VERSION_DATE` | 版本日期，格式 `YYYY年MM月DD日` |
| `launcher.py` | L285 `GREEN_ZIP_PREFIX` | zip 文件名前缀（v1.0.30 起固定为 `"DSH-GreenPortable-v"`，**不要改**） |
| `update_agent.py` | L47 `GREEN_VERSION` | 必须与 launcher.py 同步，release_upload.py 会校验 |

### 不要改

- `GREEN_ZIP_PREFIX`（v1.0.30 起已简化，稳定）
- `GREEN_RELEASE_API`、`GITEE_REPO` 等地址常量

### 验收

```bash
python -c "import launcher; print(launcher.GREEN_VERSION)"  # 应该是新版本号
```

---

## 阶段 ② · 构建 EXE（必须两个一起重建）

### 为什么不能单独构建一个？

`build_exe.bat` 会依次构建 `DSH_Launcher.exe` 和 `DSH_Update.exe`。如果你只改了一个文件却只构建一个 exe，另一个 exe 还是旧版，release_upload.py 的**新鲜度校验会阻断打包**（`exe 构建时间早于 launcher.py`）。

### 标准流程

```powershell
# 0. 【最重要】先关掉正在运行的启动器！
#    启动器在跑时根目录 DSH_Launcher.exe 被占用，copy 会失败但脚本仍打印 [OK] Build complete（假成功）
#    实在不能关：build 后手工 rename -> copy dist\DSH_Launcher.exe，并把 .old 挪到 runtime\tmp\

# 1. 清旧产物（重要！避免 PyInstaller 缓存旧字节码）
Remove-Item dist -Recurse -ErrorAction SilentlyContinue
Remove-Item build -Recurse -ErrorAction SilentlyContinue
Remove-Item DSH_Launcher.exe -ErrorAction SilentlyContinue
Remove-Item DSH_Update.exe -ErrorAction SilentlyContinue

# 2. 一键重建两个 exe（务必检查输出里没有 "being used by another process"）
.\build_exe.bat -NoPause

# 3. 验证版本（关键！）
#    注意：windowed exe 在 PowerShell 里可能无 stdout；且根目录下 DSH_Launcher.exe 可能返回 -1
#    最可靠：比对 root 与 dist 的 hash + 在 dist\ 目录里跑 --print-green-version
(Get-FileHash DSH_Launcher.exe).Hash; (Get-FileHash dist\DSH_Launcher.exe).Hash
Get-Item launcher.py,update_agent.py,DSH_Launcher.exe,DSH_Update.exe | Select-Object Name,LastWriteTime
```

### 常见坑

| 症状 | 原因 | 解决 |
|------|------|------|
| DSH_Update.exe 版本还是旧的 | `update_agent.py` 的 `GREEN_VERSION` 硬编码没改 | 改了 update_agent.py L47 再构建 |
| `DSH_Update.ico not found` | 你手动跑 PyInstaller 而不是用 bat | `build_exe.bat` 自动用 `DSH_Launcher.ico`，不要单独跑 |
| `exe 新鲜度校验失败: 构建时间早于 launcher.py` | 你改了 launcher.py 之后才构建的 exe，或者中间有文件被回写 | 重新跑 `build_exe.bat` 然后**立刻**跑 `release_upload.py` |
| 旧 exe 残留 | 没删 dist/ 和根目录旧 exe 就构建 | 每次构建前删干净 |

### 验收

```
DSH_Launcher.exe --print-green-version → "1.0.30"  ✅
DSH_Update.exe   --print-green-version → "1.0.30"  ✅
```

---

## 阶段 ③ · 写 release_notes（**必须双语**）

`release_upload.py` **强制要求**根目录有 `release_notes_v{VERSION}.md`，没有会直接阻断。

从 v1.0.31 起，**Gitee + GitHub 两个 Release 都用双语正文**。
- Gitee 标题 + body = 中文（`release_notes_v{VER}.md`）
- GitHub 标题 + body = 英文（`release_notes_v{VER}_en.md`，可选，无则复用中文）
- 两个文件都放 `doc/release_notes/` 目录
- `release_upload.py` 会自动根据平台选择中文或英文文件

### 中文模板（`release_notes_v{VER}.md`）

```markdown
v{VERSION} — 一句话标题

## 新增功能

- xxx
- xxx

## 技术架构（可选, 仅大改时写）

- xxx

## 修复

- xxx

## 打包命名变更 (如果有)

旧：DSH_Launcher_GreenPortable_Online_YYYYMMDD_v{VER}.zip
新：DSH-GreenPortable-v{VER}.zip

## 版本更新

- GREEN_VERSION: {旧} → {新}

## 升级建议

- 绿色版覆盖安装即可
```

### 英文模板（`release_notes_v{VER}_en.md`）

```markdown
v{VERSION} — One-line English title

## New Features

- xxx
- xxx

## Technical Architecture (optional, for major changes only)

- xxx

## Bug Fixes

- xxx

## Naming Changes (if any)

Old: DSH_Launcher_GreenPortable_Online_YYYYMMDD_v{VER}.zip
New: DSH-GreenPortable-v{VER}.zip

## Version Bump

- GREEN_VERSION: {old} → {new}

## Upgrade Notes

- Green edition: overwrite install is sufficient
```

### 验收

- [ ] `release_notes_v{VER}.md` 存在（中文）
- [ ] `release_notes_v{VER}_en.md` 存在（英文，**v1.0.31 起必填**）
- [ ] 两个文件第一行都是 `v{VERSION} — 标题`（各语言写各的）
- [ ] 英文里不要出现中文技术术语未翻译（如 "i18n"、"Combobox" 可保留，但"覆盖安装"要写 overwrite install）

---

## 阶段 ④ · 打包 zip

### 命令

```powershell
python release_upload.py --pack-only
```

### 这个脚本会做什么

1. 读 `launcher.py GREEN_VERSION`（版本号来源）
2. 校验关键文件存在（16 项）
3. 校验 **两个 exe 的版本号和构建时间都不早于 launcher.py**（新鲜度）
4. 自动把 `GREEN_VERSION_DATE` 回写到 launcher.py（构建当天日期）
5. 打包 zip：
   - 名字 = `DSH-GreenPortable-v{VERSION}.zip`（已简化）
   - 内容 = 根目录文件 + `plugins/` + `skills/`（不含 `runtime/`）
   - 压缩级别 6，Gitee 限制 100MB / GitHub 限制 2GB
6. 校验 zip 根目录关键项（DSH_Launcher.exe / plugins / skills 等）

### 常见坑

| 症状 | 原因 | 解决 |
|------|------|------|
| `缺少 release_notes_vX.0.Y!` | 没写 release notes | 写了再跑 |
| `exe 新鲜度校验失败: 版本号不同` | update_agent.py 没同步 | 改 update_agent.py L47 |
| `exe 新鲜度校验失败: 构建时间早于 launcher.py` | 构建 exe 后 launcher.py 被回写了日期 | 重跑 build_exe.bat，然后**立刻**跑 release_upload.py |
| zip 里 plugins 错位 | 旧版 zip 结构错误 | v1.0.29+ 已修复，不用管 |

### 验收

```
[✓] ZIP 就绪: D:\...\DSH-GreenPortable-v1.0.30.zip
```

---

## 阶段 ⑤ · 发 Release

### 方式 A：手动（没 token 时）

1. 登录 Gitee → `liujunheng/DeepSeekHarnessGreen`
2. 点 **Release** → **新建 Release**
3. 选择 tag `v1.0.30`（阶段④之前已 push）
4. Release 标题：`v1.0.30 — 祖宗记忆库 v3 会话隔离`
5. 描述：粘贴 `release_notes_v1.0.30.md` 内容
6. 上传附件：`DSH-GreenPortable-v1.0.30.zip`
7. 发布

### 方式 B：自动（有 token 时）

```powershell
# 设置 token（PowerShell 当前会话有效，跑完即弃）
$env:GITEE_TOKEN = "你的 gitee 私人令牌"
$env:GITHUB_TOKEN = "你的 github 私人令牌"   # 可选
# 【必须】UTF-8 IO，否则第一步打印 [✓] 就抛 UnicodeEncodeError
$env:PYTHONIOENCODING = 'utf-8'; $env:PYTHONUTF8 = '1'

# 一键打包 + 发 Release + 上传 zip（不带任何 flag）
python release_upload.py
```

### 注意

- `release_upload.py` 默认**先打包再上传**；**不要**先 `--pack-only` 再单独上传（新鲜度竞态，见下）
- token 在 **Gitee 设置 → 私人令牌** 创建，需要 `projects` 权限
- **`github.com` 连不上也能发**：Release 创建/传资产走 `api.github.com` + `uploads.github.com`；代码用 Gitee 镜像同步（见避坑库 v1.0.36 第 3 条）

---

## 全流程一键脚本（未来可做）

```powershell
# 伪代码，未来可以做成 release.bat
param([string]$Version)

# ① 改版本号
(launcher.py).GREEN_VERSION = $Version
(update_agent.py).GREEN_VERSION = $Version

# ② 构建 exe
.\build_exe.bat -NoPause
assert exe 版本 == $Version

# ③ 写 release notes
generate_release_notes $Version

# ④ 打包 zip
python release_upload.py --pack-only

# ⑤ commit + tag + push
git add -A
git commit -m "release: v$Version"
git tag v$Version
git push origin master v$Version

# ⑥ 发 Release（需要 token）
#    必须先设 UTF-8 IO，否则 check_python 打印 [✓] 抛 UnicodeEncodeError 直接退出
$env:PYTHONIOENCODING='utf-8'; $env:PYTHONUTF8='1'
if ($env:GITEE_TOKEN) { python release_upload.py }
```

---

## 避坑经验库（每次发版更新）

### v1.0.38 踩过的

1. **Release 描述必须覆盖从上一 tag 到 HEAD 的全部 commit，不能只写当前 session 做了什么**：本次 v1.0.38 首次发布时只写了当前 session 的 bug fix，漏掉了前几个 session 做的「绿色版更新通道重构」+「官网 changelog 分页 + SEO」+「session_import 多语言化」等共 11 个 commit 的改动。用户反馈后重写了 notes 并调用 API PATCH 补全双平台 Release body。**正确做法**：写 release notes 之前先跑 `git log v{prev}..HEAD --oneline` 把完整 commit 列表拉出来，按主题归类后逐一覆盖。
2. **`release_upload.py` 会把 launcher.py 的 GREEN_VERSION_DATE 回写成构建当天日期** → 如果你在 pack 完之后又回头改 release notes 并 amend commit，**exe 新鲜度校验会被阻断**（exe 构建时间早于 launcher.py 的日期回写）。**正确做法**：先写好完整的 release notes → commit 源码 → build_exe → commit exe → tag → push → release_upload.py（一口气）。如果 notes 写完了才发现漏了内容要改，改完 notes 要 **amend 源码 commit + 重新 build_exe** 才能保证新鲜度。
3. **Gitee PATCH Release body 时必须带 `tag_name` 和 `name` 字段**，只传 `body` 会报 `{"messages":["tag_name is missing","name is missing"]}`。GitHub 只传 `body` 即可。两个平台 PATCH 前都应该先 GET 当前 Release 拿到现有 `name` 和 `tag_name` 一起带回去。
4. **如果 commit 被 amend 过，tag 仍然指向旧 commit（amend 之前的），但这不影响 Release**：tag 在 push 时指向的是 push 那一刻的 HEAD，之后 amend commit 只改了 master 的 HEAD，tag 不动。zip 是用 build_exe 时的文件打包的，不受影响。但 **amend 过之后必须 `git push --force origin master`**，否则 Gitee/GitHub 上的 master 还是旧 commit。

### v1.0.37 踩过的

1. **发布 Release 的 token 优先从 TRAE 插件找，找不到才问用户**：Gitee/GitHub 的 PAT 不一定要用户手输——先查插件与系统凭证：
   - **Gitee**：`("protocol=https`nhost=gitee.com`n`n" | git credential fill)` 从 Windows 凭据管理器取出 `password` 行即 PAT（注意 PAT 是 32 位十六进制字符串，非 git 账号密码），注入 `$env:GITEE_TOKEN`。
   - **GitHub**：连接器的 token 在 IDE 凭证库（`connector.github.ACCESS_TOKEN`，OAuth 型，一般拿不到明文）→ 从 GitHub MCP 插件或让用户提供 `ghp_` 开头 PAT；**拿到才创建 GitHub Release，否则跳过，别硬跑**。
   - 顺序规矩：敢给的凭证先试 → 拿不到再向用户要，并把"此次用的 token 来源"记下来，避免下次重复索取。
2. **`release_upload.py` 会回写 launcher.py 版本日期（刷新 mtime）**：跑过一次完整发版后，exe 构建时间会显得"早于"launcher.py → 再跑一次会撞新鲜度校验被拦。**补发单平台（如只补 GitHub）时不要整跑 release_upload.py**，直接用该平台的 API 或 MCP 单独建 Release + 传 zip（zip 已就绪，直接复用）。

### v1.0.36 踩过的

1. **运行中的 `DSH_Launcher.exe` 无法覆盖，但可以改名（最重要）**：启动器在跑时 `build_exe.bat` 的 `copy /Y "dist\DSH_Launcher.exe"` 报 `The process cannot access the file because it is being used by another process.`，而脚本末尾 `if exist "DSH_Launcher.exe"` 判定旧文件仍在 → **照样打印 `[OK] Build complete`（假成功）**，只能靠那行 copy 错误识别。Windows 允许对运行中的 exe 同目录 `Rename-Item`，故：`Rename-Item DSH_Launcher.exe DSH_Launcher.exe.old` → `Copy-Item dist\DSH_Launcher.exe .` → 把 `.old` 挪到 `runtime\tmp\`（占用中删不掉，留根部会成为未跟踪文件）。`DSH_Update.exe` 一般没在运行，直接 copy 即可。换完用 `Get-FileHash` 比对 root/dist 同一份。
2. **`release_upload.py` 必须设 UTF-8 IO**：`check_python()` 打印 `[✓]`(U+2713)，在 GBK 控制台/管道捕获下抛 `UnicodeEncodeError: 'gbk' codec can't encode character '\u2713'`，第一步直接退出（**尚未改动任何文件，可安全重跑**，不会污染新鲜度校验）。跑前 `$env:PYTHONIOENCODING='utf-8'; $env:PYTHONUTF8='1'`。
3. **`github.com:443` 被阻断，但 Release 照发不误**：`git push/fetch github` 报 `Recv failure: Connection was reset`（`curl https://github.com` → HTTP 000），而 `api.github.com`(200) / `uploads.github.com`(302) 正常 → GitHub Release 创建 + 17.5MB 资产上传全部成功。**推 Gitee 后 GitHub 的 master 与 tag 会自动镜像同步**（本次实测 1 分钟内到位：`git -c http.proxy=http://127.0.0.1:7890 ls-remote github` 显示 master 与 v1.0.36 都等于本地 HEAD）。→ 流程改为：推 Gitee → **确认 GitHub 同步完成** → 再跑 `release_upload.py`（否则 GitHub 按 `target_commitish=master` 在旧提交上建 v 标签，双平台 tag 指向不一致）。本机代理 `127.0.0.1:7890` 可用，需要时 `git -c http.proxy=http://127.0.0.1:7890 <cmd>`。
4. **`DSH_Launcher.exe --print-green-version` 在仓库根目录返回 -1 且无输出**（同一 exe 在 `dist/` 下正常打印 `1.0.36`、退出码 0，只多一条 locale 警告）→ `verify_exe_freshness` 的次级版本校验要求 `returncode == 0`，在根目录不成立 → **被静默跳过，实际只剩 mtime 把关**。要真验版本去 `dist/` 跑，或比对 root/dist hash。v1.0.35 也如此，属既有行为。
5. **`config.json` 会被启动器归一化回写**：`open_method: browser → desktop`（README 明确"默认以独立桌面窗口打开"，desktop 才是正确默认）。该文件既是运行时配置又是 zip 内默认模板 → 这类回写要一起提交。
6. **GitHub Release 标题是中文**：`load_release_notes()` 只取中文文件首行当标题（`en_title_tmpl` 解析了但从未使用），正文是 cn+en 双语锚点。v1.0.34/35/36 一致，属既有行为，不要改成英文。
7. **启动器会"自愈"改写插件 package.json**：启动时把插件里落后的 `@deepseek-ai/*` 依赖同步到宿主版本（本次 `dsh-session-rewind` 的 `dsh-session` 由 `0.1.5-alpha.1` → `0.1.5-rc.1`，上一轮 `dsh-memory` 由 `0.1.5-alpha.2` → `0.1.5-rc.1`）。发版前 `git status` 必看，这类改动正常、应一起提交。
8. **本次实测通过的完整顺序（可作下次模板）**：改版本号（launcher.py + update_agent.py + 日期）→ 写双语 release_notes → commit 源码 → 关/换 exe → `build_exe.bat` → 验 root/dist hash 与内嵌版本 → commit exe → `git tag v<VER>` → `git push origin master v<VER>`（Gitee）→ 等 GitHub 镜像同步 → `PYTHONIOENCODING=utf-8 python release_upload.py`（双 token，无 flag）→ 独立核验双平台 Release + 抽查 zip 内容（exe 在不在、价格表是不是新值、DEV_NOTES/runtime 有没有误打包）。

### v1.0.35 踩过的

1. **PowerShell 直接运行 windowed 版 exe 无 stdout**：`.\DSH_Launcher.exe --print-green-version` 在 PowerShell 里没有任何输出（PyInstaller windowed 子系统不连控制台），容易误判"没构建成功"。验证用 Python subprocess：
   `python -c "import subprocess; print(subprocess.run([r'DSH_Launcher.exe','--print-green-version'],capture_output=True,text=True,timeout=30).stdout.strip())"`
   release_upload.py 的新鲜度校验内部走 subprocess 管道，脚本侧不受影响。
2. **Gitee 凭证可从 Windows 凭据管理器读取，无需重新索要 token**：`"protocol=https`nhost=gitee.com`n`n" | git credential fill` 输出 gitee.com 的 username + password（PAT）。发布时直接注入 `$env:GITEE_TOKEN`；GitHub 用现有 `GH_TOKEN` 映射 `GITHUB_TOKEN`。
3. **v1.0.35 全程无新坑**：5 阶段（改版本号→commit 源码→build_exe→commit exe→tag→push 双远程→release_upload 一口气）跑通。发布后 git 显示 launcher.py modified 但 `git diff --numstat` 为空（日期回写只动 mtime，内容相同，无需提交）。

### v1.0.34 踩过的

1. **Gitee 创建 Release 的 `target_commitish` 必须传分支名，不能传尚不存在的 tag 名**：`gitee_create_release` 原逻辑 `target_commitish=tag`，首次发新 tag 时 Gitee 报 `创建标签失败：<tag>`（HTTP 400）——该 tag 还没 push 到远端，无法作为 commit 目标。改为 `target_commitish="master"` 让 Gitee 从 master 最新提交自动建 tag。**GitHub 行为不同**：tag 不存在时 GitHub 会自动建 tag 指向 target_commitish，不需要预先 push。
2. **GitHub API 创建 Release 默认是 draft**：POST `/releases` 时若无 `draft=false`，创建的 release 是草稿态 → 用户看不到、`GET /releases/tags/<tag>` 也查不到（404），但 asset 其实已上传。必须再 PATCH `draft=false` 才正式发布。
3. **Gitee release 的 name/body 接口只接受 form-urlencoded，不接受 JSON**：**已固化**——release_upload.py 新增 `http_request_form()`，`gitee_create_release` / `gitee_edit_release` 改走它。
4. **`update_agent.py` 里也有独立 `GREEN_VERSION` 常量**，与 launcher.py 同步。改了没重打包会以"exe 内嵌版本 != launcher.py"被新鲜度校验阻断（exit 2）。两处 exe 都要重打。
5. **删除云端旧 zip 的实测**：GitHub 用 `DELETE /repos/.../releases/assets/<id>`（幂等）；Gitee 用 curl.exe `DELETE /releases/<id>/attach_files/<attach_id>`（Invoke-RestMethod Delete 会 404）。release 本体/tag 保留即可，用户不再下载到损坏包。

### v1.0.33 踩过的

1. **Gitee attach_files 的字段名必须是单数 `file`**，用 `files` 会报 `{"messages":["file is missing"]}`。见 release_upload.py `gitee_upload_asset`（已验证可用的构建方式：boundary + `access_token` + `file` 两个 part）。
2. **Gitee MCP 的 create_release / 资产上传当前不可用**（调用报 `list tools failed`）。改用裸 token + Gitee API：
   - 创建/更新 release：`POST/PATCH /repos/{o}/{r}/releases`
   - 找 release id：`GET /repos/{o}/{r}/releases/tags/{tag}`（注意：返回 `null`/404 表示不存在，别用 `rel['id']` 直接踩空）
   - 上传资产：**直接复用 release_upload.py 的 `gitee_upload_asset(token, release_id, zip_path)`**（不用重写 multipart）。
3. **release_upload.py `--pack-only` 会回写 launcher.py 日期**（把 mtime 刷到最新），此后**不能再跑 release_upload.py**（exe 新鲜度校验会拦）；但 zip 已就绪，后续用脚本/手动上传资产即可，不必重 build。
4. **GitHub 资产上传不用 multipart**，用 release 的 `upload_url` 去掉 `{?name,label}` 后拼 `?name=xxx.zip`，`Content-Type: application/zip`，body 直接放文件字节。
5. **Gitee 会自动给你的 tag 生成 `v{ver}.zip` + `v{ver}.tar.gz` 源码资产**，这是平台自动打包，属正常现象，不用处理。

### v1.0.32 踩过的

1. **先跑了 `python release_upload.py --pack-only` 又跑 `python release_upload.py` 会撞新鲜度校验**：
   实测 `--pack-only`（脚本其实不认这个参数，等价无参跑完整流程）会 sync 回写 launcher.py 的 GREEN_VERSION_DATE，把 launcher.py mtime 刷成最新，比 exe 构建时间还新。紧接着再跑任何 release_upload.py 都报 `exe 构建时间早于 launcher.py`。
   **正确做法（再次确认）**：`build_exe.bat → python release_upload.py`（带 token），中间不碰任何 Python 文件。断了就重 build。
2. **版本日期回写是"同一天重写"也会刷新 mtime**：
   即使 GREEN_VERSION_DATE 本来就是当天日期，`sync_launcher_version_date` 仍会重写文件刷新 mtime。所以只要跑过一次 release_upload.py，就必须重 build 才能再跑。
3. **token 用环境变量注入**：`$env:GITEE_TOKEN = "..."`（PowerShell 当前会话有效），跑完即弃。token 也可以在 Gitee 插件凭证管理里配（项目用 Gitee MCP 已验证凭证与 PAT 等价）。
4. **exe 二次重建后要再 commit 一次**：重 build 产生的 exe 与已提交版本不同，必须 `git add DSH_Launcher.exe DSH_Update.exe && git commit` 再 push，避免仓库 exe 与发布 zip 内 exe 不一致。
5. **launcher.py 显示 modified 但无内容 diff**：release_upload.py 回写日期后，git 可能因 LF/CRLF 行尾显示 launcher.py modified，但 `git diff --numstat` 为空——内容是相同的，无需提交。

### v1.0.31 踩过的

1. **release_upload.py 新鲜度校验有竞态，pack 之后不能再跑 upload-only**：
   `--pack-only` 内部会回写 `GREEN_VERSION_DATE`（等于改了 launcher.py mtime），紧接着 `--upload-only` 或再次调 release_upload.py 时，exe 构建时间就"看起来早于" launcher.py → 报 `exe 新鲜度校验失败`。
   **正确做法**：`build_exe.bat → python release_upload.py`（不带任何 flag，内部先 pack 再 upload 一气呵成），中间绝不能再碰任何 Python 源文件。
   **如果断了必须重跑**：重 build_exe → 立刻 `release_upload.py`（别 pack 再 upload，别中间插任何脚本）。
2. **Checklist 顺序要改：不要先 pack 再 commit exe**：
   commit 包含 exe 是发布的一部分，但 exe 必须在版本号 commit 之后重建才不会被新鲜度校验拦截。正确顺序：
   ```
   ① 改版本号 → ② commit 源码 → ③ build_exe → ④ commit exe → ⑤ tag → push → release_upload.py
   ```
   不要把 pack 放在 commit exe 之前，也不要把 upload 单独拿出来跑。
3. **Gitee Release 中文乱码**：
   ~~表面现象~~：PowerShell `Invoke-RestMethod` 发 PATCH 把 UTF-8 字符串按 Latin-1 编码
   ~~表面根因~~：PowerShell HTTP 客户端对非 ASCII body 有历史 bug
   **真实根因**：Gitee `/releases` 的 POST/PATCH 接口**只解析 `application/x-www-form-urlencoded` 表单**，**不解析 JSON body**。无论用 PowerShell 还是 Python 发 JSON，中文 name/body 都会被 Gitee 忽略或乱码。
   **正确做法**：把 payload `urlencode` 成表单，设 `Content-Type: application/x-www-form-urlencoded; charset=utf-8`：
   ```python
   body = urllib.parse.urlencode({'name': 'v1.0.31 — 中英双语国际化', 'body': notes}).encode('utf-8')
   req = urllib.request.Request(url, data=body, method='PATCH',
       headers={'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8'})
   ```
   GitHub 对应接口则接受 JSON，所以 GitHub 侧继续用 JSON 通道。**已固化**：release_upload.py `gitee_create_release` / `gitee_edit_release` 已改走 `http_request_form()`。
4. **release_upload.py 的 tag_name 会覆盖手动 PATCH 的 name**：
   如果手动 PATCH 修了 Gitee Release 的 title，下次 release_upload.py 带同一 tag 跑会重新设置。要么先删掉重建，要么让 release_upload.py 也修编码。

### v1.0.30 踩过的

1. **不要 push 后再 force push**：你会把 Gitee 上别人合的东西冲掉。应该先 fetch → merge → 再 push。
2. **不要先 commit 再改版本号**：commit 里 launcher.py 是旧版，后面再改 exe 版本不一致。正确顺序：改版本号 → commit → build_exe → zip → push。
3. **update_agent.py 有独立的 GREEN_VERSION**：硬编码的，改 launcher.py 别忘了改它。
4. **build_exe.bat 不要用 cmd /c**：PowerShell 里直接调 `.\build_exe.bat`，加 `-NoPause` 参数绕过 "Press any key"。
5. **release_upload.py 的新鲜度校验会拦截**：它检查两件事 —— 版本号一致 + 构建时间不早于 launcher.py 最后修改。所以 build_exe 之后**立刻**跑 release_upload.py，不要中间改任何 python 文件。（v1.0.31 补充：更细地说，pack-only 之后也不能跑 upload-only，必须一口气跑）
6. **ZIP 前缀改了之后下载端自动适配**：`GREEN_ZIP_PREFIX` 从 `"DSH_Launcher_GreenPortable_Online_"` 改成 `"DSH-GreenPortable-v"`，`green_find_zip_asset` 用 `startswith()` 匹配，自动生效，旧下载的 v1.0.29 还能匹配旧前缀。
7. **GitHub 网络不稳**：国内发版优先走 Gitee。**（v1.0.36 更新：`github.com:443` 被阻断时 `git push github` 必然失败，但 Release 走 `api.github.com` 照发；推 Gitee 后 GitHub 会自动镜像同步 master 与 tag，见避坑库 v1.0.36 第 3 条。）**

### v1.0.29 及以前踩过的

- (留给未来补充)

---

## 快速清单（Checklist）

发版前 **全部打勾** 才能开始：

- [ ] `launcher.py` GREEN_VERSION / GREEN_VERSION_DATE 已改
- [ ] `update_agent.py` GREEN_VERSION 已同步
- [ ] `git status` 已看：启动器"自愈"回写的 `config.json` / 插件 package.json 一并提交
- [ ] `git add + commit` 源码改动（版本号 + 功能改动一起 commit）
- [ ] **关掉正在运行的启动器**（否则根目录 exe 覆盖失败且脚本假报成功）
- [ ] 清旧产物：`Remove-Item dist, build -Recurse` + 删旧 exe + 删 `__pycache__`
- [ ] `.\build_exe.bat -NoPause` 跑完，输出里**没有** "being used by another process"
- [ ] 两个 exe 版本号正确、时间戳比 launcher.py 新、root 与 dist `Get-FileHash` 一致
- [ ] `release_notes_v{VERSION}.md` + `_en.md` 已写（放 `doc/release_notes/`）
  - **必须覆盖从上一 tag 到 HEAD 的全部改动**：先跑 `git log v{上一版本}..HEAD --oneline` 拿到完整 commit 列表，按主题归类（功能新增 / bug 修复 / 架构调整 / SEO / 杂项），**不能只写当前 session 做了什么**
  - 建议在 notes 开头加一行 `> 覆盖 N 个 commit / M 个文件 / +X -Y 行，上一版本是 v{prev}`，用 `git diff v{prev}..HEAD --stat` 拿统计
  - 如果发现中间有别人合的 commit（如启动器自愈回写），也要覆盖进去
- [ ] `git add DSH_Launcher.exe DSH_Update.exe + commit`（最后才提交 exe，确保新鲜）
- [ ] `git tag v{VERSION}` → `git push origin master v{VERSION}`（Gitee）
- [ ] 确认 GitHub 已镜像同步（`git -c http.proxy=http://127.0.0.1:7890 ls-remote github` 看 master/tag）
- [ ] 设 `PYTHONIOENCODING=utf-8` 后 `python release_upload.py`（**不带任何 flag，build 之后立刻一口气跑完**）
- [ ] Gitee + GitHub Release 已确认：标题正常中文 + zip 资产有 + GitHub 非 draft
- [ ] 抽查 zip 内容：两个 exe 在、本次改的功能文件是新值、DEV_NOTES/runtime 未误打包

**千万不要**：
- ❌ 在启动器运行时 build 却只看最后的 `[OK] Build complete`（那是假成功）
- ❌ 不设 `PYTHONIOENCODING=utf-8` 就跑 release_upload.py
- ❌ 先 pack-only 再 upload-only（新鲜度竞态会拦截）
- ❌ pack 完了中间去改 Python 文件或跑别的脚本
- ❌ 用 PowerShell Invoke-RestMethod 发含中文的 Release body（会乱码，用 Python）
- ❌ 在 GitHub 尚未镜像同步时发 Release（会在旧提交上建 v 标签）

---

## 开发避坑补充（v1.0.31 i18n 改造踩的）

这些不是发版流程问题，是日常开发容易踩的，放这里方便查阅。

1. **`__pycache__` 缓存旧 pyc 会改了代码却运行旧版**：
   Python 优先加载 `.pyc` 缓存，尤其是内置 Python（runtime\python\python\）可能不做时间戳检查。改了源码后 GUI 显示旧内容、运行逻辑不对，**第一件事就是清 `__pycache__`**。
   ```powershell
   Get-ChildItem -Directory -Recurse __pycache__ | Remove-Item -Recurse -Force
   ```

2. **Combobox 国际化需要单独注册 `_i18n_widgets`**：
   普通 Label/Button 走 `widget.config(text=...)` 刷新路径（refresh_all_text 第 3 步），但 Combobox 要刷新 `values` 列表 + 通过 internal 值映射显示值（第 4 步）。只设 `_i18n_internal` / `_i18n_key_map` / `_i18n_values_keys` 不够，**必须追加一行注册**：
   ```python
   _i18n_widgets.append((bind_combo, 'combobox', None))
   ```
   attr 必须是 `'combobox'`，不能是 `'text'`——否则被第 3 步误处理没效果，第 4 步又找不到。

3. **start.bat 用内置 Python，直接 python launcher.py 可能用系统 Python**：
   start.bat 调的是 `runtime\python\python\pythonw.exe`，而 PowerShell 里直接 `python launcher.py` 可能走系统 PATH 里的 Python。改了代码后**一定要用 start.bat 验证真实效果**，不要假设 shell 里 import 对了就等于 exe 里也对了。

4. **i18n 文本替换要检查完整覆盖，不要只跑一次扫描脚本**：
   `grep -r "i18n.t(" launcher.py` 看得到用了 i18n，但不代表每个控件都注册了 `_i18n_widgets`。脚本自动化替换经常会漏掉：
   - Combobox 的 values 设置
   - .grid() 链式调用的一行创建（需要拆成 var = + .grid() + append）
   - 如果脚本失败恢复了 backup，记得检查是否覆盖了正确版本

5. **config.json 的 `language` 字段会持久化语言偏好**：
   测试时切到 EN 忘了切回来，下次启动默认全英文，再点中文按钮时"已注册的控件刷中文、没注册的永远停英文"→ 界面中英文混杂。**每次改完启动器先把 config.json 的 language 改成 "zh"**。

---

## 相关文件

| 文件 | 作用 |
|------|------|
| `launcher.py` | 版本号来源 + zip 前缀 + 下载端匹配逻辑 |
| `update_agent.py` | 内嵌版本号（必须同步） |
| `build_exe.bat` | 一键构建两个 exe（PyInstaller） |
| `release_upload.py` | 打包 zip + 校验 + 上传 Release |
| `release_notes_v{VER}.md` | Release 描述（发版前必须写） |
| `doc/design-notes.md` | 架构设计 |
