# DSH 插件开发完整避坑指南

> SKILL.md 里的插件部分只保留了**硬约束速查表**（6 条，踩任何一条服务直接炸）。本文档是完整的开发细节、错误排查、原理说明，开发插件时按需查阅。
> 代码骨架见：`plugin-skeleton.md` | 完整检查清单见：`checklists/plugin-dev-checklist.md` | 主题适配见：`theme-adaptation.md`

## 一、插件协议硬约束（速查版，完整见 SKILL.md 五节）

| # | 约束                                                 | 违反症状                                                               |
| - | -------------------------------------------------- | ------------------------------------------------------------------ |
| 1 | 宿主端导出函数名必须是 `apply`                                | `invalid plugin, expect function or object with an "apply" method` |
| 2 | 纯客户端也必须带 `lib/index.js`                            | `ERR_MODULE_NOT_FOUND: ...lib/index.js` 启动即退                       |
| 3 | `exports` 必须含 `"./package.json": "./package.json"` | 客户端 bundle 跳过 → WebUI 入口不出现                                        |
| 4 | `files` 数组必须含 `cordis.patch.yml`                   | pnpm 安装时文件被排除 → 插件树注册失败                                            |
| 5 | `name` 与目录名一致                                      | pnpm 安装可能出问题                                                       |
| 6 | 纯 hook 插件不能写 `dsh.client`                          | `client-modules: dsh-xxx declares dsh.client` → 启动崩溃               |

## 二、双入口架构详解

### `dsh.bundle.patch` → 宿主端加载

- 指向 `cordis.patch.yml`，格式：`- insert: [{id, name}]` 把插件作为一行插入 profile 插件树

- `dsh plugin add` 时 reconcile 据此写进 `dsh.profile.bundles`

- 服务启动时 `dsh-app-boot` 的 `loadProfile` 按序合成：bundle 补丁 → 用户 cordis.patch.yml → `--patch` 覆盖层

### `dsh.client` → WebUI 客户端入口

- 声明 WebUI 客户端入口，格式：`inject: ["settings.section"] + platform: "web"`

- 由 `dsh-client-modules` 扫描注入

- **只声明** **`dsh.client`** **不会进插件树**；只声明 bundle 没 client 则宿主加载但 WebUI 无入口

### `files` 数组（关键）

必须包含 `cordis.patch.yml`，否则 pnpm 安装时文件被排除 → 插件树注册失败。

## 三、宿主端路由注册

### `ctx.effect` 的正确用法（高频坑）

**错误写法**（先 register 再把返回值给 effect）：

```javascript
const disposer = ctx.webServer.register({ kind, path, handler });
ctx.effect(disposer, "label");
// 问题: ctx.effect(fn) 立即执行 fn() 并把返回值当清理函数
//       register 刚进表就被 disposer 删掉 → 非 GET 3005 fallback (405)
```

**正确写法**（回调包裹）：

```javascript
ctx.effect(() => ctx.webServer.register({ kind, path, handler }), "label");
// register 返回值（注销函数）正是 fn() 返回值，effect 存起来下次清理用
```

### 404/405 语义

- **405**（Method Not Allowed）= 路由根本没注册。内置 web server 先匹配 exact 表再 prefixes，未命中落 `frontend-static` fallback（非 GET/HEAD 返回 405）

- **404** + 同 (kind, path) 注册两条 = 抛 "Duplicate" → 整个插件 fiber 回滚、**所有**路由失效（不止 POST）

### 404 排查三步

1. 是否同 (kind, path) 注册了两条？（dsh 的 register 不支持同 path 多 method）
2. `__DSH_BOOT__.entries` 有 client 条目 + `curl /plugins/<id>/client.js` 能 200
3. 如果是 `settings.section` — 它生成的是**侧边栏导航行**（按 order 排），不是顶栏独立标签，浏览器验证要滚动侧边栏找

### 404 时同 path 分 method 的解法

```javascript
// ❌ 不能注册两条
ctx.webServer.register({ kind: "plugin", path: "/myapi", handler: getHandler });
ctx.webServer.register({ kind: "plugin", path: "/myapi", handler: postHandler }); // Duplicate!

// ✅ 在同一 handler 内按 method 分流
ctx.effect(() => ctx.webServer.register({
    kind: "plugin", path: "/myapi",
    handler(req, res) {
        if (req.method === "GET") return getHandler(req, res);
        if (req.method === "POST") return postHandler(req, res);
    }
}), "my-plugin-api");
```

## 四、纯客户端也必须带宿主端 `lib/index.js`

