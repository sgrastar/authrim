<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import SegmentedControl from '#lib/ui/primitives/SegmentedControl.svelte';
	import TextArea from '#lib/ui/primitives/TextArea.svelte';
	import TextField from '#lib/ui/primitives/TextField.svelte';
	import ThemeGroup from './ThemeGroup.svelte';
	import type { LogoDisplay, ThemeDraft } from './theme-draft';

	/** Brand: the name, how the logo is shown, and the brand panel of the Split template. */
	let { draft = $bindable() }: { draft: ThemeDraft } = $props();
</script>

<ThemeGroup title={t('th.g.brand')} description={t('th.g.brand.d')}>
	<TextField label={t('th.f.brandName')} maxlength={40} counter bind:value={draft.brandName} />
	<SegmentedControl
		label={t('th.f.logoDisplay')}
		block
		options={[
			{ value: 'both', label: t('th.logo.both') },
			{ value: 'logo', label: t('th.logo.logo') },
			{ value: 'name', label: t('th.logo.name') }
		]}
		value={draft.logoDisplay}
		onchange={(value) => (draft.logoDisplay = value as LogoDisplay)}
	/>
</ThemeGroup>

<ThemeGroup title={t('th.g.panel')} description={t('th.g.panel.d')}>
	<TextField label={t('th.f.panelTitle')} maxlength={60} counter bind:value={draft.panelTitle} />
	<TextArea
		label={t('th.f.panelText')}
		rows={3}
		maxlength={200}
		counter
		bind:value={draft.panelText}
	/>
</ThemeGroup>
