// DeepSeek Harness 插件 (宿主端): dsh-lan-visibility
// 需求: 局域网模式(dsh_host=0.0.0.0)下, 给每个工作区/对话设置可见性:
//   默认「仅本机可见」; 可在设置页切换为「局域网可见」。
// 机制:
//   1) 运行时包装 connection.admit / connection.admitConnection:
//      非回环来源(局域网设备)一律以 principal.kind='lan' 的 Peer 接入,
//      回环来源(127.0.0.1 / ::1, 即本机打开)保持原 owner 浏览器 Peer 不变。
//   2) 通过 remote-access 服务注册 'lan' 策略: 只放行「局域网可见」的会话/工作区资源。
//      官方会话列表/搜索/事件流/工作区流本就用 remoteAccess.allows() 过滤, 自动生效;
//      /api/file 等精确 Fetch 路由对非 owner 直接 403, 天然挡住。
//   3) 侧车文件 $DSH_HOME/storages/lan_visibility.json 记录可见性状态;
//      管理路由(仅本机回环可调用)供设置页卡片读写。
// 不修改任何官方文件; 插件卸载时恢复原方法。
//
// 默认可见性: 仅本机可见(用户决策 2026-10-27)。已共享的会话/工作区,
// 局域网用户拥有「可看可管理」权限(会话/工作区资源上的全部动作放行)。
//
// 注意事项:
// - 「本机」= TCP 来源为回环地址。从本机浏览器用局域网 IP(如 192.168.x.x) 打开
//   会被判为局域网来源, 这是有意的语义(内部研究文档: doc/RESEARCH-lan-visibility.md, 不进仓库)。
// - 调试: 设置环境变量 DSH_LAN_VISIBILITY_SIMULATE_LAN=1 后, 请求带
//   x-dsh-simulate-lan: 1 头即模拟局域网来源, 便于本机 curl 验证权限。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, networkInterfaces } from "node:os";

const name = "dsh-lan-visibility";
// 不强制声明硬依赖: 各服务工作区/连接/网关在运行时按需注入, 缺失时插件仍可加载
// (非 web 环境里本插件只是空转, 不会阻塞启动)。
const inject = [];

const ROUTE_LIST = "/__dsh/lan-visibility/list";
const ROUTE_SET = "/__dsh/lan-visibility/set";
// 局域网地址探测: 返回绑定地址/端口与网卡 IP, 供设置页「复制一键打开链接」使用。
const ROUTE_NETWORK = "/__dsh/lan-visibility/network";
const GUARD_HEADER = "x-dsh-lan-visibility";
const STORAGE_FILE_NAME = "lan_visibility.json";
const STORAGE_VERSION = 1;
const MAX_BODY_BYTES = 64 * 1024;

// 回环地址集合: 本机打开(桌面壳 / 127.0.0.1 / localhost)的判定依据。
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// 资源 kind='global' 放行的动作白名单:
//   只给局域网用户必要的数据入口(会话列表/搜索/模型目录/工作区列表流)。
//   其它全局动作(创建会话/改设置/终端/文件/目录选择/凭据等)一律拒绝,
//   避免局域网用户触达与「会话/工作区可见性」无关的宿主能力。
const GLOBAL_ALLOWED_ACTIONS = [
	"session/list",
	"session/search",
	"session/modelCatalog",
	"workspace/follow",
];

// 兜底动作表: typert 服务不可用或版本变化时使用; 正常路径从 typert 动态枚举。
const FALLBACK_SESSION_ACTIONS = [
	"resolveAgent",
	"inspect",
	"list",
	"search",
	"create",
	"selectModel",
	"initializeDefaultModel",
	"modelCatalog",
	"canOpenWorkspacePath",
	"workspaceDesktop",
	"openWorkspacePath",
	"workspacePathApplications",
	"rename",
	"fork",
	"prompt",
	"attachment",
	"updateQueue",
	"cancel",
	"page",
	"follow",
	"projections",
	"control",
].map((methodName) => `session/${methodName}`);

const FALLBACK_WORKSPACE_ACTIONS = [
	"create",
	"initializeDefault",
	"rename",
	"delete",
	"insertBefore",
	"insertSessionBefore",
	"archiveSession",
	"unarchiveSession",
	"pinSession",
	"unpinSession",
	"follow",
].map((methodName) => `workspace/${methodName}`);

