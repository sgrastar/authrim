import { describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import LITE_CSS from '#lib/lite/lite.css?raw';
import { LITE_MODE_PROBE_URL } from '#lib/lite/routing.js';
import { buildLiteContentSecurityPolicy, cspHashSource } from '../csp';
import { liteTransformPageChunk } from '../document';
import { createLiteHandleFetch, liteGuardHandle } from '../guard';

function event(input: {
	path: string;
	routeId: string | null;
	method?: string;
	headers?: Record<string, string>;
	isDataRequest?: boolean;
}): RequestEvent {
	return {
		url: new URL(`https://login.example${input.path}`),
		route: { id: input.routeId },
		request: new Request(`https://login.example${input.path}`, {
			method: input.method ?? 'GET',
			headers: input.headers
		}),
		isDataRequest: input.isDataRequest ?? false,
		locals: {}
	} as unknown as RequestEvent;
}

const page = () =>
	new Response('<html></html>', {
		headers: {
			'Content-Type': 'text/html',
			'Content-Security-Policy': "default-src 'self' 'unsafe-inline'",
			'Cache-Control': 'public, max-age=60'
		}
	});

describe('liteGuardHandle', () => {
	it('refuses a direct request for the internal routes, by the requested path', async () => {
		const resolve = vi.fn(async () => page());
		const response = await liteGuardHandle({
			event: event({ path: '/__lite/error', routeId: '/__lite/error' }),
			resolve
		});
		expect(response.status).toBe(404);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('refuses another spelling of the internal routes, and a lite route not reached by reroute', async () => {
		const resolve = vi.fn(async () => page());
		const encoded = await liteGuardHandle({
			event: event({ path: '/%5f_lite/error', routeId: '/__lite/error' }),
			resolve
		});
		expect(encoded.status).toBe(404);
		const notRerouted = await liteGuardHandle({
			event: event({ path: '/something-else', routeId: '/__lite/[...rest]' }),
			resolve
		});
		expect(notRerouted.status).toBe(404);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('refuses a data request for a page asked with a trailing slash', async () => {
		const response = await liteGuardHandle({
			event: event({ path: '/login/', routeId: '/__lite/login', isDataRequest: true }),
			resolve: async () => page()
		});
		expect(response.status).toBe(503);
	});

	it('leaves normal pages alone', async () => {
		const resolve = vi.fn(async () => page());
		const response = await liteGuardHandle({
			event: event({ path: '/device', routeId: '/(main)/device' }),
			resolve
		});
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
	});

	it('serves a rerouted lite page with no-store and the lite CSP', async () => {
		const response = await liteGuardHandle({
			event: event({ path: '/error', routeId: '/__lite/error' }),
			resolve: async () => page()
		});
		expect(response.headers.get('Cache-Control')).toBe('private, no-store');
		const csp = response.headers.get('Content-Security-Policy') ?? '';
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain(`style-src ${await cspHashSource(LITE_CSS)}`);
		expect(csp).toContain("script-src 'none'");
		expect(csp).toContain("form-action 'self'");
		expect(csp).not.toContain('unsafe-inline');
	});

	it('adds what a page declared (a relay script and destination)', async () => {
		const e = event({ path: '/login', routeId: '/__lite/login' });
		e.locals.liteCsp = { scriptHashes: ["'sha256-abc'"], formAction: 'https://idp.example' };
		const response = await liteGuardHandle({ event: e, resolve: async () => page() });
		const csp = response.headers.get('Content-Security-Policy') ?? '';
		expect(csp).toContain("script-src 'sha256-abc'");
		expect(csp).toContain('form-action https://idp.example');
	});

	it('refuses a normal page’s data request sent to a lite route', async () => {
		const resolve = vi.fn(async () => page());
		const response = await liteGuardHandle({
			event: event({ path: '/login', routeId: '/__lite/login', isDataRequest: true }),
			resolve
		});
		expect(response.status).toBe(503);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('refuses a lite POST that is not urlencoded or is declared too large', async () => {
		const resolve = vi.fn(async () => page());
		const json = await liteGuardHandle({
			event: event({
				path: '/login',
				routeId: '/__lite/login',
				method: 'POST',
				headers: { 'content-type': 'application/json' }
			}),
			resolve
		});
		expect(json.status).toBe(415);
		const big = await liteGuardHandle({
			event: event({
				path: '/login',
				routeId: '/__lite/login',
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					'content-length': '999999'
				}
			}),
			resolve
		});
		expect(big.status).toBe(413);
		expect(resolve).not.toHaveBeenCalled();
	});
});

describe('the lite mode probe', () => {
	it('answers the probe with the mode and records it on the request', async () => {
		const handleFetch = createLiteHandleFetch(async () => 'always');
		const e = event({ path: '/login', routeId: null });
		const fetch = vi.fn();
		const response = await handleFetch({
			event: e,
			request: new Request(LITE_MODE_PROBE_URL),
			fetch
		});
		expect(await response.text()).toBe('always');
		expect(e.locals.loginUiLite).toBe('always');
		expect(fetch).not.toHaveBeenCalled();
	});

	it('reads as off when the mode does not come in time', async () => {
		vi.useFakeTimers();
		const handleFetch = createLiteHandleFetch(() => new Promise(() => undefined), 1000);
		const e = event({ path: '/login', routeId: null });
		const answer = handleFetch({
			event: e,
			request: new Request(LITE_MODE_PROBE_URL),
			fetch: vi.fn()
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(await (await answer).text()).toBe('off');
		vi.useRealTimers();
	});

	it('reads as off when the mode cannot be read, and passes other fetches through', async () => {
		const handleFetch = createLiteHandleFetch(async () => {
			throw new Error('down');
		});
		const e = event({ path: '/login', routeId: null });
		expect(
			await (
				await handleFetch({ event: e, request: new Request(LITE_MODE_PROBE_URL), fetch: vi.fn() })
			).text()
		).toBe('off');
		const fetch = vi.fn(async () => new Response('backend'));
		await handleFetch({ event: e, request: new Request('https://api.example/x'), fetch });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

describe('the lite document', () => {
	it('removes the normal first-paint styling and sets the language', () => {
		const html = `<html lang="__AUTHRIM_DOCUMENT_LANGUAGE__" dir="__AUTHRIM_DOCUMENT_DIRECTION__" style="
		background-color: __AUTHRIM_INITIAL_BACKGROUND__;
	"><head><meta name="theme-color" content="__AUTHRIM_INITIAL_BACKGROUND__" />
		<style>
			html { background-color: __AUTHRIM_INITIAL_BACKGROUND__; }
		</style>
		__AUTHRIM_THEME_FIRST_PAINT__ </head><body data-sveltekit-preload-data="hover" style="color-scheme: x"><div style="display: contents">x</div></body></html>`;
		const out = liteTransformPageChunk(html, { language: 'ar', direction: 'rtl' });
		expect(out).toContain('lang="ar" dir="rtl"');
		expect(out).not.toContain('__AUTHRIM');
		expect(out).not.toContain('style=');
		expect(out).not.toContain('<style>');
		expect(out).not.toContain('theme-color');
		expect(out).not.toContain('data-sveltekit-preload-data');
	});
});

describe('buildLiteContentSecurityPolicy', () => {
	it('allows nothing but the listed hashes', () => {
		expect(buildLiteContentSecurityPolicy({ styleHashes: [] })).toBe(
			"default-src 'none'; style-src 'none'; script-src 'none'; img-src data:; form-action 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; connect-src 'none'"
		);
	});
});
