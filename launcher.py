# -*- coding: utf-8 -*-
"""
DeepSeek Harness 一键启动器 (Python 标准库实现, 无第三方依赖)

作用:
    1. 自动检测 / 下载便携版 Node.js 到 runtime/node
    2. 自动在 runtime/dsh 下本地安装 @deepseek-ai/dsh 包
    3. 启动 dsh web 本地服务, 并自动打开浏览器
    4. 提供 tkinter 图形界面 (启动 / 停止 / 打开界面 / 日志)
    5. 所有数据 (Node, dsh, DSH_HOME) 都放在本目录 runtime 下, 完全绿色便携

用法:
    python launcher.py           # 启动图形界面 (默认)
    python launcher.py --start   # 无界面模式: 准备环境 + 启动服务
    python launcher.py --stop    # 停止服务
"""

import os
import sys
import json
import time
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

# ---------------------------------------------------------------------------
# 绿色便携: 所有缓存/配置/临时目录全部重定向到本程序 runtime 下,
# 避免 npm/pnpm/临时文件写到用户主目录 (~/.npm, ~/.pnpm-store 等)
# ---------------------------------------------------------------------------
NPM_CACHE_DIR = os.path.join(RUNTIME_DIR, "npm-cache")      # npm 下载缓存
NPM_USER_CONFIG = os.path.join(RUNTIME_DIR, "npm-userconfig")  # npm 用户配置文件(本地空文件)
PNPM_HOME_DIR = os.path.join(RUNTIME_DIR, "pnpm-home")      # pnpm 全局 home (插件管理)
PNPM_STORE_DIR = os.path.join(RUNTIME_DIR, "pnpm-store")    # pnpm 内容寻址存储
TMP_DIR = os.path.join(RUNTIME_DIR, "tmp")                  # 本地临时目录


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
class Launcher:
    """封装所有业务逻辑, 界面与命令行模式共用"""

    def __init__(self, on_log=None):
        self.config = self.load_config()
        self.on_log = on_log or (lambda message: None)
        self.server_process = None      # 当前管理的服务进程
        self.server_stdin = None        # 服务进程的 stdin 管道 (保持打开, 防止 dsh 因 EOF 退出)
        self.server_thread = None       # 服务输出读取线程
        self._stopping_server = False   # 标记"正在主动停止", 用于区分意外退出

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

    def build_env(self):
        """构造运行环境: 把便携 Node 的 bin 目录加入 PATH,
        并把 npm/pnpm/临时目录全部重定向到本地 runtime, 实现绿色便携"""
        env = dict(os.environ)
        node_bin = self.node_bin_dir()
        if node_bin:
            env["PATH"] = node_bin + os.pathsep + env.get("PATH", "")
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
        # 临时目录 → 本地
        env["TEMP"] = TMP_DIR
        env["TMP"] = TMP_DIR
        return env

    def ensure_runtime_dirs(self):
        """确保 runtime 下的所有目录与本地配置文件存在"""
        for directory in (RUNTIME_DIR, NPM_CACHE_DIR, PNPM_HOME_DIR,
                          PNPM_STORE_DIR, TMP_DIR, DSH_HOME_DIR):
            os.makedirs(directory, exist_ok=True)
        # 本地 npm 用户配置文件: 空文件即可, 用于阻断对用户主目录 ~/.npmrc 的读写
        if not os.path.exists(NPM_USER_CONFIG):
            with open(NPM_USER_CONFIG, "w", encoding="utf-8") as file_handle:
                file_handle.write("# local npm userconfig for DSH launcher\n")

    def prepare_all(self):
        """一键准备全部环境 (内置 Python + Node + dsh), 供启动前调用"""
        self.ensure_runtime_dirs()
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

    def start_server(self, open_browser=True):
        """启动 dsh web 服务, 可选自动打开浏览器"""
        if self.is_server_running():
            self.log("服务已在运行中, 无需重复启动")
            if open_browser:
                self.open_ui()
            return True

        self.log("正在准备环境 ...")
        self.prepare_all()

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

    def open_ui(self):
        """在浏览器中打开 dsh 界面"""
        port = int(self.config.get("dsh_port", 3080))
        url = "http://127.0.0.1:%d" % port
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
        from tkinter import ttk, messagebox
    except ImportError:
        print("未找到 tkinter 支持, 请使用官方 python.org 安装的 Python。")
        print("无界面模式下请运行: python launcher.py --start")
        sys.exit(1)

    app = Launcher()
    is_busy = [False]   # 用列表包装, 闭包内可赋值

    root = tk.Tk()
    root.title("DeepSeek Harness 一键启动器")
    root.geometry("640x560")
    root.minsize(560, 480)

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
        for btn in (install_btn, start_btn, stop_btn, update_btn):
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
                ok = app.start_server(open_browser=True)
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

    def on_open():
        """在浏览器中打开 dsh 界面"""
        app.open_ui()

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

    # 六个按钮: 安装环境 / 启动服务 / 停止服务 / 打开界面 / 检查更新 / 刷新状态
    install_btn = ttk.Button(button_frame, text="安装环境", command=on_install)
    install_btn.pack(side="left", padx=(0, 8))

    start_btn = ttk.Button(button_frame, text="启动服务", command=on_start)
    start_btn.pack(side="left", padx=8)

    stop_btn = ttk.Button(button_frame, text="停止服务", command=on_stop)
    stop_btn.pack(side="left", padx=8)

    ttk.Button(button_frame, text="打开界面", command=on_open).pack(side="left", padx=8)

    update_btn = ttk.Button(button_frame, text="检查更新", command=on_check_update)
    update_btn.pack(side="left", padx=8)

    ttk.Button(button_frame, text="刷新状态", command=refresh_status).pack(side="left", padx=8)

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

    def on_save():
        try:
            new_port = int(port_var.get().strip())
            if new_port < 1 or new_port > 65535:
                raise ValueError("端口范围 1-65535")
        except ValueError as error:
            messagebox.showerror("设置错误", "端口无效: %s" % error)
            return
        app.config["dsh_port"] = new_port
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
            port = int(app.config.get("dsh_port", 3080))
            if app.wait_ready(port):
                print("服务已就绪: http://127.0.0.1:%d" % port)
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
    # 默认: 图形界面
    run_gui()
    return 0


if __name__ == "__main__":
    sys.exit(main())
