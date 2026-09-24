// DeepSeek Harness 插件 (宿主端): dsh-usage-stats
// 在 WebUI 设置页提供「用量统计」的数据后端:
//   直接按磁盘扫描会话日志 (DSH_HOME/sessions/**/session.jsonl.zstd),
//   解码出每条 assistant/message 事件携带的 usage 数据
//   (inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens / reasoningTokens),
//   按模型聚合到会话级与回合级, 供前端展示 token 用量与费用估算。
// 2026-09 起新增: 官方定价页自动同步 (启动静默拉取 / 手动刷新), 峰谷两档计费
// (按每条消息的 time 判定高峰/低谷, 周末全谷), 按日聚合 (今日消耗 + 近 180 天热力图)。
// 费用估算在后端按事件时刻的峰谷档计算 (front 端消息行仍按当前时刻档估算)。
//
// 提供的接口 (路由 /__dsh/usage-stats/*, 均要求自定义头 X-DSH-Usage-Stats: 1):
//   GET /__dsh/usage-stats/list           -> 全部会话用量汇总 + price/today/days 顶层统计
//   GET /__dsh/usage-stats/detail         -> 单个会话的逐回合用量明细
//   GET /__dsh/usage-stats/balance        -> DeepSeek 账户余额
//   GET /__dsh/usage-stats/pricing        -> 当前生效价格表 + 来源 + 峰谷档
//   POST /__dsh/usage-stats/pricing-refresh -> 手动强制刷新官方价格
// 不修改任何官方文件/包。
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import zlib from "node:zlib";

// 兼容说明 (dsh 0.1.5-alpha.1):
//   dsh-session 在 v3 移除了 decodeStorageRecord 导出符号, 直接把会话日志按磁盘扫描解码.
//   lib 底部 decodeLog 用自包含的 adoptPhysicalRow 做跨版本容错解码, 不再依赖任何内部导出,
//   因此这里不 import @deepseek-ai/dsh-session, 避免旧/新版差异导致插件加载失败.
const name = "dsh-usage-stats";
const inject = ["webServer", "workspaceRegistry", "sessionQuery", "sessions"];

const ROUTE_LIST = "/__dsh/usage-stats/list";
const ROUTE_DETAIL = "/__dsh/usage-stats/detail";
const ROUTE_BALANCE = "/__dsh/usage-stats/balance";
const ROUTE_PRICING = "/__dsh/usage-stats/pricing";
const ROUTE_PRICING_REFRESH = "/__dsh/usage-stats/pricing-refresh";
const GUARD_HEADER = "x-dsh-usage-stats";

// DeepSeek 官方余额查询接口 (https://api-docs.deepseek.com/zh-cn/api/get-user-balance/)
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const USAGE_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"];

// ---- 官方定价同步与峰谷计费 (2026-09, 参考第三方插件 dsh-cost-meter) ----
// 官方定价页 (中文页, 服务端预渲染, 可直接 fetch 解析; 金额为人民币元)。
const OFFICIAL_PRICING_URL_ZH = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing";
// 从表头单元格中识别模型 id 的正则。
const DEEPSEEK_MODEL_ID_RE = /deepseek-[a-z0-9_.-]+/i;
// 高峰时段窗口 (UTC 小时, 半开区间 [start, end))。
// 对应北京时间 9:00-12:00 与 14:00-18:00。
const DEFAULT_PEAK_WINDOWS = [
	{ start: 1, end: 4 },
	{ start: 6, end: 10 },
];
// 周末全谷价生效时刻 (UTC): 2026-08-23 (周日) 00:00 北京时间。
// 自此北京周六/周日全天不再区分峰谷, 统一按谷价计费。
const WEEKEND_OFFPEAK_EFFECTIVE_AT = "2026-08-22T16:00:00Z";

/**
 * 内置默认价格表 (CNY / 每百万 tokens, 2026-09-21 实抓官方中文定价页)。
 * 结构: 每个模型含 offPeak(低谷/空闲) 与 peak(高峰) 两档三桶 (cacheHit/cacheMiss/output)。
 * 官方口径: 高峰价格为低谷的 2 倍; 周末全天为低谷价。
 * 模型 id 说明: deepseek-flash 为当前主力 id; 历史/退役 id (deepseek-v4-flash /
 * deepseek-v4-flash-vision-exp / deepseek-v4.1-flash) 由 V4.1-Flash 服务并按 flash 价
 * 计, 故三者共用同一单价。deepseek-v4-pro 自 2026-09-14 起也路由到 flash 计价,
 * 本表先保留其自身单价, 待退役完成后按实际账单调整。
 */
function buildBundledTable() {
	const flashTier = {
		offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
		peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
	};
	const proTier = {
		offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
		peak: { cacheHit: 0.30, cacheMiss: 9, output: 27 },
	};
	return {
		models: {
			"deepseek-flash": flashTier,
			"deepseek-v4-pro": proTier,
			// 历史/退役 id 别名, 与 flash 同价
			"deepseek-v4-flash": flashTier,
			"deepseek-v4-flash-vision-exp": flashTier,
			"deepseek-v4.1-flash": flashTier,
		},
		fallback: flashTier,
	};
}
const BUNDLED_PRICE_TABLE = buildBundledTable();

/**
 * 当前价格状态: 启动时静默拉官方价覆盖为 source=official; 失败保留内置表。
 * 用户前端手动编辑的价格永远优先 (前端 localStorage 覆盖, 后端 refetch 不覆盖用户自定义值)。
 */
