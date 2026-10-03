/**
 * A published account page composition for the account page stories: the placements of the
 * Admin console's default preset (`DEFAULT_ACCOUNT_PAGE_DEFINITION` in ar-lib-core), with their
 * blocks already localized the way AccountPage resolves them. Factories, so each story gets its
 * own objects.
 */
import type { AccountPageDefinition, AccountPageScreenField } from '$lib/api/account';

export type AccountPagePlacementFixture = Pick<
	AccountPageDefinition['screens'][number],
	'id' | 'screen_key' | 'width'
> & { fields: AccountPageScreenField[] };

const block = (
	field: string,
	blockType: NonNullable<AccountPageScreenField['block_type']>,
	overrides: Partial<AccountPageScreenField> = {}
): AccountPageScreenField => ({
	field,
	label: '',
	required: false,
	block_type: blockType,
	...overrides
});

/** The default preset, plus a text and a help link in the overview's two columns. */
export const accountPagePlacements = (): AccountPagePlacementFixture[] => [
	{
		id: 'overview',
		screen_key: 'account_overview',
		width: 'full',
		fields: [
			block('account.upgrade', 'account_upgrade_widget'),
			block('heading.account_overview', 'heading', { label: 'Manage your account' }),
			block('text.account_overview', 'text', {
				text: 'Review how you sign in, the devices you use and the apps you have allowed.',
				layout_column: 1
			}),
			block('link.account_help', 'link', {
				label: 'Account help',
				href: 'https://help.example.com/account',
				layout_column: 2
			})
		]
	},
	{
		id: 'launchers',
		screen_key: 'account_launchers',
		width: 'full',
		fields: [block('account.launchers', 'account_launcher_widget')]
	},
	{
		id: 'profile',
		screen_key: 'account_profile',
		width: 'half',
		fields: [block('account.profile', 'account_profile_widget')]
	},
	{
		id: 'devices',
		screen_key: 'account_devices',
		width: 'half',
		fields: [block('account.devices', 'account_device_list_widget')]
	},
	{
		id: 'sessions',
		screen_key: 'account_sessions',
		width: 'half',
		fields: [block('account.sessions', 'account_session_widget')]
	},
	{
		id: 'passkeys',
		screen_key: 'account_passkeys',
		width: 'half',
		fields: [block('account.passkeys', 'account_passkey_widget')]
	},
	{
		id: 'totp',
		screen_key: 'account_totp',
		width: 'full',
		fields: [block('account.totp', 'account_totp_widget')]
	},
	{
		id: 'consents',
		screen_key: 'account_consents',
		width: 'full',
		fields: [block('account.consents', 'account_consent_widget')]
	},
	{
		id: 'activity',
		screen_key: 'account_activity',
		width: 'full',
		fields: [block('account.activity', 'account_activity_widget')]
	}
];
