<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { API_BASE_URL, adminFetch } from '$lib/api/admin-request';
	import { LL } from '$i18n/i18n-svelte';

	// ==========================================================================
	// Types
	// ==========================================================================

	interface TenantInvitation {
		id: string;
		tenant_id: string;
		invited_email: string | null;
		invited_by: string;
		role_id: string | null;
		org_id: string | null;
		max_uses: number;
		use_count: number;
		expires_at: number;
		created_at: number;
		updated_at: number;
	}

	interface CreateResult {
		id: string;
		invite_url: string;
		token: string;
		expires_at: number;
		email_sent: boolean;
	}

	// ==========================================================================
	// State
	// ==========================================================================

	const tenantId = $derived($page.params.id);

	let invitations = $state<TenantInvitation[]>([]);
	let loading = $state(true);
	let error = $state('');
	let successMessage = $state('');

	// Create dialog
	let showCreateDialog = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let newInvitedEmail = $state('');
	let newRoleId = $state('');
	let newOrgId = $state('');
	let newMaxUses = $state(1);
	let newExpiresInHours = $state(72);

	// Created result dialog
	let showResultDialog = $state(false);
	let createResult = $state<CreateResult | null>(null);
	let copySuccess = $state(false);

	// Cancel confirm
	let cancellingId = $state('');

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
			const data = await response.json().catch(() => ({}));
			throw new Error(
				(data as { error?: string; message?: string }).message ||
					$LL.admin_tenants_request_failed({ status: response.status })
			);
		}
		return response.json();
	}

	async function loadInvitations() {
		loading = true;
		error = '';
		try {
			const data = await apiFetch(
				`/api/admin/tenants/${tenantId}/invitations?include_expired=false`
			);
			invitations = data.items ?? [];
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_tenants_load_invitations_failed();
		} finally {
			loading = false;
		}
	}

	async function handleCreate() {
		creating = true;
		createError = '';
		try {
			const body: Record<string, unknown> = {
				max_uses: newMaxUses,
				expires_in_hours: newExpiresInHours
			};
			if (newInvitedEmail) body.invited_email = newInvitedEmail;
			if (newRoleId) body.role_id = newRoleId;
			if (newOrgId) body.org_id = newOrgId;

			const result = await apiFetch(`/api/admin/tenants/${tenantId}/invitations`, {
				method: 'POST',
				body: JSON.stringify(body)
			});

			createResult = result as CreateResult;
			showCreateDialog = false;
			showResultDialog = true;
			resetCreateForm();
			await loadInvitations();
		} catch (err) {
			createError =
				err instanceof Error ? err.message : $LL.admin_tenants_create_invitation_failed();
		} finally {
			creating = false;
		}
	}

	async function handleCancel(inv: TenantInvitation) {
		if (cancellingId) return;
		if (!confirm($LL.admin_tenants_cancel_invitation_confirm())) return;
		cancellingId = inv.id;
		try {
			await apiFetch(`/api/admin/tenants/${tenantId}/invitations/${inv.id}`, {
				method: 'DELETE'
			});
			successMessage = $LL.admin_tenants_invitation_cancelled();
			invitations = invitations.filter((i) => i.id !== inv.id);
			setTimeout(() => (successMessage = ''), 4000);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_tenants_cancel_invitation_failed();
		} finally {
			cancellingId = '';
		}
	}

	async function copyToClipboard(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copySuccess = true;
			setTimeout(() => (copySuccess = false), 2000);
		} catch {
			// Fallback
			const el = document.createElement('textarea');
			el.value = text;
			document.body.appendChild(el);
			el.select();
			document.execCommand('copy');
			document.body.removeChild(el);
			copySuccess = true;
			setTimeout(() => (copySuccess = false), 2000);
		}
	}

	function resetCreateForm() {
		newInvitedEmail = '';
		newRoleId = '';
		newOrgId = '';
		newMaxUses = 1;
		newExpiresInHours = 72;
		createError = '';
	}

	// ==========================================================================
	// Helpers
	// ==========================================================================

	function formatDate(ts: number) {
		return new Date(ts * 1000).toLocaleString();
	}

	function isExpired(inv: TenantInvitation) {
		return inv.expires_at < Math.floor(Date.now() / 1000);
	}

	function isExhausted(inv: TenantInvitation) {
		return inv.max_uses !== -1 && inv.use_count >= inv.max_uses;
	}

	// ==========================================================================
	// Lifecycle
	// ==========================================================================

	onMount(() => {
		loadInvitations();
	});
