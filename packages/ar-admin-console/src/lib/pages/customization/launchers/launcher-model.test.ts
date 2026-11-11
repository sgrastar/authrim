import { describe, expect, it } from 'vitest';
import { FAKE_LAUNCHERS, FAKE_LAUNCHER_OPTIONS } from '#lib/api/fake/launchers-fake.js';
import {
	categoriesOf,
	launcherInput,
	launcherProblems,
	launcherValue,
	moved,
	newLauncherValue,
	nextSortOrder,
	tileTextColor,
	type LauncherEditorValue
} from './launcher-model';

const noNames = { users: new Map(), groups: new Map() };
const choices = {
	clients: FAKE_LAUNCHER_OPTIONS.oidc_clients,
	samlProviderIds: new Set(['saml-sp-lms'])
};
const value = (patch: Partial<LauncherEditorValue> = {}): LauncherEditorValue => ({
	...newLauncherValue(),
	name: 'Docs',
	launchUrl: 'https://docs.example.edu/',
	...patch
});

describe('launcher editor value', () => {
	it('round-trips a saved launcher to the same API input', () => {
		for (const launcher of FAKE_LAUNCHERS) {
			const { id: _id, created_at: _c, updated_at: _u, ...stored } = launcher;
			const uri =
				FAKE_LAUNCHER_OPTIONS.oidc_clients.find(
					(client) => client.client_id === launcher.application_id
				)?.initiate_login_uri ?? null;
			expect(launcherInput(launcherValue(launcher, noNames), launcher.sort_order, uri)).toEqual(
				stored
			);
		}
	});

	it('keeps the picture address and the Phosphor icon apart', () => {
		const image = launcherInput(
			value({ iconType: 'image', imageUrl: ' https://cdn.example/a.png ' }),
			0
		);
		expect(image).toMatchObject({ icon_type: 'image', icon_value: 'https://cdn.example/a.png' });
		expect(launcherInput(value({ imageUrl: 'https://cdn.example/a.png' }), 0).icon_value).toBe(
			'rocket-launch'
		);
	});

	it('sends only the lists of the audience in use', () => {
		const input = launcherInput(
			value({
				audience: 'groups',
				users: [{ value: 'user-1', label: 'One' }],
				groups: [{ value: 'grp-staff', label: 'Staff' }],
				rules: [{ id: 'r', attribute_key: 'email', operator: 'exists', attribute_value: 'x' }]
			}),
			0
		);
		expect(input.visibility).toEqual({
			mode: 'groups',
			attribute_match: 'all',
			user_ids: [],
			group_ids: ['grp-staff'],
			attribute_rules: []
		});
		const rules = launcherInput(
			value({
				audience: 'attributes',
				rules: [{ id: 'r', attribute_key: ' email ', operator: 'exists', attribute_value: 'x' }]
			}),
			0
		).visibility.attribute_rules;
		expect(rules).toEqual([
			{ id: 'r', attribute_key: 'email', operator: 'exists', attribute_value: null }
		]);
	});

	it('leaves the order to the list when a launcher is changed', () => {
		expect(launcherInput(value(), undefined)).not.toHaveProperty('sort_order');
		expect(launcherInput(value(), 40).sort_order).toBe(40);
	});

	it('needs colours the API accepts, and fills in the icon colour a picture hides', () => {
		expect(launcherProblems(value({ backgroundColor: '' }), choices).colors).toBe(
			'ln.error.colorRequired'
		);
		const picture = value({
			iconType: 'image',
			imageUrl: 'https://cdn.example/a.png',
			iconColor: ''
		});
		expect(launcherProblems(picture, choices)).toEqual({});
		expect(launcherInput(picture, 0).icon_color).toBe('#ffffff');
	});

	it('sends the tile colour only while it is on, and keeps it while it is off', () => {
		const off = value({ tileColored: false, tileBackground: '#fde68a' });
		expect(launcherInput(off, 0).tile_background_color).toBeNull();
		expect(launcherInput({ ...off, tileColored: true }, 0).tile_background_color).toBe('#fde68a');
		expect(launcherProblems(value({ tileColored: true, tileBackground: '' }), choices).colors).toBe(
			'ln.error.colorRequired'
		);
		expect(launcherProblems(value({ tileBackground: '' }), choices)).toEqual({});
	});

	it('writes black on light tiles and white on dark ones', () => {
		expect(tileTextColor('#fde68a')).toBe('#000000');
		expect(tileTextColor('#1e3a8a')).toBe('#ffffff');
	});

	it('sends only the addresses the launch type uses', () => {
		expect(
			launcherInput(
				value({
					applicationType: 'oidc_client',
					applicationId: 'client-portal',
					launchType: 'oidc_third_party_initiated',
					launchUrl: 'https://typed.example/',
					deepLinkUrl: 'https://portal.example.edu/grades'
				}),
				0,
				'https://portal.example.edu/login/start'
			)
		).toMatchObject({
			launch_url: 'https://portal.example.edu/login/start',
			deep_link_url: 'https://portal.example.edu/grades'
		});
		expect(
			launcherInput(
				value({
					applicationType: 'saml_sp',
					launchType: 'saml_sp_initiated',
					deepLinkUrl: 'https://x/'
				}),
				0
			).deep_link_url
		).toBeNull();
		expect(
			launcherInput(value({ applicationType: 'saml_sp', launchType: 'saml_idp_initiated' }), 0)
				.launch_url
		).toBeNull();
	});
});

