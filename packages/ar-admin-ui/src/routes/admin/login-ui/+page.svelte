<script lang="ts">
	import { onMount } from 'svelte';
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
	let canEditLoginUiSettings = $derived(canEdit && loginUiAvailable && loginUiConfigured);
	let currentLevel = $derived(settingsContext.currentLevel);

	// Derived: Check if there are unsaved changes
	const hasChanges = $derived(pendingPatches.length > 0);
	const hasUiConfigChanges = $derived(
		initialUiConfigForm
			? JSON.stringify(uiConfigForm) !== JSON.stringify(initialUiConfigForm)
			: false
	);

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
		uiConfigError = '';
		pendingPatches = [];

		try {
			const tenantInfo = await getTenantInfo(scopeContext.tenantId ?? settingsContext.tenantId);
			const uiConfigResult = await adminUiConfigAPI.get();
			const nextUiConfigForm: UIConfigForm = {
				baseUrl: uiConfigResult.config.baseUrl ?? '',
				paths: { ...uiConfigResult.config.paths }
			};
			uiConfig = uiConfigResult;
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
			Customization settings remain read-only until the global UI URL is configured.
		</div>
	{/if}

	{#if uiConfigError}
		<div class="alert alert-error">{uiConfigError}</div>
	{/if}

	{#if uiConfigSuccessMessage}
		<div class="alert alert-success">{uiConfigSuccessMessage}</div>
	{/if}

	{#if !loading && uiConfig}
		<div class="settings-form-card">
			<div class="ui-config-header">
				<div>
					<h2 class="section-title">Global UI Configuration</h2>
					<p class="section-description">
						Configure the global Login UI base URL and page paths used by the authorization flow.
					</p>
				</div>
				<span class="config-source-badge">Source: {uiConfig.source}</span>
			</div>

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

			<div class="settings-actions">
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
		</div>
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
	.ui-config-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 16px;
		margin-bottom: 20px;
	}

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
		padding: 4px 10px;
		border-radius: 999px;
		background: var(--surface-secondary);
		color: var(--text-secondary);
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
	}

	.coming-soon-section {
		margin-top: 32px;
		padding: 20px;
		background: var(--surface-secondary);
		border-radius: 8px;
		border: 1px dashed var(--border-color);
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
		background: var(--surface);
		border-radius: 6px;
		border: 1px solid var(--border-color);
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
