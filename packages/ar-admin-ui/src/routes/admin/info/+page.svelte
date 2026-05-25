<script lang="ts">
	import { onMount } from 'svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { getTenantInfo, type TenantInfo } from '$lib/api/admin-info';
	import { adminSettingsAPI, type CategorySettings } from '$lib/api/admin-settings';
	import { adminSAMLAPI, type SAMLSettings } from '$lib/api/admin-saml';
	import { parseDiscoveryMethods } from '$lib/admin/tenant-discovery-settings';

	type LoginEntryMode = 'tenant_only' | 'discovery_optional' | 'discovery_required';

	interface LoginEntryPreviewSettings {
		overrideEnabled: boolean;
		mode: LoginEntryMode;
		discoveryMethods: string[];
		selectionPolicy: string;
		requireCommonDiscoveryBeforeLogin: boolean;
		skipDiscoveryIfOnlyOneTenant: boolean;
		redirectTenantDiscoverToCommonEntry: boolean;
	}

	// State
	let info = $state<TenantInfo | null>(null);
	let samlSettings = $state<SAMLSettings | null>(null);
	let tenantLoginEntrySettings = $state<LoginEntryPreviewSettings | null>(null);
	let commonLoginEntrySettings = $state<LoginEntryPreviewSettings | null>(null);
	let loading = $state(true);
	let error = $state('');
	let copiedKey = $state('');

	const effectiveTenantLoginEntrySettings = $derived(
		tenantLoginEntrySettings?.overrideEnabled ? tenantLoginEntrySettings : commonLoginEntrySettings
	);

	onMount(async () => {
		await settingsContext.initialize();
	});

	// React to tenant switching
	$effect(() => {
		const tenantId =
			settingsContext.current.tenantId?.trim() || settingsContext.availableTenants[0]?.id?.trim();
		if (!tenantId) {
			loading = false;
			info = null;
			samlSettings = null;
			tenantLoginEntrySettings = null;
			commonLoginEntrySettings = null;
			return;
		}
		loadInfo(tenantId);
	});

	async function loadInfo(tenantId: string) {
		loading = true;
		error = '';
		info = null;
		samlSettings = null;
		tenantLoginEntrySettings = null;
		commonLoginEntrySettings = null;
		try {
			const [infoResult, samlResult, tenantLoginEntryResult, commonLoginEntryResult] =
				await Promise.all([
					getTenantInfo(tenantId),
					adminSAMLAPI.getSettings().catch(() => null),
					adminSettingsAPI.getSettings('login-entry', tenantId).catch(() => null),
					adminSettingsAPI.getPlatformSettings('login-entry').catch(() => null)
				]);
			info = infoResult;
			samlSettings = samlResult;
			tenantLoginEntrySettings = normalizeLoginEntrySettings(tenantLoginEntryResult);
			commonLoginEntrySettings =
				normalizeLoginEntrySettings(commonLoginEntryResult) ?? tenantLoginEntrySettings;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load info';
		} finally {
			loading = false;
		}
	}

	async function copy(text: string, key: string) {
		try {
			await navigator.clipboard.writeText(text);
			copiedKey = key;
			setTimeout(() => {
				copiedKey = '';
			}, 2000);
		} catch {
			// clipboard not available
		}
	}

	function normalizeLoginEntrySettings(
		settings: CategorySettings | null
	): LoginEntryPreviewSettings | null {
		if (!settings) return null;
		const values = settings.values;
		const mode = values['login-entry.mode'];
		return {
			overrideEnabled: readBooleanSetting(values, 'login-entry.override_enabled', false),
			mode:
				mode === 'tenant_only' || mode === 'discovery_optional' || mode === 'discovery_required'
					? mode
					: 'discovery_optional',
			discoveryMethods: parseDiscoveryMethods(values['login-entry.discovery_methods']),
			selectionPolicy:
				typeof values['login-entry.selection_policy'] === 'string'
					? values['login-entry.selection_policy']
					: 'select_if_multiple',
			requireCommonDiscoveryBeforeLogin: readBooleanSetting(
				values,
				'login-entry.require_common_discovery_before_login',
				true
			),
			skipDiscoveryIfOnlyOneTenant: readBooleanSetting(
				values,
				'login-entry.skip_discovery_if_only_one_tenant',
				false
			),
			redirectTenantDiscoverToCommonEntry: readBooleanSetting(
				values,
				'login-entry.redirect_tenant_discover_to_common_entry',
				true
			)
		};
	}

	function readBooleanSetting(values: Record<string, unknown>, key: string, fallback: boolean) {
		return typeof values[key] === 'boolean' ? values[key] : fallback;
	}

	function formatDiscoveryMethods(methods: string[] | undefined) {
		if (!methods || methods.length === 0) return 'None configured';
		return methods
			.map((method) => {
				switch (method) {
					case 'email_domain':
						return 'Email/domain';
					case 'tenant_code':
						return 'Tenant code';
					case 'tenant_slug':
						return 'Tenant slug';
					case 'wayf':
						return 'WAYF dropdown';
					default:
						return method;
				}
			})
			.join(', ');
	}

	function tenantLoginFirstPage() {
		if (!info?.login_ui_url) return 'Not configured';
		const settings = effectiveTenantLoginEntrySettings;
		if (
			info.discover_url &&
			settings?.mode !== 'tenant_only' &&
			settings?.requireCommonDiscoveryBeforeLogin
		) {
			return `Tenant discovery first, then ${info.login_ui_url}`;
		}
		return info.login_ui_url;
	}

	function globalLoginFirstPage() {
		if (!info?.global_login_ui_url) return 'Not configured';
		if (!info.discover_url) return info.global_login_ui_url;
		const settings = commonLoginEntrySettings;
		if (settings?.skipDiscoveryIfOnlyOneTenant) {
			return `${info.discover_url} (may skip if only one tenant is active)`;
		}
		return info.discover_url;
	}

	function samlInteractiveFirstPage() {
		if (!samlSettings) return 'Not configured';
		const policy = samlSettings.interactiveLoginUrlPolicy;
		if (policy === 'tenant_host') {
			return tenantLoginFirstPage();
		}
		return globalLoginFirstPage();
	}
