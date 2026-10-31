/**
 * The signed-in admin's access, for the whole console. Pages, the navigation and single
 * controls read `adminAccess.current` and ask `access.ts` about it.
 *
 * Storybook and the dev mock set an override (a persona) instead of signing in.
 */
import { adminSession } from '$lib/auth/session.svelte';
import { accessFromSession, NO_ACCESS, type AdminAccess } from './access';

let override = $state<AdminAccess | null>(null);

export const adminAccess = {
	get current(): AdminAccess {
		if (override) return override;
		const session = adminSession.current;
		return session ? accessFromSession(session) : NO_ACCESS;
	},
	/** Storybook's Admin toolbar: look at the console as this admin. */
	setOverride(next: AdminAccess | null): void {
		override = next;
	}
};
