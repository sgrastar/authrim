<script lang="ts">
	/**
	 * Settings Scope Selector Component
	 *
	 * Provides a tab-based UI for switching between Platform, Tenant, and Client scopes.
	 * Shows dropdown selectors for Tenant and Client when applicable.
	 */

	import { settingsContext, type SettingScopeLevel } from '$lib/stores/settings-context.svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { onMount } from 'svelte';

	interface Props {
		/** Callback when scope changes */
		onScopeChange?: (scope: SettingScopeLevel, tenantId?: string, clientId?: string) => void;
		/** Hide scopes that are not accessible */
		hideInaccessible?: boolean;
	}

	let { onScopeChange, hideInaccessible = true }: Props = $props();

	// Local derived state from store
	let currentLevel = $derived(settingsContext.currentLevel);
	let tenantId = $derived(settingsContext.tenantId);
	let clientId = $derived(settingsContext.clientId);
	let availableTenants = $derived(settingsContext.availableTenants);
	let availableClients = $derived(settingsContext.availableClients);
	let isLoading = $derived(settingsContext.isLoading);

	// Scope configuration
	const scopeConfig: Array<{
		level: SettingScopeLevel;
		icon: string;
	}> = [
		{ level: 'platform', icon: 'i-ph-stack' },
		{ level: 'tenant', icon: 'i-ph-buildings' },
		{ level: 'client', icon: 'i-ph-app-window' }
	];

	// Filter accessible scopes
	let accessibleScopes = $derived(
		hideInaccessible
			? scopeConfig.filter((s) => settingsContext.canAccessScope(s.level))
			: scopeConfig
	);

	// Handle scope change
	async function handleScopeChange(level: SettingScopeLevel) {
		await settingsContext.setLevel(level);
		notifyChange();
	}

	// Handle tenant change
	async function handleTenantChange(event: Event) {
		const select = event.target as HTMLSelectElement;
		await settingsContext.setTenantId(select.value);
		notifyChange();
	}

	// Handle client change
	function handleClientChange(event: Event) {
		const select = event.target as HTMLSelectElement;
		settingsContext.setClientId(select.value || null);
		notifyChange();
	}

	// Notify parent of changes
	function notifyChange() {
		onScopeChange?.(
			settingsContext.currentLevel,
			settingsContext.tenantId,
			settingsContext.clientId ?? undefined
		);
	}

	function getScopeLabel(level: SettingScopeLevel): string {
		const labels: Record<SettingScopeLevel, string> = {
			platform: $LL.admin_settings_scope_platform(),
			tenant: $LL.admin_settings_scope_tenant(),
			client: $LL.admin_settings_scope_client()
		};
		return labels[level];
	}

	function getScopeDescription(level: SettingScopeLevel): string {
		const descriptions: Record<SettingScopeLevel, string> = {
			platform: $LL.admin_settings_scope_platform_desc(),
			tenant: $LL.admin_settings_scope_tenant_desc(),
			client: $LL.admin_settings_scope_client_desc()
		};
		return descriptions[level];
	}

	// Initialize on mount
	onMount(async () => {
		await settingsContext.initialize();
	});
</script>

