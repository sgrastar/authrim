const adminSigninConfirmation = {
	admin_signin_confirmation_nav: 'サインイン確認',
	admin_signin_confirmation_page_title: 'サインイン確認 - Authrim管理画面',
	admin_signin_confirmation_title: 'サインイン確認',
	admin_signin_confirmation_description:
		'ログイン時に、ユーザーへアプリケーションとテナントの文脈を確認させるかを制御します。長期間有効なログインセッションを複数アプリで使う場合や、どこへサインインするのかを明示的に確認させたい場合に使用します。',
	admin_signin_confirmation_load_error: 'サインイン確認ポリシーを読み込めませんでした。',
	admin_signin_confirmation_loading: 'サインイン確認ポリシーを読み込み中...',
	admin_signin_confirmation_mode: 'モード',
	admin_signin_confirmation_mode_disabled: '無効',
	admin_signin_confirmation_mode_first_time: '初回のみ',
	admin_signin_confirmation_mode_every_time: '毎回',
	admin_signin_confirmation_remember_days: '記憶日数',
	admin_signin_confirmation_remember_days_value: '{days}日',
	admin_signin_confirmation_show_application_context: 'アプリケーション情報を表示',
	admin_signin_confirmation_show_tenant_context: 'テナント情報を表示',
	admin_signin_confirmation_active: '有効',
	admin_signin_confirmation_save: 'サインイン確認を保存',
	admin_signin_confirmation_saved: 'サインイン確認ポリシーを保存しました。',
	admin_signin_confirmation_save_error: 'サインイン確認ポリシーを保存できませんでした。',
	admin_signin_confirmation_permission: 'サインイン確認ポリシーを変更する権限がありません。',
	admin_signin_confirmation_name: '名前',
	admin_signin_confirmation_context: '文脈',
	admin_signin_confirmation_context_summary: 'アプリ {app} / テナント {tenant}',
	admin_signin_confirmation_status: '状態',
	admin_signin_confirmation_none: 'サインイン確認ポリシーはありません。',
	admin_signin_confirmation_enabled: '有効',
	admin_signin_confirmation_disabled: '無効'
} as const;

export default adminSigninConfirmation;
