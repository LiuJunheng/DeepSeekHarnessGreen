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
const inject = ["webServer", "workspaceRegistry", "sessionQuery", "sessions"];

const ROUTE_LIST = "/__dsh/usage-stats/list";
const ROUTE_DETAIL = "/__dsh/usage-stats/detail";
const ROUTE_BALANCE = "/__dsh/usage-stats/balance";
const GUARD_HEADER = "x-dsh-usage-stats";

// DeepSeek 官方余额查询接口 (https://api-docs.deepseek.com/zh-cn/api/get-user-balance/)
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const USAGE_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"];

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
          // 终极 fallback: 从 session.jsonl.zstd 里的 session/title 事件提取
          try {
                  const home = dshHome();
                  const sessionsRoot = join(home, "sessions");
                  // 遍历 sessionsRoot 下的所有 workspace 目录, 找 session-{uuid}/session.jsonl.zstd
                  const workspaces = await readdir(sessionsRoot);
                  for (const ws of workspaces) {
                          const dirPath = join(sessionsRoot, ws, "session-" + sessionId);
                          const zstdPath = join(dirPath, "session.jsonl.zstd");
                          let buf;
                          try { buf = await readFile(zstdPath); } catch { continue; }
                          // 用 Node 内置 zlib 解压
                          const frames = []; let i = 0;
                          const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
                          while (i < buf.length) {
                                  let j = buf.indexOf(MAGIC, i + 4);
                                  if (j < 0) j = buf.length;
                                  frames.push(buf.subarray(i, j));
                                  i = j;
                          }
                          const text = Buffer.concat(frames.map(fr => zlib.zstdDecompressSync(fr))).toString("utf8");
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
						const folded = foldEvents(events);
						meta.turnCount = folded.turns.length;
						meta.messageCount = folded.messageCount;
						meta.models = folded.totals.models;
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


