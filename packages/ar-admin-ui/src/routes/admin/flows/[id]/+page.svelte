<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import {
		adminFlowsAPI,
		type Flow,
		getProfileDisplayName,
		getProfileBadgeClass,
		canEditFlow,
		canDeleteFlow
	} from '$lib/api/admin-flows';
	import { isLegacyPreviewFlowId } from '$lib/api/legacy-flow-preview';
	import { Modal } from '$lib/components';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection
	} from '$lib/components/admin';

	let flow: Flow | null = $state(null);
	let loading = $state(true);
	let error = $state('');

	// Delete dialog state
	let showDeleteDialog = $state(false);
	let deleting = $state(false);
	let deleteError = $state('');

	// Copy dialog state
	let showCopyDialog = $state(false);
	let copyName = $state('');
	let copying = $state(false);
	let copyError = $state('');

	// Toggle state
	let toggling = $state(false);

	// Compile state
	let compiling = $state(false);
	let compiledPlan: Record<string, unknown> | null = $state(null);
	let compileError = $state('');

	const flowId = $derived($page.params.id ?? '');
	const flowIsBuiltin = $derived.by(() => flow?.is_builtin ?? false);
	const flowIsActive = $derived.by(() => flow?.is_active ?? false);
	const flowIsPreview = $derived.by(() => (flow ? isLegacyPreviewFlowId(flow.id) : false));
	const flowCanEdit = $derived.by(() => (flow ? canEditFlow(flow) : false));
	const flowCanMutate = $derived.by(() => flowCanEdit && !flowIsPreview);
	const flowCanDelete = $derived.by(() => (flow && !flowIsPreview ? canDeleteFlow(flow) : false));

	async function loadFlow() {
		if (!flowId) return;
		loading = true;
		error = '';

		try {
			const response = await adminFlowsAPI.get(flowId);
			flow = response.flow;
		} catch (err) {
			console.error('Failed to load flow:', err);
			error = err instanceof Error ? err.message : 'Failed to load flow';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadFlow();
	});

	function navigateToEdit() {
		goto(`/admin/flows/${flowId}/edit`);
	}

	function navigateBack() {
		goto('/admin/flows');
	}

	// Delete handlers
	function openDeleteDialog() {
		if (!flow || !canDeleteFlow(flow)) return;
		deleteError = '';
		showDeleteDialog = true;
	}

	function closeDeleteDialog() {
		showDeleteDialog = false;
		deleteError = '';
	}

	async function confirmDelete() {
		if (!flow) return;

		deleting = true;
		deleteError = '';

		try {
			await adminFlowsAPI.delete(flow.id);
			goto('/admin/flows');
		} catch (err) {
			deleteError = err instanceof Error ? err.message : 'Failed to delete flow';
		} finally {
			deleting = false;
		}
	}

	// Copy handlers
	function openCopyDialog() {
		if (!flow) return;
		copyName = `${flow.name} (Copy)`;
		copyError = '';
		showCopyDialog = true;
	}

	function closeCopyDialog() {
		showCopyDialog = false;
		copyError = '';
	}

	async function confirmCopy() {
		if (!flow) return;

		copying = true;
		copyError = '';

		try {
			const result = await adminFlowsAPI.copy(flow.id, { name: copyName });
			goto(`/admin/flows/${result.flow_id}`);
		} catch (err) {
			copyError = err instanceof Error ? err.message : 'Failed to copy flow';
		} finally {
			copying = false;
		}
	}

	// Toggle active status
	async function toggleActive() {
		if (!flow) return;

		toggling = true;

		try {
			await adminFlowsAPI.update(flow.id, { is_active: !flow.is_active });
			flow = { ...flow, is_active: !flow.is_active };
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to update flow';
		} finally {
			toggling = false;
		}
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp * 1000).toLocaleString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	async function compileFlow() {
		if (!flow) return;

		compiling = true;
		compileError = '';

		try {
			const result = await adminFlowsAPI.compile(flow.id);
			compiledPlan = result.compiled_plan;
		} catch (err) {
			compileError = err instanceof Error ? err.message : 'Failed to compile flow';
		} finally {
			compiling = false;
		}
	}
</script>

<svelte:head>
	<title>{flow ? `${flow.name} - Flows` : 'Flow Details'} - Admin Dashboard - Authrim</title>
</svelte:head>

