---
name: website-skill
description: "通用静态网站开发规范：纯原生 HTML/CSS/JS、多语言架构、SEO、Sitemap 排查、Cloudflare Pages 部署（.html 308）、广告接入、Markdown 渲染安全、分页爬虫兼容。新建/维护站点或 GSC 报 sitemap 读不了时加载。"
updated: "2026-10-25"
---

# 通用静态网站开发与运维规范

> 本 Skill 沉淀自一个完整的多语言静态网站项目（Cloudflare Pages 托管 + GitHub/Gitee 双镜像）的实测经验，只记录对日后开发有复用价值的内容：架构、规范、避坑。不存档设计过程、时间线与一次性审计。
> 本 Skill 自包含：**SKILL.md 是核心索引**与最高优先级规范，详细说明在 `references/`，逐项核对清单在 `checklists/`，代码模板在 `templates/`。按需查阅。

## 一、适用场景

- **从零搭新站**：按目录结构 + 代码规范 + SEO 清单一步步走，少踩坑
- **维护现有站**：改了页面/样式/脚本后，对照缓存版本号铁律 + 发版清单必做项
- **SEO 排查**：收录掉了、爬虫看到空壳、百度/搜狗不爬 → 翻「爬虫能力分级」「分页 SEO 安全」
- **Markdown 渲染**：发布说明、博客、文档页用 markdown → 必须看「HTML escape 坑」
- **分页/无限滚动**：加载更多 + 爬虫兼容 → 看「分页 SEO 安全」

## 二、技术选型铁律

- **纯原生 HTML + CSS + JS**，零外部依赖（不引 CDN 字体、框架、统计）
- JS 保持 **ES5**：只用 `var` / `function`，不用 `let` / 箭头函数
- 零构建流程：Cloudflare Pages root_dir 直接指向输出目录，不跑 webpack/vite
- 图片用 SVG 或 WebP，加 `loading="lazy"`

## 三、缓存版本号铁律（最高优先级）

所有 HTML 里的 `<link>` / `<script>` 引用 CSS 和 JS 必须带 `?v=X.Y`。**每次改了 CSS/JS，必须同步改所有 HTML**。CSS 与 JS 版本号独立管理。

曾出现过 index.html 还在 `app.js?v=3.8`、changelog.html 已 `v=3.10` 的中间态——用户加载旧缓存看到 SEO 段落被截断，排查了 3 小时才定位。

→ 完整说明见 `references/cache-versioning.md`

## 四、多语言架构（目录式单语言）

```
pages/
├── index.html          ← 根入口（JS 语言检测 + 自动跳转）
├── assets/             ← style.css + app.js + changelog-seed.json
├── zh/                 ← 简体中文（hreflang="zh-Hans"）
├── zh-Hant/            ← 繁体中文（hreflang="zh-Hant"）
└── en/                 ← 英文（hreflang="en"）
```

**hreflang 互指铁律**：每个页面 `<head>` 必须 5 条（canonical + 3 条 alternate + 1 条 x-default）。x-default 规则：首页 → 根 `/`；子页 → `/en/`。

**路径相对路径铁律**：根入口 `./assets/xxx`，子页 `../assets/xxx`；JS 跳转必须 `./zh/` 不能 `/zh/`。

→ 完整说明见 `references/multilingual-architecture.md`

## 五、分页/无限滚动的 SEO 安全（爬虫保底核心）

### 不清空容器

JS 启动后**绝对不要做** `container.innerHTML = ""`——这会删掉 HTML 内嵌的静态种子，爬虫可能在 JS 跑完前看到空壳。正确做法：收集已有 data-tag，只追加没有的。

### load-more 按钮位置铁律

```
每次 renderChunk 前 btn.remove() → 追加新卡片 → container.appendChild(btn)
```

按钮永远是容器最后一个子节点。

→ 完整代码示例见 `references/pagination-seo.md`

## 六、Markdown 渲染的 HTML escape 大坑（必看）

所有 markdown → HTML 的输出**必须先做 htmlEscape**——否则 markdown 里的 `` `<title>` `` `` `<meta>` `` 会被浏览器当成真实标签，导致 DOM 错乱、SEO 爬虫截断。

renderInline 执行顺序**不能乱**：
1. 把行内 `` `code` `` 摘出来占位，内部单独 escape
2. 对剩余普通文本做 htmlEscape（& < > "）
3. 恢复 code 占位符
4. 处理 **粗体** → `<strong>`
5. 处理 [text](url) → `<a href="escape(url)">text</a>`

**JS 和 Python 版渲染器必须逻辑一致**——Python 预渲染 seed.json，JS 运行时渲染，漏了一个都会出问题。

→ 完整代码见 `references/markdown-escape.md`

