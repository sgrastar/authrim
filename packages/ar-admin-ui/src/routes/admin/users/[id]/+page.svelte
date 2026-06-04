<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { getLocale, LL } from '$i18n/i18n-svelte';
	import { adminUsersAPI, type User, type UpdateUserInput } from '$lib/api/admin-users';
	import { adminSessionsAPI } from '$lib/api/admin-sessions';
	import {
		adminRolesAPI,
		type Role,
		type RoleAssignment,
		type ScopeType
	} from '$lib/api/admin-roles';
	import {
		adminConsentStatementsAPI,
		type UserConsentRecord,
		type ConsentItemHistory
	} from '$lib/api/admin-consent-statements';
	import OrganizationSelectDialog from '$lib/components/OrganizationSelectDialog.svelte';
	import { Modal, ToggleSwitch } from '$lib/components';
	import type { OrganizationNode } from '$lib/api/admin-organizations';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
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

	// Tab management
	type TabId = 'overview' | 'roles' | 'consents' | 'actions';
	let activeTab = $state<TabId>('overview');

	// Consent records state
	let consentRecords = $state<UserConsentRecord[]>([]);
	let consentLoading = $state(false);
	let consentError = $state('');

	// Consent history modal
	let showHistoryModal = $state(false);
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	let selectedStatementForHistory = $state<string | null>(null);
	let consentHistory = $state<ConsentItemHistory[]>([]);
	let historyLoading = $state(false);

	// Withdraw consent modal
	let showWithdrawModal = $state(false);
	let statementToWithdraw = $state<{ id: string; version: string } | null>(null);
	let withdrawLoading = $state(false);
	let loadedTenantId = $state('');

	const userId = $derived($page.params.id ?? '');

	async function loadUser() {
		loading = true;
		error = '';

		try {
			user = await adminUsersAPI.get(userId);
			resetEditForm();
		} catch (err) {
			console.error('Failed to load user:', err);
			error = err instanceof Error ? err.message : $LL.admin_user_detail_error_load();
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

	onMount(async () => {
		await settingsContext.initialize();
	});

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (!tenantId || tenantId === loadedTenantId) return;
		loadedTenantId = tenantId;
		user = null;
		error = '';
		actionError = '';
		rolesError = '';
		consentError = '';
		consentRecords = [];
		consentHistory = [];
		showHistoryModal = false;
		showWithdrawModal = false;
		statementToWithdraw = null;
		loadUser();
		loadUserRoles();
		loadAvailableRoles();
		if (activeTab === 'consents') {
			loadConsentRecords();
		}
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
			rolesError = err instanceof Error ? err.message : $LL.admin_user_detail_error_load_roles();
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
			rolesError = $LL.admin_user_detail_error_select_org();
			return;
		}
		if (selectedScope === 'org' && selectedOrgId && !isValidUUID(selectedOrgId)) {
			rolesError = $LL.admin_user_detail_error_invalid_org();
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
			rolesError = err instanceof Error ? err.message : $LL.admin_user_detail_error_assign_role();
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
			rolesError = err instanceof Error ? err.message : $LL.admin_user_detail_error_remove_role();
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
			actionError = err instanceof Error ? err.message : $LL.admin_user_detail_error_update();
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
			actionError = err instanceof Error ? err.message : $LL.admin_user_detail_error_update();
		} finally {
			confirmLoading = false;
		}
	}

	function formatTimestamp(timestamp: number | null): string {
		if (!timestamp) return '-';
		return new Date(timestamp).toLocaleString(getLocale() === 'ja' ? 'ja-JP' : 'en-US');
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

	// Tab switching - load consent records on first access to consents tab
	function switchTab(tab: TabId) {
		activeTab = tab;
		if (tab === 'consents' && consentRecords.length === 0 && !consentLoading) {
			loadConsentRecords();
		}
	}

	// Consent records loading
	async function loadConsentRecords() {
		consentLoading = true;
		consentError = '';
		try {
			const response = await adminConsentStatementsAPI.listUserConsentRecords(userId);
			consentRecords = response.records || [];
		} catch (err) {
			console.error('Failed to load consent records:', err);
			consentError =
				err instanceof Error ? err.message : $LL.admin_user_detail_error_load_consents();
		} finally {
			consentLoading = false;
		}
	}

	// Consent history loading
	async function loadConsentHistory(statementId: string) {
		historyLoading = true;
		consentError = '';
		try {
			const response = await adminConsentStatementsAPI.getUserConsentHistory(userId, statementId);
			consentHistory = response.history || [];
			showHistoryModal = true;
		} catch (err) {
			console.error('Failed to load consent history:', err);
			consentError =
				err instanceof Error ? err.message : $LL.admin_user_detail_error_load_history();
		} finally {
			historyLoading = false;
		}
	}

	// Withdraw consent
	async function handleWithdrawConsent() {
		if (!statementToWithdraw) return;

		withdrawLoading = true;
		consentError = '';
		try {
			await adminConsentStatementsAPI.withdrawUserConsent(userId, statementToWithdraw.id);
			await loadConsentRecords();
			showWithdrawModal = false;
			statementToWithdraw = null;
		} catch (err) {
			console.error('Failed to withdraw consent:', err);
			consentError =
				err instanceof Error ? err.message : $LL.admin_user_detail_error_withdraw_consent();
		} finally {
			withdrawLoading = false;
		}
	}

	// Consent status badge helpers
	function getConsentStatusBadgeClass(status: string): string {
		switch (status) {
			case 'granted':
				return 'badge badge-success';
			case 'denied':
				return 'badge badge-danger';
			case 'withdrawn':
				return 'badge badge-warning';
			case 'expired':
				return 'badge badge-neutral';
			default:
				return 'badge badge-neutral';
		}
	}

	function getConsentStatusLabel(status: string): string {
		switch (status) {
			case 'granted':
				return $LL.admin_user_detail_status_granted();
			case 'denied':
				return $LL.admin_user_detail_status_denied();
			case 'withdrawn':
				return $LL.admin_user_detail_status_withdrawn();
			case 'expired':
				return $LL.admin_user_detail_status_expired();
			default:
				return status;
		}
	}

	// History action label helper
	function getActionLabel(action: string): string {
		switch (action) {
			case 'grant':
				return $LL.admin_user_detail_status_granted();
			case 'deny':
				return $LL.admin_user_detail_status_denied();
			case 'withdraw':
				return $LL.admin_user_detail_status_withdrawn();
			case 'version_upgrade':
				return $LL.admin_user_detail_action_version_upgraded();
			default:
				return action;
		}
	}

	function getStatusLabel(status: string): string {
		switch (status) {
			case 'active':
				return $LL.admin_users_status_active();
			case 'suspended':
				return $LL.admin_users_status_suspended();
			case 'locked':
				return $LL.admin_users_status_locked();
			default:
				return status;
		}
	}

	function getScopeLabel(scope: ScopeType): string {
		switch (scope) {
			case 'global':
				return $LL.admin_user_detail_scope_global();
			case 'org':
				return $LL.admin_user_detail_scope_org();
			case 'resource':
			default:
				return scope;
		}
	}

	function formatYesNo(value: boolean): string {
		return value ? $LL.admin_user_detail_yes() : $LL.admin_user_detail_no();
	}

	function getConfirmDialogContent() {
		switch (confirmAction) {
			case 'suspend':
				return {
					title: $LL.admin_user_detail_suspend_user(),
					description: $LL.admin_user_detail_suspend_desc(),
					buttonText: $LL.admin_user_detail_suspend_action(),
					buttonColor: '#f59e0b'
				};
			case 'lock':
				return {
					title: $LL.admin_user_detail_lock_account(),
					description: $LL.admin_user_detail_lock_desc(),
					buttonText: $LL.admin_user_detail_lock_action(),
					buttonColor: '#ef4444'
				};
			case 'activate':
				return {
					title: $LL.admin_user_detail_activate_user(),
					description: $LL.admin_user_detail_activate_desc(),
					buttonText: $LL.admin_user_detail_activate_action(),
					buttonColor: '#10b981'
				};
			case 'revoke-sessions':
				return {
					title: $LL.admin_user_detail_revoke_all_sessions(),
					description: $LL.admin_user_detail_revoke_sessions_desc(),
					buttonText: $LL.admin_user_detail_revoke_all_action(),
					buttonColor: '#dc2626'
				};
			case 'delete':
				return {
					title: $LL.admin_user_detail_deleteUser(),
					description: $LL.admin_user_detail_delete_desc(),
					buttonText: $LL.admin_users_delete(),
					buttonColor: '#dc2626'
				};
			default:
				return { title: '', description: '', buttonText: '', buttonColor: '' };
		}
	}
</script>

<svelte:head>
	<title
		>{user?.email || $LL.admin_user_detail_page_title_fallback()} - Admin Dashboard - Authrim</title
	>
</svelte:head>

<div class="admin-page">
	<a href="/admin/users" class="back-link">← {$LL.admin_users_back_to_users()}</a>

	{#if loading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_user_detail_loading()}</p>
		</div>
	{:else if error}
		<div class="alert alert-error">{error}</div>
	{:else if user}
		<!-- User Header -->
		<div class="page-header-with-status">
			<div class="page-header-info">
				<h1>{sanitizeText(user.name || user.email || $LL.admin_user_detail_unknown_user())}</h1>
				<p>{sanitizeText(user.email || '')}</p>
			</div>
			<span class={getStatusBadgeClass(user.status)}>{getStatusLabel(user.status)}</span>
		</div>

		{#if actionError}
			<div class="alert alert-error">{actionError}</div>
		{/if}

		<!-- Tab Navigation -->
		<div class="tabs">
			<button
				class="tab"
				class:active={activeTab === 'overview'}
				onclick={() => switchTab('overview')}
			>
				<i class="i-ph-user"></i>
				{$LL.admin_user_detail_tab_overview()}
			</button>
			<button class="tab" class:active={activeTab === 'roles'} onclick={() => switchTab('roles')}>
				<i class="i-ph-shield-check"></i>
				{$LL.admin_user_detail_tab_roles()}
			</button>
			<button
				class="tab"
				class:active={activeTab === 'consents'}
				onclick={() => switchTab('consents')}
			>
				<i class="i-ph-check-circle"></i>
				{$LL.admin_user_detail_tab_consents()}
			</button>
			<button
				class="tab"
				class:active={activeTab === 'actions'}
				onclick={() => switchTab('actions')}
			>
				<i class="i-ph-gear"></i>
				{$LL.admin_user_detail_tab_actions()}
			</button>
		</div>

		<!-- Overview Tab -->
		{#if activeTab === 'overview'}
			<!-- User Details -->
			<div class="panel">
				<div class="panel-header">
					<h2 class="panel-title">{$LL.admin_user_detail_user_information()}</h2>
					{#if !isEditing}
						<button class="btn btn-primary btn-sm" onclick={startEditing}
							>{$LL.admin_users_edit()}</button
						>
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
								<label for="email" class="form-label">{$LL.admin_users_email()}</label>
								<input id="email" type="email" class="form-input" bind:value={editForm.email} />
							</div>
							<div class="form-group">
								<label for="name" class="form-label">{$LL.admin_users_name()}</label>
								<input id="name" type="text" class="form-input" bind:value={editForm.name} />
							</div>
							<div class="form-group">
								<label for="given_name" class="form-label">{$LL.admin_users_given_name()}</label>
								<input
									id="given_name"
									type="text"
									class="form-input"
									bind:value={editForm.given_name}
								/>
							</div>
							<div class="form-group">
								<label for="family_name" class="form-label">{$LL.admin_users_family_name()}</label>
								<input
									id="family_name"
									type="text"
									class="form-input"
									bind:value={editForm.family_name}
								/>
							</div>
							<div class="form-group">
								<label for="nickname" class="form-label">{$LL.admin_user_detail_nickname()}</label>
								<input
									id="nickname"
									type="text"
									class="form-input"
									bind:value={editForm.nickname}
								/>
							</div>
							<div class="form-group">
								<label for="preferred_username" class="form-label"
									>{$LL.admin_user_detail_preferred_username()}</label
								>
								<input
									id="preferred_username"
									type="text"
									class="form-input"
									bind:value={editForm.preferred_username}
								/>
							</div>
							<div class="form-group">
								<label for="phone_number" class="form-label"
									>{$LL.admin_user_detail_phone_number()}</label
								>
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
									label={$LL.admin_users_verified_label()}
									description={$LL.admin_user_detail_email_verified_desc()}
								/>
							</div>
							<div class="form-group form-group-full">
								<ToggleSwitch
									bind:checked={editForm.phone_number_verified}
									label={$LL.admin_user_detail_phone_verified()}
									description={$LL.admin_user_detail_phone_verified_desc()}
								/>
							</div>
						</div>
						<div class="action-buttons" style="margin-top: 20px;">
							<button type="submit" class="btn btn-primary" disabled={saving}>
								{saving ? $LL.admin_client_detail_saving() : $LL.admin_user_detail_save()}
							</button>
							<button
								type="button"
								class="btn btn-secondary"
								onclick={cancelEditing}
								disabled={saving}
							>
								{$LL.dialog_cancel()}
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
							<dt>{$LL.admin_users_email()}</dt>
							<dd class="info-value">{sanitizeText(user.email || '-')}</dd>
						</div>
						<div class="info-item">
							<dt>{$LL.admin_users_name()}</dt>
							<dd class="info-value">{sanitizeText(user.name || '-')}</dd>
						</div>
						<div class="info-item">
							<dt>{$LL.admin_users_given_name()}</dt>
							<dd class="info-value">{sanitizeText(user.given_name || '-')}</dd>
						</div>
						<div class="info-item">
							<dt>{$LL.admin_users_family_name()}</dt>
							<dd class="info-value">{sanitizeText(user.family_name || '-')}</dd>
						</div>
						<div class="info-item">
							<dt>{$LL.admin_user_detail_nickname()}</dt>
							<dd class="info-value">{sanitizeText(user.nickname || '-')}</dd>
						</div>
						<div class="info-item">
							<dt>{$LL.admin_user_detail_preferred_username()}</dt>
							<dd class="info-value">{sanitizeText(user.preferred_username || '-')}</dd>
						</div>
						<div class="info-item">
							<dt>{$LL.admin_user_detail_phone_number()}</dt>
							<dd class="info-value">{sanitizeText(user.phone_number || '-')}</dd>
						</div>
						<div class="info-item">
							<dt>{$LL.admin_user_detail_user_type()}</dt>
							<dd class="info-value">{user.user_type}</dd>
						</div>
						<div class="info-item">
							<dt>{$LL.admin_users_verified_label()}</dt>
							<dd class="info-value">
								{#if user.email_verified}
									<span class="verify-yes">✓ {formatYesNo(true)}</span>
								{:else}
									<span class="verify-no">✗ {formatYesNo(false)}</span>
								{/if}
							</dd>
						</div>
						<div class="info-item">
							<dt>{$LL.admin_user_detail_phone_verified()}</dt>
							<dd class="info-value">
								{#if user.phone_number_verified}
									<span class="verify-yes">✓ {formatYesNo(true)}</span>
								{:else}
									<span class="verify-no">✗ {formatYesNo(false)}</span>
								{/if}
							</dd>
						</div>
					</dl>
				{/if}
			</div>

			<!-- Timestamps -->
			<div class="panel">
				<h2 class="panel-title">{$LL.admin_user_detail_timestamps()}</h2>
				<dl class="info-grid">
					<div class="info-item">
						<dt>{$LL.admin_user_detail_created_at()}</dt>
						<dd class="info-value">{formatTimestamp(user.created_at)}</dd>
					</div>
					<div class="info-item">
						<dt>{$LL.admin_user_detail_updated_at()}</dt>
						<dd class="info-value">{formatTimestamp(user.updated_at)}</dd>
					</div>
					<div class="info-item">
						<dt>{$LL.admin_user_detail_last_login_at()}</dt>
						<dd class="info-value">{formatTimestamp(user.last_login_at)}</dd>
					</div>
					{#if user.suspended_at}
						<div class="info-item">
							<dt>{$LL.admin_user_detail_suspended_at()}</dt>
							<dd class="info-value warning">{formatTimestamp(user.suspended_at)}</dd>
						</div>
					{/if}
					{#if user.locked_at}
						<div class="info-item">
							<dt>{$LL.admin_user_detail_locked_at()}</dt>
							<dd class="info-value danger">{formatTimestamp(user.locked_at)}</dd>
						</div>
					{/if}
				</dl>
			</div>

			<!-- Passkeys -->
			<div class="panel">
				<h2 class="panel-title">{$LL.admin_user_detail_passkeys()}</h2>
				{#if user.passkeys && user.passkeys.length > 0}
					<ul class="passkey-list">
						{#each user.passkeys as passkey (passkey.id)}
							<li class="passkey-item">
								<div class="passkey-header">
									<div>
										<p class="passkey-name">
											{sanitizeText(passkey.device_name || $LL.admin_user_detail_unnamed_device())}
										</p>
										<p class="passkey-meta">
											{$LL.admin_user_detail_passkey_created({
												date: formatTimestamp(passkey.created_at)
											})}
										</p>
									</div>
									<p class="passkey-meta">
										{$LL.admin_user_detail_passkey_last_used({
											date: formatTimestamp(passkey.last_used_at)
										})}
									</p>
								</div>
							</li>
						{/each}
					</ul>
				{:else}
					<div class="empty-state">
						<p class="empty-state-description">{$LL.admin_user_detail_no_passkeys()}</p>
					</div>
				{/if}
			</div>
		{/if}

		<!-- Roles Tab -->
		{#if activeTab === 'roles'}
			<!-- Role Assignments -->
			<div class="panel">
				<div class="panel-header">
					<h2 class="panel-title">{$LL.admin_user_detail_role_assignments()}</h2>
					<button class="btn btn-primary btn-sm" onclick={openAssignRoleDialog}
						>{$LL.admin_user_detail_assign_role()}</button
					>
				</div>

				{#if rolesError}
					<div class="alert alert-error">{rolesError}</div>
				{/if}

				{#if rolesLoading}
					<div class="loading-state">
						<i class="i-ph-circle-notch loading-spinner"></i>
						<p>{$LL.admin_user_detail_loading_roles()}</p>
					</div>
				{:else if userRoles.length > 0}
					<div class="data-table-container">
						<table class="data-table">
							<thead>
								<tr>
									<th>{$LL.admin_user_detail_role()}</th>
									<th>{$LL.admin_user_detail_scope()}</th>
									<th>{$LL.admin_user_detail_scope_target()}</th>
									<th>{$LL.admin_user_detail_expires()}</th>
									<th class="text-right">{$LL.admin_users_actions()}</th>
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
												<span class="badge-system">{$LL.admin_user_detail_system()}</span>
											{/if}
										</td>
										<td>
											<span class={getScopeBadgeClass(role.scope)}>{getScopeLabel(role.scope)}</span
											>
										</td>
										<td class="muted">{role.scope_target || '-'}</td>
										<td class="muted"
											>{role.expires_at
												? formatTimestamp(role.expires_at)
												: $LL.admin_user_detail_never()}</td
										>
										<td class="text-right">
											<button class="btn btn-danger btn-sm" onclick={() => confirmRemoveRole(role)}>
												{$LL.admin_user_detail_remove()}
											</button>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{:else}
					<div class="empty-state">
						<p class="empty-state-description">{$LL.admin_user_detail_no_roles()}</p>
					</div>
				{/if}
			</div>
		{/if}

		<!-- Consents Tab -->
		{#if activeTab === 'consents'}
			<div class="panel">
				<h2 class="panel-title">{$LL.admin_user_detail_consent_records()}</h2>

				{#if consentError}
					<div class="alert alert-error">{consentError}</div>
				{/if}

				{#if consentLoading}
					<div class="loading-state">
						<i class="i-ph-circle-notch loading-spinner"></i>
						<p>{$LL.admin_user_detail_loading_consent_records()}</p>
					</div>
				{:else if consentRecords.length > 0}
					<div class="data-table-container">
						<table class="data-table">
							<thead>
								<tr>
									<th>{$LL.admin_user_detail_statement()}</th>
									<th>{$LL.admin_user_detail_version()}</th>
									<th>{$LL.admin_users_status()}</th>
									<th>{$LL.admin_user_detail_granted_at()}</th>
									<th>{$LL.admin_user_detail_withdrawn_at()}</th>
									<th>{$LL.admin_user_detail_expires_at()}</th>
									<th class="text-right">{$LL.admin_users_actions()}</th>
								</tr>
							</thead>
							<tbody>
								{#each consentRecords as record (record.id)}
									<tr>
										<td><span style="font-weight: 500;">{record.statement_id}</span></td>
										<td class="muted">{record.version}</td>
										<td>
											<span class={getConsentStatusBadgeClass(record.status)}>
												{getConsentStatusLabel(record.status)}
											</span>
										</td>
										<td class="muted">{formatTimestamp(record.granted_at ?? null)}</td>
										<td class="muted">{formatTimestamp(record.withdrawn_at ?? null)}</td>
										<td class="muted">{formatTimestamp(record.expires_at ?? null)}</td>
										<td class="text-right">
											<button
												class="btn btn-secondary btn-sm"
												onclick={() => {
													selectedStatementForHistory = record.statement_id;
													loadConsentHistory(record.statement_id);
												}}
											>
												{$LL.admin_user_detail_history()}
											</button>
											{#if record.status === 'granted'}
												<button
													class="btn btn-danger btn-sm"
													onclick={() => {
														statementToWithdraw = {
															id: record.statement_id,
															version: record.version
														};
														showWithdrawModal = true;
													}}
												>
													{$LL.admin_user_detail_withdraw()}
												</button>
											{/if}
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{:else}
					<div class="empty-state">
						<p class="empty-state-description">{$LL.admin_user_detail_no_consent_records()}</p>
					</div>
				{/if}
			</div>
		{/if}

		<!-- Actions Tab -->
		{#if activeTab === 'actions'}
			<div class="panel">
				<h2 class="panel-title">{$LL.admin_user_detail_tab_actions()}</h2>
				<div class="action-buttons">
					{#if user.status === 'active'}
						<button class="btn btn-warning" onclick={() => openConfirmDialog('suspend')}>
							{$LL.admin_user_detail_suspend_user()}
						</button>
						<button class="btn btn-danger" onclick={() => openConfirmDialog('lock')}>
							{$LL.admin_user_detail_lock_account()}
						</button>
					{:else if user.status === 'suspended' || user.status === 'locked'}
						<button class="btn btn-success" onclick={() => openConfirmDialog('activate')}>
							{$LL.admin_user_detail_activate_user()}
						</button>
					{/if}
					<button class="btn btn-purple" onclick={() => openConfirmDialog('revoke-sessions')}>
						{$LL.admin_user_detail_revoke_all_sessions()}
					</button>
					<button class="btn btn-danger" onclick={() => openConfirmDialog('delete')}>
						{$LL.admin_user_detail_deleteUser()}
					</button>
				</div>
			</div>
		{/if}
	{/if}
</div>

<!-- Confirmation Dialog -->
{#if showConfirmDialog}
	{@const dialogContent = getConfirmDialogContent()}
	<Modal
		open={showConfirmDialog}
		onClose={closeConfirmDialog}
		title={revokedSessionsCount !== null
			? $LL.admin_user_detail_sessions_revoked()
			: dialogContent.title}
		size="sm"
	>
		{#if revokedSessionsCount !== null}
			<!-- Success message for revoke-sessions -->
			<div class="alert alert-success">
				{$LL.admin_user_detail_sessions_revoked_message({
					count: revokedSessionsCount,
					plural: revokedSessionsCount === 1 ? '' : 's'
				})}
				{#if revokedSessionsCount > 0}
					{$LL.admin_user_detail_sessions_expire_naturally()}
				{/if}
			</div>
		{:else}
			<p class="modal-description">{dialogContent.description}</p>
		{/if}
		{#snippet footer()}
			{#if revokedSessionsCount !== null}
				<button class="btn btn-primary" onclick={closeConfirmDialog}>{$LL.dialog_close()}</button>
			{:else}
				<button class="btn btn-secondary" onclick={closeConfirmDialog} disabled={confirmLoading}>
					{$LL.dialog_cancel()}
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
					{confirmLoading ? $LL.admin_user_detail_processing() : dialogContent.buttonText}
				</button>
			{/if}
		{/snippet}
	</Modal>
{/if}

<!-- Assign Role Dialog -->
<Modal
	open={showAssignRoleDialog}
	onClose={closeAssignRoleDialog}
	title={$LL.admin_user_detail_assign_role()}
	size="md"
>
	{#if rolesError}
		<div class="alert alert-error">{rolesError}</div>
	{/if}

	{#if assignStep === 'select-role'}
		<!-- Step 1: Select Role -->
		<p class="step-indicator">{$LL.admin_user_detail_assign_step_role()}</p>
		<div class="form-group">
			<label for="role-select" class="form-label">{$LL.admin_user_detail_select_role_label()}</label
			>
			<select id="role-select" class="form-select" bind:value={selectedRoleId}>
				<option value="">{$LL.admin_user_detail_select_role_placeholder()}</option>
				{#each availableRoles as role (role.id)}
					<option value={role.id}>
						{role.display_name || role.name}
						{role.is_system ? `(${$LL.admin_user_detail_system()})` : ''}
					</option>
				{/each}
			</select>
		</div>
	{:else}
		<!-- Step 2: Select Scope -->
		<p class="step-indicator">{$LL.admin_user_detail_assign_step_scope()}</p>
		<div class="form-group">
			<!-- svelte-ignore a11y_label_has_associated_control -->
			<label class="form-label">{$LL.admin_user_detail_scope_label()}</label>
			<div class="scope-options">
				<label class="scope-option" class:selected={selectedScope === 'global'}>
					<input type="radio" value="global" bind:group={selectedScope} />
					<div class="scope-option-content">
						<span>{$LL.admin_user_detail_scope_global()}</span>
						<p>{$LL.admin_user_detail_scope_global_desc()}</p>
					</div>
				</label>
				<label class="scope-option" class:selected={selectedScope === 'org'}>
					<input type="radio" value="org" bind:group={selectedScope} />
					<div class="scope-option-content">
						<span>{$LL.admin_user_detail_scope_org()}</span>
						<p>{$LL.admin_user_detail_scope_org_desc()}</p>
					</div>
				</label>
			</div>
		</div>

		{#if selectedScope === 'org'}
			<div class="form-group">
				<!-- svelte-ignore a11y_label_has_associated_control -->
				<label class="form-label">{$LL.admin_user_detail_select_organization()}</label>
				<div class="org-selector">
					{#if selectedOrgName}
						<span class="org-selector-name">{selectedOrgName}</span>
					{:else}
						<span class="org-selector-placeholder">
							{$LL.admin_user_detail_no_organization_selected()}
						</span>
					{/if}
					<button class="btn btn-primary btn-sm" onclick={openOrgSelectDialog}>
						{selectedOrgId ? $LL.admin_user_detail_change() : $LL.admin_user_detail_select()}
					</button>
				</div>
			</div>
		{/if}
	{/if}
	{#snippet footer()}
		{#if assignStep === 'select-role'}
			<button class="btn btn-secondary" onclick={closeAssignRoleDialog}
				>{$LL.dialog_cancel()}</button
			>
			<button class="btn btn-primary" onclick={goToScopeStep} disabled={!selectedRoleId}>
				{$LL.common_next()}
			</button>
		{:else}
			<button class="btn btn-secondary" onclick={goBackToRoleStep} disabled={assignLoading}>
				{$LL.common_previous()}
			</button>
			<button
				class="btn btn-success"
				onclick={assignRole}
				disabled={assignLoading || (selectedScope === 'org' && !selectedOrgId)}
			>
				{assignLoading ? $LL.admin_user_detail_assigning() : $LL.admin_user_detail_assign_role()}
			</button>
		{/if}
	{/snippet}
</Modal>

<!-- Remove Role Confirmation Dialog -->
<Modal
	open={showRemoveRoleDialog && !!roleToRemove}
	onClose={closeRemoveRoleDialog}
	title={$LL.admin_user_detail_remove_role_title()}
	size="sm"
>
	<p class="modal-description">
		{$LL.admin_user_detail_remove_role_desc({
			role: sanitizeText(roleToRemove?.role_display_name || roleToRemove?.role_name || ''),
			scope:
				roleToRemove?.scope !== 'global'
					? $LL.admin_user_detail_remove_role_scope({
							scope: sanitizeText(roleToRemove?.scope_target || '')
						})
					: ''
		})}
	</p>
	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeRemoveRoleDialog} disabled={removeRoleLoading}>
			{$LL.dialog_cancel()}
		</button>
		<button class="btn btn-danger" onclick={removeRole} disabled={removeRoleLoading}>
			{removeRoleLoading
				? $LL.admin_user_detail_removing()
				: $LL.admin_user_detail_remove_role_title()}
		</button>
	{/snippet}
</Modal>

<!-- Organization Select Dialog -->
<OrganizationSelectDialog
	open={showOrgSelectDialog}
	onClose={() => (showOrgSelectDialog = false)}
	onSelect={handleOrgSelect}
	title={$LL.admin_user_detail_select_org_title()}
/>

<!-- Consent History Modal -->
<Modal
	open={showHistoryModal}
	onClose={() => {
		showHistoryModal = false;
		selectedStatementForHistory = null;
		consentHistory = [];
	}}
	title={$LL.admin_user_detail_consent_history()}
	size="lg"
>
	{#if historyLoading}
		<div class="loading-state">
			<i class="i-ph-circle-notch loading-spinner"></i>
			<p>{$LL.admin_user_detail_loading_history()}</p>
		</div>
	{:else if consentHistory.length > 0}
		<div class="data-table-container">
			<table class="data-table">
				<thead>
					<tr>
						<th>{$LL.admin_user_detail_action()}</th>
						<th>{$LL.admin_user_detail_version()}</th>
						<th>{$LL.admin_user_detail_status_change()}</th>
						<th>{$LL.admin_user_detail_timestamp()}</th>
						<th>{$LL.admin_user_detail_client()}</th>
					</tr>
				</thead>
				<tbody>
					{#each consentHistory as item (item.id)}
						<tr>
							<td><span style="font-weight: 500;">{getActionLabel(item.action)}</span></td>
							<td class="muted">
								{#if item.version_before !== item.version_after}
									{item.version_before || '-'} → {item.version_after || '-'}
								{:else}
									{item.version_after || '-'}
								{/if}
							</td>
							<td class="muted">
								{#if item.status_before !== item.status_after}
									{item.status_before || '-'} → {item.status_after || '-'}
								{:else}
									{item.status_after || '-'}
								{/if}
							</td>
							<td class="muted">{formatTimestamp(item.created_at)}</td>
							<td class="muted">{item.client_id || '-'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<div class="empty-state">
			<p class="empty-state-description">{$LL.admin_user_detail_no_history()}</p>
		</div>
	{/if}

	{#snippet footer()}
		<button
			class="btn btn-secondary"
			onclick={() => {
				showHistoryModal = false;
				selectedStatementForHistory = null;
				consentHistory = [];
			}}
		>
			{$LL.dialog_close()}
		</button>
	{/snippet}
</Modal>

<!-- Withdraw Consent Confirmation Modal -->
<Modal
	open={showWithdrawModal}
	onClose={() => {
		showWithdrawModal = false;
		statementToWithdraw = null;
	}}
	title={$LL.admin_user_detail_withdraw_consent_title()}
	size="sm"
>
	<p class="modal-description">
		{$LL.admin_user_detail_withdraw_consent_desc({
			statement: statementToWithdraw?.id ?? '',
			version: statementToWithdraw?.version ?? ''
		})}
	</p>

	{#snippet footer()}
		<button
			class="btn btn-secondary"
			onclick={() => {
				showWithdrawModal = false;
				statementToWithdraw = null;
			}}
			disabled={withdrawLoading}
		>
			{$LL.dialog_cancel()}
		</button>
		<button class="btn btn-danger" onclick={handleWithdrawConsent} disabled={withdrawLoading}>
			{withdrawLoading
				? $LL.admin_user_detail_withdrawing()
				: $LL.admin_user_detail_withdraw_consent_title()}
		</button>
	{/snippet}
</Modal>
