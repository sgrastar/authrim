<script lang="ts">
	import { useBusy } from '#lib/ui/busy/busy.js';
	import { useChangeMark } from '#lib/ui/save/save-scope.js';
	import LauncherIcon from './LauncherIcon.svelte';

	/**
	 * Choosing a launcher's Phosphor icon: every allowed icon in the tile's own colours, as one
	 * group of radio buttons (arrow keys move through them, as with any radio group). Each is
	 * named by its Phosphor name. Inside a SaveScope (`field`) the chosen icon takes the change
	 * ring while it differs from the saved one.
	 */
	interface Props {
		label: string;
		/** The Phosphor names to offer, in order. */
		icons: readonly string[];
		value?: string;
		background: string;
		color: string;
		disabled?: boolean;
		field?: string;
	}

	let {
		label,
		icons,
		value = $bindable(''),
		background,
		color,
		disabled = false,
		field
	}: Props = $props();

	const uid = $props.id();
	const busy = useBusy();
	const changes = useChangeMark();
	const changed = $derived(changes.changed(field, value));
	const off = $derived(disabled || busy());
</script>

<fieldset class="icon-picker" disabled={off}>
	<legend class="sr-only">{label}</legend>
	<div class="icon-picker__grid">
		{#each icons as icon (icon)}
			<label
				class="icon-picker__option"
				class:icon-picker__option--chosen={value === icon}
				class:icon-picker__option--changed={value === icon && changed}
				title={icon}
			>
				<input class="sr-only" type="radio" name="{uid}-icon" value={icon} bind:group={value} />
				<LauncherIcon iconType="phosphor" value={icon} {background} {color} size="sm" />
				<span class="sr-only">{icon}</span>
			</label>
		{/each}
	</div>
</fieldset>

<style>
	.icon-picker {
		min-inline-size: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.icon-picker__grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
		gap: 6px;
	}

	.icon-picker__option {
		display: grid;
		place-items: center;
		block-size: 44px;
		border: 1px solid transparent;
		border-radius: var(--radius-control);
		cursor: pointer;
	}

	.icon-picker__option:hover {
		background: var(--bg-hover);
	}

	.icon-picker__option--chosen {
		border-color: var(--primary);
		background: var(--bg-subtle);
	}

	.icon-picker__option--changed {
		box-shadow: 0 0 0 2px var(--changed-ring);
	}

	.icon-picker__option:has(input:focus-visible) {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.icon-picker:disabled .icon-picker__option {
		cursor: default;
		opacity: 0.6;
	}

	.icon-picker:disabled .icon-picker__option:hover {
		background: transparent;
	}
</style>
