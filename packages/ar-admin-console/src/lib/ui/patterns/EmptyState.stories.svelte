<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import Button from '../primitives/Button.svelte';
	import { sample } from '../stories/sample';
	import Card from './Card.svelte';
	import EmptyState from './EmptyState.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Empty state',
		component: EmptyState,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component: 'What to show when a list has nothing yet, with the one next step.'
				}
			}
		}
	});
</script>

<Story name="Default">
	{#snippet template()}
		<Card>
			<EmptyState title={sample('emptyTitle')} description={sample('emptyDesc')}>
				{#snippet action()}<Button variant="primary" icon="plus">{sample('create')}</Button
					>{/snippet}
			</EmptyState>
		</Card>
	{/snippet}
</Story>
