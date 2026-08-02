// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	adminReadReplicationAPI,
	ReadReplicationApiError,
	type ReadReplicationStatus
} from './admin-read-replication';

const status: ReadReplicationStatus = {
	environmentId: 'test',
	desiredMode: 'disabled',
	aggregateStatus: 'off',
	operationId: null,
	operationStatus: null,
	eligiblePolicyCount: 4,
	convergedPolicyCount: 4,
	failedPolicyCount: 0,
	targetCount: 3,
	convergedTargetCount: 3,
	pendingTargetCount: 0,
	failedTargetCount: 0,
	updatedAt: 100
};

describe('adminReadReplicationAPI', () => {
	afterEach(() => vi.restoreAllMocks());

	it('loads the platform-scoped aggregate without a tenant header', async () => {
		const fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(Response.json({ readReplication: status }));

		await expect(adminReadReplicationAPI.get()).resolves.toEqual(status);
		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(url).toContain('/api/admin/platform/read-replication');
		expect((init?.headers as Headers).get('X-Tenant-Id')).toBeNull();
	});

	it('uses the shared mutation idempotency header and sends only the boolean policy', async () => {
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			Response.json({
				readReplication: {
					...status,
					desiredMode: 'enabled',
					aggregateStatus: 'updating',
					operationId: 'operation-1',
					operationStatus: 'applying'
				}
			})
		);

		await adminReadReplicationAPI.setEnabled(true);
		const [, init] = fetchMock.mock.calls[0] ?? [];
		expect(init?.method).toBe('PUT');
		expect((init?.headers as Headers).get('Idempotency-Key')).toEqual(expect.any(String));
		expect(JSON.parse(String(init?.body))).toEqual({ enabled: true });
	});

	it('preserves the response status for permission-aware UI hiding', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			Response.json({ error: 'forbidden' }, { status: 403 })
		);

		await expect(adminReadReplicationAPI.get()).rejects.toMatchObject({
			status: 403,
			message: 'forbidden'
		} satisfies Partial<ReadReplicationApiError>);
	});
});
