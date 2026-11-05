<script lang="ts">
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import ChoiceCards from '#lib/ui/patterns/ChoiceCards.svelte';
	import SegmentedControl from '#lib/ui/primitives/SegmentedControl.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import ThemeGroup from './ThemeGroup.svelte';
	import { PALETTE_IDS } from './theme-palettes';
	import {
		SPLIT_CHOICES,
		type BrandAlign,
		type BrandPosition,
		type FormFrame,
		type SplitFrame,
		type SplitSide,
		type SplitWidth,
		type ThemeDraft
	} from './theme-draft';

	/** Layout: the template, the palette, and (Split) how the template is laid out. */
	let { draft = $bindable() }: { draft: ThemeDraft } = $props();

	/** The values of a choice, with their labels (`th.<group>.<value>`). */
	function choices<T extends string>(group: string, values: readonly T[]) {
		return values.map((value) => ({ value, label: t(`th.${group}.${value}` as MessageKey) }));
	}
</script>

<ThemeGroup title={t('th.g.template')} info={t('th.g.template.d')}>
	<ChoiceCards
		label={t('th.g.template')}
		hideLabel
		columns={1}
		options={[
			{ value: 'standard', label: t('th.tpl.standard'), description: t('th.tpl.standard.d') },
			{ value: 'split', label: t('th.tpl.split'), description: t('th.tpl.split.d') },
			{ value: 'minimal', label: t('th.tpl.minimal'), description: t('th.tpl.minimal.d') }
		]}
		bind:value={draft.template}
	/>
</ThemeGroup>

<ThemeGroup title={t('th.g.palette')} info={t('th.g.palette.d')}>
	<ChoiceCards
		label={t('th.g.palette')}
		hideLabel
		columns={1}
		options={PALETTE_IDS.map((id) => ({
			value: id,
			label: t(`th.palette.${id}` as MessageKey),
			description: t(`th.palette.${id}.d` as MessageKey)
		}))}
		bind:value={draft.palette}
	/>
</ThemeGroup>

{#if draft.template === 'split'}
	<ThemeGroup title={t('th.g.split')} info={t('th.g.split.d')}>
		<div class="pair">
			<Select
				label={t('th.f.splitSide')}
				options={choices<SplitSide>('splitSide', SPLIT_CHOICES.splitSide)}
				bind:value={draft.splitSide}
			/>
			<Select
				label={t('th.f.splitWidth')}
				options={choices<SplitWidth>('splitWidth', SPLIT_CHOICES.splitWidth)}
				bind:value={draft.splitWidth}
			/>
			<Select
				label={t('th.f.splitFrame')}
				options={choices<SplitFrame>('splitFrame', SPLIT_CHOICES.splitFrame)}
				bind:value={draft.splitFrame}
			/>
			<Select
				label={t('th.f.formFrame')}
				options={choices<FormFrame>('formFrame', SPLIT_CHOICES.formFrame)}
				bind:value={draft.formFrame}
			/>
			<Select
				label={t('th.f.brandPosition')}
				options={choices<BrandPosition>('brandPosition', SPLIT_CHOICES.brandPosition)}
				bind:value={draft.brandPosition}
			/>
		</div>
		<SegmentedControl
			label={t('th.f.brandAlign')}
			block
			options={choices<BrandAlign>('brandAlign', SPLIT_CHOICES.brandAlign)}
			value={draft.brandAlign}
			onchange={(value) => (draft.brandAlign = value as BrandAlign)}
		/>
	</ThemeGroup>
{/if}

<style>
	/* Short choices side by side, as many as the inspector's width allows. */
	.pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-field) var(--space-related);
	}
</style>
