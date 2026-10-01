/**
 * Pages compose components; they do not decide how things look. Any styling in a route file
 * means a missing component or pattern — add it under src/lib/ui instead.
 *
 * Fails when a file under src/routes contains a <style> block, a style="" attribute, a
 * style: directive, or a class attribute (page-level class names imply page-level CSS).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const routesDir = join(packageRoot, 'src/routes');

const RULES = [
	{ pattern: /<style[\s>]/, message: '<style> block' },
	{ pattern: /\sstyle\s*=/, message: 'style="" attribute' },
	{ pattern: /\sstyle:[\w-]+/, message: 'style: directive' },
	{ pattern: /\sclass\s*=/, message: 'class attribute' },
	{ pattern: /\sclass:[\w-]+/, message: 'class: directive' }
];

async function svelteFiles(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await svelteFiles(path)));
		else if (entry.name.endsWith('.svelte')) files.push(path);
	}
	return files;
}

const problems = [];
for (const file of await svelteFiles(routesDir)) {
	const lines = (await readFile(file, 'utf8')).split('\n');
	lines.forEach((line, index) => {
		for (const rule of RULES) {
			if (rule.pattern.test(line)) {
				problems.push(`${relative(packageRoot, file)}:${index + 1}  ${rule.message}`);
			}
		}
	});
}

if (problems.length > 0) {
	console.error('Route files must not style themselves. Use components from src/lib/ui:\n');
	console.error(problems.join('\n'));
	process.exit(1);
}
console.log('check-route-styles: ok');
