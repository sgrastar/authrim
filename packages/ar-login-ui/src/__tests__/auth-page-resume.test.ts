import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
	return readFileSync(resolve(__dirname, '..', path), 'utf8');
}

describe('auth page resume recovery', () => {
	for (const page of ['routes/login/+page.svelte', 'routes/signup/+page.svelte']) {
		it(`refreshes authentication methods without hiding the ${page} card`, () => {
			const pageSource = source(page);

			expect(pageSource).toContain('installPageResumeHandler(async () => {');
			expect(pageSource).toContain('loadAuthenticationMethods({ forceRefresh: true })');
			expect(pageSource).toContain('{#if methodsLoading}');
			expect(pageSource).not.toContain('{#if methodsLoading || runtimeInitialLoading}');
		});
	}

	it('preserves the authorization context in both auth switch links', () => {
		expect(source('routes/login/+page.svelte')).toContain(
			"buildAuthSwitchHref('/signup', $page.url.searchParams)"
		);
		expect(source('routes/signup/+page.svelte')).toContain(
			"buildAuthSwitchHref('/login', $page.url.searchParams)"
		);
	});
});
