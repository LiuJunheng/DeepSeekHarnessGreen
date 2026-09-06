// DeepSeek Harness 插件 (客户端): dsh-archive-purge
// 在「设置」面板注册一个「清理归档」页面: 只读展示归档会话列表。
// 说明: 实际启动时会话处于"运行中", WebUI 无法删除或恢复;
//       永久删除 / 恢复请在启动器 GUI 界面操作 (先停止服务 → 数据维护 → 会话管理)。
// GET /__dsh/archive-purge 仅用于列出已归档会话供查看。
// 这是加载器契约格式 (window.__ModuleLoader__.load), 与官方客户端插件一致。

// i18n 工具函数: 优先读 window.__DSH_I18N__ (启动器桌面壳注入), 无则 fallback 到 key 本身
// 浏览器方式 (webbrowser.open) 无此 bridge, 所有 fallback 到硬编码字符串时会显示中文 (默认行为)。
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
	id: "dsh-archive-purge",
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

		const ROUTE_PATH = "/__dsh/archive-purge";
		const GUARD_HEADER = "X-DSH-Plugin-Purge";

		/** 设置页「清理归档」区块内容。 */
		function PurgeSection() {
			const [sessions, setSessions] = react.useState(null);
			const [selected, setSelected] = react.useState({});
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [i18nTick, setI18nTick] = react.useState(0);
			const loadedRef = react.useRef(false);

			// 监听 WebUI 官方语言切换事件, 触发插件重渲染
			react.useEffect(() => {
				const handler = () => setI18nTick((t) => t + 1);
				document.addEventListener("dsh-i18n-change", handler);
				return () => document.removeEventListener("dsh-i18n-change", handler);
			}, []);

			const loadList = react.useCallback(async () => {
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
					const list = Array.isArray(payload.sessions) ? payload.sessions : [];
					setSessions(list);
					setSelected({});
				} catch (err) {
					setError(_dsht("plugin.archive_purge.load_failed", "加载失败") + ": " + String((err && err.message) || err));
				} finally {
					setBusy(false);
				}
			}, []);

			if (!loadedRef.current) {
				loadedRef.current = true;
				loadList();
			}

			const toggle = (id) => {
				setSelected((prev) => {
					const next = { ...prev };
					if (next[id]) {
						delete next[id];
					} else {
						next[id] = true;
					}
					return next;
				});
			};

			const toggleAll = () => {
				if (!sessions || sessions.length === 0) return;
				const allSelected = sessions.every((s) => selected[s.id]);
				if (allSelected) {
					setSelected({});
				} else {
					const all = {};
					for (const s of sessions) {
						all[s.id] = true;
					}
					setSelected(all);
				}
			};

			const listStyle = {
				border: "1px solid var(--dsw-alias-border-l1)",
				borderRadius: 4,
				maxHeight: 320,
				overflowY: "auto",
				fontSize: 13,
				lineHeight: 1.6,
				background: "var(--dsw-alias-bg-layer-2)"
			};
			const rowBase = {
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "6px 10px",
				borderBottom: "1px solid var(--dsw-alias-border-l1)",
				cursor: "pointer"
			};
			const labelStyle = {
				flex: 1,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			};
			const runningStyle = {
				fontSize: 11,
				color: "var(--dsw-alias-state-success-primary)",
				marginLeft: 6
			};
			const wsStyle = {
				fontSize: 11,
				color: "var(--dsw-alias-label-tertiary)",
				marginLeft: 6
			};

			return react.createElement(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: 10, padding: 4, maxWidth: 640 } },
				react.createElement(
					"p",
					{ style: { margin: 0, fontSize: 13, lineHeight: 1.5 } },
					_dsht("plugin.archive_purge.hint",
						"这里列出的是已归档（隐藏）的会话。当前服务处于运行中, WebUI 无法在此直接删除或恢复。" +
						"如需永久删除或恢复, 请在本机的启动器 GUI 操作：先点击「停止服务」, 再在「数据维护」区点击「会话管理」, " +
						"勾选会话后可选择「恢复选中」（取消归档, 不删数据）或「删除选中」（永久删除, 不可恢复）。")
				),
				sessions === null && !error && react.createElement(
					"p",
					{ style: { color: "var(--dsw-alias-label-secondary)", margin: 0, fontSize: 13 } },
					busy ? _dsht("plugin.archive_purge.loading", "加载中…") : _dsht("plugin.archive_purge.loading", "加载中…")
				),
				error !== null && react.createElement(
					"p",
					{ style: { color: "var(--dsw-alias-state-error-primary)", margin: 0, fontSize: 13 } },
					error
				),
				Array.isArray(sessions) && sessions.length > 0 && react.createElement(
					"div",
					{ style: listStyle },
					react.createElement(
						"div",
						{
							key: "__all__",
							style: { ...rowBase, background: "var(--dsw-alias-interactive-bg-hover)", fontWeight: "bold" },
							onClick: toggleAll
						},
						react.createElement("input", {
							type: "checkbox",
							checked: sessions.length > 0 && sessions.every((s) => selected[s.id]),
							onChange: toggleAll,
							style: { cursor: "pointer", margin: 0 },
							onClick: (e) => e.stopPropagation()
						}),
						react.createElement("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } },
							_dsht("plugin.archive_purge.select_all", "全选 / 全不选")),
						react.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginLeft: "auto" } },
							_dsht("plugin.archive_purge.total_count_fmt", "共 {count} 个归档会话").replace("{count}", sessions.length))
					),
					sessions.map((s) => react.createElement(
						"div",
						{
							key: s.id,
							style: rowBase,
							onClick: () => toggle(s.id)
						},
						react.createElement("input", {
							type: "checkbox",
							checked: !!selected[s.id],
							onChange: () => toggle(s.id),
							style: { cursor: "pointer", margin: 0 },
							onClick: (e) => e.stopPropagation()
						}),
						react.createElement(
							"span",
							{ style: labelStyle, title: s.id + (s.displayTitle ? " - " + s.displayTitle : "") },
							s.displayTitle || _dsht("plugin.archive_purge.no_title", "(无标题)"),
							react.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginLeft: 4 } },
								s.id.slice(0, 28) + "…")
						),
						s.running && react.createElement("span", { style: runningStyle },
							_dsht("plugin.archive_purge.running_tag", "[运行中]")),
						s.workspaceTitle && react.createElement("span", { style: wsStyle },
							"(" + s.workspaceTitle + ")")
					))
				),
				Array.isArray(sessions) && sessions.length === 0 && !error && react.createElement(
					"p",
					{ style: { color: "var(--dsw-alias-label-secondary)", margin: 0, fontSize: 13 } },
					_dsht("plugin.archive_purge.no_archived", "没有已归档的会话。")
				),
				react.createElement(
					"div",
					{ style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
					react.createElement(
						"span",
						{ style: { fontSize: 13, color: "var(--dsw-alias-state-business-primary)", background: "var(--dsw-alias-state-business-secondary)", padding: "6px 12px", borderRadius: 4 } },
						_dsht("plugin.archive_purge.action_hint", "删除/恢复请到启动器 GUI: 停止服务 → 「数据维护」→「会话管理」")
					),
					react.createElement(
						"button",
						{
							type: "button",
							disabled: busy,
							onClick: loadList,
							style: { padding: "6px 16px", cursor: busy ? "default" : "pointer" }
						},
						busy
							? _dsht("plugin.archive_purge.refreshing", "刷新中…")
							: _dsht("plugin.archive_purge.refresh_btn", "刷新列表")
					)
				)
			);
		}

		function apply(ctx) {
			function _doRegisterPurgeSection() {
			    ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "archive-purge",
				order: 500,
				label: _dsht("plugin.archive_purge.tab_label", "清理归档")
			}, PurgeSection));
			}
			if (window.__DSH_I18N__ && window.__DSH_I18N__._initialized) {
			    _doRegisterPurgeSection();
			} else {
			    var _checkPurgeSection = setInterval(function() {
			        if (window.__DSH_I18N__ && window.__DSH_I18N__._initialized) {
			            clearInterval(_checkPurgeSection);
			            _doRegisterPurgeSection();
			        }
			    }, 50);
			    }
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
