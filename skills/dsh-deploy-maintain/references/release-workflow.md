# DSH 绿色版发版流程（可套用模板）

> 本文从项目 `doc/release-workflow.md` 脱敏并通用化而来。Skill 内自包含引用，不再依赖 `doc/`。
> 适用于：任何"绿色便携整合版"（启动器 exe + 数据目录 + Release 分发 zip）的双平台发版。
> 原则：**顺序执行、不可跳步、每步有验收标准**。下面 `<VER>` 均为版本号占位（如 `1.0.35`）。
> **角色分工**：本文 = 操作者流程指南（怎么做）；若需看发版脚本 `release_upload.py` 的实现代码/配置区，见 `templates/release-upload-reference.py`（互相补充，不重复）。

---

## 总览：5 阶段，不可跳步

```
① 改版本号 → ② 写 release_notes → ③ 构建 exe → ④ commit exe + tag + push 双远程 → ⑤ 打包 + 发布 Release
```

---

## 阶段① · 改版本号（多处，必须同步）

| 文件 | 字段 | 说明 |
|------|------|------|
| `launcher.py` | `GREEN_VERSION` | 版本号主来源，唯一权威 |
| `launcher.py` | `GREEN_VERSION_DATE` | 版本日期，格式 `YYYY年MM月DD日` |
| `launcher.py` | `GREEN_ZIP_PREFIX` | zip 文件名前缀，一旦固定后 **不要改**（改会破坏下载端旧匹配） |
| `update_agent.py` | `GREEN_VERSION` | 必须与 launcher.py 同步（发版脚本新鲜度校验会拦截不一致） |

### 版本日期铁律

`GREEN_VERSION_DATE` **必须是制作当天**，即使一天发两个版本也不预写未来日期（SEO 同款纪律）。发版脚本可能按构建当天自动回写该字段。

### 验收

```bash
python -c "import launcher; print(launcher.GREEN_VERSION)"   # 应为新版本号
```

---

## 阶段② · 写 release_notes（双语）

发版脚本强制要求存在 `release_notes_v<VER>.md`（中文）+ `release_notes_v<VER>_en.md`（英文），缺中文会直接阻断。

- 两个文件首行都是 `v<VER> — 标题`（各语言写各语言）
- 章节目录：`## 新增功能` / `## 修复` / `## 技术架构`（仅大改）/ `## 版本更新` / `## 升级建议`
- 英文**禁止机翻**，必须是自然人类英文；技术词如 i18n / overwrite install 保留
- 发版脚本自动把中英拼接成一条双语正文（带锚点跳转），双平台共用

---

## 阶段③ · 构建 EXE（两个必须一起重建）

**为什么不能单独构建一个**：`DSH_Launcher.exe` 和 `DSH_Update.exe` 必须同时重建。若只建一个，另一个还是旧版，发版脚本的新鲜度校验会拦截打包（`exe 构建时间早于 launcher.py`）。

### 构建前必须先解冻根目录 exe（2026-09-10 实测）

**启动器正在运行时，根目录的 `DSH_Launcher.exe` 是当前进程映像：Windows 禁止 delete / overwrite，但允许同目录 rename。** 后果与处置：

- `build_exe.bat` 的 `copy /Y dist\DSH_Launcher.exe .` 会失败并打印
  `The process cannot access the file because it is being used by another process.`
- **但脚本末尾用 `if exist DSH_Launcher.exe` 判定，旧文件仍在 → 照样打印 `[OK] Build complete`（假成功）**。必须盯这一行错误，别只看最后的 OK。
- 处置（两条路任选）：
  1. **最省事**：发版前让用户关掉启动器，再 `build_exe.bat` → `release_upload.py`。
  2. **不想关**：build 完成后手工换文件——`Rename-Item DSH_Launcher.exe DSH_Launcher.exe.old` → `Copy-Item dist\DSH_Launcher.exe .` → 把 `.old` **挪出仓库根目录**（如 `runtime\tmp\`）。运行中的映像仍被占用**删不掉**，留在根目录会变成未跟踪文件、可能被误提交；挪到 gitignore 目录最干净。`DSH_Update.exe` 通常没在运行，直接 copy 即可。
- 换完后用 **root 与 dist 的 `Get-FileHash` 比对**确认是同一份新 exe。

### 标准流程

```powershell
# 1. 清旧产物（避免 PyInstaller 缓存旧字节码）
Remove-Item dist -Recurse -ErrorAction SilentlyContinue
Remove-Item build -Recurse -ErrorAction SilentlyContinue
Remove-Item DSH_Launcher.exe -ErrorAction SilentlyContinue
Remove-Item DSH_Update.exe -ErrorAction SilentlyContinue

# 2. 一键重建两个 exe
.\build_exe.bat -NoPause

