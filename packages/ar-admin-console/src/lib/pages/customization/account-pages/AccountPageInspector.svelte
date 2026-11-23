<script lang="ts">
	import type { Placement, PlacementCondition } from '#lib/api/account-pages.js';
	import type { Screen } from '#lib/api/screens.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Card from '#lib/ui/patterns/Card.svelte';
	import ToggleRow from '#lib/ui/patterns/ToggleRow.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Link from '#lib/ui/primitives/Link.svelte';
	import SegmentedControl from '#lib/ui/primitives/SegmentedControl.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import { CONDITIONS } from './account-page-model';

	/**
	 * The settings of the selected place, at the side of the layout: whether it is shown, its
	 * width, when it is shown, and whether guest accounts see it. What a place shows is the
	 * screen's own business and is edited there (the link). With nothing selected it says so.
	 */
	interface Props {
		/** The selected place (changed in place). */
		placement: Placement | null;
		screen?: Screen;
		/** Where the screen is edited. */
		screenHref?: string;
		disabled?: boolean;
		onremove: () => void;
	}

	let { placement = $bindable(), screen, screenHref, disabled = false, onremove }: Props = $props();

	const conditions = $derived(
		CONDITIONS.map((value) => ({
			value,
			label: t(`ap.condition.${value}` as MessageKey)
		}))
	);
</script>

<Card title={t('ap.inspector.title')}>
	{#if !placement}
		<p class="none">{t('ap.inspector.none')}</p>
	{:else}
		<div class="fields">
			<p class="screen">
				<span class="screen__label">{t('ap.inspector.screen')}</span>
				<span class="screen__name">{screen?.display_name ?? placement.screen_key}</span>
				{#if screenHref && screen}
					<Link href={screenHref}>{t('ap.inspector.editScreen')}</Link>
				{/if}
			</p>
			<ToggleRow label={t('ap.inspector.enabled')} bind:checked={placement.enabled} {disabled} />
			<SegmentedControl
				label={t('ap.inspector.width')}
				options={[
					{ value: 'full', label: t('ap.place.full') },
					{ value: 'half', label: t('ap.place.half') }
				]}
				bind:value={placement.width}
				{disabled}
			/>
			<Select
				label={t('ap.inspector.condition')}
				options={conditions}
				value={placement.condition}
				onchange={(value) => (placement!.condition = value as PlacementCondition)}
				{disabled}
			/>
			<ToggleRow
				label={t('ap.inspector.guests')}
				bind:checked={placement.show_for_guests}
				{disabled}
			/>
			<p class="id">
				<span class="screen__label">{t('ap.inspector.placeId')}</span>
				<code>{placement.id}</code>
				<span class="hint">{t('ap.inspector.placeIdHint', { id: placement.id })}</span>
			</p>
			{#if !disabled}
				<div>
					<Button variant="danger" size="sm" icon="trash" onclick={onremove}>
						{t('ap.inspector.remove')}
					</Button>
				</div>
			{/if}
		</div>
	{/if}
</Card>

<style>
	.none {
		margin: 0;
		color: var(--text-secondary);
		font-size: var(--fs-body);
	}

	.fields {
		display: grid;
		gap: 12px;
	}

	.screen,
	.id {
		display: grid;
		gap: 2px;
		margin: 0;
		font-size: var(--fs-body);
	}

	.screen__label {
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}

	.screen__name {
		font-weight: var(--fw-semibold);
	}

	.hint {
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}

	code {
		font-family: var(--font-mono, ui-monospace, monospace);
	}
</style>
