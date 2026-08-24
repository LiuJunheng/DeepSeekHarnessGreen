// DeepSeek Harness 插件 (宿主端): dsh-media-background
// 把"本地目录里的视频"作为网页背景播放的资源端。
// 由于播放目录是任意绝对路径, 不经 harness 的沙箱 fs, 直接 node:fs 读文件系统。
// 提供四个同源路由 (绑定在 harness 自身的 web server 上, 均要求自定义头
// x-dsh-media-bg 守卫, 防外部网页对本地端口发起读取):
//   GET  /__dsh/media-bg/config  -> {ok, dir, from}       当前生效目录
//   POST /__dsh/media-bg/config  -> {ok, dir}             设置目录 (校验后持久化)
//   GET  /__dsh/media-bg/list    -> {ok, dir, files}      扫描当前目录的视频 (递归子文件夹)
//   GET  /__dsh/media-bg/browse?path=<abs>  -> {ok,browse,dir,parent,children,isRoot,drives}
//                                                         目录浏览 (客户端「选目录」弹窗用)
//   GET  /__dsh/media-bg/pickdir?path=<abs> -> {ok,dir}   优先弹 Windows 原生文件夹选择框
//   GET  /__dsh/media-bg/stream?path=<rel>                视频 Range 流
// 目录来源优先级:
//   1) DSH_HOME/media-background-dir.json (面板里改过, 持久)
//   2) 环境变量 DSH_MEDIA_BG_DIR (可选; 供显式注入的默认)
//   3) 空串 (前端提示未配置)
// 安全设计: 目录受限读 (只读当前配置的目录), 防路径穿越, 全部路由带守卫头。

import { stat, readdir, readFile, writeFile, access, mkdtemp, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

const name = "dsh-media-background";
const inject = ["webServer"];

const BASE = "/__dsh/media-bg";
const GUARD_HEADER = "x-dsh-media-bg";
// 可作背景播放的媒体扩展名清单, 分两类:
//   VIDEO_EXTS: 显示画面 (可作为网页背景壁纸)
//   AUDIO_EXTS: 纯音频 (mp3/wav 等, 只出声不显示画面, 保留原生背景板 = 纯音乐模式)
// 说明: mkv/avi/flv/wmv 等能否解出来取决于浏览器内核与编码, 这里统一列出并交给浏览器尝试,
//       能放的直接播放, 放不了的会在前端自动跳到下一首, 不影响整体使用。
const VIDEO_EXTS = new Set(["mp4", "webm", "m4v", "mov", "ogg", "mkv", "avi", "flv", "wmv", "mpg", "mpeg", "ts", "3gp", "m2ts"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "flac", "aac", "m4a", "wma", "opus", "amr"]);
const MIME = {
	mp4: "video/mp4",
	webm: "video/webm",
	m4v: "video/x-m4v",
	mov: "video/quicktime",
	ogg: "video/ogg",
	mkv: "video/x-matroska",
	avi: "video/x-msvideo",
	flv: "video/x-flv",
	wmv: "video/x-ms-wmv",
	mpg: "video/mpeg",
	mpeg: "video/mpeg",
	ts: "video/mp2t",
	"3gp": "video/3gpp",
	m2ts: "video/mp2t",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	flac: "audio/flac",
	aac: "audio/aac",
	m4a: "audio/mp4",
	wma: "audio/x-ms-wma",
	opus: "audio/opus",
	amr: "audio/amr",
};
// 面板持久化的目录配置文件 (存 DSH_HOME 下, 由启动器 build_env 注入 DSH_HOME)。
function dshConfigPath() {
	return path.join(process.env.DSH_HOME || ".", "media-background-dir.json");
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

/** Windows 大小写不敏感: 统一转小写后再比较, 避免因大小写差异误判。 */
function normForCompare(p) {
	const s = path.resolve(p);
	return path.win32 ? s.toLowerCase() : s;
}

/** 校验 target 是否位于 root 目录内 (含 root 自身), 防止路径穿越到目录外。 */
function isInside(root, target) {
	try {
		const rootRes = normForCompare(root);
		const tgtPath = normForCompare(target);
		if (tgtPath === rootRes) return true;
		const prefix = rootRes.endsWith(path.win32.sep) ? rootRes : rootRes + path.win32.sep;
		return tgtPath.startsWith(prefix);
	} catch {
		return false;
	}
}

/** 解析当前生效目录 (见顶部优先级)。返回 {dir, from}。 */
async function resolveDir() {
	try {
		const raw = await readFile(dshConfigPath(), "utf8");
		const cfg = JSON.parse(raw);
		if (cfg && typeof cfg.dir === "string" && cfg.dir.trim() !== "") {
			return { dir: cfg.dir.trim(), from: "json" };
		}
	} catch { /* 无持久化文件或解析失败则继续 */ }
	const envDir = (process.env.DSH_MEDIA_BG_DIR || "").trim();
	if (envDir !== "") {
		return { dir: envDir, from: "env" };
	}
	return { dir: "", from: "none" };
}

/** 递归遍历目录, 列出可直接播放的视频文件 (含子文件夹, 每层最多 MAX_DEPTH 深)。
 *  子文件夹里的视频 rel 用「/」作分隔的相对路径 (与 url 一致, stream 端据此解析)。 */
const MAX_SCAN_DEPTH = 6;
async function listVideos(dir, base = "") {
	const files = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return files; // 无权限子目录跳过, 不中断整体扫描
	}
	for (const entry of entries) {
		const relName = base ? base + "/" + entry.name : entry.name;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (base.split("/").length >= MAX_SCAN_DEPTH) continue; // 控制深度
			const sub = await listVideos(full, relName);
			files.push(...sub);
			continue;
		}
		if (!entry.isFile()) continue;
		const dot = entry.name.lastIndexOf(".");
		const ext = dot >= 0 ? entry.name.slice(dot + 1).toLowerCase() : "";
		if (!VIDEO_EXTS.has(ext) && !AUDIO_EXTS.has(ext)) continue;
		// 判断媒体类型: 纯音频走"纯音乐模式", 其余一律当视频背景。
		const kind = AUDIO_EXTS.has(ext) ? "audio" : "video";
		let size = null;
		try {
			const info = await stat(full);
			size = info.size;
		} catch { /* 无法 stat 的文件仍列出, 大小置空 */ }
		files.push({ name: relName, path: relName, size, kind, url: "/__dsh/media-bg/stream?path=" + encodeURIComponent(relName) });
	}
	// 名称排序 (和 Windows 资源管理器一致的中文友好排序, 逐字 codepoint)。
	files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return files;
}

