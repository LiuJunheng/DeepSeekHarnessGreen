
// rewind-session.mjs — 把会话日志回退到最后一个完整回合(移除失败/卡住的回合)
// 用法: node rewind-session.mjs <session.jsonl.zstd 路径> [--turns N] [--force]
//   --turns 0 (默认): 只移除未完成的回合(有 turn/start 无 turn/end)
//   --turns N: 额外回退 N 个已完成的回合(用于清除中毒历史)
//   --force: 跳过"服务正在运行"检查(不推荐)
// 安全: 自动备份原文件为 <文件>.rewind-backup-<时间戳>.zstd
import { decodeStorageRecord, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import net from "node:net";
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function splitFrames(buf) {
  const frames = [];
  let i = 0;
  while (i < buf.length) {
    const hit = buf.indexOf(MAGIC, i);
    if (hit === -1) break;
    const nxt = buf.indexOf(MAGIC, hit + 4);
    frames.push(buf.subarray(hit, nxt === -1 ? buf.length : nxt));
    i = nxt === -1 ? buf.length : nxt;
  }
  return frames;
}

function decompress(buf) {
  const parts = splitFrames(buf).map((fr) => zlib.zstdDecompressSync(fr));
  return Buffer.concat(parts).toString("utf8");
}

function parseArgs(argv) {
  const args = { file: null, turns: 0, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--turns") { args.turns = parseInt(argv[i + 1], 10); i++; }
    else if (argv[i] === "--force") { args.force = true; }
    else if (!argv[i].startsWith("--")) args.file = argv[i];
  }
  return args;
}

const { file, turns, force } = parseArgs(process.argv.slice(2));
if (!file) { console.error("用法: node rewind-session.mjs <session.jsonl.zstd> [--turns N] [--force]"); process.exit(1); }
if (!existsSync(file)) { console.error("文件不存在: " + file); process.exit(1); }

// 安全检查: DSH 服务运行时内存缓存会覆盖文件,必须先停止服务
if (!force) {
  const serverUp = await new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port: 3080, timeout: 800 });
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => resolve(false));
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
  });
  if (serverUp) {
    console.error("错误: DSH 服务正在运行(127.0.0.1:3080)。请先停止服务再执行,否则内存缓存会覆盖修改。");
    console.error("(确认无误可加 --force 跳过检查)");
    process.exit(1);
  }
}

const raw = readFileSync(file);
const text = decompress(raw);
const lines = text.split("\n").filter((l) => l.length > 0);
if (lines.length === 0) { console.error("空文件"); process.exit(1); }

const header = JSON.parse(lines[0]);
if (header.type !== "session") { console.error("首行不是 session header"); process.exit(1); }
if (header.version !== SESSION_FORMAT_VERSION) { console.error("格式版本不兼容: " + header.version); process.exit(1); }

const rows = [];
let errors = 0;
for (let i = 1; i < lines.length; i++) {
  let parsed;
  try { parsed = JSON.parse(lines[i]); } catch { errors++; continue; }
  let decoded;
  try { decoded = decodeStorageRecord(parsed); } catch { errors++; continue; }
  rows.push({ lineIndex: i, events: decoded });
}
if (errors > 0) console.warn("警告: " + errors + " 行无法解析,已跳过");

const events = rows.flatMap((r) => r.events);
console.log("header: id=" + header.id + " 事件总数=" + events.length);

const turnEndSeqs = [];
for (const e of events) if (e.type === "turn/end") turnEndSeqs.push(e.seq);
console.log("已完成的回合数: " + turnEndSeqs.length);

let keepSeq;
if (turnEndSeqs.length === 0) {
  console.warn("没有任何已完成的回合,将清空事件(仅保留 header)");
  keepSeq = -1;
} else {
  const dropCount = Math.min(turns, turnEndSeqs.length);
  const keepIndex = turnEndSeqs.length - 1 - dropCount;
  keepSeq = turnEndSeqs[keepIndex];
  console.log("保留到 turn/end seq=" + keepSeq + " (回退了 " + (turnEndSeqs.length - 1 - keepIndex) + " 个完成的回合)");
}

const kept = events.filter((e) => e.seq <= keepSeq);
console.log("保留事件数: " + kept.length + " (移除 " + (events.length - kept.length) + " 个)");

// 重建: 第1帧 = header 一行; 第2帧 = 全部事件行(每行一条,读取端布局无关)
const headerLine = lines[0];
const eventLines = kept.map((e) => JSON.stringify(e));
const frame1 = zlib.zstdCompressSync(Buffer.from(headerLine + "\n", "utf8"));
const frame2 = eventLines.length > 0 ? zlib.zstdCompressSync(Buffer.from(eventLines.join("\n") + "\n", "utf8")) : Buffer.alloc(0);
const newBytes = frame2.length > 0 ? Buffer.concat([frame1, frame2]) : frame1;

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const backup = file + ".rewind-backup-" + ts + ".zstd";
copyFileSync(file, backup);
console.log("备份: " + backup);

writeFileSync(file, newBytes);
console.log("已重写: " + file + " (" + newBytes.length + " bytes, 帧数=" + (frame2.length > 0 ? 2 : 1) + ")");
console.log("完成。重启 DSH 服务后,该会话将回到最后一个完整回合;原内容保留在备份文件中。");
