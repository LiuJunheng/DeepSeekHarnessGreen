# 新建页面必做清单

每当网站要加一个新页面（如 tutorial.html），逐项核对。

## 文件结构

- [ ] `pages/zh/新页面.html`（简体）
- [ ] `pages/zh-Hant/新页面.html`（繁体）
- [ ] `pages/en/新页面.html`（英文）
- [ ] 文件名三语一致

## Head 标签（三语都要）

- [ ] `<meta charset="UTF-8">`
- [ ] `<title>`（页面名 - 站点名）
- [ ] `<meta name="description" content="...">`
- [ ] canonical 自指（绝对 URL）
- [ ] 4 条 hreflang + 1 条 x-default
- [ ] x-default 指向 `/en/新页面.html`（子页 → /en/ fallback）
- [ ] 站长验证标签（百度 / AdSense / 搜狗）
- [ ] AdSense adsbygoogle.js
- [ ] style.css?v + app.js?v（版本号与全站一致）

## sitemap.xml

- [ ] 新增 3 个 `<url>`（三语各一条）
- [ ] 每个 `<url>` 带 4 个 `<xhtml:link>` 互指
- [ ] `<lastmod>` 填今天日期

## 导航 / Footer

- [ ] 三语首页导航栏加新页面入口
- [ ] 三语首页 footer 加新页面入口
- [ ] 语言切换器正常（每个页面都能跳对应语言的同一页面）

## 代码规范

- [ ] 子页路径用 `../assets/xxx`
- [ ] CSS class kebab-case、语义化
- [ ] JS 变量全称、小驼峰、ES5 写法
- [ ] 外部链接 `target="_blank" rel="noopener"`
- [ ] 第三方外链 `rel="nofollow noopener noreferrer"`
- [ ] 所有 `<img>` 有 `alt`
- [ ] 装饰元素 `aria-hidden="true"`

## 文案

- [ ] 中文正文自然（非机翻）
- [ ] 英文正文自然（非机翻）
- [ ] 繁体从简体转换，保护 HTML tag 不转

## 多语言一致性检查

- [ ] 三语页面结构相同
- [ ] 三语页面导航都有新页面入口
- [ ] 三语页面 footer 都有新页面入口
- [ ] 语言切换器从新页面出发能正确跳转到对应语言的同一页面

## SEO

- [ ] hreflang 格式正确（zh-Hans / zh-Hant / en / x-default）
- [ ] sitemap 的 xhtml:link 和 HTML 里的 hreflang 一致
- [ ] `<h1>` 唯一
- [ ] `<meta name="description">` 有信息量

## 提交前验证

- [ ] grep 所有 HTML 的 app.js?v 版本号一致
- [ ] grep 所有 HTML 的 style.css?v 版本号一致
- [ ] Ctrl+Shift+R 硬刷新本地，三个语言都能打开新页面
- [ ] console 无 JS error
