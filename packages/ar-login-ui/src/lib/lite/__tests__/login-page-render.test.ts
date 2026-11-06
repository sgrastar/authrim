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
	back: 'Back'
};

function page(fields: unknown[], pow: unknown = null) {
	return render(LoginPage, {
		props: {
			data: {
				brandName: 'Acme',
				logo: null,
				page: 'step',
				search: '?challenge_id=ch-1',
				txnId: 'txn-1',
				csrfToken: 'csrf-1',
				decision: { kind: 'screen', title: 'Sign in', description: null, fields },
				pow,
				text
			} as never,
			form: null
		}
	});
}

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
});
