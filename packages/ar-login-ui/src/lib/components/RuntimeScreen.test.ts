import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { locales, loadedLocales } from '$i18n/i18n-util';
import { loadAllLocales } from '$i18n/i18n-util.sync';
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

const totpWidget = {
	field: 'auth.totp',
	label: 'Sign in with authenticator app',
	required: false,
	block_type: 'auth_widget',
	auth_method: 'totp',
	order: 30
};

const combinedEmailWidget = {
	field: 'auth.mail_otp_totp',
	label: 'Mail OTP + authenticator app',
	required: false,
	block_type: 'auth_widget',
	auth_method: 'mail_otp_totp',
	order: 20
};

function renderScreen(
	fields: Array<Record<string, unknown>>,
	authMethodMode: 'login' | 'signup',
	emailVerificationProtocolEnabled = false,
	methodAvailability: Record<string, boolean> = { mail_otp: true }
) {
	setLocale('en');
	return render(RuntimeScreen, {
		props: {
			screen: { fields },
			authMethodMode,
			fieldValues: { email: 'person@example.edu' },
			methodAvailability,
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

	it('uses an explicit login email field instead of rendering the Mail OTP email input twice', () => {
		const body = renderScreen([emailField, mailOtpWidget], 'login');

		expect(body.match(/type="email"/g)).toHaveLength(1);
		expect(body).not.toContain('you@example.com');
	});

	it('shares one email input between separate Mail OTP and authenticator app widgets', () => {
		const body = renderScreen([mailOtpWidget, totpWidget], 'login', false, {
			mail_otp: true,
			totp: true
		});

		expect(body.match(/<input/g)).toHaveLength(1);
		expect(body).toContain('Send code by email');
		expect(body).toContain('Sign in with authenticator app');
		expect(body).not.toContain('autocomplete="username"');
	});

	it('keeps the combined widget usable when only Mail OTP is enabled', () => {
		const body = renderScreen([combinedEmailWidget], 'login', false, {
			mail_otp_totp: true,
			mail_otp: true,
			totp: false
		});

		expect(body.match(/<input/g)).toHaveLength(1);
		expect(body).toContain('Send code by email');
		expect(body).not.toContain('Sign in with authenticator app');
	});

	it('keeps the combined widget usable when only the authenticator app is enabled', () => {
		const body = renderScreen([combinedEmailWidget], 'login', false, {
			mail_otp_totp: true,
			mail_otp: false,
			totp: true
		});

		expect(body.match(/<input/g)).toHaveLength(1);
		expect(body).not.toContain('Send code by email');
		expect(body).toContain('Sign in with authenticator app');
	});

	it('renders one email input for an authenticator-only signup screen', () => {
		const body = renderScreen([totpWidget], 'signup', false, { totp: true });

		expect(body.match(/type="email"/g)).toHaveLength(1);
		expect(body).toContain('Sign up with authenticator app');
	});

	it('uses a native email form submit when Email Verification Protocol is available', () => {
		const body = renderScreen([mailOtpWidget], 'login', true);

		expect(body).toContain('type="email"');
		expect(body).toContain('name="email"');
		expect(body).toContain('autocomplete="email"');
		expect(body).toMatch(/<button[^>]*type="submit"[^>]*>/);
	});

	it('shows a busy spinner while an email code request is in progress', () => {
		setLocale('en');
		const body = render(RuntimeScreen, {
			props: {
				screen: { fields: [mailOtpWidget] },
				authMethodMode: 'login',
				fieldValues: { email: 'person@example.edu' },
				methodAvailability: { mail_otp: true },
				methodLoading: { mail_otp: true }
			}
		}).body;

		expect(body).toContain('aria-busy="true"');
		expect(body).toContain('runtime-auth-spinner');
		expect(body).not.toContain('i-ph-envelope-simple');
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

	it('renders every screen block using the currently selected locale', () => {
		setLocale('es');
		const body = render(RuntimeScreen, {
			props: {
				screen: {
					fields: [
						{
							field: 'heading.login',
							label: '로그인',
							block_type: 'heading'
						},
						{
							field: 'auth.passkey',
							label: 'Passkey로 로그인',
							block_type: 'auth_widget',
							auth_method: 'passkey'
						},
						{
							field: 'auth.totp',
							label: '인증 앱으로 로그인',
							block_type: 'auth_widget',
							auth_method: 'totp'
						}
					],
					localizations: {
						en: {
							fields: {
								'heading.login-0': { label: 'Sign in' },
								'auth.passkey-1': { label: 'Sign in with Passkey' },
								'auth.totp-2': { label: 'Sign in with authenticator app' }
							}
						},
						es: {
							fields: {
								'heading.login-0': { label: 'Iniciar sesión' },
								'auth.passkey-1': { label: 'Iniciar sesión con Passkey' },
								'auth.totp-2': { label: 'Iniciar sesión con la aplicación de autenticación' }
							}
						}
					}
				},
				authMethodMode: 'login',
				methodAvailability: { passkey: true, totp: true }
			}
		}).body;

		expect(body).toContain('Iniciar sesión');
		expect(body).toContain('Iniciar sesión con Passkey');
		expect(body).toContain('Iniciar sesión con la aplicación de autenticación');
		expect(body).not.toContain('로그인');
	});

	it('overrides only the primary screen heading with the theme page title', () => {
		setLocale('en');
		const body = render(RuntimeScreen, {
			props: {
				screen: {
					fields: [
						{ field: 'heading.primary', label: 'Screen heading', block_type: 'heading' },
						{ field: 'heading.secondary', label: 'Secondary heading', block_type: 'heading' }
					]
				},
				headingOverride: 'Theme page title'
			}
		}).body;

		expect(body).toContain('Theme page title');
		expect(body).not.toContain('Screen heading');
		expect(body).toContain('Secondary heading');
	});

	it('locks required Destination Profile fields and lets optional fields be deselected', () => {
		setLocale('en');
		const body = render(RuntimeScreen, {
			props: {
				screen: {
					fields: [
						{
							field: 'consent.release',
							label: 'Shared profile data',
							block_type: 'consent_widget'
						}
					]
				},
				destinationFieldConsent: {
					profile_id: 'destination_oidc_1',
					profile_version_id: 'version_1',
					destination_type: 'oidc',
					fields: [
						{
							key: 'sub',
							label: 'Subject',
							required: true,
							nullable: false,
							classification: 'internal',
							surfaces: ['id_token'],
							required_scopes: ['openid']
						},
						{
							key: 'name',
							label: 'Name',
							required: false,
							nullable: true,
							classification: 'pii',
							surfaces: ['userinfo'],
							required_scopes: ['profile']
						}
					]
				},
				destinationFieldDecisions: { sub: true, name: true }
			}
		}).body;

		expect(body).toContain('Subject');
		expect(body).toContain('Name');
		expect(body).toMatch(/<input[^>]*checked[^>]*required[^>]*disabled[^>]*>/);
		expect(body).toMatch(/<input[^>]*checked[^>]*\/>\s*<span[^>]*>\s*<strong[^>]*>Name<\/strong>/);
	});

	it('renders Destination Profile choices when a legacy custom screen lacks a consent widget', () => {
		setLocale('en');
		const body = render(RuntimeScreen, {
			props: {
				screen: {
					fields: [{ field: 'heading.review', label: 'Review', block_type: 'heading' }]
				},
				destinationFieldConsent: {
					profile_id: 'destination_oidc_1',
					profile_version_id: 'version_1',
					destination_type: 'oidc',
					fields: [
						{
							key: 'sub',
							label: 'Subject',
							required: true,
							nullable: false,
							classification: 'internal',
							surfaces: ['id_token', 'userinfo'],
							required_scopes: []
						},
						{
							key: 'name',
							label: 'Name',
							required: false,
							nullable: true,
							classification: 'pii',
							surfaces: ['userinfo'],
							required_scopes: ['profile']
						}
					]
				},
				destinationFieldDecisions: { sub: true, name: false }
			}
		}).body;

		expect(body).toContain('Review');
		expect(body).toContain('Subject');
		expect(body).toContain('Name');
		expect(body.match(/runtime-destination-fields/g)).toHaveLength(1);
	});
});

describe('guest login widget', () => {
	const screen = {
		fields: [
			{
				field: 'guest',
				label: 'Guest',
				required: false,
				block_type: 'guest_login_widget',
				order: 1
			}
		]
	};
	it('shows the login action and retention explanation only when enabled', () => {
		setLocale('en');
		const enabled = render(RuntimeScreen, {
			props: { screen, guestEnabled: true, guestRetentionDescription: 'Retained for 30 days' }
		}).body;
		expect(enabled).toContain('Guest');
		expect(enabled).toContain('Retained for 30 days');
		const disabled = render(RuntimeScreen, { props: { screen, guestEnabled: false } }).body;
		expect(disabled).not.toContain('Guest');
	});
	it('uses the translated default when the configured label is empty', () => {
		setLocale('en');
		const body = render(RuntimeScreen, {
			props: { screen: { fields: [{ ...screen.fields[0], label: '' }] }, guestEnabled: true }
		}).body;
		expect(body).toContain('Continue as a guest');
	});
	it.each(locales)(
		'localizes persisted Japanese defaults in %s, including stale screen translations',
		(locale) => {
			loadAllLocales();
			setLocale(locale);
			const body = render(RuntimeScreen, {
				props: {
					screen: {
						fields: [{ ...screen.fields[0], label: 'ゲストとして続ける' }],
						localizations: { [locale]: { fields: { guest: { label: 'ゲストとして続ける' } } } }
					},
					guestEnabled: true
				}
			}).body;
			expect(body).toContain(loadedLocales[locale].login_guestContinue);
			if (locale !== 'ja') expect(body).not.toContain('ゲストとして続ける');
		}
	);
	it('preserves a custom guest label', () => {
		setLocale('ar');
		expect(
			render(RuntimeScreen, {
				props: {
					screen: { fields: [{ ...screen.fields[0], label: 'Try our demo' }] },
					guestEnabled: true
				}
			}).body
		).toContain('Try our demo');
	});
	it('does not offer guest creation on a signup screen', () => {
		setLocale('en');
		const body = render(RuntimeScreen, {
			props: { screen, guestEnabled: true, authMethodMode: 'signup' }
		}).body;
		expect(body).not.toContain('Guest');
	});
	it('respects the global pending-action lock', () => {
		setLocale('en');
		const body = render(RuntimeScreen, {
			props: { screen, guestEnabled: true, disabled: true }
		}).body;
		expect(body).toContain('disabled');
		expect(body).toContain('Guest');
	});
});

describe('RuntimeScreen answer parts', () => {
	function renderParts(
		fields: Array<Record<string, unknown>>,
		fieldValues: Record<string, string | boolean> = {}
	) {
		setLocale('en');
		return render(RuntimeScreen, { props: { screen: { fields }, fieldValues } }).body;
	}

	const options = [
		{ value: 'sales', label: 'Sales' },
		{ value: 'dev', label: 'Development' }
	];

	it('draws a select with an empty choice first and the chosen value selected', () => {
		const body = renderParts(
			[{ field: 'department', label: 'Department', block_type: 'select', options }],
			{ department: 'dev' }
		);
		expect(body).toContain('<select');
		expect(body).toContain('<option value=""></option>');
		expect(body).toMatch(/<option value="dev"[^>]*selected[^>]*>Development<\/option>/u);
	});

	it('draws a radio group with its label as the legend', () => {
		const body = renderParts(
			[{ field: 'plan', label: 'Plan', block_type: 'radio', required: true, options }],
			{ plan: 'sales' }
		);
		expect(body).toContain('<fieldset');
		expect(body).toMatch(/<legend[^>]*>\s*Plan/u);
		expect(body.match(/type="radio"/gu)).toHaveLength(2);
		expect(body).toMatch(/value="sales"[^>]*checked/u);
	});

	it('draws a checkbox with its label once', () => {
		const body = renderParts([
			{ field: 'newsletter', label: 'Send me news', block_type: 'checkbox', required: true }
		]);
		expect(body).toContain('type="checkbox"');
		expect(body.match(/Send me news/gu)).toHaveLength(1);
	});

	it('draws the legacy yes/no form as a checkbox, its label once', () => {
		const body = renderParts(
			[{ field: 'agree', label: 'I agree', value_type: 'boolean', placeholder: 'I agree' }],
			{ agree: true }
		);
		expect(body).toMatch(/type="checkbox"[^>]*checked/u);
		expect(body.match(/I agree/gu)).toHaveLength(1);
	});

	it('names a legacy checkbox by its label and its own words together', () => {
		const body = renderParts([
			{
				field: 'newsletter',
				block_id: 'newsletter-1',
				label: 'Newsletter',
				value_type: 'boolean',
				placeholder: 'Send me product news',
				show_label: false
			}
		]);
		expect(body).toContain(
			'aria-labelledby="runtime-field-newsletter-1-question runtime-field-newsletter-1-box"'
		);
		expect(body).toMatch(/id="runtime-field-newsletter-1-question"[^>]*class="[^"]*sr-only/u);
		expect(body).toContain('id="runtime-field-newsletter-1-box">Send me product news');
	});

	it('keeps a hidden label for screen readers', () => {
		const body = renderParts([
			{ field: 'department', label: 'Department', block_type: 'select', options, show_label: false }
		]);
		expect(body).toMatch(/<span class="[^"]*sr-only[^"]*"[^>]*>\s*Department/u);
	});

	it('lays a row out in three columns', () => {
		const body = renderParts([
			{ field: 'row', label: 'Row', block_type: 'layout_row', layout_columns: 3 },
			{ field: 'a', label: 'A', layout_column: 1 },
			{ field: 'b', label: 'B', layout_column: 2 },
			{ field: 'c', label: 'C', layout_column: 3 }
		]);
		expect(body).toContain('repeat(3, minmax(0, 1fr))');
		expect(body).toContain('grid-column: 3 / span 1;');
	});
});
