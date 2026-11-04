<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import ImageUpload from '#lib/ui/patterns/ImageUpload.svelte';
	import Slider from '#lib/ui/primitives/Slider.svelte';
	import ThemeGroup from './ThemeGroup.svelte';
	import type { ThemeDraft } from './theme-draft';

	/** Images: the logo, the favicon, the background and (Split) the brand panel's own picture. */
	let { draft = $bindable() }: { draft: ThemeDraft } = $props();

	// The brand panel exists only in the Split template; its picture waits until Split is chosen.
	const split = $derived(draft.template === 'split');
</script>

<ThemeGroup title={t('th.g.logo')} description={t('th.g.logo.d')}>
	<ImageUpload
		label={t('th.i.logo')}
		shape="square"
		maxBytes={512 * 1024}
		bind:value={draft.logo}
	/>
</ThemeGroup>

<ThemeGroup title={t('th.g.favicon')} description={t('th.g.favicon.d')}>
	<ImageUpload
		label={t('th.i.favicon')}
		shape="square"
		accept="image/png,image/svg+xml,.ico"
		maxBytes={128 * 1024}
		bind:value={draft.favicon}
	/>
</ThemeGroup>

<ThemeGroup title={t('th.g.bgImage')} description={t('th.g.bgImage.d')}>
	<ImageUpload
		label={t('th.i.bgImage')}
		shape="wide"
		maxBytes={2 * 1024 * 1024}
		bind:value={draft.backgroundImage}
	/>
	<Slider
		label={t('th.i.bgOpacity')}
		format="percent"
		disabled={!draft.backgroundImage}
		bind:value={draft.backgroundOpacity}
	/>
</ThemeGroup>

<ThemeGroup title={t('th.g.panelImage')} description={t('th.g.panelImage.d')}>
	<ImageUpload
		label={t('th.i.panelImage')}
		shape="wide"
		maxBytes={2 * 1024 * 1024}
		disabled={!split}
		bind:value={draft.panelImage}
	/>
	<Slider
		label={t('th.i.panelOpacity')}
		format="percent"
		disabled={!split || !draft.panelImage}
		bind:value={draft.panelImageOpacity}
	/>
</ThemeGroup>
