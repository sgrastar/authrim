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

	const label = $derived(data?.label || 'Check');
	const icon = $derived(data?.icon || '🔍');
	const color = $derived(data?.color || '#a855f7');

	// Get check condition display
	const checkCondition = $derived(() => {
		const config = data?.config || {};
		if (config.key) return `${config.key} ${config.operator || '=='} ${config.value ?? '?'}`;
		return null;
	});

	function handleConfigClick(event: MouseEvent) {
		event.stopPropagation();
		data?.onConfigClick?.();
	}
</script>

<div class="logic-node" class:selected style="--node-color: {color}">
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
	{#if checkCondition()}
		<div class="node-body">
			<span class="condition">{checkCondition()}</span>
		</div>
	{/if}
	<Handle type="target" position={Position.Left} />
	<div class="handle-wrapper handle-yes">
		<Handle type="source" position={Position.Right} id="true" />
		<span class="handle-label yes">Yes</span>
	</div>
	<div class="handle-wrapper handle-no">
		<Handle type="source" position={Position.Bottom} id="false" />
		<span class="handle-label no">No</span>
	</div>
</div>

<style>
	.logic-node {
		position: relative;
		background: white;
		border: 1px solid #ededed;
		border-left: 3px solid var(--node-color);
		border-radius: 6px;
		min-width: 120px;
	}

	.logic-node.selected {
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

	.logic-node:hover .config-btn {
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
	}

	.node-body {
		padding: 4px 10px 6px;
		border-top: 1px solid #f3f4f6;
	}

	.condition {
		font-size: 9px;
		color: #6b7280;
		font-family: ui-monospace, monospace;
		word-break: break-all;
	}

	.handle-wrapper {
		position: absolute;
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.handle-wrapper.handle-yes {
		right: -8px;
		top: 50%;
		transform: translateY(-50%);
	}

	.handle-wrapper.handle-no {
		bottom: -8px;
		left: 50%;
		transform: translateX(-50%);
		flex-direction: column;
	}

	.handle-label {
		font-size: 8px;
		font-weight: 600;
		padding: 1px 4px;
		border-radius: 2px;
		pointer-events: none;
	}

	.handle-label.yes {
		background: #dcfce7;
		color: #166534;
		margin-left: 12px;
	}

	.handle-label.no {
		background: #fef3c7;
		color: #92400e;
		margin-top: 10px;
	}
</style>
