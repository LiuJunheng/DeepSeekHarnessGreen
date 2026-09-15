# SEO 逐项核对清单

每次改了页面或发布新版，逐项核对。

## HTML 结构

- [ ] 每个页面唯一 `<h1>`
- [ ] `<title>` 唯一、< 60 字符、含关键词
- [ ] `<meta name="description">` 80-160 字符、有信息量、唯一
- [ ] 语义化标签（header / nav / main / section / footer）
- [ ] 所有 `<img>` 有 `alt`
- [ ] 装饰图片 `aria-hidden="true"`

## hreflang / canonical（每个新页面必查）

- [ ] `<link rel="canonical" href="自己的绝对 URL">`
- [ ] `<link rel="alternate" hreflang="zh-Hans" href="zh 版 URL">`
- [ ] `<link rel="alternate" hreflang="zh-Hant" href="zh-Hant 版 URL">`
- [ ] `<link rel="alternate" hreflang="en" href="en 版 URL">`
- [ ] `<link rel="alternate" hreflang="x-default" href="fallback URL">`
- [ ] x-default 规则：首页 → 根 `/`；子页 → `/en/`
- [ ] sitemap.xml 的 xhtml:link 和 HTML 里的 hreflang **完全一致**

## robots / sitemap

- [ ] robots.txt 纯 ASCII，无 BOM
- [ ] robots.txt 的 `Sitemap:` 指向当前域名绝对 URL
- [ ] sitemap.xml 所有 `<lastmod>` 已更新
- [ ] sitemap.xml XML 格式正确（浏览器可打开）
- [ ] sitemap Content-Type 是 text/xml（_headers 覆盖）

## 爬虫保底

- [ ] changelog / blog 等内容页 HTML 里有静态内容（爬虫保底）
- [ ] JS 不清空容器（`innerHTML = ""` 已移除）
- [ ] Markdown 渲染输出已 htmlEscape
- [ ] 分页/加载更多不依赖 JS 才能看到首屏内容

## Cloudflare Pages 特定

- [ ] `_headers` 给 pages.dev 子域名加 `X-Robots-Tag: noindex`
- [ ] `_headers` 给 sitemap.xml 覆盖 Content-Type: text/xml
- [ ] 自定义域名是唯一主域名

## 站长平台

- [ ] 百度站长平台：验证 + sitemap 提交
- [ ] Google Search Console：验证 + sitemap 提交 + Rich Results Test
- [ ] 搜狗站长平台：验证
- [ ] Bing（可选）：验证

## 定期检查（每周/每两周）

- [ ] 收录数变化趋势
- [ ] Search Console "网页" 报告
- [ ] Search Console "已抓取 - 目前未编入索引" 报告
- [ ] 主动抓取测试（Search Console 里手动触发）
- [ ] `site:yourdomain.com` 在百度 / Google 搜索，看收录状态
