<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ChoiceCards from '#lib/ui/patterns/ChoiceCards.svelte';
	import ToggleRow from '#lib/ui/patterns/ToggleRow.svelte';
	import ColorField from '#lib/ui/primitives/ColorField.svelte';
	import SegmentedControl from '#lib/ui/primitives/SegmentedControl.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import ThemeGroup from './ThemeGroup.svelte';
	import { FONT_STACKS, type ThemeDraft, type ThemeFont, type ThemeScale } from './theme-draft';

	/** Design: template, colours, type and which parts the screens show. */
	let { draft = $bindable() }: { draft: ThemeDraft } = $props();

	const fonts: readonly ThemeFont[] = ['system', 'serif', 'rounded', 'mono'];
</script>

<ThemeGroup title={t('th.g.template')} description={t('th.g.template.d')}>
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

<ThemeGroup title={t('th.g.colours')} description={t('th.g.colours.d')}>
	<ColorField label={t('th.c.background')} bind:value={draft.background} />
	<ColorField label={t('th.c.accent')} bind:value={draft.accent} />
	<ColorField label={t('th.c.title')} bind:value={draft.titleColor} />
	<ColorField label={t('th.c.text')} bind:value={draft.textColor} />
</ThemeGroup>

<ThemeGroup title={t('th.g.type')} description={t('th.g.type.d')}>
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

<ThemeGroup title={t('th.g.layout')} description={t('th.g.layout.d')}>
	<ToggleRow
		label={t('th.t.header')}
		description={t('th.t.header.d')}
		bind:checked={draft.header}
	/>
	<ToggleRow
		label={t('th.t.footer')}
		description={t('th.t.footer.d')}
		bind:checked={draft.footer}
	/>
	<ToggleRow
		label={t('th.t.themeToggle')}
		description={t('th.t.themeToggle.d')}
		bind:checked={draft.themeToggle}
	/>
	<ToggleRow
		label={t('th.t.language')}
		description={t('th.t.language.d')}
		bind:checked={draft.languageSelect}
	/>
</ThemeGroup>

<style>
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
