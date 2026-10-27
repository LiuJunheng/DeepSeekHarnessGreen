// DeepSeek Harness 插件 (客户端): dsh-lan-visibility
// 在「设置」面板新增「局域网可见性」分区:
//   - 列出全部工作区与会话(含存活与持久化会话), 每项一个「局域网可见」开关;
//   - 默认仅本机可见; 勾选后局域网设备(非回环来源)才能看到/操作该项;
//   - 未勾选/未保存状态直接读宿主路由, 本机回环访问才有权限(局域网用户打开本面板会 403)。
// 数据通过 fetch 调用宿主端路由 /__dsh/lan-visibility/* (带自定义头防跨站)。
// 这是加载器契约格式 (window.__ModuleLoader__.load), 与官方客户端插件一致。
// 注意: 不修改任何官方文件/包; 样式用内联对象, 颜色取官方 CSS 变量自动适配主题。

// 当前页面是否本机打开(回环地址): 管理入口只对本机页面注册,
// 局域网设备打开页面时不显示「局域网可见性」设置页与右键菜单项(避免 403 空转)。
function isLoopbackPage() {
	try {
		var pageHostname = window.location.hostname;
		return pageHostname === '127.0.0.1' || pageHostname === 'localhost'
			|| pageHostname === '::1' || pageHostname === '[::1]';
	} catch (_error) {
		return true;
	}
}

// 现场解析当前语言(读 <html lang>), 与其它插件一致, 切换语言后重新渲染即可。
function readCurrentLanguage() {
    var language = document.documentElement && document.documentElement.lang;
    if (language === 'zh-CN' || language === 'zh') return 'zh';
    if (language && language.indexOf('en') === 0) return 'en';
    return 'zh';
}

// 中英双语文案表: 键 -> [中文, English]。
var LABELS = {
    sectionTitle: ['局域网可见性', 'LAN visibility'],
    intro: [
        '默认仅本机可见。勾选「局域网可见」后, 同一局域网的设备才能看到并操作该工作区/会话; 本机(127.0.0.1)始终可见。',
        'Local-only by default. Tick "Share with LAN" so other devices on the same LAN can see and use that workspace or conversation; localhost (127.0.0.1) always sees everything.',
    ],
    defaultNote: ['默认: 仅本机可见', 'Default: local-only'],
    workspaceGroup: ['工作区', 'Workspaces'],
    sessionGroup: ['对话', 'Conversations'],
    noWorkspaces: ['暂无工作区', 'No workspaces'],
    noSessions: ['暂无对话', 'No conversations'],
    shareWithLan: ['局域网可见', 'Share with LAN'],
    menuShare: ['共享给局域网', 'Share with LAN'],
    menuUnshare: ['取消共享给局域网', 'Stop sharing with LAN'],
    chipLan: ['局域网', 'LAN'],
    chipLocal: ['本机', 'Local'],
    chipLanTitle: ['该会话对局域网用户可见', 'This conversation is shared with the LAN'],
    chipLocalTitle: ['该会话仅本机可见', 'This conversation is local-only'],
    sessionCount: ['个对话', 'conversations'],
    loading: ['加载中 ...', 'Loading ...'],
    loadFailed: ['加载失败: ', 'Failed to load: '],
    refresh: ['刷新', 'Refresh'],
    saveFailed: ['保存失败: ', 'Failed to save: '],
    untitled: ['未命名', 'Untitled'],
    sessionPrefix: ['会话 ', 'Session '],
    networkTitle: ['局域网地址', 'LAN address'],
    networkHint: [
        '复制下面任一条链接发给局域网设备(手机 / 另一台电脑), 对方在浏览器打开即可; 链接已自带访问凭据(约 30 天有效)。',
        'Copy one of the links below and send it to a LAN device (phone / another computer); it opens directly in a browser. The link already carries the access credential (valid ~30 days).',
    ],
    networkLanOff: [
        '当前服务只绑定本机(127.0.0.1), 局域网设备无法访问。请在启动器里打开「局域网模式」(dsh_host=0.0.0.0)并重启服务。',
        'The service is bound to localhost only, so LAN devices cannot reach it. Enable LAN mode (dsh_host=0.0.0.0) in the launcher and restart the service.',
    ],
    networkNone: ['未检测到局域网地址(请确认已连接网络/已开启局域网模式)。', 'No LAN address detected (check the network and LAN mode).'],
    networkCopy: ['复制链接', 'Copy link'],
    networkCopied: ['已复制', 'Copied'],
};

