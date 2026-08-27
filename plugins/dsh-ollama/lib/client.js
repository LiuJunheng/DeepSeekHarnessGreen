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

window.__ModuleLoader__.load({
	id: "dsh-ollama",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const inject = ["slots"];

		// 宿主端设置路由与防御头 (与 lib/index.js 保持一致)。
		const ROUTE_CONFIG = "/__dsh/ollama/config";
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

		// ---- 工具 ----

		/** 把毫秒时间戳格式化为 "刚刚 / 相对时间 / 具体时间"。 */
		function fmtCheckedAt(checkedAt) {
			if (typeof checkedAt !== "number" || !isFinite(checkedAt) || checkedAt <= 0) return "尚未检测";
			const elapsedSeconds = Math.floor((Date.now() - checkedAt) / 1000);
			if (elapsedSeconds < 10) return "刚刚";
			if (elapsedSeconds < 60) return elapsedSeconds + " 秒前";
			if (elapsedSeconds < 3600) return Math.floor(elapsedSeconds / 60) + " 分钟前";
			try {
				return new Date(checkedAt).toLocaleString("zh-CN", { hour12: false });
			} catch (error) {
				return String(checkedAt);
			}
		}

		/** 把毫秒数格式化为可读的 "x 秒 / x 分" (供提示文案用)。 */
		function fmtInterval(ms) {
			if (typeof ms !== "number" || !isFinite(ms)) return String(ms);
			if (ms < 1000) return ms + " 毫秒";
			if (ms < 60000) return (ms / 1000) + " 秒";
			return (ms / 60000) + " 分钟";
		}

		// ---- 表单输入小部件 ----

		/** 一行表单: 左侧标签, 右侧输入框 + 可选说明文字。 */
		function FieldRow({ label, children, hint }) {
			return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 } }, [
				react.createElement("label", { key: "l", style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, label),
				children,
				hint && react.createElement("span", { key: "h", style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } }, hint),
			]);
		}

		/** 文本框输入框 (统一样式)。 */
		function TextInput(props) {
			return react.createElement("input", Object.assign({
				type: "text",
				style: {
					padding: "5px 8px",
					border: "1px solid #d0d0d0",
					borderRadius: 5,
					fontSize: 12.5,
					background: "#ffffff",
					color: "#1f1f1f",
					width: "100%",
					boxSizing: "border-box",
				},
			}, props));
		}

		/** 数字输入框 (统一样式, 原生步进按钮)。 */
		function NumberInput(props) {
			return react.createElement("input", Object.assign({
				type: "number",
				style: {
					padding: "5px 8px",
					border: "1px solid #d0d0d0",
					borderRadius: 5,
					fontSize: 12.5,
					background: "#ffffff",
					color: "#1f1f1f",
					width: 180,
					boxSizing: "border-box",
				},
			}, props));
		}

		// ---- 主设置面板 ----

		function OllamaSettingsSection() {
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
					setError("读取配置失败: " + String((err && err.message) || err));
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
				// 数字字段统一转整数 (空串/非法值由宿主端校验并返回错误)
				for (const key of ["defaultContextWindow", "defaultMaxTokens", "detectIntervalMs", "probeTimeoutMs"]) {
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
						? "已保存，但按新配置接入时出错: " + payload.error
						: "已保存，并按新配置重新接入 Ollama");
				} catch (err) {
					setError("保存失败: " + String((err && err.message) || err));
				} finally {
					setBusy(false);
				}
			};

			if (!loadedRef.current) {
				loadedRef.current = true;
				loadAll(false);
			}

			// ---- 样式 ----
			const rootStyle = { display: "flex", flexDirection: "column", gap: 12, padding: 4, maxWidth: 720 };
			const titleStyle = { margin: 0, fontSize: 14, fontWeight: 600, color: "var(--dsw-alias-label-primary)" };
			const descStyle = { margin: 0, fontSize: 13, lineHeight: 1.6, color: "var(--dsw-alias-label-secondary)" };
			const cardStyle = { border: "1px solid #dddddd", borderRadius: 6, padding: "12px 14px", background: "#ffffff" };
			const btn = { padding: "6px 16px", cursor: "pointer", fontSize: 12 };

			// ---- 状态卡 ----
			const statusCard = (() => {
				const online = Boolean(status && status.online);
				const models = (status && Array.isArray(status.models)) ? status.models : [];
				return react.createElement("div", { key: "status", style: cardStyle }, [
					react.createElement("div", { key: "row", style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 } }, [
						react.createElement("span", { key: "dot", style: {
							width: 9, height: 9, borderRadius: "50%", flex: "none",
							background: online ? "#2ecc71" : "#c0392b",
						} }),
						react.createElement("span", { key: "txt", style: { fontSize: 13, fontWeight: 600, color: "#1f1f1f" } },
							online ? "Ollama 服务在线" : "Ollama 服务未检测到"),
						react.createElement("span", { key: "at", style: { fontSize: 11, color: "#8a8f98" } },
							"最近检测: " + fmtCheckedAt(status && status.checkedAt)),
						providerWritten
							? react.createElement("span", { key: "badge", style: { fontSize: 11, color: "#2ecc71", border: "1px solid #2ecc71", borderRadius: 10, padding: "1px 8px" } }, "已接入 Models 页")
							: react.createElement("span", { key: "badge", style: { fontSize: 11, color: "#8a8f98", border: "1px solid #cccccc", borderRadius: 10, padding: "1px 8px" } }, "未接入"),
					]),
					status && status.lastError
						? react.createElement("div", { key: "err", style: { fontSize: 12, color: "#c0392b", marginBottom: 6 } }, status.lastError)
						: null,
					react.createElement("div", { key: "models", style: { display: "flex", flexWrap: "wrap", gap: 6 } }, [
						models.length === 0
							? react.createElement("span", { key: "none", style: { fontSize: 12, color: "#8a8f98" } }, "尚未发现模型（服务在线后自动列出）")
							: models.map((model) =>
								react.createElement("span", { key: model, style: {
									fontFamily: "Consolas, Menlo, monospace",
									fontSize: 11.5,
									background: "#f0f4f8",
									color: "#1f4973",
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
					return react.createElement("div", { key: "loading", style: { padding: 12, color: "var(--dsw-alias-label-tertiary)" } }, "加载中…");
				}
				return react.createElement("div", { key: "form", style: cardStyle }, [
					react.createElement("div", { key: "enable", style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12 } }, [
						react.createElement("input", { type: "checkbox", id: "ollama-enabled", checked: Boolean(draft.enabled), onChange: (e) => setDraftField("enabled", e.target.checked) }),
						react.createElement("label", { htmlFor: "ollama-enabled", style: { fontSize: 13, color: "#1f1f1f", cursor: "pointer" } }, "启用自动识别 Ollama"),
					]),
					react.createElement(FieldRow, { key: "baseUrl", label: "Ollama 服务地址", hint: "Ollama 原生接口根地址，不含 /v1。默认 http://localhost:11434（本机默认端口）；远程/自定义端口请按 http://主机:端口 填写。" },
						react.createElement(TextInput, { value: draft.baseUrl || "", onChange: (e) => setDraftField("baseUrl", e.target.value) })
					),
					react.createElement(FieldRow, { key: "displayName", label: "Models 页显示名称", hint: "模型选择页里该提供方显示的名字。" },
						react.createElement(TextInput, { value: draft.displayName || "", onChange: (e) => setDraftField("displayName", e.target.value) })
					),
					react.createElement("div", { key: "nums", style: { display: "flex", gap: 16, flexWrap: "wrap" } }, [
						react.createElement(FieldRow, { key: "ctx", label: "默认上下文窗口 (tokens)" },
							react.createElement(NumberInput, { min: 1, value: draft.defaultContextWindow || "", onChange: (e) => setDraftField("defaultContextWindow", e.target.value) })
						),
						react.createElement(FieldRow, { key: "max", label: "默认最大输出 (tokens)" },
							react.createElement(NumberInput, { min: 1, value: draft.defaultMaxTokens || "", onChange: (e) => setDraftField("defaultMaxTokens", e.target.value) })
						),
					]),
					react.createElement("div", { key: "times", style: { display: "flex", gap: 16, flexWrap: "wrap" } }, [
						react.createElement(FieldRow, { key: "detect", label: "探测间隔 (毫秒)", hint: "周期探测 Ollama 的间隔。改小则模型增删同步更快，但更耗资源。" },
							react.createElement(NumberInput, { min: 1000, value: draft.detectIntervalMs || "", onChange: (e) => setDraftField("detectIntervalMs", e.target.value) })
						),
						react.createElement(FieldRow, { key: "probe", label: "探测超时 (毫秒)" },
							react.createElement(NumberInput, { min: 200, value: draft.probeTimeoutMs || "", onChange: (e) => setDraftField("probeTimeoutMs", e.target.value) })
						),
					]),
					react.createElement(FieldRow, { key: "auth", label: "授权请求头 (Authorization)", hint: "pi-ai 的 openai-completions 协议要求请求必须带 apiKey 或 authorization 头才放行，Ollama 不校验该头、值可任意。走自定义网关/中间件时可改为真实鉴权头，留空表示不发。" },
						react.createElement(TextInput, { value: draft.authorizationHeader || "", placeholder: "Bearer ollama-local", onChange: (e) => setDraftField("authorizationHeader", e.target.value) })
					),
				]);
			})();

			return react.createElement("div", { style: rootStyle }, [
				react.createElement("p", { key: "title", style: titleStyle }, "Ollama 设置"),
				react.createElement("p", { key: "desc", style: descStyle },
					"自动识别本机 Ollama 服务并接入 DSH：在线时自动把 Ollama 注册为 OpenAI 兼容 Provider（写入 llm-pi-ai 配置），" +
					"WebUI「Models」设置页即可选择 Ollama 模型并发起对话；模型有增删时按探测间隔自动同步。" +
					"修改下方配置并保存后立即生效（无需重启服务），并自动按新配置重新接入。"
				),
				error !== null && react.createElement("p", { key: "err", style: { color: "var(--dsw-alias-state-error-primary)", margin: 0, fontSize: 13 } }, error),
				statusCard,
				formCard,
				react.createElement("div", { key: "ops", style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } }, [
					react.createElement("button", { key: "save", type: "button", disabled: busy, onClick: save, style: { ...btn, fontWeight: 600 } },
						busy ? "处理中…" : "保存设置"
					),
					react.createElement("button", { key: "refresh", type: "button", disabled: busy, onClick: () => loadAll(false), style: btn },
						busy ? "处理中…" : "刷新状态"
					),
					savedTip !== null && react.createElement("span", { key: "tip", style: { fontSize: 11, color: "#2ecc71" } }, savedTip),
					config !== null && react.createElement("span", { key: "interval", style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } },
						"当前探测间隔: " + fmtInterval(config.detectIntervalMs)
					),
				]),
			]);
		}

		// ---- 插件契约 ----
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-ollama",
				order: 520,
				label: "Ollama 设置",
			}, OllamaSettingsSection));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
