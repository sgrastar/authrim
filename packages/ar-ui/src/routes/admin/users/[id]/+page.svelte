<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { adminUsersAPI, type User, type UpdateUserInput } from '$lib/api/admin-users';
	import { adminSessionsAPI } from '$lib/api/admin-sessions';
	import {
		adminRolesAPI,
		type Role,
		type RoleAssignment,
		type ScopeType
	} from '$lib/api/admin-roles';
	import OrganizationSelectDialog from '$lib/components/OrganizationSelectDialog.svelte';
	import { ToggleSwitch } from '$lib/components';
	import type { OrganizationNode } from '$lib/api/admin-organizations';
	import { sanitizeText, isValidUUID } from '$lib/utils';

	let user: User | null = $state(null);
	let loading = $state(true);
	let error = $state('');
	let isEditing = $state(false);
	let saving = $state(false);
	let actionError = $state('');

	// Edit form state
	let editForm = $state<UpdateUserInput>({});

	// Role assignment state
	let userRoles = $state<RoleAssignment[]>([]);
	let availableRoles = $state<Role[]>([]);
	let rolesLoading = $state(false);
	let rolesError = $state('');

	// Assign role dialog state
	let showAssignRoleDialog = $state(false);
	let assignStep = $state<'select-role' | 'select-scope'>('select-role');
	let selectedRoleId = $state('');
	let selectedScope = $state<ScopeType>('global');
	let selectedOrgId = $state<string | null>(null);
	let selectedOrgName = $state<string | null>(null);
	let assignLoading = $state(false);

	// Organization select dialog
	let showOrgSelectDialog = $state(false);

	// Remove role confirmation
	let showRemoveRoleDialog = $state(false);
	let roleToRemove = $state<RoleAssignment | null>(null);
	let removeRoleLoading = $state(false);

	// Confirmation dialog state
	let showConfirmDialog = $state(false);
	let confirmAction = $state<'suspend' | 'lock' | 'delete' | 'activate' | 'revoke-sessions' | null>(
		null
	);
	let confirmLoading = $state(false);
	let revokedSessionsCount = $state<number | null>(null);

	const userId = $derived($page.params.id ?? '');

	async function loadUser() {
		loading = true;
		error = '';

		try {
			user = await adminUsersAPI.get(userId);
			resetEditForm();
		} catch (err) {
			console.error('Failed to load user:', err);
			error = err instanceof Error ? err.message : 'Failed to load user';
		} finally {
			loading = false;
		}
	}

	function resetEditForm() {
		if (user) {
			editForm = {
				email: user.email || '',
				name: user.name || '',
				given_name: user.given_name || '',
				family_name: user.family_name || '',
				nickname: user.nickname || '',
				preferred_username: user.preferred_username || '',
				phone_number: user.phone_number || '',
				email_verified: user.email_verified,
				phone_number_verified: user.phone_number_verified
			};
		}
	}

	onMount(() => {
		loadUser();
		loadUserRoles();
		loadAvailableRoles();
	});

	// Role management functions
	async function loadUserRoles() {
		rolesLoading = true;
		rolesError = '';
		try {
			const response = await adminRolesAPI.getUserRoles(userId);
			userRoles = response.roles;
		} catch (err) {
			console.error('Failed to load user roles:', err);
			rolesError = err instanceof Error ? err.message : 'Failed to load roles';
		} finally {
			rolesLoading = false;
		}
	}

	async function loadAvailableRoles() {
		try {
			const response = await adminRolesAPI.list();
			availableRoles = response.roles;
		} catch (err) {
			console.error('Failed to load available roles:', err);
		}
	}

	function openAssignRoleDialog() {
		selectedRoleId = '';
		selectedScope = 'global';
		selectedOrgId = null;
		selectedOrgName = null;
		assignStep = 'select-role';
		showAssignRoleDialog = true;
		rolesError = '';
	}

	function closeAssignRoleDialog() {
		showAssignRoleDialog = false;
	}

	function goToScopeStep() {
		if (selectedRoleId) {
			assignStep = 'select-scope';
		}
	}

	function goBackToRoleStep() {
		assignStep = 'select-role';
	}

	function openOrgSelectDialog() {
		showOrgSelectDialog = true;
	}

	function handleOrgSelect(org: OrganizationNode) {
		selectedOrgId = org.id;
		selectedOrgName = org.display_name || org.name;
		showOrgSelectDialog = false;
	}

	async function assignRole() {
		if (!selectedRoleId) return;
		if (selectedScope === 'org' && !selectedOrgId) {
			rolesError = 'Please select an organization for org-scoped role';
			return;
		}
		if (selectedScope === 'org' && selectedOrgId && !isValidUUID(selectedOrgId)) {
			rolesError = 'Invalid organization ID format';
			return;
		}

		assignLoading = true;
		rolesError = '';

		try {
			await adminRolesAPI.assignRole(userId, {
				role_id: selectedRoleId,
				scope: selectedScope,
				scope_target: selectedScope === 'org' ? selectedOrgId! : undefined
			});
			await loadUserRoles();
			closeAssignRoleDialog();
		} catch (err) {
			console.error('Failed to assign role:', err);
			rolesError = err instanceof Error ? err.message : 'Failed to assign role';
		} finally {
			assignLoading = false;
		}
	}

	function confirmRemoveRole(role: RoleAssignment) {
		roleToRemove = role;
		showRemoveRoleDialog = true;
	}

	function closeRemoveRoleDialog() {
		showRemoveRoleDialog = false;
		roleToRemove = null;
	}

	async function removeRole() {
		if (!roleToRemove) return;

		removeRoleLoading = true;
		rolesError = '';

		try {
			await adminRolesAPI.removeRole(userId, roleToRemove.id);
			await loadUserRoles();
			closeRemoveRoleDialog();
		} catch (err) {
			console.error('Failed to remove role:', err);
			rolesError = err instanceof Error ? err.message : 'Failed to remove role';
		} finally {
			removeRoleLoading = false;
		}
	}

	function getScopeBadgeClass(scope: ScopeType): string {
		switch (scope) {
			case 'global':
				return 'badge badge-global';
			case 'org':
				return 'badge badge-org';
			case 'resource':
				return 'badge badge-resource';
			default:
				return 'badge badge-neutral';
		}
	}

	function startEditing() {
		resetEditForm();
		isEditing = true;
		actionError = '';
	}

	function cancelEditing() {
		isEditing = false;
		resetEditForm();
		actionError = '';
	}

	async function saveChanges() {
		if (!user) return;

		saving = true;
		actionError = '';

		try {
			user = await adminUsersAPI.update(userId, editForm);
			isEditing = false;
		} catch (err) {
			console.error('Failed to update user:', err);
			actionError = err instanceof Error ? err.message : 'Failed to update user';
		} finally {
			saving = false;
		}
	}

	function openConfirmDialog(
		action: 'suspend' | 'lock' | 'delete' | 'activate' | 'revoke-sessions'
	) {
		confirmAction = action;
		showConfirmDialog = true;
		actionError = '';
		revokedSessionsCount = null;
	}

	function closeConfirmDialog() {
		showConfirmDialog = false;
		confirmAction = null;
		revokedSessionsCount = null;
	}

	async function executeAction() {
		if (!confirmAction) return;

		confirmLoading = true;
		actionError = '';

		try {
			switch (confirmAction) {
				case 'suspend':
					await adminUsersAPI.suspend(userId);
					break;
				case 'lock':
					await adminUsersAPI.lock(userId);
					break;
				case 'activate':
					await adminUsersAPI.activate(userId);
					break;
				case 'revoke-sessions': {
					const result = await adminSessionsAPI.revokeAllForUser(userId);
					revokedSessionsCount = result.revokedCount ?? 0;
					// Don't close dialog immediately - show success message
					confirmLoading = false;
					return;
				}
				case 'delete':
					await adminUsersAPI.delete(userId);
					goto('/admin/users');
					return;
			}
			await loadUser();
			closeConfirmDialog();
		} catch (err) {
			console.error(`Failed to ${confirmAction} user:`, err);
			actionError = err instanceof Error ? err.message : `Failed to ${confirmAction} user`;
		} finally {
			confirmLoading = false;
		}
	}

	function formatTimestamp(timestamp: number | null): string {
		if (!timestamp) return '-';
		return new Date(timestamp).toLocaleString();
	}

	function getStatusBadgeClass(status: string): string {
		switch (status) {
			case 'active':
				return 'status-badge status-active';
			case 'suspended':
				return 'status-badge status-suspended';
			case 'locked':
				return 'status-badge status-locked';
			default:
				return 'status-badge';
		}
	}

	function getConfirmDialogContent() {
		switch (confirmAction) {
			case 'suspend':
				return {
					title: 'Suspend User',
					description:
						"This will temporarily suspend the user's account. The user will not be able to log in until unsuspended.",
					buttonText: 'Suspend',
					buttonColor: '#f59e0b'
				};
			case 'lock':
				return {
					title: 'Lock User Account',
					description:
						"This will lock the user's account due to security concerns. Use this for suspicious activity or compromised accounts.",
					buttonText: 'Lock',
					buttonColor: '#ef4444'
				};
			case 'activate':
				return {
					title: 'Activate User',
					description:
						"This will restore the user's account to active status. The user will be able to log in again.",
					buttonText: 'Activate',
					buttonColor: '#10b981'
				};
			case 'revoke-sessions':
				return {
					title: 'Revoke All Sessions',
					description:
						'This will immediately log out the user from all devices. The user will need to log in again.',
					buttonText: 'Revoke All',
					buttonColor: '#dc2626'
				};
			case 'delete':
				return {
					title: 'Delete User',
					description: 'This will delete the user. The user will be removed from the list.',
					buttonText: 'Delete',
					buttonColor: '#dc2626'
				};
			default:
				return { title: '', description: '', buttonText: '', buttonColor: '' };
		}
	}