**严重坑**：宿主 Cordis loader 对 bundle 树**每个包都会 import** 其 `main`/`exports["."]`，纯客户端插件也不例外。

只放 `client.js` 时安装后重启服务**瞬间退出**，报：

```
ERR_MODULE_NOT_FOUND: ...lib/index.js
plugin tree failed to load
```

**修法**：放官方 no-op：

```javascript
// lib/index.js
export function apply() {}
```

## 五、客户端加载器与官方扩展点

### 加载器契约

```javascript
window.__ModuleLoader__.load({ id: "my-plugin", factory: () => createMyPlugin() });
// apply(ctx) 里注册设置区块
ctx.slots.inject("settings.section", { id: "my-settings", component: MySettings });
```

### 官方插槽列表（只做官方没有的，别重复）

| 插槽                                    | 用途                 | 注意                                                |
| ------------------------------------- | ------------------ | ------------------------------------------------- |
| `settings.section`                    | 设置侧边栏导航行           | 按 order 排，不是顶栏标签                                  |
| `conversation.chat.assistant-actions` | 助手消息 IconActions 行 | `owner={messageId}`, 官方 👍👎 用 order 10，第三方从 20 起 |
| `conversation.chat.turnTail`          | 助手消息下方内容区          | chain：select 必填返回匹配值，priority 控选举                 |

### 快照双源（数据读取）

```javascript
// legacy 源（通用）
const legacySnapshot = useSession((s) => s);
const oldNodes = legacySnapshot.nodes; // { kind: 'assistant'|'turn'|'usage' }

// standard-kit 源（0.1.2+ 新）
const chat = useChat ? useChat(s => s) : null;
const newNodes = chat?.nodes?.values();  // 实时节点库
const finalNode = data.finalNode;        // 最终回复节点
const tokenUsage = finalNode?.data?.tokenUsage;  // TurnTokenUsage
```

兼容写法：

```javascript
const data = useChat ? useChat(s => s) : useSession(s => s);
```

### 官方已原生覆盖（别重复做）

- 消息正文「复制」

- 回合尾「在新对话中分支」

- 悬停"用时/首 token/速率"

- 会话级 token 合计（官方 StatsLine）

- ContextMeter（输入框右侧上下文窗口仪表）

- 逐回合精确记账 `turn-tail` 节点 `data.tokenUsage`

## 六、客户端 UI 通用坑

### 条件调用 hook（高频）

插槽条目组件**不要条件调用 props 传入的 hook**：

```jsx
// ❌ 错误: 被错误边界吞掉 → 组件不渲染（data-slot-error 空占位）
const useX = ownerProps.input.useDraft;
const draft = typeof useX === "function" ? useX() : null;
```

读快照优先用 ownerProps 里的普通字段（如 `ownerProps.input.draft`），hook 必须**无条件调用**。

### 宽数据布局

- 用**卡片式纵向布局**（标题独占整行 `wordBreak`、元信息 `flexWrap` chips）

- 别用固定列宽横向表格（窄面板只显示半个字）

### 字符按钮

字符按钮（如 `⌂`）部分字体渲染空白/方框 → 优先内联 SVG + 文字标签 + `title`。

### 媒体路由 + 防御头的矛盾

`<img src>` / `<iframe src>` / `<a href>` 均带不上自定义头 → 一律：

```javascript
// 预览
const res = await fetch(url, { headers: defenseHeaders });
const blob = await res.blob();
const objectUrl = URL.createObjectURL(blob);
// 交给 <img src={objectUrl}>
// 下载
const a = document.createElement("a");
a.href = objectUrl; a.download = filename; a.click();
URL.revokeObjectURL(objectUrl);
```

`showSaveFilePicker` 必须先弹框拿 handle 再 fetch 写回（异步丢焦点会拦截"需要用户手势"）。

### 改源码生效条件

- **改客户端源码** → 强刷页面即可（bundle 按请求重新生成、rev 变化）

- **改宿主端 / 加减插件** → 必须重启服务

## 七、插件自愈（更新后根治"插件树起不来"）

`update_dsh` 成功后自动执行四步：

