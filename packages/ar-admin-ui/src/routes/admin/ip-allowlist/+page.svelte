<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminIpAllowlistAPI,
		type IpAllowlistEntry,
		validateIpRange
	} from '$lib/api/admin-ip-allowlist';

	let entries: IpAllowlistEntry[] = $state([]);
	let currentIp = $state('');
	let restrictionActive = $state(false);
	let loading = $state(true);
	let error = $state('');
	let includeDisabled = $state(false);

	// Create dialog state
	let showCreateDialog = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let newIpRange = $state('');
	let newDescription = $state('');

	// Edit dialog state
	let showEditDialog = $state(false);
	let editingEntry: IpAllowlistEntry | null = $state(null);
	let editIpRange = $state('');
	let editDescription = $state('');
	let saving = $state(false);

	// IP check dialog
	let showCheckDialog = $state(false);
	let checkIp = $state('');
	let checkResult: { allowed: boolean; restriction_active: boolean } | null = $state(null);
	let checking = $state(false);

	async function loadEntries() {
		loading = true;
		error = '';

		try {
			const response = await adminIpAllowlistAPI.list(includeDisabled);
			entries = response.items;
			currentIp = response.current_ip;
			restrictionActive = response.restriction_active;
		} catch (err) {
			console.error('Failed to load IP allowlist:', err);
			error = err instanceof Error ? err.message : 'Failed to load IP allowlist';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		loadEntries();
	});

	function openCreateDialog() {
		newIpRange = '';
		newDescription = '';
		createError = '';
		showCreateDialog = true;
	}

	function closeCreateDialog() {
		showCreateDialog = false;
	}

	async function handleCreate() {
		const validation = validateIpRange(newIpRange);
		if (!validation.valid) {
			createError = validation.error || 'Invalid IP address or CIDR notation';
			return;
		}

		creating = true;
		createError = '';

		try {
			await adminIpAllowlistAPI.create({
				ip_range: newIpRange.trim(),
				description: newDescription.trim() || undefined
			});
			closeCreateDialog();
			loadEntries();
		} catch (err) {
			createError = err instanceof Error ? err.message : 'Failed to create entry';
		} finally {
			creating = false;
		}
	}

	function openEditDialog(entry: IpAllowlistEntry) {
		editingEntry = entry;
		editIpRange = entry.ip_range;
		editDescription = entry.description || '';
		showEditDialog = true;
	}

	function closeEditDialog() {
		showEditDialog = false;
		editingEntry = null;
	}

	async function handleSave() {
		if (!editingEntry) return;

		const validation = validateIpRange(editIpRange);
		if (!validation.valid) {
			alert(validation.error || 'Invalid IP address or CIDR notation');
			return;
		}

		saving = true;

		try {
			await adminIpAllowlistAPI.update(editingEntry.id, {
				ip_range: editIpRange.trim(),
				description: editDescription.trim() || undefined
			});
			closeEditDialog();
			loadEntries();
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to update entry');
		} finally {
			saving = false;
		}
	}

	async function handleDelete(entry: IpAllowlistEntry) {
		if (!confirm(`Are you sure you want to delete the IP entry "${entry.ip_range}"?`)) return;

		try {
			await adminIpAllowlistAPI.delete(entry.id);
			loadEntries();
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to delete entry');
		}
	}

	async function handleToggleEnabled(entry: IpAllowlistEntry) {
		try {
			if (entry.enabled) {
				await adminIpAllowlistAPI.disable(entry.id);
			} else {
				await adminIpAllowlistAPI.enable(entry.id);
			}
			loadEntries();
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to toggle entry');
		}
	}

	function openCheckDialog() {
		checkIp = '';
		checkResult = null;
		showCheckDialog = true;
	}

	function closeCheckDialog() {
		showCheckDialog = false;
	}

	async function handleCheckIp() {
		if (!checkIp.trim()) return;

		checking = true;
		try {
			checkResult = await adminIpAllowlistAPI.checkIp(checkIp.trim());
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to check IP');
		} finally {
			checking = false;
		}
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleString();
	}
</script>

