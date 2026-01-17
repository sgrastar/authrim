<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';

	interface Props {
		data: {
			label?: string;
			config?: {
				type?: string;
			};
			onConfigClick?: () => void;
			readonly?: boolean;
		};
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	const label = $derived(data?.label || 'Identifier Input');
	const identifierType = $derived(data?.config?.type || 'email');

	function handleConfigClick(event: MouseEvent) {
		event.stopPropagation();
		data?.onConfigClick?.();
	}
</script>

<div class="identifier-node" class:selected>
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
		<span class="icon">👤</span>
		<span class="label">{label}</span>
	</div>
	<div class="node-body">
		<span class="config-value">{identifierType}</span>
	</div>
	<Handle type="target" position={Position.Left} />
	<div class="handle-wrapper handle-success">
		<Handle type="source" position={Position.Right} id="success" />
		<span class="handle-label success">✓</span>
	</div>
	<div class="handle-wrapper handle-failure">
		<Handle type="source" position={Position.Bottom} id="failure" />
		<span class="handle-label failure">✗</span>
	</div>
</div>

<style>
	.identifier-node {
		position: relative;
		background: white;
		border: 1px solid #ededed;
		border-left: 3px solid #3b82f6;
		border-radius: 6px;
		min-width: 100px;
	}

	.identifier-node.selected {
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

	.identifier-node:hover .config-btn {
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
	}

	.node-body {
		padding: 4px 10px 6px;
		font-size: 9px;
		border-top: 1px solid #f3f4f6;
	}

	.config-value {
		color: #6b7280;
	}

	.handle-wrapper {
		position: absolute;
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.handle-wrapper.handle-success {
		right: -8px;
		top: 50%;
		transform: translateY(-50%);
	}

	.handle-wrapper.handle-failure {
		bottom: -8px;
		left: 50%;
		transform: translateX(-50%);
		flex-direction: column;
	}

	.handle-label {
		font-size: 7px;
		font-weight: 600;
		padding: 1px 3px;
		border-radius: 2px;
		pointer-events: none;
	}

	.handle-label.success {
		background: #dcfce7;
		color: #166534;
		margin-left: 10px;
	}

	.handle-label.failure {
		background: #fee2e2;
		color: #991b1b;
		margin-top: 10px;
	}
</style>
