/**
 * A sign-up whose account is still being made (lite PR6d). On a tenant whose accounts live in a
 * routed database, ar-auth answers the first email-code send or passkey start of a new address
 * with 202: the account is being made, and the same request is to be sent again once it exists
 * (the SPA polls `/api/v1/auth/account-provisioning/status` and resends). The lite page keeps that
 * request in the transaction and draws a Continue: its post checks the status once and, once the
 * account is ready, sends the request again (with a new proof of work: ar-auth takes none from a
 * lite tenant's resumed request).
 */
import type { LiteBackendClient } from './backend-client';
import { record } from './totp-passkey';

/** What a 202 answer gives to go on with (its token, how long it lasts, whose account it is). */
export interface LiteProvisioningAnswer {
	token: string;
	expiresAt: number;
	/** The user a passkey's sign-up resumes as (only a passkey's answer names one). */
	resumeUserId: string | null;
}

/** ar-auth's resume token (account-provisioning.ts `RESUME_TOKEN`). */
const RESUME_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
/** At most as long as ar-auth keeps the token (5 minutes). */
const MAX_EXPIRES_IN = 300;

/** The account being made, from a 202 answer; null for any other answer. */
export function readLiteProvisioningAnswer(answer: {
	status: number;
	json: unknown;
}): LiteProvisioningAnswer | null {
	const json = record(answer.json);
	if (
		answer.status !== 202 ||
		json.status !== 'provisioning' ||
		typeof json.provisioning_token !== 'string' ||
		!RESUME_TOKEN.test(json.provisioning_token)
	) {
		return null;
	}
	const expiresIn =
		typeof json.expires_in === 'number' && Number.isFinite(json.expires_in) && json.expires_in > 0
			? Math.min(json.expires_in, MAX_EXPIRES_IN)
			: MAX_EXPIRES_IN;
	const resumeUserId =
		typeof json.resume_user_id === 'string' &&
		json.resume_user_id.length > 0 &&
		json.resume_user_id.length <= 128
			? json.resume_user_id
			: null;
	return {
		token: json.provisioning_token,
		expiresAt: Date.now() + expiresIn * 1000,
		resumeUserId
	};
}

/** The email-code send to send again: as it was, its PKCE pair kept (ar-auth keys the resume by it). */
export interface LiteProvisioningEmailCode {
	kind: 'email_code';
	choiceStepId: string;
	email: string;
	verifier: string;
	codeChallenge: string;
	/** A sign-up's profile (null for a sign-in page's send, which signs up an unknown address). */
	profile: { displayName: string | null; customFields: Record<string, string> } | null;
	inviteToken: string | null;
}

/** The passkey start to send again, with the account it resumes. */
export interface LiteProvisioningPasskey {
	kind: 'passkey';
	choiceStepId: string;
	email: string;
	displayName: string | null;
	customFields: Record<string, string>;
	inviteToken: string | null;
	inviteProof: string | null;
	resumeUserId: string;
}

/** A sign-up held until its account exists, as the transaction keeps it. */
export interface LiteProvisioning {
	interactionId: string;
	/** Names this hold (a Continue drawn for another is not taken for it). */
	id: string;
	token: string;
	expiresAt: number;
	/** Sends made again that did not go (each names the next its own). */
	tries?: number;
	/** The try a Continue began (marked before it is made; a later Continue takes it up again). */
	trying?: number;
	request: LiteProvisioningEmailCode | LiteProvisioningPasskey;
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every((entry) => typeof entry === 'string')
	);
}

function nullableString(value: unknown): string | null | undefined {
	return value === null ? null : typeof value === 'string' ? value : undefined;
}

function readRequest(value: unknown): LiteProvisioning['request'] | null {
	const request = record(value);
	if (typeof request.choiceStepId !== 'string' || typeof request.email !== 'string') return null;
	if (request.kind === 'email_code') {
		const profile = request.profile === null ? null : record(request.profile);
		const displayName = profile ? nullableString(profile.displayName) : null;
		const inviteToken = nullableString(request.inviteToken);
		if (
			typeof request.verifier !== 'string' ||
			typeof request.codeChallenge !== 'string' ||
			displayName === undefined ||
			(profile !== null && !isStringRecord(profile.customFields)) ||
			inviteToken === undefined
		) {
			return null;
		}
		return {
			kind: 'email_code',
			choiceStepId: request.choiceStepId,
			email: request.email,
			verifier: request.verifier,
			codeChallenge: request.codeChallenge,
			profile: profile
				? { displayName, customFields: profile.customFields as Record<string, string> }
				: null,
			inviteToken
		};
	}
	if (request.kind === 'passkey') {
		const displayName = nullableString(request.displayName);
		const inviteToken = nullableString(request.inviteToken);
		const inviteProof = nullableString(request.inviteProof);
		if (
			typeof request.resumeUserId !== 'string' ||
			displayName === undefined ||
			!isStringRecord(request.customFields) ||
			inviteToken === undefined ||
			inviteProof === undefined
		) {
			return null;
		}
		return {
			kind: 'passkey',
			choiceStepId: request.choiceStepId,
			email: request.email,
			displayName,
			customFields: request.customFields,
			inviteToken,
			inviteProof,
			resumeUserId: request.resumeUserId
		};
	}
	return null;
}

/**
 * The sign-up held for its account in this interaction (expired or not: an expired one is drawn
 * so it can be started over); null when none.
 */
export function readLiteProvisioning(
	data: Record<string, unknown>,
	interactionId: string
): LiteProvisioning | null {
	const held = record(data.provisioning);
	if (
		held.interactionId !== interactionId ||
		typeof held.id !== 'string' ||
		typeof held.token !== 'string' ||
		typeof held.expiresAt !== 'number'
	) {
		return null;
	}
	const request = readRequest(held.request);
	if (!request) return null;
	const tries =
		typeof held.tries === 'number' && Number.isInteger(held.tries) && held.tries >= 0
			? held.tries
			: 0;
	return {
		interactionId,
		id: held.id,
		token: held.token,
		expiresAt: held.expiresAt,
		tries,
		...(typeof held.trying === 'number' && Number.isInteger(held.trying)
			? { trying: held.trying }
			: {}),
		request
	};
}

/** A hold's id (random; it names the Continue drawn for it). */
export function newLiteProvisioningId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/gu, '-')
		.replace(/\//gu, '_')
		.replace(/=+$/u, '');
}

/** The account's state: `ready` to send the request again, `pending` still, `failed` never. */
export async function checkLiteProvisioning(
	backend: LiteBackendClient,
	token: string
): Promise<'ready' | 'pending' | 'failed' | 'unavailable'> {
	const answer = await backend.request('/api/v1/auth/account-provisioning/status', {
		json: { provisioning_token: token }
	});
	const status = record(answer.json).status;
	if (answer.status === 200 && (status === 'ready' || status === 'pending')) return status;
	// Failed, or a token that no longer stands for an account being made (expired).
	if (answer.status === 409 || answer.status === 400) return 'failed';
	return 'unavailable';
}
