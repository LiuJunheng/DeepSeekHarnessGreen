# -*- coding: utf-8 -*-
"""
DeepSeek Harness 绿色版「桌面版」内核壳（WebView2 独立窗口）
================================================================
目标：完全脱离浏览器进程打开 DSH WebUI —— 不依赖系统中是否安装
Edge / Chrome，也不依赖浏览器外观。实现方式是内嵌 WebView2
（Chromium 内核, Windows 系统组件, 独立于浏览器）弹出真正的桌面窗口。

- 底层：pywebview（Windows 后端 = WinForms + Chromium/WebView2）。
- 地址来源：绿色版根目录 config.json 的 dsh_host / dsh_port（默认 127.0.0.1:3080）。
- 随绿色版整体迁移自动跟随，不写系统路径。
- 自举：首次运行时若检测到 pywebview 未安装，会自动用便携 python 的 pip
  后台安装（静默无控制台），装完再拉起窗口；
  兜底：WebView2 Runtime 缺失或窗口初始化失败时，自动改用系统默认浏览器打开。
- 桌面图标：窗口出现后用 Win32 消息把应用图标换成绿色鲸鱼 DSH_Launcher.ico
  （pywebview(WinForms) 的 start() 图标参数仅支持 GTK/QT，Windows 需走 WM_SETICON）。
- 未启动提示：若 dsh 服务尚未监听端口，先弹一个"请先启动服务器"的固定提示页，
  后台每秒探测端口，一旦服务就绪自动载入真实界面；而不是显示"连接失败"网页。
- 使用：由启动器 GUI「桌面窗口」按钮调用本脚本（用便携 Python + pythonw
  无控制台方式拉起，看起来像原生桌面 App）；desktop-shell.bat 独立入口
  已于 2026-08-27 移除，桌面窗口统一从启动器进入。
"""
import ctypes
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import webbrowser

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 3080

WINDOW_TITLE = "DeepSeek Harness 桌面版"
ICON_FILE = os.path.join(BASE_DIR, "DSH_Launcher.ico")
# 桌面版是"固定单实例程序": 进程启动后把自身 PID 写入 runtime, 供 launcher
# 用进程身份判断是否在线做排重, 不再依赖 WebUI 心跳 (网页版才需要心跳)。
PID_FILE = os.path.join(BASE_DIR, "runtime", "desktop_shell.pid")
WINDOW_WIDTH = 1200
WINDOW_HEIGHT = 800
WINDOW_MIN_WIDTH = 900
WINDOW_MIN_HEIGHT = 600

PIP_MIRROR = "https://mirrors.aliyun.com/pypi/simple/"
PORT_POLL_SECONDS = 1.5

