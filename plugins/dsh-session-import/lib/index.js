// DeepSeek Harness 插件 (宿主端): dsh-session-transfer
// 会话导入插件 = 导入 + (hook 官方导出按钮做另存为)。
//
// 导入 (后端):
//   POST /__dsh/session-transfer/upload  -> 接收 WebUI 上传的会话 ZIP / .jsonl,
//         校验格式后写回 DSH 持久化目录 (DSH_HOME/sessions/<项目>/<会话ID>/),
//         并把会话挂到 cwd 对应的工作区。与官方导出互逆。
//
// 导出 (前端直调官方):
//   客户端 Tab 直接 fetch('/api/session.export?sessionId=xxx&includeDescendants=true')
//   拿到 blob → showSaveFilePicker() 弹系统「另存为」对话框。
//   因为同域 (DSH WebUI 自己跑的 localhost), fetch 自动带 Cookie 鉴权,
//   不需要后端代理路由。这样就修复了官方按钮静默下载到默认目录、
//   在桌面壳 WebView2 下用户找不到文件的问题。
//
// 两个路由都要求自定义头 X-DSH-Session-Transfer: 1, 避免被误调。
//
// 写盘格式与官方持久化后端一致:
//   - 目录: sessions/<projectKey>/<encodeSegment(id)>/session.jsonl(.zstd)
//   - zstd: 校验和帧 (header + 事件)
//   - 附件: attachments/v1/objects/<sha256 前两位>/<sha256> (内容寻址)

import { readdir, writeFile, rename, mkdir, rm, realpath, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import zlib from "node:zlib";
import { createHash, randomBytes } from "node:crypto";
import { unzipSync } from "fflate";
import { SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";

const name = "dsh-session-import";
const inject = ["webServer", "workspaceRegistry"];

const ROUTE_HEALTH = "/__dsh/session-transfer/health";
const ROUTE_UPLOAD = "/__dsh/session-transfer/upload";
const GUARD_HEADER = "x-dsh-session-transfer";
const MAX_BODY_BYTES = 512 * 1024 * 1024; // 512MB, 覆盖含大量附件的导出包

// ------ 导入部分: 压缩参数 + 校验工具 ------
const ZSTD_CHECKSUM_PARAMS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

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

/** 读取请求体到 Buffer, 超限抛 TOO_LARGE。 */
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

function parseLogText(text, label) {
	const trimmed = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
	const lines = trimmed.split("\n");
	const first = lines.findIndex((l) => l.trim().length > 0);
	if (first === -1) throw new Error(`${label}: 文件为空`);
	const headerLine = lines[first].trim();
	let header;
	try { header = JSON.parse(headerLine); } catch { throw new Error(`${label}: 首行不是合法 JSON`); }
	if (header === null || typeof header !== "object" || header.type !== "session") throw new Error(`${label}: 首行不是会话 header (缺 type: "session")`);
	if (header.version !== SESSION_FORMAT_VERSION) throw new Error(`${label}: 会话格式版本不支持 (文件 ${JSON.stringify(header.version)}, 当前支持 ${SESSION_FORMAT_VERSION})`);
	if (typeof header.id !== "string" || header.id.length === 0) throw new Error(`${label}: header 缺少非空 id`);
	if (typeof header.createdAt !== "number" || !Number.isSafeInteger(header.createdAt) || header.createdAt < 0) throw new Error(`${label}: header.createdAt 非法`);
	if (typeof header.delegationDepth !== "number" || !Number.isSafeInteger(header.delegationDepth) || header.delegationDepth < 0) throw new Error(`${label}: header.delegationDepth 非法`);
	if (Object.hasOwn(header, "sandboxMode") || Object.hasOwn(header, "approvalPolicy")) throw new Error(`${label}: header 使用了已退役的 policy 字段 (sandboxMode/approvalPolicy), 拒绝导入`);
	if (header.cwd !== void 0 && typeof header.cwd !== "string") throw new Error(`${label}: header.cwd 非法`);
	const body = [];
	for (let i = first + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim().length === 0) continue;
		try { JSON.parse(line); } catch { throw new Error(`${label}: 第 ${i + 1} 行不是合法 JSON 行`); }
		body.push(line);
	}
	return { header, body };
}

function compressFrame(text) { return zlib.zstdCompressSync(Buffer.from(text, "utf8"), ZSTD_CHECKSUM_PARAMS); }

async function detectRootEncoding(sessionsRoot) {
	let sawZstd = false, sawPlain = false;
	let projects;
	try { projects = await readdir(sessionsRoot, { withFileTypes: true }); } catch { return "zstd"; }
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		let dirs;
		try { dirs = await readdir(join(sessionsRoot, project.name), { withFileTypes: true }); } catch { continue; }
		for (const d of dirs) {
			if (!d.isDirectory()) continue;
			const dir = join(sessionsRoot, project.name, d.name);
			if (!sawZstd) sawZstd = await exists(join(dir, "session.jsonl.zstd"));
			if (!sawPlain) sawPlain = await exists(join(dir, "session.jsonl"));
		}
		if (sawZstd && sawPlain) return "zstd";
	}
	return sawPlain && !sawZstd ? "none" : "zstd";
}

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function sessionExists(sessionsRoot, id) {
	const encoded = encodeSegment(id);
	let projects;
	try { projects = await readdir(sessionsRoot, { withFileTypes: true }); } catch { return false; }
	for (const project of projects) {
		if (!project.isDirectory()) continue;
		if (await exists(join(sessionsRoot, project.name, encoded))) return true;
	}
	return false;
}

