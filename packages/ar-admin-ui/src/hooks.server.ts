/**
 * SvelteKit Server Hooks for Safari ITP Compatibility
 *
 * This hook proxies /api/* requests to the backend API server.
 * By proxying through the same UI Worker origin,
 * Safari's ITP (Intelligent Tracking Prevention) won't block cookies.
 *
 * Without this proxy:
 *   Browser (UI Worker) -> API (workers.dev) = Cross-site, cookies blocked by Safari ITP
 *
 * With this proxy:
 *   Browser (UI Worker) -> SvelteKit Server (UI Worker) -> API (workers.dev) = Same-site, cookies work
 *
 * To disable the proxy (e.g., when using custom domains on the same site):
 *   Set API_BACKEND_URL to an empty or invalid value in the deployment env
 */

import { env as dynamicEnv } from '$env/dynamic/public';
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';

interface ServiceBinding {
	fetch(request: Request): Promise<Response>;
}

const MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 30000;
const LOCAL_ADMIN_PROXY_FLAG = 'AUTHRIM_ALLOW_LOCAL_ADMIN_PROXY';
const ADMIN_MACHINE_AUDIENCE = 'authrim:admin-api';
const ADMIN_UI_BFF_DEFAULT_SCOPE = 'admin-ui:proxy';
const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

type ProxyBody = ArrayBuffer | undefined;

type ProxySecurityEventResult = 'rejected' | 'failed';

type ProxySecurityEventMetadata = Record<string, string | number | boolean | undefined>;

interface AdminUiBffMachineCredentialConfig {
	clientId: string;
	keyId: string;
	privateKeyPem: string;
	scopes: string;
}

interface BffTokenRequestOptions {
	tenantId?: string | null;
	sendRequest?: (request: Request) => Promise<Response>;
}

function isLoopbackHost(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isHttpsUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

function isLoopbackProxyUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return ['http:', 'https:'].includes(parsed.protocol) && isLoopbackHost(parsed.hostname);
	} catch {
		return false;
	}
}

function getHttpsUrl(candidate: unknown): string | undefined {
	const value = String(candidate || '').trim();
	if (!value || value === '__DISABLED__' || !isHttpsUrl(value)) {
		return undefined;
	}

	return value;
}

function getLocalProxyFlag(platformEnv?: Record<string, unknown>): boolean {
	const importMetaEnv = import.meta.env as Record<string, string | undefined>;
	const candidates = [
		platformEnv?.[LOCAL_ADMIN_PROXY_FLAG],
		importMetaEnv[LOCAL_ADMIN_PROXY_FLAG],
		typeof process !== 'undefined' ? process.env?.[LOCAL_ADMIN_PROXY_FLAG] : undefined
	];

	return candidates.some((candidate) => String(candidate || '').toLowerCase() === 'true');
}

function getBackendUrlCandidates(platformEnv?: Record<string, unknown>): unknown[] {
	return [
		platformEnv?.API_BACKEND_URL,
		platformEnv?.PUBLIC_API_PROXY_BACKEND_URL,
		dynamicEnv.PUBLIC_API_PROXY_BACKEND_URL,
		import.meta.env.PUBLIC_API_PROXY_BACKEND_URL,
		typeof process !== 'undefined' ? process.env?.API_BACKEND_URL : undefined,
		typeof process !== 'undefined' ? process.env?.PUBLIC_API_PROXY_BACKEND_URL : undefined
	];
}

function hasConfiguredBackendUrl(platformEnv?: Record<string, unknown>): boolean {
	return getBackendUrlCandidates(platformEnv).some((candidate) => {
		const value = String(candidate || '').trim();
		return value.length > 0 && value !== '__DISABLED__';
	});
}

function getConfiguredLocalBackendUrl(platformEnv?: Record<string, unknown>): string | undefined {
	for (const candidate of getBackendUrlCandidates(platformEnv)) {
		const url = String(candidate || '').trim();
		if (url && url !== '__DISABLED__' && isLoopbackProxyUrl(url)) {
			return url;
		}
	}

	return undefined;
}

