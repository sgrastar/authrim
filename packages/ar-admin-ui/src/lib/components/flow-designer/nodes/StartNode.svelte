<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';

	interface Props {
		data: {
			label?: string;
		};
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	const label = $derived(data?.label || 'Start');
</script>

<div class="start-node" class:selected>
	<span class="icon">▶</span>
	<span class="label">{label}</span>
	<Handle type="source" position={Position.Right} id="success" />
</div>

<style>
	.start-node {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 5px 10px;
		background: #22c55e;
		color: white;
		border-radius: 16px;
		font-weight: 500;
		font-size: 10px;
		border: none;
	}

	.start-node.selected {
		outline: 2px solid #ff4000;
		outline-offset: 2px;
	}

	.icon {
		font-size: 8px;
	}

	.label {
		white-space: nowrap;
	}
</style>
