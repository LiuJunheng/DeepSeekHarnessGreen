# -*- coding: utf-8 -*-
"""
DeepSeek Harness 桌面绿色整合版启动器 (Python 标准库实现, 无第三方依赖)

作用:
    1. 自动检测 / 下载便携版 Node.js 到 runtime/node
    2. 自动在 runtime/dsh 下本地安装 @deepseek-ai/dsh 包
    3. 启动 dsh web 本地服务, 并按默认打开方式打开界面 (独立桌面窗口/网页窗口)
    4. 提供 tkinter 图形界面 (启动 / 停止 / 桌面窗口 / 网页窗口 / 日志)
    5. 所有数据 (Node, dsh, DSH_HOME) 都放在本目录 runtime 下, 完全绿色便携
    6. WebUI 单页面去重: 向前端注入心跳脚本, 自动打开时检测到界面已打开就不再重复
       打开新页面; 手动点「打开界面」不受此限制, 必定打开新页面

用法:
    python launcher.py           # 启动图形界面 (默认)
    python launcher.py --start   # 无界面模式: 准备环境 + 启动服务
    python launcher.py --stop    # 停止服务
    python launcher.py --purge-session <会话ID>   # 永久删除一个会话 (需先停止服务)
    python launcher.py --purge-archived           # 永久删除所有已归档会话 (需先停止服务)
    python launcher.py --restore-session <会话ID> # 复原(取消归档)一个会话 (需先停止服务)
    python launcher.py --install-plugin <本地插件目录或npm包名>  # 安装插件 (重启服务后生效)
    python launcher.py --remove-plugin <包名>     # 移除插件 (重启服务后生效)
"""

import os
import sys
import json
import time
import re
import shutil
import socket
import struct
import hashlib
import zlib
import webbrowser
import threading
import subprocess
import urllib.request
import urllib.parse
import zipfile
import tarfile
import ssl
import http.server
import secrets
import ctypes
from ctypes import wintypes

