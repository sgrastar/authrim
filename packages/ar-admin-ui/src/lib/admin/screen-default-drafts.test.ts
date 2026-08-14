import { describe, expect, it } from 'vitest';
import { createDefaultRegistrationScreenFields } from './screen-default-drafts';

describe('default registration screen draft', () => {
	it('starts without a standalone optional email field', () => {
		const fields = createDefaultRegistrationScreenFields((_japanese, english) => english);

		expect(fields.map((field) => field.field)).toEqual([
			'heading.registration',
			'auth.passkey',
			'divider.or',
			'auth.mail_otp',
			'auth.totp',
			'divider.other_accounts',
			'auth.external_idp',
			'divider.directory_password',
			'auth.directory_password'
		]);
		expect(fields.some((field) => field.block_type === 'identity_field')).toBe(false);
		expect(fields.find((field) => field.auth_method === 'mail_otp')).toBeDefined();
	});
});
