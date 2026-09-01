/**
 * 规则提炼 (v2: 零 LLM 成本的精简概要生成)。
 * 输入原文 + 类型 (user/assistant), 输出精简 summary。
 * 原则: 只抓核心信息, 砍废话和噪音, 纯中文短句。
 *
 * 用户消息: 目标 15-25 字核心 query, 砍寒暄/修饰
 * AI 回复:  目标 1-2 句总 ≤ 50 字, 砍思考过程/套话, 抓结论
 */
function ruleSummarize(text, kind) {
    if (!text)
        return text;
    // 太短: AI 回复短寒暄 → null (跳过写入); 用户消息直接返回
    if (text.length < 5) {
        if (kind === 'assistant') return null;
        return text;
    }
    // --- 先过滤明显噪音 ---
    // 日志粘贴: 以 [HH:MM:SS] 开头的行占比超 50% → 跳过 (无意义)
    const logLines = text.split('\n').filter(l => /^\[\d{2}:\d{2}:\d{2}\]/.test(l.trim()));
    if (logLines.length && logLines.length / text.split('\n').length > 0.5) {
        // 从日志里抽最后一条有意义的提示 (通常是错误摘要)
        const lastHint = logLines[logLines.length - 1].replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '').replace(/^[\s\-]+|[\s\-]+$/g, '');
        if (lastHint && lastHint.length > 10)
            return `[日志] ${lastHint.slice(0, 60)}`;
        return null; // 纯日志, 不值得记
    }
    if (kind === 'user') {
        // 用户消息: 15-25 字核心 query, 砍掉所有寒暄修饰
        let s = text
            .replace(/^(帮我|请|请问|麻烦|能不能|可不可以|想知道|我想|我想问|能不能)\s*/, '')
            .replace(/^你\s*/, '')
            .replace(/(一下|看看|看下|又|再|重新)\s*/g, '')   // 砍冗余修饰词
            .replace(/[，,。？?！!\s]+$/, '')
            .trim();
        // 取第一句核心 query
        const first = s.split(/[。？?!！\n]/)[0].trim().replace(/[，,。？?！!]+$/, '');
        if (!first || first.length < 4) {
            // 第一句太短, 取整体
            return s.slice(0, 40) || text.slice(0, 40);
        }
        // 控制在 40 字以内
        if (first.length <= 40)
            return first;
        return first.slice(0, 40) + '...';
    }
    else if (kind === 'assistant') {
        // AI 回复: 砍所有思考过程, 抓 1-2 句结论 (总 ≤ 80 字)
        // _isPureThinking: 纯思考/套话判定; 注意有版本号/路径/结论动词的句子不砍
        const _isPureThinking = (s) => {
            if (/^(让我|我来|我将|我会|我需要|我们)\b/.test(s)) return true;
            if (/^(好的|明白了|收到|没问题|可以|行|是的|对|没错|确实)/.test(s)) return true;
            if (/^(这是|下面是|以下是|根据|由于|我理解)/.test(s)) return true;
            if (/使用.{0,10}(工具|search|web|搜索|查询|函数)/.test(s)) return true;
            // "我检索" 开头: 纯思考才砍; 有版本号/路径 → 保留 (有实质结论)
            if (/^我检索/.test(s)) return !/v?\d+\.\d+/.test(s) && !/[\/\\]/.test(s);
            return false;
        };
        const sentences = text
            .split(/[。！？\n]/)
            .flatMap(s => {
                // 超过 80 字的长句: 按逗号二次拆分 (核心信息被逗号连在一起的常见情况)
                if (s.length > 80) {
                    return s.split(/[，,]/);
                }
                return [s];
            })
            .map(s => s.trim())
            // 去掉列举词前缀 (逗号拆分后留下的 "例如"/"其中"/"包括" 等)
            .map(s => s.replace(/^(例如|其中|包括|如|像|比如|其中包括)\s*/, ''))
            .filter(s => s.length >= 6 && s.length <= 80)  // 太短太长都丢
            .filter(s => !_isPureThinking(s))                // 砍思考过程
            .filter(s => !/^\*+|^#|^```|^\d+\.\s/.test(s))  // 砍 markdown 列表标记
            .map(s => s.replace(/^\*+\s*/, '').replace(/^[\-]\s*/, ''));  // 去列表符号
        if (sentences.length === 0) {
            return null; // 全被过滤 → 纯套话, 跳过写入
        }
        // 评分: 优先有结论/有版本/有路径的句子, 长度作为次要因子
        const scored = sentences.map(s => {
            let score = 0;
            // 结论动词 (核心)
            if (/(是|有|可|需|应|返回|输出|结果|修复|改为|新增|支持|已|完成|解决|版本|更新|插件)/.test(s)) score += 25;
            // 含版本号加分 (含 v 前缀)
            if (/v?\d+\.\d+[\.\-_]?\d*/.test(s)) score += 20;
            // 含路径加分
            if (/[\.\w]+[\/\\][\w\/\\]+/.test(s)) score += 10;
            // 长度适中 (10-50 字) 小加分
            if (s.length >= 10 && s.length <= 50) score += 10;
            // 太短/太长小扣分
            if (s.length < 10) score -= 5;
            if (s.length > 60) score -= 5;
            return { s, score };
        });
        scored.sort((a, b) => b.score - a.score);
        // top1 评分 < 10: 全是过渡废话, 跳过写入
        if (scored[0].score < 10)
            return null;
        // 取前 2 句, 总 ≤ 80 字 (放宽)
        const picks = [];
        let totalLen = 0;
        for (const p of scored) {
            if (totalLen + p.s.length + 1 > 80) continue;
            picks.push(p.s);
            totalLen += p.s.length + 1;
            if (picks.length >= 2) break;
        }
        if (picks.length === 0) {
            const best = scored[0].s;
            return best.length > 80 ? best.slice(0, 80) + '...' : best;
        }
        return picks.join(' ');
    }
    return text.slice(0, 40);
}

