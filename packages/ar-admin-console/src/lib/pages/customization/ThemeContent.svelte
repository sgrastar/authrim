<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ToggleRow from '#lib/ui/patterns/ToggleRow.svelte';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import ThemeGroup from './ThemeGroup.svelte';
	import { BAR_ALIGNS, TEXT_LANGUAGES, type ThemeDraft } from './theme-draft';

	/**
	 * Content: what the screens say and show of the brand: the header and footer, the language the
	 * wording is edited in, the header's logo, name and tagline, the brand panel (Split only) and the footer text. The wording is
	 * per language; an empty item uses the default wording.
	 */
	let { draft = $bindable() }: { draft: ThemeDraft } = $props();

	const logoDisplays = $derived([
		{ value: 'both', label: t('th.logo.both') },
		{ value: 'logo', label: t('th.logo.logo') },
		{ value: 'name', label: t('th.logo.name') }
	]);
	// The brand panel can also show nothing of the brand (its picture and text aside).
	const panelDisplays = $derived([...logoDisplays, { value: 'none', label: t('th.logo.none') }]);
	const aligns = $derived(BAR_ALIGNS.map((value) => ({ value, label: t(`th.align.${value}`) })));
</script>

<ThemeGroup title={t('th.g.headerFooter')} info={t('th.g.headerFooter.d')}>
	<ToggleRow label={t('th.t.header')} info={t('th.t.header.d')} bind:checked={draft.header} />
	{#if draft.header}
		<Select
			label={t('th.f.headerAlign')}
			info={t('th.f.headerAlign.d')}
			options={aligns}
			bind:value={draft.headerAlign}
		/>
	{/if}
	<ToggleRow label={t('th.t.footer')} info={t('th.t.footer.d')} bind:checked={draft.footer} />
	{#if draft.footer}
		<Select
			label={t('th.f.footerAlign')}
			info={t('th.f.footerAlign.d')}
			options={aligns}
			bind:value={draft.footerAlign}
		/>
	{/if}
</ThemeGroup>

<ThemeGroup title={t('th.g.language')} info={t('th.g.language.d')}>
	<Select
		label={t('th.f.language')}
		options={TEXT_LANGUAGES.map((language) => ({ value: language.value, label: language.label }))}
		bind:value={draft.language}
	/>
</ThemeGroup>

<ThemeGroup title={t('th.g.header')} info={t('th.g.header.d')}>
	<Select label={t('th.f.logoDisplay')} options={logoDisplays} bind:value={draft.logoDisplay} />
	<TextField label={t('th.f.headerName')} maxlength={40} counter bind:value={draft.headerName} />
	<TextField
		label={t('th.f.tagline')}
		maxlength={80}
		counter
		bind:value={draft.texts[draft.language].tagline}
	/>
</ThemeGroup>

<!-- The brand panel is the Split template's; the others have none, so nothing here would show. -->
{#if draft.template === 'split'}
	<ThemeGroup title={t('th.g.panel')} info={t('th.g.panel.d')}>
		<Select
			label={t('th.f.brandLogoDisplay')}
			options={panelDisplays}
			bind:value={draft.brandLogoDisplay}
		/>
		<TextField label={t('th.f.brandName')} maxlength={40} counter bind:value={draft.brandName} />
		<TextField label={t('th.f.panelTitle')} maxlength={60} counter bind:value={draft.panelTitle} />
		<TextArea
			label={t('th.f.panelText')}
			rows={3}
			maxlength={200}
			counter
			bind:value={draft.panelText}
		/>
	</ThemeGroup>
{/if}

<ThemeGroup title={t('th.g.footer')} info={t('th.g.footer.d')}>
	<TextArea
		label={t('th.f.footerText')}
		rows={3}
		maxlength={300}
		counter
		bind:value={draft.texts[draft.language].footer}
	/>
</ThemeGroup>
