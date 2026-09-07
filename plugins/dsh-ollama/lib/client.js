// DeepSeek Harness 插件 (客户端): dsh-ollama
// 往 WebUI「设置」里注册「Ollama 设置」页:
//   - 读取/展示当前生效配置、连接状态、已接入的 Ollama 模型列表;
//   - 提供表单修改插件配置 (服务地址 / 显示名称 / 上下文窗口 / 最大输出 /
//     探测间隔 / 探测超时 / 授权请求头 / 启用开关);
//   - 保存后经宿主端路由立即按新配置重新探测接入 (无需重启服务);
//   - 配置持久化在 DSH_HOME/ollama-config.json (宿主端负责), 重启后依然生效。
// 数据走宿主端两个路由 (均要求自定义头 X-DSH-Ollama: 1 防跨站):
//   GET  /__dsh/ollama/config -> { ok, config, status, providerWritten }
//   POST /__dsh/ollama/config -> 保存配置 + 立即重新接入, 返回同样结构 + saved
// 这是加载器契约格式 (window.__ModuleLoader__.load), 与官方客户端插件一致。
// 注意: 不修改任何官方文件/包; 样式用内联对象 + WebUI 主题变量。

// i18n 工具函数 (同其他内置插件): 优先读 window.__DSH_I18N__ (启动器桌面壳注入)

// _tabLabel: 现场解析当前语言(读 <html lang>), 不依赖 BR.current 缓存,
// 消除语言切换时 Tab 名滞后/与宿主语言不同步的竞态。宿主切语言会同步更新 <html lang>。
function _tabLabel(key, fallback) {
    var el = document.documentElement && document.documentElement.lang;
    var lang = (el === 'zh-CN' || el === 'zh') ? 'zh'
        : (el && el.indexOf('en') === 0) ? 'en'
        : ((window.__DSH_I18N__ && window.__DSH_I18N__.current) || 'zh');
    var br = window.__DSH_I18N__;
    try {
        if (br && br[lang]) {
            var val = br[lang][key];
            if (val !== undefined && val !== null && val !== '') return val;
        }
    } catch (_) {}
    return fallback || key;
}
function _dsht(key, fallback) {
	try {
		var bridge = window.__DSH_I18N__;
		if (bridge && bridge.current && bridge[bridge.current]) {
			var val = bridge[bridge.current][key];
			if (val !== undefined && val !== null && val !== "") return val;
		}
	} catch (_e) { }
	return fallback || key;
}

