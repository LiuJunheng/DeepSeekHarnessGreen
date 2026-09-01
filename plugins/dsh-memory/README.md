# dsh-memory — 祖宗记忆库

跨会话记忆插件：自动把对话中的关键信息沉淀到 SQLite 记忆库，下次对话时自动召回注入 system prompt，也支持手动写入 / 搜索 / 删除。

## 功能

- **自动记忆（写入）**：每次用户发消息后，自动脱敏（过滤 API key / 密码 / 手机号等敏感信息），以默认重要性 0.6 写入记忆库
- **自动召回（读取）**：每次模型请求前，自动注入最近 4 条记忆到 system prompt 的「祖宗记忆库最近记忆」区块
- **WebUI 管理卡片**：设置页 → 祖宗记忆库，可查看状态、浏览/搜索/删除/手动写入
- **Agent 主动调用**：Agent 可调用 7 个工具主动读写记忆（详见下方）
- **零外部依赖**：记忆引擎用 Python 标准库（sqlite3 + json + sys），MCP stdio 桥用 Node.js 内置模块，不引任何 npm / PyPI 三方包

## 目录结构

```
plugins/dsh-memory/
  package.json          # 插件元信息 (name=dsh-memory, type=module)
  cordis.patch.yml      # bundle patch: insert id=dsh-memory name=dsh-memory
  engine/
    zuzong_memory.py    # 记忆引擎 (纯 stdlib SQLite + MCP stdio)
  lib/
    bridge.js           # MCP stdio 桥 (Node.js spawn Python, 逐行 JSON-RPC)
    hooks.js            # 自动记忆钩子 (session/event + autoRecall + 脱敏)
    tools.js            # 工具注册 (schema 转换 + 并发安全标记)
    index.js            # 入口 (绿色版默认值 + Host 路由注册)
    client.js           # WebUI 记忆库管理卡片 (React, 设置页 slots 注入)
```

## 工具列表（Agent 可调用）

| 工具名 | 作用 |
|--------|------|
| `zuzong_remember` | 写入一条记忆 |
| `zuzong_recall` | 按条件召回记忆 |
| `zuzong_search` | 关键词模糊搜索（SQLite LIKE） |
| `zuzong_timeline` | 按时间倒序列出（自动召回用这个，默认取最近 4 条） |
| `zuzong_service_info` | 引擎状态（总条数、重要性、DB 路径、引擎版本等） |
| `zuzong_list_all` | 列出全部记忆（支持 limit/offset 分页） |
| `zuzong_delete` | 删除指定 ID 的记忆 |

## 存储

- **位置**：`${DSH_HOME}/memory/zuzong.db`（绿色版为 `runtime/dsh-home/memory/zuzong.db`）
- **格式**：SQLite WAL 模式单文件

```sql
memories 表:
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,              -- 记忆内容
  tags TEXT DEFAULT '[]',             -- JSON 数组, 如 ["dsh","user"]
  importance REAL DEFAULT 0.5,        -- 重要性 0.0~1.0
  note_count INTEGER DEFAULT 0,       -- 被引用次数
  created_at INTEGER NOT NULL,         -- Unix 时间戳
  updated_at INTEGER NOT NULL,

索引:
  idx_memories_created    ON memories(created_at DESC)     -- 时间倒序
  idx_memories_importance ON memories(importance DESC)     -- 重要性倒序
```

- **备份 / 迁移**：绿色版整目录拷贝 `runtime/` 时自动带走。单独备份只需复制 `zuzong.db` 文件。

## 记忆触发时机（什么时候会写入 / 召回）

### 自动记忆（写入）

监听 DSH 的 `session/event` 事件，只处理满足全部条件的消息：

1. `event.type === 'user/message'` — 真实用户发的消息（不是工具输出、不是 AI 回复）
2. `event.source.kind === 'user'` — 确认来源是用户（不是系统或插件伪消息）

