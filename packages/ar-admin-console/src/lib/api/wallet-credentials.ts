/**
 * The signed-in administrator's own wallet credential (Authrim Keyring).
 *
 *   POST /api/admin/me/wallet-credentials/offers          create an offer (QR + transaction code)
 *   GET  /api/admin/me/wallet-credentials/offers/:offerId its progress, read-only
 *   GET  /api/admin/me/wallet-credentials                 the admin's own credentials (and which
 *                                                         carry a second-factor key)
 *   POST /api/admin/me/wallet-credentials/:id/revoke      revoke one (fresh sign-in required)
 *
 * The offer and the transaction code are secrets for a few minutes: this module never logs or
 * stores them; the caller keeps them in memory only.
 */
import { isFreshAuthRequired } from '#lib/api/admin-reauth.js';
import { adminFetch } from '#lib/api/admin-request.js';
import { stepUpHeaders, stepUpRequired, withStepUp } from '#lib/api/admin-step-up.js';
import { ApiError, errorFromResponse } from '#lib/api/api-error.js';
import type { MessageKey } from '#lib/i18n/i18n.svelte.js';

const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';

export type WalletOfferState =
	| 'pending'
	| 'fetched'
	| 'token_issued'
	| 'issued'
	| 'failed'
	| 'expired'
	| 'locked';

const OFFER_STATES: ReadonlySet<string> = new Set<WalletOfferState>([
	'pending',
	'fetched',
	'token_issued',
	'issued',
	'failed',
	'expired',
	'locked'
]);

export interface WalletOffer {
	offerId: string;
	/** `openid-credential-offer://?credential_offer_uri=…`: only ever drawn as a QR code. */
	credentialOffer: string;
	/** 6 digits, shown only once the wallet has fetched the offer. */
	transactionCode: string;
	/** Milliseconds since the epoch. */
	expiresAt: number;
}

export interface WalletOfferStatus {
	offerId: string;
	state: WalletOfferState;
	expiresAt: number;
	/** base64url RFC 7638 thumbprint of the holder key; present once issued. */
	holderKeyThumbprint?: string;
}

export type WalletCredentialStatus = 'active' | 'suspended' | 'revoked';

/** One of the signed-in admin's own credentials. */
export interface WalletCredential {
	id: string;
	status: WalletCredentialStatus;
	/** Milliseconds since the epoch. */
	issuedAt: number;
	/** Milliseconds since the epoch; null when unknown. */
	expiresAt: number | null;
	/** base64url RFC 7638 thumbprint of the holder key; absent for older credentials. */
	holderKeyThumbprint?: string;
	/**
	 * Whether the holder key is one of the admin's active second factors. Revoking such a
	 * credential also revokes that factor, even when a renewed credential shares the key.
	 */
	secondFactor: boolean;
}

const CREDENTIAL_STATUSES: ReadonlySet<string> = new Set<WalletCredentialStatus>([
	'active',
	'suspended',
	'revoked'
]);

export const FRESH_AUTH_REQUIRED = 'wallet_credential_fresh_auth_required';
export const NOT_ELIGIBLE = 'wallet_credential_not_eligible';

/** A failed wallet-credential call. `code` is the API's error code, or a local one. */
export class WalletCredentialError extends Error {
	constructor(
		public code: string,
		public status: number,
		message = code
	) {
		super(message);
		this.name = 'WalletCredentialError';
	}
}

/** What the page needs; the real client and test doubles both implement it. */
export interface WalletCredentialsClient {
	createOffer(): Promise<WalletOffer>;
	getOfferStatus(offerId: string): Promise<WalletOfferStatus>;
}

/** Listing and revoking the admin's credentials (the Keyring page's credential list). */
export interface WalletCredentialManager {
	listCredentials(): Promise<WalletCredential[]>;
	/** Revoking twice is fine: the server answers 200 again. */
	revokeCredential(credentialId: string): Promise<void>;
}

