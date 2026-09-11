const ACCOUNT_AUDIT_ACTION_LABELS = {
	'account.guest.created': {
		en: 'Guest account created',
		ja: 'ゲストアカウント作成'
	},
	'account.guest.deletion_started': {
		en: 'Guest account deletion started',
		ja: 'ゲストアカウント削除開始'
	},
	'account.guest.upgrade_failed': {
		en: 'Guest registration failed',
		ja: 'ゲストアカウント登録失敗'
	},
	'account.guest.upgrade_started': {
		en: 'Guest registration started',
		ja: 'ゲストアカウント登録開始'
	},
	'account.guest.upgraded': { en: 'Guest account registered', ja: 'ゲストアカウント登録完了' },
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

function isGuestAuditEvent(action: string, metadata: Record<string, unknown> | null): boolean {
	if (action.startsWith('account.guest.')) return true;
	if (action.startsWith('guest.')) return true;
	if (!metadata) return false;
	return (
		metadata.method === 'guest' ||
		metadata.registration_state === 'guest' ||
		metadata.is_guest_session === true ||
		(typeof metadata.source === 'string' && metadata.source.startsWith('guest_')) ||
		(typeof metadata.reason === 'string' && metadata.reason.startsWith('guest_'))
	);
}

export function formatGuestAwareAuditAction(
	action: string,
	metadata: Record<string, unknown> | null,
	locale: string
): string | undefined {
	const accountAction = formatAccountAuditAction(action, locale);
	if (accountAction) return accountAction;
	if (!isGuestAuditEvent(action, metadata)) return undefined;

	const japanese = locale === 'ja';
	switch (action) {
		case 'user.login':
			return japanese ? 'ゲストアカウントログイン' : 'Guest account login';
		case 'user.logout':
			return japanese ? 'ゲストアカウントログアウト' : 'Guest account logout';
		case 'user.updated':
			return japanese ? 'ゲストアカウント更新' : 'Guest account updated';
		case 'user.deleted':
			return japanese ? 'ゲストアカウント削除' : 'Guest account deleted';
		case 'guest.resume_credentials.deactivated':
			return japanese ? 'ゲスト再開資格情報の無効化' : 'Guest resume credentials deactivated';
		default:
			return undefined;
	}
}

export interface GuestAuditDetail {
	label: string;
	value: string;
}

export function getGuestAuditDetails(
	action: string,
	metadata: Record<string, unknown> | null,
	locale: string
): GuestAuditDetail[] {
	if (!isGuestAuditEvent(action, metadata) || !metadata) return [];
	const japanese = locale === 'ja';
	const details: GuestAuditDetail[] = [];
	const add = (label: string, value: unknown) => {
		if (typeof value === 'string' && value.length > 0) details.push({ label, value });
	};

	if (typeof metadata.method === 'string') {
		const method =
			metadata.method === 'email'
				? 'Email OTP'
				: metadata.method === 'passkey'
					? 'Passkey'
					: metadata.method === 'guest'
						? japanese
							? 'ゲスト'
							: 'Guest'
						: metadata.method;
		details.push({ label: japanese ? '認証方法' : 'Authentication method', value: method });
	}
	if (typeof metadata.registration_state === 'string') {
		const state =
			metadata.registration_state === 'guest'
				? japanese
					? 'ゲスト'
					: 'Guest'
				: metadata.registration_state;
		details.push({ label: japanese ? '登録状態' : 'Registration state', value: state });
	}
	add(japanese ? 'クライアントID' : 'Client ID', metadata.client_id);
	if (typeof metadata.is_new_user === 'boolean') {
		details.push({
			label: japanese ? '新規作成' : 'New account',
			value: metadata.is_new_user ? (japanese ? 'はい' : 'Yes') : japanese ? 'いいえ' : 'No'
		});
	}
	add(japanese ? '処理段階' : 'Stage', metadata.stage);
	add(japanese ? '理由' : 'Reason', metadata.reason);
	add(japanese ? '実行元' : 'Source', metadata.source);
	add(japanese ? '操作ID' : 'Operation ID', metadata.operationId);
	add(japanese ? '失敗コード' : 'Failure code', metadata.failure_code);
	return details;
}
