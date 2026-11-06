<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { expect } from 'storybook/test';
	import LoginUIFrame from '#lib/storybook/LoginUIFrame.svelte';
	import PageSample from '#lib/storybook/PageSample.svelte';
	import ShellGallery from '#lib/storybook/ShellGallery.svelte';
	import { SAMPLE_BACKGROUND_URL } from '#lib/storybook/config.js';
	import type { LoginUIOverrides } from '#lib/storybook/config.js';

	const { Story } = defineMeta({
		title: 'Page shell/Settings',
		tags: ['autodocs'],
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
						"The page around the card: header (logo, name, tagline), top bar (theme toggle, language), optional brand panel, footer. Everything here is a tenant setting in the Admin console. Each story changes **one** setting on the toolbar's theme; the full-page stories follow **Theme**, **Scheme** and **Language**, the galleries pin their own.\n\n" +
						'Every page that has this chrome renders it through `AuthPageShell`: login, signup, verify-email-code, consent, device, reauth, ciba, callback, error and logout.'
				}
			}
		}
	});

	const page = (pageTemplate: NonNullable<LoginUIOverrides['pageTemplate']>): LoginUIOverrides => ({
		pageTemplate
	});
</script>

{#snippet full(ui: LoginUIOverrides = {}, kind: 'login' | 'signup' = 'login', client = false)}
	<LoginUIFrame fit="page" {ui}><PageSample {kind} {client} /></LoginUIFrame>
{/snippet}

<Story name="Default">
	{#snippet template()}{@render full()}{/snippet}
</Story>

<Story name="Signup">
	{#snippet template()}{@render full({}, 'signup')}{/snippet}
</Story>

<Story name="With client card">
	{#snippet template()}{@render full({}, 'login', true)}{/snippet}
</Story>

<Story
	name="Split: a long form scrolls, the switches below its last link"
	play={async ({ canvasElement }) => {
		// A short screen, so that the form is taller than its column.
		const shell = canvasElement.querySelector<HTMLElement>('.auth-page');
		shell!.style.height = '560px';
		shell!.style.minHeight = '0';
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		const column = canvasElement.querySelector<HTMLElement>('.auth-container');
		await expect(column).not.toBeNull();
		await expect(column!.scrollHeight).toBeGreaterThan(column!.clientHeight);
		const form = column!.querySelector<HTMLElement>('.card');
		const link = column!.querySelector<HTMLElement>('.auth-bottom-link');
		const switches = column!.querySelector<HTMLElement>('.auth-topbar');
		// The switches are in the form column, under its last link, not laid over its foot.
		await expect(switches).not.toBeNull();
		await expect(switches!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			link!.getBoundingClientRect().bottom - 1
		);
		// The form keeps its height (its last buttons are not clipped); the column scrolls instead.
		await expect(form!.scrollHeight).toBeLessThanOrEqual(form!.clientHeight + 1);
	}}
>
	{#snippet template()}{@render full(
			page({ template: 'split', layout: 'split_panel', topbarPosition: 'below_card' }),
			'login',
			true
		)}{/snippet}
</Story>

<Story name="Header: off">
	{#snippet template()}{@render full(page({ headerEnabled: false }))}{/snippet}
</Story>

<Story name="Header: no tagline">
	{#snippet template()}{@render full(page({ subtitleEnabled: false }))}{/snippet}
</Story>

<Story name="Header: custom tagline">
	{#snippet template()}{@render full({
			appearance: { headerText: 'Sign in once, work everywhere.' }
		})}{/snippet}
</Story>

<Story name="Header: bar">
	{#snippet template()}{@render full(page({ headerStyle: 'bar', logoLayout: 'row' }))}{/snippet}
</Story>

<Story name="Header: logo and name in a row">
	{#snippet template()}{@render full(page({ logoLayout: 'row' }))}{/snippet}
</Story>

<Story name="Logo display">
	{#snippet template()}
		<ShellGallery
			columns={2}
			height={380}
			cells={[
				{ label: 'auto (logo, and name when no logo)', ui: page({ logoDisplay: 'auto' }) },
				{ label: 'image only', ui: page({ logoDisplay: 'image' }) },
				{ label: 'text only', ui: page({ logoDisplay: 'text' }) },
				{ label: 'hidden', ui: page({ logoDisplay: 'hidden' }) },
				{
					label: 'auto, no logo uploaded',
					ui: { ...page({ logoDisplay: 'auto' }), branding: { logoUrl: null } }
				}
			]}
		/>
	{/snippet}
</Story>

<Story name="Footer: off">
	{#snippet template()}{@render full(page({ footerEnabled: false }))}{/snippet}
</Story>

<Story name="Footer: links and custom text">
	{#snippet template()}
		{@render full({
			appearance: {
				footerText: '© 2026 Acme Inc.',
				footerLinks: [
					{ label: 'Privacy', url: 'https://example.com/privacy' },
					{ label: 'Terms', url: 'https://example.com/terms' },
					{ label: 'Help', url: 'https://example.com/help' }
				]
			}
		})}
	{/snippet}
</Story>

<Story name="Footer: powered-by off">
	{#snippet template()}
		{@render full({
			...page({ poweredByEnabled: false }),
			appearance: { footerLinks: [{ label: 'Privacy', url: 'https://example.com/privacy' }] }
		})}
	{/snippet}
</Story>

<Story name="Footer: bar">
	{#snippet template()}
		{@render full({
			...page({ footerStyle: 'bar' }),
			appearance: { footerLinks: [{ label: 'Privacy', url: 'https://example.com/privacy' }] }
		})}
	{/snippet}
</Story>

<Story name="Top bar position">
	{#snippet template()}
		<ShellGallery
			columns={3}
			height={440}
			cells={(
				[
					'below_card',
					'in_card',
					'top_right',
					'bottom_left',
					'bottom_center',
					'bottom_right',
					'hidden'
				] as const
			).map((position) => ({
				label: position,
				ui: page({ topbarPosition: position })
			}))}
		/>
	{/snippet}
</Story>

<Story name="Top bar: theme toggle only">
	{#snippet template()}{@render full(page({ languageSelectEnabled: false }))}{/snippet}
</Story>

<Story name="Top bar: language only">
	{#snippet template()}{@render full(page({ themeToggleEnabled: false }))}{/snippet}
</Story>

<Story name="Switch link: off">
	{#snippet template()}{@render full(page({ authSwitchLinkEnabled: false }))}{/snippet}
</Story>

<Story name="Fonts and density">
	{#snippet template()}
		<ShellGallery
			columns={3}
			height={440}
			cells={[
				{ label: 'system / compact', ui: page({ fontFamily: 'system', fontScale: 'compact' }) },
				{ label: 'rounded / comfortable', ui: page({ fontFamily: 'rounded' }) },
				{ label: 'serif / spacious', ui: page({ fontFamily: 'serif', fontScale: 'spacious' }) },
				{ label: 'mono / comfortable', ui: page({ fontFamily: 'mono' }) }
			]}
		/>
	{/snippet}
</Story>

<Story name="Background image and colours">
	{#snippet template()}
		{@render full({
			...page({
				accentColor: '#16a34a',
				titleColor: '#ffffff',
				copyColor: '#e2e8f0',
				textColor: '#ffffff'
			}),
			appearance: { backgroundImageUrl: SAMPLE_BACKGROUND_URL }
		})}
	{/snippet}
</Story>
