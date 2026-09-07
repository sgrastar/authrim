import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REQUIRED_LANGUAGES = [
	'en',
	'ja',
	'zh-CN',
	'zh-TW',
	'es',
	'pt',
	'fr',
	'de',
	'ko',
	'ru',
	'id',
	'ar',
	'it',
	'th',
	'vi',
	'hi',
	'bn',
	'tr',
	'sw',
	'am',
	'pl'
].sort();

const PRESET_LOCALIZATION_FUNCTIONS = [
	'termsAgreementText',
	'privacyAgreementText',
	'samlAttributeReleaseConfirmationText',
	'samlAllowOnceLabels',
	'samlAllowOnceDescriptions',
	'samlAlwaysAllowLabels',
	'samlAlwaysAllowDescriptions',
	'samlDenyLabels',
	'samlDenyDescriptions',
	'releaseAllInformationLabels',
	'releaseAllInformationDescriptions',
	'releaseMinimumInformationLabels',
	'releaseMinimumInformationDescriptions',
	'releaseNoInformationLabels',
	'releaseNoInformationDescriptions',
	'genericContentOptionLabels'
];

const componentSource = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
const scriptSource = componentSource.match(/<script lang="ts">([\s\S]*?)<\/script>/)?.[1] ?? '';
const sourceFile = ts.createSourceFile(
	'consent-statements-new.ts',
	scriptSource,
	ts.ScriptTarget.Latest,
	true,
	ts.ScriptKind.TS
);

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
	if (!property.name) return null;
	if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
		return property.name.text;
	return null;
}

function findFunction(name: string): ts.FunctionDeclaration | undefined {
	return sourceFile.statements.find(
		(statement): statement is ts.FunctionDeclaration =>
			ts.isFunctionDeclaration(statement) && statement.name?.text === name
	);
}

function returnedLanguageMaps(fn: ts.FunctionDeclaration): ts.ObjectLiteralExpression[] {
	const maps: ts.ObjectLiteralExpression[] = [];
	const visit = (node: ts.Node) => {
		if (
			ts.isReturnStatement(node) &&
			node.expression &&
			ts.isObjectLiteralExpression(node.expression)
		) {
			maps.push(node.expression);
		}
		ts.forEachChild(node, visit);
	};
	if (fn.body) visit(fn.body);
	return maps;
}

describe('consent preset localizations', () => {
	it('exposes every Login UI language in the preset editor', () => {
		const declaration = sourceFile.statements
			.filter(ts.isVariableStatement)
			.flatMap((statement) => [...statement.declarationList.declarations])
			.find(
				(candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === 'languageOptions'
			);
		expect(declaration?.initializer && ts.isArrayLiteralExpression(declaration.initializer)).toBe(
			true
		);
		if (!declaration?.initializer || !ts.isArrayLiteralExpression(declaration.initializer)) return;

		const languages = declaration.initializer.elements
			.filter(ts.isObjectLiteralExpression)
			.map((option) => option.properties.find((property) => propertyName(property) === 'code'))
			.filter(
				(property): property is ts.PropertyAssignment =>
					property !== undefined && ts.isPropertyAssignment(property)
			)
			.map((property) =>
				ts.isStringLiteral(property.initializer) ? property.initializer.text : ''
			)
			.sort();
		expect(languages).toEqual(REQUIRED_LANGUAGES);
	});

	it.each(PRESET_LOCALIZATION_FUNCTIONS)(
		'%s supplies copy for all twenty-one languages',
		(name) => {
			const fn = findFunction(name);
			expect(fn, name).toBeDefined();
			if (!fn) return;
			const maps = returnedLanguageMaps(fn);
			expect(maps.length, name).toBeGreaterThan(0);
			for (const map of maps) {
				const languages = map.properties
					.map(propertyName)
					.filter((language): language is string => Boolean(language))
					.sort();
				expect(languages, name).toEqual(REQUIRED_LANGUAGES);
			}
		}
	);

	it('previews Arabic consent copy in RTL direction', () => {
		expect(componentSource).toContain("dir={selectedLanguage === 'ar' ? 'rtl' : 'ltr'}");
	});
});
