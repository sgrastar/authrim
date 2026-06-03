const adminDrBackup = {
	admin_dr_backup_page_title: 'DR Backup - Authrim',
	admin_dr_backup_title: 'DR Backup',
	admin_dr_backup_description: 'Configure disaster recovery backup artifact storage.',
	admin_dr_backup_error_load_settings: 'Failed to load DR backup settings',
	admin_dr_backup_error_load_destinations: 'Failed to load storage destinations',
	admin_dr_backup_error_update_destination: 'Failed to update DR backup storage destination',
	admin_dr_backup_destination_updated: 'DR backup storage destination updated.',
	admin_dr_backup_destination_title: 'Backup Destination',
	admin_dr_backup_loading_settings: 'Loading settings...',
	admin_dr_backup_storage_destination: 'Storage Destination',
	admin_dr_backup_not_configured: 'Not configured',
	admin_dr_backup_saml_bundle_title: 'SAML Signing DR Bundle',
	admin_dr_backup_saml_bundle_desc:
		'Export and restore local SAML signing keys, certificates, entity ID settings, and signing rollover state for this tenant.',
	admin_dr_backup_sensitive: 'Sensitive',
	admin_dr_backup_saml_bundle_warning:
		'This bundle is encrypted with your passphrase, but it contains private signing keys after decryption. Keep it offline and import it only when recreating the same tenant/domain environment.',
	admin_dr_backup_passphrase: 'Passphrase',
	admin_dr_backup_passphrase_placeholder: '12+ characters',
	admin_dr_backup_confirm_passphrase: 'Confirm passphrase',
	admin_dr_backup_confirm_passphrase_placeholder: 'Required for export',
	admin_dr_backup_exporting: 'Exporting...',
	admin_dr_backup_export_bundle: 'Export DR Bundle',
	admin_dr_backup_importing: 'Importing...',
	admin_dr_backup_import_bundle: 'Import DR Bundle',
	admin_dr_backup_bundle_exported: 'SAML signing DR bundle exported.',
	admin_dr_backup_bundle_imported: 'SAML signing DR bundle imported.',
	admin_dr_backup_error_export_bundle: 'Failed to export SAML signing DR bundle',
	admin_dr_backup_error_import_bundle: 'Failed to import SAML signing DR bundle'
} as const;

export default adminDrBackup;
