<script module lang="ts">
	import { defineMeta } from '@storybook/addon-svelte-csf';
	import { sample } from '../stories/sample';
	import LoadingState from './LoadingState.svelte';

	const { Story } = defineMeta({
		title: 'Patterns/Loading state',
		component: LoadingState,
		tags: ['autodocs'],
		parameters: {
			docs: {
				description: {
					component:
						'Placeholder while data loads. The label is announced; the spinner is decorative.'
				}
			}
		}
	});
</script>

<Story name="Default">
	{#snippet template()}<LoadingState label={sample('loading')} />{/snippet}
</Story>
