<script lang="ts">
	import { t, type MessageKey } from '#lib/i18n/i18n.svelte.js';
	import ToggleRow from '#lib/ui/patterns/ToggleRow.svelte';
	import ColorField from '#lib/ui/primitives/ColorField.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import ThemeGroup from './ThemeGroup.svelte';
	import {
		FONT_STACKS,
		LOGIN_DEFAULTS,
		TOPBAR_POSITIONS,
		type ColourMode,
		type FontScale,
		type ThemeDraft,
		type ThemeFont
	} from './theme-draft';

	/**
	 * Design: colours, type, and how the screens are set: the colour mode, the form's spacing and
	 * the topbar (the colour-mode and language choices). `scheme` is the mode the screens are
	 * shown in now, so the colour fields show the colours that apply in it.
	 */
	let { draft = $bindable(), scheme }: { draft: ThemeDraft; scheme: 'light' | 'dark' } = $props();

	const fonts: readonly ThemeFont[] = ['system', 'serif', 'rounded', 'mono'];
	const modes: readonly ColourMode[] = ['auto', 'light', 'dark'];
	const fontScales: readonly FontScale[] = ['compact', 'comfortable', 'spacious'];
	const defaults = $derived(LOGIN_DEFAULTS[scheme]);
	// "Form bottom" places the choices on Split's form side, so only Split offers it (a value it
	// already has stays listed, so the field never shows blank).
	const topbars = $derived(
		TOPBAR_POSITIONS.filter(
			(value) =>
				draft.template === 'split' || !value.startsWith('form_') || value === draft.topbarPosition
		)
	);
</script>

<ThemeGroup title={t('th.g.colours')} info={t('th.g.colours.d')}>
	<div class="colours">
		<ColorField
			label={t('th.c.background')}
			alpha
			fallback={defaults.background}
			bind:value={draft.background}
		/>
		<ColorField
			label={t('th.c.card')}
			alpha
			fallback={defaults.card}
			bind:value={draft.cardColor}
		/>
		<ColorField
			label={t('th.c.accent')}
			alpha
			fallback={defaults.accent}
			bind:value={draft.accent}
		/>
		<ColorField
			label={t('th.c.title')}
			alpha
			fallback={defaults.title}
			bind:value={draft.titleColor}
		/>
		<ColorField
			label={t('th.c.text')}
			alpha
			fallback={defaults.text}
			bind:value={draft.textColor}
		/>
		<ColorField
			label={t('th.c.copy')}
			alpha
			fallback={defaults.copy}
			bind:value={draft.copyColor}
		/>
	</div>
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
