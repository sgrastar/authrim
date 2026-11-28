import { describe, expect, it } from 'vitest';
import { ApiError } from '#lib/api/api-error.js';
import {
	createFakeRebac,
	definition,
	sampleDefinitions
} from '#lib/api/fake/end-user-rebac-fake.js';
import { t } from '#lib/i18n/i18n.svelte.js';
import {
	EMPTY_CHECK_FORM,
	EMPTY_TUPLE_FORM,
	checkInputOf,
	checkProblems,
	definitionChanges,
	definitionDraftOf,
	definitionInputOf,
	definitionResult,
	describeExpression,
	draftToExpression,
	emptyDefinitionDraft,
	expressionProblems,
	exprToDraft,
	jsonIsDrawable,
	newExpr,
	rebacRefusal,
	relationNamesOf,
	resolvedViaKey,
	subjectOf,
	toJsonMode,
	toTreeMode,
	tupleInputOf,
	tupleProblems,
	withKind
} from './rebac-model';

const words = { or: 'or', and: 'and', butNot: 'but not' };
const direct = (relation: string) => ({ type: 'direct', relation });
const viewerExpression = sampleDefinitions().find(
	(entry) => entry.id === 'rd_doc_viewer'
)?.expression;

describe('relation expressions as a tree', () => {
	it('draws every kind and gives back what it was given', () => {
		const expressions = [
			direct('viewer'),
			{ type: 'union', children: [direct('a'), direct('b')] },
			{ type: 'intersection', children: [direct('a'), direct('b')] },
			{ type: 'exclusion', base: direct('a'), subtract: direct('b') },
			{
				type: 'tuple_to_userset',
				tupleset: { relation: 'parent' },
				computed_userset: { relation: 'viewer' }
			},
			viewerExpression
		];
		for (const expression of expressions) {
			const draft = exprToDraft(expression);
			expect(draft).not.toBeNull();
			expect(draftToExpression(draft!)).toEqual(expression);
		}
	});

	it('does not draw a shape it would change: unknown types, extra keys, wrong parts', () => {
		for (const expression of [
			null,
			'viewer',
			[],
			{ type: 'weighted', relation: 'a' },
			{ type: 'direct', relation: 'a', extra: true },
			{ type: 'direct' },
			{ type: 'union', children: 'a' },
			{ type: 'union', children: [direct('a'), { type: 'nope' }] },
			{ type: 'union', children: [], note: 'x' },
			{ type: 'exclusion', base: direct('a') },
			{ type: 'tuple_to_userset', tupleset: 'parent', computed_userset: { relation: 'v' } },
			{
				type: 'tuple_to_userset',
				tupleset: { relation: 'p', x: 1 },
				computed_userset: { relation: 'v' }
			}
		])
			expect(exprToDraft(expression)).toBeNull();
	});

	it('leaves expressions deeper than it draws as JSON', () => {
		let deep: unknown = direct('a');
		for (let level = 0; level < 12; level += 1) deep = { type: 'union', children: [deep] };
		expect(exprToDraft(deep)).toBeNull();
	});

	it('starts a union or an exclusion with the parts it needs', () => {
		expect(newExpr('union').children).toHaveLength(2);
		const exclusion = newExpr('exclusion');
		expect(exclusion.base?.kind).toBe('direct');
		expect(exclusion.subtract?.kind).toBe('direct');
	});

	it('keeps what a change of kind can keep', () => {
		const union = exprToDraft({ type: 'union', children: [direct('a'), direct('b')] })!;
		const asAll = withKind(union, 'intersection');
		expect(asAll.kind).toBe('intersection');
		expect(asAll.children.map((child) => child.relation)).toEqual(['a', 'b']);
		const asExclusion = withKind(union, 'exclusion');
		expect(asExclusion.base?.relation).toBe('a');
		expect(asExclusion.subtract?.relation).toBe('b');
		const single = withKind(newExpr('direct'), 'tuple_to_userset');
		expect(single.kind).toBe('tuple_to_userset');
		expect(withKind(union, 'union')).toBe(union);
	});

	it('says which node is wrong', () => {
		const draft = newExpr('union');
		draft.children[0].relation = 'ok';
		const problems = expressionProblems(draft);
		expect(problems[draft.children[1].key]).toBe('rb.expr.nameRequired');
		expect(problems[draft.children[0].key]).toBeUndefined();
		draft.children[1].relation = 'has space';
		expect(expressionProblems(draft)[draft.children[1].key]).toBe('rb.expr.nameInvalid');
		draft.children.splice(0, draft.children.length);
		expect(expressionProblems(draft)[draft.key]).toBe('rb.expr.childrenRequired');
		const edge = newExpr('tuple_to_userset');
		edge.tupleset = 'parent';
		expect(expressionProblems(edge)[edge.key]).toBe('rb.expr.nameRequired');
	});

	it('trims relation names it sends', () => {
		const draft = newExpr('direct');
		draft.relation = ' viewer ';
		expect(draftToExpression(draft)).toEqual(direct('viewer'));
	});

	it('writes an expression as one line', () => {
		expect(describeExpression(viewerExpression, words)).toBe('viewer or editor or parent → viewer');
		expect(
			describeExpression(
				{ type: 'exclusion', base: direct('viewer'), subtract: direct('blocked') },
				words
			)
		).toBe('viewer but not blocked');
		expect(
			describeExpression(
				{
					type: 'intersection',
					children: [direct('a'), { type: 'union', children: [direct('b'), direct('c')] }]
				},
				words
			)
		).toBe('a and (b or c)');
		expect(describeExpression({ type: 'weighted' }, words)).toBe('weighted');
		expect(describeExpression(null, words)).toBe('?');
	});
});

