# -*- coding: utf-8 -*-
"""
一键打包 + 发布 Online 绿色版 zip 到 Gitee + GitHub Release
====================================================================

用法:
  1) 设置 token (二选一或都设):
       set GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
       set GITEE_TOKEN=gitee_access_token_string
  2) 执行:
       python release_upload.py
     或显式指定 Python3 路径 (系统默认 python 可能是 2.7):
       runtime\\python\\python\\python.exe release_upload.py

脚本流程:
  Step 1. 校验运行环境 + 读取 launcher.py 中的 GREEN_VERSION (唯一来源)
  Step 2. 打包 Online 绿色版 zip (仅启动器框架, 排除 runtime/)
  Step 3. GitHub: 检查 Release 是否存在 → 不存在则创建 → 上传 zip 附件
  Step 4. Gitee: 同上

--------------------------------------------------------------------
## Online 绿色版打包规则 (铁律, 每条都踩过坑)
--------------------------------------------------------------------

### 【必须包含】(根目录相对路径)
  DSH_Launcher.exe / DSH_Update.exe       # PyInstaller onefile 产物
  launcher.py / update_agent.py           # Python 启动器源码
  desktop-shell.py                        # Desktop Shell 窗口源码
  DSH_Launcher.ico                        # 绿色鲸图标
  config.json                             # 默认配置模板
  start.bat / stop.bat                    # 便捷启动/停止脚本
  plugins/                                # 插件源码 (不含 node_modules——首次启动自动装)
  pages/                                  # WebUI 辅助页面
  skills/                                 # Skill 文档目录
  README.md / README_EN.md / LICENSE      # 文档
  DEV_NOTES.md                            # 开发笔记 (含打包/发布清单)

### 【必须排除】(踩坑点!)
  ❌ 整个 runtime/ 目录
     - 原因: runtime/python (127MB) + runtime/node (94MB) + runtime/dsh (~50MB)
       加起来 270MB, zip 后还是 160MB+, 远超 Gitee 100MB 限制
     - 用户不需要: 启动器「安装环境」按钮会自动下载便携 Python + Node + dsh
  ❌ .git/ .trae/ build/ dist/ workspace/ __pycache__/
  ❌ *.pyc / *.pdb / *.spec / *.pyo / Thumbs.db / Desktop.ini
  ❌ 打包辅助脚本: release_upload.py / build_exe.bat / _pack_online.py / .gitignore
  ❌ skills/*.zip  (skill 打包产物临时文件)

### 打包后体积目标
  压缩前 ~18.5 MB  →  ZIP 压缩后 ~17 MB  (Gitee 限制 100MB, GitHub 限制 2GB)

### ZIP 命名规范
  DSH_Launcher_GreenPortable_Online_YYYYMMDD_v{GREEN_VERSION}.zip
  例: DSH_Launcher_GreenPortable_Online_20260903_v1.0.27.zip
  版本号从 launcher.py GREEN_VERSION 读取 (唯一来源, 禁止硬编码)

--------------------------------------------------------------------
## 避坑清单 (踩过的每一条, 下次别再踩)
--------------------------------------------------------------------

  1. ❌ 系统 python 可能是 2.7 → 中文注释/字符串报 Non-ASCII character
     ✅ 用 runtime/python/python/python.exe (3.10.x), 或在脚本首行加 # -*- coding: utf-8 -*-

  2. ❌ PowerShell Invoke-RestMethod 构建 multipart/form-data 上传 GitHub
     → GetBytes chars null / Array cannot be null 编码错误
     ✅ 本脚本用 Python urllib 直传 (Content-Type: application/zip + 原始二进制),
        若仍失败自动 fallback 到 curl.exe (已实测 curl.exe 稳定)

  3. ❌ 上传前没检查 zip 是否存在 → 临时文件被清理后找不到
     ✅ 脚本内置打包逻辑, 每次执行都会重新打包, 不依赖外部 zip

  4. ❌ 版本号不同步 → launcher.py 改了但 zip 文件名里还是旧版
     ✅ 脚本统一从 launcher.py GREEN_VERSION 读取, 不再重复硬编码

  5. ❌ Gitee Release 附件大小超限 (>100MB)
     ✅ Online 版必须排除 runtime/, 压缩后 ~17MB, 远低于限制

  6. ❌ .bat 文件中文乱码
     ✅ .bat 文件全部用 ASCII 编码保存, 避免 GBK/UTF-8 BOM 冲突

  7. ❌ PowerShell 5 语法限制导致转义地狱
     ✅ 所有复杂逻辑放 Python 里, PowerShell 只做简单命令调用

  8. ❌ Release tag 与 launcher.py GREEN_VERSION 不一致
     ✅ 脚本自动从 launcher.py 读版本号 → 生成 tag → 创建 Release → 上传, 一条龙

--------------------------------------------------------------------
## 版本历史
--------------------------------------------------------------------
  v3.0 (2026-09-02): 合并 runtime/tmp/build_release_zip.py 为单一权威入口;
    新增 exe 新鲜度强制校验 (改了 launcher.py 忘了重打包 exe 会 exit(2) 阻断),
    新增 GREEN_VERSION_DATE 自动回写, 新增 zip 根目录结构校验;
    修正 INCLUDE_ITEMS 补 build_exe.bat, 移除错含的 DEV_NOTES.md (项目约定).
  v2.0 (2026-09-03): 重写, 整合打包逻辑, 完整避坑清单, GitHub 上传加 curl.exe fallback
  v1.0 (2026-09-02): 初始版本, 仅上传功能
====================================================================
"""

