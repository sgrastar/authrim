import { describe, expect, it } from 'vitest';
import { ApiError, ReleasePausedError } from '#lib/api/api-error.js';
import { channelErrorKey } from './notice-labels';

describe('channelErrorKey', () => {
	it('does not take a change paused for a release for the encryption being unset', () => {
		for (const [status, code] of [
			[409, 'ADMIN_MUTATION_PAUSED_FOR_RELEASE'],
			[503, 'CONTROL_PLANE_RELEASE_ROLLOUT_UNAVAILABLE']
		] as const) {
			expect(channelErrorKey(new ReleasePausedError(status, code, ''))).toBe(
				'common.releasePaused'
			);
		}
		expect(channelErrorKey(new ApiError(503, 'temporarily_unavailable', ''))).toBe(
			'nt.slack.err.unavailable'
		);
	});
});
