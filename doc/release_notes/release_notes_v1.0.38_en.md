v1.0.38 — Green Update Channel Redesign · Website Changelog Pagination · SEO Boost

> This release covers **11 commits across 34 files (+2592 / -241 lines)** — the largest single rollout since v1.0.31. Three major themes: a full redesign of the green-edition update channel, a redesigned changelog with pagination on the website, and SEO/misc polish.

## 🌟 Highlight: Green Edition Update Channel Redesign (Launcher GUI)

The old "Check for green updates" action used a single synchronous request and one dialog — no version history, no source switching between GitHub/Gitee. This release rewrites the whole flow to match the official dsh `ask_update` UX.

### New Features

- **Version list dialog (Treeview, grouped by channel)**: All releases grouped under "Stable" / "Prerelease" headers with a scrollable list
- **Same-version multi-source merge**: GitHub + Gitee releases are bucketed by version number so each version appears in a single row; the Source column shows `GitHub + Gitee` / `GitHub only` / `Gitee only`
- **Install confirmation with two buttons**: After picking a version, a confirmation dialog offers both "Install from GitHub" and "Install from Gitee" — missing sources are automatically disabled
- **Source-aware release notes**: Switching GitHub / Gitee in the confirmation dialog updates the release notes body to show the right source
- **Smart Gitee asset filtering**: Only zips with a `/releases/download/` direct link are kept (auto-generated archive zips that return 403 are filtered out)

### Bug Fixes

- **Critical: UI freezes forever after fetching releases**: `green_all_releases()` was missing the core bucket-and-merge block. The `merged` variable was never initialized → runtime `UnboundLocalError` → the daemon worker thread silently swallowed the exception (the worker was `try-finally` only, no `except`) → the UI stayed stuck at "Checking for updates" with no dialog or error. Both issues are fixed: the full bucket merge logic is restored, and the worker now wraps the body in `try-except-finally` with traceback + error dialog
- **Async backup / cleanup**: Slow operations (plugin removal, version backup) that used to block the UI thread now run in background daemon threads

### Key Files

- `launcher.py` — **+647 / -241 lines**, full rewrite of the green update channel (`green_all_releases`, `green_find_zip_asset`, `ask_green_update`, `confirm_green_upgrade`, ...)
- `locales/zh.json` + `locales/en.json` — 53 new `green_version_select.*` i18n keys
- `update_agent.py` — version sync

## 🌐 Website: Changelog Pagination + SEO (dsh-green.website)

The website is a three-language static site (zh / en / zh-Hant). All five page types (changelog / compare / index / about / privacy) plus the shared CSS and app.js are touched.

### Changelog Pagination Architecture (**+1690 lines**, the biggest single component here)

- **Load-more pagination**: Only the latest 3 releases are embedded directly into the HTML (good for crawlers). Clicking "Load more" appends 10 at a time
- **seed.json static fallback**: New `changelog-seed.json` (pre-generated full release list) + `changelog-seed.html` (standalone test page). When the GitHub API is unreachable, the site silently falls back to the local JSON
- **Load state & edge cases**: The load-more button stays anchored at the bottom of each chunk; `mergeReleases` now sorts by `published_at` desc instead of seed-file order
- **localStorage cache TTL lowered from 1h/2h to 15min** so new versions show up on the site faster

### SEO Boost

- All **17 pages** get `(DSH)` appended to `<title>`, `<meta name="description">`, and `<meta property="og:title">` to improve search engine discoverability
- All **4 index.html files** (zh / en / zh-Hant + root) get a Sogou site verification `<meta name="sogou_site_verification">`

### Website Files Changed

| File | Change |
|------|--------|
| `pages/assets/app.js` | Pagination logic + cache TTL + sort fix |
| `pages/assets/changelog-seed.json` | **+522 lines**, pre-generated release data |
| `pages/assets/changelog-seed.html` | **+232 lines**, standalone test page |
| `pages/assets/style.css` | +22 lines, load-more button styles |
| 3× changelog.html | Pagination skeleton + latest 3 embedded |
| 4× index.html | Sogou verification meta + SEO title |
| 3× compare.html / 3× about.html / 3× privacy.html | SEO titles aligned |

## 🔧 Misc Fixes

- **session_import plugin**: Hardcoded Chinese in the native `<input type='file'>` element replaced with a custom UI driven by i18n keys (`plugin.session_import.pick_file_btn` / `no_file_selected`)
- **Plugin package.json auto-sync**: On startup the launcher pushes `@deepseek-ai/*` dependency versions into installed plugins. This session saw `dsh-session` in `dsh-session-rewind` bump from `0.1.5-alpha.1` to `0.1.5-rc.1`, and `dsh-memory` sync as well

## 📊 Change Summary

```
34 files changed, +2592 -241 lines

├── launcher.py              +647  green update channel redesign + bugfix
├── locales/zh.json / en.json  +53  new i18n keys
├── pages/assets/app.js       +296  changelog pagination + cache + sort
├── pages/assets/changelog-seed.json  +522  static fallback data
├── pages/assets/changelog-seed.html  +232  standalone test page
├── 17 website pages          +100+  SEO + pagination skeleton
├── DEV_NOTES.md              +81   multi-source merge pitfalls
├── plugin package.json files  +8   launcher self-heal sync
└── update_agent.py            +2   version sync
```

## Version Bump

- GREEN_VERSION: 1.0.37 → 1.0.38

## Upgrade Notes

- Green edition: overwrite install is sufficient
- On first launch click "Check for green updates" — you should now see the full version list with GitHub / Gitee source selection
