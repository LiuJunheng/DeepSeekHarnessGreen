/**
 * dsh-memory —— 祖宗记忆库记忆插件
 *
 * 核心模块:
 *   - bridge  (MCP stdio 桥)  : 管理 zuzong_memory.py Python 子进程生命周期
 *   - hooks   (自动记忆 + autoRecall) : 会话事件钩子, 对用户消息脱敏后写入记忆库,
 *                                       system-prompt 组装时自动注入最近记忆
 *   - tools   (工具注册)       : 动态拉取 bridge 工具清单, 注册到 Cordis 工具系统
 *   - routes  (host 路由)      : /__dsh/memory/* 记忆库管理卡片后端 + config 读写
 *
 * 用法 (cordis.yml):
 *   - id: dsh-memory
 *     name: dsh-memory
 *     config:                        # 全部可选, 以下为绿色版默认值
 *       enabled: false              # v3: 总开关, 默认关闭 (WebUI 里可开)
 *       dbPath: '${DSH_HOME}/memory/zuzong.db'
 *       identity: '祖宗记忆库'
 *       tools: ['remember','recall','search','timeline','service_info','list_all','delete']
 *       memory: { userMessage: true, autoRecall: true, desensitize: true }
 *
 * v3 设计: 总开关 enabled (默认 false) 控制自动记忆/autoRecall 钩子是否安装;
 *   bridge/tool/路由始终注册 (用户可手动调用 remember/recall 工具或 WebUI 管理卡片)。
 *   WebUI 改开关 → 写 json 持久化文件 → 下次启动生效。
 */
import z from '@deepseek-ai/schemastery';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import zlib from 'node:zlib';
import { ZuzongBridge } from './bridge.js';
import { registerZuzongTools } from './tools.js';
import { installMemoryHooks } from './hooks.js';

export const name = 'dsh-memory';

/** 本插件依赖的服务: webServer (管理卡片用, 缺失时跳过路由注册)。 */
export const inject = ['webServer'];

/**
 * 探测插件运行位置 + 绿色版便携 Python + 自研引擎文件。
 *
 * 插件可能装在两个位置:
 *   A) 开发态: <greenRoot>/plugins/dsh-memory/lib/index.js
 *      向上 3 层 = greenRoot
 *   B) 运行态: <greenRoot>/runtime/dsh-home/profiles/<name>/node_modules/dsh-memory/lib/index.js
 *      向上 7 层 = greenRoot
 *
 * 本函数逐层向上回溯寻找 runtime/python/python/python.exe 来确定 greenRoot,
 * 同时返回 plugin 根目录 (含 engine/ 子目录)。找不到就返回 null, 让调用方回退。
 */
function _detectGreenRuntime() {
    try {
        const thisFile = fileURLToPath(import.meta.url);
        const pluginDir = dirname(dirname(thisFile));  // lib → dsh-memory (或 node_modules/dsh-memory)
        const enginePath = join(pluginDir, 'engine', 'zuzong_memory.py');

        // 从 pluginDir 开始, 向上最多 10 层逐层寻找 runtime/python/python/python.exe
        let cursor = pluginDir;
        const maxUp = 10;
        for (let i = 0; i < maxUp; i++) {
            const candidate = join(cursor, 'runtime', 'python', 'python', 'python.exe');
            if (existsSync(candidate)) {
                return {
                    greenRoot: cursor,
                    portablePy: candidate,
                    enginePath: existsSync(enginePath) ? enginePath : null,
                };
            }
            const parent = dirname(cursor);
            if (parent === cursor) break;  // 到达文件系统根
            cursor = parent;
        }
        // 没找到 greenRoot, 但 pluginDir 和 enginePath 还是有参考价值
        return {
            greenRoot: null,
            portablePy: null,
            enginePath: existsSync(enginePath) ? enginePath : null,
        };
    } catch (_e) {
        return { greenRoot: null, portablePy: null, enginePath: null };
    }
}

