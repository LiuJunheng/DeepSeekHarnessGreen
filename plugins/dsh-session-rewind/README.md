# dsh-session-rewind — 会话回退插件 (WebUI 可视化)

> English: WebUI session-rewind plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It visualizes per-turn session analysis and recovers conversations that were poisoned by the "tool runtime unavailable" bug family (GitHub Discussions [#1959](https://github.com/deepseek-ai/deepseek-harness/discussions/1959) / [#1974](https://github.com/deepseek-ai/deepseek-harness/discussions/1974)) — fork at any completed turn, keep the good history, drop the poisoned tail.

## 解决的问题

DSH 的回合会因工具运行时失效(如 `Cannot read properties of undefined (reading 'prepare')`)而崩溃,并在会话日志里留下孤儿 `tool_calls`(有调用、永远没有结果),之后每一轮对话都会被 DeepSeek API 以 400 拒绝,会话**永久毒化**。DSH 0.1.0-rc.6 没有"删除失败消息"的界面功能。

本插件在 WebUI 设置页新增「会话回退」页面:

- 列出全部会话(标题/工作区/是否运行中/创建时间);
- 「分析」任意会话: 展示逐回合信息(用户问题、步骤数、工具调用数、错误码统计、是否完成);
- 在任意一个**已完成**回合上点「回退到此」: 调用官方 `session.fork` 从该回合之后**派生一个干净的续接会话**并自动打开 —— 等效于"移除失败消息之后的内容, 重新发新消息不再被干扰";
- 原会话保留不动(可再用「清理归档」等工具处理)。

因为孤儿 `tool_calls` 只存在于崩溃回合内, 从该回合之前的已完成回合边界派生, 即可干净地切掉毒化历史, 同时保住之前所有正常对话。

## 为什么是"派生新会话"而不是"原地删消息"

DSH 服务运行时, 会话由持久化层在内存中缓存, 原地改写磁盘日志会被内存状态覆盖或产生 seq 断裂, 不安全。官方 `session.fork` 正是为此设计: 从任意已完成回合边界截断并创建续接会话(与官方 UI 自带的"分支"同源, 官方只暴露末位回合, 本插件放开到任意回合)。

## 安装

本仓库已包含此插件(目录 `plugins/dsh-session-rewind`)。两种方式:

**方式 A — 本地插件安装(推荐)**:

```
git clone https://github.com/LiuJunheng/DeepSeekHarnessGreen.git
```

然后在 DSH 启动器/插件管理器里选择本地插件文件夹安装 `plugins/dsh-session-rewind`(绿色版启动器: `python launcher.py --install-plugin plugins\dsh-session-rewind`), 重启服务后, 设置页出现「会话回退」。

**方式 B — 手动加入 profile**:

在 profile 的 `package.json` dependencies 中加入 `"dsh-session-rewind": "file:<仓库绝对路径>/plugins/dsh-session-rewind"`, 然后 `pnpm install` 并重启服务。

> 注意: 本插件依赖 `@deepseek-ai/dsh-session@0.1.0-rc.6`(pnpm 安装时会自动装进 profile)。

## 配套工具 (tools/)

- `tools/rewind-session.mjs` — **离线原地回退**脚本: 服务停止时, 直接把会话日志截断到最后一个完整回合(自动备份)。适合服务停机维护场景。
- `tools/apply-agentloop-guard.mjs` — **诊断守卫补丁**: 给 `dsh-agent-loop` 的工具派发入口加存在性检查, 把晦涩的 `Cannot read properties of undefined (reading 'prepare')` 变成明确的可操作错误提示(幂等, 可反复执行; DSH 升级后重跑一次即可)。

## 接口

- `GET /__dsh/session-rewind/list` — 会话列表(快速, 只读 header)。
- `GET /__dsh/session-rewind/inspect?id=<会话ID>` — 逐回合分析(解码整个日志)。
- 回退由客户端调用官方 `session.fork`(`{sessionId, atSeq}`)完成。
- 所有接口要求自定义头 `X-DSH-Plugin-Rewind: 1` 防 CSRF。

## 实现说明

- 宿主端直接按磁盘扫描 `DSH_HOME/sessions/**/session.jsonl.zstd`(zstd 多帧), 用官方 `@deepseek-ai/dsh-session` 的 `decodeStorageRecord` 展开事件(对 chunk-run 打包行布局无关)。
- 回退动作走官方 `session.fork` + 客户端 `sessions.open`, 与服务端持久化层完全一致。

## 相关讨论

- [DeepSeek Harness Discussion #1959 — 同签名 bug 报告(工具运行时失效 + 会话毒化)](https://github.com/deepseek-ai/deepseek-harness/discussions/1959)
- [DeepSeek Harness Discussion #1974 — 我们的独立诊断报告与守卫补丁](https://github.com/deepseek-ai/deepseek-harness/discussions/1974)

## License

MIT
