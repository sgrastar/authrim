<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';

	interface Props {
		data: {
			label?: string;
			icon?: string;
			color?: string;
			config?: Record<string, unknown>;
			onConfigClick?: () => void;
			readonly?: boolean;
		};
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	const label = $derived(data?.label || 'Action');
	const icon = $derived(data?.icon || '⚡');
	const color = $derived(data?.color || 'var(--flow-node-color-muted)');

	// Get display config items (max 2)
	const configItems = $derived(() => {
		const config = data?.config || {};
		return Object.entries(config).slice(0, 2);
	});

	function handleConfigClick(event: MouseEvent) {
		event.stopPropagation();
		data?.onConfigClick?.();
	}
</script>

<div class="action-node" class:selected style="--node-color: {color}">
	{#if data?.onConfigClick && !data?.readonly}
		<button class="config-btn" onclick={handleConfigClick} title="Configure">
			<svg
				width="12"
				height="12"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
			>
				<circle cx="12" cy="12" r="3"></circle>
				<path
					d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
				></path>
			</svg>
		</button>
	{/if}
	<div class="node-header">
		<span class="icon">{icon}</span>
		<span class="label">{label}</span>
	</div>
	{#if configItems().length > 0}
		<div class="node-body">
			{#each configItems() as [key, value] (key)}
				<div class="config-item">
					<span class="config-key">{key}:</span>
					<span class="config-value">{String(value).substring(0, 15)}</span>
				</div>
			{/each}
		</div>
	{/if}
	<Handle type="target" position={Position.Left} />
	<Handle type="source" position={Position.Right} id="success" />
</div>

<style>
	.action-node {
		position: relative;
		background: var(--flow-node-bg, var(--color-surface));
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--node-color);
		border-radius: var(--radius-panel, 6px);
		color: var(--color-text);
		min-width: 100px;
		box-shadow: var(--flow-node-shadow, var(--shadow-sm));
	}

	.action-node.selected {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.config-btn {
		position: absolute;
		top: 2px;
		right: 2px;
		width: 18px;
		height: 18px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 4px);
		cursor: pointer;
		color: var(--color-text-muted);
		opacity: 0;
		transition: opacity 0.15s;
		z-index: 10;
	}

	.action-node:hover .config-btn {
		opacity: 1;
	}

	.config-btn:hover {
		background: var(--color-surface-muted);
		color: var(--color-text);
	}

	.node-header {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 5px 8px;
		font-weight: var(--font-weight-semibold, 600);
		font-size: 10px;
		color: var(--color-text);
	}

	.icon {
		font-size: 10px;
	}

	.label {
		flex: 1;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.node-body {
		padding: 4px 10px 6px;
		font-size: 9px;
		border-top: 1px solid var(--color-border);
	}

	.config-item {
		display: flex;
		gap: 3px;
		margin-bottom: 1px;
	}

	.config-item:last-child {
		margin-bottom: 0;
	}

	.config-key {
		color: var(--color-text-muted);
	}

	.config-value {
		color: var(--color-text);
		font-weight: var(--font-weight-semibold, 600);
	}
</style>
