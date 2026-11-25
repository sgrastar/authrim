import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#lib/api/admin-request.js', () => ({
	API_BASE_URL: 'https://api.test',
	adminFetch: vi.fn()
}));

import { adminFetch } from '#lib/api/admin-request.js';
import { isWorkable } from './tenant-scope.svelte';

function listIs(tenants: Array<{ id: string; name?: string; lifecycle_state?: string }>) {
	vi.mocked(adminFetch).mockResolvedValue({
		ok: true,
		json: async () => ({ tenants })
	} as Response);
}

// The store keeps the selection between loads: each test starts from a fresh one.
let tenantScope: (typeof import('./tenant-scope.svelte'))['tenantScope'];

beforeEach(async () => {
	window.sessionStorage.clear();
	vi.resetModules();
	({ tenantScope } = await import('./tenant-scope.svelte'));
});

describe('isWorkable', () => {
	it('refuses only a tenant being deleted or gone', () => {
		expect(isWorkable({ lifecycleState: 'deleting' })).toBe(false);
		expect(isWorkable({ lifecycleState: 'deleted' })).toBe(false);
		expect(isWorkable({ lifecycleState: 'active' })).toBe(true);
		expect(isWorkable({ lifecycleState: 'suspended' })).toBe(true);
		// The session's own tenant, when the list was unavailable, carries no state.
		expect(isWorkable({})).toBe(true);
	});
});

describe('the tenants a platform administrator can switch between', () => {
	it('lists every tenant with its state, including those being deleted', async () => {
		listIs([
			{ id: 'a', name: 'A', lifecycle_state: 'deleting' },
			{ id: 'b', name: 'B', lifecycle_state: 'active' },
			{ id: 'c', name: 'C', lifecycle_state: 'deleted' }
		]);
		await tenantScope.load('b', true);
		expect(tenantScope.tenants.map((t) => [t.id, t.lifecycleState])).toEqual([
			['a', 'deleting'],
			['b', 'active'],
			['c', 'deleted']
		]);
	});

	it('opens on the first tenant that can be worked on, not on one being deleted', async () => {
		listIs([
			{ id: 'a', lifecycle_state: 'deleting' },
			{ id: 'b', lifecycle_state: 'active' }
		]);
		await tenantScope.load(null, true);
		expect(tenantScope.tenantId).toBe('b');
	});

	it('does not keep a stored choice that has since started to be deleted', async () => {
		window.sessionStorage.setItem('authrim-console-tenant', 'a');
		listIs([
			{ id: 'a', lifecycle_state: 'deleting' },
			{ id: 'b', lifecycle_state: 'active' }
		]);
		await tenantScope.load(null, true);
		expect(tenantScope.tenantId).toBe('b');
	});

	it('refuses to select a tenant being deleted', async () => {
		listIs([
			{ id: 'a', lifecycle_state: 'deleting' },
			{ id: 'b', lifecycle_state: 'active' }
		]);
		await tenantScope.load(null, true);
		tenantScope.select('a');
		expect(tenantScope.tenantId).toBe('b');
	});

	it('keeps a chosen tenant that starts to be deleted from being the working one after a reload', async () => {
		listIs([
			{ id: 'a', lifecycle_state: 'active' },
			{ id: 'b', lifecycle_state: 'active' }
		]);
		await tenantScope.load(null, true);
		tenantScope.select('a');
		listIs([
			{ id: 'a', lifecycle_state: 'deleting' },
			{ id: 'b', lifecycle_state: 'active' }
		]);
		await tenantScope.reload();
		expect(tenantScope.tenantId).toBe('b');
	});

	it('offers only tenants that can be worked on as the reach of a grant', async () => {
		listIs([
			{ id: 'a', lifecycle_state: 'deleting' },
			{ id: 'b', lifecycle_state: 'active' }
		]);
		await tenantScope.load(null, true);
		expect(tenantScope.workableTenants.map((t) => t.id)).toEqual(['b']);
	});

	it('still lists the session’s own tenant when every listed tenant is being deleted', async () => {
		listIs([{ id: 'a', lifecycle_state: 'deleting' }]);
		await tenantScope.load('home', true);
		expect(tenantScope.tenantId).toBe('home');
		expect(tenantScope.tenants.map((t) => t.id)).toContain('home');
		expect(tenantScope.current?.id).toBe('home');
	});
});
