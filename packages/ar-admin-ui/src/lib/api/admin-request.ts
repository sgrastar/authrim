import { getLocale } from '$i18n/i18n-svelte';
import {
	createBrowserSteps,
	runWithStepUp,
	STEP_UP_RECEIPT_HEADER
} from '#lib/api/admin-step-up.js';
import { settingsContext } from '#lib/stores/settings-context.svelte.js';

export const API_BASE_URL = import.meta.env.PUBLIC_API_BASE_URL || '';
const MAX_ADMIN_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TENANT_PLACEMENT_WRITE_FENCE_WAIT_MS = 30_000;
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function shouldAttachIdempotencyKey(method?: string): boolean {
	return !IDEMPOTENT_METHODS.has((method ?? 'GET').toUpperCase());
}

function createIdempotencyKey(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	const bytes = new Uint8Array(16);
	if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
		crypto.getRandomValues(bytes);
	}
	return `admin-ui-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function getPersistedTenantId(): string | null {
	if (typeof sessionStorage !== 'undefined') {
		const tenantId = sessionStorage.getItem('settings_tenant_id')?.trim();
		return tenantId && tenantId !== 'default' ? tenantId : null;
	}
	return null;
}

function resolveTenantId(candidate?: string): string | null {
	const resolved =
		candidate?.trim() ||
		settingsContext.tenantId?.trim() ||
		settingsContext.availableTenants[0]?.id ||
		getPersistedTenantId() ||
		'';

	return resolved || null;
}

export function buildAdminHeaders(
	headers?: HeadersInit,
	options: {
		tenantId?: string;
		includeJsonContentType?: boolean;
		skipTenantHeader?: boolean;
		method?: string;
	} = {}
): Headers {
	const resolvedHeaders = new Headers(headers);

	if (options.includeJsonContentType && !resolvedHeaders.has('Content-Type')) {
		resolvedHeaders.set('Content-Type', 'application/json');
	}

	const tenantId = resolveTenantId(options.tenantId);
	if (tenantId && !options.skipTenantHeader) {
		resolvedHeaders.set('X-Tenant-Id', tenantId);
	}

	if (shouldAttachIdempotencyKey(options.method) && !resolvedHeaders.has('Idempotency-Key')) {
		resolvedHeaders.set('Idempotency-Key', createIdempotencyKey());
	}

	return resolvedHeaders;
}

type AdminFetchOptions = RequestInit & {
	tenantId?: string;
	includeJsonContentType?: boolean;
	skipTenantHeader?: boolean;
	/** Set false for the step-up calls themselves. */
	stepUp?: boolean;
};

async function postStepUpJson(path: string, body: unknown): Promise<Record<string, unknown>> {
	const response = await adminFetch(`${API_BASE_URL}${path}`, {
		method: 'POST',
		includeJsonContentType: true,
		stepUp: false,
		body: JSON.stringify(body)
	});
	const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok) throw new Error(`Step-up request failed (${response.status})`);
	return payload;
}

const browserSteps = createBrowserSteps(postStepUpJson);

/** A request body that can be sent twice: streams are read into memory first. */
async function makeReplayable(options: RequestInit): Promise<RequestInit> {
	if (typeof ReadableStream !== 'undefined' && options.body instanceof ReadableStream) {
		return { ...options, body: await new Response(options.body).arrayBuffer() };
	}
	return options;
}

/**
 * Admin API fetch. A 403 asking for fresh authentication or step-up is met here (passkey,
 * security key, receipt) and the request is repeated once, so callers need no step-up code.
 */
export async function adminFetch(
	input: string,
	options: AdminFetchOptions = {}
): Promise<Response> {
	const { stepUp = true, ...rest } = options;
	if (!stepUp) {
		return sendAdminFetch(input, rest);
	}
	const replayable = await makeReplayable(rest);
	let attempt = 0;
	return runWithStepUp((receipt) => {
		attempt += 1;
		const headers = new Headers(replayable.headers);
		// A repeat (after a receipt, or after a passkey re-authentication alone) is a new request:
		// reusing the first attempt's idempotency key would replay its stored refusal.
		if (attempt > 1) headers.delete('Idempotency-Key');
		if (receipt) headers.set(STEP_UP_RECEIPT_HEADER, receipt);
		return sendAdminFetch(input, { ...replayable, headers });
	}, browserSteps);
}

async function sendAdminFetch(input: string, options: AdminFetchOptions): Promise<Response> {
	const {
		tenantId,
		includeJsonContentType = false,
		skipTenantHeader = false,
		headers,
		...rest
	} = options;

	const request: RequestInit = {
		...rest,
		credentials: rest.credentials ?? 'include',
		headers: buildAdminHeaders(headers, {
			tenantId,
			includeJsonContentType,
			skipTenantHeader,
			method: rest.method
		})
	};
	const deadline = Date.now() + MAX_TENANT_PLACEMENT_WRITE_FENCE_WAIT_MS;
	const replayable =
		typeof ReadableStream === 'undefined' || !(request.body instanceof ReadableStream);
	let response: Response;
	while (true) {
		response = await fetch(input, request);
		if (response.status !== 503 || !replayable) break;
		const body = (await response
			.clone()
			.json()
			.catch(() => null)) as { error?: unknown; extensions?: Record<string, unknown> } | null;
		if (body?.error === 'log_query_incomplete') {
			throw new Error(
				getLocale() === 'ja'
					? 'ログの取得が不完全です。集計結果は確定できません。期間を絞るか、時間をおいて再試行してください。'
					: 'Log results are incomplete. Statistics could not be confirmed. Narrow the period or retry later.'
			);
		}
		if (
			body?.error !== 'temporarily_unavailable' ||
			body.extensions?.reason !== 'tenant_placement_write_fence' ||
			body.extensions?.retryable !== true
		) {
			break;
		}
		const configuredDelay = Number(body.extensions.retry_after_ms);
		const delay = Math.min(
			2000,
			Math.max(250, Number.isFinite(configuredDelay) ? configuredDelay : 500)
		);
		if (Date.now() + delay >= deadline) break;
		await new Promise<void>((resolve, reject) => {
			const complete = () => {
				request.signal?.removeEventListener('abort', abort);
				resolve();
			};
			const timer = globalThis.setTimeout(complete, delay);
			const abort = () => {
				globalThis.clearTimeout(timer);
				request.signal?.removeEventListener('abort', abort);
				reject(new DOMException('Admin request was cancelled', 'AbortError'));
			};
			if (request.signal?.aborted) return abort();
			request.signal?.addEventListener('abort', abort, { once: true });
		});
	}

	const contentLength = response.headers.get('content-length');
	if (contentLength) {
		const parsed = Number.parseInt(contentLength, 10);
		if (Number.isFinite(parsed) && parsed > MAX_ADMIN_API_RESPONSE_BYTES) {
			throw new Error('Admin API response is too large');
		}
	}

	return response;
}
