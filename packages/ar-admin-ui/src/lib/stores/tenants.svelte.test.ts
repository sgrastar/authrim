import { beforeEach, describe, expect, it, vi } from 'vitest';

const list = vi.hoisted(() => vi.fn());

vi.mock('$lib/api/admin-tenants', () => ({
	adminTenantsAPI: { list }
}));

import { tenantStore } from './tenants.svelte';

describe('tenantStore error boundaries', () => {
	beforeEach(() => {
		list.mockReset();
	});

	it('keeps selector loading non-critical but propagates inventory-page reload failures', async () => {
		list.mockRejectedValueOnce(new Error('tenant inventory unavailable'));

		await expect(tenantStore.load()).resolves.toBeUndefined();

		list.mockRejectedValueOnce(new Error('tenant inventory unavailable'));
		await expect(tenantStore.reload()).rejects.toThrow('tenant inventory unavailable');
	});
});
