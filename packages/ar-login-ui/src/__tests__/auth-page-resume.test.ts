import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
	return readFileSync(resolve(__dirname, '..', path), 'utf8');
}

describe('auth page resume recovery', () => {
	for (const page of ['routes/login/+page.svelte', 'routes/signup/+page.svelte']) {
		it(`waits for the initial runtime contract without hiding the ${page} card on resume`, () => {
			const pageSource = source(page);

			expect(pageSource).toContain('installPageResumeHandler(async () => {');
			expect(pageSource).toContain('loadAuthenticationMethods({ forceRefresh: true })');
			expect(pageSource).toContain('let initialRuntimeBootstrapPending = $state(true);');
			expect(pageSource).toContain(
				'const initialAuthUiLoading = $derived(methodsLoading || initialRuntimeBootstrapPending);'
			);
			expect(pageSource).toContain('{#if initialAuthUiLoading}');
			expect(pageSource).toContain('initialRuntimeBootstrapPending = false;');
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
