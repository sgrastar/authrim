import { describe, expect, it } from 'vitest';
import { isInternalLitePath, liteRouteForPath, normalizeRoutePath } from '../routing';
import { isRelayUrl, relayFormActionOrigin } from '../relay';

describe('lite routing', () => {
	it.each([
		['/', '/__lite/home'],
		['/login', '/__lite/login'],
		['/verify-email-code', '/__lite/verify-email-code'],
		['/consent', '/__lite/consent'],
		['/signup', '/__lite/signup'],
		['/invite', '/__lite/invite'],
		['/reauth', '/__lite/reauth'],
		['/callback', '/__lite/callback'],
		['/error', '/__lite/error'],
		['/logged-out', '/__lite/logged-out'],
		['/logout-complete', '/__lite/logout-complete'],
		['/account', '/__lite/account'],
		['/account/security', '/__lite/account/security']
	])('serves %s from %s', (path, route) => {
		expect(liteRouteForPath(path)).toBe(route);
	});

	it.each([
		'/device',
		'/device/authorize',
		'/ciba',
		'/discover',
		'/api/auth/x',
		'/authorize',
		'/logout',
		'/auth/external/google/start',
		'/accounts',
		'/__lite/login'
	])('leaves %s alone', (path) => {
		expect(liteRouteForPath(path)).toBeNull();
	});

	it('routes another spelling of the same page the same way', () => {
		expect(liteRouteForPath('/%6cogin')).toBe('/__lite/login');
		expect(liteRouteForPath('/login/')).toBe('/__lite/login');
		expect(liteRouteForPath('/account/%73ecurity/')).toBe('/__lite/account/security');
		expect(liteRouteForPath('/%E0%A4%A')).toBeNull();
	});

	it('recognises the internal prefix in any spelling', () => {
		expect(isInternalLitePath('/%5f_lite/error')).toBe(true);
		expect(isInternalLitePath('/__lite/')).toBe(true);
		expect(isInternalLitePath('/__LITE/error')).toBe(true);
	});

	it('recognises the internal prefix only as a path segment', () => {
		expect(isInternalLitePath('/__lite')).toBe(true);
		expect(isInternalLitePath('/__lite/error')).toBe(true);
		expect(isInternalLitePath('/__literal')).toBe(false);
	});
});

describe('relay targets', () => {
	it('accepts absolute http(s) URLs only', () => {
		expect(isRelayUrl('https://app.example/cb?code=1')).toBe(true);
		expect(isRelayUrl('javascript:alert(1)')).toBe(false);
		expect(isRelayUrl('/relative')).toBe(false);
		expect(isRelayUrl('https://user:pw@app.example/')).toBe(false);
		expect(isRelayUrl('data:text/html,x')).toBe(false);
	});

	it('limits a POST relay to its destination origin', () => {
		expect(
			relayFormActionOrigin({ method: 'post', action: 'https://idp.example/sso?x=1', fields: [] })
		).toBe('https://idp.example');
		expect(relayFormActionOrigin({ method: 'get', url: 'https://app.example/' })).toBeNull();
		expect(
			relayFormActionOrigin({ method: 'post', action: 'javascript:alert(1)', fields: [] })
		).toBeNull();
	});
});

describe('normalizeRoutePath', () => {
	it('decodes as SvelteKit does and drops a trailing slash', () => {
		expect(normalizeRoutePath('/')).toBe('/');
		expect(normalizeRoutePath('/a%20b/')).toBe('/a b');
		expect(normalizeRoutePath('/100%25')).toBe('/100%25');
	});
});
