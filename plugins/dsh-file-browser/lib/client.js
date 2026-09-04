// DeepSeek Harness 插件 (客户端): dsh-file-browser
// 在输入框工具行注册「📁 文件」按钮 (conversation.input.left), 在 shell.overlay
// 注册右侧浮层文件浏览器: 列目录、返回上级、路径跳转、文本/图片预览。
// 右键文件/目录弹出菜单: 插入路径/内容到输入框、复制路径 (追加进草稿, 用户可编辑后发送)。
// 新版 DSH 官方 @+文件 引用 (dsh-client-ui-reference): 以会话 header.cwd 为根、
// 用相对路径的 @"path" mention 作为提示词文本, 并带结构化 occurrence (chip 渲染 +
// 提交时经 source codec 序列化)。本插件右键菜单新增「以官方 @ 引用插入」: 把所选文件
// 换算成相对会话工作目录的 mention, 然后向当前会话作用域派发与官方 @ 菜单 onPick 完全
// 同一个事件 slash/input-insert-reference (InputTriggerController.execute 同源), 由官方
// 输入机 mint occurrence 成 chip —— 即官方机制的真正衔接, 而非普通文本。
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

		const inject = ["slots", "sessions"];

		const BASE = "/__dsh/file-browser";
		const GUARD_HEADER = "X-DSH-File-Browser";
		const CONTENT_INSERT_CAP = 3000; // 插入内容的最大字符数
		// 与宿主端一致: 大二进制文件仅预览前部 4KB head (host 端常量 BINARY_HEAD_BYTES)
		const BINARY_HEAD_BYTES = 4096;

		// ---- 官方 @ 引用 (dsh-file-reference grammar) 的路径换算 ----
		// 官方 @ 文件搜索 (dsh-file-reference-local) 以会话 header.cwd 为根、索引相对路径;
		// mention 语法与 dsh-file-reference 的 formatFileMention 一致: 无空白 `@path`,
		// 含空白 `@"path with spaces"`。宿主端 /home 与 /list 返回的都是绝对路径,
		// 这里做 Windows 语义 (大小写不敏感) 的相对换算; 目标在根之外或跨盘返回 null。
		function toPosix(p) {
			return String(p || "").replace(/\\/g, "/");
		}
		function relSegments(fromPath, toPath) {
			const fromParts = fromPath.split("/").filter(Boolean);
			const toParts = toPath.split("/").filter(Boolean);
			let i = 0;
			while (i < fromParts.length && i < toParts.length && fromParts[i].toLowerCase() === toParts[i].toLowerCase()) i += 1;
			const ups = fromParts.length - i;
			const rest = toParts.slice(i);
			return [...Array(ups).fill(".."), ...rest].join("/");
		}
		function relativePosix(fromAbs, toAbs) {
			const from = toPosix(fromAbs).replace(/\/+$/, "");
			const to = toPosix(toAbs);
			const m1 = from.match(/^([a-zA-Z]:)(\/.*)$/);
			const m2 = to.match(/^([a-zA-Z]:)(\/.*)$/);
			if (m1 || m2) {
				if (!m1 || !m2 || m1[1].toLowerCase() !== m2[1].toLowerCase()) return null; // 跨盘
				return relSegments(m1[2], m2[2]);
			}
			return relSegments(from, to); // UNC / 相对形态
		}
		function formatMention(relPosix) {
			return /\s/.test(relPosix) ? "@\"" + relPosix + "\"" : "@" + relPosix;
		}

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
			// 底部提示条 (如"官方 @ 引用不可用"原因), 数秒后自动消失
			const [notice, setNotice] = react.useState(null);
			const noticeTimerRef = react.useRef(null);
			const showNotice = react.useCallback((text) => {
				setNotice(text);
				if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
				noticeTimerRef.current = setTimeout(() => setNotice(null), 6000);
			}, []);
			react.useEffect(() => () => {
				if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
			}, []);

			// ---- 弹窗几何 (可拖动 + 可拉伸右/下/右下角) ----
			// 初始为默认尺寸/位置 (680 × (视口高-128), 右下锚), 用户拖动后按记忆渲染;
			// 最小尺寸 520×380, 最大不超过视口 - 16px (避免溢出屏幕外点不到关闭按钮)。
			const DEFAULT_W = 720;
			const MIN_W = 520;
			const MIN_H = 380;
			const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
			const initialWin = () => {
				const w = clamp(DEFAULT_W, MIN_W, (window.innerWidth || 1280) - 16);
				const h = clamp((window.innerHeight || 800) - 128, MIN_H, (window.innerHeight || 800) - 16);
				const left = (window.innerWidth || 1280) - w - 20;
				const top = 64;
				return { left, top, width: w, height: h };
			};
			const [win, setWin] = react.useState(initialWin);
			const dragStateRef = react.useRef(null); // { mode, startX, startY, origLeft, origTop, origW, origH }
			const windowOnDown = (ev, mode) => {
				ev.preventDefault();
				ev.stopPropagation();
				dragStateRef.current = {
					mode, // "move" | "r" | "b" | "br"
					startX: ev.clientX,
					startY: ev.clientY,
					origLeft: win.left,
					origTop: win.top,
					origW: win.width,
					origH: win.height,
				};
			};
			react.useEffect(() => {
				const onMove = (ev) => {
					const ds = dragStateRef.current;
					if (!ds) return;
					const dx = ev.clientX - ds.startX;
					const dy = ev.clientY - ds.startY;
					const vw = window.innerWidth || 1280;
					const vh = window.innerHeight || 800;
					setWin((cur) => {
						let left = cur.left;
						let top = cur.top;
						let width = cur.width;
						let height = cur.height;
						if (ds.mode === "move") {
							left = clamp(ds.origLeft + dx, 8, vw - 60);
							top = clamp(ds.origTop + dy, 8, vh - 60);
						} else if (ds.mode === "r") {
							width = clamp(ds.origW + dx, MIN_W, vw - 16);
						} else if (ds.mode === "b") {
							height = clamp(ds.origH + dy, MIN_H, vh - 16);
						} else if (ds.mode === "br") {
							width = clamp(ds.origW + dx, MIN_W, vw - 16);
							height = clamp(ds.origH + dy, MIN_H, vh - 16);
						}
						return { left, top, width, height };
					});
				};
				const onUp = () => { dragStateRef.current = null; };
				window.addEventListener("mousemove", onMove);
				window.addEventListener("mouseup", onUp);
				return () => {
					window.removeEventListener("mousemove", onMove);
					window.removeEventListener("mouseup", onUp);
				};
			}, []);

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
					} else if (res && res.kind === "image") {
						setPreview({
							kind: "image",
							path,
							src: res.dataUrl,
							size: res.size || 0,
							truncated: !!res.truncated,
						});
					} else if (res && res.kind === "binary") {
						setPreview({
							kind: "binary",
							path,
							size: res.size || 0,
							truncated: !!res.truncated,
							head: res.head || "",
						});
					} else {
						// kind===text / 旧兼容: 初始预览只读前部 content; 若 truncated, 按已读字节长度做 offset 继续分块
						const text = res && typeof res.content === "string" ? res.content : "";
						setPreview({
							kind: "text",
							path,
							content: text,
							size: res && typeof res.size === "number" ? res.size : 0,
							truncated: !!(res && res.truncated),
							loadedBytes: res && typeof res.size === "number"
								? Math.min(res.size, new Blob([text]).size) // 粗估 UTF-8 字节 (用于 offset)
								: 0,
						});
					}
				} catch (e) {
					setPreview({ kind: "error", message: String((e && e.message) || e) });
				} finally {
					setPreviewing(false);
				}
			}

			// 分块加载「再看后面一段」: 按 preview.loadedBytes 作为 offset 继续读一块
			// (chunk size = 默认 512KB), 结果 append 到 content。
			const [chunkLoading, setChunkLoading] = react.useState(false);
			const loadMoreChunk = async () => {
				const current = preview;
				if (!current || (current.kind !== "text" && current.kind !== "binary")) return;
				const fileSize = current.size || 0;
				const offset = Number.isFinite(Number(current.loadedBytes)) ? Number(current.loadedBytes) : 0;
				if (offset >= fileSize) {
					setPreview((prev) => prev && Object.assign({}, prev, { truncated: false, eof: true }));
					return;
				}
				setChunkLoading(true);
				try {
					const res = await postJson(BASE + "/readChunk", {
						path: current.path,
						offset,
						size: 512 * 1024,
					});
					if (res && (res.error || !res)) {
						throw new Error((res && res.error) || "未知错误");
					}
					setPreview((prev) => {
						if (!prev) return prev;
						if (prev.kind === "text") {
							let added = (res && typeof res.content === "string") ? res.content : "";
							// ---- 修正 UTF-8 多字节字符在 chunk 边界被截断 ----
							// 宿主端回传了 back 字节的"回退冗余"并按 actualStart 解码整段,
							// 现在用 TextEncoder 取 UTF-8 字节, 找到第一个非续字节的位置作为
							// 真正新内容起始 (前几个字节是上一段末尾已解码过的 UTF-8 尾巴+残体,
							// 上一段 content 末尾已经解过完整码点, 直接丢即可不丢内容)。
							const back = Number.isFinite(Number(res && res.back)) ? Number(res.back) : 0;
							if (back > 0 && added) {
								const utf8bytes = new TextEncoder().encode(added);
								// 只看前 (back+1) 字节区间: 合法起始应该在 offset 处的字节
								// 位置之前 (host 回退了 back 字节, 所以真正的合法码点起始位一定
								// 在 [0, back] 字节之间)。
								const scanTo = Math.min(utf8bytes.length, back + 1);
								let startByteIdx = 0;
								for (let i = 0; i < scanTo; i++) {
									const b = utf8bytes[i];
									// 非续字节: !(b >> 6 === 0b10), 即 < 0x80 或 >= 0xC0
									if ((b & 0xC0) !== 0x80) {
										startByteIdx = i;
										break;
									}
								}
								if (startByteIdx > 0) {
									added = new TextDecoder("utf-8").decode(utf8bytes.subarray(startByteIdx));
								}
							}
							const nextContent = prev.content + added;
							return Object.assign({}, prev, {
								content: nextContent,
								truncated: !!res.truncated && !res.eof,
								eof: !!res.eof,
								loadedBytes: new Blob([nextContent]).size,
							});
						}
						return prev;
					});
				} catch (e) {
					setPreview((prev) => {
						if (!prev || prev.kind !== "text") return prev;
						return Object.assign({}, prev, {
							kind: "text", // 保持类型不变, 附一个错误提示
							content: prev.content + "\n\n[读取后续失败] " + String((e && e.message) || e) + "\n",
						});
					});
				} finally {
					setChunkLoading(false);
				}
			};

			// 挂载时获取起始目录 (带上当前激活会话 id, 宿主端据此优先返回会话 header.cwd,
			// 而不是 dsh 程序目录 runtime\dsh)。
			react.useEffect(() => {
				let alive = true;
				const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
				fetch(BASE + "/home?sessionId=" + encodeURIComponent(sessionId), { headers: { [GUARD_HEADER]: "1" } })
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
					} else if (res && res.kind === "image") {
						text = "[图片] " + menuEntry.path + "（" + fmtSize(res.size) + (res.truncated ? "，过大仅预览前部" : "") + "）";
					} else if (res && res.kind === "binary") {
						text = "[二进制文件] " + menuEntry.path + "（大小 " + fmtSize(res.size) + "，不支持内容插入）";
					} else {
						let body = res && typeof res.content === "string" ? res.content : "";
						let note = "";
						if (body.length > CONTENT_INSERT_CAP) {
							body = body.slice(0, CONTENT_INSERT_CAP);
							note = "（内容过长，已截断为前 " + CONTENT_INSERT_CAP + " 字符）";
						} else if (res && res.truncated) {
							note = "（文件过大，预览仅前部内容；请在文件浏览面板点击「再看后面一段」分批查看全文）";
						}
						text = "[文件] " + menuEntry.path + "\n" + body + "\n[文件内容结束]" + note;
					}
					queueInsert(text);
				} catch (e) {
					queueInsert("[文件] " + menuEntry.path + "（读取失败：" + String((e && e.message) || e) + "）");
				}
			}

			
