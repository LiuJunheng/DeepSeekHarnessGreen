# 内容列表页：静态种子 + 增量 API + 分页

> 适用：更新日志（changelog）、博客列表、新闻列表、版本下载列表等「条目会持续新增」的静态页面。

这类页面有一个天然矛盾：

- 爬虫（百度、搜狗、AdSense）不跑或只跑一小会 JS → 页面源码里必须有内容
- 内容会持续新增 → 不可能每次发版都手改 HTML
- 用户希望立刻看到最新条目 → 不能只依赖长 TTL 的本地缓存

下面这套「三层数据源 + 混合渲染」是实测可用的解法。

## 一、三层数据源

| 层 | 数据来源 | 作用 | 更新方式 |
|---|---|---|---|
| 第一层 | HTML 内嵌卡片（最新 3–5 条） | 爬虫保底、JS 失败也有内容 | 发版时手工/AI 同步 |
| 第二层 | `assets/*-seed.json`（全量历史） | 离线兜底、不依赖第三方 API | 发版时同步 |
| 第三层 | 第三方 API（GitHub Releases 等） | 补充 seed 之后的新条目 | 运行时静默请求 |

三层的字段结构必须一致（`tag_name` / `name` / `published_at` / `body` 等），否则合并时要做大量兼容。

## 二、静态卡片必须打标记

HTML 内嵌的每张卡片加两个属性：

```html
<section class="changelog-item" data-tag="v1.0.46" data-embedded="true">
  ...
</section>
```

- `data-tag`：唯一键，用于去重
- `data-embedded="true"`：告诉 JS「这是给爬虫的静态卡片，不要删」

## 三、renderAll 的正确顺序

```javascript
function renderAll() {
    var container = document.getElementById("changelog-list");
    if (!container) return;

    // 1. 只删除动态卡片，保留静态卡片（绝不 innerHTML = ""）
    var dynamicItems = container.querySelectorAll(".changelog-item:not([data-embedded])");
    for (var i = 0; i < dynamicItems.length; i++) {
        dynamicItems[i].remove();
    }

    // 2. 收集静态卡片已有的 tag，并记录第一张静态卡片作为插入锚点
    var embeddedItems = container.querySelectorAll(".changelog-item[data-embedded]");
    var firstEmbedded = embeddedItems.length > 0 ? embeddedItems[0] : null;
    var existingTags = {};
    for (var j = 0; j < embeddedItems.length; j++) {
        existingTags[embeddedItems[j].getAttribute("data-tag")] = true;
    }

    // 3. 比静态卡片更新的条目：insertBefore 到最前面
    //    （缓存命中后后台拉到新版本时，靠这一步把新版排到最前）
    visibleCount = 0;
    while (visibleCount < allItems.length) {
        var tagNow = allItems[visibleCount].tag_name;
        if (existingTags[tagNow]) break;   // 遇到静态卡片已有的，停止插入
        container.insertBefore(renderOneItem(allItems[visibleCount]), firstEmbedded);
        visibleCount++;
    }

    // 4. 从当前位置往后追加一屏（跳过静态卡片已有的 tag）
    renderChunk(visibleCount);

    // 5. load-more 按钮永远保持在容器最后
    container.appendChild(loadMoreButton);
}
```

**为什么不能只 append**：列表按时间降序展示，新条目应该在最前面。只 append 会把「比静态卡片还新」的条目排到所有卡片之后，用户看到的第一条仍是旧版本。

## 四、缓存策略

```javascript
var CACHE_KEY = "dshe-releases-v3";          // key 带版本号
var CACHE_TTL_MS = 15 * 60 * 1000;           // 15 分钟
```

- **换 key 才能强制清旧缓存**：只改 TTL，用户本地旧 key 的数据仍在有效期内，不会重新请求
- **TTL 不要设太长**：曾经用 1h/2h，发新版后用户迟迟看不到；改成 15 分钟
- 缓存内容要带 `fetchedAt`，读取时判断是否过期
- 写缓存失败（隐私模式/配额满）要静默忽略，不影响页面渲染

## 五、缓存命中后的后台刷新

