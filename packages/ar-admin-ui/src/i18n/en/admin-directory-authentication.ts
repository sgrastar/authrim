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
		'Record verified but unmapped directory users as pending. Authrim does not create a normal session for them.',
	admin_directory_authentication_pending_title: 'Pending directory users',
	admin_directory_authentication_pending_description:
		'Review users who passed directory authentication but are not linked to an Authrim user.',
	admin_directory_authentication_pending_warning:
		'Automatic active creation has a high blast radius when a directory scope is misconfigured. Verify SCIM, CSV, or Authrim profile data before linking.',
	admin_directory_authentication_pending_loading: 'Loading pending users...',
	admin_directory_authentication_pending_refresh: 'Refresh',
	admin_directory_authentication_pending_empty: 'No pending directory users.',
	admin_directory_authentication_pending_load_failed: 'Failed to load pending directory users',
	admin_directory_authentication_pending_update_failed: 'Failed to update pending directory user',
	admin_directory_authentication_pending_updated: 'Pending directory user updated.',
	admin_directory_authentication_pending_link_user_required:
		'An Authrim User ID is required to link an existing user.',
	admin_directory_authentication_pending_group_count: '{count:number} groups',
	admin_directory_authentication_pending_details: 'Details',
	admin_directory_authentication_pending_subject: 'Directory Subject',
	admin_directory_authentication_pending_identifier: 'Login Identifier',
	admin_directory_authentication_pending_user_id: 'Authrim User ID',
	admin_directory_authentication_pending_reason: 'Reason',
	admin_directory_authentication_pending_approve: 'Approve',
	admin_directory_authentication_pending_link: 'Link',
	admin_directory_authentication_pending_reject: 'Reject',
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
	admin_directory_authentication_load_events: 'Load Events',
	admin_directory_authentication_loading_events: 'Loading...',
	admin_directory_authentication_events_failed: 'Failed to load relay events',
	admin_directory_authentication_recent_events: 'Recent relay events',
	admin_directory_authentication_issue_secret: 'Issue Secret',
	admin_directory_authentication_issuing_secret: 'Issuing...',
	admin_directory_authentication_rotate_secret: 'Rotate Secret',
	admin_directory_authentication_rotating_secret: 'Rotating...',
	admin_directory_authentication_secret_issued: 'Connector secret issued.',
	admin_directory_authentication_secret_rotated: 'Connector secret rotated.',
	admin_directory_authentication_secret_failed: 'Failed to update connector secret',
	admin_directory_authentication_one_time_secret: 'One-time secret',
	admin_directory_authentication_one_time_secret_hint:
		'Copy this value into Wordwarden. Authrim will not show it again.',
	admin_directory_authentication_id: 'Connector ID',
	admin_directory_authentication_endpoint_url: 'Endpoint URL',
	admin_directory_authentication_connector_id: 'Wordwarden Connector ID',
	admin_directory_authentication_relay_url: 'Relay URL',
	admin_directory_authentication_relay_url_copy: 'Copy',
	admin_directory_authentication_relay_url_copied: 'Copied',
	admin_directory_authentication_relay_url_copy_failed: 'Failed to copy relay URL',
	admin_directory_authentication_key_id: 'Key ID',
	admin_directory_authentication_secret_ref: 'Secret Reference',
	admin_directory_authentication_timeout_ms: 'Timeout (ms)',
	admin_directory_authentication_relay_verify_timeout_ms: 'Relay Verify Timeout (ms)',
	admin_directory_authentication_relay_max_pending_requests: 'Max Pending Requests',
	admin_directory_authentication_relay_challenge_ttl_ms: 'Challenge TTL (ms)',
	admin_directory_authentication_relay_auth_failure_rate: 'Auth Failures / Minute',
	admin_directory_authentication_relay_auth_failure_block_ms: 'Auth Failure Block (ms)',
	admin_directory_authentication_rotation_grace_ms: 'Rotation Grace (ms)',
	admin_directory_authentication_attributes: 'LDAP Attributes',
	admin_directory_authentication_auth_mode: 'Auth Mode',
	admin_directory_authentication_hmac: 'HMAC',
	admin_directory_authentication_transport: 'Transport',
	admin_directory_authentication_transport_direct: 'Direct HTTPS',
	admin_directory_authentication_transport_relay: 'Outbound Relay',
	admin_directory_authentication_attributes_hint: 'Comma-separated attribute names.',
	admin_directory_authentication_secret_hint:
		'Use managed:<connector-id>, env:WORDWARDEN_*, or env:AUTHRIM_WORDWARDEN_*.',
	admin_directory_authentication_validation_id_required: 'Connector ID is required.',
	admin_directory_authentication_validation_id_format:
		'Connector ID can contain letters, numbers, underscores, and hyphens.',
	admin_directory_authentication_validation_id_unique: 'Connector ID must be unique.',
	admin_directory_authentication_validation_endpoint_required: 'Endpoint URL is required.',
	admin_directory_authentication_validation_endpoint_https:
		'Endpoint URL must use HTTPS except http://localhost for local development.',
	admin_directory_authentication_validation_connector_id_required:
		'Wordwarden Connector ID is required.',
	admin_directory_authentication_validation_connector_id_format:
		'Wordwarden Connector ID must start with wwcon_ followed by 16 immutable characters.',
	admin_directory_authentication_validation_connector_id_unique:
		'Wordwarden Connector ID must be unique.',
	admin_directory_authentication_validation_key_id_required: 'Key ID is required.',
	admin_directory_authentication_validation_secret_required: 'Secret Reference is required.',
	admin_directory_authentication_validation_secret_format:
		'Secret Reference must use managed:<connector-id>, env:WORDWARDEN_*, or env:AUTHRIM_WORDWARDEN_*.',
	admin_directory_authentication_validation_timeout: 'Timeout must be between 100 and 30000 ms.',
	admin_directory_authentication_validation_relay_verify_timeout:
		'Relay Verify Timeout must be between 100 and 30000 ms.',
	admin_directory_authentication_validation_relay_max_pending:
		'Max Pending Requests must be between 1 and 256.',
	admin_directory_authentication_validation_relay_challenge_ttl:
		'Challenge TTL must be between 5000 and 300000 ms.',
	admin_directory_authentication_validation_relay_auth_failure_rate:
		'Auth Failures / Minute must be between 1 and 100.',
	admin_directory_authentication_validation_relay_auth_failure_block:
		'Auth Failure Block must be between 1000 and 3600000 ms.',
	admin_directory_authentication_validation_rotation_grace:
		'Rotation grace must be between 0 and 86400000 ms.',
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
