<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { API_BASE_URL, adminFetch } from '$lib/api/admin-request';
	import { Modal } from '$lib/components';
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection
	} from '$lib/components/admin';
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

{#snippet pageActions()}
	<button class="btn btn-primary" onclick={() => (showCreateDialog = true)}>
		<i class="i-ph-plus"></i>
		{$LL.admin_tenants_create_invitation()}
	</button>
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_tenants_invitations_title()}
		description={$LL.admin_tenants_invitations_description()}
		eyebrow={$LL.admin_tenants_title()}
		actions={pageActions}
	/>

	{#if successMessage}
		<div class="alert alert-success">{successMessage}</div>
	{/if}
	{#if error}
		<div class="alert alert-error">{error}</div>
	{/if}

	<!-- Invitations Table -->
	<AdminSection>
		{#if loading}
			<div class="loading-state">{$LL.admin_tenants_loading_invitations()}</div>
		{:else if invitations.length === 0}
			<div class="empty-state">
				<p>{$LL.admin_tenants_no_active_invitations()}</p>
			</div>
		{:else}
			<div class="invitation-table">
				<AdminDataTable>
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
				</AdminDataTable>
			</div>
			<div class="invitation-cards">
				{#each invitations as inv (inv.id)}
					<article class="invitation-card">
						<div class="invitation-card__header">
							<div>
								<p class="invitation-card__label">{$LL.admin_tenants_email()}</p>
								<p class="invitation-card__title">
									{#if inv.invited_email}
										{inv.invited_email}
									{:else}
										<span class="text-muted">{$LL.admin_tenants_anyone()}</span>
									{/if}
								</p>
							</div>
							{#if isExpired(inv)}
								<span class="badge badge-expired">{$LL.admin_tenants_expired()}</span>
							{:else if isExhausted(inv)}
								<span class="badge badge-exhausted">{$LL.admin_tenants_exhausted()}</span>
							{:else}
								<span class="badge badge-active">{$LL.admin_tenants_active()}</span>
							{/if}
						</div>
						<dl class="invitation-card__meta">
							<div>
								<dt>{$LL.admin_tenants_role()}</dt>
								<dd>{inv.role_id ?? '—'}</dd>
							</div>
							<div>
								<dt>{$LL.admin_tenants_org()}</dt>
								<dd>{inv.org_id ?? '—'}</dd>
							</div>
							<div>
								<dt>{$LL.admin_tenants_uses()}</dt>
								<dd>{inv.use_count} / {inv.max_uses === -1 ? '∞' : inv.max_uses}</dd>
							</div>
							<div>
								<dt>{$LL.admin_tenants_expires()}</dt>
								<dd>{formatDate(inv.expires_at)}</dd>
							</div>
						</dl>
						<button
							class="btn btn-secondary btn-mobile-danger"
							disabled={cancellingId === inv.id}
							onclick={() => handleCancel(inv)}
						>
							{$LL.admin_tenants_cancel_invitation_title()}
						</button>
					</article>
				{/each}
			</div>
		{/if}
	</AdminSection>
</AdminPageShell>

<!-- Create Invitation Dialog -->
<Modal
	open={showCreateDialog}
	onClose={() => {
		showCreateDialog = false;
		resetCreateForm();
	}}
	title={$LL.admin_tenants_create_invitation_aria()}
	size="md"
>
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
		<input id="org-id" type="text" bind:value={newOrgId} placeholder="org_id" class="form-input" />
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

	{#snippet footer()}
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
	{/snippet}
</Modal>

<!-- Result Dialog (show invite URL) -->
<Modal
	open={showResultDialog && !!createResult}
	onClose={() => (showResultDialog = false)}
	title={$LL.admin_tenants_invitation_created()}
	size="md"
>
	{#if createResult}
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
				<button class="btn btn-secondary" onclick={() => copyToClipboard(createResult!.invite_url)}>
					{copySuccess ? $LL.admin_tenants_copied() : $LL.admin_tenants_copy()}
				</button>
			</div>
		</div>

		<p class="expires-note">
			{$LL.admin_tenants_expires_at({ date: formatDate(createResult.expires_at) })}
		</p>
	{/if}

	{#snippet footer()}
		<button class="btn btn-primary" onclick={() => (showResultDialog = false)}
			>{$LL.admin_tenants_done()}</button
		>
	{/snippet}
</Modal>

<style>
	.loading-state,
	.empty-state {
		padding: 3rem;
		text-align: center;
		color: var(--color-text-muted);
	}

	.text-muted {
		color: var(--color-text-muted);
		font-style: italic;
	}

	.invitation-cards {
		display: none;
	}

	.invitation-card {
		display: grid;
		gap: 16px;
		padding: 16px;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-panel);
		background: var(--color-surface);
	}

	.invitation-card__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}

	.invitation-card__label,
	.invitation-card__meta dt {
		margin: 0;
		color: var(--color-text-muted);
		font-family: var(--font-meta, var(--font-body));
		font-size: 0.68rem;
		font-weight: 700;
		text-transform: uppercase;
	}

	.invitation-card__title {
		margin: 4px 0 0;
		color: var(--color-text);
		font-weight: 700;
		overflow-wrap: anywhere;
	}

	.invitation-card__meta {
		display: grid;
		gap: 12px;
		margin: 0;
	}

	.invitation-card__meta div {
		display: grid;
		gap: 3px;
	}

	.invitation-card__meta dd {
		margin: 0;
		color: var(--color-text);
		overflow-wrap: anywhere;
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
		background: color-mix(in srgb, var(--color-success) 14%, transparent);
		color: var(--color-success);
	}

	.badge-expired,
	.badge-exhausted {
		background: color-mix(in srgb, var(--color-warning) 14%, transparent);
		color: var(--color-warning);
	}

	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		padding: 0.5rem 1rem;
		border-radius: var(--radius-control);
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
		background: var(--color-accent);
		color: var(--color-accent-contrast);
	}

	.btn-primary:hover:not(:disabled) {
		opacity: 0.9;
	}

	.btn-secondary {
		background: var(--color-surface);
		color: var(--color-text);
		border: 1px solid var(--color-border);
	}

	.btn-secondary:hover:not(:disabled) {
		background: var(--color-surface-muted);
	}

	.btn-icon {
		width: 2rem;
		height: 2rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: var(--radius-control);
		border: none;
		cursor: pointer;
		font-size: 0.875rem;
	}

	.btn-icon-danger {
		background: transparent;
		color: var(--color-danger);
	}

	.btn-icon-danger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--color-danger) 10%, transparent);
	}

	.btn-mobile-danger {
		color: var(--color-danger);
	}

	.alert {
		padding: 0.75rem 1rem;
		border-radius: var(--radius-control);
		font-size: 0.875rem;
		margin-bottom: 1rem;
	}

	.alert-success {
		background: color-mix(in srgb, var(--color-success) 12%, var(--color-surface));
		color: var(--color-success);
		border: 1px solid color-mix(in srgb, var(--color-success) 42%, var(--color-border));
	}

	.alert-error {
		background: color-mix(in srgb, var(--color-danger) 12%, var(--color-surface));
		color: var(--color-danger);
		border: 1px solid color-mix(in srgb, var(--color-danger) 42%, var(--color-border));
	}

	.alert-warning {
		background: color-mix(in srgb, var(--color-warning) 14%, var(--color-surface));
		color: var(--color-warning);
		border: 1px solid color-mix(in srgb, var(--color-warning) 45%, var(--color-border));
	}

	.form-field {
		margin-bottom: 1rem;
	}

	.form-field label {
		display: block;
		font-size: 0.875rem;
		font-weight: 500;
		margin-bottom: 0.375rem;
		color: var(--color-text);
	}

	.form-input {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control);
		font-size: 0.875rem;
		background: var(--color-surface);
		color: var(--color-text);
		box-sizing: border-box;
	}

	.form-input:focus {
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-muted);
		outline: none;
	}

	.form-hint {
		font-size: 0.75rem;
		color: var(--color-text-muted);
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
		color: var(--color-text-muted);
		margin-top: 0.75rem;
	}

	@media (max-width: 640px) {
		.invitation-table {
			display: none;
		}

		.invitation-cards {
			display: grid;
			gap: 14px;
		}

		.form-row,
		.url-copy-row {
			display: flex;
			flex-direction: column;
		}

		.url-copy-row .btn {
			width: 100%;
		}
	}
</style>
