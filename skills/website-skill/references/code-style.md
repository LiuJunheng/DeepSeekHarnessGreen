# 代码规范

## 命名

| 元素 | 规范 | 反例 |
|------|------|------|
| JS 变量 / 函数 | 全称，小驼峰 | `btn`（应为 `button`）、`ctx`（应为 `canvasContext`） |
| CSS class | kebab-case，语义化 | `.blue-box`（应为 `.hero-card`） |
| HTML id | kebab-case，全局唯一 | |
| JS 常量 | UPPER_SNAKE | `CHUNK_SIZE`、`CACHE_TTL_MS` |
| CSS 变量 | kebab-case，双横线前缀 | `--accent`、`--bg-deep` |

## HTML

- 语义化标签优先：`<header>` `<nav>` `<main>` `<section>` `<article>` `<footer>`
- 装饰性元素加 `aria-hidden="true"`；交互元素加 `aria-label`
- 所有 `<img>` 必须有 `alt`；`<a>` 必须有文本（不能只有图标）
- 自闭合标签正确写法：`<img src="..." alt="...">`（不要 `/>`）
- **所有外部链接**必须加 `target="_blank" rel="noopener"`（防 tabnabbing）
- **nofollow 规则**：自己站点的外链 → `rel="noopener"`（传递权重）；外链到第三方 → `rel="nofollow noopener noreferrer"`（不传递权重）

## CSS

- 用 **CSS 变量（custom properties）** 统一主题色 / 间距 / 字号
- `:root { --accent: #39d3ff; }` 一处定义，全站复用
- 响应式断点统一（如 720px），不要每页各写一套 media query
- **背景负 z-index + `pointer-events: none`**，否则挡住页面交互
- Canvas 分层：粒子 O(n²) 连线、水纹逐像素，**分层可单独替换互不干扰**
- 渐变边框用 `mask + padding` 技巧，`border-image` 不支持圆角

## JS

- ES5：只用 `var` / `function`，不用 `let` / 箭头函数
- 所有滚动 / 指针事件加 `{ passive: true }`
- `requestAnimationFrame` 驱动动画；滚动监听用 `IntersectionObserver`
- **IntersectionObserver 触发后立即 `unobserve`**，不要常驻
- 首屏 canvas 先同步画一次（防后台/节流下 rAF 首帧不触发导致空白）
- **不要在 JS 里设置受保护请求头**（User-Agent / Cookie / Origin / Referer）——浏览器安全策略会抛 `Refused to set unsafe header`

## 无障碍

- 遵循 `prefers-reduced-motion`：开启"减少动态"时**禁用所有 Canvas 动效**
- 键盘可访问：所有交互元素可通过 Tab 键聚焦
- 图片 `alt` 描述有用内容（不要 "picture" 或留空）

## 性能

- 粒子 / 涟漪按屏幕面积自适应，超出上限的旧粒子移除
- Canvas 支持 DPR（`devicePixelRatio`）自适应
- 移动端 ≤720px 隐藏扫描光、粒子降密度（低端机动画掉帧）
- 图片加 `loading="lazy"`
