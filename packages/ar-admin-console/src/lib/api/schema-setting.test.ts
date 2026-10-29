import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-error';
import { createFakeSchemaSetting } from './fake/schema-setting-fake';
import { failureOf, httpSchemaSetting, listWindow, schemaFromRow } from './schema-setting';

const row = {
	id: 's1',
	tenant_id: 'acme',
	field_key: 'employee_id',
	display_label: 'Employee ID',
	field_type: 'string',
	cardinality: 'single',
	is_pii: 0,
	is_required: 1,
	is_active: 1,
	is_system: 0,
	validation_rules: '{"min_length":2}',
	required_scopes: null,
	scope_mode: 'any',
	is_searchable: 1,
	is_exportable: 0,
	is_vc_claim: 0,
	claim_namespace: null,
	description: null,
	display_order: 100,
	schema_version: 3,
	operation_status: 'error',
	operation_detail: '{"operation":"rename","old_key":"a","new_key":"b","error":"x"}',
	created_by: 'adm_1',
	created_at: 1_761_600_000,
	updated_at: 1_761_600_100,
	show_on_registration: 1,
	registration_required: 0,
	registration_order: 2,
	registration_placeholder: null,
	ui_group_key: 'workforce',
	ui_group_label: 'Workforce',
	ui_group_order: 40,
	ui_field_order: 10,
	examples_json: '{"values":["E1"]}',
	usage_bindings: [
		{
			id: 'derived:auth:email',
			binding_type: 'authentication_method',
			binding_id: 'auth',
			protection: 'delete_blocked',
			reason: null,
			source: 'derived'
		}
	],
	is_system_used: 1
};

describe('a schema from the API', () => {
	it('has real booleans, parsed JSON and time in milliseconds', () => {
		const schema = schemaFromRow(row);
		expect(schema).toMatchObject({
			fieldKey: 'employee_id',
			label: 'Employee ID',
			isPii: false,
			isRequired: true,
			isActive: true,
			isSystem: false,
			validation: { min_length: 2 },
			requiredScopes: [],
			isExportable: false,
			version: 3,
			status: 'error',
			createdAt: 1_761_600_000_000,
			groupKey: 'workforce',
			fieldOrder: 10,
			examples: { values: ['E1'] },
			inUse: true
		});
		expect(schema.operation).toMatchObject({ operation: 'rename', old_key: 'a', new_key: 'b' });
		expect(schema.usage[0]).toMatchObject({ protection: 'delete_blocked', source: 'derived' });
	});

	it('survives JSON it cannot read', () => {
		const schema = schemaFromRow({ ...row, validation_rules: '{oops', operation_detail: 'nope' });
		expect(schema.validation).toBeNull();
		expect(schema.operation).toBeNull();
	});
});

describe('a failure', () => {
	it('is told by what the page does about it', () => {
		const make = (status: number, body: Record<string, unknown>) =>
			new ApiError(status, String(body.error ?? ''), 'x', body);
		expect(failureOf(make(400, { error: 'invalid_request' })).kind).toBe('invalid');
		expect(
			failureOf(make(403, { error: 'forbidden', error_description: 'System claims' }))
		).toMatchObject({
			kind: 'forbidden',
			detail: 'System claims'
		});
		expect(failureOf(make(404, {})).kind).toBe('not_found');
		expect(failureOf(make(409, { error: 'invalid_request' })).kind).toBe('conflict');
		const inUse = failureOf(
			make(409, {
				error: 'field_in_use',
				usage_bindings: [{ id: 'b', binding_type: 'consent', protection: 'delete_blocked' }]
			})
		);
		expect(inUse.kind).toBe('in_use');
		expect(inUse.usage).toHaveLength(1);
		expect(
			failureOf(make(500, { success: false, error: 'Partial deletion: 2 failed' }))
		).toMatchObject({
			kind: 'partial',
			detail: 'Partial deletion: 2 failed'
		});
		expect(failureOf(make(500, { error: 'server_error' })).kind).toBe('failed');
		expect(failureOf(new Error('network')).kind).toBe('failed');
	});
});

