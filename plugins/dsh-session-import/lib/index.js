// DeepSeek Harness 插件 (宿主端): dsh-session-import
// 提供「会话导入」的后端处理: 接收 WebUI 上传的会话导出 ZIP
// (官方 /api/session.export 生成的 dsh-session-<id>.zip) 或原始 .jsonl,
// 校验格式后写回 DSH 持久化目录 (DSH_HOME/sessions/<项目>/<会话ID>/),
// 并把会话挂到 cwd 对应的工作区。与官方导出互逆。
//
// 提供的接口 (路由 /__dsh/session-import/*, 均要求自定义头 X-DSH-Session-Import: 1):
//   GET  /__dsh/session-import/health  -> 插件是否已加载。
//   POST /__dsh/session-import/upload  -> 导入。请求体为 ZIP 字节或 JSONL 文本,
//         ZIP 按魔数 (PK) 自动识别, 其余按 JSONL 文本处理。
//
// 写盘格式与官方持久化后端 (@deepseek-ai/dsh-session-persistence-jsonl) 一致:
//   - 目录: sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.jsonl(.zstd)
//   - zstd 内容: 校验和帧(header 行) + 校验和帧(事件行), 逐字节复刻官方 encodeMaterialization
//   - 附件: attachments/v1/objects/<sha256 前两位>/<sha256> (内容寻址, 与官方一致)
// 不修改任何官方文件/包。

