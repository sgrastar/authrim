<script lang="ts">
	import { SvelteSet } from 'svelte/reactivity';
	import OrganizationTree from './OrganizationTree.svelte';
	import {
		adminOrganizationsAPI,
		type OrganizationNode,
		type OrganizationHierarchyResponse
	} from '$lib/api/admin-organizations';

	interface Props {
		open: boolean;
		onClose: () => void;
		onSelect: (org: OrganizationNode) => void;
		excludeIds?: string[];
		title?: string;
	}

	let { open, onClose, onSelect, excludeIds = [], title = 'Select Organization' }: Props = $props();

	// State
	let loading = $state(true);
	let error = $state<string | null>(null);
	let hierarchyData = $state<OrganizationHierarchyResponse | null>(null);
	let expandedNodes: Set<string> = new SvelteSet();
	let selectedOrg = $state<OrganizationNode | null>(null);
	let searchQuery = $state('');
	let highlightIds: Set<string> = new SvelteSet();

	// Load hierarchy when dialog opens
	$effect(() => {
		if (open) {
			loadHierarchy();
		} else {
			// Reset state when closed
			selectedOrg = null;
			searchQuery = '';
			highlightIds = new Set();
		}
	});

	async function loadHierarchy() {
		loading = true;
		error = null;
		try {
			// Get root organizations first
			const orgList = await adminOrganizationsAPI.listOrganizations({ limit: 100 });

			// Find root orgs (no parent)
			const rootOrgs = orgList.organizations.filter((org) => !org.parent_org_id);

			if (rootOrgs.length === 0) {
				error = 'No organizations found';
				return;
			}

			// Get hierarchy starting from first root org
			// In practice, you might want to load multiple roots
			const rootOrg = rootOrgs[0];
			hierarchyData = await adminOrganizationsAPI.getHierarchy(rootOrg.id);

			// Expand first level by default
			expandedNodes = new Set([hierarchyData.organization.id]);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load organizations';
		} finally {
			loading = false;
		}
	}

	async function handleSearch() {
		if (!searchQuery.trim()) {
			highlightIds = new Set();
			return;
		}

		try {
			const results = await adminOrganizationsAPI.listOrganizations({
				search: searchQuery.trim(),
				limit: 50
			});

			// Highlight matching organizations
			highlightIds = new Set(results.organizations.map((org) => org.id));

			// Expand paths to highlighted nodes
			if (hierarchyData) {
				const newExpanded = new Set(expandedNodes);
				for (const org of results.organizations) {
					expandPathToNode(hierarchyData.organization, org.id, newExpanded);
				}
				expandedNodes = newExpanded;
			}
		} catch {
			// Silently fail search
		}
	}

	function expandPathToNode(
		node: OrganizationNode,
		targetId: string,
		expanded: Set<string>
	): boolean {
		if (node.id === targetId) {
			return true;
		}

		if (node.children) {
			for (const child of node.children) {
				if (expandPathToNode(child, targetId, expanded)) {
					expanded.add(node.id);
					return true;
				}
			}
		}

		return false;
	}

	function handleToggle(nodeId: string, isExpanded: boolean) {
		const newSet = new SvelteSet(expandedNodes);
		if (isExpanded) {
			newSet.add(nodeId);
		} else {
			newSet.delete(nodeId);
		}
		expandedNodes = newSet;
	}

	function handleNodeSelect(node: OrganizationNode) {
		// Check if excluded
		if (excludeIds.includes(node.id)) {
			return;
		}
		selectedOrg = node;
	}

	function handleConfirm() {
		if (selectedOrg) {
			onSelect(selectedOrg);
			onClose();
		}
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			onClose();
		}
	}

	// Debounce search
	let searchTimeout: ReturnType<typeof setTimeout> | null = null;
	function handleSearchInput(e: Event) {
		const target = e.target as HTMLInputElement;
		searchQuery = target.value;

		if (searchTimeout) {
			clearTimeout(searchTimeout);
		}
		searchTimeout = setTimeout(() => {
			handleSearch();
		}, 300);
	}

	// Cleanup timer on unmount or dialog close
	$effect(() => {
		return () => {
			if (searchTimeout) {
				clearTimeout(searchTimeout);
				searchTimeout = null;
			}
		};
	});
</script>

