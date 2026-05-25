<script lang="ts">
	import { onMount } from 'svelte';
	import {
		scopedSettingsAPI,
		SettingsConflictError,
		type CategorySettings
	} from '$lib/api/admin-settings';
	import { ToggleSwitch } from '$lib/components';
	import { getTenantInfo } from '$lib/api/admin-info';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { tenantStore } from '$lib/stores/tenants.svelte';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import {
		buildDiscoveryMethodsValue,
		getMethodToggles,
		resolveEmailResolutionPolicy,
		type EmailResolutionPolicy
	} from '$lib/admin/tenant-discovery-settings';

	interface LoginEntryForm {
		overrideEnabled: boolean;
		mode: 'tenant_only' | 'discovery_optional' | 'discovery_required';
		emailResolutionPolicy: EmailResolutionPolicy;
		emailEnabled: boolean;
		tenantCodeEnabled: boolean;
		tenantSlugEnabled: boolean;
		wayfEnabled: boolean;
		selectionPolicy: 'auto_if_single' | 'always_select' | 'select_if_multiple' | 'manual_only';
		allowManualTenantEntry: boolean;
		rememberLastTenant: boolean;
		redirectDefaultLoginToDiscovery: boolean;
		requireCommonDiscoveryBeforeLogin: boolean;
		skipDiscoveryIfOnlyOneTenant: boolean;
		redirectTenantDiscoverToCommonEntry: boolean;
	}

	interface DiscoveryUiForm {
		overrideEnabled: boolean;
		inheritFromLoginUi: boolean;
		theme: '' | 'light' | 'dark';
		variant: '' | 'beige' | 'blue-gray' | 'green' | 'brown' | 'navy' | 'slate';
		brandName: string;
		logoUrl: string;
		pageTitle: string;
		kickerText: string;
		titleText: string;
		subtitleText: string;
	}

	interface LoginUiFallback {
		theme: string;
		variant: string;
		brandName: string;
		logoUrl: string;
	}

	const LOGIN_ENTRY_CATEGORY = 'login-entry';
	const LOGIN_UI_CATEGORY = 'login-ui';
	const DISCOVERY_UI_CATEGORY = 'tenant-discovery-ui';
	const DISCOVERY_UI_RUNTIME_DEFAULTS = {
		theme: 'light',
		variant: 'beige',
		brandName: 'Authrim',
		pageTitle: 'Tenant Discovery',
		kickerText: 'Tenant discovery',
		titleText: 'Find your tenant',
		subtitleText:
			'Resolve the correct tenant first. Authentication methods are loaded after the tenant is confirmed.'
	} as const;

	let loading = $state(true);
	let pageError = $state('');

	let loginEntrySettings = $state<CategorySettings | null>(null);
	let commonEntryBehaviorSettings = $state<CategorySettings | null>(null);
	let commonEntrySettings = $state<CategorySettings | null>(null);
	let tenantUiSettings = $state<CategorySettings | null>(null);
	let commonDiscoverUrl = $state<string | null>(null);

	let behaviorForm = $state<LoginEntryForm | null>(null);
	let commonEntryBehaviorForm = $state<LoginEntryForm | null>(null);
	let commonEntryForm = $state<DiscoveryUiForm | null>(null);
	let tenantUiForm = $state<DiscoveryUiForm | null>(null);

	let initialBehaviorValues = $state<Record<string, unknown> | null>(null);
	let initialCommonEntryBehaviorValues = $state<Record<string, unknown> | null>(null);
	let initialCommonEntryValues = $state<Record<string, unknown> | null>(null);
	let initialTenantUiValues = $state<Record<string, unknown> | null>(null);

	let behaviorSaving = $state(false);
	let commonEntryBehaviorSaving = $state(false);
	let commonEntrySaving = $state(false);
	let tenantUiSaving = $state(false);

	let behaviorError = $state('');
	let commonEntryBehaviorError = $state('');
	let commonEntryError = $state('');
	let tenantUiError = $state('');

	let behaviorSuccess = $state('');
	let commonEntryBehaviorSuccess = $state('');
	let commonEntrySuccess = $state('');
	let tenantUiSuccess = $state('');

	const currentTenantId = $derived(settingsContext.tenantId);
	const currentTenantName = $derived(
		settingsContext.availableTenants.find((tenant) => tenant.id === currentTenantId)?.name || currentTenantId
	);
	const singleTenantMode = $derived(tenantStore.singleTenantMode);
	const canEditTenant = $derived(settingsContext.getPermissionForScope('tenant', adminAuth.user?.roles ?? []) === 'edit');
	const canEditPlatform = $derived(
		settingsContext.getPermissionForScope('platform', adminAuth.user?.roles ?? []) === 'edit'
	);
	const commonDiscoverDisplay = $derived(commonDiscoverUrl || 'the shared /discover URL');

	const hasBehaviorChanges = $derived(
		initialBehaviorValues
			? JSON.stringify(buildTenantBehaviorValues(behaviorForm, singleTenantMode)) !==
				JSON.stringify(initialBehaviorValues)
			: false
	);
	const hasCommonEntryBehaviorChanges = $derived(
		initialCommonEntryBehaviorValues
			? JSON.stringify(buildBehaviorValues(commonEntryBehaviorForm)) !==
				JSON.stringify(initialCommonEntryBehaviorValues)
			: false
	);
	const hasCommonEntryChanges = $derived(
		initialCommonEntryValues
			? JSON.stringify(buildDiscoveryUiValues(commonEntryForm)) !== JSON.stringify(initialCommonEntryValues)
			: false
	);
	const hasTenantUiChanges = $derived(
		initialTenantUiValues
			? JSON.stringify(buildTenantDiscoveryUiValues(tenantUiForm, singleTenantMode)) !==
				JSON.stringify(initialTenantUiValues)
			: false
	);
	function getBehaviorValidationError(form: LoginEntryForm | null): string {
		if (!form) return '';
		if (!singleTenantMode && !form.overrideEnabled) return '';

		if (
			!form.emailEnabled &&
			!form.tenantCodeEnabled &&
			!form.tenantSlugEnabled &&
			!form.wayfEnabled
		) {
			return 'Enable at least one discovery method.';
		}

		if (
			form.selectionPolicy === 'manual_only' &&
			!form.tenantCodeEnabled &&
			!form.tenantSlugEnabled &&
			!form.wayfEnabled
		) {
			return 'manual_only requires tenant code, tenant slug, or WAYF to remain enabled.';
		}

		return '';
	}

	const behaviorValidationError = $derived.by(() => getBehaviorValidationError(behaviorForm));
	const commonEntryBehaviorValidationError = $derived.by(() =>
		getBehaviorValidationError(commonEntryBehaviorForm)
	);

	function entryModeInfo(mode: LoginEntryForm['mode']) {
		switch (mode) {
			case 'tenant_only':
				return {
					description:
						'Users sign in through a tenant-specific entry point. The shared discovery page is bypassed unless another flow sends users there.',
					sample: 'Use when every app or invitation already knows the tenant.'
				};
			case 'discovery_optional':
				return {
					description:
						'Users can use tenant discovery, but tenant-specific login URLs remain valid.',
					sample: 'Good default for gradual multi-tenant rollout.'
				};
			case 'discovery_required':
				return {
					description:
						'Users must resolve a tenant before login methods are shown.',
					sample: 'Use when the shared login entry should always choose a tenant first.'
				};
		}
	}

	function emailResolutionInfo(policy: EmailResolutionPolicy, enabled: boolean) {
		if (!enabled) {
			return {
				description: 'Email-based discovery is currently disabled.',
				sample: 'Enable Email address below to use this policy.'
			};
		}
		switch (policy) {
			case 'exact_email_only':
				return {
					description:
						'Resolve the tenant only when the full email address is explicitly mapped.',
					sample: 'alice@example.edu must have its own mapping.'
				};
			case 'exact_email_then_domain':
				return {
					description:
						'Try an exact email mapping first, then fall back to the email domain if no exact match exists.',
					sample: 'alice@example.edu falls back to example.edu.'
				};
			case 'disabled':
				return {
					description: 'Do not resolve tenants from email addresses.',
					sample: 'Users must use another enabled discovery method.'
				};
		}
	}

	function selectionPolicyInfo(policy: LoginEntryForm['selectionPolicy']) {
		switch (policy) {
			case 'auto_if_single':
				return {
					description:
						'Automatically continue when discovery returns exactly one tenant. Show a selection screen for multiple matches.',
					sample: 'Best when mappings are reliable and one clear match is common.'
				};
			case 'always_select':
				return {
					description:
						'Always show the tenant selection step after discovery, even if only one tenant matched.',
					sample: 'Use when users should explicitly confirm the tenant.'
				};
			case 'select_if_multiple':
				return {
					description:
						'Skip the selection step for one match, but ask users to choose when multiple tenants match.',
					sample: 'Balanced default for shared email domains.'
				};
			case 'manual_only':
				return {
					description:
						'Do not auto-select from email resolution. Users must enter or choose a tenant manually.',
					sample: 'Requires tenant code, tenant slug, or WAYF discovery to stay enabled.'
				};
		}
	}

	let previousTenantId = $state('');

	onMount(async () => {
		await settingsContext.initialize();
		if (!tenantStore.loaded) {
			await tenantStore.load();
		}
		if (tenantStore.singleTenantMode) {
			loading = false;
			return;
		}
		await loadPageData();
	});

	$effect(() => {
		if (singleTenantMode || !currentTenantId || loading) return;
		if (previousTenantId === currentTenantId) return;
		previousTenantId = currentTenantId;
		if (loginEntrySettings || tenantUiSettings) {
			loadPageData();
		}
	});

	function readString(values: Record<string, unknown>, key: string): string {
		const value = values[key];
		return typeof value === 'string' ? value : '';
	}

	function readBoolean(values: Record<string, unknown>, key: string): boolean {
		return values[key] === true;
	}

	function createBehaviorForm(
		settings: CategorySettings,
		options?: { overrideEnabledDefault?: boolean }
	): LoginEntryForm {
		const toggles = getMethodToggles(settings.values['login-entry.discovery_methods']);
		const resolvedEmailResolutionPolicy = resolveEmailResolutionPolicy(
			settings.values['login-entry.discovery_methods'],
			settings.values['login-entry.email_resolution_policy']
		);

		return {
			overrideEnabled:
				typeof settings.values['login-entry.override_enabled'] === 'boolean'
					? settings.values['login-entry.override_enabled']
					: (options?.overrideEnabledDefault ?? false),
			mode:
				(settings.values['login-entry.mode'] as LoginEntryForm['mode']) ?? 'discovery_optional',
			emailResolutionPolicy:
				resolvedEmailResolutionPolicy === 'disabled'
					? 'exact_email_then_domain'
					: resolvedEmailResolutionPolicy,
			emailEnabled: toggles.emailEnabled,
			tenantCodeEnabled: toggles.tenantCodeEnabled,
			tenantSlugEnabled: toggles.tenantSlugEnabled,
			wayfEnabled: toggles.wayfEnabled,
			selectionPolicy:
				(settings.values['login-entry.selection_policy'] as LoginEntryForm['selectionPolicy']) ??
				'select_if_multiple',
			allowManualTenantEntry: readBoolean(
				settings.values,
				'login-entry.allow_manual_tenant_entry'
			),
			rememberLastTenant: readBoolean(settings.values, 'login-entry.remember_last_tenant'),
			redirectDefaultLoginToDiscovery: readBoolean(
				settings.values,
				'login-entry.redirect_default_login_to_discovery'
			),
			requireCommonDiscoveryBeforeLogin: readBoolean(
				settings.values,
				'login-entry.require_common_discovery_before_login'
			),
			skipDiscoveryIfOnlyOneTenant: readBoolean(
				settings.values,
				'login-entry.skip_discovery_if_only_one_tenant'
			),
			redirectTenantDiscoverToCommonEntry: readBoolean(
				settings.values,
				'login-entry.redirect_tenant_discover_to_common_entry'
			)
		};
	}

	function createDiscoveryUiForm(
		settings: CategorySettings,
		options?: {
			platformSettings?: CategorySettings | null;
			loginUiSettings?: CategorySettings | null;
			overrideEnabledDefault?: boolean;
		}
	): DiscoveryUiForm {
		const inheritFromLoginUi = readBoolean(settings.values, 'tenant-discovery-ui.inherit_from_login_ui');
		const platformValues = options?.platformSettings?.values ?? {};
		const loginUiValues = options?.loginUiSettings?.values ?? {};
		const loginUiFallback: LoginUiFallback = {
			theme:
				(typeof loginUiValues['login-ui.theme'] === 'string' &&
				String(loginUiValues['login-ui.theme']).trim()) ||
				DISCOVERY_UI_RUNTIME_DEFAULTS.theme,
			variant:
				(typeof loginUiValues['login-ui.variant'] === 'string' &&
				String(loginUiValues['login-ui.variant']).trim()) ||
				DISCOVERY_UI_RUNTIME_DEFAULTS.variant,
			brandName:
				(typeof loginUiValues['login-ui.brand_name'] === 'string' &&
				String(loginUiValues['login-ui.brand_name']).trim()) ||
				DISCOVERY_UI_RUNTIME_DEFAULTS.brandName,
			logoUrl:
				(typeof loginUiValues['login-ui.logo_url'] === 'string' &&
				String(loginUiValues['login-ui.logo_url']).trim()) ||
				''
		};

		function resolveTextValue(settingsKey: string, fallback: string): string {
			return (
				readString(settings.values, settingsKey) ||
				readString(platformValues, settingsKey) ||
				fallback
			);
		}

		return {
			overrideEnabled:
				typeof settings.values['tenant-discovery-ui.override_enabled'] === 'boolean'
					? settings.values['tenant-discovery-ui.override_enabled']
					: (options?.overrideEnabledDefault ?? false),
			inheritFromLoginUi,
			theme:
				((readString(settings.values, 'tenant-discovery-ui.theme') ||
					(inheritFromLoginUi ? loginUiFallback.theme : '') ||
					DISCOVERY_UI_RUNTIME_DEFAULTS.theme) as DiscoveryUiForm['theme']) || '',
			variant:
				((readString(settings.values, 'tenant-discovery-ui.variant') ||
					(inheritFromLoginUi ? loginUiFallback.variant : '') ||
					DISCOVERY_UI_RUNTIME_DEFAULTS.variant) as DiscoveryUiForm['variant']) || '',
			brandName:
				readString(settings.values, 'tenant-discovery-ui.brand_name') ||
				(inheritFromLoginUi ? loginUiFallback.brandName : '') ||
				DISCOVERY_UI_RUNTIME_DEFAULTS.brandName,
			logoUrl:
				readString(settings.values, 'tenant-discovery-ui.logo_url') ||
				(inheritFromLoginUi ? loginUiFallback.logoUrl : ''),
			pageTitle: resolveTextValue(
				'tenant-discovery-ui.page_title',
				DISCOVERY_UI_RUNTIME_DEFAULTS.pageTitle
			),
			kickerText: resolveTextValue(
				'tenant-discovery-ui.kicker_text',
				DISCOVERY_UI_RUNTIME_DEFAULTS.kickerText
			),
			titleText: resolveTextValue(
				'tenant-discovery-ui.title_text',
				DISCOVERY_UI_RUNTIME_DEFAULTS.titleText
			),
			subtitleText: resolveTextValue(
				'tenant-discovery-ui.subtitle_text',
				DISCOVERY_UI_RUNTIME_DEFAULTS.subtitleText
			)
		};
	}

	function buildBehaviorValues(
		form: LoginEntryForm | null,
		options?: { includeOverrideEnabled?: boolean; includeOperationalValues?: boolean }
	): Record<string, unknown> {
		if (!form) return {};
		const includeOverrideEnabled = options?.includeOverrideEnabled ?? false;
		const includeOperationalValues = options?.includeOperationalValues ?? true;
		const values: Record<string, unknown> = {};
		if (includeOverrideEnabled) {
			values['login-entry.override_enabled'] = form.overrideEnabled;
		}
		if (!includeOperationalValues) {
			return values;
		}
		const emailResolutionPolicy = form.emailEnabled
			? form.emailResolutionPolicy === 'disabled'
				? 'exact_email_then_domain'
				: form.emailResolutionPolicy
			: 'disabled';

		return {
			...values,
			'login-entry.mode': form.mode,
			'login-entry.discovery_methods': buildDiscoveryMethodsValue({
				emailEnabled: form.emailEnabled,
				emailResolutionPolicy,
				tenantCodeEnabled: form.tenantCodeEnabled,
				tenantSlugEnabled: form.tenantSlugEnabled,
				wayfEnabled: form.wayfEnabled
			}),
			'login-entry.email_resolution_policy': emailResolutionPolicy,
			'login-entry.selection_policy': form.selectionPolicy,
			'login-entry.allow_manual_tenant_entry': form.allowManualTenantEntry,
			'login-entry.remember_last_tenant': form.rememberLastTenant,
			'login-entry.redirect_default_login_to_discovery': form.redirectDefaultLoginToDiscovery,
			'login-entry.require_common_discovery_before_login':
				form.requireCommonDiscoveryBeforeLogin,
			'login-entry.skip_discovery_if_only_one_tenant': form.skipDiscoveryIfOnlyOneTenant,
			'login-entry.redirect_tenant_discover_to_common_entry':
				form.redirectTenantDiscoverToCommonEntry
		};
	}

	function buildTenantBehaviorValues(
		form: LoginEntryForm | null,
		isSingleTenant: boolean
	): Record<string, unknown> {
		return buildBehaviorValues(form, {
			includeOverrideEnabled: !isSingleTenant,
			includeOperationalValues: isSingleTenant || !!form?.overrideEnabled
		});
	}

	function buildDiscoveryUiValues(
		form: DiscoveryUiForm | null,
		options?: { includeOverrideEnabled?: boolean; includeOperationalValues?: boolean }
	): Record<string, unknown> {
		if (!form) return {};
		const includeOverrideEnabled = options?.includeOverrideEnabled ?? false;
		const includeOperationalValues = options?.includeOperationalValues ?? true;
		const values: Record<string, unknown> = {};
		if (includeOverrideEnabled) {
			values['tenant-discovery-ui.override_enabled'] = form.overrideEnabled;
		}
		if (!includeOperationalValues) {
			return values;
		}
		return {
			...values,
			'tenant-discovery-ui.inherit_from_login_ui': form.inheritFromLoginUi,
			'tenant-discovery-ui.theme': form.theme,
			'tenant-discovery-ui.variant': form.variant,
			'tenant-discovery-ui.brand_name': form.brandName.trim(),
			'tenant-discovery-ui.logo_url': form.logoUrl.trim(),
			'tenant-discovery-ui.page_title': form.pageTitle.trim(),
			'tenant-discovery-ui.kicker_text': form.kickerText.trim(),
			'tenant-discovery-ui.title_text': form.titleText.trim(),
			'tenant-discovery-ui.subtitle_text': form.subtitleText.trim()
		};
	}

	function buildTenantDiscoveryUiValues(
		form: DiscoveryUiForm | null,
		isSingleTenant: boolean
	): Record<string, unknown> {
		return buildDiscoveryUiValues(form, {
			includeOverrideEnabled: !isSingleTenant,
			includeOperationalValues: isSingleTenant || !!form?.overrideEnabled
		});
	}

	function diffValues(
		current: Record<string, unknown>,
		initial: Record<string, unknown>
	): Record<string, unknown> {
		const diff: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(current)) {
			if (JSON.stringify(value) !== JSON.stringify(initial[key])) {
				diff[key] = value;
			}
		}
		return diff;
	}

	async function loadPageData() {
		if (singleTenantMode) {
			loading = false;
			return;
		}

		loading = true;
		pageError = '';
		behaviorError = '';
		commonEntryBehaviorError = '';
		commonEntryError = '';
		tenantUiError = '';

		try {
			const tenantId = settingsContext.resolveTenantId(currentTenantId);
			const [loginEntryResult, tenantUiResult, tenantLoginUiResult, tenantInfoResult] = await Promise.all([
				scopedSettingsAPI.getSettingsForScope(LOGIN_ENTRY_CATEGORY, { level: 'tenant', tenantId }),
				scopedSettingsAPI.getSettingsForScope(DISCOVERY_UI_CATEGORY, { level: 'tenant', tenantId }),
				scopedSettingsAPI.getSettingsForScope(LOGIN_UI_CATEGORY, { level: 'tenant', tenantId }),
				getTenantInfo(tenantId).catch(() => null)
			]);
			commonDiscoverUrl = tenantInfoResult?.discover_url ?? null;

			loginEntrySettings = loginEntryResult;
			tenantUiSettings = tenantUiResult;
			behaviorForm = createBehaviorForm(loginEntryResult);
			initialBehaviorValues = buildTenantBehaviorValues(behaviorForm, singleTenantMode);

			if (!singleTenantMode) {
				try {
					const [platformBehaviorResult, platformUiResult] = await Promise.all([
						scopedSettingsAPI.getSettingsForScope(LOGIN_ENTRY_CATEGORY, {
							level: 'platform'
						}),
						scopedSettingsAPI.getSettingsForScope(DISCOVERY_UI_CATEGORY, {
							level: 'platform'
						})
					]);
					commonEntryBehaviorSettings = platformBehaviorResult;
					commonEntryBehaviorForm = createBehaviorForm(platformBehaviorResult);
					initialCommonEntryBehaviorValues = buildBehaviorValues(commonEntryBehaviorForm);
					commonEntrySettings = platformUiResult;
					commonEntryForm = createDiscoveryUiForm(platformUiResult);
					tenantUiForm = createDiscoveryUiForm(tenantUiResult, {
						platformSettings: platformUiResult,
						loginUiSettings: tenantLoginUiResult
					});
					initialCommonEntryValues = buildDiscoveryUiValues(commonEntryForm);
					initialTenantUiValues = buildTenantDiscoveryUiValues(tenantUiForm, singleTenantMode);
					commonEntryBehaviorError = '';
					commonEntryError = '';
				} catch (err) {
					commonEntryBehaviorSettings = null;
					commonEntryBehaviorForm = null;
					initialCommonEntryBehaviorValues = null;
					commonEntrySettings = null;
					commonEntryForm = null;
					initialCommonEntryValues = null;
					commonEntryBehaviorError =
						err instanceof Error ? err.message : 'Failed to load common entry behavior';
					commonEntryError =
						err instanceof Error ? err.message : 'Failed to load common entry screen settings';
				}
			} else {
				tenantUiForm = createDiscoveryUiForm(tenantUiResult, {
					loginUiSettings: tenantLoginUiResult
				});
				initialTenantUiValues = buildTenantDiscoveryUiValues(tenantUiForm, singleTenantMode);
				commonEntryBehaviorSettings = null;
				commonEntryBehaviorForm = null;
				initialCommonEntryBehaviorValues = null;
				commonEntrySettings = null;
				commonEntryForm = null;
				initialCommonEntryValues = null;
			}
		} catch (err) {
			pageError = err instanceof Error ? err.message : 'Failed to load tenant discovery settings';
		} finally {
			loading = false;
		}
	}

	function clearMessage(section: 'behavior' | 'commonBehavior' | 'common' | 'tenant') {
		if (section === 'behavior') {
			behaviorSuccess = '';
			return;
		}
		if (section === 'commonBehavior') {
			commonEntryBehaviorSuccess = '';
			return;
		}
		if (section === 'common') {
			commonEntrySuccess = '';
			return;
		}
		tenantUiSuccess = '';
	}

	async function saveBehavior() {
		if (!loginEntrySettings || !behaviorForm) return;
		if (behaviorValidationError) {
			behaviorError = behaviorValidationError;
			return;
		}
		const set = diffValues(
			buildTenantBehaviorValues(behaviorForm, singleTenantMode),
			initialBehaviorValues ?? {}
		);
		if (Object.keys(set).length === 0) return;

		behaviorSaving = true;
		behaviorError = '';
		clearMessage('behavior');

		try {
			await scopedSettingsAPI.updateSettingsForScope(
				LOGIN_ENTRY_CATEGORY,
				{ level: 'tenant', tenantId: settingsContext.resolveTenantId(currentTenantId) },
				{ ifMatch: loginEntrySettings.version, set }
			);
			behaviorSuccess = 'Discovery behavior saved';
			await loadPageData();
		} catch (err) {
			behaviorError =
				err instanceof SettingsConflictError
					? 'Settings were modified by another user. Reload and try again.'
					: err instanceof Error
						? err.message
						: 'Failed to save discovery behavior';
		} finally {
			behaviorSaving = false;
		}
	}

	async function saveCommonEntryBehavior() {
		if (!commonEntryBehaviorSettings || !commonEntryBehaviorForm) return;
		if (commonEntryBehaviorValidationError) {
			commonEntryBehaviorError = commonEntryBehaviorValidationError;
			return;
		}
		const set = diffValues(
			buildBehaviorValues(commonEntryBehaviorForm),
			initialCommonEntryBehaviorValues ?? {}
		);
		if (Object.keys(set).length === 0) return;

		commonEntryBehaviorSaving = true;
		commonEntryBehaviorError = '';
		clearMessage('commonBehavior');

		try {
			await scopedSettingsAPI.updateSettingsForScope(
				LOGIN_ENTRY_CATEGORY,
				{ level: 'platform' },
				{ ifMatch: commonEntryBehaviorSettings.version, set }
			);
			commonEntryBehaviorSuccess = 'Common entry discovery behavior saved';
			await loadPageData();
		} catch (err) {
			commonEntryBehaviorError =
				err instanceof SettingsConflictError
					? 'Settings were modified by another user. Reload and try again.'
					: err instanceof Error
						? err.message
						: 'Failed to save common entry discovery behavior';
		} finally {
			commonEntryBehaviorSaving = false;
		}
	}

	async function saveCommonEntryUi() {
		if (!commonEntrySettings || !commonEntryForm) return;
		const set = diffValues(buildDiscoveryUiValues(commonEntryForm), initialCommonEntryValues ?? {});
		if (Object.keys(set).length === 0) return;

		commonEntrySaving = true;
		commonEntryError = '';
		clearMessage('common');

		try {
			await scopedSettingsAPI.updateSettingsForScope(
				DISCOVERY_UI_CATEGORY,
				{ level: 'platform' },
				{ ifMatch: commonEntrySettings.version, set }
			);
			commonEntrySuccess = 'Common entry screen saved';
			await loadPageData();
		} catch (err) {
			commonEntryError =
				err instanceof SettingsConflictError
					? 'Settings were modified by another user. Reload and try again.'
					: err instanceof Error
						? err.message
						: 'Failed to save common entry screen';
		} finally {
			commonEntrySaving = false;
		}
	}

	async function saveTenantUi() {
		if (!tenantUiSettings || !tenantUiForm) return;
		const set = diffValues(
			buildTenantDiscoveryUiValues(tenantUiForm, singleTenantMode),
			initialTenantUiValues ?? {}
		);
		if (Object.keys(set).length === 0) return;

		tenantUiSaving = true;
		tenantUiError = '';
		clearMessage('tenant');

		try {
			await scopedSettingsAPI.updateSettingsForScope(
				DISCOVERY_UI_CATEGORY,
				{ level: 'tenant', tenantId: settingsContext.resolveTenantId(currentTenantId) },
				{ ifMatch: tenantUiSettings.version, set }
			);
			tenantUiSuccess = 'Tenant discovery screen saved';
			await loadPageData();
		} catch (err) {
			tenantUiError =
				err instanceof SettingsConflictError
					? 'Settings were modified by another user. Reload and try again.'
					: err instanceof Error
						? err.message
						: 'Failed to save tenant discovery screen';
		} finally {
			tenantUiSaving = false;
		}
	}
