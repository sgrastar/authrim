<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import LoginUIFrame from '#lib/storybook/LoginUIFrame.svelte';
	import PageSample from '#lib/storybook/PageSample.svelte';
	import ShellGallery from '#lib/storybook/ShellGallery.svelte';
	import { SAMPLE_BACKGROUND_URL, SAMPLE_LOGO_URL } from '#lib/storybook/config.js';
	import type { LoginUIOverrides } from '#lib/storybook/config.js';
	import { PALETTE_IDS, TEMPLATE_IDS, layoutFor } from '#lib/palettes.js';
	import type { PaletteId, TemplateId } from '#lib/palettes.js';

	const { Story } = defineMeta({
		title: 'Page shell/Palettes and templates',
		parameters: {
			layout: 'fullscreen',
			a11y: {
				// Several pages in one story repeat the page landmarks; a real page has each once.
				config: {
					rules: [
						{ id: 'landmark-no-duplicate-banner', enabled: false },
						{ id: 'landmark-no-duplicate-contentinfo', enabled: false },
						{ id: 'landmark-unique', enabled: false }
					]
				}
			},
			docs: {
				description: {
					component:
						'A tenant picks a **template** (the structure of the page: standard, split, minimal) and a **palette** (the colours and the shape of the form area: Meridian, Classic, Glass, Flat). They combine freely. `form_area_color`, the image opacities, the brand panel picture and its logo display, the header name and the form-row switches are separate settings on top of them. The stylesheet is still keyed on the pre-palette names (`data-login-theme`, `data-page-layout`); `palettes.ts` translates.'
				}
			}
		}
	});

	const ui = (
		template: TemplateId,
		palette: PaletteId,
		more: LoginUIOverrides = {}
	): LoginUIOverrides => ({
		...more,
		pageTemplate: { template, palette, layout: layoutFor(template), ...more.pageTemplate }
	});

	const LABELS: Record<PaletteId, string> = {
		meridian: 'Meridian',
		classic: 'Classic',
		glass: 'Glass',
		flat: 'Flat'
	};

	const cells = (scheme: 'light' | 'dark', more: LoginUIOverrides = {}) =>
		TEMPLATE_IDS.flatMap((template) =>
			PALETTE_IDS.map((palette) => ({
				label: `${template} / ${LABELS[palette]}`,
				scheme,
				ui: ui(template, palette, more)
			}))
		);
</script>

