<script lang="ts">
	import { onMount } from 'svelte';
	import Alert from '$lib/components/Alert.svelte';
	import ToggleSwitch from '$lib/components/ToggleSwitch.svelte';
	import { adminSettingsAPI, type CategorySettings } from '$lib/api/admin-settings';
	import { settingsContext } from '$lib/stores/settings-context.svelte';

	type ExportFormat = 'json' | 'jsonl' | 'text';
	type SortMode = 'category' | 'timeline' | 'session';
	type StorageMode = 'full' | 'masked' | 'minimal';
	type ExportMode = 'full' | 'masked' | 'minimal';

	// Tabs
	type TabId = 'settings' | 'export' | 'storage';
	let activeTab = $state<TabId>('settings');

	const TAB_DEFINITIONS: ReadonlyArray<{ id: TabId; label: string }> = [
		{ id: 'settings', label: 'Settings' },
		{ id: 'export', label: 'Export' },
		{ id: 'storage', label: 'Storage' }
	];

	// Export form state
	let tenantId = $state('');
	let startDate = $state('');
	let endDate = $state('');
	let startTime = $state('00:00');
	let endTime = $state('23:59');
	let sessionIds = $state('');
	let categories = $state({
		'http-request': false,
		'http-response': false,
		'token-validation': true,
		'auth-decision': true
	});
	let format = $state<ExportFormat>('json');
	let sortMode = $state<SortMode>('timeline');
	let exportMode = $state<ExportMode>('masked');
	let storageModeDefault = $state<StorageMode>('masked');
	let storageModeOverrides = $state<Record<string, StorageMode>>({});
	let includeStats = $state(false);
	let selectedClientIds = $state<string[]>([]);
	let clientSearchQuery = $state('');

	// Connection test state
	let testTenantId = $state('');
	let r2BucketBinding = $state('DIAGNOSTIC_LOGS');
	let pathPrefix = $state('diagnostic-logs');

	// UI state
	let loading = $state(false);
	let error = $state('');
	let success = $state('');
	let settingsLoading = $state(false);
	let settingsSaving = $state(false);
	let settingsError = $state('');
	let loggingSettings = $state<CategorySettings | null>(null);
	let loggingEnabled = $state(false);
	let r2OutputEnabled = $state(false);
	let sdkIngestEnabled = $state(false);
	let mergedOutputEnabled = $state(false);
	let clientsLoading = $state(false);
	let clientsError = $state('');
	let clientOptions = $state<{ id: string; name: string }[]>([]);
	let testLoading = $state(false);
	let testError = $state('');
	let testSuccess = $state('');
	let testLatency = $state<number | null>(null);

	const canEdit = $derived(settingsContext.canEditAtCurrentScope());

	// Filter clients for search
	const filteredClientOptions = $derived(
		clientOptions.filter(
			(client) =>
				client.name.toLowerCase().includes(clientSearchQuery.toLowerCase()) ||
				client.id.toLowerCase().includes(clientSearchQuery.toLowerCase())
		)
	);

	// Timezone detection and datetime display
	const userTimezone = $derived(Intl.DateTimeFormat().resolvedOptions().timeZone);

	function formatDateTimeDisplay(
		date: string,
		time: string
	): { utc: string; local: string } | null {
		if (!date || !time) return null;

		const dateTime = new Date(`${date}T${time}:00`);
		if (isNaN(dateTime.getTime())) return null;

		// UTC表示
		const utcStr = dateTime.toISOString().replace('T', ' ').substring(0, 19);

		// ローカルタイムゾーン表示
		const localStr = dateTime
			.toLocaleString('ja-JP', {
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
				second: '2-digit',
				hour12: false
			})
			.replace(/\//g, '-');

		return {
			utc: `${utcStr} (UTC)`,
			local: `${localStr} (${userTimezone})`
		};
	}

	const startDateTimeDisplay = $derived(formatDateTimeDisplay(startDate, startTime));
	const endDateTimeDisplay = $derived(formatDateTimeDisplay(endDate, endTime));

	// Track initial values for Storage tab (for unsaved changes detection)
	let initialStorageModeDefault = $state<StorageMode>('masked');
	let initialStorageModeOverrides = $state<Record<string, StorageMode>>({});

	// Check for unsaved changes in Storage tab only
	// (Settings tab toggles save immediately, so no unsaved changes there)
	const hasUnsavedStorageChanges = $derived(
		activeTab === 'storage' &&
			(storageModeDefault !== initialStorageModeDefault ||
				JSON.stringify(storageModeOverrides) !== JSON.stringify(initialStorageModeOverrides))
	);

	function handleTabChange(newTab: TabId) {
		// Only check Storage tab for unsaved changes
		if (hasUnsavedStorageChanges) {
			const confirmChange = confirm(
				'You have unsaved changes. Switching tabs will discard them. Continue?'
			);
			if (!confirmChange) return;
			// Reset to initial values
			storageModeDefault = initialStorageModeDefault;
			storageModeOverrides = { ...initialStorageModeOverrides };
		}

		activeTab = newTab;
	}

	onMount(async () => {
		await settingsContext.initialize();
		tenantId = settingsContext.tenantId;

		const now = new Date();
		const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

		endDate = now.toISOString().split('T')[0];
		startDate = sevenDaysAgo.toISOString().split('T')[0];
		testTenantId = tenantId;

		await loadLoggingSettings();
		await loadClientOptions();
	});

	// Reload when tenant changes via the header selector
	let prevContextTenantId = $state<string | null>(null);
	$effect(() => {
		const ctxTenantId = settingsContext.tenantId;
		if (prevContextTenantId === null) {
			prevContextTenantId = ctxTenantId;
			return;
		}
		if (ctxTenantId === prevContextTenantId) return;
		prevContextTenantId = ctxTenantId;
		tenantId = ctxTenantId;
		testTenantId = ctxTenantId;
		selectedClientIds = [];
		loadLoggingSettings();
		loadClientOptions();
	});

	async function loadLoggingSettings() {
		settingsLoading = true;
		settingsError = '';

		try {
			const result = await adminSettingsAPI.getSettings('diagnostic-logging', tenantId);
			loggingSettings = result;
			loggingEnabled = Boolean(result.values['diagnostic-logging.enabled']);
			r2OutputEnabled = Boolean(result.values['diagnostic-logging.r2_output_enabled']);
			sdkIngestEnabled = Boolean(result.values['diagnostic-logging.sdk_ingest_enabled']);
			mergedOutputEnabled = Boolean(result.values['diagnostic-logging.merged_output_enabled']);
			storageModeDefault = normalizeStorageMode(
				result.values['diagnostic-logging.storage_mode.default'],
				'masked'
			);
			storageModeOverrides = parseStorageModeOverrides(
				result.values['diagnostic-logging.storage_mode.by_client']
			);

			// Save initial values
			initialStorageModeDefault = storageModeDefault;
			initialStorageModeOverrides = { ...storageModeOverrides };
		} catch (err) {
			settingsError = err instanceof Error ? err.message : 'Failed to load diagnostic settings';
		} finally {
			settingsLoading = false;
		}
	}

	async function loadClientOptions() {
		clientsLoading = true;
		clientsError = '';

		try {
			const allClients: { id: string; name: string }[] = [];
			let page = 1;
			const limit = 200;

			while (true) {
				const response = await fetch(`/api/admin/clients?page=${page}&limit=${limit}`, {
					credentials: 'include'
				});

				if (!response.ok) {
					const errorData = await response.json().catch(() => ({}));
					throw new Error(errorData.message || 'Failed to load clients');
				}

				const data = await response.json();
				const clients = Array.isArray(data.clients) ? data.clients : [];

				allClients.push(
					...clients.map((client: { client_id: string; client_name?: string }) => ({
						id: client.client_id,
						name: client.client_name || client.client_id
					}))
				);

				if (!data.pagination?.hasNext) {
					break;
				}

				page += 1;
			}

			clientOptions = allClients;
		} catch (err) {
			clientsError = err instanceof Error ? err.message : 'Failed to load clients';
			clientOptions = [];
		} finally {
			clientsLoading = false;
		}
	}

	async function handleTenantChange(nextTenantId: string) {
		const previousTenantId = settingsContext.tenantId;
		if (!nextTenantId || nextTenantId === previousTenantId) return;
		tenantId = nextTenantId;
		testTenantId = nextTenantId;
		selectedClientIds = [];
		await settingsContext.setTenantId(nextTenantId);
		await loadLoggingSettings();
		await loadClientOptions();
	}

	async function handleToggleLogging(enabled: boolean) {
		if (!loggingSettings || settingsSaving) return;

		settingsSaving = true;
		settingsError = '';

		try {
			const result = await adminSettingsAPI.updateSettings(
				'diagnostic-logging',
				{
					ifMatch: loggingSettings.version,
					set: {
						'diagnostic-logging.enabled': enabled
					}
				},
				tenantId
			);

			loggingSettings = {
				...loggingSettings,
				version: result.version,
				values: {
					...loggingSettings.values,
					'diagnostic-logging.enabled': enabled
				}
			};
			loggingEnabled = enabled;
		} catch (err) {
			settingsError = err instanceof Error ? err.message : 'Failed to update diagnostic settings';
		} finally {
			settingsSaving = false;
		}
	}

	async function handleToggleR2Output(enabled: boolean) {
		if (!loggingSettings || settingsSaving) return;

		settingsSaving = true;
		settingsError = '';

		try {
			const result = await adminSettingsAPI.updateSettings(
				'diagnostic-logging',
				{
					ifMatch: loggingSettings.version,
					set: {
						'diagnostic-logging.r2_output_enabled': enabled
					}
				},
				tenantId
			);

			loggingSettings = {
				...loggingSettings,
				version: result.version,
				values: {
					...loggingSettings.values,
					'diagnostic-logging.r2_output_enabled': enabled
				}
			};
			r2OutputEnabled = enabled;
		} catch (err) {
			settingsError = err instanceof Error ? err.message : 'Failed to update diagnostic settings';
		} finally {
			settingsSaving = false;
		}
	}

	async function handleToggleSdkIngest(enabled: boolean) {
		if (!loggingSettings || settingsSaving) return;

		settingsSaving = true;
		settingsError = '';

		try {
			const result = await adminSettingsAPI.updateSettings(
				'diagnostic-logging',
				{
					ifMatch: loggingSettings.version,
					set: {
						'diagnostic-logging.sdk_ingest_enabled': enabled
					}
				},
				tenantId
			);

			loggingSettings = {
				...loggingSettings,
				version: result.version,
				values: {
					...loggingSettings.values,
					'diagnostic-logging.sdk_ingest_enabled': enabled
				}
			};
			sdkIngestEnabled = enabled;
		} catch (err) {
			settingsError = err instanceof Error ? err.message : 'Failed to update diagnostic settings';
		} finally {
			settingsSaving = false;
		}
	}

	async function handleToggleMergedOutput(enabled: boolean) {
		if (!loggingSettings || settingsSaving) return;

		settingsSaving = true;
		settingsError = '';

		try {
			const result = await adminSettingsAPI.updateSettings(
				'diagnostic-logging',
				{
					ifMatch: loggingSettings.version,
					set: {
						'diagnostic-logging.merged_output_enabled': enabled
					}
				},
				tenantId
			);

			loggingSettings = {
				...loggingSettings,
				version: result.version,
				values: {
					...loggingSettings.values,
					'diagnostic-logging.merged_output_enabled': enabled
				}
			};
			mergedOutputEnabled = enabled;
		} catch (err) {
			settingsError = err instanceof Error ? err.message : 'Failed to update diagnostic settings';
		} finally {
			settingsSaving = false;
		}
	}

	function validateDateRange() {
		if (startDate && endDate && startDate > endDate) {
			error = 'Start date must be before end date.';
			return false;
		}
		return true;
	}

	function toggleClientSelection(clientId: string, checked: boolean) {
		if (checked) {
			if (!selectedClientIds.includes(clientId)) {
				selectedClientIds = [...selectedClientIds, clientId];
			}
		} else {
			selectedClientIds = selectedClientIds.filter((id) => id !== clientId);
		}
	}

	function normalizeStorageMode(value: unknown, fallback: StorageMode): StorageMode {
		if (value === 'full' || value === 'masked' || value === 'minimal') return value;
		return fallback;
	}

	function parseStorageModeOverrides(raw: unknown): Record<string, StorageMode> {
		if (!raw) return {};
		const source = typeof raw === 'string' ? raw.trim() : raw;
		let parsed: unknown = source;

		if (typeof source === 'string') {
			if (!source) return {};
			try {
				parsed = JSON.parse(source);
			} catch {
				return {};
			}
		}

		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {};
		}

		const result: Record<string, StorageMode> = {};
		for (const [clientId, mode] of Object.entries(parsed as Record<string, unknown>)) {
			if (mode === 'full' || mode === 'masked' || mode === 'minimal') {
				result[clientId] = mode;
			}
		}

		return result;
	}

	function setClientStorageMode(clientId: string, value: string) {
		if (value === 'inherit') {
			const { [clientId]: _, ...rest } = storageModeOverrides;
			storageModeOverrides = rest;
			return;
		}

		if (value === 'full' || value === 'masked' || value === 'minimal') {
			storageModeOverrides = { ...storageModeOverrides, [clientId]: value };
		}
	}

	function getClientStorageMode(clientId: string): string {
		return storageModeOverrides[clientId] ?? 'inherit';
	}

	async function handleSaveStorageModes() {
		if (!loggingSettings || settingsSaving || !canEdit) return;

		settingsSaving = true;
		settingsError = '';

		try {
			const overridesPayload = JSON.stringify(storageModeOverrides);
			const result = await adminSettingsAPI.updateSettings(
				'diagnostic-logging',
				{
					ifMatch: loggingSettings.version,
					set: {
						'diagnostic-logging.storage_mode.default': storageModeDefault,
						'diagnostic-logging.storage_mode.by_client': overridesPayload
					}
				},
				tenantId
			);

			loggingSettings = {
				...loggingSettings,
				version: result.version,
				values: {
					...loggingSettings.values,
					'diagnostic-logging.storage_mode.default': storageModeDefault,
					'diagnostic-logging.storage_mode.by_client': overridesPayload
				}
			};

			// Update initial values
			initialStorageModeDefault = storageModeDefault;
			initialStorageModeOverrides = { ...storageModeOverrides };

			success = 'Storage mode settings updated.';
		} catch (err) {
			settingsError = err instanceof Error ? err.message : 'Failed to update storage mode settings';
		} finally {
			settingsSaving = false;
		}
	}

	async function handleExport(event?: Event) {
		event?.preventDefault();
		error = '';
		success = '';

		if (!tenantId) {
			error = 'Tenant ID is required.';
			return;
		}

		if (!validateDateRange()) {
			return;
		}

		loading = true;

		try {
			// eslint-disable-next-line svelte/prefer-svelte-reactivity
			const params = new URLSearchParams({
				tenantId
			});

			if (selectedClientIds.length > 0) {
				params.append('clientIds', selectedClientIds.join(','));
			}
			const startDateTime = startDate && startTime ? `${startDate}T${startTime}:00Z` : '';
			const endDateTime = endDate && endTime ? `${endDate}T${endTime}:00Z` : '';
			if (startDateTime) params.append('startDate', startDateTime);
			if (endDateTime) params.append('endDate', endDateTime);
			if (sessionIds.trim()) params.append('sessionIds', sessionIds.trim());

			const selectedCategories = Object.entries(categories)
				.filter(([_, selected]) => selected)
				.map(([category]) => category);

			if (selectedCategories.length > 0) {
				params.append('categories', selectedCategories.join(','));
			}

			params.append('format', format);
			params.append('sortMode', sortMode);
			params.append('exportMode', exportMode);
			if (includeStats) params.append('includeStats', 'true');

			const response = await fetch(`/api/admin/diagnostic-logging/export?${params.toString()}`, {
				credentials: 'include'
			});

			if (!response.ok) {
				const errorData = await response.json().catch(() => ({}));
				throw new Error(errorData.message || `Export failed: ${response.statusText}`);
			}

			const contentDisposition = response.headers.get('Content-Disposition');
			let filename = `diagnostic-logs-${tenantId}-${Date.now()}`;

			if (contentDisposition) {
				const match = contentDisposition.match(/filename="?(.+?)"?$/);
				if (match) filename = match[1];
			}

			const blob = await response.blob();
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);

			success = `Successfully exported logs as ${filename}`;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to export logs';
		} finally {
			loading = false;
		}
	}

	function handleReset() {
		tenantId = settingsContext.tenantId;
		testTenantId = tenantId;
		selectedClientIds = [];
		sessionIds = '';
		categories = {
			'http-request': false,
			'http-response': false,
			'token-validation': true,
			'auth-decision': true
		};
		format = 'json';
		sortMode = 'timeline';
		exportMode = 'masked';
		includeStats = false;
		error = '';
		success = '';
	}

	async function handleTestConnection() {
		testError = '';
		testSuccess = '';
		testLatency = null;
		testLoading = true;

		try {
			const response = await fetch('/api/admin/diagnostic-logging/test-connection', {
				method: 'POST',
				credentials: 'include',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					tenantId: testTenantId || settingsContext.tenantId,
					r2BucketBinding,
					pathPrefix
				})
			});

			const data = await response.json().catch(() => ({}));

			if (!response.ok) {
				throw new Error(data.message || 'Connection test failed');
			}

			testSuccess = data.message || 'R2 connection successful';
			testLatency = typeof data.latencyMs === 'number' ? data.latencyMs : null;
		} catch (err) {
			testError = err instanceof Error ? err.message : 'Connection test failed';
		} finally {
			testLoading = false;
		}
	}