# 服务未启动时展示的固定提示页 (data: URL), 避免加载真实地址出现"连接失败"。
PLACEHOLDER_HTML = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>服务器未启动 - DeepSeek Harness 桌面版</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    font-family: "Microsoft YaHei", "Segoe UI", sans-serif;
    background: linear-gradient(160deg, #0f2c27 0%, #123a32 55%, #0d2a24 100%);
    color: #e8f5ef;
    display: flex; align-items: center; justify-content: center;
  }
  .card {
    background: rgba(18, 58, 50, 0.85);
    border: 1px solid #2f6f5a;
    border-radius: 16px;
    padding: 40px 48px;
    max-width: 460px;
    text-align: center;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
  }
  .fish { font-size: 64px; line-height: 1; margin-bottom: 12px; }
  h1 { font-size: 22px; margin-bottom: 12px; color: #7fe0b4; }
  p { font-size: 14px; line-height: 1.8; color: #bddcd0; }
  .hint {
    margin-top: 18px; font-size: 13px; color: #8fb7a8;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="fish">&#128011;</div>
    <h1>服务器尚未启动</h1>
    <p>请在【DeepSeek Harness 启动器】中点击「启动服务」，<br>
       本窗口会自动检测到服务并载入界面。</p>
    <p class="hint">无需手动刷新，本页面会定时自动检测。</p>
  </div>
</body>
</html>"""


def read_server_address():
    """从 config.json 读取 dsh_host / dsh_port；失败或缺失时用默认值。

    Returns:
        (str, int): 形如 (host, port)。
    """
    host = DEFAULT_HOST
    port = DEFAULT_PORT
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as file_handle:
            config_data = json.load(file_handle)
        if "dsh_host" in config_data and config_data["dsh_host"]:
            host = str(config_data["dsh_host"])
        if "dsh_port" in config_data:
            port = int(config_data["dsh_port"])
    except Exception as exc:  # noqa: BLE001 - 配置解析失败不应中断，退回默认地址
        print("[DSH Shell] 读取 config.json 失败, 使用默认地址:", repr(exc), flush=True)
    # 0.0.0.0 / :: 用于对外监听, 本机 WebView 访问不到, 归一化为回环地址。
    if host in ("0.0.0.0", "::"):
        host = DEFAULT_HOST
    return host, port


def webview_runtime_present():
    """粗略判断系统是否安装了 WebView2 Runtime（绿色版可否走 WebView2 路径）。

    Returns:
        bool: 找到 EdgeWebView 目录即认为存在。
    """
    program_files_x86 = os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")
    program_files = os.environ.get("PROGRAMFILES", r"C:\Program Files")
    for candidate in (
        os.path.join(program_files_x86, "Microsoft", "EdgeWebView"),
        os.path.join(program_files, "Microsoft", "EdgeWebView"),
    ):
        if os.path.isdir(candidate):
            return True
    return False


def port_listening(port):
    """探测本机端口是否已被 dsh 服务监听（用于决定弹真实界面还是提示页）。

    Args:
        port (int): 要探测的 TCP 端口。
    Returns:
        bool: True 表示服务已就绪。
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.4)
    try:
        connected = sock.connect_ex((DEFAULT_HOST, port)) == 0
    finally:
        sock.close()
    return connected


def ensure_pywebview():
    """确保 pywebview(WebView2 后端) 可用；缺失时自动用便携 python 后台静默安装。

    Returns:
        bool: True 表示 pywebview 可用。
    """
    try:
        import webview  # noqa: F401 - 仅做可用性探测
        return True
    except ImportError:
        print("[DSH Shell] pywebview 未安装, 正在自动安装 (首次约需几十秒) ...", flush=True)
        pip_command = [
            sys.executable, "-m", "pip", "install",
            "pywebview", "pythonnet",
            "--index-url", PIP_MIRROR,
            "--no-warn-script-location",
        ]
        try:
            creation_flags = 0
            if sys.platform == "win32":
                creation_flags = subprocess.CREATE_NO_WINDOW
            subprocess.run(pip_command, creationflags=creation_flags, timeout=180)
        except Exception as exc:  # noqa: BLE001 - 安装失败交由调用方回退浏览器
            print("[DSH Shell] 自动安装 pywebview 失败:", repr(exc), flush=True)
            return False
        try:
            import webview  # noqa: F401
            return True
        except ImportError:
            return False


def write_pid_file():
    """把当前桌面壳进程 PID 写入 runtime/desktop_shell.pid, 作为"单实例在线"身份标记。

    launcher 读此文件 + 校验进程存活来判重, 不依赖 WebUI 心跳。
    写失败不致命 (launcher 会改为兜底判重)。
    """
    try:
        os.makedirs(os.path.dirname(PID_FILE), exist_ok=True)
        with open(PID_FILE, "w", encoding="utf-8") as file_handle:
            file_handle.write(str(os.getpid()))
        print("[DSH Shell] 已记录桌面壳 PID", os.getpid(), flush=True)
    except OSError:
        pass


def remove_pid_file():
    """桌面壳窗口关闭/失败退出时删除 PID 标记 (进程没了 launcher 也能判假, 删了更干净)。"""
    try:
        if os.path.exists(PID_FILE):
            os.remove(PID_FILE)
    except OSError:
        pass


def apply_window_icon(title, icon_path):
    """用 Win32 消息把顶层窗口图标换成绿色鲸鱼 .ico（后台线程执行）。

    pywebview(WinForms) 的 webview.start(icon=...) 仅支持 GTK/QT，Windows 下需
    通过 WM_SETICON 指定大/小图标。窗口创建后按标题 FindWindow 找到句柄再设置。
    Args:
        title (str): 窗口标题（与 create_window 的标题一致）。
        icon_path (str): .ico 文件绝对路径。
    """
    if sys.platform != "win32" or not icon_path or not os.path.isfile(icon_path):
        return

    def worker():
        try:
            user32 = ctypes.WinDLL("user32", use_last_error=True)
            shell32 = ctypes.WinDLL("shell32", use_last_error=True)
            user32.FindWindowW.restype = ctypes.c_void_p
            user32.FindWindowW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
            user32.SendMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint,
                                            ctypes.c_uint, ctypes.c_void_p]
            shell32.LoadImageW.restype = ctypes.c_void_p
            shell32.LoadImageW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p,
                                           ctypes.c_uint, ctypes.c_int,
                                           ctypes.c_int, ctypes.c_uint]
            WM_SETICON = 0x0080
            ICON_SMALL = 0
            ICON_BIG = 1
            IMAGE_ICON = 1
            LR_LOADFROMFILE = 0x00000010
            # 轮询等窗口出现 (最多约 10 秒)
            for _ in range(100):
                window_handle = user32.FindWindowW(None, title)
                if window_handle:
                    big_icon = shell32.LoadImageW(None, icon_path, IMAGE_ICON, 0, 0,
                                                  LR_LOADFROMFILE)
                    small_icon = shell32.LoadImageW(None, icon_path, IMAGE_ICON,
                                                    16, 16, LR_LOADFROMFILE)
                    if big_icon:
                        user32.SendMessageW(window_handle, WM_SETICON, ICON_BIG, big_icon)
                    if small_icon:
                        user32.SendMessageW(window_handle, WM_SETICON, ICON_SMALL, small_icon)
                    return
                time.sleep(0.1)
        except Exception as exc:  # noqa: BLE001 - 换图标失败不影响主流程
            print("[DSH Shell] 设置窗口图标失败:", repr(exc), flush=True)

    threading.Thread(target=worker, daemon=True).start()


