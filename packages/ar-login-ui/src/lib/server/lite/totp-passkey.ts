/**
 * The backend calls of a lite sign-in with an authenticator app (TOTP) or a passkey, the ones the
 * SPA makes (lib/api/client.ts `totpAPI`, `passkeyAPI`): from a verified form post only.
 *
 * The SPA's SDK keeps the passkey's PKCE verifier in sessionStorage; here the server makes it and
 * keeps it in the lite transaction. The WebAuthn options go to the page (the ceremony runs in the
 * browser) only as the few fields the ceremony reads, each checked.
 */
import type { LiteBackendClient } from './backend-client';
import { loginUiClientId } from './email-code';

function record(json: unknown): Record<string, unknown> {
	return typeof json === 'object' && json !== null && !Array.isArray(json)
		? (json as Record<string, unknown>)
		: {};
}

function errorOf(answer: { status: number; json: unknown }): string {
	const error = record(answer.json).error;
	return typeof error === 'string' ? error : `status_${answer.status}`;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/u;

/** The Flow interaction a sign-in attempt belongs to (its failures are recorded with it). */
function interactionHeaders(interactionId: string): Record<string, string> {
	return /^[A-Za-z0-9_.:-]{1,128}$/u.test(interactionId)
		? { 'X-Authrim-Interaction-Id': interactionId }
		: {};
}

/**
 * Starts a sign-in with an authenticator app. The answer looks the same whether the address has
 * an authenticator or not, as in the SPA. The proof of work is the lite tenant's (ar-auth asks for
 * it on this route for a lite tenant; the SDK's start sends none).
 */
export async function startLiteTotp(
	backend: LiteBackendClient,
	input: { identifier: string; proof: string | null; interactionId: string }
): Promise<
	| { ok: true; challengeId: string; expiresIn: number }
	| { ok: false; error: string; status: number }
> {
	const answer = await backend.request('/api/auth/totp/login/start', {
		json: {
			identifier: input.identifier,
			...(input.proof ? { human_verification_response: input.proof } : {})
		},
		headers: interactionHeaders(input.interactionId)
	});
	const json = record(answer.json);
	if (answer.status !== 200 || typeof json.challenge_id !== 'string' || !json.challenge_id) {
		return { ok: false, error: errorOf(answer), status: answer.status };
	}
	const expiresIn =
		typeof json.expires_in === 'number' && Number.isFinite(json.expires_in) && json.expires_in > 0
			? Math.min(json.expires_in, 600)
			: 300;
	return { ok: true, challengeId: json.challenge_id, expiresIn };
}

/**
 * Checks an authenticator code. ar-auth spends the challenge on the first check, a wrong code
 * included: a refused check needs a new start. A right one sets the session cookies itself (no
 * artifact); the authorization request is left to the Flow (`defer_authorization_continuation`).
 */
export async function verifyLiteTotp(
	backend: LiteBackendClient,
	input: { challengeId: string; code: string; authorizationChallengeId: string | null }
): Promise<
	| { ok: true; redirectUrl: string | null }
	| { ok: false; error: string; invalidCode: boolean; status: number }
> {
	const answer = await backend.request('/api/auth/totp/login/verify', {
		json: {
			challenge_id: input.challengeId,
			code: input.code,
			...(input.authorizationChallengeId
				? { authorization_challenge_id: input.authorizationChallengeId }
				: {}),
			defer_authorization_continuation: true
		}
	});
	const json = record(answer.json);
	if (answer.status !== 200 || json.success !== true) {
		const error = errorOf(answer);
		return {
			ok: false,
			error,
			invalidCode: answer.status === 400 || answer.status === 401,
			status: answer.status
		};
	}
	return {
		ok: true,
		redirectUrl:
			typeof json.redirect_url === 'string' && json.redirect_url ? json.redirect_url : null
	};
}

/** The WebAuthn request options the page's ceremony reads (and only those). */
export interface LitePasskeyOptions {
	challenge: string;
	rpId: string;
	timeout: number;
	userVerification: 'required' | 'preferred' | 'discouraged';
	allowCredentials: Array<{ id: string; transports: string[] }>;
}

const TRANSPORTS = new Set(['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card']);
const MAX_ALLOWED_CREDENTIALS = 16;

/** The options as the ceremony may use them, or null when anything is off. */
export function readLitePasskeyOptions(value: unknown): LitePasskeyOptions | null {
	const options = record(value);
	const challenge = options.challenge;
	const rpId = options.rpId;
	if (typeof challenge !== 'string' || challenge.length > 512 || !BASE64URL.test(challenge)) {
		return null;
	}
	if (typeof rpId !== 'string' || !/^[A-Za-z0-9.-]{1,253}$/u.test(rpId)) return null;
	const timeout =
		typeof options.timeout === 'number' && Number.isFinite(options.timeout)
			? Math.min(Math.max(Math.trunc(options.timeout), 10_000), 300_000)
			: 300_000;
	const userVerification =
		options.userVerification === 'preferred' || options.userVerification === 'discouraged'
			? options.userVerification
			: 'required';
	const listed = Array.isArray(options.allowCredentials) ? options.allowCredentials : [];
	if (listed.length > MAX_ALLOWED_CREDENTIALS) return null;
	const allowCredentials: LitePasskeyOptions['allowCredentials'] = [];
	for (const entry of listed) {
		const credential = record(entry);
		if (typeof credential.id !== 'string' || credential.id.length > 1024) return null;
		if (!BASE64URL.test(credential.id)) return null;
		const transports = Array.isArray(credential.transports)
			? credential.transports.filter(
					(transport): transport is string =>
						typeof transport === 'string' && TRANSPORTS.has(transport)
				)
			: [];
		allowCredentials.push({ id: credential.id, transports });
	}
	return { challenge, rpId, timeout, userVerification, allowCredentials };
}

/**
 * Starts a passkey sign-in (`direct/passkey/login/start`): the challenge to sign and its options.
 * The WebAuthn origin and relying party are the public origin the lite backend client sends.
 */
export async function startLitePasskey(
	backend: LiteBackendClient,
	input: {
		codeChallenge: string;
		proof: string | null;
		authorizationChallengeId: string | null;
		interactionId: string;
	}
): Promise<
	| { ok: true; challengeId: string; options: LitePasskeyOptions }
	| { ok: false; error: string; status: number }
> {
	const answer = await backend.request('/api/v1/auth/direct/passkey/login/start', {
		json: {
			client_id: loginUiClientId(),
			code_challenge: input.codeChallenge,
			code_challenge_method: 'S256',
			channel: 'browser',
			...(input.authorizationChallengeId
				? { authorization_challenge_id: input.authorizationChallengeId }
				: {}),
			...(input.proof ? { human_verification_response: input.proof } : {})
		},
		headers: interactionHeaders(input.interactionId)
	});
	const json = record(answer.json);
	const options = readLitePasskeyOptions(json.options);
	if (answer.status !== 200 || typeof json.challenge_id !== 'string' || !json.challenge_id) {
		return { ok: false, error: errorOf(answer), status: answer.status };
	}
	if (!options) return { ok: false, error: 'passkey_options_invalid', status: 502 };
	return { ok: true, challengeId: json.challenge_id, options };
}

/** The assertion the page's ceremony posts, re-made from its checked fields (never passed raw). */
export function readLitePasskeyCredential(
	value: string | undefined
): Record<string, unknown> | null {
	if (!value) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}
	const credential = record(parsed);
	const response = record(credential.response);
	const b64 = (field: unknown, max: number) =>
		typeof field === 'string' && field.length > 0 && field.length <= max && BASE64URL.test(field);
	if (!b64(credential.id, 1024) || !b64(credential.rawId, 1024)) return null;
	if (credential.type !== 'public-key') return null;
	if (!b64(response.authenticatorData, 2048) || !b64(response.clientDataJSON, 2048)) return null;
	if (!b64(response.signature, 1024)) return null;
	if (response.userHandle !== undefined && !b64(response.userHandle, 512)) return null;
	const attachment = credential.authenticatorAttachment;
	return {
		id: credential.id,
		rawId: credential.rawId,
		type: 'public-key',
		response: {
			authenticatorData: response.authenticatorData,
			clientDataJSON: response.clientDataJSON,
			signature: response.signature,
			...(typeof response.userHandle === 'string' ? { userHandle: response.userHandle } : {})
		},
		clientExtensionResults: {},
		...(attachment === 'platform' || attachment === 'cross-platform'
			? { authenticatorAttachment: attachment }
			: {})
	};
}

/**
 * Checks the assertion (`direct/passkey/login/finish`): the one-time artifact the session is made
 * from. ar-auth spends the challenge on the first check, whatever its outcome.
 */
export async function finishLitePasskey(
	backend: LiteBackendClient,
	input: { challengeId: string; credential: Record<string, unknown>; codeVerifier: string }
): Promise<
	{ ok: true; artifact: string; expiresIn: number } | { ok: false; error: string; status: number }
> {
	const answer = await backend.request('/api/v1/auth/direct/passkey/login/finish', {
		json: {
			challenge_id: input.challengeId,
			credential: input.credential,
			code_verifier: input.codeVerifier,
			channel: 'browser'
		}
	});
	const json = record(answer.json);
	if (
		answer.status !== 200 ||
		typeof json.direct_auth_artifact !== 'string' ||
		!json.direct_auth_artifact
	) {
		return { ok: false, error: errorOf(answer), status: answer.status };
	}
	const expiresIn =
		typeof json.expires_in === 'number' && Number.isFinite(json.expires_in) && json.expires_in > 0
			? Math.min(json.expires_in, 600)
			: 60;
	return { ok: true, artifact: json.direct_auth_artifact, expiresIn };
}
