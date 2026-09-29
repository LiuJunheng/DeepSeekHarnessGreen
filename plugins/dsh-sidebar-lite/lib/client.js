// DeepSeek Harness 插件 (客户端): dsh-sidebar-lite
// 挂进官方右侧栏 (每个会话一个右侧停靠面) 作为 tab 类型提供者, 不再自建侧栏外壳:
// 折叠/分栏/浮窗/全屏/快捷键/按会话持久化全部交给官方右侧栏容器负责。
//   1) 接管官方内置文件树 (kind "files"): 以 extension 档注册, 官方 builtin 档自动让位,
//      本插件卸载后官方文件树自动恢复。在官方能力之上额外提供
//      「返回上级 / 可编辑路径框跳转任意绝对路径 / 回到工作目录 / 刷新」;
//      单击文件交给官方资源预览 (dsh-resource://file/... ), 由官方文件预览类型渲染
//      (Markdown/代码/图片/PDF 均由官方负责)。
//   2) 新增编辑 tab (kind "sidebar-lite.edit", multiple: true): 文本就地编辑 + 保存回写,
//      每个文件一份独立内容, 互不顶掉。
// 数据全部走宿主端路由 /__dsh/sidebar-lite/* (POST JSON / GET 媒体), 均带防御头。
// 会话溯源改用官方 props 注入的 sessionId (标准 prop), 不再订阅 ctx.sessions.list。
// 这是加载器契约格式 (window.__ModuleLoader__.load), 与官方客户端插件一致。

