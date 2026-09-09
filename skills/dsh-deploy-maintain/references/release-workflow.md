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

### 常见坑

| 症状 | 原因 | 解决 |
|------|------|------|
| DSH_Update.exe 版本旧的 | `update_agent.py` 的 `GREEN_VERSION` 没同步 | 改 update_agent.py 再构建 |
| `DSH_Update.ico not found` | 手动跑 PyInstaller 而非 bat | 用 `build_exe.bat`，自动用 Launcher 图标 |
| `exe 新鲜度校验失败: 构建时间早于 launcher.py` | 改了 launcher.py 之后才构建，或中间文件被回写 | 重跑 build_exe.bat，然后**立刻**跑发版脚本 |
| 旧 exe 残留 | 没删 dist/ 和根目录旧 exe | 每次构建前删干净 |

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
| 通用 | PowerShell 发含中文的 Release body 乱码 | 用 Python urllib/发版脚本，别用 PowerShell Invoke-RestMethod |
| 通用 | 发布后本地 launcher.py 显示 modified 但内容无 diff | 发版脚本回写日期只动 mtime，`git diff --numstat` 为空，无需提交 |

### token 获取（不重头索要）

```bash
# Gitee PAT：从 Windows 凭据管理器读（git 存过就取得到）
"protocol=https`nhost=gitee.com`n`n" | git credential fill   # 输出 username + password(PAT)
# GitHub：复用现有 GH_TOKEN 映射到 GITHUB_TOKEN
```

---

## 发版后自检

- [ ] 双平台 Release 标题正常（Gitee 中文 / GitHub 英文），正文含双语
- [ ] zip 资产已上传（Gitee 可能额外生成 v.major.zip / tar.gz 源码包，属平台自动打包，正常）
- [ ] GitHub Release **非 draft**（prerelease 按需）
- [ ] 本地 git 干净（launcher.py 回归化日期 mtime 无 diff 可忽略）
- [ ] 实测验证 ZIP 内容可覆盖解压启动

---

## 版本号命名纪律

- `tag` 带 `v` 前缀（本地比较时去前缀）
- 绿色版 zip 资产名 = `{GREEN_ZIP_PREFIX}{ver}.zip` 固定
- 版本号对比用正确的 semver 五元组（major/minor/patch/pre_rank/pre_number），**不要** `re.split(r"[^\d]+")` 纯拆数字——`alpha.5` vs `rc.1` 会误判（rc.1 > alpha.5，但纯拆数字得 rc.1 < alpha.5）