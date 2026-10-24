/**
 * dsh-skill-center —— 技能中心（宿主端）
 *
 * 目标：给绿色版 DSH 补一个「技能」UI：
 *   - 左侧栏入口 + 中央「技能中心」页（由客户端插件 lib/client.js 注册插槽）；
 *   - 官方技能（bundled / runtime / preset 层）只读预览；
 *   - 个人技能存放在 $DSH_HOME/skills（绿色版 = runtime/dsh-home/skills），可新建/导入/编辑/停用/卸载；
 *   - 聊天栏技能选择器通过本插件的 /list 路由取数，选中后由客户端向草稿插入 `/name`。
 *
 * 本文件只做宿主端：HTTP 路由 + 文件系统 + ctx.skills 读取。
 * 零依赖、无构建步骤，与绿色版其他内置插件保持一致。
 *
 * 路由（前缀 /__dsh/skill-center，均为本机回环）：
 *   GET  /list            列出个人/官方/其他/已停用技能
 *   POST /read            读取某个技能的 SKILL.md 正文（受 256KB 上限保护）
 *   POST /create          新建个人技能（目录 bundle）
 *   POST /save            保存个人技能正文（原子写）
 *   POST /install-folder  从本地文件夹或单个 .md 文件导入技能
 *   POST /toggle          启用/停用个人技能（移动到 skill-center/disabled 或移回）
 *   POST /remove          卸载个人技能（移入 skill-center/trash，可恢复）
 *   POST /open-folder     在系统文件管理器中打开技能目录
 *
 * 存储布局：
 *   $DSH_HOME/skills/<name>/SKILL.md            个人技能（被 dsh-skill-filesystem 扫描，rank 400）
 *   $DSH_HOME/skills/<name>.md                  个人技能（扁平格式，兼容）
 *   $DSH_HOME/skill-center/disabled/<name>/...  已停用（移出扫描根，避免无效条目告警）
 *   $DSH_HOME/skill-center/trash/<ts>-<name>/   回收站
 *   $DSH_HOME/skill-center/tmp-<rand>/          导入/新建的临时目录（原子 rename 前）
 */
