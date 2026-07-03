<script lang="ts">
	import type { Node, NodeProps } from '@xyflow/svelte';

	export interface FlowEditorGroupData extends Record<string, unknown> {
		label: string;
		protocol?: string;
		purpose?: string;
	}

	type GroupNode = Node<FlowEditorGroupData, 'completionGroup'>;
	type Props = NodeProps<GroupNode> & {
		data: FlowEditorGroupData;
	};

	let { data }: Props = $props();
</script>

<div class="flow-editor-group-node" data-protocol={data.protocol ?? ''}>
	<span>{data.label}</span>
</div>

<style>
	.flow-editor-group-node {
		width: 100%;
		height: 100%;
		border: 1px dashed color-mix(in srgb, var(--color-info) 58%, var(--color-border));
		border-radius: 10px;
		background: color-mix(in srgb, var(--color-info) 5%, transparent);
		color: color-mix(in srgb, var(--color-info) 70%, var(--color-text));
		cursor: move;
	}

	.flow-editor-group-node[data-protocol='oidc'] {
		border-color: color-mix(in srgb, var(--color-info) 62%, var(--color-border));
		background: color-mix(in srgb, var(--color-info) 5%, transparent);
	}

	.flow-editor-group-node[data-protocol='saml'] {
		border-color: color-mix(in srgb, var(--color-warning) 62%, var(--color-border));
		background: color-mix(in srgb, var(--color-warning) 5%, transparent);
		color: color-mix(in srgb, var(--color-warning) 70%, var(--color-text));
	}

	.flow-editor-group-node span {
		position: absolute;
		top: -0.78rem;
		left: 14px;
		max-width: calc(100% - 28px);
		padding: 0 0.4rem;
		background: var(--color-surface);
		color: inherit;
		font-size: 0.72rem;
		font-weight: 850;
		line-height: 1.2;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
