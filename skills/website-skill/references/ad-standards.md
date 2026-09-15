# AdSense 接入规范

## 前置要求

Google AdSense 审核会检查：

1. **网站有实质性原创内容**（不是空壳、不是聚合站）
2. **About / Privacy Policy 合规页存在**（审核必查）
3. **ads.txt 存在**（`https://yourdomain.com/ads.txt` 公开可访问）
4. **版权清晰**（不侵权、非灰色地带产品）

## ads.txt 格式

放在 `pages/ads.txt`（Cloudflare Pages 根目录）：

```txt
google.com, pub-XXXXXXXXXXXXXXXX, DIRECT, f08c47fec0942fa0
```

- `pub-XXXXXXXXXXXXXXXX` — 你的发布商 ID
- `f08c47fec0942fa0` — Google 官方固定授权卖家标识，**不要改**
- 发布商 ID 必须和 `<head>` 里的 `google-adsense-account` 一致

## 全站 head 加 adsbygoogle.js

```html
<meta name="google-adsense-account" content="ca-pub-XXXXXXXXXXXXXXXX" />
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-XXXXXXXXXXXXXXXX" crossorigin="anonymous"></script>
```

**每个页面都要加**，不要漏。Mediapartners-Google 爬虫不跑 JS，标签必须是静态 HTML。

## 广告位预留

| 位置 | 推荐尺寸 | 说明 |
|------|---------|------|
| Hero 下方、快速上手上方 | Responsive banner | 内容间横幅 |
| Download 区块下方 | Medium rectangle (300×250) | 中等矩形 |
| Footer 上方 | Responsive banner | 底部横幅 |

## 投放替换流程

**投放前（占位）**：
```html
<div id="ad-slot-1" class="ad-slot ad-slot-wide" aria-label="advertisement">
  <!-- ADS_PLACEHOLDER_1: 审核通过后替换 -->
</div>
```

**投放后（真实广告）**：
```html
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

**保留外层 `.ad-slot` 容器 + `aria-label`**。

## CSS 容器（style.css）

```css
.ad-slot       { width:100%; max-width:728px; margin:28px auto; min-height:90px; ... }
.ad-slot-wide  { max-width:728px; }   /* leaderboard 类 */
.ad-slot-rect  { max-width:336px; }   /* medium rectangle */
```

**投放后去掉虚线占位边框和背景**（`.ad-slot` 里的 `border` / `background`）。

## 多语言注意

- AdSense 爬虫按**页面内容主体语言**决定广告，**不看** `<html lang>`
- 每个页面必须真的单语言（目录式架构正确）
- 中/英文页面广告 RPM 差异大（中文 ≈ 英文的 30-60%）
- 一个域名双语没问题

## AdSense 会拒绝的内容

- 机翻痕迹重（典型拒绝原因）
- 空洞（只有标题或几句描述）
- 灰色地带产品（盗版/破解/赌博）
- 没有 About / Privacy 的站点

## 其他合规

- 欧盟 GDPR：如果接 AdSense，未来考虑加 Cookie 同意横幅（当前暂不做，隐私政策说明）
- ad-slot 容器样式投放后要调整：投放前有占位 border/background，投放后要去掉（AdSense `<ins>` 自带尺寸）
