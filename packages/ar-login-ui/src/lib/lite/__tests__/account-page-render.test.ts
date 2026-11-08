/**
 * The lite account page's markup (LiteAccountPage.svelte): one passkey ceremony on the page, however
 * many passkey widgets its placements draw (the ceremony script takes the page's first form).
 */
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import AccountPage from '../../../routes/__lite/account/+page.svelte';

const widget = {
	kind: 'widget',
	widget: 'account_passkey_widget',
	title: 'Passkeys',
	column: null
};

describe('the lite account page markup', () => {
	it('draws a passkey being added once, never in each passkey widget', () => {
		const { body } = render(AccountPage, {
			props: {
				data: {
					page: 'account',
					brandName: 'Acme',
					logo: null,
					txnId: 'txn-1',
					csrfToken: 'csrf-1',
					op: 'o'.repeat(22),
					search: '',
					guest: false,
					stepUp: null,
					placements: [
						{ id: 'a', width: 'full', overview: false, blocks: [widget] },
						{ id: 'b', width: 'full', overview: false, blocks: [widget] }
					],
					widgets: {
						profile: { name: null, email: null, emailVerified: false },
						sessions: null,
						devices: null,
						consents: null,
						activity: null,
						activityIncomplete: false,
						activityNextHref: null,
						passkeys: [],
						passkeyCreate: { registration: { challenge: 'c' }, challenge: 'pc-1' }
					},
					text: new Proxy({}, { get: (_target, key) => String(key) })
				} as never,
				form: null as never
			}
		});
		expect(body.match(/data-lite-passkey-create=/gu)).toHaveLength(1);
		expect(body.match(/\/passkey_add_finish"/gu)).toHaveLength(1);
		// While it is drawn, the widgets offer no second start.
		expect(body).not.toContain('/passkey_add"');
	});

	it("draws an authenticator's setup, the backup codes answered, and a proof only for an active one", () => {
		const { body } = render(AccountPage, {
			props: {
				data: {
					page: 'account',
					brandName: 'Acme',
					logo: null,
					txnId: 'txn-1',
					csrfToken: 'csrf-1',
					op: 'o'.repeat(22),
					search: '',
					guest: false,
					stepUp: null,
					placements: [
						{
							id: 'a',
							width: 'full',
							overview: false,
							blocks: [
								{ kind: 'widget', widget: 'account_totp_widget', title: 'Apps', column: null }
							]
						}
					],
					widgets: {
						profile: { name: null, email: null, emailVerified: false },
						sessions: null,
						devices: null,
						consents: null,
						activity: null,
						activityIncomplete: false,
						activityNextHref: null,
						passkeys: null,
						passkeyCreate: null,
						totp: {
							credentials: [
								{ id: 'ta', name: 'Phone', meta: 'SHA1 / 6 / 30s', pending: false, used: '-' },
								{ id: 'tp', name: 'Tablet', meta: 'SHA1 / 6 / 30s', pending: true, used: '-' }
							],
							backupCodes: { total: 10, remaining: 9 },
							active: true
						},
						totpEnroll: {
							credentialId: 'tp',
							secret: 'JBSWY3DPEHPK3PXP',
							qr: 'data:image/png;base64,AA'
						},
						totpAddEnabled: true
					},
					text: new Proxy({}, { get: (_target, key) => String(key) })
				} as never,
				form: { backupCodes: ['AAAA-BBBB-CCCC'], widget: 'totp' } as never
			}
		});
		expect(body).toContain('<code>AAAA-BBBB-CCCC</code>');
		expect(body).toContain('src="data:image/png;base64,AA"');
		expect(body).toContain('<code>JBSWY3DPEHPK3PXP</code>');
		expect(body).toContain('/totp_activate"');
		// Setting one up, no second start.
		expect(body).not.toContain('/totp_add"');
		expect(body.match(/name="proof"/gu)).toHaveLength(1);
		expect(body).toContain('/totp_regenerate"');
	});
});
