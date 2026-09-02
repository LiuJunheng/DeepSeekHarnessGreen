/**
 * dsh-rules —— 用户规则注入插件
 *
 * 类似 TRAE Work 的「规则」功能: 用户编写 markdown 格式的个人规则
 * (习惯、风格、要求等), 每次模型请求组装 system prompt 时自动注入。
 *
 * 运作机制 (参考 dsh-memory hooks.js):
 *   监听 DSH 的 `system-prompt/assemble` waterfall 事件, 在 assembly.contexts
 *   里追加一条 user-rules context。DSH runtime 会把所有 contexts 拼成完整的
 *   system prompt 发送给 LLM。
 *
 * 规则文件默认位置: ${DSH_HOME}/rules/user-rules.md
 *   绿色版: runtime/dsh-home/rules/user-rules.md
 *   非绿色版: ~/.dsh/rules/user-rules.md
 *
 * v3: 加 enabled 总开关 (默认 false), WebUI settings 面板读写持久化 json。
 *
 * 配置 (cordis.yml):
 *   dsh-rules:
 *     enabled: false             # v3: 总开关, 默认关闭 (WebUI 里可开)
 *     rulesPath: ''              # 空=默认 ${DSH_HOME}/rules/user-rules.md
 *     autoReload: true           # 文件变化自动重载 (fs.watch + 2s 缓存)
 *     weight: 0.9                # 注入权重 (越高越优先)
 *     headerLabel: '【用户规则】' # 注入到 prompt 里的标题
 *     failSilently: true         # 读文件失败时静默 (不报错)
 */
import z from '@deepseek-ai/schemastery';
import { existsSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { installRulesHooks } from './hooks.js';

export const name = 'dsh-rules';

/** v3: 注入 webServer (用于注册 /__dsh/rules/config 路由)。 */
export const inject = ['webServer'];

/**
 * 插件配置 schema (用 DSH 自带的 schemastery 校验)。
 * 全部字段都有默认值, 用户不写 cordis.yml 也能工作。
 */
export const Config = z.object({
    /** v3: 总开关 —— 默认 false (规则会占 system prompt token)。 */
    enabled: z.boolean().default(false),
    /** 规则文件路径 (空字符串 = 自动用 DSH_HOME/rules/user-rules.md)。 */
    rulesPath: z.string().default(''),
    /** 文件变化自动重载: 用 fs.watch 监听规则文件目录, 下次请求时读取最新内容。 */
    autoReload: z.boolean().default(true),
    /** 注入权重: 决定 context 在 system prompt 里的优先级 (越高越优先)。 */
    weight: z.number().default(0.9),
    /** 注入到 prompt 里的标题: 方便 LLM 识别这一段是什么。 */
    headerLabel: z.string().default('【用户规则】'),
    /** 静默模式: 读文件失败时不打 warn 日志 (规则文件被删/权限问题不应该干扰用户)。 */
    failSilently: z.boolean().default(true),
    /** 规则内容最大字符数 (防止用户写太长占爆 token, 0=不限)。 */
    maxLength: z.number().default(16000),
});

/** 持久化 json 文件路径: ${DSH_HOME}/rules/rules-config.json。 */
function _persistPath() {
    return join(resolveDshHome(), 'rules', 'rules-config.json');
}

/** 读取持久化 json (WebUI 开关覆盖)。文件不存在 → 空对象。 */
function _loadPersist() {
    const p = _persistPath();
    if (!existsSync(p)) return {};
    try {
        return JSON.parse(readFileSync(p, 'utf-8')) || {};
    } catch {
        return {};
    }
}

/** 写持久化 json。 */
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

/**
 * 探测绿色版 runtime: 逐层向上回溯寻找 runtime/python/python/python.exe。
 * 跟 dsh-memory 的 _detectGreenRuntime 逻辑一样, 这里简化一下只返回 DSH_HOME。
 */
function resolveDshHome() {
    // 1. 进程环境变量 (绿色版启动器会设 DSH_HOME=runtime/dsh-home)
    if (process.env.DSH_HOME) {
        return process.env.DSH_HOME;
    }
    // 2. 回退到用户目录
    return join(homedir(), '.dsh');
}

/**
 * 确保规则文件存在。首次安装时从 default-rules.md 拷贝默认模板。
 * 文件已存在则跳过 (不覆盖用户可能已编辑的内容)。
 *
 * @param {string} rulesPath - 规则文件目标路径
 */
function ensureRulesFile(rulesPath) {
    // 目录不存在 → 先创建
    const rulesDir = dirname(rulesPath);
    if (!existsSync(rulesDir)) {
        try {
            mkdirSync(rulesDir, { recursive: true });
        } catch (err) {
            // 创建目录失败不致命, 后续读文件时会 catch
            return;
        }
    }
    // 文件已存在 → 跳过 (绝不覆盖用户数据)
    if (existsSync(rulesPath)) {
        return;
    }
    // 从 default-rules.md 拷贝默认模板
    try {
        const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)));
        const defaultFile = join(pluginDir, 'default-rules.md');
        if (existsSync(defaultFile)) {
            copyFileSync(defaultFile, rulesPath);
        }
    } catch (_err) {
        // 拷贝失败不致命, 读文件时会 catch 并静默跳过注入
    }
}

