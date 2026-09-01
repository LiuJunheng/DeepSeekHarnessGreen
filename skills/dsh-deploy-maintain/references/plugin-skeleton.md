# DSH 插件骨架参考

> 两种插件类型的完整代码骨架。开发新插件直接复制对应模板改名字。
>
> **Cordis 协议硬约束**（所有模板都已遵守，不要再改）：
>
> - 宿主端导出函数名**必须是** `apply`（不是 `setup`/`init`/`install`）
>
> - 纯客户端插件也必须带宿主端 `lib/index.js`（哪怕 no-op）
>
> - `exports` 必须包含 `"./package.json": "./package.json"`
>
> - 装完服务退出 = 对照 `plugin-dev-checklist.md` 零→二节排查

***

## 类型 A：路由 + 客户端双端插件（有 UI）

参考实作：`dsh-archive-purge` / `dsh-usage-stats` / `dsh-sidebar-lite`

### package.json

```json
{
  "name": "dsh-xxx-plugin",
  "version": "0.1.0",
  "description": "插件说明",
  "dsh": {
    "bundle": {
      "patch": "cordis.patch.yml"
    },
    "client": {
      "inject": ["slots"],
      "platform": "web"
    }
  },
  "files": ["lib", "cordis.patch.yml"],
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  }
}
```

### cordis.patch.yml

```yaml
- insert:
    - id: xxx-plugin
      name: dsh-xxx-plugin
```

### lib/index.js（宿主端：路由注册）

```js
import { readdir, readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

// 可选: 用 schemastery 定义配置 schema
// import z from "@deepseek-ai/schemastery";

export const name = "dsh-xxx-plugin";
export const inject = ["webServer", "workspaceRegistry"]; // 按需声明

// 可选: Config schema (全部字段给默认值)
// export const Config = z.object({
//   enabled: z.boolean().default(true),
//   maxItems: z.number().default(100),
// });

const ROUTE_PATH = "/__dsh/xxx";
const GUARD_HEADER = "x-dsh-plugin-xxx";

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

/**
 * Cordis 插件入口 —— 必须叫 apply, 可用 async。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config 用户配置 (Config schema 校验后的默认值)
 */
export async function apply(ctx, config) {
  // effect 包注册, 注销函数会在插件卸载时自动调
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: ROUTE_PATH,
    handler: async (req, res) => {
      if (req.headers[GUARD_HEADER] !== "1") { res.writeHead(403); res.end(); return; }
      if (req.method === "GET") {
        sendJson(res, 200, { ok: true, data: [] });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
        return;
      }
      try {
        const body = await readJsonBody(req);
        sendJson(res, 200, { ok: true, result: "ok" });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) });
      }
    }
  }), "dsh-xxx-plugin: route");

  ctx.logger.info(`dsh-xxx-plugin: ready, route = ${ROUTE_PATH}`);
}
```

### lib/client.js（客户端：WebUI 插槽注入）

```js
window.__ModuleLoader__.load({
  id: "dsh-xxx-plugin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");
    const inject = ["slots"];
    const ROUTE_PATH = "/__dsh/xxx";
    const GUARD_HEADER = "X-DSH-Plugin-Xxx";

    function PluginSection() {
      const [data, setData] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [error, setError] = react.useState(null);

      const load = react.useCallback(async () => {
        setBusy(true); setError(null);
        try {
          const resp = await fetch(ROUTE_PATH, {
            method: "GET",
            headers: { [GUARD_HEADER]: "1" }
          });
          const payload = await resp.json();
          if (!resp.ok || payload.ok !== true)
            throw new Error(payload.error || ("HTTP " + resp.status));
          setData(payload.data);
        } catch (err) {
          setError("加载失败: " + String(err.message || err));
        } finally { setBusy(false); }
      }, []);

      // 首次挂载加载
      const loadedRef = react.useRef(false);
      if (!loadedRef.current) { loadedRef.current = true; load(); }

      return react.createElement("div", { style: { padding: 8 } },
        react.createElement("p", {}, "插件内容区域")
      );
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "xxx-plugin",
        order: 500,
        label: "插件名称"
      }, PluginSection));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```

***

## 类型 B：纯 hook 插件（无 UI，只注入 system-prompt 等）

参考实作：`dsh-rules`（用户规则注入）、`dsh-memory`（祖宗记忆库注入）

### package.json

