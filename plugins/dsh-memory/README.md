# dsh-memory — 祖宗记忆库

跨会话记忆插件：自动把对话中的关键信息沉淀到 SQLite 记忆库，下次对话时自动召回注入 system prompt，也支持手动写入 / 搜索 / 删除。

## 功能

- **自动记忆（写入）**：每次用户发消息后，自动脱敏（过滤 API key / 密码 / 手机号等敏感信息），以默认重要性 0.6 写入记忆库
- **自动召回（读取）**：每次模型请求前，自动注入最近 4 条记忆到 system prompt 的「祖宗记忆库最近记忆」区块
- **WebUI 管理卡片**：设置页 → 祖宗记忆库，可查看状态、浏览/搜索/删除/手动写入
- **Agent 主动调用**：Agent 可调用 7 个工具主动读写记忆（详见下方）
- **零外部依赖**：记忆引擎用 Python 标准库（sqlite3 + json + sys），MCP stdio 桥用 Node.js 内置模块，不引任何 npm / PyPI 三方包

## 工具列表（Agent 可调用）

| 工具名 | 作用 |
|--------|------|
| `zuzong_remember` | 写入一条记忆 |
| `zuzong_recall` | 按条件召回记忆 |
| `zuzong_search` | 关键词模糊搜索 |
| `zuzong_timeline` | 按时间倒序列出（自动召回用这个，默认取最近 4 条） |
| `zuzong_service_info` | 引擎状态（总条数、重要性、DB 路径等） |
| `zuzong_list_all` | 列出全部记忆 |
| `zuzong_delete` | 删除指定 ID 的记忆 |

## WebUI 管理卡片

设置页左侧边栏找到「祖宗记忆库」标签，进入后：

- **状态面板**：总条数 / 平均重要性 / 引擎版本 / 最新写入时间 / DB 路径
- **记忆列表**：卡片式滚动，单条删除按钮
- **搜索框**：关键词实时过滤
- **快速写入**：textarea + 标签 + 重要性滑块，手动写记忆

## 存储

- **位置**：`${DSH_HOME}/memory/zuzong.db`（绿色版为 `runtime/dsh-home/memory/zuzong.db`）
- **格式**：SQLite WAL 模式单文件，7 个字段（id / content / tags / importance / note_count / created_at / updated_at）+ 2 个索引
- **备份**：整目录迁移即可，绿色版 `runtime/` 拷贝时自动带走

## 配置

配置项在 `cordis.patch.yml` 的 `config` 字段，全部可选，空字符串走自动探测：

```yaml
- id: dsh-memory
  name: dsh-memory
  config:
    # python: ''           # 自动探测 runtime/python/python/python.exe
    # moduleArgs: []       # 自动用 <pluginDir>/engine/zuzong_memory.py
    # dbPath: ''           # 自动用 DSH_HOME/memory/zuzong.db
  identity: '祖宗记忆库'
  memory:
    userMessage: true       # 用户消息自动 remember
    autoRecall: true        # 模型请求前自动注入最近 4 条记忆
    desensitize: true       # 写入前过滤敏感信息
    importance: 0.6         # 默认重要性
    autoRecallLimit: 4      # 自动召回条数
```

## 安装

本插件随绿色版 `plugins/` 目录分发，启动器「插件管理 → 一键安装内置插件」即可，或命令行：

```bat
python launcher.py --install-plugin plugins\dsh-memory
```

安装后**重启服务**生效。

## 注意

- Windows 下 Python 3.10 默认 GBK 编码，已由 bridge 层强制 `PYTHONIOENCODING=utf-8`，无需额外配置
- autoRecall 失败静默，不阻塞模型请求
- 不修改任何官方文件/包，纯插件实现