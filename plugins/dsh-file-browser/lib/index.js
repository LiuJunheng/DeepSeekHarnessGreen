// DeepSeek Harness 插件 (宿主端): dsh-file-browser
// WebUI 文件浏览与预览的后端: 注册三个本地 HTTP 路由 (均要求自定义头 X-DSH-File-Browser: 1,
// 跨域请求无法携带该头, 防止外部网页对本地端口发起读取):
//   GET  /__dsh/file-browser/home -> { root }                     起始目录 (workspace root)
//   POST /__dsh/file-browser/list -> { path, entries, truncated } 列目录
//   POST /__dsh/file-browser/read -> 文本 { kind:'text', content, size, truncated? }
//                                   | 图片 { kind:'image', dataUrl, size, truncated? }
//                                   | { kind:'binary', size, truncated? } (不可预览的大二进制)
//                                   | { error }
//                                   默认只预览前部 (文本 512KB, 图片 32MB, 二进制 4KB head)，
//                                   超出标 truncated，不再返回 tooLarge 直接报错 (见 #45 需求)。
//   POST /__dsh/file-browser/readChunk -> { content, size, truncated, offset, eof }
//                                   按偏移 offset 读指定 size (字节, 文本按 UTF8)，
//                                   支持用户点击「看后面一段」分批加载。
// 单目录最多返回 1000 项。
// 通过 ctx.get('fs') 使用 dsh 文件系统服务, 与模型读写共用同一套路径语义。
// 不修改任何官方文件/包。

import { Buffer } from "node:buffer";

const name = "dsh-file-browser";
const inject = ["webServer"];

const BASE = "/__dsh/file-browser";
const GUARD_HEADER = "x-dsh-file-browser";
// 默认 read 预览上限 (默认只读前部, 避免大文件一次性载入内存, 超出标 truncated,
// 客户端可点击「看后面一段」通过 readChunk 继续加载)。
const TEXT_PREVIEW_BYTES = 512 * 1024;    // 文本 512KB 预览 (≈25 万汉字, 够读)
const IMAGE_PREVIEW_BYTES = 32 * 1024 * 1024;  // 图片 32MB 预览 (仍以文件实际大小为主, 超大图 truncated)
const BINARY_HEAD_BYTES = 4096;            // 大二进制文件只读 4KB head (嗅探二进制/文本混合)
const READ_CHUNK_DEFAULT_BYTES = 512 * 1024;  // readChunk 单次默认 512KB
const READ_CHUNK_MAX_BYTES = 4 * 1024 * 1024; // readChunk 单次上限 4MB
const LIST_CAP = 1000;
const IMAGE_EXTS = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
};

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

/**
 * 解析"工作区根"绝对路径 (用户工作目录的根, 如 D:\DeepSeekHarnessLauncher)。
 * 优先级:
 *   1) workspaceRegistry (工作区注册表): 用户创建的工作区目录, 权威来源;
 *      有 sessionId 时优先取该会话所属工作区的 path, 否则取注册表第一个
 *      (注册表按创建顺序, 最新在前);
 *   2) sandboxPolicy.workspaceRoot: 配置显式设置的 workspaceRoot; 注意未配置时
 *      其默认值 = process.cwd() = runtime\dsh (dsh 进程被启动器以 cwd=DSH_DIR 拉起),
 *      不可作为"工作区根"兜底, 只能作为次选;
 *   3) 空串 (调用方再回退到会话 cwd, 已是最后的兜底)。
 * 目的: 当会话 header.cwd 与客户端 cwd 都拿不到时, 兜底根应该是用户的工作区根,
 * 而不是 dsh 服务进程 cwd(runtime\dsh, 目录名恰为 "dsh"), 否则文件浏览弹窗
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
 * 解析文件浏览弹窗的起始目录 (默认路径)。
 * 优先级 (与侧栏插件一致, 避免默认路径显示成 dsh 程序目录 runtime\dsh):
 *   1) 当前激活会话 header.cwd (用户为该会话指定的工作目录, 权威来源);
 *   2) 工作区注册表 workspaceRegistry 的工作区根 (会话所属工作区或注册表第一个);
 *   3) sandboxPolicy.workspaceRoot (仅显式配置, 与默认值 process.cwd() 不同才可信);
 *   4) 空串 (宿主端报错提示未配置)。
 * @param {object} ctx - cordis 宿主上下文。
 * @param {string} [sessionId] - 会话 id, 用于优先读会话 header.cwd / 匹配工作区。
 * @returns {string} 起始目录绝对路径, 找不到时返回空串。
 */
