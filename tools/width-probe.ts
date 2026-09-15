// 宽度探针：把状态栏在不同终端宽度下的实际输出与可见宽度打出来，
// 用来确认「自动降级」真的在起作用（而不是被宿主截断）。
// 跑法：node tools/width-probe.ts
import hud from '../hud.ts';

const flags: Record<string, string | undefined> = {};
const listeners = new Map<string, any>();
const noop = () => ({dispose: () => {}});
let status = '';

const cmd: any = {
	name: 'hud', cwd: process.cwd(),
	ui: {capabilities: {status: true}, setStatus: (t: string) => { status = t ?? ''; }, notify: noop},
	on: (e: string, h: any) => { listeners.set(e, h); return {dispose: noop}; },
	hooks: noop, addCommand: noop, addFlag: noop,
	getFlag: (n: string) => flags[n],
	events: {emit: noop, on: noop}, showEntry: noop, queueMessage: noop,
	exec: async () => ({stdout: '', stderr: '', code: 0}),
};
hud(cmd);

// 造一个信息量最满的状态：长模型名 + 档位 + 花费 + 压缩 + 工具
const fire = () => {
	listeners.get('model_request_end')!({
		model: 'deepseek/deepseek-v4.1-flash', effort: 'max',
		usage: {inputTokens: 570_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.522},
	});
	listeners.get('compaction_done')!({tokensSaved: 438_000});
	listeners.get('tool_running')!({toolName: 'read_file'});
};

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const width = (s: string) => {
	let w = 0;
	for (const ch of plain(s)) {
		const c = ch.codePointAt(0) ?? 0;
		w += c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
			(c >= 0xff00 && c <= 0xff60) || (c >= 0x1f300 && c <= 0x1f64f)) ? 2 : 1;
	}
	return w;
};

console.log('宽度   可见宽度  状态栏内容');
console.log('────   ────────  ────────────────────────────────────────────────');
for (const w of [200, 120, 100, 80, 70, 60, 50, 40, 30, 20]) {
	flags['max-width'] = String(w);
	status = '';
	fire();
	const vis = width(status);
	const fits = vis <= w ? '✅' : '❌';
	console.log(`${String(w).padStart(4)}   ${String(vis).padStart(6)} ${fits}  ${plain(status)}`);
}
