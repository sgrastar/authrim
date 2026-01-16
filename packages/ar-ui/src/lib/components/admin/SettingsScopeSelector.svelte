<script lang="ts">
	/**
	 * Settings Scope Selector Component
	 *
	 * Provides a tab-based UI for switching between Platform, Tenant, and Client scopes.
	 * Shows dropdown selectors for Tenant and Client when applicable.
	 */

	import { settingsContext, type SettingScopeLevel } from '$lib/stores/settings-context.svelte';
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
		label: string;
		icon: string;
		description: string;
	}> = [
		{ level: 'platform', label: 'Platform', icon: '🏗️', description: 'Global platform settings' },
		{ level: 'tenant', label: 'Tenant', icon: '🏢', description: 'Tenant-specific settings' },
		{ level: 'client', label: 'Client', icon: '📦', description: 'Client application settings' }
	];

	// Filter accessible scopes
	let accessibleScopes = $derived(
		hideInaccessible
			? scopeConfig.filter((s) => settingsContext.canAccessScope(s.level))
			: scopeConfig
	);

	// Handle scope change
	function handleScopeChange(level: SettingScopeLevel) {
		settingsContext.setLevel(level);
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
				onclick={() => handleScopeChange(scope.level)}
				title={scope.description}
			>
				<span class="scope-icon">{scope.icon}</span>
				<span class="scope-label">{scope.label}</span>
			</button>
		{/each}
	</div>

	<!-- Entity Selectors -->
	{#if currentLevel === 'tenant' || currentLevel === 'client'}
		<div class="entity-selectors">
			<!-- Tenant Selector -->
			<div class="selector-group">
				<label for="tenant-select" class="selector-label">Tenant:</label>
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
					<label for="client-select" class="selector-label">Client:</label>
					<select
						id="client-select"
						class="selector-input"
						value={clientId ?? ''}
						onchange={handleClientChange}
						disabled={isLoading || availableClients.length === 0}
					>
						<option value="">Select a client...</option>
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
				<span class="permission-icon">✏️</span>
				Editable
			</span>
		{:else}
			<span class="permission-badge readonly">
				<span class="permission-icon">🔒</span>
				Read-only
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
		background-color: #f9fafb;
		border: 1px solid #e5e7eb;
		border-radius: 8px;
	}

	/* Scope Tabs */
	.scope-tabs {
		display: flex;
		gap: 4px;
		border-bottom: 1px solid #e5e7eb;
		padding-bottom: 8px;
	}

	.scope-tab {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 8px 16px;
		background-color: transparent;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		transition: all 150ms ease-in-out;
		color: #6b7280;
		font-size: 14px;
		font-weight: 500;
	}

	.scope-tab:hover:not(.disabled) {
		background-color: #f3f4f6;
		color: #374151;
	}

	.scope-tab.active {
		background-color: #3b82f6;
		color: white;
	}

	.scope-tab.disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.scope-icon {
		font-size: 16px;
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
		font-size: 13px;
		font-weight: 500;
		color: #374151;
		white-space: nowrap;
	}

	.selector-input {
		padding: 6px 12px;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		background-color: white;
		font-size: 13px;
		color: #374151;
		min-width: 160px;
		cursor: pointer;
	}

	.selector-input:focus {
		outline: none;
		border-color: #3b82f6;
		box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
	}

	.selector-input:disabled {
		background-color: #f3f4f6;
		cursor: not-allowed;
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
		border-radius: 9999px;
		font-size: 12px;
		font-weight: 500;
	}

	.permission-badge.editable {
		background-color: #d1fae5;
		color: #065f46;
	}

	.permission-badge.readonly {
		background-color: #fef3c7;
		color: #92400e;
	}

	.permission-icon {
		font-size: 12px;
	}

	/* Dark mode */
	@media (prefers-color-scheme: dark) {
		.scope-selector {
			background-color: #1f2937;
			border-color: #374151;
		}

		.scope-tabs {
			border-color: #374151;
		}

		.scope-tab {
			color: #9ca3af;
		}

		.scope-tab:hover:not(.disabled) {
			background-color: #374151;
			color: #e5e7eb;
		}

		.scope-tab.active {
			background-color: #3b82f6;
			color: white;
		}

		.selector-label {
			color: #e5e7eb;
		}

		.selector-input {
			background-color: #374151;
			border-color: #4b5563;
			color: #e5e7eb;
		}

		.selector-input:focus {
			border-color: #60a5fa;
		}

		.selector-input:disabled {
			background-color: #1f2937;
		}

		.permission-badge.editable {
			background-color: rgba(16, 185, 129, 0.2);
			color: #6ee7b7;
		}

		.permission-badge.readonly {
			background-color: rgba(251, 191, 36, 0.2);
			color: #fcd34d;
		}
	}
</style>