<svelte:head>
	<title>IP Allowlist - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">IP Allowlist</h1>
			<p class="page-description">Manage IP-based access control for the Admin panel</p>
		</div>
		<div class="page-actions">
			<button class="btn btn-secondary" onclick={openCheckDialog}>Check IP</button>
			<button class="btn btn-primary" onclick={openCreateDialog}>
				<i class="i-ph-plus"></i>
				Add IP
			</button>
		</div>
	</div>

	<!-- Status Banner -->
	<div class="status-banner {restrictionActive ? 'active' : 'inactive'}">
		<div class="status-icon">
			{#if restrictionActive}
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
				</svg>
			{:else}
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="12" cy="12" r="10" />
					<path d="M12 8v4M12 16h.01" />
				</svg>
			{/if}
		</div>
		<div class="status-text">
			{#if restrictionActive}
				<strong>IP Restriction Active</strong>
				<span>Only listed IP addresses can access the Admin panel</span>
			{:else}
				<strong>No IP Restriction</strong>
				<span>All IP addresses can access the Admin panel. Add entries to enable restriction.</span>
			{/if}
		</div>
		<div class="current-ip">
			Your IP: <code>{currentIp}</code>
		</div>
	</div>

	<!-- Filters -->
	<div class="filters-bar">
		<label class="checkbox-label">
			<input type="checkbox" bind:checked={includeDisabled} onchange={() => loadEntries()} />
			Show disabled entries
		</label>
	</div>

	<!-- Content -->
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-spinner loading-spinner"></i>
			<p>Loading IP allowlist...</p>
		</div>
	{:else if error}
		<div class="error-state">
			<p class="error-text">{error}</p>
			<button class="btn btn-secondary" onclick={loadEntries}>Retry</button>
		</div>
	{:else if entries.length === 0}
		<div class="empty-state">
			<p>No IP allowlist entries</p>
			<p class="text-secondary">Add IP addresses or CIDR ranges to restrict Admin panel access</p>
		</div>
	{:else}
		<div class="table-container">
			<table class="table">
				<thead>
					<tr>
						<th>IP Range</th>
						<th>Description</th>
						<th>Version</th>
						<th>Status</th>
						<th>Created</th>
						<th>Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each entries as entry (entry.id)}
						<tr class:disabled={!entry.enabled}>
							<td>
								<code class="ip-code">{entry.ip_range}</code>
							</td>
							<td>{entry.description || '-'}</td>
							<td>IPv{entry.ip_version || '?'}</td>
							<td>
								{#if entry.enabled}
									<span class="badge badge-success">Enabled</span>
								{:else}
									<span class="badge badge-neutral">Disabled</span>
								{/if}
							</td>
							<td>{formatDate(entry.created_at)}</td>
							<td>
								<div class="action-buttons">
									<button
										class="btn btn-sm btn-secondary"
										onclick={() => handleToggleEnabled(entry)}
									>
										{entry.enabled ? 'Disable' : 'Enable'}
									</button>
									<button class="btn btn-sm btn-secondary" onclick={() => openEditDialog(entry)}>
										Edit
									</button>
									<button class="btn btn-sm btn-danger" onclick={() => handleDelete(entry)}>
										Delete
									</button>
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<!-- Create Dialog -->
{#if showCreateDialog}
	<div class="dialog-overlay" onclick={closeCreateDialog}>
		<div class="dialog" onclick={(e) => e.stopPropagation()}>
			<div class="dialog-header">
				<h2>Add IP Entry</h2>
				<button class="close-btn" onclick={closeCreateDialog}>&times;</button>
			</div>
			<div class="dialog-body">
				{#if createError}
					<div class="alert alert-danger">{createError}</div>
				{/if}
				<div class="form-group">
					<label for="ipRange">IP Address or CIDR Range *</label>
					<input
						type="text"
						id="ipRange"
						class="input"
						bind:value={newIpRange}
						placeholder="e.g., 192.168.1.0/24 or 10.0.0.1"
					/>
					<p class="help-text">Single IP or CIDR notation (e.g., 192.168.1.0/24)</p>
				</div>
				<div class="form-group">
					<label for="description">Description</label>
					<input
						type="text"
						id="description"
						class="input"
						bind:value={newDescription}
						placeholder="e.g., Office network"
					/>
				</div>
			</div>
			<div class="dialog-footer">
				<button class="btn btn-secondary" onclick={closeCreateDialog} disabled={creating}>
					Cancel
				</button>
				<button class="btn btn-primary" onclick={handleCreate} disabled={creating}>
					{creating ? 'Adding...' : 'Add'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Edit Dialog -->
{#if showEditDialog && editingEntry}
	<div class="dialog-overlay" onclick={closeEditDialog}>
		<div class="dialog" onclick={(e) => e.stopPropagation()}>
			<div class="dialog-header">
				<h2>Edit IP Entry</h2>
				<button class="close-btn" onclick={closeEditDialog}>&times;</button>
			</div>
			<div class="dialog-body">
				<div class="form-group">
					<label for="editIpRange">IP Address or CIDR Range</label>
					<input type="text" id="editIpRange" class="input" bind:value={editIpRange} />
				</div>
				<div class="form-group">
					<label for="editDescription">Description</label>
					<input type="text" id="editDescription" class="input" bind:value={editDescription} />
				</div>
			</div>
			<div class="dialog-footer">
				<button class="btn btn-secondary" onclick={closeEditDialog} disabled={saving}>
					Cancel
				</button>
				<button class="btn btn-primary" onclick={handleSave} disabled={saving}>
					{saving ? 'Saving...' : 'Save'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Check IP Dialog -->
{#if showCheckDialog}
	<div class="dialog-overlay" onclick={closeCheckDialog}>
		<div class="dialog" onclick={(e) => e.stopPropagation()}>
			<div class="dialog-header">
				<h2>Check IP Address</h2>
				<button class="close-btn" onclick={closeCheckDialog}>&times;</button>
			</div>
			<div class="dialog-body">
				<div class="form-group">
					<label for="checkIpInput">IP Address</label>
					<input
						type="text"
						id="checkIpInput"
						class="input"
						bind:value={checkIp}
						placeholder="Enter IP address to check"
					/>
				</div>
				{#if checkResult !== null}
					<div class="check-result {checkResult.allowed ? 'allowed' : 'denied'}">
						{#if checkResult.restriction_active}
							{#if checkResult.allowed}
								<span class="result-icon">✓</span>
								<span>This IP is <strong>allowed</strong></span>
							{:else}
								<span class="result-icon">✗</span>
								<span>This IP is <strong>not allowed</strong></span>
							{/if}
						{:else}
							<span class="result-icon">○</span>
							<span>No IP restriction active - all IPs are allowed</span>
						{/if}
					</div>
				{/if}
			</div>
			<div class="dialog-footer">
				<button class="btn btn-secondary" onclick={closeCheckDialog}>Close</button>
				<button
					class="btn btn-primary"
					onclick={handleCheckIp}
					disabled={checking || !checkIp.trim()}
				>
					{checking ? 'Checking...' : 'Check'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	/* Page-specific styles for IP Allowlist */

	/* Status Banner */
	.status-banner {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 1rem 1.5rem;
		border-radius: var(--radius-lg);
		margin-bottom: 1.5rem;
	}

	.status-banner.active {
		background: var(--success-subtle);
		border: 1px solid var(--success);
	}

	.status-banner.inactive {
		background: var(--warning-subtle);
		border: 1px solid var(--warning);
	}

	.status-icon svg {
		width: 2rem;
		height: 2rem;
	}

	.status-banner.active .status-icon {
		color: var(--success);
	}

	.status-banner.inactive .status-icon {
		color: var(--warning);
	}

	.status-text {
		flex: 1;
	}

	.status-text strong {
		display: block;
		color: var(--text-primary);
	}

	.status-text span {
		font-size: 0.875rem;
		color: var(--text-secondary);
	}

	.current-ip {
		font-size: 0.875rem;
		color: var(--text-primary);
	}

	.current-ip code {
		background: var(--bg-subtle);
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius-sm);
	}

	/* Filters */
	.filters-bar {
		margin-bottom: 1rem;
	}

	.checkbox-label {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		cursor: pointer;
		font-size: 0.875rem;
		color: var(--text-primary);
	}

	/* Table */
	.table-container {
		overflow-x: auto;
		background: var(--bg-card);
		border-radius: var(--radius-lg);
		border: 1px solid var(--border);
	}

	.table {
		width: 100%;
		border-collapse: collapse;
	}

	.table th,
	.table td {
		padding: 0.75rem 1rem;
		text-align: left;
		border-bottom: 1px solid var(--border);
	}

	.table th {
		font-weight: 600;
		font-size: 0.75rem;
		text-transform: uppercase;
		color: var(--text-secondary);
		background: var(--bg-subtle);
	}

	.table tr.disabled {
		opacity: 0.6;
	}

	.ip-code {
		background: var(--bg-subtle);
		padding: 0.25rem 0.5rem;
		border-radius: var(--radius-sm);
		font-family: var(--font-mono);
		color: var(--text-primary);
	}

	.action-buttons {
		display: flex;
		gap: 0.5rem;
	}

	/* Error state */
	.error-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 48px 24px;
		text-align: center;
		color: var(--text-secondary);
	}

	.error-text {
		color: var(--danger);
		margin-bottom: 1rem;
	}

	.text-secondary {
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	/* Dialog extensions */
	.dialog-body {
		padding: 1.5rem;
	}

	.dialog-footer {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		padding: 1rem 1.5rem;
		border-top: 1px solid var(--border);
	}

	/* Form */
	.input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-input);
		color: var(--text-primary);
		font-size: 0.875rem;
	}

	.input:focus {
		outline: none;
		border-color: var(--primary);
		box-shadow: 0 0 0 3px var(--primary-subtle);
	}

	.help-text {
		font-size: 0.75rem;
		color: var(--text-secondary);
		margin-top: 0.25rem;
	}

	/* Alert */
	.alert-danger {
		background: var(--danger-subtle);
		color: var(--danger);
	}

	/* Check Result */
	.check-result {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 1rem;
		border-radius: var(--radius-md);
		margin-top: 1rem;
	}

	.check-result.allowed {
		background: var(--success-subtle);
		color: var(--success);
	}

	.check-result.denied {
		background: var(--danger-subtle);
		color: var(--danger);
	}

	.result-icon {
		font-size: 1.25rem;
	}
</style>
