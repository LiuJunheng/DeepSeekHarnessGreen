v1.0.38 — 绿色版更新通道修复 Release 合并逻辑缺失导致界面卡住

## 修复

- **绿色版更新通道严重 bug**: `green_all_releases()` 函数缺失核心的版本分桶 + 多源合并逻辑，导致 `merged` 变量从未初始化 → 运行时抛 `UnboundLocalError` → 后台 daemon 线程静默吞噬异常 → 界面永远卡在「正在检查」且无任何弹窗或报错
- 补全 `green_all_releases()` 中 GitHub + Gitee 双源按版本号分桶合并的完整逻辑（bucket 分桶 + 主源/辅源区分 + 排序返回）
- `on_check_green_update()` worker 线程从 `try-finally` 改为 `try-except-finally`，异常时打印 traceback + 弹窗报错，防止将来再出现"静默卡住"的不可诊断问题

## 技术架构

- `green_all_releases()` 返回结构统一为 `list[dict]`，每项带 `sources` 字典（key = `github` / `gitee_release`），调用方 `ask_green_update()` 直接消费
- Gitee 侧仅保留 `/releases/download/` 直链 zip（过滤自动生成的 archive，避免下载时 403）
- GitHub 37 条 Release + Gitee 29 条 Release → 按版本分桶后合并为 37 个版本，v1.0.34+ 四版本双源齐全

## 版本更新

- GREEN_VERSION: 1.0.37 → 1.0.38

## 升级建议

- 绿色版覆盖安装即可
