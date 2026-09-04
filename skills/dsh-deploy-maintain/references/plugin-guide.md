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

