// DeepSeek Harness 插件 (客户端): dsh-file-browser
// 在输入框工具行注册「📁 文件」按钮 (conversation.input.left), 在 shell.overlay
// 注册右侧浮层文件浏览器: 列目录、返回上级、路径跳转、文本/图片预览。
// 右键文件/目录弹出菜单: 插入路径/内容到输入框、复制路径 (追加进草稿, 用户可编辑后发送)。
// 数据通过 fetch 调用宿主端路由 /__dsh/file-browser/* (带自定义头防跨站)。
// 这是加载器契约格式 (window.__ModuleLoader__.load), 与官方客户端插件一致。
// 注意: 不修改任何官方文件/包; 样式用内联对象 (与 dsh-archive-purge 同风格)。

window.__ModuleLoader__.load({
	id: "dsh-file-browser",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const inject = ["slots"];

		const BASE = "/__dsh/file-browser";
		const GUARD_HEADER = "X-DSH-File-Browser";
		const CONTENT_INSERT_CAP = 3000; // 插入内容的最大字符数

		// ---- 通用工具 ----
		function fmtSize(n) {
			if (typeof n !== "number" || !isFinite(n)) return "";
			if (n < 1024) return n + " B";
			if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
			if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
			return (n / 1073741824).toFixed(2) + " GB";
		}

		function parentOf(p) {
			if (typeof p !== "string" || !p) return "";
			const trimmed = p.replace(/[\\/]+$/, "");
			const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
			if (idx <= 0) return trimmed;
			return trimmed.slice(0, idx);
		}

		async function postJson(path, body) {
			const response = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json", [GUARD_HEADER]: "1" },
				body: JSON.stringify(body || {}),
			});
			const payload = await response.json().catch(() => null);
			if (!response.ok || payload === null) {
				throw new Error((payload && payload.error) || ("HTTP " + response.status));
			}
			return payload;
		}

		// ---- 面板开关共享状态 (跨两个插槽; 通知时必须把新值传给 setState) ----
		const listeners = new Set();
		let open = false;
		function setOpen(v) {
			if (open === v) return;
			open = v;
			listeners.forEach((fn) => fn(open));
		}
		function useOpen() {
			const [v, setV] = react.useState(open);
			react.useEffect(() => {
				listeners.add(setV);
				return () => { listeners.delete(setV); };
			}, []);
			return v;
		}

		// ---- 待插入输入框的文本队列 (面板右键菜单 → 输入框工具行组件消费) ----
		let pendingInsert = null;
		const insertListeners = new Set();
		function queueInsert(text) {
			pendingInsert = text;
			insertListeners.forEach((fn) => fn(text));
		}
		function consumeInsert() {
			if (pendingInsert === null) return;
			pendingInsert = null;
			insertListeners.forEach((fn) => fn(null));
		}
		function usePendingInsert() {
			const [v, setV] = react.useState(pendingInsert);
			react.useEffect(() => {
				insertListeners.add(setV);
				return () => { insertListeners.delete(setV); };
			}, []);
			return v;
		}

		// ---- 主题色 (CSS 变量 + 回退值, 跟随亮/暗主题) ----
		const C = {
			bgOverlay: "var(--dsw-alias-bg-overlay, #ffffff)",
			bg1: "var(--dsw-alias-bg-layer-1, #f5f6f8)",
			bg2: "var(--dsw-alias-bg-layer-2, #eceef1)",
			border: "var(--dsw-alias-border-l1, #e2e4e8)",
			border2: "var(--dsw-alias-border-l2, #c9cdd3)",
			text: "var(--dsw-alias-label-primary, #1f2329)",
			text2: "var(--dsw-alias-label-secondary, #8a8f98)",
			brand: "var(--dsw-alias-brand-primary, #3b82f6)",
			error: "var(--dsw-alias-state-error-primary, #d92d20)",
		};

		function FileBrowser(props) {
			const [cwd, setCwd] = react.useState("");
			const [entries, setEntries] = react.useState(null);
			const [listError, setListError] = react.useState(null);
			const [truncated, setTruncated] = react.useState(false);
			const [busy, setBusy] = react.useState(false);
			const [selected, setSelected] = react.useState(null);
			const [preview, setPreview] = react.useState(null);
			const [previewing, setPreviewing] = react.useState(false);
			const [pathInput, setPathInput] = react.useState("");
			const [hoverKey, setHoverKey] = react.useState(null);
			// 右键菜单: null 或 { x, y, path, name, type }
			const [menu, setMenu] = react.useState(null);

			async function loadDir(path) {
				setBusy(true);
				setListError(null);
				setSelected(null);
				setPreview(null);
				setMenu(null);
				try {
					const res = await postJson(BASE + "/list", { path });
					setCwd(res.path);
					setPathInput(res.path);
					setEntries(res.entries || []);
					setTruncated(!!res.truncated);
				} catch (e) {
					setListError(String((e && e.message) || e));
				} finally {
					setBusy(false);
				}
			}

			async function previewFile(path) {
				setSelected(path);
				setPreview(null);
				setPreviewing(true);
				try {
					const res = await postJson(BASE + "/read", { path });
					if (res && res.error) {
						setPreview({ kind: "error", message: res.error });
					} else if (res && res.tooLarge) {
						setPreview({ kind: "error", message: "文件过大，无法预览（" + fmtSize(res.size) + "）" });
					} else if (res && res.kind === "image") {
						setPreview({ kind: "image", src: res.dataUrl });
					} else {
						setPreview({ kind: "text", content: res.content, lines: res.lineCount });
					}
				} catch (e) {
					setPreview({ kind: "error", message: String((e && e.message) || e) });
				} finally {
					setPreviewing(false);
				}
			}

			// 挂载时获取起始目录
			react.useEffect(() => {
				let alive = true;
				fetch(BASE + "/home", { headers: { [GUARD_HEADER]: "1" } })
					.then((r) => r.json().catch(() => null))
					.then((res) => {
						if (!alive) return;
						if (res && res.root) {
							loadDir(res.root);
						} else {
							setListError((res && res.error) || "无法获取起始目录");
						}
					})
					.catch((e) => {
						if (alive) setListError(String((e && e.message) || e));
					});
				return () => { alive = false; };
			}, []);

			// 菜单打开时按 Esc 关闭
			react.useEffect(() => {
				if (!menu) return;
				const onKey = (ev) => { if (ev.key === "Escape") setMenu(null); };
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [menu]);

			const sorted = (entries || []).slice().sort((a, b) => {
				if (a.type === b.type) return a.name.localeCompare(b.name);
				return a.type === "directory" ? -1 : 1;
			});

			function goUp() {
				const parent = parentOf(cwd);
				if (parent && parent !== cwd) loadDir(parent);
			}

			function goToPath() {
				const p = pathInput.trim();
				if (p) loadDir(p);
			}

			// ---- 右键菜单动作 ----
			function copyText(text) {
				try {
					if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
						navigator.clipboard.writeText(text).catch(() => {});
					}
				} catch (e) { /* ignore */ }
			}

			async function insertContent(menuEntry) {
				try {
					const res = await postJson(BASE + "/read", { path: menuEntry.path });
					let text;
					if (res && res.error) {
						text = "[文件] " + menuEntry.path + "（读取失败：" + res.error + "）";
					} else if (res && res.tooLarge) {
						text = "[文件] " + menuEntry.path + "（过大无法读取，大小 " + fmtSize(res.size) + "）";
					} else if (res && res.kind === "image") {
						text = "[图片] " + menuEntry.path;
					} else {
						let body = res.content;
						let note = "";
						if (body.length > CONTENT_INSERT_CAP) {
							body = body.slice(0, CONTENT_INSERT_CAP);
							note = "（内容过长，已截断为前 " + CONTENT_INSERT_CAP + " 字符，完整文件共 " + res.lineCount + " 行）";
						}
						text = "[文件] " + menuEntry.path + "\n" + body + "\n[文件内容结束]" + note;
					}
					queueInsert(text);
				} catch (e) {
					queueInsert("[文件] " + menuEntry.path + "（读取失败：" + String((e && e.message) || e) + "）");
				}
			}

			function buildMenuItems(menuEntry) {
				const isDir = menuEntry.type === "directory";
				const items = [
					{
						label: isDir ? "插入目录路径到输入框" : "插入文件路径到输入框",
						icon: isDir ? "\uD83D\uDCC1" : "\uD83D\uDCC4",
						onClick: () => { queueInsert(menuEntry.path); setMenu(null); },
					},
				];
				if (!isDir) {
					items.push({
						label: "插入内容到输入框",
						icon: "\u270D\uFE0F",
						onClick: () => { insertContent(menuEntry); setMenu(null); },
					});
				}
				items.push({
					label: "复制路径",
					icon: "\uD83D\uDCCB",
					onClick: () => { copyText(menuEntry.path); setMenu(null); },
				});
				return items;
			}

			// ---- 渲染 ----
			const rowBase = {
				display: "flex",
				alignItems: "center",
				gap: 6,
				padding: "5px 10px",
				cursor: "pointer",
				fontSize: 12,
				whiteSpace: "nowrap",
				color: C.text,
				background: "transparent",
			};

			const rows = [
				react.createElement("div", {
					key: "..",
					style: { ...rowBase, fontWeight: 500 },
					onClick: goUp,
					onMouseEnter: () => setHoverKey(".."),
					onMouseLeave: () => setHoverKey(null),
				}, "\u2191 ..（上级目录）"),
			];

			sorted.forEach((e) => {
				const isDir = e.type === "directory";
				const key = e.path || e.name;
				rows.push(react.createElement("div", {
					key,
					style: {
						...rowBase,
						fontWeight: isDir ? 500 : 400,
						background: selected === e.path
							? C.bg2
							: hoverKey === key ? C.bg1 : "transparent",
					},
					onClick: () => (isDir ? loadDir(e.path) : previewFile(e.path)),
					onMouseEnter: () => setHoverKey(key),
					onMouseLeave: () => setHoverKey(null),
					onContextMenu: (ev) => {
						ev.preventDefault();
						ev.stopPropagation();
						setMenu({ x: ev.clientX, y: ev.clientY, path: e.path, name: e.name, type: e.type });
					},
				},
					react.createElement("span", null, isDir ? "\uD83D\uDCC1" : "\uD83D\uDCC4"),
					react.createElement("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" } }, e.name),
					isDir ? null : react.createElement("span", { style: { marginLeft: "auto", flex: "none", color: C.text2, fontSize: 11, paddingLeft: 8 } }, fmtSize(e.size)),
				));
			});

			const statusStyle = { color: C.text2, fontSize: 12, padding: "8px 4px" };
			const errorStyle = { color: C.error, fontSize: 12, padding: "8px 4px", wordBreak: "break-all" };

			let listBody;
			if (busy && entries === null) {
				listBody = react.createElement("div", { style: statusStyle }, "加载中…");
			} else if (listError) {
				listBody = react.createElement("div", { style: errorStyle }, listError);
			} else if (entries !== null && rows.length <= 1) {
				listBody = react.createElement("div", { style: statusStyle }, "空目录");
			} else {
				listBody = react.createElement("div", { style: { padding: "4px 0" } }, rows);
			}

			let previewBody;
			if (previewing) {
				previewBody = react.createElement("div", { style: statusStyle }, "加载中…");
			} else if (!preview) {
				previewBody = react.createElement("div", { style: statusStyle }, "选中左侧文件查看预览");
			} else if (preview.kind === "error") {
				previewBody = react.createElement("div", { style: errorStyle }, preview.message);
			} else if (preview.kind === "image") {
				previewBody = react.createElement("img", {
					src: preview.src,
					alt: "preview",
					style: { maxWidth: "100%", height: "auto", borderRadius: 6, display: "block" },
				});
			} else {
				previewBody = react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, minHeight: "100%" } }, [
					react.createElement("div", { key: "meta", style: statusStyle }, preview.lines + " 行"),
					react.createElement("pre", {
						key: "pre",
						style: {
							margin: 0,
							fontFamily: "ui-monospace, SFMono-Regular, Consolas, 'Courier New', monospace",
							fontSize: 12,
							lineHeight: 1.55,
							whiteSpace: "pre",
							color: C.text,
						},
					}, preview.content),
				]);
			}

			const panelStyle = {
				position: "fixed",
				top: 64,
				right: 20,
				bottom: 64,
				width: 680,
				maxWidth: "calc(100vw - 40px)",
				display: "flex",
				flexDirection: "column",
				background: C.bgOverlay,
				border: "1px solid " + C.border,
				borderRadius: 12,
				boxShadow: "0 16px 48px rgba(0,0,0,0.35)",
				overflow: "hidden",
				zIndex: 1000,
				pointerEvents: "auto",
				fontFamily: "inherit",
				fontSize: 13,
				color: C.text,
			};

			const headerStyle = {
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "10px 12px",
				borderBottom: "1px solid " + C.border,
				flex: "none",
			};

			const inputStyle = {
				flex: 1,
				minWidth: 0,
				background: C.bg1,
				border: "1px solid " + C.border,
				borderRadius: 6,
				color: C.text,
				padding: "5px 8px",
				fontSize: 12,
				outline: "none",
			};

			const btnStyle = {
				flex: "none",
				border: "1px solid " + C.border,
				background: C.bg1,
				color: C.text,
				borderRadius: 6,
				width: 26,
				height: 26,
				fontSize: 13,
				lineHeight: 1,
				cursor: "pointer",
			};

			// 右键菜单 (fixed 定位, 避免被面板 overflow:hidden 裁剪)
			let menuEl = null;
			if (menu) {
				const menuItems = buildMenuItems(menu);
				const menuWidth = 220;
				const menuHeight = 42 + (menuItems.length - 1) * 30;
				const left = Math.max(4, Math.min(menu.x, (window.innerWidth || 1280) - menuWidth - 4));
				const top = Math.max(4, Math.min(menu.y, (window.innerHeight || 800) - menuHeight - 4));
				menuEl = react.createElement("div", {
					key: "menu-root",
					style: { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 1001 },
				}, [
					react.createElement("div", {
						key: "backdrop",
						style: { position: "absolute", inset: 0 },
						onClick: () => setMenu(null),
						onContextMenu: (ev) => { ev.preventDefault(); setMenu(null); },
					}),
					react.createElement("div", {
						key: "menu",
						style: {
							position: "fixed",
							left,
							top,
							zIndex: 1002,
							background: C.bgOverlay,
							border: "1px solid " + C.border,
							borderRadius: 8,
							boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
							padding: "4px 0",
							minWidth: menuWidth,
							fontSize: 12,
							color: C.text,
						},
					}, menuItems.map((item) => react.createElement("div", {
						key: item.label,
						style: { display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", cursor: "pointer", whiteSpace: "nowrap" },
						onMouseEnter: (ev) => { ev.currentTarget.style.background = C.bg1; },
						onMouseLeave: (ev) => { ev.currentTarget.style.background = "transparent"; },
						onClick: item.onClick,
					}, item.icon, item.label))),
				]);
			}

			return react.createElement("div", { style: panelStyle }, [
				react.createElement("div", { key: "header", style: headerStyle }, [
					react.createElement("span", { key: "t", style: { fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" } }, "文件浏览"),
					react.createElement("input", {
						key: "p",
						style: inputStyle,
						value: pathInput,
						placeholder: "输入路径后回车",
						onChange: (ev) => setPathInput(ev.target.value),
						onKeyDown: (ev) => { if (ev.key === "Enter") goToPath(); },
					}),
					react.createElement("button", { key: "r", type: "button", style: btnStyle, onClick: () => loadDir(cwd || pathInput), title: "刷新" }, "\u21BB"),
					react.createElement("button", { key: "c", type: "button", style: btnStyle, onClick: props.onClose, title: "关闭" }, "\u2715"),
				]),
				react.createElement("div", { key: "body", style: { flex: 1, display: "flex", minHeight: 0 } }, [
					react.createElement("div", { key: "list", style: { width: "46%", flex: "none", borderRight: "1px solid " + C.border, overflowY: "auto" } }, listBody),
					react.createElement("div", { key: "preview", style: { flex: 1, minWidth: 0, overflow: "auto", padding: "10px 12px" } }, previewBody),
				]),
				react.createElement("div", {
					key: "footer",
					style: { flex: "none", borderTop: "1px solid " + C.border, padding: "6px 12px", color: C.text2, fontSize: 11 },
				}, busy ? "加载中…" : (entries ? entries.length + (truncated ? "+ 项（已截断）" : " 项") : "")),
				menuEl,
			]);
		}

		function apply(ctx) {
			ctx.slots.inject("conversation.input.left", () => ctx.slots.register(
				{ name: "conversation.input.left", id: "file-browser-toggle", order: 5 },
				(ownerProps) => {
					const isOpen = useOpen();
					const pending = usePendingInsert();
					const inputActions = ownerProps && ownerProps.inputActions;
					// 当前草稿从 ownerProps.input 读 (InputZone 契约, 普通数据快照),
					// 不要调用 props.useInput() —— 那是从外部传入的 hook,
					// 身份/可用性在不同渲染间可能不稳定, 条件调用会触发
					// "Rendered more/fewer hooks" 并被错误边界吞掉 (组件不渲染)。
					const input = ownerProps && ownerProps.input;

					// 消费面板右键菜单排队的插入 (追加到输入框草稿, 不直接发消息)
					react.useEffect(() => {
						if (pending == null) return;
						if (inputActions) {
							const current = input && typeof input.draft === "string" ? input.draft : "";
							inputActions.setDraft(current ? current + "\n" + pending : pending);
						}
						consumeInsert();
					}, [pending]);

					return react.createElement("button", {
						type: "button",
						onClick: () => setOpen(!isOpen),
						title: "文件浏览（右键文件可添加到对话）",
						style: {
							display: "inline-flex",
							alignItems: "center",
							gap: 4,
							border: "1px solid transparent",
							background: "transparent",
							color: isOpen ? C.brand : C.text2,
							borderRadius: 8,
							padding: "4px 7px",
							cursor: "pointer",
							whiteSpace: "nowrap",
							fontFamily: "inherit",
							fontSize: 12,
						},
					}, "\uD83D\uDCC1", react.createElement("span", { style: { marginLeft: 4 } }, "文件"));
				},
			));

			ctx.slots.inject("shell.overlay", () => ctx.slots.register(
				{ name: "shell.overlay", id: "file-browser-panel", order: 100 },
				() => {
					const isOpen = useOpen();
					if (!isOpen) return null;
					return react.createElement(FileBrowser, { onClose: () => setOpen(false) });
				},
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
