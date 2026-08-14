import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const adminFetch = vi.hoisted(() => vi.fn());

vi.mock('$lib/api/admin-request', () => ({ adminFetch }));

const apiBaseUrl = 'https://tenant.example.test';

describe('adminExternalTokenRefreshAPI', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.resetModules();
		vi.stubEnv('PUBLIC_API_BASE_URL', apiBaseUrl);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('loads configuration from the configured tenant Admin API origin', async () => {
		const { adminExternalTokenRefreshAPI } = await import('./admin-external-token-refresh');
		adminFetch.mockResolvedValue(
			new Response(
				JSON.stringify({
					config: {
						enabled: false,
						refreshThresholdSeconds: 3600,
						batchSize: 100,
						scheduledTenantBatchSize: 100,
						piiShardPageSize: 4
					}
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } }
			)
		);

		await expect(adminExternalTokenRefreshAPI.getConfig()).resolves.toMatchObject({
			config: { enabled: false }
		});
		expect(adminFetch).toHaveBeenCalledWith(
			`${apiBaseUrl}/api/admin/external-token-refresh/config`,
			expect.objectContaining({ credentials: 'include' })
		);
	});
});
