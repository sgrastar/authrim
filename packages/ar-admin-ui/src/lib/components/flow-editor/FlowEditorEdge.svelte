<script lang="ts" module>
	export interface FlowEditorEdgeData extends Record<string, unknown> {
		deletable?: boolean;
	}
</script>

<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import { BaseEdge, EdgeLabel, getBezierPath, type Edge, type EdgeProps } from '@xyflow/svelte';

	type EditorEdge = Edge<FlowEditorEdgeData, 'editor'>;

	const DELETE_EDGE_EVENT = 'authrim-flow-delete-edge';

	let {
		id,
		interactionWidth = 24,
		markerEnd,
		markerStart,
		selected = false,
		sourcePosition,
		sourceX,
		sourceY,
		style,
		targetPosition,
		targetX,
		targetY
	}: EdgeProps<EditorEdge> = $props();

	let [path, labelX, labelY] = $derived(
		getBezierPath({
			sourceX,
			sourceY,
			targetX,
			targetY,
			sourcePosition,
			targetPosition,
			curvature: 0.34
		})
	);
	const deleteLabelPosition = $derived.by(() => {
		const dx = targetX - sourceX;
		const dy = targetY - sourceY;
		const distance = Math.hypot(dx, dy) || 1;
		const unitX = dx / distance;
		const unitY = dy / distance;
		const leftNormalX = -unitY;
		const leftNormalY = unitX;
		const pointX = targetX - unitX * 24;
		const pointY = targetY - unitY * 24;

		return {
			x: pointX + leftNormalX * 20,
			y: pointY + leftNormalY * 20
		};
	});

	function handleDelete(event: MouseEvent | KeyboardEvent) {
		event.preventDefault();
		event.stopPropagation();
		const target = event.currentTarget;
		if (target instanceof HTMLElement && id) {
			target.dispatchEvent(
				new CustomEvent<{ edgeId: string }>(DELETE_EDGE_EVENT, {
					bubbles: true,
					composed: true,
					detail: { edgeId: id }
				})
			);
		}
	}

	function handleDeleteKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		handleDelete(event);
	}
</script>

<BaseEdge
	{id}
	{path}
	{labelX}
	{labelY}
	{markerStart}
	{markerEnd}
	{interactionWidth}
	{style}
	class={['flow-editor-edge', selected && 'flow-editor-edge--selected']}
/>

{#if selected}
	<EdgeLabel x={deleteLabelPosition.x} y={deleteLabelPosition.y} class="flow-editor-edge__label">
		<button
			type="button"
			class="flow-editor-edge__delete nodrag nopan"
			aria-label={$LL.admin_flows_delete()}
			onclick={handleDelete}
			onkeydown={handleDeleteKeydown}
		>
			<i class="i-ph-x" aria-hidden="true"></i>
		</button>
	</EdgeLabel>
{/if}

<style>
	:global(.flow-editor-edge) {
		stroke: var(
			--flow-edge-color,
			color-mix(in srgb, var(--color-accent) 72%, var(--color-border))
		);
		stroke-width: 1.65;
		opacity: 0.76;
		transition:
			opacity 140ms ease,
			stroke 140ms ease,
			stroke-width 140ms ease,
			filter 140ms ease;
	}

	:global(.svelte-flow__edge:hover .flow-editor-edge),
	:global(.flow-editor-edge--selected) {
		stroke: var(--color-accent);
		stroke-width: 1.9;
		opacity: 1;
	}

	:global(.flow-editor-edge--selected) {
		stroke-dasharray: 6 6;
		filter: drop-shadow(0 0 4px color-mix(in srgb, var(--color-accent) 42%, transparent));
		animation: flow-editor-edge-flow 620ms linear infinite;
	}

	:global(.svelte-flow__edge-interaction) {
		cursor: pointer;
	}

	:global(.flow-editor-edge__label) {
		pointer-events: all;
	}

	.flow-editor-edge__delete {
		width: 18px;
		height: 18px;
		display: grid;
		place-items: center;
		padding: 0;
		border: 1px solid color-mix(in srgb, var(--color-danger) 72%, var(--color-border));
		border-radius: 999px;
		background: var(--color-surface-elevated, var(--color-surface));
		color: var(--color-danger);
		box-shadow:
			0 0 0 2px color-mix(in srgb, var(--color-danger) 12%, transparent),
			0 8px 18px rgb(15 23 42 / 0.22);
		font: inherit;
		font-size: 0.72rem;
		line-height: 1;
		cursor: pointer;
	}

	.flow-editor-edge__delete:hover,
	.flow-editor-edge__delete:focus-visible {
		background: color-mix(in srgb, var(--color-danger) 10%, var(--color-surface));
		outline: none;
	}

	.flow-editor-edge__delete :global(i) {
		font-size: 0.76rem;
		line-height: 1;
	}

	@keyframes flow-editor-edge-flow {
		to {
			stroke-dashoffset: -12;
		}
	}
</style>
