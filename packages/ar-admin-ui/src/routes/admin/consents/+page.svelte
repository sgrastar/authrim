<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminSettingsAPI,
		scopedSettingsAPI,
		SettingsConflictError,
		convertPatchesToAPIRequest,
		isInternalSetting,
		type CategorySettings,
		type CategoryMetaFull,
		type SettingMetaItem,
		type UIPatch,
		type SettingSource
	} from '$lib/api/admin-settings';
	import { adminClientsAPI, type Client } from '$lib/api/admin-clients';
	import { InheritanceIndicator } from '$lib/components/admin';
	import { ToggleSwitch } from '$lib/components';
	import { settingsContext } from '$lib/stores/settings-context.svelte';

	// State management
	let meta = $state<CategoryMetaFull | null>(null);

	// Tenant settings
	let tenantSettings = $state<CategorySettings | null>(null);
	let tenantPatches = $state<UIPatch[]>([]);
	let tenantSaving = $state(false);

	// Client settings
	let clients = $state<Client[]>([]);
	let selectedClientId = $state<string | null>(null);
	let clientSettings = $state<CategorySettings | null>(null);
	let clientPatches = $state<UIPatch[]>([]);
	let clientSaving = $state(false);

	// Common
	let loading = $state(true);
	let error = $state('');
	let tenantSuccessMessage = $state('');
	let clientSuccessMessage = $state('');
	let loadedTenantId = $state('');

	// Permissions
	let canEdit = $derived(settingsContext.canEditAtCurrentScope());

	// Derived: Check if there are unsaved changes
	const hasTenantChanges = $derived(tenantPatches.length > 0);
	const hasClientChanges = $derived(clientPatches.length > 0);

	// Selected client name for display
	let selectedClientName = $derived(
		selectedClientId ? clients.find((c) => c.client_id === selectedClientId)?.client_name : null
	);

	// Setting groups for display organization
	const CONSENT_SETTING_GROUPS = {
		display: [
			'consent.show_scopes',
			'consent.show_client_info',
			'consent.remember_decision',
			'consent.remember_duration'
		],
		requirements: [
			'consent.require_explicit',
			'consent.granular_scopes',
			'consent.require_on_scope_change'
		],
		caching: ['consent.cache_ttl', 'consent.skip_for_first_party'],
		versioning: ['consent.versioning_enabled'],
		expiration: ['consent.expiration_enabled', 'consent.default_expiration_days'],
		gdpr: [
			'consent.data_export_enabled',
			'consent.data_export_retention_days',
			'consent.data_export_sync_threshold_kb'
		],
		other: ['consent.record_retention', 'consent.supported_display_types', 'consent.ui_locales'],
		rbac: ['consent.rbac_org_selector', 'consent.rbac_acting_as', 'consent.rbac_show_roles'],
		consent_management: [
			'consent.consent_management_enabled',
			'consent.default_enforcement',
			'consent.show_deletion_link',
			'consent.deletion_url',
			'consent.default_language',
			'consent.ip_hash_retention_days'
		]
	};

	// Client consent settings
	const CLIENT_CONSENT_SETTINGS = ['client.consent_required', 'client.first_party'];

	// Load data on mount
	onMount(async () => {
		await settingsContext.initialize();
		await loadData();
	});

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (tenantId && tenantId !== loadedTenantId) {
			loadedTenantId = tenantId;
			void loadData();
		}
	});

	async function loadData() {
		loading = true;
		error = '';
		loadedTenantId = settingsContext.tenantId;

		try {
			// 1. Fetch consent metadata
			const metaResult = await adminSettingsAPI.getMeta('consent');
			meta = metaResult;

			// 2. Fetch tenant-level consent settings
			const tenantResult = await scopedSettingsAPI.getSettingsForScope('consent', {
				level: 'tenant',
				tenantId: settingsContext.tenantId
			});
			tenantSettings = tenantResult;
			tenantPatches = [];

			// 3. Fetch clients list
			const clientsResult = await adminClientsAPI.list({ limit: 1000 });
			clients = clientsResult.clients;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load consent settings';
		} finally {
			loading = false;
		}
	}

	// Load client settings when client is selected
	async function loadClientSettings(clientId: string) {
		if (hasClientChanges) {
			const confirmed = confirm(
				'You have unsaved changes for the current client. Switching clients will discard these changes. Continue?'
			);
			if (!confirmed) {
				// Revert selection
				selectedClientId = selectedClientId;
				return;
			}
		}

		if (!clientId) {
			clientSettings = null;
			clientPatches = [];
			return;
		}

		try {
			error = '';
			clientSuccessMessage = '';

			// Fetch client settings (from 'client' category)
			const result = await scopedSettingsAPI.getClientSettings(clientId, 'client');
			clientSettings = result;
			clientPatches = [];
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load client settings';
			clientSettings = null;
		}
	}

	// Get current value for tenant settings
	function getTenantValue(key: string): unknown {
		const patch = tenantPatches.find((p) => p.key === key);
		if (patch) {
			if (patch.op === 'set') return patch.value;
			if (patch.op === 'disable') return false;
			if (patch.op === 'clear') return tenantSettings?.values[key];
		}
		return tenantSettings?.values[key];
	}

	// Get current value for client settings
	function getClientValue(key: string): unknown {
		const patch = clientPatches.find((p) => p.key === key);
		if (patch) {
			if (patch.op === 'set') return patch.value;
			if (patch.op === 'disable') return false;
			if (patch.op === 'clear') return clientSettings?.values[key];
		}
		return clientSettings?.values[key];
	}

	// Check if a setting is locked by environment variable
	function isLockedByEnv(key: string, settings: CategorySettings | null): boolean {
		return settings?.sources[key] === 'env';
	}

	// Check if a setting is locked
	function isSettingLocked(
		key: string,
		settingMeta: SettingMetaItem,
		settings: CategorySettings | null
	): boolean {
		if (!canEdit) return true;
		if (isLockedByEnv(key, settings)) return true;
		if (isInternalSetting(settingMeta)) return true;
		return false;
	}

	// Handle tenant value change
	function handleTenantChange(key: string, value: unknown) {
		tenantPatches = tenantPatches.filter((p) => p.key !== key);
		const originalValue = tenantSettings?.values[key];
		if (value !== originalValue) {
			tenantPatches = [...tenantPatches, { op: 'set', key, value }];
		}
	}

	// Handle client value change
	function handleClientChange(key: string, value: unknown) {
		clientPatches = clientPatches.filter((p) => p.key !== key);
		const originalValue = clientSettings?.values[key];
		if (value !== originalValue) {
			clientPatches = [...clientPatches, { op: 'set', key, value }];
		}
	}

	// Discard tenant changes
	function discardTenantChanges() {
		tenantPatches = [];
	}

	// Discard client changes
	function discardClientChanges() {
		clientPatches = [];
	}

	// Save tenant settings
	async function saveTenantSettings() {
		if (!tenantSettings || tenantPatches.length === 0) return;

		if (!canEdit) {
			error = 'You do not have permission to edit settings at this scope level';
			return;
		}

		tenantSaving = true;
		error = '';
		tenantSuccessMessage = '';

		try {
			const patchData = convertPatchesToAPIRequest(tenantPatches);

			const result = await scopedSettingsAPI.updateSettingsForScope(
				'consent',
				{ level: 'tenant', tenantId: settingsContext.tenantId },
				{
					ifMatch: tenantSettings.version,
					...patchData
				}
			);

			tenantPatches = [];

			const appliedCount = result.applied.length + result.cleared.length + result.disabled.length;
			tenantSuccessMessage = `Successfully updated ${appliedCount} setting${appliedCount !== 1 ? 's' : ''}`;

			await loadData();

			setTimeout(() => {
				tenantSuccessMessage = '';
			}, 3000);
		} catch (err) {
			if (err instanceof SettingsConflictError) {
				error = `Settings were modified by another user. Please reload and try again.`;
			} else {
				error = err instanceof Error ? err.message : 'Failed to save tenant settings';
			}
		} finally {
			tenantSaving = false;
		}
	}

	// Save client settings
	async function saveClientSettings() {
		if (!selectedClientId || !clientSettings || clientPatches.length === 0) return;

		if (!canEdit) {
			error = 'You do not have permission to edit client settings';
			return;
		}

		clientSaving = true;
		error = '';
		clientSuccessMessage = '';

		try {
			const patchData = convertPatchesToAPIRequest(clientPatches);

			const result = await scopedSettingsAPI.updateClientSettings(selectedClientId, 'client', {
				ifMatch: clientSettings.version,
				...patchData
			});

			clientPatches = [];

			const appliedCount = result.applied.length + result.cleared.length + result.disabled.length;
			clientSuccessMessage = `Successfully updated ${appliedCount} setting${appliedCount !== 1 ? 's' : ''}`;

			await loadClientSettings(selectedClientId);

			setTimeout(() => {
				clientSuccessMessage = '';
			}, 3000);
		} catch (err) {
			if (err instanceof SettingsConflictError) {
				error = `Settings were modified by another user. Please reload and try again.`;
			} else {
				error = err instanceof Error ? err.message : 'Failed to save client settings';
			}
		} finally {
			clientSaving = false;
		}
	}

	// Get input type based on setting metadata
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

	// Get client settings metadata from meta
	let clientMeta = $state<Record<string, SettingMetaItem> | null>(null);

	// Load client category metadata
	onMount(async () => {
		try {
			const clientMetaResult = await adminSettingsAPI.getMeta('client');
			clientMeta = clientMetaResult.settings;
		} catch (err) {
			console.error('Failed to load client metadata:', err);
		}
	});