function getConfiguredHttpsBackendUrl(platformEnv?: Record<string, unknown>): string | undefined {
	for (const candidate of getBackendUrlCandidates(platformEnv)) {
		const url = String(candidate || '').trim();
		if (url && url !== '__DISABLED__' && isHttpsUrl(url)) {
			return new URL(url).origin;
		}
	}

	return undefined;
}

function getLocalApiBackendUrl(platformEnv?: Record<string, unknown>): string {
	return getConfiguredLocalBackendUrl(platformEnv) ?? 'http://localhost:8786';
}

function isLocalAdminProxyEnabled(platformEnv?: Record<string, unknown>): boolean {
	if (!getLocalProxyFlag(platformEnv)) {
		return false;
	}

	return (
		getConfiguredLocalBackendUrl(platformEnv) !== undefined || !hasConfiguredBackendUrl(platformEnv)
	);
}

function getBffMachineCredentialConfig(
	platformEnv?: Record<string, unknown>
): AdminUiBffMachineCredentialConfig | null {
	const clientId = String(platformEnv?.ADMIN_UI_BFF_CLIENT_ID || '').trim();
	const keyId = String(platformEnv?.ADMIN_UI_BFF_KEY_ID || '').trim();
	const privateKeyPem = String(platformEnv?.ADMIN_UI_BFF_PRIVATE_KEY_PEM || '').trim();
	const scopes = String(platformEnv?.ADMIN_UI_BFF_SCOPES || ADMIN_UI_BFF_DEFAULT_SCOPE).trim();

	if (!clientId || !keyId || !privateKeyPem || !scopes) {
		return null;
	}

	return { clientId, keyId, privateKeyPem, scopes };
}

function isFixedHttpsBffProxyEnabled(platformEnv?: Record<string, unknown>): boolean {
	return Boolean(
		getConfiguredHttpsBackendUrl(platformEnv) && getBffMachineCredentialConfig(platformEnv)
	);
}

function getConfiguredForwardedHost(platformEnv?: Record<string, unknown>): string | undefined {
	const candidates = [
		platformEnv?.PUBLIC_API_BASE_URL,
		dynamicEnv.PUBLIC_API_BASE_URL,
		import.meta.env.PUBLIC_API_BASE_URL,
		typeof process !== 'undefined' ? process.env?.PUBLIC_API_BASE_URL : undefined
	];

	for (const candidate of candidates) {
		const url = getHttpsUrl(candidate);
		if (!url) {
			continue;
		}

		try {
			return new URL(url).host;
		} catch {
			// Ignore invalid values and continue.
		}
	}

	return undefined;
}

function getApiPublicUrl(platformEnv?: Record<string, unknown>): string | undefined {
	const candidates = [
		platformEnv?.PUBLIC_AUTHRIM_ISSUER,
		dynamicEnv.PUBLIC_AUTHRIM_ISSUER,
		import.meta.env.PUBLIC_AUTHRIM_ISSUER
	];
	for (const candidate of candidates) {
		const url = getHttpsUrl(candidate);
		if (url) return url;
	}
	return undefined;
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlEncodeJson(value: Record<string, unknown>): string {
	return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
	const base64 = pem
		.replace(/-----BEGIN PRIVATE KEY-----/g, '')
		.replace(/-----END PRIVATE KEY-----/g, '')
		.replace(/\s+/g, '');
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

async function importBffPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'pkcs8',
		pemToArrayBuffer(privateKeyPem),
		{ name: 'ECDSA', namedCurve: 'P-256' },
		false,
		['sign']
	);
}

