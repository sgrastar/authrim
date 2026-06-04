<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { LL } from '$i18n/i18n-svelte';
	import { settingsContext } from '$lib/stores/settings-context.svelte';
	import {
		adminOrganizationsAPI,
		type OrgDomainMapping,
		type Organization,
		type OrganizationNode,
		type OrganizationHierarchyResponse
	} from '$lib/api/admin-organizations';
	import OrganizationTree from '$lib/components/OrganizationTree.svelte';
	import { Modal, ToggleSwitch } from '$lib/components';

	// Tab state
	let activeTab = $state<'hierarchy' | 'mappings'>('hierarchy');

	// Hierarchy view state
	let organizations: Organization[] = $state([]);
	let selectedRootOrg: Organization | null = $state(null);
	let hierarchyData: OrganizationHierarchyResponse | null = $state(null);
	let hierarchyLoading = $state(false);
	let hierarchyError = $state('');
	let expandedNodes = new SvelteSet<string>();
	let searchQuery = $state('');
	let highlightedIds = new SvelteSet<string>();

	// Domain mappings state
	let mappings: OrgDomainMapping[] = $state([]);
	let loading = $state(true);
	let error = $state('');
	let total = $state(0);

	// Create dialog state
	let showCreateDialog = $state(false);
	let creating = $state(false);
	let createError = $state('');
	let newDomain = $state('');
	let newOrgId = $state('');
	let newAutoJoin = $state(true);
	let newMembershipType = $state<'member' | 'admin' | 'owner'>('member');

	// Delete confirmation dialog state
	let showDeleteDialog = $state(false);
	let mappingToDelete: OrgDomainMapping | null = $state(null);
	let deleting = $state(false);
	let deleteError = $state('');

	// Verification dialog state
	let showVerifyDialog = $state(false);
	let mappingToVerify: OrgDomainMapping | null = $state(null);
	let verifying = $state(false);
	let verifyError = $state('');
	let verifyRecordName = $state('');
	let verifyExpectedValue = $state('');
	let loadedTenantId = $state('');

	// ==========================================================================
	// Organization Hierarchy Functions
	// ==========================================================================

	async function loadOrganizations() {
		hierarchyLoading = true;
		hierarchyError = '';

		try {
			const response = await adminOrganizationsAPI.listOrganizations({
				limit: 100,
				search: searchQuery || undefined
			});
			organizations = response.organizations;

			// If we have organizations and no root selected, select the first one with no parent
			if (organizations.length > 0 && !selectedRootOrg) {
				const rootOrgs = organizations.filter((o) => !o.parent_org_id);
				if (rootOrgs.length > 0) {
					await selectRootOrg(rootOrgs[0]);
				}
			}
		} catch (err) {
			hierarchyError = err instanceof Error ? err.message : $LL.admin_org_load_failed();
		} finally {
			hierarchyLoading = false;
		}
	}

	async function selectRootOrg(org: Organization) {
		selectedRootOrg = org;
		hierarchyData = null;
		hierarchyLoading = true;
		hierarchyError = '';

		try {
			hierarchyData = await adminOrganizationsAPI.getHierarchy(org.id);
			// Expand root by default
			expandedNodes.clear();
			expandedNodes.add(org.id);
		} catch (err) {
			hierarchyError = err instanceof Error ? err.message : $LL.admin_org_hierarchy_load_failed();
		} finally {
			hierarchyLoading = false;
		}
	}

	function handleToggleNode(nodeId: string, expanded: boolean) {
		if (expanded) {
			expandedNodes.add(nodeId);
		} else {
			expandedNodes.delete(nodeId);
		}
	}

	function expandAll() {
		if (!hierarchyData) return;
		function collectIds(node: OrganizationNode) {
			expandedNodes.add(node.id);
			node.children.forEach(collectIds);
		}
		collectIds(hierarchyData.organization);
	}

	function collapseAll() {
		if (!hierarchyData) return;
		expandedNodes.clear();
		expandedNodes.add(hierarchyData.organization.id);
	}

	async function handleSearch() {
		if (!searchQuery.trim()) {
			highlightedIds.clear();
			await loadOrganizations();
			return;
		}

		// Search in the current hierarchy
		if (hierarchyData) {
			highlightedIds.clear();
			const query = searchQuery.toLowerCase();

			function searchNode(node: OrganizationNode) {
				if (
					node.name.toLowerCase().includes(query) ||
					(node.display_name && node.display_name.toLowerCase().includes(query))
				) {
					highlightedIds.add(node.id);
				}
				node.children.forEach(searchNode);
			}

			searchNode(hierarchyData.organization);

			// Expand all to show matches
			if (highlightedIds.size > 0) {
				expandAll();
			}
		}
	}

	// ==========================================================================
	// Domain Mapping Functions
	// ==========================================================================

	async function loadMappings() {
		loading = true;
		error = '';

		try {
			const response = await adminOrganizationsAPI.list({ limit: 50 });
			mappings = response.mappings;
			total = response.total;
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_org_mappings_load_failed();
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
		selectedRootOrg = null;
		hierarchyData = null;
		organizations = [];
		mappings = [];
		total = 0;
		highlightedIds.clear();
		expandedNodes.clear();
		loadOrganizations();
		if (activeTab === 'mappings') {
			loadMappings();
		}
	});

	function handleTabChange(tab: 'hierarchy' | 'mappings') {
		activeTab = tab;
		if (tab === 'mappings' && mappings.length === 0) {
			loadMappings();
		}
	}

	function openCreateDialog() {
		newDomain = '';
		newOrgId = '';
		newAutoJoin = true;
		newMembershipType = 'member';
		createError = '';
		showCreateDialog = true;
	}

	function closeCreateDialog() {
		showCreateDialog = false;
		createError = '';
	}

	async function confirmCreate() {
		if (!newDomain.trim() || !newOrgId.trim()) {
			createError = $LL.admin_org_domain_required();
			return;
		}

		creating = true;
		createError = '';

		try {
			await adminOrganizationsAPI.create({
				domain: newDomain.trim().toLowerCase(),
				org_id: newOrgId.trim(),
				auto_join_enabled: newAutoJoin,
				membership_type: newMembershipType,
				is_active: true
			});
			showCreateDialog = false;
			await loadMappings();
		} catch (err) {
			createError = err instanceof Error ? err.message : $LL.admin_org_create_failed();
		} finally {
			creating = false;
		}
	}

	function openDeleteDialog(mapping: OrgDomainMapping, event: Event) {
		event.stopPropagation();
		mappingToDelete = mapping;
		deleteError = '';
		showDeleteDialog = true;
	}

	function closeDeleteDialog() {
		showDeleteDialog = false;
		mappingToDelete = null;
		deleteError = '';
	}

	async function confirmDelete() {
		if (!mappingToDelete) return;

		deleting = true;
		deleteError = '';

		try {
			await adminOrganizationsAPI.delete(mappingToDelete.id);
			showDeleteDialog = false;
			mappingToDelete = null;
			await loadMappings();
		} catch (err) {
			deleteError = err instanceof Error ? err.message : $LL.admin_org_delete_failed();
		} finally {
			deleting = false;
		}
	}

	function openVerifyDialog(mapping: OrgDomainMapping, event: Event) {
		event.stopPropagation();
		mappingToVerify = mapping;
		verifyError = '';
		verifyRecordName = '';
		verifyExpectedValue = '';
		showVerifyDialog = true;
	}

	function closeVerifyDialog() {
		showVerifyDialog = false;
		mappingToVerify = null;
		verifyError = '';
	}

	async function startVerification() {
		if (!mappingToVerify) return;

		verifying = true;
		verifyError = '';

		try {
			const result = await adminOrganizationsAPI.startVerification(mappingToVerify.id);
			verifyRecordName = result.record_name;
			verifyExpectedValue = result.expected_value;
		} catch (err) {
			verifyError = err instanceof Error ? err.message : $LL.admin_org_start_verification_failed();
		} finally {
			verifying = false;
		}
	}

	async function confirmVerification() {
		if (!mappingToVerify) return;

		verifying = true;
		verifyError = '';

		try {
			const result = await adminOrganizationsAPI.confirmVerification(mappingToVerify.id);
			if (result.verified) {
				showVerifyDialog = false;
				mappingToVerify = null;
				await loadMappings();
			} else {
				verifyError = result.error || $LL.admin_org_dns_record_not_found();
			}
		} catch (err) {
			verifyError = err instanceof Error ? err.message : $LL.admin_org_verify_failed();
		} finally {
			verifying = false;
		}
	}

	async function toggleActive(mapping: OrgDomainMapping, event: Event) {
		event.stopPropagation();
		try {
			await adminOrganizationsAPI.update(mapping.id, {
				is_active: !mapping.is_active
			});
			await loadMappings();
		} catch (err) {
			error = err instanceof Error ? err.message : $LL.admin_org_update_failed();
		}
	}

	function formatMembershipType(type: OrgDomainMapping['membership_type']): string {
		switch (type) {
			case 'admin':
				return $LL.admin_org_membership_admin();
			case 'owner':
				return $LL.admin_org_membership_owner();
			case 'member':
			default:
				return $LL.admin_org_membership_member();
		}
	}
