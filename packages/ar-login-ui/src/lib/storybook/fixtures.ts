/**
 * Runtime screens and their inputs, in the shape the Admin console saves them and the login and
 * signup routes hand to RuntimeScreen. Block order, labels and conditions follow the shipped
 * default screens (`DEFAULT_SCREENS` in ar-management) plus the blocks an admin can add.
 */
import type { ExternalProvider } from '$lib/api/authentication-methods';
import type {
	FlowRuntimeConsentPolicyContent,
	FlowRuntimeDestinationFieldConsentContent
} from '$lib/api/flow-runtime';
import { getExternalProviderIconClass } from '$lib/login-provider-icons';

export type SampleField = Record<string, unknown> & { field: string; label: string };

export type SampleScreen = {
	id: string;
	screen_key: string;
	display_name: string;
	screen_kind: string;
	fields: SampleField[];
	localizations?: Record<string, unknown>;
	settings?: { canvas_layout?: 'narrow' | 'wide' };
};

export function screenOf(
	fields: SampleField[],
	settings: SampleScreen['settings'] = { canvas_layout: 'narrow' },
	kind = 'login'
): SampleScreen {
	return {
		id: `story-${kind}`,
		screen_key: kind,
		display_name: kind,
		screen_kind: kind,
		// The Admin console gives every block a stable id; RuntimeScreen keys its list by it.
		fields: fields.map((field, index) => ({
			required: false,
			order: index * 10,
			block_id: `${field.field}-${index}`,
			...field
		})),
		settings
	};
}

/** One block per entry so stories can compose, hide or reorder them. */
export const blocks = {
	heading: (label = 'Sign in', text?: string): SampleField => ({
		field: 'heading.login',
		label,
		block_type: 'heading',
		...(text ? { text } : {})
	}),
	text: (text: string): SampleField => ({
		field: 'text.note',
		label: text,
		block_type: 'text',
		text
	}),
	divider: (text = 'or', feature?: string): SampleField => ({
		field: `divider.${text}`,
		label: text,
		block_type: 'divider',
		text,
		...(feature ? { display_condition: { mode: 'feature_enabled', feature } } : {})
	}),
	passkey: (label = 'Sign in with Passkey'): SampleField => ({
		field: 'auth.passkey',
		label,
		block_type: 'auth_widget',
		auth_method: 'passkey'
	}),
	mailOtp: (label = 'Send code by email'): SampleField => ({
		field: 'auth.mail_otp',
		label,
		block_type: 'auth_widget',
		auth_method: 'mail_otp'
	}),
	totp: (label = 'Sign in with authenticator app'): SampleField => ({
		field: 'auth.totp',
		label,
		block_type: 'auth_widget',
		auth_method: 'totp'
	}),
	mailOtpTotp: (label = 'Continue'): SampleField => ({
		field: 'auth.mail_otp_totp',
		label,
		block_type: 'auth_widget',
		auth_method: 'mail_otp_totp'
	}),
	externalIdp: (showActionText = false, label = 'Ext. IdP'): SampleField => ({
		field: 'auth.external_idp',
		label,
		block_type: 'auth_widget',
		auth_method: 'external_idp',
		external_idp_show_action_text: showActionText
	}),
	directoryPassword: (label = 'Sign in with directory password'): SampleField => ({
		field: 'auth.directory_password',
		label,
		block_type: 'auth_widget',
		auth_method: 'directory_password'
	}),
	guest: (label = 'Continue as a guest'): SampleField => ({
		field: 'auth.guest',
		label,
		block_type: 'guest_login_widget'
	}),
	codeInput: (method: 'mail_otp' | 'totp' | 'auto' = 'auto'): SampleField => ({
		field: 'auth.code_input',
		label: 'Authentication code',
		required: true,
		block_type: 'code_input_widget',
		auth_method: method === 'auto' ? undefined : method,
		code_input_mode: method,
		text: 'Enter the code from your email or authenticator app.'
	}),
	consent: (): SampleField => ({
		field: 'consent.policy',
		label: 'Consent confirmation',
		required: true,
		block_type: 'consent_widget',
		text: 'Review the consent items required for this step.'
	}),
	security: (timing: 'initial' | 'submit' = 'initial'): SampleField => ({
		field: 'security.verification',
		label: 'Security verification',
		block_type: 'security_verification',
		human_verification_timing: timing
	}),
	email: (): SampleField => ({
		field: 'email',
		label: 'Email',
		required: true,
		block_type: 'identity_field',
		placeholder: 'you@example.com'
	}),
	name: (field: string, label: string, column?: number): SampleField => ({
		field,
		label,
		block_type: 'identity_field',
		block_id: `${field}-1`,
		...(column ? { layout_column: column } : {})
	}),
	checkbox: (field: string, label: string, placeholder: string): SampleField => ({
		field,
		label,
		block_type: 'identity_field',
		value_type: 'boolean',
		placeholder
	}),
	row: (columns: 1 | 2, id = 'row-1'): SampleField => ({
		field: `layout.${id}`,
		label: 'Layout row',
		block_type: 'layout_row',
		block_id: id,
		layout_columns: columns
	}),
	/** Add to any block to show it only while the method is available (or never). */
	when: (field: SampleField, condition: 'hidden' | { feature: string }): SampleField => ({
		...field,
		display_condition:
			condition === 'hidden'
				? { mode: 'hidden' }
				: { mode: 'feature_enabled', feature: condition.feature }
	})
};

