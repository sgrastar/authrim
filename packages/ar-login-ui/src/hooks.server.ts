/**
 * SvelteKit Server Hooks
 *
 * Provides server-side middleware for:
 * - Same-origin proxying for UI Worker deployments
 * - Security headers (CSP, HSTS, COOP, CORP, etc.)
 * - CSRF protection via Origin/Referer header validation
 * - Accept-Language based locale detection
 */

import { env as dynamicEnv } from '$env/dynamic/public';
import { env as privateEnv } from '$env/dynamic/private';
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import {
	LOGIN_TENANT_HOST_COOKIE,
	REMEMBERED_TENANT_COOKIE,
	getLoginTenantHost,
	getRememberedTenantHost,
	normalizeTenantHost
} from '$lib/discovery-session';
import type { AuthenticationMethodsResponse } from '$lib/api/authentication-methods';
import {
	getCachedAuthenticationMethods,
	resolveHumanVerificationProviderFromAuthenticationMethods,
	type HumanVerificationProvider
} from '$lib/server/authentication-methods-cache';
import { getAccountPageCanonicalRedirectUrl } from '$lib/server/account-canonical-url';

type ContentSecurityPolicyHumanVerificationProvider = HumanVerificationProvider | 'all';

interface ServiceBinding {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

const EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKEN_MIN_LENGTH = 32;
const EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKEN_MAX_LENGTH = 4096;

function isLoopbackHost(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

const httpsRedirectHandle: Handle = async ({ event, resolve }) => {
	if (event.url.protocol !== 'http:' || isLoopbackHost(event.url.hostname)) {
		return resolve(event);
	}

	const redirectUrl = new URL(event.url);
	redirectUrl.protocol = 'https:';
	return new Response(null, {
		status: 308,
		headers: {
			Location: redirectUrl.toString()
		}
	});
};

function isValidProxyUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'http:' || parsed.protocol === 'https:';
	} catch {
		return false;
	}
}

function getValidProxyUrl(candidate: unknown): string | undefined {
	const value = String(candidate || '').trim();
	if (!value || value === '__DISABLED__' || !isValidProxyUrl(value)) {
		return undefined;
	}

	return value;
}

function getExplicitProxyBackendUrl(platformEnv?: Record<string, unknown>): string | undefined {
	const candidates = [
		platformEnv?.API_BACKEND_URL,
		platformEnv?.PUBLIC_API_PROXY_BACKEND_URL,
		dynamicEnv.PUBLIC_API_PROXY_BACKEND_URL,
		import.meta.env.PUBLIC_API_PROXY_BACKEND_URL,
		typeof process !== 'undefined' ? process.env?.API_BACKEND_URL : undefined,
		typeof process !== 'undefined' ? process.env?.PUBLIC_API_PROXY_BACKEND_URL : undefined
	];

	for (const candidate of candidates) {
		const url = getValidProxyUrl(candidate);
		if (url) {
			return url;
		}
	}

	return undefined;
}

export function getConfiguredApiBackendUrl(
	platformEnv?: Record<string, unknown>
): string | undefined {
	const explicitProxyBackendUrl = getExplicitProxyBackendUrl(platformEnv);
	if (explicitProxyBackendUrl) {
		return explicitProxyBackendUrl;
	}

	const candidates = [
		platformEnv?.PUBLIC_API_BASE_URL,
		dynamicEnv.PUBLIC_API_BASE_URL,
		import.meta.env.PUBLIC_API_BASE_URL,
		platformEnv?.PUBLIC_AUTHRIM_ISSUER,
		dynamicEnv.PUBLIC_AUTHRIM_ISSUER,
		import.meta.env.PUBLIC_AUTHRIM_ISSUER,
		typeof process !== 'undefined' ? process.env?.PUBLIC_API_BASE_URL : undefined,
		typeof process !== 'undefined' ? process.env?.PUBLIC_AUTHRIM_ISSUER : undefined
	];

	for (const candidate of candidates) {
		const url = getValidProxyUrl(candidate);
		if (url) {
			return url;
		}
	}

	return undefined;
}

