// DeepSeek Harness 插件 (宿主端): dsh-archive-purge
// 在 WebUI 设置页里提供「清理归档会话」入口的后端处理。
// 只注册本地 HTTP 路由, 不修改任何官方文件/包。
//
// 提供的接口 (路由 /__dsh/archive-purge, 均要求自定义头 X-DSH-Plugin-Purge: 1):
//   GET  -> 列出全部已归档会话 (id / 标题 / 所属工作区 / 是否运行中), 供前端勾选。
//   POST -> 永久删除会话。请求体可为 JSON {"ids": ["会话A", "会话B"]} 仅删除所选;
//          省略 ids (或空数组) 时删除全部已归档会话。
//
// 删除行为 (与 GUI 启动器的 purge_session / purge_archived_sessions 语义一致):
//   1) 跳过仍在运行的会话;
//   2) 删除会话日志目录 (DSH_HOME/sessions/<工作区>/<会话ID>/);
//   3) 从所在工作区的 sessionIds 中摘除 (workspace.detachSession)。
// 投影缓存 (session_projcache.json) 里的旧行仅为缓存, 无害, 留待 dsh 自行覆盖。
// 说明: dsh 官方没有"取消归档/删除归档"接口, 摘除后 archivedSessionIds 中
// 会残留一个不再指向任何会话的 id, 纯属隐藏标记, 不影响任何功能。

import { readdir, readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const name = "dsh-archive-purge";
const inject = ["webServer", "workspaceRegistry"];

const ROUTE_PATH = "/__dsh/archive-purge";
// 自定义头: 跨域请求无法携带该头 (会触发 CORS 预检且本服务不返回 CORS 头),
// 防止外部网页对本地端口发起删除请求。
const GUARD_HEADER = "x-dsh-plugin-purge";

function dshHome() {
	return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(body);
}

/** 读取并解析请求体 JSON, 空请求体或解析失败均返回空对象。 */
function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
			if (raw.length > 1024 * 1024) {
				reject(new Error("请求体过大"));
				req.destroy();
			}
		});
		req.on("end", () => {
			if (!raw) return resolve({});
			try {
				resolve(JSON.parse(raw));
			} catch {
				resolve({});
			}
		});
		req.on("error", reject);
	});
}

/** 尽力读取会话标题 (来自投影缓存 session_projcache.json), 读不到返回 null。 */
async function readSessionTitle(sessionId) {
	try {
		const filePath = join(dshHome(), "storages", "session_projcache.json");
		const raw = await readFile(filePath, "utf8");
		// 去除可能的 UTF-8 BOM, 避免 JSON.parse 崩溃
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

/** 列出全部已归档会话, 附带展示所需元数据。 */
async function listArchived(ctx) {
	const registry = ctx.workspaceRegistry;
	const sessionsService = ctx.get("sessions");
	const sessions = [];
	for (const id of registry.archivedSessionIds) {
		let workspaceTitle = null;
		let workspacePath = null;
		for (const entity of registry.list()) {
			if (entity.sessionIds.includes(id)) {
				workspaceTitle = entity.title;
				workspacePath = entity.path;
				break;
			}
		}
		sessions.push({
			id,
			title: await readSessionTitle(id),
			workspaceTitle,
			workspacePath,
			running: sessionsService !== void 0 && sessionsService.get(id) !== void 0
		});
	}
	return { ok: true, total: sessions.length, sessions };
}

/** 在 sessions 根目录下按会话 id 查找并删除其日志目录, 找到并删除返回 true。 */
async function removeSessionDir(sessionsRoot, sessionId) {
	let entries;
	try {
		entries = await readdir(sessionsRoot, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const candidate = join(sessionsRoot, entry.name, sessionId);
		let st;
		try {
			st = await stat(candidate);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			await rm(candidate, { recursive: true, force: true });
			return true;
		}
	}
	return false;
}

/** 永久删除指定会话 (selectedIds 为空时删除全部已归档会话), 返回汇总结果。 */
async function purgeSessions(ctx, selectedIds) {
	const registry = ctx.workspaceRegistry;
	const sessionsRoot = join(dshHome(), "sessions");
	const archived = [...registry.archivedSessionIds];
	// 指定了 ids 时只处理所选; 未指定时处理全部归档会话; 结果去重
	const hasSelection = Array.isArray(selectedIds) && selectedIds.length > 0;
	const targets = hasSelection
		? [...new Set(selectedIds.filter((id) => typeof id === "string" && id))]
		: archived;
	const results = [];
	let deleted = 0;
	let detachedOnly = 0;
	let skippedLive = 0;
	let errors = 0;
	const sessionsService = ctx.get("sessions");

	for (const id of targets) {
		// 跳过仍在运行的会话
		if (sessionsService !== void 0 && sessionsService.get(id) !== void 0) {
			skippedLive++;
			results.push({ id, status: "skipped-live" });
			continue;
		}
		// 1) 删除日志文件
		let fileDeleted = false;
		try {
			fileDeleted = await removeSessionDir(sessionsRoot, id);
		} catch (error) {
			errors++;
			results.push({
				id,
				status: "file-error",
				error: String((error && error.message) || error)
			});
			continue;
		}
		// 2) 从所有工作区记录中摘除 (detachSession 对未挂载的 id 是幂等空操作)
		for (const entity of registry.list()) {
			await entity.detachSession(id);
		}
		if (fileDeleted) {
			deleted++;
			results.push({ id, status: "deleted" });
		} else {
			detachedOnly++;
			results.push({ id, status: "detached-only", note: "未找到日志目录(可能已删过)" });
		}
	}

	return {
		ok: true,
		total: targets.length,
		deleted,
		detachedOnly,
		skippedLive,
		errors,
		results
	};
}

function apply(ctx) {
	// 注意: ctx.effect 会把传入回调的返回值当作清理函数, 因此必须把
	// webServer.register(...) 包进回调里 (返回值即注销函数), 不能先注册再把
	// 注销函数直接传给 effect, 否则路由注册后会被立即注销 (HTTP 405)。
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: ROUTE_PATH,
		handler: async (req, res) => {
			// GET: 列出已归档会话
			if (req.method === "GET") {
				if (req.headers[GUARD_HEADER] !== "1") {
					res.writeHead(403);
					res.end();
					return;
				}
				try {
					sendJson(res, 200, await listArchived(ctx));
				} catch (error) {
					sendJson(res, 500, {
						ok: false,
						error: String((error && error.message) || error)
					});
				}
				return;
			}
			// 仅允许 POST 执行删除
			if (req.method !== "POST") {
				sendJson(res, 405, { ok: false, error: "Method Not Allowed (use GET or POST)" });
				return;
			}
			if (req.headers[GUARD_HEADER] !== "1") {
				res.writeHead(403);
				res.end();
				return;
			}
			try {
				const body = await readJsonBody(req);
				const ids = Array.isArray(body.ids) ? body.ids : undefined;
				sendJson(res, 200, await purgeSessions(ctx, ids));
			} catch (error) {
				sendJson(res, 500, {
					ok: false,
					error: String((error && error.message) || error)
				});
			}
		}
	}), "dsh-archive-purge: route");
}

export { apply, inject, name };
