<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import Button from '../primitives/Button.svelte';
	import { sample } from '../stories/sample';
	import Card from './Card.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Card',
		component: Card,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Panel for one topic. Drawn through the material tokens (`--surface-bg`, `--surface-backdrop`), so translucent themes work unchanged. `flush` removes body padding for tables and row lists.'
				}
			}
		}
	});
</script>

<Story name="Default">
	{#snippet template()}
		<Card title={sample('signingKeys')} description={sample('signingKeysDesc')}>
			{#snippet actions()}<Button size="sm">{sample('rotate')}</Button>{/snippet}
			<p style="margin:0">{sample('keyExpires')}</p>
			{#snippet footer()}{sample('lastRotation')}{/snippet}
		</Card>
	{/snippet}
</Story>