// 可见性状态(内存缓存): 会话/工作区 id -> "lan"(局域网可见) | "local"(仅本机可见)。
// 未记录的项按默认(仅本机可见)处理; 会话未显式记录时跟随其所属工作区的记录。
let visibilityState = {
	version: STORAGE_VERSION,
	sessions: {},
	workspaces: {},
};
let stateFilePath = null;
// 由 installLanPeerSplit 注入; 管理路由改可见性后用它通知 remote-access 刷新快照。
let invalidateLanAccess = () => {};

function resolveDshHome() {
	return process.env.DSH_HOME || join(homedir(), ".dsh");
}

/** 从侧车文件加载可见性状态; 文件缺失/损坏时保持默认(全部仅本机可见)。 */
function loadVisibilityState() {
	stateFilePath = join(resolveDshHome(), "storages", STORAGE_FILE_NAME);
	try {
		const text = readFileSync(stateFilePath, "utf8");
		const parsed = JSON.parse(text);
		if (parsed !== null && typeof parsed === "object" && parsed.version === STORAGE_VERSION
			&& parsed.sessions !== null && typeof parsed.sessions === "object"
			&& parsed.workspaces !== null && typeof parsed.workspaces === "object") {
			visibilityState = {
				version: STORAGE_VERSION,
				sessions: parsed.sessions,
				workspaces: parsed.workspaces,
			};
		}
	} catch {
		// 文件不存在或损坏: 保持默认状态(全部仅本机可见), 首次切换时会自动创建
	}
}

/** 原子写回侧车文件(同目录临时文件 + 替换, 与项目 storages 落盘习惯一致)。 */
function saveVisibilityState() {
	if (stateFilePath === null) {
		loadVisibilityState();
	}
	try {
		mkdirSync(dirname(stateFilePath), { recursive: true });
		const temporaryPath = stateFilePath + ".tmp";
		writeFileSync(temporaryPath, JSON.stringify(visibilityState, null, 2), "utf8");
		renameSync(temporaryPath, stateFilePath);
		return true;
	} catch {
		return false;
	}
}

/** 取原始请求的 TCP 来源地址(局域网判定依据)。 */
function requestRemoteAddress(request) {
	if (request !== null && typeof request === "object" && request.socket !== null
		&& typeof request.socket === "object" && typeof request.socket.remoteAddress === "string") {
		return request.socket.remoteAddress;
	}
	return "";
}

/** 是否回环来源(本机打开)。无 socket 信息时按本机处理(保守, 保持现状)。 */
function isLoopbackRequest(request) {
	// 测试开关: 仅显式设置环境变量后生效, 便于本机 curl 模拟局域网来源。
	if (process.env.DSH_LAN_VISIBILITY_SIMULATE_LAN === "1"
		&& request !== null && typeof request === "object"
		&& request.headers !== null && typeof request.headers === "object"
		&& request.headers["x-dsh-simulate-lan"] === "1") {
		return false;
	}
	const address = requestRemoteAddress(request);
	if (address === "") {
		return true;
	}
	return LOOPBACK_ADDRESSES.has(address);
}

/** 工作区是否对局域网可见。 */
function isWorkspaceShared(workspaceId) {
	return visibilityState.workspaces[workspaceId] === "lan";
}

/** 会话是否对局域网可见: 显式记录优先, 未记录时跟随所属工作区, 否则默认仅本机。 */
function isSessionShared(sessionId, sessionWorkspaceMap) {
	const explicit = visibilityState.sessions[sessionId];
	if (explicit === "lan") {
		return true;
	}
	if (explicit === "local") {
		return false;
	}
	const workspaceId = sessionWorkspaceMap.get(sessionId);
	return workspaceId !== undefined && isWorkspaceShared(workspaceId);
}

/**
 * 从 typert 注册表枚举会话/工作区命名空间的方法动作。
 * 版本兼容: 动作串按 `${namespace}/${method}` 生成, 与网关 decide() 的 action 一致。
 */
