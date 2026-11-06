/**
 * Keyring as a step-up second factor (Admin API, /api/admin/me/keyring):
 *
 *   POST /step-up          start a presentation that verifies a registered Keyring factor
 *   GET  /step-up/:id      its progress; the server records the factor once verified
 *   POST /enroll           start a presentation that registers the holder key (L2 receipt)
 *   GET  /enroll/:id       its progress; the server registers the key once verified
 *
 * Failures are ApiErrors, so withStepUp can answer a step-up or fresh sign-in refusal.
 */
import { adminFetch, API_BASE_URL } from '#lib/api/admin-request.js';
import { errorFromResponse } from '#lib/api/api-error.js';
import type {
	PresentationProgress,
	PresentationStart
} from '#lib/keyring/presentation-flow.svelte.js';

const BASE = `${API_BASE_URL}/api/admin/me/keyring`;

const STATUSES: ReadonlySet<string> = new Set([
	'pending',
	'processing',
	'verified',
	'failed',
	'expired',
	'consumed'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function parseStart(body: unknown): PresentationStart {
	if (
		!isRecord(body) ||
		typeof body.request_id !== 'string' ||
		typeof body.qr !== 'string' ||
		!body.qr.startsWith('openid4vp://') ||
		typeof body.match_code !== 'string' ||
		!/^\d{2}$/.test(body.match_code) ||
		typeof body.expires_at !== 'number'
	) {
		throw new Error('Unexpected Keyring presentation response');
	}
	return {
		requestId: body.request_id,
		qr: body.qr,
		matchCode: body.match_code,
		expiresAt: body.expires_at
	};
}

function parseProgress(body: unknown): PresentationProgress {
	if (!isRecord(body) || typeof body.status !== 'string' || !STATUSES.has(body.status)) {
		throw new Error('Unexpected Keyring presentation progress');
	}
	return {
		status: body.status as PresentationProgress['status'],
		...(typeof body.error === 'string' ? { error: body.error } : {})
	};
}

async function post(path: string, receipt?: string): Promise<PresentationStart> {
	const response = await adminFetch(`${BASE}${path}`, {
		method: 'POST',
		credentials: 'include',
		headers: {
			'Content-Type': 'application/json',
			...(receipt ? { 'authrim-step-up-receipt': receipt } : {})
		},
		body: '{}'
	});
	if (!response.ok) throw await errorFromResponse(response);
	return parseStart(await response.json().catch(() => null));
}

async function get(path: string): Promise<PresentationProgress> {
	const response = await adminFetch(`${BASE}${path}`, { credentials: 'include' });
	// The enrolment answers a refusal of the final step with its status in the body.
	const body: unknown = await response
		.clone()
		.json()
		.catch(() => null);
	if (!response.ok && !(isRecord(body) && body.status === 'failed')) {
		throw await errorFromResponse(response);
	}
	return parseProgress(body);
}

export interface KeyringFactorClient {
	startStepUp(): Promise<PresentationStart>;
	stepUpProgress(requestId: string): Promise<PresentationProgress>;
	startEnroll(receipt?: string): Promise<PresentationStart>;
	enrollProgress(requestId: string): Promise<PresentationProgress>;
}

export const httpKeyringFactor: KeyringFactorClient = {
	startStepUp: () => post('/step-up'),
	stepUpProgress: (id) => get(`/step-up/${encodeURIComponent(id)}`),
	startEnroll: (receipt) => post('/enroll', receipt),
	enrollProgress: (id) => get(`/enroll/${encodeURIComponent(id)}`)
};
