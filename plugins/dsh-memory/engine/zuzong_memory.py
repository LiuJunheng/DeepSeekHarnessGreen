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
    """建表 (幂等)。"""
    _conn.execute("""
        CREATE TABLE IF NOT EXISTS memories (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            content      TEXT    NOT NULL,
            tags         TEXT    DEFAULT '[]',      -- JSON 数组
            importance   REAL    DEFAULT 0.6,        -- 0.0 ~ 1.0
            note_count   INTEGER DEFAULT 0,          -- 被 recall 次数
            created_at   INTEGER NOT NULL,           -- Unix 时间戳 (秒)
            updated_at   INTEGER NOT NULL
        )
    """)
    _conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_memories_created
        ON memories(created_at DESC)
    """)
    _conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_memories_importance
        ON memories(importance DESC)
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
    """写入一条记忆。"""
    content = (args.get("content") or "").strip()
    if not content:
        return _tool_result("content 不能为空", is_error=True)
    tags = args.get("tags") or []
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]
    importance = float(args.get("importance", 0.6))
    importance = max(0.0, min(1.0, importance))
    now = int(time.time())
    cursor = _conn.execute(
        "INSERT INTO memories(content, tags, importance, created_at, updated_at) "
        "VALUES(?, ?, ?, ?, ?)",
        (content, json.dumps(tags, ensure_ascii=False), importance, now, now),
    )
    _conn.commit()
    result = {
        "id": cursor.lastrowid,
        "content": content[:200] + ("..." if len(content) > 200 else ""),
        "tags": tags,
        "importance": importance,
        "created_at": now,
    }
    return _tool_result(json.dumps(result, ensure_ascii=False))


def _tool_recall(args):
    """关键词召回 (简单 LIKE + 按重要性/时间排序)。"""
    query = (args.get("query") or "").strip()
    limit = int(args.get("limit", 5))
    limit = max(1, min(50, limit))
    now = int(time.time())
    rows = []
    if query:
        like = f"%{query}%"
        cur = _conn.execute(
            "SELECT * FROM memories "
            "WHERE content LIKE ? "
            "ORDER BY importance DESC, created_at DESC "
            "LIMIT ?",
            (like, limit),
        )
        rows = cur.fetchall()
    else:
        # 无 query → 返回最近 N 条
        cur = _conn.execute(
            "SELECT * FROM memories ORDER BY created_at DESC LIMIT ?",
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
        results.append({
            "id": row["id"],
            "content": row["content"][:300],
            "tags": json.loads(row["tags"] or "[]"),
            "importance": row["importance"],
            "created_at": row["created_at"],
            "note_count": row["note_count"],
        })
    return _tool_result(json.dumps({"query": query, "results": results}, ensure_ascii=False))


def _tool_search(args):
    """内容搜索 (全文 LIKE, 比 recall 返回更全的上下文)。"""
    query = (args.get("query") or "").strip()
    limit = int(args.get("limit", 10))
    limit = max(1, min(100, limit))
    if not query:
        return _tool_result(json.dumps({"query": "", "results": []}, ensure_ascii=False))
    like = f"%{query}%"
    cur = _conn.execute(
        "SELECT * FROM memories "
        "WHERE content LIKE ? "
        "ORDER BY importance DESC, created_at DESC "
        "LIMIT ?",
        (like, limit),
    )
    rows = cur.fetchall()
    results = []
    for row in rows:
        results.append({
            "id": row["id"],
            "content": row["content"],
            "tags": json.loads(row["tags"] or "[]"),
            "importance": row["importance"],
            "created_at": row["created_at"],
        })
    return _tool_result(json.dumps({"query": query, "count": len(results), "results": results},
                                    ensure_ascii=False))


def _tool_timeline(args):
    """时间线 (最近 N 条, 按 created_at 倒序)。"""
    limit = int(args.get("limit", 10))
    limit = max(1, min(200, limit))
    cur = _conn.execute(
        "SELECT * FROM memories ORDER BY created_at DESC LIMIT ?",
        (limit,),
    )
    rows = cur.fetchall()
    results = []
    for row in rows:
        results.append({
            "id": row["id"],
            "content": row["content"][:200],
            "tags": json.loads(row["tags"] or "[]"),
            "importance": row["importance"],
            "created_at": row["created_at"],
        })
    return _tool_result(json.dumps({"total": len(results), "results": results}, ensure_ascii=False))


def _tool_service_info(args):
    """服务状态。"""
    cur = _conn.execute("SELECT COUNT(*) as cnt FROM memories")
    total = cur.fetchone()["cnt"]
    cur = _conn.execute("SELECT AVG(importance) as avg_imp FROM memories")
    avg_row = cur.fetchone()
    avg_importance = avg_row["avg_imp"] if avg_row["avg_imp"] is not None else 0.0
    cur = _conn.execute("SELECT MAX(created_at) as latest FROM memories")
    latest_row = cur.fetchone()
    latest_ts = latest_row["latest"]
    return _tool_result(json.dumps({
        "ok": True,
        "identity": IDENTITY,
        "db_path": DB_PATH,
        "db_exists": os.path.isfile(DB_PATH),
        "total_memories": total,
        "avg_importance": round(avg_importance, 3),
        "latest_memory_ts": latest_ts,
        "engine": "zuzong-memory-lite",
        "version": "1.0.0",
    }, ensure_ascii=False))


def _tool_list_all(args):
    """列出全部记忆 (调试 / 管理卡片用)。"""
    limit = int(args.get("limit", 500))
    limit = max(1, min(5000, limit))
    offset = int(args.get("offset", 0))
    cur = _conn.execute(
        "SELECT * FROM memories ORDER BY created_at DESC LIMIT ? OFFSET ?",
        (limit, offset),
    )
    rows = cur.fetchall()
    total = _conn.execute("SELECT COUNT(*) as cnt FROM memories").fetchone()["cnt"]
    results = []
    for row in rows:
        results.append({
            "id": row["id"],
            "content": row["content"],
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


# ---------------------------------------------------------------------------
# 工具清单 (MCP tools/list 返回)
# ---------------------------------------------------------------------------
TOOLS = [
    {
        "name": "remember",
        "description": "写入一条记忆到祖宗记忆库库。content 必填；importance 0.0~1.0 (默认 0.6)；tags 可选数组或逗号分隔字符串。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "要记住的内容"},
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
        "description": "获取记忆时间线 (最近 N 条, 按创建时间倒序)。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "返回条数 (默认 10, 上限 200)"},
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
        "description": "列出记忆库全部条目 (调试 / 管理卡片用, 支持分页)。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "每页条数 (默认 500, 上限 5000)"},
                "offset": {"type": "integer", "description": "偏移量 (默认 0)"},
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
]

TOOL_HANDLERS = {
    "remember": _tool_remember,
    "recall": _tool_recall,
    "search": _tool_search,
    "timeline": _tool_timeline,
    "service_info": _tool_service_info,
    "list_all": _tool_list_all,
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
                    "serverInfo": {"name": "zuzong-memory-lite", "version": "1.0.0"},
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
