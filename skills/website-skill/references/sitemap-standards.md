# Sitemap 规范与「Google 读不了」完整排查手册

> 这是最容易走弯路的一个环节：**99% 的人第一反应是"XML 格式写错了"，然后反复重写格式，依然读不了。**
> 本文按真实排查顺序记录，先给结论，再给可复制的验证脚本。

---

## 一、先记住三个结论

1. **XML 格式几乎从来不是"读不了"的原因。** 只要标准 XML 解析器能解析，格式就没问题。
2. **真正的元凶通常是：URL 是重定向、Content-Type 不对、被 WAF 拦截、`<loc>` 返回非 200。**
3. **改了 sitemap 后，GSC 里必须"先删除旧条目再重新提交"**，否则会一直显示旧的失败缓存。

---

## 二、最小合法 sitemap（先排除格式问题）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/</loc>
    <lastmod>2026-10-24</lastmod>
  </url>
</urlset>
```

用 Python 验证：

```python
import xml.etree.ElementTree as ET
ET.fromstring(open("sitemap.xml", encoding="utf-8").read())
```

**能解析 = 格式没问题，不要再改格式，去查下面第五节。**

---

## 三、排查顺序（按命中率从高到低）

| # | 检查项 | 判定标准 | 常见错误 |
|---|--------|---------|---------|
| 1 | sitemap 自身的 HTTP 状态 | 200，**不经过任何重定向** | `http://` → `https://` 跳转、`/sitemap.xml` 被重写 |
| 2 | Content-Type | `text/xml`（最稳）或 `application/xml` | Cloudflare Pages 默认 `application/xml`，GSC 某些版本报读不了 |
| 3 | BOM | 前 3 字节不能是 `EF BB BF` | PowerShell `Set-Content` 默认写 BOM |
| 4 | 编码 | UTF-8 | GBK / ANSI |
| 5 | 行尾 | 纯 LF 最稳 | 混合 CRLF/LF（一般无害，但排除变量） |
| 6 | **每个 `<loc>` 的最终状态** | **200，且不经过 301/302/308** | `.html` 被 Pretty URLs 308、尾斜杠跳转 |
| 7 | robots.txt | 不能 `Disallow: /sitemap.xml` | 误写通配符 |
| 8 | WAF / Bot Fight Mode | Googlebot UA 必须 200 | 无 UA 请求 403 是重要信号 |
| 9 | GSC 属性类型 | 域名属性 or URL 前缀属性要匹配 | 提交到错误的属性下 |
| 10 | sitemap 位置 | 必须在站点根或其子目录 | 放在 CDN 子路径 |

---

## 四、真实案例复盘（最有价值的部分）

某多语言静态站，sitemap 检查结果：

```
✅ XML 解析通过
✅ 无 BOM
✅ 纯 LF
✅ UTF-8 合法
✅ 16 个 <loc> 本地文件全部存在
❌ 线上仍然 "Sitemap could not be read"
```

逐项实测后发现 **三个叠加问题**：

### 问题 1（最致命）：12/16 个 `<loc>` 都是 308 重定向

旧 sitemap 写的是：

```xml
<loc>https://example.com/zh/about.html</loc>
```

但 Cloudflare Pages 默认启用 **Pretty URLs**，实测：

```
/zh/about.html   → 308 → /zh/about     (200)
/zh/index.html   → 308 → /zh/          (200)
/zh/changelog.html → 308 → /zh/changelog (200)
```

**12 个页面 URL 全部 308**。GSC 会认为 sitemap 里是一堆重定向地址。

> 关键认知：**`.html` 不是网站的真实地址，无扩展名才是。**

### 问题 2：`_headers` 里根本没有 Content-Type 规则

线上实测：

```
Content-Type: application/xml   ← 期望 text/xml
```

检查 `_headers`：只有 pages.dev 的 noindex 一条，文档里写的 `/sitemap.xml → text/xml` **从未真正写进文件**。

> 教训：**文档写了 ≠ 文件里有。改完必须读文件确认，并线上 curl 验证响应头。**

### 问题 3：3 个 x-default 指向不存在的根级页面

旧 sitemap 的 subpage x-default 写成：

```xml
<hreflang="x-default" href="https://example.com/about.html"/>
```

但站点根目录**没有** `about.html`（只有 `/en/about`），线上却返回 200（软 404）。

> 软 404 比 404 更危险：爬虫以为页面存在，实际内容是首页/空壳。

### 附加信号：无 UA 请求被 403

```
UA=None                                      → 403
UA=Mozilla/5.0                               → 200
UA=Googlebot/2.1 (+http://www.google.com/bot.html) → 200
```

