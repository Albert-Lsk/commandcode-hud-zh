// 探针 v4：为「还能加什么功能」做可行性核实。
// 只看不动，全部写文件。
import {appendFileSync} from 'node:fs';
const log = (m: string) => { try { appendFileSync('/tmp/hud-probe2.log', `${m}\n`); } catch {} };

export default function (cmd: any) {
	const say = (k: string, v: any) => log(`${k}: ${typeof v === 'function' ? 'fn' : JSON.stringify(v)}`);

	log('=== cmd 顶层可用面 ===');
	for (const k of ['sessions','exec','getActiveTools','getAllTools','showEntry','queueMessage','setModel']) {
		say(`  cmd.${k}`, cmd[k]);
	}
	log('=== cmd.sessions 的方法 ===');
	if (cmd.sessions) for (const k of Object.keys(cmd.sessions)) say(`  sessions.${k}`, cmd.sessions[k]);
	else log('  (cmd.sessions 不存在)');

	cmd.hooks({
		onSessionStart: () => {
			log('=== 绑定后 ===');
			say('  cmd.sessions', cmd.sessions);
			if (cmd.sessions) for (const k of Object.keys(cmd.sessions)) say(`  sessions.${k}`, cmd.sessions[k]);
		},
	});

	cmd.on('tool_completed', (p: any) => {
		const s = JSON.stringify(p ?? {});
		log(`tool_completed payload keys=${JSON.stringify(Object.keys(p ?? {}))} 序列化长度=${s.length}`);
		if (p?.result !== undefined) {
			const rs = JSON.stringify(p.result);
			log(`  result 类型=${typeof p.result} 长度=${rs.length} 预览=${rs.slice(0, 120)}`);
		}
	});

	for (const ev of ['subagent_start','subagent_progress','subagent_stop','api_retry','continuation_recovery','tool_input_repaired','turn_end']) {
		cmd.on(ev, (p: any) => log(`${ev}: keys=${JSON.stringify(Object.keys(p ?? {}))} ${JSON.stringify(p ?? {}).slice(0, 200)}`));
	}
}