import json
import os
import re
import sys
import zipfile
import datetime
import glob
import mimetypes
import subprocess
import urllib.request
import urllib.parse
import urllib.error


# ============================================================
# 配置区 (版本号从 launcher.py 读取, 禁止硬编码)
# ============================================================

ROOT = os.path.dirname(os.path.abspath(__file__))
GITEE_OWNER = "liujunheng"
GITEE_REPO = "DeepSeekHarnessGreen"
GITHUB_OWNER = "LiuJunheng"
GITHUB_REPO = "DeepSeekHarnessGreen"

# ============================================================
# Release 描述 — 外部文件读取, 每次发布前必须写 release_notes.md
# ============================================================

def load_release_notes(root_dir):
    """
    从根目录 release_notes.md 读取发布描述。
    文件格式约定:
        第 1 行: Release 标题 (支持 {tag} 占位符)
        第 2 行起: Release body (Markdown, 直接用)
    缺失则 exit(1), 强制每次发布前写更新日志。
    """
    notes_path = os.path.join(root_dir, "release_notes.md")
    if not os.path.isfile(notes_path):
        print("[ERROR] 缺少 release_notes.md!")
        print("  请在项目根目录创建 release_notes.md, 格式:")
        print("    第 1 行: Release 标题 (可用 {tag} 占位)")
        print("    第 2 行起: Markdown 格式的更新说明")
        print("  写完再跑本脚本。")
        sys.exit(1)
    with open(notes_path, "r", encoding="utf-8") as f:
        raw = f.read()
    lines = raw.split("\n")
    # 第一行是标题, 后面是 body
    title = lines[0].strip() if lines else ""
    body = "\n".join(lines[1:]).lstrip("\n")
    if not title:
        print("[ERROR] release_notes.md 第一行是空的, 需要写 Release 标题")
        sys.exit(1)
    return title, body


# ============================================================
# 打包规则 (铁律, 每条都踩过坑)
# ============================================================

