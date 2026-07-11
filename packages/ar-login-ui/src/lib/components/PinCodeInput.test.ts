import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import PinCodeInput from './PinCodeInput.svelte';

describe('PinCodeInput', () => {
	it('uses one native numeric input with responsive visual cells', () => {
		const body = render(PinCodeInput, {
			props: {
				value: '123',
				length: 6,
				label: 'Verification Code'
			}
		}).body;

		expect(body.match(/<input/g)).toHaveLength(1);
		expect(body.match(/auth-pin-cell pin-code-input__cell/g)).toHaveLength(6);
		expect(body).toContain('aria-label="Verification Code"');
		expect(body).toContain('inputmode="numeric"');
		expect(body).toContain('autocomplete="one-time-code"');
		expect(body).toContain('enterkeyhint="done"');
		expect(body).toContain('maxlength="6"');
	});
});
