// hud 的本地测试台：用假的 ModApi 驱动真实事件序列，打印每一步渲染出的状态栏。
// 跑法：node test-hud.ts
//
// 覆盖：事件渲染、阈值提醒去重、未知模型回退、/hud 命令，
//      以及 **/reload 后的状态恢复**（第二个实例共享同一个会话存储）。

import hud from './hud.ts';

type AnyFn = (...a: any[]) => void;

// 共享的假会话存储 —— 模拟 cmd.session。两个实例共用，用来验证 reload 恢复。
const store: {customType: string; data?: any}[] = [];

function makeCmd(hooksOut: any[], commandsOut: any[], noticesOut: string[]) {
	const listeners = new Map<string, AnyFn[]>();
	const api: any = {
		name: 'commandcode-hud',
		cwd: process.cwd(),
		ui: {
			capabilities: {status: true},
			setStatus: (t: string | null) => {
				api.__status = t ?? '';
			},
			notify: (m: string) => noticesOut.push(m),
			confirm: async () => false,
			select: async () => undefined,
			input: async () => undefined,
		},
		on: (ev: string, h: AnyFn) => {
			if (!listeners.has(ev)) listeners.set(ev, []);
			listeners.get(ev)!.push(h);
			return {dispose: () => {}};
		},
		hooks: (h: any) => {
			hooksOut.push(h);
			return {dispose: () => {}};
		},
		addCommand: (c: any) => {
			commandsOut.push(c);
			return {dispose: () => {}};
		},
		addFlag: () => ({dispose: () => {}}),
		getFlag: () => undefined,
		events: {emit: () => {}, on: () => ({dispose: () => {}})},
		session: {
			appendCustomEntry: (e: {customType: string; data?: any}) => {
				store.push(e);
				return {entryId: String(store.length)};
			},
			getCustomEntries: ({customType}: {customType: string}) =>
				store.filter((e) => e.customType === customType),
		},
		showEntry: () => {},
		queueMessage: () => {},
		exec: async () => ({stdout: '', stderr: '', code: 0}),
		__status: '',
		__fire: (ev: string, payload?: any) => {
			for (const h of listeners.get(ev) ?? []) h(payload);
		},
	};
	return api;
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const line = (label: string, s: string) => console.log(`  ${label.padEnd(22)} │ ${strip(s)}`);

// ═══════════ 实例 1：跑一轮完整会话 ═══════════
console.log('══ 实例 1：新会话 ══');
const hooks1: any[] = [];
const cmds1: any[] = [];
const notices1: string[] = [];
const c1 = makeCmd(hooks1, cmds1, notices1);
hud(c1);

hooks1[0].onSessionStart({source: 'startup'});
line('冷启动', c1.__status);

c1.__fire('run_start', {sessionId: 's1'});
c1.__fire('model_request_end', {
	// 形状照实：探针实测 keys = [type, model, usage, stopReason, effort]，usage 不带 costUsd
	type: 'model_request_end',
	model: 'deepseek/deepseek-v4.1-flash',
	stopReason: 'end_turn',
	effort: 'high',
	usage: {inputTokens: 500_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0},
});
line('50% 处', c1.__status);

c1.__fire('tool_running', {toolCallId: '1', toolName: 'read_file'});
line('工具执行中', c1.__status);
c1.__fire('tool_completed', {});
c1.__fire('model_request_end', {
	type: 'model_request_end',
	model: 'deepseek/deepseek-v4.1-flash',
	stopReason: 'end_turn',
	effort: 'high',
	usage: {inputTokens: 900_000, outputTokens: 3_000, cacheReadTokens: 0, cacheWriteTokens: 0},
});
line('88% 处（触发提醒）', c1.__status);

c1.__fire('compaction_done', {tokensSaved: 200_000});
line('压缩 1 次', c1.__status);
c1.__fire('run_end', {});
line('run_end（已落盘）', c1.__status);
console.log(`\n  会话存储写入 ${store.length} 条`);

// ═══════════ 实例 2：模拟 /reload，共享同一存储 ═══════════
console.log('\n══ 实例 2：/reload 之后（新进程，同一会话）══');
const hooks2: any[] = [];
const cmds2: any[] = [];
const notices2: string[] = [];
const c2 = makeCmd(hooks2, cmds2, notices2);
hud(c2);

line('reload 后未绑定', c2.__status);
hooks2[0].onSessionStart({source: 'resume'});
line('绑定后恢复', c2.__status);

const restored = strip(c2.__status);
const checks: [string, boolean][] = [
	['上下文数字恢复', restored.includes('86%') && restored.includes('903k')],
	['模型恢复（短名，无 provider 前缀）', restored.includes('deepseek-v4.1-flash') && !restored.includes('deepseek/deepseek')],
	['累计花费恢复（自算，非事件提供）', restored.includes('$0.213')],
	['推理档位显示', restored.includes('·high')],
	['压缩次数恢复', restored.includes('⇄1')],
	['不再是冷启动的 ctx —', !restored.includes('ctx —')],
	['已提醒过的档位不重复响', notices2.length === 0],
];
console.log();
for (const [name, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${name}`);
for (const n of notices2) console.log(`     意外重复提醒: ${n}`);

// ═══════════ 未知模型 + /hud ═══════════
console.log('\n══ 未知模型回退 + /hud 命令 ══');
c2.__fire('model_request_end', {
	type: 'model_request_end',
	model: 'byok/unknown-model-name',
	effort: 'high',
	usage: {inputTokens: 250_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0},
});
line('未知模型回退', c2.__status);
const cmd = cmds2.find((x) => x.name === 'hud');
const r: any = cmd.handler({args: '', ui: c2.ui, cwd: process.cwd(), exec: c2.exec});
console.log(r.message.split('\n').map((l: string) => '  ' + strip(l)).join('\n'));

console.log('\n══ 会话结束 ══');
hooks2[0].onSessionEnd({reason: 'shutdown'});
console.log(`  ${c2.__status === '' ? '✅' : '❌'} setStatus 已清空`);

const allOk = checks.every(([, ok]) => ok) && c2.__status === '';
console.log(`\n${allOk ? '✅ 全部通过' : '❌ 有失败项'}`);
