<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';
	import type { NodeProps } from '@xyflow/svelte';

	interface Props extends NodeProps {
		color?: string;
		icon?: string;
		showErrorHandle?: boolean;
	}

	let {
		data,
		selected = false,
		color = '#6b7280',
		icon = 'circle',
		showErrorHandle = false
	}: Props = $props();

	const label = $derived(data.label || 'Node');
</script>

<div class="base-node" class:selected style="--node-color: {color}">
	<div class="node-header">
		<span class="node-icon">{icon}</span>
		<span class="node-label">{label}</span>
	</div>

	{#if data.config && Object.keys(data.config).length > 0}
		<div class="node-config">
			{#each Object.entries(data.config).slice(0, 2) as [key, value] (key)}
				<div class="config-item">
					<span class="config-key">{key}:</span>
					<span class="config-value">{String(value).substring(0, 20)}</span>
				</div>
			{/each}
		</div>
	{/if}

	<Handle type="target" position={Position.Left} class="handle handle-input" />
	<Handle type="source" position={Position.Right} class="handle handle-output" id="success" />
	{#if showErrorHandle}
		<Handle type="source" position={Position.Bottom} class="handle handle-error" id="error" />
	{/if}
</div>

<style>
	.base-node {
		background: white;
		border: 2px solid var(--node-color);
		border-radius: 8px;
		min-width: 150px;
		font-family:
			system-ui,
			-apple-system,
			sans-serif;
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
		transition:
			box-shadow 0.2s,
			transform 0.2s;
	}

	.base-node.selected {
		box-shadow:
			0 0 0 2px var(--node-color),
			0 4px 6px rgba(0, 0, 0, 0.1);
	}

	.node-header {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 6px 10px;
		background: var(--node-color);
		color: white;
		border-radius: 6px 6px 0 0;
		font-weight: 500;
		font-size: 11px;
	}

	.node-icon {
		font-size: 10px;
	}

	.node-label {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.node-config {
		padding: 8px 14px;
		font-size: 11px;
		color: #6b7280;
	}

	.config-item {
		display: flex;
		gap: 4px;
		margin-bottom: 2px;
	}

	.config-key {
		color: #9ca3af;
	}

	.config-value {
		color: #374151;
	}

	:global(.handle) {
		width: 12px !important;
		height: 12px !important;
		border: 2px solid white !important;
	}

	:global(.handle-input) {
		background: #3b82f6 !important;
	}

	:global(.handle-output) {
		background: #22c55e !important;
	}

	:global(.handle-error) {
		background: #ef4444 !important;
	}
</style>
