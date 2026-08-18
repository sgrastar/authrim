import { describe, expect, it } from 'vitest';
import { ACCOUNT_AUDIT_ACTIONS, formatAccountAuditAction } from '../account-audit-action-label';

describe('account audit action labels', () => {
	it('formats every Account Page audit action for Japanese and English views', () => {
		expect(formatAccountAuditAction('account.email.changed', 'ja')).toBe(
			'アカウントページ: メールアドレス変更'
		);
		expect(formatAccountAuditAction('account.device.unlinked', 'en')).toBe(
			'Account Page: Device unlinked'
		);
		expect(formatAccountAuditAction('account.totp.backup_codes_regenerated', 'fr')).toBe(
			'Account Page: Backup codes regenerated'
		);
	});

	it('lets the caller handle non-account actions', () => {
		expect(formatAccountAuditAction('user.login', 'ja')).toBeUndefined();
	});

	it('provides a visible label for every filterable Account Page action', () => {
		expect(ACCOUNT_AUDIT_ACTIONS).toContain('account.email.changed');
		expect(ACCOUNT_AUDIT_ACTIONS).toContain('account.device.unlinked');
		for (const action of ACCOUNT_AUDIT_ACTIONS) {
			expect(formatAccountAuditAction(action, 'ja')).toBeTruthy();
			expect(formatAccountAuditAction(action, 'en')).toBeTruthy();
		}
	});
});
