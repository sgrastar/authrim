/**
 * Passkey clean-up for a tenant that was deleted.
 *
 * A passkey outlives the tenant it was made for: the browser's passkey provider keeps offering it
 * on this host, where nothing can accept it any more. The WebAuthn Signal API lets a page on the
 * passkey's own host tell the provider so. Telling it cannot be taken back, so this module acts
 * only on the platform's answer that the tenant of this very host was deleted.
 *
 * The provider needs to know whose passkeys are meant. For that, the user handle of each person
 * who used a passkey in this browser is remembered here (an opaque id, no name or address), which
 * makes the clean-up automatic. Without one, the person picks a passkey and that one is reported.
 *
 * The lite pages neither remember owners nor show the notice: their passkey ceremony is a fixed,
 * hash-allowed script that posts a form, with no step after the server's check to hook into.
 */

const STORAGE_KEY = 'authrim:passkey-user-handles';
const MAX_REMEMBERED = 8;
/** A WebAuthn user handle is at most 64 bytes: 86 base64url characters. */
const USER_HANDLE = /^[A-Za-z0-9_-]{1,86}$/u;
const TENANT_STATUS_PATH = '/api/auth/tenant-status';

type SignalCapableCredential = typeof PublicKeyCredential & {
	signalUnknownCredential?: (options: { rpId: string; credentialId: string }) => Promise<void>;
	signalAllAcceptedCredentials?: (options: {
		rpId: string;
		userId: string;
		allAcceptedCredentialIds: string[];
	}) => Promise<void>;
};

function signalApi(): SignalCapableCredential | null {
	if (typeof window === 'undefined' || !window.PublicKeyCredential) return null;
	return window.PublicKeyCredential as SignalCapableCredential;
}

function storage(): Storage | null {
	try {
		return typeof window === 'undefined' ? null : window.localStorage;
	} catch {
		// Storage can be blocked outright (private modes, policy); nothing is remembered then.
		return null;
	}
}

function base64Url(bytes: ArrayBuffer): string {
	let binary = '';
	for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/** The user handles remembered in this browser for this host, newest last. */
export function rememberedPasskeyUserHandles(): string[] {
	try {
		const parsed: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? '[]');
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((value): value is string => typeof value === 'string' && USER_HANDLE.test(value))
			.slice(-MAX_REMEMBERED);
	} catch {
		return [];
	}
}

/**
 * Remember that the person with this user handle (base64url) used a passkey here. Best effort:
 * signing in never depends on it.
 */
export function rememberPasskeyUserHandle(userHandle: string | null | undefined): void {
	if (!userHandle || !USER_HANDLE.test(userHandle)) return;
	try {
		const handles = rememberedPasskeyUserHandles().filter((value) => value !== userHandle);
		handles.push(userHandle);
		storage()?.setItem(STORAGE_KEY, JSON.stringify(handles.slice(-MAX_REMEMBERED)));
	} catch {
		// Full or blocked storage.
	}
}

/** After a passkey sign-in: remember the owner the authenticator named in its assertion. */
export function rememberPasskeyUserOfAssertion(credential: unknown): void {
	const response = (credential as { response?: { userHandle?: unknown } } | null)?.response;
	if (typeof response?.userHandle === 'string') rememberPasskeyUserHandle(response.userHandle);
}

/** After a passkey was registered: remember the owner named in its creation options. */
export function rememberPasskeyUserOfRegistration(options: unknown): void {
	const user = (options as { user?: { id?: unknown } } | null)?.user;
	if (typeof user?.id === 'string') rememberPasskeyUserHandle(user.id);
}

/**
 * Whether the platform says the tenant of the host this page is on was deleted. False for every
 * other answer, for a failed request, and for an answer about another host (a proxy in between
 * may have chosen the tenant from something other than this page's address).
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

/** Whether this browser can tell its passkey provider anything at all. */
export function canSignalPasskeyRemoval(): boolean {
	const api = signalApi();
	return Boolean(api?.signalAllAcceptedCredentials && api.signalUnknownCredential);
}

async function signalNoAcceptedCredentials(userHandle: string): Promise<boolean> {
	const api = signalApi();
	if (!api?.signalAllAcceptedCredentials) return false;
	try {
		await api.signalAllAcceptedCredentials.call(api, {
			rpId: window.location.hostname,
			userId: userHandle,
			allAcceptedCredentialIds: []
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Tell the provider that none of the remembered people's passkeys for this host is accepted any
 * more. Returns how many people it was told for.
 *
 * The handles stay remembered. The call resolving only means the request was handed over: the
 * provider gives no answer, and one that is locked or not installed at the moment drops it. So
 * every later visit to the deleted tenant's page asks again, which costs nothing when the passkeys
 * are already gone. Call only after `isTenantOfThisHostDeleted` answered true.
 */
export async function signalRememberedPasskeysRemoved(): Promise<number> {
	if (!canSignalPasskeyRemoval()) return 0;
	const results = await Promise.all(
		rememberedPasskeyUserHandles().map(signalNoAcceptedCredentials)
	);
	return results.filter(Boolean).length;
}

export type ChosenPasskeyRemoval = 'signalled' | 'cancelled' | 'unsupported';

/**
 * Let the person pick a passkey of this host and report it, and the rest of that person's
 * passkeys with it, as no longer accepted. No server takes part: the pick only identifies the
 * passkey and its owner. Call only after `isTenantOfThisHostDeleted` answered true.
 */
export async function signalChosenPasskeyRemoved(): Promise<ChosenPasskeyRemoval> {
	const api = signalApi();
	if (!api?.signalUnknownCredential || !canSignalPasskeyRemoval()) return 'unsupported';
	if (typeof navigator === 'undefined' || !navigator.credentials?.get) return 'unsupported';

	let chosen: Credential | null;
	try {
		chosen = await navigator.credentials.get({
			publicKey: {
				// Nothing verifies this assertion; the challenge only has to be well formed.
				challenge: crypto.getRandomValues(new Uint8Array(32)),
				rpId: window.location.hostname,
				allowCredentials: [],
				userVerification: 'discouraged',
				timeout: 60_000
			}
		});
	} catch {
		return 'cancelled';
	}
	if (!chosen || chosen.type !== 'public-key') return 'cancelled';

	const credential = chosen as PublicKeyCredential;
	const userHandle = (credential.response as AuthenticatorAssertionResponse).userHandle;
	try {
		await api.signalUnknownCredential.call(api, {
			rpId: window.location.hostname,
			credentialId: credential.id
		});
	} catch {
		return 'cancelled';
	}
	if (userHandle && userHandle.byteLength > 0) {
		await signalNoAcceptedCredentials(base64Url(userHandle));
	}
	return 'signalled';
}