<Story name="Every template and palette (light)">
	{#snippet template()}
		<ShellGallery columns={3} height={460} cells={cells('light')} />
	{/snippet}
</Story>

<Story name="Every template and palette (dark)">
	{#snippet template()}
		<ShellGallery columns={3} height={460} cells={cells('dark')} />
	{/snippet}
</Story>

<Story name="Minimal: the form sits on the page">
	{#snippet template()}
		<LoginUIFrame fit="page" ui={ui('minimal', 'flat')}><PageSample /></LoginUIFrame>
	{/snippet}
</Story>

<Story name="Split: form frame, full and card">
	{#snippet template()}
		<ShellGallery
			columns={2}
			height={560}
			cells={[
				{
					label: 'full (default): the form side is a full-height panel',
					ui: ui('split', 'meridian', {
						branding: { logoUrl: SAMPLE_LOGO_URL },
						appearance: { brandPanelImageUrl: SAMPLE_BACKGROUND_URL },
						pageTemplate: { formFrame: 'full' }
					})
				},
				{
					label: 'card: the brand panel runs behind, the form floats over it',
					ui: ui('split', 'meridian', {
						branding: { logoUrl: SAMPLE_LOGO_URL },
						appearance: { brandPanelImageUrl: SAMPLE_BACKGROUND_URL },
						pageTemplate: { formFrame: 'card' }
					})
				},
				{
					label: 'card, panel on the right, wide form',
					ui: ui('split', 'meridian', {
						branding: { logoUrl: SAMPLE_LOGO_URL },
						appearance: { brandPanelImageUrl: SAMPLE_BACKGROUND_URL },
						pageTemplate: { formFrame: 'card', splitPanelSide: 'right', splitPanelWidth: 'wide' }
					})
				},
				{
					label: 'card, login panel picture (panel mode) is not drawn on the card',
					ui: ui('split', 'meridian', {
						branding: { logoUrl: SAMPLE_LOGO_URL },
						appearance: {
							brandPanelImageUrl: SAMPLE_BACKGROUND_URL,
							loginPanelBackgroundImageUrl: SAMPLE_BACKGROUND_URL
						},
						pageTemplate: { formFrame: 'card', splitBackgroundMode: 'panel' }
					})
				},
				{
					label: 'card, no brand content: the picture stays behind',
					ui: ui('split', 'meridian', {
						appearance: { brandPanelImageUrl: SAMPLE_BACKGROUND_URL },
						pageTemplate: { formFrame: 'card', brandContentMode: 'none' }
					})
				},
				{
					label: 'card, Flat palette, form area colour',
					ui: ui('split', 'flat', {
						branding: { logoUrl: SAMPLE_LOGO_URL },
						appearance: { brandPanelImageUrl: SAMPLE_BACKGROUND_URL },
						pageTemplate: { formFrame: 'card', formAreaColor: '#fff4d6' }
					})
				}
			]}
		/>
	{/snippet}
</Story>

<Story name="Form area colour">
	{#snippet template()}
		<ShellGallery
			columns={2}
			height={560}
			cells={[
				{
					label: 'standard, #fff4d6',
					ui: ui('standard', 'meridian', { pageTemplate: { formAreaColor: '#fff4d6' } })
				},
				{
					label: 'split, #fff4d6',
					ui: ui('split', 'meridian', { pageTemplate: { formAreaColor: '#fff4d6' } })
				},
				{
					label: 'split, brand only: the login panel colour (#d6f4ff) wins over #fff4d6',
					ui: ui('split', 'meridian', {
						pageTemplate: {
							formAreaColor: '#fff4d6',
							splitBackgroundMode: 'brand',
							loginPanelBackgroundColor: '#d6f4ff'
						}
					})
				}
			]}
		/>
	{/snippet}
</Story>

<Story name="Background image at 35% opacity">
	{#snippet template()}
		<ShellGallery
			columns={2}
			height={560}
			cells={[
				{
					label: 'opacity 100',
					ui: ui('standard', 'meridian', {
						appearance: { backgroundImageUrl: SAMPLE_BACKGROUND_URL }
					})
				},
				{
					label: 'opacity 35',
					ui: ui('standard', 'meridian', {
						appearance: { backgroundImageUrl: SAMPLE_BACKGROUND_URL, backgroundImageOpacity: 35 }
					})
				}
			]}
		/>
	{/snippet}
</Story>

<Story name="Brand panel picture and logo display">
	{#snippet template()}
		<ShellGallery
			columns={2}
			height={560}
			cells={[
				{
					label: 'picture, opacity 100',
					ui: ui('split', 'meridian', {
						branding: { logoUrl: SAMPLE_LOGO_URL },
						appearance: { brandPanelImageUrl: SAMPLE_BACKGROUND_URL }
					})
				},
				{
					label: 'picture, opacity 40',
					ui: ui('split', 'meridian', {
						branding: { logoUrl: SAMPLE_LOGO_URL },
						appearance: { brandPanelImageUrl: SAMPLE_BACKGROUND_URL, brandPanelImageOpacity: 40 }
					})
				},
				{
					label: 'panel logo: image only',
					ui: ui('split', 'meridian', {
						branding: { logoUrl: SAMPLE_LOGO_URL },
						pageTemplate: { brandPanelLogoDisplay: 'image' }
					})
				},
				{
					label: 'panel logo: hidden',
					ui: ui('split', 'meridian', {
						branding: { logoUrl: SAMPLE_LOGO_URL },
						pageTemplate: { brandPanelLogoDisplay: 'hidden' }
					})
				}
			]}
		/>
	{/snippet}
</Story>

<Story name="Header name">
	{#snippet template()}
		<LoginUIFrame
			fit="page"
			ui={ui('standard', 'meridian', { branding: { headerName: 'Acme Console' } })}
			><PageSample /></LoginUIFrame
		>
	{/snippet}
</Story>

<Story name="Split: switches in the form row">
	{#snippet template()}
		<ShellGallery
			columns={3}
			height={520}
			cells={(['form_bottom_left', 'form_bottom_center', 'form_bottom_right'] as const).map(
				(position) => ({
					label: position,
					ui: ui('split', 'meridian', { pageTemplate: { topbarPosition: position } })
				})
			)}
		/>
	{/snippet}
</Story>
