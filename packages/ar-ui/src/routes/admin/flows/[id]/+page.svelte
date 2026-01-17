<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import {
		adminFlowsAPI,
		type Flow,
		getProfileDisplayName,
		getProfileBadgeStyle,
		canEditFlow,
		canDeleteFlow
	} from '$lib/api/admin-flows';

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

<div class="flow-detail-page">
	{#if loading}
		<div class="loading">Loading flow...</div>
	{:else if error}
		<div class="error-state">
			<p>{error}</p>
			<button class="btn-primary" onclick={loadFlow}>Retry</button>
			<button class="btn-secondary" onclick={navigateBack}>Back to Flows</button>
		</div>
	{:else if flow}
		<div class="page-header">
			<div class="header-content">
				<div class="breadcrumb">
					<a href="/admin/flows">Flows</a>
					<span>/</span>
					<span>{flow.name}</span>
				</div>
				<div class="title-row">
					<h1>{flow.name}</h1>
					{#if flow.is_builtin}
						<span class="builtin-badge">Builtin</span>
					{/if}
					<span class="status-badge" class:active={flow.is_active} class:inactive={!flow.is_active}>
						{flow.is_active ? 'Active' : 'Inactive'}
					</span>
				</div>
				{#if flow.description}
					<p class="description">{flow.description}</p>
				{/if}
			</div>
			<div class="header-actions">
				{#if canEditFlow(flow)}
					<button class="btn-primary" onclick={navigateToEdit}>Edit Flow</button>
				{/if}
				<button class="btn-secondary" onclick={openCopyDialog}>Copy</button>
				{#if canEditFlow(flow)}
					<button class="btn-secondary" onclick={toggleActive} disabled={toggling}>
						{toggling ? 'Updating...' : flow.is_active ? 'Deactivate' : 'Activate'}
					</button>
				{/if}
				{#if canDeleteFlow(flow)}
					<button class="btn-danger" onclick={openDeleteDialog}>Delete</button>
				{/if}
			</div>
		</div>

		<div class="flow-info">
			<div class="info-grid">
				<div class="info-item">
					<span class="label">ID</span>
					<span class="value monospace">{flow.id}</span>
				</div>
				<div class="info-item">
					<span class="label">Profile</span>
					<span class="profile-badge" style={getProfileBadgeStyle(flow.profile_id)}>
						{getProfileDisplayName(flow.profile_id)}
					</span>
				</div>
				<div class="info-item">
					<span class="label">Client</span>
					<span class="value">{flow.client_id || 'Tenant Default'}</span>
				</div>
				<div class="info-item">
					<span class="label">Version</span>
					<span class="value monospace">{flow.version}</span>
				</div>
				<div class="info-item">
					<span class="label">Created</span>
					<span class="value">{formatDate(flow.created_at)}</span>
				</div>
				<div class="info-item">
					<span class="label">Updated</span>
					<span class="value">{formatDate(flow.updated_at)}</span>
				</div>
			</div>
		</div>

		<div class="flow-preview">
			<h2>Flow Definition</h2>
			{#if flow.graph_definition}
				<div class="graph-stats">
					<div class="stat">
						<span class="stat-value">{flow.graph_definition.nodes.length}</span>
						<span class="stat-label">Nodes</span>
					</div>
					<div class="stat">
						<span class="stat-value">{flow.graph_definition.edges.length}</span>
						<span class="stat-label">Edges</span>
					</div>
				</div>
				<div class="node-list">
					<h3>Nodes</h3>
					<table class="nodes-table">
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
									<td class="monospace">{node.id}</td>
									<td>
										<span class="node-type">{node.type}</span>
									</td>
									<td>{node.data.label}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<p class="no-graph">No graph definition available.</p>
			{/if}
		</div>

		<div class="json-preview">
			<h2>Raw JSON (Graph Definition)</h2>
			<pre><code>{JSON.stringify(flow.graph_definition, null, 2)}</code></pre>
		</div>

		<div class="json-preview">
			<div class="section-header">
				<h2>Compiled Plan</h2>
				<button class="btn-compile" onclick={compileFlow} disabled={compiling}>
					{compiling ? 'Compiling...' : 'Compile Now'}
				</button>
			</div>
			{#if compileError}
				<div class="compile-error">{compileError}</div>
			{/if}
			{#if compiledPlan}
				<pre><code>{JSON.stringify(compiledPlan, null, 2)}</code></pre>
			{:else if flow.compiled_plan}
				<pre><code>{JSON.stringify(flow.compiled_plan, null, 2)}</code></pre>
			{:else}
				<p class="no-compiled-plan">
					Click "Compile Now" to preview the compiled plan, or it will be generated when the flow is first executed.
				</p>
			{/if}
		</div>
	{/if}
</div>

<!-- Delete Confirmation Dialog -->
{#if showDeleteDialog && flow}
	<div class="dialog-overlay" onclick={closeDeleteDialog} role="presentation">
		<div class="dialog" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
			<h2>Delete Flow</h2>
			<p>
				Are you sure you want to delete the flow <strong>{flow.name}</strong>?
			</p>
			<p class="warning-text">This action cannot be undone.</p>

			{#if deleteError}
				<div class="dialog-error">{deleteError}</div>
			{/if}

			<div class="dialog-actions">
				<button class="btn-secondary" onclick={closeDeleteDialog} disabled={deleting}>
					Cancel
				</button>
				<button class="btn-danger" onclick={confirmDelete} disabled={deleting}>
					{deleting ? 'Deleting...' : 'Delete'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Copy Dialog -->
{#if showCopyDialog && flow}
	<div class="dialog-overlay" onclick={closeCopyDialog} role="presentation">
		<div class="dialog" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
			<h2>Copy Flow</h2>
			<p>Enter a name for the new flow:</p>

			<div class="form-group">
				<input type="text" bind:value={copyName} placeholder="Enter flow name" />
			</div>

			{#if copyError}
				<div class="dialog-error">{copyError}</div>
			{/if}

			<div class="dialog-actions">
				<button class="btn-secondary" onclick={closeCopyDialog} disabled={copying}> Cancel </button>
				<button class="btn-primary" onclick={confirmCopy} disabled={copying || !copyName.trim()}>
					{copying ? 'Copying...' : 'Copy'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.flow-detail-page {
		padding: 24px;
		max-width: 1200px;
		margin: 0 auto;
	}

	.loading {
		text-align: center;
		padding: 40px;
		color: #6b7280;
	}

	.error-state {
		text-align: center;
		padding: 40px;
		background-color: #fef2f2;
		border: 1px solid #fecaca;
		border-radius: 8px;
	}

	.error-state p {
		color: #b91c1c;
		margin-bottom: 16px;
	}

	.error-state button {
		margin: 0 8px;
	}

	.page-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		margin-bottom: 24px;
	}

	.breadcrumb {
		font-size: 14px;
		color: #6b7280;
		margin-bottom: 8px;
	}

	.breadcrumb a {
		color: #2563eb;
		text-decoration: none;
	}

	.breadcrumb a:hover {
		text-decoration: underline;
	}

	.breadcrumb span {
		margin: 0 4px;
	}

	.title-row {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-bottom: 8px;
	}

	.title-row h1 {
		margin: 0;
		font-size: 24px;
		font-weight: 600;
	}

	.builtin-badge {
		font-size: 12px;
		padding: 4px 8px;
		background-color: #dbeafe;
		color: #1e40af;
		border-radius: 4px;
	}

	.status-badge {
		font-size: 12px;
		padding: 4px 8px;
		border-radius: 4px;
	}

	.status-badge.active {
		background-color: #d1fae5;
		color: #065f46;
	}

	.status-badge.inactive {
		background-color: #f3f4f6;
		color: #6b7280;
	}

	.description {
		margin: 0;
		color: #6b7280;
		font-size: 14px;
	}

	.header-actions {
		display: flex;
		gap: 8px;
	}

	.btn-primary {
		padding: 8px 16px;
		background-color: #2563eb;
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 14px;
		cursor: pointer;
	}

	.btn-primary:hover {
		background-color: #1d4ed8;
	}

	.btn-primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-secondary {
		padding: 8px 16px;
		background-color: white;
		color: #374151;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		font-size: 14px;
		cursor: pointer;
	}

	.btn-secondary:hover {
		background-color: #f3f4f6;
	}

	.btn-secondary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-danger {
		padding: 8px 16px;
		background-color: #dc2626;
		color: white;
		border: none;
		border-radius: 6px;
		font-size: 14px;
		cursor: pointer;
	}

	.btn-danger:hover {
		background-color: #b91c1c;
	}

	.flow-info {
		background-color: white;
		border: 1px solid #e5e7eb;
		border-radius: 8px;
		padding: 24px;
		margin-bottom: 24px;
	}

	.info-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 20px;
	}

	.info-item {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.info-item .label {
		font-size: 13px;
		color: #6b7280;
		font-weight: 500;
	}

	.info-item .value {
		font-size: 14px;
		color: #111827;
	}

	.monospace {
		font-family: ui-monospace, SFMono-Regular, monospace;
		font-size: 13px;
	}

	.profile-badge {
		display: inline-block;
		padding: 4px 8px;
		border-radius: 4px;
		font-size: 12px;
		font-weight: 500;
	}

	.flow-preview {
		background-color: white;
		border: 1px solid #e5e7eb;
		border-radius: 8px;
		padding: 24px;
		margin-bottom: 24px;
	}

	.flow-preview h2 {
		margin: 0 0 16px 0;
		font-size: 18px;
		font-weight: 600;
	}

	.graph-stats {
		display: flex;
		gap: 24px;
		margin-bottom: 24px;
	}

	.stat {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 16px 24px;
		background-color: #f9fafb;
		border-radius: 8px;
	}

	.stat-value {
		font-size: 24px;
		font-weight: 600;
		color: #111827;
	}

	.stat-label {
		font-size: 14px;
		color: #6b7280;
	}

	.node-list h3 {
		margin: 0 0 12px 0;
		font-size: 14px;
		font-weight: 600;
	}

	.nodes-table {
		width: 100%;
		border-collapse: collapse;
		border: 1px solid #e5e7eb;
		border-radius: 6px;
	}

	.nodes-table th {
		text-align: left;
		padding: 8px 12px;
		background-color: #f9fafb;
		font-size: 13px;
		font-weight: 600;
		border-bottom: 1px solid #e5e7eb;
	}

	.nodes-table td {
		padding: 8px 12px;
		font-size: 14px;
		border-bottom: 1px solid #e5e7eb;
	}

	.nodes-table tr:last-child td {
		border-bottom: none;
	}

	.node-type {
		display: inline-block;
		padding: 2px 6px;
		background-color: #e5e7eb;
		border-radius: 4px;
		font-size: 12px;
		font-family: ui-monospace, SFMono-Regular, monospace;
	}

	.no-graph {
		color: #6b7280;
		font-style: italic;
	}

	.json-preview {
		background-color: white;
		border: 1px solid #e5e7eb;
		border-radius: 8px;
		padding: 24px;
	}

	.json-preview h2 {
		margin: 0;
		font-size: 18px;
		font-weight: 600;
	}

	.section-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 16px;
	}

	.btn-compile {
		padding: 6px 12px;
		background-color: #059669;
		color: white;
		border: none;
		border-radius: 4px;
		font-size: 13px;
		cursor: pointer;
	}

	.btn-compile:hover {
		background-color: #047857;
	}

	.btn-compile:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.compile-error {
		background-color: #fef2f2;
		border: 1px solid #fecaca;
		color: #b91c1c;
		padding: 8px 12px;
		border-radius: 4px;
		margin-bottom: 16px;
		font-size: 14px;
	}

	.json-preview pre {
		background-color: #1f2937;
		color: #e5e7eb;
		padding: 16px;
		border-radius: 6px;
		overflow-x: auto;
		font-size: 13px;
		max-height: 400px;
	}

	.no-compiled-plan {
		color: #6b7280;
		font-style: italic;
		padding: 16px;
		background-color: #f9fafb;
		border-radius: 6px;
		margin: 0;
	}

	/* Dialog styles */
	.dialog-overlay {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		bottom: 0;
		background-color: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.dialog {
		background-color: white;
		border-radius: 8px;
		padding: 24px;
		max-width: 400px;
		width: 90%;
		box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
	}

	.dialog h2 {
		margin: 0 0 16px 0;
		font-size: 18px;
		font-weight: 600;
	}

	.dialog p {
		margin: 0 0 12px 0;
		color: #374151;
	}

	.warning-text {
		color: #b91c1c;
		font-size: 14px;
	}

	.form-group {
		margin: 16px 0;
	}

	.form-group input {
		width: 100%;
		padding: 10px 12px;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		font-size: 14px;
	}

	.dialog-error {
		background-color: #fef2f2;
		border: 1px solid #fecaca;
		color: #b91c1c;
		padding: 8px 12px;
		border-radius: 4px;
		margin-bottom: 16px;
		font-size: 14px;
	}

	.dialog-actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 24px;
	}
</style>
