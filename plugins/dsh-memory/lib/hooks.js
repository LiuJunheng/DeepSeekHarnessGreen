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
/** 安装自动记忆钩子 (effect 作用域内, 随插件卸载自动移除)。
 *
 * v5 (实时生效): 无论 autoRemember / autoRecall 是什么状态都注册 hook ——
 * 两个开关动态变化时, 通过 isAutoRemember() / isAutoRecall() 闭包在 callback 内懒读最新值,
 * 下次请求立即生效, 不用重启。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Cordis 上下文
 * @param {import('../engine/zuzong_memory').ZuzongBridge} bridge - 祖宗记忆库 bridge
 * @param {object} opts
 * @param {() => boolean} opts.isAutoRemember - 实时 autoRemember 读取器
 * @param {() => boolean} opts.isAutoRecall    - 实时 autoRecall 读取器
 * @param {number} opts.autoRecallLimit        - recall 条数 (1-10)
 * @param {boolean} opts.desensitize           - 是否脱敏
 * @param {boolean} opts.userMessage           - 是否记用户消息
 * @param {boolean} opts.assistantMessage      - 是否记 AI 回复
 * @param {boolean} opts.toolResult            - 是否记工具结果
 * @param {boolean} opts.useSummarize          - 是否规则提炼 summary
 * @param {number} opts.importance             - 重要性权重
 */
export function installMemoryHooks(ctx, bridge, opts) {
    const memorize = (tool, args) => {
        void bridge
            .callTool(tool, args)
            .catch((err) => ctx.logger.warn(`dsh-memory: ${tool} 自动记忆失败: ${err.message}`));
    };
    const sanitize = (text) => {
        if (!opts.desensitize)
            return text;
        return desensitize(text);
    };
    const recallLimit = Math.max(1, Math.min(10, opts.autoRecallLimit || 6));

    // v3: 闭包维护当前 session 的 id / cwd —— session/event 钩子更新, system-prompt/assemble 读取
    // 这样避免了 system-prompt/assemble 的 _ctx 不是 session 对象的问题
    let currentSessionId = null;
    let currentSessionCwd = null;

    // --- 自动召回: system-prompt/assemble (总是注册, 内部懒读 autoRecall) ---
    ctx.on('system-prompt/assemble', async (assembly, _ctx, next) => {
        try {
            // v5: 懒读 autoRecall —— WebUI 改开关后下次请求立即生效
            if (!opts.isAutoRecall || !opts.isAutoRecall()) {
                return next();
            }
            // v3: 优先用 timeline 传当前 session_id, recall 作为 fallback
            // 注意: 这里读的是 session/event 钩子维护的闭包变量 currentSessionId
            let r;
            if (currentSessionId) {
                try {
                    r = await bridge.callTool('timeline', {
                        limit: recallLimit,
                        session_id: currentSessionId,  // v3: 当前会话优先
                    });
                }
                catch { /* timeline 不存在 (旧引擎), fallback 到 recall */ }
            }
            if (!r) {
                r = await bridge.callTool('recall', {
                    query: '',
                    limit: recallLimit,
                });
            }
            // recall / timeline 返回的都是 JSON, 统一按 "有 results 数组" 处理
            let payload = '';
            try {
                const parsed = JSON.parse(extractText(r.content));
                const results = parsed.results || [];
                if (results.length > 0) {
                    // v3: 区分 [当前会话] / [全局] 来源标注
                    const sessionLabel = '【当前会话】';
                    const globalLabel = '【全局记忆】';
                    const sessionItems = [];
                    const globalItems = [];
                    for (const item of results) {
                        const text = item.display || item.summary || (item.content || '').slice(0, 80);
                        if (!text) continue;
                        const itemSid = item.session_id || null;
                        if (currentSessionId && itemSid === currentSessionId) {
                            sessionItems.push(text);
                        } else {
                            globalItems.push(text);
                        }
                    }
                    const sections = [];
                    if (sessionItems.length > 0)
                        sections.push(`${sessionLabel}\n${sessionItems.map(t => `· ${t}`).join('\n')}`);
                    if (globalItems.length > 0)
                        sections.push(`${globalLabel}\n${globalItems.map(t => `· ${t}`).join('\n')}`);
                    payload = sections.join('\n\n');
                }
            }
            catch { /* JSON 解析失败 → 静默 */ }
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
    // --- 自动记录: session/event → 写入记忆库 (总是注册, 内部懒读 autoRemember) ---
    ctx.on('session/event', (_session, event) => {
        // v3: 更新当前 session 上下文 (供 system-prompt/assemble 钩子读取)
        if (_session) {
            currentSessionId = _session.id || null;
            currentSessionCwd = _session.header?.cwd || null;
        }
        // v5: 懒读 autoRemember —— WebUI 改开关后下次事件立即生效
        if (!opts.isAutoRemember || !opts.isAutoRemember()) {
            return;
        }
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
                content: (summary || safe),   // v3: content 也存精简版, 省空间
                summary: summary,
                type: 'user',
                importance: opts.importance,
                tags: ['dsh', 'user'],
                // v3: 会话隔离 — 从当前 Session 对象取 id 和 cwd
                session_id: _session?.id || null,
                cwd: _session?.header?.cwd || null,
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
                content: (summary || safe),   // v3: content 也存精简版, 省空间
                summary: summary,
                type: 'assistant',
                importance: opts.importance * 0.8,
                tags: ['dsh', 'assistant'],
                // v3: 会话隔离 — 从当前 Session 对象取 id 和 cwd
                session_id: _session?.id || null,
                cwd: _session?.header?.cwd || null,
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
                content: (summary || safe),   // v3: content 也存精简版, 省空间
                summary: summary,
                type: 'raw',
                importance: opts.importance * 0.6,
                tags: ['dsh', 'tool'],
            });
        }
    });
}
