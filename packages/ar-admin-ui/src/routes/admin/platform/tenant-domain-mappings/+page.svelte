<script lang="ts">
	import { onMount } from 'svelte';
	import { LL } from '$i18n/i18n-svelte';
	import { API_BASE_URL, adminFetch } from '$lib/api/admin-request';
	import { Modal } from '$lib/components';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection
	} from '$lib/components/admin';

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

	async function apiFetch(path: string, options?: Parameters<typeof fetch>[1]) {
		const response = await adminFetch(`${API_BASE_URL}${path}`, {
			...options,
			includeJsonContentType: true,
			skipTenantHeader: true
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
			error = err instanceof Error ? err.message : $LL.admin_tenant_domain_mappings_load_failed();
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
			createError = $LL.admin_tenant_domain_mappings_required();
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
			successMessage = $LL.admin_tenant_domain_mappings_create_success({
				domain: newDomain.trim()
			});
			await loadMappings();
		} catch (err) {
			createError =
				err instanceof Error ? err.message : $LL.admin_tenant_domain_mappings_create_failed();
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
			verifyError = $LL.admin_tenant_domain_mappings_verify_domain_required();
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
			verifyError =
				err instanceof Error ? err.message : $LL.admin_tenant_domain_mappings_verify_failed();
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
			successMessage = $LL.admin_tenant_domain_mappings_verify_success({
				domain: verifyDomain.trim()
			});
			await loadMappings();
		} catch (err) {
			verifyError =
				err instanceof Error ? err.message : $LL.admin_tenant_domain_mappings_confirm_failed();
		} finally {
			confirmingVerification = false;
		}
	}

	// ==========================================================================
	// Delete
	// ==========================================================================

	async function handleDelete(id: string) {
		if (!confirm($LL.admin_tenant_domain_mappings_delete_confirm())) return;
		deletingId = id;
		try {
			await apiFetch(`/api/admin/platform/tenant-domain-mappings/${id}`, { method: 'DELETE' });
			mappings = mappings.filter((m) => m.id !== id);
			successMessage = $LL.admin_tenant_domain_mappings_delete_success();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_tenant_domain_mappings_delete_failed();
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

<svelte:head>
	<title>{$LL.admin_tenant_domain_mappings_head_title()}</title>
</svelte:head>

{#snippet pageActions()}
	<button class="btn btn-primary" onclick={openCreateDialog}>
		<i class="i-ph-plus"></i>
		{$LL.admin_tenant_domain_mappings_add()}
	</button>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_tenant_domain_mappings_title()}
		description={$LL.admin_tenant_domain_mappings_description()}
		eyebrow={$LL.admin_tenant_domain_mappings_platform()}
		actions={pageActions}
	/>

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
			<strong>{$LL.admin_tenant_domain_mappings_how_it_works_label()}</strong>
			{$LL.admin_tenant_domain_mappings_how_it_works({
				email: 'user@company.com',
				domain: 'company.com',
				tenant: 'acme'
			})}
		</div>
	</div>

	<AdminSection>
		{#if loading}
			<div class="loading-state">
				<i class="i-ph-circle-notch animate-spin"></i>
				{$LL.admin_tenant_domain_mappings_loading()}
			</div>
		{:else if mappings.length === 0}
			<div class="empty-state">
				<i class="i-ph-globe"></i>
				<p>{$LL.admin_tenant_domain_mappings_empty()}</p>
			</div>
		{:else}
			<div class="mapping-table">
				<AdminDataTable>
					<thead>
						<tr>
							<th>{$LL.admin_tenant_domain_mappings_tenant()}</th>
							<th>{$LL.admin_tenant_domain_mappings_priority()}</th>
							<th>{$LL.admin_tenant_domain_mappings_status()}</th>
							<th>{$LL.admin_tenant_domain_mappings_verified()}</th>
							<th>{$LL.admin_tenant_domain_mappings_created()}</th>
							<th>{$LL.admin_tenant_domain_mappings_actions()}</th>
						</tr>
					</thead>
					<tbody>
						{#each mappings as mapping (mapping.id)}
							<tr>
								<td class="mono">{mapping.tenant_id}</td>
								<td>{mapping.priority}</td>
								<td>
									{#if mapping.is_active}
										<span class="badge badge-active"
											>{$LL.admin_tenant_domain_mappings_active()}</span
										>
									{:else}
										<span class="badge badge-inactive"
											>{$LL.admin_tenant_domain_mappings_inactive()}</span
										>
									{/if}
								</td>
								<td>
									{#if mapping.verified}
										<span class="badge badge-verified">
											<i class="i-ph-check"></i>
											{$LL.admin_tenant_domain_mappings_verified()}
										</span>
									{:else}
										<span class="badge badge-unverified">
											{$LL.admin_tenant_domain_mappings_unverified()}
										</span>
									{/if}
								</td>
								<td>{formatDate(mapping.created_at)}</td>
								<td class="actions">
									{#if !mapping.verified}
										<button
											class="btn btn-sm btn-secondary"
											onclick={() => openVerifyDialog(mapping)}
										>
											{$LL.admin_tenant_domain_mappings_verify_dns()}
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
											{$LL.admin_tenant_domain_mappings_delete()}
										{/if}
									</button>
								</td>
							</tr>
						{/each}
					</tbody>
				</AdminDataTable>
			</div>

			<div class="mapping-cards">
				{#each mappings as mapping (mapping.id)}
					<article class="mapping-card">
						<div class="mapping-card__header">
							<div>
								<p class="mapping-card__label">{$LL.admin_tenant_domain_mappings_tenant()}</p>
								<p class="mapping-card__title">{mapping.tenant_id}</p>
							</div>
							<div class="mapping-card__badges">
								{#if mapping.is_active}
									<span class="badge badge-active">{$LL.admin_tenant_domain_mappings_active()}</span
									>
								{:else}
									<span class="badge badge-inactive"
										>{$LL.admin_tenant_domain_mappings_inactive()}</span
									>
								{/if}
								{#if mapping.verified}
									<span class="badge badge-verified">
										<i class="i-ph-check"></i>
										{$LL.admin_tenant_domain_mappings_verified()}
									</span>
								{:else}
									<span class="badge badge-unverified">
										{$LL.admin_tenant_domain_mappings_unverified()}
									</span>
								{/if}
							</div>
						</div>
						<dl class="mapping-card__meta">
							<div>
								<dt>{$LL.admin_tenant_domain_mappings_priority()}</dt>
								<dd>{mapping.priority}</dd>
							</div>
							<div>
								<dt>{$LL.admin_tenant_domain_mappings_created()}</dt>
								<dd>{formatDate(mapping.created_at)}</dd>
							</div>
						</dl>
						<div class="mapping-card__actions">
							{#if !mapping.verified}
								<button class="btn btn-secondary" onclick={() => openVerifyDialog(mapping)}>
									{$LL.admin_tenant_domain_mappings_verify_dns()}
								</button>
							{/if}
							<button
								class="btn btn-danger-outline"
								disabled={deletingId === mapping.id}
								onclick={() => handleDelete(mapping.id)}
							>
								{deletingId === mapping.id
									? $LL.admin_tenant_domain_mappings_deleting()
									: $LL.admin_tenant_domain_mappings_delete()}
							</button>
						</div>
					</article>
				{/each}
			</div>
		{/if}
	</AdminSection>
</AdminPageShell>

<!-- Create Dialog -->
<Modal
	open={showCreateDialog}
	onClose={() => (showCreateDialog = false)}
	title={$LL.admin_tenant_domain_mappings_add_title()}
>
	{#if createError}
		<div class="alert alert-error">{createError}</div>
	{/if}
	<div class="form-group">
		<label for="new-domain" class="form-label">
			{$LL.admin_tenant_domain_mappings_domain()} <span class="required">*</span>
		</label>
		<input
			id="new-domain"
			type="text"
			class="form-input"
			bind:value={newDomain}
			placeholder={$LL.admin_tenant_domain_mappings_domain_placeholder()}
			autocomplete="off"
		/>
		<p class="field-hint">
			{$LL.admin_tenant_domain_mappings_domain_hint()}
		</p>
	</div>
	<div class="form-group">
		<label for="new-tenant" class="form-label">
			{$LL.admin_tenant_domain_mappings_tenant_id()} <span class="required">*</span>
		</label>
		<input
			id="new-tenant"
			type="text"
			class="form-input"
			bind:value={newTenantId}
			placeholder={$LL.admin_tenant_domain_mappings_tenant_placeholder()}
			autocomplete="off"
		/>
	</div>
	<div class="form-group">
		<label for="new-priority" class="form-label">
			{$LL.admin_tenant_domain_mappings_priority()}
		</label>
		<input
			id="new-priority"
			type="number"
			class="form-input"
			bind:value={newPriority}
			min="0"
			max="1000"
		/>
		<p class="field-hint">{$LL.admin_tenant_domain_mappings_priority_hint()}</p>
	</div>

	{#snippet footer()}
		<button
			class="btn btn-secondary"
			onclick={() => (showCreateDialog = false)}
			disabled={creating}
		>
			{$LL.admin_tenant_domain_mappings_cancel()}
		</button>
		<button class="btn btn-primary" onclick={handleCreate} disabled={creating}>
			{#if creating}
				<i class="i-ph-circle-notch animate-spin"></i>
				{$LL.admin_tenant_domain_mappings_creating()}
			{:else}
				{$LL.admin_tenant_domain_mappings_create()}
			{/if}
		</button>
	{/snippet}
</Modal>

<!-- Verify Dialog -->
<Modal
	open={showVerifyDialog && !!verifyingMapping}
	onClose={() => (showVerifyDialog = false)}
	title={$LL.admin_tenant_domain_mappings_verify_title()}
	size="lg"
>
	{#if verifyingMapping}
		{#if verifyError}
			<div class="alert alert-error">{verifyError}</div>
		{/if}
		<p class="verify-intro">
			{$LL.admin_tenant_domain_mappings_verify_intro({ tenant: verifyingMapping.tenant_id })}
		</p>
		<div class="form-group">
			<label for="verify-domain" class="form-label">
				{$LL.admin_tenant_domain_mappings_domain()} <span class="required">*</span>
			</label>
			<input
				id="verify-domain"
				type="text"
				class="form-input"
				bind:value={verifyDomain}
				placeholder={$LL.admin_tenant_domain_mappings_domain_placeholder()}
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
					{$LL.admin_tenant_domain_mappings_generating()}
				{:else}
					{$LL.admin_tenant_domain_mappings_generate_dns()}
				{/if}
			</button>
		{:else}
			<div class="dns-record">
				<p class="dns-record-title">{$LL.admin_tenant_domain_mappings_dns_title()}</p>
				<div class="dns-row">
					<span class="dns-label">{$LL.admin_tenant_domain_mappings_dns_type()}</span>
					<code class="dns-value">{verifyDnsRecord.type}</code>
				</div>
				<div class="dns-row">
					<span class="dns-label">{$LL.admin_tenant_domain_mappings_dns_name()}</span>
					<code class="dns-value">{verifyDnsRecord.name}</code>
				</div>
				<div class="dns-row">
					<span class="dns-label">{$LL.admin_tenant_domain_mappings_dns_value()}</span>
					<code class="dns-value dns-value-long">{verifyDnsRecord.value}</code>
				</div>
				<p class="field-hint">{$LL.admin_tenant_domain_mappings_dns_hint()}</p>
			</div>
			<button
				class="btn btn-primary"
				onclick={handleConfirmVerification}
				disabled={confirmingVerification}
			>
				{#if confirmingVerification}
					<i class="i-ph-circle-notch animate-spin"></i>
					{$LL.admin_tenant_domain_mappings_checking_dns()}
				{:else}
					{$LL.admin_tenant_domain_mappings_confirm_verify()}
				{/if}
			</button>
		{/if}
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={() => (showVerifyDialog = false)}>
			{$LL.admin_tenant_domain_mappings_close()}
		</button>
	{/snippet}
</Modal>

<style>
	.info-box {
		display: flex;
		gap: 12px;
		padding: 14px 16px;
		background: color-mix(in srgb, var(--color-accent) 10%, var(--color-surface));
		border: 1px solid color-mix(in srgb, var(--color-accent) 28%, var(--color-border));
		border-radius: var(--radius-panel);
		font-size: 0.875rem;
		color: var(--color-text-muted);
	}

	.info-box :global(i) {
		width: 18px;
		height: 18px;
		color: var(--color-accent);
		flex-shrink: 0;
		margin-top: 1px;
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
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.badge-inactive {
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
	}

	.badge-verified {
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.badge-unverified {
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
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
		border-radius: var(--radius-control);
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
		background: var(--color-accent);
		color: var(--color-accent-contrast);
	}

	.btn-primary:hover:not(:disabled) {
		filter: brightness(0.96);
	}

	.btn-secondary {
		background: var(--color-surface);
		color: var(--color-text);
		border: 1px solid var(--color-border);
	}

	.btn-secondary:hover:not(:disabled) {
		background: var(--color-surface-muted);
	}

	.btn-danger-outline {
		background: transparent;
		color: var(--color-danger);
		border: 1px solid color-mix(in srgb, var(--color-danger) 52%, var(--color-border));
	}

	.btn-danger-outline:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
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
		border-radius: var(--radius-panel);
		font-size: 0.875rem;
		margin-bottom: 16px;
	}

	.alert :global(i) {
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		margin-top: 1px;
	}

	.alert-error {
		background: color-mix(in srgb, var(--color-danger) 12%, var(--color-surface));
		color: var(--color-danger);
		border: 1px solid color-mix(in srgb, var(--color-danger) 42%, var(--color-border));
	}

	.alert-success {
		background: color-mix(in srgb, var(--color-success) 12%, var(--color-surface));
		color: var(--color-success);
		border: 1px solid color-mix(in srgb, var(--color-success) 42%, var(--color-border));
	}

	/* Loading / Empty */
	.loading-state,
	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		padding: 48px;
		color: var(--color-text-muted);
		font-size: 0.875rem;
	}

	.loading-state :global(i),
	.empty-state :global(i) {
		width: 32px;
		height: 32px;
	}

	/* Form */
	.form-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-bottom: 16px;
	}

	.form-label {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text);
	}

	.required {
		color: var(--color-danger);
	}

	.form-input {
		padding: 8px 12px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		background: var(--color-surface);
		color: var(--color-text);
		font-size: 0.875rem;
		font-family: var(--font-body);
		transition: border-color var(--transition-fast);
		outline: none;
		width: 100%;
		box-sizing: border-box;
	}

	.form-input:focus {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
	}

	.field-hint {
		font-size: 0.75rem;
		color: var(--color-text-muted);
		margin: 0;
	}

	/* DNS record display */
	.verify-intro {
		font-size: 0.875rem;
		color: var(--color-text-muted);
		margin: 0;
	}

	.dns-record {
		background: var(--color-surface-muted);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		padding: 16px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.dns-record-title {
		font-size: 0.875rem;
		font-weight: 500;
		color: var(--color-text);
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
		color: var(--color-text-muted);
		min-width: 48px;
	}

	.dns-value {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		background: var(--color-surface);
		padding: 4px 8px;
		border-radius: var(--radius-control);
		border: 1px solid var(--color-border);
		color: var(--color-text);
		word-break: break-all;
	}

	.dns-value-long {
		font-size: 0.75rem;
	}

	.mapping-cards {
		display: none;
	}

	.mapping-card {
		display: grid;
		gap: 16px;
		padding: 16px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
	}

	.mapping-card__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}

	.mapping-card__label,
	.mapping-card__meta dt {
		margin: 0;
		color: var(--color-text-muted);
		font-family: var(--font-meta, var(--font-body));
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.mapping-card__title {
		margin: 4px 0 0;
		color: var(--color-text);
		font-family: var(--font-mono);
		font-weight: 700;
		overflow-wrap: anywhere;
	}

	.mapping-card__badges {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 6px;
	}

	.mapping-card__meta {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 12px;
		margin: 0;
	}

	.mapping-card__meta div {
		display: grid;
		gap: 3px;
	}

	.mapping-card__meta dd {
		margin: 0;
		color: var(--color-text);
	}

	.mapping-card__actions {
		display: grid;
		gap: 8px;
	}

	@media (max-width: 720px) {
		.mapping-table {
			display: none;
		}

		.mapping-cards {
			display: grid;
			gap: 14px;
		}

		.info-box {
			align-items: flex-start;
		}

		.dns-row {
			align-items: stretch;
			flex-direction: column;
			gap: 4px;
		}
	}
</style>