/** 扫描指定目录的直接子文件夹名 (目录浏览选择器用)。
 *  当前目录不存在的风险已由调用方 prefix isInside 校验兜底。 */
async function listSubdirs(dir) {
	const names = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return names;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) names.push(entry.name);
	}
	names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	return names;
}

/** 列出当前机器的盘符 (仅 Windows, 供目录浏览选择器的"我的电脑"层)。 */
async function listDrives() {
	const drives = [];
	if (process.platform !== "win32") return drives;
	for (let letter = 65; letter <= 90; letter++) { // A..Z
		const drive = String.fromCharCode(letter) + ":\\";
		try {
			await access(drive);
			drives.push(drive);
		} catch { /* 未挂载的盘跳过 */ }
	}
	return drives;
}

/**
 * Windows 原生文件夹选择框 (服务端本机弹出):
 * 生成一份临时 PowerShell 脚本, 用 .NET 的 FolderBrowserDialog 显示系统标准选目录对话框。
 * 初始目录通过环境变量 DSH_PICK_INITIAL 传入 (不走脚本内联字符串, 规避路径拼接/转义问题;
 * ps1 脚本本身为纯 ASCII, 避免 PowerShell 编码导致中文乱码)。
 * 返回所选绝对路径; 用户取消 / 非 Windows / 执行失败均返回 null (让前端回退到网页逐层浏览)。
 */