describe('the requests', () => {
	afterEach(() => vi.restoreAllMocks());

	function respond(body: unknown) {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
		return fetchMock;
	}

	it('asks for a list with only the filters that were set, as 0 and 1', async () => {
		const fetchMock = respond({
			schemas: [],
			pagination: { page: 1, limit: 20, total: 0, total_pages: 0 }
		});
		await httpSchemaSetting.list('acme', {
			search: 'mail',
			isPii: true,
			isActive: false,
			limit: 20
		});
		const url = String(fetchMock.mock.calls[0][0]);
		expect(url).toContain('/api/admin/custom-claims?');
		expect(url).toContain('search=mail');
		expect(url).toContain('is_pii=1');
		expect(url).toContain('is_active=0');
		expect(url).not.toContain('is_system');
	});

	it('sends only what changed, in the API’s keys', async () => {
		const fetchMock = respond({ schema: row });
		await httpSchemaSetting.update('acme', 's1', {
			label: 'New',
			isRequired: false,
			validation: null
		});
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect(init.method).toBe('PUT');
		expect(JSON.parse(String(init.body))).toEqual({
			display_label: 'New',
			is_required: false,
			validation_rules: null
		});
	});

	it('renames with the new key', async () => {
		const fetchMock = respond({ schema: row, affected_users: 4, old_key: 'a', new_key: 'b' });
		const result = await httpSchemaSetting.rename('acme', 's1', 'b');
		const init = fetchMock.mock.calls[0][1] as RequestInit;
		expect(init.method).toBe('PATCH');
		expect(JSON.parse(String(init.body))).toEqual({ new_field_key: 'b' });
		expect(result).toMatchObject({ affectedUsers: 4, oldKey: 'a', newKey: 'b' });
	});
});

describe('a window of the list', () => {
	it('refuses a size that is not whole chunks', async () => {
		await expect(
			listWindow(createFakeSchemaSetting(), 'acme', {}, { page: 2, size: 75 })
		).rejects.toBeInstanceOf(RangeError);
	});

	it('shows a row once when the list shifted between two chunks, and reads again first', async () => {
		const client = createFakeSchemaSetting({ extra: 120 });
		let calls = 0;
		const shifting: typeof client = {
			...client,
			list: async (tenant, query, signal) => {
				const mine = (calls += 1);
				const part = await client.list(tenant, query, signal);
				// The first time round, the second chunk starts with the last row of the first.
				return mine === 2
					? { ...part, schemas: [...part.schemas.slice(0, 1), ...part.schemas] }
					: part;
			}
		};
		const window = await listWindow(shifting, 'acme', {}, { page: 1, size: 250 });
		const ids = window.schemas.map((schema) => schema.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(calls).toBeGreaterThan(3);
	});

	it('puts a window together from the API\u2019s smaller pages', async () => {
		const client = createFakeSchemaSetting();
		const all = await client.list('acme', { limit: 100 });
		const seen: number[] = [];
		const spy: typeof client = {
			...client,
			list: async (tenant, query, signal) => {
				seen.push(query?.limit ?? 0);
				return client.list(tenant, query, signal);
			}
		};
		const window = await listWindow(spy, 'acme', {}, { page: 1, size: 250 });
		expect(window.schemas.map((schema) => schema.id)).toEqual(
			all.schemas.map((schema) => schema.id)
		);
		expect(window.total).toBe(all.total);
		expect(window.limit).toBe(250);
		expect(window.totalPages).toBe(1);
		// Never more than the API gives at once.
		expect(Math.max(...seen)).toBeLessThanOrEqual(100);
	});

	it('holds a page of 250 when there are more, and the rest on the next', async () => {
		const client = createFakeSchemaSetting({ extra: 300 });
		const first = await listWindow(client, 'acme', {}, { page: 1, size: 250 });
		const second = await listWindow(client, 'acme', {}, { page: 2, size: 250 });
		expect(first.schemas).toHaveLength(250);
		expect(first.total).toBe(313);
		expect(first.totalPages).toBe(2);
		expect(second.schemas).toHaveLength(63);
		const ids = [...first.schemas, ...second.schemas].map((schema) => schema.id);
		expect(new Set(ids).size).toBe(313);
	});

	it('takes the second window from the right place', async () => {
		const client = createFakeSchemaSetting();
		const all = await client.list('acme', { limit: 100 });
		const window = await listWindow(client, 'acme', {}, { page: 2, size: 5 });
		expect(window.schemas.map((schema) => schema.id)).toEqual(
			all.schemas.slice(5, 10).map((schema) => schema.id)
		);
		expect(window.totalPages).toBe(Math.ceil(all.total / 5));
	});
});
