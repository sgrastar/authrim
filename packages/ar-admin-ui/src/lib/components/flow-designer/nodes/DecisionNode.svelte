<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';

	interface DecisionBranch {
		id: string;
		label: string;
		condition: unknown;
		priority: number;
	}

	interface DecisionNodeConfig {
		branches: DecisionBranch[];
		defaultBranch?: string;
	}

	interface Props {
		data: {
			label?: string;
			config?: DecisionNodeConfig;
			onConfigClick?: () => void;
			readonly?: boolean;
		};
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	const label = $derived(data?.label || 'Decision');
	const branches = $derived(data?.config?.branches || []);
	const defaultBranch = $derived(data?.config?.defaultBranch);

	// 3分岐以上の場合の垂直配置の計算
	const branchPositions = $derived.by(() => {
		const count = branches.length + (defaultBranch ? 1 : 0);

		if (count === 0) {
			return [];
		}

		// 2分岐以下は従来通り
		if (count <= 2) {
			const positions = [];
			branches.forEach((branch, index) => {
				positions.push({
					id: branch.id,
					label: branch.label,
					position: index === 0 ? Position.Right : Position.Bottom,
					style:
						index === 0
							? 'right: -6px; top: 50%; transform: translateY(-50%);'
							: 'bottom: -6px; left: 50%; transform: translateX(-50%);'
				});
			});
			if (defaultBranch) {
				positions.push({
					id: defaultBranch,
					label: 'Default',
					position: Position.Bottom,
					style: 'bottom: -6px; left: 50%; transform: translateX(-50%);'
				});
			}
			return positions;
		}

		// 3分岐以上は右側に垂直配置
		const positions = [];
		const spacing = 40; // 各ハンドル間のスペース
		const totalHeight = (count - 1) * spacing;
		const startY = -totalHeight / 2;

		branches.forEach((branch, index) => {
			const y = startY + index * spacing;
			positions.push({
				id: branch.id,
				label: branch.label,
				position: Position.Right,
				style: `right: -6px; top: 50%; transform: translate(0, calc(-50% + ${y}px));`
			});
		});

		if (defaultBranch) {
			const y = startY + branches.length * spacing;
			positions.push({
				id: defaultBranch,
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

<div class="decision-node" class:selected>
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
			<span class="icon">◇</span>
			<span class="label">{label}</span>
			{#if branches.length > 0}
				<span class="branch-count">{branches.length + (defaultBranch ? 1 : 0)} branches</span>
			{/if}
		</div>
	</div>
	{#each branchPositions as branchPos (branchPos.id)}
		<div class="handle-wrapper" style={branchPos.style}>
			<Handle type="source" position={branchPos.position} id={branchPos.id} />
			<span class="handle-label">{branchPos.label}</span>
		</div>
	{/each}
</div>

<style>
	.decision-node {
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

	.decision-node:hover .config-btn {
		opacity: 1;
	}

	.config-btn:hover {
		background: #f3f4f6;
		color: #374151;
	}

	.node-shape {
		position: relative;
		min-width: 100px;
		padding: 10px 16px;
		background: white;
		border: 2px solid #8b5cf6;
		border-radius: 8px;
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: 0 2px 4px rgba(139, 92, 246, 0.1);
	}

	.decision-node.selected .node-shape {
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
		font-size: 14px;
		color: #8b5cf6;
		font-weight: bold;
	}

	.label {
		font-size: 11px;
		font-weight: 600;
		color: #374151;
		white-space: nowrap;
	}

	.branch-count {
		font-size: 8px;
		color: #9ca3af;
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
		border-radius: 3px;
		pointer-events: none;
		background: #ede9fe;
		color: #5b21b6;
		margin-left: 10px;
		white-space: nowrap;
	}
</style>
