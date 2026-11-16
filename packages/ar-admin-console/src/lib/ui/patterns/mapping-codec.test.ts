import { describe, expect, it } from 'vitest';
import { evaluateMappingRule } from '@authrim/ar-lib-field-mapping/authoring';
import type { MappingRuleGraph } from '@authrim/ar-lib-field-mapping/contract';
import type { MappingSetContent, MappingSetRule } from '#lib/api/mapping-set.js';
import {
	compileMapping,
	compileMappingSet,
	decompileMappingSet,
	type MappingCodecContext
} from './mapping-codec';
import { newStep, type Mapping, type MappingType, type TransformStep } from './mapping-model';
import { previewMapping } from './mapping-preview';

function context(
	protocol: 'oidc' | 'saml' = 'oidc',
	type: MappingType = 'string',
	namespace = protocol === 'saml' ? 'saml.attribute' : 'oidc.claim'
): MappingCodecContext {
	return {
		protocol,
		profileId: 'profile',
		sources: ['first', 'last', 'enabled'].map((key) => ({
			key,
			type: 'string',
			ref: {
				side: 'source',
				namespace: 'authrim.profile',
				path: key,
				catalogEntryId: `source.${key}`
			}
		})),
		targets: [
			{
				key: 'out',
				type,
				ref: {
					side: 'destination',
					namespace,
					profileId: 'profile',
					path: 'out',
					catalogEntryId: 'destination.out'
				}
			}
		]
	};
}
const step = (
	transform: TransformStep['transform'],
	params: TransformStep['params'] = {},
	id = transform
): TransformStep => {
	const initial = newStep(transform, id);
	return { ...initial, params: { ...initial.params, ...params } };
};
const mapping = (steps: TransformStep[] = [], sources = ['first']): Mapping => ({
	id: 'stable-rule',
	target: 'out',
	sources,
	steps
});
const content = (rule: MappingSetRule): MappingSetContent => ({
	catalogVersionId: 'catalog',
	compatibilityRange: '^1',
	sourceProfileIds: ['source-profile'],
	rules: [rule]
});
function roundTrip(value: Mapping, ctx = context()) {
	const saved = content(compileMapping(value, ctx));
	const read = decompileMappingSet(saved, ctx);
	expect(read).toEqual({ editable: true, mappings: [value] });
	if (!read.editable) throw new Error(read.reason);
	expect(compileMappingSet(saved, read.mappings, ctx)).toEqual(saved);
	return saved;
}
function graph(rule: MappingSetRule, ctx: MappingCodecContext): MappingRuleGraph {
	const transforms = (rule.transforms ?? []).map((item, index) => {
		const operation = stepOperation(item.operation);
		return { id: String(index), operation, inputs: item.inputs ?? [], parameters: item.parameters };
	});
	return {
		id: rule.ruleKey,
		targetRef: ctx.targets[0].ref,
		edges: (rule.edges ?? []).map((_, index) => ({
			id: String(index),
			sourceRef:
				ctx.sources.find((field) => field.ref.path === rule.edges?.[index].sourceRef.path)?.ref ??
				ctx.sources[0].ref,
			targetRef: ctx.targets[0].ref
		})),
		transforms,
		output: rule.output ?? { edgeIndex: 0 }
	};
}
function stepOperation(operation: string): MappingRuleGraph['transforms'][number]['operation'] {
	const supported = [
		'trim',
		'concat',
		'conditional',
		'default_if_empty',
		'json_build',
		'constant_text',
		'hash'
	];
	if (!supported.includes(operation)) throw new Error(operation);
	if (
		operation === 'trim' ||
		operation === 'concat' ||
		operation === 'conditional' ||
		operation === 'default_if_empty' ||
		operation === 'json_build' ||
		operation === 'constant_text' ||
		operation === 'hash'
	)
		return operation;
	throw new Error(operation);
}

