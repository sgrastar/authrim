<script lang="ts">
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import Tabs from '#lib/ui/patterns/Tabs.svelte';
	import ToggleRow from '#lib/ui/patterns/ToggleRow.svelte';
	import Button from '#lib/ui/primitives/Button.svelte';
	import ColorField from '#lib/ui/primitives/ColorField.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import ThemeGroup from './ThemeGroup.svelte';
	import { draftColour, setDraftColour, THEME_COLOURS } from './theme-colours';
	import {
		FONT_STACKS,
		TOPBAR_POSITIONS,
		type ColourMode,
		type FontScale,
		type ThemeDraft,
		type ThemeFont
	} from './theme-draft';
	import { paletteColours } from './theme-palettes';

	/**
	 * Design: colours, type, and how the screens are set: the colour mode, the form's spacing and
	 * the topbar (the colour-mode and language choices). `scheme` is the mode the screens are
	 * shown in now; `mode` is the one the preview simulates while the theme follows the device.
	 */
	let {
		draft = $bindable(),
		scheme,
		mode = $bindable('light')
	}: { draft: ThemeDraft; scheme: 'light' | 'dark'; mode?: 'light' | 'dark' } = $props();

	const fonts: readonly ThemeFont[] = ['system', 'serif', 'rounded', 'mono'];
	const modes: readonly ColourMode[] = ['auto', 'light', 'dark'];
	const fontScales: readonly FontScale[] = ['compact', 'comfortable', 'spacious'];

	/**
	 * The colours are set per mode: a tab for each. The tab follows the mode the preview shows, and
	 * choosing one shows the preview in that mode (while the theme follows the device; a fixed mode
	 * keeps the preview as it is, and its other colours can still be set).
	 */
	let colourTab = $derived<'light' | 'dark'>(scheme);
	const colourTabs = $derived([
		{ id: 'light', label: t('th.mode.light') },
		{ id: 'dark', label: t('th.mode.dark') }
	]);
	function pickColourTab(id: string) {
		colourTab = id === 'dark' ? 'dark' : 'light';
		if (draft.mode === 'auto') mode = colourTab;
	}

	// An empty colour is the palette's own (the field shows it), so going back to the palette's
	// colours is emptying them. Nothing changes until the theme is saved.
	const customised = (tab: 'light' | 'dark') =>
		THEME_COLOURS.some((colour) => draftColour(draft, colour, tab) !== '');
	function resetColours(tab: 'light' | 'dark') {
		for (const colour of THEME_COLOURS) setDraftColour(draft, colour, tab, '');
	}
	// "Form bottom" places the choices on Split's form side, so only Split offers it; the header
	// and footer places need that bar. A value it already has stays listed, so the field never
	// shows blank.
	const topbars = $derived(
		TOPBAR_POSITIONS.filter(
			(value) =>
				value === draft.topbarPosition ||
				((draft.template === 'split' || !value.startsWith('form_')) &&
					(draft.header || !value.startsWith('header_')) &&
					(draft.footer || !value.startsWith('footer_')))
		)
	);
</script>

<ThemeGroup title={t('th.g.colours')} info={t('th.g.colours.d')}>
	{#snippet actions()}
		<Button
			variant="ghost"
			size="sm"
			icon="reset"
			disabled={!customised(colourTab)}
			onclick={() => resetColours(colourTab)}>{t('th.c.reset')}</Button
		>
	{/snippet}
	<Tabs label={t('th.c.modes')} items={colourTabs} value={colourTab} onchange={pickColourTab}>
		{#snippet panel(id)}
			{@const tab = id === 'dark' ? 'dark' : 'light'}
			{@const defaults = paletteColours(draft.palette, tab)}
			<div class="colours">
				{#each THEME_COLOURS as colour (colour.field)}
					<ColorField
						label={t(colour.label as MessageKey)}
						alpha={colour.alpha}
						fallback={colour.fallback(defaults)}
						bind:value={
							() => draftColour(draft, colour, tab),
							(value) => setDraftColour(draft, colour, tab, value)
						}
					/>
				{/each}
			</div>
		{/snippet}
	</Tabs>
</ThemeGroup>

<ThemeGroup title={t('th.g.type')} info={t('th.g.type.d')}>
	<Select
		label={t('th.f.font')}
		options={fonts.map((value) => ({ value, label: t(`th.font.${value}`) }))}
		bind:value={draft.font}
	/>
	<p class="specimen" style:font-family={FONT_STACKS[draft.font]}>{t('th.font.sample')}</p>
</ThemeGroup>

<ThemeGroup title={t('th.g.layout')} info={t('th.g.layout.d')}>
	<Select
		label={t('th.f.mode')}
		info={t('th.f.mode.d')}
		options={modes.map((value) => ({ value, label: t(`th.mode.${value}`) }))}
		bind:value={draft.mode}
	/>
	<Select
		label={t('th.f.fontScale')}
		info={t('th.f.fontScale.d')}
		options={fontScales.map((value) => ({ value, label: t(`th.fontScale.${value}`) }))}
		bind:value={draft.fontScale}
	/>
	<Select
		label={t('th.f.topbar')}
		info={t('th.f.topbar.d')}
		options={topbars.map((value) => ({ value, label: t(`th.topbar.${value}` as MessageKey) }))}
		bind:value={draft.topbarPosition}
	/>
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
	/* Many colours in a narrow column: a small swatch and tight rows. */
	.colours {
		display: grid;
		gap: 8px;
		--color-swatch: var(--control-h-xs);
		--color-box-h: var(--control-h-sm);
		--color-gap: 3px;
		--color-hex-w: 84px;
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
