# 21 条高频踩坑经验（完整版）

## 一、爬虫 & SEO 类（最痛的）

1. **`innerHTML = ""` 清空容器导致爬虫看到空壳** — JS 启动时不要清空 HTML 里的静态种子。百度爬虫 3-5 秒超时，可能在 XHR 回来前就停止了。正确做法：收集已有 data-tag，只追加没有的。

2. **renderSimpleMarkdown 必须先做 HTML escape 再输出** — markdown 里的 `` `<title>` `` `` `<meta name="description">` `` 会被浏览器当成真实标签，导致 DOM 错乱、内容截断、SEO 爬虫截断。renderInline 顺序：摘行内 code 占位 → escape 剩余文本 → 恢复 code → 处理粗体/链接。Python 预渲染器也必须同样做 escape。

3. **changelog 的 renderAll 不要 `container.innerHTML = ""`** — 同第 1 条，但针对 changelog 页面的特有场景（爬虫保底）。

4. **renderChunk 的 load-more 按钮每次追加前必须先 `btn.remove()`，追加完再 `container.appendChild(btn)`** — 否则按钮永远卡在第一次追加的位置（第 10 条后面），新卡片堆在按钮前面，用户滚到底"找不到按钮"。按钮永远是容器最后一个子节点。

5. **sitemap 和 HTML 里的 x-default 必须一致** — sitemap 的 xhtml:link 声明 x-default 指向 A，但 HTML 的 `<link rel="alternate" hreflang="x-default">` 指向 B，Google 会混乱。规则：首页 → 根 `/`；子页 → `/en/` 对应路径。

6. **sitemap `<lastmod>` 是唯一影响 Google 抓取优先级的 sitemap 字段** — changefreq / priority 基本被忽略。每次实质性改了内容必须更新 lastmod（ISO 8601 日期），否则 Google 可能不重新抓取。

7. **多语言 sitemap 用 xhtml:link 扩展是正确的，别被 Google 最简示例误导** — Google 文档给的最简示例只有 `<loc>`/`<lastmod>`，不是唯一格式。多语言站点加 `<xhtml:link rel="alternate" hreflang="…">` 是 Google 官方推荐的标准做法。

8. **Mediapartners-Google（AdSense 爬虫）不跑 JS** — 看不到 JS 动态渲染的内容。广告位容器、站长验证标签必须是**静态 HTML 源码的一部分**，不能靠 JS 注入。

## 二、缓存类

9. **所有 HTML 的 app.js / style.css 版本号必须同步** — 曾经出现过 index.html 还在 `app.js?v=3.8`、changelog.html 已 `v=3.10` 的中间态，用户加载旧缓存看到"SEO 段落截断"，排查 3 小时。改了 app.js → 所有引用它的 HTML 一起升；改了 style.css → 所有 HTML 一起升。**改完 grep 全量验证一致性**。

10. **localStorage 缓存换 key 才能强制清旧缓存** — 只改 TTL 不改 key，旧缓存还在 TTL 内不会重新拉 API。发新版想让用户立刻看到新内容，要么换 key 后缀（-v1 → -v2），要么手动提示清 localStorage。

## 三、路径 & 编码类

11. **JS 跳转相对路径铁律** — `./zh/` 不能写 `/zh/`，后者在 `file://` 下跳到磁盘根、线上跳到错误子域。

12. **PowerShell 写中文 HTML 必须 UTF-8 BOM** — `Set-Content` 默认 ANSI（GBK），浏览器按 UTF-8 解析就乱码。建议用 Python 保持 UTF-8 无 BOM。

13. **批量替换域名后必须 grep 全量验证零残留** — privacy.html 里链接文字、footer 里的版权声明容易漏改。

14. **Cloudflare Pages 默认给 `.pages.dev` 子域名分配同一套页面** — 若自定义域名和 pages.dev 别名同时可访问，Google 判定为重复内容、分散权重。`_headers` 里加 `X-Robots-Tag: noindex`。

15. **robots.txt 带 UTF-8 BOM** — 用 ASCII 重写；robots.txt 建议纯 ASCII，兼容最广。

