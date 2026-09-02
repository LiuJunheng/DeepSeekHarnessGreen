# DSH 插件主题适配规范

> 踩过 3 轮坑才搞对，直接抄。变量权威定义：`runtime/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js`

## 核心原则

**背景和文字必须一起走 CSS 变量**，DSH 自动根据 `data-theme="dark|light"` 切换值。绝对不要"背景硬编码 + 文字走变量"或反过来。

## 变量速查表

| 元素类型      | 正确变量                                                     | 说明                |
| --------- | -------------------------------------------------------- | ----------------- |
| 卡片/面板背景   | `var(--dsw-alias-bg-base)`                               | 主面板底色             |
| 输入框背景     | `var(--dsw-specific-input-major)`                        | DSH 官方专用，深浅都做了对比度 |
| 主文字（标题）   | `var(--dsw-alias-label-primary)`                         | 深=亮，浅=深           |
| 次文字（hint） | `var(--dsw-alias-label-secondary)`                       | 比 primary 低一级     |
| 辅助文字      | `var(--dsw-alias-label-tertiary)`                        | 用在"最近检测时间"这种      |
| 边框        | `var(--dsw-alias-border-l2)`                             | 通用边框              |
| 主按钮填充     | `var(--dsw-alias-button-info-fill)`                      | 品牌蓝，深浅不变          |
| 状态-成功     | `var(--dsw-alias-state-success-primary)`                 | 绿                 |
| 状态-错误     | `var(--dsw-alias-state-error-primary)`                   | 红                 |
| 业务色       | `var(--dsw-alias-state-business-primary)` / `-secondary` | 蓝                 |
| 警告色       | `var(--dsw-alias-state-warn-primary)`                    | 橙，只在真正警告用         |

## 唯一可接受的硬编码

按钮上的白字 `color: "#ffffff"` —— 配合 `--dsw-alias-button-info-fill` 填充色，设计规范内的对比度保证。其他任何地方都**不要硬编码颜色**。

## 错误示范 vs 正确写法

```js
// ❌ 硬编码白底 + CSS 变量字（深主题下白底像补丁）
const card = { background: "#ffffff", color: "var(--dsw-alias-label-primary)" };

// ❌ 硬编码灰字（深浅都不变，深主题下糊）
const hint = { color: "#8a8f98" };

// ❌ 输入框用 bg-primary 而不是 specific-input-major
const input = { background: "var(--dsw-alias-bg-primary)" };

// ❌ "运行中"用 warn 橙色（语义错误，运行中是正常不是警告）
const running = { color: "var(--dsw-alias-state-warn-primary)" };

// ✅ 全部变量
const card = { background: "var(--dsw-alias-bg-base)", color: "var(--dsw-alias-label-primary)", border: "1px solid var(--dsw-alias-border-l2)" };
const input = { background: "var(--dsw-specific-input-major)", color: "var(--dsw-alias-label-primary)", border: "1px solid var(--dsw-alias-border-l2)" };
const running = { color: "var(--dsw-alias-state-success-primary)" };
```

## 颜色对比度铁律（同色系必糊）

**同一个状态色的** **`primary`（主色）和** **`secondary`（淡底色）绝对不能同时用**在同一个元素上——深浅主题下都会糊成一片。

正确模式分两类：

| 元素类型               | 正确写法                    | 原因                                 |
| ------------------ | ----------------------- | ---------------------------------- |
| Badge/Chip/标签（非交互） | **只用文字色**，不要 background | 轻量标注不需要背景块                         |
| 按钮（可点击）            | **深彩底 + 白字**            | `state-xxx-primary` 做背景，`#fff` 做文字 |

```js
// ❌ primary 文字 + secondary 背景 (同色系糊片!)
const badge = { color: "var(--dsw-alias-state-success-primary)", background: "var(--dsw-alias-state-success-secondary)" };
const deleteBtn = { color: "var(--dsw-alias-state-error-primary)", background: "var(--dsw-alias-state-error-secondary)" };

// ✅ Badge: 只有文字色, 无背景
const runningBadge = { color: "var(--dsw-alias-state-success-primary)" };
const tag = { color: "var(--dsw-alias-state-business-primary)" };

// ✅ 按钮: 深彩底 + 白字
const deleteBtn = { background: "var(--dsw-alias-state-error-primary)", color: "#fff", border: "none" };
```

## 设计语义速查

| 场景       | 正确颜色语义           | 别用           |
| -------- | ---------------- | ------------ |
| 运行中/在线   | success（绿）       | warn（橙，那是警告） |
| 离线/错误    | error（红）         | success      |
| 信息提示     | business（蓝）      | warn（信息不是警告） |
| 真正危险     | warn（橙）          | 其他           |
| 模型名 chip | business 蓝字（无背景） | 蓝底蓝字         |

## 排查命令

改完主题后检查硬编码残留（只剩按钮白字 `#ffffff` 可接受）：

```powershell
Select-String -Path "lib\client.js" -Pattern '#([0-9a-fA-F]{3,8})|rgb\(|rgba\(' -AllMatches
```

