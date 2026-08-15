# -*- coding: utf-8 -*-
"""
DeepSeek Harness 一键启动器 (Python 标准库实现, 无第三方依赖)

作用:
    1. 自动检测 / 下载便携版 Node.js 到 runtime/node
    2. 自动在 runtime/dsh 下本地安装 @deepseek-ai/dsh 包
    3. 启动 dsh web 本地服务, 并自动打开浏览器 (界面已在浏览器中打开则不重复开新页)
    4. 提供 tkinter 图形界面 (启动 / 停止 / 打开界面 / 日志)
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

# 默认配置 (用户可在 config.json 中覆盖)
DEFAULT_CONFIG = {
    "mirror": "auto",            # 镜像: auto=自动检测 / cn=国内 / official=官方
    "node_version": "22.20.0",   # 便携 Node 版本号
    "python_version": "3.10.20", # 内置便携 Python 版本号 (python-build-standalone)
    "python_release": "20260807",# python-build-standalone 发布标签(日期)
    "dsh_port": 3080,            # dsh web 服务端口
    "dsh_package": "@deepseek-ai/dsh",   # dsh 包名
    # 启动服务后是否自动打开 WebUI 浏览器页面 (False 则只启动服务, 需手动点「打开界面」)
    "auto_open_browser": True,
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
# 该检查只约束自动打开 (启动服务后自动开页 / 命令行 --start 自动开页);
# 手动点 GUI「打开界面」不受此限制, 必定打开新页面 (open_ui(force=True))。
# dsh 升级重装后由 patch_frontend() 自动重新注入 (见 install_dsh 末尾)。
# ---------------------------------------------------------------------------
UI_BEACON_PORT = 3081            # 心跳上报端口 (config.json 的 ui_beacon_port 可覆盖)
UI_BEACON_PING_INTERVAL = 15     # 页面心跳上报间隔 (秒)
UI_ALIVE_WINDOW = 180            # 最近 N 秒内有心跳即视为界面已打开 (容忍后台标签页定时器节流)
UI_BEACON_PATH = "/__dsh_ui_alive"            # 心跳上报路径
UI_BEACON_TOKEN_FILE = os.path.join(RUNTIME_DIR, "ui-beacon.token")   # 心跳令牌文件 (防伪造上报)
UI_BEACON_MARKER_START = "<!-- dsh-launcher-ui-beacon:start -->"     # 注入标记(起)
UI_BEACON_MARKER_END = "<!-- dsh-launcher-ui-beacon:end -->"         # 注入标记(止)

# GitHub 官方 dsh 插件话题页 (插件发现入口, 仅作辅助来源; 国内网络可能无法直连)
GITHUB_TOPIC_URL = "https://github.com/topics/dsh-plugin"

# ---------------------------------------------------------------------------
# 绿色版外围更新通道 (本项目自己的 GitHub Release)
# 与官方核心更新(update_dsh, 动 runtime/dsh)完全独立: 本通道只更新项目根目录的外围文件,
# 绝不触碰 runtime/(用户数据与已装环境), 也不替换用户自定义的 config.json。
# 发布流程: 打 tag v{GREEN_VERSION} + Release 资产 DSH_Launcher_GreenPortable_Online_<日期>_v<tag>.zip
# ---------------------------------------------------------------------------
GITHUB_REPO = "LiuJunheng/DeepSeekHarnessGreen"    # 本绿色版仓库 (owner/repo)
GREEN_VERSION = "1.0.3"                            # 绿色版版本号 (与 Release tag 一致, 不含 v 前缀)
GREEN_VERSION_DATE = "2026年08月15日"               # 绿色版版本日期
GREEN_RELEASE_API = ("https://api.github.com/repos/%s/releases/latest"
                     % GITHUB_REPO)                # GitHub 官方 Releases API
GREEN_RELEASE_MIRROR = ("https://mirror.nju.edu.cn/github-release/%s/latest"
                        % GITHUB_REPO)             # 国内镜像 (与其它下载源镜像一致)
GREEN_ZIP_PREFIX = "DSH_Launcher_GreenPortable_Online_"   # Release 分发 zip 资产名前缀

# npm 上已核实的一批 dsh 插件 (供「加载推荐」一键展示, 保证即使搜索/网络异常也能看到可安装项)
# version 留空表示安装时自动取 npm 最新版; 来源标记为 "推荐"
RECOMMENDED_PLUGINS = [
    {"name": "@dsh-external/dsh-vision-toolkit", "version": "", "source": "推荐",
     "description": "视觉工具箱: 图片问答 / OCR / UI 截图测试等"},
    {"name": "dsh-find-plugin", "version": "", "source": "推荐",
     "description": "在 agent 内部查找 DeepSeek Harness 插件"},
    {"name": "dsh-remote", "version": "", "source": "推荐",
     "description": "远程工作助手: 通过 SSH / 隧道连接远程环境"},
    {"name": "dsh-clawrouter", "version": "", "source": "推荐",
     "description": "第二大脑: 智能路由工具调用的增强插件"},
    {"name": "dsh-better-sidebar", "version": "", "source": "推荐",
     "description": "web 插件: 类似 VSCode 的右侧边栏"},
    {"name": "dsh-lark-bot", "version": "", "source": "推荐",
     "description": "把 dsh 接入飞书 / Lark 机器人"},
    {"name": "dsh-email", "version": "", "source": "推荐",
     "description": "IMAP/SMTP 邮件工具: 收发邮件能力"},
    {"name": "dsh-safe-delete", "version": "", "source": "推荐",
     "description": "安全删除: 文件移入回收站而不是直接删除"},
    {"name": "dsh-web-plugin-manager", "version": "", "source": "推荐",
     "description": "在 Web 界面管理 dsh 插件"},
    {"name": "dsh-tui", "version": "", "source": "推荐",
     "description": "终端界面 (TUI) 客户端"},
    {"name": "dsh-plugin-greeter", "version": "", "source": "推荐",
     "description": "示例插件: 打招呼, 适合学习插件开发"},
    {"name": "dsh-dynamic-island", "version": "", "source": "推荐",
     "description": "灵动岛风格 UI 插件"},
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
GREEN_UPDATE_DIR = os.path.join(RUNTIME_DIR, "update")      # 绿色版更新暂存目录 (zip/解压/备份/bat)
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
        注意: 当前进程可能正由系统 Python 运行, 这里补齐的是"下次启动"用的内置解释器"""
        if self.find_python_exe() is not None:
            return
        python_version = self.config.get("python_version", "3.10.20")
        python_release = self.config.get("python_release", "20260807")
        self.log("未检测到内置便携 Python, 开始自动下载 (版本 %s, 完整版自带 tkinter) ..."
                 % python_version)
        os.makedirs(PYTHON_DIR, exist_ok=True)
        archive_name = PYTHON_ARCHIVE_TEMPLATE.format(
            version=python_version, release=python_release)
        archive_path = os.path.join(RUNTIME_DIR, archive_name)
        # 依次尝试 国内镜像 -> GitHub (自动模式), 或仅尝试指定源
        source_order = ["cn", "official"] if self.resolve_mirror()[1] else [self.resolve_mirror()[0]]
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
                    tar_handle.extractall(PYTHON_DIR)
                if os.path.exists(archive_path):
                    os.remove(archive_path)      # 清理压缩包
                python_exe = self.find_python_exe()
                if python_exe is not None:
                    self.log("内置便携 Python 就绪: %s" % python_exe)
                    return
                raise RuntimeError("解压后未找到 python.exe")
            except Exception as error:
                last_error = error
                self.log("从 [%s] 下载失败: %s" % (source, error))
                if os.path.exists(archive_path):
                    os.remove(archive_path)
        self.log("便携 Python 自动下载失败: %s (可在 start.bat 里仍使用系统 Python, 或手动放入 runtime/python)"
                 % last_error)

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

    def install_dsh(self):
        """执行 dsh 的 npm 安装 (仅负责安装, 不判断是否已存在)
        返回 True 表示安装成功; 供 prepare_dsh 首次安装与 update_dsh 更新时复用"""
        self.log("开始安装 %s ..." % self.config["dsh_package"])
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
        ]
        if npm_cli is not None and node_exe is not None:
            self.log("使用便携 Node 自带的 npm 进行安装")
            command = [node_exe, npm_cli, "install"] + install_options + [
                self.config["dsh_package"]]
        else:
            self.log("使用系统 npm 进行安装 (请确保已安装 Node.js)")
            command = ["npm", "install"] + install_options + [
                self.config["dsh_package"]]

        # 根据镜像配置附加 registry 参数
        mirror, is_auto = self.resolve_mirror()
        if not is_auto:
            registry = NPM_REGISTRY[mirror]
            command.append("--registry=%s" % registry)
            self.log("使用镜像源: %s" % registry)

        env = self.build_env()
        self.log("正在安装 dsh (首次安装可能需要几分钟, 请耐心等待) ...")
        result = subprocess.run(command, cwd=DSH_DIR, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace")
        output = (result.stdout or "").strip()
        for line in output.splitlines()[-15:]:          # 只展示最后 15 行, 避免刷屏
            if line.strip():
                self.log("npm: %s" % line.strip())

        if result.returncode != 0 or not self.dsh_installed():
            raise RuntimeError("dsh 安装失败, 请检查网络后重试 (详见上方 npm 输出)")

        self.log("dsh 安装成功 (版本: %s)" % self.dsh_version())
        self.patch_frontend()   # 安装/升级后注入 WebUI 心跳脚本 (单页面去重)
        return True

    def prepare_dsh(self, force=False):
        """确保 dsh 已本地安装, 缺失则自动 npm install
        参数 force: True 时即使已安装也强制重装 (用于「更新」场景)"""
        if not force and self.dsh_installed():
            self.log("dsh 已就绪: %s" % os.path.join(DSH_DIR, DSH_BIN_JS))
            return True
        if force:
            self.log("检测到强制更新, 开始重装 dsh ...")
        else:
            self.log("未检测到 dsh, 开始自动安装 %s ..." % self.config["dsh_package"])
        return self.install_dsh()

    def dsh_latest_version(self):
        """查询 npm 上 @deepseek-ai/dsh 的最新版本号 (只读, 不改动本地)
        查询失败返回 None"""
        npm_cli = self.find_npm_cli()
        node_exe = self.find_node_exe()
        if npm_cli is None or node_exe is None:
            self.log("未找到便携 Node, 无法查询最新版本")
            return None
        command = [node_exe, npm_cli, "view", self.config["dsh_package"], "version"]
        # 根据镜像配置附加 registry 参数 (与安装一致)
        mirror, is_auto = self.resolve_mirror()
        if not is_auto:
            command.append("--registry=%s" % NPM_REGISTRY[mirror])
        env = self.build_env()
        try:
            self.log("正在查询 dsh 最新版本 ...")
            result = subprocess.run(command, cwd=DSH_DIR, env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, encoding="utf-8", errors="replace",
                                    timeout=60)
            latest = (result.stdout or "").strip().splitlines()[-1].strip()
            if latest and result.returncode == 0:
                self.log("npm 上最新版本: %s" % latest)
                return latest
            self.log("查询失败, npm 输出: %s" % (result.stdout or result.stderr or ""))
            return None
        except Exception as error:
            self.log("查询最新版本失败: %s" % error)
            return None

    def backup_dsh(self):
        """把当前已安装的 dsh 目录备份到 runtime/dsh-backup-<版本> 下
        返回备份目录绝对路径; 若当前未安装 dsh 返回 None"""
        if not self.dsh_installed():
            return None
        version = self.dsh_version()
        backup_dir = os.path.join(RUNTIME_DIR, "dsh-backup-%s" % version)
        if os.path.exists(backup_dir):
            backup_dir = os.path.join(
                RUNTIME_DIR, "dsh-backup-%s-%s" % (version,
                                                   time.strftime("%Y%m%d%H%M%S")))
        self.log("正在备份旧版本 dsh (%s) ..." % version)
        try:
            shutil.copytree(DSH_DIR, backup_dir)
            self.log("备份完成: %s" % backup_dir)
            return backup_dir
        except Exception as error:
            self.log("备份失败: %s" % error)
            return None

    def update_dsh(self):
        """更新 dsh 到最新版: 先备份旧版, 再强制重装最新版
        返回更新后的版本号; 失败抛出异常"""
        latest = self.dsh_latest_version()
        if latest is None:
            raise RuntimeError("无法获取最新版本号, 更新已取消")
        self.log("当前版本: %s, 将更新到: %s" % (self.dsh_version(), latest))
        backup_dir = self.backup_dsh()
        if backup_dir is None:
            raise RuntimeError("备份旧版本失败, 已取消更新 (避免数据丢失)")
        # 备份成功后, 强制重装最新版 (prepare_dsh 的 force 会跳过已存在检查)
        self.prepare_dsh(force=True)
        self.log("更新完成, 当前版本: %s" % self.dsh_version())
        self.log("旧版本备份在: %s (可手动删除)" % backup_dir)
        return self.dsh_version()

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
        """查询本项目 GitHub 最新 Release 信息 (只读, 不改动本地)。
        先试官方 api.github.com, 失败自动降级国内镜像; 全部失败返回 None。
        返回 dict: tag_name / name / body / published_at / assets"""
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
                    return release_info
                self.log("该地址返回的 Release 为空: %s" % url)
            except Exception as error:
                self.log("查询 Release 失败 [%s]: %s" % (url, error))
        return None

    def green_release_version(self, release_info):
        """从 Release 信息取版本号 (去掉 tag 的 v 前缀, 如 v1.0.1 -> 1.0.1)"""
        tag = release_info.get("tag_name") or ""
        return tag[1:] if tag.startswith("v") else tag

    def green_find_zip_asset(self, release_info):
        """从 Release assets 里匹配绿色版分发 zip 资产。
        返回元组 (资产名, 下载URL, 文件大小), 找不到返回 None"""
        assets = release_info.get("assets") or []
        for asset in assets:
            asset_name = asset.get("name") or ""
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

    def prepare_green_update(self, new_zip_path):
        """准备覆盖安装: 解压分发 zip 到 runtime/update/extracted, 检测内容根目录,
        生成 update_apply.bat (由启动器在退出后执行覆盖)。
        返回元组 (内容根目录, bat 路径); 失败抛异常"""
        update_dir = GREEN_UPDATE_DIR
        os.makedirs(update_dir, exist_ok=True)
        # 1. 解压 (先清空旧的解压目录, 避免残留旧文件)
        extracted_dir = os.path.join(update_dir, "extracted")
        if os.path.exists(extracted_dir):
            shutil.rmtree(extracted_dir, ignore_errors=True)
        os.makedirs(extracted_dir, exist_ok=True)
        self.log("正在解压更新包到 %s ..." % extracted_dir)
        self._safe_extract_zip(new_zip_path, extracted_dir)
        # 2. 检测内容根目录 (兼容带/不带一层外层文件夹两种 zip 形态)
        content_root = self._detect_zip_content_root(extracted_dir)
        self.log("更新内容根目录: %s" % content_root)
        # 3. 生成覆盖安装脚本 (纯 ASCII + CRLF, 遵循 .bat 规范)
        bat_path = os.path.join(update_dir, "update_apply.bat")
        self._write_update_bat(bat_path, content_root)
        self.log("覆盖安装脚本已生成: %s" % bat_path)
        return content_root, bat_path

    def _write_update_bat(self, bat_path, content_root):
        """生成 update_apply.bat (纯 ASCII + CRLF, 避免 Windows cmd 编码问题)。
        脚本在启动器完全退出后执行: 等待进程退出 -> 备份旧文件 -> robocopy 覆盖 ->
        跳过 config.json(用户配置) 与 runtime/(用户数据/已装环境) -> 重新启动新版"""
        relaunch_flag = "bat" if not self._is_frozen() else "exe"
        bat_lines = [
            # (启动器 PID 由 launch_update_script 以命令行参数传入, 目前不再用于等待(见 step 1))
            "@echo off",
            "rem ============================================================",
            "rem  DeepSeek Harness Green Edition Overlay Installer",
            "rem  Generated automatically, do NOT edit.",
            "rem  Run after the launcher fully exits: backup -> overwrite -> relaunch.",
            "rem  Args: %1=launcher PID(unused, kept for compat)  %2=content root",
            "rem        %3=program root  %4=relaunch mode (bat|exe)",
            "rem ============================================================",
            "title DeepSeek Harness Green Update",
            "set \"LAUNCHER_PID=%~1\"",
            "set \"CONTENT_DIR=%~2\"",
            "set \"BASE_DIR=%~3\"",
            "set \"REL=%~4\"",
            "",
            "rem ---- 1. wait for launcher to exit and release file locks ----",
            "rem (poll the exe lock via rename trick.  DO NOT poll the PID: once the",
            "rem  launcher exits its PID is freed and may be REUSED by another process,",
            "rem  so tasklist would match forever -> infinite wait.  The exe file lock",
            "rem  is exactly what blocks the overwrite, so polling it is both reliable",
            "rem  and fast.  Use top-level labels only, no goto inside parens blocks.)",
            "rem     running as .exe:  poll until DSH_Launcher.exe can be renamed",
            "rem     running as .py:    no lock to poll, just sleep a moment",
            "if not exist \"%BASE_DIR%\\DSH_Launcher.exe\" goto :script_sleep",
            "set /a TRIES=0",
            ":wait_unlock",
            "set /a TRIES+=1",
            "if %TRIES% GEQ 60 goto :script_sleep",
            "ren \"%BASE_DIR%\\DSH_Launcher.exe\" \"%BASE_DIR%\\.DSH_Launcher.exe.upd\" 2>nul",
            "if errorlevel 1 goto :still_locked",
            "rem unlock detected: restore the original name immediately",
            "ren \"%BASE_DIR%\\.DSH_Launcher.exe.upd\" \"%BASE_DIR%\\DSH_Launcher.exe\" 2>nul",
            "goto :after_wait",
            ":still_locked",
            "rem (ping sleep: timeout needs a console and fails in detached mode)",
            "ping -n 2 127.0.0.1 >nul",
            "goto :wait_unlock",
            ":script_sleep",
            "rem give the launcher a moment to exit and release handles",
            "ping -n 4 127.0.0.1 >nul",
            ":after_wait",
            "rem crash-safety: remove any leftover rename marker",
            "if exist \"%BASE_DIR%\\.DSH_Launcher.exe.upd\" del /q \"%BASE_DIR%\\.DSH_Launcher.exe.upd\"",
            "",
            "rem ---- 2. backup old files that will be replaced to runtime\\update\\backup ----",
            "set \"BACKUP_DIR=%~dp0backup\"",
            "if not exist \"%BACKUP_DIR%\" mkdir \"%BACKUP_DIR%\"",
            "if exist \"%BASE_DIR%\\launcher.py\" copy /y \"%BASE_DIR%\\launcher.py\" \"%BACKUP_DIR%\\launcher.py\" >nul 2>&1",
            "if exist \"%BASE_DIR%\\DSH_Launcher.exe\" copy /y \"%BASE_DIR%\\DSH_Launcher.exe\" \"%BACKUP_DIR%\\DSH_Launcher.exe\" >nul 2>&1",
            "if exist \"%BASE_DIR%\\start.bat\" copy /y \"%BASE_DIR%\\start.bat\" \"%BACKUP_DIR%\\start.bat\" >nul 2>&1",
            "if exist \"%BASE_DIR%\\stop.bat\" copy /y \"%BASE_DIR%\\stop.bat\" \"%BACKUP_DIR%\\stop.bat\" >nul 2>&1",
            "if exist \"%BASE_DIR%\\config.json\" copy /y \"%BASE_DIR%\\config.json\" \"%BACKUP_DIR%\\config.json\" >nul 2>&1",
            "",
            "rem ---- 3. overlay: copy new content into program root ----",
            "rem     skip config.json (keep user config) and runtime/.git (user data/repo)",
            "robocopy \"%CONTENT_DIR%\" \"%BASE_DIR%\" /E /XF config.json /XD runtime .git /NFL /NDL /NJH /NJS /NP >nul",
            "set \"RC=%ERRORLEVEL%\"",
            "if %RC% GEQ 8 goto :failed",
            "",
            "rem ---- 4. relaunch the new launcher (guard: only if target exists) ----",
            "rem (start on a missing file pops an error dialog and blocks cmd forever)",
            "if /i \"%REL%\"==\"bat\" (",
            "  if exist \"%BASE_DIR%\\start.bat\" start \"\" \"%BASE_DIR%\\start.bat\"",
            ") else (",
            "  if exist \"%BASE_DIR%\\DSH_Launcher.exe\" start \"\" \"%BASE_DIR%\\DSH_Launcher.exe\"",
            ")",
            "echo Update done.",
            "exit /b 0",
            "",
            ":failed",
            "echo Update failed (robocopy errorlevel %RC%). Backup kept in %BACKUP_DIR%.",
            "exit /b 1",
        ]
        bat_text = "\r\n".join(bat_lines) + "\r\n"
        with open(bat_path, "w", encoding="ascii", newline="") as file_handle:
            file_handle.write(bat_text)

    def launch_update_script(self, bat_path, content_root):
        """以分离进程方式启动覆盖安装脚本, 使其脱离启动器进程树:
        启动器随后退出, 该 bat 仍能存活并完成文件覆盖 (解决 exe/py 被锁定无法自替换的问题)"""
        if sys.platform == "win32":
            creation_flags = (subprocess.DETACHED_PROCESS |
                              subprocess.CREATE_NEW_PROCESS_GROUP)
            relaunch_flag = "bat" if not self._is_frozen() else "exe"
            command_line = ["cmd.exe", "/c", bat_path,
                            str(os.getpid()), content_root, BASE_DIR, relaunch_flag]
        else:
            # 非 Windows: 用 nohup 分离进程 (绿色便携主要面向 Windows, 这里做兜底)
            command_line = ["sh", "-c",
                            '"%s" "%s" "%s" "%s" >/dev/null 2>&1 &' % (
                                bat_path, os.getpid(), content_root, BASE_DIR)]
            creation_flags = 0
        self.log("正在启动覆盖安装脚本 (启动器即将退出) ...")
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
        result = subprocess.run(command, cwd=DSH_DIR, env=self.build_env(),
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, encoding="utf-8", errors="replace",
                                timeout=300)
        output = (result.stdout or "").strip()
        for line in output.splitlines()[-15:]:          # 只展示最后 15 行, 避免刷屏
            if line.strip():
                self.log("npm: %s" % line.strip())
        if result.returncode != 0 or not self.pnpm_installed():
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
                result = subprocess.run(command, cwd=BASE_DIR, env=self.build_env(),
                                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                        text=True, encoding="utf-8", errors="replace",
                                        timeout=600)
            except subprocess.TimeoutExpired:
                raise RuntimeError("插件命令执行超时 (超过 10 分钟), 请检查网络后重试")
            output = (result.stdout or "").strip()
            for line in output.splitlines()[-20:]:          # 只展示最后 20 行, 避免刷屏
                if line.strip():
                    self.log("plugin: %s" % line.strip())
            return result.returncode, output

        # 先清一遍存量 package.json 的 BOM (历史遗留或重装时可能带 BOM)
        self.strip_bom_from_profile_packages(profile)
        exit_code, output = execute_once()
        if exit_code != 0:
            # 本次 pnpm 刚下载的包可能带 BOM 导致 dsh JSON.parse 崩溃;
            # 清掉 BOM 后重试一次 (pnpm 幂等, 不重复下载, 很快完成)
            self.strip_bom_from_profile_packages(profile)
            exit_code, output = execute_once()
        return exit_code, output

    def install_plugin(self, package_spec, profile=DEFAULT_PROFILE):
        """安装插件到指定 profile (转发给 pnpm add), 失败抛异常"""
        arguments = ["add", package_spec]
        mirror, is_auto = self.resolve_mirror()
        if not is_auto:
            arguments.append("--registry=%s" % NPM_REGISTRY[mirror])
        self.log("开始安装插件: %s (profile: %s) ..." % (package_spec, profile))
        exit_code, _output = self.run_plugin_command(profile, arguments)
        if exit_code != 0:
            raise RuntimeError("插件安装失败 (退出码 %s), 请查看上方日志" % exit_code)
        self.log("插件安装成功: %s" % package_spec)
        return True

    def remove_plugin(self, package_name, profile=DEFAULT_PROFILE):
        """从指定 profile 移除插件 (转发给 pnpm remove), 失败抛异常"""
        self.log("开始移除插件: %s (profile: %s) ..." % (package_name, profile))
        exit_code, _output = self.run_plugin_command(profile, ["remove", package_name])
        if exit_code != 0:
            raise RuntimeError("插件移除失败 (退出码 %s), 请查看上方日志" % exit_code)
        self.log("插件移除成功: %s" % package_name)
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
        """一键准备全部环境 (内置 Python + Node + dsh), 供启动前调用"""
        self.ensure_runtime_dirs()
        self.seed_default_workspace()
        self.prepare_python()
        self.prepare_node()
        self.prepare_dsh()
        self.log("环境准备完成, 可以启动服务")

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
        return [node_exe, dsh_js, "web", "--port", str(port)]

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
        绑定 127.0.0.1:<ui_beacon_port>, 端口被占用时仅记日志并禁用去重"""
        if self._beacon_server is not None:
            return True
        port = int(self.config.get("ui_beacon_port", UI_BEACON_PORT))
        try:
            handler_class = UiBeaconHandler
            handler_class.token = self._ui_beacon_token()
            handler_class.on_ping = self._record_ui_ping
            server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler_class)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self._beacon_server = server
            self.log("WebUI 心跳服务已启动 (127.0.0.1:%d), 用于检测界面是否已打开" % port)
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
            "    var endpoint = \"http://127.0.0.1:%d%s?t=%s\";\n"
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

    def start_server(self, open_browser=True):
        """启动 dsh web 服务, 可选自动打开浏览器"""
        if self.is_server_running():
            self.log("服务已在运行中, 无需重复启动")
            if open_browser:
                self.open_ui()
            return True

        self._ensure_ui_beacon_server()   # 先启动心跳服务, 使已打开页面的上报能尽早被记录
        self.log("正在准备环境 ...")
        self.prepare_all()
        self.patch_frontend()             # 确保前端已注入心跳脚本 (dsh 升级重装后自动补齐)

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
            if open_browser:
                if self.ui_is_open():
                    self.log("检测到 WebUI 已在浏览器中打开, 不再重复打开新页面 (可点「打开界面」手动打开)")
                else:
                    self.log("正在打开浏览器 ...")
                    webbrowser.open(url)

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

    def open_ui(self, force=False):
        """在浏览器中打开 dsh 界面。
        force=False (自动打开, 如服务启动后自动开页): 若界面已在浏览器中打开则跳过,
        避免多次重启累积重复标签页;
        force=True (手动点「打开界面」): 必定打开新页面, 不受"最近打开过"去重限制"""
        self._ensure_ui_beacon_server()
        port = int(self.config.get("dsh_port", 3080))
        url = "http://127.0.0.1:%d" % port
        if not force and self.ui_is_open():
            self.log("WebUI 已在浏览器中打开, 不再重复打开新页面: %s" % url)
            return
        self.log("正在打开界面: %s" % url)
        webbrowser.open(url)

    def on_exit(self):
        """程序退出时的清理工作 (停止服务)"""
        self.stop_server()


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

    root = tk.Tk()
    root.title("DeepSeek Harness 一键启动器")
    root.geometry("920x720")
    root.minsize(760, 600)

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

    def refresh_status():
        """刷新状态显示 + 按钮状态"""
        server_running = app.is_server_running()
        env_ready = check_environment_ready()

        # 更新状态指示灯 (绿/黄/灰)
        if server_running:
            status_indicator.itemconfig(dot, fill="#22c55e")   # 绿色
            status_text.set("服务运行中")
            detail_text.set("端口: %s" % app.config.get("dsh_port", 3080))
        elif env_ready:
            status_indicator.itemconfig(dot, fill="#f59e0b")   # 黄色
            status_text.set("环境已就绪, 待启动")
            detail_text.set("Node: \u2713  dsh: \u2713  Python: \u2713")
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
        set_busy(True)
        status_text.set("正在安装环境 ...")
        status_indicator.itemconfig(dot, fill="#f59e0b")   # 黄色闪烁
        append_log("--- 开始安装环境 ---")
        def worker():
            try:
                app.prepare_all()
                root.after(0, lambda: append_log("--- 环境安装完成 ---"))
            except Exception as error:
                root.after(0, lambda: messagebox.showerror("安装失败", str(error)))
            finally:
                root.after(0, lambda: set_busy(False))
        threading.Thread(target=worker, daemon=True).start()

    def on_start():
        """启动服务"""
        if is_busy[0]:
            return
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

    def on_open():
        """手动在浏览器中打开 dsh 界面 (必定打开新页面, 不受单页面去重拦截)"""
        app.open_ui(force=True)

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
                latest_version = app.dsh_latest_version()
                if latest_version is None:
                    root.after(0, lambda: messagebox.showerror(
                        "检查更新", "无法获取最新版本号, 请检查网络后重试。"))
                elif latest_version == current_version:
                    root.after(0, lambda: messagebox.showinfo(
                        "检查更新", "已是最新版本: %s" % current_version))
                else:
                    root.after(0, lambda: ask_update(current_version, latest_version))
            finally:
                root.after(0, lambda: set_busy(False))
        threading.Thread(target=worker, daemon=True).start()

    def ask_update(current_version, latest_version):
        """发现新版本时弹出确认框, 让用户选择 更新 / 不更新
        更新前会自动备份当前版本到 runtime/dsh-backup-<版本>"""
        choose = messagebox.askyesno(
            "发现新版本",
            "当前版本: %s\n最新版本: %s\n\n是否立即更新?\n\n"
            "更新前会自动备份当前版本到 runtime/dsh-backup-<版本>,\n"
            "旧版本备份不会自动删除, 可随时手动清理。" % (current_version, latest_version),
            icon="question")
        if not choose:
            append_log("用户选择暂不更新")
            return
        # 用户确认更新, 后台执行 (备份 + 重装)
        set_busy(True)
        status_text.set("正在更新 dsh ...")
        status_indicator.itemconfig(dot, fill="#f59e0b")
        append_log("--- 开始更新 dsh ---")
        def update_worker():
            try:
                new_version = app.update_dsh()
                root.after(0, lambda: messagebox.showinfo(
                    "更新完成", "dsh 已更新到版本: %s\n\n"
                    "旧版本已备份, 如需回退或清理请查看 runtime 目录。" % new_version))
            except Exception as error:
                root.after(0, lambda: messagebox.showerror("更新失败", str(error)))
            finally:
                root.after(0, lambda: set_busy(False))
        threading.Thread(target=update_worker, daemon=True).start()

    # -------------------------------------------------------------------------
    # 绿色版外围更新 (自更新通道, 与上面的官方核心更新完全独立):
    # 查询 GitHub Release -> 对比版本 -> 下载 zip 到 runtime/update 暂存 ->
    # 解压并生成 update_apply.bat -> 退出启动器 -> 由 bat 完成覆盖安装后自动重启。
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
        choose = messagebox.askyesno(
            "发现新绿色版",
            "当前版本: v%s\n最新版本: v%s\n\n更新说明:\n%s\n\n"
            "是否下载并更新?\n\n更新流程: 下载到 runtime/update 暂存 → 退出启动器 → "
            "自动覆盖安装 → 重启。\n不替换 config.json(你的设置) 与 runtime/(你的数据)。"
            % (local_version, latest_version, release_note),
            icon="question")
        if not choose:
            append_log("用户选择暂不更新绿色版")
            set_busy(False)
            return
        # 用户确认下载, 后台执行 (下载 + 解压 + 生成覆盖脚本)
        set_busy(True)
        status_text.set("正在下载绿色版更新 ...")
        append_log("--- 开始下载绿色版更新: %s ---" % asset_name)
        def download_worker():
            try:
                target_path = os.path.join(GREEN_UPDATE_DIR, asset_name)
                app.download_green_update(download_url, target_path, asset_size)
                content_root, bat_path = app.prepare_green_update(target_path)
                root.after(0, lambda: ask_apply_green_update(
                    content_root, bat_path))
            except Exception as error:
                root.after(0, lambda: messagebox.showerror("下载绿色版更新失败", str(error)))
                root.after(0, lambda: set_busy(False))
        threading.Thread(target=download_worker, daemon=True).start()

    def ask_apply_green_update(content_root, bat_path):
        """下载与准备完成: 提示用户将退出启动器并覆盖安装, 确认后启动脚本并退出"""
        choose = messagebox.askyesno(
            "准备完成",
            "新版已下载并准备就绪。\n\n"
            "接下来将退出启动器, 由后台脚本自动完成覆盖安装, 然后重新启动。\n"
            "旧文件会自动备份到 runtime/update/backup/ (可手动回退)。\n\n是否继续?",
            icon="question")
        if not choose:
            append_log("用户取消应用绿色版更新")
            set_busy(False)
            return
        try:
            app.launch_update_script(bat_path, content_root)
            # 脚本已分离启动, 启动器随即退出; 不重置 busy(窗口即将销毁)
            append_log("绿色版更新脚本已启动, 启动器即将退出 ...")
            on_close()
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
                           remove_btn, install_btn, manual_btn, local_install_btn):
                button.config(state=button_state)
            if not busy:
                plugin_status.set("就绪")

        def refresh_installed():
            """读取已安装插件并刷新左侧列表"""
            installed_tree.delete(*installed_tree.get_children())
            installed_item_urls.clear()
            dependencies = app.list_installed_plugins(profile)
            if not dependencies:
                installed_tree.insert("", "end", text="(暂无已安装插件)", values=("",))
                return
            for package_name, version in sorted(dependencies.items()):
                item_id = installed_tree.insert("", "end", text=package_name, values=(version,))
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
                search_tree.insert("", "end", text="(无结果)", values=(default_source, "", ""))
                plugin_status.set("没有搜索到结果")
                return
            for plugin in plugins:
                item_source = plugin.get("source", default_source)
                item_id = search_tree.insert("", "end",
                                             text=plugin["name"],
                                             values=(item_source, plugin.get("version", ""),
                                                     plugin.get("description", "")))
                # 记录每个条目对应的网址, 供右键菜单打开页面使用
                search_item_urls[item_id] = {
                    "name": plugin["name"],
                    "source": item_source,
                    "url": plugin.get("url", ""),
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
            """加载内置推荐插件列表 (npm 上已核实的 dsh 插件, 无需网络搜索)"""
            if plugin_busy[0]:
                return
            show_search_results(list(RECOMMENDED_PLUGINS), "推荐")
            plugin_status.set("已加载 %d 个推荐插件 (来源: npm 推荐)" % len(RECOMMENDED_PLUGINS))

        def do_open_github_topic():
            """在浏览器打开 GitHub 官方话题页 (完整入口, 可翻页浏览更多)"""
            webbrowser.open(GITHUB_TOPIC_URL)

        def build_open_urls(item_info):
            """根据条目信息构造可打开的网址列表
            返回 [(显示名, url), ...]; github 来源用仓库地址, 其余用 npm 页面 + GitHub 搜索兜底"""
            name = item_info["name"]
            source = item_info.get("source", "")
            raw_url = item_info.get("url", "")
            url_list = []
            # GitHub 来源: 直接打开仓库地址
            if source == "github":
                url_list.append(("打开 GitHub 仓库", raw_url or "https://github.com/%s" % name))
                url_list.append(("打开 npm 页面",
                                 "https://www.npmjs.com/package/%s" % urllib.parse.quote(name)))
            else:
                # npm / 推荐来源: 打开 npm 页面, 以及 GitHub 搜索
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
            item_source = search_tree.item(selection[0], "values")[0]
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
            folder = filedialog.askdirectory(
                title="选择本地插件目录 (目录内需含 package.json)",
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

        # ---------- 中间: 左右两个面板 ----------
        middle = ttk.Panedwindow(top, orient="horizontal")
        middle.pack(fill="both", expand=True, padx=10, pady=6)

        # 左侧: 已安装插件
        installed_frame = ttk.LabelFrame(middle, text="已安装插件 (profile: %s)" % profile)
        middle.add(installed_frame, weight=1)
        # 列表区: 左 Treeview + 右垂直滚动条 (方便上下滑动)
        installed_body = ttk.Frame(installed_frame)
        installed_body.pack(fill="both", expand=True, padx=6, pady=6)
        installed_tree = ttk.Treeview(installed_body, columns=("version",), show="tree headings")
        installed_tree.heading("#0", text="插件名")
        installed_tree.heading("version", text="版本")
        installed_tree.column("#0", width=250)
        installed_tree.column("version", width=90, anchor="center")
        installed_scrollbar = ttk.Scrollbar(installed_body, orient="vertical",
                                            command=installed_tree.yview)
        installed_tree.configure(yscrollcommand=installed_scrollbar.set)
        installed_tree.pack(side="left", fill="both", expand=True)
        installed_scrollbar.pack(side="right", fill="y")

        installed_buttons = ttk.Frame(installed_frame)
        installed_buttons.pack(fill="x", padx=6, pady=(0, 6))
        remove_btn = ttk.Button(installed_buttons, text="移除选中插件", command=on_remove)
        remove_btn.pack(side="left")
        ttk.Button(installed_buttons, text="刷新", command=on_refresh_installed).pack(side="left", padx=(6, 0))

        # 右侧: 搜索结果
        search_frame = ttk.LabelFrame(middle, text="搜索结果")
        middle.add(search_frame, weight=2)
        # 列表区: 左 Treeview + 右垂直滚动条 (方便上下滑动)
        search_body = ttk.Frame(search_frame)
        search_body.pack(fill="both", expand=True, padx=6, pady=6)
        search_tree = ttk.Treeview(search_body, columns=("source", "version", "description"), show="tree headings")
        search_tree.heading("#0", text="插件名")
        search_tree.heading("source", text="来源")
        search_tree.heading("version", text="版本")
        search_tree.heading("description", text="描述")
        # 列宽留足余量: 总和需明显小于面板宽度, 否则 pack 会把右侧滚动条压缩成 1x1
        search_tree.column("#0", width=160)
        search_tree.column("source", width=48, anchor="center")
        search_tree.column("version", width=58, anchor="center")
        search_tree.column("description", width=180, stretch=True)
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

        # 右键菜单: 在列表条目上右键可打开对应网页 (npm / GitHub) 或复制包名
        installed_tree.bind("<Button-3>",
                            lambda event: on_plugin_right_click(installed_tree,
                                                                installed_item_urls, event))
        search_tree.bind("<Button-3>",
                         lambda event: on_plugin_right_click(search_tree,
                                                             search_item_urls, event))

        # 初始刷新已安装列表; 回车触发搜索
        refresh_installed()
        keyword_entry.bind("<Return>", lambda event: do_search())

    # 八个按钮: 安装环境 / 启动服务 / 停止服务 / 打开界面 / 检查更新 / 检查绿色版更新 / 插件管理 / 刷新状态
    install_btn = ttk.Button(button_frame, text="安装环境", command=on_install)
    install_btn.pack(side="left", padx=(0, 8))

    start_btn = ttk.Button(button_frame, text="启动服务", command=on_start)
    start_btn.pack(side="left", padx=8)

    stop_btn = ttk.Button(button_frame, text="停止服务", command=on_stop)
    stop_btn.pack(side="left", padx=8)

    ttk.Button(button_frame, text="打开界面", command=on_open).pack(side="left", padx=8)

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

    # 初始刷新状态
    refresh_status()

    # ---------- 设置区 ----------
    settings_frame = ttk.LabelFrame(root, text="设置")
    settings_frame.pack(fill="x", padx=14, pady=(0, 8))

    ttk.Label(settings_frame, text="镜像源:").grid(row=0, column=0, padx=8, pady=6, sticky="w")
    mirror_var = tk.StringVar(value={"auto": "自动 (国内优先, 失败回退官方)",
                                     "cn": "国内 (npmmirror)",
                                     "official": "官方 (npmjs.org)"}.get(app.config["mirror"], "自动"))
    mirror_choices = ["自动 (国内优先, 失败回退官方)", "国内 (npmmirror)", "官方 (npmjs.org)"]
    mirror_combo = ttk.Combobox(settings_frame, textvariable=mirror_var,
                                values=mirror_choices, state="readonly", width=30)
    mirror_combo.grid(row=0, column=1, padx=8, pady=6, sticky="w")

    ttk.Label(settings_frame, text="端口:").grid(row=1, column=0, padx=8, pady=6, sticky="w")
    port_var = tk.StringVar(value=str(app.config["dsh_port"]))
    port_entry = ttk.Entry(settings_frame, textvariable=port_var, width=12)
    port_entry.grid(row=1, column=1, padx=8, pady=6, sticky="w")

    auto_open_var = tk.BooleanVar(value=bool(app.config.get("auto_open_browser", True)))
    ttk.Checkbutton(settings_frame, text="启动服务后自动打开浏览器 (已打开则不重复开新页)",
                    variable=auto_open_var).grid(row=2, column=0, columnspan=2,
                                                 padx=8, pady=4, sticky="w")

    def on_save():
        try:
            new_port = int(port_var.get().strip())
            if new_port < 1 or new_port > 65535:
                raise ValueError("端口范围 1-65535")
        except ValueError as error:
            messagebox.showerror("设置错误", "端口无效: %s" % error)
            return
        app.config["dsh_port"] = new_port
        app.config["auto_open_browser"] = bool(auto_open_var.get())
        raw = mirror_var.get()
        app.config["mirror"] = "cn" if "国内" in raw else ("official" if "官方" in raw else "auto")
        app.save_config()
        messagebox.showinfo("设置已保存", "配置已保存。下次启动服务时生效。")

    ttk.Button(settings_frame, text="保存设置", command=on_save).grid(
        row=1, column=1, padx=(180, 8), pady=6, sticky="e")

    # ---------- 日志文本框 ----------
    log_frame = ttk.LabelFrame(root, text="运行日志")
    log_frame.pack(fill="both", expand=True, padx=14, pady=(0, 12))

    log_text = tk.Text(log_frame, height=14, state="disabled",
                       font=("Consolas", 9), wrap="word")
    log_text.pack(fill="both", expand=True, padx=6, pady=6)

    # ---------- 关闭窗口时停止服务 ----------
    def on_close():
        status_text.set("正在退出并停止服务 ...")
        app.on_exit()
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)
    append_log("DeepSeek Harness 一键启动器已启动, 点击 [安装环境] 或直接 [启动服务] 开始。")
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
            started = app.start_server(open_browser=False)   # 启动(或复用已运行)服务
            app._ensure_ui_beacon_server()
            port = int(app.config.get("dsh_port", 3080))
            if app.wait_ready(port):
                print("服务已就绪: http://127.0.0.1:%d" % port)
                if app.config.get("auto_open_browser", True):
                    if app.ui_is_open():
                        print("检测到 WebUI 已在浏览器中打开, 不再重复打开新页面")
                    else:
                        webbrowser.open("http://127.0.0.1:%d" % port)
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
