<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminSettingsAPI,
		scopedSettingsAPI,
		isInternalSetting,
		isPageManagedSetting,
		SettingsConflictError,
		convertPatchesToAPIRequest,
		type CategorySettings,
		type CategoryMetaFull,
		type SettingMetaItem,
		type UIPatch,
		type SettingSource,
		type CategoryName,
		type ScopeContext
	} from '$lib/api/admin-settings';
	import { InheritanceIndicator } from '$lib/components/admin';
	import { ToggleSwitch } from '$lib/components';
	import { settingsContext } from '$lib/stores/settings-context.svelte';

	interface PageData {
		category: CategoryName;
	}

	let { data }: { data: PageData } = $props();

	// State
	let meta = $state<CategoryMetaFull | null>(null);
	let settings = $state<CategorySettings | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let successMessage = $state('');

	// Track pending changes
	let pendingPatches = $state<UIPatch[]>([]);

	// Get current scope context from store
	let scopeContext = $derived(settingsContext.scopeContext as ScopeContext);
	let canEdit = $derived(settingsContext.canEditAtCurrentScope());
	let currentLevel = $derived(settingsContext.currentLevel);

	// Derived: Check if there are unsaved changes
	const hasChanges = $derived(pendingPatches.length > 0);

	// Load data on mount
	onMount(async () => {
		await settingsContext.initialize();
		await loadData();
	});

	// Track previous scope context to detect changes
	let prevScopeKey = $state<string | null>(null);

	// Reload when scope changes
	$effect(() => {
		// Build a key from all scope context values to detect any change
		const scopeKey = `${scopeContext.level}:${scopeContext.tenantId}:${scopeContext.clientId}`;

		// Skip if same scope (no change) or initial load
		if (scopeKey === prevScopeKey) return;

		// Update previous scope key
		prevScopeKey = scopeKey;

		// Only reload if meta is already loaded (not initial load)
		if (meta) {
			loadData();
		}
	});

	async function loadData() {
		loading = true;
		error = '';
		pendingPatches = [];

		try {
			// Fetch meta
			const metaResult = await adminSettingsAPI.getMeta(data.category);
			meta = metaResult;

			// Fetch settings based on current scope
			let settingsResult: CategorySettings;
			try {
				settingsResult = await scopedSettingsAPI.getSettingsForScope(data.category, scopeContext);
			} catch {
				// Fall back to tenant settings if scope-specific fails
				settingsResult = await adminSettingsAPI.getSettings(data.category);
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
		// Check pending patches first
		const patch = pendingPatches.find((p) => p.key === key);
		if (patch) {
			if (patch.op === 'set') return patch.value;
			if (patch.op === 'disable') return false;
			if (patch.op === 'clear') return settings?.values[key]; // Will revert to default
		}
		return settings?.values[key];
	}

	// Check if a setting is locked by environment variable
	function isLockedByEnv(key: string): boolean {
		return settings?.sources[key] === 'env';
	}

	// Check if a setting is locked (by env OR by internal visibility OR no edit permission)
	function isSettingLocked(key: string, settingMeta: SettingMetaItem): boolean {
		// Locked if no edit permission at current scope
		if (!canEdit) return true;
		// Locked if set by environment variable
		if (isLockedByEnv(key)) return true;
		// Locked if visibility is 'internal' (setup-time only settings)
		if (isInternalSetting(settingMeta)) return true;
		return false;
	}

	// Handle value change
	function handleChange(key: string, value: unknown) {
		// Remove any existing patch for this key
		pendingPatches = pendingPatches.filter((p) => p.key !== key);

		// Only add patch if value differs from original
		const originalValue = settings?.values[key];
		if (value !== originalValue) {
			pendingPatches = [...pendingPatches, { op: 'set', key, value }];
		}
	}

	// Discard all changes
	function discardChanges() {
		pendingPatches = [];
	}

	// Save changes
	async function saveChanges() {
		if (!settings || pendingPatches.length === 0) return;

		// Check if editing is allowed at current scope
		if (!canEdit) {
			error = 'You do not have permission to edit settings at this scope level';
			return;
		}

		saving = true;
		error = '';
		successMessage = '';

		try {
			const patchData = convertPatchesToAPIRequest(pendingPatches);

			// Use scope-aware API for updates
			const result = await scopedSettingsAPI.updateSettingsForScope(data.category, scopeContext, {
				ifMatch: settings.version,
				...patchData
			});

			// Clear pending patches
			pendingPatches = [];

			// Show success message
			const appliedCount = result.applied.length + result.cleared.length + result.disabled.length;
			successMessage = `Successfully updated ${appliedCount} setting${appliedCount !== 1 ? 's' : ''}`;

			// Reload data to get updated version
			await loadData();

			// Clear success message after 3 seconds
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
	<!-- Back link and header -->
	<div class="settings-detail-header">
		<a href="/admin/settings" class="back-link">← Back to Settings</a>
		{#if meta}
			<div class="settings-header-row">
				<h1 class="page-title">{meta.label}</h1>
				<!-- Scope Badge -->
				<span class="scope-badge {currentLevel}">
					{currentLevel === 'platform' ? '🏗️' : currentLevel === 'tenant' ? '🏢' : '📦'}
					{currentLevel.charAt(0).toUpperCase() + currentLevel.slice(1)}
				</span>
				{#if !canEdit}
					<span class="readonly-badge">🔒 Read-only</span>
				{/if}
			</div>
			<p class="page-description">{meta.description}</p>
		{/if}
	</div>

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
			{#each Object.entries(meta.settings).filter(([_key, s]) => !isPageManagedSetting(s)) as [key, settingMeta] (key)}
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
									<span class="setting-locked">🔒 Locked</span>
								{/if}
								{#if hasPendingChange}
									<span class="setting-modified">● Modified</span>
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
			<button onclick={discardChanges} disabled={!hasChanges || saving} class="btn btn-secondary">
				Discard Changes
			</button>
			<button onclick={saveChanges} disabled={!hasChanges || saving} class="btn btn-primary">
				{saving ? 'Saving...' : `Save Changes${hasChanges ? ` (${pendingPatches.length})` : ''}`}
			</button>
		</div>
	{/if}
</div>