```json
{
  "name": "dsh-xxx-hook",
  "version": "0.1.0",
  "description": "纯 hook 插件 —— 监听 system-prompt/assemble 注入内容",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml"],
  "dsh": {
    "bundle": {
      "patch": "cordis.patch.yml"
    }
    // ⚠️ 注意: 纯 hook 插件不要写 dsh.client! 写了会让客户端模块注册表
    // 去找 exports["./client"] 找不到 → 服务启动崩溃。只有带 WebUI 的类型 A 才声明 dsh.client
  }
}
```

### cordis.patch.yml

```yaml
- insert:
    - id: xxx-hook
      name: dsh-xxx-hook
```

### lib/index.js（宿主端：system-prompt/assemble 注入）

```js
/**
 * 纯 hook 插件: 监听 system-prompt/assemble, 注入自定义 context。
 *
 * 运作原理:
 *   DSH 在每次模型请求前组装 system prompt, 触发 waterfall 事件。
 *   所有监听者依次修改 assembly 对象, 最后拼成完整 prompt 发给 LLM。
 *
 * assembly.contexts 每个元素结构:
 *   { name: string(全局唯一), text: string, weight?: number }
 *
 * 已存在的 context.name (不要重复):
 *   - user-rules          (dsh-rules 注入用户规则)
 *   - zuzong:auto-recall  (dsh-memory 注入祖宗记忆)
 */
import "@deepseek-ai/dsh-system-prompt"; // 声明依赖, 否则事件总线不存在
import z from "@deepseek-ai/schemastery";
import { readFileSync, watch, existsSync } from "node:fs";
import { dirname } from "node:path";

export const name = "dsh-xxx-hook";
export const inject = []; // 纯 hook 不依赖任何宿主服务

// 配置 schema (可选但推荐)
export const Config = z.object({
  enabled: z.boolean().default(true),
  headerLabel: z.string().default("【xxx注入】"),
  weight: z.number().default(0.9),
  failSilently: z.boolean().default(true),
});

/**
 * 安装 system-prompt/assemble 钩子。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config Config schema 校验后的配置
 */
export async function apply(ctx, config) {
  if (!config.enabled) {
    ctx.logger.info("dsh-xxx-hook: disabled, skipping");
    return;
  }

  // --- 准备数据源 (示例: 读文件, 实际可以是 SQL 查询 / HTTP 请求等) ---
  const dataPath = process.env.DSH_HOME + "/xxx/data.txt";
  let cached = null;
  let cacheTime = 0;
  const CACHE_TTL = 2000; // 2 秒缓存, 避免每次请求磁盘 IO

  const readData = () => {
    const now = Date.now();
    if (cached !== null && (now - cacheTime < CACHE_TTL)) return cached;
    try {
      if (!existsSync(dataPath)) { cached = null; return null; }
      const text = readFileSync(dataPath, "utf-8").trim();
      cached = text || null;
      cacheTime = now;
      return cached;
    } catch (err) {
      if (!config.failSilently) ctx.logger.warn(`dsh-xxx-hook: read failed: ${err.message}`);
      return null;
    }
  };

  // 文件变化自动清缓存 (autoReload)
  try {
    watch(dirname(dataPath), (eventType, filename) => {
      if (filename) { cached = null; ctx.logger.info("dsh-xxx-hook: data updated"); }
    });
  } catch (err) {
    if (!config.failSilently) ctx.logger.warn(`dsh-xxx-hook: watch failed: ${err.message}`);
  }

  // --- 核心: system-prompt/assemble waterfall 钩子 ---
  ctx.on("system-prompt/assemble", async (assembly, _ctx, next) => {
    try {
      const data = readData();
      if (data) {
        assembly.contexts.push({
          name: "xxx-hook",                 // ← 全局唯一, 不要跟其他插件重名
          text: `${config.headerLabel}\n${data}`,
          weight: config.weight,
        });
      }
    } catch (err) {
      // 钩子失败要静默, 别 throw, 下一次请求继续试
      if (!config.failSilently) ctx.logger.warn(`dsh-xxx-hook: hook error: ${err.message}`);
    }
    return next(); // ← waterfall 链必须继续
  });

  ctx.logger.info("dsh-xxx-hook: ready");
}
```

***

## 两种类型的对比

