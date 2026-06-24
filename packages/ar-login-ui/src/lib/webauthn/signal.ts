import type { AccountProfile, WebAuthnCredentialSignal } from '$lib/api/account';
import type { APIError } from '$lib/api/client';

type WebAuthnSignalCredentialConstructor = typeof PublicKeyCredential & {
	signalUnknownCredential?: (options: { rpId: string; credentialId: string }) => Promise<void>;
	signalAllAcceptedCredentials?: (options: {
		rpId: string;
		userId: string;
		allAcceptedCredentialIds: string[];
	}) => Promise<void>;
	signalCurrentUserDetails?: (options: {
		rpId: string;
		userId: string;
		name: string;
		displayName: string;
	}) => Promise<void>;
};

function getPublicKeyCredential(): WebAuthnSignalCredentialConstructor | null {
	if (typeof window === 'undefined' || !window.PublicKeyCredential) {
		return null;
	}
	return window.PublicKeyCredential as WebAuthnSignalCredentialConstructor;
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function encodeUserHandle(userId: string): string {
	return base64UrlEncode(new TextEncoder().encode(userId));
}

export async function signalAllAcceptedCredentials(
	signal: WebAuthnCredentialSignal | undefined
): Promise<void> {
	if (!signal) return;
	const PublicKeyCredentialWithSignals = getPublicKeyCredential();
	const signalMethod = PublicKeyCredentialWithSignals?.signalAllAcceptedCredentials;
	if (!signalMethod) return;

	try {
		await signalMethod.call(PublicKeyCredentialWithSignals, {
			rpId: signal.rp_id,
			userId: signal.user_id,
			allAcceptedCredentialIds: signal.credential_ids
		});
	} catch {
		// Signal API is best-effort UX sync; account operations must not fail because of it.
	}
}

export async function signalUnknownCredential(
	credentialId: string | undefined,
	rpId = typeof window !== 'undefined' ? window.location.hostname : ''
): Promise<void> {
	if (!credentialId || !rpId) return;
	const PublicKeyCredentialWithSignals = getPublicKeyCredential();
	const signalMethod = PublicKeyCredentialWithSignals?.signalUnknownCredential;
	if (!signalMethod) return;

	try {
		await signalMethod.call(PublicKeyCredentialWithSignals, {
			rpId,
			credentialId
		});
	} catch {
		// Signal API is best-effort UX sync; auth flows must not fail because of it.
	}
}

export function shouldSignalUnknownCredentialAfterRegistrationFailure(
	error: APIError | undefined
): boolean {
	if (!error) return false;
	return ['invalid_challenge', 'verification_failed', 'invalid_request'].includes(error.error);
}

export function shouldSignalUnknownCredentialAfterLoginFailure(
	error: APIError | undefined
): boolean {
	return error?.webauthn_signal?.unknown_credential === true;
}

export async function signalCurrentUserDetails(
	profile: AccountProfile | null | undefined,
	rpId = typeof window !== 'undefined' ? window.location.hostname : ''
): Promise<void> {
	if (!profile || !rpId) return;
	const PublicKeyCredentialWithSignals = getPublicKeyCredential();
	const signalMethod = PublicKeyCredentialWithSignals?.signalCurrentUserDetails;
	if (!signalMethod) return;

	const displayName = profile.name || profile.email || profile.user_id;
	try {
		await signalMethod.call(PublicKeyCredentialWithSignals, {
			rpId,
			userId: encodeUserHandle(profile.user_id),
			name: profile.email || profile.user_id,
			displayName
		});
	} catch {
		// Signal API is best-effort UX sync; profile updates must not fail because of it.
	}
}
