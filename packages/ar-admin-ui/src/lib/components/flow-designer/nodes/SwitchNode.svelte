<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';

	interface SwitchCase {
		id: string;
		label: string;
		values: (string | number | boolean)[];
	}

	interface SwitchNodeConfig {
		switchKey: string;
		cases: SwitchCase[];
		defaultCase?: string;
	}

	interface Props {
		data: {
			label?: string;
			config?: SwitchNodeConfig;
			onConfigClick?: () => void;
			readonly?: boolean;
		};
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	const label = $derived(data?.label || 'Switch');
	const switchKey = $derived(data?.config?.switchKey || '');
	const cases = $derived(data?.config?.cases || []);
	const defaultCase = $derived(data?.config?.defaultCase);

	// Calculate vertical layout for three or more branches
	const casePositions = $derived.by(() => {
		const count = cases.length + (defaultCase ? 1 : 0);

		if (count === 0) {
			return [];
		}

		// Use the previous layout for two or fewer branches
		if (count <= 2) {
			const positions = [];
			cases.forEach((caseItem, index) => {
				positions.push({
					id: caseItem.id,
					label: caseItem.label,
					position: index === 0 ? Position.Right : Position.Bottom,
					style:
						index === 0
							? 'right: -6px; top: 50%; transform: translateY(-50%);'
							: 'bottom: -6px; left: 50%; transform: translateX(-50%);'
				});
			});
			if (defaultCase) {
				positions.push({
					id: defaultCase,
					label: 'Default',
					position: Position.Bottom,
					style: 'bottom: -6px; left: 50%; transform: translateX(-50%);'
				});
			}
			return positions;
		}

		// Place three or more branches vertically on the right
		const positions = [];
		const spacing = 40; // Space between handles
		const totalHeight = (count - 1) * spacing;
		const startY = -totalHeight / 2;

		cases.forEach((caseItem, index) => {
			const y = startY + index * spacing;
			positions.push({
				id: caseItem.id,
				label: caseItem.label,
				position: Position.Right,
				style: `right: -6px; top: 50%; transform: translate(0, calc(-50% + ${y}px));`
			});
		});

		if (defaultCase) {
			const y = startY + cases.length * spacing;
			positions.push({
				id: defaultCase,
				label: 'Default',
				position: Position.Right,
				style: `right: -6px; top: 50%; transform: translate(0, calc(-50% + ${y}px));`
			});
		}

		return positions;
	});

	function handleConfigClick(event: MouseEvent) {
		event.stopPropagation();
		data?.onConfigClick?.();
	}
</script>

<div class="switch-node" class:selected>
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
			<span class="icon">⎇</span>
			<span class="label">{label}</span>
			{#if switchKey}
				<span class="switch-key">{switchKey}</span>
			{/if}
			{#if cases.length > 0}
				<span class="case-count">{cases.length + (defaultCase ? 1 : 0)} cases</span>
			{/if}
		</div>
	</div>
	{#each casePositions as casePos (casePos.id)}
		<div class="handle-wrapper" style={casePos.style}>
			<Handle type="source" position={casePos.position} id={casePos.id} />
			<span class="handle-label">{casePos.label}</span>
		</div>
	{/each}
</div>

<style>
	.switch-node {
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
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-control, 4px);
		cursor: pointer;
		color: var(--color-text-muted);
		opacity: 0;
		transition: opacity 0.15s;
		z-index: 10;
	}

	.switch-node:hover .config-btn {
		opacity: 1;
	}

	.config-btn:hover {
		background: var(--color-surface-muted);
		color: var(--color-text);
	}

	.node-shape {
		position: relative;
		min-width: 100px;
		padding: 10px 16px;
		background: var(--flow-node-bg, var(--color-surface));
		border: 2px solid var(--flow-switch-color, var(--color-accent));
		border-radius: var(--radius-panel, 8px);
		color: var(--color-text);
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: var(--flow-node-shadow, var(--shadow-sm));
	}

	.switch-node.selected .node-shape {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.content {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
	}

	.icon {
		font-size: 14px;
		color: var(--flow-switch-color, var(--color-accent));
		font-weight: bold;
	}

	.label {
		font-size: 11px;
		font-weight: var(--font-weight-semibold, 600);
		color: var(--color-text);
		white-space: nowrap;
	}

	.switch-key {
		font-size: 8px;
		color: var(--flow-switch-color, var(--color-accent));
		font-family: 'Courier New', monospace;
		background: color-mix(
			in srgb,
			var(--flow-switch-color, var(--color-accent)) 10%,
			var(--color-surface)
		);
		padding: 1px 4px;
		border-radius: var(--radius-control, 4px);
	}

	.case-count {
		font-size: 8px;
		color: var(--color-text-muted);
		font-style: italic;
	}

	.handle-wrapper {
		position: absolute;
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.handle-label {
		font-size: 8px;
		font-weight: 600;
		padding: 2px 5px;
		border-radius: var(--radius-control, 4px);
		pointer-events: none;
		background: color-mix(
			in srgb,
			var(--flow-switch-color, var(--color-accent)) 14%,
			var(--color-surface)
		);
		color: var(--flow-switch-color, var(--color-accent));
		margin-left: 10px;
		white-space: nowrap;
	}
</style>