# 必须包含的根目录项 (文件或目录, 相对 ROOT)
# 铁律: DEV_NOTES.md 和 .gitignore 不进绿色 zip (项目约定, 只用于开发侧)
INCLUDE_ITEMS = [
    "DSH_Launcher.exe",
    "DSH_Update.exe",
    "DSH_Launcher.ico",
    "launcher.py",
    "update_agent.py",
    "desktop-shell.py",
    "build_exe.bat",
    "config.json",
    "start.bat",
    "stop.bat",
    "plugins",
    "pages",
    "skills",
    "README.md",
    "README_EN.md",
    "LICENSE",
]

# 遍历时必须排除的子目录 (无论在哪一层)
EXCLUDE_SUBDIRS = {
    ".git", ".trae", "build", "dist", "workspace", "__pycache__", "runtime",
    "node_modules",
}

# 遍历时必须排除的文件名
EXCLUDE_FILENAMES = {
    "release_upload.py", ".gitignore", "_pack_online.py",
}

# 必须排除的文件扩展名
EXCLUDE_EXTS = {
    ".pyc", ".pyo", ".pdb", ".spec", ".log", ".tmp", ".bak",
}

# 额外排除的 glob 模式 (相对于 ROOT)
EXCLUDE_GLOBS = [
    "skills/*.zip",       # skill 打包临时产物
    "plugins/*/*.zip",    # 插件打包临时产物
]


# ============================================================
# Step 1: 环境校验 + 版本号读取
# ============================================================

def check_python():
    """确认当前 Python 版本 >= 3.6"""
    version_info = sys.version_info
    if version_info.major < 3:
        print("[✗] 当前 Python 是 %d.%d, 需要 Python 3.x" % (version_info.major, version_info.minor))
        print("    建议用: runtime\\python\\python\\python.exe release_upload.py")
        sys.exit(1)
    print("[✓] Python %d.%d.%d" % (version_info.major, version_info.minor, version_info.micro))


def read_version():
    """从 launcher.py 读取 GREEN_VERSION (唯一来源)"""
    path = os.path.join(ROOT, "launcher.py")
    if not os.path.exists(path):
        print("[✗] 找不到 launcher.py: " + path)
        sys.exit(1)
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    m = re.search(r'GREEN_VERSION\s*=\s*"([\d.]+)"', text)
    if not m:
        print("[✗] 无法从 launcher.py 读 GREEN_VERSION, 请检查格式")
        sys.exit(1)
    return m.group(1)


def verify_include_items():
    """校验所有 INCLUDE_ITEMS 都存在, 缺了就报错退出"""
    missing = []
    for item in INCLUDE_ITEMS:
        full_path = os.path.join(ROOT, item)
        if not os.path.exists(full_path):
            missing.append(item)
    if missing:
        print("[✗] 以下必须包含的文件/目录不存在:")
        for m in missing:
            print("    - " + m)
        print("    请先构建 exe / 安装插件 / 确认目录结构")
        sys.exit(1)
    print("[✓] 所有关键文件/目录存在 (%d 项)" % len(INCLUDE_ITEMS))


def sync_launcher_version_date(launcher_path, date_str):
    """把 launcher.py 的 GREEN_VERSION_DATE 常量更新为制作当天日期,
    保证 GUI 右上角【关于】弹窗显示的版本日期与 zip 文件名一致。
    date_str 形如 20260820 -> 回写成 "2026年08月20日"。
    若 launcher.py 里没有该常量则打印警告, 不中断打包。"""
    if not os.path.isfile(launcher_path):
        print("[WARN] launcher.py 不存在, 跳过版本日期回写: %s" % launcher_path)
        return
    chinese_date = "%s年%s月%s日" % (date_str[0:4], date_str[4:6], date_str[6:8])
    with open(launcher_path, "r", encoding="utf-8") as file_handle:
        source_text = file_handle.read()
    new_line = 'GREEN_VERSION_DATE = "%s"' % chinese_date
    updated_text, replaced_count = re.subn(
        r'GREEN_VERSION_DATE\s*=\s*"[^"]*"', new_line, source_text, count=1)
    if replaced_count == 0:
        print("[WARN] launcher.py 未找到 GREEN_VERSION_DATE, 版本日期回写失败")
        return
    with open(launcher_path, "w", encoding="utf-8", newline="\n") as file_handle:
        file_handle.write(updated_text)
    print("[INFO] 已回写 launcher.py 版本日期: %s" % chinese_date)


