// DeepSeek Harness 插件 (宿主端): dsh-session-rewind
// 在 WebUI 设置页提供「会话回退」的分析后端:
//   直接按磁盘扫描会话日志 (DSH_HOME/sessions/**/session.jsonl.zstd),
//   解码出逐回合信息(用户问题/步骤数/工具调用/错误码/是否完成/回退边界),
//   供前端展示并选择「从哪个回合之后回退」。
// 回退动作由客户端调用官方 session.fork 完成(派生干净续接会话, 原会话不动)。
//
// 提供的接口 (路由 /__dsh/session-rewind/*, 均要求自定义头 X-DSH-Plugin-Rewind: 1):
//   GET /__dsh/session-rewind/list    -> 全部会话的元数据列表 (快速, 只读 header)
//   GET /__dsh/session-rewind/inspect -> 单个会话的完整回合分析 (解码整个日志)
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import zlib from "node:zlib";
import { decodeStorageRecord, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";

const name = "dsh-session-rewind";
const inject = ["webServer", "workspaceRegistry", "sessions"];

const ROUTE_LIST = "/__dsh/session-rewind/list";
const ROUTE_INSPECT = "/__dsh/session-rewind/inspect";
const GUARD_HEADER = "x-dsh-plugin-rewind";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function dshHome() {
	return process.env.DSH_HOME || join(homedir(), ".dsh");
}

/** 动态获取 sessions 服务 (archive-purge 同款做法); 拿不到时返回空壳 */
function liveSessions(ctx) {
	try {
		return ctx.sessions || { get: () => void 0 };
	} catch {
		return { get: () => void 0 };
	}
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

/** 只解第一帧(会话 header 所在帧), 用于快速列表 */
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

/** 逐回合分析: 每回合的用户问题/步骤/工具调用/错误码/完成状态/回退边界 */
function analyzeEvents(events) {
	const turns = [];
	const totalErrors = {};
	let current = null;
	let lastSeq = -1;
	for (const e of events) {
		if (typeof e.seq === "number" && e.seq > lastSeq) lastSeq = e.seq;
		const d = e.data || {};
		switch (e.type) {
			case "turn/start": {
				current = {
					turn: d.turn,
					userText: null,
					steps: 0,
					toolCalls: 0,
					errors: {},
					complete: false,
					startSeq: e.seq,
					boundarySeq: null
				};
				turns.push(current);
				break;
			}
			case "turn/end":
				if (current !== null) {
					current.complete = true;
					current.boundarySeq = e.seq;
				}
				break;
			case "step/start":
				if (current !== null) current.steps++;
				break;
			case "user/message":
				if (current !== null && current.userText === null) {
					let text = null;
					if (typeof d.text === "string") text = d.text;
					else if (Array.isArray(d.content)) {
						const block = d.content.find((b) => b !== null && typeof b === "object" && b.type === "text");
						if (block !== void 0 && typeof block.text === "string") text = block.text;
					}
					current.userText = text === null ? null : text.replace(/\s+/g, " ").slice(0, 160);
				}
				break;
			case "tool/call":
				if (current !== null) current.toolCalls++;
				break;
			case "tool/result":
				if (current !== null && d.error !== void 0) {
					const code = (d.error && typeof d.error.code === "string" && d.error.code) || "ERROR";
					current.errors[code] = (current.errors[code] || 0) + 1;
					totalErrors[code] = (totalErrors[code] || 0) + 1;
				}
				break;
			default:
				break;
		}
	}
	const summary = {
		eventCount: events.length,
		totalTurns: turns.length,
		completedTurns: turns.filter((t) => t.complete).length,
		unfinishedTurns: turns.filter((t) => !t.complete).length,
		errorCodes: totalErrors,
		lastSeq
	};
	return { turns, summary };
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
					const meta = { id: entry.id, workspaceKey: entry.workspaceKey, compression: entry.compression, live: false, title: null, workspace: null, createdAt: null, cwd: null, error: null };
					try {
						const raw = await readFile(entry.file);
						const headerText = entry.compression === "zstd" ? decompressZstdHeader(raw) : raw.toString("utf8").split("\n", 1)[0];
						const header = parseHeaderLine(headerText.trim());
						meta.createdAt = header.createdAt ?? null;
						meta.cwd = header.cwd ?? null;
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
		path: ROUTE_INSPECT,
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
				const { turns, summary } = analyzeEvents(events);
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
						agentPreset: header.agentPreset ?? null
					},
					summary,
					turns
				});
			} catch (error) {
				sendJson(res, 500, { ok: false, error: String((error && error.message) || error) });
			}
		}
	}), name + ": inspect route");
}

export { apply, inject, name };