function homeRootOf(ctx, sessionId) {
	// 1) 会话 header.cwd: 当前激活会话的工作目录。
	try {
		const sessions = ctx.get("sessions");
		const session = sessions && typeof sessions.get === "function" && sessionId ? sessions.get(sessionId) : null;
		const headerCwd = session && session.header && typeof session.header.cwd === "string" ? session.header.cwd : "";
		if (headerCwd !== "") {
			return headerCwd;
		}
	} catch { /* sessions 服务不可用则忽略 */ }
	// 2) 工作区注册表 (工作区根)。
	const workspaceRoot = workspaceRootOf(ctx, sessionId);
	if (workspaceRoot !== "") return workspaceRoot;
	// 3) sandboxPolicy.workspaceRoot 显式配置。
	try {
		const sandboxPolicy = ctx.get("sandboxPolicy");
		const root = sandboxPolicy && typeof sandboxPolicy.workspaceRoot === "string" && sandboxPolicy.workspaceRoot !== ""
			? sandboxPolicy.workspaceRoot
			: "";
		if (root !== "" && root !== process.cwd()) return root;
	} catch { /* sandboxPolicy 服务不可用则忽略 */ }
	return "";
}

function apply(ctx) {
	const fs = ctx.get("fs");
	if (fs === undefined) return; // fs 服务未挂载时不注册路由

	const errText = (e) => String((e && e.message) || e || "unknown error");

	// 注意: ctx.effect 会把传入回调的返回值当作清理函数, 因此必须把
	// webServer.register(...) 包进回调里 (返回值即注销函数), 不能先注册再把
	// 注销函数直接传给 effect, 否则路由注册后会被立即注销 (HTTP 405)。
	const register = (path, handler) => ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path,
		handler,
	}), "dsh-file-browser: " + path);

	/** 自定义头守卫, 不通过时直接 403 并返回 false。 */
	const guarded = (req, res) => {
		if (req.headers[GUARD_HEADER] !== "1") {
			res.writeHead(403);
			res.end();
			return false;
		}
		return true;
	};

	register(BASE + "/home", async (req, res) => {
		if (req.method !== "GET") return sendJson(res, 405, { error: "use GET" });
		if (!guarded(req, res)) return;
		// 起始目录解析: 优先当前激活会话 header.cwd, 其次工作区注册表,
		// 最后才轮到 sandboxPolicy.workspaceRoot (仅显式配置)。避免默认路径
		// 显示成 dsh 程序目录 runtime\dsh (未配置时 workspaceRoot = process.cwd())。
		const absUrl = new URL(req.url, "http://dsh.internal");
		const sessionId = absUrl.searchParams.get("sessionId") || "";
		const root = homeRootOf(ctx, sessionId);
		if (!root) return sendJson(res, 500, { error: "no workspace root configured" });
		try {
			const target = await fs.resolve(root);
			sendJson(res, 200, { root: fs.processPath(target) });
		} catch (e) {
			sendJson(res, 500, { error: errText(e) });
		}
	});

	register(BASE + "/list", async (req, res) => {
		if (req.method !== "POST") return sendJson(res, 405, { error: "use POST" });
		if (!guarded(req, res)) return;
		let body;
		try {
			body = await readJsonBody(req);
		} catch (e) {
			return sendJson(res, 400, { error: errText(e) });
		}
		const path = typeof body.path === "string" ? body.path : "";
		if (!path) return sendJson(res, 400, { error: "missing path" });
		try {
			const target = await fs.resolve(path);
			const info = await fs.stat(target);
			if (!info || info.type !== "directory") {
				return sendJson(res, 400, { error: "not a directory: " + path });
			}
			const entries = await fs.listDir(target);
			const mapped = entries.map((e) => ({
				name: e.name,
				type: e.type,
				size: typeof e.size === "number" ? e.size : null,
				path: e.target && e.target.displayPath ? e.target.displayPath : "",
			}));
			sendJson(res, 200, {
				path: fs.processPath(target),
				entries: mapped.slice(0, LIST_CAP),
				truncated: mapped.length > LIST_CAP,
			});
		} catch (e) {
			sendJson(res, 500, { error: errText(e) });
		}
	});

	register(BASE + "/read", async (req, res) => {
		if (req.method !== "POST") return sendJson(res, 405, { error: "use POST" });
		if (!guarded(req, res)) return;
		let body;
		try {
			body = await readJsonBody(req);
		} catch (e) {
			return sendJson(res, 400, { error: errText(e) });
		}
		const path = typeof body.path === "string" ? body.path : "";
		if (!path) return sendJson(res, 400, { error: "missing path" });
		try {
			const target = await fs.resolve(path);
			const info = await fs.stat(target);
			if (!info || info.type !== "file") {
				return sendJson(res, 400, { error: "not a file: " + path });
			}
			const fileSize = typeof info.size === "number" ? info.size : 0;
			const dot = path.lastIndexOf(".");
			const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
			const mime = IMAGE_EXTS[ext];
			if (mime) {
				// 图片: 文件≤预览上限才做完整 dataURL; 更大的图片只取前部 head + 标 truncated
				// (客户端提示"图片过大, 以下为缩略预览", 避免一次性 base64 炸内存)。
				const needFull = fileSize > 0 && fileSize <= IMAGE_PREVIEW_BYTES;
				const cap = needFull ? fileSize : Math.min(fileSize, IMAGE_PREVIEW_BYTES);
				const bytes = cap > 0
					? (await fs.readBytes(target, undefined, cap))
					: new Uint8Array(0);
				const truncated = fileSize > bytes.length;
				sendJson(res, 200, {
					kind: "image",
					dataUrl: bytes.length > 0
						? "data:" + mime + ";base64," + Buffer.from(bytes).toString("base64")
						: "",
					size: fileSize,
					truncated,
				});
			} else {
				// 非图片: 先按「文本 UTF-8」只读前部字节 (TEXT_PREVIEW_BYTES),
				// 返回 content + size + truncated。若 fs.readText 被文件类型判定为非文本
				// 抛错, 则降级为 binary 读 head(只给大小 + truncated + 4KB 嗅探字节 hex),
				// 不再直接说"过大无法预览"。
				let readBytes;
				let decodedText = "";
				let binaryFallback = false;
				try {
					// fs 语义下: readBytes(target, offset, count) -> Uint8Array
					readBytes = await fs.readBytes(target, undefined, TEXT_PREVIEW_BYTES);
					decodedText = Buffer.from(readBytes).toString("utf8");
				} catch (__readErr) {
					binaryFallback = true;
					try {
						readBytes = await fs.readBytes(target, undefined, BINARY_HEAD_BYTES);
					} catch (__headErr) {
						readBytes = new Uint8Array(0);
					}
				}
				if (binaryFallback) {
					const truncated = fileSize > readBytes.length;
					sendJson(res, 200, {
						kind: "binary",
						size: fileSize,
						truncated,
						head: readBytes.length > 0
							? Buffer.from(readBytes).toString("base64")
							: "",
					});
				} else {
					const truncated = fileSize > readBytes.length;
					sendJson(res, 200, {
						kind: "text",
						content: decodedText,
						size: fileSize,
						truncated,
					});
				}
			}
		} catch (e) {
			sendJson(res, 500, { error: errText(e) });
		}
	});

	register(BASE + "/readChunk", async (req, res) => {
		if (req.method !== "POST") return sendJson(res, 405, { error: "use POST" });
		if (!guarded(req, res)) return;
		let body;
		try {
			body = await readJsonBody(req);
		} catch (e) {
			return sendJson(res, 400, { error: errText(e) });
		}
		const path = typeof body.path === "string" ? body.path : "";
		const offset = Number.isFinite(Number(body.offset)) ? Math.max(0, Number(body.offset)) : 0;
		const sizeRequest = Number.isFinite(Number(body.size)) ? Math.max(0, Number(body.size)) : READ_CHUNK_DEFAULT_BYTES;
		const size = Math.min(sizeRequest || READ_CHUNK_DEFAULT_BYTES, READ_CHUNK_MAX_BYTES);
		if (!path) return sendJson(res, 400, { error: "missing path" });
		try {
			const target = await fs.resolve(path);
			const info = await fs.stat(target);
			if (!info || info.type !== "file") {
				return sendJson(res, 400, { error: "not a file: " + path });
			}
			const fileSize = typeof info.size === "number" ? info.size : 0;
			if (offset >= fileSize) {
				return sendJson(res, 200, {
					content: "",
					size: fileSize,
					truncated: false,
					offset,
					eof: true,
				});
			}
			// ---- UTF-8 多字节字符跨块裁剪保护 ----
			// 客户端靠字节 (Blob.size) 估算 offset, 这个 offset 可能落在一个 UTF-8 多字节
			// 序列的中间, 直接从这里读会产生"首字节残缺"导致乱码。解决办法:
			//   1) 本端多读一点 (back = min(3, offset) 字节, 覆盖前一个可能的 UTF-8 tail)
			//      并把 back 数一并回传;
			//   2) 客户端在返回字符串里, 扫前 (back+1) 字节对应字符, 找到第一个合法起始
			//      之后的内容做增量拼接, 前缀丢掉的字节在上一轮 preview.content 末尾已经
			//      解码过了, 不会真的丢内容。
			const back = Math.min(3, offset);
			const actualStart = offset - back;
			const end = Math.min(fileSize, offset + size);
			const readCount = end - actualStart;
			const bytes = await fs.readBytes(target, actualStart, readCount);
			const content = Buffer.from(bytes).toString("utf8");
			sendJson(res, 200, {
				content,
				size: fileSize,
				truncated: end < fileSize,
				offset,
				back,
				eof: end >= fileSize,
			});
		} catch (e) {
			sendJson(res, 500, { error: errText(e) });
		}
	});
}

export { apply, inject, name };
