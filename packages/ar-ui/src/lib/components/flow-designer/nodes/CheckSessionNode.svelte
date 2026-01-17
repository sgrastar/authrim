<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';

	interface Props {
		data: {
			label?: string;
			config?: {
				fact?: string;
				// Legacy support
				key?: string;
				operator?: string;
				value?: unknown;
			};
			onConfigClick?: () => void;
			readonly?: boolean;
		};
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	const label = $derived(data?.label || 'Check Session');

	// Semantic fact labels
	const factLabels: Record<string, string> = {
		'session.authenticated': 'Is Logged In?',
		'session.mfa_verified': 'MFA Verified?',
		'session.fresh': 'Session Fresh?',
		'user.email_verified': 'Email Verified?',
		'user.phone_verified': 'Phone Verified?',
		'user.mfa_enabled': 'MFA Enabled?',
		'user.has_password': 'Has Password?',
		'user.has_passkey': 'Has Passkey?',
		'user.first_login': 'First Login?',
		'consent.terms_accepted': 'Terms Accepted?',
		'consent.privacy_accepted': 'Privacy Accepted?',
		'context.new_device': 'New Device?',
		'context.high_risk': 'High Risk?'
	};

	// Get display value - support both new `fact` and legacy `key/operator/value`
	const conditionDisplay = $derived(() => {
		const config = data?.config;
		if (config?.fact) {
			return factLabels[config.fact] || config.fact;
		}
		// Legacy: show key/operator/value
		if (config?.key) {
			const op = config.operator || 'isTrue';
			if (op === 'isTrue' || op === 'isFalse') {
				return `${config.key} ${op} ?`;
			}
			return `${config.key} ${op} ${config.value ?? '?'}`;
		}
		return 'Not configured';
	});

	function handleConfigClick(event: MouseEvent) {
		event.stopPropagation();
		data?.onConfigClick?.();
	}
</script>

<div class="check-session-node" class:selected>
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
		<span class="icon">🔍</span>
		<span class="label">{label}</span>
	</div>
	<div class="node-body">
		<span class="condition">{conditionDisplay()}</span>
	</div>
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
	.check-session-node {
		position: relative;
		background: white;
		border: 1px solid #ededed;
		border-left: 3px solid #a855f7;
		border-radius: 6px;
		min-width: 120px;
	}

	.check-session-node.selected {
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

	.check-session-node:hover .config-btn {
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
		color: #a855f7;
		font-weight: 500;
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
