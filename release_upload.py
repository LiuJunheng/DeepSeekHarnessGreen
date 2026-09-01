"""
一键发布 zip 到 Gitee + GitHub Release (v1.0.0)

用法:
  set GITHUB_TOKEN=ghp_xxx
  set GITEE_TOKEN=xxx
  python release_upload.py

做的事:
  1. 从 launcher.py 读 GREEN_VERSION
  2. 找根目录最新的绿色 zip
  3. Gitee: 如果 v1.0.26 Release 已存在 → 直接上传附件
  4. GitHub: 如果 Release 不存在 → 创建新的; 已存在 → 上传附件
"""
import json, os, sys, re, urllib.request, urllib.parse, mimetypes, glob

ROOT = os.path.dirname(os.path.abspath(__file__))
GITEE_OWNER = "liujunheng"
GITEE_REPO = "DeepSeekHarnessGreen"
GITHUB_OWNER = "LiuJunheng"
GITHUB_REPO = "DeepSeekHarnessGreen"
RELEASE_NOTES = """## 核心更新

### 🧠 dsh-memory v3 — 祖宗记忆库
- **默认关闭** (enabled: false)，省 token
- WebUI 设置面板加 **【测试】标签** + 启用开关
- 开关持久化到 runtime/dsh-home/memory/memory-config.json，重启后生效
- ruleSummarize 第四轮调优：列举词清理、长句逗号拆分、评分阈值过滤

### 📜 dsh-rules v3→v4 — 用户规则
- **Type B→Type A 升级**：从纯 hook 插件升级成双端插件
- 新增 **WebUI 设置面板**：启用开关 + 文件状态 + 字符数统计
- 新增 **规则内容预览** (只读 Markdown 源码)
- 新增 **WebUI 内编辑** (textarea + 保存/取消)，autoReload 下下次对话自动生效
- 新增 **下载 .md 按钮** (浏览器安全限制无法直接打开本地文件)
- **默认关闭** (enabled: false)

### 📚 Skill 文档补全
- plugin-skeleton.md 补 **Type B→A 升级路径** 完整章节
- plugin-skeleton.md 补 **持久化 config + WebUI 开关** 完整骨架代码
- plugin-dev-checklist.md 补 9 条升级检查项 + 8 条持久化 config 检查项 + 6 条排查速查
- SKILL.md 补 5.9.1 升级路径章节

### 🔒 安全
- config.json dsh_host 默认 0.0.0.0 → 127.0.0.1 (更安全)

## 升级说明
- 绿色版用户：启动器「检查绿色版更新」自动拉 Release 附件
- 手动升级：下载 zip 覆盖根目录（跳过 config.json 和 runtime/）
- 插件改了 package.json 后需重装：dsh plugin remove dsh-memory dsh-rules && dsh plugin add file:<插件绝对路径> && 重启服务
- dsh-rules 升级后会自动创建 runtime/dsh-home/rules/user-rules.md
"""

def read_version():
    path = os.path.join(ROOT, "launcher.py")
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    m = re.search(r'GREEN_VERSION\s*=\s*"([\d.]+)"', text)
    if not m:
        print("[✗] 无法从 launcher.py 读 GREEN_VERSION")
        sys.exit(1)
    return m.group(1)

def find_latest_zip(version):
    pattern = os.path.join(ROOT, f"DSH_Launcher_GreenPortable_Online_*_v{version}.zip")
    files = sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True)
    if not files:
        print(f"[✗] 没找到 zip: {pattern}")
        sys.exit(1)
    return files[0]

def http_request(url, method="GET", data=None, headers=None):
    headers = headers or {}
    body = None
    if data is not None and not isinstance(data, (bytes, bytearray)):
        body = json.dumps(data).encode()
        headers.setdefault("Content-Type", "application/json; charset=utf-8")
    elif isinstance(data, (bytes, bytearray)):
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
        try: parsed = json.loads(raw)
        except: parsed = raw
        return e.code, parsed

# ---------- GitHub ----------

def github_list_releases(token):
    url = f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases?per_page=20"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    status, data = http_request(url, headers=headers)
    if status != 200:
        print(f"  [GitHub] list releases HTTP {status}: {str(data)[:200]}")
        return []
    return data

def github_create_release(token, tag, name, body):
    url = f"https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases"
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28"}
    payload = {"tag_name": tag, "target_commitish": "master", "name": name, "body": body, "draft": False, "prerelease": False}
    status, data = http_request(url, method="POST", data=payload, headers=headers)
    if status not in (200, 201):
        print(f"  [GitHub] create release HTTP {status}: {str(data)[:300]}")
        return None
    return data

