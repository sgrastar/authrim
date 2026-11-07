import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import LoginPage from '../../../routes/__lite/login/+page.svelte';
import { LITE_PASSKEY_SCRIPT } from '../passkey-ceremony';
import { LITE_POW_SOLVER_SCRIPT } from '../pow-solver';

const text = {
	title: 'Sign in',
	continue: 'Continue',
	sendCode: 'Send code',
	email: 'Email address',
	guest: 'Continue as a guest',
	totp: 'Use authenticator',
	totpCode: 'Authenticator code',
	totpVerify: 'Verify authenticator code',
	passkey: 'Use passkey',
	passkeyPrompt: 'Follow your device',
	passkeyUnsupported: 'No passkeys here',
	passkeyFailed: 'Passkey did not finish',
	javascriptRequired: 'Turn on JavaScript',
	unsupported: 'Unavailable',
	back: 'Back',
	codeSentTo: 'Sent to',
	code: 'Code',
	verify: 'Verify',
	resend: 'Resend code',
	resendWait: 'Resend in 42s',
	restart: 'Use another address',
	errors: {
		email_invalid: 'Not an address',
		code_invalid: 'Wrong code',
		busy: 'Too many',
		resend_wait: 'Wait',
		retry: 'Try again',
		totp_invalid: 'Wrong authenticator code',
		totp_failed: 'Authenticator did not start',
		passkey_failed: 'Passkey did not finish'
	}
};

function page(
	fields: unknown[],
	pow: unknown = null,
	extra: { codeEntry?: unknown; form?: unknown; passkey?: unknown; available?: unknown } = {}
) {
	return render(LoginPage, {
		props: {
			data: {
				brandName: 'Acme',
				logo: null,
				page: 'step',
				search: '?challenge_id=ch-1',
				txnId: 'txn-1',
				csrfToken: 'csrf-1',
				op: 'o'.repeat(22),
				decision: { kind: 'screen', title: 'Sign in', description: null, fields },
				codeEntry: extra.codeEntry ?? null,
				passkey: extra.passkey ?? null,
				available: extra.available ?? { mailOtp: true, totp: true, passkey: true },
				purpose: 'login',
				pow,
				text
			} as never,
			form: (extra.form ?? null) as never
		}
	});
}

const POW = {
	algorithm: 'SHA-256',
	challenge: 'a'.repeat(64),
	maxnumber: 1,
	salt: 's',
	signature: 'g'
};

const field = (overrides: Record<string, unknown>) => ({
	blockType: 'identity_field',
	field: 'email',
	label: '',
	required: true,
	authMethod: null,
	text: null,
	helpText: null,
	placeholder: null,
	href: null,
	showLabel: true,
	...overrides
});