/**
 * 把 reference mention 程序化插入当前会话输入框 (兼容层 v1).
 *
 * DSH 版本适配:
 *   - 0.1.1-rc.x 旧版: sessions.provideInfo 返回 { hooks.input, props.inputActions },
 *     手动读 draft/draftRev → setDraft → scope.bail('slash/input-insert-reference')
 *   - 0.1.2-rc.1 重构版: provideInfo 结构变化或移除 hooks.input/inputActions,
 *     旧 API 调用失败时降级到 DOM fallback (直接改 textarea.value + 触发 input 事件)。
 *
 * 优先级: 旧 DSH API > DOM fallback。
 *
 * @param {object} bridge - { provideInfo(id), scope(id) } 会话级通道 (可 null)
 * @param {string} sessionId - 当前会话 id
 * @param {string} mention - 如 "@src/main.py" 或 '@"path with spaces/file.txt"'
 * @param {string} label - 显示用的文件/会话名 (chip 上显示)
 * @param {string} appearance - "file" | "folder" | "session"
 * @returns {{ok:boolean, err?:string, method?:string}} method: old-api | dom-fallback | none
 */
function insertReferenceIntoInputCompat(bridge, sessionId, mention, label, appearance) {
    appearance = appearance || "file";

    // ---- 路径 A: 旧 DSH API (0.1.1-rc.x) ----
    if (bridge && typeof bridge.provideInfo === "function") {
        try {
            const info = bridge.provideInfo(sessionId);
            const inputStore = info && info.hooks && info.hooks.input;
            const actions = info && info.props && info.props.inputActions;

            if (inputStore && typeof inputStore.getSnapshot === "function" && actions) {
                const snap = inputStore.getSnapshot();
                if (snap && typeof snap.draft === "string") {
                    // 追加到草稿末尾, 非空且末尾无空白时补一个空格
                    let draft = snap.draft;
                    if (draft !== "" && !/\s$/.test(draft)) {
                        actions.setDraft(draft + " ");
                        const snap2 = inputStore.getSnapshot();
                        draft = snap2.draft;
                    }
                    // 派发官方插入事件
                    let actx = null;
                    try { actx = typeof bridge.scope === "function" ? bridge.scope(sessionId) : null; } catch (e) { /* noop */ }
                    if (actx && typeof actx.bail === "function") {
                        const span = { start: draft.length, end: draft.length, draftRev: snap.draftRev };
                        const reference = {
                            source: "reference", ref: mention, label, appearance, clipboardText: mention,
                        };
                        // 获取最新 shell.rev 避免 CAS 失败
                        try {
                            // 1. actx 本身继承 rootCtx, 应该有 conversation 服务
                            let conversationService = null;
        try { conversationService = actx && typeof actx.get === "function" ? actx.get("conversation") : null; } catch(e) {}
                            const sessionIdentifier = (actx.session && actx.session.id) || (props && props.sessionId) || null;
                            if (conversationService && sessionIdentifier && (conversationService.input && typeof conversationService.input.shell === "function")) {
                                const shellInstance = conversationService && conversationService.input && conversationService.input.shell ? conversationService.input.shell(sessionIdentifier) : null;
                                if (shellInstance) {
                                    const currentRev = shellInstance.rev;
                                    console.log("[file-browser] shell.rev =", currentRev, "old span.draftRev =", span.draftRev);
                                    span.draftRev = currentRev;
                                }
                            } else {
                                                                console.log("[file-browser] actx keys:", Object.keys(actx || {}));
                            }
                        } catch (debugError) { console.warn("[file-browser] rev 获取失败:", debugError); }
                        const applied = actx.bail(actx, "slash/input-insert-reference", { reference, span });
                        if (applied === true) {
                            return { ok: true, method: "old-api" };
                        }
                    }
                }
            }
        } catch (e) { /* fallthrough to DOM fallback */ }
    }

    // ---- 路径 B: DOM fallback (任何 DSH 版本) ----
    // React 受控组件里必须同时设 value + dispatch('input') 才会触发 onChange handler。
    try {
        const ta = document.querySelector("textarea");
        if (ta) {
            const cur = ta.value || "";
            const sep = cur !== "" && !/\s$/.test(cur) ? " " : "";
            const next = cur + sep + mention;
            const desc = Object.getOwnPropertyDescriptor(ta.constructor.prototype, "value");
            if (desc && desc.set) {
                desc.set.call(ta, next);
            } else {
                ta.value = next;
            }
            ta.dispatchEvent(new Event("input", { bubbles: true }));
            ta.dispatchEvent(new Event("change", { bubbles: true }));
            try { ta.selectionStart = ta.selectionEnd = next.length; } catch (e) { /* noop */ }
            return { ok: true, method: "dom-fallback" };
        }
        const editor = (typeof document !== "undefined") ? document.querySelector('[contenteditable="true"]') : null;
        if (ce) {
            const cur = (ce.innerText || ce.textContent || "");
            const sep = cur !== "" && !/\s$/.test(cur) ? " " : "";
            ce.innerText = cur + sep + mention;
            ce.dispatchEvent(new Event("input", { bubbles: true }));
            return { ok: true, method: "dom-fallback-ce" };
        }
        return { ok: false, err: "无法找到输入框 (textarea/contenteditable)", method: "none" };
    } catch (e) {
        return { ok: false, err: "DOM fallback 异常: " + String((e && e.message) || e), method: "none" };
    }
}