function getConfiguredForwardedHost(platformEnv?: Record<string, unknown>): string | undefined {
	const candidates = [
		platformEnv?.PUBLIC_AUTHRIM_ISSUER,
		dynamicEnv.PUBLIC_AUTHRIM_ISSUER,
		import.meta.env.PUBLIC_AUTHRIM_ISSUER,
		platformEnv?.PUBLIC_API_BASE_URL,
		dynamicEnv.PUBLIC_API_BASE_URL,
		import.meta.env.PUBLIC_API_BASE_URL,
		platformEnv?.PUBLIC_API_PROXY_BACKEND_URL,
		dynamicEnv.PUBLIC_API_PROXY_BACKEND_URL,
		import.meta.env.PUBLIC_API_PROXY_BACKEND_URL,
		platformEnv?.API_BACKEND_URL,
		typeof process !== 'undefined' ? process.env?.PUBLIC_AUTHRIM_ISSUER : undefined,
		typeof process !== 'undefined' ? process.env?.PUBLIC_API_BASE_URL : undefined,
		typeof process !== 'undefined' ? process.env?.PUBLIC_API_PROXY_BACKEND_URL : undefined,
		typeof process !== 'undefined' ? process.env?.API_BACKEND_URL : undefined
	];

	for (const candidate of candidates) {
		const url = getValidProxyUrl(candidate);
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

function shouldUseRequestHostAsForwardedHost(platformEnv?: Record<string, unknown>): boolean {
	const candidates = [
		platformEnv?.PUBLIC_API_BASE_URL,
		dynamicEnv.PUBLIC_API_BASE_URL,
		import.meta.env.PUBLIC_API_BASE_URL,
		typeof process !== 'undefined' ? process.env?.PUBLIC_API_BASE_URL : undefined
	];

	for (const candidate of candidates) {
		if (getValidProxyUrl(candidate)) {
			return false;
		}
	}

	return true;
}

function getOriginalRequestHost(event: RequestEvent): string | undefined {
	const originalHost = event.request.headers.get('x-authrim-original-host')?.trim();
	if (!originalHost) {
		return undefined;
	}

	try {
		return new URL(`https://${originalHost}`).host;
	} catch {
		return undefined;
	}
}

function getRememberedTenantRequestHost(event: RequestEvent): string | undefined {
	if (event.url.pathname === '/api/auth/discovery') {
		return undefined;
	}

	return getRememberedTenantHost(event.cookies.get(REMEMBERED_TENANT_COOKIE));
}

function getUrlTenantRequestHost(event: RequestEvent): string | undefined {
	return normalizeTenantHost(event.url.searchParams.get('tenant_host'));
}

function getLoginTenantRequestHost(event: RequestEvent): string | undefined {
	if (event.url.pathname === '/api/auth/discovery') {
		return undefined;
	}

	return getLoginTenantHost(event.cookies.get(LOGIN_TENANT_HOST_COOKIE));
}

function getApiBackendUrl(platformEnv?: Record<string, unknown>): string {
	return getConfiguredApiBackendUrl(platformEnv) ?? 'http://localhost:8786';
}

function isDevelopmentRuntime(): boolean {
	if (import.meta.env.DEV) {
		return true;
	}

	if (typeof process !== 'undefined' && process.env?.NODE_ENV) {
		return process.env.NODE_ENV !== 'production';
	}

	return false;
}

function isProxyEnabled(platformEnv?: Record<string, unknown>): boolean {
	return getExplicitProxyBackendUrl(platformEnv) !== undefined || isDevelopmentRuntime();
}

function buildConnectSrc(platformEnv?: Record<string, unknown>): string {
	// When proxy is enabled, browser only requests to same-origin /api/* — 'self' is sufficient
	if (isProxyEnabled(platformEnv)) {
		return "connect-src 'self'";
	}
	// When proxy is disabled, add the API origin only if PUBLIC_API_BASE_URL is set to a full URL
	const apiBaseUrl =
		(platformEnv?.PUBLIC_API_BASE_URL as string | undefined)?.trim() ||
		dynamicEnv.PUBLIC_API_BASE_URL?.trim() ||
		import.meta.env.PUBLIC_API_BASE_URL?.trim();
	if (apiBaseUrl) {
		try {
			return `connect-src 'self' ${new URL(apiBaseUrl).origin}`;
		} catch {
			// Invalid URL, fall back to self only
		}
	}
	return "connect-src 'self'";
}

export function buildContentSecurityPolicy(
	platformEnv: Record<string, unknown> | undefined,
	humanVerificationProvider: ContentSecurityPolicyHumanVerificationProvider | null
): string {
	const turnstileOrigin = 'https://challenges.cloudflare.com';
	const cloudflareInsightsOrigin = 'https://static.cloudflareinsights.com';
	const hcaptchaOrigins = ['https://hcaptcha.com', 'https://*.hcaptcha.com'];
	const recaptchaOrigins = ['https://www.google.com', 'https://www.gstatic.com'];
	const scriptOrigins = [cloudflareInsightsOrigin];
	const frameOrigins = [];
	const connectOrigins = [];
	const styleOrigins = [];
	if (humanVerificationProvider === 'turnstile' || humanVerificationProvider === 'all') {
		scriptOrigins.push(turnstileOrigin, cloudflareInsightsOrigin);
		frameOrigins.push(turnstileOrigin);
	}
	if (humanVerificationProvider === 'hcaptcha' || humanVerificationProvider === 'all') {
		scriptOrigins.push(...hcaptchaOrigins);
		frameOrigins.push(...hcaptchaOrigins);
		connectOrigins.push(...hcaptchaOrigins);
		styleOrigins.push(...hcaptchaOrigins);
	}
	if (humanVerificationProvider === 'recaptcha' || humanVerificationProvider === 'all') {
		scriptOrigins.push(...recaptchaOrigins);
		frameOrigins.push(...recaptchaOrigins);
		connectOrigins.push(...recaptchaOrigins);
	}
	const uniqueScriptOrigins = [...new Set(scriptOrigins)];
	const uniqueFrameOrigins = [...new Set(frameOrigins)];
	const uniqueConnectOrigins = [...new Set(connectOrigins)];
	const uniqueStyleOrigins = [...new Set(styleOrigins)];
	const scriptSrc = `script-src 'self' 'unsafe-inline'${uniqueScriptOrigins.length ? ` ${uniqueScriptOrigins.join(' ')}` : ''}`;
	const frameSrc = uniqueFrameOrigins.length ? [`frame-src ${uniqueFrameOrigins.join(' ')}`] : [];
	const styleSrc = `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com${uniqueStyleOrigins.length ? ` ${uniqueStyleOrigins.join(' ')}` : ''}`;
	const connectSrc = `${buildConnectSrc(platformEnv)}${uniqueConnectOrigins.length ? ` ${uniqueConnectOrigins.join(' ')}` : ''}`;

	return [
		"default-src 'self'",
		scriptSrc,
		styleSrc,
		"font-src 'self' https://fonts.gstatic.com data:",
		connectSrc,
		"img-src 'self' data: https:",
		...frameSrc,
		"frame-ancestors 'none'"
	].join('; ');
}

function getCacheKeyOrigin(apiBackendUrl: string): string {
	try {
		return new URL(apiBackendUrl).origin;
	} catch {
		return apiBackendUrl;
	}
}

function getForwardedHostApiBackendUrl(apiBackendUrl: string, forwardedHost: string): string {
	try {
		const url = new URL(apiBackendUrl);
		url.protocol = 'https:';
		url.host = forwardedHost;
		return url.toString();
	} catch {
		return apiBackendUrl;
	}
}

export function buildAuthenticationMethodsCacheKey(
	apiBackendUrl: string,
	forwardedHost: string
): string {
	return `${getCacheKeyOrigin(apiBackendUrl)}|${forwardedHost.toLowerCase()}`;
}

async function fetchAuthenticationMethodsForRequest(
	event: RequestEvent,
	platformEnv: Record<string, unknown> | undefined,
	apiBackendUrl: string,
	forwardedHost: string,
	clientId?: string | null
): Promise<AuthenticationMethodsResponse | null> {
	try {
		const apiBinding =
			(platformEnv?.AR_ROUTER as ServiceBinding | undefined) ??
			(platformEnv?.API_SERVICE as ServiceBinding | undefined) ??
			null;
		const upstreamBaseUrl = apiBinding
			? getForwardedHostApiBackendUrl(apiBackendUrl, forwardedHost)
			: apiBackendUrl;
		const upstreamUrl = new URL('/api/auth/authentication-methods', upstreamBaseUrl);
		if (clientId) {
			upstreamUrl.searchParams.set('client_id', clientId);
		}
		const headers = buildProxyHeaders(event, platformEnv, forwardedHost);
		headers.set('Accept', 'application/json');

		const response = apiBinding
			? await apiBinding.fetch(upstreamUrl.toString(), { headers })
			: await fetch(new Request(upstreamUrl.toString(), { headers }));
		if (!response.ok) return null;

		return (await response.json()) as AuthenticationMethodsResponse;
	} catch {
		return null;
	}
}

export async function fetchAuthenticationMethodsForPageRequest(
	event: RequestEvent,
	platformEnv: Record<string, unknown> | undefined,
	clientId?: string | null
): Promise<AuthenticationMethodsResponse | null> {
	const apiBackendUrl = getApiBackendUrl(platformEnv);
	const forwardedHost = getForwardedHost(event, platformEnv);
	return fetchAuthenticationMethodsForRequest(
		event,
		platformEnv,
		apiBackendUrl,
		forwardedHost,
		clientId
	);
}

export async function fetchLoginChallengeThemeTargetForPageRequest(
	event: RequestEvent,
	platformEnv: Record<string, unknown> | undefined
): Promise<App.Locals['loginChallengeThemeTarget'] | null> {
	const challengeId = event.url.searchParams.get('challenge_id')?.trim();
	if (!challengeId || challengeId.length > 512) return null;

	try {
		const apiBackendUrl = getApiBackendUrl(platformEnv);
		const forwardedHost = getForwardedHost(event, platformEnv);
		const apiBinding =
			(platformEnv?.AR_ROUTER as ServiceBinding | undefined) ??
			(platformEnv?.API_SERVICE as ServiceBinding | undefined) ??
			null;
		const upstreamBaseUrl = apiBinding
			? getForwardedHostApiBackendUrl(apiBackendUrl, forwardedHost)
			: apiBackendUrl;
		const upstreamUrl = new URL('/auth/login-challenge', upstreamBaseUrl);
		upstreamUrl.searchParams.set('challenge_id', challengeId);
		const headers = buildProxyHeaders(event, platformEnv, forwardedHost);
		headers.set('Accept', 'application/json');
		const response = apiBinding
			? await apiBinding.fetch(upstreamUrl.toString(), { headers })
			: await fetch(new Request(upstreamUrl.toString(), { headers }));
		if (!response.ok) {
			return { challengeId, valid: false, clientId: null };
		}
		const data = (await response.json()) as { client?: { client_id?: unknown } };
		const clientId = typeof data.client?.client_id === 'string' ? data.client.client_id.trim() : '';
		if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(clientId)) {
			return { challengeId, valid: false, clientId: null };
		}
		return { challengeId, valid: true, clientId };
	} catch {
		return { challengeId, valid: false, clientId: null };
	}
}

export async function getCachedAuthenticationMethodsForRequest(
	event: RequestEvent,
	platformEnv: Record<string, unknown> | undefined
): Promise<AuthenticationMethodsResponse | null> {
	const apiBackendUrl = getApiBackendUrl(platformEnv);
	const forwardedHost = getForwardedHost(event, platformEnv);
	const cacheKey = buildAuthenticationMethodsCacheKey(apiBackendUrl, forwardedHost);

	return getCachedAuthenticationMethods(cacheKey, () =>
		fetchAuthenticationMethodsForRequest(event, platformEnv, apiBackendUrl, forwardedHost)
	);
}

export async function resolveHumanVerificationProviderForRequest(
	event: RequestEvent,
	platformEnv: Record<string, unknown> | undefined
): Promise<HumanVerificationProvider | null> {
	const data = await getCachedAuthenticationMethodsForRequest(event, platformEnv);
	return resolveHumanVerificationProviderFromAuthenticationMethods(data);
}

function isAuthShellPath(pathname: string): boolean {
	return (
		pathname === '/login' ||
		pathname === '/signup' ||
		pathname === '/reauth' ||
		pathname === '/verify-email-code'
	);
}

export function shouldPrefetchLoginUITheme(pathname: string): boolean {
	return (
		isAuthShellPath(pathname) ||
		pathname === '/consent' ||
		pathname === '/device' ||
		pathname === '/ciba' ||
		pathname === '/invite' ||
		pathname === '/error' ||
		pathname === '/account' ||
		pathname.startsWith('/account/')
	);
}

function parseHumanVerificationProviderForCsp(
	value: unknown
): ContentSecurityPolicyHumanVerificationProvider | null | undefined {
	const normalized = String(value || '')
		.trim()
		.toLowerCase();
	if (!normalized) return undefined;
	if (normalized === 'none' || normalized === 'disabled' || normalized === 'false') return null;
	if (
		normalized === 'turnstile' ||
		normalized === 'hcaptcha' ||
		normalized === 'recaptcha' ||
		normalized === 'all'
	) {
		return normalized;
	}
	return undefined;
}

function resolveHumanVerificationProviderForCsp(
	pathname: string,
	platformEnv: Record<string, unknown> | undefined
): ContentSecurityPolicyHumanVerificationProvider | null {
	const configured = [
		platformEnv?.LOGIN_UI_CSP_HUMAN_VERIFICATION_PROVIDER,
		platformEnv?.PUBLIC_HUMAN_VERIFICATION_PROVIDER,
		dynamicEnv.PUBLIC_HUMAN_VERIFICATION_PROVIDER,
		import.meta.env.PUBLIC_HUMAN_VERIFICATION_PROVIDER
	];
	for (const value of configured) {
		const parsed = parseHumanVerificationProviderForCsp(value);
		if (parsed !== undefined) {
			return parsed;
		}
	}

	return isAuthShellPath(pathname) ? 'all' : null;
}

export function shouldProxyPath(pathname: string): boolean {
	return (
		(pathname.startsWith('/api/') && pathname !== '/api/set-language') ||
		pathname.startsWith('/auth/') ||
		pathname.startsWith('/handoff/') ||
		pathname.startsWith('/saml/') ||
		pathname === '/authorize' ||
		pathname === '/logout'
	);
}

function getPlatformEnv(event: RequestEvent): Record<string, unknown> | undefined {
	return (event.platform as { env?: Record<string, unknown> } | undefined)?.env;
}

function getServerEnvironmentValue(
	platformEnv: Record<string, unknown> | undefined,
	name: string
): unknown {
	if (platformEnv && Object.prototype.hasOwnProperty.call(platformEnv, name)) {
		return platformEnv[name];
	}
	if (Object.prototype.hasOwnProperty.call(privateEnv, name)) {
		return privateEnv[name];
	}

	return typeof process !== 'undefined' ? process.env?.[name] : undefined;
}

function normalizeEmailVerificationOriginTrialToken(value: unknown): string | null {
	if (typeof value !== 'string' || /[\r\n]/u.test(value)) {
		return null;
	}

	const token = value.trim();
	if (
		token.length < EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKEN_MIN_LENGTH ||
		token.length > EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKEN_MAX_LENGTH ||
		!/^[A-Za-z0-9+/_-]+={0,2}$/u.test(token)
	) {
		return null;
	}

	return token;
}

function getEmailVerificationOriginTrialRequestOrigin(event: RequestEvent): string {
	const originalHost = getOriginalRequestHost(event);
	if (!originalHost) {
		return event.url.origin;
	}

	const protocol = event.url.protocol === 'http:' ? 'http:' : 'https:';
	return `${protocol}//${originalHost}`;
}

function resolveEmailVerificationOriginTrialToken(
	event: RequestEvent,
	platformEnv: Record<string, unknown> | undefined
): string | null {
	const rawTokenMap = getServerEnvironmentValue(
		platformEnv,
		'EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKENS'
	);
	const tokenMapIsConfigured =
		rawTokenMap !== undefined &&
		rawTokenMap !== null &&
		!(typeof rawTokenMap === 'string' && !rawTokenMap.trim());
	if (tokenMapIsConfigured) {
		if (typeof rawTokenMap !== 'string') {
			return null;
		}

		try {
			const parsed = JSON.parse(rawTokenMap) as unknown;
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				return null;
			}

			const tokenMap = parsed as Record<string, unknown>;
			const origin = getEmailVerificationOriginTrialRequestOrigin(event);
			const rawToken = Object.prototype.hasOwnProperty.call(tokenMap, origin)
				? tokenMap[origin]
				: undefined;
			return normalizeEmailVerificationOriginTrialToken(rawToken);
		} catch {
			return null;
		}
	}

	return normalizeEmailVerificationOriginTrialToken(
		getServerEnvironmentValue(platformEnv, 'EMAIL_VERIFICATION_ORIGIN_TRIAL_TOKEN')
	);
}

