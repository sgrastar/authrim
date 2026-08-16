import { describe, expect, it, vi } from 'vitest';
import type { ReleaseRolloutStatus } from '$lib/api/admin-control-plane';
import { createReleaseRolloutStore } from './release-rollout.svelte';

const ACTIVE_ROLLOUT: ReleaseRolloutStatus = {
	operationId: 'release-rollout-1',
	sourceVersion: '1.0.0',
	targetVersion: '1.1.0',
	phase: 'database_rollout',
	completedTargets: 2,
	totalTargets: 10,
	adminMutationMode: 'read_only',
	lastErrorCode: null,
	updatedAt: 1_800_000_000,
	blockedTargetCount: 0,
	blockedTargets: []
};

const COMPLETED_ROLLOUT: ReleaseRolloutStatus = {
	...ACTIVE_ROLLOUT,
	phase: 'completed',
	completedTargets: 10,
	adminMutationMode: 'available'
};

describe('releaseRolloutStore', () => {
	it('does not invent an active rollout or disable settings when the initial status request fails', async () => {
		const api = {
			getReleaseRolloutStatus: vi.fn().mockRejectedValue(new Error('status unavailable'))
		};
		const store = createReleaseRolloutStore(api);

		await store.refresh();

		expect(store.available).toBe(false);
		expect(store.active).toBe(false);
		expect(store.readOnly).toBe(false);
		expect(store.status.phase).toBe('idle');
		expect(store.shouldPoll).toBe(true);
	});

	it('keeps a previously confirmed rollout fenced through a later status outage', async () => {
		const api = {
			getReleaseRolloutStatus: vi
				.fn()
				.mockResolvedValueOnce({ rollout: ACTIVE_ROLLOUT })
				.mockRejectedValueOnce(new Error('status unavailable'))
		};
		const store = createReleaseRolloutStore(api);

		await store.refresh();
		expect(store.active).toBe(true);
		expect(store.readOnly).toBe(true);

		await store.refresh();

		expect(store.available).toBe(false);
		expect(store.active).toBe(true);
		expect(store.readOnly).toBe(true);
		expect(store.status).toEqual(ACTIVE_ROLLOUT);
		expect(store.shouldPoll).toBe(true);
	});

	it('stops polling after a completed rollout snapshot is confirmed', async () => {
		const api = {
			getReleaseRolloutStatus: vi.fn().mockResolvedValue({ rollout: COMPLETED_ROLLOUT })
		};
		const store = createReleaseRolloutStore(api);

		expect(store.shouldPoll).toBe(true);
		await store.refresh();

		expect(store.active).toBe(false);
		expect(store.readOnly).toBe(false);
		expect(store.shouldPoll).toBe(false);
	});
});
