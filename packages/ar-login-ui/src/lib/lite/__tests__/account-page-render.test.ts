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
});
