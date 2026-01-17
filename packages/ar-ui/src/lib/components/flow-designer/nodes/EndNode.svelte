<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';

	interface Props {
		data: {
			label?: string;
		};
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	const label = $derived(data?.label || 'End');
</script>

<div class="end-node" class:selected>
	<Handle type="target" position={Position.Left} />
	<span class="icon">✓</span>
	<span class="label">{label}</span>
</div>

<style>
	.end-node {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 5px 10px;
		background: #10b981;
		color: white;
		border-radius: 16px;
		font-weight: 500;
		font-size: 10px;
		border: none;
	}

	.end-node.selected {
		outline: 2px solid #ff4000;
		outline-offset: 2px;
	}

	.icon {
		font-size: 9px;
	}

	.label {
		white-space: nowrap;
	}
</style>
