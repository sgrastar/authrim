<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import {
		adminOrganizationsAPI,
		type OrgDomainMapping,
		type Organization,
		type OrganizationNode,
		type OrganizationHierarchyResponse
	} from '$lib/api/admin-organizations';
	import OrganizationTree from '$lib/components/OrganizationTree.svelte';
	import { ToggleSwitch } from '$lib/components';

	// Tab state
	let activeTab = $state<'hierarchy' | 'mappings'>('hierarchy');

	// Hierarchy view state
	let organizations: Organization[] = $state([]);
	let selectedRootOrg: Organization | null = $state(null);
	let hierarchyData: OrganizationHierarchyResponse | null = $state(null);
	let hierarchyLoading = $state(false);
	let hierarchyError = $state('');
	let expandedNodes: Set<string> = new SvelteSet();
	let searchQuery = $state('');
	let highlightedIds: Set<string> = new SvelteSet();

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
			console.error('Failed to load organizations:', err);
			hierarchyError = err instanceof Error ? err.message : 'Failed to load organizations';
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
			expandedNodes = new Set([org.id]);
		} catch (err) {
			console.error('Failed to load hierarchy:', err);
			hierarchyError = err instanceof Error ? err.message : 'Failed to load hierarchy';
		} finally {
			hierarchyLoading = false;
		}
	}

	function handleToggleNode(nodeId: string, expanded: boolean) {
		const newSet = new SvelteSet(expandedNodes);
		if (expanded) {
			newSet.add(nodeId);
		} else {
			newSet.delete(nodeId);
		}
		expandedNodes = newSet;
	}

	function expandAll() {
		if (!hierarchyData) return;
		const allIds = new SvelteSet<string>();
		function collectIds(node: OrganizationNode) {
			allIds.add(node.id);
			node.children.forEach(collectIds);
		}
		collectIds(hierarchyData.organization);
		expandedNodes = allIds;
	}

	function collapseAll() {
		if (!hierarchyData) return;
		expandedNodes = new SvelteSet([hierarchyData.organization.id]);
	}

	async function handleSearch() {
		if (!searchQuery.trim()) {
			highlightedIds = new SvelteSet();
			await loadOrganizations();
			return;
		}

		// Search in the current hierarchy
		if (hierarchyData) {
			const matchingIds = new SvelteSet<string>();
			const query = searchQuery.toLowerCase();

			function searchNode(node: OrganizationNode) {
				if (
					node.name.toLowerCase().includes(query) ||
					(node.display_name && node.display_name.toLowerCase().includes(query))
				) {
					matchingIds.add(node.id);
				}
				node.children.forEach(searchNode);
			}

			searchNode(hierarchyData.organization);
			highlightedIds = matchingIds;

			// Expand all to show matches
			if (matchingIds.size > 0) {
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
			console.error('Failed to load domain mappings:', err);
			error = 'Failed to load domain mappings';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		// Load hierarchy by default
		loadOrganizations();
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
			createError = 'Domain and Organization ID are required';
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
			createError = err instanceof Error ? err.message : 'Failed to create mapping';
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
			deleteError = err instanceof Error ? err.message : 'Failed to delete mapping';
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
			verifyError = err instanceof Error ? err.message : 'Failed to start verification';
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
				verifyError = result.error || 'DNS record not found. Please wait for DNS propagation.';
			}
		} catch (err) {
			verifyError = err instanceof Error ? err.message : 'Failed to verify domain';
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
			error = err instanceof Error ? err.message : 'Failed to update mapping';
		}
	}
</script>

<svelte:head>
	<title>Organizations - Admin Dashboard - Authrim</title>
</svelte:head>

