import { describe, expect, it } from 'vitest';
import {
	MAX_DIRECT_RELATIONS,
	MAX_EXPRESSION_DEPTH,
	createFakeRebac,
	expressionProblem,
	sampleDefinitions
} from './end-user-rebac-fake';

const check = (
	fake: ReturnType<typeof createFakeRebac>,
	user_id: string,
	relation: string,
	object_type: string,
	object_id: string
) => fake.check({ user_id, relation, object_type, object_id });

describe('the fake relationships API', () => {
	it('follows a union and a path to another object, and says it was computed', async () => {
		const fake = createFakeRebac();
		// usr_aiko is in grp_eng, whose members view folder_a, which is the parent of doc_1 (document#parent → folder).
		const result = await check(fake, 'usr_aiko', 'viewer', 'document', 'doc_1');
		expect(result).toMatchObject({ allowed: true, resolved_via: 'computed' });
		expect(result.path.length).toBeGreaterThan(0);
	});

	it('answers a direct tuple on a relation with no definition as direct', async () => {
		const fake = createFakeRebac({ definitions: [] });
		expect(await check(fake, 'usr_aiko', 'owner', 'document', 'doc_1')).toMatchObject({
			allowed: true,
			resolved_via: 'direct'
		});
		expect(await check(fake, 'usr_ben', 'owner', 'document', 'doc_1')).toMatchObject({
			allowed: false
		});
	});

	it('follows declared paths only: no definition, no inheritance from the folder', async () => {
		const fake = createFakeRebac({ definitions: [] });
		expect((await check(fake, 'usr_aiko', 'viewer', 'document', 'doc_1')).allowed).toBe(false);
	});

	it('applies an exclusion: the blocked user is out although a viewer', async () => {
		const fake = createFakeRebac();
		await fake.createTuple({
			relation: 'viewer',
			from_type: 'subject',
			from_id: 'usr_chen',
			to_type: 'document',
			to_id: 'doc_1'
		});
		expect((await check(fake, 'usr_chen', 'viewer', 'document', 'doc_1')).allowed).toBe(true);
		expect((await check(fake, 'usr_chen', 'can_download', 'document', 'doc_1')).allowed).toBe(
			false
		);
		await fake.createTuple({
			relation: 'viewer',
			from_type: 'subject',
			from_id: 'usr_ben',
			to_type: 'document',
			to_id: 'doc_1'
		});
		expect((await check(fake, 'usr_ben', 'can_download', 'document', 'doc_1')).allowed).toBe(true);
	});

	it('follows the edge from the child to its parent, not the other way', async () => {
		const fake = createFakeRebac();
		// A tuple pointing the wrong way (folder → document) grants nothing on the document.
		const wrong = createFakeRebac({
			tuples: [
				{
					id: 'x',
					relation: 'parent',
					from_type: 'folder',
					from_id: 'folder_a',
					from_relation: null,
					to_type: 'document',
					to_id: 'doc_1',
					expires_at: null,
					created_at: null
				},
				{
					id: 'y',
					relation: 'viewer',
					from_type: 'subject',
					from_id: 'usr_chen',
					from_relation: null,
					to_type: 'folder',
					to_id: 'folder_a',
					expires_at: null,
					created_at: null
				}
			]
		});
		expect((await check(wrong, 'usr_chen', 'viewer', 'document', 'doc_1')).allowed).toBe(false);
		expect((await check(fake, 'usr_ben', 'viewer', 'document', 'doc_1')).allowed).toBe(true);
	});

	it('denies a whole exclusion when memberships on its subtract side are unknown', async () => {
		const exclusion = {
			type: 'exclusion',
			base: { type: 'direct', relation: 'viewer' },
			subtract: { type: 'direct', relation: 'blocked' }
		};
		const fake = createFakeRebac({
			definitions: [
				{
					id: 'rd_x',
					object_type: 'document',
					relation_name: 'can_download',
					expression: exclusion,
					description: null,
					priority: 0,
					active: true,
					unusable: false,
					created_at: null,
					updated_at: null
				}
			],
			tuples: [
				{
					id: 't1',
					relation: 'viewer',
					from_type: 'subject',
					from_id: 'usr_unknown',
					from_relation: null,
					to_type: 'document',
					to_id: 'doc_1',
					expires_at: null,
					created_at: null
				},
				{
					id: 't2',
					relation: 'blocked',
					from_type: 'group',
					from_id: 'grp_blocked',
					from_relation: 'member',
					to_type: 'document',
					to_id: 'doc_1',
					expires_at: null,
					created_at: null
				}
			]
		});
		// The viewer tuple holds, but whether the user is blocked cannot be told: deny.
		expect(await check(fake, 'usr_unknown', 'can_download', 'document', 'doc_1')).toMatchObject({
			allowed: false,
			resolved_via: 'unknown_membership'
		});
		// A user whose groups are known is simply not blocked.
		const known = createFakeRebac({ unknownMembershipUsers: [] });
		await known.createTuple({
			relation: 'viewer',
			from_type: 'subject',
			from_id: 'usr_chen',
			to_type: 'document',
			to_id: 'doc_5'
		});
		expect((await check(known, 'usr_chen', 'can_download', 'document', 'doc_5')).allowed).toBe(
			true
		);
	});

	it('denies for an unusable definition even when a direct tuple exists', async () => {
		const fake = createFakeRebac();
		expect((await check(fake, 'usr_aiko', 'owner', 'document', 'doc_1')).allowed).toBe(true);
		const broken = createFakeRebac({
			definitions: [
				{
					id: 'rd_b',
					object_type: 'document',
					relation_name: 'owner',
					expression: null,
					description: null,
					priority: 0,
					active: true,
					unusable: true,
					created_at: null,
					updated_at: null
				}
			]
		});
		expect(await check(broken, 'usr_aiko', 'owner', 'document', 'doc_1')).toMatchObject({
			allowed: false,
			resolved_via: null
		});
	});

	it('does not take an unusable definition reached through another one for false', async () => {
		const stamp = { description: null, priority: 0, created_at: null, updated_at: null };
		const defs = [
			{
				...stamp,
				id: 'a',
				object_type: 'document',
				relation_name: 'viewer',
				expression: {
					type: 'tuple_to_userset',
					tupleset: { relation: 'parent' },
					computed_userset: { relation: 'viewer' }
				},
				active: true,
				unusable: false
			},
			{
				...stamp,
				id: 'b',
				object_type: 'folder',
				relation_name: 'viewer',
				expression: null,
				active: true,
				unusable: true
			},
			{
				...stamp,
				id: 'c',
				object_type: 'document',
				relation_name: 'can_download',
				expression: {
					type: 'exclusion',
					base: { type: 'direct', relation: 'owner' },
					subtract: {
						type: 'tuple_to_userset',
						tupleset: { relation: 'parent' },
						computed_userset: { relation: 'viewer' }
					}
				},
				active: true,
				unusable: false
			}
		];
		const fake = createFakeRebac({ definitions: defs });
		// Through the path to the folder: not false, unknown — the answer says why.
		expect(await check(fake, 'usr_aiko', 'viewer', 'document', 'doc_1')).toMatchObject({
			allowed: false,
			resolved_via: 'unknown_membership'
		});
		// Inside the subtract side: the whole exclusion denies, although usr_aiko owns doc_1.
		expect(await check(fake, 'usr_aiko', 'can_download', 'document', 'doc_1')).toMatchObject({
			allowed: false,
			resolved_via: 'unknown_membership'
		});
	});

	it('evaluates every branch as allow, deny or unknown', async () => {
		const stamp = {
			description: null,
			priority: 0,
			active: true,
			unusable: false,
			created_at: null,
			updated_at: null
		};
		const direct = (relation: string) => ({ type: 'direct', relation });
		// “group” holds for nobody known: its members cannot be read for usr_unknown.
		const unknownTuple = {
			id: 'g1',
			relation: 'team',
			from_type: 'group',
			from_id: 'grp_x',
			from_relation: 'member',
			to_type: 'document',
			to_id: 'd',
			expires_at: null,
			created_at: null
		};
		const own = (id: string, relation: string) => ({
			...unknownTuple,
			id,
			relation,
			from_type: 'subject',
			from_id: 'usr_unknown',
			from_relation: null
		});
		const fake = createFakeRebac({
			tuples: [unknownTuple, own('o1', 'owner')],
			definitions: [
				{
					...stamp,
					id: '1',
					object_type: 'document',
					relation_name: 'u_any',
					expression: { type: 'union', children: [direct('team'), direct('owner')] }
				},
				{
					...stamp,
					id: '2',
					object_type: 'document',
					relation_name: 'u_unknown',
					expression: { type: 'union', children: [direct('team'), direct('nothing')] }
				},
				{
					...stamp,
					id: '3',
					object_type: 'document',
					relation_name: 'i_deny',
					expression: { type: 'intersection', children: [direct('team'), direct('nothing')] }
				},
				{
					...stamp,
					id: '4',
					object_type: 'document',
					relation_name: 'i_unknown',
					expression: { type: 'intersection', children: [direct('team'), direct('owner')] }
				},
				{
					...stamp,
					id: '5',
					object_type: 'document',
					relation_name: 'x_base_deny',
					expression: { type: 'exclusion', base: direct('nothing'), subtract: direct('team') }
				},
				{
					...stamp,
					id: '6',
					object_type: 'document',
					relation_name: 'x_subtract_allow',
					expression: { type: 'exclusion', base: direct('owner'), subtract: direct('owner') }
				},
				{
					...stamp,
					id: '7',
					object_type: 'document',
					relation_name: 'x_subtract_unknown',
					expression: { type: 'exclusion', base: direct('owner'), subtract: direct('team') }
				},
				{
					...stamp,
					id: '8',
					object_type: 'document',
					relation_name: 'x_allow',
					expression: { type: 'exclusion', base: direct('owner'), subtract: direct('nothing') }
				}
			]
		});
		const ask = (relation: string) => check(fake, 'usr_unknown', relation, 'document', 'd');
		expect(await ask('u_any')).toMatchObject({ allowed: true });
		expect(await ask('u_unknown')).toMatchObject({
			allowed: false,
			resolved_via: 'unknown_membership'
		});
		expect(await ask('i_deny')).toMatchObject({ allowed: false, resolved_via: null });
		expect(await ask('i_unknown')).toMatchObject({
			allowed: false,
			resolved_via: 'unknown_membership'
		});
		expect(await ask('x_base_deny')).toMatchObject({ allowed: false, resolved_via: null });
		expect(await ask('x_subtract_allow')).toMatchObject({ allowed: false, resolved_via: null });
		expect(await ask('x_subtract_unknown')).toMatchObject({
			allowed: false,
			resolved_via: 'unknown_membership'
		});
		expect(await ask('x_allow')).toMatchObject({ allowed: true });
	});

	it('ignores an inactive unusable definition, like the engine', async () => {
		const fake = createFakeRebac({
			definitions: [
				{
					id: 'r',
					object_type: 'document',
					relation_name: 'owner',
					expression: null,
					description: null,
					priority: 0,
					active: false,
					unusable: true,
					created_at: null,
					updated_at: null
				}
			]
		});
		// Inactive: the relation counts its own tuples, as with no definition.
		expect(await check(fake, 'usr_aiko', 'owner', 'document', 'doc_1')).toMatchObject({
			allowed: true,
			resolved_via: 'direct'
		});
	});

	it('takes a cycle for unknown, so an exclusion that subtracts it denies', async () => {
		const stamp = {
			description: null,
			priority: 0,
			active: true,
			unusable: false,
			created_at: null,
			updated_at: null
		};
		const loop = {
			type: 'tuple_to_userset',
			tupleset: { relation: 'parent' },
			computed_userset: { relation: 'viewer' }
		};
		const edge = (id: string, from: string, to: string) => ({
			id,
			relation: 'parent',
			from_type: 'node',
			from_id: from,
			from_relation: null,
			to_type: 'node',
			to_id: to,
			expires_at: null,
			created_at: null
		});
		const fake = createFakeRebac({
			// a → b → a: following parents never ends.
			tuples: [
				edge('e1', 'a', 'b'),
				edge('e2', 'b', 'a'),
				{
					...edge('o', 'x', 'x'),
					relation: 'owner',
					from_type: 'subject',
					from_id: 'usr_aiko',
					to_id: 'a'
				}
			],
			definitions: [
				{ ...stamp, id: '1', object_type: 'node', relation_name: 'viewer', expression: loop },
				{
					...stamp,
					id: '2',
					object_type: 'node',
					relation_name: 'can_edit',
					expression: {
						type: 'exclusion',
						base: { type: 'direct', relation: 'owner' },
						subtract: loop
					}
				}
			]
		});
		expect(await check(fake, 'usr_aiko', 'viewer', 'node', 'a')).toMatchObject({
			allowed: false,
			resolved_via: 'unknown_membership'
		});
		expect(await check(fake, 'usr_aiko', 'can_edit', 'node', 'a')).toMatchObject({
			allowed: false,
			resolved_via: 'unknown_membership'
		});
	});

	it('refuses a definition with too many relations or too deep, on create and update', async () => {
		const fake = createFakeRebac();
		const wide = {
			type: 'union',
			children: Array.from({ length: MAX_DIRECT_RELATIONS + 1 }, (_, index) => ({
				type: 'direct',
				relation: `r${index}`
			}))
		};
		const nested = (levels: number): unknown => {
			let node: unknown = { type: 'direct', relation: 'a' };
			for (let level = 0; level < levels; level += 1) node = { type: 'union', children: [node] };
			return node;
		};
		// The root is level 0: 32 unions around a leaf are accepted, 33 are not.
		const deep = nested(MAX_EXPRESSION_DEPTH + 1);
		await expect(
			fake.createDefinition({
				object_type: 'folder',
				relation_name: 'just_fits',
				description: '',
				priority: 0,
				active: true,
				expression: nested(MAX_EXPRESSION_DEPTH)
			})
		).resolves.toMatchObject({ relation_name: 'just_fits' });
		const base = { object_type: 'folder', description: '', priority: 0, active: true };
		for (const expression of [wide, deep])
			await expect(
				fake.createDefinition({ ...base, relation_name: 'too_much', expression })
			).rejects.toMatchObject({ status: 400, body: { error: 'invalid_request' } });
		await expect(
			fake.updateDefinition('rd_folder_owner', { expression: wide })
		).rejects.toMatchObject({ status: 400 });
		await expect(
			fake.updateDefinition('rd_folder_owner', { expression: deep })
		).rejects.toMatchObject({ status: 400 });
		// The same relation named many times counts once; the limit is on distinct ones.
		const repeated = {
			type: 'union',
			children: Array.from({ length: 200 }, () => ({ type: 'direct', relation: 'same' }))
		};
		await expect(
			fake.createDefinition({ ...base, relation_name: 'fine', expression: repeated })
		).resolves.toMatchObject({ relation_name: 'fine' });
	});

	it('takes an object edge only from an active, readable definition of its source', async () => {
		const edge = {
			relation: 'parent',
			from_type: 'document',
			from_id: 'doc_9',
			to_type: 'folder',
			to_id: 'folder_b'
		};
		await expect(createFakeRebac().createTuple(edge)).resolves.toMatchObject({
			id: expect.any(String)
		});
		const sample = sampleDefinitions();
		for (const change of [{ active: false }, { unusable: true }]) {
			const fake = createFakeRebac({
				definitions: sample.map((entry) =>
					entry.id === 'rd_doc_viewer' ? { ...entry, ...change } : { ...entry }
				)
			});
			await expect(fake.createTuple(edge)).rejects.toMatchObject({
				status: 400,
				body: { error_code: 'AR050010' }
			});
		}
	});

	it('says when the list left out computed relations', async () => {
		expect((await createFakeRebac().listTuples()).computedOmitted).toBe(false);
		expect((await createFakeRebac({ computedOmitted: true }).listTuples()).computedOmitted).toBe(
			true
		);
	});

	it('does not count an expired tuple', async () => {
		const fake = createFakeRebac();
		await fake.createTuple({
			relation: 'viewer',
			from_type: 'subject',
			from_id: 'usr_zed',
			to_type: 'document',
			to_id: 'doc_7',
			expires_at: Date.UTC(2020, 0, 1)
		});
		expect((await check(fake, 'usr_zed', 'viewer', 'document', 'doc_7')).allowed).toBe(false);
	});

	it('denies, and says why, when group memberships cannot be read', async () => {
		const fake = createFakeRebac();
		expect(await check(fake, 'usr_unknown', 'viewer', 'folder', 'folder_a')).toEqual({
			allowed: false,
			resolved_via: 'unknown_membership',
			path: [],
			debug: null
		});
		// A user whose groups are known is simply not in the group: no such reason.
		expect((await check(fake, 'usr_chen', 'viewer', 'folder', 'folder_a')).resolved_via).toBeNull();
	});

	it('returns debug when asked to', async () => {
		const result = await check(
			createFakeRebac({ withDebug: true }),
			'usr_aiko',
			'owner',
			'document',
			'doc_1'
		);
		expect(result.debug).not.toBeNull();
	});

	it('takes the tuple kinds the API takes and refuses the rest with its code', async () => {
		const fake = createFakeRebac();
		await expect(
			fake.createTuple({
				relation: 'editor',
				from_type: 'group',
				from_id: 'grp_eng',
				from_relation: 'member',
				to_type: 'document',
				to_id: 'doc_9'
			})
		).resolves.toMatchObject({ from_relation: 'member' });
		await expect(
			fake.createTuple({
				relation: 'parent',
				from_type: 'document',
				from_id: 'doc_9',
				to_type: 'folder',
				to_id: 'folder_b'
			})
		).resolves.toMatchObject({ from_type: 'document', to_type: 'folder' });
		// A group without “member”, and an object edge no definition follows.
		for (const input of [
			{ from_type: 'group', from_id: 'grp_eng', relation: 'viewer' },
			// Not a relation the document's definitions follow.
			{ from_type: 'document', from_id: 'doc_9', relation: 'owner' },
			// Declared on the document, not on the folder: the edge is judged by its source.
			{ from_type: 'folder', from_id: 'folder_b', relation: 'parent' }
		])
			await expect(
				fake.createTuple({ ...input, to_type: 'folder', to_id: 'folder_b' })
			).rejects.toMatchObject({ status: 400, body: { error_code: 'AR050010' } });
	});

	it('refuses a tuple that exists, also under the older “user” kind', async () => {
		const fake = createFakeRebac();
		const again = {
			relation: 'owner',
			from_type: 'user',
			from_id: 'usr_aiko',
			to_type: 'document',
			to_id: 'doc_1'
		};
		await expect(fake.createTuple(again)).rejects.toMatchObject({ status: 409 });
	});

	it('filters and pages tuples', async () => {
		const fake = createFakeRebac();
		expect((await fake.listTuples({ object_type: 'folder' })).items).toHaveLength(2);
		expect((await fake.listTuples({ relation: 'viewer' })).total).toBe(2);
		expect((await fake.listTuples({ subject_id: 'usr_ben' })).items[0].to_id).toBe('doc_2');
		const first = await fake.listTuples({ limit: 2 });
		expect(first).toMatchObject({ total: 5, hasNext: true });
		expect(first.items).toHaveLength(2);
	});

	it('deletes a tuple and says when it is gone', async () => {
		const fake = createFakeRebac();
		await fake.removeTuple('rt_1');
		expect((await fake.listTuples()).items.some((entry) => entry.id === 'rt_1')).toBe(false);
		await expect(fake.removeTuple('rt_1')).rejects.toMatchObject({ status: 404 });
	});

	it('validates an expression as the API does, and refuses a relation defined twice', async () => {
		const fake = createFakeRebac();
		const input = {
			object_type: 'folder',
			relation_name: 'editor',
			description: '',
			priority: 0,
			active: true
		};
		await expect(
			fake.createDefinition({ ...input, expression: { type: 'union', children: [] } })
		).rejects.toMatchObject({ status: 400 });
		await expect(
			fake.createDefinition({ ...input, expression: { type: 'weighted' } })
		).rejects.toMatchObject({ status: 400 });
		const created = await fake.createDefinition({
			...input,
			expression: { type: 'direct', relation: 'editor' }
		});
		expect(created.id).toMatch(/^rd_new_/);
		await expect(
			fake.createDefinition({ ...input, expression: { type: 'direct', relation: 'editor' } })
		).rejects.toMatchObject({ status: 409 });
	});

	it('updates a definition and repairs an unusable one by a new expression', async () => {
		const fake = createFakeRebac({
			definitions: [
				{
					id: 'rd_b',
					object_type: 'document',
					relation_name: 'reviewer',
					expression: null,
					description: null,
					priority: 0,
					active: true,
					unusable: true,
					created_at: null,
					updated_at: null
				}
			]
		});
		expect((await fake.getDefinition('rd_b')).unusable).toBe(true);
		await fake.updateDefinition('rd_b', { expression: { type: 'direct', relation: 'reviewer' } });
		const repaired = await fake.getDefinition('rd_b');
		expect(repaired.unusable).toBe(false);
		expect(repaired.expression).toEqual({ type: 'direct', relation: 'reviewer' });
		await expect(
			fake.updateDefinition('rd_b', { expression: { type: 'x' } })
		).rejects.toMatchObject({
			status: 400
		});
		await expect(fake.updateDefinition('gone', { priority: 1 })).rejects.toMatchObject({
			status: 404
		});
	});

	it('does not evaluate an unusable or inactive definition', async () => {
		const fake = createFakeRebac();
		await fake.updateDefinition('rd_doc_viewer', { active: false });
		// Without the definition the relation is only its own tuples: no inheritance from the folder.
		expect((await check(fake, 'usr_aiko', 'viewer', 'document', 'doc_1')).allowed).toBe(false);
	});

	it('lists definitions by type, search and state, and counts object types', async () => {
		const fake = createFakeRebac();
		expect((await fake.listDefinitions({ object_type: 'folder' })).total).toBe(2);
		expect((await fake.listDefinitions({ search: 'download' })).items[0].relation_name).toBe(
			'can_download'
		);
		await fake.updateDefinition('rd_doc_owner', { active: false });
		expect((await fake.listDefinitions({ active: false })).total).toBe(1);
		expect(await fake.objectTypes()).toEqual([
			{ name: 'document', definition_count: 4 },
			{ name: 'folder', definition_count: 2 }
		]);
	});

	it('fails a call on request', async () => {
		const fake = createFakeRebac({ failOn: { listTuples: 500, check: 403 } });
		await expect(fake.listTuples()).rejects.toMatchObject({ status: 500 });
		await expect(check(fake, 'u', 'r', 't', 'i')).rejects.toMatchObject({ status: 403 });
	});

	it('explains what is wrong with an expression', () => {
		expect(expressionProblem({ type: 'direct', relation: 'a' })).toBeNull();
		expect(expressionProblem(null)).toMatch(/object/);
		expect(
			expressionProblem({
				type: 'exclusion',
				base: { type: 'direct' },
				subtract: { type: 'direct' }
			})
		).toMatch(/base\.relation/);
	});
});