describe('the lite sign-in page as drawn', () => {
	it('lets the guest button go without the required email field', () => {
		const { body } = page([
			field({}),
			field({ blockType: 'auth_widget', field: 'auth.mail_otp', authMethod: 'mail_otp' }),
			field({ blockType: 'guest_login_widget', field: 'auth.guest', required: false })
		]);
		expect(body).toMatch(/<input[^>]*name="email"[^>]*required/u);
		expect(body).toMatch(
			/<button[^>]*formnovalidate[^>]*formaction="\?challenge_id=ch-1&amp;\/guest"/u
		);
		expect(body).toMatch(/<button[^>]*formaction="\?challenge_id=ch-1&amp;\/send_code"/u);
		expect(body).toContain('Email address');
	});

	it('draws a checked link as a link, and an unchecked one as text', () => {
		const { body } = page([
			field({ blockType: 'link', field: 'l1', label: 'Help', href: '/help', required: false }),
			field({ blockType: 'link', field: 'l2', label: 'Plain', href: null, required: false })
		]);
		expect(body).toContain('<a href="/help">Help</a>');
		expect(body).toContain('Plain');
		expect(body).not.toContain('href="javascript');
	});

	it('embeds the challenge escaped in an attribute, and exactly the solver script', () => {
		const { body } = page(
			[field({ blockType: 'auth_widget', field: 'm', authMethod: 'mail_otp' })],
			{
				algorithm: 'SHA-256',
				challenge: 'a'.repeat(64),
				maxnumber: 1,
				salt: '"></form><script>x',
				signature: 's'
			}
		);
		expect(body).not.toContain('"></form><script>x');
		expect(body).toContain('data-lite-pow=');
		expect(body).toContain(`<script>${LITE_POW_SOLVER_SCRIPT}</script>`);
		expect(body.match(/<script/gu)).toHaveLength(1);
		expect(body).toContain('<noscript>');
	});

	it('draws a heading with both its label and its text', () => {
		const { body } = page([
			field({
				blockType: 'heading',
				field: 'h',
				label: 'Welcome',
				text: 'Sign in to go on',
				required: false
			})
		]);
		expect(body).toContain('<h2>Welcome</h2>');
		expect(body).toContain('<p>Sign in to go on</p>');
	});

	it('draws the code entry: one form, its check with no proof, its resend with one', () => {
		const { body } = page(
			[field({ blockType: 'code_input_widget', field: 'code', label: 'Code' })],
			POW,
			{
				codeEntry: {
					kind: 'mail_otp',
					maskedEmail: 'p***n@example.com',
					resendWait: 42
				}
			}
		);
		const forms = body.match(/<form[^>]*>/gu) ?? [];
		expect(forms).toHaveLength(2);
		expect(forms[0]).toContain('action="?challenge_id=ch-1&amp;/verify_code"');
		expect(forms[0]).toContain('data-lite-pow=');
		const buttons = body.match(/<button[^>]*>/gu) ?? [];
		// The check first (an Enter in the code), sent with no proof; the resend with one.
		expect(buttons[0]).toContain('data-lite-pow-none');
		expect(buttons[1]).toContain('formaction="?challenge_id=ch-1&amp;/resend"');
		expect(buttons[1]).toContain('formnovalidate');
		expect(buttons[1]).not.toContain('data-lite-pow-none');
		expect(forms[1]).toContain('action="?challenge_id=ch-1&amp;/restart"');
		expect(body).toMatch(/<input[^>]*name="code"[^>]*autocomplete="one-time-code"/u);
		expect(body).toContain('pattern="[0-9]{6}"');
		expect(body).toContain('p***n@example.com');
		expect(body).toContain('Resend in 42s');
		expect(body.match(/name="op"/gu)).toHaveLength(1);
	});

	it('says what was wrong with the last post', () => {
		const { body } = page([field({})], null, { form: { error: 'email_invalid' } });
		expect(body).toMatch(/role="alert"[^>]*>Not an address/u);
	});

	it('draws a yes/no field as a checkbox', () => {
		const { body } = page([
			field({ field: 'newsletter', label: 'News', valueType: 'boolean', required: false })
		]);
		expect(body).toMatch(/<input[^>]*type="checkbox"[^>]*name="newsletter"/u);
		expect(body).not.toMatch(/<input[^>]*name="newsletter"[^>]*type="text"/u);
	});

	it("keeps a legacy yes/no box's own words, and hides a label only from sight", () => {
		const { body } = page([
			field({
				field: 'terms',
				label: 'Terms',
				placeholder: 'I agree',
				valueType: 'boolean',
				showLabel: false
			}),
			field({ field: 'nickname', label: 'Nickname', required: false, showLabel: false })
		]);
		expect(body).toMatch(/<p class="sr-only">Terms<\/p>/u);
		expect(body).toMatch(/name="terms"[^>]*>\s*I agree/u);
		expect(body).toMatch(/<span class="sr-only">Nickname<\/span>/u);
	});

	it("draws a divider's words, never its internal name", () => {
		const { body } = page([
			{ ...field({ blockType: 'divider', label: 'Divider' }), text: 'or' },
			{ ...field({ blockType: 'divider', label: 'Divider' }), text: 'Divider' }
		]);
		expect(body).toMatch(/<p class="divider">or<\/p>/u);
		expect(body).toContain('<hr');
		expect(body).not.toContain('>Divider<');
	});

	it('draws an authenticator code entry: up to 8 digits, no resend, no proof', () => {
		const { body } = page(
			[field({ blockType: 'code_input_widget', field: 'code', label: 'Code' })],
			null,
			{ codeEntry: { kind: 'totp', maskedEmail: null, resendWait: 0 } }
		);
		const forms = body.match(/<form[^>]*>/gu) ?? [];
		expect(forms).toHaveLength(2);
		expect(forms[0]).toContain('/totp_verify"');
		expect(forms[1]).toContain('/restart"');
		expect(body).toContain('pattern="[0-9]{6}([0-9]{2})?"');
		expect(body).toContain('maxlength="8"');
		expect(body).toContain('Verify authenticator code');
		expect(body).not.toContain('/resend"');
	});

	it('draws a button for each sign-in method, the passkey one free of the required fields', () => {
		const { body } = page(
			[
				field({}),
				field({ blockType: 'auth_widget', field: 'p', authMethod: 'passkey' }),
				field({ blockType: 'auth_widget', field: 't', authMethod: 'totp' })
			],
			POW
		);
		expect(body).toMatch(/<button[^>]*formnovalidate[^>]*\/passkey_start"[^>]*>Use passkey/u);
		expect(body).toMatch(/<button[^>]*\/totp_start"[^>]*>Use authenticator/u);
	});

	it('draws only the halves of the email-code-or-authenticator part that are on', () => {
		const both = page(
			[field({}), field({ blockType: 'auth_widget', field: 'c', authMethod: 'mail_otp_totp' })],
			POW
		).body;
		expect(both).toContain('/send_code"');
		expect(both).toContain('/totp_start"');
		const codeOnly = page(
			[field({}), field({ blockType: 'auth_widget', field: 'c', authMethod: 'mail_otp_totp' })],
			POW,
			{ available: { mailOtp: true, totp: false } }
		).body;
		expect(codeOnly).not.toContain('/totp_start"');
	});

	it('draws the passkey ceremony: the options as data, the fixed script, no proof', () => {
		const options = {
			challenge: 'c'.repeat(43),
			rpId: 'id.example',
			timeout: 60000,
			userVerification: 'required',
			allowCredentials: []
		};
		const { body } = page([field({})], null, { passkey: { options } });
		const forms = body.match(/<form[^>]*>/gu) ?? [];
		expect(forms[0]).toContain('/passkey_finish"');
		expect(forms[0]).toContain('data-lite-passkey="');
		expect(forms[0]).not.toContain('data-lite-pow');
		expect(body).toContain('name="credential"');
		expect(body).toContain(`<script>${LITE_PASSKEY_SCRIPT}</script>`);
		expect(body).not.toContain(LITE_POW_SOLVER_SCRIPT);
		// The options are an attribute's value, escaped: never markup.
		expect(body).toContain('&quot;rpId&quot;:&quot;id.example&quot;');
	});

	it('draws a sign-up held for its account: its Continue (with a proof) and a way out', () => {
		const held = (form: unknown) =>
			render(LoginPage, {
				props: {
					data: {
						brandName: 'Acme',
						logo: null,
						page: 'step',
						search: '?challenge_id=ch-1',
						txnId: 'txn-1',
						csrfToken: 'csrf-1',
						op: 'o'.repeat(22),
						decision: { kind: 'screen', title: 'Sign in', description: null, fields: [] },
						codeEntry: null,
						passkey: null,
						provisioning: { id: 'hold-1' },
						available: { mailOtp: true, totp: true, passkey: true },
						purpose: 'signup',
						pow: POW,
						text: {
							...text,
							provisioningWait: 'Being set up',
							errors: {
								...text.errors,
								provisioning_wait: 'Still being set up',
								provisioning_failed: 'Could not be set up'
							}
						}
					} as never,
					form: form as never
				}
			}).body;
		const body = held(null);
		const forms = body.match(/<form[^>]*>/gu) ?? [];
		expect(forms[0]).toContain('/provisioning_continue"');
		expect(forms[0]).toContain('data-lite-pow="');
		expect(body).toContain('name="provisioning" value="hold-1"');
		expect(body).toContain('Being set up');
		expect(forms[1]).toContain('/restart"');
		expect(body).toContain(`<script>${LITE_POW_SOLVER_SCRIPT}</script>`);
		// Still being made: said so, the Continue kept; failed: only the way out.
		expect(held({ error: 'provisioning_wait' })).toContain('Still being set up');
		const failed = held({ error: 'provisioning_failed' });
		expect(failed).toContain('Could not be set up');
		expect(failed).not.toContain('/provisioning_continue"');
	});

	it('goes back from a step it cannot draw by giving the transaction up (a restart post)', () => {
		const { body } = render(LoginPage, {
			props: {
				data: {
					brandName: 'Acme',
					logo: null,
					page: 'step',
					search: '?challenge_id=ch-1',
					txnId: 'txn-1',
					csrfToken: 'csrf-1',
					op: 'o'.repeat(22),
					decision: { kind: 'unsupported', reasons: ['block:signature_pad'] },
					codeEntry: null,
					pow: null,
					text
				} as never,
				form: null
			}
		});
		expect(body).toContain('action="?challenge_id=ch-1&amp;/restart"');
		expect(body).toContain('name="txn" value="txn-1"');
		expect(body).not.toContain('href="/login');
	});

	it('offers a way out next to a Continue that failed, and none next to one that did not', () => {
		const draw = (form: unknown) =>
			render(LoginPage, {
				props: {
					data: {
						brandName: 'Acme',
						logo: null,
						page: 'step',
						search: '',
						txnId: 'txn-1',
						csrfToken: 'csrf-1',
						op: 'o'.repeat(22),
						decision: { kind: 'continue' },
						codeEntry: null,
						pow: null,
						text
					} as never,
					form: form as never
				}
			}).body;
		expect(draw({ error: 'busy' })).toContain('action="?/restart"');
		expect(draw(null)).not.toContain('/restart');
	});
});

describe('the backup codes of a new authenticator', () => {
	it('are drawn on whatever page comes next, an error page too', () => {
		const { body } = render(LoginPage, {
			props: {
				data: {
					page: 'error',
					title: 'Something went wrong',
					message: 'Try again later',
					back: 'Back',
					backHref: '/signup',
					brandName: 'Acme',
					logo: null
				} as never,
				form: { backupCodes: ['ABCD-EFGH-JKLM'], backupCodesTitle: 'Backup codes' } as never
			}
		});
		expect(body).toContain('Backup codes');
		expect(body).toContain('<code>ABCD-EFGH-JKLM</code>');
		expect(body).toContain('Try again later');
	});
});