const NATIVE_PICK_SCRIPT = [
	"Add-Type -AssemblyName System.Windows.Forms;",
	// 取当前前台窗口句柄, 包装成 owner 传给 ShowDialog, 保证对话框模态于前台窗口之上、
	// 弹到最上层, 不会被其他窗口遮挡 (原无 owner 的 ShowDialog 常被盖住、看似没弹出)。
	"Add-Type -TypeDefinition @'",
	"using System;",
	"using System.Runtime.InteropServices;",
	"public static class DshMbgWin32 {",
	"	[DllImport(\"user32.dll\")]",
	"	public static extern IntPtr GetForegroundWindow();",
	"}",
	"'@;",
	"$folderBrowser = New-Object System.Windows.Forms.FolderBrowserDialog;",
	"$folderBrowser.Description = 'Select the video background folder';",
	"$folderBrowser.ShowNewFolderButton = $false;",
	"if ($env:DSH_PICK_INITIAL -and (Test-Path -LiteralPath $env:DSH_PICK_INITIAL)) {",
	"	$folderBrowser.SelectedPath = $env:DSH_PICK_INITIAL;",
	"}",
	"$ownerHwnd = [DshMbgWin32]::GetForegroundWindow();",
	"if ($ownerHwnd -ne [IntPtr]::Zero) {",
	"	$nativeWindow = New-Object System.Windows.Forms.NativeWindow;",
	"	$nativeWindow.AssignHandle($ownerHwnd);",
	"	try { $result = $folderBrowser.ShowDialog($nativeWindow); }",
	"	finally { $nativeWindow.ReleaseHandle(); }",
	"} else {",
	"	$result = $folderBrowser.ShowDialog();",
	"}",
	"if ($result -eq [System.Windows.Forms.DialogResult]::OK) {",
	"	Write-Output $folderBrowser.SelectedPath;",
	"	exit 0;",
	"}",
	"exit 1;",
].join("\r\n");

