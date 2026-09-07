import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import AuthSwitchLink from './AuthSwitchLink.svelte';

describe('AuthSwitchLink', () => {
	it('renders an accessible navigation link with a reserved inline spinner', () => {
		const body = render(AuthSwitchLink, {
			props: {
				href: '/signup?challenge=abc',
				label: 'Create account',
				loadingLabel: 'Loading'
			}
		}).body;

		expect(body).toContain('href="/signup?challenge=abc"');
		expect(body).toContain('data-sveltekit-reload');
		expect(body).toContain('aria-busy="false"');
		expect(body).toContain('auth-switch-link__spinner');
		expect(body).toContain('Create account');
	});

	it('switches to a non-repeatable loading state and respects reduced motion', () => {
		const source = readFileSync(
			fileURLToPath(new URL('./AuthSwitchLink.svelte', import.meta.url)),
			'utf8'
		);

		expect(source).toContain('loading = true;');
		expect(source).toContain('event.preventDefault();');
		expect(source).toContain('event.metaKey');
		expect(source).toContain('event.ctrlKey');
		expect(source).toContain('class:auth-switch-link__spinner--visible={loading}');
		expect(source).toContain('aria-live="polite"');
		expect(source).toContain('@media (prefers-reduced-motion: reduce)');
	});
});