1. `_remove_incompatible_bundles` — 移除黑名单 bundle（dshmarket）+ 历史日志定位到的不兼容 bundle（日志含 `does not provide an export` / `is not in cache` / `ERR_MODULE_NOT_FOUND` / `Cannot find package` / `SyntaxError` 且堆栈路径命中 profile 的 bundles+dependencies）
2. `_heal_profile_dependencies` — 补宿主核心声明的 peer 依赖（`autoInstallPeers:false` 下 pnpm 不自动装）+ 把 profile 与 file: 本地插件的核心依赖版本同步到宿主已装版本
3. `_rebuild_dependency_tree` — 便携 pnpm `install --force --no-frozen-lockfile` 强制重建（复用 BOM 清理 + allowBuilds 补丁）
4. `_smoke_verify_core_upgrade` — 独立子进程冒烟启动验证端口监听，失败再定位 1 个不兼容 bundle 移除重建重试（最多 2 轮，每轮只删 1 个防误删）

## 八、pnpm 与插件安装

| # | 坑                             | 解法                                                                        |
| - | ----------------------------- | ------------------------------------------------------------------------- |
| 1 | pnpm 裸跑 `--version` 失败（退出码 1） | 必须在含便携 node 的 PATH 下运行                                                    |
| 2 | `file:` 安装是拷贝非软链              | 改 `plugins/` 源码必须重装才同步                                                    |
| 3 | pnpm 退出码 1 跳过 reconcile       | `ERR_PNPM_IGNORED_BUILDS` 时官方 reconcile 不运行 → 启动器兜底 `reconcile_bundles()` |
| 4 | 停用插件被 reconcile 加回            | 官方不识别 disabled 列表 → launcher 每次命令后重放停用状态                                  |
| 5 | 原生依赖构建被拒                      | 启动器自动补 `allowBuilds` 白名单（绿色版 zip 不含 runtime/，此补丁必须在启动器内做）                 |

## 九、数据维护（官方无此能力）

- **彻底删除**：服务停止后，三处一并清理——`sessions/<ID>/` 日志目录 + `workspace.json` + projcache 缓存（DSH 0.1.2-rc.1+ 分文件 `storages/session_projcache/sessions/session-{uuid}.json`，旧版单文件）

- **复原（取消归档）**：只从 `archivedSessionIds` 移除 ID，日志/归属/缓存 dsh 从没动过，天然无损

- JSON 写回用**原子写**（同目录临时文件 + `os.replace`）

## 十、版本追踪铁律

- `GREEN_VERSION` 是**唯一来源**（禁止硬编码版本号到脚本 zip 名）

- 版本号对比按数字分段（`1.0.10 > 1.0.9`）

- **版本日期纪律**：`GREEN_VERSION_DATE` 必须是制作当天，哪怕一天发两个版本，也**不预写未来日期**

## 十一、用量/费用类插件的通用经验（dsh-usage-stats 2026-09 升级）

### 官方定价页零依赖拉取

- DeepSeek 官方定价页 `https://api-docs.deepseek.com/zh-cn/quick_start/pricing`（中文页 = 人民币元，英文页 = $；解析器正则兼容两者关键词 `空闲时段/高峰时段` 与 `OFF-PEAK/PEAK`）是**服务端预渲染**，`fetch` 拿到 HTML 即可正则解析，**不需要 cheerio/jsdom**。
- 解析套路（三连环正则）：`/<table[\s\S]*?<\/table>/gi` 拆表 → `/<tr[\s\S]*?<\/tr>/gi` 拆行 → `/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi` 拆格。去掉 HTML 标签与实体后即为纯文本。
- 表头行 `[模型, <id>...]` 用 `/deepseek-[a-z0-9_.-]+/i` 提取 id；计价行每指标（缓存命中/未命中/输出）下先 `空闲时段` 后 `高峰时段` 两行，**高峰行无指标标签**（rowspan 合并）→ 需沿用上一行的指标。
- 启动时静默 `fetch`+解析，失败**静默回退内置表**（不抛错、不阻塞插件注册）。价格结构两档三桶 `{offPeak, peak} x {cacheHit, cacheMiss, output}`。

### 峰谷计费（高峰 = 低谷 2 倍，周末全谷）

- 高峰窗口按 **UTC 小时** `[{1,4},{6,10}]` = 北京 9:00-12:00 / 14:00-18:00。
- 周末（北京周六/周日，2026-08-22T16:00Z 起生效）全天谷价优先于窗口。
- **按每条消息的 `time`（epoch ms）判峰谷**——所以费用计算必须在后端扫码时做（后端有事件 time），前端只按"当前时刻"估消息行费用。

### 按日聚合（今日消耗 / 热力图）

