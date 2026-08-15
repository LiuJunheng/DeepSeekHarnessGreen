// apply-agentloop-guard.mjs — 重新应用 dsh-agent-loop 工具运行时守卫补丁
// 用途: DSH 更新(npm 重装)后, node_modules 里的补丁会被覆盖; 运行本脚本可一键重打。
// 用法: node apply-agentloop-guard.mjs
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const file = join(dirname(fileURLToPath(import.meta.url)), "node_modules", "@deepseek-ai", "dsh-agent-loop", "lib", "index.js");
const MARKER = "[dsh-tools-guard]";

if (!existsSync(file)) {
	console.error("找不到 " + file);
	process.exit(1);
}
const text = readFileSync(file, "utf8");
if (text.includes(MARKER)) {
	console.log("补丁已存在, 无需重复应用: " + file);
	process.exit(0);
}

const anchor = `async function executeToolCalls(ctx, turn, step, toolCalls, signal, acceptContext) {
	const agent = ctx.agents.requireInitiator();
	const { session } = agent;
	const planned = toolCalls.map((block) => ({`;

const guard = `async function executeToolCalls(ctx, turn, step, toolCalls, signal, acceptContext) {
	const agent = ctx.agents.requireInitiator();
	const { session } = agent;
	// [dsh-tools-guard] 工具运行时可用性守卫 (诊断用补丁):
	// 当插件树被运行中的安装/卸载/开关操作破坏, 或 @deepseek-ai/dsh-tools 模块被
	// 重复加载(profile 插件依赖树里存在第二份副本, 导致 TOOL_RUNTIME_SCHEDULER
	// Symbol 键不匹配)时, ctx.tools 可能缺失或缺少工具调度器 —— 原代码会抛晦涩的
	// "Cannot read properties of undefined (reading 'prepare'/'executionMode')"。
	// 这里在派发阶段入口提前检查并抛出可诊断的错误, 让失败回合直接显示原因。
	const tools = ctx.tools;
	const scheduler = tools === void 0 || tools === null ? void 0 : tools[TOOL_RUNTIME_SCHEDULER];
	if (scheduler === void 0 || typeof scheduler.prepare !== "function") {
		const detail = tools === void 0 || tools === null
			? "ctx.tools 服务缺失 (tools 服务未挂载)"
			: "ctx.tools 存在但缺少工具调度器 (TOOL_RUNTIME_SCHEDULER) —— 最常见原因: @deepseek-ai/dsh-tools 模块被重复加载(profile 插件依赖树里存在第二份副本, Symbol 键不匹配), 或插件树被运行中的安装/卸载/开关操作破坏";
		const guardError = new Error("[dsh-tools-guard] 工具运行时不可用: " + detail + "。请重启 DSH 服务后再试。");
		guardError.name = "ToolRuntimeUnavailableError";
		throw guardError;
	}
	const planned = toolCalls.map((block) => ({`;

if (!text.includes(anchor)) {
	console.error("锚点未找到 —— dsh 版本升级可能改变了代码结构, 请手动处理或更新本脚本。");
	process.exit(1);
}
const bak = file + ".bak-tools-guard";
copyFileSync(file, bak);
writeFileSync(file, text.replace(anchor, guard));
console.log("补丁已应用 (备份: " + bak + ")。重启 DSH 服务后生效。");
