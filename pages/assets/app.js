/* =========================================================
   DeepSeek Harness 绿色版发布页 · 轻量交互（无外部依赖）
   吸顶导航高亮 + 滚动淡入 + 粒子网络 + 水波纹动效
   ========================================================= */
(function () {
  "use strict";

  // 取父级文档中的元素（首行即用封装，避免全局污染）
  function queryAll(selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
  }

  /* 0. 自动检测最新 zip — 改下载按钮直链
     GitHub API 有 CORS 可直接调; Gitee 无 CORS, 但 zip 文件名两端一致,
     拿到 GitHub 文件名后拼 Gitee 直链. localStorage 缓存 1h.
     (v2: TTL 24h→1h, 避免新版本发布后缓存滞后仍然下载旧版) */
  var GH_REPO = "LiuJunheng/DeepSeekHarnessGreen";
  var GITEE_REPO = "liujunheng/DeepSeekHarnessGreen";
  var CACHE_KEY = "dshe-latest-release-v2";
  var CACHE_TTL_MS = 1 * 60 * 60 * 1000; // 1 小时

  function readReleaseCache() {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (Date.now() - data.fetchedAt < CACHE_TTL_MS) return data;
    } catch (e) { /* no-op */ }
    return null;
  }

  function writeReleaseCache(data) {
    try {
      data.fetchedAt = Date.now();
      localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    } catch (e) { /* no-op */ }
  }

  // 从文件名里提取 8 位日期用于排序 (格式: ..._20260905_v1.0.29.zip)
  function extractDateFromName(filename) {
    var m = filename.match(/_(\d{8})_v/);
    if (m) return parseInt(m[1], 10);
    return 0;
  }

  // 过滤 assets 里 GreenPortable zip, 按日期选最新
  function pickLatestZipAsset(assets) {
    var zips = [];
    for (var i = 0; i < assets.length; i++) {
      var name = assets[i].name;
      if (/\.zip$/i.test(name) && name.indexOf("GreenPortable") !== -1) {
        zips.push(assets[i]);
      }
    }
    if (zips.length === 0) return null;
    zips.sort(function (a, b) {
      return extractDateFromName(b.name) - extractDateFromName(a.name);
    });
    return zips[0];
  }

  // 主函数: fetch GitHub API → 拼双平台直链 → 改按钮 href
  function fetchLatestRelease() {
    // 只在有 download-right 区块的首页运行
    if (!document.querySelector(".download-right")) return;

    // 先用缓存
    var cached = readReleaseCache();
    if (cached) {
      applyReleaseToButtons(cached);
      return;
    }

    // fetch GitHub latest release API (有 CORS Access-Control-Allow-Origin: *)
    var url = "https://api.github.com/repos/" + GH_REPO + "/releases/latest";
    fetch(url, { headers: { Accept: "application/vnd.github+json" } })
      .then(function (resp) {
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        return resp.json();
      })
      .then(function (data) {
        var zip = pickLatestZipAsset(data.assets || []);
        if (!zip) return; // 没找到 zip 就保持原 releases/latest 跳转
        var result = {
          tag: data.tag_name,
          filename: zip.name,
          size: zip.size,
          publishedAt: data.published_at
        };
        writeReleaseCache(result);
        applyReleaseToButtons(result);
      })
      .catch(function () { /* 静默保留原 releases/latest 跳转 */ });
  }

  // 把 release 信息应用到按钮 href
  function applyReleaseToButtons(info) {
    var ghUrl = "https://github.com/" + GH_REPO + "/releases/download/" + info.tag + "/" + info.filename;
    var giteeUrl = "https://gitee.com/" + GITEE_REPO + "/releases/download/" + info.tag + "/" + info.filename;

    var ghBtns = document.querySelectorAll('[data-dl="github"]');
    for (var i = 0; i < ghBtns.length; i++) {
      ghBtns[i].href = ghUrl;
      ghBtns[i].removeAttribute("target");
    }
    var giteeBtns = document.querySelectorAll('[data-dl="gitee"]');
    for (var j = 0; j < giteeBtns.length; j++) {
      giteeBtns[j].href = giteeUrl;
      giteeBtns[j].removeAttribute("target");
    }
  }

  // DOM ready 后启动
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fetchLatestRelease);
  } else {
    fetchLatestRelease();
  }

  /* 1. 吸顶导航：滚动时高亮当前所在区块对应的链接 */
  var navLinks = queryAll(".nav-links a");
  var sections = navLinks
    .map(function (link) {
      var target = link.getAttribute("href");
      if (!target || target.charAt(0) !== "#") return null;
      return document.querySelector(target);
    })
    .filter(Boolean);

  function onScrollNav() {
    var scrollPos = window.scrollY + 90;
    var currentId = null;
    var found = false;

    // 从后往前找当前越过的最后一个区块
    for (var i = sections.length - 1; i >= 0; i--) {
      if (sections[i].getBoundingClientRect().top + window.scrollY <= scrollPos) {
        currentId = sections[i].id;
        found = true;
        break;
      }
    }
    // 未越过任何区块（最顶部）时高亮 Hero
    if (!found) currentId = "top";

    navLinks.forEach(function (link) {
      var isActive = link.getAttribute("href") === "#" + currentId;
      if (isActive) {
        link.classList.add("active");
      } else {
        link.classList.remove("active");
      }
    });
  }

  /* 2. 滚动淡入：给可见元素加上 visible 类 */
  var revealTargets = queryAll(".section > .section-title, .section > .section-sub, .card, .plugin-card");
  revealTargets.forEach(function (el) {
    el.classList.add("reveal");
  });

  if ("IntersectionObserver" in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          // 已显示就不再观察，避免多余计算
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    revealTargets.forEach(function (el) {
      observer.observe(el);
    });
  } else {
    // 不支持 IntersectionObserver 时直接全部显示
    revealTargets.forEach(function (el) {
      el.classList.add("visible");
    });
  }

  // 监听滚动/加载，导航高亮
  window.addEventListener("scroll", onScrollNav, { passive: true });
  window.addEventListener("load", onScrollNav);
  onScrollNav();

  /* 3. 通用版本号：从 GitHub 最新 Release 动态获取，失败则保留 HTML 里的通用提示
       （发版无需再改页面里的具体版本号 / 日期） */
  var homepageRepo = "LiuJunheng/DeepSeekHarnessGreen";
  var versionElementIds = ["hero-version", "dl-version", "footer-version"];
  var versionTargets = versionElementIds
    .map(function (id) { return document.getElementById(id); })
    .filter(Boolean);

  function applyVersion(tagName) {
    versionTargets.forEach(function (element) {
      element.textContent = tagName;
    });
  }

  function fetchLatestVersion() {
    var request = new XMLHttpRequest();
    request.open(
      "GET",
      "https://api.github.com/repos/" + homepageRepo + "/releases/latest"
    );
    request.setRequestHeader("Accept", "application/vnd.github+json");
    request.onload = function () {
      if (request.status !== 200) {
        return; // 非预期响应，保留通用提示
      }
      try {
        var payload = JSON.parse(request.responseText);
        if (payload && payload.tag_name) {
          applyVersion(payload.tag_name);
        }
      } catch (error) {
        // 解析失败时保留通用提示
      }
    };
    request.onerror = function () {
      // 网络失败时保留通用提示
    };
    request.send();
  }

  fetchLatestVersion();
  /* 3.5 Changelog 页面：静态种子优先 + GitHub API 补充 + 加载更多分页
       - pages/assets/changelog-seed.json: 全量历史 release（离线保底 + 爬虫可见）
       - GitHub API: 补充种子发布后才出的新 release
       - 去重按 tag_name；首屏 10 条，"加载更多"每次追加 10 条 */
  var CHUNK_SIZE = 10;                          // 每屏显示条数
  var visibleCount = 0;                         // 当前已渲染条数
  var allFilteredReleases = [];                 // 过滤后的全部 release（剔除 draft/prerelease）
  var releasesLoaded = false;                   // 是否已把全量数据拿到（seed + GitHub 合并完）
  var RELEASES_CACHE_KEY = "dshe-releases-v2";  // 换 key 清掉旧缓存
  var RELEASES_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

  function fetchReleasesFromCache() {
    try {
      var raw = localStorage.getItem(RELEASES_CACHE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (Date.now() - data.fetchedAt < RELEASES_CACHE_TTL_MS) return data.releases;
    } catch (e) { /* no-op */ }
    return null;
  }

  function writeReleasesCache(releases) {
    try {
      localStorage.setItem(RELEASES_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), releases: releases }));
    } catch (e) { /* no-op */ }
  }

  /* 合并多份 release 数组，按 tag_name 去重，保留先出现的（seed 优先）*/
  function mergeReleases(seedList, githubList) {
    var seen = {};
    var out = [];
    var i;
    for (i = 0; i < seedList.length; i++) {
      var s = seedList[i];
      var key = s.tag_name || s.name;
      if (key && !seen[key]) {
        seen[key] = true;
        out.push(s);
      }
    }
    for (i = 0; i < githubList.length; i++) {
      var g = githubList[i];
      var key2 = g.tag_name || g.name;
      if (key2 && !seen[key2]) {
        seen[key2] = true;
        out.push(g);
      }
    }
    return out;
  }

  /* 统一过滤掉 draft / prerelease */
  function filterReleases(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      if (!list[i].draft && !list[i].prerelease) out.push(list[i]);
    }
    return out;
  }

  /* 极简 markdown → HTML 渲染器，只处理 release body 常见格式：
     ## 标题 / ### 小标题 / - 列表项 / ` 代码块 / **粗体** / code / [链接](url)
     不追求通用，只够我们自己的 release notes 用 */
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
    function renderInline(line) {
      // **粗体**
      line = line.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      // code
      line = line.replace(/([^]+)/g, "$1");
      // [text](url)
      line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      return line;
    }

    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      var stripped = raw.trim();

      // 代码块 `
      if (/^`/.test(stripped)) {
        if (inCodeBlock) {
          closeList();
          out.push("<pre><code>" + codeLines.join("\n") + "</code></pre>");
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
      out.push("<pre><code>" + codeLines.join("\n") + "</code></pre>");
    }
    return out.join("\n");
  }

  function formatReleaseDate(isoString) {
    if (!isoString) return "";
    var d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    var y = d.getFullYear();
    var mo = ("0" + (d.getMonth() + 1)).slice(-2);
    var da = ("0" + d.getDate()).slice(-2);
    return y + "-" + mo + "-" + da;
  }

  /* 渲染单个 release 为 <section class="changelog-item"> DOM 节点 */
  function renderOneReleaseItem(r) {
    var item = document.createElement("section");
    item.className = "changelog-item";
    // header: version tag + date + GitHub link
    var header = document.createElement("header");
    header.className = "changelog-header";
    header.innerHTML =
      '<a href="' + r.html_url + '" target="_blank" rel="noopener" class="changelog-tag">' +
      (r.tag_name || r.name || "") + '</a>' +
      '<span class="changelog-date">' + formatReleaseDate(r.published_at) + '</span>';
    item.appendChild(header);

    // body: rendered markdown
    var body = document.createElement("div");
    body.className = "changelog-body";
    body.innerHTML = renderSimpleMarkdown(r.body || "");
    item.appendChild(body);

    // quick download link (if has assets)
    if (r.assets && r.assets.length > 0) {
      var zipAsset = null;
      for (var j = 0; j < r.assets.length; j++) {
        if (/\.zip$/i.test(r.assets[j].name) && r.assets[j].name.indexOf("GreenPortable") !== -1) {
          zipAsset = r.assets[j]; break;
        }
      }
      if (zipAsset) {
        var dl = document.createElement("div");
        dl.className = "changelog-download";
        dl.innerHTML = '<a href="' + zipAsset.browser_download_url + '" target="_blank" rel="noopener" class="btn btn-primary">' +
          (zipAsset.name || "下载") + '</a>';
        item.appendChild(dl);
      }
    }
    return item;
  }

  /* 渲染从 startIndex 开始的一段 release，追加到容器末尾 */
  function renderChunk(startIndex) {
    var container = document.getElementById("changelog-list");
    if (!container) return;
    var end = Math.min(startIndex + CHUNK_SIZE, allFilteredReleases.length);
    for (var i = startIndex; i < end; i++) {
      container.appendChild(renderOneReleaseItem(allFilteredReleases[i]));
    }
    visibleCount = end;
  }

  /* 管理"加载更多"按钮 */
  function showLoadMoreButton() {
    var container = document.getElementById("changelog-list");
    if (!container) return;
    // 避免重复添加
    if (document.getElementById("changelog-load-more")) return;
    var btn = document.createElement("button");
    btn.id = "changelog-load-more";
    btn.className = "changelog-load-more";
    btn.textContent = "加载更多 ↓";
    btn.onclick = function () {
      renderChunk(visibleCount);
      if (visibleCount >= allFilteredReleases.length) hideLoadMoreButton();
    };
    container.appendChild(btn);
  }
  function hideLoadMoreButton() {
    var btn = document.getElementById("changelog-load-more");
    if (btn) btn.remove();
  }

  /* 全量渲染入口：清空容器 + 首次 10 条 + 显示加载更多 */
  function renderAll() {
    var container = document.getElementById("changelog-list");
    var loading = document.getElementById("changelog-loading");
    var errorBox = document.getElementById("changelog-error");
    if (!container) return;
    container.innerHTML = "";  // 清掉 HTML 里的静态种子
    if (loading) loading.hidden = true;
    if (errorBox) errorBox.hidden = true;

    if (!allFilteredReleases || allFilteredReleases.length === 0) {
      container.innerHTML = '<p class="changelog-empty">暂无发布记录。</p>';
      return;
    }

    visibleCount = 0;
    renderChunk(0);  // 首屏 10 条
    if (visibleCount < allFilteredReleases.length) {
      showLoadMoreButton();
    } else {
      hideLoadMoreButton();  // 全部一次就能看完（≤10 条时）
    }
  }

  /* 种子 JSON 加载 */
  function fetchSeedJSON(onDone) {
    var req = new XMLHttpRequest();
    req.open("GET", "./assets/changelog-seed.json", true);
    req.onload = function () {
      if (req.status === 200) {
        try {
          var parsed = JSON.parse(req.responseText);
          // 兼容两种格式：{ meta, releases: [...] } 或直接数组
          var seedList = Array.isArray(parsed) ? parsed : (parsed.releases || []);
          onDone(seedList);
        } catch (e) { onDone([]); }
      } else {
        onDone([]);
      }
    };
    req.onerror = function () { onDone([]); };
    req.send();
  }

  /* GitHub API 加载补充 */
  function fetchGitHubReleases(onDone) {
    var req = new XMLHttpRequest();
    req.open("GET", "https://api.github.com/repos/" + GH_REPO + "/releases?per_page=30", true);
    req.setRequestHeader("Accept", "application/vnd.github+json");
    req.onload = function () {
      if (req.status === 200) {
        try {
          onDone(JSON.parse(req.responseText));
        } catch (e) { onDone([]); }
      } else {
        onDone([]);
      }
    };
    req.onerror = function () { onDone([]); };
    req.send();
  }

  function fetchAndRenderChangelog() {
    if (!document.getElementById("changelog-list")) return;

    var loading = document.getElementById("changelog-loading");
    var errorBox = document.getElementById("changelog-error");
    if (loading) loading.hidden = false;

    // 1. 先看缓存
    var cached = fetchReleasesFromCache();
    if (cached && cached.length > 0) {
      allFilteredReleases = cached;
      releasesLoaded = true;
      renderAll();
      // 后台静默 fetch 一次 GitHub，更新缓存（如果发了新版本）
      fetchGitHubReleases(function (githubList) {
        if (!githubList || githubList.length === 0) return;
        var merged = mergeReleases(cached, githubList);
        merged = filterReleases(merged);
        if (merged.length !== allFilteredReleases.length) {
          // GitHub 返回了更多（有新发布），刷新缓存但不强制重新渲染
          writeReleasesCache(merged);
        }
      });
      return;
    }

    // 2. 缓存没有：种子 JSON + GitHub API 并发
    var seedList = null;
    var githubList = null;
    var done = function () {
      if (seedList === null || githubList === null) return;  // 还没都回来
      // 合并 + 过滤
      var merged = mergeReleases(seedList || [], githubList || []);
      merged = filterReleases(merged);
      allFilteredReleases = merged;
      releasesLoaded = true;
      writeReleasesCache(merged);
      renderAll();
    };

    fetchSeedJSON(function (data) { seedList = data; done(); });
    fetchGitHubReleases(function (data) { githubList = data; done(); });
  }

  fetchAndRenderChangelog();


  /* 4. 粒子网络动效：漂浮的光点 + 邻近连线（Canvas 2D，纯本地渲染）
       遵循系统"减少动态"偏好，无 Canvas / 被禁用时静默跳过，不阻塞页面 */
  var particlesCanvas = document.getElementById("particles-canvas");
  var particlesContext = particlesCanvas ? particlesCanvas.getContext("2d") : null;
  var prefersReducedMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (particlesContext && !prefersReducedMotion) {
    startParticlesNetwork(particlesCanvas, particlesContext);
  }

  function startParticlesNetwork(canvas, context) {
    var devicePixelRatio = window.devicePixelRatio || 1;
    var canvasWidth = 0;
    var canvasHeight = 0;
    var particles = [];
    var maxParticles = 55;
    var connectDistance = 130;   // 粒子间连线距离阈值
    var pointerX = -9999;
    var pointerY = -9999;
    var pointerConnectDistance = 160;

    // 粒子对象：{ x, y, vx, vy, radius, alpha }
    function createParticle() {
      return {
        x: Math.random() * canvasWidth,
        y: Math.random() * canvasHeight,
        vx: (Math.random() - 0.5) * 0.4,
        vy: (Math.random() - 0.5) * 0.4,
        radius: 1 + Math.random() * 2,
        alpha: 0.3 + Math.random() * 0.5
      };
    }

    function resizeCanvas() {
      canvasWidth = window.innerWidth;
      canvasHeight = window.innerHeight;
      canvas.width = Math.floor(canvasWidth * devicePixelRatio);
      canvas.height = Math.floor(canvasHeight * devicePixelRatio);
      canvas.style.width = canvasWidth + "px";
      canvas.style.height = canvasHeight + "px";
      context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

      // 根据屏幕大小调整粒子数量
      var targetCount = Math.min(maxParticles, Math.floor((canvasWidth * canvasHeight) / 18000));
      if (particles.length < targetCount) {
        while (particles.length < targetCount) {
          particles.push(createParticle());
        }
      } else if (particles.length > targetCount) {
        particles.length = targetCount;
      }
    }

    function updateParticles() {
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.x += p.vx;
        p.y += p.vy;

        // 边界反弹
        if (p.x < 0 || p.x > canvasWidth) p.vx *= -1;
        if (p.y < 0 || p.y > canvasHeight) p.vy *= -1;

        // 指针轻微吸引（增加互动感）
        if (pointerX >= 0 && pointerY >= 0) {
          var dx = pointerX - p.x;
          var dy = pointerY - p.y;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < pointerConnectDistance && dist > 0) {
            var force = (pointerConnectDistance - dist) / pointerConnectDistance * 0.02;
            p.vx += (dx / dist) * force;
            p.vy += (dy / dist) * force;
            // 限制速度
            var speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
            if (speed > 1.2) {
              p.vx = (p.vx / speed) * 1.2;
              p.vy = (p.vy / speed) * 1.2;
            }
          }
        }

        // 速度缓慢回归到基础值（避免被指针加速后停不下来）
        p.vx *= 0.995;
        p.vy *= 0.995;
      }
    }

    function drawParticles() {
      // 绘制粒子
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        context.beginPath();
        context.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        context.fillStyle = "rgba(130, 170, 215, " + p.alpha + ")";
        context.fill();
        // 外发光
        context.beginPath();
        context.arc(p.x, p.y, p.radius + 3, 0, Math.PI * 2);
        context.fillStyle = "rgba(104, 148, 214, " + (p.alpha * 0.2) + ")";
        context.fill();
      }

      // 绘制连线
      context.lineWidth = 1;
      for (var i = 0; i < particles.length; i++) {
        for (var j = i + 1; j < particles.length; j++) {
          var p1 = particles[i];
          var p2 = particles[j];
          var dx = p1.x - p2.x;
          var dy = p1.y - p2.y;
          var dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < connectDistance) {
            var alpha = (1 - dist / connectDistance) * 0.25;
            context.strokeStyle = "rgba(110, 150, 205, " + alpha + ")";
            context.beginPath();
            context.moveTo(p1.x, p1.y);
            context.lineTo(p2.x, p2.y);
            context.stroke();
          }
        }

        // 指针与邻近粒子连线
        if (pointerX >= 0 && pointerY >= 0) {
          var pdx = particles[i].x - pointerX;
          var pdy = particles[i].y - pointerY;
          var pdist = Math.sqrt(pdx * pdx + pdy * pdy);
          if (pdist < pointerConnectDistance) {
            var palpha = (1 - pdist / pointerConnectDistance) * 0.5;
            context.strokeStyle = "rgba(104, 148, 214, " + palpha + ")";
            context.lineWidth = 1;
            context.beginPath();
            context.moveTo(particles[i].x, particles[i].y);
            context.lineTo(pointerX, pointerY);
            context.stroke();
          }
        }
      }
    }

    function animate() {
      context.clearRect(0, 0, canvasWidth, canvasHeight);
      updateParticles();
      drawParticles();
      requestAnimationFrame(animate);
    }

    function onPointerMove(event) {
      pointerX = event.clientX;
      pointerY = event.clientY;
    }

    function onPointerLeave() {
      pointerX = -9999;
      pointerY = -9999;
    }

    window.addEventListener("resize", resizeCanvas, { passive: true });
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerleave", onPointerLeave, { passive: true });
    resizeCanvas();
    animate();
  }

  /* 5. 水波纹动效：横向流动水波 + 扩散涟漪（Canvas 2D，纯本地渲染）
       遵循系统"减少动态"偏好，无 Canvas / 被禁用时静默跳过，不阻塞页面 */
  var waterCanvas = document.getElementById("water-background");
  var waterContext = waterCanvas ? waterCanvas.getContext("2d") : null;

  if (waterContext && !prefersReducedMotion) {
    startWaterRipples(waterCanvas, waterContext);
  }

  function startWaterRipples(canvas, context) {
    var devicePixelRatio = window.devicePixelRatio || 1;
    var canvasWidth = 0;   // 逻辑宽度
    var canvasHeight = 0;  // 逻辑高度
    var time = 0;

    // 涟漪列表：{ x, y, radius, life(0~1) }
    var ripples = [];
    var maxRipples = 22;
    var lastAutoSpawn = -9;
    var autoSpawnGap = 3.5;   // 自动涟漪间隔（秒），数值越大涟漪越稀疏

    // 指针位置（生成细微涟漪，增强互动）
    var pointerX = -1;
    var pointerY = -1;
    var lastPointerSpawn = -9;
    var pointerSpawnGap = 2.2;   // 鼠标涟漪限频（秒），数值越大越稀疏

    // 三条横向流动水波带参数（柔和蓝色渐变：上浅 → 下深，低透明度，安静不抢眼）
    // speed 值越小流动越慢；当前为极缓流动，营造安静深水感
    var waveBands = [
      { baseY: 0.28, amplitude: 0.070, speed: 0.009, color: [104, 148, 214], alpha: 0.14 },
      { baseY: 0.52, amplitude: 0.075, speed: 0.013, color: [80, 118, 198], alpha: 0.13 },
      { baseY: 0.78, amplitude: 0.065, speed: 0.011, color: [58, 90, 178], alpha: 0.12 }
    ];

    function resizeCanvas() {
      canvasWidth = window.innerWidth;
      canvasHeight = window.innerHeight;
      canvas.width = Math.floor(canvasWidth * devicePixelRatio);
      canvas.height = Math.floor(canvasHeight * devicePixelRatio);
      canvas.style.width = canvasWidth + "px";
      canvas.style.height = canvasHeight + "px";
      context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    }

    // 生成涟漪
    // spreadFactor：扩散速度倍率（1=标准，越小扩散越慢），用于区分自动/鼠标涟漪
    // initialRadius：初始半径；不传则用随机默认值
    function spawnRipple(originX, originY, spreadFactor, initialRadius) {
      ripples.push({
        x: originX,
        y: originY,
        radius: initialRadius || (10 + Math.random() * 22),
        life: 0,
        spreadFactor: spreadFactor || 1
      });
      if (ripples.length > maxRipples) {
        ripples.shift(); // 超出上限移除最早
      }
    }

    // 计算某横坐标点在当前时刻的波峰高度（叠加两个频率，制造起伏感）
    function computeWaveHeight(x, band, amplitude, speedFactor, time) {
      return (
        Math.sin(x * 0.0045 * speedFactor + time * band.speed * 55) * amplitude
        + Math.sin(x * 0.012 + time * band.speed * 22) * amplitude * 0.35
      );
    }

    // 绘制横向流动水波（加法混合，营造霓虹感）
    function drawWaves(time) {
      context.globalCompositeOperation = "lighter";
      for (var i = 0; i < waveBands.length; i++) {
        var band = waveBands[i];
        var baseY = band.baseY * canvasHeight;
        var amplitude = band.amplitude * canvasHeight;
        var speedFactor = 1 + i * 0.5;
        var color = band.color;
        var colorString =
          "rgba(" + color[0] + "," + color[1] + "," + color[2] + ",";

        // 1) 填充波峰到屏幕底部的半透明色带（加法混合，若隐若现的水光）
        context.beginPath();
        context.moveTo(0, baseY);
        for (var x = 0; x <= canvasWidth; x += 8) {
          context.lineTo(x, baseY + computeWaveHeight(x, band, amplitude, speedFactor, time));
        }
        context.lineTo(canvasWidth, canvasHeight);
        context.lineTo(0, canvasHeight);
        context.closePath();
        context.fillStyle = colorString + band.alpha + ")";
        context.fill();

        // 2) 沿波峰描一条较柔的光边，让"流动的水纹"隐约可见
        context.beginPath();
        context.moveTo(0, baseY);
        for (var x = 0; x <= canvasWidth; x += 4) {
          context.lineTo(x, baseY + computeWaveHeight(x, band, amplitude, speedFactor, time));
        }
        context.strokeStyle = colorString + 0.45 + ")";
        context.lineWidth = 1.5;
        context.stroke();
      }
      context.globalCompositeOperation = "source-over";
    }

    // 绘制扩散涟漪（外圈 + 内圈，随 life 淡出）
    // radius 增量越小扩散越慢、life 增量越小存活越久；当前为慢速优雅扩散
    function drawRipples() {
      for (var i = ripples.length - 1; i >= 0; i--) {
        var ripple = ripples[i];
        ripple.life += 0.009 * ripple.spreadFactor;
        ripple.radius += canvasHeight * 0.0012 * ripple.spreadFactor;

        if (ripple.life >= 1) {
          ripples.splice(i, 1);
          continue;
        }

        var alpha = (1 - ripple.life) * 0.35;
        context.beginPath();
        context.arc(ripple.x, ripple.y, ripple.radius, 0, Math.PI * 2);
        context.strokeStyle = "rgba(140, 170, 220, " + alpha + ")";
        context.lineWidth = 2;
        context.stroke();

        context.beginPath();
        context.arc(ripple.x, ripple.y, Math.max(2, ripple.radius * 0.4), 0, Math.PI * 2);
        context.strokeStyle = "rgba(110, 160, 230, " + alpha * 0.6 + ")";
        context.lineWidth = 1;
        context.stroke();
      }
    }

    function animate() {
      time += 0.016;
      context.clearRect(0, 0, canvasWidth, canvasHeight);

      drawWaves(time);

      // 周期性自动生成涟漪
      if (time - lastAutoSpawn > autoSpawnGap) {
        spawnRipple(Math.random() * canvasWidth, Math.random() * canvasHeight * 0.9);
        lastAutoSpawn = time;
      }
      // 指针移动时生成涟漪（限频；倍率 0.45 使鼠标涟漪扩散更慢、更小，避免跟手过快）
      if (pointerX >= 0 && pointerY >= 0 && time - lastPointerSpawn > pointerSpawnGap) {
        spawnRipple(pointerX, pointerY, 0.45, 6 + Math.random() * 6);
        lastPointerSpawn = time;
      }

      drawRipples();
      requestAnimationFrame(animate);
    }

    function onPointerMove(event) {
      pointerX = event.clientX;
      pointerY = event.clientY;
    }

    window.addEventListener("resize", resizeCanvas, { passive: true });
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    resizeCanvas();
    // 先同步绘制首帧，避免首屏 canvas 空白（rAF 在后台/节流时可能不触发；有兜底更稳）
    drawWaves(time);
    animate();
  }
})();
