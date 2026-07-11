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
