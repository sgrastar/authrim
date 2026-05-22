<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminDatabaseConnectionsAPI,
		type DatabaseConnection,
		type DatabaseConnectionProvider
	} from '$lib/api/admin-database-connections';

	let items = $state<DatabaseConnection[]>([]);
	let selected = $state<DatabaseConnection | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let error = $state('');
	let success = $state('');

	let newName = $state('');
	let newDisplayName = $state('');
	let newDescription = $state('');
	let newProvider = $state<DatabaseConnectionProvider>('hyperdrive');
	let newConfig = $state('{\n  "bindingRef": "HYPERDRIVE"\n}');
	let newCredential = $state('');

	let credentialPayload = $state('');
	let elevationGrantId = $state('');

	async function load() {
		loading = true;
		error = '';
		try {
			const response = await adminDatabaseConnectionsAPI.list();
			items = response.items;
			if (selected) {
				selected = items.find((item) => item.id === selected?.id) ?? null;
			}
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load database connections';
			items = [];
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function parseJsonField(value: string): Record<string, unknown> {
		const trimmed = value.trim();
		if (!trimmed) return {};
		const parsed = JSON.parse(trimmed);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('JSON must be an object');
		}
		return parsed as Record<string, unknown>;
	}

	async function createConnection() {
		saving = true;
		error = '';
		success = '';
		try {
			const config = parseJsonField(newConfig);
			const credential = newCredential.trim() ? parseJsonField(newCredential) : undefined;
			await adminDatabaseConnectionsAPI.create({
				name: newName.trim(),
				display_name: newDisplayName.trim() || newName.trim(),
				description: newDescription.trim() || null,
				provider: newProvider,
				config,
				credential
			});
			newName = '';
			newDisplayName = '';
			newDescription = '';
			newCredential = '';
			success = 'Database connection created.';
			await load();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create database connection';
		} finally {
			saving = false;
		}
	}

	async function rotateCredential() {
		if (!selected) return;
		saving = true;
		error = '';
		success = '';
		try {
			const credential = parseJsonField(credentialPayload);
			selected = await adminDatabaseConnectionsAPI.updateCredential(
				selected.id,
				credential,
				elevationGrantId.trim() || undefined
			);
			credentialPayload = '';
			elevationGrantId = '';
			success = 'Database credential updated.';
			await load();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to update database credential';
		} finally {
			saving = false;
		}
	}

	async function deleteSelected() {
		if (!selected) return;
		if (!confirm(`Delete database connection "${selected.display_name}"?`)) return;
		saving = true;
		error = '';
		success = '';
		try {
			await adminDatabaseConnectionsAPI.delete(selected.id, elevationGrantId.trim() || undefined);
			selected = null;
			elevationGrantId = '';
			success = 'Database connection deleted.';
			await load();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to delete database connection';
		} finally {
			saving = false;
		}
	}

	async function testSelected() {
		if (!selected) return;
		saving = true;
		error = '';
		success = '';
		try {
			const result = await adminDatabaseConnectionsAPI.test(selected.id);
			success = result.message || `Connection test status: ${result.status}`;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to test database connection';
		} finally {
			saving = false;
		}
	}

	function formatDate(timestamp: number | null): string {
		return timestamp ? new Date(timestamp).toLocaleString() : '-';
	}
</script>

<svelte:head>
	<title>Database Connections - Authrim</title>
</svelte:head>

<div class="page-shell">
	<header class="page-header">
		<div class="page-title-group">
			<h1 class="page-title">Database Connections</h1>
			<p class="page-description">Manage platform database connection profiles</p>
		</div>
		<button class="btn btn-secondary" onclick={load} disabled={loading}>Refresh</button>
	</header>

	{#if error}<div class="alert alert-error">{error}</div>{/if}
	{#if success}<div class="alert alert-success">{success}</div>{/if}

	<div class="split-panel">
		<div class="panel">
			<div class="panel-header">
				<h2 class="panel-title">Connections</h2>
				<span class="badge badge-neutral">{items.length}</span>
			</div>
			{#if loading}
				<p class="text-muted">Loading...</p>
			{:else if items.length === 0}
				<p class="text-muted">No database connections.</p>
			{:else}
				<div class="item-list">
					{#each items as item (item.id)}
						<button
							class="item-row"
							class:selected={selected?.id === item.id}
							onclick={() => (selected = item)}
						>
							<div class="item-name">
								<strong>{item.display_name}</strong>
								<small>{item.name}</small>
							</div>
							<span class="badge badge-neutral">{item.provider}</span>
							<span class="badge {item.status === 'active' ? 'badge-success' : 'badge-neutral'}">{item.status}</span>
							<span class="text-muted text-sm">{item.has_credential ? 'credential set' : 'no credential'}</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<div class="panel create-panel">
			<div class="panel-header">
				<h2 class="panel-title">Create Connection</h2>
			</div>
			<div class="form-grid">
				<label class="form-label-group">
					<span>Name</span>
					<input bind:value={newName} placeholder="primary-pg" />
				</label>
				<label class="form-label-group">
					<span>Display name</span>
					<input bind:value={newDisplayName} placeholder="Primary PostgreSQL" />
				</label>
				<label class="form-label-group">
					<span>Provider</span>
					<select bind:value={newProvider}>
						<option value="d1">D1</option>
						<option value="hyperdrive">Hyperdrive</option>
						<option value="postgres">PostgreSQL</option>
						<option value="mysql">MySQL</option>
						<option value="custom">Custom</option>
					</select>
				</label>
				<label class="form-label-group">
					<span>Description</span>
					<input bind:value={newDescription} />
				</label>
				<label class="form-label-group wide">
					<span>Config JSON</span>
					<textarea rows="7" bind:value={newConfig}></textarea>
				</label>
				<label class="form-label-group wide">
					<span>Credential JSON</span>
					<textarea rows="5" bind:value={newCredential} placeholder="JSON credential object"></textarea>
				</label>
				<div class="form-actions">
					<button class="btn btn-primary" onclick={createConnection} disabled={saving || !newName}>
						Create Connection
					</button>
				</div>
			</div>
		</div>
	</div>

	{#if selected}
		<div class="panel">
			<div class="panel-header">
				<div>
					<h2 class="panel-title">{selected.display_name}</h2>
					<p class="text-muted text-sm">{selected.provider}</p>
				</div>
				<div class="header-actions">
					<button class="btn btn-secondary btn-sm" onclick={testSelected} disabled={saving}>Test connection</button>
					<button class="btn btn-danger btn-sm" onclick={deleteSelected} disabled={saving}>Delete</button>
				</div>
			</div>
			<div class="stat-grid">
				<div class="stat-card"><span>Status</span><strong>{selected.status}</strong></div>
				<div class="stat-card"><span>Credential</span><strong>{selected.has_credential ? 'Set' : 'Not set'}</strong></div>
				<div class="stat-card"><span>Credential Updated</span><strong>{formatDate(selected.credential_updated_at)}</strong></div>
				<div class="stat-card"><span>Updated By</span><strong>{selected.credential_updated_by || '-'}</strong></div>
			</div>
			<pre class="code-block">{JSON.stringify(selected.config, null, 2)}</pre>
			<div class="credential-section">
				<h3 class="subsection-title">Update Credential</h3>
				<div class="form-grid">
					<label class="form-label-group wide">
						<span>Elevation grant ID</span>
						<input bind:value={elevationGrantId} placeholder="Required unless caller has wildcard access" />
					</label>
					<label class="form-label-group wide">
						<span>New credential JSON</span>
						<textarea rows="4" bind:value={credentialPayload} placeholder="JSON credential object"></textarea>
					</label>
				</div>
				<div class="form-actions" style="margin-top: 0.75rem;">
					<button class="btn btn-secondary" onclick={rotateCredential} disabled={saving || !credentialPayload}>
						Update Credential
					</button>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.page-shell {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.page-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.page-title {
		margin: 0 0 0.25rem;
		font-size: 1.5rem;
	}

	.page-description {
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
	}

	.alert {
		padding: 0.75rem 1rem;
		border-radius: var(--radius-sm);
		font-size: 0.875rem;
	}

	.alert-error {
		background: rgba(239, 68, 68, 0.08);
		color: #991b1b;
		border: 1px solid rgba(239, 68, 68, 0.2);
	}

	.alert-success {
		background: rgba(16, 185, 129, 0.08);
		color: #065f46;
		border: 1px solid rgba(16, 185, 129, 0.2);
	}

	.split-panel {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 0.6fr);
		gap: 1.25rem;
		align-items: start;
	}

	.panel {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-card);
		padding: 1.25rem;
	}

	.panel-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	.panel-title {
		margin: 0;
		font-size: 0.9375rem;
		font-weight: 600;
	}

	.header-actions {
		display: flex;
		gap: 0.5rem;
	}

	.item-list {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		overflow: hidden;
	}

	.item-row {
		display: grid;
		grid-template-columns: 1fr auto auto auto;
		align-items: center;
		gap: 0.75rem;
		padding: 0.75rem 1rem;
		border: none;
		border-bottom: 1px solid var(--border);
		background: var(--bg-card);
		text-align: left;
		cursor: pointer;
		transition: background var(--transition-fast);
	}

	.item-row:last-child {
		border-bottom: none;
	}

	.item-row:hover,
	.item-row.selected {
		background: var(--bg-subtle);
	}

	.item-name strong {
		display: block;
		font-weight: 600;
		color: var(--text-primary);
	}

	.item-name small {
		color: var(--text-secondary);
		font-size: 0.75rem;
	}

	.badge {
		display: inline-flex;
		align-items: center;
		padding: 2px 8px;
		border-radius: var(--radius-full);
		font-size: 0.75rem;
		font-weight: 600;
		white-space: nowrap;
	}

	.badge-neutral {
		background: var(--bg-subtle);
		color: var(--text-secondary);
	}

	.badge-success {
		background: rgba(16, 185, 129, 0.1);
		color: #065f46;
	}

	.form-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}

	.form-label-group {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-secondary);
	}

	.wide {
		grid-column: 1 / -1;
	}

	.form-actions {
		grid-column: 1 / -1;
		display: flex;
		justify-content: flex-start;
	}

	input,
	select,
	textarea {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.5rem 0.75rem;
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
		min-height: 2.25rem;
	}

	textarea,
	.code-block {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
	}

	.code-block {
		padding: 0.75rem;
		background: var(--bg-subtle);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		overflow: auto;
		max-height: 220px;
		margin: 0.75rem 0 0;
	}

	.stat-grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0.75rem;
	}

	.stat-card {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.75rem;
	}

	.stat-card span {
		display: block;
		color: var(--text-secondary);
		font-size: 0.75rem;
		margin-bottom: 0.25rem;
	}

	.stat-card strong {
		font-weight: 600;
		font-size: 0.875rem;
	}

	.credential-section {
		margin-top: 1.25rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--border);
	}

	.subsection-title {
		margin: 0 0 0.75rem;
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-secondary);
	}

	.text-muted {
		color: var(--text-secondary);
	}

	.text-sm {
		font-size: 0.8125rem;
	}

	.btn {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.5rem 0.875rem;
		font: inherit;
		font-size: 0.875rem;
		cursor: pointer;
		transition: background var(--transition-fast);
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-primary {
		background: var(--primary);
		color: #fff;
		border-color: var(--primary);
	}

	.btn-primary:hover:not(:disabled) {
		background: var(--primary-hover);
	}

	.btn-secondary {
		background: var(--bg-subtle);
		color: var(--text-primary);
	}

	.btn-secondary:hover:not(:disabled) {
		background: var(--border);
	}

	.btn-danger {
		background: rgba(239, 68, 68, 0.1);
		color: #991b1b;
		border-color: rgba(239, 68, 68, 0.3);
	}

	.btn-danger:hover:not(:disabled) {
		background: rgba(239, 68, 68, 0.18);
	}

	.btn-sm {
		padding: 0.3rem 0.625rem;
		font-size: 0.8125rem;
	}

	@media (max-width: 900px) {
		.split-panel,
		.stat-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
