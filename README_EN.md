# DeepSeek Harness Green All-in-One Launcher

> **English edition of the README.** The project is maintained in Chinese (see
> [README.md](README.md)); this English translation is refreshed on each new
> release for international users. If anything is unclear, the Chinese version
> is the source of truth.

Wraps **DeepSeek Harness** (`dsh`) into a **double-click-and-go** local launcher:
no manual install commands, no manually opening a browser. **Green all-in-one**:
Node, dsh, npm/pnpm caches, session data and temporary files all live under the
project's own `runtime/` directory only — **nothing is written to your home
directory, nothing is installed into the system**, and you can simply copy the
whole folder elsewhere and keep using it.

---

## 1. Directory Layout

```
DeepSeekHarnessLauncher/
├── start.bat              # ★ Double-click this to start (pure ASCII + CRLF)
├── stop.bat               # Double-click this to stop the service
├── launcher.py            # Core: tkinter GUI + automatic environment setup
├── DSH_Launcher.exe       # ★ Double-click this to start (exe build, no Python needed)
├── DSH_Launcher.ico       # Launcher icon (green whale, shared by window/tray/exe)
├── build_exe.bat          # Tool to package launcher.py into an exe
├── config.json            # Config (mirror / port / Node / Python versions)
├── runtime/               # ★ Auto-generated on first run; all local data lives here
│   ├── node/              # Portable Node.js (auto-downloaded)
│   ├── dsh/               # Locally installed @deepseek-ai/dsh package
│   ├── dsh-home/          # dsh data (sessions/config/storage)
│   ├── python/            # Bundled portable Python 3.10 (with tkinter, auto-downloaded)
│   ├── npm-cache/         # npm download cache (never touches ~/.npm)
│   ├── npm-userconfig     # Local npm config (blocks reading ~/.npmrc)
│   ├── pnpm-home/         # pnpm global directory (for dsh plugin management)
│   ├── pnpm-store/        # pnpm content-addressable store
│   ├── pyinstaller/       # Local PyInstaller (for exe packaging, auto-installed)
│   ├── tmp/               # Temporary files
│   ├── server.pid         # Service process ID
│   └── server.log         # Service runtime log
├── plugins/               # Built-in plugin sources (dsh-archive-purge / dsh-session-rewind / dsh-file-browser / dsh-usage-stats)
├── skills/                # This project's DSH experience Skill (installed to TRAE global skills)
└── README.md
```

## 2. Usage

> Two launch forms are provided — pick either one:
> - **exe build (recommended)**: double-click `DSH_Launcher.exe`, **no Python install required at all**
> - **script build**: double-click `start.bat`, which prefers the bundled portable Python (`runtime/python`), and only falls back to system Python if the bundled one is missing

### Prerequisites
- If using the **exe build**: nothing to install.
- If using the **start.bat script build**: on first run it auto-downloads the bundled portable Python (with tkinter) into `runtime/python`; system Python is no longer needed afterwards. Only if the bundled Python download fails do you need to install Python 3 manually (check "Add Python to PATH") as a fallback.

