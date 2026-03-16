<script lang="ts">
	import { onMount } from 'svelte';

	// ==========================================================================
	// Types
	// ==========================================================================

	interface TenantDomainMapping {
		id: string;
		tenant_id: string;
		hash_version: number;
		priority: number;
		is_active: boolean;
		verified: boolean;
		verification_expires_at: number | null;
		created_by: string | null;
		created_at: number;
		updated_at: number;
	}

	// ==========================================================================
	// State
	// ==========================================================================

	let mappings = $state<TenantDomainMapping[]>([]);
	let loading = $state(true);
	let error = $state('');
	let successMessage = $state('');

	// Create dialog
	let showCreateDialog = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let newDomain = $state('');
	let newTenantId = $state('');
	let newPriority = $state(0);

	// Verify dialog
	let showVerifyDialog = $state(false);
	let verifying = $state(false);
	let verifyError = $state('');
	let verifyingMapping: TenantDomainMapping | null = $state(null);
	let verifyDomain = $state('');
	let verifyDnsRecord: { name: string; value: string; type: string } | null = $state(null);
	let confirmingVerification = $state(false);

	// Delete confirm
	let deletingId = $state('');

	// ==========================================================================
	// API
	// ==========================================================================

	const API_BASE = '';

	async function apiFetch(path: string, options?: Parameters<typeof fetch>[1]) {
		const response = await fetch(`${API_BASE}${path}`, {
			credentials: 'include',
			...options,
			headers: {
				'Content-Type': 'application/json',
				...(options?.headers ?? {})
			}
		});

		if (!response.ok) {
			const err = await response.json().catch(() => ({}));
			throw new Error(
				(err as { error_description?: string; message?: string }).error_description ||
					(err as { error_description?: string; message?: string }).message ||
					`HTTP ${response.status}`
			);
		}
		return response.json();
	}

	// ==========================================================================
	// Load
	// ==========================================================================

	async function loadMappings() {
		loading = true;
		error = '';
		try {
			const result = (await apiFetch('/api/admin/platform/tenant-domain-mappings')) as {
				mappings: TenantDomainMapping[];
			};
			mappings = result.mappings;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load mappings';
		} finally {
			loading = false;
		}
	}

	onMount(loadMappings);

	// ==========================================================================
	// Create
	// ==========================================================================

	function openCreateDialog() {
		newDomain = '';
		newTenantId = '';
		newPriority = 0;
		createError = '';
		showCreateDialog = true;
	}

	async function handleCreate() {
		if (!newDomain.trim() || !newTenantId.trim()) {
			createError = 'Domain and Tenant ID are required';
			return;
		}
		creating = true;
		createError = '';
		try {
			await apiFetch('/api/admin/platform/tenant-domain-mappings', {
				method: 'POST',
				body: JSON.stringify({
					domain: newDomain.trim().toLowerCase(),
					tenant_id: newTenantId.trim(),
					priority: newPriority
				})
			});
			showCreateDialog = false;
			successMessage = `Domain mapping for "${newDomain.trim()}" created successfully.`;
			await loadMappings();
		} catch (err) {
			createError = err instanceof Error ? err.message : 'Failed to create mapping';
		} finally {
			creating = false;
		}
	}

	// ==========================================================================
	// Verify
	// ==========================================================================

	function openVerifyDialog(mapping: TenantDomainMapping) {
		verifyingMapping = mapping;
		verifyDomain = '';
		verifyDnsRecord = null;
		verifyError = '';
		showVerifyDialog = true;
	}

	async function handleInitiateVerification() {
		if (!verifyingMapping || !verifyDomain.trim()) {
			verifyError = 'Domain is required';
			return;
		}
		verifying = true;
		verifyError = '';
		try {
			const result = (await apiFetch('/api/admin/platform/tenant-domain-mappings/verify', {
				method: 'POST',
				body: JSON.stringify({ id: verifyingMapping.id, domain: verifyDomain.trim() })
			})) as { dns_record_name: string; dns_record_value: string; dns_record_type: string };
			verifyDnsRecord = {
				name: result.dns_record_name,
				value: result.dns_record_value,
				type: result.dns_record_type
			};
		} catch (err) {
			verifyError = err instanceof Error ? err.message : 'Failed to initiate verification';
		} finally {
			verifying = false;
		}
	}

	async function handleConfirmVerification() {
		if (!verifyingMapping || !verifyDomain.trim()) return;
		confirmingVerification = true;
		verifyError = '';
		try {
			await apiFetch('/api/admin/platform/tenant-domain-mappings/verify/confirm', {
				method: 'POST',
				body: JSON.stringify({ id: verifyingMapping.id, domain: verifyDomain.trim() })
			});
			showVerifyDialog = false;
			successMessage = `Domain "${verifyDomain.trim()}" verified successfully.`;
			await loadMappings();
		} catch (err) {
			verifyError = err instanceof Error ? err.message : 'Verification failed. Check DNS record.';
		} finally {
			confirmingVerification = false;
		}
	}

	// ==========================================================================
	// Delete
	// ==========================================================================

	async function handleDelete(id: string) {
		if (!confirm('Delete this domain mapping? This cannot be undone.')) return;
		deletingId = id;
		try {
			await apiFetch(`/api/admin/platform/tenant-domain-mappings/${id}`, { method: 'DELETE' });
			mappings = mappings.filter((m) => m.id !== id);
			successMessage = 'Domain mapping deleted.';
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to delete mapping';
		} finally {
			deletingId = '';
		}
	}

	// ==========================================================================
	// Helpers
	// ==========================================================================

	function formatDate(ts: number) {
		return new Date(ts * 1000).toLocaleDateString();
	}
