/**
 * A `var(--name)` whose `--name` is defined nowhere computes to nothing: a gap or a margin
 * silently becomes 0, and rows that should be apart touch. It builds and type-checks, and only
 * shows on screen. So a custom property that is used without a fallback must be defined
 * somewhere in src: in tokens, in a component or page style, in a `style:--x` / `style="--x:"`,
 * or set from script with `setProperty`.
 *
 * Checked: <style> blocks and quoted style attributes in .svelte files, plus .css under src. A
 * comment is not code, and neither is a string in a .ts file that only shows CSS as text (the
 * code samples), so those are neither a use nor a definition.
 * `var(--x, fallback)` is allowed: it says what to use when `--x` is not set.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const srcDir = join(packageRoot, 'src');

async function files(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const out = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await files(path)));
		else if (/\.(svelte|css|ts|js)$/.test(entry.name)) out.push(path);
	}
	return out;
}

/** The CSS of a file: all of a .css, the <style> blocks and style attributes of a .svelte. */
function cssOf(file, text) {
	if (file.endsWith('.css')) return [{ css: text, offset: 0 }];
	if (!file.endsWith('.svelte')) return [];
	return [
		...[...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => ({
			css: m[1],
			offset: m.index + m[0].indexOf(m[1])
		})),
		...[...text.matchAll(/\bstyle\s*=\s*(["'])([\s\S]*?)\1/g)].map((m) => ({
			css: m[2],
			offset: m.index
		}))
	];
}

/** Comments blanked out, so offsets (and line numbers) stay as they were. */
const blank = (css) =>
	css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));

const defined = new Set();
const used = [];
for (const file of await files(srcDir)) {
	const text = await readFile(file, 'utf8');
	for (const match of text.matchAll(/style:(--[a-zA-Z0-9_-]+)/g)) defined.add(match[1]);
	for (const match of text.matchAll(/setProperty\(\s*['"`](--[a-zA-Z0-9_-]+)/g))
		defined.add(match[1]);
	for (const { css, offset } of cssOf(file, text)) {
		const code = blank(css);
		for (const match of code.matchAll(/(?:^|[\s;{'"`(])(--[a-zA-Z0-9_-]+)\s*:/g))
			defined.add(match[1]);
		for (const match of code.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)\s*\)/g)) {
			const line = text.slice(0, offset + match.index).split('\n').length;
			used.push({ file: relative(packageRoot, file), line, name: match[1] });
		}
	}
}

const problems = used.filter((entry) => !defined.has(entry.name));
if (problems.length > 0) {
	console.error('check-css-vars: custom properties used but defined nowhere:');
	for (const p of problems) console.error(`  ${p.file}:${p.line}  var(${p.name})`);
	process.exit(1);
}
console.log('check-css-vars: ok');