async function createBffClientAssertion(
	tokenEndpoint: string,
	config: AdminUiBffMachineCredentialConfig
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = base64UrlEncodeJson({
		alg: 'ES256',
		typ: 'JWT',
		kid: config.keyId
	});
	const payload = base64UrlEncodeJson({
		iss: config.clientId,
		sub: config.clientId,
		aud: tokenEndpoint,
		iat: now,
		exp: now + 300,
		jti: crypto.randomUUID()
	});
	const signingInput = `${header}.${payload}`;
	const key = await importBffPrivateKey(config.privateKeyPem);
	const signature = await crypto.subtle.sign(
		{ name: 'ECDSA', hash: 'SHA-256' },
		key,
		new TextEncoder().encode(signingInput)
	);
	return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

async function requestBffAdminAccessToken(
	apiBackendUrl: string,
	config: AdminUiBffMachineCredentialConfig,
	options: BffTokenRequestOptions = {}
): Promise<string> {
	const tokenEndpoint = new URL('/token', apiBackendUrl).href;
	const assertion = await createBffClientAssertion(tokenEndpoint, config);
	const form = new URLSearchParams({
		grant_type: 'client_credentials',
		client_id: config.clientId,
		client_assertion_type: CLIENT_ASSERTION_TYPE,
		client_assertion: assertion,
		audience: ADMIN_MACHINE_AUDIENCE,
		scope: config.scopes
	});
	const controller = new AbortController();
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const requestHeaders = new Headers({
		accept: 'application/json',
		'content-type': 'application/x-www-form-urlencoded'
	});
	const tenantId = options.tenantId?.trim();
	if (tenantId) {
		requestHeaders.set('X-Tenant-Id', tenantId);
	}
	const tokenRequest = new Request(tokenEndpoint, {
		method: 'POST',
		headers: requestHeaders,
		body: form.toString(),
		signal: controller.signal
	});
	const sendRequest = options.sendRequest ?? ((request: Request) => fetch(request));

	let response: Response;
	try {
		response = await Promise.race([
			sendRequest(tokenRequest),
			new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => {
					controller.abort();
					reject(Object.assign(new Error('Timeout'), { name: 'AbortError' }));
				}, PROXY_TIMEOUT_MS);
			})
		]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}

	if (!response.ok) {
		throw Object.assign(new Error('Admin UI BFF token request failed'), {
			name: 'BffTokenRequestError'
		});
	}

	const payload = (await response.json()) as {
		access_token?: string;
		token_type?: string;
	};
	if (!payload.access_token || payload.token_type !== 'Bearer') {
		throw Object.assign(new Error('Admin UI BFF token response invalid'), {
			name: 'BffTokenResponseError'
		});
	}

	return payload.access_token;
}

/**
 * Check if API proxy is enabled
 * Production proxy requires Service Binding. Local fallback requires an
 * explicit opt-in flag and a loopback backend URL.
 */
function isProxyEnabled(platformEnv?: Record<string, unknown>): boolean {
	if (platformEnv?.AR_ROUTER) {
		return true;
	}

	return isLocalAdminProxyEnabled(platformEnv) || isFixedHttpsBffProxyEnabled(platformEnv);
}

function buildConnectSrc(platformEnv?: Record<string, unknown>): string {
	const telemetrySources = 'https://cloudflareinsights.com https://*.cloudflareinsights.com';
	// When proxy is enabled, browser only requests to same-origin /api/*; 'self' is sufficient.
	if (isProxyEnabled(platformEnv)) {
		return `connect-src 'self' ${telemetrySources}`;
	}
	// When proxy is disabled, add the API origin only if PUBLIC_API_BASE_URL is set to a full URL
	const apiBaseUrl =
		(platformEnv?.PUBLIC_API_BASE_URL as string | undefined)?.trim() ||
		dynamicEnv.PUBLIC_API_BASE_URL?.trim() ||
		import.meta.env.PUBLIC_API_BASE_URL?.trim();
	if (apiBaseUrl) {
		try {
			return `connect-src 'self' ${new URL(apiBaseUrl).origin} ${telemetrySources}`;
		} catch {
			// Invalid URL, fall back to self only
		}
	}
	return `connect-src 'self' ${telemetrySources}`;
}

function getPlatformEnv(event: RequestEvent): Record<string, unknown> | undefined {
	return (event.platform as { env?: Record<string, unknown> } | undefined)?.env;
}

function isAllowedProxyPath(pathname: string): boolean {
	return (
		pathname === '/api/admin' ||
		pathname.startsWith('/api/admin/') ||
		pathname === '/api/admin-setup' ||
		pathname.startsWith('/api/admin-setup/')
	);
}

function isAllowedProxyMethod(method: string): boolean {
	return ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(
		method.toUpperCase()
	);
}

function isStateChangingMethod(method: string): boolean {
	return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
}

