import { describe, expect, it } from 'vitest';
import type { ProviderProjectionJob } from '$lib/api/admin-plugins';
import { shouldShowProviderProjectionStatus } from '../provider-projection';

function job(status: ProviderProjectionJob['status']): ProviderProjectionJob {
	return {
		pluginId: 'notifier-cloudflare',
		revision: 'revision-a',
		status,
		total: 1,
		processed: status === 'pending' ? 0 : 1,
		succeeded: status === 'completed' ? 1 : 0,
		skipped: 0,
		failed: status === 'failed' ? 1 : 0,
		lastErrorCode: status === 'failed' ? 'projection_failed' : null,
		updatedAt: 1
	};
}

describe('provider projection status visibility', () => {
	it.each(['pending', 'processing', 'failed'] as const)('shows %s jobs', (status) => {
		expect(shouldShowProviderProjectionStatus([job(status)])).toBe(true);
	});

	it.each(['completed', 'superseded'] as const)('hides %s-only history', (status) => {
		expect(shouldShowProviderProjectionStatus([job(status)])).toBe(false);
	});

	it('keeps a failure visible when completed history also exists', () => {
		expect(shouldShowProviderProjectionStatus([job('completed'), job('failed')])).toBe(true);
	});
});