```javascript
var cached = readCache();
if (cached && cached.length > 0) {
    allItems = cached;
    renderAll();

    // 后台静默请求，有新内容就重渲染
    fetchRemote(function (remoteList) {
        if (!remoteList || remoteList.length === 0) return;
        var merged = filterPublished(mergeByUniqueKey(cached, remoteList));
        var lengthChanged = merged.length !== allItems.length;
        var firstChanged = merged.length > 0 && allItems.length > 0 &&
                           merged[0].tag_name !== allItems[0].tag_name;
        if (lengthChanged || firstChanged) {
            writeCache(merged);
            allItems = merged;
            renderAll();     // 关键：必须重渲染
        }
    });
    return;
}
```

**典型 bug**：后台发现新版本后只更新了 localStorage，没有更新内存数组和 DOM → 用户刷新多少次都是旧的（直到缓存过期）。

## 六、多来源合并

```javascript
function mergeByUniqueKey(seedList, remoteList) {
    var seen = {};
    var out = [];
    var i;
    for (i = 0; i < seedList.length; i++) {
        var key = seedList[i].tag_name || seedList[i].name;
        if (key && !seen[key]) {
            seen[key] = true;
            out.push(seedList[i]);
        }
    }
    for (i = 0; i < remoteList.length; i++) {
        var remoteKey = remoteList[i].tag_name || remoteList[i].name;
        if (remoteKey && !seen[remoteKey]) {
            seen[remoteKey] = true;
            out.push(remoteList[i]);
        }
    }
    // 关键：统一按发布时间降序，不要依赖来源顺序
    out.sort(function (left, right) {
        var leftTime = left.published_at ? new Date(left.published_at).getTime() : 0;
        var rightTime = right.published_at ? new Date(right.published_at).getTime() : 0;
        return rightTime - leftTime;
    });
    return out;
}
```

过滤规则：`draft === true` 与 `prerelease === true` 一律不展示。

## 七、分页（加载更多）

```javascript
var CHUNK_SIZE = 10;
var visibleCount = 0;
```

- 每次点击「加载更多」追加上限 `CHUNK_SIZE` 条
- 追加前先 `button.remove()`，追加完再 `container.appendChild(button)`
- 全部加载完后按钮置 `disabled` 并显示「没有更多」
- 分页只影响 DOM，不改变 `allItems` 全量数组；筛选/排序后从索引 0 重新渲染

## 八、发版时的同步清单

- [ ] `assets/*-seed.json` 追加新条目（字段与远端一致）
- [ ] 三个语言（或所有语言）的 HTML 内嵌卡片更新为最新 N 条
- [ ] 每张静态卡片都有 `data-tag` + `data-embedded="true"`
- [ ] 静态卡片数量在各语言页面一致
- [ ] 如果改了 JS：所有 HTML 的 `app.js?v=` 同步升版本
- [ ] 如果想让用户立刻看到新内容：缓存 key 后缀 +1（如 `-v3` → `-v4`）
- [ ] `node --check app.js` 通过
- [ ] JSON 解析通过、无 BOM、纯 LF

## 九、验收方法

1. **断网/禁用网络**：首屏仍应显示 HTML 内嵌卡片（爬虫保底生效）
2. **清空 localStorage 后刷新**：seed + API 合并，首屏 10 条
3. **有缓存时发布新版本**：刷新后应自动出现新版本（验证后台重渲染）
4. **连续点加载更多**：按钮始终在最后，不重复条目
5. **查看页面源码**：`grep -c "data-embedded" *.html` 各语言数量一致
6. **HTML 标签配对**：静态卡片结构完整（缺 `</section>` 会导致后续动态卡片被吞）

## 十、常见错误对照

| 现象 | 原因 | 修复 |
|---|---|---|
| 新版发布后刷新看不到 | 缓存命中只写了 localStorage，没重渲染 | 长度/首项变化时 `renderAll()` |
| 新版出现在列表最后 | 只 append，没有 insertBefore | 新条目插到第一张静态卡片之前 |
| 静态卡片每次刷新都重复 | 收集 tag 时只扫了动态卡片 | 只收集 `[data-embedded]` 的 `data-tag` |
| 爬虫看到空列表 | 启动时 `innerHTML = ""` | 只删 `:not([data-embedded])` |
| 本地仍是旧版本 | 只改 TTL 没换缓存 key | key 后缀 +1 |
| 条目顺序忽上忽下 | 按来源顺序拼接 | 合并后按 `published_at` 重排 |
