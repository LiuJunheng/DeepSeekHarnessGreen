# 待优化清单（dsh 0.2.2-rc.2 适配）

> 记录时间：2026-11-12
> 当前运行基线：dsh `0.2.1-rc.5` + Cordis `4.0.5` + 内置 Node `24.22.1`
> 决策：rc.2 的变更**均非阻塞**，暂不升级，先观察几个 rc 版本的稳定性与社区反馈；升级后按本清单逐项验证/处理。
> 关联：`DEV_NOTES.md` 第五节（避坑）、第十一节（system-prompt 注入）、`skills/dsh-deploy-maintain/SKILL.md` 第五章（插件开发）。

## 状态总览

| 编号 | 事项 | 优先级 | 状态 | 动手时机 |
| - | - | - | - | - |
| P1 | 侧栏文件树的官方新搜索能力被 extension 接管覆盖 | 中（功能落差） | 待决策 | 升级 rc.2 后，或用户反馈"文件树不能搜" |
| P2 | 归档会话默认清理 Git 工作树，我们的永久删除不清理 | 中（磁盘残留） | 待确认 | 升级后确认 worktree 存放位置 |
| P3 | 工具错误类型/错误码变更，影响会话回退的错误统计 | 低（统计口径） | 待验证 | 升级后拿失败会话核对一次 |

---

## P1｜侧栏文件树：官方新搜索能力被我们接管掉

**背景**

dsh `0.2.2-rc.2` 给官方内置文件树加了「按名称/路径搜索、可调整排除规则、隐藏文件显示」。
但 `plugins/dsh-sidebar-extend/lib/client.js` 以 `priority: "extension"` 接管了 `files` kind：

- `FILES_TYPE_ID = "dsh-sidebar-extend"`、`FILES_KIND = "files"`（约 L30-L31）
- `ctx.sidebarRightTabs.register({ kind: "files", priority: "extension", keepMounted: true, ... })`（约 L1002）
- `ctx.slots.inject("sidebar.right.pane.tab", ...)` 注册自己的 `FilesBody`（约 L1016）

官方 builtin 档被压过后，**官方新增的搜索/过滤界面不会出现**，用户装了本插件就享受不到。

**两个方案**

| 方案 | 做法 | 代价 | 风险 |
| - | - | - | - |
| A. 补能力 | 在 `FilesBody` 里自建搜索框：按名称/路径过滤、忽略规则、显示隐藏文件 | 中等（列表过滤 + 键盘交互 + 文案） | 与官方交互细节不一致，后续官方再升级还要跟 |
| B. 放弃接管 | 不再注册 `kind: "files"`，官方文件树回归；本插件只保留「编辑」类型 tab | 小 | 现有文件树里的右键操作（编辑/另存为/以 @ 引用插入）需要重新挂到官方树的行操作插槽上，否则功能入口减少 |

**建议**：优先评估 B —— 官方这次明确在补文件树体验，长期看"接管"是与官方赛跑；先确认官方文件树是否已提供行级动作扩展点（`sidebar.workspaces.session.menu.item` 是会话行的，不是文件行的），再决定。

**验证口径**：升级后在右侧栏打开文件 tab，确认①搜索框可见可用；②隐藏文件开关存在；③我们原有的「编辑」tab 仍能打开并保存。

---

## P2｜归档会话默认清理 Git 工作树，我们的永久删除不跟

**背景**

rc.2 起「归档会话」会默认清理符合条件的 Git 工作树（保留分支与提交；需保留本地目录时要显式关掉清理）。

我们的两条删除路径只处理会话数据，**不碰工作树**：

- `launcher.py` 的 `purge_session()`（约 L6469）：删 `sessions/<工作区编码>/<session-id>/` + 从 `workspace.json` 的 `sessionIds`/`archivedSessionIds` 移除 + 清 `session_projcache.json`
- `launcher.py` 的 `purge_archived_sessions()`（约 L6496）：对 `archivedSessionIds` 批量执行同上
- `plugins/dsh-archive-purge`：WebUI 侧只做只读列表，实际删除仍走启动器 GUI「数据维护 → 会话管理」

**风险**

- 升级**之前**就归档、且带工作树的会话，被我们永久删除后会留下孤儿目录与 `git worktree` 注册（`git worktree list` 里出现已失效条目，仓库目录越积越多）。
- 升级**之后**归档的会话由官方清理，理论上不会残留；但用户若在设置里关掉了清理，仍会残留。

