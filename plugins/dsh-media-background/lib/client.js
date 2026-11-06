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

// i18n 工具函数 (同其他内置插件): 优先读 window.__DSH_I18N__ (启动器桌面壳注入)
function _dsht(key, fallback) {
	try {
		const bridge = window.__DSH_I18N__;
		if (bridge && bridge.current && bridge[bridge.current]) {
			const val = bridge[bridge.current][key];
			if (val !== undefined && val !== null && val !== "") return val;
		}
	} catch (_e) { }
	return fallback || key;
}

window.__ModuleLoader__.load({
	id: "dsh-media-background",
	factory: () => {
		        // === 异步加载 i18n bridge ===
		        (function() {
		            if (window.__DSH_I18N__ && window.__DSH_I18N__._initialized) return;  // 桌面壳已预注入
		            var _s = document.createElement('script');
		            _s.src = 'http://127.0.0.1:3081/__dsh_i18n_bridge.js';
		            _s.onerror = function() { _s.src = 'http://localhost:3081/__dsh_i18n_bridge.js'; };
		            document.head.appendChild(_s);
		        })();
		        // === i18n bridge END ===

		// ---- i18n 语言切换重建监听 ----
		// 观星插件用原生 DOM 构建 UI (不是 React), 所有文案在 buildUI() 里一次性写进 textContent.
		// 需要监听 dsh-i18n-change 事件, 语言一变就销毁旧 DOM 重新 buildUI().
		var _i18nHandlerBound = false;
		function _bindI18nRebuildOnce() {
			if (_i18nHandlerBound) return;
			_i18nHandlerBound = true;
			document.addEventListener('dsh-i18n-change', function() {
				// 销毁旧 rootEl (含浮动按钮 + 面板 + 目录浏览弹窗 + CSS <style>)
				var oldRoot = document.getElementById('dsw-mbg-root');
				if (oldRoot && oldRoot.parentNode) oldRoot.parentNode.removeChild(oldRoot);
				var oldCss = document.getElementById('dsw-mbg-css');
				if (oldCss && oldCss.parentNode) oldCss.parentNode.removeChild(oldCss);
				// 重新构建 + 恢复 UI 状态
				buildUI();
				renderPlaylist();
				updateStatus();
				updatePlayIcon();
				if (videoEl && videoEl.parentNode) {
					applyVideoAppearance();
				}
			});
		}

		var module = { exports: {} };
		var exports = module.exports;

		// ---- 常量 ----
		const API = "/__dsh/media-bg";
		const GUARD = "X-DSH-Media-Bg";
		const STORE_KEY = "dsw-mbg-v1";      // 面板里清单 / 音量 / 浓度 / 播放模式 等偏好

		// ---- 状态 ----
		var S = {
			dir: "",                          // 当前生效目录 (host 返回)
			files: [],                        // 目录扫出的视频
			list: [],                         // 播放清单 [{name, url}]
			cur: -1,                          // 清单当前播放下标
			preview: null,                    // {name, url} 试播中的单曲 (不入清单)
			// 上次真正播放过的媒体项 ({name, url, kind}), 随偏好一起持久化:
			// 启动自动恢复与"点播放但没有任何选中项"时都优先恢复它,
			// 若它已不在清单里, 则回退到清单第一首 (不会指向不存在的下标)。
			lastItem: null,
			playing: false,
			active: false,                    // 背景是否开启 (video 是否挂载)
			panelOpen: false,
			volume: 0.7,
			opacity: 0.35,
			// 播放模式 (持久化在 localStorage):
			//   sequential  = 不循环, 清单播完停止 (旧版"循环"未勾选)
			//   repeat-one  = 单曲循环 (当前项播完从头再来)
			//   repeat-all  = 顺序循环, 清单播完回到第 1 首 (旧版"循环"已勾选)
			//   shuffle     = 随机播放, 每首播完随机换清单里另一首
			// 统一由 playNextAfterEnded() 解释, 手动上一首/下一首也复用同一份状态。
			playMode: "repeat-all",
		};

		// ---- DOM 引用 ----
		var btn = null, panel = null, dirInput = null, listEl = null;
		var playlistEl = null, statusEl = null, playIcon = null;
		var playModeSelect = null;   // 播放模式下拉 (buildUI 时重建)
		var clearInvalidButton = null;   // 「清理失效项」按钮 (buildUI 时重建)
		var videoEl = null, rootEl = null;
		// 播放失败(404/无法解码)的清单地址集合, 形如 { "/__dsh/media-bg/stream?path=...": true }。
		// 只存内存不写 localStorage: 文件可能被用户放回原处, 能播时 play 事件会自动清除标记。
		var invalidUrls = {};
		// 已经为哪些地址做过"重定位"尝试 (url -> true)。同一项只自动扫描一次:
		// 若重定位后的新地址仍失败, 不再触发第二次全目录扫描, 直接走失效反馈。
		var relocateTried = {};
		// 自动播放被浏览器策略拒绝后, 是否还欠用户一次"手势恢复声音"。
		var needsGestureUnmute = false;
		// 是否已经挂上一次性手势监听 (避免重复绑定)。
		var gestureUnmuteArmed = false;
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

		/** 带防御头的 GET, 返回 payload (host 侧 ok 校验)。 */
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
					playMode: S.playMode,
					lastItem: S.lastItem,
				}));
			} catch (error) { /* 忽略存储失败 */ }
		}

		function loadStore() {
			try {
				const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
				if (Array.isArray(saved.list)) {
					// 旧版本清单没有 kind 字段, 一律按"视频"兼容处理。
					S.list = saved.list.map((item) => Object.assign({ kind: "video" }, item));
				}
				if (typeof saved.volume === "number") S.volume = saved.volume;
				if (typeof saved.opacity === "number") S.opacity = saved.opacity;
				// 播放模式: 新版本直接读 playMode; 旧版本只有布尔 loop, 迁移为
				// loop=true → 顺序循环, loop=false → 不循环。非法值一律保持默认。
				var validPlayModes = ["sequential", "repeat-one", "repeat-all", "shuffle"];
				if (typeof saved.playMode === "string" && validPlayModes.indexOf(saved.playMode) >= 0) {
					S.playMode = saved.playMode;
				} else if (typeof saved.loop === "boolean") {
					S.playMode = saved.loop ? "repeat-all" : "sequential";
				}
				// 上次播放项: 只接受带有效 url 的对象; kind 非法时按视频兼容。
				// 老版本没有该字段时保持 null, 启动恢复会自动回退清单第一首。
				if (saved.lastItem && typeof saved.lastItem === "object" && typeof saved.lastItem.url === "string" && saved.lastItem.url) {
					S.lastItem = {
						name: typeof saved.lastItem.name === "string" ? saved.lastItem.name : "",
						url: saved.lastItem.url,
						kind: saved.lastItem.kind === "audio" ? "audio" : "video",
					};
				}
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
			// 用 play/pause 事件同步图标, 比自己维护 S.playing 准确 (video.paused 才是真实状态)。
			videoEl.addEventListener("play", () => {
				S.playing = true;
				// 能播出来说明这个地址有效: 清掉它的"失效"标记 (用户把文件放回原处后可恢复)。
				const playingUrl = videoEl.getAttribute("src");
				if (playingUrl && invalidUrls[playingUrl]) {
					delete invalidUrls[playingUrl];
					renderPlaylist();
				}
				updatePlayIcon();
			});
			videoEl.addEventListener("pause", () => { S.playing = false; updatePlayIcon(); });
			// 媒体加载失败 (文件被移动/删除时 stream 路由返回 404、编码不支持等):
			// 必须有明确提示, 否则桌面端表现为"点了没反应"(旧代码只有 play() 的 catch, 看不到原因)。
			videoEl.addEventListener("error", onVideoError);
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

	// ---- 起播与自动播放策略 (桌面端 WebView2 兼容) ----
	// 桌面壳 (pywebview + WebView2) 对"没有用户手势的未静音自动播放"一律拒绝
	// (NotAllowedError); 网页端浏览器因长期交互已拿到播放许可, 所以只在桌面端复现。
	// 处理: 先按正常音量 play(); 被拒时退回静音起播(静音播放一定被允许), 并挂一次性
	// 手势监听 —— 用户点一下页面/按一下键就恢复声音继续播放, 不需要再点面板。
	// 实测注意: WebView2 里把 muted 从 true 改回 false 会让正在播放的视频暂停,
	// 所以恢复声音后必须再调用一次 play(), 不能只改 muted。
	function startPlayback(video) {
		if (!video) return;
		needsGestureUnmute = false;      // 新的起播重新判定, 不沿用上一次的静音兜底状态
		video.muted = (S.volume === 0);  // 用户上一次的手势已恢复声音时, 这里重新按音量决定
		const playPromise = video.play();
		if (!playPromise || typeof playPromise.catch !== "function") return;
		playPromise.catch((error) => {
			if (error && error.name === "NotAllowedError") {
				// 桌面端首次启动(无手势)走这里: 静音起播 + 等一次性手势恢复声音。
				video.muted = true;
				needsGestureUnmute = true;
				const mutedPromise = video.play();
				if (mutedPromise && typeof mutedPromise.catch === "function") mutedPromise.catch(() => { });
				armGestureUnmute();
				setStatus(_dsht("plugin.media_background.status_autoplay_muted", "浏览器限制自动播放: 已静音起播, 点击页面任意处即可恢复声音"));
			}
			// 其它失败(如文件 404)交给 video 的 error 事件给出明确提示。
		});
	}

	/** 挂一次性"用户手势恢复声音"监听 (pointerdown / keydown, 捕获阶段, 先于面板逻辑)。 */
	function armGestureUnmute() {
		if (gestureUnmuteArmed) return;
		gestureUnmuteArmed = true;
		const resumeWithSound = () => {
			document.removeEventListener("pointerdown", resumeWithSound, true);
			document.removeEventListener("keydown", resumeWithSound, true);
			gestureUnmuteArmed = false;
			if (!needsGestureUnmute || !videoEl) return;
			needsGestureUnmute = false;
			videoEl.muted = false;
			videoEl.volume = S.volume;
			// 取消静音会让播放暂停(见上方实测说明), 必须紧接着再 play()。
			const resumePromise = videoEl.play();
			if (resumePromise && typeof resumePromise.catch === "function") resumePromise.catch(() => { });
			updatePlayIcon();
			updateStatus();   // 声音已恢复, 去掉"点击页面恢复声音"的提示后缀
		};
		document.addEventListener("pointerdown", resumeWithSound, true);
		document.addEventListener("keydown", resumeWithSound, true);
	}

	/** 媒体加载失败: 明确指出是哪一首、什么原因, 并把对应清单行标灰划掉。
	 *  旧代码只有 play() 的静默 catch, 所以桌面端表现为"点了没反应、也没选中"。 */
	function onVideoError() {
		if (!videoEl) return;
		// 用 getAttribute 取原始相对地址: videoEl.src 会被浏览器补成绝对地址,
		// 与清单里存的 /__dsh/media-bg/stream?... 不一致, 无法比对。
		const failedUrl = videoEl.getAttribute("src") || "";
		if (!failedUrl) return;
		let failedName = "";
		const listIndex = findListIndexByUrl(failedUrl);
		if (listIndex >= 0) failedName = S.list[listIndex].name;
		else if (S.preview && S.preview.url === failedUrl) failedName = S.preview.name;
		if (!failedName) failedName = failedUrl;
		invalidUrls[failedUrl] = true;
		S.playing = false;
		renderPlaylist();
		updatePlayIcon();
		showMediaFailedStatus(failedName);
		// 只对"清单里的项"尝试一次懒重定位 (试播项不入清单, 不做自动替换)。
		if (listIndex >= 0) tryRelocateListIndex(listIndex);
	}

	/** 统一的"无法播放"状态提示 (失败与重定位失败共用同一句, 避免两处文案漂移)。 */
	function showMediaFailedStatus(displayName) {
		setStatus(_dsht("plugin.media_background.status_media_failed_fmt", "无法播放: {{name}} (文件可能已移动/删除或格式不支持; 可点「清理失效项」移除)").replace("{{name}}", displayName));
	}

	/** 从清单里的 stream url 取出相对路径 (重定位时把旧路径交给服务端做"同级优先"判断)。 */
	function mediaPathFromUrl(url) {
		const matched = /[?&]path=([^&]*)/.exec(url || "");
		if (!matched) return "";
		try {
			return decodeURIComponent(matched[1]);
		} catch (error) {
			return "";
		}
	}

	/** 播放失败后的一次性重定位: 交给服务端在当前媒体根目录内按"同名 + 同体积"找一次。
	 *  - 每项只尝试一次 (relocateTried), 成功后也只重试播放一次;
	 *  - 请求不阻塞 UI (异步, 不 await), 扫描失败就回到原有失效反馈;
	 *  - 不做启动/打开面板时的全量重定位, 只由具体某一次的播放失败触发。 */
	function tryRelocateListIndex(index) {
		const listItem = S.list[index];
		if (!listItem || !listItem.url) return;
		if (relocateTried[listItem.url]) return;
		relocateTried[listItem.url] = true;
		const failedName = listItem.name;
		setStatus(_dsht("plugin.media_background.status_relocating_fmt", "正在尝试重新定位: {{name}}").replace("{{name}}", failedName));
		postJson("relocate", {
			name: listItem.name,
			size: (typeof listItem.size === "number" && listItem.size > 0) ? listItem.size : null,
			path: mediaPathFromUrl(listItem.url),
		}).then((data) => {
			if (!data || data.found !== true || typeof data.url !== "string" || !data.url) {
				showMediaFailedStatus(failedName);
				return;
			}
			// 扫描期间清单可能被用户改动, 必须按"当前是否还在清单里"重新定位下标。
			const currentIndex = findListIndexByUrl(listItem.url);
			if (currentIndex < 0) return;
			const oldUrl = S.list[currentIndex].url;
			S.list[currentIndex].url = data.url;
			if (typeof data.name === "string" && data.name) S.list[currentIndex].name = data.name;
			if (typeof data.size === "number") S.list[currentIndex].size = data.size;
			// 新旧地址都记为已尝试: 新地址若再失败, 不允许触发第二次扫描。
			relocateTried[data.url] = true;
			delete invalidUrls[oldUrl];
			delete invalidUrls[data.url];
			saveStore();
			renderPlaylist();
			if (S.cur === currentIndex) {
				// 只重试一次播放; 再失败会走普通失效反馈 (error 事件里已不会再重定位)。
				playListIndex(currentIndex);
			}
			setStatus(_dsht("plugin.media_background.status_relocated_fmt", "已重新定位: {{name}}").replace("{{name}}", S.list[currentIndex].name));
		}).catch(() => {
			showMediaFailedStatus(failedName);
		});
	}

	/** 「清理失效项」按钮只在清单里存在失效项时出现, 顺便显示数量。 */
	function updateInvalidButton() {
		if (!clearInvalidButton) return;
		let invalidCount = 0;
		for (const listItem of S.list) {
			if (invalidUrls[listItem.url]) invalidCount += 1;
		}
		clearInvalidButton.style.display = (invalidCount > 0) ? "" : "none";
		clearInvalidButton.textContent = _dsht("plugin.media_background.btn_clean_invalid", "清理失效项") + " (" + invalidCount + ")";
	}

	/** 清理清单里已标记失效的项 (用户主动点击才执行, 不自动改动用户清单)。 */
	function removeInvalidItems() {
		let removedCount = 0;
		for (const listItem of S.list) {
			if (invalidUrls[listItem.url]) removedCount += 1;
		}
		if (!removedCount) return;
		const currentUrl = (S.cur >= 0 && S.list[S.cur]) ? S.list[S.cur].url : "";
		const keptList = [];
		for (const listItem of S.list) {
			if (!invalidUrls[listItem.url]) {
				keptList.push(listItem);
				continue;
			}
			// 失效项被清掉时, 同时清掉它的"已尝试重定位"与"失效"记录。
			// 否则用户把文件重新加回清单后, 还会被当成"已经扫描过"而不再重定位。
			delete relocateTried[listItem.url];
			delete invalidUrls[listItem.url];
		}
		S.list = keptList;
		// 当前项若也被清掉, 下标必须跟着收敛, 不能留下指向不存在项的状态。
		S.cur = currentUrl ? findListIndexByUrl(currentUrl) : -1;
		saveStore();
		renderPlaylist();
		updateStatus();
		setStatus(_dsht("plugin.media_background.status_cleaned_invalid_fmt", "已清理 {{count}} 个失效项").replace("{{count}}", removedCount));
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

		/** 取一个随机清单下标; excludeIndex 用于避免"随机到自己"。
		 *  清单只有一首时没有其它可选项, 直接返回 0 (由调用方重复该首)。 */
		function pickRandomListIndex(excludeIndex) {
			if (!S.list.length) return -1;
			if (S.list.length === 1) return 0;
			var randomIndex = Math.floor(Math.random() * S.list.length);
			if (randomIndex === excludeIndex) randomIndex = (randomIndex + 1) % S.list.length;
			return randomIndex;
		}

		/** 在清单里按媒体地址查找下标; 找不到返回 -1。
		 *  用于"上次那首是否还在清单里"的判定, 避免凭旧下标取到不存在的项。 */
		function findListIndexByUrl(url) {
			if (!url) return -1;
			for (var index = 0; index < S.list.length; index += 1) {
				if (S.list[index] && S.list[index].url === url) return index;
			}
			return -1;
		}

		/** 解析"没有任何显式选中项"时该播哪一首 (启动恢复与播放按钮共用):
		 *   1) 上次播放项仍在清单里 → 它的下标;
		 *   2) 否则 → 清单第一首 (下标 0);
		 *   3) 清单为空 → -1 (调用方视为不可播)。
		 *  返回值始终是清单内合法下标或 -1, 不会指向不存在的项。 */
		function resolveResumeIndex() {
			if (!S.list.length) return -1;
			if (S.lastItem) {
				var lastIndex = findListIndexByUrl(S.lastItem.url);
				if (lastIndex >= 0) return lastIndex;
			}
			return 0;
		}

		/** 启动时自动恢复播放: 上次那首(仍在清单) → 清单第一首, 找到即直接开播。
		 *  与播放模式无关 —— 四种模式只决定"一首播完后怎么选下一首", 不决定启动是否起播。
		 *  清单为空则保持关闭, 不自动起播。 */
		function resumePlaybackOnStartup() {
			var resumeIndex = resolveResumeIndex();
			if (resumeIndex < 0) return;
			var resumeItem = S.list[resumeIndex];
			playListIndex(resumeIndex);
			setStatus(_dsht("plugin.media_background.status_resume_fmt", "恢复播放: {{name}} (按上次的播放模式, 可在面板里停掉)").replace("{{name}}", resumeItem.name));
		}

		/** 重新播放当前试播项 (从头开始, 保持"试播"身份, 不入清单)。 */
		function replayPreview() {
			if (!S.preview) return;
			var previewItem = S.preview;
			playPreview(previewItem.url, previewItem.name, previewItem.kind);
		}

		/** 一首播完后按「播放模式」决定下一步; 自然结束(onEnded)与手动切歌都复用这里。
		 *  试播(清单外的临时单曲)也走同一套模式, 不再"播完就整个停掉":
		 *    - 单曲循环: 重复这首试播;
		 *    - 顺序循环: 清单非空则接回清单第 1 首; 清单空则重复这首试播;
		 *    - 随机播放: 清单非空则随机接回一首; 清单空则重复这首试播;
		 *    - 不循环: 保持旧行为, 单次试播只播一次, 播完停止。
		 *  清单当前项播完: 单曲循环重复本项; 顺序循环末项回到第 1 首; 随机换一首; 不循环末项停止。 */
		function playNextAfterEnded() {
			var playMode = S.playMode;

			// 单曲循环: 重复当前项 (试播项或清单当前项)。
			if (playMode === "repeat-one") {
				if (S.preview) { replayPreview(); return; }
				if (S.cur >= 0 && S.list[S.cur]) { playListIndex(S.cur); return; }
				stop();
				return;
			}

			// 试播项播完: 按模式决定是否接回清单 (试播本身不在清单里)。
			if (S.preview) {
				if (!S.list.length) {
					if (playMode === "repeat-all" || playMode === "shuffle") { replayPreview(); return; }
					stop();
					return;
				}
				if (playMode === "shuffle") { playListIndex(pickRandomListIndex(-1)); return; }
				if (playMode === "repeat-all") { playListIndex(0); return; }
				// 不循环: 单次试播就是单次, 播完停止 (不擅自开始播整张清单)。
				stop();
				return;
			}

			// 清单为空, 或当前下标已失效 (例如播放中把该项移出清单): 从第 1 首兜底重来。
			if (!S.list.length) { stop(); return; }
			if (S.cur < 0 || S.cur >= S.list.length) { playListIndex(0); return; }
			if (playMode === "shuffle") { playListIndex(pickRandomListIndex(S.cur)); return; }
			if (S.cur === S.list.length - 1) {
				// 到清单末尾: 顺序循环回到第 1 首, 不循环则停止。
				if (playMode === "repeat-all") playListIndex(0);
				else stop();
				return;
			}
			playListIndex(S.cur + 1);
		}

		function onEnded() {
			playNextAfterEnded();
		}

	/** 当前正在播放的媒体项 (试播优先, 其次是清单当前项); 均无则返回 null。 */
	function currentItem() {
		if (S.preview) return S.preview;
		if (S.cur >= 0 && S.list[S.cur]) return S.list[S.cur];
		return null;
	}

	/** 依据当前播放项的媒体类型切换呈现方式:
	 *   视频: 背景板全透明, 露出作为壁纸的 <video> 画面 (原「观星」影画效果);
	 *   音频: 背景板保持不透明(原生纯色壁纸), 隐藏 <video> 画面, 只放声音 = 纯音乐模式。 */
	function applyMediaMode() {
		const item = currentItem();
		const isAudioMode = !!(item && item.kind === "audio");
		setBackgroundActive(!isAudioMode);
		if (videoEl) {
			if (isAudioMode) {
				// 纯音乐: 藏起画面, 保持原生背景板可见, <video> 仅作音轨在后台静音播放。
				videoEl.style.display = "none";
			} else {
				videoEl.style.display = "";
				videoEl.style.opacity = String(S.opacity);
			}
		}
	}

	/** 开启背景并播放清单里某项。 */
		function playListIndex(index) {
			if (!S.list.length) { setStatus(_dsht("plugin.media_background.status_no_video", "请先往播放清单里添加视频")); return; }
			const idx = Math.max(0, Math.min(index, S.list.length - 1));
			S.preview = null;
			S.cur = idx;
			// 记忆最近播放项: 下次启动自动恢复、以及"播放按钮无选中项"时优先用它。
			S.lastItem = { name: S.list[idx].name, url: S.list[idx].url, kind: S.list[idx].kind || "video" };
			saveStore();
			const video = ensureVideo();
			// 禁用浏览器原生单曲 loop: 否则 loop=true 时 ended 不触发,
			// 我们的手动"清单循环/切下一首"逻辑(onEnded)永远不会跑。
			video.loop = false;
			video.volume = S.volume;
			video.src = S.list[idx].url;
			// 统一走 startPlayback: 兼容桌面端无手势时被拒的自动播放 (会静音起播并等待手势恢复声音)。
			startPlayback(video);
			S.active = true;
			applyMediaMode();
			updatePlayIcon();
			setStatus(_dsht("plugin.media_background.status_playing", "播放中: ") + S.list[idx].name);
			renderPlaylist();
		}

		/** 试播单曲 (不写入清单)。kind 用于区分视频/纯音乐模式。
		 *  播完后做什么由播放模式决定 (见 playNextAfterEnded): 单曲循环重复本曲,
		 *  顺序循环/随机接回清单, 不循环则停止并回到默认背景。 */
		function playPreview(url, displayName, kind) {
			const video = ensureVideo();
			video.volume = S.volume;
			video.src = url;
			// 与清单播放共用同一套起播处理, 避免两处各写一份自动播放兼容逻辑。
			startPlayback(video);
			S.cur = -1;
			S.preview = { name: displayName, url: url, kind: kind || "video" };
			// 试播项同样记为"最近播放项", 供下次启动/播放按钮恢复。
			S.lastItem = { name: displayName, url: url, kind: kind || "video" };
			saveStore();
			S.active = true;
			applyMediaMode();
			updatePlayIcon();
			setStatus(_dsht("plugin.media_background.status_preview", "试播: ") + displayName);
		}

		function togglePause() {
			// 没有任何已加载的音源 (首次启动 / 停止之后 / 当前项被移出清单):
			// 先解析"上次那首 → 清单第一首"并直接起播, 不再静默 return 导致"点播放没反应"。
			var hasLoadedSource = !!(videoEl && videoEl.src);
			if (!hasLoadedSource && !S.preview) {
				var resumeIndex = resolveResumeIndex();
				if (resumeIndex < 0) {
					// 清单为空 = 确实没有可播内容, 此时才视为不可播。
					setStatus(_dsht("plugin.media_background.status_no_video", "请先往播放清单里添加视频"));
					return;
				}
				playListIndex(resumeIndex);
				return;
			}
			if (!videoEl) return;
			if (videoEl.paused) {
				startPlayback(videoEl);
			} else {
				videoEl.pause();
				needsGestureUnmute = false;   // 用户主动暂停后不再自动恢复声音, 避免"点了暂停又响"
			}
			// 事件监听器 play/pause 会自动 sync 图标, 这里再手动补一次 (保险)。
			updatePlayIcon();
		}

		function next() {
			if (!S.list.length) return;
			// 随机播放: 手动⏭也随机换一首 (当前在试播时 cur=-1, 同样从清单随机起播)。
			if (S.playMode === "shuffle") { playListIndex(pickRandomListIndex(S.cur)); return; }
			if (S.cur < 0) { playListIndex(0); return; }
			playListIndex((S.cur + 1) % S.list.length);
		}

		function prev() {
			if (!S.list.length) return;
			if (S.cur < 0) { playListIndex(0); return; }
			// 随机模式下手动⏮仍按清单顺序回退一首: 随机没有"历史顺序"可回溯,
			// 按序号回退是可预期、不会原地卡死的做法。
			playListIndex((S.cur - 1 + S.list.length) % S.list.length);
		}

		/** 停止并关闭背景, 回到 DeepSeek Harness 原始背景。 */
		function stop() {
			if (videoEl) {
				videoEl.pause();
				videoEl.removeAttribute("src");
				try { videoEl.load(); } catch (error) { /* 忽略 */ }
				videoEl.style.display = "";   // 复位显示, 避免下次视频播放被"纯音乐模式"的隐藏残留影响
				if (videoEl.parentNode) {
					try { videoEl.parentNode.removeChild(videoEl); } catch (error) { /* 忽略 */ }
				}
			}
			S.active = false;
			S.playing = false;
			S.cur = -1;
			S.preview = null;
			needsGestureUnmute = false;   // 停止后不再等到手势去恢复声音
			setBackgroundActive(false);
			updatePlayIcon();
			setStatus(_dsht("plugin.media_background.status_closed", "背景已关闭"));
		}

		// ---- 数据加载 ----
		async function loadConfig() {
			try {
				const data = await getJson("config");
				S.dir = data.dir || "";
				if (dirInput) dirInput.value = S.dir;
			} catch (error) {
				setStatus(_dsht("plugin.media_background.status_read_config_fail", "读取配置失败: ") + errMessage(error));
			}
		}

		async function scanList() {
			setStatus(_dsht("plugin.media_background.status_scanning", "扫描中…"));
			try {
				const data = await getJson("list");
				S.dir = data.dir || "";
				S.files = data.files || [];
				if (dirInput) dirInput.value = S.dir;
				if (data.error) setStatus(data.error);
				renderFiles();
				updateStatus();
			} catch (error) {
				setStatus(_dsht("plugin.media_background.status_scan_fail", "扫描失败: ") + errMessage(error));
			}
		}

		async function commitDir() {
			const dirValue = dirInput ? dirInput.value.trim() : "";
			if (!dirValue) { setStatus(_dsht("plugin.media_background.status_dir_empty", "目录不能为空")); return; }
			setStatus(_dsht("plugin.media_background.status_setting_dir", "设置目录…"));
			try {
				await postJson("config", { dir: dirValue });
				S.dir = dirValue;
				setStatus(_dsht("plugin.media_background.status_dir_set_scanning", "目录已设置, 正在扫描…"));
				await scanList();
			} catch (error) {
				setStatus(_dsht("plugin.media_background.status_set_dir_fail", "设置目录失败: ") + errMessage(error));
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
			browsePathEl.textContent = browseDir || _dsht("plugin.media_background.err_my_computer", "我的电脑");
			browseBody.textContent = "";
			try {
				const data = await browseQuery({ path: browseDir });
				if (data.error) {
					browseBody.appendChild(el("div", { className: "bempty", textContent: data.error }));
					return;
				}
				renderBrowseBody(data);
			} catch (error) {
				browseBody.appendChild(el("div", { className: "bempty", textContent: _dsht("plugin.media_background.err_read_fail", "读取失败: ") + errMessage(error) }));
			}
		}

		function renderBrowseBody(data) {
			// 上一级按钮 (根层隐藏)。
			const goUp = el("div", { className: "brow", on: { click: () => { browseDir = data.parent; loadBrowse(); } } }, [
				el("span", { className: "ico", textContent: "↑" }),
				el("span", { className: "nm", textContent: _dsht("plugin.media_background.err_parent", "… (返回上层)") }),
			]);
			if (!data.isRoot) browseBody.appendChild(goUp);
			const children = (data.children || []);
			if (!children.length) {
				browseBody.appendChild(el("div", { className: "bempty", textContent: _dsht("plugin.media_background.err_no_subdirs", "此目录没有子文件夹") }));
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
			if (!browseDir) { setStatus(_dsht("plugin.media_background.status_no_dir", "未选择目录")); return; }
			if (dirInput) dirInput.value = browseDir;
			closeBrowse();
			commitDir();
		}

		// ---- 渲染 ----
		function setStatus(text) {
			if (statusEl) statusEl.textContent = text;
		}

		function updateStatus() {
			const mode = S.list.length
				? _dsht("plugin.media_background.status_list_fmt", "清单 {{count}} 首 · 目录: {{dir}}").replace("{{count}}", S.list.length).replace("{{dir}}", S.dir)
				: _dsht("plugin.media_background.status_dir_fmt", "目录: {{dir}} (未配置)").replace("{{dir}}", S.dir || "");
			// 桌面端自动播放被拒时, 状态栏提示会被随后的目录扫描结果覆盖掉;
			// 把"点击页面恢复声音"作为后缀拼在当前状态上, 手势恢复声音后再自然移除。
			if (needsGestureUnmute) {
				setStatus(mode + " · " + _dsht("plugin.media_background.status_autoplay_muted_short", "点击页面任意处恢复声音"));
			} else {
				setStatus(mode);
			}
		}

		function updatePlayIcon() {
			if (!playIcon) return;
			// 读 video.paused (真实 DOM 状态), 而不是自己维护的 S.playing ——
			// 因为 video.play() 是异步 Promise, 可能被 autoplay/rejected 暂停,
			// 事件监听器 play/pause 会自动 sync S.playing, 这里再做最终兜底。
			var isActuallyPlaying = false;
			if (videoEl && videoEl.src) {
				isActuallyPlaying = !videoEl.paused && !videoEl.ended;
			}
			playIcon.textContent = isActuallyPlaying ? "⏸" : "▶";
		}

		function renderFiles() {
			if (!listEl) return;
			listEl.textContent = "";
			if (!S.files.length) {
				listEl.appendChild(el("div", { className: "dsw-mbg-tip" }, _dsht("plugin.media_background.empty_list", "该目录下没有可播放的媒体（支持视频 mp4/webm/mkv/mov/avi 等，音频 mp3/wav/flac/m4a 等）")));
				return;
			}
			for (const file of S.files) {
				const row = el("div", { className: "dsw-mbg-item" }, [
					el("span", { className: "dsw-mbg-name", title: file.name }, file.name),
					// ▷ 按钮 = 试播 (单次, 不入清单)
					el("button", {
						className: "dsw-mbg-act",
						title: _dsht("plugin.media_background.btn_preview_once", "试播 (单次, 不入清单)"),
						textContent: "▷",
						on: { click: (ev) => { ev.stopPropagation(); playPreview(file.url, file.name, file.kind); } },
					}),
					// ＋ 按钮 = 加入播放清单 (收藏夹)
					el("button", {
						className: "dsw-mbg-act",
						title: _dsht("plugin.media_background.btn_add_playlist", "加入播放清单 (收藏夹)"),
						textContent: "＋",
						on: { click: (ev) => { ev.stopPropagation(); addToList(file); } },
					}),
				]);
				// 整行点击 = 单次试播 (最直观的"点一下就播这个", 不入清单 —— 加清单请点 ＋)。
				row.addEventListener("click", () => {
					playPreview(file.url, file.name, file.kind);
				});
				listEl.appendChild(row);
			}
		}

		function addToList(file) {
			const exists = S.list.some((item) => item.url === file.url);
			if (exists) {
				setStatus(_dsht("plugin.media_background.status_already_in_list", "已在清单中: ") + file.name);
				return;
			}
			S.list.push({
				name: file.name,
				url: file.url,
				kind: file.kind || "video",
				// 记录文件体积: 播放失败后的懒重定位要靠"同名 + 同体积"才不会误认别的文件。
				// 旧版本清单没有这个字段, 重定位时退化为"只看同名"。
				size: (typeof file.size === "number") ? file.size : null,
			});
			saveStore();
			renderPlaylist();
			updateStatus();
			// 清单从 0 → 1 且当前没在播放 → 自动开始播这一首 (沿用原有"加入即播"体验)。
			if (S.list.length === 1 && !S.active) playListIndex(0);
		}

		function removeFromList(index) {
			var removedIsCurrent = (index === S.cur);
			var removedItem = S.list[index];
			S.list.splice(index, 1);
			if (index < S.cur) {
				// 删除当前项之前的条目: 下标整体前移一位, 保证仍指向同一首歌。
				S.cur -= 1;
			} else if (removedIsCurrent) {
				// 删除正在播放的条目: 声音继续放到本曲结束, 并把这一首转为"试播"身份
				// (它已不在清单里, 单曲循环仍能重复它); 其余模式由 playNextAfterEnded() 的试播分支统一兜底。
				S.cur = -1;
				if (removedItem) {
					S.preview = { name: removedItem.name, url: removedItem.url, kind: removedItem.kind || "video" };
				}
			} else if (S.cur >= S.list.length) {
				S.cur = S.list.length - 1;
			}
			saveStore();
			renderPlaylist();
			updateStatus();
		}

		function clearList() {
			// 清空时若正在播清单里的某一首: 声音继续, 并把这一首转为"试播"身份
			// (清单已空, 循环类模式仍能重复它, 不循环则在播完后停止)。
			if (S.cur >= 0 && S.list[S.cur]) {
				var currentPlayingItem = S.list[S.cur];
				S.preview = { name: currentPlayingItem.name, url: currentPlayingItem.url, kind: currentPlayingItem.kind || "video" };
			}
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
				playlistEl.appendChild(el("div", { className: "dsw-mbg-tip" }, _dsht("plugin.media_background.empty_playlist", "播放清单为空")));
				updateInvalidButton();
				return;
			}
			S.list.forEach((item, index) => {
				const isCur = (index === S.cur);
				// 播不出来的条目标灰划掉, 让用户一眼看出"不是没选中, 是文件没了"。
				const isInvalid = !!invalidUrls[item.url];
				let rowClassName = "dsw-mbg-item";
				if (isCur) rowClassName += " cur";
				if (isInvalid) rowClassName += " bad";
				const row = el("div", {
					className: rowClassName,
					title: isInvalid ? _dsht("plugin.media_background.title_row_invalid", "文件已不存在或无法解码") : "",
				}, [
					el("span", { className: "dsw-mbg-name", title: item.name },
						((index + 1) + ". " + item.name)),
					el("button", {
						className: "dsw-mbg-act", title: _dsht("plugin.media_background.btn_remove", "移除"), textContent: "✕",
						on: { click: (ev) => { ev.stopPropagation(); removeFromList(index); } },
					}),
				]);
				row.addEventListener("click", () => playListIndex(index));
				playlistEl.appendChild(row);
			});
			updateInvalidButton();
		}

		// ---- 面板构建 ----
		function cssText() {
			const css = [
				'#dsw-mbg-btn{cursor:pointer;}' ,
				'#dsw-mbg-panel{position:fixed;width:340px;height:70vh;max-height:560px;' +
					'display:none;flex-direction:column;z-index:2147483001;background:var(--dsw-alias-bg-layer-2);' +
				'border:1px solid var(--dsw-alias-border-l1);border-radius:12px;color:var(--dsw-alias-label-primary);font-size:13px;' +
					'font-family:inherit;backdrop-filter:blur(14px);box-sizing:border-box;}',
				'#dsw-mbg-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);cursor:grab;user-select:none;flex:0 0 auto;}',
				'#dsw-mbg-head:active{cursor:grabbing;}',
				'#dsw-mbg-title{flex:1;font-weight:600;font-size:14px;}',
				'.dsw-mbg-b{padding:4px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer;}',
				'.dsw-mbg-b:hover{background:var(--dsw-alias-interactive-bg-hover-solid);}',
				'.dsw-mbg-b.on{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-button-primary-fill);color:#fff;}',
				'#dsw-mbg-dirrow{display:flex;gap:6px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;}',
				'#dsw-mbg-dir{flex:1;min-width:0;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;padding:5px 8px;}',
				'.dsw-mbg-block{padding:6px 10px;flex:0 0 auto;}',
				// 中部可滚动区: 目录/清单两块列表都放在这里。面板高度不足时只滚这一块,
				// 底部设置区 (音量/浓度/播放模式) 与状态栏始终完整留在圆角背景板内,
				// 不再被挤出背景板下边缘。
				// 注意: #dsw-mbg-panel 与 #dsw-mbg-ctl 都刻意不加 overflow:hidden,
				// 否则「播放模式」<select> 展开后的原生浮层会被祖先裁掉。
				'#dsw-mbg-body{flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;}',
				'.dsw-mbg-cap{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin:4px 2px;}',
				// 「播放清单」标题行: 左边标题, 右边「清理失效项」按钮 (无失效项时按钮隐藏)。
				'.dsw-mbg-cap-row{display:flex;align-items:center;justify-content:space-between;gap:8px;}',
				'#dsw-mbg-list,#dsw-mbg-playlist{overflow-y:auto;min-height:70px;max-height:150px;}',
				'.dsw-mbg-item{display:flex;gap:6px;align-items:center;width:100%;padding:4px 6px;border-radius:6px;cursor:pointer;}',
				'.dsw-mbg-item:hover{background:var(--dsw-alias-interactive-bg-hover);}',
				'.dsw-mbg-item.cur{background:var(--dsw-alias-interactive-bg-hover-active);}',
				// 失效项 (文件被移动/删除或无法解码): 降透明度 + 名字划掉, 与"选中"状态区分开。
				'.dsw-mbg-item.bad{opacity:0.55;}',
				'.dsw-mbg-item.bad .dsw-mbg-name{text-decoration:line-through;}',
				'.dsw-mbg-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
				'.dsw-mbg-act{flex-shrink:0;cursor:pointer;border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:0 4px;font-size:13px;}',
				'.dsw-mbg-act:hover{color:var(--dsw-alias-label-primary);}',
				'.dsw-mbg-tip{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:6px;}',
				'#dsw-mbg-ctl{border-top:1px solid var(--dsw-alias-border-l1);padding:8px 12px 10px;display:flex;flex-direction:column;gap:6px;flex:0 0 auto;}',
				'.dsw-mbg-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
				// 标签定宽: 音量(2字)/浓度(2字)/播放模式(4字) 共用同一起始栅格,
				// 使右侧两个滑块与下拉框的左边缘严格对齐; 定宽避免 4 字标签撑宽导致错位。
				'.dsw-mbg-lab{font-size:11.5px;color:var(--dsw-alias-label-tertiary);flex:0 0 48px;width:48px;text-align:left;line-height:1.2;}',
				'.dsw-mbg-vol{flex:1;min-width:80px;accent-color:var(--dsw-alias-button-primary-fill);}',
				'.dsw-mbg-sel{flex:1;min-width:0;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12px;padding:3px 6px;}',
				'#dsw-mbg-status{color:var(--dsw-alias-label-secondary);font-size:11.5px;padding:6px 12px;border-top:1px solid var(--dsw-alias-border-l1);min-height:16px;flex:0 0 auto;}',
			// 目录浏览弹窗 (覆盖层)。
			'#dsw-mbg-browse{position:fixed;inset:0;z-index:2147483002;display:none;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-2);}',
			'#dsw-mbg-browse .box{width:440px;max-width:90vw;height:60vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;color:var(--dsw-alias-label-primary);font-size:13px;}',
			'#dsw-mbg-browse .bd{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);}',
			'#dsw-mbg-browse .bpath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;color:var(--dsw-alias-label-secondary);}',
			'#dsw-mbg-browse .bbody{flex:1;overflow-y:auto;padding:6px;}',
			'#dsw-mbg-browse .brow{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:6px;cursor:pointer;}',
			'#dsw-mbg-browse .brow:hover{background:var(--dsw-alias-interactive-bg-hover);}',
			'#dsw-mbg-browse .brow .ico{width:18px;text-align:center;flex-shrink:0;}',
			'#dsw-mbg-browse .brow .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
			'#dsw-mbg-browse .bempty{color:var(--dsw-alias-label-tertiary);font-size:12.5px;padding:14px;text-align:center;}',
			'#dsw-mbg-browse .bfoot{display:flex;align-items:center;gap:8px;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l1);}',
			// 动态背景开关: 播放视频时(<html>.dsw-mbg-active)把 WebUI 整窗背景板置为透明,
			// 让作为背景的 <video> 透出; 停止时移除该类即恢复 DeepSeek Harness 原生纯色壁纸。
			// 只透明化页面底座 token(--dsw-alias-bg-base, 即空壁纸/聊天画布背景),
			// 刻意不动 layer-1/2/3 / specific-menu / bg-mask 等浮层 token ——
			// 设置界面等悬浮面板用 var(--dsw-alias-bg-layer-N) 作背景, 保留不透明才不会把设置透掉。
			// 拖拽/拉伸手柄 (三手柄: 右 ew-resize / 下 ns-resize / 右下 nwse-resize)
			'#dsw-mbg-panel .rh{position:absolute;right:-3px;top:32px;bottom:44px;width:6px;cursor:ew-resize;background:transparent;}',
			'#dsw-mbg-panel .bh{position:absolute;bottom:-3px;left:14px;right:14px;height:6px;cursor:ns-resize;background:transparent;}',
			'#dsw-mbg-panel .brh{position:absolute;right:-3px;bottom:-3px;width:14px;height:14px;cursor:nwse-resize;background:transparent;}',
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
				"border-radius:20px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);" +
				"color:var(--dsw-alias-label-primary);font-size:13px;backdrop-filter:blur(6px);";
			btn.textContent = "🎬 " + _dsht("plugin.media_background.tab_label", "观星");
			rootEl.appendChild(btn);

			// 面板。
			const head = el("div", { id: "dsw-mbg-head" }, [
				el("span", { id: "dsw-mbg-title", textContent: _dsht("plugin.media_background.title", "观星 · 背景影画") }),
				el("button", { className: "dsw-mbg-b", textContent: "✕", on: { click: () => { S.panelOpen = false; panel.style.display = "none"; } } }),
			]);
			const dirRow = el("div", { id: "dsw-mbg-dirrow" }, [
				(dirInput = el("input", { id: "dsw-mbg-dir", type: "text", placeholder: _dsht("plugin.media_background.placeholder", "输入视频目录绝对路径，如 D:\\Videos"), value: S.dir })),
				el("button", { className: "dsw-mbg-b", textContent: _dsht("plugin.media_background.btn_pick_dir", "选目录…"), title: _dsht("plugin.media_background.title_folder_pick", "优先使用 Windows 文件选择框选择目录"), on: { click: openBrowse } }),
				el("button", { className: "dsw-mbg-b", textContent: _dsht("plugin.media_background.btn_scan", "扫描"), on: { click: commitDir } }),
			]);
			listEl = el("div", { id: "dsw-mbg-list" });
			playlistEl = el("div", { id: "dsw-mbg-playlist" });
			const fileBlock = el("div", { className: "dsw-mbg-block" }, [
				el("div", { className: "dsw-mbg-cap" }, _dsht("plugin.media_background.hint_dir_videos", "目录视频（点击即播，▷ 试播，＋ 加入清单）")),
				listEl,
			]);
			// 「清理失效项」按钮: 默认隐藏, 只有清单里出现播放失败(404/无法解码)的条目时才显示,
			// 由 updateInvalidButton() 统一控制显隐与数量, 不干扰正常界面。
			clearInvalidButton = el("button", {
				className: "dsw-mbg-b",
				textContent: _dsht("plugin.media_background.btn_clean_invalid", "清理失效项"),
				title: _dsht("plugin.media_background.title_clean_invalid", "移除清单里已无法播放的条目"),
				on: { click: removeInvalidItems },
			});
			clearInvalidButton.style.display = "none";
			const playBlock = el("div", { className: "dsw-mbg-block" }, [
				el("div", { className: "dsw-mbg-cap dsw-mbg-cap-row" }, [
					el("span", { textContent: _dsht("plugin.media_background.hint_playlist", "播放清单") }),
					clearInvalidButton,
				]),
				playlistEl,
			]);
			playIcon = el("span", {});
			// 中部滚动区: 两块列表同属一个容器, 面板变矮时由它承接滚动,
			// 保证底部控制区 (音量/浓度/播放模式三行) 不被挤出背景板。
			const bodyEl = el("div", { id: "dsw-mbg-body" }, [fileBlock, playBlock]);
			const ctl = el("div", { id: "dsw-mbg-ctl" }, [
				el("div", { className: "dsw-mbg-row" }, [
					el("button", { className: "dsw-mbg-b", textContent: "⏮", title: _dsht("plugin.media_background.btn_prev", "上一首"), on: { click: prev } }),
					el("button", { className: "dsw-mbg-b dsw-mbg-play", on: { click: togglePause } }, playIcon),
					el("button", { className: "dsw-mbg-b", textContent: "⏭", title: _dsht("plugin.media_background.btn_next", "下一首"), on: { click: next } }),
					el("button", { className: "dsw-mbg-b", textContent: "⏹", title: _dsht("plugin.media_background.btn_stop_bg", "停止并关闭背景"), on: { click: stop } }),
					el("button", { className: "dsw-mbg-b", textContent: _dsht("plugin.media_background.btn_clear_list", "清空清单"), on: { click: clearList } }),
				]),
				el("div", { className: "dsw-mbg-row" }, [
					el("label", { className: "dsw-mbg-lab", textContent: _dsht("plugin.media_background.label_volume", "音量") }),
					el("input", {
						className: "dsw-mbg-vol", type: "range", min: 0, max: 100, value: Math.round(S.volume * 100),
						on: { input: (ev) => { S.volume = Number(ev.target.value) / 100; if (videoEl) { videoEl.volume = S.volume; videoEl.muted = (S.volume === 0); } saveStore(); } },
					}),
				]),
				el("div", { className: "dsw-mbg-row" }, [
					el("label", { className: "dsw-mbg-lab", textContent: _dsht("plugin.media_background.label_concentration", "浓度") }),
					el("input", {
						className: "dsw-mbg-vol", type: "range", min: 0, max: 100, value: Math.round(S.opacity * 100),
						on: { input: (ev) => { S.opacity = Number(ev.target.value) / 100; applyVideoAppearance(); saveStore(); } },
					}),
				]),
				el("div", { className: "dsw-mbg-row" }, [
					el("label", { className: "dsw-mbg-lab", textContent: _dsht("plugin.media_background.label_play_mode", "播放模式") }),
					// 播放模式下拉: 单曲循环 / 顺序循环 / 随机播放 / 不循环(播完停止)。
					// 选择立即写入 S.playMode + localStorage; 只影响"下一首怎么选", 不打断当前播放。
					(playModeSelect = el("select", {
						className: "dsw-mbg-sel",
						title: _dsht("plugin.media_background.title_play_mode", "选择清单播完后的行为"),
						on: { change: (ev) => { S.playMode = ev.target.value; saveStore(); } },
					}, [
						el("option", { value: "repeat-one", textContent: _dsht("plugin.media_background.mode_repeat_one", "单曲循环") }),
						el("option", { value: "repeat-all", textContent: _dsht("plugin.media_background.mode_repeat_all", "顺序循环（播单循环）") }),
						el("option", { value: "shuffle", textContent: _dsht("plugin.media_background.mode_shuffle", "随机播放") }),
						el("option", { value: "sequential", textContent: _dsht("plugin.media_background.mode_sequential", "不循环（播完即止）") }),
					])),
				]),
			]);
			// 选项建好后再回填当前模式 (select.value 在无 option 时设置无效)。
			playModeSelect.value = S.playMode;
			statusEl = el("div", { id: "dsw-mbg-status", textContent: _dsht("plugin.media_background.status_scanning", "扫描中…") });
			// 三手柄: 右 / 下 / 右下拉伸
			var rh = el("div", { className: "rh" });
			var bh = el("div", { className: "bh" });
			var brh = el("div", { className: "brh" });
			panel = el("div", { id: "dsw-mbg-panel" }, [head, dirRow, bodyEl, ctl, statusEl]);
			rootEl.appendChild(panel);

			// 目录浏览弹窗 (覆盖整个页面, 在其内部逐层下钻选择目录)。
			(browsePathEl = el("div", { className: "bpath", textContent: _dsht("plugin.media_background.err_my_computer", "我的电脑") }));
			(browseBody = el("div", { className: "bbody" }));
			const browseBox = el("div", { className: "box" }, [
				el("div", { className: "bd" }, [
					browsePathEl,
					el("button", { className: "dsw-mbg-b", textContent: _dsht("plugin.media_background.btn_close", "关闭"), on: { click: closeBrowse } }),
				]),
				browseBody,
				el("div", { className: "bfoot" }, [
					el("button", { className: "dsw-mbg-b", textContent: _dsht("plugin.media_background.btn_use_dir", "使用此目录"), on: { click: useBrowsedDir } }),
				]),
			]);
			browseEl = el("div", { id: "dsw-mbg-browse" }, [browseBox]);
			rootEl.appendChild(browseEl);

			// ---- 弹窗几何: 避让官方右侧栏 + 可拖拽 + 可拉伸 ----
			// MIN_H 需保证: 头部 + 目录行 + 状态栏 + 底部设置区(含音量/浓度/播放模式三行) 完整可见,
			// 余下高度留给中部滚动区, 因此下限取 320px (旧值 220 会把设置区挤出背景板)。
			var MIN_W=280,MAX_W=520,MIN_H=320;
			var panelWin=null,dragState=null;
			// 读取官方右侧栏 (dsh-client-ui-sidebar-right) 当前实际占位宽度 (px):
			// 官方停靠面板带 data-sidebar-right-* 标记 —— 展开态才有 data-sidebar-right-open;
			// 折叠态面板被滑出框架不占宽度; 全屏态覆盖整个视口(浮动弹窗无处可让)记 0;
			// 多个会话的面板可能同时在 DOM 里(后台会话子树隐藏), 用 checkVisibility() 只取可见那块。
			function getSidebarRightOffset(){
				var panels=document.querySelectorAll("[data-sidebar-right-session]");
				var offset=0;
				for(var i=0;i<panels.length;i++){
					var panel=panels[i];
					if(!panel.hasAttribute("data-sidebar-right-open"))continue;
					if(panel.getAttribute("data-sidebar-right-panel")==="fullscreen")continue;
					if(typeof panel.checkVisibility==="function"&&!panel.checkVisibility())continue;
					var rect=panel.getBoundingClientRect();
					if(rect&&rect.width>offset)offset=rect.width;
				}
				return offset;
			}
			function applyWin(){
				if(!panelWin)return;
				panel.style.left=panelWin.left+"px";
				panel.style.top=panelWin.top+"px";
				panel.style.width=panelWin.width+"px";
				panel.style.height=panelWin.height+"px";
			}
			function defaultWin(){
				var side=getSidebarRightOffset();
				var vw=window.innerWidth||1280;
				var vh=window.innerHeight||800;
				var pad=side+20;
				var w=Math.min(Math.max(340,MIN_W),vw-pad-16);
				// 初始高度兜底 MIN_H: 旧逻辑 min(vh-92,560) 在矮窗口下会小于设置区所需高度,
				// 导致底部的「播放模式」行溢出圆角背景板。上限仍为 560。
				var h=Math.min(Math.max(vh-92,MIN_H),560);
				return{left:vw-w-pad,top:14,width:w,height:h,_autoPos:true};
			}
			function pd(ev,mode){
				ev.preventDefault();ev.stopPropagation();
				if(!panelWin)panelWin=defaultWin();
				dragState={mode:mode,sx:ev.clientX,sy:ev.clientY,
					oL:panelWin.left,oT:panelWin.top,oW:panelWin.width,oH:panelWin.height};
			}
			function pm(ev){
				if(!dragState)return;
				var dx=ev.clientX-dragState.sx,dy=ev.clientY-dragState.sy;
				var vw=window.innerWidth||1280,vh=window.innerHeight||800;
				var side=getSidebarRightOffset();
				var rLim=vw-side;
				var c=panelWin;
				if(dragState.mode==="move"){
					c.left=Math.min(Math.max(dragState.oL+dx,4),rLim-50);
					c.top=Math.min(Math.max(dragState.oT+dy,4),vh-40);
					c._autoPos=false;
				}else if(dragState.mode==="r"){
					c.width=Math.min(Math.max(dragState.oW+dx,MIN_W),rLim-c.left-4);
				}else if(dragState.mode==="b"){
					c.height=Math.min(Math.max(dragState.oH+dy,MIN_H),vh-c.top-4);
				}else if(dragState.mode==="br"){
					c.width=Math.min(Math.max(dragState.oW+dx,MIN_W),rLim-c.left-4);
					c.height=Math.min(Math.max(dragState.oH+dy,MIN_H),vh-c.top-4);
				}
				applyWin();
			}
			function pu(){dragState=null;}
			function reposition(){
				if(!panelWin||!panelWin._autoPos)return;
				var side=getSidebarRightOffset();
				var vw=window.innerWidth||1280,vh=window.innerHeight||800;
				var pad=side+20;
				var mw=vw-pad-16;
				panelWin.width=Math.min(Math.min(panelWin.width,mw),MAX_W);
				panelWin.width=Math.max(panelWin.width,MIN_W);
				panelWin.height=Math.min(Math.max(panelWin.height,MIN_H),vh-panelWin.top-4);
				panelWin.left=vw-panelWin.width-pad;
				panelWin.top=Math.min(Math.max(panelWin.top,4),vh-panelWin.height-4);
				applyWin();
			}
			head.addEventListener("mousedown",function(ev){pd(ev,"move");});
			rh.addEventListener("mousedown",function(ev){pd(ev,"r");});
			bh.addEventListener("mousedown",function(ev){pd(ev,"b");});
			brh.addEventListener("mousedown",function(ev){pd(ev,"br");});
			document.addEventListener("mousemove",pm);
			document.addEventListener("mouseup",pu);
			window.addEventListener("resize",reposition);
			// 官方右侧栏变化(展开/收起/切全屏/拖动宽度/切会话重建面板)时重新定位:
			(function(){
				new MutationObserver(reposition).observe(document.body,{
					childList:true,subtree:true,attributes:true,
					attributeFilter:["data-sidebar-right-open","data-sidebar-right-panel","style"]
				});
			})();

			function togglePanel(){
				S.panelOpen=!S.panelOpen;
				if(S.panelOpen){
					if(!panelWin){panelWin=defaultWin();applyWin();}
					else{reposition();}
					panel.style.display="flex";
				}else{
					panel.style.display="none";
				}
			}

			return panel;
		}

		function init() {
				_bindI18nRebuildOnce();   // 注册一次语言切换监听, 触发时重建整个 UI DOM
				loadStore();
			buildUI();
			applyVideoAppearance();
			updatePlayIcon();
			renderPlaylist();
			updateStatus();
			// 启动即自动恢复播放 (上次那首仍在清单 → 它的下标, 否则清单第一首),
			// 不再依赖播放模式; 清单为空则不起播。放在目录扫描之前, 避免网络往返拖慢起播。
			resumePlaybackOnStartup();
			loadConfig().then(() => {
				scanList();
			});
		}

		// ---- 插件契约 ----
		// 注意: init() 里所有 UI 文案都走 _dsht(), 必须等 i18n bridge 就绪后再构建 UI,
		// 否则 bridge 还没加载完时 _dsht() 只能返回 fallback (中文), 切英文就失效。
		function apply() {
			// 先看看 bridge 是否已经就绪 (desktop-shell 场景同步注入, 这里立即可命中)
			var br = window.__DSH_I18N__;
			if (br && br._initialized && br.current && br[br.current]) {
				init();
				return;
			}
			// 浏览器场景: 轮询等 bridge 异步加载完成 (最多等 5 秒, 超时也兜底调 init)
			var waitedMs = 0;
			var timer = setInterval(function() {
				var b = window.__DSH_I18N__;
				waitedMs += 100;
				if ((b && b._initialized && b.current && b[b.current]) || waitedMs >= 5000) {
					clearInterval(timer);
					init();
				}
			}, 100);
		}

		exports.apply = apply;
		return module.exports;
	}
});
