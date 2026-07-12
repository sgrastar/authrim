<script lang="ts">
	import { onMount } from 'svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { getTenantInfo, type TenantInfo } from '$lib/api/admin-info';
	import {
		adminSettingsAPI,
		type CategoryMetaFull,
		type CategorySettings
	} from '$lib/api/admin-settings';
	import { adminSAMLAPI, type SAMLSettings } from '$lib/api/admin-saml';
	import { parseDiscoveryMethods } from '$lib/admin/tenant-discovery-settings';
	import { LL } from '$i18n/i18n-svelte';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';

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
	let sessionSettings = $state<CategorySettings | null>(null);
	let clientSettingsMeta = $state<CategoryMetaFull | null>(null);
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
			sessionSettings = null;
			clientSettingsMeta = null;
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
		sessionSettings = null;
		clientSettingsMeta = null;
		tenantLoginEntrySettings = null;
		commonLoginEntrySettings = null;
		try {
			const [
				infoResult,
				samlResult,
				sessionResult,
				clientMetaResult,
				tenantLoginEntryResult,
				commonLoginEntryResult
			] = await Promise.all([
				getTenantInfo(tenantId),
				adminSAMLAPI.getSettings().catch(() => null),
				adminSettingsAPI.getSettings('session', tenantId).catch(() => null),
				adminSettingsAPI.getMeta('client').catch(() => null),
				adminSettingsAPI.getSettings('login-entry', tenantId).catch(() => null),
				adminSettingsAPI.getPlatformSettings('login-entry').catch(() => null)
			]);
			info = infoResult;
			samlSettings = samlResult;
			sessionSettings = sessionResult;
			clientSettingsMeta = clientMetaResult;
			tenantLoginEntrySettings = normalizeLoginEntrySettings(tenantLoginEntryResult);
			commonLoginEntrySettings =
				normalizeLoginEntrySettings(commonLoginEntryResult) ?? tenantLoginEntrySettings;
		} catch (e) {
			error = e instanceof Error ? e.message : $LL.admin_info_error_load();
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

	function readNumberSetting(values: Record<string, unknown>, key: string, fallback: number) {
		return typeof values[key] === 'number' && Number.isFinite(values[key]) ? values[key] : fallback;
	}

	function formatDurationMs(value: number) {
		const seconds = Math.floor(value / 1000);
		return formatDurationSeconds(seconds);
	}

	function formatDurationSeconds(seconds: number) {
		const minute = 60;
		const hour = 60 * minute;
		const day = 24 * hour;
		if (seconds % day === 0) return `${seconds / day}d`;
		if (seconds % hour === 0) return `${seconds / hour}h`;
		if (seconds % minute === 0) return `${seconds / minute}m`;
		return `${seconds}s`;
	}

	const refreshTokenTtlInfo = $derived.by(() => {
		const meta = clientSettingsMeta?.settings['client.refresh_token_ttl'];
		if (!meta || typeof meta.default !== 'number') {
			return $LL.admin_info_not_available();
		}
		return `${formatDurationSeconds(meta.default)} ${$LL.admin_info_refresh_token_ttl_per_client()}`;
	});

	function formatSettingSource(source: string | undefined) {
		switch (source) {
			case 'kv':
				return $LL.admin_inheritance_source_kv();
			case 'env':
				return $LL.admin_inheritance_source_environment();
			default:
				return $LL.admin_inheritance_source_default();
		}
	}

	const sessionTtlRows = $derived(
		[
			{
				label: $LL.admin_info_ttl_email_code(),
				key: 'session.ttl.email_code',
				defaultValue: 86400000
			},
			{
				label: $LL.admin_info_ttl_directory_password(),
				key: 'session.ttl.directory_password',
				defaultValue: 86400000
			},
			{
				label: $LL.admin_info_ttl_direct_auth(),
				key: 'session.ttl.direct_auth',
				defaultValue: 86400000
			},
			{
				label: $LL.admin_info_ttl_passkey(),
				key: 'session.ttl.passkey',
				defaultValue: 604800000
			},
			{
				label: $LL.admin_info_ttl_passkey_registration(),
				key: 'session.ttl.passkey_registration',
				defaultValue: 2592000000
			},
			{
				label: $LL.admin_info_ttl_admin_passkey(),
				key: 'session.ttl.admin_passkey',
				defaultValue: 604800000
			},
			{
				label: $LL.admin_info_ttl_anonymous(),
				key: 'session.ttl.anonymous',
				defaultValue: 86400000
			},
			{
				label: $LL.admin_info_ttl_did(),
				key: 'session.ttl.did',
				defaultValue: 86400000
			}
		].map((item) => {
			if (!sessionSettings) {
				return {
					key: item.key,
					label: item.label,
					value: $LL.admin_info_not_available(),
					source: $LL.admin_info_not_available()
				};
			}
			const value = readNumberSetting(sessionSettings?.values ?? {}, item.key, item.defaultValue);
			return {
				key: item.key,
				label: item.label,
				value: formatDurationMs(value),
				source: formatSettingSource(sessionSettings?.sources?.[item.key])
			};
		})
	);

	function formatDiscoveryMethods(methods: string[] | undefined) {
		if (!methods || methods.length === 0) return $LL.admin_info_none_configured();
		return methods
			.map((method) => {
				switch (method) {
					case 'email_domain':
						return $LL.admin_info_method_email_domain();
					case 'tenant_code':
						return $LL.admin_info_method_tenant_code();
					case 'tenant_slug':
						return $LL.admin_info_method_tenant_slug();
					case 'wayf':
						return $LL.admin_info_method_wayf();
					default:
						return method;
				}
			})
			.join(', ');
	}

	function tenantLoginFirstPage() {
		if (!info?.login_ui_url) return $LL.admin_info_not_configured();
		const settings = effectiveTenantLoginEntrySettings;
		if (
			info.discover_url &&
			settings?.mode !== 'tenant_only' &&
			settings?.requireCommonDiscoveryBeforeLogin
		) {
			return $LL.admin_info_tenant_discovery_first({ url: info.login_ui_url });
		}
		return info.login_ui_url;
	}

	function globalLoginFirstPage() {
		if (!info?.global_login_ui_url) return $LL.admin_info_not_configured();
		if (!info.discover_url) return info.global_login_ui_url;
		const settings = commonLoginEntrySettings;
		if (settings?.skipDiscoveryIfOnlyOneTenant) {
			return $LL.admin_info_global_discovery_may_skip({ url: info.discover_url });
		}
		return info.discover_url;
	}

	function samlInteractiveFirstPage() {
		if (!samlSettings) return $LL.admin_info_not_configured();
		const policy = samlSettings.interactiveLoginUrlPolicy;
		if (policy === 'tenant_host') {
			return tenantLoginFirstPage();
		}
		return globalLoginFirstPage();
	}
</script>

<svelte:head>
	<title>{$LL.admin_info_page_title()}</title>
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
				title={$LL.admin_info_copy_title()}
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

<AdminPageShell>
	<AdminPageHeader title={$LL.admin_info_title()} description={$LL.admin_info_description()} />

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch animate-spin w-6 h-6"></i>
			<span>{$LL.admin_info_loading()}</span>
		</div>
	{:else if error}
		<div class="alert alert-error info-alert">
			<i class="i-ph-warning-circle w-5 h-5"></i>
			{error}
		</div>
	{:else if info}
		<!-- Identity -->
		<section class="info-section">
			<h2 class="section-title">
				<i class="i-ph-identification-card w-5 h-5"></i>
				{$LL.admin_info_identity()}
			</h2>
			<div class="url-grid">
				{@render urlRow($LL.admin_info_tenant_id(), info.tenant_id, 'tenant_id', undefined, true)}
				{@render urlRow($LL.admin_info_tenant_name(), info.tenant_name, 'tenant_name')}
				{@render urlRow($LL.admin_info_issuer(), info.issuer, 'issuer', info.issuer)}
				{@render urlRow($LL.admin_info_api_base_url(), info.api_url, 'api_url', info.api_url)}
				{#if info.components.login_ui}
					{@render urlRow(
						$LL.admin_info_builtin_login_ui(),
						$LL.admin_info_deployed(),
						'login_ui_deployment'
					)}
				{:else}
					{@render urlRow(
						$LL.admin_info_builtin_login_ui(),
						$LL.admin_info_not_deployed(),
						'login_ui_deployment'
					)}
				{/if}
				{#if info.login_ui_url}
					{@render urlRow(
						$LL.admin_info_login_url_tenant(),
						info.login_ui_url,
						'login_ui_url',
						info.login_ui_url
					)}
				{:else}
					{@render urlRow(
						$LL.admin_info_login_url_tenant(),
						$LL.admin_info_not_configured(),
						'login_ui_url_status'
					)}
				{/if}
				{@render urlRow(
					$LL.admin_info_tenant_login_first_page(),
					tenantLoginFirstPage(),
					'tenant_login_first_page'
				)}
				{#if info.global_login_ui_url}
					{@render urlRow(
						$LL.admin_info_global_login_url(),
						info.global_login_ui_url,
						'global_login_ui_url',
						info.global_login_ui_url
					)}
				{:else}
					{@render urlRow(
						$LL.admin_info_global_login_url(),
						$LL.admin_info_not_configured(),
						'global_login_ui_url_status'
					)}
				{/if}
				{@render urlRow(
					$LL.admin_info_global_login_first_page(),
					globalLoginFirstPage(),
					'global_login_first_page'
				)}
				{#if info.discover_url}
					{@render urlRow(
						$LL.admin_info_tenant_discovery_url(),
						info.discover_url,
						'discover_url',
						info.discover_url
					)}
				{/if}
				{#if info.components.admin_ui && info.admin_ui_url}
					{@render urlRow(
						$LL.admin_info_admin_ui_url(),
						info.admin_ui_url,
						'admin_ui_url',
						info.admin_ui_url
					)}
				{:else}
					{@render urlRow(
						$LL.admin_info_admin_ui(),
						$LL.admin_info_not_deployed(),
						'admin_ui_status'
					)}
				{/if}
			</div>
		</section>

		<!-- Login Entry / Tenant Discovery -->
		<section class="info-section">
			<h2 class="section-title">
				<i class="i-ph-path w-5 h-5"></i>
				{$LL.admin_info_login_entry_title()}
			</h2>
			<div class="url-grid">
				{@render urlRow(
					$LL.admin_info_tenant_override(),
					tenantLoginEntrySettings?.overrideEnabled
						? $LL.admin_info_enabled()
						: $LL.admin_info_disabled(),
					'login_entry_override'
				)}
				{@render urlRow(
					$LL.admin_info_effective_tenant_mode(),
					effectiveTenantLoginEntrySettings?.mode ?? $LL.admin_info_not_available(),
					'effective_tenant_mode',
					undefined,
					true
				)}
				{@render urlRow(
					$LL.admin_info_effective_tenant_methods(),
					formatDiscoveryMethods(effectiveTenantLoginEntrySettings?.discoveryMethods),
					'effective_tenant_methods'
				)}
				{@render urlRow(
					$LL.admin_info_common_entry_mode(),
					commonLoginEntrySettings?.mode ?? $LL.admin_info_not_available(),
					'common_entry_mode',
					undefined,
					true
				)}
				{@render urlRow(
					$LL.admin_info_common_entry_methods(),
					formatDiscoveryMethods(commonLoginEntrySettings?.discoveryMethods),
					'common_entry_methods'
				)}
				{@render urlRow(
					$LL.admin_info_common_before_tenant(),
					effectiveTenantLoginEntrySettings?.requireCommonDiscoveryBeforeLogin
						? $LL.admin_info_enabled()
						: $LL.admin_info_disabled(),
					'common_before_tenant_login'
				)}
			</div>
		</section>

		<!-- Well-Known / Discovery -->
		<section class="info-section">
			<h2 class="section-title">
				<i class="i-ph-magnifying-glass w-5 h-5"></i>
				{$LL.admin_info_well_known()}
			</h2>
			<div class="url-grid">
				{@render urlRow(
					$LL.admin_info_openid_config(),
					info.well_known.openid_configuration,
					'wk_oidc',
					info.well_known.openid_configuration
				)}
				{@render urlRow(
					$LL.admin_info_oauth_authorization_server(),
					info.well_known.oauth_authorization_server,
					'wk_oauth',
					info.well_known.oauth_authorization_server
				)}
				{@render urlRow(
					$LL.admin_info_jwks(),
					info.well_known.jwks,
					'wk_jwks',
					info.well_known.jwks
				)}
				{@render urlRow(
					$LL.admin_info_webfinger(),
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
				{$LL.admin_info_oidc_oauth_endpoints()}
			</h2>
			<div class="url-grid">
				{@render urlRow($LL.admin_info_authorization(), info.oidc.authorization, 'oidc_auth')}
				{@render urlRow($LL.admin_info_token(), info.oidc.token, 'oidc_token')}
				{@render urlRow($LL.admin_info_userinfo(), info.oidc.userinfo, 'oidc_userinfo')}
				{@render urlRow($LL.admin_info_introspection(), info.oidc.introspection, 'oidc_introspect')}
				{@render urlRow($LL.admin_info_revocation(), info.oidc.revocation, 'oidc_revoke')}
				{@render urlRow($LL.admin_info_end_session(), info.oidc.end_session, 'oidc_endsession')}
			</div>

			<h3 class="subsection-title">{$LL.admin_info_oauth_extensions()}</h3>
			<div class="url-grid">
				{#if info.components.async}
					{@render urlRow(
						$LL.admin_info_device_authorization(),
						info.oauth_extensions.device_authorization,
						'oauth_device'
					)}
				{:else}
					{@render urlRow(
						$LL.admin_info_device_authorization(),
						$LL.admin_info_not_deployed(),
						'oauth_device_status'
					)}
				{/if}
				{@render urlRow(
					$LL.admin_info_par(),
					info.oauth_extensions.pushed_authorization_request,
					'oauth_par'
				)}
				{@render urlRow(
					$LL.admin_info_dcr(),
					info.oauth_extensions.dynamic_client_registration,
					'oauth_dcr'
				)}
			</div>
		</section>

		<!-- Session TTLs -->
		<section class="info-section">
			<div class="section-title-row">
				<h2 class="section-title no-margin">
					<i class="i-ph-clock-countdown w-5 h-5"></i>
					{$LL.admin_info_session_ttl_title()}
				</h2>
				<a href="/admin/settings/session" class="settings-link">
					{$LL.admin_info_session_ttl_settings_link()}
					<i class="i-ph-arrow-right w-4 h-4"></i>
				</a>
			</div>
			<div class="ttl-table" aria-label={$LL.admin_info_session_ttl_title()}>
				<div class="ttl-row ttl-header">
					<span>{$LL.admin_info_ttl_method()}</span>
					<span>{$LL.admin_info_ttl_value()}</span>
					<span>{$LL.admin_info_ttl_source()}</span>
				</div>
				{#each sessionTtlRows as row (row.key)}
					<div class="ttl-row">
						<span>{row.label}</span>
						<span class="monospace">{row.value}</span>
						<span>{row.source}</span>
					</div>
				{/each}
			</div>
		</section>

		<!-- Token TTLs -->
		<section class="info-section">
			<div class="section-title-row">
				<h2 class="section-title no-margin">
					<i class="i-ph-key w-5 h-5"></i>
					{$LL.admin_info_token_ttl_title()}
				</h2>
				<a href="/admin/clients" class="settings-link">
					{$LL.admin_info_refresh_token_ttl_clients_link()}
					<i class="i-ph-arrow-right w-4 h-4"></i>
				</a>
			</div>
			<div class="url-grid">
				{@render urlRow(
					$LL.admin_info_refresh_token_ttl(),
					refreshTokenTtlInfo,
					'refresh_token_ttl'
				)}
			</div>
		</section>

		<!-- CIBA -->
		<section class="info-section">
			<h2 class="section-title">
				<i class="i-ph-device-mobile w-5 h-5"></i>
				{$LL.admin_info_ciba()}
			</h2>
			<div class="url-grid">
				{#if info.components.async}
					{@render urlRow(
						$LL.admin_info_backchannel_auth(),
						info.ciba.backchannel_authentication,
						'ciba_auth'
					)}
				{:else}
					{@render urlRow($LL.admin_info_status(), $LL.admin_info_not_deployed(), 'ciba_status')}
				{/if}
			</div>
		</section>

		<!-- SAML 2.0 -->
		<section class="info-section">
			<h2 class="section-title">
				<i class="i-ph-shield-check w-5 h-5"></i>
				{$LL.admin_info_saml()}
			</h2>
			<div class="url-grid">
				{#if info.components.saml}
					{#if samlSettings}
						{@render urlRow(
							$LL.admin_info_published_idp_entity_id(),
							samlSettings.generated.idpEntityId,
							'saml_idp_entity_id',
							undefined,
							true
						)}
						{@render urlRow(
							$LL.admin_info_published_sp_entity_id(),
							samlSettings.generated.spEntityId,
							'saml_sp_entity_id',
							undefined,
							true
						)}
						{@render urlRow(
							$LL.admin_info_entity_id_style(),
							samlSettings.entityIdStyle,
							'saml_entity_id_style',
							undefined,
							true
						)}
						{@render urlRow(
							$LL.admin_info_interactive_login_redirect(),
							samlSettings.interactiveLoginUrlPolicy === 'tenant_host'
								? $LL.admin_info_tenant_host()
								: $LL.admin_info_ui_base_url(),
							'saml_interactive_login_policy'
						)}
						{@render urlRow(
							$LL.admin_info_saml_first_visible_page(),
							samlInteractiveFirstPage(),
							'saml_first_visible_page'
						)}
					{/if}
					{@render urlRow($LL.admin_info_sso(), info.saml.sso, 'saml_sso')}
					{@render urlRow(
						$LL.admin_info_idp_metadata(),
						info.saml.idp_metadata,
						'saml_idp_metadata',
						info.saml.idp_metadata
					)}
					{@render urlRow(
						$LL.admin_info_sp_metadata(),
						info.saml.sp_metadata ?? info.saml.metadata,
						'saml_sp_metadata',
						info.saml.sp_metadata ?? info.saml.metadata
					)}
					{@render urlRow($LL.admin_info_acs(), info.saml.acs, 'saml_acs')}
					{@render urlRow($LL.admin_info_slo(), info.saml.slo, 'saml_slo')}
				{:else}
					{@render urlRow($LL.admin_info_status(), $LL.admin_info_not_deployed(), 'saml_status')}
				{/if}
			</div>
		</section>

		<!-- Verifiable Credentials -->
		<section class="info-section">
			<h2 class="section-title">
				<i class="i-ph-certificate w-5 h-5"></i>
				{$LL.admin_info_vc()}
			</h2>
			<div class="url-grid">
				{#if info.components.vc}
					{@render urlRow(
						$LL.admin_info_credential_issuer_metadata(),
						info.vc.credential_issuer_metadata,
						'vc_meta',
						info.vc.credential_issuer_metadata
					)}
					{@render urlRow(
						$LL.admin_info_credential_endpoint(),
						info.vc.credential,
						'vc_credential'
					)}
					{@render urlRow($LL.admin_info_batch_credential(), info.vc.batch_credential, 'vc_batch')}
					{@render urlRow(
						$LL.admin_info_deferred_credential(),
						info.vc.deferred_credential,
						'vc_deferred'
					)}
					{@render urlRow($LL.admin_info_vp_token_request(), info.vc.vp_token_request, 'vc_vp')}
				{:else}
					{@render urlRow($LL.admin_info_status(), $LL.admin_info_not_deployed(), 'vc_status')}
				{/if}
			</div>
		</section>

		<!-- SCIM 2.0 -->
		<section class="info-section">
			<h2 class="section-title">
				<i class="i-ph-users-three w-5 h-5"></i>
				{$LL.admin_info_scim()}
			</h2>
			<div class="url-grid">
				{@render urlRow($LL.admin_info_base_url(), info.scim.base, 'scim_base')}
				{@render urlRow($LL.admin_info_users(), info.scim.users, 'scim_users')}
				{@render urlRow($LL.admin_info_groups(), info.scim.groups, 'scim_groups')}
				{@render urlRow(
					$LL.admin_info_service_provider_config(),
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
				{$LL.admin_info_admin_api()}
			</h2>
			<div class="url-grid">
				{@render urlRow($LL.admin_info_base_url(), info.admin_api.base, 'api_base')}
				{@render urlRow($LL.admin_info_users(), info.admin_api.users, 'api_users')}
				{@render urlRow($LL.admin_info_clients(), info.admin_api.clients, 'api_clients')}
				{@render urlRow($LL.admin_info_sessions(), info.admin_api.sessions, 'api_sessions')}
				{@render urlRow($LL.admin_info_audit_logs(), info.admin_api.audit_logs, 'api_audit')}
				{@render urlRow($LL.admin_info_settings(), info.admin_api.settings, 'api_settings')}
				{@render urlRow($LL.admin_info_tenants(), info.admin_api.tenants, 'api_tenants')}
				{@render urlRow(
					$LL.admin_info_schema_settings(),
					info.admin_api.custom_claims,
					'api_claims'
				)}
				{@render urlRow($LL.admin_info_organizations(), info.admin_api.organizations, 'api_orgs')}
				{@render urlRow($LL.admin_info_roles(), info.admin_api.roles, 'api_roles')}
				{@render urlRow($LL.admin_info_webhooks(), info.admin_api.webhooks, 'api_webhooks')}
			</div>
		</section>
	{/if}
</AdminPageShell>

<style>
	.loading-state {
		display: flex;
		align-items: center;
		gap: 10px;
		color: var(--color-text-muted);
		padding: 40px 0;
	}

	.info-alert {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	/* Sections */
	.info-section {
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		padding: 20px 24px;
		margin-bottom: 16px;
	}

	.section-title {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--color-text);
		margin: 0 0 16px 0;
	}

	.section-title.no-margin {
		margin: 0;
	}

	.section-title-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 16px;
	}

	.settings-link {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--color-accent);
		font-size: 0.8125rem;
		font-weight: 600;
		text-decoration: none;
		white-space: nowrap;
	}

	.settings-link:hover {
		text-decoration: underline;
	}

	.subsection-title {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--color-text-muted);
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
		border-bottom: 1px solid var(--color-border);
	}

	.url-row:last-child {
		border-bottom: none;
	}

	.url-label {
		font-size: 0.8125rem;
		color: var(--color-text-muted);
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
		color: var(--color-text);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		flex: 1;
		min-width: 0;
	}

	.url-value.monospace {
		font-family: var(--font-mono);
	}

	.url-link {
		display: flex;
		align-items: center;
		gap: 4px;
		color: var(--color-accent);
		text-decoration: none;
	}

	.url-link:hover {
		text-decoration: underline;
	}

	.ttl-table {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		overflow: hidden;
	}

	.ttl-row {
		display: grid;
		grid-template-columns: minmax(180px, 1fr) 120px 120px;
		gap: 12px;
		align-items: center;
		padding: 9px 12px;
		border-bottom: 1px solid var(--color-border);
		color: var(--color-text);
		font-size: 0.8125rem;
	}

	.ttl-row:last-child {
		border-bottom: none;
	}

	.ttl-header {
		background: var(--color-surface-raised);
		color: var(--color-text-muted);
		font-weight: 600;
	}

	.monospace {
		font-family: var(--font-mono);
	}

	/* Copy Button */
	.copy-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: transparent;
		color: var(--color-text-muted);
		cursor: pointer;
		flex-shrink: 0;
		transition:
			background 0.15s,
			color 0.15s,
			border-color 0.15s;
	}

	.copy-btn:hover {
		background: var(--color-surface-raised);
		color: var(--color-text);
	}

	.copy-btn.copied {
		background: color-mix(in srgb, var(--color-success) 10%, transparent);
		border-color: color-mix(in srgb, var(--color-success) 40%, var(--color-border));
		color: var(--color-success);
	}

	@media (max-width: 640px) {
		.url-row {
			grid-template-columns: 1fr;
			gap: 4px;
		}

		.url-label {
			font-size: 0.75rem;
		}

		.section-title-row {
			align-items: flex-start;
			flex-direction: column;
			gap: 10px;
		}

		.ttl-row {
			grid-template-columns: 1fr;
			gap: 4px;
		}
	}
</style>
