import { describe, expect, it } from 'vitest';
import { newStep, type Mapping, type MappingField, type TransformStep } from './mapping-model';
import { previewMapping } from './mapping-preview';

const sources: MappingField[] = [
	{ key: 'givenName', type: 'string', example: 'John' },
	{ key: 'sn', type: 'string', example: 'Smith' },
	{ key: 'mail', type: 'string', example: ' John@Example.com ' },
	{ key: 'active', type: 'string', example: 'Smith' },
	{ key: 'groups', type: 'string[]', example: ['sales', 'admins'] },
	{ key: 'plain', type: 'string' },
	{ key: 'dept', type: 'string', example: 'SALES' },
	{ key: 'kana', type: 'string', example: 'ﾔﾏﾀﾞ ﾀﾛｳ' },
	{ key: 'age', type: 'string', example: ' 42 ' },
	{ key: 'since', type: 'string', example: '1700000000' },
	{ key: 'memberOf', type: 'string[]', example: ['app-crm', 'staff', 'APP-hr'] },
	{ key: 'empty', type: 'string', example: '' },
	{ key: 'profile', type: 'string', example: '{"user":{"groups":["sales","admins"]}}' },
	{ key: 'mainGroup', type: 'string', example: 'sales' },
	{ key: 'employmentType', type: 'string', example: 'contract' },
	{ key: 'blank', type: 'string', example: ' \u3000 ' },
	{ key: 'social', type: 'string', example: '{"name":"John","picture":null}' }
];
const step = (transform: TransformStep['transform'], params: TransformStep['params'] = {}) => ({
	...newStep(transform, transform),
	params: { ...newStep(transform, transform).params, ...params }
});
const map = (sourceKeys: string[], steps: TransformStep[]): Mapping => ({
	id: 'm',
	target: 't',
	sources: sourceKeys,
	steps
});
const values = (trace: ReturnType<typeof previewMapping>) =>
	trace?.steps.map((after) => after.map((v) => (v.known ? v.value : '(at sign-in)')));

