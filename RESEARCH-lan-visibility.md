# 研究:局域网模式下「工作区 / 对话」的可见性权限(仅本机可见 vs 局域网可见)

> 状态:研究完成,待决策 · 2026-10-27
> 背景:dsh_host=0.0.0.0 局域网模式下,希望可以给每个工作区或对话单独设置「只有本机打开才可见」或「局域网访问的用户都可见」。

## 一、结论(先说答案)

**可行。** 而且 DSH 官方代码里已经预留了完整的扩展点,不需要从零改造:

1. DSH Web 是**单用户、无账号体系**的:所有通过浏览器访问的客户端(本机 127.0.0.1 与局域网设备)当前**全部被当作同一个 `owner`(所有者)**,因此**今天局域网用户能看到全部会话/工作区**。
2. 但官方内置了一套专门给「非 owner 访问者」用的访问控制机制:`@deepseek-ai/dsh-api-remote-access`(方法级 Remote 访问控制)。它按 `principal.kind` 注册策略,API 网关对非 owner 的每次调用/每个事件先 `decide()`;会话列表、搜索、会话事件流、工作区列表都已经用 `allows()` 做过滤。**当前构建里没有任何包注册策略,所以这套机制处于"休眠"状态——骨架完整,一接就能用。**
3. 连接层 `@deepseek-ai/dsh-client-connection` 是唯一能看到「请求来源 IP」的地方(WebSocket 升级请求 / POST /api/* 都是原始 HTTP 请求,带 `request.socket.remoteAddress`)。官方在这里对所有已认证浏览器一律按 `owner` 放行。
4. `/api/file` 等「精确 Fetch 路由」对非 owner 已经直接返回 403(见 client-connection `createSharedFetchHandler`),即官方设计上非 owner 本来就不该碰文件路由。

因此实现路径 = **在连接层把「非回环来源」的连接标记为非 owner 的 `lan` 身份 + 注册 `lan` 策略只放行被标记为「局域网可见」的资源**。官方已有的过滤逻辑会自动生效,不需要改会话/工作区控制器。

## 二、机制详解(源码位置,便于日后维护)

### 2.1 认证与信任(现状)
| 机制 | 位置 | 说明 |
|---|---|---|
| Host/Origin 围栏 | `dsh-client-connection/lib/index.js` `isTrustedApiRequest()` | Host 必须是回环/绑定地址/trusted_hosts;已打过 launcher 补丁(忽略端口,只比 hostname) |
| launch token → Cookie | 同文件 `BrowserAuth`(`authorizeIndex/isAuthenticated/authenticateApi`) | 每个进程一个一次性 token,换 30 天签名 Cookie;`dsh_require_auth=False` 时由 launcher 补丁关闭 |
| 浏览器 Peer | `HostConnectionService.admit()` | 已认证浏览器一律返回共享的 `this.browserPeer`(`principal: {kind:'owner'}`) |
| API 操作员 Peer | `/connect?token=` → `publishPeer()` | 外部 API 客户端(非浏览器)可拿到独立 Peer,但本构建未使用 |
| 精确 Fetch 路由 | `createSharedFetchHandler()` | **非 owner 直接 403**(含 `/api/file`) |

### 2.2 访问控制骨架(remote-access)
- `dsh-typert-protocol`: `PrincipalMap` 是**可合并扩展**的类型;运行时 principal 就是 `{kind: 'xxx'}` 的 JSON。
- `dsh-api-remote-access`:`RemoteAccessService`
  - `registerPolicy(kind, policy)`:按非 owner 的 principal kind 注册业务策略,policies 以 kind 为键;
  - `decide(request)`:**owner 一律放行**;非 owner 必须有匹配的策略,`bindings` 中某资源、某角色动作、条件允许才放行;否则 `remote-access/denied`(网关抛错,转发事件直接丢弃);
  - `allows(resource)`:在业务方法内部用于**过滤列表项**,读的是「调用方 principal 的策略」——本构建里 `session/list`、`session/search`、`session/follow`、`session/projections`、`workspace/follow` 都在用它;
  - `follow()`:每 Peer 的访问快照流(客户端可用于渲染"受限视图")。
- `dsh-api-gateway`:
  - `prepareInvocation()`:非 owner 调用先解析资源(`callResources`:`sessionId` 等 lookup 参数 + 方法声明的 `resources` 读取器),再 `remoteAccess.decide(...)`;`session/attach`、`session/prompt` 等按 `session` 资源判权;
  - 转发事件:按事件声明的资源做 `decide()`,被拒事件不会到达 LAN 客户端;
  - `handleUpgrade()`:WS 升级时 `connection.admitConnection(req)` → `mux.handleUpgrade(req, socket, head, admission.peer)`,**每个 WS 连接绑定一个 Peer**,该连接上的所有流都"代表"这个 Peer;socket 关闭时 `release()`。

### 2.3 关键结论(为什么说"一接就能用")
- 会话列表/搜索/事件流/工作区列表的过滤**已经写好**,只要请求方的 principal 变成非 owner 且有策略,过滤自动生效;
- 会话按 ID 打开(attach/inspect/page/prompt 等)由网关 `decide()` 统一把关,不依赖控制器内逐处判断;
- `/api/file` 已自动 403;插件自有路由(本项目 dsh-file-browser 等)需另行处理(见 4.3)。

## 三、具体方案设计(绿色版)

### 3.1 组件
1. **连接层补丁**(1 处,幂等,沿用现有 `patch_lan_trust`/`patch_auth` 同款做法):
   - 在 `client-connection/lib/index.js` 的 `admit()` / `admitConnection()` 中按 `request.socket.remoteAddress` 分流:
     - 回环(`127.0.0.1` / `::1` / `::ffff:127.0.0.1`)→ 维持现状(owner 浏览器 Peer);
     - 非回环 → 创建 **per-connection 的 Peer**,`principal: {kind:'lan'}`(WS 连接关闭时 dispose;POST 用瞬态 Peer);
   - 与现有 `patch_lan_trust` 一样由 launcher 在 install/start 时幂等重打(dsh 升级重装会还原)。
2. **新内置插件 `dsh-lan-visibility`**(host + client,仿 dsh-usage-stats 的注入模式):
   - host:
     - 注册 `lan` 策略:动态 `bindings(principal)` 读侧车文件,把「会话可见性 / 工作区可见性」映射成允许的资源 + 允许的动作集;
     - 动作白名单(按 `ctx.typert.local.list()` 动态枚举,版本兼容):默认只放行会话交互类(`list/search/follow/page/attach/inspect/prompt/updateQueue/cancel/control/attachment` 等)与工作区只读类(`follow`);管理/配置/终端/文件类默认拒绝;
     - 提供管理路由(如 `GET/POST /__dsh/lan-visibility/*`,校验自定义头,且**仅回环可调用**):列出工作区+会话及其可见性、切换可见性(写侧车文件,原子写);
   - client:设置页新增「局域网可见性」面板(类似「用量统计」卡片):列出工作区/会话,每行一个「仅本机可见 / 局域网可见」开关;或做进会话行右键菜单(迭代再看)。
3. **侧车存储**:`DSH_HOME/storages/lan_visibility.json`(参照 `storages/workspace.json` 的落盘习惯),结构如 `{ "sessions": {"<id>": "local"}, "workspaces": {"<id>": "local"} }`;未标注 = 默认可见。
4. **launcher**:内置插件目录自动安装(现有 `install_bundled_plugins`);补丁函数新增并挂入 install/start 幂等链;README/DEV_NOTES 更新。

### 3.2 语义定义
- 「本机」= TCP 来源是回环地址(127.0.0.1 / ::1)。**注意**:从本机浏览器用局域网 IP(如 192.168.x.x)打开会被判定为「局域网」——文档里写明本机请用 127.0.0.1。
- 会话可见性默认 = 局域网可见(保持今天行为不变);可全局改为默认仅本机(配置项)。
- 工作区可见性:隐藏工作区时,其下会话按「会话自身标记」再判(默认跟随工作区);工作区列表与会话列表分别过滤,官方逻辑已支持。
- 「局域网可见」的权限粒度:建议 **可看可交互**(列表/打开/发消息),管理类(改名/归档/删除/改设置/终端/文件)默认拒绝——可配置。

### 3.3 覆盖到的入口(官方已过滤,策略接入后自动生效)
- 会话列表 `session/list`、搜索 `session/search`、会话事件流(api-session/added/removed/activity 等经网关事件 decide)、会话投影 `session/projections`、工作区流 `workspace/follow`;
- 按 ID 打开会话(attach/inspect/page/prompt 等)经网关 `decide()`;
- `/api/file` 等精确 Fetch 路由:非 owner 已 403。

### 3.4 防绕过要点(必须做,否则只是"眼不见"不是权限)
- 本项目自有插件路由(文件浏览器、侧边栏、用量统计等)不走 remote-access 网关,**必须统一加「回环校验」**:写一个共享工具函数(读 `req.socket.remoteAddress`),所有插件路由在 strict 模式下一律拒绝非回环(或复用侧车可见性)。
- 事件/流、列表、按 ID 访问三条路都必须被策略覆盖(已列 3.3),避免"猜 ID 直接打开"。

## 四、风险与注意事项

1. **dsh 升级会还原官方文件** → 连接层补丁必须幂等重打(已有体系:`install_dsh` 末尾 + `start_server` 前各打一次);插件内注册策略不受升级影响。
2. **单用户语义**:一切"用户"其实是"本机 vs 局域网"两个身份,不是多账号;同一台局域网设备的多个浏览器共享一个 `lan` 身份。
3. **token 认证与可见性正交**:局域网设备仍需要带 token 的 URL 换 Cookie(或 `dsh_require_auth=False`),这是既有行为,不在本需求范围内。
4. **客户端 UI 兼容性**:当前页面默认按 owner 渲染(`__DSH_REMOTE_ACCESS__` 注入 owner baseline)。服务端过滤后 LAN 用户看到的是"少了一部分数据的界面",功能可用;若要更漂亮的受限视图(比如隐藏"新建会话"按钮),需要额外把 index 注入改成按请求区分(可选增强)。
5. **会话归属/子代理**:subagent 会话也走 session 资源;父会话隐藏时子代理界面属于边角场景,默认跟随父会话/工作区可见性,测试时覆盖。
6. **并发写侧车文件**:切换开关与策略读取并发时,用原子写(临时文件+替换,同 `storages/workspace.json` 习惯)。
7. **性能**:`admit()` 每个请求都会调用,回环判断只是字符串比较,开销可忽略;策略 `bindings()` 每次决策调用,需读内存缓存(侧车文件变更时刷新)。

## 五、验收标准(建议)

1. 本机(127.0.0.1)访问:全部功能与今天一致;
2. 局域网设备访问:只能看到「局域网可见」的会话/工作区;隐藏会话在列表不可见、按 ID 打开报错、事件流不推送、/api/file 403;
3. 开关即时生效(无需重启服务);
4. 重启服务/断网重连后可见性设置保持;
5. 本机用户可在设置页切换任意会话/工作区的可见性;局域网用户无法调用管理路由(403);
6. dsh 升级重装后补丁与插件自动恢复。

## 六、工作量估计与实施建议

约 **1.5~3 天**:
- 连接层补丁 + 策略注册(含 per-connection Peer 生命周期):0.5~1 天;
- 侧车存储 + 管理路由 + 动作白名单枚举:0.5 天;
- 设置页「局域网可见性」面板:0.5~1 天;
- 插件路由回环闸(文件浏览器等)+ 联调实测(需真机局域网设备验证):0.5 天。

建议分两步走:第一步先做「服务端策略 + 补丁 + 管理路由」,用 curl 验证权限确实生效;第二步再做设置页 UI 与插件路由闸。

## 七、决策点(2026-10-27 已确认并实施)

1. **实施方式**:按本方案实施(已落地为内置插件 `plugins/dsh-lan-visibility/`)。
2. **默认可见性**:默认「仅本机可见」(隐私优先)。
3. **权限粒度**:共享项对局域网用户「可看可管理」(被共享的会话/工作区放行其命名空间全部动作)。
4. **插件路由闸**:暂不处理自有插件路由(文件浏览器/侧边栏等)——已知绕过面,README 已注明。

### 实施要点(与本文档设计一致)
- 连接层分流在**插件内运行时包装** `connection.admit/admitConnection` 实现,**未修改任何官方文件**,dsh 升级无需重打补丁;插件卸载恢复原方法。
- 访问策略经 `remoteAccess.registerPolicy('lan', …)` 注册;动作集从 `ctx.typert.local.list()` 动态枚举。
- 事件流(`event:*`)默认全拒:转发事件资源是 GLOBAL,放行会泄漏隐藏会话的标题/cwd 元数据;会话列表实时事件不推送(刷新后更新),已共享会话内的 `session/follow` 聊天流正常。
- 侧车文件 `$DSH_HOME/storages/lan_visibility.json`;管理路由仅回环+自定义头可调用。
- 客户端设置页卡片「局域网可见性」提供逐项开关。
- 离线逻辑验证:`plugins/dsh-lan-visibility/test/verify-visibility.mjs`(31 项全过)。