import {
    existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
    statSync, lstatSync, rmSync, renameSync, cpSync, realpathSync,
} from 'node:fs';
import { join, resolve, relative, extname, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export const name = 'dsh-skill-center';

/** 需要 webServer 注册 HTTP 路由；skills 服务用 ctx.get 可选获取（缺失时降级）。 */
export const inject = ['webServer'];

const ROUTE_PREFIX = '/__dsh/skill-center';

/** 单个 SKILL.md 正文上限 256KB。 */
const MAX_SKILL_BYTES = 256 * 1024;
/** 导入 bundle 的总大小上限 8MB。 */
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
/** 导入 bundle 的文件数上限 200。 */
const MAX_BUNDLE_FILES = 200;
/** 单次请求体上限 4MB（普通 JSON 路由）。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** ZIP 上传请求体上限 20MB（base64 后约为原始 zip 的 1.34 倍）。 */
const MAX_ZIP_BODY_BYTES = 20 * 1024 * 1024;
/** 单个 ZIP 文件上限 12MB。 */
const MAX_ZIP_BYTES = 12 * 1024 * 1024;
/** ZIP 解压后总大小上限 24MB。 */
const MAX_ZIP_TOTAL_BYTES = 24 * 1024 * 1024;
/** ZIP 内单个文件上限 4MB。 */
const MAX_ZIP_FILE_BYTES = 4 * 1024 * 1024;
/** 单条目压缩比上限（防 zip bomb），仅对 >1MB 的条目生效。 */
const MAX_ZIP_RATIO = 200;
/** 技能名：kebab-case。 */
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Windows 保留设备名。 */
const RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/** 导入时跳过的目录名。 */
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.svn', '.hg']);

/** 带错误码的业务异常；handler 统一转换成 {ok:false,code,message}。 */
class ApiError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

function fail(code, message, status) {
    throw new ApiError(code, message, status);
}

/* ------------------------------------------------------------------ */
/* 路径与存储                                                          */
/* ------------------------------------------------------------------ */

/** 解析 DSH_HOME：优先进程环境变量（绿色版启动器会设置），否则 ~/.dsh。 */
function resolveDshHome() {
    const fromEnv = (process.env.DSH_HOME || '').trim();
    if (fromEnv) return resolve(fromEnv);
    return join(homedir(), '.dsh');
}

/** 计算技能中心相关路径。 */
function paths() {
    const home = resolveDshHome();
    const skills = join(home, 'skills');
    const center = join(home, 'skill-center');
    return {
        home,
        skills,
        center,
        disabled: join(center, 'disabled'),
        trash: join(center, 'trash'),
    };
}

/** 首次访问时创建目录（个人技能根/停用区/回收站）。 */
function ensureDirs() {
    const p = paths();
    for (const dir of [p.skills, p.center, p.disabled, p.trash]) {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
}

/** 判断 child 是否位于 parent 内（都用 realpath 归一，防路径穿越/符号链接）。 */
function isInside(parent, child) {
    let base;
    try { base = realpathSync(parent); } catch { base = resolve(parent); }
    let target;
    try { target = realpathSync(child); } catch { target = resolve(child); }
    const rel = relative(base, target);
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'));
}

/** 原子写文本：同目录临时文件 + rename。 */
function writeFileAtomic(target, content) {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = target + '.tmp-' + randomBytes(4).toString('hex');
    try {
        writeFileSync(tmp, content, 'utf-8');
        renameSync(tmp, target);
    } catch (error) {
        try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
        throw error;
    }
}

/** 跨设备安全的移动（rename 失败时 copy+remove）。 */
function movePath(source, target) {
    mkdirSync(dirname(target), { recursive: true });
    try {
        renameSync(source, target);
        return;
    } catch (error) {
        if (!error || error.code !== 'EXDEV') throw error;
    }
    cpSync(source, target, { recursive: true });
    rmSync(source, { recursive: true, force: true });
}

/** 删除目录/文件（尽力而为）。 */
function removePath(target) {
    try { rmSync(target, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

/* ------------------------------------------------------------------ */
/* frontmatter 解析（只解析 SKILL.md 需要的顶层字段，无第三方依赖）      */
/* ------------------------------------------------------------------ */

/** 解析布尔字段；非法拼写返回 {ok:false}（按 DSH 约定整条 skill 被丢弃）。 */
function parseBoolField(raw, fallback) {
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return { ok: true, value: fallback };
    }
    const text = String(raw).trim().toLowerCase();
    if (['true', 'yes', 'on', '1'].includes(text)) return { ok: true, value: true };
    if (['false', 'no', 'off', '0'].includes(text)) return { ok: true, value: false };
    return { ok: false, value: fallback };
}

/**
 * 解析 SKILL.md：必须以 --- 开头，第二段 --- 结束；只取顶层 key: value。
 * 返回 {ok, data, body, error}；data = {name, description, whenToUse, modelInvocable, userInvocable}。
 */
function parseFrontmatter(text) {
    const source = String(text == null ? '' : text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    if (!source.startsWith('---')) {
        return { ok: false, data: null, body: source, error: '缺少 YAML frontmatter（文件必须从 --- 开始）' };
    }
    const lines = source.split('\n');
    let endIndex = -1;
    for (let i = 1; i < lines.length; i += 1) {
        if (lines[i].trim() === '---') { endIndex = i; break; }
    }
    if (endIndex < 0) {
        return { ok: false, data: null, body: source, error: 'frontmatter 未闭合（缺少第二个 ---）' };
    }
    const headerLines = lines.slice(1, endIndex);
    const body = lines.slice(endIndex + 1).join('\n');
    const raw = {};
    for (const line of headerLines) {
        if (!line || line.startsWith(' ') || line.startsWith('\t') || line.startsWith('#')) continue;
        const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
        if (!match) continue;
        let value = match[2].trim();
        if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
            value = value.slice(1, -1);
        }
        raw[match[1]] = value;
    }
    const skillName = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!skillName) return { ok: false, data: null, body, error: 'frontmatter 缺少 name 字段' };
    if (!NAME_RE.test(skillName) || RESERVED_NAME_RE.test(skillName)) {
        return { ok: false, data: null, body, error: 'skill name 必须是 kebab-case（小写字母/数字/连字符）且不能是 Windows 保留名' };
    }
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    if (!description) return { ok: false, data: null, body, error: 'frontmatter 缺少 description 字段' };
    const modelFlag = parseBoolField(raw['disable-model-invocation'], false);
    const userFlag = parseBoolField(raw['user-invocable'], true);
    if (!modelFlag.ok || !userFlag.ok) {
        return { ok: false, data: null, body, error: 'disable-model-invocation / user-invocable 必须是布尔值' };
    }
    const whenToUse = typeof raw.whenToUse === 'string' ? raw.whenToUse.trim()
        : (typeof raw['when-to-use'] === 'string' ? raw['when-to-use'].trim() : '');
    return {
        ok: true,
        body,
        data: {
            name: skillName,
            description,
            whenToUse,
            modelInvocable: !modelFlag.value,
            userInvocable: userFlag.value,
        },
        error: null,
    };
}

/** 生成新技能的完整 SKILL.md 文本（description 用 JSON 引号转义，兼容 YAML 双引号）。 */
function composeSkill(name, description, whenToUse, body) {
    const header = ['---', 'name: ' + name, 'description: ' + JSON.stringify(String(description || '').trim())];
    if (whenToUse && String(whenToUse).trim()) header.push('whenToUse: ' + JSON.stringify(String(whenToUse).trim()));
    header.push('---', '');
    const content = String(body == null ? '' : body).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    const text = content.trim() ? content.replace(/^\n+/, '') : '# ' + name + '\n\nTODO: 在这里编写技能说明。\n';
    return header.join('\n') + '\n' + text;
}

/** 基础校验技能名。 */
function assertName(rawName) {
    const value = typeof rawName === 'string' ? rawName.trim() : '';
    if (!value) fail('NAME_INVALID', '技能名不能为空');
    if (value.length > 64) fail('NAME_INVALID', '技能名不能超过 64 个字符');
    if (!NAME_RE.test(value)) fail('NAME_INVALID', '技能名必须是 kebab-case（小写字母/数字/连字符），例如 my-skill');
    if (RESERVED_NAME_RE.test(value)) fail('NAME_INVALID', '技能名不能使用 Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）');
    return value;
}

/* ------------------------------------------------------------------ */
/* 磁盘扫描                                                            */
/* ------------------------------------------------------------------ */

/** 读取单个技能记录（不因无效而中断列表，用 valid/error 标记）。 */
function readRecord(root, displayName, filePath, kind) {
    let sizeBytes = 0;
    let updatedAt = 0;
    let text = '';
    let error = null;
    try {
        const st = statSync(filePath);
        sizeBytes = st.size;
        updatedAt = st.mtimeMs;
        if (sizeBytes > MAX_SKILL_BYTES) {
            error = 'SKILL.md 超过 256KB 上限';
        } else {
            text = readFileSync(filePath, 'utf-8');
        }
    } catch (readError) {
        error = '读取失败: ' + ((readError && readError.message) || readError);
    }
    let fm = { ok: false, error: error || '未能解析', data: null };
    if (!error) fm = parseFrontmatter(text);
    const data = fm.ok ? fm.data : null;
    const nameMismatch = fm.ok && data.name !== displayName;
    const finalError = error || (fm.ok ? (nameMismatch ? 'frontmatter 的 name（' + data.name + '）与目录/文件名不一致' : null) : fm.error);
    return {
        name: displayName,
        kind,
        path: filePath,
        dirPath: kind === 'dir' ? dirname(filePath) : null,
        root,
        sizeBytes,
        updatedAt,
        valid: fm.ok && !nameMismatch,
        error: finalError,
        description: data ? data.description : '',
        whenToUse: data ? data.whenToUse : '',
        invocation: data
            ? { modelInvocable: data.modelInvocable, userInvocable: data.userInvocable }
            : { modelInvocable: true, userInvocable: true },
    };
}

/** 扫描一个技能根目录：<name>/SKILL.md（目录）与 <name>.md（扁平），只扫一层。 */
function scanRoot(root) {
    const records = [];
    if (!existsSync(root)) return records;
    let entries = [];
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { return records; }
    const byName = new Map();
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (entry.name.startsWith('.')) continue;
        const full = join(root, entry.name);
        let st;
        try { st = lstatSync(full); } catch { continue; }
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
            const file = join(full, 'SKILL.md');
            if (!existsSync(file)) continue;
            const record = readRecord(root, entry.name, file, 'dir');
            const previous = byName.get(entry.name);
            // 同名时目录优先于扁平文件
            if (!previous || previous.kind === 'flat') byName.set(entry.name, record);
            continue;
        }
        if (st.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name !== 'SKILL.md') {
            const base = basename(entry.name, extname(entry.name));
            if (!base) continue;
            const record = readRecord(root, base, full, 'flat');
            if (!byName.has(base)) byName.set(base, record);
        }
    }
    for (const record of byName.values()) records.push(record);
    records.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return records;
}

/** 扫描个人技能与已停用技能。 */
function scanAll() {
    const p = paths();
    return {
        personal: scanRoot(p.skills),
        disabled: scanRoot(p.disabled),
    };
}

/** 在个人/停用记录里按名称查找。 */
function findDiskRecord(name) {
    const all = scanAll();
    const personal = all.personal.find((item) => item.name === name) || null;
    const disabled = all.disabled.find((item) => item.name === name) || null;
    return { personal, disabled };
}

/* ------------------------------------------------------------------ */
/* ctx.skills 读取（官方技能）                                          */
/* ------------------------------------------------------------------ */

/** 把请求里的 sessionId 解析成 agent（作为 skill 查询的 scope），失败返回 undefined。 */
function resolveAgentScope(ctx, sessionId) {
    if (!sessionId) return undefined;
    const agents = ctx.get('agents');
    if (!agents || typeof agents.get !== 'function') return undefined;
    try { return agents.get(String(sessionId)) || undefined; } catch { return undefined; }
}

/**
 * 判断一个 skill 摘要是否属于「官方」：
 * - bundled：随包 skill（filesystem 的 bundledSkillDir，rank 600）；
 * - custom 但路径位于 DSH 安装目录的 node_modules/@deepseek-ai/ 下——典型是
 *   agent preset 挂载的随包技能（source 仍报 custom，但并非用户自建）。
 * 其余（project / user / 用户 custom / runtime 注册）算「其他来源」或「我的」。
 */
function isOfficialSummary(item) {
    const source = String(item.source || '');
    if (source === 'bundled') return true;
    if (source !== 'custom') return false;
    const path = String(item.path || '');
    if (!path) return false;
    return path.replace(/\\/g, '/').toLowerCase().includes('/node_modules/@deepseek-ai/');
}

/** 读取官方/其他来源技能摘要；服务不可用时返回空集合并标记 unavailable。 */
async function collectRegistry(ctx, sessionId) {
    const skills = ctx.get('skills');
    if (!skills || typeof skills.list !== 'function') {
        return { available: false, incomplete: false, official: [], other: [], error: '当前 profile 未启用 skill 注册表（@deepseek-ai/dsh-skill）' };
    }
    const agent = resolveAgentScope(ctx, sessionId);
    let summaries = [];
    let incomplete = false;
    let error = null;
    try {
        summaries = await skills.list(agent ? { scope: agent } : {});
        incomplete = false;
    } catch (listError) {
        incomplete = true;
        error = (listError && listError.message) || String(listError);
        return { available: true, incomplete, official: [], other: [], error };
    }
    const official = [];
    const other = [];
    for (const summary of summaries || []) {
        const source = String(summary.source || '');
        const item = {
            name: summary.name,
            description: summary.description || '',
            whenToUse: summary.whenToUse || '',
            source,
            provider: summary.provider || '',
            path: summary.path || '',
            invocation: summary.invocation || { modelInvocable: true, userInvocable: true },
        };
        if (source === 'user-dsh') continue; // 个人技能以磁盘为准
        if (isOfficialSummary(item)) official.push(item);
        else other.push(item);
    }
    official.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    other.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { available: true, incomplete, official, other, error };
}

/** 取所有已知技能名（个人磁盘 + 注册表），用于冲突检查。 */
async function knownNames(ctx) {
    const disk = scanAll();
    const names = new Set([
        ...disk.personal.map((item) => item.name),
        ...disk.disabled.map((item) => item.name),
    ]);
    const registry = await collectRegistry(ctx, '');
    for (const item of registry.official.concat(registry.other)) names.add(item.name);
    return names;
}

/* ------------------------------------------------------------------ */
/* 导入实现                                                            */
/* ------------------------------------------------------------------ */

/** 统计目录内文件数与总大小，检测符号链接。 */
function measureTree(sourceDir) {
    let files = 0;
    let bytes = 0;
    const stack = [sourceDir];
    while (stack.length > 0) {
        const current = stack.pop();
        let entries = [];
        try { entries = readdirSync(current, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) continue;
            const full = join(current, entry.name);
            let st;
            try { st = lstatSync(full); } catch { continue; }
            if (st.isSymbolicLink()) fail('PATH_INVALID', '待导入的技能目录包含符号链接，已拒绝：' + full);
            if (st.isDirectory()) { stack.push(full); continue; }
            if (!st.isFile()) continue;
            files += 1;
            bytes += st.size;
            if (files > MAX_BUNDLE_FILES) fail('TOO_MANY_FILES', '技能目录文件数超过 ' + MAX_BUNDLE_FILES + ' 个上限');
            if (bytes > MAX_BUNDLE_BYTES) fail('TOO_LARGE', '技能目录总大小超过 8MB 上限');
        }
    }
    return { files, bytes };
}

/** 复制技能目录到目标（跳过 .git/node_modules 等）。 */
function copyBundle(sourceDir, targetDir) {
    if (!isInside(sourceDir, targetDir) && existsSync(targetDir)) removePath(targetDir);
    mkdirSync(targetDir, { recursive: true });
    const stack = [[sourceDir, targetDir]];
    while (stack.length > 0) {
        const pair = stack.pop();
        const sourceCurrent = pair[0];
        const targetCurrent = pair[1];
        let entries = [];
        try { entries = readdirSync(sourceCurrent, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            if (SKIP_DIRS.has(entry.name)) continue;
            const sourceFull = join(sourceCurrent, entry.name);
            const targetFull = join(targetCurrent, entry.name);
            let st;
            try { st = lstatSync(sourceFull); } catch { continue; }
            if (st.isSymbolicLink()) fail('PATH_INVALID', '待导入的技能目录包含符号链接：' + sourceFull);
            if (st.isDirectory()) {
                mkdirSync(targetFull, { recursive: true });
                stack.push([sourceFull, targetFull]);
            } else if (st.isFile()) {
                mkdirSync(dirname(targetFull), { recursive: true });
                writeFileSync(targetFull, readFileSync(sourceFull));
            }
        }
    }
}

/** 在 skill-center/ 下建一个临时目录（用于原子安装）。 */
function makeTempDir() {
    const p = paths();
    mkdirSync(p.center, { recursive: true });
    const tmp = join(p.center, 'tmp-' + randomBytes(6).toString('hex'));
    mkdirSync(tmp, { recursive: true });
    return tmp;
}

/* ------------------------------------------------------------------ */
/* ZIP 导入（零依赖：中央目录解析 + inflateRaw；含 zip-slip / zip bomb 防护） */
/* ------------------------------------------------------------------ */

/**
 * 规范化 ZIP 条目路径；非法返回 null。
 * 返回 { path, isDir }：目录条目（以 `/` 或 `\` 结尾）只用于跳过、不落盘；
 * 容忍 `./` 段（`./SKILL.md`、`a/./b`）；拒绝绝对路径、盘符、`..`、NUL。
 */
function normalizeZipEntryName(rawName) {
    let name = String(rawName || '').replace(/\\/g, '/');
    if (!name || name.includes('\u0000')) return null;
    if (name.startsWith('/')) return null;
    if (/^[A-Za-z]:/.test(name)) return null;
    const isDir = name.endsWith('/');
    const parts = name.split('/').filter((part) => part !== '' && part !== '.');
    if (parts.length === 0) return null;
    if (parts.some((part) => part === '..')) return null;
    return { path: parts.join('/'), isDir };
}

/** 解析 ZIP（仅 store/deflate），返回 [{name, data}]；超限/异常抛 ApiError。 */
function readZipEntries(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 22) fail('ZIP_INVALID', '不是有效的 ZIP 文件');
    let eocd = -1;
    const stop = Math.max(0, buffer.length - 22 - 0xffff);
    for (let i = buffer.length - 22; i >= stop; i -= 1) {
        if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) fail('ZIP_INVALID', '不是有效的 ZIP 文件（找不到中央目录结尾）');
    const diskNumber = buffer.readUInt16LE(eocd + 4);
    const cdDisk = buffer.readUInt16LE(eocd + 6);
    const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
    const totalEntries = buffer.readUInt16LE(eocd + 10);
    const cdSize = buffer.readUInt32LE(eocd + 12);
    const cdOffset = buffer.readUInt32LE(eocd + 16);
    if (diskNumber !== 0 || cdDisk !== 0) fail('ZIP_INVALID', '不支持分卷 ZIP');
    if (entriesOnDisk === 0xffff || totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
        fail('ZIP_INVALID', '不支持 ZIP64（请重新打包为普通 ZIP<4GB）');
    }
    if (totalEntries === 0) fail('ZIP_INVALID', 'ZIP 是空文件');
    if (cdOffset + cdSize > buffer.length) fail('ZIP_INVALID', 'ZIP 中央目录越界');
    const entries = [];
    const seenNames = new Set();
    let pointer = cdOffset;
    for (let index = 0; index < totalEntries; index += 1) {
        if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== 0x02014b50) fail('ZIP_INVALID', 'ZIP 中央目录损坏');
        const flags = buffer.readUInt16LE(pointer + 8);
        const method = buffer.readUInt16LE(pointer + 10);
        const compSize = buffer.readUInt32LE(pointer + 20);
        const uncompSize = buffer.readUInt32LE(pointer + 24);
        const nameLen = buffer.readUInt16LE(pointer + 28);
        const extraLen = buffer.readUInt16LE(pointer + 30);
        const commentLen = buffer.readUInt16LE(pointer + 32);
        const externalAttrs = buffer.readUInt32LE(pointer + 38);
        const localOffset = buffer.readUInt32LE(pointer + 42);
        const rawName = buffer.subarray(pointer + 46, pointer + 46 + nameLen).toString('utf-8');
        pointer += 46 + nameLen + extraLen + commentLen;
        if (flags & 0x0001) fail('ZIP_INVALID', '不支持加密 ZIP');
        if (method !== 0 && method !== 8) fail('ZIP_INVALID', '不支持的压缩算法（仅 store/deflate）');
        const normalized = normalizeZipEntryName(rawName);
        if (!normalized) fail('PATH_INVALID', 'ZIP 包含非法路径条目: ' + rawName);
        const unixMode = (externalAttrs >>> 16) & 0xffff;
        if ((unixMode & 0xf000) === 0xa000) fail('PATH_INVALID', 'ZIP 包含符号链接条目: ' + normalized.path);
        if (normalized.isDir) continue; // 显式目录条目（如 trae-skill-creation/）：跳过，不落盘
        const name = normalized.path;
        if (seenNames.has(name)) fail('ZIP_INVALID', 'ZIP 包含重复条目: ' + name);
        seenNames.add(name);
        entries.push({ name, method, compSize, uncompSize, localOffset });
    }
    const files = [];
    let total = 0;
    for (const entry of entries) {
        if (entry.uncompSize > MAX_ZIP_FILE_BYTES) fail('TOO_LARGE', 'ZIP 内文件超过 4MB 上限: ' + entry.name);
        total += entry.uncompSize;
        if (total > MAX_ZIP_TOTAL_BYTES) fail('TOO_LARGE', 'ZIP 解压后总大小超过 24MB 上限');
        if (entry.uncompSize > 1024 * 1024 && entry.compSize > 0 && entry.uncompSize / entry.compSize > MAX_ZIP_RATIO) {
            fail('ZIP_INVALID', '压缩比异常，疑似 ZIP 炸弹: ' + entry.name);
        }
        if (entry.localOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) {
            fail('ZIP_INVALID', 'ZIP 本地头损坏: ' + entry.name);
        }
        const localNameLen = buffer.readUInt16LE(entry.localOffset + 26);
        const localExtraLen = buffer.readUInt16LE(entry.localOffset + 28);
        const dataStart = entry.localOffset + 30 + localNameLen + localExtraLen;
        if (dataStart + entry.compSize > buffer.length) fail('ZIP_INVALID', 'ZIP 数据越界: ' + entry.name);
        const raw = buffer.subarray(dataStart, dataStart + entry.compSize);
        let data;
        try {
            data = entry.method === 0 ? Buffer.from(raw) : inflateRawSync(raw);
        } catch {
            fail('ZIP_INVALID', 'ZIP 解压失败: ' + entry.name);
        }
        if (data.length !== entry.uncompSize) fail('ZIP_INVALID', 'ZIP 解压大小不符: ' + entry.name);
        files.push({ name: entry.name, data });
    }
    return files;
}

