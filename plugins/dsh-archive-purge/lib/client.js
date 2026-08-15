// DeepSeek Harness 插件 (客户端): dsh-archive-purge
// 在「设置」面板注册一个「清理归档」页面: 一个按钮 + 结果展示。
// 调用宿主端路由 /__dsh/archive-purge 执行永久删除。
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
			const [busy, setBusy] = react.useState(false);
			const [result, setResult] = react.useState(null);
			const [error, setError] = react.useState(null);

			const run = async () => {
				if (busy) return;
				if (!window.confirm(
					"确定要永久删除所有已归档的会话吗？\n\n" +
					"会话日志文件与工作区注册表条目将一并删除，不可恢复。\n" +
					"正在运行的会话会自动跳过。"
				)) return;
				setBusy(true);
				setError(null);
				setResult(null);
				try {
					const response = await fetch(ROUTE_PATH, {
						method: "POST",
						headers: { [GUARD_HEADER]: "1" }
					});
					const payload = await response.json().catch(() => null);
					if (!response.ok || payload === null || payload.ok !== true) {
						throw new Error((payload && payload.error) || ("HTTP " + response.status));
					}
					setResult(payload);
				} catch (err) {
					setError(String((err && err.message) || err));
				} finally {
					setBusy(false);
				}
			};

			return react.createElement(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: 12, padding: 4, maxWidth: 560 } },
				react.createElement(
					"p",
					{ style: { margin: 0 } },
					"永久删除所有已归档（隐藏）的会话：会话日志文件与工作区注册表条目一并清除，不可恢复。正在运行的会话会自动跳过。"
				),
				react.createElement(
					"button",
					{
						type: "button",
						disabled: busy,
						onClick: run,
						style: {
							alignSelf: "flex-start",
							padding: "6px 16px",
							cursor: busy ? "default" : "pointer"
						}
					},
					busy ? "清理中…" : "立即清理归档会话"
				),
				error !== null && react.createElement(
					"p",
					{ style: { color: "#c0392b", margin: 0 } },
					"失败：" + error
				),
				result !== null && react.createElement(
					"div",
					{ style: { fontSize: 13, lineHeight: 1.6 } },
					react.createElement(
						"p",
						{ style: { margin: "4px 0" } },
						"完成：共 " + result.total + " 个归档会话；已删除 " + result.deleted +
						" 个，仅摘除记录 " + result.detachedOnly + " 个，跳过运行中 " +
						result.skippedLive + " 个，错误 " + result.errors + " 个。"
					),
					Array.isArray(result.results) && result.results.length > 0 && react.createElement(
						"ul",
						{ style: { margin: "4px 0 0 0", paddingLeft: 18, maxHeight: 220, overflowY: "auto" } },
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
