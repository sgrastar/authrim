import { describe, expect, it } from 'vitest';
import {
	ACCOUNT_AUDIT_ACTIONS,
	formatAccountAuditAction,
	formatGuestAwareAuditAction,
	getGuestAuditDetails
} from '../account-audit-action-label';

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

	it('distinguishes guest login, logout, update, and deletion from registered-user events', () => {
		expect(formatGuestAwareAuditAction('user.login', { method: 'guest' }, 'ja')).toBe(
			'ゲストアカウントログイン'
		);
		expect(formatGuestAwareAuditAction('user.logout', { is_guest_session: true }, 'en')).toBe(
			'Guest account logout'
		);
		expect(formatGuestAwareAuditAction('user.updated', { registration_state: 'guest' }, 'ja')).toBe(
			'ゲストアカウント更新'
		);
		expect(formatGuestAwareAuditAction('user.deleted', { registration_state: 'guest' }, 'en')).toBe(
			'Guest account deleted'
		);
		expect(formatGuestAwareAuditAction('user.login', { method: 'passkey' }, 'ja')).toBeUndefined();
		expect(formatGuestAwareAuditAction('user.deleted', { reason: 'guest_retention' }, 'ja')).toBe(
			'ゲストアカウント削除'
		);
		expect(formatGuestAwareAuditAction('guest.resume_credentials.deactivated', null, 'en')).toBe(
			'Guest resume credentials deactivated'
		);
	});

	it('presents stable guest audit metadata as readable details', () => {
		expect(
			getGuestAuditDetails(
				'account.guest.upgraded',
				{
					method: 'email',
					registration_state: 'guest',
					client_id: 'login-ui',
					is_new_user: false,
					unknown_private_value: 'hidden'
				},
				'ja'
			)
		).toEqual([
			{ label: '認証方法', value: 'Email OTP' },
			{ label: '登録状態', value: 'ゲスト' },
			{ label: 'クライアントID', value: 'login-ui' },
			{ label: '新規作成', value: 'いいえ' }
		]);
		expect(getGuestAuditDetails('user.login', { method: 'passkey' }, 'ja')).toEqual([]);
	});
});
