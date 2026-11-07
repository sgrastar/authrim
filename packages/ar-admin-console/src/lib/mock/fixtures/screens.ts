import { createFakeScreens } from '#lib/api/fake/screens-fake.js';
import type { Screen } from '#lib/api/screens.js';

const AT = Date.UTC(2026, 10, 1, 9, 0, 0);

/** The mock's screens: two built-in ones, a sign-up copy, and a survey that keeps records. */
export const MOCK_SCREENS: Screen[] = [
	{
		id: 'screen_login',
		screen_key: 'login',
		display_name: 'Sign in',
		description: 'The built-in sign-in screen',
		screen_kind: 'login',
		fields: [
			{
				field: 'title',
				label: 'Sign in',
				required: false,
				block_type: 'heading',
				block_id: 'title'
			},
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
		],
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
	}
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
