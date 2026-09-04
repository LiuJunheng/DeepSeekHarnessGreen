{tag} — DSH 0.1.2-rc.1 全量适配（会话标题 + 回合数据 + @引用 + inject 补全）

## 核心更新

DSH 升级到 **0.1.2-rc.1** 后，底层 session 存储结构、API 行为、ESM 约束都变了，本次是全量适配。

### 🐛 会话标题获取 — 三级 fallback
- projcache 从单文件改成按 session 分文件 `storages/session_projcache/sessions/session-{uuid}.json`
- 修复 `entry.id` 已带 `session-` 前缀导致文件名拼错
- 三级策略: 新 projcache → 旧 projcache → session.jsonl.zstd 的 session/title 事件

### 💥 sessionQuery.readSurface 不再返回 turn 事件
- usage-stats 改用 `loadSession(file, "zstd")` 直接解析磁盘 JSONL.zstd
- `foldEvents()` 回合折叠后 turnCount/turns/messages/models 全部正确

### ❌ ESM 插件里不能写 require()
- 删掉 3 个插件里非法的 inline `require("zlib")` (ReferenceError 被 catch 吞掉永不报错)
- 用顶部 `import zlib from "node:zlib"`

### 📦 inject 依赖声明补全
- session-rewind / archive-purge 加 `"sessions"` 到 inject 数组

### ⌨️ @引用插入 resolveAgentScope fallback
- 改用 `sessions.resolveAgentScope()` + DOM `execCommand('insertText')` 兜底

### 📚 Skill / DEV_NOTES 全面更新
- data-directories.md / plugin-dev-checklist.md / plugin-skeleton.md 同步更新
- DEV_NOTES.md 新增 8.7-8.10 + 附录 Checklist
- 旧 projcache 引用全局清理

## 升级说明
- 绿色版用户: 启动器「检查绿色版更新」自动拉 Release 附件
- 手动升级: 下载 zip 覆盖根目录 (跳过 config.json 和 runtime/)
- 插件不用重装，纯代码变更
