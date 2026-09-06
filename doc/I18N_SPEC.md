# 多语言开发规范

> 本文件是 launcher 桌面壳 + 插件 JS 的多语言实现规范，所有新 UI 或插件文字国际化必须遵循此文档。
> 基于 2026-09-06 排查踩坑总结（widget 变量 None、硬编码漏替换、zh/en key 不对齐、fallback 方向错误等）。

***

## 一、三层翻译体系

```
┌──────────────────────────────────────────────────────────────┐
│ 启动器 (launcher.py, Tkinter)                                │
│   → i18n.py 模块 (locales/zh.json + en.json)                  │
│     · 函数: i18n.t('key', **kwargs)                           │
│     · 单例: i18n.translator.switch('zh'|'en')                 │
│     · 回调: i18n.translator.on_change(callback)               │
├──────────────────────────────────────────────────────────────┤
│ 桌面壳 bridge (desktop-shell.py → window.__DSH_I18N__)        │
│   → window._dsht(key, fallback)   ← 插件 JS 必须用这个         │
│     · 优先级: <html lang> → localStorage → config.json        │
│     · 自动监听 <html lang> 变化 → dispatch dsh-i18n-change   │
├──────────────────────────────────────────────────────────────┤
│ WebUI 官方 (DSH LocaleRuntime)                                │
│   → settings.yaml → locale → preference                       │
│   → 启动器启动时用 config.json.language 覆盖写入此值           │
└──────────────────────────────────────────────────────────────┘
```

**默认 / fallback 一律 zh，不允许 fallback 到 en。**

***

## 二、Tkinter 控件创建三步走（铁律）

所有 UI 文字国际化，以下三步缺一不可。

### Step 1 · 赋值 + 布局分开（变量不能是 None）

```python
# ❌ 连写 = None (TTk 布局方法返回 None!)
bad_btn = ttk.Button(frame, text="硬编码中文").pack(side="left")
# bad_btn = None → 注册后 refresh 里 None.config(text='...') 静默失败

# ✅ 正确: 赋值 + 布局分行
good_btn = ttk.Button(frame, text=i18n.t('group.key'))
good_btn.pack(side="left", padx=8)
```

### Step 2 · 注册到 `_i18n_widgets`

```python
_i18n_widgets.append((good_btn, 'text', 'group.key'))
#                         ↑        ↑        ↑
#                      控件对象  属性名   i18n key
```

`refresh_all_text()` 遍历此列表，对每个控件执行 `widget.config(text=i18n.t(key))`。

### Step 3 · 在 locales 里加 key

两边必须同时存在：`locales/zh.json` 和 `locales/en.json`。详见第四节。

### 需要注册的控件类型

| 控件 | 注册属性 | 备注 |
| --- | --- | --- |
| `ttk.Label`, `tk.Label` | `text` | |
| `ttk.Button`, `tk.Button` | `text` | |
| `ttk.Checkbutton`, `tk.Checkbutton` | `text` | |
| `ttk.Radiobutton`, `tk.Radiobutton` | `text` | |
| `ttk.Labelframe` | `text` | |
| `ttk.Notebook` tab | `text` | 需额外处理 tab 重新设置 |

***

## 三、动态控件处理

以下控件不走 `_i18n_widgets` 自动刷新，需要手动处理：

### messagebox / filedialog — 调用时实时翻译

每次调用都是新的，不需要预注册：

```python
messagebox.showinfo(i18n.t('dialog.title'), i18n.t('dialog.body'))
```

### Combobox values — 在 refresh_all_text 里重设

```python
# 语言切换后 values 里的选项文字也要换语言
my_combo['values'] = (i18n.t('option.a'), i18n.t('option.b'))
my_combo.current(0)
```

### Treeview heading / 行内容 — 目前不自动刷新

heading 通过 `tree.heading("#0", text=...)` 设置，行内容通过 `tree.insert()` 一次性填充。语言切换后这些不会自动更新。如需实时，需在 `refresh_all_text` 里重设 heading + 重建行（或存引用后逐项重写）。当前策略：Treeview 内容在对话框重建时自然更新（用户关掉再打开就是新语言）。

### StringVar — 手动注册

`status_text = tk.StringVar()` 这类动态 StringVar 要在 `refresh_all_text` 里单独处理，或追加到 `_i18n_stringvars` 列表（若项目有此机制）。

### 字符串拼接 → 占位符

```python
# ❌ 不要: 在 Python 里拼
"当前版本: %s" % current_version

# ✅ 要: 让翻译文件支持占位符
# zh.json: { "status.current_version": "当前版本: {version}" }
# en.json: { "status.current_version": "Current version: {version}" }
i18n.t('status.current_version', version=current_version)
```

***

## 四、Locales 文件规范

### Key 命名

