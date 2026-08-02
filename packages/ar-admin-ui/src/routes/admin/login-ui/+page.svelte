<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { getTenantInfo } from '$lib/api/admin-info';
	import { adminClientsAPI, type Client } from '$lib/api/admin-clients';
	import { adminConsentPoliciesAPI } from '$lib/api/admin-consent-policies';
	import {
		adminSettingsAPI,
		adminUiConfigAPI,
		scopedSettingsAPI,
		SettingsConflictError,
		type CategorySettings,
		type CategoryMetaFull,
		type SettingsPatchRequest,
		type ScopeContext
	} from '$lib/api/admin-settings';
	import { ToggleSwitch } from '$lib/components';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import {
		ALL_LOGIN_UI_LOCALES,
		LOGIN_UI_LOCALE_OPTIONS,
		isLoginUILocale,
		resolveEnabledLoginUILocales,
		type LoginUILocale
	} from '$lib/login-ui/locales';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { LL } from '$i18n/i18n-svelte';

	const CATEGORY = 'login-ui';

	// State
	let meta = $state<CategoryMetaFull | null>(null);
	let settings = $state<CategorySettings | null>(null);
	let loading = $state(true);
	let error = $state('');
	let successMessage = $state('');
	let languageError = $state('');
	let languageSuccessMessage = $state('');
	let languageSaving = $state(false);
	let enabledLocales = $state<LoginUILocale[]>([...ALL_LOGIN_UI_LOCALES]);
	let initialEnabledLocales = $state<LoginUILocale[]>([...ALL_LOGIN_UI_LOCALES]);
	let defaultLocale = $state<LoginUILocale>('en');
	let initialDefaultLocale = $state<LoginUILocale>('en');
	let tenantSettings = $state<CategorySettings | null>(null);
	let postLoginSettings = $state<CategorySettings | null>(null);
	let selfServiceSettings = $state<CategorySettings | null>(null);
	let serviceSiteSettings = $state<CategorySettings | null>(null);
	let trustedOriginsInput = $state('');
	let initialTrustedOriginsInput = $state('');
	let trustedOriginsError = $state('');
	let trustedOriginsSuccessMessage = $state('');
	let trustedOriginsSaving = $state(false);
	let postLoginError = $state('');
	let postLoginSuccessMessage = $state('');
	let postLoginSaving = $state(false);
	let serviceSiteFallbackEnabled = $state(false);
	let initialServiceSiteFallbackEnabled = $state(false);
	let serviceSiteError = $state('');
	let serviceSiteSuccessMessage = $state('');
	let serviceSiteSaving = $state(false);
	type PostLoginBehavior = 'home' | 'account' | 'custom_url' | 'app_login';
	type AppLoginClientOption = {
		clientId: string;
		name: string;
		redirectUris: string[];
	};
	let postLoginBehavior = $state<PostLoginBehavior>('home');
	let postLoginRedirectUrl = $state('/');
	let appLoginClientId = $state('');
	let appLoginRedirectUri = $state('');
	let appLoginFinalReturnTo = $state('');
	let appLoginScope = $state('openid profile email');
	let appLoginClientOptions = $state<AppLoginClientOption[]>([]);
	let appLoginClientOptionsError = $state('');
	let accountPageEnabled = $state(false);
	let accountPagePath = $state('/account');
	let initialPostLoginForm = $state<{
		behavior: PostLoginBehavior;
		redirectUrl: string;
		appLoginClientId: string;
		appLoginRedirectUri: string;
		appLoginFinalReturnTo: string;
		appLoginScope: string;
		accountPageEnabled: boolean;
		accountPagePath: string;
	} | null>(null);
	let loginUiAvailable = $state(true);
	let loginUiConfigured = $state(false);
	let loginUiStatusMessage = $state('');

	// Track pending changes
	let scopeContext = $derived(settingsContext.scopeContext as ScopeContext);
	let canEdit = $derived(settingsContext.canEditAtCurrentScope());
	let canEditLoginUiSettings = $derived(canEdit);
	let canEditTrustedOrigins = $derived(canEdit);
	let currentLevel = $derived(settingsContext.currentLevel);

	// Derived: Check if there are unsaved changes
	const hasTrustedOriginsChanges = $derived(trustedOriginsInput !== initialTrustedOriginsInput);
	const hasPostLoginChanges = $derived(
		initialPostLoginForm
			? postLoginBehavior !== initialPostLoginForm.behavior ||
					postLoginRedirectUrl !== initialPostLoginForm.redirectUrl ||
					appLoginClientId !== initialPostLoginForm.appLoginClientId ||
					appLoginRedirectUri !== initialPostLoginForm.appLoginRedirectUri ||
					appLoginFinalReturnTo !== initialPostLoginForm.appLoginFinalReturnTo ||
					appLoginScope !== initialPostLoginForm.appLoginScope ||
					accountPageEnabled !== initialPostLoginForm.accountPageEnabled ||
					accountPagePath !== initialPostLoginForm.accountPagePath
			: false
	);
	const hasServiceSiteChanges = $derived(
		serviceSiteFallbackEnabled !== initialServiceSiteFallbackEnabled
	);
	const hasLanguageChanges = $derived(
		enabledLocales.join(',') !== initialEnabledLocales.join(',') ||
			defaultLocale !== initialDefaultLocale
	);
	const trustedOriginsDraft = $derived.by(() => parseTrustedOriginsDraft(trustedOriginsInput));
	const selectedAppLoginRedirectUris = $derived(
		appLoginClientOptions.find((option) => option.clientId === appLoginClientId)?.redirectUris ?? []
	);
	onMount(async () => {
		await settingsContext.initialize();
		await loadData();
	});

	let prevScopeKey = $state<string | null>(null);

	// Reload when scope changes
	$effect(() => {
		const scopeKey = `${scopeContext.level}:${scopeContext.tenantId}:${scopeContext.clientId}`;
		if (scopeKey === prevScopeKey) return;
		prevScopeKey = scopeKey;
		if (meta) {
			loadData();
		}
	});

	async function loadData() {
		loading = true;
		error = '';
		trustedOriginsError = '';
		postLoginError = '';
		appLoginClientOptionsError = '';
		serviceSiteError = '';
		languageError = '';

		try {
			const selectedTenantId = resolveSelectedTenantId();
			const tenantInfo = await getTenantInfo(selectedTenantId);
			const uiConfigResult = await adminUiConfigAPI.get();
			const tenantSettingsResult = await adminSettingsAPI.getSettings('tenant', selectedTenantId);
			const postLoginSettingsResult = await adminSettingsAPI.getSettings(
				'login-entry',
				selectedTenantId
			);
			const selfServiceSettingsResult = await adminSettingsAPI.getSettings(
				'self-service',
				selectedTenantId
			);
			const serviceSiteSettingsResult = await adminSettingsAPI.getSettings(
				'service-site',
				selectedTenantId
			);
			tenantSettings = tenantSettingsResult;
			postLoginSettings = postLoginSettingsResult;
			selfServiceSettings = selfServiceSettingsResult;
			serviceSiteSettings = serviceSiteSettingsResult;
			postLoginBehavior = readPostLoginBehavior(
				postLoginSettingsResult.values['login-entry.post_login_behavior']
			);
			postLoginRedirectUrl =
				typeof postLoginSettingsResult.values['login-entry.post_login_redirect_url'] === 'string'
					? postLoginSettingsResult.values['login-entry.post_login_redirect_url']
					: '/';
			appLoginClientId =
				typeof postLoginSettingsResult.values['login-entry.app_login_client_id'] === 'string'
					? postLoginSettingsResult.values['login-entry.app_login_client_id']
					: '';
			appLoginRedirectUri =
				typeof postLoginSettingsResult.values['login-entry.app_login_redirect_uri'] === 'string'
					? postLoginSettingsResult.values['login-entry.app_login_redirect_uri']
					: '';
			appLoginFinalReturnTo =
				typeof postLoginSettingsResult.values['login-entry.app_login_final_return_to'] === 'string'
					? postLoginSettingsResult.values['login-entry.app_login_final_return_to']
					: '';
			appLoginScope =
				typeof postLoginSettingsResult.values['login-entry.app_login_scope'] === 'string'
					? postLoginSettingsResult.values['login-entry.app_login_scope']
					: 'openid profile email';
			accountPageEnabled =
				selfServiceSettingsResult.values['self-service.account_page_enabled'] === true;
			accountPagePath =
				typeof selfServiceSettingsResult.values['self-service.account_page_path'] === 'string'
					? selfServiceSettingsResult.values['self-service.account_page_path']
					: '/account';
			initialPostLoginForm = {
				behavior: postLoginBehavior,
				redirectUrl: postLoginRedirectUrl,
				appLoginClientId,
				appLoginRedirectUri,
				appLoginFinalReturnTo,
				appLoginScope,
				accountPageEnabled,
				accountPagePath
			};
			serviceSiteFallbackEnabled =
				serviceSiteSettingsResult.values['service-site.fallback_enabled'] === true;
			initialServiceSiteFallbackEnabled = serviceSiteFallbackEnabled;
			trustedOriginsInput = formatOriginsForEditor(
				tenantSettingsResult.values['tenant.allowed_origins']
			);
			initialTrustedOriginsInput = trustedOriginsInput;
			loginUiAvailable = tenantInfo.components.login_ui;
			loginUiConfigured = !!uiConfigResult.config.baseUrl;
			loginUiStatusMessage = !loginUiAvailable
				? $LL.admin_login_ui_status_not_deployed()
				: loginUiConfigured
					? ''
					: $LL.admin_login_ui_status_not_configured();
			await loadAppLoginClientOptions();

			// Fetch meta
			const metaResult = await adminSettingsAPI.getMeta(CATEGORY);
			meta = metaResult;

			// Fetch settings based on current scope
			let settingsResult: CategorySettings;
			try {
				settingsResult = await scopedSettingsAPI.getSettingsForScope(CATEGORY, scopeContext);
			} catch {
				// Fall back to tenant settings if scope-specific fails
				settingsResult = await adminSettingsAPI.getSettings(CATEGORY);
			}

			settings = settingsResult;
			initializeLanguageSettings(settingsResult);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_login_ui_error_load();
		} finally {
			loading = false;
		}
	}

	function initializeLanguageSettings(settingsResult: CategorySettings) {
		enabledLocales = resolveEnabledLoginUILocales(
			settingsResult.values['login-ui.supported_locales']
		);
		const storedDefault = settingsResult.values['login-ui.default_locale'];
		defaultLocale =
			isLoginUILocale(storedDefault) && enabledLocales.includes(storedDefault)
				? storedDefault
				: (enabledLocales[0] ?? 'en');
		initialEnabledLocales = [...enabledLocales];
		initialDefaultLocale = defaultLocale;
	}

	function toggleLocale(locale: LoginUILocale, enabled: boolean) {
		if (enabled) {
			enabledLocales = ALL_LOGIN_UI_LOCALES.filter(
				(candidate) => candidate === locale || enabledLocales.includes(candidate)
			);
			return;
		}
		if (enabledLocales.length === 1) {
			languageError = $LL.admin_login_ui_language_at_least_one();
			return;
		}
		enabledLocales = enabledLocales.filter((candidate) => candidate !== locale);
		if (defaultLocale === locale) {
			defaultLocale = enabledLocales[0] ?? 'en';
		}
		languageError = '';
	}

	function selectDefaultLocale(locale: LoginUILocale) {
		if (!enabledLocales.includes(locale)) {
			toggleLocale(locale, true);
		}
		defaultLocale = locale;
		languageError = '';
	}

	function selectAllLocales() {
		enabledLocales = [...ALL_LOGIN_UI_LOCALES];
		languageError = '';
	}

	function clearAllLocalesExceptDefault() {
		enabledLocales = [defaultLocale];
		languageError = '';
	}

	function discardLanguageChanges() {
		enabledLocales = [...initialEnabledLocales];
		defaultLocale = initialDefaultLocale;
		languageError = '';
	}

	async function saveLanguageSettings() {
		if (!settings || !canEditLoginUiSettings) return;
		languageSaving = true;
		languageError = '';
		languageSuccessMessage = '';
		try {
			await scopedSettingsAPI.updateSettingsForScope(CATEGORY, scopeContext, {
				ifMatch: settings.version,
				set: {
					'login-ui.supported_locales': enabledLocales.join(','),
					'login-ui.default_locale': defaultLocale
				}
			});
			languageSuccessMessage = $LL.admin_login_ui_language_updated();
			await loadData();
			setTimeout(() => {
				languageSuccessMessage = '';
			}, 3000);
		} catch (err) {
			languageError =
				err instanceof SettingsConflictError
					? $LL.admin_login_ui_settings_conflict()
					: err instanceof Error
						? err.message
						: $LL.admin_login_ui_language_error_save();
		} finally {
			languageSaving = false;
		}
	}

	function resolveSelectedTenantId(): string {
		const selectedTenantId =
			scopeContext.tenantId?.trim() ||
			settingsContext.current.tenantId?.trim() ||
			settingsContext.availableTenants[0]?.id?.trim();
		if (!selectedTenantId) {
			throw new Error($LL.admin_login_ui_error_tenant_required());
		}
		return selectedTenantId;
	}

	function readPostLoginBehavior(value: unknown): PostLoginBehavior {
		return value === 'account' ||
			value === 'custom_url' ||
			value === 'app_login' ||
			value === 'home'
			? value
			: 'home';
	}

	async function loadAppLoginClientOptions() {
		appLoginClientOptionsError = '';
		try {
			const [clientsResult, trustResult] = await Promise.all([
				adminClientsAPI.list({ limit: 100 }),
				adminConsentPoliciesAPI.listClientTrustPolicies()
			]);
			const firstPartyClientIds = new Set(
				trustResult.policies
					.filter(
						(policy) =>
							policy.target_type === 'oidc_client' &&
							policy.first_party === 1 &&
							policy.is_active === 1
					)
					.map((policy) => policy.target_id)
			);
			const candidates = await Promise.all(
				clientsResult.clients.map(async (client: Client): Promise<AppLoginClientOption | null> => {
					try {
						const clientSettings = await scopedSettingsAPI.getClientSettings(
							client.client_id,
							'client'
						);
						if (
							!firstPartyClientIds.has(client.client_id) ||
							clientSettings.values['client.app_login_enabled'] !== true
						) {
							return null;
						}
						return {
							clientId: client.client_id,
							name: client.client_name,
							redirectUris: Array.isArray(client.redirect_uris) ? client.redirect_uris : []
						};
					} catch {
						return null;
					}
				})
			);
			appLoginClientOptions = candidates.filter(
				(candidate): candidate is AppLoginClientOption => candidate !== null
			);
		} catch (err) {
			appLoginClientOptions = [];
			appLoginClientOptionsError =
				err instanceof Error ? err.message : $LL.admin_login_ui_app_login_clients_error();
		}
	}

	function formatOriginsForEditor(value: unknown): string {
		if (typeof value !== 'string' || !value.trim()) return '';
		return value
			.split(',')
			.map((origin) => origin.trim())
			.filter((origin) => origin.length > 0)
			.join('\n');
	}

	function isLocalHost(hostname: string): boolean {
		return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
	}

	function normalizeTrustedOriginEntry(value: string): string {
		const trimmed = value.trim().replace(/\/$/, '');
		if (!trimmed) {
			throw new Error($LL.admin_login_ui_error_origin_empty());
		}

		// Admin UI exposes web_origin_registry semantics; the current backend stores
		// these entries in tenant allowed origins until rp_origin_registry exists.
		if (trimmed.includes('*')) {
			if (
				!/^https:\/\/\*\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?$/i.test(
					trimmed
				)
			) {
				throw new Error($LL.admin_login_ui_error_wildcard_origin({ origin: value }));
			}
			return trimmed;
		}

		let parsed: URL;
		try {
			parsed = new URL(trimmed);
		} catch {
			throw new Error($LL.admin_login_ui_error_origin_invalid({ origin: value }));
		}

		if (
			parsed.protocol !== 'https:' &&
			!(parsed.protocol === 'http:' && isLocalHost(parsed.hostname))
		) {
			throw new Error($LL.admin_login_ui_error_origin_https({ origin: value }));
		}

		if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
			throw new Error($LL.admin_login_ui_error_origin_path({ origin: value }));
		}

		return parsed.origin;
	}

	function normalizeTrustedOriginsInput(value: string): string[] {
		const uniqueOrigins = new SvelteSet<string>();

		for (const rawEntry of value.split(/[\n,]/)) {
			const trimmed = rawEntry.trim();
			if (!trimmed) continue;
			uniqueOrigins.add(normalizeTrustedOriginEntry(trimmed));
		}

		return Array.from(uniqueOrigins);
	}

	function parseTrustedOriginsDraft(value: string): { origins: string[]; error: string } {
		try {
			return {
				origins: normalizeTrustedOriginsInput(value),
				error: ''
			};
		} catch (err) {
			return {
				origins: [],
				error:
					err instanceof Error ? err.message : $LL.admin_login_ui_error_invalid_trusted_origins()
			};
		}
	}

	function discardTrustedOriginsChanges() {
		trustedOriginsInput = initialTrustedOriginsInput;
		trustedOriginsError = '';
	}

	function selectPostLoginBehavior(value: PostLoginBehavior) {
		postLoginBehavior = value;
		if (value === 'account') {
			accountPageEnabled = true;
		}
	}

	function selectAppLoginClient(clientId: string) {
		appLoginClientId = clientId;
		const selected = appLoginClientOptions.find((client) => client.clientId === clientId);
		if (selected?.redirectUris.length && !selected.redirectUris.includes(appLoginRedirectUri)) {
			appLoginRedirectUri = selected.redirectUris[0] ?? '';
		}
	}

	function discardPostLoginChanges() {
		if (!initialPostLoginForm) return;
		postLoginBehavior = initialPostLoginForm.behavior;
		postLoginRedirectUrl = initialPostLoginForm.redirectUrl;
		appLoginClientId = initialPostLoginForm.appLoginClientId;
		appLoginRedirectUri = initialPostLoginForm.appLoginRedirectUri;
		appLoginFinalReturnTo = initialPostLoginForm.appLoginFinalReturnTo;
		appLoginScope = initialPostLoginForm.appLoginScope;
		accountPageEnabled = initialPostLoginForm.accountPageEnabled;
		accountPagePath = initialPostLoginForm.accountPagePath;
		postLoginError = '';
	}

	function discardServiceSiteChanges() {
		serviceSiteFallbackEnabled = initialServiceSiteFallbackEnabled;
		serviceSiteError = '';
	}

	function buildPostLoginPatch(): Omit<SettingsPatchRequest, 'ifMatch'> {
		const set: Record<string, unknown> = {};
		if (!initialPostLoginForm || postLoginBehavior !== initialPostLoginForm.behavior) {
			set['login-entry.post_login_behavior'] = postLoginBehavior;
		}
		if (!initialPostLoginForm || postLoginRedirectUrl !== initialPostLoginForm.redirectUrl) {
			set['login-entry.post_login_redirect_url'] = postLoginRedirectUrl.trim();
		}
		if (!initialPostLoginForm || appLoginClientId !== initialPostLoginForm.appLoginClientId) {
			set['login-entry.app_login_client_id'] = appLoginClientId.trim();
		}
		if (!initialPostLoginForm || appLoginRedirectUri !== initialPostLoginForm.appLoginRedirectUri) {
			set['login-entry.app_login_redirect_uri'] = appLoginRedirectUri.trim();
		}
		if (
			!initialPostLoginForm ||
			appLoginFinalReturnTo !== initialPostLoginForm.appLoginFinalReturnTo
		) {
			set['login-entry.app_login_final_return_to'] = appLoginFinalReturnTo.trim();
		}
		if (!initialPostLoginForm || appLoginScope !== initialPostLoginForm.appLoginScope) {
			set['login-entry.app_login_scope'] = appLoginScope.trim();
		}
		return Object.keys(set).length > 0 ? { set } : {};
	}

	function buildSelfServicePatch(): Omit<SettingsPatchRequest, 'ifMatch'> {
		const finalAccountPageEnabled = postLoginBehavior === 'account' ? true : accountPageEnabled;
		const set: Record<string, unknown> = {};
		if (
			!initialPostLoginForm ||
			finalAccountPageEnabled !== initialPostLoginForm.accountPageEnabled
		) {
			set['self-service.account_page_enabled'] = finalAccountPageEnabled;
		}
		if (!initialPostLoginForm || accountPagePath !== initialPostLoginForm.accountPagePath) {
			set['self-service.account_page_path'] = accountPagePath.trim();
		}
		return Object.keys(set).length > 0 ? { set } : {};
	}

	function hasPatchChanges(patch: Omit<SettingsPatchRequest, 'ifMatch'>): boolean {
		return !!patch.set || !!patch.clear || !!patch.disable;
	}

	async function savePostLoginSettings() {
		if (!postLoginSettings || !selfServiceSettings) return;
		if (!canEditLoginUiSettings) {
			postLoginError = $LL.admin_login_ui_error_no_settings_permission();
			return;
		}

		if (postLoginBehavior === 'account' && !accountPageEnabled) {
			postLoginError = $LL.admin_login_ui_account_page_required();
			return;
		}
		if (
			postLoginBehavior === 'app_login' &&
			(!appLoginClientId.trim() || !appLoginRedirectUri.trim() || !appLoginScope.trim())
		) {
			postLoginError = $LL.admin_login_ui_app_login_required();
			return;
		}

		postLoginSaving = true;
		postLoginError = '';
		postLoginSuccessMessage = '';

		const postLoginPatch = buildPostLoginPatch();
		const selfServicePatch = buildSelfServicePatch();

		try {
			if (postLoginBehavior === 'account') {
				if (hasPatchChanges(selfServicePatch)) {
					await adminSettingsAPI.updateSettings(
						'self-service',
						{ ifMatch: selfServiceSettings.version, ...selfServicePatch },
						resolveSelectedTenantId()
					);
				}
				if (hasPatchChanges(postLoginPatch)) {
					await adminSettingsAPI.updateSettings(
						'login-entry',
						{ ifMatch: postLoginSettings.version, ...postLoginPatch },
						resolveSelectedTenantId()
					);
				}
			} else {
				if (hasPatchChanges(postLoginPatch)) {
					await adminSettingsAPI.updateSettings(
						'login-entry',
						{ ifMatch: postLoginSettings.version, ...postLoginPatch },
						resolveSelectedTenantId()
					);
				}
				if (hasPatchChanges(selfServicePatch)) {
					await adminSettingsAPI.updateSettings(
						'self-service',
						{ ifMatch: selfServiceSettings.version, ...selfServicePatch },
						resolveSelectedTenantId()
					);
				}
			}

			postLoginSuccessMessage = $LL.admin_login_ui_post_login_updated();
			await loadData();
			setTimeout(() => {
				postLoginSuccessMessage = '';
			}, 3000);
		} catch (err) {
			if (err instanceof SettingsConflictError) {
				postLoginError = $LL.admin_login_ui_settings_conflict();
			} else {
				postLoginError =
					err instanceof Error ? err.message : $LL.admin_login_ui_error_save_post_login();
			}
		} finally {
			postLoginSaving = false;
		}
	}

	async function saveServiceSiteSettings() {
		if (!serviceSiteSettings) return;
		if (!canEditLoginUiSettings) {
			serviceSiteError = $LL.admin_login_ui_error_no_settings_permission();
			return;
		}

		serviceSiteSaving = true;
		serviceSiteError = '';
		serviceSiteSuccessMessage = '';

		try {
			await adminSettingsAPI.updateSettings(
				'service-site',
				{
					ifMatch: serviceSiteSettings.version,
					set: { 'service-site.fallback_enabled': serviceSiteFallbackEnabled }
				},
				resolveSelectedTenantId()
			);

			serviceSiteSuccessMessage = $LL.admin_login_ui_service_site_updated();
			await loadData();
			setTimeout(() => {
				serviceSiteSuccessMessage = '';
			}, 3000);
		} catch (err) {
			if (err instanceof SettingsConflictError) {
				serviceSiteError = $LL.admin_login_ui_settings_conflict();
			} else {
				serviceSiteError =
					err instanceof Error ? err.message : $LL.admin_login_ui_error_save_service_site();
			}
		} finally {
			serviceSiteSaving = false;
		}
	}

	async function saveTrustedOrigins() {
		if (!tenantSettings) return;
		if (!canEditTrustedOrigins) {
			trustedOriginsError = $LL.admin_login_ui_error_no_trusted_origin_permission();
			return;
		}

		const parsed = parseTrustedOriginsDraft(trustedOriginsInput);
		if (parsed.error) {
			trustedOriginsError = parsed.error;
			return;
		}

		trustedOriginsSaving = true;
		trustedOriginsError = '';
		trustedOriginsSuccessMessage = '';

		try {
			const request =
				parsed.origins.length > 0
					? {
							ifMatch: tenantSettings.version,
							set: { 'tenant.allowed_origins': parsed.origins.join(',') }
						}
					: {
							ifMatch: tenantSettings.version,
							clear: ['tenant.allowed_origins']
						};

			await adminSettingsAPI.updateSettings('tenant', request, resolveSelectedTenantId());

			trustedOriginsSuccessMessage = $LL.admin_login_ui_trusted_origins_updated();
			await loadData();
			setTimeout(() => {
				trustedOriginsSuccessMessage = '';
			}, 3000);
		} catch (err) {
			if (err instanceof SettingsConflictError) {
				trustedOriginsError = $LL.admin_login_ui_trusted_origins_conflict();
			} else {
				trustedOriginsError =
					err instanceof Error ? err.message : $LL.admin_login_ui_error_update_trusted_origins();
			}
		} finally {
			trustedOriginsSaving = false;
		}
	}

	// Save changes