## 七、爬虫能力分级应对

| 爬虫 | JS 渲染 | 应对 |
|------|---------|------|
| Mediapartners-Google（AdSense） | ❌ | 广告位容器必须是静态 HTML |
| 搜狗 / 360 | ❌ | 页面 HTML 必须有完整骨架 |
| 百度 | ⚠️ 3-5s 超时 | 不要清空容器，保留静态种子 |
| Googlebot / 新版 Bing | ✅ | 没问题 |

## 八、避坑经验速查（高频踩过的）

| # | 坑 | 解法 |
|---|---|---|
| 1 | `innerHTML = ""` 清空容器 | 只删重复的，保留已有 |
| 2 | JS 设置 User-Agent 被静默阻止 | 后端 Worker 发起 |
| 3 | PowerShell 写中文 HTML 乱码 | UTF-8 BOM，或用 Python |
| 4 | 批量替换域名漏改 | `grep -r "旧域名" . --include="*.html"` 全量验证 |
| 5 | hreflang 和 sitemap x-default 不一致 | 改一个必须同步改另一个 |
| 6 | 相对路径写成 `/zh/` | 用 `./zh/` 和 `../zh/` |
| 7 | 缓存 key 不换只改 TTL | 换后缀 `-v1 → -v2` |
| 8 | load-more 按钮没跟着最后一张 | 每次前先 remove，追加完再 appendChild |
| 9 | markdown `` `<title>` `` 泄漏成真实标签 | 所有渲染输出必须 htmlEscape |
| 10 | Cloudflare Pages 默认 pages.dev 被 Google 收录 | `_headers` 加 `X-Robots-Tag: noindex` |
| 11 | robots.txt 带 UTF-8 BOM | 用 ASCII 重写 |
| 12 | sitemap 返回 application/xml | `_headers` 覆盖 Content-Type: text/xml |
| 13 | 所有 HTML 版本号改了一半就 push | grep 全量验证一致性 |
| 14 | Python 预渲染器忘了 htmlEscape | 用同一个函数（或逐行对照） |
| 15 | AdSense 爬虫不跑 JS，广告位靠 JS 插入 | 广告位容器必须是静态 HTML |
| 16 | **sitemap 读不了就反复改 XML 格式** | 格式几乎从不是原因，先测每条 `<loc>` 状态码 |
| 17 | **Cloudflare Pages 上 `.html` 全是 308** | 全站统一无扩展名 URL（sitemap/canonical/hreflang/内链/JS） |
| 18 | `_headers` 文档写了但文件里没有 | 读文件确认 + 线上验证响应头 |
| 19 | x-default 指向不存在的根级页面（软 200） | 与 HTML 的 x-default 保持一致 |
| 20 | 批量改锚点丢了 `#`（`./#faq` → `./faq`） | 替换后逐条验证 45 个锚点 |
| 21 | 无 UA 请求被 Cloudflare 403 | 检查 Bot Fight Mode / WAF 是否拦 Googlebot |
| 22 | **软 404：任意路径都返回 200 + 首页** | 输出根目录放 `404.html`，让错误地址真 404 |
| 23 | **sitemap 与 canonical 形态不一致** | 全站统一；Google 优先级 canonical > hreflang > sitemap |
| 24 | GSC 地址多尾斜杠/大小写错/用 www | 一字不差；用「网域」属性提交 |
| 25 | 部分页面有 BOM、部分没有 | 统一 UTF-8 无 BOM + LF |
| 26 | robots.txt 声明了 xml + txt 两条 Sitemap | 只保留 XML 一条 |
| 27 | **"Couldn't fetch" 就大改站点** | 多数是 pending（还没处理），站点侧通过就等 1–2 周 |
| 28 | GSC 按精确 URL 缓存失败记录 | 换查询参数 / 新文件名，绕开旧记录 |
| 29 | sitemap 命名空间写成 `https://` | 必须 `http://`，Google 不认 https 命名空间 |
| 30 | 反复重提交同一个 sitemap URL | 会重置 pending，保留现有记录等待 |

→ 完整避坑经验（40 条）见 `references/pitfalls.md`

## 九、发版后必做清单

1. commit + push
2. 更新 sitemap.xml 所有 `<lastmod>` 为最新日期
3. **Ctrl+Shift+R 硬刷新**本地验证
4. 百度站长平台手动提交 sitemap
5. 百度主动推送 API（零点后有额度）
6. Google Search Console 重新提交 sitemap
7. 观察 2-3 天收录数

→ 完整 checklist 见 `checklists/release-checklist.md`

## 十、Sitemap 与 URL 规范（血泪教训，必读）

这是本项目**反复失败最多次**的地方。核心认知：

### 1. sitemap 读不了，先别改 XML

