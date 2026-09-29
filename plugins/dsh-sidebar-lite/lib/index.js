// DeepSeek Harness 插件 (宿主端): dsh-sidebar-lite
// 作为官方右侧栏 (dsh-client-ui-sidebar-right) 的一个 tab 类型并入, 客户端只作为官方右栏
// 的 tab 正文 (文件树 + 编辑器), 因此本端能力聚焦两块:
//   1) 文件资源管理器: 列出会话工作目录的目录树, 支持「返回上级 / 路径框」上溯浏览
//                     (放开 isWithin 上限, 与内部 dsh-file-browser 插件一致);
//   2) 文件预览/编辑:  读取文本/二进制内容 (带 head 供前端嗅探), 写回保存。
// 终端与后台任务已删除, 改用官方右侧栏的 terminal tab 与会话头部 jobs 控件。
// 参考/复刻自第三方插件 DSH Better Sidebar (omdsh-dev/DSH-better-sidebar):
//   本端实现了其中 fs.tree / fs.read / fs.write / session.cwd / file 媒体路由,
//   去掉了终端、jobs、git、settings 命名空间、browser.probe 等重依赖能力。
//
// 提供的接口 (路由前缀 /__dsh/sidebar-lite/*, 均要求自定义头 X-DSH-Sidebar-Lite: 1):
//   POST /__dsh/sidebar-lite/session.cwd     { sessionId }                 -> { sessionId, cwd, root, parent }
//   POST /__dsh/sidebar-lite/fs.tree         { sessionId, cwd?, path? }    -> 列目录 { path, entries, truncated }
//   POST /__dsh/sidebar-lite/fs.read         { sessionId, cwd?, path }     -> { kind, content|size, truncated, head? }
//   POST /__dsh/sidebar-lite/fs.write        { sessionId, cwd?, path, content } -> { ok }
//   GET  /__dsh/sidebar-lite/file            ?sessionId=&cwd=&path=&download=      -> 媒体字节 (图片/PDF/MD 等)
// 安全约定:
//   - 资源管理器允许任意绝对路径 (上级浏览); 写操作同样是绝对路径, 用户自己负责范围,
//     与内部 dsh-file-browser 插件的行为一致;
//   - 用自定义头防跨站 (同 dsh-usage-stats 的先例, 跨域页面无法携带该头)。
// 不修改任何官方文件/包。
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const name = "dsh-sidebar-lite";
// webServer 是 DSH webserver 提供给插件的路由注册服务; sessions 提供会话 cwd 溯源。
const inject = ["webServer"];

const API_PREFIX = "/__dsh/sidebar-lite";
const GUARD_HEADER = "x-dsh-sidebar-lite";
const READ_LIMIT = 1 * 1024 * 1024;          // 文本读取上限 (1MB, 超出标 truncated)
const READ_HEAD_LIMIT = 4096;                // 二进制文件返回给前端的 head 字节数
const LIST_LIMIT = 1000;                     // 单目录最多返回条目数 (超出标 truncated)
const MEDIA_LIMIT = 32 * 1024 * 1024;        // 媒体路由单文件上限 (32MB)
const MEDIA_TYPES = {
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
	".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
	".bmp": "image/bmp", ".ico": "image/x-icon", ".avif": "image/avif",
	".pdf": "application/pdf", ".html": "text/html", ".htm": "text/html",
	".md": "text/markdown", ".txt": "text/plain", ".json": "application/json",
};

// ---- 小工具 ----

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(body);
}

/** 把一行请求的 json body 解析出来 (读失败则返回 null 并回 400)。 */
async function readJsonBody(req, res) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		chunks.push(chunk);
		size += chunk.length;
		if (size > 1 * 1024 * 1024) {
			sendJson(res, 413, { ok: false, error: "body too large" });
			return null;
		}
	}
	const text = Buffer.concat(chunks).toString("utf8");
	if (!text) return {};
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		sendJson(res, 400, { ok: false, error: "invalid json body" });
		return null;
	}
}

function requireString(payload, key) {
	const value = payload[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error("missing or invalid field: " + key);
	}
	return value;
}

// ---- 会话工作目录溯源 ----