describe('the definition form', () => {
	it('is valid once the object type, the relation and every part are given', () => {
		const draft = emptyDefinitionDraft();
		expect(definitionResult(draft, true).input).toBeNull();
		expect(definitionResult(draft, true).problems).toMatchObject({
			object_type: 'rb.def.objectTypeRequired',
			relation_name: 'rb.def.relationRequired'
		});
		draft.object_type = 'document';
		draft.relation_name = 'viewer';
		draft.expression.relation = 'viewer';
		const done = definitionResult(draft, true);
		expect(done.input).toEqual({
			object_type: 'document',
			relation_name: 'viewer',
			expression: direct('viewer'),
			description: '',
			priority: 0,
			active: true
		});
	});

	it('refuses an object type with odd characters and a priority that is not whole', () => {
		const draft = emptyDefinitionDraft('my type');
		draft.relation_name = 'viewer';
		draft.expression.relation = 'viewer';
		draft.priority = 1.5;
		expect(definitionResult(draft, true).problems).toMatchObject({
			object_type: 'rb.def.objectTypeInvalid',
			priority: 'rb.def.priorityInvalid'
		});
		draft.priority = null;
		expect(definitionResult(draft, true).problems.priority).toBe('rb.def.priorityInvalid');
	});

	it('does not ask for the object type or the name of a saved definition', () => {
		const saved = definitionDraftOf(sampleDefinitions()[0]);
		expect(definitionResult(saved, false).input).not.toBeNull();
	});

	it('edits an expression the tree cannot draw as JSON, and takes it as it is', () => {
		const odd = definition('x', 'document', 'reviewer', { type: 'weighted', parts: [1] });
		const draft = definitionDraftOf(odd);
		expect(draft.jsonMode).toBe(true);
		expect(jsonIsDrawable(draft.json)).toBe(false);
		expect(toTreeMode(draft)).toBe(false);
		expect(definitionResult(draft, false).input?.expression).toEqual({
			type: 'weighted',
			parts: [1]
		});
		draft.json = '{ not json';
		expect(definitionResult(draft, false).problems.json).toBe('rb.def.jsonInvalid');
		draft.json = '[1]';
		expect(definitionResult(draft, false).problems.json).toBe('rb.def.jsonShape');
		draft.json = '{"parts": 1}';
		expect(definitionResult(draft, false).problems.json).toBe('rb.def.jsonShape');
	});

	it('moves between the tree and the JSON of what it draws', () => {
		const draft = definitionDraftOf(sampleDefinitions()[2]);
		expect(draft.jsonMode).toBe(false);
		toJsonMode(draft);
		expect(draft.jsonMode).toBe(true);
		expect(JSON.parse(draft.json)).toEqual(viewerExpression);
		expect(jsonIsDrawable(draft.json)).toBe(true);
		expect(toTreeMode(draft)).toBe(true);
		expect(draft.jsonMode).toBe(false);
		expect(draftToExpression(draft.expression)).toEqual(viewerExpression);
	});

	it('shows a stored expression it cannot read as JSON (null: an empty object)', () => {
		const broken = definition('b', 'document', 'reviewer', null, { unusable: true });
		const draft = definitionDraftOf(broken);
		expect(draft.jsonMode).toBe(true);
		expect(draft.json).toBe('{}');
		expect(definitionResult(draft, false).problems.json).toBe('rb.def.jsonShape');
	});

	it('sends only what changed, never the type or the name', () => {
		const saved = definitionInputOf(sampleDefinitions()[1]);
		expect(definitionChanges(saved, { ...saved })).toEqual({});
		expect(
			definitionChanges(saved, {
				...saved,
				object_type: 'other',
				relation_name: 'other',
				description: 'New',
				priority: 99,
				active: false,
				expression: direct('x')
			})
		).toEqual({ description: 'New', priority: 99, active: false, expression: direct('x') });
	});

	it('lists the relations a type declares, once and in order', () => {
		expect(relationNamesOf(sampleDefinitions(), 'document')).toEqual([
			'can_download',
			'editor',
			'owner',
			'viewer'
		]);
		expect(relationNamesOf(sampleDefinitions(), 'nothing')).toEqual([]);
	});
});

