// DeepSeek Harness 插件 (宿主端): dsh-ollama
// 自动识别本机 Ollama 服务并接入 DSH, 让 WebUI 可以直接选择 Ollama 模型对话。
//
// 原理 (复用官方多 Provider 底座 dsh-llm-pi-ai, 不自己写适配器):
//   1) 启动后立即探测一次, 并按 detectIntervalMs 周期性探测 Ollama 原生接口
//      /api/tags (默认 http://localhost:11434), 拿到已安装模型名列表;
//   2) 探测到服务在线后, 通过 ctx.settings.mutate 把 providers.ollama 写进
//      llm-pi-ai 设置命名空间 (pi-ai 的 providers 配置节):
//          displayName = Ollama
//          api         = openai-completions (OpenAI 兼容协议, Ollama /v1 端点)
//          baseURL     = {baseUrl}/v1
//          models      = 从 /api/tags 拉到的模型列表 (带默认上下文/输出容量)
//   3) pi-ai 监听到设置变更后自动重新注册: 模型目录 (configurable providers) +
//      对话路由 (adapter routes) + 模型发现 (discovery),
//      WebUI 的 Models 设置页随即出现 Ollama 条目, 用户可以直接:
//          - 选择 Ollama 模型发起对话;
//          - 在 Models 页修改 baseURL / contextWindow / maxTokens 等参数;
//   4) 周期性刷新: Ollama 的模型有增删 (新 pull / 删除) 时, 自动同步 models 列表。
//
// 设置面板 (WebUI「设置 → Ollama 设置」):
//   - 客户端面板读写本插件的持久化配置, 经两个宿主端路由完成:
//       GET  /__dsh/ollama/config   -> 当前生效配置 + 连接状态 + 已接入标记
//       POST /__dsh/ollama/config   -> 校验并保存配置 + 立即按新配置重新接入
//   - 插件自身配置的持久化不依赖 settings 命名空间 (dsh-settings 仅存在于主
//     dsh 树、profile 树里解析不到, 且注册命名空间需额外 schema 依赖),
//     改存 DSH_HOME/ollama-config.json (与 dsh-media-background 同款做法)。
//     生效配置 = 默认值 + cordis.patch.yml 的 config + 面板保存的覆盖值 (最高优先)。
//
// 设计约定 (重要避坑):
//   - 不修改任何官方文件/包;
//   - 不自己调用 ctx.llm.registerAdapter / registerModelDiscovery:
//     registerAdapter 对 provider 路由是排他的, registerModelDiscovery 每个
//     namespace 只能有一个, 直接注册会与 pi-ai 冲突; 正确做法是只写 pi-ai 的
//     providers 配置, 由 pi-ai 统一注册路由与模型发现;
//   - 已存在的 Ollama provider 条目: 周期探测只做有限补齐/同步 (且仅当 baseURL
//     未被我方接管时), 不覆盖用户在 Models 页手改的 displayName / api / baseURL /
//     模型参数, 尊重用户改动; 只有面板保存时 force 全量重写 (保留已有模型的手改参数);
//   - Ollama 无需真实 API Key, 因此不写 apiKeyEnv (否则 pi-ai 会因缺凭据报
//     MISSING_CREDENTIAL)。但 pi-ai 的 openai-completions 协议要求请求必须带
//     apiKey 或 authorization 头才放行 (否则报 "No API key for provider"),
//     而 Ollama 不校验该头, 因此在 provider 配置里补一个占位 Authorization 头
//     (值见 authorizationHeader 配置项), 由 pi-ai 原样透传即可。
//
// 零原生依赖、零构建。探测用 Node 全局 fetch (运行时 Node >= 18, 本项目 v22)。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const name = "dsh-ollama";

// 需要服务端 webServer 注册设置路由; settings 是可选服务, 用 ctx.inject 动态
// 获取 (与官方插件一致), 避免在 settings 缺失时把整个 profile 拖垮。
const inject = ["webServer"];

// pi-ai 已注册的设置命名空间 (settingsNamespace("llm-pi-ai"))。
// 所有 providers.* 配置都写在这个节里, pi-ai 会把它们注册为可配置 provider。
const PI_AI_NAMESPACE = "llm-pi-ai";

// 本插件要接入的 provider 标识 (写入 providers.<id>)。
const OLLAMA_PROVIDER_ID = "ollama";

// provider 在 pi-ai 设置节里的路径前缀。
const PROVIDER_PATH = ["providers", OLLAMA_PROVIDER_ID];

