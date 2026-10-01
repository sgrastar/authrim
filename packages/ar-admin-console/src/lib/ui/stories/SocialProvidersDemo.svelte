<script lang="ts">
	import ItemCard from '../patterns/ItemCard.svelte';
	import ItemGrid from '../patterns/ItemGrid.svelte';
	import Button from '../primitives/Button.svelte';
	import Toggle from '../primitives/Toggle.svelte';
	import { sample } from './sample';

	/**
	 * Storybook demo: sign-in providers shown with their logos. The logos are made up for the
	 * demo (no real brands); real ones come from the provider catalogue.
	 */
	const logo = (svg: string) =>
		'data:image/svg+xml;utf8,' +
		encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">${svg}</svg>`);

	const PROVIDERS = [
		{
			id: 'acme',
			name: 'Acme ID',
			configured: true,
			image: logo(
				'<circle cx="24" cy="24" r="20" fill="#e2572b"/><path d="M15 32l9-18 9 18h-5l-4-8-4 8z" fill="#fff"/>'
			)
		},
		{
			id: 'globex',
			name: 'Globex Account',
			configured: true,
			image: logo(
				'<rect x="4" y="4" width="40" height="40" rx="10" fill="#1f6feb"/><circle cx="24" cy="24" r="9" fill="none" stroke="#fff" stroke-width="4"/>'
			)
		},
		{
			id: 'initech',
			name: 'Initech Login',
			configured: false,
			image: logo(
				'<path d="M24 4l18 10v20L24 44 6 34V14z" fill="#16a34a"/><rect x="21" y="14" width="6" height="20" rx="3" fill="#fff"/>'
			)
		},
		{
			id: 'hooli',
			name: 'Hooli Connect',
			configured: false,
			image: logo(
				'<rect x="4" y="12" width="40" height="24" rx="12" fill="#111"/><circle cx="17" cy="24" r="6" fill="#f5c518"/><circle cx="31" cy="24" r="6" fill="#fff"/>'
			)
		}
	];

	let enabled = $state<Record<string, boolean>>({ acme: true });
</script>

<ItemGrid label={sample('socialTitle')} columns={2} minWidth="260px">
	{#each PROVIDERS as provider (provider.id)}
		<ItemCard title={provider.name} image={provider.image} description={sample('socialDesc')}>
			{#snippet actions()}
				<Toggle
					label="{sample('enabled')}: {provider.name}"
					checked={enabled[provider.id] ?? false}
					onchange={(on) => (enabled[provider.id] = on)}
				/>
			{/snippet}
			{#snippet footer()}
				<span>{provider.configured ? sample('configured') : sample('pluginNeedsConfig')}</span>
				<Button size="sm" variant="ghost">{sample('configure')}</Button>
			{/snippet}
		</ItemCard>
	{/each}
</ItemGrid>
