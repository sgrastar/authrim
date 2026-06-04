#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(__dirname, '..');
const sourceRoot = join(packageRoot, 'src');
const strict = process.argv.includes('--strict');

const allowedExact = new Set([
	'ABAC',
	'API',
	'CSV',
	'D1',
	'HTML',
	'IdP',
	'JSON',
	'JWT',
	'JWK',
	'JWKS',
	'OAuth',
	'OIDC',
	'PEM',
	'RBAC',
	'ReBAC',
	'SAML',
	'SCIM',
	'SP',
	'URI',
	'URL',
	'WebAuthn',
	'XML'
]);

const ignoredLiteralPatterns = [
	/^\s*$/,
	/^[A-Z0-9_./: -]+$/,
	/^[a-z0-9_.:/-]+$/,
	/^\$?[A-Z_][A-Z0-9_]*(?:\s*[-/]\s*\$?[A-Z_][A-Z0-9_]*)*$/,
	/^\{[^}]+\}$/,
	/^#[0-9a-fA-F]{3,8}$/,
	/^https?:\/\//,
	/^[\w.-]+@[\w.-]+$/,
	/^[\w.-]+\.[a-z]{2,}$/i
];

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

function lineAt(content, index) {
	return content.slice(0, index).split('\n').length;
}

function isAllowedLiteral(value) {
	const trimmed = value.trim();
	if (!/[A-Za-z]{3,}/.test(trimmed)) return true;
	if (allowedExact.has(trimmed)) return true;
	if (ignoredLiteralPatterns.some((pattern) => pattern.test(trimmed))) return true;
	if (/^\$LL\./.test(trimmed) || /\$LL\.[a-zA-Z]/.test(trimmed)) return true;
	if (/^[A-Z][a-zA-Z0-9]*(?:ID|URL|URI|JSON|XML|JWT|JWK|PEM)$/.test(trimmed)) return true;
	return false;
}

function compact(value) {
	return value.replace(/\s+/g, ' ').trim();
}

function stripBlocks(content) {
	return content
		.replace(/<script\b[\s\S]*?<\/script\s*>/gi, (match) => '\n'.repeat(match.split('\n').length - 1))
		.replace(/<style\b[\s\S]*?<\/style\s*>/gi, (match) => '\n'.repeat(match.split('\n').length - 1))
		.replace(/<!--[\s\S]*?-->/g, (match) => '\n'.repeat(match.split('\n').length - 1));
}

function scanFile(file) {
	const content = readFileSync(file, 'utf8');
	const findings = [];
	const rel = relative(packageRoot, file);
	const markup = stripBlocks(content);

	const textPattern = />\s*([^<>{}][^<>{}]*)\s*</g;
	for (const match of markup.matchAll(textPattern)) {
		const text = compact(match[1]);
		if (!text || isAllowedLiteral(text)) continue;
		findings.push({
			file: rel,
			line: lineAt(markup, match.index),
			kind: 'text',
			value: text
		});
	}

	const attrPattern = /\b(aria-label|title|placeholder|alt)\s*=\s*(['"])(.*?)\2/g;
	for (const match of content.matchAll(attrPattern)) {
		const value = compact(match[3]);
		if (!value || isAllowedLiteral(value)) continue;
		findings.push({
			file: rel,
			line: lineAt(content, match.index),
			kind: `attr:${match[1]}`,
			value
		});
	}

	const uiStringPattern =
		/\b(title|label|description|placeholder|message|heading|subtitle|ariaLabel|empty|error|warning|success)\b\s*[:=]\s*(['"`])([^'"`]*[A-Za-z]{3,}[^'"`]*)\2/g;
	for (const match of content.matchAll(uiStringPattern)) {
		const value = compact(match[3]);
		if (!value || isAllowedLiteral(value)) continue;
		findings.push({
			file: rel,
			line: lineAt(content, match.index),
			kind: `script:${match[1]}`,
			value
		});
	}

	return findings;
}

const files = walk(sourceRoot, (path) => path.endsWith('.svelte'));
const findings = files.flatMap(scanFile).sort((left, right) => {
	if (left.file !== right.file) return left.file.localeCompare(right.file);
	return left.line - right.line;
});

console.log('Svelte hardcoded English literal report');
console.log(`Files scanned: ${files.length}`);
console.log(`Mode: ${strict ? 'strict' : 'report-only'}`);
console.log(`Findings: ${findings.length}`);

const limit = 250;
for (const finding of findings.slice(0, limit)) {
	console.log(
		`  - ${finding.file}:${finding.line} [${finding.kind}] ${JSON.stringify(finding.value)}`
	);
}
if (findings.length > limit) {
	console.log(`  ... ${findings.length - limit} more`);
}

if (strict && findings.length > 0) {
	console.error(`\nFound ${findings.length} hardcoded English literal(s).`);
	process.exitCode = 1;
}
