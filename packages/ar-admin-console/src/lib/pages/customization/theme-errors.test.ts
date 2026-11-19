import { describe, expect, it } from 'vitest';
import { ApiError, ConflictError, ReleasePausedError } from '#lib/api/api-error.js';
import { themeErrorKey } from './theme-errors';

describe('themeErrorKey', () => {
	it('says the environment is being updated, not that the theme was changed elsewhere', () => {
		expect(
			themeErrorKey(
				new ReleasePausedError(409, 'ADMIN_MUTATION_PAUSED_FOR_RELEASE', ''),
				'th.error.save'
			)
		).toBe('common.releasePaused');
		expect(
			themeErrorKey(
				new ReleasePausedError(503, 'CONTROL_PLANE_RELEASE_ROLLOUT_UNAVAILABLE', ''),
				'th.error.apply'
			)
		).toBe('common.releasePaused');
	});

	it('keeps a real conflict a conflict', () => {
		expect(themeErrorKey(new ConflictError('', {}), 'th.error.save')).toBe('th.error.conflict');
		expect(themeErrorKey(new ApiError(412, '', ''), 'th.error.save')).toBe('th.error.conflict');
		expect(themeErrorKey(new ApiError(409, 'theme_name_taken', ''), 'th.error.save')).toBe(
			'th.error.nameTaken'
		);
	});

	it('falls back for anything else', () => {
		expect(themeErrorKey(new Error('x'), 'th.error.save')).toBe('th.error.save');
		expect(themeErrorKey(new ApiError(500, '', ''), 'th.error.apply')).toBe('th.error.apply');
	});
});
