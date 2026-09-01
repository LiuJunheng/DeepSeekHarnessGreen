# DSH 插件骨架参考

> 两种插件类型的完整代码骨架。开发新插件直接复制对应模板改名字。
>
> **Cordis 协议硬约束**（所有模板都已遵守，不要再改）：
> - 宿主端导出函数名**必须是** `apply`（不是 `setup`/`init`/`install`）
> - 纯客户端插件也必须带宿主端 `lib/index.js`（哪怕 no-op）
> - `exports` 必须包含 `"./package.json": "./package.json"`
> - 装完服务退出 = 对照 `plugin-dev-checklist.md` 零→二节排查

---

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

---

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

---

## 两种类型的对比

| | 类型 A: 路由 + 客户端 | 类型 B: 纯 hook |
|---|---|---|
| 有 WebUI | ✅ 有（settings.section 插槽） | ❌ 无 |
| 有宿主路由 | ✅ 有（ctx.effect 注册） | ❌ 无 |
| 有 system-prompt 注入 | 可选 | ✅ 核心 |
| package.json 字段 | dsh.bundle.patch + dsh.client | 只有 dsh.bundle.patch |
| 宿主端 inject | `["webServer"]` 必需 | `[]` 空数组或按需 |
| exports | 需导出 `./client` | 不需 |
| files | `["lib", "cordis.patch.yml"]` | 同 |
| client.js | 必需 | 不存在 |
| 适用场景 | 设置面板 + 后端 API（如会话清理、统计） | system prompt 注入（如用户规则、祖宗记忆） |

## 验证命令

```bash
# 查看合成后的插件树 (确认 bundle 补丁生效)
node <dsh>/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --dump-config

# 确认 system-prompt 钩子注册 (启动后看 server.log)
grep "system-prompt" runtime/server.log

# 确认 context.name 没重复 (手动 dump assembly, 或发消息看 prompt 组装日志)
```