async function pickNativeDir(initialDir) {
	if (process.platform !== "win32") return null;
	// 用 SystemRoot 拼完整路径, 不依赖进程 PATH (dsh 的 Node 进程 PATH 未必含 WindowsPowerShell 目录)。
	const powershellPath = path.join(process.env.SystemRoot || "C:\\Windows",
		"System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	try { await access(powershellPath); } catch { return null; }
	let tempDir = "";
	try {
		tempDir = await mkdtemp(path.join(os.tmpdir(), "dsh-mbg-pick-"));
		const ps1Path = path.join(tempDir, "pickdir.ps1");
		await writeFile(ps1Path, NATIVE_PICK_SCRIPT, { encoding: "utf8" });
		const env = Object.assign({}, process.env, { DSH_PICK_INITIAL: initialDir || "" });
		const picked = await new Promise((resolve) => {
			execFile(powershellPath,
				["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1Path],
				{ env, timeout: 0, windowsHide: true, maxBuffer: 1024 * 1024 },
				(error, stdout) => {
					// 正常选中 exit 0 且输出所选路径; 取消或异常均视为未选择。
					const out = String(stdout || "").trim();
					resolve(!error && out ? out : null);
				});
		});
		if (!picked) return null;
		const info = await stat(picked);
		return info.isDirectory() ? picked : null;
	} catch {
		return null;
	} finally {
		if (tempDir) { try { await rm(tempDir, { recursive: true, force: true }); } catch { /* 忽略清理失败 */ } }
	}
}

/**
 * 守卫头校验, 不通过直接 403 并返回 false。
 * harness 的 webServer 对浏览器之外的请求也开放, 自定义头是唯一的可信门槛。
 */
function guarded(req, res) {
	if (req.headers[GUARD_HEADER] !== "1") {
		res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
		res.end("403 forbidden: missing guard header");
		return false;
	}
	return true;
}

/** 从查询串解析单个参数。 */
function queryParam(req, key) {
	try {
		const url = new URL(req.url || "/", "http://dsh.internal");
		return url.searchParams.get(key) || "";
	} catch {
		return "";
	}
}

/** 处理视频 Range 流 (支持<video>拖进度条)。 */
function serveStream(req, res, dir) {
	const rel = queryParam(req, "path");
	if (!rel) {
		return sendJson(res, 400, { error: "missing path" });
	}
	let relPath;
	try {
		relPath = decodeURIComponent(rel);
	} catch {
		relPath = rel;
	}
	if (relPath.indexOf("\0") >= 0) {
		return sendJson(res, 400, { error: "bad path" });
	}
	const target = path.resolve(dir, relPath);
	if (!isInside(dir, target)) {
		// 防穿越: 尝试读取配置目录之外的文件一律拒绝。
		res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
		res.end("403 forbidden: outside of media dir");
		return;
	}
	stat(target).then((info) => {
		if (!info.isFile()) {
			return sendJson(res, 400, { error: "not a file" });
		}
		const fileSize = info.size;
		const dot = relPath.lastIndexOf(".");
		const ext = dot >= 0 ? relPath.slice(dot + 1).toLowerCase() : "";
		const contentType = MIME[ext] || "application/octet-stream";
		// ---- 解析 Range 头: bytes=start-end ----
		const range = req.headers.range;
		let start = 0;
		let end = fileSize - 1;
		let status = 200;
		if (range && /^bytes=/.test(range)) {
			const match = /^bytes=(\d*)-(\d*)$/.exec(range);
			if (match) {
				const rangeStart = match[1] !== "" ? Number(match[1]) : null;
				const rangeEnd = match[2] !== "" ? Number(match[2]) : null;
				if (Number.isFinite(rangeStart) && rangeStart > 0) {
					start = rangeStart;
					if (Number.isFinite(rangeEnd)) {
						end = rangeEnd;
					}
					status = 206;
				} else if (Number.isFinite(rangeEnd)) {
					// 结尾区间: bytes=-N 表示最后 N 字节。
					start = Math.max(0, fileSize - rangeEnd);
					status = 206;
				}
				// start 不能越界。
				if (start >= fileSize) {
					res.writeHead(416, {
						"content-range": "bytes */" + fileSize,
						"content-type": contentType,
					});
					res.end();
					return;
				}
				if (end >= fileSize) end = fileSize - 1;
			}
		}
		const headers = {
			"content-type": contentType,
			"accept-ranges": "bytes",
			"cache-control": "no-store",
		};
		if (status === 206) {
			headers["content-range"] = "bytes " + start + "-" + end + "/" + fileSize;
			headers["content-length"] = String(end - start + 1);
		} else {
			headers["content-length"] = String(fileSize);
		}
		res.writeHead(status, headers);
		const stream = createReadStream(target, { start, end });
		stream.on("error", () => { res.destroy(); });
		req.on("close", () => { if (!res.writableEnded) stream.destroy(); });
		stream.pipe(res);
	}).catch(() => {
		sendJson(res, 404, { error: "file not found" });
	});
}

function apply(ctx) {
	// ctx.effect 会把回调的返回值当作清理函数, 因此把注册包进回调, 不能先注册再传注销函数。
	const register = (routePath, handler) => ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: routePath,
		handler,
	}), "dsh-media-background: " + routePath);

	const errText = (error) => String((error && error.message) || error || "unknown error");

	// 查询 / 设置当前生效目录 (GET 查询, POST 设置并持久化, 供下次启动继续用)。
	register(BASE + "/config", async (req, res) => {
		if (!guarded(req, res)) return;
		if (req.method === "GET") {
			try {
				const resolved = await resolveDir();
				sendJson(res, 200, { ok: true, dir: resolved.dir, from: resolved.from });
			} catch (error) {
				sendJson(res, 500, { ok: false, error: errText(error) });
			}
			return;
		}
		if (req.method === "POST") {
			let body;
			try {
				body = await readJsonBody(req);
			} catch (error) {
				return sendJson(res, 400, { ok: false, error: errText(error) });
			}
			const dir = typeof body.dir === "string" ? body.dir.trim() : "";
			if (!dir) {
				return sendJson(res, 400, { ok: false, error: "目录不能为空" });
			}
			try {
				const info = await stat(dir);
				if (!info.isDirectory()) {
					return sendJson(res, 400, { ok: false, error: "不是有效目录: " + dir });
				}
				await writeFile(dshConfigPath(), JSON.stringify({ dir }, null, 2), "utf8");
				sendJson(res, 200, { ok: true, dir });
			} catch (error) {
				sendJson(res, 500, { ok: false, error: errText(error) });
			}
			return;
		}
		sendJson(res, 405, { error: "use GET or POST" });
	});

	// 扫描当前目录的视频。
	register(BASE + "/list", async (req, res) => {
		if (req.method !== "GET") return sendJson(res, 405, { error: "use GET" });
		if (!guarded(req, res)) return;
		try {
			const resolved = await resolveDir();
			if (!resolved.dir) {
				return sendJson(res, 200, { ok: true, dir: "", files: [], error: "未配置视频目录" });
			}
			let info;
			try {
				info = await stat(resolved.dir);
			} catch {
				return sendJson(res, 200, { ok: true, dir: resolved.dir, files: [], error: "目录不存在: " + resolved.dir });
			}
			if (!info.isDirectory()) {
				return sendJson(res, 200, { ok: true, dir: resolved.dir, files: [], error: "不是目录: " + resolved.dir });
			}
			const files = await listVideos(resolved.dir);
			sendJson(res, 200, { ok: true, dir: resolved.dir, from: resolved.from, files });
		} catch (error) {
			sendJson(res, 500, { ok: false, error: errText(error) });
		}
	});

	// 目录浏览: 客户端「选目录」弹窗逐层下钻用。
	// path 缺省 = 根层 (Windows 列盘符; 其他平台列 "/"); 否则返回该目录的直接子文件夹。
	register(BASE + "/browse", async (req, res) => {
		if (req.method !== "GET") return sendJson(res, 405, { error: "use GET" });
		if (!guarded(req, res)) return;
		try {
			const browsePath = (queryParam(req, "path") || "").replace(/^\+/g, "");
			if (!browsePath) {
				// 根层: 列盘符 (Windows)。
				const drives = await listDrives();
				return sendJson(res, 200, {
					ok: true, browse: true, dir: "", parent: "", isRoot: true, children: drives,
				});
			}
			const info = await stat(browsePath);
			if (!info.isDirectory()) {
				return sendJson(res, 200, { ok: false, error: "不是目录: " + browsePath });
			}
			const children = await listSubdirs(browsePath);
			let parent = path.dirname(browsePath);
			const isRoot = (process.platform === "win32")
				? /^[a-zA-Z]:\\?$/.test(parent) ? true : false
				: (parent === "/");
			if (isRoot && /^[a-zA-Z]:$/.test(parent)) parent = "\\"; // Windows 盘根父层显示为 "\\"
			sendJson(res, 200, {
				ok: true, browse: true, dir: browsePath, parent, isRoot, children,
			});
		} catch (error) {
			sendJson(res, 200, { ok: false, error: errText(error) });
		}
	});

	// 优先尝试 Windows 原生文件夹选择框 (在服务端本机弹出系统标准对话框)。
	// 选中则直接返回路径; 用户取消 / 非 Windows / 执行失败返回 fallback 标志, 前端回退网页浏览。
	register(BASE + "/pickdir", async (req, res) => {
		if (req.method !== "GET") return sendJson(res, 405, { error: "use GET" });
		if (!guarded(req, res)) return;
		try {
			const initialDir = (queryParam(req, "path") || "").replace(/^\+/g, "");
			const dir = await pickNativeDir(initialDir);
			if (dir) return sendJson(res, 200, { ok: true, dir });
			sendJson(res, 200, { ok: false, error: "未选择目录或无法弹出原生选择框", fallback: true });
		} catch (error) {
			sendJson(res, 200, { ok: false, error: errText(error), fallback: true });
		}
	});

	// 视频流 (Range)。
	// 注意: 本路由【不】校验守卫头——浏览器 <video> 标签无法携带自定义请求头,
	// 一加守卫头视频就永远加载不出来 (与 dsh-sidebar-lite「img/iframe 携带不了防御头、
	// 只能 fetch→blob」同理)。因此只能靠"目录内防穿越 + 仅限已配置目录"兜底:
	// 即便外部网页用 <video>/<img> 试探, 最多读到用户自己配置目录里的文件,
	// 无法读到目录之外的内容 (/config、/list、/browse 仍保留守卫头, 目录清单与写操作不外泄)。
	register(BASE + "/stream", async (req, res) => {
		if (req.method !== "GET") return sendJson(res, 405, { error: "use GET" });
		try {
			const resolved = await resolveDir();
			if (!resolved.dir) {
				return sendJson(res, 400, { error: "未配置视频目录" });
			}
			serveStream(req, res, resolved.dir);
		} catch (error) {
			sendJson(res, 500, { error: errText(error) });
		}
	});
}

export { apply, inject, name };