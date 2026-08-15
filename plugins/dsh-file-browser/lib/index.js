// DeepSeek Harness 插件 (宿主端): dsh-file-browser
// WebUI 文件浏览与预览的后端: 注册三个本地 HTTP 路由 (均要求自定义头 X-DSH-File-Browser: 1,
// 跨域请求无法携带该头, 防止外部网页对本地端口发起读取):
//   GET  /__dsh/file-browser/home -> { root }                     起始目录 (workspace root)
//   POST /__dsh/file-browser/list -> { path, entries, truncated } 列目录
//   POST /__dsh/file-browser/read -> 文本 { kind:'text', content, lineCount }
//                                   | 图片 { kind:'image', dataUrl, size }
//                                   | { tooLarge, size } | { error }
// 文本预览上限 200KB, 图片预览上限 4MB, 单目录最多返回 1000 项。
// 通过 ctx.get('fs') 使用 dsh 文件系统服务, 与模型读写共用同一套路径语义。
// 不修改任何官方文件/包。

import { Buffer } from "node:buffer";

const name = "dsh-file-browser";
const inject = ["webServer"];

const BASE = "/__dsh/file-browser";
const GUARD_HEADER = "x-dsh-file-browser";
const TEXT_CAP = 200 * 1024;
const IMAGE_CAP = 4 * 1024 * 1024;
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
		const sp = ctx.get("sandboxPolicy");
		const root = sp && typeof sp.workspaceRoot === "string" ? sp.workspaceRoot : "";
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
			const dot = path.lastIndexOf(".");
			const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
			const mime = IMAGE_EXTS[ext];
			if (mime) {
				// 图片: 以 data URL 返回
				if (typeof info.size === "number" && info.size > IMAGE_CAP) {
					return sendJson(res, 200, { tooLarge: true, size: info.size });
				}
				const bytes = await fs.readBytes(target, undefined, IMAGE_CAP);
				sendJson(res, 200, {
					kind: "image",
					dataUrl: "data:" + mime + ";base64," + Buffer.from(bytes).toString("base64"),
					size: bytes.length,
				});
			} else {
				// 其余按文本处理 (二进制内容会被 fs 拒绝并转为 error)
				if (typeof info.size === "number" && info.size > TEXT_CAP) {
					return sendJson(res, 200, { tooLarge: true, size: info.size });
				}
				const text = await fs.readText(target);
				sendJson(res, 200, {
					kind: "text",
					content: text,
					lineCount: text.split("\n").length,
				});
			}
		} catch (e) {
			sendJson(res, 500, { error: errText(e) });
		}
	});
}

export { apply, inject, name };
