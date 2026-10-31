<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import LoginUIFrame from '$lib/storybook/LoginUIFrame.svelte';
	import ConfiguredFooter from './ConfiguredFooter.svelte';

	const { Story } = defineMeta({
		title: 'Components/ConfiguredFooter',
		component: ConfiguredFooter,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						"Footer links (up to 8, valid URLs only) and the powered-by line, each switchable by the tenant. The line may be replaced by the tenant's own text per language; it accepts a small set of safe HTML tags."
				}
			}
		}
	});

	const links = [
		{ label: 'Privacy', url: 'https://example.com/privacy' },
		{ label: 'Terms', url: 'https://example.com/terms' }
	];
</script>

<Story name="Default">
	{#snippet template()}
		<LoginUIFrame><ConfiguredFooter /></LoginUIFrame>
	{/snippet}
</Story>

<Story name="Links and custom text">
	{#snippet template()}
		<LoginUIFrame
			ui={{ appearance: { footerLinks: links, footerText: '© 2026 <strong>Acme</strong> Inc.' } }}
		>
			<ConfiguredFooter />
		</LoginUIFrame>
	{/snippet}
</Story>

<Story name="Links only">
	{#snippet template()}
		<LoginUIFrame
			ui={{ pageTemplate: { poweredByEnabled: false }, appearance: { footerLinks: links } }}
		>
			<ConfiguredFooter />
		</LoginUIFrame>
	{/snippet}
</Story>

<Story name="Off">
	{#snippet template()}
		<LoginUIFrame ui={{ pageTemplate: { footerEnabled: false } }}>
			<p style="color:var(--text-muted)">Nothing is rendered when the footer is switched off.</p>
			<ConfiguredFooter />
		</LoginUIFrame>
	{/snippet}
</Story>
