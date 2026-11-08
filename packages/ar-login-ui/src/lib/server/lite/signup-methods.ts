/**
 * The backend calls of a lite sign-up by passkey or authenticator app (PR6a-2), the ones the SPA's
 * sign-up page makes (lib/api/client.ts `passkeyAPI.getRegisterOptions` / `verifyRegistration`,
 * `totpAPI.signupOptions` / `signupActivate`): from a verified form post only.
 *
 * - A passkey's sign-up registers a credential (`navigator.credentials.create`): its creation
 *   options go to the page only as the fields the ceremony reads, each checked; the attestation the
 *   ceremony posts is re-made from its checked fields. The finish answers a one-time artifact, as a
 *   passkey's sign-in does, which the session is made from.
 * - An authenticator's sign-up gives a secret (shown with its otpauth link and QR code) and is
 *   activated by a code from it: ar-auth makes the session and answers the backup codes.
 */
import type { LiteBackendClient } from './backend-client';
import { loginUiClientId } from './email-code';
import { readLiteProvisioningAnswer, type LiteProvisioningAnswer } from './provisioning';
import {
	BASE64URL,
	MAX_CREDENTIAL_ID_CHARS,
	TRANSPORTS,
	errorOf,
	interactionHeaders,
	record
} from './totp-passkey';

/** A sign-up's profile and invitation, sent with the account it makes. */
export interface LiteSignupAccount {
	email: string;
	displayName: string | null;
	customFields: Record<string, string>;
	inviteToken: string | null;
	/** The proof of the invited address, when the invitation asks one first. */
	inviteProof: string | null;
}

/** An answer that the account is still being made (a routed tenant database): try again later. */
function isProvisioning(answer: { status: number; json: unknown }): boolean {
	return answer.status === 202 && record(answer.json).status === 'provisioning';
}

/** The WebAuthn creation options the page's ceremony reads (and only those). */
export interface LitePasskeyCreationOptions {
	challenge: string;
	rp: { id: string; name: string };
	user: { id: string; name: string; displayName: string };
	pubKeyCredParams: Array<{ alg: number }>;
	timeout: number;
	excludeCredentials: Array<{ id: string; transports: string[] }>;
	residentKey: 'required' | 'preferred' | 'discouraged';
	userVerification: 'required' | 'preferred' | 'discouraged';
	authenticatorAttachment: 'platform' | 'cross-platform' | null;
}

const MAX_EXCLUDED_CREDENTIALS = 32;
const MAX_ALGORITHMS = 8;

