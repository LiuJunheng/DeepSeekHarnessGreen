# Cloudflare Pages 部署方案

## 基础配置

```
Framework preset:   None（纯静态，无构建）
Build command:       留空
Build output dir:    pages  （或项目根下的输出目录，相对路径不带 /）
Root directory:      ./
```

Cloudflare Pages 拉取 Gitee/GitHub 仓库，webhook 触发自动部署（~30 秒）。

## Pretty URLs：`.html` 一律 308（重要！）

Cloudflare Pages 默认启用 Pretty URLs，会把 `.html` 地址重定向到无扩展名：

| 磁盘文件 | 请求 `.html` | 真实 200 地址 |
|---------|-------------|--------------|
| `index.html` | `/index.html` → 308 | `/` |
| `about.html` | `/about.html` → 308 | `/about` |
| `zh/index.html` | `/zh/index.html` → 308 | `/zh/` |
| `zh/changelog.html` | `/zh/changelog.html` → 308 | `/zh/changelog` |

**推论：全站 URL 必须统一无扩展名**，否则每处 `.html` 都是一个 308：

- sitemap 的 `<loc>`
- `<link rel="canonical">`
- 所有 `hreflang` 的 `href`
- 站内导航 / footer / 返回首页链接
- JS 语言跳转字符串

**相对链接注意**：
- 同目录页面：`href="about"` → `/zh/about` ✅
- 返回首页：`href="./"` → `/zh/` ✅（不要写 `href="index"`）
- 带锚点：`index.html#faq` → `./#faq`（**别丢 `#`**）

**验证方法**：用不跟随重定向的 HTTP 客户端逐条测。Python `urllib` 默认不跟随 308，正好能暴露问题；`curl -L` 会自动跟，反而看不出来。

## 自定义 404 页（必须）

Cloudflare Pages 项目在**没有 `404.html`** 时，会对任意不存在的路径返回 **200 + 首页 HTML**（软 404）。

后果：

- GSC 里 sitemap 地址写错（多尾斜杠、大小写错、写成 `sitemap_index.xml`）**永远不报 404**，只报 "Couldn't fetch / Couldn't read"
- 大量软 404 会污染索引

修复：在输出根目录放 `pages/404.html`。Pages 会自动用它并返回真正的 404 状态。

注意：404 页会在任意路径下渲染，所以页内资源/链接必须用**根绝对路径**（`/assets/...`、`/zh/`），不能用 `./` 相对路径；最稳妥是把 CSS 直接内联。

## 子域名 noindex（防重复内容）

Cloudflare Pages 默认给项目分配 `xxx.pages.dev` 子域名。自定义域名和子域名同时可访问会被 Google 判定为重复内容。

**解决方案**：在 `pages/_headers` 文件里加：

```
https://your-project.pages.dev/*
  X-Robots-Tag: noindex
```

**_headers 格式要点**：
- 纯文本文件，UTF-8 无 BOM
- URL 路径前有 `/`（除了通配符那行）
- header 行必须 **2 空格缩进**
- 自定义域名不受影响

## sitemap Content-Type 覆盖

Cloudflare 默认给 `.xml` 返回 `application/xml`，但 Google Search Console 某些版本只识别 `text/xml`（报 "Sitemap could not be read"）。在 `_headers` 里加：

```
/sitemap.xml
  Content-Type: text/xml
```

## 完整 _headers 示例

```
/sitemap.xml
  Content-Type: text/xml

https://deepseek-harness-green.pages.dev/*
  X-Robots-Tag: noindex
```

## CNAME Flattening（裸域）

```
CNAME  @ → deepseek-harness-green.pages.dev（Proxied ✅）
```

Cloudflare DNS 托管才能用裸域 CNAME，云朵图标必须亮（Proxied）。DNS Only 不行。

## 旧域名 301 跳转（GitHub Pages / Gitee Pages）

Pages 类服务不支持真正的 HTTP 301，只能靠三重保险：

```html
<!-- meta refresh（0 秒跳转） -->
<meta http-equiv="refresh" content="0; url=https://newdomain.com/">
<!-- canonical（告诉搜索引擎） -->
<link rel="canonical" href="https://newdomain.com/">
<!-- JS location.replace（兜底） -->
<script>location.replace("https://newdomain.com/");</script>
```

搜索引擎能识别 meta refresh，用户端 0 秒跳转。

## 站长凭证统一放 head

```html
<meta name="baidu-site-verification" content="..." />
<meta name="google-site-verification" content="..." />
<meta name="sogou_site_verification" content="..." />
<meta name="google-adsense-account" content="ca-pub-XXXXXXXXXXXXXXXX" />
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-XXXXXXXXXXXXXXXX" crossorigin="anonymous"></script>
```

**每个新页面都必须加**，不要忘了。

## API 备忘（Cloudflare MCP 可执行）

```
# 手动触发部署
POST /accounts/{accountId}/pages/projects/{project}/deployments
body: { branch: "master" }

# 域名列表
GET /accounts/{accountId}/pages/projects/{project}/domains
```

## 已知限制

- 项目名 `xxx.pages.dev` 永久锁定，删了才能重建
- root_dir 必须相对路径，写 `/pages` 报错
- Pages Functions（Serverless）需要时才加
