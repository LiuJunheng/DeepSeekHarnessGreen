# DeepSeek Harness — Desktop Green Portable Launcher

A one-click local launcher that wraps DeepSeek Harness (`dsh`) into a **double-click-to-run** experience: no CLI, no manual Python/Node installs, no browser setup — copy the folder, double-click, go.

> **Download** (GitHub or Gitee — pick whichever is faster for you):
> - **GitHub**: [Latest Release](https://github.com/LiuJunheng/DeepSeekHarnessGreen/releases/latest) ｜ [Repository](https://github.com/LiuJunheng/DeepSeekHarnessGreen)
> - **Gitee** (faster in China): [Releases](https://gitee.com/liujunheng/DeepSeekHarnessGreen/releases) ｜ [Repository](https://gitee.com/liujunheng/DeepSeekHarnessGreen)
>
> **Other language**: 中文 — [README.md](README.md) (translated once per release; Chinese is authoritative)

---

## Feature Highlights

- **⚡ Double-click & Go**: Use `DSH_Launcher.exe` (no Python install needed) or `start.bat`. Click **Install Environment** once — everything auto-downloads and sets up.
- **🖥️ Desktop App Experience**: Opens as a **standalone desktop window** by default (embedded WebView2 — feels like a native app, fully independent from your browser). One click switches back to the **original WebUI** in your system browser. Toggle between desktop window and browser window anytime; default can be changed in Settings.
- **🌱 Truly Portable**: Node, dsh, npm/pnpm caches, session data, temp files — **everything lives under `runtime/` in this folder**. No writes to `~/.npm`, no system installs, no registry changes. Built-in portable Node and Python. Mirrors default to China; auto-falls back to official sources. Copy the entire folder to any machine — keep using it immediately.
- **📦 10 Built-in Plugins**: Session rewind/import, usage stats, file browser, archive cleanup, sidebar, background media, **Ollama local LLM integration**, **Zuzong Memory Bank (cross-session auto-memory, default OFF since v3)**, **user rules injection (similar to TRAE rules, editable in WebUI since v4)**, and more. See [Built-in Plugins](#built-in-plugins).
- **🔁 Two Independent Update Channels**: The official `dsh` core and the green-portable shell update independently — each checks its own source, backs up before overwriting, and never touches your settings or sessions.
- **🏠 LAN Remote Access**: One click to bind to `0.0.0.0` and **auto-create Windows Firewall rule** — open the WebUI from your phone or other computers on the same LAN.

---

## Quick Start (First Time)

1. Extract the zip, double-click **`DSH_Launcher.exe`** (or `start.bat`).
2. Click **Install Environment**: auto-downloads portable Node → installs dsh → deploys built-in Python (requires internet, a few minutes; npm progress is shown line-by-line).
3. Click **Start Service** — auto-opens a **standalone desktop window** (you can switch to browser window anytime).
4. In the WebUI: Settings → Models → enter your **DeepSeek API Key**, then **select a workspace** (the folder AI works on).
5. Every time after: double-click the launcher → click **Start Service**.

> Then just chat with DeepSeek in the WebUI — let AI read/write workspace files and call tools.

### Main Buttons

| Button | What it does |
|--------|-------------|
| Install Environment | Downloads portable Node + installs dsh + deploys built-in Python |
| Start / Stop Service | Launches / stops the dsh service (auto-opens UI with your default mode) |
| Desktop Window / Browser Window | Manually opens UI: **Desktop** = embedded WebView2 standalone window; **Browser** = system browser with the original WebUI (change default in Settings) |
| Check for Updates | Checks the **official dsh** (dynamic list: npm stable/pre-release + all GitHub tags). Auto-backups old version before updating. |
| Check Green Update | Checks **this launcher shell** (launcher.exe / plugins / docs). Updates are handled by the independent `DSH_Update.exe` — overlays files and restarts. |
| Plugin Manager | View / search / install / remove plugins (npm + GitHub topics, or local plugin folders). |
| Data Maintenance | With service stopped: restore (un-archive) or permanently delete archived sessions. |
| Settings | Mirror source, port, LAN binding, etc. |

> **Headless mode** (optional): `python launcher.py --start / --stop / --purge-archived / --purge-session <ID> / --restore-session <ID> / --install-plugin <folder-or-name>`.

---

## Green Portability & Data

- **Everything local**: Portable Node, dsh package, npm cache, pnpm store, sessions, temp files — all under `runtime/`. No `~/.npm`, no `~/.pnpm-store`, no user-directory leftovers.
- **Zero system pollution**: No global npm packages, no PATH changes, no registry writes.
- **Folder-level migration**: Stop service → copy the entire folder to a new machine → double-click to run. Sessions travel with it. If workspace paths differ, re-select the workspace in the WebUI.
- **Clean uninstall**: Just delete the folder. Nothing left behind.

**Lightweight distribution zip**: The release zip does **not** include `runtime/` (no pre-downloaded environment) — it's small. On a new machine: launch → click Install → click Start — three steps and you're live.

---

## Built-in Plugins

All plugins are **pure plugins** (zero modifications to official dsh files), Apache License 2.0, same as the launcher. Install via *Plugin Manager → Install Local Plugin…* → pick `plugins\<name>`. **Restart the service after install**.

| Plugin | What it does |
|--------|-------------|
| `dsh-file-browser` | Browse / preview files inside the WebUI; right-click to `@reference`, insert paths or content into chat. |
| `dsh-archive-purge` | View archived sessions in WebUI (read-only archive browser page). |
| `dsh-session-rewind` | When a session gets "poisoned" by a tool crash, one click to rewind to a good turn and branch into a clean continuation. |
| `dsh-session-import` | Re-import exported session ZIP / JSONL back to this machine (reverse of the official export). |
| `dsh-usage-stats` | Usage statistics + per-message token / cost breakdown. |
| `dsh-sidebar-lite` | Right sidebar inside WebUI (file manager / preview / browser / terminal / tasks). |
| `dsh-media-background` | Play local folder video as WebUI background (video + audio). |
| `dsh-ollama` | Auto-detects local Ollama service and integrates it — pick Ollama models directly in the model selector. |
| `dsh-memory` | **Zuzong Memory Bank**: Extracts key information from conversations into SQLite, auto-recalls and injects into the system prompt next time you chat. v3 has **Session Isolation** (session-aware grouping), **Batch Cleanup**, **Cross-Session Load Toggle**, and **Session Titles from projcache/session.jsonl**. Default OFF to save tokens. |
| `dsh-rules` | **User Rules Injection**: Like TRAE rules — write markdown files with your preferences / code style / communication requirements. Auto-injected into system prompt on every conversation. v4 upgraded to dual-end plugin: **editable directly in WebUI** (preview + textarea + .md backup download). Default OFF. |

Detailed usage in `plugins/<name>/README.md`.

### Data Maintenance (Restore / Permanently Delete Archived Sessions)

Official dsh has **no** "permanently delete session" or "un-archive" — the "archive" button only hides sessions (logs are fully retained). This launcher directly operates local data **while the service is stopped**:

- **Restore (Un-archive)**: Session reappears in the list; logs and content untouched.
- **Permanently Delete**: Irrecoverable. Logs + registry entries wiped.

Entry: main window → *Data Maintenance → Session Management* → check sessions → click *Restore Selected / Delete Selected*.

---

## Two Independent Update Channels

**Completely independent, non-interfering**:

| Channel | Updates | Entry | Source |
|---------|---------|-------|--------|
| Official Core | `dsh` itself (npm package) | *Check for Updates* | Official npm / GitHub (all tags dynamically detected) |
| Green Shell | Launcher / exe / plugins / docs | *Check Green Update* | GitHub Release (auto-falls back to Gitee mirror if unreachable) |

Core updates only touch `runtime/dsh/`. Shell updates only touch the program root directory and **skip `config.json` and `runtime/`** (your settings and sessions are safe). Before overwriting, old files are auto-backed up to `runtime/update/backup/` — if the new version breaks something, manually copy back.

---

## LAN Remote Access

Main window → *Network Settings* → service bind → pick **LAN (0.0.0.0)** → save and start. Ready log will show `LAN address: http://<local-ip>:3080`. Open it from any other computer or phone on the same LAN. *Trusted Hosts* blank = auto-trust all LAN IPs; filled = only trust listed addresses. **Privileged operations (API Key changes) still require localhost only** — that's an official dsh security measure. Localhost mode (default `127.0.0.1`) is unchanged from before.

> Also configurable in `config.json`: `mirror` (auto/cn/official), `dsh_port`, `dsh_host`, `trusted_hosts`.

---

## FAQ

| Problem | Solution |
|---------|----------|
| "Python not found" | Built-in portable Python is missing and download failed (usually network). Install Python 3 manually and check "Add to PATH". |
| Slow Node download / dsh install | Settings → switch mirror to *China* or *Official* and retry (default is already `mirror=cn`). |
| Port already in use | Change port in Settings (e.g. 3090) → save → restart. |
| Shell tool error: `Windows ACL temp root must be outside the workspace` | The workspace folder contains `runtime/tmp`. Pick the `workspace` directory in the workspace selector when starting a new conversation. |
| WebUI won't open | Check `runtime/server.log`; confirm firewall isn't blocking 127.0.0.1. |
| Setting API Key fails with `EPERM: rename denied` | Rare — security software real-time scan conflict. Retry once; if frequent, whitelist this folder in your antivirus. |
| Green update fails | The updater will show a dialog with manual download links (GitHub / Gitee release pages + direct URL). Download the zip, extract, overwrite to program root (**do NOT overwrite `config.json` or `runtime/`**). |

---

## License

This launcher as a whole (`launcher.py`, green-portable shell, built-in plugins) is licensed under **Apache License 2.0**: `Copyright (c) 2026 LiuJunheng`. See [LICENSE](LICENSE). The green-portable zip includes a copy. Runtime dependencies (`@deepseek-ai/dsh`, Node.js, portable Python, etc.) keep their own licenses and are only installed locally inside the runtime directory — not distributed with source.

---

## DSH Experience Skill

Deployment / maintenance / plugin development experience has been distilled into a TRAE Skill called **`dsh-deploy-maintain`** (source at `skills/dsh-deploy-maintain/`, contains 51 pitfalls reference). Installed globally in TRAE — available in new sessions.