</script>

<svelte:head>
	<title>{$LL.admin_login_ui_page_title()}</title>
</svelte:head>

{#snippet titleAccessory()}
	<span class="scope-badge {currentLevel}">
		{currentLevel === 'platform'
			? $LL.admin_login_ui_scope_platform()
			: currentLevel === 'tenant'
				? $LL.admin_login_ui_scope_tenant()
				: $LL.admin_login_ui_scope_client()}
	</span>
	{#if !canEditLoginUiSettings}
		<span class="readonly-badge">{$LL.admin_login_ui_readonly()}</span>
	{/if}
{/snippet}

<AdminPageShell>
	<div class="settings-detail-page">
		<AdminPageHeader
			title={$LL.admin_login_ui_title()}
			description={$LL.admin_login_ui_description()}
			{titleAccessory}
		/>

		{#if !loginUiAvailable && !loading}
			<div class="alert alert-warning">
				{loginUiStatusMessage}
			</div>
		{:else if !loginUiConfigured && !loading}
			<div class="alert alert-warning">
				{loginUiStatusMessage}
			</div>
		{/if}

		{#if trustedOriginsError}
			<div class="alert alert-error">{trustedOriginsError}</div>
		{/if}

		{#if trustedOriginsSuccessMessage}
			<div class="alert alert-success">{trustedOriginsSuccessMessage}</div>
		{/if}

		{#if postLoginError}
			<div class="alert alert-error">
				{postLoginError}
				{#if postLoginError === $LL.admin_login_ui_account_page_required()}
					<a class="alert-link" href="#post-login">{$LL.admin_login_ui_post_login_link()}</a>
				{/if}
			</div>
		{/if}

		{#if postLoginSuccessMessage}
			<div class="alert alert-success">{postLoginSuccessMessage}</div>
		{/if}

		{#if serviceSiteError}
			<div class="alert alert-error">{serviceSiteError}</div>
		{/if}

		{#if serviceSiteSuccessMessage}
			<div class="alert alert-success">{serviceSiteSuccessMessage}</div>
		{/if}

		{#if languageError}
			<div class="alert alert-error">{languageError}</div>
		{/if}

		{#if languageSuccessMessage}
			<div class="alert alert-success">{languageSuccessMessage}</div>
		{/if}

		{#if !loading && settings}
			<section class="panel language-settings-panel">
				<div class="section-header">
					<div>
						<h2 class="section-title">{$LL.admin_login_ui_language_title()}</h2>
						<p class="section-description">
							{$LL.admin_login_ui_language_description()}
						</p>
					</div>
					<span class="config-source-badge">
						{$LL.admin_login_ui_language_enabled_count({ count: enabledLocales.length })}
					</span>
				</div>

				<div class="language-grid-toolbar">
					<button
						type="button"
						class="btn btn-secondary language-bulk-button"
						onclick={selectAllLocales}
						disabled={!canEditLoginUiSettings ||
							enabledLocales.length === ALL_LOGIN_UI_LOCALES.length}
					>
						{$LL.admin_login_ui_language_select_all()}
					</button>
					<button
						type="button"
						class="btn btn-secondary language-bulk-button"
						onclick={clearAllLocalesExceptDefault}
						disabled={!canEditLoginUiSettings ||
							(enabledLocales.length === 1 && enabledLocales[0] === defaultLocale)}
					>
						{$LL.admin_login_ui_language_clear_all()}
					</button>
				</div>

				<div class="language-grid" aria-label={$LL.admin_login_ui_language_list_label()}>
					{#each LOGIN_UI_LOCALE_OPTIONS as locale (locale.code)}
						<div class="language-option" class:default={defaultLocale === locale.code}>
							<label
								class="language-control"
								title={$LL.admin_login_ui_language_enable({ language: locale.label })}
							>
								<input
									type="checkbox"
									checked={enabledLocales.includes(locale.code)}
									disabled={!canEditLoginUiSettings}
									onchange={(event) => toggleLocale(locale.code, event.currentTarget.checked)}
								/>
								<span class="sr-only">
									{$LL.admin_login_ui_language_enable({ language: locale.label })}
								</span>
							</label>
							<label
								class="language-control"
								title={$LL.admin_login_ui_language_make_default({ language: locale.label })}
							>
								<input
									type="radio"
									name="login-ui-default-locale"
									checked={defaultLocale === locale.code}
									disabled={!canEditLoginUiSettings || !enabledLocales.includes(locale.code)}
									onchange={() => selectDefaultLocale(locale.code)}
								/>
								<span class="sr-only">
									{$LL.admin_login_ui_language_make_default({ language: locale.label })}
								</span>
							</label>
							<span class="language-name">
								{locale.label}{#if defaultLocale === locale.code}<span
										class="default-language-label"
										>({$LL.admin_login_ui_language_default_label()})</span
									>{/if}
							</span>
						</div>
					{/each}
				</div>

				<p class="language-help">{$LL.admin_login_ui_language_help()}</p>

				<div class="form-actions">
					<span class="cache-notice">{$LL.admin_login_ui_cache_notice()}</span>
					<button
						type="button"
						onclick={discardLanguageChanges}
						disabled={!hasLanguageChanges || languageSaving || !canEditLoginUiSettings}
						class="btn btn-secondary"
					>
						{$LL.admin_login_ui_discard_changes()}
					</button>
					<button
						type="button"
						onclick={saveLanguageSettings}
						disabled={!hasLanguageChanges || languageSaving || !canEditLoginUiSettings}
						class="btn btn-primary"
					>
						{languageSaving ? $LL.admin_login_ui_saving() : $LL.admin_login_ui_language_save()}
					</button>
				</div>
			</section>
		{/if}

		{#if !loading && tenantSettings}
			<section class="panel">
				<div class="section-header">
					<div>
						<h2 class="section-title">{$LL.admin_login_ui_trusted_origins_title()}</h2>
						<p class="section-description">
							{$LL.admin_login_ui_trusted_origins_description()}
						</p>
					</div>
					<span class="config-source-badge">{$LL.admin_login_ui_tenant_setting()}</span>
				</div>

				<div class="textarea-setting" class:modified={hasTrustedOriginsChanges}>
					<div class="setting-label-row">
						<label for="trusted-origins" class="setting-label"
							>{$LL.admin_login_ui_allowed_browser_origins()}</label
						>
						{#if hasTrustedOriginsChanges}
							<span class="setting-modified">{$LL.admin_login_ui_modified()}</span>
						{/if}
					</div>
					<p class="setting-description">
						{$LL.admin_login_ui_allowed_browser_origins_description()}
					</p>
					<textarea
						id="trusted-origins"
						class="settings-textarea"
						rows="6"
						disabled={!canEditTrustedOrigins}
						placeholder="https://first.multi-tenant.authrim.com\nhttps://*.example.com"
						value={trustedOriginsInput}
						oninput={(e) => {
							trustedOriginsInput = e.currentTarget.value;
						}}
					></textarea>
					<p class="settings-range-hint">
						{$LL.admin_login_ui_allowed_browser_origins_hint()}
					</p>
					{#if trustedOriginsDraft.error}
						<p class="trusted-origins-validation">{trustedOriginsDraft.error}</p>
					{/if}
				</div>

				{#if trustedOriginsDraft.origins.length > 0}
					<div class="trusted-origins-preview">
						<p class="trusted-origins-preview-label">{$LL.admin_login_ui_normalized_entries()}</p>
						<div class="trusted-origins-list">
							{#each trustedOriginsDraft.origins as origin (origin)}
								<span class="trusted-origin-chip">{origin}</span>
							{/each}
						</div>
					</div>
				{/if}

				<div class="form-actions">
					<button
						onclick={discardTrustedOriginsChanges}
						disabled={!hasTrustedOriginsChanges || trustedOriginsSaving || !canEditTrustedOrigins}
						class="btn btn-secondary"
					>
						{$LL.admin_login_ui_discard_changes()}
					</button>
					<button
						onclick={saveTrustedOrigins}
						disabled={!hasTrustedOriginsChanges ||
							trustedOriginsSaving ||
							!canEditTrustedOrigins ||
							Boolean(trustedOriginsDraft.error)}
						class="btn btn-primary"
					>
						{trustedOriginsSaving
							? $LL.admin_login_ui_saving()
							: $LL.admin_login_ui_save_trusted_origins()}
					</button>
				</div>
			</section>
		{/if}

		{#if !loading && postLoginSettings && selfServiceSettings}
			<section class="panel" id="post-login">
				<div class="section-header">
					<div>
						<h2 class="section-title">{$LL.admin_login_ui_post_login_title()}</h2>
						<p class="section-description">
							{$LL.admin_login_ui_post_login_description()}
						</p>
					</div>
					<span class="config-source-badge">{$LL.admin_login_ui_tenant_setting()}</span>
				</div>

				<div class="settings-form-card">
					<div class="setting-item" class:modified={hasPostLoginChanges}>
						<div class="setting-item-content">
							<div class="setting-info">
								<div class="setting-label-row">
									<span class="setting-label">{$LL.admin_login_ui_post_login_behavior()}</span>
									{#if hasPostLoginChanges}
										<span class="setting-modified">{$LL.admin_login_ui_modified()}</span>
									{/if}
								</div>
								<p class="setting-description">
									{$LL.admin_login_ui_post_login_behavior_description()}
								</p>
							</div>

							<div class="setting-control wide">
								<div class="radio-card-group">
									<label class="radio-card" class:selected={postLoginBehavior === 'home'}>
										<input
											type="radio"
											name="post-login-behavior"
											value="home"
											checked={postLoginBehavior === 'home'}
											disabled={!canEditLoginUiSettings}
											onchange={() => selectPostLoginBehavior('home')}
										/>
										<span>
											<strong>{$LL.admin_login_ui_post_login_home()}</strong>
											<small>{$LL.admin_login_ui_post_login_home_desc()}</small>
										</span>
									</label>
									<label class="radio-card" class:selected={postLoginBehavior === 'account'}>
										<input
											type="radio"
											name="post-login-behavior"
											value="account"
											checked={postLoginBehavior === 'account'}
											disabled={!canEditLoginUiSettings}
											onchange={() => selectPostLoginBehavior('account')}
										/>
										<span>
											<strong>{$LL.admin_login_ui_post_login_account()}</strong>
											<small>{$LL.admin_login_ui_post_login_account_desc()}</small>
										</span>
									</label>
									<label class="radio-card" class:selected={postLoginBehavior === 'custom_url'}>
										<input
											type="radio"
											name="post-login-behavior"
											value="custom_url"
											checked={postLoginBehavior === 'custom_url'}
											disabled={!canEditLoginUiSettings}
											onchange={() => selectPostLoginBehavior('custom_url')}
										/>
										<span>
											<strong>{$LL.admin_login_ui_post_login_custom()}</strong>
											<small>{$LL.admin_login_ui_post_login_custom_desc()}</small>
										</span>
									</label>
									<label class="radio-card" class:selected={postLoginBehavior === 'app_login'}>
										<input
											type="radio"
											name="post-login-behavior"
											value="app_login"
											checked={postLoginBehavior === 'app_login'}
											disabled={!canEditLoginUiSettings}
											onchange={() => selectPostLoginBehavior('app_login')}
										/>
										<span>
											<strong>{$LL.admin_login_ui_post_login_app_login()}</strong>
											<small>{$LL.admin_login_ui_post_login_app_login_desc()}</small>
										</span>
									</label>
								</div>
							</div>
						</div>
					</div>

					<div class="setting-item" class:modified={hasPostLoginChanges}>
						<div class="setting-item-content">
							<div class="setting-info">
								<label for="post-login-redirect-url" class="setting-label"
									>{$LL.admin_login_ui_post_login_redirect_url()}</label
								>
								<p class="setting-description">
									{$LL.admin_login_ui_post_login_redirect_url_description()}
									<a href="/admin/settings/security#security.trusted_redirect_origins">
										{$LL.admin_login_ui_trusted_redirect_origins_link()}
									</a>
								</p>
							</div>

							<div class="setting-control">
								<input
									type="text"
									id="post-login-redirect-url"
									value={postLoginRedirectUrl}
									disabled={!canEditLoginUiSettings || postLoginBehavior !== 'custom_url'}
									placeholder="/mypage"
									oninput={(e) => {
										postLoginRedirectUrl = e.currentTarget.value;
									}}
									class="settings-input"
								/>
							</div>
						</div>
					</div>

					{#if postLoginBehavior === 'app_login'}
						<div class="setting-item" class:modified={hasPostLoginChanges}>
							<div class="setting-item-content">
								<div class="setting-info">
									<label for="app-login-client-id" class="setting-label"
										>{$LL.admin_login_ui_app_login_client()}</label
									>
									<p class="setting-description">
										{$LL.admin_login_ui_app_login_client_description()}
										{#if appLoginClientId}
											<a href={`/admin/clients/${encodeURIComponent(appLoginClientId)}`}>
												{$LL.admin_login_ui_app_login_client_link()}
											</a>
										{/if}
									</p>
									{#if appLoginClientOptionsError}
										<p class="setting-description error-text">{appLoginClientOptionsError}</p>
									{/if}
								</div>

								<div class="setting-control">
									<select
										id="app-login-client-id"
										class="settings-input"
										value={appLoginClientId}
										disabled={!canEditLoginUiSettings}
										onchange={(e) => selectAppLoginClient(e.currentTarget.value)}
									>
										<option value="">{$LL.admin_login_ui_app_login_client_placeholder()}</option>
										{#each appLoginClientOptions as option (option.clientId)}
											<option value={option.clientId}>{option.name} ({option.clientId})</option>
										{/each}
									</select>
									<input
										type="text"
										value={appLoginClientId}
										disabled={!canEditLoginUiSettings}
										placeholder="service-web"
										oninput={(e) => {
											appLoginClientId = e.currentTarget.value;
										}}
										class="settings-input stacked-input"
									/>
								</div>
							</div>
						</div>

						<div class="setting-item" class:modified={hasPostLoginChanges}>
							<div class="setting-item-content">
								<div class="setting-info">
									<label for="app-login-redirect-uri" class="setting-label"
										>{$LL.admin_login_ui_app_login_redirect_uri()}</label
									>
									<p class="setting-description">
										{$LL.admin_login_ui_app_login_redirect_uri_description()}
									</p>
								</div>

								<div class="setting-control">
									<input
										type="url"
										id="app-login-redirect-uri"
										value={appLoginRedirectUri}
										disabled={!canEditLoginUiSettings}
										placeholder="https://service.example/callback"
										list="app-login-redirect-uri-options"
										oninput={(e) => {
											appLoginRedirectUri = e.currentTarget.value;
										}}
										class="settings-input"
									/>
									<datalist id="app-login-redirect-uri-options">
										{#each selectedAppLoginRedirectUris as redirectUri (redirectUri)}
											<option value={redirectUri}></option>
										{/each}
									</datalist>
								</div>
							</div>
						</div>

						<div class="setting-item" class:modified={hasPostLoginChanges}>
							<div class="setting-item-content">
								<div class="setting-info">
									<label for="app-login-scope" class="setting-label"
										>{$LL.admin_login_ui_app_login_scope()}</label
									>
									<p class="setting-description">
										{$LL.admin_login_ui_app_login_scope_description()}
									</p>
								</div>

								<div class="setting-control">
									<input
										type="text"
										id="app-login-scope"
										value={appLoginScope}
										disabled={!canEditLoginUiSettings}
										placeholder="openid profile email"
										oninput={(e) => {
											appLoginScope = e.currentTarget.value;
										}}
										class="settings-input"
									/>
								</div>
							</div>
						</div>

						<div class="setting-item" class:modified={hasPostLoginChanges}>
							<div class="setting-item-content">
								<div class="setting-info">
									<label for="app-login-final-return-to" class="setting-label"
										>{$LL.admin_login_ui_app_login_final_return_to()}</label
									>
									<p class="setting-description">
										{$LL.admin_login_ui_app_login_final_return_to_description()}
										<a href="/admin/settings/security#security.trusted_redirect_origins">
											{$LL.admin_login_ui_trusted_redirect_origins_link()}
										</a>
									</p>
								</div>

								<div class="setting-control">
									<input
										type="text"
										id="app-login-final-return-to"
										value={appLoginFinalReturnTo}
										disabled={!canEditLoginUiSettings}
										placeholder="/mypage"
										oninput={(e) => {
											appLoginFinalReturnTo = e.currentTarget.value;
										}}
										class="settings-input"
									/>
								</div>
							</div>
						</div>
					{/if}

					<div class="setting-item" class:modified={hasPostLoginChanges}>
						<div class="setting-item-content">
							<div class="setting-info">
								<label for="account-page-enabled" class="setting-label"
									>{$LL.admin_login_ui_account_page_enabled()}</label
								>
								<p class="setting-description">
									{$LL.admin_login_ui_account_page_enabled_description()}
									{#if postLoginBehavior === 'account'}
										<span class="inline-note">{$LL.admin_login_ui_account_page_forced_on()}</span>
									{/if}
								</p>
							</div>

							<div class="setting-control">
								<ToggleSwitch
									checked={postLoginBehavior === 'account' ? true : accountPageEnabled}
									disabled={!canEditLoginUiSettings || postLoginBehavior === 'account'}
									id="account-page-enabled"
									onchange={(newValue) => {
										accountPageEnabled = newValue;
									}}
								/>
							</div>
						</div>
					</div>

					<div class="setting-item" class:modified={hasPostLoginChanges}>
						<div class="setting-item-content">
							<div class="setting-info">
								<label for="account-page-path" class="setting-label"
									>{$LL.admin_login_ui_account_page_path()}</label
								>
								<p class="setting-description">
									{$LL.admin_login_ui_account_page_path_description()}
								</p>
							</div>

							<div class="setting-control">
								<input
									type="text"
									id="account-page-path"
									value={accountPagePath}
									disabled={!canEditLoginUiSettings}
									placeholder="/account"
									oninput={(e) => {
										accountPagePath = e.currentTarget.value;
									}}
									class="settings-input"
								/>
							</div>
						</div>
					</div>
				</div>

				<div class="form-actions">
					<span class="cache-notice">{$LL.admin_login_ui_cache_notice()}</span>
					<button
						onclick={discardPostLoginChanges}
						disabled={!hasPostLoginChanges || postLoginSaving || !canEditLoginUiSettings}
						class="btn btn-secondary"
					>
						{$LL.admin_login_ui_discard_changes()}
					</button>
					<button
						onclick={savePostLoginSettings}
						disabled={!hasPostLoginChanges || postLoginSaving || !canEditLoginUiSettings}
						class="btn btn-primary"
					>
						{postLoginSaving ? $LL.admin_login_ui_saving() : $LL.admin_login_ui_save_post_login()}
					</button>
				</div>
			</section>
		{/if}

		{#if !loading && serviceSiteSettings}
			<section class="panel" id="service-site-fallback">
				<div class="section-header">
					<div>
						<h2 class="section-title">{$LL.admin_login_ui_service_site_title()}</h2>
						<p class="section-description">
							{$LL.admin_login_ui_service_site_description()}
						</p>
					</div>
					<span class="config-source-badge">{$LL.admin_login_ui_tenant_setting()}</span>
				</div>

				<div class="settings-form-card">
					<div class="setting-item" class:modified={hasServiceSiteChanges}>
						<div class="setting-item-content">
							<div class="setting-info">
								<div class="setting-label-row">
									<label for="service-site-fallback-enabled" class="setting-label"
										>{$LL.admin_login_ui_service_site_enabled()}</label
									>
									{#if hasServiceSiteChanges}
										<span class="setting-modified">{$LL.admin_login_ui_modified()}</span>
									{/if}
								</div>
								<p class="setting-description">
									{$LL.admin_login_ui_service_site_enabled_description()}
								</p>
								<p class="setting-description">
									{$LL.admin_login_ui_service_site_setup_note()}
								</p>
							</div>

							<div class="setting-control">
								<ToggleSwitch
									checked={serviceSiteFallbackEnabled}
									disabled={!canEditLoginUiSettings}
									id="service-site-fallback-enabled"
									onchange={(newValue) => {
										serviceSiteFallbackEnabled = newValue;
									}}
								/>
							</div>
						</div>
					</div>
				</div>

				<div class="form-actions">
					<span class="cache-notice">{$LL.admin_login_ui_cache_notice()}</span>
					<button
						onclick={discardServiceSiteChanges}
						disabled={!hasServiceSiteChanges || serviceSiteSaving || !canEditLoginUiSettings}
						class="btn btn-secondary"
					>
						{$LL.admin_login_ui_discard_changes()}
					</button>
					<button
						onclick={saveServiceSiteSettings}
						disabled={!hasServiceSiteChanges || serviceSiteSaving || !canEditLoginUiSettings}
						class="btn btn-primary"
					>
						{serviceSiteSaving
							? $LL.admin_login_ui_saving()
							: $LL.admin_login_ui_save_service_site()}
					</button>
				</div>
			</section>
		{/if}

		<!-- Error message -->
		{#if error}
			<div class="alert alert-error">
				{error}
				{#if error === $LL.admin_login_ui_settings_conflict()}
					<button onclick={loadData} class="btn btn-sm btn-danger reload-action">
						{$LL.admin_login_ui_reload()}
					</button>
				{/if}
			</div>
		{/if}

		<!-- Success message -->
		{#if successMessage}
			<div class="alert alert-success">{successMessage}</div>
		{/if}

		{#if loading}
			<div class="loading-state">
				<p class="text-secondary">{$LL.admin_login_ui_loading_settings()}</p>
			</div>
		{:else if meta && settings}
			<div class="settings-form-card moved-theme-card">
				<div class="moved-theme-content">
					<div>
						<h2>{$LL.admin_header_theme()}</h2>
						<p>
							Theme templates, visual assets, page shell settings, preview, publish, and rollback
							now live on a dedicated page.
						</p>
					</div>
					<a class="btn btn-primary" href="/admin/themes">Open theme settings</a>
				</div>
			</div>
		{/if}
	</div>
</AdminPageShell>

<style>
	.settings-detail-page {
		max-width: 980px;
		--panel-border: none;
	}

	.scope-badge,
	.readonly-badge {
		display: inline-flex;
		align-items: center;
		padding: 4px 9px;
		border-radius: var(--radius-full);
		font-size: 0.75rem;
		font-weight: 700;
		white-space: nowrap;
	}

	.scope-badge {
		background: var(--color-accent-muted);
		color: var(--color-accent);
	}

	.scope-badge.tenant {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.scope-badge.client {
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
	}

	.readonly-badge {
		background: color-mix(in srgb, var(--color-danger) 12%, transparent);
		color: var(--color-danger);
	}

	.section-title {
		font-size: 18px;
		font-weight: 600;
		margin: 0 0 6px 0;
	}

	.section-description {
		font-size: 14px;
		color: var(--color-text-muted);
		margin: 0;
	}

	.config-source-badge {
		display: inline-flex;
		align-items: center;
		padding: 3px 10px;
		border-radius: var(--radius-control, 6px);
		background: var(--color-surface-muted);
		border: 1px solid var(--color-border);
		color: var(--color-text-muted);
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		white-space: nowrap;
	}

	.language-settings-panel {
		margin-bottom: 16px;
	}

	.language-grid-toolbar {
		display: flex;
		justify-content: flex-end;
		gap: 6px;
		margin-top: 18px;
	}

	.language-bulk-button {
		min-height: 28px;
		padding: 3px 9px;
		font-size: 11px;
	}

	.language-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0;
		margin-top: 8px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 8px);
		overflow: hidden;
	}

	.language-option {
		display: grid;
		grid-template-columns: auto auto minmax(0, 1fr);
		align-items: center;
		gap: 9px;
		min-height: 48px;
		padding: 10px 12px;
		border-right: 1px solid var(--color-border);
		border-bottom: 1px solid var(--color-border);
		background: var(--color-surface);
	}

	.language-option:nth-child(3n) {
		border-right: 0;
	}

	.language-option:nth-last-child(-n + 2) {
		border-bottom: 0;
	}

	.language-option.default {
		background: var(--color-accent-muted);
	}

	.language-control {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
	}

	.language-control:has(input:disabled) {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.language-control input {
		margin: 0;
	}

	.language-name {
		min-width: 0;
		font-size: 13px;
		font-weight: 600;
		color: var(--color-text);
	}

	.default-language-label {
		margin-left: 5px;
		font-size: 11px;
		line-height: 1.2;
		color: var(--color-accent);
		white-space: nowrap;
	}

	.language-help {
		margin: 12px 0 0;
		font-size: 12px;
		line-height: 1.5;
		color: var(--color-text-muted);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}

	@media (max-width: 760px) {
		.language-grid {
			grid-template-columns: 1fr;
		}

		.language-option,
		.language-option:nth-child(3n),
		.language-option:nth-last-child(-n + 2) {
			border-right: 0;
			border-bottom: 1px solid var(--color-border);
		}

		.language-option:last-child {
			border-bottom: 0;
		}
	}

	.alert-link {
		margin-left: 10px;
		color: inherit;
		font-weight: 700;
		text-decoration: underline;
	}

	.setting-control.wide {
		min-width: min(100%, 420px);
	}

	.radio-card-group {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 10px;
		width: 100%;
	}

	.radio-card {
		display: flex;
		gap: 10px;
		align-items: flex-start;
		padding: 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 8px);
		background: var(--color-surface);
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background-color 0.15s ease;
	}

	.radio-card.selected {
		border-color: var(--color-accent);
		background: var(--color-accent-muted);
	}

	.radio-card:has(input:disabled) {
		cursor: not-allowed;
		opacity: 0.7;
	}

	.radio-card input {
		margin-top: 2px;
		flex: 0 0 auto;
	}

	.radio-card span {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.radio-card strong {
		font-size: 13px;
		line-height: 1.3;
		color: var(--color-text);
	}

	.radio-card small {
		font-size: 12px;
		line-height: 1.35;
		color: var(--color-text-muted);
	}

	.inline-note {
		display: inline-block;
		margin-left: 6px;
		color: var(--color-warning);
		font-weight: 600;
	}

	.stacked-input {
		margin-top: 8px;
	}

	.error-text {
		color: var(--color-danger);
	}

	.form-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 16px;
	}

	.moved-theme-card {
		padding: 20px;
		margin-bottom: 16px;
	}

	.moved-theme-content {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
		flex-wrap: wrap;
	}

	.moved-theme-content h2 {
		margin: 0 0 4px;
		font-size: 1rem;
		color: var(--color-text);
	}

	.moved-theme-content p {
		margin: 0;
		color: var(--color-text-muted);
		font-size: 0.875rem;
		line-height: 1.35;
	}

	.cache-notice {
		color: var(--color-text-muted);
		font-size: 0.78rem;
		line-height: 1.35;
	}

	.reload-action {
		margin-left: 12px;
	}

	.textarea-setting {
		margin-top: 4px;
	}

	.textarea-setting.modified {
		background: color-mix(in srgb, var(--color-warning) 8%, transparent);
		border-radius: var(--radius-sm);
		padding: 8px;
		margin: -8px;
	}

	.settings-textarea {
		width: 100%;
		min-height: 140px;
		padding: 12px 14px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 8px);
		background: var(--control-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
		line-height: 1.5;
		resize: vertical;
	}

	.settings-textarea:focus {
		outline: none;
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.settings-textarea:disabled {
		background: var(--color-surface-muted);
		color: var(--color-text-subtle);
		cursor: not-allowed;
	}

	.trusted-origins-validation {
		margin: 8px 0 0;
		font-size: 13px;
		color: var(--color-danger);
	}

	.trusted-origins-preview {
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--color-border);
	}

	.trusted-origins-preview-label {
		margin: 0 0 10px;
		font-size: 13px;
		font-weight: 600;
		color: var(--color-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.trusted-origins-list {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.trusted-origin-chip {
		display: inline-flex;
		align-items: center;
		padding: 6px 10px;
		border-radius: 999px;
		background: var(--color-surface-muted);
		border: 1px solid var(--color-border);
		color: var(--color-text);
		font-size: 13px;
	}

	.coming-soon-section {
		margin-top: 32px;
		padding: 20px;
		background: var(--color-surface-muted);
		border-radius: var(--radius-panel, 8px);
		border: 1px dashed var(--color-border);
	}

	.coming-soon-title {
		font-size: 16px;
		font-weight: 600;
		color: var(--color-text-muted);
		margin: 0 0 8px 0;
	}

	.coming-soon-description {
		font-size: 14px;
		color: var(--color-text-subtle);
		margin: 0 0 16px 0;
	}

	.coming-soon-list {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.coming-soon-item {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 12px;
		background: var(--color-surface);
		border-radius: var(--radius-control, 6px);
		border: 1px solid var(--color-border);
	}

	.coming-soon-label {
		font-size: 14px;
		font-weight: 500;
		color: var(--color-text);
	}

	.coming-soon-desc {
		font-size: 13px;
		color: var(--color-text-subtle);
	}
</style>
