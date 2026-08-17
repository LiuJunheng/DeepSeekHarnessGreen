// DeepSeek Harness 插件 (宿主端): dsh-sidebar-lite
// 在 WebUI 右侧提供一个轻量侧边栏的数据后端, 能力聚焦五块:
//   1) 文件资源管理器: 列出会话工作目录的目录树, 支持「返回上级 / 路径框」上溯浏览
//                     (放开 isWithin 上限, 与内部 dsh-file-browser 插件一致);
//   2) 文件预览/编辑:  读取文本/二进制内容 (带 head 供前端嗅探), 写回保存;
//   3) 内嵌浏览器:     前端是沙箱 iframe, 本端不代理网络, 因此无需路由 (见 client);
//   4) CMD 终端:       child_process spawn cmd.exe + SSE 流 (轻量交互式 cmd, 避免
//                     node-pty 原生依赖), 按会话+标签页键控, 断连重连复用同一进程;
//   5) 任务管理:       复用官方会话事件日志重放 jobs 输出 + jobs.kill 停止接口。
// 参考/复刻自第三方插件 DSH Better Sidebar (omdsh-dev/DSH-better-sidebar):
//   本端实现了其中 fs.tree / fs.read / fs.write / session.cwd / file 媒体路由 / jobs 输出与
//   收割, 用 SSH 流替代其 node-pty 终端, 去掉了 git、settings 命名空间、browser.probe 等重依赖能力。
//
// 提供的接口 (路由前缀 /__dsh/sidebar-lite/*, 均要求自定义头 X-DSH-Sidebar-Lite: 1):
//   POST /__dsh/sidebar-lite/session.cwd     { sessionId }                 -> { sessionId, cwd, root, parent }
//   POST /__dsh/sidebar-lite/fs.tree         { sessionId, cwd?, path? }    -> 列目录 { path, entries, truncated }
//   POST /__dsh/sidebar-lite/fs.read         { sessionId, cwd?, path }     -> { kind, content|size, truncated, head? }
//   POST /__dsh/sidebar-lite/fs.write        { sessionId, cwd?, path, content } -> { ok }
//   GET  /__dsh/sidebar-lite/file            ?sessionId=&cwd=&path=&download=      -> 媒体字节 (图片/PDF/MD 等)
//   GET  /__dsh/sidebar-lite/terminal.stream ?sessionId=&cwd=&tab=         -> SSE 流 (command 输出/回放)
//   POST /__dsh/sidebar-lite/terminal.open   { sessionId, cwd?, tab? }     -> { ok, terminalId, transcript }
//   POST /__dsh/sidebar-lite/terminal.input  { sessionId, tab, line }      -> { ok }
//   POST /__dsh/sidebar-lite/terminal.kill   { sessionId, tab }            -> { ok }
//   POST /__dsh/sidebar-lite/jobs.output     { sessionId, id }             -> { text, truncated, read }
//   POST /__dsh/sidebar-lite/jobs.kill       { sessionId, id, reason? }    -> { ok, outcome }
// 安全约定:
//   - 资源管理器允许任意绝对路径 (上级浏览); 写操作同样是绝对路径, 用户自己负责范围,
//     与内部 dsh-file-browser 插件的行为一致;
//   - 用自定义头防跨站 (同 dsh-usage-stats 的先例, 跨域页面无法携带该头)。
// 不修改任何官方文件/包。
import { spawn } from "node:child_process";
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
const TRANSCRIPT_LIMIT = 1 * 1024 * 1024;    // 终端 transcript 回放缓冲上限 (1MB, 超出丢头)
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