<div class="admin-page">
	<!-- Page Header -->
	<div class="page-header">
		<div>
			<h1 class="page-title">Organizations</h1>
			<p class="page-description">
				Manage organization hierarchy and domain mappings for JIT provisioning.
			</p>
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
			Hierarchy
		</button>
		<button
			class="tab"
			class:active={activeTab === 'mappings'}
			onclick={() => handleTabChange('mappings')}
		>
			<i class="i-ph-globe"></i>
			Domain Mappings
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
						placeholder="Search organizations..."
						onkeydown={(e) => e.key === 'Enter' && handleSearch()}
					/>
				</div>
				<button class="btn btn-primary" onclick={handleSearch}>Search</button>
				<button class="btn btn-secondary" onclick={expandAll} disabled={!hierarchyData}>
					Expand All
				</button>
				<button class="btn btn-secondary" onclick={collapseAll} disabled={!hierarchyData}>
					Collapse All
				</button>
			</div>

			{#if hierarchyError}
				<div class="alert alert-error" style="margin-bottom: 16px;">
					{hierarchyError}
					<button class="btn btn-secondary btn-sm" onclick={loadOrganizations}>Retry</button>
				</div>
			{/if}

			{#if hierarchyLoading}
				<div class="loading-state">
					<i class="i-ph-circle-notch loading-spinner"></i>
					<p>Loading organizations...</p>
				</div>
			{:else if hierarchyData}
				<!-- Summary -->
				<div class="summary-bar">
					<span class="summary-item">
						<strong>{hierarchyData.summary.total_organizations}</strong> organizations
					</span>
					<span class="summary-divider">|</span>
					<span class="summary-item">
						<strong>{hierarchyData.summary.total_members}</strong> total members
					</span>
					<span class="summary-divider">|</span>
					<span class="summary-item">
						Max depth: <strong>{hierarchyData.summary.max_depth}</strong>
					</span>
					{#if highlightedIds.size > 0}
						<span class="summary-divider">|</span>
						<span class="summary-item highlight">
							<strong>{highlightedIds.size}</strong> matches
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
					<p class="empty-state-description">No organizations found.</p>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Domain Mappings Tab -->
	{#if activeTab === 'mappings'}
		<div class="panel">
			<div class="section-header">
				<p class="section-description">
					Configure domain-to-organization mappings for automatic user provisioning via JIT
					(Just-In-Time) provisioning. Users with email addresses matching a verified domain will be
					automatically added to the mapped organization.
				</p>
				<button class="btn btn-primary" onclick={openCreateDialog}>
					<i class="i-ph-plus"></i>
					Add Mapping
				</button>
			</div>

			{#if error}
				<div class="alert alert-error">{error}</div>
			{/if}

			{#if loading}
				<div class="loading-state">
					<i class="i-ph-circle-notch loading-spinner"></i>
					<p>Loading...</p>
				</div>
			{:else if mappings.length === 0}
				<div class="empty-state">
					<p class="empty-state-description">No domain mappings configured.</p>
					<p class="empty-state-hint">
						Add a domain mapping to enable automatic organization assignment for users.
					</p>
					<button class="btn btn-primary" onclick={openCreateDialog}>Add Your First Mapping</button>
				</div>
			{:else}
				<p class="result-count">Showing {mappings.length} of {total} mappings</p>

				<div class="data-table-container">
					<table class="data-table">
						<thead>
							<tr>
								<th>Organization ID</th>
								<th>Verification</th>
								<th>Status</th>
								<th>Auto Join</th>
								<th>Membership</th>
								<th class="text-right">Actions</th>
							</tr>
						</thead>
						<tbody>
							{#each mappings as mapping (mapping.id)}
								<tr>
									<td>
										<div class="mono cell-primary">{mapping.org_id}</div>
										<div class="cell-secondary">
											Hash: {mapping.domain_hash.substring(0, 16)}...
										</div>
									</td>
									<td>
										<span class={mapping.verified ? 'badge badge-success' : 'badge badge-warning'}>
											{mapping.verified ? 'Verified' : 'Pending'}
										</span>
									</td>
									<td>
										<span class={mapping.is_active ? 'badge badge-info' : 'badge badge-neutral'}>
											{mapping.is_active ? 'Active' : 'Inactive'}
										</span>
									</td>
									<td>{mapping.auto_join_enabled ? 'Yes' : 'No'}</td>
									<td>
										<span class="badge badge-neutral">{mapping.membership_type}</span>
									</td>
									<td class="text-right">
										<div class="action-buttons">
											{#if !mapping.verified}
												<button
													class="btn btn-warning btn-sm"
													onclick={(e) => openVerifyDialog(mapping, e)}
												>
													Verify
												</button>
											{/if}
											<button
												class="btn btn-secondary btn-sm"
												onclick={(e) => toggleActive(mapping, e)}
											>
												{mapping.is_active ? 'Disable' : 'Enable'}
											</button>
											<button
												class="btn btn-danger btn-sm"
												onclick={(e) => openDeleteDialog(mapping, e)}
											>
												Delete
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
{#if showCreateDialog}
	<div
		class="modal-overlay"
		onclick={closeCreateDialog}
		onkeydown={(e) => e.key === 'Escape' && closeCreateDialog()}
		tabindex="-1"
		role="dialog"
		aria-modal="true"
	>
		<div
			class="modal-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h2 class="modal-title">Add Domain Mapping</h2>
			</div>

			<div class="modal-body">
				{#if createError}
					<div class="alert alert-error">{createError}</div>
				{/if}

				<div class="form-group">
					<label for="new-domain" class="form-label">Email Domain</label>
					<input
						id="new-domain"
						type="text"
						class="form-input"
						bind:value={newDomain}
						placeholder="example.com"
					/>
					<p class="form-hint">
						Users with email addresses from this domain will be mapped to the organization.
					</p>
				</div>

				<div class="form-group">
					<label for="new-org-id" class="form-label">Organization ID</label>
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
						label="Auto Join"
						description="Enable auto-join for new users with this domain"
					/>
				</div>

				<div class="form-group">
					<label for="membership-type" class="form-label">Default Membership Type</label>
					<select id="membership-type" class="form-select" bind:value={newMembershipType}>
						<option value="member">Member</option>
						<option value="admin">Admin</option>
						<option value="owner">Owner</option>
					</select>
				</div>
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={closeCreateDialog} disabled={creating}>
					Cancel
				</button>
				<button class="btn btn-primary" onclick={confirmCreate} disabled={creating}>
					{creating ? 'Creating...' : 'Create Mapping'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Verify Dialog -->
{#if showVerifyDialog && mappingToVerify}
	<div
		class="modal-overlay"
		onclick={closeVerifyDialog}
		onkeydown={(e) => e.key === 'Escape' && closeVerifyDialog()}
		tabindex="-1"
		role="dialog"
		aria-modal="true"
	>
		<div
			class="modal-content modal-lg"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h2 class="modal-title">Verify Domain Ownership</h2>
			</div>

			<div class="modal-body">
				{#if verifyError}
					<div class="alert alert-error">{verifyError}</div>
				{/if}

				{#if !verifyRecordName}
					<p class="modal-description">
						To verify domain ownership, you'll need to add a DNS TXT record. Click "Get DNS Record"
						to generate the verification record.
					</p>
					<button class="btn btn-primary" onclick={startVerification} disabled={verifying}>
						{verifying ? 'Loading...' : 'Get DNS Record'}
					</button>
				{:else}
					<p class="modal-description">
						Add the following TXT record to your domain's DNS settings:
					</p>

					<div class="info-box">
						<div class="info-row">
							<span class="info-label">Record Name (Host)</span>
							<code class="info-value mono">{verifyRecordName}</code>
						</div>
						<div class="info-row">
							<span class="info-label">Record Type</span>
							<code class="info-value">TXT</code>
						</div>
						<div class="info-row">
							<span class="info-label">Record Value</span>
							<code class="info-value mono">{verifyExpectedValue}</code>
						</div>
					</div>

					<p class="form-hint">
						Note: DNS changes may take up to 48 hours to propagate. Once the record is set, click
						"Verify Domain" to confirm.
					</p>
				{/if}
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={closeVerifyDialog} disabled={verifying}>
					Cancel
				</button>
				{#if verifyRecordName}
					<button class="btn btn-success" onclick={confirmVerification} disabled={verifying}>
						{verifying ? 'Verifying...' : 'Verify Domain'}
					</button>
				{/if}
			</div>
		</div>
	</div>
{/if}

<!-- Delete Confirmation Dialog -->
{#if showDeleteDialog && mappingToDelete}
	<div
		class="modal-overlay"
		onclick={closeDeleteDialog}
		onkeydown={(e) => e.key === 'Escape' && closeDeleteDialog()}
		tabindex="-1"
		role="dialog"
		aria-modal="true"
	>
		<div
			class="modal-content"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<div class="modal-header">
				<h2 class="modal-title">Delete Domain Mapping</h2>
			</div>

			<div class="modal-body">
				{#if deleteError}
					<div class="alert alert-error">{deleteError}</div>
				{/if}

				<p class="modal-description">
					Are you sure you want to delete this domain mapping? New users from this domain will no
					longer be automatically assigned to the organization.
				</p>

				<div class="info-box">
					<div class="info-row">
						<span class="info-label">Organization:</span>
						<span class="info-value">{mappingToDelete.org_id}</span>
					</div>
					<div class="info-row">
						<span class="info-label">Status:</span>
						<span class="info-value">
							{mappingToDelete.verified ? 'Verified' : 'Pending Verification'}
						</span>
					</div>
				</div>
			</div>

			<div class="modal-footer">
				<button class="btn btn-secondary" onclick={closeDeleteDialog} disabled={deleting}>
					Cancel
				</button>
				<button class="btn btn-danger" onclick={confirmDelete} disabled={deleting}>
					{deleting ? 'Deleting...' : 'Delete Mapping'}
				</button>
			</div>
		</div>
	</div>
{/if}