describe('the tuple form', () => {
	const filled = {
		...EMPTY_TUPLE_FORM,
		subject_id: 'usr_aiko',
		relation: 'viewer',
		to_type: 'document',
		to_id: 'doc_1'
	};

	it('asks for what the kind of subject needs', () => {
		expect(tupleProblems(EMPTY_TUPLE_FORM)).toMatchObject({
			subject_id: 'rb.tuple.userRequired',
			relation: 'rb.tuple.relationRequired',
			to_type: 'rb.tuple.typeRequired',
			to_id: 'rb.tuple.idRequired'
		});
		expect(tupleProblems({ ...EMPTY_TUPLE_FORM, kind: 'group' }).subject_id).toBe(
			'rb.tuple.groupRequired'
		);
		expect(tupleProblems({ ...EMPTY_TUPLE_FORM, kind: 'object' })).toMatchObject({
			object_type: 'rb.tuple.sourceTypeRequired',
			object_id: 'rb.tuple.sourceIdRequired'
		});
		expect(tupleProblems(filled)).toEqual({});
		expect(tupleProblems({ ...filled, relation: 'a b', to_type: 'x y' })).toMatchObject({
			relation: 'rb.tuple.relationRequired',
			to_type: 'rb.def.objectTypeInvalid'
		});
	});

	it('writes a user as a direct subject', () => {
		expect(tupleInputOf(filled, null)).toEqual({
			relation: 'viewer',
			from_type: 'subject',
			from_id: 'usr_aiko',
			to_type: 'document',
			to_id: 'doc_1',
			expires_at: null
		});
	});

	it('sends a subject id with colons as it is, never split', () => {
		const input = tupleInputOf({ ...filled, subject_id: 'team:alice' }, null);
		expect(input).toMatchObject({ from_type: 'subject', from_id: 'team:alice' });
		expect(
			tupleInputOf({ ...filled, kind: 'group', subject_id: 'org:eng:core' }, null)
		).toMatchObject({ from_id: 'org:eng:core', from_type: 'group' });
		expect(
			checkInputOf({
				user_id: 'team:alice',
				relation: 'viewer',
				object_type: 'doc',
				object_id: 'a:b'
			})
		).toMatchObject({ user_id: 'team:alice', object_id: 'a:b' });
		expect(
			checkProblems({ user_id: 'team:alice', relation: 'v', object_type: 't', object_id: 'i' })
		).toEqual({});
	});

	it('writes a group as all its members: from_type group, from_relation member', () => {
		expect(tupleInputOf({ ...filled, kind: 'group', subject_id: 'grp_eng' }, 1700)).toEqual({
			relation: 'viewer',
			from_type: 'group',
			from_id: 'grp_eng',
			from_relation: 'member',
			to_type: 'document',
			to_id: 'doc_1',
			expires_at: 1700
		});
	});

	it('writes an object edge from its own type and id', () => {
		expect(
			tupleInputOf(
				{
					...filled,
					kind: 'object',
					object_type: 'document',
					object_id: 'doc_1',
					relation: 'parent',
					to_type: 'folder',
					to_id: 'folder_a'
				},
				null
			)
		).toMatchObject({
			from_type: 'document',
			from_id: 'doc_1',
			relation: 'parent',
			to_type: 'folder',
			to_id: 'folder_a'
		});
	});

	it('names the subject of a stored tuple', () => {
		expect(subjectOf({ from_type: 'subject', from_id: 'u', from_relation: null })).toEqual({
			kind: 'user',
			label: 'u'
		});
		expect(subjectOf({ from_type: 'user', from_id: 'u', from_relation: null }).kind).toBe('user');
		expect(subjectOf({ from_type: 'group', from_id: 'g', from_relation: 'member' }).kind).toBe(
			'groupMembers'
		);
		expect(subjectOf({ from_type: 'group', from_id: 'g', from_relation: null }).kind).toBe('group');
		expect(subjectOf({ from_type: 'folder', from_id: 'f', from_relation: null })).toEqual({
			kind: 'object',
			label: 'folder:f'
		});
	});
});

