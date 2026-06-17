<script lang="ts">
	import { LL } from '$i18n/i18n-svelte';
	import { createSwitch, melt } from '@melt-ui/svelte';

	interface Props {
		checked?: boolean;
		disabled?: boolean;
		label?: string;
		description?: string;
		size?: 'sm' | 'md' | 'lg';
		id?: string;
		onchange?: (checked: boolean) => void;
	}

	let {
		checked = $bindable(false),
		disabled = false,
		label,
		description,
		size = 'md',
		id,
		onchange
	}: Props = $props();

	const {
		elements: { root, input },
		states: { checked: switchChecked },
		options: { disabled: switchDisabled }
	} = createSwitch({
		defaultChecked: checked
	});

	// Sync disabled prop with internal state (handles initial + reactive updates)
	$effect.pre(() => {
		switchDisabled.set(disabled);
	});

	// Sync external checked prop with internal state
	$effect(() => {
		switchChecked.set(checked);
	});

	// Sync internal state changes back to external prop and call onchange
	$effect(() => {
		const newValue = $switchChecked;
		if (newValue !== checked) {
			checked = newValue;
			onchange?.(newValue);
		}
	});

	const sizeClasses = {
		sm: 'toggle-switch-sm',
		md: 'toggle-switch-md',
		lg: 'toggle-switch-lg'
	};

	const ariaLabel = $derived(
		label ?? ($switchChecked ? $LL.common_toggle_on() : $LL.common_toggle_off())
	);
</script>

<div class="toggle-switch-wrapper" class:toggle-switch-disabled={disabled}>
	{#if label || description}
		<div class="toggle-switch-content">
			{#if label}
				<label for={id} class="toggle-switch-label">{label}</label>
			{/if}
			{#if description}
				<p class="toggle-switch-description">{description}</p>
			{/if}
		</div>
	{/if}
	<button
		use:melt={$root}
		{id}
		class="toggle-switch {sizeClasses[size]}"
		class:toggle-switch-checked={$switchChecked}
		{disabled}
		type="button"
		aria-label={ariaLabel}
	>
		<span class="toggle-switch-thumb"></span>
	</button>
	<input use:melt={$input} />
</div>

<style>
	.toggle-switch-wrapper {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.toggle-switch-content {
		flex: 1;
		min-width: 0;
	}

	.toggle-switch-label {
		display: block;
		font-weight: 600;
		color: var(--color-text);
		margin-bottom: 0.125rem;
		cursor: pointer;
	}

	.toggle-switch-description {
		margin: 0;
		font-size: 0.875rem;
		color: var(--color-text-muted);
		line-height: 1.4;
	}

	.toggle-switch-disabled .toggle-switch-label,
	.toggle-switch-disabled .toggle-switch-description {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Toggle Switch Base */
	.toggle-switch {
		position: relative;
		display: inline-flex;
		flex-shrink: 0;
		cursor: pointer;
		border-radius: var(--toggle-radius, 9999px);
		background-color: var(--toggle-bg, var(--color-surface-muted));
		transition:
			background-color 0.2s ease,
			box-shadow 0.2s ease;
		border: none;
		padding: 0;
	}

	.toggle-switch:focus-visible {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
	}

	.toggle-switch:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Checked state */
	.toggle-switch-checked {
		background-color: var(--toggle-checked-bg, var(--color-success));
	}

	/* Thumb */
	.toggle-switch-thumb {
		position: absolute;
		background-color: var(--toggle-thumb-bg, var(--color-surface));
		border-radius: var(--toggle-thumb-radius, 50%);
		transition: transform 0.2s ease;
		box-shadow: var(
			--toggle-thumb-shadow,
			var(--shadow-xs, 0 1px 3px color-mix(in srgb, var(--color-scrim) 12%, transparent))
		);
	}

	/* Size variants */
	.toggle-switch-sm {
		width: 36px;
		height: 20px;
	}

	.toggle-switch-sm .toggle-switch-thumb {
		width: 16px;
		height: 16px;
		top: 2px;
		left: 2px;
	}

	.toggle-switch-sm.toggle-switch-checked .toggle-switch-thumb {
		transform: translateX(16px);
	}

	.toggle-switch-md {
		width: 48px;
		height: 26px;
	}

	.toggle-switch-md .toggle-switch-thumb {
		width: 22px;
		height: 22px;
		top: 2px;
		left: 2px;
	}

	.toggle-switch-md.toggle-switch-checked .toggle-switch-thumb {
		transform: translateX(22px);
	}

	.toggle-switch-lg {
		width: 56px;
		height: 30px;
	}

	.toggle-switch-lg .toggle-switch-thumb {
		width: 26px;
		height: 26px;
		top: 2px;
		left: 2px;
	}

	.toggle-switch-lg.toggle-switch-checked .toggle-switch-thumb {
		transform: translateX(26px);
	}

	:global(.dark) .toggle-switch {
		--toggle-bg: var(--color-surface-muted);
	}
</style>
