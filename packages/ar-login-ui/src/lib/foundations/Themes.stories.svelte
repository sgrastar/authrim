<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import { THEME_TEMPLATES, THEME_TEMPLATE_LABELS } from '$lib/storybook/globals.svelte';
	import TokenSwatches from './TokenSwatches.svelte';

	const { Story } = defineMeta({
		title: 'Foundations/Themes',
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
						"Colour and shape tokens of each theme, read live from the CSS. A page is the product of the **theme** (Meridian, Classic, Split brand panel, Full-bleed glass: palette and corner shapes), light or dark, and the **layout** (see Page shell). Each theme brings its own palette in each mode; Full-bleed glass takes its accent from the tenant's accent colour."
				}
			}
		}
	});

	const colours = [
		'--primary',
		'--primary-hover',
		'--primary-light',
		'--bg-page',
		'--bg-card',
		'--bg-input',
		'--bg-subtle',
		'--text-primary',
		'--text-secondary',
		'--text-muted',
		'--border',
		'--accent',
		'--success',
		'--warning',
		'--danger'
	] as const;

	const shapes = ['--card-radius', '--button-radius', '--input-radius', '--radius-lg'] as const;
</script>

{#snippet themeCard(theme: (typeof THEME_TEMPLATES)[number], scheme: 'light' | 'dark')}
	<LoginUIFrame {theme} {scheme}>
		<h3 class="auth-section-title" style="margin-bottom:12px">
			{THEME_TEMPLATE_LABELS[theme]} · {scheme}
		</h3>
		<TokenSwatches tokens={colours} />
		<h4 style="margin:16px 0 8px;color:var(--text-secondary);font-size:0.75rem">Shape</h4>
		<TokenSwatches tokens={shapes} kind="length" />
	</LoginUIFrame>
{/snippet}

<Story name="Themes (light)">
	{#snippet template()}
		<div class="grid">
			{#each THEME_TEMPLATES as theme (theme)}
				{@render themeCard(theme, 'light')}
			{/each}
		</div>
	{/snippet}
</Story>

<Story name="Themes (dark)">
	{#snippet template()}
		<div class="grid">
			{#each THEME_TEMPLATES as theme (theme)}
				{@render themeCard(theme, 'dark')}
			{/each}
		</div>
	{/snippet}
</Story>

<style>
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
		gap: 16px;
		padding: 16px;
	}
</style>