function passesCsrfCheck(event: RequestEvent): boolean {
	if (!isStateChangingMethod(event.request.method)) {
		return true;
	}

	const origin = event.request.headers.get('origin');
	if (origin) {
		return origin === event.url.origin;
	}

	const referer = event.request.headers.get('referer');
	if (!referer) {
		return false;
	}

	try {
		return new URL(referer).origin === event.url.origin;
	} catch {
		return false;
	}
}

function getForwardedAdminCookie(cookieHeader: string | null): string | null {
	if (!cookieHeader) {
		return null;
	}

	const adminSessionCookie = cookieHeader
		.split(';')
		.map((part) => part.trim())
		.find((part) => part.startsWith('authrim_admin_session='));

	return adminSessionCookie || null;
}

function createProxyRequestId(): string {
	return globalThis.crypto?.randomUUID?.() ?? `req_${Date.now().toString(36)}`;
}

function getProxyRequestId(event: RequestEvent): string {
	return event.request.headers.get('x-request-id') || createProxyRequestId();
}

function getOriginFromHeader(value: string | null): string | undefined {
	if (!value) {
		return undefined;
	}

	try {
		return new URL(value).origin;
	} catch {
		return 'invalid';
	}
}

function logProxySecurityEvent(
	event: RequestEvent,
	requestId: string,
	eventType: string,
	result: ProxySecurityEventResult,
	metadata: ProxySecurityEventMetadata = {}
): void {
	const logEvent = {
		event: 'authrim_admin_ui_bff_security',
		event_type: eventType,
		result,
		request_id: requestId,
		method: event.request.method,
		path: event.url.pathname,
		status: metadata.status,
		client_ip: event.getClientAddress() || undefined,
		origin: getOriginFromHeader(event.request.headers.get('origin')),
		referer_origin: getOriginFromHeader(event.request.headers.get('referer')),
		tenant_id: event.request.headers.get('x-tenant-id') || undefined,
		user_agent: event.request.headers.get('user-agent') || undefined,
		...metadata
	};

	if (result === 'failed') {
		console.error('Admin UI BFF security event', logEvent);
		return;
	}

	console.warn('Admin UI BFF security event', logEvent);
}

export function buildProxyHeaders(
	event: RequestEvent,
	forwardedHost: string,
	upstreamOrigin: string,
	requestId = getProxyRequestId(event),
	options: { includeBffMode?: boolean } = {}
): Headers {
	const allowedHeaders = [
		'accept',
		'accept-language',
		'content-type',
		'user-agent',
		'x-request-id',
		'x-correlation-id',
		'x-tenant-id',
		'x-diagnostic-session-id',
		'idempotency-key',
		'authrim-step-up-receipt'
	];

	const headers = new Headers();
	for (const headerName of allowedHeaders) {
		const value = event.request.headers.get(headerName);
		if (value) {
			headers.set(headerName, value);
		}
	}

	headers.set('X-Request-Id', requestId);

	const adminCookie = getForwardedAdminCookie(event.request.headers.get('cookie'));
	if (adminCookie) {
		headers.set('Cookie', adminCookie);
	}

	const clientIP = event.getClientAddress();
	if (clientIP) {
		headers.set('X-Forwarded-For', clientIP);
	}
	headers.set('X-Authrim-Forwarded-Host', forwardedHost);
	headers.set('X-Forwarded-Host', forwardedHost);
	headers.set('X-Forwarded-Proto', 'https');
	if (options.includeBffMode ?? true) {
		headers.set('X-Authrim-Admin-UI-Api-Mode', 'cross-site-proxy-bff');
	}

	if (event.request.headers.get('origin') || event.request.headers.get('referer')) {
		headers.set('Origin', upstreamOrigin);
		if (event.request.headers.get('referer')) {
			headers.set(
				'Referer',
				new URL(`${event.url.pathname}${event.url.search}`, upstreamOrigin).href
			);
		}
	}

	return headers;
}

