<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { useBusy } from '../busy/busy';
	import Button from '../primitives/Button.svelte';
	import Select from '../primitives/Select.svelte';
	import type { ChoiceOption } from '../primitives/RadioGroup.svelte';

	/**
	 * A name chosen from what was imported (a salt, an identifier source, a store, an exception
	 * list) with the import beside it: the dropdown takes the room, the button sits at its end and
	 * lines up with the dropdown's box, not with its label.
	 */
	interface Props {
		label: string;
		options: readonly ChoiceOption[];
		value: string;
		onchange: (value: string) => void;
		importLabel: string;
		onimport: () => void;
		/** An empty choice with this text (the setting may be left unset); without it, "Choose". */
		none?: string;
		hint?: string;
		error?: string;
		loading?: boolean;
	}

	let {
		label,
		options,
		value,
		onchange,
		importLabel,
		onimport,
		none,
		hint,
		error,
		loading
	}: Props = $props();

	const busy = useBusy();
</script>

<div class="material-field">
	<div class="material">
		<div class="material__select">
			<Select
				{label}
				size="sm"
				{value}
				{options}
				placeholder={loading ? t('pid.loading') : (none ?? t('pid.choose'))}
				{onchange}
			/>
		</div>
		<Button size="sm" variant="secondary" icon="upload" disabled={busy()} onclick={onimport}
			>{importLabel}</Button
		>
	</div>
	{#if error}<p class="material__error" role="status">{error}</p>{/if}
	{#if hint}<p class="material__hint">{hint}</p>{/if}
</div>

<style>
	.material-field {
		display: grid;
		gap: 5px;
	}

	.material__hint,
	.material__error {
		margin: 0;
		font-size: var(--fs-caption);
		line-height: var(--lh-snug);
		color: var(--text-muted);
	}

	.material__error {
		color: var(--danger);
	}

	.material {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: 8px;
	}

	.material__select {
		flex: 1 1 12rem;
		min-width: 0;
	}
</style>
