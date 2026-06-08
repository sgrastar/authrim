const adminEmailSettings = {
	admin_email_settings_head_title: 'Email Settings - Authrim Admin',
	admin_email_settings_title: 'Email Settings',
	admin_email_settings_description:
		'Choose the tenant-wide delivery order for enabled and configured email providers.',
	admin_email_settings_save_order: 'Save Order',
	admin_email_settings_saving: 'Saving...',
	admin_email_settings_load_failed: 'Failed to load email settings',
	admin_email_settings_save_failed: 'Failed to save email settings',
	admin_email_settings_select_tenant: 'Select a tenant to manage email settings',
	admin_email_settings_saved: 'Email provider order saved',
	admin_email_settings_loading: 'Loading email settings...',
	admin_email_settings_delivery_mode: 'Delivery Mode',
	admin_email_settings_strategy_priority_failover: 'Priority + Failover',
	admin_email_settings_tenant: 'Tenant',
	admin_email_settings_not_selected: 'Not selected',
	admin_email_settings_provider_priority: 'Provider Priority',
	admin_email_settings_provider_priority_description:
		'Configured providers are tried in this order until delivery succeeds.',
	admin_email_settings_open_plugins: 'Open Plugins Page',
	admin_email_settings_empty: 'No configured email providers are available for this tenant.',
	admin_email_settings_empty_hint:
		'Disabled providers and plugins missing required settings are hidden here. Enable and configure Cloudflare Email Service or Resend on the Plugins page first.',
	admin_email_settings_provider_settings: 'Provider Settings',
	admin_email_settings_configured_via: 'Configured via {source:string}',
	admin_email_settings_from: 'From: {address:string}',
	admin_email_settings_move_up: 'Move Up',
	admin_email_settings_move_down: 'Move Down'
} as const;

export default adminEmailSettings;
