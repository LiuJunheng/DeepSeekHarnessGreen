# DeepSeek Harness Green Pages · 维护记录

> 本文件是 `pages/`（GitHub Pages 发布页）的维护记录，只记对日后维护有复用价值的内容：架构、定稿参数、规范与避坑。不存档设计与开发过程、版本史与时间线。
> 每次改页面后同步更新本文件，并给所有 HTML 里 `<link>`/`<script>` 加 `?v=x.y` 版本号防缓存（当前 v=3.0）。

---

## 一、技术架构

### 背景层叠顺序（从下到上）

| z-index | 层 | 技术 | 说明 |
|---------|----|------|------|
| -5 | `.bg-gradient` | CSS radial-gradient | 基础深空蓝渐变，最底层的"天" |
| -4 | `.bg-aurora` | CSS radial-gradient + animation | 四团极光光晕，缓慢漂移（18s 周期） |
| -3 | `.bg-grid` | CSS linear-gradient + animation | 网格线呼吸 + 径向渐隐，6s 周期 |
| -2 | `#particles-canvas` | Canvas 2D | 粒子网络，鼠标互动连线 |
| -1 | `#water-background` | Canvas 2D | 横向流动水波 + 扩散涟漪 |
| 0 | `.scan-light` | CSS linear-gradient + animation | 垂直扫描光带，12s 循环，移动端隐藏 |
| 5+ | `main`, `.footer` | 正常文档流 | 页面内容 |

### 设计 Token（CSS 变量）

```css
--bg-deep:    #030617;   /* 最深底 */
--bg-mid:     #071029;   /* 中层蓝 */
--bg-soft:    #0b1a3a;   /* 较亮蓝 */
--accent:     #39d3ff;   /* 主色：青 */
--accent-2:   #4a9eff;   /* 辅色：蓝 */
--accent-3:   #9a6bff;   /* 点缀：紫 */
--text:       #e8f0ff;   /* 主文字 */
--muted:      #8fa4c8;   /* 次要文字 */
--border:     rgba(100, 180, 255, 0.18);
--border-glow:rgba(80, 180, 255, 0.45);
```

### 多语言架构（2026-09 引入）

采用**目录式单语言页面**结构，每个页面天然单语言（AdSense 爬虫按内容主体决定广告语言）。

```
pages/
├── index.html              ← 根入口 (语言检测 + JS 自动跳 /zh/ 或 /en/)
├── robots.txt              ← 爬虫指引 (指 sitemap)
├── sitemap.xml             ← 多语言站点地图 (xhtml:link 互指)
├── assets/                 ← 共享资源 (根入口用 ./, 子页用 ../)
│   ├── style.css           ← 深空蓝主题 + 玻璃拟态 + 动效 + 广告位 + 语言切换 + legal-page
│   └── app.js              ← 交互 (导航 + 淡入 + 版本号 + 粒子 + 水纹)
├── zh/                     ← 纯中文
│   ├── index.html          ← 主页 (带 hreflang + canonical + 3 个广告位占位)
│   ├── about.html          ← 关于 (Apache-2.0 + 非官方声明)
│   └── privacy.html        ← 隐私政策 (不收集数据 + AdSense 预留说明)
└── en/                     ← 纯英文
    ├── index.html
    ├── about.html
    └── privacy.html
```

**hreflang 互指铁律（改页必查）：**
每个页面 `<head>` 必须同时包含以下三条（双向），缺一条 Google 忽略整个 hreflang：
```html
<link rel="canonical" href="https://liujunheng.github.io/DeepSeekHarnessGreen/<path>/">
<link rel="alternate" hreflang="zh" href=".../zh/<path>">
<link rel="alternate" hreflang="en" href=".../en/<path>">
<link rel="alternate" hreflang="x-default" href=".../（根入口）">
```
`lang` 属性精确：zh 版用 `zh-CN`，en 版用 `en`（不用 `en-US`，覆盖更广）。

**路径修正铁律：**
- 根入口 `index.html` 用 `./assets/xxx.css`
- 子页 `zh/index.html` / `en/index.html` 用 `../assets/xxx.css`
- href 锚点 `#quickstart` 不变；跨页锚点用 `index.html#quickstart`

**语言记忆：** 用户从根入口或导航栏切换语言时，写入 `localStorage.setItem('dshe-lang-preference','zh'|'en')`；下次访问根入口先读这个值。

---

## 二、动效定稿参数（当前取值，改前先 Read 复核磁盘）

