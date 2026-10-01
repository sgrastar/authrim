<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import Button from '../primitives/Button.svelte';
	import { sample } from '../stories/sample';
	import PageHeader from './PageHeader.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Page header',
		component: PageHeader,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Title, one-line purpose and the page’s main action. At most one primary button here.'
				}
			}
		}
	});
</script>

<Story name="Default">
	{#snippet template()}
		<PageHeader title={sample('flowsTitle')} description={sample('flowsDesc')}>
			{#snippet actions()}<Button variant="primary" icon="plus">{sample('newFlow')}</Button
				>{/snippet}
		</PageHeader>
	{/snippet}
</Story>