def _flatten_i18n(obj, prefix=""):
    """把嵌套 dict 展平成 dot-key dict（locales JSON 统一格式）。"""
    out = {}
    for key, value in obj.items():
        new_key = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            out.update(_flatten_i18n(value, new_key))
        else:
            out[new_key] = value
    return out


def _build_i18n_bridge_js():
    """读取 locales/zh.json + en.json, 生成 window.__DSH_I18N__ 注入脚本。

    语言来源 (优先顺序):
      1) DSH 官方 LocaleRuntime 同步到 <html lang="zh-CN" | "en"> (MutationObserver 监听)
      2) fallback: 启动器 config.json 的 language
      3) fallback: "zh"

    语言切换机制:
      - WebUI settings.general.language 切语言 → LocaleRuntime.setLocale() →
        document.documentElement.lang 更新 → MutationObserver 捕获 →
        window.__DSH_I18N__.current 更新 + CustomEvent("dsh-i18n-change") 派发 →
        插件里的 _dsht() 通过该事件触发 React 重渲染
    """
    locales_dir = os.path.join(BASE_DIR, "locales")
    zh_path = os.path.join(locales_dir, "zh.json")
    en_path = os.path.join(locales_dir, "en.json")
    if not os.path.isfile(zh_path) or not os.path.isfile(en_path):
        return ""

    try:
        with open(zh_path, "r", encoding="utf-8") as zh_fh:
            zh_raw = json.load(zh_fh)
        with open(en_path, "r", encoding="utf-8") as en_fh:
            en_raw = json.load(en_fh)
        zh_flat = _flatten_i18n(zh_raw)
        en_flat = _flatten_i18n(en_raw)

        # 启动器 config.json 仅作为 fallback (WebUI 加载后会被 <html lang> 覆盖)
        config_fallback = "zh"
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as cfg_fh:
                cfg = json.load(cfg_fh)
            if cfg.get("language") in ("zh", "en"):
                config_fallback = cfg["language"]
        except Exception:
            pass

        zh_json = json.dumps(zh_flat, ensure_ascii=False, separators=(",", ":"))
        en_json = json.dumps(en_flat, ensure_ascii=False, separators=(",", ":"))

        # 重写版 bridge JS: 多源检测 + console.log 诊断 + 全局 _dsht 暴露
        bridge = r"""
(function() {
    var BR = window.__DSH_I18N__ || (window.__DSH_I18N__ = {});
    BR.zh = """ + zh_json + r""";
    BR.en = """ + en_json + r""";
    BR._configFallback = """ + repr(config_fallback) + r""";
    BR._listeners = BR._listeners || [];
    BR._debug = BR._debug || { initTime: Date.now(), events: [] };

    // 幂等保护: 已初始化过则只更新翻译字典 (locales 更新时桥接会重新注入)
    if (BR._initialized) {
        BR._debug.events.push({ type: 're-inject', time: Date.now() });
        try { console.log('[DSH-i18n] bridge re-injected (idempotent, zh=' + Object.keys(BR.zh).length + ', en=' + Object.keys(BR.en).length + ')'); } catch(_) {}
        return;
    }
    BR._initialized = true;

    try { console.log('[DSH-i18n] bridge v2 initializing... configFallback=' + BR._configFallback); } catch(_) {}

    // ============ 多源语言检测 ============
    function _parseHtmlLang() {
        try {
            var h = document.documentElement && document.documentElement.lang;
            if (h === 'zh-CN' || h === 'zh') return 'zh';
            if (h && h.indexOf('en') === 0) return 'en';
        } catch (_) {}
        return null;
    }

    function _parseLocalStorageLang() {
        try {
            var ls = window.localStorage;
            if (!ls) return null;
            // DSH 可能存语言在这些 key
            var candidates = ['locale.preference', 'language', 'locale', 'dsh.locale', 'dsh.language'];
            for (var i = 0; i < candidates.length; i++) {
                var v = ls.getItem(candidates[i]);
                if (v) {
                    if (v === 'zh-CN' || v === 'zh') return 'zh';
                    if (v.indexOf('en') === 0) return 'en';
                }
            }
        } catch (_) {}
        return null;
    }

    function _resolveCurrent() {
        // 优先级 1: <html lang> (DSH LocaleRuntime 同步)
        var fromHtml = _parseHtmlLang();
        if (fromHtml) return fromHtml;
        // 优先级 2: localStorage (手动切换后可能存这里)
        var fromLS = _parseLocalStorageLang();
        if (fromLS) return fromLS;
        // 优先级 3: config.json fallback
        return BR._configFallback || 'zh';
    }

    function _notifyChange(newLang, reason) {
        BR._debug.events.push({ type: 'notify', lang: newLang, reason: reason || 'unknown', time: Date.now() });
        try { console.log('[DSH-i18n] language changed to ' + newLang + ' (reason: ' + (reason || 'unknown') + ')'); } catch(_) {}
        try {
            document.dispatchEvent(new CustomEvent('dsh-i18n-change', { detail: { lang: newLang, reason: reason || 'unknown' } }));
        } catch (_) {}
    }

    function _setCurrentAndNotify(newLang, reason) {
        if (newLang !== BR.current) {
            BR.current = newLang;
            _notifyChange(newLang, reason);
        }
    }

    // ============ 全局 _dsht 函数 ============
    window._dsht = function(key, fallback) {
        try {
            var br = window.__DSH_I18N__;
            if (br && br.current && br[br.current]) {
                var val = br[br.current][key];
                if (val !== undefined && val !== null && val !== '') return val;
            }
            // 当前语言没翻译 → 直接返回传入的 fallback (中文)
        } catch (_) {}
        return fallback || key;
    };

    // ============ 初始化 + 监听 ============
    function _initAndWatch() {
        BR.current = _resolveCurrent();
        BR._debug.events.push({ type: 'init', current: BR.current, htmlLang: document.documentElement && document.documentElement.lang, time: Date.now() });
        try { console.log('[DSH-i18n] initialized. current=' + BR.current + ' htmlLang="' + (document.documentElement && document.documentElement.lang || '') + '"'); } catch(_) {}

        // 1) MutationObserver: 监听 <html lang>
        if (window.MutationObserver) {
            var ob = new MutationObserver(function(muts) {
                for (var i = 0; i < muts.length; i++) {
                    var m = muts[i];
                    if (m.type === 'attributes' && m.attributeName === 'lang') {
                        var newLang = _resolveCurrent();
                        BR._debug.events.push({ type: 'mutation', htmlLang: document.documentElement.lang, newLang: newLang, time: Date.now() });
                        _setCurrentAndNotify(newLang, 'html.lang mutation');
                    }
                }
            });
            ob.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
            BR._debug.observerActive = true;
        }

        // 2) localStorage 变化监听
        try {
            window.addEventListener('storage', function(e) {
                BR._debug.events.push({ type: 'storage', key: e.key, newValue: e.newValue, time: Date.now() });
                var newLang = _resolveCurrent();
                _setCurrentAndNotify(newLang, 'localStorage change: ' + e.key);
            });
        } catch(_) {}

        // 3) 兜底轮询: 每 1 秒检查一次所有来源 (最可靠)
        BR._pollCount = 0;
        setInterval(function() {
            BR._pollCount++;
            var newLang = _resolveCurrent();
            if (newLang !== BR.current) {
                BR._debug.events.push({ type: 'poll', newLang: newLang, htmlLang: document.documentElement && document.documentElement.lang, time: Date.now() });
                _setCurrentAndNotify(newLang, 'poll detection #' + BR._pollCount);
            }
        }, 1000);

        BR._debug.initComplete = true;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _initAndWatch);
    } else {
        _initAndWatch();
    }

    try { console.log('[DSH-i18n] bridge ready. Try: _dsht("plugin.session_rewind.tab_label", "test")'); } catch(_) {}
})();
"""
        return bridge
    except Exception as exc:
        print("[DSH Shell] 构建 i18n bridge 失败:", repr(exc), flush=True)
        return ""


