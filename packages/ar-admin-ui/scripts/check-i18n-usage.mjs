#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, '..');
const sourceRoot = join(packageRoot, 'src');
const localeRoot = join(sourceRoot, 'i18n');
const strict = process.argv.includes('--strict');

function walk(root, predicate = () => true) {
	const result = [];
	for (const entry of readdirSync(root)) {
		const path = join(root, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			if (entry === 'node_modules' || entry === '.svelte-kit' || entry === '.turbo') continue;
			result.push(...walk(path, predicate));
			continue;
		}
		if (predicate(path)) result.push(path);
	}
	return result;
}

function read(path) {
	return readFileSync(path, 'utf8');
}

function localeFiles(locale) {
	return walk(join(localeRoot, locale), (path) => path.endsWith('.ts'));
}

function collectLocaleKeys(locale) {
	const keys = new Map();
	for (const file of localeFiles(locale)) {
		const content = read(file);
		const keyPattern = /^\s*([a-zA-Z][a-zA-Z0-9_]*)\s*:/gm;
		for (const match of content.matchAll(keyPattern)) {
			keys.set(match[1], relative(packageRoot, file));
		}
	}
	return keys;
}

function sourceFiles() {
	return walk(sourceRoot, (path) => {
		if (!/\.(svelte|ts)$/.test(path)) return false;
		if (path.includes('/src/i18n/')) return false;
		return true;
	});
}

function collectUsedKeys() {
	const used = new Map();
	const callPattern = /\b(?:\$LL|LL)\.([a-zA-Z][a-zA-Z0-9_]*)\s*\(/g;
	for (const file of sourceFiles()) {
		const content = read(file);
		for (const match of content.matchAll(callPattern)) {
			const line = content.slice(0, match.index).split('\n').length;
			const key = match[1];
			const locations = used.get(key) ?? [];
			locations.push(`${relative(packageRoot, file)}:${line}`);
			used.set(key, locations);
		}
	}
	return used;
}

function printList(title, rows, limit = 120) {
	console.log(`\n${title}: ${rows.length}`);
	for (const row of rows.slice(0, limit)) {
		console.log(`  - ${row}`);
	}
	if (rows.length > limit) {
		console.log(`  ... ${rows.length - limit} more`);
	}
}

const enKeys = collectLocaleKeys('en');
const jaKeys = collectLocaleKeys('ja');
const usedKeys = collectUsedKeys();

const missingInJa = [...enKeys.keys()]
	.filter((key) => !jaKeys.has(key))
	.sort()
	.map((key) => `${key} (${enKeys.get(key)})`);
const extraInJa = [...jaKeys.keys()]
	.filter((key) => !enKeys.has(key))
	.sort()
	.map((key) => `${key} (${jaKeys.get(key)})`);
const undefinedUses = [...usedKeys.entries()]
	.filter(([key]) => !enKeys.has(key))
	.sort(([left], [right]) => left.localeCompare(right))
	.map(([key, locations]) => `${key} (${locations.slice(0, 3).join(', ')})`);
const unusedKeys = [...enKeys.keys()]
	.filter((key) => !usedKeys.has(key))
	.sort()
	.map((key) => `${key} (${enKeys.get(key)})`);

console.log('Admin UI i18n usage report');
console.log(`Locales: en=${enKeys.size}, ja=${jaKeys.size}, used=${usedKeys.size}`);
console.log(`Mode: ${strict ? 'strict' : 'report-only'}`);

printList('Missing in ja', missingInJa);
printList('Extra in ja', extraInJa);
printList('Undefined LL key usages', undefinedUses);
printList('Currently unused en keys', unusedKeys, 200);

const blockingCount =
	missingInJa.length + extraInJa.length + undefinedUses.length + unusedKeys.length;
if (strict && blockingCount > 0) {
	console.error(`\nFound ${blockingCount} i18n usage issue(s).`);
	process.exitCode = 1;
}
