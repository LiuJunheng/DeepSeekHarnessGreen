# 完整 SEO 清单

## sitemap.xml

- [ ] **`<lastmod>` 是唯一影响 Google 抓取优先级的字段**（changefreq / priority 基本被忽略）
- [ ] 多语言站点加 `<xhtml:link rel="alternate" hreflang="…">` 互指（Google 官方推荐的标准做法）
- [ ] 每次 push 后把所有 URL 的 `<lastmod>` 统一填最新 commit 日期
- [ ] sitemap 和 HTML 里的 x-default 必须一致（否则 Google 混乱）
- [ ] 路径用绝对 URL：`https://yourdomain.com/zh/page.html`

## robots.txt

- [ ] 纯 ASCII，不含 BOM（Cloudflare / Google 对 BOM 可能解析失败）
- [ ] `Sitemap: https://yourdomain.com/sitemap.xml` 指向当前域名的绝对 URL
- [ ] 不要用旧域名路径（比如 GitHub Pages 路径）

## 每页 Head 必含

- [ ] `<meta name="description" content="...">`（唯一、有信息量，80-160 字符）
- [ ] `<title>` 唯一（不要超过 60 字符，每个页面一个 `<h1>`）
- [ ] canonical 自指
- [ ] 4 条 hreflang + 1 条 x-default

## 爬虫能力分级应对

| 爬虫 | JS 渲染 | 必须做 |
|------|---------|-------|
| Mediapartners-Google（AdSense） | ❌ 不跑 JS | 广告位容器必须是静态 HTML |
| 搜狗 / 360 / 纯 HTTP fetcher | ❌ 不跑 JS | 页面 HTML 必须有完整内容骨架 |
| 百度（主力） | ⚠️ 弱 JS，3-5s 超时 | 不要清空容器，保留 HTML 静态种子 |
| Googlebot / 新版 Bing | ✅ 完整 JS + XHR | 没问题 |

## 分页 / 无限滚动

- [ ] JS 启动后**不要做** `container.innerHTML = ""`（爬虫保底）
- [ ] 加载更多按钮每次追加前先 `btn.remove()`，追加完再 `appendChild(btn)`（按钮永远跟最后一张）
- [ ] localStorage 缓存换 key 后缀才能强制清旧缓存

## Markdown 渲染

- [ ] 所有 markdown → HTML 输出**必须先做 htmlEscape**（& < > "）
- [ ] renderInline 顺序：摘行内 code 占位 → escape 剩余 → 恢复 code → 粗体 → 链接
- [ ] 代码块内部也必须 escape
- [ ] JS 和 Python 版渲染器必须逻辑一致

## 站内优化

- [ ] 图片有 `alt`，装饰图片加 `aria-hidden="true"`
- [ ] 语义化标签（header/nav/main/section/footer）
- [ ] 每个页面只有一个 `<h1>`
- [ ] 锚点用 `page.html#section` 形式（跨页锚点不写裸 `#section`）

## 结构化数据

- [ ] JSON-LD `SoftwareApplication`（Schema.org 标准）
- [ ] 刻意省略：`softwareVersion`（每次发版容易漏）、`applicationSubCategory`（Schema.org 没有）
- [ ] Google Rich Results Test 验证

## 站长平台

- [ ] 百度站长平台：验证标签 + 手动提交 sitemap（无额度限制）
- [ ] 百度主动推送 API（加急，每天零点重置额度）
- [ ] Google Search Console：验证域名 + 提交 sitemap 变更
- [ ] 搜狗站长平台：验证标签
- [ ] Bing Webmaster Tools：可选

## Cloudflare Pages 特定

- [ ] `_headers` 给 `*.pages.dev/*` 加 `X-Robots-Tag: noindex`
- [ ] `_headers` 给 `/sitemap.xml` 覆盖 `Content-Type: text/xml`

## 定期检查

- [ ] 观察 2-3 天收录数变化
- [ ] Search Console 检查是否有 "Crawled currently not indexed"
- [ ] 主动抓取测试（Search Console 里手动触发）