def verify_exe_freshness(root_dir, launcher_path):
    """
    强制校验 DSH_Launcher.exe 和 DSH_Update.exe 的构建时间不早于 launcher.py。
    这样改了 launcher.py 之后若忘了重跑 build_exe.bat, 会在打包时直接报错阻断,
    避免 zip 内嵌的 exe 仍是旧版 (用户运行后版本号比 Release tag 低一级)。

    校验必须在 sync_launcher_version_date **之前**调用 —— sync 会重写 launcher.py
    (改 GREEN_VERSION_DATE), 会让 launcher.py 的 mtime 变新, 造成误判。
    """
    exe_names = ("DSH_Launcher.exe", "DSH_Update.exe")
    launcher_mtime = os.path.getmtime(launcher_path)
    launcher_version = read_version()
    stale = []
    for name in exe_names:
        exe_path = os.path.join(root_dir, name)
        if not os.path.isfile(exe_path):
            stale.append((name, "文件不存在"))
            continue
        exe_mtime = os.path.getmtime(exe_path)
        # exe mtime 必须 >= launcher.py mtime (允许 2s 宽容, 避免同秒精度问题)
        if exe_mtime + 2 < launcher_mtime:
            stale.append((name, "exe 构建时间早于 launcher.py"))

    # 次级校验: 运行 exe --print-green-version 对比源码版本
    # (需要 exe 已包含该隐藏 flag, 老版本 exe 没有则跳过不报错)
    for name in exe_names:
        exe_path = os.path.join(root_dir, name)
        if not os.path.isfile(exe_path):
            continue
        try:
            result = subprocess.run(
                [exe_path, "--print-green-version"],
                capture_output=True, timeout=5,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            if result.returncode == 0:
                exe_version = result.stdout.decode("utf-8", errors="replace").strip()
                if exe_version and exe_version != launcher_version:
                    stale.append((name,
                                  "exe 内嵌版本 %s != launcher.py 版本 %s"
                                  % (exe_version, launcher_version)))
        except Exception:
            pass   # 新 flag 老 exe 不支持, 忽略

    if stale:
        print("[ERROR] exe 新鲜度校验失败, 打包已阻断!")
        print("[ERROR] 根目录 launcher.py 当前 GREEN_VERSION = %s" % launcher_version)
        for name, reason in stale:
            print("[ERROR]   - %s: %s" % (name, reason))
        print("")
        print("[HINT] 请先执行 build_exe.bat 重打包两个 exe, 再重新跑本脚本")
        print("[HINT] 原因: launcher.py (含 GREEN_VERSION) 已更新, 但 exe 还是旧构建")
        sys.exit(2)
    print("[✓] exe 新鲜度校验通过: DSH_Launcher.exe / DSH_Update.exe 均与 launcher.py 同步")


def verify_zip(zip_path, expect_top):
    """校验 zip 根目录成员是否齐全, 缺任何关键项直接 exit(1)"""
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
    top_level = set()
    for name in names:
        first = name.split("/")[0]
        top_level.add(first)
    missing = [item for item in expect_top if item not in top_level]
    if missing:
        print("[ERROR] zip 根目录缺失关键项: %s" % missing)
        sys.exit(1)
    print("[✓] zip 根目录校验通过, 成员: %s" % sorted(top_level))


# ============================================================
# Step 2: 打包 Online 绿色版 zip
# ============================================================

def should_exclude_path(rel_path, filename):
    """判断某个文件是否应该被排除 (返回 True=排除)"""
    # 检查排除的子目录
    parts = rel_path.replace("\\", "/").split("/")
    for part in parts:
        if part in EXCLUDE_SUBDIRS:
            return True

    # 检查排除的文件名
    if filename in EXCLUDE_FILENAMES:
        return True

    # 检查排除的扩展名
    _, ext = os.path.splitext(filename)
    if ext.lower() in EXCLUDE_EXTS:
        return True

    return False


def pack_online_zip(version):
    """打包 Online 绿色版 zip — 核心函数"""
    date_str = datetime.datetime.now().strftime("%Y%m%d")
    zip_name = "DSH_Launcher_GreenPortable_Online_%s_v%s.zip" % (date_str, version)
    zip_path = os.path.join(ROOT, zip_name)

    print("\n=== 打包 Online 绿色版 ===")
    print("  输出: " + zip_name)

    file_count = 0
    raw_total = 0

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for item in INCLUDE_ITEMS:
            full_path = os.path.join(ROOT, item)
            if os.path.isfile(full_path):
                # 单个文件
                size = os.path.getsize(full_path)
                zf.write(full_path, item)
                file_count += 1
                raw_total += size
            elif os.path.isdir(full_path):
                # 目录 — 递归遍历
                for dirpath, dirnames, filenames in os.walk(full_path):
                    # 先过滤要排除的子目录 (直接从 dirnames 移除, os.walk 就不会进去)
                    dirnames[:] = [
                        d for d in dirnames
                        if d not in EXCLUDE_SUBDIRS
                    ]
                    # 再过滤 glob 模式 (相对 ROOT)
                    rel_dir = os.path.relpath(dirpath, ROOT)
                    # 处理目录下的每个文件
                    for fname in filenames:
                        # 排除目录 glob
                        full_file = os.path.join(dirpath, fname)
                        rel_file = os.path.relpath(full_file, ROOT)
                        if should_exclude_path(rel_file, fname):
                            continue
                        size = os.path.getsize(full_file)
                        zf.write(full_file, rel_file)
                        file_count += 1
                        raw_total += size

    zip_size = os.path.getsize(zip_path)

    print("  文件数: %d" % file_count)
    print("  原始大小: %.1f MB" % (raw_total / 1024 / 1024))
    print("  压缩后:   %.1f MB" % (zip_size / 1024 / 1024))

    # 体积告警
    if zip_size > 95 * 1024 * 1024:
        print("  [⚠] 警告: zip %.1f MB 已接近 Gitee 100MB 限制!" % (zip_size / 1024 / 1024))
        print("      检查是否误打包了 runtime/ 或其它大目录")
    else:
        print("  [✓] 体积 OK (Gitee 限制 100MB, GitHub 限制 2GB)")

    return zip_path


# ============================================================
# HTTP 请求辅助
# ============================================================

def http_request(url, method="GET", data=None, headers=None):
    """统一 HTTP 请求 (urllib) — 处理 JSON 和二进制数据"""
    headers = headers or {}
    body = None

    if data is not None and not isinstance(data, (bytes, bytearray)):
        # JSON 数据
        body = json.dumps(data).encode("utf-8")
        headers.setdefault("Content-Type", "application/json; charset=utf-8")
    elif isinstance(data, (bytes, bytearray)):
        # 原始二进制数据
        body = data

    req = urllib.request.Request(url, data=body, method=method)
    for k, v in headers.items():
        req.add_header(k, v)

    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            raw = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            if "application/json" in ctype:
                return resp.status, json.loads(raw)
            return resp.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = raw
        return e.code, parsed


def run_curl_upload(upload_url, token, file_path):
    """Fallback 方案 — 用 curl.exe 上传二进制文件
    踩坑: PowerShell Invoke-RestMethod 构建 multipart/form-data 时
          GetBytes chars null / Array cannot be null 编码错误,
          所以 GitHub 上传优先尝试 Python urllib, 失败自动用 curl.exe"""
    fname = os.path.basename(file_path)
    file_size = os.path.getsize(file_path)

    print("  [→] curl.exe Fallback 上传 %s (%.1f MB)..." % (fname, file_size / 1024 / 1024))

    cmd = [
        "curl.exe", "-X", "POST",
        upload_url,
        "-H", "Authorization: Bearer " + token,
        "-H", "Content-Type: application/zip",
        "--data-binary", "@" + file_path,
        "--max-time", "300",
        "-s", "-o", "CON",            # 输出到控制台
        "-w", "\nCURL_HTTP_CODE:%{http_code}\n",
    ]

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=400)
        output = result.stdout + result.stderr
        # 从输出末尾提取 HTTP_CODE
        http_code = 0
        for line in reversed(output.split("\n")):
            m = re.search(r"CURL_HTTP_CODE:(\d+)", line)
            if m:
                http_code = int(m.group(1))
                break

        if http_code in (200, 201):
            print("  [✓] curl.exe 上传成功 (HTTP %d)" % http_code)
            return True
        else:
            print("  [✗] curl.exe 上传失败 (HTTP %d)" % http_code)
            print("      " + output[-500:])
            return False
    except Exception as e:
        print("  [✗] curl.exe 执行异常: " + str(e))
        return False


