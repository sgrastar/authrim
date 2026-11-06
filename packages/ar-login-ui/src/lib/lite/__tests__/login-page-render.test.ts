import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import LoginPage from '../../../routes/__lite/login/+page.svelte';
import { LITE_POW_SOLVER_SCRIPT } from '../pow-solver';

const text = {
	title: 'Sign in',
	continue: 'Continue',
	sendCode: 'Send code',
	email: 'Email address',
	guest: 'Continue as a guest',
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
		resend_wait: 'Wait'
	}
};

function page(
	fields: unknown[],
	pow: unknown = null,
	extra: { codeEntry?: unknown; form?: unknown } = {}
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

	it('draws the code entry: the code form without a proof, the resend form with one', () => {
		const { body } = page(
			[field({ blockType: 'code_input_widget', field: 'code', label: 'Code' })],
			POW,
			{ codeEntry: { maskedEmail: 'p***n@example.com', resendWait: 42 } }
		);
		const forms = body.match(/<form[^>]*>/gu) ?? [];
		expect(forms).toHaveLength(3);
		expect(forms[0]).toContain('action="?challenge_id=ch-1&amp;/verify_code"');
		expect(forms[0]).not.toContain('data-lite-pow');
		expect(forms[1]).toContain('action="?challenge_id=ch-1&amp;/resend"');
		expect(forms[1]).toContain('data-lite-pow=');
		expect(forms[2]).toContain('action="?challenge_id=ch-1&amp;/restart"');
		expect(body).toMatch(/<input[^>]*name="code"[^>]*autocomplete="one-time-code"/u);
		expect(body).toContain('pattern="[0-9]{6}"');
		expect(body).toContain('p***n@example.com');
		expect(body).toContain('Resend in 42s');
		expect(body.match(/name="op"/gu)).toHaveLength(2);
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
					decision: { kind: 'unsupported', reasons: ['block:checkbox'] },
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
