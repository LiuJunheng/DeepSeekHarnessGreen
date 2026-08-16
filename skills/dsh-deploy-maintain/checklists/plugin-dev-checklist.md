# DSH 插件开发检查清单

## 初始搭建

- [ ] 项目目录结构完整（`lib/index.js` + `lib/client.js` + `cordis.patch.yml` + `package.json`）
- [ ] **`lib/index.js` 必须存在（哪怕纯客户端插件也要，官方 no-op：`function apply(){} export { apply }`）**——宿主 cordis loader 会 import 每个包的 main/exports["."]，缺失 → `ERR_MODULE_NOT_FOUND` → **服务启动即退出**（2026-08-16 dsh-message-actions 实测）
- [ ] `package.json` 含 `dsh.bundle.patch` 指向 `cordis.patch.yml`
- [ ] `package.json` 含 `dsh.client` 声明（`inject` + `platform: "web"`）
- [ ] `files` 数组包含 `cordis.patch.yml`（否则发布/安装后文件缺失）
- [ ] `exports` 包含 `"./package.json": "./package.json"`（否则客户端 bundle 不进 `__DSH_BOOT__`）
- [ ] `cordis.patch.yml` 内容正确（`- insert: [{id, name}]`）

## 宿主端（lib/index.js）

- [ ] 导出 `{ name, inject, apply }`（纯客户端插件可只导出 `apply`，官方 no-op 写法）
- [ ] `inject` 声明了所需服务（`webServer` 必须，其他按需）
- [ ] 路由注册使用 `ctx.effect(() => ctx.webServer.register({...}), label)` 写法（**禁止先注册再传注销函数给 effect**）
- [ ] `kind` 正确（`exact` 或 `prefix`）
- [ ] 自定义头校验（`x-dsh-plugin-xxx: 1`）防跨站触发
- [ ] 方法分发（GET 列表 / POST 写入 / 其他返回 405）
- [ ] POST 有 `readJsonBody` 解析并捕获异常
- [ ] 写回接口用 `sendJson(res, 200, { ok: true, ... })` 统一格式
- [ ] 异常处理：`try/catch` 包裹后返回 500 + 错误信息

## 客户端（lib/client.js）

- [ ] 使用 `window.__ModuleLoader__.load({ id, factory })` 加载器契约
- [ ] `apply(ctx)` 里 `ctx.slots.inject("settings.section", ...)` 注册设置区块
- [ ] 消息行类 UI 用官方插槽：`conversation.chat.assistant-actions`（已完成消息操作行，`owner={messageId}`，`order` 20+）或 `conversation.chat.turnTail`（操作行上方内容区，chain：`select` 必填 + `priority`，组件拿 `matched` + `useSession`）；读消息数据用 `snapshot.nodes`（`kind:"assistant"`+`turn`+`usage`）或 `snapshot.chat.nodes.values()`
- [ ] **宽数据（标题/长文本/明细）用卡片式纵向布局**（标题独占整行 `wordBreak`、元信息 `flexWrap` chips），别用固定列宽的横向表格（窄面板下只显示半个字）
- [ ] **插槽条目组件不要条件调用 props 传入的 hook**（`typeof useXxx === "function" ? useXxx() : null` 会触发 "Rendered more/fewer hooks" 被错误边界吞掉 → 组件不渲染）；读快照优先用 ownerProps 里的普通数据字段（如 InputZone 的 `input.draft`），hook 只能无条件调用
- [ ] 改客户端源码后**强制刷新页面即可**（bundle 按请求重新生成、rev 变化），不必重启服务；改宿主端/加减插件才需重启
- [ ] 组件内 fetch 调宿主路由时带自定义头
- [ ] 加载/删除/刷新状态管理（busy/error/result）
- [ ] 勾选列表 + 全选/全不选 + 批量操作按钮
- [ ] 操作前有确认框（`window.confirm`）
- [ ] 成功后重新加载列表
- [ ] 渲染简洁，有错误/空状态/加载中提示

## 安装与验证

- [ ] 已通过 `--install-plugin <本地目录>` 或插件管理安装到 profile
- [ ] **安装后 `dsh.profile.bundles` 已含该包**（pnpm 可能因 `ERR_PNPM_IGNORED_BUILDS` 以退出码 1 结束，启动器 `reconcile_bundles` 兜底写入；若绕开启动器手动 pnpm，需自查）
- [ ] 重启服务后验证
- [ ] `--dump-config`（**设 `$env:DSH_HOME=runtime\dsh-home`**）确认插件树已合成该插件
- [ ] 首页 `window.__DSH_BOOT__.entries` 确认含该插件模块
- [ ] `node -e "require.resolve('<插件>/package.json')"` 不抛错
- [ ] 宿主路由 GET 返回 200 + 正确数据
- [ ] 宿主路由 POST 返回 200 + 正确删除结果
- [ ] 不带自定义头的请求返回 403
- [ ] 不存在的会话/不含 ids 的 POST 正确处理
- [ ] 运行中的会话自动跳过

## 启用 / 停用（2026-08-16 新增）

- [ ] 插件管理窗口已安装列表显示状态列（启用/停用/—）
- [ ] 停用选中 → 从 `dsh.profile.bundles` 移除 + 写入 `dsh.profile.disabled`；启用选中反向
- [ ] 停用后任何插件命令执行完，状态不被官方 reconcile 加回（launcher `reconcile_bundles` 重放 disabled）
- [ ] 内置 bundle（`@deepseek-ai/dsh-base` / `dsh-web-app`）不在 dependencies 里，`reconcile_bundles` 永不触碰
- [ ] 启停后重启服务才生效（GUI 有提示）

## 移出与清理

- [ ] 已通过 `--remove-plugin <包名>` 或插件管理移除
- [ ] 重启服务后确认插件树不再含该插件
- [ ] 如需彻底卸载，删除 `node_modules` 和 `dsh.profile.bundles` 条目