/** DSH_HOME: 绿色版进程会设 DSH_HOME=runtime/dsh-home, 回退 ~/.dsh。 */
function _dshHome() {
    return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 精简版配置 (v4: enabled 拆成 autoRemember + autoRecall 两个独立开关, 均默认 false)。 */
export const Config = z.object({
    serverName: z.string().default('zuzong'),
    python: z.string().default(''),          // 空字符串 = 自动探测绿色版便携 Python
    moduleArgs: z.array(String).default([]),  // 空数组 = 自动探测自研引擎
    dbPath: z.string().default(''),           // 空字符串 = 自动用 ${DSH_HOME}/memory/zuzong.db
    identity: z.string().default('祖宗记忆库'),
    env: z.dict(String).default({}),
    // 绿色版默认只暴露自研引擎支持的 7 个工具
    tools: z.union([
        z.const('core'),
        z.const('all'),
        z.array(String),
    ]).default(['remember', 'recall', 'search', 'timeline', 'service_info', 'list_all', 'delete']),
    memory: z.object({
        /** v4: 自动记录开关 —— 是否把对话事件 (user/assistant/tool) 写入记忆库, 默认 false。 */
        autoRemember: z.boolean().default(false),
        /** v4: 自动召回开关 —— 是否把记忆注入 system prompt, 默认 false。 */
        autoRecall: z.boolean().default(false),
        /** v3.1: 跨会话加载开关 —— false=只读当前会话记忆, true=全局记忆也加载, 默认 false。 */
        crossSessionRecall: z.boolean().default(false),
        userMessage: z.boolean().default(true),
        assistantMessage: z.boolean().default(true),
        toolResult: z.boolean().default(false),
        importance: z.number().default(0.6),
        autoRecallLimit: z.number().default(6),
        desensitize: z.boolean().default(true),
        useSummarize: z.boolean().default(true),
    }).default({
        autoRemember: false, autoRecall: false, crossSessionRecall: false,
        userMessage: true, assistantMessage: true, toolResult: false,
        importance: 0.6, autoRecallLimit: 6, desensitize: true,
        useSummarize: true,
    }),
    toolCallTimeoutMs: z.number().default(60_000),
    maxRetryDelayMs: z.number().default(30_000),
    failOnStartupError: z.boolean().default(false),
});

/** Config 持久化 json 文件路径: ${DSH_HOME}/memory/memory-config.json。 */
function _persistPath() {
    return join(_dshHome(), 'memory', 'memory-config.json');
}

/**
 * 读取持久化 json 覆盖 (WebUI 开关写进来的)。
 * 文件不存在或损坏 → 返回空对象 (保持 cordis config 原样)。
 */
function _loadPersist() {
    const p = _persistPath();
    if (!existsSync(p)) return {};
    try {
        const raw = readFileSync(p, 'utf-8');
        return JSON.parse(raw) || {};
    } catch {
        return {};
    }
}

/** 把 WebUI 覆盖项写回 json (宿主路由 POST 调用)。 */
function _savePersist(patch) {
    const persist = _persistPath();
    const dir = dirname(persist);
    if (!existsSync(dir)) {
        try { mkdirSync(dir, { recursive: true }); } catch { /* 静默 */ }
    }
    const existing = _loadPersist();
    const merged = { ...existing, ...patch };
    writeFileSync(persist, JSON.stringify(merged, null, 2), 'utf-8');
    return merged;
}

/**
 * 把精简 Config 重新组装成 bridge 需要的完整字段 (ZuzongBridge 要求 python/args/dbPath 非空)。
 * 绿色版的默认值:
 *   python   → 探测 runtime/python/python/python.exe, 回退 PATH 里的 python
 *   args     → ['<pluginDir>/engine/zuzong_memory.py']
 *   dbPath   → ${DSH_HOME}/memory/zuzong.db
 */
function _resolveEffectiveConfig(rawConfig) {
    const detected = _detectGreenRuntime();
    const effective = { ...rawConfig };

    // --- python ---
    if (!effective.python) {
        if (detected.portablePy) {
            try {
                // 仅用 Test-Path 等价逻辑: import.meta.url 解析到的路径不做 fs.existsSync,
                // 桥接层 spawn 失败时会重试并有清晰日志
                effective.python = detected.portablePy;
            } catch {
                effective.python = process.platform === 'win32' ? 'python' : 'python3';
            }
        } else {
            effective.python = process.platform === 'win32' ? 'python' : 'python3';
        }
    }

    // --- moduleArgs ---
    if (!effective.moduleArgs || effective.moduleArgs.length === 0) {
        if (detected.enginePath) {
            effective.moduleArgs = [detected.enginePath];
        } else {
            // 回退: 让 python 通过 -m 找 zuzong_memory 模块
            effective.moduleArgs = ['-m', 'zuzong_memory'];
        }
    }

    // --- dbPath ---
    if (!effective.dbPath) {
        effective.dbPath = join(_dshHome(), 'memory', 'zuzong.db');
    }

    return effective;
}

// ---------------------------------------------------------------------------
// Host 路由注册 (记忆库管理卡片后端)
// ---------------------------------------------------------------------------
const MEMORY_ROUTE_PREFIX = '/__dsh/memory';
const GUARD_HEADER = 'x-dsh-memory';

/** 向客户端返回 JSON 响应。 */
function sendJson(res, code, obj) {
    const body = JSON.stringify(obj, null, 2);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

/** 从 query string 解析参数。 */
function parseQuery(url) {
    try {
        return new URL(url, 'http://localhost').searchParams;
    } catch {
        return new URLSearchParams();
    }
}

// ---------------------------------------------------------------------------
// 会话标题读取 (从用量统计插件移植, 三层 fallback)
// ---------------------------------------------------------------------------
function normalizeSessionId(sessionId) {
    return sessionId && sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId;
}

/**
 * 尽力读取会话标题 (三层 fallback):
 *   1. DSH 0.1.2-rc.1: storages/session_projcache/sessions/session-{uuid}.json
 *   2. 旧版: storages/session_projcache.json (单文件)
 *   3. 终极: sessions/{ws}/session-{uuid}/session.jsonl.zstd 里的 session/title 事件
 * 拿不到返回 null。
 */
async function readSessionTitle(sessionId) {
    const id = normalizeSessionId(sessionId);
    try {
        // Layer 1: 新版按 session 分文件的 projcache
        const projPath = join(_dshHome(), 'storages', 'session_projcache', 'sessions', 'session-' + id + '.json');
        let raw;
        try { raw = readFileSync(projPath, 'utf8'); } catch {
            // Layer 2: 旧版单文件 projcache
            try { raw = readFileSync(join(_dshHome(), 'storages', 'session_projcache.json'), 'utf8'); } catch { raw = null; }
        }
        if (raw) {
            const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
            const data = JSON.parse(text);
            if (data && data.record && data.record.rows && data.record.rows.title && typeof data.record.rows.title.val === 'string') {
                const t = data.record.rows.title.val.trim();
                if (t.length > 0) return t;
            }
            const rows = data && data.tables && data.tables.sessions;
            if (rows && typeof rows === 'object') {
                const row = rows[sessionId];
                const title = row && row.rows && row.rows.title && row.rows.title.val;
                if (typeof title === 'string' && title.trim().length > 0) return title.trim();
            }
        }
        // Layer 3: 终极 fallback — 从 session.jsonl.zstd 里的 session/title 事件提取
        try {
            const sessionsRoot = join(_dshHome(), 'sessions');
            const workspaces = await readdir(sessionsRoot);
            for (const ws of workspaces) {
                const zstdPath = join(sessionsRoot, ws, 'session-' + sessionId, 'session.jsonl.zstd');
                let buf;
                try { buf = readFileSync(zstdPath); } catch { continue; }
                // zstd 可能有多个 frame, 逐个解压拼接
                const frames = [];
                let i = 0;
                const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
                while (i < buf.length) {
                    let j = buf.indexOf(MAGIC, i + 4);
                    if (j < 0) j = buf.length;
                    frames.push(buf.subarray(i, j));
                    i = j;
                }
                const text = Buffer.concat(frames.map(fr => zlib.zstdDecompressSync(fr))).toString('utf8');
                const lines = text.split('\n').filter(l => l.trim());
                // 倒序找最后一个 session/title 事件 (最准)
                for (let k = lines.length - 1; k >= 0; k--) {
                    try {
                        const obj = JSON.parse(lines[k]);
                        if (obj.type === 'session/title' && obj.data && typeof obj.data.title === 'string') {
                            const t = obj.data.title.trim();
                            if (t.length > 0) return t;
                        }
                    } catch { /* skip bad line */ }
                }
            }
        } catch { /* 忽略 fallback 错误 */ }
        return null;
    } catch {
        return null;
    }
}

/**
 * 批量给会话分组附加 display_title (带缓存)。
 *   - 实时标题优先 (ctx.sessions.list.getSnapshot) —— 运行中的会话
 *   - 磁盘 projcache / session.jsonl —— 历史会话
 *   - 都拿不到 → 用 session_id 缩写 (session-766ef...eb150)
 */
async function attachSessionTitles(ctx, groups) {
    if (!Array.isArray(groups)) return groups;
    const titleCache = new Map();  // session_id → title

    // 批量先拿实时标题 (最快)
    let liveSnap = null;
    try {
        const liveSvc = ctx.sessions;
        if (liveSvc && liveSvc.list && typeof liveSvc.list.getSnapshot === 'function') {
            liveSnap = liveSvc.list.getSnapshot();
        }
    } catch { liveSnap = null; }

    for (const g of groups) {
        const sid = g.session_id;
        if (!sid || sid === '__global__') {
            g.display_title = '全局 (无会话)';
            continue;
        }
        // 实时标题优先
        let title = null;
        if (liveSnap && liveSnap.byId && liveSnap.byId[sid]) {
            title = liveSnap.byId[sid].displayTitle || null;
        }
        // 缓存/磁盘查
        if (!title) {
            if (titleCache.has(sid)) {
                title = titleCache.get(sid);
            } else {
                title = await readSessionTitle(sid);
                titleCache.set(sid, title);
            }
        }
        g.display_title = title || sid.slice(0, 18) + (sid.length > 18 ? '...' : '');
    }
    return groups;
}

/**
 * 注册记忆管理 host 路由 (v3 新增 config GET+POST 合并, 无 method 参数):
 *   GET  /__dsh/memory/status    → 引擎状态 (service_info)
 *   GET  /__dsh/memory/list      → 列出全部记忆 (list_all, 支持 ?limit=&offset=)
 *   GET  /__dsh/memory/search    → 搜索 (search, ?q=&limit=)
 *   POST /__dsh/memory/delete    → 删除 (body: { id: number })
 *   POST /__dsh/memory/write     → 写入 (body: { content, tags?, importance? })
 *   GET+POST /__dsh/memory/config → 读配置 / 保存 enabled 持久化
 *
 * 注意: DSH webServer.register 不支持 method 参数区分路由,
 *   同 path 必须单 handler 内部判断 req.method;
 *   路由注册必须用 ctx.effect 包裹, 否则注册后会被立即清理 (HTTP 405)。
 */
function registerMemoryRoutes(ctx, bridge, effectiveConfig) {
    let webServer;
    try { webServer = ctx.get('webServer'); } catch { webServer = null; }
    if (!webServer) {
        ctx.logger.warn(`${name}: webServer 不可用, 跳过记忆库管理路由注册`);
        return;
    }

    const PREFIX = MEMORY_ROUTE_PREFIX;

    // --- /status (GET-only) ---
    ctx.effect(() => webServer.register({
        kind: 'exact', path: `${PREFIX}/status`,
        handler: async (req, res) => {
            if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'use GET' }); return; }
            try {
                const r = await bridge.callTool('service_info', {});
                const text = (r.content || []).map((c) => c.text || '').join('\n');
                let data;
                try { data = JSON.parse(text); } catch { data = { raw: text }; }
                sendJson(res, 200, { ok: true, bridgeReady: bridge.isReady(), data });
            } catch (err) {
                sendJson(res, 503, { ok: false, bridgeReady: bridge.isReady(), error: String(err.message || err) });
            }
        },
    }, `${name}: GET /status`));

    // --- /list (GET-only, v3: 支持 session_id / before_ts 过滤) ---
    ctx.effect(() => webServer.register({
        kind: 'exact', path: `${PREFIX}/list`,
        handler: async (req, res) => {
            if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'use GET' }); return; }
            const qs = parseQuery(req.url);
            const limit = parseInt(qs.get('limit') || '200', 10);
            const offset = parseInt(qs.get('offset') || '0', 10);
            // v3 新增过滤参数
            const args = { limit, offset };
            if (qs.get('session_id')) args.session_id = qs.get('session_id');
            if (qs.get('cwd')) args.cwd = qs.get('cwd');
            if (qs.get('before_ts')) args.before_ts = parseInt(qs.get('before_ts'), 10);
            try {
                const r = await bridge.callTool('list_all', args);
                const text = (r.content || []).map((c) => c.text || '').join('\n');
                let data;
                try { data = JSON.parse(text); } catch { data = { raw: text }; }
                sendJson(res, 200, { ok: true, data });
            } catch (err) {
                sendJson(res, 503, { ok: false, error: String(err.message || err) });
            }
        },
    }, `${name}: GET /list`));

    // --- /search (GET-only) ---
    ctx.effect(() => webServer.register({
        kind: 'exact', path: `${PREFIX}/search`,
        handler: async (req, res) => {
            if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'use GET' }); return; }
            const qs = parseQuery(req.url);
            const q = (qs.get('q') || '').trim();
            const limit = parseInt(qs.get('limit') || '20', 10);
            if (!q) { sendJson(res, 400, { ok: false, error: '缺少 q 参数' }); return; }
            try {
                const r = await bridge.callTool('search', { query: q, limit });
                const text = (r.content || []).map((c) => c.text || '').join('\n');
                let data;
                try { data = JSON.parse(text); } catch { data = { raw: text }; }
                sendJson(res, 200, { ok: true, data });
            } catch (err) {
                sendJson(res, 503, { ok: false, error: String(err.message || err) });
            }
        },
    }, `${name}: GET /search`));

    // --- /delete (POST-only) ---
    ctx.effect(() => webServer.register({
        kind: 'exact', path: `${PREFIX}/delete`,
        handler: (req, res) => {
            if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'use POST' }); return; }
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', async () => {
                let parsed = {};
                try { parsed = JSON.parse(body) || {}; } catch { /* 非 JSON 忽略 */ }
                const memoryId = parseInt(parsed.id, 10);
                if (!memoryId) { sendJson(res, 400, { ok: false, error: '缺少 id' }); return; }
                try {
                    const r = await bridge.callTool('delete', { id: memoryId });
                    const text = (r.content || []).map((c) => c.text || '').join('\n');
                    let data;
                    try { data = JSON.parse(text); } catch { data = { raw: text }; }
                    sendJson(res, 200, { ok: true, data });
                } catch (err) {
                    sendJson(res, 503, { ok: false, error: String(err.message || err) });
                }
            });
        },
    }, `${name}: POST /delete`));

    // --- /write (POST-only) ---
    ctx.effect(() => webServer.register({
        kind: 'exact', path: `${PREFIX}/write`,
        handler: (req, res) => {
            if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'use POST' }); return; }
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', async () => {
                let parsed = {};
                try { parsed = JSON.parse(body) || {}; } catch { /* 忽略 */ }
                const content = (parsed.content || '').trim();
                if (!content) { sendJson(res, 400, { ok: false, error: 'content 不能为空' }); return; }
                const args = { content };
                if (parsed.tags) args.tags = parsed.tags;
                if (typeof parsed.importance === 'number') args.importance = parsed.importance;
                try {
                    const r = await bridge.callTool('remember', args);
                    const text = (r.content || []).map((c) => c.text || '').join('\n');
                    let data;
                    try { data = JSON.parse(text); } catch { data = { raw: text }; }
                    sendJson(res, 200, { ok: true, data });
                } catch (err) {
                    sendJson(res, 503, { ok: false, error: String(err.message || err) });
                }
            });
        },
    }, `${name}: POST /write`));

    // --- /config (GET=读配置, POST=保存 autoRemember / autoRecall) ---
    ctx.effect(() => webServer.register({
        kind: 'exact', path: `${PREFIX}/config`,
        handler: (req, res) => {
            if (req.method === 'POST') {
                let body = '';
                req.on('data', (chunk) => { body += chunk; });
                req.on('end', () => {
                    let parsed = {};
                    try { parsed = JSON.parse(body) || {}; } catch { /* 忽略 */ }
                    const patch = {};
                    if (typeof parsed.autoRemember === 'boolean') patch.autoRemember = parsed.autoRemember;
                    if (typeof parsed.autoRecall === 'boolean') patch.autoRecall = parsed.autoRecall;
                    if (typeof parsed.crossSessionRecall === 'boolean') patch.crossSessionRecall = parsed.crossSessionRecall;
                    // 兼容旧字段 enabled: true → 两个都开, enabled: false → 两个都关
                    if (typeof parsed.enabled === 'boolean' && patch.autoRemember === undefined && patch.autoRecall === undefined) {
                        patch.autoRemember = parsed.enabled;
                        patch.autoRecall = parsed.enabled;
                    }
                    if (Object.keys(patch).length === 0) {
                        sendJson(res, 400, { ok: false, error: '无可保存字段' });
                        return;
                    }
                    const merged = _savePersist(patch);
                    ctx.logger.info(`${name}: WebUI 保存 ${JSON.stringify(patch)}`);
                    sendJson(res, 200, {
                        ok: true,
                        config: {
                            autoRemember: Boolean(merged.autoRemember ?? effectiveConfig.memory.autoRemember),
                            autoRecall: Boolean(merged.autoRecall ?? effectiveConfig.memory.autoRecall),
                            crossSessionRecall: Boolean(merged.crossSessionRecall ?? effectiveConfig.memory.crossSessionRecall),
                            persisted: merged,
                        },
                        note: '配置已保存, 下次启动 DSH 后生效',
                    });
                });
            } else {
                // GET / 其他: 返回当前生效配置
                const persist = _loadPersist();
                sendJson(res, 200, {
                    ok: true,
                    config: {
                        autoRemember: Boolean(persist.autoRemember ?? effectiveConfig.memory.autoRemember ?? false),
                        autoRecall: Boolean(persist.autoRecall ?? effectiveConfig.memory.autoRecall ?? false),
                        crossSessionRecall: Boolean(persist.crossSessionRecall ?? effectiveConfig.memory.crossSessionRecall ?? false),
                        persisted: persist,
                        dbPath: effectiveConfig.dbPath,
                    },
                });
            }
        },
    }, `${name}: config route (GET+POST)`));

    // --- v3 新增: /sessions (GET) 列出所有会话分组 + display_title ---
    ctx.effect(() => webServer.register({
        kind: 'exact', path: `${PREFIX}/sessions`,
        handler: async (req, res) => {
            if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'use GET' }); return; }
            try {
                const r = await bridge.callTool('list_sessions', {});
                const text = (r.content || []).map((c) => c.text || '').join('\n');
                let data;
                try { data = JSON.parse(text); } catch { data = { raw: text }; }
                // v3.1: 批量附加 display_title (从 projcache / 实时快照 / session.jsonl 读取)
                if (Array.isArray(data?.sessions)) {
                    data.sessions = await attachSessionTitles(ctx, data.sessions);
                }
                sendJson(res, 200, { ok: true, data });
            } catch (err) {
                sendJson(res, 503, { ok: false, error: String(err.message || err) });
            }
        },
    }, `${name}: GET /sessions`));

    // --- v3 新增: /batch_before (POST) 按时间戳批量清理 ---
    ctx.effect(() => webServer.register({
        kind: 'exact', path: `${PREFIX}/batch_before`,
        handler: (req, res) => {
            if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'use POST' }); return; }
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', async () => {
                let parsed = {};
                try { parsed = JSON.parse(body) || {}; } catch { /* 忽略 */ }
                const beforeTs = parseInt(parsed.before_ts, 10);
                if (!beforeTs || beforeTs <= 0) {
                    sendJson(res, 400, { ok: false, error: '缺少 before_ts (Unix 时间戳, 秒)' });
                    return;
                }
                try {
                    const r = await bridge.callTool('batch_delete_before', { before_ts: beforeTs });
                    const text = (r.content || []).map((c) => c.text || '').join('\n');
                    let data;
                    try { data = JSON.parse(text); } catch { data = { raw: text }; }
                    sendJson(res, 200, { ok: true, data });
                } catch (err) {
                    sendJson(res, 503, { ok: false, error: String(err.message || err) });
                }
            });
        },
    }, `${name}: POST /batch_before`));

    // --- v3 新增: /batch_session (POST) 按 session_id 批量清理 ---
    ctx.effect(() => webServer.register({
        kind: 'exact', path: `${PREFIX}/batch_session`,
        handler: (req, res) => {
            if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'use POST' }); return; }
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', async () => {
                let parsed = {};
                try { parsed = JSON.parse(body) || {}; } catch { /* 忽略 */ }
                const sessionId = (parsed.session_id || '').trim();
                if (!sessionId) {
                    sendJson(res, 400, { ok: false, error: '缺少 session_id' });
                    return;
                }
                try {
                    const r = await bridge.callTool('batch_delete_session', { session_id: sessionId });
                    const text = (r.content || []).map((c) => c.text || '').join('\n');
                    let data;
                    try { data = JSON.parse(text); } catch { data = { raw: text }; }
                    sendJson(res, 200, { ok: true, data });
                } catch (err) {
                    sendJson(res, 503, { ok: false, error: String(err.message || err) });
                }
            });
        },
    }, `${name}: POST /batch_session`));

    ctx.logger.info(`${name}: 记忆库管理路由已注册 (9 条, GET+POST 合并 config + v3 会话隔离 3 条)`);
}

