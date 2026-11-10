# 下载按钮自动指向最新版

> 适用：静态站点提供安装包/压缩包下载，且版本会持续迭代（GitHub Releases、Gitee Releases、对象存储等）。

## 一、不要硬编码版本号

最原始的做法：

```html
<a href="/downloads/app-v1.2.3.zip">Download</a>
```

问题：

- 每次发版都要改所有语言、所有页面里的链接，必漏
- 旧版本文件被清理后直接 404
- 无法统计/切换镜像

## 二、推荐的按钮结构

HTML 只保留稳定语义，`href` 指向「最新版列表页」作为无 JS 回退：

```html
<a class="download-btn" data-dl="github"
   href="https://github.com/OWNER/REPO/releases/latest"
   rel="noopener">GitHub 下载</a>

<a class="download-btn" data-dl="gitee"
   href="https://gitee.com/OWNER/REPO/releases/latest"
   rel="noopener">Gitee 下载</a>
```

JS 启动后：

1. 请求最新 release
2. 从 `assets` 里挑目标文件
3. 把按钮 `href` 改成直链，并去掉 `target`（同一标签页下载，避免弹窗被拦）

## 三、跨域限制（关键）

| 平台 | 浏览器直连 API | 处理方式 |
|---|---|---|
| GitHub REST | ✅ 有 CORS | 直接 `fetch("/releases/latest")` |
| Gitee API | ❌ 无 CORS | **不要 fetch**，用 GitHub 返回的文件名拼直链 |

前提：**两个平台发布的文件名完全一致**。若不一致，只能在后端/Worker 做映射，不能在前端硬拼。

```javascript
var ghUrl = "https://github.com/" + GH_REPO + "/releases/download/" + info.tag + "/" + info.filename;
var giteeUrl = "https://gitee.com/" + GITEE_REPO + "/releases/download/" + info.tag + "/" + info.filename;
```

## 四、挑选最新资源

一个 release 可能挂多个文件（安装包、校验和、源码包），要按规则筛选：

```javascript
function pickLatestAsset(assets) {
    var candidates = [];
    for (var i = 0; i < assets.length; i++) {
        var name = assets[i].name;
        if (!/\.zip$/i.test(name)) continue;          // 只看 zip
        if (name.indexOf("GreenPortable") === -1) continue;  // 只看目标产物
        candidates.push(assets[i]);
    }
    if (candidates.length === 0) return null;
    // 文件名里带 8 位日期时，按日期倒序，避免依赖 assets 数组顺序
    candidates.sort(function (left, right) {
        return extractDate(right.name) - extractDate(left.name);
    });
    return candidates[0];
}
```

`/releases/latest` 只能拿到「最新 release」，但如果一个 release 里传了多个历史包，仍要靠文件名/日期再做一次挑选。

## 五、缓存

```javascript
var CACHE_KEY = "site-latest-release-v3";   // 带版本后缀，便于强制刷新
var CACHE_TTL_MS = 15 * 60 * 1000;          // 15 分钟
```

- TTL 太长：新版发布后用户仍下载旧包
- TTL 太短：频繁打 API，匿名 GitHub 只有 60 次/小时/IP
- 缓存内容：`{ tag, filename, size, publishedAt, fetchedAt }`
- 发版后想立刻生效：缓存 key 后缀 +1（比等 TTL 更可靠）

## 六、失败必须静默回退

任何环节失败都不能让按钮变死链：

```javascript
function fetchLatestRelease() {
    if (!document.querySelector("[data-dl]")) return;

    var cached = readReleaseCache();
    if (cached) {
        applyReleaseToButtons(cached);
        return;
    }

    fetch("https://api.github.com/repos/" + GH_REPO + "/releases/latest", {
        headers: { Accept: "application/vnd.github+json" }
    })
    .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
    })
    .then(function (data) {
        var asset = pickLatestAsset(data.assets || []);
        if (!asset) return;              // 没找到目标文件：保留 /releases/latest
        var info = {
            tag: data.tag_name,
            filename: asset.name,
            size: asset.size,
            publishedAt: data.published_at
        };
        writeReleaseCache(info);
        applyReleaseToButtons(info);
    })
    .catch(function () {
        /* 静默保留 HTML 里的 /releases/latest 回退地址 */
    });
}
```

## 七、安全底线

- **绝不在前端代码里写 PAT / Token**（静态站源码公开可见）
- 匿名 API 限流足够用；需要更高额度时，走自己的后端/Worker 代理并做缓存
- 用户提供下载地址时只接受白名单域名，防止开放重定向
- 文件名拼进 URL 前做 `encodeURIComponent`

## 八、验收清单

- [ ] 禁用 JavaScript：按钮仍指向 `/releases/latest`，可正常打开
- [ ] 正常网络：按钮指向具体 zip 直链，点击直接下载
- [ ] 断网/API 返回 403/404：按钮保持回退地址，不报错、不变 `#`
- [ ] 发布新版本后（缓存未过期）：15 分钟内按钮自动指向新包
- [ ] 发版后想立刻生效：缓存 key 后缀已 +1
- [ ] GitHub / Gitee 两个按钮都指向同一版本、同一文件名
- [ ] `node --check app.js` 通过

## 九、常见错误对照

| 现象 | 原因 | 修复 |
|---|---|---|
| 点击下载 404 | 硬编码了旧版本文件名 | 改为 API 动态获取 |
| Gitee 按钮一直不生效 | 尝试 fetch Gitee API，被 CORS 拦截 | 只 fetch GitHub，拼 Gitee 直链 |
| 新版发布后仍下旧包 | 缓存 TTL 过长 / key 未换 | 缩短 TTL + 换 key 后缀 |
| 按钮变成 `#` | 请求失败后把 href 置空 | 失败时保留 `releases/latest` |
| 下载的是源码包 | asset 筛选条件太宽 | 按扩展名 + 产物标识 + 日期筛选 |
| 匿名 API 403 | 同 IP 请求过多 | 加缓存，或后端代理 |
