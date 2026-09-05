#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
祖宗记忆库记忆引擎 · 绿色版轻量实现
============================
纯 Python 标准库 (sqlite3 + json + sys), 零外部依赖。
实现 MCP stdio 协议 (逐行 JSON-RPC), 作为 dsh-memory 插件的后端。

存储格式: SQLite 单文件
  - memories 表: id / content / tags / importance / created_at / updated_at
  - 索引: tags 倒排 + created_at 时间排序

支持的工具 (对应 MCP tools/list):
  - remember      写入一条记忆
  - recall        关键词召回 (LIKE 匹配)
  - search        内容搜索 (全文 LIKE)
  - timeline      时间线 (最近 N 条)
  - service_info  服务与库状态
  - list_all      列出全部 (调试/管理卡片用)
  - delete        按 ID 删除一条

启动方式 (MCP stdio):
  python zuzong_memory.py    # 通过 stdin/stdout 交互
"""

import json
import os
import sqlite3
import sys
import time

# ---------------------------------------------------------------------------
# 配置 (环境变量注入)
# ---------------------------------------------------------------------------
DB_PATH = os.environ.get("ZUZONG_DB", "")
if not DB_PATH:
    # 回退: DSH_HOME/memory/zuzong.db
    dsh_home = os.environ.get("DSH_HOME", os.path.expanduser("~/.dsh"))
    DB_PATH = os.path.join(dsh_home, "memory", "zuzong.db")

IDENTITY = os.environ.get("ZUZONG_IDENTITY", "祖宗记忆库")

# 确保 DB 目录存在
DB_DIR = os.path.dirname(DB_PATH)
if DB_DIR:
    os.makedirs(DB_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# SQLite 连接 (单进程单连接, 够了)
# ---------------------------------------------------------------------------
_conn = sqlite3.connect(DB_PATH, check_same_thread=False)
_conn.row_factory = sqlite3.Row
_conn.execute("PRAGMA journal_mode=WAL")
_conn.execute("PRAGMA synchronous=NORMAL")


def _init_db():
    """建表 + 增量迁移 (幂等, 向后兼容 v1.0.0 库)。"""
    _conn.execute("""
        CREATE TABLE IF NOT EXISTS memories (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            content      TEXT    NOT NULL,
            summary      TEXT,                      -- v2: AI 提炼的精简概要
            type         TEXT    DEFAULT 'raw',     -- v2: raw | user | assistant | decision | preference | fact
            tags         TEXT    DEFAULT '[]',      -- JSON 数组
            importance   REAL    DEFAULT 0.6,       -- 0.0 ~ 1.0
            note_count   INTEGER DEFAULT 0,         -- 被 recall 次数
            session_id   TEXT    DEFAULT NULL,      -- v3: DSH session UUID
            cwd          TEXT    DEFAULT NULL,      -- v3: 工作目录
            created_at   INTEGER NOT NULL,          -- Unix 时间戳 (秒)
            updated_at   INTEGER NOT NULL
        )
    """)
    # --- v1 → v2 增量迁移 (旧库没有 summary/type 列) ---
    existing_cols = [row[1] for row in _conn.execute("PRAGMA table_info(memories)").fetchall()]
    if "summary" not in existing_cols:
        _conn.execute("ALTER TABLE memories ADD COLUMN summary TEXT")
    if "type" not in existing_cols:
        _conn.execute("ALTER TABLE memories ADD COLUMN type TEXT DEFAULT 'raw'")
    # --- v2 → v3 增量迁移 (加 session_id / cwd 实现会话隔离) ---
    if "session_id" not in existing_cols:
        _conn.execute("ALTER TABLE memories ADD COLUMN session_id TEXT DEFAULT NULL")
    if "cwd" not in existing_cols:
        _conn.execute("ALTER TABLE memories ADD COLUMN cwd TEXT DEFAULT NULL")
    # 建索引
    _conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_memories_created
        ON memories(created_at DESC)
    """)
    _conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_memories_importance
        ON memories(importance DESC)
    """)
    _conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_memories_type
        ON memories(type)
    """)
    # v3: 会话隔离相关索引
    _conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_memories_session
        ON memories(session_id, created_at DESC)
    """)
    _conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_memories_cwd
        ON memories(cwd, created_at DESC)
    """)
    _conn.commit()