</script>

<svelte:head>
	<title>Info — Admin Dashboard — Authrim</title>
</svelte:head>

<!-- Reusable URL row snippet -->
{#snippet urlRow(label: string, value: string, urlKey: string, href?: string, monospace?: boolean)}
	<div class="url-row">
		<span class="url-label">{label}</span>
		<div class="url-value-row">
			{#if href}
				<a
					{href}
					target="_blank"
					rel="noopener noreferrer"
					class="url-value url-link {monospace ? 'monospace' : ''}"
				>
					{value}
					<i class="i-ph-arrow-square-out w-3 h-3 flex-shrink-0"></i>
				</a>
			{:else}
				<span class="url-value {monospace ? 'monospace' : ''}">{value}</span>
			{/if}
			<button
				class="copy-btn {copiedKey === urlKey ? 'copied' : ''}"
				onclick={() => copy(value, urlKey)}
				title="Copy to clipboard"
			>
				{#if copiedKey === urlKey}
					<i class="i-ph-check w-4 h-4"></i>
				{:else}
					<i class="i-ph-copy w-4 h-4"></i>
				{/if}
			</button>
		</div>
	</div>
{/snippet}

<div class="page-container">
	<div class="page-header">
		<h1 class="page-title">Info</h1>
		<p class="page-description">
			Issuer metadata, well-known URLs, and endpoint references for this tenant.
		</p>
	</div>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch animate-spin w-6 h-6"></i>
			<span>Loading...</span>
		</div>
	{:else if error}
		<div class="error-banner">
			<i class="i-ph-warning-circle w-5 h-5"></i>
			{error}
		</div>
	{:else if info}
		<!-- Identity -->
		<section class="info-section">
			<h2 class="section-title">
				<i class="i-ph-identification-card w-5 h-5"></i>
				Identity
			</h2>
			<div class="url-grid">
				{@render urlRow('Tenant ID', info.tenant_id, 'tenant_id', undefined, true)}
				{@render urlRow('Tenant Name', info.tenant_name, 'tenant_name')}
				{@render urlRow('Issuer', info.issuer, 'issuer', info.issuer)}
				{@render urlRow('API Base URL', info.api_url, 'api_url', info.api_url)}
				{#if info.components.login_ui}
					{@render urlRow('Built-in Login UI', 'Deployed', 'login_ui_deployment')}
				{:else}
					{@render urlRow('Built-in Login UI', 'Not deployed', 'login_ui_deployment')}
				{/if}
				{#if info.login_ui_url}
					{@render urlRow(
						'Login URL (this tenant)',
						info.login_ui_url,
						'login_ui_url',
						info.login_ui_url
					)}
				{:else}
					{@render urlRow('Login URL (this tenant)', 'Not configured', 'login_ui_url_status')}
				{/if}
				{@render urlRow(
					'Tenant Login First Page',
					tenantLoginFirstPage(),
					'tenant_login_first_page'
				)}
				{#if info.global_login_ui_url}
					{@render urlRow(
						'Global Login URL (common entry)',
						info.global_login_ui_url,
						'global_login_ui_url',
						info.global_login_ui_url
					)}
				{:else}
					{@render urlRow(
						'Global Login URL (common entry)',
						'Not configured',
						'global_login_ui_url_status'
					)}
				{/if}
				{@render urlRow(
					'Global Login First Page',
					globalLoginFirstPage(),
					'global_login_first_page'
				)}
				{#if info.discover_url}
					{@render urlRow(
						'Tenant Discovery URL',
						info.discover_url,
						'discover_url',
						info.discover_url
					)}
				{/if}
				{#if info.components.admin_ui && info.admin_ui_url}
					{@render urlRow('Admin UI URL', info.admin_ui_url, 'admin_ui_url', info.admin_ui_url)}
				{:else}
					{@render urlRow('Admin UI', 'Not deployed', 'admin_ui_status')}
				{/if}
			</div>
		</section>

		<!-- Login Entry / Tenant Discovery -->
		<section class="info-section">
			<h2 class="section-title">
				<i class="i-ph-path w-5 h-5"></i>
				Login Entry / Tenant Discovery
			</h2>
			<div class="url-grid">
				{@render urlRow(
					'Tenant override',
					tenantLoginEntrySettings?.overrideEnabled ? 'Enabled' : 'Disabled',
					'login_entry_override'
				)}
				{@render urlRow(
					'Effective tenant mode',
					effectiveTenantLoginEntrySettings?.mode ?? 'Not available',
					'effective_tenant_mode',
					undefined,
					true
				)}
				{@render urlRow(
					'Effective tenant methods',
					formatDiscoveryMethods(effectiveTenantLoginEntrySettings?.discoveryMethods),
					'effective_tenant_methods'
				)}
				{@render urlRow(
					'Common entry mode',
					commonLoginEntrySettings?.mode ?? 'Not available',
					'common_entry_mode',
					undefined,
					true
				)}
				{@render urlRow(
					'Common entry methods',
					formatDiscoveryMethods(commonLoginEntrySettings?.discoveryMethods),
					'common_entry_methods'
				)}
				{@render urlRow(
					'Common discovery before tenant login',
					effectiveTenantLoginEntrySettings?.requireCommonDiscoveryBeforeLogin
						? 'Enabled'
						: 'Disabled',
					'common_before_tenant_login'
				)}
			</div>
		</section>

		<!-- Well-Known / Discovery -->
		<section class="info-section">
			<h2 class="section-title">
				<i class="i-ph-magnifying-glass w-5 h-5"></i>
				Well-Known / Discovery
			</h2>
			<div class="url-grid">
				{@render urlRow(
					'OpenID Configuration',
					info.well_known.openid_configuration,
					'wk_oidc',
					info.well_known.openid_configuration
				)}
				{@render urlRow(
					'OAuth Authorization Server',
					info.well_known.oauth_authorization_server,
					'wk_oauth',
					info.well_known.oauth_authorization_server
				)}
				{@render urlRow(
					'JWKS (JSON Web Key Set)',
					info.well_known.jwks,
					'wk_jwks',
					info.well_known.jwks
				)}
				{@render urlRow(
					'WebFinger',
					info.well_known.webfinger,
					'wk_webfinger',
					info.well_known.webfinger
				)}
			</div>
		</section>

		<!-- OIDC / OAuth 2.0 -->
		<section class="info-section">
			<h2 class="section-title">
				<i class="i-ph-lock-key w-5 h-5"></i>
				OIDC / OAuth 2.0 Endpoints
			</h2>
			<div class="url-grid">
				{@render urlRow('Authorization', info.oidc.authorization, 'oidc_auth')}
				{@render urlRow('Token', info.oidc.token, 'oidc_token')}
				{@render urlRow('UserInfo', info.oidc.userinfo, 'oidc_userinfo')}
				{@render urlRow('Introspection', info.oidc.introspection, 'oidc_introspect')}
				{@render urlRow('Revocation', info.oidc.revocation, 'oidc_revoke')}
				{@render urlRow('End Session (Logout)', info.oidc.end_session, 'oidc_endsession')}
			</div>

			<h3 class="subsection-title">OAuth 2.0 Extensions</h3>
			<div class="url-grid">
				{#if info.components.async}
					{@render urlRow(
						'Device Authorization (RFC 8628)',
						info.oauth_extensions.device_authorization,
						'oauth_device'
					)}
				{:else}
					{@render urlRow('Device Authorization (RFC 8628)', 'Not deployed', 'oauth_device_status')}
				{/if}
				{@render urlRow(
					'Pushed Authorization Request (RFC 9126)',
					info.oauth_extensions.pushed_authorization_request,
					'oauth_par'
				)}
				{@render urlRow(
					'Dynamic Client Registration (RFC 7591)',
					info.oauth_extensions.dynamic_client_registration,
					'oauth_dcr'
				)}
			</div>
		</section>

		<!-- CIBA -->
		<section class="info-section">
			<h2 class="section-title">
				<i class="i-ph-device-mobile w-5 h-5"></i>
				CIBA (Client-Initiated Backchannel Authentication)
			</h2>
			<div class="url-grid">
				{#if info.components.async}
					{@render urlRow(
						'Backchannel Authentication (RFC 9449)',
						info.ciba.backchannel_authentication,
						'ciba_auth'
					)}
				{:else}
					{@render urlRow('Status', 'Not deployed', 'ciba_status')}
				{/if}
			</div>
		</section>

		<!-- SAML 2.0 -->
		<section class="info-section">
			<h2 class="section-title">
				<i class="i-ph-shield-check w-5 h-5"></i>
				SAML 2.0
			</h2>
			<div class="url-grid">
				{#if info.components.saml}
					{#if samlSettings}
						{@render urlRow(
							'Published IdP Entity ID',
							samlSettings.generated.idpEntityId,
							'saml_idp_entity_id',
							undefined,
							true
						)}
						{@render urlRow(
							'Published SP Entity ID',
							samlSettings.generated.spEntityId,
							'saml_sp_entity_id',
							undefined,
							true
						)}
						{@render urlRow(
							'Entity ID Style',
							samlSettings.entityIdStyle,
							'saml_entity_id_style',
							undefined,
							true
						)}
						{@render urlRow(
							'Interactive Login Redirect',
							samlSettings.interactiveLoginUrlPolicy === 'tenant_host'
								? 'Tenant Host'
								: 'UI Base URL',
							'saml_interactive_login_policy'
						)}
						{@render urlRow(
							'SAML First Visible Page',
							samlInteractiveFirstPage(),
							'saml_first_visible_page'
						)}
					{/if}
					{@render urlRow('SSO (Single Sign-On)', info.saml.sso, 'saml_sso')}
					{@render urlRow(
						'IdP Metadata',
						info.saml.idp_metadata,
						'saml_idp_metadata',
						info.saml.idp_metadata
					)}
					{@render urlRow(
						'SP Metadata',
						info.saml.sp_metadata ?? info.saml.metadata,
						'saml_sp_metadata',
						info.saml.sp_metadata ?? info.saml.metadata
					)}
					{@render urlRow('ACS (Assertion Consumer Service)', info.saml.acs, 'saml_acs')}
					{@render urlRow('SLO (Single Logout)', info.saml.slo, 'saml_slo')}
				{:else}
					{@render urlRow('Status', 'Not deployed', 'saml_status')}
				{/if}
			</div>
		</section>

		<!-- Verifiable Credentials -->
		<section class="info-section">
			<h2 class="section-title">
				<i class="i-ph-certificate w-5 h-5"></i>
				Verifiable Credentials (OID4VC)
			</h2>
			<div class="url-grid">
				{#if info.components.vc}
					{@render urlRow(
						'Credential Issuer Metadata',
						info.vc.credential_issuer_metadata,
						'vc_meta',
						info.vc.credential_issuer_metadata
					)}
					{@render urlRow('Credential Endpoint', info.vc.credential, 'vc_credential')}
					{@render urlRow('Batch Credential', info.vc.batch_credential, 'vc_batch')}
					{@render urlRow('Deferred Credential', info.vc.deferred_credential, 'vc_deferred')}
					{@render urlRow('VP Token Request', info.vc.vp_token_request, 'vc_vp')}
				{:else}
					{@render urlRow('Status', 'Not deployed', 'vc_status')}
				{/if}
			</div>
		</section>

		<!-- SCIM 2.0 -->
		<section class="info-section">
			<h2 class="section-title">
				<i class="i-ph-users-three w-5 h-5"></i>
				SCIM 2.0 (Provisioning)
			</h2>
			<div class="url-grid">
				{@render urlRow('Base URL', info.scim.base, 'scim_base')}
				{@render urlRow('Users', info.scim.users, 'scim_users')}
				{@render urlRow('Groups', info.scim.groups, 'scim_groups')}
				{@render urlRow(
					'Service Provider Config',
					info.scim.service_provider_config,
					'scim_spc',
					info.scim.service_provider_config
				)}
			</div>
		</section>

		<!-- Admin API -->
		<section class="info-section">
			<h2 class="section-title">
				<i class="i-ph-terminal w-5 h-5"></i>
				Admin API
			</h2>
			<div class="url-grid">
				{@render urlRow('Base URL', info.admin_api.base, 'api_base')}
				{@render urlRow('Users', info.admin_api.users, 'api_users')}
				{@render urlRow('Clients', info.admin_api.clients, 'api_clients')}
				{@render urlRow('Sessions', info.admin_api.sessions, 'api_sessions')}
				{@render urlRow('Audit Logs', info.admin_api.audit_logs, 'api_audit')}
				{@render urlRow('Settings', info.admin_api.settings, 'api_settings')}
				{@render urlRow('Tenants', info.admin_api.tenants, 'api_tenants')}
				{@render urlRow('Schema Settings', info.admin_api.custom_claims, 'api_claims')}
				{@render urlRow('Organizations', info.admin_api.organizations, 'api_orgs')}
				{@render urlRow('Roles', info.admin_api.roles, 'api_roles')}
				{@render urlRow('Webhooks', info.admin_api.webhooks, 'api_webhooks')}
			</div>
		</section>
	{/if}
</div>

<style>
	.page-container {
		max-width: 900px;
	}

	.page-header {
		margin-bottom: 28px;
	}

	.page-title {
		font-size: 1.5rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0 0 4px 0;
	}

	.page-description {
		font-size: 0.875rem;
		color: var(--text-secondary);
		margin: 0;
	}

	.loading-state {
		display: flex;
		align-items: center;
		gap: 10px;
		color: var(--text-secondary);
		padding: 40px 0;
	}

	.error-banner {
		display: flex;
		align-items: center;
		gap: 8px;
		background: color-mix(in srgb, var(--danger, #dc2626) 8%, var(--bg-subtle, #f8fafc));
		border: 1px solid color-mix(in srgb, var(--danger, #dc2626) 30%, var(--border, #e5e7eb));
		color: var(--danger, #dc2626);
		border-radius: 8px;
		padding: 12px 16px;
		font-size: 0.875rem;
	}

	/* Sections */
	.info-section {
		background: var(--bg-card, #fff);
		border: 1px solid var(--border, #e5e7eb);
		border-radius: 10px;
		padding: 20px 24px;
		margin-bottom: 16px;
	}

	.section-title {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0 0 16px 0;
	}

	.subsection-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-secondary);
		margin: 20px 0 12px 0;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	/* URL Grid */
	.url-grid {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.url-row {
		display: grid;
		grid-template-columns: 280px 1fr;
		align-items: center;
		gap: 12px;
		padding: 7px 0;
		border-bottom: 1px solid var(--border-subtle, var(--border, #e5e7eb));
	}

	.url-row:last-child {
		border-bottom: none;
	}

	.url-label {
		font-size: 0.8125rem;
		color: var(--text-secondary);
		font-weight: 500;
		white-space: nowrap;
	}

	.url-value-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.url-value {
		font-size: 0.8125rem;
		color: var(--text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
		min-width: 0;
	}

	.url-value.monospace {
		font-family: var(--font-mono, monospace);
	}

	.url-link {
		display: flex;
		align-items: center;
		gap: 4px;
		color: var(--primary, #2563eb);
		text-decoration: none;
	}

	.url-link:hover {
		text-decoration: underline;
	}

	/* Copy Button */
	.copy-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: 1px solid var(--border, #e5e7eb);
		border-radius: 6px;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		flex-shrink: 0;
		transition:
			background 0.15s,
			color 0.15s,
			border-color 0.15s;
	}

	.copy-btn:hover {
		background: var(--bg-subtle, #f8fafc);
		color: var(--text-primary);
	}

	.copy-btn.copied {
		background: color-mix(in srgb, var(--success, #16a34a) 10%, var(--bg-card, #fff));
		border-color: color-mix(in srgb, var(--success, #16a34a) 40%, var(--border, #e5e7eb));
		color: var(--success, #16a34a);
	}

	@media (max-width: 640px) {
		.url-row {
			grid-template-columns: 1fr;
			gap: 4px;
		}

		.url-label {
			font-size: 0.75rem;
		}
	}
</style>