/** 把 ZIP 安全解到目标目录（跳过系统垃圾/依赖目录），返回写入文件数。 */
function extractZipToDir(buffer, targetDir) {
    const files = readZipEntries(buffer);
    mkdirSync(targetDir, { recursive: true });
    let written = 0;
    for (const file of files) {
        const lower = file.name.toLowerCase();
        if (lower.startsWith('__macosx/') || lower.endsWith('/.ds_store') || lower === '.ds_store') continue;
        const segments = lower.split('/');
        if (segments.includes('node_modules') || segments.includes('.git') || segments.includes('__pycache__')) continue;
        const target = join(targetDir, ...file.name.split('/'));
        if (!isInside(targetDir, target)) fail('PATH_INVALID', 'ZIP 路径越界: ' + file.name);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, file.data);
        written += 1;
        if (written > MAX_BUNDLE_FILES * 2) fail('TOO_MANY_FILES', 'ZIP 文件数超过上限');
    }
    return written;
}

/**
 * 在目录里发现技能候选（bundle 目录或扁平 .md）。
 * 支持：<name>/SKILL.md、SKILL.md、单层包装目录、skills/<name>/SKILL.md（多技能包）、<name>.md。
 */
function discoverSkillCandidates(rootDir, options) {
    const maxDepth = options && options.unwrap === false ? 1 : 2;
    const candidates = [];
    const seen = new Set();
    const add = (kind, path) => {
        if (seen.has(path)) return;
        seen.add(path);
        candidates.push({ kind, path });
    };
    const scan = (dir, depth) => {
        let entries = [];
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        const visible = entries.filter((entry) => !entry.name.startsWith('.') && entry.name !== '__MACOSX');
        if (visible.some((entry) => entry.isFile() && entry.name === 'SKILL.md')) { add('bundle', dir); return; }
        const subdirs = visible.filter((entry) => entry.isDirectory());
        const mdFiles = visible.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'));
        if (depth > 1 && subdirs.length === 1 && mdFiles.length === 0) {
            scan(join(dir, subdirs[0].name), depth - 1);
            if (candidates.length > 0) return;
        }
        const skillsEntry = subdirs.find((entry) => entry.name === 'skills');
        if (skillsEntry) {
            const skillsRoot = join(dir, 'skills');
            let inner = [];
            try { inner = readdirSync(skillsRoot, { withFileTypes: true }); } catch { inner = []; }
            for (const entry of inner) {
                if (entry.isDirectory() && !entry.name.startsWith('.')) {
                    const skillDir = join(skillsRoot, entry.name);
                    if (existsSync(join(skillDir, 'SKILL.md'))) add('bundle', skillDir);
                } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
                    add('flat', join(skillsRoot, entry.name));
                }
            }
            if (candidates.length > 0) return;
        }
        for (const entry of subdirs) {
            const skillDir = join(dir, entry.name);
            if (existsSync(join(skillDir, 'SKILL.md'))) add('bundle', skillDir);
        }
        if (candidates.length > 0) return;
        for (const entry of mdFiles) add('flat', join(dir, entry.name));
    };
    scan(rootDir, maxDepth);
    return candidates;
}

