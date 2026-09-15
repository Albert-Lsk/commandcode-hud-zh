// 干跑 hud.ts 的颜色逻辑：把每个百分比下真正发出的进度条颜色打出来。
// 跑法：node color-probe.ts
import hud from '../hud.ts';

const seen: {pct: number; raw: string}[] = [];
const noop = () => ({dispose: () => {}});
const listeners = new Map<string, any>();

const cmd: any = {
  name: 'hud', cwd: process.cwd(),
  ui: {
    capabilities: {status: true},
    setStatus: (t: string) => {
      const m = /(\d+)%/.exec(t.replace(/\x1b\[[0-9;]*m/g, ''));
      if (m) seen.push({pct: Number(m[1]), raw: t});
    },
    notify: noop,
  },
  on: (e: string, h: any) => { listeners.set(e, h); return {dispose: noop}; },
  hooks: noop, addCommand: noop, addFlag: noop, getFlag: () => undefined,
  events: {emit: noop, on: noop}, showEntry: noop, queueMessage: noop,
  exec: async () => ({stdout: '', stderr: '', code: 0}),
};
hud(cmd);

const NAME: Record<string, string> = {'32': '🟢 绿', '33': '🟡 黄', '31': '🔴 红'};

console.log('百分比   进度条颜色');
console.log('─────   ──────────');
for (const p of [10, 30, 50, 69, 70, 71, 80, 85, 89, 90, 91, 95, 99]) {
  listeners.get('model_request_end')!({
    model: 'deepseek/deepseek-v4.1-flash',
    usage: {inputTokens: Math.ceil(1048576 * p / 100), outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0},
  });
  const last = seen[seen.length - 1];
  const codes = [...last.raw.matchAll(/\x1b\[([0-9;]+)m/g)].map((m) => m[1]).filter((c) => c !== '0');
  const barColor = codes.find((c) => ['32', '33', '31'].includes(c)) ?? '(默认)';
  console.log(`  ${String(p).padStart(3)}%    ${NAME[barColor] ?? barColor}`);
}
