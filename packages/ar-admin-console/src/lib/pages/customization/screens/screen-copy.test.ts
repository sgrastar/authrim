import { describe, expect, it } from 'vitest';
import { newPartLabel, partName } from './screen-copy';

describe('newPartLabel', () => {
	it('is the part’s name, except for the sign-in / sign-up link', () => {
		expect(newPartLabel('heading', 'login')).toBe(partName('heading'));
	});

	it('gives the link the standard wording for the direction it goes', () => {
		expect(newPartLabel('auth_switch_link', 'login')).toBe("Don't have an account? Create one");
		expect(newPartLabel('auth_switch_link', 'custom')).toBe("Don't have an account? Create one");
		expect(newPartLabel('auth_switch_link', 'registration')).toBe(
			'Already have an account? Sign in'
		);
	});
});