说明 Cloudflare 有"无 UA 即拦截"的规则。Googlebot UA 能过，但要确认 Bot Fight Mode 没有挑战官方爬虫。

---

## 五、Cloudflare Pages Pretty URLs（必须理解）

Cloudflare Pages 默认把 `.html` 地址重定向到无扩展名：

| 磁盘文件 | 部署后的真实 URL |
|---------|-----------------|
| `pages/index.html` | `/` |
| `pages/about.html` | `/about` |
| `pages/zh/index.html` | `/zh/` |
| `pages/zh/about.html` | `/zh/about` |
| `pages/changelog.html` | `/changelog` |

**推论（全站必须统一）**：

- sitemap 的 `<loc>` → 无扩展名
- 每页的 `<link rel="canonical">` → 无扩展名
- 所有 `hreflang` 的 `href` → 无扩展名
- 站内导航 / footer 链接 → 无扩展名
- JS 语言跳转字符串 → 无扩展名

**漏掉任何一处，就会产生 308。**

> 用相对链接时：`href="about"` 在 `/zh/xxx` 下解析为 `/zh/about`，正确。
> 返回首页用 `href="./"`（解析为 `/zh/`），不要写 `href="index"`（会变成 `/zh/index`，再 308 到 `/zh/`）。
> 带锚点：`index.html#faq` → `./#faq`（**注意保留 `#`**，这是极易写错的地方）。

---

## 六、推荐格式（最大兼容性）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://example.com/</loc>
    <lastmod>2026-10-24</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://example.com/zh/</loc>
    <lastmod>2026-10-24</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
</urlset>
```

说明：

- `changefreq` / `priority` Google 基本忽略，但写了无害；照抄简单格式即可。
- `<lastmod>` 才是 Google 唯一参考的字段（ISO 8601：`YYYY-MM-DD`）。
- 每条 `<loc>` 必须是最终 200 地址。
- 顺序建议：首页 → 各语言首页 → 各语言子页。

### 多语言站点：要不要 xhtml:link？

两种都合法：

| 方案 | 优点 | 风险 |
|------|------|------|
| **简单格式（本文推荐起点）** | 解析成功率最高 | sitemap 内不声明 hreflang（但 HTML `<head>` 里仍有，Google 认可） |
| **xhtml:link 互指** | sitemap 内也能表达语言关系 | 任一 alternate 404 / 不一致，都会产生错误 |

如果选择 xhtml:link，必须满足：

1. `<urlset>` 上声明命名空间：
   ```xml
   <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
           xmlns:xhtml="http://www.w3.org/1999/xhtml">
   ```
2. **每一条 alternate 都必须 200，不能是 404，也不能是 308。**
3. **x-default 必须与 HTML 里的 `x-default` 完全一致。**
4. 每个语言版本都要互相声明（双向）。
5. `lastmod` 可选，缺了不影响解析。

> 判断原则：**先让 Google 能读（简单格式），再逐步加高级特性。** 不要一上来就堆 xhtml:link。

---

## 七、编码与行尾（硬性要求）

| 项目 | 要求 | 验证方法 |
|------|------|---------|
| 编码 | UTF-8 | `raw.decode("utf-8")` 不抛异常 |
| BOM | **无**（前 3 字节不能是 `EF BB BF`） | `raw[:3] != b"\xef\xbb\xbf"` |
| 行尾 | **纯 LF**（`\n`） | `raw.count(b"\r\n") == 0` |
| 缩进 | 2 空格 / 子项 4 空格 | 目测 |

### 正确的 Python 写法

```python
content = "\n".join(lines) + "\n"

with open("sitemap.xml", "w", encoding="utf-8", newline="\n") as f:
    f.write(content)
```

- `encoding="utf-8"` → 不写 BOM
- `newline="\n"` → 强制 LF（否则 Windows 上默认 CRLF）

### 绝对不要用 PowerShell 生成

```powershell
# ❌ 默认 UTF-16/ANSI、可能带 BOM、CRLF
Set-Content sitemap.xml $content
Out-File sitemap.xml
```

### `_headers` 也要 LF + 无 BOM

Cloudflare Pages 对 `_headers` 的格式敏感，建议同样 UTF-8 无 BOM + LF。

---

## 八、Cloudflare Pages `_headers` 配置

```txt
# Google Search Console 的 sitemap 抓取器需要 text/xml
/sitemap.xml
  Content-Type: text/xml

# 防止 *.pages.dev 子域名被收录（重复内容）
https://your-project.pages.dev/*
  X-Robots-Tag: noindex
```

要点：

- 路径规则以 `/` 开头，header 行**必须 2 空格缩进**
- 主机规则可以写完整 `https://.../*`（实测有效）
- **必须随 `pages/` 一起部署**，否则不生效
- 部署后必须线上验证响应头