function isEmailCodeEnabledForOriginTrial(
	pathname: string,
	authenticationMethods: AuthenticationMethodsResponse | null | undefined
): boolean {
	const emailCode = authenticationMethods?.methods?.emailCode;
	if (!emailCode) {
		return false;
	}

	if (pathname === '/login') {
		return (emailCode.loginEnabled ?? emailCode.enabled) === true;
	}
	if (pathname === '/signup') {
		return (emailCode.signupEnabled ?? emailCode.enabled) === true;
	}

	return false;
}

function isHtmlDocumentResponse(response: Response): boolean {
	return (
		response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/html'
	);
}

function getProxyRequestUrl(event: RequestEvent): URL {
	return event.url ?? new URL(event.request.url);
}

function buildForwardedOrigin(requestUrl: URL, forwardedHost: string): string | undefined {
	try {
		const protocol = requestUrl.protocol === 'http:' ? 'http:' : 'https:';
		return new URL(`${protocol}//${forwardedHost}`).origin;
	} catch {
		return undefined;
	}
}

function isRequestSameOriginHeaderValue(value: string, requestUrl: URL): boolean {
	try {
		return new URL(value).origin === requestUrl.origin;
	} catch {
		return false;
	}
}

function rewriteUrlOrigin(value: string, origin: string): string | undefined {
	try {
		const parsed = new URL(value);
		const replacement = new URL(origin);
		parsed.protocol = replacement.protocol;
		parsed.host = replacement.host;
		return parsed.toString();
	} catch {
		return undefined;
	}
}

