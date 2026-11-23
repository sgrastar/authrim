<script lang="ts">
	import type { LauncherChoice } from '#lib/api/account-pages.js';
	import type { Screen } from '#lib/api/screens.js';
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Callout from '#lib/ui/patterns/Callout.svelte';
	import Card from '#lib/ui/patterns/Card.svelte';
	import CheckboxRow from '#lib/ui/patterns/CheckboxRow.svelte';
	import ToggleRow from '#lib/ui/patterns/ToggleRow.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import Link from '#lib/ui/primitives/Link.svelte';
	import SegmentedControl from '#lib/ui/primitives/SegmentedControl.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import {
		CONDITIONS,
		MAX_LAUNCHERS,
		hasLauncherSlot,
		type PlaceSettings
	} from './account-page-model';

	/**
	 * The settings of the selected place, at the side of the layout: whether it is shown, when it
	 * is shown, and whether guest accounts see it. Its width is the row's: a screen in a row of
	 * two columns is half width. What a place shows is the screen's own business and is edited
	 * there (the link). With nothing selected it says so.
	 */
	interface Props {
		/** The place's id (a link on another screen points at it as `#id`); null when none is selected. */
		id: string | null;
		settings?: PlaceSettings;
		screen?: Screen;
		screenKey?: string;
		/** Where the screen is edited. */
		screenHref?: string;
		/** The tenant's launchers to choose from in a launcher slot; null when they could not be read. */
		launchers?: readonly LauncherChoice[] | null;
		disabled?: boolean;
		onremove: () => void;
	}

	let {
		id,
		settings = $bindable(),
		screen,
		screenKey = '',
		screenHref,
		launchers = null,
		disabled = false,
		onremove
	}: Props = $props();

	const slot = $derived(hasLauncherSlot(screen));
	const mode = $derived(settings?.launcher_ids ? 'selected' : 'all');
	/** The launchers to tick: the tenant's, and any chosen one that is no longer there. */
	const options = $derived.by(() => {
		const known = new Set((launchers ?? []).map((launcher) => launcher.id));
		const chosenIds = settings?.launcher_ids ?? [];
		// At the limit, only the ones already chosen can be changed (to be taken out).
		const closed = (id: string) => chosenIds.length >= MAX_LAUNCHERS && !chosenIds.includes(id);
		return [
			...(launchers ?? []).map((launcher) => ({
				value: launcher.id,
				label: launcher.enabled ? launcher.name : `${launcher.name} (${t('ap.launchers.off')})`,
				disabled: closed(launcher.id)
			})),
			...chosenIds
				.filter((chosen) => !known.has(chosen))
				.map((chosen) => ({ value: chosen, label: `${chosen} (${t('ap.launchers.gone')})` }))
		];
	});

	function chooseMode(value: string) {
		if (!settings) return;
		if (value === 'all') delete settings.launcher_ids;
		else settings.launcher_ids ??= [];
	}

	const conditions = $derived(
		CONDITIONS.map((value) => ({
			value,
			label: t(`ap.condition.${value}` as MessageKey)
		}))
	);
</script>

<Card title={t('ap.inspector.title')}>
	{#if id === null || !settings}
		<p class="none">{t('ap.inspector.none')}</p>
	{:else}
		<div class="fields">
			<p class="screen">
				<span class="screen__label">{t('ap.inspector.screen')}</span>
				<span class="screen__name">{screen?.display_name ?? screenKey}</span>
				{#if screenHref && screen}
					<Link href={screenHref}>{t('ap.inspector.editScreen')}</Link>
				{/if}
			</p>
			<ToggleRow label={t('ap.inspector.enabled')} bind:checked={settings.enabled} {disabled} />
			<Select
				label={t('ap.inspector.condition')}
				options={conditions}
				value={settings.condition}
				onchange={(value) => {
					if (settings) settings.condition = value as PlaceSettings['condition'];
				}}
				{disabled}
			/>
			<ToggleRow
				label={t('ap.inspector.guests')}
				bind:checked={settings.show_for_guests}
				{disabled}
			/>
			{#if slot}
				<div class="slot">
					<SegmentedControl
						label={t('ap.launchers.title')}
						options={[
							{ value: 'all', label: t('ap.launchers.all') },
							{ value: 'selected', label: t('ap.launchers.selected') }
						]}
						value={mode}
						onchange={chooseMode}
						{disabled}
					/>
					{#if mode === 'all'}
						<p class="note">{t('ap.launchers.allNote')}</p>
					{:else if launchers === null}
						<Callout tone="warning">{t('ap.launchers.loadFailed')}</Callout>
					{:else}
						{#if options.length === 0}
							<p class="note">{t('ap.launchers.none')}</p>
						{:else}
							<CheckboxRow
								label={t('ap.launchers.show')}
								{options}
								bind:selected={settings.launcher_ids}
								{disabled}
							/>
						{/if}
						{#if (settings.launcher_ids ?? []).length === 0}
							<Callout tone="warning">{t('ap.launchers.empty')}</Callout>
						{:else if (settings.launcher_ids ?? []).length >= MAX_LAUNCHERS}
							<p class="note">{t('ap.launchers.limit', { max: String(MAX_LAUNCHERS) })}</p>
						{/if}
					{/if}
				</div>
			{/if}
			<p class="note">{t('ap.inspector.widthHint')}</p>
			<p class="id">
				<span class="screen__label">{t('ap.inspector.placeId')}</span>
				<code>{id}</code>
				<span class="note">{t('ap.inspector.placeIdHint', { id })}</span>
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

	.slot {
		display: grid;
		gap: 8px;
	}

	.note {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}

	code {
		font-family: var(--font-mono, ui-monospace, monospace);
	}
</style>
