// DeepSeek Harness 插件 (客户端): dsh-rules
// 在「设置」面板注册「用户规则」页面 (v4 重写):
//   - 总开关 (默认关闭, 节省 system prompt token);
//   - 规则文件路径 / 存在性 / 大小;
//   - 规则内容预览 (只读, Markdown 源码);
//   - 「编辑」按钮 → 切换到编辑模式 (textarea, 可直接修改保存);
//   - 编辑模式: 保存 / 取消, autoReload 下下次对话自动生效;
//   - 打开所在目录按钮 (调系统文件管理器, 直接去改 user-rules.md);
//   - 保存开关后提示重启生效。
// 数据走宿主端路由 /__dsh/rules/config + /__dsh/rules/content + /__dsh/rules/open-folder。
// 加载器契约格式 (window.__ModuleLoader__.load), 与官方客户端插件一致。

window.__ModuleLoader__.load({
    id: "dsh-rules",
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
        let react = require("react");

        const inject = ["slots"];

        const ROUTE_CONFIG = "/__dsh/rules/config";
        const ROUTE_CONTENT = "/__dsh/rules/content";
        const ROUTE_OPEN_FOLDER = "/__dsh/rules/open-folder";

        // ---- 网络请求 ----

        /** 向宿主发 GET config 请求。 */
        async function getConfig() {
            const response = await fetch(ROUTE_CONFIG);
            const payload = await response.json().catch(() => null);
            if (!response.ok || payload === null || payload.ok !== true) {
                throw new Error((payload && payload.error) || ("HTTP " + response.status));
            }
            return payload;
        }

        /** 向宿主发 POST config 请求 (只保存 enabled)。 */
        async function postConfig(overrides) {
            const response = await fetch(ROUTE_CONFIG, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(overrides),
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok || payload === null || payload.ok !== true) {
                throw new Error((payload && payload.error) || ("HTTP " + response.status));
            }
            return payload;
        }

        /** 向宿主发 GET content 请求 (读规则文件)。 */
        async function getContent() {
            const response = await fetch(ROUTE_CONTENT);
            const payload = await response.json().catch(() => null);
            if (!response.ok || payload === null || payload.ok !== true) {
                throw new Error((payload && payload.error) || ("HTTP " + response.status));
            }
            return payload;
        }

        /** 向宿主发 POST content 请求 (写规则文件)。 */
        async function postContent(content) {
            const response = await fetch(ROUTE_CONTENT, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ content: content }),
            });
            const payload = await response.json().catch(() => null);
            if (!response.ok || payload === null || payload.ok !== true) {
                throw new Error((payload && payload.error) || ("HTTP " + response.status));
            }
            return payload;
        }

        // ---- 组件 ----

        /** 规则设置面板组件。 */
        function RulesSection() {
            // config 状态
            const [config, setConfig] = react.useState(null);
            const [loading, setLoading] = react.useState(false);
            const [error, setError] = react.useState(null);
            const [savingEnabled, setSavingEnabled] = react.useState(false);
            const [savedTip, setSavedTip] = react.useState(null);
            const [draftEnabled, setDraftEnabled] = react.useState(false);
            // content 状态
            const [content, setContent] = react.useState(null);      // null = 未加载
            const [loadingContent, setLoadingContent] = react.useState(false);
            const [editMode, setEditMode] = react.useState(false);
            const [draftContent, setDraftContent] = react.useState(""); // 编辑中的草稿
            const [savingContent, setSavingContent] = react.useState(false);
            const [contentTip, setContentTip] = react.useState(null);
            const [contentError, setContentError] = react.useState(null);
            // 首次加载标记
            const loadedRef = react.useRef(false);

            // --- 加载 config ---
            const loadConfig = react.useCallback(async () => {
                setLoading(true);
                setError(null);
                try {
                    const payload = await getConfig();
                    const cfg = payload.config || {};
                    setConfig(cfg);
                    setDraftEnabled(Boolean(cfg.enabled));
                } catch (err) {
                    setError("读取配置失败: " + String((err && err.message) || err));
                } finally {
                    setLoading(false);
                }
            }, []);

            // --- 加载 content ---
            const loadContent = react.useCallback(async () => {
                setLoadingContent(true);
                setContentError(null);
                try {
                    const payload = await getContent();
                    const text = payload.content || "";
                    setContent(text);
                    setDraftContent(text); // 同步草稿
                } catch (err) {
                    setContentError("读取规则失败: " + String((err && err.message) || err));
                } finally {
                    setLoadingContent(false);
                }
            }, []);

            // --- 实时保存 enabled 开关 (checkbox onChange 直接触发, 无需点按钮) ---
            const saveEnabled = async (newValue) => {
                setSavingEnabled(true);
                setSavedTip(null);
                setError(null);
                // 立即更新 UI 状态 (乐观更新), 不等后端返回
                setDraftEnabled(newValue);
                try {
                    const payload = await postConfig({ enabled: newValue });
                    const cfg = payload.config || {};
                    setConfig(config ? { ...config, ...cfg } : cfg);
                    setSavedTip(payload.note || "已保存");
                } catch (err) {
                    // 保存失败 → 回滚 UI 状态
                    setDraftEnabled(!newValue);
                    setError("保存开关失败: " + String((err && err.message) || err));
                } finally {
                    setSavingEnabled(false);
                }
            };

            // --- 进入编辑模式 ---
            const enterEdit = () => {
                setContentError(null);
                setContentTip(null);
                setDraftContent(content || ""); // 用当前内容初始化草稿
                setEditMode(true);
            };

            // --- 取消编辑 ---
            const cancelEdit = async () => {
                // 重新从服务器拉一次, 确保内容是最新的 (防止 autoReload 下文件被外部改了)
                setEditMode(false);
                await loadContent();
                setContentTip(null);
            };

            // --- 保存规则内容 ---
            const saveContent = async () => {
                setSavingContent(true);
                setContentTip(null);
                setContentError(null);
                try {
                    const payload = await postContent(draftContent);
                    setContent(draftContent); // 保存成功 → 正式内容更新
                    setContentTip(payload.note || "规则已保存");
                    setEditMode(false); // 退出编辑模式
                    // 同时刷新 config (文件大小可能变了)
                    if (config) {
                        setConfig({ ...config, ruleSize: draftContent.length });
                    }
                } catch (err) {
                    setContentError("保存规则失败: " + String((err && err.message) || err));
                } finally {
                    setSavingContent(false);
                }
            };

            // --- 打开规则文件所在目录 (用系统文件管理器) ---
            const openFolder = async () => {
                try {
                    const resp = await fetch(ROUTE_OPEN_FOLDER);
                    const payload = await resp.json().catch(() => null);
                    if (resp.ok && payload && payload.ok) {
                        // 已开文件管理器, 不需要额外反馈, 但把路径记录一下
                        console.log("dsh-rules: 已打开目录", payload.path);
                    } else {
                        setError((payload && payload.error) || "打开目录失败");
                    }
                } catch (err) {
                    setError("打开目录失败: " + String((err && err.message) || err));
                }
            };

            // --- 首次挂载: 同时拉 config 和 content ---
            if (!loadedRef.current) {
                loadedRef.current = true;
                loadConfig();
                loadContent();
            }

            // ---- 样式 ----
            const rootStyle = { display: "flex", flexDirection: "column", gap: 12, padding: 4, maxWidth: 720 };
            const cardStyle = { border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 6, padding: "12px 14px" };
            const btnBase = { padding: "6px 14px", cursor: "pointer", fontSize: 12, borderRadius: 4 };
            const btnPrimary = { ...btnBase, fontWeight: 600, background: "var(--dsw-alias-interactive-bg-hover)", border: "1px solid var(--dsw-alias-border-l1)" };
            const btnGhost = { ...btnBase, background: "transparent", border: "1px solid var(--dsw-alias-border-l1)", color: "var(--dsw-alias-label-primary)" };
            const btnDanger = { ...btnBase, background: "transparent", border: "1px solid #e74c3c", color: "#e74c3c" };

            return react.createElement("div", { style: rootStyle }, [
                // ===== 标题 + 说明 =====
                react.createElement("p", { key: "title", style: { margin: 0, fontSize: 14, fontWeight: 600, color: "var(--dsw-alias-label-primary)" } },
                    "用户规则设置 (类似 TRAE Work 的「规则」功能)"
                ),
                react.createElement("p", { key: "desc", style: { margin: 0, fontSize: 13, lineHeight: 1.6, color: "var(--dsw-alias-label-secondary)" } },
                    "把你的个人习惯/代码风格/表达要求写成 Markdown, 每次对话会自动注入到 system prompt 里。" +
                    "开启后会占用少量 token, 建议按需开启。支持 WebUI 内直接编辑, 或点「打开所在目录」用本地编辑器修改 user-rules.md (文件变化自动重载)。"
                ),

                error !== null && react.createElement("p", { key: "err", style: { color: "var(--dsw-alias-state-error-primary)", margin: 0, fontSize: 13 } }, error),

                // ===== 主卡片: 开关 + 文件信息 =====
                react.createElement("div", { key: "main", style: cardStyle }, [
                    // 启用开关
                    react.createElement("div", { key: "enable", style: { display: "flex", alignItems: "center", gap: 8, marginBottom: 12 } }, [
                        react.createElement("input", {
                            type: "checkbox", id: "rules-enabled",
                            checked: draftEnabled,
                            disabled: savingEnabled,
                            onChange: (e) => saveEnabled(e.target.checked),
                            style: { cursor: savingEnabled ? "default" : "pointer", margin: 0 },
                        }),
                        react.createElement("label", { htmlFor: "rules-enabled", style: { fontSize: 13, cursor: "pointer" } },
                            "启用用户规则注入",
                            config && react.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginLeft: 8 } },
                                draftEnabled ? "(每次对话会注入规则到 system prompt)" : "(关闭后不占 token)"
                            )
                        ),
                        savedTip !== null && react.createElement("span", { key: "tip", style: { fontSize: 11, color: "#2ecc71", marginLeft: 4 } }, savedTip),
                    ]),
                    // 文件状态行
                    config && react.createElement("div", { key: "file", style: {
                        fontSize: 12, color: "var(--dsw-alias-label-secondary)",
                        padding: "8px 10px", background: "var(--dsw-alias-bg-layer-2)", borderRadius: 4,
                    } }, [
                        react.createElement("div", { key: "path", style: { fontFamily: "Consolas, Menlo, monospace", fontSize: 11, wordBreak: "break-all" } },
                            "规则文件: " + (config.rulesPath || "—")
                        ),
                        react.createElement("div", { key: "state", style: { marginTop: 4 } },
                            config.ruleFileExists
                                ? "✓ 文件存在, 大小 " + (config.ruleSize || 0) + " 字符"
                                : "✗ 文件不存在 (首次使用会自动创建)"
                        ),
                        react.createElement("div", { key: "reload", style: { marginTop: 2 } },
                            "自动重载: " + (config.autoReload ? "开启 (编辑后自动生效)" : "关闭")
                        ),
                    ]),
                    // 刷新按钮 (开关已改成勾选即实时保存, 不再需要"保存开关"按钮)
                    react.createElement("div", { key: "ops", style: { display: "flex", gap: 10, alignItems: "center", marginTop: 10 } }, [
                        react.createElement("button", { key: "refresh", type: "button", disabled: loading, onClick: () => { loadConfig(); loadContent(); }, style: btnGhost },
                            loading ? "加载中…" : "刷新"
                        ),
                    ]),
                ]),

                // ===== 规则内容卡片: 预览 / 编辑 =====
                react.createElement("div", { key: "content", style: cardStyle }, [
                    // 卡片标题 + 操作按钮
                    react.createElement("div", { key: "header", style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 } }, [
                        react.createElement("strong", { style: { fontSize: 13 } },
                            editMode ? "编辑规则内容" : "规则内容预览"
                        ),
                        react.createElement("div", { style: { display: "flex", gap: 8 } },
                            editMode
                                // 编辑模式: 保存 + 取消
                                ? [
                                    react.createElement("button", {
                                        key: "saveC", type: "button", disabled: savingContent, onClick: saveContent,
                                        style: { ...btnPrimary, color: "#fff", background: "#27ae60", borderColor: "#27ae60" },
                                    }, savingContent ? "保存中…" : "保存规则"),
                                    react.createElement("button", {
                                        key: "cancel", type: "button", onClick: cancelEdit, style: btnGhost,
                                    }, "取消"),
                                ]
                                // 预览模式: 编辑 + 打开所在目录
                                : [
                                    react.createElement("button", {
                                        key: "edit", type: "button", onClick: enterEdit, style: btnPrimary,
                                    }, "编辑规则"),
                                    react.createElement("button", {
                                        key: "folder", type: "button", onClick: openFolder, style: btnGhost,
                                        title: "用系统文件管理器打开规则文件所在目录, 直接编辑 user-rules.md",
                                    }, "打开所在目录"),
                                ]
                        ),
                    ]),

                    // 错误提示 (content 区)
                    contentError !== null && react.createElement("p", { key: "cerr", style: { color: "#e74c3c", margin: "4px 0 8px", fontSize: 12 } }, contentError),
                    // 保存提示
                    contentTip !== null && react.createElement("p", { key: "ctip", style: { color: "#2ecc71", margin: "4px 0 8px", fontSize: 12 } }, contentTip),

                    // 内容区: 编辑模式用 textarea, 预览模式用 pre
                    editMode
                        ? react.createElement("textarea", {
                            key: "ta",
                            value: draftContent,
                            onChange: (e) => { setDraftContent(e.target.value); setContentTip(null); setContentError(null); },
                            placeholder: "# 个人规则\n\n- 回复用中文\n- 代码注释写详细...",
                            style: {
                                width: "100%", minHeight: 280, resize: "vertical",
                                fontFamily: "Consolas, Menlo, 'Courier New', monospace",
                                fontSize: 12, lineHeight: 1.5, padding: 10,
                                background: "var(--dsw-alias-bg-layer-2)",
                                color: "var(--dsw-alias-label-primary)",
                                border: "1px solid var(--dsw-alias-border-l1)",
                                borderRadius: 4, boxSizing: "border-box",
                                outline: "none",
                            },
                        })
                        : react.createElement("pre", {
                            key: "pre",
                            style: {
                                margin: 0, minHeight: 120, maxHeight: 360, overflowY: "auto",
                                fontFamily: "Consolas, Menlo, 'Courier New', monospace",
                                fontSize: 12, lineHeight: 1.5, padding: 10,
                                background: "var(--dsw-alias-bg-layer-2)",
                                color: "var(--dsw-alias-label-primary)",
                                border: "1px solid var(--dsw-alias-border-l1)",
                                borderRadius: 4, whiteSpace: "pre-wrap", wordBreak: "break-word",
                            },
                        },
                            loadingContent ? "加载中…" :
                            (content === null ? "未加载" :
                             (content.length === 0 ? "(规则文件为空, 点击「编辑规则」开始写)" : content))
                        ),

                    // 底部字符数统计
                    react.createElement("div", { key: "count", style: {
                        fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginTop: 6, textAlign: "right",
                    } },
                        editMode
                            ? "当前 " + draftContent.length + " 字符" +
                              (config && config.maxLength > 0 ? " / 上限 " + config.maxLength : "")
                            : (content !== null ? (content.length + " 字符") : "")
                    ),
                ]),
            ]);
        }

        // ---- 插件契约 ----
        function apply(ctx) {
            ctx.slots.inject("settings.section", () => ctx.slots.register({
                name: "settings.section",
                id: "dsh-rules",
                order: 540,
                label: "用户规则",
            }, RulesSection));
        }

        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    },
});