---

## 九、可复制的完整验证脚本

```python
# -*- coding: utf-8 -*-
import re
import xml.etree.ElementTree as ET
import urllib.request
import urllib.error

BOM = b"\xef\xbb\xbf"
SITEMAP = "https://example.com/sitemap.xml"

# ---------- 1. 本地文件字节检查 ----------
with open("pages/sitemap.xml", "rb") as f:
    raw = f.read()

print("BOM:", "❌ 有" if raw[:3] == BOM else "✅ 无")
crlf = raw.count(b"\r\n")
print("行尾:", f"CRLF={crlf}", "✅ 纯 LF" if crlf == 0 else "❌ 含 CRLF")

text = raw.decode("utf-8")
root = ET.fromstring(text)
print("XML 解析: ✅")
locs = re.findall(r"<loc>(.*?)</loc>", text)
print("<loc> 数量:", len(locs))

# ---------- 2. sitemap 自身状态 ----------
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # 不跟随，暴露 301/302/308

opener = urllib.request.build_opener(NoRedirect)

req = urllib.request.Request(
    SITEMAP,
    headers={"User-Agent": "Googlebot/2.1 (+http://www.google.com/bot.html)"},
)
try:
    with opener.open(req, timeout=20) as r:
        print("sitemap HTTP:", r.status)
        print("Content-Type:", r.headers.get("Content-Type"))
except urllib.error.HTTPError as e:
    print("❌ sitemap 状态异常:", e.code, e.headers.get("Location"))

# ---------- 3. 每个 <loc> 必须 200 且不重定向 ----------
bad = 0
for u in locs:
    req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with opener.open(req, timeout=15) as r:
            if r.status != 200:
                print("❌", r.status, u)
                bad += 1
    except urllib.error.HTTPError as e:
        print("❌", e.code, u, "→", e.headers.get("Location", ""))
        bad += 1

print(f"异常 URL: {bad} / {len(locs)}")

# ---------- 4. 检查无 UA 是否被拦 ----------
try:
    urllib.request.urlopen(SITEMAP, timeout=15)  # 默认 Python UA
    print("无 UA 请求: ✅ 通过")
except urllib.error.HTTPError as e:
    print("无 UA 请求: ❌", e.code, "（检查 Cloudflare Bot Fight Mode / WAF）")
```

**判定标准：4 项全部通过才算 sitemap 健康。**

---

## 十、GSC 提交与排错流程

1. **先删除旧 sitemap 条目**（失败的抓取结果会缓存，不删会一直显示失败）
2. 重新提交 `https://yourdomain.com/sitemap.xml`
3. 等 1–3 天
4. 看 "Sitemaps" 报告的 **Discovered URLs** 数量是否等于 sitemap 条数
5. 看 "Page indexing" → 是否有 "Crawled - currently not indexed"（内容质量问题）
6. 对重点页面用 "URL Inspection" → "Request indexing"

常见报告与含义：

| 报告 | 含义 | 处理 |
|------|------|------|
| Couldn't fetch | sitemap 本身不可访问（状态/重定向/被拦） | 查第三节 1/2/8 |
| Couldn't read | Content-Type / BOM / XML 解析问题 | 查第三节 2/3/4 |
| Sitemap contains URLs which are redirects | `<loc>` 有 301/308 | 改用最终 200 地址 |
| URLs not found (404) | `<loc>` 指向不存在页面 | 修正或删除 |
| 0 discovered URLs | 解析失败或格式错误 | 重跑验证脚本 |

---

## 十一、上线前 Sitemap Checklist

- [ ] 文件是 UTF-8 **无 BOM**
- [ ] 行尾纯 **LF**
- [ ] 标准 XML 解析器能解析
- [ ] `<loc>` 全部是**最终 200 地址**（无 `.html`、无尾斜杠跳转）
- [ ] 用"不跟随重定向"的客户端逐个测过，**0 个 301/302/308**
- [ ] sitemap 自身 URL 返回 200，不重定向
- [ ] Content-Type 为 `text/xml`（或至少 `application/xml`）
- [ ] `_headers` 规则已写进文件并部署
- [ ] robots.txt 里 `Sitemap:` 指向正确绝对地址
- [ ] canonical / hreflang / 站内链接与 sitemap 的 URL 风格**完全一致**
- [ ] 无 UA 请求不被 WAF 拦截
- [ ] GSC 删除旧条目后重新提交

---

## 十二、一句话总结

> **sitemap 读不了，先别改 XML；打开"不跟随重定向"的客户端，把每条 `<loc>` 和 sitemap 自身的状态码打出来看。**
> **在 Cloudflare Pages 上，`.html` 一律等于 308，全站必须统一用无扩展名地址。**
