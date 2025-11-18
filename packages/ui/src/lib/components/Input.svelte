<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLInputAttributes } from 'svelte/elements';

	interface Props extends Omit<HTMLInputAttributes, 'value'> {
		label?: string;
		error?: string;
		helperText?: string;
		icon?: Snippet;
		value?: string | number | null;
	}

	let {
		label,
		error,
		helperText,
		icon,
		type = 'text',
		id,
		value = $bindable('' as string | number | null),
		class: className = '',
		...restProps
	}: Props = $props();

	const inputId = $derived(id || `input-${Math.random().toString(36).substring(2, 9)}`);
	const hasError = $derived(!!error);
	const inputClasses = $derived(hasError ? 'input-error' : 'input-base');
</script>

<div class={`w-full ${className}`}>
	{#if label}
		<label for={inputId} class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
			{label}
		</label>
	{/if}

	<div class="relative">
		{#if icon}
			<div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
				{@render icon()}
			</div>
		{/if}

		<input
			id={inputId}
			{type}
			bind:value
			class={`${inputClasses} ${icon ? 'pl-10' : ''}`}
			aria-invalid={hasError}
			aria-describedby={error ? `${inputId}-error` : helperText ? `${inputId}-helper` : undefined}
			{...restProps}
		/>
	</div>

	{#if error}
		<p id={`${inputId}-error`} class="mt-1.5 text-sm text-error-600 dark:text-error-400">
			{error}
		</p>
	{:else if helperText}
		<p id={`${inputId}-helper`} class="mt-1.5 text-sm text-gray-500 dark:text-gray-400">
			{helperText}
		</p>
	{/if}
</div>
