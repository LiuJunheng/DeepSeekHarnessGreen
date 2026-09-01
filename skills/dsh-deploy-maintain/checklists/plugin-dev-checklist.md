# DSH 插件开发检查清单

## 零、Cordis 插件协议硬约束（最容易踩）

- [ ] **宿主端导出函数名必须是 `apply`，不是 `setup`/`init`/`install`**——Cordis loader 报错: `invalid plugin, expect function or object with an "apply" method, received object`。对比: dsh-memory 是 `export async function apply`，dsh-usage-stats 是 `export { apply }`，dsh-rules 曾经用 `setup` 直接炸掉
- [ ] **纯客户端插件也必须带 `lib/index.js`**——宿主 cordis loader 对 bundle 树每个包都会 `import main`，缺失 → `ERR_MODULE_NOT_FOUND: ...lib/index.js` → **服务启动即退出**。纯客户端插件用官方 no-op: `function apply() {}; export { apply }`
- [ ] **`exports` 必须包含 `"./package.json": "./package.json"`**——客户端 `ClientModuleRegistry.resolveMeta()` 用 `require.resolve("<插件>/package.json")` 扫描，缺失 → `ERR_PACKAGE_PATH_NOT_EXPORTED` → 客户端 bundle 跳过 → WebUI 入口不出现
- [ ] **`files` 数组必须包含 `cordis.patch.yml`**——否则 pnpm 安装时文件被排除 → 插件树注册失败
- [ ] **`name` 字段与目录名一致**——目录名 `dsh-rules/` → package.json `name: "dsh-rules"`
- [ ] **纯 hook 插件（类型 B）package.json 不要写 `dsh.client`**——`client-modules: dsh-xxx declares dsh.client but exports no "./client" bundle` 会让客户端模块注册表去找不存在的 `./client` export，直接炸服务。只有带 WebUI 的"类型 A"插件才声明 `dsh.client`

## 一、两种插件类型

### 类型 A：路由 + 客户端双端插件（有 UI）

```
dsh-xxx/
├── lib/
│   ├── index.js        # 宿主端: 路由注册 / system-prompt hook
│   └── client.js       # 客户端: WebUI 插槽注入
├── cordis.patch.yml    # 插件树补丁声明
├── package.json
└── README.md
```

- [ ] `package.json` 含 `dsh.bundle.patch` 指向 `cordis.patch.yml`
- [ ] `package.json` 含 `dsh.client` 声明（`inject` + `platform: "web"`）
- [ ] `exports` 包含 `".": "./lib/index.js"` + `"./client": "./lib/client.js"` + `"./package.json": "./package.json"`
- [ ] `cordis.patch.yml` 格式正确: `- insert: [{id: "xxx", name: "xxx"}]`

### 类型 B：纯 hook 插件（无 UI，只注入 system-prompt 等）

```
dsh-rules/
├── lib/
│   └── index.js        # 宿主端: system-prompt/assemble 监听
├── cordis.patch.yml    # 插件树补丁声明
├── package.json
├── default-rules.md    # 可选: 首次安装默认模板
└── README.md
```

- [ ] `package.json` 含 `dsh.bundle.patch`，**绝对不能写** `dsh.client`（没有 WebUI 入口，写了会让客户端模块注册表找 `./client` export 炸服务）
- [ ] `inject: []` 空数组（不依赖任何宿主服务）或按需声明
- [ ] `import '@deepseek-ai/dsh-system-prompt'` 声明依赖（否则事件没注册）
- [ ] 无 `lib/client.js`（不需要客户端入口）

## 二、宿主端 lib/index.js（两类通用）

### Cordis 导出契约

- [ ] 导出 `{ name, inject, Config?, apply }`（apply 必须）
- [ ] `inject` 声明所需服务（`webServer` 路由必需；纯 hook 可空 `[]`）
- [ ] `Config` 可选但常用——用 `@deepseek-ai/schemastery` 的 `z.object()` 定义配置 schema，全部字段给默认值
- [ ] **`apply` 用 async**（纯路由插件也可以 sync；但 hook 插件几乎都要 async）

### 路由注册（类型 A 专用）

- [ ] `ctx.effect(() => ctx.webServer.register({...}), label)` 写法——**禁止先注册再传注销函数给 effect**（会被立即注销）
- [ ] `kind` 正确（`exact` 精确匹配 或 `prefix` 前缀匹配）
- [ ] `path` 不与其他插件冲突（建议加唯一前缀如 `__dsh/xxx`）
- [ ] **无 method 字段**——同一 path 只能注册一次 GET/POST 分流必须在 handler 里按 `req.method` 分发
- [ ] 自定义头校验防跨站触发
- [ ] POST 有 `readJsonBody` 解析 + 异常捕获
- [ ] 写回用 `sendJson(res, 200, { ok: true, ... })` 统一格式
- [ ] 异常处理 `try/catch` → 返回 500 + 错误信息

### system-prompt/assemble 监听（类型 B 专用）

