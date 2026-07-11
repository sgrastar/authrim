import { describe, expect, it } from 'vitest';
import { isEmailIdentityField, shouldShowAuthWidgetEmailInput } from '../screen-auth-widget-layout';

describe('screen auth widget layout', () => {
	it('recognizes direct and canonical email identity fields', () => {
		expect(isEmailIdentityField({ field: 'email', block_type: 'identity_field' })).toBe(true);
		expect(
			isEmailIdentityField({ field: 'field.canonical.email', block_type: 'identity_field' })
		).toBe(true);
		expect(isEmailIdentityField({ field: 'auth.mail_otp', block_type: 'auth_widget' })).toBe(false);
	});

	it('hides the widget email input only for registration screens with a standalone email field', () => {
		const fields = [
			{ field: 'email', block_type: 'identity_field' },
			{ field: 'auth.mail_otp', block_type: 'auth_widget' }
		];

		expect(shouldShowAuthWidgetEmailInput('registration', fields)).toBe(false);
		expect(shouldShowAuthWidgetEmailInput('login', fields)).toBe(true);
		expect(
			shouldShowAuthWidgetEmailInput('registration', [
				{ field: 'auth.mail_otp', block_type: 'auth_widget' }
			])
		).toBe(true);
	});
});