XML 只要标准解析器能解析，格式就没问题。真正原因按命中率排查：

```
① sitemap 自身是否 200、是否重定向
② Content-Type 是否 text/xml
③ 是否带 BOM / 是否 UTF-8 / 行尾
④ 每条 <loc> 是否 200（重点！）
⑤ robots.txt 是否拦了
⑥ Cloudflare / WAF 是否拦 Googlebot（无 UA 403 是信号）
⑦ GSC 属性是否匹配
```

### 2. Cloudflare Pages：`.html` 一律 308

| 磁盘文件 | 真实 URL |
|---------|---------|
| `pages/about.html` | `/about` |
| `pages/zh/index.html` | `/zh/` |
| `pages/zh/changelog.html` | `/zh/changelog` |

**全站必须统一无扩展名**：sitemap `<loc>`、canonical、hreflang、站内导航、footer、JS 跳转。
漏一处就多一个 308。

锚点写法：`index.html#faq` → `./#faq`（**别丢 `#`**）。

### 3. 编码与行尾硬要求

- UTF-8、**无 BOM**（前 3 字节不能是 `EF BB BF`）
- **纯 LF**（`\r\n` 数量必须为 0）
- Python 写法：`open(path, "w", encoding="utf-8", newline="\n")`
- 不要用 PowerShell `Set-Content` / `Out-File` 生成

### 4. `_headers` 必须真的写进文件

```txt
/sitemap.xml
  Content-Type: text/xml
```

文档写了 ≠ 文件里有。改完必须读文件 + 线上验响应头。

### 5. 多语言 xhtml:link 的风险

能用简单格式就先简单格式（hreflang 在 HTML 里也有效）。
若用 xhtml:link：每条 alternate 必须 200、不能 404/308、x-default 必须与 HTML 一致。

### 6. 验证脚本（上线前必跑）

用**不跟随重定向**的客户端逐条测每个 `<loc>`：

```python
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
```

判定标准：sitemap 200 + Content-Type 正确 + 0 个 BOM + 0 个 CRLF + 0 个重定向 + 0 个非 200。

### 7. 软 404 会让"地址写错"永远不报 404

没有 `404.html` 时，Cloudflare Pages 对任意不存在路径返回 **200 + 首页 HTML**。
GSC 里 sitemap 地址多一个尾斜杠 / 大小写错 / 写成 `sitemap_index.xml`，拿到的都是 HTML，
只会报 "Couldn't read / type Unknown"，**永远不提示 404**，极难排查。

→ 输出根目录必须放 `404.html`，让未知路径返回真正的 404。

### 8. sitemap 必须与 canonical / hreflang 同形态

Google 优先级：**canonical > hreflang > sitemap**。
sitemap 写 `.html`、canonical 写无后缀 → 会被判为"替代网页"不收录，hreflang 自指也失效。
**全站统一一种形态**（Cloudflare Pages 推荐无扩展名）。

### 9. `Couldn't fetch` 可能只是"还没处理"

站点侧全部通过（200 / text/xml / 无 BOM / 无重定向 / robots 允许 / canonical 一致），
GSC 又只给 "Couldn't fetch"、没有具体错误码时，**大概率是 Google 的 pending 状态**
（best effort，可能几天到几个月）。不要继续大改站点，等 1–2 周；
可用 **Rich Results Tester（Desktop bot）** 确认 Google 能抓到 XML。

→ **完整排查手册、真实案例复盘、可复制验证脚本见 `references/sitemap-standards.md`**

---

## 文档索引

```
skills/website-skill/
├── SKILL.md                         ← 本文件（核心 + 索引）
├── README.md                        ← Skill 概述
├── checklists/
│   ├── release-checklist.md         ← 发版后必做清单
│   ├── seo-checklist.md             ← SEO 逐项核对
│   └── new-page-checklist.md        ← 新建页面必做
├── references/
│   ├── cache-versioning.md          ← 缓存版本号铁律详解
│   ├── multilingual-architecture.md ← 多语言架构全规范
│   ├── pagination-seo.md            ← 分页/无限滚动 SEO 安全实现
│   ├── markdown-escape.md           ← Markdown 渲染 HTML escape 完整代码
│   ├── deployment-cloudflare.md     ← Cloudflare Pages 部署方案
│   ├── sitemap-standards.md         ← ★ Sitemap 读不了的完整排查手册（重点）
│   ├── seo-standards.md             ← 完整 SEO 清单
│   ├── pitfalls.md                  ← 40 条避坑经验完整版
│   ├── ad-standards.md              ← AdSense 接入规范
│   └── code-style.md                ← 代码规范
└── templates/
    ├── SKILL.md（模板）              ← 新建子 Skill 参考
    └── _headers（模板）             ← Cloudflare _headers 示例
```