</script>

<svelte:head>
	<title>{user?.email || 'User'} - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<a href="/admin/users" class="back-link">← Back to Users</a>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>Loading user...</p>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if user}
		<!-- User Header -->
		<div class="page-header-with-status">
			<div class="page-header-info">
				<h1>{sanitizeText(user.name || user.email || 'Unknown User')}</h1>
				<p>{sanitizeText(user.email || '')}</p>
			</div>
			<span class={getStatusBadgeClass(user.status)}>{user.status}</span>
		</div>

		{#if actionError}
			<div class="alert alert-error">{actionError}</div>
		{/if}

		<!-- User Details -->
		<div class="panel">
			<div class="panel-header">
				<h2 class="panel-title">User Information</h2>
				{#if !isEditing}
					<button class="btn btn-primary btn-sm" onclick={startEditing}>Edit</button>
				{/if}
			</div>

			{#if isEditing}
				<!-- Edit Form -->
				<form
					onsubmit={(e) => {
						e.preventDefault();
						saveChanges();
					}}
				>
					<div class="form-grid">
						<div class="form-group">
							<label for="email" class="form-label">Email</label>
							<input id="email" type="email" class="form-input" bind:value={editForm.email} />
						</div>
						<div class="form-group">
							<label for="name" class="form-label">Name</label>
							<input id="name" type="text" class="form-input" bind:value={editForm.name} />
						</div>
						<div class="form-group">
							<label for="given_name" class="form-label">Given Name</label>
							<input
								id="given_name"
								type="text"
								class="form-input"
								bind:value={editForm.given_name}
							/>
						</div>
						<div class="form-group">
							<label for="family_name" class="form-label">Family Name</label>
							<input
								id="family_name"
								type="text"
								class="form-input"
								bind:value={editForm.family_name}
							/>
						</div>
						<div class="form-group">
							<label for="nickname" class="form-label">Nickname</label>
							<input id="nickname" type="text" class="form-input" bind:value={editForm.nickname} />
						</div>
						<div class="form-group">
							<label for="preferred_username" class="form-label">Preferred Username</label>
							<input
								id="preferred_username"
								type="text"
								class="form-input"
								bind:value={editForm.preferred_username}
							/>
						</div>
						<div class="form-group">
							<label for="phone_number" class="form-label">Phone Number</label>
							<input
								id="phone_number"
								type="tel"
								class="form-input"
								bind:value={editForm.phone_number}
							/>
						</div>
						<div class="form-group form-group-full">
							<ToggleSwitch
								bind:checked={editForm.email_verified}
								label="Email Verified"
								description="Mark the user's email address as verified"
							/>
						</div>
						<div class="form-group form-group-full">
							<ToggleSwitch
								bind:checked={editForm.phone_number_verified}
								label="Phone Verified"
								description="Mark the user's phone number as verified"
							/>
						</div>
					</div>
					<div class="action-buttons" style="margin-top: 20px;">
						<button type="submit" class="btn btn-primary" disabled={saving}>
							{saving ? 'Saving...' : 'Save Changes'}
						</button>
						<button
							type="button"
							class="btn btn-secondary"
							onclick={cancelEditing}
							disabled={saving}
						>
							Cancel
						</button>
					</div>
				</form>
			{:else}
				<!-- Display Mode -->
				<dl class="info-grid">
					<div class="info-item">
						<dt>ID</dt>
						<dd class="info-value mono">{user.id}</dd>
					</div>
					<div class="info-item">
						<dt>Email</dt>
						<dd class="info-value">{sanitizeText(user.email || '-')}</dd>
					</div>
					<div class="info-item">
						<dt>Name</dt>
						<dd class="info-value">{sanitizeText(user.name || '-')}</dd>
					</div>
					<div class="info-item">
						<dt>Given Name</dt>
						<dd class="info-value">{sanitizeText(user.given_name || '-')}</dd>
					</div>
					<div class="info-item">
						<dt>Family Name</dt>
						<dd class="info-value">{sanitizeText(user.family_name || '-')}</dd>
					</div>
					<div class="info-item">
						<dt>Nickname</dt>
						<dd class="info-value">{sanitizeText(user.nickname || '-')}</dd>
					</div>
					<div class="info-item">
						<dt>Preferred Username</dt>
						<dd class="info-value">{sanitizeText(user.preferred_username || '-')}</dd>
					</div>
					<div class="info-item">
						<dt>Phone Number</dt>
						<dd class="info-value">{sanitizeText(user.phone_number || '-')}</dd>
					</div>
					<div class="info-item">
						<dt>User Type</dt>
						<dd class="info-value">{user.user_type}</dd>
					</div>
					<div class="info-item">
						<dt>Email Verified</dt>
						<dd class="info-value">
							{#if user.email_verified}
								<span class="verify-yes">✓ Yes</span>
							{:else}
								<span class="verify-no">✗ No</span>
							{/if}
						</dd>
					</div>
					<div class="info-item">
						<dt>Phone Verified</dt>
						<dd class="info-value">
							{#if user.phone_number_verified}
								<span class="verify-yes">✓ Yes</span>
							{:else}
								<span class="verify-no">✗ No</span>
							{/if}
						</dd>
					</div>
				</dl>
			{/if}
		</div>

		<!-- Timestamps -->
		<div class="panel">
			<h2 class="panel-title">Timestamps</h2>
			<dl class="info-grid">
				<div class="info-item">
					<dt>Created At</dt>
					<dd class="info-value">{formatTimestamp(user.created_at)}</dd>
				</div>
				<div class="info-item">
					<dt>Updated At</dt>
					<dd class="info-value">{formatTimestamp(user.updated_at)}</dd>
				</div>
				<div class="info-item">
					<dt>Last Login At</dt>
					<dd class="info-value">{formatTimestamp(user.last_login_at)}</dd>
				</div>
				{#if user.suspended_at}
					<div class="info-item">
						<dt>Suspended At</dt>
						<dd class="info-value warning">{formatTimestamp(user.suspended_at)}</dd>
					</div>
				{/if}
				{#if user.locked_at}
					<div class="info-item">
						<dt>Locked At</dt>
						<dd class="info-value danger">{formatTimestamp(user.locked_at)}</dd>
					</div>
				{/if}
			</dl>
		</div>

		<!-- Passkeys -->
		<div class="panel">
			<h2 class="panel-title">Passkeys</h2>
			{#if user.passkeys && user.passkeys.length > 0}
				<ul class="passkey-list">
					{#each user.passkeys as passkey (passkey.id)}
						<li class="passkey-item">
							<div class="passkey-header">
								<div>
									<p class="passkey-name">
										{sanitizeText(passkey.device_name || 'Unnamed Device')}
									</p>
									<p class="passkey-meta">Created: {formatTimestamp(passkey.created_at)}</p>
								</div>
								<p class="passkey-meta">Last used: {formatTimestamp(passkey.last_used_at)}</p>
							</div>
						</li>
					{/each}
				</ul>
			{:else}
				<div class="empty-state">
					<p class="empty-state-description">No passkeys registered</p>
				</div>
			{/if}
		</div>

		<!-- Role Assignments -->
		<div class="panel">
			<div class="panel-header">
				<h2 class="panel-title">Role Assignments</h2>
				<button class="btn btn-primary btn-sm" onclick={openAssignRoleDialog}>Assign Role</button>
			</div>

			{#if rolesError}
				<div class="alert alert-error">{rolesError}</div>
			{/if}

			{#if rolesLoading}
				<div class="loading-state">
					<i class="i-ph-circle-notch loading-spinner"></i>
					<p>Loading roles...</p>
				</div>
			{:else if userRoles.length > 0}
				<div class="data-table-container">
					<table class="data-table">
						<thead>
							<tr>
								<th>Role</th>
								<th>Scope</th>
								<th>Scope Target</th>
								<th>Expires</th>
								<th class="text-right">Actions</th>
							</tr>
						</thead>
						<tbody>
							{#each userRoles as role (role.id)}
								<tr>
									<td>
										<span style="font-weight: 500;">
											{role.role_display_name || role.role_name}
										</span>
										{#if role.is_system_role}
											<span class="badge-system">System</span>
										{/if}
									</td>
									<td>
										<span class={getScopeBadgeClass(role.scope)}>{role.scope}</span>
									</td>
									<td class="muted">{role.scope_target || '-'}</td>
									<td class="muted"
										>{role.expires_at ? formatTimestamp(role.expires_at) : 'Never'}</td
									>
									<td class="text-right">
										<button class="btn btn-danger btn-sm" onclick={() => confirmRemoveRole(role)}>
											Remove
										</button>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{:else}
				<div class="empty-state">
					<p class="empty-state-description">No roles assigned to this user</p>
				</div>
			{/if}
		</div>

		<!-- Actions -->
		<div class="panel">
			<h2 class="panel-title">Actions</h2>
			<div class="action-buttons">
				{#if user.status === 'active'}
					<button class="btn btn-warning" onclick={() => openConfirmDialog('suspend')}>
						Suspend User
					</button>
					<button class="btn btn-danger" onclick={() => openConfirmDialog('lock')}>
						Lock Account
					</button>
				{:else if user.status === 'suspended' || user.status === 'locked'}
					<button class="btn btn-success" onclick={() => openConfirmDialog('activate')}>
						Activate User
					</button>
				{/if}
				<button class="btn btn-purple" onclick={() => openConfirmDialog('revoke-sessions')}>
					Revoke All Sessions
				</button>
				<button class="btn btn-danger" onclick={() => openConfirmDialog('delete')}>
					Delete User
				</button>
			</div>
		</div>
	{/if}
</div>

<!-- Confirmation Dialog -->
{#if showConfirmDialog}
	{@const dialogContent = getConfirmDialogContent()}
	<div
		class="modal-overlay"
		onclick={closeConfirmDialog}
		onkeydown={(e) => e.key === 'Escape' && closeConfirmDialog()}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
	>
		<div
			class="modal-content modal-sm"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h3 class="modal-title">
					{revokedSessionsCount !== null ? 'Sessions Revoked' : dialogContent.title}
				</h3>
			</div>
			<div class="modal-body">
				{#if revokedSessionsCount !== null}
					<!-- Success message for revoke-sessions -->
					<div class="alert alert-success">
						Successfully revoked {revokedSessionsCount} session{revokedSessionsCount === 1
							? ''
							: 's'}.
						{#if revokedSessionsCount > 0}
							Active sessions in memory will expire naturally.
						{/if}
					</div>
				{:else}
					<p class="modal-description">{dialogContent.description}</p>
				{/if}
			</div>
			<div class="modal-footer">
				{#if revokedSessionsCount !== null}
					<button class="btn btn-primary" onclick={closeConfirmDialog}>Close</button>
				{:else}
					<button class="btn btn-secondary" onclick={closeConfirmDialog} disabled={confirmLoading}>
						Cancel
					</button>
					<button
						class="btn {confirmAction === 'activate'
							? 'btn-success'
							: confirmAction === 'suspend'
								? 'btn-warning'
								: 'btn-danger'}"
						onclick={executeAction}
						disabled={confirmLoading}
					>
						{confirmLoading ? 'Processing...' : dialogContent.buttonText}
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<!-- Assign Role Dialog -->
{#if showAssignRoleDialog}
	<div
		class="modal-overlay"
		onclick={closeAssignRoleDialog}
		onkeydown={(e) => e.key === 'Escape' && closeAssignRoleDialog()}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
	>
		<div
			class="modal-content modal-md"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h3 class="modal-title">Assign Role</h3>
			</div>

			<div class="modal-body">
				{#if rolesError}
					<div class="alert alert-error">{rolesError}</div>
				{/if}

				{#if assignStep === 'select-role'}
					<!-- Step 1: Select Role -->
					<p class="step-indicator">Step 1 of 2: Select Role</p>
					<div class="form-group">
						<label for="role-select" class="form-label">Select a role to assign</label>
						<select id="role-select" class="form-select" bind:value={selectedRoleId}>
							<option value="">-- Select a role --</option>
							{#each availableRoles as role (role.id)}
								<option value={role.id}>
									{role.display_name || role.name}
									{role.is_system ? '(System)' : ''}
								</option>
							{/each}
						</select>
					</div>
				{:else}
					<!-- Step 2: Select Scope -->
					<p class="step-indicator">Step 2 of 2: Select Scope</p>
					<div class="form-group">
						<label class="form-label">Select scope for this role</label>
						<div class="scope-options">
							<label class="scope-option" class:selected={selectedScope === 'global'}>
								<input type="radio" value="global" bind:group={selectedScope} />
								<div class="scope-option-content">
									<span>Global</span>
									<p>Role applies across all organizations</p>
								</div>
							</label>
							<label class="scope-option" class:selected={selectedScope === 'org'}>
								<input type="radio" value="org" bind:group={selectedScope} />
								<div class="scope-option-content">
									<span>Organization</span>
									<p>Role applies only within a specific organization</p>
								</div>
							</label>
						</div>
					</div>

					{#if selectedScope === 'org'}
						<div class="form-group">
							<label class="form-label">Select Organization</label>
							<div class="org-selector">
								{#if selectedOrgName}
									<span class="org-selector-name">{selectedOrgName}</span>
								{:else}
									<span class="org-selector-placeholder">No organization selected</span>
								{/if}
								<button class="btn btn-primary btn-sm" onclick={openOrgSelectDialog}>
									{selectedOrgId ? 'Change' : 'Select'}
								</button>
							</div>
						</div>
					{/if}
				{/if}
			</div>

			<div class="modal-footer">
				{#if assignStep === 'select-role'}
					<button class="btn btn-secondary" onclick={closeAssignRoleDialog}>Cancel</button>
					<button class="btn btn-primary" onclick={goToScopeStep} disabled={!selectedRoleId}>
						Next
					</button>
				{:else}
					<button class="btn btn-secondary" onclick={goBackToRoleStep} disabled={assignLoading}>
						Back
					</button>
					<button
						class="btn btn-success"
						onclick={assignRole}
						disabled={assignLoading || (selectedScope === 'org' && !selectedOrgId)}
					>
						{assignLoading ? 'Assigning...' : 'Assign Role'}
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<!-- Remove Role Confirmation Dialog -->
{#if showRemoveRoleDialog && roleToRemove}
	<div
		class="modal-overlay"
		onclick={closeRemoveRoleDialog}
		onkeydown={(e) => e.key === 'Escape' && closeRemoveRoleDialog()}
		role="dialog"
		aria-modal="true"
		tabindex="-1"
	>
		<div
			class="modal-content modal-sm"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h3 class="modal-title">Remove Role</h3>
			</div>
			<div class="modal-body">
				<p class="modal-description">
					Are you sure you want to remove the role <strong
						>{sanitizeText(roleToRemove.role_display_name || roleToRemove.role_name || '')}</strong
					>
					{#if roleToRemove.scope !== 'global'}
						(scope: {sanitizeText(roleToRemove.scope_target || '')})
					{/if}
					from this user?
				</p>
			</div>
			<div class="modal-footer">
				<button
					class="btn btn-secondary"
					onclick={closeRemoveRoleDialog}
					disabled={removeRoleLoading}
				>
					Cancel
				</button>
				<button class="btn btn-danger" onclick={removeRole} disabled={removeRoleLoading}>
					{removeRoleLoading ? 'Removing...' : 'Remove Role'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Organization Select Dialog -->
<OrganizationSelectDialog
	open={showOrgSelectDialog}
	onClose={() => (showOrgSelectDialog = false)}
	onSelect={handleOrgSelect}
	title="Select Organization for Role Scope"
/>
