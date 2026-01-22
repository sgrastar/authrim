<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';

	interface Props {
		data: {
			label?: string;
			config?: {
				reason?: string;
				allow_retry?: boolean;
			};
			onConfigClick?: () => void;
			readonly?: boolean;
		};
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	const label = $derived(data?.label || 'Error');

	// Error reason labels
	const reasonLabels: Record<string, string> = {
		login_failed: 'Login Failed',
		account_locked: 'Account Locked',
		account_disabled: 'Account Disabled',
		session_expired: 'Session Expired',
		invalid_credentials: 'Invalid Credentials',
		mfa_failed: 'MFA Failed',
		rate_limited: 'Rate Limited',
		consent_declined: 'Consent Declined',
		registration_failed: 'Registration Failed',
		unknown_error: 'Unknown Error'
	};

	const reasonDisplay = $derived(() => {
		const reason = data?.config?.reason;
		if (reason) {
			return reasonLabels[reason] || reason;
		}
		return null;
	});

	const allowRetry = $derived(data?.config?.allow_retry ?? false);

	function handleConfigClick(event: MouseEvent) {
		event.stopPropagation();
		data?.onConfigClick?.();
	}
</script>

<div class="error-node" class:selected class:has-retry={allowRetry}>
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
	<div class="node-content">
		<span class="icon">✕</span>
		<span class="label">{label}</span>
	</div>
	{#if reasonDisplay()}
		<div class="reason-badge">
			{reasonDisplay()}
		</div>
	{/if}
	{#if allowRetry}
		<div class="handle-wrapper handle-retry">
			<Handle type="source" position={Position.Right} id="retry" />
			<span class="handle-label retry">↻</span>
		</div>
	{/if}
</div>

<style>
	.error-node {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 5px 10px;
		background: #ef4444;
		color: white;
		border-radius: 16px;
		font-weight: 500;
		font-size: 10px;
		border: none;
		min-width: 70px;
	}

	.error-node.has-retry {
		border-radius: 12px;
		padding-right: 20px;
	}

	.error-node.selected {
		outline: 2px solid #ff4000;
		outline-offset: 2px;
	}

	.config-btn {
		position: absolute;
		top: -6px;
		right: -6px;
		width: 18px;
		height: 18px;
		display: flex;
		align-items: center;
		justify-content: center;
		background: white;
		border: 1px solid #e5e7eb;
		border-radius: 50%;
		cursor: pointer;
		color: #ef4444;
		opacity: 0;
		transition: opacity 0.15s;
		z-index: 10;
	}

	.error-node:hover .config-btn {
		opacity: 1;
	}

	.config-btn:hover {
		background: #fef2f2;
	}

	.node-content {
		display: flex;
		align-items: center;
		gap: 5px;
	}

	.icon {
		font-size: 9px;
	}

	.label {
		white-space: nowrap;
	}

	.reason-badge {
		margin-top: 4px;
		padding: 2px 8px;
		background: rgba(255, 255, 255, 0.2);
		border-radius: 10px;
		font-size: 9px;
		font-weight: 400;
	}

	.handle-wrapper {
		position: absolute;
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.handle-wrapper.handle-retry {
		right: -8px;
		top: 50%;
		transform: translateY(-50%);
	}

	.handle-label {
		font-size: 10px;
		font-weight: 600;
		padding: 2px 4px;
		border-radius: 4px;
		pointer-events: none;
	}

	.handle-label.retry {
		background: white;
		color: #ef4444;
		margin-left: 10px;
	}
</style>
