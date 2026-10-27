// 独立验证脚本: dsh-lan-visibility 宿主端核心逻辑 (无需启动 dsh)。
// 覆盖:
//   1) apply 后两条管理路由已注册, 'lan' 策略已注册;
//   2) connection.admit/admitConnection 按来源分流(回环=owner, 非回环=lan);
//   3) 策略 bindings: 默认仅本机(只有 global); 共享工作区/会话后出现对应绑定;
//      会话未显式记录时跟随工作区; 显式 local 覆盖工作区共享;
//   4) 管理路由: 本机回环+自定义头可读写; 非回环 403; 切换后侧车文件落盘;
//   5) list 路由输出 visible 字段正确。
// 运行: node plugins/dsh-lan-visibility/test/verify-visibility.mjs
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let failures = 0;
function check(name, condition, detail) {
	if (condition) {
		console.log(`PASS  ${name}`);
	} else {
		failures += 1;
		console.log(`FAIL  ${name}${detail === undefined ? "" : " -> " + detail}`);
	}
}

// ---------- 环境: 临时 DSH_HOME ----------
const dshHome = mkdtempSync(join(tmpdir(), "dsh-lan-visibility-"));
process.env.DSH_HOME = dshHome;

// ---------- mock 服务 ----------
const capturedRoutes = new Map();
let capturedPolicy = null;
const mockWorkspaces = [
	{ id: "ws-1", record: { title: "Workspace One", path: "E:\\ws", sessionIds: ["session-1", "session-2"] } },
	{ id: "ws-2", record: { title: "Workspace Two", path: "E:\\ws2", sessionIds: ["session-3"] } },
];
const mockLiveSessions = [
	{ id: "session-live", header: { cwd: "E:\\ws", createdAt: 1000 } },
];

function makeOwnerPeer() {
	return { principal: { kind: "owner" }, id: "owner-peer", dispose: () => {} };
}

function makeMockConnection() {
	const ownerPeer = makeOwnerPeer();
	const createdPeers = [];
	return {
		browserPeer: ownerPeer,
		createPeer(options) {
			const peer = {
				id: "peer-" + createdPeers.length,
				principal: options.principal,
				interactions: options.interactions,
				dispose() {},
			};
			createdPeers.push(peer);
			return peer;
		},
		admit(request) {
			return { peer: ownerPeer };
		},
		admitConnection(request) {
			// 与官方实现一致: 升级准入内部先走 admit() (可能已被插件包装)。
			const admission = this.admit(request);
			return { peer: admission.peer, release: async () => {} };
		},
	};
}

function makeMockRemoteAccess() {
	return {
		registerPolicy(kind, policy) {
			capturedPolicy = policy;
			return () => {};
		},
		invalidate() {},
	};
}

function makeScope(services) {
	// 与 Cordis 注入上下文一致: 既支持 ctx.get(name), 也支持 ctx.<service> 属性访问。
	const scope = {
		get(name) {
			return services[name];
		},
		effect(callback, label) {
			const disposer = callback();
			return () => { if (typeof disposer === "function") disposer(); };
		},
	};
	for (const serviceName of Object.keys(services)) {
		scope[serviceName] = services[serviceName];
	}
	return scope;
}

function makeMockContext(services) {
	return {
		logger: { warn: () => {}, info: () => {}, error: () => {} },
		inject(dependencies, callback) {
			callback(makeScope(services));
		},
	};
}

// ---------- mock HTTP 请求/响应 ----------
function makeRequest(options) {
	const request = new EventEmitter();
	request.socket = { remoteAddress: options.remoteAddress ?? "127.0.0.1" };
	request.headers = Object.assign({}, options.headers ?? {});
	request.method = options.method ?? "GET";
	if (options.body !== undefined) {
		setImmediate(() => {
			request.emit("data", Buffer.from(options.body, "utf8"));
			request.emit("end");
		});
	}
	return request;
}

function makeResponse() {
	const response = {
		status: 0,
		body: null,
		done: null,
		writeHead(statusCode) {
			response.status = statusCode;
		},
		end(chunk) {
			response.body = chunk === undefined ? null : String(chunk);
			if (response.done !== null) response.done();
		},
	};
	response.wait = () => new Promise((resolve) => {
		if (response.body !== null) resolve(response);
		else response.done = () => resolve(response);
	});
	return response;
}

async function callRoute(path, request) {
	const route = capturedRoutes.get(path);
	if (route === undefined) throw new Error("route not registered: " + path);
	const response = makeResponse();
	route.handler(request, response);
	return await response.wait();
}

function jsonOf(response) {
	try {
		return JSON.parse(response.body);
	} catch {
		return null;
	}
}

// ---------- 加载插件 ----------
const pluginModule = await import("../lib/index.js");