**动手前必须先确认**

1. 工作树在磁盘上的实际位置（`DSH_HOME` 下哪个目录 / 是否放在原仓库 `.git/worktrees` 旁）
2. 官方用于标记"该会话有工作树"的元数据在哪（session 日志事件？`workspace.json`？独立索引文件？）
3. 删除时是否需要执行 `git worktree remove --force`（仅删目录不注销，会让 `git worktree list` 脏掉）

**方案草案**（确认后再写，**现在不要提前加逻辑**）：`purge_session()` 在删日志目录前，先按元数据定位该会话的工作树 → 优先走 `git worktree remove`，失败再退化为删目录 + `git worktree prune`；没有元数据时保持现状并打一行日志说明跳过。

**验证口径**：造一个带工作树的会话 → 归档 → 启动器永久删除 → `git worktree list` 无残留、目录已消失、仓库本身分支与提交仍在。

---

## P3｜工具错误类型/错误码变更，影响"会话回退"的错误统计

**背景**

rc.2 给工具失败提供更明确的错误类型与错误代码（旧分类的插件/SDK 需适配）。
`plugins/dsh-session-rewind/lib/index.js` 在统计错误时读的是 `d.error.code`（约 L304），取不到就归为 `"ERROR"`；前端 `lib/client.js`（约 L364）按 `summary.errorCodes` 展示分布。

**影响**

不是崩溃，是**统计变粗**：如果新版换了字段名或引入新的错误种类，分布里会出现大量 `ERROR`，按错误类型排查的能力下降。

**方案**：先看新版 `tool/result` 事件的 `data.error` 实际结构（抓一份含失败工具的会话日志），再决定是补字段映射还是补 code 白名单；**保持 `ERROR` 兜底**，不要假设一定存在新字段。

**验证口径**：拿一个有失败工具调用的会话，打开「会话回退」面板，错误分布能按具体 code 分组（不是全部 `ERROR`）。

---

## 升级时的一次性验证清单（与上面三项配套）

1. 7 个运行期补丁日志齐全（`patch_frontend` / `patch_frontend_uuid` / `patch_web_startup` / `patch_lan_trust` / `patch_commands_backoff` / `patch_lan_api_trust` / `patch_auth`）
2. 局域网 `/api` 不 403（手机用内网 IP 打开 WebUI 正常）
3. 设置页 6 个插件 tab 都在：记忆库 / 规则 / Ollama / 用量统计 / 会话回退 / 清理归档
4. 右侧栏：文件树、编辑 tab、文件右键菜单、会话右键菜单（局域网可见性项）
5. Ollama 接入 + 工具调用 + 关闭思考（`reasoning_effort=none`）全链路
6. 会话回退的错误统计能出具体 code（对应 P3）
7. 浏览器缩放 125%/150% 下，各自定义浮层仍贴住触发位置（file-browser 右键菜单、sidebar-extend 菜单、skill-center 弹层、media-background 面板）
8. AgentTeam 面板与子代理任务面板可用（rc.2 改为统一具名子代理，中断工具默认关闭）
9. 带工作树的会话：归档 → 永久删除 → `git worktree list` 无残留（对应 P2）

## 相关但无需动作（记录备查）

- **可选插件加载失败不再拖垮整个 Web 页面**：我们插件都在 `dsh.profile.bundles`，以后单插件坏了页面还能开；排查时看插件页的「未运行及原因」。
- **侧栏插件入口可收纳进「更多」**：我们注入的是 `sidebar.panellist` / `sidebar.panellist.actions`，插槽仍在，收纳行为由官方容器负责。
- **网页搜索改用 DeepSeek Search API**：本启动器与内置插件未使用搜索工具，无需迁移。
- **Session 支持批量追加事件**：我们没有包装/自定义追加接口。
- **Creator 指引统一到 `dsh-doc`**：仓库文档未引用旧 skill 名（已 grep 确认）。
- **Zod 4.6.6 / Stagehand 4.4.0**：插件未使用 zod / stagehand。
- **PTC 调用总量限制、Computer Use、Office 原生工具、LiveShare 授权、桌面端更新渠道**：均未涉及。