/**
 * 解析"工作区根"绝对路径 (用户工作目录的根, 如 D:\DeepSeekHarnessLauncher)。
 * 优先级:
 *   1) workspaceRegistry (工作区注册表): 用户创建的工作区目录, 权威来源;
 *      有 sessionId 时优先取该会话所属工作区的 path, 否则取注册表第一个
 *      (注册表按创建顺序, 最新在前);
 *   2) sandboxPolicy.workspaceRoot: 配置显式设置的 workspaceRoot; 注意未配置时
 *      其默认值 = process.cwd() = runtime\dsh (dsh 进程被启动器以 cwd=DSH_DIR 拉起),
 *      不可作为"工作区根"兜底, 只能作为次选;
 *   3) 空串 (调用方再回退到进程 cwd, 已是最后的兜底)。
 * 目的: 当会话 header.cwd 与客户端 cwd 都拿不到时, 兜底根应该是用户的工作区根,
 * 而不是 dsh 服务进程 cwd(runtime\dsh, 目录名恰为 "dsh"), 否则侧栏资源管理器
 * 默认路径会显示成 "dsh" 而非用户的工作区根目录。
 * @param {object} ctx - cordis 宿主上下文。
 * @param {string} [sessionId] - 会话 id, 用于优先匹配该会话所属的工作区。
 * @returns {string} 工作区根绝对路径, 找不到时返回空串。
 */
function workspaceRootOf(ctx, sessionId) {
	try {
		const registry = ctx.get("workspaceRegistry");
		const workspaces = registry && typeof registry.list === "function" ? registry.list() : [];
		if (typeof sessionId === "string" && sessionId !== "") {
			// 优先找 sessionId 所属的工作区 (会话 header.cwd 与工作区 path 同源)。
			for (const workspace of workspaces) {
				if (workspace && Array.isArray(workspace.sessionIds)
					&& workspace.sessionIds.includes(sessionId)
					&& typeof workspace.path === "string" && workspace.path !== "") {
					return workspace.path;
				}
			}
		}
		// 其次: 注册表第一个工作区 (最新创建的在前)。
		if (workspaces.length > 0 && typeof workspaces[0].path === "string" && workspaces[0].path !== "") {
			return workspaces[0].path;
		}
	} catch { /* workspaceRegistry 服务不可用则忽略 */ }
	// 次选: sandboxPolicy.workspaceRoot (配置显式设置的值; 未设置时默认 process.cwd()=runtime\dsh)。
	// 只有显式配置(与默认值 process.cwd() 不同)才可信, 否则返回空串, 让调用方回退到会话 cwd 等。
	try {
		const sandboxPolicy = ctx.get("sandboxPolicy");
		const root = sandboxPolicy && typeof sandboxPolicy.workspaceRoot === "string" && sandboxPolicy.workspaceRoot !== ""
			? sandboxPolicy.workspaceRoot
			: "";
		if (root !== "" && root !== process.cwd()) return root;
	} catch { /* sandboxPolicy 服务不可用则忽略 */ }
	return "";
}

/**
 * 同步取一个"好用的"兜底根目录。
 * 优先级: workspaceRootOf (工作区根, 用户创建的工作区) > 进程 cwd。
 * 目的: 当会话 header.cwd 与客户端 cwd 都拿不到时, 资源管理器默认根应该是
 * 工作目录的根目录(工作区), 而不是 dsh 服务进程 cwd(runtime\dsh, 目录名恰为 "dsh"),
 * 否则侧栏资源管理器默认路径会显示成 "dsh" 而非用户的工作区根目录。
 * @param {object} ctx - cordis 宿主上下文。
 * @param {string} [sessionId] - 会话 id, 用于优先匹配该会话所属的工作区。
 * @returns {string} 兜底根目录绝对路径。
 */
function defaultRootOf(ctx, sessionId) {
	const root = workspaceRootOf(ctx, sessionId);
	return root !== "" ? root : process.cwd();
}

/**
 * 取当前激活会话的工作目录 (权威来源是会话 header.cwd)。
 * 这里用 ctx.get("sessions") 动态取服务, 拿不到会话时回退到兜底根目录。
 * 若会话无 cwd 且客户端提供了 cwd, 则用客户端 cwd。
 * @param {object} ctx - cordis 宿主上下文。
 * @param {string} sessionId - 会话 id。
 * @param {string} [clientCwd] - 客户端上报的工作目录 (作为兜底)。
 * @param {string} [fallbackRoot] - 外部传入的兜底根 (通常为工作区根, 优先于进程 cwd)。
 * @returns {string} 会话权威工作目录绝对路径。
 */
