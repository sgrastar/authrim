import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpAdminRoles, roleAssignmentFromRow, roleDefinitionFromRow } from './admin-roles';
import { hasAdminPermission } from '@authrim/ar-lib-core/types/admin-user';
import { StepUpCancelledError } from './admin-step-up';
import { ApiError, ConflictError } from './api-error';
import { fakeAdminRoles } from './fake/admin-roles-fake';

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('roles from the wire', () => {
	it('reads a role, a built-in one by either flag', () => {
		expect(
			roleDefinitionFromRow({ id: 'r', name: 'x', permissions: ['a', 1], role_type: 'builtin' })
		).toMatchObject({ permissions: ['a'], is_system: true, inherits_from: null });
		expect(roleDefinitionFromRow({ id: 'r', name: 'x', is_system: 0 }).is_system).toBe(false);
	});

	it('reads an assignment with its administrator', () => {
		expect(
			roleAssignmentFromRow({
				id: 'a1',
				admin_user_id: 'u1',
				scope_type: 'global',
				expires_at: null,
				user: { email: 'u@example.com', name: null }
			})
		).toMatchObject({ email: 'u@example.com', name: null, scope_type: 'global' });
	});
});

describe('requests', () => {
	it('saves only what changed', async () => {
		const fetchMock = vi.fn(async () => json({}));
		vi.stubGlobal('fetch', fetchMock);
		await httpAdminRoles('acme').update('r 1', { description: ' Reads ' });
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/api/admin/admin-roles/r%201');
		expect(init.method).toBe('PATCH');
		expect(JSON.parse(String(init.body))).toEqual({ description: 'Reads' });
	});

	it('reads how many hold a role', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => json({ id: 'r', name: 'x', assigned_user_count: 3 }))
		);
		await expect(httpAdminRoles('acme').get('r')).resolves.toMatchObject({ holder_count: 3 });
	});
});

describe('the fake client', () => {
	it('keeps built-in roles read only and refuses a role beyond the caller', async () => {
		const client = fakeAdminRoles();
		await expect(client.update('role_ar_viewer', { description: 'x' })).rejects.toBeInstanceOf(
			ApiError
		);
		await expect(
			client.create({
				name: 'too_high',
				display_name: '',
				description: '',
				permissions: ['admin:users:read'],
				hierarchy_level: 90
			})
		).rejects.toSatisfy((error) => error instanceof ApiError && error.status === 403);
		await expect(
			client.create({
				name: 'ar_mine',
				display_name: '',
				description: '',
				permissions: ['admin:users:read'],
				hierarchy_level: 10
			})
		).rejects.toSatisfy((error) => error instanceof ApiError && error.status === 400);
	});

	it('refuses any change to a role ranked at or above the caller, even its text', async () => {
		const client = fakeAdminRoles({ caller: { rank: 5, permissions: ['*'] } });
		await expect(client.update('role_custom_billing', { description: 'x' })).rejects.toSatisfy(
			(error) => error instanceof ApiError && error.status === 403
		);
	});

	it('asks for a step-up only for a change that widens the role', async () => {
		const client = fakeAdminRoles({ cancelStepUp: true });
		// Text, and taking a permission away, need none.
		await client.update('role_custom_billing', { description: 'x' });
		await client.update('role_custom_billing', { permissions: ['admin:audit:read'] });
		await expect(
			client.update('role_custom_billing', {
				permissions: ['admin:audit:read', 'admin:users:read']
			})
		).rejects.toBeInstanceOf(StepUpCancelledError);
	});

	it('judges permissions as the API does (compatible actions, wildcards)', async () => {
		const client = fakeAdminRoles({
			caller: { rank: 80, permissions: ['admin:users:write', 'admin:admin_roles:*'] }
		});
		// What the API's hasAdminPermission says about users:suspend under users:write decides.
		const allowed = hasAdminPermission(['admin:users:write'], 'admin:users:suspend');
		const attempt = client.update('role_custom_billing', { permissions: ['admin:users:suspend'] });
		if (allowed) await attempt;
		else await expect(attempt).rejects.toBeInstanceOf(ApiError);
	});

	it('refuses a name twice and deleting a role in use', async () => {
		const client = fakeAdminRoles({ holders: { role_custom_billing: 1 } });
		await expect(
			client.create({
				name: 'billing_reader',
				display_name: '',
				description: '',
				permissions: ['admin:users:read'],
				hierarchy_level: 10
			})
		).rejects.toBeInstanceOf(ConflictError);
		await expect(client.remove('role_custom_billing')).rejects.toBeInstanceOf(ConflictError);
	});
});
