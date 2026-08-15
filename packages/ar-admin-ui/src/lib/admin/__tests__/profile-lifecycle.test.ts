import { describe, expect, it, vi } from 'vitest';
import { completeProfileLifecycle } from '../profile-lifecycle';

describe('completeProfileLifecycle', () => {
	it('saves, reviews, and activates a new profile in order', async () => {
		let state: string | null = null;
		const calls: string[] = [];

		const completed = await completeProfileLifecycle({
			getLifecycleState: () => state,
			saveDraft: async () => {
				calls.push('save');
				state = 'draft';
				return true;
			},
			reviewDraft: async () => {
				calls.push('review');
				state = 'reviewed';
				return true;
			},
			activateVersion: async () => {
				calls.push('activate');
				state = 'active';
				return true;
			}
		});

		expect(completed).toBe(true);
		expect(state).toBe('active');
		expect(calls).toEqual(['save', 'review', 'activate']);
	});

	it('resumes a saved draft without creating another version', async () => {
		let state: string | null = 'draft';
		const saveDraft = vi.fn(async () => true);

		const completed = await completeProfileLifecycle({
			getLifecycleState: () => state,
			saveDraft,
			reviewDraft: async () => {
				state = 'reviewed';
				return true;
			},
			activateVersion: async () => {
				state = 'active';
				return true;
			}
		});

		expect(completed).toBe(true);
		expect(saveDraft).not.toHaveBeenCalled();
	});

	it('stops at the failed step so the next save can resume', async () => {
		let state: string | null = null;
		const activateVersion = vi.fn(async () => true);

		const completed = await completeProfileLifecycle({
			getLifecycleState: () => state,
			saveDraft: async () => {
				state = 'draft';
				return true;
			},
			reviewDraft: async () => false,
			activateVersion
		});

		expect(completed).toBe(false);
		expect(state).toBe('draft');
		expect(activateVersion).not.toHaveBeenCalled();
	});
});
