# 分页 / 无限滚动的 SEO 安全实现

## 为什么不能 `innerHTML = ""`

最开始的 changelog 实现：

```javascript
// ❌ 危险做法
function renderAll() {
  var container = document.getElementById("changelog-list");
  container.innerHTML = "";  // 这一行把 HTML 里的静态种子全删了
  renderChunk(0);           // 从第 0 条开始追加 10 条
  showLoadMoreButton();
}
```

问题：HTML 里已经硬编码了最新 3 张 release 卡片（爬虫保底用的），JS 一启动就把它们清空。如果爬虫（百度）在 JS 刚执行完清空操作后就停止了（网络慢、XHR 还没回来、3-5 秒超时），收录到的就是一个**空壳 changelog**。

## 三层数据源架构

```
┌─────────────────────────────────────────────────────┐
│  第一层：HTML 内嵌静态卡片（爬虫保底）                │
│  changelog.html 的容器里硬编码最新 3 张 section 卡片 │
│  JS 启动后不清空这个容器，只补全后面的版本             │
├─────────────────────────────────────────────────────┤
│  第二层：本地 seed.json（离线兜底）                   │
│  预生成的完整数据（如 38 条 release）                 │
│  任何 tag 都能在本地查到，不依赖网络                   │
├─────────────────────────────────────────────────────┤
│  第三层：GitHub REST API（实时补充）                   │
│  /repos/{owner}/{repo}/releases?per_page=30          │
│  与 seed.json 合并去重，按 published_at 降序           │
└─────────────────────────────────────────────────────┘
```

## renderAll（安全版）

```javascript
var CHUNK_SIZE = 10;
var visibleCount = 0;
var allFilteredReleases = [];
var existingTagsFromHTML = {};

function renderAll() {
    var container = document.getElementById("changelog-list");
    var loading = document.getElementById("changelog-loading");
    var errorBox = document.getElementById("changelog-error");
    if (!container) return;

    // ✅ 不清空容器！HTML 里的静态卡片永远保留
    if (loading) loading.hidden = true;
    if (errorBox) errorBox.hidden = true;

    if (!allFilteredReleases || allFilteredReleases.length === 0) {
        container.innerHTML = '<p class="changelog-empty">暂无发布记录。</p>';
        return;
    }

    // 1. 收集 HTML 内嵌卡片已有的 data-tag
    existingTagsFromHTML = {};
    var existingSections = container.querySelectorAll(".changelog-item");
    for (var k = 0; k < existingSections.length; k++) {
        var tag = existingSections[k].getAttribute("data-tag");
        if (tag) existingTagsFromHTML[tag] = true;
    }

    // 2. 计算可见起点（跳过 HTML 已有 tag）
    visibleCount = 0;
    while (visibleCount < allFilteredReleases.length &&
           existingTagsFromHTML[allFilteredReleases[visibleCount].tag_name]) {
        visibleCount++;
    }

    // 3. 追加 CHUNK_SIZE 条（跳过已有）
    renderChunk(visibleCount);

    // 4. 按钮
    showLoadMoreButton();
    if (visibleCount >= allFilteredReleases.length) {
        finishLoadMoreButton();
    }
}
```

## renderChunk（跳过已有 + 按钮位置铁律）

```javascript
function renderChunk(startIndex) {
    var container = document.getElementById("changelog-list");
    if (!container) return;
    var btn = document.getElementById("changelog-load-more");

    // 1. 先把按钮摘下来（关键！）
    if (btn) btn.remove();

    // 2. 从 startIndex 开始，跳过 HTML 已有 tag，凑够 CHUNK_SIZE 条
    var appended = 0;
    var i = startIndex;
    for (; i < allFilteredReleases.length && appended < CHUNK_SIZE; i++) {
        var tag = allFilteredReleases[i].tag_name;
        if (existingTagsFromHTML[tag]) continue;  // 跳过 HTML 已有
        container.appendChild(renderOneReleaseItem(allFilteredReleases[i]));
        appended++;
    }
    visibleCount = i;  // 下次从这个位置继续

    // 3. 再把按钮放到最后（永远跟着最后一张卡片走）
    if (btn) container.appendChild(btn);
}
```

## 验证场景（Python 模拟）

假设 HTML 内嵌 v1.0.38/37/36（3 条），allFilteredReleases 全量 38 条：

```python
html_tags = {"v1.0.38", "v1.0.37", "v1.0.36"}
all_releases = [f"v1.0.{38-i}" for i in range(39)]  # v1.0.38 到 v1.0.0

# renderAll 初始化
visible_count = 0
while visible_count < len(all_releases) and all_releases[visible_count] in html_tags:
    visible_count += 1
# → visible_count = 3（跳过了 v1.0.38/37/36）

# renderChunk(3) — 追加 10 条（跳过已有）
appended = 0
i = 3
chunk = []
while i < len(all_releases) and appended < 10:
    if all_releases[i] in html_tags:
        i += 1; continue
    chunk.append(all_releases[i]); appended += 1; i += 1
# → chunk = ["v1.0.35", "v1.0.34", ..., "v1.0.26"]（10 条）
# → visible_count = 13

# DOM 最终:
# HTML 3 条（v1.0.38/37/36）+ 动态 10 条（v1.0.35→v1.0.26）= 13 条
# 零重复 ✅
```

## 两种实现方式的对比

| 对比项 | 清空容器 | 不清空容器（推荐） |
|--------|---------|------------------|
| HTML 内嵌卡片 | JS 启动后消失 | 永远保留 |
| 爬虫（百度 3-5s 超时） | 可能看到空壳 | 至少看到 3 条 |
| JS 正常跑完 | 10 条动态 + 按钮 | 3 条静态 + 动态补全 |
| 重复卡片 | 不会（因为全清了） | 靠 existingTagsFromHTML 跳过 |
| 复杂度 | 低 | 稍高（多了 existingTagsFromHTML） |

**复杂度换来了爬虫安全，这是值得的。**
