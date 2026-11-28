import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-error';
import {
	checkBody,
	checkFromBody,
	definitionBody,
	definitionFromRow,
	httpEndUserRebac,
	objectTypesFromBody,
	tupleBody,
	tupleFromRow
} from './end-user-rebac';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Call = [string, RequestInit];
function stub(body: unknown, status = 200) {
	const fetchMock = vi.fn(async () => json(body, status));
	vi.stubGlobal('fetch', fetchMock);
	return () => fetchMock.mock.calls as unknown as Call[];
}

describe('from the wire', () => {
	it('reads a tuple, its times as milliseconds and a group userset', () => {
		expect(
			tupleFromRow({
				id: 't',
				relationship_type: 'viewer',
				from_type: 'group',
				from_id: 'g',
				from_relation: 'member',
				to_type: 'folder',
				to_id: 'f',
				expires_at: 1_700_000_000,
				created_at: 1_700_000_000_000,
				permission_level: 'full'
			})
		).toEqual({
			id: 't',
			relation: 'viewer',
			from_type: 'group',
			from_id: 'g',
			from_relation: 'member',
			to_type: 'folder',
			to_id: 'f',
			expires_at: 1_700_000_000_000,
			created_at: 1_700_000_000_000
		});
		// An older API sends no from_relation and no expiry.
		expect(
			tupleFromRow({ id: 'u', relationship_type: 'owner', from_type: 'subject', from_id: 'x' })
		).toMatchObject({ from_relation: null, expires_at: null, relation: 'owner' });
	});

	it('marks a legacy group tuple the API says is inactive, and tolerates the flag missing', () => {
		const row = { id: 'l', relationship_type: 'viewer', from_type: 'group', from_id: 'g' };
		expect(tupleFromRow({ ...row, inactive_legacy: true }).inactiveLegacy).toBe(true);
		expect(tupleFromRow(row).inactiveLegacy).toBeUndefined();
		expect(tupleFromRow({ ...row, inactive_legacy: false }).inactiveLegacy).toBeUndefined();
	});

	it('keeps an expiry of 0 (long passed) and sends it, leaving out only none', () => {
		const row = { id: 't', relationship_type: 'v', from_type: 'subject', from_id: 'u' };
		expect(tupleFromRow({ ...row, expires_at: 0 }).expires_at).toBe(0);
		expect(tupleFromRow({ ...row, expires_at: null }).expires_at).toBeNull();
		expect(tupleFromRow(row).expires_at).toBeNull();
		const base = { relation: 'v', from_type: 'subject', from_id: 'u', to_type: 't', to_id: 'i' };
		expect(tupleBody({ ...base, expires_at: 0 })).toHaveProperty('expires_at', 0);
		expect(tupleBody({ ...base, expires_at: null })).not.toHaveProperty('expires_at');
		expect(tupleBody(base)).not.toHaveProperty('expires_at');
	});

	it('keeps an id with colons as it is, in a tuple and in a check', () => {
		expect(
			tupleBody({
				relation: 'viewer',
				from_type: 'subject',
				from_id: 'team:alice',
				to_type: 'document',
				to_id: 'a:b:c'
			})
		).toMatchObject({ from_id: 'team:alice', to_id: 'a:b:c' });
		expect(
			checkBody({ user_id: 'team:alice', relation: 'viewer', object_type: 'doc', object_id: 'x:y' })
		).toMatchObject({ subject_id: 'team:alice', object: 'x:y' });
	});

	it('reads a definition, marking an unusable one', () => {
		expect(
			definitionFromRow({
				id: 'd',
				object_type: 'document',
				relation_name: 'viewer',
				definition: { type: 'direct', relation: 'viewer' },
				description: '',
				priority: '7',
				is_active: 0,
				created_at: 1_700_000_000,
				updated_at: 1_700_000_000
			})
		).toEqual({
			id: 'd',
			object_type: 'document',
			relation_name: 'viewer',
			expression: { type: 'direct', relation: 'viewer' },
			description: null,
			priority: 7,
			active: false,
			unusable: false,
			created_at: 1_700_000_000_000,
			updated_at: 1_700_000_000_000
		});
		expect(definitionFromRow({ id: 'x', unusable: true, definition: null })).toMatchObject({
			unusable: true,
			expression: null,
			active: true
		});
	});

	it('reads the object types and drops nameless ones', () => {
		expect(
			objectTypesFromBody({
				object_types: [{ name: 'document', definition_count: 3 }, { definition_count: 1 }, 'x']
			})
		).toEqual([{ name: 'document', definition_count: 3 }]);
	});

	it('reads a check: how it was resolved, the path, the debug', () => {
		expect(
			checkFromBody({ allowed: false, resolved_via: 'unknown_membership', path: ['a', 1] })
		).toEqual({ allowed: false, resolved_via: 'unknown_membership', path: ['a'], debug: null });
		expect(checkFromBody({ allowed: true, debug: { depth: 2 } }).debug).toEqual({ depth: 2 });
		expect(() => checkFromBody({})).toThrow();
	});
});

