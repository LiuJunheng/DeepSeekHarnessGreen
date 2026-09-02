// DeepSeek Harness 插件 (客户端): dsh-session-import
// 核心功能 (v0.3.0):
//   1) 全局 hook 官方「Session 日志」按钮的静默下载行为 —— 拦截 <a download> 中
//      href 包含 /api/session.export 的 click, 改成 fetch → blob → showSaveFilePicker()
//      弹系统「另存为」对话框 (桌面壳 WebView2 下是 Windows 文件保存对话框)。
//      浏览器环境不支持 showSaveFilePicker 时回退到原行为。
//   2) 设置面板保留「📥 导入」Tab —— ZIP / .jsonl → POST /__dsh/session-transfer/upload
//      → 写回 DSH 持久化目录 + 自动挂到对应工作区。
//   3) 设置面板移除「📤 导出」Tab —— 导出已通过 hook 官方按钮实现, 无需手动输 ID。
//
// 为什么 hook <a download> 而不是 fetch:
//   官方 @deepseek-ai/dsh-session-log-export 的下载流程是:
//     HEAD /api/session.export 检查可用性 → <a download href=url>.click()
//   浏览器拿到 download 属性后直接走下载管理器, 不经过 fetch, 所以 hook fetch 拦不住。
//   唯一的拦截点是 HTMLAnchorElement.prototype.click —— 在 click 里判断 href
//   是否是 session.export, 是的话替换成 fetch + showSaveFilePicker。

window.__ModuleLoader__.load({
	id: "dsh-session-import",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const inject = ["slots"];

		const ROUTE_UPLOAD = "/__dsh/session-transfer/upload";
		const OFFICIAL_EXPORT_ROUTE = "/api/session.export";
		const GUARD_HEADER = "X-DSH-Session-Transfer";

		// ------ 全局 hook: 拦截官方 Session 导出的静默下载 ------

		/**
		 * 执行真正的 fetch + showSaveFilePicker 另存为。
		 * @param {string} exportUrl - 完整的 /api/session.export?... URL
		 * @param {string} suggestedName - 建议文件名 (官方已生成 dsh-session-<id>.zip)
		 */
		async function doSaveAsExport(exportUrl, suggestedName) {
			try {
				const response = await fetch(exportUrl, { method: "GET" });
				if (!response.ok) {
					let msg = "HTTP " + response.status;
					try { msg = await response.text(); } catch (e) {}
					throw new Error(msg);
				}
				const blob = await response.blob();

				if (window.showSaveFilePicker) {
					// 方案 A: 弹系统「另存为」对话框 (桌面壳 WebView2 / Chrome 86+)
					const handle = await window.showSaveFilePicker({
						suggestedName: suggestedName,
						types: [{ description: "ZIP 归档", accept: { "application/zip": [".zip"] } }]
					});
					const writable = await handle.createWritable();
					await writable.write(blob);
					await writable.close();
					console.log("[dsh-session-import] 另存为成功:", handle.name);
				} else {
					// 方案 B: showSaveFilePicker 不可用 → 回退到浏览器原生下载 (原行为)
					const a = document.createElement("a");
					const href = URL.createObjectURL(blob);
					a.href = href;
					a.download = suggestedName;
					document.body.appendChild(a);
					a.click();
					document.body.removeChild(a);
					setTimeout(() => URL.revokeObjectURL(href), 1000);
					console.log("[dsh-session-import] showSaveFilePicker 不可用, 回退浏览器下载");
				}
			} catch (err) {
				// 用户点了"取消"不算错误, 静默即可
				const msg = String((err && err.message) || err || "");
				if (msg.indexOf("AbortError") >= 0 || msg.indexOf("User aborted") >= 0 || msg.indexOf("The user") >= 0) {
					console.log("[dsh-session-import] 用户取消了另存为");
				} else {
					console.error("[dsh-session-import] 另存为失败:", err);
					alert("Session 导出失败: " + msg);
				}
			}
		}

		/**
		 * 安装全局 hook: 拦截所有 <a download> 中 href 匹配 session.export 的 click。
		 * 幂等 —— 多次调用只会覆盖上一个 hook (因为每次保存 original 到新变量)。
		 */
		let installedHook = false;
		function installSessionExportHook() {
			if (installedHook) return;
			installedHook = true;

			const originalAnchorClick = HTMLAnchorElement.prototype.click;

			HTMLAnchorElement.prototype.click = function () {
				// 只拦截有 download 属性且 href 包含 session.export 的 <a>
				if (this.download && this.href && this.href.indexOf(OFFICIAL_EXPORT_ROUTE) >= 0) {
					// 拦截成功 → 走 fetch + showSaveFilePicker
					doSaveAsExport(this.href, this.download);
					// 不调 originalAnchorClick, 阻止浏览器静默下载
					return;
				}
				// 其他 <a> 保持原行为
				return originalAnchorClick.call(this);
			};

			console.log("[dsh-session-import] 已安装官方 Session 导出 <a download> hook");
		}

		// ------ 设置面板: 导入 Tab ------

		const theme = {
			box: { border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 4, padding: 12, maxWidth: 640, fontSize: 13, lineHeight: 1.6, background: "var(--dsw-alias-bg-layer-2)" },
			row: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
			hint: { color: "var(--dsw-alias-label-tertiary)", margin: 0, fontSize: 13 },
			err: { color: "var(--dsw-alias-state-error-primary)", margin: 0, fontSize: 13 },
			ok: { color: "var(--dsw-alias-state-success-primary)", margin: 0, fontSize: 13 }
		};

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
					"把官方「Session 日志 ↓」按钮导出的 ZIP（或单个 .jsonl 日志）导入回本机。导入后按日志头部的 cwd 写回持久化目录，并自动挂到对应工作区；刷新会话列表即可看到。重复导入同一会话会被跳过。"
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

		// ------ 主组件: 单一导入区域 ------
		function TransferSection() {
			return react.createElement(
				"div", { style: { display: "flex", flexDirection: "column", gap: 10, padding: 4, maxWidth: 680 } },
				react.createElement("p", { style: { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)", padding: "4px 8px", background: "var(--dsw-alias-bg-layer-2)", borderRadius: 4 } },
					"💡 导出: 直接点会话右上角「Session 日志」按钮 —— 已被本插件 hook 为系统「另存为」对话框。"
				),
				react.createElement(ImportTab, null)
			);
		}

		function apply(ctx) {
			// 安装全局 hook —— 模块加载后立即生效, 不依赖 DOM
			installSessionExportHook();

			// 设置面板只保留导入区域 (导出已通过 hook 官方按钮实现)
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section", id: "session-transfer", order: 510, label: "会话传输"
			}, TransferSection));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
