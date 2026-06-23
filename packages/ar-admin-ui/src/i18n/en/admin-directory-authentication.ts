const adminDirectoryAuthentication = {
	admin_directory_authentication_page_title: 'Directory Authentication - Authrim Admin',
	admin_directory_authentication_title: 'Directory Authentication',
	admin_directory_authentication_description:
		'Configure Directory Connectors used for LDAP/AD password verification.',
	admin_directory_authentication_load_failed: 'Failed to load directory connectors',
	admin_directory_authentication_save_failed: 'Failed to save directory connectors',
	admin_directory_authentication_saved: 'Directory connector settings saved.',
	admin_directory_authentication_select_tenant:
		'Select a tenant to manage directory authentication.',
	admin_directory_authentication_loading: 'Loading directory connectors...',
	admin_directory_authentication_add_connector: 'Add Connector',
	admin_directory_authentication_save: 'Save',
	admin_directory_authentication_saving: 'Saving...',
	admin_directory_authentication_discard: 'Discard',
	admin_directory_authentication_empty: 'No directory connectors configured.',
	admin_directory_authentication_runtime_title: 'Runtime Behavior',
	admin_directory_authentication_runtime_description:
		'Configure when Authrim uses Directory Connectors during login.',
	admin_directory_authentication_enable_login: 'Directory password login',
	admin_directory_authentication_enable_login_description:
		'When enabled, Authrim verifies LDAP/AD passwords through Wordwarden from the login screen.',
	admin_directory_authentication_default_connector: 'Default Connector',
	admin_directory_authentication_auto_provision: 'Auto-provision users',
	admin_directory_authentication_auto_provision_description:
		'Create an Authrim user from directory attributes when a verified directory identity is not mapped yet.',
	admin_directory_authentication_status: 'Status',
	admin_directory_authentication_status_enabled: 'Enabled',
	admin_directory_authentication_status_disabled: 'Disabled',
	admin_directory_authentication_connectors_title: 'Connectors',
	admin_directory_authentication_connectors_description:
		'Authrim sends password verification requests to these Wordwarden endpoints.',
	admin_directory_authentication_remove: 'Remove',
	admin_directory_authentication_check_health: 'Check Health',
	admin_directory_authentication_checking_health: 'Checking...',
	admin_directory_authentication_health_ok: 'Healthy',
	admin_directory_authentication_health_failed: 'Health check failed',
	admin_directory_authentication_health_status: 'HTTP {status:number}',
	admin_directory_authentication_id: 'Connector ID',
	admin_directory_authentication_endpoint_url: 'Endpoint URL',
	admin_directory_authentication_connector_id: 'Wordwarden Tenant ID',
	admin_directory_authentication_key_id: 'Key ID',
	admin_directory_authentication_secret_ref: 'Secret Reference',
	admin_directory_authentication_timeout_ms: 'Timeout (ms)',
	admin_directory_authentication_attributes: 'LDAP Attributes',
	admin_directory_authentication_auth_mode: 'Auth Mode',
	admin_directory_authentication_hmac: 'HMAC',
	admin_directory_authentication_attributes_hint: 'Comma-separated attribute names.',
	admin_directory_authentication_secret_hint: 'Use env:WORDWARDEN_* or env:AUTHRIM_WORDWARDEN_*.',
	admin_directory_authentication_validation_id_required: 'Connector ID is required.',
	admin_directory_authentication_validation_id_format:
		'Connector ID can contain letters, numbers, underscores, and hyphens.',
	admin_directory_authentication_validation_id_unique: 'Connector ID must be unique.',
	admin_directory_authentication_validation_endpoint_required: 'Endpoint URL is required.',
	admin_directory_authentication_validation_endpoint_https:
		'Endpoint URL must use HTTPS except http://localhost for local development.',
	admin_directory_authentication_validation_connector_id_required:
		'Wordwarden Tenant ID is required.',
	admin_directory_authentication_validation_key_id_required: 'Key ID is required.',
	admin_directory_authentication_validation_secret_required: 'Secret Reference is required.',
	admin_directory_authentication_validation_secret_format:
		'Secret Reference must use env:WORDWARDEN_* or env:AUTHRIM_WORDWARDEN_*.',
	admin_directory_authentication_validation_timeout: 'Timeout must be between 100 and 30000 ms.',
	admin_directory_authentication_validation_attributes:
		'LDAP Attributes can contain up to 32 names.',
	admin_directory_authentication_validation_connector_required_when_enabled:
		'At least one connector is required when directory password login is enabled.',
	admin_directory_authentication_validation_default_connector:
		'Default Connector must match one configured connector.',
	admin_directory_authentication_tenant: 'Tenant',
	admin_directory_authentication_not_selected: 'Not selected',
	admin_directory_authentication_count: '{count:number} connectors'
} as const;

export default adminDirectoryAuthentication;
