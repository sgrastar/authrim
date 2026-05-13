<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		adminPluginsAPI,
		type PluginWithStatus,
		type PluginHealthResponse,
		PLUGIN_CATEGORIES
	} from '$lib/api/admin-plugins';
	import { Modal } from '$lib/components';

	let plugins: PluginWithStatus[] = $state([]);
	let loading = $state(true);
	let error = $state('');
	let successMessage = $state('');
	let lastLoadedTenantId = $state('');

	// Filter state
	let filterCategory = $state('');
	let filterEnabled = $state<boolean | undefined>(undefined);

	// Detail dialog state
	let showDetailDialog = $state(false);
	let selectedPlugin: PluginWithStatus | null = $state(null);
	let pluginConfig: Record<string, unknown> = $state({});
	let pluginSchema: JSONSchema | null = $state(null);
	let editedConfig: Record<string, unknown> = $state({});
	let loadingConfig = $state(false);
	let savingConfig = $state(false);
	let isEditMode = $state(false);
	let testEmailAddress = $state('');
	let sendingTestEmail = $state(false);
	let testEmailMessage = $state('');

	// Health check state
	let healthStatus: Record<string, PluginHealthResponse> = $state({});
	let checkingHealth: Record<string, boolean> = $state({});

	function getSelectedTenantId(): string | undefined {
		return settingsContext.tenantId || undefined;
	}

	// JSON Schema type definition
	interface JSONSchemaProperty {
		type?: string;
		format?: string;
		description?: string;
		default?: unknown;
		minimum?: number;
		maximum?: number;
		minLength?: number;
		enum?: string[];
	}

	interface JSONSchema {
		type?: string;
		properties?: Record<string, JSONSchemaProperty>;
		required?: string[];
		schema?: JSONSchema; // Wrapped schema from API response
	}

	async function loadPlugins() {
		loading = true;
		error = '';
		lastLoadedTenantId = getSelectedTenantId() ?? '';

		try {
			const params: { category?: string; enabled?: boolean; tenantId?: string } = {
				tenantId: getSelectedTenantId()
			};
			if (filterCategory) params.category = filterCategory;
			if (filterEnabled !== undefined) params.enabled = filterEnabled;

			const response = await adminPluginsAPI.list(params);
			plugins = response.plugins;

			const pluginId = $page.url.searchParams.get('plugin');
			if (pluginId) {
				const selected = response.plugins.find((plugin) => plugin.id === pluginId);
				if (selected) {
					await openDetailDialog(selected);
				}
			}
		} catch (err) {
			console.error('Failed to load plugins:', err);
			error = 'Failed to load plugins';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadPlugins();
	});

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (tenantId && tenantId !== lastLoadedTenantId) {
			void loadPlugins();
		}
	});

	async function toggleEnabled(plugin: PluginWithStatus, event: Event) {
		event.stopPropagation();
		try {
			if (plugin.enabled) {
				await adminPluginsAPI.disable(plugin.id, getSelectedTenantId());
			} else {
				await adminPluginsAPI.enable(plugin.id, getSelectedTenantId());
			}
			await loadPlugins();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to update plugin';
		}
	}

	async function checkHealth(plugin: PluginWithStatus, event: Event) {
		event.stopPropagation();
		checkingHealth = { ...checkingHealth, [plugin.id]: true };

		try {
			const result = await adminPluginsAPI.checkHealth(plugin.id, getSelectedTenantId());
			healthStatus = { ...healthStatus, [plugin.id]: result };
		} catch (err) {
			healthStatus = {
				...healthStatus,
				[plugin.id]: {
					status: 'unhealthy',
					message: err instanceof Error ? err.message : 'Health check failed'
				}
			};
		} finally {
			checkingHealth = { ...checkingHealth, [plugin.id]: false };
		}
	}

	async function openDetailDialog(plugin: PluginWithStatus) {
		selectedPlugin = plugin;
		pluginConfig = {};
		pluginSchema = null;
		editedConfig = {};
		isEditMode = false;
		loadingConfig = true;
		showDetailDialog = true;
		error = '';
		successMessage = '';

		try {
			// Load config and schema in parallel
			const [detail, schemaResponse] = await Promise.all([
				adminPluginsAPI.get(plugin.id, getSelectedTenantId()),
				adminPluginsAPI.getSchema(plugin.id).catch(() => null)
			]);
			selectedPlugin = {
				...detail.plugin,
				...detail.status
			};
			pluginConfig = detail.config;
			editedConfig = { ...detail.config };
			testEmailAddress = '';
			testEmailMessage = '';

			// Schema is wrapped in { pluginId, version, schema, meta }
			if (schemaResponse && typeof schemaResponse === 'object' && 'schema' in schemaResponse) {
				pluginSchema = schemaResponse.schema as JSONSchema;
			} else if (schemaResponse) {
				pluginSchema = schemaResponse as JSONSchema;
			}
		} catch (err) {
			console.error('Failed to load plugin config:', err);
			error = err instanceof Error ? err.message : 'Failed to load plugin configuration';
		} finally {
			loadingConfig = false;
		}
	}

	function closeDetailDialog() {
		showDetailDialog = false;
		selectedPlugin = null;
		pluginConfig = {};
		pluginSchema = null;
		editedConfig = {};
		isEditMode = false;
		testEmailAddress = '';
		testEmailMessage = '';
	}

	function startEditing() {
		editedConfig = { ...pluginConfig };
		isEditMode = true;
		error = '';
		successMessage = '';
	}

	function cancelEditing() {
		editedConfig = { ...pluginConfig };
		isEditMode = false;
		error = '';
	}

	async function saveConfig() {
		if (!selectedPlugin) return;

		savingConfig = true;
		error = '';
		successMessage = '';

		try {
			await adminPluginsAPI.updateConfig(
				selectedPlugin.id,
				{ config: editedConfig },
				getSelectedTenantId()
			);
			const refreshed = await adminPluginsAPI.get(selectedPlugin.id, getSelectedTenantId());
			selectedPlugin = {
				...refreshed.plugin,
				...refreshed.status
			};
			pluginConfig = { ...refreshed.config };
			editedConfig = { ...refreshed.config };
			isEditMode = false;
			successMessage = 'Configuration saved successfully';

			// Clear success message after 3 seconds
			setTimeout(() => {
				successMessage = '';
			}, 3000);
		} catch (err) {
			console.error('Failed to save config:', err);
			error = err instanceof Error ? err.message : 'Failed to save configuration';
		} finally {
			savingConfig = false;
		}
	}

	function updateConfigValue(key: string, value: unknown) {
		editedConfig = { ...editedConfig, [key]: value };
	}

	async function sendTestEmail() {
		if (!selectedPlugin || !testEmailAddress.trim()) {
			error = 'Enter a recipient email address';
			return;
		}

		sendingTestEmail = true;
		error = '';
		successMessage = '';
		testEmailMessage = '';

		try {
			const result = await adminPluginsAPI.sendTestEmail(selectedPlugin.id, {
				to: testEmailAddress.trim(),
				config: editedConfig,
				tenantId: getSelectedTenantId()
			});
			testEmailMessage = result.messageId
				? `Test email sent (${result.messageId})`
				: 'Test email sent';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to send test email';
		} finally {
			sendingTestEmail = false;
		}
	}

	function getInputType(prop: JSONSchemaProperty): string {
		if (prop.type === 'boolean') return 'checkbox';
		if (prop.type === 'integer' || prop.type === 'number') return 'number';
		if (prop.format === 'email') return 'email';
		if (prop.format === 'uri') return 'url';
		if (isSecretField(prop)) return 'password';
		return 'text';
	}

	function isSecretField(prop: JSONSchemaProperty, key?: string): boolean {
		// Check if field is a secret based on description or key name
		const secretPatterns = ['api key', 'password', 'secret', 'token', 'credential'];
		const desc = (prop.description || '').toLowerCase();
		const keyLower = (key || '').toLowerCase();

		return (
			secretPatterns.some((p) => desc.includes(p)) ||
			secretPatterns.some((p) => keyLower.includes(p.replace(' ', '')))
		);
	}

	function isFieldRequired(key: string): boolean {
		return pluginSchema?.required?.includes(key) ?? false;
	}

	function applyFilters() {
		loadPlugins();
	}

	function clearFilters() {
		filterCategory = '';
		filterEnabled = undefined;
		loadPlugins();
	}

	function getSourceIcon(type: string): string {
		switch (type) {
			case 'builtin':
				return '📦';
			case 'npm':
				return '📥';
			case 'local':
				return '📁';
			default:
				return '❓';
		}
	}

	function getTrustLevelClass(level: string): string {
		switch (level) {
			case 'official':
				return 'badge-trust official';
			case 'verified':
				return 'badge-trust verified';
			case 'community':
				return 'badge-trust community';
			default:
				return 'badge-trust';
		}
	}

	function getStabilityClass(stability: string): string {
		switch (stability) {
			case 'stable':
				return 'badge-stability stable';
			case 'beta':
				return 'badge-stability beta';
			case 'alpha':
				return 'badge-stability alpha';
			case 'experimental':
				return 'badge-stability experimental';
			default:
				return 'badge-stability';
		}
	}

	function getHealthStatusClass(status: string): string {
		switch (status) {
			case 'healthy':
				return 'health-status healthy';
			case 'unhealthy':
				return 'health-status unhealthy';
			case 'degraded':
				return 'health-status degraded';
			default:
				return 'health-status unknown';
		}
	}

	function getHealthDotClass(status: string): string {
		switch (status) {
			case 'healthy':
				return 'health-dot healthy';
			case 'unhealthy':
				return 'health-dot unhealthy';
			case 'degraded':
				return 'health-dot degraded';
			default:
				return 'health-dot';
		}
	}