### 1. 粒子网络（`#particles-canvas`）
- 最大 55 个，按面积自适应（每 18000px² 一个）
- 邻近连线阈值 < 130px、鼠标连线 < 160px；粒子颜色柔和蓝 `rgba(130,170,215)`、外发光 `rgba(104,148,214)`
- 指针轻微吸引 + 速度回归系数 0.995，避免加速后停不下来

### 2. 水波纹（`#water-background`）— 柔和蓝色渐变，安静深水感
- 三条波带（上浅 → 下深），`lighter` 加法混合：

| 带 | baseY | amplitude | speed | 颜色 | alpha |
|----|-------|-----------|-------|------|-------|
| 上 | 0.28 | 0.070 | 0.009 | rgb(104,148,214) 亮青蓝 | 0.14 |
| 中 | 0.52 | 0.075 | 0.013 | rgb(80,118,198) 中蓝 | 0.13 |
| 下 | 0.78 | 0.065 | 0.011 | rgb(58,90,178) 深蓝 | 0.12 |

- 每条波峰再描一条柔光边（alpha 0.45、线宽 1.5），让"流动"隐约可见
- 波浪速度由 `band.speed * 55`（弧度/s）决定；当前极缓，约 110/160/134 px/s
- **自动涟漪**：间隔 `autoSpawnGap = 3.5s`，标准扩散
- **鼠标涟漪**：限频 `pointerSpawnGap = 2.2s`，`spreadFactor 0.45`、初始半径 6-12（比自动更小更慢）
- 涟漪扩散/寿命：`radius += canvasHeight * 0.0012 * spreadFactor`、`life += 0.009 * spreadFactor`；外圈 alpha 0.35、线宽 2
- **必须先同步 `drawWaves(time)` 一次再 `animate()`**（防首屏 canvas 空白）

### 3. 扫描光 / 网格呼吸 / 极光
- 扫描光 12s、网格呼吸 6s、极光漂移 18s；均纯 CSS
- 移动端（≤720px）隐藏扫描光，避免低端机掉帧

### 4. 微交互
- 导航激活项发光下划线、品牌图标呼吸发光、渐变文字 6s 色相循环
- 按钮 hover 光扫过、卡片 hover 上浮 + 顶边发光线、标题渐变发光分割线

---

## 三、规范细节

### 代码风格
- **变量名用全称**：写 `button` 不写 `btn`、`context` 不写 `ctx`
- **JS 保持 ES5**：只用 `var`/`function`/`Array.prototype.slice`，不用 let/箭头函数
- **零外部依赖**：纯原生 JS + CSS，不引 CDN/字体/统计
- 所有 scroll/pointer 事件加 `{ passive: true }`

### 无障碍
- 装饰性背景元素均加 `aria-hidden="true"`；导航加 `aria-label`
- 遵循 `prefers-reduced-motion`：开启"减少动态"时**禁用所有 Canvas 动效**

### 响应式
- 断点：720px；导航堆叠、下载面板单列、扫描光隐藏
- Canvas 均支持 DPR 自适应（`devicePixelRatio`）

### 性能
- 粒子按屏幕面积自适应；涟漪上限 22 个，超出移除最早
- `requestAnimationFrame` 驱动；滚动淡入用 `IntersectionObserver`，显示后立即 `unobserve`

### 缓存防坑
- 每次改版同步给所有 HTML 中 `<link>`/`<script>` 加 `?v=x.y` 版本号（当前 v=3.0），否则浏览器/Pages 会加载旧资源造成"改了没生效"的假象

---

## 四、避坑经验

- **Canvas 分两个**（粒子、水纹）：粒子需 O(n²) 连线、水纹逐像素，分层可单独替换/调整互不干扰。
- **背景负 z-index、内容正 z-index**，`position: fixed` 的背景层必须 `pointer-events: none`，否则挡住页面交互。
- **首屏空白**：后台/节流下 rAF 首帧可能不触发 → 进 `animate()` 前先同步画一次 `drawWaves(time)` 兜底。
- **标题居中**：用 `text-align: center` + 块级 `margin: auto`；**勿用 `left:50% + transform: translateX(-50%)`**，会与滚动淡入 `.reveal` 的 `transform` 冲突导致失居。
- **调"飘得太快"**：优先降 `waveBands[].speed`，同时按比例放宽 `autoSpawnGap`；但用户感知主要来自**涟漪扩散速度（`radius` 增量）与寿命（`life` 增量）**，改这两个比改波速更直观。
- **涟漪独立节奏**：`spawnRipple` 带 `spreadFactor`/`initialRadius` 参数，`drawRipples` 里扩散与寿命都乘倍率，可让自动 vs 鼠标涟漪各有节奏。
- **改文件必复核**：diff 显示成功 ≠ 真正落盘，出现过"改了没生效"先查磁盘实际值（Grep/Read 复核再交付）。
- **渐变边框用 `mask + padding` 技巧**（`.terminal::before`），`border-image` 不支持圆角。
- **移动端**：低端机动画掉帧，隐藏扫描光、粒子按面积降密度、reduced-motion 检查放最前直接跳过。
- **PowerShell 正则替换 HTML 片段极易破坏标签**：脚本化批量改 HTML 结构风险极高，复杂改动优先用 Edit 工具逐段精确替换，简单批量改（如 `v=2.6→v=3.0`）才适合 PowerShell 字符串替换。

