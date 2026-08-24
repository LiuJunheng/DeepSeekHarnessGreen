// DeepSeek Harness 插件 (客户端): dsh-session-import
// 在「设置」面板注册一个「会话导入」区块: 选择导出的 ZIP 或 .jsonl 文件,
// POST 给宿主端 /__dsh/session-import/upload 完成导入并展示结果。
// 这是加载器契约格式 (window.__ModuleLoader__.load), 与官方客户端插件一致。

window.__ModuleLoader__.load({
	id: "dsh-session-import",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const inject = ["slots"];

		const ROUTE_UPLOAD = "/__dsh/session-import/upload";
		const GUARD_HEADER = "X-DSH-Session-Import";

		/** 设置页「会话导入」区块内容。 */
		function ImportSection() {
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [result, setResult] = react.useState(null);
			const [fileName, setFileName] = react.useState("");
			const fileRef = react.useRef(null);

			const onPick = (e) => {
				const file = e.target.files && e.target.files[0];
				setFileName(file ? file.name : "");
				setResult(null);
				setError(null);
			};

			const doImport = react.useCallback(async () => {
				const file = fileRef.current && fileRef.current.files && fileRef.current.files[0];
				if (!file) {
					setError("请先选择一个文件 (.zip 导出包或 .jsonl 日志)");
					return;
				}
				setBusy(true);
				setError(null);
				setResult(null);
				try {
					const response = await fetch(
						ROUTE_UPLOAD + "?filename=" + encodeURIComponent(file.name),
						{
							method: "POST",
							headers: {
								[GUARD_HEADER]: "1",
								"Content-Type": file.type || "application/octet-stream"
							},
							body: file
						}
					);
					const payload = await response.json().catch(() => null);
					if (!response.ok || payload === null || payload.ok !== true) {
						throw new Error((payload && payload.error) || ("HTTP " + response.status));
					}
					setResult(payload);
				} catch (err) {
					setError("导入失败: " + String((err && err.message) || err));
				} finally {
					setBusy(false);
				}
			}, []);

			// 面板边框/底色走语义变量，随 DSH 深浅主题自动切换
			const box = { border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 4, padding: 12, maxWidth: 640, fontSize: 13, lineHeight: 1.6, background: "var(--dsw-alias-bg-layer-2)" };
			const rowStyle = { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" };
			const hintStyle = { color: "var(--dsw-alias-label-tertiary)", margin: 0, fontSize: 13 };

			return react.createElement(
				"div",
				{ style: { display: "flex", flexDirection: "column", gap: 10, padding: 4, maxWidth: 680 } },
				react.createElement(
				"p",
				{ style: { margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--dsw-alias-label-secondary)" } },
				"把「Session log」按钮导出的 ZIP（或单个 .jsonl 日志）导入回本机。导入后会按日志头部的 cwd 写回持久化目录，并自动挂到对应工作区；" +
				"刷新会话列表即可看到。导入的会话与原会话 id 相同，重复导入同一会话会被跳过。"
			),
				react.createElement(
					"div",
					{ style: box },
					react.createElement(
						"div",
						{ style: rowStyle },
						react.createElement("input", {
							ref: fileRef,
							type: "file",
							accept: ".zip,.jsonl,.json,.txt",
							disabled: busy,
							onChange: onPick
						}),
						react.createElement(
							"button",
							{
								type: "button",
								disabled: busy || fileName === "",
								onClick: doImport,
								style: { padding: "6px 16px", cursor: busy || fileName === "" ? "default" : "pointer" }
							},
							busy ? "导入中…" : "开始导入"
						)
					),
					fileName !== "" && react.createElement(
						"p",
						{ style: { ...hintStyle, marginTop: 8, marginBottom: 0 } },
						"已选择: " + fileName
					)
				),
				error !== null && react.createElement(
					"p",
					{ style: { color: "var(--dsw-alias-state-error-primary)", margin: 0, fontSize: 13 } },
					error
				),
				result !== null && react.createElement(
					"div",
					{ style: { ...box, background: "var(--dsw-alias-state-success-secondary)", borderColor: "var(--dsw-alias-state-success-primary)" } },
					react.createElement(
						"p",
						{ style: { margin: "0 0 6px 0", fontWeight: "bold", fontSize: 13, color: "var(--dsw-alias-label-primary)" } },
						"导入结果"
					),
					react.createElement(
						"div",
						{ style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "var(--dsw-alias-label-secondary)" } },
						react.createElement("span", null, "会话: " + result.sessionId),
						react.createElement("span", null, "格式: " + (result.compression === "none" ? "明文 JSONL" : "zstd 压缩 JSONL")),
						react.createElement("span", null, "写入 " + (result.imported ? result.imported.length : 0) + " 份日志" +
							(result.skipped && result.skipped.length > 0 ? "（跳过 " + result.skipped.length + " 份: " +
								result.skipped.map((s) => s.id).join(", ") + "）" : "")),
						react.createElement("span", null, "附件: 导入 " + (result.media ? result.media.imported : 0) + " 个, 已存在 " +
							(result.media ? result.media.exists : 0) + " 个" +
							(result.media && result.media.skipped && result.media.skipped.length > 0
								? "（跳过 " + result.media.skipped.length + " 个）" : "")),
						result.workspaces && result.workspaces.length > 0 && react.createElement(
							"span",
							null,
							"工作区: " + result.workspaces.map((w) => w.workspace.title || w.workspace.path).join("、")
						),
						result.note && react.createElement(
							"span",
							{ style: { color: "var(--dsw-alias-label-tertiary)" } },
							result.note
						)
					)
				)
			);
		}

		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "session-import",
				order: 510,
				label: "会话导入"
			}, ImportSection));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
