<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { apiAssetUrl } from '#lib/api/assets.js';
	import ImageUpload from '#lib/ui/patterns/ImageUpload.svelte';
	import Tabs from '#lib/ui/patterns/Tabs.svelte';
	import Slider from '#lib/ui/primitives/Slider.svelte';
	import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
	import BgPresetButton from './BgPresetButton.svelte';
	import ImageFilters, { addFilterActions } from './ImageFilters.svelte';
	import { apiBgPresets, type BgPresetSource } from './bg-presets';
	import ThemeGroup from './ThemeGroup.svelte';
	import type { ThemeDraft } from './theme-draft';
	import type { LoginUIImageFilter } from '@authrim/ar-lib-core/utils/login-ui-image-filters';

	let {
		draft = $bindable(),
		presets = apiBgPresets,
		scheme,
		mode = $bindable('light')
	}: {
		draft: ThemeDraft;
		presets?: BgPresetSource;
		scheme: 'light' | 'dark';
		mode?: 'light' | 'dark';
	} = $props();

	const split = $derived(draft.template === 'split');
	const hasCard = $derived(draft.template !== 'minimal');
	let imageTab = $derived<'light' | 'dark'>(scheme);
	const tabs = $derived([
		{ id: 'light', label: t('th.mode.light') },
		{ id: 'dark', label: t('th.mode.dark') }
	]);
	function pickTab(id: string) {
		imageTab = id === 'dark' ? 'dark' : 'light';
		if (draft.mode === 'auto') mode = imageTab;
	}

	// Only the logo is set apart for dark mode (none: the light logo shows). The page and form-area
	// pictures are the same in both tabs; the dark tab also darkens them for dark mode.
	const logoFor = (tab: 'light' | 'dark') => (tab === 'dark' ? draft.darkImages.logo : draft.logo);
	function setLogo(tab: 'light' | 'dark', value: string | File | null) {
		if (tab === 'dark') draft.darkImages.logo = value;
		else draft.logo = value;
	}
</script>

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

<!-- A picture of the theme (the same in both modes): its upload, its effects menu, its opacity
     and its filters, all set in the light tab. -->
{#snippet picture(
	title: string,
	info: string,
	label: string,
	value: string | File | null,
	set: (value: string | File | null) => void,
	opacityLabel: string,
	opacity: number,
	setOpacity: (value: number) => void,
	filters: LoginUIImageFilter[],
	setFilters: (filters: LoginUIImageFilter[]) => void
)}
	<ThemeGroup {title} {info}>
		<ImageUpload
			resolveUrl={apiAssetUrl}
			{label}
			shape="square"
			maxBytes={2 * 1024 * 1024}
			bind:value={() => value, set}
		>
			{#snippet actions(pick)}<BgPresetButton {value} source={presets} onchoose={pick} /><ActionMenu
					size="sm"
					framed
					disabled={!value}
					label={t('th.f.add')}
					actions={addFilterActions(filters, (filter) => setFilters([...filters, filter]))}
				/>{/snippet}
		</ImageUpload>
		{#if value}
			<p class="shared-note">{t('th.i.effectsBothModes')}</p>
			<div class="sliders">
				<Slider
					label={opacityLabel}
					format="percent"
					dense
					bind:value={() => opacity, setOpacity}
				/>
				<ImageFilters bind:filters={() => filters, setFilters} />
			</div>
		{/if}
	</ThemeGroup>
{/snippet}

<!-- A picture's darkening in dark mode: the one thing the dark tab sets of it. -->
{#snippet darkening(title: string, dim: number, setDim: (value: number) => void)}
	<ThemeGroup {title}>
		<Slider label={t('th.i.darkDim')} format="percent" dense bind:value={() => dim, setDim} />
	</ThemeGroup>
{/snippet}

<Tabs label={t('th.i.modes')} items={tabs} value={imageTab} onchange={pickTab}>
	{#snippet panel(id)}
		{@const tab = id === 'dark' ? 'dark' : 'light'}
		<div class="mode-images">
			<ThemeGroup
				title={t('th.g.logo')}
				info={tab === 'dark' ? t('th.g.logo.dark.d') : t('th.g.logo.d')}
			>
				<ImageUpload
					resolveUrl={apiAssetUrl}
					label={t('th.i.logo')}
					shape="square"
					maxBytes={512 * 1024}
					bind:value={() => logoFor(tab), (value) => setLogo(tab, value)}
				/>
			</ThemeGroup>

			{#if tab === 'light'}
				{@render picture(
					t('th.g.bgImage'),
					t('th.g.bgImage.d'),
					t('th.i.bgImage'),
					draft.backgroundImage,
					(value) => (draft.backgroundImage = value),
					t('th.i.bgOpacity'),
					draft.backgroundOpacity,
					(value) => (draft.backgroundOpacity = value),
					draft.backgroundFilters,
					(filters) => (draft.backgroundFilters = filters)
				)}
				{#if hasCard}
					{@render picture(
						t('th.g.cardImage'),
						t('th.g.cardImage.d'),
						t('th.i.cardImage'),
						draft.cardImage,
						(value) => (draft.cardImage = value),
						t('th.i.cardOpacity'),
						draft.cardImageOpacity,
						(value) => (draft.cardImageOpacity = value),
						draft.cardImageFilters,
						(filters) => (draft.cardImageFilters = filters)
					)}
				{/if}
				{#if split}
					{@render picture(
						t('th.g.panelImage'),
						t('th.g.panelImage.d'),
						t('th.i.panelImage'),
						draft.panelImage,
						(value) => (draft.panelImage = value),
						t('th.i.panelOpacity'),
						draft.panelImageOpacity,
						(value) => (draft.panelImageOpacity = value),
						draft.panelImageFilters,
						(filters) => (draft.panelImageFilters = filters)
					)}
				{/if}
			{:else}
				<p class="shared-note">{t('th.i.darkPicturesNote')}</p>
				{#if draft.backgroundImage}
					{@render darkening(t('th.g.bgImage'), draft.backgroundDarkDim, (value) => {
						draft.backgroundDarkDim = value;
					})}
				{/if}
				{#if hasCard && draft.cardImage}
					{@render darkening(t('th.g.cardImage'), draft.cardImageDarkDim, (value) => {
						draft.cardImageDarkDim = value;
					})}
				{/if}
				{#if split && draft.panelImage}
					{@render darkening(t('th.g.panelImage'), draft.panelImageDarkDim, (value) => {
						draft.panelImageDarkDim = value;
					})}
				{/if}
			{/if}
		</div>
	{/snippet}
</Tabs>

<style>
	.mode-images {
		display: grid;
		gap: var(--space-section);
	}

	.sliders {
		display: grid;
		gap: var(--space-related);
	}

	.shared-note {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}
</style>
