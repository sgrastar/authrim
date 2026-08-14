const adminTenantDiscovery = {
	admin_tenant_discovery_head_title: 'Tenant Discovery - Admin',
	admin_tenant_discovery_title: 'Tenant Discovery',
	admin_tenant_discovery_description_single:
		'Available after enabling multi-tenant mode. Use this page to configure tenant discovery flows.',
	admin_tenant_discovery_description_multi:
		'Configure tenant resolution behavior and customize the discovery screen.',
	admin_tenant_discovery_loading: 'Loading tenant discovery settings...',
	admin_tenant_discovery_single_mode_disabled:
		'Tenant discovery is disabled while this deployment is running in single-tenant mode. You can start from `workers.dev`, add an API custom domain later, and then enable multi-tenant mode in Setup.',
	admin_tenant_discovery_controls_title: 'Discovery Controls',
	admin_tenant_discovery_controls_description:
		'Common entry, tenant resolution, and discovery screen overrides become available after multi-tenant mode is enabled.',
	admin_tenant_discovery_enable_in_setup: 'Enable In Setup',
	admin_tenant_discovery_common_behavior_title: 'Common Entry Login Behavior',
	admin_tenant_discovery_common_behavior_description:
		'Controls the shared entry page before a tenant is selected. Current URL: {url:string}.',
	admin_tenant_discovery_platform_readonly_behavior:
		'Common entry behavior is a platform setting. Tenant admins can review it, but cannot edit it.',
	admin_tenant_discovery_entry_mode: 'Entry Mode',
	admin_tenant_discovery_entry_mode_tenant_only: 'Tenant-specific entry only',
	admin_tenant_discovery_entry_mode_discovery_optional: 'Discovery optional',
	admin_tenant_discovery_entry_mode_discovery_required: 'Discovery required',
	admin_tenant_discovery_entry_mode_tenant_only_description:
		'Users sign in through a tenant-specific entry point. The shared discovery page is bypassed unless another flow sends users there.',
	admin_tenant_discovery_entry_mode_tenant_only_sample:
		'Use when every app or invitation already knows the tenant.',
	admin_tenant_discovery_entry_mode_discovery_optional_description:
		'Users can use tenant discovery, but tenant-specific login URLs remain valid.',
	admin_tenant_discovery_entry_mode_discovery_optional_sample:
		'Good default for gradual multi-tenant rollout.',
	admin_tenant_discovery_entry_mode_discovery_required_description:
		'Users must resolve a tenant before authentication methods are shown.',
	admin_tenant_discovery_entry_mode_discovery_required_sample:
		'Use when the shared login entry should always choose a tenant first.',
	admin_tenant_discovery_example: 'Example: {sample:string}',
	admin_tenant_discovery_selection_policy: 'Selection Policy',
	admin_tenant_discovery_selection_auto_if_single: 'Auto if single',
	admin_tenant_discovery_selection_always_select: 'Always select',
	admin_tenant_discovery_selection_select_if_multiple: 'Select if multiple',
	admin_tenant_discovery_selection_manual_only: 'Manual only',
	admin_tenant_discovery_selection_auto_if_single_description:
		'Automatically continue when discovery returns exactly one tenant. Show a selection screen for multiple matches.',
	admin_tenant_discovery_selection_auto_if_single_sample:
		'Best when mappings are reliable and one clear match is common.',
	admin_tenant_discovery_selection_always_select_description:
		'Always show the tenant selection step after discovery, even if only one tenant matched.',
	admin_tenant_discovery_selection_always_select_sample:
		'Use when users should explicitly confirm the tenant.',
	admin_tenant_discovery_selection_select_if_multiple_description:
		'Skip the selection step for one match, but ask users to choose when multiple tenants match.',
	admin_tenant_discovery_selection_select_if_multiple_sample:
		'Balanced default for shared email domains.',
	admin_tenant_discovery_selection_manual_only_description:
		'Do not auto-select from email resolution. Users must enter or choose a tenant manually.',
	admin_tenant_discovery_selection_manual_only_sample:
		'Requires tenant code, tenant slug, or WAYF discovery to stay enabled.',
	admin_tenant_discovery_enabled_methods: 'Enabled Discovery Methods',
	admin_tenant_discovery_method_email: 'Email address',
	admin_tenant_discovery_method_email_description:
		'Allow users to identify the tenant from their email address, with optional email-domain fallback.',
	admin_tenant_discovery_method_tenant_code: 'Tenant code',
	admin_tenant_discovery_method_tenant_code_description:
		'Allow users to identify the tenant by tenant code.',
	admin_tenant_discovery_method_tenant_slug: 'Tenant slug',
	admin_tenant_discovery_method_tenant_slug_description:
		'Allow users to identify the tenant by tenant slug.',
	admin_tenant_discovery_method_wayf: 'WAYF tenant chooser',
	admin_tenant_discovery_method_wayf_description:
		'Show a tenant-name dropdown populated from active tenants.',
	admin_tenant_discovery_allow_manual: 'Allow manual tenant entry',
	admin_tenant_discovery_allow_manual_description:
		'Show manual entry fallback when automatic discovery cannot resolve a tenant.',
	admin_tenant_discovery_remember_last: 'Remember last tenant',
	admin_tenant_discovery_remember_last_description:
		'Remember the tenant that was resolved most recently for this browser.',
	admin_tenant_discovery_redirect_default_login: 'Redirect default login to discovery',
	admin_tenant_discovery_redirect_default_login_description:
		'Redirect common-entry /login requests to /discover when appropriate.',
	admin_tenant_discovery_require_common_before_login:
		'Require common discovery before tenant login',
	admin_tenant_discovery_require_common_before_login_common_description:
		'When enabled, direct tenant-host /login visits must pass through the shared discover screen first. Challenge-based OIDC login is unchanged.',
	admin_tenant_discovery_require_common_before_login_tenant_description:
		'When enabled, direct visits to this tenant /login must pass through the shared discover screen first. Challenge-based OIDC login is unchanged.',
	admin_tenant_discovery_redirect_tenant_discover: 'Redirect tenant discover to common entry',
	admin_tenant_discovery_redirect_tenant_discover_common_description:
		'Redirect tenant-host and vanity-host /discover to common entry.',
	admin_tenant_discovery_redirect_tenant_discover_tenant_description:
		'Redirect this tenant host and vanity host /discover to common entry.',
	admin_tenant_discovery_skip_if_one: 'Skip discovery when only one tenant exists',
	admin_tenant_discovery_skip_if_one_description:
		'When enabled, the shared /discover flow immediately continues to the tenant login page if there is exactly one active tenant.',
	admin_tenant_discovery_save_common_behavior: 'Save Common Entry Behavior',
	admin_tenant_discovery_saving: 'Saving...',
	admin_tenant_discovery_tenant_behavior_title_single: 'Discovery Behavior',
	admin_tenant_discovery_tenant_behavior_title_multi: 'Tenant Entry Override',
	admin_tenant_discovery_tenant_behavior_description_single:
		'Controls how this tenant is resolved before login.',
	admin_tenant_discovery_tenant_behavior_description_multi:
		'Controls direct entry behavior for {tenant:string}. This does not change the shared entry page at {url:string}.',
	admin_tenant_discovery_open_tenant_details: 'Open Tenant Details',
	admin_tenant_discovery_enable_tenant_override: 'Enable tenant entry override',
	admin_tenant_discovery_enable_tenant_override_description:
		'When disabled, this tenant uses the common entry behavior. Existing tenant values are kept but ignored until this override is enabled.',
	admin_tenant_discovery_save_behavior: 'Save Discovery Behavior',
	admin_tenant_discovery_common_behavior_active:
		'Common entry behavior is active for this tenant. Enable the override to configure tenant-specific entry behavior.',
	admin_tenant_discovery_save_tenant_entry_override: 'Save Tenant Entry Override',
	admin_tenant_discovery_common_screen_title: 'Common Entry Screen Content',
	admin_tenant_discovery_common_screen_description:
		'Text, branding, and theme used by the shared entry page at {url:string}.',
	admin_tenant_discovery_platform_readonly_screen:
		'Common entry screen content is a platform setting. Tenant admins can review it, but cannot edit it.',
	admin_tenant_discovery_common_prefill_hint:
		'Blank values are prefilled with the effective defaults currently shown on the shared discovery screen.',
	admin_tenant_discovery_theme: 'Theme',
	admin_tenant_discovery_variant: 'Variant',
	admin_tenant_discovery_inherit_default: 'Inherit / default',
	admin_tenant_discovery_light: 'light',
	admin_tenant_discovery_dark: 'dark',
	admin_tenant_discovery_beige: 'beige',
	admin_tenant_discovery_blue_gray: 'blue-gray',
	admin_tenant_discovery_green: 'green',
	admin_tenant_discovery_brown: 'brown',
	admin_tenant_discovery_navy: 'navy',
	admin_tenant_discovery_slate: 'slate',
	admin_tenant_discovery_brand_name: 'Brand Name',
	admin_tenant_discovery_logo_url: 'Logo URL',
	admin_tenant_discovery_page_title: 'Page Title',
	admin_tenant_discovery_kicker_text: 'Kicker Text',
	admin_tenant_discovery_title_text: 'Title Text',
	admin_tenant_discovery_subtitle_text: 'Subtitle Text',
	admin_tenant_discovery_save_common_screen: 'Save Common Entry Screen',
	admin_tenant_discovery_tenant_screen_title: 'Tenant Override Screen Content',
	admin_tenant_discovery_tenant_screen_description:
		'Overrides for tenant-specific discovery screens on {tenant:string}. In multi-tenant mode, /discover on tenant hosts usually redirects to /login, so these values mainly apply to flows that still render discovery directly, such as invitation or app-hint resolution.',
	admin_tenant_discovery_enable_tenant_screen_override: 'Enable tenant screen content override',
	admin_tenant_discovery_enable_tenant_screen_override_description:
		'When disabled, common discovery screen content applies. Existing tenant screen values are kept but ignored until this override is enabled.',
	admin_tenant_discovery_tenant_prefill_hint:
		'Fields are prefilled with the effective values currently used for this tenant. Saving writes them as explicit tenant overrides.',
	admin_tenant_discovery_inherit_from_login_ui: 'Inherit from Login UI',
	admin_tenant_discovery_save_tenant_override: 'Save Tenant Override',
	admin_tenant_discovery_common_screen_active:
		'Common discovery screen content is active for this tenant. Enable the override to customize tenant-specific discovery screens.',
	admin_tenant_discovery_save_tenant_screen_override: 'Save Tenant Screen Override',
	admin_tenant_discovery_validation_enable_method: 'Enable at least one discovery method.',
	admin_tenant_discovery_validation_manual_requires_method:
		'manual_only requires tenant code, tenant slug, or WAYF to remain enabled.',
	admin_tenant_discovery_common_url_fallback: 'the shared /discover URL',
	admin_tenant_discovery_load_common_behavior_failed: 'Failed to load common entry behavior',
	admin_tenant_discovery_load_common_screen_failed: 'Failed to load common entry screen settings',
	admin_tenant_discovery_load_failed: 'Failed to load tenant discovery settings',
	admin_tenant_discovery_conflict: 'Settings were modified by another user. Reload and try again.',
	admin_tenant_discovery_behavior_saved: 'Discovery behavior saved',
	admin_tenant_discovery_behavior_save_failed: 'Failed to save discovery behavior',
	admin_tenant_discovery_common_behavior_saved: 'Common entry discovery behavior saved',
	admin_tenant_discovery_common_behavior_save_failed:
		'Failed to save common entry discovery behavior',
	admin_tenant_discovery_common_screen_saved: 'Common entry screen saved',
	admin_tenant_discovery_common_screen_save_failed: 'Failed to save common entry screen',
	admin_tenant_discovery_tenant_screen_saved: 'Tenant discovery screen saved',
	admin_tenant_discovery_tenant_screen_save_failed: 'Failed to save tenant discovery screen'
} as const;

export default adminTenantDiscovery;