describe('to the wire', () => {
	it('trims a tuple and leaves out what is empty', () => {
		expect(
			tupleBody({
				relation: ' viewer ',
				from_type: 'group',
				from_id: ' g ',
				from_relation: 'member',
				to_type: 'folder',
				to_id: ' f ',
				expires_at: null
			})
		).toEqual({
			relationship_type: 'viewer',
			from_type: 'group',
			from_id: 'g',
			from_relation: 'member',
			to_type: 'folder',
			to_id: 'f'
		});
		expect(
			tupleBody({
				relation: 'v',
				from_type: 'subject',
				from_id: 'u',
				to_type: 't',
				to_id: 'i',
				expires_at: 1234
			})
		).toEqual({
			relationship_type: 'v',
			from_type: 'subject',
			from_id: 'u',
			to_type: 't',
			to_id: 'i',
			expires_at: 1234
		});
	});

	it('names the definition and its expression as the API does, only what is given', () => {
		expect(
			definitionBody({ expression: { type: 'direct', relation: 'a' }, active: false })
		).toEqual({
			definition: { type: 'direct', relation: 'a' },
			is_active: false
		});
		expect(
			definitionBody({
				object_type: ' document ',
				relation_name: ' viewer ',
				description: ' d ',
				priority: 2
			})
		).toEqual({ object_type: 'document', relation_name: 'viewer', description: 'd', priority: 2 });
	});

	it('asks a check with the object and its type apart', () => {
		expect(
			checkBody({ user_id: ' u ', relation: ' viewer ', object_type: ' doc ', object_id: ' d ' })
		).toEqual({ subject_id: 'u', relation: 'viewer', object: 'd', object_type: 'doc' });
	});
});

