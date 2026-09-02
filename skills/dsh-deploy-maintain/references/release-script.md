# 一键发布脚本参考

> 项目已有实作：根目录 `release_upload.py`（v2.0，666 行，整合打包逻辑）。本文档是核心配置和代码段，改了同步改脚本和 SKILL.md §3.4。

## 用法

```bash
set GITHUB_TOKEN=ghp_xxx
set GITEE_TOKEN=xxx
runtime\python\python\python.exe release_upload.py
# Token 都没设时只打包不上传 (方便调试)
```

## 脚本流程

1. 环境校验（拦截 Python 2.7）+ 读 `launcher.py GREEN_VERSION`（唯一来源）
2. Python zipfile 打 Online 绿色版（`zipfile.ZIP_DEFLATED, compresslevel=6`）
3. GitHub：查 Release → 创建或复用 → urllib 直传 zip → 失败自动 fallback `curl.exe`
4. Gitee：查 Release → 创建或复用 → 手动构建 `multipart/form-data`（access_token + file）

## 打包规则配置区

```python
INCLUDE_ITEMS = [          # 必须包含的根目录项 (改了同步改 SKILL.md §3.4 清单)
    "DSH_Launcher.exe", "DSH_Update.exe", "DSH_Launcher.ico",
    "launcher.py", "update_agent.py", "desktop-shell.py",
    "config.json", "start.bat", "stop.bat",
    "plugins", "pages", "skills",
    "README.md", "README_EN.md", "LICENSE", "DEV_NOTES.md",
]

EXCLUDE_SUBDIRS = {        # os.walk 遍历时直接跳过的子目录
    ".git", ".trae", "build", "dist", "workspace", "__pycache__", "runtime",
    "node_modules",
}

EXCLUDE_FILENAMES = {      # 单独排除的文件名
    "release_upload.py", "build_exe.bat", ".gitignore", "_pack_online.py",
}

EXCLUDE_EXTS = {           # 排除的扩展名
    ".pyc", ".pyo", ".pdb", ".spec", ".log", ".tmp", ".bak",
}
```

## 打包核心逻辑

```python
def pack_online_zip(version):
    date_str = datetime.datetime.now().strftime("%Y%m%d")
    zip_name = "DSH_Launcher_GreenPortable_Online_%s_v%s.zip" % (date_str, version)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for item in INCLUDE_ITEMS:
            if os.path.isfile(full_path):
                zf.write(full_path, item)
            elif os.path.isdir(full_path):
                for dirpath, dirnames, filenames in os.walk(full_path):
                    dirnames[:] = [d for d in dirnames if d not in EXCLUDE_SUBDIRS]
                    for fname in filenames:
                        if should_exclude_path(rel_file, fname): continue
                        zf.write(full_file, rel_file)
    zip_size = os.path.getsize(zip_path)
    if zip_size > 95 * 1024 * 1024: print("[⚠] 接近 Gitee 100MB 限制!")
    return zip_path
```

## GitHub 上传（urllib + curl.exe fallback）

```python
# 优先 Python urllib 直传 (Content-Type: application/zip + 原始二进制)
# 踩坑: PowerShell Invoke-RestMethod 构建 multipart 会报 GetBytes chars null
#      Python urllib 直接 POST 原始二进制最稳, 失败再 fallback curl.exe
def github_upload_asset(token, release_id, file_path):
    # 先删同名旧资产 (避免重复)
    # urllib POST 原始二进制
    status, resp = http_request(upload_url, method="POST", data=file_data, headers=headers)
    if status not in (200, 201):
        return run_curl_upload(upload_url, token, file_path)  # fallback
```

## Gitee 上传（手动 multipart/form-data）

```python
# Gitee 要求 access_token + file 两个 form 字段
# 手动构建 multipart body, 比第三方库更可控
boundary = "----TraeBoundary7MA4YWxkTrZu0gW"
body  = ("--%s\r\n" % boundary).encode()
body += b'Content-Disposition: form-data; name="access_token"\r\n\r\n'
body += token.encode() + b"\r\n"
body += ("--%s\r\n" % boundary).encode()
body += ('Content-Disposition: form-data; name="file"; filename="%s"\r\n' % fname).encode()
body += b"\r\n" + file_data + b"\r\n"
body += ("--%s--\r\n" % boundary).encode()
```

## 8 条避坑清单

| # | 坑 | 解法 |
|---|-----|------|
| 1 | 系统 `python` 是 2.7 → 中文报 Non-ASCII | 脚本首行 `# -*- coding: utf-8 -*-` + 自动检测版本拦截 |
| 2 | PowerShell 构建 multipart → `GetBytes chars null` | GitHub 用 urllib 直传二进制，失败 fallback `curl.exe` |
| 3 | 上传前 zip 被清理 → 找不到文件 | 脚本内置打包，不依赖外部 zip |
| 4 | 版本号不同步 → zip 里旧版 | 统一从 `launcher.py GREEN_VERSION` 读，禁止硬编码 |
| 5 | Gitee 100MB 超限 | Online 版排除 `runtime/`，压缩后 ~17MB |
| 6 | `.bat` 中文乱码 | 全部 ASCII 编码保存 |
| 7 | PowerShell 转义地狱 | 复杂逻辑放 Python，PS 只做简单调用 |
| 8 | Release tag 与版本不一致 | 一条龙：读版本 → 生成 tag → 创建 Release → 上传 |

## 实测数据

Online 版打包结果：82 文件 / 18.4 MB 原始 / 17.1 MB 压缩。
