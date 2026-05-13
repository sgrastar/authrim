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
	import { settingsContext } from '$lib/stores/settings-context.svelte';

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
			const tenantSettingsResult = await adminSettingsAPI.getSettings(
				'tenant',
				selectedTenantId
			);
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
				? 'Built-in Login UI is not deployed for this environment. You can still configure a global Login UI URL below.'
				: loginUiConfigured
					? ''
					: 'Global Login UI URL is not configured yet. Configure it below.';

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
			error = err instanceof Error ? err.message : 'Failed to load settings';
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
			throw new Error('Tenant context is required to load Login UI settings');
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
			throw new Error('Origin cannot be empty.');
		}

		// Admin UI exposes web_origin_registry semantics; the current backend stores
		// these entries in tenant allowed origins until rp_origin_registry exists.
		if (trimmed.includes('*')) {
			if (
				!/^https:\/\/\*\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?$/i.test(
					trimmed
				)
			) {
				throw new Error(
					`Invalid wildcard origin "${value}". Use a host-only pattern such as https://*.example.com.`
				);
			}
			return trimmed;
		}

		let parsed: URL;
		try {
			parsed = new URL(trimmed);
		} catch {
			throw new Error(`Invalid origin "${value}".`);
		}

		if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalHost(parsed.hostname))) {
			throw new Error(`Origin "${value}" must use HTTPS, except for localhost.`);
		}

		if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
			throw new Error(`Origin "${value}" must not include a path, query, or fragment.`);
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
				error: err instanceof Error ? err.message : 'Invalid trusted origins.'
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
			trustedOriginsError = 'You do not have permission to edit trusted origins.';
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

			trustedOriginsSuccessMessage = 'Trusted origins updated.';
			await loadData();
			setTimeout(() => {
				trustedOriginsSuccessMessage = '';
			}, 3000);
		} catch (err) {
			if (err instanceof SettingsConflictError) {
				trustedOriginsError = 'Trusted origins were modified by another user. Please reload and try again.';
			} else {
				trustedOriginsError =
					err instanceof Error ? err.message : 'Failed to update trusted origins.';
			}
		} finally {
			trustedOriginsSaving = false;
		}
	}

	async function saveUiConfig() {
		if (!canEditGlobalUiConfig) {
			uiConfigError = 'You do not have permission to edit Login UI configuration.';
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
			uiConfigSuccessMessage = 'Global Login UI configuration updated.';
			await loadData();
			setTimeout(() => {
				uiConfigSuccessMessage = '';
			}, 3000);
		} catch (err) {
			uiConfigError = err instanceof Error ? err.message : 'Failed to update UI config';
		} finally {
			uiConfigSaving = false;
		}
	}

	// Save changes
	async function saveChanges() {
		if (!settings || pendingPatches.length === 0) return;

		if (!canEditLoginUiSettings) {
			error = 'You do not have permission to edit settings at this scope level';
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
			successMessage = `Successfully updated ${appliedCount} setting${appliedCount !== 1 ? 's' : ''}`;

			await loadData();

			setTimeout(() => {
				successMessage = '';
			}, 3000);
		} catch (err) {
			if (err instanceof SettingsConflictError) {
				error = `Settings were modified by another user. Please reload and try again.`;
			} else {
				error = err instanceof Error ? err.message : 'Failed to save settings';
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

<div class="settings-detail-page">
	<!-- Header -->
	<div class="settings-detail-header">
		<div class="settings-header-row">
			<h1 class="page-title">Login UI</h1>
			<!-- Scope Badge -->
			<span class="scope-badge {currentLevel}">
				{currentLevel === 'platform' ? 'Platform' : currentLevel === 'tenant' ? 'Tenant' : 'Client'}
			</span>
			{#if !canEditGlobalUiConfig && !canEditLoginUiSettings}
				<span class="readonly-badge">Read-only</span>
			{/if}
		</div>
		<p class="page-description">Customize the appearance of the login page for end users.</p>
	</div>

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
					<h2 class="section-title">Global UI Configuration</h2>
					<p class="section-description">
						Configure the global Login UI base URL and page paths used by the authorization flow.
					</p>
				</div>
				<span class="config-source-badge">Source: {uiConfig.source}</span>
			</div>

			<div class="settings-form-card">
				<div class="setting-item" class:modified={hasUiConfigChanges}>
					<div class="setting-item-content">
						<div class="setting-info">
							<div class="setting-label-row">
								<label for="ui-config-base-url" class="setting-label">Global UI Base URL</label>
								{#if hasUiConfigChanges}
									<span class="setting-modified">Modified</span>
								{/if}
							</div>
							<p class="setting-description">
								Base URL for the shared Login UI deployment. Must use HTTPS except localhost.
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
					Discard Changes
				</button>
				<button
					onclick={saveUiConfig}
					disabled={!hasUiConfigChanges || uiConfigSaving || !canEditGlobalUiConfig}
					class="btn btn-primary"
				>
					{uiConfigSaving ? 'Saving...' : 'Save Global UI Configuration'}
				</button>
			</div>
		</section>
	{/if}

	{#if !loading && tenantSettings}
		<section class="panel">
			<div class="section-header">
				<div>
					<h2 class="section-title">Trusted Origins</h2>
					<p class="section-description">
						Tenant-wide origins allowed to call browser-based auth endpoints such as passkey
						registration and direct auth. Enter one origin or wildcard pattern per line.
					</p>
				</div>
				<span class="config-source-badge">Tenant Setting</span>
			</div>

			<div class="textarea-setting" class:modified={hasTrustedOriginsChanges}>
				<div class="setting-label-row">
					<label for="trusted-origins" class="setting-label">Allowed Browser Origins</label>
					{#if hasTrustedOriginsChanges}
						<span class="setting-modified">Modified</span>
					{/if}
				</div>
				<p class="setting-description">
					This is the tenant-wide source of truth for WebAuthn and browser-side direct auth.
					Client pages can still add redirect URI origins as shortcuts, but they write back to
					this same setting.
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
					Use host-only origins. Paths are not allowed. `http://localhost` is allowed for local
					development.
				</p>
				{#if trustedOriginsDraft.error}
					<p class="trusted-origins-validation">{trustedOriginsDraft.error}</p>
				{/if}
			</div>

			{#if trustedOriginsDraft.origins.length > 0}
				<div class="trusted-origins-preview">
					<p class="trusted-origins-preview-label">Normalized entries</p>
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
					Discard Changes
				</button>
				<button
					onclick={saveTrustedOrigins}
					disabled={
						!hasTrustedOriginsChanges ||
						trustedOriginsSaving ||
						!canEditTrustedOrigins ||
						Boolean(trustedOriginsDraft.error)
					}
					class="btn btn-primary"
				>
					{trustedOriginsSaving ? 'Saving...' : 'Save Trusted Origins'}
				</button>
			</div>
		</section>
	{/if}

	<!-- Error message -->
	{#if error}
		<div class="alert alert-error">
			{error}
			{#if error.includes('another user')}
				<button onclick={loadData} class="btn btn-sm btn-danger" style="margin-left: 12px;">
					Reload
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
			<p class="text-secondary">Loading settings...</p>
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
									<span class="setting-locked">Locked</span>
								{/if}
								{#if hasPendingChange}
									<span class="setting-modified">Modified</span>
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
										Range: {settingMeta.min} - {settingMeta.max}
									{:else if settingMeta.min !== undefined}
										Min: {settingMeta.min}
									{:else if settingMeta.max !== undefined}
										Max: {settingMeta.max}
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
				Discard Changes
			</button>
			<button
				onclick={saveChanges}
				disabled={!hasChanges || saving || !canEditLoginUiSettings}
				class="btn btn-primary"
			>
				{saving ? 'Saving...' : `Save Changes${hasChanges ? ` (${pendingPatches.length})` : ''}`}
			</button>
		</div>

		<!-- Coming Soon Section -->
		<div class="coming-soon-section">
			<h2 class="coming-soon-title">Coming Soon</h2>
			<p class="coming-soon-description">The following features are currently in development:</p>
			<div class="coming-soon-list">
				<div class="coming-soon-item">
					<span class="coming-soon-label">Favicon URL</span>
					<span class="coming-soon-desc">URL to the favicon image displayed in browser tabs</span>
				</div>
				<div class="coming-soon-item">
					<span class="coming-soon-label">Background Image URL</span>
					<span class="coming-soon-desc">URL to the background image displayed on the Login UI</span
					>
				</div>
				<div class="coming-soon-item">
					<span class="coming-soon-label">Custom CSS</span>
					<span class="coming-soon-desc"
						>Custom CSS to apply to the Login UI (restricted properties only)</span
					>
				</div>
				<div class="coming-soon-item">
					<span class="coming-soon-label">Header Text</span>
					<span class="coming-soon-desc">Header text displayed above the login form</span>
				</div>
				<div class="coming-soon-item">
					<span class="coming-soon-label">Footer Text</span>
					<span class="coming-soon-desc"
						>Footer text displayed below the login form (e.g., copyright notice)</span
					>
				</div>
				<div class="coming-soon-item">
					<span class="coming-soon-label">Footer Links</span>
					<span class="coming-soon-desc"
						>JSON array of footer links. Format: [&#123;"label":"Privacy
						Policy","url":"https://..."&#125;]</span
					>
				</div>
				<div class="coming-soon-item">
					<span class="coming-soon-label">Custom Blocks</span>
					<span class="coming-soon-desc"
						>JSON array of custom content blocks. Format:
						[&#123;"position":"above-form"|"below-form"|"above-header"|"below-footer","type":"text"|"html"|"image"|"link","content":"..."&#125;]</span
					>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.section-title {
		font-size: 18px;
		font-weight: 600;
		margin: 0 0 6px 0;
	}

	.section-description {
		font-size: 14px;
		color: var(--text-secondary);
		margin: 0;
	}

	.config-source-badge {
		display: inline-flex;
		align-items: center;
		padding: 3px 10px;
		border-radius: 6px;
		background: var(--bg-subtle);
		border: 1px solid var(--border);
		color: var(--text-secondary);
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

	.textarea-setting {
		margin-top: 4px;
	}

	.textarea-setting.modified {
		background: color-mix(in srgb, var(--warning) 5%, transparent);
		border-radius: var(--radius-sm);
		padding: 8px;
		margin: -8px;
	}

	.settings-textarea {
		width: 100%;
		min-height: 140px;
		padding: 12px 14px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-card);
		color: var(--text-primary);
		font: inherit;
		line-height: 1.5;
		resize: vertical;
	}

	.settings-textarea:focus {
		outline: none;
		border-color: var(--primary);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 15%, transparent);
	}

	.settings-textarea:disabled {
		background: var(--bg-subtle);
		color: var(--text-muted);
		cursor: not-allowed;
	}

	.trusted-origins-validation {
		margin: 8px 0 0;
		font-size: 13px;
		color: var(--danger);
	}

	.trusted-origins-preview {
		margin-top: 16px;
		padding-top: 16px;
		border-top: 1px solid var(--border);
	}

	.trusted-origins-preview-label {
		margin: 0 0 10px;
		font-size: 13px;
		font-weight: 600;
		color: var(--text-secondary);
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
		background: var(--bg-subtle);
		border: 1px solid var(--border);
		color: var(--text-primary);
		font-size: 13px;
	}

	.coming-soon-section {
		margin-top: 32px;
		padding: 20px;
		background: var(--bg-subtle);
		border-radius: 8px;
		border: 1px dashed var(--border);
	}

	.coming-soon-title {
		font-size: 16px;
		font-weight: 600;
		color: var(--text-secondary);
		margin: 0 0 8px 0;
	}

	.coming-soon-description {
		font-size: 14px;
		color: var(--text-muted);
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
		background: var(--bg-card);
		border-radius: 6px;
		border: 1px solid var(--border);
	}

	.coming-soon-label {
		font-size: 14px;
		font-weight: 500;
		color: var(--text-primary);
	}

	.coming-soon-desc {
		font-size: 13px;
		color: var(--text-muted);
	}
</style>