async function readBody(event: RequestEvent): Promise<ProxyBody | '__TOO_LARGE__'> {
	if (event.request.method === 'GET' || event.request.method === 'HEAD') {
		return undefined;
	}

	const contentLength = event.request.headers.get('content-length');
	if (contentLength && parseInt(contentLength, 10) > MAX_PROXY_BODY_BYTES) {
		return '__TOO_LARGE__';
	}

	const body = await event.request.arrayBuffer();
	if (body.byteLength > MAX_PROXY_BODY_BYTES) {
		return '__TOO_LARGE__';
	}
	return body;
}

function getSetCookieHeaders(headers: Headers): string[] {
	const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
	const setCookies = withGetSetCookie.getSetCookie?.();
	if (setCookies?.length) {
		return setCookies;
	}

	const singleHeader = headers.get('set-cookie');
	return singleHeader ? [singleHeader] : [];
}

function rewriteSetCookieForProxy(cookie: string): string {
	return cookie
		.split(';')
		.filter((part) => !part.trim().toLowerCase().startsWith('domain='))
		.join(';');
}

function buildProxyResponse(response: Response): Response {
	const responseHeaders = new Headers();
	const setCookieHeaders = getSetCookieHeaders(response.headers);
	const hopByHopHeaders = [
		'connection',
		'keep-alive',
		'proxy-authenticate',
		'proxy-authorization',
		'te',
		'trailers',
		'transfer-encoding',
		'upgrade'
	];

	response.headers.forEach((value, key) => {
		const lowerKey = key.toLowerCase();

		// Skip hop-by-hop headers
		if (hopByHopHeaders.includes(lowerKey)) {
			return;
		}

		if (lowerKey === 'set-cookie') {
			return;
		}

		responseHeaders.append(key, value);
	});

	for (const cookie of setCookieHeaders) {
		responseHeaders.append('Set-Cookie', rewriteSetCookieForProxy(cookie));
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: responseHeaders
	});
}

function handleProxyError(event: RequestEvent, requestId: string, error: unknown): Response {
	const errorType = error instanceof Error ? error.name : 'Unknown';
	logProxySecurityEvent(event, requestId, 'upstream_request_failed', 'failed', {
		error_type: errorType,
		status: error instanceof Error && error.name === 'AbortError' ? 504 : 502
	});

	// Handle timeout specifically
	if (error instanceof Error && error.name === 'AbortError') {
		return new Response(
			JSON.stringify({
				error: 'gateway_timeout',
				error_description: 'Backend server did not respond in time'
			}),
			{
				status: 504,
				headers: { 'Content-Type': 'application/json' }
			}
		);
	}

	// Return a generic error response (don't leak internal details)
	return new Response(
		JSON.stringify({
			error: 'bad_gateway',
			error_description: 'Failed to connect to API server'
		}),
		{
			status: 502,
			headers: { 'Content-Type': 'application/json' }
		}
	);
}

