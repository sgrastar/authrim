<script lang="ts">
	import { onMount } from 'svelte';
	import {
		adminOrganizationsAPI,
		type OrgDomainMapping,
		type Organization,
		type OrganizationNode,
		type OrganizationHierarchyResponse
	} from '$lib/api/admin-organizations';
	import OrganizationTree from '$lib/components/OrganizationTree.svelte';

	// Tab state
	let activeTab = $state<'hierarchy' | 'mappings'>('hierarchy');

	// Hierarchy view state
	let organizations: Organization[] = $state([]);
	let selectedRootOrg: Organization | null = $state(null);
	let hierarchyData: OrganizationHierarchyResponse | null = $state(null);
	let hierarchyLoading = $state(false);
	let hierarchyError = $state('');
	let expandedNodes = $state(new Set<string>());
	let searchQuery = $state('');
	let highlightedIds = $state(new Set<string>());

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
		const newSet = new Set(expandedNodes);
		if (expanded) {
			newSet.add(nodeId);
		} else {
			newSet.delete(nodeId);
		}
		expandedNodes = newSet;
	}

	function expandAll() {
		if (!hierarchyData) return;
		const allIds = new Set<string>();
		function collectIds(node: OrganizationNode) {
			allIds.add(node.id);
			node.children.forEach(collectIds);
		}
		collectIds(hierarchyData.organization);
		expandedNodes = allIds;
	}

	function collapseAll() {
		if (!hierarchyData) return;
		expandedNodes = new Set([hierarchyData.organization.id]);
	}

	async function handleSearch() {
		if (!searchQuery.trim()) {
			highlightedIds = new Set();
			await loadOrganizations();
			return;
		}

		// Search in the current hierarchy
		if (hierarchyData) {
			const matchingIds = new Set<string>();
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

	function getStatusBadgeStyle(verified: boolean): string {
		if (verified) {
			return 'background-color: #d1fae5; color: #065f46;';
		}
		return 'background-color: #fef3c7; color: #92400e;';
	}

	function getActiveBadgeStyle(active: boolean): string {
		if (active) {
			return 'background-color: #dbeafe; color: #1e40af;';
		}
		return 'background-color: #e5e7eb; color: #374151;';
	}

	function getMembershipBadgeStyle(type: string): string {
		switch (type) {
			case 'owner':
				return 'background-color: #fce7f3; color: #be185d;';
			case 'admin':
				return 'background-color: #e0e7ff; color: #3730a3;';
			default:
				return 'background-color: #f3f4f6; color: #374151;';
		}
	}
</script>

<div class="organizations-page">
	<div class="page-header">
		<h1>Organizations</h1>
		<p class="description">
			Manage organization hierarchy and domain mappings for JIT provisioning.
		</p>
	</div>

	<!-- Tabs -->
	<div class="tabs">
		<button
			class="tab"
			class:active={activeTab === 'hierarchy'}
			onclick={() => handleTabChange('hierarchy')}
		>
			Hierarchy
		</button>
		<button
			class="tab"
			class:active={activeTab === 'mappings'}
			onclick={() => handleTabChange('mappings')}
		>
			Domain Mappings
		</button>
	</div>

	<!-- Hierarchy Tab -->
	{#if activeTab === 'hierarchy'}
		<div class="hierarchy-section">
			<!-- Search and Actions -->
			<div class="hierarchy-toolbar">
				<div class="search-box">
					<input
						type="text"
						bind:value={searchQuery}
						placeholder="Search organizations..."
						onkeydown={(e) => e.key === 'Enter' && handleSearch()}
					/>
					<button onclick={handleSearch}>Search</button>
				</div>
				<div class="toolbar-actions">
					<button class="btn-secondary" onclick={expandAll} disabled={!hierarchyData}>
						Expand All
					</button>
					<button class="btn-secondary" onclick={collapseAll} disabled={!hierarchyData}>
						Collapse All
					</button>
				</div>
			</div>

			{#if hierarchyError}
				<div class="error-banner">
					{hierarchyError}
					<button onclick={loadOrganizations}>Retry</button>
				</div>
			{/if}

			{#if hierarchyLoading}
				<div class="loading-state">Loading organizations...</div>
			{:else if hierarchyData}
				<!-- Summary -->
				<div class="hierarchy-summary">
					<span>
						{hierarchyData.summary.total_organizations} organizations
					</span>
					<span class="separator">|</span>
					<span>
						{hierarchyData.summary.total_members} total members
					</span>
					<span class="separator">|</span>
					<span>
						Max depth: {hierarchyData.summary.max_depth}
					</span>
					{#if highlightedIds.size > 0}
						<span class="separator">|</span>
						<span class="highlight-count">
							{highlightedIds.size} matches
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
					<p>No organizations found.</p>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Domain Mappings Tab -->
	{#if activeTab === 'mappings'}
		<div class="mappings-section">
			<div class="section-header">
				<p class="section-description">
					Configure domain-to-organization mappings for automatic user provisioning via JIT
					(Just-In-Time) provisioning. Users with email addresses matching a verified domain will be
					automatically added to the mapped organization.
				</p>
				<button class="btn-primary" onclick={openCreateDialog}>Add Mapping</button>
			</div>

			{#if error}
		<div
			style="padding: 12px 16px; background-color: #fee2e2; color: #b91c1c; border-radius: 6px; margin-bottom: 16px;"
		>
			{error}
		</div>
	{/if}

	{#if loading}
		<div style="text-align: center; padding: 48px; color: #6b7280;">Loading...</div>
	{:else if mappings.length === 0}
		<div
			style="text-align: center; padding: 48px; color: #6b7280; background: white; border-radius: 8px; border: 1px solid #e5e7eb;"
		>
			<p style="margin: 0 0 16px 0;">No domain mappings configured.</p>
			<p style="margin: 0 0 24px 0; font-size: 14px;">
				Add a domain mapping to enable automatic organization assignment for users.
			</p>
			<button
				onclick={openCreateDialog}
				style="
					padding: 10px 20px;
					background-color: #3b82f6;
					color: white;
					border: none;
					border-radius: 6px;
					cursor: pointer;
					font-size: 14px;
				"
			>
				Add Your First Mapping
			</button>
		</div>
	{:else}
		<div style="margin-bottom: 16px; color: #6b7280; font-size: 14px;">
			Showing {mappings.length} of {total} mappings
		</div>

		<div style="background: white; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
			<table style="width: 100%; border-collapse: collapse;">
				<thead>
					<tr style="background-color: #f9fafb; border-bottom: 1px solid #e5e7eb;">
						<th
							style="text-align: left; padding: 12px 16px; font-weight: 600; font-size: 14px; color: #374151;"
						>
							Organization ID
						</th>
						<th
							style="text-align: left; padding: 12px 16px; font-weight: 600; font-size: 14px; color: #374151;"
						>
							Verification
						</th>
						<th
							style="text-align: left; padding: 12px 16px; font-weight: 600; font-size: 14px; color: #374151;"
						>
							Status
						</th>
						<th
							style="text-align: left; padding: 12px 16px; font-weight: 600; font-size: 14px; color: #374151;"
						>
							Auto Join
						</th>
						<th
							style="text-align: left; padding: 12px 16px; font-weight: 600; font-size: 14px; color: #374151;"
						>
							Membership
						</th>
						<th
							style="text-align: right; padding: 12px 16px; font-weight: 600; font-size: 14px; color: #374151;"
						>
							Actions
						</th>
					</tr>
				</thead>
				<tbody>
					{#each mappings as mapping (mapping.id)}
						<tr style="border-bottom: 1px solid #e5e7eb;">
							<td style="padding: 12px 16px; font-size: 14px; color: #374151;">
								<div style="font-family: monospace; color: #1f2937;">{mapping.org_id}</div>
								<div style="font-size: 12px; color: #6b7280;">
									Hash: {mapping.domain_hash.substring(0, 16)}...
								</div>
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #374151;">
								<span
									style="
										display: inline-block;
										padding: 4px 8px;
										border-radius: 9999px;
										font-size: 12px;
										font-weight: 500;
										{getStatusBadgeStyle(mapping.verified)}
									"
								>
									{mapping.verified ? 'Verified' : 'Pending'}
								</span>
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #374151;">
								<span
									style="
										display: inline-block;
										padding: 4px 8px;
										border-radius: 9999px;
										font-size: 12px;
										font-weight: 500;
										{getActiveBadgeStyle(mapping.is_active)}
									"
								>
									{mapping.is_active ? 'Active' : 'Inactive'}
								</span>
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #374151;">
								{mapping.auto_join_enabled ? 'Yes' : 'No'}
							</td>
							<td style="padding: 12px 16px; font-size: 14px; color: #374151;">
								<span
									style="
										display: inline-block;
										padding: 4px 8px;
										border-radius: 9999px;
										font-size: 12px;
										font-weight: 500;
										{getMembershipBadgeStyle(mapping.membership_type)}
									"
								>
									{mapping.membership_type}
								</span>
							</td>
							<td style="padding: 12px 16px; text-align: right;">
								<div style="display: flex; justify-content: flex-end; gap: 8px;">
									{#if !mapping.verified}
										<button
											onclick={(e) => openVerifyDialog(mapping, e)}
											style="
												padding: 6px 12px;
												background-color: #fef3c7;
												color: #92400e;
												border: none;
												border-radius: 4px;
												cursor: pointer;
												font-size: 13px;
											"
										>
											Verify
										</button>
									{/if}
									<button
										onclick={(e) => toggleActive(mapping, e)}
										style="
											padding: 6px 12px;
											background-color: #f3f4f6;
											color: #374151;
											border: none;
											border-radius: 4px;
											cursor: pointer;
											font-size: 13px;
										"
									>
										{mapping.is_active ? 'Disable' : 'Enable'}
									</button>
									<button
										onclick={(e) => openDeleteDialog(mapping, e)}
										style="
											padding: 6px 12px;
											background-color: #fee2e2;
											color: #dc2626;
											border: none;
											border-radius: 4px;
											cursor: pointer;
											font-size: 13px;
										"
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
		style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 1000;"
		onclick={closeCreateDialog}
		onkeydown={(e) => e.key === 'Escape' && closeCreateDialog()}
		tabindex="-1"
		role="dialog"
	>
		<div
			style="background: white; border-radius: 8px; padding: 24px; max-width: 500px; width: 90%;"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<h2 style="font-size: 20px; font-weight: bold; margin: 0 0 16px 0; color: #1f2937;">
				Add Domain Mapping
			</h2>

			{#if createError}
				<div
					style="padding: 12px 16px; background-color: #fee2e2; color: #b91c1c; border-radius: 6px; margin-bottom: 16px;"
				>
					{createError}
				</div>
			{/if}

			<div style="margin-bottom: 16px;">
				<label
					style="display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 6px;"
				>
					Email Domain
				</label>
				<input
					type="text"
					bind:value={newDomain}
					placeholder="example.com"
					style="
						width: 100%;
						padding: 10px 12px;
						border: 1px solid #d1d5db;
						border-radius: 6px;
						font-size: 14px;
						box-sizing: border-box;
					"
				/>
				<p style="font-size: 12px; color: #6b7280; margin: 4px 0 0 0;">
					Users with email addresses from this domain will be mapped to the organization.
				</p>
			</div>

			<div style="margin-bottom: 16px;">
				<label
					style="display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 6px;"
				>
					Organization ID
				</label>
				<input
					type="text"
					bind:value={newOrgId}
					placeholder="org_..."
					style="
						width: 100%;
						padding: 10px 12px;
						border: 1px solid #d1d5db;
						border-radius: 6px;
						font-size: 14px;
						box-sizing: border-box;
					"
				/>
			</div>

			<div style="margin-bottom: 16px;">
				<label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
					<input type="checkbox" bind:checked={newAutoJoin} style="width: 16px; height: 16px;" />
					<span style="font-size: 14px; color: #374151;">Enable auto-join for new users</span>
				</label>
			</div>

			<div style="margin-bottom: 24px;">
				<label
					style="display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 6px;"
				>
					Default Membership Type
				</label>
				<select
					bind:value={newMembershipType}
					style="
						width: 100%;
						padding: 10px 12px;
						border: 1px solid #d1d5db;
						border-radius: 6px;
						font-size: 14px;
						background: white;
					"
				>
					<option value="member">Member</option>
					<option value="admin">Admin</option>
					<option value="owner">Owner</option>
				</select>
			</div>

			<div style="display: flex; justify-content: flex-end; gap: 12px;">
				<button
					onclick={closeCreateDialog}
					disabled={creating}
					style="
						padding: 10px 20px;
						background-color: #f3f4f6;
						color: #374151;
						border: none;
						border-radius: 6px;
						cursor: pointer;
						font-size: 14px;
					"
				>
					Cancel
				</button>
				<button
					onclick={confirmCreate}
					disabled={creating}
					style="
						padding: 10px 20px;
						background-color: #3b82f6;
						color: white;
						border: none;
						border-radius: 6px;
						cursor: pointer;
						font-size: 14px;
						opacity: {creating ? 0.7 : 1};
					"
				>
					{creating ? 'Creating...' : 'Create Mapping'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- Verify Dialog -->
{#if showVerifyDialog && mappingToVerify}
	<div
		style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 1000;"
		onclick={closeVerifyDialog}
		onkeydown={(e) => e.key === 'Escape' && closeVerifyDialog()}
		tabindex="-1"
		role="dialog"
	>
		<div
			style="background: white; border-radius: 8px; padding: 24px; max-width: 600px; width: 90%;"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<h2 style="font-size: 20px; font-weight: bold; margin: 0 0 16px 0; color: #1f2937;">
				Verify Domain Ownership
			</h2>

			{#if verifyError}
				<div
					style="padding: 12px 16px; background-color: #fee2e2; color: #b91c1c; border-radius: 6px; margin-bottom: 16px;"
				>
					{verifyError}
				</div>
			{/if}

			{#if !verifyRecordName}
				<p style="color: #6b7280; margin: 0 0 16px 0;">
					To verify domain ownership, you'll need to add a DNS TXT record. Click "Get DNS Record" to
					generate the verification record.
				</p>
				<button
					onclick={startVerification}
					disabled={verifying}
					style="
						padding: 10px 20px;
						background-color: #3b82f6;
						color: white;
						border: none;
						border-radius: 6px;
						cursor: pointer;
						font-size: 14px;
						opacity: {verifying ? 0.7 : 1};
					"
				>
					{verifying ? 'Loading...' : 'Get DNS Record'}
				</button>
			{:else}
				<p style="color: #6b7280; margin: 0 0 16px 0;">
					Add the following TXT record to your domain's DNS settings:
				</p>

				<div
					style="background-color: #f9fafb; padding: 16px; border-radius: 6px; margin-bottom: 16px;"
				>
					<div style="margin-bottom: 12px;">
						<label
							style="display: block; font-size: 12px; font-weight: 500; color: #6b7280; margin-bottom: 4px;"
						>
							Record Name (Host)
						</label>
						<code style="font-size: 14px; color: #1f2937; word-break: break-all;"
							>{verifyRecordName}</code
						>
					</div>
					<div style="margin-bottom: 12px;">
						<label
							style="display: block; font-size: 12px; font-weight: 500; color: #6b7280; margin-bottom: 4px;"
						>
							Record Type
						</label>
						<code style="font-size: 14px; color: #1f2937;">TXT</code>
					</div>
					<div>
						<label
							style="display: block; font-size: 12px; font-weight: 500; color: #6b7280; margin-bottom: 4px;"
						>
							Record Value
						</label>
						<code style="font-size: 14px; color: #1f2937; word-break: break-all;"
							>{verifyExpectedValue}</code
						>
					</div>
				</div>

				<p style="font-size: 12px; color: #6b7280; margin: 0 0 16px 0;">
					Note: DNS changes may take up to 48 hours to propagate. Once the record is set, click
					"Verify Domain" to confirm.
				</p>
			{/if}

			<div style="display: flex; justify-content: flex-end; gap: 12px; margin-top: 24px;">
				<button
					onclick={closeVerifyDialog}
					disabled={verifying}
					style="
						padding: 10px 20px;
						background-color: #f3f4f6;
						color: #374151;
						border: none;
						border-radius: 6px;
						cursor: pointer;
						font-size: 14px;
					"
				>
					Cancel
				</button>
				{#if verifyRecordName}
					<button
						onclick={confirmVerification}
						disabled={verifying}
						style="
							padding: 10px 20px;
							background-color: #22c55e;
							color: white;
							border: none;
							border-radius: 6px;
							cursor: pointer;
							font-size: 14px;
							opacity: {verifying ? 0.7 : 1};
						"
					>
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
		style="position: fixed; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 1000;"
		onclick={closeDeleteDialog}
		onkeydown={(e) => e.key === 'Escape' && closeDeleteDialog()}
		tabindex="-1"
		role="dialog"
	>
		<div
			style="background: white; border-radius: 8px; padding: 24px; max-width: 500px; width: 90%;"
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			role="document"
		>
			<h2 style="font-size: 20px; font-weight: bold; margin: 0 0 16px 0; color: #1f2937;">
				Delete Domain Mapping
			</h2>

			{#if deleteError}
				<div
					style="padding: 12px 16px; background-color: #fee2e2; color: #b91c1c; border-radius: 6px; margin-bottom: 16px;"
				>
					{deleteError}
				</div>
			{/if}

			<p style="color: #6b7280; margin: 0 0 16px 0;">
				Are you sure you want to delete this domain mapping? New users from this domain will no
				longer be automatically assigned to the organization.
			</p>

			<div
				style="background-color: #f9fafb; padding: 12px; border-radius: 6px; margin-bottom: 24px;"
			>
				<p style="margin: 0 0 8px 0; font-size: 14px; color: #374151;">
					<strong>Organization:</strong>
					{mappingToDelete.org_id}
				</p>
				<p style="margin: 0; font-size: 14px; color: #374151;">
					<strong>Status:</strong>
					{mappingToDelete.verified ? 'Verified' : 'Pending Verification'}
				</p>
			</div>

			<div style="display: flex; justify-content: flex-end; gap: 12px;">
				<button
					onclick={closeDeleteDialog}
					disabled={deleting}
					style="
						padding: 10px 20px;
						background-color: #f3f4f6;
						color: #374151;
						border: none;
						border-radius: 6px;
						cursor: pointer;
						font-size: 14px;
					"
				>
					Cancel
				</button>
				<button
					onclick={confirmDelete}
					disabled={deleting}
					style="
						padding: 10px 20px;
						background-color: #dc2626;
						color: white;
						border: none;
						border-radius: 6px;
						cursor: pointer;
						font-size: 14px;
						opacity: {deleting ? 0.7 : 1};
					"
				>
					{deleting ? 'Deleting...' : 'Delete Mapping'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.organizations-page {
		padding: 24px;
		max-width: 1400px;
		margin: 0 auto;
	}

	.page-header {
		margin-bottom: 24px;
	}

	.page-header h1 {
		font-size: 24px;
		font-weight: bold;
		margin: 0 0 8px 0;
		color: #1f2937;
	}

	.page-header .description {
		color: #6b7280;
		margin: 0;
	}

	.tabs {
		display: flex;
		gap: 0;
		border-bottom: 1px solid #e5e7eb;
		margin-bottom: 24px;
	}

	.tab {
		padding: 12px 24px;
		background: none;
		border: none;
		border-bottom: 2px solid transparent;
		font-size: 14px;
		font-weight: 500;
		color: #6b7280;
		cursor: pointer;
		transition: all 0.15s;
	}

	.tab:hover {
		color: #374151;
	}

	.tab.active {
		color: #2563eb;
		border-bottom-color: #2563eb;
	}

	.hierarchy-section,
	.mappings-section {
		background: white;
		border-radius: 8px;
		border: 1px solid #e5e7eb;
		padding: 24px;
	}

	.hierarchy-toolbar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 16px;
		margin-bottom: 16px;
		flex-wrap: wrap;
	}

	.search-box {
		display: flex;
		gap: 8px;
	}

	.search-box input {
		padding: 8px 12px;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		font-size: 14px;
		width: 250px;
	}

	.search-box button {
		padding: 8px 16px;
		background-color: #3b82f6;
		color: white;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		font-size: 14px;
	}

	.toolbar-actions {
		display: flex;
		gap: 8px;
	}

	.btn-secondary {
		padding: 8px 16px;
		background-color: #f3f4f6;
		color: #374151;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		font-size: 14px;
	}

	.btn-secondary:hover:not(:disabled) {
		background-color: #e5e7eb;
	}

	.btn-secondary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-primary {
		padding: 10px 20px;
		background-color: #3b82f6;
		color: white;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		font-size: 14px;
	}

	.btn-primary:hover {
		background-color: #2563eb;
	}

	.error-banner {
		background-color: #fef2f2;
		border: 1px solid #fecaca;
		color: #b91c1c;
		padding: 12px 16px;
		border-radius: 6px;
		margin-bottom: 16px;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.error-banner button {
		padding: 6px 12px;
		background-color: #b91c1c;
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}

	.loading-state {
		text-align: center;
		padding: 48px;
		color: #6b7280;
	}

	.empty-state {
		text-align: center;
		padding: 48px;
		color: #6b7280;
	}

	.hierarchy-summary {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 12px 16px;
		background-color: #f9fafb;
		border-radius: 6px;
		margin-bottom: 16px;
		font-size: 14px;
		color: #374151;
	}

	.hierarchy-summary .separator {
		color: #d1d5db;
	}

	.hierarchy-summary .highlight-count {
		color: #d97706;
		font-weight: 500;
	}

	.tree-container {
		border: 1px solid #e5e7eb;
		border-radius: 6px;
		padding: 16px;
		max-height: 600px;
		overflow-y: auto;
	}

	.section-header {
		display: flex;
		justify-content: space-between;
		align-items: flex-start;
		gap: 16px;
		margin-bottom: 24px;
	}

	.section-description {
		color: #6b7280;
		margin: 0;
		flex: 1;
	}
</style>
