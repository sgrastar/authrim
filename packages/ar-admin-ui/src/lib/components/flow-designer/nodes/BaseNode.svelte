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
		color = 'var(--color-text-muted)',
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
		background: var(--flow-node-bg, var(--color-surface));
		border: 2px solid var(--node-color);
		border-radius: var(--radius-panel, 8px);
		color: var(--color-text);
		min-width: 150px;
		font-family: var(--font-body, system-ui, -apple-system, sans-serif);
		box-shadow: var(--flow-node-shadow, var(--shadow-sm));
		transition:
			box-shadow 0.2s,
			transform 0.2s;
	}

	.base-node.selected {
		box-shadow:
			var(--flow-node-selected-ring, 0 0 0 2px var(--node-color)),
			var(--flow-node-selected-shadow, var(--shadow-panel));
	}

	.node-header {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 6px 10px;
		background: var(--node-color);
		color: var(--flow-node-header-text, var(--color-accent-contrast));
		border-radius: calc(var(--radius-panel, 8px) - 2px) calc(var(--radius-panel, 8px) - 2px) 0 0;
		font-weight: var(--font-weight-semibold, 600);
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
		color: var(--color-text-muted);
	}

	.config-item {
		display: flex;
		gap: 4px;
		margin-bottom: 2px;
	}

	.config-key {
		color: var(--color-text-muted);
	}

	.config-value {
		color: var(--color-text);
	}

	:global(.handle) {
		width: 12px !important;
		height: 12px !important;
		border: 2px solid var(--flow-node-bg, var(--color-surface)) !important;
	}

	:global(.handle-input) {
		background: var(--flow-handle-input, var(--color-info)) !important;
	}

	:global(.handle-output) {
		background: var(--flow-handle-output, var(--color-success)) !important;
	}

	:global(.handle-error) {
		background: var(--flow-handle-error, var(--color-danger)) !important;
	}
</style>
