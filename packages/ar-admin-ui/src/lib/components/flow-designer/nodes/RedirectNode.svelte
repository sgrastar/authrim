<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';

	interface Props {
		data: {
			label?: string;
			config?: {
				to?: string;
				url?: string; // Legacy support
			};
			onConfigClick?: () => void;
			readonly?: boolean;
		};
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	const label = $derived(data?.label || 'Redirect');

	// Semantic destination labels
	const destinationLabels: Record<string, string> = {
		post_login: 'After Login',
		post_register: 'After Register',
		post_logout: 'After Logout',
		post_consent: 'After Consent',
		error_page: 'Error Page',
		mfa_setup: 'MFA Setup',
		password_reset: 'Password Reset',
		account_settings: 'Account Settings',
		return_url: 'Return URL'
	};

	// Get display value - support both new `to` and legacy `url`
	const destinationDisplay = $derived(() => {
		const config = data?.config;
		if (config?.to) {
			return destinationLabels[config.to] || config.to;
		}
		// Legacy: show URL if no semantic destination
		if (config?.url) {
			return `url: ${config.url}`;
		}
		return 'Not configured';
	});

	function handleConfigClick(event: MouseEvent) {
		event.stopPropagation();
		data?.onConfigClick?.();
	}
</script>

<div class="redirect-node" class:selected>
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
		<span class="icon">↗️</span>
		<span class="label">{label}</span>
	</div>
	<div class="node-body">
		<span class="destination">{destinationDisplay()}</span>
	</div>
	<Handle type="target" position={Position.Left} />
	<Handle type="source" position={Position.Right} id="success" />
</div>

<style>
	.redirect-node {
		position: relative;
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--flow-node-color-side-effect);
		border-radius: var(--flow-node-radius, var(--radius-control, 6px));
		min-width: 100px;
	}

	.redirect-node.selected {
		outline: 2px solid var(--color-accent);
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
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-radius: var(--flow-node-control-radius, var(--radius-xs, 3px));
		cursor: pointer;
		color: var(--color-text-subtle);
		opacity: 0;
		transition: opacity 0.15s;
		z-index: 10;
	}

	.redirect-node:hover .config-btn {
		opacity: 1;
	}

	.config-btn:hover {
		background: var(--color-surface-muted);
		color: var(--color-text);
	}

	.node-header {
		display: flex;
		align-items: center;
		gap: 5px;
		padding: 5px 8px;
		font-weight: 500;
		font-size: 10px;
		color: var(--color-text);
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
		font-size: 9px;
		border-top: 1px solid var(--color-border);
	}

	.destination {
		color: var(--flow-node-redirect-color, var(--flow-node-color-side-effect));
		font-weight: 500;
	}
</style>
