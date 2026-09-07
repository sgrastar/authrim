<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { adminAdminsAPI, type AdminUser, type AdminUserListParams } from '$lib/api/admin-admins';
	import {
		adminInvitationsAPI,
		AdminInvitationDeliveryError,
		type AdminInvitation
	} from '$lib/api/admin-invitations';
	import { adminAdminRolesAPI, type AdminRole } from '$lib/api/admin-admin-roles';
	import { adminAuth } from '$lib/stores/admin-auth.svelte';
	import { Modal } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';
	import AdminDataTable from '$lib/components/admin/AdminDataTable.svelte';
	import AdminPageHeader from '$lib/components/admin/AdminPageHeader.svelte';
	import AdminPageShell from '$lib/components/admin/AdminPageShell.svelte';
	import AdminPagination from '$lib/components/admin/AdminPagination.svelte';
	import AdminSection from '$lib/components/admin/AdminSection.svelte';
	import AdminToolbar from '$lib/components/admin/AdminToolbar.svelte';

	let admins: AdminUser[] = $state([]);
	let total = $state(0);
	let totalPages = $state(0);
	let loading = $state(true);
	let error = $state('');
	let invitationError = $state('');
	let invitations: AdminInvitation[] = $state([]);
	let availableRoles: AdminRole[] = $state([]);
	const canReadRoles = $derived(adminAuth.hasPermission('admin:admin_roles:read'));
	const canInviteAdmins = $derived(
		adminAuth.hasAllPermissions([
			'admin:admin_users:read',
			'admin:admin_users:write',
			'admin:admin_roles:read',
			'admin:admin_roles:write'
		])
	);
	const canManageInvitations = $derived(
		adminAuth.hasAllPermissions([
			'admin:admin_users:read',
			'admin:admin_users:write',
			'admin:admin_roles:write'
		])
	);

	// Search and filter state
	let searchQuery = $state('');
	let statusFilter = $state<'active' | 'suspended' | 'locked' | ''>('');
	let mfaFilter = $state<boolean | null>(null);
	let currentPage = $state(1);
	const limit = 20;

	// Create dialog state
	let showCreateDialog = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let newAdminEmail = $state('');
	let newAdminName = $state('');
	let newAdminRoleId = $state('');
	let ipRestrictionEnabled = $state(false);
	let allowedIpRanges: string[] = $state(['']);

	// Debounce timer for search
	let searchTimeout: ReturnType<typeof setTimeout>;

	async function loadAdmins() {
		loading = true;
		error = '';

		try {
			const params: AdminUserListParams = {
				page: currentPage,
				limit
			};

			if (searchQuery.trim()) {
				params.email = searchQuery.trim();
			}
			if (statusFilter) {
				params.status = statusFilter;
			}
			if (mfaFilter !== null) {
				params.mfa_enabled = mfaFilter;
			}

			const response = await adminAdminsAPI.list(params);
			admins = response.items;
			total = response.total;
			totalPages = response.totalPages;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_admins_load_failed();
		} finally {
			loading = false;
		}
	}

	async function loadInvitationsAndRoles() {
		invitationError = '';
		const [invitationResult, roleResult] = await Promise.allSettled([
			adminInvitationsAPI.list(),
			canReadRoles ? adminAdminRolesAPI.list() : Promise.resolve({ items: [], total: 0 })
		]);

		if (invitationResult.status === 'fulfilled') {
			invitations = invitationResult.value.items;
		} else {
			invitationError =
				invitationResult.reason instanceof Error
					? invitationResult.reason.message
					: $LL.admin_admins_invitations_load_failed();
		}

		if (roleResult.status === 'fulfilled') {
			availableRoles = roleResult.value.items;
			if (!newAdminRoleId && availableRoles.length > 0) {
				newAdminRoleId =
					availableRoles.find((role) => role.name === 'admin')?.id ?? availableRoles[0].id;
			}
		} else if (canReadRoles) {
			availableRoles = [];
			invitationError =
				roleResult.reason instanceof Error
					? roleResult.reason.message
					: $LL.admin_admins_invitations_load_failed();
		}
	}

	onMount(() => {
		loadAdmins();
		loadInvitationsAndRoles();
	});

	function handleSearch() {
		clearTimeout(searchTimeout);
		searchTimeout = setTimeout(() => {
			currentPage = 1;
			loadAdmins();
		}, 300);
	}

	function handleStatusChange() {
		currentPage = 1;
		loadAdmins();
	}

	function handleMfaChange(event: Event) {
		const target = event.target as HTMLSelectElement;
		if (target.value === '') {
			mfaFilter = null;
		} else {
			mfaFilter = target.value === 'true';
		}
		currentPage = 1;
		loadAdmins();
	}

	function goToPage(page: number) {
		currentPage = page;
		loadAdmins();
	}

	function formatDate(timestamp: number | null): string {
		if (!timestamp) return '-';
		return new Date(timestamp).toLocaleDateString(undefined);
	}

	function getStatusBadgeClass(status: string): string {
		switch (status) {
			case 'active':
				return 'badge badge-success';
			case 'suspended':
				return 'badge badge-warning';
			case 'locked':
				return 'badge badge-danger';
			default:
				return 'badge badge-neutral';
		}
	}

	function statusLabel(status: string): string {
		switch (status) {
			case 'active':
				return $LL.admin_admins_active();
			case 'suspended':
				return $LL.admin_admins_suspended();
			case 'locked':
				return $LL.admin_admins_locked();
			default:
				return status;
		}
	}

	function deliveryLabel(status: AdminInvitation['last_delivery_status']): string {
		switch (status) {
			case 'sent':
				return $LL.admin_admins_delivery_sent();
			case 'failed':
				return $LL.admin_admins_delivery_failed();
			default:
				return $LL.admin_admins_delivery_pending();
		}
	}

	function openCreateDialog() {
		newAdminEmail = '';
		newAdminName = '';
		newAdminRoleId =
			availableRoles.find((role) => role.name === 'admin')?.id ?? availableRoles[0]?.id ?? '';
		ipRestrictionEnabled = false;
		allowedIpRanges = [''];
		createError = '';
		showCreateDialog = true;
	}

	function closeCreateDialog() {
		showCreateDialog = false;
	}

	async function handleCreate() {
		if (!newAdminEmail.trim()) {
			createError = $LL.admin_admins_email_required();
			return;
		}
		if (!newAdminRoleId) {
			createError = $LL.admin_admins_role_required();
			return;
		}
		const ranges = allowedIpRanges.map((range) => range.trim()).filter(Boolean);
		if (ipRestrictionEnabled && ranges.length === 0) {
			createError = $LL.admin_admins_ip_range_required();
			return;
		}

		creating = true;
		createError = '';

		try {
			const role = availableRoles.find((candidate) => candidate.id === newAdminRoleId);
			await adminInvitationsAPI.create({
				email: newAdminEmail.trim(),
				name: newAdminName.trim() || undefined,
				role_id: newAdminRoleId,
				scope_type: role?.name === 'super_admin' ? 'global' : 'tenant',
				ip_restriction_enabled: ipRestrictionEnabled,
				allowed_ip_ranges: ranges
			});
			closeCreateDialog();
			await loadInvitationsAndRoles();
		} catch (err) {
			if (err instanceof AdminInvitationDeliveryError) {
				closeCreateDialog();
				await loadInvitationsAndRoles();
				alert(err.message);
			} else {
				createError = err instanceof Error ? err.message : $LL.admin_admins_create_failed();
			}
		} finally {
			creating = false;
		}
	}

	function addIpRange() {
		if (allowedIpRanges.length < 5) allowedIpRanges = [...allowedIpRanges, ''];
	}

	function updateIpRange(index: number, value: string) {
		allowedIpRanges = allowedIpRanges.map((range, rangeIndex) =>
			rangeIndex === index ? value : range
		);
	}

	function removeIpRange(index: number) {
		allowedIpRanges = allowedIpRanges.filter((_range, rangeIndex) => rangeIndex !== index);
		if (allowedIpRanges.length === 0) allowedIpRanges = [''];
	}

	async function handleResendInvitation(invitation: AdminInvitation) {
		try {
			await adminInvitationsAPI.resend(invitation.id);
			await loadInvitationsAndRoles();
		} catch (err) {
			alert(err instanceof Error ? err.message : $LL.admin_admins_invitation_resend_failed());
		}
	}

	async function handleRevokeInvitation(invitation: AdminInvitation) {
		if (!confirm($LL.admin_admins_invitation_revoke_confirm({ email: invitation.email }))) return;
		try {
			await adminInvitationsAPI.revoke(invitation.id);
			await loadInvitationsAndRoles();
		} catch (err) {
			alert(err instanceof Error ? err.message : $LL.admin_admins_invitation_revoke_failed());
		}
	}

	async function handleSuspend(admin: AdminUser) {
		if (!confirm($LL.admin_admins_suspend_confirm({ email: admin.email }))) return;

		try {
			await adminAdminsAPI.suspend(admin.id);
			loadAdmins();
		} catch (err) {
			alert(err instanceof Error ? err.message : $LL.admin_admins_suspend_failed());
		}
	}

	async function handleActivate(admin: AdminUser) {
		try {
			await adminAdminsAPI.activate(admin.id);
			loadAdmins();
		} catch (err) {
			alert(err instanceof Error ? err.message : $LL.admin_admins_activate_failed());
		}
	}

	async function handleUnlock(admin: AdminUser) {
		try {
			await adminAdminsAPI.unlock(admin.id);
			loadAdmins();
		} catch (err) {
			alert(err instanceof Error ? err.message : $LL.admin_admins_unlock_failed());
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_admins_head_title()}</title>
</svelte:head>

{#snippet headerActions()}
	{#if canInviteAdmins}
		<button class="btn btn-primary" onclick={openCreateDialog}>
			<i class="i-ph-plus"></i>
			{$LL.admin_admins_add()}
		</button>
	{/if}
{/snippet}

<AdminPageShell>
	<AdminPageHeader
		title={$LL.admin_admins_title()}
		description={$LL.admin_admins_description()}
		actions={headerActions}
	/>

	{#if invitations.length > 0 || invitationError}
		<AdminSection
			title={$LL.admin_admins_pending_invitations()}
			description={$LL.admin_admins_pending_invitations_description()}
		>
			{#if invitationError}
				<div class="alert alert-danger invitation-error" role="alert">
					<span>{invitationError}</span>
					<button class="btn btn-sm btn-secondary" onclick={loadInvitationsAndRoles}>
						{$LL.admin_admins_retry()}
					</button>
				</div>
			{/if}
			{#if invitations.length > 0}
				<AdminDataTable width="wide">
					<thead>
						<tr>
							<th>{$LL.admin_admins_email()}</th>
							<th>{$LL.admin_admins_role()}</th>
							<th>{$LL.admin_admins_invitation_ip_restriction()}</th>
							<th>{$LL.admin_admins_invitation_expires()}</th>
							<th>{$LL.admin_admins_invitation_delivery()}</th>
							<th class="text-right">{$LL.admin_admins_actions()}</th>
						</tr>
					</thead>
					<tbody>
						{#each invitations as invitation (invitation.id)}
							<tr>
								<td>
									<div>{invitation.email}</div>
									{#if invitation.name}<small>{invitation.name}</small>{/if}
								</td>
								<td>{invitation.role.display_name || invitation.role.name}</td>
								<td>
									{#if invitation.ip_restriction_enabled}
										<span class="badge badge-warning">
											{$LL.admin_admins_invitation_ip_ranges({
												count: invitation.allowed_ip_ranges.length
											})}
										</span>
									{:else}
										<span class="badge badge-neutral">{$LL.admin_admins_invitation_ip_off()}</span>
									{/if}
								</td>
								<td>{formatDate(invitation.expires_at)}</td>
								<td>
									<span
										class:badge-success={invitation.last_delivery_status === 'sent'}
										class:badge-danger={invitation.last_delivery_status === 'failed'}
										class="badge"
									>
										{deliveryLabel(invitation.last_delivery_status)}
									</span>
								</td>
								<td class="text-right">
									<div class="admin-row-actions">
										{#if canManageInvitations}
											<button
												class="btn btn-sm btn-secondary"
												onclick={() => handleResendInvitation(invitation)}
											>
												{$LL.admin_admins_invitation_resend()}
											</button>
											<button
												class="btn btn-sm btn-danger"
												onclick={() => handleRevokeInvitation(invitation)}
											>
												{$LL.admin_admins_invitation_revoke()}
											</button>
										{/if}
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</AdminDataTable>
			{/if}
		</AdminSection>
	{/if}

	<AdminToolbar>
		<div class="admin-field admin-field--search">
			<label for="admin-search" class="admin-field__label">{$LL.admin_admins_email()}</label>
			<input
				id="admin-search"
				type="text"
				class="admin-input"
				placeholder={$LL.admin_admins_search_placeholder()}
				bind:value={searchQuery}
				oninput={handleSearch}
			/>
		</div>

		<div class="admin-field admin-field--compact">
			<label for="admin-status" class="admin-field__label">{$LL.admin_admins_status()}</label>
			<select
				id="admin-status"
				class="admin-select"
				bind:value={statusFilter}
				onchange={handleStatusChange}
			>
				<option value="">{$LL.admin_admins_all_statuses()}</option>
				<option value="active">{$LL.admin_admins_active()}</option>
				<option value="suspended">{$LL.admin_admins_suspended()}</option>
				<option value="locked">{$LL.admin_admins_locked()}</option>
			</select>
		</div>

		<div class="admin-field admin-field--compact">
			<label for="admin-mfa" class="admin-field__label">{$LL.admin_admins_mfa()}</label>
			<select id="admin-mfa" class="admin-select" onchange={handleMfaChange}>
				<option value="">{$LL.admin_admins_all_mfa()}</option>
				<option value="true">{$LL.admin_admins_mfa_enabled()}</option>
				<option value="false">{$LL.admin_admins_mfa_disabled()}</option>
			</select>
		</div>
	</AdminToolbar>

	<!-- Content -->
	{#if loading}
		<div class="loading-state">
			<i class="i-ph-spinner loading-spinner"></i>
			<p>{$LL.admin_admins_loading()}</p>
		</div>
	{:else if error}
		<AdminSection>
			<div class="error-state">
				<p class="error-text">{error}</p>
				<button class="btn btn-secondary" onclick={loadAdmins}>{$LL.admin_admins_retry()}</button>
			</div>
		</AdminSection>
	{:else if admins.length === 0}
		<AdminSection>
			<div class="empty-state">
				<p>{$LL.admin_admins_empty()}</p>
				{#if searchQuery || statusFilter || mfaFilter !== null}
					<button
						class="btn btn-secondary"
						onclick={() => {
							searchQuery = '';
							statusFilter = '';
							mfaFilter = null;
							loadAdmins();
						}}
					>
						{$LL.admin_admins_clear_filters()}
					</button>
				{/if}
			</div>
		</AdminSection>
	{:else}
		<AdminSection>
			<AdminDataTable width="wide">
				<thead>
					<tr>
						<th>{$LL.admin_admins_email()}</th>
						<th>{$LL.admin_admins_name()}</th>
						<th>{$LL.admin_admins_status()}</th>
						<th>{$LL.admin_admins_mfa()}</th>
						<th>{$LL.admin_admins_last_login()}</th>
						<th>{$LL.admin_admins_created()}</th>
						<th class="text-right">{$LL.admin_admins_actions()}</th>
					</tr>
				</thead>
				<tbody>
					{#each admins as admin (admin.id)}
						<tr
							onclick={() => goto(`/admin/admins/${admin.id}`)}
							onkeydown={(e) => e.key === 'Enter' && goto(`/admin/admins/${admin.id}`)}
							tabindex="0"
							role="button"
						>
							<td>{admin.email}</td>
							<td>{admin.name || '-'}</td>
							<td>
								<span class={getStatusBadgeClass(admin.status)}>
									{statusLabel(admin.status)}
								</span>
							</td>
							<td>
								{#if admin.mfa_enabled}
									<span class="badge badge-success">{$LL.admin_admins_enabled()}</span>
								{:else}
									<span class="badge badge-neutral">{$LL.admin_admins_disabled()}</span>
								{/if}
							</td>
							<td>{formatDate(admin.last_login_at)}</td>
							<td>{formatDate(admin.created_at)}</td>
							<td class="text-right">
								<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
								<div
									class="admin-row-actions"
									onclick={(e) => e.stopPropagation()}
									onkeydown={(e) => e.stopPropagation()}
									role="group"
								>
									{#if admin.status === 'active'}
										<button
											class="btn btn-sm btn-warning"
											onclick={() => handleSuspend(admin)}
											title={$LL.admin_admins_suspend()}
										>
											{$LL.admin_admins_suspend()}
										</button>
									{:else if admin.status === 'suspended'}
										<button
											class="btn btn-sm btn-success"
											onclick={() => handleActivate(admin)}
											title={$LL.admin_admins_activate()}
										>
											{$LL.admin_admins_activate()}
										</button>
									{:else if admin.status === 'locked'}
										<button
											class="btn btn-sm btn-primary"
											onclick={() => handleUnlock(admin)}
											title={$LL.admin_admins_unlock()}
										>
											{$LL.admin_admins_unlock()}
										</button>
									{/if}
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</AdminDataTable>
		</AdminSection>

		<!-- Pagination -->
		{#if totalPages > 1}
			<AdminPagination
				label={$LL.admin_admins_title()}
				info={$LL.admin_admins_pagination({
					from: (currentPage - 1) * limit + 1,
					to: Math.min(currentPage * limit, total),
					total
				})}
				previousLabel={$LL.admin_admins_previous()}
				nextLabel={$LL.admin_admins_next()}
				hasPrevious={currentPage > 1}
				hasNext={currentPage < totalPages}
				onPrevious={() => goToPage(currentPage - 1)}
				onNext={() => goToPage(currentPage + 1)}
			/>
		{/if}
	{/if}
</AdminPageShell>

<!-- Invite Admin Dialog -->
<Modal
	open={showCreateDialog}
	onClose={closeCreateDialog}
	title={$LL.admin_admins_create_title()}
	size="md"
>
	{#if createError}
		<div class="alert alert-danger">{createError}</div>
	{/if}
	<div class="form-group">
		<label for="email">{$LL.admin_admins_email()} *</label>
		<input
			type="email"
			id="email"
			class="input"
			bind:value={newAdminEmail}
			placeholder={$LL.admin_admins_email_placeholder()}
		/>
	</div>
	<div class="form-group">
		<label for="admin-role">{$LL.admin_admins_role()} *</label>
		<select id="admin-role" class="input" bind:value={newAdminRoleId}>
			<option value="">{$LL.admin_admins_select_role_placeholder()}</option>
			{#each availableRoles as role (role.id)}
				<option value={role.id}>{role.display_name || role.name}</option>
			{/each}
		</select>
	</div>
	<div class="form-group invitation-ip-restriction">
		<label class="checkbox-label">
			<input type="checkbox" bind:checked={ipRestrictionEnabled} />
			<span>{$LL.admin_admins_invitation_limit_ip()}</span>
		</label>
		<p class="field-hint">{$LL.admin_admins_invitation_limit_ip_hint()}</p>
		{#if ipRestrictionEnabled}
			<div class="ip-range-list">
				{#each allowedIpRanges as range, index (`${index}-${allowedIpRanges.length}`)}
					<div class="ip-range-row">
						<input
							type="text"
							class="input"
							value={range}
							oninput={(event) => updateIpRange(index, event.currentTarget.value)}
							placeholder={$LL.admin_admins_invitation_ip_placeholder()}
						/>
						<button
							type="button"
							class="btn btn-sm btn-secondary"
							onclick={() => removeIpRange(index)}
							aria-label={$LL.admin_admins_invitation_remove_ip_range()}
						>
							<i class="i-ph-x"></i>
						</button>
					</div>
				{/each}
				{#if allowedIpRanges.length < 5}
					<button type="button" class="btn btn-sm btn-secondary" onclick={addIpRange}>
						{$LL.admin_admins_invitation_add_ip_range()}
					</button>
				{/if}
			</div>
		{/if}
	</div>
	<div class="form-group">
		<label for="name">{$LL.admin_admins_name()}</label>
		<input
			type="text"
			id="name"
			class="input"
			bind:value={newAdminName}
			placeholder={$LL.admin_admins_name_placeholder()}
		/>
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeCreateDialog} disabled={creating}>
			{$LL.admin_admins_cancel()}
		</button>
		<button class="btn btn-primary" onclick={handleCreate} disabled={creating}>
			{creating ? $LL.admin_admins_inviting() : $LL.admin_admins_invite()}
		</button>
	{/snippet}
</Modal>

<style>
	:global(.admin-data-table-wrap tr[role='button']) {
		cursor: pointer;
	}

	.admin-row-actions {
		display: inline-flex;
		gap: 8px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.error-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 48px 24px;
		text-align: center;
		color: var(--color-text-muted);
	}

	.error-text {
		color: var(--color-danger);
		margin-bottom: 1rem;
	}

	.alert-danger {
		background: color-mix(in srgb, var(--color-danger) 10%, var(--color-surface));
		border: 1px solid color-mix(in srgb, var(--color-danger) 28%, transparent);
		color: var(--color-danger);
	}

	.invitation-error {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-bottom: 1rem;
	}

	.checkbox-label {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		font-weight: 600;
	}

	.field-hint {
		margin: 0.35rem 0 0;
		color: var(--color-text-muted);
		font-size: 0.82rem;
	}

	.ip-range-list {
		display: grid;
		gap: 0.6rem;
		margin-top: 0.8rem;
	}

	.ip-range-row {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.5rem;
	}
</style>
