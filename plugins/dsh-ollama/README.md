# dsh-ollama

自动识别本机 Ollama 服务并接入 DSH 的宿主端插件。

## 功能

- 启动后立即探测 Ollama 原生接口 `/api/tags`（默认 `http://localhost:11434`），并按 `detectIntervalMs` 周期刷新；
- 探测到服务在线后，自动把 Ollama 注册为 OpenAI 兼容 Provider（写入 `llm-pi-ai` 的 `providers.ollama` 配置）：
  - `api = openai-completions`（Ollama `/v1` 端点）
  - `baseURL = {baseUrl}/v1`
  - `models` = 从 `/api/tags` 拉到的模型列表（含默认 `contextWindow` / `maxTokens`）
- WebUI **Models 设置页**随即出现 Ollama 条目，可直接选择模型对话，也可修改 baseURL / contextWindow / maxTokens 等参数；
- Ollama 模型有增删（新 pull / 删除）时自动同步 `models` 列表。

## 设计要点 / 避坑

- 不修改任何官方文件/包；零原生依赖、零构建。
- **不自己调用 `ctx.llm.registerAdapter` / `registerModelDiscovery`**：`registerAdapter` 对 provider 路由是排他的，`registerModelDiscovery` 每个 namespace 只能有一个，直接注册会与 pi-ai 冲突。正确做法是只写 pi-ai 的 `providers` 配置，由 pi-ai 统一注册路由与模型发现。
- 已存在的 Ollama provider：只同步模型列表（且仅当 baseURL 与我方一致），不覆盖用户在 Models 页手改的其他字段。
- Ollama 无需 API Key，因此不写 `apiKeyEnv`（否则 pi-ai 会因缺凭据报 `MISSING_CREDENTIAL`）。

## 配置

入口配置在 `cordis.patch.yml` 的 `config` 字段（或安装后修改该文件）：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启用自动识别 |
| `baseUrl` | `http://localhost:11434` | Ollama 服务根地址（不含 `/v1`） |
| `displayName` | `Ollama` | Models 页显示的提供方名称 |
| `defaultContextWindow` | `32768` | 模型发现不到上下文大小时的默认值 |
| `defaultMaxTokens` | `8192` | 模型发现不到最大输出时的默认值 |
| `detectIntervalMs` | `60000` | 周期性探测间隔（毫秒） |
| `probeTimeoutMs` | `3000` | 单次探测超时（毫秒） |

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