// llm-pi-ai 命名空间注册好之前的最大重试次数与间隔 (ms)。
// pi-ai 由 dsh-base 最先加载, 但 settings 注入是异步的, 用重试避免竞态。
const NAMESPACE_RETRIES = 20;
const NAMESPACE_RETRY_DELAY_MS = 500;

// 探测循环的调度粒度: 每 5s 检查一次"距上次探测是否已超过 detectIntervalMs"。
// 这样用户在面板里改探测间隔无需重启服务即可生效。
const LOOP_TICK_MS = 5000;

// 设置路由 (客户端面板用, 均要求自定义头 X-DSH-Ollama: 1 防跨站)。
const ROUTE_CONFIG = "/__dsh/ollama/config";
const GUARD_HEADER = "x-dsh-ollama";

// 默认配置; 用户可在 cordis.patch.yml 的 config 里覆盖, 也可在 WebUI
// 「设置 → Ollama 设置」面板里修改并持久化 (持久化覆盖优先于 cordis config)。
const DEFAULT_CONFIG = {
	// 是否启用自动识别
	enabled: true,
	// Ollama 服务根地址 (不含 /v1)
	baseUrl: "http://localhost:11434",
	// 在 Models 页显示的提供方名称
	displayName: "Ollama",
	// 模型发现不到 contextWindow / maxTokens 时使用的默认值
	defaultContextWindow: 32768,
	defaultMaxTokens: 8192,
	// 发送给 Ollama 的 Authorization 头。pi-ai 的 openai-completions 协议要求
	// 请求必须带 apiKey 或 authorization 头才会放行 (否则报 No API key for
	// provider), 而 Ollama 对该头不校验、值可任意, 因此这里补一个占位头。
	// 留空字符串表示不发该头 (适合走自定义网关/中间件的高级用户)。
	authorizationHeader: "Bearer ollama-local",
	// 周期性探测间隔 (毫秒)
	detectIntervalMs: 60000,
	// 单次探测超时 (毫秒)
	probeTimeoutMs: 3000,
};

// ---- 小工具 ----

