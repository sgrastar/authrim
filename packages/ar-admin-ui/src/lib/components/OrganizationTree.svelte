<script lang="ts">
	import type { OrganizationNode } from '$lib/api/admin-organizations';

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
			aria-label={isExpanded ? 'Collapse' : 'Expand'}
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
				<span class="badge inactive">Inactive</span>
			{/if}
			<span class="badge member-count" title="Members">
				{node.member_count}
			</span>
		</div>
	</div>

	{#if hasChildren && isExpanded}
		<div class="children">
			{#each node.children as child (child.id)}
				<svelte:self
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
		border-radius: 6px;
		transition: background-color 0.15s;
	}

	.node-content:hover {
		background-color: #f3f4f6;
	}

	.node-content.selectable {
		cursor: pointer;
	}

	.node-content.selected {
		background-color: #dbeafe;
		outline: 2px solid #2563eb;
	}

	.node-content.highlighted {
		background-color: #fef3c7;
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
		color: #6b7280;
		font-size: 10px;
		flex-shrink: 0;
	}

	.toggle-btn:hover:not(:disabled) {
		color: #374151;
	}

	.toggle-btn:disabled {
		cursor: default;
	}

	.toggle-icon.empty {
		color: #d1d5db;
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
		font-weight: 500;
		color: #111827;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.node-slug {
		font-size: 12px;
		color: #9ca3af;
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
		border-radius: 4px;
		white-space: nowrap;
	}

	.badge.inactive {
		background-color: #fef2f2;
		color: #b91c1c;
	}

	.badge.member-count {
		background-color: #f3f4f6;
		color: #6b7280;
	}

	.children {
		border-left: 1px solid #e5e7eb;
		margin-left: calc(var(--depth) * var(--indent-size) + 21px);
	}
</style>
