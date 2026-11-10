import { createFakeScreens } from '#lib/api/fake/screens-fake.js';
import type { Screen, ScreenField } from '#lib/api/screens.js';

const AT = Date.UTC(2026, 10, 1, 9, 0, 0);

const LOGIN_FIELDS: ScreenField[] = [
	{ field: 'title', label: 'Sign in', required: false, block_type: 'heading', block_id: 'title' },
	{
		field: 'passkey',
		label: 'Sign in with Passkey',
		required: false,
		block_type: 'auth_widget',
		block_id: 'passkey',
		auth_method: 'passkey'
	},
	{
		field: 'or',
		label: 'Divider',
		required: false,
		block_type: 'divider',
		block_id: 'or',
		text: 'or'
	},
	{
		field: 'email',
		label: 'Email code',
		required: false,
		block_type: 'auth_widget',
		block_id: 'mail',
		auth_method: 'mail_otp'
	}
];

const AUTH_PREVIEWS: Array<{
	key: 'registration' | 'login' | 'consent' | 'code_input';
	name: string;
	fields: ScreenField[];
}> = [
	{
		key: 'registration',
		name: 'Registration',
		fields: [
			{ field: 'title', label: 'Create your account', required: false, block_type: 'heading' },
			{
				field: 'passkey',
				label: 'Create account with Passkey',
				required: false,
				block_type: 'auth_widget',
				auth_method: 'passkey'
			}
		]
	},
	{ key: 'login', name: 'Sign in', fields: LOGIN_FIELDS },
	{
		key: 'consent',
		name: 'Consent',
		fields: [
			{
				field: 'consent',
				label: 'Consent confirmation',
				required: true,
				block_type: 'consent_widget'
			}
		]
	},
	{
		key: 'code_input',
		name: 'Code input',
		fields: [
			{
				field: 'code',
				label: 'Authentication code',
				required: true,
				block_type: 'code_input_widget',
				auth_method: 'mail_otp'
			}
		]
	}
];

const ACCOUNT_PREVIEWS: Array<{
	key: string;
	name: string;
	widget: ScreenField['block_type'];
}> = [
	{ key: 'account_activity', name: 'Account activity', widget: 'account_activity_widget' },
	{ key: 'account_overview', name: 'Account overview', widget: 'heading' },
	{ key: 'account_launchers', name: 'Application launchers', widget: 'account_launcher_widget' },
	{ key: 'account_totp', name: 'Authenticator app', widget: 'account_totp_widget' },
	{
		key: 'account_social_accounts',
		name: 'Connected accounts',
		widget: 'account_social_account_widget'
	},
	{
		key: 'account_devices',
		name: 'Connected apps and devices',
		widget: 'account_device_list_widget'
	},
	{ key: 'account_consents', name: 'Consent information', widget: 'account_consent_widget' },
	{ key: 'account_custom', name: 'Custom guidance', widget: 'heading' },
	{ key: 'account_passkeys', name: 'Passkeys', widget: 'account_passkey_widget' },
	{ key: 'account_sessions', name: 'Signed-in devices', widget: 'account_session_widget' },
	{ key: 'account_profile', name: 'User profile', widget: 'account_profile_widget' }
];

