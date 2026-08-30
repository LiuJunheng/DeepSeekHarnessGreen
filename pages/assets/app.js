/* =========================================================
   DeepSeek Harness 绿色版发布页 · 轻量交互（无外部依赖）
   吸顶导航高亮 + 滚动淡入
   ========================================================= */
(function () {
  "use strict";

  // 取父级文档中的元素（首行即用封装，避免全局污染）
  function queryAll(selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector));
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
    request.setRequestHeader("User-Agent", "DSH-GreenPortable-Pages");
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

  /* 4. 水纹动效：横向流动水波 + 扩散涟漪（Canvas 2D，纯本地渲染）
       遵循系统“减少动态”偏好，无 Canvas / 被禁用时静默跳过，不阻塞页面 */
  var waterCanvas = document.getElementById("water-background");
  var waterContext = waterCanvas ? waterCanvas.getContext("2d") : null;
  var prefersReducedMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce).matches");

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
    var maxRipples = 14;
    var lastAutoSpawn = -9;
    var autoSpawnGap = 2.6;

    // 指针位置（生成细微涟漪，增强互动）
    var pointerX = -1;
    var pointerY = -1;
    var lastPointerSpawn = -9;
    var pointerSpawnGap = 0.5;

    // 三条横向流动水波带参数（青/蓝/紫，低透明度叠加光效）
    var waveBands = [
      { baseY: 0.30, amplitude: 0.045, speed: 0.10, color: [57, 211, 255], alpha: 0.05 },
      { baseY: 0.55, amplitude: 0.050, speed: 0.16, color: [64, 151, 255], alpha: 0.05 },
      { baseY: 0.80, amplitude: 0.045, speed: 0.13, color: [154, 107, 255], alpha: 0.06 }
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

    function spawnRipple(originX, originY) {
      ripples.push({ x: originX, y: originY, radius: 10 + Math.random() * 22, life: 0 });
      if (ripples.length > maxRipples) {
        ripples.shift(); // 超出上限移除最早
      }
    }

    // 绘制横向流动水波（加法混合，营造霓虹感）
    function drawWaves(time) {
      context.globalCompositeOperation = "lighter";
      for (var i = 0; i < waveBands.length; i++) {
        var band = waveBands[i];
        var baseY = band.baseY * canvasHeight;
        var amplitude = band.amplitude * canvasHeight;
        var speedFactor = 1 + i * 0.5;

        context.beginPath();
        context.moveTo(0, baseY);
        for (var x = 0; x <= canvasWidth; x += 8) {
          var waveHeight =
            Math.sin(x * 0.0045 * speedFactor + time * band.speed * 55) * amplitude
            + Math.sin(x * 0.012 + time * band.speed * 22) * amplitude * 0.35;
          context.lineTo(x, baseY + waveHeight);
        }
        context.lineTo(canvasWidth, canvasHeight);
        context.lineTo(0, canvasHeight);
        context.closePath();

        var color = band.color;
        context.fillStyle =
          "rgba(" + color[0] + "," + color[1] + "," + color[2] + "," + band.alpha + ")";
        context.fill();
      }
      context.globalCompositeOperation = "source-over";
    }

    // 绘制扩散涟漪（外圈 + 内圈，随 life 淡出）
    function drawRipples() {
      for (var i = ripples.length - 1; i >= 0; i--) {
        var ripple = ripples[i];
        ripple.life += 0.02;
        ripple.radius += canvasHeight * 0.0022;

        if (ripple.life >= 1) {
          ripples.splice(i, 1);
          continue;
        }

        var alpha = (1 - ripple.life) * 0.26;
        context.beginPath();
        context.arc(ripple.x, ripple.y, ripple.radius, 0, Math.PI * 2);
        context.strokeStyle = "rgba(120, 190, 255, " + alpha + ")";
        context.lineWidth = 1.5;
        context.stroke();

        context.beginPath();
        context.arc(ripple.x, ripple.y, Math.max(2, ripple.radius * 0.4), 0, Math.PI * 2);
        context.strokeStyle = "rgba(57, 211, 255, " + alpha * 0.6 + ")";
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
      // 指针移动时生成涟漪（限频）
      if (pointerX >= 0 && pointerY >= 0 && time - lastPointerSpawn > pointerSpawnGap) {
        spawnRipple(pointerX, pointerY);
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
    animate();
  }
})();