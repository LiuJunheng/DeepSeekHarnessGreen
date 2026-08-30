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