<AdminPageShell>
	{#if loading}
		<div class="loading-state">Loading flow...</div>
	{:else if error && !flow}
		<div class="error-state-centered">
			<p>{error}</p>
			<div class="error-state-actions">
				<button class="btn btn-primary" onclick={loadFlow}>Retry</button>
				<button class="btn btn-secondary" onclick={navigateBack}>Back to Flows</button>
			</div>
		</div>
	{:else if flow}
		<AdminPageHeader title={flow.name} description={flow.description || undefined}>
			{#snippet titleAccessory()}
				{#if flowIsBuiltin}
					<span class="badge badge-primary">Builtin</span>
				{/if}
				{#if flowIsPreview}
					<span class="badge badge-info">Preview</span>
				{/if}
				<span
					class="status-badge"
					class:status-active={flowIsActive}
					class:status-inactive={!flowIsActive}
				>
					{flowIsActive ? 'Active' : 'Inactive'}
				</span>
			{/snippet}
			{#snippet actions()}
				<button class="btn btn-secondary" onclick={navigateBack}>
					<i class="i-ph-arrow-left"></i>
					Back to Flows
				</button>
				{#if flowCanEdit}
					<button class="btn btn-primary" onclick={navigateToEdit}>Edit Flow</button>
				{/if}
				{#if flowCanMutate}
					<button class="btn btn-secondary" onclick={openCopyDialog}>Copy</button>
					<button class="btn btn-secondary" onclick={toggleActive} disabled={toggling}>
						{toggling ? 'Updating...' : flowIsActive ? 'Deactivate' : 'Activate'}
					</button>
				{/if}
				{#if flowCanDelete}
					<button class="btn btn-danger" onclick={openDeleteDialog}>Delete</button>
				{/if}
			{/snippet}
		</AdminPageHeader>

		{#if flowIsPreview}
			<div class="alert alert-warning">
				<strong>Legacy preview.</strong> This sample flow is available for reviewing the old Flow Designer
				only. It is not persisted to the backend and is not used by runtime execution.
			</div>
		{/if}

		<!-- Flow Info Panel -->
		<AdminSection>
			<div class="info-grid">
				<div class="info-item">
					<dt class="info-label">ID</dt>
					<dd class="info-value mono">{flow.id}</dd>
				</div>
				<div class="info-item">
					<dt class="info-label">Profile</dt>
					<dd class="info-value">
						<span class={getProfileBadgeClass(flow.profile_id)}>
							{getProfileDisplayName(flow.profile_id)}
						</span>
					</dd>
				</div>
				<div class="info-item">
					<dt class="info-label">Client</dt>
					<dd class="info-value">{flow.client_id || 'Tenant Default'}</dd>
				</div>
				<div class="info-item">
					<dt class="info-label">Version</dt>
					<dd class="info-value mono">{flow.version}</dd>
				</div>
				<div class="info-item">
					<dt class="info-label">Created</dt>
					<dd class="info-value">{formatDate(flow.created_at)}</dd>
				</div>
				<div class="info-item">
					<dt class="info-label">Updated</dt>
					<dd class="info-value">{formatDate(flow.updated_at)}</dd>
				</div>
			</div>
		</AdminSection>

		<!-- Flow Definition Panel -->
		<AdminSection title="Flow Definition">
			{#if flow.graph_definition}
				<div class="flow-stats">
					<div class="flow-stat">
						<span class="flow-stat-value">{flow.graph_definition.nodes.length}</span>
						<span class="flow-stat-label">Nodes</span>
					</div>
					<div class="flow-stat">
						<span class="flow-stat-value">{flow.graph_definition.edges.length}</span>
						<span class="flow-stat-label">Edges</span>
					</div>
				</div>
				<div class="flow-nodes-table">
					<h3 class="section-subtitle">Nodes</h3>
					<AdminDataTable compact>
						<thead>
							<tr>
								<th>ID</th>
								<th>Type</th>
								<th>Label</th>
							</tr>
						</thead>
						<tbody>
							{#each flow.graph_definition.nodes as node (node.id)}
								<tr>
									<td class="mono">{node.id}</td>
									<td>
										<span class="badge badge-neutral">{node.type}</span>
									</td>
									<td>{node.data.label}</td>
								</tr>
							{/each}
						</tbody>
					</AdminDataTable>
				</div>
			{:else}
				<p class="empty-text">No graph definition available.</p>
			{/if}
		</AdminSection>

		<!-- Raw JSON Panel -->
		<AdminSection title="Raw JSON (Graph Definition)">
			<pre class="code-block"><code>{JSON.stringify(flow.graph_definition, null, 2)}</code></pre>
		</AdminSection>

		<!-- Compiled Plan Panel -->
		<AdminSection title="Compiled Plan">
			{#snippet actions()}
				<button class="btn btn-success btn-sm" onclick={compileFlow} disabled={compiling}>
					{compiling ? 'Compiling...' : 'Compile Now'}
				</button>
			{/snippet}
			{#if compileError}
				<div class="alert alert-error">{compileError}</div>
			{/if}
			{#if compiledPlan}
				<pre class="code-block"><code>{JSON.stringify(compiledPlan, null, 2)}</code></pre>
			{:else if flow.compiled_plan}
				<pre class="code-block"><code>{JSON.stringify(flow.compiled_plan, null, 2)}</code></pre>
			{:else}
				<div class="empty-state">
					Click "Compile Now" to preview the compiled plan, or it will be generated when the flow is
					first executed.
				</div>
			{/if}
		</AdminSection>
	{/if}
</AdminPageShell>

<!-- Delete Confirmation Dialog -->
<Modal open={showDeleteDialog && !!flow} onClose={closeDeleteDialog} title="Delete Flow" size="sm">
	<p>
		Are you sure you want to delete the flow <strong>{flow?.name ?? ''}</strong>?
	</p>
	<p class="text-danger">This action cannot be undone.</p>

	{#if deleteError}
		<div class="alert alert-error">{deleteError}</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeDeleteDialog} disabled={deleting}>
			Cancel
		</button>
		<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
			{deleting ? 'Deleting...' : 'Delete'}
		</button>
	{/snippet}
</Modal>

<!-- Copy Dialog -->
<Modal open={showCopyDialog && !!flow} onClose={closeCopyDialog} title="Copy Flow" size="sm">
	<p>Enter a name for the new flow:</p>

	<div class="form-group">
		<input type="text" bind:value={copyName} placeholder="Enter flow name" class="form-input" />
	</div>

	{#if copyError}
		<div class="alert alert-error">{copyError}</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeCopyDialog} disabled={copying}>Cancel</button>
		<button class="btn btn-primary" onclick={confirmCopy} disabled={copying || !copyName.trim()}>
			{copying ? 'Copying...' : 'Copy'}
		</button>
	{/snippet}
</Modal>
