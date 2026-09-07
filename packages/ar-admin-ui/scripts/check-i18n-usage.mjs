#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, '..');
const sourceRoot = join(packageRoot, 'src');
const localeRoot = join(sourceRoot, 'i18n');
const strict = process.argv.includes('--strict');
const fixUnused = process.argv.includes('--fix-unused');

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
	const callPattern = /\b(?:\$LL|LL)\s*\.\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\(/g;
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

function unwrapExpression(expression) {
	let current = expression;
	while (
		current &&
		(ts.isAsExpression(current) ||
			ts.isSatisfiesExpression(current) ||
			ts.isParenthesizedExpression(current))
	) {
		current = current.expression;
	}
	return current;
}

function topLevelLocaleObject(sourceFile) {
	for (const statement of sourceFile.statements) {
		if (ts.isExportAssignment(statement)) {
			const expression = unwrapExpression(statement.expression);
			if (expression && ts.isObjectLiteralExpression(expression)) return expression;
		}
		if (!ts.isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			const expression = declaration.initializer && unwrapExpression(declaration.initializer);
			if (expression && ts.isObjectLiteralExpression(expression)) return expression;
		}
	}
	return null;
}

function propertyKey(property) {
	if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) return null;
	if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) {
		return property.name.text;
	}
	return null;
}

function removeUnusedLocaleKeys(locale, unused) {
	let removed = 0;
	for (const path of localeFiles(locale)) {
		const content = read(path);
		const sourceFile = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
		const object = topLevelLocaleObject(sourceFile);
		if (!object) continue;
		const ranges = object.properties
			.filter((property) => {
				const key = propertyKey(property);
				return key !== null && unused.has(key);
			})
			.map((property) => {
				let end = property.end;
				while (end < content.length && (content[end] === ' ' || content[end] === '\t')) end++;
				if (content[end] === ',') end++;
				return { start: property.getFullStart(), end };
			})
			.sort((left, right) => right.start - left.start);
		if (ranges.length === 0) continue;
		let updated = content;
		for (const range of ranges) updated = updated.slice(0, range.start) + updated.slice(range.end);
		writeFileSync(path, updated);
		removed += ranges.length;
	}
	return removed;
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

let enKeys = collectLocaleKeys('en');
let jaKeys = collectLocaleKeys('ja');
const usedKeys = collectUsedKeys();

if (fixUnused) {
	const unused = new Set([...enKeys.keys()].filter((key) => !usedKeys.has(key)));
	const removedEn = removeUnusedLocaleKeys('en', unused);
	const removedJa = removeUnusedLocaleKeys('ja', unused);
	console.log(`Removed unused locale keys: en=${removedEn}, ja=${removedJa}`);
	enKeys = collectLocaleKeys('en');
	jaKeys = collectLocaleKeys('ja');
}

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