def github_upload_asset(token, release_id, file_path):
    fname = os.path.basename(file_path)
    size = os.path.getsize(file_path)
    mime, _ = mimetypes.guess_type(file_path)
    mime = mime or "application/zip"
    with open(file_path, "rb") as f:
        data = f.read()
    # 先删同名旧资产
    existing = None
    releases = github_list_releases(token)
    for r in releases:
        if r["id"] == release_id:
            for a in r.get("assets", []):
                if a["name"] == fname:
                    existing = a
            break
    if existing:
        durl = existing["url"]
        h2 = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
        s2, _ = http_request(durl, method="DELETE", headers=h2)
        print(f"  [GitHub] 删除旧资产 {fname}: HTTP {s2}")

    url = f"https://uploads.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases/{release_id}/assets?name={urllib.parse.quote(fname)}"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": mime, "Content-Length": str(len(data)), "X-GitHub-Api-Version": "2022-11-28"}
    print(f"  [→] GitHub 上传 {fname} ({size/1024/1024:.1f}MB)...")
    status, resp = http_request(url, method="POST", data=data, headers=headers)
    if status in (200, 201):
        print(f"  [✓] GitHub 上传 OK: {resp.get('name', fname)}")
        return True
    print(f"  [✗] GitHub 上传 HTTP {status}: {str(resp)[:300]}")
    return False

# ---------- Gitee ----------

def gitee_list_releases(token):
    url = f"https://gitee.com/api/v5/repos/{GITEE_OWNER}/{GITEE_REPO}/releases?access_token={token}&per_page=20"
    status, data = http_request(url)
    if status != 200:
        print(f"  [Gitee] list releases HTTP {status}: {str(data)[:200]}")
        return []
    return data

def gitee_create_release(token, tag, name, body):
    url = f"https://gitee.com/api/v5/repos/{GITEE_OWNER}/{GITEE_REPO}/releases"
    payload = {"access_token": token, "tag_name": tag, "target_commitish": tag, "name": name, "body": body}
    status, data = http_request(url, method="POST", data=payload)
    if status not in (200, 201):
        print(f"  [Gitee] create release HTTP {status}: {str(data)[:300]}")
        return None
    return data

def gitee_upload_asset(token, release_id, file_path):
    fname = os.path.basename(file_path)
    size = os.path.getsize(file_path)
    mime, _ = mimetypes.guess_type(file_path)
    mime = mime or "application/zip"
    with open(file_path, "rb") as f:
        file_data = f.read()
    boundary = "----TraeBoundary7MA4YWxkTrZu0gW"
    body = b""
    # access_token
    body += f"--{boundary}\r\n".encode()
    body += b'Content-Disposition: form-data; name="access_token"\r\n\r\n'
    body += token.encode() + b"\r\n"
    # file
    body += f"--{boundary}\r\n".encode()
    body += f'Content-Disposition: form-data; name="file"; filename="{fname}"\r\n'.encode()
    body += f"Content-Type: {mime}\r\n\r\n".encode()
    body += file_data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    url = f"https://gitee.com/api/v5/repos/{GITEE_OWNER}/{GITEE_REPO}/releases/{release_id}/attach_files"
    headers = {"Content-Type": f"multipart/form-data; boundary={boundary}", "Content-Length": str(len(body))}
    print(f"  [→] Gitee 上传 {fname} ({size/1024/1024:.1f}MB)...")
    status, resp = http_request(url, method="POST", data=body, headers=headers)
    if status in (200, 201):
        print(f"  [✓] Gitee 上传 OK: {resp.get('name', fname)}")
        return True
    print(f"  [✗] Gitee 上传 HTTP {status}: {str(resp)[:300]}")
    return False

# ---------- main ----------

def main():
    version = read_version()
    tag = f"v{version}"
    zip_path = find_latest_zip(version)
    print(f"版本: {tag}")
    print(f"ZIP : {zip_path} ({os.path.getsize(zip_path)/1024/1024:.1f}MB)")
    print()

    github_token = os.environ.get("GITHUB_TOKEN", "").strip()
    gitee_token = os.environ.get("GITEE_TOKEN", "").strip()

    # ---- GitHub ----
    print("=== GitHub ===")
    if github_token:
        releases = github_list_releases(github_token)
        rel = next((r for r in releases if r["tag_name"] == tag), None)
        if rel is None:
            print(f"  创建新 Release {tag}...")
            rel = github_create_release(github_token, tag, f"{tag} — 插件 WebUI 设置面板大升级", RELEASE_NOTES)
        else:
            print(f"  已有 Release: ID={rel['id']}")
        if rel:
            github_upload_asset(github_token, rel["id"], zip_path)
    else:
        print("  SKIP: GITHUB_TOKEN 未设置")

    print()

    # ---- Gitee ----
    print("=== Gitee ===")
    if gitee_token:
        releases = gitee_list_releases(gitee_token)
        rel = next((r for r in releases if r["tag_name"] == tag), None)
        if rel is None:
            print(f"  创建新 Release {tag}...")
            rel = gitee_create_release(gitee_token, tag, f"{tag} — 插件 WebUI 设置面板大升级", RELEASE_NOTES)
        else:
            print(f"  已有 Release: ID={rel['id']}")
        if rel:
            gitee_upload_asset(gitee_token, rel["id"], zip_path)
    else:
        print("  SKIP: GITEE_TOKEN 未设置")

    print("\n[OK] 完成")

if __name__ == "__main__":
    main()
