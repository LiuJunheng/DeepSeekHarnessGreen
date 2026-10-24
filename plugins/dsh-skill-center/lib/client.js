// =============================================================================
// dsh-skill-center（客户端）
// 在 DSH Web UI 里注册三处：
//   1) sidebar.panellist  -> 左侧栏「技能」入口（点击后 shell 切到对应的 main 面板）
//   2) main (keyed)       -> 中央「技能中心」页：官方/个人/其他/已停用分组管理
//   3) conversation.input.left -> 聊天输入框左侧「技能」按钮 + 选择器，
//      选中后向草稿插入 /name（走原生显式调用链路，发送后出现 Instructions 卡片）
//
// 加载器契约格式（window.__ModuleLoader__.load）与官方客户端插件、本项目其他
// 内置插件保持一致；零依赖、无构建步骤。宿主端路由前缀 /__dsh/skill-center。
// =============================================================================
window.__ModuleLoader__.load({
    id: "dsh-skill-center",
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

        var react = require("react");
        var h = react.createElement;

        // === 异步加载 i18n bridge（与 dsh-rules / dsh-file-browser 一致） ===
        (function () {
            if (window.__DSH_I18N__ && window.__DSH_I18N__._initialized) return;
            var _s = document.createElement('script');
            _s.src = 'http://127.0.0.1:3081/__dsh_i18n_bridge.js';
            _s.onerror = function () { _s.src = 'http://localhost:3081/__dsh_i18n_bridge.js'; };
            document.head.appendChild(_s);
        })();
        // === i18n bridge END ===

        // ------------------------------------------------------------------
        // 自包含中英词典（不依赖启动器 locale，保证纯浏览器/桌面窗口都可切换）
        // ------------------------------------------------------------------
        var DICT = {
            zh: {
                "panel.title": "技能",
                "page.title": "技能中心",
                "page.subtitle": "官方技能只读，个人技能存放在本机 skills 目录，可安装/编辑/停用/卸载",
                "page.refresh": "刷新",
                "page.import": "导入技能",
                "page.create": "新建技能",
                "page.openFolder": "打开目录",
                "page.search": "搜索名称或描述…",
                "page.dropHint": "松开鼠标即可导入 ZIP（≤12MB，可含多个技能）",
                "page.dragHint": "支持拖拽：把 ZIP 文件直接拖到本页面即可导入",
                "tab.all": "全部",
                "tab.official": "官方",
                "tab.personal": "我的",
                "tab.other": "其他来源",
                "tab.disabled": "已停用",
                "empty.all": "还没有技能",
                "empty.official": "没有官方技能",
                "empty.personal": "还没有个人技能，点「新建技能」或「导入文件夹」",
                "empty.other": "没有其他来源的技能",
                "empty.disabled": "没有已停用的技能",
                "badge.official": "官方",
                "badge.personal": "我的",
                "badge.other": "其他来源",
                "badge.disabled": "已停用",
                "badge.model": "模型可调用",
                "badge.user": "用户可调用",
                "badge.modelOnly": "仅模型",
                "badge.userOnly": "仅用户",
                "row.preview": "预览",
                "row.edit": "编辑",
                "row.disable": "停用",
                "row.enable": "启用",
                "row.remove": "删除",
                "row.invalid": "格式有误",
                "detail.title": "技能详情",
                "detail.close": "关闭",
                "detail.save": "保存",
                "detail.cancel": "取消",
                "detail.readonly": "官方/其他来源技能为只读",
                "detail.placeholder": "SKILL.md 内容",
                "create.title": "新建个人技能",
                "create.name": "技能名（kebab-case）",
                "create.nameHint": "小写字母、数字与连字符，例如 my-workflow",
                "create.description": "描述（必填，模型据此判断何时加载）",
                "create.when": "何时使用（可选）",
                "create.content": "SKILL.md 正文（可选，留空自动生成模板）",
                "create.submit": "创建",
                "import.title": "导入技能（ZIP 或本地路径）",
                "import.hint": "选择 ZIP 上传（可含多个技能，兼容 TRAE/WorkBuddy 导出的 zip）；也可以直接把 ZIP 拖到本页面，或粘贴本地文件夹/.md 路径。",
                "import.path": "本地文件夹或 .md 路径（可直接粘贴）",
                "import.zipChoose": "选择 ZIP 文件…",
                "import.zipSelected": "已选择 ZIP：",
                "import.zipRemove": "移除",
                "import.zipTooBig": "ZIP 不能超过 12MB",
                "import.zipOnly": "仅支持拖拽 .zip 文件",
                "import.zipFailed": "部分技能导入失败：",
                "import.fileTooBig": "文件超过 4MB：",
                "import.readFailed": "读取文件失败：",
                "import.submit": "导入",
                "import.overwrite": "覆盖同名个人技能",
                "import.shadow": "允许遮蔽同名官方技能",
                "confirm.delete.title": "删除技能？",
                "confirm.delete.message": "技能会被移入回收站（$DSH_HOME/skill-center/trash），可手动恢复。",
                "confirm.disable.title": "停用技能？",
                "confirm.disable.message": "停用后模型和聊天选择器都不再看到该技能，可随时启用。",
                "confirm.ok": "确定",
                "confirm.cancel": "取消",
                "err.prefix": "操作失败：",
                "err.load": "加载技能列表失败：",
                "toast.created": "已创建技能",
                "toast.imported": "已导入技能",
                "toast.saved": "已保存",
                "toast.disabled": "已停用",
                "toast.enabled": "已启用",
                "toast.removed": "已移入回收站",
                "picker.button": "技能",
                "picker.title": "选择要使用的技能",
                "picker.search": "搜索技能…",
                "picker.empty": "没有可插入的技能",
                "picker.emptyHint": "在左侧「技能」里新建或导入个人技能",
                "picker.manage": "管理技能…",
                "picker.noInput": "当前输入框不可用（请先打开一个会话）",
                "picker.inserted": "已插入",
                "picker.onlyModel": "仅模型可调用，不能 /name 插入",
                "picker.loading": "加载中…",
                "count.personal": "我的",
                "count.official": "官方",
                "count.disabled": "已停用",
                "misc.registryOff": "当前 profile 未启用 skill 注册表，只显示本地个人技能",
                "misc.incomplete": "技能目录读取不完整，列表可能缺少条目",
            },
            en: {
                "panel.title": "Skills",
                "page.title": "Skill Center",
                "page.subtitle": "Official skills are read-only. Personal skills live in your skills directory and can be installed, edited, disabled or removed.",
                "page.refresh": "Refresh",
                "page.import": "Import skill",
                "page.create": "New skill",
                "page.openFolder": "Open folder",
                "page.search": "Search by name or description…",
                "page.dropHint": "Release to import the ZIP (≤12MB, may contain several skills)",
                "page.dragHint": "Drag & drop: drop a ZIP onto this page to import",
                "tab.all": "All",
                "tab.official": "Official",
                "tab.personal": "Mine",
                "tab.other": "Other sources",
                "tab.disabled": "Disabled",
                "empty.all": "No skills yet",
                "empty.official": "No official skills",
                "empty.personal": "No personal skills yet — create one or import a folder",
                "empty.other": "No skills from other sources",
                "empty.disabled": "No disabled skills",
                "badge.official": "Official",
                "badge.personal": "Mine",
                "badge.other": "Other",
                "badge.disabled": "Disabled",
                "badge.model": "Model-invocable",
                "badge.user": "User-invocable",
                "badge.modelOnly": "Model only",
                "badge.userOnly": "User only",
                "row.preview": "Preview",
                "row.edit": "Edit",
                "row.disable": "Disable",
                "row.enable": "Enable",
                "row.remove": "Remove",
                "row.invalid": "Invalid",
                "detail.title": "Skill detail",
                "detail.close": "Close",
                "detail.save": "Save",
                "detail.cancel": "Cancel",
                "detail.readonly": "Official/other-source skills are read-only",
                "detail.placeholder": "SKILL.md content",
                "create.title": "New personal skill",
                "create.name": "Name (kebab-case)",
                "create.nameHint": "Lowercase letters, digits and hyphens, e.g. my-workflow",
                "create.description": "Description (required; the model uses it to decide when to load)",
                "create.when": "When to use (optional)",
                "create.content": "SKILL.md body (optional; a template is generated when empty)",
                "create.submit": "Create",
                "import.title": "Import skill (ZIP or local path)",
                "import.hint": "Choose a ZIP (may contain several skills; TRAE/WorkBuddy exports supported), drop a ZIP onto this page, or paste a local folder/.md path.",
                "import.path": "Local folder or .md path (paste allowed)",
                "import.zipChoose": "Choose ZIP file…",
                "import.zipSelected": "Selected ZIP: ",
                "import.zipRemove": "Remove",
                "import.zipTooBig": "ZIP must be ≤ 12MB",
                "import.zipOnly": "Only .zip files can be dropped",
                "import.fileTooBig": "File exceeds 4MB: ",
                "import.readFailed": "Failed to read file: ",
                "import.zipFailed": "Some skills failed to import: ",
                "import.submit": "Import",
                "import.overwrite": "Overwrite existing personal skill",
                "import.shadow": "Allow shadowing an official skill with the same name",
                "confirm.delete.title": "Remove skill?",
                "confirm.delete.message": "The skill is moved to the trash ($DSH_HOME/skill-center/trash) and can be restored manually.",
                "confirm.disable.title": "Disable skill?",
                "confirm.disable.message": "Disabled skills disappear from the model catalog and the picker; you can enable them again later.",
                "confirm.ok": "Confirm",
                "confirm.cancel": "Cancel",
                "err.prefix": "Operation failed: ",
                "err.load": "Failed to load skills: ",
                "toast.created": "Skill created",
                "toast.imported": "Skill imported",
                "toast.saved": "Saved",
                "toast.disabled": "Disabled",
                "toast.enabled": "Enabled",
                "toast.removed": "Moved to trash",
                "picker.button": "Skills",
                "picker.title": "Pick a skill to use",
                "picker.search": "Search skills…",
                "picker.empty": "No insertable skills",
                "picker.emptyHint": "Create or import personal skills in the Skill Center",
                "picker.manage": "Manage skills…",
                "picker.noInput": "Composer is not available (open a session first)",
                "picker.inserted": "Inserted",
                "picker.onlyModel": "Model-only skill; cannot insert /name",
                "picker.loading": "Loading…",
                "count.personal": "Mine",
                "count.official": "Official",
                "count.disabled": "Disabled",
                "misc.registryOff": "The skill registry is not enabled in this profile; showing local personal skills only",
                "misc.incomplete": "Skill discovery was incomplete; some entries may be missing",
            },
        };

        function detectLang() {
            var lang = document.documentElement && document.documentElement.lang;
            if (lang && String(lang).toLowerCase().indexOf('en') === 0) return 'en';
            if (lang && String(lang).toLowerCase().indexOf('zh') === 0) return 'zh';
            return 'zh';
        }
        function t(key) {
            var lang = detectLang();
            var dict = DICT[lang] || DICT.zh;
            if (dict[key] !== undefined) return dict[key];
            return DICT.zh[key] !== undefined ? DICT.zh[key] : key;
        }
        /** 语言切换时强制重渲染。 */
        function useLangTick() {
            var state = react.useState(0);
            var setTick = state[1];
            react.useEffect(function () {
                function onChange() { setTick(function (x) { return x + 1; }); }
                document.addEventListener('dsh-i18n-change', onChange);
                return function () { document.removeEventListener('dsh-i18n-change', onChange); };
            }, []);
        }

        // ------------------------------------------------------------------
        // 样式（主题 token 为主，失败时回退深色/浅色中性色；类名 dsc- 前缀）
        // ------------------------------------------------------------------
        var CSS = [
            '.dsc-page{position:relative;display:flex;flex-direction:column;gap:12px;padding:16px 18px 18px;height:100%;min-height:420px;box-sizing:border-box;overflow:hidden;color:var(--dsw-alias-label-primary,#e6e6e6);}',
            '.dsc-head{display:flex;flex-wrap:wrap;align-items:center;gap:10px;}',
            '.dsc-title{font-size:17px;font-weight:600;margin:0;}',
            '.dsc-sub{flex-basis:100%;margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary,#9aa0aa);}',
            '.dsc-spacer{flex:1;}',
            '.dsc-btn{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));background:var(--dsw-alias-bg-layer-1,#1c1c22);color:var(--dsw-alias-label-primary,#e6e6e6);border-radius:8px;padding:5px 10px;font-size:12.5px;font-family:inherit;cursor:pointer;white-space:nowrap;}',
            '.dsc-btn:hover{background:var(--dsw-alias-bg-layer-2,#232329);}',
            '.dsc-btn:disabled{opacity:.45;cursor:not-allowed;}',
            '.dsc-btn-primary{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#6f87ff);}',
            '.dsc-btn-danger{border-color:var(--dsw-alias-state-error-primary,#c0392b);color:var(--dsw-alias-state-error-primary,#e05a4a);}',
            '.dsc-btn-sm{padding:3px 8px;font-size:12px;border-radius:6px;}',
            '.dsc-input,.dsc-textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));background:var(--dsw-alias-bg-base,#141419);color:var(--dsw-alias-label-primary,#e6e6e6);border-radius:8px;padding:7px 9px;font-size:13px;font-family:inherit;outline:none;}',
            '.dsc-input:focus,.dsc-textarea:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe);}',
            '.dsc-textarea{resize:vertical;min-height:160px;line-height:1.65;font-family:Consolas,Menlo,monospace;font-size:12.5px;}',
            '.dsc-tabs{display:flex;flex-wrap:wrap;gap:6px;}',
            '.dsc-tab{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0aa);border-radius:999px;padding:3px 11px;font-size:12.5px;cursor:pointer;font-family:inherit;}',
            '.dsc-tab:hover{color:var(--dsw-alias-label-primary,#e6e6e6);}',
            '.dsc-tab-on{color:var(--dsw-alias-brand-primary,#6f87ff);border-color:var(--dsw-alias-brand-primary,#4d6bfe);background:rgba(77,107,254,.10);}',
            '.dsc-searchrow{display:flex;gap:8px;align-items:center;}',
            '.dsc-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:6px;padding-right:2px;}',
            '.dsc-row{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.10));background:var(--dsw-alias-bg-layer-1,#1a1a20);border-radius:10px;padding:9px 11px;}',
            '.dsc-row-main{flex:1;min-width:0;cursor:pointer;}',
            '.dsc-row-name{font-size:13.5px;font-weight:600;margin:0 0 2px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;}',
            '.dsc-row-desc{font-size:12.5px;color:var(--dsw-alias-label-secondary,#9aa0aa);margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '.dsc-row-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary,#8a9099);margin-top:3px;display:flex;gap:10px;flex-wrap:wrap;}',
            '.dsc-row-actions{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end;}',
            '.dsc-badge{display:inline-flex;align-items:center;border-radius:999px;padding:0 7px;font-size:11px;line-height:17px;border:1px solid transparent;white-space:nowrap;}',
            '.dsc-badge-official{color:var(--dsw-alias-brand-primary,#6f87ff);border-color:rgba(77,107,254,.45);background:rgba(77,107,254,.10);}',
            '.dsc-badge-personal{color:var(--dsw-alias-state-success-primary,#3ecf8e);border-color:rgba(62,207,142,.40);background:rgba(62,207,142,.08);}',
            '.dsc-badge-other{color:var(--dsw-alias-state-warn-primary,#e0a33e);border-color:rgba(224,163,62,.40);background:rgba(224,163,62,.08);}',
            '.dsc-badge-disabled{color:var(--dsw-alias-state-idle-primary,#8a9099);border-color:rgba(138,144,153,.35);}',
            '.dsc-badge-soft{color:var(--dsw-alias-label-secondary,#9aa0aa);border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.14));}',
            '.dsc-badge-invalid{color:var(--dsw-alias-state-error-primary,#e05a4a);border-color:rgba(224,90,74,.45);}',
            '.dsc-empty{flex:1;display:flex;flex-direction:column;gap:6px;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary,#8a9099);font-size:13px;text-align:center;padding:24px;}',
            '.dsc-alert{border:1px solid var(--dsw-alias-state-error-primary,#c0392b);color:var(--dsw-alias-state-error-primary,#e05a4a);background:rgba(192,57,43,.08);border-radius:8px;padding:7px 10px;font-size:12.5px;display:flex;gap:8px;align-items:flex-start;}',
            '.dsc-notice{border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));color:var(--dsw-alias-label-secondary,#9aa0aa);background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.04));border-radius:8px;padding:6px 10px;font-size:12px;}',
            '.dsc-drawer{position:absolute;top:12px;right:12px;bottom:12px;width:min(460px,72%);display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.2));background:var(--dsw-alias-bg-overlay,#1b1b22);border-radius:12px;padding:12px;box-shadow:0 12px 32px rgba(0,0,0,.35);z-index:5;}',
            '.dsc-drawer-head{display:flex;align-items:center;gap:8px;}',
            '.dsc-drawer-title{font-size:14px;font-weight:600;margin:0;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '.dsc-drawer-body{flex:1;min-height:0;overflow:auto;}',
            '.dsc-pre{margin:0;white-space:pre-wrap;word-break:break-word;font-family:Consolas,Menlo,monospace;font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-primary,#e6e6e6);}',
            '.dsc-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:60;}',
            '.dsc-modal{width:min(560px,92vw);max-height:86vh;overflow:auto;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.2));background:var(--dsw-alias-bg-overlay,#1b1b22);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary,#e6e6e6);box-shadow:0 16px 40px rgba(0,0,0,.4);}',
            '.dsc-modal h3{font-size:15px;margin:0;}',
            '.dsc-field{display:flex;flex-direction:column;gap:4px;font-size:12.5px;}',
            '.dsc-field-label{color:var(--dsw-alias-label-secondary,#9aa0aa);}',
            '.dsc-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary,#8a9099);}',
            '.dsc-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px;}',
            '.dsc-check{display:flex;gap:7px;align-items:center;font-size:12.5px;color:var(--dsw-alias-label-secondary,#9aa0aa);}',
            '.dsc-toast{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.16));background:var(--dsw-alias-bg-overlay,#1b1b22);color:var(--dsw-alias-label-primary,#e6e6e6);border-radius:999px;padding:5px 14px;font-size:12px;box-shadow:0 8px 24px rgba(0,0,0,.3);z-index:8;}',
            '.dsc-picker{position:relative;display:inline-flex;}',
            '.dsc-picker-btn{display:inline-flex;align-items:center;gap:4px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,#9aa0aa);border-radius:8px;padding:4px 7px;font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap;}',
            '.dsc-picker-btn:hover,.dsc-picker-btn-on{color:var(--dsw-alias-brand-primary,#6f87ff);background:rgba(77,107,254,.08);}',
            '.dsc-picker-count{font-size:10.5px;border-radius:999px;padding:0 5px;line-height:15px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.14));}',
            '.dsc-pop{position:absolute;bottom:calc(100% + 8px);left:0;width:min(360px,86vw);max-height:min(60vh,420px);display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.2));background:var(--dsw-alias-bg-overlay,#1b1b22);border-radius:12px;padding:10px;box-shadow:0 14px 36px rgba(0,0,0,.4);z-index:70;}',
            '.dsc-pop-head{display:flex;align-items:center;gap:8px;}',
            '.dsc-pop-title{font-size:12.5px;font-weight:600;flex:1;}',
            '.dsc-pop-list{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:2px;}',
            '.dsc-pop-group{font-size:11px;color:var(--dsw-alias-label-secondary,#8a9099);padding:6px 6px 2px;}',
            '.dsc-pop-item{display:flex;flex-direction:column;gap:1px;border:1px solid transparent;border-radius:8px;padding:5px 8px;cursor:pointer;background:transparent;text-align:left;font-family:inherit;color:inherit;}',
            '.dsc-pop-item:hover{background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));}',
            '.dsc-pop-item:disabled{opacity:.45;cursor:not-allowed;}',
            '.dsc-pop-item-name{font-size:12.5px;color:var(--dsw-alias-label-primary,#e6e6e6);display:flex;gap:6px;align-items:center;}',
            '.dsc-pop-item-desc{font-size:11.5px;color:var(--dsw-alias-label-secondary,#8a9099);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
            '.dsc-pop-foot{display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.10));padding-top:7px;}',
            '.dsc-pop-hint{font-size:11px;color:var(--dsw-alias-label-secondary,#8a9099);}',
            '.dsc-page.dsc-dropping{outline:2px dashed var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:-6px;border-radius:10px;}',
            '.dsc-drop-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:rgba(20,30,60,.55);border-radius:10px;z-index:9;pointer-events:none;}',
            '.dsc-drop-title{font-size:16px;font-weight:600;color:var(--dsw-alias-brand-primary,#6f87ff);}',
            '.dsc-file-row{display:flex;align-items:center;gap:8px;border:1px dashed var(--dsw-alias-border-l1,rgba(255,255,255,.16));border-radius:8px;padding:6px 9px;font-size:12.5px;}',
            '.dsc-file-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#9aa0aa);}',
        ].join('\n');

        // ------------------------------------------------------------------
        // 宿主路由请求
        // ------------------------------------------------------------------
        var API_BASE = '/__dsh/skill-center';
        function api(route, body) {
            var init = { method: body === undefined ? 'GET' : 'POST', headers: {} };
            if (body !== undefined) {
                init.headers['content-type'] = 'application/json';
                init.body = JSON.stringify(body);
            }
            return fetch(API_BASE + route, init).then(function (response) {
                return response.json().catch(function () { return null; }).then(function (payload) {
                    if (!payload || payload.ok !== true) {
                        var error = new Error((payload && payload.message) || ('HTTP ' + response.status));
                        error.code = payload && payload.code;
                        throw error;
                    }
                    return payload;
                });
            });
        }

        // ------------------------------------------------------------------
        // 图标
        // ------------------------------------------------------------------
        function svgIcon(size, children) {
            return h('svg', {
                width: size || 14, height: size || 14, viewBox: '0 0 24 24', fill: 'none',
                stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round',
                'aria-hidden': 'true',
            }, children);
        }
        function IconSkill(props) {
            var s = props && props.size ? props.size : 14;
            return svgIcon(s, [
                h('path', { key: 'a', d: 'M12 3 2.5 8 12 13l9.5-5L12 3Z' }),
                h('path', { key: 'b', d: 'M5 10.5V16c0 1.5 3.1 3 7 3s7-1.5 7-3v-5.5' }),
            ]);
        }
        function IconPlus() { return svgIcon(13, [h('path', { key: 'a', d: 'M12 5v14M5 12h14' })]); }
        function IconRefresh() { return svgIcon(13, [h('path', { key: 'a', d: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5' })]); }
        function IconFolder() { return svgIcon(13, [h('path', { key: 'a', d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z' })]); }
        function IconTrash() { return svgIcon(13, [h('path', { key: 'a', d: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13' })]); }
        function IconPower() { return svgIcon(13, [h('path', { key: 'a', d: 'M12 4v7' }), h('path', { key: 'b', d: 'M7 7a7 7 0 1 0 10 0' })]); }
        function IconClose() { return svgIcon(13, [h('path', { key: 'a', d: 'M6 6l12 12M18 6 6 18' })]); }
        function IconSearch() { return svgIcon(13, [h('circle', { key: 'a', cx: 11, cy: 11, r: 6 }), h('path', { key: 'b', d: 'm20 20-3.2-3.2' })]); }
        function IconArchive() { return svgIcon(13, [h('path', { key: 'a', d: 'M4 7h16v13H4z' }), h('path', { key: 'b', d: 'M2 3h20v4H2z' }), h('path', { key: 'c', d: 'M10 12h4' })]); }

        // ------------------------------------------------------------------
        // 通用小部件
        // ------------------------------------------------------------------
        function Badge(props) {
            var cls = 'dsc-badge ' + (props.kind ? 'dsc-badge-' + props.kind : 'dsc-badge-soft');
            return h('span', { className: cls }, props.children);
        }
        function ErrorBar(props) {
            if (!props.message) return null;
            return h('div', { className: 'dsc-alert', role: 'alert' }, [
                h('span', { key: 't', style: { flex: 1, wordBreak: 'break-word' } }, t('err.prefix') + props.message),
                h('button', { key: 'x', type: 'button', className: 'dsc-btn dsc-btn-sm', onClick: props.onDismiss || function () {} }, t('detail.close')),
            ]);
        }
        function Modal(props) {
            return h('div', { className: 'dsc-modal-mask', onMouseDown: function (event) { if (event.target === event.currentTarget && !props.busy) props.onCancel(); } }, [
                h('div', { key: 'm', className: 'dsc-modal', role: 'dialog', 'aria-modal': 'true' }, props.children),
            ]);
        }
        function ConfirmDialog(props) {
            return h(Modal, { onCancel: props.onCancel, busy: props.busy }, [
                h('h3', { key: 't' }, props.title),
                h('div', { key: 'm', style: { fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary,#9aa0aa)', lineHeight: 1.7 } }, props.message),
                h('div', { key: 'a', className: 'dsc-modal-actions' }, [
                    h('button', { key: 'c', type: 'button', className: 'dsc-btn', onClick: props.onCancel, disabled: props.busy }, t('confirm.cancel')),
                    h('button', { key: 'o', type: 'button', className: 'dsc-btn ' + (props.danger ? 'dsc-btn-danger' : 'dsc-btn-primary'), onClick: props.onConfirm, disabled: props.busy }, t('confirm.ok')),
                ]),
            ]);
        }
        function useEscClose(onClose) {
            react.useEffect(function () {
                function onKey(event) { if (event.key === 'Escape') onClose(); }
                document.addEventListener('keydown', onKey);
                return function () { document.removeEventListener('keydown', onKey); };
            }, []);
        }
        function field(labelText, control, hint) {
            return h('div', { className: 'dsc-field' }, [
                h('span', { key: 'l', className: 'dsc-field-label' }, labelText),
                control,
                hint ? h('span', { key: 'h', className: 'dsc-hint' }, hint) : null,
            ]);
        }

        // ------------------------------------------------------------------
        // 新建技能
        // ------------------------------------------------------------------
        function CreateDialog(props) {
            useLangTick();
            useEscClose(props.onCancel);
            var s1 = react.useState('');
            var s2 = react.useState('');
            var s3 = react.useState('');
            var s4 = react.useState('');
            var name = s1[0]; var setName = s1[1];
            var description = s2[0]; var setDescription = s2[1];
            var whenToUse = s3[0]; var setWhenToUse = s3[1];
            var content = s4[0]; var setContent = s4[1];
            var canSubmit = name.trim() && description.trim() && !props.busy;
            function submit() {
                if (!canSubmit) return;
                props.onCreate({ name: name.trim(), description: description.trim(), whenToUse: whenToUse.trim(), content: content });
            }
            return h(Modal, { onCancel: props.onCancel, busy: props.busy }, [
                h('h3', { key: 't' }, t('create.title')),
                field(t('create.name'), h('input', {
                    key: 'n', className: 'dsc-input', value: name, placeholder: 'my-workflow',
                    autoFocus: true,
                    onChange: function (event) { setName(event.target.value); },
                }), t('create.nameHint')),
                field(t('create.description'), h('input', {
                    key: 'd', className: 'dsc-input', value: description,
                    onChange: function (event) { setDescription(event.target.value); },
                })),
                field(t('create.when'), h('input', {
                    key: 'w', className: 'dsc-input', value: whenToUse,
                    onChange: function (event) { setWhenToUse(event.target.value); },
                })),
                field(t('create.content'), h('textarea', {
                    key: 'c', className: 'dsc-textarea', value: content,
                    placeholder: '# ' + (name || 'my-skill') + '\n\n...',
                    onChange: function (event) { setContent(event.target.value); },
                })),
                props.error ? h(ErrorBar, { key: 'e', message: props.error }) : null,
                h('div', { key: 'a', className: 'dsc-modal-actions' }, [
                    h('button', { key: 'c', type: 'button', className: 'dsc-btn', onClick: props.onCancel, disabled: props.busy }, t('confirm.cancel')),
                    h('button', { key: 's', type: 'button', className: 'dsc-btn dsc-btn-primary', onClick: submit, disabled: !canSubmit }, props.busy ? '…' : t('create.submit')),
                ]),
            ]);
        }

        // ------------------------------------------------------------------
        // 导入技能（文件夹 / ZIP）
        // ------------------------------------------------------------------
        /** 读取浏览器 File 为 base64（ZIP ≤12MB，分块避免超长参数）。 */
        function fileToBase64(file) {
            return new Promise(function (resolveFile, rejectFile) {
                if (!file) { rejectFile(new Error('no file')); return; }
                if (file.size > 12 * 1024 * 1024) { rejectFile(new Error(t('import.zipTooBig'))); return; }
                var reader = new FileReader();
                reader.onerror = function () { rejectFile(new Error('读取 ZIP 失败')); };
                reader.onload = function () {
                    try {
                        var bytes = new Uint8Array(reader.result);
                        var chunkSize = 0x8000;
                        var parts = [];
                        for (var i = 0; i < bytes.length; i += chunkSize) {
                            parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
                        }
                        resolveFile(btoa(parts.join('')));
                    } catch (error) {
                        rejectFile(error);
                    }
                };
                reader.readAsArrayBuffer(file);
            });
        }

        /** 读取浏览器 File 为 base64（通用；maxBytes 控制单文件上限）。 */
        function readFileBase64(file, maxBytes) {
            return new Promise(function (resolveFile, rejectFile) {
                if (!file) { rejectFile(new Error('missing file')); return; }
                if (maxBytes && file.size > maxBytes) { rejectFile(new Error(t('import.fileTooBig') + ' ' + file.name)); return; }
                var reader = new FileReader();
                reader.onerror = function () { rejectFile(new Error(t('import.readFailed') + ' ' + file.name)); };
                reader.onload = function () {
                    try {
                        var bytes = new Uint8Array(reader.result);
                        var chunkSize = 0x8000;
                        var parts = [];
                        for (var i = 0; i < bytes.length; i += chunkSize) {
                            parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize)));
                        }
                        resolveFile(btoa(parts.join('')));
                    } catch (error) {
                        rejectFile(error);
                    }
                };
                reader.readAsArrayBuffer(file);
            });
        }

        function ImportDialog(props) {
            useLangTick();
            useEscClose(props.onCancel);
            var s1 = react.useState('');
            var path = s1[0]; var setPath = s1[1];
            var s2 = react.useState(false);
            var overwrite = s2[0]; var setOverwrite = s2[1];
            var s3 = react.useState(false);
            var allowShadow = s3[0]; var setAllowShadow = s3[1];
            var s4 = react.useState(props.initialZip || null);
            var zip = s4[0]; var setZip = s4[1];
            react.useEffect(function () {
                if (props.initialZip && props.initialZip.name) setZip(props.initialZip);
            }, [props.initialZip && props.initialZip.name]);
            var s5 = react.useState('');
            var zipError = s5[0]; var setZipError = s5[1];
            var fileRef = react.useRef(null);
            function chooseZip() {
                if (fileRef.current) fileRef.current.click();
            }
            function onZipFile(event) {
                var file = event.target.files && event.target.files[0];
                try { event.target.value = ''; } catch (error) { /* 忽略 */ }
                if (!file) return;
                setZipError('');
                setZip(null);
                fileToBase64(file).then(function (dataBase64) {
                    setZip({ name: file.name, dataBase64: dataBase64 });
                }).catch(function (error) {
                    setZipError((error && error.message) || String(error));
                });
            }
            var canSubmit = !!(zip || path.trim());
            function submit() {
                if (!canSubmit || props.busy) return;
                if (zip) {
                    props.onImportZip({ dataBase64: zip.dataBase64, filename: zip.name, overwrite: overwrite, allowShadow: allowShadow });
                } else {
                    props.onImport({ path: path.trim(), overwrite: overwrite, allowShadow: allowShadow });
                }
            }
            return h(Modal, { onCancel: props.onCancel, busy: props.busy }, [
                h('h3', { key: 't' }, t('import.title')),
                h('p', { key: 'h', className: 'dsc-hint', style: { lineHeight: 1.7 } }, t('import.hint')),
                h('div', { key: 'c', style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } }, [
                    h('button', { key: 'z', type: 'button', className: 'dsc-btn', onClick: chooseZip, disabled: props.busy || !!zip }, [
                        h(IconArchive, { key: 'i' }), t('import.zipChoose'),
                    ]),
                ]),
                h('input', {
                    key: 'zip-input', type: 'file', ref: fileRef, accept: '.zip,application/zip',
                    style: { display: 'none' }, onChange: onZipFile,
                }),
                zip ? h('div', { key: 'zr', className: 'dsc-file-row' }, [
                    h('span', { key: 'n', className: 'dsc-file-name', title: zip.name }, t('import.zipSelected') + zip.name),
                    h('button', {
                        key: 'x', type: 'button', className: 'dsc-btn dsc-btn-sm', disabled: props.busy,
                        onClick: function () { setZip(null); },
                    }, t('import.zipRemove')),
                ]) : null,
                zipError ? h(ErrorBar, { key: 'ze', message: zipError }) : null,
                h('label', { key: 'p', className: 'dsc-check' }, [
                    h('span', { key: 'l', className: 'dsc-hint', style: { marginRight: 6 } }, t('import.path')),
                    h('input', {
                        key: 'i', className: 'dsc-input', value: path, style: { flex: 1, minWidth: 160 },
                        onChange: function (event) { setPath(event.target.value); },
                    }),
                ]),
                h('label', { key: 'o', className: 'dsc-check' }, [
                    h('input', { type: 'checkbox', checked: overwrite, onChange: function (event) { setOverwrite(event.target.checked); } }),
                    t('import.overwrite'),
                ]),
                h('label', { key: 's', className: 'dsc-check' }, [
                    h('input', { type: 'checkbox', checked: allowShadow, onChange: function (event) { setAllowShadow(event.target.checked); } }),
                    t('import.shadow'),
                ]),
                props.error ? h(ErrorBar, { key: 'e', message: props.error }) : null,
                h('div', { key: 'a', className: 'dsc-modal-actions' }, [
                    h('button', { key: 'c', type: 'button', className: 'dsc-btn', onClick: props.onCancel, disabled: props.busy }, t('confirm.cancel')),
                    h('button', {
                        key: 'i', type: 'button', className: 'dsc-btn dsc-btn-primary', disabled: props.busy || !canSubmit,
                        onClick: submit,
                    }, props.busy ? '…' : t('import.submit')),
                ]),
            ]);
        }

        // ------------------------------------------------------------------
        // 右侧详情抽屉
        // ------------------------------------------------------------------
        function SkillDetail(props) {
            useLangTick();
            var s1 = react.useState(null);
            var draft = s1[0]; var setDraft = s1[1];
            var editable = props.group === 'personal';
            react.useEffect(function () { setDraft(props.content || ''); }, [props.name, props.content]);
            if (!props.open) return null;
            return h('div', { className: 'dsc-drawer', role: 'dialog', 'aria-label': t('detail.title') }, [
                h('div', { key: 'h', className: 'dsc-drawer-head' }, [
                    h('h3', { key: 't', className: 'dsc-drawer-title', title: props.name }, props.name),
                    h('button', { key: 'c', type: 'button', className: 'dsc-btn dsc-btn-sm', onClick: props.onClose }, [h(IconClose, { key: 'i' }), t('detail.close')]),
                ]),
                h('div', { key: 'b', className: 'dsc-drawer-body' }, props.loading
                    ? h('div', { className: 'dsc-hint' }, '…')
                    : editable
                        ? h('textarea', {
                            className: 'dsc-textarea', style: { minHeight: '100%', height: '100%', boxSizing: 'border-box' },
                            value: draft === null ? '' : draft,
                            onChange: function (event) { setDraft(event.target.value); },
                        })
                        : h('pre', { className: 'dsc-pre' }, props.content || '')),
                h('div', { key: 'a', className: 'dsc-drawer-head', style: { justifyContent: 'flex-end' } }, [
                    editable
                        ? h('button', {
                            key: 's', type: 'button', className: 'dsc-btn dsc-btn-primary', disabled: props.saving,
                            onClick: function () { props.onSave(draft === null ? '' : draft); },
                        }, props.saving ? '…' : t('detail.save'))
                        : h('span', { key: 'r', className: 'dsc-hint' }, t('detail.readonly')),
                ]),
                props.error ? h(ErrorBar, { key: 'e', message: props.error }) : null,
            ]);
        }

        // ------------------------------------------------------------------
        // 技能中心页
        // ------------------------------------------------------------------
        function SkillCenterPage() {
            useLangTick();
            var s1 = react.useState({ loading: true, data: null });
            var state = s1[0]; var setState = s1[1];
            var s2 = react.useState('all');
            var tab = s2[0]; var setTab = s2[1];
            var s3 = react.useState('');
            var query = s3[0]; var setQuery = s3[1];
            var s4 = react.useState(null);
            var detail = s4[0]; var setDetail = s4[1];
            var s5 = react.useState(null);
            var dialog = s5[0]; var setDialog = s5[1];
            var s6 = react.useState('');
            var dialogError = s6[0]; var setDialogError = s6[1];
            var s7 = react.useState(false);
            var busy = s7[0]; var setBusy = s7[1];
            var s8 = react.useState('');
            var toast = s8[0]; var setToast = s8[1];
            var s9 = react.useState('');
            var loadError = s9[0]; var setLoadError = s9[1];
            var s10 = react.useState(null);
            var confirm = s10[0]; var setConfirm = s10[1];
            var s11 = react.useState(null);
            var dragZip = s11[0]; var setDragZip = s11[1];
            var s12 = react.useState(false);
            var dragging = s12[0]; var setDragging = s12[1];

            function currentSessionId() {
                try {
                    var sessions = (pluginCtx && pluginCtx.sessions) || (pluginCtx && pluginCtx.get ? pluginCtx.get('sessions') : null);
                    if (sessions && sessions.list && typeof sessions.list.getSnapshot === 'function') {
                        var snapshot = sessions.list.getSnapshot();
                        return (snapshot && (snapshot.current || snapshot.sessionId)) || '';
                    }
                } catch (error) { /* 忽略 */ }
                return '';
            }

            function load(showSpinner) {
                if (showSpinner !== false) setState(function (prev) { return { loading: true, data: prev.data }; });
                var queryString = currentSessionId() ? ('?sessionId=' + encodeURIComponent(currentSessionId())) : '';
                api('/list' + queryString).then(function (payload) {
                    setState({ loading: false, data: payload });
                    setLoadError('');
                }).catch(function (error) {
                    setState(function (prev) { return { loading: false, data: prev.data }; });
                    setLoadError(t('err.load') + (error && error.message ? error.message : String(error)));
                });
            }
            react.useEffect(function () { load(true); }, []);
            react.useEffect(function () {
                if (!toast) return undefined;
                var timer = setTimeout(function () { setToast(''); }, 2400);
                return function () { clearTimeout(timer); };
            }, [toast]);

            var data = state.data;
            var personal = data ? data.personal || [] : [];
            var official = data ? data.official || [] : [];
            var other = data ? data.other || [] : [];
            var disabled = data ? data.disabled || [] : [];
            var filters = [
                { id: 'all', label: t('tab.all'), count: personal.length + official.length + other.length },
                { id: 'official', label: t('tab.official'), count: official.length },
                { id: 'personal', label: t('tab.personal'), count: personal.length },
                { id: 'other', label: t('tab.other'), count: other.length },
                { id: 'disabled', label: t('tab.disabled'), count: disabled.length },
            ];
            var rows = [];
            if (tab === 'all') {
                rows = personal.map(function (item) { return { group: 'personal', item: item }; })
                    .concat(official.map(function (item) { return { group: 'official', item: item }; }))
                    .concat(other.map(function (item) { return { group: 'other', item: item }; }));
            } else if (tab === 'personal') {
                rows = personal.map(function (item) { return { group: 'personal', item: item }; });
            } else if (tab === 'official') {
                rows = official.map(function (item) { return { group: 'official', item: item }; });
            } else if (tab === 'other') {
                rows = other.map(function (item) { return { group: 'other', item: item }; });
            } else if (tab === 'disabled') {
                rows = disabled.map(function (item) { return { group: 'disabled', item: item }; });
            }
            var keyword = query.trim().toLowerCase();
            if (keyword) {
                rows = rows.filter(function (row) {
                    var item = row.item;
                    return (item.name || '').toLowerCase().indexOf(keyword) >= 0
                        || (item.description || '').toLowerCase().indexOf(keyword) >= 0;
                });
            }

            function openDetail(group, item) {
                setDetail({ group: group, name: item.name, content: '', loading: true, error: '', saving: false });
                api('/read', { name: item.name, group: group, sessionId: currentSessionId() }).then(function (payload) {
                    setDetail(function (prev) {
                        if (!prev || prev.name !== item.name || prev.group !== group) return prev;
                        return { group: group, name: item.name, content: payload.content || '', loading: false, error: '', saving: false };
                    });
                }).catch(function (error) {
                    setDetail(function (prev) {
                        if (!prev) return prev;
                        return { group: group, name: item.name, content: prev.content, loading: false, error: error && error.message ? error.message : String(error), saving: false };
                    });
                });
            }

            function runAction(label, promise) {
                setBusy(true);
                promise.then(function (result) {
                    setBusy(false);
                    setDialog(null);
                    setConfirm(null);
                    setDialogError('');
                    if (label) setToast(label);
                    load(false);
                    return result;
                }).catch(function (error) {
                    setBusy(false);
                    var message = error && error.message ? error.message : String(error);
                    if (dialog) setDialogError(message);
                    else setLoadError(t('err.prefix') + message);
                });
            }

            function saveContent(text) {
                if (!detail) return;
                setDetail(function (prev) { return prev ? Object.assign({}, prev, { saving: true, error: '' }) : prev; });
                api('/save', { name: detail.name, content: text }).then(function () {
                    setDetail(function (prev) { return prev ? Object.assign({}, prev, { content: text, saving: false, error: '' }) : prev; });
                    setToast(t('toast.saved'));
                    load(false);
                }).catch(function (error) {
                    setDetail(function (prev) { return prev ? Object.assign({}, prev, { saving: false, error: error && error.message ? error.message : String(error) }) : prev; });
                });
            }

            function handleDrop(dataTransfer) {
                var files = dataTransfer && dataTransfer.files ? Array.prototype.slice.call(dataTransfer.files) : [];
                if (files.length === 0) { setLoadError(t('import.zipOnly')); return; }
                var zipFile = null;
                for (var j = 0; j < files.length; j += 1) {
                    if (/\.zip$/i.test(files[j].name)) { zipFile = files[j]; break; }
                }
                if (!zipFile) { setLoadError(t('import.zipOnly')); return; }
                readFileBase64(zipFile, 12 * 1024 * 1024).then(function (dataBase64) {
                    setDragZip({ name: zipFile.name, dataBase64: dataBase64 });
                    setDialogError('');
                    setDialog('import');
                }).catch(function (error) {
                    setLoadError(t('err.prefix') + ((error && error.message) || String(error)));
                });
            }
            var dragDepth = react.useRef(0);
            react.useEffect(function () {
                function hasFiles(event) {
                    var types = (event && event.dataTransfer && event.dataTransfer.types) || [];
                    for (var i = 0; i < types.length; i += 1) {
                        if (types[i] === 'Files') return true;
                    }
                    return false;
                }
                function onOver(event) {
                    if (!hasFiles(event)) return;
                    event.preventDefault();
                    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
                    dragDepth.current += 1;
                    if (dragDepth.current === 1) setDragging(true);
                }
                function onLeave(event) {
                    if (event && event.relatedTarget) return;
                    dragDepth.current = 0;
                    setDragging(false);
                }
                function onDrop(event) {
                    if (!hasFiles(event)) return;
                    event.preventDefault();
                    dragDepth.current = 0;
                    setDragging(false);
                    handleDrop(event.dataTransfer);
                }
                document.addEventListener('dragover', onOver);
                document.addEventListener('dragleave', onLeave);
                document.addEventListener('drop', onDrop);
                return function cleanup() {
                    document.removeEventListener('dragover', onOver);
                    document.removeEventListener('dragleave', onLeave);
                    document.removeEventListener('drop', onDrop);
                };
            }, []);

            function doCreate(form) {
                runAction(t('toast.created'), api('/create', form));
            }
            function doImport(form) {
                runAction(t('toast.imported'), api('/install-folder', form));
            }
            /** ZIP 导入：支持一次导入多个技能，逐项汇报成功/失败。 */
            function doImportZip(form) {
                setBusy(true);
                api('/import-zip', form).then(function (result) {
                    setBusy(false);
                    setDialog(null);
                    setDialogError('');
                    setDragZip(null);
                    var imported = result.imported || [];
                    var failed = result.failed || [];
                    if (imported.length) setToast(t('toast.imported') + ' ×' + imported.length);
                    if (failed.length) {
                        var lines = failed.slice(0, 5).map(function (item) {
                            return (item.source || '') + ' → ' + item.code + ' ' + item.message;
                        });
                        if (failed.length > 5) lines.push('…');
                        setLoadError(t('import.zipFailed') + lines.join('；'));
                    }
                    load(false);
                }).catch(function (error) {
                    setBusy(false);
                    setDialogError(error && error.message ? error.message : String(error));
                });
            }
            var content = h('div', { className: 'dsc-page' + (dragging ? ' dsc-dropping' : '') }, [
                dragging ? h('div', { key: 'drop-overlay', className: 'dsc-drop-overlay' }, [
                    h('div', { key: 't', className: 'dsc-drop-title' }, t('import.title')),
                    h('div', { key: 'h', className: 'dsc-hint' }, t('page.dropHint')),
                ]) : null,
                h('div', { key: 'head', className: 'dsc-head' }, [
                    h('h2', { key: 't', className: 'dsc-title' }, t('page.title')),
                    h('div', { key: 's', className: 'dsc-spacer' }),
                    h('button', { key: 'r', type: 'button', className: 'dsc-btn', onClick: function () { load(true); }, disabled: state.loading }, [h(IconRefresh, { key: 'i' }), t('page.refresh')]),
                    h('button', { key: 'i', type: 'button', className: 'dsc-btn', onClick: function () { setDialogError(''); setDragZip(null); setDialog('import'); } }, [h(IconFolder, { key: 'i' }), t('page.import')]),
                    h('button', { key: 'o', type: 'button', className: 'dsc-btn', onClick: function () { api('/open-folder', { target: 'skills' }).catch(function (error) { setLoadError(t('err.prefix') + (error && error.message ? error.message : String(error))); }); } }, t('page.openFolder')),
                    h('button', { key: 'c', type: 'button', className: 'dsc-btn dsc-btn-primary', onClick: function () { setDialogError(''); setDialog('create'); } }, [h(IconPlus, { key: 'i' }), t('page.create')]),
                    h('p', { key: 'sub', className: 'dsc-sub' }, t('page.subtitle')),
                    h('p', { key: 'drag', className: 'dsc-sub' }, t('page.dragHint')),
                ]),
                data && data.registryAvailable === false ? h('div', { key: 'off', className: 'dsc-notice' }, t('misc.registryOff')) : null,
                data && data.incomplete ? h('div', { key: 'inc', className: 'dsc-notice' }, t('misc.incomplete')) : null,
                loadError ? h(ErrorBar, { key: 'e', message: loadError, onDismiss: function () { setLoadError(''); } }) : null,
                h('div', { key: 'tabs', className: 'dsc-tabs' }, filters.map(function (entry) {
                    return h('button', {
                        key: entry.id, type: 'button',
                        className: 'dsc-tab' + (tab === entry.id ? ' dsc-tab-on' : ''),
                        onClick: function () { setTab(entry.id); },
                    }, entry.label + ' ' + entry.count);
                })),
                h('div', { key: 'search', className: 'dsc-searchrow' }, [
                    h('span', { key: 'i', style: { color: 'var(--dsw-alias-label-secondary,#8a9099)', display: 'inline-flex' } }, h(IconSearch, {})),
                    h('input', {
                        key: 'q', className: 'dsc-input', value: query, placeholder: t('page.search'),
                        onChange: function (event) { setQuery(event.target.value); },
                    }),
                ]),
                state.loading && !data
                    ? h('div', { key: 'l', className: 'dsc-empty' }, t('picker.loading'))
                    : rows.length === 0
                        ? h('div', { key: 'e', className: 'dsc-empty' }, [
                            h('div', { key: 'i', style: { display: 'inline-flex', opacity: 0.5 } }, h(IconSkill, { size: 26 })),
                            h('div', { key: 't' }, t('empty.' + tab)),
                        ])
                        : h('div', { key: 'list', className: 'dsc-list' }, rows.map(function (row) {
                            var item = row.item;
                            var group = row.group;
                            var badges = [
                                h(Badge, { key: 'g', kind: group === 'personal' ? 'personal' : group === 'official' ? 'official' : group === 'disabled' ? 'disabled' : 'other' },
                                    group === 'personal' ? t('badge.personal') : group === 'official' ? t('badge.official') : group === 'disabled' ? t('badge.disabled') : (item.source || t('badge.other'))),
                            ];
                            var inv = item.invocation || { modelInvocable: true, userInvocable: true };
                            if (!inv.modelInvocable && inv.userInvocable) badges.push(h(Badge, { key: 'm', kind: 'soft' }, t('badge.userOnly')));
                            if (inv.modelInvocable && !inv.userInvocable) badges.push(h(Badge, { key: 'u', kind: 'soft' }, t('badge.modelOnly')));
                            if (item.valid === false) badges.push(h(Badge, { key: 'x', kind: 'invalid' }, t('row.invalid')));
                            var actions = [
                                h('button', {
                                    key: 'p', type: 'button', className: 'dsc-btn dsc-btn-sm',
                                    onClick: function () { openDetail(group, item); },
                                }, t('row.preview')),
                            ];
                            if (group === 'personal' || group === 'disabled') {
                                actions.push(h('button', {
                                    key: 't', type: 'button', className: 'dsc-btn dsc-btn-sm',
                                    onClick: function () {
                                        if (group === 'personal') setConfirm({ kind: 'disable', name: item.name });
                                        else runAction(t('toast.enabled'), api('/toggle', { name: item.name, enabled: true }));
                                    },
                                }, [h(IconPower, { key: 'i' }), group === 'personal' ? t('row.disable') : t('row.enable')]));
                                actions.push(h('button', {
                                    key: 'd', type: 'button', className: 'dsc-btn dsc-btn-sm dsc-btn-danger',
                                    onClick: function () { setConfirm({ kind: 'remove', name: item.name }); },
                                }, [h(IconTrash, { key: 'i' }), t('row.remove')]));
                            }
                            return h('div', { key: group + ':' + item.name, className: 'dsc-row' }, [
                                h('div', {
                                    key: 'm', className: 'dsc-row-main', role: 'button', tabIndex: 0,
                                    onClick: function () { openDetail(group, item); },
                                    onKeyDown: function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetail(group, item); } },
                                }, [
                                    h('div', { key: 'n', className: 'dsc-row-name' }, [item.name].concat(badges)),
                                    h('p', { key: 'd', className: 'dsc-row-desc', title: item.description || '' }, item.description || '—'),
                                    h('div', { key: 'i', className: 'dsc-row-meta' }, [
                                        h('span', { key: 's' }, (item.source || group)),
                                        item.sizeBytes ? h('span', { key: 'b' }, (Math.max(1, Math.round(item.sizeBytes / 1024)) + ' KB')) : null,
                                        item.error ? h('span', { key: 'e', style: { color: 'var(--dsw-alias-state-error-primary,#e05a4a)' } }, item.error) : null,
                                    ]),
                                ]),
                                h('div', { key: 'a', className: 'dsc-row-actions' }, actions),
                            ]);
                        })),
                toast ? h('div', { key: 'toast', className: 'dsc-toast' }, toast) : null,
                h(SkillDetail, {
                    key: 'detail',
                    open: !!detail,
                    group: detail ? detail.group : '',
                    name: detail ? detail.name : '',
                    content: detail ? detail.content : '',
                    loading: detail ? detail.loading : false,
                    saving: detail ? detail.saving : false,
                    error: detail ? detail.error : '',
                    onClose: function () { setDetail(null); },
                    onSave: saveContent,
                }),
            ]);

            if (dialog === 'create') {
                content = h(react.Fragment, null, content, h(CreateDialog, {
                    key: 'create-dialog', busy: busy, error: dialogError,
                    onCreate: doCreate, onCancel: function () { setDialog(null); setDialogError(''); },
                }));
            } else if (dialog === 'import') {
                content = h(react.Fragment, null, content, h(ImportDialog, {
                    key: 'import-dialog', busy: busy, error: dialogError,
                    onImport: doImport,
                    onImportZip: doImportZip,
                    initialZip: dragZip,
                    onCancel: function () { setDialog(null); setDialogError(''); setDragZip(null); },
                }));
            }
            if (confirm) {
                var isDelete = confirm.kind === 'remove';
                content = h(react.Fragment, null, content, h(ConfirmDialog, {
                    key: 'confirm-dialog',
                    title: isDelete ? t('confirm.delete.title') : t('confirm.disable.title'),
                    message: isDelete ? t('confirm.delete.message') : t('confirm.disable.message'),
                    danger: isDelete,
                    busy: busy,
                    onCancel: function () { setConfirm(null); },
                    onConfirm: function () {
                        runAction(
                            isDelete ? t('toast.removed') : t('toast.disabled'),
                            api(isDelete ? '/remove' : '/toggle', isDelete ? { name: confirm.name } : { name: confirm.name, enabled: false }),
                        );
                    },
                }));
            }
            return content;
        }

        // ------------------------------------------------------------------
        // 聊天栏技能选择器
        // ------------------------------------------------------------------
        function SkillPickerButton(ownerProps) {
            useLangTick();
            var s1 = react.useState(false);
            var open = s1[0]; var setOpen = s1[1];
            var s2 = react.useState({ loading: false, data: null, error: '', at: 0 });
            var cache = s2[0]; var setCache = s2[1];
            var s3 = react.useState('');
            var query = s3[0]; var setQuery = s3[1];
            var s4 = react.useState('');
            var insertError = s4[0]; var setInsertError = s4[1];
            var rootRef = react.useRef(null);
            var ownerRef = react.useRef(null);
            ownerRef.current = ownerProps || null;

            var inputActions = ownerProps && ownerProps.inputActions;
            var input = ownerProps && ownerProps.input;
            var draft = input && typeof input.draft === 'string' ? input.draft : '';
            var canInsert = !!(inputActions && typeof inputActions.setDraft === 'function');

            function currentSessionId() {
                try {
                    var sessions = (pluginCtx && pluginCtx.sessions) || (pluginCtx && pluginCtx.get ? pluginCtx.get('sessions') : null);
                    if (sessions && sessions.list && typeof sessions.list.getSnapshot === 'function') {
                        var snapshot = sessions.list.getSnapshot();
                        return (snapshot && (snapshot.current || snapshot.sessionId)) || '';
                    }
                } catch (error) { /* 忽略 */ }
                return '';
            }

            function ensureData(force) {
                if (!force && cache.data && Date.now() - cache.at < 5000) return;
                setCache(function (prev) { return Object.assign({}, prev, { loading: true, error: '' }); });
                var qs = currentSessionId() ? ('?sessionId=' + encodeURIComponent(currentSessionId())) : '';
                api('/list' + qs).then(function (payload) {
                    setCache({ loading: false, data: payload, error: '', at: Date.now() });
                }).catch(function (error) {
                    setCache(function (prev) { return Object.assign({}, prev, { loading: false, error: error && error.message ? error.message : String(error) }); });
                });
            }

            react.useEffect(function () {
                if (!open) return undefined;
                ensureData(false);
                function onDocDown(event) {
                    if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
                }
                function onKey(event) { if (event.key === 'Escape') setOpen(false); }
                document.addEventListener('mousedown', onDocDown);
                document.addEventListener('keydown', onKey);
                return function () {
                    document.removeEventListener('mousedown', onDocDown);
                    document.removeEventListener('keydown', onKey);
                };
            }, [open]);

            function insert(skillName) {
                var latest = ownerRef.current || {};
                var actions = latest.inputActions;
                var latestInput = latest.input;
                var currentDraft = latestInput && typeof latestInput.draft === 'string' ? latestInput.draft : '';
                if (!actions || typeof actions.setDraft !== 'function') { setInsertError(t('picker.noInput')); return; }
                var sep = currentDraft && !/\s$/.test(currentDraft) ? ' ' : '';
                try {
                    actions.setDraft(currentDraft + sep + '/' + skillName + ' ');
                    setInsertError('');
                    setOpen(false);
                } catch (error) {
                    setInsertError((error && error.message) || String(error));
                }
            }

            var data = cache.data;
            var personal = data ? (data.personal || []) : [];
            var official = data ? (data.official || []) : [];
            var other = data ? (data.other || []) : [];
            var insertable = personal.concat(official, other).filter(function (item) {
                var inv = item.invocation || { modelInvocable: true, userInvocable: true };
                return item.valid !== false && inv.userInvocable !== false;
            });
            var keyword = query.trim().toLowerCase();
            if (keyword) {
                insertable = insertable.filter(function (item) {
                    return (item.name || '').toLowerCase().indexOf(keyword) >= 0
                        || (item.description || '').toLowerCase().indexOf(keyword) >= 0;
                });
            }
            var mySkills = insertable.filter(function (item) { return (data && data.personal || []).some(function (p) { return p.name === item.name; }); });
            var officialSkills = insertable.filter(function (item) { return mySkills.indexOf(item) < 0; });

            function group(title, items) {
                if (!items.length) return [];
                return [
                    h('div', { key: 'g:' + title, className: 'dsc-pop-group' }, title),
                ].concat(items.map(function (item) {
                    var inv = item.invocation || { modelInvocable: true, userInvocable: true };
                    return h('button', {
                        key: 'i:' + item.name, type: 'button', className: 'dsc-pop-item', disabled: !canInsert,
                        title: item.description || item.name,
                        onClick: function () { insert(item.name); },
                    }, [
                        h('span', { key: 'n', className: 'dsc-pop-item-name' }, [
                            h(IconSkill, { key: 'i', size: 12 }),
                            h('span', { key: 't' }, item.name),
                        ]),
                        h('span', { key: 'd', className: 'dsc-pop-item-desc' }, item.description || (inv.modelInvocable ? '' : t('picker.onlyModel'))),
                    ]);
                }));
            }

            var popover = open ? h('div', { className: 'dsc-pop', role: 'dialog', 'aria-label': t('picker.title') }, [
                h('div', { key: 'h', className: 'dsc-pop-head' }, [
                    h('span', { key: 't', className: 'dsc-pop-title' }, t('picker.title')),
                    h('button', { key: 'c', type: 'button', className: 'dsc-btn dsc-btn-sm', onClick: function () { setOpen(false); } }, h(IconClose, {})),
                ]),
                h('input', {
                    key: 'q', className: 'dsc-input', value: query, placeholder: t('picker.search'), autoFocus: true,
                    onChange: function (event) { setQuery(event.target.value); },
                }),
                cache.loading ? h('div', { key: 'l', className: 'dsc-hint' }, t('picker.loading')) : null,
                cache.error ? h(ErrorBar, { key: 'e', message: cache.error }) : null,
                insertError ? h(ErrorBar, { key: 'ie', message: insertError }) : null,
                !canInsert && !insertError ? h('div', { key: 'ni', className: 'dsc-hint' }, t('picker.noInput')) : null,
                h('div', { key: 'list', className: 'dsc-pop-list' },
                    insertable.length === 0
                        ? [h('div', { key: 'e', className: 'dsc-empty', style: { padding: '12px' } }, [
                            h('div', { key: 't' }, t('picker.empty')),
                            h('div', { key: 'h', className: 'dsc-hint' }, t('picker.emptyHint')),
                        ])]
                        : group(t('badge.personal'), mySkills).concat(group(t('badge.official'), officialSkills))),
                h('div', { key: 'f', className: 'dsc-pop-foot' }, [
                    h('span', { key: 'h', className: 'dsc-pop-hint' }, t('picker.inserted') + ' /name'),
                    h('button', {
                        key: 'm', type: 'button', className: 'dsc-btn dsc-btn-sm',
                        onClick: function () {
                            setOpen(false);
                            try {
                                var layout = pluginCtx && pluginCtx.get ? pluginCtx.get('layout') : null;
                                if (layout && typeof layout.selectPanel === 'function') layout.selectPanel('dsh-skill-center');
                            } catch (error) { /* 忽略 */ }
                        },
                    }, t('picker.manage')),
                ]),
            ]) : null;

            return h('div', { className: 'dsc-picker', ref: rootRef }, [
                h('button', {
                    key: 'b', type: 'button',
                    className: 'dsc-picker-btn' + (open ? ' dsc-picker-btn-on' : ''),
                    title: t('picker.title'),
                    onClick: function () { setOpen(!open); setInsertError(''); },
                }, [
                    h(IconSkill, { key: 'i', size: 13 }),
                    h('span', { key: 't' }, t('picker.button')),
                    h('span', { key: 'c', className: 'dsc-picker-count' }, String(insertable.length)),
                ]),
                popover,
            ]);
        }

        // ------------------------------------------------------------------
        // 插件契约
        // ------------------------------------------------------------------
        var pluginCtx = null;
        var STYLE_ID = 'dsh-skill-center-style';

        function injectStyle(ctx) {
            try {
                ctx.effect(function () {
                    var existing = document.getElementById(STYLE_ID);
                    if (existing) existing.remove();
                    var style = document.createElement('style');
                    style.id = STYLE_ID;
                    style.textContent = CSS;
                    document.head.appendChild(style);
                    return function () {
                        var node = document.getElementById(STYLE_ID);
                        if (node) node.remove();
                    };
                });
            } catch (error) {
                // 样式注入失败不阻断功能（页面仍可用，只是回退到宿主默认样式）
                if (window.console) console.warn('[dsh-skill-center] 样式注入失败', error);
            }
        }

        function apply(ctx) {
            pluginCtx = ctx;
            injectStyle(ctx);

            function registerPanel() {
                try {
                    ctx.slots.inject('sidebar.panellist', function () {
                        return ctx.slots.register({
                            name: 'sidebar.panellist',
                            id: 'dsh-skill-center',
                            order: 30,
                            label: function () { return t('panel.title'); },
                        }, function (props) {
                            var size = props && typeof props.size === 'number' ? props.size : 18;
                            return h(IconSkill, { size: size });
                        });
                    });
                } catch (error) {
                    if (window.console) console.warn('[dsh-skill-center] sidebar.panellist 注册失败', error);
                }
                try {
                    ctx.slots.inject('main', function () {
                        return ctx.slots.register({ name: 'main', key: 'dsh-skill-center' }, SkillCenterPage);
                    });
                } catch (error) {
                    if (window.console) console.warn('[dsh-skill-center] main 面板注册失败', error);
                }
            }

            function registerPicker() {
                try {
                    ctx.slots.inject('conversation.input.left', function () {
                        return ctx.slots.register(
                            { name: 'conversation.input.left', id: 'dsh-skill-center-picker', order: 6 },
                            function (ownerProps) { return h(SkillPickerButton, ownerProps || {}); },
                        );
                    });
                } catch (error) {
                    if (window.console) console.warn('[dsh-skill-center] conversation.input.left 注册失败', error);
                }
            }

            // i18n bridge 初始化后再注册（与 dsh-rules 相同的等待策略），避免首屏语言滞后。
            if (window.__DSH_I18N__ && window.__DSH_I18N__._initialized) {
                registerPanel();
                registerPicker();
            } else {
                var timer = setInterval(function () {
                    if (window.__DSH_I18N__ && window.__DSH_I18N__._initialized) {
                        clearInterval(timer);
                        registerPanel();
                        registerPicker();
                    }
                }, 50);
                // 1.5s 后仍未就绪也注册（词典自包含，不依赖 bridge）
                setTimeout(function () {
                    clearInterval(timer);
                    registerPanel();
                    registerPicker();
                }, 1500);
            }
        }

        var inject = ['slots', 'sessions'];
        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    },
});
