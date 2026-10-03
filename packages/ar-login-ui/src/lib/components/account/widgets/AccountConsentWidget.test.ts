import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import AccountConsentWidget from './AccountConsentWidget.svelte';
import { clientConsent, statementConsent } from './fixtures';
import { HYDRATION_MARKERS } from '$lib/testing/ssr-html';

function renderConsents(props: Partial<Parameters<typeof AccountConsentWidget>[1]> = {}) {
	return render(AccountConsentWidget, { props }).body.replace(HYDRATION_MARKERS, '');
}

describe('AccountConsentWidget', () => {
	it('lists clients with scopes and statements with their choice, and counts them', () => {
		setLocale('en');
		const body = renderConsents({ consents: [clientConsent(), statementConsent()] });

		expect(body).toContain('Docs');
		expect(body).toContain('openid, profile, email');
		expect(body).toContain('Product news by email');
		expect(body).toMatch(/class="count-badge[^"]*">2</);
	});

	it('hides the decorative kind letters from assistive technology', () => {
		setLocale('en');
		const body = renderConsents({ consents: [clientConsent(), statementConsent()] });

		expect(body).toMatch(/class="consent-icon[^"]*" aria-hidden="true">\s*A\s*</);
		expect(body).toMatch(/class="consent-icon[^"]*" aria-hidden="true">\s*C\s*</);
	});

	it('reports a load error as an alert instead of an empty list', () => {
		setLocale('en');
		const body = renderConsents({ error: 'Could not load account data' });

		expect(body).toMatch(/role="alert"[^>]*>Could not load account data/);
		expect(body).not.toContain('count-badge');
	});

	it('is a card with an h2 on its own and an h3 inside a parent panel', () => {
		setLocale('en');
		expect(renderConsents()).toContain('class="card');
		const nested = renderConsents({ headingLevel: 3 });
		expect(nested).toMatch(/<h3[^>]*>/);
		expect(nested).not.toContain('class="card');
	});
});