import { readdir, readFile, writeFile, rename, mkdir, rm, realpath, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import zlib from "node:zlib";
import { createHash, randomBytes } from "node:crypto";
import { unzipSync } from "fflate";
import { SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";

const name = "dsh-session-import";
const inject = ["webServer", "workspaceRegistry"];

const ROUTE_HEALTH = "/__dsh/session-import/health";
const ROUTE_UPLOAD = "/__dsh/session-import/upload";
const GUARD_HEADER = "x-dsh-session-import";
const MAX_BODY_BYTES = 512 * 1024 * 1024; // 512MB, 覆盖含大量附件的导出包

// 与官方后端一致的 zstd 校验和帧参数
const ZSTD_CHECKSUM_PARAMS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const ZSTD_MAGIC = 0x28b52ffd;

function dshHome() {
	return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(body);
}

function isZipBuffer(buf) {
	if (buf.length < 4) return false;
	return buf[0] === 0x50 && buf[1] === 0x4b &&
		(buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

/** 读取请求体到 Buffer, 超限返回 null (调用方回 413)。 */
function readBody(req, cap) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		req.on("data", (chunk) => {
			total += chunk.length;
			if (total > cap) {
				reject(Object.assign(new Error("请求体过大 (超过 512MB)"), { code: "TOO_LARGE" }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

/**
 * 会话 id 路径编码, 语义与官方 encodeSegment 逐字符一致:
 * 安全字符 (A-Za-z0-9._-) 原样保留, 其余 (含 ~) 转成 ~XXXX (大写十六进制)。
 */
function encodeSegment(raw) {
	if (raw.length === 0) throw new Error("cannot encode an empty path segment");
	if (raw === ".") return "~002E";
	if (raw === "..") return "~002E~002E";
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
		else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
	}
	return out;
}

/** 项目目录名, 语义与官方 projectKey 逐字符一致 (分隔符折叠为 -, 其余同 encodeSegment)。 */
function projectKey(cwd) {
	if (cwd.length === 0) throw new Error("cannot encode an empty project path");
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/**
 * 校验并解析日志文本: 第一行必须是合法会话 header (与官方 isHeaderLine/版本校验一致),
 * 其余每行必须是合法 JSON 行。返回 { header, body } (body 为去掉首行后的原文)。
 */
function parseLogText(text, label) {
	const trimmed = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const lines = trimmed.split("\n");
	const first = lines.findIndex((l) => l.trim().length > 0);
	if (first === -1) throw new Error(`${label}: 文件为空`);
	const headerLine = lines[first].trim();
	let header;
	try {
		header = JSON.parse(headerLine);
	} catch {
		throw new Error(`${label}: 首行不是合法 JSON`);
	}
	if (header === null || typeof header !== "object" || header.type !== "session") {
		throw new Error(`${label}: 首行不是会话 header (缺 type: "session")`);
	}
	if (header.version !== SESSION_FORMAT_VERSION) {
		throw new Error(`${label}: 会话格式版本不支持 (文件 ${JSON.stringify(header.version)}, 当前支持 ${SESSION_FORMAT_VERSION})`);
	}
	if (typeof header.id !== "string" || header.id.length === 0) {
		throw new Error(`${label}: header 缺少非空 id`);
	}
	if (typeof header.createdAt !== "number" || !Number.isSafeInteger(header.createdAt) || header.createdAt < 0) {
		throw new Error(`${label}: header.createdAt 非法`);
	}
	if (typeof header.delegationDepth !== "number" || !Number.isSafeInteger(header.delegationDepth) || header.delegationDepth < 0) {
		throw new Error(`${label}: header.delegationDepth 非法`);
	}
	if (Object.hasOwn(header, "sandboxMode") || Object.hasOwn(header, "approvalPolicy")) {
		throw new Error(`${label}: header 使用了已退役的 policy 字段 (sandboxMode/approvalPolicy), 拒绝导入`);
	}
	if (header.cwd !== void 0 && typeof header.cwd !== "string") {
		throw new Error(`${label}: header.cwd 非法`);
	}
	const body = [];
	for (let i = first + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim().length === 0) continue;
		try {
			JSON.parse(line);
		} catch {
			throw new Error(`${label}: 第 ${i + 1} 行不是合法 JSON 行`);
		}
		body.push(line);
	}
	return { header, body };
}

/** 压缩一帧 (带内容校验和), 与官方 compressZstdFrame 一致。 */
function compressFrame(text) {
	return zlib.zstdCompressSync(Buffer.from(text, "utf8"), ZSTD_CHECKSUM_PARAMS);
}

/** 探测整个 sessions 根的持久化编码: 存在明文 .jsonl 且无 .zstd 时为 none, 否则 zstd。 */
async function detectRootEncoding(sessionsRoot) {
	let sawZstd = false;
	let sawPlain = false;
	let projects;
	try {
		projects = await readdir(sessionsRoot, { withFileTypes: true });
	} catch {
		return "zstd";
	}
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		let dirs;
		try {
			dirs = await readdir(join(sessionsRoot, project.name), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const d of dirs) {
			if (!d.isDirectory()) continue;
			if (sawZstd && sawPlain) return "zstd";
			const dir = join(sessionsRoot, project.name, d.name);
			if (!sawZstd) sawZstd = await exists(join(dir, "session.jsonl.zstd"));
			if (!sawPlain) sawPlain = await exists(join(dir, "session.jsonl"));
		}
	}
	return sawPlain && !sawZstd ? "none" : "zstd";
}

async function exists(p) {
	try {
		await stat(p);
		return true;
	} catch {
		return false;
	}
}

/** 整个 sessions 根里是否已存在该会话 id (跨项目查, 防重复 id 触发后端报错)。 */
async function sessionExists(sessionsRoot, id) {
	const encoded = encodeSegment(id);
	let projects;
	try {
		projects = await readdir(sessionsRoot, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		if (await exists(join(sessionsRoot, project.name, encoded))) return true;
	}
	return false;
}

/** 原子写入新文件 (临时文件 + 改名), 目录自动创建。 */
async function atomicWrite(target, data) {
	await mkdir(dirname(target), { recursive: true });
	const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(tmp, data);
	try {
		await rename(tmp, target);
	} catch (error) {
		await rm(tmp, { force: true }).catch(() => {});
		throw error;
	}
}

/** 把一份日志文本写成官方布局的 artifact。返回 null 表示已存在跳过。 */
async function writeArtifact(sessionsRoot, cwd, id, text, compression) {
	const dir = join(sessionsRoot, projectKey(cwd), encodeSegment(id));
	const file = join(dir, compression === "none" ? "session.jsonl" : "session.jsonl.zstd");
	if (await exists(file)) return null;
	const lines = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const nl = lines.endsWith("\n") ? "" : "\n";
	const content = compression === "none"
		? Buffer.from(lines + nl, "utf8")
		: Buffer.concat([compressFrame(lines.split("\n", 1)[0] + "\n"), compressFrame(lines.slice(lines.indexOf("\n") + 1) + nl)]);
	await atomicWrite(file, content);
	return file;
}

/**
 * 写回一个附件 (内容寻址 objects/<前两位>/<sha256>)。id 形如 sha256:<64 hex>。
 * 摘要不一致或已存在时跳过 (内容寻址, 已存在即相同字节)。
 */
async function writeAttachment(attachmentsRoot, attachmentId, data) {
	const m = /^sha256:([a-f0-9]{64})$/.exec(String(attachmentId));
	if (m === null) return { status: "skipped", reason: `附件引用不是 sha256 形式: ${attachmentId}` };
	const hex = m[1];
	const digest = createHash("sha256").update(data).digest("hex");
	if (digest !== hex) return { status: "skipped", reason: `附件摘要不匹配 (id=${attachmentId})` };
	const target = join(attachmentsRoot, "objects", hex.slice(0, 2), hex);
	if (await exists(target)) return { status: "exists" };
	try {
		await atomicWrite(target, data);
		return { status: "imported" };
	} catch (error) {
		return { status: "error", reason: String((error && error.message) || error) };
	}
}

/** 把会话挂到 cwd 对应的工作区 (无匹配工作区且目录存在时自动创建)。 */
async function attachSessionToWorkspace(ctx, sessionId, cwd) {
	const registry = ctx.workspaceRegistry;
	if (registry === void 0) return null;
	let canonical;
	try {
		canonical = await realpath(cwd);
	} catch {
		return null; // cwd 在本机不存在 -> 不建工作区, 会话留在未分组
	}
	let workspace = void 0;
	for (const w of registry.list()) {
		try {
			if (await realpath(w.path) === canonical) {
				workspace = w;
				break;
			}
		} catch {
			// 工作区目录已不存在等情形 -> 跳过该候选
		}
	}
	if (workspace === void 0) {
		try {
			workspace = registry.create(canonical, undefined);
		} catch {
			return null;
		}
	}
	try {
		await workspace.attachSession(sessionId);
		return { id: workspace.id, title: workspace.title, path: workspace.path };
	} catch (error) {
		return { id: workspace.id, title: workspace.title, path: workspace.path, attachError: String((error && error.message) || error) };
	}
}

/** 导入一个 ZIP 或 JSONL。核心入口, 供路由与测试共用。 */
async function importPayload(ctx, body, options = {}) {
	const sessionsRoot = join(dshHome(), "sessions");
	const attachmentsRoot = join(dshHome(), "attachments", "v1");
	const compression = options.compression || await detectRootEncoding(sessionsRoot);

	let logs = [];   // { text, label, ownCwdFallback }
	let media = [];  // { id, data, name }

	if (isZipBuffer(body)) {
		let files;
		try {
			files = unzipSync(new Uint8Array(body));
		} catch (error) {
			throw new Error("无法解析 ZIP: " + String((error && error.message) || error));
		}
		const names = Object.keys(files);
		const rootName = names.find((n) => n === "session.jsonl") ||
			names.find((n) => !n.startsWith("subagents/") && !n.startsWith("media/") && /\.jsonl$/i.test(n));
		if (rootName === void 0) {
			throw new Error("ZIP 里找不到会话日志 (缺少 session.jsonl)");
		}
		logs.push({ text: Buffer.from(files[rootName]).toString("utf8"), label: rootName });
		for (const n of names) {
			if (n.startsWith("subagents/") && /\.jsonl$/i.test(n)) {
				logs.push({ text: Buffer.from(files[n]).toString("utf8"), label: n });
			}
		}
		for (const n of names) {
			const m = /^media\/(.+)\.(png|jpg|jpeg|webp|gif)$/i.exec(n);
			if (m !== null) media.push({ id: m[1], data: Buffer.from(files[n]), name: n });
		}
	} else {
		logs.push({ text: body.toString("utf8"), label: "上传的 JSONL" });
	}

	if (logs.length === 0) throw new Error("没有可导入的会话日志");

	// 逐份校验
	const parsed = [];
	const seenIds = new Set();
	for (const log of logs) {
		const { header, body } = parseLogText(log.text, log.label);
		if (seenIds.has(header.id)) throw new Error(`${log.label}: 会话 id 重复 (${header.id})`);
		seenIds.add(header.id);
		parsed.push({ header, body, label: log.label });
	}

	// 写日志
	const imported = [];
	const skipped = [];
	for (const { header, body, label } of parsed) {
		if (await sessionExists(sessionsRoot, header.id)) {
			skipped.push({ id: header.id, label, status: "exists", reason: "该会话 id 已存在, 跳过 (避免覆盖)" });
			continue;
		}
		const text = JSON.stringify(header) + "\n" + body.join("\n") + "\n";
		const file = await writeArtifact(sessionsRoot, header.cwd ?? "", header.id, text, compression);
		if (file === null) {
			skipped.push({ id: header.id, label, status: "exists", reason: "目标文件已存在, 跳过" });
			continue;
		}
		imported.push({ id: header.id, label, cwd: header.cwd ?? null, events: body.length, file });
	}

	// 写附件
	const mediaResults = { imported: 0, exists: 0, skipped: [] };
	for (const entry of media) {
		const r = await writeAttachment(attachmentsRoot, entry.id, entry.data);
		if (r.status === "imported") mediaResults.imported++;
		else if (r.status === "exists") mediaResults.exists++;
		else mediaResults.skipped.push({ name: entry.name, reason: r.reason });
	}

	// 挂工作区 (根会话 + 子会话)
	const workspaces = [];
	for (const s of imported) {
		const w = await attachSessionToWorkspace(ctx, s.id, s.cwd);
		if (w !== null) workspaces.push({ id: s.id, workspace: w });
	}

	const root = parsed[0].header;
	return {
		ok: true,
		compression,
		sessionId: root.id,
		cwd: root.cwd ?? null,
		imported: imported.map((s) => ({ id: s.id, label: s.label, events: s.events })),
		skipped,
		media: { imported: mediaResults.imported, exists: mediaResults.exists, skipped: mediaResults.skipped },
		workspaces,
		note: "导入完成。刷新 WebUI 会话列表即可看到; 如会话显示为「未分组」, 说明 header.cwd 指向的目录在本机不存在或未匹配任何工作区。"
	};
}

function apply(ctx) {
	const registerRoute = (path, handler, label) => {
		ctx.effect(() => ctx.webServer.register({
			kind: "exact",
			path,
			handler
		}), name + ": " + label);
	};

	registerRoute(ROUTE_HEALTH, async (req, res) => {
		if (req.headers[GUARD_HEADER] !== "1") {
			res.writeHead(403);
			res.end();
			return;
		}
		sendJson(res, 200, { ok: true, plugin: name, version: "0.1.0" });
	}, "health route");

	registerRoute(ROUTE_UPLOAD, async (req, res) => {
		if (req.headers[GUARD_HEADER] !== "1") {
			res.writeHead(403);
			res.end();
			return;
		}
		if (req.method !== "POST") {
			sendJson(res, 405, { ok: false, error: "Method Not Allowed (use POST)" });
			return;
		}
		let body;
		try {
			body = await readBody(req, MAX_BODY_BYTES);
		} catch (error) {
			sendJson(res, 413, { ok: false, error: String((error && error.message) || error) });
			return;
		}
		try {
			sendJson(res, 200, await importPayload(ctx, body));
		} catch (error) {
			sendJson(res, 400, { ok: false, error: String((error && error.message) || error) });
		}
	}, "upload route");
}

export { apply, inject, name, importPayload, encodeSegment, projectKey };
