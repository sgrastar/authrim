<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		adminPluginsAPI,
		type PluginWithStatus,
		type PluginHealthResponse,
		type ProviderProjectionJob,
		type PluginResourceSelection,
		PLUGIN_CATEGORIES
	} from '$lib/api/admin-plugins';
	import {
		adminControlPlaneAPI,
		type ControlProvisioningOperation
	} from '$lib/api/admin-control-plane';
	import { Modal, ToggleSwitch } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';
	import AdminToolbar from '$lib/components/admin/AdminToolbar.svelte';
	import { shouldShowProviderProjectionStatus } from '$lib/admin/provider-projection';

	let plugins: PluginWithStatus[] = $state([]);
	let loading = $state(true);
	let error = $state('');
	let successMessage = $state('');
	let lastLoadedTenantId = $state('');
	let providerProjectionJobs: ProviderProjectionJob[] = $state([]);
	let providerProjectionVisible = $state(false);
	let providerProjectionTimer: ReturnType<typeof setTimeout> | undefined;
	let provisioningTimer: ReturnType<typeof setTimeout> | undefined;
	let provisioningOperations: Record<
		string,
		{
			kind: 'activate' | 'cleanup';
			operationId: string;
			tenantId: string;
			resourceSelections: PluginResourceSelection[];
			operation: ControlProvisioningOperation | null;
			activationRetrying: boolean;
		}
	> = $state({});

	// Filter state
	let filterCategory = $state('');
	let filterStatus = $state<'all' | 'enabled' | 'disabled'>('all');

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
	let useExistingResources: Record<string, boolean> = $state({});
	let existingResourceIds: Record<string, string> = $state({});
	let existingResourceNames: Record<string, string> = $state({});

	// Health check state
	let healthStatus: Record<string, PluginHealthResponse> = $state({});
	let checkingHealth: Record<string, boolean> = $state({});
	let togglingPlugins: Record<string, boolean> = $state({});
	let uninstallingPlugin = $state(false);

	const pluginIconClasses: Record<string, string> = {
		mail: 'i-ph-envelope-simple',
		cloud: 'i-ph-cloud',
		'shield-check': 'i-ph-shield-check',
		security: 'i-ph-shield-check',
		notification: 'i-ph-bell',
		authentication: 'i-ph-key',
		integration: 'i-ph-plugs',
		plugin: 'i-ph-puzzle-piece'
	};
	const filteredPlugins = $derived(
		plugins.filter((plugin) => {
			if (filterCategory && plugin.meta?.category !== filterCategory) return false;
			if (filterStatus === 'enabled' && !plugin.enabled) return false;
			if (filterStatus === 'disabled' && plugin.enabled) return false;
			return true;
		})
	);
	const activeProviderProjectionJobs = $derived(
		providerProjectionJobs.filter((job) => job.status === 'pending' || job.status === 'processing')
	);
	const failedProviderProjectionJobs = $derived(
		providerProjectionJobs.filter((job) => job.status === 'failed')
	);
	const visibleProviderProjectionJobs = $derived([
		...failedProviderProjectionJobs,
		...activeProviderProjectionJobs
	]);

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
			const response = await adminPluginsAPI.list({ tenantId: getSelectedTenantId() });
			plugins = response.plugins;
			const tenantId = getSelectedTenantId();
			if (tenantId) {
				for (const plugin of response.plugins) {
					if (plugin.provisioning && !provisioningOperations[plugin.id]) {
						trackProvisioning(
							plugin.id,
							plugin.provisioning.operationId,
							tenantId,
							[],
							plugin.provisioning.kind === 'cleanup' ? 'cleanup' : 'activate'
						);
					}
				}
			}

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

	async function loadProviderProjectionStatus() {
		if (providerProjectionTimer) {
			clearTimeout(providerProjectionTimer);
			providerProjectionTimer = undefined;
		}
		try {
			const response = await adminPluginsAPI.getProviderProjectionStatus();
			providerProjectionJobs = response.jobs;
			providerProjectionVisible = shouldShowProviderProjectionStatus(response.jobs);
			if (response.jobs.some((job) => job.status === 'pending' || job.status === 'processing')) {
				providerProjectionTimer = setTimeout(() => void loadProviderProjectionStatus(), 5000);
			}
		} catch {
			// Tenant administrators cannot read platform-wide rollout progress.
			providerProjectionJobs = [];
			providerProjectionVisible = false;
		}
	}

	onMount(() => {
		void loadPlugins();
		void loadProviderProjectionStatus();
		return () => {
			if (providerProjectionTimer) clearTimeout(providerProjectionTimer);
			if (provisioningTimer) clearTimeout(provisioningTimer);
		};
	});

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (tenantId && tenantId !== lastLoadedTenantId) {
			void loadPlugins();
		}
	});

	function pluginDisplayName(plugin: PluginWithStatus): string {
		return plugin.meta?.name || plugin.id;
	}

	function getPluginIconClass(plugin: PluginWithStatus | null | undefined): string | null {
		const icon = plugin?.meta?.icon?.trim();
		if (!icon) return 'i-ph-puzzle-piece';
		if (icon.startsWith('i-')) return icon;
		if (pluginIconClasses[icon]) return pluginIconClasses[icon];
		if (/^[a-z0-9-]+$/i.test(icon)) return 'i-ph-puzzle-piece';
		return null;
	}

	function getPluginIconText(plugin: PluginWithStatus | null | undefined): string | null {
		const icon = plugin?.meta?.icon?.trim();
		if (!icon) return null;
		return getPluginIconClass(plugin) ? null : icon;
	}

	function pluginToggleAriaLabel(plugin: PluginWithStatus): string {
		return `${pluginDisplayName(plugin)}: ${
			plugin.enabled ? $LL.admin_plugins_enabled() : $LL.admin_plugins_disabled()
		}`;
	}

	function applyPluginStatus(
		pluginId: string,
		status: {
			enabled: boolean;
			configSource: PluginWithStatus['configSource'];
			configured: boolean;
			missingRequiredFields: string[];
			loadedAt?: number;
			lastHealthCheck?: PluginWithStatus['lastHealthCheck'];
			provisioning?: PluginWithStatus['provisioning'];
		}
	) {
		plugins = plugins.map((plugin) =>
			plugin.id === pluginId
				? {
						...plugin,
						enabled: status.enabled,
						configSource: status.configSource,
						configured: status.configured,
						missingRequiredFields: status.missingRequiredFields,
						loadedAt: status.loadedAt,
						lastHealthCheck: status.lastHealthCheck ?? plugin.lastHealthCheck
					}
				: plugin
		);

		if (selectedPlugin?.id === pluginId) {
			selectedPlugin = {
				...selectedPlugin,
				enabled: status.enabled,
				configSource: status.configSource,
				configured: status.configured,
				missingRequiredFields: status.missingRequiredFields,
				loadedAt: status.loadedAt,
				lastHealthCheck: status.lastHealthCheck ?? selectedPlugin.lastHealthCheck
			};
		}
	}

	function scheduleProvisioningPoll(delay = 3000) {
		if (provisioningTimer) clearTimeout(provisioningTimer);
		if (
			!Object.values(provisioningOperations).some(
				(entry) =>
					!entry.operation ||
					['queued', 'running', 'waiting_retry'].includes(entry.operation.status)
			)
		) {
			provisioningTimer = undefined;
			return;
		}
		provisioningTimer = setTimeout(() => void pollProvisioningOperations(), delay);
	}

	async function pollProvisioningOperations() {
		if (provisioningTimer) {
			clearTimeout(provisioningTimer);
			provisioningTimer = undefined;
		}
		const entries = Object.entries(provisioningOperations);
		await Promise.all(
			entries.map(async ([pluginId, tracked]) => {
				if (
					tracked.activationRetrying ||
					(tracked.operation && ['blocked', 'canceled'].includes(tracked.operation.status))
				) {
					return;
				}
				try {
					const { operation } = await adminControlPlaneAPI.getProvisioningOperation(
						tracked.operationId
					);
					provisioningOperations = {
						...provisioningOperations,
						[pluginId]: { ...tracked, operation }
					};
					if (operation.status !== 'succeeded') return;
					if (tracked.kind === 'cleanup') {
						const next = { ...provisioningOperations };
						delete next[pluginId];
						provisioningOperations = next;
						return;
					}
					provisioningOperations = {
						...provisioningOperations,
						[pluginId]: { ...tracked, operation, activationRetrying: true }
					};
					const status = await adminPluginsAPI.enable(
						pluginId,
						tracked.tenantId,
						tracked.resourceSelections
					);
					if (status.provisioning) throw new Error('plugin_resource_activation_not_ready');
					applyPluginStatus(pluginId, status);
					const next = { ...provisioningOperations };
					delete next[pluginId];
					provisioningOperations = next;
				} catch (caught) {
					const current = provisioningOperations[pluginId];
					if (current?.operation?.status === 'succeeded') {
						provisioningOperations = {
							...provisioningOperations,
							[pluginId]: { ...current, activationRetrying: false }
						};
						error = caught instanceof Error ? caught.message : $LL.admin_plugins_update_failed();
					}
				}
			})
		);
		scheduleProvisioningPoll();
	}

	function trackProvisioning(
		pluginId: string,
		operationId: string,
		tenantId: string,
		resourceSelections: PluginResourceSelection[],
		kind: 'activate' | 'cleanup' = 'activate'
	) {
		provisioningOperations = {
			...provisioningOperations,
			[pluginId]: {
				kind,
				operationId,
				tenantId,
				resourceSelections,
				operation: null,
				activationRetrying: false
			}
		};
		scheduleProvisioningPoll(0);
	}

	async function toggleEnabled(plugin: PluginWithStatus, enabled: boolean) {
		if (plugin.enabled === enabled || togglingPlugins[plugin.id]) return;

		togglingPlugins = { ...togglingPlugins, [plugin.id]: true };
		error = '';
		successMessage = '';
		try {
			const resourceSelections = enabled ? selectedResourceSelections(plugin) : [];
			const tenantId = getSelectedTenantId();
			const status = enabled
				? await adminPluginsAPI.enable(plugin.id, tenantId, resourceSelections)
				: await adminPluginsAPI.disable(plugin.id, tenantId);
			applyPluginStatus(plugin.id, status);
			if (enabled && status.provisioning) {
				if (!tenantId) throw new Error('plugin_provisioning_tenant_required');
				trackProvisioning(plugin.id, status.provisioning.operationId, tenantId, resourceSelections);
			} else if (provisioningOperations[plugin.id]) {
				const next = { ...provisioningOperations };
				delete next[plugin.id];
				provisioningOperations = next;
			}
			void loadProviderProjectionStatus();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_plugins_update_failed();
			await loadPlugins();
		} finally {
			togglingPlugins = { ...togglingPlugins, [plugin.id]: false };
		}
	}

	async function uninstallSelectedPlugin() {
		if (!selectedPlugin || selectedPlugin.backendKind !== 'dynamic_worker') return;
		const tenantId = getSelectedTenantId();
		if (!tenantId || !window.confirm($LL.admin_plugins_uninstall_confirm())) return;
		uninstallingPlugin = true;
		error = '';
		successMessage = '';
		try {
			const result = await adminPluginsAPI.uninstall(
				selectedPlugin.id,
				tenantId,
				`admin-plugin-uninstall:${crypto.randomUUID()}`
			);
			applyPluginStatus(selectedPlugin.id, {
				enabled: false,
				configSource: selectedPlugin.configSource,
				configured: selectedPlugin.configured,
				missingRequiredFields: selectedPlugin.missingRequiredFields
			});
			if (result.cleanup) {
				trackProvisioning(selectedPlugin.id, result.cleanup.operationId, tenantId, [], 'cleanup');
			}
			successMessage = $LL.admin_plugins_uninstall_requested();
		} catch (caught) {
			error = caught instanceof Error ? caught.message : $LL.admin_plugins_update_failed();
		} finally {
			uninstallingPlugin = false;
		}
	}

	function selectedResourceSelections(plugin: PluginWithStatus): PluginResourceSelection[] {
		if (selectedPlugin?.id !== plugin.id) return [];
		return (plugin.resources ?? []).flatMap((resource) => {
			if (!resource.allowExisting || !useExistingResources[resource.logicalResourceId]) return [];
			const providerResourceId = existingResourceIds[resource.logicalResourceId]?.trim();
			const providerName = existingResourceNames[resource.logicalResourceId]?.trim();
			if (!providerResourceId || !providerName) {
				throw new Error($LL.admin_plugins_existing_resource_required());
			}
			return [
				{
					logicalResourceId: resource.logicalResourceId,
					mode: 'existing' as const,
					providerResourceId,
					providerName
				}
			];
		});
	}

	function setUseExistingResource(logicalResourceId: string, enabled: boolean) {
		useExistingResources = { ...useExistingResources, [logicalResourceId]: enabled };
	}

	function setExistingResourceId(logicalResourceId: string, value: string) {
		existingResourceIds = { ...existingResourceIds, [logicalResourceId]: value };
	}

	function setExistingResourceName(logicalResourceId: string, value: string) {
		existingResourceNames = { ...existingResourceNames, [logicalResourceId]: value };
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
		useExistingResources = {};
		existingResourceIds = {};
		existingResourceNames = {};
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
			const tenantId = getSelectedTenantId();
			if (detail.status.provisioning && tenantId) {
				trackProvisioning(
					plugin.id,
					detail.status.provisioning.operationId,
					tenantId,
					[],
					detail.status.provisioning.kind === 'cleanup' ? 'cleanup' : 'activate'
				);
			}
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
		useExistingResources = {};
		existingResourceIds = {};
		existingResourceNames = {};
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
			void loadProviderProjectionStatus();

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
			if (isEditMode) {
				await adminPluginsAPI.updateConfig(
					selectedPlugin.id,
					{ config: editedConfig },
					getSelectedTenantId()
				);
				pluginConfig = { ...editedConfig };
				isEditMode = false;
			}
			const result = await adminPluginsAPI.sendTestEmail(selectedPlugin.id, {
				to: testEmailAddress.trim(),
				tenantId: getSelectedTenantId()
			});
			testEmailMessage =
				result.deliveryState === 'pending'
					? result.messageId
						? $LL.admin_plugins_test_email_pending_with_id({ messageId: result.messageId })
						: $LL.admin_plugins_test_email_pending()
					: result.messageId
						? $LL.admin_plugins_test_email_sent_with_id({ messageId: result.messageId })
						: $LL.admin_plugins_test_email_sent();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_plugins_test_email_failed();
		} finally {
			sendingTestEmail = false;
		}
	}

	function getInputType(prop: JSONSchemaProperty, key?: string): string {
		if (prop.type === 'boolean') return 'checkbox';
		if (prop.type === 'integer' || prop.type === 'number') return 'number';
		if (prop.format === 'email') return 'email';
		if (prop.format === 'uri') return 'url';
		if (isSecretField(prop, key)) return 'password';
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

	function clearFilters() {
		filterCategory = '';
		filterStatus = 'all';
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

	function providerProjectionSummary(): string {
		if (failedProviderProjectionJobs.length > 0) {
			return $LL.admin_plugins_provider_projection_failed({
				count: failedProviderProjectionJobs.length
			});
		}
		if (activeProviderProjectionJobs.length > 0) {
			const processed = activeProviderProjectionJobs.reduce((sum, job) => sum + job.processed, 0);
			const total = activeProviderProjectionJobs.reduce((sum, job) => sum + job.total, 0);
			return $LL.admin_plugins_provider_projection_running({
				count: activeProviderProjectionJobs.length,
				processed,
				total
			});
		}
		return $LL.admin_plugins_provider_projection_complete();
	}

	function providerProjectionStatusLabel(status: ProviderProjectionJob['status']): string {
		switch (status) {
			case 'pending':
				return $LL.admin_plugins_provider_projection_pending();
			case 'processing':
				return $LL.admin_plugins_provider_projection_processing();
			case 'failed':
				return $LL.admin_plugins_provider_projection_status_failed();
			default:
				return $LL.admin_plugins_provider_projection_complete();
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

<svelte:head>
	<title>{$LL.admin_plugins_page_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_plugins_page_title()}
		description={$LL.admin_plugins_description()}
	/>

	{#if providerProjectionVisible}
		<div
			class:provider-projection-status--failed={failedProviderProjectionJobs.length > 0}
			class:provider-projection-status--active={activeProviderProjectionJobs.length > 0}
			class="provider-projection-status"
			role={failedProviderProjectionJobs.length > 0 ? 'alert' : 'status'}
		>
			<span class="provider-projection-status__icon" aria-hidden="true">
				<i
					class={failedProviderProjectionJobs.length > 0
						? 'i-ph-warning-circle'
						: activeProviderProjectionJobs.length > 0
							? 'i-ph-spinner-gap'
							: 'i-ph-check-circle'}
				></i>
			</span>
			<div class="provider-projection-status__body">
				<strong>{$LL.admin_plugins_provider_projection_title()}</strong>
				<span>{providerProjectionSummary()}</span>
				{#if visibleProviderProjectionJobs.length > 0}
					<div class="provider-projection-status__jobs">
						{#each visibleProviderProjectionJobs as job (job.pluginId)}
							<span>
								{job.pluginId}: {providerProjectionStatusLabel(job.status)} ({job.processed}/{job.total})
							</span>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<!-- Filters -->
	<AdminSection>
		<AdminToolbar>
			<div class="admin-field admin-field--compact">
				<label for="filter-category" class="admin-field__label">
					{$LL.admin_plugins_category()}
				</label>
				<select id="filter-category" class="admin-select" bind:value={filterCategory}>
					<option value="">{$LL.admin_plugins_all_categories()}</option>
					{#each PLUGIN_CATEGORIES as category (category.id)}
						<option value={category.id}>{formatCategory(category.id)}</option>
					{/each}
				</select>
			</div>
			<div class="admin-field admin-field--compact">
				<label for="filter-status" class="admin-field__label">
					{$LL.admin_plugins_status()}
				</label>
				<select id="filter-status" class="admin-select" bind:value={filterStatus}>
					<option value="all">{$LL.admin_plugins_all()}</option>
					<option value="enabled">{$LL.admin_plugins_enabled()}</option>
					<option value="disabled">{$LL.admin_plugins_disabled()}</option>
				</select>
			</div>
			<button class="btn btn-secondary" onclick={clearFilters}>{$LL.admin_plugins_clear()}</button>
		</AdminToolbar>
	</AdminSection>

	{#if error && !showDetailDialog}
		<div class="alert alert-error">{error}</div>
	{/if}

	{#if loading}
		<div class="loading-state">{$LL.admin_plugins_loading()}</div>
	{:else if filteredPlugins.length === 0}
		<div class="empty-state">
			<p>{$LL.admin_plugins_empty()}</p>
			<p class="text-muted">
				{filterCategory || filterStatus !== 'all'
					? $LL.admin_plugins_adjust_filters()
					: $LL.admin_plugins_empty_hint()}
			</p>
		</div>
	{:else}
		<div class="plugin-grid">
			{#each filteredPlugins as plugin (plugin.id)}
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
							<span class="plugin-icon" aria-hidden="true">
								{#if getPluginIconText(plugin)}
									{getPluginIconText(plugin)}
								{:else}
									<i class={getPluginIconClass(plugin) ?? 'i-ph-puzzle-piece'}></i>
								{/if}
							</span>
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
						<div
							class="plugin-status-toggle"
							role="presentation"
							onclick={(event) => event.stopPropagation()}
							onkeydown={(event) => event.stopPropagation()}
						>
							<span class="plugin-status-label" class:enabled={plugin.enabled}>
								{plugin.enabled ? $LL.admin_plugins_enabled() : $LL.admin_plugins_disabled()}
							</span>
							<ToggleSwitch
								checked={plugin.enabled}
								disabled={togglingPlugins[plugin.id] || !plugin.configured}
								size="sm"
								ariaLabel={pluginToggleAriaLabel(plugin)}
								onchange={(enabled) => toggleEnabled(plugin, enabled)}
							/>
						</div>
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
</AdminPageShell>

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
				<span class="plugin-dialog-icon" aria-hidden="true">
					{#if getPluginIconText(selectedPlugin)}
						{getPluginIconText(selectedPlugin)}
					{:else}
						<i class={getPluginIconClass(selectedPlugin) ?? 'i-ph-puzzle-piece'}></i>
					{/if}
				</span>
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
				{#if selectedPlugin}
					{@const detailPlugin = selectedPlugin}
					<div class="plugin-status-toggle plugin-status-toggle--detail">
						<span class="plugin-status-label" class:enabled={detailPlugin.enabled}>
							{detailPlugin.enabled ? $LL.admin_plugins_enabled() : $LL.admin_plugins_disabled()}
						</span>
						<ToggleSwitch
							checked={detailPlugin.enabled}
							disabled={togglingPlugins[detailPlugin.id] || !detailPlugin.configured}
							size="sm"
							ariaLabel={pluginToggleAriaLabel(detailPlugin)}
							onchange={(enabled) => toggleEnabled(detailPlugin, enabled)}
						/>
					</div>
				{/if}
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

	{#if selectedPlugin?.backendKind === 'dynamic_worker' && (selectedPlugin.resources?.length ?? 0) > 0 && !selectedPlugin.enabled}
		{#if selectedPlugin && provisioningOperations[selectedPlugin.id]}
			{@const selectedProvisioning = provisioningOperations[selectedPlugin.id]}
			{@const operation = selectedProvisioning.operation}
			<section
				class="plugin-section"
				role={operation?.status === 'blocked' || operation?.status === 'canceled'
					? 'alert'
					: 'status'}
			>
				<div class="plugin-section-title">
					{selectedProvisioning.kind === 'cleanup'
						? $LL.admin_plugins_cleanup_title()
						: $LL.admin_plugins_provisioning_title()}
				</div>
				<p class="plugin-info-subvalue">
					{#if selectedProvisioning.kind === 'cleanup' && (operation?.status === 'blocked' || operation?.status === 'canceled')}
						{$LL.admin_plugins_cleanup_blocked()}
					{:else if selectedProvisioning.kind === 'cleanup' && operation?.status === 'succeeded'}
						{$LL.admin_plugins_cleanup_complete()}
					{:else if selectedProvisioning.kind === 'cleanup'}
						{$LL.admin_plugins_cleanup_pending()}
					{:else if operation?.status === 'blocked' || operation?.status === 'canceled'}
						{$LL.admin_plugins_provisioning_blocked()}
					{:else if operation?.status === 'succeeded'}
						{$LL.admin_plugins_provisioning_activation()}
					{:else}
						{$LL.admin_plugins_provisioning_pending()}
					{/if}
				</p>
				<div class="plugin-info-value">
					{$LL.admin_plugins_provisioning_operation()}:
					<code>{selectedProvisioning.operationId}</code>
					{#if operation}
						<span class="badge badge-neutral">{operation.status}</span>
					{/if}
				</div>
				{#if operation?.lastErrorCode}
					<p><code>{operation.lastErrorCode}</code></p>
				{/if}
				{#if operation && operation.steps.length > 0}
					<div class="plugin-info-subvalue">
						{#each operation.steps as step (step.stepKey)}
							<div>{step.stepKey}: {step.status}</div>
						{/each}
					</div>
				{/if}
				<a
					class="btn btn-secondary btn-sm"
					href={`/admin/control-plane?operation=${encodeURIComponent(selectedProvisioning.operationId)}`}
				>
					{$LL.admin_plugins_provisioning_open()}
				</a>
			</section>
		{/if}
		<details class="plugin-section plugin-resource-settings">
			<summary class="plugin-section-title">{$LL.admin_plugins_resource_advanced()}</summary>
			<p class="plugin-info-subvalue">{$LL.admin_plugins_resource_managed_default()}</p>
			{#each selectedPlugin.resources ?? [] as resource (resource.logicalResourceId)}
				<div class="plugin-resource-row">
					<div class="plugin-info-value">
						{resource.logicalResourceId} · {resource.kind} · {resource.access}
					</div>
					{#if resource.allowExisting}
						<label class="plugin-resource-existing-toggle">
							<input
								type="checkbox"
								checked={useExistingResources[resource.logicalResourceId] ?? false}
								onchange={(event) =>
									setUseExistingResource(
										resource.logicalResourceId,
										(event.currentTarget as HTMLInputElement).checked
									)}
							/>
							{$LL.admin_plugins_use_existing_resource()}
						</label>
						{#if useExistingResources[resource.logicalResourceId]}
							<div class="plugin-resource-fields">
								<div class="admin-field">
									<label
										class="admin-field__label"
										for={`plugin-resource-id-${resource.logicalResourceId}`}
									>
										{$LL.admin_plugins_provider_resource_id()}
									</label>
									<input
										id={`plugin-resource-id-${resource.logicalResourceId}`}
										class="admin-input"
										type="text"
										autocomplete="off"
										value={existingResourceIds[resource.logicalResourceId] ?? ''}
										oninput={(event) =>
											setExistingResourceId(
												resource.logicalResourceId,
												(event.currentTarget as HTMLInputElement).value
											)}
									/>
								</div>
								<div class="admin-field">
									<label
										class="admin-field__label"
										for={`plugin-resource-name-${resource.logicalResourceId}`}
									>
										{$LL.admin_plugins_provider_resource_name()}
									</label>
									<input
										id={`plugin-resource-name-${resource.logicalResourceId}`}
										class="admin-input"
										type="text"
										autocomplete="off"
										value={existingResourceNames[resource.logicalResourceId] ?? ''}
										oninput={(event) =>
											setExistingResourceName(
												resource.logicalResourceId,
												(event.currentTarget as HTMLInputElement).value
											)}
									/>
								</div>
							</div>
							<p class="plugin-info-subvalue">{$LL.admin_plugins_existing_resource_retained()}</p>
						{/if}
					{/if}
				</div>
			{/each}
		</details>
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
								type={getInputType(prop, key)}
								autocomplete={isSecretField(prop, key) ? 'new-password' : 'off'}
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
		{#if selectedPlugin?.backendKind === 'dynamic_worker' && !selectedPlugin.enabled && (selectedPlugin.resources?.length ?? 0) > 0}
			<button
				class="btn btn-danger"
				onclick={uninstallSelectedPlugin}
				disabled={uninstallingPlugin}
			>
				{uninstallingPlugin ? $LL.admin_plugins_uninstalling() : $LL.admin_plugins_uninstall()}
			</button>
		{/if}
		<button class="btn btn-secondary" onclick={closeDetailDialog}
			>{$LL.admin_plugins_close()}</button
		>
	{/snippet}
</Modal>
