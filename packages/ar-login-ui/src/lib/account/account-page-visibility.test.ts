import { describe, expect, it } from 'vitest';
import type { AccountPageDefinition } from '$lib/api/account';
import { isPlacementVisibleForRegistrationState } from './account-page-visibility';

function placement(showForGuests: boolean): AccountPageDefinition['screens'][number] {
	return {
		id: 'widget',
		screen_key: 'account_widget',
		width: 'full',
		enabled: true,
		condition: 'always',
		show_for_guests: showForGuests
	};
}

describe('Account Page guest widget visibility', () => {
	it.each([
		[undefined, false, false],
		[undefined, true, true],
		['guest', false, false],
		['guest', true, true],
		['registered', false, true],
		['registered', true, true]
	] as const)(
		'for registration_state=%s and show_for_guests=%s returns %s',
		(registrationState, showForGuests, expected) => {
			expect(
				isPlacementVisibleForRegistrationState(placement(showForGuests), registrationState)
			).toBe(expected);
		}
	);
});