# ---------------------------------------------------------------------------
# 常量与路径
# ---------------------------------------------------------------------------
def get_base_dir():
    """程序根目录: 源码模式取脚本所在目录, 打包为 exe 后取 exe 所在目录
    (PyInstaller 的 onefile 模式下 __file__ 指向临时解压目录 _MEIPASS, 不能作为基准)"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


BASE_DIR = get_base_dir()                              # 程序根目录
RUNTIME_DIR = os.path.join(BASE_DIR, "runtime")        # 运行时目录
NODE_DIR = os.path.join(RUNTIME_DIR, "node")           # 便携 Node 目录
PYTHON_DIR = os.path.join(RUNTIME_DIR, "python")       # 内置便携 Python 目录
DSH_DIR = os.path.join(RUNTIME_DIR, "dsh")             # dsh 本地安装目录
DSH_HOME_DIR = os.path.join(RUNTIME_DIR, "dsh-home")   # dsh 数据目录(会话/配置)
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")    # 配置文件
PID_FILE = os.path.join(RUNTIME_DIR, "server.pid")     # 服务进程号文件
LOG_FILE = os.path.join(RUNTIME_DIR, "server.log")     # 服务运行日志


def get_icon_path():
    """图标文件路径 (DSH_Launcher.ico, 绿色小鲸鱼):
    打包为 exe 后图标经 --add-data 打进临时解压目录 _MEIPASS, 源码模式在程序根目录。
    找不到时返回 None, 由调用方优雅降级到默认图标。"""
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            candidate = os.path.join(meipass, "DSH_Launcher.ico")
            if os.path.exists(candidate):
                return candidate
    candidate = os.path.join(BASE_DIR, "DSH_Launcher.ico")
    return candidate if os.path.exists(candidate) else None


# 主窗口标题 (单实例检测时按此标题查找已运行窗口, 与 run_gui 中 root.title 保持一致)
WINDOW_TITLE = "DeepSeek Harness 桌面绿色整合版启动器"
# 单实例互斥量名称 (exe 版与源码版共用同名, 保证全局只允许一个启动器实例)
SINGLE_INSTANCE_MUTEX = "DSH_Launcher_GreenPortable_SingleInstance"
ERROR_ALREADY_EXISTS = 183              # CreateMutexW 返回该错误码表示互斥量已存在
_SINGLE_INSTANCE_MUTEX_HANDLE = None    # 模块级持有互斥量句柄, 防止被 GC 提前释放

# 桌面版 (desktop-shell.py) 是"固定单实例程序"的身份标记常量:
# 它启动时把自身 PID 写入 desktop_shell.pid, launcher 读该文件 + 校验进程存活即判定其在线,
# 用于排重, 不再依赖 WebUI 心跳 (网页版才需要心跳)。窗口标题与 desktop-shell.py 保持一致。
DESKTOP_WINDOW_TITLE = "DeepSeek Harness 桌面版"
DESKTOP_SHELL_PID_FILE = os.path.join(RUNTIME_DIR, "desktop_shell.pid")
STILL_ACTIVE = 259          # GetExitCodeProcess 返回该值表示进程仍在运行
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def _acquire_single_instance(mutex_name=SINGLE_INSTANCE_MUTEX):
    """创建命名互斥量实现单实例 (2026-08-16):
    返回 (句柄, is_new_instance)。
    - is_new_instance=True  : 本实例是第一个, 应继续正常启动;
    - is_new_instance=False : 已有实例在运行, 调用方应激活旧窗口后退出。
    句柄必须由调用方在程序整个生命周期内持有 (存到模块级
    _SINGLE_INSTANCE_MUTEX_HANDLE), 否则 Python 释放句柄后互斥量对象
    消失, 之后再开的实例会误判为第一个, 单实例形同虚设。
    创建失败(句柄为 0, 极罕见)时降级放行, 仅失去单实例保证, 不影响启动。"""
    kernel32 = ctypes.windll.kernel32
    # 显式设置函数签名, 避免 64 位系统下句柄/返回值被 ctypes 截断
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR]
    kernel32.GetLastError.restype = ctypes.c_ulong
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel32.CreateMutexW(None, False, mutex_name)   # 默认安全属性 + 不初始占有
    if not handle:
        return None, True   # 创建失败(罕见), 降级放行
    error_code = kernel32.GetLastError()
    if error_code == ERROR_ALREADY_EXISTS:
        return handle, False   # 已有实例在运行
    return handle, True        # 本实例是第一个


def _activate_existing_launcher(window_title=WINDOW_TITLE):
    """把已运行的启动器窗口调到前台并恢复显示 (2026-08-16):
    覆盖两种状态: 正常显示 (被遮挡/最小化到任务栏/托盘图标在但窗口最小化)。
    新实例是当前前台进程, 可合法将前台让给旧窗口,
    故 SetForegroundWindow 通常有效, 再以 BringWindowToTop 兜底。"""
    user32 = ctypes.windll.user32
    user32.FindWindowW.restype = wintypes.HWND
    user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
    user32.ShowWindow.restype = wintypes.BOOL
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.SetForegroundWindow.restype = wintypes.BOOL
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.BringWindowToTop.argtypes = [wintypes.HWND]
    hwnd = user32.FindWindowW(None, window_title)
    if not hwnd:
        return False
    user32.ShowWindow(hwnd, 9)   # SW_RESTORE=9: 同时恢复最小化与隐藏(withdraw)状态
    user32.SetForegroundWindow(hwnd)
    user32.BringWindowToTop(hwnd)
    return True

# 默认配置 (用户可在 config.json 中覆盖)
DEFAULT_CONFIG = {
    "mirror": "auto",            # 镜像: auto=自动检测 / cn=国内 / official=官方
    "node_version": "22.20.0",   # 便携 Node 版本号
    "python_version": "3.10.20", # 内置便携 Python 版本号 (python-build-standalone)
    "python_release": "20260807",# python-build-standalone 发布标签(日期)
    "dsh_port": 3080,            # dsh web 服务端口
    "dsh_host": "127.0.0.1",     # dsh web 服务绑定地址: "127.0.0.1"=仅本机 / "0.0.0.0"=局域网可访问
    "trusted_hosts": [],         # 受信任主机列表 (host 或 host:port); 空=局域网模式自动信任全部局域网, 非空=只信任填写的
    "dsh_package": "@deepseek-ai/dsh",   # dsh 包名
    # 启动服务后是否自动打开 WebUI 页面 (False 则只启动服务, 需手动点「桌面窗口/网页窗口」)
    "auto_open_browser": True,
    # 打开界面的默认方式: "desktop"=独立桌面窗口(内嵌 WebView2, 完全脱离浏览器) /
    # "browser"=系统浏览器网页窗口。自动打开与「桌面窗口/网页窗口」都沿用该默认, 也可单独指定。
    "open_method": "desktop",
    # WebUI 页面心跳上报端口: 页面打开后会定期向该端口上报心跳,
    # 启动器据此判断"界面已打开"并避免重复打开新页面 (详见 UI_ALIVE_WINDOW)
    "ui_beacon_port": 3081,
    # 临时目录: 空=默认(runtime/tmp, 绿色便携); 高级用户可自定义为任意绝对路径
    # (注意: 若某会话的工作区包含该路径, dsh 的 Windows ACL 沙箱会拒绝)
    "tmp_dir": "",
    # 默认工作区: 空=自动解析(见 resolve_default_workspace, 不写死);
    # 高级用户可自定义为任意绝对路径, 若与临时目录冲突会自动回退并警告
    "default_workspace": "",
    # 注: 绿色版版本号统一以 GREEN_VERSION 常量为准 (唯一来源, 见 green_local_version)。
    # 曾把 "green_version" 默认值写在这里, 发布新版本时与常量不同步,
    # 导致本地一直显示旧版本号并反复提示更新 (见 DEV_NOTES 需求 #20)。
    # 用户如需特殊覆盖, 可直接在 config.json 里显式写 "green_version" 字段。
}

# 各平台 Node 压缩包的文件名规则 (node-v{version}-{platform}-{arch}.{ext})
NODE_PLATFORM = {
    "win32": "win-x64",
    "darwin": "darwin-x64",
    "linux": "linux-x64",
}[sys.platform if sys.platform in ("win32", "darwin", "linux") else "linux"]
NODE_ARCHIVE_EXT = ".zip" if sys.platform == "win32" else ".tar.gz"

# 下载源 (国内镜像 / 官方源)
NODE_URL_TEMPLATE = {
    "cn": "https://registry.npmmirror.com/-/binary/node/v{version}/node-v{version}-{platform}{ext}",
    "official": "https://nodejs.org/dist/v{version}/node-v{version}-{platform}{ext}",
}
NPM_REGISTRY = {
    "cn": "https://registry.npmmirror.com",
    "official": "https://registry.npmjs.org",
}

# 内置便携 Python 下载源 (python-build-standalone, 完整发行自带 tkinter)
# 文件名规则: cpython-{version}+{release}-x86_64-pc-windows-msvc-install_only.tar.gz
PYTHON_ARCHIVE_TEMPLATE = "cpython-{version}+{release}-x86_64-pc-windows-msvc-install_only.tar.gz"
PYTHON_URL_TEMPLATE = {
    "cn": "https://mirror.nju.edu.cn/github-release/astral-sh/python-build-standalone/{release}/{archive}",
    "official": "https://github.com/astral-sh/python-build-standalone/releases/download/{release}/{archive}",
}

# dsh 包的 bin 入口文件 (相对 DSH_DIR)
DSH_BIN_JS = os.path.join("node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")

# 服务就绪检查的超时时间 (秒)
SERVER_READY_TIMEOUT = 120

# 默认 profile (插件管理的目标 profile, 对应 dsh --profile web)
DEFAULT_PROFILE = "web"

# ---------------------------------------------------------------------------
# WebUI 单页面去重 (检测"界面已在浏览器中打开"则不再重复打开新页面)
# 原理: 启动器向 WebUI 前端 index.html 注入一小段心跳脚本, 页面打开后每
# UI_BEACON_PING_INTERVAL 秒向启动器的本地心跳服务上报一次; 启动器在自动打开
# 浏览器前检查: 若最近 UI_ALIVE_WINDOW 秒内收到过心跳, 说明界面已打开, 跳过。
# 该去重只按"同一种方式"进行: 若当前默认打开方式(桌面窗/网页窗)已有页面在运行,
# 则跳转/复用该页面, 绝不另开; 另一种方式不自动打开 (open_ui 内部统一拦截)。
# dsh 升级重装后由 patch_frontend() 自动重新注入 (见 install_dsh 末尾)。
# ---------------------------------------------------------------------------
UI_BEACON_PORT = 3081            # 心跳上报端口 (config.json 的 ui_beacon_port 可覆盖)
UI_BEACON_PING_INTERVAL = 15     # 页面心跳上报间隔 (秒)
UI_ALIVE_WINDOW = 180            # 最近 N 秒内有心跳即视为界面已打开 (容忍后台标签页定时器节流)
UI_BEACON_PATH = "/__dsh_ui_alive"            # 心跳上报路径
UI_BEACON_TOKEN_FILE = os.path.join(RUNTIME_DIR, "ui-beacon.token")   # 心跳令牌文件 (防伪造上报)
UI_BEACON_MARKER_START = "<!-- dsh-launcher-ui-beacon:start -->"     # 注入标记(起)
UI_BEACON_MARKER_END = "<!-- dsh-launcher-ui-beacon:end -->"         # 注入标记(止)
# crypto.randomUUID polyfill 注入标记 (局域网 http 访问不是 secure context, 该 API 缺失,
# 见 2026-08-18 需求 #47; 用 getRandomValues 兜底实现 RFC4122 v4, 幂等可重复)
UI_UUID_MARKER_START = "<!-- dsh-launcher-uuid-polyfill:start -->"   # 注入标记(起)
UI_UUID_MARKER_END = "<!-- dsh-launcher-uuid-polyfill:end -->"       # 注入标记(止)

# GitHub 官方 dsh 插件话题页 (插件发现入口, 仅作辅助来源; 国内网络可能无法直连)
GITHUB_TOPIC_URL = "https://github.com/topics/dsh-plugin"

# ---------------------------------------------------------------------------
# 绿色版外围更新通道 (本项目自己的 GitHub Release)
# 与官方核心更新(update_dsh, 动 runtime/dsh)完全独立: 本通道只更新项目根目录的外围文件,
# 绝不触碰 runtime/(用户数据与已装环境), 也不替换用户自定义的 config.json。
# 发布流程: 打 tag v{GREEN_VERSION} + Release 资产 DSH_Launcher_GreenPortable_Online_<日期>_v<tag>.zip
# ---------------------------------------------------------------------------
GITHUB_REPO = "LiuJunheng/DeepSeekHarnessGreen"    # 本绿色版仓库 (owner/repo)
GREEN_VERSION = "1.0.22"                           # 绿色版版本号 (与 Release tag 一致, 不含 v 前缀)
GREEN_VERSION_DATE = "2026年08月29日"               # 绿色版版本日期 (build_release_zip.py 会按构建当天回写)
GREEN_RELEASE_API = ("https://api.github.com/repos/%s/releases/latest"
                     % GITHUB_REPO)                # GitHub 官方 Releases API
GREEN_RELEASE_MIRROR = ("https://mirror.nju.edu.cn/github-release/%s/latest"
                        % GITHUB_REPO)             # 国内镜像 (与其它下载源镜像一致)
GREEN_ZIP_PREFIX = "DSH_Launcher_GreenPortable_Online_"   # Release 分发 zip 资产名前缀

# Gitee 镜像兜底通道 (GitHub Release / 国内镜像都连不通时, 自动转 Gitee), 两级策略:
#   1. Gitee Release 优先: 查 GITEE_RELEASES_API 找"最新且带手动上传 zip 附件"的发布版,
#      附件下载走 releases/download/<tag>/<file> 直连 (2026-08-18 实测返回真实 zip, 不走挑战页),
#      来源标记 source="gitee_release"。注意附件必须 URL 含 /releases/download/, 否则会误选
#      Gitee 自动生成的 tag 源码包 (archive/refs/tags/...zip, 仍是 JS 挑战页) —— 见避坑 #71。
#   2. 无 Release/无附件回退整仓快照: 版本号从 master 分支 launcher.py 源码提取 GREEN_VERSION,
#      下载 = git 智能 HTTP 协议克隆整仓 (见 green_gitee_clone_tree):
#      Gitee 的 archive zip 地址 (repository/archive/master.zip) 会返回带 JS 轮询
#      的挑战页, 纯 urllib 拿不到真实 zip; 改用 /info/refs + /git-upload-pack
#      拉取 pack 并解析对象, 等价拿到整仓文件 (2026-08-18 已验证)
#   - 整仓内容会比 GitHub 发货清单多出 DEV_NOTES.md / .gitignore,
#     由 update_agent.py 的 overlay_copy 统一排除 (与 GitHub 通道一致)
GITEE_REPO = "liujunheng/DeepSeekHarnessGreen"     # Gitee 仓库 (owner/repo, Gitee 全小写)
GITEE_BRANCH = "master"                            # Gitee 仓库默认分支
GITEE_ARCHIVE_URL = ("https://gitee.com/%s/repository/archive/%s.zip"
                     % (GITEE_REPO, GITEE_BRANCH))  # 整仓 zip (仅供界面展示/手动提示, 下载不走它)
GITEE_RAW_LAUNCHER_URL = ("https://gitee.com/%s/raw/%s/launcher.py"
                          % (GITEE_REPO, GITEE_BRANCH))  # 读取 GREEN_VERSION
GITEE_RELEASES_API = ("https://gitee.com/api/v5/repos/%s/releases"
                      % GITEE_REPO)  # Gitee 发布版列表 (公开读无需令牌)
GITEE_REPO_PAGE_URL = "https://gitee.com/%s" % GITEE_REPO  # Gitee 仓库主页 (失败手动提示)
GREEN_HOME_PAGE_URL = "https://liujunheng.github.io/DeepSeekHarnessGreen/"  # 发布主页 (GitHub Pages, About 里跳转)

# 「加载推荐」一键展示的 dsh 插件列表 (按社区目录站 dsh-plugins.top / awesome-deepseek-harness / 官方 dsh-plugin 话题筛选出的高口碑款, 2026-08 底校准)
# 字段说明: name=展示名; category=分类(显示在「分类」列); source=来源平台(github/npm, 与搜索项统一, 显示在「来源」列);
#   description=一句话功能; spec=真实安装标识(以 github: 开头走 GitHub 仓库安装, 否则按 npm 包名装);
#   version 统一填显示值 "latest", 表示安装时自动取最新版
# 提示: 第三方插件即以本机身份运行, 装前请先看源码
RECOMMENDED_PLUGINS = [
    {"name": "modlens", "category": "视觉", "source": "npm", "version": "latest",
     "spec": "@liustack/modlens",
     "description": "首个视觉插件: 图片粘贴进对话即转结构化证据读图识图、理解 UI"},
    {"name": "dsh-web", "category": "Web UI", "source": "github", "version": "latest",
     "spec": "github:zhu1090093659/dsh-web",
     "description": "Web 聚合生态包: 任务看板 / Git 图谱 / 皮肤中心 / 鲸鱼娘宠物等界面全家桶"},
    {"name": "DSH-better-sidebar", "category": "Web UI", "source": "github", "version": "latest",
     "spec": "github:omdsh-dev/DSH-better-sidebar",
     "description": "开放侧边栏工作台: 文件渲染编辑 / 终端 / Git / 侧边对话 / 子智能体"},
    {"name": "dsh-desktop", "category": "桌面", "source": "github", "version": "latest",
     "spec": "github:dataelement/dsh-desktop",
     "description": "把 DSH 封装成原生桌面应用: 系统托盘常驻、独立窗口"},
    {"name": "deepseek-harness-desktop", "category": "桌面", "source": "github", "version": "latest",
     "spec": "github:anywhere-labs/deepseek-harness-desktop",
     "description": "桌面端封装, 生态星标最高: 系统托盘常驻、独立窗口"},
    {"name": "dsh-TUI", "category": "终端", "source": "github", "version": "latest",
     "spec": "github:ccch1mneyyy/dsh-TUI",
     "description": "Claude Code 风全屏终端 TUI: 纯键盘流 / 流式思考 / 上下文进度"},
    {"name": "dsh-market", "category": "商店", "source": "github", "version": "latest",
     "spec": "github:dsh-market/dsh-market",
     "description": "内置可视化插件市场: 浏览 / 搜索 / 按已装项推荐 / 一键安装 (建议第一个装)"},
    {"name": "dsh-anchored-standard", "category": "预设", "source": "github", "version": "latest",
     "spec": "github:xiaobright/dsh-anchored-standard",
     "description": "两阶段预设: 先最小对齐引导、再挂全量标准工具集"},
    {"name": "modsearch", "category": "搜索", "source": "github", "version": "latest",
     "spec": "github:liustack/modsearch",
     "description": "联网实时搜索、引用来源, 与 modlens 同作者配套使用"},
    {"name": "dsh-agent-teams", "category": "Agent", "source": "github", "version": "latest",
     "spec": "github:NanmiCoder/dsh-agent-teams",
     "description": "多智能体并行拆解大任务、协作交付框架"},
    {"name": "Aegis", "category": "Agent", "source": "github", "version": "latest",
     "spec": "github:GanyuanRan/Aegis",
     "description": "架构感知: 基线优先、证据验证、漂移检查, 让 Agent 长任务更稳"},
    {"name": "DeepSeek-Balance-Whale-Widget", "category": "趣味", "source": "github", "version": "latest",
     "spec": "github:MeteorNOX/DeepSeek-Balance-Whale-Widget",
     "description": "界面右下角小鲸鱼娘盯 DeepSeek 账户余额: 数字滚动动画、可拖拽"},
    {"name": "dsh-safeguard", "category": "安全", "source": "npm", "version": "latest",
     "spec": "dsh-safeguard",
     "description": "零配置安全: 危险命令 (rm -rf / push --force) 与密钥泄漏执行前拦截"},
    {"name": "dsh-handoff", "category": "工具", "source": "npm", "version": "latest",
     "spec": "dsh-handoff",
     "description": "零配置: 会话交接一键导出 (决策/已完成/未完成/下一步), 不调模型零成本"},
    {"name": "dsh-http", "category": "工具", "source": "npm", "version": "latest",
     "spec": "dsh-http",
     "description": "零配置: 结构化 HTTP 请求, JSON 自动解析、截断保护"},
    {"name": "dsh-fmt", "category": "工具", "source": "npm", "version": "latest",
     "spec": "dsh-fmt",
     "description": "零配置: JSON/YAML/TOML/SQL 格式化与校验"},
    {"name": "dsh-clipboard", "category": "工具", "source": "npm", "version": "latest",
     "spec": "dsh-clipboard",
     "description": "零配置: 长文本一键进系统剪贴板"},
    {"name": "dsh-fetch-file", "category": "工具", "source": "npm", "version": "latest",
     "spec": "dsh-fetch-file",
     "description": "零配置: URL 下载文件进工作区, 二进制流式落盘、路径围栏"},
    {"name": "dsh-jwt", "category": "工具", "source": "npm", "version": "latest",
     "spec": "dsh-jwt",
     "description": "零配置: JWT 解码调试, payload/过期判断"},
    {"name": "dsh-cron-parse", "category": "工具", "source": "npm", "version": "latest",
     "spec": "dsh-cron-parse",
     "description": "零配置: cron 表达式解析 / 人性化 / 未来 N 次预览"},
    {"name": "dsh-when", "category": "工具", "source": "npm", "version": "latest",
     "spec": "dsh-when",
     "description": "零配置: 自然语言相对时间 转 ISO 时间"},
    {"name": "dsh-url-tools", "category": "工具", "source": "npm", "version": "latest",
     "spec": "dsh-url-tools",
     "description": "零配置: URL 解析 / 去 UTM 跟踪参数 / 编解码 / 短链展开"},
    {"name": "dsh-password", "category": "工具", "source": "npm", "version": "latest",
     "spec": "dsh-password",
     "description": "零配置: 强密码 / diceware 口令生成, 标注熵值"},
    {"name": "dsh-dead-links", "category": "工具", "source": "npm", "version": "latest",
     "spec": "dsh-dead-links",
     "description": "零配置: Markdown 文档死链检查, HEAD 降级 GET、限流并发"},
    {"name": "dsh-pkg-info", "category": "工具", "source": "npm", "version": "latest",
     "spec": "dsh-pkg-info",
     "description": "零配置: npm / PyPI 包版本、依赖、发布时间查询"},
    {"name": "dsh-case", "category": "工具", "source": "npm", "version": "latest",
     "spec": "dsh-case",
     "description": "零配置: 命名大小写转换 (camel/Pascal/snake/kebab 等 8 风格)"},
]

# ---------------------------------------------------------------------------
# 绿色便携: 所有缓存/配置/临时目录全部重定向到本程序 runtime 下,
# 避免 npm/pnpm/临时文件写到用户主目录 (~/.npm, ~/.pnpm-store 等)
# ---------------------------------------------------------------------------
NPM_CACHE_DIR = os.path.join(RUNTIME_DIR, "npm-cache")      # npm 下载缓存
NPM_USER_CONFIG = os.path.join(RUNTIME_DIR, "npm-userconfig")  # npm 用户配置文件(本地空文件)
PNPM_HOME_DIR = os.path.join(RUNTIME_DIR, "pnpm-home")      # pnpm 全局 home (插件管理)
PNPM_STORE_DIR = os.path.join(RUNTIME_DIR, "pnpm-store")    # pnpm 内容寻址存储
TMP_DIR = os.path.join(RUNTIME_DIR, "tmp")
GREEN_UPDATE_DIR = os.path.join(RUNTIME_DIR, "update")      # 绿色版更新暂存目录 (zip/解压/job/备份)
BACKUP_DIR = os.path.join(RUNTIME_DIR, "backup")            # 统一备份目录 (dsh 旧版本备份等)
# 默认工作区子目录名: 仅在"程序根目录包含临时目录"(绿色便携默认形态)冲突时,
# 才把它作为默认工作区使用; 不冲突时默认工作区直接用程序根目录本身,
# 由 resolve_default_workspace() 自动判定, 不再写死完整路径。
DEFAULT_WORKSPACE_SUBDIR = "workspace"


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
class UiBeaconHandler(http.server.BaseHTTPRequestHandler):
    """WebUI 心跳接收服务 (本地 127.0.0.1, 仅接收带正确令牌的上报)。
    页面注入的脚本每 UI_BEACON_PING_INTERVAL 秒 GET 一次 UI_BEACON_PATH?t=<令牌>;
    服务记录最近一次上报时间, 供 ui_is_open() 判断界面是否已在浏览器中打开。"""

    token = ""        # 由 _ensure_ui_beacon_server 注入当前令牌
    on_ping = None     # 回调: on_ping(unix_timestamp)

    def do_GET(self):
        try:
            parsed = urllib.parse.urlsplit(self.path)
            if parsed.path == UI_BEACON_PATH:
                query = urllib.parse.parse_qs(parsed.query)
                if query.get("t") == [self.token] and self.on_ping is not None:
                    self.on_ping(time.time())
            self.send_response(204)
            self.end_headers()
        except Exception:
            # 心跳失败不影响页面, 静默忽略
            try:
                self.send_response(204)
                self.end_headers()
            except Exception:
                pass

    def log_message(self, _format, *args):
        """关闭默认访问日志 (心跳每 15 秒一次, 避免刷屏)"""
        pass


class Launcher:
    """封装所有业务逻辑, 界面与命令行模式共用"""

    def __init__(self, on_log=None):
        self.config = self.load_config()
        self.on_log = on_log or (lambda message: None)
        self.server_process = None      # 当前管理的服务进程
        self.server_stdin = None        # 服务进程的 stdin 管道 (保持打开, 防止 dsh 因 EOF 退出)
        self.server_thread = None       # 服务输出读取线程
        self._stopping_server = False   # 标记"正在主动停止", 用于区分意外退出
        self._beacon_server = None      # WebUI 心跳接收服务 (http.server 实例)
        self._last_ui_ping = None       # 最近一次收到 WebUI 心跳的时间戳 (None=从未收到)

    # ---------- 日志 ----------
    def log(self, message):
        """输出日志 (带时间戳), 交给界面显示"""
        line = "[%s] %s" % (time.strftime("%H:%M:%S"), message)
        self.on_log(line)

    # ---------- 配置 ----------
    def load_config(self):
        """读取 config.json, 不存在则使用默认配置"""
        config = dict(DEFAULT_CONFIG)
        if os.path.exists(CONFIG_PATH):
            try:
                with open(CONFIG_PATH, "r", encoding="utf-8") as file_handle:
                    saved = json.load(file_handle)
                config.update(saved)
            except Exception as error:
                self.log("读取配置失败, 使用默认配置: %s" % error)
        return config

    def save_config(self):
        """保存配置到 config.json"""
        try:
            with open(CONFIG_PATH, "w", encoding="utf-8") as file_handle:
                json.dump(self.config, file_handle, ensure_ascii=False, indent=2)
            self.log("配置已保存: %s" % CONFIG_PATH)
        except Exception as error:
            self.log("保存配置失败: %s" % error)

    # ---------- 镜像选择 ----------
    def resolve_mirror(self):
        """根据配置决定使用哪个镜像, 返回 (name, 是否自动检测)"""
        mirror = self.config.get("mirror", "auto")
        if mirror in ("cn", "official"):
            return mirror, False
        return "cn", True     # auto 默认先试国内

    # ---------- 路径查找 ----------
    def find_node_exe(self):
        """在 runtime/node 下查找便携版 node 可执行文件, 找不到返回 None"""
        if not os.path.isdir(NODE_DIR):
            return None
        for entry_name in os.listdir(NODE_DIR):
            entry_path = os.path.join(NODE_DIR, entry_name)
            if sys.platform == "win32":
                candidate = os.path.join(entry_path, "node.exe")
            else:
                candidate = os.path.join(entry_path, "bin", "node")
            if os.path.isfile(candidate):
                return candidate
        return None

    def find_python_exe(self):
        """在 runtime/python 下查找内置便携版 python 可执行文件, 找不到返回 None
        兼容两种布局: 顶层直接是 python.exe, 或顶层有子目录(如 python/ / cpython-xxx/) 内含 python.exe"""
        if not os.path.isdir(PYTHON_DIR):
            return None
        top_exe = os.path.join(PYTHON_DIR, "python.exe")
        if os.path.isfile(top_exe):
            return top_exe
        for entry_name in sorted(os.listdir(PYTHON_DIR)):
            entry_path = os.path.join(PYTHON_DIR, entry_name)
            if os.path.isdir(entry_path):
                candidate = os.path.join(entry_path, "python.exe")
                if os.path.isfile(candidate):
                    return candidate
        return None

    def find_npm_cli(self):
        """在便携 Node 目录下查找 npm-cli.js, 找不到返回 None
        注意: Linux/Mac 的 tar.gz 里 node 在 bin/ 下、npm 在 lib/node_modules/npm;
              Windows 的 zip 里 node.exe 在顶层、npm 在 node_modules/npm,
              两者的 node 发行根目录取法不同, 需要按平台区分"""
        node_exe = self.find_node_exe()
        if node_exe is None:
            return None
        # Windows: node.exe 直接位于发行根目录, 根目录 = node.exe 所在目录
        # Linux/Mac: node 位于 bin/ 子目录, 根目录 = node.exe 上两级目录
        if sys.platform == "win32":
            node_root = os.path.dirname(node_exe)
        else:
            node_root = os.path.dirname(os.path.dirname(node_exe))
        candidates = [
            os.path.join(node_root, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
            os.path.join(node_root, "node_modules", "npm", "bin", "npm-cli.js"),
        ]
        for candidate in candidates:
            if os.path.isfile(candidate):
                return candidate
        return None

    def node_bin_dir(self):
        """返回便携 Node 的 bin 目录 (用于加入 PATH 环境变量)"""
        node_exe = self.find_node_exe()
        if node_exe is None:
            return None
        return os.path.dirname(node_exe)

    def dsh_installed(self):
        """判断 dsh 是否已本地安装"""
        return os.path.isfile(os.path.join(DSH_DIR, DSH_BIN_JS))

    # ---------- 环境准备 ----------
    def prepare_python(self):
        """确保内置便携 Python 就绪, 缺失则自动下载 (供 start.bat 下次优先使用)
        返回 True 表示内置 Python 已就绪, False 表示下载失败(此时只做日志警示,
        不抛异常, 因为 dsh 服务本身由 Node 运行, 缺失内置 Python 不影响启动服务)。
        注意: 当前进程可能正由系统 Python 运行, 这里补齐的是"下次启动"用的内置解释器"""
        if self.find_python_exe() is not None:
            return True
        python_version = self.config.get("python_version", "3.10.20")
        python_release = self.config.get("python_release", "20260807")
        self.log("未检测到内置便携 Python, 开始自动下载 (版本 %s, 完整版自带 tkinter) ..."
                 % python_version)
        os.makedirs(PYTHON_DIR, exist_ok=True)
        archive_name = PYTHON_ARCHIVE_TEMPLATE.format(
            version=python_version, release=python_release)
        archive_path = os.path.join(RUNTIME_DIR, archive_name)
        # 依次尝试 国内镜像 -> GitHub (自动模式), 或仅尝试指定源。
        # 重点避坑 (2026-08-17): python 的国内源是 mirror.nju.edu.cn, 在部分机器/网络上
        # 会 SSL 握手失败 (实测 curl 退出码 35 / urllib 报 Errno 2), 而 Node/npm 的国内源
        # registry.npmmirror.com 是正常的。因此内置 python 下载**无条件**把官方 GitHub 源
        # 作为最后兜底, 即使 config.mirror="cn" 也要试 official, 避免"国内源失败就整体失败
        # 且无任何官方回退"。去重后确定源顺序。
        resolved_mirror, mirror_is_auto = self.resolve_mirror()
        if mirror_is_auto or resolved_mirror == "cn":
            source_order = ["cn", "official"]
        else:
            source_order = ["official"]
        source_order = list(dict.fromkeys(source_order))   # 去重, 保留顺序
        last_error = None
        for source in source_order:
            url = PYTHON_URL_TEMPLATE[source].format(
                release=python_release,
                archive=urllib.parse.quote(archive_name, safe=""))
            self.log("正在从 [%s] 下载便携 Python: %s" % (source, url))
            try:
                self.download_with_progress(url, archive_path)
                self.log("下载完成, 正在解压 ...")
                # python-build-standalone 的压缩包是 .tar.gz, 与 Node 的 zip 不同, 需用 tarfile
                with tarfile.open(archive_path, "r:gz") as tar_handle:
                    # Python >= 3.12 的 tarfile 才支持 filter 参数(默认 data, 防路径逃逸/净化元数据);
                    # 内置便携 Python 是 3.10 (不支持 filter), 而 start.bat 可能用系统 python 兜底。
                    # 按版本判断: 高版本显式传 filter 消除 3.14 的 DeprecationWarning, 低版本则省略,
                    # 避免在 3.10 上传 filter 报 TypeError。
                    if sys.version_info >= (3, 12):
                        tar_handle.extractall(PYTHON_DIR, filter="data")
                    else:
                        tar_handle.extractall(PYTHON_DIR)
                if os.path.exists(archive_path):
                    os.remove(archive_path)      # 清理压缩包
                python_exe = self.find_python_exe()
                if python_exe is not None:
                    self.log("内置便携 Python 就绪: %s" % python_exe)
                    return True
                raise RuntimeError("解压后未找到 python.exe")
            except Exception as error:
                last_error = error
                self.log("从 [%s] 下载失败: %s" % (source, error))
                if os.path.exists(archive_path):
                    os.remove(archive_path)
        self.log("便携 Python 自动下载失败: %s (可在 start.bat 里仍使用系统 Python, 或手动放入 runtime/python)"
                 % last_error)
        return False

    def prepare_node(self):
        """确保便携版 Node 就绪, 缺失则自动下载"""
        node_exe = self.find_node_exe()
        if node_exe is not None:
            self.log("Node 已就绪: %s" % node_exe)
            return node_exe

        self.log("未检测到便携版 Node, 开始自动下载 (版本 v%s) ..." % self.config["node_version"])
        os.makedirs(NODE_DIR, exist_ok=True)

        archive_name = "node-v%s-%s%s" % (
            self.config["node_version"], NODE_PLATFORM, NODE_ARCHIVE_EXT)
        archive_path = os.path.join(NODE_DIR, archive_name)

        # 依次尝试 国内 -> 官方 (自动模式), 或仅尝试指定源
        source_order = ["cn", "official"] if self.resolve_mirror()[1] else [self.resolve_mirror()[0]]
        last_error = None
        for source in source_order:
            url = NODE_URL_TEMPLATE[source].format(
                version=self.config["node_version"], platform=NODE_PLATFORM, ext=NODE_ARCHIVE_EXT)
            self.log("正在从 [%s] 下载 Node: %s" % (source, url))
            try:
                self.download_with_progress(url, archive_path)
                self.log("下载完成, 正在解压 ...")
                self.extract_archive(archive_path, NODE_DIR)
                self.log("Node 解压完成")
                if os.path.exists(archive_path):
                    os.remove(archive_path)      # 清理压缩包
                node_exe = self.find_node_exe()
                if node_exe is not None:
                    return node_exe
                raise RuntimeError("解压后未找到 node 可执行文件")
            except Exception as error:
                last_error = error
                self.log("从 [%s] 下载失败: %s" % (source, error))
                if os.path.exists(archive_path):
                    os.remove(archive_path)

        raise RuntimeError("Node 下载失败: %s" % last_error)

    def download_with_progress(self, url, target_path):
        """带进度提示的下载 (使用 urllib, 无第三方依赖)"""
        # 宽松 SSL 上下文, 避免个别镜像证书问题
        ssl_context = ssl.create_default_context()
        request = urllib.request.Request(url, headers={"User-Agent": "DSH-Launcher/1.0"})
        with urllib.request.urlopen(request, context=ssl_context, timeout=60) as response:
            total_size = int(response.headers.get("Content-Length", 0))
            downloaded = 0
            with open(target_path, "wb") as file_handle:
                while True:
                    chunk = response.read(1024 * 256)
                    if not chunk:
                        break
                    file_handle.write(chunk)
                    downloaded += len(chunk)
                    if total_size > 0:
                        percent = int(downloaded * 100 / total_size)
                        self.log("下载进度: %d%% (%d / %d KB)" % (
                            percent, downloaded // 1024, total_size // 1024))

    def extract_archive(self, archive_path, target_dir):
        """解压 zip 或 tar.gz 到目标目录"""
        if sys.platform == "win32":
            with zipfile.ZipFile(archive_path, "r") as zip_handle:
                zip_handle.extractall(target_dir)
        else:
            with tarfile.open(archive_path, "r:gz") as tar_handle:
                tar_handle.extractall(target_dir)

    def _stream_subprocess(self, command, cwd, env, timeout=None, log_prefix="",
                           heartbeat_interval=None):
        """以"实时逐行输出"方式运行子进程, 避免长时间无提示被误认为卡死.

        相比 subprocess.run 的一次性捕获 (装完才显示最后几行), 本方法在子进程
        运行时逐行把输出打到日志 (GUI 日志框 / 命令行终端), 让 npm/pnpm 安装
        与插件命令执行的进度实时可见, 也便于确认进程没有卡住或报错。
        返回 (退出码, 完整输出文本);
        timeout 超时则终止进程并抛 subprocess.TimeoutExpired (与 subprocess.run 一致)。
        log_prefix: 每行日志前附加的来源前缀, 如 "npm: " / "plugin: "。

        heartbeat_interval: 可选, 秒数 (如 15)。某些阶段子进程长时间只做本地 I/O
        (如 npm 抓完元数据后的 reify/安装链接阶段, http 日志级别没有任何网络请求
        输出), 日志会长时间静默、看着像卡死。开启后, 只要子进程仍在运行、且太久
        没有新输出, 就由本方法定时打一条"已运行 N 秒, 仍在执行"的心跳日志, 让用户
        确认没有卡住。默认 None = 不开启。
        """
        process = subprocess.Popen(
            command, cwd=cwd, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace")
        collected_lines = []
        read_errors = []
        started_time = time.time()
        last_output_time = [started_time]
        alive_flag = [True]

        def read_output():
            """后台线程持续读取子进程输出: 逐行写日志并收集, 防止管道写满阻塞"""
            try:
                for line in process.stdout:
                    text = line.rstrip("\r\n")
                    if text.strip():
                        collected_lines.append(text)
                        self.log("%s%s" % (log_prefix, text))
                        last_output_time[0] = time.time()
            except Exception as error:
                read_errors.append(error)

        def heartbeat():
            """子进程仍在运行但长时间无新输出时, 定时打心跳, 避免被误判为卡死"""
            if not heartbeat_interval or heartbeat_interval <= 0:
                return
            while alive_flag[0] and process.poll() is None:
                time.sleep(max(1.0, float(heartbeat_interval)))
                if not alive_flag[0] or process.poll() is not None:
                    break
                # 仅在"确实静默超过间隔"时才打一条, 正常有输出时不打扰
                if time.time() - last_output_time[0] >= heartbeat_interval:
                    self.log("%s[进度] 已运行 %d 秒, 命令仍在执行 (暂无新输出, 请继续等待) ..."
                             % (log_prefix, int(time.time() - started_time)))
                    last_output_time[0] = time.time()   # 重置, 避免每轮重复刷屏

        reader_thread = threading.Thread(target=read_output, daemon=True)
        reader_thread.start()
        if heartbeat_interval and heartbeat_interval > 0:
            heartbeat_thread = threading.Thread(target=heartbeat, daemon=True)
            heartbeat_thread.start()
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise
        finally:
            alive_flag[0] = False   # 结束心跳线程
        # 极少数情况: 子进程派生的孙进程仍持有输出管道句柄, 导致管道未到 EOF,
        # 读取线程会一直阻塞; 这里限时等待, 不阻塞主流程 (输出内容已完整收集)。
        reader_thread.join(timeout=5)
        return process.returncode, "\n".join(collected_lines)

    def install_dsh(self, package_spec=None):
        """执行 dsh 的 npm 安装 (仅负责安装, 不判断是否已存在)
        package_spec: 默认为 self.config["dsh_package"] (即装 latest);
                     可传 "@deepseek-ai/dsh@<版本>" 或 "@deepseek-ai/dsh@next" 指定版本/标签。
        返回 True 表示安装成功; 供 prepare_dsh 首次安装与 update_dsh 更新时复用"""
        if package_spec is None:
            package_spec = self.config["dsh_package"]
        self.log("开始安装 %s ..." % package_spec)
        os.makedirs(DSH_DIR, exist_ok=True)
        self.ensure_runtime_dirs()

        # 优先用便携 Node 自带的 npm; 否则退回系统 node/npm
        npm_cli = self.find_npm_cli()
        node_exe = self.find_node_exe()
        # 通用安装参数: 所有缓存/配置都落在本地 runtime, 不写用户主目录
        install_options = [
            "--prefix", DSH_DIR,
            "--cache", NPM_CACHE_DIR,
            "--userconfig", NPM_USER_CONFIG,
            "--no-audit", "--no-fund",
            # 关键: 我们以"管道方式"运行 npm (非 TTY)。此时 npm 默认日志级别的下载
            # 过程输出会被抑制, 装完才丢一行汇总, 导致安装期间日志框毫无动静、像卡死。
            # http 级别会让每个包的 HTTP 下载完成时实时吐一行, 让进度可见; 又不会像
            # verbose 那样刷爆日志框/拖卡 GUI (下载并行, 每秒约几行, 平滑可控)。
            "--loglevel=http",
        ]
        if npm_cli is not None and node_exe is not None:
            self.log("使用便携 Node 自带的 npm 进行安装")
            command = [node_exe, npm_cli, "install"] + install_options + [package_spec]
        else:
            self.log("使用系统 npm 进行安装 (请确保已安装 Node.js)")
            command = ["npm", "install"] + install_options + [package_spec]

        # 根据镜像配置附加 registry 参数
        mirror, is_auto = self.resolve_mirror()
        if not is_auto:
            registry = NPM_REGISTRY[mirror]
            command.append("--registry=%s" % registry)
            self.log("使用镜像源: %s" % registry)

        env = self.build_env()
        self.log("正在安装 dsh (首次安装可能需要几分钟, 请耐心等待; npm 输出会实时显示, 请留意进度) ...")
        return_code, _output = self._stream_subprocess(
            command, cwd=DSH_DIR, env=env, log_prefix="npm: ",
            # 60s 空闲心跳: npm 抓完元数据后的 reify/安装链接阶段是纯本地 I/O,
            # http 日志无网络输出会长时间静默, 心跳可让用户确认没卡死 (@see 需求 #59)。
            # 默认 60 秒一次即可, 太频繁会刷屏 (2026-08-20 用户: 15s 改 60s)。
            heartbeat_interval=60)

        if return_code != 0 or not self.dsh_installed():
            raise RuntimeError("dsh 安装失败, 请检查网络后重试 (详见上方 npm 输出)")

        self.log("dsh 安装成功 (版本: %s)" % self.dsh_version())
        self.patch_frontend()   # 安装/升级后注入 WebUI 心跳脚本 (单页面去重)
        self.patch_frontend_uuid()  # 安装/升级后注入 crypto.randomUUID polyfill (局域网 http 用)
        self.patch_web_startup()  # 安装/升级后补丁 startup.js, 放开 --host 0.0.0.0 (局域网访问)
        self.patch_lan_trust()    # 安装/升级后补丁 resolveLanTrust, 支持「只信任填写的主机」
        # 局域网 /api 补丁 (pickDirectory 等特权 API 不再 403)。失败时给出醒目提示,
        # 不让用户"装了才发现局域网用不了" (2026-08-17, 避坑 #56)。
        lan_api_patched = self.patch_lan_api_trust()
        if not lan_api_patched:
            self.log("[警告] client-connection 局域网补丁未生效: 局域网模式 /api 可能报 403 "
                     "(本机模式不受影响); 可稍后重启服务重试, 或等 dsh 更新后再装一次环境")
        return True

    def prepare_dsh(self, force=False, package_spec=None):
        """确保 dsh 已本地安装, 缺失则自动 npm install
        参数 force: True 时即使已安装也强制重装 (用于「更新」场景)
        参数 package_spec: 传给 install_dsh 的包规格 (默认 None 装 latest)"""
        if not force and self.dsh_installed():
            self.log("dsh 已就绪: %s" % os.path.join(DSH_DIR, DSH_BIN_JS))
            return True
        if force:
            self.log("检测到强制更新, 开始重装 dsh ...")
        else:
            self.log("未检测到 dsh, 开始自动安装 %s ..." % self.config["dsh_package"])
        return self.install_dsh(package_spec=package_spec)

    def _npm_view(self, npm_cli, node_exe, package_spec, query):
        """执行一次 npm view 查询, 返回原始输出文本; 失败返回 None。
        供 dsh_latest_version / dsh_dist_tags 复用 (镜像参数与安装一致)。
        query 可为 "version" 单值, 也可为 "dist-tags --json" 多 token (按空格拆成独立 argv)"""
        query_args = (query or "").split()
        if not query_args:
            self.log("npm view 查询参数为空")
            return None
        command = [node_exe, npm_cli, "view", package_spec] + query_args
        # 根据镜像配置附加 registry 参数 (与安装一致)
        mirror, is_auto = self.resolve_mirror()
        if not is_auto:
            command.append("--registry=%s" % NPM_REGISTRY[mirror])
        env = self.build_env()
        try:
            result = subprocess.run(command, cwd=DSH_DIR, env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, encoding="utf-8", errors="replace",
                                    timeout=60)
            output = (result.stdout or "").strip()
            if result.returncode != 0 or not output:
                self.log("npm view 查询失败, 输出: %s" % (result.stdout or result.stderr or ""))
                return None
            return output
        except Exception as error:
            self.log("npm view 查询失败: %s" % error)
            return None

    def dsh_latest_version(self):
        """查询 npm 上 @deepseek-ai/dsh 的 latest 标签版本号 (只读, 不改动本地)
        查询失败返回 None。注意: 官方 pre-release (如 rc.8) 常发在 next 标签上,
        用 dsh_dist_tags() 才能同时看到 latest 与 next。"""
        npm_cli = self.find_npm_cli()
        node_exe = self.find_node_exe()
        if npm_cli is None or node_exe is None:
            self.log("未找到便携 Node, 无法查询最新版本")
            return None
        self.log("正在查询 dsh 最新版本 ...")
        output = self._npm_view(npm_cli, node_exe,
                                self.config["dsh_package"], "version")
        if output:
            self.log("npm 上最新版本 (latest): %s" % output)
            return output
        return None

    def dsh_dist_tags(self):
        """查询 npm 上 @deepseek-ai/dsh 的 latest / next 两个 dist-tag 版本号。
        返回 dict {"latest": str|None, "next": str|None}; 整体失败返回 None。
        (官方发布策略: 一般正式在 latest, 预发布在 next)"""
        npm_cli = self.find_npm_cli()
        node_exe = self.find_node_exe()
        if npm_cli is None or node_exe is None:
            self.log("未找到便携 Node, 无法查询 dist-tags")
            return None
        self.log("正在查询 dsh 版本标签 (latest / next) ...")
        output = self._npm_view(npm_cli, node_exe,
                                self.config["dsh_package"], "dist-tags --json")
        if not output:
            return None
        try:
            tags = json.loads(output)
        except Exception as error:
            self.log("解析 dist-tags 失败: %s, 原始: %s" % (error, output))
            return None
        result = {
            "latest": tags.get("latest"),
            "next": tags.get("next"),
        }
        self.log("npm dist-tags: latest=%s next=%s"
                 % (result["latest"], result["next"]))
        return result

    def _dsh_tag_to_version(self, tag_name):
        """把官方 GitHub release tag 解析成版本号 (动态, 不写死标签)。
        兼容形态: dsh-v0.1.2-alpha.1 / v0.1.2-alpha.1 / 0.1.2-alpha.1;
        解析不出合法版本号返回 None (如 release 名字非版本形态)"""
        tag = (tag_name or "").strip()
        if not tag:
            return None
        lowered = tag.lower()
        if lowered.startswith("dsh-v"):
            tag = tag[5:]
        elif lowered.startswith("dsh"):
            tag = tag[3:]
        if tag.startswith("v"):
            tag = tag[1:]
        if not tag or not re.match(r"^[\w.+-]+$", tag):
            return None
        return tag

    def dsh_github_releases(self, max_pages=5):
        """动态拉取官方 GitHub Releases 的**所有 tag** (分页, 不写死 latest/next)。
        官方发布策略: 正式/预发布都发在 GitHub Releases (tag 形如 dsh-v<version>),
        但**不一定同步发布到 npm** —— 本函数只负责列出所有 tag 及其发布说明,
        该版本是否已在 npm 可安装由 dsh_npm_versions() 另行判断。
        返回 list[dict] (按发布时间倒序, 最新在前):
        [{version, tag_name, prerelease, published_at, body}, ...];
        整体失败 (网络/解析) 返回 None"""
        owner = "deepseek-ai"
        repo = "deepseek-harness"
        all_releases = []
        page = 1
        try:
            while page <= max_pages:
                api_url = ("https://api.github.com/repos/%s/%s/releases"
                           "?per_page=100&page=%d" % (owner, repo, page))
                request = urllib.request.Request(
                    api_url, headers={"User-Agent": "DSH-Launcher/%s" % GREEN_VERSION})
                with urllib.request.urlopen(request, timeout=25) as response:
                    batch = json.loads(response.read().decode("utf-8"))
                if not batch:
                    break
                all_releases.extend(batch)
                if len(batch) < 100:
                    break
                page += 1
        except Exception as error:
            self.log("GitHub Releases 拉取失败: %s" % error)
            return None
        results = []
        for release in all_releases:
            tag_name = release.get("tag_name") or ""
            version = self._dsh_tag_to_version(tag_name)
            if not version:
                continue
            body = (release.get("body") or "").strip()
            max_len = 4000
            if len(body) > max_len:
                body = body[:max_len] + "\n...(发布说明过长已省略)"
            results.append({
                "version": version,
                "tag_name": tag_name,
                "prerelease": bool(release.get("prerelease")),
                "published_at": (release.get("published_at") or "").replace("T", " ")[:16],
                "body": body,
            })
        self.log("GitHub Releases 动态检测到 %d 个 tag, 最新: %s"
                 % (len(results), results[0]["version"] if results else "无"))
        return results

    def dsh_npm_versions(self):
        """查询 npm 上 @deepseek-ai/dsh 的**全部已发布版本号** (动态, 不写死)。
        与 dsh_dist_tags (latest/next) 不同, 这里拿到完整版本集合,
        用于判断某个 GitHub tag 对应的版本是否已发布到 npm (可安装)。
        返回 set[str]; 失败返回 None"""
        npm_cli = self.find_npm_cli()
        node_exe = self.find_node_exe()
        if npm_cli is None or node_exe is None:
            self.log("未找到便携 Node, 无法查询已发布版本")
            return None
        self.log("正在查询 npm 已发布版本列表 ...")
        output = self._npm_view(npm_cli, node_exe,
                                self.config["dsh_package"], "versions --json")
        if not output:
            return None
        try:
            versions = json.loads(output)
        except Exception as error:
            self.log("解析 npm versions 失败: %s, 原始: %s" % (error, output))
            return None
        result = set()
        for version in versions:
            if isinstance(version, str) and version.strip():
                result.add(version.strip())
        latest = sorted(result)[-1] if result else "无"
        self.log("npm 已发布版本 %d 个, 最新: %s" % (len(result), latest))
        return result

    def dsh_version_notes(self, version):
        """获取 @deepseek-ai/dsh@<version> 的更新说明, 供「确认升级」对话框展示
        (需求 #57)。
        官方在 GitHub Releases 发布每个版本并带发布说明 (release note body,
        tag 形如 dsh-v0.1.0-rc.X), 这是**更新描述的正确来源**; 而 npm readme 为空。
        因此: 1) 优先从 GitHub Releases 拉该版本的发布说明;
        2) 网络失败时才回退到 npm registry 元数据拼装 (描述/发布时间/主页)。
        返回 str; 两个来源均失败返回 None"""
        package_name = self.config["dsh_package"]
        self.log("正在获取 %s@%s 的更新说明 ..." % (package_name, version))

        # 1) 优先: GitHub Releases 的发布说明 (官方带 body)
        github_notes = self.dsh_version_notes_from_github(version)
        if github_notes:
            return github_notes
        self.log("GitHub 未取到 %s 的发布说明, 回退 npm 元数据" % version)

        # 2) 回退: npm registry 元数据拼装
        mirror, _is_auto = self.resolve_mirror()
        registry_root = NPM_REGISTRY[mirror]
        metadata_url = "%s/%s" % (registry_root, package_name)
        try:
            request = urllib.request.Request(
                metadata_url, headers={"User-Agent": "DSH-Launcher/%s" % GREEN_VERSION})
            with urllib.request.urlopen(request, timeout=30) as response:
                data = json.loads(response.read().decode("utf-8"))
        except Exception as error:
            self.log("获取版本元数据失败: %s" % error)
            return None
        description = data.get("description") or ""
        homepage = data.get("homepage") or ""
        publish_time = (data.get("time") or {}).get(version) or ""
        readme = data.get("readme") or ""
        lines = []
        if description:
            lines.append("描述: %s" % description)
        if publish_time:
            lines.append("发布时间: %s" % publish_time)
        if homepage:
            lines.append("主页: %s" % homepage)
        if readme:
            lines.append("说明:")
            max_len = 2000
            if len(readme) > max_len:
                readme = readme[:max_len] + "\n...(README 过长已省略)"
            lines.append(readme)
        else:
            lines.append("(未能获取该版本的发布说明, 可到主页查看官方文档。)")
        return "\n".join(lines)

    def dsh_version_notes_from_github(self, version):
        """从官方 GitHub Releases 读取指定版本 (tag 形如 dsh-v<version>) 的
        发布说明 (release body)。批量拉最近 Releases 再按 tag/name 匹配 version,
        避免硬编码 tag 前缀导致误判; 返回 str 或 None (含无权限/网络失败)"""
        owner = "deepseek-ai"
        repo = "deepseek-harness"
        api_url = ("https://api.github.com/repos/%s/%s/releases?per_page=30"
                   % (owner, repo))
        try:
            request = urllib.request.Request(
                api_url, headers={"User-Agent": "DSH-Launcher/%s" % GREEN_VERSION})
            with urllib.request.urlopen(request, timeout=25) as response:
                releases = json.loads(response.read().decode("utf-8"))
        except Exception as error:
            self.log("GitHub Releases 访问失败: %s" % error)
            return None
        target = version.lstrip("v")
        for release in releases:
            tag = self._dsh_tag_to_version(release.get("tag_name") or "")
            name = (release.get("name") or "").lstrip("v")
            if target in (tag, name):
                body = release.get("body") or ""
                if not body.strip():
                    self.log("版本 %s 的 GitHub Release body 为空" % version)
                    return None
                # 发布说明只取前段, 避免弹窗过长
                max_len = 6000
                if len(body) > max_len:
                    body = body[:max_len] + "\n...(正文过长已省略)"
                return body.strip()
        self.log("GitHub Releases 中未找到版本 %s" % version)
        return None

    def backup_dsh(self):
        """把当前已安装的 dsh 目录备份到统一备份目录 BACKUP_DIR/dsh-<版本> 下
        (不再散落在 runtime 根目录, 便于集中管理/一键清理)。
        返回备份目录绝对路径; 若当前未安装 dsh 返回 None"""
        if not self.dsh_installed():
            return None
        version = self.dsh_version()
        os.makedirs(BACKUP_DIR, exist_ok=True)
        backup_dir = os.path.join(BACKUP_DIR, "dsh-%s" % version)
        if os.path.exists(backup_dir):
            backup_dir = os.path.join(
                BACKUP_DIR, "dsh-%s-%s" % (version,
                                           time.strftime("%Y%m%d%H%M%S")))
        self.log("正在备份旧版本 dsh (%s) ..." % version)
        try:
            shutil.copytree(DSH_DIR, backup_dir)
            self.log("备份完成: %s" % backup_dir)
            return backup_dir
        except Exception as error:
            self.log("备份失败: %s" % error)
            return None

    def update_dsh(self, target_version=None):
        """更新 dsh 到目标版本: 先备份旧版, 再强制重装指定版本
        target_version: None 时装 latest (与旧行为一致); 否则装 target_version 对应版本。
        返回更新后的版本号; 失败抛出异常"""
        if target_version is None:
            latest = self.dsh_latest_version()
            if latest is None:
                raise RuntimeError("无法获取最新版本号, 更新已取消")
            package_spec = self.config["dsh_package"]
            self.log("当前版本: %s, 将更新到 latest: %s"
                     % (self.dsh_version(), latest))
        else:
            package_spec = "%s@%s" % (self.config["dsh_package"], target_version)
            self.log("当前版本: %s, 将更新到指定版本: %s"
                     % (self.dsh_version(), target_version))
        backup_dir = self.backup_dsh()
        if backup_dir is None:
            raise RuntimeError("备份旧版本失败, 已取消更新 (避免数据丢失)")
        # 备份成功后, 强制重装目标版本 (prepare_dsh 的 force 会跳过已存在检查)
        if not self.prepare_dsh(force=True, package_spec=package_spec):
            raise RuntimeError("dsh 重装失败, 更新已取消")
        self.log("更新完成, 当前版本: %s" % self.dsh_version())
        self.log("旧版本备份在: %s (可手动删除)" % backup_dir)
        return self.dsh_version()

    def cleanup_update_files(self):
        """清空绿色版更新目录 (runtime/update): 暂存 zip / 解压内容 / 覆盖前旧文件备份 / 更新任务文件。
        更新程序运行中时被锁定的文件会跳过 (不报错)。返回删除的文件/目录项数"""
        if not os.path.isdir(GREEN_UPDATE_DIR):
            self.log("更新目录不存在, 无需清理: %s" % GREEN_UPDATE_DIR)
            return 0
        removed_count = self._clear_directory_contents(GREEN_UPDATE_DIR)
        self.log("已清理更新目录: %s (删除 %d 项)" % (GREEN_UPDATE_DIR, removed_count))
        return removed_count

    def cleanup_backup_files(self):
        """清空统一备份目录 (runtime/backup) 与旧版散落在 runtime 根的 dsh-backup-* 目录
        (v1.0.x 时代的旧布局, 一并归入"备份"概念清理, 避免残留)。返回删除的文件/目录项数"""
        removed_count = 0
        if os.path.isdir(BACKUP_DIR):
            removed_count += self._clear_directory_contents(BACKUP_DIR)
        # 兼容旧布局: 清理 runtime 根下散落的 dsh-backup-* 目录 (新版本已统一进 BACKUP_DIR)
        if os.path.isdir(RUNTIME_DIR):
            for name in os.listdir(RUNTIME_DIR):
                if name.startswith("dsh-backup-"):
                    legacy_path = os.path.join(RUNTIME_DIR, name)
                    if os.path.isdir(legacy_path):
                        shutil.rmtree(legacy_path, ignore_errors=True)
                        removed_count += 1
        self.log("已清理备份目录: %s (删除 %d 项)" % (BACKUP_DIR, removed_count))
        return removed_count

    def _clear_directory_contents(self, target_dir):
        """清空目录内容 (保留目录本身), 返回删除的文件/目录项数。
        被占用的文件 (如更新程序运行中) 忽略不报错, 不阻断其余清理"""
        removed_count = 0
        for name in os.listdir(target_dir):
            entry_path = os.path.join(target_dir, name)
            try:
                if os.path.isdir(entry_path) and not os.path.islink(entry_path):
                    shutil.rmtree(entry_path, ignore_errors=True)
                else:
                    os.remove(entry_path)
                removed_count += 1
            except OSError:
                pass   # 文件被占用等, 跳过不阻断
        return removed_count

    def dsh_version(self):
        """读取已安装 dsh 的版本号"""
        try:
            package_path = os.path.join(DSH_DIR, "node_modules",
                                        "@deepseek-ai", "dsh", "package.json")
            with open(package_path, "r", encoding="utf-8") as file_handle:
                info = json.load(file_handle)
            return info.get("version", "未知")
        except Exception:
            return "未知"

    # ---------- 绿色版外围更新通道 (自更新, 与官方核心更新完全独立) ----------
    # 官方核心更新(update_dsh)动 runtime/dsh/ 目录; 本通道只更新项目根目录的外围文件
    # (launcher.py / DSH_Launcher.exe / 插件源码 / 文档等), 绝不触碰 runtime/(用户数据
    # 与已装环境) 与用户自定义的 config.json。两通道互不干扰、互不依赖。
    def _is_frozen(self):
        """判断当前是否以 exe 方式运行 (PyInstaller onefile)"""
        return getattr(sys, "frozen", False)

    def _green_version_tuple(self, version_text):
        """把 'v1.2.3' 之类的版本号拆成可比较的整数元组 (忽略非数字段, 兼容长短版本)"""
        parts = re.split(r"[^\d]+", (version_text or "").lstrip("v").strip())
        numbers = []
        for part in parts:
            if part.isdigit():
                numbers.append(int(part))
        return tuple(numbers)

    def _green_version_greater(self, left, right):
        """判断 left 版本是否大于 right 版本 (按数字分段比较, 不依赖字符串长度)"""
        return self._green_version_tuple(left) > self._green_version_tuple(right)

    def green_local_version(self):
        """当前绿色版本地版本号: 以 GREEN_VERSION 常量为准 (唯一来源)。

        仅当用户在 config.json 里显式写了 "green_version" 字段时才覆盖
        (直接读原始配置文件判断, 不读合并后的默认值, 避免默认值干扰版本比较)"""
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as file_handle:
                saved_config = json.load(file_handle)
            configured = saved_config.get("green_version") or ""
        except Exception:
            configured = ""
        if configured and str(configured).strip():
            return str(configured).strip()
        return GREEN_VERSION

    def green_latest_release(self):
        """查询本绿色版最新版本信息 (只读, 不改动本地)。

        通道优先级跟随下载源设置 (config.mirror) 分流 (用户需求 2026-08-20):
        - 官方源 (official)      : GitHub API -> 国内镜像 -> Gitee 兜底
        - 国内源 / 自动 (cn/auto) : Gitee 优先 (发布版 zip 直连) -> GitHub API ->
                                   国内镜像 兜底 (国内玩家默认走 Gitee 更快更稳)
        (Gitee 没有 Release 时从 master 分支 launcher.py 提取 GREEN_VERSION 当版本号,
        下载源是整仓 zip)。全部失败返回 None。
        返回 dict: tag_name / name / body / published_at / assets / source
        (source = "github" 或 "gitee"/"gitee_release", 供界面区分更新来源与手动提示地址)"""
        mirror, _is_auto = self.resolve_mirror()
        prefer_gitee = (mirror == "cn")   # auto 默认先试国内, 与 cn 同样优先 Gitee
        if prefer_gitee:
            # ---- 国内源/自动: 先试 Gitee (发布版 zip 直连, 国内快) ----
            gitee_info = self.green_gitee_latest()
            if gitee_info is not None:
                return gitee_info
            self.log("Gitee 优先通道不可用, 回退 GitHub 官方通道 ...")
        # ---- GitHub 官方通道 (含国内镜像) ----
        url_list = [GREEN_RELEASE_API, GREEN_RELEASE_MIRROR]
        ssl_context = ssl.create_default_context()
        for url in url_list:
            try:
                self.log("正在查询绿色版最新 Release: %s" % url)
                request = urllib.request.Request(
                    url, headers={"User-Agent": "DSH-Launcher/%s" % GREEN_VERSION})
                with urllib.request.urlopen(request, context=ssl_context, timeout=30) as response:
                    release_info = json.loads(response.read().decode("utf-8"))
                if release_info.get("tag_name"):
                    self.log("最新 Release: %s (发布时间: %s)" % (
                        release_info.get("tag_name"), release_info.get("published_at") or "未知"))
                    release_info["source"] = "github"
                    return release_info
                self.log("该地址返回的 Release 为空: %s" % url)
            except Exception as error:
                self.log("查询 Release 失败 [%s]: %s" % (url, error))
        if prefer_gitee:
            # 国内源/自动: Gitee 已先试过失败, 这里 GitHub 也失败 -> 整体不可达
            self.log("Gitee 与 GitHub Release 通道全部不可达, 无法获取最新版本")
            return None
        # 官方源: GitHub 与国内镜像都不可达 -> 自动切换 Gitee 整仓快照兜底
        self.log("GitHub Release 通道全部不可达, 自动切换 Gitee 镜像源 ...")
        return self.green_gitee_latest()

    def green_gitee_latest(self):
        """Gitee 兜底通道, 两级策略:
        1. Gitee Release 优先: GET GITEE_RELEASES_API (公开读无需令牌), 取最新带 .zip
           附件的发布版, 附件下载走 releases/download/<tag>/<file> 直连 (2026-08-18 已实测
           返回真实 zip, 不走 archive 挑战页)。返回 source="gitee_release"。
        2. 无 Release/无附件回退整仓快照: 读 master 分支 launcher.py 的 GREEN_VERSION
           当版本号, 下载源 = git 协议克隆整仓 (green_gitee_clone_tree)。
        返回与 green_latest_release 相同的 dict 结构; 全部失败返回 None"""
        # ---- 1. 优先查 Gitee Release (有 zip 附件则直接下载) ----
        release_info = self._gitee_release_latest()
        if release_info is not None:
            return release_info
        # ---- 2. 回退: 整仓快照 (git 协议克隆) ----
        try:
            self.log("Gitee 无可用 Release, 回退整仓快照: 读取 %s" % GITEE_RAW_LAUNCHER_URL)
            ssl_context = ssl.create_default_context()
            request = urllib.request.Request(
                GITEE_RAW_LAUNCHER_URL,
                headers={"User-Agent": "DSH-Launcher/%s" % GREEN_VERSION})
            with urllib.request.urlopen(request, context=ssl_context, timeout=30) as response:
                source_text = response.read().decode("utf-8", errors="replace")
            version_match = re.search(r'GREEN_VERSION\s*=\s*"([\d.]+)"', source_text)
            if not version_match:
                self.log("Gitee 源码里未找到 GREEN_VERSION, 无法判断版本")
                return None
            version = version_match.group(1)
            self.log("Gitee 镜像源最新版本: v%s (整仓快照)" % version)
            return {
                "tag_name": "v%s" % version,
                "name": "Gitee 整仓快照 v%s" % version,
                "body": "来自 Gitee 整仓快照 (GitHub 连不通且 Gitee 无 Release 时的兜底镜像源)。",
                "published_at": "",
                "assets": [{
                    "name": "DeepSeekHarnessGreen-%s.zip" % GITEE_BRANCH,
                    "browser_download_url": GITEE_ARCHIVE_URL,
                    "size": 0,   # 整仓 zip 无法预知大小, 传 0 跳过大小校验
                }],
                "source": "gitee",
            }
        except Exception as error:
            self.log("查询 Gitee 镜像源失败: %s" % error)
            return None

    def _gitee_release_latest(self):
        """查询 Gitee 发布版列表, 返回"最新且带 .zip 附件"的 release 信息。
        Gitee release 附件 (browser_download_url = releases/download/<tag>/<file>)
        已实测可直连下载 (不走 archive 挑战页), 上传需仓库主人在 Gitee 网页/API 操作。
        返回 dict (source="gitee_release", assets 含真实 zip 直连地址); 无可用返回 None"""
        try:
            self.log("正在查询 Gitee 发布版: %s" % GITEE_RELEASES_API)
            ssl_context = ssl.create_default_context()
            request = urllib.request.Request(
                # 带 per_page=100: Gitee /releases 默认每页 20 且按创建时间升序(旧->新),
                # 若发布数量超过默认页, 最新的会被截断, 必须拉全再自行降序。
                GITEE_RELEASES_API + "?per_page=100",
                headers={"User-Agent": "DSH-Launcher/%s" % GREEN_VERSION})
            with urllib.request.urlopen(request, context=ssl_context, timeout=30) as response:
                release_list = json.loads(response.read().decode("utf-8"))
            if not isinstance(release_list, list) or not release_list:
                self.log("Gitee 暂无发布版 (返回空列表)")
                return None
            # Gitee /releases 按创建时间升序(旧->新)返回, 直接顺序遍历会命中最早的
            # "带 zip 的发布"(如 v1.0.9), 导致明明有新版本却报"已是最新"。
            # 这里按 created_at 降序(新->旧)取第一个带可用 zip 的发布, 才符合"最新"语义。
            release_list = sorted(
                release_list,
                key=lambda rel: (rel.get("created_at") or ""),
                reverse=True)
            for item in release_list:
                tag_name = item.get("tag_name") or ""
                assets = item.get("assets") or []
                zip_asset = None
                for asset in assets:
                    asset_name = asset.get("name") or ""
                    download_url = asset.get("browser_download_url") or ""
                    # 只认"手动上传的附件" (releases/download/... 直连可下, 2026-08-18 实测);
                    # Gitee 自动生成的 tag 源码包 (archive/refs/tags/...zip) 会走挑战页,
                    # 拿不到真实 zip, 必须跳过
                    if (asset_name.lower().endswith(".zip")
                            and download_url
                            and "/releases/download/" in download_url):
                        zip_asset = asset
                        break
                if not zip_asset:
                    self.log("跳过 Gitee 发布版 %s (无手动上传的 zip 附件)" % (tag_name or "未知"))
                    continue
                self.log("Gitee 发布版最新版本: %s (附件 %s, 直连下载)"
                         % (tag_name, zip_asset.get("name")))
                return {
                    "tag_name": tag_name,
                    "name": item.get("name") or tag_name,
                    "body": item.get("body") or "来自 Gitee 发布版 (国内源优先时的首选镜像, 与 GitHub 发货内容一致)。",
                    "published_at": item.get("created_at") or "",
                    "assets": [{
                        "name": zip_asset.get("name"),
                        "browser_download_url": zip_asset.get("browser_download_url"),
                        "size": 0,   # Gitee 附件不返回大小, 传 0 跳过大小校验
                    }],
                    "source": "gitee_release",
                }
            self.log("Gitee 发布版列表无可用 zip 附件")
            return None
        except Exception as error:
            self.log("查询 Gitee 发布版失败: %s" % error)
            return None

    # ------------------------------------------------------------------
    # Gitee 整仓快照下载: git 智能 HTTP 协议克隆 (绕过 archive JS 挑战页)
    # ------------------------------------------------------------------
    def green_gitee_clone_tree(self, dest_dir):
        """通过 git 智能 HTTP 协议克隆 Gitee 仓库分支到 dest_dir。
        背景 (2026-08-18): Gitee 的 archive zip 地址 (repository/archive/master.zip)
        会返回带 JS 轮询的挑战页 (window._info / window._paths), 纯 urllib 拿不到
        真实 zip (checkURL 验证信息会过期)。改用 git 协议端点:
            1. GET  /<repo>.git/info/refs?service=git-upload-pack   取分支 head sha
            2. POST /<repo>.git/git-upload-pack                     取 pack 数据
            3. 解析 pack 对象 (含 REF_DELTA / OFS_DELTA 还原), 按 tree 落盘
        等价于下载整仓快照, 且只依赖标准库 (hashlib/struct/zlib/urllib)。
        返回落盘的文件数; 失败抛异常, 由调用方统一提示手动下载地址。
        本方法为只读远端操作, 不改动程序目录 (dest_dir 由调用方传入)"""
        # ---- 1. 取分支 head sha ----
        info_refs_url = ("https://gitee.com/%s.git/info/refs?service=git-upload-pack"
                         % GITEE_REPO)
        self.log("正在通过 git 协议获取 Gitee 仓库分支信息: %s" % info_refs_url)
        refs_data = self._gitee_http_get(info_refs_url)
        head_sha = self._gitee_refs_head_sha(refs_data, GITEE_BRANCH)
        if not head_sha:
            raise RuntimeError("Gitee 仓库未找到分支 %s" % GITEE_BRANCH)
        self.log("Gitee 分支 %s 最新提交: %s" % (GITEE_BRANCH, head_sha))
        # ---- 2. 拉取 pack ----
        upload_pack_url = "https://gitee.com/%s.git/git-upload-pack" % GITEE_REPO
        self.log("正在从 Gitee 拉取仓库数据 (pack) ...")
        pack_data = self._gitee_fetch_pack(upload_pack_url, head_sha)
        self.log("已获取 pack 数据 %.1f MB, 正在解析对象 ..." % (len(pack_data) / 1024.0 / 1024.0))
        # ---- 3. 解析对象 + checkout 落盘 ----
        file_count = self._gitee_checkout(head_sha, pack_data, dest_dir)
        self.log("Gitee 整仓克隆完成: 落盘 %d 个文件到 %s" % (file_count, dest_dir))
        return file_count

    def _gitee_http_get(self, url):
        """GET 请求 (git 协议端点), 返回响应字节; 失败抛异常"""
        ssl_context = ssl.create_default_context()
        request = urllib.request.Request(
            url, headers={"User-Agent": "DSH-Launcher/%s (git-upload-pack)"
                           % GREEN_VERSION})
        with urllib.request.urlopen(request, context=ssl_context, timeout=60) as response:
            return response.read()

    def _gitee_http_post_pack(self, url, payload):
        """POST git-upload-pack 请求, 返回响应字节; 失败抛异常"""
        ssl_context = ssl.create_default_context()
        request = urllib.request.Request(
            url, data=payload,
            headers={"User-Agent": "DSH-Launcher/%s (git-upload-pack)" % GREEN_VERSION,
                     "Content-Type": "application/x-git-upload-pack-request"})
        with urllib.request.urlopen(request, context=ssl_context, timeout=120) as response:
            return response.read()

    def _gitee_refs_head_sha(self, refs_data, branch_name):
        """解析 /info/refs 的 pkt-line 响应, 返回指定分支的 head sha (十六进制串);
        找不到返回空串"""
        lines, _ = self._gitee_pkt_lines(refs_data)
        for line in lines:
            text = line.decode("utf-8", "replace")
            if ("refs/heads/%s" % branch_name) in text:
                return text.split(" ", 1)[0].strip()
        return ""

    def _gitee_pkt_lines(self, data):
        """解析 pkt-line 流: 每行 = [4字节hex长度][内容(含结尾换行)]; 长度含 4 字节长度头。
        返回 (行内容列表, 解析结束位置)"""
        lines = []
        position = 0
        while position + 4 <= len(data):
            length = int(data[position:position + 4], 16)
            if length == 0:      # flush 空行
                position += 4
                continue
            position += 4
            lines.append(data[position:position + length - 4])
            position += length - 4
        return lines, position

    def _gitee_fetch_pack(self, upload_pack_url, head_sha):
        """构造 git upload-pack 请求体 (want + done), 拉取 pack 数据
        (响应里 NAK 之后的 PACK 段)"""
        want_line = ("want %s\n" % head_sha).encode("utf-8")
        # pkt-line: [4字节hex长度][内容]; 长度 = 4 + 内容字节数
        payload = b"%04x%s00000009done\n" % (len(want_line) + 4, want_line)
        response = self._gitee_http_post_pack(upload_pack_url, payload)
        pack_start = response.find(b"PACK")
        if pack_start < 0:
            raise RuntimeError("git 响应里没有 PACK 数据: %s" % response[:200])
        return response[pack_start:]

    def _gitee_parse_object_header(self, data, position):
        """读取 pack 对象头: 返回 (type, size, 内容起始位置)"""
        byte_value = data[position]
        position += 1
        object_type = (byte_value >> 4) & 7
        size = byte_value & 15
        shift = 4
        while byte_value & 0x80:
            byte_value = data[position]
            position += 1
            size |= (byte_value & 0x7F) << shift
            shift += 7
        return object_type, size, position

    def _gitee_read_varint_size(self, data, position):
        """git 对象头的大小字段 / delta 源目标大小: 小端 7bit 分组, 高位置续位。
        返回 (size, 读取后的新位置)"""
        shift = 0
        size = 0
        while True:
            byte_value = data[position]
            position += 1
            size |= (byte_value & 0x7F) << shift
            shift += 7
            if not byte_value & 0x80:
                break
        return size, position

    def _gitee_read_ofs_delta_offset(self, data, position):
        """ofs-delta 的负偏移编码: 大端 7bit 分组。返回 (offset, 读取后的新位置)"""
        offset = 0
        while True:
            byte_value = data[position]
            position += 1
            offset = (offset << 7) | (byte_value & 0x7F)
            if not byte_value & 0x80:
                break
        return offset, position

    def _gitee_object_hash(self, object_type_name, content):
        """计算 git 对象 sha1: sha1("<type> <size>\\0<content>")"""
        header = ("%s %d\0" % (object_type_name, len(content))).encode("ascii")
        return hashlib.sha1(header + content).digest()

    def _gitee_type_name(self, object_type):
        """pack 对象类型号 -> 类型名 (delta 还原后沿用基对象类型)"""
        return {1: "commit", 2: "tree", 3: "blob", 4: "tag"}.get(object_type, "blob")

    def _gitee_apply_delta(self, base_data, delta_data):
        """解 delta 指令流, 返回重建后的对象内容"""
        position = 0
        source_size, position = self._gitee_read_varint_size(delta_data, position)
        target_size, position = self._gitee_read_varint_size(delta_data, position)
        result = bytearray()
        while position < len(delta_data):
            opcode = delta_data[position]
            position += 1
            if opcode & 0x80:      # copy 指令: 从 base 复制
                copy_offset = 0
                copy_size = 0
                shift = 0
                for index in range(4):
                    if opcode & (1 << index):
                        copy_offset |= delta_data[position] << (index * 8)
                        position += 1
                for index in range(3):
                    if opcode & (0x10 << index):
                        copy_size |= delta_data[position] << (index * 8)
                        position += 1
                if copy_size == 0:
                    copy_size = 0x10000
                result.extend(base_data[copy_offset:copy_offset + copy_size])
            elif opcode:           # 插入指令: 字面量
                result.extend(delta_data[position:position + opcode])
                position += opcode
            else:
                raise RuntimeError("delta 指令流非法: opcode=0")
        return bytes(result)

    def _gitee_parse_pack(self, pack_data):
        """解析 pack 数据: 返回 raw_objects 列表, 每项 (type, payload, start_position)。
        payload 含义 (按类型区分):
            - 普通对象 (commit/tree/blob/tag): 解压后的完整内容
            - REF_DELTA (type 7): (base_sha20, delta解压数据)  前置 20 字节未压缩
            - OFS_DELTA (type 6): (offset, delta解压数据)      前置 varint 未压缩
        位置推进用 zlib 流实际消耗字节数 (zlib 流末尾后的剩余在 unused_data)"""
        if pack_data[:4] != b"PACK":
            raise RuntimeError("非法 pack 头")
        version, count = struct.unpack(">II", pack_data[4:12])
        if version not in (2, 3):
            raise RuntimeError("不支持的 pack 版本 %d" % version)
        position = 12
        raw_objects = []
        for index in range(count):
            start_position = position
            try:
                object_type, size, position = self._gitee_parse_object_header(
                    pack_data, position)
            except IndexError:
                raise RuntimeError("对象 %d 头部越界 (pos=%d total=%d)" % (
                    index, start_position, len(pack_data)))
            try:
                if object_type == 7:      # OBJ_REF_DELTA
                    base_sha = pack_data[position:position + 20]
                    if len(base_sha) < 20:
                        raise RuntimeError("对象 %d REF_DELTA 的 base sha 越界" % index)
                    position += 20
                    decompressor = zlib.decompressobj()
                    delta_data = decompressor.decompress(pack_data[position:])
                    consumed = len(pack_data) - position - len(decompressor.unused_data)
                    if consumed <= 0:
                        raise RuntimeError("对象 %d REF_DELTA 未消耗数据" % index)
                    position += consumed
                    payload = (base_sha, delta_data)
                elif object_type == 6:    # OBJ_OFS_DELTA
                    offset, position = self._gitee_read_ofs_delta_offset(
                        pack_data, position)
                    decompressor = zlib.decompressobj()
                    delta_data = decompressor.decompress(pack_data[position:])
                    consumed = len(pack_data) - position - len(decompressor.unused_data)
                    if consumed <= 0:
                        raise RuntimeError("对象 %d OFS_DELTA 未消耗数据" % index)
                    position += consumed
                    payload = (offset, delta_data)
                else:                     # 普通对象 (commit/tree/blob/tag)
                    decompressor = zlib.decompressobj()
                    content = decompressor.decompress(pack_data[position:])
                    consumed = len(pack_data) - position - len(decompressor.unused_data)
                    if consumed <= 0:
                        raise RuntimeError("对象 %d 未消耗数据" % index)
                    position += consumed
                    payload = content
            except zlib.error as error:
                raise RuntimeError("对象 %d 解压失败 (%s): pos=%d" % (
                    index, error, position))
            raw_objects.append((object_type, payload, start_position))
        return raw_objects

    def _gitee_checkout(self, head_sha, pack_data, dest_dir):
        """解析 pack 全部对象 (含 delta 还原), 按 head commit 的 tree 落盘到 dest_dir。
        返回落盘文件数"""
        raw_objects = self._gitee_parse_pack(pack_data)
        objects_by_sha = {}     # 20字节sha -> (type, content)
        objects_by_index = {}   # pack内序号 -> (type, content)
        pending_ref_delta = []  # [(index, base_sha, delta_data)]
        for index, (object_type, payload, start_position) in enumerate(raw_objects):
            if object_type == 7:      # REF_DELTA: 基对象可能后置, 进待解队列
                base_sha, delta_data = payload
                pending_ref_delta.append((index, base_sha, delta_data))
            elif object_type == 6:    # OFS_DELTA: 负偏移相对本对象起始位置
                offset, delta_data = payload
                base_offset = start_position - offset
                base_index = None
                for index2, (_, _, obj_position) in enumerate(raw_objects):
                    if obj_position == base_offset:
                        base_index = index2
                        break
                if base_index is None:
                    raise RuntimeError("ofs-delta 基线对象未定位 (offset=%d)" % offset)
                base_type, base_content = objects_by_index[base_index]
                resolved = self._gitee_apply_delta(base_content, delta_data)
                objects_by_index[index] = (base_type, resolved)
                objects_by_sha[self._gitee_object_hash(
                    self._gitee_type_name(base_type), resolved)] = (base_type, resolved)
            else:                     # 普通对象
                content = payload
                objects_by_index[index] = (object_type, content)
                objects_by_sha[self._gitee_object_hash(
                    self._gitee_type_name(object_type), content)] = (object_type, content)
        # 解析 ref-delta (基对象可能后置, 循环直到全部解析或无法推进)
        while pending_ref_delta:
            progress = False
            remaining = []
            for index, base_sha, delta_data in pending_ref_delta:
                if base_sha in objects_by_sha:
                    base_type, base_content = objects_by_sha[base_sha]
                    resolved = self._gitee_apply_delta(base_content, delta_data)
                    objects_by_index[index] = (base_type, resolved)
                    objects_by_sha[self._gitee_object_hash(
                        self._gitee_type_name(base_type), resolved)] = (base_type, resolved)
                    progress = True
                else:
                    remaining.append((index, base_sha, delta_data))
            if not progress and remaining:
                raise RuntimeError("ref-delta 基对象缺失, 无法还原 (%d 个)" % len(remaining))
            pending_ref_delta = remaining
        # 定位 head commit -> 根 tree -> 递归落盘
        head_digest = bytes.fromhex(head_sha)
        if head_digest not in objects_by_sha:
            raise RuntimeError("pack 里未找到 head 提交对象")
        commit_type, commit_content = objects_by_sha[head_digest]
        commit_text = commit_content.decode("utf-8", "replace")
        tree_line = [line for line in commit_text.split("\n") if line.startswith("tree ")]
        if not tree_line:
            raise RuntimeError("head 提交对象里没有 tree 字段")
        tree_sha = bytes.fromhex(tree_line[0].split(" ", 1)[1].strip())
        file_count = [0]
        self._gitee_write_tree(objects_by_sha, tree_sha, dest_dir, file_count)
        return file_count[0]

    def _gitee_write_tree(self, objects_by_sha, tree_sha, base_path, file_count):
        """递归把 tree 对象落盘为文件 (跳过 submodule)"""
        tree_type, tree_content = objects_by_sha[tree_sha]
        position = 0
        while position < len(tree_content):
            space_index = tree_content.index(b" ", position)
            mode = tree_content[position:space_index].decode("ascii")
            position = space_index + 1
            null_index = tree_content.index(b"\0", position)
            name = tree_content[position:null_index].decode("utf-8", "replace")
            position = null_index + 1
            child_sha = tree_content[position:position + 20]
            position += 20
            child_path = os.path.join(base_path, name)
            if mode == "40000":      # 子目录
                os.makedirs(child_path, exist_ok=True)
                self._gitee_write_tree(objects_by_sha, child_sha, child_path, file_count)
            elif mode == "160000":   # submodule, 跳过
                continue
            else:                    # blob (100644 / 100755 / 120000 symlink)
                blob_type, blob_content = objects_by_sha[child_sha]
                os.makedirs(os.path.dirname(child_path), exist_ok=True)
                with open(child_path, "wb") as file_handle:
                    file_handle.write(blob_content)
                if mode == "100755":
                    try:
                        os.chmod(child_path, 0o755)
                    except OSError:
                        pass
                file_count[0] += 1

    def green_release_version(self, release_info):
        """从 Release 信息取版本号 (去掉 tag 的 v 前缀, 如 v1.0.1 -> 1.0.1)"""
        tag = release_info.get("tag_name") or ""
        return tag[1:] if tag.startswith("v") else tag

    def green_find_zip_asset(self, release_info):
        """从版本信息里匹配绿色版分发 zip 资产。
        - GitHub 通道: 匹配 GREEN_ZIP_PREFIX + .zip 前缀的 Release 资产
        - Gitee 通道 : 整仓快照/发布版 asset 名不含该前缀, 直接取唯一 .zip 资产
        (source 为 "gitee" 或 "gitee_release" 都按 Gitee 规则匹配)
        返回元组 (资产名, 下载URL, 文件大小), 找不到返回 None"""
        assets = release_info.get("assets") or []
        is_gitee = release_info.get("source") in ("gitee", "gitee_release")
        for asset in assets:
            asset_name = asset.get("name") or ""
            if is_gitee:
                if asset_name.lower().endswith(".zip"):
                    return (asset_name, asset.get("browser_download_url") or "",
                            asset.get("size") or 0)
                continue
            if asset_name.startswith(GREEN_ZIP_PREFIX) and asset_name.lower().endswith(".zip"):
                return (asset_name, asset.get("browser_download_url") or "",
                        asset.get("size") or 0)
        return None

    def download_green_update(self, download_url, target_path, expected_size):
        """下载绿色版分发 zip 到 target_path (带进度日志), 下载后校验文件大小。
        大小不符则删除并抛异常; 成功返回 True"""
        os.makedirs(os.path.dirname(target_path), exist_ok=True)
        if os.path.exists(target_path):
            os.remove(target_path)      # 清除不完整/旧的下载文件
        self.log("开始下载: %s" % download_url)
        self.download_with_progress(download_url, target_path)
        actual_size = os.path.getsize(target_path)
        if expected_size and actual_size != expected_size:
            os.remove(target_path)
            raise RuntimeError("下载文件大小校验失败 (期望 %d 字节, 实际 %d 字节), 已删除请重试"
                               % (expected_size, actual_size))
        self.log("下载完成: %s (%.1f MB)" % (target_path, actual_size / 1024.0 / 1024.0))
        return True

    def _safe_extract_zip(self, zip_path, target_dir):
        """安全解压 zip 到目标目录 (逐成员写出, 防止 zip-slip 路径穿越)"""
        with zipfile.ZipFile(zip_path, "r") as zip_handle:
            for member in zip_handle.infolist():
                normalized_name = os.path.normpath(member.filename)
                if os.path.isabs(normalized_name) or normalized_name.startswith(".."):
                    self.log("跳过不安全路径(防路径穿越): %s" % member.filename)
                    continue
                target_path = os.path.join(target_dir, normalized_name)
                if member.is_dir():
                    os.makedirs(target_path, exist_ok=True)
                    continue
                os.makedirs(os.path.dirname(target_path), exist_ok=True)
                with zip_handle.open(member) as source_handle:
                    with open(target_path, "wb") as target_handle:
                        shutil.copyfileobj(source_handle, target_handle)

    def _detect_zip_content_root(self, extracted_dir):
        """判断解压后内容的根目录: 若解压后只有一个顶层目录且其内含绿色版标志文件
        (launcher.py / start.bat / DSH_Launcher.exe), 说明 zip 是"压缩整个文件夹"形态,
        返回该层目录; 否则返回解压目录本身"""
        entries = [name for name in os.listdir(extracted_dir)
                   if not name.startswith(".")]
        if len(entries) == 1:
            candidate = os.path.join(extracted_dir, entries[0])
            if os.path.isdir(candidate):
                if (os.path.isfile(os.path.join(candidate, "launcher.py")) or
                        os.path.isfile(os.path.join(candidate, "start.bat")) or
                        os.path.isfile(os.path.join(candidate, "DSH_Launcher.exe"))):
                    return candidate
        return extracted_dir

    def _normalize_update_structure(self, content_root):
        """修正旧版错误 zip 的目录结构 (2026-08-16, 需求 #21):
        旧打包命令 Compress-Archive 传 "plugins\\dsh-xxx" 子路径, PowerShell 会把该目录
        直接打在 zip 根、丢掉 plugins/ / skills/ 前缀, 导致更新覆盖时插件错位拷到程序根目录。
        这里把 content_root 下"本应位于 plugins/ / skills/ 的已知目录"归位到正确位置,
        使 robocopy 覆盖落点正确; 若正确位置已存在同名目录则跳过 (以 zip 内正确结构为准)"""
        plugin_names = ("dsh-archive-purge", "dsh-file-browser", "dsh-session-rewind")
        skill_names = ("dsh-deploy-maintain",)
        for plugin_name in plugin_names:
            misplaced_path = os.path.join(content_root, plugin_name)
            correct_path = os.path.join(content_root, "plugins", plugin_name)
            if os.path.isdir(misplaced_path) and not os.path.isdir(correct_path):
                plugins_dir = os.path.join(content_root, "plugins")
                os.makedirs(plugins_dir, exist_ok=True)
                shutil.move(misplaced_path, correct_path)
                self.log("归位错位插件目录: %s -> plugins\\%s" % (plugin_name, plugin_name))
        for skill_name in skill_names:
            misplaced_path = os.path.join(content_root, skill_name)
            correct_path = os.path.join(content_root, "skills", skill_name)
            if os.path.isdir(misplaced_path) and not os.path.isdir(correct_path):
                skills_dir = os.path.join(content_root, "skills")
                os.makedirs(skills_dir, exist_ok=True)
                shutil.move(misplaced_path, correct_path)
                self.log("归位错位 skill 目录: %s -> skills\\%s" % (skill_name, skill_name))

    def prepare_update_content_root(self, release_info, target_dir):
        """按更新来源准备"新版内容根目录", 返回该目录路径 (供 prepare_green_update 覆盖)。
        - github       : 下载分发 zip -> 解压 -> 检测内容根目录 (带/不带外层文件夹均兼容)
        - gitee_release: Gitee 发布版 zip 附件直连下载 (releases/download/... 不走挑战页,
                         2026-08-18 实测), 流程与 github 相同
        - gitee        : 整仓快照 -> git 智能 HTTP 协议克隆到 target_dir
                         (Gitee 无 Release 时的兜底; archive zip 会返回 JS 挑战页拿不到
                         真实 zip, 必须走 git 协议端点, 见 green_gitee_clone_tree)
        失败抛异常, 由调用方统一提示手动下载地址。
        注: 当 source 为 github 且实际下载 zip 失败时 (查询可达但 releases/download
        走不通), 会自动切换 Gitee 镜像源重试同版本 (见下方 download_green_update
        try/except 段, 用户需求 2026-08-19)。"""
        source = release_info.get("source") or "github"
        # 先清空目标目录, 避免上一次更新尝试残留旧文件被带进覆盖
        if os.path.exists(target_dir):
            shutil.rmtree(target_dir, ignore_errors=True)
        os.makedirs(target_dir, exist_ok=True)
        if source == "gitee":
            self.log("更新来源为 Gitee 整仓快照, 正在通过 git 协议克隆整仓 ...")
            # green_gitee_clone_tree 直接克隆到 target_dir (无外层嵌套), 返回落盘文件数;
            # 内容根目录即 target_dir 本身
            self.green_gitee_clone_tree(target_dir)
            self.log("更新内容根目录: %s" % target_dir)
            return target_dir
        # GitHub 发布版: 下载 zip -> 解压 -> 检测内容根目录
        # (下面的下载失败自动切换 Gitee 镜像, 见 prepare_update_content_root 开头注释)
        asset = self.green_find_zip_asset(release_info)
        if asset is None:
            raise RuntimeError("未找到匹配的绿色版分发 zip 资产")
        asset_name, download_url, asset_size = asset
        target_path = os.path.join(GREEN_UPDATE_DIR, asset_name)
        try:
            self.download_green_update(download_url, target_path, asset_size)
        except Exception as download_error:
            # 钩子: 若已是 Gitee 来源再失败则直接抛 (避免递归切换)
            is_gitee_now = source in ("gitee", "gitee_release")
            if is_gitee_now:
                raise
            # ===== 用户需求 (2026-08-19): GitHub 下载失败 -> 自动替换 Gitee 重试 =====
            # 场景: 查询阶段 api.github.com 可达能查到最新版本号, 但实际下载 zip 时
            # releases/download 走不通 (不同网络路径), 导致一直卡在 GitHub 反复失败。
            # 这里在首次下载异常后自动改用 Gitee 镜像源重新拉取同版本 zip。
            self.log("GitHub 下载失败: %s, 自动切换 Gitee 镜像源重试同版本 ..."
                     % download_error)
            gitee_info = self.green_gitee_latest()
            if gitee_info is None:
                self.log("Gitee 镜像源不可用, 放弃自动切换 (回到原始报错)")
                raise download_error
            # 防降级: 只接受版本号 >= 本次想下载的版本, 避免 Gitee 落后时装回旧版
            try:
                want_version = self.green_release_version(release_info)
                gitee_version = self.green_release_version(gitee_info)
                if (want_version and gitee_version
                        and self._green_version_greater(want_version, gitee_version)):
                    self.log("Gitee 镜像源版本 v%s 低于目标 v%s, 放弃自动切换"
                             % (gitee_version, want_version))
                    raise download_error
            except Exception:
                pass  # 版本比对失败不阻断, 直接用 Gitee 结果
            gitee_asset = self.green_find_zip_asset(gitee_info)
            if gitee_asset is None:
                self.log("Gitee 镜像源无可用 zip 资产, 放弃自动切换")
                raise download_error
            gitee_name, gitee_url, gitee_size = gitee_asset
            asset_name, download_url, asset_size = (gitee_name, gitee_url, gitee_size)
            target_path = os.path.join(GREEN_UPDATE_DIR, asset_name)
            self.log("已切换 Gitee 镜像源, 开始下载: %s" % gitee_url)
            self.download_green_update(gitee_url, target_path, gitee_size)
            # 成功后把来源记为 Gitee, 供后续失败提示与覆盖来源保持一致
            release_info["source"] = "gitee_release"
        self._safe_extract_zip(target_path, target_dir)
        content_root = self._detect_zip_content_root(target_dir)
        self.log("更新内容根目录: %s" % content_root)
        return content_root

    def prepare_green_update(self, content_root, new_version="", manual_zip_url="",
                             source="github"):
        """准备覆盖安装: 校验内容根目录, 修正旧版错位目录结构, 生成 update_job.json
        (由独立更新程序 DSH_Update.exe 在启动器退出后执行覆盖; 任务文件里带上手动下载
        地址供失败时提示)。
        content_root: 新版内容根目录 (由 prepare_update_content_root 按来源准备:
            GitHub=zip 解压, Gitee=git 协议克隆整仓, 见 green_gitee_clone_tree)。
        source: 更新来源 ("github" 或 "gitee"), 决定失败时给用户的"手动发布页"地址。
        返回元组 (内容根目录, job 文件路径); 失败抛异常"""
        update_dir = GREEN_UPDATE_DIR
        os.makedirs(update_dir, exist_ok=True)
        # 1. 校验内容根目录 (zip 解压或 git 克隆的产物)
        if not os.path.isdir(content_root):
            raise RuntimeError("更新内容根目录不存在: %s" % content_root)
        # 2. 修正旧版错误 zip 的插件/skill 错位目录 (需求 #21)
        self._normalize_update_structure(content_root)
        # 3. 生成更新任务文件 (JSON), 由 DSH_Update.exe 读取执行
        if source in ("gitee", "gitee_release"):
            manual_release_page = GITEE_REPO_PAGE_URL   # Gitee 提示去仓库页 (含发布版入口)
        else:
            manual_release_page = "https://github.com/%s/releases/latest" % GITHUB_REPO
        job_path = os.path.join(update_dir, "update_job.json")
        job_data = {
            "base_dir": BASE_DIR,                       # 程序根目录 (覆盖目标)
            "content_root": content_root,               # 新版内容根目录 (来源)
            "backup_dir": os.path.join(update_dir, "backup"),  # 旧文件备份目录
            "relaunch_mode": "bat" if not self._is_frozen() else "exe",  # 重启入口形态
            "new_version": new_version,                 # 新版本号 (状态窗口显示)
            # 失败时给用户手动下载覆盖源文件的地址 (用户需求 2026-08-18)
            "manual_release_url": manual_release_page,
            "manual_zip_url": manual_zip_url,
        }
        with open(job_path, "w", encoding="utf-8") as file_handle:
            json.dump(job_data, file_handle, ensure_ascii=False, indent=2)
        self.log("更新任务文件已生成: %s" % job_path)
        return content_root, job_path

    def launch_update_agent(self, job_path):
        """以分离进程方式启动独立更新程序 (DSH_Update.exe, 兜底用内置 python 跑
        update_agent.py), 使其脱离启动器进程树: 启动器随后退出, 由更新程序在独立
        进程里完成 等本体退出 -> 备份 -> 覆盖 -> 重启, 失败时弹窗给出手动下载地址。

        之所以用独立更新程序而不是 bat/自覆盖: 运行中的 DSH_Launcher.exe 被 Windows
        锁定, 无法原地替换; 更新程序启动后先把自己复制到 runtime/tmp 再从副本运行,
        连 DSH_Update.exe 自身也能被新版覆盖。"""
        update_exe = os.path.join(BASE_DIR, "DSH_Update.exe")
        if os.path.isfile(update_exe):
            # 首选独立更新程序 (绿色版自带, 不依赖系统 python / cmd)
            command_line = [update_exe, "--apply", job_path]
        else:
            # 兜底: 用内置便携 python 直接跑 update_agent.py
            python_exe = self.find_python_exe()
            if python_exe is None:
                raise RuntimeError(
                    "程序目录缺少 DSH_Update.exe 且找不到内置 Python, 无法自动更新。"
                    "请到 GitHub Release 手动下载新版覆盖。")
            script_path = os.path.join(BASE_DIR, "update_agent.py")
            if not os.path.isfile(script_path):
                raise RuntimeError("程序目录缺少 update_agent.py, 无法自动更新。")
            command_line = [python_exe, script_path, "--apply", job_path]
        if sys.platform == "win32":
            creation_flags = (subprocess.DETACHED_PROCESS |
                              subprocess.CREATE_NEW_PROCESS_GROUP)
        else:
            # 非 Windows: 普通后台启动 (绿色便携主要面向 Windows, 这里做兜底)
            creation_flags = 0
        self.log("正在启动独立更新程序 (启动器即将退出) ...")
        subprocess.Popen(command_line, creationflags=creation_flags,
                         cwd=BASE_DIR, close_fds=True,
                         stdin=subprocess.DEVNULL,
                         stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)

    def build_env(self):
        """构造运行环境: 把便携 Node 的 bin 目录与 pnpm 全局目录加入 PATH,
        并把 npm/pnpm/临时目录全部重定向到本地 runtime, 实现绿色便携"""
        env = dict(os.environ)
        path_entries = []
        node_bin = self.node_bin_dir()
        if node_bin:
            path_entries.append(node_bin)
        # pnpm 全局目录加入 PATH: dsh plugin 命令会用 shell 转发 pnpm,
        # 必须能在 PATH 里找到便携 pnpm.cmd, 否则报 pnpm not found
        path_entries.append(PNPM_HOME_DIR)
        env["PATH"] = os.pathsep.join(path_entries) + os.pathsep + env.get("PATH", "")
        # 所有数据 (会话/配置/存储) 都放在程序目录内, 保证绿色便携
        env["DSH_HOME"] = DSH_HOME_DIR
        # npm: 缓存 / 用户配置 / 禁止全局安装 → 本地 (避免写用户主目录 ~/.npm 等)
        env["npm_config_cache"] = NPM_CACHE_DIR
        env["npm_config_userconfig"] = NPM_USER_CONFIG
        env["npm_config_global"] = "false"
        env["npm_config_update_notifier"] = "false"
        env["npm_config_fund"] = "false"
        # pnpm: 全局 home / 内容寻址存储 → 本地 (dsh 的插件管理基于 pnpm)
        env["PNPM_HOME"] = PNPM_HOME_DIR
        env["npm_config_store_dir"] = PNPM_STORE_DIR
        # 临时目录 → 本地 (绿色便携, 默认 runtime/tmp; config.json 的 tmp_dir 可覆盖)
        tmp_dir = self.config.get("tmp_dir") or TMP_DIR
        env["TEMP"] = tmp_dir
        env["TMP"] = tmp_dir
        return env

    def ensure_runtime_dirs(self):
        """确保 runtime 下的所有目录与本地配置文件存在"""
        tmp_dir = self.config.get("tmp_dir") or TMP_DIR
        workspace_path = self.resolve_default_workspace()
        for directory in (RUNTIME_DIR, NPM_CACHE_DIR, PNPM_HOME_DIR,
                          PNPM_STORE_DIR, tmp_dir, DSH_HOME_DIR, workspace_path):
            os.makedirs(directory, exist_ok=True)
        # 本地 npm 用户配置文件: 空文件即可, 用于阻断对用户主目录 ~/.npmrc 的读写
        if not os.path.exists(NPM_USER_CONFIG):
            with open(NPM_USER_CONFIG, "w", encoding="utf-8") as file_handle:
                file_handle.write("# local npm userconfig for DSH launcher\n")

    # ---------- 工作区自动解析 (解决 Windows ACL 临时目录冲突) ----------
    def _tmp_dir(self):
        """当前生效的临时根目录 (config.json 的 tmp_dir 优先, 否则默认 runtime/tmp)。"""
        return self.config.get("tmp_dir") or TMP_DIR

    def workspace_conflicts_with_tmp(self, workspace_path, tmp_dir=None):
        """判断某个工作区是否与临时根目录冲突。

        dsh 的 Windows ACL 沙箱要求临时根目录不能位于会话工作区内部, 否则
        该会话所有 shell 工具报: "Windows ACL temp root must be outside the workspace"。
        冲突判定: 临时目录是工作区的子路径(严格包含, 不含两者同路径)。
        路径无法归一化(如不同盘符)时按不冲突处理, 不阻断启动。
        """
        tmp_dir = tmp_dir or self._tmp_dir()
        workspace_abs = os.path.normcase(os.path.normpath(os.path.abspath(workspace_path)))
        tmp_abs = os.path.normcase(os.path.normpath(os.path.abspath(tmp_dir)))
        try:
            common = os.path.commonpath([workspace_abs, tmp_abs])
        except ValueError:
            return False   # 不同盘符等无法比较 → 视为不冲突
        return common == workspace_abs and tmp_abs != workspace_abs

    def resolve_default_workspace(self):
        """自动解析一个与临时目录不冲突的默认工作区路径 (不写死)。

        规则(按优先级):
          1) 用户 config.json 显式配置了 default_workspace → 直接使用;
             若它与临时目录冲突, 记警告并回退到自动解析结果。
          2) 程序根目录 BASE_DIR 本身与临时目录不冲突 → 直接用程序根目录。
          3) 冲突(即绿色便携默认形态: 程序根目录内含 runtime/tmp)
             → 取程序目录内不包含临时目录的子目录 BASE_DIR/workspace。
        返回: 解析出的工作区绝对路径。
        """
        configured = (self.config.get("default_workspace") or "").strip()
        if configured:
            if self.workspace_conflicts_with_tmp(configured):
                self.log("警告: 配置的默认工作区包含临时目录(%s), 已回退到自动解析"
                         % self._tmp_dir())
            else:
                return os.path.abspath(configured)
        if self.workspace_conflicts_with_tmp(BASE_DIR):
            return os.path.join(BASE_DIR, DEFAULT_WORKSPACE_SUBDIR)
        return BASE_DIR

    # ---------- 插件管理 (基于 dsh plugin 转发 pnpm) ----------
    def find_pnpm_exe(self):
        """返回便携 pnpm 的可执行文件路径 (Windows 为 pnpm.cmd, 其他平台为 pnpm)"""
        if sys.platform == "win32":
            return os.path.join(PNPM_HOME_DIR, "pnpm.cmd")
        return os.path.join(PNPM_HOME_DIR, "pnpm")

    def pnpm_installed(self):
        """判断便携 pnpm 是否已安装"""
        return os.path.isfile(self.find_pnpm_exe())

    def install_pnpm(self):
        """安装 pnpm 到便携 runtime (供 dsh plugin 命令转发使用)
        已安装则直接返回; 需要便携 Node 已就绪"""
        if self.pnpm_installed():
            self.log("pnpm 已就绪: %s" % self.find_pnpm_exe())
            return True
        npm_cli = self.find_npm_cli()
        node_exe = self.find_node_exe()
        if npm_cli is None or node_exe is None:
            raise RuntimeError("未找到便携 Node, 无法安装 pnpm (请先点击「安装环境」)")
        self.ensure_runtime_dirs()
        self.log("未检测到便携 pnpm, 开始自动安装 ...")
        # 用便携 npm 全局安装 pnpm, --prefix 使其落在本地 runtime/pnpm-home
        command = [node_exe, npm_cli, "install", "-g", "pnpm",
                   "--prefix", PNPM_HOME_DIR,
                   "--cache", NPM_CACHE_DIR,
                   "--userconfig", NPM_USER_CONFIG,
                   "--no-audit", "--no-fund"]
        mirror, is_auto = self.resolve_mirror()
        if not is_auto:
            command.append("--registry=%s" % NPM_REGISTRY[mirror])
            self.log("使用镜像源: %s" % NPM_REGISTRY[mirror])
        return_code, _output = self._stream_subprocess(
            command, cwd=DSH_DIR, env=self.build_env(),
            timeout=300, log_prefix="npm: ")
        if return_code != 0 or not self.pnpm_installed():
            raise RuntimeError("pnpm 安装失败, 请检查网络后重试 (详见上方 npm 输出)")
        self.log("pnpm 安装成功: %s" % self.find_pnpm_exe())
        return True

    def strip_bom_from_profile_packages(self, profile):
        """清除 profile 的 node_modules 下所有 package.json 开头的 UTF-8 BOM (U+FEFF).

        背景: 个别 npm 包(如 dsh-tool-vision)发布时 package.json 带了 UTF-8 BOM,
        dsh 内部用 JSON.parse 直接解析该文件时会报
        "SyntaxError: Unexpected token '\ufeff'" 而崩溃, 导致插件安装/移除失败。
        BOM 对 JSON 无任何语义, 剥掉后不影响任何 JSON 解析器。
        """
        profile_modules = os.path.join(DSH_HOME_DIR, "profiles", profile, "node_modules")
        if not os.path.isdir(profile_modules):
            return
        stripped_count = 0
        for root, _directories, files in os.walk(profile_modules):
            if "package.json" not in files:
                continue
            package_json_path = os.path.join(root, "package.json")
            try:
                with open(package_json_path, "rb") as file_handle:
                    head = file_handle.read(3)
                if head != b"\xef\xbb\xbf":
                    continue
                with open(package_json_path, "rb") as file_handle:
                    content = file_handle.read()
                with open(package_json_path, "wb") as file_handle:
                    file_handle.write(content[3:])
                stripped_count += 1
            except OSError:
                # 个别文件被占用或只读时忽略, 不阻断整个命令
                continue
        if stripped_count > 0:
            self.log("已清除 %d 个 package.json 的 UTF-8 BOM (修复 dsh JSON 解析崩溃)" % stripped_count)

    def run_plugin_command(self, profile, arguments):
        """执行 dsh plugin 命令 (转发给 profile 目录里的 pnpm), 返回 (退出码, 输出文本)
        会自动确保 pnpm 就绪; 找不到 node/dsh 时抛异常。
        特别处理: 个别 npm 包(package.json 带 UTF-8 BOM)会让 dsh 的 JSON.parse 崩溃,
        本方法在命令前先清一遍存量 BOM, 失败后清理本次新装的 BOM 并重试一次
        (见 strip_bom_from_profile_packages)。"""
        node_exe = self.find_node_exe()
        if node_exe is None:
            raise RuntimeError("未找到便携 Node, 请先安装环境")
        dsh_js = os.path.join(DSH_DIR, DSH_BIN_JS)
        if not os.path.isfile(dsh_js):
            raise RuntimeError("未找到 dsh 入口文件, 请先安装环境")
        if not self.pnpm_installed():
            self.install_pnpm()
        command = [node_exe, dsh_js, "plugin", "--profile", profile] + list(arguments)

        def execute_once():
            """实际执行一次 dsh 插件命令, 返回 (退出码, 输出文本)"""
            self.log("执行插件命令: dsh plugin --profile %s %s" % (profile, " ".join(arguments)))
            try:
                return self._stream_subprocess(
                    command, cwd=BASE_DIR, env=self.build_env(),
                    timeout=600, log_prefix="plugin: ")
            except subprocess.TimeoutExpired:
                raise RuntimeError("插件命令执行超时 (超过 10 分钟), 请检查网络后重试")

        # 先清一遍存量 package.json 的 BOM (历史遗留或重装时可能带 BOM)
        self.strip_bom_from_profile_packages(profile)
        # pnpm 11 strictDepBuilds (避坑 44): 提前补齐已预构建原生依赖的 false 声明,
        # 避免 ERR_PNPM_IGNORED_BUILDS 让安装以非 0 退出。绿色版分发不含 runtime/,
        # so 必须由启动器在本机自动化补丁, 新电脑无需手改 pnpm-workspace.yaml。
        self.ensure_pnpm_native_allowbuilds(profile)
        exit_code, output = execute_once()
        if exit_code != 0:
            # 本次 pnpm 刚下载的包可能带 BOM 导致 dsh JSON.parse 崩溃;
            # 清掉 BOM 后重试一次 (pnpm 幂等, 不重复下载, 很快完成)
            self.strip_bom_from_profile_packages(profile)
            # pnpm 11: git 源插件 prepare 构建脚本被拦 (ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED,
            # 避坑 44) → 提取报错里的放行 key 写入 profile 的 allowBuilds true (幂等);
            # 无论是否写入都重试一次, 以保留原有 BOM 修复重试能力
            self.auto_allow_git_build(profile, output)
            exit_code, output = execute_once()
        # 无论 pnpm 退出码如何, 只要命令执行完就同步一次编排层:
        # 官方 reconcile 只在 pnpm exit 0 时运行, 且不识别 disabled 列表,
        # 这里兜底保证 bundles 始终与已安装依赖 + 停用状态一致。
        try:
            self.reconcile_bundles(profile)
        except Exception as error:
            self.log("同步编排层失败 (不影响插件命令结果): %s" % error)
        return exit_code, output

    # ---------- pnpm-workspace.yaml allowBuilds 自愈 (pnpm 11+) ----------
    # 背景: pnpm 11+ strictDepBuilds (见 DEV_NOTES 避坑 44) 默认拦 git 源插件
    # (如 dsh-market) 的 prepare 构建脚本 → ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED 中断;
    # 已预构建的原生依赖 (node-pty/ssh2 等) 则要显式声明 false 跳过重复构建, 否则报
    # ERR_PNPM_IGNORED_BUILDS 以非 0 退出。绿色版分发 zip 不含 runtime/, 因此必须由
    # 启动器在本机自动补齐, 新电脑无需手改 profile 的 pnpm-workspace.yaml。

    def _pnpm_workspace_yaml(self, profile):
        """返回 profile 的 pnpm-workspace.yaml 绝对路径"""
        return os.path.join(DSH_HOME_DIR, "profiles", profile, "pnpm-workspace.yaml")

    def set_allow_builds(self, profile, entry_mapping):
        """把 {全key: bool} 合并写入 profile 的 pnpm-workspace.yaml 的 allowBuilds 节。
        幂等: 已存在的 key 不动, 只补缺失项; 返回是否发生了修改。
        key 含冒号 (如 git 源的 dshmarket@https://...) 时自动加单引号包裹,
        避免 YAML 把第一个冒号误判为 key 分隔。"""
        yaml_path = self._pnpm_workspace_yaml(profile)
        if not os.path.isfile(yaml_path):
            return False
        with open(yaml_path, "r", encoding="utf-8") as file_handle:
            text = file_handle.read()
        # 收集已有 allowBuilds 顶层条目的 key (支持带引号或裸 key, 值 true/false)
        existing_keys = set()
        allow_match = re.search(r"(?m)^allowBuilds:\s*\n((?:[ \t]+[^\n]*\n)*)", text)
        if allow_match:
            block = allow_match.group(1)
            for each_line in block.splitlines():
                item_match = re.match(
                    r"[ \t]+(['\"]?)([^\n]*?)\1\s*:\s*(?:true|false)\s*$", each_line)
                if item_match:
                    existing_keys.add(item_match.group(2))
        # 构造缺失条目; key 含冒号才加引号 (与现有 git 源 key 的写法一致)
        adds = []
        for each_key, each_value in entry_mapping.items():
            if each_key in existing_keys:
                continue
            if ":" in each_key:
                formatted_key = "'%s'" % each_key.replace("'", "''")
            else:
                formatted_key = each_key
            adds.append("  %s: %s" % (formatted_key, "true" if each_value else "false"))
        if not adds:
            return False
        insertion_text = "\n" + "\n".join(adds)
        if allow_match:
            anchor_match = re.search(r"(?m)^allowBuilds:\s*$", text)
            anchor_index = anchor_match.start() if anchor_match else allow_match.start()
            text = text[:anchor_index] + "allowBuilds:" + insertion_text + text[anchor_index + len("allowBuilds:"):]
        else:
            text = text.rstrip() + "\n\nallowBuilds:" + insertion_text + "\n"
        with open(yaml_path, "w", encoding="utf-8") as file_handle:
            file_handle.write(text)
        return True

    def ensure_pnpm_native_allowbuilds(self, profile):
        """首次装插件/装环境时幂等补齐已预构建原生依赖的 false 声明, 避免
        ERR_PNPM_IGNORED_BUILDS 让安装以非 0 退出 (避坑 44)。"""
        entry_mapping = {}
        for package_name in ("cloudflared", "cpu-features", "node-pty",
                             "protobufjs", "ssh2"):
            entry_mapping[package_name] = False
        try:
            if self.set_allow_builds(profile, entry_mapping):
                self.log("已为 profile %s 补充 pnpm allowBuilds 原生依赖跳过构建声明"
                         % profile)
        except Exception as error:
            self.log("[警告] 补充 pnpm allowBuilds 失败: %s" % error)

    def auto_allow_git_build(self, profile, command_output):
        """检测安装失败输出里的 ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED, 提取 git 源插件的
        放行 key (形如 dshmarket@https://codeload.github.com/.../<commit>) 写入
        allowBuilds true (幂等), 返回是否发生了写入。key 含完整 commit hash,
        包名/版本/分支均不匹配 (见 DEV_NOTES 避坑 44)。"""
        if "ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED" not in command_output:
            return False
        key = None
        # 优先取 pnpm 报错里建议块给出的放行 key (name@commit-url: true)
        match = re.search(r"([A-Za-z0-9_.-]+@https?://\S+?):\s*true", command_output)
        if match:
            key = match.group(1)
        else:
            # 退一步: 用包名 + "fetched from \'<url>\'" 拼出 key
            url_match = re.search(r"fetched from\s+\"([^\"]+)\"", command_output)
            name_match = re.search(r"The git-hosted package\s+\"([^@\"]+)", command_output)
            if url_match and name_match:
                key = "%s@%s" % (name_match.group(1), url_match.group(1))
        if not key:
            return False
        changed = self.set_allow_builds(profile, {key: True})
        if changed:
            self.log("已放行 git 源插件构建脚本 (allowBuilds): %s" % key)
        return changed

    # ---------- profile 编排层 (dsh.profile.bundles) 同步 ----------
    # 背景: dsh plugin 命令内部会在 pnpm 成功 (退出码 0) 后自动把声明 dsh.bundle 的
    # 包写进 dsh.profile.bundles; 但 pnpm 遇到 ERR_PNPM_IGNORED_BUILDS (构建脚本被
    # 忽略的警告) 时以退出码 1 结束, 该 reconcile 会被跳过, 导致"包装上了但没生效"。
    # 这里由启动器兜底: 任何安装/移除/启停操作后都强制把 bundles 与已安装依赖对齐。
    def read_profile_manifest(self, profile=DEFAULT_PROFILE):
        """读取 profile 的 package.json, 不存在或解析失败返回 None"""
        package_json = os.path.join(DSH_HOME_DIR, "profiles", profile, "package.json")
        if not os.path.isfile(package_json):
            return None
        try:
            with open(package_json, "r", encoding="utf-8") as file_handle:
                return json.load(file_handle)
        except Exception as error:
            self.log("读取 profile 配置失败: %s" % error)
            return None

    def write_profile_manifest(self, profile, manifest):
        """写回 profile 的 package.json, 返回是否成功"""
        package_json = os.path.join(DSH_HOME_DIR, "profiles", profile, "package.json")
        try:
            with open(package_json, "w", encoding="utf-8") as file_handle:
                json.dump(manifest, file_handle, ensure_ascii=False, indent=2)
                file_handle.write("\n")
            return True
        except Exception as error:
            self.log("写回 profile 配置失败: %s" % error)
            return False

    def package_declares_bundle(self, package_name, profile=DEFAULT_PROFILE):
        """判断已安装的包是否声明了 dsh.bundle (即会成为 profile 编排层)。
        读取 node_modules 下该包的 package.json 的 dsh.bundle.patch 字段。"""
        module_dir = os.path.join(DSH_HOME_DIR, "profiles", profile,
                                  "node_modules", package_name)
        package_json = os.path.join(module_dir, "package.json")
        if not os.path.isfile(package_json):
            return False
        try:
            with open(package_json, "r", encoding="utf-8") as file_handle:
                manifest = json.load(file_handle)
            bundle = (manifest.get("dsh") or {}).get("bundle") or {}
            return bool(bundle.get("patch"))
        except Exception:
            return False

    def reconcile_bundles(self, profile=DEFAULT_PROFILE, removed=None):
        """把 dependencies 中声明 dsh.bundle 且未停用的包同步进 dsh.profile.bundles;
        停用的依赖包从 bundles 移除; removed 中列出的包 (本次移除操作的目标) 强制清除。
        内置 bundle (如 @deepseek-ai/dsh-base / dsh-web-app) 不在 dependencies 中,
        与官方 reconcile 一致永不触碰。
        返回 (是否有变更, 当前 bundles 列表)。"""
        manifest = self.read_profile_manifest(profile)
        if manifest is None:
            return False, []
        dependencies = manifest.get("dependencies") or {}
        profile_section = manifest.setdefault("dsh", {}).setdefault("profile", {})
        bundles = profile_section.get("bundles") or []
        disabled = set(profile_section.get("disabled") or [])
        removed = set(removed or [])
        changed = False
        # 新增/恢复: 声明 dsh.bundle 且未停用的依赖包
        for package_name in dependencies:
            if package_name in disabled:
                continue
            if package_name not in bundles and self.package_declares_bundle(package_name, profile):
                bundles.append(package_name)
                changed = True
        # 移除: 本次操作明确移除的包; 或仍在依赖中但已停用的包;
        # 或依赖中不再声明 bundle 的包 (更新后丢了声明)。内置 bundle 不在
        # dependencies 里, 不受影响。
        for package_name in list(bundles):
            in_dependencies = package_name in dependencies
            if package_name in removed:
                bundles.remove(package_name)
                changed = True
            elif in_dependencies and package_name in disabled:
                bundles.remove(package_name)
                changed = True
            elif in_dependencies and not self.package_declares_bundle(package_name, profile):
                bundles.remove(package_name)
                changed = True
        profile_section["bundles"] = bundles
        if changed:
            self.write_profile_manifest(profile, manifest)
        return changed, list(bundles)

    def get_plugin_state(self, package_name, profile=DEFAULT_PROFILE):
        """返回插件当前状态: enabled / disabled / plain (非 bundle 依赖) / missing"""
        manifest = self.read_profile_manifest(profile)
        if manifest is None or package_name not in (manifest.get("dependencies") or {}):
            return "missing"
        if not self.package_declares_bundle(package_name, profile):
            return "plain"
        bundles = (manifest.get("dsh") or {}).get("profile", {}).get("bundles") or []
        disabled = (manifest.get("dsh") or {}).get("profile", {}).get("disabled") or []
        if package_name in bundles and package_name not in disabled:
            return "enabled"
        return "disabled"

    def set_plugin_enabled(self, package_name, profile=DEFAULT_PROFILE, enabled=True):
        """启用/停用一个已安装的 bundle 插件: 修改 dsh.profile.bundles 与停用列表。
        返回 True 表示成功; False 表示该包不是可启停的 bundle 插件。"""
        manifest = self.read_profile_manifest(profile)
        if manifest is None:
            return False
        if not self.package_declares_bundle(package_name, profile):
            return False
        profile_section = manifest.setdefault("dsh", {}).setdefault("profile", {})
        bundles = profile_section.get("bundles") or []
        disabled = profile_section.get("disabled") or []
        if enabled:
            if package_name in disabled:
                disabled.remove(package_name)
            if package_name not in bundles:
                bundles.append(package_name)
        else:
            if package_name in bundles:
                bundles.remove(package_name)
            if package_name not in disabled:
                disabled.append(package_name)
        profile_section["bundles"] = bundles
        profile_section["disabled"] = disabled
        return self.write_profile_manifest(profile, manifest)

    def install_plugin(self, package_spec, profile=DEFAULT_PROFILE):
        """安装插件到指定 profile (转发给 pnpm add), 失败抛异常。
        安装成功后自动把声明 dsh.bundle 的包同步进 dsh.profile.bundles,
        无需手动编辑 package.json。"""
        arguments = ["add", package_spec]
        mirror, is_auto = self.resolve_mirror()
        if not is_auto:
            arguments.append("--registry=%s" % NPM_REGISTRY[mirror])
        self.log("开始安装插件: %s (profile: %s) ..." % (package_spec, profile))
        before = self.list_installed_plugins(profile)
        exit_code, _output = self.run_plugin_command(profile, arguments)
        after = self.list_installed_plugins(profile)
        added = [name for name in after if name not in before]
        if exit_code != 0 and not added:
            # pnpm 非 0 且没有任何新依赖写入 -> 真失败
            raise RuntimeError("插件安装失败 (退出码 %s), 请查看上方日志" % exit_code)
        if exit_code != 0 and added:
            # pnpm 因 ERR_PNPM_IGNORED_BUILDS 等警告以非 0 退出, 但包实际已写入依赖
            self.log("pnpm 返回非 0 (可能是构建脚本忽略警告), 但已写入依赖: %s"
                     % ", ".join(added))
        changed, bundles = self.reconcile_bundles(profile)
        self.log("插件安装成功: %s" % package_spec)
        if changed:
            self.log("已自动同步编排层 (dsh.profile.bundles): %s" % ", ".join(bundles))
        return True

    def bundled_plugin_dirs(self):
        """返回程序目录 plugins/ 下所有内置插件目录 (含 package.json 的子目录)。
        内置插件 (dsh-archive-purge / dsh-session-rewind / dsh-file-browser /
        dsh-usage-stats / dsh-session-import) 以源码形式随绿色版一起发布, 需要时用 file: 本地安装。"""
        result = []
        plugins_root = os.path.join(BASE_DIR, "plugins")
        if not os.path.isdir(plugins_root):
            return result
        for entry_name in sorted(os.listdir(plugins_root)):
            entry_path = os.path.join(plugins_root, entry_name)
            if os.path.isfile(os.path.join(entry_path, "package.json")):
                result.append(entry_path)
        return result

    def install_bundled_plugins(self, profile=DEFAULT_PROFILE):
        """把程序目录 plugins/ 下所有内置插件批量装到指定 profile (已装的跳过)。
        返回 (本次新装列表, 已存在跳过列表, 失败列表); 单个失败不中断其余插件。
        安装环境后自动调用 (2026-08-17, 需求: 安装环境最后把所有计划内置插件都装上);
        插件管理窗口的「一键安装内置插件」按钮也复用本方法。"""
        installed_now = []
        skipped = []
        failed = []
        already_installed = self.list_installed_plugins(profile)
        for folder in self.bundled_plugin_dirs():
            try:
                with open(os.path.join(folder, "package.json"), "r", encoding="utf-8") as file_handle:
                    manifest = json.load(file_handle)
            except Exception as error:
                failed.append(os.path.basename(folder))
                self.log("[警告] 读取内置插件 %s 的 package.json 失败: %s" % (folder, error))
                continue
            package_name = manifest.get("name") or ""
            if not package_name:
                failed.append(os.path.basename(folder))
                self.log("[警告] 内置插件 %s 缺少 name 字段, 已跳过" % folder)
                continue
            if package_name in already_installed:
                skipped.append(package_name)
                continue
            spec = "file:" + folder.replace("\\", "/")
            try:
                self.install_plugin(spec, profile)
                installed_now.append(package_name)
            except Exception as error:
                failed.append(package_name)
                self.log("[警告] 内置插件 %s 安装失败: %s" % (package_name, error))
        return installed_now, skipped, failed

    def _plugin_tree_hashes(self, root):
        """收集目录内所有文件的相对路径 -> MD5, 返回 {相对路径: md5}。
        用于对比内置插件源码与 profile 内已安装副本是否一致。"""
        result = {}
        if not os.path.isdir(root):
            return result
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort()
            for name in sorted(filenames):
                full_path = os.path.join(dirpath, name)
                relative = os.path.relpath(full_path, root)
                try:
                    with open(full_path, "rb") as file_handle:
                        result[relative] = hashlib.md5(file_handle.read()).hexdigest()
                except OSError:
                    result[relative] = "<unreadable>"
        return result

    def update_bundled_plugins(self, profile=DEFAULT_PROFILE, package_names=None):
        """把已安装的内置插件一键更新为程序目录 plugins/ 的最新源码 (重装最新版)。

        背景: install_bundled_plugins() 对已安装的插件直接跳过, 而 profile 的
        node_modules 里是 file: 依赖的独立拷贝 (nodeLinker=hoisted, 并非指向
        plugins/ 源码的链接), 因此内置插件源码更新后, 已装副本不会自动同步 ——
        导致"别的电脑更新了插件, 这台机器还是旧版"(如用量统计的余额功能)。
        本方法逐文件对比源码与已装副本的哈希, 不一致时把源码镜像进已装副本
        (只写变化的文件, 避免重写被服务占用的未变化文件; 源码中已删除的陈旧
        文件一并清理), 实现一键同步最新版。

        package_names: 仅更新指定插件 (None = 更新全部已安装的内置插件)。

        返回 (updated, up_to_date, not_installed, failed):
          updated        已更新插件名列表
          up_to_date     已是最新、无需更新的插件名列表
          not_installed  未安装(或不在 node_modules)的内置插件名列表
          failed         [(插件名, 失败原因), ...]
        """
        updated, up_to_date, not_installed, failed = [], [], [], []
        installed = self.list_installed_plugins(profile)
        want = set(package_names or [])
        for folder in self.bundled_plugin_dirs():
            try:
                with open(os.path.join(folder, "package.json"), "r",
                          encoding="utf-8") as file_handle:
                    manifest = json.load(file_handle)
            except Exception as error:
                failed.append((os.path.basename(folder),
                               "读取 package.json 失败: %s" % error))
                continue
            package_name = manifest.get("name") or ""
            if not package_name:
                failed.append((os.path.basename(folder), "package.json 缺少 name 字段"))
                continue
            if want and package_name not in want:
                continue
            if package_name not in installed:
                not_installed.append(package_name)
                continue
            module_dir = os.path.join(DSH_HOME_DIR, "profiles", profile,
                                      "node_modules", package_name)
            module_dir = os.path.realpath(module_dir)  # 兼容符号链接布局, 写到真实目录
            if not os.path.isdir(module_dir):
                not_installed.append(package_name)
                continue
            try:
                source_hashes = self._plugin_tree_hashes(folder)
                installed_hashes = self._plugin_tree_hashes(module_dir)
                if source_hashes == installed_hashes:
                    up_to_date.append(package_name)
                    continue
                # 镜像源码 -> 已装副本: 只写内容变化的文件 + 删除源码中已不存在的陈旧文件
                source_files = set(source_hashes.keys())
                installed_files = set(installed_hashes.keys())
                errors = []
                for relative in sorted(source_files):
                    if installed_hashes.get(relative) == source_hashes[relative]:
                        continue  # 内容一致, 不重写 (避免触碰被服务占用的未变化文件)
                    src_path = os.path.join(folder, relative)
                    dst_path = os.path.join(module_dir, relative)
                    try:
                        os.makedirs(os.path.dirname(dst_path), exist_ok=True)
                        shutil.copy2(src_path, dst_path)
                    except OSError as error:
                        errors.append("%s: %s" % (relative, error))
                for relative in sorted(installed_files - source_files):
                    stale_path = os.path.join(module_dir, relative)
                    try:
                        if os.path.isfile(stale_path):
                            os.remove(stale_path)
                    except OSError as error:
                        errors.append("删除陈旧文件 %s: %s" % (relative, error))
                if errors:
                    failed.append((package_name, "; ".join(errors[:5])))
                    self.log("[警告] 内置插件 %s 更新不完整: %s"
                             % (package_name, "; ".join(errors)))
                else:
                    updated.append(package_name)
                    self.log("已把内置插件 %s 更新为 plugins/%s 最新源码"
                             % (package_name, package_name))
            except Exception as error:
                failed.append((package_name, str(error)))
                self.log("[警告] 内置插件 %s 更新失败: %s" % (package_name, error))
        return updated, up_to_date, not_installed, failed

    def mark_bundled_plugin_sync_pending(self):
        """写入"绿色版更新后需同步一次内置插件"标记 (由 run_post_update_bundled_sync 消费)。

        绿色版更新流程: 启动器写标记 -> 退出 -> 独立更新程序覆盖 -> 重启。
        标记放在 runtime/ 下 (更新程序不替换 runtime/), 重启后新启动器检测到
        标记即自动执行一次 update_bundled_plugins(), 保证"每次绿色版更新后
        自动同步一次内置插件"。"""
        try:
            with open(os.path.join(RUNTIME_DIR, "pending_bundled_plugin_check"),
                      "w", encoding="utf-8") as file_handle:
                file_handle.write("green-update")
        except OSError:
            pass

    def run_post_update_bundled_sync(self):
        """绿色版更新后自动同步一次内置插件 (幂等: 无标记直接返回)。

        检测到标记时执行 update_bundled_plugins() 并把结果写入日志, 随后清除标记。
        GUI 启动与 --start 无界面启动都会调用, 保证更新后首次启动即完成同步。"""
        marker = os.path.join(RUNTIME_DIR, "pending_bundled_plugin_check")
        if not os.path.isfile(marker):
            return
        try:
            os.remove(marker)
        except OSError:
            pass
        try:
            updated, up_to_date, _not_installed, failed = self.update_bundled_plugins()
            summary = []
            if updated:
                summary.append("已更新 %d 个: %s" % (len(updated), ", ".join(updated)))
            if up_to_date:
                summary.append("其余 %d 个已是最新" % len(up_to_date))
            if failed:
                summary.append("失败: %s" % "; ".join(
                    "%s(%s)" % (name, reason) for name, reason in failed))
            self.log("绿色版更新完成, 自动同步内置插件 → "
                     + ("；".join(summary) if summary else "(无可同步)"))
        except Exception as error:
            self.log("[警告] 绿色版更新后的内置插件自动同步失败: %s" % error)

    def remove_plugin(self, package_name, profile=DEFAULT_PROFILE):
        """从指定 profile 移除插件 (转发给 pnpm remove), 失败抛异常。
        移除后同步编排层, 把已卸载的包从 dsh.profile.bundles 清掉。"""
        self.log("开始移除插件: %s (profile: %s) ..." % (package_name, profile))
        exit_code, _output = self.run_plugin_command(profile, ["remove", package_name])
        if exit_code != 0:
            raise RuntimeError("插件移除失败 (退出码 %s), 请查看上方日志" % exit_code)
        changed, bundles = self.reconcile_bundles(profile, removed=[package_name])
        self.log("插件移除成功: %s" % package_name)
        if changed:
            self.log("已同步编排层 (dsh.profile.bundles): %s" % ", ".join(bundles))
        return True

    def list_installed_plugins(self, profile=DEFAULT_PROFILE):
        """读取 profile 的 package.json, 返回已安装插件字典 {包名: 版本}
        注意: 这是 dsh plugin 命令实际维护的插件清单 (dependencies 字段)"""
        package_json = os.path.join(DSH_HOME_DIR, "profiles", profile, "package.json")
        dependencies = {}
        if os.path.isfile(package_json):
            try:
                with open(package_json, "r", encoding="utf-8") as file_handle:
                    manifest = json.load(file_handle)
                dependencies = manifest.get("dependencies") or {}
            except Exception as error:
                self.log("读取 profile 插件清单失败: %s" % error)
        return dependencies

    @staticmethod
    def _is_dsh_plugin_package(package):
        """判断一个 npm 包是否像可安装的 dsh 插件 (过滤无关的普通 npm 包)
        判断依据: 包名 / 关键词 / 描述 任一命中 dsh 相关特征"""
        name = (package.get("name") or "").lower()
        keywords = " ".join(package.get("keywords") or []).lower()
        description = (package.get("description") or "").lower()
        if "dsh" in name:
            return True
        if "dsh" in keywords or "dsh-plugin" in keywords or "deepseek-harness" in keywords:
            return True
        if "dsh" in description or "deepseek harness" in description \
                or "deepseek-harness" in description:
            return True
        return False

    def search_npm_plugins(self, keyword, size=100):
        """通过 npm 注册表 (国内镜像优先) 搜索 dsh 插件, 返回列表
        结果只保留与 dsh 相关的包 (见 _is_dsh_plugin_package), 每项:
        {name, version, description, url, source='npm'}; 搜索失败抛异常"""
        mirror, is_auto = self.resolve_mirror()
        # auto 模式同样国内优先 (官方 registry 在国内访问很慢)
        registry = NPM_REGISTRY["cn"] if mirror == "cn" or is_auto else NPM_REGISTRY["official"]
        encoded_keyword = urllib.parse.quote(keyword)
        url = "%s/-/v1/search?text=%s&size=%d" % (registry, encoded_keyword, size)
        self.log("正在搜索插件: %s" % url)
        request = urllib.request.Request(url, headers={"User-Agent": "DSH-Launcher/1.0"})
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
        plugins = []
        for item in payload.get("objects", []):
            package = item.get("package", {})
            if not self._is_dsh_plugin_package(package):
                continue
            plugins.append({
                "name": package.get("name", ""),
                "version": package.get("version", ""),
                "description": (package.get("description") or "").strip(),
                "url": package.get("links", {}).get("npm", ""),
                "source": "npm",
            })
        self.log("搜索到 %d 个相关结果" % len(plugins))
        return plugins

    def fetch_github_topic_plugins(self, topic="dsh-plugin"):
        """抓取 GitHub 官方话题页第一页热门仓库 (按星标排序, 约 20 个), 返回列表
        每项: {name(owner/repo), version='GitHub', description, url, source='github'}
        页面结构变化或网络失败时抛异常"""
        url = "https://github.com/topics/%s" % topic
        self.log("正在抓取 GitHub 官方话题页: %s" % url)
        ssl_context = ssl.create_default_context()
        request = urllib.request.Request(
            url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
        with urllib.request.urlopen(request, context=ssl_context, timeout=30) as response:
            html = response.read().decode("utf-8", "ignore")
        # 仓库条目链接形如 href="/owner/repo" 且 class 含 "Link text-bold wb-break-word"
        pattern = re.compile(
            r'href="/([^"/]+/[^"/]+)"[^>]*class="Link text-bold wb-break-word">([^<]+)</a>')
        plugins = []
        seen = set()
        for owner_repo, repo_name in pattern.findall(html):
            if owner_repo in seen:
                continue
            seen.add(owner_repo)
            plugins.append({
                "name": owner_repo,                       # 形如 owner/repo
                "version": "GitHub",
                "description": repo_name,
                "url": "https://github.com/%s" % owner_repo,
                "source": "github",
            })
        self.log("GitHub 官方话题页抓到 %d 个热门仓库" % len(plugins))
        return plugins

    def seed_default_workspace(self):
        """把自动解析出的安全默认工作区预置为 dsh 工作区 (绿色便携, 不写死)。

        背景: dsh 的 Windows ACL 沙箱要求临时根目录(runtime/tmp)不能位于
        会话工作区内部。若工作区是程序根目录, runtime/tmp 落在其内部, 所有
        shell 工具会报: "Windows ACL temp root must be outside the workspace"。
        解决: 不写死路径, 由 resolve_default_workspace() 自动判定——临时目录
        与程序根目录冲突时才预置程序目录内的 workspace 子目录, 不冲突时默认
        工作区直接用程序根目录本身。所有数据仍在程序目录内, 保持绿色便携。

        仅在服务未运行时调用(由 prepare_all 触发); 任何异常只记日志, 不阻断启动。
        """
        workspace_path = self.resolve_default_workspace()
        workspace_title = os.path.basename(workspace_path) or "workspace"
        storage_path = os.path.join(DSH_HOME_DIR, "storages", "workspace.json")
        try:
            if not os.path.isdir(workspace_path):
                return
            if not os.path.isfile(storage_path):
                return   # dsh 尚未初始化工作区注册表, 不做干预
            with open(storage_path, "r", encoding="utf-8") as file_handle:
                data = json.load(file_handle)
            tables = data.get("tables") if isinstance(data, dict) else None
            workspaces = tables.get("workspaces") if isinstance(tables, dict) else None
            if not isinstance(workspaces, dict):
                return   # 结构不符, 不干预
            target = os.path.normcase(os.path.normpath(workspace_path))
            for record in workspaces.values():
                if isinstance(record, dict) and \
                        os.path.normcase(os.path.normpath(record.get("path") or "")) == target:
                    return   # 已预置过
            import uuid
            new_id = str(uuid.uuid4())
            now = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
            workspaces[new_id] = {
                "path": workspace_path,
                "title": workspace_title,
                "sessionIds": [],
                "createdAt": now,
                "updatedAt": now,
            }
            global_state = data.setdefault("global", {})
            if not isinstance(global_state, dict):
                return
            global_state.setdefault("workspaceIds", []).append(new_id)
            # 原子写回 (同目录临时文件 + 替换, 避免写坏)
            temp_path = storage_path + ".seed.tmp"
            with open(temp_path, "w", encoding="utf-8") as file_handle:
                json.dump(data, file_handle, ensure_ascii=False, indent=2)
            os.replace(temp_path, storage_path)
            self.log("已预置默认工作区: %s (在 dsh 界面左侧选择该工作区新建会话)" % workspace_path)
        except Exception as error:
            self.log("预置默认工作区失败(不影响启动): %s" % error)

    def prepare_all(self):
        """一键准备全部环境 (内置 Python + Node + dsh + 内置插件 + 桌面版依赖), 供启动前调用。
        返回内置 Python 是否就绪 (True/False)。Node/dsh 失败会抛异常; 仅 Python 属
        可降级项 —— dsh 服务由 Node 运行, 缺失内置 Python 不影响启动服务, 但 start.bat
        脚本版需要它, 故以布尔返回让调用方能看到"python 失败"而不是假装都装好了。"""
        self.ensure_runtime_dirs()
        self.seed_default_workspace()
        python_ok = self.prepare_python()
        self.prepare_node()
        self.prepare_dsh()
        # 安装环境最后自动把所有计划内置的插件都装上 (已装的跳过, 单个失败不中断)。
        # 注意: prepare_all 在每次启动服务前也会调用, 因"已装跳过"故幂等, 无重复安装开销。
        if self.dsh_installed():
            installed_now, skipped, failed = self.install_bundled_plugins()
            if installed_now:
                self.log("内置插件已自动安装: %s" % ", ".join(installed_now))
            if failed:
                self.log("[警告] 内置插件安装失败: %s (可在插件管理里重试)" % ", ".join(failed))
        if python_ok:
            self.log("环境准备完成, 可以启动服务")
        else:
            self.log("环境准备完成, 但内置便携 Python 下载失败 (不影响 dsh 服务; "
                     "可后续点「安装环境」重试, 或用 start.bat 走系统 Python 兜底)")
        # 桌面版依赖 (pywebview, WebView2 后端): 便携 python 就绪时一并装好,
        # 让【安装环境】一次到位; 之后点「桌面窗口」不再静默补装 (幂等, 已装跳过)。
        if python_ok:
            self.prepare_desktop_deps()
        return python_ok

    def _desktop_deps_ready(self, python_exe):
        """探测便携 python 是否已装好桌面版依赖 (pywebview 可 import)。

        桌面版 = desktop-shell.py 的内嵌 WebView2 独立窗口, 依赖 pywebview(pythonnet)。
        用"python -c import webview"以运行时为准探测, 避免只看目录是否存在。
        Args:
            python_exe (str): 便携 python 可执行文件绝对路径。
        Returns:
            bool: True 表示 pywebview 可用。
        """
        try:
            probe_result = subprocess.run(
                [python_exe, "-c", "import webview"],
                capture_output=True, timeout=30)
            return probe_result.returncode == 0
        except Exception:
            return False

    def prepare_desktop_deps(self):
        """确保桌面版依赖 (pywebview + pythonnet) 装进便携 python; 已装直接返回。

        由【安装环境】与【打开桌面窗口】前调用: 未装则自动 pip 安装
        (带实时进度日志, 非静默), 装不上返回 False (浏览器方式不受影响)。
        Returns:
            bool: True 表示桌面版依赖已就绪。
        """
        python_exe = self.find_python_exe()
        if python_exe is None:
            self.log("未找到便携 Python, 无法安装桌面版依赖 (桌面版需先点「安装环境」)")
            return False
        if self._desktop_deps_ready(python_exe):
            self.log("桌面版依赖已就绪 (pywebview)")
            return True
        self.log("未检测到桌面版依赖 pywebview, 开始自动安装 (首次约需几十秒, 仅桌面版需要) ...")
        pip_command = [
            python_exe, "-m", "pip", "install",
            "pywebview", "pythonnet",
            "--index-url", "https://mirrors.aliyun.com/pypi/simple/",
            "--no-warn-script-location",
        ]
        try:
            return_code, _output = self._stream_subprocess(
                pip_command, cwd=os.path.dirname(python_exe), env=dict(os.environ),
                timeout=300, log_prefix="pip: ", heartbeat_interval=60)
        except subprocess.TimeoutExpired:
            self.log("桌面版依赖安装超时, 可稍后点「桌面窗口」重试 (浏览器方式不受影响)")
            return False
        if return_code != 0 or not self._desktop_deps_ready(python_exe):
            self.log("桌面版依赖安装失败, 可稍后重试 (浏览器方式不受影响)")
            return False
        self.log("桌面版依赖安装成功, 可正常使用独立桌面窗口")
        return True

    # ---------- 服务启动 / 停止 ----------
    def build_server_command(self):
        """构造启动 dsh web 服务的命令列表"""
        node_exe = self.find_node_exe()
        if node_exe is None:
            raise RuntimeError("未找到便携版 Node, 请先准备环境")
        dsh_js = os.path.join(DSH_DIR, DSH_BIN_JS)
        if not os.path.isfile(dsh_js):
            raise RuntimeError("未找到 dsh 入口文件: %s" % dsh_js)
        port = int(self.config.get("dsh_port", 3080))
        command = [node_exe, dsh_js, "web", "--port", str(port)]
        # 官方 dsh 在服务就绪后默认会自动打开系统默认浏览器 (openBrowser 默认 true,
        # 仅加了 --no-open 才关闭)。界面打开方式由启动器 open_ui 统一接管
        # (桌面壳/网页窗口, 按 config.open_method), 故强制 --no-open,
        # 否则会"官方自动开一个浏览器 + 我们又开一个界面"双开。
        command.append("--no-open")
        # 绑定地址: 默认 127.0.0.1 (仅本机); 局域网模式为 0.0.0.0 (需 startup.js 补丁放开)
        dsh_host = str(self.config.get("dsh_host", "127.0.0.1")).strip()
        if dsh_host:
            command.extend(["--host", dsh_host])
        # 受信任主机: 逐条追加 --trusted-host。
        # 语义 (patch_lan_trust 已配合): 不填=绑定 0.0.0.0 时自动信任全部局域网;
        # 填了任意一个=只信任显式填写的地址(host 或 host:port), 不再自动全局域网放行。
        for trusted_host in self.config.get("trusted_hosts", []) or []:
            trusted_host = str(trusted_host).strip()
            if trusted_host:
                command.extend(["--trusted-host", trusted_host])
        return command

    def patch_web_startup(self):
        """补丁 dsh web 启动器: 放开 --host 0.0.0.0 (局域网远程访问用, 幂等可重复)。
        官方默认拒绝 0.0.0.0 (会向局域网暴露远程工具执行能力); 本启动器仅在用户
        显式选择「局域网」绑定且了解风险后启用。dsh 升级重装后由 install_dsh()
        自动重新补丁。返回 True 表示就绪(或已是最新)。"""
        startup_path = os.path.join(DSH_DIR, "node_modules", "@deepseek-ai",
                                    "dsh-web-app", "lib", "startup.js")
        if not os.path.isfile(startup_path):
            return False
        marker = 'options.host === "0.0.0.0"'
        try:
            with open(startup_path, "r", encoding="utf-8") as file_handle:
                text = file_handle.read()
        except OSError:
            return False
        if marker not in text:
            return True
        new_text = text.replace(
            marker, 'false /* dsh-launcher: 已放开 0.0.0.0 以支持局域网访问 */')
        try:
            with open(startup_path, "w", encoding="utf-8") as file_handle:
                file_handle.write(new_text)
        except OSError:
            return False
        self.log("已补丁 dsh web 启动器: 放开 --host 0.0.0.0 (局域网访问)")
        return True

    def patch_lan_trust(self):
        """补丁 dsh web 的 resolveLanTrust: 实现「受信任主机」的精确语义 (幂等可重复)。
        官方实现绑定 0.0.0.0 时无条件把全部局域网 IPv4 加入信任列表 (trustedHosts =
        [...lanAddresses, ...extra]), 导致用户填写了 trusted_hosts 后仍全局域网放行,
        "填了也白填"。本补丁改为: trusted_hosts 为空时保持默认(自动信任全部局域网);
        trusted_hosts 非空时不再自动信任局域网, 只信任用户显式填写的地址(host 或 host:port)。
        dsh 升级重装后由 install_dsh() 自动重新补丁。返回 True 表示就绪(或已是最新)。"""
        index_path = os.path.join(DSH_DIR, "node_modules", "@deepseek-ai",
                                  "dsh-web-app", "lib", "index.js")
        if not os.path.isfile(index_path):
            return False
        marker = 'trustedHosts: [...lanAddresses, ...extra]'
        try:
            with open(index_path, "r", encoding="utf-8") as file_handle:
                text = file_handle.read()
        except OSError:
            return False
        if marker not in text:
            return True
        replacement = ('trustedHosts: extra.length === 0 '
                       '? [...lanAddresses, ...extra] '
                       ': [...extra] /* dsh-launcher: 填了信任主机则只信任显式填写的 */')
        new_text = text.replace(marker, replacement)
        try:
            with open(index_path, "w", encoding="utf-8") as file_handle:
                file_handle.write(new_text)
        except OSError:
            return False
        self.log("已补丁 dsh web 信任围栏: 受信任主机非空时只信任显式填写的地址")
        return True

    def patch_lan_api_trust(self):
        """补丁 dsh client-connection 的 /api 信任围栏 (两段式, 幂等可重复)。
        背景 (2026-08-17 实测): dsh 官方把 client-connection 的 /api 通道与特权方法
        (host.pickDirectory 等 PRIVILEGED_METHODS) 默认 pin 死在 loopback——局域网模式
        (0.0.0.0) 下用局域网 IP / 本机局域网 IP 访问 WebUI 时, 所有 /api 请求都返回
        HTTP 403, 报 "transport failure for /api/host.pickDirectory: HTTP 403"。
        两段式拆分 (更灵活, 可随官方演进逐步停用; 任一段结构不匹配只跳过该段并告警,
        绝不整块跳过或破坏运行):
          段1 (hostname 兼容): 只把 Origin 同源比较从 host(带端口) 放开为 hostname(忽略
            端口)。这是 Chrome 150+ 无端口 Origin 引出的官方 bug——本机与局域网带 Origin
            的请求都走同一处比较; 官方若已自行放宽/修复, 本段幂等自动跳过, 不误伤其它。
          段2 (局域网 trustedHosts): 未显式配置信任主机时, 自动把 dsh-web-app 提供的
            lanAddresses 并入信任列表, 并给被拒的 403 出口加诊断日志。仅在局域网模式下
            需要; DSH 官方本就将 trustedHosts 暴露为插件级 config.trustedHosts schema
            (零改官方可注入), 未来可把本段收敛为纯配置注入。
        CSRF 防护 (sec-fetch-site / origin 同 hostname) 与 DNS-rebinding 防护均保留。
        说明: register() 是类方法, 闭包访问不到 apply() 内的 log403, 故用内联
        console.error; 其余出口 (route/websocket/fetchHandler) 在 apply 作用域内可用。
        dsh 升级重装后由 install_dsh() 自动重新补丁。返回 True 表示就绪(或已是最新)。"""
        connection_path = os.path.join(DSH_DIR, "node_modules", "@deepseek-ai",
                                       "dsh-client-connection", "lib", "index.js")
        if not os.path.isfile(connection_path):
            return False
        try:
            with open(connection_path, "r", encoding="utf-8") as file_handle:
                text = file_handle.read()
        except OSError:
            return False
        # 完整 v3 幂等检查: 具备 hostname 比较 + 各出口日志
        if ("new URL(origin).hostname" in text
                and 'log403("fetchHandler"' in text and 'log403("route"' in text
                and 'log403("websocket"' in text
                and "[client-connection:403] register" in text):
            return True   # 已是完整 v3 补丁, 幂等返回

        # ---------- 官方面貌 (用于还原与替换锚点) ----------
        original_trust = "const trustedHosts = config?.trustedHosts ?? [];"
        original_privileged = "!isTrustedApiRequest(request, [])) return new Response(\"forbidden\", { status: 403 });"
        original_route = ("if (!isTrustedApiRequest(req, trustedHosts)) {\n"
                          "\t\t\tres.writeHead(403);\n"
                          "\t\t\tres.end(\"forbidden\");\n"
                          "\t\t\treturn;\n"
                          "\t\t}")
        original_register = ("if (!isTrustedApiRequest(req, trustedHosts)) {\n"
                             "\t\t\t\tres.writeHead(403);\n"
                             "\t\t\t\tres.end(\"forbidden\");\n"
                             "\t\t\t\treturn;\n"
                             "\t\t\t}")
        original_ws = ("if (!isTrustedApiRequest(req, trustedHosts)) {\n"
                       "\t\t\t\t\trejectWebSocketUpgrade(socket);\n"
                       "\t\t\t\t\treturn;\n"
                       "\t\t\t\t}")
        original_interceptor = ('if (interceptor.options.authority === "loopback" && !isTrustedApiRequest(request, [])) '
                                'return Promise.resolve(new Response("forbidden", { status: 403 }));')
        original_origin = ("try {\n"
                           "\t\treturn new URL(origin).host === hostUrl.host;\n"
                           "\t} catch {")

        # ---------- v1 / v2 已知补丁片段 (用于还原) ----------
        v1_trust = ("let trustedHosts = config?.trustedHosts ?? [];\n"
                    "\t// dsh-launcher LAN patch: 局域网模式(0.0.0.0)且未显式配置信任主机时, 自动把\n"
                    "\t// dsh-web-app 提供的本机局域网 IPv4 (webRuntime.lanAddresses) 并入信任列表;\n"
                    "\t// 否则 /api 通道与 pickDirectory 等特权 API 被 client-connection 默认 pin 死在\n"
                    "\t// loopback, 局域网 IP / 本机局域网 IP 访问会全部 HTTP 403 (仅 127.0.0.1 可用)。\n"
                    "\tconst webRuntime = ctx.get?.(\"webRuntime\");\n"
                    "\tif (trustedHosts.length === 0 && webRuntime?.lanAddresses?.length > 0) {\n"
                    "\t\ttrustedHosts = [...webRuntime.lanAddresses];\n"
                    "\t}")
        v1_privileged = "!isTrustedApiRequest(request, trustedHosts)) return new Response(\"forbidden\", { status: 403 });"
        v2_trust = (
            "let trustedHosts = config?.trustedHosts ?? [];\n"
            "\t// dsh-launcher LAN patch: 局域网模式(0.0.0.0)且未显式配置信任主机时, 自动把\n"
            "\t// dsh-web-app 提供的本机局域网 IPv4 (webRuntime.lanAddresses) 并入信任列表;\n"
            "\t// 否则 /api 通道与 pickDirectory 等特权 API 被 client-connection 默认 pin 死在\n"
            "\t// loopback, 局域网 IP / 本机局域网 IP 访问会全部 HTTP 403 (仅 127.0.0.1 可用)。\n"
            "\tconst webRuntime = ctx.get?.(\"webRuntime\");\n"
            "\tif (trustedHosts.length === 0 && webRuntime?.lanAddresses?.length > 0) {\n"
            "\t\ttrustedHosts = [...webRuntime.lanAddresses];\n"
            "\t}\n"
            "\t// dsh-launcher: 403 诊断日志 (v2) —— 记录被信任围栏拒绝的请求头, 排查\n"
            "\t// \"transport failure for /api/host.pickDirectory: HTTP 403\" 时看 server.log。\n"
            "\tconsole.error(\"[client-connection] LAN patch v2 active, trustedHosts=\" + JSON.stringify(trustedHosts)\n"
            "\t\t+ \" lanAddresses=\" + JSON.stringify(webRuntime?.lanAddresses));\n"
            "\tconst log403 = (where, request) => {\n"
            "\t\tconsole.error(\"[client-connection:403] \" + where\n"
            "\t\t\t+ \" url=\" + request.url\n"
            "\t\t\t+ \" method=\" + (request.method ?? \"\")\n"
            "\t\t\t+ \" ua=\" + header(request.headers, \"user-agent\")\n"
            "\t\t\t+ \" host=\" + header(request.headers, \"host\")\n"
            "\t\t\t+ \" origin=\" + header(request.headers, \"origin\")\n"
            "\t\t\t+ \" sec-fetch-site=\" + header(request.headers, \"sec-fetch-site\")\n"
            "\t\t\t+ \" referer=\" + header(request.headers, \"referer\")\n"
            "\t\t\t+ \" trustedHosts=\" + JSON.stringify(trustedHosts));\n"
            "\t};")
        v2_privileged = ("!isTrustedApiRequest(request, trustedHosts)) { log403(\"fetchHandler\", request); "
                         "return new Response(\"forbidden\", { status: 403 }); }")
        v2_route = ("if (!isTrustedApiRequest(req, trustedHosts)) {\n"
                    "\t\t\tlog403(\"route\", req);\n"
                    "\t\t\tres.writeHead(403);\n"
                    "\t\t\tres.end(\"forbidden\");\n"
                    "\t\t\treturn;\n"
                    "\t\t}")
        v2_register = ("if (!isTrustedApiRequest(req, trustedHosts)) {\n"
                       "\t\t\t\tconsole.error(\"[client-connection:403] register host=\" + header(req.headers, \"host\")\n"
                       "\t\t\t\t\t+ \" origin=\" + header(req.headers, \"origin\")\n"
                       "\t\t\t\t\t+ \" sec-fetch-site=\" + header(req.headers, \"sec-fetch-site\"));\n"
                       "\t\t\t\tres.writeHead(403);\n"
                       "\t\t\t\tres.end(\"forbidden\");\n"
                       "\t\t\t\treturn;\n"
                       "\t\t\t}")
        v2_register_flat = ("if (!isTrustedApiRequest(req, trustedHosts)) {\n"
                            "\t\t\t\tconsole.error(\"[client-connection:403] register host=\" + header(req.headers, \"host\")"
                            " + \" origin=\" + header(req.headers, \"origin\")"
                            " + \" sec-fetch-site=\" + header(req.headers, \"sec-fetch-site\"));\n"
                            "\t\t\t\tres.writeHead(403);\n"
                            "\t\t\t\tres.end(\"forbidden\");\n"
                            "\t\t\t\treturn;\n"
                            "\t\t\t}")
        v2_ws = ("if (!isTrustedApiRequest(req, trustedHosts)) {\n"
                 "\t\t\t\t\tlog403(\"websocket\", req);\n"
                 "\t\t\t\t\trejectWebSocketUpgrade(socket);\n"
                 "\t\t\t\t\treturn;\n"
                 "\t\t\t\t}")
        v2_interceptor = ('if (interceptor.options.authority === "loopback" && !isTrustedApiRequest(request, [])) { '
                          'console.error("[client-connection:403] interceptor host=" + header(request.headers, "host") '
                          '+ " origin=" + header(request.headers, "origin") '
                          '+ " sec-fetch-site=" + header(request.headers, "sec-fetch-site")); '
                          'return Promise.resolve(new Response("forbidden", { status: 403 })); }')
        v3_origin = ("try {\n"
                     "\t\t// dsh-launcher patch v3: 只比较 hostname, 忽略端口。\n"
                     "\t\t// Chrome 150+ 对 http://127.0.0.1:<port> 页面的同源请求会发送不带端口的\n"
                     "\t\t// Origin (http://127.0.0.1), 官方用 new URL(origin).host === hostUrl.host\n"
                     "\t\t// 比较会把 \"127.0.0.1\" 与 \"127.0.0.1:3080\" 判为不等 → 全部 /api 403。\n"
                     "\t\t// 端口不是 CSRF / DNS-rebinding 边界, 忽略它不影响安全语义。\n"
                     "\t\treturn new URL(origin).hostname === hostUrl.hostname;\n"
                     "\t} catch {")

        # ---------- 还原所有已知补丁片段为官方原样 ----------
        for old, new in ((v3_origin, original_origin),
                         (v2_trust, original_trust), (v1_trust, original_trust),
                         (v2_privileged, original_privileged), (v1_privileged, original_privileged),
                         (v2_route, original_route), (v2_register, original_register),
                         (v2_register_flat, original_register),
                         (v2_ws, original_ws), (v2_interceptor, original_interceptor)):
            text = text.replace(old, new, 1)

        # ---------- 打补丁: 段1 本机/共用 Chrome150 兼容 (仅 Origin 比较) ----------
        # 只改那一行判定: host(带端口) -> hostname(忽略端口)。
        origin_patched = False
        if "new URL(origin).hostname" in text:
            origin_patched = True                 # 官方已自行放宽/修复, 幂等跳过
        elif original_origin in text:
            text = text.replace(original_origin, v3_origin, 1)
            origin_patched = True
        else:
            self.log("跳过 client-connection 段1(Origin hostname 兼容) 补丁: 目标代码结构不匹配")

        # ---------- 打补丁: 段2 局域网 trustedHosts 注入 + 403 诊断日志 ----------
        # 官方把 trustedHosts 暴露为插件级 config schema; 这里仍以运行时代码注入兜底,
        # 端口/结构一旦不对只跳过本段, 不影响段1。
        lan_patched = False
        if "[client-connection:403]" in text and "LAN patch v2 active" in text:
            lan_patched = True                    # 已打
        elif original_trust not in text or original_privileged not in text:
            self.log("跳过 client-connection 段2(局域网 trustedHosts) 补丁: 目标代码结构不匹配 (dsh 版本可能已大改)")
        else:
            text = text.replace(original_trust, v2_trust, 1)
            text = text.replace(original_privileged, v2_privileged, 1)
            text = text.replace(original_route, v2_route, 1)
            text = text.replace(original_register, v2_register, 1)
            text = text.replace(original_ws, v2_ws, 1)
            text = text.replace(original_interceptor, v2_interceptor, 1)
            lan_patched = True

        if not (origin_patched or lan_patched):
            # 两段结构都不匹配 (dsh 版本大改时), 不强行写回, 避免破坏运行
            self.log("跳过 client-connection 补丁: 两段目标结构均不匹配 (dsh 版本可能已大改)")
            return False
        try:
            with open(connection_path, "w", encoding="utf-8") as file_handle:
                file_handle.write(text)
        except OSError:
            return False
        applied_segments = []
        if origin_patched:
            applied_segments.append("段1 Chrome150 hostname 兼容")
        if lan_patched:
            applied_segments.append("段2 局域网 trustedHosts+403日志")
        self.log("已补丁 dsh client-connection (两段式, " + " + ".join(applied_segments) + "): /api 不再 403")
        return True

    def lan_addresses(self):
        """枚举本机非内网 IPv4 地址列表 (绑定 0.0.0.0 时用于提示局域网访问地址)。
        仅作提示用途, 不保证覆盖所有网卡; 出错时静默返回空列表"""
        result = []
        try:
            for addresses in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                ip = addresses[4][0]
                if not ip.startswith("127.") and ip not in result:
                    result.append(ip)
        except OSError:
            pass
        return result

    def ensure_firewall_port(self, port):
        """为局域网访问放行指定 TCP 端口入站 (Windows 防火墙, 幂等可重复)。
        背景 (2026-08-18, 需求 #54): 局域网模式下服务由 node.exe 监听 3080, 但旧版
        防火墙规则按"程序 (dsh_launcher.exe)"放行, 只对该 exe 生效, node.exe 入站
        仍被拦, 导致手机连不上。绿色版要在任意电脑都能用, 必须改成按端口放行, 并在
        每次启动服务前自动确保规则存在, 而不是依赖用户手动设置。
        已存在同名规则 (同名多条 netsh 会累加, 会重复报已存在), 故先按名删除再新增,
        保证每次调用都能落到"端口级 TCP 放行"的最终状态; 删除失败(规则不存在)忽略。
        需管理员权限; 无权限/非 Windows/命令失败时仅记日志, 不阻断主流程。
        """
        if sys.platform != "win32":
            return False
        rule_name = "DSH Green 3080 %d" % port
        # 先清理同名旧规则 (无则忽略), 再新增端口级放行
        try:
            subprocess.call(
                ["netsh", "advfirewall", "firewall", "delete", "rule", "name=%s" % rule_name],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            pass
        try:
            command = ["netsh", "advfirewall", "firewall", "add", "rule",
                       "name=%s" % rule_name, "dir=in", "action=allow",
                       "protocol=TCP", "localport=%d" % port]
            result = subprocess.call(command, stdout=subprocess.DEVNULL,
                                     stderr=subprocess.DEVNULL)
            if result != 0:
                self.log("[警告] 无法写入 Windows 防火墙放行规则 (需要管理员权限): "
                         "局域网访问端口 %d 可能不可达" % port)
                return False
            self.log("已放行 Windows 防火墙端口 %d (入站 TCP, 局域网可访问)" % port)
            return True
        except OSError as error:
            self.log("[警告] 写入 Windows 防火墙规则出错: %s" % error)
            return False

    # ---------- WebUI 单页面去重 (心跳检测) ----------
    def _ui_beacon_token(self):
        """读取(或生成并持久化)心跳令牌, 防止其它本地页面伪造"界面已打开"的上报"""
        try:
            if os.path.isfile(UI_BEACON_TOKEN_FILE):
                with open(UI_BEACON_TOKEN_FILE, "r", encoding="utf-8") as file_handle:
                    token = file_handle.read().strip()
                if token:
                    return token
            token = secrets.token_hex(8)
            with open(UI_BEACON_TOKEN_FILE, "w", encoding="utf-8") as file_handle:
                file_handle.write(token)
            return token
        except OSError:
            # 无法读写令牌文件时退化为固定令牌 (仅影响防伪造, 不影响去重功能)
            return "dsh-launcher-local"

    def _record_ui_ping(self, timestamp):
        """记录一次 WebUI 心跳 (由心跳服务回调)"""
        self._last_ui_ping = timestamp

    def _ensure_ui_beacon_server(self):
        """确保 WebUI 心跳接收服务已启动 (幂等, 失败不阻断主流程)。
        绑定地址随 dsh_host: 本机模式绑 127.0.0.1, 局域网模式绑 0.0.0.0 (远程浏览器也能上报)。
        端口被占用时仅记日志并禁用去重"""
        if self._beacon_server is not None:
            return True
        port = int(self.config.get("ui_beacon_port", UI_BEACON_PORT))
        bind_host = "0.0.0.0" if self.config.get("dsh_host", "127.0.0.1") == "0.0.0.0" else "127.0.0.1"
        try:
            handler_class = UiBeaconHandler
            handler_class.token = self._ui_beacon_token()
            handler_class.on_ping = self._record_ui_ping
            server = http.server.ThreadingHTTPServer((bind_host, port), handler_class)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self._beacon_server = server
            self.log("WebUI 心跳服务已启动 (%s:%d), 用于检测界面是否已打开" % (bind_host, port))
            return True
        except OSError as error:
            self.log("WebUI 心跳服务启动失败 (端口 %d 可能被占用), 本次不启用去重: %s"
                     % (port, error))
            return False

    def ui_is_open(self):
        """判断 WebUI 是否已在浏览器中打开 (最近 UI_ALIVE_WINDOW 秒内收到过心跳)"""
        if self._last_ui_ping is None:
            return False
        return (time.time() - self._last_ui_ping) <= UI_ALIVE_WINDOW

    # ---------- WebUI 前端心跳脚本注入 (幂等) ----------
    def frontend_index_path(self):
        """返回 dsh Web 前端实际渲染的 index.html 路径 (服务从该文件读 HTML 再注入启动清单)"""
        return os.path.join(DSH_DIR, "node_modules", "@deepseek-ai",
                            "dsh-web-frontend", "dist", "index.html")

    def patch_frontend(self):
        """向 WebUI 前端 index.html 注入心跳脚本 (幂等, 可重复调用)。
        脚本在页面打开后运行, 每 UI_BEACON_PING_INTERVAL 秒向启动器心跳服务上报一次,
        供 ui_is_open() 判断"界面已打开"。dsh 安装/升级后由 install_dsh() 自动重新注入。
        返回 True 表示注入(或已是最新)成功, False 表示文件不可写/不存在"""
        index_path = self.frontend_index_path()
        if not os.path.isfile(index_path):
            return False
        port = int(self.config.get("ui_beacon_port", UI_BEACON_PORT))
        token = self._ui_beacon_token()
        beacon_block = (
            "%s\n"
            "<script>\n"
            "(function () {\n"
            "  try {\n"
            "    var endpoint = \"http://\" + location.hostname + \":%d%s?t=%s\";\n"
            "    function ping() { try { fetch(endpoint, { mode: \"no-cors\" }).catch(function () {}); } catch (e) {} }\n"
            "    ping(); setInterval(ping, %d);\n"
            "  } catch (e) {}\n"
            "})();\n"
            "</script>\n"
            "%s" % (UI_BEACON_MARKER_START, port, UI_BEACON_PATH, token,
                    UI_BEACON_PING_INTERVAL * 1000, UI_BEACON_MARKER_END))
        try:
            with open(index_path, "r", encoding="utf-8") as file_handle:
                html = file_handle.read()
        except OSError:
            return False
        # 已注入过: 令牌/端口变化时整体替换, 未变化则保持不变
        if UI_BEACON_MARKER_START in html:
            begin = html.index(UI_BEACON_MARKER_START)
            if UI_BEACON_MARKER_END in html[begin:]:
                end = html.index(UI_BEACON_MARKER_END, begin) + len(UI_BEACON_MARKER_END)
            else:
                end = len(html)
            if html[begin:end] == beacon_block:
                return True
            html = html[:begin] + beacon_block + html[end:]
        elif "</body>" in html:
            html = html.replace("</body>", beacon_block + "\n</body>", 1)
        else:
            html = html + "\n" + beacon_block
        try:
            with open(index_path, "w", encoding="utf-8") as file_handle:
                file_handle.write(html)
        except OSError:
            return False
        self.log("已向 WebUI 注入\"单页面去重\"心跳脚本 (端口 %d, 每 %d 秒上报)"
                 % (port, UI_BEACON_PING_INTERVAL))
        return True

    def patch_frontend_uuid(self):
        """向 WebUI 前端 index.html 注入 crypto.randomUUID polyfill (幂等, 可重复调用)。
        背景 (2026-08-18, 需求 #47): crypto.randomUUID() 是浏览器 Web API, 只在
        secure context (HTTPS 或 localhost/127.0.0.1 环回地址) 下存在。局域网模式下用
        内网 IP (如 http://192.168.x.x:3080) 普通 HTTP 访问时, 页面不被视为安全上下文,
        crypto.randomUUID 为 undefined, 官方客户端在 dsh-client-connection 的
        MessageId(crypto.randomUUID()) 与 mintRpcId()->RpcId(crypto.randomUUID()) 两处
        直接调用会抛 "crypto.randomUUID is not a function", 导致会话消息/RPC 全断,
        UA 现象就是"会话记录获取不到、添加工作区报错"; 而 127.0.0.1 属环回故正常。
        解决: 用 getRandomValues (官方 randomUuid 同思路, 非安全上下文也可用) 兜底实现
        RFC4122 v4, 仅在 crypto.randomUUID 缺失时注入, 已有则不重复。dsh 升级重装后
        由 install_dsh() 自动重新注入。返回 True 表示就绪, False 表示文件不可写/不存在。
        """
        index_path = self.frontend_index_path()
        if not os.path.isfile(index_path):
            return False
        helper = (
            "          var dshCryptoSrc = globalThis.crypto;\n"
            "          if (dshCryptoSrc && typeof dshCryptoSrc.getRandomValues === 'function'\n"
            "              && typeof dshCryptoSrc.randomUUID !== 'function') {\n"
            "            function dshRandomUUID() {\n"
            "              var bytes = dshCryptoSrc.getRandomValues(new Uint8Array(16));\n"
            "              bytes[6] = (bytes[6] & 0x0f) | 0x40;   // RFC4122 v4 版本字段\n"
            "              bytes[8] = (bytes[8] & 0x3f) | 0x80;   // variant 10xx\n"
            "              var hexList = [];\n"
            "              for (var i = 0; i < 16; i++) {\n"
            "                var part = bytes[i].toString(16);\n"
            "                if (part.length < 2) part = '0' + part;\n"
            "                hexList.push(part);\n"
            "              }\n"
            "              var hex = hexList.join('');\n"
            "              return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-'\n"
            "                + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-'\n"
            "                + hex.slice(20);\n"
            "            }\n"
            "            dshCryptoSrc.randomUUID = dshRandomUUID;\n"
            "          }\n"
        )
        uuid_block = (
            "%s\n"
            "<script>\n"
            "(function () {\n"
            "  try {\n"
            "%s"
            "  } catch (e) {}\n"
            "})();\n"
            "</script>\n"
            "%s" % (UI_UUID_MARKER_START, helper, UI_UUID_MARKER_END))
        try:
            with open(index_path, "r", encoding="utf-8") as file_handle:
                html = file_handle.read()
        except OSError:
            return False
        # 幂等: 已注入过直接返回, 避免重复
        if UI_UUID_MARKER_START in html:
            return True
        # 优先插到 </head> 前 (越靠前越早在官方 bundle 前执行), 否则兜底插到 </body> 前
        if "</head>" in html:
            html = html.replace("</head>", uuid_block + "\n</head>", 1)
        elif "</body>" in html:
            html = html.replace("</body>", uuid_block + "\n</body>", 1)
        else:
            html = html + "\n" + uuid_block
        try:
            with open(index_path, "w", encoding="utf-8") as file_handle:
                file_handle.write(html)
        except OSError:
            return False
        self.log("已向 WebUI 注入 crypto.randomUUID polyfill (局域网 http 访问不再缺失)")
        return True

    def start_server(self, open_browser=True):
        """启动 dsh web 服务, 可选自动打开浏览器"""
        if self.is_server_running():
            self.log("服务已在运行中, 无需重复启动")
            if open_browser:
                self.open_ui()
            return True

        # 启动前自动清理: 端口若被孤儿 dsh 进程占用则先清理, 避免新进程 EADDRINUSE
        # 启动失败 (2026-08-18, 需求 #46: 手动点「启动服务」时自动检查并清理)
        port = int(self.config.get("dsh_port", 3080))
        self._cleanup_orphan_dsh(port)

        self._ensure_ui_beacon_server()   # 先启动心跳服务, 使已打开页面的上报能尽早被记录
        self.log("正在准备环境 ...")
        self.prepare_all()
        self.patch_frontend()             # 确保前端已注入心跳脚本 (dsh 升级重装后自动补齐)
        self.patch_frontend_uuid()        # 确保 crypto.randomUUID polyfill 已注入 (局域网 http 用)
        self.patch_web_startup()          # 确保 startup.js 已补丁 (dsh 升级重装后自动补齐, 局域网绑定用)
        self.patch_lan_trust()            # 确保 resolveLanTrust 已补丁 (受信任主机精确语义)
        # 确保 /api 通道在局域网模式下可用 (pickDirectory 等特权 API 不再 403);
        # 失败时给出醒目提示, 避免"局域网模式下静默 403" (2026-08-17, 避坑 #56)。
        lan_api_patched = self.patch_lan_api_trust()
        if not lan_api_patched:
            self.log("[警告] client-connection 局域网补丁未生效: 局域网模式 /api 可能报 403 "
                     "(本机模式不受影响); 可重启服务重试")

        # 局域网模式下为 Web 端口自动放行防火墙 (按端口放行, 任意电脑绿色版可用, 幂等)
        if self.config.get("dsh_host", "127.0.0.1") == "0.0.0.0":
            try:
                web_port = int(self.config.get("dsh_port", 3080))
            except (ValueError, TypeError):
                web_port = 3080
            self.ensure_firewall_port(web_port)

        command = self.build_server_command()
        self.log("启动命令: %s" % " ".join(command))
        os.makedirs(RUNTIME_DIR, exist_ok=True)

        # Windows 下隐藏控制台窗口, 让服务在后台静默运行
        creation_flags = 0
        if sys.platform == "win32":
            creation_flags = subprocess.CREATE_NO_WINDOW

        log_handle = open(LOG_FILE, "a", encoding="utf-8")
        log_handle.write("\n===== DSH Server Start: %s =====\n"
                         % time.strftime("%Y-%m-%d %H:%M:%S"))
        log_handle.flush()

        self.server_process = subprocess.Popen(
            command,
            cwd=DSH_DIR,
            env=self.build_env(),
            stdin=subprocess.PIPE,       # 保持管道打开, 避免 dsh 读到 stdin EOF 后静默退出
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            creationflags=creation_flags,
        )
        # 保持 stdin 管道引用: 若被回收关闭, dsh 会因读到 EOF 而退出
        self.server_stdin = self.server_process.stdin
        self._stopping_server = False
        # 后台线程: 监听服务子进程, 意外退出时记录日志 (方便排查静默崩溃)
        threading.Thread(target=self.watch_server, daemon=True).start()

        # 记录进程号, 供 --stop 使用
        try:
            with open(PID_FILE, "w", encoding="utf-8") as file_handle:
                file_handle.write(str(self.server_process.pid))
        except Exception as error:
            self.log("写入进程号失败: %s" % error)

        self.log("服务进程已启动 (PID: %s), 正在等待就绪 ..." % self.server_process.pid)

        # 后台线程: 轮询端口直到就绪, 然后自动打开浏览器
        threading.Thread(target=self.wait_and_open, args=(open_browser,), daemon=True).start()
        return True

    def watch_server(self):
        """监听服务子进程: 主动停止时静默, 意外退出时记录日志帮助排查"""
        process = self.server_process
        if process is None:
            return
        process.wait()
        if not self._stopping_server:
            self.log("服务进程已退出 (退出码: %s); 若并非主动停止, 请查看日志 %s"
                     % (process.returncode, LOG_FILE))

    def wait_and_open(self, open_browser):
        """轮询检测服务端口是否就绪, 就绪后可选打开浏览器"""
        port = int(self.config.get("dsh_port", 3080))
        url = "http://127.0.0.1:%d" % port
        if self.wait_ready(port):
            self.log("服务已就绪: %s" % url)
            # 局域网模式: 提示可被其他电脑远程访问的地址
            if self.config.get("dsh_host", "127.0.0.1") == "0.0.0.0":
                for lan_ip in self.lan_addresses():
                    self.log("局域网访问地址: http://%s:%d (其他电脑浏览器打开)" % (lan_ip, port))
            if open_browser:
                self.open_ui(force=False)   # 按默认打开方式(桌面窗口/网页窗口)自动打开; 已打开则内部跳过

    def wait_ready(self, port):
        """阻塞等待服务端口就绪, 成功返回 True, 超时返回 False"""
        deadline = time.time() + SERVER_READY_TIMEOUT
        while time.time() < deadline:
            if self.is_server_running() is False:
                self.log("服务进程已退出, 请查看日志 %s" % LOG_FILE)
                return False
            if self.port_open(port):
                return True
            time.sleep(1)
        self.log("等待服务就绪超时, 请手动检查日志 %s" % LOG_FILE)
        return False

    @staticmethod
    def port_open(port):
        """检测本地端口是否已被监听"""
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except OSError:
            return False

    @staticmethod
    def _find_port_owner(port):
        """查询监听指定端口的进程信息, 返回 [(pid, name, command_line), ...]。
        仅 Windows 支持 (借助 PowerShell Get-NetTCPConnection + CIM 查命令行);
        其它平台或查询失败返回空列表, 保证安全兜底。"""
        if sys.platform != "win32":
            return []
        script = (
            "$ErrorActionPreference='SilentlyContinue';"
            "Get-NetTCPConnection -LocalPort %d -State Listen | ForEach-Object {"
            "  $ownPid = $_.OwningProcess;"
            "  $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$ownPid\";"
            "  if ($p) { Write-Output (\"$ownPid`t$($p.Name)`t$($p.CommandLine)\") }"
            "}"
        ) % int(port)
        try:
            result = subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                text=True, timeout=8)
        except Exception:
            return []
        owners = []
        for line in result.stdout.splitlines():
            parts = line.split("\t")
            if len(parts) >= 2 and parts[0].strip().isdigit():
                owners.append((int(parts[0]),
                               parts[1].strip(),
                               parts[2] if len(parts) > 2 else ""))
        return owners

    @staticmethod
    def _wait_port_free(port, timeout=5):
        """等待端口释放 (taskkill /F 后端口一般立即释放, 此处做短暂兜底)"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if not Launcher.port_open(port):
                return True
            time.sleep(0.3)
        return False

    def _cleanup_orphan_dsh(self, port):
        """启动前调用: 端口若被孤儿 dsh 进程占用 (非本启动器记录的进程), 确认后清理,
        避免新进程 EADDRINUSE 启动失败 (2026-08-18, 需求 #46)。
        只清理明确的 dsh 服务进程 (node + bin.js + web + --port), 不误杀其它程序。
        返回清理掉的进程数。"""
        if sys.platform != "win32":
            return 0
        if not self.port_open(port):
            return 0
        cleaned = 0
        for pid, name, command_line in self._find_port_owner(port):
            is_dsh = ("node" in name.lower()
                      and "bin.js" in command_line
                      and "web" in command_line
                      and "--port" in command_line)
            if not is_dsh:
                continue
            self.log("检测到残留 dsh 进程占用端口 %d (PID: %s), 正在清理 ..." % (port, pid))
            try:
                subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               timeout=8)
                self.log("已清理残留 dsh 进程 (PID: %s)" % pid)
                cleaned += 1
            except Exception as error:
                self.log("清理残留 dsh 进程失败 (PID: %s): %s" % (pid, error))
        if cleaned > 0:
            self._wait_port_free(port)
        return cleaned

    def is_server_running(self):
        """判断服务是否仍在运行 (依据进程对象或 PID 文件)"""
        if self.server_process is not None:
            if self.server_process.poll() is None:
                return True
        if os.path.exists(PID_FILE):
            try:
                with open(PID_FILE, "r", encoding="utf-8") as file_handle:
                    pid = int(file_handle.read().strip())
                if pid > 0:
                    # 进程存在则视为运行中
                    if sys.platform == "win32":
                        result = subprocess.run(
                            ["tasklist", "/FI", "PID eq %d" % pid],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                            text=True, timeout=5)   # 加超时, 避免刷新状态时界面卡住
                        return str(pid) in result.stdout
                    else:
                        if os.path.isdir("/proc/%d" % pid):
                            return True
            except Exception:
                pass
        return False

    def stop_server(self):
        """停止服务进程 (优先优雅退出, 再强制结束)"""
        stopped = False
        self._stopping_server = True    # 标记主动停止, 监听线程不再提示"意外退出"
        if self.server_process is not None and self.server_process.poll() is None:
            self.log("正在停止服务进程 (PID: %s) ..." % self.server_process.pid)
            self.server_process.terminate()
            try:
                self.server_process.wait(timeout=8)
                stopped = True
            except subprocess.TimeoutExpired:
                self.log("进程未响应, 强制结束 ...")
                self.server_process.kill()
                stopped = True
            self.server_process = None

        # 若本进程对象不存在, 则按 PID 文件处理
        if not stopped and os.path.exists(PID_FILE):
            try:
                with open(PID_FILE, "r", encoding="utf-8") as file_handle:
                    pid = int(file_handle.read().strip())
                if sys.platform == "win32":
                    subprocess.run(["taskkill", "/F", "/PID", str(pid)],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                else:
                    os.kill(pid, 15)
                stopped = True
            except Exception as error:
                self.log("按 PID 停止失败: %s" % error)

        if os.path.exists(PID_FILE):
            try:
                os.remove(PID_FILE)
            except OSError:
                pass

        if stopped:
            self.log("服务已停止")
        else:
            self.log("没有正在运行的服务")
        return stopped

    def _delete_session_log_dir(self, session_id):
        """删除一个会话的日志目录 (只在 sessions 根目录下按 id 查找, 防路径穿越)。
        找到并删除返回 True, 未找到返回 False。"""
        sessions_root = os.path.join(DSH_HOME_DIR, "sessions")
        if not os.path.isdir(sessions_root):
            return False
        for entry in os.listdir(sessions_root):
            workspace_dir = os.path.join(sessions_root, entry)
            if not os.path.isdir(workspace_dir):
                continue
            candidate = os.path.join(workspace_dir, session_id)
            if os.path.isdir(candidate):
                shutil.rmtree(candidate)
                return True
        return False

    def _atomic_write_json(self, path, data):
        """原子写回 JSON (同目录临时文件 + os.replace)。"""
        temp_path = path + ".tmp"
        with open(temp_path, "w", encoding="utf-8") as file_handle:
            json.dump(data, file_handle, ensure_ascii=False, indent=2)
        os.replace(temp_path, path)

    def _remove_session_from_registries(self, session_id):
        """从 storages/workspace.json 与 session_projcache.json 中移除一个会话。
        返回 (workspace_changed, projcache_changed); 失败抛异常由调用方处理。"""
        workspace_storage = os.path.join(DSH_HOME_DIR, "storages", "workspace.json")
        workspace_changed = False
        if os.path.isfile(workspace_storage):
            with open(workspace_storage, "r", encoding="utf-8") as file_handle:
                data = json.load(file_handle)
            tables = data.get("tables") if isinstance(data, dict) else None
            workspaces = tables.get("workspaces") if isinstance(tables, dict) else None
            if isinstance(workspaces, dict):
                for record in workspaces.values():
                    if not isinstance(record, dict):
                        continue
                    session_ids = record.get("sessionIds")
                    if isinstance(session_ids, list) and session_id in session_ids:
                        record["sessionIds"] = [sid for sid in session_ids if sid != session_id]
                        workspace_changed = True
            global_state = data.get("global") if isinstance(data, dict) else None
            archived = global_state.get("archivedSessionIds") if isinstance(global_state, dict) else None
            if isinstance(archived, list) and session_id in archived:
                global_state["archivedSessionIds"] = [sid for sid in archived if sid != session_id]
                workspace_changed = True
            if workspace_changed:
                self._atomic_write_json(workspace_storage, data)

        projcache_storage = os.path.join(DSH_HOME_DIR, "storages", "session_projcache.json")
        projcache_changed = False
        if os.path.isfile(projcache_storage):
            with open(projcache_storage, "r", encoding="utf-8") as file_handle:
                data = json.load(file_handle)
            tables = data.get("tables") if isinstance(data, dict) else None
            sessions = tables.get("sessions") if isinstance(tables, dict) else None
            if isinstance(sessions, dict) and session_id in sessions:
                del sessions[session_id]
                projcache_changed = True
            if projcache_changed:
                self._atomic_write_json(projcache_storage, data)
        return workspace_changed, projcache_changed

    def purge_session(self, session_id):
        """永久删除一个会话 (需服务已停止)。

        dsh 本身没有内置的"永久删除会话"功能: 归档(archive)只是把会话隐藏,
        日志文件与注册表条目全部保留。本方法在服务停止后彻底删除:
          1) 删除 sessions/<工作区编码>/<session-id>/ 会话日志目录
          2) 从 storages/workspace.json 的 sessionIds / archivedSessionIds 中移除
          3) 从 storages/session_projcache.json 中移除该会话的缓存条目
        任何一步失败都会打印出来, 不静默吞掉。
        """
        # 1) 删除会话日志目录
        if self._delete_session_log_dir(session_id):
            self.log("已删除会话日志: %s" % session_id)
        else:
            self.log("未找到该会话的日志目录: %s" % session_id)

        # 2) + 3) 清理注册表与投影缓存
        try:
            self._remove_session_from_registries(session_id)
            self.log("已从注册表/缓存移除: %s" % session_id)
        except Exception as error:
            self.log("清理注册表/缓存失败: %s" % error)
            return False

        self.log("会话已永久删除: %s" % session_id)
        return True

    def purge_archived_sessions(self):
        """永久删除所有已归档(隐藏)的会话 (需服务已停止)。

        读取 storages/workspace.json 的 archivedSessionIds, 逐个删除日志目录,
        并统一从 workspace.json 的 sessionIds/archivedSessionIds 与
        session_projcache.json 中移除。返回 (删除数量, 跳过数量)。
        """
        workspace_storage = os.path.join(DSH_HOME_DIR, "storages", "workspace.json")
        if not os.path.isfile(workspace_storage):
            self.log("未找到工作区注册表, 没有可清理的归档会话")
            return 0, 0
        with open(workspace_storage, "r", encoding="utf-8") as file_handle:
            data = json.load(file_handle)
        global_state = data.get("global") if isinstance(data, dict) else None
        archived = []
        if isinstance(global_state, dict):
            archived = [sid for sid in (global_state.get("archivedSessionIds") or [])
                        if isinstance(sid, str) and sid]
        if not archived:
            self.log("没有已归档的会话")
            return 0, 0

        deleted = 0
        missing = 0
        for session_id in archived:
            if self._delete_session_log_dir(session_id):
                deleted += 1
                self.log("已删除会话日志: %s" % session_id)
            else:
                missing += 1
                self.log("未找到会话日志: %s" % session_id)

        # 统一清理注册表与投影缓存
        try:
            for session_id in archived:
                self._remove_session_from_registries(session_id)
            self.log("已从注册表/缓存移除 %d 个会话" % len(archived))
        except Exception as error:
            self.log("清理注册表/缓存失败: %s" % error)
            raise

        self.log("归档会话清理完成: 删除 %d 个, 未找到日志 %d 个" % (deleted, missing))
        return deleted, missing

    def restore_session(self, session_id):
        """复原(取消归档)一个会话 (需服务已停止)。

        归档(archive)只是把会话 id 放入 workspace.json 的
        global.archivedSessionIds, 会话日志、工作区归属与投影缓存全部保留。
        本方法反向操作: 把该 id 从 archivedSessionIds 中移除并原子写回,
        会话即重新出现在 WebUI 会话列表。若该会话并未归档, 返回 False。
        """
        workspace_storage = os.path.join(DSH_HOME_DIR, "storages", "workspace.json")
        if not os.path.isfile(workspace_storage):
            self.log("未找到工作区注册表, 无法复原会话: %s" % session_id)
            return False
        with open(workspace_storage, "r", encoding="utf-8") as file_handle:
            data = json.load(file_handle)
        global_state = data.get("global") if isinstance(data, dict) else None
        archived = global_state.get("archivedSessionIds") if isinstance(global_state, dict) else None
        if not isinstance(archived, list) or session_id not in archived:
            self.log("会话未在归档列表中, 无需复原: %s" % session_id)
            return False
        global_state["archivedSessionIds"] = [sid for sid in archived if sid != session_id]
        try:
            self._atomic_write_json(workspace_storage, data)
        except Exception as error:
            self.log("复原会话失败(写回注册表): %s: %s" % (session_id, error))
            return False
        self.log("会话已复原(取消归档): %s" % session_id)
        return True

    def list_sessions(self):
        """枚举本地会话列表 (供 GUI 可视化删除)。

        服务停止后读取 workspace.json / session_projcache.json / sessions 目录,
        合并出每条会话的 {id, title, workspace, archived, hasLog}。
        任何文件缺失/损坏都不影响其它来源。
        """
        sessions = {}

        def ensure(sid):
            rec = sessions.get(sid)
            if rec is None:
                rec = {"id": sid, "title": None, "workspace": None,
                       "archived": False, "hasLog": False}
                sessions[sid] = rec
            return rec

        # 1) workspace.json → 工作区归属 + 归档标记
        workspace_storage = os.path.join(DSH_HOME_DIR, "storages", "workspace.json")
        if os.path.isfile(workspace_storage):
            try:
                with open(workspace_storage, "r", encoding="utf-8") as file_handle:
                    data = json.load(file_handle)
                tables = data.get("tables") if isinstance(data, dict) else None
                workspaces = tables.get("workspaces") if isinstance(tables, dict) else None
                global_state = data.get("global") if isinstance(data, dict) else None
                archived = global_state.get("archivedSessionIds") if isinstance(global_state, dict) else None
                if isinstance(workspaces, dict):
                    for record in workspaces.values():
                        if not isinstance(record, dict):
                            continue
                        wpath = record.get("path")
                        for sid in record.get("sessionIds") or []:
                            if isinstance(sid, str) and sid:
                                ensure(sid)["workspace"] = wpath
                for sid in archived or []:
                    if isinstance(sid, str) and sid:
                        ensure(sid)["archived"] = True
            except Exception:
                pass   # 读取失败不阻断

        # 2) session_projcache.json → 标题
        proj_storage = os.path.join(DSH_HOME_DIR, "storages", "session_projcache.json")
        if os.path.isfile(proj_storage):
            try:
                with open(proj_storage, "r", encoding="utf-8") as file_handle:
                    data = json.load(file_handle)
                tables = data.get("tables") if isinstance(data, dict) else None
                rows = tables.get("sessions") if isinstance(tables, dict) else None
                if isinstance(rows, dict):
                    for sid, row in rows.items():
                        if not isinstance(row, dict):
                            continue
                        title_row = (row.get("rows") or {}).get("title") or {}
                        title = title_row.get("val")
                        if isinstance(title, str) and title:
                            ensure(sid)["title"] = title
            except Exception:
                pass

        # 3) sessions 目录 → 补齐孤儿会话 + 日志存在性
        sessions_root = os.path.join(DSH_HOME_DIR, "sessions")
        if os.path.isdir(sessions_root):
            try:
                for entry in os.listdir(sessions_root):
                    workspace_dir = os.path.join(sessions_root, entry)
                    if not os.path.isdir(workspace_dir):
                        continue
                    for sid in os.listdir(workspace_dir):
                        if os.path.isdir(os.path.join(workspace_dir, sid)):
                            ensure(sid)["hasLog"] = True
            except Exception:
                pass

        result = list(sessions.values())
        result.sort(key=lambda s: ((s["workspace"] or "").lower(),
                                   0 if s["archived"] else 1, s["id"]))
        return result

    def _read_desktop_shell_pid(self):
        """读取桌面壳记录的 PID (单实例身份); 无记录/非法返回 0。"""
        try:
            with open(DESKTOP_SHELL_PID_FILE, "r", encoding="utf-8") as file_handle:
                return int(file_handle.read().strip())
        except (OSError, ValueError):
            return 0

    def _write_desktop_shell_pid(self, pid):
        """把刚启动的桌面壳进程 PID 落盘 (供后续 _desktop_shell_alive 判重)。写失败仅失去快速判重, 不致命。"""
        try:
            os.makedirs(RUNTIME_DIR, exist_ok=True)
            with open(DESKTOP_SHELL_PID_FILE, "w", encoding="utf-8") as file_handle:
                file_handle.write(str(pid))
        except OSError:
            pass

    def _desktop_shell_alive(self):
        """桌面壳是否"单实例在线": 读 PID 文件 + 用 Win32 校验该进程是否存活。

        桌面版是固定一个程序, 用"进程身份"判比 WebUI 心跳更可靠 (心跳需要的
        前端 index.html 可能没注入 / 网页版才需要)。非 Windows 或不存活一律判假。
        """
        pid = self._read_desktop_shell_pid()
        if pid <= 0 or sys.platform != "win32":
            return False
        try:
            kernel32 = ctypes.windll.kernel32
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
            kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE,
                                                    ctypes.POINTER(ctypes.c_uint32)]
            kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
            process_handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,
                                                  False, pid)
            if not process_handle:
                return False
            try:
                exit_code = ctypes.c_uint32(0)
                if not kernel32.GetExitCodeProcess(process_handle,
                                                   ctypes.byref(exit_code)):
                    return False
                return exit_code.value == STILL_ACTIVE
            finally:
                kernel32.CloseHandle(process_handle)
        except Exception:
            return False

    def _focus_desktop_window(self):
        """尽力让已存在的桌面壳窗口回到前台 (找不到窗口则返回 False, 由调用方决定是否重建)。

        桌面版是固定单实例, 手动再点「桌面窗口」时在线则聚焦, 不重复新建。
        Returns:
            bool: True 表示找到并尝试激活了既有窗口。
        """
        if sys.platform != "win32":
            return False
        try:
            user32 = ctypes.windll.user32
            user32.FindWindowW.restype = wintypes.HWND
            user32.FindWindowW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
            user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
            user32.SetForegroundWindow.argtypes = [wintypes.HWND]
            window_handle = user32.FindWindowW(None, DESKTOP_WINDOW_TITLE)
            if not window_handle:
                return False
            user32.ShowWindow(window_handle, 9)   # SW_RESTORE: 最小化/隐藏则还原
            user32.SetForegroundWindow(window_handle)   # 尽力置前, 失败也无碍
            return True
        except Exception:
            return False

    def _find_pythonw(self):
        """定位便携版 pythonw.exe (GUI 子系统, 无控制台窗口); 找不到时回退系统 pythonw。

        绿色版优先取 runtime/python 下的 pythonw.exe, 保证桌面壳子进程不附属于任何
        cmd 控制台, 从根上避免启动时闪现一下黑色终端窗口。
        Returns:
            str: pythonw 可执行文件绝对路径; 找不到返回 None。
        """
        candidates = [
            os.path.join(BASE_DIR, "runtime", "python", "python", "pythonw.exe"),
            os.path.join(BASE_DIR, "runtime", "python", "pythonw.exe"),
        ]
        for candidate in candidates:
            if os.path.isfile(candidate):
                return candidate
        return sys.executable if sys.executable.lower().endswith("pythonw.exe") else None

    def launch_desktop_shell(self):
        """启动绿色版内嵌 WebView2 的独立桌面窗口 (完全脱离浏览器)。

        由绿色版根目录 desktop-shell.py 承担: 自检/自装 pywebview(WebView2 后端),
        再以 pythonw.exe(GUI 子系统)无控制台方式运行拎起独立桌面窗口。
        这里直接用 subprocess 直启 pythonw + desktop-shell.py, 不经过 .bat,
        从而不闪现任何 cmd 黑窗 (desktop-shell.bat 独立入口已于 2026-08-27 移除,
        桌面窗口统一从启动器 GUI「桌面窗口」按钮进入)。"""
        shell_script = os.path.join(BASE_DIR, "desktop-shell.py")
        pythonw_exe = self._find_pythonw()
        url = "http://127.0.0.1:%d" % int(self.config.get("dsh_port", 3080))
        # 启动前先在 GUI 层确保桌面版依赖 (pywebview) 就绪: 缺失则带进度自动安装,
        # 不再静默由子进程后台补装; 装不上/无便携 python 时明确提示并回退浏览器。
        if not self.prepare_desktop_deps():
            self.log("桌面版依赖未就绪, 改用系统浏览器打开界面: %s" % url)
            webbrowser.open(url)
            return
        if pythonw_exe and os.path.isfile(shell_script):
            creation_flags = 0
            if sys.platform == "win32":
                creation_flags = subprocess.CREATE_NO_WINDOW
            try:
                shell_process = subprocess.Popen(
                    [pythonw_exe, shell_script],
                    cwd=BASE_DIR,
                    creationflags=creation_flags,
                )
                # 立即把 PID 落盘: 桌面版是固定单实例, launcher 据此判重(而非心跳)。
                self._write_desktop_shell_pid(shell_process.pid)
                self.log("正在打开独立桌面窗口 (WebView2 桌面版, 无控制台) ...")
                return
            except Exception as error:
                self.log("启动桌面窗口失败: %s" % error)
        # 兜底: pythonw 或桌面壳脚本缺失/启动失败时直接用系统浏览器打开
        self.log("未找到 pythonw 或 desktop-shell.py, 改用系统浏览器打开: %s" % url)
        webbrowser.open(url)

    def _ui_open_state(self, write_method=None):
        """持久化"当前正在使用的界面方式", 返回最近记录的方式; 传 write_method 时先落盘。

        说明: 心跳检测(ui_is_open)只能判断"有一个界面在线", 区分不了那个界面是
        桌面窗口还是浏览器。于是把"上一次以哪种方式打开"写进 runtime 下的临时文件,
        配合心跳即可断定当前在线的是桌面窗还是网页窗——即使启动器重启过也能对上。
        Returns:
            "desktop" / "browser" / None(从未记录)。
        """
        state_file = os.path.join(RUNTIME_DIR, "ui_open_method.txt")
        if write_method is not None:
            try:
                os.makedirs(RUNTIME_DIR, exist_ok=True)
                with open(state_file, "w", encoding="utf-8") as file_handle:
                    file_handle.write(write_method)
            except OSError:
                pass
            return write_method
        try:
            with open(state_file, "r", encoding="utf-8") as file_handle:
                value = file_handle.read().strip()
            return value if value in ("desktop", "browser") else None
        except OSError:
            return None

    def open_ui(self, force=False, method=None):
        """打开 dsh 界面。

        - 打开方式 = method(手动指定) 或 config.open_method(默认)。
        - **手动打开(force=True)不排重**：桌面版在线则聚焦已有窗口、不在线则新建;
          网页版直接 webbrowser.open(同地址会自动复用/聚焦已有标签)。反复点按钮不会
          再被"已存在"挡住。
        - **自动打开(force=False)才排重**：桌面版用"进程 PID 身份"判(固定单实例,
          不用心跳)；网页版用心跳 + 记录的上次打开方式判，已打开则跳过不重复新建。
        - 只认一种打开方式，绝不顺带开另一种 —— 根治"选桌面却还弹浏览器 / 双开"。
        """
        self._ensure_ui_beacon_server()
        open_method = method or self.config.get("open_method", "desktop")
        url = "http://127.0.0.1:%d" % int(self.config.get("dsh_port", 3080))

        if open_method == "desktop":
            # 桌面版是固定单实例程序: 用进程PID身份判在线, 不用/不依赖 WebUI 心跳。
            if self._desktop_shell_alive():
                if force:
                    # 手动点「桌面窗口」: 已有则聚焦, 让用户"点了就看见", 不重复新建。
                    if self._focus_desktop_window():
                        self.log("独立桌面窗口已在运行, 已聚焦到该窗口")
                        return
                    # 找不到窗口(残留PID) → 按无窗口重建
                    self.log("桌面壳进程在但窗口丢失, 重新打开桌面窗口")
                else:
                    # 自动打开: 已在线则排重跳过, 不重复新建。
                    self.log("独立桌面窗口已在运行, 不再重复新建 (自动打开)")
                    return
            self._ui_open_state("desktop")
            self.launch_desktop_shell()
            return

        # ---- 网页版(浏览器): 同地址 webbrowser.open 本身就会复用/聚焦已开标签 ----
        self._ui_open_state("browser")
        if not force and self.ui_is_open() and self._ui_open_state() == "browser":
            self.log("WebUI 网页窗口已在运行, 已切换到该页面: %s" % url)
            webbrowser.open(url)
            return
        self.log("正在打开界面(网页窗口): %s" % url)
        webbrowser.open(url)

    def on_exit(self):
        """程序退出时的清理工作 (停止服务)"""
        self.stop_server()


# ---------------------------------------------------------------------------
# Windows 系统托盘图标 (用 ctypes 调用 Win32 API, 零额外依赖)
# ---------------------------------------------------------------------------
class SysTrayIcon:
    """Windows 系统托盘图标: 启动即常驻, 不随最小化/恢复而消失 (2026-08-16)"""

    # Windows 常量
    NIM_ADD = 0x00000000
    NIM_DELETE = 0x00000002
    NIM_SETVERSION = 0x00000004
    NIF_MESSAGE = 0x00000001
    NIF_ICON = 0x00000002
    NIF_TIP = 0x00000004
    NIF_SHOWTIP = 0x40000000
    NOTIFYICON_VERSION_4 = 0x00000004
    WM_USER = 0x0400
    WM_TRAY_CALLBACK = 0x0400 + 100      # 自定义回调消息 ID
    WM_SYSCOMMAND = 0x0112
    SC_MINIMIZE = 0xF020
    ICON_BIG = 1
    GCL_HICON = -14
    IDI_APPLICATION = 32512

    # NOTIFYICONDATAW 结构 (Windows Vista+ 版本)
    class _NOTIFYICONDATAW(ctypes.Structure):
        _fields_ = [
            ("cbSize", wintypes.DWORD),
            ("hWnd", wintypes.HWND),
            ("uID", wintypes.UINT),
            ("uFlags", wintypes.UINT),
            ("uCallbackMessage", wintypes.UINT),
            ("hIcon", wintypes.HICON),
            ("szTip", wintypes.WCHAR * 128),
            ("dwState", wintypes.DWORD),
            ("dwStateMask", wintypes.DWORD),
            ("szInfo", wintypes.WCHAR * 256),
            ("uVersion", wintypes.UINT),
            ("szInfoTitle", wintypes.WCHAR * 64),
            ("dwInfoFlags", wintypes.DWORD),
            ("guidItem", ctypes.c_byte * 16),
            ("hBalloonIcon", wintypes.HICON),
        ]

    def __init__(self, tk_root, on_click_restore=None, on_minimize=None, tooltip="DSH 启动器"):
        self.root = tk_root
        self.on_click_restore = on_click_restore
        self.on_minimize = on_minimize
        self.tooltip = tooltip
        self._icon_added = False
        self._old_wndproc = None
        self._wndproc_new = None
        self._nid = None
        # 标志位 (2026-08-16): WndProc 回调里只允许做纯 Python 赋值,
        # 绝不能直接调用 Tk 的 after/withdraw 等 — 那会让 Tcl 在消息派发中途
        # 被重入, 触发 "PyEval_RestoreThread: GIL is released" 崩溃。
        # 由 run_gui 里的 poll_tray() 定时轮询这两个标志, 再在正常的
        # Tk 事件上下文里执行最小化/恢复。
        self._minimize_pending = False
        self._restore_pending = False
        # 关键避坑 (2026-08-16): winfo_id() 返回的是 Tk 内部子窗口 HWND,
        # 不是真实顶层窗口。WM_SYSCOMMAND / 托盘回调消息都发到顶层窗口,
        # 若把钩子挂在子窗口上, 最小化消息永远收不到 (窗口会正常最小化到任务栏)。
        # 必须用 GetAncestor(GA_ROOT) 拿到真实顶层窗口 HWND。
        user32 = ctypes.windll.user32
        # GetAncestor 必须显式设置签名: 否则默认按 32 位 c_int 返回,
        # 64 位系统下句柄被截断, 拿到的仍是错误窗口。
        user32.GetAncestor.restype = ctypes.c_ssize_t
        user32.GetAncestor.argtypes = [wintypes.HWND, ctypes.c_int]
        # 关键避坑 2 (2026-08-16): 构造时主窗口可能还没被真正映射 (realize),
        # 此时 Tk 只创建了内部子窗口 (TkChild), 真实顶层窗口 (TkTopLevel)
        # 尚未创建。若直接 GetAncestor, 拿到的仍是子窗口句柄, 钩子挂错窗口,
        # WM_SYSCOMMAND 收不到 → 最小化照样进任务栏。
        # 必须先 update_idletasks() 强制 Tk 完成窗口创建与布局。
        tk_root.update_idletasks()
        inner_hwnd = int(tk_root.winfo_id())
        top_hwnd = user32.GetAncestor(inner_hwnd, 2)   # GA_ROOT = 2
        if not top_hwnd:
            top_hwnd = inner_hwnd   # 极端情况下取不到父窗口, 退回子窗口
        self.hwnd = wintypes.HWND(top_hwnd)
        # 初始化时即挂钩窗口过程: 确保第一次点最小化就被拦截到托盘
        # (若等到 add() 才挂钩, 第一次最小化发生在托盘图标出现之前, 会漏拦截)
        self._hook_wndproc()

    def _get_icon(self):
        """获取窗口图标句柄, 失败则返回默认应用图标
        (2026-08-16): 优先从自定义 DSH_Launcher.ico 加载, 托盘/任务栏才能显示专属图标)"""
        user32 = ctypes.windll.user32
        # 设置函数签名, 避免 64 位系统下返回的句柄/指针被 ctypes 截断
        user32.SendMessageW.restype = ctypes.c_ssize_t
        user32.SendMessageW.argtypes = [
            wintypes.HWND, wintypes.UINT,
            wintypes.WPARAM, wintypes.LPARAM,
        ]
        user32.GetClassLongPtrW.restype = ctypes.c_ssize_t
        user32.GetClassLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]
        user32.LoadIconW.restype = wintypes.HICON
        user32.LoadIconW.argtypes = [wintypes.HINSTANCE, ctypes.c_int]

        # 优先: 从自定义 .ico 文件加载 (LoadImageW + LR_LOADFROMFILE)
        icon_path = get_icon_path()
        if icon_path:
            try:
                user32.LoadImageW.restype = wintypes.HICON
                user32.LoadImageW.argtypes = [
                    wintypes.HINSTANCE, wintypes.LPCWSTR,
                    ctypes.c_uint, ctypes.c_int, ctypes.c_int, ctypes.c_uint,
                ]
                # LR_LOADFROMFILE=0x10, LR_DEFAULTSIZE=0x40 (按系统当前大小加载)
                hicon = user32.LoadImageW(
                    None, icon_path, 1, 0, 0, 0x10 | 0x40)
                if hicon:
                    return hicon
            except Exception:
                pass   # 自定义图标加载失败则走下面默认逻辑

        hicon = user32.SendMessageW(self.hwnd, 0x007F, self.ICON_BIG, 0)   # WM_GETICON
        if hicon:
            return hicon
        hicon = user32.GetClassLongPtrW(self.hwnd, self.GCL_HICON)
        if hicon:
            return hicon
        return user32.LoadIconW(None, self.IDI_APPLICATION)

    def add(self):
        """添加托盘图标 (窗口过程已在 __init__ 挂钩, 此处幂等补挂一次)"""
        if self._icon_added:
            return True
        shell32 = ctypes.windll.shell32
        # 设置函数签名, 避免 64 位下结构指针被截断; 返回 BOOL(整型)
        shell32.Shell_NotifyIconW.restype = ctypes.c_int
        shell32.Shell_NotifyIconW.argtypes = [ctypes.c_uint, ctypes.c_void_p]
        hicon = self._get_icon()
        nid = self._NOTIFYICONDATAW()
        nid.cbSize = ctypes.sizeof(self._NOTIFYICONDATAW)
        nid.hWnd = self.hwnd
        nid.uID = 1
        nid.uFlags = self.NIF_MESSAGE | self.NIF_ICON | self.NIF_TIP
        nid.uCallbackMessage = self.WM_TRAY_CALLBACK
        nid.hIcon = hicon
        nid.szTip = self.tooltip[:127]
        self._hook_wndproc()
        result = shell32.Shell_NotifyIconW(self.NIM_ADD, ctypes.byref(nid))
        if not result:
            # 添加失败则还原窗口过程, 不让窗口停留在被挂钩状态
            self._unhook_wndproc()
            self._icon_added = False
            return False
        self._nid = nid
        self._icon_added = True
        return True

    def remove(self):
        """移除托盘图标 (保留窗口过程挂钩, 恢复窗口后再次最小化仍能进托盘)"""
        if not self._icon_added:
            return
        if self._nid is not None:
            shell32 = ctypes.windll.shell32
            shell32.Shell_NotifyIconW.restype = ctypes.c_int
            shell32.Shell_NotifyIconW.argtypes = [ctypes.c_uint, ctypes.c_void_p]
            shell32.Shell_NotifyIconW(self.NIM_DELETE, ctypes.byref(self._nid))
            self._nid = None
        self._icon_added = False

    def poll(self):
        """由 run_gui 的 poll_tray_loop() 定时轮询 (2026-08-16):
        处理 WndProc 里置位的待办标志, 在正常的 Tk 事件上下文里执行
        最小化/恢复 — 避免在 WndProc 回调里直接重入 Tcl 导致 GIL 崩溃。
        """
        if self._minimize_pending:
            self._minimize_pending = False
            if self.on_minimize:
                self.on_minimize()
        if self._restore_pending:
            self._restore_pending = False
            if self.on_click_restore:
                self.on_click_restore()

    def dispose(self):
        """退出前调用: 移除托盘图标 + 恢复原始窗口过程, 避免窗口销毁后回调悬空"""
        self.remove()
        self._unhook_wndproc()

    # -- 窗口过程子类化, 拦截托盘回调 + 最小化消息 --
    def _hook_wndproc(self):
        if self._old_wndproc is not None:
            return
        # WndProc 回调函数类型: LRESULT CALLBACK(HWND, UINT, WPARAM, LPARAM)
        WNDPROC = ctypes.WINFUNCTYPE(
            ctypes.c_ssize_t,             # LRESULT = LONG_PTR
            wintypes.HWND,                # hWnd
            wintypes.UINT,                # uMsg
            wintypes.WPARAM,              # wParam
            wintypes.LPARAM,              # lParam
        )
        def new_wndproc(hwnd, msg, wparam, lparam):
            # 整个回调用 try/except 包裹 (2026-08-16):
            # WndProc 回调里的 Python 异常会被 ctypes 吞掉并返回 0。
            # 若此时消息是 SC_MINIMIZE, 就会出现"最小化被吃掉但没触发最小化逻辑"
            # 的怪象 (窗口不隐藏、无托盘图标, 表现即"还在任务栏")。
            # 因此任何异常都必须放行给旧窗口过程, 保证窗口行为始终正常。
            try:
                if msg == self.WM_SYSCOMMAND and (wparam & 0xFFF0) == self.SC_MINIMIZE:
                    # 拦截最小化按钮 → 只置标志位, 不在此处调用任何 Tk 方法
                    # (WndProc 里重入 Tcl 会崩溃, 见 __init__ 里的注释)。
                    # poll_tray() 轮询到标志后, 再在正常事件上下文里执行隐藏。
                    self._minimize_pending = True
                    return 0
                # 拦截托盘图标回调消息
                if msg == self.WM_TRAY_CALLBACK:
                    if lparam == 0x0202:        # WM_LBUTTONUP → 左键单击恢复
                        self._restore_pending = True
                    elif lparam == 0x0205:      # WM_RBUTTONUP → 右键单击恢复
                        self._restore_pending = True
                    return 0
            except Exception:
                pass   # 回调异常一律放行给旧窗口过程, 不吞消息
            return ctypes.windll.user32.CallWindowProcW(
                self._old_wndproc, hwnd, msg, wparam, lparam)
        self._wndproc_new = WNDPROC(new_wndproc)
        # 设置签名, 避免 64 位下 SetWindowLongPtrW / CallWindowProcW 指针被截断
        user32 = ctypes.windll.user32
        user32.SetWindowLongPtrW.restype = ctypes.c_ssize_t
        user32.SetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t]
        user32.CallWindowProcW.restype = ctypes.c_ssize_t
        user32.CallWindowProcW.argtypes = [
            ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT,
            wintypes.WPARAM, wintypes.LPARAM,
        ]
        # GWL_WNDPROC = -4, 替换为自定义窗口过程, 返回旧的窗口过程指针
        # 注意: SetWindowLongPtrW 需要整数指针, 不能直接传 WINFUNCTYPE 回调对象,
        # 需用 ctypes.cast 取其地址后再传。
        wndproc_address = ctypes.cast(self._wndproc_new, ctypes.c_void_p).value
        self._old_wndproc = user32.SetWindowLongPtrW(self.hwnd, -4, wndproc_address)

    def _unhook_wndproc(self):
        if self._old_wndproc is None:
            return
        user32 = ctypes.windll.user32
        user32.SetWindowLongPtrW.restype = ctypes.c_ssize_t
        user32.SetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_ssize_t]
        user32.SetWindowLongPtrW(self.hwnd, -4, self._old_wndproc)
        self._old_wndproc = None
        self._wndproc_new = None

    def __del__(self):
        try:
            self.dispose()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# tkinter 图形界面
# ---------------------------------------------------------------------------
def run_gui():
    """以 tkinter 图形界面方式运行"""
    try:
        import tkinter as tk
        from tkinter import ttk, messagebox, filedialog
    except ImportError:
        print("未找到 tkinter 支持, 请使用官方 python.org 安装的 Python。")
        print("无界面模式下请运行: python launcher.py --start")
        sys.exit(1)

    app = Launcher()
    is_busy = [False]   # 用列表包装, 闭包内可赋值

    # ---------- 单实例检测 (2026-08-16): 已有一个启动器时, 激活旧窗口并退出本实例 ----------
    # 放在创建主窗口之前, 避免重复起服务/重复初始化占用资源
    mutex_handle, is_new_instance = _acquire_single_instance()
    if not is_new_instance:
        # 已有实例在运行: 把旧窗口调到前台 (托盘隐藏态也一并恢复显示)
        if _activate_existing_launcher():
            if mutex_handle:
                ctypes.windll.kernel32.CloseHandle(mutex_handle)
            return   # 激活成功, 本实例直接退出, 不再创建窗口
        # 旧实例可能还在初始化(窗口未创建), 短等待后重试几次
        for _ in range(10):
            time.sleep(0.3)
            if _activate_existing_launcher():
                if mutex_handle:
                    ctypes.windll.kernel32.CloseHandle(mutex_handle)
                return
        # 互斥量存在但找不到窗口: 提示用户后退出
        root_tmp = tk.Tk()
        root_tmp.withdraw()
        messagebox.showwarning(
            "DSH 启动器",
            "启动器已在后台运行, 但找不到其窗口。\n"
            "请查看任务栏或系统托盘; 若存在异常残留进程,\n"
            "可在任务管理器结束 DSH_Launcher.exe 后重新打开。",
            parent=root_tmp)
        root_tmp.destroy()
        return
    # 本实例是第一个: 模块级持有互斥量句柄, 防止 GC 提前释放导致单实例失效
    global _SINGLE_INSTANCE_MUTEX_HANDLE
    _SINGLE_INSTANCE_MUTEX_HANDLE = mutex_handle

    root = tk.Tk()
    root.title(WINDOW_TITLE)
    root.geometry("1160x780")
    root.minsize(1000, 660)

    # ---------- 窗口图标 (2026-08-16): 自定义 DSH 绿色小鲸鱼图标, 缺失时静默降级 ----------
    icon_path = get_icon_path()
    if icon_path:
        try:
            root.iconbitmap(icon_path)
        except Exception:
            pass   # 图标加载失败不影响主功能, 保持系统默认图标

    # ---------- 日志回调 ----------
    def append_log(line):
        """把日志追加到文本框 (跨线程安全)"""
        def do_append():
            log_text.configure(state="normal")
            log_text.insert("end", line + "\n")
            log_text.see("end")
            log_text.configure(state="disabled")
        root.after(0, do_append)
    app.on_log = append_log
    app._ensure_ui_beacon_server()   # 提前启动心跳服务, 使已打开页面的上报能持续被记录

    # ---------- 状态检查函数 ----------
    def check_environment_ready():
        """检查环境是否已就绪 (Node + dsh 已安装)"""
        return (app.find_node_exe() is not None) and app.dsh_installed()

    # 绿色版更新后自动同步一次内置插件 (2026-08-27): 更新流程在退出前写标记
    # (mark_bundled_plugin_sync_pending), 重启后这里检测到标记即后台执行同步,
    # 不阻塞界面; 环境未就绪时无需同步 (插件尚未安装), 直接清除标记。
    def auto_sync_bundled_after_green_update():
        try:
            if check_environment_ready():
                app.run_post_update_bundled_sync()
            else:
                marker = os.path.join(RUNTIME_DIR, "pending_bundled_plugin_check")
                try:
                    if os.path.isfile(marker):
                        os.remove(marker)
                except OSError:
                    pass
        except Exception as error:
            app.log("[警告] 绿色版更新后的内置插件自动同步失败: %s" % error)
    if os.path.isfile(os.path.join(RUNTIME_DIR, "pending_bundled_plugin_check")):
        threading.Thread(target=auto_sync_bundled_after_green_update, daemon=True).start()

    def python_ok():
        """内置便携 Python 是否就绪 (供 start.bat 脚本版使用; 缺失不影响 dsh 服务)"""
        return app.find_python_exe() is not None

    def refresh_status():
        """刷新状态显示 + 按钮状态"""
        server_running = app.is_server_running()
        env_ready = check_environment_ready()

        # 更新状态指示灯 (绿/黄/红/灰)。2026-08-17 新增"内置 Python 缺失"红色态:
        # 此前 Node/dsh 就绪时 detail 里的 "Python: ✓" 是硬编码的, Python 实际没装
        # 也显示勾选, 且在"装环境"时 Python 失败还会被报成"安装完成", 误导用户。
        if server_running:
            status_indicator.itemconfig(dot, fill="#22c55e")   # 绿色
            status_text.set("服务运行中")
            detail_text.set("端口: %s" % app.config.get("dsh_port", 3080))
        elif env_ready:
            if python_ok():
                status_indicator.itemconfig(dot, fill="#f59e0b")   # 黄色
                status_text.set("环境已就绪, 待启动")
                detail_text.set("Node: \u2713  dsh: \u2713  Python: \u2713")
            else:
                status_indicator.itemconfig(dot, fill="#dc2626")   # 红色: 内置 Python 缺失
                status_text.set("环境已就绪, 内置 Python 缺失")
                detail_text.set("内置 Python 未安装, 请点击「安装环境」重装 (不影响 dsh 服务)")
        else:
            status_indicator.itemconfig(dot, fill="#999999")   # 灰色
            status_text.set("环境未准备")
            detail_text.set("点击「安装环境」自动下载 Node 和 dsh 至 runtime/ 目录")

        # 更新按钮状态
        install_btn.config(state="normal" if not server_running and not is_busy[0] else "disabled")
        start_btn.config(state="normal" if env_ready and not server_running and not is_busy[0] else "disabled")
        stop_btn.config(state="normal" if server_running and not is_busy[0] else "disabled")
        update_btn.config(state="normal" if not server_running and not is_busy[0] else "disabled")
        green_update_btn.config(state="normal" if not server_running and not is_busy[0] else "disabled")
        purge_btn.config(state="normal" if not server_running and not is_busy[0] else "disabled")

    # ---------- 状态栏 (顶部) ----------
    status_frame = ttk.Frame(root)
    status_frame.pack(fill="x", padx=14, pady=(12, 0))

    # 状态指示灯 (Canvas 画圆)
    status_indicator = tk.Canvas(status_frame, width=18, height=18, highlightthickness=0)
    status_indicator.pack(side="left", padx=(0, 6))
    dot = status_indicator.create_oval(3, 3, 15, 15, fill="#999999", outline="")

    status_text = tk.StringVar(value="就绪")
    ttk.Label(status_frame, textvariable=status_text,
              font=("Microsoft YaHei", 12, "bold")).pack(side="left")

    detail_text = tk.StringVar(value="")
    ttk.Label(status_frame, textvariable=detail_text,
              font=("Microsoft YaHei", 9), foreground="#666666").pack(side="left", padx=(12, 0))

    # ---------- 关于入口 (右上角) ----------
    def show_about():
        """弹出「关于」对话框: 作者 / 版本 / 本仓库 / 发布主页 / 官方 dsh 引用 (2026-08-16)"""
        about_window = tk.Toplevel(root)
        about_window.title("关于")
        about_window.resizable(False, False)
        about_window.geometry("500x525")
        about_window.transient(root)    # 依附主窗口
        about_window.grab_set()         # 模态, 关闭前不能操作主窗口

        # 主标题
        ttk.Label(about_window, text="DeepSeek Harness 桌面绿色整合版启动器",
                  font=("Microsoft YaHei", 13, "bold")).pack(pady=(18, 4))
        ttk.Label(about_window, text="绿色整合版 · 所有文件与依赖全部本地化",
                  font=("Microsoft YaHei", 9), foreground="#666666").pack(pady=(0, 12))

        # 信息表 (左标签 / 右取值)
        # 链接项: value 用 (url, 显示文本) 元组, 以可点击链接文字呈现, 鼠标手型 + 点击跳转
        info_items = [
            ("作者", "刘俊亨"),
            ("版本号", "v" + GREEN_VERSION),
            ("版本日期", GREEN_VERSION_DATE),
            ("GitHub 仓库", ("https://github.com/LiuJunheng/DeepSeekHarnessGreen",
                              "github.com/LiuJunheng/DeepSeekHarnessGreen")),
            ("Gitee 仓库", ("https://gitee.com/liujunheng/DeepSeekHarnessGreen",
                             "gitee.com/liujunheng/DeepSeekHarnessGreen")),
            ("发布主页", (GREEN_HOME_PAGE_URL,
                           GREEN_HOME_PAGE_URL.replace("https://", ""))),
            ("官方仓库", ("https://github.com/deepseek-ai/deepseek-harness",
                           "github.com/deepseek-ai/deepseek-harness")),
        ]
        info_frame = ttk.Frame(about_window)
        info_frame.pack(fill="x", padx=24, pady=4)
        for row_index, (label, value) in enumerate(info_items):
            ttk.Label(info_frame, text=label, font=("Microsoft YaHei", 9),
                      foreground="#666666").grid(row=row_index, column=0, sticky="w", pady=2, padx=(0, 14))
            if isinstance(value, tuple):
                # 链接项: 蓝色文字 + 手型光标 + 点击跳转
                url, link_text = value
                link_label = ttk.Label(info_frame, text=link_text, font=("Microsoft YaHei", 9),
                                       foreground="#0052d9", cursor="hand2")
                link_label.grid(row=row_index, column=1, sticky="w", pady=2)
                link_label.bind("<Button-1>", lambda _event, u=url: webbrowser.open(u))
            else:
                ttk.Label(info_frame, text=value, font=("Microsoft YaHei", 9)).grid(
                    row=row_index, column=1, sticky="w", pady=2)

        # 绿色便携·本地化说明区块 (2026-08-16 补充: 强调所有文件与依赖全部本地化)
        local_frame = ttk.Frame(about_window)
        local_frame.pack(fill="x", padx=24, pady=(12, 0))
        ttk.Label(local_frame, text="绿色整合 · 本地化特点", font=("Microsoft YaHei", 9, "bold"),
                  foreground="#2f6f2f").pack(anchor="w")
        local_points = [
            "· 双击即用，无需安装、无需手动配置环境",
            "· 运行时依赖全部在程序根目录 runtime/ 下：便携 Node.js / 内置 Python /",
            "  dsh 本体 / npm-pnpm 缓存 / 会话数据 / 临时文件",
            "· 不写用户主目录、不修改系统环境变量、不占用 C 盘默认路径",
            "· 整目录拷贝即用（可拷到其他位置或其他电脑，随拷随用）",
            "· 更新只更新启动器自身，不覆盖 config.json（你的设置）与你的数据",
        ]
        for point in local_points:
            ttk.Label(local_frame, text=point, font=("Microsoft YaHei", 9),
                      foreground="#444444").pack(anchor="w", pady=1)

        # 按钮行 (仅关闭; 跳转统一用上方可点击链接文字)
        ttk.Button(about_window, text="关闭", command=about_window.destroy).pack(pady=(18, 18))

    about_btn = ttk.Button(status_frame, text="关于", command=show_about)
    about_btn.pack(side="right", padx=(10, 0))

    # ---------- 最小化: 任务栏 + 托盘图标都保持常驻 (2026-08-16) ----------
    # 设计说明: 旧逻辑是"最小化 → 隐藏窗口进托盘; 恢复 → 移除托盘图标",
    # 导致最小化后任务栏消失、展开后托盘消失, 用户容易误以为程序退出了。
    # 现在改为: 最小化只把窗口缩到任务栏 (任务栏图标保留), 托盘图标从启动
    # 就常驻不消失; 点任务栏或托盘图标都能恢复窗口, 双入口始终可见。
    def minimize_to_tray():
        """点击最小化按钮时: 最小化到任务栏 (任务栏图标保留), 托盘图标保持常驻
        (不再每次打日志提示, 频繁最小化会重复刷屏; 双入口行为见上方设计说明)"""
        tray_icon.add()   # 幂等: 已常驻则直接返回 True
        root.iconify()    # 最小化到任务栏, 不隐藏窗口 (任务栏图标不消失)

    def restore_from_tray():
        """点击托盘图标时: 恢复显示主窗口 (托盘图标保持常驻, 不删除)"""
        root.deiconify()
        root.lift()
        root.focus_force()

    class _NoTray:
        """系统托盘初始化失败时的安全替身: 所有操作均为空操作, 不干扰窗口行为"""

        def add(self):
            return False

        def remove(self):
            return None

        def poll(self):
            return None

        def dispose(self):
            return None

    try:
        tray_icon = SysTrayIcon(
            tk_root=root,
            on_click_restore=restore_from_tray,
            on_minimize=minimize_to_tray,
            tooltip="DeepSeek Harness 绿色整合版启动器",
        )
        # 启动即添加托盘图标并常驻 (2026-08-16): 无论是否最小化, 托盘图标都显示,
        # 避免"展开后托盘消失"让用户误以为程序退出了。add() 幂等且失败不抛异常,
        # 若启动时添加失败, 最小化时会再次尝试。
        if tray_icon.add():
            append_log("托盘图标已常驻, 关闭窗口时请点 [退出] 或点 X 确认。")
    except Exception as error:
        # 托盘初始化失败 (如窗口环境异常) 时降级: 退回普通最小化, 不拖垮整个 GUI
        tray_icon = _NoTray()
        append_log("系统托盘初始化失败, 已退回普通最小化: %s" % error)

    # ---------- 按钮区 ----------
    button_frame = ttk.Frame(root)
    button_frame.pack(fill="x", padx=14, pady=10)

    def set_busy(busy):
        """设置忙碌状态, 禁用/启用按钮"""
        is_busy[0] = busy
        # 忙碌时所有操作按钮都禁用, 仅刷新状态可用
        for btn in (install_btn, start_btn, stop_btn, update_btn,
                    green_update_btn, purge_btn):
            btn.config(state="disabled" if busy else "normal")
        if not busy:
            refresh_status()   # 恢复后重新刷新按钮状态

    def on_install():
        """安装环境 (Node + dsh, 含内置 Python)"""
        if is_busy[0]:
            return
        sync_gui(silent=True)   # 安装/下载前也按界面当前填入值落盘 (含镜像源), 所见即所得
        set_busy(True)
        status_text.set("正在安装环境 ...")
        status_indicator.itemconfig(dot, fill="#f59e0b")   # 黄色闪烁
        append_log("--- 开始安装环境 ---")
        def worker():
            try:
                python_ok = app.prepare_all()
                def finish(python_ok_value):
                    if python_ok_value:
                        append_log("--- 环境安装完成 ---")
                    else:
                        # 明确提示 Python 失败, 不再假装"全部装好" (2026-08-17)
                        append_log("--- 环境安装完成, 但内置 Python 下载失败 ---")
                        messagebox.showwarning(
                            "内置 Python 下载失败",
                            "Node 和 dsh 已安装成功, 但内置便携 Python 未下载成功。\n\n"
                            "这不影响 dsh 服务 (服务由 Node 运行), 但会让顶栏状态灯显示红色。\n"
                            "你可稍后再次点击「安装环境」重试; 或把 python-build-standalone 的\n"
                            "install_only 压缩包手动解压到 runtime/python 即可。")
                root.after(0, lambda: finish(python_ok))
            except Exception as error:
                root.after(0, lambda: messagebox.showerror("安装失败", str(error)))
            finally:
                root.after(0, lambda: set_busy(False))
        threading.Thread(target=worker, daemon=True).start()

    def on_start():
        """启动服务

        「所见即所得」: 用户可能改了网络/常规设置却没点「保存设置」就直接启动,
        这里启动前把界面当前填入的全部设置同步进 config 并落盘 (静默, 不弹框),
        保证界面上显示的值就是实际绑定的值 (端口/绑定/受信任主机/镜像/打开方式等)。
        """
        if is_busy[0]:
            return
        sync_gui(silent=True)   # 端口非法仅警告不阻断, 沿用旧端口
        set_busy(True)
        status_text.set("正在启动服务 ...")
        status_indicator.itemconfig(dot, fill="#f59e0b")
        def worker():
            try:
                ok = app.start_server(open_browser=bool(app.config.get("auto_open_browser", True)))
                if not ok:
                    root.after(0, lambda: append_log("启动失败, 请查看日志"))
            except Exception as error:
                root.after(0, lambda: messagebox.showerror("启动失败", str(error)))
            finally:
                root.after(0, lambda: set_busy(False))
        threading.Thread(target=worker, daemon=True).start()

    def on_stop():
        """停止服务"""
        if is_busy[0]:
            return
        set_busy(True)
        status_text.set("正在停止服务 ...")
        status_indicator.itemconfig(dot, fill="#f59e0b")
        def worker():
            try:
                app.stop_server()
            except Exception as error:
                root.after(0, lambda: messagebox.showerror("停止失败", str(error)))
            finally:
                root.after(0, lambda: set_busy(False))
        threading.Thread(target=worker, daemon=True).start()

    def on_purge():
        """会话管理: 弹出可视化列表, 支持勾选(全选/单选)后选择「恢复(取消归档)」或「永久删除」"""
        if is_busy[0]:
            return
        if app.is_server_running():
            messagebox.showwarning("清理归档", "请先点击「停止服务」, 再执行清理。")
            return
        open_purge_dialog()

    def open_purge_dialog():
        """可视化会话列表窗口: 显示标题/工作区/状态, 支持勾选(全选/单选)后
        选择「恢复(取消归档)」或「永久删除」。"""
        top = tk.Toplevel(root)
        top.title("会话管理 (勾选后恢复或永久删除)")
        top.geometry("920x540")
        top.minsize(720, 380)
        top.transient(root)

        # 数据: 所有会话列表, 勾选字典 {id: True}
        all_items = []          # list of dict
        checked = {}            # {id: True}

        # 容器框架
        main_frame = ttk.Frame(top)
        main_frame.pack(fill="both", expand=True, padx=8, pady=(8, 4))

        # 带滚动条的 Treeview
        tree_frame = ttk.Frame(main_frame)
        tree_frame.pack(fill="both", expand=True)
        tree_scrollbar = ttk.Scrollbar(tree_frame, orient="vertical")
        tree_scrollbar.pack(side="right", fill="y")

        tree = ttk.Treeview(tree_frame,
                            columns=("check", "title", "workspace", "status", "log"),
                            show="headings", selectmode="none",
                            yscrollcommand=tree_scrollbar.set)
        tree_scrollbar.config(command=tree.yview)
        tree.heading("check", text="☐")
        tree.column("check", width=40, anchor="center")
        tree.heading("title", text="标题")
        tree.column("title", width=260)
        tree.heading("workspace", text="工作区")
        tree.column("workspace", width=280)
        tree.heading("status", text="状态")
        tree.column("status", width=70, anchor="center")
        tree.heading("log", text="日志")
        tree.column("log", width=50, anchor="center")
        tree.pack(fill="both", expand=True)

        # 点击行切换勾选
        def on_row_click(event):
            item_id = tree.identify_row(event.y)
            if not item_id:
                return
            if item_id == "__all__":
                toggle_all()
                return
            if item_id == "__none__":
                return
            # 切换勾选
            checked[item_id] = not checked.get(item_id)
            update_check_display()

        tree.bind("<ButtonRelease-1>", on_row_click)

        # 更新勾选显示
        def update_check_display():
            for child in tree.get_children():
                if child == "__all__":
                    all_checked = all(checked.get(s["id"], False) for s in all_items) if all_items else False
                    tree.set(child, "check", "☑" if all_checked else "☐")
                else:
                    tree.set(child, "check", "☑" if checked.get(child) else "☐")
            # 更新选中计数
            selected_count = sum(1 for v in checked.values() if v)
            if selected_count > 0:
                delete_btn.config(text="删除选中 (%d)" % selected_count)
            else:
                delete_btn.config(text="删除选中")
            # 更新已归档选中计数 (供恢复按钮显示, 只有已归档的才可恢复)
            archived_selected = sum(1 for sid, value in checked.items()
                                    if value and any(rec["id"] == sid and rec["archived"]
                                                     for rec in all_items))
            if archived_selected > 0:
                restore_btn.config(text="恢复选中 (%d)" % archived_selected)
            else:
                restore_btn.config(text="恢复选中")
            # 更新全选/全不选按钮文字
            all_checked = all(checked.get(s["id"], False) for s in all_items) if all_items else False
            if all_items:
                toggle_all_btn.config(text="全不选" if all_checked else "全选")

        def toggle_all():
            if not all_items:
                return
            all_checked = all(checked.get(s["id"], False) for s in all_items)
            for s in all_items:
                checked[s["id"]] = not all_checked
            update_check_display()

        # 加载数据
        def refresh():
            tree.delete(*tree.get_children())
            nonlocal all_items, checked
            checked = {}
            try:
                all_items = app.list_sessions()
            except Exception as error:
                messagebox.showerror("读取会话失败", str(error), parent=top)
                count_label.config(text="读取失败")
                all_items = []
                return
            if not all_items:
                tree.insert("", "end", iid="__none__",
                            values=("", "(没有找到任何会话)", "", "", ""))
            else:
                # 全选/全不选行
                tree.insert("", "end", iid="__all__",
                            values=("☐", "全选 / 全不选", "共 %d 个会话" % len(all_items), "", ""),
                            tags=("all_row",))
                # 会话行
                for rec in all_items:
                    status_text = "已归档" if rec["archived"] else "正常"
                    tree.insert("", "end", iid=rec["id"], values=(
                        "☐",
                        rec["title"] or "(无标题)",
                        rec["workspace"] or "(未归属)",
                        status_text,
                        "有" if rec["hasLog"] else "无",
                    ))
            count_label.config(text="共 %d 个会话" % len(all_items))
            update_check_display()

        # 删除选中
        def on_delete():
            selected_ids = [sid for sid, v in checked.items() if v]
            if not selected_ids:
                messagebox.showinfo("删除会话", "请先勾选要删除的会话。", parent=top)
                return
            preview = "\n".join(selected_ids[:8]) + ("\n…" if len(selected_ids) > 8 else "")
            if not messagebox.askyesno(
                    "删除会话",
                    "确定要永久删除选中的 %d 个会话吗?\n\n%s\n\n不可恢复。" % (len(selected_ids), preview),
                    parent=top):
                return
            delete_btn.config(state="disabled")
            restore_btn.config(state="disabled")
            toggle_all_btn.config(state="disabled")
            refresh_btn.config(state="disabled")
            failed = []
            try:
                for sid in selected_ids:
                    try:
                        ok = app.purge_session(sid)
                        if not ok:
                            failed.append(sid)
                    except Exception as error:
                        failed.append(sid)
                        append_log("删除会话 %s 失败: %s" % (sid, error))
                refresh()
                if failed:
                    messagebox.showwarning("删除完成", "已删除 %d 个会话, %d 个失败。" %
                                           (len(selected_ids) - len(failed), len(failed)), parent=top)
                else:
                    messagebox.showinfo("删除完成", "已删除 %d 个会话。" % len(selected_ids), parent=top)
            except Exception as error:
                messagebox.showerror("删除失败", str(error), parent=top)
            finally:
                delete_btn.config(state="normal")
                restore_btn.config(state="normal")
                toggle_all_btn.config(state="normal")
                refresh_btn.config(state="normal")

        # 恢复选中 (取消归档): 只处理勾选且已归档的会话
        def on_restore():
            archived_by_id = {rec["id"] for rec in all_items if rec["archived"]}
            selected_ids = [sid for sid, value in checked.items()
                            if value and sid in archived_by_id]
            if not selected_ids:
                messagebox.showinfo("恢复会话", "请先勾选要恢复(取消归档)的会话。", parent=top)
                return
            preview = "\n".join(selected_ids[:8]) + ("\n…" if len(selected_ids) > 8 else "")
            if not messagebox.askyesno(
                    "恢复会话",
                    "确定要恢复(取消归档)选中的 %d 个会话吗?\n\n%s\n\n"
                    "恢复后它们将重新出现在 WebUI 会话列表, 原日志与内容不受影响。"
                    % (len(selected_ids), preview),
                    parent=top):
                return
            delete_btn.config(state="disabled")
            restore_btn.config(state="disabled")
            toggle_all_btn.config(state="disabled")
            refresh_btn.config(state="disabled")
            failed = []
            try:
                for sid in selected_ids:
                    try:
                        ok = app.restore_session(sid)
                        if not ok:
                            failed.append(sid)
                    except Exception as error:
                        failed.append(sid)
                        append_log("恢复会话 %s 失败: %s" % (sid, error))
                refresh()
                if failed:
                    messagebox.showwarning("恢复完成", "已恢复 %d 个会话, %d 个失败。" %
                                           (len(selected_ids) - len(failed), len(failed)), parent=top)
                else:
                    messagebox.showinfo("恢复完成", "已恢复 %d 个会话。" % len(selected_ids), parent=top)
            except Exception as error:
                messagebox.showerror("恢复失败", str(error), parent=top)
            finally:
                delete_btn.config(state="normal")
                restore_btn.config(state="normal")
                toggle_all_btn.config(state="normal")
                refresh_btn.config(state="normal")

        # 底部按钮栏
        bottom = ttk.Frame(top)
        bottom.pack(fill="x", padx=8, pady=(0, 8))
        count_label = ttk.Label(bottom, text="")
        count_label.pack(side="left")
        ttk.Label(bottom, text="需先停止服务; 删除不可恢复, 恢复不删数据",
                  foreground="#a04040").pack(side="left", padx=(10, 0))
        toggle_all_btn = ttk.Button(bottom, text="全选", command=toggle_all)
        toggle_all_btn.pack(side="right", padx=(6, 0))
        close_btn = ttk.Button(bottom, text="关闭", command=top.destroy)
        close_btn.pack(side="right", padx=(6, 0))
        refresh_btn = ttk.Button(bottom, text="刷新", command=refresh)
        refresh_btn.pack(side="right", padx=(6, 0))
        delete_btn = ttk.Button(bottom, text="删除选中", command=on_delete)
        delete_btn.pack(side="right", padx=(6, 0))
        restore_btn = ttk.Button(bottom, text="恢复选中", command=on_restore)
        restore_btn.pack(side="right", padx=(6, 0))

        # 初始加载
        refresh()

    def on_open(method):
        """手动按指定方式打开 dsh 界面 (必定打开, 不受单页面去重拦截)。
        method: "desktop"=独立桌面窗口(WebView2壳) / "browser"=系统浏览器。"""
        app.open_ui(force=True, method=method)

    def on_check_update():
        """检查 dsh 是否有新版本, 有则弹窗让用户选择 更新 / 不更新"""
        if is_busy[0]:
            return
        # 环境未就绪时先提示 (查询需要便携 Node + 已安装 dsh)
        if not app.dsh_installed():
            messagebox.showinfo("检查更新", "当前尚未安装 dsh, 请先点击「安装环境」。")
            return
        set_busy(True)
        status_text.set("正在检查更新 ...")
        status_indicator.itemconfig(dot, fill="#f59e0b")
        append_log("--- 开始检查 dsh 更新 ---")
        def worker():
            try:
                current_version = app.dsh_version()
                # 动态检测所有标签 (不再写死 latest/next 两个):
                # ① npm dist-tags (稳定版/预发布)  ② GitHub Releases 全部 tag
                tags = app.dsh_dist_tags()
                npm_versions = app.dsh_npm_versions()
                github_releases = app.dsh_github_releases()
                if tags is None and github_releases is None:
                    root.after(0, lambda: messagebox.showerror(
                        "检查更新", "无法获取最新版本信息, 请检查网络后重试。"))
                    return
                candidates = []
                seen = set()
                def add_candidate(version, tag_label, installable,
                                  published_at="", body="", tag_name=""):
                    if not version or version in seen:
                        return
                    # 只保留比当前已装版本更新的候选
                    # (否则已是 stable(latest) 却仍提示再次覆盖安装, 属误报)。
                    if not app._green_version_greater(version, current_version):
                        app.log("跳过与当前相同或更旧的候选 %s (当前: %s)"
                                % (version, current_version))
                        return
                    seen.add(version)
                    candidates.append({
                        "version": version,
                        "tag_label": tag_label,
                        "installable": installable,
                        "published_at": published_at,
                        "tag_name": tag_name,
                        "body": body,
                    })
                # 1) npm dist-tags: 稳定版(latest) / 预发布(next), 一定可安装
                if tags:
                    add_candidate(tags.get("latest"), "稳定版(latest)", True)
                    add_candidate(tags.get("next"), "预发布(next)", True)
                # 2) GitHub Releases 全部 tag: 是否可安装看 npm 是否已发布该版本
                if github_releases:
                    for item in github_releases:
                        installable = (npm_versions is not None
                                       and item["version"] in npm_versions)
                        source_label = "GitHub tag" + ("(预发布)" if item["prerelease"] else "")
                        add_candidate(item["version"], source_label, installable,
                                      item["published_at"], item["body"], item["tag_name"])
                # 排序: 可安装的在前, 同一组内版本号从新到旧
                candidates.sort(key=lambda c: (
                    not c["installable"],
                    tuple(-number for number in app._green_version_tuple(c["version"]))))
                if not candidates:
                    root.after(0, lambda: messagebox.showinfo(
                        "检查更新",
                        "已是最新版本: %s\n(当前没有比已安装版本更新的发布。)"
                        % current_version))
                else:
                    root.after(0, lambda: ask_update(current_version, candidates))
            finally:
                root.after(0, lambda: set_busy(False))
        threading.Thread(target=worker, daemon=True).start()

    def on_cleanup_update():
        """清空绿色版更新暂存目录 (runtime/update): 暂存 zip / 解压内容 / 覆盖前旧文件备份 / 任务文件"""
        if is_busy[0]:
            return
        choose = messagebox.askyesno(
            "清理更新",
            "将清空更新暂存目录 (runtime/update),\n"
            "包括: 暂存的新版 zip、解压内容、覆盖前的旧文件备份、更新任务文件。\n\n"
            "若更新程序正在运行中, 被占用的文件会跳过, 不影响更新。是否继续?",
            icon="warning")
        if not choose:
            append_log("用户取消清理更新")
            return
        removed_count = app.cleanup_update_files()
        messagebox.showinfo("清理更新", "已清理更新目录, 共删除 %d 项。" % removed_count)
        append_log("已清理更新目录, 删除 %d 项" % removed_count)

    def on_cleanup_backup():
        """清空统一备份目录 (runtime/backup) 与旧版散落的 dsh-backup-* 目录"""
        if is_busy[0]:
            return
        choose = messagebox.askyesno(
            "清理备份",
            "将清空备份目录 (runtime/backup),\n"
            "包括: 更新 dsh 前自动备份的旧版本目录, 以及旧版散落的 dsh-backup-* 残留。\n\n"
            "清理后无法回退旧版本! 是否继续?",
            icon="warning")
        if not choose:
            append_log("用户取消清理备份")
            return
        removed_count = app.cleanup_backup_files()
        messagebox.showinfo("清理备份", "已清理备份目录, 共删除 %d 项。" % removed_count)
        append_log("已清理备份目录, 删除 %d 项" % removed_count)

    def start_update_to(target_version):
        """按用户选择的目标版本, 后台执行 备份 + 重装"""
        set_busy(True)
        status_text.set("正在更新 dsh ...")
        status_indicator.itemconfig(dot, fill="#f59e0b")
        append_log("--- 开始更新 dsh (目标: %s) ---" % target_version)
        def update_worker():
            try:
                new_version = app.update_dsh(target_version=target_version)
                root.after(0, lambda: messagebox.showinfo(
                    "更新完成", "dsh 已更新到版本: %s\n\n"
                    "旧版本已备份到 runtime/backup, 可在「数据维护」里一键清理。" % new_version))
            except Exception as error:
                root.after(0, lambda: messagebox.showerror("更新失败", str(error)))
            finally:
                root.after(0, lambda: set_busy(False))
        threading.Thread(target=update_worker, daemon=True).start()

    def confirm_upgrade(current_version, version, tag_name, preloaded_notes=None):
        """点击某个目标版本后弹出「确认升级」: 先展示该版本的更新描述,
        用户点「确认升级」才真正执行; 点「取消」则回到版本选择/关闭 (需求 #57)。
        preloaded_notes: 动态检测时已拉到的发布说明 (GitHub body), 有则直接用,
        避免重复网络查询; 无则在后台线程拉取 (需求: 动态 tag 列表复用)"""
        detail_dialog = tk.Toplevel(root)
        detail_dialog.title("确认升级")
        detail_dialog.transient(root)
        detail_dialog.grab_set()   # 模态

        header_frame = ttk.Frame(detail_dialog, padding=12)
        header_frame.pack(fill="x")
        ttk.Label(header_frame, justify="left", text=(
            "当前版本: %s\n\n将升级到: %s (%s)\n\n该版本的更新描述:" %
            (current_version, version, tag_name))).pack(anchor="w")

        # 更新描述文本区 (初始加载中, 后台线程查询后填充)
        notes_text = tk.Text(detail_dialog, height=12, width=72, wrap="word",
                             state="disabled")
        notes_text.pack(fill="both", expand=True, padx=12)
        scrollbar = ttk.Scrollbar(detail_dialog,
                                  command=notes_text.yview)
        scrollbar.pack(side="right", fill="y")
        notes_text.configure(yscrollcommand=scrollbar.set)

        def load_notes():
            notes = (preloaded_notes if preloaded_notes
                     else app.dsh_version_notes(version))
            root.after(0, lambda: fill_notes(notes))

        def fill_notes(notes):
            notes_text.configure(state="normal")
            notes_text.delete("1.0", "end")
            placeholder = ("(未能获取该版本的更新描述, 可直接确认升级。\n"
                           "目标版本: %s)" % version) if not notes else notes
            notes_text.insert("1.0", placeholder)
            notes_text.configure(state="disabled")

        threading.Thread(target=load_notes, daemon=True).start()

        footer_frame = ttk.Frame(detail_dialog, padding=12)
        footer_frame.pack(fill="x")
        ttk.Label(footer_frame, justify="left", foreground="#888888", text=(
            "升级前会自动备份当前版本到 runtime/backup/dsh-<版本>,\n"
            "旧版本备份不会自动删除, 可随时在「数据维护」里一键清理。")).pack(anchor="w")
        button_row = ttk.Frame(footer_frame)
        button_row.pack(side="right")
        ttk.Button(button_row, text="取消", command=detail_dialog.destroy).pack(side="right")
        ttk.Button(button_row, text="确认升级", command=lambda: (
            detail_dialog.destroy(), start_update_to(version))).pack(side="right", padx=6)

        # 居中于主窗口
        detail_dialog.update_idletasks()
        pos_x = root.winfo_x() + (root.winfo_width() - detail_dialog.winfo_reqwidth()) // 2
        pos_y = root.winfo_y() + (root.winfo_height() - detail_dialog.winfo_reqheight()) // 2
        detail_dialog.geometry("+%d+%d" % (pos_x, pos_y))

    def ask_update(current_version, candidates):
        """发现新版本时弹出对话框: 用可滚动列表**动态**列出所有检测到的候选版本
        (npm 稳定版/预发布 + GitHub 全部 tag), 用户选中后进入确认升级。
        不写死 latest/next 两个标签 —— 所有 tag 都按真实来源动态列出来。
        candidates: [{"version","tag_label","installable","published_at",
                      "tag_name","body"}, ...],
        已按 可安装优先、版本号从新到旧 排序。
        未发布到 npm 的版本 (仅 GitHub 源码 tag) 只能查看/打开 GitHub 页面,
        无法自动安装 (会给出明确提示, 避免安装失败)"""
        dialog = tk.Toplevel(root)
        dialog.title("发现新版本")
        dialog.transient(root)
        dialog.grab_set()   # 模态: 关闭前主窗口不可操作
        dialog.geometry("680x480")

        header = ttk.Frame(dialog, padding=12)
        header.pack(fill="x")
        ttk.Label(header, justify="left", text=(
            "当前版本: %s\n\n检测到 %d 个可更新版本, 请选择要安装的版本:"
            % (current_version, len(candidates)))).pack(anchor="w")

        # 列表区: 左 Treeview + 右垂直滚动条 (方便上下滑动)
        body = ttk.Frame(dialog)
        body.pack(fill="both", expand=True, padx=12, pady=(0, 6))
        tree = ttk.Treeview(body, columns=("tag", "time", "installable"),
                            show="tree headings", height=10)
        tree.heading("#0", text="版本")
        tree.heading("tag", text="标签/来源")
        tree.heading("time", text="发布时间")
        tree.heading("installable", text="可安装")
        # 列宽留足余量: 总和需明显小于面板宽度, 否则 pack 会把右侧滚动条压缩成 1x1
        tree.column("#0", width=130, anchor="center")
        tree.column("tag", width=170, anchor="w")
        tree.column("time", width=130, anchor="center")
        tree.column("installable", width=110, anchor="center")
        tree_scrollbar = ttk.Scrollbar(body, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=tree_scrollbar.set)
        tree.pack(side="left", fill="both", expand=True)
        tree_scrollbar.pack(side="right", fill="y")

        selected_items = {}
        for index, item in enumerate(candidates):
            installable_text = "是" if item["installable"] else "否(未发布到npm)"
            tree.insert("", "end", iid=str(index), text=item["version"],
                        values=(item["tag_label"], item["published_at"],
                                installable_text))
            selected_items[str(index)] = item

        def get_selected():
            selection = tree.selection()
            if not selection:
                messagebox.showwarning("发现新版本",
                                       "请先在上方列表中选择一个版本。", parent=dialog)
                return None
            return selected_items[selection[0]]

        def on_confirm():
            item = get_selected()
            if item is None:
                return
            if not item["installable"]:
                messagebox.showwarning(
                    "发现新版本",
                    "版本 %s 尚未发布到 npm, 暂无法自动安装。\n\n"
                    "官方通常只把正式/稳定版本发布到 npm,\n"
                    "而源码 tag 会提前出现在 GitHub Releases。\n"
                    "可点下方「打开 GitHub 发布页」查看该版本的源码与发布说明。"
                    % item["version"], parent=dialog)
                return
            dialog.destroy()
            confirm_upgrade(current_version, item["version"],
                            item["tag_label"], item.get("body"))

        def on_open_github():
            item = get_selected()
            if item is None:
                return
            tag_name = item.get("tag_name") or item["version"]
            url = ("https://github.com/deepseek-ai/deepseek-harness/"
                   "releases/tag/%s" % urllib.parse.quote(tag_name))
            try:
                webbrowser.open(url)
                append_log("已打开 GitHub 发布页: %s" % url)
            except Exception as error:
                messagebox.showerror("打开失败", "无法打开浏览器: %s" % error,
                                     parent=dialog)

        footer = ttk.Frame(dialog, padding=12)
        footer.pack(fill="x")
        ttk.Label(footer, justify="left", foreground="#888888", text=(
            "提示: 「可安装」= 该版本已发布到 npm, 可自动下载安装;\n"
            "未发布到 npm 的源码 tag 只能查看, 需等官方同步发布后才能安装。")).pack(anchor="w")
        button_row = ttk.Frame(footer)
        button_row.pack(side="right")
        ttk.Button(button_row, text="暂不更新", command=lambda: (
            dialog.destroy(), append_log("用户选择暂不更新"))).pack(side="right")
        ttk.Button(button_row, text="打开 GitHub 发布页",
                   command=on_open_github).pack(side="right", padx=6)
        ttk.Button(button_row, text="确认升级",
                   command=on_confirm).pack(side="right", padx=(6, 0))

        # 居中于主窗口
        dialog.update_idletasks()
        pos_x = root.winfo_x() + (root.winfo_width() - dialog.winfo_reqwidth()) // 2
        pos_y = root.winfo_y() + (root.winfo_height() - dialog.winfo_reqheight()) // 2
        dialog.geometry("+%d+%d" % (pos_x, pos_y))

    # -------------------------------------------------------------------------
    # 绿色版外围更新 (自更新通道, 与上面的官方核心更新完全独立):
    # 查询 GitHub Release -> 对比版本 -> 下载 zip 到 runtime/update 暂存 ->
    # 解压并生成 update_job.json -> 启动独立更新程序 DSH_Update.exe -> 启动器退出 ->
    # 由更新程序完成覆盖安装 (等本体退出/备份/覆盖/重启), 失败时弹窗给出手动下载地址。
    # 绝不触碰 runtime/ 与用户自定义的 config.json, 保证与官方核心更新互不干扰。
    # -------------------------------------------------------------------------
    def on_check_green_update():
        """检查绿色版是否有新版本 (查询本项目 GitHub Release)"""
        if is_busy[0]:
            return
        if app.is_server_running():
            messagebox.showinfo("检查绿色版更新", "请先点击「停止服务」, 再进行绿色版更新。")
            return
        set_busy(True)
        status_text.set("正在检查绿色版更新 ...")
        status_indicator.itemconfig(dot, fill="#f59e0b")
        append_log("--- 开始检查绿色版更新 ---")
        def worker():
            try:
                release_info = app.green_latest_release()
                root.after(0, lambda: confirm_green_update(release_info))
            except Exception as error:
                root.after(0, lambda: messagebox.showerror("检查绿色版更新", str(error)))
                root.after(0, lambda: set_busy(False))
        threading.Thread(target=worker, daemon=True).start()

    def confirm_green_update(release_info):
        """绿色版查询结果处理: 无 Release / 已是最新 / 发现新版 -> 确认是否下载"""
        if release_info is None:
            set_busy(False)
            messagebox.showerror("检查绿色版更新", "无法获取最新版本, 请检查网络后重试。")
            return
        local_version = app.green_local_version()
        latest_version = app.green_release_version(release_info)
        if not latest_version:
            set_busy(False)
            messagebox.showwarning("检查绿色版更新",
                                   "当前版本尚未发布正式 Release, 请稍后再试。")
            return
        if not app._green_version_greater(latest_version, local_version):
            set_busy(False)
            messagebox.showinfo("检查绿色版更新", "已是最新绿色版 v%s" % local_version)
            return
        asset = app.green_find_zip_asset(release_info)
        if asset is None:
            set_busy(False)
            messagebox.showwarning(
                "检查绿色版更新",
                "已发现新版 v%s, 但 Release 里未找到匹配的下载文件 (需含 %s*.zip),\n"
                "请到 GitHub 手动下载。" % (latest_version, GREEN_ZIP_PREFIX))
            return
        asset_name, download_url, asset_size = asset
        release_note = (release_info.get("body") or "").strip() or "(无更新说明)"
        if len(release_note) > 400:
            release_note = release_note[:400] + " ..."
        is_gitee_source = (release_info.get("source") or "") in ("gitee", "gitee_release")
        # 提示文案按"下载源设置 + 实际来源"区分语义 (用户需求 2026-08-20):
        # 国内源/自动: 主动优先走 Gitee, 文案用"国内源优先"而非"GitHub 连不通";
        # 官方源    : 仅在 Gitee 兜底时提示"GitHub 通道连不通"。
        prefer_gitee = (app.resolve_mirror()[0] == "cn")
        if is_gitee_source:
            if prefer_gitee:
                source_hint = ("\n\n本次更新来自 Gitee 镜像源 (国内源优先, 发布版 zip 直连, "
                               "与 GitHub 发货内容一致)。")
            else:
                source_hint = ("\n\n注意: GitHub 通道连不通, 本次更新来自 Gitee 镜像源"
                               " (发布版 zip / 整仓快照, 与 GitHub 发货内容一致)。")
        else:
            source_hint = ""
        choose = messagebox.askyesno(
            "发现新绿色版",
            "当前版本: v%s\n最新版本: v%s\n\n更新说明:\n%s%s\n\n"
            "是否下载并更新?\n\n更新流程: 下载到 runtime/update 暂存 → 退出启动器 → "
            "自动覆盖安装 → 重启。\n不替换 config.json(你的设置) 与 runtime/(你的数据)。"
            % (local_version, latest_version, release_note, source_hint),
            icon="question")
        if not choose:
            append_log("用户选择暂不更新绿色版")
            set_busy(False)
            return
        # 用户确认下载, 后台执行 (按来源准备内容根目录 + 生成更新任务)
        set_busy(True)
        status_text.set("正在下载绿色版更新 ...")
        append_log("--- 开始下载绿色版更新: %s ---" % asset_name)
        def download_worker():
            try:
                # 按来源准备内容根目录: GitHub=下载zip解压, Gitee=git协议克隆整仓。
                # prepare_update_content_root 内部若发生"GitHub 下载失败自动切 Gitee",
                # 会改写 release_info["source"], 因此 source 必须在调用后再取,
                # 保证后续失败提示/覆盖来源与真实下载源一致。
                extracted_dir = os.path.join(GREEN_UPDATE_DIR, "extracted")
                content_root = app.prepare_update_content_root(
                    release_info, extracted_dir)
                source = release_info.get("source") or "github"
                content_root, job_path = app.prepare_green_update(
                    content_root, latest_version, download_url, source)
                root.after(0, lambda: ask_apply_green_update(
                    content_root, job_path))
            except Exception as error:
                root.after(0, lambda: messagebox.showerror("下载绿色版更新失败", str(error)))
                root.after(0, lambda: set_busy(False))
        threading.Thread(target=download_worker, daemon=True).start()

    def ask_apply_green_update(content_root, job_path):
        """下载与准备完成: 提示用户将退出启动器并覆盖安装, 确认后启动独立更新程序并退出"""
        choose = messagebox.askyesno(
            "准备完成",
            "新版已下载并准备就绪。\n\n"
            "接下来将退出启动器, 由独立更新程序自动完成覆盖安装, 然后重新启动。\n"
            "旧文件会自动备份到 runtime/update/backup/ (可手动回退)。\n\n是否继续?",
            icon="question")
        if not choose:
            append_log("用户取消应用绿色版更新")
            set_busy(False)
            return
        try:
            # 更新完成重启后, 新启动器会自动同步一次内置插件 (见 run_post_update_bundled_sync)
            app.mark_bundled_plugin_sync_pending()
            app.launch_update_agent(job_path)
            # 脚本已分离启动, 启动器随即退出; 不重置 busy(窗口即将销毁)
            append_log("绿色版更新脚本已启动, 启动器即将退出 ...")
            on_close(confirm=False)
        except Exception as error:
            messagebox.showerror("启动更新脚本失败", str(error))
            set_busy(False)

    def on_plugin_manager():
        """打开插件管理新窗口 (需环境就绪)"""
        if is_busy[0]:
            return
        if not check_environment_ready():
            messagebox.showinfo("插件管理", "请先点击「安装环境」准备环境 (需要 Node + dsh)。")
            return
        open_plugin_manager()

    def open_plugin_manager():
        """插件管理窗口: 查看已安装 / 搜索 (npm + GitHub 官方话题页) / 安装 / 移除插件
        所有耗时操作都在后台线程执行, 通过 root.after 回主线程更新界面"""
        top = tk.Toplevel(root)
        top.title("插件管理")
        top.geometry("900x600")
        top.minsize(760, 520)

        profile = DEFAULT_PROFILE
        plugin_busy = [False]   # 本窗口忙碌标志, 防止重复操作
        # 记录列表条目 -> 插件信息, 供右键菜单打开对应网页使用
        installed_item_urls = {}   # 左侧已安装: item_id -> 包名
        search_item_urls = {}      # 右侧搜索:  item_id -> {name, source, url}

        # ---------- 操作函数 (先全部定义, 再创建控件; 函数体内对控件的引用在调用时才解析) ----------
        def set_plugin_busy(busy):
            """设置本窗口忙碌状态, 统一禁用/恢复操作按钮"""
            plugin_busy[0] = busy
            button_state = "disabled" if busy else "normal"
            for button in (search_btn, load_github_btn, github_btn, load_rec_btn,
                           remove_btn, install_btn, manual_btn, local_install_btn,
                           enable_btn, disable_btn):
                button.config(state=button_state)
            if not busy:
                plugin_status.set("就绪")

        def refresh_installed():
            """读取已安装插件并刷新左侧列表"""
            installed_tree.delete(*installed_tree.get_children())
            installed_item_urls.clear()
            dependencies = app.list_installed_plugins(profile)
            if not dependencies:
                installed_tree.insert("", "end", text="(暂无已安装插件)", values=("", "", ""))
                return
            for package_name, version in sorted(dependencies.items()):
                state = app.get_plugin_state(package_name, profile)
                state_label = {"enabled": "启用", "disabled": "停用",
                               "plain": "—", "missing": "—"}.get(state, "—")
                item_id = installed_tree.insert("", "end", text=package_name,
                                                values=(version, state_label))
                # 记录每个条目对应的网址, 供右键菜单打开页面使用
                installed_item_urls[item_id] = package_name

        def on_refresh_installed():
            """刷新已安装列表 (本地读取, 不耗时)"""
            refresh_installed()

        def show_search_results(plugins, default_source):
            """把搜索结果填入右侧列表; default_source 为 'npm' 或 'github'"""
            search_tree.delete(*search_tree.get_children())
            search_item_urls.clear()
            if not plugins:
                search_tree.insert("", "end", text="(无结果)", values=("", default_source, "", ""))
                plugin_status.set("没有搜索到结果")
                return
            for plugin in plugins:
                item_category = plugin.get("category", "")
                item_source = plugin.get("source", default_source)
                item_id = search_tree.insert("", "end",
                                             text=plugin["name"],
                                             values=(item_category, item_source,
                                                     plugin.get("version", ""),
                                                     plugin.get("description", "")))
                # 记录每个条目对应的网址, 供右键菜单打开页面使用; spec 为显式安装标识 (推荐项才有)
                search_item_urls[item_id] = {
                    "name": plugin["name"],
                    "category": item_category,
                    "source": item_source,
                    "url": plugin.get("url", ""),
                    "spec": plugin.get("spec", ""),
                }
            plugin_status.set("共 %d 条结果" % len(plugins))

        def do_search():
            """搜索插件 (npm 注册表, 国内镜像优先)"""
            if plugin_busy[0]:
                return
            keyword = keyword_var.get().strip() or "dsh-plugin"
            set_plugin_busy(True)
            plugin_status.set("正在搜索: %s ..." % keyword)
            def worker():
                try:
                    plugins = app.search_npm_plugins(keyword)
                    root.after(0, lambda: show_search_results(plugins, "npm"))
                except Exception as error:
                    root.after(0, lambda: (messagebox.showerror("搜索失败", str(error), parent=top),
                                           plugin_status.set("搜索失败")))
                finally:
                    root.after(0, lambda: set_plugin_busy(False))
            threading.Thread(target=worker, daemon=True).start()

        def do_load_github():
            """抓取 GitHub 官方话题页热门仓库并填入搜索结果"""
            if plugin_busy[0]:
                return
            set_plugin_busy(True)
            plugin_status.set("正在加载 GitHub 官方话题页 ...")
            def worker():
                try:
                    plugins = app.fetch_github_topic_plugins()
                    root.after(0, lambda: show_search_results(plugins, "github"))
                except Exception as error:
                    root.after(0, lambda: (messagebox.showerror("加载失败", str(error), parent=top),
                                           plugin_status.set("加载失败")))
                finally:
                    root.after(0, lambda: set_plugin_busy(False))
            threading.Thread(target=worker, daemon=True).start()

        def do_load_recommended():
            """加载内置推荐插件列表 (本地内置, 无需网络搜索, 即使断网也能看到可装项)"""
            if plugin_busy[0]:
                return
            show_search_results(list(RECOMMENDED_PLUGINS), "推荐")
            plugin_status.set("已加载 %d 个社区精选推荐插件" % len(RECOMMENDED_PLUGINS))

        def do_open_github_topic():
            """在浏览器打开 GitHub 官方话题页 (完整入口, 可翻页浏览更多)"""
            webbrowser.open(GITHUB_TOPIC_URL)

        def build_open_urls(item_info):
            """根据条目信息构造可打开的网址列表
            返回 [(显示名, url), ...]; 推荐项 GitHub 标识用仓库地址, 其余用 npm 页面 + GitHub 搜索兜底"""
            name = item_info["name"]
            spec = item_info.get("spec", "")
            raw_url = item_info.get("url", "")
            url_list = []
            # 推荐项 GitHub 标识: 直接打开仓库地址; 仓库名不等于 npm 包名, 不给无效的 npm 页
            if spec.startswith("github:"):
                repo = spec[len("github:"):]
                url_list.append(("打开 GitHub 仓库", raw_url or "https://github.com/%s" % repo))
                url_list.append(("打开 GitHub 搜索",
                                 "https://github.com/search?q=%s" % urllib.parse.quote(name)))
            else:
                # npm 包 / 搜索来源: 打开 npm 页面, 以及 GitHub 搜索
                url_list.append(("打开 npm 页面",
                                 "https://www.npmjs.com/package/%s" % urllib.parse.quote(name)))
                url_list.append(("打开 GitHub 搜索",
                                 "https://github.com/search?q=%s" % urllib.parse.quote(name)))
            return url_list

        def on_plugin_right_click(tree, item_urls, event):
            """Treeview 右键菜单: 打开对应网页 (npm / GitHub)
            tree 为被点击的 Treeview, item_urls 为条目映射表, event 为鼠标事件"""
            row_id = tree.identify_row(event.y)
            if not row_id:
                return
            tree.selection_set(row_id)
            info = item_urls.get(row_id)
            if info is None:
                return
            context_menu = tk.Menu(top, tearoff=0)
            for label, url in build_open_urls(info):
                context_menu.add_command(label=label, command=lambda u=url: webbrowser.open(u))
            context_menu.add_separator()
            context_menu.add_command(label="复制包名",
                                     command=lambda: root.clipboard_append(info["name"]))
            context_menu.tk_popup(event.x_root, event.y_root)
            context_menu.grab_release()

        def resolve_selected_spec():
            """取搜索结果选中项的安装规格与显示名
            返回 (安装规格, 显示名); 未选中或空条目返回 (None, None)"""
            selection = search_tree.selection()
            if not selection:
                return None, None
            package_name = search_tree.item(selection[0], "text")
            if package_name.startswith("("):
                return None, None
            # 推荐项: 优先用显式 spec (可能为 github:<repo> 或 npm 包名)
            item_spec = search_item_urls.get(selection[0], {}).get("spec", "")
            if item_spec:
                return item_spec, package_name
            # 搜索来源: 依来源列判断 (位于 values 第 1 项, 前面是分类列), GitHub 用仓库形式, 其余按 npm 包名
            item_source = search_tree.item(selection[0], "values")[1]
            if item_source == "github":
                return "github:%s" % package_name, package_name
            return package_name, package_name

        def on_install_selected():
            """安装搜索结果中选中的插件"""
            if plugin_busy[0]:
                return
            spec, display_name = resolve_selected_spec()
            if spec is None:
                messagebox.showinfo("插件管理", "请先在右侧选中要安装的插件。", parent=top)
                return
            do_install(spec, display_name)

        def on_manual_install():
            """手动输入安装规格并安装"""
            if plugin_busy[0]:
                return
            spec = manual_var.get().strip()
            if not spec:
                messagebox.showinfo("插件管理",
                                    "请先输入要安装的插件规格, 如 dsh-advisor 或 github:用户/仓库#提交号。",
                                    parent=top)
                return
            do_install(spec, spec)

        def on_install_local():
            """选择本地插件文件夹 (含 package.json) 并安装, 重启服务后生效"""
            if plugin_busy[0]:
                return
            default_plugins_dir = os.path.join(BASE_DIR, "plugins")
            if not os.path.isdir(default_plugins_dir):
                default_plugins_dir = BASE_DIR
            folder = filedialog.askdirectory(
                title="选择本地插件目录 (目录内需含 package.json)",
                initialdir=default_plugins_dir,
                parent=top)
            if not folder:
                return
            if not messagebox.askyesno(
                    "安装本地插件",
                    "将安装本地插件目录:\n%s\n\n安装后需重启服务生效。\n继续吗?" % folder,
                    parent=top):
                return
            spec = "file:" + os.path.abspath(folder).replace("\\", "/")
            do_install(spec, os.path.basename(folder))

        def on_install_bundled():
            """一键安装 + 同步程序目录 plugins/ 下所有内置插件:
            未安装的自动补装, 已安装的自动更新为最新源码 (附带检查更新操作)。
            复用 install_bundled_plugins() + update_bundled_plugins(), 与「安装环境」里
            的自动安装同一实现; 更新为增量: 逐文件哈希对比, 只写变化的文件"""
            if plugin_busy[0]:
                return
            if not app.bundled_plugin_dirs():
                messagebox.showinfo("插件管理", "程序目录 plugins/ 下未发现内置插件。", parent=top)
                return
            if not messagebox.askyesno(
                    "安装内置插件",
                    "将批量安装并同步程序目录 plugins/ 下的全部内置插件:\n%s\n\n"
                    "未安装的会自动安装, 已安装的自动更新为最新源码 (已是最新的跳过), "
                    "完成后需重启服务生效。继续吗?" % "\n".join(
                        os.path.basename(folder) for folder in app.bundled_plugin_dirs()),
                    parent=top):
                return
            set_plugin_busy(True)
            plugin_status.set("正在安装/更新内置插件 ...")
            def worker():
                try:
                    installed_now, _skipped, failed_install = \
                        app.install_bundled_plugins(profile)
                    updated, up_to_date, _not_installed, failed_update = \
                        app.update_bundled_plugins(profile)
                    summary = []
                    if installed_now:
                        summary.append("新装: %s" % ", ".join(installed_now))
                    if updated:
                        summary.append("已更新: %s" % ", ".join(updated))
                    if up_to_date:
                        summary.append("已是最新: %s" % ", ".join(up_to_date))
                    if failed_install:
                        summary.append("安装失败: %s" % ", ".join(failed_install))
                    if failed_update:
                        summary.append("更新失败: %s" % "; ".join(
                            "%s(%s)" % (name, reason) for name, reason in failed_update))
                    message = "\n".join(summary) if summary else "(没有可安装/更新的内置插件)"
                    root.after(0, lambda: (refresh_installed(),
                                           messagebox.showinfo("安装内置插件", message, parent=top),
                                           plugin_status.set("内置插件安装/更新完成")))
                except Exception as error:
                    root.after(0, lambda: (messagebox.showerror("安装失败", str(error), parent=top),
                                           plugin_status.set("安装失败")))
                finally:
                    root.after(0, lambda: set_plugin_busy(False))
            threading.Thread(target=worker, daemon=True).start()

        def do_install(spec, display_name):
            """后台线程执行插件安装"""
            set_plugin_busy(True)
            plugin_status.set("正在安装: %s ..." % display_name)
            def worker():
                try:
                    app.install_plugin(spec, profile)
                    root.after(0, lambda: (refresh_installed(),
                                           plugin_status.set("已安装: %s" % display_name)))
                except Exception as error:
                    root.after(0, lambda: (messagebox.showerror("安装失败", str(error), parent=top),
                                           plugin_status.set("安装失败")))
                finally:
                    root.after(0, lambda: set_plugin_busy(False))
            threading.Thread(target=worker, daemon=True).start()

        def auto_sync_bundled_on_open():
            """打开插件管理窗口即自动同步一次内置插件 (无需单独按钮):
            把已安装的内置插件更新为 plugins/ 最新源码, 结果写入状态栏。"""
            try:
                updated, up_to_date, _not_installed, failed = \
                    app.update_bundled_plugins(profile)
                if updated:
                    root.after(0, lambda: (refresh_installed(),
                                           plugin_status.set("已自动更新内置插件: %s (重启服务后完全生效)"
                                                             % ", ".join(updated))))
                elif failed:
                    root.after(0, lambda: plugin_status.set(
                        "内置插件同步: 失败 %s" % "; ".join(
                            "%s(%s)" % (name, reason) for name, reason in failed)))
                else:
                    root.after(0, lambda: plugin_status.set(
                        "内置插件已是最新 (%d 个)" % len(up_to_date)))
            except Exception as error:
                root.after(0, lambda: plugin_status.set("内置插件同步失败: %s" % error))

        def on_remove():
            """移除左侧选中的已安装插件"""
            if plugin_busy[0]:
                return
            selection = installed_tree.selection()
            if not selection:
                messagebox.showinfo("插件管理", "请先在左侧选中要移除的插件。", parent=top)
                return
            package_name = installed_tree.item(selection[0], "text")
            if package_name.startswith("("):
                return
            if not messagebox.askyesno("移除插件", "确定要移除插件「%s」吗?" % package_name, parent=top):
                return
            set_plugin_busy(True)
            plugin_status.set("正在移除: %s ..." % package_name)
            def worker():
                try:
                    app.remove_plugin(package_name, profile)
                    root.after(0, lambda: (refresh_installed(),
                                           plugin_status.set("已移除: %s" % package_name)))
                except Exception as error:
                    root.after(0, lambda: (messagebox.showerror("移除失败", str(error), parent=top),
                                           plugin_status.set("移除失败")))
                finally:
                    root.after(0, lambda: set_plugin_busy(False))
            threading.Thread(target=worker, daemon=True).start()

        def on_toggle(enable):
            """启用/停用左侧选中的插件 (改 dsh.profile.bundles + disabled 列表)"""
            if plugin_busy[0]:
                return
            selection = installed_tree.selection()
            if not selection:
                messagebox.showinfo("插件管理", "请先在左侧选中要启停的插件。", parent=top)
                return
            package_name = installed_tree.item(selection[0], "text")
            if package_name.startswith("("):
                return
            action = "启用" if enable else "停用"
            if not messagebox.askyesno(action + "插件",
                                       "确定要%s插件「%s」吗?\n\n%s后需重启服务才生效。" % (action, package_name, action),
                                       parent=top):
                return
            try:
                ok = app.set_plugin_enabled(package_name, profile, enabled=enable)
            except Exception as error:
                messagebox.showerror(action + "失败", str(error), parent=top)
                return
            if not ok:
                messagebox.showinfo("插件管理",
                                    "「%s」不是可启停的 bundle 插件 (未声明 dsh.bundle), 无需启停。" % package_name,
                                    parent=top)
                return
            refresh_installed()
            plugin_status.set("已%s: %s (重启服务后生效)" % (action, package_name))

        # ---------- 顶部工具栏 ----------
        toolbar = ttk.Frame(top)
        toolbar.pack(fill="x", padx=10, pady=(10, 6))

        ttk.Label(toolbar, text="搜索插件:").pack(side="left")
        keyword_var = tk.StringVar(value="dsh-plugin")
        keyword_entry = ttk.Entry(toolbar, textvariable=keyword_var, width=28)
        keyword_entry.pack(side="left", padx=(6, 6))

        ttk.Label(toolbar, text="  ").pack(side="left")

        ttk.Label(toolbar, text="GitHub 官方入口:").pack(side="left")
        github_btn = ttk.Button(toolbar, text="打开官方话题页", command=do_open_github_topic)
        github_btn.pack(side="left", padx=(6, 0))

        bundled_btn = ttk.Button(toolbar, text="一键安装内置插件",
                                 command=on_install_bundled)
        bundled_btn.pack(side="left", padx=(12, 0))
        ttk.Label(toolbar, text="(打开本窗口自动同步内置插件)").pack(side="left", padx=(6, 0))

        # ---------- 中间: 左右两个面板 ----------
        middle = ttk.Panedwindow(top, orient="horizontal")
        middle.pack(fill="both", expand=True, padx=10, pady=6)

        # 左侧: 已安装插件
        installed_frame = ttk.LabelFrame(middle, text="已安装插件 (profile: %s)" % profile)
        middle.add(installed_frame, weight=1)
        # 列表区: 左 Treeview + 右垂直滚动条 (方便上下滑动)
        installed_body = ttk.Frame(installed_frame)
        installed_body.pack(fill="both", expand=True, padx=6, pady=6)
        installed_tree = ttk.Treeview(installed_body, columns=("version", "state"), show="tree headings")
        installed_tree.heading("#0", text="插件名")
        installed_tree.heading("version", text="版本")
        installed_tree.heading("state", text="状态")
        installed_tree.column("#0", width=240)
        installed_tree.column("version", width=80, anchor="center")
        installed_tree.column("state", width=56, anchor="center")
        installed_scrollbar = ttk.Scrollbar(installed_body, orient="vertical",
                                            command=installed_tree.yview)
        installed_tree.configure(yscrollcommand=installed_scrollbar.set)
        installed_tree.pack(side="left", fill="both", expand=True)
        installed_scrollbar.pack(side="right", fill="y")

        installed_buttons = ttk.Frame(installed_frame)
        installed_buttons.pack(fill="x", padx=6, pady=(0, 6))
        remove_btn = ttk.Button(installed_buttons, text="移除选中插件", command=on_remove)
        remove_btn.pack(side="left")
        enable_btn = ttk.Button(installed_buttons, text="启用选中", command=lambda: on_toggle(True))
        enable_btn.pack(side="left", padx=(6, 0))
        disable_btn = ttk.Button(installed_buttons, text="停用选中", command=lambda: on_toggle(False))
        disable_btn.pack(side="left", padx=(6, 0))
        ttk.Button(installed_buttons, text="刷新", command=on_refresh_installed).pack(side="left", padx=(6, 0))
        ttk.Label(installed_buttons, text="(启停后需重启服务生效)",
                  foreground="#666666").pack(side="left", padx=(8, 0))

        # 右侧: 搜索结果
        search_frame = ttk.LabelFrame(middle, text="搜索结果")
        middle.add(search_frame, weight=2)
        # 列表区: 左 Treeview + 右垂直滚动条 (方便上下滑动)
        search_body = ttk.Frame(search_frame)
        search_body.pack(fill="both", expand=True, padx=6, pady=6)
        search_tree = ttk.Treeview(search_body, columns=("category", "source", "version", "description"), show="tree headings")
        search_tree.heading("#0", text="插件名")
        search_tree.heading("category", text="分类")
        search_tree.heading("source", text="来源")
        search_tree.heading("version", text="版本")
        search_tree.heading("description", text="描述")
        # 列宽留足余量: 总和需明显小于面板宽度, 否则 pack 会把右侧滚动条压缩成 1x1
        search_tree.column("#0", width=150)
        search_tree.column("category", width=56, anchor="center")
        search_tree.column("source", width=48, anchor="center")
        search_tree.column("version", width=54, anchor="center")
        search_tree.column("description", width=170, stretch=True)
        search_scrollbar = ttk.Scrollbar(search_body, orient="vertical",
                                         command=search_tree.yview)
        search_tree.configure(yscrollcommand=search_scrollbar.set)
        search_tree.pack(side="left", fill="both", expand=True)
        search_scrollbar.pack(side="right", fill="y")

        search_buttons = ttk.Frame(search_frame)
        search_buttons.pack(fill="x", padx=6, pady=(0, 6))
        search_btn = ttk.Button(search_buttons, text="搜索", command=do_search)
        search_btn.pack(side="left")
        load_rec_btn = ttk.Button(search_buttons, text="加载推荐", command=do_load_recommended)
        load_rec_btn.pack(side="left", padx=(6, 0))
        load_github_btn = ttk.Button(search_buttons, text="加载 GitHub 热门", command=do_load_github)
        load_github_btn.pack(side="left", padx=(6, 0))
        install_btn = ttk.Button(search_buttons, text="安装选中插件", command=on_install_selected)
        install_btn.pack(side="left", padx=(6, 0))

        # ---------- 手动安装栏 ----------
        manual_frame = ttk.Frame(top)
        manual_frame.pack(fill="x", padx=10, pady=(0, 6))
        ttk.Label(manual_frame, text="手动安装 (支持 npm 包名 或 github:用户/仓库#提交号):").pack(side="left")
        manual_var = tk.StringVar()
        manual_entry = ttk.Entry(manual_frame, textvariable=manual_var, width=48)
        manual_entry.pack(side="left", padx=(6, 6))
        manual_btn = ttk.Button(manual_frame, text="安装", command=on_manual_install)
        manual_btn.pack(side="left")
        local_install_btn = ttk.Button(manual_frame, text="选择本地插件文件夹安装…",
                                       command=on_install_local)
        local_install_btn.pack(side="left", padx=(8, 0))
        ttk.Label(manual_frame, text="(本地插件: 重启服务后生效)",
                  foreground="#666666").pack(side="left", padx=(8, 0))

        # ---------- 底部状态栏 ----------
        plugin_status = tk.StringVar(value="就绪")
        ttk.Label(top, textvariable=plugin_status, font=("Microsoft YaHei", 9),
                  foreground="#555555").pack(side="bottom", fill="x", padx=10, pady=(0, 8), anchor="w")

        # 右键菜单: 已安装列表 -> npm 页面 / 复制包名 (内置插件更新在打开窗口时自动进行,
        # 无需单独入口); 搜索列表 -> 对应网页 (npm / GitHub) 或复制包名
        def on_installed_right_click(event):
            """已安装列表右键: 打开 npm 页面 / 复制包名"""
            row_id = installed_tree.identify_row(event.y)
            if not row_id:
                return
            installed_tree.selection_set(row_id)
            package_name = installed_item_urls.get(row_id)
            if not package_name:
                return
            context_menu = tk.Menu(top, tearoff=0)
            context_menu.add_command(
                label="打开 npm 页面",
                command=lambda: webbrowser.open(
                    "https://www.npmjs.com/package/%s" % urllib.parse.quote(package_name)))
            context_menu.add_command(label="复制包名",
                                     command=lambda: root.clipboard_append(package_name))
            context_menu.tk_popup(event.x_root, event.y_root)
            context_menu.grab_release()

        installed_tree.bind("<Button-3>", on_installed_right_click)
        search_tree.bind("<Button-3>",
                         lambda event: on_plugin_right_click(search_tree,
                                                             search_item_urls, event))

        # 初始刷新已安装列表; 回车触发搜索
        refresh_installed()
        keyword_entry.bind("<Return>", lambda event: do_search())

        # 打开窗口即自动同步一次内置插件 (2026-08-27): 源码随绿色版更新后,
        # 打开插件管理即可把已装副本更新到最新, 无需单独更新按钮
        threading.Thread(target=auto_sync_bundled_on_open, daemon=True).start()

    # 八个按钮: 安装环境 / 启动服务 / 停止服务 / 打开界面 / 检查更新 / 检查绿色版更新 / 插件管理 / 刷新状态
    install_btn = ttk.Button(button_frame, text="安装环境", command=on_install)
    install_btn.pack(side="left", padx=(0, 8))

    start_btn = ttk.Button(button_frame, text="启动服务", command=on_start)
    start_btn.pack(side="left", padx=8)

    stop_btn = ttk.Button(button_frame, text="停止服务", command=on_stop)
    stop_btn.pack(side="left", padx=8)

    # 分隔: 打开界面 → 桌面窗口 / 网页窗口 两项 (可分别手动打开)
    ttk.Button(button_frame, text="桌面窗口",
               command=lambda: on_open("desktop")).pack(side="left", padx=(0, 8))
    ttk.Button(button_frame, text="网页窗口",
               command=lambda: on_open("browser")).pack(side="left", padx=8)

    update_btn = ttk.Button(button_frame, text="检查更新", command=on_check_update)
    update_btn.pack(side="left", padx=8)

    green_update_btn = ttk.Button(button_frame, text="检查绿色版更新", command=on_check_green_update)
    green_update_btn.pack(side="left", padx=8)

    plugin_btn = ttk.Button(button_frame, text="插件管理", command=on_plugin_manager)
    plugin_btn.pack(side="left", padx=8)

    ttk.Button(button_frame, text="刷新状态", command=refresh_status).pack(side="left", padx=8)

    # ---------- 数据维护区 (需先停止服务) ----------
    maintenance_frame = ttk.LabelFrame(root, text="数据维护 (需先停止服务, 恢复不删数据)")
    maintenance_frame.pack(fill="x", padx=14, pady=(0, 8))
    purge_btn = ttk.Button(maintenance_frame, text="会话管理", command=on_purge)
    purge_btn.pack(side="left", padx=8, pady=6)
    ttk.Label(maintenance_frame,
              text="弹出会话列表, 勾选(可全选)后可恢复(取消归档)或永久删除选中的会话(日志+注册表条目)",
              foreground="#a04040").pack(side="left", padx=(12, 8))
    # 清理维护: 清空更新暂存目录 / 统一备份目录 (独立文件夹集中管理)
    cleanup_row = ttk.Frame(maintenance_frame)
    cleanup_row.pack(fill="x", padx=8, pady=(0, 6))
    cleanup_update_btn = ttk.Button(cleanup_row, text="清理更新",
                                    command=on_cleanup_update)
    cleanup_update_btn.pack(side="left", padx=(0, 8))
    cleanup_backup_btn = ttk.Button(cleanup_row, text="清理备份",
                                    command=on_cleanup_backup)
    cleanup_backup_btn.pack(side="left", padx=(0, 8))
    ttk.Label(cleanup_row,
              text="清空 runtime/update (更新暂存) 与 runtime/backup (旧版备份) 文件夹",
              foreground="#606060").pack(side="left", padx=(4, 8))

    # 初始刷新状态
    refresh_status()

    # ---------- 配置区: 「网络设置」左、「常规设置」右 (左右分栏, 总宽控制在窗口默认宽 ~1280 内) ----------
    config_area = ttk.Frame(root)
    config_area.pack(fill="x", padx=14, pady=(0, 8))
    config_area.columnconfigure(0, weight=1)   # 左列: 网络设置
    config_area.columnconfigure(1, weight=1)   # 右列: 常规设置

    # ===== 左: 网络设置 (局域网远程访问) =====
    network_frame = ttk.LabelFrame(config_area, text="网络设置 (局域网远程访问)")
    network_frame.grid(row=0, column=0, sticky="nsew", padx=(0, 6))

    ttk.Label(network_frame, text="服务绑定:").grid(row=0, column=0, padx=8, pady=6, sticky="w")
    bind_var = tk.StringVar(value=("局域网 (允许局域网访问 0.0.0.0)"
                                   if app.config.get("dsh_host", "127.0.0.1") == "0.0.0.0"
                                   else "本机 (仅本机访问 127.0.0.1)"))
    bind_choices = ["本机 (仅本机访问 127.0.0.1)", "局域网 (允许局域网访问 0.0.0.0)"]
    bind_combo = ttk.Combobox(network_frame, textvariable=bind_var,
                              values=bind_choices, state="readonly", width=30)
    bind_combo.grid(row=0, column=1, padx=8, pady=6, sticky="w")

    ttk.Label(network_frame, text="受信任主机:").grid(row=1, column=0, padx=8, pady=6, sticky="w")
    trusted_var = tk.StringVar(
        value=", ".join(str(host) for host in app.config.get("trusted_hosts", [])))
    trusted_entry = ttk.Entry(network_frame, textvariable=trusted_var, width=30)
    trusted_entry.grid(row=1, column=1, padx=8, pady=6, sticky="w")

    ttk.Label(network_frame,
              text="受信任主机: 可空, 逗号分隔的 host 或 host:port。\n"
                   "不填=绑定局域网时自动信任全部局域网 IP; 填了任意一个=只信任填写的地址,\n"
                   "不再自动全局域网放行。",
              foreground="#606060", justify="left", wraplength=430).grid(
                  row=2, column=0, columnspan=2, padx=8, pady=(0, 6), sticky="w")

    # ===== 右: 常规设置 =====
    settings_frame = ttk.LabelFrame(config_area, text="常规设置")
    settings_frame.grid(row=0, column=1, sticky="nsew", padx=(6, 0))

    mirror_var = tk.StringVar(value={"auto": "自动 (国内优先, 失败回退官方)",
                                     "cn": "国内 (npmmirror)",
                                     "official": "官方 (npmjs.org)"}.get(app.config["mirror"], "自动"))
    mirror_choices = ["自动 (国内优先, 失败回退官方)", "国内 (npmmirror)", "官方 (npmjs.org)"]
    mirror_combo = ttk.Combobox(settings_frame, textvariable=mirror_var,
                                values=mirror_choices, state="readonly", width=30)
    ttk.Label(settings_frame, text="镜像源:").grid(row=0, column=0, padx=8, pady=6, sticky="w")
    # 常规设置里让「镜像源」与「端口」同一行并列, 善用横向宽度, 压缩纵向高度
    mirror_combo.grid(row=0, column=1, padx=8, pady=6, sticky="w")

    ttk.Label(settings_frame, text="端口:").grid(row=0, column=2, padx=(16, 0), pady=6, sticky="w")
    port_var = tk.StringVar(value=str(app.config["dsh_port"]))
    port_entry = ttk.Entry(settings_frame, textvariable=port_var, width=10)
    port_entry.grid(row=0, column=3, padx=8, pady=6, sticky="w")

    # 默认打开方式: 影响「启动服务后自动打开」与单击按钮时的默认方式 (也可在按钮区单独指定)。
    # 注意: 下拉选项是中文, 初始值必须也用中文标签, 否则选项框显示出英文 desktop/browser 对不上。
    open_method_var = tk.StringVar(
        value=("独立桌面窗口 (内嵌 WebView2)"
               if app.config.get("open_method", "desktop") == "desktop"
               else "网页窗口 (系统浏览器)"))
    ttk.Label(settings_frame, text="默认打开方式:").grid(row=1, column=0, padx=8, pady=6, sticky="w")
    open_method_choices = ["独立桌面窗口 (内嵌 WebView2)", "网页窗口 (系统浏览器)"]
    open_method_combo = ttk.Combobox(settings_frame, textvariable=open_method_var,
                                     values=open_method_choices, state="readonly", width=30)
    open_method_combo.grid(row=1, column=1, padx=8, pady=6, sticky="w")

    auto_open_var = tk.BooleanVar(value=bool(app.config.get("auto_open_browser", True)))
    ttk.Checkbutton(settings_frame,
                    text="启动服务后自动打开界面 (按默认方式打开, 已打开则不重复开新页)",
                    variable=auto_open_var).grid(row=2, column=0, columnspan=4,
                                                 padx=8, pady=4, sticky="w")

    def sync_gui(silent=False):
        """把界面当前填入的值("所见")同步进 config 并落盘("所得")。

        统一了「保存设置 / 启动服务前 / 安装下载前」三处的同步逻辑, 保证
        "界面上看到的值就是实际在用的值"——用户改了没点保存, 启动或安装时
        也会按最新输入自动落盘后再操作。

        silent=True (启动/安装前的自动同步): 端口非法时只记警告不阻断(沿用旧端口),
        不弹对话框; 否则(手动保存)端口非法弹错误框并返回 False 中止。
        """
        try:
            raw_port = port_var.get().strip()
            new_port = int(raw_port) if raw_port else None
            if new_port is not None and not (1 <= new_port <= 65535):
                raise ValueError("端口范围 1-65535")
            if new_port is not None:
                app.config["dsh_port"] = new_port
        except ValueError as error:
            if not silent:
                messagebox.showerror("设置错误", "端口无效: %s" % error)
                return False
            append_log("[警告] 端口无效, 本次未改动端口: %s" % error)
        # 网络设置: 服务绑定 (仅允许 127.0.0.1 / 0.0.0.0) + 受信任主机 (逗号/空白分隔, 去空)
        app.config["dsh_host"] = ("0.0.0.0" if "局域网" in bind_var.get() else "127.0.0.1")
        trusted_list = []
        for item in trusted_var.get().replace("，", ",").split(","):
            item = item.strip()
            if item:
                trusted_list.append(item)
        app.config["trusted_hosts"] = trusted_list
        # 常规设置: 镜像源 / 默认打开方式 / 自动打开 / 背景视频目录
        raw = mirror_var.get()
        app.config["mirror"] = "cn" if "国内" in raw else ("official" if "官方" in raw else "auto")
        open_raw = open_method_var.get()
        app.config["open_method"] = ("desktop" if "桌面" in open_raw else "browser")
        app.config["auto_open_browser"] = bool(auto_open_var.get())
        app.save_config()
        return True

    def on_save():
        """手动「保存设置」: 同步两块并将结果落盘"""
        if sync_gui(silent=False):
            messagebox.showinfo("设置已保存", "配置已保存。下次启动服务时生效。")

    # ===== 保存设置 (「网络设置」与「常规设置」共同, 放在两块下方统一提交) =====
    settings_action = ttk.Frame(root)
    settings_action.pack(fill="x", padx=14, pady=(0, 8))
    ttk.Label(settings_action, text="改动后即使不点保存, 启动服务或安装下载时也会自动按最新填入值落盘生效",
              foreground="#606060").pack(side="left", padx=8)
    ttk.Button(settings_action, text="保存设置", command=on_save).pack(side="right", padx=8)

    # ---------- 日志文本框 ----------
    log_frame = ttk.LabelFrame(root, text="运行日志")
    log_frame.pack(fill="both", expand=True, padx=14, pady=(0, 12))

    # 内容多的运行日志需要用滚动条上下翻看 (消息多了自动换行成很长的滚动区,
    # 不加速滚动的话只能靠鼠标滚轮, 回看早期输出很费劲)。
    log_inner = ttk.Frame(log_frame)
    log_inner.pack(fill="both", expand=True, padx=6, pady=6)
    # Text 与滚动条互相引用, 需先建控件、再双向绑定命令 (见下方 config)
    log_scrollbar = ttk.Scrollbar(log_inner, orient="vertical")
    log_text = tk.Text(log_inner, height=14, state="disabled",
                       font=("Consolas", 9), wrap="word",
                       yscrollcommand=log_scrollbar.set)
    log_scrollbar.config(command=log_text.yview)   # 拖滚动条 → 文本上下滚动
    log_scrollbar.pack(side="right", fill="y")
    log_text.pack(side="left", fill="both", expand=True)

    # ---------- 关闭窗口时选择: 退出 / 最小化到托盘 / 取消 ----------
    def ask_close_choice():
        """关闭时弹三选一对话框 (模态), 返回:
        "exit" 退出并停止服务; "tray" 最小化到托盘(服务继续); None 取消。
        这样"不关服务"时托盘/任务栏入口仍在, 可随时恢复, 与本项目期望一致。
        """
        choice = {"value": None}

        def choose(value):
            choice["value"] = value
            dialog.destroy()

        dialog = tk.Toplevel(root)
        dialog.title("确认关闭")
        dialog.transient(root)
        dialog.grab_set()          # 模态: 关闭操作期间主窗口不响应
        dialog.resizable(False, False)

        label_frame = ttk.Frame(dialog, padding=14)
        label_frame.pack(fill="x")
        ttk.Label(label_frame, justify="left", text=(
            "请选择关闭方式:\n\n"
            "退出并停止服务   —— 关闭启动器, 同时停止 dsh 服务。\n"
            "最小化到托盘     —— dsh 服务继续运行, 可随时从\n"
            "                     任务栏或托盘图标恢复窗口。\n"
            "取消             —— 什么都不做, 继续使用。")).pack(anchor="w")

        button_row = ttk.Frame(dialog, padding=14)
        button_row.pack(fill="x")
        ttk.Button(button_row, text="取消",
                   command=lambda: choose(None)).pack(side="right")
        ttk.Button(button_row, text="最小化到托盘(服务继续)",
                   command=lambda: choose("tray")).pack(side="right", padx=8)
        ttk.Button(button_row, text="退出并停止服务",
                   command=lambda: choose("exit")).pack(side="right")

        # 居中于主窗口
        dialog.update_idletasks()
        pos_x = root.winfo_x() + (root.winfo_width() - dialog.winfo_reqwidth()) // 2
        pos_y = root.winfo_y() + (root.winfo_height() - dialog.winfo_reqheight()) // 2
        dialog.geometry("+%d+%d" % (pos_x, pos_y))

        root.wait_window(dialog)
        return choice["value"]

    def on_close(confirm=True):
        """按 X 关闭窗口: 先弹三选一, 避免误关
        - 退出并停止服务: 移除托盘 + 停止服务 + 退出;
        - 最小化到托盘: dsh 服务继续运行, 保留任务栏/托盘入口可恢复;
        - 取消: 保持现状。
        :param confirm: True 为普通手动关闭 (按 X); False 用于绿色版自更新流程
                        (此前已确认过, 不再重复询问, 直接退出)。
        """
        if confirm:
            close_choice = ask_close_choice()
            if close_choice == "tray":
                minimize_to_tray()   # 服务继续运行, 任务栏/托盘入口保留
                return
            if close_choice is None:   # 取消
                return
            # close_choice == "exit" → 继续往下执行退出
        status_text.set("正在退出并停止服务 ...")
        tray_icon.dispose()   # 先移除托盘图标并还原窗口过程, 避免残留
        app.on_exit()
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)

    # ---------- 托盘标志轮询 ----------
    def poll_tray_loop():
        """定时轮询托盘待办标志 (2026-08-16):
        WndProc 回调里只置位 _minimize_pending/_restore_pending, 不直接碰 Tk;
        这里在正常的 Tk 事件上下文里执行最小化/恢复, 彻底避开 WndProc 重入 Tcl。
        """
        tray_icon.poll()
        root.after(80, poll_tray_loop)
    root.after(80, poll_tray_loop)

    append_log("DeepSeek Harness 绿色整合版启动器已启动, 点击 [安装环境] 或直接 [启动服务] 开始。")
    root.mainloop()


# ---------------------------------------------------------------------------
# 命令行模式入口
# ---------------------------------------------------------------------------
def main():
    args = sys.argv[1:]
    if "--stop" in args:
        app = Launcher()
        app.on_log = lambda message: print(message)   # 命令行模式把日志打印到终端
        app.stop_server()
        return 0
    if "--start" in args:
        app = Launcher()
        app.on_log = lambda message: print(message)   # 命令行模式把日志打印到终端
        try:
            app.run_post_update_bundled_sync()   # 绿色版更新后自动同步一次内置插件
            started = app.start_server(open_browser=False)   # 启动(或复用已运行)服务
            app._ensure_ui_beacon_server()
            port = int(app.config.get("dsh_port", 3080))
            if app.wait_ready(port):
                print("服务已就绪: http://127.0.0.1:%d" % port)
                if app.config.get("dsh_host", "127.0.0.1") == "0.0.0.0":
                    for lan_ip in app.lan_addresses():
                        print("局域网访问地址: http://%s:%d (其他电脑浏览器打开)" % (lan_ip, port))
                if app.config.get("auto_open_browser", True):
                    app.open_ui(force=False)   # 按默认打开方式(桌面窗口/网页窗口)打开
            # 守护模式: 保持本进程存活以维持服务子进程的 stdin 管道打开,
            # 否则 dsh 会因读到 stdin EOF 而退出。服务退出后本进程随之返回。
            if started and app.server_process is not None:
                print("服务运行中。停止服务: python launcher.py --stop 或关闭本窗口")
                while app.server_process.poll() is None:
                    time.sleep(1)
                print("服务进程已退出 (退出码: %s)。" % app.server_process.returncode)
            return 0
        except Exception as error:
            print("启动失败: %s" % error)
            return 1
    if "--purge-session" in args:
        app = Launcher()
        app.on_log = lambda message: print(message)   # 命令行模式把日志打印到终端
        try:
            index = args.index("--purge-session")
            session_id = args[index + 1] if index + 1 < len(args) else ""
            session_id = (session_id or "").strip()
            if not session_id:
                print("用法: python launcher.py --purge-session <会话ID>")
                return 2
            if app.is_server_running():
                print("服务正在运行, 请先停止服务: python launcher.py --stop")
                return 1
            return 0 if app.purge_session(session_id) else 1
        except Exception as error:
            print("永久删除失败: %s" % error)
            return 1
    if "--purge-archived" in args:
        app = Launcher()
        app.on_log = lambda message: print(message)   # 命令行模式把日志打印到终端
        try:
            if app.is_server_running():
                print("服务正在运行, 请先停止服务: python launcher.py --stop")
                return 1
            deleted, missing = app.purge_archived_sessions()
            print("归档会话清理完成: 删除 %d 个, 未找到日志 %d 个" % (deleted, missing))
            return 0
        except Exception as error:
            print("清理归档失败: %s" % error)
            return 1
    if "--restore-session" in args:
        app = Launcher()
        app.on_log = lambda message: print(message)   # 命令行模式把日志打印到终端
        try:
            index = args.index("--restore-session")
            session_id = args[index + 1] if index + 1 < len(args) else ""
            session_id = (session_id or "").strip()
            if not session_id:
                print("用法: python launcher.py --restore-session <会话ID>")
                return 2
            if app.is_server_running():
                print("服务正在运行, 请先停止服务: python launcher.py --stop")
                return 1
            return 0 if app.restore_session(session_id) else 1
        except Exception as error:
            print("复原会话失败: %s" % error)
            return 1
    if "--install-plugin" in args or "--remove-plugin" in args:
        app = Launcher()
        app.on_log = lambda message: print(message)   # 命令行模式把日志打印到终端
        try:
            if "--install-plugin" in args:
                index = args.index("--install-plugin")
                spec = args[index + 1] if index + 1 < len(args) else ""
                spec = (spec or "").strip()
                if not spec:
                    print("用法: python launcher.py --install-plugin <本地插件目录或npm包名>")
                    return 2
                if app.is_server_running():
                    print("提示: 服务正在运行, 插件将在重启服务后生效。")
                # 本地目录: 归一化为 file: 形式的绝对路径 (pnpm 可识别), 不改动目录本身
                if os.path.isdir(spec):
                    spec = "file:" + os.path.abspath(spec).replace("\\", "/")
                app.install_plugin(spec)
                print("插件已安装: %s (重启服务后生效)" % spec)
                return 0
            else:
                index = args.index("--remove-plugin")
                package_name = args[index + 1] if index + 1 < len(args) else ""
                package_name = (package_name or "").strip()
                if not package_name:
                    print("用法: python launcher.py --remove-plugin <包名>")
                    return 2
                if app.is_server_running():
                    print("提示: 服务正在运行, 插件移除将在重启服务后生效。")
                app.remove_plugin(package_name)
                print("插件已移除: %s" % package_name)
                return 0
        except Exception as error:
            print("插件操作失败: %s" % error)
            return 1
    # 默认: 图形界面
    run_gui()
    return 0


if __name__ == "__main__":
    sys.exit(main())