/** 读取一个候选技能源的 SKILL.md 并校验 frontmatter/名称。 */
function inspectSkillSource(source) {
    const bundleDir = source.kind === 'bundle' ? source.path : null;
    const flatFile = source.kind === 'flat' ? source.path : null;
    const mainFile = bundleDir ? join(bundleDir, 'SKILL.md') : flatFile;
    let text = '';
    try {
        text = readFileSync(mainFile, 'utf-8');
    } catch (error) {
        fail('IO_ERROR', '读取 SKILL.md 失败: ' + ((error && error.message) || error), 500);
    }
    const parsed = parseFrontmatter(text);
    if (!parsed.ok) fail('FRONTMATTER_INVALID', parsed.error);
    const skillName = assertName(parsed.data.name);
    return { bundleDir, flatFile, mainFile, text, parsed, skillName };
}

/** 把一个候选技能安装到个人技能根（含冲突处理与原子写入）。 */
async function installSkillFromSource(ctx, source, options) {
    const info = inspectSkillSource(source);
    const overwrite = options.overwrite === true;
    const allowShadow = options.allowShadow === true;
    const disk = findDiskRecord(info.skillName);
    if (disk.personal) {
        if (!overwrite) fail('EXISTS', '个人技能已存在: ' + info.skillName + '（如需覆盖请勾选覆盖）');
        movePath(disk.personal.kind === 'dir' ? disk.personal.dirPath : disk.personal.path, join(paths().trash, Date.now() + '-' + info.skillName));
    }
    if (disk.disabled) {
        if (!overwrite) fail('EXISTS', '已停用列表里已有同名技能: ' + info.skillName);
        movePath(disk.disabled.kind === 'dir' ? disk.disabled.dirPath : disk.disabled.path, join(paths().trash, Date.now() + '-disabled-' + info.skillName));
    }
    if (!disk.personal) {
        const registry = await collectRegistry(ctx, '');
        const conflict = registry.official.concat(registry.other).find((item) => item.name === info.skillName);
        if (conflict && !allowShadow) {
            fail('OFFICIAL_CONFLICT', '已存在同名官方技能（' + conflict.source + '）: ' + info.skillName + '；如仍要安装（遮蔽官方同名技能）请确认');
        }
    }
    if (info.bundleDir) {
        measureTree(info.bundleDir);
        const tmpDir = makeTempDir();
        const target = join(paths().skills, info.skillName);
        try {
            copyBundle(info.bundleDir, tmpDir);
            if (!existsSync(join(tmpDir, 'SKILL.md'))) fail('PATH_INVALID', '复制后缺少 SKILL.md');
            if (existsSync(target)) fail('EXISTS', '目标目录已存在: ' + info.skillName);
            renameSync(tmpDir, target);
        } catch (error) {
            removePath(tmpDir);
            if (error instanceof ApiError) throw error;
            fail('IO_ERROR', '导入失败: ' + ((error && error.message) || error), 500);
        }
        return { name: info.skillName, kind: 'dir', path: join(target, 'SKILL.md') };
    }
    const targetFile = join(paths().skills, info.skillName + '.md');
    if (existsSync(targetFile)) fail('EXISTS', '目标文件已存在: ' + info.skillName + '.md');
    try {
        writeFileAtomic(targetFile, info.text);
    } catch (error) {
        fail('IO_ERROR', '导入失败: ' + ((error && error.message) || error), 500);
    }
    return { name: info.skillName, kind: 'flat', path: targetFile };
}

