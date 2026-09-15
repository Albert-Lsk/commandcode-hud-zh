// 探针 v3：在多个时点各写一条不同 customType 的条目，看哪些真的落盘。
import {appendFileSync} from 'node:fs';
const log = (m: string) => { try { appendFileSync('/tmp/hud-probe.log', `${m}\n`); } catch {} };

export default function (cmd: any) {
	// 时点 → customType 的映射
	const write = (where: string, session: any) => {
		try {
			const r = session?.appendCustomEntry({customType: where, data: {where}});
			log(`WRITE ${where} → ${JSON.stringify(r)}`);
		} catch (e: any) { log(`WRITE ${where} 抛错: ${e?.message ?? e}`); }
	};

	cmd.on('model_request_end', () => write('at-model-request-end', cmd.session));
	cmd.on('turn_end', () => write('at-turn-end-event', cmd.session));

	cmd.hooks({
		onSessionStart: () => write('at-session-start', cmd.session),
		onTurnEnd: (_a: any, ctx: any) => write('at-onTurnEnd-hook', ctx?.session),
		onRunEnd: (_a: any, ctx: any) => write('at-onRunEnd-hook', ctx?.session),
	});

	cmd.on('run_end', () => write('at-run-end-event', cmd.session));
	log('--- 一轮结束 ---');
}