function setProxyBrowserOriginHeaders(
	headers: Headers,
	event: RequestEvent,
	forwardedHost: string
): void {
	const requestUrl = getProxyRequestUrl(event);
	const forwardedOrigin = buildForwardedOrigin(requestUrl, forwardedHost);
	const origin = event.request.headers.get('origin');
	if (origin) {
		if (forwardedOrigin && isRequestSameOriginHeaderValue(origin, requestUrl)) {
			headers.set('X-Authrim-Browser-Origin', new URL(origin).origin);
			headers.set('Origin', forwardedOrigin);
		} else {
			headers.set('Origin', origin);
		}
	}

	const referer = event.request.headers.get('referer');
	if (referer) {
		if (forwardedOrigin && isRequestSameOriginHeaderValue(referer, requestUrl)) {
			headers.set('X-Authrim-Browser-Origin', new URL(referer).origin);
			headers.set('Referer', rewriteUrlOrigin(referer, forwardedOrigin) ?? referer);
		} else {
			headers.set('Referer', referer);
		}
	}
}

export function buildProxyHeaders(
	event: RequestEvent,
	platformEnv: Record<string, unknown> | undefined,
	forwardedHost: string
): Headers {
	const allowedHeaders = [
		'accept',
		'accept-language',
		'content-type',
		'authorization',
		'cookie',
		'user-agent',
		'x-request-id',
		'x-correlation-id',
		'x-session-id',
		'x-diagnostic-session-id'
	];

	const headers = new Headers();
	for (const headerName of allowedHeaders) {
		const value = event.request.headers.get(headerName);
		if (value) {
			headers.set(headerName, value);
		}
	}
	setProxyBrowserOriginHeaders(headers, event, forwardedHost);

	const clientIP = event.getClientAddress();
	if (clientIP) {
		headers.set('X-Forwarded-For', clientIP);
	}
	headers.set('X-Authrim-Original-Host', forwardedHost);
	headers.set('X-Authrim-Forwarded-Host', forwardedHost);
	headers.set('X-Authrim-Ui-Proxy', 'login-ui');
	headers.set('X-Forwarded-Host', forwardedHost);
	headers.set('X-Forwarded-Proto', 'https');
	headers.set('Host', forwardedHost);

	return headers;
}

