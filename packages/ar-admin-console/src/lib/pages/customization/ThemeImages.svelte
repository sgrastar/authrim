<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { apiAssetUrl } from '#lib/api/assets.js';
	import ImageUpload from '#lib/ui/patterns/ImageUpload.svelte';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';
	import Slider from '#lib/ui/primitives/Slider.svelte';
	import BgPresetButton from './BgPresetButton.svelte';
	import ThemeGroup from './ThemeGroup.svelte';
	import type { ThemeDraft } from './theme-draft';

	/** Images: the logo, the favicon, the background and (Split) the brand panel's own picture. */
	let { draft = $bindable() }: { draft: ThemeDraft } = $props();

	// The brand panel exists only in the Split template, so its picture is offered only with Split.
	const split = $derived(draft.template === 'split');
	// The form area is a box on the page in Standard and Split; Minimal draws no box.
	const hasCard = $derived(draft.template !== 'minimal');
</script>

<ThemeGroup title={t('th.g.logo')} info={t('th.g.logo.d')}>
	<ImageUpload
		resolveUrl={apiAssetUrl}
		label={t('th.i.logo')}
		shape="square"
		maxBytes={512 * 1024}
		bind:value={draft.logo}
	/>
</ThemeGroup>

<ThemeGroup title={t('th.g.favicon')} info={t('th.g.favicon.d')}>
	<ImageUpload
		resolveUrl={apiAssetUrl}
		label={t('th.i.favicon')}
		shape="square"
		accept="image/png,image/svg+xml,.ico"
		maxBytes={128 * 1024}
		bind:value={draft.favicon}
	/>
</ThemeGroup>

<ThemeGroup title={t('th.g.bgImage')} info={t('th.g.bgImage.d')}>
	<ImageUpload
		resolveUrl={apiAssetUrl}
		label={t('th.i.bgImage')}
		shape="square"
		maxBytes={2 * 1024 * 1024}
		bind:value={draft.backgroundImage}
	>
		{#snippet actions(pick)}<BgPresetButton value={draft.backgroundImage} onpick={pick} />{/snippet}
	</ImageUpload>
	{#if draft.backgroundImage}
		<Slider label={t('th.i.bgOpacity')} format="percent" bind:value={draft.backgroundOpacity} />
		<Checkbox size="sm" bind:checked={draft.backgroundGrayscale}>
			{t('th.i.grayscale')}
		</Checkbox>
	{/if}
</ThemeGroup>

{#if split}
	<ThemeGroup title={t('th.g.panelImage')} info={t('th.g.panelImage.d')}>
		<ImageUpload
			resolveUrl={apiAssetUrl}
			label={t('th.i.panelImage')}
			shape="square"
			maxBytes={2 * 1024 * 1024}
			bind:value={draft.panelImage}
		>
			{#snippet actions(pick)}<BgPresetButton value={draft.panelImage} onpick={pick} />{/snippet}
		</ImageUpload>
		{#if draft.panelImage}
			<Slider
				label={t('th.i.panelOpacity')}
				format="percent"
				bind:value={draft.panelImageOpacity}
			/>
			<Checkbox size="sm" bind:checked={draft.panelImageGrayscale}>
				{t('th.i.grayscale')}
			</Checkbox>
		{/if}
	</ThemeGroup>
{/if}

{#if hasCard}
	<ThemeGroup title={t('th.g.cardImage')} info={t('th.g.cardImage.d')}>
		<ImageUpload
			resolveUrl={apiAssetUrl}
			label={t('th.i.cardImage')}
			shape="square"
			maxBytes={2 * 1024 * 1024}
			bind:value={draft.cardImage}
		>
			{#snippet actions(pick)}<BgPresetButton value={draft.cardImage} onpick={pick} />{/snippet}
		</ImageUpload>
		{#if draft.cardImage}
			<Slider label={t('th.i.cardOpacity')} format="percent" bind:value={draft.cardImageOpacity} />
			<Checkbox size="sm" bind:checked={draft.cardImageGrayscale}>
				{t('th.i.grayscale')}
			</Checkbox>
		{/if}
	</ThemeGroup>
{/if}
