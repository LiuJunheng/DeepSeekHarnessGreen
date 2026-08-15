// DeepSeek Harness 插件 (宿主端): dsh-archive-purge
// 在 WebUI 设置页里提供「清理归档会话」入口的后端处理。
// 只注册一个本地 HTTP 路由, 不修改任何官方文件/包。
//
// 行为: 遍历工作区注册表的归档会话集合 (workspaceRegistry.archivedSessionIds),
//   1) 跳过仍在运行的会话;
//   2) 删除会话日志目录 (DSH_HOME/sessions/<工作区>/<会话ID>/);
//   3) 从所在工作区的 sessionIds 中摘除 (workspace.detachSession)。
// 投影缓存 (session_projcache.json) 里的旧行仅为缓存, 无害, 留待 dsh 自行覆盖。
// 说明: dsh 官方没有"取消归档/删除归档"接口, 摘除后 archivedSessionIds 中
// 会残留一个不再指向任何会话的 id, 纯属隐藏标记, 不影响任何功能。

import { readdir, stat, rm } from "node:fs/promises";
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

/** 永久删除全部已归档会话, 返回汇总结果。 */
async function purgeArchived(ctx) {
	const registry = ctx.workspaceRegistry;
	const sessionsRoot = join(dshHome(), "sessions");
	const archived = [...registry.archivedSessionIds];
	const results = [];
	let deleted = 0;
	let detachedOnly = 0;
	let skippedLive = 0;
	let errors = 0;
	const sessionsService = ctx.get("sessions");

	for (const id of archived) {
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
		total: archived.length,
		deleted,
		detachedOnly,
		skippedLive,
		errors,
		results
	};
}

function apply(ctx) {
	const disposer = ctx.webServer.register({
		kind: "exact",
		path: ROUTE_PATH,
		handler: async (req, res) => {
			if (req.method !== "POST") {
				res.writeHead(405);
				res.end();
				return;
			}
			if (req.headers[GUARD_HEADER] !== "1") {
				res.writeHead(403);
				res.end();
				return;
			}
			try {
				sendJson(res, 200, await purgeArchived(ctx));
			} catch (error) {
				sendJson(res, 500, {
					ok: false,
					error: String((error && error.message) || error)
				});
			}
		}
	});
	ctx.effect(disposer, "dsh-archive-purge: route");
}

export { apply, inject, name };