function sessionCwdOf(ctx, sessionId, clientCwd, fallbackRoot) {
	try {
		const sessions = ctx.get("sessions");
		const session = sessions && sessions.get(sessionId);
		const headerCwd = session && session.header && session.header.cwd;
		if (typeof headerCwd === "string" && headerCwd !== "") {
			console.log("[dsh-sidebar-lite] sessionCwdOf: 用 header.cwd =", headerCwd, "(sessionId =", sessionId + ")");
			return headerCwd;
		}
		console.log("[dsh-sidebar-lite] sessionCwdOf: header.cwd 缺失", { sessionId, hasSession: !!session, headerCwd });
	} catch (error) {
		console.log("[dsh-sidebar-lite] sessionCwdOf: sessions 服务异常", error && error.message);
	}
	if (typeof clientCwd === "string" && clientCwd !== "") {
		try {
			if (!isAbsolute(clientCwd)) throw new Error("not absolute");
			console.log("[dsh-sidebar-lite] sessionCwdOf: 用客户端 cwd =", clientCwd);
			return resolve(clientCwd);
		} catch {
			throw new Error("invalid client cwd: " + clientCwd);
		}
	}
	// 兜底: 优先工作区根(用户工作目录的根), 最后才落到进程 cwd(runtime\dsh)。避免默认路径显示成 "dsh"。
	const root = fallbackRoot || defaultRootOf(ctx, sessionId) || process.cwd();
	console.log("[dsh-sidebar-lite] sessionCwdOf: 兜底 cwd =", root);
	return root;
}

/**
 * 解析工作区根目录 (优先工作区注册表 workspaceRegistry, 与 dsh 内部工作区同源;
 * 次选 sandboxPolicy.workspaceRoot)。资源管理器默认以此作为根目录, 展示
 * D:\DeepSeekHarnessLauncher 整个项目, 而非把会话工作目录 (如 runtime\dsh) 作为
 * 不可上溯的"固定根"。
 * 优先用 fs 服务把内部路径解析为可展示的绝对路径, fs 不可用则退回原始 root。
 * @param {object} ctx - cordis 宿主上下文。
 * @param {string} [sessionId] - 会话 id, 用于优先匹配该会话所属的工作区。
 * @returns {Promise<string>} 工作区根绝对路径, 无法解析时返回空串。
 */
async function resolveWorkspaceRoot(ctx, sessionId) {
	try {
		// 优先: 工作区注册表 (用户创建的工作区目录, 权威来源)。
		let root = workspaceRootOf(ctx, sessionId);
		if (root === "") {
			// 次选: sandboxPolicy.workspaceRoot (配置显式设置的值)。
			// 注意: 未显式配置时其默认值 = process.cwd() = runtime\dsh (dsh 程序目录),
			// 绝不可作为工作区根兜底 —— 只有显式配置(与默认值不同)才可信。
			const sandboxPolicy = ctx.get("sandboxPolicy");
			const configured = sandboxPolicy && typeof sandboxPolicy.workspaceRoot === "string"
				? sandboxPolicy.workspaceRoot
				: "";
			if (configured !== "" && configured !== process.cwd()) {
				root = configured;
			}
		}
		if (root === "") return "";
		try {
			const fsService = ctx.get("fs");
			if (fsService && typeof fsService.resolve === "function" && typeof fsService.processPath === "function") {
				const target = await fsService.resolve(root);
				const display = fsService.processPath(target);
				return typeof display === "string" && display !== "" ? display : root;
			}
		} catch { /* fs 服务不可用则退回原始 root */ }
		return root;
	} catch {
		return "";
	}
}

/**
 * 把客户端返回的路径解析为绝对路径 (必须是绝对, 在此基础上 resolve)。
 * 注意: 为支持资源管理器「返回上级 / 路径框」的上溯浏览, 这里不再限制在会话工作
 * 目录之内 (isWithin), 与内部 dsh-file-browser 插件放开上限的行为保持一致。
 * @param {string} cwd - 会话工作目录 (仅作默认值来源, 不再作为路径围栏)。
 * @param {string} rawPath - 客户端传来的绝对路径。
 * @returns {string} 规范化后的绝对路径。
 */
