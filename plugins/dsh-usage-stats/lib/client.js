// DeepSeek Harness 插件 (客户端): dsh-usage-stats
// 两个功能面, 一个插件统一安装/卸载:
//   1) 「设置」面板的「用量统计」页:
//      总览卡片 (全会话 token 合计 / 估算费用 / 按模型分布) +
//      可编辑价格表 (localStorage 持久化, 用于费用估算) +
//      会话列表 (卡片式: 标题/ID 独占整行, 元信息换行排列) +
//      逐回合明细 (卡片式: 用户消息独占整行可完整阅读, 其余信息在其下方)。
//      数据通过 fetch 调用宿主端路由 /__dsh/usage-stats/* (带自定义头防跨站)。
//   2) 对话消息行的「本次token」显示:
//      每条已完成助手消息的操作行上方 (conversation.chat.turnTail 链式插槽),
//      常驻显示该回合实际消耗的 token: 输入 / 输出 / 缓存 / 思考(推理)。
//      数据来源: 会话快照中本回合所有 assistant/message 节点的 usage 求和。
// 费用 = 各 token 数 / 1e6 × 对应单价, 单价表在页面内可编辑, 仅供估算。
// 这是加载器契约格式 (window.__ModuleLoader__.load), 与官方客户端插件一致。
// 注意: 不修改任何官方文件/包; 样式用内联对象。