def open_in_shell_window(server_url, port, icon_path):
    """用 pywebview 弹出内嵌 WebView2 的独立桌面窗口并阻塞到窗口关闭。

    若 dsh 服务尚未监听端口，先弹"请先启动服务器"提示页，后台轮询端口，
    一旦就绪自动 load 真实地址；同时给窗口换上绿色鲸鱼图标。
    Args:
        server_url (str): 要加载的 DSH WebUI 完整地址。
        port (int): dsh 服务监听端口。
        icon_path (str): 窗口图标 .ico 路径。
    """
    import webview as shell_webview_backend  # 延迟导入, 避免未用时拖慢启动

    # 决定首屏地址: 服务未就绪时直接用提示页 data URL 作为初始地址,
    # 避免"窗口先展示连接失败再跳提示页"的抖动, 也规避了 start() 前调用
    # load_url() 导致 WinForms 窗口无法启动的坑(现象: Main window failed to start)。
    server_ready = port_listening(port)
    if server_ready:
        initial_url = server_url
    else:
        placeholder_url = "data:text/html;charset=utf-8," + urllib.parse.quote(PLACEHOLDER_HTML)
        initial_url = placeholder_url

    window_handle = shell_webview_backend.create_window(
        WINDOW_TITLE,
        initial_url,
        width=WINDOW_WIDTH,
        height=WINDOW_HEIGHT,
        min_size=(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT),
        resizable=True,
    )

    i18n_bridge_js = _build_i18n_bridge_js()

    def _inject_i18n():
        """尝试在当前页面注入 window.__DSH_I18N__ bridge (忽略失败, SPA 导航可能重建上下文)."""
        if not i18n_bridge_js:
            return
        try:
            window_handle.evaluate_js(i18n_bridge_js)
            # 注入后立即查询 bridge 状态 (pywebview evaluate_js 返回最后一个表达式结果)
            status = window_handle.evaluate_js(
                'window.__DSH_I18N__ ? '
                'JSON.stringify({'
                'current: window.__DSH_I18N__.current, '
                'initialized: !!window.__DSH_I18N__._initialized, '
                'hasZh: !!window.__DSH_I18N__.zh, '
                'hasEn: !!window.__DSH_I18N__.en, '
                'htmlLang: (document.documentElement && document.documentElement.lang) || ""'
                '}) : "MISSING"'
            )
            try:
                import json as _json
                parsed = _json.loads(status)
                print(f'[DSH-i18n] bridge OK: current={parsed.get("current","?")} '
                      f'htmlLang="{parsed.get("htmlLang","")}" '
                      f'zh={parsed.get("hasZh")} en={parsed.get("hasEn")} '
                      f'initialized={parsed.get("initialized")}')
            except Exception:
                print(f'[DSH-i18n] bridge check raw: {status}')
        except Exception as exc:
            print(f'[DSH-i18n] inject failed: {exc}')

    def _start_persistent_injector():
        """启动后台线程, 持续注入 bridge 直到窗口关闭.

        为什么需要: DSH WebUI 是 SPA (单页应用), 插件模块可能在 bridge 注入前就加载了,
        或者 SPA 内部导航会重建 JS 上下文导致 bridge 丢失.
        持续注入确保任意时刻 window.__DSH_I18N__ 都可用.
        bridge JS 本身是幂等的 (已存在则跳过重复设置), 不会有副作用.
        """
        def inject_loop():
            # 前 60 秒高频注入 (覆盖启动 + SPA 导航), 之后降频到 10 秒一次
            start_time = time.time()
            while True:
                elapsed = time.time() - start_time
                if elapsed < 60:
                    time.sleep(3)
                else:
                    time.sleep(10)
                _inject_i18n()
        threading.Thread(target=inject_loop, daemon=True).start()

    # ===== 关键: 绑定 pywebview 事件, 在正确的 window 上下文里注入 =====
    # 之前用 load_url + sleep(0.5) + evaluate_js, 但 load_url 后立即 sleep
    # 注入会落在 about:blank 上 (JS 上下文不同), DSH 页面加载后 bridge 丢失.
    # events.loaded = 页面 HTML + JS 都加载完, evaluate_js 一定在正确的 window 里.
    # events.before_load = 更早触发, 如果能在新页面 JS 执行前注入就完美.
    def _on_page_loaded():
        """页面加载完成后注入 bridge (正确的 window 上下文)."""
        _inject_i18n()

    def _on_page_before_load(url):
        """页面开始加载时就尝试注入 (可能在 JS 执行前, 最优时序)."""
        _inject_i18n()

    try:
        window_handle.events.loaded += _on_page_loaded
        window_handle.events.before_load += _on_page_before_load
        print("[DSH-i18n] bound pywebview events.loaded + before_load for bridge injection")
    except Exception as exc:
        print(f"[DSH-i18n] bind events failed (will rely on persistent injector): {exc}")

    def on_window_ready():
        """窗口就绪后(主线程回调)再导航/轮询; 服务未起来则后台轮询端口, 一起来自动切真实界面.

        必须在 start() 的窗口就绪回调里做 load_url, 不能在其之前调用
        (pywebview/WinForms 在 start() 前 load_url 会挂起窗口初始化)。
        """
        # 启动持续注入 (不依赖服务是否就绪, 兜底 SPA 内部导航重建 JS 上下文)
        _start_persistent_injector()

        if server_ready:
            # 服务已就绪, load_url 后 events.loaded 会自动注入 bridge
            return

        def wait_for_server():
            while not port_listening(port):
                time.sleep(PORT_POLL_SECONDS)
            try:
                window_handle.load_url(server_url)
                # 不再手动 sleep + evaluate_js —— events.loaded/before_load 自动处理
                # 插件里还有 slot-ready wait (setInterval 等 bridge 就绪再 register tab label)
            except Exception:  # noqa: BLE001 - 窗口可能已关闭, 忽略
                pass

        threading.Thread(target=wait_for_server, daemon=True).start()

    # 换绿色鲸鱼图标 (Win32 消息, 后台线程找窗口设置; 不影响主流程)。
    apply_window_icon(WINDOW_TITLE, icon_path)

    # 记录单实例身份 (pid 文件), 使 launcher 能按进程判重; 窗口关闭/失败退出时删除。
    write_pid_file()
    try:
        # start(func) 进入 GUI 消息循环并阻塞, func 在窗口就绪后于主线程执行。
        # icon=: pywebview 的 WinForms 后端会把该 .ico 直接赋给窗体 Icon
        # (自绘 WM_SETICON 依赖窗口标题查找, 页面 title 覆盖后可能失效,
        #  而 start(icon=) 是权威方式); 传 None 时后端才退回 pythonw 默认图标)。
        shell_webview_backend.start(on_window_ready, debug=False, icon=icon_path)
    finally:
        remove_pid_file()


