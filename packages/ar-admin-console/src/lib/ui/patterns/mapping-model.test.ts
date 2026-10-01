import { describe, expect, it } from 'vitest';
import {
	TRANSFORMS,
	TRANSFORM_CATEGORIES,
	generatorFor,
	newStep,
	fixesFor,
	mappingProblems,
	unmappedRequired,
	unusedSources,
	type Mapping,
	type MappingField,
	type TransformStep
} from './mapping-model';

const sources: MappingField[] = [
	{ key: 'mail', type: 'string' },
	{ key: 'memberOf', type: 'string[]' },
	{ key: 'givenName', type: 'string' },
	{ key: 'sn', type: 'string' },
	{ key: 'active', type: 'string' },
	{ key: 'profile', type: 'string' }
];
const targets: MappingField[] = [
	{ key: 'email', type: 'string', required: true },
	{ key: 'groups', type: 'string[]' },
	{ key: 'department', type: 'string' },
	{ key: 'name', type: 'string' },
	{ key: 'enabled', type: 'boolean', required: true },
	{ key: 'age', type: 'number' },
	{ key: 'extra', type: 'object' }
];
let n = 0;
const step = (
	transform: TransformStep['transform'],
	params: Record<string, string | boolean> = {}
): TransformStep => ({
	id: `s${++n}`,
	transform,
	params
});
const map = (target: string, sources: string[], steps: TransformStep[] = []): Mapping => ({
	id: target,
	target,
	sources,
	steps
});

describe('mappingProblems', () => {
	it('accepts a plain copy of the same type', () => {
		expect(mappingProblems(map('email', ['mail']), sources, targets)).toEqual([]);
	});

	it('flags several values going into one, unless a step picks or joins them', () => {
		expect(mappingProblems(map('department', ['memberOf']), sources, targets)).toEqual([
			{ kind: 'manyIntoOne' }
		]);
		expect(
			mappingProblems(map('department', ['memberOf'], [step('first')]), sources, targets)
		).toEqual([]);
		expect(
			mappingProblems(
				map('department', ['memberOf'], [step('join', { delimiter: ',' })]),
				sources,
				targets
			)
		).toEqual([]);
	});

	it('asks for a combining step when there are several sources, and for settings', () => {
		expect(mappingProblems(map('name', ['givenName', 'sn']), sources, targets)).toEqual([
			{ kind: 'needsCombine' }
		]);
		expect(mappingProblems(map('name', ['givenName'], [step('concat')]), sources, targets)).toEqual(
			[{ kind: 'combineNeedsMore' }]
		);
		expect(
			mappingProblems(map('department', ['memberOf'], [step('join')]), sources, targets)
		).toEqual([{ kind: 'missingParam', step: 1, param: 'delimiter' }]);
	});

	it('follows the type through the steps', () => {
		expect(mappingProblems(map('enabled', ['active']), sources, targets)).toEqual([
			{ kind: 'typeMismatch', from: 'string', to: 'boolean' }
		]);
		expect(
			mappingProblems(
				map('enabled', ['active'], [step('trim'), step('text_to_boolean')]),
				sources,
				targets
			)
		).toEqual([]);
	});
});

