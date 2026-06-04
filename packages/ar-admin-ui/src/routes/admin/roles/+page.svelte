<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { LL } from '$i18n/i18n-svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		adminRolesAPI,
		type Role,
		getRoleType,
		canDeleteRole,
		type RoleType
	} from '$lib/api/admin-roles';
	import RoleAssignmentRules from '$lib/components/admin/RoleAssignmentRules.svelte';
	import { Modal } from '$lib/components';
	import { formatRoleFilterType, formatRoleType } from '$lib/admin/roles-i18n';

	let roles: Role[] = $state([]);
	let loading = $state(true);
	let error = $state('');

	// Tab state - 'roles' or 'rules'
	let activeTab = $derived($page.url.searchParams.get('tab') || 'roles');

	// Filter state
	let filterType: 'all' | RoleType = $state('all');

	// Delete confirmation dialog state
	let showDeleteDialog = $state(false);
	let roleToDelete: Role | null = $state(null);
	let deleting = $state(false);
	let deleteError = $state('');
	let loadedTenantId = $state('');

	// Filtered roles
	let filteredRoles = $derived.by(() => {
		if (filterType === 'all') {
			return roles;
		}
		return roles.filter((role) => getRoleType(role) === filterType);
	});

	async function loadRoles() {
		loading = true;
		error = '';

		try {
			const response = await adminRolesAPI.list();
			roles = response.roles;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_roles_load_failed();
		} finally {
			loading = false;
		}
	}

	onMount(async () => {
		await settingsContext.initialize();
	});

	$effect(() => {
		const tenantId = settingsContext.tenantId;
		if (!tenantId || tenantId === loadedTenantId) return;
		loadedTenantId = tenantId;
		loadRoles();
	});

	function switchTab(tab: string) {
		const url = new URL($page.url);
		if (tab === 'roles') {
			url.searchParams.delete('tab');
		} else {
			url.searchParams.set('tab', tab);
		}
		goto(url.toString(), { replaceState: true, noScroll: true });
	}

	function navigateToRole(role: Role) {
		goto(`/admin/roles/${role.id}`);
	}

	function navigateToCreate() {
		goto('/admin/roles/new');
	}

	function openDeleteDialog(role: Role, event: Event) {
		event.stopPropagation();
		if (!canDeleteRole(role)) {
			return;
		}
		roleToDelete = role;
		deleteError = '';
		showDeleteDialog = true;
	}

	function closeDeleteDialog() {
		showDeleteDialog = false;
		roleToDelete = null;
		deleteError = '';
	}

	async function confirmDelete() {
		if (!roleToDelete) return;

		deleting = true;
		deleteError = '';

		try {
			// Note: Delete API not implemented yet in backend
			// await adminRolesAPI.delete(roleToDelete.id);
			deleteError = $LL.admin_roles_delete_unavailable();
		} catch (err) {
			deleteError = err instanceof Error ? err.message : $LL.admin_roles_delete_failed();
		} finally {
			deleting = false;
		}
	}

	function getRoleTypeBadgeClass(type: RoleType): string {
		switch (type) {
			case 'system':
				return 'badge badge-info';
			case 'builtin':
				return 'badge badge-neutral';
			case 'custom':
				return 'badge badge-success';
			default:
				return 'badge badge-neutral';
		}
	}

	function formatDate(timestamp: number): string {
		return new Date(timestamp).toLocaleDateString('en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		});
	}
</script>

<svelte:head>
	<title>{$LL.admin_roles_head_title()}</title>
</svelte:head>

<div class="admin-page">
	<!-- Info Banner -->
	<div class="mb-4 bg-blue-50 border border-blue-200 rounded-lg p-4">
		<div class="flex items-start">
			<span class="i-ph-info text-blue-600 text-xl mr-3 mt-0.5"></span>
			<div>
				<h3 class="font-semibold text-blue-900 mb-1">{$LL.admin_roles_end_user_rbac()}</h3>
				<p class="text-sm text-blue-800">
					{$LL.admin_roles_info_banner()}
					<a href="/admin/admin-rbac" class="underline hover:text-blue-900">
						{$LL.admin_roles_admin_rbac()}
					</a>
				</p>
			</div>
		</div>
	</div>

	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_roles_title()}</h1>
			<p class="page-description">{$LL.admin_roles_description()}</p>
		</div>
		{#if activeTab === 'roles'}
			<div class="page-actions">
				<button class="btn btn-primary" onclick={navigateToCreate}>
					<i class="i-ph-plus"></i>
					{$LL.admin_roles_create_role()}
				</button>
			</div>
		{/if}
	</div>

	<!-- Tab Navigation -->
	<div class="tab-nav">
		<button class="tab-btn" class:active={activeTab === 'roles'} onclick={() => switchTab('roles')}>
			<i class="i-ph-shield-check"></i>
			{$LL.admin_roles_tab_roles()}
		</button>
		<button class="tab-btn" class:active={activeTab === 'rules'} onclick={() => switchTab('rules')}>
			<i class="i-ph-git-branch"></i>
			{$LL.admin_roles_tab_rules()}
		</button>
	</div>

	<!-- Tab Content -->
	{#if activeTab === 'roles'}
		<!-- Roles Tab -->
		{#if error}
			<div class="alert alert-error" style="margin-bottom: 16px;">
				{error}
				<button class="btn btn-secondary btn-sm" onclick={loadRoles}>
					{$LL.admin_roles_retry()}
				</button>
			</div>
		{/if}

		<!-- Filter Bar -->
		<div class="filter-bar">
			<span class="filter-label">{$LL.admin_roles_filter()}</span>
			<button
				class="filter-btn"
				class:active={filterType === 'all'}
				onclick={() => (filterType = 'all')}
			>
				{$LL.admin_roles_filter_all()}
			</button>
			<button
				class="filter-btn"
				class:active={filterType === 'system'}
				onclick={() => (filterType = 'system')}
			>
				{$LL.admin_roles_filter_system()}
			</button>
			<button
				class="filter-btn"
				class:active={filterType === 'builtin'}
				onclick={() => (filterType = 'builtin')}
			>
				{$LL.admin_roles_filter_builtin()}
			</button>
			<button
				class="filter-btn"
				class:active={filterType === 'custom'}
				onclick={() => (filterType = 'custom')}
			>
				{$LL.admin_roles_filter_custom()}
			</button>
		</div>

		{#if loading}
			<div class="loading-state">
				<i class="i-ph-circle-notch loading-spinner"></i>
				<p>{$LL.admin_roles_loading()}</p>
			</div>
		{:else if filteredRoles.length === 0}
			<div class="panel">
				<div class="empty-state">
					{#if filterType === 'all'}
						<p class="empty-state-description">{$LL.admin_roles_empty()}</p>
					{:else}
						<p class="empty-state-description">
							{$LL.admin_roles_empty_filtered({
								type: formatRoleFilterType(filterType, $LL)
							})}
						</p>
					{/if}
				</div>
			</div>
		{:else}
			<div class="data-table-container">
				<table class="data-table">
					<thead>
						<tr>
							<th>{$LL.admin_roles_name()}</th>
							<th>{$LL.admin_roles_type()}</th>
							<th>{$LL.admin_roles_description_label()}</th>
							<th>{$LL.admin_roles_created()}</th>
							<th class="text-right">{$LL.admin_roles_actions()}</th>
						</tr>
					</thead>
					<tbody>
						{#each filteredRoles as role (role.id)}
							{@const roleType = getRoleType(role)}
							<tr
								onclick={() => navigateToRole(role)}
								onkeydown={(e) => e.key === 'Enter' && navigateToRole(role)}
								tabindex="0"
								role="button"
							>
								<td>
									<div class="cell-primary">{role.display_name || role.name}</div>
									{#if role.display_name && role.display_name !== role.name}
										<div class="cell-secondary">({role.name})</div>
									{/if}
								</td>
								<td>
									<span class={getRoleTypeBadgeClass(roleType)}
										>{formatRoleType(roleType, $LL)}</span
									>
								</td>
								<td class="muted truncate" style="max-width: 300px;">
									{role.description || '-'}
								</td>
								<td class="muted nowrap">{formatDate(role.created_at)}</td>
								<td class="text-right" onclick={(e) => e.stopPropagation()}>
									<div class="action-buttons">
										<button
											class="btn btn-secondary btn-sm"
											onclick={(e) => {
												e.stopPropagation();
												navigateToRole(role);
											}}
										>
											{$LL.admin_roles_view()}
										</button>
										{#if canDeleteRole(role)}
											<button
												class="btn btn-danger btn-sm"
												onclick={(e) => openDeleteDialog(role, e)}
											>
												{$LL.admin_roles_delete()}
											</button>
										{/if}
									</div>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	{:else if activeTab === 'rules'}
		<!-- Assignment Rules Tab -->
		<RoleAssignmentRules />
	{/if}
</div>

<!-- Delete Confirmation Dialog -->
<Modal
	open={showDeleteDialog && !!roleToDelete}
	onClose={closeDeleteDialog}
	title={$LL.admin_roles_delete_title()}
	size="md"
>
	{#if roleToDelete}
		<p class="modal-description">
			{$LL.admin_roles_delete_description({ role: roleToDelete.name })}
		</p>
		<p class="danger-text">{$LL.admin_roles_delete_danger()}</p>

		{#if deleteError}
			<div class="alert alert-error">{deleteError}</div>
		{/if}
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeDeleteDialog} disabled={deleting}>
			{$LL.admin_roles_cancel()}
		</button>
		<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
			{deleting ? $LL.admin_roles_deleting() : $LL.admin_roles_delete()}
		</button>
	{/snippet}
</Modal>

<style>
	/* Tab Navigation */
	.tab-nav {
		display: flex;
		gap: 4px;
		margin-bottom: 24px;
		border-bottom: 1px solid var(--border-primary);
		padding-bottom: 0;
	}

	.tab-btn {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 20px;
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		margin-bottom: -1px;
		color: var(--text-secondary);
		font-size: 0.9375rem;
		font-weight: 500;
		cursor: pointer;
		transition: all var(--transition-fast);
	}

	.tab-btn:hover {
		color: var(--text-primary);
	}

	.tab-btn.active {
		color: var(--primary);
		border-bottom-color: var(--primary);
	}

	.tab-btn :global(i) {
		width: 18px;
		height: 18px;
	}
</style>