```
group.subgroup.key        # 小写 + 点分隔
例: check_update.npm_latest
例: maintenance.cleanup_hint
例: upgrade_confirm.footer
```

### zh.json 和 en.json 必须同步

每次加 key 后，用以下脚本验证对齐：

```bash
python -c "
import json
zh = json.load(open('locales/zh.json'))
en = json.load(open('locales/en.json'))
def flatten(d, p=''):
    out = set()
    for k, v in d.items():
        key = f'{p}.{k}' if p else k
        if isinstance(v, dict): out.update(flatten(v, key))
        else: out.add(key)
    return out
zk = flatten(zh); ek = flatten(en)
print(f'zh: {len(zk)} keys, en: {len(ek)} keys')
print(f'missing in en: {zk - ek}')
print(f'missing in zh: {ek - zk}')
"
```

### fallback 方向

| 场景 | 默认 / fallback |
| --- | --- |
| 启动器 Tkinter | i18n.py 默认 `zh` |
| 插件 JS bridge | `window._dsht(key, "中文 fallback")` |
| DSH LocaleRuntime | settings.yaml `locale.preference`（启动器启动时写入） |
| 浏览器直接打开 WebUI | 插件 `_dsht` 的中文 fallback（没有 bridge） |

**严禁 fallback 到 en。** `_dsht` 里若当前语言没翻译，直接返回调用方传入的中文 fallback。

***

## 五、插件 JS i18n 规范

### 必须的 `_dsht()` 函数（文件顶部）

```javascript
function _dsht(key, fallback) {
    try {
        const val = window.__DSH_I18N__?.[window.__DSH_I18N__.current]?.[key];
        if (val) return val;
    } catch(_) {}
    return fallback;   // fallback 必须是中文原文
}
```

### 必须的语言切换监听（React 组件里）

```javascript
const [i18nTick, setI18nTick] = React.useState(0);

React.useEffect(() => {
    const handler = () => setI18nTick(t => t + 1);
    document.addEventListener('dsh-i18n-change', handler);
    return () => document.removeEventListener('dsh-i18n-change', handler);
}, []);
```

### 注意事项

- `apply(ctx)` 里注册 tab label 时 `_dsht("xxx.tab_label", "原文")` 是**一次性求值**，不会随语言切换自动更新。界面内文字会变，但 tab 标题要重建插件才刷新。
- React render 里调用 `_dsht()` 的文字会跟随 `i18nTick` 实时更新。

***

## 六、避坑清单

| # | 坑 | 症状 | 根因 | 解法 |
| --- | --- | --- | --- | --- |
| 1 | widget 变量是 None | 语言切换时该控件静默不刷新 | `.pack()`/`.grid()` 连写在构造后，返回 None | 赋值和布局分行写 |
| 2 | 硬编码中文漏替换 | 界面上有一部分文字永远是中文 | 只做了 grep 替换，手工构建的字符串没覆盖 | 终极扫描脚本（见下节） |
| 3 | zh/en key 数量不对齐 | 切到英文某处显示 key 本身或中文 fallback | 只改了一个文件 | 每次改完跑对齐验证脚本 |
| 4 | bridge fallback 到 en | 切到中文时某处仍显示英文 | `_dsht` 里做了 "另一种语言兜底" | 删掉，当前语言没翻译就返回中文 fallback |
| 5 | Treeview 内容不刷新 | 切语言后表格行文字不变 | Treeview 是一次性 insert | 关掉重开对话框（当前策略）或在 refresh_all_text 里重建 |

***

## 七、测试 checklist

改完 UI 多语言化后必须逐项验证：

```
[ ] launcher.py 语法通过 (py_compile)
[ ] desktop-shell.py 语法通过
[ ] 所有硬编码中文 text= 已替换为 i18n.t()
[ ] 所有新控件有变量名（无 .pack()/.grid() 连写）
[ ] 所有新控件已 append 到 _i18n_widgets
[ ] zh.json + en.json key 完全对齐（跑第四节验证脚本）
[ ] 启动器界面切换 EN → 所有注册控件实时变英文
[ ] 启动器界面切换 中文 → 所有注册控件实时变回中文
[ ] 启动 WebUI → 初始语言 = config.json.language
[ ] 插件设置界面切换语言 → 文字实时更新（插件 JS 有 i18nTick）
```

***

## 八、已知限制（暂不解决）

| 限制 | 说明 |
| --- | --- |
| 插件 tab label 不实时 | slot 注册时是静态值，语言切换后 tab 标题不变（界面内文字会变）|
| Treeview heading / 行内容 | 语言切换后不自动刷新，关掉重开对话框自然更新 |
| Combobox values | 需在 refresh_all_text 里显式重设 |
| status_text 等 StringVar | 动态 StringVar 需额外注册或单独处理 |
| append_log 日志 | 日志中的硬编码中文不翻译，保持原样（便于调试）|