</script>

<svelte:head>
	<title>Consents - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">Consents</h1>
			<p class="page-description">Manage user consent settings at tenant and client levels</p>
		</div>
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

	{#if loading}
		<div class="loading-state">
			<p class="text-secondary">Loading consent settings...</p>
		</div>
	{:else if meta && tenantSettings}
		<!-- Section 1: Tenant-Level Consent Settings -->
		<section class="consent-section tenant-section">
			<div class="section-header">
				<div class="section-header-left">
					<span class="section-badge tenant">🏢 Tenant</span>
					<h2 class="section-title">Tenant-Level Consent Settings</h2>
				</div>
				{#if !canEdit}
					<span class="readonly-badge">🔒 Read-only</span>
				{/if}
			</div>

			{#if tenantSuccessMessage}
				<div class="alert alert-success">{tenantSuccessMessage}</div>
			{/if}

			<div class="settings-groups">
				<!-- Display Settings -->
				<div class="settings-group">
					<h3 class="group-title">Display Settings</h3>
					<div class="settings-form-card">
						{#each CONSENT_SETTING_GROUPS.display as key (key)}
							{@const settingMeta = meta.settings[key]}
							{@const value = getTenantValue(key)}
							{@const locked = isSettingLocked(key, settingMeta, tenantSettings)}
							{@const hasPendingChange = tenantPatches.some((p) => p.key === key)}
							<div class="setting-item" class:modified={hasPendingChange}>
								<div class="setting-item-content">
									<div class="setting-info">
										<div class="setting-label-row">
											<label for={key} class="setting-label">{settingMeta.label}</label>
											<InheritanceIndicator
												source={(tenantSettings?.sources[key] as SettingSource) || 'default'}
												currentScope="tenant"
												{canEdit}
												compact={true}
											/>
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
												onchange={(newValue) => handleTenantChange(key, newValue)}
											/>
										{:else if settingMeta.type === 'enum' && settingMeta.enum}
											<select
												id={key}
												value={String(value)}
												disabled={locked}
												onchange={(e) => handleTenantChange(key, e.currentTarget.value)}
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
													handleTenantChange(key, inputValue);
												}}
												class="settings-input"
											/>
										{/if}
									</div>
								</div>
							</div>
						{/each}
					</div>
				</div>

				<!-- Requirements -->
				<div class="settings-group">
					<h3 class="group-title">Requirements</h3>
					<div class="settings-form-card">
						{#each CONSENT_SETTING_GROUPS.requirements as key (key)}
							{@const settingMeta = meta.settings[key]}
							{@const value = getTenantValue(key)}
							{@const locked = isSettingLocked(key, settingMeta, tenantSettings)}
							{@const hasPendingChange = tenantPatches.some((p) => p.key === key)}
							<div class="setting-item" class:modified={hasPendingChange}>
								<div class="setting-item-content">
									<div class="setting-info">
										<div class="setting-label-row">
											<label for={key} class="setting-label">{settingMeta.label}</label>
											<InheritanceIndicator
												source={(tenantSettings?.sources[key] as SettingSource) || 'default'}
												currentScope="tenant"
												{canEdit}
												compact={true}
											/>
											{#if hasPendingChange}
												<span class="setting-modified">● Modified</span>
											{/if}
										</div>
										<p class="setting-description">{settingMeta.description}</p>
									</div>
									<div class="setting-control">
										<ToggleSwitch
											checked={Boolean(value)}
											disabled={locked}
											id={key}
											onchange={(newValue) => handleTenantChange(key, newValue)}
										/>
									</div>
								</div>
							</div>
						{/each}
					</div>
				</div>

				<!-- Caching -->
				<div class="settings-group">
					<h3 class="group-title">Caching</h3>
					<div class="settings-form-card">
						{#each CONSENT_SETTING_GROUPS.caching as key (key)}
							{@const settingMeta = meta.settings[key]}
							{@const value = getTenantValue(key)}
							{@const locked = isSettingLocked(key, settingMeta, tenantSettings)}
							{@const hasPendingChange = tenantPatches.some((p) => p.key === key)}
							<div class="setting-item" class:modified={hasPendingChange}>
								<div class="setting-item-content">
									<div class="setting-info">
										<div class="setting-label-row">
											<label for={key} class="setting-label">{settingMeta.label}</label>
											<InheritanceIndicator
												source={(tenantSettings?.sources[key] as SettingSource) || 'default'}
												currentScope="tenant"
												{canEdit}
												compact={true}
											/>
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
												onchange={(newValue) => handleTenantChange(key, newValue)}
											/>
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
													handleTenantChange(key, inputValue);
												}}
												class="settings-input"
											/>
										{/if}
									</div>
								</div>
							</div>
						{/each}
					</div>
				</div>

				<!-- Policy Versioning -->
				<div class="settings-group">
					<h3 class="group-title">Policy Versioning</h3>
					<div class="settings-form-card">
						{#each CONSENT_SETTING_GROUPS.versioning as key (key)}
							{@const settingMeta = meta.settings[key]}
							{@const value = getTenantValue(key)}
							{@const locked = isSettingLocked(key, settingMeta, tenantSettings)}
							{@const hasPendingChange = tenantPatches.some((p) => p.key === key)}
							<div class="setting-item" class:modified={hasPendingChange}>
								<div class="setting-item-content">
									<div class="setting-info">
										<div class="setting-label-row">
											<label for={key} class="setting-label">{settingMeta.label}</label>
											<InheritanceIndicator
												source={(tenantSettings?.sources[key] as SettingSource) || 'default'}
												currentScope="tenant"
												{canEdit}
												compact={true}
											/>
											{#if hasPendingChange}
												<span class="setting-modified">● Modified</span>
											{/if}
										</div>
										<p class="setting-description">{settingMeta.description}</p>
									</div>
									<div class="setting-control">
										<ToggleSwitch
											checked={Boolean(value)}
											disabled={locked}
											id={key}
											onchange={(newValue) => handleTenantChange(key, newValue)}
										/>
									</div>
								</div>
							</div>
						{/each}
					</div>
				</div>

				<!-- Expiration -->
				<div class="settings-group">
					<h3 class="group-title">Expiration</h3>
					<div class="settings-form-card">
						{#each CONSENT_SETTING_GROUPS.expiration as key (key)}
							{@const settingMeta = meta.settings[key]}
							{@const value = getTenantValue(key)}
							{@const locked = isSettingLocked(key, settingMeta, tenantSettings)}
							{@const hasPendingChange = tenantPatches.some((p) => p.key === key)}
							<div class="setting-item" class:modified={hasPendingChange}>
								<div class="setting-item-content">
									<div class="setting-info">
										<div class="setting-label-row">
											<label for={key} class="setting-label">{settingMeta.label}</label>
											<InheritanceIndicator
												source={(tenantSettings?.sources[key] as SettingSource) || 'default'}
												currentScope="tenant"
												{canEdit}
												compact={true}
											/>
											{#if hasPendingChange}
												<span class="setting-modified">● Modified</span>
											{/if}
										</div>
										<p class="setting-description">{settingMeta.description}</p>
									</div>
									<div class="setting-control">
										{#if settingMeta.type === 'boolean'}
											<ToggleSwitch
												checked={Boolean(value)}
												disabled={locked}
												id={key}
												onchange={(newValue) => handleTenantChange(key, newValue)}
											/>
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
													handleTenantChange(key, inputValue);
												}}
												class="settings-input"
											/>
										{/if}
									</div>
								</div>
							</div>
						{/each}
					</div>
				</div>

				<!-- GDPR Data Export -->
				<div class="settings-group">
					<h3 class="group-title">GDPR Data Export</h3>
					<div class="settings-form-card">
						{#each CONSENT_SETTING_GROUPS.gdpr as key (key)}
							{@const settingMeta = meta.settings[key]}
							{@const value = getTenantValue(key)}
							{@const locked = isSettingLocked(key, settingMeta, tenantSettings)}
							{@const hasPendingChange = tenantPatches.some((p) => p.key === key)}
							<div class="setting-item" class:modified={hasPendingChange}>
								<div class="setting-item-content">
									<div class="setting-info">
										<div class="setting-label-row">
											<label for={key} class="setting-label">{settingMeta.label}</label>
											<InheritanceIndicator
												source={(tenantSettings?.sources[key] as SettingSource) || 'default'}
												currentScope="tenant"
												{canEdit}
												compact={true}
											/>
											{#if hasPendingChange}
												<span class="setting-modified">● Modified</span>
											{/if}
										</div>
										<p class="setting-description">{settingMeta.description}</p>
									</div>
									<div class="setting-control">
										{#if settingMeta.type === 'boolean'}
											<ToggleSwitch
												checked={Boolean(value)}
												disabled={locked}
												id={key}
												onchange={(newValue) => handleTenantChange(key, newValue)}
											/>
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
													handleTenantChange(key, inputValue);
												}}
												class="settings-input"
											/>
										{/if}
									</div>
								</div>
							</div>
						{/each}
					</div>
				</div>

				<!-- Other Settings -->
				<div class="settings-group">
					<h3 class="group-title">Other Settings</h3>
					<div class="settings-form-card">
						{#each CONSENT_SETTING_GROUPS.other as key (key)}
							{@const settingMeta = meta.settings[key]}
							{@const value = getTenantValue(key)}
							{@const locked = isSettingLocked(key, settingMeta, tenantSettings)}
							{@const hasPendingChange = tenantPatches.some((p) => p.key === key)}
							<div class="setting-item" class:modified={hasPendingChange}>
								<div class="setting-item-content">
									<div class="setting-info">
										<div class="setting-label-row">
											<label for={key} class="setting-label">{settingMeta.label}</label>
											<InheritanceIndicator
												source={(tenantSettings?.sources[key] as SettingSource) || 'default'}
												currentScope="tenant"
												{canEdit}
												compact={true}
											/>
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
												handleTenantChange(key, inputValue);
											}}
											class="settings-input"
										/>
									</div>
								</div>
							</div>
						{/each}
					</div>
				</div>

				<!-- RBAC Features -->
				<div class="settings-group">
					<h3 class="group-title">RBAC Consent Features</h3>
					<div class="settings-form-card">
						{#each CONSENT_SETTING_GROUPS.rbac as key (key)}
							{@const settingMeta = meta.settings[key]}
							{@const value = getTenantValue(key)}
							{@const locked = isSettingLocked(key, settingMeta, tenantSettings)}
							{@const hasPendingChange = tenantPatches.some((p) => p.key === key)}
							<div class="setting-item" class:modified={hasPendingChange}>
								<div class="setting-item-content">
									<div class="setting-info">
										<div class="setting-label-row">
											<label for={key} class="setting-label">{settingMeta.label}</label>
											<InheritanceIndicator
												source={(tenantSettings?.sources[key] as SettingSource) || 'default'}
												currentScope="tenant"
												{canEdit}
												compact={true}
											/>
											{#if hasPendingChange}
												<span class="setting-modified">● Modified</span>
											{/if}
										</div>
										<p class="setting-description">{settingMeta.description}</p>
									</div>
									<div class="setting-control">
										<ToggleSwitch
											checked={Boolean(value)}
											disabled={locked}
											id={key}
											onchange={(newValue) => handleTenantChange(key, newValue)}
										/>
									</div>
								</div>
							</div>
						{/each}
					</div>
				</div>
			</div>

			<!-- Tenant Action buttons -->
			<div class="settings-actions">
				<button
					onclick={discardTenantChanges}
					disabled={!hasTenantChanges || tenantSaving}
					class="btn btn-secondary"
				>
					Discard Changes
				</button>
				<button
					onclick={saveTenantSettings}
					disabled={!hasTenantChanges || tenantSaving}
					class="btn btn-primary"
				>
					{tenantSaving
						? 'Saving...'
						: `Save Tenant Settings${hasTenantChanges ? ` (${tenantPatches.length})` : ''}`}
				</button>
			</div>
		</section>

		<!-- Section 2: Client Selector -->
		<section class="client-selector-section">
			<div class="section-header">
				<div class="section-header-left">
					<span class="section-badge client">📦 Client</span>
					<h2 class="section-title">Client-Specific Consent Overrides</h2>
				</div>
			</div>

			<div class="client-selector-wrapper">
				<label for="client-select" class="client-selector-label"
					>Select a client to configure consent overrides:</label
				>
				<select
					id="client-select"
					bind:value={selectedClientId}
					onchange={() => loadClientSettings(selectedClientId || '')}
					class="client-selector"
				>
					<option value="">-- Select a client --</option>
					{#each clients as client (client.client_id)}
						<option value={client.client_id}>{client.client_name}</option>
					{/each}
				</select>
			</div>
		</section>

		<!-- Section 3: Client Consent Settings -->
		{#if selectedClientId && clientSettings && clientMeta}
			<section class="consent-section client-section">
				<div class="section-header">
					<div class="section-header-left">
						<span class="section-badge client">📦 Client</span>
						<h2 class="section-title">Client Settings: {selectedClientName}</h2>
					</div>
					{#if !canEdit}
						<span class="readonly-badge">🔒 Read-only</span>
					{/if}
				</div>

				{#if clientSuccessMessage}
					<div class="alert alert-success">{clientSuccessMessage}</div>
				{/if}

				<div class="settings-form-card">
					{#each CLIENT_CONSENT_SETTINGS as key (key)}
						{@const settingMeta = clientMeta[key]}
						{#if settingMeta}
							{@const value = getClientValue(key)}
							{@const locked = isSettingLocked(key, settingMeta, clientSettings)}
							{@const hasPendingChange = clientPatches.some((p) => p.key === key)}
							<div class="setting-item" class:modified={hasPendingChange}>
								<div class="setting-item-content">
									<div class="setting-info">
										<div class="setting-label-row">
											<label for={`client-${key}`} class="setting-label">{settingMeta.label}</label>
											<InheritanceIndicator
												source={(clientSettings?.sources[key] as SettingSource) || 'default'}
												currentScope="client"
												{canEdit}
												compact={true}
											/>
											{#if hasPendingChange}
												<span class="setting-modified">● Modified</span>
											{/if}
										</div>
										<p class="setting-description">{settingMeta.description}</p>
									</div>
									<div class="setting-control">
										<ToggleSwitch
											checked={Boolean(value)}
											disabled={locked}
											id={`client-${key}`}
											onchange={(newValue) => handleClientChange(key, newValue)}
										/>
									</div>
								</div>
							</div>
						{/if}
					{/each}
				</div>

				<!-- Client Action buttons -->
				<div class="settings-actions">
					<button
						onclick={discardClientChanges}
						disabled={!hasClientChanges || clientSaving}
						class="btn btn-secondary"
					>
						Discard Changes
					</button>
					<button
						onclick={saveClientSettings}
						disabled={!hasClientChanges || clientSaving}
						class="btn btn-primary"
					>
						{clientSaving
							? 'Saving...'
							: `Save Client Settings${hasClientChanges ? ` (${clientPatches.length})` : ''}`}
					</button>
				</div>
			</section>
		{/if}
	{/if}
</div>

<style>
	/* Consent Sections */
	.consent-section {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 24px;
		margin-bottom: 24px;
	}

	.tenant-section {
		border-left: 4px solid var(--primary);
	}

	.client-section {
		border-left: 4px solid #a855f7;
	}

	.section-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 24px;
		gap: 16px;
	}

	.section-header-left {
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.section-badge {
		display: inline-flex;
		align-items: center;
		padding: 4px 12px;
		border-radius: 6px;
		font-size: 13px;
		font-weight: 500;
	}

	.section-badge.tenant {
		background: var(--primary-light);
		color: var(--primary);
	}

	.section-badge.client {
		background: #f3e8ff;
		color: #a855f7;
	}

	.section-title {
		font-size: 20px;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0;
	}

	.readonly-badge {
		display: inline-flex;
		align-items: center;
		padding: 4px 12px;
		border-radius: 6px;
		font-size: 13px;
		font-weight: 500;
		background: var(--bg-subtle);
		color: var(--text-secondary);
	}

	/* Settings Groups */
	.settings-groups {
		display: flex;
		flex-direction: column;
		gap: 24px;
	}

	.settings-group {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.group-title {
		font-size: 16px;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0;
		padding-left: 4px;
	}

	/* Settings Form Card */
	.settings-form-card {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 8px;
		overflow: hidden;
	}

	.setting-item {
		border-bottom: 1px solid var(--border);
		transition: background-color 0.15s ease;
	}

	.setting-item:last-child {
		border-bottom: none;
	}

	.setting-item.modified {
		background: var(--primary-light);
	}

	.setting-item-content {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 20px;
		gap: 24px;
	}

	.setting-info {
		flex: 1;
		min-width: 0;
	}

	.setting-label-row {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-bottom: 4px;
	}

	.setting-label {
		font-size: 14px;
		font-weight: 500;
		color: var(--text-primary);
		margin: 0;
	}

	.setting-modified {
		font-size: 12px;
		color: var(--primary);
		font-weight: 500;
	}

	.setting-description {
		font-size: 13px;
		color: var(--text-secondary);
		margin: 0;
		line-height: 1.5;
	}

	.setting-unit {
		color: var(--text-muted);
		font-style: italic;
	}

	.setting-control {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 4px;
		min-width: 200px;
	}

	.settings-input,
	.settings-select {
		width: 100%;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-card);
		color: var(--text-primary);
		font-size: 14px;
	}

	.settings-input:disabled,
	.settings-select:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Client Selector Section */
	.client-selector-section {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: 12px;
		padding: 24px;
		margin-bottom: 24px;
	}

	.client-selector-wrapper {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.client-selector-label {
		font-size: 14px;
		font-weight: 500;
		color: var(--text-primary);
	}

	.client-selector {
		padding: 10px 14px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-card);
		color: var(--text-primary);
		font-size: 14px;
		cursor: pointer;
		max-width: 400px;
	}

	.client-selector:focus {
		outline: none;
		border-color: var(--primary);
		box-shadow: 0 0 0 3px var(--primary-light);
	}

	/* Action Buttons */
	.settings-actions {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 12px;
		margin-top: 24px;
		padding-top: 24px;
		border-top: 1px solid var(--border);
	}

	/* Alerts */
	.alert {
		padding: 12px 16px;
		border-radius: 8px;
		margin-bottom: 16px;
		font-size: 14px;
	}

	.alert-error {
		background: var(--danger-light);
		color: var(--danger);
		border: 1px solid var(--danger);
	}

	.alert-success {
		background: var(--success-light);
		color: var(--success);
		border: 1px solid var(--success);
	}

	/* Loading State */
	.loading-state {
		display: flex;
		justify-content: center;
		align-items: center;
		padding: 48px;
		color: var(--text-secondary);
	}

	.text-secondary {
		color: var(--text-secondary);
	}
</style>