export const apiProxy: Handle = async ({ event, resolve }) => {
	// Get platform environment (Cloudflare Workers provides this)
	const platformEnv = getPlatformEnv(event);

	// Only proxy /api/* requests
	if (!event.url.pathname.startsWith('/api/')) {
		return resolve(event);
	}

	if (!isAllowedProxyPath(event.url.pathname)) {
		return resolve(event);
	}

	const proxyRequestId = getProxyRequestId(event);

	if (!isAllowedProxyMethod(event.request.method)) {
		logProxySecurityEvent(event, proxyRequestId, 'method_rejected', 'rejected', {
			status: 405
		});
		return new Response('Method Not Allowed', {
			status: 405,
			headers: { Allow: 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS' }
		});
	}

	if (!passesCsrfCheck(event)) {
		logProxySecurityEvent(event, proxyRequestId, 'csrf_rejected', 'rejected', {
			status: 403
		});
		return new Response('Forbidden: CSRF check failed', { status: 403 });
	}

	const arRouter = platformEnv?.AR_ROUTER as ServiceBinding | undefined;
	const localProxyEnabled = isLocalAdminProxyEnabled(platformEnv);
	const fixedHttpsBffProxyEnabled = isFixedHttpsBffProxyEnabled(platformEnv);
	const includeBffMode =
		event.url.pathname === '/api/admin' || event.url.pathname.startsWith('/api/admin/');
	const includeTransportBffMode =
		includeBffMode && (Boolean(arRouter) || fixedHttpsBffProxyEnabled);

	if (!arRouter && !localProxyEnabled && !fixedHttpsBffProxyEnabled) {
		logProxySecurityEvent(event, proxyRequestId, 'proxy_not_configured', 'rejected', {
			status: 500
		});
		return new Response(
			JSON.stringify({
				error: 'proxy_not_configured',
				error_description:
					'Admin UI proxy requires a Cloudflare Service Binding, or explicit local loopback proxy opt-in.'
			}),
			{
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			}
		);
	}

	if (!arRouter && !isProxyEnabled(platformEnv)) {
		return resolve(event);
	}

	// Security: Limit request body size (10MB max)
	const body = await readBody(event);
	if (body === '__TOO_LARGE__') {
		logProxySecurityEvent(event, proxyRequestId, 'payload_too_large', 'rejected', {
			status: 413,
			max_body_bytes: MAX_PROXY_BODY_BYTES
		});
		return new Response(
			JSON.stringify({
				error: 'payload_too_large',
				error_description: 'Request body exceeds maximum allowed size'
			}),
			{
				status: 413,
				headers: { 'Content-Type': 'application/json' }
			}
		);
	}

	if (arRouter) {
		// === Service Binding path (Cloudflare Workers production) ===
		// AR_ROUTER binding routes internally; no workers.dev endpoint is needed.
		const apiPublicUrl = getApiPublicUrl(platformEnv);
		if (!apiPublicUrl) {
			logProxySecurityEvent(event, proxyRequestId, 'issuer_not_configured', 'rejected', {
				status: 500
			});
			return new Response(
				JSON.stringify({
					error: 'proxy_not_configured',
					error_description: 'Admin UI proxy requires PUBLIC_AUTHRIM_ISSUER for Service Binding.'
				}),
				{
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				}
			);
		}
		const apiPublicOrigin = new URL(apiPublicUrl).origin;
		const forwardedHost = new URL(apiPublicUrl).host;
		const targetUrl = `${apiPublicUrl}${event.url.pathname}${event.url.search}`;
		const headers = buildProxyHeaders(event, forwardedHost, apiPublicOrigin, proxyRequestId, {
			includeBffMode: includeTransportBffMode
		});
		const bffMachineCredentialConfig = getBffMachineCredentialConfig(platformEnv);
		if (includeTransportBffMode && !bffMachineCredentialConfig) {
			logProxySecurityEvent(event, proxyRequestId, 'bff_credential_not_configured', 'rejected', {
				status: 500
			});
			return new Response(
				JSON.stringify({
					error: 'proxy_not_configured',
					error_description: 'Admin UI proxy requires Admin UI BFF machine credentials.'
				}),
				{
					status: 500,
					headers: { 'Content-Type': 'application/json' }
				}
			);
		}
		const controller = new AbortController();
		let timeoutId: ReturnType<typeof setTimeout> | undefined;

		try {
			if (includeTransportBffMode && bffMachineCredentialConfig) {
				const accessToken = await requestBffAdminAccessToken(
					apiPublicUrl,
					bffMachineCredentialConfig,
					{
						tenantId: event.request.headers.get('x-tenant-id'),
						sendRequest: (request) => arRouter.fetch(request)
					}
				);
				headers.set('Authorization', `Bearer ${accessToken}`);
			}
			const response = await Promise.race([
				arRouter.fetch(
					new Request(targetUrl, {
						method: event.request.method,
						headers,
						body: body as BodyInit | undefined,
						signal: controller.signal
					})
				),
				new Promise<never>((_, reject) => {
					timeoutId = setTimeout(() => {
						controller.abort();
						reject(Object.assign(new Error('Timeout'), { name: 'AbortError' }));
					}, PROXY_TIMEOUT_MS);
				})
			]);
			if (timeoutId) clearTimeout(timeoutId);
			return buildProxyResponse(response);
		} catch (error) {
			if (timeoutId) clearTimeout(timeoutId);
			return handleProxyError(event, proxyRequestId, error);
		}
	} else {
		// === HTTP fetch path (local development / fallback) ===
		const apiBackendUrl = fixedHttpsBffProxyEnabled
			? (getConfiguredHttpsBackendUrl(platformEnv) as string)
			: getLocalApiBackendUrl(platformEnv);
		const apiBackendOrigin = new URL(apiBackendUrl).origin;
		const targetUrl = `${apiBackendUrl}${event.url.pathname}${event.url.search}`;
		const forwardedHost = getConfiguredForwardedHost(platformEnv) ?? new URL(apiBackendUrl).host;
		const headers = buildProxyHeaders(event, forwardedHost, apiBackendOrigin, proxyRequestId, {
			includeBffMode: includeTransportBffMode
		});
		const bffMachineCredentialConfig = getBffMachineCredentialConfig(platformEnv);

		// Make the proxied request with timeout
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

		try {
			if (fixedHttpsBffProxyEnabled && bffMachineCredentialConfig) {
				const accessToken = await requestBffAdminAccessToken(
					apiBackendUrl,
					bffMachineCredentialConfig,
					{ tenantId: event.request.headers.get('x-tenant-id') }
				);
				headers.set('Authorization', `Bearer ${accessToken}`);
			}

			const response = await fetch(targetUrl, {
				method: event.request.method,
				headers,
				body: body as BodyInit | undefined,
				signal: controller.signal
			});

			clearTimeout(timeoutId);
			return buildProxyResponse(response);
		} catch (error) {
			clearTimeout(timeoutId);
			return handleProxyError(event, proxyRequestId, error);
		}
	}
};

/**
 * Security headers hook
 * Adds comprehensive security headers to all responses.
 */
const securityHeaders: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	const platformEnv = getPlatformEnv(event);

	// Content Security Policy
	// - 'unsafe-inline' required for SvelteKit style injection and inline scripts
	// - connect-src includes API origin for cross-origin API calls
	// - img-src allows HTTPS and data: URIs (charts, dynamic images)
	response.headers.set(
		'Content-Security-Policy',
		[
			"default-src 'self'",
			"script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",
			"style-src 'self' 'unsafe-inline'",
			"img-src 'self' https: data:",
			buildConnectSrc(platformEnv),
			"font-src 'self'",
			"frame-ancestors 'none'",
			"base-uri 'self'",
			"form-action 'self'"
		].join('; ')
	);

	// Enforce HTTPS
	response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	// Prevent clickjacking — admin UI should never be embedded
	response.headers.set('X-Frame-Options', 'DENY');
	// Prevent MIME sniffing
	response.headers.set('X-Content-Type-Options', 'nosniff');
	// Referrer policy
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	// Legacy XSS filter (for older browsers)
	response.headers.set('X-XSS-Protection', '1; mode=block');
	// Restrict browser features
	response.headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
	// Cross-origin isolation
	response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
	response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');

	return response;
};

