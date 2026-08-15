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

## 会话投影缓存（session_projcache.json）

路径：`runtime/dsh-home/storages/session_projcache.json`

- 缓存会话标题、统计摘要等元数据，供 WebUI 快速展示。
- 格式：`{ "tables": { "sessions": { "<会话ID>": { "rows": { "title": { "val": "标题" } } } } } }`。
- **只是缓存**：旧行残留无害，dsh 会自行覆盖。
- 读入时**必须去 BOM**（某些版本可能带 UTF-8 BOM）。

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
- 会话 ID 出现在三处：`workspace.json` 的 `sessionIds`/`archivedSessionIds`、`sessions/<编码>/<ID>/` 目录名、`session_projcache.json` 的 key。
- 彻底删除一个会话 = 清理以上三处数据（服务停止后操作）。