const priceState = {
	table: BUNDLED_PRICE_TABLE,  // 当前生效表 { models, fallback }
	theme: null,                 // 未启用
	source: "bundled",           // bundled(内置) | official(官方同步)
	fetchedAt: null,             // 最近一次官方同步时间 (ISO 字符串)
	pendingRefresh: null,        // 在途的刷新 Promise (防并发重复拉取)
};

/** 从价格表里按模型 id 取价格条目, 未知模型回退 fallback。 */
function priceEntryFor(modelId, table) {
	const models = table && table.models;
	if (typeof modelId === "string" && modelId.length > 0 && models !== null && typeof models === "object"
		&& Object.prototype.hasOwnProperty.call(models, modelId)) {
		return models[modelId];
	}
	const fallback = table && table.fallback;
	return fallback || BUNDLED_PRICE_TABLE.fallback;
}

/** 把官方页解析结果规整成统一表形状 ({ models, fallback })。 */
function normalizeOfficialTable(fetched) {
	const models = fetched.models;
	const firstId = Object.keys(models)[0];
	const fallback = models[firstId] || BUNDLED_PRICE_TABLE.fallback;
	return { models, fallback };
}

function dshHome() {
	return process.env.DSH_HOME || join(homedir(), ".dsh");
}

/**
 * 读取 DeepSeek API Key。
 * 优先级: ① 运行进程环境变量 DEEPSEEK_API_KEY; ② DSH_HOME/.credentials.yaml 的 refs.DEEPSEEK_API_KEY
 * (用户在 WebUI 设置面板里配置的 key 由 harness 持久化到该 yaml)。
 * 读不到返回 null (前端据此提示未配置)。
 */
async function readApiKey() {
	const fromEnv = process.env.DEEPSEEK_API_KEY;
	if (fromEnv && typeof fromEnv === "string" && fromEnv.trim().length > 0) {
		return fromEnv.trim();
	}
	try {
		const raw = await readFile(join(dshHome(), ".credentials.yaml"), "utf8");
		const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // 去 UTF-8 BOM
		const match = text.match(/^\s*DEEPSEEK_API_KEY\s*:\s*(\S+)\s*$/m);
		if (match !== null && typeof match[1] === "string" && match[1].length > 0) {
			return match[1];
		}
	} catch {
		// 忽略: 读不到文件就当未配置
	}
	return null;
}

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(body);
}

/* ===================== 官方定价页解析 (零依赖, 参考 dsh-cost-meter) ===================== */

