import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import AccountConsentWidget from './AccountConsentWidget.svelte';
import { clientConsent, statementConsent } from './fixtures';
import { HYDRATION_MARKERS } from '#lib/testing/ssr-html.js';

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

	it('shows the information each client is given and how it was decided', () => {
		setLocale('en');
		const body = renderConsents({
			consents: [
				clientConsent(),
				clientConsent({
					id: 'trusted',
					informationRelease: { basis: 'trust', approved: [], declined: [], decidedAt: 1 }
				}),
				clientConsent({ id: 'old', informationRelease: undefined })
			]
		});

		expect(body).toContain('Information provided');
		expect(body).toContain('Full name, Email address');
		expect(body).toContain('Not provided');
		expect(body).toContain('Everything the service asks for (a trusted service)');
		expect(body).toContain('Not decided yet');
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

	describe('withdrawal', () => {
		const saml = {
			kind: 'saml_sp' as const,
			id: 'https://sp.example.edu/sp',
			spEntityId: 'https://sp.example.edu/sp',
			spName: 'Library portal',
			decidedAt: 1
		};

		it('offers a button naming each service, SAML provider and withdrawable statement', () => {
			setLocale('en');
			const body = renderConsents({
				consents: [
					clientConsent(),
					saml,
					statementConsent(),
					statementConsent({ id: 'fixed', title: 'Terms', withdrawable: false }),
					statementConsent({ id: 'old', title: 'Older record', withdrawable: undefined })
				],
				onWithdraw: () => {}
			});

			expect(body).toContain('aria-label="Withdraw consent for Docs"');
			expect(body).toContain('aria-label="Withdraw consent for Library portal"');
			expect(body).toContain('aria-label="Withdraw consent for Product news by email"');
			expect(body).not.toContain('Withdraw consent for Terms');
			expect(body).not.toContain('Withdraw consent for Older record');
		});

		it('draws no button for a read-only list, and shows the outcome', () => {
			setLocale('en');
			const readOnly = renderConsents({ consents: [clientConsent()] });
			expect(readOnly).not.toContain('Withdraw consent');

			const body = renderConsents({
				consents: [clientConsent()],
				onWithdraw: () => {},
				notice: { kind: 'error', message: 'It is already gone.' }
			});
			expect(body).toMatch(/role="alert"[^>]*>\s*It is already gone\./);
		});

		it('disables the other buttons while one withdrawal runs', () => {
			setLocale('en');
			const body = renderConsents({
				consents: [clientConsent(), statementConsent()],
				onWithdraw: () => {},
				actionLoading: 'consent:consent-client-1'
			});
			expect(body.match(/<button[^>]*disabled/gu)?.length).toBe(2);
		});
	});
});