# 3. 验证版本（关键）——windowed 版 exe 直接跑无 stdout，用 Python subprocess 验证
python -c "import subprocess; print(subprocess.run([r'DSH_Launcher.exe','--print-green-version'],capture_output=True,text=True,timeout=30).stdout.strip())"
python -c "import subprocess; print(subprocess.run([r'DSH_Update.exe','--print-green-version'],capture_output=True,text=True,timeout=30).stdout.strip())"
```

> **坑：windowed (GUI) 子系统 exe 不连控制台**，PowerShell 直接 `.\xxx.exe --print-green-version` 无任何输出，容易误判"没构建成功"。必须用 Python subprocess `capture_output` 读 stdout。发版脚本内部的新鲜度校验也是这么跑的。

> **坑中坑：同一个 exe 在 `dist/` 下能打印版本，在仓库根目录下却返回 `-1` 且输出为空**（2026-09-10 实测，v1.0.35/1.0.36 均如此）。根目录多了 `locales/` 等资源，`dist/` 下反而会打一条 locale 警告后正常输出 `1.0.36`、退出码 0。**后果**：发版脚本 `verify_exe_freshness` 的"次级版本校验"要求 `returncode == 0`，在根目录不成立 → **被静默跳过**，实际只剩 mtime 把关。要真正验版本号，去 `dist/` 跑一遍，或直接比对 root/dist 的 `Get-FileHash`。

### 构建后自查（推荐）

```powershell
# root 与 dist 必须同一份（换 exe 后尤其要查）
(Get-FileHash DSH_Launcher.exe).Hash; (Get-FileHash dist\DSH_Launcher.exe).Hash
# exe mtime 必须晚于 launcher.py / update_agent.py
Get-Item launcher.py,update_agent.py,DSH_Launcher.exe,DSH_Update.exe | Select-Object Name,LastWriteTime
```

### 常见坑

| 症状 | 原因 | 解决 |
|------|------|------|
| DSH_Update.exe 版本旧的 | `update_agent.py` 的 `GREEN_VERSION` 没同步 | 改 update_agent.py 再构建 |
| `DSH_Update.ico not found` | 手动跑 PyInstaller 而非 bat | 用 `build_exe.bat`，自动用 Launcher 图标 |
| `exe 新鲜度校验失败: 构建时间早于 launcher.py` | 改了 launcher.py 之后才构建，或中间文件被回写 | 重跑 build_exe.bat，然后**立刻**跑发版脚本 |
| 旧 exe 残留 | 没删 dist/ 和根目录旧 exe | 每次构建前删干净 |
| `The process cannot access the file because it is being used by another process.` + 仍打印 `[OK] Build complete` | 启动器正在运行，根目录 exe 被占用（**假成功**） | 关掉启动器再 build，或 rename→copy 换文件（见上）；别信末尾的 OK |

---

## 阶段④ · commit exe + tag + push 双远程

正确顺序（已固化，防新鲜度竞态）：

```
① 改版本号 → ② commit 源码 → ③ build_exe → ④ commit exe → ⑤ tag → push → 发版脚本
```

```bash
git add DSH_Launcher.exe DSH_Update.exe && git commit -m "build: v<VER> 重建两个 exe"
git tag v<VER>
git push origin master v<VER>     # 远程1（如 Gitee）
git push github master v<VER>     # 远程2（如 GitHub）
```

**不要把 exe 打包 zip 放在 commit exe 之前**，也不要把发版上传单独拿出来干跑。

---

## 阶段⑤ · 打包 + 发布 Release（发版脚本一口气干完）

### 唯一正确姿势：`build_exe.bat → python release_upload.py`（不带任何 flag）

- 发版脚本**内部先打包再上传**（含 release_notes 回写版本日期、zip 打包、双平台创建/上传）
- token 用环境变量注入：`$env:GITEE_TOKEN=...`、`$env:GITHUB_TOKEN=...`，跑完即弃
- **中间绝不能再碰任何 Python 源文件**，否则新鲜度校验会拦（见下）

### 必须先设 UTF-8 IO，否则第一步就崩（2026-09-10 实测）

```powershell
$env:PYTHONIOENCODING='utf-8'; $env:PYTHONUTF8='1'   # 中文 Windows / 管道重定向下必须
python release_upload.py
```

`check_python()` 会打印 `[✓]`（U+2713）；在 GBK 控制台或**被管道捕获**的 stdout 下抛
`UnicodeEncodeError: 'gbk' codec can't encode character '\u2713'` 并立刻退出——**崩在第一步，尚未改动任何文件，可安全重跑**（launcher.py 未被回写，不会污染新鲜度校验）。

### 高频坑：新鲜度竞态

