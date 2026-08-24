// DeepSeek Harness 插件 (客户端): dsh-media-background
// 往 WebUI 注入"背景视频"能力 (命名空间 dsw-mbg):
//   - 全屏 <video> 作半透明背景层 (position fixed inset:0, z-index:0, pointer-events:none),
//     对话内容正常显示在上, 视频作为半透明壁纸透出, 浓度(opacity)滑块可调。
//   - 右下角浮动按钮「🎬 观星」+ 面板: 目录 / 视频列表 / 播放清单 / 播放控制。
// 数据走宿主端路由 (带防御头):
//   GET  /__dsh/media-bg/config  -> {ok, dir, from}
//   POST /__dsh/media-bg/config  -> {ok, dir}  (面板里改目录)
//   GET  /__dsh/media-bg/list    -> {ok, dir, files:[{name, path, size, url}]}
// <video> 的 src 用 host 端返回的 stream URL (该路由不带防御头, 见 index.js 说明)。
window.__ModuleLoader__.load({
	id: "dsh-media-background",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;

		// ---- 常量 ----
		const API = "/__dsh/media-bg";
		const GUARD = "X-DSH-Media-Bg";
		const STORE_KEY = "dsw-mbg-v1";      // 面板里清单 / 音量 / 浓度 / 循环 等偏好

		// ---- 状态 ----
		var S = {
			dir: "",                          // 当前生效目录 (host 返回)
			files: [],                        // 目录扫出的视频
			list: [],                         // 播放清单 [{name, url}]
			cur: -1,                          // 清单当前播放下标
			preview: null,                    // {name, url} 试播中的单曲 (不入清单)
			playing: false,
			active: false,                    // 背景是否开启 (video 是否挂载)
			panelOpen: false,
			volume: 0.7,
			opacity: 0.35,
			loop: true,                       // 循环开关 (默认开; 实质清单循环见 onEnded)
		};

		// ---- DOM 引用 ----
		var btn = null, panel = null, dirInput = null, listEl = null;
		var playlistEl = null, statusEl = null, playIcon = null;
		var videoEl = null, rootEl = null;
		// 目录浏览弹窗元素。
		var browseEl = null, browseBody = null, browsePathEl = null, browseBack = null;
		// 目录浏览状态: 当前浏览的绝对路径 (空=根/我的电脑)。
		var browseDir = "";

		// ---- 工具 ----
		function el(tag, props, children) {
			const node = document.createElement(tag);
			if (props) {
				for (const key in props) {
					if (key === "style") Object.assign(node.style, props[key]);
					else if (key === "on") {
						for (const ev in props[key]) node.addEventListener(ev, props[key][ev]);
					} else {
						node[key] = props[key];
					}
				}
			}
			if (children) {
				for (const child of [].concat(children)) {
					node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
				}
			}
			return node;
		}

		function errMessage(error) {
			return (error && error.message) ? error.message : String(error);
		}

		/** 带防御头的 JSON POST, 返回 payload (host 侧 ok 校验)。 */
		async function postJson(method, payload) {
			const response = await fetch(API + "/" + method, {
				method: "POST",
				headers: { "content-type": "application/json", [GUARD]: "1" },
				body: JSON.stringify(payload),
			});
			const data = await response.json().catch(() => null);
			if (!response.ok || data === null || data.ok !== true) {
				throw new Error((data && data.error) || ("HTTP " + response.status));
			}
			return data;
		}

		/** 带防御头的 GET (可带查询参数), 返回 payload (host 侧 ok 校验)。 */
		async function getJson(method) {
			const response = await fetch(API + "/" + method, { headers: { [GUARD]: "1" } });
			const data = await response.json().catch(() => null);
			if (!response.ok || data === null || data.ok !== true) {
				throw new Error((data && data.error) || ("HTTP " + response.status));
			}
			return data;
		}

		/** 带防御头的 GET + 查询参数组合 (目录浏览用)。 */
		async function browseQuery(entries) {
			const query = new URLSearchParams();
			for (const key in entries) query.set(key, entries[key]);
			const suffix = query.toString() ? ("?" + query.toString()) : "";
			const response = await fetch(API + "/browse" + suffix, { headers: { [GUARD]: "1" } });
			const data = await response.json().catch(() => null);
			if (!response.ok || data === null || data.ok !== true) {
				throw new Error((data && data.error) || ("HTTP " + response.status));
			}
			return data;
		}

		// ---- 持久化 (localStorage) ----
		function saveStore() {
			try {
				localStorage.setItem(STORE_KEY, JSON.stringify({
					list: S.list,
					volume: S.volume,
					opacity: S.opacity,
					loop: S.loop,
				}));
			} catch (error) { /* 忽略存储失败 */ }
		}

		function loadStore() {
			try {
				const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
				if (Array.isArray(saved.list)) S.list = saved.list;
				if (typeof saved.volume === "number") S.volume = saved.volume;
				if (typeof saved.opacity === "number") S.opacity = saved.opacity;
				if (typeof saved.loop === "boolean") S.loop = saved.loop;
			} catch (error) { /* 读取失败用默认 */ }
		}

		// ---- 背景视频层 ----
		function ensureVideo() {
			if (videoEl == null) {
				videoEl = document.createElement("video");
				videoEl.id = "dsw-mbg-video";
				videoEl.style.cssText =
					"position:fixed;inset:0;width:100vw;height:100vh;object-fit:cover;" +
					"z-index:0;pointer-events:none;background:#000;";
				videoEl.muted = (S.volume === 0);
				videoEl.setAttribute("playsinline", "");
				// 播放结束自动切下一首 (或按循环策略处理)。
				videoEl.addEventListener("ended", onEnded);
			}
			if (videoEl.parentNode !== document.body) {
				// 插到 <body> 最前 (firstChild): 与 harness 工作区同为普通层 (z-index auto/0) 时,
				// DOM 顺序在后者绘制在上 → 工作区文字永久浮于视频之上, 不会随浓度拉高被遮住;
				// 浓度只控制视频自身透明度 (applyVideoAppearance), 不影响工作区文字。
				document.body.insertBefore(videoEl, document.body.firstChild);
			}
			applyVideoAppearance();
			return videoEl;
		}

		function applyVideoAppearance() {
			if (!videoEl) return;
			videoEl.style.opacity = String(S.opacity);
		}

		/** 切换整体背景: on=true 时让 WebUI 背景板全透明(只露视频), false 时恢复原生纯色壁纸。 */
		function setBackgroundActive(on) {
			if (on) document.documentElement.classList.add("dsw-mbg-active");
			else document.documentElement.classList.remove("dsw-mbg-active");
		}

		function onEnded() {
			if (S.preview) {
				stop();
				return;
			}
			if (!S.list.length || S.cur < 0) { stop(); return; }
			if (S.cur === S.list.length - 1) {
				// 到清单末尾。
				if (S.loop) playListIndex(0);
				else stop();
			} else {
				playListIndex(S.cur + 1);
			}
		}

		/** 开启背景并播放清单里某项。 */
		function playListIndex(index) {
			if (!S.list.length) { setStatus("请先往播放清单里添加视频"); return; }
			const idx = Math.max(0, Math.min(index, S.list.length - 1));
			S.preview = null;
			S.cur = idx;
			const video = ensureVideo();
			// 禁用浏览器原生单曲 loop: 否则 loop=true 时 ended 不触发,
			// 我们的手动"清单循环/切下一首"逻辑(onEnded)永远不会跑。
			video.loop = false;
			video.volume = S.volume;
			video.src = S.list[idx].url;
			video.play()
				.then(() => { S.playing = true; })
				.catch(() => { S.playing = false; });
			S.active = true;
			setBackgroundActive(true);
			updatePlayIcon();
			setStatus("播放中: " + S.list[idx].name);
			renderPlaylist();
		}

		/** 试播单曲 (不写入清单), 播完即回到默认背景。 */
		function playPreview(url, displayName) {
			const video = ensureVideo();
			video.volume = S.volume;
			video.src = url;
			video.play()
				.then(() => { S.playing = true; })
				.catch(() => { S.playing = false; });
			S.cur = -1;
			S.preview = { name: displayName, url };
			S.active = true;
			setBackgroundActive(true);
			updatePlayIcon();
			setStatus("试播: " + displayName);
		}

		function togglePause() {
			if (!videoEl || videoEl.src === "") return;
			if (videoEl.paused) {
				videoEl.play().finally(() => { S.playing = !videoEl.paused; updatePlayIcon(); });
			} else {
				videoEl.pause();
				S.playing = false;
				updatePlayIcon();
			}
		}

		function next() {
			if (!S.list.length) return;
			if (S.cur < 0) { playListIndex(0); return; }
			playListIndex((S.cur + 1) % S.list.length);
		}

		function prev() {
			if (!S.list.length) return;
			if (S.cur < 0) { playListIndex(0); return; }
			playListIndex((S.cur - 1 + S.list.length) % S.list.length);
		}

		/** 停止并关闭背景, 回到 DeepSeek Harness 原始背景。 */
		function stop() {
			if (videoEl) {
				videoEl.pause();
				videoEl.removeAttribute("src");
				try { videoEl.load(); } catch (error) { /* 忽略 */ }
				if (videoEl.parentNode) {
					try { videoEl.parentNode.removeChild(videoEl); } catch (error) { /* 忽略 */ }
				}
			}
			S.active = false;
			S.playing = false;
			S.cur = -1;
			S.preview = null;
			setBackgroundActive(false);
			updatePlayIcon();
			setStatus("背景已关闭");
		}

		// ---- 数据加载 ----
		async function loadConfig() {
			try {
				const data = await getJson("config");
				S.dir = data.dir || "";
				if (dirInput) dirInput.value = S.dir;
			} catch (error) {
				setStatus("读取配置失败: " + errMessage(error));
			}
		}

		async function scanList() {
			setStatus("扫描中…");
			try {
				const data = await getJson("list");
				S.dir = data.dir || "";
				S.files = data.files || [];
				if (dirInput) dirInput.value = S.dir;
				if (data.error) setStatus(data.error);
				renderFiles();
				updateStatus();
			} catch (error) {
				setStatus("扫描失败: " + errMessage(error));
			}
		}

		async function commitDir() {
			const dirValue = dirInput ? dirInput.value.trim() : "";
			if (!dirValue) { setStatus("目录不能为空"); return; }
			setStatus("设置目录…");
			try {
				await postJson("config", { dir: dirValue });
				S.dir = dirValue;
				setStatus("目录已设置, 正在扫描…");
				await scanList();
			} catch (error) {
				setStatus("设置目录失败: " + errMessage(error));
			}
		}

		// ---- 目录浏览 (优先 Windows 原生文件夹选择框; 回退网页逐层下钻) ----
		/** 「选目录…」入口: 先尝试服务端弹出 Windows 原生文件夹选择框, 失败/取消再回退网页浏览。 */
		async function openBrowse() {
			try {
				const query = new URLSearchParams({ path: S.dir || "" });
				const response = await fetch(API + "/pickdir?" + query.toString(), { headers: { [GUARD]: "1" } });
				const data = await response.json().catch(() => null);
				if (data && data.ok === true && data.dir) {
					// 原生选择框已得到结果: 回填输入框并应用, 不再打开网页浏览弹窗。
					if (dirInput) dirInput.value = data.dir;
					commitDir();
					return;
				}
			} catch (error) { /* 原生方式不可用时回退网页逐层浏览 */ }
			// 回退: 打开网页内逐层下钻的目录浏览弹窗。
			browseEl.style.display = "flex";
			browseDir = S.dir || "";   // 从当前生效目录开始浏览
			loadBrowse();
		}

		function closeBrowse() {
			browseEl.style.display = "none";
		}

		async function loadBrowse() {
			if (!browsePathEl || !browseBody) return;
			browsePathEl.textContent = browseDir || "我的电脑";
			browseBody.textContent = "";
			try {
				const data = await browseQuery({ path: browseDir });
				if (data.error) {
					browseBody.appendChild(el("div", { className: "bempty", textContent: data.error }));
					return;
				}
				renderBrowseBody(data);
			} catch (error) {
				browseBody.appendChild(el("div", { className: "bempty", textContent: "读取失败: " + errMessage(error) }));
			}
		}

		function renderBrowseBody(data) {
			// 上一级按钮 (根层隐藏)。
			const goUp = el("div", { className: "brow", on: { click: () => { browseDir = data.parent; loadBrowse(); } } }, [
				el("span", { className: "ico", textContent: "↑" }),
				el("span", { className: "nm", textContent: "… (返回上层)" }),
			]);
			if (!data.isRoot) browseBody.appendChild(goUp);
			const children = (data.children || []);
			if (!children.length) {
				browseBody.appendChild(el("div", { className: "bempty", textContent: "此目录没有子文件夹" }));
			} else {
				for (const child of children) {
					const full = (data.dir ? joinPath(data.dir, child) : child);
					const row = el("div", { className: "brow", on: { click: () => { browseDir = full; loadBrowse(); } } }, [
						el("span", { className: "ico", textContent: "📁" }),
						el("span", { className: "nm", textContent: child }),
					]);
					browseBody.appendChild(row);
				}
			}
		}

		function joinPath(base, child) {
			if (!base) return child;
			const sep = (/\\$/.test(base) || /\/$/.test(base)) ? "" : "\\";
			return base + sep + child;
		}

		/** 点击"使用此目录": 把当前浏览目录填进输入框并应用。 */
		function useBrowsedDir() {
			if (!browseDir) { setStatus("未选择目录"); return; }
			if (dirInput) dirInput.value = browseDir;
			closeBrowse();
			commitDir();
		}

		// ---- 渲染 ----
		function setStatus(text) {
			if (statusEl) statusEl.textContent = text;
		}

		function updateStatus() {
			const mode = S.list.length ?("清单 " + S.list.length + " 首 · 目录: " + S.dir) : ("目录: " + (S.dir || "未配置"));
			setStatus(mode);
		}

		function updatePlayIcon() {
			if (!playIcon) return;
			playIcon.textContent = (S.playing ? "⏸" : "▶");
		}

		function renderFiles() {
			if (!listEl) return;
			listEl.textContent = "";
			if (!S.files.length) {
				listEl.appendChild(el("div", { className: "dsw-mbg-tip" }, "该目录下没有可播放的视频 (支持 mp4/webm/m4v/mov/ogg)"));
				return;
			}
			for (const file of S.files) {
				const row = el("div", { className: "dsw-mbg-item" }, [
					el("span", { className: "dsw-mbg-name", title: file.name }, file.name),
					el("button", {
						className: "dsw-mbg-act",
						title: "试播",
						textContent: "▷",
						on: { click: (ev) => { ev.stopPropagation(); playPreview(file.url, file.name); } },
					}),
					el("button", {
						className: "dsw-mbg-act",
						title: "加入播放清单",
						textContent: "＋",
						on: { click: (ev) => { ev.stopPropagation(); addToList(file); } },
					}),
				]);
				// 整行点击 = 加入清单并从该项开始播放 (最直观的"点击就播")。
				row.addEventListener("click", () => {
					addToList(file, true);
				});
				listEl.appendChild(row);
			}
		}

		function addToList(file, playNow) {
			const exists = S.list.some((item) => item.url === file.url);
			if (exists) {
				// 已在清单, 直接播它即可。
				if (playNow) playListIndex(S.list.findIndex((item) => item.url === file.url));
				return;
			}
			S.list.push({ name: file.name, url: file.url });
			saveStore();
			renderPlaylist();
			updateStatus();
			if (playNow) playListIndex(S.list.length - 1);
			// 清单从空变成非空且尚未播放时: 自动从第一首开始播放 (自动循环开始)。
			else if (S.list.length === 1 && !S.active) playListIndex(0);
		}

		function removeFromList(index) {
			S.list.splice(index, 1);
			if (S.cur >= S.list.length) S.cur = S.list.length - 1;
			saveStore();
			renderPlaylist();
			updateStatus();
		}

		function clearList() {
			S.list = [];
			S.cur = -1;
			saveStore();
			renderPlaylist();
			updateStatus();
		}

		function renderPlaylist() {
			if (!playlistEl) return;
			playlistEl.textContent = "";
			if (!S.list.length) {
				playlistEl.appendChild(el("div", { className: "dsw-mbg-tip" }, "播放清单为空"));
				return;
			}
			S.list.forEach((item, index) => {
				const isCur = (index === S.cur);
				const row = el("div", { className: "dsw-mbg-item" + (isCur ? " cur" : "") }, [
					el("span", { className: "dsw-mbg-name", title: item.name },
						((index + 1) + ". " + item.name)),
					el("button", {
						className: "dsw-mbg-act", title: "移除", textContent: "✕",
						on: { click: (ev) => { ev.stopPropagation(); removeFromList(index); } },
					}),
				]);
				row.addEventListener("click", () => playListIndex(index));
				playlistEl.appendChild(row);
			});
		}

		// ---- 面板构建 ----
		function cssText() {
			const css = [
				'#dsw-mbg-btn{cursor:pointer;}' ,
				'#dsw-mbg-panel{position:fixed;right:14px;top:14px;width:340px;height:70vh;max-height:560px;' +
					'display:none;flex-direction:column;z-index:2147483001;background:rgba(24,28,36,.78);' +
					'border:1px solid rgba(255,255,255,.14);border-radius:12px;color:#dbe2ec;font-size:13px;' +
					'font-family:inherit;backdrop-filter:blur(14px);}',
				'#dsw-mbg-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.1);}',
				'#dsw-mbg-title{flex:1;font-weight:600;font-size:14px;}',
				'.dsw-mbg-b{padding:4px 10px;border-radius:7px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.07);color:#dbe2ec;font-size:12px;cursor:pointer;}',
				'.dsw-mbg-b:hover{background:rgba(255,255,255,.15);}',
				'.dsw-mbg-b.on{background:#3b82f6;border-color:#3b82f6;color:#fff;}',
				'#dsw-mbg-dirrow{display:flex;gap:6px;align-items:center;padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.08);}',
				'#dsw-mbg-dir{flex:1;min-width:0;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.22);border-radius:6px;color:#fff;font-size:12.5px;padding:5px 8px;}',
				'.dsw-mbg-block{padding:6px 10px;}',
				'.dsw-mbg-cap{font-size:11.5px;color:#8b95a5;margin:4px 2px;}',
				'#dsw-mbg-list,#dsw-mbg-playlist{overflow-y:auto;min-height:70px;max-height:150px;}',
				'.dsw-mbg-item{display:flex;gap:6px;align-items:center;width:100%;padding:4px 6px;border-radius:6px;cursor:pointer;}',
				'.dsw-mbg-item:hover{background:rgba(255,255,255,.09);}',
				'.dsw-mbg-item.cur{background:rgba(59,130,246,.28);}',
				'.dsw-mbg-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
				'.dsw-mbg-act{flex-shrink:0;cursor:pointer;border:0;background:transparent;color:#9aa4b2;padding:0 4px;font-size:13px;}',
				'.dsw-mbg-act:hover{color:#fff;}',
				'.dsw-mbg-tip{color:#8b95a5;font-size:12px;padding:6px;}',
				'#dsw-mbg-ctl{border-top:1px solid rgba(255,255,255,.1);padding:8px 12px 10px;display:flex;flex-direction:column;gap:6px;}',
				'.dsw-mbg-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
				'.dsw-mbg-lab{font-size:11.5px;color:#8b95a5;min-width:34px;}',
				'.dsw-mbg-vol{flex:1;min-width:80px;accent-color:#3b82f6;}',
				'#dsw-mbg-status{color:#9aa4b2;font-size:11.5px;padding:6px 12px;border-top:1px solid rgba(255,255,255,.08);min-height:16px;}',
			// 目录浏览弹窗 (覆盖层)。
			'#dsw-mbg-browse{position:fixed;inset:0;z-index:2147483002;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.45);}',
			'#dsw-mbg-browse .box{width:440px;max-width:90vw;height:60vh;display:flex;flex-direction:column;background:rgba(24,28,36,.96);border:1px solid rgba(255,255,255,.16);border-radius:12px;color:#dbe2ec;font-size:13px;}',
			'#dsw-mbg-browse .bd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.1);}',
			'#dsw-mbg-browse .bpath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;color:#cfd6e1;}',
			'#dsw-mbg-browse .bbody{flex:1;overflow-y:auto;padding:6px;}',
			'#dsw-mbg-browse .brow{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:6px;cursor:pointer;}',
			'#dsw-mbg-browse .brow:hover{background:rgba(255,255,255,.09);}',
			'#dsw-mbg-browse .brow .ico{width:18px;text-align:center;flex-shrink:0;}',
			'#dsw-mbg-browse .brow .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
			'#dsw-mbg-browse .bempty{color:#8b95a5;font-size:12.5px;padding:14px;text-align:center;}',
			'#dsw-mbg-browse .bfoot{display:flex;align-items:center;gap:8px;padding:10px 12px;border-top:1px solid rgba(255,255,255,.1);}',
			// 动态背景开关: 播放视频时(<html>.dsw-mbg-active)把 WebUI 整窗背景板置为透明,
			// 让作为背景的 <video> 透出; 停止时移除该类即恢复 DeepSeek Harness 原生纯色壁纸。
			// 只透明化页面底座 token(--dsw-alias-bg-base, 即空壁纸/聊天画布背景),
			// 刻意不动 layer-1/2/3 / specific-menu / bg-mask 等浮层 token ——
			// 设置界面等悬浮面板用 var(--dsw-alias-bg-layer-N) 作背景, 保留不透明才不会把设置透掉。
			'html.dsw-mbg-active body{background:transparent!important;--dsw-alias-bg-base:transparent!important;}',
			'html.dsw-mbg-active #root{background:transparent!important;}',
		].join("\n");
			const style = document.createElement("style");
			style.id = "dsw-mbg-css";
			style.textContent = css;
			return style;
		}

		function buildUI() {
			rootEl = el("div", { id: "dsw-mbg-root" });
			document.head.appendChild(cssText());
			document.body.appendChild(rootEl);

			// 右下角浮动按钮。
			btn = el("button", {
				id: "dsw-mbg-btn",
				on: { click: togglePanel },
			});
			btn.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:2147483000;padding:8px 14px;" +
				"border-radius:20px;border:1px solid rgba(255,255,255,.25);background:rgba(18,20,26,.78);" +
				"color:#e8ecf2;font-size:13px;backdrop-filter:blur(6px);";
			btn.textContent = "🎬 观星";
			rootEl.appendChild(btn);

			// 面板。
			const head = el("div", { id: "dsw-mbg-head" }, [
				el("span", { id: "dsw-mbg-title", textContent: "观星 · 背景影画" }),
				el("button", { className: "dsw-mbg-b", textContent: "✕", on: { click: () => { S.panelOpen = false; panel.style.display = "none"; } } }),
			]);
			const dirRow = el("div", { id: "dsw-mbg-dirrow" }, [
				(dirInput = el("input", { id: "dsw-mbg-dir", type: "text", placeholder: "输入视频目录绝对路径，如 D:\\Videos", value: S.dir })),
				el("button", { className: "dsw-mbg-b", textContent: "选目录…", title: "优先使用 Windows 文件选择框选择目录", on: { click: openBrowse } }),
				el("button", { className: "dsw-mbg-b", textContent: "扫描", on: { click: commitDir } }),
			]);
			listEl = el("div", { id: "dsw-mbg-list" });
			playlistEl = el("div", { id: "dsw-mbg-playlist" });
			const fileBlock = el("div", { className: "dsw-mbg-block" }, [
				el("div", { className: "dsw-mbg-cap" }, "目录视频（点击即播，▷ 试播，＋ 加入清单）"),
				listEl,
			]);
			const playBlock = el("div", { className: "dsw-mbg-block" }, [
				el("div", { className: "dsw-mbg-cap" }, "播放清单"),
				playlistEl,
			]);
			playIcon = el("span", {});
			const ctl = el("div", { id: "dsw-mbg-ctl" }, [
				el("div", { className: "dsw-mbg-row" }, [
					el("button", { className: "dsw-mbg-b", textContent: "⏮", title: "上一首", on: { click: prev } }),
					el("button", { className: "dsw-mbg-b dsw-mbg-play", on: { click: togglePause } }, playIcon),
					el("button", { className: "dsw-mbg-b", textContent: "⏭", title: "下一首", on: { click: next } }),
					el("button", { className: "dsw-mbg-b", textContent: "⏹", title: "停止并关闭背景", on: { click: stop } }),
					el("button", { className: "dsw-mbg-b", textContent: "清空清单", on: { click: clearList } }),
				]),
				el("div", { className: "dsw-mbg-row" }, [
					el("label", { className: "dsw-mbg-lab", textContent: "音量" }),
					el("input", {
						className: "dsw-mbg-vol", type: "range", min: 0, max: 100, value: Math.round(S.volume * 100),
						on: { input: (ev) => { S.volume = Number(ev.target.value) / 100; if (videoEl) { videoEl.volume = S.volume; videoEl.muted = (S.volume === 0); } saveStore(); } },
					}),
				]),
				el("div", { className: "dsw-mbg-row" }, [
					el("label", { className: "dsw-mbg-lab", textContent: "浓度" }),
					el("input", {
						className: "dsw-mbg-vol", type: "range", min: 0, max: 100, value: Math.round(S.opacity * 100),
						on: { input: (ev) => { S.opacity = Number(ev.target.value) / 100; applyVideoAppearance(); saveStore(); } },
					}),
					el("label", { className: "dsw-mbg-lab", textContent: "循环" }),
					el("input", { type: "checkbox", checked: S.loop, on: { change: (ev) => { S.loop = ev.target.checked; saveStore(); } } }),
				]),
			]);
			statusEl = el("div", { id: "dsw-mbg-status", textContent: "加载中…" });
			panel = el("div", { id: "dsw-mbg-panel" }, [head, dirRow, fileBlock, playBlock, ctl, statusEl]);
			rootEl.appendChild(panel);

			// 目录浏览弹窗 (覆盖整个页面, 在其内部逐层下钻选择目录)。
			(browsePathEl = el("div", { className: "bpath", textContent: "我的电脑" }));
			(browseBody = el("div", { className: "bbody" }));
			const browseBox = el("div", { className: "box" }, [
				el("div", { className: "bd" }, [
					browsePathEl,
					el("button", { className: "dsw-mbg-b", textContent: "关闭", on: { click: closeBrowse } }),
				]),
				browseBody,
				el("div", { className: "bfoot" }, [
					el("button", { className: "dsw-mbg-b", textContent: "使用此目录", on: { click: useBrowsedDir } }),
				]),
			]);
			browseEl = el("div", { id: "dsw-mbg-browse" }, [browseBox]);
			rootEl.appendChild(browseEl);

			function togglePanel() {
				S.panelOpen = !S.panelOpen;
				panel.style.display = S.panelOpen ? "flex" : "none";
			}

			return panel;
		}

		function init() {
			loadStore();
			buildUI();
			applyVideoAppearance();
			updatePlayIcon();
			loadConfig().then(() => {
				scanList();
			});
			renderPlaylist();
			updateStatus();
		}

		// ---- 插件契约 ----
		function apply() {
			init();
		}

		exports.apply = apply;
		return module.exports;
	}
});