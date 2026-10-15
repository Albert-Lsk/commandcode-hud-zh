// commandcode-hud-zh — 常驻上下文 HUD（Command Code mod）
//
// 在输入面板下方常驻一行：模型·推理档位 · 上下文进度条 · 花费 · 压缩 · 当前工具。
//
// 设计动机来自一次真实事故：某个 session 的 9 次自动压缩把锚点钉在同一张
// 389.9 KB 的截图上，压缩彻底失效，上下文地板卡在 4.26 MB，界面上毫无提示，
// 直到下一轮直接 400。
//
// 所以这个 mod 的重点不是「显示用了多少」，而是**在坏掉之前预警**：
//   ① 大结果预警   —— 什么内容正在永久占位（并可能钉死压缩锚点）
//   ② 压缩健康度   —— 压完之后上下文有没有真的下降（没降 = 压缩已失效）
//   ③ 压缩回收量   —— 压缩到底救回了多少
//   ④ 精确花费     —— 直接读会话文件里 CLI 自己算的 costUsd
//   ⑤ 请求体预警   —— 活跃链字节量（图片占大头）逼近网关 502 区间前预警
//
// 刻意不做：不 patch CLI 的 dist、不读 auth.json、不联网。

import type {ModApi} from '@commandcode/harness';
import {closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';

const MODEL_CONTEXT: Record<string, number> = {
	'MiniMaxAI/MiniMax-M2.5': 204800,
	'MiniMaxAI/MiniMax-M3': 1048576,
	'Qwen/Qwen3.7-Flash': 1048576,
	'Qwen/Qwen3.7-Max': 1048576,
	'Qwen/Qwen3.7-Plus': 1048576,
	'Qwen/Qwen3.8-27B': 268288,
	'Qwen/Qwen3.8-Flash': 1048576,
	'Qwen/Qwen3.8-Max': 1048576,
	'Qwen/Qwen3.8-Max-0902': 1048576,
	'claude-fable-5': 1048576,
	'claude-fable-5-1': 1048576,
	'claude-haiku-4-5-20251001': 204800,
	'claude-opus-4-7': 1048576,
	'claude-opus-4-8': 1048576,
	'claude-opus-5': 1048576,
	'claude-sonnet-4-6': 1048576,
	'claude-sonnet-5': 1048576,
	'deepseek/deepseek-v4-flash': 1048576,
	'deepseek/deepseek-v4-flash-fast': 1048576,
	'deepseek/deepseek-v4-flash-vision-exp': 1048576,
	'deepseek/deepseek-v4-pro': 1048576,
	'deepseek/deepseek-v4.1-flash': 1048576,
	'google/gemini-3.1-flash-lite': 1048576,
	'google/gemini-3.5-flash': 1048576,
	'google/gemini-3.5-flash-lite': 1048576,
	'google/gemini-3.6-flash': 1048576,
	'google/gemini-3.7-flash': 1101005,
	'google/gemini-3.8-flash': 1048576,
	'gpt-5.3-codex': 409600,
	'gpt-5.4': 409600,
	'gpt-5.4-mini': 409600,
	'gpt-5.5': 409600,
	'gpt-5.6-luna': 1101005,
	'gpt-5.6-sol': 1101005,
	'gpt-5.6-terra': 1101005,
	'gpt-6-astra': 1101005,
	'inclusionai/ling-3.0-flash-sante:free': 268288,
	'meituan/LongCat-2.0:free': 1101005,
	'meta/muse-spark-1.1': 1101005,
	'meta/muse-spark-1.2': 1101005,
	'meta/muse-spark-1.2-contributor': 1101005,
	'meta/muse-spark-1.3': 1101005,
	'meta/muse-spark-1.3-contributor': 1101005,
	'moonshotai/Kimi-K2.5': 262144,
	'moonshotai/Kimi-K2.6': 262144,
	'moonshotai/Kimi-K2.7-Code': 262144,
	'moonshotai/Kimi-K2.7-Code-Highspeed': 268288,
	'moonshotai/Kimi-K3': 1048576,
	'nvidia/nemotron-3-ultra-550b-a55b': 1048576,
	'poolside/laguna-s-2.1-free': 262144,
	'sakana/fugu-ultra': 1048576,
	'stepfun/Step-3.5-Flash': 1048576,
	'stepfun/Step-3.7-Flash': 262144,
	'tencent/hy3-paid': 268288,
	'tencent/hy4-preview': 1101005,
	'thinkingmachines/inkling': 262144,
	'thinkingmachines/inkling-small': 1048576,
	'xai/grok-4.5': 512000,
	'xai/grok-4.6': 512000,
	'xiaomi/mimo-v2.5': 1048576,
	'xiaomi/mimo-v2.5-pro': 1048576,
	'z-ai/glm-5.3-flash': 1101005,
	'zai-org/GLM-5': 204800,
	'zai-org/GLM-5.2': 1048576,
	'zai-org/GLM-5.2-Fast': 1048576,
	'zai-org/GLM-5.3': 1048576,
};

const MODEL_PRICE: Record<string, Price> = {
	'MiniMaxAI/MiniMax-M2.5': {in: 0.3, out: 1.2, read: 0.03, write: 0.3},
	'MiniMaxAI/MiniMax-M2.7': {in: 0.3, out: 1.2, read: 0.06, write: 0.3},
	'MiniMaxAI/MiniMax-M3': {in: 0.3, out: 1.2, read: 0.06, write: 0.3},
	'Qwen/Qwen3.6-Max-Preview': {in: 1.3, out: 7.8, read: 0.26, write: 1.63},
	'Qwen/Qwen3.6-Plus': {in: 0.5, out: 3, read: 0.1, write: 0.5},
	'Qwen/Qwen3.7-Flash': {in: 0.03, out: 0.13, read: 0.006, write: 0.038},
	'Qwen/Qwen3.7-Max': {in: 2.5, out: 7.5, read: 0.5, write: 3.13},
	'Qwen/Qwen3.7-Plus': {in: 0.4, out: 1.6, read: 0.08, write: 0.5},
	'Qwen/Qwen3.8-27B': {in: 0.4, out: 3, read: 0.04, write: 0.4},
	'Qwen/Qwen3.8-Flash': {in: 0.16, out: 0.47, read: 0.016, write: 0.16},
	'Qwen/Qwen3.8-Max': {in: 2, out: 6, read: 0.25, write: 2.5},
	'Qwen/Qwen3.8-Max-0902': {in: 2, out: 6, read: 0.25, write: 2},
	'claude-fable-5': {in: 10, out: 50, read: 1, write: 12.5},
	'claude-fable-5-1': {in: 10, out: 50, read: 0.25, write: 12.5},
	'claude-haiku-4-5-20251001': {in: 1, out: 5, read: 0.1, write: 1.25},
	'claude-opus-4-7': {in: 5, out: 25, read: 0.5, write: 6.25},
	'claude-opus-4-8': {in: 5, out: 25, read: 0.5, write: 6.25},
	'claude-opus-5': {in: 5, out: 25, read: 0.5, write: 6.25},
	'claude-sonnet-4-6': {in: 3, out: 15, read: 0.3, write: 3.75},
	'claude-sonnet-5': {in: 2, out: 10, read: 0.2, write: 2.5},
	'deepseek/deepseek-v4-flash': {in: 0.15, out: 0.6, read: 0.003, write: 0.15},
	'deepseek/deepseek-v4-flash-fast': {in: 0.28, out: 0.56, read: 0.07, write: 0.28},
	'deepseek/deepseek-v4-flash-vision-exp': {in: 0.15, out: 0.6, read: 0.003, write: 0.15},
	'deepseek/deepseek-v4-pro': {in: 0.66, out: 1.98, read: 0.022, write: 0.66},
	'deepseek/deepseek-v4.1-flash': {in: 0.15, out: 0.6, read: 0.003, write: 0.15},
	'google/gemini-3.1-flash-lite': {in: 0.25, out: 1.5, read: 0.03, write: 0.25},
	'google/gemini-3.5-flash': {in: 1.5, out: 9, read: 0.15, write: 1.5},
	'google/gemini-3.5-flash-lite': {in: 0.3, out: 2.5, read: 0.03, write: 0.3},
	'google/gemini-3.6-flash': {in: 1.5, out: 7.5, read: 0.15, write: 1.5},
	'google/gemini-3.7-flash': {in: 1.5, out: 7.5, read: 0.15, write: 0.08334},
	'google/gemini-3.8-flash': {in: 1.5, out: 7.5, read: 0.15, write: 1.5},
	'gpt-5.3-codex': {in: 2, out: 8, read: 0.5, write: 0},
	'gpt-5.4': {in: 2.5, out: 15, read: 0.25, write: 0},
	'gpt-5.4-mini': {in: 0.75, out: 4.5, read: 0.075, write: 0},
	'gpt-5.5': {in: 5, out: 30, read: 0.5, write: 0},
	'gpt-5.6-luna': {in: 0.2, out: 1.2, read: 0.02, write: 0.25},
	'gpt-5.6-sol': {in: 5, out: 30, read: 0.5, write: 6.25},
	'gpt-5.6-terra': {in: 2, out: 12, read: 0.2, write: 2.5},
	'gpt-6-astra': {in: 10, out: 50, read: 1, write: 12.5},
	'inclusionai/ling-3.0-flash-sante:free': {in: 0, out: 0, read: 0, write: 0},
	'meituan/LongCat-2.0:free': {in: 0, out: 0, read: 0, write: 0},
	'meta/muse-spark-1.1': {in: 1.25, out: 4.25, read: 0.15, write: 1.25},
	'meta/muse-spark-1.2': {in: 1.25, out: 4.25, read: 0.15, write: 1.25},
	'meta/muse-spark-1.2-contributor': {in: 0.1, out: 0.2, read: 0.002, write: 0.1},
	'meta/muse-spark-1.3': {in: 1.25, out: 4.25, read: 0.15, write: 1.25},
	'meta/muse-spark-1.3-contributor': {in: 0.1, out: 0.2, read: 0.002, write: 0.1},
	'moonshotai/Kimi-K2.5': {in: 0.6, out: 3, read: 0.1, write: 0.6},
	'moonshotai/Kimi-K2.6': {in: 0.95, out: 4, read: 0.16, write: 0.95},
	'moonshotai/Kimi-K2.7-Code': {in: 0.95, out: 4, read: 0.19, write: 0.95},
	'moonshotai/Kimi-K2.7-Code-Highspeed': {in: 1.9, out: 8, read: 0.38, write: 1.9},
	'moonshotai/Kimi-K3': {in: 3, out: 15, read: 0.3, write: 3},
	'nvidia/nemotron-3-ultra-550b-a55b': {in: 0.6, out: 2.4, read: 0.12, write: 0.6},
	'poolside/laguna-s-2.1-free': {in: 0, out: 0, read: 0, write: 0},
	'sakana/fugu-ultra': {in: 5, out: 30, read: 0.5, write: 5},
	'stepfun/Step-3.5-Flash': {in: 0.1, out: 0.3, read: 0.02, write: 0.1},
	'stepfun/Step-3.7-Flash': {in: 0.2, out: 1.15, read: 0.04, write: 0.2},
	'tencent/hy3-paid': {in: 0.14, out: 0.58, read: 0.035, write: 0.14},
	'tencent/hy4-preview': {in: 0.834, out: 2.501, read: 0.042, write: 0.834},
	'thinkingmachines/inkling': {in: 1, out: 4.05, read: 0.17, write: 1},
	'thinkingmachines/inkling-small': {in: 0.5, out: 1.2, read: 0.1, write: 0.5},
	'xai/grok-4.5': {in: 2, out: 6, read: 0.5, write: 2},
	'xai/grok-4.6': {in: 2, out: 6, read: 0.5, write: 2},
	'xiaomi/mimo-v2.5': {in: 0.14, out: 0.28, read: 0.0028, write: 0.14},
	'xiaomi/mimo-v2.5-pro': {in: 0.435, out: 0.87, read: 0.0036, write: 0.435},
	'z-ai/glm-5.3-flash': {in: 0.15, out: 0.5, read: 0.03, write: 0.15},
	'zai-org/GLM-5': {in: 1, out: 3.2, read: 0.2, write: 1},
	'zai-org/GLM-5.1': {in: 1.4, out: 4.4, read: 0.26, write: 1.4},
	'zai-org/GLM-5.2': {in: 1.4, out: 4.4, read: 0.26, write: 1.4},
	'zai-org/GLM-5.2-Fast': {in: 3, out: 10.25, read: 0.5, write: 3},
	'zai-org/GLM-5.3': {in: 1.4, out: 4.4, read: 0.26, write: 1.4},
};

// 版本号：改功能就 +1。`/hud` 会打出来，用来确认内存里到底跑的是哪一版
// （mods 每个进程只加载一次，/reload 之前一直在跑旧代码，光看磁盘是看不出来的）。
const VERSION = '0.7.0';

const FALLBACK_CONTEXT = 1_048_576;

// ── 颜色档位 ──
const P_YELLOW = 0.7; // 70% 起转黄
const P_RED = 0.9; // 90% 起转红（含）

// ── 提醒阈值（每个 session 每档一次）──
const P_WARN = P_YELLOW;
const P_CRIT = 0.85;
const P_DANGER = P_RED;

// ── 压缩健康度 ──
// 压缩后上下文至少要降这么多，才认为它真的回收了东西。
// 事故里的表现是：压了 9 次，地板一动不动。
const COMPACT_MIN_GAIN = 5_000;
// 连续这么多次无效就报警
const COMPACT_INEFFECTIVE_ALERT = 2;

// ── ⑤ 请求体预警（502）──
// 实测：23.1MB 的请求体（90% 是图片）被网关以 502 掐断，重试同样失败；
// 13.7MB 起本机已有案例，公开复现口径是序列化后「roughly 20 MB+」开始断流。
// 估算口径 = 会话日志活跃链字节和 + 固定开销（系统提示 / 工具 schema / 请求字段，标定值）。
const REQUEST_OVERHEAD = 1.3 * 1048576;
const P_PAY_LIMIT_MB = 23; // 红线（--mod-option payload-limit-mb 可改）
const P_PAY_FLOOR = 0.1; // 显示门槛 = 10% 红线（≈2.3MB）
const P_PAY_WARN = 0.65; // 转黄 / 首次提醒（≈15MB）
const P_PAY_CRIT = 0.87; // 转红 / 二次提醒（≈20MB）

const ANSI = {
	dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
	red: (s: string) => `\x1b[31m${s}\x1b[0m`,
	magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
	cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

// ─────────────────────────────────────────────────────────────
// 多语言
//
// 解析顺序：--mod-option lang=zh|en  >  Command Code 的界面语言设置
// （~/.commandcode/config.json 的 language；Settings → Interface language 或 /language 改它）
// >  默认 zh。mods 每个进程只加载一次：改完设置 /reload（或开新会话）后生效。
// ─────────────────────────────────────────────────────────────
const TEXT = {
	zh: {
		hudCleared: 'HUD 已清空（下一轮会自动回来）',
		flagCtxLimit: '手动指定上下文上限（token 数）',
		flagCtxWidth: '进度条宽度，默认 12',
		flagCtxBar: '进度条字形：block（默认）或 ascii',
		flagMaxWidth: '状态栏可用列数，默认自动探测终端宽度',
		flagBigResult: '工具结果超过多少 KB 就预警，默认 100，设 0 关闭',
		flagPayload: '请求体红线（MB），默认 23；显示/黄/红档位按 10%/65%/87% 等比缩放，设 0 关闭',
		cmdDesc: '显示上下文 HUD 详情（/hud off 清空状态栏）',
		unknownModel: '(未知模型)',
		notDetected: '未探测',
		ctxLine: (barText: string, pct: string, used: string, lim: string) =>
			`上下文 ${barText} ${pct}%  ${used} / ${lim}`,
		costLine: (money: string, src: string) => `花费 ${money}　来源：${src}`,
		costOfficial: (n: number) => `官方（会话文件 ${n} 笔）`,
		costLocal: '本地估算（读不到会话文件）',
		compactionsLine: (n: number, saved: string) => `压缩 ${n} 次，累计回收 ${saved}`,
		lastCompactBad: '　⚠ 最近一次压缩没有回收',
		bigResultsLine: (n: number, chars: string, kb: number) => `大结果 ${n} 个，累计 ${chars} 字符（阈值 ${kb} KB）`,
		payloadLine: (total: string, content: string, fixed: string) => `请求体 ≈ ${total}（内容 ${content} ＋ 固定 ${fixed}）`,
		payloadImages: (n: number, mbv: string) => `　图片 ${n} 张 · ${mbv}`,
		payloadNoFile: '——（未定位会话文件）',
		payScaleLine: (lim: number, f: number, w: number, c: number) => `请求体红线 ${lim}MB　显示 ${f}% / 黄 ${w}% / 红 ${c}%`,
		toolsLine: (n: number) => `本轮工具 ${n} 次`,
		persistLine: (ok: string, writes: number, readBack: number | string) => `持久化 ${ok}　本进程写入 ${writes} 次　已读回 ${readBack} 条`,
		persistOk: '✅ 可用',
		persistNo: '❌ 未绑定',
		diagNoWidth: '（探测不到宽度，不裁）',
		diagOver: '⚠ 超宽会被截断',
		diagFits: '✅ 不超宽',
		diagLine: (
			ver: string,
			cols: number | string,
			lastCols: number | string,
			budget: number | string,
			width: number,
			note: string,
		) => `v${ver}　终端 ${cols} 列　上次渲染按 ${lastCols} 列算　可用 ${budget} 列　状态栏实宽 ${width} 列　${note}`,
		sessionOk: (path: string) => `会话文件 ✅ ${path}`,
		sessionNo: '会话文件 ❌ 未定位',
		ctxWarn: (pct: number, used: string, lim: string) => `上下文已用 ${pct}%（${used}/${lim}）。`,
		ctxCrit: (pct: number) => `上下文 ${pct}%——建议现在 /compact，别等自动压缩。`,
		ctxDanger: (pct: number) =>
			`上下文 ${pct}%，接近上限。自动压缩的锚点一旦被大附件钉住就会失效，建议把成果落盘后 /clear 开新 session（或用 /rewind 回到爆点之前）。`,
		imgsPart: (n: number, mbv: string) => `（图片 ${n} 张 · ${mbv}）`,
		payWarn: (mbv: string, imgs: string) =>
			`📦 请求体估算 ≈ ${mbv}${imgs}。实测 13.7MB 起就有 502 案例——别再加截图了；多图会话建议先落盘再 /compact。`,
		payCrit: (mbv: string, imgs: string) =>
			`⚠️ 请求体估算 ≈ ${mbv}${imgs}。公开复现口径：序列化后「roughly 20 MB+」开始断流；建议把成果落盘，现在 /compact 再继续。`,
		payDanger: (mbv: string, imgs: string) =>
			`🚨 请求体估算 ≈ ${mbv}${imgs} —— 已到实测 502 尺寸（23.1MB 的请求 90% 是图片，曾被网关掐断且重试连炸）。立即 /compact，或落盘后 /clear 开新会话。`,
		bigWhatImage: '一张图片',
		bigWhatBlob: '一大段内容',
		bigResult: (tool: string, what: string, kb: number) =>
			`⚠️ ${tool} 返回了${what}（约 ${kb} KB）。这块会永久留在上下文里，不会被压缩回收；如果它落在压缩锚点上，还会让后续压缩彻底失效。`,
		compactDead: (n: number, before: string, after: string) =>
			`🚨 压缩已经失效：连续 ${n} 次压缩后上下文没有下降（${before} → ${after}）。通常是某块大内容把压缩锚点钉住了。再这样下去会直接撞上限，建议现在把成果落盘，然后 /clear 开新 session。`,
		gateway: (mbv: string) =>
			`⚠️ 模型请求失败重试（疑似 502 断流）。当前请求体 ≈ ${mbv}，相同体积重试通常还会失败——建议先 /compact，再从断点继续。`,
	},
	en: {
		hudCleared: 'HUD cleared (it returns on the next turn)',
		flagCtxLimit: 'Manually set the context limit (tokens)',
		flagCtxWidth: 'Bar width, default 12',
		flagCtxBar: 'Bar style: block (default) or ascii',
		flagMaxWidth: 'Usable columns for the status line (auto-detected by default)',
		flagBigResult: 'Warn when a tool result exceeds this many KB (default 100; 0 disables)',
		flagPayload: 'Request-body red line in MB (default 23); show/yellow/red scale by 10%/65%/87%; 0 disables',
		cmdDesc: 'Show context HUD details (/hud off clears the status line)',
		unknownModel: '(unknown model)',
		notDetected: 'n/a',
		ctxLine: (barText: string, pct: string, used: string, lim: string) =>
			`Context ${barText} ${pct}%  ${used} / ${lim}`,
		costLine: (money: string, src: string) => `Cost ${money}  source: ${src}`,
		costOfficial: (n: number) => `official (${n} entries in the session file)`,
		costLocal: 'local estimate (session file not found)',
		compactionsLine: (n: number, saved: string) => `Compactions ${n}, reclaimed ${saved}`,
		lastCompactBad: '  ⚠ last compaction reclaimed nothing',
		bigResultsLine: (n: number, chars: string, kb: number) => `Large results ${n}, ${chars} chars total (threshold ${kb} KB)`,
		payloadLine: (total: string, content: string, fixed: string) => `Request ≈ ${total} (content ${content} + fixed ${fixed})`,
		payloadImages: (n: number, mbv: string) => `  images ${n} · ${mbv}`,
		payloadNoFile: '— (session file not located)',
		payScaleLine: (lim: number, f: number, w: number, c: number) => `Red line ${lim}MB  show ${f}% / yellow ${w}% / red ${c}%`,
		toolsLine: (n: number) => `Tools this run: ${n}`,
		persistLine: (ok: string, writes: number, readBack: number | string) => `Persistence ${ok}  writes ${writes}  read back ${readBack}`,
		persistOk: '✅ bound',
		persistNo: '❌ not bound',
		diagNoWidth: '(width not detected - no trimming)',
		diagOver: '⚠ will be truncated',
		diagFits: '✅ fits',
		diagLine: (
			ver: string,
			cols: number | string,
			lastCols: number | string,
			budget: number | string,
			width: number,
			note: string,
		) => `v${ver}  terminal ${cols} cols  last render ${lastCols} cols  budget ${budget}  status width ${width}  ${note}`,
		sessionOk: (path: string) => `Session file ✅ ${path}`,
		sessionNo: 'Session file ❌ not located',
		ctxWarn: (pct: number, used: string, lim: string) => `Context usage at ${pct}% (${used}/${lim}).`,
		ctxCrit: (pct: number) => `Context at ${pct}% — run /compact now instead of waiting for auto-compaction.`,
		ctxDanger: (pct: number) =>
			`Context at ${pct}%, near the limit. Once a large attachment pins the compaction anchor, auto-compaction stops working — save your work, then /clear (or /rewind past the blow-up).`,
		imgsPart: (n: number, mbv: string) => ` (${n} images · ${mbv})`,
		payWarn: (mbv: string, imgs: string) =>
			`📦 Estimated request size ≈ ${mbv}${imgs}. 502s have started at 13.7MB in practice — avoid adding more screenshots; save your work and /compact early.`,
		payCrit: (mbv: string, imgs: string) =>
			`⚠️ Estimated request size ≈ ${mbv}${imgs}. Public repro: streams cut from "roughly 20 MB+" serialized — save your work and /compact before continuing.`,
		payDanger: (mbv: string, imgs: string) =>
			`🚨 Estimated request size ≈ ${mbv}${imgs} — the measured 502 size (23.1MB, 90% images; identical retries failed too). Run /compact now, or save your work and /clear.`,
		bigWhatImage: 'an image',
		bigWhatBlob: 'a large result',
		bigResult: (tool: string, what: string, kb: number) =>
			`⚠️ ${tool} returned ${what} (~${kb} KB). It stays in the context permanently and is never reclaimed by compaction; if it lands on the compaction anchor, it breaks future compactions entirely.`,
		compactDead: (n: number, before: string, after: string) =>
			`🚨 Compaction has failed: context did not drop after ${n} consecutive compactions (${before} → ${after}). A large block is pinning the anchor. Save your work and start fresh with /clear before you hit the limit.`,
		gateway: (mbv: string) =>
			`⚠️ Model request failed and is retrying (likely the 502 stream cut). Current request ≈ ${mbv} — the same payload usually keeps failing; /compact first, then continue.`,
	},
};
type Lang = keyof typeof TEXT;

function normalizeLang(v: unknown): Lang | '' {
	const s = String(v ?? '').trim().toLowerCase();
	if (!s) return '';
	if (s.startsWith('zh')) return 'zh';
	if (s.startsWith('en')) return 'en';
	return '';
}

// 跟随 Command Code 的界面语言设置（config.json 的 language）
function configLanguage(): string {
	try {
		const p = process.env.COMMANDCODE_HUD_CONFIG || join(homedir(), '.commandcode', 'config.json');
		const j = JSON.parse(readFileSync(p, 'utf8'));
		return typeof j?.language === 'string' ? j.language : '';
	} catch {
		return '';
	}
}

// ─────────────────────────────────────────────────────────────
// 纯函数
// ─────────────────────────────────────────────────────────────

// 状态栏是单行文本，控制字符必须清掉，否则会把渲染搞乱
function clean(s: unknown, max = 40): string {
	const t = String(s ?? '')
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// 花费：小额不能被 toFixed(2) 吃成 $0.00
function money(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return '$0';
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

function human(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return '0';
	if (n >= 1_000_000) return `${(n / 1_048_576).toFixed(1)}M`;
	if (n >= 1_000) return `${Math.round(n / 1000)}k`;
	return String(Math.round(n));
}

// 字节读数：小于 1MB 用 KB，避免几百字节被 toFixed(1) 吃成 0.0MB
function mb(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return '0MB';
	if (n < 1_048_576) return `${Math.max(1, Math.round(n / 1024))}KB`;
	return `${(n / 1_048_576).toFixed(1)}MB`;
}

// 可见宽度：先剥掉 ANSI，再把全角字符按 2 列算。
// 终端是按列截断的，不这么算会在中文/emoji 处提前撑爆。
function visibleWidth(s: string): number {
	const plain = s.replace(/\x1b\[[0-9;]*m/g, '');
	let w = 0;
	for (const ch of plain) {
		const c = ch.codePointAt(0) ?? 0;
		w += c >= 0x1100 && (c <= 0x115f || c === 0x2329 || c === 0x232a ||
			(c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
			(c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) ||
			(c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ||
			(c >= 0x1f300 && c <= 0x1f64f) || (c >= 0x1f900 && c <= 0x1f9ff)) ? 2 : 1;
	}
	return w;
}

// 两套字形。块字符（█░）好看，但有些字体/主题会渲染成色块，反而看不出进度。
function bar(ratio: number, width = 12, style: 'block' | 'ascii' = 'block'): string {
	const clamped = Math.max(0, Math.min(1, ratio));
	const filled = Math.round(clamped * width);
	const [on, off] = style === 'ascii' ? ['#', '-'] : ['█', '░'];
	return on.repeat(filled) + off.repeat(width - filled);
}

// 事件里的 usage 不带 costUsd，按单价估算（仅在读不到会话文件时兜底）。
// 口径：inputTokens 已含 cacheRead（OpenAI 口径），先拆出未缓存部分再计价。
function estimateCost(u: any, model: string): number {
	const p = MODEL_PRICE[model];
	if (!p) return 0;
	const input = Number(u?.inputTokens) || 0;
	const read = Number(u?.cacheReadTokens) || 0;
	const write = Number(u?.cacheWriteTokens) || 0;
	const out = Number(u?.outputTokens) || 0;
	const uncached = Math.max(0, input - read - write);
	return (uncached * p.in + read * p.read + write * p.write + out * p.out) / 1_000_000;
}

// ─────────────────────────────────────────────────────────────
// 会话文件增量读取（精确花费 + ⑤ 请求体估算）
//
// mod 拿不到当前 session id，但 run_start 会给出；文件名就是 <id>.jsonl，
// 放在 ~/.commandcode/projects/<slug>/ 下。直接扫目录比推算 slug 稳。
// 会话文件里每条 assistant 记录带 CLI 自己算的 usage.costUsd —— 那是官方数字，
// 比本地按价目表估算准，而且不会随模型目录漂移。
//
// 文件同时是一棵 append-only 的树（每条记录带 id/parentId）：压缩不重写日志，
// 只追加一条 {type:'compaction', firstKeptEntryId}；模型看到的就是「最近一条
// 链上压缩标记起的活跃链」。⑤ 的字节估算只统计活跃链，旁支不计。
// ─────────────────────────────────────────────────────────────
type RecMeta = {
	parent: string;
	bytes: number;
	compact: boolean;
	fk: string;
	imgBytes: number;
	imgCount: number;
};

class SessionLog {
	// 注意：这里不用 TS 的参数属性简写（constructor(private base: string)）。
	// Node 的类型剥离（strip-only）不支持它，会直接抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX，
	// 那样就没法用 node 直接跑本文件和测试台了。全文件只用可擦除语法。
	private readonly base: string;
	private file: string | null = null;
	private offset = 0;
	private carry = ''; // 跨读取的半行
	totalCost = 0;
	requests = 0;
	// 顺带记住最后一条 assistant 记录的状态：会话文件里每条都带 model/effort/usage，
	// 拿它回填，reload 和 resume 之后就不用先显示一个刺眼的 `ctx —`。
	lastModel = '';
	lastEffort = '';
	lastContext = 0;
	// ⑤：活跃链索引（id → 记录元信息）与字节统计
	recs = new Map<string, RecMeta>();
	lastId = '';
	totalBytes = 0;
	totalImgBytes = 0;
	totalImgCount = 0;
	ctxBytes = 0;
	imgBytes = 0;
	imgCount = 0;

	constructor(base: string) {
		this.base = base;
	}

	locate(sessionId: string): boolean {
		if (!sessionId) return false;
		try {
			for (const slug of readdirSync(this.base)) {
				const p = join(this.base, slug, `${sessionId}.jsonl`);
				if (existsSync(p)) {
					this.file = p;
					this.offset = 0;
					this.carry = '';
					this.totalCost = 0;
					this.requests = 0;
					this.lastModel = '';
					this.lastEffort = '';
					this.lastContext = 0;
					this.recs.clear();
					this.lastId = '';
					this.totalBytes = 0;
					this.totalImgBytes = 0;
					this.totalImgCount = 0;
					this.ctxBytes = 0;
					this.imgBytes = 0;
					this.imgCount = 0;
					return true;
				}
			}
		} catch {
			// 目录不存在等情况：当作读不到
		}
		return false;
	}

	/** 增量读一次。返回是否真的读到了新字节。 */
	poll(): boolean {
		if (!this.file) return false;
		try {
			const size = statSync(this.file).size;
			if (size < this.offset) {
				// 文件被换掉或截断：从头重来
				this.offset = 0;
				this.carry = '';
				this.recs.clear();
				this.lastId = '';
				this.totalBytes = 0;
				this.totalImgBytes = 0;
				this.totalImgCount = 0;
				this.ctxBytes = 0;
				this.imgBytes = 0;
				this.imgCount = 0;
			}
			if (size === this.offset) return false;

			const fd = openSync(this.file, 'r');
			const buf = Buffer.alloc(size - this.offset);
			readSync(fd, buf, 0, buf.length, this.offset);
			closeSync(fd);
			this.offset = size;

			const lines = (this.carry + buf.toString('utf8')).split('\n');
			this.carry = lines.pop() ?? ''; // 最后一段可能是半行
			for (const line of lines) {
				if (!line.trim()) continue;
				const bytes = Buffer.byteLength(line, 'utf8');
				this.totalBytes += bytes;
				// 图片只会是内联 base64；先按行扫一遍（比整行 JSON 深挖便宜）
				let imgBytes = 0;
				let imgCount = 0;
				if (/"type"\s*:\s*"image"/.test(line)) {
					imgCount = (line.match(/"type"\s*:\s*"image"/g) ?? []).length;
					const re = /"data"\s*:\s*"([A-Za-z0-9+/=]+)"/g;
					let mm: RegExpExecArray | null;
					while ((mm = re.exec(line))) imgBytes += mm[1].length;
					this.totalImgBytes += imgBytes;
					this.totalImgCount += imgCount;
				}
				try {
					const rec = JSON.parse(line);
					if (typeof rec?.id === 'string' && rec.id) {
						this.recs.set(rec.id, {
							parent: typeof rec.parentId === 'string' ? rec.parentId : '',
							bytes,
							compact: rec.type === 'compaction',
							fk: typeof rec.firstKeptEntryId === 'string' ? rec.firstKeptEntryId : '',
							imgBytes,
							imgCount,
						});
						this.lastId = rec.id;
					}
					const u = rec?.usage;
					if (!u) continue;
					if (Number.isFinite(u.costUsd)) {
						this.totalCost += Number(u.costUsd);
						this.requests += 1;
					}
					if (Number.isFinite(u.inputTokens)) {
						this.lastContext = Number(u.inputTokens) + (Number(u.outputTokens) || 0);
						if (rec.model) this.lastModel = String(rec.model);
						if (rec.effort) this.lastEffort = String(rec.effort);
					}
				} catch {
					// 坏行跳过：会话文件本来就容错
				}
			}
			return true;
		} catch {
			return false;
		}
	}

	// ⑤ 计算模型当前看到的上下文字节数（活跃链 + 压缩边界）与图片占比。
	// 语义来自 harness 的 buildContextEntriesFromPath：
	//   无链上压缩 → 根到叶整条链；
	//   有链上压缩 → 最近一条 compaction 的 firstKeptEntryId（含）到叶。
	refreshContext(leafHint: string): void {
		const leaf = leafHint && this.recs.has(leafHint) ? leafHint : this.lastId;
		if (!leaf || !this.recs.has(leaf)) {
			// 没有 id 链（旧日志 / 测试桩）：退回全文件字节和
			this.ctxBytes = this.totalBytes;
			this.imgBytes = this.totalImgBytes;
			this.imgCount = this.totalImgCount;
			return;
		}
		const chain: string[] = [];
		const seen = new Set<string>();
		for (let id = leaf; id && this.recs.has(id) && !seen.has(id); id = this.recs.get(id)!.parent) {
			seen.add(id);
			chain.push(id);
		}
		let mIdx = -1;
		for (let i = 0; i < chain.length; i++) {
			if (this.recs.get(chain[i])!.compact) {
				mIdx = i;
				break;
			}
		}
		let end = chain.length - 1;
		if (mIdx >= 0) {
			const fkIdx = chain.indexOf(this.recs.get(chain[mIdx])!.fk);
			end = fkIdx > mIdx ? fkIdx : mIdx;
		}
		let b = 0;
		let ib = 0;
		let ic = 0;
		for (let i = 0; i <= end; i++) {
			const m = this.recs.get(chain[i])!;
			b += m.bytes;
			ib += m.imgBytes;
			ic += m.imgCount;
		}
		this.ctxBytes = b;
		this.imgBytes = ib;
		this.imgCount = ic;
	}

	get found(): boolean {
		return this.file !== null;
	}
	get path(): string {
		return this.file ?? '';
	}
}

// 从启动参数里捞 session id —— 让 --resume 的会话一打开就能显示历史花费
function sessionIdFromArgv(argv: readonly string[]): string {
	const looksLikeId = (v: string) => /^[0-9a-f][0-9a-f-]{7,}$/i.test(v);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--resume' || a === '-r' || a === '--session' || a === '--sessions') {
			const v = argv[i + 1];
			if (v && !v.startsWith('-') && looksLikeId(v)) return v;
		}
		if (a.startsWith('--resume=') || a.startsWith('--session=')) {
			const v = a.split('=')[1] ?? '';
			if (looksLikeId(v)) return v;
		}
	}
	return '';
}

// ─────────────────────────────────────────────────────────────
// mod 本体
// ─────────────────────────────────────────────────────────────

export default function (cmd: ModApi): void {
	// ── 运行态 ──
	let model = '';
	let effort = '';
	let contextTokens = 0;
	let estimatedCost = 0; // 价目表估算（兜底用）
	let compactions = 0;
	let savedTotal = 0; // 压缩累计回收的 token（③）
	let currentTool: string | null = null;
	let toolsThisRun = 0;
	let running = false;
	let hydrated = false;

	// 压缩健康度（②）
	let pendingCompactBefore = 0; // 压缩前的上下文
	let ineffectiveCompactions = 0; // 连续无效次数
	let lastCompactIneffective = false;

	// 大结果预警（①）
	let bigResults = 0;
	let bigChars = 0;
	let lastBigWarnAt = 0;

	// 诊断用：最近一次渲染的实宽、预算、以及当时探测到的终端列数
	let lastRenderedWidth = 0;
	let lastBudget = 0;
	let lastCols = 0;

	// ⑤ 请求体估算（字节，含固定开销）
	let payloadBytes = 0;
	let gatewayNotified = false;

	// 持久化
	let writes = 0;
	let lastWriteAt = 0;
	let hydratedFired: string[] = [];

	const fired = new Set<string>();

	// 会话说目录固定在这里；环境变量只是为了让测试能指到临时目录
	const log = new SessionLog(
		process.env.COMMANDCODE_HUD_PROJECTS || join(homedir(), '.commandcode', 'projects'),
	);

	// ── 参数 ──
	cmd.addFlag('lang', {
		type: 'string',
		description: 'zh | en — 默认跟随 Command Code 界面语言（defaults to the app interface language）',
	});

	// 语言：--mod-option lang=  >  界面语言设置（config.json）  >  默认 zh
	function detectLang(): Lang {
		return normalizeLang(cmd.getFlag('lang')) || normalizeLang(configLanguage()) || 'zh';
	}
	let LANG: Lang = detectLang();
	function T() {
		return TEXT[LANG];
	}

	cmd.addFlag('ctx-limit', {type: 'string', description: T().flagCtxLimit});
	cmd.addFlag('ctx-width', {type: 'string', description: T().flagCtxWidth});
	cmd.addFlag('ctx-bar', {type: 'string', description: T().flagCtxBar});
	cmd.addFlag('max-width', {
		type: 'string',
		description: T().flagMaxWidth,
	});
	cmd.addFlag('big-result-kb', {
		type: 'string',
		description: T().flagBigResult,
	});
	cmd.addFlag('payload-limit-mb', {
		type: 'string',
		description: T().flagPayload,
	});

	function limit(): number {
		const o = Number(cmd.getFlag('ctx-limit'));
		if (Number.isFinite(o) && o > 0) return o;
		return MODEL_CONTEXT[model] ?? FALLBACK_CONTEXT;
	}

	function width(): number {
		const w = Number(cmd.getFlag('ctx-width'));
		return Number.isFinite(w) && w >= 4 && w <= 40 ? Math.round(w) : 12;
	}

	function barStyle(): 'block' | 'ascii' {
		return String(cmd.getFlag('ctx-bar') ?? '').toLowerCase() === 'ascii' ? 'ascii' : 'block';
	}

	// 状态栏可用列数。探测不到（无头/管道）就返回 0 = 不裁。
	function columns(): number {
		const o = Number(cmd.getFlag('max-width'));
		if (Number.isFinite(o) && o > 0) return Math.round(o);
		const c = Number(process.stdout?.columns);
		return Number.isFinite(c) && c > 0 ? c : 0;
	}

	function bigThreshold(): number {
		const v = cmd.getFlag('big-result-kb');
		if (v === undefined) return 100 * 1024;
		const n = Number(v);
		return Number.isFinite(n) && n >= 0 ? n * 1024 : 100 * 1024;
	}

	function payLimit(): number {
		const v = cmd.getFlag('payload-limit-mb');
		if (v === undefined) return P_PAY_LIMIT_MB * 1048576;
		const n = Number(v);
		return Number.isFinite(n) && n >= 0 ? n * 1048576 : P_PAY_LIMIT_MB * 1048576;
	}

	// ⑤：leafId() 拿得到就信它（/rewind 之后活跃叶不一定等于最后一条记录）
	function activeLeaf(): string {
		try {
			const l = (cmd as any).sessions?.leafId?.();
			return typeof l === 'string' ? l : '';
		} catch {
			return '';
		}
	}

	function refreshPayload(): void {
		if (log.found) {
			log.refreshContext(activeLeaf());
			payloadBytes = log.ctxBytes > 0 ? log.ctxBytes + REQUEST_OVERHEAD : 0;
		}
		checkPayload();
	}

	// 把会话文件里读到的状态填进来。只填"还没有"的字段：
	// 实时事件永远优先，这里只负责 reload / resume 之后的第一眼。
	function syncFromLog(): void {
		if (!log.found) return;
		if (!model && log.lastModel) model = log.lastModel;
		if (!effort && log.lastEffort) effort = log.lastEffort;
		if (contextTokens === 0 && log.lastContext > 0) contextTokens = log.lastContext;
	}

	// 状态栏空间金贵，模型名只显示最后一段（deepseek/deepseek-v4.1-flash → deepseek-v4.1-flash）
	function shortModel(full: string): string {
		const s = clean(full, 40);
		const i = s.lastIndexOf('/');
		return clean(i >= 0 ? s.slice(i + 1) : s, 26);
	}

	// < 70% 绿　70–90% 黄　≥ 90% 红
	function colorFor(ratio: number) {
		if (ratio >= P_RED) return ANSI.red;
		if (ratio >= P_YELLOW) return ANSI.yellow;
		return ANSI.green;
	}

	function costNow(): number {
		// 会话文件里的官方数字优先；读不到才退回估算
		return log.found ? log.totalCost : estimatedCost;
	}

	// ── 终端尺寸变化 ──
	//
	// 状态栏只在事件触发时刷新，而「拖动窗口」不是事件。不监听 resize 的话，
	// 把窗口压窄之后 HUD 会一直停在上一次的宽度上，然后被宿主截断 ——
	// 诊断里会看到「可用列数 > 终端列数」这种不可能的值。
	let resizeHandler: (() => void) | null = null;

	function attachResize(): void {
		const out: any = process.stdout;
		if (!out || typeof out.on !== 'function' || resizeHandler) return;
		resizeHandler = () => render();
		try {
			out.on('resize', resizeHandler);
		} catch {
			resizeHandler = null;
		}
	}

	function detachResize(): void {
		const out: any = process.stdout;
		if (!out || !resizeHandler) return;
		try {
			out.off?.('resize', resizeHandler);
		} catch {
			// 摘不掉也无所谓，进程本来就要结束了
		}
		resizeHandler = null;
	}

	// ── 持久化 ──
	const HUD_STATE = 'commandcode-hud/state';
	const HUD_PROBE = 'commandcode-hud/probe';

	function hydrate(): void {
		if (hydrated) return;
		hydrated = true;
		try {
			const entries = cmd.session?.getCustomEntries({customType: HUD_STATE}) ?? [];
			const last: any = entries.length ? (entries[entries.length - 1] as any)?.data : null;
			if (!last) return;
			if (last.model) model = String(last.model);
			if (last.effort) effort = String(last.effort);
			if (Number.isFinite(last.estimatedCost)) estimatedCost = Number(last.estimatedCost);
			if (Number.isFinite(last.compactions)) compactions = Number(last.compactions);
			if (Number.isFinite(last.savedTotal)) savedTotal = Number(last.savedTotal);
			if (Number.isFinite(last.bigResults)) bigResults = Number(last.bigResults);
			if (Number.isFinite(last.bigChars)) bigChars = Number(last.bigChars);
			if (Number.isFinite(last.payloadBytes)) payloadBytes = Number(last.payloadBytes);
			if (Array.isArray(last.fired)) hydratedFired = last.fired.map(String);
		} catch {
			// 没有会话存储（--no-session / 测试）：安静跳过
		}
	}

	function persist(force = false): void {
		if (!cmd.session) return;
		const now = Date.now();
		if (!force && now - lastWriteAt < 30_000) return;
		lastWriteAt = now;
		try {
			cmd.session.appendCustomEntry({
				customType: HUD_STATE,
				data: {
					model,
					effort,
					estimatedCost,
					compactions,
					savedTotal,
					bigResults,
					bigChars,
					payloadBytes: Math.round(payloadBytes),
					fired: [...new Set([...hydratedFired, ...fired])],
				},
			});
			writes += 1;
		} catch {
			// 持久化失败不该影响会话；/hud 里能看到状态
		}
	}

	// /reload 之后拿不到 session id（argv 里没有，要等下一次 run_start）。
	// 办法：写一条带唯一 token 的条目，再去找哪个会话文件收到了它 ——
	// appendCustomEntry 落的就是当前会话的文件。只用最近几分钟改动过的文件，避免全盘扫。
	function adoptSessionByProbe(): void {
		if (!cmd.session) return;
		const token = `adopt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		try {
			cmd.session.appendCustomEntry({customType: HUD_PROBE, data: {token}});
		} catch {
			return;
		}
		try {
			const cutoff = Date.now() - 5 * 60 * 1000;
			const base = process.env.COMMANDCODE_HUD_PROJECTS || join(homedir(), '.commandcode', 'projects');
			for (const slug of readdirSync(base)) {
				let names: string[];
				try {
					names = readdirSync(join(base, slug));
				} catch {
					continue;
				}
				for (const name of names) {
					if (!name.endsWith('.jsonl') || name.endsWith('.checkpoints.jsonl')) continue;
					const p = join(base, slug, name);
					try {
						const st = statSync(p);
						if (st.mtimeMs < cutoff || st.size === 0) continue;
						// 只读尾部：探针条目刚写进去，一定在最后
						const len = Math.min(st.size, 64 * 1024);
						const fd = openSync(p, 'r');
						const buf = Buffer.alloc(len);
						readSync(fd, buf, 0, len, st.size - len);
						closeSync(fd);
						if (!buf.toString('utf8').includes(token)) continue;
					} catch {
						continue;
					}
					if (log.locate(name.replace(/\.jsonl$/, ''))) {
						log.poll();
						syncFromLog();
						return;
					}
				}
			}
		} catch {
			// 找不到就算了：下一次 run_start 会给 id
		}
	}

	// ── 渲染 ──
	//
	// 状态栏是单行，终端变窄时宿主会直接截断（同类 mod 的做法是让用户手动开 compact）。
	// 这里改成自动降级：从最全的排法开始试，放不下就依次丢次要信息，
	// 保底留住「上下文百分比」—— 那才是这个 HUD 存在的理由。
	type Layout = {barWidth: number; tokens: boolean; show: string[]};

	function render(): void {
		if (!cmd.ui.capabilities.status) return;
		hydrate();

		const lim = limit();
		const ratio = lim > 0 ? contextTokens / lim : 0;
		const paint = colorFor(ratio);
		const pct = `${Math.round(ratio * 100)}%`;

		const modelSeg = model
			? ANSI.cyan(
					`[${effort ? `${shortModel(model)}·${clean(effort, 8)}` : shortModel(model)}]`,
				)
			: '';
		const cost = costNow();
		const costSeg = cost > 0 ? ANSI.dim(money(cost)) : '';
		const compactSeg =
			compactions > 0
				? ANSI.magenta(
						`⇄${compactions}${savedTotal > 0 ? ` −${human(savedTotal)}` : ''}` +
							(lastCompactIneffective ? ' ⚠' : ''),
					)
				: '';
		const toolSeg = currentTool
			? ANSI.dim(`⚙ ${clean(currentTool, 18)}`)
			: toolsThisRun > 0
				? ANSI.dim(`⚙×${toolsThisRun}`)
				: '';
		const payLim = payLimit();
		const payRatio = payLim > 0 ? payloadBytes / payLim : 0;
		const paySeg =
			payloadBytes > 0 && payRatio >= P_PAY_FLOOR
				? (payRatio >= P_PAY_CRIT ? ANSI.red : payRatio >= P_PAY_WARN ? ANSI.yellow : ANSI.green)(
						`📦 ${mb(payloadBytes)}`,
					)
				: '';

		const ctxSeg = (bw: number, withTokens: boolean): string => {
			if (contextTokens <= 0) return ANSI.dim('ctx —');
			return (
				`${ANSI.dim('ctx')} ${paint(bar(ratio, bw, barStyle()))} ${paint(pct)}` +
				(withTokens ? ANSI.dim(` ${human(contextTokens)}/${human(lim)}`) : '')
			);
		};

		const SEP = ANSI.dim(' │ ');
		const build = (l: Layout): string => {
			const parts: string[] = [];
			if (l.show.includes('model') && modelSeg) parts.push(modelSeg);
			parts.push(ctxSeg(l.barWidth, l.tokens));
			if (l.show.includes('payload') && paySeg) parts.push(paySeg);
			if (l.show.includes('cost') && costSeg) parts.push(costSeg);
			if (l.show.includes('compact') && compactSeg) parts.push(compactSeg);
			if (l.show.includes('tool') && toolSeg) parts.push(toolSeg);
			if (running) parts.push(ANSI.dim('…'));
			return parts.join(SEP);
		};

		const w = width();
		const LADDER: Layout[] = [
			{barWidth: w, tokens: true, show: ['model', 'cost', 'compact', 'tool', 'payload']},
			{barWidth: w, tokens: true, show: ['model', 'cost', 'compact', 'payload']},
			{barWidth: w, tokens: true, show: ['model', 'compact', 'payload']},
			{barWidth: 8, tokens: true, show: ['model', 'compact', 'payload']},
			{barWidth: 8, tokens: false, show: ['model', 'compact', 'payload']},
			{barWidth: 6, tokens: false, show: ['compact', 'payload']},
			{barWidth: 6, tokens: false, show: ['payload']},
			{barWidth: 5, tokens: false, show: []},
		];

		// 宿主的 ModStatusLine 是 <Box paddingLeft={2}><Text wrap="truncate">，
		// 所以真正可用的内容宽度是「终端列数 − 2」，而不是终端列数。
		// 早先按 −1 算，窄窗口下会照样被截掉尾巴。
		const cols = columns();
		lastCols = cols;
		let out: string;
		if (cols <= 0) {
			out = build(LADDER[0]); // 探测不到宽度（无头/管道）：不裁
			lastBudget = 0;
		} else {
			const budget = Math.max(8, cols - 2);
			lastBudget = budget;
			out = build(LADDER[LADDER.length - 1]); // 全都放不下时用最窄的
			for (const l of LADDER) {
				const candidate = build(l);
				if (visibleWidth(candidate) <= budget) {
					out = candidate;
					break;
				}
			}
		}
		lastRenderedWidth = visibleWidth(out);

		cmd.ui.setStatus(out);
	}

	// ── 阈值提醒 ──
	function checkThresholds(): void {
		const lim = limit();
		if (lim <= 0 || contextTokens <= 0) return;
		const ratio = contextTokens / lim;
		const hit = (p: number, key: string, msg: string) => {
			if (ratio >= p && !fired.has(key)) {
				fired.add(key);
				cmd.ui.notify(msg);
				persist(true);
			}
		};
		hit(P_WARN, 'warn', T().ctxWarn(Math.round(ratio * 100), human(contextTokens), human(lim)));
		hit(P_CRIT, 'crit', T().ctxCrit(Math.round(ratio * 100)));
		hit(P_DANGER, 'danger', T().ctxDanger(Math.round(ratio * 100)));
	}

	// ── ⑤ 请求体预警（502）──
	function checkPayload(): void {
		const lim = payLimit();
		if (lim <= 0 || payloadBytes <= 0) return;
		const imgs = log.imgCount > 0 ? T().imgsPart(log.imgCount, mb(log.imgBytes)) : '';
		const hit = (ratio: number, key: string, msg: string) => {
			if (payloadBytes >= lim * ratio && !fired.has(key)) {
				fired.add(key);
				cmd.ui.notify(msg);
				persist(true);
			}
		};
		hit(P_PAY_WARN, 'payload-warn', T().payWarn(mb(payloadBytes), imgs));
		hit(P_PAY_CRIT, 'payload-crit', T().payCrit(mb(payloadBytes), imgs));
		hit(1, 'payload-danger', T().payDanger(mb(payloadBytes), imgs));
	}

	// ── ① 大结果预警 ──
	function inspectToolResult(toolName: string, result: unknown): void {
		const threshold = bigThreshold();
		if (threshold <= 0) return;

		let size = 0;
		let isImage = false;
		try {
			const s = JSON.stringify(result ?? '');
			size = s.length;
			isImage = s.includes('"type":"image"');
		} catch {
			return;
		}
		if (size < threshold) return;

		bigResults += 1;
		bigChars += size;

		// 别刷屏：60 秒最多一条
		const now = Date.now();
		if (now - lastBigWarnAt < 60_000) return;
		lastBigWarnAt = now;

		const kb = Math.round(size / 1024);
		const what = isImage ? T().bigWhatImage : T().bigWhatBlob;
		cmd.ui.notify(T().bigResult(clean(toolName, 20), what, kb));
	}

	// ── ② 压缩健康度：压完之后真的降了吗 ──
	function checkCompactionEffect(): void {
		if (pendingCompactBefore <= 0) return;
		const before = pendingCompactBefore;
		pendingCompactBefore = 0;

		if (before - contextTokens >= COMPACT_MIN_GAIN) {
			ineffectiveCompactions = 0;
			lastCompactIneffective = false;
			return;
		}

		ineffectiveCompactions += 1;
		lastCompactIneffective = true;
		if (ineffectiveCompactions === COMPACT_INEFFECTIVE_ALERT && !fired.has('compact-dead')) {
			fired.add('compact-dead');
			cmd.ui.notify(T().compactDead(ineffectiveCompactions, human(before), human(contextTokens)));
		}
	}

	// ── 事件 ──
	cmd.on('run_start', (e: any) => {
		running = true;
		toolsThisRun = 0;
		if (e?.sessionId && log.locate(String(e.sessionId))) {
			log.poll(); // 首次全量读：resume 也能立刻显示历史花费与上下文
			syncFromLog();
			refreshPayload();
		}
		render();
	});

	cmd.on('model_request_start', () => {
		// ⑤ 请求发出前的最后一眼：会话文件里的新记录此时都已经落盘
		log.poll();
		refreshPayload();
		render();
	});

	// ⑤ 事后确认：真的打上重试/断流时，把「就是体积」这层怀疑直接说出来。
	// 502 是客户端合成的（流没等到 finish 事件），重试通常同样失败——
	// 这时体积读数已经足够大，值得立刻把成果落盘再 /compact。
	function gatewayEvidence(e: any): void {
		if (gatewayNotified) return;
		let blob = String(e ?? '');
		try {
			blob += ` ${JSON.stringify(e ?? '')}`;
		} catch {
			// 序列化失败就不挑
		}
		if (!/502|Stream ended|truncat/i.test(blob)) return;
		if (payloadBytes <= 0 || payloadBytes < payLimit() * P_PAY_FLOOR) return;
		gatewayNotified = true;
		cmd.ui.notify(T().gateway(mb(payloadBytes)));
	}
	cmd.on('api_retry', (e: any) => gatewayEvidence(e));
	cmd.on('stream_restart', (e: any) => gatewayEvidence(e));
	cmd.on('run_error', (e: any) => gatewayEvidence(e));

	cmd.on('model_request_end', (e: any) => {
		if (e?.model) model = String(e.model);
		if (e?.effort) effort = String(e.effort);
		const u = e?.usage ?? {};
		if (Number.isFinite(u.inputTokens)) {
			contextTokens = Number(u.inputTokens) + (Number(u.outputTokens) || 0);
		}
		if (!log.found) {
			estimatedCost += Number.isFinite(u.costUsd)
				? Number(u.costUsd)
				: estimateCost(u, model);
		}

		checkCompactionEffect(); // ② 压缩后的第一笔请求，用来判断压缩有没有用
		checkThresholds();
		refreshPayload();
		persist();
		render();
	});

	cmd.on('tool_running', (e: any) => {
		currentTool = clean(e?.toolName, 18) || null;
		render();
	});

	cmd.on('tool_completed', (e: any) => {
		currentTool = null;
		toolsThisRun += 1;
		inspectToolResult(String(e?.toolName ?? '?'), e?.result);
		render();
	});

	cmd.on('tool_errored', () => {
		currentTool = null;
		toolsThisRun += 1;
		render();
	});

	cmd.on('compaction_start', () => {
		pendingCompactBefore = contextTokens; // ② 记下压缩前的体积
		render();
	});

	cmd.on('compaction_done', (e: any) => {
		compactions += 1;
		if (Number.isFinite(e?.tokensSaved)) savedTotal += Number(e.tokensSaved); // ③
		log.poll();
		refreshPayload(); // 压缩标记刚落盘：⑤ 的读数应该立刻降下来
		persist(true);
		render();
	});

	cmd.on('turn_end', () => {
		log.poll(); // 会话文件在每个 turn 提交后才有新内容
		syncFromLog();
		refreshPayload();
		render();
	});

	cmd.on('run_end', () => {
		running = false;
		currentTool = null;
		log.poll();
		refreshPayload();
		persist(true);
		render();
	});

	// ── 会话生命周期 ──
	cmd.hooks({
		onSessionStart: () => {
			LANG = detectLang();
			hydrated = false;
			hydrate();
			for (const k of hydratedFired) fired.add(k);
			// --resume 进来的会话：argv 里能捞到 id，先把历史花费读出来
			const fromArgv = sessionIdFromArgv(process.argv);
			if (fromArgv && log.locate(fromArgv)) log.poll();
			else adoptSessionByProbe(); // /reload 的情况：靠探针反查
			syncFromLog();
			refreshPayload();
			attachResize();
			render();
		},
		onSessionEnd: () => {
			detachResize();
			cmd.ui.setStatus(null);
		},
	});

	// ── 手动命令 ──
	cmd.addCommand({
		name: 'hud',
		description: T().cmdDesc,
		handler: ({args}: any) => {
			if (String(args ?? '').trim() === 'off') {
				cmd.ui.setStatus(null);
				return {message: T().hudCleared};
			}
			const lim = limit();
			const ratio = lim > 0 ? contextTokens / lim : 0;
			const cost = costNow();
			const costSrc = log.found ? T().costOfficial(log.requests) : T().costLocal;
			let readBack: number | string = 0;
			try {
				readBack = cmd.session?.getCustomEntries({customType: HUD_STATE}).length ?? 0;
			} catch {
				readBack = '?';
			}
			const diagNote =
				lastBudget <= 0 ? T().diagNoWidth : lastRenderedWidth > lastBudget ? T().diagOver : T().diagFits;
			return {
				message:
					`${clean(model, 40) || T().unknownModel}${effort ? ` · ${clean(effort, 12)}` : ''}\n` +
					T().ctxLine(bar(ratio, 24, barStyle()), String(Math.round(ratio * 100)), human(contextTokens), human(lim)) +
					'\n' +
					T().costLine(money(cost), costSrc) +
					'\n' +
					T().compactionsLine(compactions, human(savedTotal)) +
					(lastCompactIneffective ? T().lastCompactBad : '') +
					'\n' +
					T().bigResultsLine(bigResults, human(bigChars), Math.round(bigThreshold() / 1024)) +
					'\n' +
					(log.found
						? T().payloadLine(mb(payloadBytes), mb(log.ctxBytes), mb(REQUEST_OVERHEAD)) +
							T().payloadImages(log.imgCount, mb(log.imgBytes))
						: T().payloadNoFile) +
					'\n' +
					T().payScaleLine(
						Math.round(payLimit() / 1048576),
						Math.round(P_PAY_FLOOR * 100),
						Math.round(P_PAY_WARN * 100),
						Math.round(P_PAY_CRIT * 100),
					) +
					'\n' +
					T().toolsLine(toolsThisRun) +
					'\n' +
					T().persistLine(cmd.session ? T().persistOk : T().persistNo, writes, readBack) +
					'\n' +
					T().diagLine(
						VERSION,
						columns() || T().notDetected,
						lastCols || T().notDetected,
						lastBudget || T().notDetected,
						lastRenderedWidth,
						diagNote,
					) +
					'\n' +
					(log.found ? T().sessionOk(log.path) : T().sessionNo),
			};
		},
	});
}
