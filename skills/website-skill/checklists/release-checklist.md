# 发版后必做清单

每次 commit + push 之后，逐项核对。

## 代码提交阶段

- [ ] git add + commit（message 描述清楚改了什么）
- [ ] git push 到 master
- [ ] 确认所有 HTML 的 app.js?v / style.css?v 版本号一致（grep 验证）

## sitemap 更新

- [ ] sitemap.xml 所有 `<lastmod>` 统一填最新日期（YYYY-MM-DD）
- [ ] 如果加了新页面，新增 3 个 `<url>`（三语），每个带 4 个 xhtml:link 互指
- [ ] 如果删了页面，从 sitemap 移除对应条目
- [ ] 用浏览器直接打开 sitemap.xml 检查 XML 格式正确

## 本地验证（Ctrl+Shift+R 硬刷新）

- [ ] 首页正常加载，版本号显示正确
- [ ] changelog 页面首屏正常渲染，爬虫保底的静态卡片存在
- [ ] 加载更多按钮正常追加，按钮位置跟着最后一张卡片走
- [ ] 三个语言切换器正常跳转
- [ ] console 无 JS error

## 站长平台

- [ ] **百度站长平台**：手动提交 sitemap（无额度限制，推荐方式）
- [ ] **百度主动推送 API**（可选）：零点后有额度，满了返回 `error:400`
- [ ] **Google Search Console**：重新提交 sitemap
- [ ] **搜狗站长平台**：必要时手动提交

## 观察期

- [ ] 观察 2-3 天收录数变化
- [ ] Search Console 检查是否有抓取错误
- [ ] 百度站长平台索引量是否更新

## 百度主动推送脚本（临时，不进仓库）

```python
import urllib.request

SITE = "https://yourdomain.com"
TOKEN = "你的百度 token"
API = f"http://data.zz.baidu.com/urls?site={SITE}&token={TOKEN}"

URLS = [
    "https://yourdomain.com/",
    "https://yourdomain.com/zh/",
    "https://yourdomain.com/zh/about.html",
    "https://yourdomain.com/zh/privacy.html",
    # ... 三语各页面
]

body = "\n".join(URLS).encode("utf-8")
req = urllib.request.Request(API, data=body, method="POST",
    headers={"Content-Type": "text/plain", "User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req, timeout=30) as r:
    print(r.read().decode())
# 成功: {"success": N, "remain": M}
# 失败: {"error":400}  → over quota，明天零点重试
```
