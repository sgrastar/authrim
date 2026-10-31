import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
	return readFileSync(resolve(__dirname, '..', path), 'utf8');
}

describe('login and signup entry motion', () => {
	it('enables the shared staggered reveal on both authentication forms', () => {
		for (const [page, view] of [
			['routes/login/+page.svelte', 'lib/views/LoginView.svelte'],
			['routes/signup/+page.svelte', 'lib/views/SignupView.svelte']
		]) {
			const pageSource = source(page);
			const viewSource = source(view);

			// The route owns the timer; the view draws the form and the provider stack it staggers.
			expect(pageSource).toContain('entryMotion={entryMotionEnabled}');
			expect(pageSource).toContain('if (initialAuthUiLoading) return;');
			expect(pageSource).toContain('entryMotionEnabled = false;');
			expect(viewSource).toContain('class="auth-entry-form"');
			expect(viewSource).toContain('<ExternalProviderStack');
		}
		expect(source('lib/views/parts/ExternalProviderStack.svelte')).toContain(
			'class="auth-provider-stack space-y-3"'
		);
	});

	it('lets the shared shell carry the reveal class', () => {
		expect(source('lib/components/AuthPageShell.svelte')).toContain(
			'class:auth-page--entry-motion={entryMotion}'
		);
	});

	it('reveals only transform and opacity in reading order', () => {
		const css = source('app.css');

		expect(css).toContain('@keyframes auth-entry-reveal');
		expect(css).toContain('transform: translate3d(0, 12px, 0);');
		expect(css).toContain('--auth-entry-delay: 55ms;');
		expect(css).toContain('220ms + var(--auth-entry-section-delay, 0ms) + var(--auth-entry-delay)');
		expect(css).toContain(
			'.auth-page--entry-motion .runtime-layout-section > .runtime-layout-cell'
		);
		expect(css).toContain('.auth-page--entry-motion .auth-provider-stack > *');
	});

	it('does not run the entry animation when reduced motion is requested', () => {
		const css = source('app.css');
		const motionBlock = css.match(
			/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\/\* --- Built-in Login UI theme templates --- \*\//
		)?.[0];

		expect(motionBlock).toBeDefined();
		expect(motionBlock).toContain('animation: auth-entry-reveal');
	});
});
