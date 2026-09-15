# 多语言架构全规范

## 目录结构（目录式单语言）

```
pages/
├── index.html              ← 根入口（JS 语言检测 + 自动跳转）
├── robots.txt              ← 爬虫指引
├── sitemap.xml             ← 多语言站点地图
├── assets/                 ← 共享资源
│   ├── style.css
│   ├── app.js
│   └── changelog-seed.json
├── zh/                     ← 简体中文（hreflang="zh-Hans"）
│   ├── index.html
│   ├── about.html
│   ├── privacy.html
│   ├── compare.html
│   └── changelog.html
├── zh-Hant/                ← 繁体中文（hreflang="zh-Hant"）
│   └── ...（同上 5 个页面）
└── en/                     ← 英文（hreflang="en"）
    └── ...（同上 5 个页面）
```

## hreflang 互指铁律（改页必查）

**每个页面 `<head>` 必须 5 条，缺一不可**：

```html
<!-- 示例：zh/changelog.html -->
<link rel="canonical" href="https://yourdomain.com/zh/changelog.html">
<link rel="alternate" hreflang="zh-Hans" href="https://yourdomain.com/zh/changelog.html">
<link rel="alternate" hreflang="zh-Hant" href="https://yourdomain.com/zh-Hant/changelog.html">
<link rel="alternate" hreflang="en" href="https://yourdomain.com/en/changelog.html">
<link rel="alternate" hreflang="x-default" href="https://yourdomain.com/en/changelog.html">
```

### x-default 规则（关键！）

- **首页（index）** → 根 `/`（根入口做语言自动跳转）
- **子页面（about/privacy/compare/changelog）** → `/en/` 对应路径（英文是通用 fallback）

**禁止**：子页面 x-default 指向根 `/` 或其他语言版本（会分散权重）。

### hreflang 值 vs URL 路径独立

- hreflang 用精确标签：`zh-Hans` / `zh-Hant` / `en`
- URL 路径用短名：`zh/` / `zh-Hant/` / `en/`
- Google 接受这种分离，不要改

### lang 属性精确

- `zh-CN`（简体）
- `zh-Hant`（繁体）
- `en`（不用 `en-US`，覆盖更广）

## 路径相对路径铁律

| 页面位置 | CSS 引用 | JS 引用 |
|---------|---------|---------|
| 根入口 `index.html` | `./assets/style.css` | `./assets/app.js` |
| 子页 `zh/index.html` | `../assets/style.css` | `../assets/app.js` |

**绝对路径 `/zh/` 的危险**：
- `file://` 打开 → 跳到磁盘根目录
- 线上访问 → 跳到错误的子域（比如没有 `/zh` 前缀）

## 浏览器语言检测

```javascript
function detectBrowserLang() {
    var accept = (navigator.language || navigator.userLanguage || "").toLowerCase();
    if (accept.startsWith("zh-tw") || accept.startsWith("zh-hk") ||
        accept.startsWith("zh-mo") || accept.startsWith("zh-hant")) {
        return "zh-Hant";
    }
    if (accept.startsWith("zh")) {
        return "zh";
    }
    return "en";
}

// localStorage 优先（用户之前选过）
var saved = localStorage.getItem("dshe-lang-preference");
var target = saved || detectBrowserLang();
location.replace("./" + target + "/");
```

## 繁体转换

用 `opencc-python-reimplemented`：

```python
from opencc import OpenCC
cc = OpenCC('s2t')  # 简体 → 繁体

# 保护 HTML tag / CSS / JS / URL 不被转换
import re
def safe_convert(html):
    # 找到所有 HTML tag 和代码块，保护不转
    protected = {}
    def save(m):
        key = f"\u0000P{len(protected)}\u0000"
        protected[key] = m.group(0)
        return key
    # 保护 <...> HTML 标签
    text = re.sub(r'<[^>]+>', save, html)
    # 保护 ``` 代码块
    text = re.sub(r'```.*?```', save, text, flags=re.DOTALL)
    # 转换正文
    converted = cc.convert(text)
    # 恢复保护内容
    for k, v in protected.items():
        converted = converted.replace(k, v)
    return converted
```

## 新页面铁律（每次加新页面必做）

1. **三语各放一份**：`pages/zh/`、`pages/zh-Hant/`、`pages/en/`，文件名一致
2. **每个页面 `<head>`**：4 条 hreflang + 1 条 canonical + 1 条 x-default
3. **sitemap.xml**：新增 3 个 `<url>`，每个带 4 个 `xhtml:link` 互指
4. **站长验证标签**（百度 / AdSense / 搜狗）必须一并加上
5. **导航和 footer**：三语首页的导航 + footer 都要加新页面的入口

## 文案铁律

- **所有翻译文案禁止机翻**：机翻痕迹是 AdSense 审核以"低价值内容"拒绝的典型原因
- 标题与正文直白，不搞趣味包装
- FAQ 问题口语化，答案保留技术术语
- 用户明确偏好优先于规则建议（曾用三国军帐风格包装被完整回退）
