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

→ 完整排查手册见 `references/sitemap-standards.md`
