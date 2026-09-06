// ============================================================
// DSH 插件客户端多语言模板 (client.js)
// 用法: 复制本文件到你的插件 lib/client.js, 全局替换
//       dsh-xxx-plugin / xxx-plugin / XXXSection / ROUTE_PATH / GUARD_HEADER
// 说明:
//   - 本模板同时演示「React 插件」主写法, 文末附「原生 DOM 插件」的
//     语言切换重建 (i18n rebuild) 模式 (观星插件同款)。
//   - 规范细节/避坑见: ../references/i18n-webui-plugin.md
//   - Cordis 硬约束 (不要改): apply 导出名 / exports 含 ./package.json /
//     files 含 cordis.patch.yml / 纯 hook 不写 dsh.client
// ============================================================

// ---------- i18n 工具函数: _dsht (所有插件统一实现) ----------
// 优先读 window.__DSH_I18N__ (桌面壳注入 / 浏览器异步加载), 读不到返回 fallback
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

window.__ModuleLoader__.load({
	id: "dsh-xxx-plugin",
	factory: (require) => {
		// ---------- 异步加载 i18n bridge (浏览器场景; 全局去重, 只发一次请求) ----------
		(function() {
			if (window.__DSH_I18N__ && window.__DSH_I18N__._initialized) return;  // 桌面壳已预注入
			if (window.__dsh_i18n_bridge_loaded) return;                          // 已有插件注入过
			window.__dsh_i18n_bridge_loaded = true;
			var _s = document.createElement('script');
			_s.src = 'http://127.0.0.1:3081/__dsh_i18n_bridge.js';
			_s.onerror = function() { _s.src = 'http://localhost:3081/__dsh_i18n_bridge.js'; };
			document.head.appendChild(_s);
		})();
		// ---------- i18n bridge END ----------

		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const inject = ["slots"];
		const ROUTE_PATH = "/__dsh/xxx-plugin";
		const GUARD_HEADER = "X-DSH-Plugin-Xxx";

		/** 设置页「xxx」区块内容 (React 插件主写法)。 */
		function XxxSection() {
			const [data, setData] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);
			// i18nTick: 语言切换时 +1, 触发整个组件 re-render, 让 _dsht() 重跑
			const [i18nTick, setI18nTick] = react.useState(0);
			const loadedRef = react.useRef(false);

			// 监听官方语言切换事件 → 自动重渲染 (React 插件靠这一步实时换语言)
			react.useEffect(() => {
				const handler = () => setI18nTick((t) => t + 1);
				document.addEventListener("dsh-i18n-change", handler);
				return () => document.removeEventListener("dsh-i18n-change", handler);
			}, []);

			const loadData = react.useCallback(async () => {
				setBusy(true);
				setError(null);
				try {
					const response = await fetch(ROUTE_PATH, {
						method: "GET",
						headers: { [GUARD_HEADER]: "1" }
					});
					const payload = await response.json().catch(() => null);
					if (!response.ok || payload === null || payload.ok !== true) {
						throw new Error((payload && payload.error) || ("HTTP " + response.status));
					}
					setData(payload.data);
				} catch (err) {
					setError(_dsht("plugin.xxx_plugin.load_failed", "加载失败") + ": " + String((err && err.message) || err));
				} finally {
					setBusy(false);
				}
			}, []);

			// 首次挂载加载 (注意: 不能条件调用 hook, 这里用 ref 标志)
			if (!loadedRef.current) {
				loadedRef.current = true;
				loadData();
			}

			// 全部文案走 _dsht(key, fallback), 禁止硬编码中文 (注释除外)
			return react.createElement("div", { style: { padding: 8 } },
				react.createElement("p", { style: { margin: 0, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } },
					_dsht("plugin.xxx_plugin.title", "xxx 插件")
				),
				busy && react.createElement("p", { style: { color: "var(--dsw-alias-label-secondary)" } },
					_dsht("plugin.xxx_plugin.loading", "加载中…")
				),
				error && react.createElement("p", { style: { color: "var(--dsw-alias-state-error-primary)" } }, error),
				!busy && !error && react.createElement("p", { style: { color: "var(--dsw-alias-label-secondary)" } },
					_dsht("plugin.xxx_plugin.empty", "暂无数据")
				)
			);
		}

		function apply(ctx) {
			// waitReady 注册: 只保留「立即 or 轮询」两分支, 天然幂等.
			// ❌ 不要加 setTimeout 强制注册 —— 轮询成功后 2 秒再注册一次,
			//    报 list slot "settings.section" already has an entry with id "xxx-plugin"
			var registered = false;
			function tryRegister() {
				if (registered) return;
				if (ctx && ctx.slots && typeof ctx.slots.inject === "function") {
					registered = true;
					ctx.slots.inject("settings.section", () => ctx.slots.register({
						name: "settings.section",
						id: "xxx-plugin",
						order: 500,
						label: _dsht("plugin.xxx_plugin.nav_label", "xxx 插件")
					}, XxxSection));
				}
			}
			tryRegister();
			if (!registered) {
				var timer = setInterval(function() {
					if (typeof ctx !== "undefined" && ctx.slots && typeof ctx.slots.inject === "function") {
						clearInterval(timer);
						tryRegister();
					}
				}, 50);
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

// ============================================================
// 附: 原生 DOM 插件 (非 React) 语言切换重建模式
// 参考实作: dsh-media-background (观星插件)。判断依据: 代码里没有
// react.createElement, 用 document.createElement + textContent 构建 UI。
// 两种插件区别:
//   React 插件 → slot.register 延迟 mount + useEffect 自动 re-render, 天然响应语言切换
//   原生 DOM 插件 → apply 后立即 buildUI(), textContent 一次性写死, 必须手动监听事件重建
// ============================================================

/*
var _i18nHandlerBound = false;

function apply() {
    // 1) 初始化时序: 等 bridge ready 再构建 UI (桌面壳立即可命中, 浏览器轮询最多 5s)
    var br = window.__DSH_I18N__;
    if (br && br._initialized && br.current && br[br.current]) {
        init();
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
    // 2) 语言切换重建: 只绑定一次
    if (!_i18nHandlerBound) {
        _i18nHandlerBound = true;
        document.addEventListener('dsh-i18n-change', function() {
            var oldRoot = document.getElementById('xxx-root');
            if (oldRoot && oldRoot.parentNode) oldRoot.parentNode.removeChild(oldRoot);
            var oldCss = document.getElementById('xxx-css');
            if (oldCss && oldCss.parentNode) oldCss.parentNode.removeChild(oldCss);
            buildUI();          // 重建 DOM 树
            restoreState();     // 恢复 UI 状态 (列表/状态/图标等, 按插件实际情况)
        });
    }
}
*/