function buildActionSuperset(typert) {
	const sessionActions = new Set(FALLBACK_SESSION_ACTIONS);
	const workspaceActions = new Set(FALLBACK_WORKSPACE_ACTIONS);
	try {
		if (typert !== null && typeof typert === "object" && typert.local !== null
			&& typeof typert.local === "object" && typeof typert.local.list === "function") {
			for (const descriptor of typert.local.list()) {
				if (descriptor === null || typeof descriptor !== "object") {
					continue;
				}
				const namespace = descriptor.namespace;
				const methodName = typeof descriptor.method === "string" ? descriptor.method : descriptor.exportName;
				if (typeof namespace !== "string" || typeof methodName !== "string") {
					continue;
				}
				const action = `${namespace}/${methodName}`;
				if (namespace === "session") {
					sessionActions.add(action);
				} else if (namespace === "workspace") {
					workspaceActions.add(action);
				}
			}
		}
	} catch {
		// 动态枚举失败: 使用兜底动作表
	}
	return { sessionActions: [...sessionActions], workspaceActions: [...workspaceActions] };
}

/**
 * 收集当前可见性判定所需的资源:
 * 工作区实体、会话 -> 工作区映射、全部已知会话 id(存活 + 工作区记录 + 显式记录)。
 * 全部为同步读取, 供策略的同步 bindings() 使用。
 */
function collectVisibilityResources(scopeContext) {
	const sessionsService = scopeContext.get("sessions");
	const workspaceRegistry = scopeContext.get("workspaceRegistry");
	const liveSessions = sessionsService !== undefined && typeof sessionsService.list === "function"
		? sessionsService.list()
		: [];
	const workspaceEntities = workspaceRegistry !== undefined && typeof workspaceRegistry.list === "function"
		? workspaceRegistry.list()
		: [];
	const sessionWorkspaceMap = new Map();
	const sessionIds = new Set();
	for (const entity of workspaceEntities) {
		if (entity === null || typeof entity !== "object" || entity.record === null || typeof entity.record !== "object") {
			continue;
		}
		const workspaceSessionIds = Array.isArray(entity.record.sessionIds) ? entity.record.sessionIds : [];
		for (const sessionId of workspaceSessionIds) {
			if (typeof sessionId !== "string") {
				continue;
			}
			if (!sessionWorkspaceMap.has(sessionId)) {
				sessionWorkspaceMap.set(sessionId, entity.id);
			}
			sessionIds.add(sessionId);
		}
	}
	for (const session of liveSessions) {
		if (session !== null && typeof session === "object" && typeof session.id === "string") {
			sessionIds.add(session.id);
		}
	}
	for (const sessionId of Object.keys(visibilityState.sessions)) {
		sessionIds.add(sessionId);
	}
	return { workspaceEntities, sessionWorkspaceMap, sessionIds };
}

/**
 * 构造 'lan' 访问策略:
 * - global 资源: 只放行 GLOBAL_ALLOWED_ACTIONS(列表/搜索/模型目录/工作区流);
 * - 已被共享的工作区: 放行 workspace 命名空间的全部动作(可看可管理);
 * - 已被共享(或所属工作区已共享)的会话: 放行 session + workspace 命名空间动作
 *   (会话绑定同时包含 workspace/follow 动作, 供 workspace/follow 内部 allows() 过滤使用)。
 * 未共享的资源没有任何绑定 -> decide()/allows() 一律拒绝。
 */
function createLanPolicy(scopeContext) {
	const actionSuperset = buildActionSuperset(scopeContext.get("typert"));
	const sessionRoleActions = [...new Set([
		...actionSuperset.sessionActions,
		...actionSuperset.workspaceActions,
		...GLOBAL_ALLOWED_ACTIONS,
	])];
	const workspaceRoleActions = [...new Set([
		...actionSuperset.workspaceActions,
		...GLOBAL_ALLOWED_ACTIONS,
	])];
	return {
		bindings(principal) {
			const bindings = [
				{ resource: { kind: "global" }, role: { actions: GLOBAL_ALLOWED_ACTIONS } },
			];
			const { workspaceEntities, sessionWorkspaceMap, sessionIds } = collectVisibilityResources(scopeContext);
			for (const entity of workspaceEntities) {
				if (entity === null || typeof entity !== "object" || typeof entity.id !== "string") {
					continue;
				}
				if (isWorkspaceShared(entity.id)) {
					bindings.push({
						resource: { kind: "workspace", id: entity.id },
						role: { actions: workspaceRoleActions },
					});
				}
			}
			for (const sessionId of sessionIds) {
				if (isSessionShared(sessionId, sessionWorkspaceMap)) {
					bindings.push({
						resource: { kind: "session", id: sessionId },
						role: { actions: sessionRoleActions },
					});
				}
			}
			return bindings;
		},
	};
}

