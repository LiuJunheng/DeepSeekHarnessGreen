# 缓存版本号铁律详解

## 为什么需要

浏览器会缓存静态资源（CSS / JS）。如果你改了 CSS 内容但没改引用 URL，浏览器会继续用旧缓存——用户看到的永远是"改了没生效"。

在 URL 后面加 `?v=X.Y` 参数**不是什么特殊功能**——它只是让浏览器把它当成一个全新的 URL，忽略旧缓存。

## 版本号管理规则

| 资源 | 版本号字段 | 什么时候升 |
|------|-----------|-----------|
| style.css | `?v=X.Y` | 任何 CSS 改动（哪怕只改了一个颜色值） |
| app.js | `?v=X.Y` | 任何 JS 改动（哪怕只改了一行逻辑） |

**CSS 和 JS 版本号独立管理**——改了 CSS 只升 CSS 版本，不要把 JS 版本绑一起升。

## 历史事故

> 2026-09-13 踩过的坑：index.html 和 zh-Hant/index.html 还在引用 `app.js?v=3.8`，但 changelog.html 已经是 `v=3.10` 内容。用户加载旧缓存，页面上 SEO 段落被截断，排查了 3 小时才定位是版本号没同步。

## 正确的版本号同步方式

### 方式 1：Python 脚本遍历全量 HTML（推荐）

```python
import os, re

def bump_version(filename_pattern, old_v, new_v):
    """把所有 HTML 里的 style.css?v=X.Y 或 app.js?v=X.Y 升版本"""
    for root, dirs, files in os.walk("pages"):
        for f in files:
            if not f.endswith(".html"):
                continue
            path = os.path.join(root, f)
            with open(path, encoding="utf-8") as fh:
                content = fh.read()
            if filename_pattern in content:
                # 替换 ?v=old_v → ?v=new_v
                new_content = content.replace(
                    f'{filename_pattern}?v={old_v}',
                    f'{filename_pattern}?v={new_v}'
                )
                if new_content != content:
                    with open(path, "w", encoding="utf-8") as fh:
                        fh.write(new_content)
                    print(f"updated: {path}")
```

调用：`bump_version('app.js', '3.8', '3.10')`

### 方式 2：PowerShell 一行（简单批量改版本号可以）

```powershell
Get-ChildItem pages -Filter "*.html" -Recurse | ForEach-Object {
    $c = [IO.File]::ReadAllText($_.FullName, [Text.Encoding]::UTF8)
    $c = $c -replace 'app\.js\?v=3\.8', 'app.js?v=3.10'
    [IO.File]::WriteAllText($_.FullName, $c, [Text.Encoding]::UTF8)
}
```

## push 前验证

```bash
# 确认所有 HTML 的版本号一致
grep -r "app.js?v=" pages/ --include="*.html" | sort | uniq
grep -r "style.css?v=" pages/ --include="*.html" | sort | uniq
```

如果输出了多个不同版本号，说明有遗漏，必须全部统一。

## 与 localStorage 缓存的区别

| 类型 | 机制 | 换版本方式 |
|------|------|-----------|
| **浏览器静态资源缓存** | 基于 URL | 改 `?v=X.Y` |
| **localStorage 应用数据缓存** | 基于 key + TTL | 换 key 后缀（`-v1 → -v2`）才会强制清，只改 TTL 不够 |

两者独立运作，互不影响。
