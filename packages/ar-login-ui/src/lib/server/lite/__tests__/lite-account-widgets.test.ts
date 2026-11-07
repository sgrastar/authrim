/**
 * The lite account page's widget readers (account-widgets.ts): what each widget shows, read from
 * the account APIs' answers as the SPA's widgets read them, and nothing else.
 */
import { describe, expect, it } from 'vitest';
import { liteMessages } from '../messages';
import {
	liteAccountActivity,
	liteAccountConsents,
	liteAccountDevices,
	liteAccountItemId,
	liteAccountProfile,
	liteAccountSessions
} from '../account-widgets';

describe('the lite account widgets', async () => {
	const { LL } = await liteMessages('en');

	it('reads the profile and only IDs of the API shapes', () => {
		expect(
			liteAccountProfile({ profile: { name: 'Kai', email: 'k@example.com', email_verified: true } })
		).toEqual({ name: 'Kai', email: 'k@example.com', emailVerified: true });
		expect(liteAccountProfile({})).toEqual({ name: null, email: null, emailVerified: false });
		expect(liteAccountItemId('0_session-1')).toBe('0_session-1');
		expect(liteAccountItemId('a/b')).toBeNull();
		expect(liteAccountItemId('')).toBeNull();
	});

	it('titles a session by its browser and system, its place in English', () => {
		const [current, other] = liteAccountSessions(
			{
				sessions: [
					{
						id: 's-a',
						current: true,
						browser: 'Firefox',
						os: 'macOS',
						country_code: 'jp',
						created_at: 1
					},
					{ id: 's-b', current: false },
					{ id: 'bad id', current: false }
				]
			},
			LL,
			'en'
		);
		expect(current).toMatchObject({
			id: 's-a',
			title: 'Firefox / macOS',
			current: true,
			location: 'Japan'
		});
		expect(other).toMatchObject({ id: 's-b', title: LL.account_unknownDevice(), location: null });
	});

	it('names a device by its own name, else its fallback, else its ID', () => {
		expect(
			liteAccountDevices(
				{
					devices: [
						{ id: 'd1', display_name: 'Laptop', platform: 'web', current: true },
						{ id: 'd2', fallback_display_name: 'App' },
						{ id: 'd3' }
					]
				},
				'en'
			).map((device) => device.title)
		).toEqual(['Laptop', 'App', 'd3']);
	});

	it("describes a client's consent and a statement's", () => {
		const [client, statement] = liteAccountConsents(
			{
				consents: [
					{
						kind: 'oauth_client',
						clientId: 'c1',
						clientName: 'App',
						clientLogoUri: 'https://cdn.example/logo.png',
						scopes: ['openid', 'email'],
						selectedScopes: ['openid'],
						grantedAt: 1,
						policyVersions: { tosVersion: '3', consentVersion: 2 }
					},
					{
						kind: 'statement',
						statementId: 'st1',
						title: 'News',
						status: 'withdrawn',
						version: '1',
						selectedValue: 'always'
					}
				]
			},
			LL,
			'en'
		);
		expect(client).toMatchObject({ kind: 'oauth_client', title: 'App', subtitle: 'c1' });
		// No logo: the lite page loads no image from elsewhere.
		expect(client).not.toHaveProperty('logo');
		expect(client.rows[0]).toEqual({ label: LL.account_consentScopes(), value: 'openid' });
		expect(client.rows.at(-1)?.value).toBe(
			`${LL.account_consentTerms()}: 3 / ${LL.account_consentVersion()}: 2`
		);
		expect(statement.rows[0]).toEqual({
			label: LL.account_consentStatus(),
			value: LL.account_consentStatusWithdrawn()
		});
		expect(statement.rows).toContainEqual({
			label: LL.account_consentSelectedValue(),
			value: LL.account_consentSelectedAlways()
		});
	});

	it('labels the activity it knows, each once, with the next page when there is one', () => {
		const activity = liteAccountActivity(
			{
				operations: [
					{ id: 'o1', action: 'account.passkey.created', created_at: 1_700_000_000 },
					{ id: 'o1', action: 'account.passkey.created', created_at: 1_700_000_000 },
					{ id: 'o2', action: 'custom.thing', created_at: 1_700_000_100 }
				],
				pagination: { has_more: true, next_cursor: 'abc_123' }
			},
			LL,
			'en'
		);
		expect(activity.items.map((item) => item.label)).toEqual([
			LL.account_operationPasskeyCreated(),
			'custom.thing'
		]);
		expect(activity.items[0].iso).toBe(new Date(1_700_000_000_000).toISOString());
		expect(activity.nextCursor).toBe('abc_123');
		expect(
			liteAccountActivity(
				{ operations: [], pagination: { has_more: false, next_cursor: 'x' } },
				LL,
				'en'
			).nextCursor
		).toBeNull();
	});
});
