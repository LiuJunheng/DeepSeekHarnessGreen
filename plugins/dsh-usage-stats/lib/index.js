// DeepSeek Harness 插件 (宿主端): dsh-usage-stats
// 在 WebUI 设置页提供「用量统计」的数据后端:
//   直接按磁盘扫描会话日志 (DSH_HOME/sessions/**/session.jsonl.zstd),
//   解码出每条 assistant/message 事件携带的 usage 数据
//   (inputTokens / outputTokens / cacheReadTokens / cacheWriteTokens / reasoningTokens),
//   按模型聚合到会话级与回合级, 供前端展示 token 用量与费用估算。
// 费用估算在客户端完成 (价格表由用户在前端编辑, 本端只返回原始 token 数)。
//
// 提供的接口 (路由 /__dsh/usage-stats/*, 均要求自定义头 X-DSH-Usage-Stats: 1):
//   GET /__dsh/usage-stats/list   -> 全部会话的用量汇总 (每会话按模型聚合)
//   GET /__dsh/usage-stats/detail -> 单个会话的逐回合用量明细
// 不修改任何官方文件/包。
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import zlib from "node:zlib";
import { decodeStorageRecord, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";

const name = "dsh-usage-stats";
const inject = ["webServer", "workspaceRegistry"];

const ROUTE_LIST = "/__dsh/usage-stats/list";
const ROUTE_DETAIL = "/__dsh/usage-stats/detail";
const GUARD_HEADER = "x-dsh-usage-stats";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const USAGE_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"];

function dshHome() {
	return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(body);
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

/** 只解第一帧(会话 header 所在帧), 用于快速读元数据 */
function decompressZstdHeader(buf) {
	const frames = splitFrames(buf);
	if (frames.length === 0) throw new Error("empty or header-less log");
	return zlib.zstdDecompressSync(frames[0]).toString("utf8");
}

function parseHeaderLine(firstLine) {
	const parsed = JSON.parse(firstLine);
	if (parsed === null || typeof parsed !== "object" || parsed.type !== "session") {
		throw new Error("first line is not a session header");
	}
	if (parsed.version !== SESSION_FORMAT_VERSION) {
		throw new Error("unsupported session format version " + String(parsed.version));
	}
	return parsed;
}

/** 解析整个日志文本为 { header, events } (事件经官方 decodeStorageRecord 展开) */
function decodeLog(text) {
	const lines = text.split("\n").filter((l) => l.length > 0);
	if (lines.length === 0) throw new Error("empty log");
	const header = parseHeaderLine(lines[0]);
	const events = [];
	for (let i = 1; i < lines.length; i++) {
		let parsed;
		try {
			parsed = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		let decoded;
		try {
			decoded = decodeStorageRecord(parsed);
		} catch {
			continue;
		}
		for (const e of decoded) events.push(e);
	}
	return { header, events };
}

/** 扫描 DSH_HOME/sessions 下所有会话文件 */
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
			const zstdPath = join(dir, "session.jsonl.zstd");
			const plainPath = join(dir, "session.jsonl");
			let file = null;
			let compression = "zstd";
			try {
				await readFile(zstdPath);
				file = zstdPath;
			} catch {
				try {
					await readFile(plainPath);
					file = plainPath;
					compression = "none";
				} catch {
					continue;
				}
			}
			found.push({ id: s.name, file, compression, workspaceKey: ws.name });
		}
	}
	return found;
}

/** 尽力读取会话标题 (投影缓存 session_projcache.json), 读不到返回 null */
async function readSessionTitle(sessionId) {
	try {
		const raw = await readFile(join(dshHome(), "storages", "session_projcache.json"), "utf8");
		const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
		const data = JSON.parse(text);
		const rows = data && data.tables && data.tables.sessions;
		if (!rows || typeof rows !== "object") return null;
		const row = rows[sessionId];
		const title = row && row.rows && row.rows.title && row.rows.title.val;
		return typeof title === "string" && title.length > 0 ? title : null;
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
		return ctx.get("sessions") || { get: () => void 0 };
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
 */
function foldEvents(events) {
	const totals = { models: {} };
	const turns = [];
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
				break;
			}
			default:
				break;
		}
	}
	return { totals, turns, messageCount };
}

/** 读取一个会话文件: 返回 { header, events } 或抛错 */
async function loadSession(file, compression) {
	const raw = await readFile(file);
	const text = compression === "zstd" ? decompressZstd(raw) : raw.toString("utf8");
	return decodeLog(text);
}

function apply(ctx) {
	const sessionsRoot = join(dshHome(), "sessions");

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
						const { header, events } = await loadSession(entry.file, entry.compression);
						meta.createdAt = header.createdAt ?? null;
						meta.cwd = header.cwd ?? null;
						const folded = foldEvents(events);
						meta.turnCount = folded.turns.length;
						meta.messageCount = folded.messageCount;
						meta.models = folded.totals.models;
					} catch (error) {
						meta.error = String((error && error.message) || error);
					}
					meta.live = liveSessions(ctx).get(entry.id) !== void 0;
					meta.title = await readSessionTitle(entry.id);
					meta.workspace = workspaceOf(ctx, entry.id);
					sessions.push(meta);
				}
				// 按 createdAt 倒序 (新的在前)
				sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
				sendJson(res, 200, { ok: true, total: sessions.length, sessions });
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
				const { header, events } = await loadSession(entry.file, entry.compression);
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
}

export { apply, inject, name };