/** 让出当前事件循环一段时间 (返回一个 Promise)。 */
function sleep(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** DSH_HOME (绿色版为 runtime/dsh-home)。 */
function dshHome() {
	return process.env.DSH_HOME || join(homedir(), ".dsh");
}

/** 插件自身配置的持久化文件路径。 */
function configFilePath() {
	return join(dshHome(), "ollama-config.json");
}

/**
 * 读取面板持久化的配置覆盖值。文件不存在 / 损坏一律返回空对象。
 * @returns {object} 覆盖值对象 (键 ⊆ DEFAULT_CONFIG)
 */
function readOverrides() {
	try {
		const raw = readFileSync(configFilePath(), "utf8");
		const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw; // 去 UTF-8 BOM
		const data = JSON.parse(text);
		return (data !== null && typeof data === "object") ? data : {};
	} catch {
		return {};
	}
}

/**
 * 写入面板持久化的配置覆盖值 (原子性: 先写临时文件再 rename 不可靠跨平台,
 * 直接覆盖即可, 文件很小)。
 * @param {object} overrides - 要持久化的覆盖值
 * @param {Function} logger - 日志函数集
 */
function writeOverrides(overrides, logger) {
	try {
		mkdirSync(dshHome(), { recursive: true });
		writeFileSync(configFilePath(), JSON.stringify(overrides, null, 2) + "\n", "utf8");
	} catch (error) {
		logger.warn("[dsh-ollama] 保存配置失败: %s",
			error && error.message ? error.message : error);
	}
}

/**
 * 计算当前生效配置: 默认值 + cordis config (entry) + 面板持久化覆盖 (最高优先)。
 * @param {object} entry - cordis.patch.yml 里 config 的原始对象
 * @returns {object} 合并后的生效配置 (键 ⊆ DEFAULT_CONFIG)
 */
function resolveEffectiveSettings(entry) {
	const overrides = readOverrides();
	const merged = {};
	for (const key of Object.keys(DEFAULT_CONFIG)) {
		if (key in overrides && overrides[key] !== undefined) {
			merged[key] = overrides[key];
		} else if (key in entry && entry[key] !== undefined) {
			merged[key] = entry[key];
		} else {
			merged[key] = DEFAULT_CONFIG[key];
		}
	}
	return merged;
}

/**
 * 探测 Ollama 服务并返回已安装模型名列表。
 * 探测端点: GET {baseUrl}/api/tags (Ollama 原生接口, 返回 { models: [{ name }] })。
 * 连不上 / 超时 / 返回异常 一律视为"未检测到", 返回 null。
 * @param {string} baseUrl - Ollama 根地址, 如 http://localhost:11434
 * @param {number} timeoutMs - 单次探测超时毫秒数
 * @returns {Promise<Array<string> | null>} 模型名数组; 未检测到时为 null
 */
async function probeOllamaModels(baseUrl, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const endpoint = baseUrl.replace(/\/+$/, "") + "/api/tags";
		const response = await fetch(endpoint, { signal: controller.signal });
		if (!response.ok) return null;
		const body = await response.json();
		const entries = Array.isArray(body && body.models) ? body.models : [];
		const modelNames = [];
		for (const entry of entries) {
			if (typeof entry.name === "string" && entry.name.length > 0) {
				modelNames.push(entry.name);
			}
		}
		return modelNames;
	} catch {
		// 连接失败 / 超时 (AbortError) / 非 JSON 响应, 都当作未检测到
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 构建写入 llm-pi-ai 的 Ollama provider 配置对象。
 * @param {object} settings - 合并后的插件配置
 * @param {Array<string>} modelNames - 从 /api/tags 拿到的模型名
 * @returns {object} pi-ai profile 对象 (displayName / api / baseURL / models)
 */
function buildProviderProfile(settings, modelNames) {
	const models = modelNames.map((modelId) => ({
		id: modelId,
		name: modelId,
		contextWindow: settings.defaultContextWindow,
		maxTokens: settings.defaultMaxTokens,
	}));
	// 占位 Authorization 头: pi-ai 的 openai-completions 协议校验
	// getClientApiKey() 时, 没有 apiKey 也没有 authorization 头会直接抛
	// "No API key for provider", 而 Ollama 不校验该头, 因此补一个占位值。
	const authorization = settings.authorizationHeader;
	// Ollama 的 OpenAI 兼容层不说 OpenAI 官方方言: 不认 developer 角色 /
	// max_completion_tokens / strict 工具字段。不配 compat 时 pi-ai 按
	// OpenAI 官方协议发送 (developer 角色承载 system、max_completion_tokens
	// 写输出上限、工具带 strict), Ollama 会丢弃/拒绝, 导致工具 schema 到
	// 不了模型 → 模型从不调用 DSH 工具。这套开关让 pi-ai 改用 Ollama
	// 认识的方式: system 角色、max_tokens 字段、不带 strict 的工具。
	const ollamaCompat = {
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens",
		supportsStrictMode: false,
	};
	return {
		displayName: settings.displayName,
		api: "openai-completions",
		baseURL: settings.baseUrl.replace(/\/+$/, "") + "/v1",
		compat: ollamaCompat,
		...authorization ? { headers: { Authorization: authorization } } : {},
		...models.length > 0 ? { models } : {},
	};
}

/**
 * 比较两个模型列表是否等价 (只比 id + contextWindow + maxTokens, 忽略顺序)。
 * @param {Array<object> | undefined} previousModels - 当前已存的 models 列表
 * @param {Array<object> | undefined} nextModels - 要写入的 models 列表
 * @returns {boolean} true 表示等价, 无需写入
 */
function modelsEquivalent(previousModels, nextModels) {
	const signature = (models) => (models || [])
		.map((model) => model.id + "|" + model.contextWindow + "|" + model.maxTokens)
		.sort()
		.join(",");
	return signature(previousModels) === signature(nextModels);
}

/**
 * 合并模型列表: 已存在的模型保留其手改的 contextWindow / maxTokens (以旧列表为准),
 * 只对新增模型套用默认容量。force 重写时用于不丢失用户在 Models 页的手改。
 * @param {Array<object> | undefined} previousModels - 当前已存的 models 列表
 * @param {Array<object> | undefined} nextModels - 探测到的新模型列表
 * @returns {Array<object>} 合并后的模型列表
 */
function mergeModelParams(previousModels, nextModels) {
	const previousMap = new Map();
	for (const model of (previousModels || [])) {
		if (model && typeof model.id === "string") previousMap.set(model.id, model);
	}
	return (nextModels || []).map((model) => {
		const previous = previousMap.get(model.id);
		if (previous === undefined) return model;
		return {
			id: model.id,
			name: model.name || previous.name || model.id,
			contextWindow: previous.contextWindow !== undefined ? previous.contextWindow : model.contextWindow,
			maxTokens: previous.maxTokens !== undefined ? previous.maxTokens : model.maxTokens,
		};
	});
}

/**
 * 把 Ollama provider 写入 llm-pi-ai 设置节。
 * 周期探测 (force=false) 规则:
 *   - 该 provider 尚不存在: 写全量 profile (自动接入);
 *   - 已存在且 baseURL 与我方一致 (或未设置): 只在模型列表变化时同步 models,
 *     不覆盖用户手改的其他字段;
 *   - 已存在但 baseURL 被用户改成了别的地址: 视为用户外部管理, 不打扰。
 * 面板保存 (force=true) 规则: 全量重写 displayName / api / baseURL / headers,
 * 模型列表用 mergeModelParams 保留已存在模型的手改参数, 由面板保存主动触发。
 * @param {object} sctx - ctx.inject(["settings"]) 注入的上下文
 * @param {object} settings - 合并后的插件配置
 * @param {object} profile - 要写入的 provider 配置
 * @param {Function} logger - 日志函数集 (ctx.logger)
 * @param {object} options - 可选 { force: boolean }
 */
async function applyOllamaProfile(sctx, settings, profile, logger, options) {
	const resolved = sctx.settings.get(PI_AI_NAMESPACE);
	const currentProfile = resolved && resolved.providers
		? resolved.providers[OLLAMA_PROVIDER_ID]
		: undefined;
	const force = Boolean(options && options.force);
	if (currentProfile === undefined || force) {
		// 首次接入 或 面板保存强制重写: 全量写入
		const mergedModels = force && Array.isArray(currentProfile && currentProfile.models)
			? mergeModelParams(currentProfile.models, profile.models || [])
			: (profile.models || []);
		const ops = [
			{ op: "set", path: [...PROVIDER_PATH, "displayName"], value: profile.displayName },
			{ op: "set", path: [...PROVIDER_PATH, "api"], value: profile.api },
			{ op: "set", path: [...PROVIDER_PATH, "baseURL"], value: profile.baseURL },
			{ op: "set", path: [...PROVIDER_PATH, "compat"], value: profile.compat },
		];
		if (profile.headers) {
			ops.push({ op: "set", path: [...PROVIDER_PATH, "headers"], value: profile.headers });
		} else {
			ops.push({ op: "remove", path: [...PROVIDER_PATH, "headers"] });
		}
		if (mergedModels.length > 0) {
			ops.push({ op: "set", path: [...PROVIDER_PATH, "models"], value: mergedModels });
		}
		await sctx.settings.mutate(PI_AI_NAMESPACE, ops);
		logger.info("[dsh-ollama] 检测到 Ollama 服务, 已自动接入 provider (模型数: %d, force=%s)",
			mergedModels.length, force ? "yes" : "no");
		return;
	}
	// 已存在: 尊重用户改动, 只做有限的补齐/同步
	const baseURLMatches = currentProfile.baseURL === undefined
		|| currentProfile.baseURL === profile.baseURL;
	if (!baseURLMatches) return;
	const ops = [];
	// 补齐旧版本 / 手动创建时缺失的必需字段: pi-ai 的 openai-completions 协议
	// 要求 api 与 authorization 头, 缺失时请求会报 "No API key for provider"。
	// 仅在字段缺失时补齐, 不覆盖用户已填写的值。
	if (currentProfile.api === undefined && profile.api !== undefined) {
		ops.push({ op: "set", path: [...PROVIDER_PATH, "api"], value: profile.api });
	}
	if (currentProfile.compat === undefined && profile.compat !== undefined) {
		ops.push({ op: "set", path: [...PROVIDER_PATH, "compat"], value: profile.compat });
	}
	if (currentProfile.headers === undefined && profile.headers !== undefined) {
		ops.push({ op: "set", path: [...PROVIDER_PATH, "headers"], value: profile.headers });
	}
	if (!modelsEquivalent(currentProfile.models, profile.models)) {
		ops.push({ op: "set", path: [...PROVIDER_PATH, "models"], value: profile.models || [] });
	}
	if (ops.length === 0) return;
	await sctx.settings.mutate(PI_AI_NAMESPACE, ops);
	logger.info("[dsh-ollama] Ollama 配置已补齐/模型列表已同步 (模型数: %d)",
		profile.models ? profile.models.length : 0);
}

/**
 * 探测结果状态 (模块级, 供设置面板 GET 查询)。
 * @type {{ online: boolean, models: string[], checkedAt: number, lastError: string | null }}
 */
const status = { online: false, models: [], checkedAt: 0, lastError: null };

/**
 * 执行一次完整的"探测 + 接入"流程, 并刷新 status。
 * 返回 true 表示本次流程完成 (无论是否写入了新配置); false 表示未检测到服务。
 * @param {object} sctx - ctx.inject(["settings"]) 注入的上下文
 * @param {object} settings - 合并后的插件配置
 * @param {Function} logger - 日志函数集 (ctx.logger)
 * @param {object} options - 可选 { force: boolean } (面板保存时传 true)
 * @returns {Promise<boolean>}
 */
async function runDetection(sctx, settings, logger, options) {
	const modelNames = await probeOllamaModels(settings.baseUrl, settings.probeTimeoutMs);
	status.checkedAt = Date.now();
	if (modelNames === null) {
		// 未检测到服务: 刷新状态后静默跳过, 等待下一轮 (不反复打日志)
		status.online = false;
		status.models = [];
		status.lastError = "无法连接 Ollama 服务 (" + settings.baseUrl + ")";
		return false;
	}
	status.online = true;
	status.models = modelNames;
	status.lastError = null;
	const profile = buildProviderProfile(settings, modelNames);
	let lastError = null;
	for (let attempt = 0; attempt < NAMESPACE_RETRIES; attempt++) {
		try {
			await applyOllamaProfile(sctx, settings, profile, logger, options);
			return true;
		} catch (error) {
			lastError = error;
			const message = error && error.message ? error.message : String(error);
			if (!message.includes("not registered")) throw error;
			// llm-pi-ai 命名空间还没注册好, 稍等再试
			await sleep(NAMESPACE_RETRY_DELAY_MS);
		}
	}
	throw lastError;
}

/**
 * 启动探测循环: 立即探测一次, 之后每 LOOP_TICK_MS 检查一次距上次探测是否
 * 已超过 detectIntervalMs (面板改探测间隔无需重启即生效)。
 * @param {object} sctx - ctx.inject(["settings"]) 注入的上下文
 * @param {object} entry - cordis.patch.yml 里 config 的原始对象
 * @param {Function} logger - 日志函数集 (ctx.logger)
 */
function startDetectionLoop(sctx, entry, logger) {
	let lastRunAt = 0;
	const scheduleRun = () => {
		const effective = resolveEffectiveSettings(entry);
		if (!effective.enabled) return; // 面板关闭了自动识别: 跳过 (保留已接入的 provider)
		if (Date.now() - lastRunAt < effective.detectIntervalMs) return;
		lastRunAt = Date.now();
		runDetection(sctx, effective, logger, {}).catch((error) => {
			logger.warn("[dsh-ollama] Ollama 接入失败: %s",
				error && error.message ? error.message : error);
		});
	};
	// 立即探测一次
	scheduleRun();
	// 周期调度
	const timer = setInterval(scheduleRun, LOOP_TICK_MS);
	// 随本插件的 fiber 释放时清理定时器
	sctx.effect(() => () => clearInterval(timer));
}

/** 校验面板提交的配置覆盖值; 返回 { ok, overrides?, errors? }。 */
function sanitizeOverrides(body) {
	if (body === null || typeof body !== "object") {
		return { ok: false, errors: ["请求体不是 JSON 对象"] };
	}
	const overrides = {};
	const errors = [];
	const intField = (key, minValue, label) => {
		const value = body[key];
		if (value === undefined) return;
		const numberValue = Number(value);
		if (!Number.isInteger(numberValue) || numberValue < minValue) {
			errors.push(label + " 必须是大于等于 " + minValue + " 的整数");
			return;
		}
		overrides[key] = numberValue;
	};
	if (body.enabled !== undefined) {
		if (typeof body.enabled !== "boolean") errors.push("启用开关必须是布尔值");
		else overrides.enabled = body.enabled;
	}
	if (body.baseUrl !== undefined) {
		if (typeof body.baseUrl !== "string" || !/^https?:\/\/.+/.test(body.baseUrl.trim())) {
			errors.push("Ollama 服务地址必须以 http:// 或 https:// 开头");
		} else {
			overrides.baseUrl = body.baseUrl.trim().replace(/\/+$/, "");
		}
	}
	if (body.displayName !== undefined) {
		const displayName = String(body.displayName).trim();
		if (displayName.length === 0) errors.push("显示名称不能为空");
		else overrides.displayName = displayName;
	}
	intField("defaultContextWindow", 1, "默认上下文窗口");
	intField("defaultMaxTokens", 1, "默认最大输出");
	intField("detectIntervalMs", 1000, "探测间隔");
	intField("probeTimeoutMs", 200, "探测超时");
	if (body.authorizationHeader !== undefined) {
		if (typeof body.authorizationHeader !== "string") errors.push("授权请求头必须是字符串");
		else overrides.authorizationHeader = body.authorizationHeader;
	}
	if (errors.length > 0) return { ok: false, errors };
	return { ok: true, overrides };
}

/**
 * 注册设置面板用的路由。注意: WebServer 的路由模型只有 kind / path / handler,
 * 没有 method 字段 —— 同一个 path 只能注册一次, 否则重复注册会抛
 * "Duplicate (kind, path)" 错误, 导致整个插件 fiber 回滚、所有路由失效 (404)。
 * 因此 GET / POST 合并进同一个 handler, 按 req.method 分流, 均要求自定义头防跨站:
 *   GET  /__dsh/ollama/config   -> { ok, config, status, providerWritten }
 *   POST /__dsh/ollama/config   -> 保存配置 + 按新配置立即接入, 返回同样结构 + saved
 * @param {object} sctx - ctx.inject(["settings"]) 注入的上下文
 * @param {object} entry - cordis.patch.yml 里 config 的原始对象
 * @param {Function} logger - 日志函数集 (ctx.logger)
 */
function registerRoutes(sctx, entry, logger) {
	const configPayload = () => {
		const effective = resolveEffectiveSettings(entry);
		const resolved = sctx.settings.get(PI_AI_NAMESPACE);
		const provider = resolved && resolved.providers
			? resolved.providers[OLLAMA_PROVIDER_ID]
			: undefined;
		return {
			ok: true,
			config: effective,
			status: {
				online: status.online,
				models: status.models,
				checkedAt: status.checkedAt,
				lastError: status.lastError,
			},
			providerWritten: provider !== undefined,
		};
	};

	sctx.effect(() => sctx.webServer.register({
		kind: "exact",
		path: ROUTE_CONFIG,
		handler: async (req, res) => {
			if (req.headers[GUARD_HEADER] !== "1") {
				res.writeHead(403);
				res.end();
				return;
			}
			// POST: 保存配置 + 立即按新配置重新探测接入
			if (req.method === "POST") {
				const send = (statusCode, payload) => {
					res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify(payload));
				};
				let body = null;
				try {
					const chunks = [];
					for await (const chunk of req) chunks.push(chunk);
					const raw = Buffer.concat(chunks).toString("utf8");
					body = raw.length > 0 ? JSON.parse(raw) : {};
				} catch {
					send(400, { ok: false, error: "请求体不是合法 JSON" });
					return;
				}
				const sanitized = sanitizeOverrides(body);
				if (!sanitized.ok) {
					send(400, { ok: false, error: sanitized.errors.join("; ") });
					return;
				}
				writeOverrides(sanitized.overrides, logger);
				logger.info("[dsh-ollama] 设置已保存: %j", sanitized.overrides);
				const effective = resolveEffectiveSettings(entry);
				try {
					await runDetection(sctx, effective, logger, { force: true });
				} catch (error) {
					send(200, { ...configPayload(), saved: true,
						error: "保存成功但按新配置接入失败: " + ((error && error.message) || error) });
					return;
				}
				send(200, { ...configPayload(), saved: true });
				return;
			}
			// 其余方法 (GET): 返回当前生效配置 + 连接状态
			const payload = configPayload();
			res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify(payload));
		}
	}), name + ": config route");
}

/**
 * 插件入口。启动时注册设置路由 + 探测循环。
 * @param {object} ctx - cordis 宿主上下文
 * @param {object} config - cordis 入口配置 (cordis.patch.yml 里的 config)
 */
function apply(ctx, config) {
	const logger = ctx.logger;
	const entry = config || {};
	const initial = resolveEffectiveSettings(entry);
	if (!initial.enabled) {
		logger.info("[dsh-ollama] 自动识别已关闭 (enabled=false), 跳过 Ollama 接入 (可在 WebUI 设置面板开启)。");
		return;
	}
	ctx.inject(["settings"], (sctx) => {
		startDetectionLoop(sctx, entry, logger);
		registerRoutes(sctx, entry, logger);
	});
}

export { apply, inject, name };
