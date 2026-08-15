// DeepSeek Harness 插件 (客户端): dsh-session-rewind
// 在「设置」面板注册一个「会话回退」页面:
//   1) 列出全部会话 (标题/工作区/是否运行中/创建时间);
//   2) 「分析」某个会话: 展示逐回合信息 (用户问题/步骤/工具错误/是否完成);
//   3) 在任意已完成回合上点「回退到此」: 调用官方 session.fork 从该回合之后
//      派生一个干净的续接会话, 并自动打开它继续对话 (原会话保留)。
// 原理: 服务运行中无法原地改写会话文件 (持久化层有内存缓存), 官方机制就是
//       "派生 (fork)": 新会话携带截至选定回合的历史, 等效于移除失败消息。
// 这是加载器契约格式 (window.__ModuleLoader__.load), 与官方客户端插件一致。

window.__ModuleLoader__.load({
	id: "dsh-session-rewind",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const inject = ["slots"];

		const ROUTE_LIST = "/__dsh/session-rewind/list";
		const ROUTE_INSPECT = "/__dsh/session-rewind/inspect";
		const GUARD_HEADER = "X-DSH-Plugin-Rewind";

		const fmtTime = (ts) => {
			if (!ts) return "—";
			const d = new Date(ts);
			const p = (n) => String(n).padStart(2, "0");
			return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
		};

		// 多行文本 (最多 n 行, 超出省略) 的公共样式
		const clampStyle = (n) => ({
			display: "-webkit-box",
			WebkitLineClamp: n,
			WebkitBoxOrient: "vertical",
			overflow: "hidden",
			wordBreak: "break-word"
		});

		const errorBadge = (errors) => {
			const codes = Object.keys(errors || {});
			if (codes.length === 0) return null;
			return react.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
				codes.map((c) =>
					react.createElement("span", {
						key: c,
						style: { fontSize: 11, color: "#c0392b", background: "#fdecea", borderRadius: 3, padding: "1px 6px", whiteSpace: "nowrap" }
					}, c + "×" + errors[c])
				)
			);
		};

		function RewindSection({ getSessions }) {
			const [sessions, setSessions] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [inspecting, setInspecting] = react.useState(null);
			const [inspect, setInspect] = react.useState(null);
			const [working, setWorking] = react.useState(false);
			const [message, setMessage] = react.useState(null);
			const loadedRef = react.useRef(false);

			const loadList = react.useCallback(async () => {
				setBusy(true);
				setError(null);
				try {
					const response = await fetch(ROUTE_LIST, {
						method: "GET",
						headers: { [GUARD_HEADER]: "1" }
					});
					const payload = await response.json().catch(() => null);
					if (!response.ok || payload === null || payload.ok !== true) {
						throw new Error((payload && payload.error) || ("HTTP " + response.status));
					}
					setSessions(Array.isArray(payload.sessions) ? payload.sessions : []);
				} catch (err) {
					setError("加载失败: " + String((err && err.message) || err));
				} finally {
					setBusy(false);
				}
			}, []);

			if (!loadedRef.current) {
				loadedRef.current = true;
				loadList();
			}

			const analyze = async (id) => {
				setInspecting(id);
				setInspect(null);
				setError(null);
				setMessage(null);
				try {
					const response = await fetch(ROUTE_INSPECT + "?id=" + encodeURIComponent(id), {
						method: "GET",
						headers: { [GUARD_HEADER]: "1" }
					});
					const payload = await response.json().catch(() => null);
					if (!response.ok || payload === null || payload.ok !== true) {
						throw new Error((payload && payload.error) || ("HTTP " + response.status));
					}
					setInspect(payload);
				} catch (err) {
					setError("分析失败: " + String((err && err.message) || err));
					setInspecting(null);
				}
			};

			const backToList = () => {
				setInspecting(null);
				setInspect(null);
				setMessage(null);
			};

			// 回退: 从该回合之后派生新会话并打开
			const rewindAt = async (sessionId, turn) => {
				const boundarySeq = turn.boundarySeq;
				if (boundarySeq === null || boundarySeq === void 0) return;
				const ok = window.confirm(
					"从第 " + turn.turn + " 回合之后「回退」?\n\n" +
					"将派生一个全新的续接会话(携带截至该回合的历史, 等效于移除失败消息之后的内容),\n" +
					"并自动打开新会话。原会话保留不动(可在之后清理)。\n\n" +
					"会话: " + sessionId
				);
				if (!ok) return;
				setWorking(true);
				setMessage(null);
				setError(null);
				try {
					const sessions = getSessions();
					const childId = await sessions.fork({ sessionId, atSeq: boundarySeq, increaseTitle: true });
					setMessage("回退成功! 已派生新会话 " + childId + ", 正在为你打开…");
					try {
						sessions.open(childId);
					} catch (_) { /* 打开失败也不阻塞提示 */ }
					backToList();
					loadList();
				} catch (err) {
					setError("回退失败: " + String((err && err.message) || err));
				} finally {
					setWorking(false);
				}
			};

			const rootStyle = { display: "flex", flexDirection: "column", gap: 12, padding: 4, maxWidth: 1080 };
			const titleStyle = { margin: 0, fontSize: 14, fontWeight: 600 };
			const descStyle = { margin: 0, fontSize: 13, lineHeight: 1.6, color: "#555" };
			const tableStyle = { border: "1px solid #ddd", borderRadius: 4, fontSize: 13, background: "#fff", overflow: "hidden" };
			const thStyle = { padding: "8px 12px", background: "#f5f5f5", borderBottom: "1px solid #ddd", fontWeight: 600, fontSize: 12, color: "#444" };
			const tdStyle = { padding: "8px 12px", borderBottom: "1px solid #eee", verticalAlign: "top" };
			const btn = { padding: "5px 14px", cursor: "pointer", fontSize: 12 };
			const badgeLive = { fontSize: 11, color: "#e67e22", marginLeft: 6 };
			const monoStyle = { fontFamily: "Consolas, Menlo, monospace", fontSize: 11, color: "#999" };

			// ---------- 列表视图 ----------
			if (inspecting === null) {
				return react.createElement("div", { style: rootStyle },
					react.createElement("p", { style: titleStyle }, "会话回退"),
					react.createElement("p", { style: descStyle },
						"当某个会话因插件不兼容等原因出错(例如工具反复报 UNKNOWN_TOOL / 代码执行失败)而无法继续时, " +
						"可对任意会话做「回合分析」, 然后在任意一个已完成的回合上点「回退到此」: " +
						"系统会从该回合之后派生一个干净的续接会话并自动打开, 相当于把失败的消息之后的内容移除, " +
						"继续对话不再受干扰。原会话保留不动。"
					),
					error !== null && react.createElement("p", { style: { color: "#c0392b", margin: 0, fontSize: 13 } }, error),
					sessions === null && !error && react.createElement("p", { style: { color: "#888", margin: 0, fontSize: 13 } }, busy ? "加载中…" : "加载中…"),
					Array.isArray(sessions) && react.createElement("div", { style: tableStyle },
						// 表头: 标题(4) 工作区(2) 创建时间(150) 状态(90) 操作(90)
						react.createElement("div", { style: { display: "flex", alignItems: "center" } },
							react.createElement("span", { style: { flex: 4, ...thStyle } }, "标题 (含完整会话 ID)"),
							react.createElement("span", { style: { flex: 2, ...thStyle } }, "工作区"),
							react.createElement("span", { style: { width: 150, ...thStyle } }, "创建时间"),
							react.createElement("span", { style: { width: 90, ...thStyle } }, "状态"),
							react.createElement("span", { style: { width: 90, ...thStyle, textAlign: "right" } }, "操作")
						),
						sessions.length === 0 && react.createElement("div", { style: { padding: 12, color: "#888" } }, "没有找到任何会话。"),
						sessions.map((s) => react.createElement("div", { key: s.id, style: { display: "flex", alignItems: "flex-start" } },
							// 标题单元格: 标题可换行(最多2行) + 完整会话 ID 单独一行
							react.createElement("div", { style: { flex: 4, ...tdStyle, minWidth: 0 } },
								react.createElement("div", {
									style: { fontSize: 13, fontWeight: 600, lineHeight: 1.45, ...clampStyle(2) },
									title: s.title || "(无标题)"
								}, s.title || "(无标题)"),
								react.createElement("div", { style: { ...monoStyle, marginTop: 3, wordBreak: "break-all", lineHeight: 1.4 } }, s.id),
								s.live && react.createElement("span", { style: badgeLive }, "运行中")
							),
							react.createElement("div", { style: { flex: 2, ...tdStyle, minWidth: 0, fontSize: 12, color: "#666", ...clampStyle(2) }, title: (s.workspace && s.workspace.path) || s.workspaceKey || "" },
								(s.workspace && s.workspace.title) || s.workspaceKey || "—"
							),
							react.createElement("div", { style: { width: 150, ...tdStyle, fontSize: 12, color: "#888" } }, fmtTime(s.createdAt)),
							react.createElement("div", { style: { width: 90, ...tdStyle, fontSize: 12 } },
								s.live ? react.createElement("span", { style: { color: "#e67e22", fontWeight: 600 } }, "运行中") : react.createElement("span", { style: { color: "#999" } }, "空闲")
							),
							react.createElement("div", { style: { width: 90, ...tdStyle, textAlign: "right" } },
								react.createElement("button", {
									type: "button",
									disabled: busy || working,
									onClick: () => analyze(s.id),
									style: btn
								}, inspecting === s.id ? "分析中…" : "分析")
							)
						))
					),
					react.createElement("div", { style: { display: "flex", gap: 10, alignItems: "center" } },
						react.createElement("button", { type: "button", disabled: busy, onClick: loadList, style: { padding: "6px 16px", cursor: busy ? "default" : "pointer" } }, busy ? "刷新中…" : "刷新列表"),
						message !== null && react.createElement("span", { style: { fontSize: 13, color: "#27ae60" } }, message)
					)
				);
			}

			// ---------- 分析视图 ----------
			const data = inspect;
			const s = data && data.session;
			const summary = data && data.summary;
			const turns = data && Array.isArray(data.turns) ? data.turns : [];
			const poisonHints = [];
			if (summary && summary.errorCodes) {
				const codes = summary.errorCodes;
				if (codes.UNKNOWN_TOOL > 0) poisonHints.push("检测到 " + codes.UNKNOWN_TOOL + " 次工具缺失 (UNKNOWN_TOOL) —— 很可能是插件不兼容导致核心工具消失");
				if (codes.CODE_RUN_FAILED > 0) poisonHints.push("检测到 " + codes.CODE_RUN_FAILED + " 次代码执行失败 (CODE_RUN_FAILED)");
			}
			const lastCompleted = [...turns].reverse().find((t) => t.complete);

			return react.createElement("div", { style: rootStyle },
				react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } },
					react.createElement("button", { type: "button", onClick: backToList, style: btn }, "← 返回列表"),
					react.createElement("p", { style: { ...titleStyle, margin: 0, maxWidth: 640 } },
						s && (s.title || "(无标题)"),
						react.createElement("span", { style: { ...monoStyle, marginLeft: 8 } }, s && s.id)
					)
				),
				data === null && react.createElement("p", { style: { color: "#888" } }, "分析中…"),
				error !== null && react.createElement("p", { style: { color: "#c0392b", margin: 0, fontSize: 13 } }, error),
				data !== null && react.createElement(react.Fragment, null,
					react.createElement("div", { style: { display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13, color: "#555" } },
						react.createElement("span", null, "事件数: " + summary.eventCount),
						react.createElement("span", null, "回合: " + summary.totalTurns + " (完成 " + summary.completedTurns + " / 未完成 " + summary.unfinishedTurns + ")"),
						s && s.live && react.createElement("span", { style: badgeLive }, "运行中(此会话当前已打开, 回退后会自动切到新会话)"),
						s && s.cwd && react.createElement("span", { style: { color: "#999", wordBreak: "break-all" } }, s.cwd)
					),
					poisonHints.length > 0 && react.createElement("div", { style: { fontSize: 13, color: "#b8860b", background: "#fdf6e3", borderRadius: 4, padding: "8px 12px", lineHeight: 1.6 } },
						poisonHints.map((h, i) => react.createElement("div", { key: i }, "⚠ " + h))
					),
					summary.unfinishedTurns > 0 && react.createElement("div", { style: { fontSize: 13, color: "#c0392b", background: "#fdecea", borderRadius: 4, padding: "8px 12px", lineHeight: 1.6 } },
						"检测到 " + summary.unfinishedTurns + " 个未完成回合(有开始无结束, 通常是出错/中断留下)。" +
						(lastCompleted
							? "建议回退到最后一个已完成回合(第 " + lastCompleted.turn + " 回合)之后。"
							: "该会话没有任何已完成回合。")
					),
					react.createElement("div", { style: tableStyle },
						// 表头: 回合(64) 用户问题(4) 步骤(56) 调用(64) 错误(2) 状态(90) 操作(100)
						react.createElement("div", { style: { display: "flex", alignItems: "center" } },
							react.createElement("span", { style: { width: 64, ...thStyle } }, "回合"),
							react.createElement("span", { style: { flex: 4, ...thStyle } }, "用户问题 / 摘要"),
							react.createElement("span", { style: { width: 56, ...thStyle } }, "步骤"),
							react.createElement("span", { style: { width: 64, ...thStyle } }, "调用"),
							react.createElement("span", { style: { flex: 2, ...thStyle } }, "错误"),
							react.createElement("span", { style: { width: 90, ...thStyle } }, "状态"),
							react.createElement("span", { style: { width: 100, ...thStyle, textAlign: "right" } }, "操作")
						),
						turns.length === 0 && react.createElement("div", { style: { padding: 12, color: "#888" } }, "该会话还没有任何回合。"),
						turns.map((t) => react.createElement("div", { key: t.turn, style: { display: "flex", alignItems: "flex-start" } },
							react.createElement("div", { style: { width: 64, ...tdStyle, fontSize: 12, fontWeight: 600 } }, "#" + t.turn),
							react.createElement("div", { style: { flex: 4, ...tdStyle, minWidth: 0, fontSize: 12, color: "#333", ...clampStyle(2) }, title: t.userText || "" },
								t.userText || "(无用户消息)"
							),
							react.createElement("div", { style: { width: 56, ...tdStyle, fontSize: 12 } }, t.steps),
							react.createElement("div", { style: { width: 64, ...tdStyle, fontSize: 12 } }, t.toolCalls),
							react.createElement("div", { style: { flex: 2, ...tdStyle, minWidth: 0 } }, errorBadge(t.errors)),
							react.createElement("div", { style: { width: 90, ...tdStyle, fontSize: 12 } },
								t.complete
									? react.createElement("span", { style: { color: "#27ae60", fontWeight: 600 } }, "已完成")
									: react.createElement("span", { style: { color: "#c0392b", fontWeight: 600 } }, "未完成")
							),
							react.createElement("div", { style: { width: 100, ...tdStyle, textAlign: "right" } },
								t.complete && react.createElement("button", {
									type: "button",
									disabled: working,
									onClick: () => rewindAt(s.id, t),
									style: { ...btn, background: "#fff" }
								}, working ? "回退中…" : "回退到此")
							)
						))
					),
					react.createElement("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
						message !== null && react.createElement("span", { style: { fontSize: 13, color: "#27ae60" } }, message),
						react.createElement("span", { style: { fontSize: 12, color: "#999" } }, "提示: 回退 = 从该回合之后派生新会话并自动打开; 原会话保留不动。")
					)
				)
			);
		}

		function apply(ctx) {
			// 延迟取 sessions 服务 (设置页渲染时一定已就绪)
			const getSessions = () => ctx.get("sessions");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "session-rewind",
				order: 510,
				label: "会话回退"
			}, () => react.createElement(RewindSection, { getSessions })));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