</script>

<svelte:head>
	<title>Diagnostic Logging - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="diagnostic-logging-page">
	<div class="page-header">
		<h1 class="page-title">Diagnostic Logging</h1>
		<p class="page-description">
			Export diagnostic logs for OIDF conformance testing, debugging, and compliance audits.
		</p>
	</div>

	{#if error}
		<Alert variant="error" dismissible onDismiss={() => (error = '')}>
			{error}
		</Alert>
	{/if}

	{#if success}
		<Alert variant="success" dismissible onDismiss={() => (success = '')}>
			{success}
		</Alert>
	{/if}

	{#if settingsError}
		<Alert variant="error" dismissible onDismiss={() => (settingsError = '')}>
			{settingsError}
		</Alert>
	{/if}

	<!-- Tab Navigation -->
	<div class="tabs-nav">
		{#each TAB_DEFINITIONS as tab (tab.id)}
			<button
				class="tab-button"
				class:active={activeTab === tab.id}
				onclick={() => handleTabChange(tab.id)}
			>
				{tab.label}
			</button>
		{/each}
	</div>

	<!-- Tab Content -->
	<div class="tab-content">
		{#if activeTab === 'settings'}
			<!-- Settings Tab -->
			<div class="settings-form-card">
				<div class="card-section">
					<h2 class="card-title">Logging Status</h2>
					<p class="card-subtitle">Enable or disable diagnostic logging for this tenant.</p>

					<div class="toggle-item">
						<h3 class="toggle-item-title">Diagnostic Logging</h3>
						<p class="toggle-item-description">
							Enable or disable diagnostic logging for this tenant.
						</p>
						<div class="toggle-row">
							<ToggleSwitch
								checked={loggingEnabled}
								disabled={!canEdit || settingsLoading || settingsSaving}
								label="Diagnostic logging"
								description={loggingEnabled ? 'Logging is enabled.' : 'Logging is disabled.'}
								onchange={handleToggleLogging}
							/>
							{#if settingsLoading}
								<span class="inline-muted">Loading...</span>
							{:else if settingsSaving}
								<span class="inline-muted">Saving...</span>
							{/if}
						</div>
					</div>

					<div class="toggle-item">
						<h3 class="toggle-item-title">R2 Output</h3>
						<p class="toggle-item-description">
							When enabled, logs are persisted to R2 for export. When disabled, logs are only
							emitted to console and exports return empty results.
						</p>
						<div class="toggle-row">
							<ToggleSwitch
								checked={r2OutputEnabled}
								disabled={!canEdit || settingsLoading || settingsSaving}
								label="Persist logs to R2"
								description={r2OutputEnabled ? 'R2 output is enabled.' : 'R2 output is disabled.'}
								onchange={handleToggleR2Output}
							/>
							{#if settingsLoading}
								<span class="inline-muted">Loading...</span>
							{:else if settingsSaving}
								<span class="inline-muted">Saving...</span>
							{/if}
						</div>
					</div>

					<div class="toggle-item">
						<h3 class="toggle-item-title">SDK Log Ingestion</h3>
						<p class="toggle-item-description">
							Accept diagnostic logs from client SDKs (Web, Node.js, etc.) via the public ingest
							API. Requires client_id authentication.
						</p>
						<div class="toggle-row">
							<ToggleSwitch
								checked={sdkIngestEnabled}
								disabled={!canEdit || settingsLoading || settingsSaving}
								label="Accept SDK logs"
								description={sdkIngestEnabled
									? 'SDK ingestion is enabled.'
									: 'SDK ingestion is disabled.'}
								onchange={handleToggleSdkIngest}
							/>
							{#if settingsLoading}
								<span class="inline-muted">Loading...</span>
							{:else if settingsSaving}
								<span class="inline-muted">Saving...</span>
							{/if}
						</div>
					</div>

					<div class="toggle-item">
						<h3 class="toggle-item-title">Merged Log Output</h3>
						<p class="toggle-item-description">
							Export server and SDK logs in a single merged timeline using diagnosticSessionId
							correlation. Useful for OIDF conformance testing and end-to-end debugging. (Requires
							SDK Log Ingestion enabled)
						</p>
						<div class="toggle-row">
							<ToggleSwitch
								checked={mergedOutputEnabled}
								disabled={!canEdit || settingsLoading || settingsSaving || !sdkIngestEnabled}
								label="Enable merged export"
								description={mergedOutputEnabled
									? 'Merged output is enabled.'
									: 'Merged output is disabled.'}
								onchange={handleToggleMergedOutput}
							/>
							{#if settingsLoading}
								<span class="inline-muted">Loading...</span>
							{:else if settingsSaving}
								<span class="inline-muted">Saving...</span>
							{/if}
						</div>
					</div>
				</div>
			</div>
		{:else if activeTab === 'export'}
			<!-- Export Tab -->
			<form class="settings-form-card" onsubmit={handleExport}>
				<div class="card-section">
					<h2 class="card-title">Export Filters</h2>
					<p class="card-subtitle">Narrow the data set before downloading logs.</p>
				</div>

				<div class="card-section">
					<div class="form-grid">
						<div class="form-group">
							<label for="tenantId">Tenant ID</label>
							<input
								id="tenantId"
								class="settings-input"
								type="text"
								bind:value={tenantId}
								onchange={(event) => handleTenantChange(event.currentTarget.value)}
							/>
						</div>
					</div>
				</div>

				<div class="card-section">
					<h3 class="card-title-sm">Date Range</h3>
					<p class="form-hint">Defaults to the last 7 days when left blank.</p>
					<div class="date-time-grid">
						<div class="date-time-group">
							<label for="startDate">Start Date & Time</label>
							<div class="date-time-row">
								<input id="startDate" class="settings-input" type="date" bind:value={startDate} />
								<input
									id="startTime"
									class="settings-input"
									type="time"
									bind:value={startTime}
									step="1"
								/>
							</div>
							{#if startDateTimeDisplay}
								<div class="datetime-preview">
									<div class="datetime-preview-line">{startDateTimeDisplay.utc}</div>
									<div class="datetime-preview-line">{startDateTimeDisplay.local}</div>
								</div>
							{/if}
						</div>
						<div class="date-time-group">
							<label for="endDate">End Date & Time</label>
							<div class="date-time-row">
								<input id="endDate" class="settings-input" type="date" bind:value={endDate} />
								<input
									id="endTime"
									class="settings-input"
									type="time"
									bind:value={endTime}
									step="1"
								/>
							</div>
							{#if endDateTimeDisplay}
								<div class="datetime-preview">
									<div class="datetime-preview-line">{endDateTimeDisplay.utc}</div>
									<div class="datetime-preview-line">{endDateTimeDisplay.local}</div>
								</div>
							{/if}
						</div>
					</div>
				</div>

				<div class="card-section">
					<h3 class="card-title-sm">Clients</h3>
					<p class="form-hint">
						Select one or more clients to filter results. Leave blank to export all clients.
					</p>
					{#if clientsLoading}
						<p class="empty-state">Loading clients...</p>
					{:else if clientsError}
						<p class="empty-state">{clientsError}</p>
					{:else if clientOptions.length === 0}
						<p class="empty-state">No clients found for this tenant.</p>
					{:else}
						<div class="checkbox-grid">
							{#each clientOptions as client (client.id)}
								<label class="settings-checkbox-label">
									<input
										class="settings-checkbox"
										type="checkbox"
										checked={selectedClientIds.includes(client.id)}
										onchange={(event) =>
											toggleClientSelection(client.id, event.currentTarget.checked)}
									/>
									<span class="settings-checkbox-text">{client.name}</span>
								</label>
							{/each}
						</div>
					{/if}
				</div>

				<div class="card-section">
					<h3 class="card-title-sm">Session IDs</h3>
					<p class="form-hint">Comma-separated diagnosticSessionId values.</p>
					<textarea
						class="settings-textarea"
						rows="3"
						placeholder="session-123, session-456"
						bind:value={sessionIds}
					></textarea>
				</div>

				<div class="card-section">
					<h3 class="card-title-sm">Categories</h3>
					<div class="categories-container">
						<label class="category-checkbox-card" class:checked={categories['http-request']}>
							<input
								class="settings-checkbox"
								type="checkbox"
								bind:checked={categories['http-request']}
							/>
							<div class="category-content">
								<span class="category-checkbox-text">HTTP Request</span>
								<span class="category-description">Full request including Authorization header</span
								>
							</div>
						</label>
						<label class="category-checkbox-card" class:checked={categories['http-response']}>
							<input
								class="settings-checkbox"
								type="checkbox"
								bind:checked={categories['http-response']}
							/>
							<div class="category-content">
								<span class="category-checkbox-text">HTTP Response</span>
								<span class="category-description">Status code, headers, response body</span>
							</div>
						</label>
						<label class="category-checkbox-card" class:checked={categories['token-validation']}>
							<input
								class="settings-checkbox"
								type="checkbox"
								bind:checked={categories['token-validation']}
							/>
							<div class="category-content">
								<span class="category-checkbox-text">Token Validation</span>
								<span class="category-description"
									>JWT validation, signature verification, claims validation</span
								>
							</div>
						</label>
						<label class="category-checkbox-card" class:checked={categories['auth-decision']}>
							<input
								class="settings-checkbox"
								type="checkbox"
								bind:checked={categories['auth-decision']}
							/>
							<div class="category-content">
								<span class="category-checkbox-text">Auth Decision</span>
								<span class="category-description"
									>Authorization logic, policy evaluation results</span
								>
							</div>
						</label>
					</div>
				</div>

				<div class="card-section">
					<h3 class="card-title-sm">Format</h3>
					<div class="form-grid format-grid">
						<div class="form-group">
							<label for="format">Export format</label>
							<select id="format" class="settings-select" bind:value={format}>
								<option value="json">JSON (pretty)</option>
								<option value="jsonl">JSONL (streaming)</option>
								<option value="text">Text (grouped)</option>
							</select>
						</div>
						<div class="form-group">
							<label for="sortMode">Sort mode</label>
							<select id="sortMode" class="settings-select" bind:value={sortMode}>
								<option value="timeline">Timeline (mixed)</option>
								<option value="category">Category (grouped)</option>
								<option value="session">Session (grouped)</option>
							</select>
						</div>
						<div class="form-group">
							<label for="exportMode">Export privacy</label>
							<select id="exportMode" class="settings-select" bind:value={exportMode}>
								<option value="full">Full (if stored)</option>
								<option value="masked">Masked</option>
								<option value="minimal">Minimal</option>
							</select>
						</div>
						<div class="form-group checkbox-group">
							<label class="settings-checkbox-label">
								<input class="settings-checkbox" type="checkbox" bind:checked={includeStats} />
								<span class="settings-checkbox-text">Include statistics summary</span>
							</label>
						</div>
					</div>
				</div>

				<div class="settings-actions">
					<button class="btn btn-secondary" type="button" onclick={handleReset} disabled={loading}>
						Reset
					</button>
					<button class="btn btn-primary" type="submit" disabled={loading}>
						{#if loading}
							Exporting...
						{:else}
							Export Logs
						{/if}
					</button>
				</div>
			</form>

			<div class="settings-form-card">
				<div class="card-section">
					<h2 class="card-title">Usage Notes</h2>
					<ul class="info-list">
						<li>Use diagnosticSessionId values for OIDF conformance submissions.</li>
						<li>JSONL is best for streaming pipelines and log aggregators.</li>
						<li>Include statistics for audit trails and compliance exports.</li>
					</ul>
				</div>
			</div>
		{:else if activeTab === 'storage'}
			<!-- Storage Tab -->
			<div class="settings-form-card">
				<div class="card-section">
					<h3 class="card-title-sm">Storage Mode</h3>
					<p class="card-subtitle">
						Choose how much sensitive data is stored for each client. Stored logs cannot be exported
						at a higher fidelity than they were recorded.
					</p>
					<div class="form-grid">
						<div class="form-group">
							<label for="storageModeDefault">Default storage mode</label>
							<select
								id="storageModeDefault"
								class="settings-select"
								bind:value={storageModeDefault}
								disabled={!canEdit || settingsLoading || settingsSaving}
							>
								<option value="full">Full (PII + tokens)</option>
								<option value="masked">Masked / hashed</option>
								<option value="minimal">Minimal (non-PII only)</option>
							</select>
						</div>
					</div>

					<h4 class="card-title-sm" style="margin-top: 16px;">Client overrides</h4>
					{#if clientsLoading}
						<p class="empty-state">Loading clients...</p>
					{:else if clientsError}
						<p class="empty-state">{clientsError}</p>
					{:else if clientOptions.length === 0}
						<p class="empty-state">No clients found for this tenant.</p>
					{:else}
						<div class="client-overrides-section">
							<div class="search-row">
								<input
									type="text"
									class="settings-input"
									placeholder="Search clients..."
									bind:value={clientSearchQuery}
								/>
							</div>

							<div class="overrides-table-wrapper">
								<table class="overrides-table">
									<thead>
										<tr>
											<th>Client</th>
											<th>Storage Mode</th>
										</tr>
									</thead>
									<tbody>
										{#each filteredClientOptions as client (client.id)}
											<tr>
												<td>
													<div class="client-info">
														<span class="client-name">{client.name}</span>
														<span class="client-id">{client.id}</span>
													</div>
												</td>
												<td>
													<select
														class="settings-select compact"
														value={getClientStorageMode(client.id)}
														onchange={(event) =>
															setClientStorageMode(client.id, event.currentTarget.value)}
														disabled={!canEdit || settingsLoading || settingsSaving}
													>
														<option value="inherit">Inherit default</option>
														<option value="full">Full</option>
														<option value="masked">Masked</option>
														<option value="minimal">Minimal</option>
													</select>
												</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						</div>
					{/if}

					<div class="settings-actions">
						<button
							class="btn btn-secondary"
							type="button"
							onclick={() => (storageModeOverrides = {})}
							disabled={!canEdit || settingsSaving}
						>
							Clear Overrides
						</button>
						<button
							class="btn btn-primary"
							type="button"
							onclick={handleSaveStorageModes}
							disabled={!canEdit || settingsSaving}
						>
							{#if settingsSaving}
								Saving...
							{:else}
								Save Storage Modes
							{/if}
						</button>
					</div>
				</div>
			</div>

			<div class="settings-form-card">
				<div class="card-section">
					<h2 class="card-title">Storage Connection</h2>
					<p class="card-subtitle">Verify R2 connectivity before exporting large volumes.</p>
				</div>

				<div class="card-section">
					<div class="form-grid">
						<div class="form-group">
							<label for="testTenantId">Tenant ID</label>
							<input
								id="testTenantId"
								class="settings-input"
								type="text"
								bind:value={testTenantId}
							/>
						</div>
						<div class="form-group">
							<label for="r2BucketBinding">R2 binding</label>
							<input
								id="r2BucketBinding"
								class="settings-input"
								type="text"
								bind:value={r2BucketBinding}
							/>
						</div>
						<div class="form-group">
							<label for="pathPrefix">Path prefix</label>
							<input id="pathPrefix" class="settings-input" type="text" bind:value={pathPrefix} />
						</div>
					</div>
				</div>

				{#if testError}
					<div class="card-section">
						<Alert variant="error" dismissible onDismiss={() => (testError = '')}>
							{testError}
						</Alert>
					</div>
				{/if}

				{#if testSuccess}
					<div class="card-section">
						<Alert variant="success" dismissible onDismiss={() => (testSuccess = '')}>
							{testSuccess}
							{#if testLatency !== null}
								<span class="inline-muted">({testLatency} ms)</span>
							{/if}
						</Alert>
					</div>
				{/if}

				<div class="settings-actions">
					<button
						class="btn btn-secondary"
						type="button"
						onclick={handleTestConnection}
						disabled={testLoading}
					>
						{#if testLoading}
							Testing...
						{:else}
							Test Connection
						{/if}
					</button>
				</div>
			</div>
		{/if}
	</div>
</div>

<style>
	.diagnostic-logging-page {
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.page-header {
		margin-bottom: 8px;
	}

	.page-title {
		margin: 0 0 8px 0;
		font-size: 1.75rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.page-description {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.9375rem;
	}

	/* Tabs Navigation */
	.tabs-nav {
		display: flex;
		gap: 4px;
		border-bottom: 2px solid var(--border);
		margin-bottom: 20px;
	}

	.tab-button {
		padding: 12px 20px;
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		margin-bottom: -2px;
		font-size: 0.9375rem;
		font-weight: 500;
		color: var(--text-secondary);
		cursor: pointer;
		transition: all 0.2s ease;
	}

	.tab-button:hover {
		color: var(--text-primary);
		background-color: var(--bg-hover);
	}

	.tab-button.active {
		color: var(--primary);
		border-bottom-color: var(--primary);
	}

	/* Tab Content */
	.tab-content {
		display: flex;
		flex-direction: column;
		gap: 20px;
	}

	.card-section {
		padding: 16px 20px;
		border-top: 1px solid var(--border);
	}

	.card-section:first-child {
		border-top: none;
	}

	.card-title {
		margin: 0 0 4px 0;
		font-size: 1rem;
		color: var(--text-primary);
	}

	.card-title-sm {
		margin: 0 0 6px 0;
		font-size: 0.9rem;
		color: var(--text-primary);
	}

	.card-subtitle {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	.toggle-item {
		margin-top: 24px;
		padding-top: 24px;
		border-top: 1px solid var(--border);
	}

	.toggle-item:first-child {
		margin-top: 16px;
		padding-top: 16px;
		border-top: none;
	}

	.toggle-item-title {
		margin: 0 0 6px 0;
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.toggle-item-description {
		margin: 0 0 12px 0;
		font-size: 0.875rem;
		color: var(--text-secondary);
		line-height: 1.5;
	}

	.toggle-row {
		display: flex;
		align-items: center;
		gap: 16px;
	}

	.form-grid {
		display: grid;
		gap: 16px;
		grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
	}

	.format-grid {
		align-items: start;
	}

	.form-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.checkbox-group {
		display: flex;
		align-items: center;
		padding-top: 28px;
	}

	.checkbox-group .settings-checkbox-label {
		margin: 0;
	}

	.form-group label {
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-secondary);
	}

	.form-hint {
		margin: 0 0 12px 0;
		color: var(--text-muted);
		font-size: 0.8125rem;
	}

	.settings-textarea {
		width: 100%;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		font-size: 0.875rem;
		background-color: var(--bg-card);
		color: var(--text-primary);
		resize: vertical;
		min-height: 90px;
	}

	.settings-textarea:focus {
		outline: none;
		border-color: var(--primary);
		box-shadow: 0 0 0 3px var(--primary-light);
	}

	.checkbox-grid {
		display: grid;
		gap: 10px 16px;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
	}

	.empty-state {
		margin: 0;
		color: var(--text-muted);
		font-size: 0.875rem;
	}

	.inline-muted {
		color: var(--text-muted);
		margin-left: 6px;
	}

	.info-list {
		margin: 0;
		padding-left: 18px;
		color: var(--text-secondary);
		line-height: 1.6;
	}

	/* Export Tab - Date Time Grid */
	.date-time-grid {
		display: grid;
		gap: 20px;
		grid-template-columns: 1fr 1fr;
	}

	.date-time-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.date-time-row {
		display: flex;
		gap: 8px;
	}

	.date-time-row input[type='date'],
	.date-time-row input[type='time'] {
		flex: 1;
		min-width: 0;
	}

	.datetime-preview {
		margin-top: 8px;
		padding: 8px 12px;
		background-color: var(--bg-subtle);
		border-radius: var(--radius-sm);
		font-size: 0.8125rem;
		color: var(--text-secondary);
		font-family: var(--font-mono);
	}

	.datetime-preview-line {
		line-height: 1.6;
	}

	@media (max-width: 768px) {
		.date-time-grid {
			grid-template-columns: 1fr;
		}
	}

	/* Export Tab - Categories Container */
	.categories-container {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
		gap: 12px;
		margin-top: 12px;
	}

	.category-checkbox-card {
		background-color: var(--bg-subtle);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 12px 16px;
		transition: all var(--transition-fast);
		cursor: pointer;
		display: flex;
		align-items: flex-start;
		gap: 10px;
	}

	.category-checkbox-card:hover {
		background-color: var(--bg-card);
		border-color: var(--primary-light);
	}

	.category-checkbox-card.checked {
		background-color: var(--primary-light);
		border-color: var(--primary);
	}

	.category-content {
		display: flex;
		flex-direction: column;
		gap: 4px;
		flex: 1;
	}

	.category-checkbox-text {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.category-description {
		font-size: 0.75rem;
		color: var(--text-muted);
		line-height: 1.4;
	}

	.settings-checkbox {
		margin-top: 2px;
		flex-shrink: 0;
	}

	/* Storage Tab - Client Overrides */
	.client-overrides-section {
		margin-top: 16px;
	}

	.search-row {
		margin-bottom: 12px;
	}

	.overrides-table-wrapper {
		max-height: 400px;
		overflow-y: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
	}

	.overrides-table {
		width: 100%;
		border-collapse: collapse;
	}

	.overrides-table thead {
		position: sticky;
		top: 0;
		background-color: var(--bg-subtle);
		z-index: 1;
	}

	.overrides-table th {
		padding: 12px 16px;
		text-align: left;
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-secondary);
		border-bottom: 1px solid var(--border);
	}

	.overrides-table td {
		padding: 12px 16px;
		border-bottom: 1px solid var(--border);
	}

	.overrides-table tbody tr:hover {
		background-color: var(--bg-hover);
	}

	.client-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.client-name {
		font-size: 0.875rem;
		color: var(--text-primary);
		font-weight: 500;
	}

	.client-id {
		font-size: 0.75rem;
		color: var(--text-muted);
		font-family: var(--font-mono);
	}

	.settings-select.compact {
		width: 180px;
	}
</style>
