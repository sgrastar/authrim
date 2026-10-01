<script lang="ts">
	import { useBusy } from '../busy/busy';
	/**
	 * Immediate-effect switch. Use only when flipping it takes effect at once (enable a flow,
	 * turn a feature on). Settings confirmed with a save button use Checkbox instead.
	 */
	interface Props {
		checked?: boolean;
		/** Accessible name; the visible label usually sits next to it in a SettingRow. */
		label: string;
		disabled?: boolean;
		/** `sm`: in a dense row or a small card. */
		size?: 'md' | 'sm';
		onchange?: (checked: boolean) => void;
	}

	let {
		checked = $bindable(false),
		label,
		disabled = false,
		size = 'md',
		onchange
	}: Props = $props();

	const busy = useBusy();

	function toggle() {
		checked = !checked;
		onchange?.(checked);
	}
</script>

<button
	class="switch"
	class:switch--sm={size === 'sm'}
	type="button"
	role="switch"
	aria-checked={checked}
	aria-label={label}
	disabled={disabled || busy()}
	onclick={toggle}
>
	<span class="switch__knob"></span>
</button>

<style>
	/* Knob and travel follow from the height: knob = height - 4, travel = width - height. */
	.switch {
		--switch-h: var(--control-h-xs);
		--switch-travel: 16px;
		display: inline-flex;
		flex-shrink: 0;
		width: calc(var(--switch-h) + var(--switch-travel));
		height: var(--switch-h);
		padding: 2px;
		border: 0;
		border-radius: var(--radius-round);
		background: var(--switch-off);
		transition: background 0.15s ease;
	}

	/* Smaller to look at; still 24px tall to press (WCAG 2.2 target size). */
	.switch--sm {
		--switch-h: 18px;
		--switch-travel: 12px;
		position: relative;
	}

	.switch--sm::after {
		position: absolute;
		inset: -3px;
		content: '';
	}

	.switch__knob {
		width: calc(var(--switch-h) - 4px);
		height: calc(var(--switch-h) - 4px);
		border-radius: 50%;
		background: var(--switch-knob);
		box-shadow: var(--shadow-sm);
		transition: transform 0.15s ease;
	}

	.switch[aria-checked='true'] {
		background: var(--success);
	}

	/* In RTL "off" sits at the right edge, so "on" moves left. */
	.switch[aria-checked='true'] .switch__knob {
		transform: translateX(calc(var(--switch-travel) * var(--dir)));
	}

	.switch:disabled {
		opacity: 0.45;
	}

	@media (prefers-reduced-motion: reduce) {
		.switch,
		.switch__knob {
			transition: none;
		}
	}
</style>