describe('the HTTP client', () => {
	it('lists tuples with the filters under the API’s names, and sees the omitted flag', async () => {
		const calls = stub({
			tuples: [{ id: 't', relationship_type: 'viewer', from_type: 'subject', from_id: 'u' }],
			pagination: { page: 2, limit: 1, total: 5 },
			userset_subjects_omitted: true
		});
		const result = await httpEndUserRebac('t1').listTuples({
			object_type: 'document',
			relation: 'viewer',
			subject_id: 'u',
			page: 2,
			limit: 1
		});
		const url = new URL(calls()[0][0], 'http://x');
		expect(url.pathname).toBe('/api/admin/rebac/tuples');
		expect(Object.fromEntries(url.searchParams)).toEqual({
			to_type: 'document',
			relationship_type: 'viewer',
			from_id: 'u',
			page: '2',
			limit: '1'
		});
		expect(result).toMatchObject({
			total: 5,
			page: 2,
			hasNext: true,
			usersetOmitted: true,
			computedOmitted: false
		});
		expect(result.items).toHaveLength(1);
	});

	it('reads a list without the flag as complete', async () => {
		stub({ tuples: [], pagination: { page: 1, limit: 50, total: 0 } });
		const result = await httpEndUserRebac('t1').listTuples();
		expect(result.usersetOmitted).toBe(false);
		expect(result.computedOmitted).toBe(false);
	});

	it('sees the computed-relations flag', async () => {
		stub({
			tuples: [],
			pagination: { page: 1, limit: 50, total: 0 },
			computed_relations_omitted: true
		});
		expect((await httpEndUserRebac('t1').listTuples()).computedOmitted).toBe(true);
	});

	it('creates a tuple and returns the one the API stored', async () => {
		const calls = stub(
			{
				tuple: {
					id: 'new',
					relationship_type: 'viewer',
					from_type: 'group',
					from_id: 'g',
					from_relation: 'member'
				}
			},
			201
		);
		const created = await httpEndUserRebac('t1').createTuple({
			relation: 'viewer',
			from_type: 'group',
			from_id: 'g',
			from_relation: 'member',
			to_type: 'folder',
			to_id: 'f'
		});
		expect(created).toMatchObject({ id: 'new', from_relation: 'member' });
		const [url, init] = calls()[0];
		expect(url).toMatch(/\/api\/admin\/rebac\/tuples$/);
		expect(init.method).toBe('POST');
		expect(JSON.parse(String(init.body))).toMatchObject({
			from_type: 'group',
			from_relation: 'member'
		});
	});

	it('turns the refusal of a tuple kind into an error with the API’s code', async () => {
		stub(
			{ error: 'invalid_request', error_code: 'AR050010', error_description: 'not allowed' },
			400
		);
		const failure = await httpEndUserRebac('t1')
			.createTuple({
				relation: 'x',
				from_type: 'team',
				from_id: 'a',
				to_type: 'b',
				to_id: 'c'
			})
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ApiError);
		expect((failure as ApiError).status).toBe(400);
		expect((failure as ApiError).body.error_code).toBe('AR050010');
	});

	it('deletes a tuple by its id', async () => {
		const calls = stub({ success: true });
		await httpEndUserRebac('t1').removeTuple('a/b');
		const [url, init] = calls()[0];
		expect(url).toMatch(/\/tuples\/a%2Fb$/);
		expect(init.method).toBe('DELETE');
	});

	it('lists definitions with the filters, reading the unusable mark', async () => {
		const calls = stub({
			definitions: [{ id: 'd', object_type: 'document', relation_name: 'v', unusable: true }],
			pagination: { page: 1, limit: 20, total: 1 }
		});
		const result = await httpEndUserRebac('t1').listDefinitions({
			object_type: 'document',
			search: 'v',
			active: false
		});
		const url = new URL(calls()[0][0], 'http://x');
		expect(Object.fromEntries(url.searchParams)).toEqual({
			object_type: 'document',
			search: 'v',
			is_active: 'false'
		});
		expect(result.items[0].unusable).toBe(true);
	});

	it('creates, updates and deletes a definition', async () => {
		const calls = stub({ definition: { id: 'd', object_type: 'a', relation_name: 'b' } }, 201);
		const client = httpEndUserRebac('t1');
		expect(
			await client.createDefinition({
				object_type: 'a',
				relation_name: 'b',
				expression: { type: 'direct', relation: 'b' },
				description: '',
				priority: 0,
				active: true
			})
		).toMatchObject({ id: 'd' });
		await client.updateDefinition('d', { priority: 3 });
		await client.removeDefinition('d');
		const [create, update, remove] = calls();
		expect(create[1].method).toBe('POST');
		expect(JSON.parse(String(create[1].body))).toMatchObject({
			object_type: 'a',
			definition: { type: 'direct', relation: 'b' },
			is_active: true
		});
		expect(update[1].method).toBe('PUT');
		expect(JSON.parse(String(update[1].body))).toEqual({ priority: 3 });
		expect(remove[1].method).toBe('DELETE');
	});

	it('refuses a malformed definition answer instead of guessing', async () => {
		stub({ definition: {} }, 201);
		await expect(
			httpEndUserRebac('t1').createDefinition({
				object_type: 'a',
				relation_name: 'b',
				expression: {},
				description: '',
				priority: 0,
				active: true
			})
		).rejects.toThrow();
	});

	it('gets one definition, with or without its envelope', async () => {
		stub({ definition: { id: 'd', object_type: 'a', relation_name: 'b' } });
		expect((await httpEndUserRebac('t1').getDefinition('d')).id).toBe('d');
		stub({ id: 'e', object_type: 'a', relation_name: 'b' });
		expect((await httpEndUserRebac('t1').getDefinition('e')).id).toBe('e');
	});

	it('reads the object types', async () => {
		stub({ object_types: [{ name: 'document', definition_count: 2 }] });
		expect(await httpEndUserRebac('t1').objectTypes()).toEqual([
			{ name: 'document', definition_count: 2 }
		]);
	});

	it('checks with a POST of the question', async () => {
		const calls = stub({ allowed: true, resolved_via: 'direct', path: ['x'] });
		const result = await httpEndUserRebac('t1').check({
			user_id: 'u',
			relation: 'viewer',
			object_type: 'document',
			object_id: 'd'
		});
		expect(result).toEqual({ allowed: true, resolved_via: 'direct', path: ['x'], debug: null });
		const [url, init] = calls()[0];
		expect(url).toMatch(/\/api\/admin\/rebac\/check$/);
		expect(JSON.parse(String(init.body))).toEqual({
			subject_id: 'u',
			relation: 'viewer',
			object: 'd',
			object_type: 'document'
		});
	});

	it('turns a 403 into an error the page shows as “no access”', async () => {
		stub({ error: 'forbidden' }, 403);
		await expect(httpEndUserRebac('t1').listTuples()).rejects.toMatchObject({ status: 403 });
	});
});