/* ------------------------------------------------------------------ */
/* HTTP 工具                                                           */
/* ------------------------------------------------------------------ */

/** 返回 JSON 响应。 */
function sendJson(res, status, payload) {
    let body = '';
    try { body = JSON.stringify(payload); } catch { body = '{"ok":false,"code":"IO_ERROR","message":"响应序列化失败"}'; }
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}

/** 读取并解析 JSON 请求体（有上限，ZIP 路由可传更大 limit）。 */
function readJsonBody(req, limit) {
    const maxBytes = typeof limit === 'number' && limit > 0 ? limit : MAX_BODY_BYTES;
    return new Promise((resolveBody, rejectBody) => {
        const chunks = [];
        let size = 0;
        let settled = false;
        const rejectOnce = (error) => { if (!settled) { settled = true; rejectBody(error); } };
        req.on('data', (chunk) => {
            if (settled) return;
            size += chunk.length;
            if (size > maxBytes) {
                rejectOnce(new ApiError('TOO_LARGE', '请求体超过 ' + Math.round(maxBytes / 1024 / 1024) + 'MB 上限', 413));
                try { req.destroy(); } catch { /* 忽略 */ }
                return;
            }
            chunks.push(chunk);
        });
        req.on('error', (error) => rejectOnce(new ApiError('BAD_REQUEST', '读取请求失败: ' + ((error && error.message) || error))));
        req.on('end', () => {
            if (settled) return;
            settled = true;
            const text = Buffer.concat(chunks).toString('utf-8');
            if (!text.trim()) { resolveBody({}); return; }
            try {
                const parsed = JSON.parse(text);
                resolveBody(parsed && typeof parsed === 'object' ? parsed : {});
            } catch (error) {
                rejectBody(new ApiError('BAD_REQUEST', '请求体不是合法 JSON'));
            }
        });
    });
}

