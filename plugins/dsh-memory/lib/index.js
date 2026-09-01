/**
 * dsh-memory —— 祖宗记忆库记忆插件
 *
 * 核心模块:
 *   - bridge  (MCP stdio 桥)  : 管理 zuzong_memory.py Python 子进程生命周期
 *   - hooks   (自动记忆 + autoRecall) : 会话事件钩子, 对用户消息脱敏后写入记忆库,
 *                                       system-prompt 组装时自动注入最近记忆
 *   - tools   (工具注册)       : 动态拉取 bridge 工具清单, 注册到 Cordis 工具系统
 *   - routes  (host 路由)      : /__dsh/memory/* 记忆库管理卡片后端
 *
 * 用法 (cordis.yml):
 *   - id: dsh-memory
 *     name: dsh-memory
 *     config:                        # 全部可选, 以下为绿色版默认值
 *       dbPath: '${DSH_HOME}/memory/zuzong.db'
 *       identity: '祖宗记忆库'
 *       tools: ['remember','recall','search','timeline','service_info','list_all','delete']
 *       memory: { userMessage: true, autoRecall: true, desensitize: true }
 */
import z from '@deepseek-ai/schemastery';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
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

/** 精简版配置 (移除 roleplayEntryButton / mutual 等非核心)。 */
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
        userMessage: z.boolean().default(true),
        assistantMessage: z.boolean().default(false),
        toolResult: z.boolean().default(false),
        importance: z.number().default(0.6),
        autoRecall: z.boolean().default(true),
        autoRecallLimit: z.number().default(4),
        desensitize: z.boolean().default(true),
    }).default({
        userMessage: true, assistantMessage: false, toolResult: false,
        importance: 0.6, autoRecall: true, autoRecallLimit: 4, desensitize: true,
    }),
    toolCallTimeoutMs: z.number().default(60_000),
    maxRetryDelayMs: z.number().default(30_000),
    failOnStartupError: z.boolean().default(false),
});

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

/**
 * 注册 4 个记忆管理 host 路由:
 *   GET  /__dsh/memory/status    → 引擎状态 (service_info)
 *   GET  /__dsh/memory/list      → 列出全部记忆 (list_all, 支持 ?limit=&offset=)
 *   GET  /__dsh/memory/search    → 搜索 (search, ?q=&limit=)
 *   POST /__dsh/memory/delete    → 删除 (body: { id: number })
 *   POST /__dsh/memory/write     → 写入 (body: { content, tags?, importance? })
 */
function registerMemoryRoutes(ctx, bridge) {
    const routes = [
        { path: `${MEMORY_ROUTE_PREFIX}/status`, method: 'GET', handler: async (req, res) => {
            try {
                const r = await bridge.callTool('service_info', {});
                const text = (r.content || []).map((c) => c.text || '').join('\n');
                let data;
                try { data = JSON.parse(text); } catch { data = { raw: text }; }
                sendJson(res, 200, { ok: true, bridgeReady: bridge.isReady(), data });
            } catch (err) {
                sendJson(res, 503, { ok: false, bridgeReady: bridge.isReady(), error: String(err.message || err) });
            }
        }},
        { path: `${MEMORY_ROUTE_PREFIX}/list`, method: 'GET', handler: async (req, res) => {
            const qs = parseQuery(req.url);
            const limit = parseInt(qs.get('limit') || '200', 10);
            const offset = parseInt(qs.get('offset') || '0', 10);
            try {
                const r = await bridge.callTool('list_all', { limit, offset });
                const text = (r.content || []).map((c) => c.text || '').join('\n');
                let data;
                try { data = JSON.parse(text); } catch { data = { raw: text }; }
                sendJson(res, 200, { ok: true, data });
            } catch (err) {
                sendJson(res, 503, { ok: false, error: String(err.message || err) });
            }
        }},
        { path: `${MEMORY_ROUTE_PREFIX}/search`, method: 'GET', handler: async (req, res) => {
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
        }},
        { path: `${MEMORY_ROUTE_PREFIX}/delete`, method: 'POST', handler: async (req, res) => {
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
        }},
        { path: `${MEMORY_ROUTE_PREFIX}/write`, method: 'POST', handler: async (req, res) => {
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
        }},
    ];

    const disposers = [];
    for (const route of routes) {
        try {
            const dispose = ctx.webServer.register({
                kind: 'exact',
                path: route.path,
                method: route.method,
                handler: route.handler,
            }, `${name}: ${route.method} ${route.path}`);
            disposers.push(dispose);
            ctx.logger.info(`${name}: 已注册路由 ${route.method} ${route.path}`);
        } catch (err) {
            ctx.logger.warn(`${name}: 路由注册失败 ${route.method} ${route.path} (webServer 不可用?): ${String(err)}`);
        }
    }
    return () => { for (const d of disposers) d(); };
}

// ---------------------------------------------------------------------------
// 插件激活入口
// ---------------------------------------------------------------------------
export async function apply(ctx, config) {
    // 组装有效配置 (绿色版默认值)
    const effective = _resolveEffectiveConfig(config);

    ctx.logger.info(
        `dsh-memory-lite: 祖宗记忆库记忆插件激活 · ` +
        `python=${effective.python} args=[${effective.moduleArgs.join(' ')}] ` +
        `db=${effective.dbPath}`
    );

    // 创建 MCP stdio 桥
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

        // --- 自动记忆钩子 (session/event + autoRecall) ---
        installMemoryHooks(ctx, bridge, effective.memory);

        // --- 记忆库管理卡片 host 路由 ---
        // webServer 是可选注入 (某些最小 host 没有), 缺失时跳过
        let webServer;
        try { webServer = ctx.get('webServer'); } catch { webServer = null; }
        if (webServer) {
            const disposeRoutes = registerMemoryRoutes(ctx, bridge);
            disposers.push(disposeRoutes);
            ctx.logger.info('dsh-memory: 记忆库管理路由已注册 (可通过 /__dsh/memory/* 访问)');
        } else {
            ctx.logger.warn('dsh-memory: webServer 不可用, 跳过记忆库管理路由注册');
        }
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