const mockServices = {
	connection: makeMockConnection(),
	remoteAccess: makeMockRemoteAccess(),
	typert: {
		local: {
			list() {
				return [
					{ namespace: "session", method: "list" },
					{ namespace: "session", method: "attach" },
					{ namespace: "workspace", method: "follow" },
				];
			},
		},
	},
	sessions: { list: () => mockLiveSessions },
	workspaceRegistry: { list: () => mockWorkspaces },
	sessionQuery: {
		listSessions: async () => [
			{ header: { id: "session-cold", cwd: "E:\\cold", createdAt: 2000 } },
		],
	},
	// 标题投影 mock: 与官方 session/list 的取法一致(存活用 sessionProjections, 持久化用 sessionProjectionCache)。
	sessionProjections: {
		cachedSnapshot(session) {
			if (session !== null && session !== undefined && session.id === "session-live") {
				return { asOfSeq: 1, values: { title: "实时会话标题" } };
			}
			return undefined;
		},
		snapshot() {
			return undefined;
		},
	},
	sessionProjectionCache: {
		cachedSnapshot(meta) {
			if (meta !== null && meta !== undefined && meta.id === "session-cold") {
				return { asOfSeq: 2, values: { title: "冷会话标题" } };
			}
			return undefined;
		},
		cachedPredecessorTitle() {
			return undefined;
		},
	},
	webServer: {
		register(route) {
			capturedRoutes.set(route.path, route);
			return () => {};
		},
	},
};

const mockContext = makeMockContext(mockServices);
pluginModule.apply(mockContext);

// ---------- 1. 注册结果 ----------
check("router: list 路由已注册", capturedRoutes.has("/__dsh/lan-visibility/list"));
check("router: set 路由已注册", capturedRoutes.has("/__dsh/lan-visibility/set"));
check("policy: 'lan' 策略已注册", capturedPolicy !== null && typeof capturedPolicy.bindings === "function");

// ---------- 2. 连接分流 ----------
const ownerAdmission = mockServices.connection.admit(makeRequest({ remoteAddress: "127.0.0.1" }));
check("admit: 回环来源 = owner", ownerAdmission.peer.principal.kind === "owner");

const lanAdmission = mockServices.connection.admit(makeRequest({ remoteAddress: "192.168.1.50" }));
check("admit: 局域网来源 = lan", lanAdmission.peer.principal.kind === "lan");

const lanConnection = mockServices.connection.admitConnection(makeRequest({ remoteAddress: "192.168.1.50" }));
check("admitConnection: 局域网来源 = 独立 lan peer", lanConnection.peer.principal.kind === "lan");
check("admitConnection: release 可释放", typeof lanConnection.release === "function");

const ownerConnection = mockServices.connection.admitConnection(makeRequest({ remoteAddress: "127.0.0.1" }));
check("admitConnection: 回环来源保持 owner", ownerConnection.peer.principal.kind === "owner");

// ---------- 3. 策略 bindings(默认仅本机) ----------
const lanPrincipal = { kind: "lan" };
function resourceIds(bindings, kind) {
	return bindings
		.filter((binding) => binding.resource.kind === kind)
		.map((binding) => binding.resource.id);
}
let bindings = capturedPolicy.bindings(lanPrincipal);
check("policy: 默认只有 global 绑定", resourceIds(bindings, "session").length === 0 && resourceIds(bindings, "workspace").length === 0);
check("policy: global 绑定含 session/list", bindings[0].resource.kind === "global"
	&& bindings[0].role.actions.includes("session/list"));

// ---------- 4. 管理路由: 鉴权 ----------
const forbidden = await callRoute("/__dsh/lan-visibility/list", makeRequest({
	remoteAddress: "192.168.1.50",
	headers: { "x-dsh-lan-visibility": "1" },
}));
check("route: 非回环来源 403", forbidden.status === 403);

const noHeader = await callRoute("/__dsh/lan-visibility/list", makeRequest({ remoteAddress: "127.0.0.1" }));
check("route: 缺自定义头 403", noHeader.status === 403);

const listResponse = await callRoute("/__dsh/lan-visibility/list", makeRequest({
	remoteAddress: "127.0.0.1",
	headers: { "x-dsh-lan-visibility": "1" },
}));
const listPayload = jsonOf(listResponse);
check("route: 回环+头 200", listResponse.status === 200 && listPayload !== null);
check("list: 默认 defaultVisible=local", listPayload.defaultVisible === "local");
check("list: 工作区 2 个", Array.isArray(listPayload.workspaces) && listPayload.workspaces.length === 2);
check("list: 会话可见性初始均 false", listPayload.sessions.every((session) => session.visible === false));

