/**
 * The lite account page's linked external accounts (account-social.ts): what the widget lists, the
 * outcome a provider sends back, and the only start of a link the page sends the browser to.
 */
import { describe, expect, it } from 'vitest';
import { liteMessages } from '../messages';
import { liteAccountSocial, liteAccountSocialOutcome, liteLinkStartUrl } from '../account-social';

const INTENT = 'a'.repeat(43);

describe('the lite linked accounts', async () => {
	const { LL } = await liteMessages('en');

	it('lists the accounts linked, and the providers that may be linked still', () => {
		const view = liteAccountSocial(
			{
				identities: [
					{
						id: 'li-1',
						providerId: 'p-google',
						providerSlug: 'google',
						providerName: 'Google',
						providerEmail: 'a@example.com',
						linkedAt: 1_700_000_000,
						lastLoginAt: 1_700_000_100
					},
					{ id: 'bad id', providerId: 'github', providerName: 'GitHub', linkedAt: 1 }
				]
			},
			[
				{ id: 'google', name: 'Google', startMode: 'oauth_redirect' },
				// Linked by its ID (no slug): not offered again, though its row is not drawn.
				{ id: 'github', name: 'GitHub', startMode: 'oauth_redirect' },
				{ id: 'corp', name: 'Corp', startMode: 'saml_sp' },
				{ id: 'off', name: 'Off', startMode: 'oauth_redirect', loginEnabled: false },
				{ id: 'gone', name: 'Gone', startMode: 'oauth_redirect', enabled: false },
				{ id: 'apple', name: 'Apple', startMode: 'oauth_redirect' },
				{ id: 'a/b', name: 'Bad', startMode: 'oauth_redirect' }
			],
			LL,
			'en'
		);
		expect(view.identities).toEqual([
			expect.objectContaining({ id: 'li-1', name: 'Google', email: 'a@example.com' })
		]);
		expect(view.identities[0].meta).toContain(LL.account_socialLastUsed({ date: '' }).trim());
		expect(view.linkable).toEqual([
			{ id: 'apple', label: LL.account_socialLinkWith({ provider: 'Apple' }) }
		]);
	});

	it("says a link's outcome as the SPA does", () => {
		expect(
			liteAccountSocialOutcome(new URL('https://id.example/account?social_link=linked'), LL)
		).toEqual({ kind: 'success', message: LL.account_socialLinked() });
		expect(
			liteAccountSocialOutcome(
				new URL('https://id.example/account?social_link=error&reason=already_linked'),
				LL
			)
		).toEqual({ kind: 'error', message: LL.account_socialErrorAlreadyLinked() });
		expect(
			liteAccountSocialOutcome(
				new URL('https://id.example/account?social_link=error&reason=<b>'),
				LL
			)?.message
		).toBe(LL.account_socialErrorFailed());
		expect(liteAccountSocialOutcome(new URL('https://id.example/account'), LL)).toBeNull();
	});

	it('draws the start of a link on the public origin, and nothing else', () => {
		const origin = 'https://id.example';
		const start = `/auth/external/google/start?link_intent=${INTENT}`;
		expect(liteLinkStartUrl(`https://id.example${start}`, origin)).toBe(`${origin}${start}`);
		// ar-bridge names its issuer's host; a tenant's own domain is the page's.
		expect(liteLinkStartUrl(`https://tenant.authrim.example${start}`, origin)).toBe(
			`${origin}${start}`
		);
		expect(liteLinkStartUrl(`https://id.example${start}&tenant_hint=t1`, origin)).toBe(
			`${origin}${start}&tenant_hint=t1`
		);
		for (const refused of [
			`https://id.example${start}&redirect_uri=x`,
			`https://id.example${start}&link_intent=${INTENT}`,
			`https://id.example/auth/external/google/start?link_intent=short`,
			`https://id.example/auth/external/google/callback?link_intent=${INTENT}`,
			`https://user:pw@id.example${start}`,
			`https://id.example${start}#x`,
			start,
			`javascript:alert(1)`,
			42
		]) {
			expect(liteLinkStartUrl(refused, origin)).toBeNull();
		}
	});
});
