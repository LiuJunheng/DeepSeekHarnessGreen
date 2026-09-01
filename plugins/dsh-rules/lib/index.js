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
 * 配置 (cordis.yml):
 *   dsh-rules:
 *     enabled: true              # 总开关
 *     rulesPath: ''              # 空=默认 ${DSH_HOME}/rules/user-rules.md
 *     autoReload: true           # 文件变化自动重载 (fs.watch + 2s 缓存)
 *     weight: 0.9                # 注入权重 (越高越优先)
 *     headerLabel: '【用户规则】' # 注入到 prompt 里的标题
 *     failSilently: true         # 读文件失败时静默 (不报错)
 */
import z from '@deepseek-ai/schemastery';
import { existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { installRulesHooks } from './hooks.js';

export const name = 'dsh-rules';

/** 本插件不依赖其他服务 (纯 system-prompt hook)。 */
export const inject = [];

/**
 * 插件配置 schema (用 DSH 自带的 schemastery 校验)。
 * 全部字段都有默认值, 用户不写 cordis.yml 也能工作。
 */
export const Config = z.object({
    /** 总开关: false 时不安装任何钩子 (插件等于没装)。 */
    enabled: z.boolean().default(true),
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
    // 1. 解析规则文件路径
    const dshHome = resolveDshHome();
    const rulesPath = config.rulesPath || join(dshHome, 'rules', 'user-rules.md');

    // 2. 确保规则文件存在 (首次安装自动创建)
    ensureRulesFile(rulesPath);

    // 3. 禁用模式 → 不装钩子 (相当于没装这个插件)
    if (!config.enabled) {
        ctx.logger.info('dsh-rules: disabled by config, skipping hook installation');
        return;
    }

    // 4. 安装 system-prompt/assemble 钩子
    installRulesHooks(ctx, {
        rulesPath,
        config,
    });

    ctx.logger.info(`dsh-rules: ready, rules file = ${rulesPath}`);
}
