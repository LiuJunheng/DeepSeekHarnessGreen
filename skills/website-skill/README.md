# website-skill — 通用静态网站开发与运维规范

本 Skill 沉淀自一个完整的多语言静态网站项目的实测经验。覆盖技术选型、代码规范、多语言架构、SEO 清单、Cloudflare Pages 部署、广告接入、Markdown 渲染安全、分页爬虫兼容等全链路。

## 适用场景

- **从零搭新站**：按目录结构 + 规范 + 清单一步步走
- **维护现有站**：改了页面/样式/脚本后，对照铁律和清单排查
- **SEO 排查**：收录掉了、爬虫看到空壳、百度不爬 → 找对应章节
- **Markdown 渲染**：发布说明、博客、文档页用 markdown → 必须看 HTML escape 大坑
- **分页/无限滚动**：加载更多 + 爬虫兼容

## 文档索引

```
website-skill/
├── SKILL.md                         ← 核心 + 索引（Agent 优先读）
├── README.md                        ← 你正在看的
├── checklists/
│   ├── release-checklist.md         ← 发版后 7 步必做清单
│   ├── seo-checklist.md             ← SEO 逐项核对（30+ 项）
│   └── new-page-checklist.md        ← 新建页面 25 项必做
├── references/
│   ├── cache-versioning.md          ← 缓存版本号铁律详解 + 事故记录
│   ├── multilingual-architecture.md ← 多语言架构全规范（hreflang / 路径 / 繁体转换）
│   ├── pagination-seo.md            ← 分页/无限滚动 SEO 安全（三层架构 + 代码示例）
│   ├── markdown-escape.md           ← Markdown 渲染 HTML escape 完整代码（JS + Python）
│   ├── deployment-cloudflare.md     ← Cloudflare Pages 部署方案（_headers / CNAME / 301 跳转）
│   ├── seo-standards.md             ← 完整 SEO 清单
│   ├── pitfalls.md                  ← 21 条高频踩坑经验完整版
│   ├── ad-standards.md              ← AdSense 接入规范
│   └── code-style.md                ← 代码规范
└── templates/
    └── _headers                     ← Cloudflare _headers 示例模板
```

## 最高优先级规范（直接抄在 SKILL.md 里的）

1. **缓存版本号铁律**：CSS/JS 改了 → 所有 HTML 同步升 `?v=X.Y`
2. **多语言 hreflang 铁律**：5 条互指，x-default 子页→/en/
3. **分页不清空容器**：不要 `innerHTML = ""`，爬虫保底
4. **Markdown 必须 htmlEscape**：所有输出先 escape 再渲染
5. **JS 相对路径铁律**：`./zh/` 不能 `/zh/`

## 15 条高频避坑（完整版在 references/pitfalls.md）

| # | 坑 | 解法 |
|---|---|---|
| 1 | innerHTML="" 清空容器 | 只删重复的 |
| 2 | JS 设置 User-Agent 被静默阻止 | 后端 Worker 发起 |
| 3 | PowerShell 写中文 HTML 乱码 | UTF-8 BOM 或用 Python |
| 4 | 批量替换域名漏改 | grep 全量验证 |
| 5 | hreflang 和 x-default 不一致 | 改一个同步改另一个 |
| 6 | 相对路径写成 /zh/ | 用 ./zh/ 和 ../zh/ |
| 7 | 缓存 key 不换只改 TTL | 换后缀 -v1 → -v2 |
| 8 | load-more 按钮没跟着最后一张 | 每次前 remove，追加后 appendChild |
| 9 | markdown `<title>` 泄漏成真实标签 | 所有渲染输出必须 htmlEscape |
| 10 | pages.dev 子域名被 Google 收录 | _headers 加 noindex |
| 11 | robots.txt 带 BOM | ASCII 重写 |
| 12 | sitemap 返回 application/xml | _headers 覆盖 text/xml |
| 13 | 版本号改了一半就 push | grep 全量验证 |
| 14 | Python 预渲染器忘了 escape | 用同一函数 |
| 15 | AdSense 广告位靠 JS 插入 | 广告位必须是静态 HTML |

## 怎么用

### 作为项目维护者

1. **新建网站**：按 references/multilingual-architecture.md 的目录结构建项目 → 对照 checklists/new-page-checklist.md 走
2. **改了页面**：改之前查 SKILL.md 的最高优先级规范 → 改完 grep 全量验证版本号 → push 后走 checklists/release-checklist.md
3. **SEO 出问题**：对照 checklists/seo-checklist.md 逐项排查
4. **想不起某个坑**：直接打开 references/pitfalls.md，大概率在里面

### 作为 Agent

SKILL.md 的 frontmatter description 说清楚了调用时机：
- 新建网站 → 按架构搭
- 改了 CSS/JS → 记得版本号同步
- 做 Markdown 渲染 → 记得 htmlEscape
- 改了分页/无限滚动 → 记得不清空容器

## 版本历史

- v=1.0（2026-09-15）：首次创建，沉淀自一个完整的多语言静态网站项目
