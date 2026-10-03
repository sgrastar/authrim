import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import AccountSocialAccountsWidget from './AccountSocialAccountsWidget.svelte';
import { linkedIdentity, socialProviders } from './social-fixtures';

/** Svelte's SSR hydration comments, which split text from closing tags. */
const HYDRATION_MARKERS = /<!--[\s\S]*?-->/g;

const handlers = {
	onLink: (_providerId: string) => undefined,
	onUnlink: (_identityId: string) => undefined
};

function html(props: Record<string, unknown>): string {
	return render(AccountSocialAccountsWidget, { props: { ...handlers, ...props } }).body.replace(
		HYDRATION_MARKERS,
		''
	);
}

describe('AccountSocialAccountsWidget', () => {
	it('lists linked accounts and offers only the providers not yet linked', () => {
		setLocale('en');
		const body = html({ identities: [linkedIdentity()], providers: socialProviders() });

		expect(body).toContain('Google');
		expect(body).toContain('person@gmail.example');
		expect(body).toContain('Unlink');
		expect(body).toContain('Link GitHub');
		expect(body).not.toContain('Link Google');
	});

	it('matches a linked account to its provider by slug, else by id', () => {
		setLocale('en');
		const bySlug = html({
			identities: [linkedIdentity({ providerId: 'prov_google', providerSlug: 'google' })],
			providers: socialProviders()
		});
		expect(bySlug).not.toContain('Link Google');

		const byId = html({
			identities: [linkedIdentity({ providerId: 'google', providerSlug: undefined })],
			providers: socialProviders()
		});
		expect(byId).not.toContain('Link Google');
	});

	it('does not offer providers the tenant does not let sign in', () => {
		setLocale('en');
		const body = html({
			identities: [],
			providers: socialProviders().map((provider) =>
				provider.id === 'github' ? { ...provider, loginEnabled: false } : provider
			)
		});

		expect(body).toContain('Link Google');
		expect(body).not.toContain('Link GitHub');
	});

	it('says when nothing is linked and when nothing more can be', () => {
		setLocale('en');
		expect(html({ identities: [], providers: [] })).toContain('No external accounts are linked.');
		expect(
			html({
				identities: [
					linkedIdentity(),
					linkedIdentity({ id: 'linked-github', providerId: 'p2', providerSlug: 'github' })
				],
				providers: socialProviders()
			})
		).toContain('No other providers are available to link.');
	});

	it('announces an error outcome and states a success', () => {
		setLocale('en');
		expect(
			html({ identities: [], notice: { kind: 'error', message: 'Already linked elsewhere.' } })
		).toMatch(/role="alert"[^>]*>\s*Already linked elsewhere\./);
		expect(html({ identities: [], notice: { kind: 'success', message: 'Linked.' } })).toMatch(
			/role="status"[^>]*>\s*Linked\./
		);
	});

	it('lists without actions when no handlers are given', () => {
		setLocale('en');
		const body = render(AccountSocialAccountsWidget, {
			props: { identities: [linkedIdentity()], providers: socialProviders() }
		}).body;

		expect(body).toContain('Google');
		expect(body).not.toContain('Unlink');
		expect(body).not.toContain('Link GitHub');
	});

	it('draws a skeleton while loading', () => {
		setLocale('en');
		const body = html({ loading: true, identities: [], providers: socialProviders() });

		expect(body).not.toContain('No external accounts are linked.');
		expect(body).toContain('aria-busy="true"');
	});
});