/** 规范化绝对路径: 必须是绝对路径并 resolve, 否则抛错 (返回的异常对象)。 */
function fail(message) {
	const error = new Error(message);
	error.aborted = false;
	return error;
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
 * 取当前激活会话的工作目录 (权威来源是会话 header.cwd)。
 * 这里用 ctx.get("sessions") 动态取服务, 拿不到会话时回退到 guest 的 cwd 或进程 cwd。
 * 若会话无 cwd 且客户端提供了 cwd, 则用客户端 cwd。
 * @param {object} ctx - cordis 宿主上下文。
 * @param {string} sessionId - 会话 id。
 * @param {string} [clientCwd] - 客户端上报的工作目录 (作为兜底)。
 * @returns {string} 会话权威工作目录绝对路径。
 */
function sessionCwdOf(ctx, sessionId, clientCwd) {
	try {
		const sessions = ctx.get("sessions");
		const session = sessions && sessions.get(sessionId);
		const headerCwd = session && session.header && session.header.cwd;
		if (typeof headerCwd === "string" && headerCwd !== "") return headerCwd;
	} catch { /* sessions 服务不可用则忽略 */ }
	if (typeof clientCwd === "string" && clientCwd !== "") {
		try {
			if (!isAbsolute(clientCwd)) throw new Error("not absolute");
			return resolve(clientCwd);
		} catch {
			throw new Error("invalid client cwd: " + clientCwd);
		}
	}
	return process.cwd();
}

/**
 * 解析工作区根目录 (与内部 dsh-file-browser 的 home 同源: sandboxPolicy.workspaceRoot)。
 * 资源管理器默认以此作为根目录, 展示 E:\DeepSeekHarnessLauncher 整个项目,
 * 而非把会话工作目录 (如 runtime\dsh) 作为不可上溯的"固定根"。
 * 优先用 fs 服务把内部路径解析为可展示的绝对路径, fs 不可用则退回原始 workspaceRoot。
 * @param {object} ctx - cordis 宿主上下文。
 * @returns {Promise<string>} 工作区根绝对路径, 无法解析时返回空串。
 */
async function resolveWorkspaceRoot(ctx) {
	try {
		const sandboxPolicy = ctx.get("sandboxPolicy");
		const root = sandboxPolicy && typeof sandboxPolicy.workspaceRoot === "string"
			? sandboxPolicy.workspaceRoot
			: "";
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

// ---- CMD 终端 (轻量: child_process spawn cmd.exe + SSE 流) ----
//
// 每个终端按 `${sessionId}:${tab}` 键控, 用一把进程 + 有界 transcript 回放缓冲。
// 由于不走 node-pty (绿色版零原生依赖), cmd 无真实 TTY: 前端每次回车写一行到 stdin,
// cmd 默认回显并把命令输出打回 stdout, 我们原样流回前端。断连(刷新/切页)只摘除 SSE
// 监听器而不杀进程, 重连由 terminal.stream 再次挂接并回放 transcript; 只有「停止」按钮
// 或 terminal.kill 才真正结束进程。

/** 终端句柄表: key = `${sessionId}:${tab}`。 */
const TERMINALS = new Map();

function terminalKey(sessionId, tab) {
	return String(sessionId) + ":" + String(tab || "1");
}

/**
 * 打开 (或复用) 一个 cmd 终端进程。
 * @param {string} cwd - 进程初始工作目录。
 * @param {string} key - `${sessionId}:${tab}` 键。
 * @returns {{proc:object, transcript:string, closed:boolean, listeners:Set}} 终端句柄。
 */
function openTerminal(cwd, key) {
	const existing = TERMINALS.get(key);
	if (existing && !existing.closed) return existing;
	const proc = spawn("cmd.exe", [], { cwd: cwd || process.cwd() });
	// 中文系统 cmd.exe 默认以 GBK(cp936) 编码输出, 直接 Buffer.toString("utf8") 会乱码。
	// 用 TextDecoder("gbk") 逐块解码, stream:true 保留跨块的多字节字符状态 (node 标准构建
	// 带 full ICU 支持 gbk 标签; 若异常则降级为 utf8 解码)。
	const handle = {
		key,
		proc,
		transcript: "",
		closed: false,
		listeners: new Set(),
		decoder: (() => {
			try {
				return new TextDecoder("gbk");
			} catch (__decErr) {
				return null;
			}
		})(),
	};
	const decodeChunk = (chunk) => {
		if (handle.decoder) {
			return handle.decoder.decode(chunk, { stream: true });
		}
		return chunk.toString("utf8");
	};
	const appendToTranscript = (text) => {
		handle.transcript += text;
		if (handle.transcript.length > TRANSCRIPT_LIMIT) {
			handle.transcript = handle.transcript.slice(handle.transcript.length - TRANSCRIPT_LIMIT);
		}
	};
	const push = (text) => {
		appendToTranscript(text);
		for (const listener of handle.listeners) {
			listener(text);
		}
	};
	proc.stdout.on("data", (chunk) => push(decodeChunk(chunk)));
	proc.stderr.on("data", (chunk) => push(decodeChunk(chunk)));
	proc.on("close", (code) => {
		handle.closed = true;
		push("\r\n[进程已退出, 退出码 " + String(code) + "]\r\n");
	});
	TERMINALS.set(key, handle);
	return handle;
}

/** 关闭并清空一个终端 (停止按钮 / 插件卸载时)。 */
function closeTerminal(key) {
	const handle = TERMINALS.get(key);
	if (handle) {
		try { handle.proc.kill(); } catch { /* 已退出则忽略 */ }
	}
	TERMINALS.delete(key);
}

// ---- 任务管理 (jobs): 复用官方会话事件日志重放输出 + jobs.kill 收割 ----

/** 从一条会话事件里解析 jobs 输出: job_output 调用与其配对的 tool/result 文本。 */
function jobOutputParts(events, jobId) {
	const pairByCallId = new Map(); // callId -> job_id
	const parts = [];
	let read = false;
	for (const event of (events || [])) {
		if (event.type === "tool/call") {
			const data = event.data || {};
			if (data.name !== "job_output" || typeof data.callId !== "string") continue;
			let parsedJobId;
			try {
				const args = typeof data.arguments === "string" ? data.arguments : "";
				parsedJobId = JSON.parse(args).job_id;
			} catch { /* 参数无法解析则忽略 */ }
			if (typeof parsedJobId !== "string") continue;
			pairByCallId.set(data.callId, parsedJobId);
		} else if (event.type === "tool/result") {
			const message = event.data && event.data.message;
			if (message === undefined || typeof message.source.callId !== "string") continue;
			if (pairByCallId.get(message.source.callId) !== jobId) continue;
			read = true;
			const textBlocks = [];
			let isError = false;
			const collect = (blocks) => {
				for (const block of (blocks || [])) {
					if (block.type === "tool-result") {
						if (block.isError === true) isError = true;
						collect(block.content);
					} else if (block.type === "text" && typeof block.text === "string") {
						textBlocks.push(block.text);
					}
				}
			};
			collect(message.content);
			const text = textBlocks.join("\n");
			if (!isError && text !== "" && !text.startsWith("(no new output)")) {
				parts.push(text);
			}
		}
	}
	return { text: parts.join("\n"), read };
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
			// GET 终端 SSE 流: 回放 transcript 后持续推送命令输出。不进 POST 分支, 提前返回。
			if (req.method === "GET" && absUrl.pathname === API_PREFIX + "/terminal.stream") {
				const terminalSessionId = absUrl.searchParams.get("sessionId") || "";
				const terminalClientCwd = absUrl.searchParams.get("cwd") || undefined;
				const terminalTab = absUrl.searchParams.get("tab") || "1";
				const terminalWorkspace = sessionCwdOf(ctx, terminalSessionId, terminalClientCwd);
				const terminalHandle = openTerminal(terminalWorkspace, terminalKey(terminalSessionId, terminalTab));
				res.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
				});
				res.flushHeaders();
				const pushEvent = (text) => {
					if (res.writableEnded) return;
					res.write("data: " + JSON.stringify({ type: "out", text }) + "\n\n");
				};
				terminalHandle.listeners.add(pushEvent);
				// 先回放已累积的历史输出, 让重连后的页面恢复现场。
				if (terminalHandle.transcript !== "") {
					res.write("data: " + JSON.stringify({ type: "replay", text: terminalHandle.transcript }) + "\n\n");
				} else {
					res.write("data: " + JSON.stringify({ type: "ready", text: "" }) + "\n\n");
				}
				req.on("close", () => {
					// 断连只摘除监听器, 保留进程以便重连复用 (与 better-sidebar 的
					// reconnect grace 语义一致); 真正结束需 terminal.kill 或关闭 Tab。
					terminalHandle.listeners.delete(pushEvent);
				});
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
						const workspace = sessionCwdOf(ctx, sessionId, cwd);
						const parent = dirname(workspace);
						// 工作区根 = 资源管理器默认根目录 (对齐 dsh-file-browser 的 home),
						// 让侧栏默认展示 E:\DeepSeekHarnessLauncher 整个项目而非 runtime\dsh。
						const workspaceRoot = await resolveWorkspaceRoot(ctx);
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
					case "terminal.open": {
						// 确保终端进程已就绪 (SSE 连接前可选调用; SSE 挂接本身也会创建)。
						const terminalWorkspace = sessionCwdOf(ctx, sessionId, cwd);
						const terminalTab = typeof payload.tab === "string" ? payload.tab : "1";
						const terminalHandle = openTerminal(terminalWorkspace, terminalKey(sessionId, terminalTab));
						result = { ok: true, terminalId: terminalKey(sessionId, terminalTab), transcript: terminalHandle.transcript };
						break;
					}
					case "terminal.input": {
						const terminalTab = typeof payload.tab === "string" ? payload.tab : "1";
						const terminalHandle = TERMINALS.get(terminalKey(sessionId, terminalTab));
						if (terminalHandle === undefined || terminalHandle.closed) {
							throw new Error("终端不存在或已退出: " + terminalKey(sessionId, terminalTab));
						}
						const line = requireString(payload, "line");
						terminalHandle.proc.stdin.write(line + "\n");
						result = { ok: true };
						break;
					}
					case "terminal.kill": {
						const terminalTab = typeof payload.tab === "string" ? payload.tab : "1";
						closeTerminal(terminalKey(sessionId, terminalTab));
						result = { ok: true };
						break;
					}
					case "jobs.output": {
						const jobSessionId = requireString(payload, "sessionId");
						const jobId = requireString(payload, "id");
						const sessionService = ctx.get("sessions");
						const ownerSession = sessionService && sessionService.get(jobSessionId);
						result = { ...jobOutputParts(ownerSession ? ownerSession.events : [], jobId) };
						break;
					}
					case "jobs.kill": {
						const jobSessionId = requireString(payload, "sessionId");
						const jobId = requireString(payload, "id");
						const candidate = ctx.get("jobs");
						if (candidate === undefined) {
							throw new Error("后台任务注册表未挂载, 无法停止任务");
						}
						const agents = ctx.get("agents");
						const caller = agents && typeof agents.get === "function" ? agents.get(jobSessionId) : undefined;
						const reason = typeof payload.reason === "string" && payload.reason !== ""
							? payload.reason
							: "user requested via sidebar";
						result = { ok: true, outcome: candidate.kill(jobId, caller, reason) };
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