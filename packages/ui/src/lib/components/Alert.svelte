<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import { AlertCircle, CheckCircle, Info, AlertTriangle, X } from 'lucide-svelte';

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

	const variantConfig = {
		success: {
			containerClass: 'bg-success-50 border-success-200 dark:bg-success-900/20 dark:border-success-800',
			iconClass: 'text-success-600 dark:text-success-400',
			titleClass: 'text-success-800 dark:text-success-300',
			textClass: 'text-success-700 dark:text-success-400',
			Icon: CheckCircle
		},
		error: {
			containerClass: 'bg-error-50 border-error-200 dark:bg-error-900/20 dark:border-error-800',
			iconClass: 'text-error-600 dark:text-error-400',
			titleClass: 'text-error-800 dark:text-error-300',
			textClass: 'text-error-700 dark:text-error-400',
			Icon: AlertCircle
		},
		warning: {
			containerClass: 'bg-warning-50 border-warning-200 dark:bg-warning-900/20 dark:border-warning-800',
			iconClass: 'text-warning-600 dark:text-warning-400',
			titleClass: 'text-warning-800 dark:text-warning-300',
			textClass: 'text-warning-700 dark:text-warning-400',
			Icon: AlertTriangle
		},
		info: {
			containerClass: 'bg-info-50 border-info-200 dark:bg-info-900/20 dark:border-info-800',
			iconClass: 'text-info-600 dark:text-info-400',
			titleClass: 'text-info-800 dark:text-info-300',
			textClass: 'text-info-700 dark:text-info-400',
			Icon: Info
		}
	};

	const config = $derived(variantConfig[variant]);
	const Icon = $derived(config.Icon);

	function handleDismiss() {
		visible = false;
		onDismiss?.();
	}
</script>

{#if visible}
	<div
		class={`border rounded-lg p-4 ${config.containerClass} ${className}`}
		role="alert"
		{...restProps}
	>
		<div class="flex items-start gap-3">
			<Icon class={`h-5 w-5 mt-0.5 flex-shrink-0 ${config.iconClass}`} />

			<div class="flex-1 min-w-0">
				{#if title}
					<h3 class={`text-sm font-medium mb-1 ${config.titleClass}`}>
						{title}
					</h3>
				{/if}
				<div class={`text-sm ${config.textClass}`}>
					{@render children()}
				</div>
			</div>

			{#if dismissible}
				<button
					type="button"
					class={`flex-shrink-0 ${config.iconClass} hover:opacity-75 transition-opacity`}
					onclick={handleDismiss}
					aria-label="Dismiss alert"
				>
					<X class="h-5 w-5" />
				</button>
			{/if}
		</div>
	</div>
{/if}