| <br />             | 类型 A: 路由 + 客户端                | 类型 B: 纯 hook                 |
| ------------------ | ----------------------------- | ---------------------------- |
| 有 WebUI            | ✅ 有（settings.section 插槽）      | ❌ 无                          |
| 有宿主路由              | ✅ 有（ctx.effect 注册）            | ❌ 无                          |
| 有 system-prompt 注入 | 可选                            | ✅ 核心                         |
| package.json 字段    | dsh.bundle.patch + dsh.client | 只有 dsh.bundle.patch          |
| 宿主端 inject         | `["webServer"]` 必需            | `[]` 空数组或按需                  |
| exports            | 需导出 `./client`                | 不需                           |
| files              | `["lib", "cordis.patch.yml"]` | 同                            |
| client.js          | 必需                            | 不存在                          |
| 适用场景               | 设置面板 + 后端 API（如会话清理、统计）       | system prompt 注入（如用户规则、祖宗记忆） |

***

## 类型 B → 类型 A 升级路径（纯 hook 插件加 WebUI 设置入口）

> 触发场景：纯 hook 插件（如 dsh-rules、dsh-memory）做了一段时间后，想加 WebUI 开关、配置面板。
>
> **踩过的坑**：直接把 `lib/client.js` 丢进 plugins/ 目录重启服务，结果客户端模块注册表 `ClientModuleRegistry.resolveMeta()` 找不到 `exports["./client"]` → 整个插件的 client 模块被跳过 → WebUI 入口不出现。更严重的情况：package.json 里没加 `dsh.client` 但有了 client.js 文件，会让注册表去 `require.resolve` 失败直接炸服务。

### 必须改的三个地方

**1. package.json 加两个声明**

```json
{
  // 原来只有 dsh.bundle.patch，现在加 dsh.client + exports["./client"]
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",          // ← 新增！让客户端模块注册表能 resolve
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml"],     // ← 原来可能没 files 数组，确保 cordis.patch.yml 包含
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {                              // ← 新增！声明 WebUI 客户端入口
      "inject": ["slots"],
      "platform": "web"
    }
  }
}
```

**2. lib/index.js 加** **`inject`** **依赖 + 路由注册**

```javascript
// 原来: export const inject = [];  // 纯 hook 不依赖宿主服务
// 现在: 需要 webServer 来注册 config GET/POST 路由
export const inject = ["webServer"];

export async function apply(ctx, config) {
  // ...原有 hook 安装逻辑...

  // 新增: 注册 config 路由 (enabled 开关持久化)
  const disposers = [];
  if (ctx.webServer) {
    disposers.push(ctx.webServer.register({
      kind: "exact",
      path: "/__dsh/xxx/config",
      method: "GET",  // 注意: 某些版本 register 不支持 method, 分流在 handler 里按 req.method
      handler: (req, res) => { /* ... */ },
    }));
    disposers.push(ctx.webServer.register({
      kind: "exact",
      path: "/__dsh/xxx/config",
      method: "POST",
      handler: (req, res) => { /* ... */ },
    }));
  }

  ctx.effect(() => () => { for (const d of disposers) d(); }, "xxx:cleanup");
}
```

**⚠️ 路由注册踩坑提醒**：某些版本的 `webServer.register` **不支持** **`method`** **字段**，同一 path 只能注册一次。如果报 "Duplicate (kind,path)" 错误，改成在**同一个 handler 里按** **`req.method`** **分流 GET/POST**：

```javascript
ctx.webServer.register({
  kind: "exact",
  path: "/__dsh/xxx/config",
  handler: async (req, res) => {
    if (req.method === "GET") { /* ... */ }
    else if (req.method === "POST") { /* ... */ }
    else { res.writeHead(405); res.end(); }
  },
});
```

**3. 新建 lib/client.js**

见下方"持久化配置 + WebUI 开关"完整模板。

***

## 持久化配置 + WebUI 开关（通用模式）

> 适用场景：插件有 `enabled` 总开关，默认关闭（省 token），用户从 WebUI 打开后重启生效。
>
> 参考实作：dsh-memory v3（祖宗记忆库）、dsh-rules v3（用户规则）

### 架构图

```
┌─────────────────────────────────────────────────────────────┐
│ DSH_HOME/config.json (cordis.yml)                           │
│   ↓                                                         │
│ Config schema 默认值 (enabled: false)                        │
│   ↓ 合并                                                    │
│ ${DSH_HOME}/xxx/xxx-config.json (WebUI 持久化 json)          │
│   ↓                                                         │
│ apply() 最终生效配置 → enabled=false 跳过 hooks 安装         │
│                          → enabled=true 正常装 hooks         │
└─────────────────────────────────────────────────────────────┘

WebUI 设置页:
  [ ] 启用插件 (默认关闭)  [保存] [刷新]
       ↓ POST /__dsh/xxx/config  {enabled: true}
       ↓ 写 json 文件
       ↓ 提示"下次启动 DSH 后生效"
```

