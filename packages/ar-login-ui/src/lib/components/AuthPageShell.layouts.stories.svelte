<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import PageSample from '$lib/storybook/PageSample.svelte';
	import ShellGallery from '$lib/storybook/ShellGallery.svelte';
	import { SAMPLE_BACKGROUND_URL } from '$lib/storybook/config';
	import type { LoginUIOverrides } from '$lib/storybook/config';
	import { THEME_TEMPLATES, THEME_TEMPLATE_LABELS } from '$lib/storybook/globals.svelte';

	const { Story } = defineMeta({
		title: 'Page shell/Themes and layouts',
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
						'A tenant picks a **theme** (palette and shape: Meridian, Classic, Split brand panel, Full-bleed glass), a **layout** (centred card, split panel, full-bleed card) and a light or dark **colour variant**. They are three separate settings; the Admin console\'s theme page offers them as presets. The **brand panel** is the element only the split layout adds, and it needs `brand content` other than "none". On narrow screens (up to 640px) the panel is hidden.'
				}
			}
		}
	});

	const split = (
		pageTemplate: NonNullable<LoginUIOverrides['pageTemplate']>
	): LoginUIOverrides => ({
		pageTemplate: { layout: 'split_panel', ...pageTemplate }
	});
</script>

<Story name="All themes (light)">
	{#snippet template()}
		<ShellGallery
			columns={2}
			height={600}
			cells={THEME_TEMPLATES.map((theme) => ({
				label: THEME_TEMPLATE_LABELS[theme],
				theme,
				scheme: 'light'
			}))}
		/>
	{/snippet}
</Story>

<Story name="All themes (dark)">
	{#snippet template()}
		<ShellGallery
			columns={2}
			height={600}
			cells={THEME_TEMPLATES.map((theme) => ({
				label: THEME_TEMPLATE_LABELS[theme],
				theme,
				scheme: 'dark'
			}))}
		/>
	{/snippet}
</Story>

<Story name="All themes (signup)">
	{#snippet template()}
		<ShellGallery
			columns={2}
			height={600}
			cells={THEME_TEMPLATES.map((theme) => ({
				label: THEME_TEMPLATE_LABELS[theme],
				theme,
				kind: 'signup' as const
			}))}
		/>
	{/snippet}
</Story>

<Story name="Colour variants of Classic">
	{#snippet template()}
		<ShellGallery
			columns={3}
			height={520}
			cells={[
				{ label: 'light / beige', theme: 'classic', scheme: 'light', variant: 'beige' },
				{ label: 'light / blue-gray', theme: 'classic', scheme: 'light', variant: 'blue-gray' },
				{ label: 'light / green', theme: 'classic', scheme: 'light', variant: 'green' },
				{ label: 'dark / brown', theme: 'classic', scheme: 'dark', variant: 'brown' },
				{ label: 'dark / navy', theme: 'classic', scheme: 'dark', variant: 'navy' },
				{ label: 'dark / slate', theme: 'classic', scheme: 'dark', variant: 'slate' }
			]}
		/>
	{/snippet}
</Story>

<Story name="Layouts">
	{#snippet template()}
		<ShellGallery
			columns={3}
			height={560}
			cells={[
				{ label: 'centered_card', ui: { pageTemplate: { layout: 'centered_card' } } },
				{ label: 'split_panel', ui: split({}) },
				{
					label: 'fullbleed_card (with background image)',
					ui: {
						pageTemplate: { layout: 'fullbleed_card' },
						appearance: { backgroundImageUrl: SAMPLE_BACKGROUND_URL }
					}
				}
			]}
		/>
	{/snippet}
</Story>

<Story name="Split panel (brand panel)">
	{#snippet template()}
		<LoginUIFrame fit="page" theme="split-brand-panel" ui={split({})}><PageSample /></LoginUIFrame>
	{/snippet}
</Story>

<Story name="Split panel: panel on the right, wide form">
	{#snippet template()}
		<LoginUIFrame
			fit="page"
			theme="split-brand-panel"
			ui={split({ splitPanelSide: 'right', splitPanelWidth: 'wide' })}><PageSample /></LoginUIFrame
		>
	{/snippet}
</Story>

<Story name="Split panel: framed card">
	{#snippet template()}
		<LoginUIFrame
			fit="page"
			theme="split-brand-panel"
			ui={{
				...split({ splitFrame: 'card' }),
				appearance: { backgroundImageUrl: SAMPLE_BACKGROUND_URL }
			}}><PageSample /></LoginUIFrame
		>
	{/snippet}
</Story>

<Story name="Split panel: background modes">
	{#snippet template()}
		<ShellGallery
			columns={3}
			height={520}
			cells={(['shared', 'brand', 'panel'] as const).map((mode) => ({
				label: `split_background_mode: ${mode}`,
				theme: 'split-brand-panel' as const,
				ui: {
					...split({
						splitBackgroundMode: mode,
						loginPanelBackgroundColor: '#0f172a',
						loginPanelBackgroundGradientColor: '#1e3a8a',
						loginPanelBackgroundOpacity: 70
					}),
					appearance: { backgroundImageUrl: SAMPLE_BACKGROUND_URL }
				}
			}))}
		/>
	{/snippet}
</Story>

<Story name="Split panel: brand content">
	{#snippet template()}
		<ShellGallery
			columns={3}
			height={480}
			cells={[
				{
					label: 'logo_copy, centre, left',
					theme: 'split-brand-panel',
					ui: split({ brandContentMode: 'logo_copy' })
				},
				{
					label: 'logo_copy, top, centre',
					theme: 'split-brand-panel',
					ui: split({ brandPosition: 'top', brandAlign: 'center' })
				},
				{
					label: 'logo_copy, bottom, right',
					theme: 'split-brand-panel',
					ui: split({ brandPosition: 'bottom', brandAlign: 'right' })
				},
				{ label: 'logo only', theme: 'split-brand-panel', ui: split({ brandContentMode: 'logo' }) },
				{
					label: 'logo only, no logo uploaded (name instead)',
					theme: 'split-brand-panel',
					ui: { ...split({ brandContentMode: 'logo' }), branding: { logoUrl: null } }
				},
				{
					label: 'none (no panel)',
					theme: 'split-brand-panel',
					ui: split({ brandContentMode: 'none' })
				}
			]}
		/>
	{/snippet}
</Story>

<Story name="Full-bleed glass: accent colour">
	{#snippet template()}
		<ShellGallery
			columns={3}
			height={520}
			cells={['#e8623f', '#2563eb', '#16a34a'].map((accentColor) => ({
				label: `accent ${accentColor}`,
				theme: 'fullbleed-glass' as const,
				ui: {
					pageTemplate: { accentColor },
					appearance: { backgroundImageUrl: SAMPLE_BACKGROUND_URL }
				}
			}))}
		/>
	{/snippet}
</Story>

<Story name="Right-to-left (Arabic)" globals={{ locale: 'ar' }}>
	{#snippet template()}
		<ShellGallery
			columns={2}
			height={520}
			cells={[
				{ label: 'centered_card', ui: { pageTemplate: { layout: 'centered_card' } } },
				{ label: 'split_panel', theme: 'split-brand-panel', ui: split({}) }
			]}
		/>
	{/snippet}
</Story>