async function atomicWrite(target, data) {
	await mkdir(dirname(target), { recursive: true });
	const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
	await writeFile(tmp, data);
	try { await rename(tmp, target); } catch (error) { await rm(tmp, { force: true }).catch(() => {}); throw error; }
}

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

async function writeAttachment(attachmentsRoot, attachmentId, data) {
	const m = /^sha256:([a-f0-9]{64})$/.exec(String(attachmentId));
	if (m === null) return { status: "skipped", reason: `附件引用不是 sha256 形式: ${attachmentId}` };
	const hex = m[1];
	const digest = createHash("sha256").update(data).digest("hex");
	if (digest !== hex) return { status: "skipped", reason: `附件摘要不匹配 (id=${attachmentId})` };
	const target = join(attachmentsRoot, "objects", hex.slice(0, 2), hex);
	if (await exists(target)) return { status: "exists" };
	try { await atomicWrite(target, data); return { status: "imported" }; }
	catch (error) { return { status: "error", reason: String((error && error.message) || error) }; }
}

async function attachSessionToWorkspace(ctx, sessionId, cwd) {
	const registry = ctx.workspaceRegistry;
	if (registry === void 0) return null;
	let canonical;
	try { canonical = await realpath(cwd); } catch { return null; }
	let workspace = void 0;
	for (const w of registry.list()) { try { if (await realpath(w.path) === canonical) { workspace = w; break; } } catch {} }
	if (workspace === void 0) { try { workspace = registry.create(canonical, undefined); } catch { return null; } }
	try { await workspace.attachSession(sessionId); return { id: workspace.id, title: workspace.title, path: workspace.path }; }
	catch (error) { return { id: workspace.id, title: workspace.title, path: workspace.path, attachError: String((error && error.message) || error) }; }
}

