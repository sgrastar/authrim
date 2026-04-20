// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAdminHeaders } from './admin-request';

describe('buildAdminHeaders', () => {
	beforeEach(() => {
		localStorage.clear();
		sessionStorage.clear();
		vi.restoreAllMocks();
	});

	it('uses the persisted tenant selection when store initialization has not completed yet', () => {
		sessionStorage.setItem('settings_tenant_id', 'first');
		localStorage.setItem('sessionId', 'session-123');

		const headers = buildAdminHeaders();

		expect(headers.get('X-Tenant-Id')).toBe('first');
		expect(headers.get('X-Session-Id')).toBe('session-123');
	});

	it('omits X-Tenant-Id when skipTenantHeader is enabled', () => {
		sessionStorage.setItem('settings_tenant_id', 'first');

		const headers = buildAdminHeaders(undefined, { skipTenantHeader: true });

		expect(headers.get('X-Tenant-Id')).toBeNull();
	});
});
