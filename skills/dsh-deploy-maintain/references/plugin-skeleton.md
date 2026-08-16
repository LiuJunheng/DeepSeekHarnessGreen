# DSH 插件骨架参考（dsh-archive-purge 实作版）

> 基于 `plugins/dsh-archive-purge` 的完整双端插件，用于 DSH 插件开发的直接参考模板。

## 目录结构

```
dsh-xxx-plugin/
├── lib/
│   ├── index.js       # 宿主端（server-side）：路由注册
│   └── client.js      # 客户端（WebUI）：设置区块注入
├── cordis.patch.yml   # 插件树补丁声明（必须被 files 覆盖）
├── package.json       # dsh.bundle + dsh.client 双端声明
└── README.md          # 插件说明
```

## package.json（双端声明完整版）

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
  "files": [
    "lib",
    "cordis.patch.yml"
  ],
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    "./package.json": "./package.json"
  }
}
```

**关键**：`exports` 必须包含 `"./package.json"`（否则客户端 bundle 不进 `__DSH_BOOT__`）；`files` 必须包含 `cordis.patch.yml`。

> **⚠️ 纯客户端插件也必须带 `lib/index.js`**：宿主 cordis loader 会 import 每个包的 `main`/`exports["."]`，纯客户端插件（只做 WebUI 注入、无宿主路由）若缺 `lib/index.js`，安装后**重启服务会瞬间退出**（`ERR_MODULE_NOT_FOUND: ...lib/index.js`，`plugin tree failed to load`）。纯客户端插件用官方 no-op 写法即可：
> ```js
> // lib/index.js —— 纯客户端插件宿主端 no-op
> function apply() {}
> export { apply };
> ```
> （对照官方 `@deepseek-ai/dsh-client-ui-message-feedback` 的宿主端。2026-08-16 `dsh-message-actions` 实测踩坑，见 SKILL.md 4.9 / DEV_NOTES 避坑 #49）

## cordis.patch.yml

```yaml
- insert:
    - id: archive-purge
      name: archive-purge
```

## 宿主端 lib/index.js 骨架

```js
import { readdir, readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const name = "dsh-xxx-plugin";
const inject = ["webServer", "workspaceRegistry"];  // 按需声明依赖服务

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

function apply(ctx) {
  // 必须把 register 包进 effect 回调，不能先注册再传注销函数
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",            // 或 "prefix"
    path: ROUTE_PATH,
    handler: async (req, res) => {
      // 自定义头校验（防跨站触发）
      if (req.headers[GUARD_HEADER] !== "1") {
        res.writeHead(403);
        res.end();
        return;
      }
      // 方法分发
      if (req.method === "GET") {
        // 列表查询逻辑
        sendJson(res, 200, { ok: true, data: [] });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
        return;
      }
      // POST 处理逻辑
      try {
        const body = await readJsonBody(req);
        sendJson(res, 200, { ok: true, result: "ok" });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error) });
      }
    }
  }), "dsh-xxx-plugin: route");
}

export { apply, inject, name };
```

## 客户端 lib/client.js 骨架

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
        setBusy(true);
        setError(null);
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
        } finally {
          setBusy(false);
        }
      }, []);

      // 首次挂载加载
      const loadedRef = react.useRef(false);
      if (!loadedRef.current) { loadedRef.current = true; load(); }

      return react.createElement("div", { style: { padding: 8 } },
        // 在此渲染 UI
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

> **⚠️ 插槽条目组件禁用"从 props 条件调用 hook"**：standard props 里的 hook（如输入框区域的 `useInput`）是外部传入的函数，身份/可用性在渲染间可能变化；写成 `typeof useInput === "function" ? useInput() : null` 会导致 React "Rendered more/fewer hooks" 被错误边界吞掉、组件不渲染（`data-slot-error` 空占位，控制台 `componentDidCatch`）。需要读快照数据时，优先用 ownerProps 里已有的普通字段——例如 `conversation.input.left` 的 ownerProps 直接带 `input: InputState`（`input.draft` 即当前草稿），`inputActions.setDraft(草稿+文本)` 可追加草稿。详见 `SKILL.md` 4.6 与根项目 `DEV_NOTES.md` 避坑 #42。
> **改客户端源码无需重启服务**：客户端 bundle 按请求从 node_modules 重新生成（rev 哈希变化），强制刷新页面即可生效；只有宿主端改动 / 加减插件才需要重启。

## 数据目录参考

```
runtime/dsh-home/
├── profiles/
│   └── web/                    # 默认 profile
│       ├── package.json        # dependencies + dsh.profile.bundles（插件清单）
│       ├── node_modules/       # 已装插件（pnpm 拷贝）
│       ├── settings.yaml       # 用户设置（API Key 等）
│       └── cordis.patch.yml    # 用户层补丁
├── storages/
│   ├── workspace.json          # 工作区注册表（{path, title, sessionIds, archivedSessionIds, ...}）
│   └── session_projcache.json  # 会话标题/统计缓存
├── sessions/
│   └── <工作区路径编码>/       # 如 --D-DeepSeekHarnessLauncher--
│       └── <会话ID>/           # 会话日志目录
│           └── session.jsonl.zstd  # 日志（header 含 cwd 字段）
└── settings.yaml               # 全局设置
```

## 验证命令

```bash
# 查看合成后的插件树（确认 bundle 补丁生效）
node <dsh>/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --dump-config

# 验证客户端 module 是否进入 __DSH_BOOT__
curl http://127.0.0.1:3080/ | grep __DSH_BOOT__

# 验证 require.resolve 是否成功
node -e "console.log(require.resolve('dsh-xxx-plugin/package.json'))"
```