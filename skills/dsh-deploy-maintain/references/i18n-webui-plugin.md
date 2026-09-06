# DSH 插件 WebUI 多语言（i18n）实现规范

> 沉淀自 10 个 dsh 插件统一多语言化的实测经验（2026-09-07 全面审计）。
> 代码模板见：`templates/i18n_client_template.js`。检查清单见：`../checklists/plugin-dev-checklist.md`。
> 本规范的核心目标：**让插件所有 UI 文本跟随 DSH 官方 General 语言设置实时切换，且不产生控制台报错、不重复发网络请求。**

## 一、两种 bridge 场景（必须先理解，否则时序必踩坑）

插件 UI 里的 `_dsht(key, fallback)` 从全局对象 `window.__DSH_I18N__` 读翻译，但这个对象有两种注入方式：

| 场景 | bridge 注入方式 | 时序 |
|------|---------------|------|
| **桌面壳**（desktop-shell.py + WebView2） | launcher 用 pywebview `evaluate_js` **同步**注入完整 bridge JS，`__DSH_I18N__._initialized === true` | 页面一加载就可用 |
| **浏览器直接访问**（webbrowser.open / 远程） | 心跳 server **3081 端口**的 `/__dsh_i18n_bridge.js` 由插件 `<script>` **异步**加载 | 页面加载后可能还在下载 |

**核心结论**：写插件时不能假设 bridge 已就绪。`_dsht()` 只是"读到就返回翻译、读不到就返回 fallback"，它本身不负责等待。

### bridge 脚本的服务端来源

- 浏览器场景由 launcher 的心跳 server（3081 端口）提供，同一端口服务四类请求：
  - `/__dsh_ui_alive?=<令牌>` → 心跳上报（SPA 去重）
  - `/__dsh_i18n_bridge.js` → i18n bridge 脚本
  - `/__dsh_locales/zh.json` / `/__dsh_locales/en.json` → 翻译字典（扁平化 JSON）
- 插件动态注入 `<script>` 时的候选路径（按顺序尝试，全部失败则静默）：
  1. `http://127.0.0.1:3081/__dsh_i18n_bridge.js`
  2. `http://localhost:3081/__dsh_i18n_bridge.js`（127.0.0.1 失败后 onerror 切换）
  3. 页面同源 `/__dsh_i18n_bridge.js`
  4. `/plugins/<插件目录>/__dsh_i18n_bridge.js`（launcher 把 bridge JS 也写入插件目录）
- 桌面壳场景 bridge 预注入，动态 `<script>` 直接跳过。

## 二、`_dsht(key, fallback)` 工具函数（10 个插件统一实现）

```javascript
// 优先读 window.__DSH_I18N__ (桌面壳注入或浏览器异步加载的 bridge)
// bridge 缺失 / key 缺失 / 值为空 → 返回 fallback 或 key 本身
function _dsht(key, fallback) {
    try {
        const bridge = window.__DSH_I18N__;
        if (bridge && bridge.current && bridge[bridge.current]) {
            const val = bridge[bridge.current][key];
            if (val !== undefined && val !== null && val !== "") {
                return val;
            }
        }
    } catch (_e) { /* bridge 不存在或解析失败, 忽略 */ }
    return fallback || key;
}
```

要点：
- `bridge[bridge.current]` 是当前语言的**扁平化**字典（`plugin.archive_purge.title` 这种点路径 key），不是嵌套结构。
- 禁止在 UI 文案里硬编码中文（注释除外），一律 `_dsht("key", "fallback")`。
- fallback 一定要写，它是 bridge 缺失时的兜底显示（也方便开发期直接看 fallback 内容定位）。

## 三、异步 bridge 注入 + 去重（必须全局只发一次请求）

浏览器场景需要插件主动加载 bridge。**多插件共存时，每个插件都注入一个 `<script>` 会产生 N 次重复网络请求（实测 10 个插件 = 10 个 114KB 请求）**。用全局标志去重：

```javascript
// 放在 window.__ModuleLoader__.load({...}) 的 factory 开头
(function() {
    if (window.__DSH_I18N__ && window.__DSH_I18N__._initialized) return;  // 桌面壳已预注入
    if (window.__dsh_i18n_bridge_loaded) return;                          // 已有插件注入过
    window.__dsh_i18n_bridge_loaded = true;
    var _s = document.createElement('script');
    _s.src = 'http://127.0.0.1:3081/__dsh_i18n_bridge.js';
    _s.onerror = function() { _s.src = 'http://localhost:3081/__dsh_i18n_bridge.js'; };
    document.head.appendChild(_s);
})();
```

