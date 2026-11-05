<script lang="ts">
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import ChoiceCards from '#lib/ui/patterns/ChoiceCards.svelte';
	import ToggleRow from '#lib/ui/patterns/ToggleRow.svelte';
	import ColorField from '#lib/ui/primitives/ColorField.svelte';
	import SegmentedControl from '#lib/ui/primitives/SegmentedControl.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import ThemeGroup from './ThemeGroup.svelte';
	import {
		FONT_STACKS,
		SPLIT_CHOICES,
		type BrandAlign,
		type BrandPosition,
		type SplitFrame,
		type SplitSide,
		type SplitWidth,
		type ThemeDraft,
		type ThemeFont,
		type ThemeScale
	} from './theme-draft';

	/** Design: template (and the Split template's layout), colours, type and which parts the screens show. */
	let { draft = $bindable() }: { draft: ThemeDraft } = $props();

	const fonts: readonly ThemeFont[] = ['system', 'serif', 'rounded', 'mono'];

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

{#if draft.template === 'split'}
	<ThemeGroup title={t('th.g.split')} info={t('th.g.split.d')}>
		<div class="pair">
			<Select
				label={t('th.f.splitFrame')}
				options={choices<SplitFrame>('splitFrame', SPLIT_CHOICES.splitFrame)}
				bind:value={draft.splitFrame}
			/>
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

<ThemeGroup title={t('th.g.colours')} info={t('th.g.colours.d')}>
	<ColorField label={t('th.c.background')} bind:value={draft.background} />
	<ColorField label={t('th.c.accent')} bind:value={draft.accent} />
	<ColorField label={t('th.c.title')} bind:value={draft.titleColor} />
	<ColorField label={t('th.c.text')} bind:value={draft.textColor} />
	<ColorField label={t('th.c.copy')} bind:value={draft.copyColor} />
</ThemeGroup>

<ThemeGroup title={t('th.g.type')} info={t('th.g.type.d')}>
	<Select
		label={t('th.f.font')}
		options={fonts.map((value) => ({ value, label: t(`th.font.${value}`) }))}
		bind:value={draft.font}
	/>
	<p class="specimen" style:font-family={FONT_STACKS[draft.font]}>{t('th.font.sample')}</p>
	<SegmentedControl
		label={t('th.f.scale')}
		block
		options={[
			{ value: 's', label: t('th.scale.s') },
			{ value: 'm', label: t('th.scale.m') },
			{ value: 'l', label: t('th.scale.l') }
		]}
		value={draft.scale}
		onchange={(value) => (draft.scale = value as ThemeScale)}
	/>
</ThemeGroup>

<ThemeGroup title={t('th.g.layout')} info={t('th.g.layout.d')}>
	<ToggleRow
		label={t('th.t.themeToggle')}
		info={t('th.t.themeToggle.d')}
		bind:checked={draft.themeToggle}
	/>
	<ToggleRow
		label={t('th.t.language')}
		info={t('th.t.language.d')}
		bind:checked={draft.languageSelect}
	/>
</ThemeGroup>

<style>
	/* Short choices side by side, as many as the inspector's width allows. */
	.pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-field) var(--space-related);
	}

	/* The specimen is set in the chosen typeface so the choice can be judged before it is made. */
	.specimen {
		margin: 0;
		padding: 10px 12px;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--bg-subtle);
		font-size: var(--fs-body-lg);
		color: var(--text-primary);
	}
</style>