describe('previewMapping (run by the runtime engine)', () => {
	it('shows each step: per source before combining, one value after', () => {
		const trace = previewMapping(
			map(
				['givenName', 'sn'],
				[step('concat', { delimiter: ' ' }), step('affix_text', { suffix: ' (Sales)' })]
			),
			sources
		);
		expect(values(trace)).toEqual([['John Smith'], ['John Smith (Sales)']]);
		expect(trace?.output).toEqual({ known: true, value: 'John Smith (Sales)' });
	});

	it('applies steps before combining to each source', () => {
		const trace = previewMapping(
			map(
				['givenName', 'sn'],
				[step('case', { mode: 'upper' }), step('concat', { delimiter: '.' })]
			),
			sources
		);
		expect(values(trace)).toEqual([['JOHN', 'SMITH'], ['JOHN.SMITH']]);
	});

	it('says what the runtime says, not a guess (unmatched yes/no text is no value)', () => {
		const trace = previewMapping(map(['active'], [step('text_to_boolean')]), sources);
		expect(trace?.output).toEqual({ known: true, value: null });
		const email = previewMapping(map(['mail'], [step('trim'), step('case')]), sources);
		expect(email?.output).toEqual({ known: true, value: 'john@example.com' });
	});

	it('keeps a part, removes characters, replaces by a pattern', () => {
		const out = (steps: TransformStep[], from = ['mail']) =>
			previewMapping(map(from, steps), sources)?.output;
		const mail = [step('trim')];
		expect(out([...mail, step('keep_part')])).toEqual({ known: true, value: 'John' });
		expect(out([...mail, step('keep_part', { keep: 'after' })])).toEqual({
			known: true,
			value: 'Example.com'
		});
		expect(out([step('remove_text', { text: 'a' })], ['groups'])).toEqual({
			known: true,
			value: ['sles', 'dmins']
		});
		expect(
			out([...mail, step('regex_replace', { pattern: '^(.+)@.+$', replacement: '$1' })])
		).toEqual({ known: true, value: 'John' });
		expect(
			out([
				...mail,
				step('regex_replace', { pattern: 'EXAMPLE', replacement: 'x', ignoreCase: true })
			])
		).toEqual({ known: true, value: 'John@x.com' });
	});

	it('converts values: table, width, number, date', () => {
		const out = (from: string, steps: TransformStep[]) =>
			previewMapping(map([from], steps), sources)?.output;
		const table = JSON.stringify([['sales', '営業']]);
		expect(out('dept', [step('value_map', { entries: table, ignoreCase: true })])).toEqual({
			known: true,
			value: '営業'
		});
		expect(out('dept', [step('value_map', { entries: table, otherwise: 'none' })])).toEqual({
			known: true,
			value: null
		});
		expect(out('kana', [step('to_fullwidth')])).toEqual({ known: true, value: 'ヤマダ　タロウ' });
		expect(out('age', [step('text_to_number')])).toEqual({ known: true, value: 42 });
		expect(out('since', [step('date_format', { from: 'auto', to: 'date' })])).toEqual({
			known: true,
			value: '2023-11-14'
		});
	});

	it('filters values, fills a default, replaces text, leaves hashing to run time', () => {
		const out = (from: string, steps: TransformStep[]) =>
			previewMapping(map([from], steps), sources)?.output;
		expect(
			out('memberOf', [
				step('filter_values', { how: 'starts_with', match: 'app-', ignoreCase: true })
			])
		).toEqual({ known: true, value: ['app-crm', 'APP-hr'] });
		expect(
			out('memberOf', [step('filter_values', { how: 'starts_with', match: 'app-', exclude: true })])
		).toEqual({ known: true, value: ['staff', 'APP-hr'] });
		expect(out('empty', [step('default_if_empty', { value: 'ja' })])).toEqual({
			known: true,
			value: 'ja'
		});
		expect(out('dept', [step('replace_text', { find: 'les', replacement: 'LE' })])).toEqual({
			known: true,
			value: 'SALES'
		});
		expect(
			out('dept', [step('replace_text', { find: 'les', replacement: 'le', ignoreCase: true })])
		).toEqual({ known: true, value: 'SAle' });
		expect(out('dept', [step('hash')])).toEqual({ known: false });
	});

	it('takes a list out of JSON, and collects attributes into a list', () => {
		const out = (from: string[], steps: TransformStep[]) =>
			previewMapping(map(from, steps), sources)?.output;
		expect(out(['profile'], [step('json_extract_array', { path: 'user.groups' })])).toEqual({
			known: true,
			value: ['sales', 'admins']
		});
		expect(out(['profile'], [step('json_extract_array', { path: 'user.name' })])).toEqual({
			known: true,
			value: null
		});
		expect(
			out(
				['mainGroup', 'memberOf', 'empty'],
				[step('array_build', { omitEmpty: true, unique: true })]
			)
		).toEqual({ known: true, value: ['sales', 'app-crm', 'staff', 'APP-hr'] });
	});

	it('chooses a value by a condition on another attribute', () => {
		const condition = (value: string) =>
			JSON.stringify({
				id: 'g',
				kind: 'group',
				match: 'all',
				children: [{ id: 'r', kind: 'rule', field: 'employmentType', operator: 'eq', value }]
			});
		const choose = (value: string, elseMode = 'as_is') =>
			previewMapping(
				map(
					['dept'],
					[step('conditional', { condition: condition(value), thenValue: 'contractor', elseMode })]
				),
				sources
			)?.output;
		expect(choose('contract')).toEqual({ known: true, value: 'contractor' });
		expect(choose('permanent')).toEqual({ known: true, value: 'SALES' });
		expect(choose('permanent', 'none')).toEqual({ known: true, value: null });
	});

	it('gives a chosen value type, and says whether there is a value', () => {
		const condition = JSON.stringify({
			id: 'g',
			kind: 'group',
			match: 'all',
			children: [{ id: 'r', kind: 'rule', field: 'mail', operator: 'exists', value: null }]
		});
		const typed = previewMapping(
			map(
				['mail'],
				[step('conditional', { condition, valueType: 'as_boolean', thenBool: 'true' })]
			),
			sources
		);
		expect(typed?.output).toEqual({ known: true, value: true });
		expect(previewMapping(map(['mail'], [step('has_value')]), sources)?.output).toEqual({
			known: true,
			value: true
		});
		expect(
			previewMapping(map(['empty'], [step('has_value', { invert: true })]), sources)?.output
		).toEqual({ known: true, value: true });
	});

	it('tidies empty values, spaces of both widths included', () => {
		const out = (from: string, params: TransformStep['params']) =>
			previewMapping(map([from], [step('normalize_empty', params)]), sources)?.output;
		expect(out('blank', {})).toEqual({ known: true, value: null });
		expect(out('blank', { emptyAs: 'fixed', emptyValue: 'n/a' })).toEqual({
			known: true,
			value: 'n/a'
		});
		expect(out('blank', { spaces: false })).toEqual({ known: true, value: ' \u3000 ' });
		expect(out('dept', {})).toEqual({ known: true, value: 'SALES' });
	});

	it('takes a value out of JSON, or the default when the key is missing', () => {
		const out = (params: TransformStep['params']) =>
			previewMapping(map(['social'], [step('json_extract_or', params)]), sources)?.output;
		const picture = 'https://example.com/default.png';
		expect(out({ path: 'name', defaultValue: picture })).toEqual({ known: true, value: 'John' });
		expect(out({ path: 'avatar', defaultValue: picture })).toEqual({ known: true, value: picture });
		expect(out({ path: 'picture', defaultValue: picture })).toEqual({
			known: true,
			value: picture
		});
		expect(out({ path: 'picture', defaultValue: picture, nullAsMissing: false })).toEqual({
			known: true,
			value: null
		});
	});

	it('writes dates in a time zone', () => {
		const date = (to: string, timeZone: string) =>
			previewMapping(map(['since'], [step('date_format', { from: 'auto', to, timeZone })]), sources)
				?.output;
		expect(date('iso', 'Asia/Tokyo')).toEqual({ known: true, value: '2023-11-15T07:13:20+09:00' });
		expect(date('date', 'Asia/Tokyo')).toEqual({ known: true, value: '2023-11-15' });
		expect(date('iso', 'UTC')).toEqual({ known: true, value: '2023-11-14T22:13:20Z' });
		expect(date('iso', 'America/New_York')).toEqual({
			known: true,
			value: '2023-11-14T17:13:20-05:00'
		});
	});

	it('handles several values and fixed values', () => {
		expect(previewMapping(map(['groups'], [step('first')]), sources)?.output).toEqual({
			known: true,
			value: 'sales'
		});
		expect(
			previewMapping(map([], [step('constant_boolean', { value: 'true' })]), sources)?.output
		).toEqual({ known: true, value: true });
	});

	it('leaves identifiers to sign-in, and shows nothing without sample data', () => {
		const pairwise = previewMapping(map(['mail'], [step('oidc_pairwise_sub')]), sources);
		expect(pairwise?.output).toEqual({ known: false });
		expect(previewMapping(map(['plain'], [step('trim')]), sources)).toBeNull();
	});
});