def parse_url_arg():
    """解析命令行 --url 参数: 由启动器传入带 ?token= 的认证地址 (新版 dsh 要求,
    见 launcher.py _web_auth_url), 桌面壳直接用它打开即可完成认证换 Cookie。
    不存在时返回 None (桌面壳按 config 自行构建地址, 兼容旧版/手动直启)。"""
    arguments = sys.argv[1:]
    if "--url" in arguments:
        url_index = arguments.index("--url")
        if url_index + 1 < len(arguments):
            return arguments[url_index + 1]
    return None


def main():
    """桌面壳入口：选定加载方式并保持进程存活直到窗口/浏览器关闭。"""
    host, port = read_server_address()
    override_url = parse_url_arg()
    if override_url:
        server_url = override_url
        # 从认证地址解析端口 (用于就绪轮询); 解析失败沿用 config 端口
        try:
            parsed_port = urllib.parse.urlparse(override_url).port
            if parsed_port is not None:
                port = int(parsed_port)
        except (ValueError, TypeError):
            pass
    else:
        server_url = "http://%s:%d" % (host, port)
    icon_path = ICON_FILE if os.path.isfile(ICON_FILE) else None
    print("[DSH Shell] 目标地址:", server_url, flush=True)

    # WebView2 Runtime 缺失时直接用系统默认浏览器打开 (保证功能可用)。
    if not webview_runtime_present():
        print("[DSH Shell] 未检测到 WebView2 Runtime, 改用系统默认浏览器。", flush=True)
        webbrowser.open(server_url)
        return 0

    # pywebview 缺失时自动静默安装; 装不上再回退浏览器。
    if not ensure_pywebview():
        print("[DSH Shell] pywebview 不可用, 改用系统默认浏览器。", flush=True)
        webbrowser.open(server_url)
        return 1

    try:
        print("[DSH Shell] 正在弹出 WebView2 桌面窗口...", flush=True)
        open_in_shell_window(server_url, port, icon_path)
        return 0
    except Exception as exc:  # noqa: BLE001 - 任何内核初始化失败都回退浏览器
        print("[DSH Shell] WebView2 窗口启动失败:", repr(exc), flush=True)
        print("[DSH Shell] 回退到系统默认浏览器打开。", flush=True)
        try:
            webbrowser.open(server_url)
            return 0
        except Exception as browser_exc:  # noqa: BLE001 - 尽力而为
            print("[DSH Shell] 打开系统默认浏览器失败:", repr(browser_exc), flush=True)
            return 1


if __name__ == "__main__":
    sys.exit(main())