</script>

<div class="page">
	<div class="page-header">
		<div>
			<h1 class="page-title">Tenant Domain Mappings</h1>
			<p class="page-description">
				Map email domains to tenants for automatic routing during signup. Requires <strong
					>system admin</strong
				> privileges.
			</p>
		</div>
		<button class="btn btn-primary" onclick={openCreateDialog}>
			<i class="i-ph-plus"></i>
			Add Mapping
		</button>
	</div>

	{#if error}
		<div class="alert alert-error">
			<i class="i-ph-warning-circle"></i>
			{error}
		</div>
	{/if}

	{#if successMessage}
		<div class="alert alert-success">
			<i class="i-ph-check-circle"></i>
			{successMessage}
		</div>
	{/if}

	<div class="info-box">
		<i class="i-ph-info"></i>
		<div>
			<strong>How it works:</strong> When a user signs up with an email like
			<code>user@company.com</code>, and <code>company.com</code> is mapped to the
			<code>acme</code> tenant (verified, active), they will be automatically routed to that tenant. Host
			header resolution takes priority over this mapping.
		</div>
	</div>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch animate-spin"></i>
			Loading mappings...
		</div>
	{:else if mappings.length === 0}
		<div class="empty-state">
			<i class="i-ph-globe"></i>
			<p>No tenant domain mappings configured.</p>
		</div>
	{:else}
		<div class="table-container">
			<table class="table">
				<thead>
					<tr>
						<th>Tenant</th>
						<th>Priority</th>
						<th>Status</th>
						<th>Verified</th>
						<th>Created</th>
						<th>Actions</th>
					</tr>
				</thead>
				<tbody>
					{#each mappings as mapping (mapping.id)}
						<tr>
							<td class="mono">{mapping.tenant_id}</td>
							<td>{mapping.priority}</td>
							<td>
								{#if mapping.is_active}
									<span class="badge badge-active">Active</span>
								{:else}
									<span class="badge badge-inactive">Inactive</span>
								{/if}
							</td>
							<td>
								{#if mapping.verified}
									<span class="badge badge-verified">
										<i class="i-ph-check"></i>
										Verified
									</span>
								{:else}
									<span class="badge badge-unverified">Unverified</span>
								{/if}
							</td>
							<td>{formatDate(mapping.created_at)}</td>
							<td class="actions">
								{#if !mapping.verified}
									<button
										class="btn btn-sm btn-secondary"
										onclick={() => openVerifyDialog(mapping)}
									>
										Verify DNS
									</button>
								{/if}
								<button
									class="btn btn-sm btn-danger-outline"
									disabled={deletingId === mapping.id}
									onclick={() => handleDelete(mapping.id)}
								>
									{#if deletingId === mapping.id}
										<i class="i-ph-circle-notch animate-spin"></i>
									{:else}
										Delete
									{/if}
								</button>
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
	<div
		class="modal-overlay"
		onclick={() => (showCreateDialog = false)}
		role="button"
		tabindex="-1"
		aria-label="Close dialog"
		onkeydown={(e) => e.key === 'Escape' && (showCreateDialog = false)}
	></div>
	<div class="modal" role="dialog" aria-modal="true" aria-labelledby="create-dialog-title">
		<div class="modal-header">
			<h2 id="create-dialog-title">Add Domain Mapping</h2>
			<button class="modal-close" onclick={() => (showCreateDialog = false)} aria-label="Close">
				<i class="i-ph-x"></i>
			</button>
		</div>
		<div class="modal-body">
			{#if createError}
				<div class="alert alert-error">{createError}</div>
			{/if}
			<div class="form-group">
				<label for="new-domain" class="form-label">Domain <span class="required">*</span></label>
				<input
					id="new-domain"
					type="text"
					class="form-input"
					bind:value={newDomain}
					placeholder="e.g. company.com"
					autocomplete="off"
				/>
				<p class="field-hint">
					Lowercase domain. Users with this email domain will be routed to the tenant.
				</p>
			</div>
			<div class="form-group">
				<label for="new-tenant" class="form-label">Tenant ID <span class="required">*</span></label>
				<input
					id="new-tenant"
					type="text"
					class="form-input"
					bind:value={newTenantId}
					placeholder="e.g. acme"
					autocomplete="off"
				/>
			</div>
			<div class="form-group">
				<label for="new-priority" class="form-label">Priority</label>
				<input
					id="new-priority"
					type="number"
					class="form-input"
					bind:value={newPriority}
					min="0"
					max="1000"
				/>
				<p class="field-hint">Higher value = higher priority. Used when multiple mappings match.</p>
			</div>
		</div>
		<div class="modal-footer">
			<button
				class="btn btn-secondary"
				onclick={() => (showCreateDialog = false)}
				disabled={creating}
			>
				Cancel
			</button>
			<button class="btn btn-primary" onclick={handleCreate} disabled={creating}>
				{#if creating}
					<i class="i-ph-circle-notch animate-spin"></i>
					Creating...
				{:else}
					Create Mapping
				{/if}
			</button>
		</div>
	</div>
{/if}

<!-- Verify Dialog -->
{#if showVerifyDialog && verifyingMapping}
	<div
		class="modal-overlay"
		onclick={() => (showVerifyDialog = false)}
		role="button"
		tabindex="-1"
		aria-label="Close dialog"
		onkeydown={(e) => e.key === 'Escape' && (showVerifyDialog = false)}
	></div>
	<div
		class="modal modal-wide"
		role="dialog"
		aria-modal="true"
		aria-labelledby="verify-dialog-title"
	>
		<div class="modal-header">
			<h2 id="verify-dialog-title">Verify Domain Ownership</h2>
			<button class="modal-close" onclick={() => (showVerifyDialog = false)} aria-label="Close">
				<i class="i-ph-x"></i>
			</button>
		</div>
		<div class="modal-body">
			{#if verifyError}
				<div class="alert alert-error">{verifyError}</div>
			{/if}
			<p class="verify-intro">
				Verify that you own the domain for tenant <strong>{verifyingMapping.tenant_id}</strong>.
				Enter the domain and add the DNS TXT record shown below.
			</p>
			<div class="form-group">
				<label for="verify-domain" class="form-label">Domain <span class="required">*</span></label>
				<input
					id="verify-domain"
					type="text"
					class="form-input"
					bind:value={verifyDomain}
					placeholder="e.g. company.com"
					autocomplete="off"
				/>
			</div>
			{#if !verifyDnsRecord}
				<button
					class="btn btn-primary"
					onclick={handleInitiateVerification}
					disabled={verifying || !verifyDomain.trim()}
				>
					{#if verifying}
						<i class="i-ph-circle-notch animate-spin"></i>
						Generating...
					{:else}
						Generate DNS Record
					{/if}
				</button>
			{:else}
				<div class="dns-record">
					<p class="dns-record-title">Add this DNS TXT record to your domain:</p>
					<div class="dns-row">
						<span class="dns-label">Type</span>
						<code class="dns-value">{verifyDnsRecord.type}</code>
					</div>
					<div class="dns-row">
						<span class="dns-label">Name</span>
						<code class="dns-value">{verifyDnsRecord.name}</code>
					</div>
					<div class="dns-row">
						<span class="dns-label">Value</span>
						<code class="dns-value dns-value-long">{verifyDnsRecord.value}</code>
					</div>
					<p class="field-hint">
						DNS propagation can take up to 48 hours. Click "Confirm Verification" once the record is
						added.
					</p>
				</div>
				<button
					class="btn btn-primary"
					onclick={handleConfirmVerification}
					disabled={confirmingVerification}
				>
					{#if confirmingVerification}
						<i class="i-ph-circle-notch animate-spin"></i>
						Checking DNS...
					{:else}
						Confirm Verification
					{/if}
				</button>
			{/if}
		</div>
		<div class="modal-footer">
			<button class="btn btn-secondary" onclick={() => (showVerifyDialog = false)}> Close </button>
		</div>
	</div>
{/if}

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: 24px;
	}

	.page-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}

	.page-title {
		font-family: var(--font-display);
		font-size: 1.5rem;
		font-weight: 700;
		color: var(--text-primary);
		margin: 0 0 4px;
	}

	.page-description {
		font-size: 0.875rem;
		color: var(--text-secondary);
		margin: 0;
	}

	.info-box {
		display: flex;
		gap: 12px;
		padding: 14px 16px;
		background: var(--primary-light, var(--bg-subtle));
		border: 1px solid var(--primary-border, var(--border));
		border-radius: var(--radius-md);
		font-size: 0.875rem;
		color: var(--text-secondary);
	}

	.info-box :global(i) {
		width: 18px;
		height: 18px;
		color: var(--primary);
		flex-shrink: 0;
		margin-top: 1px;
	}

	.info-box code {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		background: var(--bg-card);
		padding: 1px 4px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
	}

	.table-container {
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		overflow: hidden;
	}

	.table {
		width: 100%;
		border-collapse: collapse;
	}

	.table th {
		padding: 12px 16px;
		text-align: left;
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
		background: var(--bg-subtle);
		border-bottom: 1px solid var(--border);
	}

	.table td {
		padding: 14px 16px;
		font-size: 0.875rem;
		color: var(--text-primary);
		border-bottom: 1px solid var(--border-subtle);
		vertical-align: middle;
	}

	.table tr:last-child td {
		border-bottom: none;
	}

	.mono {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
	}

	.badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 8px;
		border-radius: var(--radius-full);
		font-size: 0.75rem;
		font-weight: 500;
	}

	.badge :global(i) {
		width: 12px;
		height: 12px;
	}

	.badge-active {
		background: var(--success-subtle);
		color: var(--success);
	}

	.badge-inactive {
		background: var(--bg-subtle);
		color: var(--text-muted);
	}

	.badge-verified {
		background: var(--success-subtle);
		color: var(--success);
	}

	.badge-unverified {
		background: var(--warning-subtle);
		color: var(--warning-dark);
	}

	.actions {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	/* Buttons */
	.btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 8px 16px;
		border-radius: var(--radius-md);
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: all var(--transition-fast);
		border: none;
		text-decoration: none;
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn :global(i) {
		width: 16px;
		height: 16px;
	}

	.btn-primary {
		background: var(--primary);
		color: white;
	}

	.btn-primary:hover:not(:disabled) {
		background: var(--primary-dark);
	}

	.btn-secondary {
		background: var(--bg-subtle);
		color: var(--text-primary);
		border: 1px solid var(--border);
	}

	.btn-secondary:hover:not(:disabled) {
		background: var(--bg-card);
	}

	.btn-danger-outline {
		background: transparent;
		color: var(--danger);
		border: 1px solid var(--danger);
	}

	.btn-danger-outline:hover:not(:disabled) {
		background: var(--danger-subtle);
	}

	.btn-sm {
		padding: 4px 10px;
		font-size: 0.8125rem;
	}

	/* Alert */
	.alert {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 12px 16px;
		border-radius: var(--radius-md);
		font-size: 0.875rem;
	}

	.alert :global(i) {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.alert-error {
		background: var(--danger-subtle);
		color: var(--danger);
		border: 1px solid var(--danger-border);
	}

	.alert-success {
		background: var(--success-subtle);
		color: var(--success);
		border: 1px solid var(--success-border, var(--success-subtle));
	}

	/* Loading / Empty */
	.loading-state,
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding: 48px;
		color: var(--text-muted);
		font-size: 0.875rem;
	}

	.loading-state :global(i),
	.empty-state :global(i) {
		width: 32px;
		height: 32px;
	}

	/* Modal */
	.modal-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		z-index: 100;
		border: none;
		cursor: default;
	}

	.modal {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		width: 100%;
		max-width: 480px;
		background: var(--bg-card);
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-xl);
		z-index: 101;
		display: flex;
		flex-direction: column;
		max-height: 90vh;
	}

	.modal-wide {
		max-width: 600px;
	}

	.modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 20px 24px 16px;
		border-bottom: 1px solid var(--border);
	}

	.modal-header h2 {
		font-size: 1.125rem;
		font-weight: 600;
		color: var(--text-primary);
		margin: 0;
	}

	.modal-close {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border: none;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
		border-radius: var(--radius-sm);
		transition: all var(--transition-fast);
	}

	.modal-close:hover {
		background: var(--bg-subtle);
		color: var(--text-primary);
	}

	.modal-close :global(i) {
		width: 18px;
		height: 18px;
	}

	.modal-body {
		padding: 20px 24px;
		display: flex;
		flex-direction: column;
		gap: 16px;
		overflow-y: auto;
	}

	.modal-footer {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
		padding: 16px 24px 20px;
		border-top: 1px solid var(--border);
	}

	/* Form */
	.form-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.form-label {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-primary);
	}

	.required {
		color: var(--danger);
	}

	.form-input {
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--bg-card);
		color: var(--text-primary);
		font-size: 0.875rem;
		font-family: var(--font-body);
		transition: border-color var(--transition-fast);
		outline: none;
		width: 100%;
		box-sizing: border-box;
	}

	.form-input:focus {
		border-color: var(--primary);
		box-shadow: 0 0 0 3px var(--primary-light);
	}

	.field-hint {
		font-size: 0.75rem;
		color: var(--text-muted);
		margin: 0;
	}

	/* DNS record display */
	.verify-intro {
		font-size: 0.875rem;
		color: var(--text-secondary);
		margin: 0;
	}

	.dns-record {
		background: var(--bg-subtle);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.dns-record-title {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--text-primary);
		margin: 0;
	}

	.dns-row {
		display: flex;
		align-items: baseline;
		gap: 12px;
	}

	.dns-label {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		color: var(--text-muted);
		min-width: 48px;
	}

	.dns-value {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		background: var(--bg-card);
		padding: 4px 8px;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
		color: var(--text-primary);
		word-break: break-all;
	}

	.dns-value-long {
		font-size: 0.75rem;
	}
</style>