async function errorFrom(response: Response): Promise<WalletCredentialError> {
	const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
	const code = typeof body?.error === 'string' && body.error ? body.error : '';
	if (code) return new WalletCredentialError(code, response.status);
	if (response.status === 404) return new WalletCredentialError('not_found', 404);
	if (response.status === 503) return new WalletCredentialError('vc_unavailable', 503);
	return new WalletCredentialError(`http_${response.status}`, response.status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function parseOffer(body: unknown): WalletOffer {
	if (
		!isRecord(body) ||
		typeof body.offerId !== 'string' ||
		typeof body.credentialOffer !== 'string' ||
		typeof body.transactionCode !== 'string' ||
		typeof body.expiresAt !== 'number'
	) {
		throw new WalletCredentialError('invalid_response', 200);
	}
	return {
		offerId: body.offerId,
		credentialOffer: body.credentialOffer,
		transactionCode: body.transactionCode,
		expiresAt: body.expiresAt
	};
}

function parseStatus(body: unknown): WalletOfferStatus {
	if (
		!isRecord(body) ||
		typeof body.offerId !== 'string' ||
		typeof body.state !== 'string' ||
		!OFFER_STATES.has(body.state) ||
		typeof body.expiresAt !== 'number'
	) {
		throw new WalletCredentialError('invalid_response', 200);
	}
	return {
		offerId: body.offerId,
		state: body.state as WalletOfferState,
		expiresAt: body.expiresAt,
		...(typeof body.holderKeyThumbprint === 'string'
			? { holderKeyThumbprint: body.holderKeyThumbprint }
			: {})
	};
}

function parseCredentials(body: unknown): WalletCredential[] {
	if (!isRecord(body) || !Array.isArray(body.items)) {
		throw new WalletCredentialError('invalid_response', 200);
	}
	return body.items.map((item): WalletCredential => {
		if (
			!isRecord(item) ||
			typeof item.id !== 'string' ||
			typeof item.status !== 'string' ||
			!CREDENTIAL_STATUSES.has(item.status) ||
			typeof item.issuedAt !== 'number' ||
			!(item.expiresAt === null || typeof item.expiresAt === 'number')
		) {
			throw new WalletCredentialError('invalid_response', 200);
		}
		return {
			id: item.id,
			status: item.status as WalletCredentialStatus,
			issuedAt: item.issuedAt,
			expiresAt: item.expiresAt,
			...(typeof item.holderKeyThumbprint === 'string'
				? { holderKeyThumbprint: item.holderKeyThumbprint }
				: {}),
			secondFactor: item.secondFactor === true
		};
	});
}

export const httpWalletCredentials: WalletCredentialsClient & WalletCredentialManager = {
	async listCredentials() {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/me/wallet-credentials`, {
			credentials: 'include'
		});
		if (!response.ok) throw await errorFrom(response);
		return parseCredentials(await response.json().catch(() => null));
	},

	async revokeCredential(credentialId) {
		// Revoking an admin credential is an L2 operation: the step-up runs here and the request is
		// repeated with the receipt. Other refusals keep their wallet error codes.
		try {
			await withStepUp(async (receipt) => {
				const response = await adminFetch(
					`${API_BASE_URL}/api/admin/me/wallet-credentials/${encodeURIComponent(credentialId)}/revoke`,
					{ method: 'POST', credentials: 'include', headers: stepUpHeaders(receipt) }
				);
				if (response.ok) return;
				if (response.status === 403) {
					const error = await errorFromResponse(response.clone());
					if (stepUpRequired(error) || isFreshAuthRequired(error)) throw error;
				}
				throw await errorFrom(response);
			});
		} catch (error) {
			// A refusal that survived the step-up keeps the wallet error contract of the page.
			if (error instanceof ApiError) throw new WalletCredentialError(error.code, error.status);
			throw error;
		}
	},

	async createOffer() {
		const response = await adminFetch(`${API_BASE_URL}/api/admin/me/wallet-credentials/offers`, {
			method: 'POST',
			credentials: 'include'
		});
		if (!response.ok) throw await errorFrom(response);
		return parseOffer(await response.json().catch(() => null));
	},

	async getOfferStatus(offerId) {
		const response = await adminFetch(
			`${API_BASE_URL}/api/admin/me/wallet-credentials/offers/${encodeURIComponent(offerId)}`,
			{ credentials: 'include' }
		);
		if (!response.ok) throw await errorFrom(response);
		return parseStatus(await response.json().catch(() => null));
	}
};

/** Message key for a failed offer request. */
export function walletCredentialErrorKey(error: unknown): MessageKey {
	if (error instanceof WalletCredentialError) {
		switch (error.code) {
			case FRESH_AUTH_REQUIRED:
				return 'keyring.error.freshAuth';
			case NOT_ELIGIBLE:
				return 'keyring.error.notEligible';
			case 'vc_unavailable':
				return 'keyring.error.unavailable';
		}
	}
	return 'keyring.error.generic';
}

/** Message key for a failed revocation or credential list. */
export function revokeErrorKey(error: unknown): MessageKey {
	if (error instanceof WalletCredentialError) {
		if (error.code === FRESH_AUTH_REQUIRED) return 'keyring.error.freshAuth';
		if (error.status === 503) return 'keyring.credentials.error.busy';
	}
	return 'keyring.error.generic';
}
