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
</script>

<div class="form-group {className}">
	{#if label}
		<label for={inputId} class="form-label">
			{label}
		</label>
	{/if}

	<div class="input-wrapper">
		{#if icon}
			<div class="input-icon">
				{@render icon()}
			</div>
		{/if}

		<input
			id={inputId}
			{type}
			bind:value
			class="form-input"
			class:has-icon={!!icon}
			class:has-error={hasError}
			aria-invalid={hasError}
			aria-describedby={error ? `${inputId}-error` : helperText ? `${inputId}-helper` : undefined}
			{...restProps}
		/>
	</div>

	{#if error}
		<p id={`${inputId}-error`} class="form-error">
			{error}
		</p>
	{:else if helperText}
		<p id={`${inputId}-helper`} class="form-hint">
			{helperText}
		</p>
	{/if}
</div>

<style>
	.form-group {
		width: 100%;
		margin-bottom: 20px;
	}

	.form-label {
		display: block;
		font-family: var(--font-display);
		font-size: 0.9375rem;
		font-weight: 600;
		color: var(--text-primary);
		margin-bottom: 8px;
	}

	.input-wrapper {
		position: relative;
	}

	.input-icon {
		position: absolute;
		left: 16px;
		top: 50%;
		transform: translateY(-50%);
		width: 20px;
		height: 20px;
		color: var(--text-muted);
		pointer-events: none;
	}

	.input-icon :global(i),
	.input-icon :global(svg) {
		width: 20px;
		height: 20px;
	}

	.form-input {
		width: 100%;
		padding: 12px 16px;
		background: var(--bg-glass);
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		font-size: 0.9375rem;
		font-family: var(--font-body);
		color: var(--text-primary);
		transition: all var(--transition-fast);
		backdrop-filter: var(--blur-sm);
		-webkit-backdrop-filter: var(--blur-sm);
	}

	.form-input.has-icon {
		padding-left: 48px;
	}

	.form-input::placeholder {
		color: var(--text-muted);
	}

	.form-input:focus {
		outline: none;
		border-color: var(--primary);
		box-shadow: 0 0 0 4px var(--primary-light);
	}

	.form-input:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.form-input.has-error {
		border-color: var(--danger);
	}

	.form-input.has-error:focus {
		box-shadow: 0 0 0 4px var(--danger-light);
	}

	.form-hint {
		font-size: 0.8125rem;
		color: var(--text-muted);
		margin-top: 6px;
	}

	.form-error {
		font-size: 0.8125rem;
		color: var(--danger);
		margin-top: 6px;
	}
</style>
