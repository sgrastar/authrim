<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import { Handle, Position, type Node, type NodeProps } from '@xyflow/svelte';

	export type FlowEditorNodeKind =
		| 'start'
		| 'registration'
		| 'authentication'
		| 'verification'
		| 'profile'
		| 'consent'
		| 'account'
		| 'end'
		| 'decision';

	export interface FlowEditorNodeOutput {
		id: string;
		label: string;
	}

	export interface FlowEditorCompletionBlock {
		id: string;
		label: string;
		protocol?: string;
		purpose?: string;
		role?: 'consent' | 'output';
	}

	export interface FlowEditorNodeData extends Record<string, unknown> {
		kind: FlowEditorNodeKind;
		title: string;
		description: string;
		settings: string[];
		outputs: FlowEditorNodeOutput[];
		completionBlock?: FlowEditorCompletionBlock;
		configure?: (nodeId: string) => void;
	}

	type EditorNode = Node<FlowEditorNodeData, 'editor'>;
	type Props = NodeProps<EditorNode> & {
		data: FlowEditorNodeData;
	};

	const CONFIGURE_NODE_EVENT = 'authrim-flow-configure-node';
	let { id, data }: Props = $props();
	let showDescription = $state(false);
	const descriptionId = $derived(`${id}-description`);

	function handleConfigure(event: MouseEvent) {
		event.preventDefault();
		event.stopPropagation();
		const target = event.currentTarget;
		if (target instanceof HTMLElement) {
			target.dispatchEvent(
				new CustomEvent<{ nodeId: string }>(CONFIGURE_NODE_EVENT, {
					bubbles: true,
					composed: true,
					detail: { nodeId: id }
				})
			);
		}
		data.configure?.(id);
	}

	function stopNodeEvent(event: Event) {
		event.stopPropagation();
	}
</script>

<div
	class="flow-editor-node"
	class:flow-editor-node--description-visible={showDescription}
	data-kind={data.kind}
	data-completion-block={data.completionBlock?.role ?? undefined}
	role="group"
	aria-label={data.title}
	onpointerenter={() => (showDescription = true)}
	onpointerleave={() => (showDescription = false)}
	onfocusin={() => (showDescription = true)}
	onfocusout={() => (showDescription = false)}
