<script lang="ts">
	import { t, tIn } from '#lib/i18n/i18n.svelte.js';
	import Select from '#lib/ui/primitives/Select.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import ThemeGroup from './ThemeGroup.svelte';
	import { TEXT_LANGUAGES, type ThemeDraft } from './theme-draft';
	import { PREVIEW_SCREENS } from './theme-sections';

	/**
	 * Text: the wording of the screens, per language. An empty item uses the default wording
	 * (shown as the field's placeholder).
	 */
	let { draft = $bindable() }: { draft: ThemeDraft } = $props();
</script>

<ThemeGroup title={t('th.g.language')} description={t('th.g.language.d')}>
	<Select
		label={t('th.f.language')}
		options={TEXT_LANGUAGES.map((language) => ({ value: language.value, label: language.label }))}
		bind:value={draft.language}
	/>
</ThemeGroup>

<ThemeGroup title={t('th.g.titles')}>
	{#each PREVIEW_SCREENS as screen (screen.value)}
		<TextField
			label={t(screen.label)}
			placeholder={tIn(draft.language, screen.label)}
			maxlength={60}
			bind:value={draft.texts[draft.language].titles[screen.value]}
		/>
	{/each}
</ThemeGroup>

<ThemeGroup title={t('th.g.copy')}>
	<TextField
		label={t('th.f.tagline')}
		maxlength={80}
		counter
		bind:value={draft.texts[draft.language].tagline}
	/>
	<TextArea
		label={t('th.f.footerText')}
		rows={3}
		maxlength={300}
		counter
		bind:value={draft.texts[draft.language].footer}
	/>
</ThemeGroup>
