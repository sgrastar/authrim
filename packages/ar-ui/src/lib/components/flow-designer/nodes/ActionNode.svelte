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
	const color = $derived(data?.color || '#6b7280');

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
		background: white;
		border: 1px solid #ededed;
		border-left: 3px solid var(--node-color);
		border-radius: 6px;
		min-width: 100px;
	}

	.action-node.selected {
		outline: 2px solid #ff4000;
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
		background: white;
		border: 1px solid #e5e7eb;
		border-radius: 3px;
		cursor: pointer;
		color: #9ca3af;
		opacity: 0;
		transition: opacity 0.15s;
		z-index: 10;
	}

	.action-node:hover .config-btn {
		opacity: 1;
	}

	.config-btn:hover {
		background: #f3f4f6;
		color: #374151;
	}

	.node-header {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 5px 8px;
		font-weight: 500;
		font-size: 10px;
		color: #374151;
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
		border-top: 1px solid #f3f4f6;
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
		color: #9ca3af;
	}

	.config-value {
		color: #374151;
		font-weight: 500;
	}
</style>