命中后执行流程：**原始文本 → 脱敏过滤（API key / 密码 / 身份证 / 手机号）→ `remember(content, importance=0.6, tags=['dsh','user'])`**

### 自动召回（读取）

监听 DSH 的 `system-prompt/assemble` 事件，在 system prompt 组装时：

1. 调用 `timeline(limit=4)` 取最近 4 条记忆
2. 注入到 system prompt 的 `【祖宗记忆库最近记忆】` 区块
3. **失败静默**：timeline 出错或 DB 不存在时不阻塞模型请求

### Agent 主动调用

Agent 在对话中可随时调用 7 个 `zuzong_*` 工具，由工具调用系统转发到 MCP stdio 桥 → 引擎。

## Host 路由（WebUI 后端）

插件在宿主端注册 5 个路由，供 `client.js` fetch 调用：

| 路由 | 方法 | 功能 |
|------|------|------|
| `/\_\_dsh/memory/status` | GET | 引擎状态（bridgeReady / totalMemories / avgImportance / dbPath / engine 版本） |
| `/\_\_dsh/memory/list` | GET | 列出全部记忆，`?limit=&offset=` 分页 |
| `/\_\_dsh/memory/search` | GET | 关键词模糊搜索，`?q=&limit=` |
| `/\_\_dsh/memory/delete` | POST | 删除指定 ID 的记忆，body: `{ "id": 1 }` |
| `/\_\_dsh/memory/write` | POST | 手动写入记忆，body: `{ "content": "...", "tags": [], "importance": 0.6 }` |

webServer 是可选注入：缺失时跳过路由注册，不阻塞插件激活。

## WebUI 管理卡片

设置页左侧边栏找到「祖宗记忆库」标签，进入后：

- **状态面板**：总条数 / 平均重要性 / 引擎版本 / 最新写入时间 / DB 路径
- **记忆列表**：卡片式滚动，单条删除按钮
- **搜索框**：回车或点按钮触发，关键词实时过滤
- **快速写入**：textarea + 标签 + 重要性滑块，点「写入」按钮

### WebUI 注册要求（插件开发时必看）

1. **`ctx.slots.inject` 格式**：必须用 DSH 绿色版插件统一格式注册设置页标签：
   ```javascript
   ctx.slots.inject("settings.section", () => ctx.slots.register({
       name: "settings.section",
       id: "dsh-memory",
       order: 530,
       label: "祖宗记忆库",
   }, MemoryCard));
   ```
   不能直接 `ctx.slots.register(...)`，否则设置页不显示入口。

2. **路由注册包裹 `ctx.effect`**：Host 路由注册必须放在 `ctx.effect(() => { ... }, name)` 回调内，确保 webServer 服务就绪后才触发注册，否则返回 404。

3. **`package.json` 声明 client 注入**：
   ```json
   "dsh": { "client": { "inject": ["slots"], "platform": "web" } }
   ```
   缺少则 WebUI 不会加载 `client.js`。

4. **`index.js` 必须 export name**：
   ```javascript
   export const name = 'dsh-memory';
   ```
   Cordis 插件标识，缺失会导致插件不激活。

## Python 路径自动探测（绿色版适配）

引擎 Python 路径从 `import.meta.url`（`lib/index.js`）开始**向上最多 10 层**逐层寻找 `runtime/python/python/python.exe`，找到即锁定绿色版根目录。兼容两种部署位置：

| 部署形态 | 插件实际位置 | 向上寻找到 Python 根目录 |
|----------|-------------|--------------------------|
| **开发态** | `<greenRoot>/plugins/dsh-memory/` | 向上 3 层到 `<greenRoot>` |
| **运行态**（launcher 安装后） | `<greenRoot>/runtime/dsh-home/profiles/web/node_modules/dsh-memory/` | 向上 7 层到 `<greenRoot>` |

Engine 脚本路径固定为 `<pluginDir>/engine/zuzong_memory.py`（相对位置在两种形态下都成立）。DB 路径固定为 `${DSH_HOME}/memory/zuzong.db`。

