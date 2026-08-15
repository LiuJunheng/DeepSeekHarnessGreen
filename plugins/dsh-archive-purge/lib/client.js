// DeepSeek Harness 插件 (客户端): dsh-archive-purge
// 在「设置」面板注册一个「清理归档」页面: 归档会话列表 (勾选) + 操作按钮。
// GET  /__dsh/archive-purge 列出已归档会话;
// POST /__dsh/archive-purge {"ids": [...]} 删除所选, 省略 ids 则清空全部。
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
			// 状态: sessions 列表, 勾选集合, 加载/执行/网络状态
			const [sessions, setSessions] = react.useState(null);  // null = 加载中, [] = 无归档
			const [selected, setSelected] = react.useState({});
			const [busy, setBusy] = react.useState(false);
			const [result, setResult] = react.useState(null);
			const [error, setError] = react.useState(null);
			// 是否已加载 (首次加载后不再自动刷新, 由用户操作触发)
			const loadedRef = react.useRef(false);

			// 加载归档会话列表
			const loadList = react.useCallback(async () => {
				setBusy(true);
				setError(null);
				setResult(null);
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

			// 删除操作: 有勾选时只删勾选, 无勾选时删全部 (需二次确认)
			const runDelete = async (deleteAll) => {
				const hasSelection = Object.keys(selected).length > 0;
				const ids = hasSelection ? Object.keys(selected) : undefined;
				const label = ids ? "所选" : "全部";
				const msg = ids
					? ("确定要永久删除" + label + "的 " + ids.length + " 个已归档会话吗？\n\n" +
					   "会话日志文件与工作区注册表条目将一并删除, 不可恢复。\n" +
					   "正在运行的会话会自动跳过。")
					: ("确定要永久删除" + label + "已归档会话吗？\n\n" +
					   "会话日志文件与工作区注册表条目将一并删除, 不可恢复。\n" +
					   "正在运行的会话会自动跳过。");
				if (!window.confirm(msg)) return;

				setBusy(true);
				setError(null);
				setResult(null);
				try {
					const body = ids ? JSON.stringify({ ids: ids }) : "{}";
					const response = await fetch(ROUTE_PATH, {
						method: "POST",
						headers: { [GUARD_HEADER]: "1", "content-type": "application/json" },
						body: body
					});
					const payload = await response.json().catch(() => null);
					if (!response.ok || payload === null || payload.ok !== true) {
						throw new Error((payload && payload.error) || ("HTTP " + response.status));
					}
					setResult(payload);
					// 删除成功后重新加载列表
					await loadList();
				} catch (err) {
					setError("删除失败: " + String((err && err.message) || err));
				} finally {
					setBusy(false);
				}
			};

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
					"永久删除已归档（隐藏）的会话：会话日志文件与工作区注册表条目一并清除, 不可恢复。" +
					"正在运行的会话会自动跳过。勾选要删除的会话后点击「删除所选」, 或直接点击「清空全部」。"
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
				// 操作按钮行
				Array.isArray(sessions) && react.createElement(
					"div",
					{ style: { display: "flex", gap: 10, alignItems: "center" } },
					react.createElement(
						"button",
						{
							type: "button",
							disabled: busy || sessions.length === 0,
							onClick: () => runDelete(false),
							style: {
								padding: "6px 16px",
								cursor: (busy || sessions.length === 0) ? "default" : "pointer"
							}
						},
						busy ? "删除中…" : (Object.keys(selected).length > 0
							? "删除所选 (" + Object.keys(selected).length + ")"
							: "清空全部")
					),
					react.createElement(
						"button",
						{
							type: "button",
							disabled: busy || sessions.length === 0,
							onClick: loadList,
							style: {
								padding: "6px 16px",
								cursor: (busy || sessions.length === 0) ? "default" : "pointer"
							}
						},
						"刷新列表"
					)
				),
				// 结果摘要
				result !== null && react.createElement(
					"div",
					{ style: { fontSize: 13, lineHeight: 1.6, background: "#eaf7ea", padding: "8px 12px", borderRadius: 4 } },
					react.createElement(
						"p",
						{ style: { margin: "4px 0", color: "#27ae60" } },
						"完成：共 " + result.total + " 个归档会话；已删除 " + result.deleted +
						" 个，仅摘除记录 " + result.detachedOnly + " 个，跳过运行中 " +
						result.skippedLive + " 个，错误 " + result.errors + " 个。"
					),
					Array.isArray(result.results) && result.results.length > 0 && react.createElement(
						"ul",
						{ style: { margin: "4px 0 0 0", paddingLeft: 18, maxHeight: 160, overflowY: "auto" } },
						result.results.map((r) => react.createElement(
							"li",
							{ key: r.id },
							r.id + " — " + r.status + (r.note ? "（" + r.note + "）" : "")
						))
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