describe('launcher problems', () => {
	it('accepts a complete link', () => {
		expect(launcherProblems(value(), choices)).toEqual({});
	});

	it('asks for a name, an HTTPS address and a picture', () => {
		expect(
			launcherProblems(
				value({ name: ' ', launchUrl: 'http://docs.example/', iconType: 'image', imageUrl: '' }),
				choices
			)
		).toEqual({
			name: 'ln.error.nameRequired',
			launchUrl: 'ln.error.httpsOnly',
			imageUrl: 'ln.error.imageRequired'
		});
	});

	it('needs an application that can be chosen, unless the choices could not be read', () => {
		const oidc = value({ applicationType: 'oidc_client', applicationId: 'gone' });
		expect(launcherProblems(oidc, choices).applicationId).toBe('ln.error.clientUnavailable');
		expect(
			launcherProblems(oidc, { ...choices, optionsKnown: false }).applicationId
		).toBeUndefined();
		expect(
			launcherProblems(
				value({ applicationType: 'saml_sp', launchType: 'saml_sp_initiated' }),
				choices
			).applicationId
		).toBe('ln.error.spRequired');
	});

	it('refuses third-party login for a client without initiate_login_uri', () => {
		expect(
			launcherProblems(
				value({
					applicationType: 'oidc_client',
					applicationId: 'client-reports',
					launchType: 'oidc_third_party_initiated'
				}),
				choices
			).launchType
		).toBe('ln.error.noInitiateLoginUri');
	});

	it('limits RelayState to 80 bytes and needs no launch URL for IdP-initiated SSO', () => {
		const idp = value({
			applicationType: 'saml_sp',
			applicationId: 'saml-sp-lms',
			launchType: 'saml_idp_initiated',
			launchUrl: ''
		});
		expect(launcherProblems(idp, choices)).toEqual({});
		expect(
			launcherProblems({ ...idp, deepLinkUrl: `https://example.edu/${'a'.repeat(80)}` }, choices)
				.deepLinkUrl
		).toBe('ln.error.relayStateTooLong');
	});

	it('needs someone to show it to', () => {
		expect(launcherProblems(value({ audience: 'users' }), choices).users).toBe(
			'ln.error.usersRequired'
		);
		expect(launcherProblems(value({ audience: 'groups' }), choices).groups).toBe(
			'ln.error.groupsRequired'
		);
		expect(
			launcherProblems(
				value({
					audience: 'attributes',
					rules: [{ id: 'r', attribute_key: 'bad key', operator: 'equals', attribute_value: 'x' }]
				}),
				choices
			).rules
		).toBe('ln.error.rulesInvalid');
	});
});

describe('launcher list helpers', () => {
	it('adds new launchers after the last one', () => {
		expect(nextSortOrder(FAKE_LAUNCHERS)).toBe(30);
		expect(nextSortOrder([])).toBe(0);
	});

	it('lists each category once, sorted', () => {
		expect(categoriesOf(FAKE_LAUNCHERS, 'en')).toEqual(['Campus', 'Knowledge']);
	});

	it('moves one entry by one place and stays put at the ends', () => {
		expect(moved(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
		expect(moved(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
	});
});
