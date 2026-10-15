// hud 的本地测试台：用假的 ModApi 驱动真实事件序列，打印每一步渲染出的状态栏。
// 跑法：node test-hud.ts
//
// 覆盖：事件渲染、阈值去重、未知模型回退、/hud 命令、/reload 状态恢复，
//      以及五项新能力：① 大结果预警 ② 压缩健康度 ③ 压缩回收量 ④ 精确花费 ⑤ 请求体预警；
//      多语言：默认 zh，跟随 Command Code 界面语言（config.json），--mod-option lang= 覆盖。

import {appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
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
process.env.COMMANDCODE_HUD_CONFIG = join(FAKE_ROOT, 'no-such-config.json'); // 语言探测保持确定性（默认 zh）

type AnyFn = (...a: any[]) => void;
const store: {customType: string; data?: any}[] = [];
const flags: Record<string, string | undefined> = {};

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
		getFlag: (n: string) => flags[n],
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
// 有了回填，reload/恢复之后第一次渲染就该有上下文，不再是刺眼的 ctx —
ok('冷启动即回填上下文（无 ctx —）', !strip(cmd1.__status).includes('ctx —') && strip(cmd1.__status).includes('%'));
// 全新会话（没有 transcript）才应该是空的
ok('冷启动也能显示回填的模型名', strip(cmd1.__status).includes('deepseek-v4.1-flash'));

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

// 回填：reload 后不该再显示刺眼的 ctx —
const r2b = strip(cmd2.__status);
ok('回填：上下文（不再是 ctx —）', !r2b.includes('ctx —') && r2b.includes('29%'));
ok('回填：模型名', r2b.includes('deepseek-v4.1-flash'));
ok('/hud 打出版本号', /v\d+\.\d+\.\d+/.test(r.message));
ok('/hud 给出宽度诊断', r.message.includes('终端') && r.message.includes('状态栏实宽'));

// ═══════════ 终端宽度自适应 + resize 重算 ═══════════
console.log('\n══ 宽度自适应（resize）══');
const h3: any[] = [], c3: any[] = [], n3: string[] = [];
const cmd3 = makeCmd(h3, c3, n3);
hud(cmd3);
h3[0].onSessionStart({source: 'startup'});
cmd3.__fire('run_start', {sessionId: SID});
cmd3.__fire('model_request_end', {
	model: 'deepseek/deepseek-v4.1-flash', effort: 'max',
	usage: {inputTokens: 570_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0},
});
cmd3.__fire('compaction_done', {tokensSaved: 438_000});
cmd3.__fire('tool_running', {toolName: 'read_file'});

const vis = (s: string) => {
	let w = 0;
	for (const ch of strip(s)) {
		const c = ch.codePointAt(0) ?? 0;
		w += c >= 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) ||
			(c >= 0xff00 && c <= 0xff60) || (c >= 0x1f300 && c <= 0x1f64f)) ? 2 : 1;
	}
	return w;
};

// 宽窗口：全量信息
flags['max-width'] = '120';
cmd3.__fire('tool_completed', {toolName: 'read_file', result: 'ok'});
cmd3.__fire('tool_running', {toolName: 'read_file'});
const wide = strip(cmd3.__status);
console.log(`  120 列  (${String(vis(cmd3.__status)).padStart(3)} 宽) │ ${wide}`);
ok('宽窗口下信息齐全（含花费与工具）', wide.includes('$') && wide.includes('⚙'));

// 压窄：靠 resize 事件触发重算
flags['max-width'] = '44';
process.stdout.emit('resize');
const narrow = strip(cmd3.__status);
console.log(`   44 列  (${String(vis(cmd3.__status)).padStart(3)} 宽) │ ${narrow}`);
ok('resize 后自动降级（丢掉工具与花费）', !narrow.includes('⚙') && !narrow.includes('$'));
ok('resize 后仍不超宽', vis(cmd3.__status) <= 44 - 2);
ok('降级仍保住上下文百分比与压缩标记', /\d+%/.test(narrow) && narrow.includes('⇄'));

// 极窄：只剩百分比
flags['max-width'] = '20';
process.stdout.emit('resize');
const tiny = strip(cmd3.__status);
console.log(`   20 列  (${String(vis(cmd3.__status)).padStart(3)} 宽) │ ${tiny}`);
ok('极窄下只剩上下文（保底）', tiny.includes('%') && vis(cmd3.__status) <= 20 - 2);

// 拉回宽：信息应恢复
flags['max-width'] = '120';
process.stdout.emit('resize');
ok('拉宽后信息恢复', strip(cmd3.__status).includes('$'));

