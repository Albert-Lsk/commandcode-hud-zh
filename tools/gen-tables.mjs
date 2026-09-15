#!/usr/bin/env node
// 从 Command Code 随包的模型目录重新生成上下文上限表与定价表，
// 然后把它们注入 hud.ts。Command Code 升级后模型目录会漂移，跑这个同步。
//
//   node tools/gen-tables.mjs
//
// 只读本地文件，不联网。

import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {execSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REL = 'dist/bundled/command-code-knowledge/reference/models.md';

function findModelsMd() {
	const candidates = [];
	try {
		const npmRoot = execSync('npm root -g', {encoding: 'utf8'}).trim();
		candidates.push(join(npmRoot, 'command-code', REL));
	} catch {}
	candidates.push(
		join(process.env.HOME ?? '', '.npm-global/lib/node_modules/command-code', REL),
		'/usr/local/lib/node_modules/command-code/' + REL,
	);
	for (const c of candidates) if (existsSync(c)) return c;
	throw new Error('找不到 Command Code 的 models.md，试过：\n' + candidates.join('\n'));
}

const text = readFileSync(findModelsMd(), 'utf8');
const ctx = {};
const price = {};

for (const line of text.split('\n')) {
	const row = /^\|\s*`([^`]+)`\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|/.exec(line);
	if (!row) continue;
	const [, id, , , , priceCell] = row;

	const windowCell = row[3];
	const w = /([\d.]+)\s*([KM])/i.exec(windowCell);
	if (w) {
		const v = Number(w[1]);
		ctx[id] = Math.round(w[2].toUpperCase() === 'M' ? v * 1048576 : v * 1024);
	}

	const p = /\$([\d.]+)\s*\/\s*\$([\d.]+)/.exec(priceCell);
	if (p) {
		const read = /cache\s*\$([\d.]+)/.exec(priceCell);
		const write = /write\s*\$([\d.]+)/.exec(priceCell);
		price[id] = {
			in: Number(p[1]), out: Number(p[2]),
			read: read ? Number(read[1]) : Number(p[1]),
			write: write ? Number(write[1]) : Number(p[1]),
		};
	}
}

const ctxRows = Object.keys(ctx).sort().map((k) => `\t'${k}': ${ctx[k]},`).join('\n');
const priceRows = Object.keys(price).sort()
	.map((k) => `\t'${k}': {in: ${price[k].in}, out: ${price[k].out}, read: ${price[k].read}, write: ${price[k].write}},`)
	.join('\n');

let src = readFileSync(join(ROOT, 'hud.ts'), 'utf8');

const ctxBlock = /const MODEL_CONTEXT: Record<string, number> = \{[\s\S]*?\n\};/;
const priceBlock = /const MODEL_PRICE: Record<string, Price> = \{[\s\S]*?\n\};/;
if (!ctxBlock.test(src) || !priceBlock.test(src)) {
	throw new Error('hud.ts 里找不到 MODEL_CONTEXT / MODEL_PRICE 块，结构可能已改');
}

src = src.replace(ctxBlock, `const MODEL_CONTEXT: Record<string, number> = {\n${ctxRows}\n};`);
src = src.replace(priceBlock, `const MODEL_PRICE: Record<string, Price> = {\n${priceRows}\n};`);
writeFileSync(join(ROOT, 'hud.ts'), src);

writeFileSync(join(ROOT, 'model-context.json'), JSON.stringify(ctx, null, 1) + '\n');
writeFileSync(join(ROOT, 'model-price.json'), JSON.stringify(price, null, 1) + '\n');

console.log(`✅ 已同步 ${Object.keys(ctx).length} 个上下文上限 / ${Object.keys(price).length} 个定价`);
console.log(`   源: ${findModelsMd()}`);
