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


// _tabLabel: 现场解析当前语言(读 <html lang>), 不依赖 BR.current 缓存,
// 消除语言切换时 Tab 名滞后/与宿主语言不同步的竞态。宿主切语言会同步更新 <html lang>。
function _tabLabel(key, fallback) {
    var el = document.documentElement && document.documentElement.lang;
    var lang = (el === 'zh-CN' || el === 'zh') ? 'zh'
        : (el && el.indexOf('en') === 0) ? 'en'
        : ((window.__DSH_I18N__ && window.__DSH_I18N__.current) || 'zh');
    var br = window.__DSH_I18N__;
    try {
        if (br && br[lang]) {
            var val = br[lang][key];
            if (val !== undefined && val !== null && val !== '') return val;
        }
    } catch (_) {}
    return fallback || key;
}
function _dsht(key, fallback) {
    try {
        const bridge = window.__DSH_I18N__;
        if (bridge && bridge.current && bridge[bridge.current]) {
            const val = bridge[bridge.current][key];
            if (val !== undefined && val !== null && val !== "") return val;
        }
    } catch (_e) { }
    return fallback || key;
}

window.__ModuleLoader__.load({
	id: "dsh-usage-stats",
	factory: (require) => {
		        // === 异步加载 i18n bridge ===
		        (function() {
		            if (window.__DSH_I18N__ && window.__DSH_I18N__._initialized) return;  // 桌面壳已预注入
		            var _s = document.createElement('script');
		            _s.src = 'http://127.0.0.1:3081/__dsh_i18n_bridge.js';
		            _s.onerror = function() { _s.src = 'http://localhost:3081/__dsh_i18n_bridge.js'; };
		            document.head.appendChild(_s);
		        })();
		        // === i18n bridge END ===

		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const inject = ["slots"];

		const ROUTE_LIST = "/__dsh/usage-stats/list";
		const ROUTE_DETAIL = "/__dsh/usage-stats/detail";
		const ROUTE_BALANCE = "/__dsh/usage-stats/balance";
		const ROUTE_PRICING = "/__dsh/usage-stats/pricing";
		const ROUTE_PRICING_REFRESH = "/__dsh/usage-stats/pricing-refresh";
		const GUARD_HEADER = "X-DSH-Usage-Stats";
		// 价格表键名版本 v3 -> v4 -> v5: v5 起价格结构升级为两档三桶 (offPeak/peak x cacheHit/cacheMiss/output),
		// 与后端 /pricing 返回的官方表结构一致, 可无缝覆盖。旧 localStorage 结构不兼容, 升版本号避免盖住新默认值。
		const PRICES_KEY = "dsh.usageStats.prices.v5";
		// 高峰窗口 (UTC 小时, 半开区间): 对应北京时间 9:00-12:00 与 14:00-18:00。
		const PEAK_WINDOWS = [
			{ start: 1, end: 4 },
			{ start: 6, end: 10 },
		];
		// 周末全谷价生效时刻 (UTC): 2026-08-23 (周日) 00:00 北京时间起, 北京周六/周日全天不再区分峰谷。
		const WEEKEND_OFFPEAK_EFFECTIVE_AT = "2026-08-22T16:00:00Z";

		/**
		 * 默认价格表 (单位: 元 / 每百万 tokens, 2026-09-21 实抓官方中文定价页)。
		 * 结构: 每个模型含 offPeak(低谷/空闲) 与 peak(高峰) 两档三桶 (cacheHit/cacheMiss/output),
		 * 与后端 priceState.table 同构。官方口径: 高峰 = 低谷 2 倍, 周末全天低谷价。
		 * 模型 id 说明: deepseek-flash 为当前主力 id (DeepSeek-V4.1-Flash); 历史/退役 id
		 * (deepseek-v4-flash / deepseek-v4-flash-vision-exp / deepseek-v4.1-flash) 由 flash 服务并按
		 * flash 计价, 故三者共用同一单价。deepseek-v4-pro 自 2026-09-14 起也路由到 flash 计价,
		 * 本表先保留其自身单价, 待退役完成后按实际账单调整。
		 * 字段: cacheMiss=输入未命中缓存, cacheHit=输入命中缓存, output=输出。
		 */
		const DEFAULT_PRICES = {
			models: {
				"deepseek-flash": {
					offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
					peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
				},
				"deepseek-v4-flash": {
					offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
					peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
				},
				"deepseek-v4-flash-vision-exp": {
					offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
					peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
				},
				"deepseek-v4.1-flash": {
					offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
					peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
				},
				"deepseek-v4-pro": {
					offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
					peak: { cacheHit: 0.30, cacheMiss: 9, output: 27 },
				},
			},
			fallback: {
				offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
				peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
			},
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

		/**
		 * 用官方表更新当前价格 (「从官方更新价格」按钮 / 首次静默同步用)。
		 * 规则 (对齐"用户手动编辑优先"): 官方表里已有的模型用官方新价; 用户手动添加、
		 * 官方表里没有的自定义模型保留; 不写 localStorage (用户没再点保存前, 本地表仍是旧的,
		 * 避免静默覆盖用户手改价——只有显式点「保存价格」才落盘)。
		 */
		function loadPricesFromOfficial(officialTable) {
			const official = JSON.parse(JSON.stringify(officialTable || DEFAULT_PRICES));
			if (!official.models || typeof official.models !== "object") return JSON.parse(JSON.stringify(DEFAULT_PRICES));
			// 把用户本地保存的自定义模型 (官方表没有的) 并进去。
			let local = null;
			try {
				const raw = localStorage.getItem(PRICES_KEY);
				if (raw) local = JSON.parse(raw);
			} catch (e) { local = null; }
			if (local && local.models && typeof local.models === "object") {
				for (const model of Object.keys(local.models)) {
					if (!Object.prototype.hasOwnProperty.call(official.models, model)) {
						official.models[model] = local.models[model];
					}
				}
			}
			official.fallback = JSON.parse(JSON.stringify((officialTable && officialTable.fallback) || DEFAULT_PRICES.fallback));
			return official;
		}

		function num(v) {
			const n = typeof v === "number" ? v : parseFloat(v);
			return Number.isFinite(n) && n >= 0 ? n : 0;
		}

		/** 北京周六/周日全谷区间 (UTC ms 起始), 非周末/生效前返回 null。 */
		function weekendZoneAt(atMs) {
			if (typeof atMs !== "number" || !isFinite(atMs) || atMs < Date.parse(WEEKEND_OFFPEAK_EFFECTIVE_AT)) return null;
			const beijingDay = Math.floor((atMs + 8 * 3600000) / 86400000);
			const weekday = (beijingDay + 4) % 7; // 0=周日 … 6=周六
			if (weekday !== 6 && weekday !== 0) return null;
			const saturdayDay = weekday === 6 ? beijingDay : beijingDay - 1;
			return {
				start: Math.max(saturdayDay * 86400000 - 8 * 3600000, Date.parse(WEEKEND_OFFPEAK_EFFECTIVE_AT)),
				end: (saturdayDay + 2) * 86400000 - 8 * 3600000,
			};
		}

		/** 是否处于高峰时段 (周末全谷优先; 未过生效门槛的旧时刻按低谷). 与后端 isPeakHour 同口径. */
		function isPeakHour(atMs) {
			const weekend = weekendZoneAt(atMs);
			if (weekend !== null) return false;
			if (typeof atMs !== "number" || !isFinite(atMs)) return false;
			const hour = new Date(atMs).getUTCHours();
			for (const windowEntry of PEAK_WINDOWS) {
				if (hour >= windowEntry.start && hour < windowEntry.end) return true;
			}
			return false;
		}

		/**
		 * 取某模型的当前生效档三桶 (按此刻峰谷): 命中 presence.peak/offPeak, 缺失回退 fallback。
		 * 兼容只有一档 (无 offPeak/peak 子档) 的旧条目: 直接回退条目本身。
		 */
		function priceOf(prices, model, atMs) {
			const nowMs = (typeof atMs === "number" && isFinite(atMs)) ? atMs : Date.now();
			const p = (prices.models && prices.models[model]) || prices.fallback;
			if (!p) return { cacheHit: 0, cacheMiss: 0, output: 0 };
			const tier = isPeakHour(nowMs) ? (p.peak || p) : (p.offPeak || p);
			return {
				cacheHit: num(tier.cacheHit),
				cacheMiss: num(tier.cacheMiss),
				output: num(tier.output),
			};
		}

		/**
		 * 按单价估算一次用量的费用 (对齐 DeepSeek 官方计费口径):
		 *   费用 = 输入(未命中缓存) × 未命中单价 + 输入(命中缓存) × 命中单价 + 输出 × 输出单价
		 *   其中输入未命中 = inputTokens + cacheWriteTokens (首次写入缓存的输入按未命中价计费);
		 *   思考(reasoning) token 已计入 outputTokens, 不重复计费。
		 * atMs 缺省按当前时刻取峰谷档 (消息行「本次token」用)。
		 */
		function costOf(usage, prices, model, atMs) {
			if (!usage) return 0;
			const p = priceOf(prices, model, atMs);
			return (
				((num(usage.inputTokens) + num(usage.cacheWriteTokens)) / 1e6) * p.cacheMiss +
				(num(usage.cacheReadTokens) / 1e6) * p.cacheHit +
				(num(usage.outputTokens) / 1e6) * p.output
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

		// ---- DeepSeek 真实余额查询 (账户级, 2026-08-25 新增) ----

		// 余额缓存 (模块级): 避免消息行多次渲染反复请求后端; 默认缓存 5 分钟
		const BALANCE_CACHE_MS = 5 * 60 * 1000;
		let balanceCacheValue = null;   // 最近一次拿到的完整余额响应对象
		let balanceCacheAt = 0;         // 最近一次拉取的时间戳 (毫秒)

		/**
		 * 直接拉取余额响应 (不抛异常): 返回 { ok, configured, balance?, error? }。
		 * 与 getJson 不同: 余额路由即使查询失败也返回 HTTP 200, 需原样拿到 ok / configured 字段来区分状态。
		 */
		async function getBalancePayload() {
			// 全程兜底: 非 DeepSeek 绑定 / 后端不可达 / 网络异常都不允许往外抛, 保证消息行 effect 不产生 unhandled rejection
			try {
				const response = await fetch(ROUTE_BALANCE, { headers: { [GUARD_HEADER]: "1" } });
				return await response.json().catch(() => ({ ok: false, error: _dsht("plugin.usage_stats.err_balance_parse", "余额接口响应解析失败") }));
			} catch (err) {
				return { ok: false, configured: false, error: _dsht("plugin.usage_stats.err_balance_req", "余额接口请求失败: ") + String((err && err.message) || err) };
			}
		}

		/**
		 * 带缓存的余额获取: 缓存未过期直接回缓存; 否则请求后端并刷新缓存。
		 * force 为 true 时强制重新拉取 (设置页手动刷新用)。
		 */
		async function getBalanceCached(force) {
			const now = Date.now();
			if (!force && balanceCacheValue !== null && now - balanceCacheAt < BALANCE_CACHE_MS) {
				return balanceCacheValue;
			}
			try {
				const payload = await getBalancePayload();
				balanceCacheValue = payload;
				balanceCacheAt = Date.now();
				return payload;
			} catch (err) {
				// 双保险: 拉取异常时若缓存未过期则回缓存, 否则给一个平和的失败响应, 绝不外抛
				if (balanceCacheValue !== null && now - balanceCacheAt < BALANCE_CACHE_MS) {
					return balanceCacheValue;
				}
				return { ok: false, configured: false, error: _dsht("plugin.usage_stats.err_balance_query", "余额查询失败: ") + String((err && err.message) || err) };
			}
		}

		/**
		 * 从余额响应里挑出 CNY 的余额信息 (拿不到 CNY 用第一个); 无有效余额返回 null。
		 */
		function pickBalanceInfo(payload) {
			if (!payload || payload.ok !== true || !payload.balance || !Array.isArray(payload.balance.balance_infos)) return null;
			const infos = payload.balance.balance_infos;
			return infos.find((item) => item && item.currency === "CNY") || infos[0] || null;
		}

		/** 把余额数字 (字符串/数字) 格式化为千分位 (如 "110.00" -> "110.00") */
		function fmtBalance(value) {
			if (typeof value !== "string" && typeof value !== "number") return "—";
			const numberValue = Number(value);
			if (!Number.isFinite(numberValue)) return "—";
			return numberValue.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
		}

		// ---- 价格表编辑 ----
		// 价格结构 v5: 每模型 { offPeak: {cacheHit,cacheMiss,output}, peak: {...} } 两档三桶,
		// 编辑器按「低谷/高峰」切换编辑档位 (默认高峰, 与第三方插件峰谷提示一致)。

		function PriceEditor({ prices, setPrices, onChange, officialInfo, onRefreshOfficial, refreshing }) {
		const [i18nTick, setI18nTick] = react.useState(0);
		react.useEffect(() => {
			const handler = () => setI18nTick(t => t + 1);
			document.addEventListener('dsh-i18n-change', handler);
			return () => document.removeEventListener('dsh-i18n-change', handler);
		}, []);
			const [draft, setDraft] = react.useState(prices);
			const [editTier, setEditTier] = react.useState("peak"); // 当前编辑档位: peak | offPeak
			const [newName, setNewName] = react.useState("");
			const [newMiss, setNewMiss] = react.useState("");
			const [newHit, setNewHit] = react.useState("");
			const [newOut, setNewOut] = react.useState("");

			// 兼容旧一档条目 (无 offPeak/peak 子档): 取条目自身作为任意档的表现体。
			const tierOf = (entry) => {
				if (!entry) return { offPeak: { cacheHit: 0, cacheMiss: 0, output: 0 }, peak: { cacheHit: 0, cacheMiss: 0, output: 0 } };
				if (!entry.offPeak && !entry.peak) return { offPeak: entry, peak: entry };
				return {
					offPeak: entry.offPeak || entry,
					peak: entry.peak || entry,
				};
			};
			const currentTierOf = (entry) => tierOf(entry)[editTier];

			const setRow = (model, field, value) => {
				setDraft((prev) => {
					const next = { ...prev, models: { ...prev.models } };
					const tiers = tierOf(next.models[model] || prev.fallback);
					tiers[editTier] = { ...tiers[editTier], [field]: value };
					next.models[model] = tiers;
					return next;
				});
			};
			const setFallback = (field, value) => {
				setDraft((prev) => {
					const tiers = tierOf(prev.fallback);
					tiers[editTier] = { ...tiers[editTier], [field]: value };
					return { ...prev, fallback: tiers };
				});
			};

			const save = () => {
				const normalize = (entry) => {
					const tiers = tierOf(entry);
					const norm = (t) => ({
						cacheHit: num(t.cacheHit),
						cacheMiss: num(t.cacheMiss),
						output: num(t.output),
					});
					return { offPeak: norm(tiers.offPeak), peak: norm(tiers.peak) };
				};
				const next = { models: {}, fallback: normalize(draft.fallback) };
				for (const model of Object.keys(draft.models)) {
					next.models[model] = normalize(draft.models[model]);
				}
				savePrices(next);
				setPrices(next);
				setDraft(next);
				onChange(next);
			};

			const addModel = () => {
				const name = newName.trim();
				if (!name) return;
				const value = { cacheHit: num(newHit), cacheMiss: num(newMiss), output: num(newOut) };
				setDraft((prev) => ({
					...prev,
					models: { ...prev.models, [name]: { offPeak: { ...value }, peak: { ...value } } },
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
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 4,
				fontSize: 12,
				textAlign: "right",
				background: "var(--dsw-specific-input-major)",
				color: "var(--dsw-alias-label-primary)",
			};
			const th = { padding: "6px 10px", textAlign: "left", fontSize: 12, color: "var(--dsw-alias-label-secondary)", borderBottom: "1px solid var(--dsw-alias-border-l2)" };
			const td = { padding: "4px 10px", fontSize: 12, color: "var(--dsw-alias-label-primary)" };
			const tierBtn = (tier, label) => react.createElement("button", {
				key: tier,
				type: "button",
				style: {
					padding: "3px 10px",
					fontSize: 12,
					cursor: "pointer",
					borderRadius: 4,
					border: "1px solid var(--dsw-alias-border-l2)",
					background: editTier === tier ? "var(--dsw-specific-input-major)" : "transparent",
					color: "var(--dsw-alias-label-primary)",
					fontWeight: editTier === tier ? 600 : 400,
				},
				onClick: () => setEditTier(tier),
			}, label);

			const tierSwitch = react.createElement("div", { key: "tier", style: { display: "flex", gap: 6, alignItems: "center" } }, [
				tierBtn("peak", _dsht("plugin.usage_stats.price_tier_peak", "高峰时段")),
				tierBtn("offPeak", _dsht("plugin.usage_stats.price_tier_offpeak", "低谷时段")),
			]);

			// 价格来源徽标 + 从官方更新价格按钮 (仅后端可达时显示)
			const sourceBadge = react.createElement("span", {
				key: "src",
				style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", alignSelf: "center" },
			}, (officialInfo && officialInfo.source === "official"
				? _dsht("plugin.usage_stats.price_source_official", "官方同步") +
					(officialInfo.fetchedAt ? " · " + fmtTime(Date.parse(officialInfo.fetchedAt)) : "")
				: _dsht("plugin.usage_stats.price_source_bundled", "内置默认价")));
			const refreshBtn = react.createElement("button", {
				key: "refresh",
				type: "button",
				disabled: refreshing,
				onClick: () => { if (onRefreshOfficial) onRefreshOfficial(); },
				style: { padding: "4px 12px", cursor: refreshing ? "default" : "pointer", fontSize: 12 },
			}, refreshing ? _dsht("plugin.usage_stats.btn_updating", "更新中…") : _dsht("plugin.usage_stats.btn_refresh_prices", "从官方更新价格"));

			return react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8 } }, [
				react.createElement("div", { key: "head", style: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" } }, [
					tierSwitch,
					refreshBtn,
					sourceBadge,
				]),
				react.createElement("table", { key: "tbl", style: { borderCollapse: "collapse", width: "100%", maxWidth: 560 } }, [
					react.createElement("thead", { key: "h" },
						react.createElement("tr", { key: "r" },
							react.createElement("th", { style: th }, _dsht("plugin.usage_stats.price_model", "模型")),
							react.createElement("th", { style: { ...th, textAlign: "right" } }, _dsht("plugin.usage_stats.price_input_miss", "输入(未命中) ¥/M")),
							react.createElement("th", { style: { ...th, textAlign: "right" } }, _dsht("plugin.usage_stats.price_input_hit", "输入(命中缓存) ¥/M")),
							react.createElement("th", { style: { ...th, textAlign: "right" } }, _dsht("plugin.usage_stats.price_output", "输出 ¥/M")),
							react.createElement("th", { style: { ...th, width: 40 } }, "")
						)
					),
					react.createElement("tbody", { key: "b" }, [
						Object.keys(draft.models).map((model) =>
							react.createElement("tr", { key: model },
								react.createElement("td", { style: { ...td, fontFamily: "Consolas, Menlo, monospace" } }, model),
								react.createElement("td", { style: td },
									react.createElement("input", { type: "number", min: 0, step: "0.01", style: inputStyle, value: currentTierOf(draft.models[model]).cacheMiss, onChange: (e) => setRow(model, "cacheMiss", e.target.value) })
								),
								react.createElement("td", { style: td },
									react.createElement("input", { type: "number", min: 0, step: "0.01", style: inputStyle, value: currentTierOf(draft.models[model]).cacheHit, onChange: (e) => setRow(model, "cacheHit", e.target.value) })
								),
								react.createElement("td", { style: td },
									react.createElement("input", { type: "number", min: 0, step: "0.01", style: inputStyle, value: currentTierOf(draft.models[model]).output, onChange: (e) => setRow(model, "output", e.target.value) })
								),
								react.createElement("td", { style: td },
									react.createElement("button", { type: "button", style: { fontSize: 11, cursor: "pointer", color: "var(--dsw-alias-state-error-primary)", border: "none", background: "transparent" }, onClick: () => removeModel(model) }, _dsht("plugin.usage_stats.price_btn_del", "删"))
								)
							)
						),
						react.createElement("tr", { key: "__fallback__" },
							react.createElement("td", { style: { ...td, fontWeight: 600 } }, _dsht("plugin.usage_stats.price_fallback", "其他模型（兜底）")),
							react.createElement("td", { style: td },
								react.createElement("input", { type: "number", min: 0, step: "0.01", style: inputStyle, value: currentTierOf(draft.fallback).cacheMiss, onChange: (e) => setFallback("cacheMiss", e.target.value) })
							),
							react.createElement("td", { style: td },
								react.createElement("input", { type: "number", min: 0, step: "0.01", style: inputStyle, value: currentTierOf(draft.fallback).cacheHit, onChange: (e) => setFallback("cacheHit", e.target.value) })
							),
							react.createElement("td", { style: td },
								react.createElement("input", { type: "number", min: 0, step: "0.01", style: inputStyle, value: currentTierOf(draft.fallback).output, onChange: (e) => setFallback("output", e.target.value) })
							),
							react.createElement("td", { style: td }, "")
						),
						react.createElement("tr", { key: "__add__" },
							react.createElement("td", { style: td },
								react.createElement("input", { type: "text", placeholder: _dsht("plugin.usage_stats.price_placeholder_model", "新模型名"), style: { ...inputStyle, width: 140, textAlign: "left" }, value: newName, onChange: (e) => setNewName(e.target.value) })
							),
							react.createElement("td", { style: td }, react.createElement("input", { type: "number", min: 0, step: "0.01", placeholder: _dsht("plugin.usage_stats.price_placeholder_miss", "未命中"), style: inputStyle, value: newMiss, onChange: (e) => setNewMiss(e.target.value) })),
							react.createElement("td", { style: td }, react.createElement("input", { type: "number", min: 0, step: "0.01", placeholder: _dsht("plugin.usage_stats.price_placeholder_hit", "命中"), style: inputStyle, value: newHit, onChange: (e) => setNewHit(e.target.value) })),
							react.createElement("td", { style: td }, react.createElement("input", { type: "number", min: 0, step: "0.01", placeholder: _dsht("plugin.usage_stats.label_output_short", "输出"), style: inputStyle, value: newOut, onChange: (e) => setNewOut(e.target.value) })),
							react.createElement("td", { style: td },
								react.createElement("button", { type: "button", style: { fontSize: 11, cursor: "pointer" }, onClick: addModel }, _dsht("plugin.usage_stats.price_btn_add", "添加"))
							)
						),
					]),
				]),
				react.createElement("div", { key: "btns", style: { display: "flex", gap: 8, flexWrap: "wrap" } }, [
					react.createElement("button", { key: "save", type: "button", style: { padding: "4px 14px", cursor: "pointer", fontSize: 12 }, onClick: save }, _dsht("plugin.usage_stats.price_btn_save", "保存价格")),
					react.createElement("button", { key: "reset", type: "button", style: { padding: "4px 14px", cursor: "pointer", fontSize: 12 }, onClick: reset }, _dsht("plugin.usage_stats.price_btn_reset", "恢复默认")),
					react.createElement("span", { key: "tip", style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", alignSelf: "center" } },
						_dsht("plugin.usage_stats.price_hint", "单价 = 元 / 每百万 tokens；费用 = 输入(未命中)×单价 + 输入(命中)×单价 + 输出×单价，思考 token 已计入输出不重复计费；高峰/低谷两档按官方规则计（北京周一至周五 9:00-12:00 / 14:00-18:00 为高峰，其余含周末为低谷，高峰为低谷 2 倍），可通过「从官方更新价格」获取最新官方价；手动保存的价格会覆盖官方价")
					),
				]),
			]);
		}

		// ---- 主面板 ----

		/** 元信息小标签 (label + value, 自动换行)。 */
		function MetaChip({ label, value, valueStyle }) {
			return react.createElement("span", {
				style: {
					display: "inline-flex",
					alignItems: "baseline",
					gap: 4,
					background: "var(--dsw-alias-bg-secondary)",
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

		/** 单个会话卡片 (标题独占一行, 下方元信息 chips, 明细在卡片内展开) */
		function SessionCard({ session, prices, detail, detailBusy, onToggleDetail }) {
			const s = session;
			const sum = sumModels(s.models, prices);
			const expanded = detail && detail.id === s.id;

			const cardStyle = {
				border: "1px solid var(--dsw-alias-border-l2)",
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
					react.createElement("span", { key: "t", style: titleStyle, title: s.displayTitle || s.id },
						s.displayTitle || _dsht("plugin.usage_stats.no_title", "(无标题)")
					),
					s.live && react.createElement("span", { key: "live", style: { ...badgeStyle, color: "var(--dsw-alias-state-success-primary)" } }, _dsht("plugin.usage_stats.btn_running", "运行中")),
					s.error && react.createElement("span", { key: "err", style: { ...badgeStyle, color: "var(--dsw-alias-state-error-primary)" } }, _dsht("plugin.usage_stats.btn_decode_fail", "解码失败")),
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
					}, expanded ? _dsht("plugin.usage_stats.btn_collapse", "收起") : (detailBusy ? _dsht("plugin.usage_stats.btn_loading", "加载中…") : _dsht("plugin.usage_stats.btn_detail", "明细"))),
				]),
				// 第二行: 会话 ID (整行, 超长省略, 悬停可见完整)
				react.createElement("div", { key: "id", style: idStyle, title: s.id }, s.id),
				// 第三行: 元信息 chips (自动换行)
				react.createElement("div", { key: "m", style: chipRowStyle }, [
					react.createElement(MetaChip, { key: "ws", label: _dsht("plugin.usage_stats.label_workspace", "工作区"), value: (s.workspace && s.workspace.title) || "—" }),
					react.createElement(MetaChip, { key: "tc", label: _dsht("plugin.usage_stats.label_turns", "回合"), value: fmtInt(s.turnCount) }),
					react.createElement(MetaChip, { key: "in", label: _dsht("plugin.usage_stats.label_input", "输入"), value: fmtInt(sum.total.inputTokens) }),
					react.createElement(MetaChip, { key: "out", label: _dsht("plugin.usage_stats.label_output_short", "输出"), value: fmtInt(sum.total.outputTokens) }),
					react.createElement(MetaChip, { key: "cache", label: _dsht("plugin.usage_stats.label_cache", "缓存"), value: fmtInt(sum.total.cacheReadTokens + sum.total.cacheWriteTokens) }),
					react.createElement(MetaChip, { key: "cost", label: _dsht("plugin.usage_stats.label_cost", "估算费用"), value: fmtCost(sum.cost), valueStyle: { fontWeight: 700 } }),
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

		/** 会话明细: 汇总行 + 逐回合卡片。 */
		function DetailBody({ detail, prices, session }) {
			const d = detail;
			const bodyStyle = {
				marginTop: 10,
				borderTop: "1px solid var(--dsw-alias-border-l2)",
				paddingTop: 10,
			};

			if (d === null) {
				return react.createElement("div", { style: { ...bodyStyle, color: "var(--dsw-alias-label-tertiary)", fontSize: 12 } }, _dsht("plugin.usage_stats.btn_loading", "加载中…"));
			}
			if (d.error) {
				return react.createElement("div", { style: { ...bodyStyle, color: "var(--dsw-alias-state-error-primary)", fontSize: 12 } }, _dsht("plugin.usage_stats.detail_err_load", "明细加载失败: ") + d.error);
			}

			const dSum = sumModels(d.totals && d.totals.models, prices);
			const models = (d.totals && d.totals.models) || {};
			const modelNames = Object.keys(models);

			// 汇总 chips
			const metaChips = [
				react.createElement(MetaChip, { key: "tc", label: _dsht("plugin.usage_stats.label_turns", "回合"), value: fmtInt(d.turnCount) }),
				react.createElement(MetaChip, { key: "mc", label: _dsht("plugin.usage_stats.label_assistant_msg", "助手消息"), value: fmtInt(d.messageCount) }),
				react.createElement(MetaChip, { key: "out", label: _dsht("plugin.usage_stats.label_output_tokens", "输出 tokens"), value: fmtInt(dSum.total.outputTokens) }),
				react.createElement(MetaChip, { key: "cost", label: _dsht("plugin.usage_stats.label_cost", "估算费用"), value: fmtCost(dSum.cost), valueStyle: { fontWeight: 700 } }),
			];
			if (d.session && d.session.createdAt) {
				metaChips.push(react.createElement(MetaChip, { key: "ct", label: _dsht("plugin.usage_stats.label_created_at", "创建于"), value: fmtTime(d.session.createdAt) }));
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
							border: "1px solid var(--dsw-alias-border-l2)",
							borderRadius: 6,
							padding: "8px 10px",
							background: "var(--dsw-alias-bg-secondary)",
							marginBottom: 8,
						},
					}, [
						// 用户消息独占整行, 完整换行显示
						react.createElement("div", {
							key: "msg",
							style: {
								fontSize: 12.5,
								lineHeight: 1.6,
								color: "var(--dsw-alias-label-primary)",
								wordBreak: "break-word",
								overflowWrap: "break-word",
							},
						}, t.userText || _dsht("plugin.usage_stats.empty_no_text", "（无文本 / 命令）")),
						// 下方: 回合信息 (自动换行)
						react.createElement("div", {
							key: "info",
							style: {
								marginTop: 6,
								display: "flex",
								flexWrap: "wrap",
								gap: "2px 12px",
								fontSize: 11.5,
								color: "var(--dsw-alias-label-secondary)",
							},
						}, [
							react.createElement("span", { key: "turn", style: { fontWeight: 600, color: "var(--dsw-alias-label-secondary)" } }, _dsht("plugin.usage_stats.label_turn_hash", "回合 #") + t.turn),
							react.createElement("span", { key: "steps" }, _dsht("plugin.usage_stats.label_steps", "步骤") + " " + fmtInt(t.steps)),
							react.createElement("span", { key: "tools" }, _dsht("plugin.usage_stats.label_tool_calls", "工具调用") + " " + fmtInt(t.toolCalls)),
							react.createElement("span", { key: "out" }, _dsht("plugin.usage_stats.label_output_tk", "输出 tk") + " " + fmtInt(tSum.total.outputTokens)),
							react.createElement("span", { key: "cost", style: { fontWeight: 600, color: "var(--dsw-alias-label-secondary)" } }, _dsht("plugin.usage_stats.label_cost", "估算费用").replace("费用", "") + fmtCost(tSum.cost)),
							react.createElement("span", { key: "model", style: { fontFamily: "Consolas, Menlo, monospace", color: "var(--dsw-alias-label-tertiary)" } }, turnModels),
							react.createElement("span", {
								key: "status",
								style: { color: t.complete ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-warn-primary)", fontWeight: 600 },
							}, t.complete ? _dsht("plugin.usage_stats.label_done", "完成") : _dsht("plugin.usage_stats.label_undone", "未完")),
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
						value: _dsht("plugin.usage_stats.label_input", "输入") + " " + fmtInt(models[model].inputTokens) + " · " + _dsht("plugin.usage_stats.label_output_short", "输出") + " " + fmtInt(models[model].outputTokens) + " · " + _dsht("plugin.usage_stats.label_cache", "缓存") + " " + fmtInt(models[model].cacheReadTokens + models[model].cacheWriteTokens) + " · " + _dsht("plugin.usage_stats.label_cost", "估算费用").replace("费用","") + fmtCost(costOf(models[model], prices, model)),
						valueStyle: { fontFamily: "Consolas, Menlo, monospace", fontSize: 11 },
					})
				)),
				turnBlocks.length === 0 && react.createElement("div", { key: "empty", style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, padding: "4px 0" } }, _dsht("plugin.usage_stats.empty_no_turns", "没有回合数据。")),
				turnBlocks,
			]);
		}

		function UsageStatsSection() {
		const [i18nTick, setI18nTick] = react.useState(0);
		react.useEffect(() => {
			const handler = () => setI18nTick(t => t + 1);
			document.addEventListener('dsh-i18n-change', handler);
			return () => document.removeEventListener('dsh-i18n-change', handler);
		}, []);
			const [sessions, setSessions] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [prices, setPrices] = react.useState(null);
			const [detail, setDetail] = react.useState(null);
			const [detailBusy, setDetailBusy] = react.useState(false);
			const [balance, setBalance] = react.useState(null);          // 真实余额响应 (含 ok/configured/balance/error)
			const [balanceBusy, setBalanceBusy] = react.useState(false); // 余额加载/刷新中标志
			const [todayData, setTodayData] = react.useState(null);      // 今日消耗 (后端按事件时刻/峰谷聚合)
			const [daysData, setDaysData] = react.useState(null);        // 近 60 天每日序列 (热力图)
			const [priceInfo, setPriceInfo] = react.useState(null);      // { source, fetchedAt, currentTier }
			const [priceBusy, setPriceBusy] = react.useState(false);     // 官方价格刷新中标志
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
					setTodayData(payload.today || null);
					setDaysData(Array.isArray(payload.days) ? payload.days : null);
					if (payload.price) {
						setPriceInfo(payload.price);
					}
				} catch (err) {
					setError(_dsht("plugin.usage_stats.err_load", "加载失败: ") + String((err && err.message) || err));
				} finally {
					setBusy(false);
				}
			}, []);

			const loadBalance = react.useCallback(async (force) => {
				setBalanceBusy(true);
				try {
					const payload = await getBalanceCached(force);
					setBalance(payload);
				} catch (err) {
					setBalance({ ok: false, error: String((err && err.message) || err) });
				} finally {
					setBalanceBusy(false);
				}
			}, []);

			// 从官方定价页刷新价格表; 成功则更新状态与来源徽标, 失败保留现有表不崩。
			// 注意: 必须在本组件内定义于首次加载块之前 (const 声明的 useCallback 在定义前引用会触发 TDZ 报错)。
			const refreshOfficialPrices = react.useCallback(async () => {
				setPriceBusy(true);
				try {
					const payload = await (await fetch(ROUTE_PRICING_REFRESH, { headers: { [GUARD_HEADER]: "1" } })).json().catch(() => null);
					if (payload && payload.ok === true) {
						if (payload.table) setPrices(loadPricesFromOfficial(payload.table));
						if (payload.source || payload.fetchedAt || payload.currentTier) {
							setPriceInfo({
								source: payload.source,
								fetchedAt: payload.fetchedAt,
								currentTier: payload.currentTier,
							});
						}
					}
				} catch (err) { /* 忽略: 保留现有价格表 */ } finally {
					setPriceBusy(false);
				}
			}, []);

			if (!loadedRef.current) {
				loadedRef.current = true;
				loadList();
				loadBalance(false);
				// 静默拉一次官方价: 刷新价格表为默认 (不落 localStorage, 用户手改优先)。
				refreshOfficialPrices();
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
			const cardStyle = { border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 6, padding: "10px 12px", background: "var(--dsw-alias-bg-base)" };
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
					react.createElement("span", { key: "l", style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } }, label),
					react.createElement("span", { key: "v", style: { fontSize: 16, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, value),
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

			// ---- 真实余额卡 (DeepSeek 账户余额, 实扣非估算) ----
			const balanceStat = (label, value) =>
				react.createElement("div", { key: label, style: { display: "flex", flexDirection: "column", gap: 2, minWidth: 96 } }, [
					react.createElement("span", { key: "l", style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } }, label),
					react.createElement("span", { key: "v", style: { fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, value),
				]);
			const balanceCard = (() => {
				if (balance === null) return null;
				const currencySymbol = () => {
					const info = pickBalanceInfo(balance);
					return info && info.currency === "USD" ? "$" : "¥";
				};
				let body;
				if (balance.configured === false) {
					body = react.createElement("div", { key: "nb", style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" } },
						balance.error || _dsht("plugin.usage_stats.hint_no_deepseek", "当前非 DeepSeek 账户，或未在设置面板配置 API Key，无法读取余额（余额查询仅对 DeepSeek 生效，其余功能不受影响）"));
				} else if (balance.ok !== true) {
					body = react.createElement("div", { key: "fb", style: { fontSize: 12, color: "var(--dsw-alias-state-error-primary)" } },
						balance.error || _dsht("plugin.usage_stats.hint_balance_fail", "余额查询失败"));
				} else {
					const info = pickBalanceInfo(balance);
					if (!info) {
						body = react.createElement("div", { key: "nb", style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" } }, _dsht("plugin.usage_stats.hint_no_balance_detail", "DeepSeek 未返回余额明细"));
					} else {
						const symbol = currencySymbol();
						const available = (balance.balance && balance.balance.is_available === true) ? _dsht("plugin.usage_stats.label_yes", "可用") : _dsht("plugin.usage_stats.label_no", "不可用");
						body = react.createElement("div", { key: "bb", style: { display: "flex", gap: 24, flexWrap: "wrap", fontSize: 12 } }, [
							balanceStat(_dsht("plugin.usage_stats.label_total_balance", "总余额"), symbol + fmtBalance(info.total_balance)),
							balanceStat(_dsht("plugin.usage_stats.label_recharge_balance", "充值余额"), symbol + fmtBalance(info.topped_up_balance)),
							balanceStat(_dsht("plugin.usage_stats.label_promo_balance", "赠金余额"), symbol + fmtBalance(info.granted_balance)),
							balanceStat(_dsht("plugin.usage_stats.label_api_available", "API 可用"), available),
						]);
					}
				}
				return react.createElement("div", { key: "balcard", style: cardStyle }, [
					react.createElement("div", { key: "h", style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 } }, [
						react.createElement("span", { key: "t", style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, _dsht("plugin.usage_stats.label_balance", "余额（DeepSeek 实时）")),
						react.createElement("button", { key: "r", type: "button", disabled: balanceBusy, onClick: () => loadBalance(true), style: { ...btn, fontSize: 11, padding: "2px 8px" } },
							balanceBusy ? _dsht("plugin.usage_stats.btn_querying", "查询中…") : _dsht("plugin.usage_stats.btn_refresh_balance", "刷新余额")),
					]),
					body,
				]);
			})();

			// ---- 今日消耗卡 (后端按事件时刻/峰谷聚合) ----
			const todayCard = (() => {
				if (todayData === null) return null;
				const headerChildren = [
					react.createElement("span", { key: "t", style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, _dsht("plugin.usage_stats.label_today_cost", "今日消耗")),
				];
				if (priceInfo && priceInfo.currentTier === "peak") {
					headerChildren.push(react.createElement("span", { key: "tier", style: { fontSize: 11, marginLeft: 8, color: "var(--dsw-alias-state-warn-primary)", fontWeight: 500 } }, _dsht("plugin.usage_stats.tier_peak_now", "当前高峰时段")));
				} else {
					headerChildren.push(react.createElement("span", { key: "tier", style: { fontSize: 11, marginLeft: 8, color: "var(--dsw-alias-state-success-primary)", fontWeight: 500 } }, _dsht("plugin.usage_stats.tier_offpeak_now", "当前低谷时段")));
				}
				return react.createElement("div", { key: "todaycard", style: cardStyle }, [
					react.createElement("div", { key: "h", style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 } }, [
						react.createElement("span", { key: "ct", style: { display: "flex", alignItems: "center" } }, headerChildren),
					]),
					react.createElement("div", { key: "b", style: { display: "flex", gap: 24, flexWrap: "wrap", fontSize: 12 } }, [
						statCell(_dsht("plugin.usage_stats.label_cost", "估算费用"), fmtCost(todayData.cost)),
						statCell(_dsht("plugin.usage_stats.label_input", "输入"), fmtInt(todayData.input)),
						statCell(_dsht("plugin.usage_stats.label_output_short", "输出"), fmtInt(todayData.output)),
						statCell(_dsht("plugin.usage_stats.label_cache", "缓存"), fmtInt(todayData.cacheRead + todayData.cacheWrite)),
						statCell(_dsht("plugin.usage_stats.label_reasoning", "思考推理"), fmtInt(todayData.reasoning)),
						statCell(_dsht("plugin.usage_stats.label_today_calls", "调用数"), fmtInt(todayData.calls)),
					]),
				]);
			})();

			// ---- 近 180 天热力图 (GitHub 风格, 支持横向滚动 + 日期标注) ----
			const heatmapCard = (() => {
				if (!Array.isArray(daysData) || daysData.length === 0) return null;
				// 找出最大日费用 (空天不计), 用于颜色 5 档分级。
				let maxCost = 0;
				for (const day of daysData) {
					const cost = Number(day && day.cost) || 0;
					if (cost > maxCost) maxCost = cost;
				}
				const levelOf = (cost) => {
					if (!(cost > 0) || maxCost <= 0) return 0;
					const ratio = cost / maxCost;
					if (ratio > 0.75) return 4;
					if (ratio > 0.5) return 3;
					if (ratio > 0.25) return 2;
					return 1;
				};
				const cells = daysData.map((day) => {
					const cost = Number(day && day.cost) || 0;
					return { date: day.date, cost, tokens: (Number(day.input) || 0) + (Number(day.output) || 0) };
				});
				// 按【自然周】(周日为一周起点) 对齐成网格: 列 = 自然周, 行 = 星期几 (0=周日 … 6=周六)。
				// 关键: 不能用"每满 7 个切一列"的纯顺序切块——那会把自然周从周中切开, 日期错位。
				// 用第一个日期所在周的周日作为基准, 每个 cell 按度过多少天归入正确的周列。
				const weekdayOf = (dateStr) => {
					const utcMs = Date.parse(dateStr + "T00:00:00Z");
					const beijingMs = utcMs + 8 * 3600000;
					return new Date(beijingMs).getUTCDay(); // 0=周日 … 6=周六
				};
				const dayMsOf = (dateStr) => Date.parse(dateStr + "T00:00:00Z");
				const dayBaseOf = (dateStr) => Math.floor((dayMsOf(dateStr) + 8 * 3600000) / 86400000); // 北京日历日 index
				// 第一个日期所在那一周的周日 (北京日历日 index)。
				const firstDayBase = dayBaseOf(cells[0].date);
				const firstWeekday = weekdayOf(cells[0].date);
				const firstSundayBase = firstDayBase - firstWeekday;
				// 遍历 (cells 按日期升序且无缺天): 每个 cell 归入 {(dayBase-firstSundayBase)/7} 列的星期几行。
				const grid = [];
				for (const cell of cells) {
					const dayBase = dayBaseOf(cell.date);
					const weekIndex = Math.floor((dayBase - firstSundayBase) / 7);
					const rowIndex = weekdayOf(cell.date);
					if (grid[weekIndex] === void 0) grid[weekIndex] = new Array(7).fill(null);
					grid[weekIndex][rowIndex] = cell;
				}
				const colorLevels = ["var(--dsw-alias-bg-secondary)", "#2e7d32", "#66bb6a", "#aed581", "#fbc02d"];
				const weekdayChinese = ["日", "一", "二", "三", "四", "五", "六"];
				const cellBox = (cell, rowIndex) => {
						// 该周该星期无数据 (如首/末列不完整): 空白兜底, 防访问属性抛错。
						const cellSafe = cell || { date: "_empty", cost: 0, tokens: 0 };
						const styleCell = {
							width: 12,
							height: 12,
							boxSizing: "border-box", // 边框不撑大格子, 保持 12px 网格对齐
							borderRadius: 2,
							// 空格子用透明底 + 细边框, 让每个格子清晰可分; 有热度时填色。
							background: cellSafe.cost > 0 ? colorLevels[levelOf(cellSafe.cost)] : "transparent",
							border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))",
							margin: 1,
						};
						return react.createElement("div", {
							key: cellSafe.date,
							style: styleCell,
							title: _dsht("plugin.usage_stats.heatmap_tip", "{date}: ¥{cost} · {tokens} tokens").replace("{date}", cellSafe.date).replace("{cost}", (cellSafe.cost || 0).toFixed(4)).replace("{tokens}", fmtInt(cellSafe.tokens)),
						});
					};
				// 顶部月份标注: 每列取该周第一个有数据的 cell 的月份, 变化时显示 (跨月处)。
				const monthOf = (dateStr) => {
					const parts = String(dateStr).split("-");
					return parts.length === 3 ? parts[1] : "";
				};
				const monthLabels = [];
				let lastMonth = "";
				for (let index = 0; index < grid.length; index += 1) {
					const firstCell = grid[index].find((cell) => cell !== null);
					const month = firstCell ? monthOf(firstCell.date) : "";
					monthLabels.push(month !== "" && month !== lastMonth ? month : "");
					if (month !== "") lastMonth = month;
				}
				const cellSize = 14; // 12px 方块 + 2px margin
				return react.createElement("div", { key: "heatmap", style: cardStyle }, [
					react.createElement("div", { key: "h", style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 } }, [
						react.createElement("span", { key: "t", style: { fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } }, _dsht("plugin.usage_stats.label_heatmap", "近 180 天消耗热力图")),
					]),
					// 可横向滚动容器 (等宽网格超出面板宽度时出现滚动条)。
					react.createElement("div", { key: "scroll", style: { overflowX: "auto", width: "100%", paddingBottom: 4 } }, [
						react.createElement("div", { key: "inner", style: { display: "flex", width: 26 + (grid.length - 1) * cellSize + cellSize } }, [
							// 左侧固定星期列 (日~六)
							react.createElement("div", { key: "wklbl", style: { display: "flex", flexDirection: "column", marginRight: 6 } },
								[].concat(["", ...weekdayChinese]).map((label, index) =>
									react.createElement("span", {
										key: "wk" + index,
										style: { width: 14, height: 14, fontSize: 9, lineHeight: "14px", textAlign: "center", color: "var(--dsw-alias-label-tertiary)" },
									}, label)
								)
							),
							// 网格区
							react.createElement("div", { key: "gridwrap", style: { display: "flex", flexDirection: "column" } }, [
								// 月份标注行
								react.createElement("div", { key: "months", style: { display: "flex", height: 14, fontSize: 9, color: "var(--dsw-alias-label-tertiary)" } },
									monthLabels.map((label, index) =>
										react.createElement("span", { key: "mo" + index, style: { width: cellSize, fontSize: 9, overflow: "hidden", whiteSpace: "nowrap" } }, label)
									)
								),
								// 周 → 7 行 (周日至周六), 每行列宽等宽
								react.createElement("div", { key: "weeks" }, grid.map((rows, columnIndex) =>
									react.createElement("div", { key: "col" + columnIndex, style: { display: "flex", flexDirection: "column", float: "left" } },
										rows.map((cell, rowIndex) => cellBox(cell, rowIndex))
									)
								)),
							]),
						]),
					]),
					react.createElement("div", { key: "legend", style: { marginTop: 6, fontSize: 11, color: "var(--dsw-alias-label-tertiary)", display: "flex", alignItems: "center", gap: 4 } }, [
						react.createElement("span", { key: "l0" }, _dsht("plugin.usage_stats.heatmap_legend", "少")),
						...colorLevels.map((color, index) =>
							react.createElement("span", { key: "lc" + index, style: { display: "inline-block", width: 10, height: 10, borderRadius: 2, background: color, margin: "0 1px" } })
						),
						react.createElement("span", { key: "l1" }, _dsht("plugin.usage_stats.heatmap_legend_more", "多")),
					]),
				]);
			})();

			return react.createElement("div", { style: rootStyle }, [
				react.createElement("p", { key: "title", style: titleStyle }, _dsht("plugin.usage_stats.title", "用量统计")),
				react.createElement("p", { key: "desc", style: descStyle },
					_dsht("plugin.usage_stats.desc", "扫描本机全部会话日志，按模型汇总每次模型调用的 token 用量（输入 / 输出 / 缓存读取 / 缓存写入 / 思考推理）。费用按 DeepSeek 官方计费口径估算：输入（未命中缓存）+ 输入（命中缓存）+ 输出，各自 ÷1e6 × 单价；思考 token 已计入输出、不重复计费。价格表可在下方编辑并保存（仅存于本浏览器，默认按官方高峰时段价，请按实际价格/时段修改）。当前服务运行中的会话可能仍在写入，统计为截至刷新时的数据。")
				),

				error !== null && react.createElement("p", { key: "err", style: { color: "var(--dsw-alias-state-error-primary)", margin: 0, fontSize: 13 } }, error),

				// 真实余额卡 (位于总览上方)
				balanceCard,

				// 今日消耗卡 + 近 60 天热力图
				todayCard,
				heatmapCard,

				// 总览
				overview !== null && react.createElement("div", { key: "ov", style: cardStyle }, [
					react.createElement("div", { key: "row1", style: { display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 8 } }, [
						statCell(_dsht("plugin.usage_stats.label_session_count", "会话数"), fmtInt(sessions.length)),
						statCell(_dsht("plugin.usage_stats.label_turn_count", "回合总数"), fmtInt(overview.turnCount)),
						statCell(_dsht("plugin.usage_stats.label_input_tokens", "输入 tokens"), fmtInt(overview.total.inputTokens)),
						statCell(_dsht("plugin.usage_stats.label_output_tokens", "输出 tokens"), fmtInt(overview.total.outputTokens)),
						statCell(_dsht("plugin.usage_stats.label_cache_read", "缓存读取"), fmtInt(overview.total.cacheReadTokens)),
						statCell(_dsht("plugin.usage_stats.label_cache_write", "缓存写入"), fmtInt(overview.total.cacheWriteTokens)),
						statCell(_dsht("plugin.usage_stats.label_reasoning", "思考推理"), fmtInt(overview.total.reasoningTokens)),
						statCell(_dsht("plugin.usage_stats.label_cost", "估算费用"), fmtCost(overview.cost)),
					]),
					react.createElement("div", { key: "row2", style: { display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: "var(--dsw-alias-label-secondary)" } },
						Object.keys(overview.perModel).map((model) =>
							react.createElement("span", { key: model, style: { fontFamily: "Consolas, Menlo, monospace" } },
								model + ": " + _dsht("plugin.usage_stats.label_input", "输入") + " " + fmtInt(overview.perModel[model].inputTokens) +
								_dsht("plugin.usage_stats.label_output_short", "输出") + " " + fmtInt(overview.perModel[model].outputTokens) +
								_dsht("plugin.usage_stats.label_cache", "缓存") + " " + fmtInt(overview.perModel[model].cacheReadTokens + overview.perModel[model].cacheWriteTokens) +
								_dsht("plugin.usage_stats.label_cost", "估算费用").replace("费用","") + fmtCost(costOf(overview.perModel[model], prices, model))
							)
						)
					),
				]),

				// 价格表 (可折叠)
				react.createElement("details", { key: "prices", style: cardStyle }, [
					react.createElement("summary", { key: "s", style: { cursor: "pointer", fontWeight: 600, fontSize: 13, color: "var(--dsw-alias-label-primary)" } }, _dsht("plugin.usage_stats.label_price_table", "价格表（费用估算用）")),
					react.createElement("div", { key: "b", style: { marginTop: 8 } },
						prices !== null && react.createElement(PriceEditor, {
							prices,
							setPrices,
							onChange: (next) => setPrices(next),
							officialInfo: priceInfo,
							onRefreshOfficial: refreshOfficialPrices,
							refreshing: priceBusy,
						})
					),
				]),

				// 会话列表 (卡片式, 标题独占一行)
				react.createElement("div", { key: "list" }, [
					sessions === null && !error && react.createElement("div", { key: "loading", style: { padding: 12, color: "var(--dsw-alias-label-tertiary)" } }, _dsht("plugin.usage_stats.btn_loading", "加载中…")),
					Array.isArray(sessions) && sessions.length === 0 && !error && react.createElement("div", { key: "empty", style: { padding: 12, color: "var(--dsw-alias-label-tertiary)" } }, _dsht("plugin.usage_stats.empty_no_sessions", "没有找到任何会话。")),
					sessionCards,
				]),

				// 操作行
				react.createElement("div", { key: "ops", style: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" } }, [
					react.createElement("button", { key: "refresh", type: "button", disabled: busy, onClick: loadList, style: { ...btn, padding: "6px 16px" } },
						busy ? _dsht("plugin.usage_stats.btn_scanning", "扫描中…") : _dsht("plugin.usage_stats.btn_refresh_stats", "刷新统计")
					),
					react.createElement("span", { key: "tip", style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } }, _dsht("plugin.usage_stats.hint_logs_large", "日志较大时会话多时扫描可能需要几秒")),
				]),
			]);
		}

		// ---- 消息行「本次token」显示 (conversation.chat.turnTail 链式插槽) ----

		/**
		 * 汇总某个回合所有助手消息的 usage。
		 * 数据源兼容两代 dsh 快照结构:
		 *   - rc.6: 顶层兼容字段 snapshot.nodes (ConversationSnapshot, AssistantMessageNode 数组)
		 *           + snapshot.chat.nodes (ChatNodeStore) 兜底;
		 *   - 0.1.2+: chat.legacy.nodes (ChatSnapshot, ConversationNode 数组, 官方 StatsLine 同源)
		 *           + chat.nodes (ChatNodeStore) 兜底。
		 * 返回: 该回合汇总 totals + perModel (按模型分组的 usage, 用于按模型分别计价,
		 * 模型名取节点 provenance.model, 缺失归 "unknown")。
		 */
		function sumTurnUsage(data, turnNum) {
			// 兼容两种快照形态的 legacy 节点数组
			const nodes = data && Array.isArray(data.nodes) ? data.nodes
				: (data && data.legacy && Array.isArray(data.legacy.nodes)) ? data.legacy.nodes
				: [];
			// 兼容两种快照形态的 ChatNodeStore
			const store = data && data.nodes && typeof data.nodes.values === "function" ? data.nodes
				: (data && data.chat && data.chat.nodes && typeof data.chat.nodes.values === "function") ? data.chat.nodes
				: null;

			const accumulate = (u) => {
				total.found = true;
				total.inputTokens += num(u.inputTokens);
				total.outputTokens += num(u.outputTokens);
				total.cacheReadTokens += num(u.cacheReadTokens);
				total.cacheWriteTokens += num(u.cacheWriteTokens);
				total.reasoningTokens += num(u.reasoningTokens);
			};
			const accumulateModel = (u, model) => {
				if (!total.perModel[model]) {
					total.perModel[model] = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
				}
				const m = total.perModel[model];
				m.inputTokens += num(u.inputTokens);
				m.outputTokens += num(u.outputTokens);
				m.cacheReadTokens += num(u.cacheReadTokens);
				m.cacheWriteTokens += num(u.cacheWriteTokens);
				m.reasoningTokens += num(u.reasoningTokens);
			};
			const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, found: false, perModel: {} };

			// ① legacy 节点数组 (已完成的 AssistantMessageNode, 含 usage/provenance)
			for (const n of nodes) {
				if (!n || n.kind !== "assistant") continue;
				if (typeof n.turn !== "number" || n.turn !== turnNum) continue;
				const u = n.usage;
				if (!u || typeof u !== "object") continue;
				accumulate(u);
				const model = (n.provenance && typeof n.provenance.model === "string" && n.provenance.model) || "unknown";
				accumulateModel(u, model);
			}

			// ② 兜底: chat 视图实时节点库 (assistant-step 的 finalNode / turn-tail 的 closing.finalNode)
			if (!total.found && store) {
				try {
					for (const viewNode of store.values()) {
						if (!viewNode || typeof viewNode !== "object") continue;
						const d = viewNode.data;
						const fn = d && (d.finalNode || (d.closing && d.closing.finalNode));
						if (!fn || typeof fn !== "object") continue;
						if (fn.kind !== "assistant" || typeof fn.turn !== "number" || fn.turn !== turnNum) continue;
						const u = fn.usage;
						if (!u || typeof u !== "object") continue;
						accumulate(u);
						const model = (fn.provenance && typeof fn.provenance.model === "string" && fn.provenance.model) || "unknown";
						accumulateModel(u, model);
					}
				} catch (e) { /* 节点库不可用时忽略 */ }
			}
			return total;
		}

		/** 回合 token 用量显示 (带「本次token：」前缀, 右对齐, 无数据时静默不渲染)。 */
		function TurnTokens(props) {
		const [i18nTick, setI18nTick] = react.useState(0);
		react.useEffect(() => {
			const handler = () => setI18nTick(t => t + 1);
			document.addEventListener('dsh-i18n-change', handler);
			return () => document.removeEventListener('dsh-i18n-change', handler);
		}, []);
			const useSession = props.useSession;
			const useChat = props.useChat;
			const matched = props.matched;

			// 兼容两代 turnTail 插槽 owner 结构 (官方 0.1.6 契约变更):
			//   - 旧版: owner.matched = { turn: number }
			//   - 新版: owner.turn = TurnLocation 对象 (turn: number, start/end 事件), owner.seq 为 closing seq
			const turnObj = (matched && matched.turn) || props.turn;
			const turnNum = typeof turnObj === "number" ? turnObj : (turnObj && typeof turnObj.turn === "number" ? turnObj.turn : null);

			// 真实余额 (DeepSeek 账户)/预估消耗一起展示: 需在条件 return 之前声明 hook, 保证 hooks 顺序稳定
			const [balance, setBalance] = react.useState(null);
			react.useEffect(() => {
				let alive = true;
				(async () => {
					// 全程 try/catch: 非 DeepSeek 账户读取失败也绝不当成崩溃来源 (unhandled rejection)
					try {
						const payload = await getBalanceCached(false);
						if (alive) setBalance(payload);
					} catch (err) {
						if (alive) setBalance({ ok: false, configured: false, error: String((err && err.message) || err) });
					}
				})();
				return () => { alive = false; };
			}, []);

			// 防御: standard kit 缺失时静默不渲染 (0.1.2+ 提供 useChat, rc.6 提供 useSession)
			if ((!useSession || typeof useSession !== "function") && (!useChat || typeof useChat !== "function")) return null;

			if (turnNum === null) return null;

			// 取会话/聊天数据: 0.1.2+ 用 useChat (ChatSnapshot: chat.legacy.nodes / chat.nodes),
			// rc.6 用 useSession (ConversationSnapshot: nodes / chat.nodes); sumTurnUsage 兼容两种形态。
			const data = (useChat && typeof useChat === "function") ? useChat((s) => s) : useSession((s) => s);
			const usage = sumTurnUsage(data, turnNum);
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
			if (missStr && missTotal > 0) parts.push(_dsht("plugin.usage_stats.turn_input_miss", "输入(未命中) ") + missStr);
			if (hitStr && usage.cacheReadTokens > 0) parts.push(_dsht("plugin.usage_stats.turn_input_hit", "输入(命中缓存) ") + hitStr);
			if (outStr) parts.push(_dsht("plugin.usage_stats.turn_output", "输出 ") + outStr);
			if (reasonStr && usage.reasoningTokens > 0) parts.push(_dsht("plugin.usage_stats.turn_reasoning", "思考 ") + reasonStr);
			if (cost > 0) parts.push(_dsht("plugin.usage_stats.turn_cost", "费用约 ") + fmtCost(cost));

			// 追加真实余额 (账户扣款后的实时余额), 与预估消耗一起展示; 无有效余额/未配置时不显示该项
			if (balance && balance.ok === true) {
				const info = pickBalanceInfo(balance);
				if (info) {
					const symbol = info.currency === "USD" ? "$" : "¥";
					parts.push(_dsht("plugin.usage_stats.turn_balance", "余额 ") + symbol + fmtBalance(info.total_balance));
				}
			}

			if (parts.length === 0) return null;

			return react.createElement("div", {
				title: _dsht("plugin.usage_stats.turn_title_hint", "该回合实际消耗的 token 与预估费用（token 按 DeepSeek 官方计费口径分类：输入分未命中/命中缓存，思考(reasoning) 已计入输出不重复计费；费用按价格表估算，可在 设置 → 用量统计 调整价格；余额为 DeepSeek 账户实时余额）"),
				style: {
					display: "flex",
					justifyContent: "flex-end",
					gap: 4,
					fontSize: 11,
					lineHeight: 1.5,
					color: "var(--dsw-alias-label-secondary, #8a8f98)",
				},
			}, [
				react.createElement("span", { key: "prefix", style: { flex: "none" } }, _dsht("plugin.usage_stats.label_this_turn", "本次token：")),
				react.createElement("span", { key: "vals" }, parts.join(" · ")),
			]);
		}

		function apply(ctx) {
			function _doRegisterUsageStatsSection() {
			    ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "usage-stats",
				order: 510,
				label: () => _tabLabel("plugin.usage_stats.title", "用量统计"),
			}, UsageStatsSection));
			}
			if (window.__DSH_I18N__ && window.__DSH_I18N__._initialized) {
			    _doRegisterUsageStatsSection();
			} else {
			    var _checkUsageStatsSection = setInterval(function() {
			        if (window.__DSH_I18N__ && window.__DSH_I18N__._initialized) {
			            clearInterval(_checkUsageStatsSection);
			            _doRegisterUsageStatsSection();
			        }
			    }, 50);
			    }

			// 消息行「本次token」显示: 注册到官方 conversation.chat.turnTail (list 型插槽)。
			// 注意 (0.1.6 契约): list 型插槽必须给 id, 否则 register 抛 SlotAssemblyError
			// 被 SlotErrorBoundary 吞掉 → 静默不渲染。list 不走 select, 组件直接收到
			// ownerProps { turn: TurnLocation对象, seq, openFile } + 标准 hook props (useChat/useSession)。
			ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register(
				{
					name: "conversation.chat.turnTail",
					id: "dsh-usage-stats-turn-tail",
					priority: -10,
				},
				(props) => react.createElement(TurnTokens, props),
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