<div class="scope-selector">
	<!-- Scope Tabs -->
	<div class="scope-tabs" role="tablist">
		{#each accessibleScopes as scope (scope.level)}
			{@const isActive = currentLevel === scope.level}
			<button
				role="tab"
				aria-selected={isActive}
				class="scope-tab"
				class:active={isActive}
				class:disabled={!settingsContext.canAccessScope(scope.level)}
				onclick={() => void handleScopeChange(scope.level)}
				title={getScopeDescription(scope.level)}
			>
				<i class="scope-icon {scope.icon}" aria-hidden="true"></i>
				<span class="scope-label">{getScopeLabel(scope.level)}</span>
			</button>
		{/each}
	</div>

	<!-- Entity Selectors -->
	{#if currentLevel === 'tenant' || currentLevel === 'client'}
		<div class="entity-selectors">
			<!-- Tenant Selector -->
			<div class="selector-group">
				<label for="tenant-select" class="selector-label">
					{$LL.admin_settings_scope_tenant_label()}
				</label>
				<select
					id="tenant-select"
					class="selector-input"
					value={tenantId}
					onchange={handleTenantChange}
					disabled={isLoading || availableTenants.length <= 1}
				>
					{#each availableTenants as tenant (tenant.id)}
						<option value={tenant.id}>{tenant.name}</option>
					{/each}
				</select>
			</div>

			<!-- Client Selector (only for client scope) -->
			{#if currentLevel === 'client'}
				<div class="selector-group">
					<label for="client-select" class="selector-label">
						{$LL.admin_settings_scope_client_label()}
					</label>
					<select
						id="client-select"
						class="selector-input"
						value={clientId ?? ''}
						onchange={handleClientChange}
						disabled={isLoading || availableClients.length === 0}
					>
						<option value="">{$LL.admin_settings_scope_select_client()}</option>
						{#each availableClients as client (client.id)}
							<option value={client.id}>{client.name}</option>
						{/each}
					</select>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Permission Indicator -->
	<div class="permission-indicator">
		{#if settingsContext.canEditAtCurrentScope()}
			<span class="permission-badge editable">
				<i class="permission-icon i-ph-pencil-simple" aria-hidden="true"></i>
				{$LL.admin_settings_scope_editable()}
			</span>
		{:else}
			<span class="permission-badge readonly">
				<i class="permission-icon i-ph-lock-key" aria-hidden="true"></i>
				{$LL.admin_settings_readonly()}
			</span>
		{/if}
	</div>
</div>

<style>
	.scope-selector {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 12px 16px;
		background-color: var(--color-surface-muted);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
	}

	/* Scope Tabs */
	.scope-tabs {
		display: flex;
		gap: 4px;
		border-bottom: 1px solid var(--color-border);
		padding-bottom: 8px;
	}

	.scope-tab {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 16px;
		background-color: transparent;
		border: none;
		border-radius: var(--radius-control);
		cursor: pointer;
		transition: all var(--transition-fast);
		color: var(--color-text-muted);
		font-size: 0.875rem;
		font-weight: 500;
	}

	.scope-tab:hover:not(.disabled) {
		background-color: color-mix(in srgb, var(--color-accent) 8%, transparent);
		color: var(--color-text);
	}

	.scope-tab.active {
		background-color: var(--color-accent);
		color: var(--color-accent-contrast);
	}

	.scope-tab.disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.scope-icon {
		font-size: 1rem;
	}

	.scope-label {
		white-space: nowrap;
	}

	/* Entity Selectors */
	.entity-selectors {
		display: flex;
		flex-wrap: wrap;
		gap: 16px;
	}

	.selector-group {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.selector-label {
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--color-text);
		white-space: nowrap;
	}

	.selector-input {
		padding: 6px 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background-color: var(--control-bg, var(--color-surface));
		font-size: 0.8125rem;
		color: var(--color-text);
		min-width: 160px;
		cursor: pointer;
	}

	.selector-input:focus {
		outline: none;
		border-color: var(--color-accent);
		box-shadow: var(--control-focus-shadow, 0 0 0 3px var(--color-accent-muted));
	}

	.selector-input:disabled {
		background-color: var(--color-surface-muted);
		cursor: not-allowed;
		color: var(--color-text-subtle);
	}

	/* Permission Indicator */
	.permission-indicator {
		display: flex;
		justify-content: flex-end;
	}

	.permission-badge {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 10px;
		border-radius: var(--radius-control);
		font-size: 0.75rem;
		font-weight: 500;
	}

	.permission-badge.editable {
		background-color: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.permission-badge.readonly {
		background-color: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
	}

	.permission-icon {
		font-size: 0.75rem;
	}
</style>
