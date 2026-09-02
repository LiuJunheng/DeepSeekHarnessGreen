// DeepSeek Harness 插件 (客户端): dsh-session-transfer
// 在「设置」面板注册一个「会话传输」区块, 包含两个 Tab:
//   [导入] 上传官方导出的 ZIP / .jsonl → POST /__dsh/session-transfer/upload → 写回持久化目录
//   [导出] fetch /__dsh/session-transfer/export → showSaveFilePicker() 弹另存为 → 选路径保存 ZIP
// 桌面壳 (WebView2) 下 showSaveFilePicker() 会弹系统另存为对话框,
// 浏览器里则用浏览器原生"另存为"弹框, 两者体验一致。

window.__ModuleLoader__.load({
	id: "dsh-session-transfer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const inject = ["slots"];

		const ROUTE_UPLOAD = "/__dsh/session-transfer/upload";
		const OFFICIAL_EXPORT_ROUTE = "/api/session.export";  // 导出直接调官方路由 (同域 fetch 自动带 Cookie)
		const GUARD_HEADER = "X-DSH-Session-Transfer";

		// ------ 通用样式 (CSS 语义变量, 随 DSH 深浅主题自动切换) ------
		const theme = {
			box: { border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 4, padding: 12, maxWidth: 640, fontSize: 13, lineHeight: 1.6, background: "var(--dsw-alias-bg-layer-2)" },
			row: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
			hint: { color: "var(--dsw-alias-label-tertiary)", margin: 0, fontSize: 13 },
			err: { color: "var(--dsw-alias-state-error-primary)", margin: 0, fontSize: 13 },
			ok: { color: "var(--dsw-alias-state-success-primary)", margin: 0, fontSize: 13 },
			tabBtn: { padding: "6px 14px", cursor: "pointer", fontSize: 13, background: "transparent", border: "1px solid var(--dsw-alias-border-l1)", color: "var(--dsw-alias-label-secondary)", borderRadius: 4 },
			tabBtnActive: { padding: "6px 14px", cursor: "default", fontSize: 13, background: "var(--dsw-alias-bg-layer-1)", border: "1px solid var(--dsw-alias-border-l1)", color: "var(--dsw-alias-label-primary)", borderRadius: 4, fontWeight: "bold" }
		};

		// ------ 导入 Tab ------
		function ImportTab() {
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
				if (!file) { setError("请先选择一个文件 (.zip 导出包或 .jsonl 日志)"); return; }
				setBusy(true); setError(null); setResult(null);
				try {
					const response = await fetch(
						ROUTE_UPLOAD + "?filename=" + encodeURIComponent(file.name),
						{	method: "POST",
							headers: { [GUARD_HEADER]: "1", "Content-Type": file.type || "application/octet-stream" },
							body: file
						}
					);
					const payload = await response.json().catch(() => null);
					if (!response.ok || payload === null || payload.ok !== true) throw new Error((payload && payload.error) || ("HTTP " + response.status));
					setResult(payload);
				} catch (err) {
					setError("导入失败: " + String((err && err.message) || err));
				} finally { setBusy(false); }
			}, []);

			return react.createElement(react.Fragment, null,
				react.createElement("p", { style: { margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--dsw-alias-label-secondary)" } },
					"把「Session 日志」按钮导出的 ZIP（或单个 .jsonl 日志）导入回本机。导入后按日志头部的 cwd 写回持久化目录，并自动挂到对应工作区；刷新会话列表即可看到。重复导入同一会话会被跳过。"
				),
				react.createElement("div", { style: theme.box },
					react.createElement("div", { style: theme.row },
						react.createElement("input", {
							ref: fileRef, type: "file", accept: ".zip,.jsonl,.json,.txt",
							disabled: busy, onChange: onPick
						}),
						react.createElement("button", {
							type: "button", disabled: busy || fileName === "",
							onClick: doImport,
							style: { padding: "6px 16px", cursor: busy || fileName === "" ? "default" : "pointer" }
						}, busy ? "导入中…" : "开始导入")
					),
					fileName !== "" && react.createElement("p", { style: { ...theme.hint, marginTop: 8, marginBottom: 0 } }, "已选择: " + fileName)
				),
				error !== null && react.createElement("p", { style: theme.err }, error),
				result !== null && react.createElement("div", { style: { ...theme.box, background: "var(--dsw-alias-state-success-secondary)", borderColor: "var(--dsw-alias-state-success-primary)" } },
					react.createElement("p", { style: { margin: "0 0 6px 0", fontWeight: "bold", fontSize: 13, color: "var(--dsw-alias-label-primary)" } }, "导入结果"),
					react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "var(--dsw-alias-label-secondary)" } },
						react.createElement("span", null, "会话: " + result.sessionId),
						react.createElement("span", null, "格式: " + (result.compression === "none" ? "明文 JSONL" : "zstd 压缩 JSONL")),
						react.createElement("span", null, "写入 " + (result.imported ? result.imported.length : 0) + " 份日志" +
							(result.skipped && result.skipped.length > 0 ? "（跳过 " + result.skipped.length + " 份）" : "")),
						react.createElement("span", null, "附件: 导入 " + (result.media ? result.media.imported : 0) + " 个, 已存在 " + (result.media ? result.media.exists : 0) + " 个"),
						result.note && react.createElement("span", { style: { color: "var(--dsw-alias-label-tertiary)" } }, result.note)
					)
				)
			);
		}

		// ------ 导出 Tab ------
		function ExportTab() {
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [result, setResult] = react.useState(null);
			const [sessionId, setSessionId] = react.useState("");
			const [includeDesc, setIncludeDesc] = react.useState(true);
			const [suggestedName, setSuggestedName] = react.useState("");

			const EXPORT_HINT = (
				"填一个会话 ID 导出为 ZIP 包（和官方「Session 日志 ↓」按钮产出一致）。" +
				"会弹出系统「另存为」对话框让你选保存位置 —— 浏览器走原生下载弹框，" +
				"桌面壳（WebView2）走 Windows 文件保存对话框。"
			);

			const doExport = react.useCallback(async () => {
				if (!sessionId.trim()) { setError("请填写要导出的会话 ID"); return; }
				setBusy(true); setError(null); setResult(null);
				try {
					const url = OFFICIAL_EXPORT_ROUTE + "?sessionId=" + encodeURIComponent(sessionId.trim())
						+ "&includeDescendants=" + (includeDesc ? "true" : "false");
					const response = await fetch(url, { method: "GET", headers: { [GUARD_HEADER]: "1" } });
					if (!response.ok) {
						let msg = "HTTP " + response.status;
						try { msg = await response.text(); } catch (e) {}
						throw new Error(msg);
					}
					const blob = await response.blob();

					// 方案 A: showSaveFilePicker (WebView2 / Chrome 86+) —— 弹系统"另存为"对话框
					// 方案 B: 回退到 <a download> —— 静默下载到浏览器默认目录
					if (window.showSaveFilePicker) {
						const name = suggestedName.trim() || ("dsh-session-" + sessionId.trim() + ".zip");
						const handle = await window.showSaveFilePicker({
							suggestedName: name,
							types: [{ description: "ZIP 归档", accept: { "application/zip": [".zip"] } }]
						});
						const writable = await handle.createWritable();
						await writable.write(blob);
						await writable.close();
						setResult({ ok: true, method: "另存为 (系统对话框)", path: handle.name });
					} else {
						const name = suggestedName.trim() || ("dsh-session-" + sessionId.trim() + ".zip");
						const a = document.createElement("a");
						const href = URL.createObjectURL(blob);
						a.href = href; a.download = name;
						document.body.appendChild(a); a.click(); document.body.removeChild(a);
						setTimeout(() => URL.revokeObjectURL(href), 1000);
						setResult({ ok: true, method: "浏览器默认下载目录 (showSaveFilePicker 不可用)", path: name });
					}
				} catch (err) {
					// 用户点了"取消"不算错误
					const msg = String((err && err.message) || err || "");
					if (msg.indexOf("AbortError") >= 0 || msg.indexOf("User aborted") >= 0 || msg.indexOf("The user") >= 0) {
						setError(null);  // 静默
					} else {
						setError("导出失败: " + msg);
					}
				} finally { setBusy(false); }
			}, [sessionId, includeDesc, suggestedName]);

			return react.createElement(react.Fragment, null,
				react.createElement("p", { style: { margin: 0, fontSize: 13, lineHeight: 1.5, color: "var(--dsw-alias-label-secondary)" } }, EXPORT_HINT),
				react.createElement("div", { style: theme.box },
					react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
						react.createElement("label", null,
							react.createElement("span", { style: { display: "block", marginBottom: 4, fontSize: 13, color: "var(--dsw-alias-label-primary)" } }, "会话 ID"),
							react.createElement("input", {
								type: "text", value: sessionId,
								onChange: (e) => { setSessionId(e.target.value); setError(null); },
								placeholder: "贴一个会话 ID (形如 s_xxxxxxxxxxxx)",
								disabled: busy,
								style: { width: "100%", padding: "6px 8px", fontSize: 13, boxSizing: "border-box" }
							})
						),
						react.createElement("label", null,
							react.createElement("span", { style: { display: "block", marginBottom: 4, fontSize: 13, color: "var(--dsw-alias-label-primary)" } }, "文件名 (可选)"),
							react.createElement("input", {
								type: "text", value: suggestedName,
								onChange: (e) => setSuggestedName(e.target.value),
								placeholder: "留空自动生成 dsh-session-<id>.zip",
								disabled: busy,
								style: { width: "100%", padding: "6px 8px", fontSize: 13, boxSizing: "border-box" }
							})
						),
						react.createElement("label", { style: theme.row },
							react.createElement("input", {
								type: "checkbox", checked: includeDesc,
								onChange: (e) => setIncludeDesc(e.target.checked),
								disabled: busy
							}),
							react.createElement("span", { style: { fontSize: 13, color: "var(--dsw-alias-label-secondary)" } }, "包含子会话 (subagent 嵌套对话)")
						),
						react.createElement("button", {
							type: "button", onClick: doExport, disabled: busy,
							style: { padding: "6px 18px", cursor: busy ? "default" : "pointer" }
						}, busy ? "导出中…" : "导出 ZIP")
					)
				),
				error !== null && react.createElement("p", { style: theme.err }, error),
				result !== null && react.createElement("div", { style: { ...theme.box, background: "var(--dsw-alias-state-success-secondary)", borderColor: "var(--dsw-alias-state-success-primary)" } },
					react.createElement("p", { style: { margin: "0 0 6px 0", fontWeight: "bold", fontSize: 13, color: "var(--dsw-alias-label-primary)" } }, "导出完成"),
					react.createElement("p", { style: { margin: 0, fontSize: 13, color: "var(--dsw-alias-label-secondary)" } },
						"方式: " + result.method + (result.path ? " / 文件: " + result.path : "")
					)
				)
			);
		}

		// ------ 主组件: 两个 Tab 切换 ------
		function TransferSection() {
			const [tab, setTab] = react.useState("import");
			return react.createElement(
				"div", { style: { display: "flex", flexDirection: "column", gap: 10, padding: 4, maxWidth: 680 } },
				react.createElement("div", { style: { display: "flex", gap: 8 } },
					react.createElement("button", {
						type: "button", onClick: () => setTab("import"),
						style: tab === "import" ? theme.tabBtnActive : theme.tabBtn
					}, "📥 导入"),
					react.createElement("button", {
						type: "button", onClick: () => setTab("export"),
						style: tab === "export" ? theme.tabBtnActive : theme.tabBtn
					}, "📤 导出")
				),
				tab === "import" ? react.createElement(ImportTab, null) : react.createElement(ExportTab, null)
			);
		}

		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section", id: "session-transfer", order: 510, label: "会话传输"
			}, TransferSection));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
