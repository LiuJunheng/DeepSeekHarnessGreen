# dsh-ollama

自动识别本机 Ollama 服务并接入 DSH 的宿主端插件。

## 功能

- 启动后立即探测 Ollama 原生接口 `/api/tags`（默认 `http://localhost:11434`），并按 `detectIntervalMs` 周期刷新；
- 探测到服务在线后，自动把 Ollama 注册为 OpenAI 兼容 Provider（写入 `llm-pi-ai` 的 `providers.ollama` 配置）：
  - `api = openai-completions`（Ollama `/v1` 端点）
  - `baseURL = {baseUrl}/v1`
  - `models` = 从 `/api/tags` 拉到的模型列表（含 `contextWindow` / `maxTokens`）
  - `compat` = Ollama 兼容开关（`supportsDeveloperRole: false` / `supportsReasoningEffort: true` / `maxTokensField: max_tokens` / `supportsStrictMode: false`），**保证 pi-ai 用 Ollama 认识的方言发请求，工具（Tool Calling）才能送达模型并被执行**——缺它时 Ollama 接入后模型从不调用 DSH 工具；`supportsReasoningEffort: true` 是**思考控制**关键（见下）：pi-ai 才会发送 `reasoning_effort`，配合模型 `reasoningEfforts.off="none"` 默认关思考，token 全部留给工具调用；
  - **自动上下文容量修复**（`ensureContext`，默认开）：探测到容量不足的模型时，自动用 Modelfile 固化 `num_ctx` 并创建 `"<原名>-32k"` 变体，`models` 自动指向变体——否则 DSH 工具 schema 被截断、模型从不调用工具 + 报 token 上限；
- WebUI **Models 设置页**随即出现 Ollama 条目，可直接选择模型对话，也可修改 baseURL / contextWindow / maxTokens 等参数；
- Ollama 模型有增删（新 pull / 删除）时自动同步 `models` 列表。
- WebUI「设置 → Ollama 设置」面板提供**「一键接入」按钮**（2026-08-27 新增）：当自动探测没能在更新/启动后把模型配置好时（如 Ollama 启动晚于 DSH、或 provider 列表停在旧状态），点一下即**立即**按当前生效配置强制重新探测 ` /api/tags`、必要时补建 `-32k` 上下文变体，并把 `providers.ollama`（含全部模型）全量重写到 llm-pi-ai；不保存表单、不改动已持久化的面板配置，结束即刷新连接状态 / 模型列表 / 已接入标记。

## 设计要点 / 避坑