## MCP 协议实现

引擎实现 MCP stdio 协议子集（2024-11-05 版本），Node.js 侧 `bridge.js` 负责：

1. **spawn** Python 子进程，强制 `PYTHONIOENCODING=utf-8`（防 Windows 中文乱码）
2. **握手**：`initialize` → 等待 `notifications/initialized` → `tools/list`
3. **逐行 JSON-RPC**：Node.js 用 UTF-8 write stdin，Python 用 UTF-8 write stdout，桥用 `readline.createInterface` 读行并解析

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
  tools: ['remember','recall','search','timeline','service_info','list_all','delete']
  memory:
    userMessage: true       # 用户消息自动 remember
    autoRecall: true        # 模型请求前自动注入最近 4 条记忆
    desensitize: true       # 写入前过滤 API 密钥/密码/手机号等敏感信息
    importance: 0.6         # 默认重要性
    autoRecallLimit: 4      # 自动召回条数
```

## 安装

本插件随绿色版 `plugins/` 目录分发，启动器「插件管理 → 一键安装内置插件」即可，或命令行：

```bat
python launcher.py --install-plugin plugins\dsh-memory
```

安装后**重启服务**生效。

## 避坑清单（开发时必看）

### Windows 中文乱码（最容易踩）

Python 3.10 在 Windows 上 stdin/stdout 默认用系统编码（GBK），Node.js spawn 时用 UTF-8 write stdin → 中文 MCP JSON 被 Python 当 GBK 解析 → 写入 SQLite 变成 `缁х画` 这类典型乱码。

**修复**：`bridge.js` spawn env 里显式加 `PYTHONIOENCODING: 'utf-8'`。

**验证方法**：直接读 DB，中文 hex 反向 `bytes.fromhex(...).decode('utf-8')` 应等于原始内容。

Python 3.15+ 已默认 UTF-8 模式，但绿色版用的是 Python 3.10.20，必须手动设。

### launcher 自愈机制（修改插件源码后）

launcher 启动时会对 `node_modules/<plugin>` 做 hash 完整性校验，发现"被污染"（手动 copy 不是 pnpm 链接结构）会删掉从 `file:plugins/dsh-memory` 重新 `dsh plugin add` 安装。

**结论**：修改插件源码后**直接重启 launcher 即可**，不用手动 copy。launcher 会自动同步。

### 文件编码必须无 BOM UTF-8

launcher 跑 pnpm install 时如果 JSON/YAML 有 BOM（PowerShell `Set-Content -Encoding UTF8` 会加），会报：
```
SyntaxError: Unexpected token '\uFEFF', "﻿{..." is not valid JSON
```

写入时用 .NET `UTF8Encoding($false)` 或 `[System.IO.File]::WriteAllLines()` 无 BOM 模式。

### DSH_HOME 不要硬编码

绿色版进程会设 `DSH_HOME=runtime/dsh-home`，不要在代码里硬编码 `~/.dsh`。引擎会优先读环境变量，fallback 才用默认值。

### ESM 没有 `__file__`

bridge.js / index.js 用 ESM 语法，获取脚本所在目录要用 `import.meta.url` + `fileURLToPath()`，不能用 CommonJS 的 `__filename` / `__dirname`。

### SQLite LIKE 够用

search 用 `LIKE '%xxx%'`（SQLite 默认大小写不敏感）。语义检索 / 向量索引暂不做，当前量级 LIKE 够用。

### autoRecall 不阻塞模型请求

timeline 失败静默，只打日志不抛错。这是设计决策——记忆功能是锦上添花，不应影响主链路。

### launcher.py 自动扫描

`launcher.py` 的 `_bundled_plugin_dirs()` 自动扫描 `plugins/` 下含 `package.json` 的子目录，**不需要手动注册**。`engine/` 子目录会被完整复制进 `node_modules`（launcher 遍历整个目录树 hash）。