/**
 * 安装连接层分流 + 'lan' 策略注册:
 * - connection.admit: 认证通过后, 非回环来源改发共享 lan Peer(POST /api 等无连接态请求);
 * - connection.admitConnection: WS 升级通过后, 非回环来源改发"每连接一个" lan Peer,
 *   并在 socket 关闭时由网关调用 release() 释放(避免 Peer 泄漏);
 * - 回环来源(本机)保持官方 owner 浏览器 Peer, 行为与今天完全一致。
 */
function installLanPeerSplit(scopeContext) {
	const connection = scopeContext.get("connection");
	const remoteAccess = scopeContext.get("remoteAccess");
	if (connection === undefined || remoteAccess === undefined) {
		return;
	}
	loadVisibilityState();
	const sharedLanPeer = connection.createPeer({
		principal: { kind: "lan" },
		interactions: "answer",
	});
	const originalAdmit = connection.admit;
	const originalAdmitConnection = connection.admitConnection;

	connection.admit = function admitWithLanSplit(request) {
		const admission = originalAdmit.call(connection, request);
		if (admission === undefined || admission === null || "rejection" in admission) {
			return admission;
		}
		if (!isLoopbackRequest(request)) {
			return { peer: sharedLanPeer };
		}
		return admission;
	};

	connection.admitConnection = function admitConnectionWithLanSplit(request) {
		const admission = originalAdmitConnection.call(connection, request);
		if (admission === undefined || admission === null || "rejection" in admission) {
			return admission;
		}
		if (admission.peer !== undefined && admission.peer !== null
			&& admission.peer.principal !== undefined && admission.peer.principal !== null
			&& admission.peer.principal.kind === "lan") {
			// 每个 WebSocket 连接独占一个 lan Peer: 连接关闭时释放, 不留泄漏
			const connectionPeer = connection.createPeer({
				principal: { kind: "lan" },
				interactions: "answer",
			});
			return { peer: connectionPeer, release: () => connectionPeer.dispose() };
		}
		return admission;
	};

	const disposePolicy = remoteAccess.registerPolicy("lan", createLanPolicy(scopeContext));
	invalidateLanAccess = () => {
		try {
			remoteAccess.invalidate();
		} catch {
			// 快照刷新失败不影响策略本身
		}
	};
	scopeContext.effect(() => () => {
		connection.admit = originalAdmit;
		connection.admitConnection = originalAdmitConnection;
		disposePolicy();
		try {
			void sharedLanPeer.dispose();
		} catch {
			// 已释放则忽略
		}
	}, "dsh-lan-visibility: restore connection admission");
}

/** 路由守卫: 必须带自定义头(防跨站)且来自本机回环(仅所有者可读写可见性设置)。 */
function isOwnerRouteRequest(request) {
	if (request === null || typeof request !== "object" || request.headers === null
		|| typeof request.headers !== "object" || request.headers[GUARD_HEADER] !== "1") {
		return false;
	}
	return isLoopbackRequest(request);
}