- 北京时区日键 = `new Date(ms + 8h)` 取日期，`Math.floor((ms + 8*3600000)/86400000)` 算日 index（1970-01-01 是周四，`(day+4)%7` 得周几）。
- 每条 `assistant/message` 事件带 `time` + `data.usage`（inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/reasoningTokens），按日累加后即可出"今日消耗"与近 180 天热力图。
- 热力图 GitHub 风格：最近 N 天（180 天分 ~26 周，7 行 × 26 列），**横向滚动容器**（`overflowX:auto` + 网格区固定等宽列）；顶部跨月处标注月份、左侧固定星期列（日~六）；颜色按当日 cost 相对最大值 5 档分级（`ratio>0.75/0.5/0.25`），悬停 title 显示日期+费用+tokens。

### 官方插槽契约变更（升级 dsh 后消息行/会话级插件失效的高频根因）

- **`conversation.chat.turnTail` owner 结构在 0.1.6 变了**：旧版 `owner.matched = { turn: number }`，新版 `owner.turn = TurnLocation 对象`（含 `.turn: number`、`.start/.end` 事件）+ `owner.seq`（closing seq）+ `owner.openFile`（[slots.d.ts 的 TurnTailOwnerProps](D:\DeepSeekHarnessLauncher\runtime\dsh\node_modules\@deepseek-ai\dsh-client-ui-chat\lib\types\client\contract\slots.d.ts)）。**组件里不能再只读 `props.matched.turn`**，要兼容两种：`(matched && matched.turn) || props.turn`，再解 `typeof turnObj === "number" ? turnObj : turnObj.turn`。否则升级后消息行"本次token/费用/余额"静默不显示（返回 null 不渲染，无报错）。
- **`turnTail` 是 list 型插槽，注册必须带 `id`**（0.1.6 起 register 在 list 分支强制 `options.id`，缺了抛 `SlotAssemblyError` 且被 SlotErrorBoundary 吞掉→**静默不渲染**，表现跟上面一样）。对比：`settings.section` 也是 list 型，我们的登记带了 `id` 所以正常工作。list 型**不走 `select`**（select 只对 chain 型生效），组件直接收到 `ownerProps { turn, seq, openFile }` + 标准 hook props（`useChat`/`useSession` 由 scope 注入的 kit 提供，定义在官方 `dsh-client-ui-slots/lib/index.js` 的 `register()` list 分支与 `dsh-client-ui-renderer` 的 `renderEntry()`：`{...kit, ...injected, ...slotInjected.props, ...ownerProps}`）。所以注册时别画蛇添足写 select，只写 `{ name, id, priority }`。
- **官方快照 hook 仍经 scope 标准 props 注入**（`PropsRuntime = Owner & KeyProps & SlotInjectFace & ScopeStandardProps`），`useChat`/`useSession` 不需要插件自带——插件组件照常从 `props.useChat` 取。快照 `chat.legacy.nodes`（AssistantMessageNode 数组，含 `turn: number`、`usage`）在 0.1.6 仍由 `event.data.usage` 填充，官方 StatsPills 同源，可放心用。
- **排查方法**：设置面板正常但消息行消失 → 优先怀疑插槽 owner / snapshot 契约变化，直接读官方 `dsh-client-ui-chat` 的 `slots.d.ts` 与 `TurnTailNodeView` 里 `renderSlot(...)` 传入的字段（在 `runtime/dsh/node_modules/@deepseek-ai/`，不在 profile 的 node_modules）。
- **另一高频根因（客户端渲染崩溃→整面板空白）**：`const` 声明的 `useCallback` 若在**定义之前**被调用（如 `if (!loadedRef.current) { refreshOfficialPrices(); }` 放在定义前）→ TDZ `ReferenceError`；以及数组越界 `cells[idx]` 为 `undefined` 后直接访问 `cell.cost` → TypeError。**热力图末列不足一周、组件初始化块引用后定义的回调，都要兜底**（`cell || 默认对象`、把回调定义移到调用前）。

### 存储/兼容避坑

- session 日志文件 `session.v3.jsonl.zstd`（文件名带版本段），内部结构 = zstd 多帧 + 每行 JSONL，与旧版 `session.jsonl.zstd` 完全一致——**扫目录按候选列表挑最高优先级**（`session.v*.jsonl.zstd` > `session.jsonl.zstd` > `session.jsonl`），未来加 v4 也不用改。
- 前端价格表 localStorage key 若升级结构（如 v4→v5 两档），**必须升 key 名前缀**，否则旧表永远盖住新默认值。
- 用户手动编辑的价格永远优先：官方同步只更新"内置默认档"，不写 localStorage；前端点「保存价格」才落盘覆盖。`loadPricesFromOfficial()` 合并官方表 + 保留用户自定义模型（官方表没有的键）。