</script>

<svelte:head>
	<title>Tenant Discovery - Admin</title>
</svelte:head>

<div class="page-shell">
	<header class="page-header">
		<div>
			<h1 class="page-title">Tenant Discovery</h1>
			<p class="page-description">
				{#if singleTenantMode}
					Available after enabling multi-tenant mode. Use this page to configure tenant discovery flows.
				{:else}
					Configure tenant resolution behavior and customize the discovery screen.
				{/if}
			</p>
		</div>
	</header>

	{#if loading}
		<div class="loading-state">
			<p>Loading tenant discovery settings...</p>
		</div>
	{:else if singleTenantMode}
		<section class="panel">
			<div class="alert alert-info">
				Tenant discovery is disabled while this deployment is running in single-tenant mode.
				You can start from `workers.dev`, add an API custom domain later, and then enable
				multi-tenant mode in Setup.
			</div>
		</section>
		<section class="panel">
			<div class="section-header">
				<div>
					<h2>Discovery Controls</h2>
					<p>
						Common entry, tenant resolution, and discovery screen overrides become available
						after multi-tenant mode is enabled.
					</p>
				</div>
			</div>
			<div class="actions">
				<button class="btn btn-primary" disabled>Enable In Setup</button>
			</div>
		</section>
	{:else if pageError}
		<section class="panel">
			<div class="alert alert-error">{pageError}</div>
		</section>
	{:else}
		{#if !singleTenantMode}
			<section class="panel">
				<div class="section-header">
					<div>
						<h2>Common Entry Login Behavior</h2>
						<p>Controls the shared entry page before a tenant is selected. Current URL: <code>{commonDiscoverDisplay}</code>.</p>
					</div>
				</div>

				{#if commonEntryBehaviorError}
					<div class="alert alert-error">{commonEntryBehaviorError}</div>
				{/if}
				{#if commonEntryBehaviorValidationError && commonEntryBehaviorValidationError !== commonEntryBehaviorError}
					<div class="alert alert-error">{commonEntryBehaviorValidationError}</div>
				{/if}
				{#if commonEntryBehaviorSuccess}
					<div class="alert alert-success">{commonEntryBehaviorSuccess}</div>
				{/if}
				{#if !canEditPlatform}
					<div class="alert alert-info">
						Common entry behavior is a platform setting. Tenant admins can review it, but cannot edit it.
					</div>
				{/if}

				{#if commonEntryBehaviorForm}
					<div class="form-grid">
						<div class="form-group">
							<label for="common-entry-mode">Entry Mode</label>
							<select
								id="common-entry-mode"
								bind:value={commonEntryBehaviorForm.mode}
								disabled={!canEditPlatform || commonEntryBehaviorSaving}
							>
								<option value="tenant_only">Tenant-specific entry only</option>
								<option value="discovery_optional">Discovery optional</option>
								<option value="discovery_required">Discovery required</option>
							</select>
							<div class="inline-help">
								<p>{entryModeInfo(commonEntryBehaviorForm.mode).description}</p>
								<code>Example: {entryModeInfo(commonEntryBehaviorForm.mode).sample}</code>
							</div>
						</div>

						<div class="form-group">
							<label for="common-email-policy">Email Resolution</label>
							<select
								id="common-email-policy"
								bind:value={commonEntryBehaviorForm.emailResolutionPolicy}
								disabled={!canEditPlatform || commonEntryBehaviorSaving || !commonEntryBehaviorForm.emailEnabled}
							>
								<option value="exact_email_then_domain">Exact email, then email-domain fallback</option>
								<option value="exact_email_only">Exact email only</option>
							</select>
							<div class="inline-help">
								<p>
									{emailResolutionInfo(
										commonEntryBehaviorForm.emailResolutionPolicy,
										commonEntryBehaviorForm.emailEnabled
									).description}
								</p>
								<code>
									Example: {emailResolutionInfo(
										commonEntryBehaviorForm.emailResolutionPolicy,
										commonEntryBehaviorForm.emailEnabled
									).sample}
								</code>
							</div>
						</div>

						<div class="form-group">
							<label for="common-selection-policy">Selection Policy</label>
							<select
								id="common-selection-policy"
								bind:value={commonEntryBehaviorForm.selectionPolicy}
								disabled={!canEditPlatform || commonEntryBehaviorSaving}
							>
								<option value="auto_if_single">Auto if single</option>
								<option value="always_select">Always select</option>
								<option value="select_if_multiple">Select if multiple</option>
								<option value="manual_only">Manual only</option>
							</select>
							<div class="inline-help">
								<p>{selectionPolicyInfo(commonEntryBehaviorForm.selectionPolicy).description}</p>
								<code>
									Example: {selectionPolicyInfo(commonEntryBehaviorForm.selectionPolicy).sample}
								</code>
							</div>
						</div>
					</div>

					<div class="methods-card">
						<h3>Enabled Discovery Methods</h3>
						<div class="toggle-row">
							<div>
								<strong>Email address</strong>
								<p>
									Allow users to identify the tenant from their email address, with optional
									email-domain fallback.
								</p>
							</div>
							<ToggleSwitch
								id="common-email-enabled"
								checked={commonEntryBehaviorForm.emailEnabled}
								disabled={!canEditPlatform || commonEntryBehaviorSaving}
								onchange={(value) => {
									if (commonEntryBehaviorForm) commonEntryBehaviorForm.emailEnabled = value;
								}}
							/>
						</div>
						<div class="toggle-row">
							<div>
								<strong>Tenant code</strong>
								<p>Allow users to identify the tenant by tenant code.</p>
							</div>
							<ToggleSwitch
								id="common-tenant-code-enabled"
								checked={commonEntryBehaviorForm.tenantCodeEnabled}
								disabled={!canEditPlatform || commonEntryBehaviorSaving}
								onchange={(value) => {
									if (commonEntryBehaviorForm) commonEntryBehaviorForm.tenantCodeEnabled = value;
								}}
							/>
						</div>
						<div class="toggle-row">
							<div>
								<strong>Tenant slug</strong>
								<p>Allow users to identify the tenant by tenant slug.</p>
							</div>
							<ToggleSwitch
								id="common-tenant-slug-enabled"
								checked={commonEntryBehaviorForm.tenantSlugEnabled}
								disabled={!canEditPlatform || commonEntryBehaviorSaving}
								onchange={(value) => {
									if (commonEntryBehaviorForm) commonEntryBehaviorForm.tenantSlugEnabled = value;
								}}
							/>
						</div>
						<div class="toggle-row">
							<div>
								<strong>WAYF tenant chooser</strong>
								<p>Show a tenant-name dropdown populated from active tenants.</p>
							</div>
							<ToggleSwitch
								id="common-wayf-enabled"
								checked={commonEntryBehaviorForm.wayfEnabled}
								disabled={!canEditPlatform || commonEntryBehaviorSaving}
								onchange={(value) => {
									if (commonEntryBehaviorForm) commonEntryBehaviorForm.wayfEnabled = value;
								}}
							/>
						</div>
					</div>

					<div class="toggle-list">
						<div class="toggle-row">
							<div>
								<strong>Allow manual tenant entry</strong>
								<p>Show manual entry fallback when automatic discovery cannot resolve a tenant.</p>
							</div>
							<ToggleSwitch
								id="common-allow-manual-entry"
								checked={commonEntryBehaviorForm.allowManualTenantEntry}
								disabled={!canEditPlatform || commonEntryBehaviorSaving}
								onchange={(value) => {
									if (commonEntryBehaviorForm) commonEntryBehaviorForm.allowManualTenantEntry = value;
								}}
							/>
						</div>
						<div class="toggle-row">
							<div>
								<strong>Remember last tenant</strong>
								<p>Remember the tenant that was resolved most recently for this browser.</p>
							</div>
							<ToggleSwitch
								id="common-remember-last-tenant"
								checked={commonEntryBehaviorForm.rememberLastTenant}
								disabled={!canEditPlatform || commonEntryBehaviorSaving}
								onchange={(value) => {
									if (commonEntryBehaviorForm) commonEntryBehaviorForm.rememberLastTenant = value;
								}}
							/>
						</div>
						<div class="toggle-row">
							<div>
								<strong>Redirect default login to discovery</strong>
								<p>Redirect common-entry <code>/login</code> requests to <code>/discover</code> when appropriate.</p>
							</div>
							<ToggleSwitch
								id="common-redirect-default-login"
								checked={commonEntryBehaviorForm.redirectDefaultLoginToDiscovery}
								disabled={!canEditPlatform || commonEntryBehaviorSaving}
								onchange={(value) => {
									if (commonEntryBehaviorForm) commonEntryBehaviorForm.redirectDefaultLoginToDiscovery = value;
								}}
							/>
						</div>
						<div class="toggle-row">
							<div>
								<strong>Require common discovery before tenant login</strong>
								<p>
									When enabled, direct tenant-host <code>/login</code> visits must pass through the
									shared discover screen first. Challenge-based OIDC login is unchanged.
								</p>
							</div>
						<ToggleSwitch
							id="common-require-discovery-before-login"
							checked={commonEntryBehaviorForm.requireCommonDiscoveryBeforeLogin}
							disabled={!canEditPlatform || commonEntryBehaviorSaving}
							onchange={(value) => {
								if (commonEntryBehaviorForm) commonEntryBehaviorForm.requireCommonDiscoveryBeforeLogin = value;
							}}
						/>
					</div>
					<div class="toggle-row">
						<div>
							<strong>Redirect tenant discover to common entry</strong>
							<p>Redirect tenant-host and vanity-host <code>/discover</code> to common entry.</p>
						</div>
						<ToggleSwitch
							id="common-redirect-tenant-discover"
							checked={commonEntryBehaviorForm.redirectTenantDiscoverToCommonEntry}
							disabled={!canEditPlatform || commonEntryBehaviorSaving}
							onchange={(value) => {
								if (commonEntryBehaviorForm) commonEntryBehaviorForm.redirectTenantDiscoverToCommonEntry = value;
							}}
						/>
					</div>
					<div class="toggle-row">
						<div>
							<strong>Skip discovery when only one tenant exists</strong>
								<p>
									When enabled, the shared <code>/discover</code> flow immediately continues to the
									tenant login page if there is exactly one active tenant.
								</p>
							</div>
							<ToggleSwitch
								id="common-skip-if-only-one-tenant"
								checked={commonEntryBehaviorForm.skipDiscoveryIfOnlyOneTenant}
								disabled={!canEditPlatform || commonEntryBehaviorSaving}
								onchange={(value) => {
									if (commonEntryBehaviorForm) commonEntryBehaviorForm.skipDiscoveryIfOnlyOneTenant = value;
								}}
							/>
						</div>
					</div>

					<div class="actions">
						<button
							class="btn btn-primary"
							onclick={saveCommonEntryBehavior}
							disabled={!canEditPlatform || !hasCommonEntryBehaviorChanges || commonEntryBehaviorSaving || !!commonEntryBehaviorValidationError}
						>
							{#if commonEntryBehaviorSaving}Saving...{:else}Save Common Entry Behavior{/if}
						</button>
					</div>
				{/if}
			</section>
		{/if}

			<section class="panel">
				<div class="section-header">
					<div>
						<h2>{singleTenantMode ? 'Discovery Behavior' : 'Tenant Entry Override'}</h2>
						<p>
							{singleTenantMode
								? 'Controls how this tenant is resolved before login.'
								: `Controls direct entry behavior for ${currentTenantName}. This does not change the shared entry page at ${commonDiscoverDisplay}.`}
						</p>
					</div>
				<a class="subtle-link" href={`/admin/tenants/${currentTenantId}`}>Open Tenant Details</a>
			</div>

			{#if behaviorError}
				<div class="alert alert-error">{behaviorError}</div>
			{/if}
			{#if behaviorValidationError && behaviorValidationError !== behaviorError}
				<div class="alert alert-error">{behaviorValidationError}</div>
			{/if}
			{#if behaviorSuccess}
				<div class="alert alert-success">{behaviorSuccess}</div>
			{/if}

			{#if behaviorForm}
				{#if !singleTenantMode}
					<div class="override-toggle">
						<div>
							<strong>Enable tenant entry override</strong>
							<p>
								When disabled, this tenant uses the common entry behavior. Existing tenant values are
								kept but ignored until this override is enabled.
							</p>
						</div>
						<ToggleSwitch
							id="tenant-entry-override-enabled"
							checked={behaviorForm.overrideEnabled}
							disabled={!canEditTenant || behaviorSaving}
							onchange={(value) => {
								if (behaviorForm) behaviorForm.overrideEnabled = value;
							}}
						/>
					</div>
				{/if}

				{#if singleTenantMode || behaviorForm.overrideEnabled}
				<div class="form-grid">
					<div class="form-group">
						<label for="mode">Entry Mode</label>
						<select id="mode" bind:value={behaviorForm.mode} disabled={!canEditTenant || behaviorSaving}>
							<option value="tenant_only">Tenant-specific entry only</option>
							<option value="discovery_optional">Discovery optional</option>
							<option value="discovery_required">Discovery required</option>
						</select>
						<div class="inline-help">
							<p>{entryModeInfo(behaviorForm.mode).description}</p>
							<code>Example: {entryModeInfo(behaviorForm.mode).sample}</code>
						</div>
					</div>

					<div class="form-group">
						<label for="email-policy">Email Resolution</label>
						<select
							id="email-policy"
							bind:value={behaviorForm.emailResolutionPolicy}
							disabled={!canEditTenant || behaviorSaving || !behaviorForm.emailEnabled}
						>
							<option value="exact_email_then_domain">Exact email, then email-domain fallback</option>
							<option value="exact_email_only">Exact email only</option>
						</select>
						<div class="inline-help">
							<p>
								{emailResolutionInfo(behaviorForm.emailResolutionPolicy, behaviorForm.emailEnabled)
									.description}
							</p>
							<code>
								Example: {emailResolutionInfo(
									behaviorForm.emailResolutionPolicy,
									behaviorForm.emailEnabled
								).sample}
							</code>
						</div>
					</div>

					<div class="form-group">
						<label for="selection-policy">Selection Policy</label>
						<select
							id="selection-policy"
							bind:value={behaviorForm.selectionPolicy}
							disabled={!canEditTenant || behaviorSaving}
						>
							<option value="auto_if_single">Auto if single</option>
							<option value="always_select">Always select</option>
							<option value="select_if_multiple">Select if multiple</option>
							<option value="manual_only">Manual only</option>
						</select>
						<div class="inline-help">
							<p>{selectionPolicyInfo(behaviorForm.selectionPolicy).description}</p>
							<code>Example: {selectionPolicyInfo(behaviorForm.selectionPolicy).sample}</code>
						</div>
					</div>
				</div>

				<div class="methods-card">
					<h3>Enabled Discovery Methods</h3>
					<div class="toggle-row">
						<div>
							<strong>Email address</strong>
							<p>
								Allow users to identify the tenant from their email address, with optional
								email-domain fallback.
							</p>
						</div>
						<ToggleSwitch
							id="email-enabled"
							checked={behaviorForm.emailEnabled}
							disabled={!canEditTenant || behaviorSaving}
							onchange={(value) => {
								if (behaviorForm) behaviorForm.emailEnabled = value;
							}}
						/>
					</div>
					<div class="toggle-row">
						<div>
							<strong>Tenant code</strong>
							<p>Allow users to identify the tenant by tenant code.</p>
						</div>
						<ToggleSwitch
							id="tenant-code-enabled"
							checked={behaviorForm.tenantCodeEnabled}
							disabled={!canEditTenant || behaviorSaving}
							onchange={(value) => {
								if (behaviorForm) behaviorForm.tenantCodeEnabled = value;
							}}
						/>
					</div>
					<div class="toggle-row">
						<div>
							<strong>Tenant slug</strong>
							<p>Allow users to identify the tenant by tenant slug.</p>
						</div>
						<ToggleSwitch
							id="tenant-slug-enabled"
							checked={behaviorForm.tenantSlugEnabled}
							disabled={!canEditTenant || behaviorSaving}
							onchange={(value) => {
								if (behaviorForm) behaviorForm.tenantSlugEnabled = value;
							}}
						/>
					</div>
					<div class="toggle-row">
						<div>
							<strong>WAYF tenant chooser</strong>
							<p>Show a tenant-name dropdown populated from active tenants.</p>
						</div>
						<ToggleSwitch
							id="wayf-enabled"
							checked={behaviorForm.wayfEnabled}
							disabled={!canEditTenant || behaviorSaving}
							onchange={(value) => {
								if (behaviorForm) behaviorForm.wayfEnabled = value;
							}}
						/>
					</div>
				</div>

				<div class="toggle-list">
					<div class="toggle-row">
						<div>
							<strong>Allow manual tenant entry</strong>
							<p>Show manual entry fallback when automatic discovery cannot resolve a tenant.</p>
						</div>
						<ToggleSwitch
							id="allow-manual-entry"
							checked={behaviorForm.allowManualTenantEntry}
							disabled={!canEditTenant || behaviorSaving}
							onchange={(value) => {
								if (behaviorForm) behaviorForm.allowManualTenantEntry = value;
							}}
						/>
					</div>
					<div class="toggle-row">
						<div>
							<strong>Remember last tenant</strong>
							<p>Remember the tenant that was resolved most recently for this browser.</p>
						</div>
						<ToggleSwitch
							id="remember-last-tenant"
							checked={behaviorForm.rememberLastTenant}
							disabled={!canEditTenant || behaviorSaving}
							onchange={(value) => {
								if (behaviorForm) behaviorForm.rememberLastTenant = value;
							}}
						/>
					</div>
					<div class="toggle-row">
						<div>
							<strong>Redirect default login to discovery</strong>
							<p>Redirect common-entry `/login` requests to `/discover` when appropriate.</p>
						</div>
						<ToggleSwitch
							id="redirect-default-login"
							checked={behaviorForm.redirectDefaultLoginToDiscovery}
							disabled={!canEditTenant || behaviorSaving}
							onchange={(value) => {
								if (behaviorForm) behaviorForm.redirectDefaultLoginToDiscovery = value;
							}}
						/>
					</div>
					<div class="toggle-row">
						<div>
							<strong>Require common discovery before tenant login</strong>
							<p>
								When enabled, direct visits to this tenant's <code>/login</code> must pass through the
								shared discover screen first. Challenge-based OIDC login is unchanged.
							</p>
						</div>
						<ToggleSwitch
							id="require-discovery-before-login"
							checked={behaviorForm.requireCommonDiscoveryBeforeLogin}
							disabled={!canEditTenant || behaviorSaving}
							onchange={(value) => {
								if (behaviorForm) behaviorForm.requireCommonDiscoveryBeforeLogin = value;
							}}
						/>
					</div>
					<div class="toggle-row">
						<div>
							<strong>Redirect tenant discover to common entry</strong>
							<p>Redirect this tenant's host and vanity host <code>/discover</code> to common entry.</p>
						</div>
						<ToggleSwitch
							id="redirect-tenant-discover"
							checked={behaviorForm.redirectTenantDiscoverToCommonEntry}
							disabled={!canEditTenant || behaviorSaving}
							onchange={(value) => {
								if (behaviorForm) behaviorForm.redirectTenantDiscoverToCommonEntry = value;
							}}
						/>
					</div>
				</div>

				<div class="actions">
					<button
						class="btn btn-primary"
						onclick={saveBehavior}
						disabled={!canEditTenant || !hasBehaviorChanges || behaviorSaving || !!behaviorValidationError}
					>
						{#if behaviorSaving}Saving...{:else}Save Discovery Behavior{/if}
					</button>
				</div>
				{:else}
					<div class="collapsed-override">
						Common entry behavior is active for this tenant. Enable the override to configure tenant-specific entry behavior.
					</div>
					<div class="actions">
						<button
							class="btn btn-primary"
							onclick={saveBehavior}
							disabled={!canEditTenant || !hasBehaviorChanges || behaviorSaving}
						>
							{#if behaviorSaving}Saving...{:else}Save Tenant Entry Override{/if}
						</button>
					</div>
				{/if}
			{/if}
		</section>

		{#if !singleTenantMode}
			<section class="panel">
				<div class="section-header">
					<div>
						<h2>Common Entry Screen Content</h2>
						<p>Text, branding, and theme used by the shared entry page at <code>{commonDiscoverDisplay}</code>.</p>
					</div>
				</div>

				{#if commonEntryError}
					<div class="alert alert-error">{commonEntryError}</div>
				{/if}
				{#if commonEntrySuccess}
					<div class="alert alert-success">{commonEntrySuccess}</div>
				{/if}
				{#if !canEditPlatform}
					<div class="alert alert-info">
						Common entry screen content is a platform setting. Tenant admins can review it, but cannot edit it.
					</div>
				{/if}

				{#if commonEntryForm}
					<p class="field-hint section-hint">
						Blank values are prefilled with the effective defaults currently shown on the shared discovery screen.
					</p>
					<div class="form-grid two-column">
						<div class="form-group">
							<label for="common-theme">Theme</label>
							<select id="common-theme" bind:value={commonEntryForm.theme} disabled={!canEditPlatform || commonEntrySaving}>
								<option value="">Inherit / default</option>
								<option value="light">light</option>
								<option value="dark">dark</option>
							</select>
						</div>
						<div class="form-group">
							<label for="common-variant">Variant</label>
							<select id="common-variant" bind:value={commonEntryForm.variant} disabled={!canEditPlatform || commonEntrySaving}>
								<option value="">Inherit / default</option>
								<option value="beige">beige</option>
								<option value="blue-gray">blue-gray</option>
								<option value="green">green</option>
								<option value="brown">brown</option>
								<option value="navy">navy</option>
								<option value="slate">slate</option>
							</select>
						</div>
						<div class="form-group">
							<label for="common-brand-name">Brand Name</label>
							<input id="common-brand-name" type="text" bind:value={commonEntryForm.brandName} disabled={!canEditPlatform || commonEntrySaving} />
						</div>
						<div class="form-group full-width">
							<label for="common-logo-url">Logo URL</label>
							<input id="common-logo-url" type="url" bind:value={commonEntryForm.logoUrl} disabled={!canEditPlatform || commonEntrySaving} />
						</div>
						<div class="form-group full-width">
							<label for="common-page-title">Page Title</label>
							<input id="common-page-title" type="text" bind:value={commonEntryForm.pageTitle} disabled={!canEditPlatform || commonEntrySaving} />
						</div>
						<div class="form-group full-width">
							<label for="common-kicker">Kicker Text</label>
							<input id="common-kicker" type="text" bind:value={commonEntryForm.kickerText} disabled={!canEditPlatform || commonEntrySaving} />
						</div>
						<div class="form-group full-width">
							<label for="common-title">Title Text</label>
							<input id="common-title" type="text" bind:value={commonEntryForm.titleText} disabled={!canEditPlatform || commonEntrySaving} />
						</div>
						<div class="form-group full-width">
							<label for="common-subtitle">Subtitle Text</label>
							<textarea id="common-subtitle" rows="3" bind:value={commonEntryForm.subtitleText} disabled={!canEditPlatform || commonEntrySaving}></textarea>
						</div>
					</div>
					<div class="actions">
						<button class="btn btn-primary" onclick={saveCommonEntryUi} disabled={!canEditPlatform || !hasCommonEntryChanges || commonEntrySaving}>
							{#if commonEntrySaving}Saving...{:else}Save Common Entry Screen{/if}
						</button>
					</div>
				{/if}
			</section>
		{/if}

		<section class="panel">
			<div class="section-header">
				<div>
					<h2>Tenant Override Screen Content</h2>
					<p>
						Overrides for tenant-specific discovery screens on <strong>{currentTenantName}</strong>.
						In multi-tenant mode, <code>/discover</code> on tenant hosts usually redirects to
						<code>/login</code>, so these values mainly apply to flows that still render discovery
						directly, such as invitation or app-hint resolution.
					</p>
				</div>
			</div>

			{#if tenantUiError}
				<div class="alert alert-error">{tenantUiError}</div>
			{/if}
			{#if tenantUiSuccess}
				<div class="alert alert-success">{tenantUiSuccess}</div>
			{/if}

			{#if tenantUiForm}
				{#if !singleTenantMode}
					<div class="override-toggle">
						<div>
							<strong>Enable tenant screen content override</strong>
							<p>
								When disabled, common discovery screen content applies. Existing tenant screen values
								are kept but ignored until this override is enabled.
							</p>
						</div>
						<ToggleSwitch
							id="tenant-ui-override-enabled"
							checked={tenantUiForm.overrideEnabled}
							disabled={!canEditTenant || tenantUiSaving}
							onchange={(value) => {
								if (tenantUiForm) tenantUiForm.overrideEnabled = value;
							}}
						/>
					</div>
				{/if}

				{#if singleTenantMode || tenantUiForm.overrideEnabled}
				<p class="field-hint section-hint">
					Fields are prefilled with the effective values currently used for this tenant. Saving writes them as explicit tenant overrides.
				</p>
				<div class="form-grid two-column">
					<div class="form-group">
						<label for="tenant-inherit">Inherit from Login UI</label>
						<ToggleSwitch
							id="tenant-inherit"
							checked={tenantUiForm.inheritFromLoginUi}
							disabled={!canEditTenant || tenantUiSaving}
							onchange={(value) => {
								if (tenantUiForm) tenantUiForm.inheritFromLoginUi = value;
							}}
						/>
					</div>
					<div class="form-group">
						<label for="tenant-theme">Theme</label>
						<select id="tenant-theme" bind:value={tenantUiForm.theme} disabled={!canEditTenant || tenantUiSaving}>
							<option value="">Inherit / default</option>
							<option value="light">light</option>
							<option value="dark">dark</option>
						</select>
					</div>
					<div class="form-group">
						<label for="tenant-variant">Variant</label>
						<select id="tenant-variant" bind:value={tenantUiForm.variant} disabled={!canEditTenant || tenantUiSaving}>
							<option value="">Inherit / default</option>
							<option value="beige">beige</option>
							<option value="blue-gray">blue-gray</option>
							<option value="green">green</option>
							<option value="brown">brown</option>
							<option value="navy">navy</option>
							<option value="slate">slate</option>
						</select>
					</div>
					<div class="form-group">
						<label for="tenant-brand-name">Brand Name</label>
						<input id="tenant-brand-name" type="text" bind:value={tenantUiForm.brandName} disabled={!canEditTenant || tenantUiSaving} />
					</div>
					<div class="form-group full-width">
						<label for="tenant-logo-url">Logo URL</label>
						<input id="tenant-logo-url" type="url" bind:value={tenantUiForm.logoUrl} disabled={!canEditTenant || tenantUiSaving} />
					</div>
					<div class="form-group full-width">
						<label for="tenant-page-title">Page Title</label>
						<input id="tenant-page-title" type="text" bind:value={tenantUiForm.pageTitle} disabled={!canEditTenant || tenantUiSaving} />
					</div>
					<div class="form-group full-width">
						<label for="tenant-kicker">Kicker Text</label>
						<input id="tenant-kicker" type="text" bind:value={tenantUiForm.kickerText} disabled={!canEditTenant || tenantUiSaving} />
					</div>
					<div class="form-group full-width">
						<label for="tenant-title">Title Text</label>
						<input id="tenant-title" type="text" bind:value={tenantUiForm.titleText} disabled={!canEditTenant || tenantUiSaving} />
					</div>
					<div class="form-group full-width">
						<label for="tenant-subtitle">Subtitle Text</label>
						<textarea id="tenant-subtitle" rows="3" bind:value={tenantUiForm.subtitleText} disabled={!canEditTenant || tenantUiSaving}></textarea>
					</div>
				</div>
				<div class="actions">
					<button class="btn btn-primary" onclick={saveTenantUi} disabled={!canEditTenant || !hasTenantUiChanges || tenantUiSaving}>
						{#if tenantUiSaving}Saving...{:else}Save Tenant Override{/if}
					</button>
				</div>
				{:else}
					<div class="collapsed-override">
						Common discovery screen content is active for this tenant. Enable the override to customize tenant-specific discovery screens.
					</div>
					<div class="actions">
						<button class="btn btn-primary" onclick={saveTenantUi} disabled={!canEditTenant || !hasTenantUiChanges || tenantUiSaving}>
							{#if tenantUiSaving}Saving...{:else}Save Tenant Screen Override{/if}
						</button>
					</div>
				{/if}
			{/if}
		</section>
	{/if}
</div>

<style>
	.page-shell {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.page-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
	}

	.page-title {
		margin: 0 0 0.25rem;
		font-size: 1.5rem;
	}

	.page-description {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	.panel {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-card);
		padding: 1.25rem;
	}

	.section-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.section-header h2,
	.methods-card h3 {
		margin: 0;
	}

	.section-header p,
	.methods-card p {
		margin: 0.25rem 0 0;
		color: var(--text-secondary);
	}

	.subtle-link {
		font-size: 0.875rem;
	}

	.form-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		gap: 1rem;
	}

	.two-column {
		grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
	}

	.form-group {
		display: grid;
		gap: 0.4rem;
	}

	.field-hint {
		font-size: 0.875rem;
		color: var(--text-secondary);
		margin: 0;
	}

	.inline-help {
		display: grid;
		gap: 0.35rem;
		margin-top: 0.25rem;
		padding: 0.75rem 0.85rem;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--bg-subtle);
	}

	.inline-help p {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
		line-height: 1.45;
	}

	.inline-help code {
		color: var(--text-primary);
		font-size: 0.8125rem;
		white-space: normal;
		overflow-wrap: anywhere;
	}

	.section-hint {
		margin: 0 0 1rem;
	}

	.form-group.full-width {
		grid-column: 1 / -1;
	}

	label {
		font-weight: 600;
	}

	input,
	select,
	textarea {
		width: 100%;
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 0.8rem 0.9rem;
		background: var(--bg-card);
		color: var(--text-primary);
	}

	.methods-card,
	.toggle-list {
		display: grid;
		gap: 0.75rem;
		margin-top: 1rem;
	}

	.methods-card {
		padding: 1rem;
		border: 1px solid var(--border);
		border-radius: 16px;
		background: var(--bg-glass);
	}

	.toggle-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.9rem 0;
		border-bottom: 1px solid var(--border);
	}

	.toggle-row:last-child {
		border-bottom: none;
	}

	.toggle-row p {
		font-size: 0.9rem;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 1rem;
	}

	.alert {
		margin-bottom: 1rem;
		padding: 0.9rem 1rem;
		border-radius: 12px;
	}

	.alert-error {
		background: rgba(239, 68, 68, 0.1);
		color: #b91c1c;
	}

	.alert-success {
		background: rgba(16, 185, 129, 0.12);
		color: #047857;
	}

	.alert-info {
		background: rgba(59, 130, 246, 0.1);
		color: #1d4ed8;
	}

	.override-toggle {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
		padding: 0.95rem 1rem;
		border: 1px solid var(--border);
		border-radius: 12px;
		background: var(--bg-glass);
	}

	.override-toggle p {
		margin: 0.3rem 0 0;
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

	.collapsed-override {
		padding: 1rem;
		border: 1px dashed var(--border);
		border-radius: 12px;
		background: var(--bg-subtle);
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

	@media (max-width: 700px) {
		.section-header,
		.toggle-row,
		.override-toggle {
			flex-direction: column;
			align-items: flex-start;
		}

		.actions {
			justify-content: stretch;
		}

		.actions .btn {
			width: 100%;
		}
	}
</style>