export function getForwardedHost(
	event: RequestEvent,
	platformEnv?: Record<string, unknown>
): string {
	const urlTenantHost = getUrlTenantRequestHost(event);
	if (urlTenantHost) {
		return urlTenantHost;
	}

	const loginTenantHost = getLoginTenantRequestHost(event);
	if (loginTenantHost) {
		return loginTenantHost;
	}

	const originalHost = getOriginalRequestHost(event);
	if (originalHost) {
		return originalHost;
	}

	const rememberedTenantHost = getRememberedTenantRequestHost(event);
	if (rememberedTenantHost) {
		return rememberedTenantHost;
	}

	if (event.url.pathname === '/api/auth/discovery') {
		return event.url.host;
	}

	if (shouldUseRequestHostAsForwardedHost(platformEnv)) {
		return event.url.host;
	}

	return getConfiguredForwardedHost(platformEnv) ?? event.url.host;
}

async function readBody(event: RequestEvent): Promise<string | undefined> {
	if (event.request.method === 'GET' || event.request.method === 'HEAD') {
		return undefined;
	}

	const maxBodySize = 10 * 1024 * 1024;
	const contentLength = event.request.headers.get('content-length');
	if (contentLength && parseInt(contentLength, 10) > maxBodySize) {
		return '__TOO_LARGE__';
	}

	const body = await event.request.text();
	if (body.length > maxBodySize) {
		return '__TOO_LARGE__';
	}
	return body;
}

