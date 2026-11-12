/**
 * The backend calls of a lite sign-in by email code and as a guest, the ones the SPA makes
 * (lib/api/client.ts `emailCodeAPI`, `guestAPI`): from a verified form post only.
 *
 * The SPA keeps the code's PKCE verifier and attempt in sessionStorage; here the server makes the
 * verifier and keeps both in the lite transaction.
 */
import type { FlowRuntimeStep } from '#lib/api/flow-runtime.js';
import type { LiteBackendClient } from './backend-client';
import type { LiteFlowState } from './flow-driver';
import { readLiteProvisioningAnswer, type LiteProvisioningAnswer } from './provisioning';

/** The Login UI's client (lib/auth.ts `getClientId`): what the direct sign-in APIs act for. */
export function loginUiClientId(): string {
	const configured = import.meta.env.PUBLIC_LOGIN_UI_CLIENT_ID as string | undefined;
	return configured || 'login-ui';
}

function base64Url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replace(/\+/gu, '-')
		.replace(/\//gu, '_')
		.replace(/=+$/u, '');
}

/** A PKCE verifier (32 random bytes) and its S256 challenge. */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

function record(json: unknown): Record<string, unknown> {
	return typeof json === 'object' && json !== null && !Array.isArray(json)
		? (json as Record<string, unknown>)
		: {};
}

function errorOf(answer: { status: number; json: unknown }): string {
	const error = record(answer.json).error;
	return typeof error === 'string' ? error : `status_${answer.status}`;
}

/**
 * Sends a code. The answer looks the same whether a code went out or not (a refused proof, a
 * limited address, an unknown one): the page says a code was sent either way, as the SPA does.
 * The action header is the page's: `login` on the sign-in page (without it an unknown address is
 * checked as a sign-up, and a login proof would not do); `signup` on the sign-up page, which sends
 * the account's profile and the invitation it takes (the SPA's `emailCodeAPI.send`).
 */
export async function sendLiteEmailCode(
	backend: LiteBackendClient,
	input: {
		email: string;
		proof: string | null;
		codeChallenge: string;
		authorizationChallengeId: string | null;
		/** The Flow's interaction (none for a re-authentication, which runs no Flow). */
		interactionId: string | null;
		/** A re-authentication's send (ar-auth takes the challenge's action; no page action). */
		reauth?: boolean;
		/** A sign-up's profile and invitation (the sign-up page's send). */
		signup?: {
			displayName: string | null;
			customFields: Record<string, string>;
			inviteToken: string | null;
		};
	}
): Promise<
	| { ok: true; attemptId: string; maskedEmail: string | null }
	| {
			ok: false;
			error: string;
			status: number;
			provisioning?: LiteProvisioningAnswer;
			/** On `account_not_found`: whether the Flow offers a sign-up for the address. */
			signUpAvailable?: boolean;
	  }
> {
	const signup = input.signup;
	const answer = await backend.request('/api/v1/auth/direct/email-code/send', {
		json: {
			client_id: loginUiClientId(),
			email: input.email,
			code_challenge: input.codeChallenge,
			code_challenge_method: 'S256',
			channel: 'browser',
			authorization_challenge_id: input.authorizationChallengeId ?? undefined,
			human_verification_response: input.proof ?? undefined,
			runtime_interaction_id: input.interactionId ?? undefined,
			...(signup
				? {
						display_name: signup.displayName ?? undefined,
						custom_fields: signup.customFields,
						invite_token: signup.inviteToken ?? undefined
					}
				: {})
		},
		headers: input.reauth
			? {}
			: { 'X-Authrim-Human-Verification-Action': signup ? 'signup' : 'login' }
	});
	// A new address whose account is still being made (a routed tenant database): sent again
	// once it exists (provisioning.ts).
	const provisioning = readLiteProvisioningAnswer(answer);
	if (provisioning) return { ok: false, error: 'provisioning', status: 202, provisioning };
	const json = record(answer.json);
	if (answer.status !== 200 || typeof json.attempt_id !== 'string') {
		return {
			ok: false,
			error: errorOf(answer),
			status: answer.status,
			...(json.sign_up_available === true ? { signUpAvailable: true } : {})
		};
	}
	return {
		ok: true,
		attemptId: json.attempt_id,
		maskedEmail: typeof json.masked_email === 'string' ? json.masked_email : null
	};
}

/** Checks a code: its one-time artifact (what makes the session), with how long it lasts. */
export async function checkLiteEmailCode(
	backend: LiteBackendClient,
	input: { attemptId: string; code: string; codeVerifier: string }
): Promise<
	| { ok: true; artifact: string; expiresIn: number }
	| { ok: false; error: string; invalidCode: boolean; status: number }
