// DeepSeek Harness 插件 (客户端): dsh-memory
// 记忆库管理卡片 UI:
//   - 状态面板: 引擎状态 / 总条数 / DB 路径 / 平均重要性
//   - 记忆列表: 分页滚动 / 单条删除 / 点击查看详情
//   - 搜索: 关键词实时过滤
//   - 手动写入: 快速添加记忆
//
// 数据通过 fetch 调用宿主端路由 /__dsh/memory/*
//
// 加载器契约 (与官方客户端插件一致):
//   window.__ModuleLoader__.load({ id, factory })
//
// 主题适配 (2026-09-02, 按 SKILL §5.7):
//   全量 CSS 变量化, 深浅主题自动切换。背景/输入框/边框走 DSH 官方变量
//   (bg-base, specific-input-major, border-l2), 文字走 label-primary/secondary/tertiary,
//   状态色走 state-success/error/warn/business 变量。

window.__ModuleLoader__.load({
    id: "dsh-memory",
    factory: (require) => {
        var module = { exports: {} };
        var exports = module.exports;
        Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
        let react = require("react");

        const inject = ["slots"];

        const ROUTE_STATUS = "/__dsh/memory/status";
        const ROUTE_LIST = "/__dsh/memory/list";
        const ROUTE_SEARCH = "/__dsh/memory/search";
        const ROUTE_DELETE = "/__dsh/memory/delete";
        const ROUTE_WRITE = "/__dsh/memory/write";
        const ROUTE_CONFIG = "/__dsh/memory/config";
        const GUARD_HEADER = "x-dsh-memory";

        // ---- 主题样式常量 (统一引用, 便于维护) ----

        const CARD = {
            background: "var(--dsw-alias-bg-base)",
            border: "1px solid var(--dsw-alias-border-l2)",
            borderRadius: 12,
            color: "var(--dsw-alias-label-primary)",
        };
        const INPUT = {
            background: "var(--dsw-specific-input-major)",
            border: "1px solid var(--dsw-alias-border-l2)",
            color: "var(--dsw-alias-label-primary)",
        };
        const HINT = "var(--dsw-alias-label-tertiary)";
        const LABEL = "var(--dsw-alias-label-secondary)";
        const TEXT = "var(--dsw-alias-label-primary)";

        // ---- 工具函数 ----

        function fmtTime(ts) {
            if (!ts) return "—";
            try { return new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false }); }
            catch { return String(ts); }
        }

        function fmtImportance(v) {
            if (typeof v !== "number") return "0.6";
            return v.toFixed(2);
        }

        async function fetchJson(url, opts) {
            opts = opts || {};
            opts.headers = opts.headers || {};
            opts.headers["Content-Type"] = opts.headers["Content-Type"] || "application/json";
            const resp = await fetch(url, opts);
            const text = await resp.text();
            try { return JSON.parse(text); } catch { return { ok: false, error: text }; }
        }

        // ---- React 组件 ----

        /** 记忆库主面板 (卡片式, 顶部双开关 + 实时保存)。 */
        function MemoryCard() {
            const [status, setStatus] = react.useState(null);
            const [items, setItems] = react.useState([]);
            const [total, setTotal] = react.useState(0);
            const [offset, setOffset] = react.useState(0);
            const [loading, setLoading] = react.useState(false);
            const [error, setError] = react.useState(null);
            const [searchText, setSearchText] = react.useState("");
            const [selectedItem, setSelectedItem] = react.useState(null);
            // v4: 双开关状态 (自动记录 + 自动注入)
            const [autoRemember, setAutoRemember] = react.useState(null);   // null = 未加载
            const [autoRecall, setAutoRecall] = react.useState(null);
            const [savingField, setSavingField] = react.useState(null);    // 正在保存哪个字段
            const [savedTip, setSavedTip] = react.useState(null);

            const PAGE_SIZE = 50;

            /** 读取当前生效配置 (双开关)。 */
            const loadConfig = react.useCallback(async () => {
                try {
                    const resp = await fetch(ROUTE_CONFIG);
                    const payload = await resp.json().catch(() => null);
                    if (resp.ok && payload && payload.ok) {
                        setAutoRemember(Boolean(payload.config.autoRemember));
                        setAutoRecall(Boolean(payload.config.autoRecall));
                    } else {
                        setAutoRemember(false); setAutoRecall(false);
                    }
                } catch {
                    setAutoRemember(false); setAutoRecall(false);
                }
            }, []);

            /** 实时保存单个字段 (autoRemember 或 autoRecall)。 */
            const saveField = react.useCallback(async (fieldName, value) => {
                // 乐观更新: 先改 UI, 后端失败再回滚
                const prevRemember = autoRemember;
                const prevRecall = autoRecall;
                if (fieldName === "autoRemember") setAutoRemember(value);
                if (fieldName === "autoRecall") setAutoRecall(value);
                setSavingField(fieldName);
                setSavedTip(null);
                try {
                    const resp = await fetch(ROUTE_CONFIG, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({ [fieldName]: value }),
                    });
                    const payload = await resp.json().catch(() => null);
                    if (resp.ok && payload && payload.ok) {
                        setSavedTip(fieldName === "autoRemember"
                            ? (value ? "自动记录已开启" : "自动记录已关闭")
                            : (value ? "自动注入已开启" : "自动注入已关闭"));
                    } else {
                        // 回滚
                        setAutoRemember(prevRemember);
                        setAutoRecall(prevRecall);
                        setError((payload && payload.error) || "保存失败");
                    }
                } catch (err) {
                    // 回滚
                    setAutoRemember(prevRemember);
                    setAutoRecall(prevRecall);
                    setError("保存失败: " + String((err && err.message) || err));
                } finally {
                    setSavingField(null);
                }
            }, [autoRemember, autoRecall]);

            /** 组件挂载时先读配置, 再加载数据。 */
            react.useEffect(() => {
                loadConfig();
            }, [loadConfig]);

            /** 刷新全部数据。 */
            const refreshAll = react.useCallback(async () => {
                setLoading(true);
                setError(null);
                try {
                    const [sRes, lRes] = await Promise.all([
                        fetchJson(ROUTE_STATUS),
                        fetchJson(`${ROUTE_LIST}?limit=${PAGE_SIZE}&offset=${offset}`),
                    ]);
                    if (sRes.ok) setStatus(sRes.data);
                    else setError(sRes.error || "状态获取失败");
                    if (lRes.ok) {
                        setItems(lRes.data.items || []);
                        setTotal(lRes.data.total || 0);
                    }
                } catch (err) {
                    setError(String(err.message || err));
                } finally {
                    setLoading(false);
                }
            }, [offset]);

            react.useEffect(() => { refreshAll(); }, [refreshAll]);

            /** 搜索。 */
            const doSearch = react.useCallback(async () => {
                if (!searchText.trim()) { refreshAll(); return; }
                setLoading(true);
                try {
                    const res = await fetchJson(`${ROUTE_SEARCH}?q=${encodeURIComponent(searchText)}&limit=100`);
                    if (res.ok) {
                        setItems(res.data.results || []);
                        setTotal((res.data.results || []).length);
                    } else {
                        setError(res.error || "搜索失败");
                    }
                } catch (err) {
                    setError(String(err.message || err));
                } finally {
                    setLoading(false);
                }
            }, [searchText, refreshAll]);

            /** 删除一条。 */
            const doDelete = react.useCallback(async (id) => {
                if (!confirm(`确认删除记忆 #${id} ?`)) return;
                try {
                    await fetchJson(ROUTE_DELETE, {
                        method: "POST",
                        body: JSON.stringify({ id }),
                    });
                    setSelectedItem(null);
                    refreshAll();
                } catch (err) {
                    setError(String(err.message || err));
                }
            }, [refreshAll]);

            /** 手动写入。 */
            const doWrite = react.useCallback(async (content, tags, importance) => {
                try {
                    await fetchJson(ROUTE_WRITE, {
                        method: "POST",
                        body: JSON.stringify({ content, tags, importance }),
                    });
                    refreshAll();
                } catch (err) {
                    setError(String(err.message || err));
                }
            }, [refreshAll]);

            // ---- 渲染 ----
            const bridgeReady = status ? true : false;
            const totalMem = status?.total_memories ?? total;

            return react.createElement("div", {
                style: Object.assign({ padding: "16px", fontFamily: "-apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif", minHeight: "400px" }, CARD),
            },
                // --- 标题栏 (v4: 双开关 + 实时保存) ---
                react.createElement("div", { style: {
                    display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap",
                    marginBottom: "16px", borderBottom: "1px solid var(--dsw-alias-border-l2)", paddingBottom: "12px",
                }},
                    react.createElement("span", { style: { fontSize: "18px", fontWeight: 600, color: TEXT } }, "祖宗记忆库"),
                    react.createElement("span", { style: {
                        padding: "2px 10px", borderRadius: "10px", fontSize: "12px",
                        background: bridgeReady ? "var(--dsw-alias-state-success-secondary)" : "var(--dsw-alias-state-warn-secondary)",
                        color: bridgeReady ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-state-warn-primary)",
                    }}, bridgeReady ? "就绪" : "未就绪"),
                    // v4: 双 checkbox —— 自动记录
                    autoRemember !== null && react.createElement("label", { style: {
                        display: "flex", alignItems: "center", gap: "6px", marginLeft: "12px",
                        fontSize: "13px", color: TEXT, cursor: "pointer",
                    }},
                        react.createElement("input", {
                            type: "checkbox",
                            checked: autoRemember,
                            disabled: savingField === "autoRemember",
                            onChange: (e) => saveField("autoRemember", e.target.checked),
                            style: { cursor: savingField === "autoRemember" ? "default" : "pointer", margin: 0 },
                        }),
                        react.createElement("span", null, "自动记录"),
                    ),
                    // v4: 双 checkbox —— 自动注入
                    autoRecall !== null && react.createElement("label", { style: {
                        display: "flex", alignItems: "center", gap: "6px", marginLeft: "4px",
                        fontSize: "13px", color: TEXT, cursor: "pointer",
                    }},
                        react.createElement("input", {
                            type: "checkbox",
                            checked: autoRecall,
                            disabled: savingField === "autoRecall",
                            onChange: (e) => saveField("autoRecall", e.target.checked),
                            style: { cursor: savingField === "autoRecall" ? "default" : "pointer", margin: 0 },
                        }),
                        react.createElement("span", null, "自动注入"),
                    ),
                    react.createElement("button", {
                        onClick: refreshAll,
                        style: {
                            marginLeft: "auto", padding: "4px 12px", borderRadius: "6px",
                            background: "var(--dsw-alias-button-info-fill)", color: "#fff", border: "none", cursor: "pointer",
                            fontSize: "13px",
                        },
                    }, "刷新"),
                ),
                // 保存提示
                savedTip !== null && react.createElement("div", { style: {
                    padding: "6px 12px",
                    borderLeft: "3px solid var(--dsw-alias-state-success-primary)", color: "var(--dsw-alias-state-success-primary)", fontSize: "12px", marginBottom: "10px",
                }}, savedTip),

                // --- 状态行 ---
                react.createElement("div", { style: {
                    display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px", marginBottom: "16px",
                }},
                    react.createElement(StatBox, { label: "总条数", value: String(totalMem), accent: "var(--dsw-alias-state-business-primary)" }),
                    react.createElement(StatBox, {
                        label: "平均重要性",
                        value: status ? fmtImportance(status.avg_importance) : "—",
                        accent: "var(--dsw-alias-state-success-primary)",
                    }),
                    react.createElement(StatBox, {
                        label: "引擎版本",
                        value: status?.version || "—",
                        accent: "var(--dsw-alias-state-warn-primary)",
                    }),
                    react.createElement(StatBox, {
                        label: "最新写入",
                        value: fmtTime(status?.latest_memory_ts),
                        accent: "var(--dsw-alias-label-secondary)",
                    }),
                ),

                // --- DB 路径 ---
                status && react.createElement("div", { style: {
                    fontSize: "11px", color: HINT, marginBottom: "12px",
                    padding: "6px 10px", background: "var(--dsw-alias-bg-secondary)", borderRadius: "6px",
                }}, `DB: ${status.db_path}`),

                error && react.createElement("div", { style: {
                    padding: "8px 12px", color: "var(--dsw-alias-state-error-primary)", fontSize: "13px", marginBottom: "12px",
                    borderLeft: "3px solid var(--dsw-alias-state-error-primary)",
                }}, error),

                // --- 搜索 + 写入 ---
                react.createElement("div", { style: { display: "flex", gap: "8px", marginBottom: "12px" }},
                    react.createElement("input", {
                        value: searchText,
                        onChange: (e) => setSearchText(e.target.value),
                        onKeyDown: (e) => { if (e.key === "Enter") doSearch(); },
                        placeholder: "搜索记忆内容...",
                        style: Object.assign({
                            flex: 1, padding: "8px 12px", borderRadius: "6px", fontSize: "13px", outline: "none",
                        }, INPUT),
                    }),
                    react.createElement("button", {
                        onClick: doSearch,
                        style: {
                            padding: "8px 16px", borderRadius: "6px", background: "var(--dsw-alias-button-info-fill)",
                            color: "#fff", border: "none", cursor: "pointer", fontSize: "13px",
                        },
                    }, "搜索"),
                ),

                // --- 手动写入 ---
                react.createElement(QuickWrite, { onWrite: doWrite }),

                // --- 列表 ---
                react.createElement("div", { style: {
                    maxHeight: "300px", overflowY: "auto",
                    borderTop: "1px solid var(--dsw-alias-border-l2)", paddingTop: "12px",
                }},
                    loading ? react.createElement("div", { style: { textAlign: "center", padding: "20px", color: HINT } }, "加载中...")
                    : items.length === 0 ? react.createElement("div", { style: { textAlign: "center", padding: "20px", color: HINT } }, "暂无记忆")
                    : items.map((item) =>
                        react.createElement(MemoryItem, {
                            key: item.id,
                            item: item,
                            selected: selectedItem?.id === item.id,
                            onSelect: () => setSelectedItem(item),
                            onDelete: () => doDelete(item.id),
                        })
                    ),
                ),
            );
        }

        /** 统计小方块。accent 参数用 CSS 变量色值做左侧竖条和数值色。 */
        function StatBox({ label, value, accent }) {
            return react.createElement("div", { style: {
                padding: "10px 12px", borderRadius: "8px",
                background: "var(--dsw-alias-bg-secondary)", borderLeft: `3px solid ${accent}`,
            }},
                react.createElement("div", { style: { fontSize: "11px", color: LABEL, marginBottom: "2px" } }, label),
                react.createElement("div", { style: { fontSize: "16px", fontWeight: 600, color: accent } }, value),
            );
        }

        /** 单条记忆。 */
        function MemoryItem({ item, selected, onSelect, onDelete }) {
            const tags = item.tags || [];
            return react.createElement("div", {
                onClick: onSelect,
                style: {
                    padding: "10px 12px", marginBottom: "6px",
                    background: selected ? "var(--dsw-alias-state-business-secondary)" : "var(--dsw-alias-bg-secondary)",
                    borderRadius: "8px", cursor: "pointer",
                    border: selected ? "1px solid var(--dsw-alias-state-business-primary)" : "1px solid transparent",
                    transition: "all 0.15s",
                },
            },
                react.createElement("div", { style: { fontSize: "13px", color: TEXT, lineHeight: "1.5" } },
                    item.content.length > 150 ? item.content.slice(0, 150) + "..." : item.content,
                ),
                react.createElement("div", { style: {
                    display: "flex", alignItems: "center", gap: "8px", marginTop: "6px",
                    fontSize: "11px", color: HINT,
                }},
                    react.createElement("span", null, `#${item.id}`),
                    react.createElement("span", null, fmtTime(item.created_at)),
                    tags.slice(0, 3).map((t, i) =>
                        react.createElement("span", {
                            key: i,
                            style: { padding: "1px 6px", borderRadius: "4px", background: "var(--dsw-alias-state-business-secondary)", color: "var(--dsw-alias-state-business-primary)" },
                        }, t)
                    ),
                    react.createElement("span", { style: { marginLeft: "auto", color: "var(--dsw-alias-state-warn-primary)" } }, `importance ${fmtImportance(item.importance)}`),
                    react.createElement("button", {
                        onClick: (e) => { e.stopPropagation(); onDelete(); },
                        style: {
                            padding: "2px 8px", borderRadius: "4px",
                            background: "var(--dsw-alias-state-error-secondary)", color: "var(--dsw-alias-state-error-primary)",
                            border: "none", cursor: "pointer", fontSize: "11px",
                        },
                    }, "删除"),
                ),
            );
        }

        /** 快速写入表单。 */
        function QuickWrite({ onWrite }) {
            const [content, setContent] = react.useState("");
            const [tagsStr, setTagsStr] = react.useState("");
            const [importance, setImportance] = react.useState(0.6);

            const submit = () => {
                if (!content.trim()) return;
                const tags = tagsStr.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
                onWrite(content.trim(), tags, importance);
                setContent(""); setTagsStr(""); setImportance(0.6);
            };

            return react.createElement("div", { style: {
                padding: "10px", marginBottom: "12px",
                background: "var(--dsw-alias-bg-secondary)", borderRadius: "8px",
                border: "1px dashed var(--dsw-alias-border-l2)",
            }},
                react.createElement("textarea", {
                    value: content,
                    onChange: (e) => setContent(e.target.value),
                    placeholder: "快速写入一条记忆...",
                    rows: 2,
                    style: Object.assign({
                        width: "100%", padding: "8px", borderRadius: "6px",
                        fontSize: "13px", outline: "none", resize: "vertical",
                        boxSizing: "border-box", fontFamily: "inherit",
                    }, INPUT),
                }),
                react.createElement("div", { style: { display: "flex", gap: "8px", marginTop: "6px" }},
                    react.createElement("input", {
                        value: tagsStr,
                        onChange: (e) => setTagsStr(e.target.value),
                        placeholder: "标签 (逗号分隔)",
                        style: Object.assign({ flex: 1, padding: "6px 10px", borderRadius: "6px", fontSize: "12px", outline: "none" }, INPUT),
                    }),
                    react.createElement("input", {
                        type: "number", min: 0, max: 1, step: 0.1,
                        value: importance,
                        onChange: (e) => setImportance(parseFloat(e.target.value) || 0.6),
                        title: "重要性 0.0 ~ 1.0",
                        style: Object.assign({ width: "80px", padding: "6px 10px", borderRadius: "6px", fontSize: "12px", outline: "none" }, INPUT),
                    }),
                    react.createElement("button", {
                        onClick: submit,
                        style: {
                            padding: "6px 16px", borderRadius: "6px",
                            background: "var(--dsw-alias-state-success-primary)", color: "#fff", border: "none",
                            cursor: "pointer", fontSize: "12px", fontWeight: 600,
                        },
                    }, "写入"),
                ),
            );
        }

        // ---- 插件契约: 通过 ctx.slots.inject("settings.section", ...) 挂载到设置页 ----
        function apply(ctx) {
            ctx.slots.inject("settings.section", () => ctx.slots.register({
                name: "settings.section",
                id: "dsh-memory",
                order: 530,
                label: "祖宗记忆库",
            }, MemoryCard));
        }

        exports.apply = apply;
        exports.inject = inject;
        return module.exports;
    },
});