export function buildProxyResponse(response: Response): Response {
	const responseHeaders = new Headers();
	const setCookieHeaders =
		(response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
	response.headers.forEach((value, key) => {
		const lower = key.toLowerCase();
		if (
			lower === 'content-length' ||
			lower === 'transfer-encoding' ||
			lower === 'content-encoding' ||
			lower === 'set-cookie'
		) {
			return;
		}
		responseHeaders.set(key, value);
	});
	for (const setCookie of setCookieHeaders) {
		responseHeaders.append('Set-Cookie', setCookie);
	}
	if (setCookieHeaders.length === 0) {
		const setCookie = response.headers.get('set-cookie');
		if (setCookie) {
			responseHeaders.append('Set-Cookie', setCookie);
		}
	}

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers: responseHeaders
	});
}

const apiProxyHandle: Handle = async ({ event, resolve }) => {
	const pathname = event.url.pathname;
	if (!shouldProxyPath(pathname)) {
		return resolve(event);
	}

	const platformEnv = getPlatformEnv(event);
	const apiBackendUrl = getApiBackendUrl(platformEnv);
	const forwardedHost = getForwardedHost(event, platformEnv);

	const body = await readBody(event);
	if (body === '__TOO_LARGE__') {
		return new Response('Request body too large', { status: 413 });
	}

	const apiBinding =
		(platformEnv?.AR_ROUTER as ServiceBinding | undefined) ??
		(platformEnv?.API_SERVICE as ServiceBinding | undefined) ??
		null;
	const upstreamBaseUrl = apiBinding
		? getForwardedHostApiBackendUrl(apiBackendUrl, forwardedHost)
		: apiBackendUrl;
	const upstreamUrl = new URL(event.url.pathname + event.url.search, upstreamBaseUrl);
	const proxyHeaders = buildProxyHeaders(event, platformEnv, forwardedHost);

	const requestInit: RequestInit = {
		method: event.request.method,
		headers: proxyHeaders,
		redirect: 'manual'
	};

	if (body !== undefined) {
		requestInit.body = body;
	}

	const response = apiBinding
		? await apiBinding.fetch(upstreamUrl.toString(), requestInit)
		: await fetch(new Request(upstreamUrl.toString(), requestInit));

	return buildProxyResponse(response);
};

