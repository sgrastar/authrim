/**
 * Admin session state, backed by the HttpOnly admin session cookie (never readable here).
 * `check()` asks the Admin API who is signed in; the console layout uses it as its guard.
 */
import { adminAuthAPI, AuthError, type SessionStatus } from '$lib/api/admin-auth';

export type SessionState = 'unknown' | 'authenticated' | 'anonymous' | 'forbidden';

let state = $state<SessionState>('unknown');
let current = $state<SessionStatus | null>(null);

export const adminSession = {
	get state(): SessionState {
		return state;
	},
	get current(): SessionStatus | null {
		return current;
	},
	get isPlatformAdmin(): boolean {
		return current?.is_platform_admin === true;
	},
	get displayName(): string {
		return current?.name || current?.email || current?.user_id || '';
	},
	get initials(): string {
		const source = current?.name || current?.email || '';
		const letters = source
			.split(/[\s@._-]+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? '');
		return letters.join('') || '?';
	},

	async check(): Promise<SessionState> {
		try {
			const session = await adminAuthAPI.checkSession();
			current = session;
			state = session ? 'authenticated' : 'anonymous';
		} catch (error) {
			current = null;
			state = error instanceof AuthError && error.code === 'forbidden' ? 'forbidden' : 'anonymous';
		}
		return state;
	},

	async signOut(): Promise<void> {
		current = null;
		state = 'anonymous';
		await adminAuthAPI.logout();
	}
};
