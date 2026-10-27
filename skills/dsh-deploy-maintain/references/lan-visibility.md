# DSH Web 局域网/本机身份与访问控制（可复用参考）

> 来源：绿色版内置插件 `dsh-lan-visibility` 的开发研究（2026-10-27）。
> 适用场景：需要区分「本机打开」与「局域网设备访问」，或给非本机访问者做资源级权限。

## 一、DSH Web 的身份模型（关键事实）

1. **单用户、无账号体系**：所有通过浏览器访问的客户端（本机 127.0.0.1 与局域网设备）都被视为同一个 `owner` Peer。
   - `dsh-client-connection` 的 `admit()`：Host/Origin 围栏通过 + Cookie 认证通过 → 返回共享的 `this.browserPeer`（`principal: {kind:'owner'}`）。
   - 认证层：launch token（每进程一次）换 30 天签名 Cookie；绿色版 `dsh_require_auth=false` 时 launcher 补丁跳过 Cookie 校验（保留 Host/Origin 围栏）。
2. **官方已内置「非 owner 访问者」访问控制骨架**（`@deepseek-ai/dsh-api-remote-access`），当前构建无人注册策略 = 休眠：
   - 按 `principal.kind` 注册策略：`remoteAccess.registerPolicy(kind, { bindings(principal), explain? })`；
   - 网关 `dsh-api-gateway` 对非 owner 的**每次调用/每个转发事件**先 `decide()`：owner 一律放行；
     非 owner 必须命中策略绑定（资源 kind + 角色动作 + 条件），否则 `remote-access/denied`；
   - 会话列表/搜索/会话事件/投影（`dsh-api-session-controller`）与工作区流（`dsh-api-workspace-controller`）
     在业务代码内用 `remoteAccess.allows({kind:'session'|'workspace', id})` 过滤列表项；
   - 资源解析：`typert.resources.register("session", {field:"sessionId"})` / `workspace:{field:"workspaceId"}`
     → 带 `sessionId`/`workspaceId` 参数的调用自动解析资源；`page`/`follow` 用 `@Remote({resources:{session: addressedSession}})`。
3. **精确 Fetch 路由（如 `/api/file`）对非 owner 直接 403**（`createSharedFetchHandler`），无需额外处理。
4. **转发事件的资源是 GLOBAL**：`api-session/*` 等事件没有声明会话资源读取器 → `eventResources` 返回 GLOBAL →
   策略只能按 `event:<eventName>` 整体放行/拒绝。放行 = 隐藏会话的标题/cwd 元数据会泄漏给非 owner，谨慎。

## 二、可复用模式：按来源 IP 分流 + 策略限制

```
插件 apply():
1) ctx.inject(["connection","remoteAccess","typert"], (scope) => {
     const connection = scope.get("connection");
     const originalAdmit = connection.admit;
     const originalAdmitConnection = connection.admitConnection;
     const sharedLanPeer = connection.createPeer({ principal: {kind:'lan'}, interactions:'answer' });

     connection.admit = (request) => {
       const admission = originalAdmit.call(connection, request);   // 先过官方认证/围栏
       if ("rejection" in admission) return admission;               // 401/403 原样返回
       return isLoopback(request) ? admission : { peer: sharedLanPeer };  // POST /api/* 用共享 lan Peer
     };
     connection.admitConnection = (request) => {                     // WebSocket 升级
       const admission = originalAdmitConnection.call(connection, request);
       if ("rejection" in admission) return admission;
       if (admission.peer.principal.kind === "lan") {               // 每连接独占 Peer, socket 关闭时释放
         const peer = connection.createPeer({ principal: {kind:'lan'}, interactions:'answer' });
         return { peer, release: () => peer.dispose() };
       }
       return admission;
     };

     const dispose = scope.get("remoteAccess").registerPolicy("lan", policy);
     scope.effect(() => () => { connection.admit = originalAdmit; connection.admitConnection = originalAdmitConnection; dispose(); });
   });
2) isLoopback(request) = request.socket.remoteAddress ∈ {127.0.0.1, ::1, ::ffff:127.0.0.1}
   （WebSocket 升级与 POST /api/* 的 handler 收到的都是原始 IncomingMessage，有 socket.remoteAddress）
```

策略要点：
- `bindings()` 是同步函数：用 `ctx.get("sessions").list()`、`ctx.get("workspaceRegistry").list()`（同步）构造绑定；
  不要把异步查询放进 bindings。
- 动作串 = `${descriptor.namespace}/${descriptor.method}`（与网关 decide() 的 action 一致）；
  可从 `ctx.typert.local.list()` 动态枚举（版本兼容），准备兜底表。
- **坑**：`allows()` 判断的是「当前调用的动作」——`session/list` 内部的 allows 动作是 `session/list`，
  `workspace/follow` 内部对会话的 allows 动作是 `workspace/follow`。因此共享会话的绑定动作集应为
  session ∪ workspace（ ∪ 全局白名单）的并集，否则工作区流里的会话会被误剔除。
- `global` 资源（无 sessionId/workspaceId 参数的调用：list、search、create、settings、terminal、fs…）单独用
  动作白名单放行，默认拒绝，避免非 owner 触达与业务无关的宿主能力。
- 可见性/权限状态改完后调 `remoteAccess.invalidate()` 刷新快照。
- 管理接口的守卫：自定义头（防 CSRF）＋ 回环来源判断（仅本机可改权限）。

## 三、坑位清单

1. 运行时包装服务方法（monkey-patch 实例方法）不需要改官方文件，dsh 升级不还原；但插件卸载要恢复原方法。
2. `admitConnection` 官方内部先调 `this.admit()`：包装时注意顺序与 `release` 生命周期，避免 Peer 泄漏。
3. 共享 Peer 给 POST 是安全的（无事件流）；WS 必须每连接一个 Peer，否则并发连接互相关闭/泄漏。
4. 测试「局域网来源」：本机直连局域网 IP 的 socket.remoteAddress 可能是回环，**不可靠**；
   用环境变量 + 自定义头做测试开关，或真机局域网设备验证。
5. 插件自有 webServer 路由（文件浏览器/侧边栏等）绕过 remote-access 网关，需要自行加回环闸才能纳入权限体系。