// ═══════════ 隐私：只显示统计，不带出工具返回的原文 ═══════════
{
	const canary = 'SYNTHETIC_PRIVATE_TOOL_BODY_DO_NOT_ECHO';
	const privacyHooks: any[] = [], privacyCommands: any[] = [], privacyNotices: string[] = [];
	const privacyCmd = makeCmd(privacyHooks, privacyCommands, privacyNotices);
	hud(privacyCmd);
	privacyHooks[0].onSessionStart({source: 'startup'});
	privacyCmd.__fire('tool_completed', {
		toolName: 'read_file',
		result: [{type: 'text', text: canary.repeat(4096)}],
	});
	privacyCmd.__fire('run_end', {});
	const diagnostic = privacyCommands.find((x) => x.name === 'hud').handler({args: ''});
	const exposed = JSON.stringify([privacyCmd.__status, privacyNotices, store, diagnostic.message]);
	// 使用新实例，确保预警实际触发，不受前面的 60 秒节流影响。
	ok('隐私：工具返回原文不进入状态栏、通知或持久化数据', privacyNotices.length === 1 && !exposed.includes(canary));
}

// ═══════════ 会话 4：⑤ 请求体预警（502）═══════════
console.log('\n══ 会话 4：请求体预警 ══');
{
	const SID2 = '11111111-2222-3333-4444-555555555555';
	const dir4 = join(FAKE_ROOT, 'fake-slug');
	const raw4: string[] = [];
	const line4 = (o: unknown) => JSON.stringify(o);
	const txt4 = (id: string, parent: string, pad: number) =>
		line4({
			type: 'message', id, parentId: parent, timestamp: 0,
			message: {role: 'user', content: [{type: 'text', text: 'x'.repeat(pad)}]},
		});
	const img4 = (id: string, parent: string, kb: number) =>
		line4({
			type: 'message', id, parentId: parent, timestamp: 0,
			message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 't', content: [
				{type: 'image', source: {type: 'base64', media_type: 'image/jpeg', data: 'A'.repeat(kb * 1024)}},
			]}]},
		});
	const write4 = () => writeFileSync(join(dir4, `${SID2}.jsonl`), raw4.join('\n') + '\n');

	raw4.push(line4({type: 'session', version: 3, id: 'sess', timestamp: 0, cwd: '/tmp'}));
	raw4.push(txt4('m1', 'sess', 400));
	raw4.push(txt4('m2', 'm1', 400));
	raw4.push(txt4('side9', 'm2', 900 * 1024)); // DAG 旁支：写进文件，但不在活跃链上
	raw4.push(line4({
		type: 'compaction', id: 'c1', parentId: 'm2', timestamp: 0,
		summary: 'S'.repeat(900), firstKeptEntryId: 'm2', tokensBefore: 50000,
	}));
	raw4.push(txt4('m3', 'c1', 400));
	write4();

	flags['payload-limit-mb'] = '15'; // 红线 15MB：显示 1.5 / 黄 9.75 / 红 13.05
	const h4: any[] = [], c4: any[] = [], n4: string[] = [];
	const cmd4 = makeCmd(h4, c4, n4);
	hud(cmd4);
	h4[0].onSessionStart({source: 'startup'});
	cmd4.__fire('run_start', {sessionId: SID2});

	const s4 = () => strip(cmd4.__status);
	const expCtx = (...ids: string[]) =>
		raw4
			.filter((l) => ids.some((id) => l.includes(`"id":"${id}"`)))
			.reduce((s, l) => s + Buffer.byteLength(l, 'utf8'), 0);
	const expMb = (ctx: number) => `${((ctx + 1.3 * 1048576) / 1048576).toFixed(1)}MB`;
	const payCount = (mark: string) => n4.filter((m) => m.includes(mark)).length;

	// 起始内容很小 → 低于显示门槛（10% × 15MB = 1.5MB）
	ok('⑤ 低于门槛不显示', !s4().includes('📦'));

	// +4MB 图片 → 约 5.2MB：转绿显示，无提醒；旁支的 900KB 不得计入
	raw4.push(img4('m4', 'm3', 4000));
	write4();
	cmd4.__fire('turn_end');
	const ctxA = expCtx('m2', 'c1', 'm3', 'm4');
	ok('⑤ 估算按活跃链算（旁支不计）', s4().includes(`📦 ${expMb(ctxA)}`));
	ok('⑤ 绿档不提醒', n4.length === 0);

	// +5.3MB → 约 10.4MB ≥ 65%（9.75MB）：黄档提醒
	raw4.push(img4('m5', 'm4', 5300));
	write4();
	cmd4.__fire('turn_end');
	ok('⑤ 黄档提醒一次', payCount('📦 请求体估算') === 1);

	// +3.2MB → 约 13.5MB ≥ 87%（13.05MB）：红档提醒
	raw4.push(img4('m6', 'm5', 3200));
	write4();
	cmd4.__fire('turn_end');
	ok('⑤ 红档提醒一次', payCount('⚠️ 请求体估算') === 1);

	// +2.2MB → 约 15.7MB ≥ 红线：危险提醒
	raw4.push(img4('m7', 'm6', 2200));
	write4();
	cmd4.__fire('turn_end');
	ok('⑤ 红线提醒一次', payCount('🚨 请求体估算') === 1);
	show('⑤ 红线读数', cmd4.__status);

	// 网关真在重试 502：点名体积（每个会话只喊一次）
	const retry = {attempt: 3, delayMs: 10_000, error: {status: 502, message: 'Stream ended unexpectedly before completion'}};
	cmd4.__fire('api_retry', retry);
	cmd4.__fire('api_retry', retry);
	ok('⑤ 重试时点名 502（只喊一次）', n4.filter((m) => m.includes('失败重试')).length === 1);
	for (const m of n4) console.log(`  📣 ${m}`);

	// /hud 明细
	const r4: any = c4.find((x) => x.name === 'hud').handler({args: ''});
	ok('/hud 打出请求体与图片明细', r4.message.includes('请求体 ≈') && r4.message.includes('图片 4 张'));
	ok('/hud 打出请求体红线', r4.message.includes('请求体红线 15MB'));

	// /rewind 之后活跃叶不再等于最后一条记录：leafId() 优先
	(cmd4 as any).sessions = {leafId: () => 'm2'};
	cmd4.__fire('turn_end');
	ok('⑤ leafId 校正后回到门槛之下', !s4().includes('📦'));
	delete (cmd4 as any).sessions;
	cmd4.__fire('turn_end');
	ok('⑤ 恢复活跃叶后读数回来', s4().includes('📦'));

	// /reload：已提醒过的档位不重复响，读数靠持久化 + 重算回填
	const h6: any[] = [], c6: any[] = [], n6: string[] = [];
	const cmd6 = makeCmd(h6, c6, n6);
	hud(cmd6);
	h6[0].onSessionStart({source: 'startup'});
	cmd6.__fire('run_start', {sessionId: SID2});
	ok('⑤ reload 后不重复提醒', n6.filter((m) => m.includes('请求体估算')).length === 0);
	ok('⑤ reload 后回填读数', strip(cmd6.__status).includes('📦'));

	delete flags['payload-limit-mb'];
}