window.__ModuleLoader__.load({
	id: "dsh-usage-stats",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const inject = ["slots"];

		const ROUTE_LIST = "/__dsh/usage-stats/list";
		const ROUTE_DETAIL = "/__dsh/usage-stats/detail";
		const GUARD_HEADER = "X-DSH-Usage-Stats";
		const PRICES_KEY = "dsh.usageStats.prices.v3";

		/**
		 * 默认价格表 (单位: 元 / 每百万 tokens)。
		 * 参考 DeepSeek 官方定价 (api-docs.deepseek.com/zh-cn/quick_start/pricing/, 2026-08-17 抓取),
		 * 默认取【高峰时段】价格 (北京时间 9:00-12:00 / 14:00-18:00, 高峰为低谷 2 倍):
		 *   deepseek-v4-flash: 输入命中缓存 0.10 / 未命中 3.0 / 输出 9.0
		 *   deepseek-v4-pro:   输入命中缓存 0.30 / 未命中 9.0 / 输出 27.0
		 * 注: 官方自 2026-08-17 起改为峰谷定价; 本表默认高峰价, 费用估算偏保守,
		 * 用户可自行按实际价格/时段修改 (前端价格表可编辑并保存)。
		 * 字段: miss=输入未命中缓存, hit=输入命中缓存, out=输出。
		 */
		const DEFAULT_PRICES = {
			models: {
				"deepseek-v4-flash": { miss: 3.0, hit: 0.10, out: 9.0 },
				"deepseek-v4-pro": { miss: 9.0, hit: 0.30, out: 27.0 },
			},
			fallback: { miss: 3.0, hit: 0.10, out: 9.0 },
		};

		// ---- 工具 ----

		function fmtInt(n) {
			if (typeof n !== "number" || !isFinite(n)) return "0";
			return n.toLocaleString("zh-CN");
		}

		function fmtCost(n) {
			if (typeof n !== "number" || !isFinite(n)) return "¥0.0000";
			return "¥" + n.toFixed(4);
		}

		function fmtTime(ms) {
			if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "—";
			try {
				return new Date(ms).toLocaleString("zh-CN", { hour12: false });
			} catch (e) {
				return String(ms);
			}
		}

		/** 友好格式: 1234 -> 1.2k, 2345678 -> 2.3M (消息行「本次token」显示用) */
		function fmtTokens(n) {
			if (typeof n !== "number" || !isFinite(n) || n <= 0) return null;
			if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, "") + "M";
			if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
			return String(Math.round(n));
		}

		/** 读取价格表 (localStorage), 解析失败回退默认 */
		function loadPrices() {
			try {
				const raw = localStorage.getItem(PRICES_KEY);
				if (raw) {
					const parsed = JSON.parse(raw);
					if (parsed && typeof parsed === "object" && parsed.models && parsed.fallback) {
						return parsed;
					}
				}
			} catch (e) { /* ignore */ }
			return JSON.parse(JSON.stringify(DEFAULT_PRICES));
		}

		function savePrices(prices) {
			try {
				localStorage.setItem(PRICES_KEY, JSON.stringify(prices));
				return true;
			} catch (e) {
				return false;
			}
		}

		/** 取某模型的单价 (缺失用 fallback) */
		function priceOf(prices, model) {
			const p = prices.models[model] || prices.fallback;
			return {
				miss: num(p.miss),
				hit: num(p.hit),
				out: num(p.out),
			};
		}

		function num(v) {
			const n = typeof v === "number" ? v : parseFloat(v);
			return Number.isFinite(n) && n >= 0 ? n : 0;
		}

		/**
		 * 按单价估算一次用量的费用 (对齐 DeepSeek 官方计费口径):
		 *   费用 = 输入(未命中缓存) × 未命中单价 + 输入(命中缓存) × 命中单价 + 输出 × 输出单价
		 *   其中输入未命中 = inputTokens + cacheWriteTokens (首次写入缓存的输入按未命中价计费);
		 *   思考(reasoning) token 已计入 outputTokens, 不重复计费。
		 */
		function costOf(usage, prices, model) {
			if (!usage) return 0;
			const p = priceOf(prices, model);
			return (
				((num(usage.inputTokens) + num(usage.cacheWriteTokens)) / 1e6) * p.miss +
				(num(usage.cacheReadTokens) / 1e6) * p.hit +
				(num(usage.outputTokens) / 1e6) * p.out
			);
		}

		/** 汇总一个 models 表 (模型 -> usage): 返回合计 usage 与费用 */
		function sumModels(models, prices) {
			const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 0 };
			let cost = 0;
			if (models && typeof models === "object") {
				for (const model of Object.keys(models)) {
					const u = models[model];
					for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "calls"]) {
						if (typeof u[k] === "number") total[k] += u[k];
					}
					cost += costOf(u, prices, model);
				}
			}
			return { total, cost };
		}

		async function getJson(path) {
			const response = await fetch(path, { headers: { [GUARD_HEADER]: "1" } });
			const payload = await response.json().catch(() => null);
			if (!response.ok || payload === null || payload.ok !== true) {
				throw new Error((payload && payload.error) || ("HTTP " + response.status));
			}
			return payload;
		}

		// ---- 价格表编辑 ----

		function PriceEditor({ prices, setPrices, onChange }) {
			const [draft, setDraft] = react.useState(prices);
			const [newName, setNewName] = react.useState("");
			const [newMiss, setNewMiss] = react.useState("");
			const [newHit, setNewHit] = react.useState("");
			const [newOut, setNewOut] = react.useState("");

			const setRow = (model, field, value) => {
				setDraft((prev) => ({
					...prev,
					models: { ...prev.models, [model]: { ...(prev.models[model] || prev.fallback), [field]: value } },
				}));
			};
			const setFallback = (field, value) => {
				setDraft((prev) => ({ ...prev, fallback: { ...prev.fallback, [field]: value } }));
			};

			const save = () => {
				const next = {
					models: {},
					fallback: { miss: num(draft.fallback.miss), hit: num(draft.fallback.hit), out: num(draft.fallback.out) },
				};
				for (const model of Object.keys(draft.models)) {
					next.models[model] = { miss: num(draft.models[model].miss), hit: num(draft.models[model].hit), out: num(draft.models[model].out) };
				}
				savePrices(next);
				setPrices(next);
				onChange(next);
			};

			const addModel = () => {
				const name = newName.trim();
				if (!name) return;
				setDraft((prev) => ({
					...prev,
					models: { ...prev.models, [name]: { miss: num(newMiss), hit: num(newHit), out: num(newOut) } },
				}));
				setNewName("");
				setNewMiss("");
				setNewHit("");
				setNewOut("");
			};

			const removeModel = (model) => {
				setDraft((prev) => {
					const next = { ...prev, models: { ...prev.models } };
					delete next.models[model];
					return next;
				});
			};

			const reset = () => {
				const def = JSON.parse(JSON.stringify(DEFAULT_PRICES));
				savePrices(def);
				setDraft(def);
				setPrices(def);
				onChange(def);
			};

			const inputStyle = {
				width: 64,
				padding: "3px 6px",
				border: "1px solid #d0d0d0",
				borderRadius: 4,
				fontSize: 12,
				textAlign: "right",
			};
			const th = { padding: "6px 10px", textAlign: "left", fontSize: 12, color: "#555555", borderBottom: "1px solid #e6e6e6" };
			// 价格表卡片背景固定浅色 (#ffffff)，表格内文字必须固定深色，否则深色主题下会继承页面白字、白字落白底看不清
			const td = { padding: "4px 10px", fontSize: 12, color: "#1f1f1f" };

			return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } }, [
				react.createElement("table", { key: "tbl", style: { borderCollapse: "collapse", width: "100%", maxWidth: 560 } }, [
					react.createElement("thead", { key: "h" },
						react.createElement("tr", { key: "r" },
							react.createElement("th", { style: th }, "模型"),
							react.createElement("th", { style: { ...th, textAlign: "right" } }, "输入(未命中) ¥/M"),
							react.createElement("th", { style: { ...th, textAlign: "right" } }, "输入(命中缓存) ¥/M"),
							react.createElement("th", { style: { ...th, textAlign: "right" } }, "输出 ¥/M"),
							react.createElement("th", { style: { ...th, width: 40 } }, "")
						)
					),
					react.createElement("tbody", { key: "b" }, [
						Object.keys(draft.models).map((model) =>
							react.createElement("tr", { key: model },
								react.createElement("td", { style: { ...td, fontFamily: "Consolas, Menlo, monospace" } }, model),
								react.createElement("td", { style: td },
									react.createElement("input", { type: "number", min: 0, step: "0.01", style: inputStyle, value: draft.models[model].miss, onChange: (e) => setRow(model, "miss", e.target.value) })
								),
								react.createElement("td", { style: td },
									react.createElement("input", { type: "number", min: 0, step: "0.01", style: inputStyle, value: draft.models[model].hit, onChange: (e) => setRow(model, "hit", e.target.value) })
								),
								react.createElement("td", { style: td },
									react.createElement("input", { type: "number", min: 0, step: "0.01", style: inputStyle, value: draft.models[model].out, onChange: (e) => setRow(model, "out", e.target.value) })
								),
								react.createElement("td", { style: td },
									react.createElement("button", { type: "button", style: { fontSize: 11, cursor: "pointer", color: "#c0392b", border: "none", background: "transparent" }, onClick: () => removeModel(model) }, "删")
								)
							)
						),
						react.createElement("tr", { key: "__fallback__" },
							react.createElement("td", { style: { ...td, fontWeight: 600 } }, "其他模型（兜底）"),
							react.createElement("td", { style: td },
								react.createElement("input", { type: "number", min: 0, step: "0.01", style: inputStyle, value: draft.fallback.miss, onChange: (e) => setFallback("miss", e.target.value) })
							),
							react.createElement("td", { style: td },
								react.createElement("input", { type: "number", min: 0, step: "0.01", style: inputStyle, value: draft.fallback.hit, onChange: (e) => setFallback("hit", e.target.value) })
							),
							react.createElement("td", { style: td },
								react.createElement("input", { type: "number", min: 0, step: "0.01", style: inputStyle, value: draft.fallback.out, onChange: (e) => setFallback("out", e.target.value) })
							),
							react.createElement("td", { style: td }, "")
						),
						react.createElement("tr", { key: "__add__" },
							react.createElement("td", { style: td },
								react.createElement("input", { type: "text", placeholder: "新模型名", style: { ...inputStyle, width: 140, textAlign: "left" }, value: newName, onChange: (e) => setNewName(e.target.value) })
							),
							react.createElement("td", { style: td }, react.createElement("input", { type: "number", min: 0, step: "0.01", placeholder: "未命中", style: inputStyle, value: newMiss, onChange: (e) => setNewMiss(e.target.value) })),
							react.createElement("td", { style: td }, react.createElement("input", { type: "number", min: 0, step: "0.01", placeholder: "命中", style: inputStyle, value: newHit, onChange: (e) => setNewHit(e.target.value) })),
							react.createElement("td", { style: td }, react.createElement("input", { type: "number", min: 0, step: "0.01", placeholder: "输出", style: inputStyle, value: newOut, onChange: (e) => setNewOut(e.target.value) })),
							react.createElement("td", { style: td },
								react.createElement("button", { type: "button", style: { fontSize: 11, cursor: "pointer" }, onClick: addModel }, "添加")
							)
						),
					]),
				]),
				react.createElement("div", { key: "btns", style: { display: "flex", gap: 8, flexWrap: "wrap" } }, [
					react.createElement("button", { key: "save", type: "button", style: { padding: "4px 14px", cursor: "pointer", fontSize: 12 }, onClick: save }, "保存价格"),
					react.createElement("button", { key: "reset", type: "button", style: { padding: "4px 14px", cursor: "pointer", fontSize: 12 }, onClick: reset }, "恢复默认"),
					react.createElement("span", { key: "tip", style: { fontSize: 11, color: "#8a8f98", alignSelf: "center" } },
						"单价 = 元 / 每百万 tokens；费用 = 输入(未命中)×单价 + 输入(命中)×单价 + 输出×单价，思考 token 已计入输出不重复计费；默认按 DeepSeek 官方高峰时段价（北京 9:00-12:00 / 14:00-18:00，高峰为低谷 2 倍），请按实际价格/时段修改"
					),
				]),
			]);
		}

		// ---- 主面板 ----

		/** 元信息小标签 (label + value, 自动换行)。
		 *  背景框固定浅灰底、文字固定深色，不随主题变化（因为背景框颜色不会变，
		 *  若文字随主题变白会在白框上不可读）。 */
		function MetaChip({ label, value, valueStyle }) {
			return react.createElement("span", {
				style: {
					display: "inline-flex",
					alignItems: "baseline",
					gap: 4,
					background: "#f5f5f5",
					borderRadius: 4,
					padding: "2px 8px",
					fontSize: 12,
					whiteSpace: "nowrap",
				},
			}, [
				react.createElement("span", { key: "l", style: { color: "#8a8f98" } }, label),
				react.createElement("span", { key: "v", style: { fontWeight: 500, color: "#2f3540", ...(valueStyle || {}) } }, value),
			]);
		}

		/** 单个会话卡片 (标题独占一行, 下方元信息 chips, 明细在卡片内展开) */
		function SessionCard({ session, prices, detail, detailBusy, onToggleDetail }) {
			const s = session;
			const sum = sumModels(s.models, prices);
			const expanded = detail && detail.id === s.id;

			const cardStyle = {
				border: "1px solid #dddddd",
				borderRadius: 8,
				padding: "10px 12px",
				background: "#ffffff",
				marginBottom: 10,
			};
			const titleStyle = {
				flex: 1,
				minWidth: 0,
				fontSize: 13,
				fontWeight: 600,
				color: "#1f1f1f",
				lineHeight: 1.5,
				wordBreak: "break-word",
				overflowWrap: "break-word",
			};
			const idStyle = {
				marginTop: 2,
				fontFamily: "Consolas, Menlo, monospace",
				fontSize: 11,
				color: "#8a8f98",
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
			const badgeStyle = {
				flex: "none",
				fontSize: 11,
				padding: "1px 7px",
				borderRadius: 999,
				whiteSpace: "nowrap",
			};

			return react.createElement("div", { key: "card", style: cardStyle }, [
				// 第一行: 标题(独占整行剩余宽度) + 徽标 + 明细按钮
				react.createElement("div", { key: "h", style: { display: "flex", alignItems: "center", gap: 8 } }, [
					react.createElement("span", { key: "t", style: titleStyle, title: s.title || s.id },
						s.title || "(无标题)"
					),
					s.live && react.createElement("span", { key: "live", style: { ...badgeStyle, color: "#e67e22", background: "#fdf3e3" } }, "运行中"),
					s.error && react.createElement("span", { key: "err", style: { ...badgeStyle, color: "#c0392b", background: "#fdecea" } }, "解码失败"),
					react.createElement("button", {
						key: "btn",
						type: "button",
						disabled: !!s.error || detailBusy,
						style: {
							flex: "none",
							padding: "3px 12px",
							cursor: detailBusy ? "default" : "pointer",
							fontSize: 12,
							borderRadius: 4,
						},
						onClick: () => onToggleDetail(s.id),
					}, expanded ? "收起" : (detailBusy ? "加载中…" : "明细")),
				]),
				// 第二行: 会话 ID (整行, 超长省略, 悬停可见完整)
				react.createElement("div", { key: "id", style: idStyle, title: s.id }, s.id),
				// 第三行: 元信息 chips (自动换行)
				react.createElement("div", { key: "m", style: chipRowStyle }, [
					react.createElement(MetaChip, { key: "ws", label: "工作区", value: (s.workspace && s.workspace.title) || "—" }),
					react.createElement(MetaChip, { key: "tc", label: "回合", value: fmtInt(s.turnCount) }),
					react.createElement(MetaChip, { key: "in", label: "输入", value: fmtInt(sum.total.inputTokens) }),
					react.createElement(MetaChip, { key: "out", label: "输出", value: fmtInt(sum.total.outputTokens) }),
					react.createElement(MetaChip, { key: "cache", label: "缓存", value: fmtInt(sum.total.cacheReadTokens + sum.total.cacheWriteTokens) }),
					react.createElement(MetaChip, { key: "cost", label: "估算费用", value: fmtCost(sum.cost), valueStyle: { fontWeight: 700 } }),
				]),
				// 明细展开区
				expanded && react.createElement(DetailBody, {
					key: "detail",
					detail: detail.data,
					prices,
					session: s,
				}),
			]);
		}

		/** 会话明细: 汇总行 + 逐回合卡片 (用户消息独占整行)。
		 *  卡片内文字固定深色（背景框固定浅色，不随主题变化）。 */
		function DetailBody({ detail, prices, session }) {
			const d = detail;
			const bodyStyle = {
				marginTop: 10,
				borderTop: "1px solid #e6e6e6",
				paddingTop: 10,
			};

			if (d === null) {
				return react.createElement("div", { style: { ...bodyStyle, color: "#8a8f98", fontSize: 12 } }, "加载中…");
			}
			if (d.error) {
				return react.createElement("div", { style: { ...bodyStyle, color: "#c0392b", fontSize: 12 } }, "明细加载失败: " + d.error);
			}

			const dSum = sumModels(d.totals && d.totals.models, prices);
			const models = (d.totals && d.totals.models) || {};
			const modelNames = Object.keys(models);

			// 汇总 chips
			const metaChips = [
				react.createElement(MetaChip, { key: "tc", label: "回合", value: fmtInt(d.turnCount) }),
				react.createElement(MetaChip, { key: "mc", label: "助手消息", value: fmtInt(d.messageCount) }),
				react.createElement(MetaChip, { key: "out", label: "输出 tokens", value: fmtInt(dSum.total.outputTokens) }),
				react.createElement(MetaChip, { key: "cost", label: "估算费用", value: fmtCost(dSum.cost), valueStyle: { fontWeight: 700 } }),
			];
			if (d.session && d.session.createdAt) {
				metaChips.push(react.createElement(MetaChip, { key: "ct", label: "创建于", value: fmtTime(d.session.createdAt) }));
			}

			// 逐回合卡片
			const turnBlocks = [];
			(d.turns || []).forEach((t, ti) => {
				const tSum = sumModels(t.models, prices);
				const turnModels = Object.keys(t.models || {}).join(", ") || "—";
				turnBlocks.push(
					react.createElement("div", {
						key: ti,
						style: {
							border: "1px solid #dddddd",
							borderRadius: 6,
							padding: "8px 10px",
							background: "#fafafa",
							marginBottom: 8,
						},
					}, [
						// 用户消息独占整行, 完整换行显示
						react.createElement("div", {
							key: "msg",
							style: {
								fontSize: 12.5,
								lineHeight: 1.6,
								color: "#1f1f1f",
								wordBreak: "break-word",
								overflowWrap: "break-word",
							},
						}, t.userText || "（无文本 / 命令）"),
						// 下方: 回合信息 (自动换行)
						react.createElement("div", {
							key: "info",
							style: {
								marginTop: 6,
								display: "flex",
								flexWrap: "wrap",
								gap: "2px 12px",
								fontSize: 11.5,
								color: "#555555",
							},
						}, [
							react.createElement("span", { key: "turn", style: { fontWeight: 600, color: "#555555" } }, "回合 #" + t.turn),
							react.createElement("span", { key: "steps" }, "步骤 " + fmtInt(t.steps)),
							react.createElement("span", { key: "tools" }, "工具调用 " + fmtInt(t.toolCalls)),
							react.createElement("span", { key: "out" }, "输出 tk " + fmtInt(tSum.total.outputTokens)),
							react.createElement("span", { key: "cost", style: { fontWeight: 600, color: "#555555" } }, "估算 " + fmtCost(tSum.cost)),
							react.createElement("span", { key: "model", style: { fontFamily: "Consolas, Menlo, monospace", color: "#8a8f98" } }, turnModels),
							react.createElement("span", {
								key: "status",
								style: { color: t.complete ? "#1a7f37" : "#b25e00", fontWeight: 600 },
							}, t.complete ? "完成" : "未完"),
						]),
					])
				);
			});

			return react.createElement("div", { style: bodyStyle }, [
				react.createElement("div", { key: "meta", style: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 } }, metaChips),
				modelNames.length > 0 && react.createElement("div", {
					key: "models",
					style: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 },
				}, modelNames.map((model) =>
					react.createElement(MetaChip, {
						key: model,
						label: model,
						value: "入 " + fmtInt(models[model].inputTokens) + " · 出 " + fmtInt(models[model].outputTokens) + " · 缓存 " + fmtInt(models[model].cacheReadTokens + models[model].cacheWriteTokens) + " · 估 " + fmtCost(costOf(models[model], prices, model)),
						valueStyle: { fontFamily: "Consolas, Menlo, monospace", fontSize: 11 },
					})
				)),
				turnBlocks.length === 0 && react.createElement("div", { key: "empty", style: { color: "#8a8f98", fontSize: 12, padding: "4px 0" } }, "没有回合数据。"),
				turnBlocks,
			]);
		}

		function UsageStatsSection() {
			const [sessions, setSessions] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [prices, setPrices] = react.useState(null);
			const [detail, setDetail] = react.useState(null);
			const [detailBusy, setDetailBusy] = react.useState(false);
			const loadedRef = react.useRef(false);

			if (prices === null) {
				setPrices(loadPrices());
			}

			const loadList = react.useCallback(async () => {
				setBusy(true);
				setError(null);
				try {
					const payload = await getJson(ROUTE_LIST);
					setSessions(Array.isArray(payload.sessions) ? payload.sessions : []);
					setDetail(null);
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

			const toggleDetail = async (sessionId) => {
				if (detail && detail.id === sessionId) {
					setDetail(null);
					return;
				}
				setDetailBusy(true);
				setDetail({ id: sessionId, data: null });
				try {
					const payload = await getJson(ROUTE_DETAIL + "?id=" + encodeURIComponent(sessionId));
					setDetail({ id: sessionId, data: payload });
				} catch (err) {
					setDetail({ id: sessionId, data: { error: String((err && err.message) || err) } });
				} finally {
					setDetailBusy(false);
				}
			};

			// ---- 样式 ----
			const rootStyle = { display: "flex", flexDirection: "column", gap: 12, padding: 4, maxWidth: 1080 };
			const titleStyle = { margin: 0, fontSize: 14, fontWeight: 600, color: "var(--dsw-alias-label-primary)" };
			const descStyle = { margin: 0, fontSize: 13, lineHeight: 1.6, color: "var(--dsw-alias-label-secondary)" };
			const cardStyle = { border: "1px solid #dddddd", borderRadius: 6, padding: "10px 12px", background: "#ffffff" };
			const btn = { padding: "4px 10px", cursor: "pointer", fontSize: 12 };

			// ---- 总览 (全会话合计) ----
			const overview = react.useMemo(() => {
				if (!Array.isArray(sessions)) return null;
				const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 0 };
				let cost = 0;
				let turnCount = 0;
				const perModel = {};
				for (const s of sessions) {
					if (!s || typeof s !== "object") continue;
					turnCount += (typeof s.turnCount === "number" ? s.turnCount : 0);
					if (s.models && typeof s.models === "object") {
						for (const model of Object.keys(s.models)) {
							const u = s.models[model];
							if (!perModel[model]) perModel[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 0 };
							for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "calls"]) {
								if (typeof u[k] === "number") {
									total[k] += u[k];
									perModel[model][k] += u[k];
								}
							}
							cost += costOf(u, prices, model);
						}
					}
				}
				return { total, cost, turnCount, perModel };
			}, [sessions, prices]);

			const statCell = (label, value) =>
				react.createElement("div", { key: label, style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 96 } }, [
					react.createElement("span", { key: "l", style: { fontSize: 11, color: "#8a8f98" } }, label),
					react.createElement("span", { key: "v", style: { fontSize: 16, fontWeight: 600, color: "#1f1f1f" } }, value),
				]);

			// ---- 会话列表 (卡片式) ----
			const sessionCards = [];
			if (Array.isArray(sessions)) {
				sessions.forEach((s, idx) => {
					sessionCards.push(
						react.createElement(SessionCard, {
							key: s.id || idx,
							session: s,
							prices,
							detail,
							detailBusy,
							onToggleDetail: toggleDetail,
						})
					);
				});
			}

			return react.createElement("div", { style: rootStyle }, [
				react.createElement("p", { key: "title", style: titleStyle }, "用量统计"),
				react.createElement("p", { key: "desc", style: descStyle },
					"扫描本机全部会话日志，按模型汇总每次模型调用的 token 用量（输入 / 输出 / 缓存读取 / 缓存写入 / 思考推理）。" +
					"费用按 DeepSeek 官方计费口径估算：输入（未命中缓存）+ 输入（命中缓存）+ 输出，各自 ÷1e6 × 单价；思考 token 已计入输出、不重复计费。" +
					"价格表可在下方编辑并保存（仅存于本浏览器，默认按官方高峰时段价，请按实际价格/时段修改）。" +
					"当前服务运行中的会话可能仍在写入，统计为截至刷新时的数据。"
				),

				error !== null && react.createElement("p", { key: "err", style: { color: "var(--dsw-alias-state-error-primary)", margin: 0, fontSize: 13 } }, error),

				// 总览
				overview !== null && react.createElement("div", { key: "ov", style: cardStyle }, [
					react.createElement("div", { key: "row1", style: { display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 8 } }, [
						statCell("会话数", fmtInt(sessions.length)),
						statCell("回合总数", fmtInt(overview.turnCount)),
						statCell("输入 tokens", fmtInt(overview.total.inputTokens)),
						statCell("输出 tokens", fmtInt(overview.total.outputTokens)),
						statCell("缓存读取", fmtInt(overview.total.cacheReadTokens)),
						statCell("缓存写入", fmtInt(overview.total.cacheWriteTokens)),
						statCell("思考推理", fmtInt(overview.total.reasoningTokens)),
						statCell("估算费用", fmtCost(overview.cost)),
					]),
					react.createElement("div", { key: "row2", style: { display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: "#555555" } },
						Object.keys(overview.perModel).map((model) =>
							react.createElement("span", { key: model, style: { fontFamily: "Consolas, Menlo, monospace" } },
								model + ": 入 " + fmtInt(overview.perModel[model].inputTokens) +
								" / 出 " + fmtInt(overview.perModel[model].outputTokens) +
								" / 缓存 " + fmtInt(overview.perModel[model].cacheReadTokens + overview.perModel[model].cacheWriteTokens) +
								" / 估 " + fmtCost(costOf(overview.perModel[model], prices, model))
							)
						)
					),
				]),

				// 价格表 (可折叠)
				react.createElement("details", { key: "prices", style: cardStyle }, [
					react.createElement("summary", { key: "s", style: { cursor: "pointer", fontWeight: 600, fontSize: 13, color: "#1f1f1f" } }, "价格表（费用估算用）"),
					react.createElement("div", { key: "b", style: { marginTop: 8 } },
						prices !== null && react.createElement(PriceEditor, { prices, setPrices, onChange: (next) => setPrices(next) })
					),
				]),

				// 会话列表 (卡片式, 标题独占一行)
				react.createElement("div", { key: "list" }, [
					sessions === null && !error && react.createElement("div", { key: "loading", style: { padding: 12, color: "var(--dsw-alias-label-tertiary)" } }, "加载中…"),
					Array.isArray(sessions) && sessions.length === 0 && !error && react.createElement("div", { key: "empty", style: { padding: 12, color: "var(--dsw-alias-label-tertiary)" } }, "没有找到任何会话。"),
					sessionCards,
				]),

				// 操作行
				react.createElement("div", { key: "ops", style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } }, [
					react.createElement("button", { key: "refresh", type: "button", disabled: busy, onClick: loadList, style: { ...btn, padding: "6px 16px" } },
						busy ? "扫描中…" : "刷新统计"
					),
					react.createElement("span", { key: "tip", style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } }, "日志较大时会话多时扫描可能需要几秒"),
				]),
			]);
		}

		// ---- 消息行「本次token」显示 (conversation.chat.turnTail 链式插槽) ----

		/**
		 * 汇总某个回合所有助手消息的 usage。
		 * 数据源: 会话快照顶层兼容字段 snapshot.nodes 里的 AssistantMessageNode
		 * (kind === "assistant", 带 turn 与 usage)。
		 * 返回: 该回合汇总 totals + perModel (按模型分组的 usage, 用于按模型分别计价,
		 * 模型名取节点 provenance.model, 缺失归 "unknown")。
		 */
		function sumTurnUsage(snapshot, turnNum) {
			const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, found: false, perModel: {} };
			const nodes = snapshot && Array.isArray(snapshot.nodes) ? snapshot.nodes : [];
			for (const n of nodes) {
				if (!n || n.kind !== "assistant") continue;
				if (typeof n.turn !== "number" || n.turn !== turnNum) continue;
				const u = n.usage;
				if (!u || typeof u !== "object") continue;
				total.found = true;
				total.inputTokens += num(u.inputTokens);
				total.outputTokens += num(u.outputTokens);
				total.cacheReadTokens += num(u.cacheReadTokens);
				total.cacheWriteTokens += num(u.cacheWriteTokens);
				total.reasoningTokens += num(u.reasoningTokens);
				// 按模型分组 (用于按模型价格分别计价)
				const model = (n.provenance && typeof n.provenance.model === "string" && n.provenance.model) || "unknown";
				if (!total.perModel[model]) {
					total.perModel[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
				}
				const m = total.perModel[model];
				m.inputTokens += num(u.inputTokens);
				m.outputTokens += num(u.outputTokens);
				m.cacheReadTokens += num(u.cacheReadTokens);
				m.cacheWriteTokens += num(u.cacheWriteTokens);
				m.reasoningTokens += num(u.reasoningTokens);
			}
			return total;
		}

		/** 回合 token 用量显示 (带「本次token：」前缀, 右对齐, 无数据时静默不渲染)。 */
		function TurnTokens(props) {
			const useSession = props.useSession;
			const matched = props.matched;

			// 防御: standard kit 缺失时静默不渲染
			if (!useSession || typeof useSession !== "function") return null;

			const snapshot = useSession((s) => s);
			const turnObj = matched && matched.turn;
			const turnNum = typeof turnObj === "number" ? turnObj : (turnObj && typeof turnObj.turn === "number" ? turnObj.turn : null);
			if (turnNum === null) return null;

			const usage = sumTurnUsage(snapshot, turnNum);
			if (!usage.found) return null;

			// 预估费用: 按回合内各模型分别计价 (价格表取 localStorage 已保存值, 未保存用官方默认价)
			const prices = loadPrices();
			let cost = 0;
			for (const model of Object.keys(usage.perModel || {})) {
				cost += costOf(usage.perModel[model], prices, model);
			}

			// 拼装展示项 (按官方计费口径分类): 输入(未命中缓存) / 输入(命中缓存) / 输出 / 思考 / 费用约
			//   输入未命中 = inputTokens + cacheWriteTokens (首次写入缓存的输入按未命中计费);
			//   思考(reasoning) 已计入输出, 不重复计费, 仅作参考展示。
			const parts = [];
			const missTotal = usage.inputTokens + usage.cacheWriteTokens;
			const missStr = fmtTokens(missTotal);
			const hitStr = fmtTokens(usage.cacheReadTokens);
			const outStr = fmtTokens(usage.outputTokens);
			const reasonStr = fmtTokens(usage.reasoningTokens);
			if (missStr && missTotal > 0) parts.push("输入(未命中) " + missStr);
			if (hitStr && usage.cacheReadTokens > 0) parts.push("输入(命中缓存) " + hitStr);
			if (outStr) parts.push("输出 " + outStr);
			if (reasonStr && usage.reasoningTokens > 0) parts.push("思考 " + reasonStr);
			if (cost > 0) parts.push("费用约 " + fmtCost(cost));
			if (parts.length === 0) return null;

			return react.createElement("div", {
				title: "该回合实际消耗的 token 与预估费用（token 按 DeepSeek 官方计费口径分类：输入分未命中/命中缓存，思考(reasoning) 已计入输出不重复计费；费用按价格表估算，可在 设置 → 用量统计 调整价格）",
				style: {
					display: "flex",
					justifyContent: "flex-end",
					gap: 4,
					fontSize: 11,
					lineHeight: 1.5,
					color: "var(--dsw-alias-label-secondary, #8a8f98)",
				},
			}, [
				react.createElement("span", { key: "prefix", style: { flex: "none" } }, "本次token："),
				react.createElement("span", { key: "vals" }, parts.join(" · ")),
			]);
		}

		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "usage-stats",
				order: 510,
				label: "用量统计",
			}, UsageStatsSection));

			ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register(
				{
					name: "conversation.chat.turnTail",
					priority: -10,
					select: (owner) => ({ turn: owner.turn, seq: owner.seq }),
				},
				(props) => react.createElement(TurnTokens, props),
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
