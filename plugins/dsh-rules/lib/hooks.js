/**
 * dsh-rules hooks —— 核心 system-prompt/assemble 注入逻辑。
 *
 * 工作流程:
 *   1. 监听 DSH 的 system-prompt/assemble waterfall 事件
 *   2. 每次模型请求组装 system prompt 时触发
 *   3. 读用户规则文件 (带缓存 + 自动重载)
 *   4. 追加到 assembly.contexts → DSH runtime 拼成完整 prompt → 发给 LLM
 *
 * 参考: plugins/dsh-memory/lib/hooks.js 里的 autoRecall 实现
 *  (dsh-memory 用同一机制注入祖宗记忆库内容)
 */
import '@deepseek-ai/dsh-system-prompt';
import { readFileSync, watch, existsSync } from 'node:fs';
import { dirname, basename } from 'node:path';

/** 缓存 TTL: 规则文件读一次缓存 2 秒, 避免每次请求都磁盘 IO。 */
const CACHE_TTL_MS = 2000;

/**
 * 安装规则注入钩子。在 Cordis effect 作用域内, 插件卸载时自动移除所有钩子。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文
 * @param {{ rulesPath: string, config: object }} opts - 配置对象
 *   - rulesPath: 规则文件绝对路径
 *   - config: Config schema 校验后的配置 (enabled/rulesPath/autoReload/weight/headerLabel/failSilently/maxLength)
 */
export function installRulesHooks(ctx, opts) {
    const rulesPath = opts.rulesPath;
    const config = opts.config;

    /** @type {string|null} 规则内容缓存 (null = 无有效内容) */
    let cachedRules = null;
    /** @type {number} 缓存写入时间戳 (毫秒) */
    let cacheTimeMs = 0;

    /**
     * 读取规则文件内容。带缓存 (2s TTL) + maxLength 截断 + 去空。
     * 读失败时返回 null (不抛异常, 让调用方静默跳过注入)。
     *
     * @returns {string|null} 规则纯文本, 或 null (无内容 / 读失败 / 超过 maxLength)
     */
    function readRulesContent() {
        const now = Date.now();
        // 命中缓存 → 直接返回
        if (cachedRules !== null && (now - cacheTimeMs < CACHE_TTL_MS)) {
            return cachedRules;
        }

        // 文件不存在 → 跳过 (可能用户删了, 或 ensureRulesFile 还没跑)
        if (!existsSync(rulesPath)) {
            cachedRules = null;
            cacheTimeMs = now;
            return null;
        }

        try {
            let raw = readFileSync(rulesPath, 'utf-8');
            // 去 BOM (Windows 记事本保存的 markdown 可能有 UTF-8 BOM)
            if (raw.charCodeAt(0) === 0xFEFF) {
                raw = raw.slice(1);
            }
            // 去首尾空白 + 内部多余空行
            const trimmed = raw.trim();
            if (!trimmed) {
                cachedRules = null;
                cacheTimeMs = now;
                return null;
            }
            // 超过 maxLength → 截断 (保留前 maxLength 字符, 加省略号)
            let final = trimmed;
            if (config.maxLength > 0 && trimmed.length > config.maxLength) {
                final = trimmed.slice(0, config.maxLength) + '\n...(规则内容已截断, 超过 maxLength 限制)';
            }
            cachedRules = final;
            cacheTimeMs = now;
            return final;
        } catch (err) {
            if (!config.failSilently) {
                ctx.logger.warn(`dsh-rules: 读规则文件失败: ${err.message}`);
            }
            cachedRules = null;
            cacheTimeMs = now;
            return null;
        }
    }

    /**
     * 文件变化监听: autoReload=true 时 watch 规则文件所在目录。
     * Windows 上 watch 文件本身可能不稳定, 所以 watch 目录 + 过滤文件名。
     */
    if (config.autoReload) {
        try {
            const watchDir = dirname(rulesPath);
            const watchFile = basename(rulesPath);
            watch(watchDir, (eventType, filename) => {
                // 只关心规则文件本身 (避免目录里其他 md 文件触发)
                if (filename === watchFile) {
                    cachedRules = null; // 清缓存 → 下次请求重新读盘
                    ctx.logger.info('dsh-rules: 规则文件已更新, 下次请求生效');
                }
            });
            ctx.logger.info(`dsh-rules: watching ${watchDir}/${watchFile} for changes`);
        } catch (err) {
            // watch 失败 (比如规则目录不存在或无权限) → 降级为无 autoReload
            if (!config.failSilently) {
                ctx.logger.warn(`dsh-rules: 文件监听失败 (autoReload 降级): ${err.message}`);
            }
        }
    }

    /**
     * 核心钩子: system-prompt/assemble。
     * 每次模型请求组装 system prompt 时执行 (waterfall 模式, 支持异步)。
     *
     * assembly.contexts 追加规则 → DSH runtime 把所有 contexts 拼成完整 prompt → 发给 LLM。
     * context.name 必须全局唯一 (invariant.js 校验), 我们用 'user-rules'。
     */
    ctx.on('system-prompt/assemble', async (assembly, _ctx, next) => {
        try {
            const rules = readRulesContent();
            if (rules) {
                assembly.contexts.push({
                    name: 'user-rules',
                    text: `${config.headerLabel}\n${rules}`,
                    weight: config.weight,
                });
            }
        } catch (err) {
            // 钩子本身不能抛异常 → 静默吞掉, 下一次请求继续试
            if (!config.failSilently) {
                ctx.logger.warn(`dsh-rules: assemble hook 异常: ${err.message}`);
            }
        }
        // waterfall 链必须继续传下去 (下一个监听者修改 assembly)
        return next();
    });
}