- **不要先 `--pack-only` 再 `--upload-only`**——`--pack-only` 会回写 `GREEN_VERSION_DATE` 刷新 launcher.py 的 mtime，导致紧接着 `--upload-only` 报"exe 构建时间早于 launcher.py"。脚本实际上不认 pack-only。
- 正确做法：`build_exe.bat → python release_upload.py` **一口气**跑完，中间不插任何脚本。

---

## 双平台 Release 踩坑速查（最重要）

| 平台 | 坑 | 解法 |
|------|----|------|
| **Gitee** | create/edit Release 接口只解析 `application/x-www-form-urlencoded`，不是 JSON | 走 `http_request_form()`，`Content-Type: application/x-www-form-urlencoded; charset=utf-8`；GitHub 侧继续用 JSON |
| **Gitee** | 首次发新 tag 时 `target_commitish` 传 tag 名报 HTTP 400（tag 还没 push） | `target_commitish="master"`，让 Gitee 从默认分支自动建 tag（要预先 push tag 用 git 推开） |
| **Gitee** | attach_files 字段名写错报 `file is missing` | multipart 里字段名必须是单数 `file`（不是 `files`） |
| **GitHub** | POST /releases 默认创建 draft，用户看不到 | 必须 `draft:false` |
| **GitHub** | 传 tag 名需预先存在 | GitHub 行为不同：tag 不存在会自动建 tag 指向 target_commitish，不需要预先 push |
| **GitHub** | `github.com:443` 完全不可达（`git push github` 报 `Recv failure: Connection was reset` / `Couldn't connect to server`），但 `api.github.com` / `uploads.github.com` 正常 | **发版不必等 GitHub 的 git 通道**：推 Gitee 后 GitHub 的 **master 与 tag 会一起自动镜像同步**（实测几十秒～1 分钟内到位）。**务必先确认同步再发 Release**，否则 GitHub 会按 `target_commitish=master` 在旧提交上建 tag，造成双平台 tag 指向不一致。需要直连时可用本机代理：`git -c http.proxy=http://127.0.0.1:7890 ls-remote github` |
| 通用 | PowerShell 发含中文的 Release body 乱码 | 用 Python urllib/发版脚本，别用 PowerShell Invoke-RestMethod |
| 通用 | 发布后本地 launcher.py 显示 modified 但内容无 diff | 发版脚本回写日期只动 mtime，`git diff --numstat` 为空，无需提交 |
| 通用 | GitHub Release 标题是**中文**，与"GitHub 用英文标题"的直觉不符 | 固有行为：脚本只取中文文件首行当标题（`en_title_tmpl` 解析了但未使用），正文是 cn+en 双语锚点。v1.0.34/35/36 一致，**不要为了"改英文"去动脚本** |

### token 获取（不重头索要）

```bash
# Gitee PAT：从 Windows 凭据管理器读（git 存过就取得到）
"protocol=https`nhost=gitee.com`n`n" | git credential fill   # 输出 username + password(PAT)
# GitHub：复用现有 GH_TOKEN 映射到 GITHUB_TOKEN
```

**先用只读接口验 token 再发版**（省得打包完才发现 401）：`GET https://api.github.com/user`（`Authorization: Bearer <pat>`）与 `GET https://gitee.com/api/v5/user?access_token=<pat>`，返回的 `login` 应与仓库 owner 一致。

### 发版前先探明连通性（30 秒）

```powershell
foreach ($t in 'https://github.com','https://api.github.com','https://uploads.github.com','https://gitee.com') {
  "$t -> HTTP " + (curl.exe -s -o NUL -w "%{http_code}" --max-time 15 $t)
}
```

判读：`api.github.com` / `uploads.github.com` 通即可发 GitHub Release（创建 Release + 传资产都走这两个域名）；`github.com` 只影响 `git push`，可用 Gitee 镜像同步绕过。

---

## 发版后自检

- [ ] 双平台 Release 标题正常（**两边都是中文标题**，正文含 cn+en 双语锚点）
- [ ] zip 资产已上传（Gitee 可能额外生成 v.major.zip / tar.gz 源码包，属平台自动打包，正常）
- [ ] GitHub Release **非 draft**（prerelease 按需）
- [ ] 本地 git 干净（launcher.py 回归化日期 mtime 无 diff 可忽略）
- [ ] 实测验证 ZIP 内容可覆盖解压启动

---

## 版本号命名纪律

- `tag` 带 `v` 前缀（本地比较时去前缀）
- 绿色版 zip 资产名 = `{GREEN_ZIP_PREFIX}{ver}.zip` 固定
- 版本号对比用正确的 semver 五元组（major/minor/patch/pre_rank/pre_number），**不要** `re.split(r"[^\d]+")` 纯拆数字——`alpha.5` vs `rc.1` 会误判（rc.1 > alpha.5，但纯拆数字得 rc.1 < alpha.5）