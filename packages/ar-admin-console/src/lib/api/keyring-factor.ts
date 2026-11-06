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
	BrowserPresentationStart,
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

function parseBrowserStart(body: unknown): BrowserPresentationStart {
	const dc = isRecord(body) ? body.dc_request : null;
	if (
		!isRecord(body) ||
		typeof body.request_id !== 'string' ||
		typeof body.expires_at !== 'number' ||
		!isRecord(dc) ||
		typeof dc.protocol !== 'string' ||
		!isRecord(dc.data) ||
		typeof dc.data.request !== 'string'
	) {
		throw new Error('Unexpected Keyring browser request');
	}
	return {
		requestId: body.request_id,
		expiresAt: body.expires_at,
		dcRequest: { protocol: dc.protocol, data: { request: dc.data.request } }
	};
}

async function postJson(path: string, body: unknown, receipt?: string): Promise<unknown> {
	const response = await adminFetch(`${BASE}${path}`, {
		method: 'POST',
		credentials: 'include',
		headers: {
			'Content-Type': 'application/json',
			...(receipt ? { 'authrim-step-up-receipt': receipt } : {})
		},
		body: JSON.stringify(body)
	});
	// A refusal of the final step answers with its status in the body.
	const parsed: unknown = await response
		.clone()
		.json()
		.catch(() => null);
	if (!response.ok && !(isRecord(parsed) && parsed.status === 'failed')) {
		throw await errorFromResponse(response);
	}
	return parsed;
}

async function post(path: string, receipt?: string): Promise<PresentationStart> {
	return parseStart(await postJson(path, {}, receipt));
}

async function postInBrowser(path: string, receipt?: string): Promise<BrowserPresentationStart> {
	return parseBrowserStart(await postJson(path, { mode: 'dc_api' }, receipt));
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
	/** Digital Credentials API: a request for the browser, and the answer it gave. */
	startStepUpInBrowser(): Promise<BrowserPresentationStart>;
	submitStepUp(requestId: string, data: unknown): Promise<PresentationProgress>;
	startEnrollInBrowser(receipt?: string): Promise<BrowserPresentationStart>;
	submitEnroll(requestId: string, data: unknown): Promise<PresentationProgress>;
}

export const httpKeyringFactor: KeyringFactorClient = {
	startStepUp: () => post('/step-up'),
	stepUpProgress: (id) => get(`/step-up/${encodeURIComponent(id)}`),
	startEnroll: (receipt) => post('/enroll', receipt),
	enrollProgress: (id) => get(`/enroll/${encodeURIComponent(id)}`),
	startStepUpInBrowser: () => postInBrowser('/step-up'),
	submitStepUp: async (id, data) =>
		parseProgress(
			await postJson(`/step-up/${encodeURIComponent(id)}/response`, { response: data })
		),
	startEnrollInBrowser: (receipt) => postInBrowser('/enroll', receipt),
	submitEnroll: async (id, data) =>
		parseProgress(await postJson(`/enroll/${encodeURIComponent(id)}/response`, { response: data }))
};