function textOf(key) {
    var pair = LABELS[key];
    if (pair === undefined) return key;
    return readCurrentLanguage() === 'en' ? pair[1] : pair[0];
}

window.__ModuleLoader__.load({
	id: "dsh-lan-visibility",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const ROUTE_LIST = "/__dsh/lan-visibility/list";
		const ROUTE_SET = "/__dsh/lan-visibility/set";
		const ROUTE_NETWORK = "/__dsh/lan-visibility/network";
		const GUARD_HEADER = "x-dsh-lan-visibility";

		// 统一的鉴权头 + JSON 请求封装: 路由要求自定义头(防跨站), 否则 403。
		async function requestJson(url, options) {
			const init = options === undefined ? {} : options;
			const headers = init.headers === undefined ? {} : Object.assign({}, init.headers);
			headers[GUARD_HEADER] = "1";
			const response = await fetch(url, Object.assign({}, init, { headers }));
			if (!response.ok) {
				let detail = "HTTP " + response.status;
				try {
					const text = await response.text();
					if (text) detail = detail + " " + text;
				} catch (_error) {
					// 忽略响应体读取失败
				}
				throw new Error(detail);
			}
			return await response.json();
		}

		// ---------- 会话行可见性标签(官方侧栏没有"标题后"插槽, 用 DOM 注入实现) ----------
		// 官方会话行结构(ui-workspace SessionNodeItem): [状态点 span][标题 span][时间 span][置顶][操作 span],
		// 行元素带 data-row-key="session:<id>"。标签插入到「标题」与「时间」之间; React 重建行时
		// 由 MutationObserver 自动补回, 并以 30s 周期刷新可见性快照。
		const CHIP_ATTR = "data-dsh-lan-visibility-chip";
		let visibilitySnapshot = { sessions: new Map(), workspaces: new Map() };
		let scheduledScanTimer = null;
		let lastSnapshotRefreshAt = 0;

		/** 把列表路由返回的数据同时作为可见性快照(供行标签使用), 并重新装饰行。 */
		function applySnapshotFromPayload(payload) {
			const sessions = new Map();
			for (const row of (Array.isArray(payload.sessions) ? payload.sessions : [])) {
				if (row !== null && typeof row === "object" && typeof row.id === "string") sessions.set(row.id, row);
			}
			const workspaces = new Map();
			for (const row of (Array.isArray(payload.workspaces) ? payload.workspaces : [])) {
				if (row !== null && typeof row === "object" && typeof row.id === "string") workspaces.set(row.id, row);
			}
			visibilitySnapshot = { sessions, workspaces };
			lastSnapshotRefreshAt = Date.now();
			decorateSessionRows();
		}

		/** 刷新可见性快照(列表路由), 并重新装饰会话行。 */
		async function refreshVisibilitySnapshot() {
			try {
				applySnapshotFromPayload(await requestJson(ROUTE_LIST));
			} catch (_error) {
				// 读取失败时保留旧快照, 仅重新装饰现有行
				decorateSessionRows();
			}
		}

		/** 会话在快照中的有效可见性(未收录的新会话按默认「仅本机」)。 */
		function sessionVisibleFromSnapshot(sessionId) {
			const row = visibilitySnapshot.sessions.get(sessionId);
			return row !== undefined && row.visible === true;
		}

		/** 设置标签的文案与颜色(局域网=强调色, 本机=弱化色)。 */
		function decorateVisibilityChip(chip, visible) {
			const label = visible ? textOf("chipLan") : textOf("chipLocal");
			if (chip.textContent !== label) chip.textContent = label;
			Object.assign(chip.style, {
				display: "inline-flex",
				alignItems: "center",
				flex: "none",
				marginLeft: 4,
				padding: "0 4px",
				borderRadius: 3,
				fontSize: 10,
				lineHeight: "14px",
				fontWeight: 400,
				whiteSpace: "nowrap",
				userSelect: "none",
			});
			chip.style.color = visible ? "var(--dsw-alias-accent, #4d6bfe)" : "var(--dsw-alias-fg-secondary, #888)";
			chip.style.background = visible ? "rgba(77,107,254,0.12)" : "transparent";
			chip.style.border = visible
				? "1px solid rgba(77,107,254,0.35)"
				: "1px solid var(--dsw-alias-border, rgba(128,128,128,0.3))";
			chip.title = visible ? textOf("chipLanTitle") : textOf("chipLocalTitle");
		}

		/** 遍历官方侧栏会话行, 给每行标题后补可见性标签。 */
		function decorateSessionRows() {
			let unknownSession = false;
			const rows = document.querySelectorAll('[data-row-key^="session:"]');
			for (const row of rows) {
				const rowKey = row.getAttribute("data-row-key");
				if (rowKey === null) continue;
				const sessionId = rowKey.slice("session:".length);
				if (!visibilitySnapshot.sessions.has(sessionId)) unknownSession = true;
				let chip = row.querySelector("[" + CHIP_ATTR + "]");
				if (chip === null) {
					chip = document.createElement("span");
					chip.setAttribute(CHIP_ATTR, "1");
					// 行结构: [0]=状态点/leading 槽, [1]=标题, [2]=时间(空白会话没有时间, 追加到末尾)
					const timeSpan = row.children[2];
					if (timeSpan !== undefined) row.insertBefore(chip, timeSpan);
					else row.appendChild(chip);
				}
				decorateVisibilityChip(chip, sessionVisibleFromSnapshot(sessionId));
			}
			// 出现快照里没有的会话(如刚新建): 节流刷新一次快照
			if (unknownSession && Date.now() - lastSnapshotRefreshAt > 5000) {
				lastSnapshotRefreshAt = Date.now();
				void refreshVisibilitySnapshot();
			}
		}

		/** 合并短时间内的大量 DOM 变化(消息流式输出等), 只安排一次扫描。 */
		function scheduleRowDecoration() {
			if (scheduledScanTimer !== null) return;
			scheduledScanTimer = setTimeout(() => {
				scheduledScanTimer = null;
				decorateSessionRows();
			}, 150);
		}

		/** 安装行标签: 首次刷新 + 30s 周期刷新 + MutationObserver 增量补回。 */
		function installSessionRowBadges() {
			void refreshVisibilitySnapshot();
			setInterval(() => { void refreshVisibilitySnapshot(); }, 30000);
			try {
				const observer = new MutationObserver(() => { scheduleRowDecoration(); });
				observer.observe(document.body, { childList: true, subtree: true });
			} catch (_error) {
				// 环境不支持 MutationObserver 时仅靠周期刷新
			}
		}

		function formatTime(milliseconds) {
			if (typeof milliseconds !== "number" || milliseconds <= 0) return "";
			try {
				return new Date(milliseconds).toLocaleString();
			} catch (_error) {
				return "";
			}
		}

		function shortSessionId(sessionId) {
			if (typeof sessionId !== "string" || sessionId.length <= 20) return String(sessionId);
			return sessionId.slice(0, 6) + "..." + sessionId.slice(-8);
		}

		// 单个可见性开关: 复选框 + 文案。勾选 = 局域网可见。
		function VisibilityToggle(props) {
			const checked = props.checked === true;
			const disabled = props.disabled === true;
			return react.createElement("label", {
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: 6,
					cursor: disabled ? "default" : "pointer",
					flex: "none",
					opacity: disabled ? 0.6 : 1,
				},
				title: textOf("shareWithLan"),
			}, [
				react.createElement("input", {
					key: "checkbox",
					type: "checkbox",
					checked: checked,
					disabled: disabled,
					onChange: () => { if (props.onChange) props.onChange(!checked); },
					style: { width: 14, height: 14, margin: 0, accentColor: "var(--dsw-alias-accent, #4d6bfe)" },
				}),
				react.createElement("span", {
					key: "label",
					style: { fontSize: 12, color: "var(--dsw-alias-fg-secondary, #666)" },
				}, textOf("shareWithLan")),
			]);
		}

		function LanVisibilitySection() {
			const [payload, setPayload] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [pendingKey, setPendingKey] = react.useState(null);
			const [network, setNetwork] = react.useState(null);
			const [copiedAddress, setCopiedAddress] = react.useState(null);

			const loadList = react.useCallback(async () => {
				setBusy(true);
				setError(null);
				try {
					const next = await requestJson(ROUTE_LIST);
					setPayload(next);
					// 同一份数据也作为行标签快照, 避免再发一次请求
					applySnapshotFromPayload(next);
					// 局域网地址探测(失败不影响列表展示)
					try {
						setNetwork(await requestJson(ROUTE_NETWORK));
					} catch (_networkError) {
						setNetwork(null);
					}
				} catch (err) {
					setError(textOf("loadFailed") + String((err && err.message) || err));
				} finally {
					setBusy(false);
				}
			}, []);

			react.useEffect(() => { void loadList(); }, [loadList]);

			const toggleItem = react.useCallback(async (kind, id, nextVisible) => {
				const pending = kind + ":" + id;
				setPendingKey(pending);
				try {
					await requestJson(ROUTE_SET, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ kind, id, visible: nextVisible }),
					});
					// 成功后就地更新本地数据, 避免整表闪烁; 之后异步再拉一次保持权威。
					setPayload((previous) => {
						if (previous === null) return previous;
						const isSession = kind === "session";
						const updateRow = (row) => (row.id === id ? Object.assign({}, row, { visible: nextVisible }) : row);
						return Object.assign({}, previous, {
							workspaces: isSession ? previous.workspaces : previous.workspaces.map(updateRow),
							sessions: isSession ? previous.sessions.map(updateRow) : previous.sessions,
						});
					});
					void loadList();
				} catch (err) {
					setError(textOf("saveFailed") + String((err && err.message) || err));
				} finally {
					setPendingKey(null);
				}
			}, [loadList]);

			// 复制一键打开链接: 优先 Clipboard API, 失败回退 textarea + execCommand。
			const copyLink = react.useCallback(async (url, address) => {
				let copied = false;
				try {
					if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === "function") {
						await navigator.clipboard.writeText(url);
						copied = true;
					}
				} catch (_error) {
					// 回退到 execCommand
				}
				if (!copied) {
					try {
						const textarea = document.createElement("textarea");
						textarea.value = url;
						textarea.style.position = "fixed";
						textarea.style.opacity = "0";
						document.body.appendChild(textarea);
						textarea.select();
						document.execCommand("copy");
						document.body.removeChild(textarea);
						copied = true;
					} catch (_error) {
						// 复制失败则静默
					}
				}
				if (copied) {
					setCopiedAddress(address);
					setTimeout(() => {
						setCopiedAddress((current) => (current === address ? null : current));
					}, 1500);
				}
			}, []);

			const cardStyle = {
				border: "1px solid var(--dsw-alias-border, rgba(128,128,128,0.25))",
				borderRadius: 8,
				padding: "12px 14px",
				marginBottom: 12,
				background: "var(--dsw-alias-bg-elevated, transparent)",
			};
			const headerStyle = {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 8,
				marginBottom: 6,
			};
			const rowStyle = {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 10,
				padding: "6px 0",
				borderTop: "1px solid var(--dsw-alias-border, rgba(128,128,128,0.15))",
			};
			const nameStyle = { fontSize: 13, color: "var(--dsw-alias-fg-primary, inherit)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
			const metaStyle = { fontSize: 12, color: "var(--dsw-alias-fg-secondary, #888)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "1 1 auto", marginLeft: 8, minWidth: 0 };
			const noteStyle = { fontSize: 12, color: "var(--dsw-alias-fg-secondary, #888)", marginBottom: 10, lineHeight: 1.6 };

			if (payload === null) {
				return react.createElement("div", { style: { padding: 8 } },
					busy ? textOf("loading") : (error !== null ? react.createElement("div", { style: { color: "var(--dsw-alias-error, #d33)" } }, error) : null));
			}

			const workspaces = Array.isArray(payload.workspaces) ? payload.workspaces : [];
			const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];

			return react.createElement("div", { style: { padding: 8 } }, [
				react.createElement("div", { key: "header", style: headerStyle }, [
					react.createElement("div", { key: "title", style: { fontSize: 14, fontWeight: 600 } }, textOf("sectionTitle")),
					react.createElement("div", { key: "actions", style: { display: "flex", alignItems: "center", gap: 8 } }, [
						react.createElement("span", { key: "default", style: { fontSize: 12, color: "var(--dsw-alias-fg-secondary, #888)" } }, textOf("defaultNote")),
						react.createElement("button", {
							key: "refresh",
							type: "button",
							disabled: busy,
							onClick: () => { void loadList(); },
							style: { fontSize: 12, padding: "2px 10px", cursor: "pointer" },
						}, textOf("refresh")),
					]),
				]),
				react.createElement("div", { key: "intro", style: noteStyle }, textOf("intro")),
				error !== null ? react.createElement("div", { key: "error", style: { color: "var(--dsw-alias-error, #d33)", marginBottom: 8, fontSize: 12 } }, error) : null,

				// ---------- 局域网地址(自动检测 + 复制一键打开链接) ----------
				react.createElement("div", { key: "network-card", style: cardStyle }, [
					react.createElement("div", { key: "network-title", style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, textOf("networkTitle")),
					network === null
						? react.createElement("div", { key: "network-loading", style: { fontSize: 12, color: "var(--dsw-alias-fg-secondary, #888)", padding: "6px 0" } }, textOf("loading"))
						: network.lanMode !== true
							? react.createElement("div", { key: "network-off", style: { fontSize: 12, color: "var(--dsw-alias-warning, #d97706)", lineHeight: 1.6, padding: "4px 0" } }, textOf("networkLanOff"))
							: (Array.isArray(network.urls) && network.urls.length > 0
								? [
									react.createElement("div", { key: "network-hint", style: { fontSize: 12, color: "var(--dsw-alias-fg-secondary, #888)", lineHeight: 1.6, marginBottom: 4 } }, textOf("networkHint")),
									network.urls.map((entry) => react.createElement("div", { key: "network-" + entry.address, style: rowStyle }, [
										react.createElement("div", { key: "info", style: { flex: "1 1 auto", minWidth: 0 } }, [
											react.createElement("div", { key: "address", style: { fontSize: 13, fontWeight: 600 } }, entry.address),
											react.createElement("div", { key: "url", style: { fontSize: 11, color: "var(--dsw-alias-fg-secondary, #888)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: entry.url }, entry.url),
										]),
										react.createElement("button", {
											key: "copy",
											type: "button",
											onClick: () => { void copyLink(entry.url, entry.address); },
											style: { fontSize: 12, padding: "2px 10px", cursor: "pointer", flex: "none" },
										}, copiedAddress === entry.address ? textOf("networkCopied") : textOf("networkCopy")),
									])),
								]
								: react.createElement("div", { key: "network-none", style: { fontSize: 12, color: "var(--dsw-alias-fg-secondary, #888)", padding: "6px 0" } }, textOf("networkNone"))),
				]),

				// ---------- 工作区 ----------
				react.createElement("div", { key: "workspaces-card", style: cardStyle }, [
					react.createElement("div", { key: "workspaces-title", style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, textOf("workspaceGroup")),
					workspaces.length === 0
						? react.createElement("div", { key: "workspaces-empty", style: { fontSize: 12, color: "var(--dsw-alias-fg-secondary, #888)", padding: "6px 0" } }, textOf("noWorkspaces"))
						: workspaces.map((workspace) => {
							const displayName = workspace.title !== "" ? workspace.title : (workspace.path !== "" ? workspace.path : textOf("untitled"));
							return react.createElement("div", { key: "workspace-" + workspace.id, style: rowStyle }, [
								react.createElement("span", { key: "name", style: nameStyle, title: workspace.path }, displayName),
								react.createElement("span", { key: "meta", style: metaStyle }, (workspace.sessionCount || 0) + " " + textOf("sessionCount")),
								react.createElement(VisibilityToggle, {
									key: "toggle",
									checked: workspace.visible,
									disabled: pendingKey === "workspace:" + workspace.id,
									onChange: (next) => { void toggleItem("workspace", workspace.id, next); },
								}),
							]);
						}),
				]),

				// ---------- 会话 ----------
				react.createElement("div", { key: "sessions-card", style: cardStyle }, [
					react.createElement("div", { key: "sessions-title", style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, textOf("sessionGroup")),
					sessions.length === 0
						? react.createElement("div", { key: "sessions-empty", style: { fontSize: 12, color: "var(--dsw-alias-fg-secondary, #888)", padding: "6px 0" } }, textOf("noSessions"))
						: sessions.map((session) => {
							const parts = [];
							if (session.workspaceTitle) parts.push(session.workspaceTitle);
							if (session.cwd) parts.push(session.cwd);
							const timeText = formatTime(session.updatedAt);
							if (timeText) parts.push(timeText);
							// 标题与左侧会话栏一致(取会话 title 投影); 无标题的新会话回退显示短 id。
							const displayName = typeof session.title === "string" && session.title !== ""
								? session.title
								: textOf("sessionPrefix") + shortSessionId(session.id);
							return react.createElement("div", { key: "session-" + session.id, style: rowStyle }, [
								react.createElement("span", { key: "name", style: Object.assign({}, nameStyle, { flex: "0 1 auto", maxWidth: "38%" }), title: session.id }, displayName),
								react.createElement("span", { key: "meta", style: metaStyle }, parts.join(" · ") || "-"),
								react.createElement(VisibilityToggle, {
									key: "toggle",
									checked: session.visible,
									disabled: pendingKey === "session:" + session.id,
									onChange: (next) => { void toggleItem("session", session.id, next); },
								}),
							]);
						}),
				]),
			]);
		}

		// 会话行「...」菜单里的可见性行(官方 list 插槽: sidebar.workspaces.session.menu.item)。
		// ownerProps: { sessionId, displayTitle }; 标准 props 含 useMenuOpenState 钩子(返回 [open, setOpen])。
		// 菜单项动作: 点击后关闭菜单, 并把该会话切换为「局域网可见 / 仅本机可见」(显式记录, 优先级高于所属工作区)。
		function SessionMenuVisibilityItem(props) {
			const sessionId = props.sessionId;
			const menuOpenState = typeof props.useMenuOpenState === "function" ? props.useMenuOpenState() : [false, () => {}];
			const setMenuOpen = menuOpenState[1];
			const [visible, setVisible] = react.useState(null); // null=读取中; true/false=当前有效可见性
			const [busy, setBusy] = react.useState(false);

			react.useEffect(() => {
				let cancelled = false;
				(async () => {
					try {
						const payload = await requestJson(ROUTE_LIST);
						const row = (Array.isArray(payload.sessions) ? payload.sessions : []).find((session) => session.id === sessionId);
						if (!cancelled) setVisible(row !== undefined && row.visible === true);
					} catch (_error) {
						if (!cancelled) setVisible(false);
					}
				})();
				return () => { cancelled = true; };
			}, [sessionId]);

			const toggle = () => {
				if (typeof setMenuOpen === "function") setMenuOpen(false);
				if (busy || visible === null) return;
				setBusy(true);
				requestJson(ROUTE_SET, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ kind: "session", id: sessionId, visible: visible !== true }),
				}).catch(() => {}).then(() => {
					setBusy(false);
					// 切换后刷新行标签快照
					void refreshVisibilitySnapshot();
				});
			};

			return react.createElement("button", {
				type: "button",
				role: "menuitem",
				disabled: busy || visible === null,
				onClick: toggle,
				style: {
					display: "flex",
					alignItems: "center",
					width: "100%",
					boxSizing: "border-box",
					padding: "8px 12px",
					marginTop: 4,
					borderTop: "1px solid var(--dsw-alias-border, rgba(128,128,128,0.2))",
					background: "transparent",
					border: 0,
					borderRadius: 6,
					color: "var(--dsw-alias-fg-primary, inherit)",
					font: "inherit",
					fontSize: 13,
					textAlign: "left",
					cursor: busy || visible === null ? "default" : "pointer",
					opacity: busy || visible === null ? 0.6 : 1,
					gap: 8,
				},
			}, visible === true ? textOf("menuUnshare") : textOf("menuShare"));
		}

		const inject = ["slots"];

		function apply(ctx) {
			// 管理入口只对本机(回环地址)页面注册; 局域网设备页面不出现设置页与右键菜单项。
			if (!isLoopbackPage()) return;
			// 设置页「局域网可见性」卡片(工作区/会话总览与批量切换)。
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "lan-visibility",
				order: 520,
				label: () => (readCurrentLanguage() === "en" ? "LAN visibility" : "局域网可见性"),
			}, LanVisibilitySection));
			// 会话右键「...」菜单项: 官方 shipped 行 order = pin100/rename200/fork300/archive400/session-id450,
			// 本项放在 archive 之后、复制 Session ID 之前(430)。
			ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
				name: "sidebar.workspaces.session.menu.item",
				id: "lan-visibility",
				order: 430,
			}, SessionMenuVisibilityItem));
			// 会话列表行标题旁的可见性标签(DOM 注入; 官方无「标题后」插槽)。
			installSessionRowBadges();
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