// ---- 官方 @ 引用插入 (衔接官方 @+文件 机制) ----
			// 把所选文件以"官方引用"形式插入输入框: 1) 换算成相对会话工作目录 (header.cwd)
			// 的 @"rel/path" mention; 2) 经 standard-kit 的 provideInfo 拿当前输入机状态
			// (draft/draftRev) 与 inputActions; 3) 向当前会话作用域派发官方事件
			// slash/input-insert-reference —— 与官方 @ 菜单 onPick → InputTriggerController
			// .execute 完全同一事件/结构, 由官方输入机 mint occurrence: 草稿里是 @label
			// chip, 提交时经 reference source 的 codec 序列化为 mention 文本发给模型。
			// 仅支持文件 (目录的官方 pick 会留开引号续补全, 不适合一键插入)。
			async function insertOfficialReference(menuEntry) {
			    try {
			                    const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
			                    let root = "";
			                    try {
			                        const res = await fetch(BASE + "/home?sessionId=" + encodeURIComponent(sessionId), {
			                            headers: { [GUARD_HEADER]: "1" },
			                        });
			                        const payload = await res.json().catch(() => null);
			                        root = payload && typeof payload.root === "string" ? payload.root : "";
			                    } catch (e) { /* below */ }
			                    if (!root) { showNotice("Cannot get session cwd, official @ unavailable"); return; }
			                    const rel = relativePosix(root, menuEntry.path);
			                    if (rel === null || rel === "" || rel === ".." || rel.startsWith("../")) {
			                        showNotice("File outside session cwd, official @ only supports relative path");
			                        return;
			                    }
			                    // DSH 0.1.2-rc.1: sessions.scope(sessionId) -> actx,
			                    // actx.bail(actx, "slash/input-insert-reference") -> official chip
			                    let actx = null;
			                    try { actx = props && props.bridge && typeof props.bridge.scope === "function" ? props.bridge.scope(sessionId) : null; } catch (e) { actx = null; }
			                    			                    if (!actx) { showNotice("Cannot get session scope"); return; }
			                    const inputState = (typeof window !== "undefined") ? window.__dshInputState : null;
			                    const draft = (inputState && typeof inputState.draft === "string") ? inputState.draft : "";
			                    const draftRev = (inputState && typeof inputState.draftRev === "number") ? inputState.draftRev : 0;
			                    const caret = draft.length;
			                    const reference = {
			                        source: "reference",
			                        ref: "@" + rel,
			                        label: (menuEntry.path.split(/[\\/]/).pop()) || rel,
			                        appearance: "file",
			                        clipboardText: "@" + rel,
			                    };
			                    // 从 DSH shell 拿最新 rev 避免 CAS 失败
			                    let effectiveDraftRev = draftRev;
			                    try {
			                        let conversationService = null;
        try { conversationService = actx && typeof actx.get === "function" ? actx.get("conversation") : null; } catch(e) {}
			                        const sessionIdentifier = (actx.session && actx.session.id) || sessionId || null;
			                        if (conversationService && sessionIdentifier && (conversationService.input && typeof conversationService.input.shell === "function")) {
			                            const shellInstance = conversationService && conversationService.input && conversationService.input.shell ? conversationService.input.shell(sessionIdentifier) : null;
			                            if (shellInstance) {
			                                const liveRev = shellInstance.rev;
			                                if (typeof liveRev === "number" && liveRev !== draftRev) {
			                                    console.log("[file-browser path2] draftRev:", draftRev, "→ liveRev:", liveRev);
			                                    effectiveDraftRev = liveRev;
			                                }
			                            }
			                        }
			                    } catch (revErr) { console.warn("[file-browser path2] rev error:", revErr); }
			                    const span = { start: caret, end: caret, draftRev: effectiveDraftRev };
			                    // 先尝试 DSH 官方 bail API (chip 插入)
			                    let ok = false;
			                    try { ok = actx.bail(actx, "slash/input-insert-reference", { reference, span }) === true; } catch (e) { ok = false; }
			                    if (ok) {
			                        showNotice("Inserted official chip: @" + rel);
			                    } else {
			                        // Fallback: 直接 DOM 操作往输入框插文本
			                        try {
			                            const editor = (typeof document !== "undefined") ? document.querySelector('[contenteditable="true"]') : null;
			                            if (editor) {
			                                editor.focus();
			                                const inserted = document.execCommand("insertText", false, "@" + rel + " ");
			                                if (inserted) {
			                                    showNotice("已插入文本: @" + rel);
			                                } else {
			                                    showNotice("请手动输入: @" + rel);
			                                }
			                            } else {
			                                showNotice("请手动输入: @" + rel);
			                            }
			                        } catch (domErr) {
			                            showNotice("请手动输入: @" + rel);
			                        }
			                    }
			                    setMenu(null);
			    } catch (e) {
			        console.error("[file-browser] insertOfficialReference error:", e);
			        try { showNotice("插入报错: " + (e && e.message || e)); } catch (_) {}
			    }
        }

			function buildMenuItems(menuEntry) {
				const isDir = menuEntry.type === "directory";
				const items = [];
				// 官方 @+文件 引用插入 (文件专属, 排第一): 与官方 @ 菜单同源的引用 chip。
				if (!isDir) {
					items.push({
						label: "以官方 @ 引用插入",
						icon: "@",
						onClick: () => { setMenu(null); insertOfficialReference(menuEntry); },
					});
				}
				items.push({
					label: isDir ? "插入目录路径到输入框" : "插入文件路径到输入框",
					icon: isDir ? "\uD83D\uDCC1" : "\uD83D\uDCC4",
					onClick: () => { queueInsert(menuEntry.path); setMenu(null); },
				});
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
				previewBody = react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, [
					preview.truncated
						? react.createElement("div", { key: "note", style: statusStyle }, "图片过大（" + fmtSize(preview.size) + "），以下为前部缩略预览（建议直接用图片文件双击打开看原图）。")
						: react.createElement("div", { key: "note", style: statusStyle }, fmtSize(preview.size)),
					preview.src
						? react.createElement("img", {
							key: "img",
							src: preview.src,
							alt: "preview",
							style: { maxWidth: "100%", height: "auto", borderRadius: 6, display: "block" },
						})
						: react.createElement("div", { key: "na", style: errorStyle }, "预览失败：未能生成缩略数据"),
				]);
			} else if (preview.kind === "binary") {
				const head = preview.head || "";
				let headDisplay = "";
				if (head) {
					try {
						const buf = Uint8Array.from(atob(head), (c) => c.charCodeAt(0));
						const hex = Array.from(buf.slice(0, 64)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
						const ascii = Array.from(buf.slice(0, 64)).map((b) => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : ".").join("");
						headDisplay = hex + "\n" + ascii;
					} catch (_decodeErr) { headDisplay = ""; }
				}
				previewBody = react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, [
					react.createElement("div", { key: "note", style: statusStyle }, "二进制文件，大小 " + fmtSize(preview.size) + (preview.truncated ? "（预览仅前部 " + BINARY_HEAD_BYTES + " 字节 head）" : "")),
					headDisplay
						? react.createElement("pre", {
							key: "head",
							style: {
								margin: 0,
								fontFamily: "ui-monospace, SFMono-Regular, Consolas, 'Courier New', monospace",
								fontSize: 11,
								lineHeight: 1.5,
								whiteSpace: "pre-wrap",
								wordBreak: "break-all",
								background: C.bg1,
								padding: 8,
								borderRadius: 6,
								color: C.text,
							},
						}, headDisplay)
						: null,
				]);
			} else {
				// kind === "text"
				const meta = fmtSize(preview.size);
				const truncatedNote = preview.truncated
					? "已预览前部 " + fmtSize(preview.loadedBytes || 0) + "，共 " + meta
					: meta + "（已全部载入）";
				const children = [
					react.createElement("div", { key: "meta", style: statusStyle }, truncatedNote),
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
				];
				if (preview.truncated && !preview.eof) {
					children.push(react.createElement("div", {
						key: "more",
						style: { flex: "none", display: "flex", alignItems: "center", justifyContent: "flex-start", gap: 8, padding: "6px 0" },
					}, [
						react.createElement("button", {
							key: "btn",
							type: "button",
							disabled: chunkLoading,
							style: {
								border: "1px solid " + C.border,
								background: C.bg1,
								color: C.text,
								borderRadius: 6,
								padding: "4px 10px",
								fontSize: 12,
								cursor: chunkLoading ? "default" : "pointer",
								opacity: chunkLoading ? 0.6 : 1,
							},
							onClick: loadMoreChunk,
						}, chunkLoading ? "加载中…" : "再看后面一段（512KB）"),
						react.createElement("span", { key: "tip", style: { fontSize: 11, color: C.text2 } }, "可连续点击直到文件末尾"),
					]));
				} else if (preview.eof) {
					children.push(react.createElement("div", { key: "eof", style: { fontSize: 11, color: C.text2, padding: "4px 0" } }, "已到文件末尾 ✓"));
				}
				previewBody = react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, minHeight: "100%" } }, children);
			}

			const panelStyle = {
				position: "fixed",
				left: win.left,
				top: win.top,
				width: win.width,
				height: win.height,
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
				cursor: "move",
			};

			// 四个拉伸手柄: 右 (ew-resize) / 下 (ns-resize) / 右下 (nwse-resize)。
			// 全部放在面板边界内 (right/bottom 为 0, 避免被 overflow:hidden 裁剪),
			// 并用半透明品牌色背景, 让用户一眼能看出这里可以拖拽调整尺寸。
			const resizeHandleBase = {
				position: "absolute",
				zIndex: 8,
				userSelect: "none",
				background: "rgba(74, 123, 255, 0.22)",
			};
			const rightHandleStyle = {
				...resizeHandleBase,
				top: 10,
				bottom: 10,
				right: 0,
				width: 6,
				cursor: "ew-resize",
				borderRadius: "0 3px 3px 0",
			};
			const bottomHandleStyle = {
				...resizeHandleBase,
				left: 10,
				right: 10,
				bottom: 0,
				height: 6,
				cursor: "ns-resize",
				borderRadius: "0 0 3px 3px",
			};
			const brHandleStyle = {
				...resizeHandleBase,
				right: 0,
				bottom: 0,
				width: 16,
				height: 16,
				cursor: "nwse-resize",
				background: "rgba(74, 123, 255, 0.34)",
				borderRadius: "12px 0 12px 0",
			};
			// 右下角拖拽指示: 两条对角线 (放在 br 手柄内部, 随手柄移动)。
			const brGripStyle = {
				position: "absolute",
				right: 3,
				bottom: 3,
				width: 9,
				height: 9,
				borderRight: "2px solid " + C.brand,
				borderBottom: "2px solid " + C.brand,
				borderRadius: "0 0 2px 0",
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
				// 拉伸手柄: 右下角 BR + 右侧 R + 底部 B (顺序靠前, 避免被其他内部元素盖住事件)。
				react.createElement("div", { key: "hrR", style: rightHandleStyle, onMouseDown: (e) => windowOnDown(e, "r"), title: "拖动调整宽度" }),
				react.createElement("div", { key: "hrB", style: bottomHandleStyle, onMouseDown: (e) => windowOnDown(e, "b"), title: "拖动调整高度" }),
				react.createElement("div", { key: "hrBR", style: brHandleStyle, onMouseDown: (e) => windowOnDown(e, "br"), title: "拖动调整尺寸" },
					react.createElement("div", { key: "grip", style: brGripStyle })),
				react.createElement("div", {
					key: "header", style: headerStyle,
					onMouseDown: (e) => windowOnDown(e, "move"),
					// 避免拖动头部时选中文本
					onDoubleClick: (e) => { e.preventDefault(); /* 预留: 双击可重置尺寸 */ },
				}, [
					react.createElement("span", { key: "t", style: { fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" } }, "文件浏览"),
					react.createElement("input", {
						key: "p",
						style: inputStyle,
						value: pathInput,
						placeholder: "输入路径后回车",
						onChange: (ev) => setPathInput(ev.target.value),
						onKeyDown: (ev) => { if (ev.key === "Enter") goToPath(); },
						onMouseDown: (e) => e.stopPropagation(),  // 输入框不触发拖动
					}),
					react.createElement("button", { key: "r", type: "button", style: btnStyle, onClick: () => loadDir(cwd || pathInput), title: "刷新", onMouseDown: (e) => e.stopPropagation() }, "\u21BB"),
					react.createElement("button", { key: "c", type: "button", style: btnStyle, onClick: props.onClose, title: "关闭", onMouseDown: (e) => e.stopPropagation() }, "\u2715"),
				]),
				react.createElement("div", { key: "body", style: { flex: 1, display: "flex", minHeight: 0 } }, [
					react.createElement("div", { key: "list", style: { width: "46%", flex: "none", borderRight: "1px solid " + C.border, overflowY: "auto" } }, listBody),
					react.createElement("div", { key: "preview", style: { flex: 1, minWidth: 0, overflow: "auto", padding: "10px 12px" } }, previewBody),
				]),
				react.createElement("div", {
					key: "footer",
					style: { flex: "none", borderTop: "1px solid " + C.border, padding: "6px 12px", color: notice ? C.error : C.text2, fontSize: 11 },
				}, notice
					? notice
					: (busy ? "加载中…" : (entries ? entries.length + (truncated ? "+ 项（已截断）" : " 项") : ""))),
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
// 把 inputActions 暴露到 window, 给 sidebar-lite 等兄弟插件用 (DSH 0.1.2-rc.1 跨插件桥接)
                                   if (typeof window !== undefined) {
                                           window.__dshInputActions = inputActions || null;
                                           window.__dshInputState = input || null;
                                           window.__dshSessions = ctx && ctx.sessions || null;
                                   }

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
						title: "文件浏览（右键文件可 @ 引用插入 / 插入路径 / 插入内容 / 复制）",
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
					// 当前激活会话 id: 官方 sessions.list store 快照的字段是 current
					// (不是 sessionId! 用错字段会恒为 null)。传给宿主端 /home, 让它优先
					// 返回该会话的 header.cwd 作为文件浏览弹窗的默认路径。
					let sessionId = "";
					try {
						const sessions = ctx && ctx.sessions;
						const snapshot = sessions && sessions.list && typeof sessions.list.getSnapshot === "function"
							? sessions.list.getSnapshot()
							: null;
						sessionId = (snapshot && (snapshot.current || snapshot.sessionId)) || "";
					} catch (e) { /* 取不到就按无会话处理, 宿主端回退工作区根 */ }
					// 官方 @ 引用插入需要的会话级通道 (尽量少暴露 ctx 本体):
					//   provideInfo(id) -> standard-kit 提供包 { hooks: { input: 输入机状态 store }, props: { inputActions } }
					//   scope(id)       -> 会话作用域 ctx (用于派发 slash/input-insert-reference)
					const bridge = {
						provideInfo: (id) => {
							try {
								const sessions = ctx && ctx.sessions;
								return sessions && typeof sessions.provideInfo === "function" ? sessions.provideInfo(id) : null;
							} catch (e) { return null; }
						},
						scope: (id) => {
							try {
								const sessions = ctx && ctx.sessions;
								return sessions && typeof sessions.resolveAgentScope === "function" ? sessions.resolveAgentScope(id) : (sessions && typeof sessions.scope === "function" ? sessions.scope(id) : null);
							} catch (e) { return null; }
						},
					};
					return react.createElement(FileBrowser, { onClose: () => setOpen(false), sessionId, bridge });
				},
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});

