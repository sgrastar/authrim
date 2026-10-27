/**
 * Type and icons are set from the scales in tokens.css (--fs-*, --fw-*, --lh-*, --icon-*), so
 * the same role has the same size everywhere. A literal size or weight would slip past that, so
 * it is rejected. The same applies to literal line heights.
 *
 * Allowed: src/lib/ui/tokens/**, src/lib/ui/themes/** and src/lib/ui/fonts/** (@font-face).
 * Checked:  <style> blocks and quoted style attributes in .svelte files, plus .css under src.
 * Relative font sizes create extra rendered tiers, so components use role tokens instead.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const srcDir = join(packageRoot, 'src');
const ALLOWED = ['tokens', 'themes', 'fonts'].map((dir) => join(srcDir, 'lib/ui', dir) + sep);
const LITERAL =
	/font-size:\s*[0-9.]+(px|rem|em)\b|font-size:\s*[0-9.]+%|font-weight:\s*[0-9]+\b|line-height:\s*[0-9.]+(?:px|rem|em|%)?(?=\s|;|}|$)|--icon-size:\s*[0-9.]+px\b/;

async function files(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const out = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await files(path)));
		else if (entry.name.endsWith('.svelte') || entry.name.endsWith('.css')) out.push(path);
	}
	return out;
}

const problems = [];
for (const file of await files(srcDir)) {
	if (ALLOWED.some((prefix) => file.startsWith(prefix))) continue;
	const text = await readFile(file, 'utf8');
	const blocks = file.endsWith('.css')
		? [text]
		: [
				...[...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]),
				...[...text.matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/g)].map((m) => m[2])
			];
	for (const css of blocks) {
		css.split('\n').forEach((line) => {
			const code = line.replace(/\/\*.*?\*\//g, '');
			if (LITERAL.test(code)) problems.push(`${relative(packageRoot, file)}: ${line.trim()}`);
		});
	}
}

if (problems.length > 0) {
	console.error(
		'Literal type or icon sizes (use --fs-* / --fw-* / --lh-* / --icon-* from tokens.css):'
	);
	for (const problem of problems) console.error(`  ${problem}`);
	process.exit(1);
}
console.log('check-type-scale: ok');
