import type { ScreenField } from '$lib/api/admin-screens';

type Translate = (japanese: string, english: string) => string;

export function createDefaultRegistrationScreenFields(translate: Translate): ScreenField[] {
	return [
		{
			field: 'heading.registration',
			label: translate('アカウントを作成', 'Create your account'),
			required: false,
			block_type: 'heading',
			order: 0
		},
		{
			field: 'auth.passkey',
			label: translate('Passkeyでアカウント作成', 'Create Account with Passkey'),
			required: false,
			block_type: 'auth_widget',
			auth_method: 'passkey',
			order: 10
		},
		{
			field: 'divider.or',
			label: translate('または', 'or'),
			required: false,
			block_type: 'divider',
			text: translate('または', 'or'),
			display_condition: { mode: 'feature_enabled', feature: 'mail_otp' },
			order: 20
		},
		{
			field: 'auth.mail_otp',
			label: translate('認証コードをメール送信', 'Send code by email'),
			required: false,
			block_type: 'auth_widget',
			auth_method: 'mail_otp',
			order: 30
		},
		{
			field: 'auth.totp',
			label: translate('認証アプリで新規登録', 'Create account with authenticator app'),
			required: false,
			block_type: 'auth_widget',
			auth_method: 'totp',
			order: 35
		},
		{
			field: 'divider.other_accounts',
			label: translate('他のアカウントで続行', 'Continue with another account'),
			required: false,
			block_type: 'divider',
			text: translate('他のアカウントで続行', 'Continue with another account'),
			display_condition: { mode: 'feature_enabled', feature: 'external_idp' },
			order: 40
		},
		{
			field: 'auth.external_idp',
			label: 'Ext. IdP',
			required: false,
			block_type: 'auth_widget',
			auth_method: 'external_idp',
			external_idp_show_action_text: false,
			order: 50
		},
		{
			field: 'divider.directory_password',
			label: translate('または', 'or'),
			required: false,
			block_type: 'divider',
			text: translate('または', 'or'),
			display_condition: { mode: 'feature_enabled', feature: 'directory_password' },
			order: 55
		},
		{
			field: 'auth.directory_password',
			label: translate('ディレクトリパスワードでサインイン', 'Sign in with directory password'),
			required: false,
			block_type: 'auth_widget',
			auth_method: 'directory_password',
			order: 60
		}
	];
}