### 宿主端完整骨架（lib/index.js）

```javascript
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import z from "@deepseek-ai/schemastery";

export const name = "dsh-xxx";
export const inject = ["webServer"];

// Config schema — enabled 默认 false (省 token / 按需开启)
export const Config = z.object({
  enabled: z.boolean().default(false),
  // ...其他配置字段...
});

/** 持久化 json 文件路径: ${DSH_HOME}/xxx/xxx-config.json */
function _persistPath() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "xxx", "xxx-config.json");
}

/** 读持久化 json (文件不存在 → 空对象) */
function _loadPersist() {
  const p = _persistPath();
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf-8")) || {}; }
  catch { return {}; }
}

/** 写持久化 json (自动建目录) */
function _savePersist(patch) {
  const persist = _persistPath();
  const dir = dirname(persist);
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* 静默 */ }
  }
  const existing = _loadPersist();
  const merged = { ...existing, ...patch };
  writeFileSync(persist, JSON.stringify(merged, null, 2), "utf-8");
  return merged;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

export async function apply(ctx, config) {
  // === Step 1: 合并持久化配置 (json 覆盖 cordis.yml 默认值) ===
  const persist = _loadPersist();
  const mergedConfig = { ...config };
  if (typeof persist.enabled === "boolean") {
    mergedConfig.enabled = persist.enabled;
  }

  // === Step 2: 注册 config GET/POST 路由 ===
  const disposers = [];
  if (ctx.webServer) {
    // 某些版本 register 不支持 method 字段 —— 同一个 handler 里分流
    disposers.push(ctx.webServer.register({
      kind: "exact",
      path: "/__dsh/xxx/config",
      handler: (req, res) => {
        if (req.method === "GET") {
          const p = _loadPersist();
          sendJson(res, 200, {
            ok: true,
            config: {
              enabled: Boolean(p.enabled ?? mergedConfig.enabled),
              // 其他要暴露给 WebUI 的字段...
            },
            persisted: p,
          });
          return;
        }
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
          return;
        }
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
          let parsed = {};
          try { parsed = JSON.parse(body) || {}; } catch { /* 忽略 */ }
          const patch = {};
          if (typeof parsed.enabled === "boolean") patch.enabled = parsed.enabled;
          if (Object.keys(patch).length === 0) {
            sendJson(res, 400, { ok: false, error: "无可保存字段" });
            return;
          }
          const merged = _savePersist(patch);
          sendJson(res, 200, {
            ok: true,
            config: { enabled: Boolean(merged.enabled ?? mergedConfig.enabled) },
            note: "配置已保存, 下次启动 DSH 后生效",
          });
        });
      },
    }));
    ctx.logger.info("dsh-xxx: config route registered");
  }

  // === Step 3: enabled=false → 跳过 hooks 安装 (但路由始终注册, 方便用户随时改开关) ===
  if (!mergedConfig.enabled) {
    ctx.logger.info("dsh-xxx: disabled (enabled=false), skip hooks");
    ctx.effect(() => () => { for (const d of disposers) d(); }, "dsh-xxx");
    return;
  }

  // === Step 4: enabled=true → 正常装 hooks ===
  // ctx.on("system-prompt/assemble", ...) 或 ctx.effect(() => ctx.tools.register(...)) 等
  ctx.logger.info("dsh-xxx: ready");

  ctx.effect(() => () => { for (const d of disposers) d(); }, "dsh-xxx:cleanup");
}
```

### 客户端完整骨架（lib/client.js）