/* ------------------------------------------------------------------ */
/* 路由处理                                                            */
/* ------------------------------------------------------------------ */

/** GET /list */
async function handleList(ctx, req) {
    ensureDirs();
    const url = new URL(req.url, 'http://127.0.0.1');
    const sessionId = url.searchParams.get('sessionId') || '';
    const disk = scanAll();
    const registry = await collectRegistry(ctx, sessionId);
    const registryByName = new Map();
    for (const item of registry.official.concat(registry.other)) registryByName.set(item.name, item);
    const personal = disk.personal.map((record) => {
        const hit = registryByName.get(record.name);
        const merged = { ...record };
        if (hit) {
            merged.registry = { source: hit.source, provider: hit.provider, invocation: hit.invocation };
            if (hit.source !== 'user-dsh') merged.shadowNotice = '与 ' + hit.source + ' 同名技能冲突，当前生效来源需在会话内确认';
        }
        return merged;
    });
    const p = paths();
    return {
        ok: true,
        roots: { home: p.home, skills: p.skills, disabled: p.disabled },
        personal,
        official: registry.official,
        other: registry.other,
        disabled: disk.disabled,
        incomplete: registry.incomplete,
        registryAvailable: registry.available,
        registryError: registry.error || null,
        counts: {
            personal: personal.length,
            official: registry.official.length,
            other: registry.other.length,
            disabled: disk.disabled.length,
        },
    };
}

/** 读取某个技能的正文（个人/停用读磁盘；官方/其他走 ctx.skills，失败时回退摘要 path）。 */
async function handleRead(ctx, body) {
    ensureDirs();
    const skillName = assertName(body.name);
    const group = String(body.group || 'personal');
    if (group === 'personal' || group === 'disabled') {
        const disk = findDiskRecord(skillName);
        const record = group === 'personal' ? disk.personal : disk.disabled;
        if (!record) fail('NOT_FOUND', '技能不存在: ' + skillName);
        if (record.sizeBytes > MAX_SKILL_BYTES) fail('TOO_LARGE', 'SKILL.md 超过 256KB 上限');
        const content = readFileSync(record.path, 'utf-8');
        return { ok: true, name: skillName, group, content, record };
    }
    const skills = ctx.get('skills');
    if (!skills || typeof skills.get !== 'function') fail('SKILLS_UNAVAILABLE', '当前 profile 未启用 skill 注册表');
    const agent = resolveAgentScope(ctx, body.sessionId);
    let definition = null;
    try {
        definition = await skills.get(skillName, agent ? { scope: agent } : {});
    } catch (getError) {
        definition = null;
    }
    if (definition && typeof definition.content === 'string') {
        return {
            ok: true,
            name: skillName,
            group,
            content: definition.content,
            record: {
                name: definition.name,
                description: definition.description || '',
                source: definition.source || '',
                provider: definition.provider || '',
                path: definition.path || '',
                invocation: definition.invocation || { modelInvocable: true, userInvocable: true },
            },
        };
    }
    const registry = await collectRegistry(ctx, body.sessionId);
    const hit = registry.official.concat(registry.other).find((item) => item.name === skillName);
    if (!hit) fail('NOT_FOUND', '技能不存在或不可读: ' + skillName);
    if (hit.path && existsSync(hit.path)) {
        const st = statSync(hit.path);
        if (st.size > MAX_SKILL_BYTES) fail('TOO_LARGE', 'SKILL.md 超过 256KB 上限');
        const content = readFileSync(hit.path, 'utf-8');
        return { ok: true, name: skillName, group, content, record: hit };
    }
    fail('NOT_FOUND', '技能正文不可读: ' + skillName);
}