window.__ModuleLoader__.load({
	id: "dsh-sidebar-lite",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		// 官方客户端服务依赖: 插槽注册表 / 会话服务 / 右侧栏 tab 类型注册表 / 文案。
		const inject = ["slots", "sessions", "sidebarRightTabs", "locale"];

		// ---- 常量 ----
		const API_PREFIX = "/__dsh/sidebar-lite";
		const GUARD_HEADER = "X-DSH-Sidebar-Lite";
		const LOCALE_NS = "dsh-sidebar-lite";            // 官方文案命名空间 (ctx.locale.bind 用)
		const FILES_TYPE_ID = "dsh-sidebar-lite";        // 文件树类型在 tab 系统内的唯一 id (也是正文插槽 key)
		const FILES_KIND = "files";                      // 接管官方内置文件树的 kind
		const EDIT_TYPE_ID = "dsh-sidebar-lite/edit";    // 编辑类型 id (也是正文/标题插槽 key)
		const EDIT_KIND = "sidebar-lite.edit";           // 编辑类型的 kind
		const STYLE_TAG_ID = "dsh-sidebar-lite/body.css";
		const FILES_GUIDE_COMMAND_ID = "workspace.files"; // 官方「工作区文件」快捷键命令 id (仅用于指南卡展示)

		// ---- 模块级桥接 ----
		// 官方 @ 引用插入需要一个会话级通道 (sessions.provideInfo / resolveAgentScope),
		// 原来由自建外壳从 ctx prop 构造; 现在 apply(ctx) 把 ctx 存到这里, 组件内再用它构造。
		let pluginContext = null;
		// 官方输入机状态: 通过 conversation.input.left 插槽捕获 InputZone 契约快照,
		// 供右键「以官方 @ 引用插入」读取 draft / draftRev。
		let capturedInputActions = null;
		let capturedInput = null;

		// ---- 官方资源地址构造 (必须内联, 不 require 官方包) ----
		// 与官方 fileAddressFor / sessionFileAddress 完全同一套逻辑, 保证 openResource 命中
		// 官方文件预览类型。
		const FILE_ADDRESS_PREFIX = "dsh-resource://file/";

		/** 逐段编码一个 id 或路径段, 保留盘符里的冒号。 */
		function encodeSegment(segment) {
			return encodeURIComponent(segment).replace(/%3A/gi, ":");
		}

		/** 按 `/` 分段编码整条路径。 */
		function encodePath(path) {
			return path.split("/").map(encodeSegment).join("/");
		}

		/** 构造某会话下文件的资源地址。 */
		function sessionFileAddress(sessionId, path) {
			const normalized = path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
			return FILE_ADDRESS_PREFIX + "session/" + encodeSegment(sessionId) + "/" + encodePath(normalized);
		}

		// ---- 编辑器资源地址 (dsh-resource://edit/...) ----
		// 官方只持久化资源地址 (tab.contentId), 不持久化 navigation.params, 因此编辑 tab 的
		// 文件身份必须编进地址本身: 刷新页面恢复布局后仍能定位到同一文件, 同一文件的重复
		// 打开也会按地址去重复用同一个 tab。
		const EDIT_ADDRESS_PREFIX = "dsh-resource://edit/";

		/** 构造某会话下某个绝对路径的编辑器资源地址 (路径统一成正斜杠后逐段编码)。 */
		function editAddressFor(sessionId, absolutePath) {
			const normalized = String(absolutePath || "").replace(/\\/g, "/");
			return EDIT_ADDRESS_PREFIX + "session/" + encodeSegment(sessionId) + "/" + encodePath(normalized);
		}

		/** 从编辑器资源地址还原绝对路径; 不是本插件地址时返回空串。 */
		function pathFromEditAddress(address) {
			const text = typeof address === "string" ? address : "";
			const prefix = EDIT_ADDRESS_PREFIX + "session/";
			if (!text.startsWith(prefix)) return "";
			const rest = text.slice(prefix.length);
			const slashIndex = rest.indexOf("/");
			if (slashIndex < 0) return "";
			return rest.slice(slashIndex + 1).split("/").map((segment) => {
				try {
					return decodeURIComponent(segment);
				} catch (error) {
					return segment;
				}
			}).join("/");
		}

		/** 是否为工作区绝对路径 (POSIX / Windows 盘符 / UNC)。 */
		function isAbsoluteWorkspacePath(value) {
			return value.startsWith("/") || /^[A-Za-z]:[/\\]/.test(value) || value.startsWith("\\\\");
		}

		/**
		 * 按调用方持有的路径形态求资源地址: 相对路径, 或会话工作目录内的绝对路径,
		 * 转成 session 作用域地址; 工作目录之外或根未知的绝对路径, 保留其绝对路径
		 * (仍挂在该会话地址下)。
		 */
		function fileAddressFor(sessionId, cwd, path) {
			const normalized = path.replace(/\\/g, "/");
			if (!isAbsoluteWorkspacePath(normalized)) return sessionFileAddress(sessionId, normalized);
			const root = (cwd === undefined || cwd === null) ? "" : cwd.replace(/\\/g, "/").replace(/\/+$/, "");
			if (root !== "" && normalized === root) return sessionFileAddress(sessionId, "");
			if (root !== "" && normalized.startsWith(root + "/")) return sessionFileAddress(sessionId, normalized.slice(root.length + 1));
			return sessionFileAddress(sessionId, normalized);
		}

		// ---- API 辅助 ----

		/** POST 一段 JSON 到宿主方法, 带防御头; 返回 payload (并校验 service 层的 ok 标记)。 */
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

		/** 取错误信息文本 (兼容非 Error 抛出值)。 */
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

		/** 相对路径 (把绝对 path 减去 cwd 前缀, 得到可从当前浏览目录访问的相对路径)。 */
		function relativeTo(cwd, absolutePath) {
			const fixedCwd = (cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
			const fixedPath = absolutePath.replace(/\\/g, "/");
			if (fixedCwd && fixedPath.startsWith(fixedCwd + "/")) {
				return fixedPath.slice(fixedCwd.length + 1);
			}
			return fixedPath;
		}

		/** 取路径里的文件名 (反斜杠/正斜杠都兼容)。 */
		function baseNameOf(filePath) {
			const fixed = String(filePath || "").replace(/\\/g, "/").replace(/\/+$/, "");
			const index = fixed.lastIndexOf("/");
			return index < 0 ? fixed : fixed.slice(index + 1);
		}

		// ---- 官方 @ 引用 (dsh-file-reference grammar) 的路径换算 ----
		// 与 dsh-file-browser 插件同一套逻辑: 官方 @ 文件搜索 (dsh-file-reference-local)
		// 以会话 header.cwd 为根、索引相对路径; mention 语法无空白 `@path`、含空白
		// `@"path with spaces"`。这里做 Windows 语义 (大小写不敏感) 的相对换算;
		// 目标在根之外或跨盘返回 null。
		function toPosix(pathValue) {
			return String(pathValue || "").replace(/\\/g, "/");
		}
		function relSegments(fromPath, toPath) {
			const fromParts = fromPath.split("/").filter(Boolean);
			const toParts = toPath.split("/").filter(Boolean);
			let index = 0;
			while (index < fromParts.length && index < toParts.length && fromParts[index].toLowerCase() === toParts[index].toLowerCase()) index += 1;
			const ups = fromParts.length - index;
			const rest = toParts.slice(index);
			return [...Array(ups).fill(".."), ...rest].join("/");
		}
		function relativePosix(fromAbsolute, toAbsolute) {
			const from = toPosix(fromAbsolute).replace(/\/+$/, "");
			const to = toPosix(toAbsolute);
			const fromDrive = from.match(/^([a-zA-Z]:)(\/.*)$/);
			const toDrive = to.match(/^([a-zA-Z]:)(\/.*)$/);
			if (fromDrive || toDrive) {
				if (!fromDrive || !toDrive || fromDrive[1].toLowerCase() !== toDrive[1].toLowerCase()) return null; // 跨盘
				return relSegments(fromDrive[2], toDrive[2]);
			}
			return relSegments(from, to); // UNC / 相对形态
		}

		/**
		 * 以官方 @ 引用把文件插入当前会话输入框 (与官方 @ 菜单 onPick 完全同一管线):
		 * 换算相对会话工作目录 (header.cwd, 即官方 @ 搜索的根) 的 mention → 经
		 * standard-kit sessions.provideInfo 读输入机状态 (draft/draftRev) →
		 * sessions.resolveAgentScope 取会话作用域, 派发官方事件
		 * slash/input-insert-reference, 由官方输入机 mint 结构化 occurrence:
		 * 草稿显示 @文件名 chip, 发送时经 reference source codec 序列化为相对路径。
		 * @param {object} bridge - { provideInfo(id), scope(id) } 会话级通道。
		 * @param {string} sessionId - 当前 tab 所属会话 id。
		 * @param {string} cwd - 会话工作目录 (官方 @ 引用的根)。
		 * @param {string} entryPath - 文件的绝对路径。
		 * @returns {Promise<string|null>} 错误信息 (null = 成功)。
		 */
		async function insertOfficialReference(bridge, sessionId, cwd, entryPath) {
			try {
				if (!cwd) return "No session cwd, official @ unavailable";
				const relativePath = relativePosix(cwd, entryPath);
				if (relativePath === null || relativePath === "" || relativePath === ".." || relativePath.startsWith("../")) {
					return "File outside session cwd";
				}
				let sessionScopeContext = null;
				try { sessionScopeContext = bridge && typeof bridge.scope === "function" ? bridge.scope(sessionId) : null; } catch (error) { sessionScopeContext = null; }
				if (!sessionScopeContext) return "Cannot get session scope";
				const inputState = capturedInput || null;
				const draft = (inputState && typeof inputState.draft === "string") ? inputState.draft : "";
				const draftRevision = (inputState && typeof inputState.draftRev === "number") ? inputState.draftRev : 0;
				const caret = draft.length;
				const reference = {
					source: "reference",
					ref: "@" + relativePath,
					label: baseNameOf(entryPath) || relativePath,
					appearance: "file",
					clipboardText: "@" + relativePath,
				};
				const span = { start: caret, end: caret, draftRev: draftRevision };
				let inserted = false;
				// 动态取输入机的 liveRev, 避免 CAS (draftRev 不匹配) 失败。
				try {
					let conversation = null;
					try { conversation = sessionScopeContext && typeof sessionScopeContext.get === "function" ? sessionScopeContext.get("conversation") : null; } catch (error) { conversation = null; }
					const targetSessionId = (sessionScopeContext.session && sessionScopeContext.session.id) || sessionId || null;
					const shell = conversation && conversation.input && typeof conversation.input.shell === "function" ? conversation.input.shell(targetSessionId) : null;
					const liveRevision = shell && shell.rev !== undefined ? shell.rev : null;
					if (liveRevision !== null && liveRevision !== undefined) { span.draftRev = liveRevision; }
				} catch (error) { /* 拿不到 liveRev 时沿用原 draftRev */ }
				try { inserted = sessionScopeContext.bail(sessionScopeContext, "slash/input-insert-reference", { reference, span }) === true; } catch (error) { inserted = false; }
				// bail 失败时退化为 DOM 插入 (任何版本都能兜底)。
				if (!inserted) {
					try {
						const editor = (typeof document !== "undefined") ? document.querySelector('[contenteditable="true"]') : null;
						if (editor) {
							editor.focus();
							const insertedText = reference && reference.ref ? reference.ref.replace(/^@/, "") : "";
							const ok = document.execCommand("insertText", false, "@" + insertedText + " ");
							if (ok) return null;
						}
					} catch (domError) { /* 忽略, 继续返回错误信息 */ }
					return "Insert failed: " + (reference && reference.ref ? reference.ref : "");
				}
				return null;
			} catch (error) {
				console.error("[dsh-sidebar-lite] insertOfficialReference error:", error);
				return String((error && error.message) || error);
			}
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

		/** execCommand 回退复制 (旧内核 / 非安全上下文)。 */
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
			} catch (error) {
				return false;
			}
		}

		/**
		 * 通过宿主 file 媒体路由下载 (另存为) 文件。该路由要求防御头, 无法用 <a href> 直接跳转,
		 * 需先 fetch(带防御头) → blob 拿到字节。因为是本地机器, 「另存为」语义更贴合:
		 * 优先用原生「另存为」对话框 (File System Access API, showSaveFilePicker) 让用户
		 * 自由选择保存位置; 该 API 不可用时回退为浏览器自动下载 (同名文件)。
		 * 注意: 需在用户手势内先弹出对话框, 避免 fetch 异步丢失去焦点后对话框被浏览器拦截。
		 */
		async function saveAsFile(scope, filePath) {
			const fileName = baseNameOf(filePath) || "file";
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
				params.set("path", filePath);
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
			} catch (error) {
				console.error("[dsh-sidebar-lite] save-as failed:", error);
			}
		}

		// ---- 样式注入 (只注入本插件自己的类名, 全部走官方主题 token, 无硬编码颜色) ----
		// 仿官方做法: <style> 带 data-plugin / data-plugin-css 标记, 类名前缀 dsl 与官方区分。
		function injectStyles() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_TAG_ID) + "]") !== null) return;
			const style = document.createElement("style");
			style.dataset.plugin = "dsh-sidebar-lite";
			style.dataset.pluginCss = STYLE_TAG_ID;
			style.textContent = [
				".dsl-root{height:100%;min-height:0;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5;}",
				".dsl-head{flex:none;display:flex;align-items:center;gap:4px;padding:4px 8px;border-bottom:0.5px solid var(--dsw-alias-border-l3);}",
				".dsl-path{flex:1;min-width:0;padding:3px 6px;font-size:11px;color:inherit;background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);outline:none;}",
				".dsl-tool{flex:none;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:var(--dsw-alias-label-secondary);background:transparent;border:none;border-radius:var(--dsw-radius-sm);padding:2px 6px;font-size:12px;}",
				".dsl-tool:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);}",
				".dsl-tool[disabled]{cursor:default;opacity:.4;}",
				".dsl-tool[disabled]:hover{color:var(--dsw-alias-label-secondary);background:transparent;}",
				".dsl-home{flex:none;display:inline-flex;align-items:center;justify-content:center;gap:3px;height:26px;padding:0 8px;cursor:pointer;white-space:nowrap;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);font-size:12px;}",
				".dsl-home:hover{background:var(--dsw-alias-interactive-bg-hover);}",
				".dsl-body{flex:1;min-height:0;overflow:auto;padding:2px 0;}",
				".dsl-row{display:flex;align-items:center;gap:4px;padding:2px 4px;cursor:pointer;font-size:12.5px;user-select:none;white-space:nowrap;overflow:hidden;border-radius:var(--dsw-radius-sm);}",
				".dsl-row:hover{background:var(--dsw-alias-interactive-bg-hover);}",
				".dsl-row-hidden .dsl-name{color:var(--dsw-alias-label-tertiary);}",
				".dsl-chevron{flex:none;display:inline-block;width:12px;text-align:center;font-size:11px;color:var(--dsw-alias-label-tertiary);}",
				".dsl-glyph{flex:none;font-size:12px;}",
				".dsl-name{min-width:0;overflow:hidden;text-overflow:ellipsis;}",
				".dsl-note{padding:6px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary);}",
				".dsl-error{padding:6px 10px;font-size:11px;color:var(--dsw-alias-state-error-primary);}",
				".dsl-copied{font-size:11px;color:var(--dsw-alias-state-success-primary);white-space:nowrap;}",
				".dsl-menu-mask{position:fixed;inset:0;z-index:2147483000;}",
				".dsl-menu{position:fixed;z-index:2147483001;min-width:172px;padding:4px 0;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);}",
				".dsl-menu-item{padding:6px 10px;cursor:pointer;font-size:12.5px;white-space:nowrap;}",
				".dsl-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover);}",
				".dsl-menu-sep{height:1px;margin:3px 4px;background:var(--dsw-alias-border-l3);}",
				".dsl-editor{height:100%;min-height:0;display:flex;flex-direction:column;}",
				".dsl-editor-bar{flex:none;display:flex;align-items:center;gap:6px;padding:4px 8px;border-bottom:0.5px solid var(--dsw-alias-border-l3);}",
				".dsl-editor-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;}",
				".dsl-editor-area{flex:1;min-height:0;width:100%;box-sizing:border-box;padding:8px;resize:none;border:none;outline:none;background:transparent;color:inherit;font:12px/1.5 ui-monospace,Consolas,Menlo,monospace;}",
				".dsl-editor-note{flex:none;padding:4px 8px;font-size:11px;color:var(--dsw-alias-state-warn-primary);}",
				".dsl-editor-message{flex:1;min-height:0;overflow:auto;padding:12px;font-size:12px;color:var(--dsw-alias-label-secondary);}",
				".dsl-title{display:inline-flex;align-items:center;gap:6px;}",
			].join("");
			document.head.appendChild(style);
		}

		// ---- 右键上下文菜单 (文件: @引用/编辑/另存为/复制; 目录: 复制) ----

		function ContextMenu({ x, y, entry, onSelect, t }) {
			const items = [];
			if (!entry.isDir) {
				items.push(react.createElement("div", { key: "insertref", className: "dsl-menu-item", onClick: () => onSelect("insertref") }, t("menu_insert_ref")));
				items.push(react.createElement("div", { key: "edit", className: "dsl-menu-item", onClick: () => onSelect("edit") }, t("menu_edit")));
				items.push(react.createElement("div", { key: "saveas", className: "dsl-menu-item", onClick: () => onSelect("saveas") }, t("menu_save_as")));
				items.push(react.createElement("div", { key: "sep", className: "dsl-menu-sep" }));
			}
			items.push(react.createElement("div", { key: "relative", className: "dsl-menu-item", onClick: () => onSelect("relative") }, t("menu_copy_rel")));
			items.push(react.createElement("div", { key: "absolute", className: "dsl-menu-item", onClick: () => onSelect("absolute") }, t("menu_copy_abs")));
			return react.createElement("div", {
				className: "dsl-menu",
				style: {
					left: Math.min(x, window.innerWidth - 190),
					top: Math.min(y, window.innerHeight - 240),
				},
				onMouseDown: (event) => event.stopPropagation(),
				onContextMenu: (event) => event.preventDefault(),
			}, items);
		}

		// ---- 资源管理器节点 (递归目录, 懒加载展开) ----

		function TreeNode({ entry, depth, scope, refreshTick, onOpenFile, onMenu, t }) {
			const [expanded, setExpanded] = react.useState(false);
			const [children, setChildren] = react.useState(null);       // null = 尚未加载
			const [truncated, setTruncated] = react.useState(false);     // 命中单目录条数上限
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);

			/** 读取本目录一级子项 (懒加载与刷新共用)。 */
			const loadChildren = react.useCallback(async () => {
				setBusy(true);
				setError(null);
				try {
					const data = await postMethod("fs.tree", { sessionId: scope.sessionId, ...(scope.cwd ? { cwd: scope.cwd } : {}), path: entry.path });
					setChildren((data.listing && data.listing.entries) || []);
					setTruncated(!!(data.listing && data.listing.truncated));
				} catch (loadError) {
					setError(errMessage(loadError));
					setChildren([]);
				} finally {
					setBusy(false);
				}
			}, [scope.sessionId, scope.cwd, entry.path]);

			const toggle = () => {
				if (!entry.isDir) {
					onOpenFile(entry);
					return;
				}
				const next = !expanded;
				setExpanded(next);
				if (next && children === null && !busy) loadChildren();
			};

			// 官方刷新快捷键 (tab.actions.bindCommands refresh) 触发时, 重新读取已展开目录的子级。
			react.useEffect(() => {
				if (!expanded || children === null) return;
				loadChildren();
			}, [refreshTick]);

			const rowChildren = [
				react.createElement("span", { key: "chev", className: "dsl-chevron" }, entry.isDir ? (expanded ? "▾" : "▸") : ""),
				react.createElement("span", { key: "glyph", className: "dsl-glyph" }, entry.isDir ? "📁" : "📄"),
				react.createElement("span", { key: "name", className: "dsl-name" }, entry.name),
			];

			const levelIndent = 6 + (depth + 1) * 22;

			return react.createElement("div", null, [
				react.createElement("div", {
					key: "row",
					className: entry.hidden ? "dsl-row dsl-row-hidden" : "dsl-row",
					style: { paddingLeft: 6 + depth * 22 },
					title: entry.path,
					onClick: toggle,
					onContextMenu: (event) => {
						event.preventDefault();
						event.stopPropagation();
						onMenu(entry, event.clientX, event.clientY);
					},
				}, rowChildren),
				entry.isDir && expanded && react.createElement("div", { key: "children" }, [
					busy && children === null && react.createElement("div", { key: "busy", className: "dsl-note", style: { paddingLeft: levelIndent } }, t("files.scanning")),
					children !== null && error && react.createElement("div", { key: "err", className: "dsl-error", style: { paddingLeft: levelIndent } }, t("files.load_failed")),
					children !== null && children.length === 0 && !error && react.createElement("div", { key: "empty", className: "dsl-note", style: { paddingLeft: levelIndent } }, t("files.empty")),
					children !== null && truncated && react.createElement("div", { key: "trunc", className: "dsl-note", style: { paddingLeft: levelIndent } }, t("files.truncated_note")),
					children !== null ? children.map((child) => react.createElement(TreeNode, { key: child.path, entry: child, depth: depth + 1, scope, refreshTick, onOpenFile, onMenu, t })) : null,
				]),
			]);
		}

		// ---- 资源管理器面板 (官方 tab 格子的正文) ----

		function ExplorerView({ sessionId, cwd, workspaceRoot, refreshTick, onRefresh, t, onOpenFile, onEdit, bridge }) {
			// 当前正在浏览的目录: 默认会话工作目录 cwd (即"这个会话锁指定的目录"),
			// 无会话/无 cwd 时回退工作区根 workspaceRoot; 之后可由路径框上溯任意路径。
			const initialRoot = (cwd || workspaceRoot || "");
			const [currentPath, setCurrentPath] = react.useState(initialRoot);
			const [pathBox, setPathBox] = react.useState(initialRoot);
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [rootEntries, setRootEntries] = react.useState(null);
			const [rootTruncated, setRootTruncated] = react.useState(false);
			// 单个共享右键菜单: 记录触发行 + 光标位置; 复制成功短暂显示「已复制」。
			const [rowMenu, setRowMenu] = react.useState(null);
			const [copiedPath, setCopiedPath] = react.useState(null);
			// 临时提示条 (如官方 @ 引用不可用的原因), 数秒后自动消失。
			const [notice, setNotice] = react.useState(null);
			const noticeTimerRef = react.useRef(null);
			const showNotice = react.useCallback((text) => {
				setNotice(text);
				if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
				noticeTimerRef.current = window.setTimeout(() => setNotice(null), 6000);
			}, []);
			react.useEffect(() => () => {
				if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
			}, []);

			// 工作区根/会话工作目录可能在会话挂载后才确定, 首次拿到后同步当前浏览目录。
			react.useEffect(() => {
				if (currentPath === "") {
					const target = cwd || workspaceRoot || "";
					if (target !== "") {
						setCurrentPath(target);
						setPathBox(target);
					}
				}
			}, [cwd, workspaceRoot]);

			// 读取当前目录一级子项 (切目录 / 换会话 / 官方刷新都走这里)。
			react.useEffect(() => {
				let cancelled = false;
				if (currentPath === "") return undefined;
				setBusy(true);
				setError(null);
				setRootEntries(null);
				(async () => {
					try {
						const data = await postMethod("fs.tree", { sessionId, ...(cwd ? { cwd } : {}), path: currentPath });
						if (cancelled) return;
						setRootEntries((data.listing && data.listing.entries) || []);
						setRootTruncated(!!(data.listing && data.listing.truncated));
					} catch (loadError) {
						if (!cancelled) setError(errMessage(loadError));
					} finally {
						if (!cancelled) setBusy(false);
					}
				})();
				return () => { cancelled = true; };
			}, [currentPath, sessionId, cwd, refreshTick]);

			// 进入上级目录 (已是盘符/根目录时禁用)。
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

			// 打开右键菜单 (记录触发行与光标位置)。
			const openMenu = (entry, x, y) => {
				setRowMenu({ entry, x, y });
			};

			// 复制文本; 成功后把该行标记为「已复制」并短暂显示。
			const copyPath = (text, path) => {
				writeClipboard(text).then((ok) => {
					if (!ok) return;
					setCopiedPath(path);
					window.setTimeout(() => {
						setCopiedPath((current) => (current === path ? null : current));
					}, 1200);
				});
			};

			// 菜单项点击: insertref=官方 @ 引用, edit=打开编辑 tab, saveas=另存为, relative/absolute=复制。
			const onMenuSelect = (id) => {
				const menu = rowMenu;
				if (menu === null) return;
				setRowMenu(null);
				if (id === "insertref") {
					if (menu.entry.isDir) return;
					// 官方 @ 引用以会话工作目录 (header.cwd) 为根 —— 正是侧栏解析出的 cwd。
					insertOfficialReference(bridge, sessionId, cwd, menu.entry.path).then((insertError) => {
						if (insertError) showNotice(insertError);
					});
					return;
				}
				if (id === "edit") {
					if (menu.entry.isDir) return;
					onEdit(menu.entry.path);
					return;
				}
				if (id === "saveas") {
					saveAsFile({ sessionId, cwd: cwd || undefined }, menu.entry.path);
					return;
				}
				const text = id === "relative" ? relativeTo(currentPath, menu.entry.path) : menu.entry.path;
				copyPath(text, menu.entry.path);
			};

			const currentLabel = (currentPath || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || currentPath;

			return react.createElement("div", { className: "dsl-root" }, [
				// 顶部路径条: 返回上级 + 路径框 + 回到工作目录 + 刷新。
				react.createElement("div", { key: "head", className: "dsl-head" }, [
					react.createElement("button", {
						key: "up",
						type: "button",
						className: "dsl-tool",
						disabled: !canGoUp,
						title: t("btn_up"),
						onClick: goUp,
					}, "⬆"),
					react.createElement("input", {
						key: "path",
						type: "text",
						className: "dsl-path",
						value: pathBox,
						spellCheck: false,
						placeholder: t("path.placeholder"),
						onChange: (event) => setPathBox(event.target.value),
						onKeyDown: (event) => { if (event.key === "Enter") goToPath(); },
					}),
					// 回到工作目录: 目标是「这个会话锁指定的目录」= 会话工作目录 cwd,
					// 无会话/无 cwd 时才回退工作区根 workspaceRoot。
					// 图标用内联 SVG 房子 (不依赖字体字形, 跨浏览器/字体稳定显示);
					// 图标旁带文字标签「目录」, 一眼可辨用途; 悬停提示显示实际跳转目标路径。
					react.createElement("button", {
						key: "home",
						type: "button",
						className: "dsl-home",
						title: t("btn_home_title") + ": " + (cwd || workspaceRoot || ""),
						onClick: () => {
							const target = (cwd || workspaceRoot || "");
							if (target !== "") { setCurrentPath(target); setPathBox(target); }
						},
					}, [
						react.createElement("svg", { key: "ic", width: 15, height: 15, viewBox: "0 0 24 24", fill: "currentColor", style: { display: "block" } }, react.createElement("path", { d: "M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" })),
						react.createElement("span", { key: "lb" }, t("btn_home")),
					]),
					react.createElement("button", {
						key: "refresh",
						type: "button",
						className: "dsl-tool",
						title: t("btn_refresh"),
						onClick: () => { if (typeof onRefresh === "function") onRefresh(); },
					}, "⟳"),
				]),
				error !== null && react.createElement("div", { key: "err", className: "dsl-error" }, t("files.load_error") + error),
				notice !== null && react.createElement("div", { key: "ntc", className: "dsl-error" }, notice),
				react.createElement("div", { key: "body", className: "dsl-body" }, [
					// 根行: 当前目录自身也可右键 (复制相对/绝对路径)。
					react.createElement("div", {
						key: "rootrow",
						className: "dsl-row",
						style: { paddingLeft: 6 },
						title: currentPath,
						onClick: () => { if (currentPath) copyPath(relativeTo(currentPath, currentPath), currentPath); },
						onContextMenu: (event) => { event.preventDefault(); event.stopPropagation(); if (currentPath) openMenu({ isDir: true, name: currentLabel, path: currentPath }, event.clientX, event.clientY); },
					}, [
						react.createElement("span", { key: "glyph", className: "dsl-glyph" }, "📁"),
						react.createElement("span", { key: "name", className: "dsl-name", style: { flex: 1 } }, currentLabel + (busy ? t("files.loading_suffix") : "")),
						copiedPath === currentPath && react.createElement("span", { key: "copied", className: "dsl-copied" }, t("files.copied")),
					]),
					rootEntries === null && !error && react.createElement("div", { key: "loading", className: "dsl-note" }, t("files.scanning")),
					rootEntries !== null && rootEntries.length === 0 && react.createElement("div", { key: "empty", className: "dsl-note" }, t("files.empty")),
					rootEntries !== null && rootTruncated && react.createElement("div", { key: "trunc", className: "dsl-note" }, t("files.truncated_note")),
					rootEntries !== null ? rootEntries.map((child) => react.createElement(TreeNode, {
						key: child.path,
						entry: child,
						depth: 0,
						scope: { sessionId, cwd: currentPath },
						refreshTick,
						onOpenFile,
						onMenu: openMenu,
						t,
					})) : null,
					// 菜单遮罩: 点击空白处关闭菜单。
					rowMenu !== null && react.createElement("div", {
						key: "menu-mask",
						className: "dsl-menu-mask",
						onMouseDown: () => setRowMenu(null),
						onContextMenu: (event) => event.preventDefault(),
					}),
					rowMenu !== null && react.createElement(ContextMenu, {
						key: "menu",
						x: rowMenu.x,
						y: rowMenu.y,
						entry: rowMenu.entry,
						onSelect: onMenuSelect,
						t,
					}),
				]),
			]);
		}

		// ---- 文件树 tab 正文 (注册为 kind "files" 的类型正文) ----

		function FilesBody({ useTabInfo, sessionId, useSessions, t }) {
			const tab = useTabInfo().tab;

			// 会话工作目录: 官方标准 prop 提供的会话列表选择器 (不再订阅 ctx.sessions.list)。
			const sessionCwd = useSessions((state) => (state && state.byId ? (state.byId[sessionId] && state.byId[sessionId].cwd) : undefined));

			// 根解析兜底: useSessions 拿不到 cwd 时, 经宿主 session.cwd 取 workspaceRoot || cwd。
			const [fallbackRoot, setFallbackRoot] = react.useState("");
			const [fallbackSettled, setFallbackSettled] = react.useState(false);
			const fallbackResolvedFor = react.useRef(null);
			// 会话切换 (keepMounted 下) 时重置根兜底与展开状态。
			react.useEffect(() => {
				setFallbackRoot("");
				setFallbackSettled(false);
				fallbackResolvedFor.current = null;
			}, [sessionId]);
			react.useEffect(() => {
				if (typeof sessionCwd === "string" && sessionCwd !== "") return undefined;
				if (fallbackResolvedFor.current === sessionId) return undefined;
				fallbackResolvedFor.current = sessionId;
				let cancelled = false;
				(async () => {
					try {
						const data = await postMethod("session.cwd", { sessionId });
						if (!cancelled) setFallbackRoot(data.workspaceRoot || data.cwd || "");
					} catch (fallbackError) {
						// 宿主不可用时保持空根, 界面提示"没有工作目录"。
					} finally {
						if (!cancelled) setFallbackSettled(true);
					}
				})();
				return () => { cancelled = true; };
			}, [sessionId, sessionCwd]);

			const hasSessionCwd = (typeof sessionCwd === "string" && sessionCwd !== "");
			// 当前会话的根兜底是否已经落定 (ref 在 effect 内同步赋值, 再触发状态更新)。
			const fallbackReady = fallbackResolvedFor.current === sessionId && fallbackSettled;
			const effectiveCwd = hasSessionCwd ? sessionCwd : (fallbackRoot || "");

			// 官方刷新快捷键: 绑定到「重新读取当前目录」。
			const [refreshTick, setRefreshTick] = react.useState(0);
			react.useEffect(() => {
				if (!tab || !tab.actions || typeof tab.actions.bindCommands !== "function") return undefined;
				return tab.actions.bindCommands({ refresh: () => setRefreshTick((tick) => tick + 1) });
			}, [tab.actions, tab.id]);

			// 官方 @ 引用插入需要的会话级通道 (与 dsh-file-browser 插件相同):
			//   provideInfo(id) -> standard-kit 提供包
			//   scope(id)       -> 会话作用域 ctx (用于派发 slash/input-insert-reference)
			const bridge = {
				provideInfo: (id) => {
					try {
						const sessions = pluginContext && pluginContext.sessions;
						return sessions && typeof sessions.provideInfo === "function" ? sessions.provideInfo(id) : null;
					} catch (error) { return null; }
				},
				scope: (id) => {
					try {
						const sessions = pluginContext && pluginContext.sessions;
						return sessions && typeof sessions.resolveAgentScope === "function" ? sessions.resolveAgentScope(id) : (sessions && typeof sessions.scope === "function" ? sessions.scope(id) : null);
					} catch (error) { return null; }
				},
			};

			// 单击文件行: 交给官方资源预览 (Markdown/代码/图片/PDF 都由官方渲染)。
			const openResource = (absolutePath) => {
				if (!tab || !tab.actions) return;
				tab.actions.openResource(fileAddressFor(sessionId, effectiveCwd, absolutePath));
			};
			// 「编辑」: 打开本插件的编辑 tab, 文件身份编进资源地址 (刷新页面后可恢复同一文件)。
			const openEdit = (absolutePath) => {
				if (!tab || !tab.actions) return;
				tab.actions.openResource(editAddressFor(sessionId, absolutePath));
			};

			// 根尚未确定 (会话 cwd 未到 / 兜底未落定): 先显示"扫描目录…", 避免用上一会话的旧根挂载树。
			if (!hasSessionCwd && !fallbackReady) {
				return react.createElement("div", { className: "dsl-root" },
					react.createElement("div", { className: "dsl-note" }, t("files.scanning")));
			}
			if (effectiveCwd === "") {
				return react.createElement("div", { className: "dsl-root" },
					react.createElement("div", { className: "dsl-note" }, t("files.no_workspace")));
			}

			return react.createElement(ExplorerView, {
				// keepMounted 下换会话时用 key 强制重建, 重置根目录/展开/菜单等内部状态。
				key: sessionId,
				sessionId,
				cwd: effectiveCwd,
				workspaceRoot: fallbackRoot,
				refreshTick,
				onRefresh: () => setRefreshTick((tick) => tick + 1),
				t,
				onOpenFile: (entry) => openResource(entry.path),
				onEdit: openEdit,
				bridge,
			});
		}

		// ---- 编辑 tab (kind "sidebar-lite.edit") ----
		// 内容完全由 props 里的会话与 tab 身份驱动: 文件路径从资源地址 (tab.contentId) 还原,
		// 因为官方只持久化地址、不持久化 navigation.params。

		function EditorBody({ useTabInfo, sessionId, t }) {
			const tab = useTabInfo().tab;
			// 绝对路径来自资源地址, 因此宿主端无需再用 cwd 兜底 (resolvePathUnder 只接受绝对路径)。
			const filePath = pathFromEditAddress(tab && tab.contentId);

			const [kind, setKind] = react.useState("loading");   // loading | text | binary | error
			const [content, setContent] = react.useState("");
			const [truncated, setTruncated] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [dirty, setDirty] = react.useState(false);
			const [saved, setSaved] = react.useState(false);
			const [saving, setSaving] = react.useState(false);
			const savedTimerRef = react.useRef(null);

			// 读取文件内容 (二进制 / 超 1MB 截断分别标记)。
			react.useEffect(() => {
				let cancelled = false;
				if (filePath === "") {
					setKind("error");
					setError(t("edit.no_path"));
					return undefined;
				}
				setKind("loading");
				setError(null);
				setDirty(false);
				setSaved(false);
				setTruncated(false);
				(async () => {
					try {
						const data = await postMethod("fs.read", { sessionId, path: filePath });
						if (cancelled) return;
						const file = (data && typeof data.file === "object") ? data.file : null;
						if (file === null) {
							setKind("error");
							setError(t("edit.read_failed"));
							return;
						}
						setTruncated(file.truncated === true);
						if (file.kind === "binary") {
							setKind("binary");
							setContent("");
							return;
						}
						setKind("text");
						setContent(typeof file.content === "string" ? file.content : "");
					} catch (readError) {
						if (!cancelled) {
							setKind("error");
							setError(t("edit.read_failed") + errMessage(readError));
						}
					}
				})();
				return () => { cancelled = true; };
			}, [filePath, sessionId]);

			react.useEffect(() => () => {
				if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
			}, []);

			/** 保存: 把 textarea 内容写回宿主 (截断文件禁止保存)。 */
			const save = async () => {
				if (saving || kind !== "text" || truncated) return;
				setSaving(true);
				setError(null);
				try {
					await postMethod("fs.write", { sessionId, path: filePath, content });
					setDirty(false);
					setSaved(true);
					if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
					savedTimerRef.current = window.setTimeout(() => setSaved(false), 1600);
				} catch (writeError) {
					setError(t("edit.save_failed") + errMessage(writeError));
				} finally {
					setSaving(false);
				}
			};

			const fileName = baseNameOf(filePath) || t("edit.title");

			if (kind === "loading") {
				return react.createElement("div", { className: "dsl-editor" },
					react.createElement("div", { className: "dsl-editor-message" }, t("edit.loading")));
			}
			if (kind === "error") {
				return react.createElement("div", { className: "dsl-editor" },
					react.createElement("div", { className: "dsl-editor-message" }, error));
			}
			if (kind === "binary") {
				return react.createElement("div", { className: "dsl-editor" }, [
					react.createElement("div", { key: "bar", className: "dsl-editor-bar" }, [
						react.createElement("span", { key: "name", className: "dsl-editor-name", title: filePath }, fileName),
					]),
					react.createElement("div", { key: "msg", className: "dsl-editor-message" }, t("edit.binary")),
				]);
			}

			return react.createElement("div", { className: "dsl-editor" }, [
				react.createElement("div", { key: "bar", className: "dsl-editor-bar" }, [
					react.createElement("span", { key: "name", className: "dsl-editor-name", title: filePath }, fileName),
					truncated ? null : react.createElement("button", {
						key: "save",
						type: "button",
						className: "dsl-tool",
						disabled: !dirty || saving,
						onClick: save,
					}, saved ? t("edit.saved") : (saving ? t("edit.saving") : t("edit.save"))),
				]),
				truncated && react.createElement("div", { key: "trunc", className: "dsl-editor-note" }, t("edit.truncated")),
				error !== null && react.createElement("div", { key: "err", className: "dsl-error" }, error),
				react.createElement("textarea", {
					key: "area",
					className: "dsl-editor-area",
					value: content,
					readOnly: truncated,
					spellCheck: false,
					onChange: (event) => { setContent(event.target.value); setDirty(true); },
				}),
			]);
		}

		/** 编辑 tab 的标题: 显示文件名 (同样从资源地址还原绝对路径)。 */
		function EditorTitle({ useTabInfo, t }) {
			const tab = useTabInfo().tab;
			const filePath = pathFromEditAddress(tab && tab.contentId);
			return react.createElement("span", { className: "dsl-title" }, (baseNameOf(filePath) || t("edit.title")));
		}

		// ---- 文案字典 (扁平键值; zh 为准, en 对应) ----
		const zh = {
			"files.title": "文件",
			"files.description": "浏览会话工作区的文件",
			"files.no_workspace": "这个会话没有工作目录。",
			"files.scanning": "扫描目录…",
			"files.empty": "(空目录)",
			"files.load_failed": "读取失败",
			"files.load_error": "加载失败: ",
			"files.copied": "已复制",
			"files.loading_suffix": " · 加载中…",
			"files.truncated_note": "条目太多, 只显示了一部分。",
			"path.placeholder": "完整路径, 回车跳转",
			btn_up: "返回上级",
			btn_home: "目录",
			"btn_home_title": "回到工作目录",
			btn_refresh: "刷新",
			menu_insert_ref: "以官方 @ 引用插入",
			menu_edit: "编辑",
			menu_save_as: "另存为",
			menu_copy_rel: "复制相对路径",
			menu_copy_abs: "复制绝对路径",
			"edit.title": "编辑",
			"edit.no_path": "没有可编辑的文件。",
			"edit.loading": "读取文件…",
			"edit.read_failed": "无法读取: ",
			"edit.binary": "该文件不可编辑（二进制）。",
			"edit.truncated": "文件过大，已截断，禁止保存。",
			"edit.save": "保存",
			"edit.saving": "保存中…",
			"edit.saved": "已保存 ✓",
			"edit.save_failed": "保存失败: ",
		};
		const en = {
			"files.title": "Files",
			"files.description": "Browse files in this session's workspace",
			"files.no_workspace": "This session has no workspace directory.",
			"files.scanning": "Reading…",
			"files.empty": "(Empty directory)",
			"files.load_failed": "Read failed",
			"files.load_error": "Load failed: ",
			"files.copied": "Copied",
			"files.loading_suffix": " · loading…",
			"files.truncated_note": "Too many entries, showing only some of them.",
			"path.placeholder": "Full path, press Enter to jump",
			btn_up: "Go to parent",
			btn_home: "Dir",
			"btn_home_title": "Back to working directory",
			btn_refresh: "Reload",
			menu_insert_ref: "Insert as official @ reference",
			menu_edit: "Edit",
			menu_save_as: "Save as",
			menu_copy_rel: "Copy relative path",
			menu_copy_abs: "Copy absolute path",
			"edit.title": "Edit",
			"edit.no_path": "No file to edit.",
			"edit.loading": "Reading file…",
			"edit.read_failed": "Cannot read: ",
			"edit.binary": "This file cannot be edited (binary).",
			"edit.truncated": "File too large; truncated and saving is disabled.",
			"edit.save": "Save",
			"edit.saving": "Saving…",
			"edit.saved": "Saved ✓",
			"edit.save_failed": "Save failed: ",
		};

		// ---- 应用入口 ----

		function apply(ctx) {
			// 模块级保存 ctx: 组件内用它构造 sessions 桥接 (官方 @ 引用插入)。
			pluginContext = ctx;

			const t = ctx.locale.bind(LOCALE_NS);
			ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), "dsh-sidebar-lite: dictionaries");

			// 1) 接管官方内置文件树 (kind "files"): extension 档压过官方 builtin,
			//    卸载本插件后官方文件树自动恢复。
			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: FILES_TYPE_ID,
				kind: FILES_KIND,
				priority: "extension",
				keepMounted: true,
				title: () => t("files.title"),
				guide: [{
					id: "files",
					commandId: FILES_GUIDE_COMMAND_ID,
					order: 20,
					title: () => t("files.title"),
					description: () => t("files.description"),
				}],
			}), "dsh-sidebar-lite: files type");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: FILES_TYPE_ID,
				locale: LOCALE_NS,
			}, FilesBody)), "dsh-sidebar-lite: files body");

			// 2) 编辑类型: 资源类型 (认领 dsh-resource://edit/**), 文件身份编进地址本身。
			//    官方持久化资源地址 (contentId), 因此刷新页面后编辑 tab 仍能定位同一文件;
			//    同一文件重复打开按地址去重, 复用同一个 tab。
			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: EDIT_TYPE_ID,
				kind: EDIT_KIND,
				priority: "extension",
				patterns: [EDIT_ADDRESS_PREFIX + "**"],
				canOpen: (address) => pathFromEditAddress(address) !== "",
				title: (address) => baseNameOf(pathFromEditAddress(address)) || t("edit.title"),
			}), "dsh-sidebar-lite: edit type");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: EDIT_TYPE_ID,
				locale: LOCALE_NS,
			}, EditorBody)), "dsh-sidebar-lite: edit body");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
				name: "sidebar.right.pane.tab.title",
				key: EDIT_TYPE_ID,
				locale: LOCALE_NS,
			}, EditorTitle)), "dsh-sidebar-lite: edit title");

			// 3) 官方输入机捕获 (不变): 注册 conversation.input.left 的隐藏组件,
			//    把 ownerProps.inputActions / input (InputZone 契约快照) 存入模块级变量,
			//    供右键「以官方 @ 引用插入」读取输入机 draft / draftRev。渲染 null 不占 UI。
			try {
				ctx.slots.inject("conversation.input.left", () => ctx.slots.register(
					{ name: "conversation.input.left", id: "dsh-sidebar-lite-bridge", order: 1 },
					(ownerProps) => {
						capturedInputActions = (ownerProps && ownerProps.inputActions) || null;
						capturedInput = (ownerProps && ownerProps.input) || null;
						return null;
					},
				));
			} catch (error) { /* slot 不可用时插入退化为 bail / DOM fallback */ }

			injectStyles();
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});