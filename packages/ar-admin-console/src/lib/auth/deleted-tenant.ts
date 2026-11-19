/**
 * The Admin Console's part in clearing the passkeys of a deleted tenant.
 *
 * The console and the Login UI are served on the same host, so an administrator's passkey has the
 * same RP ID as an end user's and the Login UI can clear both. The console only does two things:
 * it remembers the WebAuthn user handle of each administrator who used a passkey in this browser,
 * in the list the Login UI reads, and it hands over to the Login UI when the platform says the
 * tenant of this host was deleted. The notice and the WebAuthn Signal API calls are the Login UI's
 * (`packages/ar-login-ui/src/lib/webauthn/deleted-tenant.ts`); the storage key and the format
 * below are a contract with that file, kept in step by `deleted-tenant.test.ts`.
 */

export const PASSKEY_USER_HANDLES_STORAGE_KEY = 'authrim:passkey-user-handles';
export const MAX_REMEMBERED_PASSKEY_USER_HANDLES = 8;
/** A WebAuthn user handle is at most 64 bytes: 86 base64url characters. */
const USER_HANDLE = /^[A-Za-z0-9_-]{1,86}$/u;
const TENANT_STATUS_PATH = '/api/auth/tenant-status';
/** Where the Login UI shows the notice and clears the passkeys. */
export const DELETED_TENANT_NOTICE_PATH = '/login';

function storage(): Storage | null {
	try {
		return typeof window === 'undefined' ? null : window.localStorage;
	} catch {
		// Storage can be blocked outright (private modes, policy); nothing is remembered then.
		return null;
	}
}

function remembered(): string[] {
	try {
		const parsed: unknown = JSON.parse(
			storage()?.getItem(PASSKEY_USER_HANDLES_STORAGE_KEY) ?? '[]'
		);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(value): value is string => typeof value === 'string' && USER_HANDLE.test(value)
		);
	} catch {
		return [];
	}
}

function remember(userHandle: unknown): void {
	if (typeof userHandle !== 'string' || !USER_HANDLE.test(userHandle)) return;
	try {
		const handles = remembered().filter((value) => value !== userHandle);
		handles.push(userHandle);
		storage()?.setItem(
			PASSKEY_USER_HANDLES_STORAGE_KEY,
			JSON.stringify(handles.slice(-MAX_REMEMBERED_PASSKEY_USER_HANDLES))
		);
	} catch {
		// Full or blocked storage. Best effort: signing in never depends on it.
	}
}

/** After a passkey sign-in the server accepted: remember the owner named in the assertion. */
export function rememberPasskeyUserOfAssertion(credential: unknown): void {
	remember((credential as { response?: { userHandle?: unknown } } | null)?.response?.userHandle);
}

/** After a passkey the server registered: remember the owner named in its creation options. */
export function rememberPasskeyUserOfRegistration(options: unknown): void {
	remember((options as { user?: { id?: unknown } } | null)?.user?.id);
}

/**
 * Whether the platform says the tenant of the host this page is on was deleted. False for every
 * other answer, for a failed request, and for an answer about another host.
 */
export async function isTenantOfThisHostDeleted(fetcher: typeof fetch = fetch): Promise<boolean> {
	if (typeof window === 'undefined') return false;
	try {
		const response = await fetcher(TENANT_STATUS_PATH, {
			method: 'GET',
			cache: 'no-store',
			credentials: 'omit',
			headers: { Accept: 'application/json' }
		});
		if (!response.ok) return false;
		const answer = (await response.json()) as { status?: unknown; host?: unknown } | null;
		return answer?.status === 'deleted' && answer.host === window.location.hostname.toLowerCase();
	} catch {
		return false;
	}
}

/**
 * Leave for the Login UI's notice when the tenant of this host was deleted. Returns whether it
 * left. `replace`, so the console's sign-in page is not kept behind the notice.
 */
export async function leaveForNoticeIfTenantDeleted(
	fetcher: typeof fetch = fetch,
	leave: (path: string) => void = (path) => window.location.replace(path)
): Promise<boolean> {
	if (!(await isTenantOfThisHostDeleted(fetcher))) return false;
	leave(DELETED_TENANT_NOTICE_PATH);
	return true;
}