/** The mock's screens: built-in auth templates plus saved flow and account screens. */
export const MOCK_SCREENS: Screen[] = [
	{
		id: 'screen_login',
		screen_key: 'login_template',
		display_name: 'Sign in',
		description: 'The built-in sign-in screen',
		screen_kind: 'login',
		fields: structuredClone(LOGIN_FIELDS),
		localizations: { ja: { display_name: 'ログイン', fields: { title: { label: 'ログイン' } } } },
		settings: { canvas_layout: 'narrow' },
		is_active: true,
		is_system: true,
		version: 1,
		created_at: AT,
		updated_at: AT
	},
	{
		id: 'screen_signup',
		screen_key: 'registration_custom',
		display_name: 'Sign up',
		description: null,
		screen_kind: 'registration',
		fields: [
			{
				field: 'title',
				label: 'Create your account',
				required: false,
				block_type: 'heading',
				block_id: 'title'
			},
			{
				field: 'names',
				label: 'Layout row',
				required: false,
				block_type: 'layout_row',
				block_id: 'names',
				layout_columns: 2
			},
			{
				field: 'given_name',
				label: 'Given name',
				required: true,
				block_id: 'given',
				layout_column: 1
			},
			{
				field: 'family_name',
				label: 'Family name',
				required: true,
				block_id: 'family',
				layout_column: 2
			},
			{
				field: 'rest',
				label: 'Layout row',
				required: false,
				block_type: 'layout_row',
				block_id: 'rest',
				layout_columns: 1
			},
			{
				field: 'news_opt_in',
				label: 'Send me news',
				required: false,
				block_type: 'checkbox',
				block_id: 'news'
			}
		],
		localizations: {},
		settings: { canvas_layout: 'narrow', base_preset_key: 'registration', base_preset_version: 1 },
		is_active: true,
		is_system: false,
		version: 3,
		created_at: AT,
		updated_at: AT + 86_400_000
	},
	{
		id: 'screen_survey',
		screen_key: 'welcome_survey',
		display_name: 'Welcome survey',
		description: 'Asked once after the first sign-in',
		screen_kind: 'custom',
		fields: [
			{
				field: 'title',
				label: 'One quick question',
				required: false,
				block_type: 'heading',
				block_id: 'title'
			},
			{
				field: 'heard_from',
				label: 'How did you hear about us?',
				required: true,
				block_type: 'radio',
				block_id: 'heard',
				store_to_profile: false,
				answer_targets: ['flow_event', 'record'],
				options: [
					{ value: 'web', label: 'Web search' },
					{ value: 'friend', label: 'A friend' },
					{ value: 'event', label: 'An event' }
				]
			},
			{
				field: 'note',
				label: 'Anything else?',
				required: false,
				block_id: 'note',
				store_to_profile: false,
				answer_targets: ['record']
			}
		],
		localizations: {},
		settings: { canvas_layout: 'narrow' },
		is_active: true,
		is_system: false,
		version: 2,
		created_at: AT,
		updated_at: AT + 2 * 86_400_000
	},
	{
		id: 'screen_profile',
		screen_key: 'profile_completion',
		display_name: 'Profile completion',
		description: 'The built-in profile completion screen',
		screen_kind: 'profile_completion',
		fields: [
			{ field: 'name', label: 'Name', required: true },
			{ field: 'preferred_username', label: 'Preferred username', required: false }
		],
		localizations: {},
		settings: { canvas_layout: 'narrow' },
		is_active: true,
		is_system: true,
		version: 1,
		created_at: AT,
		updated_at: AT
	},
	...AUTH_PREVIEWS.map(
		({ key, name, fields }, index): Screen => ({
			id: `screen_default_${key}`,
			screen_key: key,
			display_name: name,
			description: null,
			screen_kind: key,
			fields: structuredClone(fields),
			localizations: {},
			settings: { canvas_layout: 'narrow' },
			is_active: true,
			is_system: false,
			version: 1,
			created_at: AT + index * 1000,
			updated_at: AT + index * 1000
		})
	),
	...AUTH_PREVIEWS.filter(({ key }) => key !== 'login').map(
		({ key, name, fields }, index): Screen => ({
			id: `template_${key}`,
			screen_key: `${key}_template`,
			display_name: name,
			description: null,
			screen_kind: key,
			fields: structuredClone(fields),
			localizations: {},
			settings: { canvas_layout: 'narrow' },
			is_active: true,
			is_system: true,
			version: 1,
			created_at: AT + index * 1000,
			updated_at: AT + index * 1000
		})
	),
	...ACCOUNT_PREVIEWS.map(
		({ key, name, widget }, index): Screen => ({
			id: `screen_${key}`,
			screen_key: key,
			display_name: name,
			description: null,
			screen_kind: 'account',
			fields: [{ field: key, label: name, required: false, block_type: widget, order: 10 }],
			localizations: {},
			settings: { canvas_layout: 'wide' },
			is_active: true,
			is_system: false,
			version: 1,
			created_at: AT + index * 1000,
			updated_at: AT + index * 1000
		})
	),
	...ACCOUNT_PREVIEWS.map(
		({ key, name, widget }, index): Screen => ({
			id: `template_${key}`,
			screen_key: `${key}_template`,
			display_name: name,
			description: null,
			screen_kind: 'account',
			fields: [{ field: key, label: name, required: false, block_type: widget, order: 10 }],
			localizations: {},
			settings: { canvas_layout: 'wide' },
			is_active: true,
			is_system: true,
			version: 1,
			created_at: AT + index * 1000,
			updated_at: AT + index * 1000
		})
	)
];

export const mockScreens = createFakeScreens({
	delay: 150,
	screens: MOCK_SCREENS,
	usages: {
		screen_login: [
			{
				kind: 'flow',
				flow_id: 'flow_login',
				flow_name: 'Default sign-in',
				node_id: 'login',
				node_title: 'Sign in',
				stage: 'published'
			}
		],
		screen_survey: [
			{
				kind: 'flow',
				flow_id: 'flow_login',
				flow_name: 'Default sign-in',
				node_id: 'survey',
				node_title: 'Welcome survey',
				stage: 'draft'
			}
		]
	},
	responses: {
		screen_survey: Array.from({ length: 30 }, (_, index) => ({
			id: `response_${index + 1}`,
			user_id: `user_${(index % 7) + 1}`,
			screen_key: 'welcome_survey',
			flow_id: 'flow_login',
			flow_version_id: 'version_1',
			interaction_id: `interaction_${index + 1}`,
			step_id: 'survey:step',
			answers: (index % 3 === 0
				? { heard_from: 'friend', note: 'Glad to be here' }
				: { heard_from: index % 2 ? 'web' : 'event' }) as Record<string, string>,
			created_at: AT + index * 3_600_000,
			updated_at: AT + index * 3_600_000
		}))
	}
});
