/** In-memory first-steps progress for Storybook and tests. */
import type { OnboardingClient } from '../onboarding';

export function createFakeOnboarding(
	initial: readonly string[] = [],
	options: { fail?: boolean } = {}
): OnboardingClient {
	const completed = new Set(initial);
	const answer = async () => {
		if (options.fail) throw new Error('unavailable');
		return [...completed];
	};
	return {
		list: answer,
		complete: (itemId) => {
			if (!options.fail) completed.add(itemId);
			return answer();
		},
		reopen: (itemId) => {
			if (!options.fail) completed.delete(itemId);
			return answer();
		}
	};
}
