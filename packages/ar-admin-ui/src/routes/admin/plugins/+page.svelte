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
	import { LL } from '$i18n/i18n-svelte';

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

	function safePluginUrl(url: string | undefined): string | null {
		if (!url) return null;
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== 'https:') return null;
			return parsed.toString();
		} catch {
			return null;
		}
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
			error = $LL.admin_plugins_load_failed();
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
			error = err instanceof Error ? err.message : $LL.admin_plugins_update_failed();
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
					message: err instanceof Error ? err.message : $LL.admin_plugins_health_check_failed()
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
			error = err instanceof Error ? err.message : $LL.admin_plugins_load_config_failed();
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
			successMessage = $LL.admin_plugins_config_saved();

			// Clear success message after 3 seconds
			setTimeout(() => {
				successMessage = '';
			}, 3000);
		} catch (err) {
			console.error('Failed to save config:', err);
			error = err instanceof Error ? err.message : $LL.admin_plugins_save_config_failed();
		} finally {
			savingConfig = false;
		}
	}

	function updateConfigValue(key: string, value: unknown) {
		editedConfig = { ...editedConfig, [key]: value };
	}

	async function sendTestEmail() {
		if (!selectedPlugin || !testEmailAddress.trim()) {
			error = $LL.admin_plugins_recipient_required();
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
				? $LL.admin_plugins_test_email_sent_with_id({ messageId: result.messageId })
				: $LL.admin_plugins_test_email_sent();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_plugins_test_email_failed();
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

	function formatCategory(id: string): string {
		switch (id) {
			case 'authentication':
				return $LL.admin_plugins_category_authentication();
			case 'mfa':
				return $LL.admin_plugins_category_mfa();
			case 'integration':
				return $LL.admin_plugins_category_integration();
			case 'notification':
				return $LL.admin_plugins_category_notification();
			case 'analytics':
				return $LL.admin_plugins_category_analytics();
			case 'security':
				return $LL.admin_plugins_category_security();
			case 'compliance':
				return $LL.admin_plugins_category_compliance();
			default:
				return id;
		}
	}

	function formatConfigured(configSource: string | undefined): string {
		return configSource
			? $LL.admin_plugins_configured_via({ source: configSource })
			: $LL.admin_plugins_needs_configuration();
	}

	function formatHealthStatus(status: string): string {
		switch (status) {
			case 'healthy':
				return $LL.admin_plugins_health_healthy();
			case 'unhealthy':
				return $LL.admin_plugins_health_unhealthy();
			case 'degraded':
				return $LL.admin_plugins_health_degraded();
			default:
				return $LL.admin_plugins_health_unknown();
		}
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
			<h1 class="page-title">{$LL.admin_plugins_page_title()}</h1>
			<p class="modal-description">
				{$LL.admin_plugins_description()}
			</p>
		</div>
	</div>

	<!-- Filters -->
	<div class="filter-bar">
		<div class="form-group">
			<label for="filter-category" class="form-label">{$LL.admin_plugins_category()}</label>
			<select id="filter-category" class="form-select" bind:value={filterCategory}>
				<option value="">{$LL.admin_plugins_all_categories()}</option>
				{#each PLUGIN_CATEGORIES as category (category.id)}
					<option value={category.id}>{formatCategory(category.id)}</option>
				{/each}
			</select>
		</div>
		<div class="form-group">
			<label for="filter-status" class="form-label">{$LL.admin_plugins_status()}</label>
			<select id="filter-status" class="form-select" bind:value={filterEnabled}>
				<option value={undefined}>{$LL.admin_plugins_all()}</option>
				<option value={true}>{$LL.admin_plugins_enabled()}</option>
				<option value={false}>{$LL.admin_plugins_disabled()}</option>
			</select>
		</div>
		<button class="btn-filter" onclick={applyFilters}>{$LL.admin_plugins_apply()}</button>
		<button class="btn-clear" onclick={clearFilters}>{$LL.admin_plugins_clear()}</button>
	</div>

	{#if error && !showDetailDialog}
		<div class="alert alert-error">{error}</div>
	{/if}

	{#if loading}
		<div class="loading-state">{$LL.admin_plugins_loading()}</div>
	{:else if plugins.length === 0}
		<div class="empty-state">
			<p>{$LL.admin_plugins_empty()}</p>
			<p class="text-muted">
				{filterCategory || filterEnabled !== undefined
					? $LL.admin_plugins_adjust_filters()
					: $LL.admin_plugins_empty_hint()}
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
							{plugin.enabled ? $LL.admin_plugins_enabled() : $LL.admin_plugins_disabled()}
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
							{plugin.configured
								? formatConfigured(plugin.configSource)
								: $LL.admin_plugins_needs_configuration()}
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
								{formatHealthStatus(healthStatus[plugin.id].status)}
							</span>
						{:else if plugin.lastHealthCheck}
							<span class={getHealthStatusClass(plugin.lastHealthCheck.status)}>
								<span class={getHealthDotClass(plugin.lastHealthCheck.status)}></span>
								{formatHealthStatus(plugin.lastHealthCheck.status)}
							</span>
						{:else}
							<span class="health-status unknown">{$LL.admin_plugins_no_health_data()}</span>
						{/if}
						<button
							class="health-check-btn"
							onclick={(e) => checkHealth(plugin, e)}
							disabled={checkingHealth[plugin.id]}
						>
							{checkingHealth[plugin.id]
								? $LL.admin_plugins_checking()
								: $LL.admin_plugins_check_health()}
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
			{$LL.admin_plugins_community_warning()}
		</div>
	{/if}

	{#if selectedPlugin?.meta?.description}
		<p class="plugin-description">{selectedPlugin.meta.description}</p>
	{/if}

	<div class="plugin-info-grid">
		<div class="plugin-info-item">
			<div class="plugin-info-label">{$LL.admin_plugins_source()}</div>
			<div class="plugin-info-value">
				{getSourceIcon(selectedPlugin?.source.type ?? '')}
				{selectedPlugin?.source.type}
				{#if selectedPlugin?.source.identifier}
					<div class="plugin-info-subvalue">{selectedPlugin.source.identifier}</div>
				{/if}
			</div>
		</div>
		<div class="plugin-info-item">
			<div class="plugin-info-label">{$LL.admin_plugins_status()}</div>
			<div class="plugin-info-value">
				{selectedPlugin?.enabled ? $LL.admin_plugins_enabled() : $LL.admin_plugins_disabled()}
				<div class="plugin-info-subvalue">
					{selectedPlugin?.configured
						? formatConfigured(selectedPlugin.configSource)
						: $LL.admin_plugins_missing_required_configuration()}
				</div>
				{#if selectedPlugin && !selectedPlugin.configured && selectedPlugin.missingRequiredFields.length > 0}
					<div class="plugin-info-subvalue">
						{$LL.admin_plugins_required({
							fields: selectedPlugin.missingRequiredFields.join(', ')
						})}
					</div>
				{/if}
			</div>
		</div>
	</div>

	{#if selectedPlugin && selectedPlugin.capabilities.length > 0}
		<div class="plugin-section">
			<div class="plugin-section-title">{$LL.admin_plugins_capabilities()}</div>
			<div class="plugin-capabilities">
				{#each selectedPlugin.capabilities as cap (cap)}
					<span class="badge-capability">{cap}</span>
				{/each}
			</div>
		</div>
	{/if}

	{#if selectedPlugin?.meta?.author}
		{@const authorUrl = safePluginUrl(selectedPlugin.meta.author.url)}
		<div class="plugin-section">
			<div class="plugin-section-title">{$LL.admin_plugins_author()}</div>
			<div class="plugin-info-value">
				{selectedPlugin.meta.author.name}
				{#if authorUrl}
					<a href={authorUrl} target="_blank" rel="noopener noreferrer" class="plugin-doc-link">
						↗
					</a>
				{/if}
			</div>
		</div>
	{/if}

	{#if selectedPlugin?.meta?.documentationUrl}
		{@const documentationUrl = safePluginUrl(selectedPlugin.meta.documentationUrl)}
		{#if documentationUrl}
			<div class="plugin-section">
				<a
					href={documentationUrl}
					target="_blank"
					rel="noopener noreferrer"
					class="plugin-doc-link"
				>
					{$LL.admin_plugins_documentation()} ↗
				</a>
			</div>
		{/if}
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
			<div class="plugin-config-title">{$LL.admin_plugins_configuration()}</div>
			{#if pluginSchema && !loadingConfig}
				{#if isEditMode}
					<div class="plugin-config-actions">
						<button
							class="btn btn-secondary btn-sm"
							onclick={cancelEditing}
							disabled={savingConfig}
						>
							{$LL.admin_plugins_cancel()}
						</button>
						<button class="btn btn-primary btn-sm" onclick={saveConfig} disabled={savingConfig}>
							{savingConfig ? $LL.admin_plugins_saving() : $LL.admin_plugins_save()}
						</button>
					</div>
				{:else}
					<button class="btn btn-primary btn-sm" onclick={startEditing}
						>{$LL.admin_plugins_edit()}</button
					>
				{/if}
			{/if}
		</div>

		{#if loadingConfig}
			<div class="text-muted">{$LL.admin_plugins_loading_configuration()}</div>
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
			<div class="text-muted">{$LL.admin_plugins_no_configuration()}</div>
		{:else}
			<!-- Fallback: JSON view when no schema -->
			<pre class="plugin-config-json">{JSON.stringify(pluginConfig, null, 2)}</pre>
		{/if}
	</div>

	{#if selectedPlugin?.capabilities.includes('notifier.email')}
		<div class="plugin-section">
			<div class="plugin-config-header">
				<div class="plugin-config-title">{$LL.admin_plugins_send_test_email_title()}</div>
			</div>
			<div class="plugin-config-field">
				<label class="plugin-config-label" for="plugin-test-email"
					>{$LL.admin_plugins_recipient_email()}</label
				>
				<input
					id="plugin-test-email"
					type="email"
					class="plugin-config-input"
					bind:value={testEmailAddress}
					placeholder="you@example.com"
				/>
				<div class="plugin-config-hint">
					{$LL.admin_plugins_test_email_hint()}
				</div>
			</div>
			<div class="plugin-test-actions">
				<button
					class="btn btn-primary btn-sm"
					onclick={sendTestEmail}
					disabled={sendingTestEmail || !selectedPlugin?.enabled}
				>
					{sendingTestEmail ? $LL.admin_plugins_sending() : $LL.admin_plugins_send_test_email()}
				</button>
				{#if !selectedPlugin?.enabled}
					<span class="text-muted">{$LL.admin_plugins_enable_before_test()}</span>
				{/if}
			</div>
			{#if testEmailMessage}
				<div class="alert alert-success">✓ {testEmailMessage}</div>
			{/if}
		</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeDetailDialog}
			>{$LL.admin_plugins_close()}</button
		>
	{/snippet}
</Modal>
