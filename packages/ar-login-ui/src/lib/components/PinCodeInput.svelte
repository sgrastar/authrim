<script lang="ts">
	import { createPinInput, melt } from '@melt-ui/svelte';

	type Props = {
		value?: string;
		length?: number;
		disabled?: boolean;
		name?: string;
		digitLabel?: (position: number) => string;
		onValueChange?: (value: string) => void;
	};

	let {
		value = '',
		length = 6,
		disabled = false,
		name,
		digitLabel,
		onValueChange
	}: Props = $props();

	function normalizeLength(raw: number): number {
		if (!Number.isFinite(raw)) return 6;
		return Math.max(1, Math.min(12, Math.trunc(raw)));
	}

	function codeDigits(raw: string, count: number): string[] {
		return raw.replace(/\D/g, '').slice(0, count).split('');
	}

	function inputLabel(position: number): string {
		return digitLabel?.(position) ?? `Digit ${position}`;
	}

	function rootStyle(count: number): string {
		return `--pin-code-cell-size: ${count > 6 ? '2.25rem' : '3rem'};`;
	}

	const digitCount = $derived(normalizeLength(length));

	const {
		elements: { root, input, hiddenInput },
		states: { value: pinValue },
		options: { disabled: pinDisabled, name: pinName }
	} = createPinInput({
		placeholder: '0',
		type: 'text',
		defaultValue: [],
		onValueChange: ({ next }) => {
			const nextDigits = codeDigits(next.join(''), digitCount);
			const nextCode = nextDigits.join('');
			if (nextCode !== value) {
				onValueChange?.(nextCode);
			}
			return nextDigits;
		}
	});

	$effect(() => {
		pinDisabled.set(disabled);
	});

	$effect(() => {
		pinName.set(name);
	});

	$effect(() => {
		const next = codeDigits(value, digitCount);
		if (pinValue.get().join('') !== next.join('')) {
			pinValue.set(next);
		}
	});
</script>

<div class="pin-code-input" style={rootStyle(digitCount)} use:melt={$root}>
	{#each Array.from({ length: digitCount }, (_, index) => index) as index (index)}
		<input
			use:melt={$input()}
			aria-label={inputLabel(index + 1)}
			autocomplete="one-time-code"
			inputmode="numeric"
			pattern="[0-9]*"
			class="auth-pin-cell pin-code-input__cell"
			maxlength="1"
			{disabled}
		/>
	{/each}
</div>
<input use:melt={$hiddenInput} />

<style>
	.pin-code-input {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		width: 100%;
	}

	.pin-code-input__cell {
		flex: 0 0 clamp(2rem, 10vw, var(--pin-code-cell-size));
		width: clamp(2rem, 10vw, var(--pin-code-cell-size));
		min-width: 0;
		padding: 0;
	}

	@media (max-width: 420px) {
		.pin-code-input {
			gap: 0.375rem;
		}

		.pin-code-input__cell {
			height: 3.25rem;
		}
	}
</style>
