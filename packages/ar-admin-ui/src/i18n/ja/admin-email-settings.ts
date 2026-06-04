const adminEmailSettings = {
	admin_email_settings_head_title: 'Email Settings - Authrim Admin',
	admin_email_settings_title: 'Email Settings',
	admin_email_settings_description:
		'有効かつ設定済みのemail providerについて、tenant全体の配信順序を選択します。',
	admin_email_settings_save_order: '順序を保存',
	admin_email_settings_saving: '保存中...',
	admin_email_settings_load_failed: 'Email settingsの読み込みに失敗しました',
	admin_email_settings_save_failed: 'Email settingsの保存に失敗しました',
	admin_email_settings_select_tenant: 'Email settingsを管理するtenantを選択してください',
	admin_email_settings_saved: 'Email providerの順序を保存しました',
	admin_email_settings_loading: 'Email settingsを読み込み中...',
	admin_email_settings_delivery_mode: '配信モード',
	admin_email_settings_strategy_priority_failover: 'Priority + Failover',
	admin_email_settings_tenant: 'Tenant',
	admin_email_settings_not_selected: '未選択',
	admin_email_settings_provider_priority: 'Provider Priority',
	admin_email_settings_provider_priority_description:
		'配信が成功するまで、設定済みproviderをこの順序で試行します。',
	admin_email_settings_open_plugins: 'Pluginsページを開く',
	admin_email_settings_empty: 'このtenantで利用可能な設定済みemail providerはありません。',
	admin_email_settings_empty_hint:
		'無効なproviderや必須設定が不足しているpluginはここに表示されません。まずPluginsページでCloudflare Email ServiceまたはResendを有効化して設定してください。',
	admin_email_settings_provider_settings: 'Provider設定',
	admin_email_settings_configured_via: '{source}で設定',
	admin_email_settings_from: 'From: {address}',
	admin_email_settings_move_up: '上へ',
	admin_email_settings_move_down: '下へ'
} as const;

export default adminEmailSettings;