- [ ] **`import '@deepseek-ai/dsh-system-prompt'`**——声明依赖，否则事件总线不存在
- [ ] hook 签名: `ctx.on('system-prompt/assemble', async (assembly, _ctx, next) => { ...; return next(); })`——**必须 waterfall 链继续**
- [ ] `assembly.contexts.push({ name, text, weight? })`——`name` 全局唯一（invariant.js 校验，重复会 fail），`text` 必填字符串
- [ ] 钩子失败要静默——读文件失败/bridge 断开时别 throw，用 try-catch 吞掉，下一次请求继续试
- [ ] 两个插件用同一机制但不同 name 不冲突（dsh-memory 用 `zuzong:auto-recall`，dsh-rules 用 `user-rules`）
- [ ] 读文件带缓存——"读多写少"内容本地缓存 2s TTL，避免每次请求磁盘 IO
- [ ] 文件变化自动重载——`fs.watch` 监听目录 + 清缓存 → 下次请求生效

## 三、客户端 lib/client.js（仅类型 A）

- [ ] `window.__ModuleLoader__.load({ id, factory })` 加载器契约
- [ ] `apply(ctx)` 里 `ctx.slots.inject("settings.section", ...)` 注册设置区块
- [ ] 消息行插槽用官方的: `conversation.chat.assistant-actions`（已完成消息操作行，order 20+，官方 👍👎 用 10）或 `conversation.chat.turnTail`（操作行上方内容区，chain + select + priority）
- [ ] **宽数据用卡片式纵向布局**——标题独占整行 wordBreak，元信息 flexWrap chips；别用固定列宽横向表格
- [ ] **插槽条目组件不要条件调用 props 传入的 hook**——会触发 "Rendered more/fewer hooks" 被错误边界吞掉 → 组件不渲染
- [ ] 改客户端源码**强制刷新页面即可**（bundle 按请求重新生成），**改宿主端才需重启服务**
- [ ] 组件内 fetch 带自定义头防跨站
- [ ] 加载/删除/刷新状态管理（busy/error/result）+ 空状态 + 加载中提示

## 四、安装与验证

- [ ] launcher 启动器: `plugins/` 下的目录自动扫描装成内置插件
- [ ] 手动安装: `dsh plugin add file:<绝对路径>`
- [ ] **pnpm 对 file: 是拷贝/硬链接**——改 `plugins/` 源码必须重装或同步运行副本（`Copy-Item src\* dst -Recurse -Force`）
- [ ] **pnpm 因 `ERR_PNPM_IGNORED_BUILDS` 以退出码 1 结束**——官方 reconcile 只在 exitCode===0 运行 → 启动器 `reconcile_bundles` 兜底写入 bundles
- [ ] 重启服务后验证
- [ ] `--dump-config` 必须先 `$env:DSH_HOME=runtime\dsh-home` 再 dump（否则加载 `~/.dsh`）
- [ ] 类型 A: 首页 `window.__DSH_BOOT__.entries` 确认含插件 client 模块
- [ ] 类型 A: `curl /__dsh/xxx` 宿主路由 GET 返回 200
- [ ] 类型 B: 发一条消息，看 `server.log` 有没有 hook 注册日志 + 检查 system prompt 里的 context

## 五、启用 / 停用 / 移出

- [ ] 停用 = 从 `dsh.profile.bundles` 移除 + 写 `dsh.profile.disabled` 数组
- [ ] **官方 reconcile 不识别 disabled 列表会把停用包加回**——launcher 每次命令后重放停用状态
- [ ] 启停后重启服务生效
- [ ] 移除: `dsh plugin remove <包名>` 或插件管理界面

## 六、排查速查

| 症状 | 根因 | 修法 |
|---|---|---|
| `invalid plugin, expect function or object with an "apply" method` | 导出函数名不是 `apply` | 改 `export async function apply` |
| `ERR_MODULE_NOT_FOUND: ...lib/index.js` | 纯客户端插件缺宿主端 index.js | 加 no-op: `function apply(){} export { apply }` |
| WebUI 入口不显示 | `exports` 漏 `./package.json` | 补上 |
| `--dump-config` 看不到插件层 | 没设 DSH_HOME | `$env:DSH_HOME=runtime\dsh-home` |
| 改插件源码没变化 | pnpm 对 file: 是拷贝 | 同步运行副本或重装 |
| 路由 405 | 没进 exact 表 | `ctx.effect(()=>register(...))` 写法 |
| system-prompt hook 不触发 | 没 import `@deepseek-ai/dsh-system-prompt` | 补上 import |
| plugin tree 加了两个同名 context | 两个插件用了同一个 context.name | 换唯一名字 |
| `client-modules: xxx declares dsh.client but exports no "./client" bundle` | 纯 hook 插件误写了 `dsh.client` 块 | 删掉 package.json 里整个 `dsh.client` 块，只保留 `dsh.bundle.patch` |
| hook 抛异常炸掉整个请求 | 读文件失败没 try-catch | try-catch 吞掉，failSilently |
| 装完插件服务退出 | 纯客户端缺宿主端 index.js / exports 格式错 / apply 命名错 | 对照本清单零→二节排查 |
