<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import {
		adminAdminsAPI,
		type AdminRoleAssignment,
		type AdminUserDetail,
		type UpdateAdminUserInput
	} from '$lib/api/admin-admins';
	import {
		adminAdminRolesAPI,
		type AdminRole,
		type AssignableAdminRoleScopeType
	} from '$lib/api/admin-admin-roles';
	import { Modal } from '$lib/components';
	import { LL } from '$i18n/i18n-svelte';

	let admin: AdminUserDetail | null = $state(null);
	let availableRoles: AdminRole[] = $state([]);
	let loading = $state(true);
	let error = $state('');

	// Edit state
	let isEditing = $state(false);
	let saving = $state(false);
	let editData: UpdateAdminUserInput = $state({});

	// Role assignment dialog
	let showRoleDialog = $state(false);
	let selectedRoleId = $state('');
	let selectedScopeType: AssignableAdminRoleScopeType = $state('tenant');
	let selectedScopeId = $state('');
	let selectedExpiresAt = $state('');
	let assigningRole = $state(false);
	let roleError = $state('');

	// Role assignment edit dialog
	let showAssignmentEditDialog = $state(false);
	let editingAssignment: AdminRoleAssignment | null = $state(null);
	let editScopeType: AssignableAdminRoleScopeType = $state('tenant');
	let editScopeId = $state('');
	let editExpiresAt = $state('');
	let savingAssignment = $state(false);
	let assignmentEditError = $state('');

	const adminId = $derived($page.params.id);

	async function loadAdmin() {
		if (!adminId) {
			error = $LL.admin_admins_id_required();
			loading = false;
			return;
		}

		loading = true;
		error = '';

		try {
			admin = await adminAdminsAPI.get(adminId);
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_admins_detail_load_failed();
		} finally {
			loading = false;
		}
	}

	async function loadRoles() {
		try {
			const response = await adminAdminRolesAPI.list();
			availableRoles = response.items;
		} catch {
			// Role assignment controls can still render without the role list.
		}
	}

	onMount(() => {
		loadAdmin();
		loadRoles();
	});

	function startEdit() {
		if (!admin) return;
		editData = {
			email: admin.email,
			name: admin.name || ''
		};
		isEditing = true;
	}

	function cancelEdit() {
		isEditing = false;
		editData = {};
	}

	async function saveEdit() {
		if (!admin) return;

		saving = true;
		try {
			await adminAdminsAPI.update(admin.id, editData);
			await loadAdmin();
			isEditing = false;
		} catch (err) {
			alert(err instanceof Error ? err.message : $LL.admin_admins_update_failed());
		} finally {
			saving = false;
		}
	}

	async function handleDelete() {
		if (!admin) return;
		const message = hasPlatformAdminRole(admin)
			? $LL.admin_admins_delete_platform_confirm({ email: admin.email })
			: $LL.admin_admins_delete_confirm({ email: admin.email });
		if (!confirm(message)) return;

		try {
			await adminAdminsAPI.delete(admin.id);
			goto('/admin/admins');
		} catch (err) {
			alert(err instanceof Error ? err.message : $LL.admin_admins_delete_failed());
		}
	}

	async function handleSuspend() {
		if (!admin) return;
		const message = hasPlatformAdminRole(admin)
			? $LL.admin_admins_suspend_platform_confirm({ email: admin.email })
			: $LL.admin_admins_suspend_confirm({ email: admin.email });
		if (!confirm(message)) return;

		try {
			await adminAdminsAPI.suspend(admin.id);
			await loadAdmin();
		} catch (err) {
			alert(err instanceof Error ? err.message : $LL.admin_admins_suspend_failed());
		}
	}

	async function handleActivate() {
		if (!admin) return;

		try {
			await adminAdminsAPI.activate(admin.id);
			await loadAdmin();
		} catch (err) {
			alert(err instanceof Error ? err.message : $LL.admin_admins_activate_failed());
		}
	}

	async function handleUnlock() {
		if (!admin) return;

		try {
			await adminAdminsAPI.unlock(admin.id);
			await loadAdmin();
		} catch (err) {
			alert(err instanceof Error ? err.message : $LL.admin_admins_unlock_failed());
		}
	}

	function openRoleDialog() {
		selectedRoleId = '';
		selectedScopeType = 'tenant';
		selectedScopeId = admin?.tenant_id || '';
		selectedExpiresAt = '';
		roleError = '';
		showRoleDialog = true;
	}

	function closeRoleDialog() {
		showRoleDialog = false;
	}

	function handleNewScopeTypeChange() {
		if (selectedScopeType === 'tenant') {
			selectedScopeId = admin?.tenant_id || '';
		} else {
			selectedScopeId = '';
		}
	}

	function openAssignmentEditDialog(role: AdminRoleAssignment) {
		editingAssignment = role;
		editScopeType = role.scope_type === 'global' ? 'global' : 'tenant';
		editScopeId = editScopeType === 'tenant' ? role.scope_id || admin?.tenant_id || '' : '';
		editExpiresAt = timestampToDateTimeLocal(role.expires_at);
		assignmentEditError = '';
		showAssignmentEditDialog = true;
	}

	function closeAssignmentEditDialog() {
		showAssignmentEditDialog = false;
		editingAssignment = null;
	}

	function handleEditScopeTypeChange() {
		if (editScopeType === 'tenant') {
			editScopeId = editingAssignment?.scope_id || admin?.tenant_id || '';
		} else {
			editScopeId = '';
		}
	}

	async function handleAssignRole() {
		if (!admin || !selectedRoleId) return;

		assigningRole = true;
		roleError = '';

		try {
			await adminAdminsAPI.assignRole(admin.id, {
				role_id: selectedRoleId,
				scope_type: selectedScopeType,
				scope_id: selectedScopeType === 'tenant' ? selectedScopeId.trim() || undefined : undefined,
				expires_at: selectedExpiresAt ? new Date(selectedExpiresAt).getTime() : undefined
			});
			closeRoleDialog();
			await loadAdmin();
		} catch (err) {
			roleError = err instanceof Error ? err.message : $LL.admin_admins_assign_role_failed();
		} finally {
			assigningRole = false;
		}
	}

	async function handleUpdateAssignment() {
		if (!admin || !editingAssignment) return;

		savingAssignment = true;
		assignmentEditError = '';

		try {
			await adminAdminRolesAPI.updateAssignment(
				editingAssignment.role_id,
				editingAssignment.assignment_id,
				{
					scope_type: editScopeType,
					scope_id: editScopeType === 'tenant' ? editScopeId.trim() || undefined : undefined,
					expires_at: editExpiresAt ? new Date(editExpiresAt).getTime() : null
				}
			);
			closeAssignmentEditDialog();
			await loadAdmin();
		} catch (err) {
			assignmentEditError =
				err instanceof Error ? err.message : $LL.admin_admins_assignment_update_failed();
		} finally {
			savingAssignment = false;
		}
	}

	async function handleRemoveRole(role: AdminRoleAssignment) {
		if (!admin) return;
		const isPlatformAdminRole = role.name === 'super_admin';
		const message = isPlatformAdminRole
			? $LL.admin_admins_remove_platform_role_confirm({
					role: role.name,
					email: admin.email
				})
			: $LL.admin_admins_remove_role_confirm({ role: role.name, email: admin.email });
		if (!confirm(message)) return;

		try {
			await adminAdminsAPI.removeRoleAssignment(admin.id, role.assignment_id);
			await loadAdmin();
		} catch (err) {
			alert(err instanceof Error ? err.message : $LL.admin_admins_role_remove_failed());
		}
	}

	function formatDate(timestamp: number | null): string {
		if (!timestamp) return '-';
		return new Date(timestamp).toLocaleString(undefined);
	}

	function timestampToDateTimeLocal(timestamp: number | null): string {
		if (!timestamp) return '';
		const date = new Date(timestamp);
		const offsetMs = date.getTimezoneOffset() * 60_000;
		return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
	}

	function formatScope(role: AdminRoleAssignment): string {
		if (role.scope_type === 'global') return $LL.admin_admins_scope_global();
		if (role.scope_type === 'tenant')
			return $LL.admin_admins_scope_tenant_with_id({
				id: role.scope_id || admin?.tenant_id || '-'
			});
		return $LL.admin_admins_scope_unsupported({
			scope: `${role.scope_type}${role.scope_id ? `:${role.scope_id}` : ''}`
		});
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

	function hasPlatformAdminRole(adminUser: AdminUserDetail): boolean {
		return adminUser.roles.some((role) => role.name === 'super_admin');
	}

	// Filter available roles to exclude already assigned ones
	let assignableRoles = $derived(
		availableRoles.filter((r) => !admin?.roles.some((ar) => ar.role_id === r.id))
	);
</script>

<svelte:head>
	<title>
		{$LL.admin_admins_detail_head_title({
			email: admin?.email || $LL.admin_admins_detail_title_fallback()
		})}
	</title>
</svelte:head>

<div class="page-container">
	<!-- Breadcrumb -->
	<nav class="breadcrumb">
		<a href="/admin/admins">{$LL.admin_admins_title()}</a>
		<span>/</span>
		<span>{admin?.email || $LL.admin_admins_detail_loading_fallback()}</span>
	</nav>

	{#if loading}
		<div class="loading-container">
			<div class="spinner"></div>
			<p>{$LL.admin_admins_loading()}</p>
		</div>
	{:else if error}
		<div class="error-container">
			<p class="error-text">{error}</p>
			<button class="btn btn-secondary" onclick={() => goto('/admin/admins')}>
				{$LL.admin_admins_back_to_admin_users()}
			</button>
		</div>
	{:else if admin}
		<!-- Page Header -->
		<div class="page-header">
			<div class="header-content">
				<h1>{admin.email}</h1>
				<div class="header-badges">
					<span class={getStatusBadgeClass(admin.status)}>{statusLabel(admin.status)}</span>
					{#if admin.mfa_enabled}
						<span class="badge badge-info">{$LL.admin_admins_mfa_enabled()}</span>
					{/if}
				</div>
			</div>
			<div class="header-actions">
				{#if !isEditing}
					<button class="btn btn-secondary" onclick={startEdit}>{$LL.admin_admins_edit()}</button>
					{#if admin.status === 'active'}
						<button class="btn btn-warning" onclick={handleSuspend}
							>{$LL.admin_admins_suspend()}</button
						>
					{:else if admin.status === 'suspended'}
						<button class="btn btn-success" onclick={handleActivate}
							>{$LL.admin_admins_activate()}</button
						>
					{:else if admin.status === 'locked'}
						<button class="btn btn-primary" onclick={handleUnlock}
							>{$LL.admin_admins_unlock()}</button
						>
					{/if}
					<button class="btn btn-danger" onclick={handleDelete}>{$LL.admin_admins_delete()}</button>
				{/if}
			</div>
		</div>

		<div class="content-grid">
			<!-- Basic Info Card -->
			<div class="card">
				<div class="card-header">
					<h2>{$LL.admin_admins_basic_information()}</h2>
				</div>
				<div class="card-body">
					{#if isEditing}
						<div class="form-group">
							<label for="email">{$LL.admin_admins_email()}</label>
							<input type="email" id="email" class="input" bind:value={editData.email} />
						</div>
						<div class="form-group">
							<label for="name">{$LL.admin_admins_name()}</label>
							<input type="text" id="name" class="input" bind:value={editData.name} />
						</div>
						<div class="form-actions">
							<button class="btn btn-secondary" onclick={cancelEdit} disabled={saving}>
								{$LL.admin_admins_cancel()}
							</button>
							<button class="btn btn-primary" onclick={saveEdit} disabled={saving}>
								{saving ? $LL.admin_admins_saving() : $LL.admin_admins_save()}
							</button>
						</div>
					{:else}
						<div class="info-grid">
							<div class="info-row">
								<span class="info-label">{$LL.admin_admins_email()}</span>
								<span class="info-value">{admin.email}</span>
							</div>
							<div class="info-row">
								<span class="info-label">{$LL.admin_admins_name()}</span>
								<span class="info-value">{admin.name || '-'}</span>
							</div>
							<div class="info-row">
								<span class="info-label">{$LL.admin_admins_email_verified()}</span>
								<span class="info-value"
									>{admin.email_verified ? $LL.admin_admins_yes() : $LL.admin_admins_no()}</span
								>
							</div>
							<div class="info-row">
								<span class="info-label">{$LL.admin_admins_status()}</span>
								<span class="info-value">
									<span class={getStatusBadgeClass(admin.status)}>{statusLabel(admin.status)}</span>
								</span>
							</div>
							<div class="info-row">
								<span class="info-label">{$LL.admin_admins_mfa_enabled()}</span>
								<span class="info-value"
									>{admin.mfa_enabled ? $LL.admin_admins_yes() : $LL.admin_admins_no()}</span
								>
							</div>
							{#if admin.mfa_method}
								<div class="info-row">
									<span class="info-label">{$LL.admin_admins_mfa_method()}</span>
									<span class="info-value">{admin.mfa_method}</span>
								</div>
							{/if}
							<div class="info-row">
								<span class="info-label">{$LL.admin_admins_passkeys()}</span>
								<span class="info-value">{admin.passkey_count}</span>
							</div>
						</div>
					{/if}
				</div>
			</div>

			<!-- Login Info Card -->
			<div class="card">
				<div class="card-header">
					<h2>{$LL.admin_admins_login_information()}</h2>
				</div>
				<div class="card-body">
					<div class="info-grid">
						<div class="info-row">
							<span class="info-label">{$LL.admin_admins_last_login()}</span>
							<span class="info-value">{formatDate(admin.last_login_at)}</span>
						</div>
						<div class="info-row">
							<span class="info-label">{$LL.admin_admins_last_login_ip()}</span>
							<span class="info-value">{admin.last_login_ip || '-'}</span>
						</div>
						<div class="info-row">
							<span class="info-label">{$LL.admin_admins_failed_login_count()}</span>
							<span class="info-value">{admin.failed_login_count}</span>
						</div>
						<div class="info-row">
							<span class="info-label">{$LL.admin_admins_created_at()}</span>
							<span class="info-value">{formatDate(admin.created_at)}</span>
						</div>
						<div class="info-row">
							<span class="info-label">{$LL.admin_admins_updated_at()}</span>
							<span class="info-value">{formatDate(admin.updated_at)}</span>
						</div>
					</div>
				</div>
			</div>

			<!-- Roles Card -->
			<div class="card full-width">
				<div class="card-header">
					<h2>{$LL.admin_admins_assigned_roles()}</h2>
					<button class="btn btn-sm btn-primary" onclick={openRoleDialog}
						>{$LL.admin_admins_add_role()}</button
					>
				</div>
				<div class="card-body">
					{#if admin.roles.length === 0}
						<p class="text-muted">{$LL.admin_admins_no_roles_assigned()}</p>
					{:else}
						<div class="roles-list">
							{#each admin.roles as role (role.id)}
								<div class="role-item">
									<div class="role-info">
										<span class="role-name">{role.display_name || role.name}</span>
										<span class="role-id">{role.name}</span>
									</div>
									<div class="role-meta">
										<span class="scope-chip">{formatScope(role)}</span>
										<span class="text-muted"
											>{$LL.admin_admins_assigned_at({
												date: formatDate(role.assigned_at)
											})}</span
										>
										{#if role.expires_at}
											<span class="text-muted"
												>{$LL.admin_admins_expires_at({
													date: formatDate(role.expires_at)
												})}</span
											>
										{/if}
									</div>
									<button
										class="btn btn-sm btn-secondary"
										onclick={() => openAssignmentEditDialog(role)}
									>
										{$LL.admin_admins_edit()}
									</button>
									<button class="btn btn-sm btn-danger" onclick={() => handleRemoveRole(role)}>
										{$LL.admin_admins_remove()}
									</button>
								</div>
							{/each}
						</div>
					{/if}
				</div>
			</div>
		</div>
	{/if}
</div>

<!-- Role Assignment Dialog -->
<Modal
	open={showRoleDialog}
	onClose={closeRoleDialog}
	title={$LL.admin_admins_assign_role_title()}
	size="md"
>
	{#if roleError}
		<div class="alert alert-danger">{roleError}</div>
	{/if}
	{#if assignableRoles.length === 0}
		<p class="text-muted">{$LL.admin_admins_no_available_roles()}</p>
	{:else}
		<div class="form-group">
			<label for="role">{$LL.admin_admins_select_role()}</label>
			<select id="role" class="select" bind:value={selectedRoleId}>
				<option value="">{$LL.admin_admins_select_role_placeholder()}</option>
				{#each assignableRoles as role (role.id)}
					<option value={role.id}>{role.display_name || role.name}</option>
				{/each}
			</select>
		</div>
		<div class="form-row">
			<div class="form-group">
				<label for="roleScopeType">{$LL.admin_admins_scope_type()}</label>
				<select
					id="roleScopeType"
					class="select"
					bind:value={selectedScopeType}
					onchange={handleNewScopeTypeChange}
				>
					<option value="tenant">{$LL.admin_admins_scope_tenant()}</option>
					<option value="global">{$LL.admin_admins_scope_global()}</option>
				</select>
			</div>
			<div class="form-group">
				<label for="roleScopeId">{$LL.admin_admins_scope_id()}</label>
				<input
					id="roleScopeId"
					class="input"
					type="text"
					bind:value={selectedScopeId}
					disabled={selectedScopeType === 'global'}
					placeholder={admin?.tenant_id || 'tenant_id'}
				/>
			</div>
		</div>
		<div class="form-group">
			<label for="roleExpiresAt">{$LL.admin_admins_expires_at_label()}</label>
			<input
				id="roleExpiresAt"
				class="input"
				type="datetime-local"
				bind:value={selectedExpiresAt}
			/>
		</div>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeRoleDialog} disabled={assigningRole}>
			{$LL.admin_admins_cancel()}
		</button>
		<button
			class="btn btn-primary"
			onclick={handleAssignRole}
			disabled={assigningRole || !selectedRoleId}
		>
			{assigningRole ? $LL.admin_admins_assigning() : $LL.admin_admins_assign()}
		</button>
	{/snippet}
</Modal>

<!-- Role Assignment Edit Dialog -->
<Modal
	open={showAssignmentEditDialog && !!editingAssignment}
	onClose={closeAssignmentEditDialog}
	title={$LL.admin_admins_edit_assignment_title()}
	size="md"
>
	{#if assignmentEditError}
		<div class="alert alert-danger">{assignmentEditError}</div>
	{/if}
	{#if editingAssignment}
		<div class="form-group">
			<!-- svelte-ignore a11y_label_has_associated_control -->
			<label>{$LL.admin_admins_role()}</label>
			<div class="readonly-value">{editingAssignment.display_name || editingAssignment.name}</div>
		</div>
		<div class="form-row">
			<div class="form-group">
				<label for="editScopeType">{$LL.admin_admins_scope_type()}</label>
				<select
					id="editScopeType"
					class="select"
					bind:value={editScopeType}
					onchange={handleEditScopeTypeChange}
				>
					<option value="tenant">{$LL.admin_admins_scope_tenant()}</option>
					<option value="global">{$LL.admin_admins_scope_global()}</option>
				</select>
			</div>
			<div class="form-group">
				<label for="editScopeId">{$LL.admin_admins_scope_id()}</label>
				<input
					id="editScopeId"
					class="input"
					type="text"
					bind:value={editScopeId}
					disabled={editScopeType === 'global'}
					placeholder={admin?.tenant_id || 'tenant_id'}
				/>
			</div>
		</div>
		<div class="form-group">
			<label for="editExpiresAt">{$LL.admin_admins_expires_at_label()}</label>
			<input id="editExpiresAt" class="input" type="datetime-local" bind:value={editExpiresAt} />
		</div>
	{/if}

	{#snippet footer()}
		<button
			class="btn btn-secondary"
			onclick={closeAssignmentEditDialog}
			disabled={savingAssignment}
		>
			{$LL.admin_admins_cancel()}
		</button>
		<button
			class="btn btn-primary"
			onclick={handleUpdateAssignment}
			disabled={savingAssignment || !editingAssignment}
		>
			{savingAssignment ? $LL.admin_admins_saving() : $LL.admin_admins_save()}
		</button>
	{/snippet}
</Modal>

<style>
	.page-container {
		padding: 1.5rem;
		max-width: 1200px;
		margin: 0 auto;
	}

	.breadcrumb {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 1rem;
		font-size: 0.875rem;
		color: var(--text-muted);
	}

	.breadcrumb a {
		color: var(--primary);
		text-decoration: none;
	}

	.breadcrumb a:hover {
		text-decoration: underline;
	}

	.page-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		margin-bottom: 1.5rem;
	}

	.header-content h1 {
		margin: 0 0 0.5rem 0;
		font-size: 1.5rem;
		font-weight: 600;
	}

	.header-badges {
		display: flex;
		gap: 0.5rem;
	}

	.header-actions {
		display: flex;
		gap: 0.5rem;
	}

	.content-grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 1.5rem;
	}

	.card.full-width {
		grid-column: 1 / -1;
	}

	.card {
		background: var(--bg-primary);
		border: 1px solid var(--border-color);
		border-radius: var(--radius-lg);
	}

	.card-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem 1.5rem;
		border-bottom: 1px solid var(--border-color);
	}

	.card-header h2 {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
	}

	.card-body {
		padding: 1.5rem;
	}

	.info-grid {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.info-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.info-label {
		color: var(--text-muted);
		font-size: 0.875rem;
	}

	.info-value {
		font-weight: 500;
	}

	.roles-list {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.role-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem;
		background: var(--bg-secondary);
		border-radius: var(--radius-md);
	}

	.role-info {
		display: flex;
		flex-direction: column;
	}

	.role-name {
		font-weight: 500;
	}

	.role-id {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.role-meta {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		font-size: 0.75rem;
		gap: 0.25rem;
	}

	.scope-chip {
		display: inline-flex;
		align-items: center;
		padding: 0.125rem 0.5rem;
		border: 1px solid var(--border-color);
		border-radius: var(--radius-sm);
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.75rem;
		white-space: nowrap;
	}

	.form-group {
		margin-bottom: 1rem;
	}

	.form-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}

	.readonly-value {
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border-color);
		border-radius: var(--radius-md);
		background: var(--bg-secondary);
		color: var(--text-primary);
		font-size: 0.875rem;
	}

	.form-group label {
		display: block;
		margin-bottom: 0.5rem;
		font-weight: 500;
		font-size: 0.875rem;
	}

	.form-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 1rem;
	}

	.input,
	.select {
		width: 100%;
		padding: 0.5rem 0.75rem;
		border: 1px solid var(--border-color);
		border-radius: var(--radius-md);
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.875rem;
	}

	.badge {
		display: inline-block;
		padding: 0.25rem 0.5rem;
		font-size: 0.75rem;
		font-weight: 500;
		border-radius: var(--radius-sm);
	}

	.badge-success {
		background: var(--success-bg);
		color: var(--success);
	}

	.badge-warning {
		background: var(--warning-bg);
		color: var(--warning);
	}

	.badge-danger {
		background: var(--danger-bg);
		color: var(--danger);
	}

	.badge-info {
		background: var(--info-bg);
		color: var(--info);
	}

	.badge-neutral {
		background: var(--bg-tertiary);
		color: var(--text-muted);
	}

	.btn {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 1rem;
		border: none;
		border-radius: var(--radius-md);
		font-size: 0.875rem;
		font-weight: 500;
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.btn-sm {
		padding: 0.25rem 0.5rem;
		font-size: 0.75rem;
	}

	.btn-primary {
		background: var(--primary);
		color: white;
	}

	.btn-secondary {
		background: var(--bg-secondary);
		color: var(--text-primary);
		border: 1px solid var(--border-color);
	}

	.btn-success {
		background: var(--success);
		color: white;
	}

	.btn-warning {
		background: var(--warning);
		color: white;
	}

	.btn-danger {
		background: var(--danger);
		color: white;
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.text-muted {
		color: var(--text-muted);
	}

	.loading-container,
	.error-container {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		padding: 3rem;
		text-align: center;
	}

	.spinner {
		width: 2rem;
		height: 2rem;
		border: 2px solid var(--border-color);
		border-top-color: var(--primary);
		border-radius: 50%;
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.error-text {
		color: var(--danger);
		margin-bottom: 1rem;
	}

	.alert {
		padding: 0.75rem;
		border-radius: var(--radius-md);
		margin-bottom: 1rem;
	}

	.alert-danger {
		background: var(--danger-bg);
		color: var(--danger);
	}

	@media (max-width: 768px) {
		.content-grid {
			grid-template-columns: 1fr;
		}

		.page-header {
			flex-direction: column;
			gap: 1rem;
		}

		.header-actions {
			flex-wrap: wrap;
		}

		.form-row {
			grid-template-columns: 1fr;
		}
	}
</style>
