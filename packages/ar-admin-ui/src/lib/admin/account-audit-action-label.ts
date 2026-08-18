const ACCOUNT_AUDIT_ACTION_LABELS = {
	'account.profile.name_updated': {
		en: 'Account Page: Name changed',
		ja: 'アカウントページ: 名前変更'
	},
	'account.email.added': {
		en: 'Account Page: Email added',
		ja: 'アカウントページ: メールアドレス追加'
	},
	'account.email.changed': {
		en: 'Account Page: Email changed',
		ja: 'アカウントページ: メールアドレス変更'
	},
	'account.email.reauthenticated': {
		en: 'Account Page: Re-authenticated by email',
		ja: 'アカウントページ: メールで再認証'
	},
	'account.device.updated': {
		en: 'Account Page: Device renamed',
		ja: 'アカウントページ: 端末名変更'
	},
	'account.device.unlinked': {
		en: 'Account Page: Device unlinked',
		ja: 'アカウントページ: 端末解除'
	},
	'account.session.revoked': {
		en: 'Account Page: Session logged out',
		ja: 'アカウントページ: セッションログアウト'
	},
	'account.passkey.created': {
		en: 'Account Page: Passkey added',
		ja: 'アカウントページ: Passkey追加'
	},
	'account.passkey.updated': {
		en: 'Account Page: Passkey renamed',
		ja: 'アカウントページ: Passkey名変更'
	},
	'account.passkey.deleted': {
		en: 'Account Page: Passkey deleted',
		ja: 'アカウントページ: Passkey削除'
	},
	'account.passkey.reauthenticated': {
		en: 'Account Page: Re-authenticated by Passkey',
		ja: 'アカウントページ: Passkeyで再認証'
	},
	'account.totp.enrollment_started': {
		en: 'Account Page: Authenticator setup started',
		ja: 'アカウントページ: 認証アプリ設定開始'
	},
	'account.totp.activated': {
		en: 'Account Page: Authenticator activated',
		ja: 'アカウントページ: 認証アプリ有効化'
	},
	'account.totp.updated': {
		en: 'Account Page: Authenticator renamed',
		ja: 'アカウントページ: 認証アプリ名変更'
	},
	'account.totp.removed': {
		en: 'Account Page: Authenticator removed',
		ja: 'アカウントページ: 認証アプリ削除'
	},
	'account.totp.backup_codes_regenerated': {
		en: 'Account Page: Backup codes regenerated',
		ja: 'アカウントページ: バックアップコード再生成'
	},
	'account.totp.reauthenticated': {
		en: 'Account Page: Re-authenticated by authenticator',
		ja: 'アカウントページ: 認証アプリで再認証'
	}
} as const;

export type AccountAuditAction = keyof typeof ACCOUNT_AUDIT_ACTION_LABELS;
export const ACCOUNT_AUDIT_ACTIONS = Object.freeze(
	Object.keys(ACCOUNT_AUDIT_ACTION_LABELS) as AccountAuditAction[]
);

export function formatAccountAuditAction(action: string, locale: string): string | undefined {
	const labels = ACCOUNT_AUDIT_ACTION_LABELS[action as AccountAuditAction];
	if (!labels) return undefined;
	return locale === 'ja' ? labels.ja : labels.en;
}
