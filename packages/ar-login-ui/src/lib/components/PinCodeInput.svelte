<script lang="ts">
	import { normalizePinCode, normalizePinCodeLength } from '$lib/utils/pin-code';

	type Props = {
		value?: string;
		length?: number;
		disabled?: boolean;
		name?: string;
		label?: string;
		digitLabel?: (position: number) => string;
		onValueChange?: (value: string) => void;
	};

	let {
		value = '',
		length = 6,
		disabled = false,
		name,
		label,
		digitLabel,
		onValueChange
	}: Props = $props();

	function rootStyle(count: number): string {
		return `--pin-code-length: ${count};`;
	}

	const digitCount = $derived(normalizePinCodeLength(length));
	let inputValue = $derived(normalizePinCode(value, digitCount));

	function handleInput(event: Event) {
		const target = event.currentTarget as HTMLInputElement;
		const nextValue = normalizePinCode(target.value, digitCount);

		inputValue = nextValue;
		if (target.value !== nextValue) {
			target.value = nextValue;
		}
		if (nextValue !== value) {
			onValueChange?.(nextValue);
		}
	}
</script>

<div class="pin-code-input" class:is-disabled={disabled} style={rootStyle(digitCount)}>
	<input
		type="text"
		class="pin-code-input__native"
		value={inputValue}
		{name}
		aria-label={label ?? digitLabel?.(1) ?? 'Verification code'}
		autocomplete="one-time-code"
		inputmode="numeric"
		enterkeyhint="done"
		pattern="[0-9]*"
		maxlength={digitCount}
		autocapitalize="none"
		spellcheck="false"
		{disabled}
		oninput={handleInput}
	/>
	<div class="pin-code-input__cells" aria-hidden="true">
		{#each Array.from({ length: digitCount }, (_, index) => index) as index (index)}
			<span
				class="auth-pin-cell pin-code-input__cell"
				class:is-filled={Boolean(inputValue[index])}
				class:is-active={index === Math.min(inputValue.length, digitCount - 1)}
			>
				{inputValue[index] ?? ''}
			</span>
		{/each}
	</div>
</div>

<style>
	.pin-code-input {
		position: relative;
		width: 100%;
		max-width: 21rem;
		min-width: 0;
		margin-inline: auto;
	}

	.pin-code-input__native {
		position: absolute;
		z-index: 1;
		inset: 0;
		width: 100%;
		height: 100%;
		margin: 0;
		padding: 0;
		border: 0;
		border-radius: var(--input-radius, var(--radius-md));
		background: transparent;
		color: transparent;
		-webkit-text-fill-color: transparent;
		caret-color: transparent;
		font-size: 16px;
		cursor: text;
		opacity: 0.01;
	}

	.pin-code-input__native:focus {
		outline: none;
	}

	.pin-code-input__cells {
		display: grid;
		grid-template-columns: repeat(var(--pin-code-length), minmax(0, 1fr));
		gap: clamp(0.25rem, 2vw, 0.5rem);
		width: 100%;
	}

	.pin-code-input__cell {
		display: grid;
		width: 100%;
		height: var(--auth-pin-cell-height, clamp(3rem, 14vw, 3.5rem));
		min-width: 0;
		padding: 0;
		font-size: var(--auth-pin-cell-font-size, 1.25rem);
		place-items: center;
	}

	.pin-code-input:focus-within .pin-code-input__cell.is-active {
		border-color: var(--primary);
		box-shadow: 0 0 0 3px var(--primary-light);
	}

	.pin-code-input.is-disabled .pin-code-input__cell {
		opacity: 0.5;
	}

	@media (max-width: 420px) {
		.pin-code-input__cell {
			font-size: var(--auth-pin-cell-font-size, 1.125rem);
		}
	}
</style>
