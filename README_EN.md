# DeepSeek Harness Green All-in-One Launcher

> **English edition of the README.** The project is maintained in Chinese (see
> [README.md](README.md)); this English translation is refreshed on each new
> release for international users. If anything is unclear, the Chinese version
> is the source of truth.

Wraps **DeepSeek Harness** (`dsh`) into a **double-click-and-go** local launcher:
without typing commands, without manually opening a browser, and without
installing Python/Node separately. **Green all-in-one**: Node, dsh, npm/pnpm
caches, session data and temporary files all live under the project's own
`runtime/` directory only — **nothing is written to your home directory, nothing
is installed into the system, nothing is written to the registry**, and you can
simply copy the whole folder to any other computer and keep using it.

> **Download**: GitHub [Release](https://github.com/LiuJunheng/DeepSeekHarnessGreen/releases/latest) ／ Gitee mirror
> (usually faster in China) <https://gitee.com/liujunheng/DeepSeekHarnessGreen/releases> →
> repos [GitHub](https://github.com/LiuJunheng/DeepSeekHarnessGreen) / [Gitee](https://gitee.com/liujunheng/DeepSeekHarnessGreen)
>
> **Other language**: 中文 — [README.md](README.md)（随版本发布翻译一次；以中文为准）

## Highlights

- **⚡ Double-click and go**: use `DSH_Launcher.exe` or `start.bat` — you don't
  even need to install Python / Node separately (portable builds are bundled);
  just click「Install Environment」the first time.
- **🌱 Green & portable**: Node, dsh, npm/pnpm caches, session data and temp
  files all live under this folder's `runtime/` — **nothing touches your home
  directory, nothing is installed into the system, nothing is written to the
  registry**. Bundled portable Node/Python download domestic mirrors first and
  fall back to the official source automatically. Copy the whole folder to any
  new computer and use it as-is, no reinstall needed.
- **📦 7 practical built-in plugins**: session rewind, session import, usage
  stats, file browser, archive purge, **local-video background** and more — one-click install (see
  [Built-in Plugins at a Glance](#built-in-plugins-at-a-glance)).
- **🏠 LAN remote access**: one-click switch to 0.0.0.0 binding + **automatic
  Windows firewall port exception**, so phones / other computers can open the
  WebUI directly (also covers the manually-fixed「random UUID」missing and
  port / IP 403 pitfalls).
- **🔁 Two-channel independent self-update**: the official core (dsh) and the
  green-edition outer layer don't interfere with each other and can be upgraded
  in one click; the green-edition update **automatically falls back to a Gitee
  mirror when GitHub is unreachable**, backs up before upgrading, shows manual
  addresses on failure, and **never loses your settings or sessions**.

---

## 1. Directory Layout

```
DeepSeekHarnessLauncher/
├── start.bat              # ★ Double-click this to start (pure ASCII + CRLF)
├── stop.bat               # Double-click this to stop the service
├── launcher.py            # Core: tkinter GUI + automatic environment setup
├── DSH_Launcher.exe       # ★ Double-click this to start (exe build, no Python needed)
├── update_agent.py        # Standalone updater source (packaged as DSH_Update.exe)
├── DSH_Update.exe         # ★ Standalone updater: overwrites & restarts after the main app exits
├── DSH_Launcher.ico       # Launcher icon (shared by window / system tray / exe)
├── build_exe.bat          # Tool to package launcher.py / update_agent.py into exes
├── config.json            # Config (mirror / port / Node / Python versions)
├── runtime/               # ★ Auto-generated on first run; all local data lives here (green all-in-one)
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
├── plugins/               # Built-in plugin sources (7, see「Built-in Plugins at a Glance」)
├── skills/                # This project's DSH experience Skill (installed to TRAE global skills)
└── README.md / README_EN.md  # Chinese (maintained) / English (refreshed per release)
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
| Check Update | Query the latest dsh version on npm; if newer, prompt you to update; backs up the old version to `runtime/backup/dsh-<version>` first (non-destructive) | Environment installed & service not running |
| Check Green Update | Query this project's latest GitHub Release (the green edition's outer layer: launcher/plugins/docs); when found → download to `runtime/update/` → exit the launcher → the standalone updater `DSH_Update.exe` completes the overlay install and restarts. If it fails, a dialog shows **manual download addresses** (GitHub release page + direct zip link). **Does NOT replace `config.json` (your settings) or `runtime/` (your data)**; old files are backed up to `runtime/update/backup/`. See Section 6 | Service not running |
| Plugin Manager | Open plugin management window: view installed plugins, search plugins (npm registry + GitHub official `dsh-plugin` topic), install/remove plugins (see Section 5) | Environment ready |
| Data Maintenance | Main window「Data Maintenance」section (stop the service first): **Session Manager** button → session list, **tick (select all / none / single)** to **restore (unarchive)** or **permanently delete** selected sessions, see Section 5「Data Maintenance」 | After service stopped |
| Refresh Status | Manually re-check environment & service status | Anytime |
| About (top-right) | Open「About」dialog: author, version, release date, this repo and official dsh repo links (clickable), plus **Green All-in-One · Localization notes** | Anytime |
| Minimize | Minimize to taskbar (taskbar icon stays), **tray icon stays resident from startup**; click the taskbar or tray icon to restore | Anytime |
| X (top-right) | Shows a second confirmation first (avoid accidental close), then auto-stops the dsh service and exits | Anytime |
| Duplicate-launch guard | If the launcher is already running (including minimized to taskbar / running in tray background), opening it again does NOT start another service; it brings the running window to the front instead | Anytime |

> **WebUI single-page dedup**: the launcher injects a heartbeat script into the WebUI page; the page reports to
> 127.0.0.1:3081 every 15 seconds. When **auto-opening** (after starting the service), if it detects the UI is already
> open in the browser (heartbeat within 180 seconds), it does **not** open a new page, avoiding a pile of identical tabs
> after repeated restarts. **Manually clicking「Open UI」is not limited by this — it always opens a new page.**
> You can uncheck *Auto-open browser after starting service* in Settings (corresponds to `auto_open_browser` in
> `config.json`; the beacon port is adjustable via `ui_beacon_port`).

### Stopping
- Click **【Stop Service】** in the launcher, or double-click **stop.bat**.
- Clicking the top-right **X** shows a **second confirmation** first (avoid accidental close), then stops the service automatically.
- Clicking **Minimize** shrinks to the **system tray** to run in the background; click the tray icon to restore. To fully quit, still use the top-right X.

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
> Compared to whole-folder migration, this zip **does NOT contain `runtime/` (no pre-downloaded environment or sessions)**; on a new machine the launcher auto-downloads Node / Python / dsh after connecting to the network. Small size, ideal for distribution.
>
> Packed contents match the GitHub repo (main branch): `launcher.py`, `update_agent.py`, `desktop-shell.py`,
> `start.bat`, `stop.bat`, `build_exe.bat`, `DSH_Launcher.exe`, `DSH_Update.exe`, `DSH_Launcher.ico`,
> `config.json`, `README.md`, `README_EN.md`, `LICENSE`, `plugins/`, `skills/dsh-deploy-maintain/`
> (`DSH_Launcher.exe` / `DSH_Update.exe` are also tracked in the GitHub repo, same source as the Release;
> `DEV_NOTES.md` and `.gitignore` are dev-side files, not shipped).

- **Latest download** (GitHub Release): <https://github.com/LiuJunheng/DeepSeekHarnessGreen/releases/latest>
- **Gitee mirror download** (when GitHub is not accessible from your network): <https://gitee.com/liujunheng/DeepSeekHarnessGreen/releases>
- Repository: <https://github.com/LiuJunheng/DeepSeekHarnessGreen> (GitHub) / <https://gitee.com/liujunheng/DeepSeekHarnessGreen> (Gitee)

Three steps on a new machine:
1. Extract to any directory (e.g., `E:\DeepSeekHarnessLauncher`), double-click **start.bat** (or `DSH_Launcher.exe`);
2. Click **【Install Environment】**, wait for the auto-download of portable Node + dsh install + portable Python (needs network, a few minutes);
3. Click **【Start Service】** → in the web UI enter your API Key and select a workspace (it's recommended to pick the auto-registered `workspace` inside the program dir to avoid the ACL temp-dir conflict).

This zip is maintained and distributed by the author with each release; users simply download it and extract it — no need to care about its internal structure.

## 5. Plugins & Session Management

> This section covers two parts of the green edition: the **plugin system** and **session data maintenance**.
> - **Built-in plugins**: 7 self-contained plugins (sources ship with the package under `plugins/`) covering chat
>   enhancement, session management, usage stats, local-video background and more;
> - **Data maintenance**: the launcher's built-in 「restore / permanently delete archived sessions」feature (dsh
>   officially has none; this is a green-edition addition).
>
> Entry points: click **【Plugin Manager】** in the main window to open the plugin management window; data maintenance
> lives in the「Data Maintenance」section (stop the service first).

### Managing & Maintaining Plugins
> Once the environment is ready (Node + dsh installed), click **【Plugin Manager】** in the main window to **view,
> search, install, remove, enable/disable** plugins. The management actions are described below; each built-in plugin's
> function is described in「Built-in Plugins at a Glance / Details」.

- **View installed plugins**: the window's left「Installed Plugins」lists the plugins installed in the current profile
  (`web`) (columns: name / version / **status** — enabled / disabled / —). Select one or more, then use 【Remove Selected】,
  【**Enable Selected**】, 【**Disable Selected**】(enable/disable and removal require a **service restart** to take effect),
  or 【Refresh】; **right-click** an entry to open its npm page / GitHub search, or copy the package name.
- **Install a new plugin from search results**: the window's right「Search Results」shows matches (source / version /
  description); select one and click 【Install Selected Plugin】. Find plugins via the top toolbar:
  - **【Search】** : search the **npm registry** (domestic mirror first) by keyword, showing **only dsh-related installable
    plugins** (irrelevant packages filtered automatically);
  - **【Load Recommended】** : one-click show the built-in **12 verified dsh plugins** (e.g., `@dsh-external/dsh-vision-toolkit`,
    `dsh-remote`, `dsh-lark-bot`, etc.), no network/GitHub needed to see installable items;
  - **【Load GitHub Trending】** : fetch popular repos from the **GitHub official `dsh-plugin` topic page**
    (`https://github.com/topics/dsh-plugin`) (≈20 by stars);
  - **【Open Official Topic】** : open the topic page in the browser to browse the full list by page.
- **Manual / local install**: in the bottom manual-install bar, enter an npm package name (e.g., `dsh-remote`) or
  `github:user/repo#commit` to install a specific version; or click **「Install from local plugin folder…」** to pick any
  local plugin directory containing `package.json` and install it in one click (the dialog **defaults to this repo's
  `plugins/` directory**, handy for installing built-in plugin sources directly). CLI equivalent: `python launcher.py
  --install-plugin <local-dir-or-package>`.
- **Where they install / green?**: plugins install into `runtime/dsh-home/profiles/web/` (the profile's `node_modules` +
  `package.json`) via `dsh plugin` (which forwards to pnpm internally) — pnpm and its store live under `runtime/`,
  **nothing written to the home directory**; on first use the launcher auto-installs pnpm into `runtime/pnpm-home` using
  portable Node.
- **Automatic orchestration layer**: after any install / remove / enable / disable, the launcher automatically writes
  dependencies that declare `dsh.bundle.patch` into the profile's `dsh.profile.bundles` (even if pnpm ends with exit
  code 1 due to `ERR_PNPM_IGNORED_BUILDS` build-script warnings, it still syncs as a fallback; **no manual package.json
  editing needed**); enable/disable state is recorded in `dsh.profile.disabled`. **After a service restart the plugin loads.**
- **Other tips**: the bottom status bar shows progress in real time ("installing / installed / N results found", etc.);
  GitHub-source repos aren't necessarily npm packages, so install failure is normal — the window shows the reason, and
  you can switch to the same-named package in the npm registry.

### Built-in Plugins at a Glance (7 bundled)
Installation: any built-in plugin can be installed via「Plugin Manager → Install from local plugin folder…」selecting its
directory (CLI equivalent: `python launcher.py --install-plugin plugins\<plugin>`); **restart the service** for it to take
effect. After an official-core or green-edition self-update, an already-installed older copy is a pnpm copy — reinstall
the local plugin for it to take effect. See each plugin's README for full usage.

| Plugin | One-liner | Docs |
|--------|-----------|------|
| `dsh-file-browser` | WebUI file browse / preview / right-click to insert an official @ reference, path or content into the conversation | [README](plugins/dsh-file-browser/README.md) |
| `dsh-archive-purge` | Read-only「Archive Purge」page in the WebUI to view archived sessions | [README](plugins/dsh-archive-purge/README.md) |
| `dsh-session-rewind` | When a session gets "poisoned" by a tool-run crash, one-click rewind to a usable turn and fork a clean continuation | [README](plugins/dsh-session-rewind/README.md) |
| `dsh-session-import` | Import an exported session ZIP / JSONL **back into this machine** (inverse of the official export) | [README](plugins/dsh-session-import/README.md) |
| `dsh-usage-stats` | Usage stats + per-message「this-turn tokens / estimated cost」 | [README](plugins/dsh-usage-stats/README.md) |
| `dsh-sidebar-lite` | WebUI right sidebar (file management / preview / browser / terminal / tasks; right-click a file to insert it as an official @ reference) | [README](plugins/dsh-sidebar-lite/README.md) |
| `dsh-media-background` | Play local-directory videos as the WebUI background (video + audio, add to a playlist) | [README](plugins/dsh-media-background/README.md) |

All built-in plugins are **pure plugins** (modify no official files) and are open-sourced together with the green edition
under the **Apache License 2.0** (see Section 11).

### Built-in Plugin Details (grouped by function)
> Install any of them via「Plugin Manager → Install from local plugin folder…」selecting the corresponding
> `plugins\<plugin>` directory (CLI equivalent: `python launcher.py --install-plugin plugins\<plugin>`), then **restart the
> service**; see each section's README for full usage.

#### Chat & File Enhancement
- **`dsh-file-browser` (file browse / preview / right-click add to conversation)**: after installing and restarting the
  service, a「📁 File」button appears on the left of the WebUI input's tool row; clicking it opens a right-side floating
  file browser — directory listing (dirs first), text/code and image preview, path-input jump, up/refresh; **right-click
  a file or directory** to: for files, **「Insert as official @ reference」** (bridges the new DSH official `@+file`
  mechanism — the file is converted to a `@relative/path` mention under the session working directory and inserted through
  the official `slash/input-insert-reference` pipeline, showing a `@filename` chip in the input that serializes to the
  canonical relative path on send; files outside the session working directory are refused with a notice), or append its
  **path** or **content** (≤3000 chars, truncated with a note if longer) to the input draft (editable before sending), or
  **copy the path**. It's a pure plugin. See
  [plugins/dsh-file-browser/README.md](plugins/dsh-file-browser/README.md).
  > FAQ: if you don't see the「File」button after installing → usually the service wasn't restarted / the plugin `exports`
  > is missing `"./package.json"` / the source was changed without reinstalling; see the plugin README's「Troubleshooting」.
- **`dsh-sidebar-lite` (WebUI right sidebar)**: a persistent working panel on the right side of the WebUI, providing file
  management / preview / browser / terminal / task entries, so you can operate files and tools right beside the
  conversation; right-clicking a file row in its resource manager also offers **「Insert as official @ reference」** (the
  same official `@`-reference pipeline as `dsh-file-browser`). See
  [plugins/dsh-sidebar-lite/README.md](plugins/dsh-sidebar-lite/README.md).

#### Session Data Management
- **`dsh-archive-purge` (archive purge viewer)**: after installing and restarting the service, you can **view** the
  archived session list in the WebUI「Settings → Archive Purge」(tick/select-all interaction kept). Because all sessions are
  "running" while the service is up, the WebUI **cannot delete directly**, so this page is **read-only display** — real
  deletion/restore happens in the「Data Maintenance」below. It's a pure plugin. See
  [plugins/dsh-archive-purge/README.md](plugins/dsh-archive-purge/README.md).
  > FAQ: if「Archive Purge」isn't visible in the WebUI settings → usually the plugin `package.json`'s `exports` is missing
  > `"./package.json"` (or the source was changed without reinstalling); see the plugin README's「Troubleshooting」.
- **`dsh-session-rewind` (session rewind)**: solves the problem of dsh sessions being **permanently poisoned** after a
  tool-run crash (`Cannot read properties of undefined (reading 'prepare')`) — the crashed turn leaves orphan `tool_calls`
  in the log, and every later turn is rejected with API 400. After installing and restarting the service, the WebUI
  「Settings → Session Rewind」can: list all sessions →「Analyze」any session (per-turn info: user question / step count /
  tool-call count / error-code stats / completeness) → click「Rewind to here」on any **completed** turn, which calls the
  official `session.fork` to derive a **clean continuation session** from that turn and opens it automatically (the
  original session is kept and can be cleaned up later via「Data Maintenance」). The UI is **card-based layout** (session
  titles and user-question descriptions each take a full row and are fully readable, with workspace/creation time/steps/
  tool calls below). It's a pure plugin. See [plugins/dsh-session-rewind/README.md](plugins/dsh-session-rewind/README.md).
- **`dsh-session-import` (session import)**: import a session ZIP exported by the「Session log」button (`dsh-session-<id>.zip`,
  from the official `GET /api/session.export`) or a single `.jsonl` log **back into this machine** — the inverse of the
  official export. After installing and restarting the service, go to WebUI「Settings → Session Import」and pick a file: it
  auto-detects ZIP (via the `PK` magic) or plain JSONL, validates the session header (version/fields), then writes back
  under `runtime/dsh-home/sessions/<project>/<sessionId>/` keyed by the log header's `cwd` (zstd frames byte-identical to
  the official persistence backend), stores `media/` attachments content-addressed in the attachment store, and attaches
  the session to the matching workspace (sessions whose `cwd` directory does not exist here stay in「Ungrouped」but still
  appear in the session list). Re-importing the same session id is skipped and never overwrites. It's a pure plugin. See
  [plugins/dsh-session-import/README.md](plugins/dsh-session-import/README.md).
  > Note: import is "restore/view" semantics — the session appears in the list for viewing history, but there is no generic
  > official UI entry to "continue chatting from that session"; projection metadata such as titles is filled in later by
  > DSH, so it may briefly show「(Untitled)」.

#### Usage Stats
- **`dsh-usage-stats` (usage stats + per-turn "this-turn tokens")** (v0.2.0, one plugin with two feature surfaces,
  installed/uninstalled together):
  1. **Settings page「Usage Stats」**: scans **all local session logs**, aggregates token usage per model call, and supports
     **cost estimation**. Overview cards (sessions / total turns / input / output / cache / thinking tokens + estimated
     cost, per-model breakdown); **editable price table** (yuan / per million tokens, columns per official billing as
     「input uncached / input cached / output」, default official prices, stored in browser localStorage); **session card
     list** (title takes a full row, meta info wraps) +「Details」expands **per-turn cards** (user message takes a full
     readable row, with turn number / steps / tool calls / output tk / estimate / model / completion status below).
  2. **Per-turn「this-turn tokens」on message rows**: above the action row of every **completed assistant message**, a
     right-aligned resident readout of that turn's actual token usage — `this-turn tokens: input(uncached) 3.3k ·
     input(cached) 832.3k · output 4.6k · thinking 3.7k · est. ¥0.13` (k/M abbreviations, classified per official billing;
     thinking is already counted in output and not double-billed; the cost is estimated from the price table; data is the
     sum of `usage` from all `assistant/message` events in that turn, same source as the panel; the official hover
     duration/first-token/rate is unaffected).

  Data is decoded directly from session logs (`session.jsonl.zstd`, zstd multi-frame, same mechanism as
  `dsh-session-rewind`); **cost is an estimate** (logs don't contain cost; estimated from the price table, for cost
  reference only). See [plugins/dsh-usage-stats/README.md](plugins/dsh-usage-stats/README.md).
  > Note: the per-turn「this-turn tokens」was originally a standalone plugin `dsh-turn-tokens` (v0.1.0); it was merged into
  > this plugin since v0.2.0. If you installed it in an older version, remove it before installing this plugin to avoid
  > duplicate display.

#### Video background
- **`dsh-media-background` (play local videos as the WebUI background, "Watch the Stars")**: pick a local directory,
  list its videos (**including subfolders**, up to 6 levels deep), add them one by one to a playlist, and play them as a
  full-screen `<video>` background layer with **video + sound** (volume / previous / next / pause / stop / background
  opacity / loop, all adjustable; the playlist loops by default). No need to leave the page to pick the directory — click
  「Select folder…」in the「🎬 观星」panel at the bottom-right and drill down from the drive letters in the opened
  **directory browser window**, or paste a path directly; the picked directory is persisted. The background renders as a
  **semi-transparent wallpaper** behind the conversation (default opacity 35%, adjustable 0–100), leaving the harness
  theme untouched so normal conversation looks unchanged. See
  [plugins/dsh-media-background/README.md](plugins/dsh-media-background/README.md).

### Data Maintenance (restore / permanently delete archived sessions)
> dsh officially has **no** "permanently delete session" or "unarchive" feature: archiving in the web UI only **hides**
> the session (log files and registry entries are all kept). This launcher operates directly on the local data files
> **after the service is stopped**, and can:
> - **Restore (unarchive)**: remove the session id from `global.archivedSessionIds` in `workspace.json`; the session
>   reappears in the WebUI session list, **logs and content unaffected**.
> - **Permanently delete**: fully remove the log directory + registry entry, **irreversible**.
>
> On the WebUI side, `dsh-archive-purge` only provides **read-only viewing** of archived sessions; real deletion/restore
> happens here: **click「Stop Service」→ main window「Data Maintenance」→「Session Manager」→ tick sessions →
>「Restore Selected」or「Delete Selected」**.

| Operation | Where | Description |
|-----------|-------|-------------|
| Session Manager | Main window「Data Maintenance」section | Opens a session list (title / workspace / status / has logs), **tick (select all / none / single)** then **Restore Selected** (only effective for "archived" sessions) or **Permanently Delete Selected** |
| CLI | `--restore-session <ID>` | Restore (unarchive) a specific session |
| CLI | `--purge-archived` / `--purge-session <ID>` | Permanent delete: the former clears all archived, the latter deletes a specific session |

- **Restore** only changes `archivedSessionIds` in `storages/workspace.json` (atomic write-back: temp file + `os.replace`),
  doesn't touch logs or workspace ownership; restoring a non-archived or non-existent session safely returns "nothing to do".
- **Delete** cleans three sources at once:
  1. Session log dir `runtime/dsh-home/sessions/<workspace-code>/<session-ID>/`
  2. The `sessionIds` / `archivedSessionIds` entries in `storages/workspace.json`
  3. That session's title / stats cache line in `storages/session_projcache.json`

Notes:
- **You must stop the service first** (the GUI pops a warning; the CLI validates and errors out if the service is running).
- Deletion is **irreversible**, with confirmation prompts before every delete; restore doesn't remove data and is safe.
- Running sessions are never cleaned up.

## 6. Green-Edition Self-Update (Dual-Channel Update)

This green edition supports **two fully independent, non-interfering update channels**:

| Channel | What it updates | Entry | Update source |
|---------|-----------------|-------|---------------|
| Official core | dsh itself (the npm package in `runtime/dsh/`) | 「Check Update」 | Official npm / GitHub |
| Green-edition outer layer | launcher `launcher.py` / `DSH_Launcher.exe` / `plugins/` / docs etc. | 「Check Green Update」 | This project's GitHub Release (auto-falls back to a Gitee mirror when GitHub is unreachable) |

Each channel judges its own version, downloads its own updates, and backs up separately — **they never touch each other**:
core updates only touch `runtime/dsh/`, outer updates only touch the program root (skipping `config.json` and `runtime/`).

### Green-Edition Outer-Layer Update Flow
1. Click「Check Green Update」(stop the service first) → query the latest GitHub Release (official API falls back to a
   domestic mirror, then to **Gitee** — two tiers: if a Gitee release exists, its manually-uploaded zip asset is
   downloaded directly; otherwise the whole repo is cloned over the git smart-HTTP protocol; dev-side files like
   `DEV_NOTES.md`/`.gitignore` are skipped so the result matches the GitHub channel).
2. If newer, a dialog shows the version comparison and update notes (the source — GitHub or Gitee — is indicated) → after
   confirming, fetch the new content into `runtime/update/extracted/`:
   - **GitHub source / Gitee release**: download the distribution zip (with progress, size verified) → safe-extract
     (Gitee's manually-uploaded release assets download directly, no challenge page);
   - **Gitee whole-repo snapshot (fallback when no release)**: Gitee's whole-repo zip URL returns a JS challenge page (not
     a real zip), so the launcher clones the whole repo over the **git smart-HTTP protocol** (equivalent to a snapshot,
     using only Python stdlib).
3. Write the update job file (`runtime/update/update_job.json`).
4. After confirming, **exit the launcher**, and the standalone updater (`DSH_Update.exe`) completes everything in its own
   process: it copies itself to `runtime/tmp` and runs from the copy (so it can replace itself too) → waits for the file
   lock to release → backs up old files to `runtime/update/backup/` → overwrites the program root (skipping `config.json`
   / `runtime/` / `.git`) → auto-restarts the new launcher.
5. A dedicated progress window shows status throughout; **if it fails, a dialog explains the reason and shows manual
   download addresses** (GitHub release page / Gitee repo page + direct zip link); the program keeps working on the
   current version.

### Safety & Rollback
- **Does NOT replace** `config.json` (your custom port/mirror settings) or `runtime/` (your session data / installed environment).
- Old files are auto-backed up to `runtime/update/backup/` before overwrite; if the new version has issues you can
  manually copy them back to the root to roll back.
- Distribution zip naming convention: `DSH_Launcher_GreenPortable_Online_<date>_v<version>.zip`, Release tag `v<version>`.
- Built-in plugin sources update with the green edition, but plugin copies **already installed** into
  `runtime/dsh-home/profiles/web` are pnpm copies; reinstall the local plugins via「Plugin Manager」for them to take effect.
- **Manual update (fallback when auto-update fails)**: open the GitHub release page, download the latest zip → extract →
  **overwrite** the extracted files into the program root (do **not** overwrite `config.json` or the `runtime/` folder) →
  double-click the launcher again.

## 7. Built-in Python & exe Packaging

### Why Python / Built-in Python
- **What launcher.py does**: the launcher itself is written in Python, responsible for「auto-download portable Node →
  install dsh locally → start the service → open the browser」and provides the tkinter GUI. So running the launcher
  **needs** a Python interpreter.
- **Built-in portable Python**: the Python 3.10 under `runtime/python` (full version, with tkinter), preferred by
  `start.bat`. If missing on first launch it auto-downloads from a mirror (domestic `mirror.nju.edu.cn` first, falls back
  to GitHub), **not installed into the system, no pollution**, and migrates with the folder.
- **exe build**: PyInstaller packages launcher.py into `DSH_Launcher.exe`; the interpreter and standard library are
  embedded in the exe, so **no Python is needed at runtime** — double-click and go, closest to a "green portable software"
  experience.

### Which Launch Form to Pick
| Form | Entry | Needs Python? | Size / notes |
|------|-------|---------------|--------------|
| exe build | double-click `DSH_Launcher.exe` | No | single-file exe (≈8 MB) with embedded interpreter; program root must be on the same level as `runtime/` |
| script build | double-click `start.bat` | No (uses bundled) | relies on `runtime/python` (≈200 MB); falls back to system Python only if bundled is missing |

> Note: the exe and start.bat share the same `runtime/`; use either one, data is fully interchangeable.

### Rebuilding the exe
After editing `launcher.py` / `update_agent.py`, double-click **build_exe.bat** to update the exes:
1. Auto-locate Python (bundled first, then system).
2. Install PyInstaller locally into `runtime/pyinstaller` (Tsinghua mirror; no system-environment changes, no C drive).
3. Package the single-file `dist\DSH_Launcher.exe` and copy it to the project root.
4. Package the standalone updater `dist\DSH_Update.exe` and copy it to the project root.
5. The build also bundles the built-in VC runtime DLLs (`vcruntime140.dll` / `vcruntime140_1.dll` /
   `vcruntime140_threads.dll`) into both exes, so target machines don't need a separate VC++ runtime install.

### Manually Downloading the Built-in Python (optional)
If you don't want to wait for the auto-download, manually extract python-build-standalone's
`cpython-3.10.20+20260807-x86_64-pc-windows-msvc-install_only.tar.gz` into `runtime/python`; either
`runtime/python/python.exe` or `runtime/python/any-subfolder/python.exe` is recognized.

## 8. Security Notes
- The service only binds `127.0.0.1` (local loopback) by default; it's not exposed to the public internet.
- All file reads/writes and command executions happen inside your chosen **workspace**.
- When operating in the web UI for the first time, read the high-risk command confirmation dialogs carefully before
  clicking allow.

## 9. DSH Experience Skill

The deployment / maintenance / plugin-development experience accumulated in this project is organized into a TRAE Skill:
**`dsh-deploy-maintain`**.

- Source files are in the project's `skills/dsh-deploy-maintain/` (main document `SKILL.md` + `checklists/` checklists +
  `references/` plugin skeleton & data-directory details).
- Installed into TRAE's global skills (`~/.trae-cn/skills/dsh-deploy-maintain/`), usable directly in new sessions.
- Contents: green all-in-one deployment (portable Node / env-var redirection / workspace ACL sandbox / exe packaging),
  daily maintenance (update backup / plugin management / data maintenance), DSH plugin development (dual-end loading /
  `ctx.effect` route registration / `exports` pitfalls), with pitfalls condensed into a troubleshooting quick-reference table.

## 10. FAQ

| Issue | Fix |
|-------|-----|
| "Python not found" | The bundled portable Python is missing and its download failed (usually a network issue). Follow the hint in start.bat to install Python 3 manually with "Add to PATH" checked as a fallback |
| Node download slow / failing | In the UI settings, switch the mirror to "domestic" or "official" and retry |
| dsh install slow / stuck for a long time | The official npm registry is slow to reach from China; switch the mirror to "domestic (npmmirror)" in the UI settings or `config.json`, save and retry (this green edition defaults to `mirror=cn`) |
| Port in use | Change the port in Settings (e.g., 3090), save, and restart |
| Want a full uninstall | Just delete the whole folder (no registry writes, no system leftovers) |
| Shell tool reports `Windows ACL temp root must be outside the workspace` | That session's workspace contains `runtime/tmp` (typically the workspace was set to the program root). The green edition keeps the temp dir inside the program dir, and dsh's ACL sandbox requires the temp dir to be **outside** the workspace. Fix: when opening a new session, pick **workspace** (`…\workspace`, auto-resolved and pre-registered by the launcher) or any directory not containing `runtime/tmp`; old sessions can't change workspace — archive/delete them or start a new session |
| dsh web page won't open | Check `runtime/server.log`; make sure the firewall isn't blocking 127.0.0.1 |
| `EPERM: rename denied` when setting API Key | Occasional; it's a concurrency conflict between security software (e.g., Huorong) real-time scanning and file writes. Retry once to save successfully; if frequent, add the `DeepSeekHarnessLauncher` directory to the security software whitelist |
| Green-update failed / not effective after updating | The standalone updater pops up the failure reason and shows manual download addresses (GitHub release page + direct zip link). Fallback: open the GitHub release page, download the latest zip → extract → overwrite into the program root (do **not** overwrite `config.json` or the `runtime/` folder) → double-click the launcher again |

## 11. Open Source License

The whole green edition — the launcher `launcher.py`, the green shell, and the 7 built-in plugins (see
[Built-in Plugins at a Glance](#built-in-plugins-at-a-glance)) — is uniformly licensed under the **Apache License 2.0**:
`Copyright (c) 2026 LiuJunheng`. A copy of the license is at [LICENSE](LICENSE) in the repo root and is shipped in the
green-edition zip.

- **Main project + all built-in plugins**: a single Apache License 2.0, distributed together with the green edition — no
  extra, no split, no separate license declarations.
- **Runtime dependencies** (`@deepseek-ai/dsh`, Node.js, portable Python, etc.) keep their own third-party licenses; the
  green edition only installs them inside its local runtime directory and does not ship their sources.

Apache License 2.0 requires: any redistribution (including the green-edition zip / exe) must retain this LICENSE copy and
copyright notice; modified files must be marked; no trademark license is granted; the work is provided "AS IS" without any
warranty.

> **Compliance note for the green edition**: the packaging MUST include `LICENSE` (see「Lightweight Distribution Zip」
> above), otherwise the distributed zip has no license copy, violating Apache 2.0 §4's redistribution clause.