describe('Mapping Set editor codec', () => {
	it.each(['oidc', 'saml'] satisfies ('oidc' | 'saml')[])(
		'round trips %s target refs and expands lanes before combining',
		(protocol) => {
			const ctx = context(protocol);
			const value = mapping(
				[
					step('trim'),
					step('case', { mode: 'lower' }),
					step('concat', { delimiter: ' ' }),
					step('affix_text', { prefix: '[', suffix: ']' })
				],
				['first', 'last']
			);
			const saved = roundTrip(value, ctx);
			expect(saved.rules[0].transforms?.map((item) => item.inputs)).toEqual([
				[{ edgeIndex: 0 }],
				[{ edgeIndex: 1 }],
				[{ stepIndex: 0 }],
				[{ stepIndex: 1 }],
				[{ stepIndex: 2 }, { stepIndex: 3 }],
				[{ stepIndex: 4 }]
			]);
			expect(saved.rules[0].metadata?.console).toMatchObject({
				stepIndexes: [[0, 1], [2, 3], [4], [5]]
			});
			expect(saved.rules[0].output).toEqual({ stepIndex: 5 });
		}
	);

	it('previews profile-backed JSON with the same edge naming as persisted runtime graphs', () => {
		const ctx = context('oidc', 'object');
		const value = mapping(
			[
				step('trim'),
				step('json_build', { keyMap: '{"destination.out":"item"}', nullHandling: 'omit' })
			],
			['first', 'last']
		);
		const rule = compileMapping(value, ctx);
		const samples = ctx.sources.map((field, index) => ({
			...field,
			example: index === 0 ? ' alpha ' : ' beta '
		}));
		const runtime = evaluateMappingRule({
			rule: graph(rule, ctx),
			edgeValueReferences: 'target',
			sourceValues: samples.map((field) => ({ sourceRef: field.ref, value: field.example }))
		});
		const preview = previewMapping(value, samples, { targetRef: ctx.targets[0].ref });
		expect(runtime.output).toMatchObject({
			kind: 'value',
			envelope: { value: { item: 'alpha', item_2: 'beta' } }
		});
		expect(preview?.output).toMatchObject({
			known: true,
			value: { item: 'alpha', item_2: 'beta' }
		});
	});
	it('rejects non-text identifier post-processing and cross-protocol identifier parameters', () => {
		const pid = step('persistent_identifier');
		expect(() => compileMapping(mapping([pid, step('hash')], []), context())).toThrow(
			'identifier_post_transform_not_allowed'
		);
		expect(() =>
			compileMapping(
				mapping([step('persistent_identifier', { audience: 'sp_entity_id' })], []),
				context()
			)
		).toThrow('release protocol');
	});
	it('preserves valid SAML NameID references without optional catalog IDs', () => {
		const ctx = context('saml', 'string', 'saml.nameid');
		delete ctx.targets[0].ref.catalogEntryId;
		delete ctx.sources[0].ref.catalogEntryId;
		const saved = roundTrip(mapping(), ctx);
		expect(saved.rules[0].targetRef).toEqual({
			side: 'destination',
			namespace: 'saml.nameid',
			profileId: 'profile',
			path: 'out'
		});
	});
	it('infers supported graphs without console metadata and preserves omitted defaults', () => {
		const ctx = context();
		const rule = compileMapping(mapping([step('trim')]), ctx);
		delete rule.metadata;
		delete rule.priority;
		const saved = content(rule);
		const decoded = decompileMappingSet(saved, ctx);
		expect(decoded.editable).toBe(true);
		if (!decoded.editable) throw new Error(decoded.reason);
		expect(compileMappingSet(saved, decoded.mappings, ctx)).toEqual(saved);
	});
	it.each([
		{ steps: [step('constant_text', { value: '' })], type: 'string' },
		{ steps: [step('constant_boolean', { value: 'false' })], type: 'boolean' },
		{ steps: [step('constant_number', { value: '-1.25' })], type: 'number' },
		{
			steps: [step('json_build', { keyMap: '{"first":"name"}', nullHandling: 'include_null' })],
			type: 'object',
			sources: ['first', 'last']
		},
		{
			steps: [
				step('json_extract_or', {
					path: 'nested[0]',
					defaultValue: 'fallback',
					nullAsMissing: true
				})
			],
			type: 'string',
			sources: ['first']
		},
		{
			steps: [step('array_build', { unique: true, omitEmpty: true })],
			type: 'string[]',
			sources: ['first', 'last']
		},
		{ steps: [step('hash', { encoding: 'base64url' })], type: 'string', sources: ['first'] }
	] satisfies { steps: TransformStep[]; type: MappingType; sources?: string[] }[])(
		'preserves typed/JSON/hash parameters: $steps.0.transform',
		({ steps, type, sources = [] }) => {
			const saved = roundTrip(mapping(steps, sources), context('oidc', type));
			if (steps[0].transform === 'constant_boolean')
				expect(saved.rules[0].transforms?.[0].parameters?.value).toBe(false);
			if (steps[0].transform === 'constant_number')
				expect(saved.rules[0].transforms?.[0].parameters?.value).toBe(-1.25);
			if (steps[0].transform === 'hash')
				expect(previewMapping(mapping(steps, sources), context().sources)?.output).toEqual({
					known: false
				});
		}
	);
	it('keeps named condition dependencies and absent values without releasing intermediate inputs', () => {
		const ctx = context();
		const condition = JSON.stringify({
			kind: 'group',
			match: 'all',
			children: [{ kind: 'rule', field: 'enabled', operator: 'eq', value: 'yes' }]
		});
		const value = mapping([
			step('conditional', {
				condition,
				valueType: 'as_text',
				thenValue: 'allowed',
				elseMode: 'as_is'
			}),
			step('default_if_empty', { value: 'empty' })
		]);
		const saved = roundTrip(value, ctx);
		expect(saved.rules[0].transforms?.[0].inputs).toEqual([
			{ edgeIndex: 0, name: 'value' },
			{ edgeIndex: 1, name: 'field:enabled' }
		]);
		const result = evaluateMappingRule({ rule: graph(saved.rules[0], ctx), sourceValues: [] });
		expect(result.output).toMatchObject({ kind: 'value', envelope: { value: 'empty' } });
		const broken = structuredClone(saved);
		broken.rules[0].transforms![0].inputs = [{ edgeIndex: 0, name: 'value' }];
		expect(decompileMappingSet(broken, ctx).editable).toBe(false);
		expect(() =>
			compileMapping(
				mapping([
					step('conditional', {
						condition: condition.replace('enabled', 'ambient'),
						thenValue: 'x'
					})
				]),
				ctx
			)
		).toThrow();
	});
	it.each([
		{ kind: 'rule', field: 'first', operator: 'exists', value: null },
		{
			kind: 'group',
			match: 'all',
			children: [{ kind: 'rule', field: 'first', operator: 'exists', value: null, future: true }]
		}
	])('refuses conditions the builder cannot preserve (%#)', (condition) => {
		expect(() =>
			compileMapping(
				mapping([
					step('conditional', { condition: JSON.stringify(condition), thenValue: 'value' })
				]),
				context()
			)
		).toThrow('condition');
	});
	it('stores only applicable identifier settings and preserves NameID IDs', () => {
		const ctx = context('saml', 'string', 'saml.nameid');
		const pid = step('persistent_identifier', {
			input: 'account',
			format: 'plain',
			algorithm: 'authrim_sha256',
			audience: 'sp_entity_id',
			stored: 'off',
			store: 'old-store',
			digest: 'SHA-256'
		});
		const saved = content(compileMapping(mapping([pid], []), ctx));
		expect(saved.rules[0].transforms?.[0].parameters).not.toHaveProperty('store');
		expect(saved.rules[0].transforms?.[0].parameters).not.toHaveProperty('digest');
		const decoded = decompileMappingSet(saved, ctx);
		expect(decoded.editable).toBe(true);
		if (!decoded.editable) throw new Error(decoded.reason);
		expect(decoded.mappings[0].steps[0].id).toBe(pid.id);
		expect(compileMappingSet(saved, decoded.mappings, ctx)).toEqual(saved);
		expect(() =>
			compileMapping(mapping([pid, step('conditional', { condition: '{}' })], []), ctx)
		).toThrow();
		expect(() =>
			compileMapping(
				mapping([step('persistent_identifier', { ...pid.params, audience: 'sector' })], []),
				ctx
			)
		).toThrow();
	});
	it('rejects identifier post-transforms outside the runtime allow-list', () => {
		const ctx = context();
		const pid = step('persistent_identifier');
		expect(() =>
			compileMapping(mapping([pid, step('hash', { encoding: 'hex' })], []), ctx)
		).toThrow('identifier_post_transform_not_allowed');
		expect(() =>
			compileMapping(mapping([pid, step('default_if_empty', { value: 'replacement' })], []), ctx)
		).toThrow('identifier_post_transform_not_allowed');
	});
	it('retains a condition dependency that reuses its value edge', () => {
		const ctx = context();
		const condition = JSON.stringify({
			kind: 'group',
			match: 'all',
			children: [{ kind: 'rule', field: 'first', operator: 'exists', value: null }]
		});
		const rule = compileMapping(
			mapping([step('conditional', { condition, thenValue: 'present' })]),
			ctx
		);
		expect(rule.transforms?.[0].inputs).toEqual([
			{ edgeIndex: 0, name: 'value' },
			{ edgeIndex: 0, name: 'field:first' }
		]);
		delete rule.metadata;
		const decoded = decompileMappingSet(content(rule), ctx);
		expect(decoded.editable).toBe(true);
		if (!decoded.editable) throw new Error(decoded.reason);
		expect(compileMappingSet(content(rule), decoded.mappings, ctx)).toEqual(content(rule));
	});
	it.each([
		(rule: MappingSetRule) => {
			rule.scope = { clientId: 'client' };
		},
		(rule: MappingSetRule) => {
			rule.condition = { all: [] };
		},
		(rule: MappingSetRule) => {
			rule.metadata = { future: true };
		},
		(rule: MappingSetRule) => {
			rule.metadata = { console: { version: 2 } };
		},
		(rule: MappingSetRule) => {
			rule.metadata = {
				console: { version: 1, mapping: mapping(), stepIndexes: [], future: true }
			};
		},
		(rule: MappingSetRule) => {
			rule.validationRules = [{ targetRef: {}, validationKind: 'required' }];
		},
		(rule: MappingSetRule) => {
			rule.releaseRules = [{ destinationType: 'oidc', sourceRef: {}, releaseAction: 'deny' }];
		},
		(rule: MappingSetRule) => {
			rule.conflictRules = [{ targetRef: {}, conflictStrategy: 'first' }];
		},
		(rule: MappingSetRule) => {
			rule.edges![0].targetRef.profileId = 'other';
		},
		(rule: MappingSetRule) => {
			rule.edges![0].sourceRef.catalogEntryId = 'other';
		},
		(rule: MappingSetRule) => {
			rule.transforms = [{ operation: 'trim', inputs: [{ stepIndex: 0 }] }];
		},
		(rule: MappingSetRule) => {
			rule.output = { edgeIndex: 99 };
		},
		(rule: MappingSetRule) => {
			rule.transforms = [
				{ operation: 'trim', inputs: [{ edgeIndex: 0 }], parameters: { future: true } }
			];
			rule.output = { stepIndex: 0 };
		}
	])('refuses unsupported or invalid persisted settings (%#)', (change) => {
		const saved = content(compileMapping(mapping(), context()));
		change(saved.rules[0]);
		const decoded = decompileMappingSet(saved, context());
		expect(decoded).toMatchObject({ editable: false, reason: expect.any(String) });
		expect(() => compileMappingSet(saved, [mapping()], context())).toThrow();
	});
	it('refuses a disconnected/lossy stored graph, altered console metadata and invalid typed constants', () => {
		const ctx = context();
		const saved = content(compileMapping(mapping([step('trim')]), ctx));
		saved.rules[0].output = { edgeIndex: 0 };
		expect(decompileMappingSet(saved, ctx).editable).toBe(false);
		for (const value of ['', 'NaN', 'Infinity'])
			expect(() =>
				compileMapping(mapping([step('constant_number', { value })], []), context('oidc', 'number'))
			).toThrow();
		const malformed = context();
		const badTarget = malformed.targets[0];
		badTarget.ref.profileId = 'other';
		expect(() => compileMapping(mapping(), malformed)).toThrow();
	});
});