/** POST /create：新建个人技能目录 bundle。 */
async function handleCreate(ctx, body) {
    ensureDirs();
    const skillName = assertName(body.name);
    const description = String(body.description || '').trim();
    if (!description) fail('FRONTMATTER_INVALID', 'description 不能为空');
    if (description.length > 1024) fail('FRONTMATTER_INVALID', 'description 不能超过 1024 个字符');
    const whenToUse = String(body.whenToUse || '').trim();
    const names = await knownNames(ctx);
    if (names.has(skillName)) fail('EXISTS', '同名技能已存在（个人/已停用/官方）：' + skillName);
    const content = composeSkill(skillName, description, whenToUse, body.content);
    const parsed = parseFrontmatter(content);
    if (!parsed.ok) fail('FRONTMATTER_INVALID', parsed.error);
    const tmpDir = makeTempDir();
    const target = join(paths().skills, skillName);
    try {
        writeFileSync(join(tmpDir, 'SKILL.md'), content, 'utf-8');
        if (existsSync(target)) fail('EXISTS', '目标技能目录已存在: ' + skillName);
        renameSync(tmpDir, target);
    } catch (error) {
        removePath(tmpDir);
        if (error instanceof ApiError) throw error;
        fail('IO_ERROR', '创建技能失败: ' + ((error && error.message) || error), 500);
    }
    return { ok: true, name: skillName, kind: 'dir', path: join(target, 'SKILL.md') };
}

/** POST /save：保存个人技能正文（原子写，必须仍是合法 frontmatter 且同名）。 */
async function handleSave(ctx, body) {
    ensureDirs();
    const skillName = assertName(body.name);
    const content = String(body.content == null ? '' : body.content);
    if (Buffer.byteLength(content, 'utf-8') > MAX_SKILL_BYTES) fail('TOO_LARGE', 'SKILL.md 超过 256KB 上限');
    const parsed = parseFrontmatter(content);
    if (!parsed.ok) fail('FRONTMATTER_INVALID', parsed.error);
    if (parsed.data.name !== skillName) {
        fail('FRONTMATTER_INVALID', 'frontmatter 的 name（' + parsed.data.name + '）必须与技能名（' + skillName + '）一致');
    }
    const disk = findDiskRecord(skillName);
    if (!disk.personal) fail('NOT_FOUND', '个人技能不存在（官方技能只读）: ' + skillName);
    const record = disk.personal;
    try {
        writeFileAtomic(record.path, content);
    } catch (error) {
        if (error && (error.code === 'EBUSY' || error.code === 'EPERM')) {
            fail('IO_ERROR', '文件被占用，保存失败，请重试或重启服务后重试', 500);
        }
        fail('IO_ERROR', '保存失败: ' + ((error && error.message) || error), 500);
    }
    return { ok: true, name: skillName, path: record.path };
}

/** POST /install-folder：从本地目录（含 SKILL.md）或单个 .md 导入个人技能。 */
async function handleInstallFolder(ctx, body) {
    ensureDirs();
    const rawPath = String(body.path || '').trim();
    if (!rawPath) fail('BAD_REQUEST', '缺少 path');
    const source = resolve(rawPath);
    if (!existsSync(source)) fail('NOT_FOUND', '路径不存在: ' + source);
    let st;
    try { st = lstatSync(source); } catch { fail('NOT_FOUND', '无法访问路径: ' + source); }
    if (st.isSymbolicLink()) fail('PATH_INVALID', '不允许导入符号链接');
    let candidates = [];
    if (st.isFile()) {
        if (extname(source).toLowerCase() !== '.md') fail('PATH_INVALID', '请选择技能文件夹或单个 .md 文件');
        candidates = [{ kind: 'flat', path: source }];
    } else if (st.isDirectory()) {
        candidates = discoverSkillCandidates(source, { unwrap: true });
        if (candidates.length === 0) fail('PATH_INVALID', '目录中没有找到 SKILL.md');
        if (candidates.length > 1) {
            fail('PATH_INVALID', '目录下有多个技能，请直接选择其中一个，或改用 ZIP 导入批量安装');
        }
    } else {
        fail('PATH_INVALID', '不支持的路径类型');
    }
    const result = await installSkillFromSource(ctx, candidates[0], {
        overwrite: body.overwrite === true,
        allowShadow: body.allowShadow === true,
    });
    return { ok: true, name: result.name, kind: result.kind, path: result.path, imported: [result] };
}

/** 在临时目录里发现技能并逐个安装，返回 {imported, failed}。 */
async function installFromStagedDir(ctx, tempDir, options) {
    const candidates = discoverSkillCandidates(tempDir, { unwrap: true });
    if (candidates.length === 0) {
        fail('ZIP_INVALID', '没有找到技能（支持 <name>/SKILL.md、SKILL.md、skills/<name>/SKILL.md、<name>.md）');
    }
    const imported = [];
    const failed = [];
    for (const candidate of candidates) {
        try {
            const result = await installSkillFromSource(ctx, candidate, options);
            imported.push(result);
        } catch (error) {
            let relativeSource = candidate.path;
            try { relativeSource = relative(tempDir, candidate.path).replace(/\\/g, '/') || candidate.path; } catch { /* 忽略 */ }
            failed.push({
                code: error instanceof ApiError ? error.code : 'IO_ERROR',
                message: (error && error.message) || String(error),
                source: relativeSource,
            });
        }
    }
    return { imported, failed };
}

/**
 * POST /import-zip：上传 ZIP（base64）导入技能。
 * 支持一个或多个技能；逐个安装，返回 imported / failed，冲突策略与文件夹导入一致。
 */
async function handleImportZip(ctx, body) {
    ensureDirs();
    const encoded = typeof body.dataBase64 === 'string' ? body.dataBase64.trim() : '';
    if (!encoded) fail('BAD_REQUEST', '缺少 ZIP 数据（dataBase64）');
    if (encoded.length > MAX_ZIP_BYTES * 2) fail('TOO_LARGE', 'ZIP 文件超过 12MB 上限');
    let buffer;
    try {
        buffer = Buffer.from(encoded, 'base64');
    } catch (error) {
        fail('ZIP_INVALID', 'ZIP 数据不是合法 base64');
    }
    if (!buffer || buffer.length === 0) fail('ZIP_INVALID', 'ZIP 数据为空');
    if (buffer.length > MAX_ZIP_BYTES) fail('TOO_LARGE', 'ZIP 文件超过 12MB 上限');
    const tempDir = makeTempDir();
    try {
        try {
            extractZipToDir(buffer, tempDir);
        } catch (error) {
            if (error instanceof ApiError) throw error;
            fail('ZIP_INVALID', 'ZIP 解压失败: ' + ((error && error.message) || error));
        }
        const result = await installFromStagedDir(ctx, tempDir, {
            overwrite: body.overwrite === true,
            allowShadow: body.allowShadow === true,
        });
        return { ok: true, imported: result.imported, failed: result.failed, candidates: result.imported.length + result.failed.length };
    } finally {
        removePath(tempDir);
    }
}

