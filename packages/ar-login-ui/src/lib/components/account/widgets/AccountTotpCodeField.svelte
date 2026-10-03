<script lang="ts">
	/** A labelled one-time-code input with its actions beside it (stacked on narrow screens). */
	import type { Snippet } from 'svelte';

	let {
		label,
		hideLabel = false,
		value = $bindable(''),
		placeholder,
		maxlength = 8,
		inputmode = 'numeric',
		compact = false,
		actions
	}: {
		label: string;
		/** Keep the label for assistive technology only (rows that repeat the same field). */
		hideLabel?: boolean;
		value?: string;
		placeholder?: string;
		maxlength?: number;
		inputmode?: 'numeric' | 'text';
		/** A narrow field beside a list row instead of a full-width line. */
		compact?: boolean;
		actions: Snippet;
	} = $props();

	const inputId = $props.id();
</script>

<div class="code-field" class:compact>
	<label for={inputId} class:sr-only={hideLabel}>{label}</label>
	<div class="code-row">
		<input
			id={inputId}
			class="code-input"
			autocomplete="one-time-code"
			{inputmode}
			{maxlength}
			{placeholder}
			bind:value
		/>
		{@render actions()}
	</div>
</div>

<style>
	.code-field {
		display: grid;
		gap: 6px;
	}

	label {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.code-row {
		display: grid;
		gap: 8px;
	}

	.code-input {
		width: 100%;
		min-height: 38px;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
		letter-spacing: 0.08em;
		padding: 0 10px;
	}

	.code-input::placeholder {
		color: var(--text-muted);
		letter-spacing: normal;
	}

	.code-input:focus {
		outline: none;
		border-color: var(--primary);
	}

	@media (min-width: 640px) {
		.code-row {
			grid-template-columns: minmax(0, 1fr) auto auto;
			align-items: center;
		}

		.compact {
			width: min(240px, 40vw);
		}

		.compact .code-row {
			grid-template-columns: minmax(0, 1fr) auto;
		}
	}
</style>