</script>

<svelte:head>
	<title>{$LL.admin_org_head_title()}</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">{$LL.admin_org_title()}</h1>
			<p class="page-description">{$LL.admin_org_description()}</p>
		</div>
	</div>

	<!-- Tabs -->
	<div class="tabs">
		<button
			class="tab"
			class:active={activeTab === 'hierarchy'}
			onclick={() => handleTabChange('hierarchy')}
		>
			<i class="i-ph-tree-structure"></i>
			{$LL.admin_org_hierarchy()}
		</button>
		<button
			class="tab"
			class:active={activeTab === 'mappings'}
			onclick={() => handleTabChange('mappings')}
		>
			<i class="i-ph-globe"></i>
			{$LL.admin_org_domain_mappings()}
		</button>
	</div>

	<!-- Hierarchy Tab -->
	{#if activeTab === 'hierarchy'}
		<div class="panel">
			<!-- Search and Actions -->
			<div class="filter-row">
				<div class="form-group" style="flex: 1;">
					<input
						type="text"
						class="form-input"
						bind:value={searchQuery}
						placeholder={$LL.admin_org_search_placeholder()}
						onkeydown={(e) => e.key === 'Enter' && handleSearch()}
					/>
				</div>
				<button class="btn btn-primary" onclick={handleSearch}>{$LL.admin_org_search()}</button>
				<button class="btn btn-secondary" onclick={expandAll} disabled={!hierarchyData}>
					{$LL.admin_org_expand_all()}
				</button>
				<button class="btn btn-secondary" onclick={collapseAll} disabled={!hierarchyData}>
					{$LL.admin_org_collapse_all()}
				</button>
			</div>

			{#if hierarchyError}
				<div class="alert alert-error" style="margin-bottom: 16px;">
					{hierarchyError}
					<button class="btn btn-secondary btn-sm" onclick={loadOrganizations}>
						{$LL.admin_org_retry()}
					</button>
				</div>
			{/if}

			{#if hierarchyLoading}
				<div class="loading-state">
					<i class="i-ph-circle-notch loading-spinner"></i>
					<p>{$LL.admin_org_loading_organizations()}</p>
				</div>
			{:else if hierarchyData}
				<!-- Summary -->
				<div class="summary-bar">
					<span class="summary-item">
						{$LL.admin_org_summary_organizations({
							count: hierarchyData.summary.total_organizations
						})}
					</span>
					<span class="summary-divider">|</span>
					<span class="summary-item">
						{$LL.admin_org_summary_members({ count: hierarchyData.summary.total_members })}
					</span>
					<span class="summary-divider">|</span>
					<span class="summary-item">
						{$LL.admin_org_summary_max_depth({ depth: hierarchyData.summary.max_depth })}
					</span>
					{#if highlightedIds.size > 0}
						<span class="summary-divider">|</span>
						<span class="summary-item highlight">
							{$LL.admin_org_summary_matches({ count: highlightedIds.size })}
						</span>
					{/if}
				</div>

				<!-- Tree View -->
				<div class="tree-container">
					<OrganizationTree
						node={hierarchyData.organization}
						{expandedNodes}
						onToggle={handleToggleNode}
						highlightIds={highlightedIds}
					/>
				</div>
			{:else if organizations.length === 0}
				<div class="empty-state">
					<p class="empty-state-description">{$LL.admin_org_empty()}</p>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Domain Mappings Tab -->
	{#if activeTab === 'mappings'}
		<div class="panel">
			<div class="section-header">
				<p class="section-description">{$LL.admin_org_mappings_description()}</p>
				<button class="btn btn-primary" onclick={openCreateDialog}>
					<i class="i-ph-plus"></i>
					{$LL.admin_org_add_mapping()}
				</button>
			</div>

			{#if error}
				<div class="alert alert-error">{error}</div>
			{/if}

			{#if loading}
				<div class="loading-state">
					<i class="i-ph-circle-notch loading-spinner"></i>
					<p>{$LL.admin_org_loading()}</p>
				</div>
			{:else if mappings.length === 0}
				<div class="empty-state">
					<p class="empty-state-description">{$LL.admin_org_mappings_empty()}</p>
					<p class="empty-state-hint">
						{$LL.admin_org_mappings_empty_hint()}
					</p>
					<button class="btn btn-primary" onclick={openCreateDialog}>
						{$LL.admin_org_add_first_mapping()}
					</button>
				</div>
			{:else}
				<p class="result-count">
					{$LL.admin_org_result_count({ shown: mappings.length, total })}
				</p>

				<div class="data-table-container">
					<table class="data-table">
						<thead>
							<tr>
								<th>{$LL.admin_org_organization_id()}</th>
								<th>{$LL.admin_org_verification()}</th>
								<th>{$LL.admin_org_status()}</th>
								<th>{$LL.admin_org_auto_join()}</th>
								<th>{$LL.admin_org_membership()}</th>
								<th class="text-right">{$LL.admin_org_actions()}</th>
							</tr>
						</thead>
						<tbody>
							{#each mappings as mapping (mapping.id)}
								<tr>
									<td>
										<div class="mono cell-primary">{mapping.org_id}</div>
										<div class="cell-secondary">
											{$LL.admin_org_hash()}
											{mapping.domain_hash.substring(0, 16)}...
										</div>
									</td>
									<td>
										<span class={mapping.verified ? 'badge badge-success' : 'badge badge-warning'}>
											{mapping.verified ? $LL.admin_org_verified() : $LL.admin_org_pending()}
										</span>
									</td>
									<td>
										<span class={mapping.is_active ? 'badge badge-info' : 'badge badge-neutral'}>
											{mapping.is_active ? $LL.admin_org_active() : $LL.admin_org_inactive()}
										</span>
									</td>
									<td>{mapping.auto_join_enabled ? $LL.admin_org_yes() : $LL.admin_org_no()}</td>
									<td>
										<span class="badge badge-neutral"
											>{formatMembershipType(mapping.membership_type)}</span
										>
									</td>
									<td class="text-right">
										<div class="action-buttons">
											{#if !mapping.verified}
												<button
													class="btn btn-warning btn-sm"
													onclick={(e) => openVerifyDialog(mapping, e)}
												>
													{$LL.admin_org_verify()}
												</button>
											{/if}
											<button
												class="btn btn-secondary btn-sm"
												onclick={(e) => toggleActive(mapping, e)}
											>
												{mapping.is_active ? $LL.admin_org_disable() : $LL.admin_org_enable()}
											</button>
											<button
												class="btn btn-danger btn-sm"
												onclick={(e) => openDeleteDialog(mapping, e)}
											>
												{$LL.admin_org_delete()}
											</button>
										</div>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	{/if}
</div>

<!-- Create Dialog -->
<Modal
	open={showCreateDialog}
	onClose={closeCreateDialog}
	title={$LL.admin_org_add_mapping_title()}
	size="md"
>
	{#if createError}
		<div class="alert alert-error">{createError}</div>
	{/if}

	<div class="form-group">
		<label for="new-domain" class="form-label">{$LL.admin_org_email_domain()}</label>
		<input
			id="new-domain"
			type="text"
			class="form-input"
			bind:value={newDomain}
			placeholder="example.com"
		/>
		<p class="form-hint">{$LL.admin_org_email_domain_hint()}</p>
	</div>

	<div class="form-group">
		<label for="new-org-id" class="form-label">{$LL.admin_org_organization_id()}</label>
		<input
			id="new-org-id"
			type="text"
			class="form-input"
			bind:value={newOrgId}
			placeholder="org_..."
		/>
	</div>

	<div class="form-group">
		<ToggleSwitch
			bind:checked={newAutoJoin}
			label={$LL.admin_org_auto_join()}
			description={$LL.admin_org_auto_join_description()}
		/>
	</div>

	<div class="form-group">
		<label for="membership-type" class="form-label">{$LL.admin_org_default_membership_type()}</label
		>
		<select id="membership-type" class="form-select" bind:value={newMembershipType}>
			<option value="member">{$LL.admin_org_membership_member()}</option>
			<option value="admin">{$LL.admin_org_membership_admin()}</option>
			<option value="owner">{$LL.admin_org_membership_owner()}</option>
		</select>
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeCreateDialog} disabled={creating}>
			{$LL.admin_org_cancel()}
		</button>
		<button class="btn btn-primary" onclick={confirmCreate} disabled={creating}>
			{creating ? $LL.admin_org_creating() : $LL.admin_org_create_mapping()}
		</button>
	{/snippet}
</Modal>

<!-- Verify Dialog -->
<Modal
	open={showVerifyDialog && !!mappingToVerify}
	onClose={closeVerifyDialog}
	title={$LL.admin_org_verify_domain_title()}
	size="lg"
>
	{#if verifyError}
		<div class="alert alert-error">{verifyError}</div>
	{/if}

	{#if !verifyRecordName}
		<p class="modal-description">
			{$LL.admin_org_verify_intro()}
		</p>
		<button class="btn btn-primary" onclick={startVerification} disabled={verifying}>
			{verifying ? $LL.admin_org_loading() : $LL.admin_org_get_dns_record()}
		</button>
	{:else}
		<p class="modal-description">{$LL.admin_org_add_txt_record()}</p>

		<div class="info-box">
			<div class="info-row">
				<span class="info-label">{$LL.admin_org_record_name()}</span>
				<code class="info-value mono">{verifyRecordName}</code>
			</div>
			<div class="info-row">
				<span class="info-label">{$LL.admin_org_record_type()}</span>
				<code class="info-value">TXT</code>
			</div>
			<div class="info-row">
				<span class="info-label">{$LL.admin_org_record_value()}</span>
				<code class="info-value mono">{verifyExpectedValue}</code>
			</div>
		</div>

		<p class="form-hint">
			{$LL.admin_org_dns_note()}
		</p>
	{/if}

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeVerifyDialog} disabled={verifying}>
			{$LL.admin_org_cancel()}
		</button>
		{#if verifyRecordName}
			<button class="btn btn-success" onclick={confirmVerification} disabled={verifying}>
				{verifying ? $LL.admin_org_verifying() : $LL.admin_org_verify_domain()}
			</button>
		{/if}
	{/snippet}
</Modal>

<!-- Delete Confirmation Dialog -->
<Modal
	open={showDeleteDialog && !!mappingToDelete}
	onClose={closeDeleteDialog}
	title={$LL.admin_org_delete_mapping_title()}
	size="md"
>
	{#if deleteError}
		<div class="alert alert-error">{deleteError}</div>
	{/if}

	<p class="modal-description">
		{$LL.admin_org_delete_description()}
	</p>

	<div class="info-box">
		<div class="info-row">
			<span class="info-label">{$LL.admin_org_organization_label()}</span>
			<span class="info-value">{mappingToDelete?.org_id ?? ''}</span>
		</div>
		<div class="info-row">
			<span class="info-label">{$LL.admin_org_status_label()}</span>
			<span class="info-value">
				{mappingToDelete?.verified
					? $LL.admin_org_verified()
					: $LL.admin_org_pending_verification()}
			</span>
		</div>
	</div>

	{#snippet footer()}
		<button class="btn btn-secondary" onclick={closeDeleteDialog} disabled={deleting}>
			{$LL.admin_org_cancel()}
		</button>
		<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
			{deleting ? $LL.admin_org_deleting() : $LL.admin_org_delete_mapping()}
		</button>
	{/snippet}
</Modal>