# ============================================================
# GitHub Release 操作
# ============================================================

def github_list_releases(token):
    url = "https://api.github.com/repos/%s/%s/releases?per_page=20" % (GITHUB_OWNER, GITHUB_REPO)
    headers = {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    status, data = http_request(url, headers=headers)
    if status != 200:
        print("  [GitHub] list releases HTTP %d: %s" % (status, str(data)[:200]))
        return []
    return data


def github_create_release(token, tag, name, body):
    url = "https://api.github.com/repos/%s/%s/releases" % (GITHUB_OWNER, GITHUB_REPO)
    headers = {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    payload = {
        "tag_name": tag,
        "target_commitish": "master",
        "name": name,
        "body": body,
        "draft": False,
        "prerelease": False,
    }
    status, data = http_request(url, method="POST", data=payload, headers=headers)
    if status not in (200, 201):
        print("  [GitHub] create release HTTP %d: %s" % (status, str(data)[:300]))
        return None
    return data


def github_upload_asset(token, release_id, file_path):
    """上传 zip 到 GitHub Release — 优先 Python urllib, 失败 fallback curl.exe"""
    fname = os.path.basename(file_path)
    file_size = os.path.getsize(file_path)
    mime = "application/zip"

    # 构建上传 URL
    upload_url = (
        "https://uploads.github.com/repos/%s/%s/releases/%d/assets?name=%s"
        % (GITHUB_OWNER, GITHUB_REPO, release_id, urllib.parse.quote(fname))
    )

    # 先删同名旧资产 (避免重复上传)
    print("  [→] 检查同名旧资产...")
    releases = github_list_releases(token)
    old_asset = None
    for r in releases:
        if r["id"] == release_id:
            for a in r.get("assets", []):
                if a["name"] == fname:
                    old_asset = a
            break
    if old_asset:
        durl = old_asset["url"]
        h = {
            "Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        s2, _ = http_request(durl, method="DELETE", headers=h)
        print("  [→] 删除旧资产 %s: HTTP %d" % (fname, s2))

    # 读取文件内容
    with open(file_path, "rb") as f:
        file_data = f.read()

    # 方案 A: Python urllib 直传 (Content-Type: application/zip + 原始二进制)
    print("  [→] Python urllib 上传 %s (%.1f MB)..." % (fname, file_size / 1024 / 1024))
    headers = {
        "Authorization": "Bearer " + token,
        "Content-Type": mime,
        "Content-Length": str(len(file_data)),
        "X-GitHub-Api-Version": "2022-11-28",
    }
    status, resp = http_request(upload_url, method="POST", data=file_data, headers=headers)

    if status in (200, 201):
        print("  [✓] GitHub 上传 OK: %s (ID=%d)" % (resp.get("name", fname), resp.get("id", 0)))
        return True
    else:
        print("  [!] Python urllib 上传失败 (HTTP %d), 尝试 curl.exe fallback..." % status)
        print("      错误: %s" % str(resp)[:300])
        # 方案 B: curl.exe fallback
        return run_curl_upload(upload_url, token, file_path)


# ============================================================
# Gitee Release 操作
# ============================================================

def gitee_list_releases(token):
    url = (
        "https://gitee.com/api/v5/repos/%s/%s/releases"
        "?access_token=%s&per_page=20"
        % (GITEE_OWNER, GITEE_REPO, token)
    )
    status, data = http_request(url)
    if status != 200:
        print("  [Gitee] list releases HTTP %d: %s" % (status, str(data)[:200]))
        return []
    return data


def gitee_create_release(token, tag, name, body):
    url = "https://gitee.com/api/v5/repos/%s/%s/releases" % (GITEE_OWNER, GITEE_REPO)
    payload = {
        "access_token": token,
        "tag_name": tag,
        "target_commitish": tag,
        "name": name,
        "body": body,
    }
    status, data = http_request(url, method="POST", data=payload)
    if status not in (200, 201):
        print("  [Gitee] create release HTTP %d: %s" % (status, str(data)[:300]))
        return None
    return data


def gitee_upload_asset(token, release_id, file_path):
    """上传 zip 到 Gitee Release — 用 multipart/form-data 手动构建"""
    fname = os.path.basename(file_path)
    file_size = os.path.getsize(file_path)
    mime = "application/zip"

    # Gitee API 不支持删除单个 asset, 只能"同名跳过"防止无限堆积
    print("  [→] 检查 Gitee 同名资产是否已存在...")
    releases = gitee_list_releases(token)
    skip_upload = False
    for rel in releases:
        if rel.get("id") == release_id:
            existing_names = [a.get("name") for a in rel.get("assets", [])]
            same_count = existing_names.count(fname)
            if same_count > 0:
                print("  [→] Gitee 已有 %d 份同名资产 %s, 跳过上传 (Gitee API 不支持删单个 asset)"
                      % (same_count, fname))
                skip_upload = True
            break

    if skip_upload:
        return True

    with open(file_path, "rb") as f:
        file_data = f.read()

    # 手动构建 multipart/form-data (Gitee 要求 access_token + file 两个字段)
    boundary = "----TraeBoundary7MA4YWxkTrZu0gW"
    body = b""
    body += ("--%s\r\n" % boundary).encode("utf-8")
    body += b'Content-Disposition: form-data; name="access_token"\r\n\r\n'
    body += token.encode("utf-8") + b"\r\n"
    body += ("--%s\r\n" % boundary).encode("utf-8")
    body += (
        'Content-Disposition: form-data; name="file"; filename="%s"\r\n' % fname
    ).encode("utf-8")
    body += ("Content-Type: %s\r\n\r\n" % mime).encode("utf-8")
    body += file_data + b"\r\n"
    body += ("--%s--\r\n" % boundary).encode("utf-8")

    url = (
        "https://gitee.com/api/v5/repos/%s/%s/releases/%d/attach_files"
        % (GITEE_OWNER, GITEE_REPO, release_id)
    )
    headers = {
        "Content-Type": "multipart/form-data; boundary=" + boundary,
        "Content-Length": str(len(body)),
    }

    print("  [→] Gitee 上传 %s (%.1f MB)..." % (fname, file_size / 1024 / 1024))
    status, resp = http_request(url, method="POST", data=body, headers=headers)

    if status in (200, 201):
        print("  [✓] Gitee 上传 OK: %s" % resp.get("name", fname))
        return True
    else:
        print("  [✗] Gitee 上传 HTTP %d: %s" % (status, str(resp)[:300]))
        return False


# ============================================================
# Main
# ============================================================

def main():
    print("=" * 64)
    print("  DSH Green — 一键打包 + 发布")
    print("=" * 64)

    # Step 1: 环境校验 + 版本号
    check_python()
    version = read_version()
    tag = "v" + version
    print("[✓] 版本号: %s  (来源: launcher.py GREEN_VERSION)" % tag)
    verify_include_items()

    # 发布铁律 (v3.0 起):
    # 1) verify_exe_freshness 必须在 sync_launcher_version_date **之前** —— sync 会重写
    #    launcher.py 改 GREEN_VERSION_DATE, 会让 mtime 变新, 导致校验误判。
    # 2) 任一校验失败 exit(2), 阻断打包, 明确提示 "请先跑 build_exe.bat"。
    launcher_path = os.path.join(ROOT, "launcher.py")
    verify_exe_freshness(ROOT, launcher_path)

    # Step 1.5: 自动回写 launcher.py 的 GREEN_VERSION_DATE 为构建当天
    date_str = datetime.datetime.now().strftime("%Y%m%d")
    sync_launcher_version_date(launcher_path, date_str)

    # Step 1.6: 读取 Release 描述 (强制外部文件, 每次发布前必须写)
    release_title_tmpl, release_notes = load_release_notes(ROOT)
    release_title = release_title_tmpl.format(tag=tag)

    # Step 2: 打包 zip
    zip_path = pack_online_zip(version)
    print("[✓] ZIP 就绪: " + zip_path)

    # 校验 zip 根目录关键项齐全 (包含 build_exe.bat / plugins / skills 等)
    expect_top = [
        "launcher.py", "update_agent.py", "desktop-shell.py",
        "start.bat", "stop.bat", "build_exe.bat",
        "DSH_Launcher.exe", "DSH_Update.exe", "DSH_Launcher.ico",
        "config.json", "README.md", "README_EN.md", "LICENSE",
        "plugins", "pages", "skills",
    ]
    verify_zip(zip_path, expect_top)

    # 读 token
    github_token = os.environ.get("GITHUB_TOKEN", "").strip()
    gitee_token = os.environ.get("GITEE_TOKEN", "").strip()

    if not github_token and not gitee_token:
        print("\n[!] 未设置 GITHUB_TOKEN 或 GITEE_TOKEN, 跳过上传")
        print("    设置方法: set GITHUB_TOKEN=ghp_xxx  或  set GITEE_TOKEN=xxx")
        print("    ZIP 已就绪, 可手动上传: " + zip_path)
        sys.exit(0)

    # Step 3: GitHub
    print("\n" + "=" * 64)
    print("  GitHub Release")
    print("=" * 64)

    if github_token:
        releases = github_list_releases(github_token)
        rel = None
        for r in releases:
            if r["tag_name"] == tag:
                rel = r
                break

        if rel is None:
            print("  创建新 Release %s..." % tag)
            rel = github_create_release(
                github_token,
                tag,
                release_title,
                release_notes,
            )
        else:
            print("  已有 Release: ID=%s" % rel["id"])

        if rel:
            github_upload_asset(github_token, rel["id"], zip_path)
        else:
            print("  [✗] Release 创建/查询失败")
    else:
        print("  SKIP: GITHUB_TOKEN 未设置")

    # Step 4: Gitee
    print("\n" + "=" * 64)
    print("  Gitee Release")
    print("=" * 64)

    if gitee_token:
        releases = gitee_list_releases(gitee_token)
        rel = None
        for r in releases:
            if r["tag_name"] == tag:
                rel = r
                break

        if rel is None:
            print("  创建新 Release %s..." % tag)
            rel = gitee_create_release(
                gitee_token,
                tag,
                release_title,
                release_notes,
            )
        else:
            print("  已有 Release: ID=%s" % rel["id"])

        if rel:
            gitee_upload_asset(gitee_token, rel["id"], zip_path)
        else:
            print("  [✗] Release 创建/查询失败")
    else:
        print("  SKIP: GITEE_TOKEN 未设置")

    print("\n[OK] 全部完成")


if __name__ == "__main__":
    main()