{#if open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="dialog-overlay"
		role="dialog"
		aria-modal="true"
		aria-labelledby="dialog-title"
		onkeydown={handleKeyDown}
	>
		<div class="dialog-content">
			<div class="dialog-header">
				<h2 id="dialog-title">{title}</h2>
				<button class="close-btn" onclick={onClose} aria-label="Close">
					<span>×</span>
				</button>
			</div>

			<div class="dialog-body">
				<!-- Search -->
				<div class="search-box">
					<input
						type="text"
						placeholder="Search organizations..."
						value={searchQuery}
						oninput={handleSearchInput}
					/>
				</div>

				<!-- Tree -->
				<div class="tree-container">
					{#if loading}
						<div class="loading">Loading organizations...</div>
					{:else if error}
						<div class="error">{error}</div>
					{:else if hierarchyData}
						<OrganizationTree
							node={hierarchyData.organization}
							{expandedNodes}
							selectedId={selectedOrg?.id ?? null}
							selectable={true}
							onSelect={handleNodeSelect}
							onToggle={handleToggle}
							{highlightIds}
						/>
					{/if}
				</div>

				<!-- Selection info -->
				{#if selectedOrg}
					<div class="selection-info">
						<span class="label">Selected:</span>
						<span class="value">{selectedOrg.display_name || selectedOrg.name}</span>
					</div>
				{/if}
			</div>

			<div class="dialog-footer">
				<button class="btn btn-secondary" onclick={onClose}> Cancel </button>
				<button class="btn btn-primary" onclick={handleConfirm} disabled={!selectedOrg}>
					Select
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.dialog-overlay {
		position: fixed;
		inset: 0;
		background-color: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
	}

	.dialog-content {
		background: white;
		border-radius: 8px;
		box-shadow:
			0 20px 25px -5px rgba(0, 0, 0, 0.1),
			0 10px 10px -5px rgba(0, 0, 0, 0.04);
		max-width: 500px;
		width: 90%;
		max-height: 80vh;
		display: flex;
		flex-direction: column;
	}

	.dialog-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 20px;
		border-bottom: 1px solid #e5e7eb;
	}

	.dialog-header h2 {
		margin: 0;
		font-size: 18px;
		font-weight: 600;
		color: #111827;
	}

	.close-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		background: none;
		border: none;
		border-radius: 6px;
		cursor: pointer;
		color: #6b7280;
		font-size: 24px;
		line-height: 1;
	}

	.close-btn:hover {
		background-color: #f3f4f6;
		color: #374151;
	}

	.dialog-body {
		flex: 1;
		overflow: hidden;
		display: flex;
		flex-direction: column;
		padding: 16px 20px;
	}

	.search-box {
		margin-bottom: 12px;
	}

	.search-box input {
		width: 100%;
		padding: 8px 12px;
		border: 1px solid #d1d5db;
		border-radius: 6px;
		font-size: 14px;
	}

	.search-box input:focus {
		outline: none;
		border-color: #2563eb;
		box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
	}

	.tree-container {
		flex: 1;
		overflow-y: auto;
		border: 1px solid #e5e7eb;
		border-radius: 6px;
		min-height: 200px;
		max-height: 300px;
	}

	.loading,
	.error {
		padding: 24px;
		text-align: center;
		color: #6b7280;
	}

	.error {
		color: #dc2626;
	}

	.selection-info {
		margin-top: 12px;
		padding: 8px 12px;
		background-color: #f0f9ff;
		border-radius: 6px;
		font-size: 14px;
	}

	.selection-info .label {
		color: #6b7280;
		margin-right: 8px;
	}

	.selection-info .value {
		color: #1e40af;
		font-weight: 500;
	}

	.dialog-footer {
		display: flex;
		justify-content: flex-end;
		gap: 12px;
		padding: 16px 20px;
		border-top: 1px solid #e5e7eb;
	}

	.btn {
		padding: 8px 16px;
		border-radius: 6px;
		font-size: 14px;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s;
	}

	.btn-secondary {
		background-color: white;
		border: 1px solid #d1d5db;
		color: #374151;
	}

	.btn-secondary:hover {
		background-color: #f9fafb;
	}

	.btn-primary {
		background-color: #2563eb;
		border: 1px solid #2563eb;
		color: white;
	}

	.btn-primary:hover:not(:disabled) {
		background-color: #1d4ed8;
	}

	.btn-primary:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