// ---------- 5. 切换可见性 ----------
const setWorkspace = await callRoute("/__dsh/lan-visibility/set", makeRequest({
	remoteAddress: "127.0.0.1",
	method: "POST",
	headers: { "x-dsh-lan-visibility": "1", "content-type": "application/json" },
	body: JSON.stringify({ kind: "workspace", id: "ws-1", visible: true }),
}));
const setWorkspacePayload = jsonOf(setWorkspace);
check("set: 工作区共享成功", setWorkspace.status === 200 && setWorkspacePayload.ok === true);

bindings = capturedPolicy.bindings(lanPrincipal);
check("policy: 共享工作区后出现 workspace 绑定", resourceIds(bindings, "workspace").includes("ws-1"));
check("policy: 共享工作区后其会话跟随可见", resourceIds(bindings, "session").includes("session-1") && resourceIds(bindings, "session").includes("session-2"));
check("policy: 未共享工作区的会话仍不可见", !resourceIds(bindings, "session").includes("session-3"));

// 会话显式 local 覆盖工作区共享
await callRoute("/__dsh/lan-visibility/set", makeRequest({
	remoteAddress: "127.0.0.1",
	method: "POST",
	headers: { "x-dsh-lan-visibility": "1", "content-type": "application/json" },
	body: JSON.stringify({ kind: "session", id: "session-1", visible: false }),
}));
bindings = capturedPolicy.bindings(lanPrincipal);
check("policy: 会话显式 local 后从绑定移除", !resourceIds(bindings, "session").includes("session-1"));
check("policy: 同工作区其它会话仍可见", resourceIds(bindings, "session").includes("session-2"));

// 会话显式共享(独立于工作区)
await callRoute("/__dsh/lan-visibility/set", makeRequest({
	remoteAddress: "127.0.0.1",
	method: "POST",
	headers: { "x-dsh-lan-visibility": "1", "content-type": "application/json" },
	body: JSON.stringify({ kind: "session", id: "session-3", visible: true }),
}));
bindings = capturedPolicy.bindings(lanPrincipal);
check("policy: 会话显式共享后出现会话绑定", resourceIds(bindings, "session").includes("session-3"));
check("policy: 会话绑定动作含 session/attach", bindings
	.filter((binding) => binding.resource.kind === "session" && binding.resource.id === "session-3")
	.every((binding) => binding.role.actions.includes("session/attach")));

// ---------- 6. 侧车文件落盘 ----------
const storagePath = join(dshHome, "storages", "lan_visibility.json");
let storageText = null;
try {
	storageText = readFileSync(storagePath, "utf8");
} catch {
	storageText = null;
}
const storageState = storageText === null ? null : JSON.parse(storageText);
check("storage: 侧车文件已创建", storageState !== null);
check("storage: 工作区状态已记录", storageState !== null && storageState.workspaces["ws-1"] === "lan");
check("storage: 会话状态已记录", storageState !== null && storageState.sessions["session-1"] === "local" && storageState.sessions["session-3"] === "lan");

// ---------- 7. list 输出与状态一致 ----------
const refreshed = await callRoute("/__dsh/lan-visibility/list", makeRequest({
	remoteAddress: "127.0.0.1",
	headers: { "x-dsh-lan-visibility": "1" },
}));
const refreshedPayload = jsonOf(refreshed);
const workspaceOne = refreshedPayload.workspaces.find((workspace) => workspace.id === "ws-1");
const sessionOne = refreshedPayload.sessions.find((session) => session.id === "session-1");
const sessionThree = refreshedPayload.sessions.find((session) => session.id === "session-3");
check("list: 工作区 ws-1 visible=true", workspaceOne !== undefined && workspaceOne.visible === true);
check("list: 会话 session-1 visible=false(显式 local)", sessionOne !== undefined && sessionOne.visible === false);
check("list: 会话 session-3 visible=true", sessionThree !== undefined && sessionThree.visible === true);
check("list: 存活会话出现在列表中", refreshedPayload.sessions.some((session) => session.id === "session-live"));

// ---------- 8. 标题提取(与左侧会话栏标题一致) ----------
const liveRow = refreshedPayload.sessions.find((session) => session.id === "session-live");
const coldRow = refreshedPayload.sessions.find((session) => session.id === "session-cold");
check("title: 存活会话标题来自 title 投影", liveRow !== undefined && liveRow.title === "实时会话标题");
check("title: 持久化会话标题来自投影缓存", coldRow !== undefined && coldRow.title === "冷会话标题");
check("title: 无标题会话回退为空串", refreshedPayload.sessions
	.filter((session) => session.id !== "session-live" && session.id !== "session-cold")
	.every((session) => session.title === ""));

// ---------- 清理 ----------
try {
	rmSync(dshHome, { recursive: true, force: true });
} catch {
	// 忽略清理失败
}

if (failures > 0) {
	console.log(`\n${failures} 项失败`);
	process.exitCode = 1;
} else {
	console.log("\n全部通过 (100%)");
}