### First Run
1. Double-click **start.bat** (or `DSH_Launcher.exe`).
2. A small launcher window pops up with a **status indicator** at the top (green = running / yellow = ready / gray = not installed).
3. First time: click **【Install Environment】**, it runs automatically (needs network, a few minutes; **npm install shows progress line by line in real time**, so you can confirm it isn't stuck or failing):
   - Downloads portable Node.js v22 into `runtime/node` (domestic mirror first, falls back to official on failure).
   - Installs `@deepseek-ai/dsh` locally into `runtime/dsh`.
   - Fills in the bundled portable Python into `runtime/python`.
4. When the status light turns yellow, click **【Start Service】** → browser opens automatically → `http://127.0.0.1:3080`.
5. In the web UI: Settings → Models → enter your DeepSeek API Key; then **choose a workspace** (pick the project folder you want the AI to work on).
6. Afterwards, every time: double-click start.bat (or exe) → yellow light means ready → click **【Start Service】**, opens instantly.

### Button Reference
| Button | What it does | When enabled |
|--------|--------------|--------------|
| Install Environment | Download portable Node + install dsh + fill in bundled Python | Environment not installed / service not running |
| Start Service | Launch the dsh web service and auto-open the browser (doesn't open a new page if the UI is already open) | Environment ready & service not running |
| Stop Service | Stop the dsh service | Service running |
| Open UI | Manually open the dsh UI in the browser (**always opens a new page**, not limited by single-page dedup) | Service running |
| Check Update | Query the latest dsh version on npm; if newer, prompt you to update; backs up the old version to `runtime/dsh-backup-<version>` first (non-destructive, deletable) | Environment installed & service not running |
| Check Green Update | Query this project's latest GitHub Release (the green edition's outer layer: launcher/plugins/docs); when found → download to `runtime/update/` → exit the launcher → auto-overwrite and restart. **Does NOT replace `config.json` (your settings) or `runtime/` (your data)**; old files are backed up to `runtime/update/backup/`. See Section 7 | Service not running |
| Plugin Manager | Open plugin management window: view installed plugins, search plugins (npm registry + GitHub official `dsh-plugin` topic), install/remove plugins (see Section 5) | Environment ready |
| Data Maintenance | Main window「Data Maintenance」section (stop the service first): **Session Manager** button → session list, **tick (all/individual)** to **restore (unarchive)** or **permanently delete** selected sessions, see Section 6 | After service stopped |
| Refresh Status | Manually re-check environment & service status | Anytime |
| About (top-right) | Open「About」dialog: author, version, release date, this repo and official dsh repo links (clickable), plus **Green All-in-One · Localization notes** (all files & dependencies fully localized) | Anytime |
| Minimize | Minimize to taskbar (taskbar icon stays), **tray icon stays resident from startup**; click the taskbar or tray icon to restore | Anytime |
| X (top-right) | Shows a second confirmation first (avoid accidental close), then auto-stops the dsh service and exits | Anytime |
| Duplicate-launch guard | If the launcher is already running (including minimized to taskbar / running in tray background), opening it again does NOT start another service; it brings the running window to the front instead | Anytime |

> **Dedicated icon**: the launcher uses a custom **green whale** icon (`DSH_Launcher.ico`), shared consistently across taskbar / system tray / exe file, so it's instantly recognizable as the DSH green edition (no more default PyInstaller icon).

> **WebUI single-page dedup**: the launcher injects a heartbeat script into the WebUI page; the page reports to `127.0.0.1:3081` every 15 seconds. When **auto-opening** (after starting the service), if it detects the UI is already open in the browser (heartbeat within 180 seconds), it does **not** open a new page, avoiding a pile of identical tabs after repeated restarts. **Manually clicking「Open UI」is not limited by this — it always opens a new page.** You can uncheck *Auto-open browser after starting service* in Settings (corresponds to `auto_open_browser` in `config.json`; port adjustable via `ui_beacon_port`).

### Stopping
- Click **【Stop Service】** in the launcher, or double-click **stop.bat**.
- Clicking the top-right **X** shows a **second confirmation** first (avoid accidental close), then stops the service automatically.
- Clicking **Minimize** shrinks to the **system tray** to run in the background; click the tray icon to restore. To fully quit, still use the top-right X (or the X when the tray icon has no right-click menu).

### Headless Mode (optional)
```bat
python launcher.py --start                 :: start (daemon mode: keeps this window running; close the window or stop.bat to stop)
python launcher.py --stop                  :: stop
python launcher.py --purge-archived        :: permanently delete all archived sessions (stop the service first)
python launcher.py --purge-session <ID>    :: permanently delete a specific session (stop the service first)
python launcher.py --restore-session <ID>  :: restore (unarchive) a specific session (stop the service first)
python launcher.py --install-plugin <local-plugin-dir-or-npm-package> :: install a plugin (pass a local directory path directly)
```

## 3. Configuration (`config.json`)

| Field | Description | Default |
|-------|-------------|---------|
| `mirror` | Mirror source: `auto` (domestic first, fall back to official) / `cn` domestic / `official` official | `auto` |
| `node_version` | Portable Node version | `22.20.0` |
| `python_version` | Bundled portable Python version | `3.10.20` |
| `python_release` | python-build-standalone release tag (date) | `20260807` |
| `dsh_port` | Service port | `3080` |
| `dsh_package` | dsh package name | `@deepseek-ai/dsh` |
| `tmp_dir` | Temp directory (empty = default `runtime/tmp`, green all-in-one; any absolute path allowed) | empty |
| `default_workspace` | Default workspace (empty = auto-resolve: program root if no conflict, otherwise the `workspace` subfolder inside the program dir; custom absolute path allowed, auto-fallback + warning on temp-dir conflict) | empty |
| `dsh_host` | dsh web service bind address: `127.0.0.1` = local only / `0.0.0.0` = other computers on LAN can open the WebUI remotely | `127.0.0.1` |
| `trusted_hosts` | Trusted host list (array; elements are host or host:port). **Empty (default) = auto-trust all LAN IPs when bound to LAN; if any is filled = only the filled addresses are trusted, no blanket LAN-wide access** | `[]` |

You can also change the mirror and port in the launcher UI 【Settings】(network-related 【Network Settings】is in the next subsection), then click 【Save Settings】.

### Network Settings (LAN Remote Access)
> To let **other computers' browsers** open the dsh WebUI deployed on this machine remotely (e.g., one server computer + multiple client computers), configure as follows.

- In the main window's「Network Settings (LAN Remote Access)」section →「Service Binding」choose **「LAN (allow LAN access 0.0.0.0)」** →「Save Network Settings」(takes effect next time the service starts).
- After saving, click **【Start Service】**; the ready log shows an extra line `LAN access address: http://<this-machine-IP>:3080`. Other computers on the LAN can open that address in a browser to use the WebUI (chat and tool calls work normally).
- 「Trusted Hosts」**empty (default) = auto-trust all LAN IPs** (simplest: every computer on the LAN can open it); **if any is filled = only the filled addresses are trusted** (e.g., only allow a specific host `my-server.local` or `192.168.1.10:3080`), multiple separated by commas.
- **Security boundary (please be aware)**: choosing LAN mode with empty trusted hosts = **the whole LAN subnet is open**, any device that can reach this machine's LAN IP can open and operate the WebUI (can run tools); filling trusted hosts restricts access to only those hosts. dsh's **Settings / credentials (API Key) privileged operations remain local-only** (remote browsers get 403), which is official security protection. Local mode (default `127.0.0.1`) is exactly as before — local only.
- Equivalent CLI/config: `dsh_host` (`127.0.0.1` / `0.0.0.0`) and `trusted_hosts` (array) in `config.json`.

## 4. Green All-in-One Notes
- **Fully localized**: portable Node, dsh package, npm cache, pnpm store, session data, temp files — all under `runtime/`, nothing written to your home directory (`~/.npm`, `~/.pnpm-store`, etc. are never created).
- **No system pollution**: no global npm packages, no PATH changes, no registry writes.
- **Whole-folder migration**: copy the entire folder to any location / another computer, double-click start.bat and keep using it (sessions travel with it).
- **Clean uninstall**: just delete the whole folder.
- **Automatic default-workspace resolution**: because the temp directory sits inside the program directory, dsh's ACL sandbox forbids the workspace from containing it. On startup the launcher **auto-detects**: when the program root conflicts with the temp dir, the default workspace automatically uses the `workspace` subfolder inside the program dir and pre-registers it in the workspace list; when there's no conflict it uses the program root directly. No manual config needed (see `default_workspace` in `config.json`).

### Migrating to a New Computer (full steps)
1. **Stop the service on the old computer first**: double-click `stop.bat` (or 【Stop Service】 in the launcher) so no process holds the files and the copy is complete.
2. **Copy the whole `DeepSeekHarnessLauncher` folder** (≈528 MB) to the new computer, any location is fine (the program locates itself by its own path, nothing hardcoded).
3. **Optional cleanup** (cleaner & smaller migration):
   - Delete `runtime/server.pid`, `runtime/server.log` (old state leftovers).
   - Empty `runtime/tmp` (temporary files).
   - Optionally delete `runtime/npm-cache` (pure download cache; deleting doesn't affect use, only re-downloads if you reinstall dsh later).
4. **New computer prerequisites**: **install nothing**. Use `DSH_Launcher.exe` directly, or `start.bat` (bundled portable Python is in runtime); only if the bundled Python download fails do you need to install system Python. **No need to install Node** (portable version is in runtime).
5. **Start**: double-click `DSH_Launcher.exe` (or `start.bat`) → 【Start Service】. API Key, settings, plugins, session history all come along.
6. **Workspace note**: dsh records sessions by "workspace absolute path" (see `runtime/dsh-home/storages/workspace.json`). If the new computer's workspace path differs from the old one, re-select/add the workspace in the web UI (old session data remains, not deleted); if the path matches it's fully seamless.

### Lightweight Distribution Zip (slim online edition, ≈8 MB)
> Compared to whole-folder migration, this zip **does NOT contain `runtime/` (no pre-downloaded environment or sessions)**; on a new machine the launcher auto-downloads Node / Python / dsh after connecting to the network. Small size, ideal for GitHub Release distribution.
>
> Packed contents (the project root "shipping list"): `launcher.py`, `start.bat`, `stop.bat`, `build_exe.bat`, `DSH_Launcher.exe`, `config.json`, `README.md`, `README_EN.md`, `DEV_NOTES.md`, `.gitignore`, `plugins/dsh-archive-purge/`, `plugins/dsh-session-rewind/`, `plugins/dsh-file-browser/`, `plugins/dsh-usage-stats/`, `skills/dsh-deploy-maintain/`.

- **Latest download** (GitHub Release, tag `v1.0.6`): <https://github.com/LiuJunheng/DeepSeekHarnessGreen/releases/latest>
- Repository: <https://github.com/LiuJunheng/DeepSeekHarnessGreen>

Three steps on a new machine:
1. Extract to any directory (e.g., `E:\DeepSeekHarnessLauncher`), double-click **start.bat** (or `DSH_Launcher.exe`);
2. Click **【Install Environment】**, wait for the auto-download of portable Node + dsh install + portable Python (needs network, a few minutes);
3. Click **【Start Service】** → in the web UI enter your API Key and select a workspace (it's recommended to pick the auto-registered `workspace` inside the program dir to avoid the ACL temp-dir conflict).

To regenerate this zip (run in the project root in PowerShell):
```powershell
Compress-Archive -Path launcher.py, start.bat, stop.bat, build_exe.bat, DSH_Launcher.exe, config.json, README.md, README_EN.md, DEV_NOTES.md, .gitignore, "plugins", "skills" -DestinationPath DSH_Launcher_GreenPortable_Online_<date>.zip -CompressionLevel Optimal
```
> **Important (zip structure)**: for plugins/skills you MUST pass the **directory names** `"plugins"` / `"skills"` (keeping the `plugins/`, `skills/` prefixes inside the zip). **Do NOT** pass sub-paths like `"plugins\dsh-archive-purge"` — `Compress-Archive` would put that directory at the zip root and **drop the `plugins/` prefix**, so an update would copy the plugin into the program root by mistake (see DEV_NOTES requirement #21). After packing, confirm with `tar -tf xxx.zip` (or File Explorer) that the zip root contains `plugins/`, `skills/` folders and files like `launcher.py`.
>
> **(2026-08-16 addition)**: if `skills/` still contains `Skill-dsh-deploy-maintain.zip` (the Skill sync package), passing `"skills"` will pack it into the green zip too. Before packing, move it out (e.g., `Move-Item skills\Skill-dsh-deploy-maintain.zip %TEMP%\`), then move it back after packing, to avoid nesting a redundant sync zip inside the green zip.

## 5. Plugin Management

> Once the environment is ready (Node + dsh installed), click **【Plugin Manager】** in the main window to open the plugin management window.

### Window Layout
- **Left「Installed Plugins」**: plugins installed in the current profile (`web`) (columns: name / version / **status** — enabled / disabled / —), with a vertical scrollbar; **right-click** an entry to open the npm page or GitHub search, or copy the package name; selecting one enables 【Remove Selected Plugin】, 【**Enable Selected**】, 【**Disable Selected**】(enable/disable requires a **service restart** to take effect), 【Refresh】.
- **Right「Search Results」**: search results (source / version / description), with a vertical scrollbar; right-click works the same as the left; selecting one enables 【Install Selected Plugin】.
- **Top toolbar**:
  - Search box +【Search】: search the **npm registry** (domestic mirror first) by keyword, showing **only dsh-related installable plugins** (irrelevant packages filtered automatically);
  - 【Load Recommended】: one-click show the built-in **12 verified dsh plugins** (e.g., `@dsh-external/dsh-vision-toolkit`, `dsh-remote`, `dsh-lark-bot`, etc.), no network/GitHub needed to see installable items;
  - 【Load GitHub Trending】: fetch popular repos from the **GitHub official `dsh-plugin` topic page** (`https://github.com/topics/dsh-plugin`) (≈20 by stars);
  - 【Open Official Topic】: open the topic page in the browser to browse the full list by page.
- **Bottom manual-install bar**: enter an npm package name directly (e.g., `dsh-remote`) or `github:user/repo#commit` to install a specific version; or click **「Install from local plugin folder…」** to pick any local plugin directory containing `package.json` and install it in one click (local plugins need a **service restart** to take effect). The file dialog **defaults to this repo's `plugins/` directory** (falls back to the program root if missing), handy for installing built-in plugin sources directly. CLI equivalent: `python launcher.py --install-plugin <local-dir-or-package>`.
- The bottom status bar shows progress in real time ("installing / installed / N results found", etc.).

### Notes
- Plugins are actually installed under `runtime/dsh-home/profiles/web/` (the profile's `node_modules` and `package.json`) via `dsh plugin` (which forwards to pnpm internally), **green all-in-one**: pnpm and its store are under `runtime/`, nothing written to the home directory.
- **Automatic orchestration layer after install**: after any plugin install / remove / enable / disable, the launcher automatically writes dependencies that declare `dsh.bundle.patch` into the profile's `dsh.profile.bundles` (even if pnpm ends with exit code 1 due to `ERR_PNPM_IGNORED_BUILDS` build-script warnings, it still syncs as a fallback; **no manual package.json editing needed**); after a service restart the plugin loads.
- **Enable / Disable toggle**: installed plugins can be disabled in one click (removed from the orchestration layer, dependencies kept; state recorded in `dsh.profile.disabled`) or re-enabled; takes effect after a service restart.
- On first use of the plugin manager, the launcher auto-installs pnpm into `runtime/pnpm-home` using portable Node.
- GitHub-source repos aren't necessarily npm packages, so install failure is normal; the window shows the reason. You can switch to the same-named package in the npm registry.

### Built-in Plugin: dsh-file-browser (WebUI file browse / preview / right-click add to conversation)
The launcher's `plugins/` ships with **`dsh-file-browser`**: after installing and restarting the service, a「📁 File」button appears on the left of the WebUI input's tool row; clicking it opens a right-side floating file browser — directory listing (dirs first), text/code and image preview, path-input jump, up/refresh; **right-click a file or directory** to append its **path** or **content** (≤3000 chars, truncated with a note if longer) to the input draft (editable before sending), or **copy the path**. It's a pure plugin (modifies no official files); install via「Plugin Manager → Install from local plugin folder…」selecting `plugins/dsh-file-browser` (CLI equivalent: `python launcher.py --install-plugin plugins\dsh-file-browser`). See [plugins/dsh-file-browser/README.md](plugins/dsh-file-browser/README.md).

> FAQ: after installing, if you don't see the「File」button in the input row → usually the service wasn't restarted / the plugin `exports` is missing `"./package.json"` / the source was changed without reinstalling; see the plugin README's「Troubleshooting」section.

## 6. Data Maintenance (restore / clean up sessions)

> dsh officially has **no** "permanently delete session" or "unarchive" feature: archiving in the web UI only **hides** the session (log files and registry entries are all kept). This launcher operates directly on the local data files **after the service is stopped**, and can:
> - **Restore (unarchive)**: remove the session id from `global.archivedSessionIds` in `workspace.json`; the session reappears in the WebUI session list, **logs and content unaffected** (like recalling a banished general into service — no blame for the past).
> - **Permanently delete**: fully remove the log directory + registry entry, **irreversible** (like stripping a title and never rehiring).

| Operation | Where | Description |
|-----------|-------|-------------|
| Session Manager | Main window「Data Maintenance」section | Opens a session list (title / workspace / status / has logs), **tick (select all / none / single)** then **Restore Selected** (only effective for "archived" sessions) or **Permanently Delete Selected** |
| CLI | `--restore-session <ID>` | Restore (unarchive) a specific session |
| CLI | `--purge-archived` / `--purge-session <ID>` | Permanent delete: the former clears all archived, the latter deletes a specific session |

- **Restore** only changes `archivedSessionIds` in `storages/workspace.json` (atomic write-back: temp file + `os.replace`), doesn't touch logs or workspace ownership; restoring a non-archived or non-existent session safely returns "nothing to do".
- **Delete** cleans three sources at once:
  1. Session log dir `runtime/dsh-home/sessions/<workspace-code>/<session-ID>/`
  2. The `sessionIds` / `archivedSessionIds` entries in `storages/workspace.json`
  3. That session's title / stats cache line in `storages/session_projcache.json`

Notes:
- **You must stop the service first** (the GUI pops a warning; the CLI validates and errors out if the service is running).
- Deletion is **irreversible**, with confirmation prompts before every delete; restore doesn't remove data and is safe.
- Running sessions are never cleaned up.

### Companion: Built-in「Archive Purge」WebUI Plugin
The launcher's `plugins/` ships with **`dsh-archive-purge`**: after installing and restarting the service, you can **view** the archived session list in the WebUI「Settings → Archive Purge」(tick/select-all interaction kept). Because all sessions are "running" while the service is up, the WebUI **cannot delete directly**, so this page is **read-only display** — real deletion/restore happens in the launcher GUI: **click「Stop Service」→ main window「Data Maintenance」→「Session Manager」→ tick sessions →「Restore Selected」or「Delete Selected」**. It's a pure plugin (modifies no official files); install via「Plugin Manager → Install from local plugin folder…」selecting `plugins/dsh-archive-purge`. See [plugins/dsh-archive-purge/README.md](plugins/dsh-archive-purge/README.md).

> FAQ: after installing, if「Archive Purge」isn't visible in the WebUI settings → usually the plugin `package.json`'s `exports` is missing `"./package.json"` (or the source was changed without reinstalling); see the plugin README's「Troubleshooting」section.

### Companion: Built-in「Session Rewind」WebUI Plugin
The launcher's `plugins/` ships with **`dsh-session-rewind`**: solves the problem of dsh sessions being **permanently poisoned** after a tool-run crash (`Cannot read properties of undefined (reading 'prepare')`) — the crashed turn leaves orphan `tool_calls` in the log, and every later turn is rejected with API 400. After installing and restarting the service, the WebUI「Settings → Session Rewind」can: list all sessions →「Analyze」any session (per-turn info: user question / step count / tool-call count / error-code stats / completeness) → click「Rewind to here」on any **completed** turn, which calls the official `session.fork` to derive a **clean continuation session** from that turn and opens it automatically (the original session is kept and can be cleaned up later via「Session Manager」). The UI is **card-based layout** (session titles and user-question descriptions each take a full row and are fully readable, with workspace/creation time/steps/tool calls below, in the same style as usage stats). It's a pure plugin (modifies no official files); install via「Plugin Manager → Install from local plugin folder…」selecting `plugins/dsh-session-rewind` (CLI equivalent: `python launcher.py --install-plugin plugins\dsh-session-rewind`). See [plugins/dsh-session-rewind/README.md](plugins/dsh-session-rewind/README.md).

### Built-in Plugin: dsh-usage-stats (usage stats + per-turn "this turn tokens")
The launcher's `plugins/` ships with **`dsh-usage-stats`** (v0.2.0, one plugin with two feature surfaces, installed/uninstalled together):

1. **Settings page「Usage Stats」**: scans **all local session logs**, aggregates token usage per model call, and supports **cost estimation**. Overview cards (sessions / total turns / input / output / cache / thinking tokens + estimated cost, per-model breakdown); **editable price table** (yuan / per million tokens, per official billing as「input uncached / input cached / output」columns, default official current prices, stored in browser localStorage); **session card list** (title takes a full row, meta info wraps) +「Details」expands **per-turn cards** (user message takes a full readable row, with turn number / steps / tool calls / output tk / estimate / model / completion status below).
2. **Per-turn「this turn tokens」on message rows**: above the action row of every **completed assistant message**, a right-aligned resident readout of that turn's actual token usage — `this turn tokens: input(uncached) 3.3k · input(cached) 832.3k · output 4.6k · thinking 3.7k` (k/M abbreviations, classified per official billing; thinking is already counted in output and not double-billed; data is the sum of `usage` from all `assistant/message` events in that turn, same source as the panel; the official hover duration/first-token/rate is unaffected).

Data is decoded directly from session logs (`session.jsonl.zstd`, zstd multi-frame, same mechanism as `dsh-session-rewind`); **cost is an estimate** (logs don't contain cost; estimated from the price table, for cost reference only). Install via「Plugin Manager → Install from local plugin folder…」selecting `plugins/dsh-usage-stats` (CLI equivalent: `python launcher.py --install-plugin plugins\dsh-usage-stats`). See [plugins/dsh-usage-stats/README.md](plugins/dsh-usage-stats/README.md).

> Note: the per-turn「this turn tokens」was originally a standalone plugin `dsh-turn-tokens` (v0.1.0); it was merged into this plugin since v0.2.0. If you installed it in an older version, remove it before installing this plugin to avoid duplicate display.

## 7. Green-Edition Self-Update (Dual-Channel Update)

This green edition supports **two fully independent, non-interfering update channels**:

| Channel | What it updates | Entry | Update source |
|---------|-----------------|-------|---------------|
| Official core | dsh itself (the npm package in `runtime/dsh/`) | 「Check Update」 | Official npm / GitHub |
| Green-edition outer layer | launcher `launcher.py` / `DSH_Launcher.exe` / `plugins/` / docs etc. | 「Check Green Update」 | This project's GitHub Release |

Each channel judges its own version, downloads its own updates, and backs up separately — **they never touch each other**: core updates only touch `runtime/dsh/`, outer updates only touch the program root (skipping `config.json` and `runtime/`).

### Green-Edition Outer-Layer Update Flow
1. Click「Check Green Update」(stop the service first) → query the latest GitHub Release (official API falls back to a domestic mirror on failure).
2. If newer, a dialog shows the version comparison and update notes → after confirming, download the distribution zip into `runtime/update/` (with progress, size verified).
3. Auto-extract and generate the overwrite-install script (`runtime/update/update_apply.bat`).
4. After confirming, **exit the launcher**, and the background script completes automatically: wait for the file lock to release → back up old files to `runtime/update/backup/` → overwrite the program root (skipping `config.json` / `runtime/` / `.git`) → auto-restart the new launcher.

### Safety & Rollback
- **Does NOT replace** `config.json` (your custom port/mirror settings) or `runtime/` (your session data / installed environment).
- Old files are auto-backed up to `runtime/update/backup/` before overwrite; if the new version has issues you can manually copy them back to the root to roll back.
- Distribution zip naming convention: `DSH_Launcher_GreenPortable_Online_<date>_v<version>.zip`, Release tag `v<version>` (currently `v1.0.6`).
- Built-in plugin sources update with the green edition, but plugin copies **already installed** into `runtime/dsh-home/profiles/web` are pnpm copies; reinstall the local plugins via「Plugin Manager」for them to take effect.

## 8. Built-in Python & exe Packaging

### Why Python / Built-in Python
- **What launcher.py does**: the launcher itself is written in Python, responsible for「auto-download portable Node → install dsh locally → start the service → open the browser」and provides the tkinter GUI. So running the launcher **needs** a Python interpreter.
- **Built-in portable Python**: the Python 3.10 under `runtime/python` (full version, with tkinter), preferred by `start.bat`. If missing on first launch it auto-downloads from a mirror (domestic `mirror.nju.edu.cn` first, falls back to GitHub), **not installed into the system, no pollution**, and migrates with the folder.
- **exe build**: PyInstaller packages launcher.py into `DSH_Launcher.exe`; the interpreter and standard library are embedded in the exe, so **no Python is needed at runtime** — double-click and go, closest to a "green portable software" experience.

### Which Launch Form to Pick
| Form | Entry | Needs Python? | Size / notes |
|------|-------|---------------|--------------|
| exe build | double-click `DSH_Launcher.exe` | No | single-file exe (≈8 MB) with embedded interpreter; program root must be on the same level as `runtime/` |
| script build | double-click `start.bat` | No (uses bundled) | relies on `runtime/python` (≈200 MB); falls back to system Python only if bundled is missing |

> Note: the exe and start.bat share the same `runtime/`; use either one, data is fully interchangeable.

### Rebuilding the exe
After editing `launcher.py`, double-click **build_exe.bat** to update the exe:
1. Auto-locate Python (bundled first, then system).
2. Install PyInstaller locally into `runtime/pyinstaller` (Tsinghua mirror; no system-environment changes, no C drive).
3. Package the single-file `dist\DSH_Launcher.exe` and copy it to the project root.

### Manually Downloading the Built-in Python (optional)
If you don't want to wait for the auto-download, manually extract python-build-standalone's `cpython-3.10.20+20260807-x86_64-pc-windows-msvc-install_only.tar.gz` into `runtime/python`; either `runtime/python/python.exe` or `runtime/python/any-subfolder/python.exe` is recognized.

## 9. Security Notes
- The service only binds `127.0.0.1` (local loopback) by default; it's not exposed to the public internet.
- All file reads/writes and command executions happen inside your chosen **workspace**.
- When operating in the web UI for the first time, read the high-risk command confirmation dialogs carefully before clicking allow.

## 10. DSH Experience Skill

The deployment / maintenance / plugin-development experience accumulated in this project is organized into a TRAE Skill: **`dsh-deploy-maintain`**.

- Source files are in the project's `skills/dsh-deploy-maintain/` (main document `SKILL.md` + `checklists/` checklists + `references/` plugin skeleton & data-directory details).
- Installed into TRAE's global skills (`~/.trae-cn/skills/dsh-deploy-maintain/`), usable directly in new sessions.
- Contents: green all-in-one deployment (portable Node / env-var redirection / workspace ACL sandbox / exe packaging), daily maintenance (update backup / plugin management / data maintenance), DSH plugin development (dual-end loading / `ctx.effect` route registration / `exports` pitfalls), with 51 pitfalls condensed into a troubleshooting quick-reference table.

## 11. FAQ

| Issue | Fix |
|-------|-----|
| "Python not found" | The bundled portable Python is missing and its download failed (usually a network issue). Follow the hint in start.bat to install Python 3 manually with "Add to PATH" checked as a fallback |
| Node download slow / failing | In the UI settings, switch the mirror to "domestic" or "official" and retry |
| dsh install slow / stuck for a long time | The official npm registry is slow to reach from China; switch the mirror to "domestic (npmmirror)" in the UI settings or `config.json`, save and retry (this green edition defaults to `mirror=cn`) |
| Port in use | Change the port in Settings (e.g., 3090), save, and restart |
| Want a full uninstall | Just delete the whole folder (no registry writes, no system leftovers) |
| Web page "Failed to fetch" / infinite spinner | Usually not a network problem but the **service process exited** (an old bug: dsh silently exits when stdin closes). Fixed: the launcher keeps the service's stdin pipe open with a resident daemon. If it still happens, check `runtime/server.log` and the launcher log to confirm whether the service is alive |
| Shell tool reports `Windows ACL temp root must be outside the workspace` | That session's workspace contains `runtime/tmp` (typically the workspace was set to the program root). The green edition keeps the temp dir inside the program dir, and dsh's ACL sandbox requires the temp dir to be **outside** the workspace. Fix: when opening a new session, pick **workspace** (`…\workspace`, auto-resolved and pre-registered by the launcher) or any directory not containing `runtime/tmp`; old sessions can't change workspace — archive/delete them or start a new session |
| dsh web page won't open | Check `runtime/server.log`; make sure the firewall isn't blocking 127.0.0.1 |
| `EPERM: rename denied` when setting API Key | Occasional; it's a concurrency conflict between security software (e.g., Huorong) real-time scanning and file writes. Retry once to save successfully; if frequent, add the `DeepSeekHarnessLauncher` directory to the security software whitelist |
| `SyntaxError: Unexpected token '\ufeff'` in plugin install logs | That npm package's `package.json` carries a UTF-8 BOM (the publisher's encoding issue), which crashes dsh's JSON parsing. Built-in fix: the launcher auto-strips these BOMs before the plugin command and retries; a normal retry installs it successfully |