/**
 * Cordis 插件生命周期入口: 插件被加载时调用 (Cordis 协议要求导出函数名为 apply)。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文 (含 logger, on, waterfall 等)
 * @param {z.infer<typeof Config>} config - 用户在 cordis.yml 里配置的值 (或默认值)
 */
export async function apply(ctx, config) {
    // v3: 合并持久化 json 覆盖 (WebUI 开关写进来的)
    const persist = _loadPersist();
    const mergedConfig = { ...config };
    if (typeof persist.enabled === 'boolean') {
        mergedConfig.enabled = persist.enabled;
    }

    // 1. 解析规则文件路径
    const dshHome = resolveDshHome();
    const rulesPath = mergedConfig.rulesPath || join(dshHome, 'rules', 'user-rules.md');

    // 2. 确保规则文件存在 (首次安装自动创建)
    ensureRulesFile(rulesPath);

    // v3: 注册 config / content 路由 (同 path 合并 GET+POST, 内部判断 req.method)
    // DSH webServer.register 不支持 method 参数区分路由, 同 path 必须单 handler 判断 method。
    // 路由注册必须用 ctx.effect 包裹, 否则注册后会被立即清理 (HTTP 405)。
    try {
        const webServer = ctx.get('webServer');

        // --- /__dsh/rules/config (GET=读配置, POST=保存 enabled) ---
        ctx.effect(() => webServer.register({
            kind: 'exact',
            path: '/__dsh/rules/config',
            handler: (req, res) => {
                if (req.method === 'POST') {
                    // POST: 保存 enabled 到持久化 json
                    let body = '';
                    req.on('data', (chunk) => { body += chunk; });
                    req.on('end', () => {
                        let parsed = {};
                        try { parsed = JSON.parse(body) || {}; } catch { /* 忽略 */ }
                        const patch = {};
                        if (typeof parsed.enabled === 'boolean') patch.enabled = parsed.enabled;
                        if (Object.keys(patch).length === 0) {
                            sendJson(res, 400, { ok: false, error: '无可保存字段' });
                            return;
                        }
                        const merged = _savePersist(patch);
                        ctx.logger.info(`${name}: WebUI 保存 enabled=${merged.enabled}`);
                        sendJson(res, 200, {
                            ok: true,
                            config: { enabled: Boolean(merged.enabled ?? mergedConfig.enabled) },
                            note: '配置已保存, 下次启动 DSH 后生效',
                        });
                    });
                } else {
                    // GET / 其他: 返回当前生效配置
                    const p = _loadPersist();
                    const ruleFileExists = existsSync(rulesPath);
                    let ruleSize = 0;
                    if (ruleFileExists) {
                        try { ruleSize = readFileSync(rulesPath, 'utf-8').length; } catch { /* 忽略 */ }
                    }
                    sendJson(res, 200, {
                        ok: true,
                        config: {
                            enabled: Boolean(p.enabled ?? mergedConfig.enabled),
                            rulesPath,
                            ruleFileExists,
                            ruleSize,
                            autoReload: Boolean(mergedConfig.autoReload),
                            headerLabel: mergedConfig.headerLabel,
                            maxLength: mergedConfig.maxLength,
                        },
                        persisted: p,
                    });
                }
            },
        }, `${name}: config route`));

        // --- /__dsh/rules/content (GET=读文件, POST=写文件) ---
        ctx.effect(() => webServer.register({
            kind: 'exact',
            path: '/__dsh/rules/content',
            handler: (req, res) => {
                if (req.method === 'POST') {
                    // POST: 写规则文件
                    let body = '';
                    req.on('data', (chunk) => { body += chunk; });
                    req.on('end', () => {
                        let parsed = {};
                        try { parsed = JSON.parse(body) || {}; } catch {
                            sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
                            return;
                        }
                        const newContent = typeof parsed.content === 'string' ? parsed.content : null;
                        if (newContent === null) {
                            sendJson(res, 400, { ok: false, error: '缺少 content 字段' });
                            return;
                        }
                        // 长度上限检查 (防止写爆 token)
                        if (mergedConfig.maxLength > 0 && newContent.length > mergedConfig.maxLength) {
                            sendJson(res, 413, {
                                ok: false,
                                error: '规则内容过长 (' + newContent.length + ' 字符), 上限 ' + mergedConfig.maxLength,
                            });
                            return;
                        }
                        // 确保目录存在
                        const rulesDir = dirname(rulesPath);
                        if (!existsSync(rulesDir)) {
                            try { mkdirSync(rulesDir, { recursive: true }); } catch (err) {
                                sendJson(res, 500, { ok: false, error: '创建目录失败: ' + String(err.message || err) });
                                return;
                            }
                        }
                        try {
                            writeFileSync(rulesPath, newContent, 'utf-8');
                            sendJson(res, 200, {
                                ok: true,
                                content: newContent,
                                size: newContent.length,
                                note: '规则已保存' + (mergedConfig.autoReload ? ', 下次对话自动生效' : ' (请手动重启 DSH 生效)'),
                            });
                        } catch (err) {
                            sendJson(res, 500, { ok: false, error: '写文件失败: ' + String(err.message || err) });
                        }
                    });
                } else {
                    // GET / 其他: 读规则文件
                    ensureRulesFile(rulesPath);
                    if (!existsSync(rulesPath)) {
                        sendJson(res, 200, { ok: true, content: '', path: rulesPath });
                        return;
                    }
                    try {
                        const content = readFileSync(rulesPath, 'utf-8');
                        sendJson(res, 200, {
                            ok: true,
                            content,
                            path: rulesPath,
                            size: content.length,
                        });
                    } catch (err) {
                        sendJson(res, 500, { ok: false, error: '读文件失败: ' + String(err.message || err) });
                    }
                }
            },
        }, `${name}: content route`));

        // --- /__dsh/rules/open-folder (GET: 用系统文件管理器打开规则文件所在目录) ---
        ctx.effect(() => webServer.register({
            kind: 'exact',
            path: '/__dsh/rules/open-folder',
            handler: (req, res) => {
                const targetDir = dirname(rulesPath);
                if (!existsSync(targetDir)) {
                    mkdirSync(targetDir, { recursive: true });
                }
                const platform = process.platform;
                try {
                    if (platform === 'win32') {
                        // Windows: spawn explorer 直接传参数, 不经过 shell
                        const child = spawn('explorer', [targetDir], {
                            detached: true, stdio: 'ignore', windowsHide: false,
                        });
                        child.unref();
                    } else if (platform === 'darwin') {
                        const child = spawn('open', [targetDir], {
                            detached: true, stdio: 'ignore',
                        });
                        child.unref();
                    } else {
                        const child = spawn('xdg-open', [targetDir], {
                            detached: true, stdio: 'ignore',
                        });
                        child.unref();
                    }
                    ctx.logger.info(`${name}: 已打开目录 ${targetDir}`);
                    sendJson(res, 200, { ok: true, path: targetDir });
                } catch (err) {
                    ctx.logger.warn(`${name}: 打开目录失败: ${err.message}`);
                    sendJson(res, 500, { ok: false, error: String(err.message || err) });
                }
            },
        }, `${name}: open-folder route`));

        ctx.logger.info(`${name}: 配置路由已注册 (3 条, GET+POST 合并)`);
    } catch {
        ctx.logger.warn(`${name}: webServer 不可用, 跳过配置路由注册`);
    }

    // 3. v4 (实时生效): 无论 enabled 是什么都装 hooks, hook 内部通过
    //    isEnabled() 懒读最新值 → WebUI 改开关后下次请求立即生效, 不用重启。
    //    路由仍注册 (让用户能在 WebUI 里改开关)。
    //    注意: 以前 enabled=false 时 apply 会直接 return, 根本不 installRulesHooks,
    //    所以用户改了开关也没用 —— 必须重启。现在删掉这个早返回。

    // 4. 安装 system-prompt/assemble 钩子 (带实时 enabled 守卫)
    //    isEnabled 闭包每次被调用时都读最新的持久化 JSON, 避免 stale closure 问题。
    installRulesHooks(ctx, {
        rulesPath,
        config: mergedConfig,
        isEnabled: () => {
            const fresh = _loadPersist();
            return Boolean(fresh.enabled ?? mergedConfig.enabled);
        },
    });

    ctx.logger.info(`${name}: ready, rules file = ${rulesPath}, hooks 已安装 (enabled=${mergedConfig.enabled}, 可实时切换)`);
}