window.__ModuleLoader__.load({
	id: "dsh-ollama",
	factory: (require) => {
		        // === 异步加载 i18n bridge ===
		        (function() {
		            if (window.__DSH_I18N__ && window.__DSH_I18N__._initialized) return;  // 桌面壳已预注入
		            var _s = document.createElement('script');
		            _s.src = 'http://127.0.0.1:3081/__dsh_i18n_bridge.js';
		            _s.onerror = function() { _s.src = 'http://localhost:3081/__dsh_i18n_bridge.js'; };
		            document.head.appendChild(_s);
		        })();
		        // === i18n bridge END ===

		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const inject = ["slots"];

		// 宿主端设置路由与防御头 (与 lib/index.js 保持一致)。
		const ROUTE_CONFIG = "/__dsh/ollama/config";
		const ROUTE_RECONNECT = "/__dsh/ollama/reconnect";
		const GUARD_HEADER = "X-DSH-Ollama";

		// ---- 网络请求 ----

		/** 带防御头的 GET, 返回 payload (宿主侧 ok 校验)。 */
		async function getConfig() {
			const response = await fetch(ROUTE_CONFIG, { headers: { [GUARD_HEADER]: "1" } });
			const payload = await response.json().catch(() => null);
			if (!response.ok || payload === null || payload.ok !== true) {
				throw new Error((payload && payload.error) || ("HTTP " + response.status));
			}
			return payload;
		}

		/** 带防御头的 POST (保存配置), 返回 payload (宿主侧 ok 校验)。 */
		async function postConfig(overrides) {
			const response = await fetch(ROUTE_CONFIG, {
				method: "POST",
				headers: { "content-type": "application/json", [GUARD_HEADER]: "1" },
				body: JSON.stringify(overrides),
			});
			const payload = await response.json().catch(() => null);
			if (!response.ok || payload === null || payload.ok !== true) {
				throw new Error((payload && payload.error) || ("HTTP " + response.status));
			}
			return payload;
		}

		// ---- 网络请求 ----

		/** 「一键接入」: 强制重新探测 + 全量重写 provider; 不保存表单、不动持久化配置。
		 * 宿主端返回 { config, status, providerWritten, reconnected, error? }。 */
		async function reconnectOllama() {
			const response = await fetch(ROUTE_RECONNECT, {
				method: "POST",
				headers: { [GUARD_HEADER]: "1" },
			});
			const payload = await response.json().catch(() => null);
			if (!response.ok || payload === null || payload.ok !== true) {
				throw new Error((payload && payload.error) || ("HTTP " + response.status));
			}
			return payload;
		}

		// ---- 工具 ----

		/** 把毫秒时间戳格式化为 "刚刚 / 相对时间 / 具体时间"。 */
		function fmtCheckedAt(checkedAt) {
			if (typeof checkedAt !== "number" || !isFinite(checkedAt) || checkedAt <= 0) return _dsht("plugin.ollama.status_not_checked", "尚未检测");
			const elapsedSeconds = Math.floor((Date.now() - checkedAt) / 1000);
			if (elapsedSeconds < 10) return _dsht("plugin.ollama.time_just_now", "刚刚");
			if (elapsedSeconds < 60) return _dsht("plugin.ollama.time_seconds_ago", "{n} 秒前").replace("{n}", elapsedSeconds);
			if (elapsedSeconds < 3600) return _dsht("plugin.ollama.time_minutes_ago", "{n} 分钟前").replace("{n}", Math.floor(elapsedSeconds / 60));
			try {
				return new Date(checkedAt).toLocaleString("zh-CN", { hour12: false });
			} catch (error) {
				return String(checkedAt);
			}
		}

		/** 把毫秒数格式化为可读的 "x 秒 / x 分" (供提示文案用)。 */
		function fmtInterval(ms) {
			if (typeof ms !== "number" || !isFinite(ms)) return String(ms);
			if (ms < 1000) return _dsht("plugin.ollama.time_ms", "{n} 毫秒").replace("{n}", ms);
			if (ms < 60000) return _dsht("plugin.ollama.time_s", "{n} 秒").replace("{n}", Math.round(ms / 1000));
			return _dsht("plugin.ollama.time_min", "{n} 分钟").replace("{n}", Math.round(ms / 60000));
		}

		// ---- 表单输入小部件 ----

		/** 一行表单: 左侧标签, 右侧输入框 + 可选说明文字。全部走 DSH CSS 变量, 深浅主题自动适配。 */
		function FieldRow({ label, children, hint }) {
			return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 } }, [
				react.createElement("label", { key: "l", style: { fontSize: 12, color: "var(--dsw-alias-label-primary)" } }, label),
				children,
				hint && react.createElement("span", { key: "h", style: { fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, hint),
			]);
		}

		/** 文本框输入框 (统一样式)。用 DSH 官方输入框变量, 深浅主题自动适配。 */
		function TextInput(props) {
			return react.createElement("input", Object.assign({
				type: "text",
				style: {
					padding: "5px 8px",
					border: "1px solid var(--dsw-alias-border-l2)",
					borderRadius: 5,
					fontSize: 12.5,
					background: "var(--dsw-specific-input-major)",
					color: "var(--dsw-alias-label-primary)",
					width: "100%",
					boxSizing: "border-box",
				},
			}, props));
		}

		/** 数字输入框 (统一样式, 原生步进按钮)。用 DSH 官方输入框变量, 深浅主题自动适配。 */
		function NumberInput(props) {
			return react.createElement("input", Object.assign({
				type: "number",
				style: {
					padding: "5px 8px",
					border: "1px solid var(--dsw-alias-border-l2)",
					borderRadius: 5,
					fontSize: 12.5,
					background: "var(--dsw-specific-input-major)",
					color: "var(--dsw-alias-label-primary)",
					width: 180,
					boxSizing: "border-box",
				},
			}, props));
		}

		// ---- 主设置面板 ----

		function OllamaSettingsSection() {
			// i18n 语言切换监听器: 切换语言时触发重渲染
			const [i18nTick, setI18nTick] = react.useState(0);
			react.useEffect(() => {
				const handler = () => setI18nTick((t) => t + 1);
				document.addEventListener("dsh-i18n-change", handler);
				return () => document.removeEventListener("dsh-i18n-change", handler);
			}, []);

			// 生效配置 (来自宿主端: 默认值 + cordis config + 面板持久化覆盖)
			const [config, setConfig] = react.useState(null);
			// 连接状态: { online, models, checkedAt, lastError }
			const [status, setStatus] = react.useState(null);
			// provider 是否已写入 llm-pi-ai (Models 页是否出现 Ollama 条目)
			const [providerWritten, setProviderWritten] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [savedTip, setSavedTip] = react.useState(null);
			// 表单草稿 (保存前可编辑, 保存后才写入)
			const [draft, setDraft] = react.useState(null);
			const loadedRef = react.useRef(false);

			const setDraftField = (key, value) => {
				setDraft((previous) => ({ ...previous, [key]: value }));
			};

			/** 拉取最新配置 + 状态, 填充表单。 */
			const loadAll = react.useCallback(async (silent) => {
				if (!silent) setBusy(true);
				setError(null);
				try {
					const payload = await getConfig();
					setConfig(payload.config || {});
					setStatus(payload.status || {});
					setProviderWritten(payload.providerWritten === true);
					setDraft({ ...(payload.config || {}) });
					return payload;
				} catch (err) {
					setError(_dsht("plugin.ollama.err_read", "读取配置失败: ") + String((err && err.message) || err));
					return null;
				} finally {
					setBusy(false);
				}
			}, []);

			/** 保存配置: 校验数字字段后 POST, 成功后用返回的生效配置刷新表单。 */
			const save = async () => {
				if (draft === null) return;
				setBusy(true);
				setError(null);
				setSavedTip(null);
				const overrides = { ...draft };
				// 数字字段统一转整数 (空串/非法值由宿主端校验并返回错误)。
				// 上下文/输出容量改走 target* —— 这才是 buildProviderProfile 与
				// ensureContextVariants 实际采用的生效字段; default* 仅作回退,
				// 面板不再暴露, 避免"改了不生效"的困惑 (坑 38)。
				for (const key of ["targetContextWindow", "targetMaxTokens", "detectIntervalMs", "probeTimeoutMs"]) {
					const value = overrides[key];
					if (typeof value === "string") overrides[key] = value.trim() === "" ? 0 : Number(value);
				}
				try {
					const payload = await postConfig(overrides);
					setConfig(payload.config || {});
					setStatus(payload.status || {});
					setProviderWritten(payload.providerWritten === true);
					setDraft({ ...(payload.config || {}) });
					setSavedTip(payload.error
						? _dsht("plugin.ollama.msg_saved_with_err", "已保存，但按新配置接入时出错: {{err}}").replace("{{err}}", String(payload.error))
						: _dsht("plugin.ollama.msg_saved_reconnect", "已保存，并按新配置重新接入 Ollama"));
				} catch (err) {
					setError(_dsht("plugin.ollama.err_save", "保存失败: ") + String((err && err.message) || err));
				} finally {
					setBusy(false);
				}
			};

			if (!loadedRef.current) {
				loadedRef.current = true;
				loadAll(false);
			}

			/** 「一键接入」: 强制重新探测接入, 用返回的生效配置刷新表单与状态。 */
			const reconnectNow = async () => {
				setBusy(true);
				setError(null);
				setSavedTip(null);
				try {
					const payload = await reconnectOllama();
					setConfig(payload.config || {});
					setStatus(payload.status || {});
					setProviderWritten(payload.providerWritten === true);
					setDraft({ ...(payload.config || {}) });
					// 面板顶部错误优先级最高; 其次失败/成功文案
					if (payload.error) {
						setError(String(payload.error));
					} else if (payload.reconnected === true) {
						setSavedTip(_dsht("plugin.ollama.msg_reconnected", "已重新接入 Ollama，模型已按当前配置同步"));
					} else {
						setSavedTip(_dsht("plugin.ollama.msg_reconnect_no_models", "重探完成，但未检测到可接入的 Ollama 模型"));
					}
				} catch (err) {
					setError(_dsht("plugin.ollama.err_one_click", "一键接入失败: ") + String((err && err.message) || err));
				} finally {
					setBusy(false);
				}
			};

			// ---- 样式 ----
			// 设计原则 (2026-09-02): 所有颜色走 DSH CSS 变量, 深浅主题自动切换。
			// 输入框背景用 --dsw-specific-input-major (DSH 官方输入框专用);
			// 卡片/面板背景用 --dsw-alias-bg-base;
			// 主文字用 --dsw-alias-label-primary (深主题下是亮色, 浅主题下是深色);
			// 边框用 --dsw-alias-border-l1 / border-l2。
			const rootStyle = { display: "flex", flexDirection: "column", gap: 12, padding: 4, maxWidth: 720 };
			const titleStyle = { margin: 0, fontSize: 14, fontWeight: 600, color: "var(--dsw-alias-label-primary)" };
			const descStyle = { margin: 0, fontSize: 13, lineHeight: 1.6, color: "var(--dsw-alias-label-secondary)" };
			const cardStyle = { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 6, padding: "12px 14px", background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)" };
			const btn = { padding: "6px 16px", cursor: "pointer", fontSize: 12, background: "var(--dsw-alias-button-info-fill)", color: "#ffffff", border: "none", borderRadius: 4 };
			const btnGhost = { padding: "6px 16px", cursor: "pointer", fontSize: 12, background: "transparent", color: "var(--dsw-alias-label-primary)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 4 };

			// ---- 状态卡 ----
			const statusCard = (() => {
				const online = Boolean(status && status.online);
				const models = (status && Array.isArray(status.models)) ? status.models : [];
				return react.createElement("div", { key: "status", style: cardStyle }, [
					react.createElement("div", { key: "row", style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 } }, [
						react.createElement("span", { key: "dot", style: {
							width: 9, height: 9, borderRadius: "50%", flex: "none",
							background: online ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-error-primary)",
						} }),
						react.createElement("span", { key: "txt", style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } },
							online ? _dsht("plugin.ollama.status_online", "Ollama 服务在线") : _dsht("plugin.ollama.status_offline", "Ollama 服务未检测到")),
						react.createElement("span", { key: "at", style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } },
							_dsht("plugin.ollama.status_last_check", "最近检测: {{relativeTime}}").replace("{{relativeTime}}", fmtCheckedAt(status && status.checkedAt))),
						providerWritten
							? react.createElement("span", { key: "badge", style: { fontSize: 11, color: "var(--dsw-alias-state-success-primary)", border: "1px solid var(--dsw-alias-state-success-primary)", borderRadius: 10, padding: "1px 8px" } }, _dsht("plugin.ollama.status_connected", "已接入 Models 页"))
							: react.createElement("span", { key: "badge", style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 10, padding: "1px 8px" } }, _dsht("plugin.ollama.status_not_connected", "未接入")),
						// 「一键接入」按钮: 强制按当前配置重新探测接入 (不需保存表单)。
						react.createElement("button", { key: "reconnect", type: "button", disabled: busy, onClick: reconnectNow, style: {
							padding: "4px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600,
							background: "var(--dsw-alias-state-business-primary)", color: "#ffffff", border: "none", borderRadius: 4,
						} },
							busy ? _dsht("plugin.ollama.btn_connecting", "接入中…") : _dsht("plugin.ollama.btn_one_click", "一键接入")),
					]),
					status && status.lastError
						? react.createElement("div", { key: "err", style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary)", marginBottom: 6 } }, status.lastError)
						: null,
					react.createElement("div", { key: "models", style: { display: "flex", flexWrap: "wrap", gap: 6 } }, [
						models.length === 0
							? react.createElement("span", { key: "none", style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } }, _dsht("plugin.ollama.status_no_models_yet", "尚未发现模型（服务在线后自动列出）"))
							: models.map((model) =>
								react.createElement("span", { key: model, style: {
									fontFamily: "Consolas, Menlo, monospace",
									fontSize: 11.5,
									background: "var(--dsw-alias-state-business-secondary)",
									color: "var(--dsw-alias-state-business-primary)",
									borderRadius: 4,
									padding: "2px 8px",
								} }, model)
							),
					]),
				]);
			})();

			// ---- 配置表单 ----
			const formCard = (() => {
				if (draft === null) {
					return react.createElement("div", { key: "loading", style: { padding: 12, color: "var(--dsw-alias-label-tertiary)" } }, _dsht("plugin.ollama.btn_loading", "加载中…"));
				}
				return react.createElement("div", { key: "form", style: cardStyle }, [
					react.createElement("div", { key: "enable", style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12 } }, [
						react.createElement("input", { type: "checkbox", id: "ollama-enabled", checked: Boolean(draft.enabled), onChange: (e) => setDraftField("enabled", e.target.checked) }),
						react.createElement("label", { htmlFor: "ollama-enabled", style: { fontSize: 13, color: "var(--dsw-alias-label-primary)", cursor: "pointer" } }, _dsht("plugin.ollama.label_enable", "启用自动识别 Ollama")),
					]),
					react.createElement(FieldRow, { key: "baseUrl", label: _dsht("plugin.ollama.label_endpoint", "Ollama 服务地址"), hint: _dsht("plugin.ollama.hint_endpoint", "Ollama 原生接口根地址，不含 /v1。默认 http://localhost:11434（本机默认端口）；远程/自定义端口请按 http://主机:端口 填写。") },
						react.createElement(TextInput, { value: draft.baseUrl || "", onChange: (e) => setDraftField("baseUrl", e.target.value) })
					),
					react.createElement(FieldRow, { key: "displayName", label: _dsht("plugin.ollama.label_display_name", "Models 页显示名称"), hint: _dsht("plugin.ollama.hint_display_name", "模型选择页里该提供方显示的名字。") },
						react.createElement(TextInput, { value: draft.displayName || "", onChange: (e) => setDraftField("displayName", e.target.value) })
					),
					react.createElement("div", { key: "nums", style: { display: "flex", gap: 16, flexWrap: "wrap" } }, [
						react.createElement(FieldRow, { key: "ctx", label: _dsht("plugin.ollama.label_ctx_window", "目标上下文窗口 (tokens)"), hint: _dsht("plugin.ollama.hint_ctx_window", "生效值：写入 Models 页模型容量 + 自动创建变体固化的 num_ctx。") },
							react.createElement(NumberInput, { min: 1024, value: draft.targetContextWindow || "", onChange: (e) => setDraftField("targetContextWindow", e.target.value) })
						),
						react.createElement(FieldRow, { key: "max", label: _dsht("plugin.ollama.label_max_output", "目标最大输出 (tokens)"), hint: _dsht("plugin.ollama.hint_max_output", "生效值：单次输出上限，必须远小于上下文窗口（如 32768/8192），否则输入空间为零必截断。") },
							react.createElement(NumberInput, { min: 256, value: draft.targetMaxTokens || "", onChange: (e) => setDraftField("targetMaxTokens", e.target.value) })
						),
					]),
					react.createElement("div", { key: "times", style: { display: "flex", gap: 16, flexWrap: "wrap" } }, [
						react.createElement(FieldRow, { key: "detect", label: _dsht("plugin.ollama.label_probe_interval", "探测间隔 (毫秒)"), hint: _dsht("plugin.ollama.hint_probe_interval", "周期探测 Ollama 的间隔。改小则模型增删同步更快，但更耗资源。") },
							react.createElement(NumberInput, { min: 1000, value: draft.detectIntervalMs || "", onChange: (e) => setDraftField("detectIntervalMs", e.target.value) })
						),
						react.createElement(FieldRow, { key: "probe", label: _dsht("plugin.ollama.label_probe_timeout", "探测超时 (毫秒)") },
							react.createElement(NumberInput, { min: 200, value: draft.probeTimeoutMs || "", onChange: (e) => setDraftField("probeTimeoutMs", e.target.value) })
						),
					]),
					react.createElement(FieldRow, { key: "auth", label: _dsht("plugin.ollama.label_auth_header", "授权请求头 (Authorization)"), hint: _dsht("plugin.ollama.hint_auth", "pi-ai 的 openai-completions 协议要求请求必须带 apiKey 或 authorization 头才放行，Ollama 不校验该头、值可任意。走自定义网关/中间件时可改为真实鉴权头，留空表示不发。") },
						react.createElement(TextInput, { value: draft.authorizationHeader || "", placeholder: _dsht("plugin.ollama.placeholder_auth", "Bearer ollama-local"), onChange: (e) => setDraftField("authorizationHeader", e.target.value) })
					),
				]);
			})();

			return react.createElement("div", { style: rootStyle }, [
				react.createElement("p", { key: "title", style: titleStyle }, _dsht("plugin.ollama.title", "Ollama 设置")),
				react.createElement("p", { key: "desc", style: descStyle },
					_dsht("plugin.ollama.desc", "自动识别本机 Ollama 服务并接入 DSH：在线时自动把 Ollama 注册为 OpenAI 兼容 Provider（写入 llm-pi-ai 配置），WebUI「Models」设置页即可选择 Ollama 模型并发起对话；模型有增删时按探测间隔自动同步。修改下方配置并保存后立即生效（无需重启服务），并自动按新配置重新接入。")
				),
				error !== null && react.createElement("p", { key: "err", style: { color: "var(--dsw-alias-state-error-primary)", margin: 0, fontSize: 13 } }, error),
				statusCard,
				formCard,
				react.createElement("div", { key: "ops", style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } }, [
					react.createElement("button", { key: "save", type: "button", disabled: busy, onClick: save, style: { ...btn, fontWeight: 600 } },
						busy ? _dsht("plugin.ollama.btn_processing", "处理中…") : _dsht("plugin.ollama.btn_save", "保存设置")
					),
					react.createElement("button", { key: "refresh", type: "button", disabled: busy, onClick: () => loadAll(false), style: btnGhost },
						busy ? _dsht("plugin.ollama.btn_processing", "处理中…") : _dsht("plugin.ollama.btn_refresh", "刷新状态")
					),
					savedTip !== null && react.createElement("span", { key: "tip", style: { fontSize: 11, color: "var(--dsw-alias-state-success-primary)" } }, savedTip),
					config !== null && react.createElement("span", { key: "interval", style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } },
						_dsht("plugin.ollama.status_interval_fmt", "当前探测间隔: {{fmtInterval}}").replace("{{fmtInterval}}", fmtInterval(config.detectIntervalMs))
					),
				]),
			]);
		}

		// ---- 插件契约 ----
		function apply(ctx) {
			function _doRegisterOllamaSettingsSection() {
			    ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-ollama",
				order: 520,
				label: () => _tabLabel("plugin.ollama.title", "Ollama 设置"),
			}, OllamaSettingsSection));
			}
			if (window.__DSH_I18N__ && window.__DSH_I18N__._initialized) {
			    _doRegisterOllamaSettingsSection();
			} else {
			    var _checkOllamaSettingsSection = setInterval(function() {
			        if (window.__DSH_I18N__ && window.__DSH_I18N__._initialized) {
			            clearInterval(_checkOllamaSettingsSection);
			            _doRegisterOllamaSettingsSection();
			        }
			    }, 50);
			    }
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