/** The shipped login screen: every method, dividers that follow the methods they separate. */
export const defaultLoginScreen = screenOf(
	[
		blocks.heading('Sign in'),
		blocks.passkey(),
		blocks.divider('or', 'mail_otp'),
		blocks.mailOtp(),
		blocks.totp(),
		blocks.divider('Continue with another account', 'external_idp'),
		blocks.externalIdp(),
		blocks.divider('or', 'directory_password'),
		blocks.directoryPassword(),
		blocks.guest()
	],
	{ canvas_layout: 'narrow' },
	'login'
);

/** A registration screen as an admin might author it: email, a two-column name row, extras. */
export const registrationScreen = screenOf(
	[
		blocks.heading('Create your account'),
		blocks.passkey('Create Account with Passkey'),
		blocks.email(),
		blocks.divider('or', 'mail_otp'),
		blocks.mailOtp(),
		blocks.totp('Create account with authenticator app'),
		blocks.row(2),
		blocks.name('given_name', 'First name', 1),
		blocks.name('family_name', 'Last name', 2),
		blocks.checkbox('newsletter', 'Newsletter', 'Send me product news'),
		blocks.security('submit'),
		blocks.consent()
	],
	{ canvas_layout: 'wide' },
	'registration'
);

export const codeInputScreen = screenOf(
	[blocks.heading('Enter your code'), blocks.codeInput()],
	{ canvas_layout: 'narrow' },
	'code_input'
);

export const allMethods = {
	passkey: true,
	mail_otp: true,
	mail_otp_totp: true,
	totp: true,
	external_idp: true,
	directory_password: true
} as const;

const providers: ExternalProvider[] = [
	{ id: 'google', name: 'Google', type: 'oidc', startMode: 'oauth_redirect' },
	{ id: 'github', name: 'GitHub', type: 'oauth2', startMode: 'oauth_redirect' },
	{ id: 'microsoft', name: 'Microsoft', type: 'oidc', startMode: 'oauth_redirect' },
	{
		id: 'corp',
		name: 'Acme employee SSO',
		type: 'saml',
		startMode: 'saml_sp',
		buttonColor: '#2563eb',
		buttonColorDark: '#93c5fd'
	}
];

/** What routes/login maps `visibleExternalProviders` to before handing them to RuntimeScreen. */
export const externalProviders = providers.map((provider) => ({
	id: provider.id,
	label: provider.name,
	iconUrl: null,
	iconClass: getExternalProviderIconClass(provider),
	style: provider.buttonColor
		? `border-color: ${provider.buttonColor}; color: ${provider.buttonColor};`
		: ''
}));

export const consentPolicy: FlowRuntimeConsentPolicyContent = {
	id: 'policy_terms',
	display_name: 'Terms and privacy',
	description: null,
	language: 'en',
	default_language: 'en',
	items: [
		{
			statement_id: 'tos',
			slug: 'tos',
			category: 'terms',
			title: 'Terms of Service',
			description: 'I agree to the Terms of Service.',
			document_url: 'https://example.com/terms',
			inline_content: null,
			version: '2',
			version_id: 'v2',
			is_required: true,
			content_mode: 'checkbox',
			checkbox_mode: 'required',
			checkbox_default_checked: false,
			display_order: 0
		},
		{
			statement_id: 'newsletter',
			slug: 'newsletter',
			category: 'marketing',
			title: 'Product news',
			description: 'Send me product news by email.',
			document_url: null,
			inline_content: null,
			version: '1',
			version_id: 'v1',
			is_required: false,
			content_mode: 'checkbox',
			checkbox_mode: 'optional',
			checkbox_default_checked: false,
			display_order: 1
		},
		{
			statement_id: 'privacy',
			slug: 'privacy',
			category: 'privacy',
			title: 'Privacy notice',
			description: 'We process your data as described in the privacy notice.',
			document_url: null,
			inline_content: null,
			version: '1',
			version_id: 'v1',
			is_required: false,
			content_mode: 'display_only',
			checkbox_mode: 'none',
			checkbox_default_checked: false,
			display_order: 2
		}
	]
};

export const destinationFieldConsent: FlowRuntimeDestinationFieldConsentContent = {
	profile_id: 'profile_crm',
	profile_version_id: 'v1',
	destination_type: 'oidc',
	consent_mode: 'once',
	fields: [
		{
			key: 'email',
			label: 'Email address',
			required: true,
			nullable: false,
			classification: 'contact',
			surfaces: ['id_token'],
			required_scopes: ['email']
		},
		{
			key: 'phone_number',
			label: 'Phone number',
			required: false,
			nullable: true,
			classification: 'contact',
			surfaces: ['userinfo'],
			required_scopes: ['phone']
		}
	]
};
