import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { setLocale } from '$i18n/i18n-svelte';
import RuntimeScreen from './RuntimeScreen.svelte';

const emailField = {
	field: 'email',
	label: 'Account email',
	required: true,
	block_type: 'identity_field',
	placeholder: 'name@example.edu',
	order: 10
};

const mailOtpWidget = {
	field: 'auth.mail_otp',
	label: 'Send code by email',
	required: false,
	block_type: 'auth_widget',
	auth_method: 'mail_otp',
	order: 20
};

function renderScreen(
	fields: Array<Record<string, unknown>>,
	authMethodMode: 'login' | 'signup',
	emailVerificationProtocolEnabled = false
) {
	setLocale('en');
	return render(RuntimeScreen, {
		props: {
			screen: { fields },
			authMethodMode,
			fieldValues: { email: 'person@example.edu' },
			methodAvailability: { mail_otp: true },
			emailVerificationProtocolEnabled
		}
	}).body;
}

describe('RuntimeScreen signup email fields', () => {
	it('uses the standalone signup email field without rendering the Mail OTP email input twice', () => {
		const body = renderScreen([emailField, mailOtpWidget], 'signup');

		expect(body.match(/type="email"/g)).toHaveLength(1);
		expect(body).toContain('name@example.edu');
		expect(body).toContain('Send code by email');
		expect(body).not.toContain('you@example.com');
	});

	it('keeps the Mail OTP email input when the signup screen has no standalone email field', () => {
		const body = renderScreen([mailOtpWidget], 'signup');

		expect(body.match(/type="email"/g)).toHaveLength(1);
		expect(body).toContain('you@example.com');
	});

	it('keeps the Mail OTP email input when the standalone email field is hidden', () => {
		const body = renderScreen(
			[{ ...emailField, display_condition: { mode: 'hidden' } }, mailOtpWidget],
			'signup'
		);

		expect(body.match(/type="email"/g)).toHaveLength(1);
		expect(body).toContain('you@example.com');
	});

	it('does not change login screens that intentionally contain both fields', () => {
		const body = renderScreen([emailField, mailOtpWidget], 'login');

		expect(body.match(/type="email"/g)).toHaveLength(2);
		expect(body).toContain('you@example.com');
	});

	it('uses a native email form submit when Email Verification Protocol is available', () => {
		const body = renderScreen([mailOtpWidget], 'login', true);

		expect(body).toContain('type="email"');
		expect(body).toContain('name="email"');
		expect(body).toContain('autocomplete="email"');
		expect(body).toMatch(/<button[^>]*type="submit"[^>]*>/);
	});

	it('marks a wide canvas layout for the page shell to consume', () => {
		setLocale('en');
		const body = render(RuntimeScreen, {
			props: {
				screen: { fields: [emailField], settings: { canvas_layout: 'wide' } },
				authMethodMode: 'signup'
			}
		}).body;

		expect(body).toMatch(/class="[^"]*runtime-screen[^"]*is-wide[^"]*"/);
	});
});

describe('RuntimeScreen consent status', () => {
	it('renders accepted documents checked and disabled while pending documents remain editable', () => {
		setLocale('en');
		const body = render(RuntimeScreen, {
			props: {
				screen: {
					fields: [
						{
							field: 'consent',
							label: 'Policies',
							required: true,
							block_type: 'consent_widget'
						}
					]
				},
				consentPolicy: {
					id: 'policy_1',
					display_name: 'Legal documents',
					description: null,
					language: 'en',
					default_language: 'en',
					items: [
						{
							statement_id: 'terms',
							slug: 'terms',
							category: 'terms',
							title: 'Terms of Service',
							description: '',
							document_url: null,
							inline_content: 'Terms of Service',
							version: '1',
							version_id: 'terms_v1',
							is_required: true,
							checkbox_mode: 'required',
							checkbox_default_checked: false,
							display_order: 0,
							acceptance_status: 'accepted',
							action_required: false,
							accepted_at: 1_700_000_000,
							accepted_record_id: 'record_1'
						},
						{
							statement_id: 'privacy',
							slug: 'privacy',
							category: 'privacy',
							title: 'Privacy Policy',
							description: '',
							document_url: null,
							inline_content: 'Privacy Policy',
							version: '1',
							version_id: 'privacy_v1',
							is_required: true,
							checkbox_mode: 'required',
							checkbox_default_checked: false,
							display_order: 1,
							acceptance_status: 'pending',
							action_required: true,
							accepted_at: null,
							accepted_record_id: null
						}
					]
				},
				consentDecisions: { terms: true, privacy: false }
			}
		}).body;

		expect(body).toContain('Terms of Service');
		expect(body).toContain('Privacy Policy');
		expect(body).toContain('Accepted');
		expect(body).toContain('aria-describedby="runtime-screen-consent-accepted-terms"');
		expect(body.match(/disabled/g)).toHaveLength(1);
		expect(body.match(/type="checkbox"/g)).toHaveLength(2);
	});

	it('renders only the server-provided SAML attribute presentation values', () => {
		setLocale('en');
		const body = render(RuntimeScreen, {
			props: {
				screen: {
					fields: [
						{ field: 'consent', label: 'Attributes', required: true, block_type: 'consent_widget' }
					]
				},
				consentPolicy: {
					id: 'saml-release',
					display_name: 'Attributes',
					description: null,
					language: 'en',
					default_language: 'en',
					items: [
						{
							statement_id: 'saml:attribute:mail',
							slug: 'mail',
							category: 'attribute_release',
							title: 'Email address',
							description: 'Shared with this service',
							document_url: null,
							inline_content: null,
							version: 'request-v1',
							version_id: 'saml:attribute:mail',
							is_required: true,
							checkbox_mode: 'required',
							checkbox_default_checked: true,
							display_order: 1,
							attribute_value_display: 'masked_values',
							attribute_display_values: ['u***@example.test'],
							release_kind: 'attribute',
							release_name: 'mail',
							release_locked: true
						}
					]
				},
				consentDecisions: { 'saml:attribute:mail': true }
			}
		}).body;

		expect(body).toContain('u***@example.test');
		expect(body).toContain('aria-label="Email address values"');
	});
});
