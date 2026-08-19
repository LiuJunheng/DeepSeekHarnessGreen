# dsh-session-import

WebUI「会话导入」插件：把官方「Session log」按钮导出的 ZIP（`dsh-session-<id>.zip`，来自 `GET /api/session.export`）或单个 `.jsonl` 日志导入回 DSH，写回持久化目录并挂到对应工作区，与官方导出互逆。

## 用法

1. 安装：`python launcher.py --install-plugin plugins\dsh-session-import`（或启动器 GUI 插件管理 → 一键安装内置插件）。
2. **重启服务生效**（bundle 补丁在服务启动时合成）。
3. 打开 WebUI → 设置 → 左侧「会话导入」→ 选择导出 ZIP 或 .jsonl → 开始导入。
4. 刷新会话列表查看导入的会话。

## 行为

- **ZIP 自动识别**（`PK` 魔数），其余按 JSONL 文本处理。
- 写盘布局与官方持久化后端一致：
  - `DSH_HOME/sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.jsonl.zstd`（默认 zstd：校验和帧(header) + 校验和帧(事件)，与官方 `encodeMaterialization` 逐字节一致；根编码探测为明文时写 `session.jsonl`）。
  - `subagents/*/session.jsonl` → 每个子会话一份 artifact。
  - `media/<attachmentId>.<ext>` → 按内容寻址写回 `DSH_HOME/attachments/v1/objects/<sha256 前两位>/<sha256>`（校验摘要一致）。
- 校验：首行为合法会话 header（`type:"session"`、版本号匹配 `SESSION_FORMAT_VERSION`、无已退役 policy 字段）、每行均为合法 JSON。
- 重复导入：已存在的会话 id 会跳过（不覆盖）。
- 工作区：按 header.cwd 匹配现有工作区；目录存在且无匹配时自动创建工作区；cwd 目录不存在则留在「未分组」（仍会出现在会话列表）。
- 会话列表实时可见：`session.list` 会合并冷（持久化）会话，无需重启即可看到数据；会话标题等投影数据由 DSH 自行补齐（导入不写投影缓存）。

## 接口

- `GET /__dsh/session-import/health` → 插件是否已加载。
- `POST /__dsh/session-import/upload?filename=<名字>` → 请求体为 ZIP 字节或 JSONL 文本。
- 两个路由均要求自定义头 `X-DSH-Session-Import: 1`（防跨站伪造）。

## 限制

- 不写投影缓存/统计：导入会话的标题等元数据由 DSH 后续投影计算补齐，可能显示为「(无标题)」。
- 导入是"恢复/查看"语义：会话不会自动继续运行，官方也没有通用的"从该会话继续聊"UI 入口。
- 体积上限 512MB（含媒体）。
- 不处理 zip64（超大条目）与加密 ZIP。
