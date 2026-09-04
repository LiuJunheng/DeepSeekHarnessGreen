# DSH 数据目录机制详解

> 基于实测的 dsh 数据目录内部结构，适用于排查"会话不见了""工作区冲突""归档残留"等问题。

## 工作区注册表（workspace.json）

路径：`runtime/dsh-home/storages/workspace.json`

```json
{
  "workspaces": {
    "D:\\DeepSeekHarnessLauncher": {
      "path": "D:\\DeepSeekHarnessLauncher",
      "title": "DeepSeekHarnessLauncher",
      "sessionIds": ["session-id-1", "session-id-2"],
      "createdAt": "2026-08-14T...",
      "updatedAt": "2026-08-14T..."
    }
  },
  "workspaceIds": ["D:\\DeepSeekHarnessLauncher"],
  "archivedSessionIds": ["archived-session-id-1"],
  "nativeCreated": true
}
```

- **不是会话配置**：只是展示/分组的台账，`sessionIds` 只是引用，会话的权威数据在 header 的 `cwd`。
- **archivedSessionIds**：归档的会话 id 列表，"归档"= 从 `sessionIds` 移到 `archivedSessionIds`，**日志目录和注册表条目全保留**。dsh 没有"取消归档/删归档 id"的接口。
- `workspaceIds` 控制左侧工作区选择器的显示顺序。

## 会话日志目录（sessions/）

路径：`runtime/dsh-home/sessions/<工作区路径编码>/<会话ID>/`

- 工作区路径编码规则：`D:\DeepSeekHarnessLauncher` → `--D-DeepSeekHarnessLauncher--`（`:` 变 `-`，`\` 变 `-`，每段用 `--` 包裹）。
- 每个会话一个独立目录，内含 `session.jsonl.zstd`（Zstd 压缩的 JSONL 日志，首行 header 含 `cwd` 字段）。
- 日志目录关联的附件、工具输出等也在该目录下。

## 会话投影缓存（session_projcache）

DSH 0.1.2-rc.1 **改成按 session 分文件存储**（旧版是单文件 `session_projcache.json`）。

### 新格式（DSH 0.1.2-rc.1）

路径：`runtime/dsh-home/storages/session_projcache/sessions/session-{会话ID}.json`

```json
{
  "version": 5,
  "record": {
    "rows": {
      "title": { "ver": 1, "seq": 380, "val": "AI代码辅助：文件生成测试" }
    }
  }
}
```

- **文件名有 `session-` 前缀**：`session-{uuid}.json`，不是纯 `{uuid}.json`！
- 读标题：`data.record.rows.title.val`（字符串，可能为空）。
- 缓存**可能还没写入**：新建但未对话的会话不会立即生成 projcache 条目。

### 旧格式（DHS 0.1.1 及以前）

路径：`runtime/dsh-home/storages/session_projcache.json`

```json
{ "tables": { "sessions": { "<会话ID>": { "rows": { "title": { "val": "标题" } } } } } }
```

### 三级读取策略（推荐）

1. **先试新格式**：`storages/session_projcache/sessions/session-{normalizeId}.json` → `record.rows.title.val`
2. **再试旧格式**：`storages/session_projcache.json` → `tables.sessions[id].rows.title.val`（兼容旧版）
3. **终极 fallback**：解压 `session.jsonl.zstd`，找最后一条 `session/title` 事件的 `data.title`（最可靠，覆盖所有版本）

### 注意

- 读入时**必须去 BOM**（某些版本可能带 UTF-8 BOM）。
- 只是缓存：旧行残留无害，dsh 会自行覆盖。
- 空会话返回 null 是预期行为，别当 bug。

## 插件清单（profiles/web/package.json）

dependencies 字段记录已装插件版本，`dsh.profile.bundles` 记录插件树合成条目：

```json
{
  "dependencies": {
    "dsh-archive-purge": "file:D:/.../plugins/dsh-archive-purge"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-archive-purge"]
    }
  }
}
```

## 设置文件（settings.yaml）

路径：`runtime/dsh-home/profiles/web/settings.yaml`（profile 级）或 `runtime/dsh-home/settings.yaml`（全局）

- 保存 API Key 等凭证，dsh 采用"写 tmp 临时文件 + rename 原子替换"保存。
- 安全软件（如火绒）实时扫描可能短暂锁定文件导致 `EPERM: rename`（偶发，重试即可解决）。

## 会话与会话 ID

- 每个会话有全局唯一 ID（UUID 格式，如 `a1b2c3d4-e5f6-7890-abcd-ef1234567890`）。
- 会话 ID 出现在多处：`workspace.json` 的 `sessionIds`/`archivedSessionIds`、`sessions/<编码>/session-<ID>/` 目录名、projcache 文件名（`session-<ID>.json`）。**注意：磁盘路径里统一带 `session-` 前缀，纯 UUID 是不带前缀的，代码里拼路径时要先 normalize**。
- 彻底删除一个会话 = 清理以上三处数据（服务停止后操作）。