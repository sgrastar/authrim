<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';

	interface FieldConfig {
		name: string;
		type: 'text' | 'email' | 'phone' | 'date' | 'select' | 'checkbox';
		label?: string;
		required?: boolean;
		options?: string[];
	}

	interface Props {
		data: {
			label?: string;
			config?: {
				fields?: FieldConfig[];
			};
			onConfigClick?: () => void;
			readonly?: boolean;
		};
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	const label = $derived(data?.label || 'User Input');
	const fields = $derived(data?.config?.fields || []);

	function handleConfigClick(event: MouseEvent) {
		event.stopPropagation();
		data?.onConfigClick?.();
	}

	function getFieldsSummary(): string {
		if (fields.length === 0) return 'No fields';
		if (fields.length <= 2) {
			return fields.map((f) => f.label || f.name).join(', ');
		}
		return `${fields.length} fields`;
	}
</script>

<div class="user-input-node" class:selected>
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
		<span class="icon">📋</span>
		<span class="label">{label}</span>
	</div>
	<div class="node-body">
		<span class="config-value">{getFieldsSummary()}</span>
		{#if fields.length > 0}
			<div class="field-list">
				{#each fields.slice(0, 3) as field (field.name)}
					<span class="field-chip" class:required={field.required}>
						{field.label || field.name}
					</span>
				{/each}
				{#if fields.length > 3}
					<span class="field-more">+{fields.length - 3}</span>
				{/if}
			</div>
		{/if}
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
	.user-input-node {
		position: relative;
		background: white;
		border: 1px solid #ededed;
		border-left: 3px solid #0ea5e9;
		border-radius: 6px;
		min-width: 120px;
	}

	.user-input-node.selected {
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

	.user-input-node:hover .config-btn {
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
		display: block;
		margin-bottom: 4px;
	}

	.field-list {
		display: flex;
		flex-wrap: wrap;
		gap: 2px;
	}

	.field-chip {
		display: inline-block;
		padding: 1px 4px;
		background: #f3f4f6;
		border-radius: 2px;
		font-size: 8px;
		color: #6b7280;
	}

	.field-chip.required {
		background: #dbeafe;
		color: #1d4ed8;
	}

	.field-more {
		display: inline-block;
		padding: 1px 4px;
		font-size: 8px;
		color: #9ca3af;
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