> {
	const verified = await backend.request('/api/v1/auth/direct/email-code/verify', {
		json: {
			attempt_id: input.attemptId,
			code: input.code,
			code_verifier: input.codeVerifier,
			channel: 'browser'
		}
	});
	const json = record(verified.json);
	if (verified.status !== 200 || typeof json.direct_auth_artifact !== 'string') {
		return {
			ok: false,
			error: errorOf(verified),
			invalidCode: verified.status === 400 || verified.status === 401,
			status: verified.status
		};
	}
	const expiresIn =
		typeof json.expires_in === 'number' && Number.isFinite(json.expires_in) && json.expires_in > 0
			? Math.min(json.expires_in, 600)
			: 60;
	return { ok: true, artifact: json.direct_auth_artifact, expiresIn };
}

/** Makes the session from a checked code's artifact (its cookies go into the action's jar). */
export async function createLiteDirectSession(
	backend: LiteBackendClient,
	input: {
		artifact: string;
		codeVerifier: string;
		authorizationChallengeId: string | null;
		/**
		 * Whether the session's answer continues the authorization request itself (a
		 * re-authentication, which runs no Flow); else the Flow's completion does.
		 */
		continueAuthorization?: boolean;
	}
): Promise<
	{ ok: true; redirectUrl: string | null } | { ok: false; error: string; status: number }
> {
	const session = await backend.request('/api/v1/auth/direct/session', {
		json: {
			direct_auth_artifact: input.artifact,
			client_id: loginUiClientId(),
			code_verifier: input.codeVerifier,
			channel: 'browser',
			authorization_challenge_id: input.authorizationChallengeId ?? undefined,
			// The Flow's completion continues the authorization request, not this call (unless no
			// Flow runs).
			defer_authorization_continuation: input.continueAuthorization !== true
		}
	});
	if (session.status !== 200) return { ok: false, error: errorOf(session), status: session.status };
	// Where the backend sends a direct sign-in (the tenant's post-login page): the fallback when
	// the Flow's completion names no destination and the request no return target.
	const redirectUrl = record(session.json).redirect_url;
	return { ok: true, redirectUrl: typeof redirectUrl === 'string' ? redirectUrl : null };
}

/** A guest sign-in (its cookies go into the action's jar). */
export async function liteGuestLogin(
	backend: LiteBackendClient,
	input: { authorizationChallengeId: string | null; proof: string | null }
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
	// For an authorization request, its own client; otherwise the Login UI's (a cookie session
	// only), as the SPA does.
	const answer = await backend.request('/api/auth/guest/login', {
		json: {
			...(input.authorizationChallengeId
				? { authorizationChallengeId: input.authorizationChallengeId }
				: { clientId: loginUiClientId() }),
			human_verification_response: input.proof ?? undefined
		}
	});
	return answer.status === 200 && record(answer.json).success === true
		? { ok: true }
		: { ok: false, error: errorOf(answer), status: answer.status };
}

/** Submits the person's own choice on a step (the SPA's `continueAfterRuntimeStep`). */
export async function submitLiteStep(
	backend: LiteBackendClient,
	state: LiteFlowState,
	step: FlowRuntimeStep,
	handle: string,
	/** What the step's submit carries (a consent's decisions); nothing, by default. */
	input: Record<string, unknown> = {},
	/** The visit of the step the page was drawn on: one submitted on an earlier visit is refused. */
	visitId: string | null = null
): Promise<
	| {
			ok: true;
			completed: boolean;
			output: Record<string, unknown> | null;
			step: FlowRuntimeStep | null;
	  }
	| { ok: false; error: string }
> {
	const answer = await backend.request(
		`/api/v1/login/interactions/${encodeURIComponent(state.interactionId)}/submit`,
		{
			json: {
				step_id: step.id,
				node_id: step.source_node_id,
				selected_handle: handle,
				contract_hash: state.contractHash,
				signature: state.signature,
				input,
				...(visitId ? { visit_id: visitId } : {})
			}
		}
	);
	const json = record(answer.json);
	if (answer.status !== 200) return { ok: false, error: errorOf(answer) };
	return {
		ok: true,
		completed: json.completed === true,
		output: Object.keys(record(json.output)).length > 0 ? record(json.output) : null,
		step: Object.keys(record(json.step)).length > 0 ? (json.step as FlowRuntimeStep) : null
	};
}
