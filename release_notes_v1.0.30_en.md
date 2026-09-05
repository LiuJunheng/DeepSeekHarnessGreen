{tag} — Zuzong Memory Bank v3: Session Isolation + Batch Cleanup

## New Features

### Zuzong Memory Bank v3 Session Isolation (dsh-memory)
- **Session-aware grouping**: Auto-recall now tags each memory with `session_id` and `cwd`; the WebUI groups memories by conversation
- **Meaningful session titles**: Three-layer fallback — `projcache` snapshot → live session cache → `session.jsonl.zstd` parsing — to display readable names instead of raw UUIDs
- **Batch cleanup**: Delete all memories for a specific session, or everything before a timestamp (two-step confirmation dialog)
- **Cross-session load toggle**: OFF by default = only inject memories from the current session; ON = also pull globally important memories
- **Instant apply**: Toggle changes (cross-session, auto-record, auto-inject) take effect immediately — no service restart required

### Architecture Upgrades
- Zero-downtime SQLite migration: old databases get `ALTER TABLE` to add `session_id`, `cwd` columns plus new indexes (`idx_memories_session`, `idx_memories_cwd`)
- Default recall limit raised to 6 memories (hard cap 10, configurable via `autoRecallLimit`)
- New `cross_session` parameter on the `timeline` tool

## Package Naming Simplified
- Before: `DSH_Launcher_GreenPortable_Online_YYYYMMDD_v{tag}.zip` (too long)
- After: **`DSH-GreenPortable-v{tag}.zip`**

## Version Bump
- `GREEN_VERSION`: 1.0.29 → {tag}
- `GREEN_ZIP_PREFIX`: `"DSH_Launcher_GreenPortable_Online_"` → `"DSH-GreenPortable-v"`

## Known Limitations
- Cross-session toggle is dimmed until "Auto-inject" is enabled (depends on auto-injection being active)
- First launch of an existing database auto-runs `ALTER TABLE` — safe, but you'll see migration log lines

## Upgrade Notes
- Just overwrite the folder with the new zip; the auto-migration handles the old SQLite schema
- If DSH fails to start after upgrade, kill `DSH_Launcher.exe` from Task Manager and reopen