function resolvePathUnder(cwd, rawPath) {
	if (!isAbsolute(rawPath)) throw new Error("path must be absolute: " + rawPath);
	return resolve(rawPath);
}

// ---- 目录列出 (单层, 复用 better-sidebar 的 fs.tree 语义) ----

async function listDirectory(cwd, target, maxEntries) {
	let level;
	try {
		level = await readdir(target, { withFileTypes: true });
	} catch (error) {
		throw new Error("cannot list: " + target + ": " + error.message);
	}
	const rows = [];
	let overflow = 0;
	for (const entry of level) {
		if (rows.length >= maxEntries) {
			overflow += 1;
			continue;
		}
		rows.push({
			name: entry.name,
			path: resolve(target, entry.name),
			isDir: entry.isDirectory() || entry.isSymbolicLink(),
			hidden: entry.name.startsWith("."),
		});
	}
	// 目录优先, 名称大小写不敏感排序 (VSCode explorer 顺序)。
	rows.sort((a, b) => {
		const isA = a.isDir ? -1 : 1;
		if (a.isDir !== b.isDir) return isA;
		return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
	});
	return { path: target, entries: rows, truncated: overflow > 0 };
}

// ---- 文本/二进制读取 (带 head 与 truncated) ----

async function readText(path) {
	const info = await stat(path).catch((error) => {
		throw new Error("cannot read: " + path + ": " + error.message);
	});
	if (info.isDirectory()) throw new Error("path is a directory: " + path);
	const size = info.size;
	const truncated = size > READ_LIMIT;
	const handle = await open(path, "r").catch((error) => {
		throw new Error("cannot open: " + path + ": " + error.message);
	});
	try {
		const buffer = Buffer.alloc(Math.min(size, READ_LIMIT));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const slice = buffer.subarray(0, bytesRead);
		const binary = slice.includes(0);
		const head = binary
			? slice.subarray(0, Math.min(bytesRead, READ_HEAD_LIMIT)).toString("base64")
			: undefined;
		return {
			kind: binary ? "binary" : "text",
			content: binary ? "" : slice.toString("utf8"),
			truncated,
			size,
			head,
		};
	} finally {
		await handle.close();
	}
}

// ---- 写文件 (先写临时文件再 rename, 保证原子性) ----

async function writeText(path, content) {
	await mkdir(dirname(path), { recursive: true }).catch(() => {});
	const tmp = `${path}.dsh-sidebar-lite-tmp-${process.pid}`;
	try {
		await writeFile(tmp, content, "utf8");
		await rename(tmp, path);
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => {});
		throw new Error("cannot write: " + path + ": " + error.message);
	}
}

// ---- 媒体字节路由 (图片/PDF/Markdown 等, 供预览, GET) ----

/**
 * 读取查询参数里的 sessionId / cwd / path, 在会话工作目录内锁定目标并返回原始字节。
 * 客户端用 fetch(带防御头) 拉取后转 blob 预览, 因此不依赖 <img>/<iframe> 能否携带自定义头。
 * @param {object} req - IncomingMessage。
 * @param {object} res - ServerResponse。
 * @param {object} ctx - cordis 宿主上下文。
 * @param {URL} absUrl - 已解析的请求 URL。
 */