/**
 * 自动记忆钩子：把 DSH 的会话事件（经统一的 session/event 分发）沉淀进祖宗记忆库。
 *
 * v2 升级: 写入前先用 ruleSummarize 生成精简 summary (零 LLM 成本), 同时记 user + assistant
 * (assistantMessage 默认开启)。autoRecall 按 type 分组注入, 优先用 summary。
 *
 * 与 DSH 的 session-persistence 插件（保存会话日志）不同，这里是"语义沉淀"：
 * 用户消息写入祖宗记忆库知识层（带去重与重要性），agent 回复与工具结果可选开启。
 * 只记忆真实用户消息（source.kind === 'user'），过滤插件注入的噪音。
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
    // P1 完善 (自动 recall 注入): 每次模型请求组装 system prompt 时, 注入祖宗记忆库记忆。
    // v2: 按 type 分组, 优先用 summary (精简概要) 而非原文。
    if (opts.autoRecall) {
        const recallLimit = Math.max(1, Math.min(10, opts.autoRecallLimit || 6));
        ctx.on('system-prompt/assemble', async (assembly, _ctx, next) => {
            try {
                // v2: 用 recall (空 query → 引擎自动优先有 summary 的条目)
                const r = await bridge.callTool('recall', {
                    query: '',
                    limit: recallLimit,
                });
                // recall 返回的是 JSON {query, results: [{display, type, ...}]}
                let payload = '';
                try {
                    const parsed = JSON.parse(extractText(r.content));
                    const results = parsed.results || [];
                    if (results.length > 0) {
                        // v2: 按 type 分组, 只用 display (优先 summary)
                        const byType = { user: [], assistant: [], other: [] };
                        for (const item of results) {
                            const key = (item.type === 'user' || item.type === 'assistant')
                                ? item.type
                                : 'other';
                            const text = item.display || item.summary || (item.content || '').slice(0, 80);
                            if (text)
                                byType[key].push(text);
                        }
                        const sections = [];
                        if (byType.user.length > 0)
                            sections.push(`【用户提问】\n${byType.user.map(t => `· ${t}`).join('\n')}`);
                        if (byType.assistant.length > 0)
                            sections.push(`【AI 回答】\n${byType.assistant.map(t => `· ${t}`).join('\n')}`);
                        if (byType.other.length > 0)
                            sections.push(`【其他记忆】\n${byType.other.map(t => `· ${t}`).join('\n')}`);
                        payload = sections.join('\n\n');
                    }
                }
                catch { /* JSON 解析失败 → 旧 fallback */ }
                if (payload) {
                    assembly.contexts.push({
                        name: 'zuzong:auto-recall',
                        text: `【祖宗记忆库 · 跨会话沉淀】\n${payload}`,
                    });
                }
            }
            catch { /* 静默: 召回失败不影响请求 */ }
            return next();
        });
    }
    ctx.on('session/event', (_session, event) => {
        if (event.type === 'user/message' && opts.userMessage) {
            // 只记真实用户输入 (kind='user'), 跳过插件注入/系统上下文
            if (event.data.source?.kind !== 'user') {
                ctx.logger.info(`dsh-memory: user/message 被滤 (source.kind=${event.data.source?.kind ?? 'undefined'})`);
                return;
            }
            const text = extractText(event.data.content);
            if (!text)
                return;
            const safe = sanitize(text);
            if (safe === null)
                return;
            // v2: 规则提炼精简 summary (可通过 useSummarize 关闭)
            let summary = null;
            if (opts.useSummarize) {
                summary = ruleSummarize(safe, 'user');
                if (summary === null)
                    return; // 纯日志, 不值得记
            }
            memorize('remember', {
                content: safe,
                summary: summary,
                type: 'user',
                importance: opts.importance,
                tags: ['dsh', 'user'],
            });
            // 语义召回预热
            memorize('recall', { query: (summary || safe).slice(0, 60), limit: 3 });
        }
        else if (event.type === 'assistant/message' && opts.assistantMessage) {
            const text = extractText(event.data.message.content);
            if (!text)
                return;
            const safe = sanitize(text);
            if (safe === null)
                return;
            // v2: 规则提炼精简 summary
            let summary = null;
            if (opts.useSummarize) {
                summary = ruleSummarize(safe, 'assistant');
                if (summary === null)
                    return;
            }
            memorize('remember', {
                content: safe,
                summary: summary,
                type: 'assistant',
                importance: opts.importance * 0.8,
                tags: ['dsh', 'assistant'],
            });
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
            // v2: 工具结果只取最后一行
            let summary = null;
            if (opts.useSummarize) {
                const lines = safe.split('\n').filter(l => l.trim());
                summary = (lines[lines.length - 1]?.slice(0, 80) || safe.slice(0, 80));
            }
            memorize('remember', {
                content: safe,
                summary: summary,
                type: 'raw',
                importance: opts.importance * 0.6,
                tags: ['dsh', 'tool'],
            });
        }
    });
}
