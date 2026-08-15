# dsh-deploy-maintain

DeepSeek Harness 绿色便携版（一键启动器）的部署、维护与插件开发经验 Skill。

## 内容

- **部署**：便携 Node + dsh 安装、环境变量重定向、工作区 ACL 沙箱、exe 打包
- **维护**：更新备份、插件管理（pnpm）、数据维护（会话永久删除）
- **插件开发**：dsh 插件双端加载、`ctx.effect` 路由注册、客户端 `exports` 坑
- **避坑**：34 条实测经验浓缩为排查速查表

## 目录

```
dsh-deploy-maintain/
├── SKILL.md                          # 主文档（部署/维护/插件/避坑/速查表）
├── README.md                         # 本文件
├── checklists/
│   ├── deployment-checklist.md       # 部署/启动/更新/打包/数据维护检查清单
│   └── plugin-dev-checklist.md       # 插件开发/安装/验证检查清单
└── references/
    ├── plugin-skeleton.md            # DSH 插件完整代码骨架（宿主+客户端）
    └── data-directories.md           # DSH 数据目录内部机制详解
```

## 使用

当任务涉及 DSH 绿色版部署、维护或插件开发时，加载本 Skill，按 `SKILL.md` 章节执行，配合 `checklists/` 逐项核对，参考 `references/` 的代码骨架与数据机制。

## 来源

沉淀自 `DeepSeekHarnessLauncher` 项目（Python tkinter 一键启动器 + `dsh-archive-purge` 插件）的全过程实测，含 34 条避坑记录（2026-08-15）。
