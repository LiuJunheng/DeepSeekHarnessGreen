# Markdown 渲染的 HTML escape 完整代码

## 问题描述

release notes、博客、文档页里的 markdown 可能包含行内 code：

```markdown
所有 17 个页面的 `title` / `meta name="description"` 都做了优化
```

如果直接转成 HTML 输出而不 escape，浏览器会把 `<title>` 和 `<meta>` 当成真实 HTML 标签来解析——导致：
1. DOM 错乱（后面内容被吞掉或渲染异常）
2. SEO 爬虫看到截断的页面，判定内容空

## 根因

`renderSimpleMarkdown` 里用正则处理完 **粗体** 和 [链接](url) 之后，对剩余文本没有做 HTML escape（`&` `<` `>` `"`）。行内 code 里的 `<title>` 就是这样泄漏出去的。

## 解决方案

### JS 版（运行时渲染）

```javascript
/* HTML escape 辅助函数：用 DOM API，自动处理 & < > " */
function htmlEscape(text) {
    var div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

/* 行内渲染：顺序绝对不能乱！
   1. 先把行内 code（`xxx`）摘出来占位，内部单独 escape
   2. 对剩余普通文本做 htmlEscape
   3. 恢复 code 占位符（内部已经 escape 过了）
   4. 处理 **粗体** → <strong>
   5. 处理 [text](url) → <a href="escape(url)">text</a> */
function renderInline(line) {
    // Step 1: 摘行内 code 占位
    var codePieces = [];
    line = line.replace(/`([^`]+)`/g, function (m, codeContent) {
        codePieces.push(htmlEscape(codeContent));
        return "\u0000CODE" + codePieces.length + "\u0000";
    });

    // Step 2: 对剩余文本 htmlEscape
    line = htmlEscape(line);

    // Step 3: 恢复 code 占位符
    for (var i = 0; i < codePieces.length; i++) {
        line = line.replace(
            "\u0000CODE" + (i + 1) + "\u0000",
            "<code>" + codePieces[i] + "</code>"
        );
    }

    // Step 4: **粗体**
    line = line.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

    // Step 5: [text](url)
    line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (m, text, url) {
        return '<a href="' + htmlEscape(url) + '" target="_blank" rel="noopener">' + text + "</a>";
    });

    return line;
}
```

### 完整 renderSimpleMarkdown

```javascript
function renderSimpleMarkdown(text) {
    if (!text) return "";
    var lines = text.split(/\r?\n/);
    var out = [];
    var inCodeBlock = false;
    var codeLines = [];
    var listOpen = false;

    function closeList() {
        if (listOpen) { out.push("</ul>"); listOpen = false; }
    }

    for (var i = 0; i < lines.length; i++) {
        var raw = lines[i];
        var stripped = raw.trim();

        // 代码块 ```  — 内部也必须 htmlEscape
        if (/^```/.test(stripped)) {
            if (inCodeBlock) {
                closeList();
                out.push("<pre><code>" + htmlEscape(codeLines.join("\n")) + "</code></pre>");
                codeLines = [];
                inCodeBlock = false;
            } else {
                inCodeBlock = true;
            }
            continue;
        }
        if (inCodeBlock) { codeLines.push(raw); continue; }

        // ## 二级标题
        var h2 = raw.match(/^##\s+(.+)$/);
        if (h2) { closeList(); out.push("<h3>" + renderInline(h2[1]) + "</h3>"); continue; }

        // ### 三级标题
        var h3 = raw.match(/^###\s+(.+)$/);
        if (h3) { closeList(); out.push("<h4>" + renderInline(h3[1]) + "</h4>"); continue; }

        // - 列表项
        var li = raw.match(/^\s*[-*]\s+(.+)$/);
        if (li) {
            if (!listOpen) { out.push("<ul>"); listOpen = true; }
            out.push("<li>" + renderInline(li[1]) + "</li>");
            continue;
        }

        // 空行：关闭列表
        if (stripped === "") { closeList(); continue; }

        // 普通段落
        closeList();
        out.push("<p>" + renderInline(raw) + "</p>");
    }

    closeList();
    if (inCodeBlock && codeLines.length > 0) {
        out.push("<pre><code>" + htmlEscape(codeLines.join("\n")) + "</code></pre>");
    }
    return out.join("\n");
}
```

### Python 版（预渲染 seed.json 用）

**必须与 JS 版逻辑完全一致**，否则会出现 JS 版本漏 escape 或 Python 版漏 escape 的单边故障：

```python
import re

def html_escape(text):
    return (text
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;"))

def render_inline(line):
    # Step 1: 摘行内 code 占位
    code_pieces = []
    def replace_code(m):
        code_pieces.append(html_escape(m.group(1)))
        return "\u0000CODE" + str(len(code_pieces)) + "\u0000"
    line = re.sub(r"`([^`]+)`", replace_code, line)

    # Step 2: htmlEscape
    line = html_escape(line)

    # Step 3: 恢复 code
    for i, piece in enumerate(code_pieces):
        line = line.replace("\u0000CODE" + str(i+1) + "\u0000",
                           "<code>" + piece + "</code>")

    # Step 4: **粗体**
    line = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", line)

    # Step 5: [text](url)
    line = re.sub(r"\[([^\]]+)\]\(([^)]+)\)",
                  lambda m: '<a href="' + html_escape(m.group(2)) +
                            '" target="_blank" rel="noopener">' +
                            m.group(1) + "</a>", line)
    return line

def render_simple_markdown(text):
    if not text: return ""
    lines = text.split("\n")
    out = []
    in_code = False
    code_lines = []
    list_open = False

    def close_list():
        nonlocal list_open
        if list_open:
            out.append("</ul>")
            list_open = False

    for raw in lines:
        stripped = raw.strip()
        if re.match(r"^```", stripped):
            if in_code:
                close_list()
                out.append("<pre><code>" + html_escape("\n".join(code_lines)) + "</code></pre>")
                code_lines = []
                in_code = False
            else:
                in_code = True
            continue
        if in_code:
            code_lines.append(raw)
            continue

        h2 = re.match(r"^##\s+(.+)$", raw)
        if h2:
            close_list()
            out.append("<h3>" + render_inline(h2.group(1)) + "</h3>")
            continue

        h3 = re.match(r"^###\s+(.+)$", raw)
        if h3:
            close_list()
            out.append("<h4>" + render_inline(h3.group(1)) + "</h4>")
            continue

        li = re.match(r"^\s*[-*]\s+(.+)$", raw)
        if li:
            if not list_open:
                out.append("<ul>")
                list_open = True
            out.append("<li>" + render_inline(li.group(1)) + "</li>")
            continue

        if stripped == "":
            close_list()
            continue

        close_list()
        out.append("<p>" + render_inline(raw) + "</p>")

    close_list()
    if in_code and code_lines:
        out.append("<pre><code>" + html_escape("\n".join(code_lines)) + "</code></pre>")

    return "\n".join(out)
```

## 执行顺序为什么不能乱

如果先处理 **粗体** 再 htmlEscape：`<strong>` 标签本身会被 escape 成 `&lt;strong&gt;`，**粗体功能就废了**。

如果先 htmlEscape 再处理行内 code：code 占位符里的 `<title>` 会被 escape 两次（第一次 escape 变成 `&lt;title&gt;`，恢复占位符时又被包了一层），输出会是 `<code>&amp;lt;title&amp;gt;</code>`——双重 escape，显示效果变了。

**只有先摘 code、escape 剩余文本、恢复 code、再处理粗体/链接 这一条路径是对的。**
