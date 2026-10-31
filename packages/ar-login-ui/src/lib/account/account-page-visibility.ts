import type { AccountRegistrationState } from '@authrim/ar-lib-core';
import type { AccountPageDefinition } from '$lib/api/account';

type AccountPagePlacement = AccountPageDefinition['screens'][number];

export function isPlacementVisibleForRegistrationState(
	placement: AccountPagePlacement,
	registrationState: AccountRegistrationState | null | undefined
): boolean {
	if (registrationState == null) return placement.show_for_guests !== false;
	return registrationState !== 'guest' || placement.show_for_guests !== false;
}
