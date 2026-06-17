<script lang="ts">
	import type { OrganizationNode } from '$lib/api/admin-organizations';
	import { LL } from '$i18n/i18n-svelte';
	import OrganizationTree from './OrganizationTree.svelte';

	interface Props {
		node: OrganizationNode;
		expandedNodes?: Set<string>;
		selectedId?: string | null;
		selectable?: boolean;
		onSelect?: (node: OrganizationNode) => void;
		onToggle?: (nodeId: string, expanded: boolean) => void;
		highlightIds?: Set<string>;
	}

	let {
		node,
		expandedNodes = new Set(),
		selectedId = null,
		selectable = false,
		onSelect,
		onToggle,
		highlightIds = new Set()
	}: Props = $props();

	let isExpanded = $derived(expandedNodes.has(node.id));
	let hasChildren = $derived(node.children && node.children.length > 0);
	let isSelected = $derived(selectedId === node.id);
	let isHighlighted = $derived(highlightIds.has(node.id));

	function handleToggle(e: Event) {
		e.stopPropagation();
		onToggle?.(node.id, !isExpanded);
	}

	function handleSelect() {
		if (selectable && onSelect) {
			onSelect(node);
		}
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			if (selectable) {
				handleSelect();
			} else if (hasChildren) {
				handleToggle(e);
			}
		}
	}
</script>

<div class="tree-node" style="--depth: {node.depth}">
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div
		class="node-content"
		class:selectable
		class:selected={isSelected}
		class:highlighted={isHighlighted}
		class:inactive={!node.is_active}
		role={selectable ? 'button' : undefined}
		tabindex={selectable ? 0 : undefined}
		onclick={selectable ? handleSelect : undefined}
		onkeydown={handleKeyDown}
	>
		<button
			class="toggle-btn"
			class:has-children={hasChildren}
			onclick={handleToggle}
			aria-label={isExpanded ? $LL.admin_org_tree_collapse() : $LL.admin_org_tree_expand()}
			disabled={!hasChildren}
		>
			{#if hasChildren}
				<span class="toggle-icon">{isExpanded ? '▼' : '▶'}</span>
			{:else}
				<span class="toggle-icon empty">•</span>
			{/if}
		</button>

		<div class="node-info">
			<span class="node-name">
				{node.display_name || node.name}
			</span>
			{#if node.display_name && node.display_name !== node.name}
				<span class="node-slug">({node.name})</span>
			{/if}
		</div>

		<div class="node-badges">
			{#if !node.is_active}
				<span class="badge inactive">{$LL.admin_org_inactive()}</span>
			{/if}
			<span class="badge member-count" title={$LL.admin_org_tree_members()}>
				{node.member_count}
			</span>
		</div>
	</div>

	{#if hasChildren && isExpanded}
		<div class="children">
			{#each node.children as child (child.id)}
				<OrganizationTree
					node={child}
					{expandedNodes}
					{selectedId}
					{selectable}
					{onSelect}
					{onToggle}
					{highlightIds}
				/>
			{/each}
		</div>
	{/if}
</div>

<style>
	.tree-node {
		--indent-size: 24px;
	}

	.node-content {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		padding-left: calc(var(--depth) * var(--indent-size) + 12px);
		border-radius: var(--radius-control, 6px);
		transition:
			background-color 0.15s ease,
			outline-color 0.15s ease;
	}

	.node-content:hover {
		background: var(--color-surface-muted);
	}

	.node-content.selectable {
		cursor: pointer;
	}

	.node-content.selected {
		background: color-mix(in srgb, var(--color-accent) 12%, var(--color-surface));
		outline: 2px solid var(--color-accent);
	}

	.node-content.highlighted {
		background: color-mix(in srgb, var(--color-warning) 15%, var(--color-surface));
	}

	.node-content.inactive {
		opacity: 0.6;
	}

	.toggle-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		padding: 0;
		background: none;
		border: none;
		cursor: pointer;
		color: var(--color-text-muted);
		font-size: 10px;
		flex-shrink: 0;
	}

	.toggle-btn:hover:not(:disabled) {
		color: var(--color-text);
	}

	.toggle-btn:disabled {
		cursor: default;
	}

	.toggle-icon.empty {
		color: var(--color-text-subtle);
	}

	.node-info {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.node-name {
		font-size: 14px;
		font-weight: var(--font-weight-semibold, 600);
		color: var(--color-text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.node-slug {
		font-size: 12px;
		color: var(--color-text-muted);
		white-space: nowrap;
	}

	.node-badges {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
	}

	.badge {
		font-size: 11px;
		padding: 2px 6px;
		border-radius: var(--radius-control, 6px);
		white-space: nowrap;
	}

	.badge.inactive {
		background: color-mix(in srgb, var(--color-danger) 12%, var(--color-surface));
		color: var(--color-danger);
	}

	.badge.member-count {
		background: var(--color-surface-muted);
		color: var(--color-text-muted);
	}

	.children {
		border-left: 1px solid var(--color-border);
		margin-left: calc(var(--depth) * var(--indent-size) + 21px);
	}
</style>