## 四、React 插件 vs 原生 DOM 插件（语言切换响应差异，核心坑）

| 维度 | React 插件（9 个：memory/ollama/usage-stats 等） | 原生 DOM 插件（media-background 观星） |
|------|-----------------------------------------------|--------------------------------------|
| UI 构建 | `react.createElement`，组件内渲染 | `document.createElement`，`textContent` 一次性写死 |
| UI 渲染时机 | `ctx.slots.register('settings.section', ...)` 延迟到用户点设置才 mount | `apply → init() → buildUI()` 模块加载后**立即**构建 |
| 语言切换响应 | `useEffect` 监听 `dsh-i18n-change` → `setI18nTick()` → **自动 re-render**，render 里所有 `_dsht()` 重跑 | **必须手动监听事件 + 销毁旧 DOM 重建** |

**React 插件模式**（自动响应语言切换）：

```javascript
const [i18nTick, setI18nTick] = react.useState(0);
react.useEffect(() => {
    const handler = () => setI18nTick((t) => t + 1);
    document.addEventListener("dsh-i18n-change", handler);
    return () => document.removeEventListener("dsh-i18n-change", handler);
}, []);
```

**原生 DOM 插件必须套 `_bindI18nRebuildOnce()` 模式**（两处都要做）：

1. **初始化时序**——`apply()` 里先等 bridge ready 再 init（100ms 轮询，最多 5s，超时兜底）：
```javascript
function apply() {
    var br = window.__DSH_I18N__;
    if (br && br._initialized && br.current && br[br.current]) {
        init();  // 桌面壳场景立即可命中
        return;
    }
    var waitedMs = 0;
    var timer = setInterval(function() {
        var b = window.__DSH_I18N__;
        waitedMs += 100;
        if ((b && b._initialized && b.current && b[b.current]) || waitedMs >= 5000) {
            clearInterval(timer);
            init();
        }
    }, 100);
}
```
2. **语言切换重建**——监听 `dsh-i18n-change`，销毁旧 rootEl + CSS style，重新 buildUI 并恢复状态（`_i18nHandlerBound` 标志保证只监听一次）。

## 五、waitReady 注册必须幂等（否则控制台报错）

**错误模式**（实测 7 条 `Error: list slot "settings.section" already has an entry with id "XXX"`）：

```javascript
if (ready) { _doRegisterXXX(); }                                  // A 立即
else {
    setInterval(if ready) { _doRegisterXXX(); }, 50ms);           // B 轮询
    setTimeout(clearInterval; _doRegisterXXX(), 2000);            // C 强制再注册 ← BUG!
}
```

浏览器场景 B 轮询已注册成功，C 在 2 秒后**无条件再注册一次** → 同一 slot id 注册两次报错。

**正确模式**：只保留"立即 or 轮询"两分支，天然幂等。**不要用 setTimeout 做"超时强制注册"**。

## 六、语言字典（locales）对齐纪律

- 启动器维护 `locales/zh.json` 和 `locales/en.json` 两套扁平化后的 key 字典（launcher 加载后扁平化为点路径 key，经 bridge 提供）。
- **zh/en 两套 key 必须完全对齐**（本项目实测 799 个 key），漏一个 key 会导致该语言 fallback 回 key 本身。
- 字典 key 组织按 `plugin.<插件名>.<组件>.<文案>` 命名，新增 UI 文案时两套字典同步加。
- 本地验证：`python -c "import json; zh=json.load(open('locales/zh.json')); en=json.load(open('locales/en.json')); ..."` 对比两套扁平化 key 集合是否一致。

## 七、调试与验收

- **验证 bridge 是否注入**：控制台 `typeof window.__DSH_I18N__`、`window.__DSH_I18N__._initialized`。
- **验证语言切换**：切到 en 后，UI 上所有插件面板文本应变为英文，无需手动刷新（React 自动 re-render；原生 DOM 走 rebuild）。
- **验证无重复注册**：控制台不应出现 `list slot ... already has an entry`。
- **验证无重复请求**：Network 面板 `__dsh_i18n_bridge.js` 应只有一次成功请求（其余命中全局去重标志）。
- 改插件客户端源码 → 强刷页面生效；改宿主端/字典服务端 → 重启服务或重启 launcher。
