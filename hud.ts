// commandcode-hud — 常驻上下文仪表盘
//
// 参照 jarrodwatts/claude-hud 的思路，改用 Command Code 的 ModApi 实现。
// 渲染在输入面板下方的常驻状态栏（cmd.ui.setStatus），每一轮对话后自动刷新。
//
// 为什么要有它：上下文溢出是静默发生的——自动压缩会悄悄跑很多次，
// 界面上没有任何提示，直到某一条消息直接报 400。这个 mod 把那个盲区补上。

import type {ModApi} from '@commandcode/harness';

// ─────────────────────────────────────────────────────────────
// 模型 → 上下文上限（由 Command Code 随包的模型目录生成）
// 注意：文档写 "1M"，实际是 2^20 = 1048576，这里按实测值修正。
// ─────────────────────────────────────────────────────────────
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

const FALLBACK_CONTEXT = 1_048_576;

// 模型 → 每 1M token 单价（美元）。同样由随包的模型目录生成。
// 注意：事件里的 usage **没有 costUsd**（会话日志里才有），所以成本得自己算。
type Price = {in: number; out: number; read: number; write: number};
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


// 颜色档位（所有者指定）
const P_YELLOW = 0.70; // 70% 起转黄
const P_RED = 0.90; // 90% 起转红（含）

// 提醒阈值：到这几个点各响一次（每个 session 每档一次）
// 与颜色档位对齐：70 转黄时提示，90 转红时给出处置建议；85 是中间那道软性的 /compact 提醒。
const P_WARN = P_YELLOW; // 70
const P_CRIT = 0.85;
const P_DANGER = P_RED; // 90