/** 导入核心入口 (ZIP 或原始 JSONL → DSH 持久化目录)。 */
async function importPayload(ctx, body, options = {}) {
	const sessionsRoot = join(dshHome(), "sessions");
	const attachmentsRoot = join(dshHome(), "attachments", "v1");
	const compression = options.compression || await detectRootEncoding(sessionsRoot);
	let logs = [], media = [];

	if (isZipBuffer(body)) {
		let files;
		try { files = unzipSync(new Uint8Array(body)); } catch (error) { throw new Error("无法解析 ZIP: " + String((error && error.message) || error)); }
		const names = Object.keys(files);
		const rootName = names.find((n) => n === "session.jsonl") ||
			names.find((n) => !n.startsWith("subagents/") && !n.startsWith("media/") && /\.jsonl$/i.test(n));
		if (rootName === void 0) throw new Error("ZIP 里找不到会话日志 (缺少 session.jsonl)");
		logs.push({ text: Buffer.from(files[rootName]).toString("utf8"), label: rootName });
		for (const n of names) { if (n.startsWith("subagents/") && /\.jsonl$/i.test(n)) logs.push({ text: Buffer.from(files[n]).toString("utf8"), label: n }); }
		for (const n of names) { const m = /^media\/(.+)\.(png|jpg|jpeg|webp|gif)$/i.exec(n); if (m !== null) media.push({ id: m[1], data: Buffer.from(files[n]), name: n }); }
	} else { logs.push({ text: body.toString("utf8"), label: "上传的 JSONL" }); }

	if (logs.length === 0) throw new Error("没有可导入的会话日志");
	const parsed = [];
	const seenIds = new Set();
	for (const log of logs) {
		const { header, body: bodyLines } = parseLogText(log.text, log.label);
		if (seenIds.has(header.id)) throw new Error(`${log.label}: 会话 id 重复 (${header.id})`);
		seenIds.add(header.id);
		parsed.push({ header, body: bodyLines, label: log.label });
	}

	const imported = [], skipped = [];
	for (const { header, body: bodyLines, label } of parsed) {
		if (await sessionExists(sessionsRoot, header.id)) { skipped.push({ id: header.id, label, status: "exists", reason: "该会话 id 已存在" }); continue; }
		const text = JSON.stringify(header) + "\n" + bodyLines.join("\n") + "\n";
		const file = await writeArtifact(sessionsRoot, header.cwd ?? "", header.id, text, compression);
		if (file === null) { skipped.push({ id: header.id, label, status: "exists", reason: "目标文件已存在" }); continue; }
		imported.push({ id: header.id, label, cwd: header.cwd ?? null, events: bodyLines.length, file });
	}

	const mediaResults = { imported: 0, exists: 0, skipped: [] };
	for (const entry of media) {
		const r = await writeAttachment(attachmentsRoot, entry.id, entry.data);
		if (r.status === "imported") mediaResults.imported++;
		else if (r.status === "exists") mediaResults.exists++;
		else mediaResults.skipped.push({ name: entry.name, reason: r.reason });
	}

	const workspaces = [];
	for (const s of imported) { const w = await attachSessionToWorkspace(ctx, s.id, s.cwd); if (w !== null) workspaces.push({ id: s.id, workspace: w }); }
	const root = parsed[0].header;
	return {
		ok: true, compression, sessionId: root.id, cwd: root.cwd ?? null,
		imported: imported.map((s) => ({ id: s.id, label: s.label, events: s.events })),
		skipped, media: { imported: mediaResults.imported, exists: mediaResults.exists, skipped: mediaResults.skipped },
		workspaces, note: "导入完成。请重启 DSH 服务以刷新会话列表（会话列表在启动时从持久化目录加载）。"
	};
}

// ------ apply: 注册两个路由 ------
function apply(ctx) {
	const register = (path, handler, label) => ctx.effect(() => ctx.webServer.register({
		kind: "exact", path, handler
	}), name + ": " + label);

	// Health
	register(ROUTE_HEALTH, async (req, res) => {
		if (req.headers[GUARD_HEADER] !== "1") { res.writeHead(403); res.end(); return; }
		sendJson(res, 200, { ok: true, plugin: name, version: "0.2.0" });
	}, "health");

	// 导入
	register(ROUTE_UPLOAD, async (req, res) => {
		if (req.headers[GUARD_HEADER] !== "1") { res.writeHead(403); res.end(); return; }
		if (req.method !== "POST") { sendJson(res, 405, { ok: false, error: "Method Not Allowed (use POST)" }); return; }
		let body;
		try { body = await readBody(req, MAX_BODY_BYTES); }
		catch (error) { sendJson(res, 413, { ok: false, error: String((error && error.message) || error) }); return; }
		try { sendJson(res, 200, await importPayload(ctx, body)); }
		catch (error) { sendJson(res, 400, { ok: false, error: String((error && error.message) || error) }); }
	}, "upload");
}

export { apply, inject, name, importPayload, encodeSegment, projectKey };