async function serveMedia(req, res, ctx, absUrl) {
	let sessionId = absUrl.searchParams.get("sessionId") || "";
	let clientCwd = absUrl.searchParams.get("cwd") || undefined;
	let rawPath = absUrl.searchParams.get("path");
	let download = absUrl.searchParams.get("download") === "1";
	if (typeof rawPath !== "string" || rawPath === "") {
		sendJson(res, 400, { ok: false, error: "missing or invalid field: path" });
		return;
	}
	let workspace;
	let target;
	try {
		workspace = sessionCwdOf(ctx, sessionId, clientCwd);
		target = resolvePathUnder(workspace, rawPath);
		const info = await stat(target).catch((error) => {
			throw new Error("cannot read: " + target + ": " + error.message);
		});
		if (!info.isFile()) throw new Error("path is not a file: " + target);
		if (info.size > MEDIA_LIMIT) {
			sendJson(res, 413, { ok: false, error: "file too large for preview (>32MB)" });
			return;
		}
		const ext = (basename(target).match(/\.([^.]+)$/) || [])[1];
		const contentType = ext ? (MEDIA_TYPES["." + ext.toLowerCase()] || "application/octet-stream") : "application/octet-stream";
		res.writeHead(200, {
			"content-type": contentType,
			"content-length": String(info.size),
			...download ? { "content-disposition": 'attachment; filename="' + basename(target).replace(/"/g, "") + '"' } : {},
		});
		const stream = createReadStream(target);
		stream.on("error", () => {
			// 流中途出错: 尽力关闭响应。
			try { res.destroy(); } catch { /* ignore */ }
		});
		stream.pipe(res);
	} catch (error) {
		sendJson(res, 400, {
			ok: false,
			error: (error && error.message) ? error.message : String(error),
		});
	}
}

// ---- 路由装配 ----

function apply(ctx) {
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		handler: async (req, res) => {
			// 防跨站: 必须携带自定义头 (跨域页面无法伪造)。
			if (req.headers[GUARD_HEADER] !== "1") {
				res.writeHead(403);
				res.end();
				return;
			}
			const absUrl = new URL(req.url, "http://dsh.internal");
			// GET 媒体路由: 原文返回字节流 (供 fetch+blob 预览)。
			if (req.method === "GET" && absUrl.pathname === API_PREFIX + "/file") {
				await serveMedia(req, res, ctx, absUrl);
				return;
			}
			if (req.method !== "POST") {
				sendJson(res, 405, { ok: false, error: "method not allowed" });
				return;
			}
			const pathname = absUrl.pathname;
			const method = pathname.startsWith(API_PREFIX + "/")
				? pathname.slice(API_PREFIX.length + 1)
				: undefined;
			if (!method || method.includes("/")) {
				sendJson(res, 404, { ok: false, error: "unknown method" });
				return;
			}
			const payload = await readJsonBody(req, res);
			if (payload === null) return;
			const { sessionId, cwd } = (() => {
				let sid = typeof payload.sessionId === "string" ? payload.sessionId : "";
				let cw = typeof payload.cwd === "string" && payload.cwd !== "" ? payload.cwd : undefined;
				return { sessionId: sid, cwd: cw };
			})();
			try {
				let result;
				switch (method) {
					case "session.cwd": {
					// 工作区根 = 资源管理器默认根目录 (优先工作区注册表, 对齐 dsh 工作区),
					// 让侧栏默认展示工作区根(如 D:\DeepSeekHarnessLauncher) 而非 runtime\dsh。
					const workspaceRoot = await resolveWorkspaceRoot(ctx, sessionId);
					// 会话工作目录权威来源是 header.cwd; 拿不到时用工作区根兜底,
					// 不再落到 dsh 进程 cwd(runtime\dsh), 否则默认路径会显示成 "dsh"。
					const workspace = sessionCwdOf(ctx, sessionId, cwd, workspaceRoot || undefined);
					const parent = dirname(workspace);
					result = {
						sessionId,
						cwd: workspace,
						root: basename(workspace) || workspace,
						parent: parent === workspace ? null : parent,
						workspaceRoot: workspaceRoot || undefined,
					};
					break;
				}
					case "fs.tree": {
						const workspace = sessionCwdOf(ctx, sessionId, cwd);
						const target = payload.path === undefined
							? (workspace === "" ? process.cwd() : workspace)
							: resolvePathUnder(workspace, requireString(payload, "path"));
						const listing = await listDirectory(workspace, target, LIST_LIMIT);
						result = { sessionId, cwd: workspace, listing };
						break;
					}
					case "fs.read": {
						const workspace = sessionCwdOf(ctx, sessionId, cwd);
						const target = resolvePathUnder(workspace, requireString(payload, "path"));
						result = { sessionId, cwd: workspace, file: await readText(target) };
						break;
					}
					case "fs.write": {
						const workspace = sessionCwdOf(ctx, sessionId, cwd);
						const target = resolvePathUnder(workspace, requireString(payload, "path"));
						await writeText(target, requireString(payload, "content"));
						result = { ok: true };
						break;
					}
					default:
						sendJson(res, 404, { ok: false, error: "unknown method: " + method });
						return;
				}
				sendJson(res, 200, { ok: true, ...result });
			} catch (error) {
				sendJson(res, 400, {
					ok: false,
					error: (error && error.message) ? error.message : String(error),
				});
			}
		},
	}), name + ": api prefix");
}

export { apply, inject, name };
