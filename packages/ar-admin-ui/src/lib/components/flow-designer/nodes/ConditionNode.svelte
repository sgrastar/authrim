<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';

	interface Props {
		data: {
			label?: string;
			config?: {
				expression?: string;
			};
			onConfigClick?: () => void;
			readonly?: boolean;
		};
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	const label = $derived(data?.label || 'Condition');
	// Expression can be used for tooltip or display in future
	// const expression = $derived(data?.config?.expression || 'true');

	function handleConfigClick(event: MouseEvent) {
		event.stopPropagation();
		data?.onConfigClick?.();
	}
</script>

<div class="condition-node" class:selected>
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
	<Handle type="target" position={Position.Left} />
	<div class="node-shape">
		<div class="content">
			<span class="icon">⋔</span>
			<span class="label">{label}</span>
		</div>
	</div>
	<div class="handle-yes">
		<Handle type="source" position={Position.Right} id="true" />
		<span class="handle-label">Yes</span>
	</div>
	<div class="handle-no">
		<Handle type="source" position={Position.Bottom} id="false" />
		<span class="handle-label">No</span>
	</div>
</div>

<style>
	.condition-node {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.config-btn {
		position: absolute;
		top: -4px;
		right: -4px;
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

	.condition-node:hover .config-btn {
		opacity: 1;
	}

	.config-btn:hover {
		background: #f3f4f6;
		color: #374151;
	}

	.node-shape {
		position: relative;
		min-width: 80px;
		padding: 8px 12px;
		background: white;
		border: 1px solid #ec4899;
		border-radius: 6px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.condition-node.selected .node-shape {
		outline: 2px solid #ff4000;
		outline-offset: 2px;
	}

	.content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
	}

	.icon {
		font-size: 10px;
		color: #ec4899;
	}

	.label {
		font-size: 10px;
		font-weight: 500;
		color: #374151;
		white-space: nowrap;
	}

	.handle-yes {
		position: absolute;
		right: -6px;
		top: 50%;
		transform: translateY(-50%);
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.handle-yes .handle-label {
		background: #dcfce7;
		color: #166534;
		margin-left: 10px;
	}

	.handle-no {
		position: absolute;
		bottom: -6px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
	}

	.handle-no .handle-label {
		background: #fef3c7;
		color: #92400e;
		margin-top: 8px;
	}

	.handle-label {
		font-size: 8px;
		font-weight: 600;
		padding: 1px 4px;
		border-radius: 2px;
		pointer-events: none;
	}
</style>