function shortText(value: unknown, max: number): string | null {
	return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

/**
 * The creation options as the ceremony may use them, or null when anything is off. Reads ar-auth's
 * answer and the form this returns (the transaction keeps it), alike.
 */
export function readLitePasskeyCreationOptions(
	value: unknown,
	/** The most credentials taken in the exclude list (a sign-up's is short; an account's is all). */
	maxExcluded = MAX_EXCLUDED_CREDENTIALS
): LitePasskeyCreationOptions | null {
	const options = record(value);
	const challenge = options.challenge;
	if (typeof challenge !== 'string' || challenge.length > 512 || !BASE64URL.test(challenge)) {
		return null;
	}
	const rp = record(options.rp);
	const rpId = rp.id;
	const rpName = shortText(rp.name, 256);
	if (typeof rpId !== 'string' || !/^[A-Za-z0-9.-]{1,253}$/u.test(rpId) || !rpName) return null;
	const user = record(options.user);
	const userId = user.id;
	const userName = shortText(user.name, 256);
	const displayName = shortText(user.displayName, 256);
	if (typeof userId !== 'string' || userId.length > 128 || !BASE64URL.test(userId)) return null;
	if (!userName || !displayName) return null;
	const params = Array.isArray(options.pubKeyCredParams) ? options.pubKeyCredParams : [];
	if (params.length === 0 || params.length > MAX_ALGORITHMS) return null;
	const pubKeyCredParams: Array<{ alg: number }> = [];
	for (const entry of params) {
		const param = record(entry);
		if ((param.type !== undefined && param.type !== 'public-key') || !Number.isInteger(param.alg)) {
			return null;
		}
		pubKeyCredParams.push({ alg: param.alg as number });
	}
	const timeout =
		typeof options.timeout === 'number' && Number.isFinite(options.timeout)
			? Math.min(Math.max(Math.trunc(options.timeout), 10_000), 300_000)
			: 300_000;
	const listed = Array.isArray(options.excludeCredentials) ? options.excludeCredentials : [];
	if (listed.length > maxExcluded) return null;
	const excludeCredentials: LitePasskeyCreationOptions['excludeCredentials'] = [];
	for (const entry of listed) {
		const credential = record(entry);
		if (typeof credential.id !== 'string' || credential.id.length > MAX_CREDENTIAL_ID_CHARS) {
			return null;
		}
		if (!BASE64URL.test(credential.id)) return null;
		const transports = Array.isArray(credential.transports)
			? credential.transports.filter(
					(transport): transport is string =>
						typeof transport === 'string' && TRANSPORTS.has(transport)
				)
			: [];
		excludeCredentials.push({ id: credential.id, transports });
	}
	// ar-auth's `authenticatorSelection`, or the kept form's own fields.
	const selection =
		options.authenticatorSelection === undefined ? options : record(options.authenticatorSelection);
	const residentKey =
		selection.residentKey === 'preferred' || selection.residentKey === 'discouraged'
			? selection.residentKey
			: 'required';
	const userVerification =
		selection.userVerification === 'preferred' || selection.userVerification === 'discouraged'
			? selection.userVerification
			: 'required';
	const authenticatorAttachment =
		selection.authenticatorAttachment === 'platform' ||
		selection.authenticatorAttachment === 'cross-platform'
			? selection.authenticatorAttachment
			: null;
	return {
		challenge,
		rp: { id: rpId, name: rpName },
		user: { id: userId, name: userName, displayName },
		pubKeyCredParams,
		timeout,
		excludeCredentials,
		residentKey,
		userVerification,
		authenticatorAttachment
	};
}

/**
 * Starts a passkey's sign-up (`direct/passkey/signup/start`): the account (made now, unchecked),
 * the challenge to register and its creation options. `provisioning`: the account is still being
 * made (a routed tenant database), to be tried again.
 */
export async function startLitePasskeySignup(
	backend: LiteBackendClient,
	input: LiteSignupAccount & {
		codeChallenge: string;
		proof: string | null;
		authorizationChallengeId: string | null;
		interactionId: string;
		/** The account a start answered 202 for, now made (the same start, sent again). */
		resume?: { token: string; userId: string };
	}
): Promise<
	| { ok: true; challengeId: string; options: LitePasskeyCreationOptions }
	| {
			ok: false;
			error: string;
			status: number;
			provisioning: boolean;
			resume?: LiteProvisioningAnswer;
	  }
> {
	const answer = await backend.request('/api/v1/auth/direct/passkey/signup/start', {
		json: {
			client_id: loginUiClientId(),
			email: input.email,
			display_name: input.displayName ?? undefined,
			custom_fields: input.customFields,
			code_challenge: input.codeChallenge,
			code_challenge_method: 'S256',
			channel: 'browser',
			...(input.authorizationChallengeId
				? { authorization_challenge_id: input.authorizationChallengeId }
				: {}),
			...(input.proof ? { human_verification_response: input.proof } : {}),
			...(input.inviteToken ? { invite_token: input.inviteToken } : {}),
			...(input.inviteProof ? { invitation_email_proof: input.inviteProof } : {}),
			...(input.resume
				? { provisioning_token: input.resume.token, resume_user_id: input.resume.userId }
				: {})
		},
		headers: interactionHeaders(input.interactionId)
	});
	if (isProvisioning(answer)) {
		const resume = readLiteProvisioningAnswer(answer);
		return {
			ok: false,
			error: 'provisioning',
			status: 202,
			provisioning: true,
			...(resume ? { resume } : {})
		};
	}
	const json = record(answer.json);
	if (answer.status !== 200 || typeof json.challenge_id !== 'string' || !json.challenge_id) {
		return { ok: false, error: errorOf(answer), status: answer.status, provisioning: false };
	}
	const options = readLitePasskeyCreationOptions(json.options);
	if (!options) {
		return { ok: false, error: 'passkey_options_invalid', status: 502, provisioning: false };
	}
	return { ok: true, challengeId: json.challenge_id, options };
}

const MAX_ATTESTATION_CHARS = 6000;

/** The registration the page's ceremony posts, re-made from its checked fields (never raw). */
export function readLitePasskeyRegistration(
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
	if (
		!b64(credential.id, MAX_CREDENTIAL_ID_CHARS) ||
		!b64(credential.rawId, MAX_CREDENTIAL_ID_CHARS)
	) {
		return null;
	}
	if (credential.type !== 'public-key') return null;
	if (
		!b64(response.clientDataJSON, 2048) ||
		!b64(response.attestationObject, MAX_ATTESTATION_CHARS)
	) {
		return null;
	}
	const transports = Array.isArray(response.transports)
		? response.transports.filter(
				(transport): transport is string =>
					typeof transport === 'string' && TRANSPORTS.has(transport)
			)
		: [];
	const attachment = credential.authenticatorAttachment;
	return {
		id: credential.id,
		rawId: credential.rawId,
		type: 'public-key',
		response: {
			clientDataJSON: response.clientDataJSON,
			attestationObject: response.attestationObject,
			transports
		},
		clientExtensionResults: {},
		...(attachment === 'platform' || attachment === 'cross-platform'
			? { authenticatorAttachment: attachment }
			: {})
	};
}

/**
 * Checks the registration (`direct/passkey/signup/finish`): the one-time artifact the session is
 * made from. ar-auth spends the challenge on the first check, whatever its outcome.
 */
export async function finishLitePasskeySignup(
	backend: LiteBackendClient,
	input: { challengeId: string; credential: Record<string, unknown>; codeVerifier: string }
): Promise<
	{ ok: true; artifact: string; expiresIn: number } | { ok: false; error: string; status: number }
> {
	const answer = await backend.request('/api/v1/auth/direct/passkey/signup/finish', {
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

/** An authenticator's sign-up, begun: its challenge and the secret to add to the app. */
export interface LiteTotpSignup {
	challengeId: string;
	expiresIn: number;
	/** The secret (base32), for an app that cannot read the link or the code. */
	secret: string;
	/** The `otpauth://` link (and the QR code's text). */
	otpauthUri: string;
}

/**
 * Starts an authenticator's sign-up (`/api/auth/totp/signup/options`): the account (made now,
 * unchecked), the challenge and the secret.
 */
export async function startLiteTotpSignup(
	backend: LiteBackendClient,
	input: LiteSignupAccount & {
		proof: string | null;
		authorizationChallengeId: string | null;
		interactionId: string;
	}
): Promise<
	| ({ ok: true } & LiteTotpSignup)
	| { ok: false; error: string; status: number; provisioning: boolean }
> {
	const answer = await backend.request('/api/auth/totp/signup/options', {
		json: {
			email: input.email,
			...(input.displayName ? { name: input.displayName } : {}),
			custom_fields: input.customFields,
			...(input.authorizationChallengeId
				? { authorization_challenge_id: input.authorizationChallengeId }
				: {}),
			...(input.proof ? { human_verification_response: input.proof } : {}),
			...(input.inviteToken ? { invite_token: input.inviteToken } : {}),
			...(input.inviteProof ? { invitation_email_proof: input.inviteProof } : {})
		},
		headers: interactionHeaders(input.interactionId)
	});
	if (isProvisioning(answer)) {
		return { ok: false, error: 'provisioning', status: 202, provisioning: true };
	}
	const json = record(answer.json);
	const challengeId = shortText(json.challenge_id, 256);
	const secret =
		typeof json.secret === 'string' && /^[A-Z2-7]{16,128}=*$/u.test(json.secret)
			? json.secret
			: null;
	const otpauthUri =
		typeof json.otpauth_uri === 'string' &&
		json.otpauth_uri.length <= 1024 &&
		json.otpauth_uri.startsWith('otpauth://totp/')
			? json.otpauth_uri
			: null;
	if ((answer.status !== 200 && answer.status !== 201) || !challengeId) {
		return { ok: false, error: errorOf(answer), status: answer.status, provisioning: false };
	}
	if (!secret || !otpauthUri) {
		return { ok: false, error: 'totp_secret_invalid', status: 502, provisioning: false };
	}
	const expiresIn =
		typeof json.expires_in === 'number' && Number.isFinite(json.expires_in) && json.expires_in > 0
			? Math.min(json.expires_in, 900)
			: 600;
	return { ok: true, challengeId, expiresIn, secret, otpauthUri };
}

/**
 * Activates an authenticator's sign-up with a code from it (`/api/auth/totp/signup/activate`):
 * ar-auth makes the session (its cookies) and answers the backup codes, shown once. The
 * authorization request is left to the Flow (`defer_authorization_continuation`).
 */
export async function activateLiteTotpSignup(
	backend: LiteBackendClient,
	input: { challengeId: string; code: string }
): Promise<
	| { ok: true; backupCodes: string[]; redirectUrl: string | null }
	| { ok: false; error: string; invalidCode: boolean; status: number; provisioning: boolean }
> {
	const answer = await backend.request('/api/auth/totp/signup/activate', {
		json: {
			challenge_id: input.challengeId,
			code: input.code,
			defer_authorization_continuation: true
		}
	});
	if (isProvisioning(answer)) {
		return {
			ok: false,
			error: 'provisioning',
			invalidCode: false,
			status: 202,
			provisioning: true
		};
	}
	const json = record(answer.json);
	if (answer.status !== 200 || json.success !== true) {
		return {
			ok: false,
			error: errorOf(answer),
			invalidCode: answer.status === 400 || answer.status === 401,
			status: answer.status,
			provisioning: false
		};
	}
	const backupCodes = Array.isArray(json.backup_codes)
		? json.backup_codes
				.filter(
					(code): code is string => typeof code === 'string' && /^[A-Za-z0-9-]{4,32}$/u.test(code)
				)
				.slice(0, 32)
		: [];
	return {
		ok: true,
		backupCodes,
		redirectUrl:
			typeof json.redirect_url === 'string' && json.redirect_url ? json.redirect_url : null
	};
}