/** 去掉单元格内 HTML 标签与实体, 返回纯文本。 */
function stripHtmlTags(html) {
	return String(html).replace(/<[^>]*>/g, "").replace(/&[a-zA-Z#0-9]+;/g, " ").trim();
}

/** 把 HTML 里的 <table> 拆成二维数组 (行 → 单元格文本)。 */
function parsePricingTables(html) {
	const tables = String(html).match(/<table[\s\S]*?<\/table>/gi) || [];
	return tables.map((tableHtml) => {
		const rows = [];
		const rowMatches = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [];
		for (const rowHtml of rowMatches) {
			const cellMatches = rowHtml.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
			const row = cellMatches.map((cellHtml) => stripHtmlTags(cellHtml));
			if (row.length > 0) rows.push(row);
		}
		return rows;
	});
}

/** 从单元格文本里提取人民币金额 (形如 "0.02元" / "1元"), 失败返回 null。 */
function parseCnyMoney(cellText) {
	const match = /([0-9]+(?:\.[0-9]+)?)\s*元/.exec(cellText || "");
	if (match === null) return null;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : null;
}

/**
 * 解析官方中文定价页 HTML, 返回 { models, currency }。
 * 页面为一张表: 表头行 [模型, <模型id>...]; 每个指标 (缓存命中/未命中/输出) 下
 * 有 "空闲时段" 与 "高峰时段" 两行价格。首两格为 rowspan 合并, 高峰行无指标标签,
 * 沿用上一行指标。模型 id 由契据正则从表头提取; 币种固定 CNY (中文页金额后带 "元")。
 */
function parsePricingHtmlZh(html) {
	const tables = parsePricingTables(html);
	const modelIds = [];
	// tiers[metric] = { offPeak: number[], peak: number[] } (按模型在表头中的顺序)。
	const tiers = {};
	const metricOf = (textValue) => {
		const upper = String(textValue || "").toUpperCase();
		if (upper.indexOf("缓存未命中") !== -1) return "cacheMiss";
		if (upper.indexOf("缓存命中") !== -1) return "cacheHit";
		// 输出行须含 "token"，避免误吞「输出长度」规格行。
		if (upper.indexOf("TOKEN") !== -1 && String(textValue || "").indexOf("输出") !== -1) return "output";
		return null;
	};
	for (const rows of tables) {
		let lastMetric = null;
		for (let i = 0; i < rows.length; i += 1) {
			const row = rows[i];
			const firstCell = String(row[0] || "").trim();
			// 模型表头行 "模型" 后跟全部模型 id。
			if (firstCell === "模型") {
				const ids = row.slice(1).map((cell) => {
					const match = DEEPSEEK_MODEL_ID_RE.exec(cell || "");
					return match === null ? null : match[0];
				}).filter((value) => value !== null);
				if (ids.length > 0) {
					modelIds.splice(0, modelIds.length, ...ids);
				}
				continue;
			}
			// 指标标签可能在本行任意单元格; 高峰行无标签时沿用上一行指标。
			const metric = metricOf(row.join(" ")) || lastMetric;
			if (metric !== null) lastMetric = metric;
			// 档位标签 "空闲时段"/"高峰时段", 价格紧跟其后。
			const tierIndex = row.findIndex((cell) => {
				const text = String(cell || "").trim();
				return text === "空闲时段" || text === "高峰时段";
			});
			if (tierIndex < 0) continue;
			if (metric === null || modelIds.length === 0) continue;
			const tierText = String(row[tierIndex] || "").trim();
			const tierLabel = tierText === "高峰时段" ? "peak" : "offPeak";
			const moneyValues = row.slice(tierIndex + 1, tierIndex + 1 + modelIds.length).map(parseCnyMoney);
			if (moneyValues.some((value) => value === null)) continue;
			if (tiers[metric] === undefined) tiers[metric] = { offPeak: [], peak: [] };
			tiers[metric][tierLabel] = moneyValues;
		}
	}
	const models = {};
	for (let index = 0; index < modelIds.length; index += 1) {
		const id = String(modelIds[index]).toLowerCase();
		const offPeak = {
			cacheHit: tiers.cacheHit && tiers.cacheHit.offPeak[index],
			cacheMiss: tiers.cacheMiss && tiers.cacheMiss.offPeak[index],
			output: tiers.output && tiers.output.offPeak[index],
		};
		const peak = {
			cacheHit: tiers.cacheHit && tiers.cacheHit.peak[index],
			cacheMiss: tiers.cacheMiss && tiers.cacheMiss.peak[index],
			output: tiers.output && tiers.output.peak[index],
		};
		if (offPeak.cacheMiss === undefined || peak.cacheMiss === undefined) continue;
		models[id] = { offPeak, peak };
	}
	if (Object.keys(models).length === 0) {
		throw new Error("unable to parse pricing table");
	}
	return { models, currency: "CNY" };
}

/**
 * 拉取官方定价页并解析。任何失败 (网络/解析/超时) 静默返回 null, 调用方回退内置表。
 */
async function fetchOfficialPricing() {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 8000);
	try {
		const response = await fetch(OFFICIAL_PRICING_URL_ZH, {
			headers: { Accept: "text/html" },
			signal: controller.signal,
		});
		if (!response.ok) return null;
		const html = await response.text();
		const parsed = parsePricingHtmlZh(html);
		return {
			models: parsed.models,
			currency: parsed.currency,
			fetchedAt: new Date().toISOString(),
			source: "official",
		};
	} catch (error) {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 确保价格表已同步官方: 初始 (no-force) 且未同步过才拉取; force 时强制重拉。
 * 返回当前 priceState; 在途中合并并发调用 (只保留一个在途 Promise)。
 */
async function ensureOfficialPrices(force) {
	if (force !== true && priceState.source === "official") return priceState;
	if (priceState.pendingRefresh !== null) return priceState.pendingRefresh;
	priceState.pendingRefresh = (async () => {
		const fetched = await fetchOfficialPricing();
		if (fetched !== null) {
			priceState.table = normalizeOfficialTable(fetched);
			priceState.source = "official";
			priceState.fetchedAt = fetched.fetchedAt;
		}
		return priceState;
	})().finally(() => {
		priceState.pendingRefresh = null;
	});
	return priceState.pendingRefresh;
}

/* ===================== 峰谷判定与按事件时刻计费 ===================== */

/**
 * 北京周六/周日全谷区间 (UTC ms; 北京日历日界 = UTC+8)。
 * 周末区间 [周 0:00, 周一 0:00) (生效后); 非周末或生效前返回 null。
 */
function weekendZoneAt(atMs) {
	if (!Number.isFinite(atMs) || atMs < Date.parse(WEEKEND_OFFPEAK_EFFECTIVE_AT)) return null;
	const beijingDay = Math.floor((atMs + 8 * 3600000) / 86400000);
	const weekday = (beijingDay + 4) % 7; // 0=周日 … 6=周六
	if (weekday !== 6 && weekday !== 0) return null;
	const saturdayDay = weekday === 6 ? beijingDay : beijingDay - 1;
	return {
		start: Math.max(saturdayDay * 86400000 - 8 * 3600000, Date.parse(WEEKEND_OFFPEAK_EFFECTIVE_AT)),
		end: (saturdayDay + 2) * 86400000 - 8 * 3600000,
	};
}

/** 某时刻是否处于高峰时段 (周末全谷优先于一切; 否则看 UTC 小时窗口)。 */
function isPeakHour(atMs) {
	if (weekendZoneAt(atMs) !== null) return false;
	if (!Number.isFinite(atMs)) return false;
	const hour = new Date(atMs).getUTCHours();
	return DEFAULT_PEAK_WINDOWS.some((windowEntry) =>
		Number.isFinite(windowEntry.start) && Number.isFinite(windowEntry.end)
		&& hour >= windowEntry.start && hour < windowEntry.end
	);
}

/**
 * 按计费时刻从价格条目里选档: 高峰时刻用 peak, 其余 (含周末) 用 offPeak。
 * 兼容只有一档 (无 offPeak/peak 子档) 的旧条目结构。
 */
function tierFor(priceEntry, atMs) {
	const base = priceEntry || {};
	if (isPeakHour(atMs)) {
		return base.peak || base;
	}
	return base.offPeak || base;
}

/**
 * 按一档三桶价格估算一次用量的费用 (CNY)。
 * 对齐官方计费口径: 输入(未命中)= inputTokens + cacheWriteTokens (首次写入缓存的输入按未命中价),
 * 命中缓存按 cacheHit 价, 输出按 output 价; 思考(reasoning) 已计入 output 不重复计费。
 */
function costOfUsage(usage, tier) {
	if (usage === null || typeof usage !== "object") return 0;
	const missTokens = (usage.inputTokens || 0) + (usage.cacheWriteTokens || 0);
	const hitTokens = usage.cacheReadTokens || 0;
	const outTokens = usage.outputTokens || 0;
	return (missTokens / 1e6) * (tier.cacheMiss || 0)
		+ (hitTokens / 1e6) * (tier.cacheHit || 0)
		+ (outTokens / 1e6) * (tier.output || 0);
}

/** 北京时区下的本地日期键 (YYYY-MM-DD)。 */
function localDayKey(atMs) {
	const date = new Date(atMs);
	const pad = (value) => String(value).padStart(2, "0");
	return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
}

/** 空的一天用量桶 (按日聚合用)。 */
function emptyDayUsage() {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0, cost: 0 };
}

/** 取非负有限数字, 否则 0。 */
function safeNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** 按 zstd magic 切分多帧拼接文件 */
function splitFrames(buf) {
	const frames = [];
	let i = 0;
	while (i < buf.length) {
		const hit = buf.indexOf(MAGIC, i);
		if (hit === -1) break;
		const nxt = buf.indexOf(MAGIC, hit + 4);
		frames.push(buf.subarray(hit, nxt === -1 ? buf.length : nxt));
		i = nxt === -1 ? buf.length : nxt;
	}
	return frames;
}

/** 解出整个 zstd 多帧文件的文本 */
function decompressZstd(buf) {
	const parts = splitFrames(buf).map((fr) => zlib.zstdDecompressSync(fr));
	return Buffer.concat(parts).toString("utf8");
}

/** 解析首行会话 header. 跨版本容错: 不校验 header.version (实测 v3 会话物理字段为 0) */
function parseHeaderLine(firstLine) {
	const parsed = JSON.parse(firstLine);
	if (parsed === null || typeof parsed !== "object" || parsed.type !== "session") {
		throw new Error("first line is not a session header");
	}
	return parsed;
}

/**
 * 把一条物理日志行收纳进事件表 (跨版本容错解码)。
 * dsh 从 v2 升级到 v3 移除了 decodeStorageRecord, 这里不依赖任何内部导出符号, 只做:
 *   1) 忽略 ignorable 空事件
 *   2) 表面替换折叠: surfaceOp.op === "replace" 时, 丢弃被取代的旧事件 seq 区间
 *      (新/旧版本别名为 startSeq/endSeq 与 start/end)
 *   3) 以 seq 为键收纳, 最终按 seq 升序输出
 */
function adoptPhysicalRow(parsedRow, eventsBySeq) {
	if (parsedRow === null || typeof parsedRow !== "object") return;
	if (typeof parsedRow.type !== "string" || typeof parsedRow.seq !== "number") return;
	if (parsedRow.ignorable === true) return;
	const surfaceOperation = parsedRow.surfaceOp;
	if (surfaceOperation !== void 0 && surfaceOperation !== "append") {
		if (surfaceOperation !== null && typeof surfaceOperation === "object" && surfaceOperation.op === "replace") {
			const replaceStartSeq = Number(surfaceOperation.startSeq !== void 0 ? surfaceOperation.startSeq : surfaceOperation.start);
			const replaceEndSeq = Number(surfaceOperation.endSeq !== void 0 ? surfaceOperation.endSeq : surfaceOperation.end);
			if (Number.isFinite(replaceStartSeq) && Number.isFinite(replaceEndSeq)) {
				for (let seq = replaceStartSeq; seq < replaceEndSeq; seq++) {
					eventsBySeq.delete(seq);
				}
			}
		}
	}
	eventsBySeq.set(parsedRow.seq, parsedRow);
}

/** 解析整个日志文本为 { header, events } (事件经跨版本容错解码展开) */
function decodeLog(text) {
	const lines = text.split("\n").filter((l) => l.length > 0);
	if (lines.length === 0) throw new Error("empty log");
	const header = parseHeaderLine(lines[0]);
	const eventsBySeq = new Map();
	for (let i = 1; i < lines.length; i++) {
		let parsed;
		try {
			parsed = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		try {
			adoptPhysicalRow(parsed, eventsBySeq);
		} catch {
			continue;
		}
	}
	const seqs = Array.from(eventsBySeq.keys()).sort((a, b) => a - b);
	const events = seqs.map((seq) => eventsBySeq.get(seq));
	return { header, events };
}

/** 扫描 DSH_HOME/sessions 下所有会话文件.
 * 兼容三代存储格式:
 *   1) session.v3.jsonl.zstd  (DSH 0.1.2+ 新版本, 带版本号中间段)
 *   2) session.jsonl.zstd     (旧版无版本号的 zstd 压缩)
 *   3) session.jsonl          (纯文本兜底)
 * 每个会话目录挑优先级最高的那个文件 (v3 > 无版本号 zstd > 纯文本).
 *
 * v3 文件内部结构与旧格式完全一致 (zstd 多帧 + 每行 JSONL + 首行 session header +
 * 后续事件含 usage), 只是文件名中间多了 ".v3" 版本标记. 详见 2026-09-21 实测.
 */
async function scanSessionFiles(root) {
	const found = [];
	const workspaces = await readdir(root, { withFileTypes: true }).catch(() => []);
	for (const ws of workspaces) {
		if (!ws.isDirectory()) continue;
		const wsDir = join(root, ws.name);
		const sessionDirs = await readdir(wsDir, { withFileTypes: true }).catch(() => []);
		for (const s of sessionDirs) {
			if (!s.isDirectory()) continue;
			const dir = join(wsDir, s.name);

			// 先列整个目录, 再按优先级挑文件 (比硬编码 3 条路径更可扩展, 未来 DSH 加 v4 也不用再改)
			const dirEntries = await readdir(dir).catch(() => []);
			const candidates = dirEntries.filter((name) => {
				// 匹配 session[.vN].jsonl[.zstd] 三种变体
				return (
					name === "session.jsonl.zstd" ||
					name === "session.jsonl" ||
					/^session\.v\d+\.jsonl\.zstd$/.test(name)
				);
			});
			if (candidates.length === 0) continue;

			// 优先级: 带版本号 (最新) > 无版本号 zstd > 纯文本
			let chosen = null;
			let chosenCompression = "none";
			const versioned = candidates.filter((name) => /^session\.v\d+\.jsonl\.zstd$/.test(name));
			if (versioned.length > 0) {
				// 挑版本号最大的那个 (通常只有一个, 以防万一)
				chosen = versioned.sort((a, b) => {
					const va = parseInt(a.match(/\.v(\d+)\./)[1], 10);
					const vb = parseInt(b.match(/\.v(\d+)\./)[1], 10);
					return vb - va;
				})[0];
				chosenCompression = "zstd";
			} else if (candidates.includes("session.jsonl.zstd")) {
				chosen = "session.jsonl.zstd";
				chosenCompression = "zstd";
			} else {
				chosen = "session.jsonl";
				chosenCompression = "none";
			}

			found.push({ id: s.name, file: join(dir, chosen), compression: chosenCompression, workspaceKey: ws.name });
		}
	}
	return found;
}

/** 尽力读取会话标题 (投影缓存 session_projcache.json), 读不到返回 null */
/** 如果 sessionId 带 "session-" 前缀则去掉, 确保拿到纯 UUID */
function normalizeSessionId(sessionId) {
    return sessionId && sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
}

async function readSessionTitle(sessionId) {
  const id = normalizeSessionId(sessionId);
  try {
          // DSH 0.1.2-rc.1: projcache 改成按 session 分文件存储
          // 路径: storages/session_projcache/sessions/session-{sessionId}.json
          // ⚠️ 注意文件名前缀是 "session-" + uuid, 不是纯 uuid!
          const projPath = join(dshHome(), "storages", "session_projcache", "sessions", "session-" + id + ".json");
          let raw;
          try {
                  raw = await readFile(projPath, "utf8");
          } catch (e) {
                  // fallback: 旧版单文件
                  try { raw = await readFile(join(dshHome(), "storages", "session_projcache.json"), "utf8"); } catch { raw = null; }
          }
          if (raw) {
                  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
                  const data = JSON.parse(text);
                  // 新版格式: { version: 5, record: { rows: { title: { val: "..." } } } }
                  if (data && data.record && data.record.rows && data.record.rows.title && typeof data.record.rows.title.val === "string") {
                          const t = data.record.rows.title.val.trim();
                          if (t.length > 0) return t;
                  }
                  // 旧版格式 fallback
                  const rows = data && data.tables && data.tables.sessions;
                  if (rows && typeof rows === "object") {
                          const row = rows[sessionId];
                          const title = row && row.rows && row.rows.title && row.rows.title.val;
                          if (typeof title === "string" && title.trim().length > 0) return title.trim();
                  }
          }
          // 终极 fallback: 从会话日志文件里的 session/title 事件提取
          // (兼容 session.v3.jsonl.zstd / session.jsonl.zstd / session.jsonl)
          try {
                  const home = dshHome();
                  const sessionsRoot = join(home, "sessions");
                  const workspaces = await readdir(sessionsRoot);
                  for (const ws of workspaces) {
                          const dirPath = join(sessionsRoot, ws, "session-" + sessionId);
                          let buf = null;
                          // 按优先级挑文件: v3 zstd > 无版本号 zstd > 纯文本
                          const tryNames = async () => {
                                  const ents = await readdir(dirPath).catch(() => []);
                                  const v3Name = ents.find((n) => /^session\.v\d+\.jsonl\.zstd$/.test(n));
                                  if (v3Name) return { name: v3Name, zstd: true };
                                  if (ents.includes("session.jsonl.zstd")) return { name: "session.jsonl.zstd", zstd: true };
                                  if (ents.includes("session.jsonl")) return { name: "session.jsonl", zstd: false };
                                  return null;
                          };
                          const picked = await tryNames();
                          if (!picked) continue;
                          let raw = null;
                          try { raw = await readFile(join(dirPath, picked.name)); } catch { continue; }
                          let text = "";
                          if (picked.zstd) {
                                  // 用 Node 内置 zlib 解压
                                  const frames = []; let i = 0;
                                  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
                                  while (i < raw.length) {
                                          let j = raw.indexOf(MAGIC, i + 4);
                                          if (j < 0) j = raw.length;
                                          frames.push(raw.subarray(i, j));
                                          i = j;
                                  }
                                  text = Buffer.concat(frames.map(fr => zlib.zstdDecompressSync(fr))).toString("utf8");
                          } else {
                                  text = raw.toString("utf8");
                          }
                          const lines = text.split("\n").filter(l => l.trim());
                          for (let k = lines.length - 1; k >= 0; k--) {
                                  try {
                                          const obj = JSON.parse(lines[k]);
                                          if (obj.type === "session/title" && obj.data && typeof obj.data.title === "string") {
                                                  const t = obj.data.title.trim();
                                                  if (t.length > 0) return t;
                                          }
                                  } catch { /* skip bad line */ }
                          }
                  }
          } catch { /* ignore fallback errors */ }
          return null;
  } catch {
          return null;
  }
}

/** 在 workspaceRegistry 里找会话所属工作区 */
function workspaceOf(ctx, sessionId) {
	const registry = ctx.workspaceRegistry;
	if (registry === void 0) return null;
	for (const entity of registry.list()) {
		if (entity.sessionIds.includes(sessionId)) {
			return { id: entity.id, title: entity.title, path: entity.path };
		}
	}
	return null;
}

/** 动态获取 sessions 服务 (拿不到时返回空壳) */
function liveSessions(ctx) {
	try {
		return ctx.sessions || { get: () => void 0 };
	} catch {
		return { get: () => void 0 };
	}
}

/** 空用量桶 */
function emptyUsage() {
	const u = {};
	for (const k of USAGE_KEYS) u[k] = 0;
	u.calls = 0;
	return u;
}

/** 把一条 usage 记录累加进目标桶 (容错: 非数字/负数忽略) */
function addUsage(target, usage) {
	if (!usage || typeof usage !== "object") return;
	for (const k of USAGE_KEYS) {
		const v = usage[k];
		if (typeof v === "number" && Number.isFinite(v) && v >= 0) target[k] += v;
	}
	target.calls += 1;
}

/** 从 user/message 事件提取纯文本预览 (兼容 text 字段与 content 数组两种形态) */
function userTextPreview(data) {
	let text = null;
	if (typeof data.text === "string") text = data.text;
	else if (Array.isArray(data.content)) {
		const block = data.content.find((b) => b !== null && typeof b === "object" && b.type === "text");
		if (block !== void 0 && typeof block.text === "string") text = block.text;
	}
	return text === null ? null : text.replace(/\s+/g, " ").slice(0, 160);
}

/**
 * 折叠整个事件流:
 *   totals: 按模型聚合的全会话用量 { models: { [model]: usage } }
 *   turns:  逐回合 { turn, userText, steps, toolCalls, messages, complete, models }
 *   days:   按日聚合 { [YYYY-MM-DD]: { input, output, cacheRead, cacheWrite, reasoning, calls, cost } }
 *           (每条 assistant/message 按其 time 归属到北京时区日期, cost 按该事件时刻的峰谷档计)
 * 传入 priceTable 才累积 cost; 不传则 days 只含 token 桶, cost 恒 0。
 */
function foldEvents(events, priceTable) {
	const totals = { models: {} };
	const turns = [];
	const days = {};
	let current = null;
	let messageCount = 0;
	for (const e of events) {
		const d = e.data || {};
		switch (e.type) {
			case "turn/start": {
				current = {
					turn: d.turn,
					userText: null,
					steps: 0,
					toolCalls: 0,
					messages: 0,
					models: {},
					complete: false,
				};
				turns.push(current);
				break;
			}
			case "turn/end":
				if (current !== null) current.complete = true;
				break;
			case "step/start":
				if (current !== null) current.steps++;
				break;
			case "user/message":
				if (current !== null && current.userText === null) {
					current.userText = userTextPreview(d);
				}
				break;
			case "tool/call":
				if (current !== null) current.toolCalls++;
				break;
			case "assistant/message": {
				const src = d.message && d.message.source;
				const model = (src && typeof src.model === "string" && src.model) || "unknown";
				messageCount++;
				if (!totals.models[model]) totals.models[model] = emptyUsage();
				addUsage(totals.models[model], d.usage);
				if (current !== null) {
					current.messages++;
					if (!current.models[model]) current.models[model] = emptyUsage();
					addUsage(current.models[model], d.usage);
				}
				// 按日聚合: 用事件自带 time (epoch ms) 分桶到北京日期。
				// 计费时刻 = 该事件 time, 按其峰谷档累加 cost (传入 priceTable 才计费)。
				if (e.time !== void 0 && Number.isFinite(Number(e.time))) {
					const dayKey = localDayKey(Number(e.time));
					if (days[dayKey] === undefined) days[dayKey] = emptyDayUsage();
					const dayBucket = days[dayKey];
					const usage = d.usage || {};
					dayBucket.input += safeNumber(usage.inputTokens);
					dayBucket.output += safeNumber(usage.outputTokens);
					dayBucket.cacheRead += safeNumber(usage.cacheReadTokens);
					dayBucket.cacheWrite += safeNumber(usage.cacheWriteTokens);
					dayBucket.reasoning += safeNumber(usage.reasoningTokens);
					dayBucket.calls += 1;
					if (priceTable) {
						const entry = priceEntryFor(model, priceTable);
						const tier = tierFor(entry, Number(e.time));
						dayBucket.cost += costOfUsage(usage, tier);
					}
				}
				break;
			}
			default:
				break;
		}
	}
	return { totals, turns, messageCount, days };
}

/** 读取一个会话文件: 返回 { header, events } 或抛错 */

/**
 * 从 DSH 官方 sessionQuery API 拿事件 (DSH 0.1.2-rc.1 用 SQLite, JSONL 只有 header).
 * 返回 { header, events } 或抛错.
 */
async function loadSessionFromDshApi(ctx, sessionId) {
    const sessionQuery = ctx && ctx.sessionQuery || null;
    if (!sessionQuery) throw new Error("sessionQuery service not available");
    // 方法 1: readSurface → { session, events }
    if (typeof sessionQuery.readSurface === "function") {
        const surface = await sessionQuery.readSurface(sessionId);
        const header = { id: sessionId, cwd: surface.session?.cwd, createdAt: surface.session?.createdAt, parentSession: surface.session?.parentSession, agentPreset: surface.session?.agentPreset };
        return { header, events: surface.events || [] };
    }
    // 方法 2: traceSession → { events }
    if (typeof sessionQuery.traceSession === "function") {
        const traced = await sessionQuery.traceSession(sessionId);
        return { header: { id: sessionId }, events: traced.events || [] };
    }
    throw new Error("sessionQuery has no usable method");
}

async function loadSession(file, compression) {
	const raw = await readFile(file);
	const text = compression === "zstd" ? decompressZstd(raw) : raw.toString("utf8");
	return decodeLog(text);
}

function apply(ctx) {
	const sessionsRoot = join(dshHome(), "sessions");

	// 启动时静默拉一次官方价 (不阻塞插件注册; 失败保留内置表, 不抛错)。
	ensureOfficialPrices(false).catch(() => {});

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: ROUTE_LIST,
		handler: async (req, res) => {
			if (req.headers[GUARD_HEADER] !== "1") {
				res.writeHead(403);
				res.end();
				return;
			}
			try {
				const files = await scanSessionFiles(sessionsRoot);
				const sessions = [];
				// 全局按日聚合 (跨会话合并), 用于今日消耗 + 近 60 天热力图。
				const globalDays = {};
				for (const entry of files) {
					const meta = {
						id: entry.id,
						workspaceKey: entry.workspaceKey,
						compression: entry.compression,
						live: false,
						title: null,
						workspace: null,
						createdAt: null,
						cwd: null,
						turnCount: 0,
						messageCount: 0,
						models: {},
						error: null,
					};
					try {
						let header = null, events = [];
						try {
                                                    const loaded = await loadSession(entry.file, entry.compression);
                                                    header = loaded.header;
                                                    events = loaded.events;
                                                } catch (eFile) {
                                                    throw new Error("File: " + eFile.message);
                                                }
						meta.createdAt = header.createdAt ?? null;
						meta.cwd = header.cwd ?? null;
						const folded = foldEvents(events, priceState.table);
						meta.turnCount = folded.turns.length;
						meta.messageCount = folded.messageCount;
						meta.models = folded.totals.models;
						// 把该会话的按日聚合合并进全局表。
						for (const dayKey of Object.keys(folded.days)) {
							if (globalDays[dayKey] === undefined) globalDays[dayKey] = emptyDayUsage();
							const target = globalDays[dayKey];
							const source = folded.days[dayKey];
							target.input += source.input;
							target.output += source.output;
							target.cacheRead += source.cacheRead;
							target.cacheWrite += source.cacheWrite;
							target.reasoning += source.reasoning;
							target.calls += source.calls;
							target.cost += source.cost;
						}
					} catch (error) {
						meta.error = String((error && error.message) || error);
					}
					meta.live = liveSessions(ctx).get(entry.id) !== void 0;
					let liveDisplayTitle = null;
					try {
					    const liveSvc = ctx.sessions;
					    const snap = liveSvc && liveSvc.list && typeof liveSvc.list.getSnapshot === "function" ? liveSvc.list.getSnapshot() : null;
					    liveDisplayTitle = snap && snap.byId && snap.byId[entry.id] && snap.byId[entry.id].displayTitle || null;
					} catch {}
					meta.title = liveDisplayTitle || await readSessionTitle(entry.id);
					meta.displayTitle = liveDisplayTitle || meta.title || (meta.cwd && meta.cwd.split("/").pop()) || entry.id;
					meta.workspace = workspaceOf(ctx, entry.id);
					sessions.push(meta);
				}
				// 按 createdAt 倒序 (新的在前)
				sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
				// 今日消耗 (北京时区当天)。
				const todayKey = localDayKey(Date.now());
				const today = globalDays[todayKey] || emptyDayUsage();
				// 近 180 天每日序列 (缺数据的天用空桶补齐, 供前端热力图横向滚动查看)。
				const nowMs = Date.now();
				const days = [];
				for (let backDays = 179; backDays >= 0; backDays -= 1) {
					const dayMs = nowMs - backDays * 86400000;
					const key = localDayKey(dayMs);
					days.push({ date: key, ...(globalDays[key] || emptyDayUsage()) });
				}
				sendJson(res, 200, {
					ok: true, total: sessions.length, sessions,
					price: {
						source: priceState.source,
						fetchedAt: priceState.fetchedAt,
						currentTier: isPeakHour(Date.now()) ? "peak" : "offPeak",
					},
					today: today,
					days: days,
				});
			} catch (error) {
				sendJson(res, 500, { ok: false, error: String((error && error.message) || error) });
			}
		}
	}), name + ": list route");

	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: ROUTE_DETAIL,
		handler: async (req, res) => {
			if (req.headers[GUARD_HEADER] !== "1") {
				res.writeHead(403);
				res.end();
				return;
			}
			try {
				const url = new URL(req.url, "http://localhost");
				const sessionId = url.searchParams.get("id");
				if (!sessionId) {
					sendJson(res, 400, { ok: false, error: "missing id" });
					return;
				}
				const files = await scanSessionFiles(sessionsRoot);
				const entry = files.find((f) => f.id === sessionId);
				if (entry === void 0) {
					sendJson(res, 404, { ok: false, error: "session not found: " + sessionId });
					return;
				}
				let header = null, events = [];
				try {
                                                    const loaded = await loadSession(entry.file, entry.compression);
                                                    header = loaded.header;
                                                    events = loaded.events;
                                                } catch (eFile) {
                                                    throw new Error("File: " + eFile.message);
                                                }
				const folded = foldEvents(events);
				sendJson(res, 200, {
					ok: true,
					session: {
						id: entry.id,
						title: await readSessionTitle(entry.id),
						workspaceKey: entry.workspaceKey,
						live: liveSessions(ctx).get(entry.id) !== void 0,
						createdAt: header.createdAt ?? null,
						cwd: header.cwd ?? null,
						parentSession: header.parentSession ?? null,
						agentPreset: header.agentPreset ?? null,
					},
					totals: folded.totals,
					turnCount: folded.turns.length,
					messageCount: folded.messageCount,
					turns: folded.turns,
				});
			} catch (error) {
				sendJson(res, 500, { ok: false, error: String((error && error.message) || error) });
			}
		}
	}), name + ": detail route");

	// 价格表查询: 返回当前生效价格表 + 来源 + 峰谷档 (供前端加载/展示)。
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: ROUTE_PRICING,
		handler: async (req, res) => {
			if (req.headers[GUARD_HEADER] !== "1") {
				res.writeHead(403);
				res.end();
				return;
			}
			try {
				// 首次访问时若尚未同步官方价 (启动拉取可能还在途/失败), 这里再确保一次。
				await ensureOfficialPrices(false);
				sendJson(res, 200, {
					ok: true,
					table: priceState.table,
					source: priceState.source,
					fetchedAt: priceState.fetchedAt,
					currentTier: isPeakHour(Date.now()) ? "peak" : "offPeak",
				});
			} catch (error) {
				sendJson(res, 200, { ok: false, error: String((error && error.message) || error) });
			}
		}
	}), name + ": pricing route");

	// 手动强制刷新官方价格 (前端「从官方更新价格」按钮)。
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: ROUTE_PRICING_REFRESH,
		handler: async (req, res) => {
			if (req.headers[GUARD_HEADER] !== "1") {
				res.writeHead(403);
				res.end();
				return;
			}
			try {
				const next = await ensureOfficialPrices(true);
				sendJson(res, 200, {
					ok: true,
					table: next.table,
					source: next.source,
					fetchedAt: next.fetchedAt,
					currentTier: isPeakHour(Date.now()) ? "peak" : "offPeak",
				});
			} catch (error) {
				sendJson(res, 200, { ok: false, error: String((error && error.message) || error) });
			}
		}
	}), name + ": pricing refresh route");

	// 余额查询: 后端用 DeepSeek API key 调 /user/balance, key 不出服务端、不暴露给前端
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: ROUTE_BALANCE,
		handler: async (req, res) => {
			if (req.headers[GUARD_HEADER] !== "1") {
				res.writeHead(403);
				res.end();
				return;
			}
			try {
				const key = await readApiKey();
				if (!key) {
					sendJson(res, 200, { ok: false, configured: false, error: "未检测到 DeepSeek API Key，请先在设置面板配置" });
					return;
				}
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 8000);
				let response;
				try {
					response = await fetch(DEEPSEEK_BALANCE_URL, {
						method: "GET",
						headers: { Accept: "application/json", Authorization: "Bearer " + key },
						signal: controller.signal,
					});
				} finally {
					clearTimeout(timer);
				}
				if (!response.ok) {
					let detail = "";
					try {
						const body = await response.json();
						if (body && body.error && body.error.message) detail = String(body.error.message);
					} catch { /* 忽略解析失败 */ }
					// 401/403 通常是非 DeepSeek key 或 key 已失效, 给平和提示, 不影响其它功能
					const friendly = (response.status === 401 || response.status === 403)
						? "当前账户非 DeepSeek，或 API Key 无效，无法读取余额（其余功能不受影响）"
						: "查询余额失败(HTTP " + response.status + ")" + (detail ? " " + detail : "");
					sendJson(res, 200, { ok: false, configured: true, http_status: response.status, error: friendly });
					return;
				}
				const data = await response.json();
				sendJson(res, 200, { ok: true, configured: true, balance: data });
			} catch (error) {
				const reason = (error && error.name === "AbortError")
					? "查询余额超时"
					: "查询余额异常: " + String((error && error.message) || error);
				sendJson(res, 200, { ok: false, configured: true, error: reason });
			}
		}
	}), name + ": balance route");
}

export { apply, inject, name };


