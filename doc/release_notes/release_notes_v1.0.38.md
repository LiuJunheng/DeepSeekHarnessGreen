v1.0.38 — 绿色版更新通道重构 · 官网 changelog 分页 · SEO 增强

> 本版本覆盖 **11 个 commit / 34 个文件 / +2592 -241 行**，是自 v1.0.31 以来改动量最大的一次，主要集中在三大方向：绿色版更新通道彻底重构、官网 changelog 增强、以及 SEO/多语言杂项优化。

## 🌟 核心特性：绿色版更新通道彻底重构（Launcher GUI）

原来的「检查绿色版更新」是一个同步请求 + 单一弹窗，无法展示历史版本、无法让用户在 GitHub/Gitee 之间选择下载源。本次完整重写，对齐官方 dsh 的 ask_update 交互模式。

### 新增功能

- **版本列表弹窗（Treeview + 双分组）**：所有 Release 按 stable / prerelease 分组展示，带滚动条
- **同版本多源合并**：GitHub Release + Gitee Release 按 version 号分桶合并，同一版本只占一行；来源列显示 `GitHub + Gitee` / `仅 GitHub` / `仅 Gitee`
- **安装弹窗双按钮**：选择版本后弹出确认窗口，底部两个安装按钮 —— 「从 GitHub 安装」+「从 Gitee 安装」，缺失的来源自动禁用
- **来源切换同步更新**：切换 GitHub / Gitee 时，发布说明正文自动切换为对应来源的内容
- **来源标签自动判定**：Gitee 过滤只认 `/releases/download/` 直链 zip（过滤自动生成的 archive，避免下载时 403）

### 修复

- **严重 bug：查询完 Release 后界面永久卡住**：`green_all_releases()` 函数缺失 bucket 分桶 + 双源合并的核心代码块，`merged` 变量从未初始化 → 运行时抛 `UnboundLocalError` → 后台 daemon 线程静默吞噬异常（worker 只有 `try-finally` 没有 `except`）→ 界面永远卡在「正在检查」且无任何弹窗。已补全完整合并逻辑 + 给 worker 加 `except Exception` 防止静默崩溃
- 异步清理 / 备份任务的耗时操作（插件移除、版本备份）改为后台 daemon 线程执行，UI 不再卡顿

### 改动文件

- `launcher.py` — **+647 / -241 行**，绿色版更新通道全链路重写（`green_all_releases`、`green_find_zip_asset`、`ask_green_update`、`confirm_green_upgrade` 等）
- `locales/zh.json` + `locales/en.json` — 新增 53 条 `green_version_select.*` i18n 键
- `update_agent.py` — 版本号同步

## 🌐 官网增强：changelog 分页 + SEO（dsh-green.website）

官网是三语静态站（zh / en / zh-Hant），所有 changelog / compare / index / about / privacy 五个页面 + 公共 CSS + 公共 app.js 都有改动。

### Changelog 分页架构（**+1690 行**，本次最大单一组件）

- **load-more 分页**：默认只嵌入最新 3 条 Release 进 HTML（利于爬虫收录），点「加载更多」每次追加 10 条
- **seed.json 静态兜底**：新增 `changelog-seed.json`（预生成的完整 Release 列表）+ `changelog-seed.html`（独立测试页），GitHub API 不可达时自动 fallback 到本地 JSON
- **加载状态与边界处理**：每次 `renderChunk` 后保留底部 load-more 按钮；`mergeReleases` 按 `published_at` 降序而非 seed 文件顺序
- **localStorage 缓存 TTL 从 1h/2h 统一降到 15min**，让新版本更快在官网显示

### SEO 优化

- 所有 **17 个页面** 的 `<title>` / `<meta name="description">` / `<meta property="og:title">` 统一加上 `(DSH)` 关键词，提升搜索引擎发现率
- 所有 **4 个 index.html**（zh / en / zh-Hant + 根）新增搜狗站点验证 `<meta name="sogou_site_verification">`

### 改动文件（官网）

| 文件 | 改动 |
|------|------|
| `pages/assets/app.js` | 分页逻辑 + 缓存 TTL + 排序修复 |
| `pages/assets/changelog-seed.json` | **+522 行**，预生成的 Release 数据 |
| `pages/assets/changelog-seed.html` | **+232 行**，独立测试页 |
| `pages/assets/style.css` | +22 行，分页 load-more 按钮样式 |
| 3× changelog.html | 加分页骨架 + 内嵌最新 3 条 |
| 4× index.html | 加 sogou 验证 meta + SEO title |
| 3× compare.html / 3× about.html / 3× privacy.html | SEO title 补齐 |

## 🔧 杂项修复

- **session_import 插件**：移除原生 `<input type='file'>` 硬编码中文，改为自定义 UI + i18n 翻译（`plugin.session_import.pick_file_btn` / `no_file_selected`）
- **插件 package.json 同步**：启动器启动时把 `@deepseek-ai/*` 依赖自动同步到宿主版本（本次 `dsh-session-rewind` 的 `dsh-session` 由 0.1.5-alpha.1 → 0.1.5-rc.1，`dsh-memory` 同步更新）

## 📊 改动总览

```
34 files changed, +2592 -241 lines

├── launcher.py              +647  绿色版更新通道重构 + bugfix
├── locales/zh.json / en.json +53   新 i18n 键
├── pages/assets/app.js       +296  changelog 分页 + 缓存 + 排序
├── pages/assets/changelog-seed.json  +522  静态兜底数据
├── pages/assets/changelog-seed.html  +232  测试页
├── 17 个官网页面            +100+ SEO + 分页骨架
├── DEV_NOTES.md              +81  绿色版多源合并避坑经验
├── 插件 package.json         +8   启动器自愈同步
└── update_agent.py           +2   版本号同步
```

## 版本更新

- GREEN_VERSION: 1.0.37 → 1.0.38

## 升级建议

- 绿色版覆盖安装即可
- 首次点「检查绿色版更新」应该能看到完整版本列表 + GitHub / Gitee 双源选择
