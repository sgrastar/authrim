<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		adminFlowsAPI,
		type Flow,
		type ProfileId,
		getProfileDisplayName,
		getProfileBadgeClass,
		canDeleteFlow
	} from '$lib/api/admin-flows';
	import { adminSettingsAPI } from '$lib/api/admin-settings';
	import { ToggleSwitch } from '$lib/components';

	let flows: Flow[] = $state([]);
	let loading = $state(true);
	let error = $state('');

	// Flow Engine Feature Flag state
	let flowEngineEnabled = $state(false);
	let flowEngineLoading = $state(true);
	let flowEngineError = $state('');
	let flowEngineSaving = $state(false);
	let featureFlagsVersion = $state('');

	// Pagination
	let page = $state(1);
	let limit = $state(20);
	let total = $state(0);
	let totalPages = $state(0);

	// Filter state
	let filterProfile: ProfileId | 'all' = $state('all');
	let filterActive: 'all' | 'active' | 'inactive' = $state('all');
	let searchQuery = $state('');

	// Delete confirmation dialog state
	let showDeleteDialog = $state(false);
	let flowToDelete: Flow | null = $state(null);
	let deleting = $state(false);
	let deleteError = $state('');

	async function loadFlowEngineStatus() {
		flowEngineLoading = true;
		flowEngineError = '';

		try {
			const settings = await adminSettingsAPI.getSettings('feature-flags');
			flowEngineEnabled = settings.values['feature.enable_flow_engine'] === true;
			featureFlagsVersion = settings.version;
		} catch (err) {
			console.error('Failed to load Flow Engine status:', err);
			flowEngineError = 'Failed to load Flow Engine status';
		} finally {
			flowEngineLoading = false;
		}
	}

	async function toggleFlowEngine() {
		if (flowEngineSaving) return;

		flowEngineSaving = true;
		flowEngineError = '';

		try {
			// Ensure we have a valid version before updating
			if (!featureFlagsVersion) {
				const settings = await adminSettingsAPI.getSettings('feature-flags');
				featureFlagsVersion = settings.version;
				flowEngineEnabled = settings.values['feature.enable_flow_engine'] === true;
			}

			const newValue = !flowEngineEnabled;
			const result = await adminSettingsAPI.updateSettings('feature-flags', {
				ifMatch: featureFlagsVersion,
				set: { 'feature.enable_flow_engine': newValue }
			});
			flowEngineEnabled = newValue;
			featureFlagsVersion = result.newVersion;
		} catch (err) {
			console.error('Failed to update Flow Engine status:', err);
			flowEngineError = err instanceof Error ? err.message : 'Failed to update Flow Engine status';
			// Reload to get current state
			await loadFlowEngineStatus();
		} finally {
			flowEngineSaving = false;
		}
	}

	async function loadFlows() {
		loading = true;
		error = '';

		try {
			const response = await adminFlowsAPI.list({
				profile_id: filterProfile !== 'all' ? filterProfile : undefined,
				is_active: filterActive === 'all' ? undefined : filterActive === 'active',
				search: searchQuery || undefined,
				page,
				limit
			});
			flows = response.flows;
			total = response.pagination.total;
			totalPages = response.pagination.total_pages;
		} catch (err) {
			console.error('Failed to load flows:', err);
			error = 'Failed to load flows';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadFlowEngineStatus();
		loadFlows();
	});

	function handleSearch() {
		page = 1;
		loadFlows();
	}

	function handleFilterChange() {
		page = 1;
		loadFlows();
	}

	function navigateToFlow(flow: Flow) {
		goto(`/admin/flows/${flow.id}`);
	}

	function navigateToCreate() {
		goto('/admin/flows/new');
	}

	function openDeleteDialog(flow: Flow, event: Event) {
		event.stopPropagation();
		if (!canDeleteFlow(flow)) {
			return;
		}
		flowToDelete = flow;
		deleteError = '';
		showDeleteDialog = true;
	}

	function closeDeleteDialog() {
		showDeleteDialog = false;
		flowToDelete = null;
		deleteError = '';
	}

	async function confirmDelete() {
		if (!flowToDelete) return;

		deleting = true;
		deleteError = '';

		try {
			await adminFlowsAPI.delete(flowToDelete.id);
			closeDeleteDialog();
			await loadFlows();
		} catch (err) {
			deleteError = err instanceof Error ? err.message : 'Failed to delete flow';
		} finally {
			deleting = false;
		}
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp * 1000).toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}

	function goToPage(newPage: number) {
		if (newPage >= 1 && newPage <= totalPages) {
			page = newPage;
			loadFlows();
		}
	}
