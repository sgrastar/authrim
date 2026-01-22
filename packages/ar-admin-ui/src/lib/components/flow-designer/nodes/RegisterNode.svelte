<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';

	interface Props {
		data: {
			label?: string;
			config?: {
				require_email_verification?: boolean;
				auto_login?: boolean;
			};
			onConfigClick?: () => void;
			readonly?: boolean;
		};
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	const label = $derived(data?.label || 'Register');
	const requireVerification = $derived(data?.config?.require_email_verification ?? true);
	const autoLogin = $derived(data?.config?.auto_login ?? true);

	function handleConfigClick(event: MouseEvent) {
		event.stopPropagation();
		data?.onConfigClick?.();
	}

	function getConfigSummary(): string {
		const parts: string[] = [];
		if (requireVerification) parts.push('verify');
		if (autoLogin) parts.push('auto-login');
		return parts.length > 0 ? parts.join(', ') : 'default';
	}
</script>

<div class="register-node" class:selected>
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
		<span class="icon">📝</span>
		<span class="label">{label}</span>
	</div>
	<div class="node-body">
		<span class="config-value">{getConfigSummary()}</span>
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
	<div class="handle-wrapper handle-exists">
		<Handle type="source" position={Position.Right} id="exists" style="top: 80%;" />
		<span class="handle-label exists">Exists</span>
	</div>
</div>

<style>
	.register-node {
		position: relative;
		background: white;
		border: 1px solid #ededed;
		border-left: 3px solid #10b981;
		border-radius: 6px;
		min-width: 100px;
	}

	.register-node.selected {
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

	.register-node:hover .config-btn {
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
		top: 30%;
		transform: translateY(-50%);
	}

	.handle-wrapper.handle-failure {
		bottom: -8px;
		left: 50%;
		transform: translateX(-50%);
		flex-direction: column;
	}

	.handle-wrapper.handle-exists {
		right: -8px;
		top: 70%;
		transform: translateY(-50%);
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

	.handle-label.exists {
		background: #fef3c7;
		color: #92400e;
		margin-left: 10px;
	}
</style>
