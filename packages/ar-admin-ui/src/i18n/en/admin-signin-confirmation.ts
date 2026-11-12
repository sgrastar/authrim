const adminSigninConfirmation = {
	admin_signin_confirmation_nav: 'Sign-in Confirmation',
	admin_signin_confirmation_page_title: 'Sign-in Confirmation - Authrim Admin',
	admin_signin_confirmation_title: 'Sign-in Confirmation',
	admin_signin_confirmation_description:
		'Controls whether users must confirm the application and tenant context during sign-in. Use this when a long-lived session may be reused across applications, or when users should explicitly confirm where they are signing in.',
	admin_signin_confirmation_load_error: 'Failed to load sign-in confirmation policy.',
	admin_signin_confirmation_loading: 'Loading sign-in confirmation policy...',
	admin_signin_confirmation_mode: 'Mode',
	admin_signin_confirmation_mode_disabled: 'Disabled',
	admin_signin_confirmation_mode_first_time: 'First time',
	admin_signin_confirmation_mode_every_time: 'Every time',
	admin_signin_confirmation_remember_days: 'Remember days',
	admin_signin_confirmation_remember_days_value: '{days:number} days',
	admin_signin_confirmation_show_application_context: 'Show application context',
	admin_signin_confirmation_show_tenant_context: 'Show tenant context',
	admin_signin_confirmation_active: 'Active',
	admin_signin_confirmation_save: 'Save sign-in policy',
	admin_signin_confirmation_saved: 'Sign-in confirmation policy saved.',
	admin_signin_confirmation_save_error: 'Failed to save sign-in confirmation policy.',
	admin_signin_confirmation_permission:
		'You do not have permission to change sign-in confirmation policies.',
	admin_signin_confirmation_name: 'Name',
	admin_signin_confirmation_context: 'Context',
	admin_signin_confirmation_context_summary: 'App {app:string} / Tenant {tenant:string}',
	admin_signin_confirmation_status: 'Status',
	admin_signin_confirmation_none: 'No sign-in confirmation policy.',
	admin_signin_confirmation_enabled: 'Enabled',
	admin_signin_confirmation_disabled: 'Disabled'
} as const;

export default adminSigninConfirmation;
