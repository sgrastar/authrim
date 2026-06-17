<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { getTenantInfo } from '$lib/api/admin-info';
	import {
		adminSettingsAPI,
		adminUiConfigAPI,
		scopedSettingsAPI,
		isInternalSetting,
		SettingsConflictError,
		convertPatchesToAPIRequest,
		type CategorySettings,
		type CategoryMetaFull,
		type SettingMetaItem,
		type UIPatch,
		type SettingSource,
		type UIConfigResponse,
		type ScopeContext
	} from '$lib/api/admin-settings';
	import { InheritanceIndicator } from '$lib/components/admin';
	import { ToggleSwitch } from '$lib/components';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import { LL } from '$i18n/i18n-svelte';

	const CATEGORY = 'login-ui';

	// State
	let meta = $state<CategoryMetaFull | null>(null);
	let settings = $state<CategorySettings | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let successMessage = $state('');
	let tenantSettings = $state<CategorySettings | null>(null);
	let trustedOriginsInput = $state('');
	let initialTrustedOriginsInput = $state('');
	let trustedOriginsError = $state('');
	let trustedOriginsSuccessMessage = $state('');
	let trustedOriginsSaving = $state(false);
	let uiConfigError = $state('');
	let uiConfigSuccessMessage = $state('');
	let uiConfigSaving = $state(false);
	let loginUiAvailable = $state(true);
	let loginUiConfigured = $state(false);
	let loginUiStatusMessage = $state('');
	let uiConfig = $state<UIConfigResponse | null>(null);
	type UIPathKey = keyof UIConfigResponse['config']['paths'];
	type UIConfigForm = {
		baseUrl: string;
		paths: Record<UIPathKey, string>;
	};
	let uiConfigForm = $state<UIConfigForm>({
		baseUrl: '',
		paths: {
			login: '',
			consent: '',
			reauth: '',
			error: '',
			device: '',
			deviceAuthorize: '',
			logoutComplete: '',
			loggedOut: '',
			register: ''
		}
	});
	let initialUiConfigForm = $state<UIConfigForm | null>(null);

	// Track pending changes
	let pendingPatches = $state<UIPatch[]>([]);

	// Get current scope context from store
	let scopeContext = $derived(settingsContext.scopeContext as ScopeContext);
	let canEdit = $derived(settingsContext.canEditAtCurrentScope());
	let canEditGlobalUiConfig = $derived(canEdit);
	let canEditLoginUiSettings = $derived(canEdit);
	let canEditTrustedOrigins = $derived(canEdit);
	let currentLevel = $derived(settingsContext.currentLevel);

	// Derived: Check if there are unsaved changes
	const hasChanges = $derived(pendingPatches.length > 0);
	const hasTrustedOriginsChanges = $derived(trustedOriginsInput !== initialTrustedOriginsInput);
	const hasUiConfigChanges = $derived(
		initialUiConfigForm
			? JSON.stringify(uiConfigForm) !== JSON.stringify(initialUiConfigForm)
			: false
	);
	const trustedOriginsDraft = $derived.by(() => parseTrustedOriginsDraft(trustedOriginsInput));

	// Load data on mount
	onMount(async () => {
		await settingsContext.initialize();
		await loadData();
	});

	// Track previous scope context to detect changes
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
		uiConfigError = '';
		pendingPatches = [];

		try {
			const selectedTenantId = resolveSelectedTenantId();
			const tenantInfo = await getTenantInfo(selectedTenantId);
			const uiConfigResult = await adminUiConfigAPI.get();
			const tenantSettingsResult = await adminSettingsAPI.getSettings('tenant', selectedTenantId);
			const nextUiConfigForm: UIConfigForm = {
				baseUrl: uiConfigResult.config.baseUrl ?? '',
				paths: { ...uiConfigResult.config.paths }
			};
			uiConfig = uiConfigResult;
			tenantSettings = tenantSettingsResult;
			trustedOriginsInput = formatOriginsForEditor(
				tenantSettingsResult.values['tenant.allowed_origins']
			);
			initialTrustedOriginsInput = trustedOriginsInput;
			uiConfigForm = nextUiConfigForm;
			initialUiConfigForm = {
				baseUrl: nextUiConfigForm.baseUrl,
				paths: { ...nextUiConfigForm.paths }
			};
			loginUiAvailable = tenantInfo.components.login_ui;
			loginUiConfigured = !!uiConfigResult.config.baseUrl;
			loginUiStatusMessage = !loginUiAvailable
				? $LL.admin_login_ui_status_not_deployed()
				: loginUiConfigured
					? ''
					: $LL.admin_login_ui_status_not_configured();

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
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_login_ui_error_load();
		} finally {
			loading = false;
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

	// Get current value (considering pending patches)
	function getCurrentValue(key: string): unknown {
		const patch = pendingPatches.find((p) => p.key === key);
		if (patch) {
			if (patch.op === 'set') return patch.value;
			if (patch.op === 'disable') return false;
			if (patch.op === 'clear') return settings?.values[key];
		}
		return settings?.values[key];
	}

	// Check if a setting is locked by environment variable
	function isLockedByEnv(key: string): boolean {
		return settings?.sources[key] === 'env';
	}

	// Check if a setting is locked
	function isSettingLocked(key: string, settingMeta: SettingMetaItem): boolean {
		if (!canEditLoginUiSettings) return true;
		if (isLockedByEnv(key)) return true;
		if (isInternalSetting(settingMeta)) return true;
		return false;
	}

	// Check if a setting should be hidden (in_development status)
	function shouldHideSetting(settingMeta: SettingMetaItem): boolean {
		return settingMeta.status === 'in_development';
	}

	// Handle value change
	function handleChange(key: string, value: unknown) {
		pendingPatches = pendingPatches.filter((p) => p.key !== key);
		const originalValue = settings?.values[key];
		if (value !== originalValue) {
			pendingPatches = [...pendingPatches, { op: 'set', key, value }];
		}
	}

	// Discard all changes
	function discardChanges() {
		pendingPatches = [];
	}

	function discardUiConfigChanges() {
		if (!initialUiConfigForm) return;
		uiConfigForm = {
			baseUrl: initialUiConfigForm.baseUrl,
			paths: { ...initialUiConfigForm.paths }
		};
		uiConfigError = '';
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

	async function saveUiConfig() {
		if (!canEditGlobalUiConfig) {
			uiConfigError = $LL.admin_login_ui_error_no_config_permission();
			return;
		}

		uiConfigSaving = true;
		uiConfigError = '';
		uiConfigSuccessMessage = '';

		try {
			await adminUiConfigAPI.update({
				baseUrl: uiConfigForm.baseUrl.trim() || null,
				paths: { ...uiConfigForm.paths }
			});
			uiConfigSuccessMessage = $LL.admin_login_ui_config_updated();
			await loadData();
			setTimeout(() => {
				uiConfigSuccessMessage = '';
			}, 3000);
		} catch (err) {
			uiConfigError = err instanceof Error ? err.message : $LL.admin_login_ui_error_update_config();
		} finally {
			uiConfigSaving = false;
		}
	}

	// Save changes
	async function saveChanges() {
		if (!settings || pendingPatches.length === 0) return;

		if (!canEditLoginUiSettings) {
			error = $LL.admin_login_ui_error_no_settings_permission();
			return;
		}

		saving = true;
		error = '';
		successMessage = '';

		try {
			const patchData = convertPatchesToAPIRequest(pendingPatches);

			const result = await scopedSettingsAPI.updateSettingsForScope(CATEGORY, scopeContext, {
				ifMatch: settings.version,
				...patchData
			});

			pendingPatches = [];

			const appliedCount = result.applied.length + result.cleared.length + result.disabled.length;
			successMessage = $LL.admin_login_ui_updated_settings({ count: appliedCount });

			await loadData();

			setTimeout(() => {
				successMessage = '';
			}, 3000);
		} catch (err) {
			if (err instanceof SettingsConflictError) {
				error = $LL.admin_login_ui_settings_conflict();
			} else {
				error = err instanceof Error ? err.message : $LL.admin_login_ui_error_save_settings();
			}
		} finally {
			saving = false;
		}
	}

	// Render input based on setting type
	function getInputType(settingMeta: SettingMetaItem): string {
		switch (settingMeta.type) {
			case 'number':
			case 'duration':
				return 'number';
			case 'boolean':
				return 'checkbox';
			default:
				return 'text';
		}
	}
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
	{#if !canEditGlobalUiConfig && !canEditLoginUiSettings}
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

		{#if uiConfigError}
			<div class="alert alert-error">{uiConfigError}</div>
		{/if}

		{#if uiConfigSuccessMessage}
			<div class="alert alert-success">{uiConfigSuccessMessage}</div>
		{/if}

		{#if trustedOriginsError}
			<div class="alert alert-error">{trustedOriginsError}</div>
		{/if}

		{#if trustedOriginsSuccessMessage}
			<div class="alert alert-success">{trustedOriginsSuccessMessage}</div>
		{/if}

		{#if !loading && uiConfig}
			<section class="panel">
				<div class="section-header">
					<div>
						<h2 class="section-title">{$LL.admin_login_ui_global_config_title()}</h2>
						<p class="section-description">
							{$LL.admin_login_ui_global_config_description()}
						</p>
					</div>
					<span class="config-source-badge"
						>{$LL.admin_login_ui_source({ source: uiConfig.source })}</span
					>
				</div>

				<div class="settings-form-card">
					<div class="setting-item" class:modified={hasUiConfigChanges}>
						<div class="setting-item-content">
							<div class="setting-info">
								<div class="setting-label-row">
									<label for="ui-config-base-url" class="setting-label"
										>{$LL.admin_login_ui_global_base_url()}</label
									>
									{#if hasUiConfigChanges}
										<span class="setting-modified">{$LL.admin_login_ui_modified()}</span>
									{/if}
								</div>
								<p class="setting-description">
									{$LL.admin_login_ui_global_base_url_description()}
								</p>
							</div>

							<div class="setting-control">
								<input
									type="url"
									id="ui-config-base-url"
									value={uiConfigForm.baseUrl}
									disabled={!canEditGlobalUiConfig}
									placeholder="https://single-ar-login-ui.pages.dev"
									oninput={(e) => {
										uiConfigForm = {
											...uiConfigForm,
											baseUrl: e.currentTarget.value
										};
									}}
									class="settings-input"
								/>
							</div>
						</div>
					</div>

					{#each Object.entries(uiConfig.metadata) as [key, metaItem] (key)}
						<div class="setting-item" class:modified={hasUiConfigChanges}>
							<div class="setting-item-content">
								<div class="setting-info">
									<label for={`ui-path-${key}`} class="setting-label">{metaItem.label}</label>
									<p class="setting-description">{metaItem.description}</p>
								</div>

								<div class="setting-control">
									<input
										type="text"
										id={`ui-path-${key}`}
										value={uiConfigForm.paths[key as UIPathKey]}
										disabled={!canEditGlobalUiConfig}
										oninput={(e) => {
											uiConfigForm = {
												...uiConfigForm,
												paths: {
													...uiConfigForm.paths,
													[key]: e.currentTarget.value
												}
											};
										}}
										class="settings-input"
									/>
								</div>
							</div>
						</div>
					{/each}
				</div>

				<div class="form-actions">
					<button
						onclick={discardUiConfigChanges}
						disabled={!hasUiConfigChanges || uiConfigSaving || !canEditGlobalUiConfig}
						class="btn btn-secondary"
					>
						{$LL.admin_login_ui_discard_changes()}
					</button>
					<button
						onclick={saveUiConfig}
						disabled={!hasUiConfigChanges || uiConfigSaving || !canEditGlobalUiConfig}
						class="btn btn-primary"
					>
						{uiConfigSaving ? $LL.admin_login_ui_saving() : $LL.admin_login_ui_save_global_config()}
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
			<!-- Settings form -->
			<div class="settings-form-card">
				{#each Object.entries(meta.settings).filter(([_key, s]) => !shouldHideSetting(s)) as [key, settingMeta] (key)}
					{@const value = getCurrentValue(key)}
					{@const locked = isSettingLocked(key, settingMeta)}
					{@const hasPendingChange = pendingPatches.some((p) => p.key === key)}
					<div class="setting-item" class:modified={hasPendingChange}>
						<div class="setting-item-content">
							<div class="setting-info">
								<div class="setting-label-row">
									<label for={key} class="setting-label">{settingMeta.label}</label>
									<InheritanceIndicator
										source={(settings?.sources[key] as SettingSource) || 'default'}
										currentScope={currentLevel}
										{canEdit}
										compact={true}
									/>
									{#if locked && !isLockedByEnv(key)}
										<span class="setting-locked">{$LL.admin_login_ui_locked()}</span>
									{/if}
									{#if hasPendingChange}
										<span class="setting-modified">{$LL.admin_login_ui_modified()}</span>
									{/if}
								</div>
								<p class="setting-description">
									{settingMeta.description}
									{#if settingMeta.unit}
										<span class="setting-unit">({settingMeta.unit})</span>
									{/if}
								</p>
							</div>

							<div class="setting-control">
								{#if settingMeta.type === 'boolean'}
									<ToggleSwitch
										checked={Boolean(value)}
										disabled={locked}
										id={key}
										onchange={(newValue) => handleChange(key, newValue)}
									/>
								{:else if settingMeta.type === 'enum' && settingMeta.enum}
									<select
										id={key}
										value={String(value)}
										disabled={locked}
										onchange={(e) => handleChange(key, e.currentTarget.value)}
										class="settings-select"
									>
										{#each settingMeta.enum as option (option)}
											<option value={option}>{option}</option>
										{/each}
									</select>
								{:else}
									<input
										type={getInputType(settingMeta)}
										id={key}
										value={String(value ?? '')}
										disabled={locked}
										min={settingMeta.min}
										max={settingMeta.max}
										oninput={(e) => {
											const inputValue =
												settingMeta.type === 'number' || settingMeta.type === 'duration'
													? Number(e.currentTarget.value)
													: e.currentTarget.value;
											handleChange(key, inputValue);
										}}
										class="settings-input"
									/>
								{/if}
								{#if settingMeta.min !== undefined || settingMeta.max !== undefined}
									<p class="settings-range-hint">
										{#if settingMeta.min !== undefined && settingMeta.max !== undefined}
											{$LL.admin_login_ui_range({
												min: settingMeta.min,
												max: settingMeta.max
											})}
										{:else if settingMeta.min !== undefined}
											{$LL.admin_login_ui_min({ min: settingMeta.min })}
										{:else if settingMeta.max !== undefined}
											{$LL.admin_login_ui_max({ max: settingMeta.max })}
										{/if}
									</p>
								{/if}
							</div>
						</div>
					</div>
				{/each}
			</div>

			<!-- Action buttons -->
			<div class="settings-actions">
				<button
					onclick={discardChanges}
					disabled={!hasChanges || saving || !canEditLoginUiSettings}
					class="btn btn-secondary"
				>
					{$LL.admin_login_ui_discard_changes()}
				</button>
				<button
					onclick={saveChanges}
					disabled={!hasChanges || saving || !canEditLoginUiSettings}
					class="btn btn-primary"
				>
					{saving
						? $LL.admin_login_ui_saving()
						: `${$LL.admin_login_ui_save_changes()}${hasChanges ? ` (${pendingPatches.length})` : ''}`}
				</button>
			</div>

			<!-- Coming Soon Section -->
			<div class="coming-soon-section">
				<h2 class="coming-soon-title">{$LL.admin_login_ui_coming_soon_title()}</h2>
				<p class="coming-soon-description">{$LL.admin_login_ui_coming_soon_description()}</p>
				<div class="coming-soon-list">
					<div class="coming-soon-item">
						<span class="coming-soon-label">{$LL.admin_login_ui_coming_soon_favicon()}</span>
						<span class="coming-soon-desc">{$LL.admin_login_ui_coming_soon_favicon_desc()}</span>
					</div>
					<div class="coming-soon-item">
						<span class="coming-soon-label">{$LL.admin_login_ui_coming_soon_background()}</span>
						<span class="coming-soon-desc">{$LL.admin_login_ui_coming_soon_background_desc()}</span>
					</div>
					<div class="coming-soon-item">
						<span class="coming-soon-label">{$LL.admin_login_ui_coming_soon_custom_css()}</span>
						<span class="coming-soon-desc">{$LL.admin_login_ui_coming_soon_custom_css_desc()}</span>
					</div>
					<div class="coming-soon-item">
						<span class="coming-soon-label">{$LL.admin_login_ui_coming_soon_header()}</span>
						<span class="coming-soon-desc">{$LL.admin_login_ui_coming_soon_header_desc()}</span>
					</div>
					<div class="coming-soon-item">
						<span class="coming-soon-label">{$LL.admin_login_ui_coming_soon_footer()}</span>
						<span class="coming-soon-desc">{$LL.admin_login_ui_coming_soon_footer_desc()}</span>
					</div>
					<div class="coming-soon-item">
						<span class="coming-soon-label">{$LL.admin_login_ui_coming_soon_footer_links()}</span>
						<span class="coming-soon-desc"
							>{$LL.admin_login_ui_coming_soon_footer_links_desc()}</span
						>
					</div>
					<div class="coming-soon-item">
						<span class="coming-soon-label">{$LL.admin_login_ui_coming_soon_custom_blocks()}</span>
						<span class="coming-soon-desc"
							>{$LL.admin_login_ui_coming_soon_custom_blocks_desc()}</span
						>
					</div>
				</div>
			</div>
		{/if}
	</div>
</AdminPageShell>

<style>
	.settings-detail-page {
		max-width: 980px;
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

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 16px;
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
