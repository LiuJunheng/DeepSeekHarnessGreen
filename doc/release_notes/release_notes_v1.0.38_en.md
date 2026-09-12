v1.0.38 — Green Edition Update Channel: Fixed Missing Merge Logic That Caused UI Freeze

## Bug Fixes

- **Critical green edition update channel bug**: `green_all_releases()` was missing the core bucket-and-merge block, causing `merged` to be never initialized → runtime `UnboundLocalError` → the daemon worker thread silently swallowed the exception → the UI stayed stuck at "Checking for updates" forever with no dialog or error
- Restored the full bucket-based merge logic in `green_all_releases()`: GitHub + Gitee releases are grouped by version into `bucket[ver][source]` entries, then collapsed into `merged` with GitHub as primary source and Gitee kept as fallback
- `on_check_green_update()` worker now wraps the whole body in `try-except-finally` (was `try-finally` only); on any exception it prints a traceback + shows an error dialog, preventing future "silent freeze" states

## Technical Notes

- `green_all_releases()` returns a unified `list[dict]` where each item carries a `sources` dict keyed by `github` / `gitee_release`, directly consumable by `ask_green_update()`
- Gitee side keeps only zips with `/releases/download/` direct links (filters auto-generated archive zips which return 403)
- GitHub 37 releases + Gitee 29 releases → bucketed into 37 versions total; v1.0.34 and newer have both sources available

## Version Bump

- GREEN_VERSION: 1.0.37 → 1.0.38

## Upgrade Notes

- Green edition: overwrite install is sufficient