/**
 * POST /import-bundle：已移除（DSH 0.2.1-rc.3 无目录选择服务，浏览器也拿不到绝对路径，
 * 上一版的 webkitdirectory 上传在 WebView2 里拿不到文件，故只保留 ZIP / 路径导入）。
 */

/** POST /toggle：停用/启用个人技能（移出或移回扫描根）。 */
async function handleToggle(ctx, body) {
    ensureDirs();
    const skillName = assertName(body.name);
    const enable = body.enabled !== false;
    const disk = findDiskRecord(skillName);
    const p = paths();
    if (!enable) {
        if (!disk.personal) fail('NOT_FOUND', '个人技能不存在: ' + skillName);
        const record = disk.personal;
        const target = record.kind === 'dir' ? join(p.disabled, skillName) : join(p.disabled, skillName + '.md');
        if (existsSync(target)) fail('EXISTS', '停用区已存在同名技能: ' + skillName);
        try {
            movePath(record.kind === 'dir' ? record.dirPath : record.path, target);
        } catch (error) { fail('IO_ERROR', '停用失败: ' + ((error && error.message) || error), 500); }
        return { ok: true, name: skillName, enabled: false };
    }
    if (!disk.disabled) fail('NOT_FOUND', '停用区没有该技能: ' + skillName);
    const record = disk.disabled;
    const target = record.kind === 'dir' ? join(p.skills, skillName) : join(p.skills, skillName + '.md');
    if (existsSync(target)) fail('EXISTS', '个人技能目录已存在同名技能: ' + skillName);
    try {
        movePath(record.kind === 'dir' ? record.dirPath : record.path, target);
    } catch (error) { fail('IO_ERROR', '启用失败: ' + ((error && error.message) || error), 500); }
    return { ok: true, name: skillName, enabled: true };
}

/** POST /remove：卸载个人技能（移入回收站，可恢复）。 */
async function handleRemove(ctx, body) {
    ensureDirs();
    const skillName = assertName(body.name);
    const disk = findDiskRecord(skillName);
    const record = disk.personal || disk.disabled;
    if (!record) fail('NOT_FOUND', '个人技能不存在（官方技能只读）: ' + skillName);
    const trashId = String(Date.now()) + '-' + skillName;
    const target = join(paths().trash, trashId);
    try {
        movePath(record.kind === 'dir' ? record.dirPath : record.path, target);
    } catch (error) { fail('IO_ERROR', '卸载失败: ' + ((error && error.message) || error), 500); }
    return { ok: true, name: skillName, trashId };
}

/** POST /open-folder：用系统文件管理器打开技能目录。 */
async function handleOpenFolder(ctx, body) {
    ensureDirs();
    const p = paths();
    const target = String(body.target || 'skills') === 'disabled' ? p.disabled : p.skills;
    try {
        const command = process.platform === 'win32' ? 'explorer.exe'
            : process.platform === 'darwin' ? 'open' : 'xdg-open';
        const child = spawn(command, [target], { detached: true, stdio: 'ignore' });
        child.unref();
    } catch (error) {
        fail('IO_ERROR', '打开目录失败: ' + ((error && error.message) || error), 500);
    }
    return { ok: true, path: target };
}

/* ------------------------------------------------------------------ */
/* 插件入口                                                            */
/* ------------------------------------------------------------------ */

const ROUTES = [
    { method: 'GET', route: '/list', handler: handleList },
    { method: 'POST', route: '/read', handler: handleRead },
    { method: 'POST', route: '/create', handler: handleCreate },
    { method: 'POST', route: '/save', handler: handleSave },
    { method: 'POST', route: '/install-folder', handler: handleInstallFolder },
    { method: 'POST', route: '/import-zip', handler: handleImportZip, bodyLimit: MAX_ZIP_BODY_BYTES },
    { method: 'POST', route: '/toggle', handler: handleToggle },
    { method: 'POST', route: '/remove', handler: handleRemove },
    { method: 'POST', route: '/open-folder', handler: handleOpenFolder },
];

/**
 * Cordis 插件入口：注册全部路由。
 * 每个路由用 ctx.effect 包裹（与 dsh-rules 一致），插件卸载时自动注销。
 */
export async function apply(ctx) {
    let webServer = null;
    try { webServer = ctx.get('webServer'); } catch { webServer = null; }
    if (!webServer || typeof webServer.register !== 'function') {
        if (ctx.logger && ctx.logger.warn) ctx.logger.warn('[dsh-skill-center] 未找到 webServer 服务，插件不生效');
        return;
    }
    for (const entry of ROUTES) {
        const path = ROUTE_PREFIX + entry.route;
        const isGet = entry.method === 'GET';
        ctx.effect(() => webServer.register({
            kind: 'exact',
            path,
            handler: (req, res) => {
                if ((req.method || 'GET').toUpperCase() !== entry.method) {
                    sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '仅支持 ' + entry.method });
                    return;
                }
                Promise.resolve()
                    .then(async () => {
                        const input = isGet ? req : await readJsonBody(req, entry.bodyLimit);
                        const result = await entry.handler(ctx, input);
                        sendJson(res, 200, result);
                    })
                    .catch((error) => {
                        const apiError = error instanceof ApiError ? error : null;
                        if (!apiError && ctx.logger && ctx.logger.warn) {
                            ctx.logger.warn('[dsh-skill-center] ' + path + ' 处理失败: ' + ((error && error.message) || error));
                        }
                        sendJson(res, apiError ? apiError.status : 500, {
                            ok: false,
                            code: apiError ? apiError.code : 'IO_ERROR',
                            message: (error && error.message) || String(error),
                        });
                    });
            },
        }));
    }
    try {
        ensureDirs();
    } catch (error) {
        if (ctx.logger && ctx.logger.warn) ctx.logger.warn('[dsh-skill-center] 创建技能目录失败: ' + ((error && error.message) || error));
    }
    if (ctx.logger && ctx.logger.info) {
        ctx.logger.info('[dsh-skill-center] 已加载，个人技能根: ' + paths().skills);
    }
}
