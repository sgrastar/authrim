<script lang="ts">
	import { t } from '#lib/i18n/i18n.svelte.js';
	import { apiAssetUrl } from '#lib/api/assets.js';
	import ImageUpload from '#lib/ui/patterns/ImageUpload.svelte';
	import Tabs from '#lib/ui/patterns/Tabs.svelte';
	import Checkbox from '#lib/ui/primitives/Checkbox.svelte';
	import Slider from '#lib/ui/primitives/Slider.svelte';
	import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
	import BgPresetButton from './BgPresetButton.svelte';
	import ImageFilters, { addFilterActions } from './ImageFilters.svelte';
	import { apiBgPresets, type BgPresetSource } from './bg-presets';
	import ThemeGroup from './ThemeGroup.svelte';
	import type { ThemeDraft } from './theme-draft';

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

<Tabs label={t('th.i.modes')} items={tabs} value={imageTab} onchange={pickTab}>
	{#snippet panel(id)}
		{@const tab = id === 'dark' ? 'dark' : 'light'}
		{@const backgroundImage = draft.backgroundImage}
		{@const cardImage = draft.cardImage}
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

			<ThemeGroup title={t('th.g.bgImage')} info={t('th.g.bgImage.d')}>
				<ImageUpload
					resolveUrl={apiAssetUrl}
					label={t('th.i.bgImage')}
					shape="square"
					maxBytes={2 * 1024 * 1024}
					bind:value={draft.backgroundImage}
				>
					{#snippet actions(pick)}<BgPresetButton
							value={backgroundImage}
							source={presets}
							onchoose={pick}
						/><ActionMenu
							size="sm"
							framed
							disabled={!backgroundImage}
							label={t('th.f.add')}
							actions={addFilterActions(draft.backgroundFilters, (filter) => {
								draft.backgroundFilters = [...draft.backgroundFilters, filter];
							})}
						/>{/snippet}
				</ImageUpload>
				{#if backgroundImage}
					<p class="shared-note">{t('th.i.effectsBothModes')}</p>
					<div class="sliders">
						<div class="slider-pair">
							<Slider
								label={t('th.i.bgOpacity')}
								format="percent"
								dense
								bind:value={draft.backgroundOpacity}
							/>
							{#if tab === 'dark'}
								<Slider
									label={t('th.i.darkDim')}
									format="percent"
									dense
									bind:value={draft.backgroundDarkDim}
								/>
							{/if}
						</div>
						<ImageFilters bind:filters={draft.backgroundFilters} />
					</div>
				{/if}
			</ThemeGroup>

			{#if hasCard}
				<ThemeGroup title={t('th.g.cardImage')} info={t('th.g.cardImage.d')}>
					<ImageUpload
						resolveUrl={apiAssetUrl}
						label={t('th.i.cardImage')}
						shape="square"
						maxBytes={2 * 1024 * 1024}
						bind:value={draft.cardImage}
					>
						{#snippet actions(pick)}<BgPresetButton
								value={cardImage}
								source={presets}
								onchoose={pick}
							/>{/snippet}
					</ImageUpload>
					{#if cardImage}
						<p class="shared-note">{t('th.i.effectsBothModes')}</p>
						<div class="slider-pair">
							<Slider
								label={t('th.i.cardOpacity')}
								format="percent"
								dense
								bind:value={draft.cardImageOpacity}
							/>
							{#if tab === 'dark'}
								<Slider
									label={t('th.i.darkDim')}
									format="percent"
									dense
									bind:value={draft.cardImageDarkDim}
								/>
							{/if}
						</div>
						<Checkbox size="sm" bind:checked={draft.cardImageGrayscale}>
							{t('th.i.grayscale')}
						</Checkbox>
					{/if}
				</ThemeGroup>
			{/if}
		</div>
	{/snippet}
</Tabs>

{#if split}
	<ThemeGroup title={t('th.g.panelImage')} info={t('th.g.panelImage.d')}>
		<ImageUpload
			resolveUrl={apiAssetUrl}
			label={t('th.i.panelImage')}
			shape="square"
			maxBytes={2 * 1024 * 1024}
			bind:value={draft.panelImage}
		>
			{#snippet actions(pick)}<BgPresetButton
					value={draft.panelImage}
					source={presets}
					onchoose={pick}
				/>{/snippet}
		</ImageUpload>
		{#if draft.panelImage}
			<!-- The brand panel sits outside the mode tabs: its dark-mode darkening is always here. -->
			<div class="slider-pair">
				<Slider
					label={t('th.i.panelOpacity')}
					format="percent"
					dense
					bind:value={draft.panelImageOpacity}
				/>
				<Slider
					label={t('th.i.darkDim')}
					format="percent"
					dense
					bind:value={draft.panelImageDarkDim}
				/>
			</div>
			<Checkbox size="sm" bind:checked={draft.panelImageGrayscale}>
				{t('th.i.grayscale')}
			</Checkbox>
		{/if}
	</ThemeGroup>
{/if}

<style>
	.mode-images {
		display: grid;
		gap: var(--space-section);
	}

	.sliders {
		display: grid;
		gap: var(--space-related);
	}

	/* A picture's opacity and its dark-mode darkening: one setting read as two rows. */
	.slider-pair {
		display: grid;
		gap: calc(var(--space-related) / 2);
	}

	.shared-note {
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-caption);
	}
</style>
