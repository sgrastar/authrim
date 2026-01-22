<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';

	interface Props extends HTMLAttributes<HTMLDivElement> {
		variant?: 'success' | 'error' | 'warning' | 'info';
		title?: string;
		dismissible?: boolean;
		onDismiss?: () => void;
		children: Snippet;
	}

	let {
		variant = 'info',
		title,
		dismissible = false,
		onDismiss,
		children,
		class: className = '',
		...restProps
	}: Props = $props();

	let visible = $state(true);

	const icons: Record<string, string> = {
		success: 'i-ph-check-circle',
		error: 'i-ph-x-circle',
		warning: 'i-ph-warning',
		info: 'i-ph-info'
	};

	function handleDismiss() {
		visible = false;
		onDismiss?.();
	}
</script>

{#if visible}
	<div class="alert alert-{variant} {className}" role="alert" {...restProps}>
		<div class="alert-content">
			<i class="alert-icon {icons[variant]}"></i>

			<div class="alert-body">
				{#if title}
					<h3 class="alert-title">{title}</h3>
				{/if}
				<div class="alert-text">
					{@render children()}
				</div>
			</div>

			{#if dismissible}
				<button
					type="button"
					class="alert-dismiss"
					onclick={handleDismiss}
					aria-label="Dismiss alert"
				>
					<i class="i-ph-x"></i>
				</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	.alert {
		border-radius: var(--radius-lg);
		padding: 16px;
		border: 1px solid;
	}

	.alert-content {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}

	.alert-icon {
		width: 20px;
		height: 20px;
		flex-shrink: 0;
		margin-top: 2px;
	}

	.alert-body {
		flex: 1;
		min-width: 0;
	}

	.alert-title {
		font-size: 0.875rem;
		font-weight: 600;
		margin: 0 0 4px 0;
	}

	.alert-text {
		font-size: 0.875rem;
	}

	.alert-dismiss {
		flex-shrink: 0;
		background: transparent;
		border: none;
		cursor: pointer;
		padding: 0;
		opacity: 0.7;
		transition: opacity var(--transition-fast);
	}

	.alert-dismiss:hover {
		opacity: 1;
	}

	.alert-dismiss :global(i) {
		width: 20px;
		height: 20px;
	}

	/* Success variant */
	.alert-success {
		background: var(--success-light);
		border-color: var(--success);
	}

	.alert-success .alert-icon,
	.alert-success .alert-dismiss {
		color: var(--success);
	}

	.alert-success .alert-title {
		color: var(--success);
	}

	.alert-success .alert-text {
		color: #065f46;
	}

	/* Error variant */
	.alert-error {
		background: var(--danger-light);
		border-color: var(--danger);
	}

	.alert-error .alert-icon,
	.alert-error .alert-dismiss {
		color: var(--danger);
	}

	.alert-error .alert-title {
		color: var(--danger);
	}

	.alert-error .alert-text {
		color: #991b1b;
	}

	/* Warning variant */
	.alert-warning {
		background: var(--warning-light);
		border-color: var(--warning);
	}

	.alert-warning .alert-icon,
	.alert-warning .alert-dismiss {
		color: var(--warning);
	}

	.alert-warning .alert-title {
		color: #92400e;
	}

	.alert-warning .alert-text {
		color: #92400e;
	}

	/* Info variant */
	.alert-info {
		background: var(--primary-light);
		border-color: var(--primary);
	}

	.alert-info .alert-icon,
	.alert-info .alert-dismiss {
		color: var(--primary);
	}

	.alert-info .alert-title {
		color: var(--primary);
	}

	.alert-info .alert-text {
		color: var(--text-secondary);
	}
</style>
