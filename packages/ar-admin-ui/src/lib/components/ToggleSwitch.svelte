<script lang="ts">
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
		states: { checked: switchChecked }
	} = createSwitch({
		defaultChecked: checked,
		disabled
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
	>
		<span class="toggle-switch-thumb"></span>
	</button>
	<input use:melt={$input} />
</div>

<style>
	.toggle-switch-wrapper {
		display: flex;
		align-items: flex-start;
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
		color: var(--text-primary);
		margin-bottom: 0.125rem;
		cursor: pointer;
	}

	.toggle-switch-description {
		margin: 0;
		font-size: 0.875rem;
		color: var(--text-secondary);
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
		border-radius: 9999px;
		background-color: var(--toggle-bg, #d1d5db);
		transition:
			background-color 0.2s ease,
			box-shadow 0.2s ease;
		border: none;
		padding: 0;
	}

	.toggle-switch:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 2px;
	}

	.toggle-switch:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	/* Checked state */
	.toggle-switch-checked {
		background-color: var(--success, #10b981);
	}

	/* Thumb */
	.toggle-switch-thumb {
		position: absolute;
		background-color: white;
		border-radius: 50%;
		transition: transform 0.2s ease;
		box-shadow:
			0 1px 3px 0 rgba(0, 0, 0, 0.1),
			0 1px 2px -1px rgba(0, 0, 0, 0.1);
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

	/* Dark mode support */
	:global(.dark) .toggle-switch {
		--toggle-bg: #4b5563;
	}

	:global(.dark) .toggle-switch-checked {
		background-color: var(--success, #10b981);
	}
</style>