16. **sitemap Content-Type 被返回 application/xml** — Cloudflare 默认行为，但 GSC 某些版本只识别 text/xml。`_headers` 覆盖：`/sitemap.xml` 行下面 2 空格缩进写 `Content-Type: text/xml`。

## 四、API & 限流类

17. **浏览器 JS 不能设置受保护请求头** — `fetch()` / `XMLHttpRequest.setRequestHeader()` 禁止设置 User-Agent、Cookie、Origin、Referer 等浏览器安全头，写了会抛 `Refused to set unsafe header` 导致整个请求静默失败。如需自定义 UA，必须在后端（Cloudflare Worker）发起。

18. **前端直连 GitHub REST API 有限流** — 匿名请求 60 req/hour/IP，带 PAT 5000 req/hour。用 localStorage 15 分钟缓存（key 换后缀才能清旧缓存）。

19. **百度主动推送每天零点重置额度** — 超额度返回 `{"error":400}` over quota，不建议硬编码进 CI（push 失败会阻塞构建）。

## 五、其他

20. **Schema.org SoftwareApplication 没有 applicationSubCategory 字段** — 用了 Google 会静默忽略，别浪费。`softwareVersion` 虽然 Schema.org 有但每次发版要手动同步，**建议省略**（Google 富文本展示不强制依赖）。

21. **ad-slot 容器样式投放后要调整** — AdSense `<ins>` 自带尺寸会自动填充，投放前的虚线占位边框 / 背景要去掉。CSS 里用注释区分占位 vs 投放后。

## 六、sitemap / URL（最容易反复踩）

22. **sitemap 读不了，先别改 XML 格式** — 90% 的人第一反应是重写 XML，结果毫无作用。只要标准 XML 解析器能解析，格式就不是原因。真正原因按命中率：① sitemap 自身重定向 ② Content-Type 不对 ③ BOM ④ 每条 `<loc>` 非 200（最常见）⑤ WAF 拦截 ⑥ GSC 属性不匹配。

23. **Cloudflare Pages 上 `.html` 一律 308** — `/zh/about.html` → 308 → `/zh/about`；`/zh/index.html` → 308 → `/zh/`；`/zh/changelog.html` → 308 → `/zh/changelog`。**全站必须统一无扩展名**：sitemap `<loc>`、canonical、hreflang、站内导航、footer、JS 跳转。漏一处就多一个 308。注意 Python `urllib` 默认**不跟随 308**，正好可以用来暴露问题；`curl -L` 会自动跟，反而看不出来。

24. **`_headers` 文档写了但文件里没有** — 曾经文档写明 `/sitemap.xml → text/xml`，实际文件里只有 pages.dev 的 noindex，线上一直是 `application/xml`。改完必须 **Read 文件确认 + 线上验证响应头**。正确写法：

    ```txt
    /sitemap.xml
      Content-Type: text/xml
    ```

    路径以 `/` 开头，header 行 2 空格缩进，随 `pages/` 一起部署才生效。

25. **x-default 指向不存在的根级页面会返回软 200** — sitemap 里写 `https://example.com/about.html`，但根目录没有该文件，线上却返回 200（软 404）。比真 404 更危险：爬虫以为页面存在。x-default 必须与 HTML 的 `x-default` 完全一致，且每条 alternate 都要 200。

26. **批量改 `index.html#anchor` 时极易丢掉 `#`** — 正确：`index.html#faq` → `./#faq`；错误写法 `"./" + val[len("index.html#"):]` 会得到 `./faq`（404）。批量替换后必须用链接解析器逐条验证，不要只看替换数量。

27. **无 UA 请求被 Cloudflare 403 是 WAF 拦截信号** — 实测 `UA=None → 403`、`Googlebot UA → 200`。GSC 报 "Couldn't fetch" 时，去 Security → Bots 检查 Bot Fight Mode / WAF 是否挑战官方爬虫。