```javascript
// DSH 插件客户端加载器契约
window.__ModuleLoader__.load({
  id: "dsh-xxx",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");
    const inject = ["slots"];
    const ROUTE_CONFIG = "/__dsh/xxx/config";

    async function fetchConfig() {
      const resp = await fetch(ROUTE_CONFIG);
      const payload = await resp.json().catch(() => null);
      if (!resp.ok || payload === null || payload.ok !== true)
        throw new Error((payload && payload.error) || ("HTTP " + resp.status));
      return payload;
    }

    async function saveConfig(overrides) {
      const resp = await fetch(ROUTE_CONFIG, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(overrides),
      });
      const payload = await resp.json().catch(() => null);
      if (!resp.ok || payload === null || payload.ok !== true)
        throw new Error((payload && payload.error) || ("HTTP " + resp.status));
      return payload;
    }

    function XxxSection() {
      const [enabled, setEnabled] = react.useState(null);   // null = 加载中
      const [saving, setSaving] = react.useState(false);
      const [savedTip, setSavedTip] = react.useState(null);
      const [error, setError] = react.useState(null);
      const loadedRef = react.useRef(false);

      const loadAll = react.useCallback(async () => {
        setError(null);
        try {
          const payload = await fetchConfig();
          setEnabled(Boolean(payload.config.enabled));
        } catch (err) {
          setEnabled(false);
          setError("读取配置失败: " + String((err && err.message) || err));
        }
      }, []);

      const handleSave = async (newValue) => {
        setSaving(true);
        setSavedTip(null);
        setError(null);
        try {
          const payload = await saveConfig({ enabled: newValue });
          setEnabled(newValue);
          setSavedTip(payload.note || "已保存, 下次启动 DSH 后生效");
        } catch (err) {
          setError("保存失败: " + String((err && err.message) || err));
        } finally {
          setSaving(false);
        }
      };

      if (!loadedRef.current) { loadedRef.current = true; loadAll(); }

      return react.createElement("div", { style: { padding: "12px 8px", maxWidth: 640 } },
        // 标题 + 说明
        react.createElement("p", { style: { margin: 0, fontSize: 14, fontWeight: 600 } },
          "插件名称设置"
        ),
        react.createElement("p", { style: { margin: "4px 0 12px", fontSize: 12, color: "#888" } },
          "开启后会占用少量 system prompt token, 建议按需开启。"
        ),
        // 【测试】标签 (可选, 表示功能不完善)
        react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
          react.createElement("span", { style: {
            padding: "1px 8px", borderRadius: 8, fontSize: 10, fontWeight: 600,
            background: "rgba(245, 158, 11, 0.2)", color: "#f59e0b",
            border: "1px solid rgba(245, 158, 11, 0.4)",
          }}, "【测试】"),
          react.createElement("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" } },
            react.createElement("input", {
              type: "checkbox",
              checked: enabled,
              disabled: saving || enabled === null,
              onChange: (e) => handleSave(e.target.checked),
              style: { cursor: saving ? "default" : "pointer" },
            }),
            react.createElement("span", null,
              enabled === null ? "加载中…" :
              enabled ? "已启用 (下次启动生效)" : "已关闭 (节省 token)"
            ),
          ),
        ),
        // 错误提示
        error && react.createElement("p", { style: { margin: "8px 0 0", fontSize: 12, color: "#e74c3c" } }, error),
        // 保存提示
        savedTip && react.createElement("p", { style: { margin: "8px 0 0", fontSize: 12, color: "#27ae60" } }, savedTip),
      );
    }

    function apply(ctx) {
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "dsh-xxx",
        order: 500,           // 数字越大越靠下, 同类插件保持一致
        label: "插件名称",
      }, XxxSection));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
```

### 这个模式的核心设计决策

| 决策                           | 理由                                                                   |
| ---------------------------- | -------------------------------------------------------------------- |
| **enabled 默认 false**         | system-prompt 注入类插件占 token，默认关闭让用户自己决定                               |
| **持久化 json 独立于 cordis.yml**  | 用户可能手动编辑 cordis.yml 覆盖 WebUI 开关；独立 json 文件是"用户态覆盖层"，优先级更高            |
| **路由始终注册，hooks 按 enabled 装** | enabled=false 时用户仍能打开 WebUI 改开关（路由在），但不消耗 token（hooks 不在）；改完开关提示重启生效 |
| **POST 只支持 enabled 一个字段**    | 其他配置（rulesPath/weight 等）用户不太会从 WebUI 改，保持 POST 接口简单；需要扩展时在 patch 里加  |
| **提示"下次启动生效"**               | 因为 apply() 只在启动时跑一次，WebUI 改了 json 不会热插拔 hooks；简单明确，不误导用户             |

```bash
# 查看合成后的插件树 (确认 bundle 补丁生效)
node <dsh>/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --dump-config

# 确认 system-prompt 钩子注册 (启动后看 server.log)
grep "system-prompt" runtime/server.log

# 确认 context.name 没重复 (手动 dump assembly, 或发消息看 prompt 组装日志)
```