describe('operations', () => {
	it('offers every runtime operation but copy, and fixed values, each in a category', () => {
		expect(TRANSFORMS).toHaveLength(40);
		for (const def of TRANSFORMS) expect(TRANSFORM_CATEGORIES).toContain(def.category);
	});

	it('starts a step at the runtime defaults, switches off', () => {
		expect(newStep('split', 's').params).toEqual({
			delimiter: ',',
			trimItems: false,
			omitEmpty: false,
			unique: false
		});
		expect(newStep('normalize', 'n').params).toEqual({ mode: 'whitespace' });
	});

	it('types what JSON steps give', () => {
		const toAge = map('age', ['profile'], [step('json_extract_integer', { path: 'age' })]);
		expect(mappingProblems(toAge, sources, targets)).toEqual([]);
		expect(
			mappingProblems(map('age', ['profile'], [step('json_extract_integer')]), sources, targets)
		).toEqual([{ kind: 'missingParam', step: 1, param: 'path' }]);
		expect(
			mappingProblems(
				map('enabled', ['profile'], [step('json_extract_text', { path: 'on' })]),
				sources,
				targets
			)
		).toEqual([{ kind: 'typeMismatch', from: 'string', to: 'boolean' }]);
	});

	it('fills an attribute with a fixed value, no source needed', () => {
		expect(
			mappingProblems(map('enabled', [], [newStep('constant_boolean', 'c')]), sources, targets)
		).toEqual([]);
		expect(generatorFor('boolean')).toBe('constant_boolean');
		expect(generatorFor('number')).toBe('constant_number');
		expect(generatorFor('string')).toBe('constant_text');
		expect(
			mappingProblems(map('age', [], [step('constant_number', { value: 'ten' })]), sources, targets)
		).toEqual([{ kind: 'notNumber', step: 1 }]);
		expect(mappingProblems(map('email', [], [step('constant_text')]), sources, targets)).toEqual([
			{ kind: 'missingParam', step: 1, param: 'value' }
		]);
		// A fixed value of the wrong type is still caught.
		expect(
			mappingProblems(
				map('enabled', [], [step('constant_text', { value: 'on' })]),
				sources,
				targets
			)
		).toEqual([{ kind: 'typeMismatch', from: 'string', to: 'boolean' }]);
	});

	it('checks a regular expression before it is used', () => {
		const bad = step('regex_replace', { pattern: '(unclosed', replacement: '' });
		expect(mappingProblems(map('email', ['mail'], [bad]), sources, targets)).toEqual([
			{ kind: 'badPattern', step: 1 }
		]);
		const good = step('regex_replace', { pattern: '^(.+)@.+$', replacement: '$1' });
		expect(mappingProblems(map('email', ['mail'], [good]), sources, targets)).toEqual([]);
	});

	it('asks for a setting only while it applies, and for a table with rows', () => {
		const table = newStep('value_map', 'v');
		expect(mappingProblems(map('department', ['sn'], [table]), sources, targets)).toEqual([
			{ kind: 'missingParam', step: 1, param: 'entries' }
		]);
		const filled = { ...table, params: { ...table.params, entries: '[["Sales","営業"]]' } };
		expect(mappingProblems(map('department', ['sn'], [filled]), sources, targets)).toEqual([]);
		const fixed = { ...filled, params: { ...filled.params, otherwise: 'fixed' } };
		expect(mappingProblems(map('department', ['sn'], [fixed]), sources, targets)).toEqual([
			{ kind: 'missingParam', step: 1, param: 'fallbackValue' }
		]);
	});

	it('types dates and numbers, and lets a date go into text', () => {
		const iso = step('date_format', { from: 'auto', to: 'iso' });
		expect(mappingProblems(map('name', ['sn'], [iso]), sources, targets)).toEqual([]);
		const unix = step('date_format', { from: 'iso', to: 'unix_s' });
		expect(mappingProblems(map('age', ['sn'], [unix]), sources, targets)).toEqual([]);
		expect(mappingProblems(map('age', ['sn'], [step('text_to_number')]), sources, targets)).toEqual(
			[]
		);
	});

	it('builds JSON from one attribute or several', () => {
		const build = step('json_build', { nullHandling: 'omit' });
		expect(mappingProblems(map('extra', ['profile'], [build]), sources, targets)).toEqual([]);
		expect(mappingProblems(map('extra', ['givenName', 'sn'], [build]), sources, targets)).toEqual(
			[]
		);
	});
});

describe('fixesFor', () => {
	it('offers the step that resolves a problem', () => {
		expect(fixesFor({ kind: 'manyIntoOne' }).map((f) => f.step.transform)).toEqual([
			'first',
			'join'
		]);
		expect(
			fixesFor({ kind: 'typeMismatch', from: 'string', to: 'boolean' })[0].step.transform
		).toBe('text_to_boolean');
		expect(fixesFor({ kind: 'needsCombine' })[0].step.transform).toBe('concat');
		expect(fixesFor({ kind: 'noSource' })).toEqual([]);
	});
});

describe('coverage', () => {
	it('lists required attributes left empty and sources nobody uses', () => {
		const mappings = [map('email', ['mail'])];
		expect(unmappedRequired(targets, mappings).map((f) => f.key)).toEqual(['enabled']);
		expect(unusedSources(sources, mappings).map((f) => f.key)).toEqual([
			'memberOf',
			'givenName',
			'sn',
			'active',
			'profile'
		]);
	});
});
