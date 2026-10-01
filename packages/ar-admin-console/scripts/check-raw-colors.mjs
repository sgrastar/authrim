/**
 * Colours are defined once, as theme tokens. Anywhere else a literal colour would ignore the
 * theme (and dark mode), so it is rejected.
 *
 * Allowed: src/lib/ui/tokens/** and src/lib/ui/themes/** (where tokens are defined).
 * Checked:  every other .svelte / .css / .ts file under src.
 * Keywords such as `transparent`, `currentColor` and `inherit` are fine.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const srcDir = join(packageRoot, 'src');
const ALLOWED = [join(srcDir, 'lib/ui/tokens') + sep, join(srcDir, 'lib/ui/themes') + sep];
const EXTENSIONS = ['.svelte', '.css', '.ts'];
const COLOR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/;

async function files(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const out = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await files(path)));
		else if (EXTENSIONS.some((ext) => entry.name.endsWith(ext))) out.push(path);
	}
	return out;
}

/** Only CSS contexts matter: <style> blocks in .svelte, whole .css files, style strings in .ts. */
function cssRanges(path, text) {
	if (path.endsWith('.css')) return [text];
	if (path.endsWith('.svelte'))
		return [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
	return [];
}

const problems = [];
for (const file of await files(srcDir)) {
	if (ALLOWED.some((prefix) => file.startsWith(prefix))) continue;
	if (file.endsWith('.test.ts')) continue;
	const text = await readFile(file, 'utf8');
	for (const css of cssRanges(file, text)) {
		css.split('\n').forEach((line) => {
			const code = line.replace(/\/\*.*?\*\//g, '');
			if (COLOR.test(code)) problems.push(`${relative(packageRoot, file)}: ${line.trim()}`);
		});
	}
}

if (problems.length > 0) {
	console.error(
		'Literal colours outside the theme tokens. Use a token (see src/lib/ui/themes/README.md):\n'
	);
	console.error(problems.join('\n'));
	process.exit(1);
}
console.log('check-raw-colors: ok');