const ANSI = {
	dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
	bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
	red: (s: string) => `\x1b[31m${s}\x1b[0m`,
	magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
	cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

// 单行状态栏，控制字符必须清掉，否则会把渲染搞乱
function clean(s: unknown, max = 40): string {
	const t = String(s ?? '')
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// 花费：小额不能被 toFixed(2) 吃成 $0.00，否则前面几十轮看着都像没花钱
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

// 进度条：多宽都行，等宽字符保证对齐
//
// 两套字形。块字符（█░）好看，但依赖终端字体正确渲染 —— 有些字体/主题会把它
// 渲染成色块或点阵，反而看不出进度。ascii 版用 # 和 -，任何环境都不会出错。
function bar(ratio: number, width = 12, style: 'block' | 'ascii' = 'block'): string {
	const clamped = Math.max(0, Math.min(1, ratio));
	const filled = Math.round(clamped * width);
	const [on, off] = style === 'ascii' ? ['#', '-'] : ['█', '░'];
	return on.repeat(filled) + off.repeat(width - filled);
}

export default function (cmd: ModApi): void {
	// ── 运行态（闭包，不持久化）──
	let model = '';
	let effort = ''; // 推理档位，事件 payload 里白送的
	let contextTokens = 0; // 最近一次请求的 inputTokens = 当前上下文大小
	let costUsd = 0; // 本 session 累计花费
	let compactions = 0;
	let currentTool: string | null = null;
	let toolsThisRun = 0;
	let running = false;
	const fired = new Set<string>(); // 已触发过的阈值提醒
	let hydrated = false; // 是否已从会话存储恢复过
	let writes = 0; // 本进程成功写入的状态条目数
	let lastWriteAt = 0; // 节流用

	// ── 持久化：让 HUD 熬过 /reload 和 --resume ──
	// mods 是每个进程加载一次的，闭包里的计数器活不过 reload。
	// cmd.session 是官方给的持久化接缝，写进去的东西不会被送给模型。
	const HUD_STATE = 'commandcode-hud/state';

	function hydrate(): void {
		if (hydrated) return;
		hydrated = true;
		try {
			const entries = cmd.session?.getCustomEntries({customType: HUD_STATE}) ?? [];
			const last: any = entries.length ? (entries[entries.length - 1] as any)?.data : null;
			if (!last) return;
			if (last.model) model = String(last.model);
			if (last.effort) effort = String(last.effort);
			if (Number.isFinite(last.contextTokens)) contextTokens = Number(last.contextTokens);
			if (Number.isFinite(last.costUsd)) costUsd = Number(last.costUsd);
			if (Number.isFinite(last.compactions)) compactions = Number(last.compactions);
			// 已提醒过的档位一并恢复，否则 reload 后同一档会再响一次
			if (Array.isArray(last.fired)) for (const k of last.fired) fired.add(String(k));
		} catch {
			// 没有会话存储（--no-session / 单元测试）就安静跳过
		}
	}

	function persist(force = false): void {
		if (!cmd.session) return; // 还没绑定：静默跳过
		// 节流：模型调用很密，没必要每次都写
		const now = Date.now();
		if (!force && now - lastWriteAt < 30_000) return;
		lastWriteAt = now;
		try {
			cmd.session.appendCustomEntry({
				customType: HUD_STATE,
				data: {model, effort, contextTokens, costUsd, compactions, fired: [...fired]},
			});
			writes += 1;
		} catch {
			// 持久化失败不该影响会话。状态在 /hud 里能看到。
		}
	}

	// 允许手动覆盖上限（模型目录没收录 / 走 BYOK 时用）
	cmd.addFlag('ctx-limit', {type: 'string', description: '手动指定上下文上限（token 数）'});
	cmd.addFlag('ctx-width', {type: 'string', description: '进度条宽度，默认 12'});
	cmd.addFlag('ctx-bar', {
		type: 'string',
		description: "进度条字形：block（█░，默认）或 ascii（#-，字体渲染不稳时用）",
	});

	function limit(): number {
		const override = Number(cmd.getFlag('ctx-limit'));
		if (Number.isFinite(override) && override > 0) return override;
		return MODEL_CONTEXT[model] ?? FALLBACK_CONTEXT;
	}

	function width(): number {
		const w = Number(cmd.getFlag('ctx-width'));
		return Number.isFinite(w) && w >= 4 && w <= 40 ? Math.round(w) : 12;
	}

	// 状态栏空间金贵，模型名只显示最后一段（deepseek/deepseek-v4.1-flash → deepseek-v4.1-flash）。
	// 完整 id 留给 /hud 命令，那里不差这点宽度。
	function shortModel(full: string): string {
		const s = clean(full, 40);
		const i = s.lastIndexOf('/');
		return clean(i >= 0 ? s.slice(i + 1) : s, 26);
	}

	function barStyle(): 'block' | 'ascii' {
		return String(cmd.getFlag('ctx-bar') ?? '').toLowerCase() === 'ascii' ? 'ascii' : 'block';
	}

	// 事件里的 usage 不带 costUsd，按单价自己算。
	// 口径：inputTokens 已含 cacheRead（OpenAI 口径），先拆出未缓存的部分，
	// 否则缓存命中的 token 会被按全价再算一遍。
	function estimateCost(u: any, m: string): number {
		const p = MODEL_PRICE[m];
		if (!p) return 0;
		const input = Number(u?.inputTokens) || 0;
		const read = Number(u?.cacheReadTokens) || 0;
		const write = Number(u?.cacheWriteTokens) || 0;
		const out = Number(u?.outputTokens) || 0;
		const uncached = Math.max(0, input - read - write);
		return (uncached * p.in + read * p.read + write * p.write + out * p.out) / 1_000_000;
	}

	// < 70% 绿　70–90% 黄　≥ 90% 红
	function colorFor(ratio: number) {
		if (ratio >= P_RED) return ANSI.red;
		if (ratio >= P_YELLOW) return ANSI.yellow;
		return ANSI.green;
	}

	function render(): void {
		if (!cmd.ui.capabilities.status) return; // 无头环境：不渲染
		hydrate(); // reload / resume 后第一次渲染时把计数器捞回来

		const lim = limit();
		const ratio = lim > 0 ? contextTokens / lim : 0;
		const paint = colorFor(ratio);

		const parts: string[] = [];

		// 1. 模型徽标
		if (model) {
			const tag = effort ? `${shortModel(model)}·${clean(effort, 8)}` : shortModel(model);
			parts.push(ANSI.cyan(`[${tag}]`));
		}

		// 2. 上下文：进度条 + 百分比 + 绝对量
		if (contextTokens > 0) {
			const pct = `${Math.round(ratio * 100)}%`;
			parts.push(
				`${ANSI.dim('ctx')} ${paint(bar(ratio, width(), barStyle()))} ` +
					`${paint(pct)} ${ANSI.dim(`${human(contextTokens)}/${human(lim)}`)}`,
			);
		} else {
			parts.push(ANSI.dim('ctx —'));
		}

		// 3. 花费
		if (costUsd > 0) parts.push(ANSI.dim(money(costUsd)));

		// 4. 压缩次数（静默杀手，必须可见）
		if (compactions > 0) parts.push(ANSI.magenta(`⇄${compactions}`));

		// 5. 工具活动
		if (currentTool) parts.push(ANSI.dim(`⚙ ${clean(currentTool, 18)}`));
		else if (toolsThisRun > 0) parts.push(ANSI.dim(`⚙×${toolsThisRun}`));

		// 6. 运行中标记
		if (running) parts.push(ANSI.dim('…'));

		cmd.ui.setStatus(parts.join(ANSI.dim(' │ ')));
	}

	// ── 阈值提醒（每个 session 每档只响一次）──
	function checkThresholds(): void {
		const lim = limit();
		if (lim <= 0 || contextTokens <= 0) return;
		const ratio = contextTokens / lim;
		const hit = (p: number, key: string, msg: string) => {
			if (ratio >= p && !fired.has(key)) {
				fired.add(key);
				cmd.ui.notify(msg);
			}
		};
		hit(
			P_WARN,
			'warn',
			`上下文已用 ${Math.round(ratio * 100)}%（${human(contextTokens)}/${human(lim)}）。`,
		);
		hit(
			P_CRIT,
			'crit',
			`上下文 ${Math.round(ratio * 100)}%——建议现在 /compact，别等自动压缩。`,
		);
		hit(
			P_DANGER,
			'danger',
			`上下文 ${Math.round(ratio * 100)}%，接近上限。自动压缩的锚点一旦被大附件钉住就会失效，` +
				`建议把成果落盘后 /clear 开新 session（或用 /rewind 回到爆点之前）。`,
		);
	}

	// ── 事件订阅（观察者，不改行为）──
	cmd.on('model_request_end', (e: any) => {
		if (e?.model) model = String(e.model);
		if (e?.effort) effort = String(e.effort);
		const u = e?.usage ?? {};
		// 上下文 = 本次请求的输入 + 本次产出。下一次请求的输入大致就是这个数，
		// 所以这才是「再问一轮会占多少」的真实预估。
		if (Number.isFinite(u.inputTokens)) {
			contextTokens = Number(u.inputTokens) + (Number(u.outputTokens) || 0);
		}
		// 事件不带 costUsd，自己按单价算；万一以后带上了就优先用官方的
		if (Number.isFinite(u.costUsd)) costUsd += Number(u.costUsd);
		else costUsd += estimateCost(u, model);
		persist(); // 节流后的落盘：模型调用是最频繁的可靠时点
		checkThresholds();
		render();
	});

	cmd.on('tool_running', (e: any) => {
		currentTool = clean(e?.toolName, 18) || null;
		render();
	});

	cmd.on('tool_completed', () => {
		currentTool = null;
		toolsThisRun += 1;
		render();
	});

	cmd.on('tool_errored', () => {
		currentTool = null;
		toolsThisRun += 1;
		render();
	});

	cmd.on('compaction_done', () => {
		compactions += 1;
		persist();
		render();
	});

	cmd.on('run_start', () => {
		running = true;
		toolsThisRun = 0;
		render();
	});

	cmd.on('run_end', () => {
		running = false;
		currentTool = null;
		persist(true); // 每轮结束强制落一次
		render();
	});

	// ── 会话生命周期 ──
	cmd.hooks({
		onSessionStart: () => {
			hydrated = false; // 重新绑定：允许再捞一次（/reload 后就是这条路径）
			hydrate();
			render();
		},
		onSessionEnd: () => cmd.ui.setStatus(null),
	});

	// ── 手动命令：立刻看一眼，或清空 ──
	cmd.addCommand({
		name: 'hud',
		description: '显示/清空上下文 HUD（/hud off 清空）',
		handler: ({args}: any) => {
			const a = String(args ?? '').trim();
			if (a === 'off') {
				cmd.ui.setStatus(null);
				return {message: 'HUD 已清空（下一轮会自动回来）'};
			}
			const lim = limit();
			const ratio = lim > 0 ? contextTokens / lim : 0;
			return {
				message:
					`${clean(model, 32) || '(未知模型)'}\n` +
					`上下文 ${bar(ratio, 24, barStyle())} ${Math.round(ratio * 100)}%  ` +
					`${human(contextTokens)} / ${human(lim)}\n` +
					`累计花费 ${money(costUsd)}　压缩 ${compactions} 次　本轮工具 ${toolsThisRun} 次\n` +
					`持久化 ${cmd.session ? '✅ 可用' : '❌ 未绑定'}　` +
					`本进程写入 ${writes} 次　` +
					`已读回 ${(() => {
						try {
							return cmd.session?.getCustomEntries({customType: HUD_STATE}).length ?? 0;
						} catch {
							return '?';
						}
					})()} 条`,
			};
		},
	});
}