</script>

<div class="admin-page">
	<div class="page-header">
		<div class="page-header-info">
			<h1 class="page-title">Plugins</h1>
			<p class="modal-description">
				Manage installed plugins to extend Authrim's functionality with custom authentication flows,
				event handlers, claims providers, and integrations.
			</p>
		</div>
	</div>

	<!-- Filters -->
	<div class="filter-bar">
		<div class="form-group">
			<label for="filter-category" class="form-label">Category</label>
			<select id="filter-category" class="form-select" bind:value={filterCategory}>
				<option value="">All Categories</option>
				{#each PLUGIN_CATEGORIES as category (category.id)}
					<option value={category.id}>{category.name}</option>
				{/each}
			</select>
		</div>
		<div class="form-group">
			<label for="filter-status" class="form-label">Status</label>
			<select id="filter-status" class="form-select" bind:value={filterEnabled}>
				<option value={undefined}>All</option>
				<option value={true}>Enabled</option>
				<option value={false}>Disabled</option>
			</select>
		</div>
		<button class="btn-filter" onclick={applyFilters}>Apply</button>
		<button class="btn-clear" onclick={clearFilters}>Clear</button>
	</div>

	{#if error && !showDetailDialog}
		<div class="alert alert-error">{error}</div>
	{/if}

	{#if loading}
		<div class="loading-state">Loading...</div>
	{:else if plugins.length === 0}
		<div class="empty-state">
			<p>No plugins found.</p>
			<p class="text-muted">
				{filterCategory || filterEnabled !== undefined
					? 'Try adjusting your filters.'
					: 'Plugins can be added via npm packages or local configuration.'}
			</p>
		</div>
	{:else}
		<div class="plugin-grid">
			{#each plugins as plugin (plugin.id)}
				<div
					class="plugin-card"
					onclick={() => openDetailDialog(plugin)}
					onkeydown={(e) => e.key === 'Enter' && openDetailDialog(plugin)}
					tabindex="0"
					role="button"
				>
					<!-- Header -->
					<div class="plugin-card-header">
						<div class="plugin-card-info">
							<span class="plugin-icon">{plugin.meta?.icon || '🧩'}</span>
							<div>
								<h3 class="plugin-name">{plugin.meta?.name || plugin.id}</h3>
								<div class="plugin-badges">
									<span class={getTrustLevelClass(plugin.trustLevel)}>
										{plugin.trustLevel}
									</span>
									{#if plugin.meta?.stability}
										<span class={getStabilityClass(plugin.meta.stability)}>
											{plugin.meta.stability}
										</span>
									{/if}
								</div>
							</div>
						</div>
						<button
							class="plugin-status-btn {plugin.enabled ? 'enabled' : 'disabled'}"
							onclick={(e) => toggleEnabled(plugin, e)}
						>
							{plugin.enabled ? 'Enabled' : 'Disabled'}
						</button>
					</div>

					<!-- Description -->
					{#if plugin.meta?.description}
						<p class="plugin-description">{plugin.meta.description}</p>
					{/if}

					<!-- Metadata -->
					<div class="plugin-meta">
						<span class="plugin-meta-item">
							{getSourceIcon(plugin.source.type)}
							{plugin.source.type}
						</span>
						<span class="plugin-meta-item">v{plugin.version}</span>
						<span class="plugin-meta-item">
							{plugin.configured ? `configured via ${plugin.configSource}` : 'needs configuration'}
						</span>
						{#if plugin.meta?.category}
							<span class="badge-category">{plugin.meta.category}</span>
						{/if}
					</div>

					<!-- Capabilities -->
					{#if plugin.capabilities.length > 0}
						<div class="plugin-capabilities">
							{#each plugin.capabilities as cap (cap)}
								<span class="badge-capability">{cap}</span>
							{/each}
						</div>
					{/if}

					<!-- Health Status -->
					<div class="plugin-footer">
						{#if healthStatus[plugin.id]}
							<span class={getHealthStatusClass(healthStatus[plugin.id].status)}>
								<span class={getHealthDotClass(healthStatus[plugin.id].status)}></span>
								{healthStatus[plugin.id].status}
							</span>
						{:else if plugin.lastHealthCheck}
							<span class={getHealthStatusClass(plugin.lastHealthCheck.status)}>
								<span class={getHealthDotClass(plugin.lastHealthCheck.status)}></span>
								{plugin.lastHealthCheck.status}
							</span>
						{:else}
							<span class="health-status unknown">No health data</span>
						{/if}
						<button
							class="health-check-btn"
							onclick={(e) => checkHealth(plugin, e)}
							disabled={checkingHealth[plugin.id]}
						>
							{checkingHealth[plugin.id] ? 'Checking...' : 'Check Health'}
						</button>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<!-- Detail Dialog -->
<Modal
	open={showDetailDialog && !!selectedPlugin}
	onClose={closeDetailDialog}
	title={selectedPlugin?.meta?.name ?? selectedPlugin?.id ?? ''}
	size="lg"
>
	{#snippet header()}
		<div class="plugin-dialog-header">
			<div class="plugin-dialog-info">
				<span class="plugin-dialog-icon">{selectedPlugin?.meta?.icon || '🧩'}</span>
				<div>
					<h2 class="plugin-dialog-title">
						{selectedPlugin?.meta?.name || selectedPlugin?.id}
					</h2>
					<div class="plugin-dialog-version">v{selectedPlugin?.version}</div>
				</div>
			</div>
			<button class="close-btn" onclick={closeDetailDialog}>×</button>
		</div>
	{/snippet}

	{#if selectedPlugin?.trustLevel === 'community'}
		<div class="warning-banner">
			⚠️ This is a community plugin. Authrim does not guarantee its security, reliability, or
			compatibility.
		</div>
	{/if}

	{#if selectedPlugin?.meta?.description}
		<p class="plugin-description">{selectedPlugin.meta.description}</p>
	{/if}

	<div class="plugin-info-grid">
		<div class="plugin-info-item">
			<div class="plugin-info-label">Source</div>
			<div class="plugin-info-value">
				{getSourceIcon(selectedPlugin?.source.type ?? '')}
				{selectedPlugin?.source.type}
				{#if selectedPlugin?.source.identifier}
					<div class="plugin-info-subvalue">{selectedPlugin.source.identifier}</div>
				{/if}
			</div>
		</div>
		<div class="plugin-info-item">
			<div class="plugin-info-label">Status</div>
			<div class="plugin-info-value">
				{selectedPlugin?.enabled ? '✓ Enabled' : '○ Disabled'}
				<div class="plugin-info-subvalue">
					{selectedPlugin?.configured
						? `Configured via ${selectedPlugin.configSource}`
						: 'Missing required configuration'}
				</div>
				{#if selectedPlugin && !selectedPlugin.configured && selectedPlugin.missingRequiredFields.length > 0}
					<div class="plugin-info-subvalue">
						Required: {selectedPlugin.missingRequiredFields.join(', ')}
					</div>
				{/if}
			</div>
		</div>
	</div>

	{#if selectedPlugin && selectedPlugin.capabilities.length > 0}
		<div class="plugin-section">
			<div class="plugin-section-title">Capabilities</div>
			<div class="plugin-capabilities">
				{#each selectedPlugin.capabilities as cap (cap)}
					<span class="badge-capability">{cap}</span>
				{/each}
			</div>
		</div>
	{/if}

	{#if selectedPlugin?.meta?.author}
		<div class="plugin-section">
			<div class="plugin-section-title">Author</div>
			<div class="plugin-info-value">
				{selectedPlugin.meta.author.name}
				{#if selectedPlugin.meta.author.url}
					<a
						href={selectedPlugin.meta.author.url}
						target="_blank"
						rel="noopener noreferrer"
						class="plugin-doc-link"
					>
						↗
					</a>
				{/if}
			</div>
		</div>
	{/if}

	{#if selectedPlugin?.meta?.documentationUrl}
		<div class="plugin-section">
			<a
				href={selectedPlugin.meta.documentationUrl}
				target="_blank"
				rel="noopener noreferrer"
				class="plugin-doc-link"
			>
				📖 Documentation ↗
			</a>
		</div>
	{/if}

	<!-- Success/Error Messages -->
	{#if successMessage}
		<div class="alert alert-success">✓ {successMessage}</div>
	{/if}
	{#if error && showDetailDialog}
		<div class="alert alert-error">{error}</div>
	{/if}

	<div class="plugin-section">
		<div class="plugin-config-header">
			<div class="plugin-config-title">Configuration</div>
			{#if pluginSchema && !loadingConfig}
				{#if isEditMode}
					<div class="plugin-config-actions">
						<button
							class="btn btn-secondary btn-sm"
							onclick={cancelEditing}
							disabled={savingConfig}
						>
							Cancel
						</button>
						<button class="btn btn-primary btn-sm" onclick={saveConfig} disabled={savingConfig}>
							{savingConfig ? 'Saving...' : 'Save'}
						</button>
					</div>
				{:else}
					<button class="btn btn-primary btn-sm" onclick={startEditing}>Edit</button>
				{/if}
			{/if}
		</div>

		{#if loadingConfig}
			<div class="text-muted">Loading configuration...</div>
		{:else if pluginSchema && pluginSchema.properties}
			<!-- Schema-based form -->
			<div class="plugin-config-form">
				{#each Object.entries(pluginSchema.properties) as [key, prop] (key)}
					<div class="plugin-config-field">
						<!-- svelte-ignore a11y_label_has_associated_control -->
						<label class="plugin-config-label">
							{key}
							{#if isFieldRequired(key)}
								<span class="plugin-config-required">*</span>
							{/if}
						</label>
						{#if prop.description}
							<div class="plugin-config-hint">{prop.description}</div>
						{/if}

						{#if prop.type === 'boolean'}
							<label class="plugin-config-checkbox">
								<input
									type="checkbox"
									checked={Boolean(editedConfig[key] ?? prop.default)}
									disabled={!isEditMode}
									onchange={(e) => updateConfigValue(key, (e.target as HTMLInputElement).checked)}
								/>
								<span class="plugin-config-checkbox-label">
									{(editedConfig[key] ?? prop.default) ? 'Enabled' : 'Disabled'}
								</span>
							</label>
						{:else if prop.enum}
							<select
								class="plugin-config-select"
								value={String(editedConfig[key] ?? prop.default ?? '')}
								disabled={!isEditMode}
								onchange={(e) => updateConfigValue(key, (e.target as HTMLSelectElement).value)}
							>
								{#each prop.enum as option (option)}
									<option value={option}>{option}</option>
								{/each}
							</select>
						{:else}
							<input
								type={getInputType(prop)}
								class="plugin-config-input"
								value={String(editedConfig[key] ?? prop.default ?? '')}
								disabled={!isEditMode}
								oninput={(e) => {
									const target = e.target as HTMLInputElement;
									const value =
										prop.type === 'integer' || prop.type === 'number'
											? Number(target.value)
											: target.value;
									updateConfigValue(key, value);
								}}
								placeholder={prop.default !== undefined ? String(prop.default) : ''}
								min={prop.minimum}
								max={prop.maximum}
							/>
						{/if}
					</div>
				{/each}
			</div>
		{:else if Object.keys(pluginConfig).length === 0}
			<div class="text-muted">No configuration available.</div>
		{:else}
			<!-- Fallback: JSON view when no schema -->
			<pre class="plugin-config-json">{JSON.stringify(pluginConfig, null, 2)}</pre>
		{/if}
	</div>

	{#if selectedPlugin?.capabilities.includes('notifier.email')}
		<div class="plugin-section">
			<div class="plugin-config-header">
				<div class="plugin-config-title">Send Test Email</div>
			</div>
			<div class="plugin-config-field">
				<label class="plugin-config-label" for="plugin-test-email">Recipient Email</label>
				<input
					id="plugin-test-email"
					type="email"
					class="plugin-config-input"
					bind:value={testEmailAddress}
					placeholder="you@example.com"
				/>
				<div class="plugin-config-hint">
					Uses the current tenant-scoped plugin settings. Unsaved edits in this dialog are included.
				</div>
			</div>
			<div class="plugin-test-actions">
				<button
					class="btn btn-primary btn-sm"
					onclick={sendTestEmail}
					disabled={sendingTestEmail || !selectedPlugin?.enabled}
				>
					{sendingTestEmail ? 'Sending...' : 'Send Test Email'}
				</button>
				{#if !selectedPlugin?.enabled}
					<span class="text-muted">Enable the plugin before sending a test email.</span>
				{/if}
			</div>
			{#if testEmailMessage}
				<div class="alert alert-success">✓ {testEmailMessage}</div>
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeDetailDialog}>Close</button>
	{/snippet}
</Modal>