</script>

<svelte:head>
	<title>Flows - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">Flows</h1>
			<p class="page-description">Manage authentication and authorization flows.</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-primary" onclick={navigateToCreate} disabled={!flowEngineEnabled}>
				<i class="i-ph-plus"></i>
				Create Flow
			</button>
		</div>
	</div>

	<!-- Flow Engine Feature Flag Toggle -->
	<div class="panel flow-engine-toggle-panel">
		<div class="flow-engine-toggle-row">
			<div class="flow-engine-info">
				<h3 class="flow-engine-title">Flow Engine</h3>
				<p class="flow-engine-description">
					Enable server-driven UI flows (UI Contract). When disabled, standard OIDC flows will be
					used.
				</p>
			</div>
			<div class="flow-engine-control">
				{#if flowEngineLoading}
					<span class="loading-text">Loading...</span>
				{:else}
					<ToggleSwitch
						checked={flowEngineEnabled}
						disabled={flowEngineSaving}
						onchange={toggleFlowEngine}
					/>
				{/if}
			</div>
		</div>
		{#if flowEngineError}
			<div class="alert alert-error alert-sm">{flowEngineError}</div>
		{/if}
		{#if flowEngineSaving}
			<div class="saving-indicator">Saving...</div>
		{/if}
	</div>

	{#if !flowEngineEnabled && !flowEngineLoading}
		<div class="alert alert-warning">
			<strong>Flow Engine is disabled.</strong> Enable it above to manage flows. When disabled, standard
			OIDC flows will be used instead.
		</div>
	{/if}

	{#if error}
		<div class="alert alert-error">
			<span>{error}</span>
			<button class="btn btn-secondary btn-sm" onclick={loadFlows}>Retry</button>
		</div>
	{/if}

	<!-- Filters -->
	<div class="panel">
		<div class="filter-row">
			<div class="form-group" style="flex: 1;">
				<label for="search" class="form-label">Search</label>
				<div class="search-box">
					<input
						id="search"
						type="text"
						class="form-input"
						placeholder="Search flows..."
						bind:value={searchQuery}
						onkeypress={(e) => e.key === 'Enter' && handleSearch()}
					/>
					<button class="btn btn-secondary" onclick={handleSearch}>
						<i class="i-ph-magnifying-glass"></i>
					</button>
				</div>
			</div>

			<div class="form-group">
				<label for="profile-filter" class="form-label">Profile</label>
				<select
					id="profile-filter"
					class="form-select"
					bind:value={filterProfile}
					onchange={handleFilterChange}
				>
					<option value="all">All</option>
					<option value="human-basic">Human (Basic)</option>
					<option value="human-org">Human (Org)</option>
					<option value="ai-agent">AI Agent</option>
					<option value="iot-device">IoT Device</option>
				</select>
			</div>

			<div class="form-group">
				<label for="status-filter" class="form-label">Status</label>
				<select
					id="status-filter"
					class="form-select"
					bind:value={filterActive}
					onchange={handleFilterChange}
				>
					<option value="all">All</option>
					<option value="active">Active</option>
					<option value="inactive">Inactive</option>
				</select>
			</div>
		</div>
	</div>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading flows...</p>
		</div>
	{:else if flows.length === 0}
		<div class="panel">
			<div class="empty-state">
				<p class="empty-state-description">No flows found.</p>
				<button class="btn btn-primary" onclick={navigateToCreate}>Create your first flow</button>
			</div>
		</div>
	{:else}
		<div class="data-table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>Name</th>
						<th>Profile</th>
						<th>Client</th>
						<th>Status</th>
						<th>Version</th>
						<th>Updated</th>
						<th class="text-right">Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each flows as flow (flow.id)}
						<tr
							onclick={() => navigateToFlow(flow)}
							onkeydown={(e) => e.key === 'Enter' && navigateToFlow(flow)}
							tabindex="0"
							role="button"
						>
							<td>
								<div class="cell-primary">
									{flow.name}
									{#if flow.is_builtin}
										<span class="badge badge-info">Builtin</span>
									{/if}
								</div>
							</td>
							<td>
								<span class={getProfileBadgeClass(flow.profile_id)}>
									{getProfileDisplayName(flow.profile_id)}
								</span>
							</td>
							<td class="muted">
								{flow.client_id || 'Tenant Default'}
							</td>
							<td>
								<span class={flow.is_active ? 'badge badge-success' : 'badge badge-neutral'}>
									{flow.is_active ? 'Active' : 'Inactive'}
								</span>
							</td>
							<td class="mono muted">{flow.version}</td>
							<td class="muted nowrap">{formatDate(flow.updated_at)}</td>
							<td class="text-right" onclick={(e) => e.stopPropagation()}>
								<div class="action-buttons">
									<button
										class="btn btn-secondary btn-sm"
										onclick={(e) => {
											e.stopPropagation();
											navigateToFlow(flow);
										}}
									>
										View
									</button>
									{#if canDeleteFlow(flow)}
										<button
											class="btn btn-danger btn-sm"
											onclick={(e) => openDeleteDialog(flow, e)}
										>
											Delete
										</button>
									{/if}
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#if totalPages > 1}
			<div class="pagination">
				<button
					class="btn btn-secondary btn-sm"
					disabled={page === 1}
					onclick={() => goToPage(page - 1)}
				>
					Previous
				</button>
				<span class="pagination-info">Page {page} of {totalPages} ({total} total)</span>
				<button
					class="btn btn-secondary btn-sm"
					disabled={page === totalPages}
					onclick={() => goToPage(page + 1)}
				>
					Next
				</button>
			</div>
		{/if}
	{/if}
</div>

<!-- Delete Confirmation Dialog -->
{#if showDeleteDialog && flowToDelete}
	<div
		class="modal-overlay"
		onclick={closeDeleteDialog}
		onkeydown={(e) => e.key === 'Escape' && closeDeleteDialog()}
		tabindex="-1"
		role="dialog"
		aria-modal="true"
		aria-labelledby="delete-dialog-title"
	>
		<div
			class="modal-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h2 id="delete-dialog-title" class="modal-title">Delete Flow</h2>
			</div>

			<div class="modal-body">
				{#if deleteError}
					<div class="alert alert-error">{deleteError}</div>
				{/if}

				<p class="modal-description">
					Are you sure you want to delete the flow <strong>{flowToDelete.name}</strong>?
				</p>
				<p class="danger-text">This action cannot be undone.</p>
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={closeDeleteDialog} disabled={deleting}>
					Cancel
				</button>
				<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
					{deleting ? 'Deleting...' : 'Delete'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* Flow Engine Toggle Panel Styles */
	.flow-engine-toggle-panel {
		margin-bottom: 1.5rem;
		padding: 1rem 1.25rem;
	}

	.flow-engine-toggle-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
	}

	.flow-engine-info {
		flex: 1;
	}

	.flow-engine-title {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.flow-engine-description {
		margin: 0.25rem 0 0;
		font-size: 0.875rem;
		color: var(--text-secondary);
	}

	.flow-engine-control {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}

	.loading-text {
		font-size: 0.875rem;
		color: var(--text-secondary);
	}

	.saving-indicator {
		margin-top: 0.5rem;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.alert-sm {
		margin-top: 0.75rem;
		padding: 0.5rem 0.75rem;
		font-size: 0.875rem;
	}

	.alert-warning {
		background-color: rgba(234, 179, 8, 0.1);
		border: 1px solid rgba(234, 179, 8, 0.3);
		border-radius: 0.375rem;
		padding: 0.75rem 1rem;
		color: var(--text-primary);
		margin-bottom: 1rem;
	}
</style>