>
	{#if data.kind !== 'start'}
		<Handle type="target" position={Position.Top} class="flow-editor-node__target" />
	{/if}

	<button
		type="button"
		class="flow-editor-node__settings nodrag nopan"
		onpointerdown={stopNodeEvent}
		onclick={handleConfigure}
		aria-label={$LL.admin_flows_node_settings_aria({ title: data.title })}
	>
		<i class="i-ph-gear-six" aria-hidden="true"></i>
	</button>

	{#if data.completionBlock}
		<div class="flow-editor-node__block-label" title={data.completionBlock.label}>
			<span>{data.completionBlock.label}</span>
		</div>
	{/if}

	<div class="flow-editor-node__title-row">
		<h2>{data.title}</h2>
	</div>

	{#if data.description}
		<span id={descriptionId} class="flow-editor-node__tooltip" role="tooltip">
			{data.description}
		</span>
	{/if}

	{#if data.kind !== 'end'}
		{#if data.outputs.length <= 1}
			<Handle
				id={data.outputs[0]?.id ?? 'default'}
				type="source"
				position={Position.Bottom}
				class="flow-editor-node__source flow-editor-node__source-bottom"
			/>
		{:else}
			<div
				class="flow-editor-node__outputs"
				aria-label={$LL.admin_flows_node_outputs_aria({ title: data.title })}
				style={`--output-count: ${data.outputs.length};`}
			>
				{#each data.outputs as output, index (output.id)}
					<div class="flow-editor-node__output">
						<span>{output.label}</span>
						<Handle
							id={output.id}
							type="source"
							position={Position.Bottom}
							class="flow-editor-node__source flow-editor-node__source-output"
							style={`left: ${Math.round(((index + 1) / (data.outputs.length + 1)) * 100)}%;`}
						/>
					</div>
				{/each}
			</div>
		{/if}
	{/if}
</div>

<style>
	.flow-editor-node {
		--flow-node-accent: var(--color-accent);
		--flow-node-glow: color-mix(in srgb, var(--flow-node-accent) 34%, transparent);
		position: relative;
		width: 226px;
		min-height: 54px;
		padding: 12px 12px 10px;
		border: 1px solid color-mix(in srgb, var(--flow-node-accent) 42%, var(--color-border));
		border-radius: 6px;
		background: var(--flow-node-bg, var(--color-surface));
		color: var(--color-text);
		box-shadow: var(--card-shadow, none);
		overflow: visible;
		transition:
			border-color 150ms ease,
			box-shadow 150ms ease,
			background 150ms ease;
	}

	.flow-editor-node:hover,
	.flow-editor-node:focus-within {
		z-index: 30;
		border-color: var(--flow-node-accent);
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--flow-node-accent) 66%, transparent),
			0 0 0 4px color-mix(in srgb, var(--flow-node-accent) 12%, transparent),
			0 0 20px 1px var(--flow-node-glow),
			var(--card-shadow, 0 8px 18px rgb(15 23 42 / 0.14));
	}

	.flow-editor-node[data-kind='start'] {
		--flow-node-accent: var(--color-success);
	}

	.flow-editor-node[data-kind='registration'],
	.flow-editor-node[data-kind='authentication'] {
		--flow-node-accent: var(--color-accent);
	}

	.flow-editor-node[data-kind='consent'] {
		--flow-node-accent: var(--color-warning);
	}

	.flow-editor-node[data-kind='end'] {
		--flow-node-accent: var(--color-info);
		display: flex;
		align-items: center;
	}

	.flow-editor-node[data-completion-block] {
		border-style: solid;
		background:
			linear-gradient(
				180deg,
				color-mix(in srgb, var(--flow-node-accent) 7%, transparent),
				transparent 42px
			),
			var(--flow-node-bg, var(--color-surface));
	}

	.flow-editor-node[data-completion-block='consent'] {
		--flow-node-accent: var(--color-warning);
	}

	.flow-editor-node[data-completion-block='output'] {
		--flow-node-accent: var(--color-info);
	}

	.flow-editor-node__settings {
		position: absolute;
		z-index: 4;
		top: 7px;
		right: 7px;
		width: 22px;
		height: 22px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		border: 1px solid color-mix(in srgb, var(--flow-node-accent) 36%, var(--color-border));
		border-radius: 999px;
		background: var(--flow-node-bg, var(--color-surface));
		color: var(--color-text);
		font: inherit;
		font-size: 0.8rem;
		font-weight: 800;
		cursor: pointer;
		opacity: 0;
		pointer-events: none;
		transform: translateY(-1px) scale(0.94);
		transition:
			opacity 120ms ease,
			transform 120ms ease,
			border-color 120ms ease,
			color 120ms ease;
	}

	.flow-editor-node:hover .flow-editor-node__settings,
	.flow-editor-node:focus-within .flow-editor-node__settings,
	.flow-editor-node__settings:focus-visible {
		opacity: 1;
		pointer-events: auto;
		transform: translateY(0) scale(1);
	}

	.flow-editor-node__settings:hover {
		border-color: var(--flow-node-accent);
		color: var(--flow-node-accent);
	}

	.flow-editor-node__settings :global(i) {
		font-size: 0.86rem;
		line-height: 1;
	}

	.flow-editor-node__title-row {
		position: relative;
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: 22px;
		padding-right: 54px;
	}

	.flow-editor-node__block-label {
		display: inline-flex;
		max-width: calc(100% - 34px);
		margin: 0 0 6px;
		padding: 2px 7px;
		border: 1px solid color-mix(in srgb, var(--flow-node-accent) 36%, transparent);
		border-radius: 999px;
		background: color-mix(in srgb, var(--flow-node-accent) 9%, transparent);
		color: color-mix(in srgb, var(--flow-node-accent) 72%, var(--color-text));
		font-size: 0.62rem;
		font-weight: 800;
		line-height: 1.2;
		text-transform: uppercase;
	}

	.flow-editor-node__block-label span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.flow-editor-node h2 {
		margin: 0;
		color: var(--color-text);
		font-family: var(--font-display);
		font-size: 0.86rem;
		font-weight: 850;
		line-height: 1.25;
	}

	.flow-editor-node__tooltip {
		position: absolute;
		z-index: 100;
		top: 50%;
		right: calc(100% + 12px);
		width: 220px;
		padding: 9px 10px;
		border: 1px solid color-mix(in srgb, var(--flow-node-accent) 48%, var(--color-border));
		border-radius: 6px;
		background: var(--color-surface-elevated, var(--color-surface));
		color: var(--color-text);
		box-shadow: var(--popover-shadow, var(--card-shadow, 0 12px 28px rgba(15, 23, 42, 0.16)));
		font-size: 0.72rem;
		font-weight: 650;
		line-height: 1.5;
		opacity: 0;
		pointer-events: none;
		transform: translate(-4px, -50%) scale(0.98);
		transition:
			opacity 120ms ease,
			transform 120ms ease;
	}

	.flow-editor-node__tooltip::after {
		content: '';
		position: absolute;
		top: 50%;
		right: -6px;
		width: 10px;
		height: 10px;
		border-top: 1px solid color-mix(in srgb, var(--flow-node-accent) 48%, var(--color-border));
		border-right: 1px solid color-mix(in srgb, var(--flow-node-accent) 48%, var(--color-border));
		background: var(--color-surface-elevated, var(--color-surface));
		transform: translateY(-50%) rotate(45deg);
	}

	.flow-editor-node:hover .flow-editor-node__tooltip,
	.flow-editor-node:focus-within .flow-editor-node__tooltip,
	.flow-editor-node--description-visible .flow-editor-node__tooltip {
		opacity: 1;
		transform: translate(0, -50%) scale(1);
	}

	.flow-editor-node__outputs {
		display: grid;
		grid-template-columns: repeat(var(--output-count), minmax(0, 1fr));
		gap: 4px;
		margin-top: 8px;
		padding-top: 7px;
		border-top: 1px solid color-mix(in srgb, var(--flow-node-accent) 24%, var(--color-border));
	}

	.flow-editor-node__output {
		min-height: 18px;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--color-text-muted);
		font-size: 0.62rem;
		font-weight: 800;
		text-align: center;
		white-space: nowrap;
	}

	:global(.flow-editor-node__target),
	:global(.flow-editor-node__source) {
		width: 14px;
		height: 14px;
		border: 2px solid var(--flow-node-bg, var(--color-surface));
		background: var(--flow-node-accent);
		box-shadow:
			0 0 0 1px color-mix(in srgb, var(--flow-node-accent) 72%, transparent),
			0 0 0 4px color-mix(in srgb, var(--flow-node-accent) 12%, transparent);
		transition:
			background 120ms ease,
			box-shadow 120ms ease,
			transform 120ms ease;
	}

	:global(.flow-editor-node__target.connectingto),
	:global(.flow-editor-node__source.connectingfrom) {
		box-shadow:
			0 0 0 1px var(--flow-node-accent),
			0 0 0 6px color-mix(in srgb, var(--flow-node-accent) 22%, transparent);
		transform: scale(1.05);
	}

	:global(.flow-editor-node__target) {
		top: -7px;
	}

	:global(.flow-editor-node__source-bottom) {
		bottom: -7px;
	}

	:global(.flow-editor-node__source-output) {
		bottom: -7px;
		transform: translateX(-50%);
	}
</style>