</script>

<div class="page-container">
	<div class="page-header">
		<div>
			<a href="/admin/tenants" class="back-link">← {$LL.admin_tenants_title()}</a>
			<h1 class="page-title">{$LL.admin_tenants_invitations_title()}</h1>
			<p class="page-subtitle">{$LL.admin_tenants_invitations_description()}</p>
		</div>
		<button class="btn btn-primary" onclick={() => (showCreateDialog = true)}>
			+ {$LL.admin_tenants_create_invitation()}
		</button>
	</div>

	{#if successMessage}
		<div class="alert alert-success">{successMessage}</div>
	{/if}
	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	<!-- Invitations Table -->
	<div class="card">
		{#if loading}
			<div class="loading-state">{$LL.admin_tenants_loading_invitations()}</div>
		{:else if invitations.length === 0}
			<div class="empty-state">
				<p>{$LL.admin_tenants_no_active_invitations()}</p>
			</div>
		{:else}
			<table class="data-table">
				<thead>
					<tr>
						<th>{$LL.admin_tenants_email()}</th>
						<th>{$LL.admin_tenants_role()}</th>
						<th>{$LL.admin_tenants_org()}</th>
						<th>{$LL.admin_tenants_uses()}</th>
						<th>{$LL.admin_tenants_expires()}</th>
						<th>{$LL.admin_tenants_status()}</th>
						<th>{$LL.admin_tenants_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each invitations as inv (inv.id)}
						<tr>
							<td>
								{#if inv.invited_email}
									{inv.invited_email}
								{:else}
									<span class="text-muted">{$LL.admin_tenants_anyone()}</span>
								{/if}
							</td>
							<td>{inv.role_id ?? '—'}</td>
							<td>{inv.org_id ?? '—'}</td>
							<td>{inv.use_count} / {inv.max_uses === -1 ? '∞' : inv.max_uses}</td>
							<td>{formatDate(inv.expires_at)}</td>
							<td>
								{#if isExpired(inv)}
									<span class="badge badge-expired">{$LL.admin_tenants_expired()}</span>
								{:else if isExhausted(inv)}
									<span class="badge badge-exhausted">{$LL.admin_tenants_exhausted()}</span>
								{:else}
									<span class="badge badge-active">{$LL.admin_tenants_active()}</span>
								{/if}
							</td>
							<td>
								<button
									class="btn-icon btn-icon-danger"
									disabled={cancellingId === inv.id}
									onclick={() => handleCancel(inv)}
									title={$LL.admin_tenants_cancel_invitation_title()}
								>
									✕
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>
</div>

<!-- Create Invitation Dialog -->
{#if showCreateDialog}
	<div
		class="dialog-overlay"
		role="dialog"
		aria-modal="true"
		aria-label={$LL.admin_tenants_create_invitation_aria()}
	>
		<div class="dialog">
			<div class="dialog-header">
				<h2>{$LL.admin_tenants_create_invitation()}</h2>
				<button
					class="dialog-close"
					onclick={() => {
						showCreateDialog = false;
						resetCreateForm();
					}}>✕</button
				>
			</div>
			<div class="dialog-body">
				{#if createError}
					<div class="alert alert-error">{createError}</div>
				{/if}

				<div class="form-field">
					<label for="invited-email">{$LL.admin_tenants_invited_email()}</label>
					<input
						id="invited-email"
						type="email"
						bind:value={newInvitedEmail}
						placeholder={$LL.admin_tenants_invited_email_placeholder()}
						class="form-input"
					/>
					<p class="form-hint">{$LL.admin_tenants_invited_email_hint()}</p>
				</div>

				<div class="form-field">
					<label for="role-id">{$LL.admin_tenants_auto_role()}</label>
					<input
						id="role-id"
						type="text"
						bind:value={newRoleId}
						placeholder="role_id"
						class="form-input"
					/>
				</div>

				<div class="form-field">
					<label for="org-id">{$LL.admin_tenants_auto_org()}</label>
					<input
						id="org-id"
						type="text"
						bind:value={newOrgId}
						placeholder="org_id"
						class="form-input"
					/>
				</div>

				<div class="form-row">
					<div class="form-field">
						<label for="max-uses">{$LL.admin_tenants_max_uses()}</label>
						<input
							id="max-uses"
							type="number"
							bind:value={newMaxUses}
							min="-1"
							max="1000"
							class="form-input"
						/>
						<p class="form-hint">{$LL.admin_tenants_max_uses_hint()}</p>
					</div>
					<div class="form-field">
						<label for="expires-hours">{$LL.admin_tenants_expires_in_hours()}</label>
						<input
							id="expires-hours"
							type="number"
							bind:value={newExpiresInHours}
							min="1"
							max="720"
							class="form-input"
						/>
					</div>
				</div>
			</div>
			<div class="dialog-footer">
				<button
					class="btn btn-secondary"
					onclick={() => {
						showCreateDialog = false;
						resetCreateForm();
					}}>{$LL.admin_tenants_cancel()}</button
				>
				<button class="btn btn-primary" onclick={handleCreate} disabled={creating}>
					{creating ? $LL.admin_tenants_creating() : $LL.admin_tenants_create_invitation()}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Result Dialog (show invite URL) -->
{#if showResultDialog && createResult}
	<div
		class="dialog-overlay"
		role="dialog"
		aria-modal="true"
		aria-label={$LL.admin_tenants_invitation_created()}
	>
		<div class="dialog">
			<div class="dialog-header">
				<h2>{$LL.admin_tenants_invitation_created()}</h2>
				<button class="dialog-close" onclick={() => (showResultDialog = false)}>✕</button>
			</div>
			<div class="dialog-body">
				{#if !createResult.email_sent}
					<div class="alert alert-warning">
						{$LL.admin_tenants_email_not_sent()}
					</div>
				{:else}
					<div class="alert alert-success">{$LL.admin_tenants_email_sent()}</div>
				{/if}

				<div class="form-field">
					<label for="invite-url-field">{$LL.admin_tenants_invitation_url()}</label>
					<div class="url-copy-row">
						<input
							id="invite-url-field"
							type="text"
							readonly
							value={createResult.invite_url}
							class="form-input url-input"
						/>
						<button
							class="btn btn-secondary"
							onclick={() => copyToClipboard(createResult!.invite_url)}
						>
							{copySuccess ? $LL.admin_tenants_copied() : $LL.admin_tenants_copy()}
						</button>
					</div>
				</div>

				<p class="expires-note">
					{$LL.admin_tenants_expires_at({ date: formatDate(createResult.expires_at) })}
				</p>
			</div>
			<div class="dialog-footer">
				<button class="btn btn-primary" onclick={() => (showResultDialog = false)}
					>{$LL.admin_tenants_done()}</button
				>
			</div>
		</div>
	</div>
{/if}

<style>
	.page-container {
		max-width: 1000px;
		margin: 0 auto;
		padding: 1.5rem;
	}

	.page-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		margin-bottom: 1.5rem;
	}

	.back-link {
		font-size: 0.85rem;
		color: var(--text-muted, #6b7280);
		text-decoration: none;
		display: block;
		margin-bottom: 0.25rem;
	}

	.back-link:hover {
		color: var(--primary, #4f46e5);
	}

	.page-title {
		font-size: 1.5rem;
		font-weight: 700;
		margin: 0 0 0.25rem;
	}

	.page-subtitle {
		color: var(--text-muted, #6b7280);
		font-size: 0.875rem;
		margin: 0;
	}

	.card {
		background: var(--card-bg, #fff);
		border: 1px solid var(--border, #e5e7eb);
		border-radius: 0.5rem;
		overflow: hidden;
	}

	.loading-state,
	.empty-state {
		padding: 3rem;
		text-align: center;
		color: var(--text-muted, #6b7280);
	}

	.data-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.875rem;
	}

	.data-table th {
		padding: 0.75rem 1rem;
		text-align: left;
		font-weight: 600;
		background: var(--table-header-bg, #f9fafb);
		border-bottom: 1px solid var(--border, #e5e7eb);
		white-space: nowrap;
	}

	.data-table td {
		padding: 0.75rem 1rem;
		border-bottom: 1px solid var(--border-light, #f3f4f6);
		vertical-align: middle;
	}

	.text-muted {
		color: var(--text-muted, #9ca3af);
		font-style: italic;
	}

	.badge {
		display: inline-flex;
		align-items: center;
		padding: 0.2rem 0.6rem;
		border-radius: 9999px;
		font-size: 0.75rem;
		font-weight: 600;
	}

	.badge-active {
		background: var(--color-success-bg, #dcfce7);
		color: var(--color-success, #16a34a);
	}

	.badge-expired,
	.badge-exhausted {
		background: var(--color-warning-bg, #fef3c7);
		color: var(--color-warning, #d97706);
	}

	.btn {
		padding: 0.5rem 1rem;
		border-radius: 0.375rem;
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		border: none;
		transition: opacity 0.15s;
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-primary {
		background: var(--primary, #4f46e5);
		color: #fff;
	}

	.btn-primary:hover:not(:disabled) {
		opacity: 0.9;
	}

	.btn-secondary {
		background: var(--card-bg, #fff);
		color: var(--text, #111827);
		border: 1px solid var(--border, #e5e7eb);
	}

	.btn-secondary:hover:not(:disabled) {
		background: var(--hover-bg, #f3f4f6);
	}

	.btn-icon {
		width: 2rem;
		height: 2rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 0.375rem;
		border: none;
		cursor: pointer;
		font-size: 0.875rem;
	}

	.btn-icon-danger {
		background: transparent;
		color: var(--color-error, #dc2626);
	}

	.btn-icon-danger:hover:not(:disabled) {
		background: var(--color-error-bg, #fee2e2);
	}

	.alert {
		padding: 0.75rem 1rem;
		border-radius: 0.375rem;
		font-size: 0.875rem;
		margin-bottom: 1rem;
	}

	.alert-success {
		background: var(--color-success-bg, #dcfce7);
		color: var(--color-success, #16a34a);
	}

	.alert-error {
		background: var(--color-error-bg, #fee2e2);
		color: var(--color-error, #dc2626);
	}

	.alert-warning {
		background: var(--color-warning-bg, #fef3c7);
		color: var(--color-warning, #d97706);
	}

	/* Dialog */
	.dialog-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.dialog {
		background: var(--card-bg, #fff);
		border-radius: 0.5rem;
		width: 100%;
		max-width: 500px;
		margin: 1rem;
		box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
	}

	.dialog-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1.25rem 1.5rem;
		border-bottom: 1px solid var(--border, #e5e7eb);
	}

	.dialog-header h2 {
		font-size: 1.1rem;
		font-weight: 600;
		margin: 0;
	}

	.dialog-close {
		background: none;
		border: none;
		cursor: pointer;
		color: var(--text-muted, #6b7280);
		font-size: 1.1rem;
		padding: 0.25rem;
	}

	.dialog-body {
		padding: 1.5rem;
	}

	.dialog-footer {
		display: flex;
		justify-content: flex-end;
		gap: 0.75rem;
		padding: 1rem 1.5rem;
		border-top: 1px solid var(--border, #e5e7eb);
	}

	.form-field {
		margin-bottom: 1rem;
	}

	.form-field label {
		display: block;
		font-size: 0.875rem;
		font-weight: 500;
		margin-bottom: 0.375rem;
	}

	.form-input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border, #d1d5db);
		border-radius: 0.375rem;
		font-size: 0.875rem;
		background: var(--input-bg, #fff);
		color: var(--text, #111827);
		box-sizing: border-box;
	}

	.form-hint {
		font-size: 0.75rem;
		color: var(--text-muted, #6b7280);
		margin-top: 0.25rem;
	}

	.form-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}

	.url-copy-row {
		display: flex;
		gap: 0.5rem;
	}

	.url-input {
		flex: 1;
		min-width: 0;
	}

	.expires-note {
		font-size: 0.8rem;
		color: var(--text-muted, #6b7280);
		margin-top: 0.75rem;
	}
</style>
