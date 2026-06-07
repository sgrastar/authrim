import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(packageRoot, '../..');
const productionServerOutput = join(packageRoot, '.svelte-kit/output/server');
const managementSource = join(repoRoot, 'packages/ar-management/src');
const forbiddenProductionNeedles = [
	'__AUTHRIM_ADMIN_UI_DEV_MOCK_SENTINEL__',
	'AUTHRIM_ADMIN_UI_DEV_MOCK'
];
const forbiddenWorkerNeedles = ['AUTHRIM_ADMIN_UI_DEV_MOCK'];

async function walkFiles(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await walkFiles(path)));
		} else if (entry.isFile()) {
			files.push(path);
		}
	}
	return files;
}

async function assertDirectoryExists(dir, message) {
	try {
		const info = await stat(dir);
		if (info.isDirectory()) return;
	} catch {
		// Fall through to the stable error below.
	}
	throw new Error(message);
}

async function assertNeedlesAbsent({ dir, needles, label }) {
	const files = await walkFiles(dir);
	const matches = [];
	for (const file of files) {
		const text = await readFile(file, 'utf8').catch(() => null);
		if (text === null) continue;
		for (const needle of needles) {
			if (text.includes(needle)) {
				matches.push(`${file.replace(repoRoot + '/', '')}: ${needle}`);
			}
		}
	}
	if (matches.length > 0) {
		throw new Error(`${label} contains dev mock guard markers:\n${matches.join('\n')}`);
	}
}

await assertDirectoryExists(
	productionServerOutput,
	'Admin UI production output is missing. Run `pnpm --filter @authrim/ar-admin-ui build` first.'
);

await assertNeedlesAbsent({
	dir: productionServerOutput,
	needles: forbiddenProductionNeedles,
	label: 'Admin UI production server output'
});

await assertNeedlesAbsent({
	dir: managementSource,
	needles: forbiddenWorkerNeedles,
	label: 'ar-management Worker source'
});

console.log('Admin UI dev mock guard check passed.');
