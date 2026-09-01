/**
 * 自动记忆钩子：把 DSH 的会话事件（经统一的 session/event 分发）沉淀进祖宗记忆库。
 *
 * 与 DSH 的 session-persistence 插件（保存会话日志）不同，这里是"语义沉淀"：
 * 用户消息写入祖宗记忆库知识层（带去重与重要性），agent 回复与工具结果可选开启。
 * 只记忆真实用户消息（source.kind === 'user'），过滤插件注入的噪音。
 *
 * P1 完善（GPT 审查·自动记忆只写不读）：新增 autoRecall——通过
 * system-prompt/assemble 事件（waterfall，异步允许）在每次模型请求组装
 * system prompt 时自动注入祖宗记忆库最近记忆（timeline），让记忆"自动可用"
 * 而不只依赖 Agent 主动调用 recall/think 工具。失败静默（不影响请求）。
 */
import '@deepseek-ai/dsh-session';
import '@deepseek-ai/dsh-system-prompt';
/** 从 ContentBlock[] 提取纯文本。 */
function extractText(blocks) {
    const parts = [];
    for (const block of blocks) {
        if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text);
        }
    }
    return parts.join('\n').trim();
}
/**
 * 敏感信息模式（GPT 审查·自动记忆脱敏）：写入记忆库前过滤凭据/个人标识。
 * 命中 → 替换为 [已过滤:类别]（保留对话主体）；过滤后只剩占位符/空白 → 整条跳过。
 * 纯内容过滤，不涉及身份认证——开源场景下的隐私保护。
 */
const SENSITIVE_PATTERNS = [
    { re: /sk-[A-Za-z0-9_-]{8,}/g, label: 'API密钥' },
    { re: /\b(?:api[_-]?key|apikey|access[_-]?token)\b\s*[:=]\s*[^\s,，。;；]+/gi, label: 'API密钥' },
    { re: /\b(?:password|passwd|pwd)\b\s*[:=]\s*[^\s,，。;；]+/gi, label: '密码' },
    { re: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, label: '令牌' },
    // 中文密码：值限定非中文连续串（凭据特征），避免误伤「密码是重要的安全概念」
    { re: /密码\s*[:：是]\s*[A-Za-z0-9_@#$%^&*!.-]{4,}/g, label: '密码' },
    { re: /\b\d{17}[\dXx]\b/g, label: '身份证号' },
    { re: /\b1[3-9]\d{9}\b/g, label: '手机号' },
];
/** 脱敏：替换敏感片段；返回 null 表示整条都是敏感内容（应跳过写入）。 */
export function desensitize(text) {
    let out = text;
    for (const { re, label } of SENSITIVE_PATTERNS) {
        out = out.replace(re, `[已过滤:${label}]`);
    }
    // 过滤后只剩占位符/空白 → 纯凭据消息，不写（或全部被替换）
    const residue = out.replace(/\[已过滤:[^\]]+\]/g, '').trim();
    if (!residue)
        return null;
    return out;
}
/** 安装自动记忆钩子（effect 作用域内，随插件卸载自动移除）。 */
export function installMemoryHooks(ctx, bridge, opts) {
    const memorize = (tool, args) => {
        void bridge
            .callTool(tool, args)
            .catch((err) => ctx.logger.warn(`dsh-memory: ${tool} 自动记忆失败: ${err.message}`));
    };
    // P1 完善（GPT 审查·自动记忆脱敏）：写入前过滤敏感信息（默认开启）。
    // 命中敏感模式 → 替换为 [已过滤:类别]；纯凭据消息 → 跳过写入（不落库）。
    const sanitize = (text) => {
        if (!opts.desensitize)
            return text;
        return desensitize(text);
    };
    // P1 完善（自动 recall 注入）：每次模型请求组装 system prompt 时，注入祖宗记忆库最近记忆。
    // 用 system-prompt/assemble 事件（waterfall）而非 llm/stream——后者请求 deep-frozen 不可改写。
    if (opts.autoRecall) {
        const recallLimit = Math.max(1, Math.min(10, opts.autoRecallLimit || 4));
        ctx.on('system-prompt/assemble', async (assembly, _ctx, next) => {
            try {
                // 异步取最近记忆（失败静默——不阻塞模型请求）
                const r = await bridge.callTool('timeline', { limit: recallLimit });
                const text = extractText(r.content);
                if (text) {
                    assembly.contexts.push({
                        name: 'zuzong:auto-recall',
                        text: `【祖宗记忆库 · 最近记忆】\n${text.slice(0, 600)}`,
                    });
                }
            }
            catch { /* 静默：召回失败不影响请求 */ }
            return next();
        });
    }
    ctx.on('session/event', (_session, event) => {
        if (event.type === 'user/message' && opts.userMessage) {
            // 只记真实用户输入（kind='user'），跳过插件注入/系统上下文
            if (event.data.source?.kind !== 'user') {
                // T4 诊断（2026-08-30）：dsh 端对话零写入排查——记录被滤事件的实际
                // source.kind（若 dsh 新版改了 kind 值，此处日志可定位）
                ctx.logger.info(`dsh-memory: user/message 事件被滤（source.kind=${event.data.source?.kind ?? 'undefined'}）`);
                return;
            }
            const text = extractText(event.data.content);
            if (!text)
                return;
            const safe = sanitize(text); // 脱敏：纯凭据消息 → null → 跳过写入
            if (safe === null)
                return;
            memorize('remember', { content: safe, importance: opts.importance, tags: ['dsh', 'user'] });
            // T4：用用户消息做一次语义召回——触发祖宗记忆库 _note_reuse 落库（复用观测），
            // 召回结果同时预热祖宗记忆库检索缓存（timeline 只读不触发复用统计）
            memorize('recall', { query: safe.slice(0, 200), limit: 3 });
        }
        else if (event.type === 'assistant/message' && opts.assistantMessage) {
            const text = extractText(event.data.message.content);
            if (!text)
                return;
            const safe = sanitize(text);
            if (safe === null)
                return;
            memorize('remember', { content: safe, importance: opts.importance * 0.8, tags: ['dsh', 'assistant'] });
        }
        else if (event.type === 'tool/result' && opts.toolResult) {
            if (event.data.error)
                return;
            const text = extractText(event.data.message.content);
            if (!text)
                return;
            const safe = sanitize(text);
            if (safe === null)
                return;
            memorize('remember', { content: safe, importance: opts.importance * 0.6, tags: ['dsh', 'tool'] });
        }
    });
}
