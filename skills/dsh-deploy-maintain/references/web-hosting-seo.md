# 软件官网静态托管 + SEO 落地经验（可套用模板）

> 本文从项目 `doc/deploy-and-seo.md` 脱敏并通用化而来。Skill 内自包含引用，不依赖 `doc/`。
> 适用于：为开源软件/绿色便携版搭建**多语言静态官网**（首页 + 关于 + 隐私 + 对比 + 更新日志），并做 Google/百度收录与 AdSense 审核落地的整套经验。
> 生产环境约定用 `<主域>`、`<pages.dev 子域>`、`<owner>/<repo>` 做占位，实际按自己域名替换。

---

## 一、部署架构模式

### 双托管（推荐）：主站 + 旧站 301

| 角色 | 方案 | 说明 |
|------|------|------|
| **主站** | Cloudflare Pages（root_dir=静态目录，纯静态无构建） | 放完整三语站点 + sitemap + robots + ads.txt + `_headers` |
| **备用子域** | `<项目>.pages.dev` | Cloudflare 自动分配，与主域同套页面 |
| **旧站 301** | GitHub Pages（页面目录放跳转文件） | 老域名/路径 → meta refresh 0s + canonical + JS location.replace 三重保险跳主域 |

**CNAME 裸域**：Cloudflare CNAME flattening 把裸域 CNAME 扁平化为多条 A 记录直达 Pages，无需显式建名。

### 多语言目录结构

```
静态根/
├── index.html        ← 根入口：语言检测 JS 自动跳 /zh/ /zh-Hant/ /en/
├── robots.txt        ← 指 sitemap
├── sitemap.xml       ← xhtml:link 互指所有语言变体
├── assets/           ← style.css + app.js（根入口用 ./, 子目录页用 ../）
├── zh/  zh-Hant/  en/  → 各放 index / about / privacy / compare / changelog
```

**多语言三铁律**：
1. **每个页面天然单语言**（AdSense/Google 按内容主体语言决定广告/权重，不看 `<html lang>`）
2. **hreflang 互指 4 条 + canonical 自指**都在 `<head>`，缺一条 Google 忽略整个 hreflang：
   - `zh-Hans` / `zh-Hant` / `en` / `x-default` 4 条 alternate
   - `lang` 精确：zh 用 `zh-CN`、zh-Hant 用 `zh-Hant`、en 用 `en`（别用 `en-US`）
   - `hreflang` 用精确 `zh-Hans`/`zh-Hant` 但 URL 路径用短名 `zh/`/`zh-Hant/`，两者独立（Google 接受）
3. **JS 跳转必须相对路径**（`./zh/`），绝对 `/zh/` 在 `file://` 或 GitHub Pages 子路径下会错跳

### 浏览器语言检测（根入口 JS）

- zh-TW/HK/MO/hant* → 繁体 `./zh-Hant/`
- zh-CN/SG/zh* → 简体 `./zh/`
- 其他 → `./en/`
- localStorage 优先，保留旧值映射

---

## 二、SEO 结构与结构化数据

### sitemap.xml 必须字段

- `<loc>` 绝对 https URL
- `<xhtml:link rel="alternate" hreflang="zh-Hans|zh-Hant|en|x-default">` 4 条互指
- `<lastmod>` ISO 8601——Google 说这是 sitemap 里**唯一影响抓取优先级**的字段，实质性改内容必须同步更新

### x-default 规则（sitemap 与 HTML 必须一致）

- **首页** → x-default 指向根 `/`（根本身做语言自动跳转）
- **子页**（about/privacy/compare/changelog）→ x-default 指向 `/en/` 对应路径（英文是通用 fallback）
- **禁止**子页 x-default 指向根或其他语言（分散权重）

### JSON-LD：SoftwareApplication

首页 `<head>` 加一份结构化数据用于富文本摘要：
- 必备：`@type`=SoftwareApplication、name、description（本地化）、operatingSystem、applicationCategory、inLanguage、url、offers（免费 price=0）、downloadUrl、sameAs
- **刻意不写**（避免不现实同步负担）：`softwareVersion`（每次发版要手动同步）、`applicationSubCategory`（Schema.org 无此字段）、`image`（无稳定 logo URL）、`aggregateRating`（评分不稳定）
- 验证：Google Rich Results Test（https://search.google.com/test/rich-results）

### robots.txt / ads.txt

- robots.txt：`User-agent: *` + `Allow: /` + `Sitemap: https://<主域>/sitemap.xml`；**纯 ASCII、无 BOM**（BOM 会被认成乱码）
- ads.txt：放静态根 `/ads.txt`，内容 `google.com, pub-<ID>, DIRECT, f08c47fec0942fa0`（`f08c...` 是 Google 固定授权卖家标识 TAG）。发布商 ID 与 `<head>` 的 `google-adsense-account` 必须一致
- 旧站 301 跳转页不需要 ads.txt（Google 跟随跳转到真实域名）

---

## 三、Cloudflare Pages 运维要点