28. **GSC 会缓存旧的失败结果** — 修好 sitemap 后，必须先在 GSC **删除旧条目**，再重新提交同一个 URL；否则可能长时间仍显示 "Couldn't read"。

29. **软 404：任意不存在路径返回 200 + 首页 HTML** — Cloudflare Pages 项目在没有 `404.html` 时会这样（实测 `/sitemap.xml/`、`/Sitemap.xml`、`/sitemap_index.xml`、`/nonexistent-abc-987` 全部 200 + 首页）。后果：GSC 里 sitemap 地址只要多一个尾斜杠、大小写错、写错文件名，拿到的就是 HTML，GSC 只能报 "Couldn't read / type Unknown"，**永远不会提示 404**，极难排查。修复：在输出根目录放 `404.html`，让未知路径返回真正的 404。

30. **sitemap 与 canonical / hreflang 形态必须一致** — Google 优先级是 **canonical > hreflang > sitemap**。sitemap 写 `/zh/about.html`、canonical 写 `/zh/about` 时，URL 会被判为"规范网页的替代网页"（Alternate page with proper canonical tag），不收录；同时 hreflang 要求每个成员有自指标签，形态不一致会让整个三语互指失效。**全站统一一种形态**（Cloudflare Pages 推荐无扩展名）。

31. **GSC 提交地址必须一字不差** — 不带尾斜杠、大小写正确、不用 `www`（会 301）、不写 `sitemap_index.xml`。配合第 29 条软 404，错误地址不会报 404，只会报"读不了"。建议用「网域」属性提交。

32. **BOM 不一致** — 一部分页面有 UTF-8 BOM、一部分没有（PowerShell 写文件留下的）。统一为 **UTF-8 无 BOM + LF**；验证 `raw[:3] != EF BB BF` 且 `b"\r\n" not in raw`。

33. **robots.txt 同时声明 xml + txt** — GSC 会出现两条 sitemap 记录，其中一条状态异常时容易误判。只保留一条 XML 的 `Sitemap:`。

34. **`Couldn't fetch` / `Sitemap could not be read` 常常是 "还没处理"，不是抓取失败** — Google 的 Diamond Product Expert 置顶说明：Google 处理 sitemap 是 best effort，有巨大积压，可能几天到几个月；真正失败会给更具体的错误码。站点侧全部通过、又没有具体错误时，**不要继续大改站点**，等 1–2 周。

35. **GSC 按精确 URL 缓存失败记录** — 同一个 URL 会长期停留在旧状态。换一个"GSC 没见过的 URL"常能触发重新抓取：查询参数（`?gsc_check=...`）、改名（`sitemap2.xml`）、嵌套路径。注意：有 `404.html` 的站点，末尾加 `/` 会返回 404，不能用。

36. **sitemap 命名空间必须是 `http://`，不能是 `https://`** — Google 的 sitemap 解析器不认 `https://www.sitemaps.org/schemas/sitemap/0.9`。Next.js 曾出现此回归 bug（15.4.4 修复）。生成后务必检查 `<urlset xmlns="http://...">`。

37. **不要反复重提交同一个 sitemap URL** — 会重置 pending 状态，反而不利。站点侧没问题时保留现有记录，等它自己转成功。

38. **Cloudflare Pages 可能集体出现 "200 + 合法 XML 但 GSC 报 Couldn't fetch"** — 2026-10 多个 Pages 站点同症状，robots/URL/canonical 全部正常、URL Inspection 也成功，站点侧找不到原因。先确认站点侧全部通过，再判断为平台/Google 侧问题，避免过度改造。

39. **Sitemap 只是提示，不是收录必要条件** — Googlebot 通过站内链接也能抓全站，小站尤其如此。不要把收录完全押在 sitemap 状态上；内容质量和内链才是根本。

40. **`X-Robots-Tag: noindex` 不阻止 sitemap 被处理** — sitemap 本身 noindex 是正常的（Product Expert 明确说明）。真正的问题是 WAF/CDN 对 Googlebot 返回 HTML、挑战页或空响应，而不是 XML。

→ 完整排查手册见 `references/sitemap-standards.md`