// ---------------------------------------------------------------------------
// 插件激活入口
// ---------------------------------------------------------------------------
export async function apply(ctx, config) {
    // v4: 合并持久化 json 覆盖 (WebUI 开关写进来的 autoRemember / autoRecall)
    const persist = _loadPersist();
    const mergedConfig = { ...config };
    if (mergedConfig.memory && typeof mergedConfig.memory === 'object') {
        if (typeof persist.autoRemember === 'boolean') {
            mergedConfig.memory.autoRemember = persist.autoRemember;
        }
        if (typeof persist.autoRecall === 'boolean') {
            mergedConfig.memory.autoRecall = persist.autoRecall;
        }
    }
    // 组装有效配置 (绿色版默认值 + 持久化覆盖)
    const effective = _resolveEffectiveConfig(mergedConfig);

    ctx.logger.info(
        `dsh-memory-lite: 祖宗记忆库记忆插件激活 · ` +
        `autoRemember=${effective.memory.autoRemember} autoRecall=${effective.memory.autoRecall} ` +
        `python=${effective.python} db=${effective.dbPath}`
    );

    // 创建 MCP stdio 桥 (始终创建, 用户可手动调用工具或 WebUI 管理卡片)
    const bridge = new ZuzongBridge({
        python: effective.python,
        args: effective.moduleArgs,
        env: {
            ZUZONG_DB: effective.dbPath,
            ZUZONG_IDENTITY: effective.identity,
            ...effective.env,
        },
        timeoutMs: effective.toolCallTimeoutMs,
        maxRetryDelayMs: effective.maxRetryDelayMs,
    });
    bridge.start();

    const ready = await bridge.waitReady();
    if (!ready) {
        const message = `祖宗记忆库记忆进程无法启动 (python=${effective.python}, 请检查便携 Python 是否就绪)`;
        if (effective.failOnStartupError) {
            bridge.dispose();
            throw new Error(message);
        }
        ctx.logger.warn(`dsh-memory: ${message}，继续后台重试`);
    }

    const disposers = [];
    let toolsPoll = null;
    try {
        // --- 工具注册 (动态拉取 bridge 上的工具清单, 按 config.tools 筛选) ---
        let toolsRegistered = false;
        const tryRegister = async () => {
            if (toolsRegistered || !bridge.isReady()) return;
            try {
                const dispose = await registerZuzongTools(ctx, bridge, {
                    selection: effective.tools,
                    toolPrefix: `${effective.serverName}_`,
                });
                disposers.push(dispose);
                toolsRegistered = true;
                if (toolsPoll) { clearInterval(toolsPoll); toolsPoll = null; }
                ctx.logger.info('dsh-memory: 祖宗记忆库工具已注册');
            } catch (err) {
                ctx.logger.warn(`dsh-memory: 工具注册失败, 稍后重试: ${String(err)}`);
            }
        };
        if (ready) await tryRegister();
        if (!toolsRegistered) {
            toolsPoll = setInterval(() => { void tryRegister(); }, 2000);
            disposers.push(() => { if (toolsPoll) clearInterval(toolsPoll); });
        }

        // --- v5 (实时生效): 无论 autoRemember/autoRecall 是什么都装 hooks ---
        // 每个 hook 内部通过 isAutoRemember() / isAutoRecall() 懒读最新值,
        // WebUI 改开关后下次请求/事件立即生效, 不用重启。
        // 注意: 以前是 if (ar || ac) install → 开关全关时 hooks 根本没注册,
        // 用户改了开关也没用 —— 必须重启 apply() 才会走到 installMemoryHooks。
        installMemoryHooks(ctx, bridge, {
            ...effective.memory,
            isAutoRemember: () => {
                const fresh = _loadPersist();
                return Boolean(fresh.autoRemember ?? effective.memory.autoRemember);
            },
            isAutoRecall: () => {
                const fresh = _loadPersist();
                return Boolean(fresh.autoRecall ?? effective.memory.autoRecall);
            },
            // v3.1: 跨会话加载开关 —— false=只读当前会话, true=全局记忆也加载
            isCrossSessionRecall: () => {
                const fresh = _loadPersist();
                return Boolean(fresh.crossSessionRecall ?? effective.memory.crossSessionRecall);
            },
        });
        ctx.logger.info(
            `dsh-memory: hooks 已安装 (autoRemember=${effective.memory.autoRemember}, ` +
            `autoRecall=${effective.memory.autoRecall}, ` +
            `crossSessionRecall=${effective.memory.crossSessionRecall}, 可实时切换)`
        );

        // --- 记忆库管理卡片 host 路由 (始终注册, 含 config 读写) ---
        // registerMemoryRoutes 内部自己用 ctx.effect 管理路由生命周期
        registerMemoryRoutes(ctx, bridge, effective);
    } catch (err) {
        bridge.dispose();
        throw err;
    }

    // --- effect 清理作用域 (插件卸载时自动回收) ---
    ctx.effect(() => {
        return () => {
            for (const dispose of disposers) dispose();
            bridge.dispose();
            ctx.logger.info('dsh-memory: 已卸载 (工具已注销, 祖宗记忆库进程已退出)');
        };
    }, name);
}
