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
	import {
		AdminDataTable,
		AdminPageHeader,
		AdminPageShell,
		AdminSection,
		AdminTabs
	} from '$lib/components/admin';
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

	const tabs = $derived([
		{
			id: 'roles',
			label: $LL.admin_roles_tab_roles(),
			icon: 'i-ph-shield-check'
		},
		{
			id: 'rules',
			label: $LL.admin_roles_tab_rules(),
			icon: 'i-ph-git-branch'
		}
	]);
</script>

<svelte:head>
	<title>{$LL.admin_roles_head_title()}</title>
</svelte:head>

<AdminPageShell>
	<AdminSection>
		<div class="info-box">
			<i class="i-ph-info" aria-hidden="true"></i>
			<div>
				<strong>{$LL.admin_roles_end_user_rbac()}</strong>
				<p>
					{$LL.admin_roles_info_banner()}
					<a href="/admin/admin-rbac">{$LL.admin_roles_admin_rbac()}</a>
				</p>
			</div>
		</div>
	</AdminSection>

	<AdminPageHeader title={$LL.admin_roles_title()} description={$LL.admin_roles_description()}>
		{#snippet actions()}
			{#if activeTab === 'roles'}
				<button class="btn btn-primary" onclick={navigateToCreate}>
					<i class="i-ph-plus"></i>
					{$LL.admin_roles_create_role()}
				</button>
			{/if}
		{/snippet}
	</AdminPageHeader>

	<AdminTabs
		items={tabs}
		active={activeTab}
		onChange={switchTab}
		ariaLabel={$LL.admin_roles_title()}
	/>

	<!-- Tab Content -->
	{#if activeTab === 'roles'}
		<!-- Roles Tab -->
		{#if error}
			<div class="alert alert-error alert--stacked">
				{error}
				<button class="btn btn-secondary btn-sm" onclick={loadRoles}>
					{$LL.admin_roles_retry()}
				</button>
			</div>
		{/if}

		<!-- Filter Bar -->
		<AdminSection>
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
		</AdminSection>

		{#if loading}
			<div class="loading-state">
				<i class="i-ph-circle-notch loading-spinner"></i>
				<p>{$LL.admin_roles_loading()}</p>
			</div>
		{:else if filteredRoles.length === 0}
			<AdminSection>
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
			</AdminSection>
		{:else}
			<AdminSection>
				<AdminDataTable width="wide">
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
								data-clickable="true"
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
								<td class="muted truncate description-cell">
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
				</AdminDataTable>
			</AdminSection>
		{/if}
	{:else if activeTab === 'rules'}
		<!-- Assignment Rules Tab -->
		<RoleAssignmentRules />
	{/if}
</AdminPageShell>

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
	.info-box :global(i) {
		font-size: 1.2rem;
		color: var(--color-accent);
	}

	.alert--stacked {
		margin-bottom: 16px;
	}

	.description-cell {
		max-width: 300px;
	}
</style>