---

## 五、文案分寸（当前采用直白原则）

- **功能按钮 / 操作步骤文字不改、保持清晰直白**（下载、安装环境等）。
- 标题与正文直白，不采用趣味包装；装饰性口号也以直接传达价值为先。
- FAQ 问题口语化、答案保留技术术语。
- **用户明确偏好优先于规则建议**（曾用三国军帐风格包装被要求完整回退）。
- **所有翻译文案禁止机翻**：英文文案必须是自然人类写的，机翻痕迹是 AdSense 审核以"低价值内容"拒绝的典型原因。

---

## 六、广告位预留（Google AdSense 接入准备）

### Mediapartners-Google 爬虫限制（关键！）
AdSense 比 Googlebot 基础得多，**看不到 JS 动态渲染/插入的内容**。所有关键 HTML（包括广告位容器）必须是**静态 HTML 源码的一部分**，不能靠 JS 动态注入。

### 广告位位置（共 3 处，主页面）
| ID | 位置 | 推荐尺寸 | 说明 |
|----|------|---------|------|
| `ad-slot-1` | Hero 下方、快速上手上方 | Responsive banner | 内容间横幅 |
| `ad-slot-2` | Download 区块下方 | Medium rectangle (300×250) | 中等矩形 |
| `ad-slot-3` | Footer 上方 | Responsive banner | 底部横幅 |

### CSS 容器（已写在 style.css）
```css
.ad-slot       { width:100%; max-width:728px; margin:28px auto; min-height:90px; ... }
.ad-slot-wide  { max-width:728px; }   /* leaderboard 类 */
.ad-slot-rect  { max-width:336px; }   /* medium rectangle */
```
投放后**去掉虚线占位边框**（`.ad-slot` 里的 `border`/`background`）。

### 投放替换流程（审核通过后）
把 HTML 注释占位替换成 AdSense `<ins>` 代码，**保留外层 `.ad-slot` 容器 + `aria-label`**：
```html
<!-- 前: -->
<div id="ad-slot-1" class="ad-slot ad-slot-wide" aria-label="advertisement">
  <!-- ADS_PLACEHOLDER_1: Replace with <ins class="adsbygoogle"> code after AdSense approval -->
</div>

<!-- 后: -->
<div id="ad-slot-1" class="ad-slot ad-slot-wide" aria-label="advertisement">
  <ins class="adsbygoogle"
       style="display:block"
       data-ad-client="ca-pub-XXXXXXXXXXXXXXXX"
       data-ad-slot="XXXXXXXXXX"
       data-ad-format="auto"
       data-full-width-responsive="true"></ins>
  <script>(adsbygoogle = window.adsbygoogle || []).push({});</script>
</div>
```

### AdSense 多语言注意点
- AdSense 爬虫按**页面内容主体语言**决定广告，**不看** `<html lang>` — 每个页面必须真的单语言
- 中/英文页面广告 RPM 差异大（中文 ≈ 英文的 30-60%），一个域名双语没问题
- 合规页（About / Privacy Policy）是 AdSense 审核必查项

---

## 七、后续可优化方向

- [ ] 增加暗/亮色主题切换（目前仅深色科技风）
- [ ] 增加"返回顶部"悬浮按钮
- [ ] Hero 区增加产品截图/动图展示
- [ ] 下载面板增加文件大小、更新日期等信息
- [ ] 考虑增加顶部滚动进度条
- [ ] AdSense 审核通过后替换 3 个广告位占位 + 接入 GA4/Universal Analytics（合规页已有说明）
- [ ] 欧盟合规：接入 AdSense 后，未来考虑加 GDPR Cookie 同意横幅（当前暂不做，隐私政策已说明）
