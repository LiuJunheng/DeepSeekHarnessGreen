// DeepSeek Harness 插件 (客户端): dsh-archive-purge
// 在「设置」面板注册一个「清理归档」页面: 只读展示归档会话列表。
// 说明: 实际启动时会话处于"运行中", WebUI 无法清理;
//       永久删除请在启动器 GUI 界面操作 (先停止服务 → 数据维护 → 清理归档)。
// GET /__dsh/archive-purge 仅用于列出已归档会话供查看。
// 这是加载器契约格式 (window.__ModuleLoader__.load), 与官方客户端插件一致。

window.__ModuleLoader__.load({
	id: "dsh-archive-purge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const inject = ["slots"];

		const ROUTE_PATH = "/__dsh/archive-purge";
		const GUARD_HEADER = "X-DSH-Plugin-Purge";

		/** 设置页「清理归档」区块内容。 */
		function PurgeSection() {
			// 状态: sessions 列表, 勾选集合, 加载/网络状态 (只读展示, 不执行删除)
			const [sessions, setSessions] = react.useState(null);  // null = 加载中, [] = 无归档
			const [selected, setSelected] = react.useState({});
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);
			// 是否已加载 (首次加载后不再自动刷新, 由用户操作触发)
			const loadedRef = react.useRef(false);

			// 加载归档会话列表
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
					// 清空旧勾选
					setSelected({});
				} catch (err) {
					setError("加载失败: " + String((err && err.message) || err));
				} finally {
					setBusy(false);
				}
			}, []);

			// 首次挂载加载
			if (!loadedRef.current) {
				loadedRef.current = true;
				loadList();
			}

			// 切换勾选
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

			// 全选 / 全不选
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

			// 说明: WebUI 只读展示归档会话, 不提供删除 (实际启动时会话处于运行中无法清理)。
			// 永久删除请在启动器 GUI 界面操作: 先停止服务 → 「数据维护」区 → 清理归档。

			// 样式: 列表容器
			const listStyle = {
				border: "1px solid #ddd",
				borderRadius: 4,
				maxHeight: 320,
				overflowY: "auto",
				fontSize: 13,
				lineHeight: 1.6,
				background: "#fafafa"
			};
			// 行样式
			const rowBase = {
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "6px 10px",
				borderBottom: "1px solid #eee",
				cursor: "pointer"
			};
			// 标签文字 (会话 id + 标题)
			const labelStyle = {
				flex: 1,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			};
			// 运行中标记
			const runningStyle = {
				fontSize: 11,
				color: "#e67e22",
				marginLeft: 6
			};
			// 工作区标记
			const wsStyle = {
				fontSize: 11,
				color: "#888",
				marginLeft: 6
			};

			return react.createElement(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: 10, padding: 4, maxWidth: 640 } },
				// 说明文字
				react.createElement(
					"p",
					{ style: { margin: 0, fontSize: 13, lineHeight: 1.5 } },
					"此页面仅用于查看已归档（隐藏）的会话。由于当前服务处于运行中, 归档会话无法在此直接删除。" +
					"如需永久清理, 请在本机的启动器 GUI 界面操作：先点击「停止服务」, 再在「数据维护」区点击「清理归档」, " +
					"勾选要删除的会话后永久删除（日志与注册表条目一并清除, 不可恢复）。"
				),
				// 加载中提示
				sessions === null && !error && react.createElement(
					"p",
					{ style: { color: "#888", margin: 0, fontSize: 13 } },
					busy ? "加载中…" : "加载中…"
				),
				// 错误提示
				error !== null && react.createElement(
					"p",
					{ style: { color: "#c0392b", margin: 0, fontSize: 13 } },
					error
				),
				// 列表
				Array.isArray(sessions) && sessions.length > 0 && react.createElement(
					"div",
					{ style: listStyle },
					// 全选行
					react.createElement(
						"div",
						{
							key: "__all__",
							style: { ...rowBase, background: "#f0f0f0", fontWeight: "bold" },
							onClick: toggleAll
						},
						react.createElement("input", {
							type: "checkbox",
							checked: sessions.length > 0 && sessions.every((s) => selected[s.id]),
							onChange: toggleAll,
							style: { cursor: "pointer", margin: 0 },
							onClick: (e) => e.stopPropagation()
						}),
						react.createElement("span", { style: { fontSize: 12, color: "#555" } }, "全选 / 全不选"),
						react.createElement("span", { style: { fontSize: 11, color: "#999", marginLeft: "auto" } },
							"共 " + sessions.length + " 个归档会话")
					),
					// 会话行
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
							{ style: labelStyle, title: s.id + (s.title ? " - " + s.title : "") },
							s.title || "(无标题)",
							react.createElement("span", { style: { fontSize: 11, color: "#aaa", marginLeft: 4 } },
								s.id.slice(0, 28) + "…")
						),
						s.running && react.createElement("span", { style: runningStyle }, "[运行中]"),
						s.workspaceTitle && react.createElement("span", { style: wsStyle },
							"(" + s.workspaceTitle + ")")
					))
				),
				// 无归档提示
				Array.isArray(sessions) && sessions.length === 0 && !error && react.createElement(
					"p",
					{ style: { color: "#888", margin: 0, fontSize: 13 } },
					"没有已归档的会话。"
				),
				// 操作提示 + 刷新按钮 (仅查看, 不提供删除)
				react.createElement(
					"div",
					{ style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
					react.createElement(
						"span",
						{ style: { fontSize: 13, color: "#b8860b", background: "#fdf6e3", padding: "6px 12px", borderRadius: 4 } },
						"删除功能已移至启动器 GUI：停止服务 → 「数据维护」→「清理归档」"
					),
					react.createElement(
						"button",
						{
							type: "button",
							disabled: busy,
							onClick: loadList,
							style: { padding: "6px 16px", cursor: busy ? "default" : "pointer" }
						},
						busy ? "刷新中…" : "刷新列表"
					)
				)
			);
		}

		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "archive-purge",
				order: 500,
				label: "清理归档"
			}, PurgeSection));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});