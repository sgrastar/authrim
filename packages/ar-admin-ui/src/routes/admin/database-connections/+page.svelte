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
	let newD1BindingRef = $state('');
	let newHyperdriveBindingRef = $state('');
	let newHyperdriveDialect = $state<'postgres' | 'mysql'>('postgres');
	let newSqlConnectionString = $state('');
	let newSqlSchema = $state('');
	let newSqlPoolName = $state('');
	let newCustomType = $state('');
	let newCustomConfig = $state('');
	let newCustomCredential = $state('');

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

	function optionalString(value: string): string | undefined {
		const trimmed = value.trim();
		return trimmed ? trimmed : undefined;
	}

	function requiredString(value: string, label: string): string {
		const trimmed = value.trim();
		if (!trimmed) {
			throw new Error(`${label} is required.`);
		}
		return trimmed;
	}

	function buildCreateConfig(): Record<string, unknown> {
		if (newProvider === 'd1') {
			return {
				bindingRef: requiredString(newD1BindingRef, 'D1 binding reference')
			};
		}
		if (newProvider === 'hyperdrive') {
			return {
				bindingRef: requiredString(newHyperdriveBindingRef, 'Hyperdrive binding reference'),
				dialect: newHyperdriveDialect
			};
		}
		if (newProvider === 'postgres' || newProvider === 'mysql') {
			return {
				...(optionalString(newSqlSchema) ? { schema: optionalString(newSqlSchema) } : {}),
				...(optionalString(newSqlPoolName) ? { poolName: optionalString(newSqlPoolName) } : {})
			};
		}
		const customConfig = parseJsonField(newCustomConfig);
		return {
			type: requiredString(newCustomType, 'Custom connection type'),
			...(Object.keys(customConfig).length > 0 ? { config: customConfig } : {})
		};
	}

	function buildCreateCredential(): Record<string, unknown> | undefined {
		if (newProvider === 'postgres' || newProvider === 'mysql') {
			const connectionString = optionalString(newSqlConnectionString);
			return connectionString ? { connectionString } : undefined;
		}
		if (newProvider === 'custom') {
			const credential = parseJsonField(newCustomCredential);
			return Object.keys(credential).length > 0 ? credential : undefined;
		}
		return undefined;
	}

	function resetCreateForm() {
		newName = '';
		newDisplayName = '';
		newDescription = '';
		newD1BindingRef = '';
		newHyperdriveBindingRef = '';
		newHyperdriveDialect = 'postgres';
		newSqlConnectionString = '';
		newSqlSchema = '';
		newSqlPoolName = '';
		newCustomType = '';
		newCustomConfig = '';
		newCustomCredential = '';
	}

	async function createConnection() {
		saving = true;
		error = '';
		success = '';
		try {
			const config = buildCreateConfig();
			const credential = buildCreateCredential();
			await adminDatabaseConnectionsAPI.create({
				name: newName.trim(),
				display_name: newDisplayName.trim() || newName.trim(),
				description: newDescription.trim() || null,
				provider: newProvider,
				config,
				credential
			});
			resetCreateForm();
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

	function redactDisplayValue(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(redactDisplayValue);
		if (!value || typeof value !== 'object') return value;
		const redacted: Record<string, unknown> = {};
		for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
			if (
				/(secret|password|credential|token|api[_-]?key|private[_-]?key|authorization|connection[_-]?string|url)/iu.test(
					key
				)
			) {
				redacted[key] = '[redacted]';
			} else {
				redacted[key] = redactDisplayValue(nestedValue);
			}
		}
		return redacted;
	}

	function jsonDisplayText(value: unknown): string {
		return JSON.stringify(redactDisplayValue(value), null, 2);
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
							<span class="badge {item.status === 'active' ? 'badge-success' : 'badge-neutral'}"
								>{item.status}</span
							>
							<span class="text-muted text-sm"
								>{item.has_credential ? 'credential set' : 'no credential'}</span
							>
						</button>
					{/each}
				</div>
			{/if}
		</div>

		<div class="panel create-panel">
			<div class="panel-header">
				<div>
					<h2 class="panel-title">Create Connection</h2>
					<p class="panel-description">
						Register a database target for runtime profiles, audits, and tenant storage routing.
					</p>
				</div>
			</div>
			<div class="form-grid">
				<label class="form-label-group">
					<span>Name</span>
					<input bind:value={newName} />
					<small>Stable identifier used by API and routing records.</small>
				</label>
				<label class="form-label-group">
					<span>Display name</span>
					<input bind:value={newDisplayName} />
					<small>Human-readable name shown in Admin UI selectors.</small>
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
					<small>Optional operational note for where this connection is used.</small>
				</label>

				<div class="form-section wide">
					<div>
						<h3 class="form-section-title">Provider settings</h3>
						<p class="form-section-description">
							These fields become the connection config stored by the API.
						</p>
					</div>
					<div class="deployment-note">
						<strong>Binding deployment</strong>
						<p>
							D1 and Hyperdrive binding names must already exist in the Worker deployment. Adding or
							renaming a binding requires updating setup/wrangler configuration and redeploying
							before runtime traffic can use this connection. Direct PostgreSQL/MySQL credentials
							can be rotated from Admin UI, but a Hyperdrive binding change still requires deploy.
						</p>
					</div>
					{#if newProvider === 'd1'}
						<label class="form-label-group nested-single">
							<span>D1 binding reference</span>
							<input bind:value={newD1BindingRef} />
							<small>Worker binding name for the D1 database created by setup or operations.</small>
						</label>
					{:else if newProvider === 'hyperdrive'}
						<div class="form-grid nested">
							<label class="form-label-group">
								<span>Hyperdrive binding reference</span>
								<input bind:value={newHyperdriveBindingRef} />
								<small>Worker binding name for the Hyperdrive connection.</small>
							</label>
							<label class="form-label-group">
								<span>SQL dialect</span>
								<select bind:value={newHyperdriveDialect}>
									<option value="postgres">PostgreSQL</option>
									<option value="mysql">MySQL</option>
								</select>
								<small>Used by connectivity checks and runtime adapter selection.</small>
							</label>
						</div>
					{:else if newProvider === 'postgres' || newProvider === 'mysql'}
						<div class="form-grid nested">
							<label class="form-label-group">
								<span>Schema</span>
								<input bind:value={newSqlSchema} />
								<small>Optional default schema or database namespace.</small>
							</label>
							<label class="form-label-group">
								<span>Pool name</span>
								<input bind:value={newSqlPoolName} />
								<small>Optional label for operators and logs.</small>
							</label>
						</div>
					{:else}
						<div class="form-grid nested">
							<label class="form-label-group">
								<span>Custom type</span>
								<input bind:value={newCustomType} />
								<small>Provider-specific connection type.</small>
							</label>
							<label class="form-label-group wide">
								<span>Advanced fields</span>
								<textarea rows="5" bind:value={newCustomConfig}></textarea>
								<small>Optional object for fields that do not have a dedicated control yet.</small>
							</label>
						</div>
					{/if}
				</div>

				{#if newProvider === 'postgres' || newProvider === 'mysql' || newProvider === 'custom'}
					<div class="form-section wide">
						<div>
							<h3 class="form-section-title">Credentials</h3>
							<p class="form-section-description">
								Secrets are encrypted by the management API and are not stored in config.
							</p>
						</div>
						{#if newProvider === 'postgres' || newProvider === 'mysql'}
							<label class="form-label-group nested-single">
								<span>Connection string</span>
								<textarea rows="3" bind:value={newSqlConnectionString} autocomplete="off"
								></textarea>
								<small
									>Stored as an encrypted credential. Prefer Hyperdrive for production Workers
									deployments.</small
								>
							</label>
						{:else}
							<label class="form-label-group nested-single">
								<span>Credential object</span>
								<textarea rows="5" bind:value={newCustomCredential} autocomplete="off"></textarea>
								<small>Optional encrypted credential object for custom providers.</small>
							</label>
						{/if}
					</div>
				{/if}
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
					<button class="btn btn-secondary btn-sm" onclick={testSelected} disabled={saving}
						>Test connection</button
					>
					<button class="btn btn-danger btn-sm" onclick={deleteSelected} disabled={saving}
						>Delete</button
					>
				</div>
			</div>
			<div class="stat-grid">
				<div class="stat-card"><span>Status</span><strong>{selected.status}</strong></div>
				<div class="stat-card">
					<span>Credential</span><strong>{selected.has_credential ? 'Set' : 'Not set'}</strong>
				</div>
				<div class="stat-card">
					<span>Credential Updated</span><strong
						>{formatDate(selected.credential_updated_at)}</strong
					>
				</div>
				<div class="stat-card">
					<span>Updated By</span><strong>{selected.credential_updated_by || '-'}</strong>
				</div>
			</div>
			<pre class="code-block">{jsonDisplayText(selected.config)}</pre>
			<div class="credential-section">
				<h3 class="subsection-title">Update Credential</h3>
				<div class="form-grid">
					<label class="form-label-group wide">
						<span>Elevation grant ID</span>
						<input bind:value={elevationGrantId} />
						<small>Required unless the caller already has wildcard credential access.</small>
					</label>
					<label class="form-label-group wide">
						<span>New credential object</span>
						<textarea rows="4" bind:value={credentialPayload}></textarea>
					</label>
				</div>
				<div class="form-actions" style="margin-top: 0.75rem;">
					<button
						class="btn btn-secondary"
						onclick={rotateCredential}
						disabled={saving || !credentialPayload}
					>
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
		grid-template-columns: minmax(0, 1fr) minmax(420px, 1fr);
		gap: 1.25rem;
		align-items: start;
	}

	.panel {
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--bg-card);
		padding: 1.5rem;
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
		font-size: 1.05rem;
		font-weight: 600;
	}

	.panel-description {
		margin: 0.25rem 0 0;
		color: var(--text-secondary);
		font-size: 0.875rem;
		line-height: 1.45;
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
		gap: 1rem;
		align-items: start;
	}

	.form-grid.nested {
		margin-top: 1rem;
	}

	.nested-single {
		margin-top: 1rem;
	}

	.form-label-group {
		display: flex;
		flex-direction: column;
		gap: 0.45rem;
		font-size: 0.875rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.form-label-group small {
		color: var(--text-secondary);
		font-size: 0.8125rem;
		font-weight: 400;
		line-height: 1.4;
	}

	.form-section {
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-subtle);
		padding: 1rem;
	}

	.form-section-title {
		margin: 0;
		color: var(--text-primary);
		font-size: 0.9375rem;
		font-weight: 600;
	}

	.form-section-description {
		margin: 0.25rem 0 0;
		color: var(--text-secondary);
		font-size: 0.8125rem;
		line-height: 1.45;
	}

	.deployment-note {
		margin-top: 1rem;
		padding: 0.875rem;
		border: 1px solid color-mix(in srgb, var(--primary) 24%, var(--border));
		border-radius: var(--radius-md);
		background: color-mix(in srgb, var(--primary) 7%, var(--bg-card));
	}

	.deployment-note strong {
		display: block;
		color: var(--text-primary);
		font-size: 0.875rem;
		font-weight: 600;
	}

	.deployment-note p {
		margin: 0.25rem 0 0;
		color: var(--text-secondary);
		font-size: 0.8125rem;
		line-height: 1.5;
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
		border-radius: var(--radius-md);
		padding: 0.625rem 0.75rem;
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
		font-size: 0.875rem;
		min-height: 2.625rem;
		width: 100%;
	}

	input:focus,
	select:focus,
	textarea:focus {
		outline: 2px solid color-mix(in srgb, var(--primary) 28%, transparent);
		outline-offset: 1px;
	}

	textarea,
	.code-block {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
	}

	textarea {
		line-height: 1.5;
		resize: vertical;
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
		.stat-grid,
		.form-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
