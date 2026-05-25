// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAdminHeaders } from './admin-request';
import { settingsContext } from '$lib/stores/settings-context.svelte';

describe('buildAdminHeaders', () => {
	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		settingsContext.reset();
		vi.restoreAllMocks();
	});

	it('uses the persisted tenant selection when store initialization has not completed yet', () => {
		sessionStorage.setItem('settings_tenant_id', 'first');
		localStorage.setItem('sessionId', 'session-123');

		const headers = buildAdminHeaders();

		expect(headers.get('X-Tenant-Id')).toBe('first');
		expect(headers.get('X-Session-Id')).toBeNull();
	});

	it('prefers the live tenant context over a stale persisted selection', async () => {
		await settingsContext.setTenantId('fresh');
		sessionStorage.setItem('settings_tenant_id', 'stale');

		const headers = buildAdminHeaders();

		expect(headers.get('X-Tenant-Id')).toBe('fresh');
	});

	it('uses an explicit tenant override for tenant path admin API calls', async () => {
		await settingsContext.setTenantId('first');

		const headers = buildAdminHeaders(undefined, { tenantId: 'second' });

		expect(headers.get('X-Tenant-Id')).toBe('second');
	});

	it('omits X-Tenant-Id before any tenant context is available', () => {
		const headers = buildAdminHeaders();

		expect(headers.get('X-Tenant-Id')).toBeNull();
	});

	it('omits X-Tenant-Id when skipTenantHeader is enabled', () => {
		sessionStorage.setItem('settings_tenant_id', 'first');

		const headers = buildAdminHeaders(undefined, { skipTenantHeader: true });

		expect(headers.get('X-Tenant-Id')).toBeNull();
	});
});
