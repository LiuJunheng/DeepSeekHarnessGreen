// DeepSeek Harness 插件 (客户端): dsh-sidebar-lite
// 在 WebUI 右侧注入一个轻量侧边栏 (参考/复刻自第三方插件 DSH Better Sidebar
// omdsh-dev/DSH-better-sidebar 的交互形态, 提供五项能力)。
//   1) 资源管理器:   读取会话工作目录的目录树, 支持「返回上级 / 路径框」上溯浏览任意路径;
//   2) 文件预览/编辑: 文本就地编辑 + 保存回写; 图片/PDF/HTML 通过 fetch+blob 预览
//                     (宿主端 file 媒体路由要求防御头, <img>/<iframe> 携带不了,
//                      故统一 fetch→blob→objectURL);
//   3) 内嵌浏览器:   地址栏导航 + 沙箱 iframe;
//   4) CMD 终端:     child_process spawn cmd.exe + SSE 流 (逐行执行命令), 轻量不依赖 node-pty;
//   5) 任务管理:     读取官方 session/jobs 推送镜像 (jobsBySession) 列出后台任务,
//                    并可查看 AI 读取到的输出 / 请求停止 (jobs.output / jobs.kill)。
// 数据全部走宿主端路由 /__dsh/sidebar-lite/* (POST JSON / GET 媒体), 均带防御头。
// 会话溯源: 通过 ctx.sessions.list 订阅当前激活会话, 取其 id 与摘要 cwd 上报宿主。
// 挂载方式: 与 better-sidebar 一致, 往 document.body 挂一个 portal div 再用
// createRoot 渲染, 不依赖官方任何内部布局插槽, 也不修改任何官方文件。
// 这是加载器契约格式 (window.__ModuleLoader__.load), 与官方客户端插件一致。

