v1.0.30 — 祖宗记忆库 v3 会话隔离 + 批量清理

## 新增功能

### 祖宗记忆库 v3 会话隔离 (dsh-memory)
- ✅ **会话分组**：自动记忆带 session_id + cwd，WebUI 按会话分组显示
- ✅ **有意义的会话标题**：从 projcache / 实时快照 / session.jsonl.zstd 三层 fallback 读取
- ✅ **批量清理**：按会话清理 / 按时间戳清理（二次确认弹窗）
- ✅ **跨会话加载开关**：默认关闭 = 只读当前会话记忆；勾选 = 全局记忆也注入
- ✅ **实时生效**：跨会话开关 / 自动记录 / 自动注入 改了立即生效，不用重启

### 架构升级
- SQLite 增量迁移：自动给旧库加 session_id / cwd 列 + 索引
- 默认加载 6 条记忆（上限 10，可通过 autoRecallLimit 调）
- timeline 工具新增 cross_session 参数

## 打包命名简化
- 旧：DSH_Launcher_GreenPortable_Online_YYYYMMDD_v1.0.30.zip（太长）
- 新：**DSH-GreenPortable-v1.0.30.zip**

## 版本更新
- GREEN_VERSION: 1.0.29 → 1.0.30
- GREEN_ZIP_PREFIX: "DSH_Launcher_GreenPortable_Online_" → "DSH-GreenPortable-v"

## 已知问题
- WebUI 跨会话开关需要先勾「自动注入」才亮（灰态表示依赖自动注入开启）
- 首次启动旧库自动 ALTER TABLE 加列，安全但会看到迁移日志

## 升级建议
- 绿色版覆盖安装即可，自动会做旧库迁移
- 如果遇到 DSH 起不来，杀 DSH_Launcher.exe 后重新打开
