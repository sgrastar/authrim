/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { completionRedirect } from '../completion-redirect';

function openOn(origin: string) {
	const url = new URL(origin);
	Object.defineProperty(window, 'location', {
		value: { origin: url.origin, hostname: url.hostname, href: `${origin}/verify-email-code` },
		writable: true
	});
}

describe('where a completed Flow sends the browser', () => {
	describe('in local development, the UI on one port and the issuer on another', () => {
		beforeEach(() => openOn('http://localhost:5173'));

		it('goes on with the authorization request the server gave, not to the usual destination', () => {
			// What the server gives for an application's authorization request (its issuer, as is).
			const continuation =
				'http://localhost:8787/authorize?_confirmation_challenge=909d24f8-3441-b602-4686-263f7ad05c06';

			expect(completionRedirect({ redirect_url: continuation }, '/account')).toBe(continuation);
		});
	});

	describe('deployed', () => {
		beforeEach(() => openOn('https://login.example.com'));

		it("goes on with the issuer's authorization request", () => {
			const continuation = 'https://auth.example.com/authorize?_confirmation_challenge=abc';
			expect(completionRedirect({ redirect_url: continuation }, '/account')).toBe(continuation);
		});

		it('does not go to plain http on this machine, nor to another address by http', () => {
			expect(
				completionRedirect({ redirect_url: 'http://localhost:8787/authorize?x=1' }, '/account')
			).toBe('/account');
			expect(completionRedirect({ redirect_url: 'http://evil.example/' }, '/account')).toBe(
				'/account'
			);
		});

		it('falls back when the server gave none', () => {
			expect(completionRedirect({}, '/account')).toBe('/account');
			expect(completionRedirect(null, '/account')).toBe('/account');
		});
	});

	describe('from a UI on a loopback address', () => {
		beforeEach(() => openOn('http://localhost:5173'));

		it('does not go to plain http on another address', () => {
			expect(completionRedirect({ redirect_url: 'http://evil.example/' }, '/account')).toBe(
				'/account'
			);
			expect(completionRedirect({ redirect_url: '//evil.example/' }, '/account')).toBe('/account');
		});
	});
});