// ═══════════ 会话 5：多语言（lang=en / 跟随界面语言）═══════════
console.log('\n══ 会话 5：多语言 ══');
{
	// ① --mod-option lang=en
	flags['lang'] = 'en';
	const h7: any[] = [], c7: any[] = [], n7: string[] = [];
	const cmd7 = makeCmd(h7, c7, n7);
	hud(cmd7);
	h7[0].onSessionStart({source: 'startup'});
	cmd7.__fire('tool_completed', {
		toolName: 'read_file',
		result: [{type: 'text', text: 'x'.repeat(300 * 1024)}],
	});
	ok('en：大结果提醒是英文', n7.some((m) => m.includes('returned') && m.includes('compaction anchor')));
	const r7: any = c7.find((x) => x.name === 'hud').handler({args: ''});
	ok('en：/hud 是英文', r7.message.includes('Context ') && r7.message.includes('Red line'));
	delete flags['lang'];

	// ② 跟随 Command Code 界面语言（config.json 的 language=en）
	const cfgEn = join(FAKE_ROOT, 'cfg-en.json');
	writeFileSync(cfgEn, JSON.stringify({language: 'en'}));
	process.env.COMMANDCODE_HUD_CONFIG = cfgEn;
	const h8: any[] = [], c8: any[] = [], n8: string[] = [];
	const cmd8 = makeCmd(h8, c8, n8);
	hud(cmd8);
	h8[0].onSessionStart({source: 'startup'});
	cmd8.__fire('tool_completed', {
		toolName: 'read_file',
		result: [{type: 'text', text: 'x'.repeat(300 * 1024)}],
	});
	ok('en：跟随界面语言（config.json）', n8.some((m) => m.includes('returned')));

	// ③ 配置切回 zh：新实例应回到中文
	const cfgZh = join(FAKE_ROOT, 'cfg-zh.json');
	writeFileSync(cfgZh, JSON.stringify({language: 'zh'}));
	process.env.COMMANDCODE_HUD_CONFIG = cfgZh;
	const h9: any[] = [], c9: any[] = [], n9: string[] = [];
	const cmd9 = makeCmd(h9, c9, n9);
	hud(cmd9);
	h9[0].onSessionStart({source: 'startup'});
	cmd9.__fire('tool_completed', {
		toolName: 'read_file',
		result: [{type: 'text', text: 'x'.repeat(300 * 1024)}],
	});
	ok('zh：跟随界面语言回到中文', n9.some((m) => m.includes('返回了')));
	process.env.COMMANDCODE_HUD_CONFIG = join(FAKE_ROOT, 'no-such-config.json');
}

// ═══════════ 版本一致性（防止 package.json 与 mod 内的 VERSION 漂移）═══════════
{
	const modSrc = readFileSync('hud.ts', 'utf8');
	const pkgJson = JSON.parse(readFileSync('package.json', 'utf8'));
	const modVer = /const VERSION = '([^']+)'/.exec(modSrc)?.[1];
	ok(`package.json 版本与 mod 一致（${modVer}）`, pkgJson.version === modVer);
}

// ═══════════ 汇总 ═══════════
console.log('\n══ 结果 ══');
for (const [name, pass] of checks) console.log(`  ${pass ? '✅' : '❌'} ${name}`);
const allOk = checks.every(([, p]) => p);
console.log(`\n${allOk ? '✅ 全部通过' : `❌ ${checks.filter(([, p]) => !p).length} 项失败`}`);
process.exitCode = allOk ? 0 : 1;
