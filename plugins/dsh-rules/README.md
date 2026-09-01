# dsh-rules

DSH 插件: 用户规则注入。类似 TRAE Work 的「规则」功能。

## 功能

编写你的个人偏好、代码风格、沟通要求等规则 (markdown 格式), 每次对话时自动作为 system prompt 注入给 LLM。

## 安装

绿色版启动器首次运行时会自动把内置插件装进 profile。如果你是手动安装:

```bash
dsh plugin add file:./plugins/dsh-rules
```

## 使用

### 1. 找到规则文件

规则文件位置:

```
绿色版:  runtime/dsh-home/rules/user-rules.md
非绿色版: ~/.dsh/rules/user-rules.md
```

首次安装时会自动从 `default-rules.md` 拷贝一份默认模板。

### 2. 编辑规则

直接用任意编辑器打开 `user-rules.md`, 写入你的规则。例如:

```markdown
# 我的规则

## 代码风格
- 所有变量名用英文全称, 不要简写
- Python 项目尽量用最少依赖
- 提供 bat 一键运行脚本

## 沟通偏好
- 回复用中文
- 文案包装优先用三国历史典故
```

### 3. 自动生效

- 修改保存后, DSH 会在**下次对话请求**时自动读取最新内容

- `autoReload: true` (默认) 时, 文件变化会被 `fs.watch` 监听到

- 规则内容会作为 system prompt 的一个 context (`name: user-rules`) 注入

## 配置

在 `cordis.yml` 里可选配置:

```yaml
dsh-rules:
  enabled: true              # 总开关
  rulesPath: ''              # 空=默认 DSH_HOME/rules/user-rules.md
  autoReload: true           # 文件变化自动重载
  weight: 0.9                # 注入权重 (越高越优先)
  headerLabel: '【用户规则】' # 注入标题
  failSilently: true         # 读文件失败时静默
  maxLength: 16000           # 规则最大字符数 (0=不限)
```

## 工作原理

```
用户写 user-rules.md
    ↓
dsh-rules 监听 system-prompt/assemble 事件
    ↓
每次模型请求组装 prompt 时读取规则
    ↓
追加到 assembly.contexts.push({ name:'user-rules', text: '...', weight: 0.9 })
    ↓
DSH runtime 把所有 contexts 拼成完整 system prompt
    ↓
发给 LLM → LLM 看到你的规则 → 遵循回答
```

## 与 dsh-memory autoRecall 的区别

| <br />       | dsh-rules                    | dsh-memory autoRecall |
| ------------ | ---------------------------- | --------------------- |
| 内容           | 用户手写的固定规则                    | 祖宗记忆库自动召回的最近对话        |
| 可编辑          | ✅ 手动编辑 md 文件                 | ❌ 自动管理                |
| 持久化          | 规则文件                         | SQLite 数据库            |
| context name | `user-rules`                 | `zuzong:auto-recall`  |
| 冲突           | 两个独立 context, 各有唯一 name, 不冲突 | <br />                |

## 故障排查

### 规则没生效?

1. 确认规则文件有内容 (不是空文件)
2. 确认 `enabled: true` (cordis.yml 或默认值)
3. 重启 DSH 服务 (或等 autoReload 触发)
4. 看日志: `dsh-rules: ready, rules file = ...`

### 规则文件被删了?

插件不会崩溃, 只是不注入规则。下次启动时 `ensureRulesFile()` 会从 default-rules.md 重建默认模板。

## 开发

基于 `system-prompt/assemble` waterfall 事件实现。参考:

- [dsh-memory hooks.js](../dsh-memory/lib/hooks.js) — 同一事件的另一个使用范例

- `runtime/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/invariant.js` — context 类型约束