function writeJson(response, statusCode, payload) {
	response.writeHead(statusCode, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	response.end(JSON.stringify(payload));
}

function writeText(response, statusCode, text) {
	response.writeHead(statusCode, {
		"content-type": "text/plain; charset=utf-8",
		"cache-control": "no-store",
	});
	response.end(text);
}

/** 读取 JSON 请求体(带大小上限)。 */
function readJsonBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let totalBytes = 0;
		request.on("data", (chunk) => {
			totalBytes += chunk.length;
			if (totalBytes > MAX_BODY_BYTES) {
				reject(new Error("request body too large"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch (error) {
				reject(error);
			}
		});
		request.on("error", reject);
	});
}

/**
 * 读取一个会话的标题(与官方 session/list 的取法一致):
 * - 存活会话: sessionProjections.cachedSnapshot(session) 的 title 投影; 未物化时再用 snapshot 折叠兜底;
 * - 持久化会话: sessionProjectionCache.cachedSnapshot(header) / cachedPredecessorTitle(header)。
 * 取不到标题(如全新空会话)返回空串, 由前端回退显示短 id。
 */
function readSessionTitle(scopeContext, session, header) {
	try {
		const sessionProjections = scopeContext.get("sessionProjections");
		if (session !== undefined && sessionProjections !== undefined
			&& typeof sessionProjections.cachedSnapshot === "function") {
			const cached = sessionProjections.cachedSnapshot(session);
			if (cached !== undefined && cached.values !== undefined
				&& typeof cached.values.title === "string" && cached.values.title !== "") {
				return cached.values.title;
			}
			if (typeof sessionProjections.snapshot === "function") {
				const folded = sessionProjections.snapshot(session, ["title"]);
				if (folded !== undefined && folded.values !== undefined
					&& typeof folded.values.title === "string" && folded.values.title !== "") {
					return folded.values.title;
				}
			}
		}
		const projectionCache = scopeContext.get("sessionProjectionCache");
		if (projectionCache !== undefined && typeof projectionCache.cachedSnapshot === "function") {
			const cached = projectionCache.cachedSnapshot(header);
			if (cached !== undefined && cached.values !== undefined
				&& typeof cached.values.title === "string" && cached.values.title !== "") {
				return cached.values.title;
			}
			if (typeof projectionCache.cachedPredecessorTitle === "function") {
				const predecessor = projectionCache.cachedPredecessorTitle(header);
				if (predecessor !== undefined && predecessor.values !== undefined
					&& typeof predecessor.values.title === "string" && predecessor.values.title !== "") {
					return predecessor.values.title;
				}
			}
		}
	} catch {
		// 标题读取失败只影响展示, 不影响可见性功能
	}
	return "";
}

/** 组装设置页列表数据: 工作区/会话清单 + 可见性 + 默认值。 */
async function buildListPayload(scopeContext) {
	const workspaceRegistry = scopeContext.get("workspaceRegistry");
	const sessionsService = scopeContext.get("sessions");
	const sessionQuery = scopeContext.get("sessionQuery");
	const workspaceEntities = workspaceRegistry !== undefined && typeof workspaceRegistry.list === "function"
		? workspaceRegistry.list()
		: [];
	const workspaceById = new Map();
	const sessionWorkspaceMap = new Map();
	const workspaces = [];
	for (const entity of workspaceEntities) {
		if (entity === null || typeof entity !== "object" || typeof entity.id !== "string") {
			continue;
		}
		const record = entity.record !== null && typeof entity.record === "object" ? entity.record : {};
		const workspaceSessionIds = Array.isArray(record.sessionIds) ? record.sessionIds : [];
		workspaceById.set(entity.id, record.title !== undefined ? record.title : String(entity.id));
		for (const sessionId of workspaceSessionIds) {
			if (!sessionWorkspaceMap.has(sessionId)) {
				sessionWorkspaceMap.set(sessionId, entity.id);
			}
		}
		workspaces.push({
			id: entity.id,
			title: record.title !== undefined ? String(record.title) : "",
			path: record.path !== undefined ? String(record.path) : "",
			sessionCount: workspaceSessionIds.length,
			visible: isWorkspaceShared(entity.id),
		});
	}

	// 会话清单: 存活会话 + 持久化(冷)会话, 按最后活动时间倒序。
	const sessionMap = new Map();
	const liveSessions = sessionsService !== undefined && typeof sessionsService.list === "function"
		? sessionsService.list()
		: [];
	for (const session of liveSessions) {
		if (session === null || typeof session !== "object" || typeof session.id !== "string") {
			continue;
		}
		const header = session.header !== null && typeof session.header === "object" ? session.header : {};
		sessionMap.set(session.id, {
			id: session.id,
			title: readSessionTitle(scopeContext, session, header),
			cwd: header.cwd !== undefined ? String(header.cwd) : "",
			updatedAt: typeof header.updatedAt === "number" ? header.updatedAt : (typeof header.createdAt === "number" ? header.createdAt : 0),
		});
	}
	if (sessionQuery !== undefined && typeof sessionQuery.listSessions === "function") {
		try {
			const records = await sessionQuery.listSessions(undefined);
			for (const record of records) {
				if (record === null || typeof record !== "object" || record.header === null || typeof record.header !== "object") {
					continue;
				}
				const header = record.header;
				if (typeof header.id !== "string" || sessionMap.has(header.id)) {
					continue;
				}
				sessionMap.set(header.id, {
					id: header.id,
					title: readSessionTitle(scopeContext, undefined, header),
					cwd: header.cwd !== undefined ? String(header.cwd) : "",
					updatedAt: typeof header.updatedAt === "number" ? header.updatedAt : (typeof header.createdAt === "number" ? header.createdAt : 0),
				});
			}
		} catch {
			// 查询索引不可用时仅展示存活会话
		}
	}
	// 工作区记录里登记过、但当前既非存活也未被查询索引列出的会话(如已归档)也要可勾选。
	for (const sessionId of sessionWorkspaceMap.keys()) {
		if (!sessionMap.has(sessionId)) {
			sessionMap.set(sessionId, { id: sessionId, title: "", cwd: "", updatedAt: 0 });
		}
	}
	const sessions = [...sessionMap.values()]
		.sort((left, right) => right.updatedAt - left.updatedAt)
		.map((session) => ({
			id: session.id,
			title: session.title !== undefined ? session.title : "",
			cwd: session.cwd,
			updatedAt: session.updatedAt,
			workspaceId: sessionWorkspaceMap.get(session.id) !== undefined ? sessionWorkspaceMap.get(session.id) : null,
			workspaceTitle: sessionWorkspaceMap.get(session.id) !== undefined
				? (workspaceById.get(sessionWorkspaceMap.get(session.id)) || "")
				: "",
			visible: isSessionShared(session.id, sessionWorkspaceMap),
		}));
	return {
		defaultVisible: "local",
		workspaces,
		sessions,
	};
}

/** 处理可见性切换: 校验参数 -> 写内存 -> 原子落盘 -> 通知 remote-access 刷新。 */
async function handleVisibilitySet(request, response) {
	if (request.method !== "POST") {
		writeText(response, 405, "method not allowed");
		return;
	}
	let body;
	try {
		body = await readJsonBody(request);
	} catch {
		writeText(response, 400, "invalid json body");
		return;
	}
	const kind = body !== null && typeof body === "object" ? body.kind : undefined;
	const id = body !== null && typeof body === "object" ? body.id : undefined;
	const visible = body !== null && typeof body === "object" ? body.visible : undefined;
	if ((kind !== "session" && kind !== "workspace") || typeof id !== "string" || id.length === 0 || typeof visible !== "boolean") {
		writeText(response, 400, "invalid arguments: {kind:'session'|'workspace', id:string, visible:boolean}");
		return;
	}
	const target = kind === "session" ? visibilityState.sessions : visibilityState.workspaces;
	target[id] = visible ? "lan" : "local";
	if (!saveVisibilityState()) {
		writeText(response, 500, "failed to persist visibility state");
		return;
	}
	invalidateLanAccess();
	writeJson(response, 200, { ok: true, kind, id, visible });
}

/**
 * 收集本机局域网访问信息(仅本机回环路由返回, 供设置页展示/复制一键打开链接):
 * - bindHost/port/protocol 来自 webServer 服务(实际监听值与绑定地址);
 * - 网卡 IPv4 地址来自 os.networkInterfaces()(只取非回环);
 * - launchToken 来自 connection.browserAuth(认证开启时局域网设备需要它换 30 天 Cookie;
 *   取不到就退回裸地址, 认证关闭时裸地址本来就能直接打开)。
 */
function collectNetworkAccess(scopeContext) {
	const webServer = scopeContext.get("webServer");
	const bindHost = webServer !== undefined && typeof webServer.host === "string" ? webServer.host : "";
	const protocol = webServer !== undefined && typeof webServer.protocol === "string" ? webServer.protocol : "http:";
	const port = webServer !== undefined && webServer.port !== undefined && webServer.port !== null
		? String(webServer.port)
		: "";
	const lanMode = bindHost === "0.0.0.0" || bindHost === "::";
	const addresses = [];
	try {
		const interfaces = networkInterfaces();
		for (const interfaceName of Object.keys(interfaces)) {
			const entries = interfaces[interfaceName];
			if (!Array.isArray(entries)) continue;
			for (const entry of entries) {
				if (entry === null || typeof entry !== "object") continue;
				const isIPv4 = entry.family === "IPv4" || entry.family === 4;
				if (!isIPv4 || entry.internal !== false) continue;
				if (typeof entry.address !== "string" || entry.address === "") continue;
				if (addresses.includes(entry.address)) continue;
				addresses.push(entry.address);
			}
		}
	} catch {
		// 网卡信息读取失败只影响展示
	}
	let launchToken = "";
	try {
		const connection = scopeContext.get("connection");
		if (connection !== undefined && connection !== null && connection.browserAuth !== undefined
			&& connection.browserAuth !== null && typeof connection.browserAuth.launchToken === "string") {
			launchToken = connection.browserAuth.launchToken;
		}
	} catch {
		// 取不到 token 时退回裸地址
	}
	const urls = [];
	for (const address of addresses) {
		const origin = protocol + "//" + address + (port === "" ? "" : ":" + port);
		urls.push({
			address,
			origin,
			url: launchToken === "" ? origin + "/" : origin + "/?token=" + encodeURIComponent(launchToken),
		});
	}
	return { lanMode, bindHost, protocol, port, tokenIncluded: launchToken !== "", addresses, urls };
}

/** 注册管理路由(列表 / 切换), 仅本机回环 + 自定义头可调用。 */
function installRoutes(scopeContext) {
	scopeContext.effect(() => scopeContext.webServer.register({
		kind: "exact",
		path: ROUTE_LIST,
		handler: async (request, response) => {
			if (!isOwnerRouteRequest(request)) {
				writeText(response, 403, "forbidden");
				return;
			}
			try {
				writeJson(response, 200, await buildListPayload(scopeContext));
			} catch (error) {
				writeText(response, 500, String(error !== null && error !== undefined && error.message !== undefined ? error.message : error));
			}
		},
	}), "dsh-lan-visibility: list route");

	scopeContext.effect(() => scopeContext.webServer.register({
		kind: "exact",
		path: ROUTE_SET,
		handler: async (request, response) => {
			if (!isOwnerRouteRequest(request)) {
				writeText(response, 403, "forbidden");
				return;
			}
			try {
				await handleVisibilitySet(request, response);
			} catch (error) {
				writeText(response, 500, String(error !== null && error !== undefined && error.message !== undefined ? error.message : error));
			}
		},
	}), "dsh-lan-visibility: set route");

	// 局域网地址探测: 供设置页展示「复制一键打开链接」。
	scopeContext.effect(() => scopeContext.webServer.register({
		kind: "exact",
		path: ROUTE_NETWORK,
		handler: async (request, response) => {
			if (!isOwnerRouteRequest(request)) {
				writeText(response, 403, "forbidden");
				return;
			}
			try {
				writeJson(response, 200, collectNetworkAccess(scopeContext));
			} catch (error) {
				writeText(response, 500, String(error !== null && error !== undefined && error.message !== undefined ? error.message : error));
			}
		},
	}), "dsh-lan-visibility: network route");
}

export function apply(ctx) {
	// 可见性状态在激活时同步加载一次(侧车文件很小, 同步读取避免策略读到半空状态)。
	loadVisibilityState();

	// 连接层分流 + 访问策略(需要 connection / remoteAccess / typert 服务)。
	ctx.inject(["connection", "remoteAccess", "typert"], (scopeContext) => {
		try {
			installLanPeerSplit(scopeContext);
		} catch (error) {
			ctx.logger.warn(`dsh-lan-visibility: 连接层分流安装失败: ${String(error)}`);
		}
	});

	// 管理路由(需要 webServer 服务; 非 web 环境自动跳过)。
	ctx.inject(["webServer"], (scopeContext) => {
		try {
			installRoutes(scopeContext);
		} catch (error) {
			ctx.logger.warn(`dsh-lan-visibility: 管理路由注册失败: ${String(error)}`);
		}
	});
}

export { inject, name };
