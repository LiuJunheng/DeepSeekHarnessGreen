# dsh-deploy-maintain

DeepSeek Harness 绿色整合版启动器的部署、维护与插件开发经验 Skill。

## 内容

- **部署**：便携 Node + dsh 安装、环境变量重定向、工作区 ACL 沙箱、exe 打包
- **维护**：更新备份、插件管理（pnpm）、数据维护（会话永久删除）、绿色版自更新（双通道）
- **插件开发**：dsh 插件双端加载、Cordis 协议六条硬约束、`ctx.effect` 路由注册、客户端 `exports` 坑、纯客户端插件宿主端 `lib/index.js` 必须存在（缺失服务启动即退出）
- **避坑**：关键易错点浓缩为排查速查表；详细规范独立存放在 `references/`

## 目录

```
dsh-deploy-maintain/
├── SKILL.md                          # 主文档（部署/维护/插件/避坑/速查表，只留核心避坑与规范）
├── README.md                         # 本文件
├── checklists/
│   ├── deployment-checklist.md       # 部署/启动/更新/打包/数据维护检查清单
│   └── plugin-dev-checklist.md       # 插件开发/安装/验证检查清单
├── references/
│   ├── plugin-skeleton.md            # DSH 插件完整代码骨架（宿主+客户端，含类型 B 升级 A）
│   ├── plugin-guide.md               # 插件开发导览
│   ├── data-directories.md           # DSH 数据目录内部机制详解
│   ├── theme-adaptation.md           # WebUI 主题自适应（CSS 变量/对比度/语义色）规范
│   ├── i18n-webui-plugin.md          # 插件 WebUI 多语言（_dsht/bridge/React vs 原生 DOM）
│   ├── release-workflow.md           # 发版流程/打包校验/凭证/编码坑
│   └── web-hosting-seo.md            # 在线发布页双托管 + SEO 模板
└── templates/
    ├── i18n_client_template.js       # 插件客户端 i18n 模板
    └── release-upload-reference.py   # 发布脚本参考
```

## 使用

当任务涉及 DSH 绿色版部署、维护或插件开发时，加载本 Skill，按 `SKILL.md` 章节执行，配合 `checklists/` 逐项核对，参考 `references/` 的代码骨架与数据机制。

## 来源

沉淀自 `DeepSeekHarnessLauncher` 项目（Python tkinter 绿色整合版启动器 + 内置 `dsh-archive-purge` / `dsh-file-browser` / `dsh-session-rewind` / `dsh-usage-stats` / `dsh-sidebar-lite` / `dsh-media-background` 插件）的全过程实测，避坑记录持续补录。
