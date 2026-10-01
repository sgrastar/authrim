/**
 * Type and icons are set from the scales in tokens.css (--fs-*, --fw-*, --lh-*, --icon-*), so
 * the same role has the same size everywhere. A literal size or weight would slip past that, so
 * it is rejected.
 *
 * Allowed: src/lib/ui/tokens/**, src/lib/ui/themes/** and src/lib/ui/fonts/** (@font-face).
 * Checked:  <style> blocks in .svelte files and .css files under src.
 * Relative sizes (em, %) are fine: they follow the role of their parent.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const srcDir = join(packageRoot, 'src');
const ALLOWED = ['tokens', 'themes', 'fonts'].map((dir) => join(srcDir, 'lib/ui', dir) + sep);
const LITERAL = /font-size:\s*[0-9.]+(px|rem)\b|font-weight:\s*[0-9]+\b|--icon-size:\s*[0-9.]+px\b/;

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
		: [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
	for (const css of blocks) {
		css.split('\n').forEach((line) => {
			const code = line.replace(/\/\*.*?\*\//g, '');
			if (LITERAL.test(code)) problems.push(`${relative(packageRoot, file)}: ${line.trim()}`);
		});
	}
}

if (problems.length > 0) {
	console.error('Literal type or icon sizes (use --fs-* / --fw-* / --icon-* from tokens.css):');
	for (const problem of problems) console.error(`  ${problem}`);
	process.exit(1);
}
console.log('check-type-scale: ok');