const loginTenantHostCookieHandle: Handle = async ({ event, resolve }) => {
	const tenantHost = getUrlTenantRequestHost(event);
	if (tenantHost) {
		event.cookies.set(LOGIN_TENANT_HOST_COOKIE, tenantHost, {
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			maxAge: 600
		});
	}

	return resolve(event);
};

const accountCanonicalHostHandle: Handle = async ({ event, resolve }) => {
	const platformEnv = getPlatformEnv(event);
	const redirectUrl = getAccountPageCanonicalRedirectUrl(event, platformEnv);
	if (redirectUrl) {
		return new Response(null, {
			status: 302,
			headers: {
				Location: redirectUrl
			}
		});
	}

	return resolve(event);
};

const securityHeadersHandle: Handle = async ({ event, resolve }) => {
	const platformEnv = getPlatformEnv(event);
	const response = await resolve(event);
	const humanVerificationProvider = resolveHumanVerificationProviderForCsp(
		event.url.pathname,
		platformEnv
	);
	const csp = buildContentSecurityPolicy(platformEnv, humanVerificationProvider);

	response.headers.set('Content-Security-Policy', csp);
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
	response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
	response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	return response;
};

function isSafeMethod(method: string): boolean {
	return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

function sameOrigin(a: URL, b: URL): boolean {
	return a.protocol === b.protocol && a.host === b.host;
}

const csrfHandle: Handle = async ({ event, resolve }) => {
	if (isSafeMethod(event.request.method)) {
		return resolve(event);
	}

	if (event.url.pathname.startsWith('/api/')) {
		return resolve(event);
	}

	const origin = event.request.headers.get('origin');
	if (origin) {
		try {
			if (!sameOrigin(new URL(origin), event.url)) {
				return new Response('Forbidden', { status: 403 });
			}
		} catch {
			return new Response('Forbidden', { status: 403 });
		}
	} else {
		const referer = event.request.headers.get('referer');
		if (referer) {
			try {
				if (!sameOrigin(new URL(referer), event.url)) {
					return new Response('Forbidden', { status: 403 });
				}
			} catch {
				return new Response('Forbidden', { status: 403 });
			}
		}
	}

	return resolve(event);
};

const loginUIThemeBootstrapHandle: Handle = async ({ event, resolve }) => {
	if (shouldPrefetchLoginUITheme(event.url.pathname)) {
		const challengeTarget =
			event.url.pathname === '/login'
				? await fetchLoginChallengeThemeTargetForPageRequest(event, getPlatformEnv(event))
				: null;
		if (challengeTarget) {
			event.locals.loginChallengeThemeTarget = challengeTarget;
		}
		event.locals.authenticationMethods = await fetchAuthenticationMethodsForPageRequest(
			event,
			getPlatformEnv(event),
			challengeTarget?.valid ? challengeTarget.clientId : null
		);
	}

	return resolve(event);
};

export const emailVerificationOriginTrialHandle: Handle = async ({ event, resolve }) => {
	const method = event.request.method.toUpperCase();
	const eligibleRequest =
		(method === 'GET' || method === 'HEAD') &&
		isEmailCodeEnabledForOriginTrial(event.url.pathname, event.locals.authenticationMethods);
	const token = eligibleRequest
		? resolveEmailVerificationOriginTrialToken(event, getPlatformEnv(event))
		: null;

	event.locals.emailVerificationProtocolEnabled = token !== null;
	const response = await resolve(event);
	if (token && isHtmlDocumentResponse(response)) {
		response.headers.append('Origin-Trial', token);
	}

	return response;
};

const localeHandle: Handle = async ({ event, resolve }) => {
	const supportedLocales = ['en', 'ja'];
	const cookieLocale = event.cookies.get('lang');
	if (cookieLocale && supportedLocales.includes(cookieLocale)) {
		event.locals.locale = cookieLocale;
		return resolve(event);
	}

	const acceptLanguage = event.request.headers.get('accept-language') || '';
	const candidates = acceptLanguage
		.split(',')
		.map((part) => part.split(';')[0]?.trim().toLowerCase())
		.filter(Boolean);

	for (const candidate of candidates) {
		const base = candidate.split('-')[0];
		if (base && supportedLocales.includes(base)) {
			event.locals.locale = base;
			return resolve(event);
		}
	}

	event.locals.locale = 'en';
	return resolve(event);
};

export const handle = sequence(
	httpsRedirectHandle,
	loginTenantHostCookieHandle,
	accountCanonicalHostHandle,
	apiProxyHandle,
	csrfHandle,
	loginUIThemeBootstrapHandle,
	emailVerificationOriginTrialHandle,
	localeHandle,
	securityHeadersHandle
);