describe('the check form', () => {
	it('asks for all four parts and trims them', () => {
		expect(checkProblems(EMPTY_CHECK_FORM)).toMatchObject({
			user_id: 'rb.check.userRequired',
			relation: 'rb.tuple.relationRequired',
			object_type: 'rb.tuple.typeRequired',
			object_id: 'rb.tuple.idRequired'
		});
		const form = {
			user_id: ' u ',
			relation: ' viewer ',
			object_type: ' document ',
			object_id: ' d '
		};
		expect(checkProblems(form)).toEqual({});
		expect(checkInputOf(form)).toEqual({
			user_id: 'u',
			relation: 'viewer',
			object_type: 'document',
			object_id: 'd'
		});
	});

	it('has a sentence for each way the engine resolved a check, and none for another', () => {
		for (const via of ['direct', 'computed', 'cache', 'closure', 'context', 'unknown_membership'])
			expect(resolvedViaKey(via)).toBe(`rb.via.${via}`);
		expect(resolvedViaKey('something_new')).toBeNull();
		expect(resolvedViaKey(null)).toBeNull();
	});

	it('explains an unknown membership as not “no groups”', () => {
		expect(t('rb.via.unknown_membership')).toMatch(/could not be read/);
	});
});

describe('what a refusal says', () => {
	const refused = (status: number, body: Record<string, unknown>) =>
		new ApiError(
			status,
			typeof body.error === 'string' ? body.error : '',
			String(body.error_description ?? ''),
			body
		);

	it('names a tuple kind the API does not take by its error code', () => {
		for (const field of ['error_code', 'code'])
			expect(
				rebacRefusal(refused(400, { error: 'invalid_request', [field]: 'AR050010' }), 'tuple').key
			).toBe('rb.error.tupleTypeNotAllowed');
	});

	it('falls back to the wording only when the answer has no code', () => {
		expect(
			rebacRefusal(
				refused(400, {
					error: 'invalid_request',
					error_description: 'Relationship tuple type not allowed'
				}),
				'tuple'
			).key
		).toBe('rb.error.tupleTypeNotAllowed');
		// Another code wins over the wording: a different refusal is not taken for this one.
		expect(
			rebacRefusal(
				refused(400, {
					error: 'invalid_request',
					error_code: 'AR060001',
					error_description: 'tuple type not allowed'
				}),
				'tuple'
			).key
		).not.toBe('rb.error.tupleTypeNotAllowed');
	});

	it('tells a repeat from another conflict by what was being changed', () => {
		expect(rebacRefusal(refused(409, { error: 'conflict' }), 'tuple').key).toBe(
			'rb.error.tupleExists'
		);
		expect(rebacRefusal(refused(409, { error: 'conflict' }), 'definition').key).toBe(
			'rb.error.definitionExists'
		);
	});

	it('keeps the API’s words for a malformed expression', () => {
		expect(
			rebacRefusal(
				refused(400, { error: 'invalid_request', error_description: 'definition.type is unknown' }),
				'definition'
			)
		).toEqual({ key: 'rb.error.definitionInvalid', detail: 'definition.type is unknown' });
	});

	it('says what a 403 is about, and leaves the platform switch to the shared wording', () => {
		expect(rebacRefusal(refused(403, { error: 'forbidden' }), 'check').key).toBe(
			'rb.error.forbidden'
		);
		expect(rebacRefusal(refused(403, { error: 'capability_disabled' }), 'tuple').key).toBe(
			'az.error.capability'
		);
		expect(rebacRefusal(new Error('x'), 'tuple').key).toBe('az.error.generic');
	});

	it('is what the fake API refuses too', async () => {
		const fake = createFakeRebac();
		const refusal = await fake
			.createTuple({
				relation: 'owner',
				from_type: 'document',
				from_id: 'd',
				to_type: 'folder',
				to_id: 'f'
			})
			.catch((error: unknown) => rebacRefusal(error, 'tuple'));
		expect(refusal).toEqual({ key: 'rb.error.tupleTypeNotAllowed' });
	});
});
