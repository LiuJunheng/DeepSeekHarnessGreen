// DeepSeek Harness 插件 (客户端): dsh-session-rewind
// 在「设置」面板注册一个「会话回退」页面 (卡片式布局, 与 dsh-usage-stats 同风格):
//   1) 会话列表: 每会话一张卡片 —— 标题独占整行完整换行, 下方会话 ID, 再下方元信息 chips
//      (工作区 / 创建时间 / 状态), 右侧「分析」按钮;
//   2) 「分析」视图: 每回合一张卡片 —— 用户问题描述独占整行完整可读, 下方
//      回合号/步骤/工具调用/错误/未完成标记, 已完成回合提供「回退到此」;
//   3) 「回退到此」: 调用官方 session.fork 从该回合之后派生一个干净的续接会话,
//      并自动打开它继续对话 (原会话保留)。
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

		/** 元信息小标签 (label + value, 自动换行, 与用量统计面板同风格) */
		function MetaChip({ label, value, valueStyle }) {
			return react.createElement("span", {
				style: {
					display: "inline-flex",
					alignItems: "baseline",
					gap: 4,
					background: "var(--dsw-alias-bg-layer-2)",
					borderRadius: 4,
					padding: "2px 8px",
					fontSize: 12,
					whiteSpace: "nowrap",
				},
			}, [
				react.createElement("span", { key: "l", style: { color: "var(--dsw-alias-label-tertiary)" } }, label),
				react.createElement("span", { key: "v", style: { fontWeight: 500, color: "var(--dsw-alias-label-primary)", ...(valueStyle || {}) } }, value),
			]);
		}

		/** 错误码徽标组 (红色小胶囊, 可换行) */
		const errorBadge = (errors) => {
			const codes = Object.keys(errors || {});
			if (codes.length === 0) return null;
			return react.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 4 } },
				codes.map((c) =>
					react.createElement("span", {
						key: c,
						title: c + "×" + errors[c],
						style: { fontSize: 11, color: "var(--dsw-alias-state-error-primary)", background: "var(--dsw-alias-state-error-secondary)", borderRadius: 3, padding: "1px 6px", whiteSpace: "nowrap", maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }
					}, c + "×" + errors[c])
				)
			);
		};

		/** 会话卡片 (标题独占整行 + ID + 元信息 chips + 分析按钮) */
		function SessionCard({ s, busy, working, inspecting, onAnalyze }) {
			const cardStyle = {
				border: "1px solid var(--dsw-alias-border-l1)",
				borderRadius: 8,
				padding: "10px 12px",
				background: "var(--dsw-alias-bg-base)",
				marginBottom: 10,
			};
			const titleStyle = {
				flex: 1,
				minWidth: 0,
				fontSize: 13,
				fontWeight: 600,
				color: "var(--dsw-alias-label-primary)",
				lineHeight: 1.5,
				wordBreak: "break-word",
				overflowWrap: "break-word",
			};
			const idStyle = {
				marginTop: 2,
				fontFamily: "Consolas, Menlo, monospace",
				fontSize: 11,
				color: "var(--dsw-alias-label-tertiary)",
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap",
			};
			const chipRowStyle = {
				display: "flex",
				flexWrap: "wrap",
				gap: 6,
				marginTop: 8,
				alignItems: "center",
			};

			return react.createElement("div", { style: cardStyle }, [
				// 第一行: 标题(独占整行剩余宽度) + 运行中徽标 + 分析按钮
				react.createElement("div", { key: "h", style: { display: "flex", alignItems: "center", gap: 8 } }, [
					react.createElement("span", { key: "t", style: titleStyle, title: s.displayTitle || s.id },
						s.displayTitle || "(无标题)"
					),
					s.live && react.createElement("span", { key: "live", style: { flex: "none", fontSize: 11, color: "var(--dsw-alias-state-success-primary)", borderRadius: 999, padding: "1px 7px", whiteSpace: "nowrap" } }, "运行中"),
					react.createElement("button", {
						key: "btn",
						type: "button",
						disabled: busy || working,
						style: { flex: "none", padding: "3px 12px", cursor: busy || working ? "default" : "pointer", fontSize: 12, borderRadius: 4 },
						onClick: () => onAnalyze(s.id),
					}, inspecting === s.id ? "分析中…" : "分析"),
				]),
				// 第二行: 会话 ID (整行, 超长省略, 悬停可见完整)
				react.createElement("div", { key: "id", style: idStyle, title: s.id }, s.id),
				// 第三行: 元信息 chips (自动换行)
				react.createElement("div", { key: "m", style: chipRowStyle }, [
					react.createElement(MetaChip, { key: "ws", label: "工作区", value: (s.workspace && s.workspace.title) || s.workspaceKey || "—" }),
					react.createElement(MetaChip, { key: "ct", label: "创建时间", value: fmtTime(s.createdAt) }),
					react.createElement(MetaChip, { key: "st", label: "状态", value: s.live ? "运行中" : "空闲", valueStyle: { color: s.live ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-label-tertiary)" } }),
				]),
			]);
		}

		/** 逐回合卡片 (用户问题独占整行 + 信息行 + 回退按钮) */
		function TurnCard({ t, working, onRewind }) {
			const cardStyle = {
				border: "1px solid var(--dsw-alias-border-l1)",
				borderRadius: 6,
				padding: "8px 10px",
				background: "var(--dsw-alias-bg-layer-2)",
				marginBottom: 8,
			};

			return react.createElement("div", { style: cardStyle }, [
				// 用户问题描述独占整行, 完整换行显示
				react.createElement("div", {
					key: "q",
					style: {
						fontSize: 12.5,
						lineHeight: 1.6,
						color: "var(--dsw-alias-label-primary)",
						wordBreak: "break-word",
						overflowWrap: "break-word",
					},
					title: t.userText || "",
				}, t.userText || "(无用户消息)"),
				// 信息行: 回合号/步骤/工具调用 + 错误/未完成 + 回退按钮 (自动换行)
				react.createElement("div", {
					key: "info",
					style: {
						marginTop: 6,
						display: "flex",
						alignItems: "center",
						flexWrap: "wrap",
						gap: "4px 12px",
						fontSize: 11.5,
						color: "var(--dsw-alias-label-secondary)",
					},
				}, [
					react.createElement("span", { key: "turn", style: { fontWeight: 600, color: t.complete ? "var(--dsw-alias-label-secondary)" : "var(--dsw-alias-state-error-primary)" } }, "回合 #" + t.turn),
					react.createElement("span", { key: "steps" }, "步骤 " + t.steps),
					react.createElement("span", { key: "tools" }, "工具调用 " + t.toolCalls),
					!t.complete && react.createElement("span", { key: "unfin", style: { fontSize: 11, color: "var(--dsw-alias-state-error-primary)", background: "var(--dsw-alias-state-error-secondary)", borderRadius: 3, padding: "1px 6px", fontWeight: 600, whiteSpace: "nowrap" } }, "⚠ 未完成"),
					errorBadge(t.errors),
					t.complete && react.createElement("button", {
						key: "btn",
						type: "button",
						disabled: working,
						onClick: () => onRewind(t),
						style: { marginLeft: "auto", padding: "3px 12px", cursor: working ? "default" : "pointer", fontSize: 12, borderRadius: 4, background: "var(--dsw-alias-bg-base)" },
					}, working ? "回退中…" : "回退到此"),
				]),
			]);
		}

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
			const descStyle = { margin: 0, fontSize: 13, lineHeight: 1.6, color: "var(--dsw-alias-label-secondary)" };
			const btn = { padding: "4px 10px", cursor: "pointer", fontSize: 12 };
			const monoStyle = { fontFamily: "Consolas, Menlo, monospace", fontSize: 11, color: "var(--dsw-alias-label-tertiary)" };

			// ---------- 列表视图 (卡片式) ----------
			if (inspecting === null) {
				return react.createElement("div", { style: rootStyle },
					react.createElement("p", { style: titleStyle }, "会话回退"),
					react.createElement("p", { style: descStyle },
						"当某个会话因插件不兼容等原因出错(例如工具反复报 UNKNOWN_TOOL / 代码执行失败)而无法继续时, " +
						"可对任意会话做「回合分析」, 然后在任意一个已完成的回合上点「回退到此」: " +
						"系统会从该回合之后派生一个干净的续接会话并自动打开, 相当于把失败的消息之后的内容移除, " +
						"继续对话不再受干扰。原会话保留不动。"
					),
					error !== null && react.createElement("p", { style: { color: "var(--dsw-alias-state-error-primary)", margin: 0, fontSize: 13 } }, error),
					sessions === null && !error && react.createElement("p", { style: { color: "var(--dsw-alias-label-tertiary)", margin: 0, fontSize: 13 } }, "加载中…"),
					Array.isArray(sessions) && sessions.length === 0 && !error && react.createElement("p", { style: { color: "var(--dsw-alias-label-tertiary)", margin: 0, fontSize: 13 } }, "没有找到任何会话。"),
					Array.isArray(sessions) && sessions.map((s) =>
						react.createElement(SessionCard, {
							key: s.id,
							s,
							busy,
							working,
							inspecting,
							onAnalyze: analyze,
						})
					),
					react.createElement("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
						react.createElement("button", { type: "button", disabled: busy, onClick: loadList, style: { padding: "6px 16px", cursor: busy ? "default" : "pointer" } }, busy ? "刷新中…" : "刷新列表"),
						message !== null && react.createElement("span", { style: { fontSize: 13, color: "var(--dsw-alias-state-success-primary)" } }, message)
					)
				);
			}

			// ---------- 分析视图 (逐回合卡片式) ----------
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
					react.createElement("p", { style: { ...titleStyle, margin: 0, minWidth: 0, flex: 1, wordBreak: "break-word" } },
						s && (s.displayTitle || "(无标题)"),
						react.createElement("span", { style: { ...monoStyle, marginLeft: 8 } }, s && s.id)
					)
				),
				data === null && react.createElement("p", { style: { color: "var(--dsw-alias-label-tertiary)" } }, "分析中…"),
				error !== null && react.createElement("p", { style: { color: "var(--dsw-alias-state-error-primary)", margin: 0, fontSize: 13 } }, error),
				data !== null && react.createElement(react.Fragment, null,
					// 会话汇总 chips (自动换行)
					react.createElement("div", { style: { display: "flex", flexWrap: "wrap", gap: 6 } }, [
						react.createElement(MetaChip, { key: "ev", label: "事件数", value: summary.eventCount }),
						react.createElement(MetaChip, { key: "turn", label: "回合", value: summary.totalTurns + " (完成 " + summary.completedTurns + " / 未完成 " + summary.unfinishedTurns + ")" }),
						s && s.live && react.createElement(MetaChip, { key: "live", label: "状态", value: "运行中 (回退后自动切到新会话)", valueStyle: { color: "var(--dsw-alias-state-success-primary)" } }),
						s && s.cwd && react.createElement(MetaChip, { key: "cwd", label: "工作区路径", value: s.cwd, valueStyle: { fontFamily: "Consolas, Menlo, monospace", fontSize: 11 } }),
					]),
					poisonHints.length > 0 && react.createElement("div", { style: { fontSize: 13, color: "var(--dsw-alias-state-warn-primary)", background: "var(--dsw-alias-state-warn-secondary)", borderRadius: 4, padding: "8px 12px", lineHeight: 1.6 } },
						poisonHints.map((h, i) => react.createElement("div", { key: i }, "⚠ " + h))
					),
					summary.unfinishedTurns > 0 && react.createElement("div", { style: { fontSize: 13, color: "var(--dsw-alias-state-error-primary)", background: "var(--dsw-alias-state-error-secondary)", borderRadius: 4, padding: "8px 12px", lineHeight: 1.6 } },
						"检测到 " + summary.unfinishedTurns + " 个未完成回合(有开始无结束, 通常是出错/中断留下)。" +
						(lastCompleted
							? "建议回退到最后一个已完成回合(第 " + lastCompleted.turn + " 回合)之后。"
							: "该会话没有任何已完成回合。")
					),
					turns.length === 0 && react.createElement("p", { style: { color: "var(--dsw-alias-label-tertiary)", margin: 0, fontSize: 13 } }, "该会话还没有任何回合。"),
					turns.map((t) =>
						react.createElement(TurnCard, {
							key: t.turn,
							t,
							working,
							onRewind: () => rewindAt(s.id, t),
						})
					),
					react.createElement("div", { style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } },
						message !== null && react.createElement("span", { style: { fontSize: 13, color: "var(--dsw-alias-state-success-primary)" } }, message),
						react.createElement("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } }, "提示: 回退 = 从该回合之后派生新会话并自动打开; 原会话保留不动。")
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
