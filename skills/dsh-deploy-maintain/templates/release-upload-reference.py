#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
发布脚本实现参考 (release_upload.py 代码速查)

角色分工 (与 release-workflow.md 互相补充, 不重复):
  - release-workflow.md      = 操作者流程指南: 怎么一步步发版 (顺序/验收/双平台踩坑)
  - 本文件 (本文档)          = 脚本实现参考: release_upload.py 内部怎么写、为什么这么写
                              (代码段、配置区、实现层坑)。给改脚本的人看。

用途: 本文件是可读的代码速查骨架, 不是可直接运行的脚本;
      真正的脚本是项目根目录 release_upload.py。改脚本逻辑同步更新本文件。

注意: 以下代码块为参考片段 (省略上下文与依赖定义), 摘录自真实脚本核心逻辑。
"""

# ============================================================
# 一、脚本职责链路
# ============================================================
# release_upload.py 整合了"打包 + 校验 + 双平台上 传", 一条命令干完:
#
#   env 校验 → 读 GREEN_VERSION(唯一来源) → 新鲜度校验 → 回写版本日期
#          → 打 zip → 校验 zip → GitHub(create/upload) → Gitee(create/upload)
#
# 入口无 flag: 内部先打包再上传。
# 注意不要先 --pack-only 再 --upload-only (见 workflow 新鲜度竞态)。


# ============================================================
# 二、打包规则配置区 (改了这里注意与 zip 内容 / verify 期望同步)
# ============================================================
INCLUDE_ITEMS = [  # 必须包含的根目录项 (要进 zip 的顶层文件/目录)
    "DSH_Launcher.exe", "DSH_Update.exe", "DSH_Launcher.ico",
    "launcher.py", "update_agent.py", "desktop-shell.py",
    "config.json", "start.bat", "stop.bat",
    "plugins", "pages", "skills",
    "README.md", "README_EN.md", "LICENSE", "DEV_NOTES.md",
]

EXCLUDE_SUBDIRS = {  # os.walk 遍历时直接跳过的子目录
    ".git", ".trae", "build", "dist", "workspace", "__pycache__", "runtime",
    "node_modules",
}

EXCLUDE_FILENAMES = {  # 单独排除的文件名
    "release_upload.py", "build_exe.bat", ".gitignore", "_pack_online.py",
}

EXCLUDE_EXTS = {  # 排除的扩展名
    ".pyc", ".pyo", ".pdb", ".spec", ".log", ".tmp", ".bak",
}

# 绿色版 zip 排除 runtime/ (数据与已装环境), 体积压到 ~17MB,
# 规避 Gitee 100MB / GitHub 2GB 限制。


# ============================================================
# 三、打包核心逻辑
# ============================================================
def pack_online_zip(version, zip_path):
    """打 Online 绿色版 zip。zip 文件名固定 DSH-GreenPortable-v{ver}.zip
    (GREEN_ZIP_PREFIX 在 launcher.py 定义)。"""
    import zipfile
    import os

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for item in INCLUDE_ITEMS:
            full_path = os.path.join(os.getcwd(), item)
            if os.path.isfile(full_path):
                zf.write(full_path, item)
            elif os.path.isdir(full_path):
                for dirpath, dirnames, filenames in os.walk(full_path):
                    dirnames[:] = [d for d in dirnames if d not in EXCLUDE_SUBDIRS]
                    for fname in filenames:
                        rel_file = os.path.join(dirpath, fname)
                        if should_exclude_path(rel_file, fname):
                            continue
                        zf.write(full_file, rel_file)
    zip_size = os.path.getsize(zip_path)
    if zip_size > 95 * 1024 * 1024:
        print("[warning] 接近 Gitee 100MB 限制!")
    return zip_path


def should_exclude_path(rel_file, fname):
    """按 EXCLUDE_FILENAMES / EXCLUDE_EXTS 判断是否排除。"""
    import os
    if fname in EXCLUDE_FILENAMES:
        return True
    ext = os.path.splitext(fname)[1].lower()
    if ext in EXCLUDE_EXTS:
        return True
    return False


# 打包/解压侧都要做的 zip 安全校验:
#   - 解压防 zip-slip: 逐成员 normpath 拒绝 "../" 或绝对路径
#   - 检查"内容根目录是否存在外层文件夹" (兼容带/不带)


# ============================================================
# 四、GitHub 上传 (urllib 直传 + curl.exe fallback)
# ============================================================
# 实现层坑: PowerShell Invoke-RestMethod 构建 multipart 会报 GetBytes chars null
#           → 用 Python urllib 直接 POST 原始二进制最稳, 失败再 fallback curl.exe
def github_upload_asset(token, release_id, file_path):
    """上传 zip 到 GitHub Release。先删同名旧资产, 再 urllib POST 原始二进制。"""
    import urllib.parse

    fname = os.path.basename(file_path)
    mime = "application/zip"
    # upload_url 去掉 {?name,label} 后再拼 ?name=xxx.zip
    upload_url = (
        "https://uploads.github.com/repos/%s/%s/releases/%d/assets?name=%s"
        % (GITHUB_OWNER, GITHUB_REPO, release_id, urllib.parse.quote(fname))
    )
    file_data = open(file_path, "rb").read()
    headers = {
        "Authorization": "Bearer " + token,
        "Accept": "application/vnd.github+json",
        "Content-Type": mime,
    }
    status, resp = http_request(upload_url, method="POST", data=file_data, headers=headers)
    if status not in (200, 201):
        return run_curl_upload(upload_url, token, file_path)  # fallback
    return resp


# ============================================================
# 五、Gitee 上传 (手动 multipart/form-data)
# ============================================================
# Gitee 要求 access_token + file 两个 form 字段; 手动构建比第三方库更可控。
# 字段名必须是单数 "file" (用 "files" 报 {"messages":["file is missing"]})
def gitee_upload_asset(token, release_id, zip_path):
    """上传 zip 到 Gitee Release。返回是否成功 (release_upload 内部复用)。"""
    fname = os.path.basename(zip_path)
    file_data = open(zip_path, "rb").read()

    boundary = "----TraeBoundary7MA4YWxkTrZu0gW"
    body = ("--%s\r\n" % boundary).encode()
    body += b'Content-Disposition: form-data; name="access_token"\r\n\r\n'
    body += token.encode() + b"\r\n"
    body += ("--%s\r\n" % boundary).encode()
    body += ('Content-Disposition: form-data; name="file"; filename="%s"\r\n' % fname).encode()
    body += b"\r\n" + file_data + b"\r\n"
    body += ("--%s--\r\n" % boundary).encode()
    # POST %s% headers Content-Type: multipart/form-data; boundary=...
    return True


# ============================================================
# 六、Gitee create/edit Release (关键实现差异)
# ============================================================
# Gitee create/edit Release 只解析 application/x-www-form-urlencoded 表单,
# 不解析 JSON body。用 JSON 会让中文 name/body 乱码或丢失。
# 正确做法: payload urlencode 成表单, 设:
#     Content-Type: application/x-www-form-urlencoded; charset=utf-8
# 已有封装 http_request_form()。GitHub 侧继续用 JSON。
#
# 另: Gitee 首次发新 tag 时 target_commitish 必须传分支名 "master" (不能传尚不存在的
#     tag 名, 否则 HTTP 400); GitHub 建 Release 须 draft:false (默认 draft 用户看不到)。


# ============================================================
# 七、踩坑清单 (分"实现层"与"流程/操作层")
# ============================================================
# ---- 实现层专属 (改脚本才涉及) ----
#   1. 系统 python 是 2.7 → 中文报 Non-ASCII
#      解法: 脚本首行 # -*- coding: utf-8 -*- + 自动版本拦截
#   2. PowerShell 构建 multipart → GetBytes chars null
#      解法: GitHub 用 urllib 直传二进制, 失败 fallback curl.exe
#   3. Gitee create/edit 中文 name/body 乱码
#      解法: 必须 form-urlencoded 通道 http_request_form(), 不能用 JSON
#   4. Gitee attach_files 报 "file is missing"
#      解法: multipart 字段名是单数 "file" 不是 "files"
#   5. 上传前 zip 被清理 → 找不到文件
#      解法: 脚本内置打包, 不依赖外部 zip
#   6. 版本号不同步 → zip 里旧版
#      解法: 统一从 launcher.py GREEN_VERSION 读, 禁止硬编码
#   7. .bat 中文乱码
#      解法: 全部 ASCII 编码保存
#   8. PowerShell 转义地狱
#      解法: 复杂逻辑放 Python, PS 只做简单调用
#
# ---- 流程/操作层 (发版时看 release-workflow.md, 不在此重复) ----
#   新版 windowed exe 验证、新鲜度竞态、Gitee target_commitish、GitHub draft、
#   发布后 mtime 无 diff — 统一收敛在 release-workflow.md 阶段③-⑤。