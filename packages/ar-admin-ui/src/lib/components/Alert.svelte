<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
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
					aria-label={$LL.common_dismiss_alert()}
				>
					<i class="i-ph-x"></i>
				</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	.alert {
		border-radius: var(--alert-radius, var(--radius-panel, var(--radius-lg)));
		padding: var(--alert-padding, 16px);
		border: 1px solid;
		box-shadow: var(--alert-shadow, none);
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
		letter-spacing: var(--alert-title-letter-spacing, 0);
	}

	.alert-text {
		color: var(--alert-text-color, var(--color-text));
		font-size: var(--alert-text-size, 0.875rem);
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
		background: color-mix(
			in srgb,
			var(--color-success) var(--alert-success-bg-mix, 12%),
			var(--color-surface)
		);
		border-color: color-mix(
			in srgb,
			var(--color-success) var(--alert-success-border-mix, 42%),
			var(--color-border)
		);
	}

	.alert-success .alert-icon,
	.alert-success .alert-dismiss {
		color: var(--color-success);
	}

	.alert-success .alert-title {
		color: var(--color-success);
	}

	.alert-success .alert-text {
		color: var(--alert-success-text-color, var(--alert-text-color, var(--color-text)));
	}

	/* Error variant */
	.alert-error {
		background: color-mix(
			in srgb,
			var(--color-danger) var(--alert-error-bg-mix, 12%),
			var(--color-surface)
		);
		border-color: color-mix(
			in srgb,
			var(--color-danger) var(--alert-error-border-mix, 42%),
			var(--color-border)
		);
	}

	.alert-error .alert-icon,
	.alert-error .alert-dismiss {
		color: var(--color-danger);
	}

	.alert-error .alert-title {
		color: var(--color-danger);
	}

	.alert-error .alert-text {
		color: var(--alert-error-text-color, var(--alert-text-color, var(--color-text)));
	}

	/* Warning variant */
	.alert-warning {
		background: color-mix(
			in srgb,
			var(--color-warning) var(--alert-warning-bg-mix, 14%),
			var(--color-surface)
		);
		border-color: color-mix(
			in srgb,
			var(--color-warning) var(--alert-warning-border-mix, 45%),
			var(--color-border)
		);
	}

	.alert-warning .alert-icon,
	.alert-warning .alert-dismiss {
		color: var(--color-warning);
	}

	.alert-warning .alert-title {
		color: var(--color-warning);
	}

	.alert-warning .alert-text {
		color: var(--alert-warning-text-color, var(--alert-text-color, var(--color-text)));
	}

	/* Info variant */
	.alert-info {
		background: var(--alert-info-bg, var(--color-accent-muted));
		border-color: color-mix(
			in srgb,
			var(--color-accent) var(--alert-info-border-mix, 38%),
			var(--color-border)
		);
	}

	.alert-info .alert-icon,
	.alert-info .alert-dismiss {
		color: var(--color-accent);
	}

	.alert-info .alert-title {
		color: var(--color-accent);
	}

	.alert-info .alert-text {
		color: var(--alert-info-text-color, var(--color-text-muted));
	}
</style>
