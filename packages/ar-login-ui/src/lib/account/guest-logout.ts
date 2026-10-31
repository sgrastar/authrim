/** A guest loses its browser resume credential on logout, regardless of retention policy. */
export async function logoutWithGuestWarning(input: {
	amr?: string[];
	warning: string;
	confirm: (message: string) => boolean;
	logout: () => Promise<void>;
}): Promise<boolean> {
	if (input.amr?.includes('anon') && !input.confirm(input.warning)) return false;
	await input.logout();
	return true;
}
