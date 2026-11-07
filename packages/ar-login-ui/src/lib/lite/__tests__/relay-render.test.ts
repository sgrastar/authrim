import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import LiteRelay from '../LiteRelay.svelte';
import { LITE_RELAY_SUBMIT_SCRIPT } from '../relay';

describe('LiteRelay', () => {
	it('relays a GET with a meta refresh and a link, escaped', () => {
		const { head, body } = render(LiteRelay, {
			props: {
				target: { method: 'get', url: 'https://app.example/cb?code=a&state="x"' },
				continueLabel: 'Continue'
			}
		});
		expect(head).toContain('http-equiv="refresh"');
		expect(head).toContain('0;url=https://app.example/cb?code=a&amp;state=&quot;x&quot;');
		expect(body).toContain('href="https://app.example/cb?code=a&amp;state=&quot;x&quot;"');
		expect(body).not.toContain('<script');
	});

	it('relays a POST with hidden fields and exactly the hashed script', () => {
		const { body } = render(LiteRelay, {
			props: {
				target: {
					method: 'post',
					action: 'https://idp.example/sso',
					fields: [
						['SAMLRequest', 'PHNhbWw+"<'],
						['RelayState', 'abc']
					]
				},
				continueLabel: 'Continue'
			}
		});
		expect(body).toContain('action="https://idp.example/sso"');
		expect(body).toContain('name="SAMLRequest" value="PHNhbWw+&quot;&lt;"');
		expect(body).toContain(`<script>${LITE_RELAY_SUBMIT_SCRIPT}</script>`);
		expect(body).toContain('<button type="submit">Continue</button>');
	});

	it('draws nothing for a destination that is not an absolute http(s) URL', () => {
		const { head, body } = render(LiteRelay, {
			props: { target: { method: 'get', url: 'javascript:alert(1)' }, continueLabel: 'Continue' }
		});
		expect(head).not.toContain('refresh');
		expect(body).not.toContain('javascript:');
	});
});