### `_headers` 自定义响应头（纯文本，路径前带 `/`，header 行 **2 空格缩进**，不要用完整 URL）

两个高频用途：
1. **sitemap Content-Type 修正**：静态构建默认给 `.xml` 返回 `application/xml`，但 Google Search Console fetcher 某些构建只识别 `text/xml`（报 "Sitemap could not be read / Type Unknown / 0 pages"）。用 `_headers` 覆盖强制 `text/xml`。
2. **pages.dev 别名 noindex**：pages.dev 子域和自定义主域同时可访问同一套页面会被 Google 判重复内容、分散权重 → 只给 pages.dev 路径加 `X-Robots-Tag: noindex`，自定义域名不受影响。

```text
/sitemap.xml
  Content-Type: text/xml

https://<project>.pages.dev/*
  X-Robots-Tag: noindex
```

**注意**：`_headers` 不会自动 push——必须在 git 仓库根、输出目录下提交触发新构建；**不识别 BOM**，保存为 UTF-8 无 BOM；部署后用 `curl -I https://<project>.pages.dev/ | grep x-robots-tag` 验证生效。

### Cache Rules（防改了没生效）

```
Rule 1 - 静态资源长缓存:   URI Path contains /assets/  → Edge TTL 1y, Browser TTL 1y
Rule 2 - HTML 不缓存:      URI Path ends with .html OR URI Path = /  → 0 / No cache
```

### 缓存版本号（`.css? v=`, `.js? v=`）

每次改了 CSS/JS **内容**，必须同步改所有 HTML 里 `<link>`/`<script>` 的 `?v=X.Y` 版本号，否则浏览器/Pages 加载旧资源造成"改了没生效"假象。CSS 与 JS 版本**独立管理**，各自改了才升。

### Dashboard 一次必开

Always Use HTTPS / Automatic HTTPS Rewrites / Bot Fight Mode / Web Analytics。

---

## 四、内容页通用规律

### 更新日志页（零后端）

浏览器端调 GitHub REST API `/repos/<owner>/<repo>/releases?per_page=10`，过滤 draft/prerelease，解析 body markdown 渲染为卡片。**发 GitHub Release 是唯一触发点，不需要改任何 HTML/JS/CSS**。
- 用一个轻量 markdown 渲染器（标题/列表/代码块/加粗/行内码/链接/换行）
- 缓存独立 key + TTL（如 2h），与最新 zip 直链缓存互不干扰；GitHub 匿名限流 60 req/hour/IP，2h 缓存后占用极小
- 错误降级：403/网络失败显示降级文案 + 手动 GitHub 链接
- 根目录 changelog.html 加 `noindex,nofollow`（只是跳转，不应被收录）

### 对比页 / 措辞纪律

- 外链社区项目加 `rel="nofollow noopener noreferrer"`（不传权重）；自己仓库/官方链接 `rel="noopener"`（保留权重）
- 去绝对化营销词（"独有""唯一"），措辞严谨避 AdSense"低价值内容"审核
- 所有翻译**禁止机翻**，英文必须自然人类写

### 新页面三语同步铁律

新增一页必须在 zh/ zh-Hant/ en/ 各放一份 + sitemap 补 3 条带 xhtml:link 互指 + 站长验证标签 + hreflang/canonical 齐全。

---

## 五、发新内容后必做清单

| # | 操作 | 频率 |
|---|------|------|
| 1 | sitemap.xml 加新 URL（三语） | 每次 |
| 2 | commit + push → 等主站自动部署（约 30 秒） | 每次 |
| 3 | 百度站长后台手动提交 sitemap（无额度限制） | 每次 |
| 4 | 百度主动推送（加急，每日额度有限、零点重置） | 零点后 |
| 5 | Google Search Console 提交 sitemap 变更 | 每次（可选） |

**域名替换必须全量验证**：改了域名后 grep 全量 HTML + sitemap.xml 确认零残留（曾因旧 GitHub Pages 地址在 robots/sitemap 残留，Google 爬 sitemap 跳旧站）。

---

## 六、避坑速查

| 坑 | 现象 | 解法 |
|----|------|------|
| pages.dev 与主域重复收录 | 重复内容、分散权重 | `_headers` 只给 pages.dev 加 noindex |
| sitemap 抓不到 | Search Console "Content-Type unknown / 0 pages" | `_headers` 强制 `/sitemap.xml` → `text/xml` |
| 改 CSS 没生效 | 浏览器缓存旧文件 | 升 `?v=X.Y` 版本号 |
| robots.txt 乱码 | 带 UTF-8 BOM | 纯 ASCII 重写 |
| 子页 x-default 指根 | hreflang 权重分散 | 子页 x-default 指 `/en/` 对应路径 |
| 绝对路径 JS 跳转 | `file://`/子路径下错跳 | 一律相对路径 `./zh/` |
| 新页面漏接 hreflang | Google 忽略该页语言标记 | 4 条 alternate + canonical 都放 |