_init_db()


# ---------------------------------------------------------------------------
# JSON-RPC 辅助
# ---------------------------------------------------------------------------
def _write_line(obj):
    """向 stdout 写一行 JSON (MCP 协议要求逐行)。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _tool_result(text, is_error=False):
    """MCP tools/call 标准结果格式。"""
    return {
        "content": [{"type": "text", "text": text}],
        "isError": is_error,
    }


# ---------------------------------------------------------------------------
# 工具实现
# ---------------------------------------------------------------------------
def _tool_remember(args):
    """写入一条记忆 (v2: 支持 summary / type 字段)。"""
    content = (args.get("content") or "").strip()
    if not content:
        return _tool_result("content 不能为空", is_error=True)
    tags = args.get("tags") or []
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]
    importance = float(args.get("importance", 0.6))
    importance = max(0.0, min(1.0, importance))
    # --- v2 新增可选字段 ---
    summary = (args.get("summary") or "").strip() or None
    memory_type = (args.get("type") or "raw").strip()
    # type 白名单校验
    allowed_types = {"raw", "user", "assistant", "decision", "preference", "fact"}
    if memory_type not in allowed_types:
        memory_type = "raw"
    # --- v3: 会话隔离字段 (可选, 不传则 NULL) ---
    session_id = (args.get("session_id") or None) or None
    cwd_value = (args.get("cwd") or None) or None
    now = int(time.time())
    cursor = _conn.execute(
        "INSERT INTO memories(content, summary, type, tags, importance, session_id, cwd, created_at, updated_at) "
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (content, summary, memory_type, json.dumps(tags, ensure_ascii=False), importance, session_id, cwd_value, now, now),
    )
    _conn.commit()
    result = {
        "id": cursor.lastrowid,
        "content": content[:200] + ("..." if len(content) > 200 else ""),
        "summary": summary,
        "type": memory_type,
        "session_id": session_id,
        "cwd": cwd_value,
        "tags": tags,
        "importance": importance,
        "created_at": now,
    }
    return _tool_result(json.dumps(result, ensure_ascii=False))


def _tool_recall(args):
    """关键词召回 (v2: 空 query 时优先返回有 summary 的高价值条目, 有 query 时同时搜 content + summary)。"""
    query = (args.get("query") or "").strip()
    limit = int(args.get("limit", 5))
    limit = max(1, min(50, limit))
    now = int(time.time())
    rows = []
    if query:
        like = f"%{query}%"
        cur = _conn.execute(
            "SELECT * FROM memories "
            "WHERE content LIKE ? OR summary LIKE ? "
            "ORDER BY importance DESC, created_at DESC "
            "LIMIT ?",
            (like, like, limit),
        )
        rows = cur.fetchall()
    else:
        # v2: 空 query → 优先有 summary + 高 importance + 最近
        cur = _conn.execute(
            "SELECT * FROM memories "
            "ORDER BY (CASE WHEN summary IS NOT NULL AND summary != '' THEN 1 ELSE 0 END) DESC, "
            "importance DESC, created_at DESC "
            "LIMIT ?",
            (limit,),
        )
        rows = cur.fetchall()
    # 更新 note_count (召回次数 +1)
    ids = [r["id"] for r in rows]
    if ids:
        _conn.executemany(
            "UPDATE memories SET note_count = note_count + 1, updated_at = ? WHERE id = ?",
            [(now, rid) for rid in ids],
        )
        _conn.commit()
    results = []
    for row in rows:
        # 优先用 summary 展示, 没有才用 content 截断
        display_text = (row["summary"] or row["content"][:300])
        results.append({
            "id": row["id"],
            "content": row["content"][:300],
            "summary": row["summary"],
            "type": row["type"],
            "display": display_text,
            "tags": json.loads(row["tags"] or "[]"),
            "importance": row["importance"],
            "created_at": row["created_at"],
            "note_count": row["note_count"],
        })
    return _tool_result(json.dumps({"query": query, "results": results}, ensure_ascii=False))


def _tool_search(args):
    """内容搜索 (v2: 同时搜 content + summary, 返回完整 content)。"""
    query = (args.get("query") or "").strip()
    limit = int(args.get("limit", 10))
    limit = max(1, min(100, limit))
    if not query:
        return _tool_result(json.dumps({"query": "", "results": []}, ensure_ascii=False))
    like = f"%{query}%"
    cur = _conn.execute(
        "SELECT * FROM memories "
        "WHERE content LIKE ? OR summary LIKE ? "
        "ORDER BY importance DESC, created_at DESC "
        "LIMIT ?",
        (like, like, limit),
    )
    rows = cur.fetchall()
    results = []
    for row in rows:
        results.append({
            "id": row["id"],
            "content": row["content"],
            "summary": row["summary"],
            "type": row["type"],
            "tags": json.loads(row["tags"] or "[]"),
            "importance": row["importance"],
            "created_at": row["created_at"],
        })
    return _tool_result(json.dumps({"query": query, "count": len(results), "results": results},
                                    ensure_ascii=False))


def _tool_timeline(args):
    """时间线 (v3: 支持 session_id 优先; cross_session=False 时只返回当前会话自己的记忆, 不拉全局补)。"""
    limit = int(args.get("limit", 10))
    limit = max(1, min(200, limit))
    session_id = args.get("session_id")
    # v3.1: cross_session=False (默认) = 只返回当前会话自己的记忆; True = 用全局重要性补够 limit
    cross_session = bool(args.get("cross_session", False))
    if session_id:
        cur = _conn.execute(
            "SELECT * FROM memories "
            "WHERE session_id = ? "
            "ORDER BY (CASE WHEN summary IS NOT NULL AND summary != '' THEN 1 ELSE 0 END) DESC, "
            "importance DESC, created_at DESC "
            "LIMIT ?",
            (session_id, limit),
        )
        rows = cur.fetchall()
        # v3.1: 只有 cross_session=True 才用全局补 (用户主动勾选跨会话)
        if cross_session and len(rows) < limit:
            global_cur = _conn.execute(
                "SELECT * FROM memories "
                "WHERE session_id IS NULL OR session_id != ? "
                "ORDER BY importance DESC, created_at DESC "
                "LIMIT ?",
                (session_id, limit - len(rows)),
            )
            rows += global_cur.fetchall()
    else:
        cur = _conn.execute(
            "SELECT * FROM memories "
            "ORDER BY (CASE WHEN summary IS NOT NULL AND summary != '' THEN 1 ELSE 0 END) DESC, "
            "importance DESC, created_at DESC "
            "LIMIT ?",
            (limit,),
        )
        rows = cur.fetchall()
    results = []
    for row in rows:
        results.append({
            "id": row["id"],
            "content": row["content"][:200],
            "summary": row["summary"],
            "type": row["type"],
            "session_id": row["session_id"],
            "tags": json.loads(row["tags"] or "[]"),
            "importance": row["importance"],
            "created_at": row["created_at"],
        })
    return _tool_result(json.dumps({"total": len(results), "results": results}, ensure_ascii=False))

def _tool_service_info(args):
    """服务状态 (v2: 版本号 + summary 统计)。"""
    cur = _conn.execute("SELECT COUNT(*) as cnt FROM memories")
    total = cur.fetchone()["cnt"]
    cur = _conn.execute("SELECT AVG(importance) as avg_imp FROM memories")
    avg_row = cur.fetchone()
    avg_importance = avg_row["avg_imp"] if avg_row["avg_imp"] is not None else 0.0
    cur = _conn.execute("SELECT MAX(created_at) as latest FROM memories")
    latest_row = cur.fetchone()
    latest_ts = latest_row["latest"]
    # v2: summary 统计
    summarized_count = _conn.execute(
        "SELECT COUNT(*) as cnt FROM memories WHERE summary IS NOT NULL AND summary != ''"
    ).fetchone()["cnt"]
    return _tool_result(json.dumps({
        "ok": True,
        "identity": IDENTITY,
        "db_path": DB_PATH,
        "db_exists": os.path.isfile(DB_PATH),
        "total_memories": total,
        "summarized_count": summarized_count,
        "avg_importance": round(avg_importance, 3),
        "latest_memory_ts": latest_ts,
        "engine": "zuzong-memory-lite",
        "version": "3.0.0",
    }, ensure_ascii=False))


def _tool_list_all(args):
    """列出记忆 (v3: 支持 session_id / cwd / before_ts 过滤, 返回会话隔离字段)。"""
    limit = int(args.get("limit", 500))
    limit = max(1, min(5000, limit))
    offset = int(args.get("offset", 0))
    session_id = args.get("session_id")
    cwd_filter = args.get("cwd")
    before_ts = args.get("before_ts")
    where_parts = []
    params = []
    if session_id is not None:
        where_parts.append("session_id = ?")
        params.append(session_id)
    if cwd_filter is not None:
        where_parts.append("cwd = ?")
        params.append(cwd_filter)
    if before_ts is not None:
        where_parts.append("created_at < ?")
        params.append(int(before_ts))
    where_sql = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""
    cur = _conn.execute(
        f"SELECT * FROM memories {where_sql} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        params + [limit, offset],
    )
    rows = cur.fetchall()
    cur_total = _conn.execute(f"SELECT COUNT(*) as cnt FROM memories {where_sql}", params)
    total = cur_total.fetchone()["cnt"]
    results = []
    for row in rows:
        results.append({
            "id": row["id"],
            "content": row["content"],
            "summary": row["summary"],
            "type": row["type"],
            "session_id": row["session_id"],
            "cwd": row["cwd"],
            "tags": json.loads(row["tags"] or "[]"),
            "importance": row["importance"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "note_count": row["note_count"],
        })
    return _tool_result(json.dumps({"total": total, "offset": offset, "items": results},
                                    ensure_ascii=False))

def _tool_delete(args):
    """按 ID 删除一条记忆。"""
    memory_id = args.get("id")
    if memory_id is None:
        return _tool_result("缺少 id 参数", is_error=True)
    try:
        memory_id = int(memory_id)
    except (TypeError, ValueError):
        return _tool_result("id 必须是整数", is_error=True)
    cur = _conn.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
    _conn.commit()
    return _tool_result(json.dumps({"ok": True, "deleted": cur.rowcount}, ensure_ascii=False))


def _tool_batch_delete_before(args):
    """v3 批量清理: 删除指定时间戳 (秒) 之前的所有记忆。先 COUNT 再 DELETE。"""
    before_ts = args.get("before_ts")
    if before_ts is None:
        return _tool_result("缺少 before_ts 参数 (Unix 时间戳, 秒)", is_error=True)
    try:
        before_ts = int(before_ts)
    except (TypeError, ValueError):
        return _tool_result("before_ts 必须是整数", is_error=True)
    if before_ts <= 0:
        return _tool_result("before_ts 必须 > 0", is_error=True)
    cnt_row = _conn.execute(
        "SELECT COUNT(*) as cnt FROM memories WHERE created_at < ?", (before_ts,)
    ).fetchone()
    delete_count = cnt_row["cnt"]
    _conn.execute("DELETE FROM memories WHERE created_at < ?", (before_ts,))
    _conn.commit()
    return _tool_result(json.dumps({
        "ok": True, "before_ts": before_ts,
        "deleted": delete_count, "note": "此操作不可恢复",
    }, ensure_ascii=False))


def _tool_batch_delete_session(args):
    """v3 批量清理: 删除指定 session_id 的全部记忆。"""
    session_id = (args.get("session_id") or "").strip()
    if not session_id:
        return _tool_result("缺少 session_id 参数", is_error=True)
    cnt_row = _conn.execute(
        "SELECT COUNT(*) as cnt FROM memories WHERE session_id = ?", (session_id,)
    ).fetchone()
    delete_count = cnt_row["cnt"]
    _conn.execute("DELETE FROM memories WHERE session_id = ?", (session_id,))
    _conn.commit()
    return _tool_result(json.dumps({
        "ok": True, "session_id": session_id,
        "deleted": delete_count, "note": "此操作不可恢复",
    }, ensure_ascii=False))


def _tool_list_sessions(args):
    """v3 新增: 列出所有不同 session_id 分组, 供 WebUI 会话分组视图用。"""
    rows = _conn.execute("""
        SELECT
            session_id, cwd,
            COUNT(*) as cnt,
            MAX(created_at) as latest,
            MIN(created_at) as earliest
        FROM memories
        GROUP BY session_id
        ORDER BY latest DESC
    """).fetchall()
    results = []
    for row in rows:
        session_label = "全局 (未关联会话)" if row["session_id"] is None else row["session_id"]
        results.append({
            "session_id": row["session_id"],
            "session_label": session_label,
            "cwd": row["cwd"],
            "count": row["cnt"],
            "latest": row["latest"],
            "earliest": row["earliest"],
        })
    total = _conn.execute("SELECT COUNT(*) as cnt FROM memories").fetchone()["cnt"]
    return _tool_result(json.dumps({
        "total_memories": total,
        "session_count": len(results),
        "sessions": results,
    }, ensure_ascii=False))


# ---------------------------------------------------------------------------
# 工具清单 (MCP tools/list 返回)
# ---------------------------------------------------------------------------
TOOLS = [
    {
        "name": "remember",
        "description": "写入一条记忆到祖宗记忆库 (v2: 支持 AI 提炼后的 summary 和 type 分类)。content 必填；importance 0.0~1.0 (默认 0.6)；tags 可选数组或逗号分隔字符串；summary 可选精简概要；type 可选 (raw/user/assistant/decision/preference/fact)。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "要记住的完整原文"},
                "summary": {"type": "string", "description": "AI 提炼的精简概要 (可选, v2 新增)"},
                "type": {"type": "string", "description": "记忆类型 (raw/user/assistant/decision/preference/fact, 默认 raw, v2 新增)"},
                "tags": {"type": "array", "items": {"type": "string"}, "description": "标签数组 (可选)"},
                "importance": {"type": "number", "description": "重要性 0.0~1.0 (默认 0.6)"},
            },
            "required": ["content"],
        },
    },
    {
        "name": "recall",
        "description": "召回相关记忆。query 关键词 (可选, 空则返回最近 N 条); limit 默认 5。按重要性+时间排序。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "关键词 (可选)"},
                "limit": {"type": "integer", "description": "返回条数 (默认 5, 上限 50)"},
            },
        },
    },
    {
        "name": "search",
        "description": "在记忆库中搜索内容 (返回完整 content)。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索关键词"},
                "limit": {"type": "integer", "description": "返回条数 (默认 10, 上限 100)"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "timeline",
        "description": "获取记忆时间线 (v3: session_id 优先; cross_session=false 时只返回当前会话记忆, true 时全局补)。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "返回条数 (默认 10, 上限 200)"},
                "session_id": {"type": "string", "description": "当前 session UUID (可选)"},
                "cross_session": {"type": "boolean", "description": "v3.1: 是否把全局记忆也加载进来 (默认 false = 只当前会话)"},
            },
        },
    },
    {
        "name": "service_info",
        "description": "获取祖宗记忆库记忆引擎状态 (DB 路径/总条数/平均重要性等)。",
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "list_all",
        "description": "列出记忆 (v3: 支持 session_id / cwd / before_ts 过滤)。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "每页条数 (默认 500, 上限 5000)"},
                "offset": {"type": "integer", "description": "偏移量 (默认 0)"},
                "session_id": {"type": "string", "description": "按 session_id 过滤 (可选, v3)"},
                "cwd": {"type": "string", "description": "按 cwd 过滤 (可选, v3)"},
                "before_ts": {"type": "integer", "description": "created_at < 此时间戳 (可选, v3)"},
            },
        },
    },
    {
        "name": "delete",
        "description": "按 ID 删除一条记忆。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "integer", "description": "记忆 ID"},
            },
            "required": ["id"],
        },
    },
    {
        "name": "batch_delete_before",
        "description": "v3 批量清理: 删除指定时间戳之前的所有记忆。返回 {deleted: N}。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "before_ts": {"type": "integer", "description": "Unix 时间戳 (秒), 删除 created_at < 此值的记忆"},
            },
            "required": ["before_ts"],
        },
    },
    {
        "name": "batch_delete_session",
        "description": "v3 批量清理: 删除指定 session_id 的全部记忆。返回 {deleted: N}。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "session_id": {"type": "string", "description": "DSH session UUID"},
            },
            "required": ["session_id"],
        },
    },
    {
        "name": "list_sessions",
        "description": "v3: 列出所有不同 session_id 分组, 供 WebUI 会话分组视图用。",
        "inputSchema": {
            "type": "object",
            "properties": {},
        },
    },
]

TOOL_HANDLERS = {
    "remember": _tool_remember,
    "recall": _tool_recall,
    "search": _tool_search,
    "timeline": _tool_timeline,
    "service_info": _tool_service_info,
    "list_all": _tool_list_all,
    "batch_delete_before": _tool_batch_delete_before,
    "batch_delete_session": _tool_batch_delete_session,
    "list_sessions": _tool_list_sessions,
    "delete": _tool_delete,
}


# ---------------------------------------------------------------------------
# MCP 协议主循环
# ---------------------------------------------------------------------------
def main():
    """逐行 JSON-RPC 处理循环。"""
    print(f"[zuzong-memory] 启动 identity={IDENTITY} db={DB_PATH}", file=sys.stderr, flush=True)
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError as exc:
            print(f"[zuzong-memory] 非 JSON: {line[:100]} ({exc})", file=sys.stderr, flush=True)
            continue

        rid = msg.get("id")
        method = msg.get("method", "")
        params = msg.get("params", {})

        # 客户端请求 → 有 id → 必须返回 response
        if method == "initialize":
            _write_line({
                "jsonrpc": "2.0",
                "id": rid,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "serverInfo": {"name": "zuzong-memory-lite", "version": "3.0.0"},
                    "capabilities": {"tools": {"listChanged": False}},
                },
            })
        elif method == "notifications/initialized":
            # 通知 → 无 response, 忽略
            pass
        elif method == "tools/list":
            _write_line({
                "jsonrpc": "2.0",
                "id": rid,
                "result": {"tools": TOOLS},
            })
        elif method == "tools/call":
            tool_name = params.get("name", "")
            tool_args = params.get("arguments", {})
            handler = TOOL_HANDLERS.get(tool_name)
            if not handler:
                _write_line({
                    "jsonrpc": "2.0",
                    "id": rid,
                    "error": {
                        "code": -32601,
                        "message": f"未知工具: {tool_name}",
                    },
                })
                continue
            try:
                result = handler(tool_args if isinstance(tool_args, dict) else {})
                _write_line({"jsonrpc": "2.0", "id": rid, "result": result})
            except Exception as exc:
                _write_line({
                    "jsonrpc": "2.0",
                    "id": rid,
                    "error": {"code": -32000, "message": f"工具异常: {exc}"},
                })
        else:
            _write_line({
                "jsonrpc": "2.0",
                "id": rid,
                "error": {"code": -32601, "message": f"未知方法: {method}"},
            })


if __name__ == "__main__":
    main()
