<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import {
		adminAdminsAPI,
		type AdminUserDetail,
		type UpdateAdminUserInput
	} from '$lib/api/admin-admins';
	import { adminAdminRolesAPI, type AdminRole } from '$lib/api/admin-admin-roles';

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
	let assigningRole = $state(false);
	let roleError = $state('');

	const adminId = $derived($page.params.id);

	async function loadAdmin() {
		if (!adminId) {
			error = 'Admin ID is required';
			loading = false;
			return;
		}

		loading = true;
		error = '';

		try {
			admin = await adminAdminsAPI.get(adminId);
		} catch (err) {
			console.error('Failed to load admin:', err);
			error = err instanceof Error ? err.message : 'Failed to load admin user';
		} finally {
			loading = false;
		}
	}

	async function loadRoles() {
		try {
			const response = await adminAdminRolesAPI.list();
			availableRoles = response.items;
		} catch (err) {
			console.error('Failed to load roles:', err);
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
			alert(err instanceof Error ? err.message : 'Failed to update admin user');
		} finally {
			saving = false;
		}
	}

	async function handleDelete() {
		if (!admin) return;
		if (!confirm(`Are you sure you want to delete ${admin.email}?`)) return;

		try {
			await adminAdminsAPI.delete(admin.id);
			goto('/admin/admins');
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to delete admin user');
		}
	}

	async function handleSuspend() {
		if (!admin) return;
		if (!confirm(`Are you sure you want to suspend ${admin.email}?`)) return;

		try {
			await adminAdminsAPI.suspend(admin.id);
			await loadAdmin();
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to suspend admin user');
		}
	}

	async function handleActivate() {
		if (!admin) return;

		try {
			await adminAdminsAPI.activate(admin.id);
			await loadAdmin();
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to activate admin user');
		}
	}

	async function handleUnlock() {
		if (!admin) return;

		try {
			await adminAdminsAPI.unlock(admin.id);
			await loadAdmin();
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to unlock admin user');
		}
	}

	function openRoleDialog() {
		selectedRoleId = '';
		roleError = '';
		showRoleDialog = true;
	}

	function closeRoleDialog() {
		showRoleDialog = false;
	}

	async function handleAssignRole() {
		if (!admin || !selectedRoleId) return;

		assigningRole = true;
		roleError = '';

		try {
			await adminAdminsAPI.assignRole(admin.id, { role_id: selectedRoleId });
			closeRoleDialog();
			await loadAdmin();
		} catch (err) {
			roleError = err instanceof Error ? err.message : 'Failed to assign role';
		} finally {
			assigningRole = false;
		}
	}

	async function handleRemoveRole(roleId: string, roleName: string) {
		if (!admin) return;
		if (!confirm(`Remove role "${roleName}" from ${admin.email}?`)) return;

		try {
			await adminAdminsAPI.removeRole(admin.id, roleId);
			await loadAdmin();
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to remove role');
		}
	}

	function formatDate(timestamp: number | null): string {
		if (!timestamp) return '-';
		return new Date(timestamp).toLocaleString();
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

	// Filter available roles to exclude already assigned ones
	let assignableRoles = $derived(
		availableRoles.filter((r) => !admin?.roles.some((ar) => ar.id === r.id))
	);
</script>

<svelte:head>
	<title>{admin?.email || 'Admin User'} - Authrim</title>
</svelte:head>

<div class="page-container">
	<!-- Breadcrumb -->
	<nav class="breadcrumb">
		<a href="/admin/admins">Admin Users</a>
		<span>/</span>
		<span>{admin?.email || 'Loading...'}</span>
	</nav>

	{#if loading}
		<div class="loading-container">
			<div class="spinner"></div>
			<p>Loading admin user...</p>
		</div>
	{:else if error}
		<div class="error-container">
			<p class="error-text">{error}</p>
			<button class="btn btn-secondary" onclick={() => goto('/admin/admins')}>
				Back to Admin Users
			</button>
		</div>
	{:else if admin}
		<!-- Page Header -->
		<div class="page-header">
			<div class="header-content">
				<h1>{admin.email}</h1>
				<div class="header-badges">
					<span class={getStatusBadgeClass(admin.status)}>{admin.status}</span>
					{#if admin.mfa_enabled}
						<span class="badge badge-info">MFA Enabled</span>
					{/if}
				</div>
			</div>
			<div class="header-actions">
				{#if !isEditing}
					<button class="btn btn-secondary" onclick={startEdit}>Edit</button>
					{#if admin.status === 'active'}
						<button class="btn btn-warning" onclick={handleSuspend}>Suspend</button>
					{:else if admin.status === 'suspended'}
						<button class="btn btn-success" onclick={handleActivate}>Activate</button>
					{:else if admin.status === 'locked'}
						<button class="btn btn-primary" onclick={handleUnlock}>Unlock</button>
					{/if}
					<button class="btn btn-danger" onclick={handleDelete}>Delete</button>
				{/if}
			</div>
		</div>

		<div class="content-grid">
			<!-- Basic Info Card -->
			<div class="card">
				<div class="card-header">
					<h2>Basic Information</h2>
				</div>
				<div class="card-body">
					{#if isEditing}
						<div class="form-group">
							<label for="email">Email</label>
							<input type="email" id="email" class="input" bind:value={editData.email} />
						</div>
						<div class="form-group">
							<label for="name">Name</label>
							<input type="text" id="name" class="input" bind:value={editData.name} />
						</div>
						<div class="form-actions">
							<button class="btn btn-secondary" onclick={cancelEdit} disabled={saving}>
								Cancel
							</button>
							<button class="btn btn-primary" onclick={saveEdit} disabled={saving}>
								{saving ? 'Saving...' : 'Save'}
							</button>
						</div>
					{:else}
						<div class="info-grid">
							<div class="info-row">
								<span class="info-label">Email</span>
								<span class="info-value">{admin.email}</span>
							</div>
							<div class="info-row">
								<span class="info-label">Name</span>
								<span class="info-value">{admin.name || '-'}</span>
							</div>
							<div class="info-row">
								<span class="info-label">Email Verified</span>
								<span class="info-value">{admin.email_verified ? 'Yes' : 'No'}</span>
							</div>
							<div class="info-row">
								<span class="info-label">Status</span>
								<span class="info-value">
									<span class={getStatusBadgeClass(admin.status)}>{admin.status}</span>
								</span>
							</div>
							<div class="info-row">
								<span class="info-label">MFA Enabled</span>
								<span class="info-value">{admin.mfa_enabled ? 'Yes' : 'No'}</span>
							</div>
							{#if admin.mfa_method}
								<div class="info-row">
									<span class="info-label">MFA Method</span>
									<span class="info-value">{admin.mfa_method}</span>
								</div>
							{/if}
							<div class="info-row">
								<span class="info-label">Passkeys</span>
								<span class="info-value">{admin.passkey_count}</span>
							</div>
						</div>
					{/if}
				</div>
			</div>

			<!-- Login Info Card -->
			<div class="card">
				<div class="card-header">
					<h2>Login Information</h2>
				</div>
				<div class="card-body">
					<div class="info-grid">
						<div class="info-row">
							<span class="info-label">Last Login</span>
							<span class="info-value">{formatDate(admin.last_login_at)}</span>
						</div>
						<div class="info-row">
							<span class="info-label">Last Login IP</span>
							<span class="info-value">{admin.last_login_ip || '-'}</span>
						</div>
						<div class="info-row">
							<span class="info-label">Failed Login Count</span>
							<span class="info-value">{admin.failed_login_count}</span>
						</div>
						<div class="info-row">
							<span class="info-label">Created At</span>
							<span class="info-value">{formatDate(admin.created_at)}</span>
						</div>
						<div class="info-row">
							<span class="info-label">Updated At</span>
							<span class="info-value">{formatDate(admin.updated_at)}</span>
						</div>
					</div>
				</div>
			</div>

			<!-- Roles Card -->
			<div class="card full-width">
				<div class="card-header">
					<h2>Assigned Roles</h2>
					<button class="btn btn-sm btn-primary" onclick={openRoleDialog}>Add Role</button>
				</div>
				<div class="card-body">
					{#if admin.roles.length === 0}
						<p class="text-muted">No roles assigned</p>
					{:else}
						<div class="roles-list">
							{#each admin.roles as role (role.id)}
								<div class="role-item">
									<div class="role-info">
										<span class="role-name">{role.display_name || role.name}</span>
										<span class="role-id">{role.name}</span>
									</div>
									<div class="role-meta">
										<span class="text-muted">Assigned: {formatDate(role.assigned_at)}</span>
										{#if role.expires_at}
											<span class="text-muted">Expires: {formatDate(role.expires_at)}</span>
										{/if}
									</div>
									<button
										class="btn btn-sm btn-danger"
										onclick={() => handleRemoveRole(role.id, role.name)}
									>
										Remove
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
{#if showRoleDialog}
	<div class="dialog-overlay" onclick={closeRoleDialog}>
		<div class="dialog" onclick={(e) => e.stopPropagation()}>
			<div class="dialog-header">
				<h2>Assign Role</h2>
				<button class="btn-close" onclick={closeRoleDialog}>&times;</button>
			</div>
			<div class="dialog-body">
				{#if roleError}
					<div class="alert alert-danger">{roleError}</div>
				{/if}
				{#if assignableRoles.length === 0}
					<p class="text-muted">No available roles to assign</p>
				{:else}
					<div class="form-group">
						<label for="role">Select Role</label>
						<select id="role" class="select" bind:value={selectedRoleId}>
							<option value="">-- Select a role --</option>
							{#each assignableRoles as role (role.id)}
								<option value={role.id}>{role.display_name || role.name}</option>
							{/each}
						</select>
					</div>
				{/if}
			</div>
			<div class="dialog-footer">
				<button class="btn btn-secondary" onclick={closeRoleDialog} disabled={assigningRole}>
					Cancel
				</button>
				<button
					class="btn btn-primary"
					onclick={handleAssignRole}
					disabled={assigningRole || !selectedRoleId}
				>
					{assigningRole ? 'Assigning...' : 'Assign'}
				</button>
			</div>
		</div>
	</div>
{/if}

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
	}

	.form-group {
		margin-bottom: 1rem;
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
		background: var(--bg-primary);
		border-radius: var(--radius-lg);
		width: 100%;
		max-width: 400px;
		box-shadow: var(--shadow-lg);
	}

	.dialog-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 1rem 1.5rem;
		border-bottom: 1px solid var(--border-color);
	}

	.dialog-header h2 {
		margin: 0;
		font-size: 1.125rem;
		font-weight: 600;
	}

	.btn-close {
		background: none;
		border: none;
		font-size: 1.5rem;
		cursor: pointer;
		color: var(--text-muted);
	}

	.dialog-body {
		padding: 1.5rem;
	}

	.dialog-footer {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		padding: 1rem 1.5rem;
		border-top: 1px solid var(--border-color);
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
	}
</style>
