import { describe, expect, it } from 'vitest';
import { buildProxyHeaders } from './hooks.server';

describe('buildProxyHeaders', () => {
	it('forwards X-Tenant-Id to the backend proxy target', () => {
		const event = {
			request: new Request('https://mt-ar-admin-ui.pages.dev/api/admin/stats', {
				headers: {
					Host: 'mt-ar-admin-ui.pages.dev',
					Origin: 'https://mt-ar-admin-ui.pages.dev',
					'X-Session-Id': 'session-123',
					'X-Tenant-Id': 'first'
				}
			}),
			getClientAddress: () => '203.0.113.10'
		} as unknown as Parameters<typeof buildProxyHeaders>[0];

		const headers = buildProxyHeaders(event, undefined, 'multi-tenant.authrim.com');

		expect(headers.get('X-Tenant-Id')).toBe('first');
		expect(headers.get('X-Session-Id')).toBe('session-123');
		expect(headers.get('X-Forwarded-Host')).toBe('multi-tenant.authrim.com');
	});
});