window.__ModuleLoader__.load({
	id: "dsh-sidebar-lite",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// createRoot 解析: 优先 react-dom/client, 缺省回退到全局 ReactDOM.createRoot。
		var reactRootFactory = null;
		try {
			reactRootFactory = require("react-dom/client");
		} catch (__e1) {
			reactRootFactory = null;
		}
		var createRootFn = null;
		if (reactRootFactory && reactRootFactory.createRoot) {
			createRootFn = reactRootFactory.createRoot;
		} else if (globalThis.ReactDOM && globalThis.ReactDOM.createRoot) {
			createRootFn = globalThis.ReactDOM.createRoot;
		}

		const inject = ["slots", "sessions"];

		// ---- 常量 ----
		const API_PREFIX = "/__dsh/sidebar-lite";
		const GUARD_HEADER = "X-DSH-Sidebar-Lite";
		const PANEL_WIDTH = 320;            // 展开宽度 (px)
		const CSS_VAR = "--dsh-sidebar-lite-width";
		const STYLE_ID = "dsh-sidebar-lite-css";
		// 需要就地编辑的文本扩展名 (其余命中宿主端 fs.read 的 text 判定也同样可编辑)。
		const EDITABLE_EXTS = [
			"js", "jsx", "ts", "tsx", "json", "py", "md", "txt", "yml", "yaml",
			"c", "cc", "cpp", "h", "hpp", "java", "go", "rs", "css", "less", "scss",
			"html", "htm", "xml", "toml", "ini", "cfg", "log", "csv", "tsv",
			"sh", "bat", "cmd", "ps1", "tex", "sql", "http",
		];

		// ---- 命名空间 (防止样式串扰 / 卸载残留) ----
		const N = "dsl";

		// ---- API 辅助 ----

		/** POST 一段 JSON 到宿主方法, 带防御头; 返回 payload (service 层的 ok 校验)。 */
		async function postMethod(method, payload) {
			const response = await fetch(API_PREFIX + "/" + method, {
				method: "POST",
				headers: { "content-type": "application/json", [GUARD_HEADER]: "1" },
				body: JSON.stringify(payload),
			});
			const data = await response.json().catch(() => null);
			if (!response.ok || data === null || data.ok !== true) {
				throw new Error((data && data.error) || ("HTTP " + response.status));
			}
			return data;
		}

		/** 取媒体字节为 blob objectURL (预览用)。 */
		async function fetchBlobUrl(scope, path) {
			const params = new URLSearchParams({ sessionId: scope.sessionId || "" });
			if (scope.cwd) params.set("cwd", scope.cwd);
			params.set("path", path);
			const response = await fetch(API_PREFIX + "/file?" + params.toString(), {
				headers: { [GUARD_HEADER]: "1" },
			});
			if (!response.ok) {
				const data = await response.json().catch(() => null);
				throw new Error((data && data.error) || ("HTTP " + response.status));
			}
			const blob = await response.blob();
			return URL.createObjectURL(blob);
		}

		/** 文件扩展名小写 (无扩展名返回空串)。 */
		function extOf(name) {
			const i = name.lastIndexOf(".");
			return i < 0 ? "" : name.slice(i + 1).toLowerCase();
		}

		function errMessage(error) {
			return (error && error.message) ? error.message : String(error);
		}

		/** 目录分隔符统一的绝对路径取父目录 (Windows 反斜杠兼容)。 */
		function dirnameOf(filePath) {
			const fixed = filePath.replace(/\\/g, "/");
			const index = fixed.lastIndexOf("/");
			if (index <= 0) return fixed;
			return fixed.slice(0, index);
		}

		/** 把目录与相对名拼成绝对路径 (统一正斜杠, 避免混合分隔符)。 */
		function joinPath(dir, name) {
			const normalizedDir = dir.replace(/\\/g, "/").replace(/\/$/, "");
			return normalizedDir + "/" + name.replace(/\\/g, "/");
		}

		/** 相对路径 (把绝对 path 减去 cwd 前缀, 得到可从工作目录访问的相对路径)。 */
		function relativeTo(cwd, absolutePath) {
			const fixedCwd = (cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
			const fixedPath = absolutePath.replace(/\\/g, "/");
			if (fixedCwd && fixedPath.startsWith(fixedCwd + "/")) {
				return fixedPath.slice(fixedCwd.length + 1);
			}
			return fixedPath;
		}

		/** 写剪贴板 (优先 navigator.clipboard, 缺省回退到 execCommand 兼容旧内核)。 */
		function writeClipboard(text) {
			if (navigator.clipboard && navigator.clipboard.writeText) {
				return navigator.clipboard.writeText(text).then(
					() => true,
					() => fallbackCopy(text)
				);
			}
			return Promise.resolve(fallbackCopy(text));
		}
		function fallbackCopy(text) {
			try {
				const textarea = document.createElement("textarea");
				textarea.value = text;
				textarea.style.position = "fixed";
				textarea.style.opacity = "0";
				document.body.appendChild(textarea);
				textarea.select();
				const ok = document.execCommand("copy");
				textarea.remove();
				return ok;
			} catch (e) {
				return false;
			}
		}

		/** 通过宿主 file 媒体路由"另存为"文件。 因路由要求防御头, 无法用 <a href> 直接跳转,
		 *  需先 fetch(带防御头)→blob 拿到字节。 因为是本地机器, "另存为"语义更贴合:
		 *  优先用原生「另存为」对话框 (File System Access API, showSaveFilePicker) 让用户
		 *  自由选择保存位置; 该 API 不可用时回退为浏览器自动下载 (同名文件)。
		 *  注意: 需在用户手势内先弹出对话框, 避免 fetch 异步丢失去焦点后对话框被浏览器拦截。 */
		async function saveAsFile(scope, path) {
			const fileName = path.split("/").pop() || "file";
			let saveHandle = null;
			// 优先弹出原生「另存为」对话框 (需在用户手势窗口内调用)。
			if (window.showSaveFilePicker) {
				try {
					saveHandle = await window.showSaveFilePicker({ suggestedName: fileName });
				} catch (pickError) {
					// 用户取消对话框 (AbortError) 或 API 受限不放行: 直接返回, 不触发下载。
					return;
				}
			}
			try {
				const params = new URLSearchParams({ sessionId: scope.sessionId || "", download: "1" });
				if (scope.cwd) params.set("cwd", scope.cwd);
				params.set("path", path);
				const response = await fetch(API_PREFIX + "/file?" + params.toString(), {
					headers: { [GUARD_HEADER]: "1" },
				});
				if (!response.ok) {
					const data = await response.json().catch(() => null);
					throw new Error((data && data.error) || ("HTTP " + response.status));
				}
				const blob = await response.blob();
				// 用户已通过对话框选好保存位置: 写入该文件。
				if (saveHandle) {
					const writable = await saveHandle.createWritable();
					await writable.write(blob);
					await writable.close();
					return;
				}
				// 回退: 创建 <a> 触发浏览器下载 (无法选择位置时的兜底)。
				const objectUrl = URL.createObjectURL(blob);
				const anchor = document.createElement("a");
				anchor.href = objectUrl;
				anchor.download = fileName;
				anchor.style.display = "none";
				document.body.appendChild(anchor);
				anchor.click();
				anchor.remove();
				window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
			} catch (e) {
				console.error("[dsh-sidebar-lite] save-as failed:", e);
			}
		}

		/**
		 * 挂接终端 SSE 流并消费其输出事件。返回一个 AbortController, 供组件在卸载时停止读取
		 * (注意: 只断开读取, 不结束宿主端进程, 重进终端页会重新挂接并收到历史回放)。
		 * @param {object} scope - 会话作用域 { sessionId, cwd? }。
		 * @param {string} tab - 终端标签页 id。
		 * @param {function} onText - 每次收到一段输出文本时回调 (包含回放与实时输出)。
		 * @param {function} onError - 出错回调。
		 * @returns {{controller:AbortController, stop:function}} 控制句柄。
		 */
		function attachTerminalStream(scope, tab, onText, onError) {
			const controller = new AbortController();
			const params = new URLSearchParams({ sessionId: scope.sessionId || "" });
			if (scope.cwd) params.set("cwd", scope.cwd);
			params.set("tab", tab);
			(async () => {
				try {
					const response = await fetch(API_PREFIX + "/terminal.stream?" + params.toString(), {
						headers: { [GUARD_HEADER]: "1" },
						signal: controller.signal,
					});
					if (!response.ok || !response.body) {
						onError("终端流连接失败: HTTP " + response.status);
						return;
					}
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						let sepIndex;
						// SSE 事件以空行 "\n\n" 分隔, 逐条解析取出 data: 行里的 JSON。
						while ((sepIndex = buffer.indexOf("\n\n")) >= 0) {
							const eventText = buffer.slice(0, sepIndex);
							buffer = buffer.slice(sepIndex + 2);
							for (const line of eventText.split("\n")) {
								if (line.indexOf("data: ") !== 0) continue;
								try {
									const data = JSON.parse(line.slice(6));
									if (typeof data.text === "string" && data.text !== "") onText(data.text);
								} catch { /* 非 JSON 事件忽略 */ }
							}
						}
					}
				} catch (e) {
					if (e && e.name !== "AbortError") onError(errMessage(e));
				}
			})();
			return {
				controller,
				stop: () => { try { controller.abort(); } catch (e2) { /* ignore */ } },
			};
		}

		// ---- 注入全局样式 (侧边栏定位 + #root 让位, 展开/收起) ----

		function injectStyles() {
			if (document.getElementById(STYLE_ID)) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent =
				"#" + N + "-host{position:fixed;top:0;right:0;bottom:0;width:var(" + CSS_VAR + "," + PANEL_WIDTH + "px);" +
				"z-index:2147482999;transition:width .18s ease;display:flex;flex-direction:column;" +
				"background:var(--dsw-alias-fill-solid,#ffffff);box-shadow:-1px 0 0 var(--dsw-alias-stroke-default,#e5e5e5);}" +
				"#" + N + "-host." + N + "-closed{width:0;box-shadow:none;overflow:hidden;}" +
				"#" + N + "-host." + N + "-resizing{transition:none;cursor:col-resize;user-select:none;}" +
				"#" + N + "-ribbon{position:fixed;top:10px;right:8px;z-index:2147483000;" +
				"border:1px solid var(--dsw-alias-stroke-default,#ddd);border-radius:6px;" +
				"background:var(--dsw-alias-fill-solid,#ffffff);box-shadow:0 1px 3px rgba(0,0,0,.08);" +
				"color:var(--dsw-alias-label-secondary,#8a8f98);cursor:pointer;" +
				"font:14px/1 ui-monospace,Menlo,monospace;padding:6px 8px;}" +
				"#" + N + "-host ::-webkit-scrollbar{width:8px;height:8px;}" +
				"#" + N + "-host ::-webkit-scrollbar-thumb{background:#c9c9c9;border-radius:4px;}" +
				"#root{margin-right:var(" + CSS_VAR + ",0px);transition:margin-right .18s ease;}";
			document.head.appendChild(style);
		}

		function setPanelWidth(width) {
			try {
				document.documentElement.style.setProperty(CSS_VAR, width + "px");
			} catch (e) { /* ignore */ }
		}

		// ---- 小控件 ----

		function IconChevron({ open }) {
			return react.createElement("span", {
				style: { display: "inline-block", width: 12, textAlign: "center", fontSize: 11, color: "#8a8f98", flex: "none" },
			}, open ? "▾" : "▸");
		}

		// 用文件夹/文件图标 (folder=文件家图, file=文档图)
		function IconLayer(kind) {
			return react.createElement("span", { style: { fontSize: 12, flex: "none" } }, kind === "f" ? "📁" : "📄");
		}

		// ---- 右键上下文菜单 (与 better-sidebar 一致: 下载[仅文件] / 复制相对 / 复制绝对) ----

		function ContextMenu({ x, y, entry, onSelect }) {
			const itemStyle = { padding: "6px 10px", cursor: "pointer", fontSize: 12.5, whiteSpace: "nowrap" };
			const sepStyle = { height: 1, background: "var(--dsw-alias-stroke-default,#eee)", margin: "3px 4px" };
			// 仅文件行提供"另存为"(本地机器, 用对话框自选保存位置), 目录行只提供复制相对/绝对。
			const items = [];
			if (!entry.isDir) {
				items.push(react.createElement("div", { key: "saveas", style: itemStyle, onClick: () => onSelect("saveas") }, "另存为"));
			}
			if (items.length > 0) {
				items.push(react.createElement("div", { key: "sep0", style: sepStyle }));
			}
			items.push(react.createElement("div", { key: "relative", style: itemStyle, onClick: () => onSelect("relative") }, "复制相对路径"));
			items.push(react.createElement("div", { key: "absolute", style: itemStyle, onClick: () => onSelect("absolute") }, "复制绝对路径"));
			return react.createElement("div", {
				style: {
					position: "fixed", left: Math.min(x, window.innerWidth - 190), top: Math.min(y, window.innerHeight - 240),
					zIndex: 2147483001, minWidth: 172, background: "var(--dsw-alias-fill-solid,#ffffff)",
					border: "1px solid var(--dsw-alias-stroke-default,#ddd)", borderRadius: 6,
					boxShadow: "0 4px 16px rgba(0,0,0,.12)", padding: "4px 0",
				},
				onMouseDown: (event) => event.stopPropagation(),
				onContextMenu: (event) => event.preventDefault(),
			}, items);
		}

		// ---- 资源管理器节点 (递归目录) ----

		function TreeNode({ entry, depth, scope, onOpenFile, onMenu }) {
			const [expanded, setExpanded] = react.useState(false);
			const [children, setChildren] = react.useState(null); // null=未加载
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);

			const toggle = async () => {
				if (!entry.isDir) {
					onOpenFile(entry);
					return;
				}
				const next = !expanded;
				setExpanded(next);
				if (next && children === null && !busy) {
					setBusy(true);
					setError(null);
					try {
						const data = await postMethod("fs.tree", { sessionId: scope.sessionId, ...(scope.cwd ? { cwd: scope.cwd } : {}), path: entry.path });
						setChildren((data.listing && data.listing.entries) || []);
					} catch (e) {
						setError(errMessage(e));
						setChildren([]);
					} finally {
						setBusy(false);
					}
				}
			};

			return react.createElement("div", { key: entry.path }, [
				react.createElement("div", {
					key: "row",
					style: { display: "flex", alignItems: "center", gap: 4, padding: "2px 4px", paddingLeft: 6 + depth * 22, cursor: "pointer", fontSize: 12.5, userSelect: "none", whiteSpace: "nowrap", overflow: "hidden" },
					title: entry.path,
					onClick: toggle,
					onContextMenu: (event) => {
						event.preventDefault();
						event.stopPropagation();
						onMenu(entry, event.clientX, event.clientY);
					},
				}, [
					IconChevron({ open: expanded }),
					entry.isDir ? IconLayer("f") : IconLayer("d"),
					react.createElement("span", { key: "n", style: { color: entry.hidden ? "#b0b6c0" : "inherit", textDecoration: entry.isDir ? "none" : undefined } }, entry.name),
				]),
				entry.isDir && expanded && react.createElement("div", { key: "children" }, [
					busy && children === null && react.createElement("div", { key: "busy", style: { paddingLeft: 6 + (depth + 1) * 22, fontSize: 11, color: "#8a8f98" } }, "加载中…"),
					children !== null && error && react.createElement("div", { key: "err", style: { paddingLeft: 6 + (depth + 1) * 22, fontSize: 11, color: "#c0392b" } }, "读取失败"),
					children !== null && children.length === 0 && !error && react.createElement("div", { key: "empty", style: { paddingLeft: 6 + (depth + 1) * 22, fontSize: 11, color: "#8a8f98" } }, "(空目录)"),
					children !== null ? children.map((child) => react.createElement(TreeNode, { key: child.path, entry: child, depth: depth + 1, scope, onOpenFile, onMenu })) : null,
				]),
			]);
		}

		// ---- 资源管理器面板 ----

		function ExplorerView({ scope, cwd, workspaceRoot, rootName, onOpenFile }) {
			// 当前正在浏览的目录 (默认优先用会话工作目录 cwd——即"这个会话锁指定的目录"
			// session.header.cwd, 如 D:\DeepSeekHarnessLauncher；无会话/无 cwd 时回退到
			// 工作区根 workspaceRoot)。
			// 支持「返回上级」与路径框上溯任意路径，不再锁死在会话 cwd 内。
			const initialRoot = (cwd || workspaceRoot || "");
			const [currentPath, setCurrentPath] = react.useState(initialRoot);
			const [pathBox, setPathBox] = react.useState(initialRoot);
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [rootEntries, setRootEntries] = react.useState(null);
			const [detail, setDetail] = react.useState(null);
			const [refreshTick, setRefreshTick] = react.useState(0);
			// 单个共享右键菜单 (与原版一致): 记录触发行 + 光标位置; 复制成功短暂显示"已复制"。
			const [rowMenu, setRowMenu] = react.useState(null);
			const [copiedPath, setCopiedPath] = react.useState(null);

			// 工作区根/会话工作目录可能在会话挂载后才确定, 首次拿到后同步当前浏览目录。
			// 与 initialRoot 一致: 会话工作目录 cwd 优先 (即"这个会话锁指定的目录"),
			// 工作区根 workspaceRoot 兜底。
			react.useEffect(() => {
				if (currentPath === "") {
					const target = cwd || workspaceRoot || "";
					if (target !== "") {
						setCurrentPath(target);
						setPathBox(target);
					}
				}
			}, [cwd, workspaceRoot]);

			react.useEffect(() => {
				let cancelled = false;
				if (currentPath === "") return;
				setBusy(true);
				setError(null);
				setRootEntries(null);
				(async () => {
					try {
						const data = await postMethod("fs.tree", { sessionId: scope.sessionId, ...(scope.cwd ? { cwd: scope.cwd } : {}), path: currentPath });
						if (cancelled) return;
						setRootEntries((data.listing && data.listing.entries) || []);
					} catch (e) {
						if (!cancelled) setError(errMessage(e));
					} finally {
						if (!cancelled) setBusy(false);
					}
				})();
				return () => { cancelled = true; };
			}, [currentPath, scope.sessionId, refreshTick]);

			// 进入上级目录 (回到菜单目录; 已是盘符/根目录时禁用)。
			const parentPath = dirnameOf(currentPath);
			const fixedCurrent = currentPath.replace(/\\/g, "/");
			const isDriveRoot = /^[A-Za-z]:[\\/]?$/i.test(fixedCurrent) || fixedCurrent === "/" || currentPath === "";
			const canGoUp = currentPath !== "" && parentPath !== currentPath && !isDriveRoot;
			const goUp = () => {
				if (!canGoUp) return;
				setCurrentPath(parentPath);
				setPathBox(parentPath);
			};
			// 通过路径框跳转到任意目录 (回车触发)。
			const goToPath = () => {
				const trimmed = pathBox.trim();
				if (trimmed === "" || trimmed === currentPath) return;
				setCurrentPath(trimmed);
			};

			const openFile = (entry) => {
				setDetail({ entry, scope });
			};

			// 打开右键菜单 (记录触发行与光标位置)。
			const openMenu = (entry, x, y) => {
				setRowMenu({ entry, x, y });
			};

			// 复制文本; 成功后把该行标记为"已复制"并短暂显示。
			const copyPath = (text, path) => {
				writeClipboard(text).then((ok) => {
					if (!ok) return;
					setCopiedPath(path);
					window.setTimeout(() => {
						setCopiedPath((current) => (current === path ? null : current));
					}, 1200);
				});
			};

			// 菜单项点击: 'saveas' 走另存为, 'relative'/'absolute' 走复制。
			const onMenuSelect = (id) => {
				const menu = rowMenu;
				if (menu === null) return;
				setRowMenu(null);
				if (id === "saveas") {
					saveAsFile(scope, menu.entry.path);
					return;
				}
				const text = id === "relative"
					? relativeTo(currentPath, menu.entry.path)
					: menu.entry.path;
				copyPath(text, menu.entry.path);
			};

			const currentLabel = (currentPath || rootName || "工作目录").replace(/[\\/]+$/, "").split(/[\\/]/).pop();

			return react.createElement("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1, position: "relative" } }, [
				// 资源管理头: 返回上级 + 根目录名 + 路径框 + 回到工作目录 + 刷新按钮。
				react.createElement("div", { key: "head", style: { display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderBottom: "1px solid var(--dsw-alias-stroke-default,#eee)" } }, [
					react.createElement("button", { key: "up", type: "button", disabled: !canGoUp, style: { cursor: canGoUp ? "pointer" : "default", fontSize: 12, padding: "2px 6px", opacity: canGoUp ? 1 : 0.4 }, title: "返回上级 (" + parentPath + ")", onClick: goUp }, "⬆"),
					react.createElement("input", {
						key: "path",
						type: "text",
						value: pathBox,
						spellCheck: false,
						placeholder: "完整路径, 回车跳转",
						style: { flex: 1, minWidth: 0, padding: "3px 6px", fontSize: 11, border: "1px solid var(--dsw-alias-stroke-default,#ccc)", borderRadius: 4, outline: "none" },
						onChange: (event) => setPathBox(event.target.value),
						onKeyDown: (event) => { if (event.key === "Enter") goToPath(); },
					}),
					// 回到工作目录: 目标是「这个会话锁指定的目录」= 会话工作目录 cwd
					// (session.header.cwd), 而非 dsh 程序目录 runtime\dsh、也非工作区根;
					// 无会话/无 cwd 时才回退到工作区根 workspaceRoot。
					// 图标用内联 SVG 房子 (不依赖字体字形, 跨浏览器/字体稳定显示, 避免
					// 原 "⌂" 字符在某些字体下渲染成空白/方框看不清); 按钮放大 26px 高,
					// 图标旁带文字标签「目录」, 一眼可辨用途; 边框用主题强调色更醒目,
					// 悬停提示显示实际跳转的目标路径。
					react.createElement("button", {
						key: "home",
						type: "button",
						style: { cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 3, height: 26, padding: "0 8px", whiteSpace: "nowrap", border: "1px solid var(--dsw-alias-accent,#4a7bff)", borderRadius: 4, background: "transparent", color: "var(--dsw-alias-accent,#4a7bff)", fontSize: 12 },
						title: "回到工作目录: " + (cwd || workspaceRoot || "(未连接会话)"),
						onClick: () => {
							const target = (cwd || workspaceRoot || "");
							if (target !== "") { setCurrentPath(target); setPathBox(target); }
						},
					}, [
						react.createElement("svg", { key: "ic", width: 15, height: 15, viewBox: "0 0 24 24", fill: "currentColor", style: { display: "block" } }, react.createElement("path", { d: "M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" })),
						react.createElement("span", { key: "lb", style: { lineHeight: "16px" } }, "目录"),
					]),
					react.createElement("button", { key: "refresh", type: "button", style: { cursor: "pointer", fontSize: 12, padding: "2px 5px", border: "none", background: "transparent", color: "#8a8f98" }, title: "刷新", onClick: () => setRefreshTick((tick) => tick + 1) }, "⟳"),
				]),
				error !== null && react.createElement("div", { key: "err", style: { padding: 8, fontSize: 12, color: "#c0392b" } }, "加载失败: " + error),
				react.createElement("div", { key: "body", style: { flex: 1, overflow: "auto", padding: "2px 0" } }, [
					// 根行: 当前目录自身也可右键 (与原版一致, 复制相对/绝对路径)。
					react.createElement("div", {
						key: "rootrow",
						style: { display: "flex", alignItems: "center", gap: 4, padding: "2px 4px", paddingLeft: 6, cursor: "pointer", fontSize: 12.5, userSelect: "none", whiteSpace: "nowrap", overflow: "hidden" },
						title: currentPath,
						onClick: () => { if (currentPath) copyPath(relativeTo(currentPath, currentPath), currentPath); },
						onContextMenu: (event) => { event.preventDefault(); event.stopPropagation(); if (currentPath) openMenu({ isDir: true, name: currentLabel, path: currentPath }, event.clientX, event.clientY); },
					}, [
						IconLayer("f"),
						react.createElement("span", { key: "n", style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis" } }, currentLabel + (busy ? " · 加载中…" : "")),
						copiedPath === currentPath && react.createElement("span", { key: "copied", style: { fontSize: 11, color: "#4a7bff", whiteSpace: "nowrap" } }, "已复制"),
					]),
					rootEntries === null && !error && react.createElement("div", { key: "loading", style: { padding: 8, fontSize: 12, color: "#8a8f98" } }, "扫描目录…"),
					rootEntries !== null && rootEntries.length === 0 && react.createElement("div", { key: "empty", style: { padding: 8, fontSize: 12, color: "#8a8f98" } }, "(空目录)"),
					rootEntries !== null ? rootEntries.map((child) => react.createElement(TreeNode, { key: child.path, entry: child, depth: 0, scope: { sessionId: scope.sessionId, cwd: currentPath }, onOpenFile: openFile, onMenu: openMenu })) : null,
					// 菜单关闭: 点击空白处或关闭菜单后复位。
					rowMenu !== null && react.createElement("div", {
						key: "menu-mask",
						style: { position: "fixed", inset: 0, zIndex: 2147483000 },
						onMouseDown: () => setRowMenu(null),
						onContextMenu: (event) => event.preventDefault(),
					}),
					rowMenu !== null && react.createElement(ContextMenu, {
						key: "menu",
						x: rowMenu.x,
						y: rowMenu.y,
						entry: rowMenu.entry,
						onSelect: onMenuSelect,
					}),
				]),
				detail !== null && react.createElement(FileViewer, {
					key: "fv",
					entry: detail.entry,
					scope: detail.scope,
					onClose: () => setDetail(null),
				}),
			]);
		}

		// ---- 文件预览/编辑 ----

		function FileViewer({ entry, scope, onClose }) {
			const [kind, setKind] = react.useState(null);   // 'text' | 'binary' | 'loading' | 'error'
			const [text, setText] = react.useState("");
			const [editDirty, setEditDirty] = react.useState(false);
			const [saved, setSaved] = react.useState(false);
			const [truncated, setTruncated] = react.useState(false);
			const [mediaUrl, setMediaUrl] = react.useState(null);
			const [error, setError] = react.useState(null);

			const editable = EDITABLE_EXTS.includes(extOf(entry.name));

			react.useEffect(() => {
				let cancelled = false;
				setKind("loading");
				setError(null);
				(async () => {
					try {
						const data = await postMethod("fs.read", { sessionId: scope.sessionId, ...(scope.cwd ? { cwd: scope.cwd } : {}), path: entry.path });
						if (cancelled) return;
						if (data.file && data.file.kind === "text" && editable) {
							setKind("text");
							setText(data.file.content);
							setTruncated(!!data.file.truncated);
						} else if (data.file && data.file.kind === "text") {
							setKind("text");          // 未在可编辑表但在服务端被判定为文本, 仍只读展示
							setText(data.file.content);
							setTruncated(!!data.file.truncated);
						} else {
							// 二进制: 走媒体路由取 blob 再按扩展名显示
							setKind("binary");
							setTruncated(!!(data.file && data.file.truncated));
							const url = await fetchBlobUrl({ sessionId: scope.sessionId, cwd: scope.cwd }, entry.path);
							if (cancelled) { URL.revokeObjectURL(url); return; }
							setMediaUrl(url);
						}
					} catch (e) {
						if (!cancelled) { setKind("error"); setError(errMessage(e)); }
					}
				})();
				return () => { cancelled = true; };
			}, [entry.path, scope.sessionId]);

			react.useEffect(() => () => {
				if (mediaUrl) URL.revokeObjectURL(mediaUrl);
			}, [mediaUrl]);

			const save = async () => {
				try {
					await postMethod("fs.write", { sessionId: scope.sessionId, ...(scope.cwd ? { cwd: scope.cwd } : {}), path: entry.path, content: text });
					setEditDirty(false);
					setSaved(true);
					setTimeout(() => setSaved(false), 1600);
				} catch (e) {
					setError(errMessage(e));
				}
			};

			const ext = extOf(entry.name);
			const isImage = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"].includes(ext);
			const isPdf = ext === "pdf";
			const isHtml = ext === "html" || ext === "htm";
			const isMd = ext === "md";

			const headerStyle = { display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderBottom: "1px solid var(--dsw-alias-stroke-default,#eee)", fontSize: 12.5 };

			let bodyElem;
			if (kind === "loading") bodyElem = react.createElement("div", { key: "loading", style: { padding: 12, fontSize: 12, color: "#8a8f98" } }, "读取文件…");
			else if (kind === "error") bodyElem = react.createElement("div", { key: "err", style: { padding: 12, fontSize: 12, color: "#c0392b" } }, "无法读取: " + error);
			else if (kind === "binary" && isImage) bodyElem = react.createElement("div", { key: "img", style: { overflow: "auto", padding: 6 } }, react.createElement("img", { src: mediaUrl || undefined, alt: entry.name, style: { maxWidth: "100%", display: "block" } }));
			else if (kind === "binary" && isPdf) bodyElem = react.createElement("iframe", { key: "pdf", src: mediaUrl || undefined, style: { flex: 1, border: "none", width: "100%", height: "100%", background: "#fff" } });
			else if (kind === "binary" && isHtml) bodyElem = react.createElement("iframe", { key: "html", src: mediaUrl || undefined, sandbox: "allow-scripts allow-same-origin", style: { flex: 1, border: "none", width: "100%", height: "100%", background: "#fff" } });
			else if (kind === "binary") bodyElem = react.createElement("div", { key: "bin", style: { padding: 12, fontSize: 12, color: "#8a8f98" } }, "二进制文件, 不支持文本预览扩展名。");
			else {
				bodyElem = react.createElement("div", { key: "txt", style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } }, [
					react.createElement("textarea", {
						key: "ta",
						value: text,
						readOnly: !editable || !editDirty,
						spellCheck: false,
						style: { flex: 1, width: "100%", boxSizing: "border-box", border: "none", outline: "none", resize: "none", font: "12px/1.5 ui-monospace,Consolas,Menlo,monospace", padding: 8, color: "inherit", background: "transparent" },
						onChange: (e) => { setText(e.target.value); setEditDirty(true); },
					}),
					truncated && react.createElement("div", { key: "trunc", style: { padding: "2px 8px", fontSize: 11, color: "#b8860b" } }, "文件超过 1MB, 仅载入前部 (只读保护)。"),
				]);
			}

			return react.createElement("div", { key: "fv", style: { borderTop: "1px solid var(--dsw-alias-stroke-default,#eee)", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } }, [
				react.createElement("div", { key: "h", style: headerStyle }, [
					react.createElement("button", { key: "back", type: "button", style: { cursor: "pointer", fontSize: 12, padding: "2px 6px" }, onClick: onClose }, "‹ 返回"),
					react.createElement("span", { key: "t", title: entry.path, style: { flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, "📄 " + entry.name),
					kind === "text" && editable && react.createElement("button", { key: "edit", type: "button", disabled: !editDirty, style: { cursor: editDirty ? "pointer" : "default", fontSize: 12, padding: "2px 8px", opacity: editDirty ? 1 : 0.5 }, onClick: () => { if (!editDirty) { setEditDirty(true); } else { save(); } } }, saved ? "已保存 ✓" : (editDirty ? "保存" : "编辑")),
					isMd && kind === "text" && react.createElement("button", { key: "md", type: "button", style: { cursor: "pointer", fontSize: 12, padding: "2px 8px", opacity: 0.85 }, onClick: () => window.open("/__dsh/sidebar-lite/file?" + new URLSearchParams({ sessionId: scope.sessionId, ...(scope.cwd ? { cwd: scope.cwd } : {}), path: entry.path }), "_blank") }, "在新窗口查看"),
				]),
				error !== null && kind !== "error" && react.createElement("div", { key: "err2", style: { padding: 6, fontSize: 12, color: "#c0392b" } }, error),
				bodyElem,
			]);
		}

		// ---- 内嵌浏览器 ----

		function BrowserView({ scope }) {
			const [address, setAddress] = react.useState("");
			const [src, setSrc] = react.useState(null);
			const [error, setError] = react.useState(null);

			const go = () => {
				setError(null);
				let url = address.trim();
				if (!url) return;
				if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = "https://" + url;
				setSrc(url);
			};

			react.useEffect(() => { setAddress(src || ""); }, [src]);

			return react.createElement("div", { style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } }, [
				react.createElement("div", { key: "bar", style: { display: "flex", gap: 4, padding: 4, borderBottom: "1px solid var(--dsw-alias-stroke-default,#eee)" } }, [
					react.createElement("input", { key: "in", type: "text", value: address, placeholder: "输入网址 (如 example.com) 回车访问", spellCheck: false, style: { flex: 1, minWidth: 0, padding: "3px 6px", fontSize: 12, border: "1px solid var(--dsw-alias-stroke-default,#ccc)", borderRadius: 4, outline: "none" }, onChange: (e) => setAddress(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") go(); } }),
					react.createElement("button", { key: "go", type: "button", style: { cursor: "pointer", fontSize: 12, padding: "3px 10px" }, onClick: go }, "前往"),
				]),
				error !== null && react.createElement("div", { key: "err", style: { padding: 6, fontSize: 12, color: "#c0392b" } }, error),
				react.createElement("div", { key: "frame", style: { flex: 1, minHeight: 0, position: "relative", background: "#fff" } }, [
					src === null && react.createElement("div", { key: "hint", style: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#8a8f98" } }, "在上方输入网址开始浏览"),
					src !== null && react.createElement("iframe", {
						key: "if",
						src,
						sandbox: "allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals",
						referrerPolicy: "no-referrer",
						style: { position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" },
						onLoad: () => setError(null),
						onError: () => setError("无法载入该页面 (可能拒绝 iframe 嵌入)。"),
					}),
				]),
			]);
		}

		// ---- CMD 终端 ----

		function TerminalView({ scope, tab }) {
			// 输出日志 (合并回放 + 实时输出), 用一个 <pre> 整体渲染, 追加时自动滚动到底。
			const [lines, setLines] = react.useState([]);
			const [input, setInput] = react.useState("");
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false); // 发送中 / 停止中
			const streamRef = react.useRef(null);
			const bottomRef = react.useRef(null);

			// 挂载时确保进程就绪并挂接 SSE 流; 卸载时只断开读取, 不结束宿主进程。
			react.useEffect(() => {
				let alive = true;
				postMethod("terminal.open", { sessionId: scope.sessionId, ...(scope.cwd ? { cwd: scope.cwd } : {}), tab })
					.then(() => {
						if (!alive) return;
						const stream = attachTerminalStream(scope, tab, (text) => {
							setLines((previous) => previous.concat([text]));
						}, (message) => {
							if (alive) setError(message);
						});
						streamRef.current = stream;
					})
					.catch((e) => {
						if (alive) setError(errMessage(e));
					});
				return () => {
					alive = false;
					if (streamRef.current) streamRef.current.stop();
				};
			}, [scope.sessionId, tab]);

			// 输出区域自动滚动到底。
			react.useEffect(() => {
				if (bottomRef.current) bottomRef.current.scrollIntoView();
			}, [lines]);

			const sendLine = async () => {
				const line = input;
				if (line === "") return;
				setInput("");
				setError(null);
				setBusy(true);
				try {
					// cmd 默认回显命令本身, 因此只在本地补一行 v 光标提示后交给宿主写 stdin。
					await postMethod("terminal.input", { sessionId: scope.sessionId, tab, line });
					setLines((previous) => previous.concat([""])); // 触发一次滚动
				} catch (e) {
					setError(errMessage(e));
				} finally {
					setBusy(false);
				}
			};

			const killTerminal = async () => {
				setBusy(true);
				try {
					// 先断开 SSE 读取再停进程, 避免进程退出事件写到一个断开的响应上。
					if (streamRef.current) streamRef.current.stop();
					await postMethod("terminal.kill", { sessionId: scope.sessionId, tab });
					setLines((previous) => previous.concat(["\r\n[终端已停止]\r\n"]));
				} catch (e) {
					setError(errMessage(e));
				} finally {
					setBusy(false);
				}
			};

			return react.createElement("div", { style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } }, [
				react.createElement("div", { key: "bar", style: { display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", borderBottom: "1px solid var(--dsw-alias-stroke-default,#eee)" } }, [
					react.createElement("span", { key: "hint", style: { flex: 1, fontSize: 11, color: "#8a8f98", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, "CMD 终端 (逐行执行命令)"),
					react.createElement("button", { key: "kill", type: "button", disabled: busy, style: { cursor: busy ? "default" : "pointer", fontSize: 12, padding: "2px 8px", color: "#c0392b" }, onClick: killTerminal }, "停止"),
				]),
				error !== null && react.createElement("div", { key: "err", style: { padding: 6, fontSize: 11, color: "#c0392b" } }, error),
				react.createElement("div", { key: "out", style: { flex: 1, minHeight: 0, overflow: "auto", padding: "6px 8px" } }, [
					react.createElement("pre", { key: "pre", style: { margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", font: "12px/1.5 ui-monospace,Consolas,Menlo,monospace", color: "inherit" } },
						(lines.length === 0 ? "输入命令后回车执行 (如 dir / cd / python --version)。\n" : lines.join(""))),
					react.createElement("div", { key: "bottom", ref: bottomRef }),
				]),
				react.createElement("div", { key: "cmd", style: { display: "flex", gap: 4, padding: "4px 8px", borderTop: "1px solid var(--dsw-alias-stroke-default,#eee)" } }, [
					react.createElement("input", {
						key: "i",
						type: "text",
						value: input,
						placeholder: "输入命令, 回车执行",
						spellCheck: false,
						style: { flex: 1, minWidth: 0, padding: "3px 6px", fontSize: 12, border: "1px solid var(--dsw-alias-stroke-default,#ccc)", borderRadius: 4, outline: "none" },
						onChange: (event) => setInput(event.target.value),
						onKeyDown: (event) => { if (event.key === "Enter") sendLine(); },
					}),
					react.createElement("button", { key: "send", type: "button", disabled: busy || input === "", style: { cursor: (busy || input === "") ? "default" : "pointer", fontSize: 12, padding: "3px 10px" }, onClick: sendLine }, "执行"),
				]),
			]);
		}

		// ---- 任务管理 (后台任务) ----

		function TasksView({ scope, jobs }) {
			// 展开查看输出时用 objectMap 缓存每个任务的输出文本与错误。
			const [outputText, setOutputText] = react.useState({});
			const [busyId, setBusyId] = react.useState(null);

			const loadOutput = async (job) => {
				setBusyId(job.id);
				try {
					const data = await postMethod("jobs.output", { sessionId: scope.sessionId, id: job.id });
					setOutputText((previous) => ({ ...previous, [job.id]: { text: data.text || "(无输出)", error: null } }));
				} catch (e) {
					setOutputText((previous) => ({ ...previous, [job.id]: { text: "", error: errMessage(e) } }));
				} finally {
					setBusyId(null);
				}
			};

			const killJob = async (job) => {
				setBusyId(job.id);
				try {
					await postMethod("jobs.kill", { sessionId: scope.sessionId, id: job.id, reason: "user requested via sidebar" });
					setOutputText((previous) => ({ ...previous, [job.id]: { text: "已请求停止该任务。", error: null } }));
				} catch (e) {
					setOutputText((previous) => ({ ...previous, [job.id]: { text: "", error: errMessage(e) } }));
				} finally {
					setBusyId(null);
				}
			};

			const list = jobs || [];
			if (list.length === 0) {
				return react.createElement("div", { key: "empty", style: { padding: 12, fontSize: 12, color: "#8a8f98" } }, "暂无后台任务。AI 调用 job 类工具 (如长任务/脚本) 后, 会在此列出。");
			}

			return react.createElement("div", { key: "jobs", style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "auto" } }, list.map((job) => {
				const currentOutput = outputText[job.id] || null;
				const statusLabel = job.status || "unknown";
				return react.createElement("div", { key: job.id, style: { borderBottom: "1px solid var(--dsw-alias-stroke-default,#eee)", padding: "8px" } }, [
					react.createElement("div", { key: "row", style: { display: "flex", alignItems: "center", gap: 6 } }, [
						react.createElement("span", { key: "st", style: { fontSize: 11, padding: "1px 6px", borderRadius: 3, background: statusLabel === "running" ? "#e8f0fe" : "#ececec", color: statusLabel === "running" ? "#1a56db" : "#5f6672" } }, statusLabel),
						react.createElement("span", { key: "id", style: { flex: 1, minWidth: 0, fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", userSelect: "none" }, title: job.title || job.id }, (job.title || job.id)),
						react.createElement("button", { key: "out", type: "button", disabled: busyId === job.id, style: { cursor: busyId === job.id ? "default" : "pointer", fontSize: 11, padding: "2px 6px" }, onClick: () => loadOutput(job), title: "查看 AI 读取到的输出" }, "输出"),
						react.createElement("button", { key: "kill", type: "button", disabled: busyId === job.id, style: { cursor: busyId === job.id ? "default" : "pointer", fontSize: 11, padding: "2px 6px" }, onClick: () => killJob(job), title: "停止该任务" }, "停止"),
					]),
					currentOutput !== null && react.createElement("div", { key: "body", style: { marginTop: 6, padding: 6, background: "#f6f7f8", borderRadius: 4 } }, [
						currentOutput.error !== null
							? react.createElement("div", { key: "e", style: { fontSize: 11, color: "#c0392b" } }, "操作失败: " + currentOutput.error)
							: react.createElement("pre", { key: "o", style: { margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: 11, lineHeight: 1.5 } }, currentOutput.text),
					]),
				]);
			}));
		}

		// ---- 侧边栏外壳 (折叠 + Tab 切换) ----

		function SidebarShell({ ctx }) {
			const [open, setOpen] = react.useState(true);
			const [tab, setTab] = react.useState("explorer"); // 'explorer' | 'browser' | 'terminal' | 'tasks'
			const [cwd, setCwd] = react.useState(null);
			const [rootName, setRootName] = react.useState("");
			// 工作区根目录 (E:\DeepSeekHarnessLauncher): 资源管理器默认根。
			const [workspaceRoot, setWorkspaceRoot] = react.useState(null);
			const [sessionErr, setSessionErr] = react.useState(null);

			// ---- 侧边栏宽度自由拉伸 ----
			// 拖动左边缘调整面板宽度 (右停靠, 宽度=视口宽-光标x); 记录收起前宽度以便展开复位。
			const [panelWidth, setPanelWidthState] = react.useState(PANEL_WIDTH);
			const [resizing, setResizing] = react.useState(false);
			const lastWidthRef = react.useRef(PANEL_WIDTH);

			// 宽度变化时同步 CSS 变量 (驱动 #root 让位 + 面板宽度)。
			react.useEffect(() => {
				setPanelWidth(panelWidth);
			}, [panelWidth]);

			// 收起点下当前宽度, 展开时恢复 (避免每次展开重置回默认宽度)。
			react.useEffect(() => {
				if (open) {
					setPanelWidthState(lastWidthRef.current);
				} else {
					lastWidthRef.current = panelWidth;
					setPanelWidthState(0);
				}
			}, [open]);

			// 拖动左边缘: 全局监听 mousemove / mouseup 连续更新宽度, 最小 200px。
			const onResizeStart = (event) => {
				event.preventDefault();
				setResizing(true);
			};
			react.useEffect(() => {
				if (!resizing) return undefined;
				const onMove = (moveEvent) => {
					const nextWidth = Math.max(200, window.innerWidth - moveEvent.clientX);
					setPanelWidthState(nextWidth);
				};
				const onEnd = () => setResizing(false);
				document.addEventListener("mousemove", onMove);
				document.addEventListener("mouseup", onEnd);
				return () => {
					document.removeEventListener("mousemove", onMove);
					document.removeEventListener("mouseup", onEnd);
				};
			}, [resizing]);

			// 订阅当前激活会话 (ctx.sessions.list 外部 store)。
			const [, force] = react.useReducer((x) => x + 1, 0);
			react.useEffect(() => {
				if (!ctx || !ctx.sessions || !ctx.sessions.list || typeof ctx.sessions.list.subscribe !== "function") return undefined;
				return ctx.sessions.list.subscribe(() => force());
			}, [ctx]);

			const snapshot = (ctx && ctx.sessions && ctx.sessions.list && typeof ctx.sessions.list.getSnapshot === "function") ? ctx.sessions.list.getSnapshot() : null;
			// 当前激活会话 id: 官方 list store 的字段是 current (不是 sessionId!),
			// 用错字段会恒为 null → 走"无会话兜底" → 任务面板永远空、会话 cwd 拿不到。
			const sessionId = (snapshot && (snapshot.current || snapshot.sessionId)) || null;
			const summaryCwd = sessionId ? ((snapshot && snapshot.byId && snapshot.byId[sessionId] && snapshot.byId[sessionId].cwd) || undefined) : undefined;
			// 后台任务列表 (官方 session/jobs 推送镜像, 与 better-sidebar 同一数据源)。
			const jobs = (snapshot && snapshot.jobsBySession && sessionId && snapshot.jobsBySession[sessionId]) || [];

			// 已做过"无会话兜底根解析"的标记: 只兜底一次, 避免频繁轮询宿主端点根。
			const fallbackResolved = react.useRef(false);

			// 解析会话权威工作目录 (宿主端以 session.header.cwd 为准)。
			react.useEffect(() => {
				let cancelled = false;
				if (sessionId) {
					// 有会话: 解析会话 cwd + 工作区根, 作为资源管理器默认根。
					fallbackResolved.current = true;
					setSessionErr(null);
					(async () => {
						try {
							const data = await postMethod("session.cwd", { sessionId, ...(summaryCwd ? { cwd: summaryCwd } : {}) });
							if (cancelled) return;
							setCwd(data.cwd || null);
							setRootName(data.root || "");
							// 资源管理器默认根: 优先工作区根, 兜底会话工作目录。
							setWorkspaceRoot(data.workspaceRoot || data.cwd || null);
						} catch (e) {
							if (!cancelled) setSessionErr(errMessage(e));
						}
					})();
				} else if (!fallbackResolved.current) {
					// 无会话: 仍兜底解析一次工作区根 (宿主 resolveWorkspaceRoot 不依赖 sessionId),
					// 否则资源管理器 currentPath 永远为空, 卡死在「扫描目录…」不显示目录。
					fallbackResolved.current = true;
					setSessionErr(null);
					(async () => {
						try {
							const data = await postMethod("session.cwd", { sessionId: "" });
							if (cancelled) return;
							const fallbackRoot = data.workspaceRoot || data.cwd || null;
							setWorkspaceRoot(fallbackRoot);
							setRootName(data.root || "");
							// 无会话时, 会话 cwd 也一并兜底, 保证 fs.tree / file / terminal 有非空作用域。
							setCwd((existing) => existing || fallbackRoot);
						} catch (e) {
							if (!cancelled) setSessionErr(errMessage(e));
						}
					})();
				}
				return () => { cancelled = true; };
			}, [sessionId]);

			const scope = { sessionId: sessionId || "", cwd: cwd || undefined };

			// 展开/收起时的 #root 让位现由上方 panelWidth 相关 effect 统一处理。

			const tabButton = (id, label) => react.createElement("button", {
				key: id,
				type: "button",
				onClick: () => setTab(id),
				style: { flex: 1, cursor: "pointer", padding: "6px 4px", fontSize: 12, border: "none", borderBottom: tab === id ? "2px solid var(--dsw-alias-accent,#4a7bff)" : "2px solid transparent", background: "transparent", color: tab === id ? "inherit" : "#8a8f98", fontWeight: tab === id ? 600 : 400 },
			}, label);

			// 折叠时显示右侧细条, 便于重新展开。
			if (!open) {
				return react.createElement("button", {
					type: "button",
					id: N + "-ribbon",
					onClick: () => setOpen(true),
					title: "展开侧边栏",
				}, "‹‹");
			}

			return react.createElement("div", { key: "main", id: N + "-host", className: resizing ? N + "-resizing" : undefined }, [
				// 左边缘拖动手柄: 透明分隔条, 悬停显示横向拖拽光标, 拖动即调整宽度。
				react.createElement("div", {
					key: "resizer",
					style: { position: "absolute", left: 0, top: 0, bottom: 0, width: 5, zIndex: 2147483001, cursor: "ew-resize", background: "transparent" },
					onMouseDown: onResizeStart,
				}),
				react.createElement("div", { key: "title", style: { display: "flex", alignItems: "center", gap: 4, padding: "6px 8px", borderBottom: "1px solid var(--dsw-alias-stroke-default,#eee)", fontSize: 12.5, fontWeight: 600 } }, [
					react.createElement("span", { key: "t", style: { flex: 1 } }, "侧边栏"),
					react.createElement("button", { key: "cl", type: "button", style: { cursor: "pointer", fontSize: 12, padding: "2px 6px" }, onClick: () => setOpen(false), title: "收起" }, "›"),
				]),
				react.createElement("div", { key: "tabs", style: { display: "flex", borderBottom: "1px solid var(--dsw-alias-stroke-default,#eee)" } }, [
					tabButton("explorer", "资源管理"),
					tabButton("terminal", "终端"),
					tabButton("tasks", "任务"),
					tabButton("browser", "浏览器"),
				]),
				sessionErr !== null && react.createElement("div", { key: "serr", style: { padding: 6, fontSize: 11, color: "#c0392b" } }, "会话定位失败: " + sessionErr),
				react.createElement("div", { key: "body", style: { flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" } }, [
					tab === "explorer"
						? react.createElement(ExplorerView, { key: "ex", scope, cwd, workspaceRoot, rootName, onOpenFile: () => { } })
						: tab === "terminal"
						? react.createElement(TerminalView, { key: "te", scope, tab: "1" })
						: tab === "tasks"
						? react.createElement(TasksView, { key: "ta", scope, jobs })
						: react.createElement(BrowserView, { key: "br", scope }),
				]),
			]);
		}

		// ---- 应用入口 / 挂载 ----

		function apply(ctx) {
			if (!createRootFn) {
				console.error("[dsh-sidebar-lite] 未找到 createRoot (react-dom 不可用), 侧边栏跳过");
				return;
			}
			injectStyles();
			ctx.effect(() => {
				let disposed = false;
				let root = null;
				let host = null;
				try {
					host = document.createElement("div");
					host.id = N + "-host-wrap";
					document.body.appendChild(host);
					root = createRootFn(host);
					root.render(react.createElement(SidebarShell, { ctx }));
					setPanelWidth(PANEL_WIDTH);
				} catch (error) {
					console.error("[dsh-sidebar-lite] mount error:", error);
				}
				return () => {
					disposed = true;
					try { if (root) root.unmount(); } catch (e) { /* ignore */ }
					try { if (host) host.remove(); } catch (e2) { /* ignore */ }
					setPanelWidth(0);
				};
			}, "dsh-sidebar-lite: sidebar mount");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});