/**
 * CSRF protection hook
 * Validates Origin or Referer header on state-changing requests (POST, PUT, DELETE, PATCH).
 * Falls back to Referer check when Origin header is absent.
 */
const csrfProtection: Handle = async ({ event, resolve }) => {
	const method = event.request.method;

	// Only check state-changing methods
	if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
		const origin = event.request.headers.get('origin');
		const requestOrigin = event.url.origin;

		if (origin) {
			// Primary: validate Origin header
			if (origin !== requestOrigin) {
				return new Response('Forbidden: CSRF check failed', { status: 403 });
			}
		} else {
			// Fallback: validate Referer header when Origin is absent
			const referer = event.request.headers.get('referer');
			if (referer) {
				try {
					const refererOrigin = new URL(referer).origin;
					if (refererOrigin !== requestOrigin) {
						return new Response('Forbidden: CSRF check failed', { status: 403 });
					}
				} catch {
					return new Response('Forbidden: CSRF check failed', { status: 403 });
				}
			} else {
				// Neither Origin nor Referer present — reject.
				// Admin UI is browser-only; legitimate browser requests always send
				// at least one of these headers on state-changing methods.
				return new Response('Forbidden: CSRF check failed', { status: 403 });
			}
		}
	}

	return resolve(event);
};

export const handle = sequence(apiProxy, securityHeaders, csrfProtection);
