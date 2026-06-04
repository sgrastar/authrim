const adminDrBackup = {
	admin_dr_backup_page_title: 'DRバックアップ - Authrim',
	admin_dr_backup_title: 'DRバックアップ',
	admin_dr_backup_description: '災害復旧用バックアップartifactの保存先を設定します。',
	admin_dr_backup_error_load_settings: 'DRバックアップ設定を読み込めませんでした',
	admin_dr_backup_error_load_destinations: '保存先を読み込めませんでした',
	admin_dr_backup_error_update_destination: 'DRバックアップ保存先を更新できませんでした',
	admin_dr_backup_destination_updated: 'DRバックアップ保存先を更新しました。',
	admin_dr_backup_destination_title: 'バックアップ保存先',
	admin_dr_backup_loading_settings: '設定を読み込み中...',
	admin_dr_backup_storage_destination: '保存先',
	admin_dr_backup_not_configured: '未設定',
	admin_dr_backup_saml_bundle_title: 'SAML署名DR Bundle',
	admin_dr_backup_saml_bundle_desc:
		'このテナントのローカルSAML署名鍵、証明書、entity ID設定、署名rollover状態をexport/restoreします。',
	admin_dr_backup_sensitive: '機密',
	admin_dr_backup_saml_bundle_warning:
		'このbundleはpassphraseで暗号化されますが、復号後は秘密署名鍵を含みます。オフラインで保管し、同じテナント/ドメイン環境を再作成するときだけimportしてください。',
	admin_dr_backup_passphrase: 'Passphrase',
	admin_dr_backup_passphrase_placeholder: '12文字以上',
	admin_dr_backup_confirm_passphrase: 'Passphrase確認',
	admin_dr_backup_confirm_passphrase_placeholder: 'export時は必須',
	admin_dr_backup_exporting: 'Export中...',
	admin_dr_backup_export_bundle: 'DR BundleをExport',
	admin_dr_backup_importing: 'Import中...',
	admin_dr_backup_import_bundle: 'DR BundleをImport',
	admin_dr_backup_bundle_exported: 'SAML署名DR bundleをexportしました。',
	admin_dr_backup_bundle_imported: 'SAML署名DR bundleをimportしました。',
	admin_dr_backup_error_export_bundle: 'SAML署名DR bundleをexportできませんでした',
	admin_dr_backup_error_import_bundle: 'SAML署名DR bundleをimportできませんでした'
} as const;

export default adminDrBackup;
