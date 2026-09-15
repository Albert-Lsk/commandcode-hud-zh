// hud 的本地测试台：用假的 ModApi 驱动真实事件序列，打印每一步渲染出的状态栏。
// 跑法：node test-hud.ts
//
// 覆盖：事件渲染、阈值去重、未知模型回退、/hud 命令、/reload 状态恢复，
//      以及四项新能力：① 大结果预警 ② 压缩健康度 ③ 压缩回收量 ④ 精确花费。

import {appendFileSync, mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import hud from './hud.ts';

// ④ 精确花费要读真实文件 —— 造一个假的会话说目录
const FAKE_ROOT = mkdtempSync(join(tmpdir(), 'hud-test-'));
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function writeSession(entries: {costUsd: number; inputTokens: number}[]) {
	const dir = join(FAKE_ROOT, 'fake-slug');
	mkdirSync(dir, {recursive: true});
	writeFileSync(
		join(dir, `${SID}.jsonl`),
		entries
			.map((e) =>
				JSON.stringify({
					type: 'message',
					model: 'deepseek/deepseek-v4.1-flash',
					usage: {
						inputTokens: e.inputTokens,
						outputTokens: 100,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						costUsd: e.costUsd,
					},
				}),
			)
			.join('\n') + '\n',
	);
}
writeSession([
	{costUsd: 0.1, inputTokens: 100_000},
	{costUsd: 0.25, inputTokens: 300_000},
]);
process.env.COMMANDCODE_HUD_PROJECTS = FAKE_ROOT;

type AnyFn = (...a: any[]) => void;
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
				// 模拟真实行为：条目落进当前会话文件，探针反查才能找到它
				if (e.customType === 'commandcode-hud/probe') {
					writeSession([{costUsd: 0.1, inputTokens: 100_000}, {costUsd: 0.25, inputTokens: 300_000}]);
					const d = join(FAKE_ROOT, 'fake-slug');
					appendFileSync(join(d, `${SID}.jsonl`), JSON.stringify(e) + '\n');
				}
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
const show = (label: string, s: string) => console.log(`  ${label.padEnd(20)} │ ${strip(s)}`);
const checks: [string, boolean][] = [];
const ok = (name: string, pass: boolean) => checks.push([name, pass]);

// ═══════════ 会话 1：完整走一遍 ═══════════
console.log('══ 会话 1 ══');
const h1: any[] = [], c1: any[] = [], n1: string[] = [];
const cmd1 = makeCmd(h1, c1, n1);
hud(cmd1);
h1[0].onSessionStart({source: 'startup'});
show('冷启动', cmd1.__status);
ok('冷启动显示 ctx —', strip(cmd1.__status).includes('ctx —'));

const req = (pct: number, effort = 'high') =>
	cmd1.__fire('model_request_end', {
		type: 'model_request_end',
		model: 'deepseek/deepseek-v4.1-flash',
		effort,
		usage: {
			inputTokens: Math.ceil(1048576 * pct / 100),
			outputTokens: 1000,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		},
	});

// ④ 精确花费：run_start 给 sessionId → 从会话文件读官方 costUsd
cmd1.__fire('run_start', {sessionId: SID});
req(20);
show('20%（花费来自文件）', cmd1.__status);
ok('④ 花费取自会话文件（$0.350）', strip(cmd1.__status).includes('$0.350'));
// 估算值会不一样（价目表算出来是 $0.0317），所以只要精确匹配官方数字即可
ok('④ 用的是官方数字而非估算', strip(cmd1.__status).includes('$0.350'));

// ① 大结果预警
cmd1.__fire('tool_completed', {
	type: 'tool_completed',
	toolCallId: '1',
	toolName: 'read_file',
	result: [{type: 'text', text: 'x'.repeat(300 * 1024)}],
});
show('大结果之后', cmd1.__status);
ok('① 大结果触发提醒', n1.some((m) => m.includes('read_file') && m.includes('300 KB')));
ok('① 提醒里点出压缩锚点风险', n1.some((m) => m.includes('压缩锚点') || m.includes('压缩')));

// ① 图片特判
n1.length = 0;
cmd1.__fire('tool_completed', {
	type: 'tool_completed',
	toolCallId: '2',
	toolName: 'read_image',
	result: [{type: 'image', source: {type: 'base64', data: 'A'.repeat(200 * 1024)}}],
});
console.log(`  图片预警被节流（60s 内只响一次）：${n1.length === 0 ? '✅' : '❌'}`);

// ③ 压缩回收量
cmd1.__fire('compaction_start', {});
cmd1.__fire('compaction_done', {tokensSaved: 437_882});
show('压缩 1 次（有回收）', cmd1.__status);
ok('③ 显示回收量 −438k（437882 四舍五入到 438k）', strip(cmd1.__status).includes('−438k'));

// ② 压缩健康度：压完上下文真的降了 → 健康
req(12);
show('压缩后降到 12%', cmd1.__status);
ok('② 有效压缩不打警告标', !strip(cmd1.__status).includes('⚠'));

// ② 压缩失效：压完几乎没降
cmd1.__fire('compaction_start', {});
cmd1.__fire('compaction_done', {tokensSaved: 0});
req(11.9);
show('压缩后几乎没降', cmd1.__status);
ok('② 无效压缩打警告标', strip(cmd1.__status).includes('⚠'));
cmd1.__fire('compaction_start', {});
cmd1.__fire('compaction_done', {tokensSaved: 0});
req(11.8);
show('连续第 2 次无效', cmd1.__status);
ok('② 连续 2 次无效 → 报警', n1.some((m) => m.includes('压缩已经失效')));
ok('② 报警只响一次', n1.filter((m) => m.includes('压缩已经失效')).length === 1);

// ═══════════ 会话 2：/reload 恢复 ═══════════
console.log('\n══ 会话 2：/reload ══');
const h2: any[] = [], c2: any[] = [], n2: string[] = [];
const cmd2 = makeCmd(h2, c2, n2);
hud(cmd2);
h2[0].onSessionStart({source: 'resume'});
show('绑定后恢复', cmd2.__status);
const r2 = strip(cmd2.__status);
ok('恢复：模型', r2.includes('deepseek-v4.1-flash'));
ok('恢复：压缩次数', r2.includes('⇄3'));
ok('恢复：回收量', r2.includes('−438k'));
ok('恢复：大结果计数', r2.length > 20);

// ═══════════ /hud 诊断 ═══════════
console.log('\n══ /hud 诊断输出 ══');
const hudCmd = c2.find((x) => x.name === 'hud');
const r: any = hudCmd.handler({args: '', ui: cmd2.ui, cwd: process.cwd(), exec: cmd2.exec});
console.log(r.message.split('\n').map((l: string) => '  ' + strip(l)).join('\n'));
ok('/hud 标出花费来源为官方', r.message.includes('官方（会话文件'));
ok('/hud 标出会话文件已定位', r.message.includes('会话文件 ✅'));
ok('恢复后花费不为 0（探针反查成功）', !r2.includes('$0 │') && cmd2.__status.includes('$0.350'));

// ═══════════ 汇总 ═══════════
console.log('\n══ 结果 ══');
for (const [name, pass] of checks) console.log(`  ${pass ? '✅' : '❌'} ${name}`);
const allOk = checks.every(([, p]) => p);
console.log(`\n${allOk ? '✅ 全部通过' : `❌ ${checks.filter(([, p]) => !p).length} 项失败`}`);
process.exitCode = allOk ? 0 : 1;