- 不修改任何官方文件/包；零原生依赖、零构建。
- **不自己调用 `ctx.llm.registerAdapter` / `registerModelDiscovery`**：`registerAdapter` 对 provider 路由是排他的，`registerModelDiscovery` 每个 namespace 只能有一个，直接注册会与 pi-ai 冲突。正确做法是只写 pi-ai 的 `providers` 配置，由 pi-ai 统一注册路由与模型发现。
- 已存在的 Ollama provider：只做有限同步（且仅当 baseURL 与我方一致），不覆盖用户在 Models 页手改的其他字段；模型列表用 `mergeModelParams` 合并——**已有模型保留手改的 contextWindow/maxTokens/name，只对新增模型套默认容量**，避免下一轮探测把你手改的参数覆盖回去。
- Ollama 无需 API Key，因此不写 `apiKeyEnv`（否则 pi-ai 会因缺凭据报 `MISSING_CREDENTIAL`）。
- **必须写 `compat`（工具调用关键，2026-08-27 实测）**：Ollama 的 OpenAI 兼容层不说 OpenAI 官方方言——不认 `developer` 角色、`max_completion_tokens` 字段、工具定义里的 `strict` 字段。pi-ai 对无法识别的端点默认按 OpenAI 官方协议发送，Ollama 会丢弃/拒绝，导致**工具 schema 到不了模型、模型从不调用工具**。本插件固定写入 `compat: { supportsDeveloperRole: false, supportsReasoningEffort: true, maxTokensField: "max_tokens", supportsStrictMode: false }`，让 pi-ai 改用 system 角色、`max_tokens` 字段、不带 strict 的工具。此坑对任何 OpenAI 兼容网关（LM Studio / vLLM 等）同样适用。
- **思考控制（坑 37，2026-08-27 实测）**：qwen3 / gemma 等模型在 Ollama 里默认开思考，会把 `max_tokens` 烧在 reasoning 上、还没轮到工具调用就被截断。`/v1` 端点不认顶层 `think: false`（Ollama 0.32.14 实测静默丢弃），**只认 `reasoning_effort`**。因此 `compat.supportsReasoningEffort` 必须为 `true`，且每个模型声明 `reasoningEfforts` 映射（`off:"none"` / `minimal:"none"` / `low:"low"` / `medium:"medium"` / `high:"high"`）——DSH 默认思考档位 off 时，pi-ai 发送 `reasoning_effort="none"` 关思考，token 全部留给工具调用（实测思考片段 0、正常调用工具）。
- **必须解决上下文容量（工具调用另一前提，2026-08-27 坑 35 实测）**：Ollama 服务端默认 `num_ctx` 只有 4096/16384，而 DSH 的 system prompt + 工具 schema 上万 token → 工具定义被截断 → 模型从不调用工具 + 报 token 上限。`OLLAMA_CONTEXT_LENGTH` 环境变量对桌面版 serve 不生效，`/v1/chat/completions` 不转发 `options.num_ctx`；**正解是 Modelfile 固化 `num_ctx` 重建变体**。本插件 `ensureContext`（默认开）自动完成：探测模型 → 原生能力足够则创建 `"<原名>-32k"` 变体 → models 指向变体。也可手动：`FROM qwen3:4b` + `PARAMETER num_ctx 32768` → `ollama create qwen3:4b-32k -f Modelfile`。
- **`maxTokens` 必须远小于 `contextWindow`**（2026-08-27 实测）：两者相等（如都设 16000）时 pi-ai 认为"输出上限 = 总上下文"，输入空间为零 → 必截断。正确配比如 `contextWindow: 32768` / `maxTokens: 8192`。

## 配置

入口配置在 `cordis.patch.yml` 的 `config` 字段（或安装后修改该文件）：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用自动识别 |
| `baseUrl` | `http://localhost:11434` | Ollama 服务根地址（不含 `/v1`） |
| `displayName` | `Ollama` | Models 页显示的提供方名称 |
| `defaultContextWindow` | `32768` | 模型发现不到上下文大小时的**回退值**（面板不直接编辑，见 `target*`） |
| `defaultMaxTokens` | `8192` | 模型发现不到最大输出时的**回退值**（面板不直接编辑，见 `target*`） |
| `detectIntervalMs` | `60000` | 周期性探测间隔（毫秒） |
| `probeTimeoutMs` | `3000` | 单次探测超时（毫秒） |
| `ensureContext` | `true` | 自动修复上下文容量（创建 `-32k` 变体并指向它） |
| `targetContextWindow` | `32768` | **生效**的上下文窗口：写入 Models 页模型容量 + 变体固化的 `num_ctx`。面板「目标上下文窗口」即改此项 |
| `targetMaxTokens` | `8192` | **生效**的单次输出上限（须远小于 `targetContextWindow`，如 32768/8192）。面板「目标最大输出」即改此项 |

## 安装

本插件随绿色版 `plugins/` 目录分发，使用启动器「插件管理 → 一键安装内置插件」即可（或在 profile 目录执行 `pnpm add file:E:/DeepSeekHarnessLauncher/plugins/dsh-ollama`）。

## 使用流程

1. 启动 Ollama（`ollama serve`）并确保已下载至少一个模型（`ollama pull llama3.2` 等）；
2. 启动 DSH（或直接使用绿色版启动器）；
3. 日志出现 `[dsh-ollama] 检测到 Ollama 服务` 即接入成功；
4. 打开 WebUI → 设置 → Models，选择 Ollama 及模型即可对话。

## 兼容性

- 需要 DSH 已内置 `@deepseek-ai/dsh-llm-pi-ai`（随 `@deepseek-ai/dsh-base` 加载，web profile 默认具备）；
- 需要 Node >= 18（探测使用全局 `fetch`）。
